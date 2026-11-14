-- D6.3 part B: subcontracts, subcontract payment certificates, advances and piece-rate jobs
-- (ARCHITECTURE §4.16, ERD, WORKFLOWS "Subcontracts", "Subcontract certificates", "Subcontract
-- advances" and "Piece-rate jobs", brief §5.14 and §15 C/G). Enforces, in the database as well as
-- the API:
-- * A SUBCONTRACTOR IS A SUPPLIER (decision D-140): suppliers gain is_subcontractor; a subcontract
--   names an active supplier with the flag.
-- * SUBCONTRACTS ARE MAKER-CHECKED AND FROZEN: draft → submitted (digest) → approved by someone who
--   never contributed → active → completed | terminated (reason); terms never change after
--   submission and lines only through append-only, independently approved variations (versions).
-- * NO BQ QUANTITY IS LET TWICE: the live subcontract lines on a BQ item never exceed the item's
--   quantity in the BQ in force (100 % for a lump sum) without an exception reason, checked under
--   an advisory lock per item when a subcontract or a variation is approved.
-- * NO MEASURED QUANTITY IS PAID TWICE: a certificate's quantities to date never exceed its lines
--   and, per BQ item, the latest claims of every subcontract never exceed the item's APPROVED D6.3
--   measured quantity (advisory lock per item, checked at commit of submission and certification).
-- * CERTIFICATES FOLLOW RULE KE-SUB-1 (recomputed by a CHECK), are certified by someone who never
--   contributed, never change once certified, and post their work once to the cost ledger
--   (category subcontract, per BQ item); payments and advances recorded as paid post the cash
--   once; a subcontractor's tax invoice matched to a certificate posts nothing and can never also
--   be a procure-to-pay supplier invoice (decision D-145).
-- * ADVANCES are maker-checked (requested → approved → paid by three different people), never above
--   the agreed advance, and certificates never recover more than was paid.
-- * PIECE-RATE JOBS (decision D-147): approved by someone other than the creator; output recorded
--   against a job takes its rate, unit, worker and BQ item, falls within its dates, and the
--   approved output on a job never exceeds its agreed quantity plus approved extensions (the job
--   row is locked, so two outputs cannot race past it).
-- Every new table has tenant_id, forced RLS with WITH CHECK, a restrictive policy that keeps
-- supplier-role members out, and composite (tenant_id, …) foreign keys; pmb_app holds no DELETE
-- (except draft lines and claims) and no UPDATE on append-only tables. No permission was added.
BEGIN;

-- AlterTable
ALTER TABLE "cost_entries" ADD COLUMN     "subcontract_advance_id" UUID,
ADD COLUMN     "subcontract_certificate_id" UUID,
ADD COLUMN     "subcontract_line_id" UUID,
ADD COLUMN     "subcontract_payment_id" UUID,
ALTER COLUMN "source" SET DATA TYPE VARCHAR(30);

-- AlterTable
ALTER TABLE "piece_rate_outputs" ADD COLUMN     "job_id" UUID;

-- AlterTable
ALTER TABLE "suppliers" ADD COLUMN     "is_subcontractor" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "subcontracts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "supplier_id" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "scope" VARCHAR(2000),
    "status" VARCHAR(12) NOT NULL DEFAULT 'draft',
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "retention_percent" DECIMAL(5,2) NOT NULL,
    "retention_limit_percent" DECIMAL(5,2),
    "practical_release_percent" DECIMAL(5,2) NOT NULL,
    "vat_percent" DECIMAL(5,2) NOT NULL,
    "wht_percent" DECIMAL(5,2) NOT NULL,
    "advance_limit_minor" BIGINT NOT NULL DEFAULT 0,
    "advance_recovery_percent" DECIMAL(5,2) NOT NULL,
    "payment_terms_days" INTEGER NOT NULL,
    "payment_terms_note" VARCHAR(500),
    "contract_version" INTEGER NOT NULL DEFAULT 0,
    "original_value_minor" BIGINT,
    "current_value_minor" BIGINT,
    "digest" CHAR(64),
    "contributors" UUID[] DEFAULT ARRAY[]::UUID[],
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_by" UUID,
    "submitted_at" TIMESTAMPTZ,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ,
    "activated_by" UUID,
    "activated_at" TIMESTAMPTZ,
    "closed_by" UUID,
    "closed_at" TIMESTAMPTZ,
    "close_reason" VARCHAR(500),
    "cancelled_by" UUID,
    "cancelled_at" TIMESTAMPTZ,
    "cancel_reason" VARCHAR(500),
    "return_reason" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "subcontracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subcontract_lines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "subcontract_id" UUID NOT NULL,
    "variation_id" UUID,
    "line_no" INTEGER NOT NULL,
    "bq_version_id" UUID NOT NULL,
    "bq_item_lineage_id" UUID NOT NULL,
    "basis" VARCHAR(10) NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "unit" VARCHAR(20),
    "quantity" DECIMAL(20,4) NOT NULL,
    "rate_minor" BIGINT,
    "amount_minor" BIGINT NOT NULL,
    "vat_treatment" VARCHAR(12) NOT NULL,
    "over_quantity_reason" VARCHAR(500),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subcontract_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subcontract_variations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "subcontract_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'pending',
    "value_change_minor" BIGINT NOT NULL,
    "digest" CHAR(64) NOT NULL,
    "resulting_version" INTEGER,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ,
    "decision_reason" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "subcontract_variations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subcontract_line_changes" (
    "tenant_id" UUID NOT NULL,
    "subcontract_id" UUID NOT NULL,
    "variation_id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "quantity_change" DECIMAL(20,4) NOT NULL,
    "amount_change_minor" BIGINT NOT NULL,
    "over_quantity_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subcontract_line_changes_pkey" PRIMARY KEY ("tenant_id","variation_id","line_id")
);

-- CreateTable
CREATE TABLE "subcontract_advances" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "subcontract_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'requested',
    "requested_by" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ,
    "decision_note" VARCHAR(500),
    "paid_by" UUID,
    "paid_at" TIMESTAMPTZ,
    "paid_on" DATE,
    "method" VARCHAR(15),
    "reference" VARCHAR(60),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "subcontract_advances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subcontract_certificates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "subcontract_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "certificate_number" INTEGER,
    "kind" VARCHAR(20) NOT NULL,
    "release_stage" VARCHAR(10),
    "status" VARCHAR(10) NOT NULL DEFAULT 'draft',
    "valuation_date" DATE NOT NULL,
    "notes" VARCHAR(1000),
    "revision" INTEGER NOT NULL DEFAULT 0,
    "rule_version" VARCHAR(20),
    "contract_version" INTEGER,
    "retention_percent" DECIMAL(5,2),
    "retention_limit_percent" DECIMAL(5,2),
    "practical_release_percent" DECIMAL(5,2),
    "vat_percent" DECIMAL(5,2),
    "wht_percent" DECIMAL(5,2),
    "advance_recovery_percent" DECIMAL(5,2),
    "original_value_minor" BIGINT,
    "work_done_minor" BIGINT,
    "vatable_work_done_minor" BIGINT,
    "retention_stage" VARCHAR(10),
    "retention_limit_minor" BIGINT,
    "retention_computed_minor" BIGINT,
    "retention_held_minor" BIGINT,
    "advances_paid_minor" BIGINT,
    "recovered_to_date_minor" BIGINT,
    "net_to_date_minor" BIGINT,
    "previous_certified_minor" BIGINT,
    "amount_due_minor" BIGINT,
    "vat_minor" BIGINT,
    "wht_minor" BIGINT,
    "payable_minor" BIGINT,
    "line_count" INTEGER NOT NULL DEFAULT 0,
    "digest" CHAR(64),
    "contributors" UUID[] DEFAULT ARRAY[]::UUID[],
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_by" UUID,
    "submitted_at" TIMESTAMPTZ,
    "certified_by" UUID,
    "certified_at" TIMESTAMPTZ,
    "cancelled_by" UUID,
    "cancelled_at" TIMESTAMPTZ,
    "cancel_reason" VARCHAR(500),
    "return_reason" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "subcontract_certificates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subcontract_certificate_claims" (
    "tenant_id" UUID NOT NULL,
    "subcontract_id" UUID NOT NULL,
    "certificate_id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "quantity_to_date" DECIMAL(20,4) NOT NULL,
    "entered_by" UUID NOT NULL,
    "entered_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subcontract_certificate_claims_pkey" PRIMARY KEY ("tenant_id","certificate_id","line_id")
);

-- CreateTable
CREATE TABLE "subcontract_certificate_lines" (
    "tenant_id" UUID NOT NULL,
    "certificate_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "line_no" INTEGER NOT NULL,
    "line_id" UUID NOT NULL,
    "bq_item_lineage_id" UUID NOT NULL,
    "basis" VARCHAR(10) NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "unit" VARCHAR(20),
    "rate_minor" BIGINT,
    "line_quantity" DECIMAL(20,4) NOT NULL,
    "line_amount_minor" BIGINT NOT NULL,
    "vat_treatment" VARCHAR(12) NOT NULL,
    "measured_to_date" DECIMAL(20,4),
    "quantity_to_date" DECIMAL(20,4) NOT NULL,
    "previous_quantity" DECIMAL(20,4) NOT NULL,
    "previous_minor" BIGINT NOT NULL,
    "value_to_date_minor" BIGINT NOT NULL,

    CONSTRAINT "subcontract_certificate_lines_pkey" PRIMARY KEY ("tenant_id","certificate_id","revision","line_no")
);

-- CreateTable
CREATE TABLE "subcontract_payments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "subcontract_id" UUID NOT NULL,
    "certificate_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "paid_on" DATE NOT NULL,
    "method" VARCHAR(15) NOT NULL,
    "reference" VARCHAR(60) NOT NULL,
    "reference_key" VARCHAR(60) NOT NULL,
    "idempotency_key" VARCHAR(100) NOT NULL,
    "request_digest" CHAR(64) NOT NULL,
    "recorded_by" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subcontract_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subcontract_invoices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "subcontract_id" UUID NOT NULL,
    "certificate_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "invoice_number" VARCHAR(60) NOT NULL,
    "invoice_number_key" VARCHAR(60) NOT NULL,
    "invoice_date" DATE NOT NULL,
    "etims_number" VARCHAR(60),
    "amount_minor" BIGINT NOT NULL,
    "recorded_by" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subcontract_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "piece_rate_jobs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "bq_version_id" UUID NOT NULL,
    "bq_item_lineage_id" UUID NOT NULL,
    "labourer_id" UUID,
    "gang_id" UUID,
    "description" VARCHAR(200) NOT NULL,
    "unit" VARCHAR(20) NOT NULL,
    "bq_unit" VARCHAR(20) NOT NULL,
    "conversion_factor" DECIMAL(20,6) NOT NULL DEFAULT 1,
    "rate_minor" BIGINT NOT NULL,
    "agreed_quantity" DECIMAL(12,3) NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'pending',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ,
    "decision_note" VARCHAR(500),
    "closed_by" UUID,
    "closed_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "piece_rate_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "piece_rate_job_extensions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'pending',
    "requested_by" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ,
    "decision_note" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "piece_rate_job_extensions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "subcontracts_tenant_id_project_id_status_idx" ON "subcontracts"("tenant_id", "project_id", "status");

-- CreateIndex
CREATE INDEX "subcontracts_tenant_id_supplier_id_idx" ON "subcontracts"("tenant_id", "supplier_id");

-- CreateIndex
CREATE UNIQUE INDEX "subcontracts_tenant_id_id_key" ON "subcontracts"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "subcontracts_tenant_id_project_id_id_key" ON "subcontracts"("tenant_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "subcontracts_tenant_id_project_id_number_key" ON "subcontracts"("tenant_id", "project_id", "number");

-- CreateIndex
CREATE INDEX "subcontract_lines_tenant_id_project_id_bq_item_lineage_id_idx" ON "subcontract_lines"("tenant_id", "project_id", "bq_item_lineage_id");

-- CreateIndex
CREATE UNIQUE INDEX "subcontract_lines_tenant_id_id_key" ON "subcontract_lines"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "subcontract_lines_tenant_id_subcontract_id_id_key" ON "subcontract_lines"("tenant_id", "subcontract_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "subcontract_lines_tenant_id_subcontract_id_line_no_key" ON "subcontract_lines"("tenant_id", "subcontract_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "subcontract_variations_tenant_id_id_key" ON "subcontract_variations"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "subcontract_variations_tenant_id_subcontract_id_id_key" ON "subcontract_variations"("tenant_id", "subcontract_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "subcontract_variations_tenant_id_subcontract_id_number_key" ON "subcontract_variations"("tenant_id", "subcontract_id", "number");

-- CreateIndex
CREATE INDEX "subcontract_line_changes_tenant_id_subcontract_id_line_id_idx" ON "subcontract_line_changes"("tenant_id", "subcontract_id", "line_id");

-- CreateIndex
CREATE UNIQUE INDEX "subcontract_advances_tenant_id_id_key" ON "subcontract_advances"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "subcontract_advances_tenant_id_project_id_id_key" ON "subcontract_advances"("tenant_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "subcontract_advances_tenant_id_subcontract_id_number_key" ON "subcontract_advances"("tenant_id", "subcontract_id", "number");

-- CreateIndex
CREATE INDEX "subcontract_certificates_tenant_id_project_id_status_idx" ON "subcontract_certificates"("tenant_id", "project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "subcontract_certificates_tenant_id_id_key" ON "subcontract_certificates"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "subcontract_certificates_tenant_id_project_id_id_key" ON "subcontract_certificates"("tenant_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "subcontract_certificates_tenant_id_subcontract_id_id_key" ON "subcontract_certificates"("tenant_id", "subcontract_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "subcontract_certificates_tenant_id_subcontract_id_number_key" ON "subcontract_certificates"("tenant_id", "subcontract_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "subcontract_certificates_tenant_id_subcontract_id_certifica_key" ON "subcontract_certificates"("tenant_id", "subcontract_id", "certificate_number");

-- CreateIndex
CREATE INDEX "subcontract_certificate_lines_tenant_id_line_id_idx" ON "subcontract_certificate_lines"("tenant_id", "line_id");

-- CreateIndex
CREATE INDEX "subcontract_payments_tenant_id_certificate_id_idx" ON "subcontract_payments"("tenant_id", "certificate_id");

-- CreateIndex
CREATE UNIQUE INDEX "subcontract_payments_tenant_id_id_key" ON "subcontract_payments"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "subcontract_payments_tenant_id_project_id_id_key" ON "subcontract_payments"("tenant_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "subcontract_payments_tenant_id_idempotency_key_key" ON "subcontract_payments"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "subcontract_payments_tenant_id_method_reference_key_key" ON "subcontract_payments"("tenant_id", "method", "reference_key");

-- CreateIndex
CREATE UNIQUE INDEX "subcontract_invoices_tenant_id_id_key" ON "subcontract_invoices"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "subcontract_invoices_tenant_id_certificate_id_key" ON "subcontract_invoices"("tenant_id", "certificate_id");

-- CreateIndex
CREATE UNIQUE INDEX "subcontract_invoices_tenant_id_supplier_id_invoice_number_k_key" ON "subcontract_invoices"("tenant_id", "supplier_id", "invoice_number_key");

-- CreateIndex
CREATE INDEX "piece_rate_jobs_tenant_id_project_id_bq_item_lineage_id_idx" ON "piece_rate_jobs"("tenant_id", "project_id", "bq_item_lineage_id");

-- CreateIndex
CREATE UNIQUE INDEX "piece_rate_jobs_tenant_id_id_key" ON "piece_rate_jobs"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "piece_rate_jobs_tenant_id_project_id_id_key" ON "piece_rate_jobs"("tenant_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "piece_rate_jobs_tenant_id_project_id_number_key" ON "piece_rate_jobs"("tenant_id", "project_id", "number");

-- CreateIndex
CREATE INDEX "piece_rate_job_extensions_tenant_id_job_id_idx" ON "piece_rate_job_extensions"("tenant_id", "job_id");

-- CreateIndex
CREATE UNIQUE INDEX "piece_rate_job_extensions_tenant_id_id_key" ON "piece_rate_job_extensions"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "cost_entries_tenant_id_subcontract_certificate_id_idx" ON "cost_entries"("tenant_id", "subcontract_certificate_id");

-- CreateIndex
CREATE INDEX "piece_rate_outputs_tenant_id_job_id_idx" ON "piece_rate_outputs"("tenant_id", "job_id");

-- AddForeignKey
ALTER TABLE "piece_rate_outputs" ADD CONSTRAINT "piece_rate_outputs_tenant_id_project_id_job_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "job_id") REFERENCES "piece_rate_jobs"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_tenant_id_project_id_subcontract_certificate__fkey" FOREIGN KEY ("tenant_id", "project_id", "subcontract_certificate_id") REFERENCES "subcontract_certificates"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_tenant_id_subcontract_line_id_fkey" FOREIGN KEY ("tenant_id", "subcontract_line_id") REFERENCES "subcontract_lines"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_tenant_id_project_id_subcontract_payment_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "subcontract_payment_id") REFERENCES "subcontract_payments"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_tenant_id_project_id_subcontract_advance_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "subcontract_advance_id") REFERENCES "subcontract_advances"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subcontracts" ADD CONSTRAINT "subcontracts_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subcontracts" ADD CONSTRAINT "subcontracts_tenant_id_supplier_id_fkey" FOREIGN KEY ("tenant_id", "supplier_id") REFERENCES "suppliers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subcontract_lines" ADD CONSTRAINT "subcontract_lines_tenant_id_project_id_subcontract_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "subcontract_id") REFERENCES "subcontracts"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subcontract_lines" ADD CONSTRAINT "subcontract_lines_tenant_id_subcontract_id_variation_id_fkey" FOREIGN KEY ("tenant_id", "subcontract_id", "variation_id") REFERENCES "subcontract_variations"("tenant_id", "subcontract_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subcontract_lines" ADD CONSTRAINT "subcontract_lines_tenant_id_bq_version_id_bq_item_lineage__fkey" FOREIGN KEY ("tenant_id", "bq_version_id", "bq_item_lineage_id") REFERENCES "bq_items"("tenant_id", "version_id", "lineage_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subcontract_variations" ADD CONSTRAINT "subcontract_variations_tenant_id_project_id_subcontract_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "subcontract_id") REFERENCES "subcontracts"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subcontract_line_changes" ADD CONSTRAINT "subcontract_line_changes_tenant_id_subcontract_id_variatio_fkey" FOREIGN KEY ("tenant_id", "subcontract_id", "variation_id") REFERENCES "subcontract_variations"("tenant_id", "subcontract_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subcontract_line_changes" ADD CONSTRAINT "subcontract_line_changes_tenant_id_subcontract_id_line_id_fkey" FOREIGN KEY ("tenant_id", "subcontract_id", "line_id") REFERENCES "subcontract_lines"("tenant_id", "subcontract_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subcontract_advances" ADD CONSTRAINT "subcontract_advances_tenant_id_project_id_subcontract_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "subcontract_id") REFERENCES "subcontracts"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subcontract_certificates" ADD CONSTRAINT "subcontract_certificates_tenant_id_project_id_subcontract__fkey" FOREIGN KEY ("tenant_id", "project_id", "subcontract_id") REFERENCES "subcontracts"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subcontract_certificate_claims" ADD CONSTRAINT "subcontract_certificate_claims_tenant_id_subcontract_id_ce_fkey" FOREIGN KEY ("tenant_id", "subcontract_id", "certificate_id") REFERENCES "subcontract_certificates"("tenant_id", "subcontract_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subcontract_certificate_claims" ADD CONSTRAINT "subcontract_certificate_claims_tenant_id_subcontract_id_li_fkey" FOREIGN KEY ("tenant_id", "subcontract_id", "line_id") REFERENCES "subcontract_lines"("tenant_id", "subcontract_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subcontract_certificate_lines" ADD CONSTRAINT "subcontract_certificate_lines_tenant_id_certificate_id_fkey" FOREIGN KEY ("tenant_id", "certificate_id") REFERENCES "subcontract_certificates"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subcontract_certificate_lines" ADD CONSTRAINT "subcontract_certificate_lines_tenant_id_line_id_fkey" FOREIGN KEY ("tenant_id", "line_id") REFERENCES "subcontract_lines"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subcontract_payments" ADD CONSTRAINT "subcontract_payments_tenant_id_project_id_subcontract_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "subcontract_id") REFERENCES "subcontracts"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subcontract_payments" ADD CONSTRAINT "subcontract_payments_tenant_id_subcontract_id_certificate__fkey" FOREIGN KEY ("tenant_id", "subcontract_id", "certificate_id") REFERENCES "subcontract_certificates"("tenant_id", "subcontract_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subcontract_invoices" ADD CONSTRAINT "subcontract_invoices_tenant_id_subcontract_id_certificate__fkey" FOREIGN KEY ("tenant_id", "subcontract_id", "certificate_id") REFERENCES "subcontract_certificates"("tenant_id", "subcontract_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subcontract_invoices" ADD CONSTRAINT "subcontract_invoices_tenant_id_supplier_id_fkey" FOREIGN KEY ("tenant_id", "supplier_id") REFERENCES "suppliers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "piece_rate_jobs" ADD CONSTRAINT "piece_rate_jobs_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "piece_rate_jobs" ADD CONSTRAINT "piece_rate_jobs_tenant_id_bq_version_id_bq_item_lineage_id_fkey" FOREIGN KEY ("tenant_id", "bq_version_id", "bq_item_lineage_id") REFERENCES "bq_items"("tenant_id", "version_id", "lineage_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "piece_rate_jobs" ADD CONSTRAINT "piece_rate_jobs_tenant_id_labourer_id_fkey" FOREIGN KEY ("tenant_id", "labourer_id") REFERENCES "labourers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "piece_rate_jobs" ADD CONSTRAINT "piece_rate_jobs_tenant_id_project_id_gang_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "gang_id") REFERENCES "gangs"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "piece_rate_job_extensions" ADD CONSTRAINT "piece_rate_job_extensions_tenant_id_project_id_job_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "job_id") REFERENCES "piece_rate_jobs"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Shared helpers -----------------------------------------------------------------------------------
-- The BQ version in force (the newest approved version) of a project.
CREATE FUNCTION app.bq_version_in_force(target_tenant uuid, target_project uuid) RETURNS uuid
  LANGUAGE sql STABLE AS $$
  SELECT id FROM bq_versions
   WHERE tenant_id = target_tenant AND project_id = target_project AND status = 'approved'
   ORDER BY approved_at DESC NULLS LAST, version_no DESC LIMIT 1
$$;

-- packages/domain subcontractLineValueMinor: quantity × rate for a quantity line, the lump sum pro
-- rata for a percent line; one rounding, half away from zero (exact integer arithmetic).
CREATE FUNCTION app.subcontract_line_value(basis text, rate_minor bigint, amount_minor bigint,
  line_quantity numeric, done numeric) RETURNS bigint LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN done = 0 THEN 0
    WHEN basis = 'quantity' THEN app.div_half_up(done * 10000 * rate_minor, 10000)::bigint
    WHEN line_quantity <= 0 THEN 0
    ELSE app.div_half_up(amount_minor * (done * 10000), line_quantity * 10000)::bigint
  END
$$;

-- Whether a subcontract line counts: a line of the contract, or one added by an approved variation.
CREATE FUNCTION app.subcontract_line_live(target_tenant uuid, variation uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT variation IS NULL OR EXISTS (
    SELECT 1 FROM subcontract_variations v
     WHERE v.tenant_id = target_tenant AND v.id = variation AND v.status = 'approved')
$$;

-- A line's quantity and value in force: as let, plus every change of an approved variation.
CREATE FUNCTION app.subcontract_line_in_force(target_tenant uuid, target_line uuid,
  OUT quantity numeric, OUT amount_minor bigint) LANGUAGE sql STABLE AS $$
  SELECT l.quantity + COALESCE(sum(c.quantity_change), 0),
         (l.amount_minor + COALESCE(sum(c.amount_change_minor), 0))::bigint
    FROM subcontract_lines l
    LEFT JOIN subcontract_line_changes c ON c.tenant_id = l.tenant_id AND c.line_id = l.id
     AND EXISTS (SELECT 1 FROM subcontract_variations v WHERE v.tenant_id = c.tenant_id
                  AND v.id = c.variation_id AND v.status = 'approved')
   WHERE l.tenant_id = target_tenant AND l.id = target_line
   GROUP BY l.quantity, l.amount_minor
$$;

-- What can be let on a BQ item: its quantity in the BQ in force, 100 (percent) for a priced lump
-- sum, nothing for an item that is not measured or no longer in the BQ in force.
CREATE FUNCTION app.subcontract_item_capacity(target_tenant uuid, target_project uuid, lineage uuid)
  RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE((
    SELECT CASE app.measurement_basis(i.kind, i.quantity, i.amount_minor)
      WHEN 'quantity' THEN i.quantity WHEN 'percent' THEN 100 ELSE 0 END
      FROM bq_items i
     WHERE i.tenant_id = target_tenant
       AND i.version_id = app.bq_version_in_force(target_tenant, target_project)
       AND i.lineage_id = lineage), 0)
$$;

-- The quantity let on a BQ item by the other live subcontracts: their lines in force while
-- approved or active; once completed or terminated, what their last certificate certified.
CREATE FUNCTION app.subcontract_item_let(target_tenant uuid, target_project uuid, lineage uuid,
  except_subcontract uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE(sum(CASE WHEN s.status IN ('approved', 'active')
      THEN (app.subcontract_line_in_force(l.tenant_id, l.id)).quantity
      ELSE COALESCE((
        SELECT cl.quantity_to_date FROM subcontract_certificate_lines cl
          JOIN subcontract_certificates c ON c.tenant_id = cl.tenant_id AND c.id = cl.certificate_id
           AND c.revision = cl.revision
         WHERE cl.tenant_id = l.tenant_id AND cl.line_id = l.id AND c.status = 'certified'
         ORDER BY c.certificate_number DESC LIMIT 1), 0) END), 0)
    FROM subcontract_lines l
    JOIN subcontracts s ON s.tenant_id = l.tenant_id AND s.id = l.subcontract_id
   WHERE l.tenant_id = target_tenant AND l.project_id = target_project
     AND l.bq_item_lineage_id = lineage AND s.id <> except_subcontract
     AND s.status IN ('approved', 'active', 'completed', 'terminated')
     AND app.subcontract_line_live(l.tenant_id, l.variation_id)
$$;

-- The approved measured quantity (D6.3) in force on a BQ item on a date: the newest approved, not
-- superseded measurement on or before it in the item's current basis (as app.check_valuation_lines).
CREATE FUNCTION app.measured_in_force(target_tenant uuid, target_project uuid, lineage uuid,
  as_of date) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE((
    SELECT m.quantity_to_date FROM progress_measurements m
      JOIN progress_measurement_reviews r ON r.tenant_id = m.tenant_id
       AND r.measurement_id = m.id AND r.decision = 'approved'
      JOIN bq_items i ON i.tenant_id = m.tenant_id
       AND i.version_id = app.bq_version_in_force(target_tenant, target_project)
       AND i.lineage_id = m.item_lineage_id
     WHERE m.tenant_id = target_tenant AND m.project_id = target_project
       AND m.item_lineage_id = lineage AND m.measured_on <= as_of
       AND COALESCE(m.basis, 'quantity') = app.measurement_basis(i.kind, i.quantity, i.amount_minor)
       AND NOT EXISTS (
         SELECT 1 FROM progress_measurements c
           JOIN progress_measurement_reviews cr ON cr.tenant_id = c.tenant_id
            AND cr.measurement_id = c.id AND cr.decision = 'approved'
          WHERE c.tenant_id = m.tenant_id AND c.corrects_id = m.id)
     ORDER BY m.measured_on DESC, m.recorded_at DESC, m.id DESC LIMIT 1), 0)
$$;

-- A subcontractor is an active supplier flagged as one (decision D-140).
CREATE FUNCTION app.assert_subcontractor(target_tenant uuid, target_supplier uuid)
  RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM suppliers WHERE tenant_id = target_tenant AND id = target_supplier
                  AND is_subcontractor AND status = 'active') THEN
    RAISE EXCEPTION 'A subcontract is let to an active supplier flagged as a subcontractor'
      USING ERRCODE = '23514';
  END IF;
END
$$;

-- "SC-0001/SCC-0002": the reference a certificate's cost entries carry.
CREATE FUNCTION app.subcontract_certificate_reference(subcontract_number integer,
  certificate_number integer) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT 'SC-' || lpad(subcontract_number::text, 4, '0') || '/SCC-'
    || lpad(certificate_number::text, 4, '0')
$$;

-- packages/domain invoiceNumberKey: upper case without spaces, dots, slashes or hyphens.
CREATE FUNCTION app.invoice_number_key(value text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT upper(regexp_replace(btrim(value), '[[:space:]./-]+', '', 'g'))
$$;

-- The terms frozen at submission (everything but status, people, stamps and the value in force).
CREATE FUNCTION app.subcontract_terms(s subcontracts) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('supplier', s.supplier_id, 'kind', s.kind, 'title', s.title,
    'scope', s.scope, 'start', s.start_date, 'end', s.end_date,
    'retention', s.retention_percent, 'limit', s.retention_limit_percent,
    'release', s.practical_release_percent, 'vat', s.vat_percent, 'wht', s.wht_percent,
    'advance', s.advance_limit_minor, 'recovery', s.advance_recovery_percent,
    'days', s.payment_terms_days, 'note', s.payment_terms_note)
$$;

-- Subcontracts -------------------------------------------------------------------------------------
ALTER TABLE "subcontracts" ADD CONSTRAINT "subcontracts_check" CHECK (
  number >= 1 AND version >= 1 AND contract_version >= 0
  AND kind IN ('labour_only', 'supply_and_fix')
  AND char_length(btrim(title)) >= 3
  AND (scope IS NULL OR char_length(btrim(scope)) >= 1)
  AND start_date BETWEEN DATE '2000-01-01' AND DATE '2099-12-31'
  AND end_date BETWEEN start_date AND DATE '2099-12-31'
  AND retention_percent BETWEEN 0 AND 20
  AND (retention_limit_percent IS NULL OR retention_limit_percent BETWEEN 0 AND 100)
  AND practical_release_percent BETWEEN 0 AND 100
  AND vat_percent BETWEEN 0 AND 30 AND wht_percent BETWEEN 0 AND 20
  AND advance_limit_minor >= 0 AND advance_recovery_percent BETWEEN 0 AND 100
  AND (advance_limit_minor = 0 OR advance_recovery_percent > 0)
  AND payment_terms_days BETWEEN 0 AND 365
  AND (payment_terms_note IS NULL OR char_length(btrim(payment_terms_note)) >= 1)
  AND contributors IS NOT NULL AND created_by = ANY (contributors)
  AND (digest IS NULL OR digest ~ '^[0-9a-f]{64}$')
  AND (return_reason IS NULL OR char_length(btrim(return_reason)) >= 3)
  AND (original_value_minor IS NULL) = (current_value_minor IS NULL)
  AND (original_value_minor IS NULL OR original_value_minor >= 0)
  AND (current_value_minor IS NULL OR current_value_minor >= 0)
  AND COALESCE(CASE status
    WHEN 'draft' THEN digest IS NULL AND approved_at IS NULL AND original_value_minor IS NULL
      AND contract_version = 0 AND cancelled_at IS NULL AND closed_at IS NULL
    WHEN 'submitted' THEN digest IS NOT NULL AND submitted_by IS NOT NULL
      AND submitted_at IS NOT NULL AND approved_at IS NULL AND original_value_minor IS NULL
      AND contract_version = 0 AND cancelled_at IS NULL
    WHEN 'approved' THEN digest IS NOT NULL AND approved_by IS NOT NULL AND approved_at IS NOT NULL
      AND original_value_minor IS NOT NULL AND contract_version >= 1
      AND NOT (approved_by = ANY (contributors)) AND activated_at IS NULL AND closed_at IS NULL
    WHEN 'active' THEN digest IS NOT NULL AND approved_by IS NOT NULL AND approved_at IS NOT NULL
      AND original_value_minor IS NOT NULL AND contract_version >= 1
      AND NOT (approved_by = ANY (contributors)) AND activated_by IS NOT NULL
      AND activated_at IS NOT NULL AND closed_at IS NULL
    WHEN 'completed' THEN approved_at IS NOT NULL AND original_value_minor IS NOT NULL
      AND activated_at IS NOT NULL AND closed_by IS NOT NULL AND closed_at IS NOT NULL
    WHEN 'terminated' THEN approved_at IS NOT NULL AND original_value_minor IS NOT NULL
      AND closed_by IS NOT NULL AND closed_at IS NOT NULL
      AND char_length(btrim(close_reason)) >= 3
    WHEN 'cancelled' THEN cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL
      AND char_length(btrim(cancel_reason)) >= 3 AND approved_at IS NULL
    ELSE false
  END, false)
);

-- Checks every line in force of a subcontract against the BQ: the quantity let on its item by
-- every live subcontract never exceeds the item's quantity in the BQ in force unless the line (or
-- the approved change that raised it) carries an exception reason. Items are locked one by one in
-- lineage order, so two approvals on the same item are serialised and never deadlock.
CREATE FUNCTION app.check_subcontract_caps(target_tenant uuid, target_subcontract uuid)
  RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  line record;
BEGIN
  FOR line IN
    SELECT l.id, l.project_id, l.bq_item_lineage_id,
           l.over_quantity_reason IS NOT NULL OR EXISTS (
             SELECT 1 FROM subcontract_line_changes c
               JOIN subcontract_variations v ON v.tenant_id = c.tenant_id AND v.id = c.variation_id
              WHERE c.tenant_id = l.tenant_id AND c.line_id = l.id AND v.status = 'approved'
                AND c.over_quantity_reason IS NOT NULL) AS excepted
      FROM subcontract_lines l
     WHERE l.tenant_id = target_tenant AND l.subcontract_id = target_subcontract
       AND app.subcontract_line_live(l.tenant_id, l.variation_id)
     ORDER BY l.bq_item_lineage_id
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended('subcontract-item:' || target_tenant || ':' || line.bq_item_lineage_id, 0));
    IF NOT line.excepted
       AND (app.subcontract_line_in_force(target_tenant, line.id)).quantity
         + app.subcontract_item_let(target_tenant, line.project_id, line.bq_item_lineage_id,
                                    target_subcontract)
       > app.subcontract_item_capacity(target_tenant, line.project_id, line.bq_item_lineage_id)
    THEN
      RAISE EXCEPTION 'Subcontracted quantity on a BQ item never exceeds the BQ quantity in force without a reason'
        USING ERRCODE = '23514';
    END IF;
  END LOOP;
END
$$;

-- packages/domain SUBCONTRACT_TRANSITIONS. A subcontract starts as a draft numbered after the last
-- one, let to a flagged supplier; only a draft's terms change; submission stamps the clock with
-- its digest; approval is by the signed-in user who never contributed, on the digest submitted,
-- fixes the original value at the lines' value, checks the advance is recoverable and the BQ caps;
-- after approval the value and version move only with an approved variation; closing needs no open
-- certificate or variation; completed, terminated and cancelled never change; never deleted.
CREATE FUNCTION app.guard_subcontract() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  original bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A subcontract is never deleted; cancel it' USING ERRCODE = '23514';
  END IF;
  PERFORM app.assert_quality_writable(NEW.tenant_id, NEW.project_id);
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.created_by IS DISTINCT FROM app.current_user_id()
       OR NEW.digest IS NOT NULL OR NEW.contract_version <> 0
       OR NEW.original_value_minor IS NOT NULL THEN
      RAISE EXCEPTION 'A subcontract starts as an empty draft by the signed-in user'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.number <> COALESCE((SELECT max(number) FROM subcontracts
         WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id), 0) + 1 THEN
      RAISE EXCEPTION 'Subcontracts are numbered one after another' USING ERRCODE = '23514';
    END IF;
    PERFORM app.assert_subcontractor(NEW.tenant_id, NEW.supplier_id);
    NEW.contributors := app.add_contributors(NEW.contributors, NEW.created_by, NEW.updated_by);
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;

  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.number IS DISTINCT FROM OLD.number OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'A subcontract keeps its project and number' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('completed', 'terminated', 'cancelled') THEN
    RAISE EXCEPTION 'A % subcontract never changes', OLD.status USING ERRCODE = '23514';
  END IF;
  IF NOT (NEW.contributors @> OLD.contributors) THEN
    RAISE EXCEPTION 'A subcontract''s contributors are only ever added' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'draft' AND app.subcontract_terms(NEW) IS DISTINCT FROM app.subcontract_terms(OLD)
  THEN
    RAISE EXCEPTION 'A subcontract''s terms never change after submission; vary it instead'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'draft' AND NEW.supplier_id IS DISTINCT FROM OLD.supplier_id THEN
    PERFORM app.assert_subcontractor(NEW.tenant_id, NEW.supplier_id);
  END IF;

  -- After approval the value and version move only with an approved variation (same status).
  IF OLD.status IN ('approved', 'active')
     AND (NEW.contract_version IS DISTINCT FROM OLD.contract_version
          OR NEW.current_value_minor IS DISTINCT FROM OLD.current_value_minor
          OR NEW.original_value_minor IS DISTINCT FROM OLD.original_value_minor) THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.original_value_minor IS DISTINCT FROM OLD.original_value_minor
       OR NEW.contract_version <> OLD.contract_version + 1
       OR NOT EXISTS (SELECT 1 FROM subcontract_variations WHERE tenant_id = NEW.tenant_id
                       AND subcontract_id = NEW.id AND status = 'approved'
                       AND resulting_version = NEW.contract_version)
       OR NEW.current_value_minor <> NEW.original_value_minor + COALESCE((
            SELECT sum(value_change_minor) FROM subcontract_variations
             WHERE tenant_id = NEW.tenant_id AND subcontract_id = NEW.id AND status = 'approved'), 0)
    THEN
      RAISE EXCEPTION 'A subcontract''s value changes only with an approved variation'
        USING ERRCODE = '23514';
    END IF;
    PERFORM app.check_subcontract_caps(NEW.tenant_id, NEW.id);
    RETURN NEW;
  END IF;

  IF OLD.status = NEW.status THEN
    IF NEW.status = 'draft' AND (NEW.digest IS NOT NULL OR NEW.original_value_minor IS NOT NULL) THEN
      RAISE EXCEPTION 'A draft subcontract has no digest or value' USING ERRCODE = '23514';
    END IF;
    IF NEW.status <> 'draft' AND (NEW.digest IS DISTINCT FROM OLD.digest
         OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
         OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
         OR NEW.approved_by IS DISTINCT FROM OLD.approved_by) THEN
      RAISE EXCEPTION 'A subcontract keeps its submission and approval' USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.status = 'draft' AND NEW.status = 'submitted' THEN
    IF NEW.submitted_by IS DISTINCT FROM app.current_user_id() OR NEW.digest IS NULL THEN
      RAISE EXCEPTION 'A subcontract is submitted by the signed-in user with its digest'
        USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM subcontract_lines WHERE tenant_id = NEW.tenant_id
                    AND subcontract_id = NEW.id AND variation_id IS NULL) THEN
      RAISE EXCEPTION 'A subcontract is submitted with at least one line' USING ERRCODE = '23514';
    END IF;
    PERFORM app.assert_subcontractor(NEW.tenant_id, NEW.supplier_id);
    NEW.submitted_at := clock_timestamp();
    -- Whoever added a line contributed to what is approved.
    NEW.contributors := app.add_contributors(NEW.contributors, VARIADIC ARRAY(
      SELECT created_by FROM subcontract_lines WHERE tenant_id = NEW.tenant_id
         AND subcontract_id = NEW.id AND variation_id IS NULL));
  ELSIF OLD.status = 'submitted' AND NEW.status = 'draft' THEN
    IF NEW.return_reason IS NULL OR NEW.digest IS NOT NULL THEN
      RAISE EXCEPTION 'A returned subcontract goes back to draft with a reason'
        USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.status = 'submitted' AND NEW.status = 'approved' THEN
    IF NEW.approved_by IS DISTINCT FROM app.current_user_id()
       OR NEW.approved_by = ANY (NEW.contributors) THEN
      RAISE EXCEPTION 'A subcontract is approved by someone other than those who prepared it'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.digest IS DISTINCT FROM OLD.digest THEN
      RAISE EXCEPTION 'A subcontract is approved exactly as submitted' USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(sum(amount_minor), 0)::bigint INTO original FROM subcontract_lines
     WHERE tenant_id = NEW.tenant_id AND subcontract_id = NEW.id AND variation_id IS NULL;
    IF NEW.original_value_minor IS DISTINCT FROM original
       OR NEW.current_value_minor IS DISTINCT FROM original OR NEW.contract_version <> 1 THEN
      RAISE EXCEPTION 'An approved subcontract is worth its lines (version 1)'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.advance_limit_minor > round(original * NEW.advance_recovery_percent / 100) THEN
      RAISE EXCEPTION 'An advance is recoverable within the subcontract value'
        USING ERRCODE = '23514';
    END IF;
    PERFORM app.check_subcontract_caps(NEW.tenant_id, NEW.id);
    NEW.approved_at := clock_timestamp();
  ELSIF OLD.status = 'approved' AND NEW.status = 'active' THEN
    IF NEW.activated_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'A subcontract is started by the signed-in user' USING ERRCODE = '23514';
    END IF;
    NEW.activated_at := clock_timestamp();
  ELSIF (OLD.status = 'active' AND NEW.status = 'completed')
     OR (OLD.status IN ('approved', 'active') AND NEW.status = 'terminated') THEN
    IF NEW.closed_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'A subcontract is closed by the signed-in user' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM subcontract_certificates WHERE tenant_id = NEW.tenant_id
                AND subcontract_id = NEW.id AND status IN ('draft', 'submitted'))
       OR EXISTS (SELECT 1 FROM subcontract_variations WHERE tenant_id = NEW.tenant_id
                   AND subcontract_id = NEW.id AND status = 'pending') THEN
      RAISE EXCEPTION 'A subcontract closes with no certificate or variation open'
        USING ERRCODE = '23514';
    END IF;
    NEW.closed_at := clock_timestamp();
  ELSIF OLD.status IN ('draft', 'submitted') AND NEW.status = 'cancelled' THEN
    IF NEW.cancelled_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'A subcontract is cancelled by the signed-in user' USING ERRCODE = '23514';
    END IF;
    NEW.cancelled_at := clock_timestamp();
  ELSE
    RAISE EXCEPTION 'Subcontract status cannot change from % to %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('draft', 'submitted') AND NOT (OLD.status = 'submitted' AND NEW.status = 'draft')
  THEN
    NEW.contributors := app.add_contributors(
      NEW.contributors, NEW.created_by, NEW.updated_by, NEW.submitted_by, app.current_user_id());
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER subcontract_guard BEFORE INSERT OR UPDATE OR DELETE ON "subcontracts"
  FOR EACH ROW EXECUTE FUNCTION app.guard_subcontract();

-- Lines ----------------------------------------------------------------------------------------------
ALTER TABLE "subcontract_lines" ADD CONSTRAINT "subcontract_lines_check" CHECK (
  line_no >= 1 AND basis IN ('quantity', 'percent') AND char_length(btrim(description)) >= 2
  AND (unit IS NULL OR char_length(btrim(unit)) >= 1)
  AND quantity > 0 AND vat_treatment IN ('standard', 'zero_rated', 'exempt')
  AND (over_quantity_reason IS NULL OR char_length(btrim(over_quantity_reason)) >= 3)
  AND CASE basis
    WHEN 'quantity' THEN rate_minor BETWEEN 1 AND 100000000000
      AND amount_minor = round(quantity * rate_minor)
    ELSE rate_minor IS NULL AND quantity <= 100 AND amount_minor > 0
  END
);
-- Added by the signed-in user to a draft (or by a pending variation of an approved or active
-- subcontract, by its maker), naming an item of the BQ in force in the item's basis (never a
-- provisional sum, PC sum or contingency), once per item; at most 500 lines. Never changed; only a
-- draft's own lines are removed.
CREATE FUNCTION app.guard_subcontract_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent record;
  variation record;
  item record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Subcontract lines never change; vary the subcontract' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    SELECT status INTO parent FROM subcontracts
     WHERE tenant_id = OLD.tenant_id AND id = OLD.subcontract_id FOR SHARE;
    IF OLD.variation_id IS NOT NULL OR parent.status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'Lines are removed only from a draft subcontract' USING ERRCODE = '23514';
    END IF;
    PERFORM app.assert_quality_writable(OLD.tenant_id, OLD.project_id);
    RETURN OLD;
  END IF;
  PERFORM app.assert_quality_writable(NEW.tenant_id, NEW.project_id);
  IF NEW.created_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'Subcontract lines are added by the signed-in user' USING ERRCODE = '23514';
  END IF;
  SELECT status INTO parent FROM subcontracts
   WHERE tenant_id = NEW.tenant_id AND id = NEW.subcontract_id FOR SHARE;
  IF NEW.variation_id IS NULL THEN
    IF parent.status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'Lines are added to a draft subcontract, or by a variation'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT status, created_by INTO variation FROM subcontract_variations
     WHERE tenant_id = NEW.tenant_id AND id = NEW.variation_id;
    IF variation.status IS DISTINCT FROM 'pending' OR variation.created_by <> NEW.created_by
       OR parent.status NOT IN ('approved', 'active') THEN
      RAISE EXCEPTION 'A variation adds lines while it is pending, by its maker'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.bq_version_id IS DISTINCT FROM app.bq_version_in_force(NEW.tenant_id, NEW.project_id) THEN
    RAISE EXCEPTION 'A subcontract line names an item of the BQ in force' USING ERRCODE = '23514';
  END IF;
  SELECT kind, quantity, amount_minor INTO item FROM bq_items
   WHERE tenant_id = NEW.tenant_id AND version_id = NEW.bq_version_id
     AND lineage_id = NEW.bq_item_lineage_id;
  IF NEW.basis IS DISTINCT FROM app.measurement_basis(item.kind, item.quantity, item.amount_minor)
  THEN
    RAISE EXCEPTION 'A subcontract line uses its item''s basis; provisional sums, PC sums and contingencies are not let'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM subcontract_lines l
     WHERE l.tenant_id = NEW.tenant_id AND l.subcontract_id = NEW.subcontract_id
       AND l.bq_item_lineage_id = NEW.bq_item_lineage_id AND l.id <> NEW.id
       AND (l.variation_id IS NULL OR EXISTS (
         SELECT 1 FROM subcontract_variations v WHERE v.tenant_id = l.tenant_id
            AND v.id = l.variation_id AND v.status IN ('pending', 'approved')))
  ) THEN
    RAISE EXCEPTION 'A BQ item appears once on a subcontract; change its line instead'
      USING ERRCODE = '23514';
  END IF;
  IF (SELECT count(*) FROM subcontract_lines WHERE tenant_id = NEW.tenant_id
       AND subcontract_id = NEW.subcontract_id) >= 500 THEN
    RAISE EXCEPTION 'A subcontract has at most 500 lines' USING ERRCODE = '23514';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END
$$;
CREATE TRIGGER subcontract_line_guard BEFORE INSERT OR UPDATE OR DELETE ON "subcontract_lines"
  FOR EACH ROW EXECUTE FUNCTION app.guard_subcontract_line();

-- Variations ---------------------------------------------------------------------------------------
ALTER TABLE "subcontract_variations" ADD CONSTRAINT "subcontract_variations_check" CHECK (
  number >= 1 AND version >= 1 AND char_length(btrim(reason)) >= 3
  AND digest ~ '^[0-9a-f]{64}$'
  AND (decision_reason IS NULL OR char_length(btrim(decision_reason)) >= 3)
  AND (decided_by IS NULL OR decided_by <> created_by)
  AND COALESCE(CASE status
    WHEN 'pending' THEN decided_by IS NULL AND decided_at IS NULL AND resulting_version IS NULL
    WHEN 'approved' THEN decided_by IS NOT NULL AND decided_at IS NOT NULL
      AND resulting_version >= 2
    WHEN 'rejected' THEN decided_by IS NOT NULL AND decided_at IS NOT NULL
      AND decision_reason IS NOT NULL AND resulting_version IS NULL
    ELSE false
  END, false)
);
-- One variation waiting at a time per subcontract.
CREATE UNIQUE INDEX "subcontract_variations_one_pending" ON "subcontract_variations"
  ("tenant_id", "subcontract_id") WHERE status = 'pending';

-- Raised by the signed-in user on an approved or active subcontract, numbered after the last;
-- decided once, by someone other than its maker; approval names the next contract version.
-- Never deleted.
CREATE FUNCTION app.guard_subcontract_variation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A subcontract variation is never deleted' USING ERRCODE = '23514';
  END IF;
  PERFORM app.assert_quality_writable(NEW.tenant_id, NEW.project_id);
  SELECT status, contract_version INTO parent FROM subcontracts
   WHERE tenant_id = NEW.tenant_id AND id = NEW.subcontract_id;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.created_by IS DISTINCT FROM app.current_user_id()
       OR parent.status NOT IN ('approved', 'active') THEN
      RAISE EXCEPTION 'A variation is raised by the signed-in user on an approved subcontract'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.number <> COALESCE((SELECT max(number) FROM subcontract_variations
         WHERE tenant_id = NEW.tenant_id AND subcontract_id = NEW.subcontract_id), 0) + 1 THEN
      RAISE EXCEPTION 'Variations are numbered one after another' USING ERRCODE = '23514';
    END IF;
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF OLD.status <> 'pending' OR NEW.status NOT IN ('approved', 'rejected')
     OR (to_jsonb(NEW) - 'status' - 'decided_by' - 'decided_at' - 'decision_reason'
         - 'resulting_version' - 'version')
        IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'decided_by' - 'decided_at'
         - 'decision_reason' - 'resulting_version' - 'version') THEN
    RAISE EXCEPTION 'A variation is decided once and never rewritten' USING ERRCODE = '23514';
  END IF;
  IF NEW.decided_by IS DISTINCT FROM app.current_user_id() OR NEW.decided_by = NEW.created_by THEN
    RAISE EXCEPTION 'A variation is decided by someone other than its maker'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'approved' AND (parent.status NOT IN ('approved', 'active')
       OR NEW.resulting_version IS DISTINCT FROM parent.contract_version + 1) THEN
    RAISE EXCEPTION 'An approved variation is the next version of an open subcontract'
      USING ERRCODE = '23514';
  END IF;
  NEW.decided_at := clock_timestamp();
  RETURN NEW;
END
$$;
CREATE TRIGGER subcontract_variation_guard BEFORE INSERT OR UPDATE OR DELETE
  ON "subcontract_variations" FOR EACH ROW EXECUTE FUNCTION app.guard_subcontract_variation();

-- At commit: a variation's value change is exactly its added lines and its changes; an approved
-- one has moved its subcontract to its version and takes no line below zero or below what was
-- claimed on a live certificate.
CREATE FUNCTION app.check_subcontract_variation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  added bigint;
  changed bigint;
  parent record;
BEGIN
  SELECT COALESCE(sum(amount_minor), 0)::bigint INTO added FROM subcontract_lines
   WHERE tenant_id = NEW.tenant_id AND variation_id = NEW.id;
  SELECT COALESCE(sum(amount_change_minor), 0)::bigint INTO changed FROM subcontract_line_changes
   WHERE tenant_id = NEW.tenant_id AND variation_id = NEW.id;
  IF added + changed <> NEW.value_change_minor OR (
    NOT EXISTS (SELECT 1 FROM subcontract_lines WHERE tenant_id = NEW.tenant_id
                 AND variation_id = NEW.id)
    AND NOT EXISTS (SELECT 1 FROM subcontract_line_changes WHERE tenant_id = NEW.tenant_id
                     AND variation_id = NEW.id)) THEN
    RAISE EXCEPTION 'A variation''s value change is its lines and changes' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'approved' THEN
    SELECT contract_version INTO parent FROM subcontracts
     WHERE tenant_id = NEW.tenant_id AND id = NEW.subcontract_id;
    IF parent.contract_version < NEW.resulting_version THEN
      RAISE EXCEPTION 'An approved variation moves its subcontract to the next version'
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM subcontract_line_changes c
       CROSS JOIN LATERAL app.subcontract_line_in_force(c.tenant_id, c.line_id) f
       WHERE c.tenant_id = NEW.tenant_id AND c.variation_id = NEW.id
         AND (f.quantity < 0 OR f.quantity < COALESCE((
           SELECT cl.quantity_to_date FROM subcontract_certificate_lines cl
             JOIN subcontract_certificates sc ON sc.tenant_id = cl.tenant_id
              AND sc.id = cl.certificate_id AND sc.revision = cl.revision
            WHERE cl.tenant_id = c.tenant_id AND cl.line_id = c.line_id
              AND sc.status IN ('submitted', 'certified')
            ORDER BY sc.number DESC LIMIT 1), 0))
    ) THEN
      RAISE EXCEPTION 'A variation never takes a line below what was certified'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER subcontract_variation_complete AFTER INSERT OR UPDATE
  ON "subcontract_variations" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION app.check_subcontract_variation();

ALTER TABLE "subcontract_line_changes" ADD CONSTRAINT "subcontract_line_changes_check" CHECK (
  quantity_change <> 0
  AND (over_quantity_reason IS NULL OR char_length(btrim(over_quantity_reason)) >= 3)
);
-- A change is written with its pending variation, by its maker, to a line in force of the same
-- subcontract, valued at the line's terms in force (packages/domain subcontractChangeMinor).
CREATE FUNCTION app.guard_subcontract_line_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  variation record;
  line record;
  in_force record;
  expected bigint;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Variation changes never change' USING ERRCODE = '23514';
  END IF;
  SELECT status, created_by, project_id INTO variation FROM subcontract_variations
   WHERE tenant_id = NEW.tenant_id AND id = NEW.variation_id;
  IF variation.status IS DISTINCT FROM 'pending'
     OR variation.created_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A variation changes lines while it is pending, by its maker'
      USING ERRCODE = '23514';
  END IF;
  PERFORM app.assert_quality_writable(NEW.tenant_id, variation.project_id);
  SELECT basis, rate_minor, variation_id INTO line FROM subcontract_lines
   WHERE tenant_id = NEW.tenant_id AND id = NEW.line_id;
  IF NOT app.subcontract_line_live(NEW.tenant_id, line.variation_id) THEN
    RAISE EXCEPTION 'A variation changes a line in force' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO in_force FROM app.subcontract_line_in_force(NEW.tenant_id, NEW.line_id);
  expected := CASE line.basis
    WHEN 'quantity' THEN app.div_half_up(NEW.quantity_change * 10000 * line.rate_minor, 10000)
    ELSE app.div_half_up(in_force.amount_minor * (NEW.quantity_change * 10000),
                         in_force.quantity * 10000) END;
  IF NEW.amount_change_minor <> expected
     OR (line.basis = 'percent' AND in_force.quantity + NEW.quantity_change > 100) THEN
    RAISE EXCEPTION 'A variation values a change at the line''s rate' USING ERRCODE = '23514';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END
$$;
CREATE TRIGGER subcontract_line_change_guard BEFORE INSERT OR UPDATE OR DELETE
  ON "subcontract_line_changes" FOR EACH ROW EXECUTE FUNCTION app.guard_subcontract_line_change();

-- Advances -------------------------------------------------------------------------------------------
ALTER TABLE "subcontract_advances" ADD CONSTRAINT "subcontract_advances_check" CHECK (
  number >= 1 AND version >= 1 AND amount_minor > 0 AND char_length(btrim(reason)) >= 3
  AND (decision_note IS NULL OR char_length(btrim(decision_note)) >= 3)
  AND (method IS NULL OR method IN ('bank_transfer', 'cheque', 'mpesa', 'cash', 'other'))
  AND (reference IS NULL OR char_length(btrim(reference)) >= 2)
  AND COALESCE(CASE status
    WHEN 'requested' THEN decided_by IS NULL AND paid_by IS NULL
    WHEN 'approved' THEN decided_by IS NOT NULL AND decided_at IS NOT NULL
      AND decided_by <> requested_by AND paid_by IS NULL
    WHEN 'paid' THEN decided_by IS NOT NULL AND decided_by <> requested_by
      AND paid_by IS NOT NULL AND paid_at IS NOT NULL AND paid_on IS NOT NULL
      AND method IS NOT NULL AND reference IS NOT NULL
      AND paid_by <> requested_by AND paid_by <> decided_by
    WHEN 'rejected' THEN decided_by IS NOT NULL AND decided_at IS NOT NULL
      AND decided_by <> requested_by AND decision_note IS NOT NULL AND paid_by IS NULL
    WHEN 'cancelled' THEN decided_by IS NOT NULL AND decided_at IS NOT NULL
      AND decision_note IS NOT NULL AND paid_by IS NULL
    ELSE false
  END, false)
);
-- Requested by the signed-in user on an approved or active subcontract, within the agreed advance
-- (the subcontract row is locked, so two requests cannot both pass); approved by someone else;
-- recorded as paid (outside PM-Buddy) by a third person, not in the future; paid is final.
CREATE FUNCTION app.guard_subcontract_advance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent record;
  committed bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'An advance is never deleted; cancel it' USING ERRCODE = '23514';
  END IF;
  PERFORM app.assert_quality_writable(NEW.tenant_id, NEW.project_id);
  IF TG_OP = 'INSERT' THEN
    SELECT status, advance_limit_minor INTO parent FROM subcontracts
     WHERE tenant_id = NEW.tenant_id AND id = NEW.subcontract_id FOR UPDATE;
    IF NEW.status <> 'requested' OR NEW.requested_by IS DISTINCT FROM app.current_user_id()
       OR parent.status NOT IN ('approved', 'active') THEN
      RAISE EXCEPTION 'An advance is requested by the signed-in user on an approved subcontract'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.number <> COALESCE((SELECT max(number) FROM subcontract_advances
         WHERE tenant_id = NEW.tenant_id AND subcontract_id = NEW.subcontract_id), 0) + 1 THEN
      RAISE EXCEPTION 'Advances are numbered one after another' USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(sum(amount_minor), 0)::bigint INTO committed FROM subcontract_advances
     WHERE tenant_id = NEW.tenant_id AND subcontract_id = NEW.subcontract_id
       AND status IN ('requested', 'approved', 'paid');
    IF committed + NEW.amount_minor > parent.advance_limit_minor THEN
      RAISE EXCEPTION 'Advances never exceed the advance agreed in the subcontract'
        USING ERRCODE = '23514';
    END IF;
    NEW.requested_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'decided_by' - 'decided_at' - 'decision_note' - 'paid_by'
      - 'paid_at' - 'paid_on' - 'method' - 'reference' - 'version')
     IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'decided_by' - 'decided_at' - 'decision_note'
      - 'paid_by' - 'paid_at' - 'paid_on' - 'method' - 'reference' - 'version') THEN
    RAISE EXCEPTION 'An advance keeps its amount and request' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'requested' AND NEW.status IN ('approved', 'rejected') THEN
    IF NEW.decided_by IS DISTINCT FROM app.current_user_id() OR NEW.decided_by = NEW.requested_by
    THEN
      RAISE EXCEPTION 'An advance is decided by someone other than who asked for it'
        USING ERRCODE = '23514';
    END IF;
    NEW.decided_at := clock_timestamp();
  ELSIF OLD.status = 'approved' AND NEW.status = 'paid' THEN
    IF NEW.paid_by IS DISTINCT FROM app.current_user_id() OR NEW.paid_by = NEW.requested_by
       OR NEW.paid_by = NEW.decided_by THEN
      RAISE EXCEPTION 'An advance is paid by someone who neither asked for nor approved it'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.decided_by IS DISTINCT FROM OLD.decided_by OR NEW.paid_on > app.business_today() THEN
      RAISE EXCEPTION 'An advance is paid as approved, not in the future' USING ERRCODE = '23514';
    END IF;
    NEW.paid_at := clock_timestamp();
  ELSIF OLD.status IN ('requested', 'approved') AND NEW.status = 'cancelled' THEN
    IF NEW.decided_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'An advance is cancelled by the signed-in user' USING ERRCODE = '23514';
    END IF;
    NEW.decided_at := clock_timestamp();
  ELSE
    RAISE EXCEPTION 'Advance status cannot change from % to %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER subcontract_advance_guard BEFORE INSERT OR UPDATE OR DELETE
  ON "subcontract_advances" FOR EACH ROW EXECUTE FUNCTION app.guard_subcontract_advance();

-- Certificates -----------------------------------------------------------------------------------------
ALTER TABLE "subcontract_certificates" ADD CONSTRAINT "subcontract_certificates_check" CHECK (
  number >= 1 AND version >= 1 AND revision >= 0 AND line_count BETWEEN 0 AND 500
  AND kind IN ('interim', 'retention_release')
  AND (kind = 'retention_release') = (release_stage IS NOT NULL)
  AND (release_stage IS NULL OR release_stage IN ('practical', 'final'))
  AND valuation_date BETWEEN DATE '2000-01-01' AND DATE '2099-12-31'
  AND contributors IS NOT NULL AND created_by = ANY (contributors)
  AND (digest IS NULL OR digest ~ '^[0-9a-f]{64}$')
  AND (certificate_number IS NULL OR certificate_number >= 1)
  AND (notes IS NULL OR char_length(btrim(notes)) >= 1)
  AND (return_reason IS NULL OR char_length(btrim(return_reason)) >= 3)
  AND COALESCE(CASE status
    WHEN 'draft' THEN digest IS NULL AND submitted_at IS NULL AND certified_at IS NULL
      AND cancelled_at IS NULL AND certificate_number IS NULL AND payable_minor IS NULL
    WHEN 'submitted' THEN digest IS NOT NULL AND submitted_by IS NOT NULL
      AND submitted_at IS NOT NULL AND certified_at IS NULL AND cancelled_at IS NULL
      AND certificate_number IS NULL AND payable_minor IS NOT NULL
    WHEN 'certified' THEN digest IS NOT NULL AND certified_by IS NOT NULL
      AND certified_at IS NOT NULL AND certificate_number IS NOT NULL AND payable_minor IS NOT NULL
      AND cancelled_at IS NULL AND NOT (certified_by = ANY (contributors))
    WHEN 'cancelled' THEN cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL
      AND char_length(btrim(cancel_reason)) >= 3 AND certificate_number IS NULL
    ELSE false
  END, false)
  -- Frozen figures: all or none, and packages/domain computeSubcontractCertificate (KE-SUB-1).
  AND num_nulls(rule_version, contract_version, retention_percent, practical_release_percent,
      vat_percent, wht_percent, advance_recovery_percent, original_value_minor, work_done_minor,
      vatable_work_done_minor, retention_stage, retention_computed_minor, retention_held_minor,
      advances_paid_minor, recovered_to_date_minor, net_to_date_minor, previous_certified_minor,
      amount_due_minor, vat_minor, wht_minor, payable_minor) IN (0, 21)
  AND (payable_minor IS NULL OR (
    rule_version = 'KE-SUB-1' AND contract_version >= 1
    AND retention_stage IN ('none', 'practical', 'final')
    AND (kind = 'interim' OR retention_stage = release_stage)
    AND work_done_minor >= 0 AND vatable_work_done_minor BETWEEN 0 AND work_done_minor
    AND advances_paid_minor >= 0 AND original_value_minor >= 0
    AND (retention_limit_percent IS NULL) = (retention_limit_minor IS NULL)
    AND (retention_limit_minor IS NULL
         OR retention_limit_minor = round(original_value_minor * retention_limit_percent / 100))
    AND retention_computed_minor = LEAST(GREATEST(round(work_done_minor * retention_percent / 100), 0),
                                         COALESCE(retention_limit_minor, 9223372036854775807))
    AND retention_held_minor = CASE retention_stage
      WHEN 'none' THEN retention_computed_minor
      WHEN 'practical' THEN retention_computed_minor
        - round(retention_computed_minor * practical_release_percent / 100)
      ELSE 0 END
    AND recovered_to_date_minor = LEAST(
      GREATEST(round(work_done_minor * advance_recovery_percent / 100), 0), advances_paid_minor)
    AND net_to_date_minor = work_done_minor - retention_held_minor - recovered_to_date_minor
    AND amount_due_minor = net_to_date_minor - previous_certified_minor
    AND vat_minor = CASE WHEN work_done_minor > 0
      THEN app.div_half_up(amount_due_minor * (vat_percent * 100) * vatable_work_done_minor,
                           work_done_minor * 10000) ELSE 0 END
    AND wht_minor = round(amount_due_minor * wht_percent / 100)
    AND payable_minor = amount_due_minor + vat_minor - wht_minor
  ))
);
-- One certificate in preparation per subcontract; one live release per completion stage.
CREATE UNIQUE INDEX "subcontract_certificates_one_open" ON "subcontract_certificates"
  ("tenant_id", "subcontract_id") WHERE status IN ('draft', 'submitted');
CREATE UNIQUE INDEX "subcontract_certificates_one_release_per_stage" ON "subcontract_certificates"
  ("tenant_id", "subcontract_id", "release_stage")
  WHERE kind = 'retention_release' AND status <> 'cancelled';

-- The checks a submitted or certified certificate passes against the rest of the database (on
-- submission and again on certification, so a stale certificate is refused): the subcontract's
-- terms and version in force, every certified certificate netted off, dated on or after the last
-- one and not in the future, the advances paid by its date, an interim only on an active
-- subcontract at the retention stage reached, a release only after the certified completion and
-- releasing no more than is held. COMPLIANCE-REVIEW CR-SCN-01–05.
CREATE FUNCTION app.check_subcontract_certificate(c subcontract_certificates) RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  parent subcontracts%ROWTYPE;
  prior record;
  last record;
  paid bigint;
BEGIN
  SELECT * INTO parent FROM subcontracts WHERE tenant_id = c.tenant_id AND id = c.subcontract_id;
  IF c.retention_percent <> parent.retention_percent
     OR c.retention_limit_percent IS DISTINCT FROM parent.retention_limit_percent
     OR c.practical_release_percent <> parent.practical_release_percent
     OR c.vat_percent <> parent.vat_percent OR c.wht_percent <> parent.wht_percent
     OR c.advance_recovery_percent <> parent.advance_recovery_percent
     OR c.original_value_minor IS DISTINCT FROM parent.original_value_minor
     OR c.contract_version IS DISTINCT FROM parent.contract_version THEN
    RAISE EXCEPTION 'A certificate uses its subcontract''s terms and version in force'
      USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(sum(amount_due_minor), 0)::bigint AS due, max(valuation_date) AS latest,
         bool_or(kind = 'retention_release' AND release_stage = 'final') AS final_released,
         bool_or(kind = 'retention_release' AND release_stage = 'practical') AS practical_released
    INTO prior FROM subcontract_certificates
   WHERE tenant_id = c.tenant_id AND subcontract_id = c.subcontract_id AND status = 'certified'
     AND id <> c.id;
  IF c.previous_certified_minor <> prior.due THEN
    RAISE EXCEPTION 'A certificate nets off every certificate already certified'
      USING ERRCODE = '23514';
  END IF;
  IF c.valuation_date > app.business_today()
     OR (prior.latest IS NOT NULL AND c.valuation_date < prior.latest) THEN
    RAISE EXCEPTION 'A certificate is dated on or after the last one and not in the future'
      USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(sum(amount_minor), 0)::bigint INTO paid FROM subcontract_advances
   WHERE tenant_id = c.tenant_id AND subcontract_id = c.subcontract_id AND status = 'paid'
     AND paid_on <= c.valuation_date;
  IF c.advances_paid_minor <> paid THEN
    RAISE EXCEPTION 'A certificate recovers from the advances paid by its date'
      USING ERRCODE = '23514';
  END IF;
  IF c.kind = 'interim' THEN
    IF parent.status <> 'active' THEN
      RAISE EXCEPTION 'Interim certificates are for an active subcontract' USING ERRCODE = '23514';
    END IF;
    IF c.retention_stage IS DISTINCT FROM (CASE WHEN prior.final_released THEN 'final'
         WHEN prior.practical_released THEN 'practical' ELSE 'none' END) THEN
      RAISE EXCEPTION 'An interim certificate holds the retention left after the releases so far'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM project_completions WHERE tenant_id = c.tenant_id
                    AND project_id = c.project_id AND kind = c.release_stage
                    AND status = 'certified' AND completion_date <= c.valuation_date)
       OR (c.release_stage = 'practical' AND prior.final_released) THEN
      RAISE EXCEPTION 'Retention is released after the certified % completion', c.release_stage
        USING ERRCODE = '23514';
    END IF;
    SELECT * INTO last FROM subcontract_certificates
     WHERE tenant_id = c.tenant_id AND subcontract_id = c.subcontract_id AND status = 'certified'
       AND id <> c.id ORDER BY certificate_number DESC LIMIT 1;
    IF last.id IS NULL OR c.work_done_minor <> last.work_done_minor
       OR c.amount_due_minor < 0 OR c.amount_due_minor > last.retention_held_minor THEN
      RAISE EXCEPTION 'A retention release carries the last certificate forward and releases no more than is held'
        USING ERRCODE = '23514';
    END IF;
  END IF;
END
$$;

-- packages/domain SUBCONTRACT_CERTIFICATE_TRANSITIONS: as app.guard_valuation. Certification is by
-- the signed-in user who never contributed (anyone who created, edited, claimed quantities on or
-- submitted it), numbers it after the last certificate of the subcontract and changes nothing
-- else; certified and cancelled certificates never change and nothing is ever deleted.
CREATE FUNCTION app.guard_subcontract_certificate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent record;
  frozen_old jsonb;
  frozen_new jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A subcontract certificate is never deleted; cancel it'
      USING ERRCODE = '23514';
  END IF;
  PERFORM app.assert_quality_writable(NEW.tenant_id, NEW.project_id);
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO parent FROM subcontracts
     WHERE tenant_id = NEW.tenant_id AND id = NEW.subcontract_id;
    IF NEW.status <> 'draft' OR NEW.created_by IS DISTINCT FROM app.current_user_id()
       OR NEW.revision <> 0 OR NEW.payable_minor IS NOT NULL OR NEW.line_count <> 0 THEN
      RAISE EXCEPTION 'A certificate starts as an empty draft by the signed-in user'
        USING ERRCODE = '23514';
    END IF;
    IF (NEW.kind = 'interim' AND parent.status IS DISTINCT FROM 'active')
       OR (NEW.kind = 'retention_release'
           AND parent.status NOT IN ('active', 'completed', 'terminated')) THEN
      RAISE EXCEPTION 'Interim certificates are for an active subcontract' USING ERRCODE = '23514';
    END IF;
    IF NEW.number <> COALESCE((SELECT max(number) FROM subcontract_certificates
         WHERE tenant_id = NEW.tenant_id AND subcontract_id = NEW.subcontract_id), 0) + 1 THEN
      RAISE EXCEPTION 'Certificates are numbered one after another' USING ERRCODE = '23514';
    END IF;
    IF NEW.valuation_date > app.business_today() THEN
      RAISE EXCEPTION 'A certificate is dated on or after the last one and not in the future'
        USING ERRCODE = '23514';
    END IF;
    NEW.contributors := app.add_contributors(NEW.contributors, NEW.created_by, NEW.updated_by);
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;

  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.subcontract_id IS DISTINCT FROM OLD.subcontract_id OR NEW.number <> OLD.number
     OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.release_stage IS DISTINCT FROM OLD.release_stage
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A certificate keeps its subcontract, number and kind' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('certified', 'cancelled') THEN
    RAISE EXCEPTION 'A % subcontract certificate never changes', OLD.status
      USING ERRCODE = '23514';
  END IF;
  IF NOT (NEW.contributors @> OLD.contributors) THEN
    RAISE EXCEPTION 'A certificate''s contributors are only ever added' USING ERRCODE = '23514';
  END IF;
  frozen_old := to_jsonb(OLD) - 'status' - 'certificate_number' - 'certified_by' - 'certified_at'
    - 'version' - 'updated_by' - 'updated_at' - 'contributors' - 'cancelled_by' - 'cancelled_at'
    - 'cancel_reason';
  frozen_new := to_jsonb(NEW) - 'status' - 'certificate_number' - 'certified_by' - 'certified_at'
    - 'version' - 'updated_by' - 'updated_at' - 'contributors' - 'cancelled_by' - 'cancelled_at'
    - 'cancel_reason';
  IF OLD.status = 'draft' AND NEW.status = 'draft' THEN
    IF NEW.payable_minor IS NOT NULL OR NEW.revision <> OLD.revision OR NEW.digest IS NOT NULL
       OR NEW.submitted_at IS NOT NULL OR NEW.valuation_date > app.business_today() THEN
      RAISE EXCEPTION 'A draft certificate has no figures and is not dated in the future'
        USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.status = 'draft' AND NEW.status = 'submitted' THEN
    IF NEW.submitted_by IS DISTINCT FROM app.current_user_id()
       OR NEW.revision <> OLD.revision + 1 THEN
      RAISE EXCEPTION 'A certificate is submitted by the signed-in user as its next revision'
        USING ERRCODE = '23514';
    END IF;
    NEW.submitted_at := now();
    -- Whoever claimed quantities contributed to what is certified.
    NEW.contributors := app.add_contributors(NEW.contributors, VARIADIC ARRAY(
      SELECT entered_by FROM subcontract_certificate_claims
       WHERE tenant_id = NEW.tenant_id AND certificate_id = NEW.id));
    PERFORM app.check_subcontract_certificate(NEW);
  ELSIF OLD.status = 'submitted' AND NEW.status = 'certified' THEN
    IF frozen_new IS DISTINCT FROM frozen_old THEN
      RAISE EXCEPTION 'A certificate is certified exactly as submitted' USING ERRCODE = '23514';
    END IF;
    IF NEW.certified_by IS DISTINCT FROM app.current_user_id()
       OR NEW.certified_by = ANY (NEW.contributors) THEN
      RAISE EXCEPTION 'A certificate is certified by someone other than those who prepared it'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.certificate_number IS DISTINCT FROM COALESCE((SELECT max(certificate_number)
         FROM subcontract_certificates WHERE tenant_id = NEW.tenant_id
          AND subcontract_id = NEW.subcontract_id), 0) + 1 THEN
      RAISE EXCEPTION 'Certificates are numbered one after another' USING ERRCODE = '23514';
    END IF;
    NEW.certified_at := now();
    PERFORM app.check_subcontract_certificate(NEW);
  ELSIF OLD.status = 'submitted' AND NEW.status = 'draft' THEN
    IF NEW.return_reason IS NULL OR NEW.payable_minor IS NOT NULL OR NEW.digest IS NOT NULL
       OR NEW.revision <> OLD.revision THEN
      RAISE EXCEPTION 'A returned certificate goes back to draft with a reason and no figures'
        USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.status IN ('draft', 'submitted') AND NEW.status = 'cancelled' THEN
    IF NEW.cancelled_by IS DISTINCT FROM app.current_user_id()
       OR frozen_new IS DISTINCT FROM frozen_old THEN
      RAISE EXCEPTION 'A certificate is cancelled by the signed-in user, unchanged'
        USING ERRCODE = '23514';
    END IF;
    NEW.cancelled_at := now();
  ELSE
    RAISE EXCEPTION 'Certificate status cannot change from % to %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('draft', 'submitted') AND NOT (OLD.status = 'submitted' AND NEW.status = 'draft')
  THEN
    NEW.contributors := app.add_contributors(
      NEW.contributors, NEW.created_by, NEW.updated_by, NEW.submitted_by, app.current_user_id());
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER subcontract_certificate_guard BEFORE INSERT OR UPDATE OR DELETE
  ON "subcontract_certificates" FOR EACH ROW EXECUTE FUNCTION app.guard_subcontract_certificate();

ALTER TABLE "subcontract_certificate_claims" ADD CONSTRAINT "subcontract_certificate_claims_check"
  CHECK (quantity_to_date >= 0);
-- A draft interim's claims: entered, changed or removed by the signed-in user only while it is a
-- draft, on a line in force of its subcontract.
CREATE FUNCTION app.guard_subcontract_certificate_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target record;
  row_tenant uuid;
  row_certificate uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    row_tenant := OLD.tenant_id;
    row_certificate := OLD.certificate_id;
  ELSE
    row_tenant := NEW.tenant_id;
    row_certificate := NEW.certificate_id;
  END IF;
  SELECT status, kind, project_id INTO target FROM subcontract_certificates
   WHERE tenant_id = row_tenant AND id = row_certificate;
  IF target.status IS DISTINCT FROM 'draft' OR target.kind IS DISTINCT FROM 'interim' THEN
    RAISE EXCEPTION 'Quantities are claimed only on an interim draft' USING ERRCODE = '23514';
  END IF;
  PERFORM app.assert_quality_writable(row_tenant, target.project_id);
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NEW.entered_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'Quantities are claimed by the signed-in user' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.certificate_id <> OLD.certificate_id OR NEW.line_id <> OLD.line_id)
  THEN
    RAISE EXCEPTION 'A claim keeps its certificate and line' USING ERRCODE = '23514';
  END IF;
  IF NOT app.subcontract_line_live(NEW.tenant_id, (SELECT variation_id FROM subcontract_lines
       WHERE tenant_id = NEW.tenant_id AND id = NEW.line_id)) THEN
    RAISE EXCEPTION 'Quantities are claimed on a line in force' USING ERRCODE = '23514';
  END IF;
  NEW.entered_at := clock_timestamp();
  RETURN NEW;
END
$$;
CREATE TRIGGER subcontract_certificate_claim_guard BEFORE INSERT OR UPDATE OR DELETE
  ON "subcontract_certificate_claims" FOR EACH ROW
  EXECUTE FUNCTION app.guard_subcontract_certificate_claim();

ALTER TABLE "subcontract_certificate_lines" ADD CONSTRAINT "subcontract_certificate_lines_check"
  CHECK (
    revision >= 1 AND line_no >= 1 AND basis IN ('quantity', 'percent')
    AND vat_treatment IN ('standard', 'zero_rated', 'exempt')
    AND quantity_to_date >= 0 AND previous_quantity >= 0 AND line_quantity >= 0
    AND value_to_date_minor >= 0 AND previous_minor >= 0
    AND (measured_to_date IS NULL OR measured_to_date >= 0)
  );
-- Lines are written only with their certificate's submission (same transaction, that revision).
CREATE FUNCTION app.guard_subcontract_certificate_line() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Certificate lines never change' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM subcontract_certificates
     WHERE tenant_id = NEW.tenant_id AND id = NEW.certificate_id AND status = 'submitted'
       AND revision = NEW.revision AND submitted_at = now()
  ) THEN
    RAISE EXCEPTION 'Certificate lines are written only with their submission'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER subcontract_certificate_line_guard BEFORE INSERT OR UPDATE OR DELETE
  ON "subcontract_certificate_lines" FOR EACH ROW
  EXECUTE FUNCTION app.guard_subcontract_certificate_line();

