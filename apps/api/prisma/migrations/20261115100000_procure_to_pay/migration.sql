-- D5.2 Procure-to-pay (ARCHITECTURE §4.5, ERD §5, WORKFLOWS "Procurement and certification",
-- brief §5.3, §5.7, §5.8 and §15 C/D/E/G). Enforces, in the database as well as the API:
-- * State machines for requisitions, RFQs, LPOs and supplier invoices (packages/domain
--   procurement/lifecycle.ts), with frozen content outside draft and immutable approved LPOs.
-- * Maker-checker by identity: contributor lists kept by triggers (only ever grow); the decider of
--   a requisition, the approver of an LPO, of a single-source exception, of a match exception and
--   of an invoice is never a contributor; a settlement is never recorded by the invoice approver.
-- * Award rule: an LPO needs procurement_settings.min_quotes complete, valid quotations or an
--   approved single-source exception.
-- * GRNs, quotations, matches, payables, settlements and documents are append-only evidence
--   (GRNs only voided with a reason; quotations only withdrawn).
-- * THE THREE-WAY MATCH BLOCKS BAD PAYMENTS: an invoice reaches `approved` only with a payable
--   bound to a passing match of its current content version that is still current (same GRN set,
--   same other approved invoices, same settings); a `matched` outcome is re-checked in SQL
--   (app.invoice_match_violations: quantities against accepted GRNs and the order across all
--   approved invoices of the LPO, prices, totals, eTIMS); settlements need the active payable,
--   a still-verified payee version and never exceed the outstanding balance.
-- * Duplicate supplier invoice numbers are refused (normalised key, per supplier).
-- Every table has tenant_id, forced RLS with WITH CHECK and composite (tenant_id, …) foreign keys.
BEGIN;

-- AlterTable
ALTER TABLE "procurement_settings" ADD COLUMN     "block_payment_without_etims" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "min_quotes" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "price_tolerance_percent" DECIMAL(7,4) NOT NULL DEFAULT 0,
ADD COLUMN     "qty_tolerance_percent" DECIMAL(7,4) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "requisitions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "site_id" UUID,
    "number" VARCHAR(20) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'draft',
    "needed_by" DATE NOT NULL,
    "notes" VARCHAR(2000),
    "line_count" INTEGER NOT NULL DEFAULT 0,
    "contributors" UUID[] NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_by" UUID,
    "submitted_at" TIMESTAMPTZ,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ,
    "rejection_reason" VARCHAR(500),
    "cancelled_by" UUID,
    "cancelled_at" TIMESTAMPTZ,
    "cancel_reason" VARCHAR(500),

    CONSTRAINT "requisitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "requisition_lines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "material_id" UUID NOT NULL,
    "quantity" DECIMAL(20,6) NOT NULL,
    "unit" VARCHAR(20) NOT NULL,
    "base_quantity" DECIMAL(20,6) NOT NULL,
    "base_unit" VARCHAR(20) NOT NULL,
    "conversion" JSONB NOT NULL,
    "bq_version_id" UUID,
    "bq_item_lineage_id" UUID,
    "note" VARCHAR(300),

    CONSTRAINT "requisition_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rfqs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "number" VARCHAR(20) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'open',
    "respond_by" DATE,
    "notes" VARCHAR(2000),
    "min_quotes_applied" INTEGER,
    "exception_reason" VARCHAR(500),
    "exception_requested_by" UUID,
    "exception_requested_at" TIMESTAMPTZ,
    "exception_approved_by" UUID,
    "exception_approved_at" TIMESTAMPTZ,
    "cancelled_by" UUID,
    "cancelled_at" TIMESTAMPTZ,
    "cancel_reason" VARCHAR(500),
    "contributors" UUID[] NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rfqs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rfq_requisitions" (
    "tenant_id" UUID NOT NULL,
    "rfq_id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "released_at" TIMESTAMPTZ,

    CONSTRAINT "rfq_requisitions_pkey" PRIMARY KEY ("tenant_id","rfq_id","requisition_id")
);

-- CreateTable
CREATE TABLE "rfq_suppliers" (
    "tenant_id" UUID NOT NULL,
    "rfq_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "added_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rfq_suppliers_pkey" PRIMARY KEY ("tenant_id","rfq_id","supplier_id")
);

