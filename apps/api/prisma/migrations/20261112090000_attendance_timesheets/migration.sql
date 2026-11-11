-- D3.3 Attendance and timesheets, web-only slice (ARCHITECTURE §4.4, ERD §6; brief §5.5, §15).
-- * attendance_settings: the company's weekly period cut-off (Q-C4: Thursday 18:00, Friday pay).
-- * timesheet_rule_versions: effective-dated rules (company default or project override), never
--   updated; a version cannot take effect inside a submitted or approved period.
-- * public_holidays: the company's holiday calendar (seeded from the Public Holidays Act and the
--   2026 Gazette notices); locked once a period covering the date is submitted or approved.
-- * timesheet_periods: open → submitted → approved (locked) or rejected → open; submitter ≠
--   approver (CHECK); approval writes the immutable timesheet_lines snapshot payroll reads.
-- * attendance_days (muster sheets per site and date: draft → submitted → confirmed by someone who
--   neither submitted nor recorded it) and attendance_records (one per labourer, site and date;
--   pluggable capture method with reserved evidence columns; the labourer must be engaged).
-- * attendance_corrections (after submission, decided by someone other than the requester),
--   attendance_anomalies (review signals, one open per record and kind) and timesheet_adjustments
--   (after approval: land in a later period, never touch the approved one).
-- * idempotency_records and outbox_events: idempotent commands and the transactional outbox.
-- * The catalogue gains attendance.confirm and timesheets.submit/approve/manage_rules.
-- Every new table has tenant_id, forced RLS with WITH CHECK, composite (tenant_id, …) foreign keys
-- and no TRUNCATE/REFERENCES/TRIGGER for pmb_app; history and snapshots lose UPDATE/DELETE.
BEGIN;

