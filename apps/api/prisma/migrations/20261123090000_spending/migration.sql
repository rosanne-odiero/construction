-- D5.4 Spending and cash flow (ARCHITECTURE §4.8, ERD §8, WORKFLOWS "Budgets" and "Petty cash",
-- brief §5.8 and §15 C/D). Enforces, in the database as well as the API:
-- * AN APPEND-ONLY COST LEDGER (cost_entries): every entry is tagged with project, site, BQ item or
--   cost code, category, counterparty and payment reference, in one of two measures (accrued,
--   paid), from exactly one source, posted once per purpose (partial unique indexes), checked
--   against its source by app.check_cost_entry, and never updated or deleted (trigger + revoked
--   privileges); a correction is a reversing entry from an approved reversal journal.
-- * NO DOUBLE COUNTING: an approved supplier invoice accrues its subtotal (net of VAT, materials
--   held in stores) once; each settlement posts only the cost part of the cash it paid
--   (app.settlement_cost_minor, cumulative half-up, so the parts add up to the subtotal). Stock
--   issues re-allocate accrued material cost to BQ items in the read model; they never post cost.
--   Both automatic postings are made by triggers on the D5.2 tables, so no code path can skip them.
-- * PETTY-CASH FLOATS THAT NEVER GO NEGATIVE: each float's book balance moves only through its own
--   append-only ledger; app.post_float_entry locks the float row (SELECT … FOR UPDATE), checks the
--   source (paid top-up, submitted or rejected expense, approved count) and refuses a balance
--   below zero or a top-up above the limit; app.guard_petty_cash_float refuses any other change.
-- * MAKER-CHECKER BY IDENTITY: budgets are approved by someone who never contributed; journals by
--   someone other than their author; expenses and counts by someone who is neither the recorder,
--   the counter nor the float's custodian; top-ups approved by someone other than the requester
--   and paid by someone other than the approver.
-- * Expenses are offline-ready (client ID, idempotency key, request digest) and an M-Pesa code is
--   used by at most one expense that was not rejected.
-- * The new permission finance.petty_cash joins the role and project-assignment CHECKs.
-- Every table has tenant_id, forced RLS with WITH CHECK and composite (tenant_id, …) foreign keys.
BEGIN;

