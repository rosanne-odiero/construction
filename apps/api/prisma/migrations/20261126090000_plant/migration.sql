-- D8.3 Plant and equipment (brief §5.13 "owned and hired plant (mixers, vibrators, excavators,
-- scaffolding, formwork): hire rates, days/hours used, fuel issued and consumption, breakdowns,
-- maintenance, operator assignment" and §15 C/G; ARCHITECTURE §4.11; ERD §9; WORKFLOWS "Plant and
-- equipment"). Enforces, in the database as well as the API:
-- * plant_settings: the company's fuel variance tolerance and minimum sample, idle-hire and
--   hire-ending windows, service warning and the categories whose operators need a certificate.
-- * plant_items: the company register (code unique per company; owned, or hired with a supplier,
--   rate and hire start); code, ownership, meter, fuel type and opening reading are fixed. The
--   item's site is its last move's destination and its status follows that site, open major or
--   unsafe breakdowns and closure (off hire for hired plant, disposed for owned; FINAL), checked at
--   commit by app.check_plant_state.
-- * plant_moves (append-only, numbered per item, dated in order): yard ⇄ project sites; usage and
--   fuel are only accepted at a site on a day the item was there (app.plant_present).
-- * plant_operators: a labourer engaged on the project or a company member, for a period without
--   overlap; ended once, never deleted.
-- * plant_usage_logs and plant_fuel_issues (append-only; a correction or void is a new row naming
--   the row it replaces, once): meter readings may never go backwards in time
--   (app.check_plant_reading) unless a meter reset (plant_meter_resets, append-only, after every
--   reading) lies between; one day's usage is at most 24.0 hours or 1,500 km; no working day while
--   an unsafe breakdown is open; operators must be assigned on the day; a fuel issue carries the
--   standard consumption in force. Neither posts to the stores or cost ledgers (decision D-93).
-- * plant_breakdowns (BRK-NNNN per company): open → repaired | off_hire (hired) | written_off
--   (owned), final once resolved. plant_services: append-only, voided with a reason.
-- * Every record is stamped by the database clock; closed and cancelled projects are read-only.
--   Guards never skip their checks because they run inside another trigger.
-- Every table has tenant_id, forced RLS with WITH CHECK and composite (tenant_id, …) foreign keys.
-- No new permissions (plant.manage, site.diary, stores.manage, projects.manage, finance.view and
-- finance.manage already exist), so the permission CHECK constraints are unchanged.
BEGIN;