-- CreateTable
CREATE TABLE "attendance_settings" (
    "tenant_id" UUID NOT NULL,
    "frequency" VARCHAR(20) NOT NULL DEFAULT 'weekly',
    "week_ends_on" SMALLINT NOT NULL DEFAULT 4,
    "cutoff_minutes" SMALLINT NOT NULL DEFAULT 1080,
    "payday_weekday" SMALLINT NOT NULL DEFAULT 5,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_settings_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "timesheet_rule_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID,
    "scope_key" VARCHAR(40) NOT NULL DEFAULT '',
    "effective_from" DATE NOT NULL,
    "normal_minutes" SMALLINT NOT NULL,
    "default_break_minutes" SMALLINT NOT NULL,
    "break_after_minutes" SMALLINT NOT NULL,
    "day_start_minutes" SMALLINT NOT NULL,
    "late_grace_minutes" SMALLINT NOT NULL,
    "half_day_threshold_minutes" SMALLINT NOT NULL,
    "max_plausible_minutes" SMALLINT NOT NULL,
    "rest_days" SMALLINT[],
    "ot_weekday_multiplier" DECIMAL(4,2) NOT NULL,
    "ot_rest_day_multiplier" DECIMAL(4,2) NOT NULL,
    "ot_holiday_multiplier" DECIMAL(4,2) NOT NULL,
    "compliance_status" VARCHAR(20) NOT NULL DEFAULT 'unverified',
    "source_reference" VARCHAR(300) NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "timesheet_rule_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public_holidays" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "holiday_date" DATE NOT NULL,
    "name_en" VARCHAR(120) NOT NULL,
    "name_sw" VARCHAR(120) NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "source" VARCHAR(400) NOT NULL,
    "compliance_status" VARCHAR(20) NOT NULL DEFAULT 'unverified',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "public_holidays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timesheet_periods" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "cutoff_at" TIMESTAMPTZ NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'open',
    "version" INTEGER NOT NULL DEFAULT 1,
    "submitted_by" UUID,
    "submitted_at" TIMESTAMPTZ,
    "submitted_digest" CHAR(64),
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ,
    "rejected_by" UUID,
    "rejected_at" TIMESTAMPTZ,
    "rejection_reason" VARCHAR(500),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "timesheet_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_days" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "work_date" DATE NOT NULL,
    "period_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 1,
    "submitted_by" UUID,
    "submitted_at" TIMESTAMPTZ,
    "confirmed_by" UUID,
    "confirmed_at" TIMESTAMPTZ,
    "returned_by" UUID,
    "returned_at" TIMESTAMPTZ,
    "return_reason" VARCHAR(500),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_records" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "day_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "work_date" DATE NOT NULL,
    "labourer_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "check_in_minutes" SMALLINT,
    "check_out_minutes" SMALLINT,
    "overnight" BOOLEAN NOT NULL DEFAULT false,
    "break_minutes" SMALLINT,
    "notes" VARCHAR(500),
    "capture_method" VARCHAR(20) NOT NULL DEFAULT 'web_manual',
    "device_id" UUID,
    "device_time" TIMESTAMPTZ,
    "server_received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "accuracy_m" DECIMAL(7,1),
    "geofence_result" VARCHAR(10),
    "geofence_version" INTEGER,
    "match_confidence" DECIMAL(5,4),
    "photo_file_id" UUID,
    "client_event_id" UUID,
    "corrected" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_corrections" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "day_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "work_date" DATE NOT NULL,
    "record_id" UUID,
    "labourer_id" UUID NOT NULL,
    "proposed" JSONB NOT NULL,
    "previous" JSONB,
    "reason" VARCHAR(500) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "version" INTEGER NOT NULL DEFAULT 1,
    "requested_by" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ,
    "decision_note" VARCHAR(500),

    CONSTRAINT "attendance_corrections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_anomalies" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "record_id" UUID NOT NULL,
    "labourer_id" UUID NOT NULL,
    "work_date" DATE NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "severity" VARCHAR(10) NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "status" VARCHAR(20) NOT NULL DEFAULT 'open',
    "open_marker" VARCHAR(4) DEFAULT 'open',
    "correction_id" UUID,
    "detected_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ,
    "review_note" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "attendance_anomalies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timesheet_lines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "period_id" UUID NOT NULL,
    "labourer_id" UUID NOT NULL,
    "line_key" VARCHAR(60) NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "adjustment_id" UUID,
    "original_period_id" UUID,
    "half_days" INTEGER NOT NULL,
    "worked_minutes" INTEGER NOT NULL,
    "normal_minutes" INTEGER NOT NULL,
    "ot_weekday_minutes" INTEGER NOT NULL,
    "ot_rest_day_minutes" INTEGER NOT NULL,
    "ot_holiday_minutes" INTEGER NOT NULL,
    "late_minutes" INTEGER NOT NULL,
    "present_count" INTEGER NOT NULL,
    "half_day_count" INTEGER NOT NULL,
    "absent_count" INTEGER NOT NULL,
    "leave_count" INTEGER NOT NULL,
    "sick_count" INTEGER NOT NULL,
    "rule_version_ids" UUID[],
    "record_ids" UUID[],
    "days" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "timesheet_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timesheet_adjustments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "original_period_id" UUID NOT NULL,
    "target_period_id" UUID,
    "labourer_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "work_date" DATE NOT NULL,
    "record_id" UUID,
    "proposed" JSONB NOT NULL,
    "previous" JSONB,
    "reason" VARCHAR(500) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "version" INTEGER NOT NULL DEFAULT 1,
    "delta" JSONB,
    "rule_version_id" UUID,
    "requested_by" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ,
    "decision_note" VARCHAR(500),

    CONSTRAINT "timesheet_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "tenant_id" UUID NOT NULL,
    "operation" VARCHAR(80) NOT NULL,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "user_id" UUID NOT NULL,
    "fingerprint" CHAR(64) NOT NULL,
    "response" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("tenant_id","operation","idempotency_key")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "topic" VARCHAR(80) NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "timesheet_rule_versions_tenant_id_id_key" ON "timesheet_rule_versions"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "timesheet_rule_versions_tenant_id_scope_key_effective_from_key" ON "timesheet_rule_versions"("tenant_id", "scope_key", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "public_holidays_tenant_id_id_key" ON "public_holidays"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "public_holidays_tenant_id_holiday_date_key" ON "public_holidays"("tenant_id", "holiday_date");

-- CreateIndex
CREATE INDEX "timesheet_periods_tenant_id_project_id_status_idx" ON "timesheet_periods"("tenant_id", "project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "timesheet_periods_tenant_id_id_key" ON "timesheet_periods"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "timesheet_periods_tenant_id_project_id_id_key" ON "timesheet_periods"("tenant_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "timesheet_periods_tenant_id_project_id_start_date_key" ON "timesheet_periods"("tenant_id", "project_id", "start_date");

-- CreateIndex
CREATE INDEX "attendance_days_tenant_id_period_id_idx" ON "attendance_days"("tenant_id", "period_id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_days_tenant_id_id_key" ON "attendance_days"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_days_tenant_id_id_site_id_work_date_key" ON "attendance_days"("tenant_id", "id", "site_id", "work_date");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_days_tenant_id_site_id_work_date_key" ON "attendance_days"("tenant_id", "site_id", "work_date");

-- CreateIndex
CREATE INDEX "attendance_records_tenant_id_labourer_id_work_date_idx" ON "attendance_records"("tenant_id", "labourer_id", "work_date");

-- CreateIndex
CREATE INDEX "attendance_records_tenant_id_project_id_work_date_idx" ON "attendance_records"("tenant_id", "project_id", "work_date");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_records_tenant_id_id_key" ON "attendance_records"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_records_tenant_id_site_id_labourer_id_work_date_key" ON "attendance_records"("tenant_id", "site_id", "labourer_id", "work_date");

-- CreateIndex
CREATE INDEX "attendance_corrections_tenant_id_day_id_idx" ON "attendance_corrections"("tenant_id", "day_id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_corrections_tenant_id_id_key" ON "attendance_corrections"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "attendance_anomalies_tenant_id_project_id_status_idx" ON "attendance_anomalies"("tenant_id", "project_id", "status");

-- CreateIndex
CREATE INDEX "attendance_anomalies_tenant_id_labourer_id_work_date_idx" ON "attendance_anomalies"("tenant_id", "labourer_id", "work_date");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_anomalies_tenant_id_id_key" ON "attendance_anomalies"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_anomalies_tenant_id_record_id_kind_open_marker_key" ON "attendance_anomalies"("tenant_id", "record_id", "kind", "open_marker");

-- CreateIndex
CREATE INDEX "timesheet_lines_tenant_id_labourer_id_idx" ON "timesheet_lines"("tenant_id", "labourer_id");

-- CreateIndex
CREATE UNIQUE INDEX "timesheet_lines_tenant_id_id_key" ON "timesheet_lines"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "timesheet_lines_tenant_id_period_id_labourer_id_line_key_key" ON "timesheet_lines"("tenant_id", "period_id", "labourer_id", "line_key");

-- CreateIndex
CREATE INDEX "timesheet_adjustments_tenant_id_project_id_status_idx" ON "timesheet_adjustments"("tenant_id", "project_id", "status");

-- CreateIndex
CREATE INDEX "timesheet_adjustments_tenant_id_labourer_id_work_date_idx" ON "timesheet_adjustments"("tenant_id", "labourer_id", "work_date");

-- CreateIndex
CREATE UNIQUE INDEX "timesheet_adjustments_tenant_id_id_key" ON "timesheet_adjustments"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_created_at_idx" ON "outbox_events"("published_at", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_tenant_id_id_key" ON "outbox_events"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "attendance_settings" ADD CONSTRAINT "attendance_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timesheet_rule_versions" ADD CONSTRAINT "timesheet_rule_versions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timesheet_rule_versions" ADD CONSTRAINT "timesheet_rule_versions_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public_holidays" ADD CONSTRAINT "public_holidays_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timesheet_periods" ADD CONSTRAINT "timesheet_periods_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_days" ADD CONSTRAINT "attendance_days_tenant_id_project_id_site_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "site_id") REFERENCES "sites"("tenant_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_days" ADD CONSTRAINT "attendance_days_tenant_id_project_id_period_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "period_id") REFERENCES "timesheet_periods"("tenant_id", "project_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_tenant_id_day_id_site_id_work_date_fkey" FOREIGN KEY ("tenant_id", "day_id", "site_id", "work_date") REFERENCES "attendance_days"("tenant_id", "id", "site_id", "work_date") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_tenant_id_project_id_site_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "site_id") REFERENCES "sites"("tenant_id", "project_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_tenant_id_labourer_id_fkey" FOREIGN KEY ("tenant_id", "labourer_id") REFERENCES "labourers"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_tenant_id_day_id_site_id_work_date_fkey" FOREIGN KEY ("tenant_id", "day_id", "site_id", "work_date") REFERENCES "attendance_days"("tenant_id", "id", "site_id", "work_date") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_tenant_id_record_id_fkey" FOREIGN KEY ("tenant_id", "record_id") REFERENCES "attendance_records"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_tenant_id_labourer_id_fkey" FOREIGN KEY ("tenant_id", "labourer_id") REFERENCES "labourers"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_anomalies" ADD CONSTRAINT "attendance_anomalies_tenant_id_record_id_fkey" FOREIGN KEY ("tenant_id", "record_id") REFERENCES "attendance_records"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_anomalies" ADD CONSTRAINT "attendance_anomalies_tenant_id_correction_id_fkey" FOREIGN KEY ("tenant_id", "correction_id") REFERENCES "attendance_corrections"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_anomalies" ADD CONSTRAINT "attendance_anomalies_tenant_id_project_id_site_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "site_id") REFERENCES "sites"("tenant_id", "project_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_anomalies" ADD CONSTRAINT "attendance_anomalies_tenant_id_labourer_id_fkey" FOREIGN KEY ("tenant_id", "labourer_id") REFERENCES "labourers"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timesheet_lines" ADD CONSTRAINT "timesheet_lines_tenant_id_project_id_period_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "period_id") REFERENCES "timesheet_periods"("tenant_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timesheet_lines" ADD CONSTRAINT "timesheet_lines_tenant_id_project_id_original_period_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "original_period_id") REFERENCES "timesheet_periods"("tenant_id", "project_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timesheet_lines" ADD CONSTRAINT "timesheet_lines_tenant_id_labourer_id_fkey" FOREIGN KEY ("tenant_id", "labourer_id") REFERENCES "labourers"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timesheet_lines" ADD CONSTRAINT "timesheet_lines_tenant_id_adjustment_id_fkey" FOREIGN KEY ("tenant_id", "adjustment_id") REFERENCES "timesheet_adjustments"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timesheet_adjustments" ADD CONSTRAINT "timesheet_adjustments_tenant_id_project_id_original_period_fkey" FOREIGN KEY ("tenant_id", "project_id", "original_period_id") REFERENCES "timesheet_periods"("tenant_id", "project_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timesheet_adjustments" ADD CONSTRAINT "timesheet_adjustments_tenant_id_project_id_target_period_i_fkey" FOREIGN KEY ("tenant_id", "project_id", "target_period_id") REFERENCES "timesheet_periods"("tenant_id", "project_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timesheet_adjustments" ADD CONSTRAINT "timesheet_adjustments_tenant_id_project_id_site_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "site_id") REFERENCES "sites"("tenant_id", "project_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timesheet_adjustments" ADD CONSTRAINT "timesheet_adjustments_tenant_id_labourer_id_fkey" FOREIGN KEY ("tenant_id", "labourer_id") REFERENCES "labourers"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timesheet_adjustments" ADD CONSTRAINT "timesheet_adjustments_tenant_id_record_id_fkey" FOREIGN KEY ("tenant_id", "record_id") REFERENCES "attendance_records"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Helpers ----------------------------------------------------------------------------------------
-- The business date in Africa/Nairobi (ARCHITECTURE §9) from the database clock.
CREATE FUNCTION app.nairobi_today() RETURNS date LANGUAGE sql STABLE AS $$
  SELECT (now() AT TIME ZONE 'Africa/Nairobi')::date
$$;
CREATE FUNCTION app.has_distinct_elements(values_in smallint[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE AS $$
  SELECT cardinality(values_in) = (SELECT count(DISTINCT value) FROM unnest(values_in) AS value)
$$;

-- Settings, rules and holidays --------------------------------------------------------------------
-- packages/types PERIOD_FREQUENCIES and DEFAULT_PERIOD_SETTINGS (QUESTIONS Q-C4).
ALTER TABLE "attendance_settings" ADD CONSTRAINT "attendance_settings_check" CHECK (
  frequency = 'weekly' AND week_ends_on BETWEEN 1 AND 7 AND payday_weekday BETWEEN 1 AND 7
  AND cutoff_minutes BETWEEN 0 AND 1439 AND version >= 1
);

-- packages/types TIMESHEET_RULE_LIMITS; packages/domain ruleIssues (COMPLIANCE-REVIEW: CR-PAY-08).
ALTER TABLE "timesheet_rule_versions" ADD CONSTRAINT "timesheet_rule_versions_values_check" CHECK (
  normal_minutes BETWEEN 60 AND 720
  AND default_break_minutes BETWEEN 0 AND 180
  AND break_after_minutes BETWEEN 0 AND 720
  AND day_start_minutes BETWEEN 0 AND 1439
  AND late_grace_minutes BETWEEN 0 AND 240
  AND half_day_threshold_minutes BETWEEN 30 AND 720
  AND max_plausible_minutes BETWEEN 240 AND 1440
  AND half_day_threshold_minutes <= normal_minutes
  AND max_plausible_minutes >= normal_minutes
  AND ot_weekday_multiplier BETWEEN 1 AND 5
  AND ot_rest_day_multiplier BETWEEN 1 AND 5
  AND ot_holiday_multiplier BETWEEN 1 AND 5
  AND rest_days <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[]
  AND cardinality(rest_days) <= 6
  AND app.has_distinct_elements(rest_days)
);
ALTER TABLE "timesheet_rule_versions" ADD CONSTRAINT "timesheet_rule_versions_meta_check" CHECK (
  compliance_status IN ('unverified', 'approved') AND char_length(btrim(source_reference)) >= 3
);

-- Rule versions are never updated. The database sets the scope and creation time. A version may
-- not take effect on a date inside a submitted or approved period of its scope (closed periods are
-- stable, INVARIANTS); only a version that has not started yet can be deleted.
CREATE FUNCTION app.guard_timesheet_rule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Timesheet rule versions are never updated' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.effective_from <= app.nairobi_today() THEN
      RAISE EXCEPTION 'A rule version in force cannot be deleted' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  NEW.scope_key := COALESCE(NEW.project_id::text, 'company');
  NEW.created_at := now();
  IF EXISTS (
    SELECT 1 FROM timesheet_periods p
    WHERE p.tenant_id = NEW.tenant_id
      AND (NEW.project_id IS NULL OR p.project_id = NEW.project_id)
      AND p.status IN ('submitted', 'approved') AND p.end_date >= NEW.effective_from
  ) THEN
    RAISE EXCEPTION 'A rule cannot take effect inside a submitted or approved period'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER timesheet_rule_guard BEFORE INSERT OR UPDATE OR DELETE ON "timesheet_rule_versions"
  FOR EACH ROW EXECUTE FUNCTION app.guard_timesheet_rule();

-- packages/types HOLIDAY_KINDS (COMPLIANCE-REVIEW: CR-PAY-14).
ALTER TABLE "public_holidays" ADD CONSTRAINT "public_holidays_check" CHECK (
  kind IN ('statutory', 'gazetted', 'observed', 'company')
  AND compliance_status IN ('unverified', 'approved')
  AND char_length(btrim(name_en)) >= 3 AND char_length(btrim(name_sw)) >= 3
  AND char_length(btrim(source)) >= 3
);

-- A holiday changes the pay category of its date, so it cannot be added or removed once any
-- period covering that date is submitted or approved; holidays are never updated.
CREATE FUNCTION app.guard_public_holiday() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  row_tenant uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
  row_date date := CASE WHEN TG_OP = 'DELETE' THEN OLD.holiday_date ELSE NEW.holiday_date END;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Public holidays are never updated' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM timesheet_periods p
    WHERE p.tenant_id = row_tenant AND p.status IN ('submitted', 'approved')
      AND row_date BETWEEN p.start_date AND p.end_date
  ) THEN
    RAISE EXCEPTION 'The date is inside a submitted or approved period' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  NEW.created_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER public_holiday_guard BEFORE INSERT OR UPDATE OR DELETE ON "public_holidays"
  FOR EACH ROW EXECUTE FUNCTION app.guard_public_holiday();

-- Periods ----------------------------------------------------------------------------------------
ALTER TABLE "timesheet_periods" ADD CONSTRAINT "timesheet_periods_dates_check" CHECK (
  end_date >= start_date AND end_date - start_date <= 30
);
ALTER TABLE "timesheet_periods" ADD CONSTRAINT "timesheet_periods_vocabulary_check" CHECK (
  status IN ('open', 'submitted', 'rejected', 'approved') AND version >= 1
  AND (submitted_digest IS NULL OR submitted_digest ~ '^[0-9a-f]{64}$')
  AND (rejection_reason IS NULL OR char_length(btrim(rejection_reason)) BETWEEN 10 AND 500)
);
-- Maker ≠ checker by identity: whoever submitted a period can neither approve nor reject it.
ALTER TABLE "timesheet_periods" ADD CONSTRAINT "timesheet_periods_maker_checker_check" CHECK (
  (approved_by IS NULL OR approved_by <> submitted_by)
  AND (rejected_by IS NULL OR submitted_by IS NULL OR rejected_by <> submitted_by)
);
ALTER TABLE "timesheet_periods" ADD CONSTRAINT "timesheet_periods_state_check" CHECK (
  (status = 'open' AND submitted_by IS NULL AND submitted_at IS NULL AND submitted_digest IS NULL
    AND approved_by IS NULL AND approved_at IS NULL)
  OR (status = 'submitted' AND submitted_by IS NOT NULL AND submitted_at IS NOT NULL
    AND submitted_digest IS NOT NULL AND approved_by IS NULL AND approved_at IS NULL)
  OR (status = 'rejected' AND submitted_by IS NOT NULL AND rejected_by IS NOT NULL
    AND rejected_at IS NOT NULL AND rejection_reason IS NOT NULL
    AND approved_by IS NULL AND approved_at IS NULL)
  OR (status = 'approved' AND submitted_by IS NOT NULL AND submitted_at IS NOT NULL
    AND submitted_digest IS NOT NULL AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
);

-- Explicit states (brief §15 C): open → submitted (after the cut-off, every day confirmed) →
-- approved (no open anomaly) or rejected → open. An approved period never changes; periods of a
-- project never overlap (the project row lock serialises creation). Timestamps come from the
-- database clock.
CREATE FUNCTION app.guard_timesheet_period() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' THEN
      RAISE EXCEPTION 'A period starts open' USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM projects WHERE tenant_id = NEW.tenant_id AND id = NEW.project_id
      FOR NO KEY UPDATE;
    IF EXISTS (
      SELECT 1 FROM timesheet_periods p
      WHERE p.tenant_id = NEW.tenant_id AND p.project_id = NEW.project_id
        AND p.start_date <= NEW.end_date AND p.end_date >= NEW.start_date
    ) THEN
      RAISE EXCEPTION 'Timesheet periods of a project cannot overlap' USING ERRCODE = '23514';
    END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  IF OLD.status = 'approved' THEN
    RAISE EXCEPTION 'An approved period is locked' USING ERRCODE = '23514';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.start_date IS DISTINCT FROM OLD.start_date OR NEW.end_date IS DISTINCT FROM OLD.end_date
     OR NEW.cutoff_at IS DISTINCT FROM OLD.cutoff_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Period identity and dates cannot change' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'A period changes only through a transition' USING ERRCODE = '23514';
  END IF;
  IF NOT (
    (OLD.status = 'open' AND NEW.status = 'submitted')
    OR (OLD.status = 'submitted' AND NEW.status IN ('approved', 'rejected'))
    OR (OLD.status = 'rejected' AND NEW.status = 'open')
  ) THEN
    RAISE EXCEPTION 'Invalid period transition' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'submitted' THEN
    IF now() < NEW.cutoff_at THEN
      RAISE EXCEPTION 'A period can be submitted only after its cut-off' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM attendance_days d
      WHERE d.tenant_id = NEW.tenant_id AND d.period_id = NEW.id AND d.status <> 'confirmed'
    ) THEN
      RAISE EXCEPTION 'Every day must be confirmed before submission' USING ERRCODE = '23514';
    END IF;
    NEW.submitted_at := now();
  ELSIF NEW.status = 'approved' THEN
    IF EXISTS (
      SELECT 1 FROM attendance_anomalies a
      JOIN attendance_records r ON r.tenant_id = a.tenant_id AND r.id = a.record_id
      JOIN attendance_days d ON d.tenant_id = r.tenant_id AND d.id = r.day_id
      WHERE d.tenant_id = NEW.tenant_id AND d.period_id = NEW.id AND a.status = 'open'
    ) THEN
      RAISE EXCEPTION 'Open anomalies must be reviewed before approval' USING ERRCODE = '23514';
    END IF;
    NEW.approved_at := now();
  ELSIF NEW.status = 'rejected' THEN
    NEW.rejected_at := now();
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER timesheet_period_guard BEFORE INSERT OR UPDATE ON "timesheet_periods"
  FOR EACH ROW EXECUTE FUNCTION app.guard_timesheet_period();

-- Muster days ------------------------------------------------------------------------------------
ALTER TABLE "attendance_days" ADD CONSTRAINT "attendance_days_vocabulary_check" CHECK (
  status IN ('draft', 'submitted', 'confirmed') AND version >= 1
  AND (return_reason IS NULL OR char_length(btrim(return_reason)) BETWEEN 10 AND 500)
  AND (returned_by IS NULL) = (returned_at IS NULL)
  AND (returned_by IS NULL) = (return_reason IS NULL)
);
-- Maker ≠ checker: the submitter never confirms (the trigger also excludes every recorder).
ALTER TABLE "attendance_days" ADD CONSTRAINT "attendance_days_maker_checker_check" CHECK (
  confirmed_by IS NULL OR confirmed_by <> submitted_by
);
ALTER TABLE "attendance_days" ADD CONSTRAINT "attendance_days_state_check" CHECK (
  (status = 'draft' AND submitted_by IS NULL AND submitted_at IS NULL
    AND confirmed_by IS NULL AND confirmed_at IS NULL)
  OR (status = 'submitted' AND submitted_by IS NOT NULL AND submitted_at IS NOT NULL
    AND confirmed_by IS NULL AND confirmed_at IS NULL)
  OR (status = 'confirmed' AND submitted_by IS NOT NULL AND submitted_at IS NOT NULL
    AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)
);

-- A day belongs to the period covering its date and can be created or changed only while that
-- period is open or rejected. draft → submitted → confirmed, or submitted → draft (returned by
-- someone other than the submitter). The confirmer cannot be the submitter or anyone who recorded
-- or last changed a record of the day. A confirmed day is final: later changes are corrections.
CREATE FUNCTION app.guard_attendance_day() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  period record;
BEGIN
  SELECT status, start_date, end_date INTO period FROM timesheet_periods
  WHERE tenant_id = NEW.tenant_id AND id = NEW.period_id;
  IF period.status IS NULL OR period.status NOT IN ('open', 'rejected') THEN
    RAISE EXCEPTION 'The timesheet period is locked' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'A muster day starts as a draft' USING ERRCODE = '23514';
    END IF;
    IF NEW.work_date NOT BETWEEN period.start_date AND period.end_date THEN
      RAISE EXCEPTION 'The day is outside its period' USING ERRCODE = '23514';
    END IF;
    IF NEW.work_date > app.nairobi_today() THEN
      RAISE EXCEPTION 'Attendance cannot be recorded for a future date' USING ERRCODE = '23514';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.site_id IS DISTINCT FROM OLD.site_id
     OR NEW.work_date IS DISTINCT FROM OLD.work_date OR NEW.period_id IS DISTINCT FROM OLD.period_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Muster day identity cannot change' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'confirmed' THEN
    RAISE EXCEPTION 'A confirmed day is final; use a correction' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status = 'draft' AND NEW.status = 'submitted' THEN
      IF NOT EXISTS (
        SELECT 1 FROM attendance_records r WHERE r.tenant_id = NEW.tenant_id AND r.day_id = NEW.id
      ) THEN
        RAISE EXCEPTION 'An empty day cannot be submitted' USING ERRCODE = '23514';
      END IF;
      NEW.submitted_at := now();
    ELSIF OLD.status = 'submitted' AND NEW.status = 'confirmed' THEN
      IF EXISTS (
        SELECT 1 FROM attendance_records r
        WHERE r.tenant_id = NEW.tenant_id AND r.day_id = NEW.id
          AND (r.created_by = NEW.confirmed_by OR r.updated_by = NEW.confirmed_by)
      ) THEN
        RAISE EXCEPTION 'Someone who recorded the day cannot confirm it' USING ERRCODE = '23514';
      END IF;
      NEW.confirmed_at := now();
    ELSIF OLD.status = 'submitted' AND NEW.status = 'draft' THEN
      IF NEW.returned_by IS NULL OR NEW.returned_by = OLD.submitted_by THEN
        RAISE EXCEPTION 'A day is returned by someone other than its submitter'
          USING ERRCODE = '23514';
      END IF;
      NEW.returned_at := now();
    ELSE
      RAISE EXCEPTION 'Invalid muster day transition' USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'A submitted day changes only through a transition' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER attendance_day_guard BEFORE INSERT OR UPDATE ON "attendance_days"
  FOR EACH ROW EXECUTE FUNCTION app.guard_attendance_day();

-- Attendance records -----------------------------------------------------------------------------
-- packages/types ATTENDANCE_STATUSES, CAPTURE_METHODS, GEOFENCE_RESULTS.
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_vocabulary_check" CHECK (
  status IN ('present', 'half_day', 'absent', 'leave', 'sick')
  AND capture_method IN ('web_manual', 'qr_card', 'face', 'fingerprint', 'terminal')
  AND (geofence_result IS NULL OR geofence_result IN ('inside', 'outside', 'unknown'))
  AND (match_confidence IS NULL OR match_confidence BETWEEN 0 AND 1)
  AND version >= 1
);
-- packages/domain entryIssues: worked days carry both times (check-out after check-in, or the next
-- morning for an overnight shift shorter than 24 hours) and a break shorter than the shift; other
-- statuses carry no times. Checked again here so no path can store an impossible shift.
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_times_check" CHECK (
  (status IN ('present', 'half_day')
    AND check_in_minutes BETWEEN 0 AND 1439 AND check_out_minutes BETWEEN 0 AND 1439
    AND ((NOT overnight AND check_out_minutes > check_in_minutes)
      OR (overnight AND check_out_minutes < check_in_minutes))
    AND (break_minutes IS NULL OR (break_minutes >= 0 AND break_minutes <
      check_out_minutes + CASE WHEN overnight THEN 1440 ELSE 0 END - check_in_minutes)))
  OR (status IN ('absent', 'leave', 'sick') AND check_in_minutes IS NULL
    AND check_out_minutes IS NULL AND NOT overnight AND break_minutes IS NULL)
);
-- A supervisor's web entry carries no device, location, match or photo evidence: those columns are
-- reserved for the site app, kiosk and terminal capture methods (D3.3 site slice, D3.4).
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_web_evidence_check" CHECK (
  capture_method <> 'web_manual' OR (
    device_id IS NULL AND device_time IS NULL AND latitude IS NULL AND longitude IS NULL
    AND accuracy_m IS NULL AND geofence_result IS NULL AND geofence_version IS NULL
    AND match_confidence IS NULL AND photo_file_id IS NULL
  )
);

-- A record is written only while its period is open or rejected and its day is a draft, or in the
-- transaction that approves a correction for it (then it is marked corrected). A new record needs
-- the labourer engaged on the project on that date and a date that is not in the future. Identity,
-- capture method and evidence never change.
CREATE FUNCTION app.guard_attendance_record() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  day record;
  period_status text;
  corrected_now boolean;
BEGIN
  SELECT status, period_id INTO day FROM attendance_days
  WHERE tenant_id = NEW.tenant_id AND id = NEW.day_id;
  SELECT status INTO period_status FROM timesheet_periods
  WHERE tenant_id = NEW.tenant_id AND id = day.period_id;
  IF period_status IS NULL OR period_status NOT IN ('open', 'rejected') THEN
    RAISE EXCEPTION 'The timesheet period is locked' USING ERRCODE = '23514';
  END IF;
  corrected_now := EXISTS (
    SELECT 1 FROM attendance_corrections c
    WHERE c.tenant_id = NEW.tenant_id AND c.day_id = NEW.day_id
      AND c.labourer_id = NEW.labourer_id AND c.status = 'approved' AND c.decided_at = now()
  );
  IF day.status <> 'draft' AND NOT corrected_now THEN
    RAISE EXCEPTION 'A submitted or confirmed day changes only through an approved correction'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.work_date > app.nairobi_today() THEN
      RAISE EXCEPTION 'Attendance cannot be recorded for a future date' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM labour_engagements e
      WHERE e.tenant_id = NEW.tenant_id AND e.labourer_id = NEW.labourer_id
        AND e.project_id = NEW.project_id AND e.start_date <= NEW.work_date
        AND (e.end_date IS NULL OR e.end_date >= NEW.work_date)
    ) THEN
      RAISE EXCEPTION 'The labourer is not engaged on the project on that date'
        USING ERRCODE = '23514';
    END IF;
    NEW.created_at := now();
    NEW.server_received_at := now();
  ELSE
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.day_id IS DISTINCT FROM OLD.day_id OR NEW.project_id IS DISTINCT FROM OLD.project_id
       OR NEW.site_id IS DISTINCT FROM OLD.site_id OR NEW.work_date IS DISTINCT FROM OLD.work_date
       OR NEW.labourer_id IS DISTINCT FROM OLD.labourer_id
       OR NEW.capture_method IS DISTINCT FROM OLD.capture_method
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.server_received_at IS DISTINCT FROM OLD.server_received_at
       OR NEW.client_event_id IS DISTINCT FROM OLD.client_event_id
       OR NEW.device_id IS DISTINCT FROM OLD.device_id
       OR NEW.device_time IS DISTINCT FROM OLD.device_time
       OR NEW.latitude IS DISTINCT FROM OLD.latitude OR NEW.longitude IS DISTINCT FROM OLD.longitude
       OR NEW.accuracy_m IS DISTINCT FROM OLD.accuracy_m
       OR NEW.geofence_result IS DISTINCT FROM OLD.geofence_result
       OR NEW.geofence_version IS DISTINCT FROM OLD.geofence_version
       OR NEW.match_confidence IS DISTINCT FROM OLD.match_confidence
       OR NEW.photo_file_id IS DISTINCT FROM OLD.photo_file_id THEN
      RAISE EXCEPTION 'Attendance identity and capture evidence cannot change'
        USING ERRCODE = '23514';
    END IF;
    IF OLD.corrected AND NOT NEW.corrected THEN
      RAISE EXCEPTION 'A correction mark cannot be removed' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF corrected_now THEN NEW.corrected := true; END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER attendance_record_guard BEFORE INSERT OR UPDATE ON "attendance_records"
  FOR EACH ROW EXECUTE FUNCTION app.guard_attendance_record();

-- Corrections ------------------------------------------------------------------------------------
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_check" CHECK (
  status IN ('pending', 'approved', 'rejected') AND version >= 1
  AND char_length(btrim(reason)) BETWEEN 10 AND 500
  AND jsonb_typeof(proposed) = 'object'
  AND (previous IS NULL OR jsonb_typeof(previous) = 'object')
  AND (decision_note IS NULL OR char_length(btrim(decision_note)) BETWEEN 3 AND 500)
);
-- Maker ≠ checker: the requester never decides their own correction.
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_maker_checker_check"
  CHECK (decided_by IS NULL OR decided_by <> requested_by);
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_state_check" CHECK (
  (status = 'pending' AND decided_by IS NULL AND decided_at IS NULL AND decision_note IS NULL)
  OR (status = 'approved' AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
  OR (status = 'rejected' AND decided_by IS NOT NULL AND decided_at IS NOT NULL
    AND decision_note IS NOT NULL)
);

-- A correction is requested for a submitted or confirmed day of an open or rejected period (one
-- pending correction per labourer and day), then decided once; nothing else ever changes.
CREATE FUNCTION app.guard_attendance_correction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  day record;
  period_status text;
BEGIN
  SELECT status, period_id, work_date, site_id INTO day FROM attendance_days
  WHERE tenant_id = NEW.tenant_id AND id = NEW.day_id;
  SELECT status INTO period_status FROM timesheet_periods
  WHERE tenant_id = NEW.tenant_id AND id = day.period_id;
  IF period_status IS NULL OR period_status NOT IN ('open', 'rejected') THEN
    RAISE EXCEPTION 'The timesheet period is locked' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'A correction starts pending' USING ERRCODE = '23514';
    END IF;
    IF day.status NOT IN ('submitted', 'confirmed') THEN
      RAISE EXCEPTION 'Draft days are edited directly' USING ERRCODE = '23514';
    END IF;
    IF NEW.record_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM attendance_records r
      WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.record_id AND r.day_id = NEW.day_id
        AND r.labourer_id = NEW.labourer_id
    ) THEN
      RAISE EXCEPTION 'The record belongs to another day or labourer' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM attendance_corrections c
      WHERE c.tenant_id = NEW.tenant_id AND c.day_id = NEW.day_id
        AND c.labourer_id = NEW.labourer_id AND c.status = 'pending'
    ) THEN
      RAISE EXCEPTION 'A correction is already pending' USING ERRCODE = '23514';
    END IF;
    NEW.requested_at := now();
    RETURN NEW;
  END IF;
  IF OLD.status <> 'pending' OR NEW.status NOT IN ('approved', 'rejected')
     OR NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.day_id IS DISTINCT FROM OLD.day_id OR NEW.site_id IS DISTINCT FROM OLD.site_id
     OR NEW.work_date IS DISTINCT FROM OLD.work_date OR NEW.record_id IS DISTINCT FROM OLD.record_id
     OR NEW.labourer_id IS DISTINCT FROM OLD.labourer_id
     OR NEW.proposed IS DISTINCT FROM OLD.proposed OR NEW.previous IS DISTINCT FROM OLD.previous
     OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    RAISE EXCEPTION 'A correction is decided once and never rewritten' USING ERRCODE = '23514';
  END IF;
  NEW.decided_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER attendance_correction_guard BEFORE INSERT OR UPDATE ON "attendance_corrections"
  FOR EACH ROW EXECUTE FUNCTION app.guard_attendance_correction();

-- Anomalies --------------------------------------------------------------------------------------
-- packages/types ANOMALY_KINDS, ANOMALY_SEVERITIES, ANOMALY_STATUSES.
ALTER TABLE "attendance_anomalies" ADD CONSTRAINT "attendance_anomalies_vocabulary_check" CHECK (
  kind IN ('two_sites', 'overlapping_times', 'excess_hours', 'not_engaged', 'labourer_inactive',
    'do_not_rehire', 'accreditation_invalid', 'manual_override')
  AND severity IN ('critical', 'warning', 'info')
  AND status IN ('open', 'resolved', 'dismissed', 'cleared')
  AND jsonb_typeof(details) = 'object' AND version >= 1
  AND (review_note IS NULL OR char_length(btrim(review_note)) BETWEEN 3 AND 500)
);
ALTER TABLE "attendance_anomalies" ADD CONSTRAINT "attendance_anomalies_state_check" CHECK (
  ((status = 'open') = (open_marker IS NOT NULL))
  AND (open_marker IS NULL OR open_marker = 'open')
  AND ((kind = 'manual_override') = (correction_id IS NOT NULL))
  AND (
    (status = 'open' AND reviewed_by IS NULL AND reviewed_at IS NULL AND review_note IS NULL)
    OR (status IN ('resolved', 'dismissed') AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL
      AND review_note IS NOT NULL)
    OR (status = 'cleared' AND reviewed_at IS NOT NULL)
  )
);

-- An anomaly describes its record (same company, project, site, labourer and date) and is closed
-- once: resolved or dismissed by a person who neither recorded nor last changed the record, or
-- cleared when its condition no longer holds. Closed anomalies never change.
CREATE FUNCTION app.guard_attendance_anomaly() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rec record;
BEGIN
  SELECT project_id, site_id, labourer_id, work_date, created_by, updated_by INTO rec
  FROM attendance_records WHERE tenant_id = NEW.tenant_id AND id = NEW.record_id;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' THEN
      RAISE EXCEPTION 'An anomaly starts open' USING ERRCODE = '23514';
    END IF;
    IF rec.project_id IS DISTINCT FROM NEW.project_id OR rec.site_id IS DISTINCT FROM NEW.site_id
       OR rec.labourer_id IS DISTINCT FROM NEW.labourer_id
       OR rec.work_date IS DISTINCT FROM NEW.work_date THEN
      RAISE EXCEPTION 'An anomaly must describe its record' USING ERRCODE = '23514';
    END IF;
    NEW.detected_at := now();
    RETURN NEW;
  END IF;
  IF OLD.status <> 'open' OR NEW.status = 'open'
     OR NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.site_id IS DISTINCT FROM OLD.site_id
     OR NEW.record_id IS DISTINCT FROM OLD.record_id
     OR NEW.labourer_id IS DISTINCT FROM OLD.labourer_id
     OR NEW.work_date IS DISTINCT FROM OLD.work_date OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.severity IS DISTINCT FROM OLD.severity OR NEW.details IS DISTINCT FROM OLD.details
     OR NEW.correction_id IS DISTINCT FROM OLD.correction_id
     OR NEW.detected_at IS DISTINCT FROM OLD.detected_at THEN
    RAISE EXCEPTION 'An anomaly is closed once and never rewritten' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('resolved', 'dismissed') AND NEW.kind <> 'manual_override'
     AND (NEW.reviewed_by = rec.created_by OR NEW.reviewed_by = rec.updated_by) THEN
    RAISE EXCEPTION 'Someone who recorded the attendance cannot review its anomaly'
      USING ERRCODE = '23514';
  END IF;
  NEW.reviewed_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER attendance_anomaly_guard BEFORE INSERT OR UPDATE ON "attendance_anomalies"
  FOR EACH ROW EXECUTE FUNCTION app.guard_attendance_anomaly();

-- Approved timesheet lines -----------------------------------------------------------------------
ALTER TABLE "timesheet_lines" ADD CONSTRAINT "timesheet_lines_kind_check" CHECK (
  (kind = 'attendance' AND line_key = 'attendance' AND adjustment_id IS NULL
    AND original_period_id IS NULL AND half_days >= 0 AND worked_minutes >= 0
    AND normal_minutes >= 0 AND ot_weekday_minutes >= 0 AND ot_rest_day_minutes >= 0
    AND ot_holiday_minutes >= 0 AND late_minutes >= 0 AND present_count >= 0
    AND half_day_count >= 0 AND absent_count >= 0 AND leave_count >= 0 AND sick_count >= 0)
  OR (kind = 'adjustment' AND adjustment_id IS NOT NULL AND original_period_id IS NOT NULL
    AND line_key = 'adjustment:' || adjustment_id::text)
);
ALTER TABLE "timesheet_lines" ADD CONSTRAINT "timesheet_lines_minutes_check" CHECK (
  worked_minutes = normal_minutes + ot_weekday_minutes + ot_rest_day_minutes + ot_holiday_minutes
  AND jsonb_typeof(days) = 'array'
);

-- Lines are the approval snapshot: written only in the transaction that approves their period,
-- never updated or deleted.
CREATE FUNCTION app.guard_timesheet_line() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Approved timesheet lines are immutable' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM timesheet_periods p
    WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.period_id
      AND p.status = 'approved' AND p.approved_at = now()
  ) THEN
    RAISE EXCEPTION 'Timesheet lines are written only when their period is approved'
      USING ERRCODE = '23514';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER timesheet_line_guard BEFORE INSERT OR UPDATE OR DELETE ON "timesheet_lines"
  FOR EACH ROW EXECUTE FUNCTION app.guard_timesheet_line();

