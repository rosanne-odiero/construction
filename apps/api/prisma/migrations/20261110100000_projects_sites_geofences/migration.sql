-- D2.1 Projects, sites and geofences (ARCHITECTURE §4 projects module, ERD §3).
-- * projects gains its commercial fields, an explicit lifecycle (status + version) and a code that
--   is unique per company. Rows created before D2.1 (name only) get PRJ-001… codes per company and
--   stay in planning; FORCE row-level security is lifted only for that backfill and every row is
--   checked.
-- * project_status_changes: append-only history of lifecycle transitions with reasons.
-- * sites and site_geofences: a site's geofence is versioned. Versions are append-only, numbered
--   and time-stamped by the database (effective_from strictly increases per site), so attendance
--   can later evaluate the version in force at capture time. A past version is never changed.
-- * wbs_nodes (a tree with progress weights) and milestones (explicit lifecycle).
-- * project_memberships may carry the wider project-scoped catalogue (packages/types
--   PROJECT_ASSIGNABLE_PERMISSIONS).
-- Every new table has tenant_id, forced RLS with WITH CHECK, and composite (tenant_id, …) foreign
-- keys for every tenant-to-tenant reference.
BEGIN;

-- Projects ---------------------------------------------------------------------------------------
ALTER TABLE "projects"
  ADD COLUMN "code" VARCHAR(20),
  ADD COLUMN "description" VARCHAR(2000),
  ADD COLUMN "client_name" VARCHAR(150),
  ADD COLUMN "client_email" VARCHAR(254),
  ADD COLUMN "client_phone" VARCHAR(32),
  ADD COLUMN "contract_sum_minor" BIGINT,
  ADD COLUMN "currency" CHAR(3) NOT NULL DEFAULT 'KES',
  ADD COLUMN "contract_type" VARCHAR(30),
  ADD COLUMN "start_date" DATE,
  ADD COLUMN "end_date" DATE,
  ADD COLUMN "county" VARCHAR(30),
  ADD COLUMN "town" VARCHAR(100),
  ADD COLUMN "latitude" DECIMAL(9,6),
  ADD COLUMN "longitude" DECIMAL(9,6),
  ADD COLUMN "status" VARCHAR(20) NOT NULL DEFAULT 'planning',
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "created_by" UUID,
  ADD COLUMN "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- The schema owner is subject to FORCE ROW LEVEL SECURITY and has no tenant context, so it would
-- see no projects. Lift FORCE for the backfill (ALTER TABLE holds an exclusive lock), assign a
-- code to every row, check the counts, then restore FORCE.
ALTER TABLE "projects" NO FORCE ROW LEVEL SECURITY;
DO $$
DECLARE
  total bigint;
  coded bigint;
BEGIN
  SELECT count(*) INTO total FROM projects;
  UPDATE projects p
    SET code = 'PRJ-' || lpad(s.n::text, greatest(3, length(s.n::text)), '0')
    FROM (
      SELECT id, row_number() OVER (PARTITION BY tenant_id ORDER BY created_at, id) AS n
      FROM projects
    ) s
    WHERE p.id = s.id;
  SELECT count(*) INTO coded FROM projects WHERE code ~ '^PRJ-[0-9]{3,}$' AND status = 'planning';
  IF coded <> total THEN
    RAISE EXCEPTION 'project codes were not all assigned (% of %)', coded, total;
  END IF;
END $$;
ALTER TABLE "projects" ALTER COLUMN "code" SET NOT NULL;
ALTER TABLE "projects" FORCE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX "projects_tenant_id_code_key" ON "projects"("tenant_id", "code");
CREATE INDEX "projects_tenant_id_status_idx" ON "projects"("tenant_id", "status");