-- CreateTable
CREATE TABLE "quotations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "rfq_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "reference" VARCHAR(60),
    "quoted_on" DATE NOT NULL,
    "valid_until" DATE NOT NULL,
    "delivery_days" INTEGER NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'received',
    "complete" BOOLEAN NOT NULL,
    "net_total_minor" BIGINT NOT NULL,
    "vat_rate_percent" DECIMAL(7,4) NOT NULL,
    "vat_rule_status" VARCHAR(30) NOT NULL,
    "withdrawn_by" UUID,
    "withdrawn_at" TIMESTAMPTZ,
    "withdrawn_reason" VARCHAR(500),
    "recorded_by" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quotations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotation_lines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "quotation_id" UUID NOT NULL,
    "requisition_line_id" UUID NOT NULL,
    "status" VARCHAR(10) NOT NULL,
    "price_unit" VARCHAR(20),
    "unit_price_minor" BIGINT,
    "vat_treatment" VARCHAR(15),
    "price_ratio" VARCHAR(120),
    "net_unit_price_base_minor" DECIMAL(30,6),
    "net_amount_minor" BIGINT,
    "price_id" UUID,

    CONSTRAINT "quotation_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lpos" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "number" VARCHAR(20) NOT NULL,
    "rfq_id" UUID NOT NULL,
    "quotation_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "replaces_lpo_id" UUID,
    "status" VARCHAR(20) NOT NULL DEFAULT 'draft',
    "delivery_site_id" UUID,
    "delivery_date" DATE,
    "terms" VARCHAR(2000),
    "credit_days" INTEGER NOT NULL,
    "supplier_name" VARCHAR(200) NOT NULL,
    "supplier_kra_pin_masked" VARCHAR(16),
    "supplier_etims_status" VARCHAR(20) NOT NULL,
    "vat_rate_percent" DECIMAL(7,4) NOT NULL,
    "vat_rule_status" VARCHAR(30) NOT NULL,
    "subtotal_minor" BIGINT NOT NULL,
    "vat_minor" BIGINT NOT NULL,
    "total_minor" BIGINT NOT NULL,
    "contributors" UUID[] NOT NULL DEFAULT '{}',
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

    CONSTRAINT "lpos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lpo_lines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "lpo_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "requisition_line_id" UUID NOT NULL,
    "material_id" UUID NOT NULL,
    "quantity" DECIMAL(20,6) NOT NULL,
    "unit" VARCHAR(20) NOT NULL,
    "base_quantity" DECIMAL(20,6) NOT NULL,
    "base_unit" VARCHAR(20) NOT NULL,
    "price_unit" VARCHAR(20) NOT NULL,
    "unit_price_minor" BIGINT NOT NULL,
    "vat_treatment" VARCHAR(15) NOT NULL,
    "price_ratio" VARCHAR(120) NOT NULL,
    "net_unit_price_base_minor" DECIMAL(30,6) NOT NULL,
    "net_amount_minor" BIGINT NOT NULL,

    CONSTRAINT "lpo_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grns" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "lpo_id" UUID NOT NULL,
    "site_id" UUID,
    "number" VARCHAR(20) NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'recorded',
    "idempotency_key" VARCHAR(100) NOT NULL,
    "request_digest" CHAR(64) NOT NULL,
    "captured_at" TIMESTAMPTZ NOT NULL,
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "received_by_name" VARCHAR(100) NOT NULL,
    "recorded_by" UUID NOT NULL,
    "vehicle_registration" VARCHAR(15) NOT NULL,
    "vehicle_registration_format" VARCHAR(10) NOT NULL,
    "delivery_note_number" VARCHAR(60),
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "accuracy_m" DECIMAL(9,1),
    "location_state" VARCHAR(12) NOT NULL,
    "low_accuracy" BOOLEAN NOT NULL DEFAULT false,
    "location_error" VARCHAR(12),
    "geofence_version" INTEGER,
    "over_delivery" BOOLEAN NOT NULL DEFAULT false,
    "line_count" INTEGER NOT NULL,
    "source" VARCHAR(10) NOT NULL,
    "notes" VARCHAR(1000),
    "voided_by" UUID,
    "voided_at" TIMESTAMPTZ,
    "void_reason" VARCHAR(500),

    CONSTRAINT "grns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grn_lines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "grn_id" UUID NOT NULL,
    "lpo_id" UUID NOT NULL,
    "lpo_line_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "unit" VARCHAR(20) NOT NULL,
    "received_quantity" DECIMAL(20,6) NOT NULL,
    "rejected_quantity" DECIMAL(20,6) NOT NULL,
    "rejection_reason" VARCHAR(300),
    "accepted_base_quantity" DECIMAL(20,6) NOT NULL,
    "over_delivery" BOOLEAN NOT NULL DEFAULT false,
    "conversion" JSONB NOT NULL,

    CONSTRAINT "grn_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_invoices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "lpo_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "invoice_number" VARCHAR(60) NOT NULL,
    "invoice_number_key" VARCHAR(60) NOT NULL,
    "invoice_date" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "etims_invoice_number" VARCHAR(40),
    "etims_format" VARCHAR(15),
    "vat_rate_percent" DECIMAL(7,4) NOT NULL,
    "vat_rule_status" VARCHAR(30) NOT NULL,
    "subtotal_minor" BIGINT NOT NULL,
    "vat_minor" BIGINT NOT NULL,
    "total_minor" BIGINT NOT NULL,
    "computed_subtotal_minor" BIGINT NOT NULL,
    "computed_vat_minor" BIGINT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'draft',
    "content_version" INTEGER NOT NULL DEFAULT 1,
    "notes" VARCHAR(1000),
    "contributors" UUID[] NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_by" UUID,
    "submitted_at" TIMESTAMPTZ,
    "cancelled_by" UUID,
    "cancelled_at" TIMESTAMPTZ,
    "cancel_reason" VARCHAR(500),

    CONSTRAINT "supplier_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_invoice_lines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "lpo_id" UUID NOT NULL,
    "lpo_line_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "quantity" DECIMAL(20,6) NOT NULL,
    "unit" VARCHAR(20) NOT NULL,
    "base_quantity" DECIMAL(20,6) NOT NULL,
    "unit_price_minor" BIGINT NOT NULL,
    "vat_treatment" VARCHAR(15) NOT NULL,
    "price_ratio" VARCHAR(120) NOT NULL,
    "net_unit_price_base_minor" DECIMAL(30,6) NOT NULL,
    "net_amount_minor" BIGINT NOT NULL,
    "conversion" JSONB NOT NULL,

    CONSTRAINT "supplier_invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "three_way_matches" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "lpo_id" UUID NOT NULL,
    "invoice_content_version" INTEGER NOT NULL,
    "grn_ids" UUID[] NOT NULL,
    "prior_invoice_ids" UUID[] NOT NULL,
    "qty_tolerance_percent" DECIMAL(7,4) NOT NULL,
    "price_tolerance_percent" DECIMAL(7,4) NOT NULL,
    "block_without_etims" BOOLEAN NOT NULL,
    "outcome" VARCHAR(10) NOT NULL,
    "reasons" TEXT[] NOT NULL,
    "evidence" JSONB NOT NULL,
    "computed_by" UUID NOT NULL,
    "computed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exception_reason" VARCHAR(500),
    "exception_by" UUID,
    "exception_at" TIMESTAMPTZ,

    CONSTRAINT "three_way_matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_payables" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "invoice_content_version" INTEGER NOT NULL,
    "match_id" UUID NOT NULL,
    "payout_version_id" UUID NOT NULL,
    "authorised_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'KES',
    "approved_by" UUID NOT NULL,
    "approved_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "superseded_by" UUID,
    "superseded_at" TIMESTAMPTZ,

    CONSTRAINT "invoice_payables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_settlements" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "payable_id" UUID NOT NULL,
    "method" VARCHAR(20) NOT NULL,
    "external_reference" VARCHAR(60) NOT NULL,
    "reference_key" VARCHAR(60) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "paid_on" DATE NOT NULL,
    "note" VARCHAR(500),
    "idempotency_key" VARCHAR(100) NOT NULL,
    "request_digest" CHAR(64) NOT NULL,
    "recorded_by" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "procurement_documents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "quotation_id" UUID,
    "grn_id" UUID,
    "invoice_id" UUID,
    "object_key" VARCHAR(300) NOT NULL,
    "content_type" VARCHAR(40) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "scan_status" VARCHAR(15) NOT NULL,
    "scan_engine" VARCHAR(40) NOT NULL,
    "scanned_at" TIMESTAMPTZ NOT NULL,
    "uploaded_by" UUID NOT NULL,
    "uploaded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "procurement_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "requisitions_tenant_id_project_id_status_idx" ON "requisitions"("tenant_id", "project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "requisitions_tenant_id_id_key" ON "requisitions"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "requisitions_tenant_id_project_id_id_key" ON "requisitions"("tenant_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "requisitions_tenant_id_number_key" ON "requisitions"("tenant_id", "number");

-- CreateIndex
CREATE INDEX "requisition_lines_tenant_id_requisition_id_idx" ON "requisition_lines"("tenant_id", "requisition_id");

-- CreateIndex
CREATE UNIQUE INDEX "requisition_lines_tenant_id_id_key" ON "requisition_lines"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "requisition_lines_tenant_id_requisition_id_line_no_key" ON "requisition_lines"("tenant_id", "requisition_id", "line_no");

-- CreateIndex
CREATE INDEX "rfqs_tenant_id_project_id_status_idx" ON "rfqs"("tenant_id", "project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "rfqs_tenant_id_id_key" ON "rfqs"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "rfqs_tenant_id_project_id_id_key" ON "rfqs"("tenant_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "rfqs_tenant_id_number_key" ON "rfqs"("tenant_id", "number");

-- CreateIndex
CREATE INDEX "rfq_requisitions_tenant_id_requisition_id_idx" ON "rfq_requisitions"("tenant_id", "requisition_id");

-- CreateIndex
CREATE INDEX "rfq_suppliers_tenant_id_supplier_id_idx" ON "rfq_suppliers"("tenant_id", "supplier_id");

-- CreateIndex
CREATE INDEX "quotations_tenant_id_rfq_id_idx" ON "quotations"("tenant_id", "rfq_id");

-- CreateIndex
CREATE UNIQUE INDEX "quotations_tenant_id_id_key" ON "quotations"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "quotations_tenant_id_rfq_id_id_key" ON "quotations"("tenant_id", "rfq_id", "id");

-- CreateIndex
CREATE INDEX "quotation_lines_tenant_id_requisition_line_id_idx" ON "quotation_lines"("tenant_id", "requisition_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "quotation_lines_tenant_id_id_key" ON "quotation_lines"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "quotation_lines_tenant_id_quotation_id_requisition_line_id_key" ON "quotation_lines"("tenant_id", "quotation_id", "requisition_line_id");

-- CreateIndex
CREATE INDEX "lpos_tenant_id_project_id_status_idx" ON "lpos"("tenant_id", "project_id", "status");

-- CreateIndex
CREATE INDEX "lpos_tenant_id_supplier_id_idx" ON "lpos"("tenant_id", "supplier_id");

-- CreateIndex
CREATE INDEX "lpos_tenant_id_rfq_id_idx" ON "lpos"("tenant_id", "rfq_id");

-- CreateIndex
CREATE UNIQUE INDEX "lpos_tenant_id_id_key" ON "lpos"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "lpos_tenant_id_project_id_id_key" ON "lpos"("tenant_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "lpos_tenant_id_number_key" ON "lpos"("tenant_id", "number");

-- CreateIndex
CREATE INDEX "lpo_lines_tenant_id_requisition_line_id_idx" ON "lpo_lines"("tenant_id", "requisition_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "lpo_lines_tenant_id_id_key" ON "lpo_lines"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "lpo_lines_tenant_id_lpo_id_id_key" ON "lpo_lines"("tenant_id", "lpo_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "lpo_lines_tenant_id_lpo_id_line_no_key" ON "lpo_lines"("tenant_id", "lpo_id", "line_no");

-- CreateIndex
CREATE INDEX "grns_tenant_id_project_id_idx" ON "grns"("tenant_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "grns_tenant_id_id_key" ON "grns"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "grns_tenant_id_lpo_id_id_key" ON "grns"("tenant_id", "lpo_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "grns_tenant_id_number_key" ON "grns"("tenant_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "grns_tenant_id_idempotency_key_key" ON "grns"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "grn_lines_tenant_id_lpo_line_id_idx" ON "grn_lines"("tenant_id", "lpo_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "grn_lines_tenant_id_id_key" ON "grn_lines"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "grn_lines_tenant_id_grn_id_lpo_line_id_key" ON "grn_lines"("tenant_id", "grn_id", "lpo_line_id");

-- CreateIndex
CREATE INDEX "supplier_invoices_tenant_id_project_id_status_idx" ON "supplier_invoices"("tenant_id", "project_id", "status");

-- CreateIndex
CREATE INDEX "supplier_invoices_tenant_id_supplier_id_idx" ON "supplier_invoices"("tenant_id", "supplier_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_invoices_tenant_id_id_key" ON "supplier_invoices"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_invoices_tenant_id_lpo_id_id_key" ON "supplier_invoices"("tenant_id", "lpo_id", "id");

-- CreateIndex
CREATE INDEX "supplier_invoice_lines_tenant_id_lpo_line_id_idx" ON "supplier_invoice_lines"("tenant_id", "lpo_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_invoice_lines_tenant_id_id_key" ON "supplier_invoice_lines"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_invoice_lines_tenant_id_invoice_id_lpo_line_id_key" ON "supplier_invoice_lines"("tenant_id", "invoice_id", "lpo_line_id");

-- CreateIndex
CREATE INDEX "three_way_matches_tenant_id_invoice_id_computed_at_idx" ON "three_way_matches"("tenant_id", "invoice_id", "computed_at");

-- CreateIndex
CREATE UNIQUE INDEX "three_way_matches_tenant_id_id_key" ON "three_way_matches"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "three_way_matches_tenant_id_invoice_id_id_key" ON "three_way_matches"("tenant_id", "invoice_id", "id");

-- CreateIndex
CREATE INDEX "invoice_payables_tenant_id_invoice_id_idx" ON "invoice_payables"("tenant_id", "invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_payables_tenant_id_id_key" ON "invoice_payables"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_payables_tenant_id_invoice_id_id_key" ON "invoice_payables"("tenant_id", "invoice_id", "id");

-- CreateIndex
CREATE INDEX "invoice_settlements_tenant_id_invoice_id_idx" ON "invoice_settlements"("tenant_id", "invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_settlements_tenant_id_id_key" ON "invoice_settlements"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_settlements_tenant_id_method_reference_key_key" ON "invoice_settlements"("tenant_id", "method", "reference_key");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_settlements_tenant_id_idempotency_key_key" ON "invoice_settlements"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "procurement_documents_tenant_id_quotation_id_idx" ON "procurement_documents"("tenant_id", "quotation_id");

-- CreateIndex
CREATE INDEX "procurement_documents_tenant_id_grn_id_idx" ON "procurement_documents"("tenant_id", "grn_id");

-- CreateIndex
CREATE INDEX "procurement_documents_tenant_id_invoice_id_idx" ON "procurement_documents"("tenant_id", "invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "procurement_documents_tenant_id_id_key" ON "procurement_documents"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "procurement_documents_tenant_id_object_key_key" ON "procurement_documents"("tenant_id", "object_key");

-- AddForeignKey
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_tenant_id_site_id_fkey" FOREIGN KEY ("tenant_id", "site_id") REFERENCES "sites"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requisition_lines" ADD CONSTRAINT "requisition_lines_tenant_id_requisition_id_fkey" FOREIGN KEY ("tenant_id", "requisition_id") REFERENCES "requisitions"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requisition_lines" ADD CONSTRAINT "requisition_lines_tenant_id_material_id_fkey" FOREIGN KEY ("tenant_id", "material_id") REFERENCES "materials"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requisition_lines" ADD CONSTRAINT "requisition_lines_tenant_id_bq_version_id_bq_item_lineage__fkey" FOREIGN KEY ("tenant_id", "bq_version_id", "bq_item_lineage_id") REFERENCES "bq_items"("tenant_id", "version_id", "lineage_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_requisitions" ADD CONSTRAINT "rfq_requisitions_tenant_id_project_id_rfq_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "rfq_id") REFERENCES "rfqs"("tenant_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_requisitions" ADD CONSTRAINT "rfq_requisitions_tenant_id_project_id_requisition_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "requisition_id") REFERENCES "requisitions"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_suppliers" ADD CONSTRAINT "rfq_suppliers_tenant_id_rfq_id_fkey" FOREIGN KEY ("tenant_id", "rfq_id") REFERENCES "rfqs"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_suppliers" ADD CONSTRAINT "rfq_suppliers_tenant_id_supplier_id_fkey" FOREIGN KEY ("tenant_id", "supplier_id") REFERENCES "suppliers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_tenant_id_rfq_id_fkey" FOREIGN KEY ("tenant_id", "rfq_id") REFERENCES "rfqs"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_tenant_id_rfq_id_supplier_id_fkey" FOREIGN KEY ("tenant_id", "rfq_id", "supplier_id") REFERENCES "rfq_suppliers"("tenant_id", "rfq_id", "supplier_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_tenant_id_quotation_id_fkey" FOREIGN KEY ("tenant_id", "quotation_id") REFERENCES "quotations"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_tenant_id_requisition_line_id_fkey" FOREIGN KEY ("tenant_id", "requisition_line_id") REFERENCES "requisition_lines"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_tenant_id_price_id_fkey" FOREIGN KEY ("tenant_id", "price_id") REFERENCES "material_prices"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lpos" ADD CONSTRAINT "lpos_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lpos" ADD CONSTRAINT "lpos_tenant_id_project_id_rfq_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "rfq_id") REFERENCES "rfqs"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lpos" ADD CONSTRAINT "lpos_tenant_id_rfq_id_quotation_id_fkey" FOREIGN KEY ("tenant_id", "rfq_id", "quotation_id") REFERENCES "quotations"("tenant_id", "rfq_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lpos" ADD CONSTRAINT "lpos_tenant_id_supplier_id_fkey" FOREIGN KEY ("tenant_id", "supplier_id") REFERENCES "suppliers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lpos" ADD CONSTRAINT "lpos_tenant_id_delivery_site_id_fkey" FOREIGN KEY ("tenant_id", "delivery_site_id") REFERENCES "sites"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lpos" ADD CONSTRAINT "lpos_tenant_id_replaces_lpo_id_fkey" FOREIGN KEY ("tenant_id", "replaces_lpo_id") REFERENCES "lpos"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lpo_lines" ADD CONSTRAINT "lpo_lines_tenant_id_lpo_id_fkey" FOREIGN KEY ("tenant_id", "lpo_id") REFERENCES "lpos"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lpo_lines" ADD CONSTRAINT "lpo_lines_tenant_id_requisition_line_id_fkey" FOREIGN KEY ("tenant_id", "requisition_line_id") REFERENCES "requisition_lines"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lpo_lines" ADD CONSTRAINT "lpo_lines_tenant_id_material_id_fkey" FOREIGN KEY ("tenant_id", "material_id") REFERENCES "materials"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grns" ADD CONSTRAINT "grns_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grns" ADD CONSTRAINT "grns_tenant_id_project_id_lpo_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "lpo_id") REFERENCES "lpos"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grns" ADD CONSTRAINT "grns_tenant_id_site_id_fkey" FOREIGN KEY ("tenant_id", "site_id") REFERENCES "sites"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grns" ADD CONSTRAINT "grns_tenant_id_site_id_geofence_version_fkey" FOREIGN KEY ("tenant_id", "site_id", "geofence_version") REFERENCES "site_geofences"("tenant_id", "site_id", "version") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grn_lines" ADD CONSTRAINT "grn_lines_tenant_id_lpo_id_grn_id_fkey" FOREIGN KEY ("tenant_id", "lpo_id", "grn_id") REFERENCES "grns"("tenant_id", "lpo_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grn_lines" ADD CONSTRAINT "grn_lines_tenant_id_lpo_id_lpo_line_id_fkey" FOREIGN KEY ("tenant_id", "lpo_id", "lpo_line_id") REFERENCES "lpo_lines"("tenant_id", "lpo_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_tenant_id_project_id_lpo_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "lpo_id") REFERENCES "lpos"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_tenant_id_supplier_id_fkey" FOREIGN KEY ("tenant_id", "supplier_id") REFERENCES "suppliers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_invoice_lines" ADD CONSTRAINT "supplier_invoice_lines_tenant_id_lpo_id_invoice_id_fkey" FOREIGN KEY ("tenant_id", "lpo_id", "invoice_id") REFERENCES "supplier_invoices"("tenant_id", "lpo_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_invoice_lines" ADD CONSTRAINT "supplier_invoice_lines_tenant_id_lpo_id_lpo_line_id_fkey" FOREIGN KEY ("tenant_id", "lpo_id", "lpo_line_id") REFERENCES "lpo_lines"("tenant_id", "lpo_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "three_way_matches" ADD CONSTRAINT "three_way_matches_tenant_id_lpo_id_invoice_id_fkey" FOREIGN KEY ("tenant_id", "lpo_id", "invoice_id") REFERENCES "supplier_invoices"("tenant_id", "lpo_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_payables" ADD CONSTRAINT "invoice_payables_tenant_id_invoice_id_fkey" FOREIGN KEY ("tenant_id", "invoice_id") REFERENCES "supplier_invoices"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_payables" ADD CONSTRAINT "invoice_payables_tenant_id_invoice_id_match_id_fkey" FOREIGN KEY ("tenant_id", "invoice_id", "match_id") REFERENCES "three_way_matches"("tenant_id", "invoice_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_payables" ADD CONSTRAINT "invoice_payables_tenant_id_payout_version_id_fkey" FOREIGN KEY ("tenant_id", "payout_version_id") REFERENCES "supplier_payout_versions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_settlements" ADD CONSTRAINT "invoice_settlements_tenant_id_invoice_id_payable_id_fkey" FOREIGN KEY ("tenant_id", "invoice_id", "payable_id") REFERENCES "invoice_payables"("tenant_id", "invoice_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "procurement_documents" ADD CONSTRAINT "procurement_documents_tenant_id_quotation_id_fkey" FOREIGN KEY ("tenant_id", "quotation_id") REFERENCES "quotations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "procurement_documents" ADD CONSTRAINT "procurement_documents_tenant_id_grn_id_fkey" FOREIGN KEY ("tenant_id", "grn_id") REFERENCES "grns"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "procurement_documents" ADD CONSTRAINT "procurement_documents_tenant_id_invoice_id_fkey" FOREIGN KEY ("tenant_id", "invoice_id") REFERENCES "supplier_invoices"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Settings (CONFIGURATION §5) ------------------------------------------------------------------
ALTER TABLE "procurement_settings" ADD CONSTRAINT "procurement_settings_p2p_check" CHECK (
  min_quotes BETWEEN 1 AND 10
  AND qty_tolerance_percent BETWEEN 0 AND 100 AND price_tolerance_percent BETWEEN 0 AND 100
);

-- The match settings in force for a company (no row = the defaults: 0 %, 0 %, block).
CREATE FUNCTION app.p2p_match_settings(target_tenant uuid,
  OUT qty_tolerance numeric, OUT price_tolerance numeric, OUT block_etims boolean)
  LANGUAGE sql STABLE AS $$
  SELECT COALESCE(s.qty_tolerance_percent, 0), COALESCE(s.price_tolerance_percent, 0),
         COALESCE(s.block_payment_without_etims, true)
    FROM (SELECT 1) AS one
    LEFT JOIN procurement_settings s ON s.tenant_id = target_tenant
$$;

-- Today's business date (Africa/Nairobi), as packages/domain nairobiDate.
CREATE FUNCTION app.business_today() RETURNS date LANGUAGE sql STABLE AS $$
  SELECT (now() AT TIME ZONE 'Africa/Nairobi')::date
$$;

-- Requisitions ---------------------------------------------------------------------------------
-- packages/types REQUISITION_STATUSES; maker-checker by identity: the decider is never a
-- contributor (requester or anyone who wrote it).
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_state_check" CHECK (
  number ~ '^REQ-[0-9]{4,12}$' AND version >= 1 AND line_count BETWEEN 0 AND 100
  AND created_by = ANY (contributors)
  AND COALESCE(CASE status
    WHEN 'draft' THEN submitted_at IS NULL AND decided_by IS NULL AND cancelled_at IS NULL
      AND rejection_reason IS NULL
    WHEN 'submitted' THEN submitted_by IS NOT NULL AND submitted_at IS NOT NULL
      AND decided_by IS NULL AND cancelled_at IS NULL AND line_count >= 1
    WHEN 'approved' THEN submitted_by IS NOT NULL AND decided_by IS NOT NULL
      AND decided_at IS NOT NULL AND rejection_reason IS NULL AND cancelled_at IS NULL
      AND line_count >= 1
    WHEN 'ordered' THEN decided_by IS NOT NULL AND rejection_reason IS NULL
      AND cancelled_at IS NULL AND line_count >= 1
    WHEN 'rejected' THEN decided_by IS NOT NULL AND decided_at IS NOT NULL
      AND char_length(btrim(rejection_reason)) >= 3 AND cancelled_at IS NULL
    WHEN 'cancelled' THEN cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL
      AND char_length(btrim(cancel_reason)) >= 3
    ELSE false
  END, false)
  AND (decided_by IS NULL OR NOT (decided_by = ANY (contributors)))
);

-- packages/domain REQUISITION_TRANSITIONS (statusChanges).
CREATE FUNCTION app.guard_requisition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  site_project uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'A requisition starts as a draft' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.project_id IS DISTINCT FROM OLD.project_id
       OR NEW.number IS DISTINCT FROM OLD.number OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'A requisition keeps its identity' USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'cancelled' THEN
      RAISE EXCEPTION 'A cancelled requisition never changes' USING ERRCODE = '23514';
    END IF;
    IF NOT (NEW.contributors @> OLD.contributors) THEN
      RAISE EXCEPTION 'A requisition''s contributors are only ever added' USING ERRCODE = '23514';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND (OLD.status, NEW.status) NOT IN (
      ('draft', 'submitted'), ('submitted', 'approved'), ('submitted', 'rejected'),
      ('rejected', 'draft'), ('submitted', 'draft'), ('approved', 'draft'),
      ('draft', 'cancelled'), ('submitted', 'cancelled'), ('approved', 'ordered'),
      ('ordered', 'approved')
    ) THEN
      RAISE EXCEPTION 'Requisition status cannot change from % to %', OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;
    IF (OLD.status <> 'draft' OR NEW.status <> 'draft') AND (
      NEW.site_id IS DISTINCT FROM OLD.site_id OR NEW.needed_by IS DISTINCT FROM OLD.needed_by
      OR NEW.notes IS DISTINCT FROM OLD.notes OR NEW.line_count IS DISTINCT FROM OLD.line_count
    ) THEN
      RAISE EXCEPTION 'Only a draft requisition changes its content' USING ERRCODE = '23514';
    END IF;
    IF NEW.status IN ('approved', 'rejected') AND OLD.status = 'submitted'
       AND app.current_user_id() IS DISTINCT FROM NEW.decided_by THEN
      RAISE EXCEPTION 'A requisition is decided by the signed-in user' USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'approved' AND NEW.status = 'draft' AND EXISTS (
      SELECT 1 FROM rfq_requisitions WHERE tenant_id = NEW.tenant_id AND requisition_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'A requisition that went to an RFQ cannot return to draft'
        USING ERRCODE = '23514';
    END IF;
    IF (OLD.status, NEW.status) IN (('approved', 'ordered'), ('ordered', 'approved'))
       AND (NEW.status = 'ordered') IS DISTINCT FROM EXISTS (
         SELECT 1 FROM lpo_lines l
           JOIN lpos o ON o.tenant_id = l.tenant_id AND o.id = l.lpo_id
           JOIN requisition_lines r ON r.tenant_id = l.tenant_id AND r.id = l.requisition_line_id
          WHERE r.tenant_id = NEW.tenant_id AND r.requisition_id = NEW.id AND o.status = 'approved'
       ) THEN
      RAISE EXCEPTION 'A requisition is ordered exactly while an approved LPO covers it'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.site_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.site_id IS DISTINCT FROM OLD.site_id) THEN
    SELECT project_id INTO site_project FROM sites WHERE tenant_id = NEW.tenant_id AND id = NEW.site_id;
    IF site_project IS DISTINCT FROM NEW.project_id THEN
      RAISE EXCEPTION 'The site belongs to another project' USING ERRCODE = '23514';
    END IF;
  END IF;
  -- Writers of a draft or submitted requisition contribute; deciding, cancelling and ordering do not.
  IF NEW.status IN ('draft', 'submitted') THEN
    NEW.contributors := app.add_contributors(
      NEW.contributors, NEW.created_by, NEW.updated_by, NEW.submitted_by, app.current_user_id()
    );
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER requisition_guard BEFORE INSERT OR UPDATE ON "requisitions"
  FOR EACH ROW EXECUTE FUNCTION app.guard_requisition();

ALTER TABLE "requisition_lines" ADD CONSTRAINT "requisition_lines_check" CHECK (
  line_no BETWEEN 1 AND 100 AND quantity > 0 AND base_quantity > 0
  AND (bq_version_id IS NULL) = (bq_item_lineage_id IS NULL)
  AND (note IS NULL OR char_length(btrim(note)) >= 1)
);

-- Lines change only while the requisition is a draft; their material's base unit is kept; a BQ
-- tag names an item of an approved BQ version of the same project; writers contribute.
CREATE FUNCTION app.guard_requisition_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent record;
  material_base text;
  bq_ok boolean;
BEGIN
  SELECT status, project_id INTO parent FROM requisitions
    WHERE tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id)
      AND id = COALESCE(NEW.requisition_id, OLD.requisition_id);
  IF parent.status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Requisition lines change only while the requisition is a draft'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP <> 'DELETE' THEN
    IF TG_OP = 'UPDATE' AND NEW.requisition_id IS DISTINCT FROM OLD.requisition_id THEN
      RAISE EXCEPTION 'A line stays with its requisition' USING ERRCODE = '23514';
    END IF;
    SELECT base_unit INTO material_base FROM materials
      WHERE tenant_id = NEW.tenant_id AND id = NEW.material_id;
    IF material_base IS DISTINCT FROM NEW.base_unit THEN
      RAISE EXCEPTION 'A line''s base unit is its material''s base unit' USING ERRCODE = '23514';
    END IF;
    IF NEW.bq_version_id IS NOT NULL THEN
      SELECT v.status = 'approved' AND v.project_id = parent.project_id INTO bq_ok
        FROM bq_versions v WHERE v.tenant_id = NEW.tenant_id AND v.id = NEW.bq_version_id;
      IF NOT COALESCE(bq_ok, false) THEN
        RAISE EXCEPTION 'A BQ tag names an approved BQ version of the same project'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  IF app.current_user_id() IS NOT NULL THEN
    UPDATE requisitions SET contributors = app.add_contributors(contributors, app.current_user_id())
      WHERE tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id)
        AND id = COALESCE(NEW.requisition_id, OLD.requisition_id)
        AND NOT (app.current_user_id() = ANY (contributors));
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER requisition_line_guard BEFORE INSERT OR UPDATE OR DELETE ON "requisition_lines"
  FOR EACH ROW EXECUTE FUNCTION app.guard_requisition_line();

-- At commit, a requisition's line count equals its lines.
CREATE FUNCTION app.check_requisition_lines() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_tenant uuid;
  target_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'requisitions' THEN
    target_tenant := NEW.tenant_id;
    target_id := NEW.id;
  ELSE
    target_tenant := COALESCE(NEW.tenant_id, OLD.tenant_id);
    target_id := COALESCE(NEW.requisition_id, OLD.requisition_id);
  END IF;
  IF (SELECT line_count FROM requisitions WHERE tenant_id = target_tenant AND id = target_id)
     IS DISTINCT FROM (SELECT count(*)::int FROM requisition_lines
                        WHERE tenant_id = target_tenant AND requisition_id = target_id) THEN
    RAISE EXCEPTION 'A requisition''s line count must equal its lines' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER requisition_line_count AFTER INSERT OR UPDATE ON "requisitions"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_requisition_lines();
CREATE CONSTRAINT TRIGGER requisition_line_count AFTER INSERT OR UPDATE OR DELETE
  ON "requisition_lines" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_requisition_lines();

-- RFQs and quotations -------------------------------------------------------------------------
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_state_check" CHECK (
  number ~ '^RFQ-[0-9]{4,12}$' AND version >= 1 AND created_by = ANY (contributors)
  AND status IN ('open', 'awarded', 'cancelled')
  AND (status = 'cancelled') = (cancelled_at IS NOT NULL)
  AND (cancelled_at IS NULL OR (cancelled_by IS NOT NULL
       AND COALESCE(char_length(btrim(cancel_reason)), 0) >= 3))
  AND (exception_reason IS NULL) = (exception_requested_at IS NULL)
  AND (exception_requested_by IS NULL) = (exception_requested_at IS NULL)
  AND (exception_reason IS NULL OR char_length(btrim(exception_reason)) >= 3)
  AND (exception_approved_by IS NULL) = (exception_approved_at IS NULL)
  AND (exception_approved_by IS NULL OR exception_requested_by IS NOT NULL)
  AND (exception_approved_by IS NULL OR NOT (exception_approved_by = ANY (contributors)))
  AND (min_quotes_applied IS NULL OR min_quotes_applied BETWEEN 1 AND 10)
);

-- packages/domain RFQ_TRANSITIONS: open → awarded (a live LPO exists) → open (it was cancelled);
-- open → cancelled. A single-source exception is approved by the signed-in user, never a
-- contributor (creator, editors, the requester of the exception and quotation recorders).
CREATE FUNCTION app.guard_rfq() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  live_lpo boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' OR NEW.exception_approved_by IS NOT NULL THEN
      RAISE EXCEPTION 'An RFQ starts open' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.project_id IS DISTINCT FROM OLD.project_id
       OR NEW.number IS DISTINCT FROM OLD.number OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'An RFQ keeps its identity' USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'cancelled' THEN
      RAISE EXCEPTION 'A cancelled RFQ never changes' USING ERRCODE = '23514';
    END IF;
    IF NOT (NEW.contributors @> OLD.contributors) THEN
      RAISE EXCEPTION 'An RFQ''s contributors are only ever added' USING ERRCODE = '23514';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND (OLD.status, NEW.status) NOT IN (
      ('open', 'awarded'), ('awarded', 'open'), ('open', 'cancelled')
    ) THEN
      RAISE EXCEPTION 'RFQ status cannot change from % to %', OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;
    IF OLD.status <> 'open' AND (NEW.respond_by IS DISTINCT FROM OLD.respond_by
       OR NEW.notes IS DISTINCT FROM OLD.notes
       OR NEW.exception_reason IS DISTINCT FROM OLD.exception_reason
       OR NEW.exception_approved_by IS DISTINCT FROM OLD.exception_approved_by) THEN
      RAISE EXCEPTION 'Only an open RFQ changes' USING ERRCODE = '23514';
    END IF;
    IF OLD.exception_approved_by IS NOT NULL AND (
      NEW.exception_reason IS DISTINCT FROM OLD.exception_reason
      OR NEW.exception_approved_by IS DISTINCT FROM OLD.exception_approved_by) THEN
      RAISE EXCEPTION 'An approved exception never changes' USING ERRCODE = '23514';
    END IF;
    IF NEW.exception_approved_by IS NOT NULL AND OLD.exception_approved_by IS NULL
       AND app.current_user_id() IS DISTINCT FROM NEW.exception_approved_by THEN
      RAISE EXCEPTION 'An exception is approved by the signed-in user' USING ERRCODE = '23514';
    END IF;
    live_lpo := EXISTS (SELECT 1 FROM lpos WHERE tenant_id = NEW.tenant_id AND rfq_id = NEW.id
                          AND status <> 'cancelled');
    IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('awarded', 'open')
       AND (NEW.status = 'awarded') IS DISTINCT FROM live_lpo THEN
      RAISE EXCEPTION 'An RFQ is awarded exactly while it has a live LPO' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'cancelled' AND live_lpo THEN
      RAISE EXCEPTION 'An RFQ with a live LPO cannot be cancelled' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR (NEW.status <> 'cancelled'
     AND NEW.exception_approved_by IS NOT DISTINCT FROM OLD.exception_approved_by) THEN
    NEW.contributors := app.add_contributors(
      NEW.contributors, NEW.created_by, NEW.updated_by, NEW.exception_requested_by,
      app.current_user_id()
    );
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER rfq_guard BEFORE INSERT OR UPDATE ON "rfqs"
  FOR EACH ROW EXECUTE FUNCTION app.guard_rfq();

-- A requisition is on at most one unreleased RFQ (released when that RFQ is cancelled).
CREATE UNIQUE INDEX "rfq_requisitions_one_live" ON "rfq_requisitions"("tenant_id", "requisition_id")
  WHERE released_at IS NULL;

CREATE FUNCTION app.guard_rfq_requisition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.released_at IS NOT NULL
       OR (SELECT status FROM rfqs WHERE tenant_id = NEW.tenant_id AND id = NEW.rfq_id)
          IS DISTINCT FROM 'open'
       OR (SELECT status FROM requisitions WHERE tenant_id = NEW.tenant_id AND id = NEW.requisition_id)
          IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION 'An open RFQ takes approved requisitions' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'released_at') IS DISTINCT FROM (to_jsonb(OLD) - 'released_at')
     OR OLD.released_at IS NOT NULL OR NEW.released_at IS NULL
     OR (SELECT status FROM rfqs WHERE tenant_id = NEW.tenant_id AND id = NEW.rfq_id)
        IS DISTINCT FROM 'cancelled' THEN
    RAISE EXCEPTION 'A requisition is released only by cancelling its RFQ' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER rfq_requisition_guard BEFORE INSERT OR UPDATE ON "rfq_requisitions"
  FOR EACH ROW EXECUTE FUNCTION app.guard_rfq_requisition();

-- Suppliers are invited and removed only while the RFQ is open; blocked suppliers never.
CREATE FUNCTION app.guard_rfq_supplier() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT status FROM rfqs WHERE tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id)
        AND id = COALESCE(NEW.rfq_id, OLD.rfq_id)) IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'Suppliers change only while the RFQ is open' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND (SELECT status FROM suppliers WHERE tenant_id = NEW.tenant_id
       AND id = NEW.supplier_id) = 'blocked' THEN
    RAISE EXCEPTION 'A blocked supplier cannot be invited' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER rfq_supplier_guard BEFORE INSERT OR DELETE ON "rfq_suppliers"
  FOR EACH ROW EXECUTE FUNCTION app.guard_rfq_supplier();

ALTER TABLE "quotations" ADD CONSTRAINT "quotations_state_check" CHECK (
  valid_until >= quoted_on AND delivery_days BETWEEN 0 AND 365 AND net_total_minor >= 0
  AND vat_rate_percent BETWEEN 0 AND 100
  AND (reference IS NULL OR char_length(btrim(reference)) >= 1)
  AND COALESCE(CASE status
    WHEN 'received' THEN withdrawn_at IS NULL AND withdrawn_by IS NULL AND withdrawn_reason IS NULL
    WHEN 'withdrawn' THEN withdrawn_at IS NOT NULL AND withdrawn_by IS NOT NULL
      AND char_length(btrim(withdrawn_reason)) >= 3
    ELSE false
  END, false)
);
-- One live quotation per supplier and RFQ.
CREATE UNIQUE INDEX "quotations_one_live_per_supplier" ON "quotations"("tenant_id", "rfq_id", "supplier_id")
  WHERE status = 'received';

-- Quotations are recorded on open RFQs and never edited; they are only withdrawn (with a reason).
CREATE FUNCTION app.guard_quotation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'received'
       OR (SELECT status FROM rfqs WHERE tenant_id = NEW.tenant_id AND id = NEW.rfq_id)
          IS DISTINCT FROM 'open'
       OR NEW.recorded_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'Quotations are recorded on open RFQs by the signed-in user'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'withdrawn_by' - 'withdrawn_at' - 'withdrawn_reason')
     IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'withdrawn_by' - 'withdrawn_at' - 'withdrawn_reason')
     OR OLD.status <> 'received' OR NEW.status <> 'withdrawn'
     OR NEW.withdrawn_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A quotation never changes; it can only be withdrawn' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM lpos WHERE tenant_id = NEW.tenant_id AND quotation_id = NEW.id
               AND status <> 'cancelled') THEN
    RAISE EXCEPTION 'An awarded quotation cannot be withdrawn' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER quotation_guard BEFORE INSERT OR UPDATE ON "quotations"
  FOR EACH ROW EXECUTE FUNCTION app.guard_quotation();

ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_check" CHECK (
  COALESCE(CASE status
    WHEN 'quoted' THEN price_unit IS NOT NULL AND unit_price_minor > 0
      AND unit_price_minor <= 1000000000000
      AND vat_treatment IN ('inclusive', 'exclusive', 'not_applicable')
      AND price_ratio ~ '^[0-9]+/[0-9]+$' AND net_unit_price_base_minor > 0
      AND net_amount_minor >= 0
    WHEN 'no_bid' THEN price_unit IS NULL AND unit_price_minor IS NULL AND vat_treatment IS NULL
      AND price_ratio IS NULL AND net_unit_price_base_minor IS NULL AND net_amount_minor IS NULL
      AND price_id IS NULL
    ELSE false
  END, false)
);

-- A quotation line prices a line of a requisition on the quotation's RFQ.
CREATE FUNCTION app.guard_quotation_line() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM quotations q
      JOIN rfq_requisitions rr ON rr.tenant_id = q.tenant_id AND rr.rfq_id = q.rfq_id
        AND rr.released_at IS NULL
      JOIN requisition_lines rl ON rl.tenant_id = rr.tenant_id AND rl.requisition_id = rr.requisition_id
     WHERE q.tenant_id = NEW.tenant_id AND q.id = NEW.quotation_id AND q.status = 'received'
       AND rl.id = NEW.requisition_line_id
  ) THEN
    RAISE EXCEPTION 'A quotation line prices a line of its RFQ' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER quotation_line_guard BEFORE INSERT ON "quotation_lines"
  FOR EACH ROW EXECUTE FUNCTION app.guard_quotation_line();