-- CreateTable
CREATE TABLE "plant_settings" (
    "tenant_id" UUID NOT NULL,
    "fuel_variance_percent" INTEGER NOT NULL DEFAULT 15,
    "fuel_min_hours" INTEGER NOT NULL DEFAULT 10,
    "fuel_min_km" INTEGER NOT NULL DEFAULT 100,
    "idle_hire_days" INTEGER NOT NULL DEFAULT 3,
    "hire_ending_days" INTEGER NOT NULL DEFAULT 7,
    "service_due_soon_percent" INTEGER NOT NULL DEFAULT 10,
    "certificate_categories" VARCHAR(20)[],
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plant_settings_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "plant_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "category" VARCHAR(20) NOT NULL,
    "ownership" VARCHAR(6) NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "make_model" VARCHAR(120),
    "registration" VARCHAR(30),
    "supplier_id" UUID,
    "lpo_id" UUID,
    "hire_rate_minor" BIGINT,
    "hire_rate_unit" VARCHAR(5),
    "hire_start_on" DATE,
    "hire_end_on" DATE,
    "meter_type" VARCHAR(5) NOT NULL,
    "fuel_type" VARCHAR(6) NOT NULL,
    "standard_consumption" DECIMAL(5,2),
    "opening_on" DATE NOT NULL,
    "opening_reading" DECIMAL(8,1),
    "service_every" DECIMAL(6,1),
    "service_every_days" INTEGER,
    "status" VARCHAR(12) NOT NULL DEFAULT 'available',
    "status_reason" VARCHAR(500),
    "closed_on" DATE,
    "project_id" UUID,
    "site_id" UUID,
    "notes" VARCHAR(1000),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plant_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plant_moves" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plant_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "moved_on" DATE NOT NULL,
    "from_project_id" UUID,
    "from_site_id" UUID,
    "to_project_id" UUID,
    "to_site_id" UUID,
    "reason" VARCHAR(500),
    "moved_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plant_moves_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plant_operators" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "kind" VARCHAR(8) NOT NULL,
    "labourer_id" UUID,
    "user_id" UUID,
    "from_on" DATE NOT NULL,
    "to_on" DATE,
    "certificate_ref" VARCHAR(60),
    "certificate_expires_on" DATE,
    "assigned_by" UUID NOT NULL,
    "assigned_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_by" UUID,
    "ended_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "plant_operators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plant_meter_resets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plant_id" UUID NOT NULL,
    "reset_at" TIMESTAMPTZ NOT NULL,
    "old_reading" DECIMAL(8,1) NOT NULL,
    "new_reading" DECIMAL(8,1) NOT NULL,
    "reason" VARCHAR(16) NOT NULL,
    "note" VARCHAR(500) NOT NULL,
    "recorded_by" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plant_meter_resets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plant_usage_logs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "used_on" DATE NOT NULL,
    "day_status" VARCHAR(10) NOT NULL,
    "start_reading" DECIMAL(8,1),
    "end_reading" DECIMAL(8,1),
    "operator_labourer_id" UUID,
    "operator_user_id" UUID,
    "bq_version_id" UUID,
    "bq_item_lineage_id" UUID,
    "cost_code_id" UUID,
    "notes" VARCHAR(500),
    "corrects_id" UUID,
    "correction_reason" VARCHAR(500),
    "is_void" BOOLEAN NOT NULL DEFAULT false,
    "idempotency_key" VARCHAR(100) NOT NULL,
    "request_digest" CHAR(64) NOT NULL,
    "captured_at" TIMESTAMPTZ NOT NULL,
    "recorded_by" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plant_usage_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plant_fuel_issues" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "issued_at" TIMESTAMPTZ NOT NULL,
    "litres" DECIMAL(5,1) NOT NULL,
    "meter_reading" DECIMAL(8,1),
    "tank_filled" BOOLEAN NOT NULL,
    "fuel_type" VARCHAR(6) NOT NULL,
    "standard_consumption" DECIMAL(5,2),
    "source" VARCHAR(12) NOT NULL,
    "reference" VARCHAR(60),
    "received_by_labourer_id" UUID,
    "received_by_user_id" UUID,
    "notes" VARCHAR(500),
    "corrects_id" UUID,
    "correction_reason" VARCHAR(500),
    "is_void" BOOLEAN NOT NULL DEFAULT false,
    "idempotency_key" VARCHAR(100) NOT NULL,
    "request_digest" CHAR(64) NOT NULL,
    "captured_at" TIMESTAMPTZ NOT NULL,
    "recorded_by" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plant_fuel_issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plant_breakdowns" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "reported_at" TIMESTAMPTZ NOT NULL,
    "severity" VARCHAR(8) NOT NULL,
    "description" VARCHAR(1000) NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'open',
    "reported_by" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_on" DATE,
    "resolution_note" VARCHAR(500),
    "repaired_by" VARCHAR(120),
    "cost_reference" VARCHAR(60),
    "resolved_by" UUID,
    "resolved_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "plant_breakdowns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plant_services" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plant_id" UUID NOT NULL,
    "project_id" UUID,
    "site_id" UUID,
    "serviced_at" TIMESTAMPTZ NOT NULL,
    "kind" VARCHAR(10) NOT NULL,
    "meter_reading" DECIMAL(8,1),
    "description" VARCHAR(500) NOT NULL,
    "done_by" VARCHAR(120),
    "cost_reference" VARCHAR(60),
    "status" VARCHAR(10) NOT NULL DEFAULT 'recorded',
    "recorded_by" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voided_by" UUID,
    "voided_at" TIMESTAMPTZ,
    "void_reason" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "plant_services_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "plant_items_tenant_id_project_id_site_id_idx" ON "plant_items"("tenant_id", "project_id", "site_id");

-- CreateIndex
CREATE INDEX "plant_items_tenant_id_supplier_id_idx" ON "plant_items"("tenant_id", "supplier_id");

-- CreateIndex
CREATE INDEX "plant_items_tenant_id_lpo_id_idx" ON "plant_items"("tenant_id", "lpo_id");

-- CreateIndex
CREATE UNIQUE INDEX "plant_items_tenant_id_id_key" ON "plant_items"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "plant_items_tenant_id_code_key" ON "plant_items"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "plant_moves_tenant_id_to_project_id_to_site_id_idx" ON "plant_moves"("tenant_id", "to_project_id", "to_site_id");

-- CreateIndex
CREATE INDEX "plant_moves_tenant_id_from_project_id_from_site_id_idx" ON "plant_moves"("tenant_id", "from_project_id", "from_site_id");

-- CreateIndex
CREATE UNIQUE INDEX "plant_moves_tenant_id_id_key" ON "plant_moves"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "plant_moves_tenant_id_plant_id_seq_key" ON "plant_moves"("tenant_id", "plant_id", "seq");

-- CreateIndex
CREATE INDEX "plant_operators_tenant_id_plant_id_idx" ON "plant_operators"("tenant_id", "plant_id");

-- CreateIndex
CREATE INDEX "plant_operators_tenant_id_project_id_idx" ON "plant_operators"("tenant_id", "project_id");

-- CreateIndex
CREATE INDEX "plant_operators_tenant_id_labourer_id_idx" ON "plant_operators"("tenant_id", "labourer_id");

-- CreateIndex
CREATE UNIQUE INDEX "plant_operators_tenant_id_id_key" ON "plant_operators"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "plant_meter_resets_tenant_id_plant_id_reset_at_idx" ON "plant_meter_resets"("tenant_id", "plant_id", "reset_at");

-- CreateIndex
CREATE UNIQUE INDEX "plant_meter_resets_tenant_id_id_key" ON "plant_meter_resets"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "plant_usage_logs_tenant_id_plant_id_used_on_idx" ON "plant_usage_logs"("tenant_id", "plant_id", "used_on");

-- CreateIndex
CREATE INDEX "plant_usage_logs_tenant_id_project_id_used_on_idx" ON "plant_usage_logs"("tenant_id", "project_id", "used_on");

-- CreateIndex
CREATE UNIQUE INDEX "plant_usage_logs_tenant_id_id_key" ON "plant_usage_logs"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "plant_usage_logs_tenant_id_idempotency_key_key" ON "plant_usage_logs"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "plant_usage_logs_tenant_id_corrects_id_key" ON "plant_usage_logs"("tenant_id", "corrects_id");

-- CreateIndex
CREATE INDEX "plant_fuel_issues_tenant_id_plant_id_issued_at_idx" ON "plant_fuel_issues"("tenant_id", "plant_id", "issued_at");

-- CreateIndex
CREATE INDEX "plant_fuel_issues_tenant_id_project_id_issued_at_idx" ON "plant_fuel_issues"("tenant_id", "project_id", "issued_at");

-- CreateIndex
CREATE UNIQUE INDEX "plant_fuel_issues_tenant_id_id_key" ON "plant_fuel_issues"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "plant_fuel_issues_tenant_id_idempotency_key_key" ON "plant_fuel_issues"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "plant_fuel_issues_tenant_id_corrects_id_key" ON "plant_fuel_issues"("tenant_id", "corrects_id");

-- CreateIndex
CREATE INDEX "plant_breakdowns_tenant_id_plant_id_status_idx" ON "plant_breakdowns"("tenant_id", "plant_id", "status");

-- CreateIndex
CREATE INDEX "plant_breakdowns_tenant_id_project_id_status_idx" ON "plant_breakdowns"("tenant_id", "project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "plant_breakdowns_tenant_id_id_key" ON "plant_breakdowns"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "plant_breakdowns_tenant_id_number_key" ON "plant_breakdowns"("tenant_id", "number");

-- CreateIndex
CREATE INDEX "plant_services_tenant_id_plant_id_serviced_at_idx" ON "plant_services"("tenant_id", "plant_id", "serviced_at");

-- CreateIndex
CREATE UNIQUE INDEX "plant_services_tenant_id_id_key" ON "plant_services"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "plant_settings" ADD CONSTRAINT "plant_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant_items" ADD CONSTRAINT "plant_items_tenant_id_supplier_id_fkey" FOREIGN KEY ("tenant_id", "supplier_id") REFERENCES "suppliers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant_items" ADD CONSTRAINT "plant_items_tenant_id_lpo_id_fkey" FOREIGN KEY ("tenant_id", "lpo_id") REFERENCES "lpos"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant_items" ADD CONSTRAINT "plant_items_tenant_id_project_id_site_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "site_id") REFERENCES "sites"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant_moves" ADD CONSTRAINT "plant_moves_tenant_id_plant_id_fkey" FOREIGN KEY ("tenant_id", "plant_id") REFERENCES "plant_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant_moves" ADD CONSTRAINT "plant_moves_tenant_id_from_project_id_from_site_id_fkey" FOREIGN KEY ("tenant_id", "from_project_id", "from_site_id") REFERENCES "sites"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant_moves" ADD CONSTRAINT "plant_moves_tenant_id_to_project_id_to_site_id_fkey" FOREIGN KEY ("tenant_id", "to_project_id", "to_site_id") REFERENCES "sites"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant_operators" ADD CONSTRAINT "plant_operators_tenant_id_plant_id_fkey" FOREIGN KEY ("tenant_id", "plant_id") REFERENCES "plant_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant_operators" ADD CONSTRAINT "plant_operators_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant_operators" ADD CONSTRAINT "plant_operators_tenant_id_labourer_id_fkey" FOREIGN KEY ("tenant_id", "labourer_id") REFERENCES "labourers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant_meter_resets" ADD CONSTRAINT "plant_meter_resets_tenant_id_plant_id_fkey" FOREIGN KEY ("tenant_id", "plant_id") REFERENCES "plant_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant_usage_logs" ADD CONSTRAINT "plant_usage_logs_tenant_id_plant_id_fkey" FOREIGN KEY ("tenant_id", "plant_id") REFERENCES "plant_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant_usage_logs" ADD CONSTRAINT "plant_usage_logs_tenant_id_project_id_site_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "site_id") REFERENCES "sites"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant_usage_logs" ADD CONSTRAINT "plant_usage_logs_tenant_id_operator_labourer_id_fkey" FOREIGN KEY ("tenant_id", "operator_labourer_id") REFERENCES "labourers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant_usage_logs" ADD CONSTRAINT "plant_usage_logs_tenant_id_bq_version_id_bq_item_lineage_i_fkey" FOREIGN KEY ("tenant_id", "bq_version_id", "bq_item_lineage_id") REFERENCES "bq_items"("tenant_id", "version_id", "lineage_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant_usage_logs" ADD CONSTRAINT "plant_usage_logs_tenant_id_cost_code_id_fkey" FOREIGN KEY ("tenant_id", "cost_code_id") REFERENCES "cost_codes"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant_usage_logs" ADD CONSTRAINT "plant_usage_logs_tenant_id_corrects_id_fkey" FOREIGN KEY ("tenant_id", "corrects_id") REFERENCES "plant_usage_logs"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant_fuel_issues" ADD CONSTRAINT "plant_fuel_issues_tenant_id_plant_id_fkey" FOREIGN KEY ("tenant_id", "plant_id") REFERENCES "plant_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant_fuel_issues" ADD CONSTRAINT "plant_fuel_issues_tenant_id_project_id_site_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "site_id") REFERENCES "sites"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant_fuel_issues" ADD CONSTRAINT "plant_fuel_issues_tenant_id_received_by_labourer_id_fkey" FOREIGN KEY ("tenant_id", "received_by_labourer_id") REFERENCES "labourers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant_fuel_issues" ADD CONSTRAINT "plant_fuel_issues_tenant_id_corrects_id_fkey" FOREIGN KEY ("tenant_id", "corrects_id") REFERENCES "plant_fuel_issues"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant_breakdowns" ADD CONSTRAINT "plant_breakdowns_tenant_id_plant_id_fkey" FOREIGN KEY ("tenant_id", "plant_id") REFERENCES "plant_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant_breakdowns" ADD CONSTRAINT "plant_breakdowns_tenant_id_project_id_site_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "site_id") REFERENCES "sites"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant_services" ADD CONSTRAINT "plant_services_tenant_id_plant_id_fkey" FOREIGN KEY ("tenant_id", "plant_id") REFERENCES "plant_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plant_services" ADD CONSTRAINT "plant_services_tenant_id_project_id_site_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "site_id") REFERENCES "sites"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One original usage log per item and day; corrections chain from it (unique corrects_id).
CREATE UNIQUE INDEX "plant_usage_logs_one_original_per_day" ON "plant_usage_logs"("tenant_id", "plant_id", "used_on")
  WHERE corrects_id IS NULL;