-- Adjustments ------------------------------------------------------------------------------------
ALTER TABLE "timesheet_adjustments" ADD CONSTRAINT "timesheet_adjustments_check" CHECK (
  status IN ('pending', 'approved', 'rejected') AND version >= 1
  AND char_length(btrim(reason)) BETWEEN 10 AND 500
  AND jsonb_typeof(proposed) = 'object'
  AND (previous IS NULL OR jsonb_typeof(previous) = 'object')
  AND (delta IS NULL OR jsonb_typeof(delta) = 'object')
  AND (decision_note IS NULL OR char_length(btrim(decision_note)) BETWEEN 3 AND 500)
  AND (target_period_id IS NULL OR target_period_id <> original_period_id)
);
-- Maker ≠ checker: the requester never decides their own adjustment.
ALTER TABLE "timesheet_adjustments" ADD CONSTRAINT "timesheet_adjustments_maker_checker_check"
  CHECK (decided_by IS NULL OR decided_by <> requested_by);
ALTER TABLE "timesheet_adjustments" ADD CONSTRAINT "timesheet_adjustments_state_check" CHECK (
  (status = 'pending' AND decided_by IS NULL AND decided_at IS NULL AND target_period_id IS NULL
    AND delta IS NULL)
  OR (status = 'approved' AND decided_by IS NOT NULL AND decided_at IS NOT NULL
    AND target_period_id IS NOT NULL AND delta IS NOT NULL AND rule_version_id IS NOT NULL)
  OR (status = 'rejected' AND decided_by IS NOT NULL AND decided_at IS NOT NULL
    AND decision_note IS NOT NULL AND target_period_id IS NULL AND delta IS NULL)
);