-- At commit: a quotation's net total is the sum of its quoted lines and it is complete exactly
-- when it prices every line of its RFQ.
CREATE FUNCTION app.check_quotation_totals() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target record;
  target_id uuid;
  priced bigint;
  quoted int;
  bids int;
  wanted int;
BEGIN
  IF TG_TABLE_NAME = 'quotations' THEN
    target_id := NEW.id;
  ELSE
    target_id := NEW.quotation_id;
  END IF;
  SELECT * INTO target FROM quotations WHERE tenant_id = NEW.tenant_id AND id = target_id;
  SELECT COALESCE(sum(net_amount_minor), 0), count(*) FILTER (WHERE status = 'quoted'), count(*)
    INTO priced, quoted, bids
    FROM quotation_lines WHERE tenant_id = target.tenant_id AND quotation_id = target.id;
  SELECT count(*) INTO wanted FROM rfq_requisitions rr
    JOIN requisition_lines rl ON rl.tenant_id = rr.tenant_id AND rl.requisition_id = rr.requisition_id
   WHERE rr.tenant_id = target.tenant_id AND rr.rfq_id = target.rfq_id AND rr.released_at IS NULL;
  IF target.net_total_minor <> priced OR target.complete <> (quoted = wanted AND bids = wanted)
     OR bids = 0 THEN
    RAISE EXCEPTION 'A quotation''s total and completeness must follow its lines'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER quotation_totals AFTER INSERT ON "quotations"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_quotation_totals();