-- Shared helpers ---------------------------------------------------------------------------------
-- Closed and cancelled projects are read-only (packages/domain isProjectReadOnly). FOR SHARE waits
-- for a concurrent status change.
CREATE FUNCTION app.assert_plant_writable(target_tenant uuid, target_project uuid)
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

-- Business days are Africa/Nairobi (UTC+3, no daylight saving): a day's start reading is taken at
-- midnight and its end reading one millisecond before the next (packages/domain plantDayStart).
CREATE FUNCTION app.plant_day_start(target_day date) RETURNS timestamptz
  LANGUAGE sql STABLE AS $$
  SELECT target_day::timestamp AT TIME ZONE 'Africa/Nairobi'
$$;
CREATE FUNCTION app.plant_day_end(target_day date) RETURNS timestamptz
  LANGUAGE sql STABLE AS $$
  SELECT (target_day + 1)::timestamp AT TIME ZONE 'Africa/Nairobi' - interval '1 millisecond'
$$;
-- How far the meter ran over a usage day: end − start, or across the reset recorded during the day
-- (at most one per day): the old meter's last reading − start + end − the new meter's first
-- (packages/domain usageRun).
CREATE FUNCTION app.plant_usage_run(target_tenant uuid, target_plant uuid, target_day date,
  day_start numeric, day_end numeric) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT (r.old_reading - day_start) + (day_end - r.new_reading) FROM plant_meter_resets r
      WHERE r.tenant_id = target_tenant AND r.plant_id = target_plant
        AND r.reset_at > app.plant_day_start(target_day)
        AND r.reset_at <= app.plant_day_end(target_day)
      ORDER BY r.reset_at LIMIT 1),
    day_end - day_start)
$$;
CREATE FUNCTION app.plant_business_date(moment timestamptz) RETURNS date
  LANGUAGE sql STABLE AS $$
  SELECT (moment AT TIME ZONE 'Africa/Nairobi')::date
$$;

-- Whether the item was at the site on the day: its last move before the day took it there, or a
-- move on the day took it there or away from there.
CREATE FUNCTION app.plant_present(target_tenant uuid, target_plant uuid, target_site uuid,
  target_day date) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE((
      SELECT m.to_site_id = target_site FROM plant_moves m
       WHERE m.tenant_id = target_tenant AND m.plant_id = target_plant AND m.moved_on < target_day
       ORDER BY m.seq DESC LIMIT 1
    ), false)
    OR EXISTS (
      SELECT 1 FROM plant_moves m
       WHERE m.tenant_id = target_tenant AND m.plant_id = target_plant AND m.moved_on = target_day
         AND (m.to_site_id = target_site OR m.from_site_id = target_site)
    )
$$;

-- Every current meter reading of an item (packages/domain meter.ts): the opening reading, each
-- current usage log's start and end, each current fuelling and recorded service, and each reset's
-- old reading (closing its epoch) and new reading (opening the next). `excluded` leaves out the
-- record a correction replaces. Superseded and void rows never count.
CREATE FUNCTION app.plant_meter_readings(target_tenant uuid, target_plant uuid, excluded uuid)
  RETURNS TABLE (read_at timestamptz, reading numeric) LANGUAGE sql STABLE AS $$
  SELECT app.plant_day_start(p.opening_on), p.opening_reading FROM plant_items p
   WHERE p.tenant_id = target_tenant AND p.id = target_plant AND p.opening_reading IS NOT NULL
  UNION ALL
  SELECT r.moment, r.value FROM plant_usage_logs u
   CROSS JOIN LATERAL (VALUES (app.plant_day_start(u.used_on), u.start_reading),
     (app.plant_day_end(u.used_on), u.end_reading)) AS r (moment, value)
   WHERE u.tenant_id = target_tenant AND u.plant_id = target_plant AND NOT u.is_void
     AND u.start_reading IS NOT NULL AND u.id IS DISTINCT FROM excluded
     AND NOT EXISTS (SELECT 1 FROM plant_usage_logs c
                      WHERE c.tenant_id = u.tenant_id AND c.corrects_id = u.id)
  UNION ALL
  SELECT f.issued_at, f.meter_reading FROM plant_fuel_issues f
   WHERE f.tenant_id = target_tenant AND f.plant_id = target_plant AND NOT f.is_void
     AND f.meter_reading IS NOT NULL AND f.id IS DISTINCT FROM excluded
     AND NOT EXISTS (SELECT 1 FROM plant_fuel_issues c
                      WHERE c.tenant_id = f.tenant_id AND c.corrects_id = f.id)
  UNION ALL
  SELECT s.serviced_at, s.meter_reading FROM plant_services s
   WHERE s.tenant_id = target_tenant AND s.plant_id = target_plant AND s.status = 'recorded'
     AND s.meter_reading IS NOT NULL
  UNION ALL
  SELECT m.reset_at - interval '1 millisecond', m.old_reading FROM plant_meter_resets m
   WHERE m.tenant_id = target_tenant AND m.plant_id = target_plant
  UNION ALL
  SELECT m.reset_at, m.new_reading FROM plant_meter_resets m
   WHERE m.tenant_id = target_tenant AND m.plant_id = target_plant
$$;

-- A reading at `moment` must be at least every reading at or before it and at most every reading
-- after it, within the same meter epoch (between resets). Decision D-92.
CREATE FUNCTION app.check_plant_reading(target_tenant uuid, target_plant uuid, moment timestamptz,
  value numeric, excluded uuid) RETURNS void LANGUAGE plpgsql STABLE AS $$
DECLARE
  epoch_start timestamptz;
  epoch_end timestamptz;
  previous numeric;
  following numeric;
BEGIN
  SELECT max(reset_at) INTO epoch_start FROM plant_meter_resets
    WHERE tenant_id = target_tenant AND plant_id = target_plant AND reset_at <= moment;
  SELECT min(reset_at) INTO epoch_end FROM plant_meter_resets
    WHERE tenant_id = target_tenant AND plant_id = target_plant AND reset_at > moment;
  SELECT max(r.reading) INTO previous FROM app.plant_meter_readings(target_tenant, target_plant,
    excluded) r WHERE r.read_at <= moment AND (epoch_start IS NULL OR r.read_at >= epoch_start);
  SELECT min(r.reading) INTO following FROM app.plant_meter_readings(target_tenant, target_plant,
    excluded) r WHERE r.read_at > moment AND (epoch_end IS NULL OR r.read_at < epoch_end);
  IF value < previous OR value > following THEN
    RAISE EXCEPTION 'A meter reading cannot be lower than an earlier one or higher than a later one; record a meter reset'
      USING ERRCODE = '23514';
  END IF;
END
$$;

-- The item's status must match its site, its open major/unsafe breakdowns and its closure, and its
-- site must be its last move's destination (packages/domain expectedPlantStatus).
CREATE FUNCTION app.check_plant_state(target_tenant uuid, target_plant uuid)
  RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  item plant_items%ROWTYPE;
  destination uuid;
  blocking boolean;
  expected text;