-- CreateTable
CREATE TABLE "spending_settings" (
    "tenant_id" UUID NOT NULL,
    "budget_alert_percent" INTEGER NOT NULL,
    "unusual_spend_multiplier" DECIMAL(7,2) NOT NULL,
    "unusual_spend_min_samples" INTEGER NOT NULL,
    "duplicate_window_days" INTEGER NOT NULL,
    "forecast_weeks" INTEGER NOT NULL,
    "opening_cash_minor" BIGINT,
    "opening_cash_on" DATE,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spending_settings_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "cost_codes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "category" VARCHAR(20) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budgets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "notes" VARCHAR(1000),
    "status" VARCHAR(12) NOT NULL DEFAULT 'draft',
    "bq_version_id" UUID,
    "total_minor" BIGINT NOT NULL DEFAULT 0,
    "line_count" INTEGER NOT NULL DEFAULT 0,
    "digest" CHAR(64),
    "contributors" UUID[] DEFAULT ARRAY[]::UUID[],
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_by" UUID,
    "submitted_at" TIMESTAMPTZ,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ,
    "return_reason" VARCHAR(500),
    "cancelled_by" UUID,
    "cancelled_at" TIMESTAMPTZ,
    "cancel_reason" VARCHAR(500),

    CONSTRAINT "budgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_lines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "budget_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "bq_version_id" UUID,
    "bq_item_lineage_id" UUID,
    "cost_code_id" UUID,
    "category" VARCHAR(20),
    "description" VARCHAR(300) NOT NULL,
    "amount_minor" BIGINT NOT NULL,

    CONSTRAINT "budget_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_journals" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "number" VARCHAR(20) NOT NULL,
    "kind" VARCHAR(12) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'submitted',
    "line_count" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ,
    "decision_reason" VARCHAR(500),

    CONSTRAINT "cost_journals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_journal_lines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "journal_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "measure" VARCHAR(8) NOT NULL,
    "category" VARCHAR(20) NOT NULL,
    "cost_code_id" UUID,
    "bq_version_id" UUID,
    "bq_item_lineage_id" UUID,
    "site_id" UUID,
    "counterparty_kind" VARCHAR(10) NOT NULL,
    "supplier_id" UUID,
    "counterparty_name" VARCHAR(200),
    "payment_reference" VARCHAR(60),
    "occurred_on" DATE NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "reverses_entry_id" UUID,

    CONSTRAINT "cost_journal_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_entries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "site_id" UUID,
    "measure" VARCHAR(8) NOT NULL,
    "category" VARCHAR(20) NOT NULL,
    "cost_code_id" UUID,
    "bq_version_id" UUID,
    "bq_item_lineage_id" UUID,
    "counterparty_kind" VARCHAR(10) NOT NULL,
    "supplier_id" UUID,
    "counterparty_name" VARCHAR(200),
    "payment_reference" VARCHAR(60),
    "amount_minor" BIGINT NOT NULL,
    "occurred_on" DATE NOT NULL,
    "source" VARCHAR(20) NOT NULL,
    "purpose" VARCHAR(20) NOT NULL,
    "invoice_id" UUID,
    "settlement_id" UUID,
    "expense_id" UUID,
    "float_count_id" UUID,
    "journal_id" UUID,
    "journal_line_id" UUID,
    "reverses_entry_id" UUID,
    "recorded_by" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "business_date" DATE NOT NULL,

    CONSTRAINT "cost_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "petty_cash_floats" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "custodian_user_id" UUID NOT NULL,
    "limit_minor" BIGINT NOT NULL,
    "balance_minor" BIGINT NOT NULL DEFAULT 0,
    "last_seq" BIGINT NOT NULL DEFAULT 0,
    "last_entry_at" TIMESTAMPTZ,
    "status" VARCHAR(10) NOT NULL DEFAULT 'active',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "petty_cash_floats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "petty_cash_entries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "float_id" UUID NOT NULL,
    "seq" BIGINT NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "balance_minor" BIGINT NOT NULL,
    "top_up_id" UUID,
    "expense_id" UUID,
    "count_id" UUID,
    "recorded_by" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "business_date" DATE NOT NULL,

    CONSTRAINT "petty_cash_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "petty_cash_top_ups" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "float_id" UUID NOT NULL,
    "number" VARCHAR(20) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'requested',
    "requested_by" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ,
    "decision_reason" VARCHAR(500),
    "paid_by" UUID,
    "paid_at" TIMESTAMPTZ,
    "paid_on" DATE,
    "method" VARCHAR(15),
    "reference" VARCHAR(60),
    "reference_key" VARCHAR(60),
    "cancelled_by" UUID,
    "cancelled_at" TIMESTAMPTZ,
    "cancel_reason" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "petty_cash_top_ups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "petty_cash_expenses" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "float_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "number" VARCHAR(20) NOT NULL,
    "spent_on" DATE NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "charge_minor" BIGINT NOT NULL DEFAULT 0,
    "category" VARCHAR(20) NOT NULL,
    "cost_code_id" UUID,
    "bq_version_id" UUID,
    "bq_item_lineage_id" UUID,
    "counterparty_kind" VARCHAR(10) NOT NULL,
    "supplier_id" UUID,
    "payee_name" VARCHAR(200) NOT NULL,
    "payee_account" VARCHAR(40),
    "payee_phone_masked" VARCHAR(16),
    "payment_method" VARCHAR(10) NOT NULL,
    "mpesa_code" CHAR(10),
    "parsed_from_sms" BOOLEAN NOT NULL DEFAULT false,
    "sms_kind" VARCHAR(10),
    "description" VARCHAR(500) NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'submitted',
    "idempotency_key" VARCHAR(100) NOT NULL,
    "request_digest" CHAR(64) NOT NULL,
    "captured_at" TIMESTAMPTZ NOT NULL,
    "source" VARCHAR(10) NOT NULL,
    "recorded_by" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ,
    "decision_reason" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "petty_cash_expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "petty_cash_receipts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "expense_id" UUID NOT NULL,
    "object_key" VARCHAR(300) NOT NULL,
    "content_type" VARCHAR(40) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "scan_status" VARCHAR(15) NOT NULL,
    "scan_engine" VARCHAR(40) NOT NULL,
    "scanned_at" TIMESTAMPTZ NOT NULL,
    "uploaded_by" UUID NOT NULL,
    "uploaded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "petty_cash_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "petty_cash_counts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "float_id" UUID NOT NULL,
    "number" VARCHAR(20) NOT NULL,
    "counted_minor" BIGINT NOT NULL,
    "book_minor" BIGINT NOT NULL,
    "book_seq" BIGINT NOT NULL,
    "variance_minor" BIGINT NOT NULL,
    "note" VARCHAR(500),
    "status" VARCHAR(10) NOT NULL DEFAULT 'submitted',
    "counted_by" UUID NOT NULL,
    "counted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ,
    "decision_reason" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "petty_cash_counts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_flow_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "direction" VARCHAR(3) NOT NULL,
    "description" VARCHAR(200) NOT NULL,
    "expected_on" DATE NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'expected',
    "received_on" DATE,
    "received_minor" BIGINT,
    "reference" VARCHAR(60),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_flow_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cost_codes_tenant_id_active_code_idx" ON "cost_codes"("tenant_id", "active", "code");

-- CreateIndex
CREATE UNIQUE INDEX "cost_codes_tenant_id_id_key" ON "cost_codes"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "cost_codes_tenant_id_code_key" ON "cost_codes"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "budgets_tenant_id_project_id_status_idx" ON "budgets"("tenant_id", "project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "budgets_tenant_id_id_key" ON "budgets"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "budgets_tenant_id_project_id_id_key" ON "budgets"("tenant_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "budgets_tenant_id_project_id_version_no_key" ON "budgets"("tenant_id", "project_id", "version_no");

-- CreateIndex
CREATE UNIQUE INDEX "budget_lines_tenant_id_id_key" ON "budget_lines"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "budget_lines_tenant_id_budget_id_line_no_key" ON "budget_lines"("tenant_id", "budget_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "budget_lines_tenant_id_budget_id_bq_item_lineage_id_key" ON "budget_lines"("tenant_id", "budget_id", "bq_item_lineage_id");

-- CreateIndex
CREATE UNIQUE INDEX "budget_lines_tenant_id_budget_id_cost_code_id_key" ON "budget_lines"("tenant_id", "budget_id", "cost_code_id");

-- CreateIndex
CREATE INDEX "cost_journals_tenant_id_project_id_status_idx" ON "cost_journals"("tenant_id", "project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "cost_journals_tenant_id_id_key" ON "cost_journals"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "cost_journals_tenant_id_project_id_id_key" ON "cost_journals"("tenant_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "cost_journals_tenant_id_number_key" ON "cost_journals"("tenant_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "cost_journal_lines_tenant_id_id_key" ON "cost_journal_lines"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "cost_journal_lines_tenant_id_journal_id_id_key" ON "cost_journal_lines"("tenant_id", "journal_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "cost_journal_lines_tenant_id_journal_id_line_no_key" ON "cost_journal_lines"("tenant_id", "journal_id", "line_no");

-- CreateIndex
CREATE INDEX "cost_entries_tenant_id_project_id_recorded_at_idx" ON "cost_entries"("tenant_id", "project_id", "recorded_at");

-- CreateIndex
CREATE INDEX "cost_entries_tenant_id_project_id_bq_item_lineage_id_idx" ON "cost_entries"("tenant_id", "project_id", "bq_item_lineage_id");

-- CreateIndex
CREATE INDEX "cost_entries_tenant_id_invoice_id_idx" ON "cost_entries"("tenant_id", "invoice_id");

-- CreateIndex
CREATE INDEX "cost_entries_tenant_id_expense_id_idx" ON "cost_entries"("tenant_id", "expense_id");

-- CreateIndex
CREATE INDEX "cost_entries_tenant_id_cost_code_id_idx" ON "cost_entries"("tenant_id", "cost_code_id");

-- CreateIndex
CREATE UNIQUE INDEX "cost_entries_tenant_id_id_key" ON "cost_entries"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "cost_entries_tenant_id_reverses_entry_id_key" ON "cost_entries"("tenant_id", "reverses_entry_id");

-- CreateIndex
CREATE INDEX "petty_cash_floats_tenant_id_project_id_idx" ON "petty_cash_floats"("tenant_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "petty_cash_floats_tenant_id_id_key" ON "petty_cash_floats"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "petty_cash_floats_tenant_id_project_id_id_key" ON "petty_cash_floats"("tenant_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "petty_cash_floats_tenant_id_site_id_key" ON "petty_cash_floats"("tenant_id", "site_id");

-- CreateIndex
CREATE INDEX "petty_cash_entries_tenant_id_float_id_recorded_at_idx" ON "petty_cash_entries"("tenant_id", "float_id", "recorded_at");

-- CreateIndex
CREATE UNIQUE INDEX "petty_cash_entries_tenant_id_id_key" ON "petty_cash_entries"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "petty_cash_entries_tenant_id_float_id_seq_key" ON "petty_cash_entries"("tenant_id", "float_id", "seq");

-- CreateIndex
CREATE INDEX "petty_cash_top_ups_tenant_id_float_id_status_idx" ON "petty_cash_top_ups"("tenant_id", "float_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "petty_cash_top_ups_tenant_id_id_key" ON "petty_cash_top_ups"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "petty_cash_top_ups_tenant_id_float_id_id_key" ON "petty_cash_top_ups"("tenant_id", "float_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "petty_cash_top_ups_tenant_id_number_key" ON "petty_cash_top_ups"("tenant_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "petty_cash_top_ups_tenant_id_method_reference_key_key" ON "petty_cash_top_ups"("tenant_id", "method", "reference_key");

-- CreateIndex
CREATE INDEX "petty_cash_expenses_tenant_id_float_id_recorded_at_idx" ON "petty_cash_expenses"("tenant_id", "float_id", "recorded_at");

-- CreateIndex
CREATE UNIQUE INDEX "petty_cash_expenses_tenant_id_id_key" ON "petty_cash_expenses"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "petty_cash_expenses_tenant_id_project_id_id_key" ON "petty_cash_expenses"("tenant_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "petty_cash_expenses_tenant_id_float_id_id_key" ON "petty_cash_expenses"("tenant_id", "float_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "petty_cash_expenses_tenant_id_number_key" ON "petty_cash_expenses"("tenant_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "petty_cash_expenses_tenant_id_idempotency_key_key" ON "petty_cash_expenses"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "petty_cash_receipts_tenant_id_expense_id_idx" ON "petty_cash_receipts"("tenant_id", "expense_id");

-- CreateIndex
CREATE UNIQUE INDEX "petty_cash_receipts_tenant_id_id_key" ON "petty_cash_receipts"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "petty_cash_receipts_tenant_id_object_key_key" ON "petty_cash_receipts"("tenant_id", "object_key");

-- CreateIndex
CREATE UNIQUE INDEX "petty_cash_counts_tenant_id_id_key" ON "petty_cash_counts"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "petty_cash_counts_tenant_id_project_id_id_key" ON "petty_cash_counts"("tenant_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "petty_cash_counts_tenant_id_float_id_id_key" ON "petty_cash_counts"("tenant_id", "float_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "petty_cash_counts_tenant_id_number_key" ON "petty_cash_counts"("tenant_id", "number");

-- CreateIndex
CREATE INDEX "cash_flow_items_tenant_id_project_id_status_expected_on_idx" ON "cash_flow_items"("tenant_id", "project_id", "status", "expected_on");

-- CreateIndex
CREATE UNIQUE INDEX "cash_flow_items_tenant_id_id_key" ON "cash_flow_items"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_settlements_tenant_id_invoice_id_id_key" ON "invoice_settlements"("tenant_id", "invoice_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_invoices_tenant_id_project_id_id_key" ON "supplier_invoices"("tenant_id", "project_id", "id");

-- AddForeignKey
ALTER TABLE "spending_settings" ADD CONSTRAINT "spending_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_codes" ADD CONSTRAINT "cost_codes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_tenant_id_bq_version_id_fkey" FOREIGN KEY ("tenant_id", "bq_version_id") REFERENCES "bq_versions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_tenant_id_budget_id_fkey" FOREIGN KEY ("tenant_id", "budget_id") REFERENCES "budgets"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_tenant_id_bq_version_id_bq_item_lineage_id_fkey" FOREIGN KEY ("tenant_id", "bq_version_id", "bq_item_lineage_id") REFERENCES "bq_items"("tenant_id", "version_id", "lineage_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_tenant_id_cost_code_id_fkey" FOREIGN KEY ("tenant_id", "cost_code_id") REFERENCES "cost_codes"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_journals" ADD CONSTRAINT "cost_journals_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_journal_lines" ADD CONSTRAINT "cost_journal_lines_tenant_id_project_id_journal_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "journal_id") REFERENCES "cost_journals"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_journal_lines" ADD CONSTRAINT "cost_journal_lines_tenant_id_cost_code_id_fkey" FOREIGN KEY ("tenant_id", "cost_code_id") REFERENCES "cost_codes"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_journal_lines" ADD CONSTRAINT "cost_journal_lines_tenant_id_bq_version_id_bq_item_lineage_fkey" FOREIGN KEY ("tenant_id", "bq_version_id", "bq_item_lineage_id") REFERENCES "bq_items"("tenant_id", "version_id", "lineage_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_journal_lines" ADD CONSTRAINT "cost_journal_lines_tenant_id_project_id_site_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "site_id") REFERENCES "sites"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_journal_lines" ADD CONSTRAINT "cost_journal_lines_tenant_id_supplier_id_fkey" FOREIGN KEY ("tenant_id", "supplier_id") REFERENCES "suppliers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_journal_lines" ADD CONSTRAINT "cost_journal_lines_tenant_id_reverses_entry_id_fkey" FOREIGN KEY ("tenant_id", "reverses_entry_id") REFERENCES "cost_entries"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_tenant_id_project_id_site_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "site_id") REFERENCES "sites"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_tenant_id_cost_code_id_fkey" FOREIGN KEY ("tenant_id", "cost_code_id") REFERENCES "cost_codes"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_tenant_id_bq_version_id_bq_item_lineage_id_fkey" FOREIGN KEY ("tenant_id", "bq_version_id", "bq_item_lineage_id") REFERENCES "bq_items"("tenant_id", "version_id", "lineage_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_tenant_id_supplier_id_fkey" FOREIGN KEY ("tenant_id", "supplier_id") REFERENCES "suppliers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_tenant_id_project_id_invoice_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "invoice_id") REFERENCES "supplier_invoices"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_tenant_id_invoice_id_settlement_id_fkey" FOREIGN KEY ("tenant_id", "invoice_id", "settlement_id") REFERENCES "invoice_settlements"("tenant_id", "invoice_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_tenant_id_project_id_expense_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "expense_id") REFERENCES "petty_cash_expenses"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_tenant_id_project_id_float_count_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "float_count_id") REFERENCES "petty_cash_counts"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_tenant_id_project_id_journal_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "journal_id") REFERENCES "cost_journals"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_tenant_id_journal_id_journal_line_id_fkey" FOREIGN KEY ("tenant_id", "journal_id", "journal_line_id") REFERENCES "cost_journal_lines"("tenant_id", "journal_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_tenant_id_reverses_entry_id_fkey" FOREIGN KEY ("tenant_id", "reverses_entry_id") REFERENCES "cost_entries"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "petty_cash_floats" ADD CONSTRAINT "petty_cash_floats_tenant_id_project_id_site_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "site_id") REFERENCES "sites"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "petty_cash_entries" ADD CONSTRAINT "petty_cash_entries_tenant_id_float_id_fkey" FOREIGN KEY ("tenant_id", "float_id") REFERENCES "petty_cash_floats"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "petty_cash_entries" ADD CONSTRAINT "petty_cash_entries_tenant_id_float_id_top_up_id_fkey" FOREIGN KEY ("tenant_id", "float_id", "top_up_id") REFERENCES "petty_cash_top_ups"("tenant_id", "float_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "petty_cash_entries" ADD CONSTRAINT "petty_cash_entries_tenant_id_float_id_expense_id_fkey" FOREIGN KEY ("tenant_id", "float_id", "expense_id") REFERENCES "petty_cash_expenses"("tenant_id", "float_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "petty_cash_entries" ADD CONSTRAINT "petty_cash_entries_tenant_id_float_id_count_id_fkey" FOREIGN KEY ("tenant_id", "float_id", "count_id") REFERENCES "petty_cash_counts"("tenant_id", "float_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "petty_cash_top_ups" ADD CONSTRAINT "petty_cash_top_ups_tenant_id_project_id_float_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "float_id") REFERENCES "petty_cash_floats"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "petty_cash_expenses" ADD CONSTRAINT "petty_cash_expenses_tenant_id_project_id_float_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "float_id") REFERENCES "petty_cash_floats"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "petty_cash_expenses" ADD CONSTRAINT "petty_cash_expenses_tenant_id_project_id_site_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "site_id") REFERENCES "sites"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "petty_cash_expenses" ADD CONSTRAINT "petty_cash_expenses_tenant_id_cost_code_id_fkey" FOREIGN KEY ("tenant_id", "cost_code_id") REFERENCES "cost_codes"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "petty_cash_expenses" ADD CONSTRAINT "petty_cash_expenses_tenant_id_bq_version_id_bq_item_lineag_fkey" FOREIGN KEY ("tenant_id", "bq_version_id", "bq_item_lineage_id") REFERENCES "bq_items"("tenant_id", "version_id", "lineage_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "petty_cash_expenses" ADD CONSTRAINT "petty_cash_expenses_tenant_id_supplier_id_fkey" FOREIGN KEY ("tenant_id", "supplier_id") REFERENCES "suppliers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "petty_cash_receipts" ADD CONSTRAINT "petty_cash_receipts_tenant_id_project_id_expense_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "expense_id") REFERENCES "petty_cash_expenses"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "petty_cash_counts" ADD CONSTRAINT "petty_cash_counts_tenant_id_project_id_float_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "float_id") REFERENCES "petty_cash_floats"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_flow_items" ADD CONSTRAINT "cash_flow_items_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Permissions (packages/types PERMISSIONS, PROJECT_ASSIGNABLE_PERMISSIONS): finance.petty_cash ---
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
    'advances.approve', 'payments.view', 'payments.approve', 'payments.disburse',
    'payments.record_cash', 'payments.reverse', 'procurement.requisition',
    'procurement.approve', 'procurement.manage_suppliers', 'stores.manage', 'finance.view',
    'finance.manage', 'finance.view_sensitive', 'finance.petty_cash', 'site.diary', 'site.photos',
    'quality.manage', 'safety.manage', 'plant.manage', 'documents.manage', 'reports.view',
    'portal.client', 'portal.supplier', 'portal.worker'
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
    'procurement.requisition', 'procurement.approve', 'stores.manage', 'finance.view',
    'finance.petty_cash', 'site.diary', 'site.photos', 'quality.manage', 'safety.manage',
    'plant.manage', 'documents.manage', 'reports.view', 'portal.client', 'portal.worker'
  ]::text[]
);

-- Settings and cost codes (CONFIGURATION "Spending") ---------------------------------------------
ALTER TABLE "spending_settings" ADD CONSTRAINT "spending_settings_check" CHECK (
  budget_alert_percent BETWEEN 1 AND 100
  AND unusual_spend_multiplier BETWEEN 1 AND 100
  AND unusual_spend_min_samples BETWEEN 3 AND 20
  AND duplicate_window_days BETWEEN 0 AND 30
  AND forecast_weeks BETWEEN 4 AND 26
  AND (opening_cash_minor IS NULL) = (opening_cash_on IS NULL)
  AND (opening_cash_on IS NULL OR opening_cash_on BETWEEN DATE '2000-01-01' AND DATE '2099-12-31')
  AND version >= 1
);

ALTER TABLE "cost_codes" ADD CONSTRAINT "cost_codes_check" CHECK (
  code ~ '^[A-Z0-9][A-Z0-9-]{1,19}$' AND char_length(btrim(name)) >= 2 AND name = btrim(name)
  AND category IN ('materials', 'labour', 'plant', 'subcontract', 'preliminaries', 'fees',
                   'permits', 'transport', 'petty_cash')
  AND version >= 1
);

CREATE FUNCTION app.guard_cost_code() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.code IS DISTINCT FROM OLD.code OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'A cost code keeps its code' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER cost_code_guard BEFORE UPDATE ON "cost_codes"
  FOR EACH ROW EXECUTE FUNCTION app.guard_cost_code();

-- Budgets -----------------------------------------------------------------------------------------
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_state_check" CHECK (
  version_no >= 1 AND version >= 1 AND total_minor >= 0 AND line_count BETWEEN 0 AND 5000
  AND char_length(btrim(name)) >= 2
  AND created_by = ANY (contributors)
  AND (digest IS NULL OR digest ~ '^[0-9a-f]{64}$')
  AND COALESCE(CASE status
    WHEN 'draft' THEN submitted_at IS NULL AND approved_by IS NULL AND cancelled_at IS NULL
      AND digest IS NULL
    WHEN 'submitted' THEN submitted_by IS NOT NULL AND submitted_at IS NOT NULL
      AND digest IS NOT NULL AND approved_by IS NULL AND cancelled_at IS NULL
    WHEN 'approved' THEN submitted_by IS NOT NULL AND approved_by IS NOT NULL
      AND approved_at IS NOT NULL AND digest IS NOT NULL AND cancelled_at IS NULL
    WHEN 'cancelled' THEN cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL
      AND char_length(btrim(cancel_reason)) >= 3 AND approved_by IS NULL
    ELSE false
  END, false)
  AND (approved_by IS NULL) = (approved_at IS NULL)
  AND (approved_by IS NULL OR NOT (approved_by = ANY (contributors)))
  AND (return_reason IS NULL OR char_length(btrim(return_reason)) >= 3)
);
-- One version in preparation per project.
CREATE UNIQUE INDEX "budgets_one_open_per_project" ON "budgets"("tenant_id", "project_id")
  WHERE status IN ('draft', 'submitted');

-- packages/domain BUDGET_TRANSITIONS. A budget starts as an empty draft numbered after the last
-- version; approved and cancelled versions never change; the approver is the signed-in user and
-- never a contributor (everyone who created, edited, submitted or changed a line: only grows).
CREATE FUNCTION app.guard_budget() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bq_ok boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.created_by IS DISTINCT FROM app.current_user_id()
       OR NEW.total_minor <> 0 OR NEW.line_count <> 0 THEN
      RAISE EXCEPTION 'A budget starts as an empty draft by the signed-in user' USING ERRCODE = '23514';
    END IF;
    IF NEW.version_no <> COALESCE((SELECT max(version_no) FROM budgets
         WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id), 0) + 1 THEN
      RAISE EXCEPTION 'Budget versions are numbered one after another' USING ERRCODE = '23514';
    END IF;
    IF NEW.bq_version_id IS NOT NULL THEN
      SELECT v.status = 'approved' AND v.project_id = NEW.project_id INTO bq_ok FROM bq_versions v
       WHERE v.tenant_id = NEW.tenant_id AND v.id = NEW.bq_version_id;
      IF NOT COALESCE(bq_ok, false) THEN
        RAISE EXCEPTION 'A budget follows an approved BQ version of its project' USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSE
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.project_id IS DISTINCT FROM OLD.project_id
       OR NEW.version_no IS DISTINCT FROM OLD.version_no
       OR NEW.bq_version_id IS DISTINCT FROM OLD.bq_version_id
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'A budget keeps its project, version and BQ version' USING ERRCODE = '23514';
    END IF;
    IF OLD.status IN ('approved', 'cancelled') THEN
      RAISE EXCEPTION 'A % budget never changes', OLD.status USING ERRCODE = '23514';
    END IF;
    IF NOT (NEW.contributors @> OLD.contributors) THEN
      RAISE EXCEPTION 'A budget''s contributors are only ever added' USING ERRCODE = '23514';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND (OLD.status, NEW.status) NOT IN (
      ('draft', 'submitted'), ('submitted', 'approved'), ('submitted', 'draft'),
      ('draft', 'cancelled'), ('submitted', 'cancelled')
    ) THEN
      RAISE EXCEPTION 'Budget status cannot change from % to %', OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'submitted' AND NEW.status = 'submitted' THEN
      RAISE EXCEPTION 'A submitted budget is approved, returned or cancelled' USING ERRCODE = '23514';
    END IF;
    IF OLD.status <> 'draft' AND (NEW.total_minor <> OLD.total_minor
       OR NEW.line_count <> OLD.line_count OR NEW.name IS DISTINCT FROM OLD.name
       OR NEW.notes IS DISTINCT FROM OLD.notes) THEN
      RAISE EXCEPTION 'Only a draft budget changes' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'approved' AND NEW.approved_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'A budget is approved by the signed-in user' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'cancelled' AND NEW.cancelled_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'A budget is cancelled by the signed-in user' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.status IN ('draft', 'submitted') AND (TG_OP = 'INSERT'
     OR NOT (OLD.status = 'submitted' AND NEW.status = 'draft')) THEN
    NEW.contributors := app.add_contributors(
      NEW.contributors, NEW.created_by, NEW.updated_by, NEW.submitted_by, app.current_user_id()
    );
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER budget_guard BEFORE INSERT OR UPDATE ON "budgets"
  FOR EACH ROW EXECUTE FUNCTION app.guard_budget();

ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_check" CHECK (
  line_no >= 1 AND amount_minor >= 0
  AND num_nonnulls(bq_item_lineage_id, cost_code_id) = 1
  AND (bq_version_id IS NULL) = (bq_item_lineage_id IS NULL)
  AND (category IS NULL OR category IN ('materials', 'labour', 'plant', 'subcontract',
       'preliminaries', 'fees', 'permits', 'transport', 'petty_cash'))
  AND (cost_code_id IS NULL OR category IS NOT NULL)
  AND char_length(btrim(description)) >= 1
);

-- Lines change only while their budget is a draft. An item line names an item of the budget's BQ
-- version; a cost-code line takes its code's category. Only the amount, description and category
-- of a line change; whoever changes a line becomes a contributor.
CREATE FUNCTION app.guard_budget_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  b record;
BEGIN
  SELECT status, bq_version_id INTO b FROM budgets
   WHERE tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id)
     AND id = COALESCE(NEW.budget_id, OLD.budget_id) FOR UPDATE;
  IF b.status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Budget lines change only while the budget is a draft' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND ((to_jsonb(NEW) - 'amount_minor' - 'description' - 'category')
       IS DISTINCT FROM (to_jsonb(OLD) - 'amount_minor' - 'description' - 'category')) THEN
    RAISE EXCEPTION 'A budget line keeps its item or cost code' USING ERRCODE = '23514';
  END IF;
  IF NEW.bq_version_id IS NOT NULL AND NEW.bq_version_id IS DISTINCT FROM b.bq_version_id THEN
    RAISE EXCEPTION 'A budget line names an item of the budget''s BQ version' USING ERRCODE = '23514';
  END IF;
  IF NEW.cost_code_id IS NOT NULL AND NEW.category IS DISTINCT FROM (
    SELECT category FROM cost_codes WHERE tenant_id = NEW.tenant_id AND id = NEW.cost_code_id
  ) THEN
    RAISE EXCEPTION 'A cost-code line takes its code''s category' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER budget_line_guard BEFORE INSERT OR UPDATE OR DELETE ON "budget_lines"
  FOR EACH ROW EXECUTE FUNCTION app.guard_budget_line();