-- At commit of a submission or certification the frozen lines match the header and the
-- subcontract: the declared count, work done and VATable work; one line per line in force, at its
-- terms in force (packages/domain subcontractLineValueMinor), within its quantity, carrying the
-- last certified figures as "previous"; a release changes no quantity; and, per BQ item this
-- certificate claims, the latest claims of every subcontract never exceed the item's approved
-- measured quantity (each item locked in lineage order), nor does this claim exceed what was
-- measured on its own date — the same measured quantity is never paid to two subcontracts.
CREATE FUNCTION app.check_subcontract_certificate_lines() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  sums record;
  lineage uuid;
  claimed numeric;
  own numeric;
  latest date;
BEGIN
  IF NEW.status NOT IN ('submitted', 'certified') THEN
    RETURN NULL;
  END IF;
  SELECT count(*) AS lines, count(DISTINCT line_id) AS distinct_lines,
         COALESCE(sum(value_to_date_minor), 0) AS work,
         COALESCE(sum(value_to_date_minor) FILTER (WHERE vat_treatment = 'standard'), 0) AS vatable
    INTO sums FROM subcontract_certificate_lines
   WHERE tenant_id = NEW.tenant_id AND certificate_id = NEW.id AND revision = NEW.revision;
  IF sums.lines <> NEW.line_count OR sums.distinct_lines <> sums.lines
     OR sums.work <> NEW.work_done_minor OR sums.vatable <> NEW.vatable_work_done_minor
     OR sums.lines <> (SELECT count(*) FROM subcontract_lines l WHERE l.tenant_id = NEW.tenant_id
                        AND l.subcontract_id = NEW.subcontract_id
                        AND app.subcontract_line_live(l.tenant_id, l.variation_id)) THEN
    RAISE EXCEPTION 'A subcontract certificate''s lines add up to its figures, one per line'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM subcontract_certificate_lines cl
      JOIN subcontract_lines l ON l.tenant_id = cl.tenant_id AND l.id = cl.line_id
      CROSS JOIN LATERAL app.subcontract_line_in_force(l.tenant_id, l.id) f
      LEFT JOIN LATERAL (
        SELECT p.quantity_to_date, p.value_to_date_minor
          FROM subcontract_certificate_lines p
          JOIN subcontract_certificates pc ON pc.tenant_id = p.tenant_id
           AND pc.id = p.certificate_id AND pc.revision = p.revision
         WHERE p.tenant_id = cl.tenant_id AND p.line_id = cl.line_id AND pc.status = 'certified'
           AND pc.id <> NEW.id
         ORDER BY pc.certificate_number DESC LIMIT 1) prev ON true
     WHERE cl.tenant_id = NEW.tenant_id AND cl.certificate_id = NEW.id
       AND cl.revision = NEW.revision
       AND (l.subcontract_id <> NEW.subcontract_id
            OR NOT app.subcontract_line_live(l.tenant_id, l.variation_id)
            OR cl.bq_item_lineage_id <> l.bq_item_lineage_id OR cl.basis <> l.basis
            OR cl.rate_minor IS DISTINCT FROM l.rate_minor OR cl.vat_treatment <> l.vat_treatment
            OR cl.line_quantity <> f.quantity OR cl.line_amount_minor <> f.amount_minor
            OR cl.quantity_to_date > cl.line_quantity
            OR cl.value_to_date_minor <> app.subcontract_line_value(cl.basis, cl.rate_minor,
                 cl.line_amount_minor, cl.line_quantity, cl.quantity_to_date)
            OR cl.previous_quantity <> COALESCE(prev.quantity_to_date, 0)
            OR cl.previous_minor <> COALESCE(prev.value_to_date_minor, 0)
            OR (NEW.kind = 'retention_release' AND cl.quantity_to_date <> cl.previous_quantity))
  ) THEN
    RAISE EXCEPTION 'Each line values its quantity to date at the subcontract''s terms in force'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'interim' THEN
    FOR lineage IN
      SELECT DISTINCT bq_item_lineage_id FROM subcontract_certificate_lines
       WHERE tenant_id = NEW.tenant_id AND certificate_id = NEW.id AND revision = NEW.revision
         AND quantity_to_date > 0
       ORDER BY 1
    LOOP
      PERFORM pg_advisory_xact_lock(
        hashtextextended('subcontract-claim:' || NEW.tenant_id || ':' || lineage, 0));
      WITH latest_certificates AS (
        SELECT DISTINCT ON (c.subcontract_id) c.id, c.revision, c.valuation_date
          FROM subcontract_certificates c
         WHERE c.tenant_id = NEW.tenant_id AND c.project_id = NEW.project_id
           AND (c.id = NEW.id OR (c.subcontract_id <> NEW.subcontract_id
                                  AND c.status IN ('submitted', 'certified')))
         ORDER BY c.subcontract_id, c.number DESC
      )
      SELECT COALESCE(sum(cl.quantity_to_date), 0), max(lc.valuation_date)
        INTO claimed, latest
        FROM latest_certificates lc
        JOIN subcontract_certificate_lines cl ON cl.tenant_id = NEW.tenant_id
         AND cl.certificate_id = lc.id AND cl.revision = lc.revision
         AND cl.bq_item_lineage_id = lineage;
      SELECT COALESCE(sum(quantity_to_date), 0) INTO own FROM subcontract_certificate_lines
       WHERE tenant_id = NEW.tenant_id AND certificate_id = NEW.id AND revision = NEW.revision
         AND bq_item_lineage_id = lineage;
      IF claimed > app.measured_in_force(NEW.tenant_id, NEW.project_id, lineage,
                                         GREATEST(latest, NEW.valuation_date))
         OR own > app.measured_in_force(NEW.tenant_id, NEW.project_id, lineage, NEW.valuation_date)
      THEN
        RAISE EXCEPTION 'Subcontract claims on a BQ item never exceed its approved measured quantity'
          USING ERRCODE = '23514';
      END IF;
    END LOOP;
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER subcontract_certificate_lines_complete AFTER UPDATE
  ON "subcontract_certificates" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION app.check_subcontract_certificate_lines();