BEGIN
  SELECT * INTO item FROM plant_items WHERE tenant_id = target_tenant AND id = target_plant;
  IF item.id IS NULL THEN
    RETURN;
  END IF;
  SELECT to_site_id INTO destination FROM plant_moves
    WHERE tenant_id = target_tenant AND plant_id = target_plant ORDER BY seq DESC LIMIT 1;
  IF destination IS DISTINCT FROM item.site_id THEN
    RAISE EXCEPTION 'A plant item is where its last move took it' USING ERRCODE = '23514';
  END IF;
  blocking := EXISTS (SELECT 1 FROM plant_breakdowns
    WHERE tenant_id = target_tenant AND plant_id = target_plant AND status = 'open'
      AND severity IN ('major', 'unsafe'));
  expected := CASE
    WHEN item.status IN ('off_hire', 'disposed') THEN item.status
    WHEN blocking THEN 'under_repair'
    WHEN item.site_id IS NOT NULL THEN 'on_site'
    ELSE 'available' END;
  IF item.status <> expected THEN
    RAISE EXCEPTION 'A plant item''s status follows its site, breakdowns and closure'
      USING ERRCODE = '23514';
  END IF;
  IF item.status IN ('off_hire', 'disposed') AND EXISTS (SELECT 1 FROM plant_breakdowns
      WHERE tenant_id = target_tenant AND plant_id = target_plant AND status = 'open') THEN
    RAISE EXCEPTION 'Plant is closed only once its breakdowns are resolved' USING ERRCODE = '23514';
  END IF;
END
$$;