-- After each statement on the lines, the budget's total and line count follow its lines and the
-- signed-in user becomes a contributor (statement triggers: one update per budget, even for a
-- budget of thousands of lines created at once).
CREATE FUNCTION app.sum_budget_lines() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE budgets b
     SET total_minor = COALESCE((SELECT sum(l.amount_minor) FROM budget_lines l
                                  WHERE l.tenant_id = b.tenant_id AND l.budget_id = b.id), 0),
         line_count = (SELECT count(*) FROM budget_lines l
                        WHERE l.tenant_id = b.tenant_id AND l.budget_id = b.id),
         contributors = app.add_contributors(b.contributors, app.current_user_id())
   WHERE (b.tenant_id, b.id) IN (SELECT tenant_id, budget_id FROM changed_lines);
  RETURN NULL;
END
$$;
CREATE TRIGGER budget_lines_inserted AFTER INSERT ON "budget_lines"
  REFERENCING NEW TABLE AS changed_lines FOR EACH STATEMENT EXECUTE FUNCTION app.sum_budget_lines();
CREATE TRIGGER budget_lines_updated AFTER UPDATE ON "budget_lines"
  REFERENCING NEW TABLE AS changed_lines FOR EACH STATEMENT EXECUTE FUNCTION app.sum_budget_lines();
