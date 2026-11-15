-- D6.2 Schedule (ARCHITECTURE §4.6, ERD §3, WORKFLOWS "Schedule baseline and delay log", brief §5.9
-- and §15 C/E/G). Enforces, in the database as well as the API:
-- * schedule_settings: one working calendar per project (ISO weekdays, public holidays on/off).
-- * schedule_activities: tasks (duration, optional WBS node and BQ item lineage of an approved
--   version, "start no earlier than", actual dates, physical progress with a declared basis) and
--   milestone links (zero-duration markers that reuse `milestones`). Shape, actual-date and
--   progress rules are CHECKs; actual dates never lie in the future (Africa/Nairobi); a started
--   task is never deleted; optimistic versions advance by one.
-- * schedule_dependencies: FS/SS/FF/SF with a lag of −60…365 working days, one per pair, and NO
--   CYCLES (app.reject_schedule_cycle, serialised on the project row).
-- * schedule_baselines + schedule_baseline_items: FROZEN snapshots. Append-only: no UPDATE or
--   DELETE (trigger + privileges); items are written only in the baseline's own transaction and
--   must match its item_count at commit; numbers increase by one per project.
-- * schedule_delays + schedule_delay_activities: a versioned, append-only delay log; each change
--   or withdrawal appends the next version (superseding the previous exactly once).
-- * Closed and cancelled projects are read-only for every schedule table.
-- Every table has tenant_id, forced RLS with WITH CHECK and composite (tenant_id, …) foreign keys.
-- No new permissions: reading needs projects.view, changing projects.manage (API, like WBS and
-- milestones), so the permission CHECK constraints are unchanged.
BEGIN;

-- CreateTable
CREATE TABLE "schedule_settings" (
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "working_weekdays" INTEGER[],
    "include_public_holidays" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schedule_settings_pkey" PRIMARY KEY ("tenant_id","project_id")
);

-- CreateTable
CREATE TABLE "schedule_activities" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "kind" VARCHAR(10) NOT NULL,
    "milestone_id" UUID,
    "wbs_node_id" UUID,
    "bq_version_id" UUID,
    "bq_item_lineage_id" UUID,
    "code" VARCHAR(20),
    "name" VARCHAR(150),
    "duration_days" INTEGER NOT NULL,
    "start_no_earlier_than" DATE,
    "actual_start" DATE,
    "actual_finish" DATE,
    "progress_basis" VARCHAR(10),
    "percent_complete" DECIMAL(5,2),
    "quantity_done" DECIMAL(20,4),
    "quantity_total" DECIMAL(20,4),
    "quantity_unit" VARCHAR(20),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schedule_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_dependencies" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "predecessor_id" UUID NOT NULL,
    "successor_id" UUID NOT NULL,
    "type" VARCHAR(2) NOT NULL,
    "lag_days" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schedule_dependencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_baselines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "baseline_no" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "data_date" DATE NOT NULL,
    "start_date" DATE NOT NULL,
    "project_finish" DATE,
    "working_weekdays" INTEGER[],
    "include_public_holidays" BOOLEAN NOT NULL,
    "item_count" INTEGER NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schedule_baselines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_baseline_items" (
    "tenant_id" UUID NOT NULL,
    "baseline_id" UUID NOT NULL,
    "kind" VARCHAR(10) NOT NULL,
    "ref_id" UUID NOT NULL,
    "code" VARCHAR(20),
    "name" VARCHAR(150) NOT NULL,
    "wbs_node_id" UUID,
    "start_date" DATE NOT NULL,
    "finish_date" DATE NOT NULL,
    "duration_days" INTEGER NOT NULL,
    "total_float_days" INTEGER,
    "critical" BOOLEAN NOT NULL,

    CONSTRAINT "schedule_baseline_items_pkey" PRIMARY KEY ("tenant_id","baseline_id","kind","ref_id")
);