-- Category keys (packages/types PLANT_CATEGORIES), without repeats.
CREATE FUNCTION app.valid_plant_categories(categories varchar[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE AS $$
  SELECT categories <@ ARRAY['concrete_mixer', 'vibrator', 'excavator', 'loader', 'roller',
      'compactor', 'generator', 'pump', 'crane_hoist', 'scaffolding', 'formwork', 'vehicle',
      'other']::varchar[]
    AND cardinality(categories) = (SELECT count(DISTINCT c) FROM unnest(categories) c)
$$;

-- Settings ---------------------------------------------------------------------------------------
-- packages/types PLANT_SETTINGS_LIMITS.
ALTER TABLE "plant_settings" ADD CONSTRAINT "plant_settings_check" CHECK (
  fuel_variance_percent BETWEEN 1 AND 100
  AND fuel_min_hours BETWEEN 1 AND 200
  AND fuel_min_km BETWEEN 10 AND 5000
  AND idle_hire_days BETWEEN 1 AND 60
  AND hire_ending_days BETWEEN 1 AND 60
  AND service_due_soon_percent BETWEEN 0 AND 50
  AND app.valid_plant_categories(certificate_categories)
  AND version >= 1
);
CREATE FUNCTION app.guard_plant_settings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Plant settings cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF NEW.updated_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'Settings are changed by the signed-in user' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION 'Settings start at version 1' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.tenant_id <> OLD.tenant_id OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'The company is fixed and the version must advance' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER plant_settings_guard BEFORE INSERT OR UPDATE OR DELETE ON "plant_settings"
  FOR EACH ROW EXECUTE FUNCTION app.guard_plant_settings();

-- Register ---------------------------------------------------------------------------------------
-- packages/types PLANT_CATEGORIES, PLANT_OWNERSHIPS, HIRE_RATE_UNITS, METER_TYPES, FUEL_TYPES,
-- PLANT_STATUSES, PLANT_LIMITS; packages/validation hireIssues/meterIssues.
ALTER TABLE "plant_items" ADD CONSTRAINT "plant_items_check" CHECK (
  code ~ '^[A-Z0-9][A-Z0-9-]{1,19}$'
  AND char_length(name) BETWEEN 2 AND 120 AND name = btrim(name)
  AND category IN ('concrete_mixer', 'vibrator', 'excavator', 'loader', 'roller', 'compactor',
    'generator', 'pump', 'crane_hoist', 'scaffolding', 'formwork', 'vehicle', 'other')
  AND ownership IN ('owned', 'hired')
  AND quantity BETWEEN 1 AND 100000
  AND (make_model IS NULL OR char_length(btrim(make_model)) BETWEEN 1 AND 120)
  AND (registration IS NULL OR char_length(btrim(registration)) BETWEEN 1 AND 30)
  AND meter_type IN ('hours', 'km', 'none')
  AND fuel_type IN ('diesel', 'petrol', 'none')
  AND (ownership = 'hired') = (supplier_id IS NOT NULL)
  AND (ownership = 'hired') = (hire_rate_minor IS NOT NULL)
  AND (ownership = 'hired') = (hire_rate_unit IS NOT NULL)
  AND (ownership = 'hired') = (hire_start_on IS NOT NULL)
  AND (ownership = 'hired' OR (hire_end_on IS NULL AND lpo_id IS NULL))
  AND (hire_rate_minor IS NULL OR hire_rate_minor BETWEEN 1 AND 1000000000)
  AND (hire_rate_unit IS NULL OR hire_rate_unit IN ('day', 'hour', 'month'))
  AND (hire_rate_unit IS DISTINCT FROM 'hour' OR meter_type = 'hours')
  AND (hire_end_on IS NULL OR hire_end_on >= hire_start_on)
  AND (standard_consumption IS NOT NULL) = (meter_type <> 'none' AND fuel_type <> 'none')
  AND (standard_consumption IS NULL OR standard_consumption > 0)
  AND (opening_reading IS NOT NULL) = (meter_type <> 'none')
  AND (opening_reading IS NULL OR opening_reading >= 0)
  AND (service_every IS NULL OR (meter_type <> 'none' AND service_every > 0))
  AND (service_every_days IS NULL OR service_every_days BETWEEN 1 AND 3650)
  AND status IN ('available', 'on_site', 'under_repair', 'off_hire', 'disposed')
  AND (project_id IS NULL) = (site_id IS NULL)
  AND (status <> 'on_site' OR site_id IS NOT NULL)
  AND (status NOT IN ('available', 'off_hire', 'disposed') OR site_id IS NULL)
  AND (status <> 'off_hire' OR ownership = 'hired')
  AND (status <> 'disposed' OR ownership = 'owned')
  AND (status IN ('off_hire', 'disposed')) = (closed_on IS NOT NULL)
  AND (status IN ('off_hire', 'disposed')) = (status_reason IS NOT NULL)
  AND (status_reason IS NULL OR char_length(btrim(status_reason)) BETWEEN 3 AND 500)
  AND (closed_on IS NULL OR closed_on >= opening_on)
  AND (notes IS NULL OR char_length(btrim(notes)) BETWEEN 1 AND 1000)
  AND version >= 1
);
CREATE FUNCTION app.guard_plant_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  last_move plant_moves%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Plant items cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF NEW.updated_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'Plant items are changed by the signed-in user' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 OR NEW.created_by IS DISTINCT FROM app.current_user_id()
      OR NEW.status <> 'available' OR NEW.site_id IS NOT NULL THEN
      RAISE EXCEPTION 'A plant item is registered in the yard by the signed-in user'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.opening_on > app.business_today() THEN
      RAISE EXCEPTION 'The opening date cannot be in the future' USING ERRCODE = '23514';
    END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  IF OLD.status IN ('off_hire', 'disposed') THEN
    RAISE EXCEPTION 'Off-hired and disposed plant is final' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.id, NEW.tenant_id, NEW.code, NEW.ownership, NEW.meter_type, NEW.fuel_type,
      NEW.opening_on, NEW.opening_reading, NEW.created_by, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.code, OLD.ownership, OLD.meter_type,
      OLD.fuel_type, OLD.opening_on, OLD.opening_reading, OLD.created_by, OLD.created_at)
    OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'The code, ownership, meter, fuel type and opening reading are fixed'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.site_id IS DISTINCT FROM OLD.site_id OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    SELECT * INTO last_move FROM plant_moves
      WHERE tenant_id = NEW.tenant_id AND plant_id = NEW.id ORDER BY seq DESC LIMIT 1;
    IF last_move.id IS NULL OR last_move.to_site_id IS DISTINCT FROM NEW.site_id
      OR last_move.from_site_id IS DISTINCT FROM OLD.site_id THEN
      RAISE EXCEPTION 'A plant item changes site only by a recorded move' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.status IN ('off_hire', 'disposed') THEN
    IF NEW.closed_on > app.business_today()
      OR (NEW.hire_start_on IS NOT NULL AND NEW.closed_on < NEW.hire_start_on) THEN
      RAISE EXCEPTION 'Plant is closed on a date within its hire, not in the future'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER plant_item_guard BEFORE INSERT OR UPDATE OR DELETE ON "plant_items"
  FOR EACH ROW EXECUTE FUNCTION app.guard_plant_item();
CREATE FUNCTION app.check_plant_item_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM app.check_plant_state(NEW.tenant_id, NEW.id);
  RETURN NULL;
END
$$;
CREATE FUNCTION app.check_plant_child_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM app.check_plant_state(NEW.tenant_id, NEW.plant_id);
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER plant_item_state AFTER INSERT OR UPDATE ON "plant_items"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_plant_item_state();

-- Moves ------------------------------------------------------------------------------------------
ALTER TABLE "plant_moves" ADD CONSTRAINT "plant_moves_check" CHECK (
  seq >= 1
  AND (from_project_id IS NULL) = (from_site_id IS NULL)
  AND (to_project_id IS NULL) = (to_site_id IS NULL)
  AND to_site_id IS DISTINCT FROM from_site_id
  AND (reason IS NULL OR char_length(btrim(reason)) BETWEEN 1 AND 500)
);
CREATE FUNCTION app.guard_plant_move() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item plant_items%ROWTYPE;
  latest plant_moves%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Plant moves are append-only' USING ERRCODE = '42501';
  END IF;
  IF NEW.moved_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A move is recorded by the signed-in user' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO item FROM plant_items WHERE tenant_id = NEW.tenant_id AND id = NEW.plant_id
    FOR UPDATE;
  IF item.status IN ('off_hire', 'disposed') THEN
    RAISE EXCEPTION 'Off-hired and disposed plant does not move' USING ERRCODE = '23514';
  END IF;
  IF NEW.from_site_id IS DISTINCT FROM item.site_id
    OR NEW.from_project_id IS DISTINCT FROM item.project_id THEN
    RAISE EXCEPTION 'A move starts where the item is' USING ERRCODE = '23514';
  END IF;
  IF NEW.to_project_id IS NOT NULL THEN
    PERFORM app.assert_plant_writable(NEW.tenant_id, NEW.to_project_id);
  END IF;
  SELECT * INTO latest FROM plant_moves
    WHERE tenant_id = NEW.tenant_id AND plant_id = NEW.plant_id ORDER BY seq DESC LIMIT 1;
  IF NEW.seq <> COALESCE(latest.seq, 0) + 1 THEN
    RAISE EXCEPTION 'Moves are numbered in order' USING ERRCODE = '23514';
  END IF;
  IF NEW.moved_on > app.business_today() OR NEW.moved_on < item.opening_on
    OR NEW.moved_on < latest.moved_on THEN
    RAISE EXCEPTION 'A move is dated after the previous one and not in the future'
      USING ERRCODE = '23514';
  END IF;
  -- Leaving a site must not strand usage or fuel still in force there after the move (void and
  -- superseded rows do not count: voiding them is how a late move is made possible).
  IF NEW.from_site_id IS NOT NULL AND (
    EXISTS (SELECT 1 FROM plant_usage_logs u
      WHERE u.tenant_id = NEW.tenant_id AND u.plant_id = NEW.plant_id
        AND u.site_id = NEW.from_site_id AND u.used_on > NEW.moved_on AND NOT u.is_void
        AND NOT EXISTS (SELECT 1 FROM plant_usage_logs c
                         WHERE c.tenant_id = u.tenant_id AND c.corrects_id = u.id))
    OR EXISTS (SELECT 1 FROM plant_fuel_issues f
      WHERE f.tenant_id = NEW.tenant_id AND f.plant_id = NEW.plant_id
        AND f.site_id = NEW.from_site_id AND app.plant_business_date(f.issued_at) > NEW.moved_on
        AND NOT f.is_void
        AND NOT EXISTS (SELECT 1 FROM plant_fuel_issues c
                         WHERE c.tenant_id = f.tenant_id AND c.corrects_id = f.id))
  ) THEN
    RAISE EXCEPTION 'Usage or fuel is recorded at this site after the move date'
      USING ERRCODE = '23514';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END
$$;
CREATE TRIGGER plant_move_guard BEFORE INSERT OR UPDATE OR DELETE ON "plant_moves"
  FOR EACH ROW EXECUTE FUNCTION app.guard_plant_move();
CREATE CONSTRAINT TRIGGER plant_move_state AFTER INSERT ON "plant_moves"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_plant_child_state();

-- Operators --------------------------------------------------------------------------------------
-- packages/types OPERATOR_KINDS; certificates are a flag, never a block (CR-PLT-01).
ALTER TABLE "plant_operators" ADD CONSTRAINT "plant_operators_check" CHECK (
  kind IN ('labourer', 'staff')
  AND (kind = 'labourer') = (labourer_id IS NOT NULL)
  AND (kind = 'staff') = (user_id IS NOT NULL)
  AND (to_on IS NULL OR to_on >= from_on)
  AND (certificate_ref IS NULL OR char_length(btrim(certificate_ref)) BETWEEN 1 AND 60)
  AND (certificate_expires_on IS NULL OR certificate_ref IS NOT NULL)
  AND (ended_by IS NULL) = (ended_at IS NULL)
  AND (ended_by IS NULL OR to_on IS NOT NULL)
  AND version >= 1
);
CREATE FUNCTION app.guard_plant_operator() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item plant_items%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Operator assignments cannot be deleted; end them' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO item FROM plant_items WHERE tenant_id = NEW.tenant_id AND id = NEW.plant_id
    FOR UPDATE;
  IF TG_OP = 'INSERT' THEN
    PERFORM app.assert_plant_writable(NEW.tenant_id, NEW.project_id);
    IF NEW.assigned_by IS DISTINCT FROM app.current_user_id() OR NEW.version <> 1
      OR NEW.ended_by IS NOT NULL THEN
      RAISE EXCEPTION 'An operator is assigned by the signed-in user' USING ERRCODE = '23514';
    END IF;
    IF item.status IN ('off_hire', 'disposed') THEN
      RAISE EXCEPTION 'Off-hired and disposed plant takes no operators' USING ERRCODE = '23514';
    END IF;
    IF NEW.labourer_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM labour_engagements
        WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id
          AND labourer_id = NEW.labourer_id) THEN
      RAISE EXCEPTION 'The operator is not engaged on this project' USING ERRCODE = '23514';
    END IF;
    IF NEW.user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM memberships
        WHERE tenant_id = NEW.tenant_id AND user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'The operator is not a member of the company' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM plant_operators o
        WHERE o.tenant_id = NEW.tenant_id AND o.plant_id = NEW.plant_id
          AND o.labourer_id IS NOT DISTINCT FROM NEW.labourer_id
          AND o.user_id IS NOT DISTINCT FROM NEW.user_id
          AND daterange(o.from_on, o.to_on, '[]') && daterange(NEW.from_on, NEW.to_on, '[]')) THEN
      RAISE EXCEPTION 'This operator is already assigned to the item for that period'
        USING ERRCODE = '23514';
    END IF;
    NEW.assigned_at := now();
    RETURN NEW;
  END IF;
  -- Only ending, once (also on a closed project): the end date moves earlier, not before the start.
  IF OLD.ended_by IS NOT NULL THEN
    RAISE EXCEPTION 'An ended operator assignment is final' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.id, NEW.tenant_id, NEW.plant_id, NEW.project_id, NEW.kind, NEW.labourer_id,
      NEW.user_id, NEW.from_on, NEW.certificate_ref, NEW.certificate_expires_on, NEW.assigned_by,
      NEW.assigned_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.plant_id, OLD.project_id, OLD.kind,
      OLD.labourer_id, OLD.user_id, OLD.from_on, OLD.certificate_ref, OLD.certificate_expires_on,
      OLD.assigned_by, OLD.assigned_at)
    OR NEW.version <> OLD.version + 1 OR NEW.to_on IS NULL
    OR (OLD.to_on IS NOT NULL AND NEW.to_on > OLD.to_on)
    OR NEW.ended_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'An operator assignment can only be ended' USING ERRCODE = '23514';
  END IF;
  NEW.ended_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER plant_operator_guard BEFORE INSERT OR UPDATE OR DELETE ON "plant_operators"
  FOR EACH ROW EXECUTE FUNCTION app.guard_plant_operator();

