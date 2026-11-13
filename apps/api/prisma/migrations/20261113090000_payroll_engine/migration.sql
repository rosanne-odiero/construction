-- D4.1 Payroll engine (ARCHITECTURE §4.5, ERD §7, WORKFLOWS "Payroll"; brief §5.6, §6, §15 C).
-- * payroll_settings (advance limits, recovery cap) and pay_calendars (daily, weekly, fortnightly
--   or monthly per project; weekly following the timesheet weeks when no row exists).
-- * statutory_rule_versions: effective-dated PAYE, NSSF, SHIF, AHL, NITA, non-monthly method and
--   applicability per engagement type; never edited, only verified once by someone other than the
--   author (COMPLIANCE-REVIEW CR-PAY-01 … CR-PAY-07). minimum_wage_rates (warning only, CR-PAY-09).
-- * payroll_allowances, piece_rate_outputs (+ shares written at approval, maker ≠ checker) and
--   salary_advances (requested → approved → disbursed outside PM-Buddy; requester ≠ approver ≠ payer).
-- * payroll_batches (draft → submitted snapshot or cancelled) with payroll_lines, payroll_earnings,
--   payroll_deductions (employee and employer) and advance_recoveries, rewritten only while draft.
-- * payroll_consumptions: each approved timesheet line and output share is consumed by at most one
--   live batch (unique while active). payroll_day_claims: attendance and piece rate never pay the
--   same labourer-day (trigger). Advances are never over-recovered (trigger with a row lock).
-- * The catalogue gains payroll.view/manage_rules/verify_rules/export and advances.request/approve;
--   verification and exports join the MFA-required permissions.
-- Every new table has tenant_id, forced RLS with WITH CHECK, composite (tenant_id, …) foreign keys
-- and no TRUNCATE/REFERENCES/TRIGGER for pmb_app; snapshots and history lose UPDATE/DELETE.
BEGIN;