-- Payments recorded against certified certificates ---------------------------------------------------
ALTER TABLE "subcontract_payments" ADD CONSTRAINT "subcontract_payments_check" CHECK (
  amount_minor > 0 AND method IN ('bank_transfer', 'cheque', 'mpesa', 'cash', 'other')
  AND char_length(btrim(reference)) >= 2 AND reference_key = app.invoice_number_key(reference)
  AND char_length(reference_key) >= 1
  AND char_length(idempotency_key) BETWEEN 8 AND 100 AND request_digest ~ '^[0-9a-f]{64}$'
  AND paid_on BETWEEN DATE '2000-01-01' AND DATE '2099-12-31'
);
-- Recorded by the signed-in user who did not certify the certificate, against a certified
-- certificate with something payable, never above what is still payable (the certificate row is
-- locked, so two payments cannot both pass), not in the future. Stamped with the clock (the cost
-- apportionment orders payments by it). Never changed or deleted.
CREATE FUNCTION app.guard_subcontract_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target record;
  paid bigint;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'A recorded payment never changes; record a correction with the bank'
      USING ERRCODE = '23514';
  END IF;
  PERFORM app.assert_quality_writable(NEW.tenant_id, NEW.project_id);
  SELECT status, certified_by, payable_minor, subcontract_id, project_id INTO target
    FROM subcontract_certificates
   WHERE tenant_id = NEW.tenant_id AND id = NEW.certificate_id FOR UPDATE;
  IF target.status IS DISTINCT FROM 'certified' OR target.payable_minor <= 0
     OR target.subcontract_id <> NEW.subcontract_id OR target.project_id <> NEW.project_id THEN
    RAISE EXCEPTION 'Payments are recorded against a certified certificate with something payable'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.recorded_by IS DISTINCT FROM app.current_user_id()
     OR NEW.recorded_by = target.certified_by THEN
    RAISE EXCEPTION 'A payment is recorded by someone other than the certifier'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.paid_on > app.business_today() THEN
    RAISE EXCEPTION 'A payment is not recorded in the future' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(sum(amount_minor), 0)::bigint INTO paid FROM subcontract_payments
   WHERE tenant_id = NEW.tenant_id AND certificate_id = NEW.certificate_id;
  IF paid + NEW.amount_minor > target.payable_minor THEN
    RAISE EXCEPTION 'Payments never exceed what the certificate made payable'
      USING ERRCODE = '23514';
  END IF;
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END
$$;
CREATE TRIGGER subcontract_payment_guard BEFORE INSERT OR UPDATE OR DELETE
  ON "subcontract_payments" FOR EACH ROW EXECUTE FUNCTION app.guard_subcontract_payment();