ALTER TABLE "projects" ADD CONSTRAINT "projects_code_check" CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{1,19}$');
ALTER TABLE "projects" ADD CONSTRAINT "projects_name_check" CHECK (char_length(btrim(name)) >= 1);
ALTER TABLE "projects" ADD CONSTRAINT "projects_currency_check" CHECK (currency = 'KES');
ALTER TABLE "projects" ADD CONSTRAINT "projects_contract_sum_check" CHECK (
  contract_sum_minor IS NULL OR contract_sum_minor BETWEEN 0 AND 9007199254740991
);
-- packages/types CONTRACT_TYPES
ALTER TABLE "projects" ADD CONSTRAINT "projects_contract_type_check" CHECK (
  contract_type IS NULL OR contract_type IN (
    'lump_sum', 'remeasurement', 'design_and_build', 'cost_plus', 'labour_only'
  )
);
-- packages/types PROJECT_STATUSES
ALTER TABLE "projects" ADD CONSTRAINT "projects_status_check" CHECK (
  status IN ('planning', 'active', 'on_hold', 'completed', 'closed', 'cancelled')
);
-- packages/types KENYA_COUNTIES (the 47 counties, First Schedule order)
ALTER TABLE "projects" ADD CONSTRAINT "projects_county_check" CHECK (
  county IS NULL OR county IN (
    'mombasa', 'kwale', 'kilifi', 'tana-river', 'lamu', 'taita-taveta', 'garissa', 'wajir',
    'mandera', 'marsabit', 'isiolo', 'meru', 'tharaka-nithi', 'embu', 'kitui', 'machakos',
    'makueni', 'nyandarua', 'nyeri', 'kirinyaga', 'muranga', 'kiambu', 'turkana', 'west-pokot',
    'samburu', 'trans-nzoia', 'uasin-gishu', 'elgeyo-marakwet', 'nandi', 'baringo', 'laikipia',
    'nakuru', 'narok', 'kajiado', 'kericho', 'bomet', 'kakamega', 'vihiga', 'bungoma', 'busia',
    'siaya', 'kisumu', 'homa-bay', 'migori', 'kisii', 'nyamira', 'nairobi'
  )
);
ALTER TABLE "projects" ADD CONSTRAINT "projects_dates_check" CHECK (
  start_date IS NULL OR end_date IS NULL OR end_date >= start_date
);
-- packages/domain KENYA_BOUNDS
ALTER TABLE "projects" ADD CONSTRAINT "projects_location_check" CHECK (
  (latitude IS NULL AND longitude IS NULL)
  OR (latitude BETWEEN -5 AND 5.5 AND longitude BETWEEN 33.5 AND 42)
);
ALTER TABLE "projects" ADD CONSTRAINT "projects_client_phone_check" CHECK (
  client_phone IS NULL OR client_phone ~ '^(254[17][0-9]{8}|\+[1-9][0-9]{7,14})$'
);
ALTER TABLE "projects" ADD CONSTRAINT "projects_client_email_check" CHECK (
  client_email IS NULL OR client_email ~ '^[^@\s]+@[^@\s]+$'
);
ALTER TABLE "projects" ADD CONSTRAINT "projects_version_check" CHECK (version >= 1);
-- Past planning, the contract details that activation required stay filled in.
ALTER TABLE "projects" ADD CONSTRAINT "projects_active_details_check" CHECK (
  status IN ('planning', 'cancelled') OR (
    client_name IS NOT NULL AND contract_sum_minor > 0 AND contract_type IS NOT NULL
    AND start_date IS NOT NULL AND end_date IS NOT NULL AND county IS NOT NULL
    AND town IS NOT NULL
  )
);

-- Database backstop for the lifecycle in packages/domain PROJECT_TRANSITIONS: a project starts in
-- planning, moves only along the listed transitions, keeps its code once it leaves planning, and
-- is read-only once closed or cancelled.
CREATE FUNCTION app.guard_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'planning' THEN
      RAISE EXCEPTION 'A project starts in planning' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('closed', 'cancelled') THEN
    RAISE EXCEPTION 'Closed and cancelled projects are read-only' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND (OLD.status, NEW.status) NOT IN (
    ('planning', 'active'), ('planning', 'cancelled'), ('active', 'on_hold'),
    ('on_hold', 'active'), ('on_hold', 'cancelled'), ('active', 'completed'),
    ('completed', 'closed')
  ) THEN
    RAISE EXCEPTION 'Project status cannot change from % to %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  IF NEW.code IS DISTINCT FROM OLD.code AND OLD.status <> 'planning' THEN
    RAISE EXCEPTION 'The project code is fixed once the project leaves planning'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER project_guard BEFORE INSERT OR UPDATE ON "projects"
  FOR EACH ROW EXECUTE FUNCTION app.guard_project();