-- CreateTable
CREATE TABLE "payroll_settings" (
    "tenant_id" UUID NOT NULL,
    "advance_max_minor" BIGINT NOT NULL,
    "advance_max_outstanding_minor" BIGINT NOT NULL,
    "recovery_max_percent" DECIMAL(5,2) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_settings_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "pay_calendars" (
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "frequency" VARCHAR(20) NOT NULL,
    "anchor_date" DATE NOT NULL,
    "payday_offset_days" SMALLINT NOT NULL,
    "minimum_wage_area" VARCHAR(20),
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pay_calendars_pkey" PRIMARY KEY ("tenant_id","project_id")
);

-- CreateTable
CREATE TABLE "statutory_rule_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "effective_from" DATE NOT NULL,
    "parameters" JSONB NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'unverified',
    "source_reference" VARCHAR(2000) NOT NULL,
    "notes" VARCHAR(1000) NOT NULL DEFAULT '',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verified_by" UUID,
    "verified_at" TIMESTAMPTZ,
    "verification_note" VARCHAR(500),

    CONSTRAINT "statutory_rule_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "minimum_wage_rates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "effective_from" DATE NOT NULL,
    "area" VARCHAR(20) NOT NULL,
    "occupation" VARCHAR(30) NOT NULL,
    "monthly_minor" BIGINT NOT NULL,
    "daily_minor" BIGINT,
    "hourly_minor" BIGINT,
    "source" VARCHAR(2000) NOT NULL,
    "compliance_status" VARCHAR(20) NOT NULL DEFAULT 'unverified',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "minimum_wage_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_allowances" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "name_en" VARCHAR(80) NOT NULL,
    "name_sw" VARCHAR(80) NOT NULL,
    "basis" VARCHAR(20) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "taxable" BOOLEAN NOT NULL,
    "trade_id" UUID,
    "labourer_id" UUID,
    "effective_from" DATE NOT NULL,
    "ended_on" DATE,
    "ended_by" UUID,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_allowances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "piece_rate_outputs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "work_date" DATE NOT NULL,
    "labourer_id" UUID,
    "gang_id" UUID,
    "bq_item_id" UUID,
    "description" VARCHAR(200) NOT NULL,
    "unit" VARCHAR(20) NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "rate_minor" BIGINT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "version" INTEGER NOT NULL DEFAULT 1,
    "recorded_by" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ,
    "decision_note" VARCHAR(500),

    CONSTRAINT "piece_rate_outputs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "piece_rate_output_shares" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "output_id" UUID NOT NULL,
    "labourer_id" UUID NOT NULL,
    "work_date" DATE NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "piece_rate_output_shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_advances" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "labourer_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "instalment_minor" BIGINT,
    "max_recovery_percent" DECIMAL(5,2),
    "status" VARCHAR(20) NOT NULL DEFAULT 'requested',
    "version" INTEGER NOT NULL DEFAULT 1,
    "requested_by" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ,
    "decision_note" VARCHAR(500),
    "disbursement_method" VARCHAR(20),
    "disbursement_reference" VARCHAR(60),
    "paid_on" DATE,
    "evidence_note" VARCHAR(500),
    "disbursed_by" UUID,
    "disbursed_at" TIMESTAMPTZ,
    "cancelled_by" UUID,
    "cancelled_at" TIMESTAMPTZ,
    "cancellation_reason" VARCHAR(500),

    CONSTRAINT "salary_advances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_batches" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "pay_date" DATE NOT NULL,
    "statutory_month" CHAR(7) NOT NULL,
    "frequency" VARCHAR(20) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 1,
    "active_marker" VARCHAR(6) DEFAULT 'active',
    "unverified_rules" BOOLEAN NOT NULL,
    "line_count" INTEGER NOT NULL,
    "gross_minor" BIGINT NOT NULL,
    "total_deductions_minor" BIGINT NOT NULL,
    "net_minor" BIGINT NOT NULL,
    "employer_cost_minor" BIGINT NOT NULL,
    "totals" JSONB NOT NULL,
    "exclusions" JSONB NOT NULL,
    "rule_version_ids" UUID[],
    "timesheet_rule_ids" UUID[],
    "mtd_batch_ids" UUID[],
    "digest" CHAR(64) NOT NULL,
    "calculated_by" UUID NOT NULL,
    "calculated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_by" UUID,
    "submitted_at" TIMESTAMPTZ,
    "cancelled_by" UUID,
    "cancelled_at" TIMESTAMPTZ,
    "cancellation_reason" VARCHAR(500),

    CONSTRAINT "payroll_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_lines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "labourer_id" UUID NOT NULL,
    "worker_no" VARCHAR(20) NOT NULL,
    "full_name" VARCHAR(150) NOT NULL,
    "trade_name_en" VARCHAR(80),
    "trade_name_sw" VARCHAR(80),
    "engagement_type" VARCHAR(20) NOT NULL,
    "rate_basis" VARCHAR(10) NOT NULL,
    "half_days" INTEGER NOT NULL,
    "normal_minutes" INTEGER NOT NULL,
    "ot_weekday_minutes" INTEGER NOT NULL,
    "ot_rest_day_minutes" INTEGER NOT NULL,
    "ot_holiday_minutes" INTEGER NOT NULL,
    "days_worked" INTEGER NOT NULL,
    "gross_minor" BIGINT NOT NULL,
    "statutory_base_minor" BIGINT NOT NULL,
    "statutory_withheld_minor" BIGINT NOT NULL,
    "advance_recovery_minor" BIGINT NOT NULL,
    "other_deductions_minor" BIGINT NOT NULL,
    "net_minor" BIGINT NOT NULL,
    "employer_cost_minor" BIGINT NOT NULL,
    "statutory_month" CHAR(7) NOT NULL,
    "month_to_date" JSONB NOT NULL,
    "warnings" JSONB NOT NULL,
    "payee_phone_bidx" CHAR(64),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_earnings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "category" VARCHAR(20),
    "work_date" DATE,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unit" VARCHAR(20) NOT NULL,
    "rate_minor" BIGINT,
    "multiplier" DECIMAL(6,3),
    "description" VARCHAR(200) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "taxable" BOOLEAN NOT NULL,
    "labour_rate_id" UUID,
    "timesheet_rule_id" UUID,
    "timesheet_line_id" UUID,
    "share_id" UUID,
    "allowance_id" UUID,

    CONSTRAINT "payroll_earnings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_deductions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "party" VARCHAR(10) NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "due_minor" BIGINT NOT NULL,
    "withheld_minor" BIGINT NOT NULL,
    "shortfall_minor" BIGINT NOT NULL,
    "rule_version_id" UUID NOT NULL,

    CONSTRAINT "payroll_deductions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "advance_recoveries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "advance_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "outstanding_after_minor" BIGINT NOT NULL,

    CONSTRAINT "advance_recoveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_consumptions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "source_kind" VARCHAR(20) NOT NULL,
    "timesheet_line_id" UUID,
    "share_id" UUID,
    "active_marker" VARCHAR(6) DEFAULT 'active',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_consumptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_day_claims" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "labourer_id" UUID NOT NULL,
    "work_date" DATE NOT NULL,
    "basis" VARCHAR(20) NOT NULL,
    "active_marker" VARCHAR(6) DEFAULT 'active',

    CONSTRAINT "payroll_day_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "statutory_rule_versions_tenant_id_id_key" ON "statutory_rule_versions"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "statutory_rule_versions_tenant_id_kind_effective_from_key" ON "statutory_rule_versions"("tenant_id", "kind", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "minimum_wage_rates_tenant_id_id_key" ON "minimum_wage_rates"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "minimum_wage_rates_tenant_id_area_occupation_effective_from_key" ON "minimum_wage_rates"("tenant_id", "area", "occupation", "effective_from");

-- CreateIndex
CREATE INDEX "payroll_allowances_tenant_id_project_id_idx" ON "payroll_allowances"("tenant_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_allowances_tenant_id_id_key" ON "payroll_allowances"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "piece_rate_outputs_tenant_id_project_id_work_date_idx" ON "piece_rate_outputs"("tenant_id", "project_id", "work_date");

-- CreateIndex
CREATE UNIQUE INDEX "piece_rate_outputs_tenant_id_id_key" ON "piece_rate_outputs"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "piece_rate_outputs_tenant_id_project_id_id_key" ON "piece_rate_outputs"("tenant_id", "project_id", "id");

-- CreateIndex
CREATE INDEX "piece_rate_output_shares_tenant_id_project_id_work_date_idx" ON "piece_rate_output_shares"("tenant_id", "project_id", "work_date");

-- CreateIndex
CREATE UNIQUE INDEX "piece_rate_output_shares_tenant_id_id_key" ON "piece_rate_output_shares"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "piece_rate_output_shares_tenant_id_output_id_labourer_id_key" ON "piece_rate_output_shares"("tenant_id", "output_id", "labourer_id");

-- CreateIndex
CREATE INDEX "salary_advances_tenant_id_labourer_id_idx" ON "salary_advances"("tenant_id", "labourer_id");

-- CreateIndex
CREATE INDEX "salary_advances_tenant_id_project_id_status_idx" ON "salary_advances"("tenant_id", "project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "salary_advances_tenant_id_id_key" ON "salary_advances"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "payroll_batches_tenant_id_statutory_month_status_idx" ON "payroll_batches"("tenant_id", "statutory_month", "status");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_batches_tenant_id_id_key" ON "payroll_batches"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_batches_tenant_id_project_id_id_key" ON "payroll_batches"("tenant_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_batches_tenant_id_project_id_period_start_active_ma_key" ON "payroll_batches"("tenant_id", "project_id", "period_start", "active_marker");

-- CreateIndex
CREATE INDEX "payroll_lines_tenant_id_labourer_id_statutory_month_idx" ON "payroll_lines"("tenant_id", "labourer_id", "statutory_month");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_lines_tenant_id_id_key" ON "payroll_lines"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_lines_tenant_id_batch_id_id_key" ON "payroll_lines"("tenant_id", "batch_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_lines_tenant_id_batch_id_labourer_id_key" ON "payroll_lines"("tenant_id", "batch_id", "labourer_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_earnings_tenant_id_id_key" ON "payroll_earnings"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_earnings_tenant_id_line_id_position_key" ON "payroll_earnings"("tenant_id", "line_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_deductions_tenant_id_id_key" ON "payroll_deductions"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_deductions_tenant_id_line_id_kind_key" ON "payroll_deductions"("tenant_id", "line_id", "kind");

-- CreateIndex
CREATE INDEX "advance_recoveries_tenant_id_advance_id_idx" ON "advance_recoveries"("tenant_id", "advance_id");

-- CreateIndex
CREATE UNIQUE INDEX "advance_recoveries_tenant_id_id_key" ON "advance_recoveries"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "advance_recoveries_tenant_id_line_id_advance_id_key" ON "advance_recoveries"("tenant_id", "line_id", "advance_id");

-- CreateIndex
CREATE INDEX "payroll_consumptions_tenant_id_batch_id_idx" ON "payroll_consumptions"("tenant_id", "batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_consumptions_tenant_id_id_key" ON "payroll_consumptions"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_consumptions_tenant_id_timesheet_line_id_active_mar_key" ON "payroll_consumptions"("tenant_id", "timesheet_line_id", "active_marker");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_consumptions_tenant_id_share_id_active_marker_key" ON "payroll_consumptions"("tenant_id", "share_id", "active_marker");

-- CreateIndex
CREATE INDEX "payroll_day_claims_tenant_id_labourer_id_work_date_idx" ON "payroll_day_claims"("tenant_id", "labourer_id", "work_date");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_day_claims_tenant_id_id_key" ON "payroll_day_claims"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_day_claims_tenant_id_batch_id_labourer_id_work_date_key" ON "payroll_day_claims"("tenant_id", "batch_id", "labourer_id", "work_date", "basis");

-- AddForeignKey
ALTER TABLE "payroll_settings" ADD CONSTRAINT "payroll_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pay_calendars" ADD CONSTRAINT "pay_calendars_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "statutory_rule_versions" ADD CONSTRAINT "statutory_rule_versions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "minimum_wage_rates" ADD CONSTRAINT "minimum_wage_rates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_allowances" ADD CONSTRAINT "payroll_allowances_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_allowances" ADD CONSTRAINT "payroll_allowances_tenant_id_trade_id_fkey" FOREIGN KEY ("tenant_id", "trade_id") REFERENCES "trades"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_allowances" ADD CONSTRAINT "payroll_allowances_tenant_id_labourer_id_fkey" FOREIGN KEY ("tenant_id", "labourer_id") REFERENCES "labourers"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "piece_rate_outputs" ADD CONSTRAINT "piece_rate_outputs_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "piece_rate_outputs" ADD CONSTRAINT "piece_rate_outputs_tenant_id_labourer_id_fkey" FOREIGN KEY ("tenant_id", "labourer_id") REFERENCES "labourers"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "piece_rate_outputs" ADD CONSTRAINT "piece_rate_outputs_tenant_id_project_id_gang_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "gang_id") REFERENCES "gangs"("tenant_id", "project_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "piece_rate_outputs" ADD CONSTRAINT "piece_rate_outputs_tenant_id_bq_item_id_fkey" FOREIGN KEY ("tenant_id", "bq_item_id") REFERENCES "bq_items"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "piece_rate_output_shares" ADD CONSTRAINT "piece_rate_output_shares_tenant_id_project_id_output_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "output_id") REFERENCES "piece_rate_outputs"("tenant_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "piece_rate_output_shares" ADD CONSTRAINT "piece_rate_output_shares_tenant_id_labourer_id_fkey" FOREIGN KEY ("tenant_id", "labourer_id") REFERENCES "labourers"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_advances" ADD CONSTRAINT "salary_advances_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_advances" ADD CONSTRAINT "salary_advances_tenant_id_labourer_id_fkey" FOREIGN KEY ("tenant_id", "labourer_id") REFERENCES "labourers"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_batches" ADD CONSTRAINT "payroll_batches_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_tenant_id_project_id_batch_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "batch_id") REFERENCES "payroll_batches"("tenant_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_tenant_id_labourer_id_fkey" FOREIGN KEY ("tenant_id", "labourer_id") REFERENCES "labourers"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_earnings" ADD CONSTRAINT "payroll_earnings_tenant_id_batch_id_line_id_fkey" FOREIGN KEY ("tenant_id", "batch_id", "line_id") REFERENCES "payroll_lines"("tenant_id", "batch_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_earnings" ADD CONSTRAINT "payroll_earnings_tenant_id_labour_rate_id_fkey" FOREIGN KEY ("tenant_id", "labour_rate_id") REFERENCES "labour_rates"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_earnings" ADD CONSTRAINT "payroll_earnings_tenant_id_timesheet_rule_id_fkey" FOREIGN KEY ("tenant_id", "timesheet_rule_id") REFERENCES "timesheet_rule_versions"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_earnings" ADD CONSTRAINT "payroll_earnings_tenant_id_timesheet_line_id_fkey" FOREIGN KEY ("tenant_id", "timesheet_line_id") REFERENCES "timesheet_lines"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_earnings" ADD CONSTRAINT "payroll_earnings_tenant_id_share_id_fkey" FOREIGN KEY ("tenant_id", "share_id") REFERENCES "piece_rate_output_shares"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_earnings" ADD CONSTRAINT "payroll_earnings_tenant_id_allowance_id_fkey" FOREIGN KEY ("tenant_id", "allowance_id") REFERENCES "payroll_allowances"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_deductions" ADD CONSTRAINT "payroll_deductions_tenant_id_batch_id_line_id_fkey" FOREIGN KEY ("tenant_id", "batch_id", "line_id") REFERENCES "payroll_lines"("tenant_id", "batch_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_deductions" ADD CONSTRAINT "payroll_deductions_tenant_id_rule_version_id_fkey" FOREIGN KEY ("tenant_id", "rule_version_id") REFERENCES "statutory_rule_versions"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advance_recoveries" ADD CONSTRAINT "advance_recoveries_tenant_id_batch_id_line_id_fkey" FOREIGN KEY ("tenant_id", "batch_id", "line_id") REFERENCES "payroll_lines"("tenant_id", "batch_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advance_recoveries" ADD CONSTRAINT "advance_recoveries_tenant_id_advance_id_fkey" FOREIGN KEY ("tenant_id", "advance_id") REFERENCES "salary_advances"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_consumptions" ADD CONSTRAINT "payroll_consumptions_tenant_id_project_id_batch_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "batch_id") REFERENCES "payroll_batches"("tenant_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_consumptions" ADD CONSTRAINT "payroll_consumptions_tenant_id_timesheet_line_id_fkey" FOREIGN KEY ("tenant_id", "timesheet_line_id") REFERENCES "timesheet_lines"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_consumptions" ADD CONSTRAINT "payroll_consumptions_tenant_id_share_id_fkey" FOREIGN KEY ("tenant_id", "share_id") REFERENCES "piece_rate_output_shares"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_day_claims" ADD CONSTRAINT "payroll_day_claims_tenant_id_project_id_batch_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "batch_id") REFERENCES "payroll_batches"("tenant_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_day_claims" ADD CONSTRAINT "payroll_day_claims_tenant_id_labourer_id_fkey" FOREIGN KEY ("tenant_id", "labourer_id") REFERENCES "labourers"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;


-- Helpers ----------------------------------------------------------------------------------------
-- Whether `labourer` is engaged on `project` on `day` (labour_engagements).
CREATE FUNCTION app.is_engaged(tenant uuid, labourer uuid, project uuid, day date) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM labour_engagements e
    WHERE e.tenant_id = tenant AND e.labourer_id = labourer AND e.project_id = project
      AND e.start_date <= day AND (e.end_date IS NULL OR e.end_date >= day)
  )
$$;

-- The status of a batch, for the child-table guards (NULL when it does not exist).
CREATE FUNCTION app.payroll_batch_status(tenant uuid, batch uuid) RETURNS text
  LANGUAGE sql STABLE AS $$
  SELECT status FROM payroll_batches WHERE tenant_id = tenant AND id = batch
$$;

-- Settings and calendars --------------------------------------------------------------------------
-- packages/types PAYROLL_SETTINGS_LIMITS (PRODUCT).
ALTER TABLE "payroll_settings" ADD CONSTRAINT "payroll_settings_check" CHECK (
  advance_max_minor BETWEEN 100 AND 100000000
  AND advance_max_outstanding_minor BETWEEN 100 AND 100000000
  AND advance_max_outstanding_minor >= advance_max_minor
  AND recovery_max_percent BETWEEN 1 AND 100 AND version >= 1
);
ALTER TABLE "pay_calendars" ADD CONSTRAINT "pay_calendars_check" CHECK (
  frequency IN ('daily', 'weekly', 'fortnightly', 'monthly')
  AND payday_offset_days BETWEEN 0 AND 14
  AND (minimum_wage_area IS NULL OR minimum_wage_area IN ('cities', 'municipalities', 'other'))
  AND version >= 1
);
CREATE FUNCTION app.touch_payroll_config() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER payroll_settings_touch BEFORE INSERT OR UPDATE ON "payroll_settings"
  FOR EACH ROW EXECUTE FUNCTION app.touch_payroll_config();
CREATE TRIGGER pay_calendars_touch BEFORE INSERT OR UPDATE ON "pay_calendars"
  FOR EACH ROW EXECUTE FUNCTION app.touch_payroll_config();

-- Statutory rule versions -------------------------------------------------------------------------
-- packages/types STATUTORY_RULE_KINDS; parameters are validated by the shared Zod schema and
-- packages/domain statutoryParameterIssues (COMPLIANCE-REVIEW CR-PAY-01 … CR-PAY-07).
ALTER TABLE "statutory_rule_versions" ADD CONSTRAINT "statutory_rule_versions_check" CHECK (
  kind IN ('paye', 'nssf', 'shif', 'ahl', 'nita', 'method', 'applicability')
  AND status IN ('unverified', 'verified')
  AND jsonb_typeof(parameters) = 'object'
  AND char_length(btrim(source_reference)) >= 10
);
-- Verification is a separate person's decision with a note (maker ≠ checker by identity).
ALTER TABLE "statutory_rule_versions" ADD CONSTRAINT "statutory_rule_versions_state_check" CHECK (
  (status = 'unverified' AND verified_by IS NULL AND verified_at IS NULL
    AND verification_note IS NULL)
  OR (status = 'verified' AND verified_by IS NOT NULL AND verified_at IS NOT NULL
    AND verification_note IS NOT NULL
    AND char_length(btrim(verification_note)) BETWEEN 10 AND 500
    AND verified_by <> created_by)
);

-- Rule versions are never edited: the only change is unverified → verified. A new version may not
-- take effect on or before the pay date of a submitted batch (closed history is stable,
-- INVARIANTS). Only an unverified version no batch has used can be deleted.
CREATE FUNCTION app.guard_statutory_rule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'unverified' THEN
      RAISE EXCEPTION 'A rule version starts unverified' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM payroll_batches b
      WHERE b.tenant_id = NEW.tenant_id AND b.status = 'submitted'
        AND b.pay_date >= NEW.effective_from
    ) THEN
      RAISE EXCEPTION 'A rule version cannot take effect inside submitted payroll'
        USING ERRCODE = '23514';
    END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'unverified' OR EXISTS (
      SELECT 1 FROM payroll_batches b
      WHERE b.tenant_id = OLD.tenant_id AND OLD.id = ANY (b.rule_version_ids)
    ) THEN
      RAISE EXCEPTION 'A verified or used rule version is kept' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'unverified' OR NEW.status <> 'verified'
     OR NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
     OR NEW.parameters IS DISTINCT FROM OLD.parameters
     OR NEW.source_reference IS DISTINCT FROM OLD.source_reference
     OR NEW.notes IS DISTINCT FROM OLD.notes OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Rule versions are never edited; only verified once' USING ERRCODE = '23514';
  END IF;
  NEW.verified_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER statutory_rule_guard BEFORE INSERT OR UPDATE OR DELETE ON "statutory_rule_versions"
  FOR EACH ROW EXECUTE FUNCTION app.guard_statutory_rule();

-- packages/types MINIMUM_WAGE_AREAS and MINIMUM_WAGE_OCCUPATIONS (COMPLIANCE-REVIEW CR-PAY-09).
ALTER TABLE "minimum_wage_rates" ADD CONSTRAINT "minimum_wage_rates_check" CHECK (
  area IN ('cities', 'municipalities', 'other')
  AND occupation IN ('general_labourer', 'night_watchman', 'artisan_ungraded', 'artisan_grade_iii',
    'artisan_grade_ii', 'artisan_grade_i')
  AND monthly_minor > 0 AND (daily_minor IS NULL OR daily_minor > 0)
  AND (hourly_minor IS NULL OR hourly_minor > 0)
  AND compliance_status IN ('unverified', 'verified')
  AND char_length(btrim(source)) >= 10
);

-- Allowances --------------------------------------------------------------------------------------
ALTER TABLE "payroll_allowances" ADD CONSTRAINT "payroll_allowances_check" CHECK (
  code ~ '^[a-z][a-z0-9_]{1,39}$'
  AND char_length(btrim(name_en)) >= 2 AND char_length(btrim(name_sw)) >= 2
  AND basis IN ('per_day_worked', 'per_period')
  AND amount_minor BETWEEN 1 AND 100000000
  AND NOT (trade_id IS NOT NULL AND labourer_id IS NOT NULL)
  AND (ended_on IS NULL OR ended_on >= effective_from)
  AND ((ended_on IS NULL) = (ended_by IS NULL))
);
-- An allowance for one labourer needs an engagement on the project; afterwards only its end date
-- can be set, once.
CREATE FUNCTION app.guard_payroll_allowance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.labourer_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM labour_engagements e
      WHERE e.tenant_id = NEW.tenant_id AND e.labourer_id = NEW.labourer_id
        AND e.project_id = NEW.project_id
    ) THEN
      RAISE EXCEPTION 'The labourer is not engaged on the project' USING ERRCODE = '23514';
    END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  IF OLD.ended_on IS NOT NULL OR NEW.ended_on IS NULL
     OR NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.code IS DISTINCT FROM OLD.code
     OR NEW.name_en IS DISTINCT FROM OLD.name_en OR NEW.name_sw IS DISTINCT FROM OLD.name_sw
     OR NEW.basis IS DISTINCT FROM OLD.basis OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
     OR NEW.taxable IS DISTINCT FROM OLD.taxable OR NEW.trade_id IS DISTINCT FROM OLD.trade_id
     OR NEW.labourer_id IS DISTINCT FROM OLD.labourer_id
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'An allowance is never edited; it can only be ended once'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER payroll_allowance_guard BEFORE INSERT OR UPDATE ON "payroll_allowances"
  FOR EACH ROW EXECUTE FUNCTION app.guard_payroll_allowance();

-- Piece-rate output -------------------------------------------------------------------------------
ALTER TABLE "piece_rate_outputs" ADD CONSTRAINT "piece_rate_outputs_check" CHECK (
  (labourer_id IS NULL) <> (gang_id IS NULL)
  AND quantity > 0 AND rate_minor BETWEEN 1 AND 100000000
  AND amount_minor = round(quantity * rate_minor)
  AND status IN ('pending', 'approved', 'rejected') AND version >= 1
  AND char_length(btrim(description)) >= 3 AND char_length(btrim(unit)) >= 1
  AND (decision_note IS NULL OR char_length(btrim(decision_note)) BETWEEN 1 AND 500)
);
-- Maker ≠ checker: whoever recorded the output never decides it.
ALTER TABLE "piece_rate_outputs" ADD CONSTRAINT "piece_rate_outputs_maker_checker_check"
  CHECK (decided_by IS NULL OR decided_by <> recorded_by);
ALTER TABLE "piece_rate_outputs" ADD CONSTRAINT "piece_rate_outputs_state_check" CHECK (
  (status = 'pending' AND decided_by IS NULL AND decided_at IS NULL)
  OR (status = 'approved' AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
  OR (status = 'rejected' AND decided_by IS NOT NULL AND decided_at IS NOT NULL
    AND decision_note IS NOT NULL AND char_length(btrim(decision_note)) >= 10)
);
CREATE FUNCTION app.guard_piece_rate_output() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'Output starts pending' USING ERRCODE = '23514';
    END IF;
    IF NEW.work_date > app.nairobi_today() THEN
      RAISE EXCEPTION 'Output cannot be recorded for a future date' USING ERRCODE = '23514';
    END IF;
    IF NEW.labourer_id IS NOT NULL
       AND NOT app.is_engaged(NEW.tenant_id, NEW.labourer_id, NEW.project_id, NEW.work_date) THEN
      RAISE EXCEPTION 'The labourer is not engaged on the project that day' USING ERRCODE = '23514';
    END IF;
    IF NEW.bq_item_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM bq_items i
      JOIN bq_versions v ON v.tenant_id = i.tenant_id AND v.id = i.version_id
      WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.bq_item_id AND v.project_id = NEW.project_id
    ) THEN
      RAISE EXCEPTION 'The BQ item belongs to another project' USING ERRCODE = '23514';
    END IF;
    NEW.recorded_at := now();
    RETURN NEW;
  END IF;
  IF OLD.status <> 'pending' OR NEW.status NOT IN ('approved', 'rejected')
     OR NEW.version <> OLD.version + 1
     OR NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.work_date IS DISTINCT FROM OLD.work_date
     OR NEW.labourer_id IS DISTINCT FROM OLD.labourer_id OR NEW.gang_id IS DISTINCT FROM OLD.gang_id
     OR NEW.bq_item_id IS DISTINCT FROM OLD.bq_item_id
     OR NEW.description IS DISTINCT FROM OLD.description OR NEW.unit IS DISTINCT FROM OLD.unit
     OR NEW.quantity IS DISTINCT FROM OLD.quantity OR NEW.rate_minor IS DISTINCT FROM OLD.rate_minor
     OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
     OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by
     OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at THEN
    RAISE EXCEPTION 'Output is decided once and never rewritten' USING ERRCODE = '23514';
  END IF;
  NEW.decided_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER piece_rate_output_guard BEFORE INSERT OR UPDATE ON "piece_rate_outputs"
  FOR EACH ROW EXECUTE FUNCTION app.guard_piece_rate_output();

-- At commit, an approved output's shares add up to its amount exactly (at least one share).
CREATE FUNCTION app.check_output_shares() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  total numeric;
  shares integer;
BEGIN
  SELECT COALESCE(sum(amount_minor), 0), count(*) INTO total, shares
  FROM piece_rate_output_shares
  WHERE tenant_id = NEW.tenant_id AND output_id = NEW.id;
  IF shares = 0 OR total <> NEW.amount_minor THEN
    RAISE EXCEPTION 'An approved output''s shares must add up to its amount'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER piece_rate_output_shares_total AFTER UPDATE ON "piece_rate_outputs"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.status = 'approved')
  EXECUTE FUNCTION app.check_output_shares();

ALTER TABLE "piece_rate_output_shares" ADD CONSTRAINT "piece_rate_output_shares_check"
  CHECK (amount_minor >= 0);
-- Shares are written in the approval transaction, for labourers engaged on the project that day
-- (the output's own labourer, or the gang's members).
CREATE FUNCTION app.guard_output_share() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  output record;
BEGIN
  SELECT status, work_date, labourer_id, gang_id INTO output FROM piece_rate_outputs
  WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id AND id = NEW.output_id;
  IF output.status IS DISTINCT FROM 'approved' OR NEW.work_date <> output.work_date THEN
    RAISE EXCEPTION 'Shares belong to an approved output and its date' USING ERRCODE = '23514';
  END IF;
  IF output.labourer_id IS NOT NULL AND output.labourer_id <> NEW.labourer_id THEN
    RAISE EXCEPTION 'An individual output has one share, for its labourer' USING ERRCODE = '23514';
  END IF;
  IF output.gang_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM gang_memberships m
    WHERE m.tenant_id = NEW.tenant_id AND m.gang_id = output.gang_id
      AND m.labourer_id = NEW.labourer_id AND m.joined_on <= output.work_date
      AND (m.left_on IS NULL OR m.left_on >= output.work_date)
  ) THEN
    RAISE EXCEPTION 'The labourer was not in the gang that day' USING ERRCODE = '23514';
  END IF;
  IF NOT app.is_engaged(NEW.tenant_id, NEW.labourer_id, NEW.project_id, NEW.work_date) THEN
    RAISE EXCEPTION 'The labourer is not engaged on the project that day' USING ERRCODE = '23514';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER output_share_guard BEFORE INSERT ON "piece_rate_output_shares"
  FOR EACH ROW EXECUTE FUNCTION app.guard_output_share();

-- Salary advances ---------------------------------------------------------------------------------
ALTER TABLE "salary_advances" ADD CONSTRAINT "salary_advances_check" CHECK (
  amount_minor > 0
  AND (instalment_minor IS NULL OR (instalment_minor > 0 AND instalment_minor <= amount_minor))
  AND (max_recovery_percent IS NULL OR max_recovery_percent BETWEEN 1 AND 100)
  AND status IN ('requested', 'approved', 'rejected', 'cancelled', 'disbursed') AND version >= 1
  AND char_length(btrim(reason)) BETWEEN 10 AND 500
  AND (disbursement_method IS NULL
    OR disbursement_method IN ('cash', 'mpesa_outside', 'bank_outside'))
  AND (decision_note IS NULL OR char_length(btrim(decision_note)) BETWEEN 1 AND 500)
  AND (cancellation_reason IS NULL OR char_length(btrim(cancellation_reason)) BETWEEN 10 AND 500)
);
-- Maker ≠ checker by identity: the requester neither approves nor records the payment.
ALTER TABLE "salary_advances" ADD CONSTRAINT "salary_advances_maker_checker_check" CHECK (
  (decided_by IS NULL OR decided_by <> requested_by)
  AND (disbursed_by IS NULL OR disbursed_by <> requested_by)
);
ALTER TABLE "salary_advances" ADD CONSTRAINT "salary_advances_state_check" CHECK (
  (status = 'requested' AND decided_by IS NULL AND decided_at IS NULL AND disbursed_by IS NULL
    AND cancelled_by IS NULL)
  OR (status = 'approved' AND decided_by IS NOT NULL AND decided_at IS NOT NULL
    AND disbursed_by IS NULL AND cancelled_by IS NULL)
  OR (status = 'rejected' AND decided_by IS NOT NULL AND decided_at IS NOT NULL
    AND decision_note IS NOT NULL AND char_length(btrim(decision_note)) >= 10
    AND disbursed_by IS NULL AND cancelled_by IS NULL)
  OR (status = 'disbursed' AND decided_by IS NOT NULL AND disbursement_method IS NOT NULL
    AND disbursement_reference IS NOT NULL AND paid_on IS NOT NULL AND evidence_note IS NOT NULL
    AND disbursed_by IS NOT NULL AND disbursed_at IS NOT NULL AND cancelled_by IS NULL)
  OR (status = 'cancelled' AND cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL
    AND cancellation_reason IS NOT NULL AND disbursed_by IS NULL)
);
-- requested → approved | rejected | cancelled; approved → disbursed | cancelled. The amount, terms
-- and requester never change; timestamps come from the database clock.
CREATE FUNCTION app.guard_salary_advance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'requested' THEN
      RAISE EXCEPTION 'An advance starts requested' USING ERRCODE = '23514';
    END IF;
    IF NOT app.is_engaged(NEW.tenant_id, NEW.labourer_id, NEW.project_id, app.nairobi_today()) THEN
      RAISE EXCEPTION 'The labourer is not engaged on the project' USING ERRCODE = '23514';
    END IF;
    NEW.requested_at := now();
    RETURN NEW;
  END IF;
  IF NEW.version <> OLD.version + 1
     OR NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.labourer_id IS DISTINCT FROM OLD.labourer_id
     OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.instalment_minor IS DISTINCT FROM OLD.instalment_minor
     OR NEW.max_recovery_percent IS DISTINCT FROM OLD.max_recovery_percent
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    RAISE EXCEPTION 'An advance''s amount and terms never change' USING ERRCODE = '23514';
  END IF;
  IF NOT (
    (OLD.status = 'requested' AND NEW.status IN ('approved', 'rejected', 'cancelled'))
    OR (OLD.status = 'approved' AND NEW.status IN ('disbursed', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'Invalid advance transition' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('approved', 'rejected') THEN
    NEW.decided_at := now();
  ELSIF NEW.status = 'disbursed' THEN
    IF NEW.decided_by IS DISTINCT FROM OLD.decided_by OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
       OR NEW.paid_on > app.nairobi_today() THEN
      RAISE EXCEPTION 'A payment is recorded for an approved advance, on or before today'
        USING ERRCODE = '23514';
    END IF;
    NEW.disbursed_at := now();
  ELSE
    NEW.cancelled_at := now();
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER salary_advance_guard BEFORE INSERT OR UPDATE ON "salary_advances"
  FOR EACH ROW EXECUTE FUNCTION app.guard_salary_advance();

-- Batches -----------------------------------------------------------------------------------------
ALTER TABLE "payroll_batches" ADD CONSTRAINT "payroll_batches_check" CHECK (
  frequency IN ('daily', 'weekly', 'fortnightly', 'monthly')
  AND status IN ('draft', 'submitted', 'cancelled') AND version >= 1
  AND period_end >= period_start AND period_end - period_start <= 31
  AND pay_date >= period_end AND statutory_month = to_char(pay_date, 'YYYY-MM')
  AND digest ~ '^[0-9a-f]{64}$' AND line_count >= 0
  AND jsonb_typeof(totals) = 'object' AND jsonb_typeof(exclusions) = 'array'
  AND (cancellation_reason IS NULL OR char_length(btrim(cancellation_reason)) BETWEEN 10 AND 500)
  AND net_minor >= 0
);
ALTER TABLE "payroll_batches" ADD CONSTRAINT "payroll_batches_state_check" CHECK (
  (status = 'draft' AND active_marker = 'active' AND submitted_by IS NULL
    AND submitted_at IS NULL AND cancelled_by IS NULL)
  OR (status = 'submitted' AND active_marker = 'active' AND submitted_by IS NOT NULL
    AND submitted_at IS NOT NULL AND cancelled_by IS NULL)
  OR (status = 'cancelled' AND active_marker IS NULL AND cancelled_by IS NOT NULL
    AND cancelled_at IS NOT NULL AND cancellation_reason IS NOT NULL)
);
-- Explicit states (WORKFLOWS "Payroll", D4.1 part): draft (recalculated freely) → submitted (the
-- frozen snapshot: nothing but cancellation changes it) or cancelled; submitted → cancelled. Live
-- batches of a project never overlap (the project row lock serialises creation).
CREATE FUNCTION app.guard_payroll_batch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.active_marker IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'A batch starts as a draft' USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM projects WHERE tenant_id = NEW.tenant_id AND id = NEW.project_id
      FOR NO KEY UPDATE;
    IF EXISTS (
      SELECT 1 FROM payroll_batches b
      WHERE b.tenant_id = NEW.tenant_id AND b.project_id = NEW.project_id
        AND b.active_marker = 'active'
        AND b.period_start <= NEW.period_end AND b.period_end >= NEW.period_start
    ) THEN
      RAISE EXCEPTION 'Payroll batches of a project cannot overlap' USING ERRCODE = '23514';
    END IF;
    NEW.created_at := now();
    NEW.calculated_at := now();
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.period_start IS DISTINCT FROM OLD.period_start
     OR NEW.period_end IS DISTINCT FROM OLD.period_end OR NEW.pay_date IS DISTINCT FROM OLD.pay_date
     OR NEW.statutory_month IS DISTINCT FROM OLD.statutory_month
     OR NEW.frequency IS DISTINCT FROM OLD.frequency
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'A batch keeps its identity and period' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'A cancelled batch is final' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'submitted' AND NEW.status <> 'cancelled' THEN
    RAISE EXCEPTION 'A submitted batch is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('submitted', 'cancelled') AND (
       NEW.unverified_rules IS DISTINCT FROM OLD.unverified_rules
       OR NEW.line_count IS DISTINCT FROM OLD.line_count
       OR NEW.gross_minor IS DISTINCT FROM OLD.gross_minor
       OR NEW.total_deductions_minor IS DISTINCT FROM OLD.total_deductions_minor
       OR NEW.net_minor IS DISTINCT FROM OLD.net_minor
       OR NEW.employer_cost_minor IS DISTINCT FROM OLD.employer_cost_minor
       OR NEW.totals IS DISTINCT FROM OLD.totals OR NEW.exclusions IS DISTINCT FROM OLD.exclusions
       OR NEW.rule_version_ids IS DISTINCT FROM OLD.rule_version_ids
       OR NEW.timesheet_rule_ids IS DISTINCT FROM OLD.timesheet_rule_ids
       OR NEW.mtd_batch_ids IS DISTINCT FROM OLD.mtd_batch_ids
       OR NEW.digest IS DISTINCT FROM OLD.digest
       OR NEW.calculated_by IS DISTINCT FROM OLD.calculated_by
       OR NEW.calculated_at IS DISTINCT FROM OLD.calculated_at) THEN
    RAISE EXCEPTION 'Submission and cancellation freeze the last calculation'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'submitted' AND (
       NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
       OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at) THEN
    RAISE EXCEPTION 'A submission is never rewritten' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'draft' THEN
    NEW.calculated_at := now();
  ELSIF NEW.status = 'submitted' AND OLD.status = 'draft' THEN
    NEW.submitted_at := now();
  ELSIF NEW.status = 'cancelled' THEN
    NEW.active_marker := NULL;
    NEW.cancelled_at := now();
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER payroll_batch_guard BEFORE INSERT OR UPDATE ON "payroll_batches"
  FOR EACH ROW EXECUTE FUNCTION app.guard_payroll_batch();

-- Lines and their components ----------------------------------------------------------------------
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_check" CHECK (
  engagement_type IN ('casual', 'term', 'piece_rate') AND rate_basis IN ('daily', 'hourly')
  AND gross_minor >= 0 AND net_minor >= 0 AND advance_recovery_minor >= 0
  AND other_deductions_minor >= 0 AND days_worked >= 0
  AND net_minor = gross_minor - statutory_withheld_minor - advance_recovery_minor
    - other_deductions_minor
  AND jsonb_typeof(month_to_date) = 'object' AND jsonb_typeof(warnings) = 'array'
  AND (payee_phone_bidx IS NULL OR payee_phone_bidx ~ '^[0-9a-f]{64}$')
);
ALTER TABLE "payroll_earnings" ADD CONSTRAINT "payroll_earnings_check" CHECK (
  kind IN ('attendance', 'overtime', 'piece_rate', 'allowance')
  AND (category IS NULL OR category IN ('weekday', 'rest_day', 'public_holiday'))
  AND position >= 0 AND char_length(unit) >= 1 AND char_length(description) >= 1
  AND (kind NOT IN ('attendance', 'overtime') OR (labour_rate_id IS NOT NULL
    AND timesheet_rule_id IS NOT NULL AND timesheet_line_id IS NOT NULL AND work_date IS NOT NULL))
  AND (kind <> 'overtime' OR (multiplier IS NOT NULL AND category IS NOT NULL))
  AND (kind <> 'piece_rate' OR share_id IS NOT NULL)
  AND (kind <> 'allowance' OR allowance_id IS NOT NULL)
);
ALTER TABLE "payroll_deductions" ADD CONSTRAINT "payroll_deductions_check" CHECK (
  (party = 'employee' AND kind IN ('nssf', 'shif', 'ahl', 'paye')
    AND shortfall_minor = due_minor - withheld_minor AND shortfall_minor >= 0)
  OR (party = 'employer' AND kind IN ('nssf_employer', 'ahl_employer', 'nita')
    AND withheld_minor = due_minor AND shortfall_minor = 0)
);
ALTER TABLE "advance_recoveries" ADD CONSTRAINT "advance_recoveries_check"
  CHECK (amount_minor > 0 AND outstanding_after_minor >= 0);

-- Lines, components and recoveries are written and removed only while their batch is a draft
-- (recalculation); a submitted batch's snapshot never changes. They are never updated.
CREATE FUNCTION app.guard_payroll_child() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  row_tenant uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
  row_batch uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.batch_id ELSE NEW.batch_id END;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Payroll lines are never updated' USING ERRCODE = '23514';
  END IF;
  IF app.payroll_batch_status(row_tenant, row_batch) IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Only a draft batch''s lines change' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER payroll_line_guard BEFORE INSERT OR UPDATE OR DELETE ON "payroll_lines"
  FOR EACH ROW EXECUTE FUNCTION app.guard_payroll_child();
CREATE TRIGGER payroll_earning_guard BEFORE INSERT OR UPDATE OR DELETE ON "payroll_earnings"
  FOR EACH ROW EXECUTE FUNCTION app.guard_payroll_child();
CREATE TRIGGER payroll_deduction_guard BEFORE INSERT OR UPDATE OR DELETE ON "payroll_deductions"
  FOR EACH ROW EXECUTE FUNCTION app.guard_payroll_child();
CREATE TRIGGER advance_recovery_guard BEFORE INSERT OR UPDATE OR DELETE ON "advance_recoveries"
  FOR EACH ROW EXECUTE FUNCTION app.guard_payroll_child();

-- A line belongs to its batch's statutory month.
CREATE FUNCTION app.guard_payroll_line_month() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM payroll_batches b
    WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id
      AND b.statutory_month = NEW.statutory_month
  ) THEN
    RAISE EXCEPTION 'A line belongs to its batch''s statutory month' USING ERRCODE = '23514';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER payroll_line_month BEFORE INSERT ON "payroll_lines"
  FOR EACH ROW EXECUTE FUNCTION app.guard_payroll_line_month();

-- Recovery only from a disbursed advance of the same project, and never more than its amount over
-- every non-cancelled batch (the advance row lock serialises competing batches).
CREATE FUNCTION app.guard_advance_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  advance record;
  recovered numeric;
BEGIN
  SELECT a.status, a.amount_minor, a.project_id INTO advance FROM salary_advances a
  WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.advance_id
  FOR UPDATE;
  IF advance.status IS DISTINCT FROM 'disbursed' THEN
    RAISE EXCEPTION 'Only a disbursed advance is recovered' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM payroll_batches b
    WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id AND b.project_id = advance.project_id
  ) THEN
    RAISE EXCEPTION 'An advance is recovered on its own project' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(sum(r.amount_minor), 0) INTO recovered
  FROM advance_recoveries r
  JOIN payroll_batches b ON b.tenant_id = r.tenant_id AND b.id = r.batch_id
  WHERE r.tenant_id = NEW.tenant_id AND r.advance_id = NEW.advance_id AND b.status <> 'cancelled';
  IF recovered + NEW.amount_minor > advance.amount_minor THEN
    RAISE EXCEPTION 'An advance is never over-recovered' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER advance_recovery_limit BEFORE INSERT ON "advance_recoveries"
  FOR EACH ROW EXECUTE FUNCTION app.guard_advance_recovery();

-- Consumption and day claims ----------------------------------------------------------------------
ALTER TABLE "payroll_consumptions" ADD CONSTRAINT "payroll_consumptions_check" CHECK (
  (source_kind = 'timesheet_line' AND timesheet_line_id IS NOT NULL AND share_id IS NULL)
  OR (source_kind = 'piece_rate_share' AND share_id IS NOT NULL AND timesheet_line_id IS NULL)
);
ALTER TABLE "payroll_consumptions" ADD CONSTRAINT "payroll_consumptions_marker_check"
  CHECK (active_marker IS NULL OR active_marker = 'active');
ALTER TABLE "payroll_day_claims" ADD CONSTRAINT "payroll_day_claims_check" CHECK (
  basis IN ('attendance', 'piece_rate') AND (active_marker IS NULL OR active_marker = 'active')
);

-- A draft consumes approved timesheet lines and approved output shares of its own project that end
-- by its period end; each source is consumed by at most one live batch (unique while active). A
-- consumption is released (marker NULL) only when its batch is cancelled; drafts may delete theirs.
CREATE FUNCTION app.guard_payroll_consumption() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  row_tenant uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
  row_batch uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.batch_id ELSE NEW.batch_id END;
  batch_status text := app.payroll_batch_status(row_tenant, row_batch);
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF batch_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'Only a draft batch''s sources change' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF batch_status IS DISTINCT FROM 'cancelled' OR OLD.active_marker IS NULL
       OR NEW.active_marker IS NOT NULL OR NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
       OR NEW.project_id IS DISTINCT FROM OLD.project_id
       OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
       OR NEW.timesheet_line_id IS DISTINCT FROM OLD.timesheet_line_id
       OR NEW.share_id IS DISTINCT FROM OLD.share_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'A source is released only by cancelling its batch' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF batch_status IS DISTINCT FROM 'draft' OR NEW.active_marker IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'Only a draft batch consumes sources' USING ERRCODE = '23514';
  END IF;
  IF NEW.timesheet_line_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM timesheet_lines l
    JOIN timesheet_periods p ON p.tenant_id = l.tenant_id AND p.id = l.period_id
    JOIN payroll_batches b ON b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id
    WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.timesheet_line_id
      AND l.project_id = NEW.project_id AND p.status = 'approved' AND p.end_date <= b.period_end
  ) THEN
    RAISE EXCEPTION 'Only approved timesheet lines of the project are paid' USING ERRCODE = '23514';
  END IF;
  IF NEW.share_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM piece_rate_output_shares s
    JOIN piece_rate_outputs o ON o.tenant_id = s.tenant_id AND o.id = s.output_id
    JOIN payroll_batches b ON b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id
    WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.share_id AND s.project_id = NEW.project_id
      AND o.status = 'approved' AND s.work_date <= b.period_end
  ) THEN
    RAISE EXCEPTION 'Only approved output of the project is paid' USING ERRCODE = '23514';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER payroll_consumption_guard BEFORE INSERT OR UPDATE OR DELETE ON "payroll_consumptions"
  FOR EACH ROW EXECUTE FUNCTION app.guard_payroll_consumption();