-- The subcontractor's tax invoice matched to a certificate --------------------------------------------
ALTER TABLE "subcontract_invoices" ADD CONSTRAINT "subcontract_invoices_check" CHECK (
  char_length(btrim(invoice_number)) >= 1
  AND invoice_number_key = app.invoice_number_key(invoice_number)
  AND char_length(invoice_number_key) >= 1
  AND (etims_number IS NULL OR char_length(btrim(etims_number)) >= 1)
  AND amount_minor > 0 AND invoice_date BETWEEN DATE '2000-01-01' AND DATE '2099-12-31'
);
-- One per certified certificate, from its subcontractor, for exactly the certificate's amount due
-- plus VAT, by the signed-in user; its number is never also a supplier invoice of the same
-- supplier (that invoice would accrue the same work a second time). Never changed or deleted.
CREATE FUNCTION app.guard_subcontract_invoice() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'A matched invoice never changes' USING ERRCODE = '23514';
  END IF;
  SELECT c.status, c.amount_due_minor, c.vat_minor, s.supplier_id, c.project_id INTO target
    FROM subcontract_certificates c
    JOIN subcontracts s ON s.tenant_id = c.tenant_id AND s.id = c.subcontract_id
   WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.certificate_id;
  PERFORM app.assert_quality_writable(NEW.tenant_id, target.project_id);
  IF target.status IS DISTINCT FROM 'certified' OR NEW.supplier_id <> target.supplier_id
     OR NEW.amount_minor <> target.amount_due_minor + target.vat_minor
     OR NEW.recorded_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'An invoice matches a certified certificate of its subcontractor, for its amount due and VAT'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM supplier_invoices WHERE tenant_id = NEW.tenant_id
              AND supplier_id = NEW.supplier_id AND invoice_number_key = NEW.invoice_number_key
              AND status <> 'cancelled') THEN
    RAISE EXCEPTION 'This invoice number is already a supplier invoice of the subcontractor'
      USING ERRCODE = '23514';
  END IF;
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END
$$;
CREATE TRIGGER subcontract_invoice_guard BEFORE INSERT OR UPDATE OR DELETE
  ON "subcontract_invoices" FOR EACH ROW EXECUTE FUNCTION app.guard_subcontract_invoice();