-- Append-only rows (geofence versions, status history) are never updated, and deleted only when a
-- parent is deleted (cascade); a direct DELETE is refused.
CREATE FUNCTION app.reject_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = '42501';
END
$$;

-- Project status history -------------------------------------------------------------------------
CREATE TABLE "project_status_changes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "from_status" VARCHAR(20) NOT NULL,
    "to_status" VARCHAR(20) NOT NULL,
    "reason" VARCHAR(500),
    "changed_by" UUID NOT NULL,
    "changed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_status_changes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "project_status_changes_tenant_id_project_id_changed_at_idx"
  ON "project_status_changes"("tenant_id", "project_id", "changed_at");
ALTER TABLE "project_status_changes" ADD CONSTRAINT "project_status_changes_tenant_id_project_id_fkey"
  FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_status_changes" ADD CONSTRAINT "project_status_changes_status_check" CHECK (
  from_status IN ('planning', 'active', 'on_hold', 'completed', 'closed', 'cancelled')
  AND to_status IN ('planning', 'active', 'on_hold', 'completed', 'closed', 'cancelled')
  AND from_status <> to_status
);
ALTER TABLE "project_status_changes" ADD CONSTRAINT "project_status_changes_reason_check" CHECK (
  reason IS NULL OR char_length(btrim(reason)) BETWEEN 3 AND 500
);
CREATE TRIGGER project_status_changes_append_only BEFORE UPDATE OR DELETE ON "project_status_changes"
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();

-- Sites ------------------------------------------------------------------------------------------
CREATE TABLE "sites" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "address" VARCHAR(250),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sites_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sites_tenant_id_id_key" ON "sites"("tenant_id", "id");
CREATE UNIQUE INDEX "sites_tenant_id_project_id_name_key" ON "sites"("tenant_id", "project_id", "name");
ALTER TABLE "sites" ADD CONSTRAINT "sites_tenant_id_project_id_fkey"
  FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sites" ADD CONSTRAINT "sites_name_check" CHECK (
  char_length(name) >= 1 AND name = btrim(name)
);
ALTER TABLE "sites" ADD CONSTRAINT "sites_version_check" CHECK (version >= 1);

-- A stored polygon: an open ring of 3–100 distinct {lat, lng} vertices inside the Kenya bounding
-- box (packages/domain GEOFENCE_LIMITS, KENYA_BOUNDS). Self-intersection is checked by the shared
-- domain code before the insert; the area bounds are repeated below.
CREATE FUNCTION app.geofence_polygon_valid(polygon jsonb) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  vertex jsonb;
  vertices integer;
BEGIN
  IF polygon IS NULL OR jsonb_typeof(polygon) <> 'array' THEN
    RETURN false;
  END IF;
  vertices := jsonb_array_length(polygon);
  IF vertices < 3 OR vertices > 100 THEN
    RETURN false;
  END IF;
  FOR vertex IN SELECT value FROM jsonb_array_elements(polygon) LOOP
    IF jsonb_typeof(vertex) IS DISTINCT FROM 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(vertex)) <> 2
       OR jsonb_typeof(vertex -> 'lat') IS DISTINCT FROM 'number'
       OR jsonb_typeof(vertex -> 'lng') IS DISTINCT FROM 'number' THEN
      RETURN false;
    END IF;
    IF (vertex ->> 'lat')::numeric NOT BETWEEN -5 AND 5.5
       OR (vertex ->> 'lng')::numeric NOT BETWEEN 33.5 AND 42 THEN
      RETURN false;
    END IF;
  END LOOP;
  -- Distinct vertices; this also refuses a repeated closing vertex.
  RETURN (SELECT count(DISTINCT value) FROM jsonb_array_elements(polygon)) = vertices;