-- Attendance and piece rate never pay the same labourer-day (brief §5.6, §15 C): an active claim of
-- the other basis for the same labourer and date is refused, company-wide. The labourer row lock
-- serialises competing batches.
CREATE FUNCTION app.guard_payroll_day_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  row_tenant uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
  row_batch uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.batch_id ELSE NEW.batch_id END;
  batch_status text := app.payroll_batch_status(row_tenant, row_batch);
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF batch_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'Only a draft batch''s day claims change' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF batch_status IS DISTINCT FROM 'cancelled' OR OLD.active_marker IS NULL
       OR NEW.active_marker IS NOT NULL OR NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
       OR NEW.project_id IS DISTINCT FROM OLD.project_id
       OR NEW.labourer_id IS DISTINCT FROM OLD.labourer_id
       OR NEW.work_date IS DISTINCT FROM OLD.work_date OR NEW.basis IS DISTINCT FROM OLD.basis THEN
      RAISE EXCEPTION 'A day claim is released only by cancelling its batch' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF batch_status IS DISTINCT FROM 'draft' OR NEW.active_marker IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'Only a draft batch claims days' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM labourers WHERE tenant_id = NEW.tenant_id AND id = NEW.labourer_id
    FOR NO KEY UPDATE;
  IF EXISTS (
    SELECT 1 FROM payroll_day_claims c
    WHERE c.tenant_id = NEW.tenant_id AND c.labourer_id = NEW.labourer_id
      AND c.work_date = NEW.work_date AND c.active_marker = 'active' AND c.basis <> NEW.basis
  ) THEN
    RAISE EXCEPTION 'Attendance and piece rate cannot both pay one labourer-day'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER payroll_day_claim_guard BEFORE INSERT OR UPDATE OR DELETE ON "payroll_day_claims"
  FOR EACH ROW EXECUTE FUNCTION app.guard_payroll_day_claim();