-- The other direction: a procure-to-pay invoice never reuses a number matched to a certificate
-- (named to fire before supplier_invoice_guard: BEFORE triggers run in name order).
CREATE FUNCTION app.refuse_subcontract_invoice_number() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'cancelled' AND EXISTS (
    SELECT 1 FROM subcontract_invoices WHERE tenant_id = NEW.tenant_id
       AND supplier_id = NEW.supplier_id AND invoice_number_key = NEW.invoice_number_key
  ) THEN
    RAISE EXCEPTION 'This invoice number is matched to a subcontract certificate'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER subcontract_invoice_number_free BEFORE INSERT OR UPDATE OF invoice_number_key,
  supplier_id, status ON "supplier_invoices" FOR EACH ROW
  EXECUTE FUNCTION app.refuse_subcontract_invoice_number();

-- The cost ledger: three new sources -----------------------------------------------------------------
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
    ELSE false
  END, false)
);
-- Each new source posts once (its reversal aside).
CREATE UNIQUE INDEX "cost_entries_subcontract_line_once" ON "cost_entries"
  ("tenant_id", "subcontract_certificate_id", "subcontract_line_id")
  WHERE source = 'subcontract_certificate';
CREATE UNIQUE INDEX "cost_entries_subcontract_payment_once" ON "cost_entries"
  ("tenant_id", "subcontract_payment_id") WHERE subcontract_payment_id IS NOT NULL;