END
$$;

CREATE TABLE "site_geofences" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "kind" VARCHAR(10) NOT NULL,
    "center_lat" DECIMAL(9,6),
    "center_lng" DECIMAL(9,6),
    "radius_m" INTEGER,
    "polygon" JSONB,
    "area_m2" DECIMAL(12,1) NOT NULL,
    "perimeter_m" DECIMAL(10,1) NOT NULL,
    "effective_from" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,

    CONSTRAINT "site_geofences_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "site_geofences_tenant_id_site_id_version_key"
  ON "site_geofences"("tenant_id", "site_id", "version");
CREATE INDEX "site_geofences_tenant_id_site_id_effective_from_idx"
  ON "site_geofences"("tenant_id", "site_id", "effective_from");
ALTER TABLE "site_geofences" ADD CONSTRAINT "site_geofences_tenant_id_site_id_fkey"
  FOREIGN KEY ("tenant_id", "site_id") REFERENCES "sites"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "site_geofences" ADD CONSTRAINT "site_geofences_shape_check" CHECK (
  (
    kind = 'radius'
    AND center_lat BETWEEN -5 AND 5.5 AND center_lng BETWEEN 33.5 AND 42
    AND radius_m BETWEEN 20 AND 5000
    AND polygon IS NULL
  ) OR (
    kind = 'polygon'
    AND app.geofence_polygon_valid(polygon)
    AND center_lat IS NULL AND center_lng IS NULL AND radius_m IS NULL
    AND area_m2 BETWEEN 100 AND 25000000
  )
);
ALTER TABLE "site_geofences" ADD CONSTRAINT "site_geofences_metrics_check" CHECK (
  area_m2 > 0 AND perimeter_m > 0
);
ALTER TABLE "site_geofences" ADD CONSTRAINT "site_geofences_version_check" CHECK (version >= 1);

-- The database numbers versions and stamps effective_from (strictly increasing per site); the
-- site row lock serialises concurrent changes to one site.
CREATE FUNCTION app.assign_geofence_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  latest_version integer;
  latest_from timestamptz;
BEGIN
  PERFORM 1 FROM sites WHERE tenant_id = NEW.tenant_id AND id = NEW.site_id FOR UPDATE;
  SELECT version, effective_from INTO latest_version, latest_from FROM site_geofences
    WHERE tenant_id = NEW.tenant_id AND site_id = NEW.site_id
    ORDER BY version DESC LIMIT 1;
  NEW.version := COALESCE(latest_version, 0) + 1;
  NEW.effective_from := greatest(
    clock_timestamp(),
    COALESCE(latest_from + interval '1 microsecond', clock_timestamp())
  );
  RETURN NEW;
END
$$;
CREATE TRIGGER site_geofence_version BEFORE INSERT ON "site_geofences"
  FOR EACH ROW EXECUTE FUNCTION app.assign_geofence_version();
CREATE TRIGGER site_geofences_append_only BEFORE UPDATE OR DELETE ON "site_geofences"
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();

-- WBS --------------------------------------------------------------------------------------------
CREATE TABLE "wbs_nodes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "parent_id" UUID,
    "code" VARCHAR(30) NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "weight_basis_points" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wbs_nodes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "wbs_nodes_tenant_id_project_id_id_key" ON "wbs_nodes"("tenant_id", "project_id", "id");
CREATE UNIQUE INDEX "wbs_nodes_tenant_id_project_id_code_key" ON "wbs_nodes"("tenant_id", "project_id", "code");
CREATE INDEX "wbs_nodes_tenant_id_project_id_parent_id_sort_order_idx"
  ON "wbs_nodes"("tenant_id", "project_id", "parent_id", "sort_order");
ALTER TABLE "wbs_nodes" ADD CONSTRAINT "wbs_nodes_tenant_id_project_id_fkey"
  FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