-- Opening rates -----------------------------------------------------------------------------------
-- Payroll prices each day with the rate in force that day, so work recorded before any rate of a
-- kind existed could never be paid (D3.1 refused every backdated rate). The first rate of a scope
-- (an opening rate) may now start in the past, but never on or before the end of submitted payroll
-- it could reach; later rates still start today or later, and rates are still never changed.
CREATE OR REPLACE FUNCTION app.guard_labour_rate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.scope_key := concat_ws('|',
      COALESCE(NEW.project_id::text, '-'), COALESCE(NEW.labourer_id::text, '-'),
      COALESCE(NEW.trade_id::text, '-'), COALESCE(NEW.skill_level_id::text, '-'), NEW.basis);
    IF NEW.effective_from < (now() AT TIME ZONE 'Africa/Nairobi')::date THEN
      IF EXISTS (
        SELECT 1 FROM labour_rates r
        WHERE r.tenant_id = NEW.tenant_id AND r.scope_key = NEW.scope_key
      ) THEN
        RAISE EXCEPTION 'A new rate cannot start before today' USING ERRCODE = '23514';
      END IF;
      IF EXISTS (
        SELECT 1 FROM payroll_batches b
        WHERE b.tenant_id = NEW.tenant_id AND b.status = 'submitted'
          AND b.period_end >= NEW.effective_from
          AND (NEW.project_id IS NULL OR b.project_id = NEW.project_id)
      ) THEN
        RAISE EXCEPTION 'An opening rate cannot reach into submitted payroll' USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 OR OLD.effective_from > (now() AT TIME ZONE 'Africa/Nairobi')::date THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'A rate that has come into force cannot be deleted' USING ERRCODE = '42501';
  END IF;
  RAISE EXCEPTION 'Rates are never changed in place; add a new effective-dated rate'
    USING ERRCODE = '42501';