CREATE CONSTRAINT TRIGGER quotation_totals AFTER INSERT ON "quotation_lines"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_quotation_totals();

-- LPOs ---------------------------------------------------------------------------------------
ALTER TABLE "lpos" ADD CONSTRAINT "lpos_state_check" CHECK (
  number ~ '^LPO-[0-9]{4,12}$' AND version >= 1 AND created_by = ANY (contributors)
  AND subtotal_minor >= 0 AND vat_minor >= 0 AND total_minor = subtotal_minor + vat_minor
  AND credit_days BETWEEN 0 AND 365 AND vat_rate_percent BETWEEN 0 AND 100
  AND supplier_etims_status IN ('registered', 'unknown', 'not_registered')
  AND COALESCE(CASE status
    WHEN 'draft' THEN submitted_at IS NULL AND approved_by IS NULL AND cancelled_at IS NULL
    WHEN 'submitted' THEN submitted_by IS NOT NULL AND submitted_at IS NOT NULL
      AND approved_by IS NULL AND cancelled_at IS NULL
    WHEN 'approved' THEN approved_by IS NOT NULL AND approved_at IS NOT NULL
      AND cancelled_at IS NULL
    WHEN 'cancelled' THEN cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL
      AND char_length(btrim(cancel_reason)) >= 3
    ELSE false
  END, false)
  AND (approved_by IS NULL) = (approved_at IS NULL)
  AND (approved_by IS NULL OR NOT (approved_by = ANY (contributors)))
  AND (return_reason IS NULL OR char_length(btrim(return_reason)) >= 3)
);
-- One live (not cancelled) LPO per RFQ: a reissue follows a cancellation.
CREATE UNIQUE INDEX "lpos_one_live_per_rfq" ON "lpos"("tenant_id", "rfq_id") WHERE status <> 'cancelled';