CREATE TRIGGER budget_lines_deleted AFTER DELETE ON "budget_lines"
  REFERENCING OLD TABLE AS changed_lines FOR EACH STATEMENT EXECUTE FUNCTION app.sum_budget_lines();

-- At commit: a budget's total and line count are those of its lines.
CREATE FUNCTION app.check_budget_totals() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target record;
  total numeric;
  lines int;
BEGIN
  SELECT * INTO target FROM budgets WHERE tenant_id = NEW.tenant_id AND id = NEW.id;
  SELECT COALESCE(sum(amount_minor), 0), count(*)::int INTO total, lines FROM budget_lines
   WHERE tenant_id = target.tenant_id AND budget_id = target.id;
  IF target.total_minor <> total OR target.line_count <> lines THEN
    RAISE EXCEPTION 'A budget''s total is the sum of its lines' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER budget_totals AFTER INSERT OR UPDATE ON "budgets"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_budget_totals();

-- Cost journals -----------------------------------------------------------------------------------
ALTER TABLE "cost_journals" ADD CONSTRAINT "cost_journals_check" CHECK (
  number ~ '^JNL-[0-9]{4,12}$' AND kind IN ('adjustment', 'reversal')
  AND char_length(btrim(reason)) >= 3 AND line_count BETWEEN 1 AND 50
  AND (kind <> 'reversal' OR line_count = 1) AND version >= 1
  AND COALESCE(CASE status
    WHEN 'submitted' THEN decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL
    WHEN 'approved' THEN decided_by IS NOT NULL AND decided_at IS NOT NULL
    WHEN 'rejected' THEN decided_by IS NOT NULL AND decided_at IS NOT NULL
      AND char_length(btrim(decision_reason)) >= 3
    ELSE false
  END, false)
  AND (decided_by IS NULL OR decided_by <> created_by)
);

-- A journal is proposed by the signed-in user; afterwards only its decision is recorded, once, by
-- the signed-in user, who is never its author.
CREATE FUNCTION app.guard_cost_journal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'submitted' OR NEW.created_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'A journal is proposed by the signed-in user' USING ERRCODE = '23514';
    END IF;
    -- Database-stamped, so its lines can be tied to this transaction (app.guard_cost_journal_line).
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'decided_by' - 'decided_at' - 'decision_reason' - 'version')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'status' - 'decided_by' - 'decided_at' - 'decision_reason' - 'version')
     OR OLD.status <> 'submitted' OR NEW.status NOT IN ('approved', 'rejected')
     OR NEW.decided_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A journal is only decided, once, by the signed-in user' USING ERRCODE = '23514';
  END IF;
  IF NEW.decided_by = OLD.created_by THEN
    RAISE EXCEPTION 'A journal is decided by someone other than its author' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER cost_journal_guard BEFORE INSERT OR UPDATE ON "cost_journals"
  FOR EACH ROW EXECUTE FUNCTION app.guard_cost_journal();

ALTER TABLE "cost_journal_lines" ADD CONSTRAINT "cost_journal_lines_check" CHECK (
  line_no BETWEEN 1 AND 50 AND measure IN ('accrued', 'paid') AND amount_minor <> 0
  AND category IN ('materials', 'labour', 'plant', 'subcontract', 'preliminaries', 'fees',
                   'permits', 'transport', 'petty_cash')
  AND counterparty_kind IN ('supplier', 'worker', 'other', 'none')
  AND (counterparty_kind = 'supplier') = (supplier_id IS NOT NULL)
  AND (counterparty_kind <> 'none' OR counterparty_name IS NULL)
  AND (bq_version_id IS NULL) = (bq_item_lineage_id IS NULL)
  AND (reverses_entry_id IS NOT NULL OR num_nonnulls(bq_item_lineage_id, cost_code_id) >= 1)
  AND occurred_on BETWEEN DATE '2000-01-01' AND DATE '2099-12-31'
);

-- Lines are written with their journal, in its own transaction, and never change.
CREATE FUNCTION app.guard_cost_journal_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  j record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Journal lines never change' USING ERRCODE = '23514';
  END IF;
  SELECT status, kind, created_at INTO j FROM cost_journals
   WHERE tenant_id = NEW.tenant_id AND id = NEW.journal_id;
  IF j.status IS DISTINCT FROM 'submitted' OR j.created_at <> now() THEN
    RAISE EXCEPTION 'Journal lines are written with their journal' USING ERRCODE = '23514';
  END IF;
  IF (j.kind = 'reversal') <> (NEW.reverses_entry_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Only a reversal journal names an entry to reverse' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER cost_journal_line_guard BEFORE INSERT OR UPDATE OR DELETE ON "cost_journal_lines"
  FOR EACH ROW EXECUTE FUNCTION app.guard_cost_journal_line();

-- At commit: the line count matches, and an approved journal has posted each line exactly once.
CREATE FUNCTION app.check_cost_journal_postings() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target record;
BEGIN
  SELECT * INTO target FROM cost_journals WHERE tenant_id = NEW.tenant_id AND id = NEW.id;
  IF target.line_count IS DISTINCT FROM (SELECT count(*)::int FROM cost_journal_lines
       WHERE tenant_id = target.tenant_id AND journal_id = target.id)
     OR (target.status = 'approved' AND EXISTS (
       SELECT 1 FROM cost_journal_lines l WHERE l.tenant_id = target.tenant_id
          AND l.journal_id = target.id
          AND (SELECT count(*) FROM cost_entries e WHERE e.tenant_id = l.tenant_id
                 AND e.journal_line_id = l.id) <> 1
     ))
     OR (target.status <> 'approved' AND EXISTS (
       SELECT 1 FROM cost_entries e WHERE e.tenant_id = target.tenant_id
          AND e.journal_id = target.id
     )) THEN
    RAISE EXCEPTION 'An approved journal posts each of its lines once' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER cost_journal_postings AFTER INSERT OR UPDATE ON "cost_journals"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_cost_journal_postings();

-- The cost ledger ---------------------------------------------------------------------------------
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_check" CHECK (
  measure IN ('accrued', 'paid') AND amount_minor <> 0
  AND category IN ('materials', 'labour', 'plant', 'subcontract', 'preliminaries', 'fees',
                   'permits', 'transport', 'petty_cash')
  AND counterparty_kind IN ('supplier', 'worker', 'other', 'none')
  AND (counterparty_kind = 'supplier') = (supplier_id IS NOT NULL)
  AND (counterparty_kind <> 'none' OR counterparty_name IS NULL)
  AND (bq_version_id IS NULL) = (bq_item_lineage_id IS NULL)
  AND (reverses_entry_id IS NOT NULL) = (purpose = 'reversal')
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
    ELSE false
  END, false)
);
-- Each source posts once per purpose (its reversal aside).
CREATE UNIQUE INDEX "cost_entries_invoice_once" ON "cost_entries" ("tenant_id", "invoice_id")
  WHERE source = 'supplier_invoice';