END
$$;

-- Permissions -------------------------------------------------------------------------------------
-- The catalogue gains payroll.view, payroll.manage_rules, payroll.verify_rules, payroll.export,
-- advances.request and advances.approve (packages/types PERMISSIONS); project assignments gain the
-- project-scoped ones. Existing rows keep their values; both constraints only widen.
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
    'payroll.view', 'payroll.prepare', 'payroll.review', 'payroll.approve',
    'payroll.manage_rules', 'payroll.verify_rules', 'payroll.export', 'advances.request',
    'advances.approve', 'payments.view', 'payments.approve',
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
    'timesheets.submit', 'timesheets.approve', 'timesheets.manage_rules', 'payroll.view',
    'payroll.prepare', 'payroll.review', 'advances.request', 'advances.approve',
    'procurement.requisition', 'procurement.approve', 'stores.manage',
    'finance.view', 'site.diary', 'site.photos', 'quality.manage', 'safety.manage',
    'plant.manage', 'documents.manage', 'reports.view'
  ]::text[]
);
-- MFA-required permissions only grow (CONFIGURATION auth.mfa.required_permissions): statutory rule
-- verification and statutory exports join (both also need step-up when used). Only the owner and
-- finance system roles hold them, so app.system_role_requires_mfa is unchanged.
CREATE OR REPLACE FUNCTION app.permissions_require_mfa(permissions text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT COALESCE(permissions && ARRAY[
    'payroll.approve', 'payroll.verify_rules', 'payroll.export', 'payments.approve',
    'payments.disburse', 'payments.reverse', 'finance.manage', 'config.manage_statutory',
    'roles.manage', 'tenancy.manage', 'platform.admin'
  ]::text[], false) $$;

-- Row-level security ------------------------------------------------------------------------------
ALTER TABLE "payroll_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payroll_settings" FORCE ROW LEVEL SECURITY;
ALTER TABLE "pay_calendars" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pay_calendars" FORCE ROW LEVEL SECURITY;
ALTER TABLE "statutory_rule_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "statutory_rule_versions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "minimum_wage_rates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "minimum_wage_rates" FORCE ROW LEVEL SECURITY;
ALTER TABLE "payroll_allowances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payroll_allowances" FORCE ROW LEVEL SECURITY;
ALTER TABLE "piece_rate_outputs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "piece_rate_outputs" FORCE ROW LEVEL SECURITY;
ALTER TABLE "piece_rate_output_shares" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "piece_rate_output_shares" FORCE ROW LEVEL SECURITY;
ALTER TABLE "salary_advances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "salary_advances" FORCE ROW LEVEL SECURITY;
ALTER TABLE "payroll_batches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payroll_batches" FORCE ROW LEVEL SECURITY;
ALTER TABLE "payroll_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payroll_lines" FORCE ROW LEVEL SECURITY;
ALTER TABLE "payroll_earnings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payroll_earnings" FORCE ROW LEVEL SECURITY;
ALTER TABLE "payroll_deductions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payroll_deductions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "advance_recoveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "advance_recoveries" FORCE ROW LEVEL SECURITY;
ALTER TABLE "payroll_consumptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payroll_consumptions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "payroll_day_claims" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payroll_day_claims" FORCE ROW LEVEL SECURITY;

CREATE POLICY payroll_settings_isolation ON payroll_settings
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND updated_by = app.current_user_id());
CREATE POLICY pay_calendars_isolation ON pay_calendars
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND updated_by = app.current_user_id());
CREATE POLICY statutory_rule_versions_read ON statutory_rule_versions FOR SELECT
  USING (tenant_id = app.current_tenant_id());