-- An adjustment corrects a date inside an approved period without touching it (late attendance
-- creates adjustments, never mutates closed periods: INVARIANTS). One pending adjustment per
-- labourer and date; decided once; an approved one lands in a later open or rejected period.
CREATE FUNCTION app.guard_timesheet_adjustment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  original record;
  target record;
BEGIN
  SELECT status, start_date, end_date INTO original FROM timesheet_periods
  WHERE tenant_id = NEW.tenant_id AND id = NEW.original_period_id;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'An adjustment starts pending' USING ERRCODE = '23514';
    END IF;
    IF original.status IS DISTINCT FROM 'approved'
       OR NEW.work_date NOT BETWEEN original.start_date AND original.end_date THEN
      RAISE EXCEPTION 'Adjustments correct dates of an approved period' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM timesheet_adjustments a
      WHERE a.tenant_id = NEW.tenant_id AND a.labourer_id = NEW.labourer_id
        AND a.work_date = NEW.work_date AND a.status = 'pending'
    ) THEN
      RAISE EXCEPTION 'An adjustment is already pending' USING ERRCODE = '23514';
    END IF;
    NEW.requested_at := now();
    RETURN NEW;
  END IF;
  IF OLD.status <> 'pending' OR NEW.status NOT IN ('approved', 'rejected')
     OR NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.original_period_id IS DISTINCT FROM OLD.original_period_id
     OR NEW.labourer_id IS DISTINCT FROM OLD.labourer_id OR NEW.site_id IS DISTINCT FROM OLD.site_id
     OR NEW.work_date IS DISTINCT FROM OLD.work_date OR NEW.record_id IS DISTINCT FROM OLD.record_id
     OR NEW.proposed IS DISTINCT FROM OLD.proposed OR NEW.previous IS DISTINCT FROM OLD.previous
     OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    RAISE EXCEPTION 'An adjustment is decided once and never rewritten' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'approved' THEN
    SELECT status, start_date INTO target FROM timesheet_periods
    WHERE tenant_id = NEW.tenant_id AND id = NEW.target_period_id;
    IF target.status IS NULL OR target.status NOT IN ('open', 'rejected')
       OR target.start_date <= original.end_date THEN
      RAISE EXCEPTION 'An adjustment lands in a later open period' USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.decided_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER timesheet_adjustment_guard BEFORE INSERT OR UPDATE ON "timesheet_adjustments"
  FOR EACH ROW EXECUTE FUNCTION app.guard_timesheet_adjustment();