-- Meter resets -----------------------------------------------------------------------------------
-- packages/types METER_RESET_REASONS; decision D-92.
ALTER TABLE "plant_meter_resets" ADD CONSTRAINT "plant_meter_resets_check" CHECK (
  old_reading >= 0 AND new_reading >= 0
  AND reason IN ('meter_replaced', 'meter_reset', 'rollover', 'other')
  AND char_length(btrim(note)) BETWEEN 3 AND 500
);
CREATE FUNCTION app.guard_plant_meter_reset() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item plant_items%ROWTYPE;
  latest timestamptz;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Meter resets are append-only' USING ERRCODE = '42501';
  END IF;
  IF NEW.recorded_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A meter reset is recorded by the signed-in user' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO item FROM plant_items WHERE tenant_id = NEW.tenant_id AND id = NEW.plant_id
    FOR UPDATE;
  IF item.meter_type = 'none' OR item.status IN ('off_hire', 'disposed') THEN
    RAISE EXCEPTION 'Only a metered item in service has its meter reset' USING ERRCODE = '23514';
  END IF;
  IF NEW.reset_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'A meter reset cannot be in the future' USING ERRCODE = '23514';
  END IF;
  -- One reset per item and business day: a usage day spans at most one (app.plant_usage_run).
  IF EXISTS (SELECT 1 FROM plant_meter_resets r
      WHERE r.tenant_id = NEW.tenant_id AND r.plant_id = NEW.plant_id
        AND app.plant_business_date(r.reset_at) = app.plant_business_date(NEW.reset_at)) THEN
    RAISE EXCEPTION 'An item''s meter is reset at most once a day' USING ERRCODE = '23514';
  END IF;
  SELECT max(read_at) INTO latest FROM app.plant_meter_readings(NEW.tenant_id, NEW.plant_id, NULL);
  IF latest IS NOT NULL AND NEW.reset_at <= latest THEN
    RAISE EXCEPTION 'A meter reset comes after every reading already recorded'
      USING ERRCODE = '23514';
  END IF;
  PERFORM app.check_plant_reading(NEW.tenant_id, NEW.plant_id,
    NEW.reset_at - interval '1 millisecond', NEW.old_reading, NULL);
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END
$$;
CREATE TRIGGER plant_meter_reset_guard BEFORE INSERT OR UPDATE OR DELETE ON "plant_meter_resets"
  FOR EACH ROW EXECUTE FUNCTION app.guard_plant_meter_reset();

-- Usage ------------------------------------------------------------------------------------------
-- packages/types USAGE_DAY_STATUSES, PLANT_LIMITS (24.0 hours or 1,500.0 km in a day); decisions
-- D-91 (append-only corrections) and D-92 (monotonic meter).
ALTER TABLE "plant_usage_logs" ADD CONSTRAINT "plant_usage_logs_check" CHECK (
  day_status IN ('working', 'idle', 'breakdown')
  AND (start_reading IS NULL) = (end_reading IS NULL)
  AND (start_reading IS NULL OR (start_reading >= 0 AND end_reading >= 0))
  AND (operator_labourer_id IS NULL OR operator_user_id IS NULL)
  AND (bq_version_id IS NULL) = (bq_item_lineage_id IS NULL)
  AND (bq_item_lineage_id IS NULL OR cost_code_id IS NULL)
  AND (notes IS NULL OR char_length(btrim(notes)) BETWEEN 1 AND 500)
  AND (corrects_id IS NULL) = (correction_reason IS NULL)
  AND (correction_reason IS NULL OR char_length(btrim(correction_reason)) BETWEEN 3 AND 500)
  AND (NOT is_void OR corrects_id IS NOT NULL)
  AND corrects_id IS DISTINCT FROM id
  AND idempotency_key ~ '^[A-Za-z0-9._:-]{8,100}$'
  AND request_digest ~ '^[0-9a-f]{64}$'
);
CREATE FUNCTION app.guard_plant_usage_log() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item plant_items%ROWTYPE;
  corrected plant_usage_logs%ROWTYPE;
  day_limit numeric;
  day_run numeric;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Usage logs are append-only; record a correction' USING ERRCODE = '42501';
  END IF;
  IF NEW.recorded_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'Usage is recorded by the signed-in user' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO item FROM plant_items WHERE tenant_id = NEW.tenant_id AND id = NEW.plant_id
    FOR UPDATE;
  PERFORM app.assert_plant_writable(NEW.tenant_id, NEW.project_id);
  IF NEW.used_on > app.business_today() OR NEW.used_on < item.opening_on THEN
    RAISE EXCEPTION 'A usage day is neither in the future nor before the item was registered'
      USING ERRCODE = '23514';
  END IF;
  IF (item.meter_type = 'none') <> (NEW.start_reading IS NULL) THEN
    RAISE EXCEPTION 'Readings are recorded exactly when the item has a meter'
      USING ERRCODE = '23514';
  END IF;
  day_limit := CASE item.meter_type WHEN 'hours' THEN 24.0 ELSE 1500.0 END;
  day_run := app.plant_usage_run(NEW.tenant_id, NEW.plant_id, NEW.used_on, NEW.start_reading,
    NEW.end_reading);
  IF day_run < 0 THEN
    RAISE EXCEPTION 'The end reading is below the start (no meter reset that day)'
      USING ERRCODE = '23514';
  END IF;
  IF day_run > day_limit THEN
    RAISE EXCEPTION 'One day''s usage cannot exceed 24 hours or 1,500 km' USING ERRCODE = '23514';
  END IF;
  IF NOT app.plant_present(NEW.tenant_id, NEW.plant_id, NEW.site_id, NEW.used_on) THEN
    RAISE EXCEPTION 'The item was not at this site on that day' USING ERRCODE = '23514';
  END IF;
  IF NEW.corrects_id IS NOT NULL THEN
    SELECT * INTO corrected FROM plant_usage_logs
      WHERE tenant_id = NEW.tenant_id AND id = NEW.corrects_id;
    IF corrected.plant_id IS DISTINCT FROM NEW.plant_id OR corrected.used_on <> NEW.used_on THEN
      RAISE EXCEPTION 'A correction is for the same item and day' USING ERRCODE = '23514';
    END IF;
    IF NEW.is_void AND corrected.is_void THEN
      RAISE EXCEPTION 'This usage log is already void' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NOT NEW.is_void THEN
    IF NEW.start_reading IS NOT NULL THEN
      PERFORM app.check_plant_reading(NEW.tenant_id, NEW.plant_id,
        app.plant_day_start(NEW.used_on), NEW.start_reading, NEW.corrects_id);
      PERFORM app.check_plant_reading(NEW.tenant_id, NEW.plant_id,
        app.plant_day_end(NEW.used_on), NEW.end_reading, NEW.corrects_id);
    END IF;
    IF NEW.day_status = 'working' AND EXISTS (SELECT 1 FROM plant_breakdowns b
        WHERE b.tenant_id = NEW.tenant_id AND b.plant_id = NEW.plant_id AND b.status = 'open'
          AND b.severity = 'unsafe' AND app.plant_business_date(b.reported_at) <= NEW.used_on) THEN
      RAISE EXCEPTION 'Plant with an open unsafe breakdown cannot be logged as working'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.operator_labourer_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM plant_operators o
        WHERE o.tenant_id = NEW.tenant_id AND o.plant_id = NEW.plant_id
          AND o.labourer_id = NEW.operator_labourer_id
          AND NEW.used_on <@ daterange(o.from_on, o.to_on, '[]'))
      OR NEW.operator_user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM plant_operators o
        WHERE o.tenant_id = NEW.tenant_id AND o.plant_id = NEW.plant_id
          AND o.user_id = NEW.operator_user_id
          AND NEW.used_on <@ daterange(o.from_on, o.to_on, '[]')) THEN
      RAISE EXCEPTION 'The operator was not assigned to the item on that day'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.bq_version_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM bq_versions v
        WHERE v.tenant_id = NEW.tenant_id AND v.id = NEW.bq_version_id
          AND v.project_id = NEW.project_id) THEN
      RAISE EXCEPTION 'The BQ item belongs to another project' USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END
$$;
CREATE TRIGGER plant_usage_log_guard BEFORE INSERT OR UPDATE OR DELETE ON "plant_usage_logs"
  FOR EACH ROW EXECUTE FUNCTION app.guard_plant_usage_log();