CREATE UNIQUE INDEX "cost_entries_settlement_once" ON "cost_entries" ("tenant_id", "settlement_id")
  WHERE settlement_id IS NOT NULL;
CREATE UNIQUE INDEX "cost_entries_expense_once" ON "cost_entries" ("tenant_id", "expense_id", "purpose")
  WHERE expense_id IS NOT NULL;
CREATE UNIQUE INDEX "cost_entries_count_once" ON "cost_entries" ("tenant_id", "float_count_id", "purpose")
  WHERE float_count_id IS NOT NULL;
CREATE UNIQUE INDEX "cost_entries_journal_line_once" ON "cost_entries" ("tenant_id", "journal_line_id")
  WHERE journal_line_id IS NOT NULL;

-- The cost part of a supplier settlement (packages/domain settlementCostMinor): the settlement's
-- share of the invoice subtotal, cumulative and half up, so the parts of a fully settled invoice
-- add up to exactly its subtotal. Integer arithmetic (div), never a rounded quotient.
CREATE FUNCTION app.settlement_cost_minor(subtotal bigint, total bigint, settled_before bigint,
                                          amount bigint)
  RETURNS bigint LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN total <= 0 THEN 0 ELSE
    (div(2::numeric * (settled_before + amount) * subtotal + total, 2::numeric * total)
     - div(2::numeric * settled_before * subtotal + total, 2::numeric * total))::bigint END
$$;

-- Before every entry: recorded by the signed-in user, stamped with the server time and business
-- date, and checked against its source (amount, measure, category, tags and counterparty), so an
-- entry can only ever say what its approved source says. A reversal mirrors the entry it
-- reverses with the opposite sign.
CREATE FUNCTION app.check_cost_entry() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER cost_entry_check BEFORE INSERT ON "cost_entries"
  FOR EACH ROW EXECUTE FUNCTION app.check_cost_entry();

CREATE FUNCTION app.refuse_cost_entry_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'The cost ledger is append-only: post a reversing entry instead'
    USING ERRCODE = '23514';
END
$$;
CREATE TRIGGER cost_entry_append_only BEFORE UPDATE OR DELETE ON "cost_entries"
  FOR EACH ROW EXECUTE FUNCTION app.refuse_cost_entry_change();
CREATE TRIGGER cost_entry_no_truncate BEFORE TRUNCATE ON "cost_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_cost_entry_change();

-- Automatic postings from procure-to-pay (D5.2) -------------------------------------------------
-- An invoice accrues its subtotal once, when it is first approved (a re-approval after a payee
-- change creates a new payable but no new cost). Materials bought on LPOs are stock: the accrual
-- names no BQ item (decision D-53; issues re-allocate the cost to BQ items in the read model).
CREATE FUNCTION app.post_invoice_accrual() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  src record;
BEGIN
  IF NEW.subtotal_minor = 0 OR EXISTS (
    SELECT 1 FROM cost_entries WHERE tenant_id = NEW.tenant_id AND invoice_id = NEW.id
       AND source = 'supplier_invoice'
  ) THEN
    RETURN NULL;
  END IF;
  SELECT l.delivery_site_id, COALESCE(s.trading_name, s.legal_name) AS supplier_name INTO src
    FROM lpos l JOIN suppliers s ON s.tenant_id = l.tenant_id AND s.id = l.supplier_id
   WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.lpo_id;
  INSERT INTO cost_entries (id, tenant_id, project_id, site_id, measure, category,
    counterparty_kind, supplier_id, counterparty_name, payment_reference, amount_minor,
    occurred_on, source, purpose, invoice_id, recorded_by, business_date)
  VALUES (uuidv7(), NEW.tenant_id, NEW.project_id, src.delivery_site_id, 'accrued', 'materials',
    'supplier', NEW.supplier_id, left(src.supplier_name, 200), NEW.invoice_number,
    NEW.subtotal_minor, NEW.invoice_date, 'supplier_invoice', 'accrual', NEW.id,
    app.current_user_id(), app.business_today());
  RETURN NULL;
END
$$;
CREATE TRIGGER supplier_invoice_cost AFTER UPDATE OF status ON "supplier_invoices"
  FOR EACH ROW WHEN (NEW.status = 'approved' AND OLD.status = 'matched')
  EXECUTE FUNCTION app.post_invoice_accrual();

-- Each settlement posts the cost part of the cash it paid (paid measure; never the accrued one).
CREATE FUNCTION app.post_settlement_cost() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  inv record;
  settled_before bigint;
  cost bigint;
BEGIN
  SELECT i.project_id, i.subtotal_minor, i.total_minor, i.supplier_id, l.delivery_site_id,
         COALESCE(s.trading_name, s.legal_name) AS supplier_name
    INTO inv
    FROM supplier_invoices i
    JOIN lpos l ON l.tenant_id = i.tenant_id AND l.id = i.lpo_id
    JOIN suppliers s ON s.tenant_id = i.tenant_id AND s.id = i.supplier_id
   WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.invoice_id;
  SELECT COALESCE(sum(amount_minor), 0) INTO settled_before FROM invoice_settlements
   WHERE tenant_id = NEW.tenant_id AND invoice_id = NEW.invoice_id
     AND (recorded_at, id) < (NEW.recorded_at, NEW.id);
  cost := app.settlement_cost_minor(inv.subtotal_minor, inv.total_minor, settled_before,
                                    NEW.amount_minor);
  IF cost <> 0 THEN
    INSERT INTO cost_entries (id, tenant_id, project_id, site_id, measure, category,
      counterparty_kind, supplier_id, counterparty_name, payment_reference, amount_minor,
      occurred_on, source, purpose, invoice_id, settlement_id, recorded_by, business_date)
    VALUES (uuidv7(), NEW.tenant_id, inv.project_id, inv.delivery_site_id, 'paid', 'materials',
      'supplier', inv.supplier_id, left(inv.supplier_name, 200), NEW.external_reference, cost,
      NEW.paid_on, 'invoice_settlement', 'payment', NEW.invoice_id, NEW.id,
      app.current_user_id(), app.business_today());
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER invoice_settlement_cost AFTER INSERT ON "invoice_settlements"
  FOR EACH ROW EXECUTE FUNCTION app.post_settlement_cost();

-- Petty-cash floats -------------------------------------------------------------------------------
ALTER TABLE "petty_cash_floats" ADD CONSTRAINT "petty_cash_floats_check" CHECK (
  char_length(btrim(name)) >= 2 AND limit_minor > 0 AND balance_minor >= 0 AND last_seq >= 0
  AND status IN ('active', 'closed') AND (status = 'active' OR balance_minor = 0) AND version >= 1
);

-- A float starts empty and keeps its project and site; its custodian is a member of the company;
-- its balance changes only with its next ledger entry (app.apply_float_entry).
CREATE FUNCTION app.guard_petty_cash_float() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.balance_minor <> 0 OR NEW.last_seq <> 0 OR NEW.last_entry_at IS NOT NULL
       OR NEW.status <> 'active' OR NEW.created_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'A float starts empty and active, created by the signed-in user'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.project_id IS DISTINCT FROM OLD.project_id
       OR NEW.site_id IS DISTINCT FROM OLD.site_id OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'A float keeps its project and site' USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'closed' THEN
      RAISE EXCEPTION 'A closed float never changes' USING ERRCODE = '23514';
    END IF;
    IF (NEW.balance_minor, NEW.last_seq, NEW.last_entry_at)
       IS DISTINCT FROM (OLD.balance_minor, OLD.last_seq, OLD.last_entry_at)
       AND (NEW.last_seq <> OLD.last_seq + 1 OR NOT EXISTS (
         SELECT 1 FROM petty_cash_entries e
          WHERE e.tenant_id = NEW.tenant_id AND e.float_id = NEW.id AND e.seq = NEW.last_seq
            AND e.balance_minor = NEW.balance_minor AND e.recorded_at = NEW.last_entry_at
       )) THEN
      RAISE EXCEPTION 'A float''s balance changes only with its next ledger entry'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF (TG_OP = 'INSERT' OR NEW.custodian_user_id IS DISTINCT FROM OLD.custodian_user_id)
     AND NOT EXISTS (SELECT 1 FROM memberships WHERE tenant_id = NEW.tenant_id
                       AND user_id = NEW.custodian_user_id) THEN
    RAISE EXCEPTION 'A custodian is a member of the company' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER petty_cash_float_guard BEFORE INSERT OR UPDATE ON "petty_cash_floats"
  FOR EACH ROW EXECUTE FUNCTION app.guard_petty_cash_float();

ALTER TABLE "petty_cash_entries" ADD CONSTRAINT "petty_cash_entries_check" CHECK (
  seq >= 1 AND amount_minor <> 0 AND balance_minor >= 0
  AND COALESCE(CASE kind
    WHEN 'top_up' THEN top_up_id IS NOT NULL AND expense_id IS NULL AND count_id IS NULL
      AND amount_minor > 0
    WHEN 'expense' THEN expense_id IS NOT NULL AND top_up_id IS NULL AND count_id IS NULL
      AND amount_minor < 0
    WHEN 'expense_rejected' THEN expense_id IS NOT NULL AND top_up_id IS NULL AND count_id IS NULL
      AND amount_minor > 0
    WHEN 'count_adjustment' THEN count_id IS NOT NULL AND top_up_id IS NULL AND expense_id IS NULL
    ELSE false
  END, false)
);
CREATE UNIQUE INDEX "petty_cash_entries_top_up_once" ON "petty_cash_entries" ("tenant_id", "top_up_id")
  WHERE top_up_id IS NOT NULL;