-- Idempotency and outbox -------------------------------------------------------------------------
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_check" CHECK (
  operation ~ '^[a-z][a-z0-9_.:-]{2,79}$' AND idempotency_key ~ '^[A-Za-z0-9_-]{8,128}$'
  AND fingerprint ~ '^[0-9a-f]{64}$'
);
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_check" CHECK (
  topic ~ '^[a-z][a-z0-9_.]{2,79}$' AND jsonb_typeof(payload) = 'object'
);

-- The catalogue gains attendance.confirm, timesheets.submit, timesheets.approve and
-- timesheets.manage_rules (packages/types PERMISSIONS and PROJECT_ASSIGNABLE_PERMISSIONS). Existing
-- rows keep their values; both constraints only widen.
ALTER TABLE "tenant_roles" DROP CONSTRAINT "tenant_roles_permissions_check";
ALTER TABLE "tenant_roles" ADD CONSTRAINT "tenant_roles_permissions_check" CHECK (
  permissions IS NOT NULL
  AND cardinality(permissions) >= 1
  AND permissions <@ ARRAY[
    'tenancy.manage', 'users.invite', 'roles.manage', 'audit.view', 'config.manage',
    'config.manage_statutory', 'projects.view', 'projects.create', 'projects.manage', 'bq.view',
    'bq.edit', 'bq.import', 'bq.approve_variation', 'labour.view', 'labour.manage',
    'labour.view_sensitive', 'labour.do_not_rehire', 'labour.consent', 'attendance.view',
    'attendance.record', 'attendance.override', 'attendance.review_anomalies',
    'attendance.confirm', 'timesheets.submit', 'timesheets.approve', 'timesheets.manage_rules',
    'payroll.prepare', 'payroll.review', 'payroll.approve', 'payments.view', 'payments.approve',
    'payments.disburse', 'payments.record_cash', 'payments.reverse', 'procurement.requisition',
    'procurement.approve', 'procurement.manage_suppliers', 'stores.manage', 'finance.view',
    'finance.manage', 'finance.view_sensitive', 'site.diary', 'site.photos', 'quality.manage',
    'safety.manage', 'plant.manage', 'documents.manage', 'reports.view', 'portal.client',
    'portal.supplier'
  ]::text[]
);
ALTER TABLE "project_memberships" DROP CONSTRAINT "project_permissions_check";
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_permissions_check" CHECK (
  permissions <@ ARRAY[
    'projects.view', 'projects.manage', 'bq.view', 'bq.edit', 'bq.import',
    'bq.approve_variation', 'labour.view', 'labour.manage', 'labour.view_sensitive',
    'labour.do_not_rehire', 'labour.consent', 'attendance.view', 'attendance.record',
    'attendance.override', 'attendance.review_anomalies', 'attendance.confirm',
    'timesheets.submit', 'timesheets.approve', 'timesheets.manage_rules', 'payroll.prepare',
    'payroll.review', 'procurement.requisition', 'procurement.approve', 'stores.manage',
    'finance.view', 'site.diary', 'site.photos', 'quality.manage', 'safety.manage',
    'plant.manage', 'documents.manage', 'reports.view'
  ]::text[]
);

