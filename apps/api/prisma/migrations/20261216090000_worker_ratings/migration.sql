-- D3.5 Worker ratings (ARCHITECTURE §4.2, ERD §3, WORKFLOWS "Worker ratings", brief §5.4).
-- Enforces, in the database as well as the API:
-- * ONE RATING PER WORKER, PROJECT AND DAY: punctuality, quality, safety and teamwork, each 1–5,
--   with an optional comment the worker can read in their portal (unique index).
-- * ONLY WORKED DAYS, ONLY RECENT ONES: a worker can be rated for a day only when attendance
--   records them present or half day on one of the project's sites, and only for today or the six
--   days before (Africa/Nairobi), on a project that is not closed or cancelled.
-- * THE RATER OWNS THE RATING, FOR ONE DAY: it is given by the signed-in user at the database
--   time, and only that person may change it, on the same Nairobi day; every change is versioned.
--   Nothing deletes a rating except erasing the worker's record (trigger + revoked privilege).
-- * The new permission labour.rate joins the role and project-assignment CHECKs (the lists equal
--   packages/types TENANT_PERMISSIONS and PROJECT_ASSIGNABLE_PERMISSIONS). Project managers, site
--   agents and foremen already assigned to a project with labour.view get it there.
-- Every table has tenant_id, forced RLS with WITH CHECK and composite (tenant_id, …) foreign keys.
BEGIN;

-- CreateTable
CREATE TABLE "labourer_ratings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "labourer_id" UUID NOT NULL,
    "work_date" DATE NOT NULL,
    "punctuality" SMALLINT NOT NULL,
    "quality" SMALLINT NOT NULL,
    "safety" SMALLINT NOT NULL,
    "teamwork" SMALLINT NOT NULL,
    "comment" VARCHAR(500),
    "rated_by" UUID NOT NULL,
    "rated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changed_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "labourer_ratings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "labourer_ratings_tenant_id_id_key" ON "labourer_ratings"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "labourer_ratings_tenant_id_project_id_labourer_id_work_date_key" ON "labourer_ratings"("tenant_id", "project_id", "labourer_id", "work_date");

-- CreateIndex
CREATE INDEX "labourer_ratings_tenant_id_labourer_id_work_date_idx" ON "labourer_ratings"("tenant_id", "labourer_id", "work_date");

-- AddForeignKey
ALTER TABLE "labourer_ratings" ADD CONSTRAINT "labourer_ratings_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "labourer_ratings" ADD CONSTRAINT "labourer_ratings_tenant_id_labourer_id_fkey" FOREIGN KEY ("tenant_id", "labourer_id") REFERENCES "labourers"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Ratings (packages/types RATING_CRITERIA, RATING_SCORE_LIMITS, RATING_COMMENT_MAX_LENGTH) ------
ALTER TABLE "labourer_ratings" ADD CONSTRAINT "labourer_ratings_check" CHECK (
  punctuality BETWEEN 1 AND 5
  AND quality BETWEEN 1 AND 5
  AND safety BETWEEN 1 AND 5
  AND teamwork BETWEEN 1 AND 5
  AND (comment IS NULL OR (char_length(comment) BETWEEN 1 AND 500 AND comment = btrim(comment)))
  AND version >= 1
  AND (version = 1) = (changed_at IS NULL)
);

-- packages/domain ratingWindow (RATING_WINDOW_DAYS = 7) and canChangeRating.
CREATE FUNCTION app.guard_labourer_rating() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  today date := (now() AT TIME ZONE 'Africa/Nairobi')::date;
  project_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Only together with the worker's record (labourers ON DELETE CASCADE runs after its row went).
    IF EXISTS (SELECT 1 FROM labourers WHERE tenant_id = OLD.tenant_id AND id = OLD.labourer_id) THEN
      RAISE EXCEPTION 'Worker ratings are never deleted' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.rated_by IS DISTINCT FROM app.current_user_id() OR NEW.version <> 1
      OR NEW.changed_at IS NOT NULL THEN
      RAISE EXCEPTION 'A rating is given by the signed-in user' USING ERRCODE = '23514';
    END IF;
    IF NEW.work_date NOT BETWEEN today - 6 AND today THEN
      RAISE EXCEPTION 'Only today and the six days before can be rated' USING ERRCODE = '23514';
    END IF;
    NEW.rated_at := now();
  ELSE
    IF ROW(NEW.id, NEW.tenant_id, NEW.project_id, NEW.labourer_id, NEW.work_date, NEW.rated_by,
        NEW.rated_at)
      IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.project_id, OLD.labourer_id, OLD.work_date,
        OLD.rated_by, OLD.rated_at)
      OR NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'A rating keeps its worker, project, day and rater; changes are versioned'
        USING ERRCODE = '23514';
    END IF;
    IF OLD.rated_by IS DISTINCT FROM app.current_user_id()
      OR (OLD.rated_at AT TIME ZONE 'Africa/Nairobi')::date <> today THEN
      RAISE EXCEPTION 'Only the rater can change a rating, on the day they gave it'
        USING ERRCODE = '23514';
    END IF;
    NEW.changed_at := now();
  END IF;
  -- A rating, and every change to it, rests on attendance recording the day as worked (present or
  -- half day). Attendance stays correctable: a rating whose day no longer is stays, set aside.
  IF NOT EXISTS (
    SELECT 1 FROM attendance_records r
    WHERE r.tenant_id = NEW.tenant_id AND r.project_id = NEW.project_id
      AND r.labourer_id = NEW.labourer_id AND r.work_date = NEW.work_date
      AND r.status IN ('present', 'half_day')
  ) THEN
    RAISE EXCEPTION 'Only a worker recorded as working that day on the project can be rated'
      USING ERRCODE = '23514';
  END IF;
  -- Closed and cancelled projects are read-only (packages/domain isProjectReadOnly). FOR SHARE
  -- waits for a concurrent status change.
  SELECT status INTO project_status FROM projects
    WHERE tenant_id = NEW.tenant_id AND id = NEW.project_id FOR SHARE;
  IF project_status IS NULL OR project_status IN ('closed', 'cancelled') THEN
    RAISE EXCEPTION 'Closed and cancelled projects are read-only' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER labourer_rating_guard BEFORE INSERT OR UPDATE OR DELETE ON "labourer_ratings"
  FOR EACH ROW EXECUTE FUNCTION app.guard_labourer_rating();