CREATE UNIQUE INDEX "petty_cash_entries_expense_once" ON "petty_cash_entries" ("tenant_id", "expense_id", "kind")
  WHERE expense_id IS NOT NULL;
CREATE UNIQUE INDEX "petty_cash_entries_count_once" ON "petty_cash_entries" ("tenant_id", "count_id")
  WHERE count_id IS NOT NULL;

-- Before every float entry: recorded by the signed-in user; the float row is locked so concurrent
-- spends are serialised; the entry says what its source says; a top-up never takes the float
-- above its limit and NOTHING takes it below zero. The entry gets the next number and the running
-- balance; app.apply_float_entry then moves the float's balance.
CREATE FUNCTION app.post_float_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  f petty_cash_floats%ROWTYPE;
  src record;
BEGIN
  IF NEW.recorded_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A float entry is recorded by the signed-in user' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO f FROM petty_cash_floats WHERE tenant_id = NEW.tenant_id AND id = NEW.float_id
     FOR UPDATE;
  IF NOT FOUND OR f.status <> 'active' THEN
    RAISE EXCEPTION 'Only an active float takes entries' USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'top_up' THEN
    SELECT status, amount_minor INTO src FROM petty_cash_top_ups
     WHERE tenant_id = NEW.tenant_id AND float_id = NEW.float_id AND id = NEW.top_up_id;
    IF NOT FOUND OR src.status <> 'paid' OR NEW.amount_minor <> src.amount_minor THEN
      RAISE EXCEPTION 'A top-up entry posts a paid top-up' USING ERRCODE = '23514';
    END IF;
    IF f.balance_minor + NEW.amount_minor > f.limit_minor THEN
      RAISE EXCEPTION 'A top-up never takes a float above its limit' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.kind IN ('expense', 'expense_rejected') THEN
    SELECT status, amount_minor + charge_minor AS total INTO src FROM petty_cash_expenses
     WHERE tenant_id = NEW.tenant_id AND float_id = NEW.float_id AND id = NEW.expense_id;
    IF NOT FOUND OR (NEW.kind = 'expense' AND (src.status <> 'submitted'
         OR NEW.amount_minor <> -src.total))
       OR (NEW.kind = 'expense_rejected' AND (src.status <> 'rejected'
         OR NEW.amount_minor <> src.total OR NOT EXISTS (
           SELECT 1 FROM petty_cash_entries WHERE tenant_id = NEW.tenant_id
              AND expense_id = NEW.expense_id AND kind = 'expense'))) THEN
      RAISE EXCEPTION 'An expense entry posts its expense' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT status, variance_minor INTO src FROM petty_cash_counts
     WHERE tenant_id = NEW.tenant_id AND float_id = NEW.float_id AND id = NEW.count_id;
    IF NOT FOUND OR src.status <> 'approved' OR NEW.amount_minor <> src.variance_minor THEN
      RAISE EXCEPTION 'A count adjustment posts an approved count''s variance' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF f.balance_minor + NEW.amount_minor < 0 THEN
    RAISE EXCEPTION 'A petty-cash float never goes below zero' USING ERRCODE = '23514';
  END IF;
  NEW.seq := f.last_seq + 1;
  NEW.balance_minor := f.balance_minor + NEW.amount_minor;
  NEW.business_date := app.business_today();
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END
$$;
CREATE TRIGGER petty_cash_entry_post BEFORE INSERT ON "petty_cash_entries"
  FOR EACH ROW EXECUTE FUNCTION app.post_float_entry();

CREATE FUNCTION app.apply_float_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE petty_cash_floats
     SET balance_minor = NEW.balance_minor, last_seq = NEW.seq, last_entry_at = NEW.recorded_at
   WHERE tenant_id = NEW.tenant_id AND id = NEW.float_id;
  RETURN NULL;
END
$$;
CREATE TRIGGER petty_cash_entry_apply AFTER INSERT ON "petty_cash_entries"
  FOR EACH ROW EXECUTE FUNCTION app.apply_float_entry();

CREATE FUNCTION app.refuse_float_entry_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'The float ledger is append-only' USING ERRCODE = '23514';
END
$$;
CREATE TRIGGER petty_cash_entry_append_only BEFORE UPDATE OR DELETE ON "petty_cash_entries"
  FOR EACH ROW EXECUTE FUNCTION app.refuse_float_entry_change();

-- Top-ups -----------------------------------------------------------------------------------------
ALTER TABLE "petty_cash_top_ups" ADD CONSTRAINT "petty_cash_top_ups_check" CHECK (
  number ~ '^TOP-[0-9]{4,12}$' AND amount_minor > 0 AND char_length(btrim(reason)) >= 3
  AND version >= 1
  AND COALESCE(CASE status
    WHEN 'requested' THEN decided_by IS NULL AND paid_by IS NULL AND cancelled_by IS NULL
    WHEN 'approved' THEN decided_by IS NOT NULL AND decided_at IS NOT NULL AND paid_by IS NULL
      AND cancelled_by IS NULL
    WHEN 'paid' THEN decided_by IS NOT NULL AND paid_by IS NOT NULL AND paid_at IS NOT NULL
      AND paid_on IS NOT NULL AND cancelled_by IS NULL
    WHEN 'rejected' THEN decided_by IS NOT NULL AND decided_at IS NOT NULL
      AND char_length(btrim(decision_reason)) >= 3 AND paid_by IS NULL AND cancelled_by IS NULL
    WHEN 'cancelled' THEN cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL
      AND char_length(btrim(cancel_reason)) >= 3 AND paid_by IS NULL
    ELSE false
  END, false)
  AND (paid_by IS NULL) = (method IS NULL)
  AND (paid_by IS NULL) = (reference IS NULL)
  AND (paid_by IS NULL) = (reference_key IS NULL)
  AND (method IS NULL OR method IN ('mpesa', 'bank_transfer', 'cash', 'cheque'))
  AND (reference IS NULL OR char_length(btrim(reference)) >= 3)
  AND (decided_by IS NULL OR decided_by <> requested_by)
  AND (paid_by IS NULL OR paid_by <> decided_by)
);

-- packages/domain TOP_UP_TRANSITIONS. Requested by the signed-in user on an active float; each
-- step by the signed-in user; approved by someone other than the requester, paid by someone
-- other than the approver.
CREATE FUNCTION app.guard_petty_cash_top_up() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'requested' OR NEW.requested_by IS DISTINCT FROM app.current_user_id()
       OR (SELECT status FROM petty_cash_floats WHERE tenant_id = NEW.tenant_id
             AND id = NEW.float_id) IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'A top-up is requested by the signed-in user for an active float'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.float_id IS DISTINCT FROM OLD.float_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.number IS DISTINCT FROM OLD.number
     OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    RAISE EXCEPTION 'A top-up''s request never changes' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('paid', 'rejected', 'cancelled') THEN
    RAISE EXCEPTION 'A % top-up never changes', OLD.status USING ERRCODE = '23514';
  END IF;
  IF (OLD.status, NEW.status) NOT IN (('requested', 'approved'), ('requested', 'rejected'),
       ('approved', 'paid'), ('requested', 'cancelled'), ('approved', 'cancelled')) THEN
    RAISE EXCEPTION 'Top-up status cannot change from % to %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  IF (NEW.status IN ('approved', 'rejected') AND NEW.decided_by IS DISTINCT FROM app.current_user_id())
     OR (NEW.status = 'paid' AND (NEW.paid_by IS DISTINCT FROM app.current_user_id()
         OR NEW.decided_by IS DISTINCT FROM OLD.decided_by))
     OR (NEW.status = 'cancelled' AND NEW.cancelled_by IS DISTINCT FROM app.current_user_id()) THEN
    RAISE EXCEPTION 'A top-up step is taken by the signed-in user' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'paid' AND (NEW.paid_on > app.business_today()
     OR NEW.paid_on < (OLD.requested_at AT TIME ZONE 'Africa/Nairobi')::date) THEN
    RAISE EXCEPTION 'A top-up is paid between its request and today' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER petty_cash_top_up_guard BEFORE INSERT OR UPDATE ON "petty_cash_top_ups"
  FOR EACH ROW EXECUTE FUNCTION app.guard_petty_cash_top_up();

-- At commit: a paid top-up has raised its float's balance exactly once.
CREATE FUNCTION app.check_top_up_posting() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT status FROM petty_cash_top_ups WHERE tenant_id = NEW.tenant_id AND id = NEW.id) = 'paid'
     AND (SELECT count(*) FROM petty_cash_entries WHERE tenant_id = NEW.tenant_id
            AND top_up_id = NEW.id) <> 1 THEN
    RAISE EXCEPTION 'A paid top-up raises its float once' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER petty_cash_top_up_posting AFTER INSERT OR UPDATE ON "petty_cash_top_ups"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_top_up_posting();