-- Row-level security -----------------------------------------------------------------------------
ALTER TABLE "attendance_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_settings" FORCE ROW LEVEL SECURITY;
ALTER TABLE "timesheet_rule_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "timesheet_rule_versions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "public_holidays" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public_holidays" FORCE ROW LEVEL SECURITY;
ALTER TABLE "timesheet_periods" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "timesheet_periods" FORCE ROW LEVEL SECURITY;
ALTER TABLE "attendance_days" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_days" FORCE ROW LEVEL SECURITY;
ALTER TABLE "attendance_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_records" FORCE ROW LEVEL SECURITY;
ALTER TABLE "attendance_corrections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_corrections" FORCE ROW LEVEL SECURITY;
ALTER TABLE "attendance_anomalies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_anomalies" FORCE ROW LEVEL SECURITY;
ALTER TABLE "timesheet_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "timesheet_lines" FORCE ROW LEVEL SECURITY;
ALTER TABLE "timesheet_adjustments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "timesheet_adjustments" FORCE ROW LEVEL SECURITY;
ALTER TABLE "idempotency_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "idempotency_records" FORCE ROW LEVEL SECURITY;
ALTER TABLE "outbox_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbox_events" FORCE ROW LEVEL SECURITY;

CREATE POLICY attendance_settings_isolation ON attendance_settings
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY timesheet_rule_versions_read ON timesheet_rule_versions FOR SELECT
  USING (tenant_id = app.current_tenant_id());