-- packages/domain LPO_TRANSITIONS. An LPO is created from an open RFQ's complete, unexpired,
-- received quotation, for an active supplier, only when the RFQ has the company's minimum number
-- of such quotations or an approved single-source exception. Approved LPOs never change except to
-- be cancelled while nothing was received or invoiced. The approver is never a contributor.
CREATE FUNCTION app.guard_lpo() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  quote record;
  rfq_row record;
  enough boolean;
  site_project uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'An LPO starts as a draft' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO rfq_row FROM rfqs WHERE tenant_id = NEW.tenant_id AND id = NEW.rfq_id;
    SELECT * INTO quote FROM quotations WHERE tenant_id = NEW.tenant_id AND id = NEW.quotation_id;
    IF rfq_row.status IS DISTINCT FROM 'open' OR quote.status IS DISTINCT FROM 'received'
       OR NOT quote.complete OR quote.valid_until < app.business_today()
       OR quote.supplier_id IS DISTINCT FROM NEW.supplier_id THEN
      RAISE EXCEPTION 'An LPO awards a complete, valid quotation of an open RFQ'
        USING ERRCODE = '23514';
    END IF;
    IF (SELECT status FROM suppliers WHERE tenant_id = NEW.tenant_id AND id = NEW.supplier_id)
       IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'An LPO goes to an active supplier' USING ERRCODE = '23514';
    END IF;
    enough := rfq_row.exception_approved_by IS NOT NULL OR (
      SELECT count(*) FROM quotations q WHERE q.tenant_id = NEW.tenant_id AND q.rfq_id = NEW.rfq_id
        AND q.status = 'received' AND q.complete AND q.valid_until >= app.business_today()
    ) >= COALESCE((SELECT min_quotes FROM procurement_settings WHERE tenant_id = NEW.tenant_id), 3);
    IF NOT enough THEN
      RAISE EXCEPTION 'Too few quotations and no approved single-source exception'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.project_id IS DISTINCT FROM OLD.project_id
       OR NEW.number IS DISTINCT FROM OLD.number OR NEW.rfq_id IS DISTINCT FROM OLD.rfq_id
       OR NEW.quotation_id IS DISTINCT FROM OLD.quotation_id
       OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
       OR NEW.replaces_lpo_id IS DISTINCT FROM OLD.replaces_lpo_id
       OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.supplier_name IS DISTINCT FROM OLD.supplier_name
       OR NEW.supplier_kra_pin_masked IS DISTINCT FROM OLD.supplier_kra_pin_masked
       OR NEW.supplier_etims_status IS DISTINCT FROM OLD.supplier_etims_status
       OR NEW.credit_days IS DISTINCT FROM OLD.credit_days
       OR NEW.vat_rate_percent IS DISTINCT FROM OLD.vat_rate_percent
       OR NEW.vat_rule_status IS DISTINCT FROM OLD.vat_rule_status THEN
      RAISE EXCEPTION 'An LPO keeps its identity, supplier snapshot and VAT rate'
        USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'cancelled' THEN
      RAISE EXCEPTION 'A cancelled LPO never changes' USING ERRCODE = '23514';
    END IF;
    IF NOT (NEW.contributors @> OLD.contributors) THEN
      RAISE EXCEPTION 'An LPO''s contributors are only ever added' USING ERRCODE = '23514';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND (OLD.status, NEW.status) NOT IN (
      ('draft', 'submitted'), ('submitted', 'approved'), ('submitted', 'draft'),
      ('draft', 'cancelled'), ('submitted', 'cancelled'), ('approved', 'cancelled')
    ) THEN
      RAISE EXCEPTION 'LPO status cannot change from % to %', OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;
    IF (OLD.status <> 'draft' OR NEW.status <> 'draft') AND (
      NEW.delivery_site_id IS DISTINCT FROM OLD.delivery_site_id
      OR NEW.delivery_date IS DISTINCT FROM OLD.delivery_date OR NEW.terms IS DISTINCT FROM OLD.terms
      OR NEW.subtotal_minor IS DISTINCT FROM OLD.subtotal_minor
      OR NEW.vat_minor IS DISTINCT FROM OLD.vat_minor OR NEW.total_minor IS DISTINCT FROM OLD.total_minor
    ) THEN
      RAISE EXCEPTION 'Only a draft LPO changes its content' USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'approved' AND (
      NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
      OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
      OR NEW.contributors IS DISTINCT FROM OLD.contributors) THEN
      RAISE EXCEPTION 'An approved LPO never changes' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'approved' AND OLD.status = 'submitted'
       AND app.current_user_id() IS DISTINCT FROM NEW.approved_by THEN
      RAISE EXCEPTION 'An LPO is approved by the signed-in user' USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'approved' AND NEW.status = 'cancelled' AND (
      EXISTS (SELECT 1 FROM grns WHERE tenant_id = NEW.tenant_id AND lpo_id = NEW.id
                AND status = 'recorded')
      OR EXISTS (SELECT 1 FROM supplier_invoices WHERE tenant_id = NEW.tenant_id AND lpo_id = NEW.id
                   AND status <> 'cancelled')) THEN
      RAISE EXCEPTION 'An LPO with deliveries or invoices cannot be cancelled' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.delivery_site_id IS NOT NULL AND (TG_OP = 'INSERT'
     OR NEW.delivery_site_id IS DISTINCT FROM OLD.delivery_site_id) THEN
    SELECT project_id INTO site_project FROM sites
      WHERE tenant_id = NEW.tenant_id AND id = NEW.delivery_site_id;
    IF site_project IS DISTINCT FROM NEW.project_id THEN
      RAISE EXCEPTION 'The delivery site belongs to another project' USING ERRCODE = '23514';
    END IF;
  END IF;
  -- Creators, editors and submitters contribute; approving, returning and cancelling do not.
  IF NEW.status IN ('draft', 'submitted') AND (TG_OP = 'INSERT'
     OR NOT (OLD.status = 'submitted' AND NEW.status = 'draft')) THEN
    NEW.contributors := app.add_contributors(
      NEW.contributors, NEW.created_by, NEW.updated_by, NEW.submitted_by, app.current_user_id()
    );
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER lpo_guard BEFORE INSERT OR UPDATE ON "lpos"
  FOR EACH ROW EXECUTE FUNCTION app.guard_lpo();

ALTER TABLE "lpo_lines" ADD CONSTRAINT "lpo_lines_check" CHECK (
  line_no BETWEEN 1 AND 100 AND quantity > 0 AND base_quantity > 0 AND unit_price_minor > 0
  AND unit_price_minor <= 1000000000000
  AND vat_treatment IN ('inclusive', 'exclusive', 'not_applicable')
  AND price_ratio ~ '^[0-9]+/[0-9]+$' AND net_unit_price_base_minor > 0 AND net_amount_minor >= 0
);

-- LPO lines are written once, with their draft LPO, from its RFQ's requisition lines.
CREATE FUNCTION app.guard_lpo_line() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM lpos o
      JOIN rfq_requisitions rr ON rr.tenant_id = o.tenant_id AND rr.rfq_id = o.rfq_id
        AND rr.released_at IS NULL
      JOIN requisition_lines rl ON rl.tenant_id = rr.tenant_id AND rl.requisition_id = rr.requisition_id
     WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.lpo_id AND o.status = 'draft'
       AND rl.id = NEW.requisition_line_id AND rl.material_id = NEW.material_id
       AND rl.base_unit = NEW.base_unit
  ) THEN
    RAISE EXCEPTION 'An LPO line orders a requisition line of its RFQ, on a draft LPO'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER lpo_line_guard BEFORE INSERT ON "lpo_lines"
  FOR EACH ROW EXECUTE FUNCTION app.guard_lpo_line();

-- At commit: an LPO's subtotal is the sum of its rounded lines and VAT is charged once on the
-- VAT-able subtotal, half-up (FINANCIAL_MODEL; packages/domain documentTotals).
CREATE FUNCTION app.check_lpo_totals() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target record;
  target_id uuid;
  subtotal bigint;
  vatable bigint;
  lines int;
BEGIN
  IF TG_TABLE_NAME = 'lpos' THEN
    target_id := NEW.id;
  ELSE
    target_id := NEW.lpo_id;
  END IF;
  SELECT * INTO target FROM lpos WHERE tenant_id = NEW.tenant_id AND id = target_id;
  SELECT COALESCE(sum(net_amount_minor), 0),
         COALESCE(sum(net_amount_minor) FILTER (WHERE vat_treatment <> 'not_applicable'), 0),
         count(*)
    INTO subtotal, vatable, lines
    FROM lpo_lines WHERE tenant_id = target.tenant_id AND lpo_id = target.id;
  IF lines = 0 OR target.subtotal_minor <> subtotal
     OR target.vat_minor <> round(vatable * target.vat_rate_percent / 100) THEN
    RAISE EXCEPTION 'An LPO''s totals must follow its lines' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER lpo_totals AFTER INSERT OR UPDATE ON "lpos"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_lpo_totals();
CREATE CONSTRAINT TRIGGER lpo_totals AFTER INSERT ON "lpo_lines"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_lpo_totals();

-- Goods Received Notes -------------------------------------------------------------------------
ALTER TABLE "grns" ADD CONSTRAINT "grns_state_check" CHECK (
  number ~ '^GRN-[0-9]{4,12}$' AND line_count BETWEEN 1 AND 100
  AND (status = 'voided') = (voided_at IS NOT NULL)
  AND status IN ('recorded', 'voided')
  AND (voided_at IS NULL OR (voided_by IS NOT NULL
       AND COALESCE(char_length(btrim(void_reason)), 0) >= 3))
  AND char_length(btrim(received_by_name)) >= 2
  AND vehicle_registration ~ '^[A-Z0-9][A-Z0-9 -]{1,14}$'
  AND vehicle_registration_format IN ('kenyan', 'other')
  AND (latitude IS NULL) = (longitude IS NULL) AND (latitude IS NULL) = (accuracy_m IS NULL)
  AND (latitude IS NULL OR (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180
       AND accuracy_m >= 0))
  AND COALESCE(CASE location_state
    WHEN 'no_fix' THEN latitude IS NULL AND geofence_version IS NULL AND NOT low_accuracy
    WHEN 'no_geofence' THEN latitude IS NOT NULL AND geofence_version IS NULL
    WHEN 'inside' THEN latitude IS NOT NULL AND geofence_version IS NOT NULL
    WHEN 'outside' THEN latitude IS NOT NULL AND geofence_version IS NOT NULL
    ELSE false
  END, false)
  AND (location_error IS NULL OR (location_error IN ('denied', 'unavailable', 'timeout', 'unsupported')
       AND latitude IS NULL))
  AND source IN ('web', 'site_app')
  AND request_digest ~ '^[0-9a-f]{64}$' AND char_length(idempotency_key) >= 8
);

-- A GRN is recorded by the signed-in user against an approved LPO, at a site of its project, and
-- never changes afterwards except to be voided with a reason. A GRN that supports an approved
-- invoice (its payable's match counted it) cannot be voided.
CREATE FUNCTION app.guard_grn() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  site_project uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'recorded' OR NEW.recorded_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'A GRN is recorded by the signed-in user' USING ERRCODE = '23514';
    END IF;
    IF (SELECT status FROM lpos WHERE tenant_id = NEW.tenant_id AND id = NEW.lpo_id)
       IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION 'Goods are received against an approved LPO' USING ERRCODE = '23514';
    END IF;
    IF NEW.site_id IS NOT NULL THEN
      SELECT project_id INTO site_project FROM sites WHERE tenant_id = NEW.tenant_id AND id = NEW.site_id;
      IF site_project IS DISTINCT FROM NEW.project_id THEN
        RAISE EXCEPTION 'The site belongs to another project' USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'voided_by' - 'voided_at' - 'void_reason')
     IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'voided_by' - 'voided_at' - 'void_reason')
     OR OLD.status <> 'recorded' OR NEW.status <> 'voided'
     OR NEW.voided_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A GRN never changes; it can only be voided' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM invoice_payables p
      JOIN three_way_matches m ON m.tenant_id = p.tenant_id AND m.id = p.match_id
     WHERE p.tenant_id = NEW.tenant_id AND NEW.id = ANY (m.grn_ids)
  ) THEN
    RAISE EXCEPTION 'A GRN that supports an approved invoice cannot be voided'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER grn_guard BEFORE INSERT OR UPDATE ON "grns"
  FOR EACH ROW EXECUTE FUNCTION app.guard_grn();