-- CreateTable
CREATE TABLE "schedule_delays" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "delay_id" UUID NOT NULL,
    "delay_no" INTEGER NOT NULL,
    "version_no" INTEGER NOT NULL,
    "supersedes_id" UUID,
    "status" VARCHAR(10) NOT NULL,
    "cause" VARCHAR(30) NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "working_days_lost" DECIMAL(5,1) NOT NULL,
    "description" VARCHAR(2000) NOT NULL,
    "site_diary_id" UUID,
    "claim_flag" VARCHAR(20) NOT NULL,
    "change_reason" VARCHAR(500),
    "recorded_by" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schedule_delays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_delay_activities" (
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "delay_version_id" UUID NOT NULL,
    "activity_id" UUID NOT NULL,

    CONSTRAINT "schedule_delay_activities_pkey" PRIMARY KEY ("tenant_id","delay_version_id","activity_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "schedule_activities_tenant_id_id_key" ON "schedule_activities"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_activities_tenant_id_project_id_id_key" ON "schedule_activities"("tenant_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_activities_tenant_id_project_id_code_key" ON "schedule_activities"("tenant_id", "project_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_activities_tenant_id_project_id_milestone_id_key" ON "schedule_activities"("tenant_id", "project_id", "milestone_id");

-- CreateIndex
CREATE INDEX "schedule_dependencies_tenant_id_project_id_successor_id_idx" ON "schedule_dependencies"("tenant_id", "project_id", "successor_id");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_dependencies_tenant_id_id_key" ON "schedule_dependencies"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_dependencies_tenant_id_project_id_predecessor_id_s_key" ON "schedule_dependencies"("tenant_id", "project_id", "predecessor_id", "successor_id");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_baselines_tenant_id_id_key" ON "schedule_baselines"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_baselines_tenant_id_project_id_id_key" ON "schedule_baselines"("tenant_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_baselines_tenant_id_project_id_baseline_no_key" ON "schedule_baselines"("tenant_id", "project_id", "baseline_no");

-- CreateIndex
CREATE INDEX "schedule_delays_tenant_id_project_id_delay_no_idx" ON "schedule_delays"("tenant_id", "project_id", "delay_no");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_delays_tenant_id_id_key" ON "schedule_delays"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_delays_tenant_id_project_id_id_key" ON "schedule_delays"("tenant_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_delays_tenant_id_project_id_supersedes_id_key" ON "schedule_delays"("tenant_id", "project_id", "supersedes_id");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_delays_tenant_id_delay_id_version_no_key" ON "schedule_delays"("tenant_id", "delay_id", "version_no");

-- CreateIndex
CREATE INDEX "schedule_delay_activities_tenant_id_project_id_activity_id_idx" ON "schedule_delay_activities"("tenant_id", "project_id", "activity_id");

-- CreateIndex
CREATE UNIQUE INDEX "milestones_tenant_id_project_id_id_key" ON "milestones"("tenant_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "site_diaries_tenant_id_project_id_id_key" ON "site_diaries"("tenant_id", "project_id", "id");

-- AddForeignKey
ALTER TABLE "schedule_settings" ADD CONSTRAINT "schedule_settings_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_activities" ADD CONSTRAINT "schedule_activities_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_activities" ADD CONSTRAINT "schedule_activities_tenant_id_project_id_milestone_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "milestone_id") REFERENCES "milestones"("tenant_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_activities" ADD CONSTRAINT "schedule_activities_tenant_id_project_id_wbs_node_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "wbs_node_id") REFERENCES "wbs_nodes"("tenant_id", "project_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_activities" ADD CONSTRAINT "schedule_activities_tenant_id_bq_version_id_bq_item_lineag_fkey" FOREIGN KEY ("tenant_id", "bq_version_id", "bq_item_lineage_id") REFERENCES "bq_items"("tenant_id", "version_id", "lineage_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_dependencies" ADD CONSTRAINT "schedule_dependencies_tenant_id_project_id_predecessor_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "predecessor_id") REFERENCES "schedule_activities"("tenant_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_dependencies" ADD CONSTRAINT "schedule_dependencies_tenant_id_project_id_successor_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "successor_id") REFERENCES "schedule_activities"("tenant_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_baselines" ADD CONSTRAINT "schedule_baselines_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_baseline_items" ADD CONSTRAINT "schedule_baseline_items_tenant_id_baseline_id_fkey" FOREIGN KEY ("tenant_id", "baseline_id") REFERENCES "schedule_baselines"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_delays" ADD CONSTRAINT "schedule_delays_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_delays" ADD CONSTRAINT "schedule_delays_tenant_id_project_id_delay_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "delay_id") REFERENCES "schedule_delays"("tenant_id", "project_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_delays" ADD CONSTRAINT "schedule_delays_tenant_id_project_id_supersedes_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "supersedes_id") REFERENCES "schedule_delays"("tenant_id", "project_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_delays" ADD CONSTRAINT "schedule_delays_tenant_id_project_id_site_diary_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "site_diary_id") REFERENCES "site_diaries"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_delay_activities" ADD CONSTRAINT "schedule_delay_activities_tenant_id_project_id_delay_versi_fkey" FOREIGN KEY ("tenant_id", "project_id", "delay_version_id") REFERENCES "schedule_delays"("tenant_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_delay_activities" ADD CONSTRAINT "schedule_delay_activities_tenant_id_project_id_activity_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "activity_id") REFERENCES "schedule_activities"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Shared guards ----------------------------------------------------------------------------------
-- Closed and cancelled projects are read-only (packages/domain isProjectReadOnly). FOR SHARE
-- waits for a concurrent status change.
CREATE FUNCTION app.assert_schedule_writable(target_tenant uuid, target_project uuid)
  RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  project_status text;
BEGIN
  SELECT status INTO project_status FROM projects
    WHERE tenant_id = target_tenant AND id = target_project FOR SHARE;
  IF project_status IN ('closed', 'cancelled') THEN
    RAISE EXCEPTION 'Closed and cancelled projects are read-only' USING ERRCODE = '23514';
  END IF;
END
$$;

-- Working calendar -------------------------------------------------------------------------------
ALTER TABLE "schedule_settings" ADD CONSTRAINT "schedule_settings_check" CHECK (
  working_weekdays IS NOT NULL
  AND cardinality(working_weekdays) BETWEEN 1 AND 7
  AND working_weekdays <@ ARRAY[1, 2, 3, 4, 5, 6, 7]
  AND array_position(working_weekdays, NULL) IS NULL
  AND version >= 1
);
CREATE FUNCTION app.guard_schedule_settings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM app.assert_schedule_writable(NEW.tenant_id, NEW.project_id);
  IF NEW.updated_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'Settings are changed by the signed-in user' USING ERRCODE = '23514';
  END IF;
  IF (SELECT count(DISTINCT day) FROM unnest(NEW.working_weekdays) AS day)
      <> cardinality(NEW.working_weekdays) THEN
    RAISE EXCEPTION 'Working weekdays must not repeat' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION 'Settings start at version 1' USING ERRCODE = '23514';
    END IF;
  ELSIF ROW(NEW.tenant_id, NEW.project_id) IS DISTINCT FROM ROW(OLD.tenant_id, OLD.project_id)
    OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'The project is fixed and the version must advance' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER schedule_settings_guard BEFORE INSERT OR UPDATE ON "schedule_settings"
  FOR EACH ROW EXECUTE FUNCTION app.guard_schedule_settings();

-- Activities and milestone links -----------------------------------------------------------------
-- packages/types SCHEDULE_ITEM_KINDS, PROGRESS_BASES, SCHEDULE_LIMITS.maxDurationDays.
ALTER TABLE "schedule_activities" ADD CONSTRAINT "schedule_activities_shape_check" CHECK (
  version >= 1
  AND (bq_version_id IS NULL) = (bq_item_lineage_id IS NULL)
  AND COALESCE(CASE kind
    WHEN 'task' THEN milestone_id IS NULL
      AND code ~ '^[A-Za-z0-9][A-Za-z0-9.-]{0,19}$'
      AND char_length(name) >= 1 AND name = btrim(name)
      AND duration_days BETWEEN 1 AND 1000
      AND progress_basis IN ('physical', 'quantity')
    WHEN 'milestone' THEN milestone_id IS NOT NULL AND code IS NULL AND name IS NULL
      AND wbs_node_id IS NULL AND bq_version_id IS NULL AND duration_days = 0
      AND start_no_earlier_than IS NULL AND actual_start IS NULL AND actual_finish IS NULL
      AND progress_basis IS NULL AND percent_complete IS NULL AND quantity_done IS NULL
      AND quantity_total IS NULL AND quantity_unit IS NULL
    ELSE false END, false)
);
-- Actual dates and physical progress (packages/domain checkActivityProgress): a finish needs a
-- start on or before it; 100 % exactly when finished; nothing reported before the start; a
-- physical estimate is a whole percent; a quantity percent is done ÷ total rounded down to 0.01.
ALTER TABLE "schedule_activities" ADD CONSTRAINT "schedule_activities_progress_check" CHECK (
  kind = 'milestone' OR COALESCE(
    (actual_finish IS NULL OR (actual_start IS NOT NULL AND actual_finish >= actual_start))
    AND (percent_complete IS NULL OR percent_complete BETWEEN 0 AND 100)
    AND CASE progress_basis
      WHEN 'physical' THEN quantity_done IS NULL AND quantity_total IS NULL
        AND quantity_unit IS NULL
        AND (percent_complete IS NULL OR percent_complete = trunc(percent_complete))
      WHEN 'quantity' THEN quantity_total > 0 AND quantity_done BETWEEN 0 AND quantity_total
        AND char_length(btrim(quantity_unit)) BETWEEN 1 AND 20
        AND percent_complete = trunc(quantity_done * 10000 / quantity_total) / 100
      ELSE false END
    AND CASE
      WHEN actual_finish IS NOT NULL THEN percent_complete = 100
      WHEN actual_start IS NOT NULL THEN percent_complete IS NULL OR percent_complete < 100
      ELSE (percent_complete IS NULL OR percent_complete = 0)
        AND (quantity_done IS NULL OR quantity_done = 0)
    END, false)
);

CREATE FUNCTION app.guard_schedule_activity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bq_project uuid;
  bq_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM app.assert_schedule_writable(OLD.tenant_id, OLD.project_id);
    IF OLD.kind = 'task' AND OLD.actual_start IS NOT NULL THEN
      RAISE EXCEPTION 'A started activity cannot be deleted' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  PERFORM app.assert_schedule_writable(NEW.tenant_id, NEW.project_id);
  IF NEW.updated_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'Activities are changed by the signed-in user' USING ERRCODE = '23514';
  END IF;
  IF NEW.actual_start > app.business_today() OR NEW.actual_finish > app.business_today() THEN
    RAISE EXCEPTION 'Actual dates cannot be in the future' USING ERRCODE = '23514';
  END IF;
  IF NEW.bq_version_id IS NOT NULL AND (TG_OP = 'INSERT'
      OR NEW.bq_version_id IS DISTINCT FROM OLD.bq_version_id) THEN
    SELECT project_id, status INTO bq_project, bq_status FROM bq_versions
      WHERE tenant_id = NEW.tenant_id AND id = NEW.bq_version_id;
    IF bq_project IS DISTINCT FROM NEW.project_id OR bq_status IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION 'A BQ link must name an approved version of the same project'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 OR NEW.created_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'An activity starts at version 1, created by the signed-in user'
        USING ERRCODE = '23514';
    END IF;
    NEW.created_at := now();
  ELSIF ROW(NEW.id, NEW.tenant_id, NEW.project_id, NEW.kind, NEW.milestone_id, NEW.created_by,
      NEW.created_at) IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.project_id, OLD.kind,
      OLD.milestone_id, OLD.created_by, OLD.created_at)
    OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Activity identity is fixed and its version must advance'
      USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER schedule_activity_guard BEFORE INSERT OR UPDATE OR DELETE ON "schedule_activities"
  FOR EACH ROW EXECUTE FUNCTION app.guard_schedule_activity();

-- Dependencies -----------------------------------------------------------------------------------
-- packages/types DEPENDENCY_TYPES and SCHEDULE_LIMITS (lag −60…365 working days).
ALTER TABLE "schedule_dependencies" ADD CONSTRAINT "schedule_dependencies_check" CHECK (
  type IN ('FS', 'SS', 'FF', 'SF')
  AND lag_days BETWEEN -60 AND 365
  AND predecessor_id <> successor_id
  AND version >= 1
);
-- No dependency may close a loop (packages/domain dependencyCreatesCycle). The project row lock
-- serialises concurrent inserts, so two links that together form a cycle cannot both commit.
CREATE FUNCTION app.reject_schedule_cycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM projects WHERE tenant_id = NEW.tenant_id AND id = NEW.project_id FOR UPDATE;
  IF EXISTS (
    WITH RECURSIVE reach(id) AS (
      SELECT NEW.successor_id
      UNION
      SELECT d.successor_id FROM schedule_dependencies d
        JOIN reach r ON d.predecessor_id = r.id
        WHERE d.tenant_id = NEW.tenant_id AND d.project_id = NEW.project_id
    )
    SELECT 1 FROM reach WHERE id = NEW.predecessor_id
  ) THEN
    RAISE EXCEPTION 'A schedule dependency cannot create a cycle' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE FUNCTION app.guard_schedule_dependency() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM app.assert_schedule_writable(OLD.tenant_id, OLD.project_id);
    RETURN OLD;
  END IF;
  PERFORM app.assert_schedule_writable(NEW.tenant_id, NEW.project_id);
  IF NEW.updated_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'Dependencies are changed by the signed-in user' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 OR NEW.created_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'A dependency starts at version 1, created by the signed-in user'
        USING ERRCODE = '23514';
    END IF;
    NEW.created_at := now();
  ELSIF ROW(NEW.id, NEW.tenant_id, NEW.project_id, NEW.predecessor_id, NEW.successor_id,
      NEW.created_by, NEW.created_at) IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.project_id,
      OLD.predecessor_id, OLD.successor_id, OLD.created_by, OLD.created_at)
    OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'A dependency links the same items for life and its version must advance'
      USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER schedule_dependency_guard BEFORE INSERT OR UPDATE OR DELETE ON "schedule_dependencies"
  FOR EACH ROW EXECUTE FUNCTION app.guard_schedule_dependency();
CREATE TRIGGER schedule_dependency_no_cycle BEFORE INSERT ON "schedule_dependencies"
  FOR EACH ROW EXECUTE FUNCTION app.reject_schedule_cycle();

-- Baselines (frozen) -----------------------------------------------------------------------------
ALTER TABLE "schedule_baselines" ADD CONSTRAINT "schedule_baselines_check" CHECK (
  baseline_no >= 1
  AND char_length(name) >= 1 AND name = btrim(name)
  AND char_length(btrim(reason)) BETWEEN 3 AND 500
  AND working_weekdays IS NOT NULL AND cardinality(working_weekdays) BETWEEN 1 AND 7
  AND working_weekdays <@ ARRAY[1, 2, 3, 4, 5, 6, 7]
  AND item_count >= 1
);
ALTER TABLE "schedule_baseline_items" ADD CONSTRAINT "schedule_baseline_items_check" CHECK (
  kind IN ('task', 'milestone')
  AND finish_date >= start_date
  AND duration_days >= 0
  AND (kind = 'task' OR (duration_days = 0 AND start_date = finish_date))
  AND char_length(name) >= 1
);
-- A baseline is numbered next for its project, frozen as of a data date that is not in the
-- future, stamped with the database clock and created by the signed-in user.
CREATE FUNCTION app.guard_schedule_baseline() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  latest integer;
BEGIN
  PERFORM app.assert_schedule_writable(NEW.tenant_id, NEW.project_id);
  PERFORM 1 FROM projects WHERE tenant_id = NEW.tenant_id AND id = NEW.project_id FOR UPDATE;
  SELECT max(baseline_no) INTO latest FROM schedule_baselines
    WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id;
  IF NEW.baseline_no <> COALESCE(latest, 0) + 1 THEN
    RAISE EXCEPTION 'Baselines are numbered in order' USING ERRCODE = '23514';
  END IF;
  IF NEW.created_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A baseline is frozen by the signed-in user' USING ERRCODE = '23514';
  END IF;
  IF NEW.data_date > app.business_today() THEN
    RAISE EXCEPTION 'A baseline cannot be frozen as of a future date' USING ERRCODE = '23514';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER schedule_baseline_guard BEFORE INSERT ON "schedule_baselines"
  FOR EACH ROW EXECUTE FUNCTION app.guard_schedule_baseline();
-- Items are written only in the baseline's own transaction (its created_at is that transaction's
-- now()), so a frozen baseline can never gain items later.
CREATE FUNCTION app.guard_schedule_baseline_item() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schedule_baselines
     WHERE tenant_id = NEW.tenant_id AND id = NEW.baseline_id AND created_at = now()
  ) THEN
    RAISE EXCEPTION 'Baseline items are written only with their baseline' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER schedule_baseline_item_guard BEFORE INSERT ON "schedule_baseline_items"
  FOR EACH ROW EXECUTE FUNCTION app.guard_schedule_baseline_item();
-- At commit, a baseline holds exactly the items it declares.
CREATE FUNCTION app.check_schedule_baseline_items() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM schedule_baseline_items
       WHERE tenant_id = NEW.tenant_id AND baseline_id = NEW.id) <> NEW.item_count THEN
    RAISE EXCEPTION 'A baseline must hold exactly its declared items' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER schedule_baseline_items_complete AFTER INSERT ON "schedule_baselines"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_schedule_baseline_items();