CREATE POLICY timesheet_rule_versions_insert ON timesheet_rule_versions FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id() AND created_by = app.current_user_id());
CREATE POLICY timesheet_rule_versions_cancel ON timesheet_rule_versions FOR DELETE
  USING (tenant_id = app.current_tenant_id());
CREATE POLICY public_holidays_read ON public_holidays FOR SELECT
  USING (tenant_id = app.current_tenant_id());
CREATE POLICY public_holidays_insert ON public_holidays FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id() AND created_by = app.current_user_id());
CREATE POLICY public_holidays_remove ON public_holidays FOR DELETE
  USING (tenant_id = app.current_tenant_id());
CREATE POLICY timesheet_periods_isolation ON timesheet_periods
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY attendance_days_isolation ON attendance_days
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY attendance_records_isolation ON attendance_records
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY attendance_corrections_read ON attendance_corrections FOR SELECT
  USING (tenant_id = app.current_tenant_id());
CREATE POLICY attendance_corrections_insert ON attendance_corrections FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id() AND requested_by = app.current_user_id());
CREATE POLICY attendance_corrections_decide ON attendance_corrections FOR UPDATE
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND decided_by = app.current_user_id());
CREATE POLICY attendance_anomalies_isolation ON attendance_anomalies
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY timesheet_lines_read ON timesheet_lines FOR SELECT
  USING (tenant_id = app.current_tenant_id());