-- Expenses ----------------------------------------------------------------------------------------
ALTER TABLE "petty_cash_expenses" ADD CONSTRAINT "petty_cash_expenses_check" CHECK (
  number ~ '^EXP-[0-9]{4,12}$' AND amount_minor > 0 AND charge_minor >= 0 AND version >= 1
  AND category IN ('materials', 'labour', 'plant', 'subcontract', 'preliminaries', 'fees',
                   'permits', 'transport', 'petty_cash')
  AND num_nonnulls(cost_code_id, bq_item_lineage_id) >= 1
  AND (bq_version_id IS NULL) = (bq_item_lineage_id IS NULL)
  AND counterparty_kind IN ('supplier', 'worker', 'other')
  AND (counterparty_kind = 'supplier') = (supplier_id IS NOT NULL)
  AND char_length(btrim(payee_name)) >= 2 AND char_length(btrim(description)) >= 3
  AND payment_method IN ('cash', 'mpesa')
  AND (payment_method = 'mpesa') = (mpesa_code IS NOT NULL)
  AND (mpesa_code IS NULL OR (mpesa_code ~ '^[A-Z0-9]{10}$' AND mpesa_code ~ '[A-Z]'))
  AND (NOT parsed_from_sms OR (mpesa_code IS NOT NULL AND sms_kind IS NOT NULL))
  AND (sms_kind IS NULL OR (parsed_from_sms AND sms_kind IN ('sent', 'paybill', 'till', 'withdraw')))
  AND (payee_phone_masked IS NULL OR payee_phone_masked ~ '^0[17][0-9]{2}[*]{3}[0-9]{3}$')
  AND (payee_account IS NULL OR char_length(btrim(payee_account)) >= 1)
  AND COALESCE(CASE status
    WHEN 'submitted' THEN decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL
    WHEN 'approved' THEN decided_by IS NOT NULL AND decided_at IS NOT NULL
    WHEN 'rejected' THEN decided_by IS NOT NULL AND decided_at IS NOT NULL
      AND char_length(btrim(decision_reason)) >= 3
    ELSE false
  END, false)
  AND (decided_by IS NULL OR decided_by <> recorded_by)
  AND source IN ('web', 'site_app')
  AND request_digest ~ '^[0-9a-f]{64}$' AND char_length(idempotency_key) >= 8
);
-- One M-Pesa transaction is one expense (a rejected record may be corrected under the same code).
CREATE UNIQUE INDEX "petty_cash_expenses_one_mpesa_code" ON "petty_cash_expenses" ("tenant_id", "mpesa_code")
  WHERE mpesa_code IS NOT NULL AND status <> 'rejected';

-- An expense is recorded by the float's custodian (the signed-in user) on an active float, at its
-- site, dated within the last 90 days (Africa/Nairobi), against an item of an approved BQ version
-- of the project or an active cost code. Afterwards only its decision is recorded, once, by the
-- signed-in user, who is neither the recorder nor the custodian; approval needs a receipt photo.
CREATE FUNCTION app.guard_petty_cash_expense() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  f record;
  bq_ok boolean;
BEGIN
  SELECT status, custodian_user_id, site_id, project_id INTO f FROM petty_cash_floats
   WHERE tenant_id = NEW.tenant_id AND id = NEW.float_id;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'submitted' OR NEW.recorded_by IS DISTINCT FROM app.current_user_id()
       OR f.status IS DISTINCT FROM 'active' OR f.custodian_user_id <> NEW.recorded_by
       OR f.site_id <> NEW.site_id THEN
      RAISE EXCEPTION 'An expense is recorded by the custodian of an active float at its site'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.spent_on > app.business_today() OR NEW.spent_on < app.business_today() - 90 THEN
      RAISE EXCEPTION 'An expense is dated within the last 90 days' USING ERRCODE = '23514';
    END IF;
    IF NEW.bq_version_id IS NOT NULL THEN
      SELECT v.status = 'approved' AND v.project_id = NEW.project_id INTO bq_ok FROM bq_versions v
       WHERE v.tenant_id = NEW.tenant_id AND v.id = NEW.bq_version_id;
      IF NOT COALESCE(bq_ok, false) THEN
        RAISE EXCEPTION 'An expense names an item of an approved BQ version of the project'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NEW.cost_code_id IS NOT NULL AND NOT COALESCE((SELECT active FROM cost_codes
         WHERE tenant_id = NEW.tenant_id AND id = NEW.cost_code_id), false) THEN
      RAISE EXCEPTION 'An expense uses an active cost code' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'decided_by' - 'decided_at' - 'decision_reason' - 'version')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'status' - 'decided_by' - 'decided_at' - 'decision_reason' - 'version')
     OR OLD.status <> 'submitted' OR NEW.status NOT IN ('approved', 'rejected')
     OR NEW.decided_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'An expense is only decided, once, by the signed-in user' USING ERRCODE = '23514';
  END IF;
  IF NEW.decided_by IN (OLD.recorded_by, f.custodian_user_id) THEN
    RAISE EXCEPTION 'An expense is decided by someone other than its recorder and the custodian'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'approved' AND NOT EXISTS (
    SELECT 1 FROM petty_cash_receipts WHERE tenant_id = NEW.tenant_id AND expense_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'An expense is approved with a receipt photo' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER petty_cash_expense_guard BEFORE INSERT OR UPDATE ON "petty_cash_expenses"
  FOR EACH ROW EXECUTE FUNCTION app.guard_petty_cash_expense();

-- At commit: a recorded expense has taken its cash out of the float; a rejected one has put it
-- back; an approved one has posted its cost (accrued and paid, and its M-Pesa charge if any).
CREATE FUNCTION app.check_expense_postings() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target record;
  wanted text[];
BEGIN
  SELECT * INTO target FROM petty_cash_expenses WHERE tenant_id = NEW.tenant_id AND id = NEW.id;
  IF NOT EXISTS (SELECT 1 FROM petty_cash_entries WHERE tenant_id = target.tenant_id
                   AND expense_id = target.id AND kind = 'expense')
     OR (target.status = 'rejected') <> EXISTS (
       SELECT 1 FROM petty_cash_entries WHERE tenant_id = target.tenant_id
          AND expense_id = target.id AND kind = 'expense_rejected') THEN
    RAISE EXCEPTION 'An expense moves its float''s cash with it' USING ERRCODE = '23514';
  END IF;
  wanted := CASE WHEN target.status <> 'approved' THEN ARRAY[]::text[]
                 WHEN target.charge_minor > 0
                   THEN ARRAY['accrual', 'charge_accrual', 'charge_payment', 'payment']
                 ELSE ARRAY['accrual', 'payment'] END;
  IF wanted IS DISTINCT FROM ARRAY(
    SELECT purpose::text FROM cost_entries WHERE tenant_id = target.tenant_id
       AND expense_id = target.id ORDER BY purpose) THEN
    RAISE EXCEPTION 'An approved expense posts its cost once' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER petty_cash_expense_postings AFTER INSERT OR UPDATE ON "petty_cash_expenses"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_expense_postings();

ALTER TABLE "petty_cash_receipts" ADD CONSTRAINT "petty_cash_receipts_check" CHECK (
  content_type IN ('image/jpeg', 'image/png', 'image/webp') AND size_bytes > 0
  AND sha256 ~ '^[0-9a-f]{64}$' AND scan_status IN ('clean', 'not_scanned')
);

-- Receipts are evidence: added by the signed-in user to an expense that was not rejected, at
-- most three per expense, never changed.
CREATE FUNCTION app.guard_petty_cash_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expense_status text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'A receipt is never changed' USING ERRCODE = '23514';
  END IF;
  -- The expense row lock serialises concurrent uploads, so the count below holds.
  SELECT status INTO expense_status FROM petty_cash_expenses
   WHERE tenant_id = NEW.tenant_id AND id = NEW.expense_id FOR UPDATE;
  IF NEW.uploaded_by IS DISTINCT FROM app.current_user_id()
     OR expense_status IS NULL OR expense_status = 'rejected'
     OR (SELECT count(*) FROM petty_cash_receipts WHERE tenant_id = NEW.tenant_id
           AND expense_id = NEW.expense_id) >= 3 THEN
    RAISE EXCEPTION 'At most three receipts, added by the signed-in user to an expense not rejected'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER petty_cash_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON "petty_cash_receipts"
  FOR EACH ROW EXECUTE FUNCTION app.guard_petty_cash_receipt();

-- Counts ------------------------------------------------------------------------------------------
ALTER TABLE "petty_cash_counts" ADD CONSTRAINT "petty_cash_counts_check" CHECK (
  number ~ '^CNT-[0-9]{4,12}$' AND counted_minor >= 0 AND book_minor >= 0 AND book_seq >= 0
  AND variance_minor = counted_minor - book_minor AND version >= 1
  AND (note IS NULL OR char_length(btrim(note)) >= 1)
  AND COALESCE(CASE status
    WHEN 'submitted' THEN decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL
    WHEN 'approved' THEN decided_by IS NOT NULL AND decided_at IS NOT NULL
    WHEN 'returned' THEN decided_by IS NOT NULL AND decided_at IS NOT NULL
      AND char_length(btrim(decision_reason)) >= 3
    ELSE false
  END, false)
  AND (decided_by IS NULL OR decided_by <> counted_by)
);
CREATE UNIQUE INDEX "petty_cash_counts_one_open" ON "petty_cash_counts" ("tenant_id", "float_id")
  WHERE status = 'submitted';

-- A count is recorded by the signed-in user against the float's book balance at that moment (the
-- float row is locked). Afterwards only its decision is recorded, once, by the signed-in user, who
-- neither counted nor holds the float.
CREATE FUNCTION app.guard_petty_cash_count() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  f record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT status, balance_minor, last_seq INTO f FROM petty_cash_floats
     WHERE tenant_id = NEW.tenant_id AND id = NEW.float_id FOR UPDATE;
    IF NEW.status <> 'submitted' OR NEW.counted_by IS DISTINCT FROM app.current_user_id()
       OR f.status IS DISTINCT FROM 'active' OR NEW.book_minor <> f.balance_minor
       OR NEW.book_seq <> f.last_seq THEN
      RAISE EXCEPTION 'A count is recorded by the signed-in user against the current book balance'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT custodian_user_id INTO f FROM petty_cash_floats
   WHERE tenant_id = NEW.tenant_id AND id = NEW.float_id;
  IF (to_jsonb(NEW) - 'status' - 'decided_by' - 'decided_at' - 'decision_reason' - 'version')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'status' - 'decided_by' - 'decided_at' - 'decision_reason' - 'version')
     OR OLD.status <> 'submitted' OR NEW.status NOT IN ('approved', 'returned')
     OR NEW.decided_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A count is only decided, once, by the signed-in user' USING ERRCODE = '23514';
  END IF;
  IF NEW.decided_by IN (OLD.counted_by, f.custodian_user_id) THEN
    RAISE EXCEPTION 'A count is decided by someone who neither counted nor holds the float'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER petty_cash_count_guard BEFORE INSERT OR UPDATE ON "petty_cash_counts"
  FOR EACH ROW EXECUTE FUNCTION app.guard_petty_cash_count();