CREATE UNIQUE INDEX "cost_entries_subcontract_advance_once" ON "cost_entries"
  ("tenant_id", "subcontract_advance_id") WHERE subcontract_advance_id IS NOT NULL;

-- app.check_cost_entry gains the subcontract sources (the rest is unchanged from D5.4): a
-- certificate entry is the work certified on one line this period (value to date − previous) at
-- the line's BQ item; a payment entry is the cost part of the cash (its share of the amount due,
-- cumulative half-up like a supplier settlement); an advance entry is the advance paid.
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

-- Automatic postings (decision D-145): a certified certificate posts the work certified this period
-- once per line (accrued, subcontract, the line's BQ item); a recorded payment posts the cost part
-- of its cash (paid); an advance recorded as paid posts the advance (paid, no BQ item). A retention
-- release posts no accrual (the work was accrued gross); its payment posts the cash.
CREATE FUNCTION app.post_subcontract_certificate_cost() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  src record;
BEGIN
  SELECT s.supplier_id, s.number, COALESCE(p.trading_name, p.legal_name) AS supplier_name
    INTO src
    FROM subcontracts s JOIN suppliers p ON p.tenant_id = s.tenant_id AND p.id = s.supplier_id
   WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.subcontract_id;
  INSERT INTO cost_entries (id, tenant_id, project_id, measure, category, bq_version_id,
    bq_item_lineage_id, counterparty_kind, supplier_id, counterparty_name, payment_reference,
    amount_minor, occurred_on, source, purpose, subcontract_certificate_id, subcontract_line_id,
    recorded_by, business_date)
  SELECT uuidv7(), NEW.tenant_id, NEW.project_id, 'accrued', 'subcontract', l.bq_version_id,
         l.bq_item_lineage_id, 'supplier', src.supplier_id, left(src.supplier_name, 200),
         app.subcontract_certificate_reference(src.number, NEW.certificate_number),
         cl.value_to_date_minor - cl.previous_minor, NEW.valuation_date,
         'subcontract_certificate', 'accrual', NEW.id, cl.line_id, app.current_user_id(),
         app.business_today()
    FROM subcontract_certificate_lines cl
    JOIN subcontract_lines l ON l.tenant_id = cl.tenant_id AND l.id = cl.line_id
   WHERE cl.tenant_id = NEW.tenant_id AND cl.certificate_id = NEW.id
     AND cl.revision = NEW.revision AND cl.value_to_date_minor <> cl.previous_minor
   ORDER BY cl.line_no;
  RETURN NULL;
END
$$;
CREATE TRIGGER subcontract_certificate_cost AFTER UPDATE OF status ON "subcontract_certificates"
  FOR EACH ROW WHEN (NEW.status = 'certified' AND OLD.status = 'submitted')
  EXECUTE FUNCTION app.post_subcontract_certificate_cost();

CREATE FUNCTION app.post_subcontract_payment_cost() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  src record;
  settled_before bigint;
  cost bigint;
BEGIN
  SELECT c.amount_due_minor, c.payable_minor, s.supplier_id,
         COALESCE(p.trading_name, p.legal_name) AS supplier_name
    INTO src
    FROM subcontract_certificates c
    JOIN subcontracts s ON s.tenant_id = c.tenant_id AND s.id = c.subcontract_id
    JOIN suppliers p ON p.tenant_id = s.tenant_id AND p.id = s.supplier_id
   WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.certificate_id;
  SELECT COALESCE(sum(amount_minor), 0) INTO settled_before FROM subcontract_payments
   WHERE tenant_id = NEW.tenant_id AND certificate_id = NEW.certificate_id
     AND (recorded_at, id) < (NEW.recorded_at, NEW.id);
  cost := app.settlement_cost_minor(src.amount_due_minor, src.payable_minor, settled_before,
                                    NEW.amount_minor);
  IF cost <> 0 THEN
    INSERT INTO cost_entries (id, tenant_id, project_id, measure, category, counterparty_kind,
      supplier_id, counterparty_name, payment_reference, amount_minor, occurred_on, source,
      purpose, subcontract_payment_id, recorded_by, business_date)
    VALUES (uuidv7(), NEW.tenant_id, NEW.project_id, 'paid', 'subcontract', 'supplier',
      src.supplier_id, left(src.supplier_name, 200), NEW.reference, cost, NEW.paid_on,
      'subcontract_payment', 'payment', NEW.id, app.current_user_id(), app.business_today());
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER subcontract_payment_cost AFTER INSERT ON "subcontract_payments"
  FOR EACH ROW EXECUTE FUNCTION app.post_subcontract_payment_cost();

CREATE FUNCTION app.post_subcontract_advance_cost() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  src record;
BEGIN
  SELECT s.supplier_id, COALESCE(p.trading_name, p.legal_name) AS supplier_name INTO src
    FROM subcontracts s JOIN suppliers p ON p.tenant_id = s.tenant_id AND p.id = s.supplier_id
   WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.subcontract_id;
  INSERT INTO cost_entries (id, tenant_id, project_id, measure, category, counterparty_kind,
    supplier_id, counterparty_name, payment_reference, amount_minor, occurred_on, source, purpose,
    subcontract_advance_id, recorded_by, business_date)
  VALUES (uuidv7(), NEW.tenant_id, NEW.project_id, 'paid', 'subcontract', 'supplier',
    src.supplier_id, left(src.supplier_name, 200), NEW.reference, NEW.amount_minor, NEW.paid_on,
    'subcontract_advance', 'payment', NEW.id, app.current_user_id(), app.business_today());
  RETURN NULL;
END
$$;
CREATE TRIGGER subcontract_advance_cost AFTER UPDATE OF status ON "subcontract_advances"
  FOR EACH ROW WHEN (NEW.status = 'paid' AND OLD.status = 'approved')
  EXECUTE FUNCTION app.post_subcontract_advance_cost();

-- Piece-rate jobs ------------------------------------------------------------------------------------
ALTER TABLE "piece_rate_jobs" ADD CONSTRAINT "piece_rate_jobs_check" CHECK (
  number >= 1 AND version >= 1 AND (labourer_id IS NULL) <> (gang_id IS NULL)
  AND char_length(btrim(description)) >= 3 AND char_length(btrim(unit)) >= 1
  AND char_length(btrim(bq_unit)) >= 1 AND conversion_factor > 0
  AND (unit <> bq_unit OR conversion_factor = 1)
  AND rate_minor BETWEEN 1 AND 100000000 AND agreed_quantity > 0
  AND start_date BETWEEN DATE '2000-01-01' AND DATE '2099-12-31'
  AND end_date BETWEEN start_date AND DATE '2099-12-31'
  AND (decision_note IS NULL OR char_length(btrim(decision_note)) >= 3)
  AND (decided_by IS NULL OR decided_by <> created_by)
  AND COALESCE(CASE status
    WHEN 'pending' THEN decided_by IS NULL AND decided_at IS NULL AND closed_at IS NULL
    WHEN 'approved' THEN decided_by IS NOT NULL AND decided_at IS NOT NULL AND closed_at IS NULL
    WHEN 'rejected' THEN decided_by IS NOT NULL AND decided_at IS NOT NULL
      AND decision_note IS NOT NULL AND closed_at IS NULL
    WHEN 'closed' THEN decided_by IS NOT NULL AND closed_by IS NOT NULL AND closed_at IS NOT NULL
    ELSE false
  END, false)
);
-- Created by the signed-in user against an item of the BQ in force measured by quantity, in the
-- item's unit (or a unit converted to it); terms never change (reject and create another);
-- approved or rejected once by someone other than the creator; approved → closed. Never deleted.
CREATE FUNCTION app.guard_piece_rate_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A piece-rate job is never deleted; reject or close it' USING ERRCODE = '23514';
  END IF;
  PERFORM app.assert_quality_writable(NEW.tenant_id, NEW.project_id);
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.created_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'A piece-rate job starts pending, by the signed-in user'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.number <> COALESCE((SELECT max(number) FROM piece_rate_jobs
         WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id), 0) + 1 THEN
      RAISE EXCEPTION 'Piece-rate jobs are numbered one after another' USING ERRCODE = '23514';
    END IF;
    IF NEW.bq_version_id IS DISTINCT FROM app.bq_version_in_force(NEW.tenant_id, NEW.project_id)
    THEN
      RAISE EXCEPTION 'A piece-rate job names an item of the BQ in force' USING ERRCODE = '23514';
    END IF;
    SELECT kind, quantity, amount_minor, unit INTO item FROM bq_items
     WHERE tenant_id = NEW.tenant_id AND version_id = NEW.bq_version_id
       AND lineage_id = NEW.bq_item_lineage_id;
    IF app.measurement_basis(item.kind, item.quantity, item.amount_minor) IS DISTINCT FROM 'quantity'
       OR NEW.bq_unit IS DISTINCT FROM item.unit THEN
      RAISE EXCEPTION 'A piece-rate job is for an item measured by quantity, in its unit'
        USING ERRCODE = '23514';
    END IF;
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'decided_by' - 'decided_at' - 'decision_note' - 'closed_by'
      - 'closed_at' - 'version')
     IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'decided_by' - 'decided_at' - 'decision_note'
      - 'closed_by' - 'closed_at' - 'version') THEN
    RAISE EXCEPTION 'A piece-rate job keeps its terms' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected') THEN
    IF NEW.decided_by IS DISTINCT FROM app.current_user_id() OR NEW.decided_by = NEW.created_by THEN
      RAISE EXCEPTION 'A piece-rate job is decided by someone other than its creator'
        USING ERRCODE = '23514';
    END IF;
    NEW.decided_at := clock_timestamp();
  ELSIF OLD.status = 'approved' AND NEW.status = 'closed' THEN
    IF NEW.closed_by IS DISTINCT FROM app.current_user_id()
       OR NEW.decided_by IS DISTINCT FROM OLD.decided_by THEN
      RAISE EXCEPTION 'A piece-rate job is closed by the signed-in user' USING ERRCODE = '23514';
    END IF;
    NEW.closed_at := clock_timestamp();
  ELSE
    RAISE EXCEPTION 'Piece-rate job status cannot change from % to %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER piece_rate_job_guard BEFORE INSERT OR UPDATE OR DELETE ON "piece_rate_jobs"
  FOR EACH ROW EXECUTE FUNCTION app.guard_piece_rate_job();