CREATE POLICY timesheet_lines_insert ON timesheet_lines FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY timesheet_adjustments_read ON timesheet_adjustments FOR SELECT
  USING (tenant_id = app.current_tenant_id());
CREATE POLICY timesheet_adjustments_insert ON timesheet_adjustments FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id() AND requested_by = app.current_user_id());
CREATE POLICY timesheet_adjustments_decide ON timesheet_adjustments FOR UPDATE
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND decided_by = app.current_user_id());
CREATE POLICY idempotency_records_read ON idempotency_records FOR SELECT
  USING (tenant_id = app.current_tenant_id());
CREATE POLICY idempotency_records_insert ON idempotency_records FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id() AND user_id = app.current_user_id());
CREATE POLICY outbox_events_read ON outbox_events FOR SELECT
  USING (tenant_id = app.current_tenant_id());
CREATE POLICY outbox_events_insert ON outbox_events FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id());

-- Runtime role: attendance history, approvals and the payroll snapshot are never deleted or
-- rewritten outside the guarded transitions; approved lines, idempotency records and outbox events
-- are insert-only; only scheduled rule versions and unlocked holidays can be removed. No TRUNCATE,
-- REFERENCES or TRIGGER on any new table.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmb_app') THEN
    REVOKE UPDATE ON "timesheet_rule_versions", "public_holidays", "timesheet_lines",
      "idempotency_records", "outbox_events" FROM pmb_app;
    REVOKE DELETE ON "attendance_settings", "timesheet_periods", "attendance_days",
      "attendance_records", "attendance_corrections", "attendance_anomalies", "timesheet_lines",
      "timesheet_adjustments", "idempotency_records", "outbox_events" FROM pmb_app;
    REVOKE TRUNCATE, REFERENCES, TRIGGER ON "attendance_settings", "timesheet_rule_versions",
      "public_holidays", "timesheet_periods", "attendance_days", "attendance_records",
      "attendance_corrections", "attendance_anomalies", "timesheet_lines",
      "timesheet_adjustments", "idempotency_records", "outbox_events" FROM pmb_app;
  END IF;
END
$$;
REVOKE EXECUTE ON FUNCTION app.guard_timesheet_rule() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_public_holiday() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_timesheet_period() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_attendance_day() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_attendance_record() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_attendance_correction() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_attendance_anomaly() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_timesheet_line() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_timesheet_adjustment() FROM PUBLIC;

COMMIT;