-- Row-level security -----------------------------------------------------------------------------
ALTER TABLE "labourer_ratings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "labourer_ratings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "labourer_ratings_isolation" ON "labourer_ratings"
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

-- The runtime role never deletes ratings.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmb_app') THEN
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON "labourer_ratings" FROM pmb_app;
  END IF;
END
$$;
REVOKE EXECUTE ON FUNCTION app.guard_labourer_rating() FROM PUBLIC;

-- Permissions (packages/types PERMISSIONS, PROJECT_ASSIGNABLE_PERMISSIONS): labour.rate ---------
ALTER TABLE "tenant_roles" DROP CONSTRAINT "tenant_roles_permissions_check";
ALTER TABLE "tenant_roles" ADD CONSTRAINT "tenant_roles_permissions_check" CHECK (
  permissions IS NOT NULL
  AND cardinality(permissions) >= 1
  AND permissions <@ ARRAY[
    'tenancy.manage', 'users.invite', 'roles.manage', 'audit.view', 'config.manage',
    'config.manage_statutory', 'projects.view', 'projects.create', 'projects.manage', 'bq.view',
    'bq.edit', 'bq.import', 'bq.approve_variation', 'labour.view', 'labour.manage',
    'labour.view_sensitive', 'labour.do_not_rehire', 'labour.consent', 'labour.rate',
    'attendance.view', 'attendance.record', 'attendance.override', 'attendance.review_anomalies',
    'attendance.confirm', 'timesheets.submit', 'timesheets.approve', 'timesheets.manage_rules',
    'payroll.view', 'payroll.prepare', 'payroll.review', 'payroll.approve', 'payroll.manage_rules',
    'payroll.verify_rules', 'payroll.export', 'advances.request', 'advances.approve',
    'payments.view', 'payments.approve', 'payments.disburse', 'payments.record_cash',
    'payments.reverse', 'payments.manage_credentials', 'payments.review', 'payments.initiate_test',
    'procurement.requisition', 'procurement.approve', 'procurement.manage_suppliers',
    'stores.manage', 'finance.view', 'finance.manage', 'finance.view_sensitive',
    'finance.petty_cash', 'site.diary', 'site.photos', 'quality.manage', 'safety.manage',
    'plant.manage', 'documents.manage', 'reports.view', 'portal.client', 'portal.supplier',
    'portal.worker'
  ]::text[]
);
ALTER TABLE "project_memberships" DROP CONSTRAINT "project_permissions_check";
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_permissions_check" CHECK (
  permissions <@ ARRAY[
    'projects.view', 'projects.manage', 'bq.view', 'bq.edit', 'bq.import', 'bq.approve_variation',
    'labour.view', 'labour.manage', 'labour.view_sensitive', 'labour.do_not_rehire',
    'labour.consent', 'labour.rate', 'attendance.view', 'attendance.record', 'attendance.override',
    'attendance.review_anomalies', 'attendance.confirm', 'timesheets.submit', 'timesheets.approve',
    'timesheets.manage_rules', 'payroll.view', 'payroll.prepare', 'payroll.review',
    'advances.request', 'advances.approve', 'procurement.requisition', 'procurement.approve',
    'stores.manage', 'finance.view', 'finance.petty_cash', 'site.diary', 'site.photos',
    'quality.manage', 'safety.manage', 'plant.manage', 'documents.manage', 'reports.view',
    'portal.client', 'portal.worker'
  ]::text[]
);

-- The people already running a project's workers can rate them there: project managers, site
-- agents and foremen whose assignment includes labour.view. Custom roles gain labour.rate only
-- when an administrator adds it. The schema owner is subject to FORCE ROW LEVEL SECURITY without
-- a tenant context, so FORCE is lifted only for this backfill (ALTER TABLE holds an exclusive
-- lock) and restored.
ALTER TABLE "project_memberships" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "memberships" NO FORCE ROW LEVEL SECURITY;
UPDATE project_memberships pm
  SET permissions = array_append(pm.permissions, 'labour.rate')
  FROM memberships m
  WHERE m.tenant_id = pm.tenant_id AND m.user_id = pm.user_id
    AND m.role IN ('project_manager', 'site_agent', 'foreman')
    AND 'labour.view' = ANY (pm.permissions)
    AND NOT ('labour.rate' = ANY (pm.permissions));
ALTER TABLE "memberships" FORCE ROW LEVEL SECURITY;
ALTER TABLE "project_memberships" FORCE ROW LEVEL SECURITY;

COMMIT;