CREATE POLICY statutory_rule_versions_insert ON statutory_rule_versions FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id() AND created_by = app.current_user_id());
CREATE POLICY statutory_rule_versions_verify ON statutory_rule_versions FOR UPDATE
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND verified_by = app.current_user_id());
CREATE POLICY statutory_rule_versions_remove ON statutory_rule_versions FOR DELETE
  USING (tenant_id = app.current_tenant_id());
CREATE POLICY minimum_wage_rates_read ON minimum_wage_rates FOR SELECT
  USING (tenant_id = app.current_tenant_id());
CREATE POLICY minimum_wage_rates_insert ON minimum_wage_rates FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id() AND created_by = app.current_user_id());
CREATE POLICY payroll_allowances_read ON payroll_allowances FOR SELECT
  USING (tenant_id = app.current_tenant_id());
CREATE POLICY payroll_allowances_insert ON payroll_allowances FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id() AND created_by = app.current_user_id());
CREATE POLICY payroll_allowances_end ON payroll_allowances FOR UPDATE
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND ended_by = app.current_user_id());
CREATE POLICY piece_rate_outputs_read ON piece_rate_outputs FOR SELECT
  USING (tenant_id = app.current_tenant_id());
CREATE POLICY piece_rate_outputs_insert ON piece_rate_outputs FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id() AND recorded_by = app.current_user_id());
CREATE POLICY piece_rate_outputs_decide ON piece_rate_outputs FOR UPDATE
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND decided_by = app.current_user_id());
CREATE POLICY piece_rate_output_shares_read ON piece_rate_output_shares FOR SELECT
  USING (tenant_id = app.current_tenant_id());