-- At commit: an approved count with a variance has adjusted the float once and posted the
-- variance as petty-cash cost (accrued and paid); nothing else has.
CREATE FUNCTION app.check_count_postings() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target record;
  posted boolean;
BEGIN
  SELECT * INTO target FROM petty_cash_counts WHERE tenant_id = NEW.tenant_id AND id = NEW.id;
  posted := target.status = 'approved' AND target.variance_minor <> 0;
  IF posted <> EXISTS (SELECT 1 FROM petty_cash_entries WHERE tenant_id = target.tenant_id
                         AND count_id = target.id)
     OR (CASE WHEN posted THEN 2 ELSE 0 END) <> (SELECT count(*) FROM cost_entries
           WHERE tenant_id = target.tenant_id AND float_count_id = target.id) THEN
    RAISE EXCEPTION 'An approved count posts its variance once' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER petty_cash_count_postings AFTER INSERT OR UPDATE ON "petty_cash_counts"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_count_postings();

-- Cash-flow lines ---------------------------------------------------------------------------------
ALTER TABLE "cash_flow_items" ADD CONSTRAINT "cash_flow_items_check" CHECK (
  direction IN ('in', 'out') AND char_length(btrim(description)) >= 3 AND amount_minor > 0
  AND expected_on BETWEEN DATE '2000-01-01' AND DATE '2099-12-31' AND version >= 1
  AND status IN ('expected', 'received', 'cancelled')
  AND (status = 'received') = (received_on IS NOT NULL)
  AND (received_on IS NULL) = (received_minor IS NULL)
  AND (received_minor IS NULL OR received_minor > 0)
  AND (reference IS NULL OR char_length(btrim(reference)) >= 1)
);

-- A line keeps its project, direction and author; once received or cancelled it never changes.
CREATE FUNCTION app.guard_cash_flow_item() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'expected' OR NEW.created_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'A cash-flow line starts as expected, by the signed-in user'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.direction IS DISTINCT FROM OLD.direction OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'A cash-flow line keeps its project and direction' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'expected' THEN
    RAISE EXCEPTION 'A % cash-flow line never changes', OLD.status USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'received' AND NEW.received_on > app.business_today() THEN
    RAISE EXCEPTION 'Money is received on or before today' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER cash_flow_item_guard BEFORE INSERT OR UPDATE ON "cash_flow_items"
  FOR EACH ROW EXECUTE FUNCTION app.guard_cash_flow_item();

-- Existing approved invoices and settlements -----------------------------------------------------
-- Approved invoices accrue their subtotal (recorded by their first approver, when approved); each
-- recorded settlement posts the cost part of its cash, cumulatively in recording order
-- (app.settlement_cost_minor), exactly as the triggers above do from now on. This runs before the
-- tables' RLS is enabled, as the schema owner, so FORCE ROW LEVEL SECURITY is lifted for the
-- tables read here and restored afterwards.
ALTER TABLE "supplier_invoices" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "invoice_payables" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "invoice_settlements" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "lpos" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "suppliers" NO FORCE ROW LEVEL SECURITY;

ALTER TABLE "cost_entries" DISABLE TRIGGER "cost_entry_check";
INSERT INTO cost_entries (id, tenant_id, project_id, site_id, measure, category, counterparty_kind,
  supplier_id, counterparty_name, payment_reference, amount_minor, occurred_on, source, purpose,
  invoice_id, recorded_by, recorded_at, business_date)
SELECT uuidv7(first.approved_at - clock_timestamp()), i.tenant_id, i.project_id,
       l.delivery_site_id, 'accrued', 'materials', 'supplier', i.supplier_id,
       left(COALESCE(s.trading_name, s.legal_name), 200), i.invoice_number, i.subtotal_minor,
       i.invoice_date, 'supplier_invoice', 'accrual', i.id, first.approved_by, first.approved_at,
       (first.approved_at AT TIME ZONE 'Africa/Nairobi')::date
  FROM supplier_invoices i
  JOIN lpos l ON l.tenant_id = i.tenant_id AND l.id = i.lpo_id
  JOIN suppliers s ON s.tenant_id = i.tenant_id AND s.id = i.supplier_id
  JOIN LATERAL (
    SELECT p.approved_by, p.approved_at FROM invoice_payables p
     WHERE p.tenant_id = i.tenant_id AND p.invoice_id = i.id
     ORDER BY p.approved_at, p.id LIMIT 1
  ) first ON true
 WHERE i.status IN ('approved', 'partly_settled', 'settled') AND i.subtotal_minor > 0;

INSERT INTO cost_entries (id, tenant_id, project_id, site_id, measure, category, counterparty_kind,
  supplier_id, counterparty_name, payment_reference, amount_minor, occurred_on, source, purpose,
  invoice_id, settlement_id, recorded_by, recorded_at, business_date)
SELECT uuidv7(x.recorded_at - clock_timestamp()), x.tenant_id, x.project_id, x.delivery_site_id,
       'paid', 'materials', 'supplier', x.supplier_id, x.supplier_name, x.external_reference,
       app.settlement_cost_minor(x.subtotal_minor, x.total_minor, x.settled_before, x.amount_minor),
       x.paid_on, 'invoice_settlement', 'payment', x.invoice_id, x.id, x.recorded_by,
       x.recorded_at, (x.recorded_at AT TIME ZONE 'Africa/Nairobi')::date
  FROM (
    SELECT st.*, i.project_id, i.subtotal_minor, i.total_minor, i.supplier_id, l.delivery_site_id,
           left(COALESCE(s.trading_name, s.legal_name), 200) AS supplier_name,
           COALESCE(sum(st.amount_minor) OVER (PARTITION BY st.tenant_id, st.invoice_id
             ORDER BY st.recorded_at, st.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),
             0)::bigint AS settled_before
      FROM invoice_settlements st
      JOIN supplier_invoices i ON i.tenant_id = st.tenant_id AND i.id = st.invoice_id
      JOIN lpos l ON l.tenant_id = i.tenant_id AND l.id = i.lpo_id
      JOIN suppliers s ON s.tenant_id = i.tenant_id AND s.id = i.supplier_id
  ) x
 WHERE app.settlement_cost_minor(x.subtotal_minor, x.total_minor, x.settled_before,
                                 x.amount_minor) <> 0;
ALTER TABLE "cost_entries" ENABLE TRIGGER "cost_entry_check";

ALTER TABLE "supplier_invoices" FORCE ROW LEVEL SECURITY;
ALTER TABLE "invoice_payables" FORCE ROW LEVEL SECURITY;
ALTER TABLE "invoice_settlements" FORCE ROW LEVEL SECURITY;
ALTER TABLE "lpos" FORCE ROW LEVEL SECURITY;
ALTER TABLE "suppliers" FORCE ROW LEVEL SECURITY;

-- Row-level security -----------------------------------------------------------------------------
DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['spending_settings', 'cost_codes', 'budgets', 'budget_lines',
    'cost_journals', 'cost_journal_lines', 'cost_entries', 'petty_cash_floats',
    'petty_cash_entries', 'petty_cash_top_ups', 'petty_cash_expenses', 'petty_cash_receipts',
    'petty_cash_counts', 'cash_flow_items']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = app.current_tenant_id()) '
      'WITH CHECK (tenant_id = app.current_tenant_id())', target || '_isolation', target);
  END LOOP;
END
$$;

-- The runtime role never deletes spending history (draft budget lines aside); the cost ledger,
-- the float ledger, journal lines and receipts are append-only.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmb_app') THEN
    REVOKE DELETE ON "spending_settings", "cost_codes", "budgets", "cost_journals",
      "cost_journal_lines", "cost_entries", "petty_cash_floats", "petty_cash_entries",
      "petty_cash_top_ups", "petty_cash_expenses", "petty_cash_receipts", "petty_cash_counts",
      "cash_flow_items" FROM pmb_app;
    REVOKE UPDATE ON "cost_entries", "petty_cash_entries", "cost_journal_lines",
      "petty_cash_receipts" FROM pmb_app;
    REVOKE TRUNCATE, REFERENCES, TRIGGER
      ON "spending_settings", "cost_codes", "budgets", "budget_lines", "cost_journals",
         "cost_journal_lines", "cost_entries", "petty_cash_floats", "petty_cash_entries",
         "petty_cash_top_ups", "petty_cash_expenses", "petty_cash_receipts", "petty_cash_counts",
         "cash_flow_items"
      FROM pmb_app;
    GRANT EXECUTE ON FUNCTION app.settlement_cost_minor(bigint, bigint, bigint, bigint) TO pmb_app;
  END IF;
END
$$;
REVOKE EXECUTE ON FUNCTION app.settlement_cost_minor(bigint, bigint, bigint, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_cost_code() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_budget() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_budget_line() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.sum_budget_lines() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_budget_totals() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_cost_journal() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_cost_journal_line() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_cost_journal_postings() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_cost_entry() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.refuse_cost_entry_change() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.post_invoice_accrual() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.post_settlement_cost() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_petty_cash_float() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.post_float_entry() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.apply_float_entry() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.refuse_float_entry_change() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_petty_cash_top_up() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_top_up_posting() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_petty_cash_expense() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_expense_postings() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_petty_cash_receipt() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_petty_cash_count() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_count_postings() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_cash_flow_item() FROM PUBLIC;

COMMIT;