CREATE TRIGGER schedule_baselines_append_only BEFORE UPDATE OR DELETE ON "schedule_baselines"
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
CREATE TRIGGER schedule_baseline_items_append_only BEFORE UPDATE OR DELETE ON "schedule_baseline_items"
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();

-- Delay log (versioned, append-only) -------------------------------------------------------------
-- packages/types DELAY_CAUSES, DELAY_CLAIM_FLAGS, DELAY_STATUSES, SCHEDULE_LIMITS.maxDelayDays.
ALTER TABLE "schedule_delays" ADD CONSTRAINT "schedule_delays_check" CHECK (
  delay_no >= 1 AND version_no >= 1
  AND (version_no = 1) = (supersedes_id IS NULL)
  AND (version_no = 1) = (delay_id = id)
  AND (version_no = 1) = (change_reason IS NULL)
  AND (version_no > 1 OR status = 'recorded')
  AND status IN ('recorded', 'withdrawn')
  AND cause IN ('weather', 'client_instruction', 'design_information', 'supplier_material',
    'labour', 'plant', 'statutory_permits', 'site_conditions', 'late_payment', 'other')
  AND claim_flag IN ('not_assessed', 'non_excusable', 'excusable', 'compensable')
  AND working_days_lost BETWEEN 0 AND 1000
  AND working_days_lost * 2 = trunc(working_days_lost * 2)
  AND (end_date IS NULL OR end_date >= start_date)
  AND char_length(btrim(description)) BETWEEN 3 AND 2000
  AND (change_reason IS NULL OR char_length(btrim(change_reason)) BETWEEN 3 AND 500)
);
-- One delay number per project (the first version holds it).
CREATE UNIQUE INDEX "schedule_delays_one_number_per_project"
  ON "schedule_delays"("tenant_id", "project_id", "delay_no") WHERE version_no = 1;