CREATE POLICY piece_rate_output_shares_insert ON piece_rate_output_shares FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY salary_advances_read ON salary_advances FOR SELECT
  USING (tenant_id = app.current_tenant_id());
CREATE POLICY salary_advances_insert ON salary_advances FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id() AND requested_by = app.current_user_id());
CREATE POLICY salary_advances_update ON salary_advances FOR UPDATE
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY payroll_batches_isolation ON payroll_batches
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY payroll_lines_isolation ON payroll_lines
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY payroll_earnings_isolation ON payroll_earnings
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY payroll_deductions_isolation ON payroll_deductions
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY advance_recoveries_isolation ON advance_recoveries
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY payroll_consumptions_isolation ON payroll_consumptions
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY payroll_day_claims_isolation ON payroll_day_claims
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

-- Runtime role: minimum wages, output shares and every line component are insert-only (drafts may
-- delete theirs while recalculating); settings, calendars, rules history, allowances, outputs,
-- advances and batches are never deleted (only unverified, unused rule versions are). No TRUNCATE,
-- REFERENCES or TRIGGER on any new table.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmb_app') THEN
    REVOKE UPDATE ON "minimum_wage_rates", "piece_rate_output_shares", "payroll_lines",
      "payroll_earnings", "payroll_deductions", "advance_recoveries" FROM pmb_app;
    REVOKE DELETE ON "payroll_settings", "pay_calendars", "minimum_wage_rates",
      "payroll_allowances", "piece_rate_outputs", "piece_rate_output_shares", "salary_advances",
      "payroll_batches" FROM pmb_app;
    REVOKE TRUNCATE, REFERENCES, TRIGGER ON "payroll_settings", "pay_calendars",
      "statutory_rule_versions", "minimum_wage_rates", "payroll_allowances", "piece_rate_outputs",
      "piece_rate_output_shares", "salary_advances", "payroll_batches", "payroll_lines",
      "payroll_earnings", "payroll_deductions", "advance_recoveries", "payroll_consumptions",
      "payroll_day_claims" FROM pmb_app;
  END IF;
END
$$;
REVOKE EXECUTE ON FUNCTION app.touch_payroll_config() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_statutory_rule() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_payroll_allowance() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_piece_rate_output() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_output_shares() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_output_share() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_salary_advance() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_payroll_batch() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_payroll_child() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_payroll_line_month() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_advance_recovery() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_payroll_consumption() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_payroll_day_claim() FROM PUBLIC;

COMMIT;