ALTER TABLE "grn_lines" ADD CONSTRAINT "grn_lines_check" CHECK (
  line_no BETWEEN 1 AND 100 AND received_quantity >= 0 AND rejected_quantity >= 0
  AND rejected_quantity <= received_quantity AND accepted_base_quantity >= 0
  AND (rejected_quantity = 0 OR COALESCE(char_length(btrim(rejection_reason)), 0) >= 1)
);

-- Lines are written with their GRN (the line count at commit forbids later additions).
CREATE FUNCTION app.guard_grn_line() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT status FROM grns WHERE tenant_id = NEW.tenant_id AND id = NEW.grn_id)
     IS DISTINCT FROM 'recorded' THEN
    RAISE EXCEPTION 'Lines are added only to a recorded GRN' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER grn_line_guard BEFORE INSERT ON "grn_lines"
  FOR EACH ROW EXECUTE FUNCTION app.guard_grn_line();

CREATE FUNCTION app.check_grn_lines() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'grns' THEN
    target_id := NEW.id;
  ELSE
    target_id := NEW.grn_id;
  END IF;
  IF (SELECT line_count FROM grns WHERE tenant_id = NEW.tenant_id AND id = target_id)
     IS DISTINCT FROM (SELECT count(*)::int FROM grn_lines
                        WHERE tenant_id = NEW.tenant_id AND grn_id = target_id) THEN
    RAISE EXCEPTION 'A GRN''s line count must equal its lines' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER grn_line_count AFTER INSERT ON "grns"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_grn_lines();
CREATE CONSTRAINT TRIGGER grn_line_count AFTER INSERT ON "grn_lines"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_grn_lines();

-- The recorded (not voided) GRNs of an LPO, ordered: the set a match counts.
CREATE FUNCTION app.lpo_grn_set(target_tenant uuid, target_lpo uuid) RETURNS uuid[]
  LANGUAGE sql STABLE AS $$
  SELECT COALESCE(array_agg(id ORDER BY id), '{}') FROM grns
   WHERE tenant_id = target_tenant AND lpo_id = target_lpo AND status = 'recorded'
$$;

-- Supplier invoices ----------------------------------------------------------------------------
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_state_check" CHECK (
  version >= 1 AND content_version >= 1 AND created_by = ANY (contributors)
  AND subtotal_minor >= 0 AND vat_minor >= 0 AND total_minor > 0
  AND total_minor = subtotal_minor + vat_minor
  AND computed_subtotal_minor >= 0 AND computed_vat_minor >= 0
  AND vat_rate_percent BETWEEN 0 AND 100 AND due_date >= invoice_date
  AND char_length(btrim(invoice_number)) >= 1 AND char_length(invoice_number_key) >= 1
  AND (etims_invoice_number IS NULL) = (etims_format IS NULL)
  AND (etims_format IS NULL OR etims_format IN ('etims', 'unrecognised'))
  AND status IN ('draft', 'submitted', 'matched', 'disputed', 'approved', 'partly_settled',
                 'settled', 'cancelled')
  AND (status = 'cancelled') = (cancelled_at IS NOT NULL)
  AND (cancelled_at IS NULL OR (cancelled_by IS NOT NULL
       AND COALESCE(char_length(btrim(cancel_reason)), 0) >= 3))
  AND (status = 'draft' OR status = 'cancelled' OR submitted_at IS NOT NULL)
);
-- A supplier's invoice number is used once (cancelled invoices aside, e.g. after a credit note).
CREATE UNIQUE INDEX "supplier_invoices_number_once" ON "supplier_invoices"
  ("tenant_id", "supplier_id", "invoice_number_key") WHERE status <> 'cancelled';

-- The approved invoices of an LPO other than `excluded`, ordered: what a match counts as already
-- billed (no double billing).
CREATE FUNCTION app.lpo_prior_invoice_set(target_tenant uuid, target_lpo uuid, excluded uuid)
  RETURNS uuid[] LANGUAGE sql STABLE AS $$
  SELECT COALESCE(array_agg(id ORDER BY id), '{}') FROM supplier_invoices
   WHERE tenant_id = target_tenant AND lpo_id = target_lpo AND id <> excluded
     AND status IN ('approved', 'partly_settled', 'settled')
$$;

-- packages/domain INVOICE_TRANSITIONS. Content changes only in draft (and bumps
-- content_version); matched/disputed need a match of the current content version with that
-- outcome; approved needs the active payable of the current version written by the signed-in
-- user; settlement states follow the recorded settlements.
CREATE FUNCTION app.guard_supplier_invoice() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  lpo_row record;
  settled bigint;
  content_changed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO lpo_row FROM lpos WHERE tenant_id = NEW.tenant_id AND id = NEW.lpo_id;
    IF NEW.status <> 'draft' OR NEW.content_version <> 1 THEN
      RAISE EXCEPTION 'An invoice starts as a draft' USING ERRCODE = '23514';
    END IF;
    IF lpo_row.status IS DISTINCT FROM 'approved' OR lpo_row.supplier_id IS DISTINCT FROM NEW.supplier_id THEN
      RAISE EXCEPTION 'An invoice bills an approved LPO of the same supplier' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.project_id IS DISTINCT FROM OLD.project_id
       OR NEW.lpo_id IS DISTINCT FROM OLD.lpo_id OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
       OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.vat_rate_percent IS DISTINCT FROM OLD.vat_rate_percent
       OR NEW.vat_rule_status IS DISTINCT FROM OLD.vat_rule_status THEN
      RAISE EXCEPTION 'An invoice keeps its identity, LPO, supplier and VAT rate'
        USING ERRCODE = '23514';
    END IF;
    IF OLD.status IN ('cancelled', 'settled') THEN
      RAISE EXCEPTION 'A % invoice never changes', OLD.status USING ERRCODE = '23514';
    END IF;
    IF NOT (NEW.contributors @> OLD.contributors) THEN
      RAISE EXCEPTION 'An invoice''s contributors are only ever added' USING ERRCODE = '23514';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND (OLD.status, NEW.status) NOT IN (
      ('draft', 'submitted'), ('submitted', 'matched'), ('disputed', 'matched'),
      ('submitted', 'disputed'), ('matched', 'disputed'), ('disputed', 'draft'),
      ('matched', 'draft'), ('matched', 'approved'), ('approved', 'partly_settled'),
      ('approved', 'settled'), ('partly_settled', 'settled'), ('draft', 'cancelled'),
      ('submitted', 'cancelled'), ('disputed', 'cancelled'), ('matched', 'cancelled')
    ) THEN
      RAISE EXCEPTION 'Invoice status cannot change from % to %', OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;
    content_changed := NEW.invoice_number IS DISTINCT FROM OLD.invoice_number
      OR NEW.invoice_number_key IS DISTINCT FROM OLD.invoice_number_key
      OR NEW.invoice_date IS DISTINCT FROM OLD.invoice_date OR NEW.due_date IS DISTINCT FROM OLD.due_date
      OR NEW.etims_invoice_number IS DISTINCT FROM OLD.etims_invoice_number
      OR NEW.etims_format IS DISTINCT FROM OLD.etims_format
      OR NEW.subtotal_minor IS DISTINCT FROM OLD.subtotal_minor
      OR NEW.vat_minor IS DISTINCT FROM OLD.vat_minor OR NEW.total_minor IS DISTINCT FROM OLD.total_minor
      OR NEW.computed_subtotal_minor IS DISTINCT FROM OLD.computed_subtotal_minor
      OR NEW.computed_vat_minor IS DISTINCT FROM OLD.computed_vat_minor
      OR NEW.notes IS DISTINCT FROM OLD.notes;
    IF (content_changed OR NEW.content_version IS DISTINCT FROM OLD.content_version)
       AND (OLD.status <> 'draft' OR NEW.status <> 'draft') THEN
      RAISE EXCEPTION 'Only a draft invoice changes its content' USING ERRCODE = '23514';
    END IF;
    IF NEW.content_version < OLD.content_version
       OR (content_changed AND NEW.content_version = OLD.content_version) THEN
      RAISE EXCEPTION 'A content change gives the invoice a new content version'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('matched', 'disputed') AND NOT EXISTS (
      SELECT 1 FROM three_way_matches m
       WHERE m.tenant_id = NEW.tenant_id AND m.invoice_id = NEW.id
         AND m.invoice_content_version = NEW.content_version
         AND CASE NEW.status
           WHEN 'matched' THEN m.outcome = 'matched' OR m.exception_at IS NOT NULL
           ELSE m.outcome = 'mismatch' AND m.exception_at IS NULL END
    ) THEN
      RAISE EXCEPTION 'An invoice is % only by a match of its current version', NEW.status
        USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'approved' AND OLD.status = 'matched' AND NOT EXISTS (
      SELECT 1 FROM invoice_payables p
       WHERE p.tenant_id = NEW.tenant_id AND p.invoice_id = NEW.id AND p.superseded_at IS NULL
         AND p.invoice_content_version = NEW.content_version
         AND p.approved_by = app.current_user_id()
    ) THEN
      RAISE EXCEPTION 'An invoice is approved only with a payable written by its approver'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.status IN ('approved', 'partly_settled', 'settled') THEN
      SELECT COALESCE(sum(amount_minor), 0) INTO settled FROM invoice_settlements
        WHERE tenant_id = NEW.tenant_id AND invoice_id = NEW.id;
      IF NOT COALESCE(CASE NEW.status
        WHEN 'approved' THEN settled = 0
        WHEN 'partly_settled' THEN settled > 0 AND settled < NEW.total_minor
        ELSE settled = NEW.total_minor
      END, false) THEN
        RAISE EXCEPTION 'An invoice''s settlement state follows its settlements'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  -- Recording, editing, submitting and reopening contribute; matching, exceptions, approval and
  -- settlement do not.
  IF NEW.status IN ('draft', 'submitted') THEN
    NEW.contributors := app.add_contributors(
      NEW.contributors, NEW.created_by, NEW.updated_by, NEW.submitted_by, app.current_user_id()
    );
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER supplier_invoice_guard BEFORE INSERT OR UPDATE ON "supplier_invoices"
  FOR EACH ROW EXECUTE FUNCTION app.guard_supplier_invoice();

ALTER TABLE "supplier_invoice_lines" ADD CONSTRAINT "supplier_invoice_lines_check" CHECK (
  line_no BETWEEN 1 AND 100 AND quantity > 0 AND base_quantity > 0 AND unit_price_minor > 0
  AND unit_price_minor <= 1000000000000
  AND vat_treatment IN ('inclusive', 'exclusive', 'not_applicable')
  AND price_ratio ~ '^[0-9]+/[0-9]+$' AND net_unit_price_base_minor > 0 AND net_amount_minor >= 0
);

-- Lines change only while the invoice is a draft; every change gives it a new content version
-- (so no stored match or approval can describe the changed lines) and makes the writer a
-- contributor.
CREATE FUNCTION app.guard_supplier_invoice_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_tenant uuid := COALESCE(NEW.tenant_id, OLD.tenant_id);
  target_invoice uuid := COALESCE(NEW.invoice_id, OLD.invoice_id);
BEGIN
  IF (SELECT status FROM supplier_invoices WHERE tenant_id = target_tenant AND id = target_invoice)
     IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Invoice lines change only while the invoice is a draft' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
     OR NEW.lpo_id IS DISTINCT FROM OLD.lpo_id) THEN
    RAISE EXCEPTION 'A line stays with its invoice' USING ERRCODE = '23514';
  END IF;
  UPDATE supplier_invoices
     SET content_version = content_version + 1,
         contributors = app.add_contributors(contributors, app.current_user_id())
   WHERE tenant_id = target_tenant AND id = target_invoice;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER supplier_invoice_line_guard BEFORE INSERT OR UPDATE OR DELETE
  ON "supplier_invoice_lines" FOR EACH ROW EXECUTE FUNCTION app.guard_supplier_invoice_line();