-- The parent must be a node of the same project in the same company.
ALTER TABLE "wbs_nodes" ADD CONSTRAINT "wbs_nodes_tenant_id_project_id_parent_id_fkey"
  FOREIGN KEY ("tenant_id", "project_id", "parent_id") REFERENCES "wbs_nodes"("tenant_id", "project_id", "id")
  ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "wbs_nodes" ADD CONSTRAINT "wbs_nodes_code_check" CHECK (
  code ~ '^[A-Za-z0-9][A-Za-z0-9.-]{0,29}$'
);
ALTER TABLE "wbs_nodes" ADD CONSTRAINT "wbs_nodes_name_check" CHECK (
  char_length(name) >= 1 AND name = btrim(name)
);
-- packages/domain FULL_WEIGHT_BP: a weight is 0–100 % in basis points.
ALTER TABLE "wbs_nodes" ADD CONSTRAINT "wbs_nodes_weight_check" CHECK (
  weight_basis_points BETWEEN 0 AND 10000
);
ALTER TABLE "wbs_nodes" ADD CONSTRAINT "wbs_nodes_sort_order_check" CHECK (sort_order >= 0);
ALTER TABLE "wbs_nodes" ADD CONSTRAINT "wbs_nodes_parent_check" CHECK (parent_id IS DISTINCT FROM id);
ALTER TABLE "wbs_nodes" ADD CONSTRAINT "wbs_nodes_version_check" CHECK (version >= 1);

-- No node may become its own ancestor. The project row lock serialises concurrent moves.
CREATE FUNCTION app.reject_wbs_cycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM projects WHERE tenant_id = NEW.tenant_id AND id = NEW.project_id FOR UPDATE;
  IF EXISTS (
    WITH RECURSIVE ancestors(id, parent_id, depth) AS (
      SELECT n.id, n.parent_id, 1 FROM wbs_nodes n
        WHERE n.tenant_id = NEW.tenant_id AND n.id = NEW.parent_id
      UNION ALL
      SELECT n.id, n.parent_id, a.depth + 1 FROM wbs_nodes n
        JOIN ancestors a ON n.id = a.parent_id
        WHERE n.tenant_id = NEW.tenant_id AND a.depth < 64
    )
    SELECT 1 FROM ancestors WHERE id = NEW.id
  ) THEN
    RAISE EXCEPTION 'A WBS node cannot be its own ancestor' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER wbs_nodes_no_cycle BEFORE UPDATE OF "parent_id" ON "wbs_nodes"
  FOR EACH ROW EXECUTE FUNCTION app.reject_wbs_cycle();

-- Milestones -------------------------------------------------------------------------------------
CREATE TABLE "milestones" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "wbs_node_id" UUID,
    "name" VARCHAR(150) NOT NULL,
    "due_date" DATE NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'planned',
    "actual_date" DATE,
    "status_reason" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "milestones_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "milestones_tenant_id_id_key" ON "milestones"("tenant_id", "id");
CREATE UNIQUE INDEX "milestones_tenant_id_project_id_name_key" ON "milestones"("tenant_id", "project_id", "name");
CREATE INDEX "milestones_tenant_id_project_id_due_date_idx" ON "milestones"("tenant_id", "project_id", "due_date");
CREATE INDEX "milestones_tenant_id_project_id_wbs_node_id_idx"
  ON "milestones"("tenant_id", "project_id", "wbs_node_id");
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_tenant_id_project_id_fkey"
  FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
-- A milestone's WBS node must belong to the same project in the same company.
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_tenant_id_project_id_wbs_node_id_fkey"
  FOREIGN KEY ("tenant_id", "project_id", "wbs_node_id") REFERENCES "wbs_nodes"("tenant_id", "project_id", "id")
  ON DELETE NO ACTION ON UPDATE CASCADE;