-- Fuel -------------------------------------------------------------------------------------------
-- packages/types FUEL_SOURCES, PLANT_LIMITS (0.1–2,000.0 litres); decisions D-91, D-92, D-93.
ALTER TABLE "plant_fuel_issues" ADD CONSTRAINT "plant_fuel_issues_check" CHECK (
  litres BETWEEN 0.1 AND 2000.0
  AND (meter_reading IS NULL OR meter_reading >= 0)
  AND fuel_type IN ('diesel', 'petrol')
  AND (standard_consumption IS NULL OR standard_consumption > 0)
  AND source IN ('site_store', 'fuel_station', 'bowser', 'other')
  AND (reference IS NULL OR char_length(btrim(reference)) BETWEEN 1 AND 60)
  AND (received_by_labourer_id IS NULL OR received_by_user_id IS NULL)
  AND (notes IS NULL OR char_length(btrim(notes)) BETWEEN 1 AND 500)
  AND (corrects_id IS NULL) = (correction_reason IS NULL)
  AND (correction_reason IS NULL OR char_length(btrim(correction_reason)) BETWEEN 3 AND 500)
  AND (NOT is_void OR corrects_id IS NOT NULL)
  AND corrects_id IS DISTINCT FROM id
  AND idempotency_key ~ '^[A-Za-z0-9._:-]{8,100}$'
  AND request_digest ~ '^[0-9a-f]{64}$'
);
CREATE FUNCTION app.guard_plant_fuel_issue() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item plant_items%ROWTYPE;
  corrected plant_fuel_issues%ROWTYPE;
  issued_on date;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Fuel issues are append-only; record a correction' USING ERRCODE = '42501';
  END IF;
  IF NEW.recorded_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'Fuel is recorded by the signed-in user' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO item FROM plant_items WHERE tenant_id = NEW.tenant_id AND id = NEW.plant_id
    FOR UPDATE;
  PERFORM app.assert_plant_writable(NEW.tenant_id, NEW.project_id);
  IF item.fuel_type = 'none' OR NEW.fuel_type <> item.fuel_type THEN
    RAISE EXCEPTION 'Fuel is issued only to plant that uses it, of its type'
      USING ERRCODE = '23514';
  END IF;
  -- A new issue carries the standard in force; a correction or void keeps the standard the issue
  -- was recorded under, so a closed window is never re-judged by a later standard (D-94).
  IF NEW.corrects_id IS NULL AND NEW.standard_consumption IS DISTINCT FROM item.standard_consumption THEN
    RAISE EXCEPTION 'A fuel issue carries the standard consumption in force'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.corrects_id IS NOT NULL AND NEW.standard_consumption IS DISTINCT FROM (
       SELECT standard_consumption FROM plant_fuel_issues
        WHERE tenant_id = NEW.tenant_id AND id = NEW.corrects_id) THEN
    RAISE EXCEPTION 'A correction keeps the standard consumption of the issue it corrects'
      USING ERRCODE = '23514';
  END IF;
  IF (item.meter_type = 'none') <> (NEW.meter_reading IS NULL) THEN
    RAISE EXCEPTION 'The meter is read at fuelling exactly when the item has one'
      USING ERRCODE = '23514';
  END IF;
  issued_on := app.plant_business_date(NEW.issued_at);
  IF NEW.issued_at > now() + interval '5 minutes' OR issued_on < item.opening_on THEN
    RAISE EXCEPTION 'Fuel is neither issued in the future nor before the item was registered'
      USING ERRCODE = '23514';
  END IF;
  IF NOT app.plant_present(NEW.tenant_id, NEW.plant_id, NEW.site_id, issued_on) THEN
    RAISE EXCEPTION 'The item was not at this site on that day' USING ERRCODE = '23514';
  END IF;
  IF NEW.corrects_id IS NOT NULL THEN
    SELECT * INTO corrected FROM plant_fuel_issues
      WHERE tenant_id = NEW.tenant_id AND id = NEW.corrects_id;
    IF corrected.plant_id IS DISTINCT FROM NEW.plant_id THEN
      RAISE EXCEPTION 'A correction is for the same item' USING ERRCODE = '23514';
    END IF;
    IF NEW.is_void AND corrected.is_void THEN
      RAISE EXCEPTION 'This fuel issue is already void' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NOT NEW.is_void THEN
    IF NEW.meter_reading IS NOT NULL THEN
      PERFORM app.check_plant_reading(NEW.tenant_id, NEW.plant_id, NEW.issued_at,
        NEW.meter_reading, NEW.corrects_id);
    END IF;
    IF NEW.received_by_labourer_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM labour_engagements
        WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id
          AND labourer_id = NEW.received_by_labourer_id) THEN
      RAISE EXCEPTION 'The receiver is not engaged on this project' USING ERRCODE = '23514';
    END IF;
    IF NEW.received_by_user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM memberships
        WHERE tenant_id = NEW.tenant_id AND user_id = NEW.received_by_user_id) THEN
      RAISE EXCEPTION 'The receiver is not a member of the company' USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END
$$;
CREATE TRIGGER plant_fuel_issue_guard BEFORE INSERT OR UPDATE OR DELETE ON "plant_fuel_issues"
  FOR EACH ROW EXECUTE FUNCTION app.guard_plant_fuel_issue();

-- Breakdowns -------------------------------------------------------------------------------------
-- packages/types BREAKDOWN_SEVERITIES, BREAKDOWN_STATUSES; packages/domain
-- breakdownResolutionAllowed. Major and unsafe breakdowns put the item under repair
-- (app.check_plant_state at commit).
ALTER TABLE "plant_breakdowns" ADD CONSTRAINT "plant_breakdowns_check" CHECK (
  number >= 1 AND version >= 1
  AND severity IN ('minor', 'major', 'unsafe')
  AND char_length(btrim(description)) BETWEEN 5 AND 1000
  AND status IN ('open', 'repaired', 'off_hire', 'written_off')
  AND (status = 'open') = (resolved_on IS NULL)
  AND (status = 'open') = (resolved_by IS NULL)
  AND (status = 'open') = (resolved_at IS NULL)
  AND (status IN ('open', 'repaired') OR resolution_note IS NOT NULL)
  AND (resolution_note IS NULL OR char_length(btrim(resolution_note)) BETWEEN 1 AND 500)
  AND (repaired_by IS NULL OR char_length(btrim(repaired_by)) BETWEEN 1 AND 120)
  AND (cost_reference IS NULL OR char_length(btrim(cost_reference)) BETWEEN 1 AND 60)
);
CREATE FUNCTION app.guard_plant_breakdown() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item plant_items%ROWTYPE;
  latest integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Breakdowns cannot be deleted' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO item FROM plant_items WHERE tenant_id = NEW.tenant_id AND id = NEW.plant_id
    FOR UPDATE;
  IF TG_OP = 'INSERT' THEN
    IF NEW.reported_by IS DISTINCT FROM app.current_user_id() OR NEW.status <> 'open'
      OR NEW.version <> 1 THEN
      RAISE EXCEPTION 'A breakdown is reported open by the signed-in user'
        USING ERRCODE = '23514';
    END IF;
    IF item.status IN ('off_hire', 'disposed') THEN
      RAISE EXCEPTION 'Off-hired and disposed plant cannot break down' USING ERRCODE = '23514';
    END IF;
    PERFORM app.assert_plant_writable(NEW.tenant_id, NEW.project_id);
    IF NEW.reported_at > now() + interval '5 minutes'
      OR NOT app.plant_present(NEW.tenant_id, NEW.plant_id, NEW.site_id,
        app.plant_business_date(NEW.reported_at)) THEN
      RAISE EXCEPTION 'A breakdown is reported where the item was, not in the future'
        USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM tenants WHERE tenant_id = NEW.tenant_id FOR UPDATE;
    SELECT max(number) INTO latest FROM plant_breakdowns WHERE tenant_id = NEW.tenant_id;
    IF NEW.number <> COALESCE(latest, 0) + 1 THEN
      RAISE EXCEPTION 'Breakdowns are numbered in order' USING ERRCODE = '23514';
    END IF;
    NEW.recorded_at := now();
    RETURN NEW;
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'A resolved breakdown is final' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.id, NEW.tenant_id, NEW.plant_id, NEW.project_id, NEW.site_id, NEW.number,
      NEW.reported_at, NEW.severity, NEW.description, NEW.reported_by, NEW.recorded_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.plant_id, OLD.project_id, OLD.site_id,
      OLD.number, OLD.reported_at, OLD.severity, OLD.description, OLD.reported_by,
      OLD.recorded_at)
    OR NEW.version <> OLD.version + 1 OR NEW.status = 'open'
    OR NEW.resolved_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A breakdown can only be resolved, by the signed-in user'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.resolved_on < app.plant_business_date(NEW.reported_at)
    OR NEW.resolved_on > app.business_today() THEN
    RAISE EXCEPTION 'A breakdown is resolved after it was reported, not in the future'
      USING ERRCODE = '23514';
  END IF;
  IF (NEW.status = 'off_hire' AND item.ownership <> 'hired')
    OR (NEW.status = 'written_off' AND item.ownership <> 'owned') THEN
    RAISE EXCEPTION 'Hired plant goes off hire; owned plant is written off'
      USING ERRCODE = '23514';
  END IF;
  NEW.resolved_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER plant_breakdown_guard BEFORE INSERT OR UPDATE OR DELETE ON "plant_breakdowns"
  FOR EACH ROW EXECUTE FUNCTION app.guard_plant_breakdown();