CREATE FUNCTION app.guard_schedule_delay() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  latest integer;
  previous schedule_delays%ROWTYPE;
BEGIN
  PERFORM app.assert_schedule_writable(NEW.tenant_id, NEW.project_id);
  PERFORM 1 FROM projects WHERE tenant_id = NEW.tenant_id AND id = NEW.project_id FOR UPDATE;
  IF NEW.recorded_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A delay is recorded by the signed-in user' USING ERRCODE = '23514';
  END IF;
  IF NEW.start_date > app.business_today() OR NEW.end_date > app.business_today() THEN
    RAISE EXCEPTION 'A delay cannot be recorded for future dates' USING ERRCODE = '23514';
  END IF;
  IF NEW.version_no = 1 THEN
    SELECT max(delay_no) INTO latest FROM schedule_delays
      WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id;
    IF NEW.delay_no <> COALESCE(latest, 0) + 1 THEN
      RAISE EXCEPTION 'Delays are numbered in order' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT * INTO previous FROM schedule_delays
      WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id AND id = NEW.supersedes_id;
    IF previous.id IS NULL OR previous.delay_id <> NEW.delay_id
      OR previous.delay_no <> NEW.delay_no OR previous.version_no <> NEW.version_no - 1 THEN
      RAISE EXCEPTION 'A delay version follows its previous version' USING ERRCODE = '23514';
    END IF;
    IF previous.status = 'withdrawn' THEN
      RAISE EXCEPTION 'A withdrawn delay cannot change' USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.recorded_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER schedule_delay_guard BEFORE INSERT ON "schedule_delays"
  FOR EACH ROW EXECUTE FUNCTION app.guard_schedule_delay();