-- packages/types MILESTONE_STATUSES
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_status_check" CHECK (
  status IN ('planned', 'in_progress', 'achieved', 'cancelled')
);
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_actual_date_check" CHECK (
  (status = 'achieved') = (actual_date IS NOT NULL)
);
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_name_check" CHECK (
  char_length(name) >= 1 AND name = btrim(name)
);
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_reason_check" CHECK (
  status_reason IS NULL OR char_length(btrim(status_reason)) BETWEEN 3 AND 500
);
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_version_check" CHECK (version >= 1);

-- Database backstop for packages/domain MILESTONE_TRANSITIONS.
CREATE FUNCTION app.guard_milestone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'planned' THEN
      RAISE EXCEPTION 'A milestone starts as planned' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND (OLD.status, NEW.status) NOT IN (
    ('planned', 'in_progress'), ('planned', 'achieved'), ('in_progress', 'achieved'),
    ('planned', 'cancelled'), ('in_progress', 'cancelled'), ('achieved', 'in_progress')
  ) THEN
    RAISE EXCEPTION 'Milestone status cannot change from % to %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER milestone_guard BEFORE INSERT OR UPDATE ON "milestones"
  FOR EACH ROW EXECUTE FUNCTION app.guard_milestone();

-- Project assignments: the wider project-scoped catalogue (PROJECT_ASSIGNABLE_PERMISSIONS). Every
-- existing value is in the new list, so no row changes; the constraint is checked against every
-- row as it is added.
ALTER TABLE "project_memberships" DROP CONSTRAINT "project_permissions_check";
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_permissions_check" CHECK (
  permissions <@ ARRAY[
    'projects.view', 'projects.manage', 'bq.view', 'bq.edit', 'bq.import',
    'bq.approve_variation', 'labour.view', 'labour.manage', 'labour.view_sensitive',
    'attendance.view', 'attendance.record', 'attendance.override', 'attendance.review_anomalies',
    'payroll.prepare', 'payroll.review', 'procurement.requisition', 'procurement.approve',
    'stores.manage', 'finance.view', 'site.diary', 'site.photos', 'quality.manage',
    'safety.manage', 'plant.manage', 'documents.manage', 'reports.view'
  ]::text[]
);

-- Row-level security -----------------------------------------------------------------------------
ALTER TABLE "project_status_changes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "project_status_changes" FORCE ROW LEVEL SECURITY;
ALTER TABLE "sites" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sites" FORCE ROW LEVEL SECURITY;
ALTER TABLE "site_geofences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "site_geofences" FORCE ROW LEVEL SECURITY;
ALTER TABLE "wbs_nodes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "wbs_nodes" FORCE ROW LEVEL SECURITY;
ALTER TABLE "milestones" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "milestones" FORCE ROW LEVEL SECURITY;

CREATE POLICY project_status_changes_read ON project_status_changes FOR SELECT
  USING (tenant_id = app.current_tenant_id());
CREATE POLICY project_status_changes_insert ON project_status_changes FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id() AND changed_by = app.current_user_id());
CREATE POLICY sites_isolation ON sites
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY site_geofences_read ON site_geofences FOR SELECT
  USING (tenant_id = app.current_tenant_id());
CREATE POLICY site_geofences_insert ON site_geofences FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id() AND created_by = app.current_user_id());
CREATE POLICY wbs_nodes_isolation ON wbs_nodes
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY milestones_isolation ON milestones
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

-- The runtime role never rewrites history, never deletes sites (attendance will reference them)
-- and gets no TRUNCATE, REFERENCES or TRIGGER on the new tables.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmb_app') THEN
    REVOKE UPDATE, DELETE ON "project_status_changes", "site_geofences" FROM pmb_app;
    REVOKE DELETE ON "sites" FROM pmb_app;
    REVOKE TRUNCATE, REFERENCES, TRIGGER
      ON "project_status_changes", "sites", "site_geofences", "wbs_nodes", "milestones" FROM pmb_app;
  END IF;
END
$$;
REVOKE EXECUTE ON FUNCTION app.guard_project() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.reject_history_mutation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.assign_geofence_version() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.reject_wbs_cycle() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_milestone() FROM PUBLIC;

COMMIT;