ALTER TABLE "piece_rate_job_extensions" ADD CONSTRAINT "piece_rate_job_extensions_check" CHECK (
  quantity > 0 AND version >= 1 AND char_length(btrim(reason)) >= 3
  AND (decision_note IS NULL OR char_length(btrim(decision_note)) >= 3)
  AND (decided_by IS NULL OR decided_by <> requested_by)
  AND COALESCE(CASE status
    WHEN 'pending' THEN decided_by IS NULL AND decided_at IS NULL
    WHEN 'approved' THEN decided_by IS NOT NULL AND decided_at IS NOT NULL
    WHEN 'rejected' THEN decided_by IS NOT NULL AND decided_at IS NOT NULL
      AND decision_note IS NOT NULL
    ELSE false
  END, false)
);
-- Asked for by the signed-in user on an approved job; decided once by someone else. Append-only.
CREATE FUNCTION app.guard_piece_rate_job_extension() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'An extension is never deleted' USING ERRCODE = '23514';
  END IF;
  PERFORM app.assert_quality_writable(NEW.tenant_id, NEW.project_id);
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.requested_by IS DISTINCT FROM app.current_user_id()
       OR (SELECT status FROM piece_rate_jobs WHERE tenant_id = NEW.tenant_id
            AND id = NEW.job_id) IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION 'An extension is asked for by the signed-in user on an approved job'
        USING ERRCODE = '23514';
    END IF;
    NEW.requested_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF OLD.status <> 'pending' OR NEW.status NOT IN ('approved', 'rejected')
     OR (to_jsonb(NEW) - 'status' - 'decided_by' - 'decided_at' - 'decision_note' - 'version')
        IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'decided_by' - 'decided_at'
        - 'decision_note' - 'version') THEN
    RAISE EXCEPTION 'An extension is decided once and never rewritten' USING ERRCODE = '23514';
  END IF;
  IF NEW.decided_by IS DISTINCT FROM app.current_user_id() OR NEW.decided_by = NEW.requested_by THEN
    RAISE EXCEPTION 'An extension is decided by someone other than who asked for it'
      USING ERRCODE = '23514';
  END IF;
  NEW.decided_at := clock_timestamp();
  RETURN NEW;