-- At commit: the recomputed subtotal and VAT stored on the invoice follow its lines.
CREATE FUNCTION app.check_invoice_totals() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target record;
  target_tenant uuid;
  target_id uuid;
  subtotal bigint;
  vatable bigint;
BEGIN
  IF TG_TABLE_NAME = 'supplier_invoices' THEN
    target_tenant := NEW.tenant_id;
    target_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    target_tenant := OLD.tenant_id;
    target_id := OLD.invoice_id;
  ELSE
    target_tenant := NEW.tenant_id;
    target_id := NEW.invoice_id;
  END IF;
  SELECT * INTO target FROM supplier_invoices WHERE tenant_id = target_tenant AND id = target_id;
  SELECT COALESCE(sum(net_amount_minor), 0),
         COALESCE(sum(net_amount_minor) FILTER (WHERE vat_treatment <> 'not_applicable'), 0)
    INTO subtotal, vatable
    FROM supplier_invoice_lines WHERE tenant_id = target.tenant_id AND invoice_id = target.id;
  IF target.computed_subtotal_minor <> subtotal
     OR target.computed_vat_minor <> round(vatable * target.vat_rate_percent / 100) THEN
    RAISE EXCEPTION 'An invoice''s recomputed totals must follow its lines' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER supplier_invoice_totals AFTER INSERT OR UPDATE ON "supplier_invoices"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_invoice_totals();
CREATE CONSTRAINT TRIGGER supplier_invoice_totals AFTER INSERT OR UPDATE OR DELETE
  ON "supplier_invoice_lines" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_invoice_totals();

-- The three-way match backstop ----------------------------------------------------------------
-- Repeats packages/domain threeWayMatch on the stored six-decimal base quantities and per-base
-- net prices (prices with a 0.00001 minor-unit margin for the six-decimal rounding of exact
-- prices, so it is never stricter than the domain rule). Returns the failure codes, sorted.
CREATE FUNCTION app.invoice_match_violations(target_tenant uuid, target_invoice uuid,
  grn_set uuid[], prior_set uuid[], qty_tolerance numeric, price_tolerance numeric,
  block_etims boolean) RETURNS text[] LANGUAGE plpgsql STABLE AS $$
DECLARE
  inv record;
  line record;
  found text[] := '{}';
  q numeric := 1 + qty_tolerance / 100;
  p numeric := 1 + price_tolerance / 100;
  line_total int;
  subtotal bigint;
  vatable bigint;
  allowance bigint;
  order_subtotal bigint;
  prior_subtotal bigint;
BEGIN
  SELECT * INTO inv FROM supplier_invoices WHERE tenant_id = target_tenant AND id = target_invoice;
  SELECT count(*), COALESCE(sum(net_amount_minor), 0),
         COALESCE(sum(net_amount_minor) FILTER (WHERE vat_treatment <> 'not_applicable'), 0)
    INTO line_total, subtotal, vatable
    FROM supplier_invoice_lines WHERE tenant_id = target_tenant AND invoice_id = target_invoice;
  allowance := greatest(1, line_total);
  IF line_total = 0 THEN found := found || 'invoice-empty'::text; END IF;
  IF inv.total_minor <> inv.subtotal_minor + inv.vat_minor THEN
    found := found || 'total-arithmetic'::text;
  END IF;
  IF abs(inv.subtotal_minor - subtotal) > allowance THEN found := found || 'subtotal-mismatch'::text; END IF;
  IF abs(inv.vat_minor - round(vatable * inv.vat_rate_percent / 100)) > allowance THEN
    found := found || 'vat-mismatch'::text;
  END IF;
  SELECT subtotal_minor INTO order_subtotal FROM lpos WHERE tenant_id = target_tenant AND id = inv.lpo_id;
  SELECT COALESCE(sum(computed_subtotal_minor), 0) INTO prior_subtotal FROM supplier_invoices
    WHERE tenant_id = target_tenant AND id = ANY (prior_set);
  IF prior_subtotal + subtotal > order_subtotal * q * p + allowance THEN
    found := found || 'total-exceeds-order'::text;
  END IF;
  IF block_etims AND COALESCE(btrim(inv.etims_invoice_number), '') = '' THEN
    found := found || 'etims-missing'::text;
  END IF;
  FOR line IN
    SELECT il.lpo_line_id, sum(il.base_quantity) AS billed,
           max(il.net_unit_price_base_minor) AS price,
           ol.base_quantity AS ordered, ol.net_unit_price_base_minor AS order_price,
           (SELECT COALESCE(sum(gl.accepted_base_quantity), 0) FROM grn_lines gl
             WHERE gl.tenant_id = target_tenant AND gl.lpo_line_id = il.lpo_line_id
               AND gl.grn_id = ANY (grn_set)) AS received,
           (SELECT COALESCE(sum(pl.base_quantity), 0) FROM supplier_invoice_lines pl
             WHERE pl.tenant_id = target_tenant AND pl.lpo_line_id = il.lpo_line_id
               AND pl.invoice_id = ANY (prior_set)) AS previous
      FROM supplier_invoice_lines il
      JOIN lpo_lines ol ON ol.tenant_id = il.tenant_id AND ol.lpo_id = il.lpo_id
        AND ol.id = il.lpo_line_id
     WHERE il.tenant_id = target_tenant AND il.invoice_id = target_invoice
     GROUP BY il.lpo_line_id, ol.base_quantity, ol.net_unit_price_base_minor
  LOOP
    IF line.billed > 0 THEN
      IF line.received = 0 THEN
        found := found || 'not-received'::text;
      ELSIF line.previous + line.billed > line.received * q THEN
        found := found || 'qty-exceeds-received'::text;
      END IF;
      IF line.previous + line.billed > line.ordered * q THEN
        found := found || 'qty-exceeds-ordered'::text;
      END IF;
      IF line.price > line.order_price * p + 0.00001 THEN
        found := found || 'price-above-order'::text;
      END IF;
    END IF;
  END LOOP;
  RETURN ARRAY(SELECT DISTINCT code FROM unnest(found) AS code ORDER BY code);
END
$$;

ALTER TABLE "three_way_matches" ADD CONSTRAINT "three_way_matches_check" CHECK (
  invoice_content_version >= 1 AND outcome IN ('matched', 'mismatch')
  AND (outcome = 'matched') = (cardinality(reasons) = 0)
  AND qty_tolerance_percent BETWEEN 0 AND 100 AND price_tolerance_percent BETWEEN 0 AND 100
  AND (exception_by IS NULL) = (exception_at IS NULL)
  AND (exception_by IS NULL) = (exception_reason IS NULL)
  AND (exception_reason IS NULL OR char_length(btrim(exception_reason)) >= 3)
  AND (exception_by IS NULL OR outcome = 'mismatch')
  AND NOT (exception_by IS NOT NULL AND reasons && ARRAY['etims-missing', 'total-arithmetic',
    'invoice-empty', 'line-not-on-order']::text[])
);

-- A match is written by the signed-in user for the invoice's current content version, the LPO's
-- current GRN set, its other approved invoices and the company's current settings; a `matched`
-- outcome must also pass the SQL rules. Afterwards only an exception may be recorded on a
-- mismatch, once, by the signed-in user who is not a contributor to the invoice, while the match
-- is still current.
CREATE FUNCTION app.guard_three_way_match() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  inv record;
  settings record;
BEGIN
  SELECT * INTO inv FROM supplier_invoices WHERE tenant_id = NEW.tenant_id AND id = NEW.invoice_id;
  SELECT * INTO settings FROM app.p2p_match_settings(NEW.tenant_id);
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - 'exception_reason' - 'exception_by' - 'exception_at')
       IS DISTINCT FROM (to_jsonb(OLD) - 'exception_reason' - 'exception_by' - 'exception_at')
       OR OLD.exception_by IS NOT NULL OR NEW.exception_by IS NULL
       OR NEW.exception_by IS DISTINCT FROM app.current_user_id()
       OR NEW.exception_by = ANY (inv.contributors) OR inv.status <> 'disputed' THEN
      RAISE EXCEPTION 'A match never changes; an exception is recorded once by an independent person'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.computed_by IS DISTINCT FROM app.current_user_id() OR NEW.exception_by IS NOT NULL
        OR inv.status NOT IN ('submitted', 'disputed', 'matched') THEN
    RAISE EXCEPTION 'A match is run by the signed-in user on a submitted invoice'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.invoice_content_version IS DISTINCT FROM inv.content_version
     OR NEW.grn_ids IS DISTINCT FROM app.lpo_grn_set(NEW.tenant_id, inv.lpo_id)
     OR NEW.prior_invoice_ids IS DISTINCT FROM app.lpo_prior_invoice_set(NEW.tenant_id, inv.lpo_id, inv.id)
     OR NEW.qty_tolerance_percent IS DISTINCT FROM settings.qty_tolerance
     OR NEW.price_tolerance_percent IS DISTINCT FROM settings.price_tolerance
     OR NEW.block_without_etims IS DISTINCT FROM settings.block_etims THEN
    RAISE EXCEPTION 'A match describes the invoice, its GRNs, invoices and settings as they are now'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.outcome = 'matched' AND cardinality(app.invoice_match_violations(
       NEW.tenant_id, NEW.invoice_id, NEW.grn_ids, NEW.prior_invoice_ids,
       NEW.qty_tolerance_percent, NEW.price_tolerance_percent, NEW.block_without_etims)) > 0 THEN
    RAISE EXCEPTION 'The three-way match fails; the invoice cannot be matched'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND 'etims-missing' = ANY (app.invoice_match_violations(
       NEW.tenant_id, NEW.invoice_id, NEW.grn_ids, NEW.prior_invoice_ids,
       NEW.qty_tolerance_percent, NEW.price_tolerance_percent, NEW.block_without_etims)) THEN
    RAISE EXCEPTION 'A missing eTIMS number cannot be excepted' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER three_way_match_guard BEFORE INSERT OR UPDATE ON "three_way_matches"
  FOR EACH ROW EXECUTE FUNCTION app.guard_three_way_match();

-- Payables (approval snapshots) and settlements -----------------------------------------------
ALTER TABLE "invoice_payables" ADD CONSTRAINT "invoice_payables_check" CHECK (
  authorised_minor > 0 AND currency = 'KES' AND invoice_content_version >= 1
  AND (superseded_at IS NULL) = (superseded_by IS NULL)
);
CREATE UNIQUE INDEX "invoice_payables_one_active" ON "invoice_payables"("tenant_id", "invoice_id")
  WHERE superseded_at IS NULL;

