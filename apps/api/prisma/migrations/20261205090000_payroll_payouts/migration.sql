-- D4.3 Approvals and payouts (ARCHITECTURE §4.19; WORKFLOWS "Payroll" and "Payment attempts";
-- THREAT_MODEL A-01, A-04, A-05, A-08, A-12, A-16, A-17, A-22, OR-04 … OR-06; owner decisions of
-- 16 Nov 2026 and D-167):
-- * payroll_batches gain review, rejection, reopening and approval (with the approval digest, the
--   applied limit and the segregation-waiver mark) and, after approval, a derived settlement status
--   (approved → disbursing → partially_settled → settled); `contributors` (who created, calculated,
--   submitted or reopened) is kept by the guard trigger, which also enforces every transition and
--   repeats maker-checker; payroll_batch_decisions is the append-only decision log with an action
--   hash checked by the database;
-- * payroll_obligations (whole shillings of each approved line's net) and payroll_carry_forwards
--   (its cents, D-167), brought forward by a later batch line through payroll_consumptions (a third
--   one-time source; payroll_lines.brought_forward_minor);
-- * payroll_payouts (M-Pesa through a D4.2 payment request, or recorded cash/bank confirmed by a
--   second person; one live payout per obligation), payroll_payout_evidence, payroll_allocations
--   (paid amount and status of an obligation are derived from them; never beyond the amount),
--   payroll_payout_flags (unusual payouts), labourer verifications, holds and change-hold
--   overrides; labourers gain phone_changed_at/by (trigger) and preferred_language;
-- * payout_settings (with the OR-04 waiver), payroll_approval_limits, payment_tariff_versions
--   (DEMO bands seeded for every company), payroll_notifications (durable outbox; recipients
--   sealed);
-- * cost_entries gain the payroll_line and payroll_payout sources (accrued labour at approval,
--   paid labour as payouts settle, reversals, M-Pesa charges as fees) with "post once" indexes.
-- Every new table has tenant_id, composite (tenant_id, …) foreign keys, forced RLS with WITH CHECK
-- and the restrictive staff-only policy of the payments tables; pmb_app holds no DELETE (approval
-- limits aside) and no UPDATE on the append-only tables. No permission was added.
BEGIN;

-- AlterTable
ALTER TABLE "cost_entries" ADD COLUMN     "payroll_line_id" UUID,
ADD COLUMN     "payroll_payout_id" UUID;

-- AlterTable
ALTER TABLE "labourers" ADD COLUMN     "phone_changed_at" TIMESTAMPTZ,
ADD COLUMN     "phone_changed_by" UUID,
ADD COLUMN     "preferred_language" VARCHAR(2) NOT NULL DEFAULT 'sw';

-- AlterTable
ALTER TABLE "payroll_batches" ADD COLUMN     "approval_digest" CHAR(64),
ADD COLUMN     "approval_limit_minor" BIGINT,
ADD COLUMN     "approval_note" VARCHAR(500),
ADD COLUMN     "approved_at" TIMESTAMPTZ,
ADD COLUMN     "approved_by" UUID,
ADD COLUMN     "approved_under_waiver" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "contributors" UUID[] DEFAULT ARRAY[]::UUID[],
ADD COLUMN     "rejected_at" TIMESTAMPTZ,
ADD COLUMN     "rejected_by" UUID,
ADD COLUMN     "rejection_reason" VARCHAR(500),
ADD COLUMN     "reopened_at" TIMESTAMPTZ,
ADD COLUMN     "reopened_by" UUID,
ADD COLUMN     "review_note" VARCHAR(500),
ADD COLUMN     "reviewed_at" TIMESTAMPTZ,
ADD COLUMN     "reviewed_by" UUID;

-- AlterTable
ALTER TABLE "payroll_consumptions" ADD COLUMN     "carry_forward_id" UUID;

-- AlterTable
ALTER TABLE "payroll_lines" ADD COLUMN     "brought_forward_minor" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "payroll_batch_decisions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "action" VARCHAR(30) NOT NULL,
    "actor_id" UUID NOT NULL,
    "batch_version" INTEGER NOT NULL,
    "digest" CHAR(64) NOT NULL,
    "approval_digest" CHAR(64),
    "net_minor" BIGINT NOT NULL,
    "applied_limit_minor" BIGINT,
    "under_waiver" BOOLEAN NOT NULL DEFAULT false,
    "step_up_at" TIMESTAMPTZ,
    "action_hash" CHAR(64) NOT NULL,
    "note" VARCHAR(500),
    "obligation_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_batch_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_obligations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "labourer_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "paid_minor" BIGINT NOT NULL DEFAULT 0,
    "status" VARCHAR(10) NOT NULL DEFAULT 'open',
    "channel" VARCHAR(10) NOT NULL,
    "manual_reason" VARCHAR(20),
    "destination_bidx" CHAR(64),
    "verification_id" UUID,
    "destination_approved_by" UUID NOT NULL,
    "destination_approved_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_obligations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_carry_forwards" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "labourer_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_carry_forwards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_payouts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "obligation_id" UUID NOT NULL,
    "labourer_id" UUID NOT NULL,
    "method" VARCHAR(10) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "status" VARCHAR(25) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "payment_request_id" UUID,
    "destination_bidx" CHAR(64),
    "receipt" VARCHAR(30),
    "result_code" VARCHAR(20),
    "result_desc" VARCHAR(300),
    "charge_minor" BIGINT,
    "tariff_version_id" UUID,
    "name_check" VARCHAR(12),
    "name_score" DECIMAL(4,3),
    "receiver_name_enc" BYTEA,
    "reference" VARCHAR(40),
    "paid_on" DATE,
    "reason" VARCHAR(500),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_by" UUID,
    "confirmed_at" TIMESTAMPTZ,
    "step_up_at" TIMESTAMPTZ,
    "rejected_by" UUID,
    "rejected_at" TIMESTAMPTZ,
    "rejection_reason" VARCHAR(500),
    "finished_at" TIMESTAMPTZ,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_payout_evidence" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "payout_id" UUID NOT NULL,
    "object_key" VARCHAR(300) NOT NULL,
    "content_type" VARCHAR(40) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "scan_status" VARCHAR(15) NOT NULL,
    "scan_engine" VARCHAR(40) NOT NULL,
    "scanned_at" TIMESTAMPTZ NOT NULL,
    "uploaded_by" UUID NOT NULL,
    "uploaded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_payout_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_allocations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "obligation_id" UUID NOT NULL,
    "payout_id" UUID NOT NULL,
    "kind" VARCHAR(10) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "reference" VARCHAR(40),
    "reverses_allocation_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_payout_flags" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "obligation_id" UUID NOT NULL,
    "code" VARCHAR(30) NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "status" VARCHAR(10) NOT NULL DEFAULT 'open',
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cleared_by" UUID,
    "cleared_at" TIMESTAMPTZ,
    "clear_reason" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "payroll_payout_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "labourer_payout_verifications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "labourer_id" UUID NOT NULL,
    "phone_bidx" CHAR(64) NOT NULL,
    "phone_masked" VARCHAR(20),
    "method" VARCHAR(30) NOT NULL,
    "note" VARCHAR(500),
    "verified_by" UUID NOT NULL,
    "verified_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "labourer_payout_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "labourer_payout_holds" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "labourer_id" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "phone_bidx" CHAR(64),
    "phone_masked" VARCHAR(20),
    "reason" VARCHAR(500) NOT NULL,
    "payout_id" UUID,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_by" UUID,
    "released_at" TIMESTAMPTZ,
    "release_reason" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "labourer_payout_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "labourer_change_hold_overrides" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "labourer_id" UUID NOT NULL,
    "phone_changed_at" TIMESTAMPTZ NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "labourer_change_hold_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_settings" (
    "tenant_id" UUID NOT NULL,
    "cash_max_per_worker_period_minor" BIGINT NOT NULL DEFAULT 2000000,
    "name_match_threshold" DECIMAL(3,2) NOT NULL DEFAULT 0.80,
    "name_mismatch_hold" BOOLEAN NOT NULL DEFAULT true,
    "payee_change_hold_hours" INTEGER NOT NULL DEFAULT 24,
    "unusual_new_recipient_minor" BIGINT NOT NULL DEFAULT 5000000,
    "business_hours_start" CHAR(5) NOT NULL DEFAULT '06:00',
    "business_hours_end" CHAR(5) NOT NULL DEFAULT '20:00',
    "float_check_max_age_minutes" INTEGER NOT NULL DEFAULT 15,
    "waiver_enabled" BOOLEAN NOT NULL DEFAULT false,
    "waiver_reason" VARCHAR(500),
    "waiver_limit_minor" BIGINT NOT NULL DEFAULT 50000000,
    "waiver_changed_by" UUID,
    "waiver_changed_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ,
    "limits_version" INTEGER NOT NULL DEFAULT 0,
    "limits_updated_by" UUID,
    "limits_updated_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payout_settings_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "payroll_approval_limits" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "system_role" VARCHAR(30),
    "custom_role_id" UUID,
    "max_batch_net_minor" BIGINT NOT NULL,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_approval_limits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_notifications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "subject_key" VARCHAR(120) NOT NULL,
    "batch_id" UUID,
    "obligation_id" UUID,
    "labourer_id" UUID,
    "user_id" UUID,
    "target" VARCHAR(12),
    "event_at" TIMESTAMPTZ,
    "channel" VARCHAR(10) NOT NULL,
    "recipient_enc" BYTEA NOT NULL,
    "recipient_key" CHAR(64) NOT NULL,
    "recipient_masked" VARCHAR(40) NOT NULL,
    "language" VARCHAR(2) NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "last_error_code" VARCHAR(30),
    "sent_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_tariff_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" VARCHAR(10) NOT NULL DEFAULT 'b2c',
    "effective_from" DATE NOT NULL,
    "status" VARCHAR(10) NOT NULL,
    "bands" JSONB NOT NULL,
    "source" VARCHAR(2000) NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_tariff_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payroll_batch_decisions_tenant_id_batch_id_created_at_idx" ON "payroll_batch_decisions"("tenant_id", "batch_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_batch_decisions_tenant_id_id_key" ON "payroll_batch_decisions"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "payroll_obligations_tenant_id_labourer_id_status_idx" ON "payroll_obligations"("tenant_id", "labourer_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_obligations_tenant_id_id_key" ON "payroll_obligations"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_obligations_tenant_id_batch_id_id_key" ON "payroll_obligations"("tenant_id", "batch_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_obligations_tenant_id_batch_id_line_id_key" ON "payroll_obligations"("tenant_id", "batch_id", "line_id");

-- CreateIndex
CREATE INDEX "payroll_carry_forwards_tenant_id_labourer_id_idx" ON "payroll_carry_forwards"("tenant_id", "labourer_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_carry_forwards_tenant_id_id_key" ON "payroll_carry_forwards"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_carry_forwards_tenant_id_batch_id_line_id_key" ON "payroll_carry_forwards"("tenant_id", "batch_id", "line_id");

-- CreateIndex
CREATE INDEX "payroll_payouts_tenant_id_batch_id_idx" ON "payroll_payouts"("tenant_id", "batch_id");

-- CreateIndex
CREATE INDEX "payroll_payouts_tenant_id_labourer_id_idx" ON "payroll_payouts"("tenant_id", "labourer_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_payouts_tenant_id_id_key" ON "payroll_payouts"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_payouts_tenant_id_project_id_id_key" ON "payroll_payouts"("tenant_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_payouts_tenant_id_obligation_id_id_key" ON "payroll_payouts"("tenant_id", "obligation_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_payouts_tenant_id_payment_request_id_key" ON "payroll_payouts"("tenant_id", "payment_request_id");

-- CreateIndex
CREATE INDEX "payroll_payout_evidence_tenant_id_payout_id_idx" ON "payroll_payout_evidence"("tenant_id", "payout_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_payout_evidence_tenant_id_id_key" ON "payroll_payout_evidence"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_payout_evidence_tenant_id_object_key_key" ON "payroll_payout_evidence"("tenant_id", "object_key");

-- CreateIndex
CREATE INDEX "payroll_allocations_tenant_id_obligation_id_idx" ON "payroll_allocations"("tenant_id", "obligation_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_allocations_tenant_id_id_key" ON "payroll_allocations"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_allocations_tenant_id_payout_id_kind_key" ON "payroll_allocations"("tenant_id", "payout_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_allocations_tenant_id_reverses_allocation_id_key" ON "payroll_allocations"("tenant_id", "reverses_allocation_id");

-- CreateIndex
CREATE INDEX "payroll_payout_flags_tenant_id_obligation_id_idx" ON "payroll_payout_flags"("tenant_id", "obligation_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_payout_flags_tenant_id_id_key" ON "payroll_payout_flags"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "labourer_payout_verifications_tenant_id_labourer_id_phone_b_idx" ON "labourer_payout_verifications"("tenant_id", "labourer_id", "phone_bidx");

-- CreateIndex
CREATE UNIQUE INDEX "labourer_payout_verifications_tenant_id_id_key" ON "labourer_payout_verifications"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "labourer_payout_holds_tenant_id_labourer_id_idx" ON "labourer_payout_holds"("tenant_id", "labourer_id");

-- CreateIndex
CREATE UNIQUE INDEX "labourer_payout_holds_tenant_id_id_key" ON "labourer_payout_holds"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "labourer_change_hold_overrides_tenant_id_id_key" ON "labourer_change_hold_overrides"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "labourer_change_hold_overrides_tenant_id_labourer_id_phone__key" ON "labourer_change_hold_overrides"("tenant_id", "labourer_id", "phone_changed_at");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_approval_limits_tenant_id_id_key" ON "payroll_approval_limits"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_approval_limits_tenant_id_system_role_key" ON "payroll_approval_limits"("tenant_id", "system_role");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_approval_limits_tenant_id_custom_role_id_key" ON "payroll_approval_limits"("tenant_id", "custom_role_id");

-- CreateIndex
CREATE INDEX "payroll_notifications_status_next_attempt_at_idx" ON "payroll_notifications"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "payroll_notifications_tenant_id_obligation_id_idx" ON "payroll_notifications"("tenant_id", "obligation_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_notifications_tenant_id_id_key" ON "payroll_notifications"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_notifications_tenant_id_kind_subject_key_recipient__key" ON "payroll_notifications"("tenant_id", "kind", "subject_key", "recipient_key");

-- CreateIndex
CREATE UNIQUE INDEX "payment_tariff_versions_tenant_id_id_key" ON "payment_tariff_versions"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_tariff_versions_tenant_id_kind_effective_from_key" ON "payment_tariff_versions"("tenant_id", "kind", "effective_from");

-- CreateIndex
CREATE INDEX "cost_entries_tenant_id_payroll_line_id_idx" ON "cost_entries"("tenant_id", "payroll_line_id");

-- CreateIndex
CREATE INDEX "cost_entries_tenant_id_payroll_payout_id_idx" ON "cost_entries"("tenant_id", "payroll_payout_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_consumptions_tenant_id_carry_forward_id_active_mark_key" ON "payroll_consumptions"("tenant_id", "carry_forward_id", "active_marker");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_lines_tenant_id_project_id_id_key" ON "payroll_lines"("tenant_id", "project_id", "id");

-- AddForeignKey
ALTER TABLE "payroll_consumptions" ADD CONSTRAINT "payroll_consumptions_tenant_id_carry_forward_id_fkey" FOREIGN KEY ("tenant_id", "carry_forward_id") REFERENCES "payroll_carry_forwards"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_batch_decisions" ADD CONSTRAINT "payroll_batch_decisions_tenant_id_project_id_batch_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "batch_id") REFERENCES "payroll_batches"("tenant_id", "project_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_batch_decisions" ADD CONSTRAINT "payroll_batch_decisions_tenant_id_obligation_id_fkey" FOREIGN KEY ("tenant_id", "obligation_id") REFERENCES "payroll_obligations"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_obligations" ADD CONSTRAINT "payroll_obligations_tenant_id_project_id_batch_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "batch_id") REFERENCES "payroll_batches"("tenant_id", "project_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_obligations" ADD CONSTRAINT "payroll_obligations_tenant_id_batch_id_line_id_fkey" FOREIGN KEY ("tenant_id", "batch_id", "line_id") REFERENCES "payroll_lines"("tenant_id", "batch_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_obligations" ADD CONSTRAINT "payroll_obligations_tenant_id_labourer_id_fkey" FOREIGN KEY ("tenant_id", "labourer_id") REFERENCES "labourers"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_obligations" ADD CONSTRAINT "payroll_obligations_tenant_id_verification_id_fkey" FOREIGN KEY ("tenant_id", "verification_id") REFERENCES "labourer_payout_verifications"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_carry_forwards" ADD CONSTRAINT "payroll_carry_forwards_tenant_id_project_id_batch_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "batch_id") REFERENCES "payroll_batches"("tenant_id", "project_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_carry_forwards" ADD CONSTRAINT "payroll_carry_forwards_tenant_id_batch_id_line_id_fkey" FOREIGN KEY ("tenant_id", "batch_id", "line_id") REFERENCES "payroll_lines"("tenant_id", "batch_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_carry_forwards" ADD CONSTRAINT "payroll_carry_forwards_tenant_id_labourer_id_fkey" FOREIGN KEY ("tenant_id", "labourer_id") REFERENCES "labourers"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_payouts" ADD CONSTRAINT "payroll_payouts_tenant_id_project_id_batch_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "batch_id") REFERENCES "payroll_batches"("tenant_id", "project_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_payouts" ADD CONSTRAINT "payroll_payouts_tenant_id_batch_id_obligation_id_fkey" FOREIGN KEY ("tenant_id", "batch_id", "obligation_id") REFERENCES "payroll_obligations"("tenant_id", "batch_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_payouts" ADD CONSTRAINT "payroll_payouts_tenant_id_labourer_id_fkey" FOREIGN KEY ("tenant_id", "labourer_id") REFERENCES "labourers"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_payouts" ADD CONSTRAINT "payroll_payouts_tenant_id_payment_request_id_fkey" FOREIGN KEY ("tenant_id", "payment_request_id") REFERENCES "payment_requests"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_payouts" ADD CONSTRAINT "payroll_payouts_tenant_id_tariff_version_id_fkey" FOREIGN KEY ("tenant_id", "tariff_version_id") REFERENCES "payment_tariff_versions"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_payout_evidence" ADD CONSTRAINT "payroll_payout_evidence_tenant_id_project_id_payout_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "payout_id") REFERENCES "payroll_payouts"("tenant_id", "project_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_allocations" ADD CONSTRAINT "payroll_allocations_tenant_id_obligation_id_fkey" FOREIGN KEY ("tenant_id", "obligation_id") REFERENCES "payroll_obligations"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_allocations" ADD CONSTRAINT "payroll_allocations_tenant_id_obligation_id_payout_id_fkey" FOREIGN KEY ("tenant_id", "obligation_id", "payout_id") REFERENCES "payroll_payouts"("tenant_id", "obligation_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_allocations" ADD CONSTRAINT "payroll_allocations_tenant_id_reverses_allocation_id_fkey" FOREIGN KEY ("tenant_id", "reverses_allocation_id") REFERENCES "payroll_allocations"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_payout_flags" ADD CONSTRAINT "payroll_payout_flags_tenant_id_batch_id_fkey" FOREIGN KEY ("tenant_id", "batch_id") REFERENCES "payroll_batches"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_payout_flags" ADD CONSTRAINT "payroll_payout_flags_tenant_id_batch_id_obligation_id_fkey" FOREIGN KEY ("tenant_id", "batch_id", "obligation_id") REFERENCES "payroll_obligations"("tenant_id", "batch_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "labourer_payout_verifications" ADD CONSTRAINT "labourer_payout_verifications_tenant_id_labourer_id_fkey" FOREIGN KEY ("tenant_id", "labourer_id") REFERENCES "labourers"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "labourer_payout_holds" ADD CONSTRAINT "labourer_payout_holds_tenant_id_labourer_id_fkey" FOREIGN KEY ("tenant_id", "labourer_id") REFERENCES "labourers"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "labourer_payout_holds" ADD CONSTRAINT "labourer_payout_holds_tenant_id_payout_id_fkey" FOREIGN KEY ("tenant_id", "payout_id") REFERENCES "payroll_payouts"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "labourer_change_hold_overrides" ADD CONSTRAINT "labourer_change_hold_overrides_tenant_id_labourer_id_fkey" FOREIGN KEY ("tenant_id", "labourer_id") REFERENCES "labourers"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_settings" ADD CONSTRAINT "payout_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_approval_limits" ADD CONSTRAINT "payroll_approval_limits_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_approval_limits" ADD CONSTRAINT "payroll_approval_limits_tenant_id_custom_role_id_fkey" FOREIGN KEY ("tenant_id", "custom_role_id") REFERENCES "tenant_roles"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_notifications" ADD CONSTRAINT "payroll_notifications_tenant_id_batch_id_fkey" FOREIGN KEY ("tenant_id", "batch_id") REFERENCES "payroll_batches"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_notifications" ADD CONSTRAINT "payroll_notifications_tenant_id_obligation_id_fkey" FOREIGN KEY ("tenant_id", "obligation_id") REFERENCES "payroll_obligations"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_notifications" ADD CONSTRAINT "payroll_notifications_tenant_id_labourer_id_fkey" FOREIGN KEY ("tenant_id", "labourer_id") REFERENCES "labourers"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_tariff_versions" ADD CONSTRAINT "payment_tariff_versions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_tenant_id_project_id_payroll_line_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "payroll_line_id") REFERENCES "payroll_lines"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_tenant_id_project_id_payroll_payout_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "payroll_payout_id") REFERENCES "payroll_payouts"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Labourers: number changes and the SMS language -------------------------------------------------
ALTER TABLE "labourers" ADD CONSTRAINT "labourers_preferred_language_check"
  CHECK (preferred_language IN ('en', 'sw'));

-- phone_changed_at/by follow phone_bidx and are never written by the API: a new number (or a
-- cleared one) is stamped with the signed-in user and the time; a registration leaves them NULL,
-- like every number recorded before D4.3. A verification is valid only for the current number, so
-- a change invalidates it, and the change hold (OR-05) runs from phone_changed_at.
CREATE FUNCTION app.track_labourer_phone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.phone_changed_at := NULL;
    NEW.phone_changed_by := NULL;
  ELSIF NEW.phone_bidx IS DISTINCT FROM OLD.phone_bidx THEN
    NEW.phone_changed_at := now();
    NEW.phone_changed_by := app.current_user_id();
  ELSE
    NEW.phone_changed_at := OLD.phone_changed_at;
    NEW.phone_changed_by := OLD.phone_changed_by;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER labourer_phone_change BEFORE INSERT OR UPDATE ON "labourers"
  FOR EACH ROW EXECUTE FUNCTION app.track_labourer_phone();

-- Payroll batches: review, rejection, approval and the derived settlement states ------------------
-- Existing batches: their contributors are whoever created, calculated and submitted them. This
-- runs as the schema owner with the batch guard off and FORCE ROW LEVEL SECURITY lifted for the
-- update only (as the D5.4 migration did for its backfill).
ALTER TABLE "payroll_batches" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "payroll_batches" DISABLE TRIGGER "payroll_batch_guard";
UPDATE payroll_batches SET contributors = ARRAY(
  SELECT DISTINCT c FROM unnest(ARRAY[created_by, calculated_by, submitted_by]) c
   WHERE c IS NOT NULL ORDER BY c);
ALTER TABLE "payroll_batches" ENABLE TRIGGER "payroll_batch_guard";
ALTER TABLE "payroll_batches" FORCE ROW LEVEL SECURITY;

ALTER TABLE "payroll_batches" DROP CONSTRAINT "payroll_batches_check";
ALTER TABLE "payroll_batches" ADD CONSTRAINT "payroll_batches_check" CHECK (
  frequency IN ('daily', 'weekly', 'fortnightly', 'monthly')
  AND status IN ('draft', 'submitted', 'reviewed', 'rejected', 'approved', 'disbursing',
                 'partially_settled', 'settled', 'cancelled')
  AND version >= 1
  AND period_end >= period_start AND period_end - period_start <= 31
  AND pay_date >= period_end AND statutory_month = to_char(pay_date, 'YYYY-MM')
  AND digest ~ '^[0-9a-f]{64}$' AND line_count >= 0
  AND jsonb_typeof(totals) = 'object' AND jsonb_typeof(exclusions) = 'array'
  AND (cancellation_reason IS NULL OR char_length(btrim(cancellation_reason)) BETWEEN 10 AND 500)
  AND (rejection_reason IS NULL OR char_length(btrim(rejection_reason)) BETWEEN 10 AND 500)
  AND (approval_digest IS NULL OR approval_digest ~ '^[0-9a-f]{64}$')
  AND (approval_limit_minor IS NULL OR approval_limit_minor >= 0)
  AND contributors IS NOT NULL
  AND net_minor >= 0
);
ALTER TABLE "payroll_batches" DROP CONSTRAINT "payroll_batches_state_check";
ALTER TABLE "payroll_batches" ADD CONSTRAINT "payroll_batches_state_check" CHECK (
  (status = 'draft' AND active_marker = 'active' AND submitted_by IS NULL
    AND submitted_at IS NULL AND reviewed_by IS NULL AND rejected_by IS NULL
    AND approved_by IS NULL AND cancelled_by IS NULL)
  OR (status = 'submitted' AND active_marker = 'active' AND submitted_by IS NOT NULL
    AND submitted_at IS NOT NULL AND reviewed_by IS NULL AND rejected_by IS NULL
    AND approved_by IS NULL AND cancelled_by IS NULL)
  OR (status = 'reviewed' AND active_marker = 'active' AND submitted_by IS NOT NULL
    AND submitted_at IS NOT NULL AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL
    AND rejected_by IS NULL AND approved_by IS NULL AND cancelled_by IS NULL)
  OR (status = 'rejected' AND active_marker = 'active' AND submitted_by IS NOT NULL
    AND submitted_at IS NOT NULL AND rejected_by IS NOT NULL AND rejected_at IS NOT NULL
    AND rejection_reason IS NOT NULL AND approved_by IS NULL AND cancelled_by IS NULL)
  OR (status IN ('approved', 'disbursing', 'partially_settled', 'settled')
    AND active_marker = 'active' AND submitted_by IS NOT NULL AND reviewed_by IS NOT NULL
    AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND approval_digest IS NOT NULL
    AND approval_limit_minor IS NOT NULL AND rejected_by IS NULL AND cancelled_by IS NULL)
  OR (status = 'cancelled' AND active_marker IS NULL AND cancelled_by IS NOT NULL
    AND cancelled_at IS NOT NULL AND cancellation_reason IS NOT NULL AND approved_by IS NULL)
);
-- Maker-checker (OR-04): the reviewer and the approver are never contributors; the approver is
-- not the reviewer unless the approval was given under the owner's segregation waiver.
ALTER TABLE "payroll_batches" ADD CONSTRAINT "payroll_batches_separation_check" CHECK (
  (reviewed_by IS NULL OR NOT (reviewed_by = ANY (contributors)))
  AND (approved_by IS NULL OR (NOT (approved_by = ANY (contributors))
       AND approved_under_waiver = (approved_by = reviewed_by)))
  AND (approved_by IS NOT NULL OR NOT approved_under_waiver)
);

-- Explicit states (WORKFLOWS "Payroll", D4.1 + D4.3): draft (recalculated freely) → submitted (the
-- frozen snapshot) → reviewed → approved, submitted/reviewed → rejected → draft (reopened),
-- draft/submitted/reviewed → cancelled; after approval only the derived settlement status moves
-- (packages/types PAYROLL_BATCH_TRANSITIONS) and nothing else about the batch changes. Each
-- decision is recorded once, by the signed-in user; contributors grow by whoever recalculates,
-- submits or reopens (never through the API's own values).
CREATE OR REPLACE FUNCTION app.guard_payroll_batch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actor uuid := app.current_user_id();
  settling constant text[] := ARRAY['approved', 'disbursing', 'partially_settled', 'settled'];
  allowed boolean;
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
    NEW.contributors := ARRAY(
      SELECT DISTINCT c FROM unnest(ARRAY[NEW.created_by, NEW.calculated_by]) c
       WHERE c IS NOT NULL ORDER BY c);
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
  allowed := CASE OLD.status
    WHEN 'draft' THEN NEW.status IN ('draft', 'submitted', 'cancelled')
    WHEN 'submitted' THEN NEW.status IN ('reviewed', 'rejected', 'cancelled')
    WHEN 'reviewed' THEN NEW.status IN ('approved', 'rejected', 'cancelled')
    WHEN 'rejected' THEN NEW.status = 'draft'
    WHEN 'approved' THEN NEW.status IN ('disbursing', 'partially_settled', 'settled')
    WHEN 'disbursing' THEN NEW.status IN ('partially_settled', 'settled')
    WHEN 'partially_settled' THEN NEW.status IN ('disbursing', 'settled')
    WHEN 'settled' THEN NEW.status IN ('partially_settled', 'disbursing')
    ELSE false END;
  IF NOT allowed THEN
    RAISE EXCEPTION 'This payroll batch status change is not allowed' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = ANY (settling)
     AND (to_jsonb(NEW) - 'status' - 'version') <> (to_jsonb(OLD) - 'status' - 'version') THEN
    RAISE EXCEPTION 'An approved batch is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> 'draft' AND (
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
  IF NEW.contributors IS DISTINCT FROM OLD.contributors THEN
    RAISE EXCEPTION 'Batch contributors are kept by the database' USING ERRCODE = '23514';
  END IF;
  IF ((OLD.status = 'draft' AND NEW.status IN ('draft', 'submitted'))
      OR (OLD.status = 'rejected' AND NEW.status = 'draft'))
     AND actor IS NOT NULL AND NOT (actor = ANY (OLD.contributors)) THEN
    NEW.contributors := OLD.contributors || actor;
  END IF;

  IF OLD.status = 'rejected' AND NEW.status = 'draft' THEN
    IF NEW.reopened_by IS DISTINCT FROM actor THEN
      RAISE EXCEPTION 'A batch is reopened by the signed-in user' USING ERRCODE = '23514';
    END IF;
    NEW.reopened_at := now();
    NEW.submitted_by := NULL;
    NEW.submitted_at := NULL;
    NEW.reviewed_by := NULL;
    NEW.reviewed_at := NULL;
    NEW.review_note := NULL;
    NEW.rejected_by := NULL;
    NEW.rejected_at := NULL;
    NEW.rejection_reason := NULL;
  ELSE
    IF NEW.reopened_by IS DISTINCT FROM OLD.reopened_by
       OR NEW.reopened_at IS DISTINCT FROM OLD.reopened_at THEN
      RAISE EXCEPTION 'A reopening is never rewritten' USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'draft' AND NEW.status = 'submitted' THEN
      IF NEW.submitted_by IS DISTINCT FROM actor THEN
        RAISE EXCEPTION 'A batch is submitted by the signed-in user' USING ERRCODE = '23514';
      END IF;
      NEW.submitted_at := now();
    ELSIF NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
          OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
      RAISE EXCEPTION 'A submission is never rewritten' USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'submitted' AND NEW.status = 'reviewed' THEN
      IF NEW.reviewed_by IS DISTINCT FROM actor THEN
        RAISE EXCEPTION 'A batch is reviewed by the signed-in user' USING ERRCODE = '23514';
      END IF;
      NEW.reviewed_at := now();
    ELSIF NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
          OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
          OR NEW.review_note IS DISTINCT FROM OLD.review_note THEN
      RAISE EXCEPTION 'A review is never rewritten' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'rejected' AND OLD.status <> 'rejected' THEN
      IF NEW.rejected_by IS DISTINCT FROM actor THEN
        RAISE EXCEPTION 'A batch is rejected by the signed-in user' USING ERRCODE = '23514';
      END IF;
      NEW.rejected_at := now();
    ELSIF NEW.rejected_by IS DISTINCT FROM OLD.rejected_by
          OR NEW.rejected_at IS DISTINCT FROM OLD.rejected_at
          OR NEW.rejection_reason IS DISTINCT FROM OLD.rejection_reason THEN
      RAISE EXCEPTION 'A rejection is never rewritten' USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'reviewed' AND NEW.status = 'approved' THEN
      IF NEW.approved_by IS DISTINCT FROM actor THEN
        RAISE EXCEPTION 'A batch is approved by the signed-in user' USING ERRCODE = '23514';
      END IF;
      IF NEW.approved_under_waiver AND NOT EXISTS (
        SELECT 1 FROM payout_settings s WHERE s.tenant_id = NEW.tenant_id AND s.waiver_enabled
      ) THEN
        RAISE EXCEPTION 'Only the segregation waiver lets the reviewer approve'
          USING ERRCODE = '23514';
      END IF;
      NEW.approved_at := now();
    ELSIF NEW.approved_by IS DISTINCT FROM OLD.approved_by
          OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
          OR NEW.approval_digest IS DISTINCT FROM OLD.approval_digest
          OR NEW.approval_note IS DISTINCT FROM OLD.approval_note
          OR NEW.approved_under_waiver IS DISTINCT FROM OLD.approved_under_waiver
          OR NEW.approval_limit_minor IS DISTINCT FROM OLD.approval_limit_minor THEN
      RAISE EXCEPTION 'An approval is never rewritten' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.status = 'cancelled' THEN
    IF NEW.cancelled_by IS DISTINCT FROM actor THEN
      RAISE EXCEPTION 'A batch is cancelled by the signed-in user' USING ERRCODE = '23514';
    END IF;
    NEW.active_marker := NULL;
    NEW.cancelled_at := now();
  ELSIF NEW.cancelled_by IS DISTINCT FROM OLD.cancelled_by
        OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
        OR NEW.cancellation_reason IS DISTINCT FROM OLD.cancellation_reason THEN
    RAISE EXCEPTION 'Only a cancellation records a cancellation' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'draft' THEN
    NEW.calculated_at := now();
  END IF;
  RETURN NEW;
END
$$;

-- Lines: brought-forward carry-forwards (D-167) are added to net after every deduction.
ALTER TABLE "payroll_lines" DROP CONSTRAINT "payroll_lines_check";
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_check" CHECK (
  engagement_type IN ('casual', 'term', 'piece_rate') AND rate_basis IN ('daily', 'hourly')
  AND gross_minor >= 0 AND net_minor >= 0 AND advance_recovery_minor >= 0
  AND other_deductions_minor >= 0 AND days_worked >= 0 AND brought_forward_minor >= 0
  AND net_minor = gross_minor - statutory_withheld_minor - advance_recovery_minor
    - other_deductions_minor + brought_forward_minor
  AND jsonb_typeof(month_to_date) = 'object' AND jsonb_typeof(warnings) = 'array'
  AND (payee_phone_bidx IS NULL OR payee_phone_bidx ~ '^[0-9a-f]{64}$')
);

-- Consumption: a carry-forward is a third one-time source, brought forward by its worker's line.
ALTER TABLE "payroll_consumptions" DROP CONSTRAINT "payroll_consumptions_check";
ALTER TABLE "payroll_consumptions" ADD CONSTRAINT "payroll_consumptions_check" CHECK (
  (source_kind = 'timesheet_line' AND timesheet_line_id IS NOT NULL AND share_id IS NULL
    AND carry_forward_id IS NULL)
  OR (source_kind = 'piece_rate_share' AND share_id IS NOT NULL AND timesheet_line_id IS NULL
    AND carry_forward_id IS NULL)
  OR (source_kind = 'carry_forward' AND carry_forward_id IS NOT NULL
    AND timesheet_line_id IS NULL AND share_id IS NULL)
);

CREATE OR REPLACE FUNCTION app.guard_payroll_consumption() RETURNS trigger LANGUAGE plpgsql AS $$
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
       OR NEW.carry_forward_id IS DISTINCT FROM OLD.carry_forward_id
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
  IF NEW.carry_forward_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM payroll_carry_forwards c
    JOIN payroll_lines l ON l.tenant_id = c.tenant_id AND l.batch_id = NEW.batch_id
      AND l.labourer_id = c.labourer_id
    WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.carry_forward_id
      AND c.batch_id <> NEW.batch_id AND l.brought_forward_minor >= c.amount_minor
  ) THEN
    RAISE EXCEPTION 'A carry-forward is brought forward by its worker''s line'
      USING ERRCODE = '23514';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END
$$;

-- Decisions -------------------------------------------------------------------------------------
ALTER TABLE "payroll_batch_decisions" ADD CONSTRAINT "payroll_batch_decisions_check" CHECK (
  action IN ('submit', 'review', 'reject', 'reopen', 'approve', 'cancel', 'destination_approve')
  AND batch_version >= 1 AND digest ~ '^[0-9a-f]{64}$'
  AND (approval_digest IS NULL OR approval_digest ~ '^[0-9a-f]{64}$')
  AND action_hash ~ '^[0-9a-f]{64}$' AND net_minor >= 0
  AND (applied_limit_minor IS NULL OR applied_limit_minor >= 0)
  AND (action = 'destination_approve') = (obligation_id IS NOT NULL)
  AND (action = 'approve' OR (applied_limit_minor IS NULL AND NOT under_waiver))
);

-- The decision log is append-only evidence (T-12, A-17): written by the signed-in user, with the
-- action hash the domain defines (packages/domain decisionActionText) checked here.
CREATE FUNCTION app.guard_payroll_batch_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'The batch decision log is append-only' USING ERRCODE = '23514';
  END IF;
  IF NEW.actor_id IS DISTINCT FROM app.current_user_id()
     OR NEW.action_hash <> encode(sha256(convert_to(concat_ws('|', NEW.batch_id::text,
          NEW.batch_version::text, NEW.digest, COALESCE(NEW.approval_digest, ''),
          NEW.net_minor::text, NEW.action), 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'A decision is recorded by the signed-in user with its action hash'
      USING ERRCODE = '23514';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER payroll_batch_decision_guard BEFORE INSERT OR UPDATE OR DELETE
  ON "payroll_batch_decisions" FOR EACH ROW EXECUTE FUNCTION app.guard_payroll_batch_decision();

-- Verifications, holds and change-hold overrides -------------------------------------------------
ALTER TABLE "labourer_payout_verifications" ADD CONSTRAINT "labourer_payout_verifications_check"
  CHECK (method IN ('in_person_id_check') AND phone_bidx ~ '^[0-9a-f]{64}$');

-- Owner decision 5: someone other than whoever changed the number (or registered the worker, when
-- the number came with the registration) checks the worker's ID in person; the verification names
-- the labourer's current number. Append-only.
CREATE FUNCTION app.guard_labourer_payout_verification() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actor uuid := app.current_user_id();
  lab record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'A verification is never changed' USING ERRCODE = '23514';
  END IF;
  SELECT phone_bidx, phone_changed_at, phone_changed_by, created_by INTO lab FROM labourers
   WHERE tenant_id = NEW.tenant_id AND id = NEW.labourer_id;
  IF NOT FOUND OR lab.phone_bidx IS NULL OR NEW.phone_bidx <> lab.phone_bidx
     OR NEW.verified_by IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'A verification is of the worker''s current number, by the signed-in user'
      USING ERRCODE = '23514';
  END IF;
  IF actor = lab.phone_changed_by OR (lab.phone_changed_at IS NULL AND actor = lab.created_by) THEN
    RAISE EXCEPTION 'Whoever entered the number cannot verify it' USING ERRCODE = '23514';
  END IF;
  NEW.verified_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER labourer_payout_verification_guard BEFORE INSERT OR UPDATE OR DELETE
  ON "labourer_payout_verifications" FOR EACH ROW
  EXECUTE FUNCTION app.guard_labourer_payout_verification();

ALTER TABLE "labourer_payout_holds" ADD CONSTRAINT "labourer_payout_holds_check" CHECK (
  kind IN ('name_mismatch', 'manual') AND char_length(btrim(reason)) BETWEEN 10 AND 500
  AND (phone_bidx IS NULL OR phone_bidx ~ '^[0-9a-f]{64}$')
  AND (kind <> 'manual' OR (created_by IS NOT NULL AND payout_id IS NULL))
  AND (kind <> 'name_mismatch' OR (created_by IS NULL AND payout_id IS NOT NULL))
  AND (released_by IS NULL) = (released_at IS NULL)
  AND (released_by IS NULL) = (release_reason IS NULL)
  AND (release_reason IS NULL OR char_length(btrim(release_reason)) BETWEEN 10 AND 500)
  AND version >= 1
);

-- A manual hold is placed by the signed-in user, a name-mismatch hold by the system; a hold is
-- released once, by the signed-in user with a reason, and never deleted.
CREATE FUNCTION app.guard_labourer_payout_hold() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actor uuid := app.current_user_id();
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A payout hold is released, never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.released_by IS NOT NULL OR NEW.version <> 1
       OR (NEW.kind = 'manual' AND NEW.created_by IS DISTINCT FROM actor) THEN
      RAISE EXCEPTION 'A hold starts active' USING ERRCODE = '23514';
    END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  IF OLD.released_by IS NOT NULL OR NEW.released_by IS DISTINCT FROM actor
     OR NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.labourer_id IS DISTINCT FROM OLD.labourer_id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.phone_bidx IS DISTINCT FROM OLD.phone_bidx
     OR NEW.phone_masked IS DISTINCT FROM OLD.phone_masked
     OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.payout_id IS DISTINCT FROM OLD.payout_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'A hold is released once, by the signed-in user' USING ERRCODE = '23514';
  END IF;
  NEW.released_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER labourer_payout_hold_guard BEFORE INSERT OR UPDATE OR DELETE
  ON "labourer_payout_holds" FOR EACH ROW EXECUTE FUNCTION app.guard_labourer_payout_hold();

ALTER TABLE "labourer_change_hold_overrides" ADD CONSTRAINT "labourer_change_hold_overrides_check"
  CHECK (char_length(btrim(reason)) BETWEEN 10 AND 500);

-- OR-05: only a member whose system role is owner overrides the hold after a number change, and
-- only for the labourer's current change. Append-only.
CREATE FUNCTION app.guard_labourer_change_hold_override() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actor uuid := app.current_user_id();
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'A change-hold override is never changed' USING ERRCODE = '23514';
  END IF;
  IF NEW.created_by IS DISTINCT FROM actor OR NOT EXISTS (
       SELECT 1 FROM memberships m
        WHERE m.tenant_id = NEW.tenant_id AND m.user_id = actor AND m.role = 'owner')
     OR NOT EXISTS (
       SELECT 1 FROM labourers l
        WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.labourer_id
          AND l.phone_changed_at = NEW.phone_changed_at) THEN
    RAISE EXCEPTION 'An owner overrides the current change hold' USING ERRCODE = '23514';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER labourer_change_hold_override_guard BEFORE INSERT OR UPDATE OR DELETE
  ON "labourer_change_hold_overrides" FOR EACH ROW
  EXECUTE FUNCTION app.guard_labourer_change_hold_override();

-- Payout settings and approval limits -----------------------------------------------------------
ALTER TABLE "payout_settings" ADD CONSTRAINT "payout_settings_check" CHECK (
  cash_max_per_worker_period_minor BETWEEN 0 AND 100000000
  AND cash_max_per_worker_period_minor % 100 = 0
  AND name_match_threshold BETWEEN 0.5 AND 1
  AND payee_change_hold_hours BETWEEN 0 AND 168
  AND unusual_new_recipient_minor BETWEEN 100 AND 100000000
  AND unusual_new_recipient_minor % 100 = 0
  AND business_hours_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  AND business_hours_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  AND business_hours_start < business_hours_end
  AND float_check_max_age_minutes BETWEEN 1 AND 120
  AND waiver_limit_minor BETWEEN 100 AND 100000000000 AND waiver_limit_minor % 100 = 0
  AND (NOT waiver_enabled OR waiver_reason IS NOT NULL)
  AND (waiver_reason IS NULL OR char_length(btrim(waiver_reason)) BETWEEN 10 AND 500)
  AND (waiver_changed_by IS NULL) = (waiver_changed_at IS NULL)
  AND version >= 0 AND limits_version >= 0
);

-- OR-04: only a member whose system role is owner changes the segregation waiver (stamped here);
-- versions only move forward; the row is never deleted.
CREATE FUNCTION app.guard_payout_settings() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actor uuid := app.current_user_id();
  waiver_changed boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Payout settings are never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    waiver_changed := NEW.waiver_enabled OR NEW.waiver_changed_by IS NOT NULL
      OR NEW.waiver_reason IS NOT NULL;
    NEW.created_at := now();
  ELSE
    waiver_changed := NEW.waiver_enabled IS DISTINCT FROM OLD.waiver_enabled
      OR NEW.waiver_reason IS DISTINCT FROM OLD.waiver_reason
      OR NEW.waiver_limit_minor IS DISTINCT FROM OLD.waiver_limit_minor
      OR NEW.waiver_changed_by IS DISTINCT FROM OLD.waiver_changed_by;
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.version < OLD.version OR NEW.limits_version < OLD.limits_version THEN
      RAISE EXCEPTION 'Payout settings keep their company and only move forward'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF waiver_changed THEN
    IF NEW.waiver_changed_by IS DISTINCT FROM actor OR NOT EXISTS (
      SELECT 1 FROM memberships m
       WHERE m.tenant_id = NEW.tenant_id AND m.user_id = actor AND m.role = 'owner'
    ) THEN
      RAISE EXCEPTION 'Only an owner changes the segregation waiver' USING ERRCODE = '23514';
    END IF;
    NEW.waiver_changed_at := now();
  ELSIF TG_OP = 'UPDATE' AND NEW.waiver_changed_at IS DISTINCT FROM OLD.waiver_changed_at THEN
    RAISE EXCEPTION 'The waiver is stamped by its owner''s change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER payout_settings_guard BEFORE INSERT OR UPDATE OR DELETE ON "payout_settings"
  FOR EACH ROW EXECUTE FUNCTION app.guard_payout_settings();

ALTER TABLE "payroll_approval_limits" ADD CONSTRAINT "payroll_approval_limits_check" CHECK (
  (system_role IS NULL) <> (custom_role_id IS NULL)
  AND (system_role IS NULL OR system_role IN ('owner', 'project_manager', 'site_agent', 'foreman',
       'quantity_surveyor', 'storekeeper', 'finance', 'client', 'consultant', 'supplier',
       'labourer'))
  AND max_batch_net_minor BETWEEN 100 AND 100000000000 AND max_batch_net_minor % 100 = 0
);

CREATE FUNCTION app.stamp_payroll_approval_limit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.updated_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'An approval limit is set by the signed-in user' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER payroll_approval_limit_stamp BEFORE INSERT OR UPDATE ON "payroll_approval_limits"
  FOR EACH ROW EXECUTE FUNCTION app.stamp_payroll_approval_limit();

-- Charges tariff (CR-PMT-02) --------------------------------------------------------------------
ALTER TABLE "payment_tariff_versions" ADD CONSTRAINT "payment_tariff_versions_check" CHECK (
  kind IN ('b2c') AND status IN ('demo', 'verified')
  AND jsonb_typeof(bands) = 'array' AND jsonb_array_length(bands) BETWEEN 1 AND 30
  AND char_length(btrim(source)) >= 10
  AND (created_by IS NOT NULL OR status = 'demo')
);

-- Versions are added, never edited: a company's own by the signed-in user; the DEMO one with no
-- author (seeded below and when a company first configures payments).
CREATE FUNCTION app.guard_payment_tariff_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'A tariff version is never changed: add a new one' USING ERRCODE = '23514';
  END IF;
  IF NEW.created_by IS NOT NULL AND NEW.created_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A tariff version is added by the signed-in user' USING ERRCODE = '23514';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER payment_tariff_version_guard BEFORE INSERT OR UPDATE OR DELETE
  ON "payment_tariff_versions" FOR EACH ROW EXECUTE FUNCTION app.guard_payment_tariff_version();

-- Every existing company starts with the DEMO bands (packages/types DEMO_B2C_TARIFF), clearly
-- labelled; new companies get them when they first configure payments. Seeded before the table's
-- RLS is enabled; tenants is read as the schema owner with FORCE lifted for this statement only.
ALTER TABLE "tenants" NO FORCE ROW LEVEL SECURITY;
INSERT INTO payment_tariff_versions (id, tenant_id, kind, effective_from, status, bands, source,
  created_by)
SELECT uuidv7(), t.tenant_id, 'b2c', DATE '2024-01-01', 'demo',
       '[{"upToMinor":10000,"chargeMinor":0},{"upToMinor":150000,"chargeMinor":500},{"upToMinor":500000,"chargeMinor":900},{"upToMinor":2000000,"chargeMinor":1100},{"upToMinor":25000000,"chargeMinor":1300}]'::jsonb,
       'DEMO placeholder bands for development and tests (CR-PMT-02, Q-M2); replace with the company''s verified Safaricom B2C tariff',
       NULL
  FROM tenants t;
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;

-- Obligations and carry-forwards ---------------------------------------------------------------
ALTER TABLE "payroll_obligations" ADD CONSTRAINT "payroll_obligations_check" CHECK (
  amount_minor > 0 AND amount_minor % 100 = 0
  AND paid_minor >= 0 AND paid_minor <= amount_minor
  AND status IN ('open', 'settled') AND (status = 'settled') = (paid_minor = amount_minor)
  AND channel IN ('mpesa', 'manual') AND (channel = 'mpesa') = (manual_reason IS NULL)
  AND (manual_reason IS NULL OR manual_reason IN ('no_number', 'below_b2c_min', 'above_b2c_max'))
  AND COALESCE(manual_reason = 'no_number', false) = (destination_bidx IS NULL)
  AND (destination_bidx IS NULL
       OR (destination_bidx ~ '^[0-9a-f]{64}$' AND verification_id IS NOT NULL))
  AND version >= 1
);

-- An obligation is created at approval for the whole shillings of an approved line's net (D-167),
-- to the line's payee number with its verification; its paid amount and status are always derived
-- from its allocations here; only a re-approval by someone independent moves the destination, to
-- the labourer's current verified number, while nothing is in flight. Never deleted.
CREATE FUNCTION app.guard_payroll_obligation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actor uuid := app.current_user_id();
  src record;
  paid bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'An obligation is never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT l.labourer_id, l.net_minor, l.payee_phone_bidx, b.status, b.project_id INTO src
      FROM payroll_lines l JOIN payroll_batches b ON b.tenant_id = l.tenant_id AND b.id = l.batch_id
     WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.line_id AND l.batch_id = NEW.batch_id;
    IF NOT FOUND OR src.status <> 'approved' OR src.project_id <> NEW.project_id
       OR src.labourer_id <> NEW.labourer_id
       OR NEW.amount_minor <> src.net_minor - (src.net_minor % 100)
       OR NEW.destination_bidx IS DISTINCT FROM src.payee_phone_bidx
       OR NEW.paid_minor <> 0 OR NEW.status <> 'open' OR NEW.version <> 1
       OR NEW.destination_approved_by IS DISTINCT FROM actor
       OR (NEW.verification_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM labourer_payout_verifications v
             WHERE v.tenant_id = NEW.tenant_id AND v.id = NEW.verification_id
               AND v.labourer_id = NEW.labourer_id AND v.phone_bidx = NEW.destination_bidx)) THEN
      RAISE EXCEPTION 'An obligation is the whole shillings of an approved line''s net, to its payee'
        USING ERRCODE = '23514';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    NEW.destination_approved_at := now();
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
     OR NEW.line_id IS DISTINCT FROM OLD.line_id OR NEW.labourer_id IS DISTINCT FROM OLD.labourer_id
     OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
     OR NEW.channel IS DISTINCT FROM OLD.channel
     OR NEW.manual_reason IS DISTINCT FROM OLD.manual_reason
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'An obligation keeps its line, amount and channel' USING ERRCODE = '23514';
  END IF;
  IF NEW.destination_bidx IS DISTINCT FROM OLD.destination_bidx
     OR NEW.verification_id IS DISTINCT FROM OLD.verification_id
     OR NEW.destination_approved_by IS DISTINCT FROM OLD.destination_approved_by THEN
    IF NEW.destination_approved_by IS DISTINCT FROM actor OR NEW.destination_bidx IS NULL
       OR NEW.channel <> 'mpesa'
       OR NOT EXISTS (
         SELECT 1 FROM labourers l
          WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.labourer_id
            AND l.phone_bidx = NEW.destination_bidx
            AND l.phone_changed_by IS DISTINCT FROM actor)
       OR NOT EXISTS (
         SELECT 1 FROM labourer_payout_verifications v
          WHERE v.tenant_id = NEW.tenant_id AND v.id = NEW.verification_id
            AND v.labourer_id = NEW.labourer_id AND v.phone_bidx = NEW.destination_bidx)
       OR EXISTS (
         SELECT 1 FROM payroll_batches b
          WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id
            AND actor = ANY (b.contributors))
       OR EXISTS (
         SELECT 1 FROM payroll_payouts p
          WHERE p.tenant_id = NEW.tenant_id AND p.obligation_id = NEW.id
            AND p.status IN ('active', 'pending_confirmation')) THEN
      RAISE EXCEPTION 'A changed destination is re-approved by someone independent, to a verified number'
        USING ERRCODE = '23514';
    END IF;
    NEW.destination_approved_at := now();
  ELSIF NEW.destination_approved_at IS DISTINCT FROM OLD.destination_approved_at THEN
    RAISE EXCEPTION 'A destination approval is never rewritten' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(sum(a.amount_minor), 0) INTO paid FROM payroll_allocations a
   WHERE a.tenant_id = NEW.tenant_id AND a.obligation_id = NEW.id;
  NEW.paid_minor := paid;
  NEW.status := CASE WHEN paid = NEW.amount_minor THEN 'settled' ELSE 'open' END;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER payroll_obligation_guard BEFORE INSERT OR UPDATE OR DELETE ON "payroll_obligations"
  FOR EACH ROW EXECUTE FUNCTION app.guard_payroll_obligation();

ALTER TABLE "payroll_carry_forwards" ADD CONSTRAINT "payroll_carry_forwards_check"
  CHECK (amount_minor BETWEEN 1 AND 99);

-- A carry-forward is created at approval for the cents of an approved line's net (D-167).
CREATE FUNCTION app.guard_payroll_carry_forward() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  src record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'A carry-forward is never changed' USING ERRCODE = '23514';
  END IF;
  SELECT l.labourer_id, l.net_minor, b.status, b.project_id INTO src
    FROM payroll_lines l JOIN payroll_batches b ON b.tenant_id = l.tenant_id AND b.id = l.batch_id
   WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.line_id AND l.batch_id = NEW.batch_id;
  IF NOT FOUND OR src.status <> 'approved' OR src.project_id <> NEW.project_id
     OR src.labourer_id <> NEW.labourer_id OR NEW.amount_minor <> src.net_minor % 100 THEN
    RAISE EXCEPTION 'A carry-forward is the cents of an approved line''s net' USING ERRCODE = '23514';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER payroll_carry_forward_guard BEFORE INSERT OR UPDATE OR DELETE
  ON "payroll_carry_forwards" FOR EACH ROW EXECUTE FUNCTION app.guard_payroll_carry_forward();

-- Payouts ----------------------------------------------------------------------------------------
ALTER TABLE "payroll_payouts" ADD CONSTRAINT "payroll_payouts_check" CHECK (
  method IN ('mpesa', 'cash', 'bank') AND amount_minor > 0 AND amount_minor % 100 = 0
  AND status IN ('active', 'pending_confirmation', 'confirmed', 'failed', 'rejected', 'reversed')
  AND version >= 1
  AND (method = 'mpesa') = (payment_request_id IS NOT NULL)
  AND (method <> 'mpesa' OR (status IN ('active', 'confirmed', 'failed', 'reversed')
       AND destination_bidx ~ '^[0-9a-f]{64}$' AND reference IS NULL AND reason IS NULL
       AND confirmed_by IS NULL AND rejected_by IS NULL))
  AND (method = 'mpesa' OR (status IN ('pending_confirmation', 'confirmed', 'rejected')
       AND paid_on IS NOT NULL AND receipt IS NULL AND result_code IS NULL
       AND charge_minor IS NULL AND name_check IS NULL AND receiver_name_enc IS NULL))
  AND (method <> 'cash' OR reason IS NOT NULL)
  AND (method <> 'bank' OR reference IS NOT NULL)
  AND (reason IS NULL OR char_length(btrim(reason)) BETWEEN 10 AND 500)
  AND (reference IS NULL OR reference ~ '^[A-Za-z0-9 _#/.:-]{3,40}$')
  AND (name_check IS NULL OR name_check IN ('match', 'mismatch', 'unavailable'))
  AND (name_score IS NULL OR name_score BETWEEN 0 AND 1)
  AND (charge_minor IS NULL OR charge_minor >= 0)
  AND (status IN ('confirmed', 'reversed')) = (confirmed_at IS NOT NULL)
  AND (method <> 'mpesa' OR status NOT IN ('confirmed', 'reversed')
       OR (receipt IS NOT NULL AND paid_on IS NOT NULL AND name_check IS NOT NULL))
  AND (method = 'mpesa' OR status <> 'confirmed'
       OR (confirmed_by IS NOT NULL AND confirmed_by <> created_by))
  AND (status = 'rejected') = (rejected_by IS NOT NULL)
  AND (rejected_by IS NULL OR (rejected_by <> created_by AND rejected_at IS NOT NULL
       AND rejection_reason IS NOT NULL))
  AND (rejection_reason IS NULL OR char_length(btrim(rejection_reason)) BETWEEN 10 AND 500)
  AND (status IN ('active', 'pending_confirmation')) = (finished_at IS NULL)
  AND app.is_field_ciphertext(receiver_name_enc)
);
-- One live payout per obligation: it reserves the outstanding amount.
CREATE UNIQUE INDEX "payroll_payouts_one_live" ON "payroll_payouts" ("tenant_id", "obligation_id")
  WHERE status IN ('active', 'pending_confirmation');

-- A payout pays at most what its obligation still owes (the obligation row is locked, so two
-- payouts or a payout and an allocation cannot race); an M-Pesa payout is exactly one B2C request
-- of purpose payroll_obligation to the approved destination; a cash or bank payment waits for a
-- second person. States move only along PAYROLL_PAYOUT_TRANSITIONS; evidence (receipt, result,
-- charge, name check) is written once, when the payout finishes; nothing is deleted.
CREATE FUNCTION app.guard_payroll_payout() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actor uuid := app.current_user_id();
  ob record;
  req record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A payout is never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT o.batch_id, o.project_id, o.labourer_id, o.status, o.channel, o.amount_minor,
           o.paid_minor, o.destination_bidx, b.status AS batch_status
      INTO ob
      FROM payroll_obligations o
      JOIN payroll_batches b ON b.tenant_id = o.tenant_id AND b.id = o.batch_id
     WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.obligation_id
       FOR UPDATE OF o;
    IF NOT FOUND
       OR ob.batch_status NOT IN ('approved', 'disbursing', 'partially_settled', 'settled')
       OR ob.batch_id <> NEW.batch_id OR ob.project_id <> NEW.project_id
       OR ob.labourer_id <> NEW.labourer_id OR ob.status <> 'open'
       OR NEW.amount_minor > ob.amount_minor - ob.paid_minor OR NEW.version <> 1
       OR NEW.created_by IS DISTINCT FROM actor OR NEW.confirmed_by IS NOT NULL
       OR NEW.confirmed_at IS NOT NULL OR NEW.rejected_by IS NOT NULL OR NEW.receipt IS NOT NULL
       OR NEW.charge_minor IS NOT NULL OR NEW.name_check IS NOT NULL
       OR NEW.finished_at IS NOT NULL THEN
      RAISE EXCEPTION 'A payout pays at most what its approved obligation still owes'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.method = 'mpesa' THEN
      SELECT r.purpose, r.purpose_ref, r.amount_minor, r.kind INTO req FROM payment_requests r
       WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.payment_request_id;
      IF NEW.status <> 'active' OR ob.channel <> 'mpesa'
         OR NEW.destination_bidx IS DISTINCT FROM ob.destination_bidx
         OR req.purpose IS DISTINCT FROM 'payroll_obligation'
         OR req.purpose_ref IS DISTINCT FROM NEW.id
         OR req.amount_minor IS DISTINCT FROM NEW.amount_minor
         OR req.kind IS DISTINCT FROM 'b2c' OR NEW.paid_on IS NOT NULL THEN
        RAISE EXCEPTION 'An M-Pesa payout is one B2C request to the approved destination'
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.status <> 'pending_confirmation' OR NEW.paid_on > app.business_today()
          OR NEW.paid_on < app.business_today() - 90 THEN
      RAISE EXCEPTION 'A cash or bank payment waits for confirmation and was paid in the last 90 days'
        USING ERRCODE = '23514';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
     OR NEW.obligation_id IS DISTINCT FROM OLD.obligation_id
     OR NEW.labourer_id IS DISTINCT FROM OLD.labourer_id OR NEW.method IS DISTINCT FROM OLD.method
     OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
     OR NEW.payment_request_id IS DISTINCT FROM OLD.payment_request_id
     OR NEW.destination_bidx IS DISTINCT FROM OLD.destination_bidx
     OR NEW.reference IS DISTINCT FROM OLD.reference OR NEW.reason IS DISTINCT FROM OLD.reason
     OR (OLD.method <> 'mpesa' AND NEW.paid_on IS DISTINCT FROM OLD.paid_on)
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'A payout keeps its obligation, method and amount' USING ERRCODE = '23514';
  END IF;
  IF NOT ((OLD.status = 'active' AND NEW.status IN ('confirmed', 'failed'))
          OR (OLD.status = 'pending_confirmation' AND NEW.status IN ('confirmed', 'rejected'))
          OR (OLD.status = 'confirmed' AND NEW.status = 'reversed' AND OLD.method = 'mpesa')) THEN
    RAISE EXCEPTION 'This payout status change is not allowed' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'confirmed' THEN
    IF (to_jsonb(NEW) - 'status' - 'version' - 'updated_at')
       <> (to_jsonb(OLD) - 'status' - 'version' - 'updated_at')
       OR NOT EXISTS (SELECT 1 FROM payment_requests r WHERE r.tenant_id = NEW.tenant_id
                       AND r.id = NEW.payment_request_id AND r.status = 'reversed') THEN
      RAISE EXCEPTION 'A confirmed payout is reversed only by its reversed request'
        USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.method <> 'mpesa' THEN
    IF NEW.status = 'confirmed' THEN
      IF NEW.confirmed_by IS DISTINCT FROM actor OR actor = OLD.created_by THEN
        RAISE EXCEPTION 'Someone other than the recorder confirms a payment'
          USING ERRCODE = '23514';
      END IF;
      IF OLD.method = 'cash' AND NOT EXISTS (
        SELECT 1 FROM payroll_payout_evidence e
         WHERE e.tenant_id = NEW.tenant_id AND e.payout_id = NEW.id
      ) THEN
        RAISE EXCEPTION 'A cash payment is confirmed with its evidence' USING ERRCODE = '23514';
      END IF;
      NEW.confirmed_at := now();
    ELSE
      IF NEW.rejected_by IS DISTINCT FROM actor OR actor = OLD.created_by THEN
        RAISE EXCEPTION 'Someone other than the recorder rejects a payment'
          USING ERRCODE = '23514';
      END IF;
      NEW.rejected_at := now();
    END IF;
  ELSIF NEW.status = 'confirmed' THEN
    IF NOT EXISTS (SELECT 1 FROM payment_requests r WHERE r.tenant_id = NEW.tenant_id
                    AND r.id = NEW.payment_request_id AND r.status = 'confirmed') THEN
      RAISE EXCEPTION 'An M-Pesa payout confirms with its confirmed request'
        USING ERRCODE = '23514';
    END IF;
    NEW.confirmed_at := now();
  END IF;
  IF OLD.status IN ('active', 'pending_confirmation') THEN
    NEW.finished_at := now();
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
-- Key rotation (D9.1): the schema owner may re-encrypt the receiver name and change nothing else
-- (app.is_field_rewrap, as in 20261204093000_payments_key_rotation).
CREATE TRIGGER payroll_payout_guard BEFORE INSERT OR DELETE ON "payroll_payouts"
  FOR EACH ROW EXECUTE FUNCTION app.guard_payroll_payout();
CREATE TRIGGER payroll_payout_guard_update BEFORE UPDATE ON "payroll_payouts"
  FOR EACH ROW
  WHEN (NOT app.is_field_rewrap(to_jsonb(OLD) - 'receiver_name_enc',
    to_jsonb(NEW) - 'receiver_name_enc', OLD.receiver_name_enc, NEW.receiver_name_enc))
  EXECUTE FUNCTION app.guard_payroll_payout();

ALTER TABLE "payroll_payout_evidence" ADD CONSTRAINT "payroll_payout_evidence_check" CHECK (
  content_type IN ('image/jpeg', 'image/png', 'image/webp') AND size_bytes > 0
  AND sha256 ~ '^[0-9a-f]{64}$' AND scan_status IN ('clean', 'not_scanned')
);

-- Evidence of a cash or bank payment waiting for confirmation: added by the signed-in user, at
-- most three per payment, never changed (the payout row lock serialises uploads).
CREATE FUNCTION app.guard_payroll_payout_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  po record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Payment evidence is never changed' USING ERRCODE = '23514';
  END IF;
  SELECT method, status INTO po FROM payroll_payouts
   WHERE tenant_id = NEW.tenant_id AND id = NEW.payout_id FOR UPDATE;
  IF NEW.uploaded_by IS DISTINCT FROM app.current_user_id() OR po.method IS NULL
     OR po.method = 'mpesa' OR po.status <> 'pending_confirmation'
     OR (SELECT count(*) FROM payroll_payout_evidence e
          WHERE e.tenant_id = NEW.tenant_id AND e.payout_id = NEW.payout_id) >= 3 THEN
    RAISE EXCEPTION 'At most three pieces of evidence, added to a payment awaiting confirmation'
      USING ERRCODE = '23514';
  END IF;
  NEW.uploaded_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER payroll_payout_evidence_guard BEFORE INSERT OR UPDATE OR DELETE
  ON "payroll_payout_evidence" FOR EACH ROW EXECUTE FUNCTION app.guard_payroll_payout_evidence();

-- Allocations --------------------------------------------------------------------------------------
ALTER TABLE "payroll_allocations" ADD CONSTRAINT "payroll_allocations_check" CHECK (
  (kind = 'payment' AND amount_minor > 0 AND reverses_allocation_id IS NULL)
  OR (kind = 'reversal' AND amount_minor < 0 AND reverses_allocation_id IS NOT NULL)
);

-- A confirmed payout allocates its whole amount once; a reversed payout takes it back once; the
-- obligation's allocations never exceed its amount nor go below zero (the obligation row lock
-- serialises them). Append-only.
CREATE FUNCTION app.guard_payroll_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ob record;
  po record;
  orig record;
  paid bigint;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'An allocation is never changed: it is reversed' USING ERRCODE = '23514';
  END IF;
  SELECT amount_minor INTO ob FROM payroll_obligations
   WHERE tenant_id = NEW.tenant_id AND id = NEW.obligation_id FOR UPDATE;
  SELECT status, amount_minor INTO po FROM payroll_payouts
   WHERE tenant_id = NEW.tenant_id AND id = NEW.payout_id;
  SELECT COALESCE(sum(a.amount_minor), 0) INTO paid FROM payroll_allocations a
   WHERE a.tenant_id = NEW.tenant_id AND a.obligation_id = NEW.obligation_id;
  IF NEW.kind = 'payment' THEN
    IF po.status IS DISTINCT FROM 'confirmed' OR NEW.amount_minor <> po.amount_minor
       OR paid + NEW.amount_minor > ob.amount_minor THEN
      RAISE EXCEPTION 'A confirmed payout allocates its amount, never beyond the obligation'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT kind, payout_id, amount_minor INTO orig FROM payroll_allocations
     WHERE tenant_id = NEW.tenant_id AND id = NEW.reverses_allocation_id;
    IF NOT FOUND OR po.status IS DISTINCT FROM 'reversed' OR orig.kind <> 'payment'
       OR orig.payout_id <> NEW.payout_id OR NEW.amount_minor <> -orig.amount_minor
       OR paid + NEW.amount_minor < 0 THEN
      RAISE EXCEPTION 'A reversal takes back its reversed payout''s allocation'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER payroll_allocation_guard BEFORE INSERT OR UPDATE OR DELETE ON "payroll_allocations"
  FOR EACH ROW EXECUTE FUNCTION app.guard_payroll_allocation();

-- The obligation recomputes its paid amount and status from its allocations.
CREATE FUNCTION app.apply_payroll_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE payroll_obligations SET version = version + 1
   WHERE tenant_id = NEW.tenant_id AND id = NEW.obligation_id;
  RETURN NULL;
END
$$;
CREATE TRIGGER payroll_allocation_apply AFTER INSERT ON "payroll_allocations"
  FOR EACH ROW EXECUTE FUNCTION app.apply_payroll_allocation();

-- Unusual-payout flags ---------------------------------------------------------------------------
ALTER TABLE "payroll_payout_flags" ADD CONSTRAINT "payroll_payout_flags_check" CHECK (
  code IN ('new_recipient_large', 'shared_number', 'outside_business_hours')
  AND status IN ('open', 'cleared') AND jsonb_typeof(details) = 'object'
  AND (status = 'cleared') = (cleared_by IS NOT NULL)
  AND (cleared_by IS NULL) = (cleared_at IS NULL)
  AND (cleared_by IS NULL) = (clear_reason IS NULL)
  AND (clear_reason IS NULL OR char_length(btrim(clear_reason)) BETWEEN 10 AND 500)
  AND (code = 'outside_business_hours') = (created_by IS NOT NULL)
  AND version >= 1
);
CREATE UNIQUE INDEX "payroll_payout_flags_one_open" ON "payroll_payout_flags"
  ("tenant_id", "obligation_id", "code") WHERE status = 'open';

-- A flag is raised open (at approval by the system, outside business hours by whoever tried to
-- start the payout) and cleared once by the signed-in user, who is neither a batch contributor nor
-- its approver nor (outside business hours) whoever tried to start the payout. Never deleted.
CREATE FUNCTION app.guard_payroll_payout_flag() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actor uuid := app.current_user_id();
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A flag is cleared, never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' OR NEW.version <> 1
       OR (NEW.created_by IS NOT NULL AND NEW.created_by IS DISTINCT FROM actor) THEN
      RAISE EXCEPTION 'A flag is raised open' USING ERRCODE = '23514';
    END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  IF OLD.status <> 'open' OR NEW.status <> 'cleared' OR NEW.cleared_by IS DISTINCT FROM actor
     OR NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
     OR NEW.obligation_id IS DISTINCT FROM OLD.obligation_id OR NEW.code IS DISTINCT FROM OLD.code
     OR NEW.details IS DISTINCT FROM OLD.details OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'A flag is cleared once, by the signed-in user' USING ERRCODE = '23514';
  END IF;
  IF actor = OLD.created_by OR EXISTS (
    SELECT 1 FROM payroll_batches b
     WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id
       AND (actor = ANY (b.contributors) OR actor = b.approved_by)
  ) THEN
    RAISE EXCEPTION 'A flag is cleared by someone independent of the batch' USING ERRCODE = '23514';
  END IF;
  NEW.cleared_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER payroll_payout_flag_guard BEFORE INSERT OR UPDATE OR DELETE
  ON "payroll_payout_flags" FOR EACH ROW EXECUTE FUNCTION app.guard_payroll_payout_flag();

-- Notifications ---------------------------------------------------------------------------------
ALTER TABLE "payroll_notifications" ADD CONSTRAINT "payroll_notifications_check" CHECK (
  kind IN ('payslip', 'number_change', 'approval_notice') AND channel IN ('sms', 'email')
  AND language IN ('en', 'sw') AND status IN ('queued', 'sent', 'failed') AND attempts >= 0
  AND recipient_key ~ '^[0-9a-f]{64}$' AND app.is_field_ciphertext(recipient_enc)
  AND char_length(subject_key) >= 1
  AND (target IS NULL OR target IN ('old_number', 'new_number'))
  AND (kind <> 'payslip' OR (obligation_id IS NOT NULL AND labourer_id IS NOT NULL
       AND channel = 'sms'))
  AND (kind <> 'number_change' OR (labourer_id IS NOT NULL AND target IS NOT NULL
       AND event_at IS NOT NULL AND channel = 'sms'))
  AND (kind <> 'approval_notice' OR (batch_id IS NOT NULL AND user_id IS NOT NULL))
  AND (status = 'sent') = (sent_at IS NOT NULL)
  AND (status = 'queued') = (next_attempt_at IS NOT NULL)
  AND (last_error_code IS NULL OR last_error_code IN ('provider_unavailable', 'provider_rejected',
       'recipient_invalid', 'render_failed', 'too_long', 'timeout'))
  AND version >= 1
);

-- A notification is queued once per kind, subject and recipient; afterwards only its delivery
-- state moves: queued → sent | failed, a retry stays queued, and a manual resend re-queues a
-- failed one. What it says and to whom never changes; nothing is deleted.
CREATE FUNCTION app.guard_payroll_notification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A notification is never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'queued' OR NEW.attempts <> 0 OR NEW.version <> 1 THEN
      RAISE EXCEPTION 'A notification starts queued' USING ERRCODE = '23514';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.subject_key IS DISTINCT FROM OLD.subject_key
     OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
     OR NEW.obligation_id IS DISTINCT FROM OLD.obligation_id
     OR NEW.labourer_id IS DISTINCT FROM OLD.labourer_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.target IS DISTINCT FROM OLD.target OR NEW.event_at IS DISTINCT FROM OLD.event_at
     OR NEW.channel IS DISTINCT FROM OLD.channel
     OR NEW.recipient_enc IS DISTINCT FROM OLD.recipient_enc
     OR NEW.recipient_key IS DISTINCT FROM OLD.recipient_key
     OR NEW.recipient_masked IS DISTINCT FROM OLD.recipient_masked
     OR NEW.language IS DISTINCT FROM OLD.language
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.version <> OLD.version + 1
     OR OLD.status = 'sent'
     OR (OLD.status = 'failed' AND (NEW.status <> 'queued' OR NEW.attempts <> 0)) THEN
    RAISE EXCEPTION 'A notification keeps what it says and to whom' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER payroll_notification_guard BEFORE INSERT OR DELETE
  ON "payroll_notifications" FOR EACH ROW EXECUTE FUNCTION app.guard_payroll_notification();
CREATE TRIGGER payroll_notification_guard_update BEFORE UPDATE ON "payroll_notifications"
  FOR EACH ROW
  WHEN (NOT app.is_field_rewrap(to_jsonb(OLD) - 'recipient_enc', to_jsonb(NEW) - 'recipient_enc',
    OLD.recipient_enc, NEW.recipient_enc))
  EXECUTE FUNCTION app.guard_payroll_notification();

-- Due notifications (company and ID only) at `p_now` (default now; tests look ahead to exercise
-- the retry backoff), oldest first; inside a company context only that company's. The dispatcher
-- claims each one in its company's context (FOR UPDATE SKIP LOCKED).
CREATE FUNCTION app.due_payroll_notifications(p_limit integer, p_now timestamptz)
  RETURNS TABLE (tenant_id uuid, id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT n.tenant_id, n.id
    FROM public.payroll_notifications n
   WHERE n.status = 'queued' AND n.next_attempt_at <= COALESCE(p_now, now())
     AND (app.current_tenant_id() IS NULL OR n.tenant_id = app.current_tenant_id())
   ORDER BY n.next_attempt_at, n.id
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 1), 1), 200)
$$;

-- The cost ledger: payroll sources (D4.3, CR-SPD-05 proposed policy) ---------------------------------
-- What an approved line's gross costs, per BQ item its earnings reach: piece-rate earnings whose
-- output names a piece-rate job (D6.3 part B) or a BQ item, on that item; everything else without
-- one. The API posts exactly these groups and app.check_cost_entry accepts nothing else.
CREATE FUNCTION app.payroll_line_cost_groups(p_tenant uuid, p_line uuid)
  RETURNS TABLE (bq_version_id uuid, bq_item_lineage_id uuid, amount_minor bigint)
  LANGUAGE sql STABLE AS $$
  SELECT COALESCE(j.bq_version_id, i.version_id), COALESCE(j.bq_item_lineage_id, i.lineage_id),
         sum(e.amount_minor)::bigint
    FROM payroll_earnings e
    LEFT JOIN piece_rate_output_shares s ON s.tenant_id = e.tenant_id AND s.id = e.share_id
    LEFT JOIN piece_rate_outputs o ON o.tenant_id = s.tenant_id AND o.id = s.output_id
    LEFT JOIN piece_rate_jobs j ON j.tenant_id = o.tenant_id AND j.id = o.job_id
    LEFT JOIN bq_items i ON i.tenant_id = o.tenant_id AND i.id = o.bq_item_id
   WHERE e.tenant_id = p_tenant AND e.line_id = p_line
   GROUP BY 1, 2
$$;

ALTER TABLE "cost_entries" DROP CONSTRAINT "cost_entries_check";
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_check" CHECK (
  measure IN ('accrued', 'paid') AND amount_minor <> 0
  AND category IN ('materials', 'labour', 'plant', 'subcontract', 'preliminaries', 'fees',
                   'permits', 'transport', 'petty_cash')
  AND counterparty_kind IN ('supplier', 'worker', 'other', 'none')
  AND (counterparty_kind = 'supplier') = (supplier_id IS NOT NULL)
  AND (counterparty_kind <> 'none' OR counterparty_name IS NULL)
  AND (bq_version_id IS NULL) = (bq_item_lineage_id IS NULL)
  AND (reverses_entry_id IS NOT NULL) = (purpose = 'reversal')
  AND (source IN ('subcontract_certificate', 'subcontract_payment', 'subcontract_advance')
       OR num_nonnulls(subcontract_certificate_id, subcontract_line_id, subcontract_payment_id,
                       subcontract_advance_id) = 0)
  AND (source IN ('payroll_line', 'payroll_payout')
       OR num_nonnulls(payroll_line_id, payroll_payout_id) = 0)
  AND COALESCE(CASE source
    WHEN 'supplier_invoice' THEN invoice_id IS NOT NULL AND settlement_id IS NULL
      AND num_nonnulls(expense_id, float_count_id, journal_id, journal_line_id) = 0
      AND purpose = 'accrual' AND measure = 'accrued'
    WHEN 'invoice_settlement' THEN invoice_id IS NOT NULL AND settlement_id IS NOT NULL
      AND num_nonnulls(expense_id, float_count_id, journal_id, journal_line_id) = 0
      AND purpose = 'payment' AND measure = 'paid'
    WHEN 'petty_cash_expense' THEN expense_id IS NOT NULL
      AND num_nonnulls(invoice_id, settlement_id, float_count_id, journal_id, journal_line_id) = 0
      AND ((purpose IN ('accrual', 'charge_accrual') AND measure = 'accrued')
           OR (purpose IN ('payment', 'charge_payment') AND measure = 'paid'))
    WHEN 'petty_cash_count' THEN float_count_id IS NOT NULL
      AND num_nonnulls(invoice_id, settlement_id, expense_id, journal_id, journal_line_id) = 0
      AND ((purpose = 'variance_accrual' AND measure = 'accrued')
           OR (purpose = 'variance_payment' AND measure = 'paid'))
    WHEN 'cost_journal' THEN journal_id IS NOT NULL AND journal_line_id IS NOT NULL
      AND num_nonnulls(invoice_id, settlement_id, expense_id, float_count_id) = 0
      AND purpose IN ('journal', 'reversal')
    WHEN 'subcontract_certificate' THEN subcontract_certificate_id IS NOT NULL
      AND subcontract_line_id IS NOT NULL
      AND num_nonnulls(invoice_id, settlement_id, expense_id, float_count_id, journal_id,
                       journal_line_id, subcontract_payment_id, subcontract_advance_id) = 0
      AND purpose = 'accrual' AND measure = 'accrued' AND category = 'subcontract'
      AND bq_item_lineage_id IS NOT NULL
    WHEN 'subcontract_payment' THEN subcontract_payment_id IS NOT NULL
      AND num_nonnulls(invoice_id, settlement_id, expense_id, float_count_id, journal_id,
                       journal_line_id, subcontract_certificate_id, subcontract_line_id,
                       subcontract_advance_id) = 0
      AND purpose = 'payment' AND measure = 'paid' AND category = 'subcontract'
    WHEN 'subcontract_advance' THEN subcontract_advance_id IS NOT NULL
      AND num_nonnulls(invoice_id, settlement_id, expense_id, float_count_id, journal_id,
                       journal_line_id, subcontract_certificate_id, subcontract_line_id,
                       subcontract_payment_id) = 0
      AND purpose = 'payment' AND measure = 'paid' AND category = 'subcontract'
    WHEN 'payroll_line' THEN payroll_line_id IS NOT NULL AND payroll_payout_id IS NULL
      AND num_nonnulls(invoice_id, settlement_id, expense_id, float_count_id, journal_id,
                       journal_line_id) = 0
      AND purpose IN ('accrual', 'employer_accrual') AND measure = 'accrued'
      AND category = 'labour' AND counterparty_kind = 'worker'
    WHEN 'payroll_payout' THEN payroll_payout_id IS NOT NULL AND payroll_line_id IS NULL
      AND num_nonnulls(invoice_id, settlement_id, expense_id, float_count_id, journal_id,
                       journal_line_id) = 0
      AND ((purpose IN ('payment', 'reversal') AND measure = 'paid' AND category = 'labour')
           OR (purpose = 'charge_accrual' AND measure = 'accrued' AND category = 'fees')
           OR (purpose = 'charge_payment' AND measure = 'paid' AND category = 'fees'))
    ELSE false
  END, false)
);
-- Each payroll source posts once per purpose (and BQ item, for a line's gross).
CREATE UNIQUE INDEX "cost_entries_payroll_line_once" ON "cost_entries"
  ("tenant_id", "payroll_line_id", "purpose", "bq_version_id", "bq_item_lineage_id")
  NULLS NOT DISTINCT WHERE source = 'payroll_line';
CREATE UNIQUE INDEX "cost_entries_payroll_payout_once" ON "cost_entries"
  ("tenant_id", "payroll_payout_id", "purpose") WHERE payroll_payout_id IS NOT NULL;

-- app.check_cost_entry gains the payroll sources (the rest is unchanged from D6.3 part B): an
-- approved line accrues its gross per BQ group (app.payroll_line_cost_groups) and its employer
-- statutory cost, as labour for the worker on the pay date; a confirmed payout pays its amount as
-- labour (reference: receipt or bank/cash reference, on its paid date) and, for M-Pesa, accrues
-- and pays the tariff charge booked on it as fees; a reversed payout reverses its payment entry.
CREATE OR REPLACE FUNCTION app.check_cost_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  src record;
  orig cost_entries%ROWTYPE;
  settled_before bigint;
  expected bigint;
  charge boolean;
BEGIN
  IF NEW.recorded_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A cost entry is recorded by the signed-in user' USING ERRCODE = '23514';
  END IF;
  NEW.recorded_at := clock_timestamp();
  NEW.business_date := app.business_today();
  IF NEW.source = 'supplier_invoice' THEN
    SELECT i.project_id, i.status, i.subtotal_minor, i.supplier_id, i.invoice_date,
           i.invoice_number, l.delivery_site_id
      INTO src
      FROM supplier_invoices i JOIN lpos l ON l.tenant_id = i.tenant_id AND l.id = i.lpo_id
     WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.invoice_id;
    IF NOT FOUND OR src.status NOT IN ('approved', 'partly_settled', 'settled')
       OR src.project_id <> NEW.project_id OR NEW.amount_minor <> src.subtotal_minor
       OR NEW.category <> 'materials' OR NEW.supplier_id IS DISTINCT FROM src.supplier_id
       OR NEW.occurred_on <> src.invoice_date
       OR NEW.payment_reference IS DISTINCT FROM src.invoice_number
       OR NEW.site_id IS DISTINCT FROM src.delivery_site_id
       OR NEW.bq_item_lineage_id IS NOT NULL OR NEW.cost_code_id IS NOT NULL THEN
      RAISE EXCEPTION 'An invoice accrual posts the approved invoice''s subtotal (materials, held in stores)'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.source = 'invoice_settlement' THEN
    SELECT s.id, s.amount_minor, s.paid_on, s.external_reference, s.recorded_at,
           i.project_id, i.subtotal_minor, i.total_minor, i.supplier_id, l.delivery_site_id
      INTO src
      FROM invoice_settlements s
      JOIN supplier_invoices i ON i.tenant_id = s.tenant_id AND i.id = s.invoice_id
      JOIN lpos l ON l.tenant_id = i.tenant_id AND l.id = i.lpo_id
     WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.settlement_id
       AND s.invoice_id = NEW.invoice_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'A payment entry names a recorded settlement' USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(sum(amount_minor), 0) INTO settled_before FROM invoice_settlements
     WHERE tenant_id = NEW.tenant_id AND invoice_id = NEW.invoice_id
       AND (recorded_at, id) < (src.recorded_at, src.id);
    expected := app.settlement_cost_minor(src.subtotal_minor, src.total_minor, settled_before,
                                          src.amount_minor);
    IF src.project_id <> NEW.project_id OR NEW.amount_minor <> expected
       OR NEW.category <> 'materials' OR NEW.supplier_id IS DISTINCT FROM src.supplier_id
       OR NEW.occurred_on <> src.paid_on
       OR NEW.payment_reference IS DISTINCT FROM src.external_reference
       OR NEW.site_id IS DISTINCT FROM src.delivery_site_id
       OR NEW.bq_item_lineage_id IS NOT NULL OR NEW.cost_code_id IS NOT NULL THEN
      RAISE EXCEPTION 'A payment entry posts the cost part of its settlement' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.source = 'petty_cash_expense' THEN
    SELECT e.* INTO src FROM petty_cash_expenses e
     WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.expense_id;
    charge := NEW.purpose IN ('charge_accrual', 'charge_payment');
    IF NOT FOUND OR src.status <> 'approved' OR src.project_id <> NEW.project_id
       OR NEW.amount_minor <> (CASE WHEN charge THEN src.charge_minor ELSE src.amount_minor END)
       OR NEW.category <> (CASE WHEN charge THEN 'fees' ELSE src.category END)
       OR NEW.site_id IS DISTINCT FROM src.site_id
       OR NEW.cost_code_id IS DISTINCT FROM src.cost_code_id
       OR (NEW.bq_version_id, NEW.bq_item_lineage_id)
          IS DISTINCT FROM (src.bq_version_id, src.bq_item_lineage_id)
       OR NEW.counterparty_kind <> src.counterparty_kind
       OR NEW.supplier_id IS DISTINCT FROM src.supplier_id
       OR NEW.counterparty_name IS DISTINCT FROM src.payee_name
       OR NEW.payment_reference IS DISTINCT FROM src.mpesa_code
       OR NEW.occurred_on <> src.spent_on THEN
      RAISE EXCEPTION 'An expense posts its approved amount and tags' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.source = 'petty_cash_count' THEN
    SELECT c.project_id, c.status, c.variance_minor, c.counted_at, f.site_id INTO src
      FROM petty_cash_counts c
      JOIN petty_cash_floats f ON f.tenant_id = c.tenant_id AND f.id = c.float_id
     WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.float_count_id;
    IF NOT FOUND OR src.status <> 'approved' OR src.project_id <> NEW.project_id
       OR NEW.amount_minor <> -src.variance_minor OR NEW.category <> 'petty_cash'
       OR NEW.site_id IS DISTINCT FROM src.site_id OR NEW.counterparty_kind <> 'none'
       OR NEW.occurred_on <> (src.counted_at AT TIME ZONE 'Africa/Nairobi')::date
       OR NEW.bq_item_lineage_id IS NOT NULL OR NEW.cost_code_id IS NOT NULL
       OR NEW.payment_reference IS NOT NULL THEN
      RAISE EXCEPTION 'A count posts its approved variance as petty-cash cost' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.source = 'subcontract_certificate' THEN
    SELECT c.project_id, c.status, c.valuation_date, c.certificate_number, s.supplier_id,
           s.number, cl.value_to_date_minor - cl.previous_minor AS amount, l.bq_version_id,
           l.bq_item_lineage_id
      INTO src
      FROM subcontract_certificates c
      JOIN subcontracts s ON s.tenant_id = c.tenant_id AND s.id = c.subcontract_id
      JOIN subcontract_certificate_lines cl ON cl.tenant_id = c.tenant_id
       AND cl.certificate_id = c.id AND cl.revision = c.revision
       AND cl.line_id = NEW.subcontract_line_id
      JOIN subcontract_lines l ON l.tenant_id = cl.tenant_id AND l.id = cl.line_id
     WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.subcontract_certificate_id;
    IF NOT FOUND OR src.status <> 'certified' OR src.project_id <> NEW.project_id
       OR NEW.amount_minor <> src.amount OR NEW.category <> 'subcontract'
       OR NEW.supplier_id IS DISTINCT FROM src.supplier_id
       OR NEW.occurred_on <> src.valuation_date
       OR NEW.payment_reference IS DISTINCT FROM
          app.subcontract_certificate_reference(src.number, src.certificate_number)
       OR (NEW.bq_version_id, NEW.bq_item_lineage_id)
          IS DISTINCT FROM (src.bq_version_id, src.bq_item_lineage_id)
       OR NEW.site_id IS NOT NULL OR NEW.cost_code_id IS NOT NULL THEN
      RAISE EXCEPTION 'A subcontract certificate posts the work certified on each line this period'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.source = 'subcontract_payment' THEN
    SELECT p.id, p.certificate_id, p.amount_minor, p.paid_on, p.reference, p.recorded_at,
           p.project_id, c.amount_due_minor, c.payable_minor, s.supplier_id
      INTO src
      FROM subcontract_payments p
      JOIN subcontract_certificates c ON c.tenant_id = p.tenant_id AND c.id = p.certificate_id
      JOIN subcontracts s ON s.tenant_id = p.tenant_id AND s.id = p.subcontract_id
     WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.subcontract_payment_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'A payment entry names a recorded payment' USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(sum(amount_minor), 0) INTO settled_before FROM subcontract_payments
     WHERE tenant_id = NEW.tenant_id AND certificate_id = src.certificate_id
       AND (recorded_at, id) < (src.recorded_at, src.id);
    expected := app.settlement_cost_minor(src.amount_due_minor, src.payable_minor,
                                          settled_before, src.amount_minor);
    IF src.project_id <> NEW.project_id OR NEW.amount_minor <> expected
       OR NEW.category <> 'subcontract' OR NEW.supplier_id IS DISTINCT FROM src.supplier_id
       OR NEW.occurred_on <> src.paid_on OR NEW.payment_reference IS DISTINCT FROM src.reference
       OR NEW.bq_item_lineage_id IS NOT NULL OR NEW.cost_code_id IS NOT NULL
       OR NEW.site_id IS NOT NULL THEN
      RAISE EXCEPTION 'A subcontract payment posts the cost part of the cash paid'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.source = 'subcontract_advance' THEN
    SELECT a.project_id, a.status, a.amount_minor, a.paid_on, a.reference, s.supplier_id
      INTO src
      FROM subcontract_advances a
      JOIN subcontracts s ON s.tenant_id = a.tenant_id AND s.id = a.subcontract_id
     WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.subcontract_advance_id;
    IF NOT FOUND OR src.status <> 'paid' OR src.project_id <> NEW.project_id
       OR NEW.amount_minor <> src.amount_minor OR NEW.category <> 'subcontract'
       OR NEW.supplier_id IS DISTINCT FROM src.supplier_id OR NEW.occurred_on <> src.paid_on
       OR NEW.payment_reference IS DISTINCT FROM src.reference
       OR NEW.bq_item_lineage_id IS NOT NULL OR NEW.cost_code_id IS NOT NULL
       OR NEW.site_id IS NOT NULL THEN
      RAISE EXCEPTION 'An advance posts the amount paid to the subcontractor'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.source = 'payroll_line' THEN
    SELECT l.project_id, l.full_name, l.employer_cost_minor, b.status, b.pay_date INTO src
      FROM payroll_lines l JOIN payroll_batches b ON b.tenant_id = l.tenant_id AND b.id = l.batch_id
     WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.payroll_line_id;
    IF NOT FOUND OR src.status NOT IN ('approved', 'disbursing', 'partially_settled', 'settled')
       OR src.project_id <> NEW.project_id
       OR NEW.counterparty_name IS DISTINCT FROM left(src.full_name, 200)
       OR NEW.occurred_on <> src.pay_date OR NEW.payment_reference IS NOT NULL
       OR NEW.site_id IS NOT NULL OR NEW.cost_code_id IS NOT NULL THEN
      RAISE EXCEPTION 'A payroll accrual posts its approved line as labour on the pay date'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.purpose = 'employer_accrual' THEN
      expected := src.employer_cost_minor;
      IF NEW.bq_item_lineage_id IS NOT NULL THEN
        expected := NULL;
      END IF;
    ELSE
      SELECT g.amount_minor INTO expected
        FROM app.payroll_line_cost_groups(NEW.tenant_id, NEW.payroll_line_id) g
       WHERE (g.bq_version_id, g.bq_item_lineage_id)
             IS NOT DISTINCT FROM (NEW.bq_version_id, NEW.bq_item_lineage_id);
    END IF;
    IF expected IS NULL OR NEW.amount_minor <> expected THEN
      RAISE EXCEPTION 'A payroll accrual posts the line''s gross per BQ item and its employer cost'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.source = 'payroll_payout' THEN
    SELECT p.project_id, p.method, p.status, p.amount_minor, p.charge_minor, p.receipt,
           p.reference, p.paid_on, l.full_name
      INTO src
      FROM payroll_payouts p
      JOIN payroll_obligations o ON o.tenant_id = p.tenant_id AND o.id = p.obligation_id
      JOIN payroll_lines l ON l.tenant_id = o.tenant_id AND l.id = o.line_id
     WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.payroll_payout_id;
    IF NOT FOUND OR src.project_id <> NEW.project_id OR NEW.site_id IS NOT NULL
       OR NEW.cost_code_id IS NOT NULL OR NEW.bq_item_lineage_id IS NOT NULL
       OR src.status NOT IN ('confirmed', 'reversed') OR NEW.occurred_on <> src.paid_on THEN
      RAISE EXCEPTION 'A payout posts once it is confirmed, on its paid date' USING ERRCODE = '23514';
    END IF;
    IF NEW.purpose = 'payment' THEN
      IF NEW.amount_minor <> src.amount_minor OR NEW.counterparty_kind <> 'worker'
         OR NEW.counterparty_name IS DISTINCT FROM left(src.full_name, 200)
         OR NEW.payment_reference IS DISTINCT FROM COALESCE(src.receipt, src.reference) THEN
        RAISE EXCEPTION 'A payout pays its amount to the worker as labour' USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.purpose IN ('charge_accrual', 'charge_payment') THEN
      IF src.method <> 'mpesa' OR src.charge_minor IS NULL
         OR NEW.amount_minor <> src.charge_minor OR NEW.counterparty_kind <> 'other'
         OR NEW.counterparty_name IS DISTINCT FROM 'Safaricom M-Pesa'
         OR NEW.payment_reference IS DISTINCT FROM src.receipt THEN
        RAISE EXCEPTION 'An M-Pesa charge posts the tariff estimate booked on its payout'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      SELECT * INTO orig FROM cost_entries
       WHERE tenant_id = NEW.tenant_id AND id = NEW.reverses_entry_id;
      IF NOT FOUND OR src.status <> 'reversed' OR orig.source <> 'payroll_payout'
         OR orig.purpose <> 'payment' OR orig.payroll_payout_id <> NEW.payroll_payout_id
         OR NEW.amount_minor <> -orig.amount_minor OR NEW.measure <> orig.measure
         OR NEW.category <> orig.category
         OR NEW.counterparty_kind <> orig.counterparty_kind
         OR NEW.counterparty_name IS DISTINCT FROM orig.counterparty_name
         OR NEW.payment_reference IS DISTINCT FROM orig.payment_reference
         OR NEW.occurred_on <> orig.occurred_on THEN
        RAISE EXCEPTION 'A payout reversal mirrors its payment entry' USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSE
    SELECT j.project_id, j.status, j.kind, l.* INTO src
      FROM cost_journal_lines l
      JOIN cost_journals j ON j.tenant_id = l.tenant_id AND j.id = l.journal_id
     WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.journal_line_id
       AND l.journal_id = NEW.journal_id;
    IF NOT FOUND OR src.status <> 'approved' OR src.project_id <> NEW.project_id
       OR NEW.amount_minor <> src.amount_minor OR NEW.measure <> src.measure
       OR NEW.category <> src.category OR NEW.site_id IS DISTINCT FROM src.site_id
       OR NEW.cost_code_id IS DISTINCT FROM src.cost_code_id
       OR (NEW.bq_version_id, NEW.bq_item_lineage_id)
          IS DISTINCT FROM (src.bq_version_id, src.bq_item_lineage_id)
       OR NEW.counterparty_kind <> src.counterparty_kind
       OR NEW.supplier_id IS DISTINCT FROM src.supplier_id
       OR NEW.counterparty_name IS DISTINCT FROM src.counterparty_name
       OR NEW.payment_reference IS DISTINCT FROM src.payment_reference
       OR NEW.occurred_on <> src.occurred_on
       OR NEW.reverses_entry_id IS DISTINCT FROM src.reverses_entry_id
       OR (NEW.purpose = 'reversal') <> (src.kind = 'reversal') THEN
      RAISE EXCEPTION 'A journal entry posts its approved line' USING ERRCODE = '23514';
    END IF;
    IF NEW.purpose = 'reversal' THEN
      SELECT * INTO orig FROM cost_entries
       WHERE tenant_id = NEW.tenant_id AND id = NEW.reverses_entry_id;
      IF NOT FOUND OR orig.purpose = 'reversal' OR orig.project_id <> NEW.project_id
         OR NEW.amount_minor <> -orig.amount_minor OR NEW.measure <> orig.measure
         OR NEW.category <> orig.category OR NEW.site_id IS DISTINCT FROM orig.site_id
         OR NEW.cost_code_id IS DISTINCT FROM orig.cost_code_id
         OR (NEW.bq_version_id, NEW.bq_item_lineage_id)
            IS DISTINCT FROM (orig.bq_version_id, orig.bq_item_lineage_id)
         OR NEW.counterparty_kind <> orig.counterparty_kind
         OR NEW.supplier_id IS DISTINCT FROM orig.supplier_id
         OR NEW.counterparty_name IS DISTINCT FROM orig.counterparty_name
         OR NEW.payment_reference IS DISTINCT FROM orig.payment_reference
         OR NEW.occurred_on <> orig.occurred_on THEN
        RAISE EXCEPTION 'A reversal mirrors the entry it reverses' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- Row-level security -----------------------------------------------------------------------------
-- Every new table: the standard company policy, and the restrictive staff-only policy of
-- 20261204091000_payments_portal_isolation (client, supplier and client-only custom role members
-- read and write none of it). The notification dispatcher's definer function reads due rows
-- through a SELECT policy granted to the schema owner alone.
DO $$
DECLARE
  staff constant text := 'NOT EXISTS (SELECT 1 FROM memberships m '
    'LEFT JOIN tenant_roles r ON r.tenant_id = m.tenant_id AND r.id = m.custom_role_id '
    'WHERE m.tenant_id = app.current_tenant_id() AND m.user_id = app.current_user_id() '
    'AND (m.role IN (''client'', ''supplier'') OR (m.role = ''custom'' '
    'AND ''portal.client'' = ANY (r.permissions) '
    'AND r.permissions <@ ARRAY[''projects.view'', ''bq.view'', ''portal.client'']::text[])))';
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['payroll_batch_decisions', 'payroll_obligations',
    'payroll_carry_forwards', 'payroll_payouts', 'payroll_payout_evidence', 'payroll_allocations',
    'payroll_payout_flags', 'labourer_payout_verifications', 'labourer_payout_holds',
    'labourer_change_hold_overrides', 'payout_settings', 'payroll_approval_limits',
    'payroll_notifications', 'payment_tariff_versions']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = app.current_tenant_id()) '
      'WITH CHECK (tenant_id = app.current_tenant_id())', target || '_isolation', target);
    EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE USING (%s) WITH CHECK (%s)',
      target || '_staff_only', target, staff, staff);
  END LOOP;
  EXECUTE format('CREATE POLICY payroll_notifications_dispatch ON payroll_notifications '
    'FOR SELECT TO %I USING (true)', current_user);
END
$$;

-- The runtime role never deletes payout history (approval limits aside: a set is replaced whole)
-- and never rewrites the append-only tables.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmb_app') THEN
    REVOKE UPDATE, DELETE ON "payroll_batch_decisions", "payroll_carry_forwards",
      "payroll_allocations", "payroll_payout_evidence", "labourer_payout_verifications",
      "labourer_change_hold_overrides", "payment_tariff_versions" FROM pmb_app;
    REVOKE DELETE ON "payroll_obligations", "payroll_payouts", "payroll_payout_flags",
      "labourer_payout_holds", "payroll_notifications", "payout_settings" FROM pmb_app;
    REVOKE TRUNCATE, REFERENCES, TRIGGER ON "payroll_batch_decisions", "payroll_obligations",
      "payroll_carry_forwards", "payroll_payouts", "payroll_payout_evidence",
      "payroll_allocations", "payroll_payout_flags", "labourer_payout_verifications",
      "labourer_payout_holds", "labourer_change_hold_overrides", "payout_settings",
      "payroll_approval_limits", "payroll_notifications", "payment_tariff_versions" FROM pmb_app;
    GRANT EXECUTE ON FUNCTION app.due_payroll_notifications(integer, timestamptz) TO pmb_app;
    GRANT EXECUTE ON FUNCTION app.payroll_line_cost_groups(uuid, uuid) TO pmb_app;
  END IF;
END
$$;
REVOKE EXECUTE ON FUNCTION app.due_payroll_notifications(integer, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.payroll_line_cost_groups(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.track_labourer_phone() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_payroll_batch_decision() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_labourer_payout_verification() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_labourer_payout_hold() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_labourer_change_hold_override() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_payout_settings() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.stamp_payroll_approval_limit() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_payment_tariff_version() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_payroll_obligation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_payroll_carry_forward() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_payroll_payout() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_payroll_payout_evidence() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_payroll_allocation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.apply_payroll_allocation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_payroll_payout_flag() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_payroll_notification() FROM PUBLIC;

COMMIT;