CREATE CONSTRAINT TRIGGER plant_breakdown_state AFTER INSERT OR UPDATE ON "plant_breakdowns"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_plant_child_state();

-- Services ---------------------------------------------------------------------------------------
-- packages/types SERVICE_KINDS, SERVICE_RECORD_STATUSES; packages/domain serviceStatus.
ALTER TABLE "plant_services" ADD CONSTRAINT "plant_services_check" CHECK (
  kind IN ('service', 'repair', 'inspection')
  AND (meter_reading IS NULL OR meter_reading >= 0)
  AND char_length(btrim(description)) BETWEEN 3 AND 500
  AND (done_by IS NULL OR char_length(btrim(done_by)) BETWEEN 1 AND 120)
  AND (cost_reference IS NULL OR char_length(btrim(cost_reference)) BETWEEN 1 AND 60)
  AND (project_id IS NULL) = (site_id IS NULL)
  AND status IN ('recorded', 'voided')
  AND (status = 'voided') = (voided_by IS NOT NULL)
  AND (status = 'voided') = (voided_at IS NOT NULL)
  AND (status = 'voided') = (void_reason IS NOT NULL)
  AND (void_reason IS NULL OR char_length(btrim(void_reason)) BETWEEN 3 AND 500)
  AND version >= 1
);
CREATE FUNCTION app.guard_plant_service() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item plant_items%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Service records cannot be deleted' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO item FROM plant_items WHERE tenant_id = NEW.tenant_id AND id = NEW.plant_id
    FOR UPDATE;
  IF TG_OP = 'INSERT' THEN
    IF NEW.recorded_by IS DISTINCT FROM app.current_user_id() OR NEW.status <> 'recorded'
      OR NEW.version <> 1 THEN
      RAISE EXCEPTION 'A service is recorded by the signed-in user' USING ERRCODE = '23514';
    END IF;
    IF item.status IN ('off_hire', 'disposed') THEN
      RAISE EXCEPTION 'Off-hired and disposed plant is not serviced' USING ERRCODE = '23514';
    END IF;
    IF NEW.site_id IS DISTINCT FROM item.site_id THEN
      RAISE EXCEPTION 'A service is recorded where the item is' USING ERRCODE = '23514';
    END IF;
    IF NEW.project_id IS NOT NULL THEN
      PERFORM app.assert_plant_writable(NEW.tenant_id, NEW.project_id);
    END IF;
    IF (item.meter_type = 'none') <> (NEW.meter_reading IS NULL) THEN
      RAISE EXCEPTION 'The meter is read at a service exactly when the item has one'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.serviced_at > now() + interval '5 minutes'
      OR app.plant_business_date(NEW.serviced_at) < item.opening_on THEN
      RAISE EXCEPTION 'A service is neither in the future nor before the item was registered'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.meter_reading IS NOT NULL THEN
      PERFORM app.check_plant_reading(NEW.tenant_id, NEW.plant_id, NEW.serviced_at,
        NEW.meter_reading, NULL);
    END IF;
    NEW.recorded_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF OLD.status <> 'recorded' THEN
    RAISE EXCEPTION 'A voided service record is final' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.id, NEW.tenant_id, NEW.plant_id, NEW.project_id, NEW.site_id, NEW.serviced_at,
      NEW.kind, NEW.meter_reading, NEW.description, NEW.done_by, NEW.cost_reference,
      NEW.recorded_by, NEW.recorded_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.plant_id, OLD.project_id, OLD.site_id,
      OLD.serviced_at, OLD.kind, OLD.meter_reading, OLD.description, OLD.done_by,
      OLD.cost_reference, OLD.recorded_by, OLD.recorded_at)
    OR NEW.version <> OLD.version + 1 OR NEW.status <> 'voided'
    OR NEW.voided_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A service record is fixed; it can only be voided' USING ERRCODE = '23514';
  END IF;
  NEW.voided_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER plant_service_guard BEFORE INSERT OR UPDATE OR DELETE ON "plant_services"
  FOR EACH ROW EXECUTE FUNCTION app.guard_plant_service();

-- Row-level security -----------------------------------------------------------------------------
DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['plant_settings', 'plant_items', 'plant_moves', 'plant_operators',
    'plant_meter_resets', 'plant_usage_logs', 'plant_fuel_issues', 'plant_breakdowns',
    'plant_services']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = app.current_tenant_id()) '
      'WITH CHECK (tenant_id = app.current_tenant_id())', target || '_isolation', target);
  END LOOP;
END
$$;

-- The runtime role never deletes plant records and never rewrites moves, meter resets, usage logs
-- or fuel issues (append-only ledgers: corrections are new rows).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmb_app') THEN
    REVOKE UPDATE ON "plant_moves", "plant_meter_resets", "plant_usage_logs", "plant_fuel_issues"
      FROM pmb_app;
    REVOKE DELETE ON "plant_settings", "plant_items", "plant_moves", "plant_operators",
      "plant_meter_resets", "plant_usage_logs", "plant_fuel_issues", "plant_breakdowns",
      "plant_services" FROM pmb_app;
    REVOKE TRUNCATE, REFERENCES, TRIGGER
      ON "plant_settings", "plant_items", "plant_moves", "plant_operators", "plant_meter_resets",
         "plant_usage_logs", "plant_fuel_issues", "plant_breakdowns", "plant_services"
      FROM pmb_app;
    GRANT EXECUTE ON FUNCTION app.assert_plant_writable(uuid, uuid) TO pmb_app;
    GRANT EXECUTE ON FUNCTION app.plant_day_start(date) TO pmb_app;
    GRANT EXECUTE ON FUNCTION app.plant_day_end(date) TO pmb_app;
    GRANT EXECUTE ON FUNCTION app.plant_business_date(timestamptz) TO pmb_app;
    GRANT EXECUTE ON FUNCTION app.plant_present(uuid, uuid, uuid, date) TO pmb_app;
    GRANT EXECUTE ON FUNCTION app.plant_meter_readings(uuid, uuid, uuid) TO pmb_app;
    GRANT EXECUTE ON FUNCTION app.check_plant_reading(uuid, uuid, timestamptz, numeric, uuid)
      TO pmb_app;
    GRANT EXECUTE ON FUNCTION app.check_plant_state(uuid, uuid) TO pmb_app;
    GRANT EXECUTE ON FUNCTION app.valid_plant_categories(varchar[]) TO pmb_app;
  END IF;
END
$$;
REVOKE EXECUTE ON FUNCTION app.assert_plant_writable(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.plant_day_start(date) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.plant_day_end(date) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.plant_usage_run(uuid, uuid, date, numeric, numeric) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.plant_business_date(timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.plant_present(uuid, uuid, uuid, date) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.plant_meter_readings(uuid, uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_plant_reading(uuid, uuid, timestamptz, numeric, uuid)
  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_plant_state(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.valid_plant_categories(varchar[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_plant_settings() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_plant_item() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_plant_item_state() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_plant_child_state() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_plant_move() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_plant_operator() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_plant_meter_reset() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_plant_usage_log() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_plant_fuel_issue() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_plant_breakdown() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_plant_service() FROM PUBLIC;

COMMIT;