-- THE three-way match rule (brief §5.3, "the three-way match blocks bad payments"): a payable is
-- written only by the signed-in approver, who contributed nothing to the invoice, for the
-- invoice's current content version, to the supplier's verified payout version, for the amount
-- still outstanding. A first approval needs a matched invoice and a passing match (matched, or a
-- mismatch with an approved exception) that is still current: same content version, same GRNs,
-- same other approved invoices, same settings. A re-approval (the payee's details changed, so
-- the D5.1 version is no longer verified) keeps the approved match and supersedes the old payable;
-- a payable is never superseded while its payee version is still verified.
CREATE FUNCTION app.guard_invoice_payable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  inv record;
  m record;
  settings record;
  payee record;
  previous record;
  previous_payee text;
  settled bigint;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - 'superseded_by' - 'superseded_at')
       IS DISTINCT FROM (to_jsonb(OLD) - 'superseded_by' - 'superseded_at')
       OR OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL
       OR NEW.superseded_by IS DISTINCT FROM app.current_user_id()
       OR (SELECT status FROM supplier_payout_versions
            WHERE tenant_id = OLD.tenant_id AND id = OLD.payout_version_id) = 'verified' THEN
      RAISE EXCEPTION 'A payable never changes; a re-approval supersedes it after its payee changed'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO inv FROM supplier_invoices WHERE tenant_id = NEW.tenant_id AND id = NEW.invoice_id
    FOR UPDATE;
  SELECT * INTO m FROM three_way_matches WHERE tenant_id = NEW.tenant_id AND id = NEW.match_id;
  SELECT * INTO settings FROM app.p2p_match_settings(NEW.tenant_id);
  SELECT * INTO payee FROM supplier_payout_versions
    WHERE tenant_id = NEW.tenant_id AND id = NEW.payout_version_id;
  SELECT * INTO previous FROM invoice_payables
    WHERE tenant_id = NEW.tenant_id AND invoice_id = NEW.invoice_id
    ORDER BY approved_at DESC, id DESC LIMIT 1;
  IF NEW.superseded_at IS NOT NULL OR NEW.approved_by IS DISTINCT FROM app.current_user_id()
     OR NEW.approved_by = ANY (inv.contributors) THEN
    RAISE EXCEPTION 'An invoice is approved by a signed-in person who did not prepare it'
      USING ERRCODE = '23514';
  END IF;
  IF m.invoice_id IS DISTINCT FROM inv.id
     OR NEW.invoice_content_version IS DISTINCT FROM inv.content_version
     OR m.invoice_content_version IS DISTINCT FROM inv.content_version
     OR NOT (m.outcome = 'matched' OR m.exception_at IS NOT NULL) THEN
    RAISE EXCEPTION 'An invoice is approved only with a passing match of its current version'
      USING ERRCODE = '23514';
  END IF;
  IF inv.status = 'matched' AND previous.id IS NULL THEN
    IF m.grn_ids IS DISTINCT FROM app.lpo_grn_set(NEW.tenant_id, inv.lpo_id)
       OR m.prior_invoice_ids IS DISTINCT FROM app.lpo_prior_invoice_set(NEW.tenant_id, inv.lpo_id, inv.id)
       OR m.qty_tolerance_percent IS DISTINCT FROM settings.qty_tolerance
       OR m.price_tolerance_percent IS DISTINCT FROM settings.price_tolerance
       OR m.block_without_etims IS DISTINCT FROM settings.block_etims THEN
      RAISE EXCEPTION 'An invoice is approved only with a current three-way match'
        USING ERRCODE = '23514';
    END IF;
  ELSIF inv.status IN ('approved', 'partly_settled') AND previous.id IS NOT NULL THEN
    SELECT status INTO previous_payee FROM supplier_payout_versions
      WHERE tenant_id = NEW.tenant_id AND id = previous.payout_version_id;
    IF previous.superseded_at IS NULL AND previous_payee = 'verified' THEN
      RAISE EXCEPTION 'The invoice''s approval is still current' USING ERRCODE = '23514';
    END IF;
    IF NEW.match_id IS DISTINCT FROM previous.match_id THEN
      RAISE EXCEPTION 'A re-approval keeps the approved match' USING ERRCODE = '23514';
    END IF;
    IF previous.superseded_at IS NULL THEN
      UPDATE invoice_payables SET superseded_by = NEW.approved_by, superseded_at = now()
        WHERE tenant_id = previous.tenant_id AND id = previous.id;
    END IF;
  ELSE
    RAISE EXCEPTION 'Only a matched invoice, or one whose payee changed, can be approved'
      USING ERRCODE = '23514';
  END IF;
  IF payee.supplier_id IS DISTINCT FROM inv.supplier_id OR payee.status IS DISTINCT FROM 'verified' THEN
    RAISE EXCEPTION 'An invoice is approved only to the supplier''s verified payout details'
      USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(sum(amount_minor), 0) INTO settled FROM invoice_settlements
    WHERE tenant_id = NEW.tenant_id AND invoice_id = NEW.invoice_id;
  IF NEW.authorised_minor IS DISTINCT FROM inv.total_minor - settled THEN
    RAISE EXCEPTION 'A payable authorises the amount still outstanding' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER invoice_payable_guard BEFORE INSERT OR UPDATE ON "invoice_payables"
  FOR EACH ROW EXECUTE FUNCTION app.guard_invoice_payable();

ALTER TABLE "invoice_settlements" ADD CONSTRAINT "invoice_settlements_check" CHECK (
  amount_minor > 0 AND method IN ('bank_transfer', 'cheque', 'mpesa_b2b', 'other')
  AND char_length(btrim(external_reference)) >= 3 AND char_length(reference_key) >= 3
  AND request_digest ~ '^[0-9a-f]{64}$' AND char_length(idempotency_key) >= 8
);

-- A settlement is recorded by the signed-in user, never the approver, against the active payable
-- of an approved invoice whose payee version is still verified (changed payout details stop
-- payment until a re-approval), never above what is outstanding, and never dated in the future.
CREATE FUNCTION app.guard_invoice_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  inv record;
  payable record;
  on_payable bigint;
  on_invoice bigint;
BEGIN
  SELECT * INTO inv FROM supplier_invoices WHERE tenant_id = NEW.tenant_id AND id = NEW.invoice_id
    FOR UPDATE;
  SELECT p.*, v.status AS payee_status INTO payable FROM invoice_payables p
    JOIN supplier_payout_versions v ON v.tenant_id = p.tenant_id AND v.id = p.payout_version_id
   WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.payable_id;
  IF NEW.recorded_by IS DISTINCT FROM app.current_user_id() OR NEW.recorded_by = payable.approved_by THEN
    RAISE EXCEPTION 'A settlement is recorded by a signed-in person other than the approver'
      USING ERRCODE = '23514';
  END IF;
  IF inv.status NOT IN ('approved', 'partly_settled') OR payable.superseded_at IS NOT NULL
     OR payable.payee_status IS DISTINCT FROM 'verified' THEN
    RAISE EXCEPTION 'Only an approved invoice with a current payee can be settled'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.paid_on > app.business_today() OR NEW.paid_on < inv.invoice_date THEN
    RAISE EXCEPTION 'A settlement is dated between the invoice date and today' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(sum(amount_minor), 0) INTO on_payable FROM invoice_settlements
    WHERE tenant_id = NEW.tenant_id AND payable_id = NEW.payable_id;
  SELECT COALESCE(sum(amount_minor), 0) INTO on_invoice FROM invoice_settlements
    WHERE tenant_id = NEW.tenant_id AND invoice_id = NEW.invoice_id;
  IF on_payable + NEW.amount_minor > payable.authorised_minor
     OR on_invoice + NEW.amount_minor > inv.total_minor THEN
    RAISE EXCEPTION 'A settlement cannot exceed the outstanding balance' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER invoice_settlement_guard BEFORE INSERT ON "invoice_settlements"
  FOR EACH ROW EXECUTE FUNCTION app.guard_invoice_settlement();

-- At commit, the invoice's status follows its settlements (approved, partly settled, settled).
CREATE FUNCTION app.check_invoice_settlement_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  inv record;
  settled bigint;
BEGIN
  SELECT * INTO inv FROM supplier_invoices WHERE tenant_id = NEW.tenant_id AND id = NEW.invoice_id;
  SELECT COALESCE(sum(amount_minor), 0) INTO settled FROM invoice_settlements
    WHERE tenant_id = NEW.tenant_id AND invoice_id = NEW.invoice_id;
  IF inv.status IS DISTINCT FROM (CASE WHEN settled = inv.total_minor THEN 'settled'
                                       ELSE 'partly_settled' END) THEN
    RAISE EXCEPTION 'An invoice''s status must follow its settlements' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER invoice_settlement_state AFTER INSERT ON "invoice_settlements"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_invoice_settlement_state();

-- Documents ------------------------------------------------------------------------------------
ALTER TABLE "procurement_documents" ADD CONSTRAINT "procurement_documents_check" CHECK (
  num_nonnulls(quotation_id, grn_id, invoice_id) = 1
  AND COALESCE(CASE
    WHEN quotation_id IS NOT NULL THEN kind = 'quotation'
    WHEN grn_id IS NOT NULL THEN kind IN ('delivery_note', 'goods')
    ELSE kind = 'invoice'
  END, false)
  AND content_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')
  AND (kind NOT IN ('delivery_note', 'goods') OR content_type <> 'application/pdf')
  AND size_bytes BETWEEN 1 AND 10485760 AND sha256 ~ '^[0-9a-f]{64}$'
  AND scan_status IN ('clean', 'not_scanned')
  AND object_key = 'tenants/' || tenant_id || '/projects/' || project_id || '/procurement/'
    || kind || '/' || id
);

-- Files are attached by the signed-in user to a record of the same project and never change.
CREATE FUNCTION app.guard_procurement_document() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  owner_project uuid;
BEGIN
  IF NEW.uploaded_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A document is uploaded by the signed-in user' USING ERRCODE = '23514';
  END IF;
  IF NEW.quotation_id IS NOT NULL THEN
    SELECT r.project_id INTO owner_project FROM quotations q
      JOIN rfqs r ON r.tenant_id = q.tenant_id AND r.id = q.rfq_id
     WHERE q.tenant_id = NEW.tenant_id AND q.id = NEW.quotation_id;
  ELSIF NEW.grn_id IS NOT NULL THEN
    SELECT project_id INTO owner_project FROM grns WHERE tenant_id = NEW.tenant_id AND id = NEW.grn_id;
  ELSE
    SELECT project_id INTO owner_project FROM supplier_invoices
      WHERE tenant_id = NEW.tenant_id AND id = NEW.invoice_id;
  END IF;
  IF owner_project IS DISTINCT FROM NEW.project_id THEN
    RAISE EXCEPTION 'A document belongs to a record of its project' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER procurement_document_guard BEFORE INSERT ON "procurement_documents"
  FOR EACH ROW EXECUTE FUNCTION app.guard_procurement_document();

-- Row-level security ---------------------------------------------------------------------------
DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['requisitions', 'requisition_lines', 'rfqs', 'rfq_requisitions',
    'rfq_suppliers', 'quotations', 'quotation_lines', 'lpos', 'lpo_lines', 'grns', 'grn_lines',
    'supplier_invoices', 'supplier_invoice_lines', 'three_way_matches', 'invoice_payables',
    'invoice_settlements', 'procurement_documents']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = app.current_tenant_id()) '
      'WITH CHECK (tenant_id = app.current_tenant_id())', target || '_isolation', target);
  END LOOP;
END
$$;

-- The runtime role never deletes procurement history; evidence and money rows are append-only.
-- Draft lines may be deleted (requisition and invoice lines, while their parent is a draft, as
-- the triggers check) and invited suppliers removed while an RFQ is open.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmb_app') THEN
    REVOKE DELETE ON "requisitions", "rfqs", "rfq_requisitions", "quotations", "quotation_lines",
      "lpos", "lpo_lines", "grns", "grn_lines", "supplier_invoices", "three_way_matches",
      "invoice_payables", "invoice_settlements", "procurement_documents" FROM pmb_app;
    REVOKE UPDATE ON "rfq_suppliers", "quotation_lines", "lpo_lines", "grn_lines",
      "invoice_settlements", "procurement_documents" FROM pmb_app;
    REVOKE TRUNCATE, REFERENCES, TRIGGER
      ON "requisitions", "requisition_lines", "rfqs", "rfq_requisitions", "rfq_suppliers",
         "quotations", "quotation_lines", "lpos", "lpo_lines", "grns", "grn_lines",
         "supplier_invoices", "supplier_invoice_lines", "three_way_matches", "invoice_payables",
         "invoice_settlements", "procurement_documents"
      FROM pmb_app;
    GRANT EXECUTE ON FUNCTION app.p2p_match_settings(uuid) TO pmb_app;
    GRANT EXECUTE ON FUNCTION app.business_today() TO pmb_app;
    GRANT EXECUTE ON FUNCTION app.lpo_grn_set(uuid, uuid) TO pmb_app;
    GRANT EXECUTE ON FUNCTION app.lpo_prior_invoice_set(uuid, uuid, uuid) TO pmb_app;
    GRANT EXECUTE ON FUNCTION app.invoice_match_violations(uuid, uuid, uuid[], uuid[], numeric,
      numeric, boolean) TO pmb_app;
  END IF;
END
$$;
REVOKE EXECUTE ON FUNCTION app.p2p_match_settings(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.business_today() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.lpo_grn_set(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.lpo_prior_invoice_set(uuid, uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.invoice_match_violations(uuid, uuid, uuid[], uuid[], numeric,
  numeric, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_requisition() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_requisition_line() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_requisition_lines() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_rfq() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_rfq_requisition() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_rfq_supplier() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_quotation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_quotation_line() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_quotation_totals() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_lpo() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_lpo_line() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_lpo_totals() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_grn() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_grn_line() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_grn_lines() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_supplier_invoice() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_supplier_invoice_line() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_invoice_totals() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_three_way_match() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_invoice_payable() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_invoice_settlement() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_invoice_settlement_state() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_procurement_document() FROM PUBLIC;

COMMIT;