CREATE TRIGGER schedule_delays_append_only BEFORE UPDATE OR DELETE ON "schedule_delays"
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();

-- Affected activities are tasks, written in their delay version's own transaction.
CREATE FUNCTION app.guard_schedule_delay_activity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schedule_delays
     WHERE tenant_id = NEW.tenant_id AND id = NEW.delay_version_id AND recorded_at = now()
  ) THEN
    RAISE EXCEPTION 'Affected activities are written only with their delay version'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM schedule_activities
     WHERE tenant_id = NEW.tenant_id AND id = NEW.activity_id AND kind = 'task'
  ) THEN
    RAISE EXCEPTION 'A delay affects tasks only' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER schedule_delay_activity_guard BEFORE INSERT ON "schedule_delay_activities"
  FOR EACH ROW EXECUTE FUNCTION app.guard_schedule_delay_activity();
CREATE TRIGGER schedule_delay_activities_append_only BEFORE UPDATE OR DELETE ON "schedule_delay_activities"
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();

-- Row-level security -----------------------------------------------------------------------------
DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['schedule_settings', 'schedule_activities',
    'schedule_dependencies', 'schedule_baselines', 'schedule_baseline_items', 'schedule_delays',
    'schedule_delay_activities']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = app.current_tenant_id()) '
      'WITH CHECK (tenant_id = app.current_tenant_id())', target || '_isolation', target);
  END LOOP;
END
$$;

-- The runtime role never rewrites baselines or the delay log and never deletes settings; it may
-- delete unstarted tasks (the trigger checks) and dependencies.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmb_app') THEN
    REVOKE UPDATE, DELETE ON "schedule_baselines", "schedule_baseline_items", "schedule_delays",
      "schedule_delay_activities" FROM pmb_app;
    REVOKE DELETE ON "schedule_settings" FROM pmb_app;
    REVOKE TRUNCATE, REFERENCES, TRIGGER
      ON "schedule_settings", "schedule_activities", "schedule_dependencies",
         "schedule_baselines", "schedule_baseline_items", "schedule_delays",
         "schedule_delay_activities"
      FROM pmb_app;
    GRANT EXECUTE ON FUNCTION app.assert_schedule_writable(uuid, uuid) TO pmb_app;
  END IF;
END
$$;
REVOKE EXECUTE ON FUNCTION app.assert_schedule_writable(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_schedule_settings() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_schedule_activity() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.reject_schedule_cycle() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_schedule_dependency() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_schedule_baseline() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_schedule_baseline_item() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_schedule_baseline_items() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_schedule_delay() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_schedule_delay_activity() FROM PUBLIC;

COMMIT;