END
$$;
CREATE TRIGGER piece_rate_job_extension_guard BEFORE INSERT OR UPDATE OR DELETE
  ON "piece_rate_job_extensions" FOR EACH ROW
  EXECUTE FUNCTION app.guard_piece_rate_job_extension();

-- Output that names a job (decision D-147; D4.1's own guard still applies first): recorded against
-- an approved job within its dates, at the job's rate and unit, for its worker and BQ item; the job
-- row is locked, and recorded (pending + approved) output never exceeds the quantity in force;
-- approval re-checks the approved output alone. The job link never changes.
CREATE FUNCTION app.guard_piece_rate_output_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  job piece_rate_jobs%ROWTYPE;
  in_force numeric;
  used numeric;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.job_id IS DISTINCT FROM OLD.job_id THEN
      RAISE EXCEPTION 'An output keeps its job' USING ERRCODE = '23514';
    END IF;
    IF NEW.job_id IS NULL OR NOT (OLD.status = 'pending' AND NEW.status = 'approved') THEN
      RETURN NEW;
    END IF;
  ELSIF NEW.job_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO job FROM piece_rate_jobs
   WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id AND id = NEW.job_id FOR UPDATE;
  in_force := job.agreed_quantity + COALESCE((SELECT sum(quantity) FROM piece_rate_job_extensions
    WHERE tenant_id = job.tenant_id AND job_id = job.id AND status = 'approved'), 0);
  IF TG_OP = 'INSERT' THEN
    IF job.status IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION 'Output is recorded against an approved job' USING ERRCODE = '23514';
    END IF;
    IF NEW.work_date < job.start_date OR NEW.work_date > job.end_date THEN
      RAISE EXCEPTION 'Output is recorded within the job''s dates' USING ERRCODE = '23514';
    END IF;
    IF NEW.rate_minor <> job.rate_minor OR NEW.unit <> job.unit
       OR NEW.labourer_id IS DISTINCT FROM job.labourer_id
       OR NEW.gang_id IS DISTINCT FROM job.gang_id
       OR (SELECT lineage_id FROM bq_items WHERE tenant_id = NEW.tenant_id AND id = NEW.bq_item_id)
          IS DISTINCT FROM job.bq_item_lineage_id THEN
      RAISE EXCEPTION 'Output against a job takes the job''s rate, unit, worker and BQ item'
        USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(sum(quantity), 0) INTO used FROM piece_rate_outputs
     WHERE tenant_id = NEW.tenant_id AND job_id = NEW.job_id AND status IN ('pending', 'approved');
  ELSE
    SELECT COALESCE(sum(quantity), 0) INTO used FROM piece_rate_outputs
     WHERE tenant_id = NEW.tenant_id AND job_id = NEW.job_id AND status = 'approved'
       AND id <> NEW.id;
  END IF;
  IF used + NEW.quantity > in_force THEN
    RAISE EXCEPTION 'Output on a job never exceeds its agreed quantity without an approved extension'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER piece_rate_output_job_guard BEFORE INSERT OR UPDATE ON "piece_rate_outputs"
  FOR EACH ROW EXECUTE FUNCTION app.guard_piece_rate_output_job();

-- Row-level security -----------------------------------------------------------------------------------
DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['subcontracts', 'subcontract_lines', 'subcontract_variations',
    'subcontract_line_changes', 'subcontract_advances', 'subcontract_certificates',
    'subcontract_certificate_claims', 'subcontract_certificate_lines', 'subcontract_payments',
    'subcontract_invoices', 'piece_rate_jobs', 'piece_rate_job_extensions']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = app.current_tenant_id()) '
      'WITH CHECK (tenant_id = app.current_tenant_id())', target || '_isolation', target);
  END LOOP;
END
$$;

-- Subcontracts concern suppliers: a supplier-role member (D7.2 portal) reads and writes none of
-- them, except that it may read its own supplier's matched invoices (so the invoice-number check
-- above also holds for invoices it submits through the portal); anyone else is unaffected.
DO $$
DECLARE
  not_supplier constant text := 'NOT EXISTS (SELECT 1 FROM memberships m '
    'WHERE m.tenant_id = app.current_tenant_id() AND m.user_id = app.current_user_id() '
    'AND m.role = ''supplier'')';
  own constant text := 'SELECT s.supplier_id FROM supplier_portal_users s '
    'WHERE s.tenant_id = app.current_tenant_id() AND s.user_id = app.current_user_id() '
    'AND s.status = ''active''';
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['subcontracts', 'subcontract_lines', 'subcontract_variations',
    'subcontract_line_changes', 'subcontract_advances', 'subcontract_certificates',
    'subcontract_certificate_claims', 'subcontract_certificate_lines', 'subcontract_payments']
  LOOP
    EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE USING (%s) WITH CHECK (%s)',
      target || '_supplier_portal', target, not_supplier, not_supplier);
  END LOOP;
  EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE USING (%s OR supplier_id IN (%s)) '
    'WITH CHECK (%s)', 'subcontract_invoices_supplier_portal', 'subcontract_invoices',
    not_supplier, own, not_supplier);
END
$$;

-- The runtime role never deletes or rewrites subcontract records (only a draft's lines and a draft
-- certificate's claims may be removed); lines, changes, frozen certificate lines, payments and
-- matched invoices are insert-only; everything else changes through the guarded transitions.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmb_app') THEN
    REVOKE DELETE ON "subcontracts", "subcontract_variations", "subcontract_line_changes",
      "subcontract_advances", "subcontract_certificates", "subcontract_certificate_lines",
      "subcontract_payments", "subcontract_invoices", "piece_rate_jobs",
      "piece_rate_job_extensions" FROM pmb_app;
    REVOKE UPDATE ON "subcontract_lines", "subcontract_line_changes",
      "subcontract_certificate_lines", "subcontract_payments", "subcontract_invoices" FROM pmb_app;
    REVOKE TRUNCATE, REFERENCES, TRIGGER ON "subcontracts", "subcontract_lines",
      "subcontract_variations", "subcontract_line_changes", "subcontract_advances",
      "subcontract_certificates", "subcontract_certificate_claims", "subcontract_certificate_lines",
      "subcontract_payments", "subcontract_invoices", "piece_rate_jobs",
      "piece_rate_job_extensions" FROM pmb_app;
    GRANT EXECUTE ON FUNCTION app.bq_version_in_force(uuid, uuid) TO pmb_app;
    GRANT EXECUTE ON FUNCTION app.subcontract_line_value(text, bigint, bigint, numeric, numeric)
      TO pmb_app;
    GRANT EXECUTE ON FUNCTION app.subcontract_line_live(uuid, uuid) TO pmb_app;
    GRANT EXECUTE ON FUNCTION app.subcontract_line_in_force(uuid, uuid) TO pmb_app;
    GRANT EXECUTE ON FUNCTION app.subcontract_item_capacity(uuid, uuid, uuid) TO pmb_app;
    GRANT EXECUTE ON FUNCTION app.subcontract_item_let(uuid, uuid, uuid, uuid) TO pmb_app;
    GRANT EXECUTE ON FUNCTION app.measured_in_force(uuid, uuid, uuid, date) TO pmb_app;
    GRANT EXECUTE ON FUNCTION app.assert_subcontractor(uuid, uuid) TO pmb_app;
    GRANT EXECUTE ON FUNCTION app.subcontract_certificate_reference(integer, integer) TO pmb_app;
    GRANT EXECUTE ON FUNCTION app.invoice_number_key(text) TO pmb_app;
    GRANT EXECUTE ON FUNCTION app.subcontract_terms(subcontracts) TO pmb_app;
    GRANT EXECUTE ON FUNCTION app.check_subcontract_caps(uuid, uuid) TO pmb_app;
    GRANT EXECUTE ON FUNCTION app.check_subcontract_certificate(subcontract_certificates)
      TO pmb_app;
  END IF;
END
$$;
REVOKE EXECUTE ON FUNCTION app.bq_version_in_force(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.subcontract_line_value(text, bigint, bigint, numeric, numeric)
  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.subcontract_line_live(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.subcontract_line_in_force(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.subcontract_item_capacity(uuid, uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.subcontract_item_let(uuid, uuid, uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.measured_in_force(uuid, uuid, uuid, date) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.assert_subcontractor(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.subcontract_certificate_reference(integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.invoice_number_key(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.subcontract_terms(subcontracts) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_subcontract_caps(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_subcontract_certificate(subcontract_certificates) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_subcontract() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_subcontract_line() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_subcontract_variation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_subcontract_variation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_subcontract_line_change() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_subcontract_advance() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_subcontract_certificate() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_subcontract_certificate_claim() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_subcontract_certificate_line() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_subcontract_certificate_lines() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_subcontract_payment() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_subcontract_invoice() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.refuse_subcontract_invoice_number() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.post_subcontract_certificate_cost() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.post_subcontract_payment_cost() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.post_subcontract_advance_cost() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_piece_rate_job() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_piece_rate_job_extension() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_piece_rate_output_job() FROM PUBLIC;

COMMIT;
