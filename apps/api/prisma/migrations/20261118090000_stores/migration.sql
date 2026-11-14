-- D5.3 Stores (ARCHITECTURE §4.6, ERD §4–5, WORKFLOWS "Stores", brief §5.2, §5.3 and §15 C/E/G).
-- Enforces, in the database as well as the API:
-- * One store per site (stores_tenant_id_site_id_key); the storekeeper is a company member.
-- * AN APPEND-ONLY STOCK LEDGER in each material's base unit with signed quantities, the value
--   moved and the running balance, numbered per store and material. Entries are never updated or
--   deleted (trigger + revoked privileges); a correction is an entry of the same kind and opposite
--   sign naming the entry it reverses (once).
-- * SERIALISED, CONSISTENT BALANCES: app.post_stock_entry locks the (store, material) balance row
--   (SELECT … FOR UPDATE) before every entry, numbers it, checks the source document, the
--   weighted-average valuation and that stock never goes below zero (negative stock is never
--   allowed, D-45); app.apply_stock_entry moves the balance to the entry's running balance, and
--   app.guard_stock_balance refuses any other balance change. Two simultaneous issues of the last
--   stock therefore cannot both succeed.
-- * Every posted source has its entries at commit: recorded GRNs (receipts at the LPO's net price
--   per base unit), voided GRNs (reversals), issues/returns/wastage and their reversals,
--   transfers (out at dispatch, in at receipt, reversed on cancel) and approved stock takes
--   (adjustments). Existing recorded GRNs are received into a store by this migration (below).
-- * Returns never exceed what is still outstanding on the issue line (issue row lock).
-- * Stock takes are approved by someone who neither created, counted nor submitted them.
-- * Progress measurements and build-up line → material mappings are append-only / stamped.
-- Every table has tenant_id, forced RLS with WITH CHECK and composite (tenant_id, …) foreign keys.
BEGIN;

-- AlterTable
ALTER TABLE "procurement_settings" ADD COLUMN     "consumption_variance_percent" DECIMAL(7,4) NOT NULL DEFAULT 10;

-- CreateTable
CREATE TABLE "stores" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "storekeeper_user_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_balances" (
    "tenant_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "material_id" UUID NOT NULL,
    "quantity" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "value_minor" DECIMAL(30,6) NOT NULL DEFAULT 0,
    "last_seq" BIGINT NOT NULL DEFAULT 0,
    "last_entry_at" TIMESTAMPTZ,

    CONSTRAINT "stock_balances_pkey" PRIMARY KEY ("tenant_id","store_id","material_id")
);

-- CreateTable
CREATE TABLE "stock_ledger_entries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "material_id" UUID NOT NULL,
    "base_unit" VARCHAR(20) NOT NULL,
    "seq" BIGINT NOT NULL,
    "kind" VARCHAR(15) NOT NULL,
    "quantity" DECIMAL(20,6) NOT NULL,
    "unit_cost_minor" DECIMAL(30,6) NOT NULL,
    "value_minor" DECIMAL(30,6) NOT NULL,
    "balance_quantity" DECIMAL(20,6) NOT NULL,
    "balance_value_minor" DECIMAL(30,6) NOT NULL,
    "business_date" DATE NOT NULL,
    "recorded_by" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grn_id" UUID,
    "grn_line_id" UUID,
    "movement_id" UUID,
    "movement_line_id" UUID,
    "transfer_id" UUID,
    "transfer_line_id" UUID,
    "stock_take_id" UUID,
    "stock_take_line_id" UUID,
    "bq_version_id" UUID,
    "bq_item_lineage_id" UUID,
    "gang_id" UUID,
    "reverses_entry_id" UUID,

    CONSTRAINT "stock_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "kind" VARCHAR(10) NOT NULL,
    "number" VARCHAR(20) NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'posted',
    "bq_version_id" UUID,
    "bq_item_lineage_id" UUID,
    "gang_id" UUID,
    "issued_to_name" VARCHAR(100),
    "return_of_id" UUID,
    "wastage_reason" VARCHAR(20),
    "notes" VARCHAR(1000),
    "idempotency_key" VARCHAR(100) NOT NULL,
    "request_digest" CHAR(64) NOT NULL,
    "captured_at" TIMESTAMPTZ NOT NULL,
    "business_date" DATE NOT NULL,
    "source" VARCHAR(10) NOT NULL,
    "line_count" INTEGER NOT NULL,
    "recorded_by" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversed_by" UUID,
    "reversed_at" TIMESTAMPTZ,
    "reversal_reason" VARCHAR(500),

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movement_lines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "movement_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "material_id" UUID NOT NULL,
    "quantity" DECIMAL(20,6) NOT NULL,
    "unit" VARCHAR(20) NOT NULL,
    "base_quantity" DECIMAL(20,6) NOT NULL,
    "conversion" JSONB NOT NULL,
    "return_of_line_id" UUID,

    CONSTRAINT "stock_movement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transfers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" VARCHAR(20) NOT NULL,
    "from_project_id" UUID NOT NULL,
    "from_store_id" UUID NOT NULL,
    "to_project_id" UUID NOT NULL,
    "to_store_id" UUID NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'dispatched',
    "source" VARCHAR(10) NOT NULL,
    "idempotency_key" VARCHAR(100) NOT NULL,
    "request_digest" CHAR(64) NOT NULL,
    "captured_at" TIMESTAMPTZ NOT NULL,
    "dispatched_by" UUID NOT NULL,
    "dispatched_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatch_notes" VARCHAR(1000),
    "receive_idempotency_key" VARCHAR(100),
    "receive_digest" CHAR(64),
    "receive_captured_at" TIMESTAMPTZ,
    "received_by" UUID,
    "received_at" TIMESTAMPTZ,
    "receive_notes" VARCHAR(1000),
    "resolved_by" UUID,
    "resolved_at" TIMESTAMPTZ,
    "resolution_note" VARCHAR(500),
    "cancelled_by" UUID,
    "cancelled_at" TIMESTAMPTZ,
    "cancel_reason" VARCHAR(500),
    "line_count" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "stock_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transfer_lines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "transfer_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "material_id" UUID NOT NULL,
    "quantity" DECIMAL(20,6) NOT NULL,
    "unit" VARCHAR(20) NOT NULL,
    "base_quantity" DECIMAL(20,6) NOT NULL,
    "conversion" JSONB NOT NULL,
    "unit_cost_minor" DECIMAL(30,6) NOT NULL,
    "dispatched_value_minor" DECIMAL(30,6) NOT NULL,
    "received_base_quantity" DECIMAL(20,6),
    "difference_reason" VARCHAR(300),

    CONSTRAINT "stock_transfer_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_takes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "number" VARCHAR(20) NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'draft',
    "notes" VARCHAR(1000),
    "contributors" UUID[] DEFAULT ARRAY[]::UUID[],
    "line_count" INTEGER NOT NULL,
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

    CONSTRAINT "stock_takes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_take_lines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "stock_take_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "material_id" UUID NOT NULL,
    "snapshot_quantity" DECIMAL(20,6) NOT NULL,
    "snapshot_seq" BIGINT NOT NULL,
    "counted_quantity" DECIMAL(20,6),
    "expected_quantity" DECIMAL(20,6),
    "counted_seq" BIGINT,
    "counted_by" UUID,
    "counted_at" TIMESTAMPTZ,
    "count_id" UUID,

    CONSTRAINT "stock_take_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_take_counts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "stock_take_id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "counted_quantity" DECIMAL(20,6) NOT NULL,
    "expected_quantity" DECIMAL(20,6) NOT NULL,
    "counted_seq" BIGINT NOT NULL,
    "idempotency_key" VARCHAR(100) NOT NULL,
    "request_digest" CHAR(64) NOT NULL,
    "captured_at" TIMESTAMPTZ NOT NULL,
    "counted_by" UUID NOT NULL,
    "counted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_take_counts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_reorder_levels" (
    "tenant_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "material_id" UUID NOT NULL,
    "reorder_level" DECIMAL(20,6) NOT NULL,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_reorder_levels_pkey" PRIMARY KEY ("tenant_id","store_id","material_id")
);

-- CreateTable
CREATE TABLE "progress_measurements" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "bq_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "item_lineage_id" UUID NOT NULL,
    "measured_on" DATE NOT NULL,
    "quantity_to_date" DECIMAL(20,4) NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'recorded',
    "note" VARCHAR(500),
    "corrects_id" UUID,
    "correction_reason" VARCHAR(500),
    "measured_by" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "progress_measurements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_buildup_line_materials" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "buildup_id" UUID NOT NULL,
    "buildup_version_id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "material_id" UUID NOT NULL,
    "unit" VARCHAR(20) NOT NULL,
    "base_unit" VARCHAR(20) NOT NULL,
    "base_per_unit" VARCHAR(120) NOT NULL,
    "conversion" JSONB NOT NULL,
    "mapped_by" UUID NOT NULL,
    "mapped_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unmapped_by" UUID,
    "unmapped_at" TIMESTAMPTZ,

    CONSTRAINT "rate_buildup_line_materials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stores_tenant_id_project_id_idx" ON "stores"("tenant_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "stores_tenant_id_id_key" ON "stores"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "stores_tenant_id_project_id_id_key" ON "stores"("tenant_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "stores_tenant_id_site_id_key" ON "stores"("tenant_id", "site_id");

-- CreateIndex
CREATE INDEX "stock_balances_tenant_id_material_id_idx" ON "stock_balances"("tenant_id", "material_id");

-- CreateIndex
CREATE INDEX "stock_ledger_entries_tenant_id_store_id_id_idx" ON "stock_ledger_entries"("tenant_id", "store_id", "id");

-- CreateIndex
CREATE INDEX "stock_ledger_entries_tenant_id_project_id_bq_item_lineage_i_idx" ON "stock_ledger_entries"("tenant_id", "project_id", "bq_item_lineage_id");

-- CreateIndex
CREATE INDEX "stock_ledger_entries_tenant_id_grn_id_idx" ON "stock_ledger_entries"("tenant_id", "grn_id");

-- CreateIndex
CREATE INDEX "stock_ledger_entries_tenant_id_movement_id_idx" ON "stock_ledger_entries"("tenant_id", "movement_id");

-- CreateIndex
CREATE INDEX "stock_ledger_entries_tenant_id_transfer_id_idx" ON "stock_ledger_entries"("tenant_id", "transfer_id");

-- CreateIndex
CREATE INDEX "stock_ledger_entries_tenant_id_stock_take_id_idx" ON "stock_ledger_entries"("tenant_id", "stock_take_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_ledger_entries_tenant_id_id_key" ON "stock_ledger_entries"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_ledger_entries_tenant_id_store_id_material_id_seq_key" ON "stock_ledger_entries"("tenant_id", "store_id", "material_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "stock_ledger_entries_tenant_id_reverses_entry_id_key" ON "stock_ledger_entries"("tenant_id", "reverses_entry_id");

-- CreateIndex
CREATE INDEX "stock_movements_tenant_id_store_id_kind_idx" ON "stock_movements"("tenant_id", "store_id", "kind");

-- CreateIndex
CREATE INDEX "stock_movements_tenant_id_project_id_bq_item_lineage_id_idx" ON "stock_movements"("tenant_id", "project_id", "bq_item_lineage_id");

-- CreateIndex
CREATE INDEX "stock_movements_tenant_id_return_of_id_idx" ON "stock_movements"("tenant_id", "return_of_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_movements_tenant_id_id_key" ON "stock_movements"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_movements_tenant_id_store_id_id_key" ON "stock_movements"("tenant_id", "store_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_movements_tenant_id_number_key" ON "stock_movements"("tenant_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "stock_movements_tenant_id_idempotency_key_key" ON "stock_movements"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "stock_movement_lines_tenant_id_return_of_line_id_idx" ON "stock_movement_lines"("tenant_id", "return_of_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_movement_lines_tenant_id_id_key" ON "stock_movement_lines"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_movement_lines_tenant_id_movement_id_line_no_key" ON "stock_movement_lines"("tenant_id", "movement_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "stock_movement_lines_tenant_id_movement_id_material_id_key" ON "stock_movement_lines"("tenant_id", "movement_id", "material_id");

-- CreateIndex
CREATE INDEX "stock_transfers_tenant_id_from_store_id_status_idx" ON "stock_transfers"("tenant_id", "from_store_id", "status");

-- CreateIndex
CREATE INDEX "stock_transfers_tenant_id_to_store_id_status_idx" ON "stock_transfers"("tenant_id", "to_store_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfers_tenant_id_id_key" ON "stock_transfers"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfers_tenant_id_number_key" ON "stock_transfers"("tenant_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfers_tenant_id_idempotency_key_key" ON "stock_transfers"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfers_tenant_id_receive_idempotency_key_key" ON "stock_transfers"("tenant_id", "receive_idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfer_lines_tenant_id_id_key" ON "stock_transfer_lines"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfer_lines_tenant_id_transfer_id_line_no_key" ON "stock_transfer_lines"("tenant_id", "transfer_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfer_lines_tenant_id_transfer_id_material_id_key" ON "stock_transfer_lines"("tenant_id", "transfer_id", "material_id");

-- CreateIndex
CREATE INDEX "stock_takes_tenant_id_store_id_status_idx" ON "stock_takes"("tenant_id", "store_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "stock_takes_tenant_id_id_key" ON "stock_takes"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_takes_tenant_id_number_key" ON "stock_takes"("tenant_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "stock_take_lines_tenant_id_id_key" ON "stock_take_lines"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_take_lines_tenant_id_stock_take_id_id_key" ON "stock_take_lines"("tenant_id", "stock_take_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_take_lines_tenant_id_stock_take_id_line_no_key" ON "stock_take_lines"("tenant_id", "stock_take_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "stock_take_lines_tenant_id_stock_take_id_material_id_key" ON "stock_take_lines"("tenant_id", "stock_take_id", "material_id");

-- CreateIndex
CREATE INDEX "stock_take_counts_tenant_id_idempotency_key_idx" ON "stock_take_counts"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "stock_take_counts_tenant_id_line_id_idx" ON "stock_take_counts"("tenant_id", "line_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_take_counts_tenant_id_id_key" ON "stock_take_counts"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "progress_measurements_tenant_id_project_id_item_lineage_id__idx" ON "progress_measurements"("tenant_id", "project_id", "item_lineage_id", "measured_on");

-- CreateIndex
CREATE UNIQUE INDEX "progress_measurements_tenant_id_id_key" ON "progress_measurements"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "progress_measurements_tenant_id_corrects_id_key" ON "progress_measurements"("tenant_id", "corrects_id");

-- CreateIndex
CREATE INDEX "rate_buildup_line_materials_tenant_id_line_id_idx" ON "rate_buildup_line_materials"("tenant_id", "line_id");

-- CreateIndex
CREATE INDEX "rate_buildup_line_materials_tenant_id_material_id_idx" ON "rate_buildup_line_materials"("tenant_id", "material_id");

-- CreateIndex
CREATE UNIQUE INDEX "rate_buildup_line_materials_tenant_id_id_key" ON "rate_buildup_line_materials"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "rate_buildup_lines_tenant_id_version_id_id_key" ON "rate_buildup_lines"("tenant_id", "version_id", "id");

-- AddForeignKey
ALTER TABLE "stores" ADD CONSTRAINT "stores_tenant_id_project_id_site_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "site_id") REFERENCES "sites"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_tenant_id_store_id_fkey" FOREIGN KEY ("tenant_id", "store_id") REFERENCES "stores"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_tenant_id_material_id_fkey" FOREIGN KEY ("tenant_id", "material_id") REFERENCES "materials"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledger_entries" ADD CONSTRAINT "stock_ledger_entries_tenant_id_project_id_store_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "store_id") REFERENCES "stores"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledger_entries" ADD CONSTRAINT "stock_ledger_entries_tenant_id_store_id_material_id_fkey" FOREIGN KEY ("tenant_id", "store_id", "material_id") REFERENCES "stock_balances"("tenant_id", "store_id", "material_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledger_entries" ADD CONSTRAINT "stock_ledger_entries_tenant_id_material_id_fkey" FOREIGN KEY ("tenant_id", "material_id") REFERENCES "materials"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledger_entries" ADD CONSTRAINT "stock_ledger_entries_tenant_id_grn_id_fkey" FOREIGN KEY ("tenant_id", "grn_id") REFERENCES "grns"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledger_entries" ADD CONSTRAINT "stock_ledger_entries_tenant_id_grn_line_id_fkey" FOREIGN KEY ("tenant_id", "grn_line_id") REFERENCES "grn_lines"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledger_entries" ADD CONSTRAINT "stock_ledger_entries_tenant_id_movement_id_fkey" FOREIGN KEY ("tenant_id", "movement_id") REFERENCES "stock_movements"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledger_entries" ADD CONSTRAINT "stock_ledger_entries_tenant_id_movement_line_id_fkey" FOREIGN KEY ("tenant_id", "movement_line_id") REFERENCES "stock_movement_lines"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledger_entries" ADD CONSTRAINT "stock_ledger_entries_tenant_id_transfer_id_fkey" FOREIGN KEY ("tenant_id", "transfer_id") REFERENCES "stock_transfers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledger_entries" ADD CONSTRAINT "stock_ledger_entries_tenant_id_transfer_line_id_fkey" FOREIGN KEY ("tenant_id", "transfer_line_id") REFERENCES "stock_transfer_lines"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledger_entries" ADD CONSTRAINT "stock_ledger_entries_tenant_id_stock_take_id_fkey" FOREIGN KEY ("tenant_id", "stock_take_id") REFERENCES "stock_takes"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledger_entries" ADD CONSTRAINT "stock_ledger_entries_tenant_id_stock_take_line_id_fkey" FOREIGN KEY ("tenant_id", "stock_take_line_id") REFERENCES "stock_take_lines"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledger_entries" ADD CONSTRAINT "stock_ledger_entries_tenant_id_bq_version_id_bq_item_linea_fkey" FOREIGN KEY ("tenant_id", "bq_version_id", "bq_item_lineage_id") REFERENCES "bq_items"("tenant_id", "version_id", "lineage_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledger_entries" ADD CONSTRAINT "stock_ledger_entries_tenant_id_project_id_gang_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "gang_id") REFERENCES "gangs"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledger_entries" ADD CONSTRAINT "stock_ledger_entries_tenant_id_reverses_entry_id_fkey" FOREIGN KEY ("tenant_id", "reverses_entry_id") REFERENCES "stock_ledger_entries"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_project_id_store_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "store_id") REFERENCES "stores"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_bq_version_id_bq_item_lineage_id_fkey" FOREIGN KEY ("tenant_id", "bq_version_id", "bq_item_lineage_id") REFERENCES "bq_items"("tenant_id", "version_id", "lineage_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_project_id_gang_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "gang_id") REFERENCES "gangs"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_store_id_return_of_id_fkey" FOREIGN KEY ("tenant_id", "store_id", "return_of_id") REFERENCES "stock_movements"("tenant_id", "store_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movement_lines" ADD CONSTRAINT "stock_movement_lines_tenant_id_movement_id_fkey" FOREIGN KEY ("tenant_id", "movement_id") REFERENCES "stock_movements"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movement_lines" ADD CONSTRAINT "stock_movement_lines_tenant_id_material_id_fkey" FOREIGN KEY ("tenant_id", "material_id") REFERENCES "materials"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movement_lines" ADD CONSTRAINT "stock_movement_lines_tenant_id_return_of_line_id_fkey" FOREIGN KEY ("tenant_id", "return_of_line_id") REFERENCES "stock_movement_lines"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_tenant_id_from_project_id_from_store_id_fkey" FOREIGN KEY ("tenant_id", "from_project_id", "from_store_id") REFERENCES "stores"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_tenant_id_to_project_id_to_store_id_fkey" FOREIGN KEY ("tenant_id", "to_project_id", "to_store_id") REFERENCES "stores"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_tenant_id_transfer_id_fkey" FOREIGN KEY ("tenant_id", "transfer_id") REFERENCES "stock_transfers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_tenant_id_material_id_fkey" FOREIGN KEY ("tenant_id", "material_id") REFERENCES "materials"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_takes" ADD CONSTRAINT "stock_takes_tenant_id_project_id_store_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "store_id") REFERENCES "stores"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_take_lines" ADD CONSTRAINT "stock_take_lines_tenant_id_stock_take_id_fkey" FOREIGN KEY ("tenant_id", "stock_take_id") REFERENCES "stock_takes"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_take_lines" ADD CONSTRAINT "stock_take_lines_tenant_id_material_id_fkey" FOREIGN KEY ("tenant_id", "material_id") REFERENCES "materials"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_take_counts" ADD CONSTRAINT "stock_take_counts_tenant_id_stock_take_id_fkey" FOREIGN KEY ("tenant_id", "stock_take_id") REFERENCES "stock_takes"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_take_counts" ADD CONSTRAINT "stock_take_counts_tenant_id_stock_take_id_line_id_fkey" FOREIGN KEY ("tenant_id", "stock_take_id", "line_id") REFERENCES "stock_take_lines"("tenant_id", "stock_take_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reorder_levels" ADD CONSTRAINT "stock_reorder_levels_tenant_id_store_id_fkey" FOREIGN KEY ("tenant_id", "store_id") REFERENCES "stores"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reorder_levels" ADD CONSTRAINT "stock_reorder_levels_tenant_id_material_id_fkey" FOREIGN KEY ("tenant_id", "material_id") REFERENCES "materials"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "progress_measurements" ADD CONSTRAINT "progress_measurements_tenant_id_project_id_bq_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "bq_id") REFERENCES "bqs"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "progress_measurements" ADD CONSTRAINT "progress_measurements_tenant_id_bq_id_version_id_fkey" FOREIGN KEY ("tenant_id", "bq_id", "version_id") REFERENCES "bq_versions"("tenant_id", "bq_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "progress_measurements" ADD CONSTRAINT "progress_measurements_tenant_id_version_id_item_lineage_id_fkey" FOREIGN KEY ("tenant_id", "version_id", "item_lineage_id") REFERENCES "bq_items"("tenant_id", "version_id", "lineage_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "progress_measurements" ADD CONSTRAINT "progress_measurements_tenant_id_corrects_id_fkey" FOREIGN KEY ("tenant_id", "corrects_id") REFERENCES "progress_measurements"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_buildup_line_materials" ADD CONSTRAINT "rate_buildup_line_materials_tenant_id_buildup_id_buildup_v_fkey" FOREIGN KEY ("tenant_id", "buildup_id", "buildup_version_id") REFERENCES "rate_buildup_versions"("tenant_id", "buildup_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_buildup_line_materials" ADD CONSTRAINT "rate_buildup_line_materials_tenant_id_buildup_version_id_l_fkey" FOREIGN KEY ("tenant_id", "buildup_version_id", "line_id") REFERENCES "rate_buildup_lines"("tenant_id", "version_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_buildup_line_materials" ADD CONSTRAINT "rate_buildup_line_materials_tenant_id_material_id_fkey" FOREIGN KEY ("tenant_id", "material_id") REFERENCES "materials"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Settings (CONFIGURATION §5) ------------------------------------------------------------------
ALTER TABLE "procurement_settings" ADD CONSTRAINT "procurement_settings_stores_check" CHECK (
  consumption_variance_percent BETWEEN 0 AND 1000
);

-- Existing GRNs ---------------------------------------------------------------------------------
-- Recorded GRNs are received into the store of their site (or, when a GRN names no site, of its
-- project's only site), valued at the LPO line's net price per base unit, in receipt order. GRNs
-- of projects with several sites and no site on the GRN cannot be placed and are left out
-- (IMPLEMENTATION_STATUS D5.3; their goods enter a store through a stock take). Voided GRNs net
-- to nothing and are skipped. This runs before the triggers below exist, as the schema owner, so
-- FORCE ROW LEVEL SECURITY is lifted for the tables read here and restored afterwards.
ALTER TABLE "grns" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "grn_lines" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "lpo_lines" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "sites" NO FORCE ROW LEVEL SECURITY;

CREATE TEMPORARY TABLE d53_grn_sites ON COMMIT DROP AS
SELECT g.tenant_id, g.id AS grn_id, g.project_id, g.recorded_by, g.received_at,
       COALESCE(g.site_id, only_site.site_id) AS site_id
  FROM grns g
  LEFT JOIN LATERAL (
    SELECT (array_agg(s.id))[1] AS site_id FROM sites s
     WHERE s.tenant_id = g.tenant_id AND s.project_id = g.project_id
    HAVING count(*) = 1
  ) only_site ON true
 WHERE g.status = 'recorded';

INSERT INTO stores (id, tenant_id, project_id, site_id, name, created_by, updated_by, created_at,
                    updated_at)
SELECT uuidv7(), s.tenant_id, s.project_id, s.id, left(s.name || ' store', 120), first.recorded_by,
       first.recorded_by, now(), now()
  FROM sites s
  JOIN LATERAL (
    SELECT x.recorded_by FROM d53_grn_sites x
     WHERE x.tenant_id = s.tenant_id AND x.site_id = s.id
     ORDER BY x.received_at LIMIT 1
  ) first ON true;

CREATE TEMPORARY TABLE d53_receipts ON COMMIT DROP AS
SELECT x.tenant_id, st.project_id, st.id AS store_id, ll.material_id, ll.base_unit, gl.grn_id,
       gl.id AS grn_line_id, gl.line_no, gl.accepted_base_quantity AS quantity,
       ll.net_unit_price_base_minor AS unit_cost,
       round(gl.accepted_base_quantity * ll.net_unit_price_base_minor, 6) AS value,
       x.recorded_by, x.received_at
  FROM d53_grn_sites x
  JOIN stores st ON st.tenant_id = x.tenant_id AND st.site_id = x.site_id
  JOIN grn_lines gl ON gl.tenant_id = x.tenant_id AND gl.grn_id = x.grn_id
  JOIN lpo_lines ll ON ll.tenant_id = gl.tenant_id AND ll.id = gl.lpo_line_id
 WHERE gl.accepted_base_quantity > 0;

INSERT INTO stock_balances (tenant_id, store_id, material_id, quantity, value_minor, last_seq,
                            last_entry_at)
SELECT tenant_id, store_id, material_id, sum(quantity), sum(value), count(*), max(received_at)
  FROM d53_receipts GROUP BY tenant_id, store_id, material_id;

INSERT INTO stock_ledger_entries (id, tenant_id, project_id, store_id, material_id, base_unit, seq,
  kind, quantity, unit_cost_minor, value_minor, balance_quantity, balance_value_minor,
  business_date, recorded_by, recorded_at, grn_id, grn_line_id)
SELECT uuidv7(received_at - clock_timestamp()), tenant_id, project_id, store_id, material_id,
       base_unit, row_number() OVER running, 'receipt', quantity, unit_cost, value,
       sum(quantity) OVER running, sum(value) OVER running,
       (received_at AT TIME ZONE 'Africa/Nairobi')::date, recorded_by, received_at, grn_id,
       grn_line_id
  FROM d53_receipts
WINDOW running AS (PARTITION BY tenant_id, store_id, material_id
                   ORDER BY received_at, grn_id, line_no ROWS UNBOUNDED PRECEDING);

ALTER TABLE "grns" FORCE ROW LEVEL SECURITY;
ALTER TABLE "grn_lines" FORCE ROW LEVEL SECURITY;
ALTER TABLE "lpo_lines" FORCE ROW LEVEL SECURITY;
ALTER TABLE "sites" FORCE ROW LEVEL SECURITY;

-- Stores ----------------------------------------------------------------------------------------
ALTER TABLE "stores" ADD CONSTRAINT "stores_check" CHECK (
  char_length(btrim(name)) >= 2 AND version >= 1
);

-- A store keeps its company, project and site; its storekeeper is a member of the company.
CREATE FUNCTION app.guard_store() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.site_id IS DISTINCT FROM OLD.site_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'A store keeps its project and site' USING ERRCODE = '23514';
  END IF;
  IF NEW.storekeeper_user_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.storekeeper_user_id IS DISTINCT FROM OLD.storekeeper_user_id)
     AND NOT EXISTS (SELECT 1 FROM memberships WHERE tenant_id = NEW.tenant_id
                       AND user_id = NEW.storekeeper_user_id) THEN
    RAISE EXCEPTION 'A storekeeper is a member of the company' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER store_guard BEFORE INSERT OR UPDATE ON "stores"
  FOR EACH ROW EXECUTE FUNCTION app.guard_store();

-- Balances --------------------------------------------------------------------------------------
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_check" CHECK (
  quantity >= 0 AND value_minor >= 0 AND (quantity > 0 OR value_minor = 0) AND last_seq >= 0
);

-- A balance starts empty and then only follows the ledger: each change moves it to the running
-- balance of the next entry (seq + 1) of the same store and material.
CREATE FUNCTION app.guard_stock_balance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.quantity <> 0 OR NEW.value_minor <> 0 OR NEW.last_seq <> 0 OR NEW.last_entry_at IS NOT NULL
    THEN
      RAISE EXCEPTION 'A stock balance starts empty' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.store_id IS DISTINCT FROM OLD.store_id
     OR NEW.material_id IS DISTINCT FROM OLD.material_id OR NEW.last_seq <> OLD.last_seq + 1
     OR NOT EXISTS (
       SELECT 1 FROM stock_ledger_entries e
        WHERE e.tenant_id = NEW.tenant_id AND e.store_id = NEW.store_id
          AND e.material_id = NEW.material_id AND e.seq = NEW.last_seq
          AND e.balance_quantity = NEW.quantity AND e.balance_value_minor = NEW.value_minor
          AND e.recorded_at = NEW.last_entry_at
     ) THEN
    RAISE EXCEPTION 'A stock balance changes only with its next ledger entry' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER stock_balance_guard BEFORE INSERT OR UPDATE ON "stock_balances"
  FOR EACH ROW EXECUTE FUNCTION app.guard_stock_balance();

-- The ledger ------------------------------------------------------------------------------------
ALTER TABLE "stock_ledger_entries" ADD CONSTRAINT "stock_ledger_entries_check" CHECK (
  kind IN ('receipt', 'issue', 'return', 'transfer_out', 'transfer_in', 'wastage', 'adjustment')
  AND quantity <> 0 AND unit_cost_minor >= 0 AND sign(value_minor) IN (0, sign(quantity))
  AND balance_quantity >= 0 AND balance_value_minor >= 0
  AND (balance_quantity > 0 OR balance_value_minor = 0) AND seq >= 1
  AND (grn_id IS NULL) = (grn_line_id IS NULL)
  AND (movement_id IS NULL) = (movement_line_id IS NULL)
  AND (transfer_id IS NULL) = (transfer_line_id IS NULL)
  AND (stock_take_id IS NULL) = (stock_take_line_id IS NULL)
  AND num_nonnulls(grn_id, movement_id, transfer_id, stock_take_id) = 1
  AND (bq_version_id IS NULL) = (bq_item_lineage_id IS NULL)
  AND COALESCE(CASE kind
    WHEN 'receipt' THEN grn_id IS NOT NULL
    WHEN 'transfer_out' THEN transfer_id IS NOT NULL
    WHEN 'transfer_in' THEN transfer_id IS NOT NULL AND reverses_entry_id IS NULL
    WHEN 'adjustment' THEN stock_take_id IS NOT NULL AND reverses_entry_id IS NULL
    ELSE movement_id IS NOT NULL
  END, false)
  AND (reverses_entry_id IS NOT NULL OR kind = 'adjustment'
       OR (kind IN ('receipt', 'return', 'transfer_in') AND quantity > 0)
       OR (kind IN ('issue', 'transfer_out', 'wastage') AND quantity < 0))
  AND ((bq_item_lineage_id IS NULL AND gang_id IS NULL) OR kind IN ('issue', 'return'))
);
-- One posting per source line (its correction aside).
CREATE UNIQUE INDEX "stock_ledger_entries_grn_line_once" ON "stock_ledger_entries"
  ("tenant_id", "grn_line_id") WHERE grn_line_id IS NOT NULL AND reverses_entry_id IS NULL;
CREATE UNIQUE INDEX "stock_ledger_entries_movement_line_once" ON "stock_ledger_entries"
  ("tenant_id", "movement_line_id") WHERE movement_line_id IS NOT NULL AND reverses_entry_id IS NULL;
CREATE UNIQUE INDEX "stock_ledger_entries_transfer_line_once" ON "stock_ledger_entries"
  ("tenant_id", "transfer_line_id", "kind") WHERE transfer_line_id IS NOT NULL AND reverses_entry_id IS NULL;
CREATE UNIQUE INDEX "stock_ledger_entries_stock_take_line_once" ON "stock_ledger_entries"
  ("tenant_id", "stock_take_line_id") WHERE stock_take_line_id IS NOT NULL;

-- Checks an entry against its source document (what moved, where, how much and at what cost).
CREATE FUNCTION app.check_stock_entry_source(entry stock_ledger_entries, store_site uuid)
  RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  src record;
  issue_cost numeric;
  reversal boolean := entry.reverses_entry_id IS NOT NULL;
BEGIN
  IF entry.kind = 'receipt' THEN
    SELECT g.status, g.project_id, g.site_id, gl.accepted_base_quantity, ll.material_id,
           ll.net_unit_price_base_minor
      INTO src
      FROM grn_lines gl
      JOIN grns g ON g.tenant_id = gl.tenant_id AND g.id = gl.grn_id
      JOIN lpo_lines ll ON ll.tenant_id = gl.tenant_id AND ll.id = gl.lpo_line_id
     WHERE gl.tenant_id = entry.tenant_id AND gl.id = entry.grn_line_id AND gl.grn_id = entry.grn_id;
    IF NOT FOUND OR src.material_id <> entry.material_id OR src.project_id <> entry.project_id
       OR (src.site_id IS NOT NULL AND src.site_id <> store_site)
       OR src.status <> (CASE WHEN reversal THEN 'voided' ELSE 'recorded' END)
       OR (NOT reversal AND (entry.quantity <> src.accepted_base_quantity
                             OR entry.unit_cost_minor <> src.net_unit_price_base_minor)) THEN
      RAISE EXCEPTION 'A receipt posts its GRN line at the LPO''s net price per base unit'
        USING ERRCODE = '23514';
    END IF;
  ELSIF entry.kind IN ('issue', 'return', 'wastage') THEN
    SELECT m.kind, m.status, m.store_id, m.bq_version_id, m.bq_item_lineage_id, m.gang_id,
           l.material_id, l.base_quantity, l.return_of_line_id
      INTO src
      FROM stock_movement_lines l
      JOIN stock_movements m ON m.tenant_id = l.tenant_id AND m.id = l.movement_id
     WHERE l.tenant_id = entry.tenant_id AND l.id = entry.movement_line_id
       AND l.movement_id = entry.movement_id;
    IF NOT FOUND OR src.kind <> entry.kind OR src.store_id <> entry.store_id
       OR src.material_id <> entry.material_id OR abs(entry.quantity) <> src.base_quantity
       OR (src.bq_version_id, src.bq_item_lineage_id, src.gang_id)
          IS DISTINCT FROM (entry.bq_version_id, entry.bq_item_lineage_id, entry.gang_id)
       OR src.status <> (CASE WHEN reversal THEN 'reversed' ELSE 'posted' END) THEN
      RAISE EXCEPTION 'A stock movement posts its own lines' USING ERRCODE = '23514';
    END IF;
    IF entry.kind = 'return' AND NOT reversal THEN
      SELECT e.unit_cost_minor INTO issue_cost FROM stock_ledger_entries e
       WHERE e.tenant_id = entry.tenant_id AND e.movement_line_id = src.return_of_line_id
         AND e.reverses_entry_id IS NULL;
      IF issue_cost IS DISTINCT FROM entry.unit_cost_minor THEN
        RAISE EXCEPTION 'A return comes back at its issue''s unit cost' USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSIF entry.kind IN ('transfer_out', 'transfer_in') THEN
    SELECT t.status, t.from_store_id, t.to_store_id, l.material_id, l.base_quantity,
           l.unit_cost_minor, l.dispatched_value_minor, l.received_base_quantity
      INTO src
      FROM stock_transfer_lines l
      JOIN stock_transfers t ON t.tenant_id = l.tenant_id AND t.id = l.transfer_id
     WHERE l.tenant_id = entry.tenant_id AND l.id = entry.transfer_line_id
       AND l.transfer_id = entry.transfer_id;
    IF NOT FOUND OR src.material_id <> entry.material_id THEN
      RAISE EXCEPTION 'A transfer posts its own lines' USING ERRCODE = '23514';
    END IF;
    IF entry.kind = 'transfer_out' AND (entry.store_id <> src.from_store_id
       OR src.status <> (CASE WHEN reversal THEN 'cancelled' ELSE 'dispatched' END)
       OR (NOT reversal AND (entry.quantity <> -src.base_quantity
           OR entry.value_minor <> -src.dispatched_value_minor
           OR entry.unit_cost_minor <> src.unit_cost_minor))) THEN
      RAISE EXCEPTION 'A transfer leaves its source store as dispatched' USING ERRCODE = '23514';
    END IF;
    IF entry.kind = 'transfer_in' AND (entry.store_id <> src.to_store_id
       OR src.status NOT IN ('received', 'disputed')
       OR entry.quantity IS DISTINCT FROM src.received_base_quantity
       OR entry.unit_cost_minor <> src.unit_cost_minor) THEN
      RAISE EXCEPTION 'A transfer arrives in its destination store as received' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT s.status, s.store_id, l.material_id, l.counted_quantity, l.expected_quantity
      INTO src
      FROM stock_take_lines l
      JOIN stock_takes s ON s.tenant_id = l.tenant_id AND s.id = l.stock_take_id
     WHERE l.tenant_id = entry.tenant_id AND l.id = entry.stock_take_line_id
       AND l.stock_take_id = entry.stock_take_id;
    IF NOT FOUND OR src.status <> 'approved' OR src.store_id <> entry.store_id
       OR src.material_id <> entry.material_id
       OR entry.quantity IS DISTINCT FROM src.counted_quantity - src.expected_quantity THEN
      RAISE EXCEPTION 'An adjustment posts an approved stock-take variance' USING ERRCODE = '23514';
    END IF;
  END IF;
END
$$;

-- Before every entry: the recorder is the signed-in user, the base unit is the material's, the
-- (store, material) balance row is locked, a correction mirrors its original, the value follows
-- the weighted-average rules (packages/domain stores/valuation.ts) and stock never goes below
-- zero. The entry gets the next number and the running balance; app.apply_stock_entry then
-- moves the balance.
CREATE FUNCTION app.post_stock_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bal stock_balances%ROWTYPE;
  orig stock_ledger_entries%ROWTYPE;
  store_site uuid;
  material_base text;
  magnitude numeric := abs(NEW.quantity);
BEGIN
  IF NEW.recorded_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A stock entry is recorded by the signed-in user' USING ERRCODE = '23514';
  END IF;
  SELECT base_unit INTO material_base FROM materials
   WHERE tenant_id = NEW.tenant_id AND id = NEW.material_id;
  IF material_base IS DISTINCT FROM NEW.base_unit THEN
    RAISE EXCEPTION 'Stock is kept in the material''s base unit' USING ERRCODE = '23514';
  END IF;
  SELECT site_id INTO store_site FROM stores
   WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id AND id = NEW.store_id;
  INSERT INTO stock_balances (tenant_id, store_id, material_id)
    VALUES (NEW.tenant_id, NEW.store_id, NEW.material_id) ON CONFLICT DO NOTHING;
  SELECT * INTO bal FROM stock_balances
   WHERE tenant_id = NEW.tenant_id AND store_id = NEW.store_id AND material_id = NEW.material_id
     FOR UPDATE;
  IF NEW.reverses_entry_id IS NOT NULL THEN
    SELECT * INTO orig FROM stock_ledger_entries
     WHERE tenant_id = NEW.tenant_id AND id = NEW.reverses_entry_id;
    IF NOT FOUND OR orig.reverses_entry_id IS NOT NULL OR orig.kind <> NEW.kind
       OR orig.store_id <> NEW.store_id OR orig.material_id <> NEW.material_id
       OR NEW.quantity <> -orig.quantity
       OR (orig.grn_line_id, orig.movement_line_id, orig.transfer_line_id)
          IS DISTINCT FROM (NEW.grn_line_id, NEW.movement_line_id, NEW.transfer_line_id) THEN
      RAISE EXCEPTION 'A correction mirrors the entry it reverses' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.quantity > 0 THEN
    IF NEW.reverses_entry_id IS NOT NULL THEN
      IF NEW.value_minor <> -orig.value_minor OR NEW.unit_cost_minor <> orig.unit_cost_minor THEN
        RAISE EXCEPTION 'A reversed outflow returns the value it took' USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.value_minor <> round(NEW.quantity * NEW.unit_cost_minor, 6) THEN
      RAISE EXCEPTION 'An inflow is valued at quantity × unit cost' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF magnitude > bal.quantity THEN
      RAISE EXCEPTION 'Stock cannot go below zero' USING ERRCODE = '23514';
    END IF;
    IF magnitude = bal.quantity THEN
      IF NEW.value_minor <> -bal.value_minor THEN
        RAISE EXCEPTION 'Emptying a position takes all of its value' USING ERRCODE = '23514';
      END IF;
    ELSIF abs(abs(NEW.value_minor) * bal.quantity - magnitude * bal.value_minor) * 2
          > bal.quantity * 0.000001 THEN
      RAISE EXCEPTION 'An outflow is valued at the weighted average cost' USING ERRCODE = '23514';
    END IF;
    IF abs(NEW.unit_cost_minor * bal.quantity - bal.value_minor) * 2 > bal.quantity * 0.000001 THEN
      RAISE EXCEPTION 'An outflow''s unit cost is the weighted average' USING ERRCODE = '23514';
    END IF;
  END IF;
  PERFORM app.check_stock_entry_source(NEW, store_site);
  NEW.seq := bal.last_seq + 1;
  NEW.balance_quantity := bal.quantity + NEW.quantity;
  NEW.balance_value_minor := bal.value_minor + NEW.value_minor;
  NEW.business_date := app.business_today();
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END
$$;
CREATE TRIGGER stock_entry_post BEFORE INSERT ON "stock_ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION app.post_stock_entry();

CREATE FUNCTION app.apply_stock_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE stock_balances
     SET quantity = NEW.balance_quantity, value_minor = NEW.balance_value_minor,
         last_seq = NEW.seq, last_entry_at = NEW.recorded_at
   WHERE tenant_id = NEW.tenant_id AND store_id = NEW.store_id AND material_id = NEW.material_id;
  RETURN NULL;
END
$$;
CREATE TRIGGER stock_entry_apply AFTER INSERT ON "stock_ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION app.apply_stock_entry();

CREATE FUNCTION app.refuse_stock_entry_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'The stock ledger is append-only: post a correcting entry instead'
    USING ERRCODE = '23514';
END
$$;
CREATE TRIGGER stock_entry_append_only BEFORE UPDATE OR DELETE ON "stock_ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION app.refuse_stock_entry_change();

-- Issues, returns and wastage ---------------------------------------------------------------------
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_check" CHECK (
  kind IN ('issue', 'return', 'wastage') AND status IN ('posted', 'reversed')
  AND number ~ CASE kind WHEN 'issue' THEN '^ISS-[0-9]{4,12}$' WHEN 'return' THEN '^RTN-[0-9]{4,12}$'
                         ELSE '^WST-[0-9]{4,12}$' END
  AND line_count BETWEEN 1 AND 50
  AND (status = 'reversed') = (reversed_at IS NOT NULL)
  AND (reversed_at IS NULL OR (reversed_by IS NOT NULL
       AND COALESCE(char_length(btrim(reversal_reason)), 0) >= 3))
  AND (bq_version_id IS NULL) = (bq_item_lineage_id IS NULL)
  AND COALESCE(CASE kind
    WHEN 'issue' THEN (bq_item_lineage_id IS NOT NULL OR gang_id IS NOT NULL)
      AND char_length(btrim(issued_to_name)) >= 2 AND return_of_id IS NULL AND wastage_reason IS NULL
    WHEN 'return' THEN return_of_id IS NOT NULL AND wastage_reason IS NULL
    ELSE wastage_reason IN ('damaged', 'expired', 'spilled', 'weather', 'theft_suspected', 'other')
      AND return_of_id IS NULL AND bq_item_lineage_id IS NULL AND gang_id IS NULL
      AND issued_to_name IS NULL AND char_length(btrim(notes)) >= 3
  END, false)
  AND source IN ('web', 'site_app')
  AND request_digest ~ '^[0-9a-f]{64}$' AND char_length(idempotency_key) >= 8
);

-- A movement is recorded by the signed-in user; an issue names an item of an approved BQ version
-- of the store's project; a return names a posted issue of the same store and carries its BQ item
-- and gang. Afterwards it only changes to `reversed` (by the signed-in user, with a reason); an
-- issue is reversed only after its returns are.
CREATE FUNCTION app.guard_stock_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bq_ok boolean;
  original record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'posted' OR NEW.recorded_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'A stock movement is posted by the signed-in user' USING ERRCODE = '23514';
    END IF;
    NEW.business_date := app.business_today();
    IF NEW.bq_version_id IS NOT NULL THEN
      SELECT v.status = 'approved' AND v.project_id = NEW.project_id INTO bq_ok
        FROM bq_versions v WHERE v.tenant_id = NEW.tenant_id AND v.id = NEW.bq_version_id;
      IF NOT COALESCE(bq_ok, false) THEN
        RAISE EXCEPTION 'Material is issued to an item of an approved BQ version of the project'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NEW.kind = 'return' THEN
      SELECT * INTO original FROM stock_movements
       WHERE tenant_id = NEW.tenant_id AND store_id = NEW.store_id AND id = NEW.return_of_id
         FOR UPDATE;
      IF NOT FOUND OR original.kind <> 'issue' OR original.status <> 'posted'
         OR (original.bq_version_id, original.bq_item_lineage_id, original.gang_id)
            IS DISTINCT FROM (NEW.bq_version_id, NEW.bq_item_lineage_id, NEW.gang_id) THEN
        RAISE EXCEPTION 'A return names a posted issue of the same store' USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'reversed_by' - 'reversed_at' - 'reversal_reason')
     IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'reversed_by' - 'reversed_at' - 'reversal_reason')
     OR OLD.status <> 'posted' OR NEW.status <> 'reversed'
     OR NEW.reversed_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A stock movement never changes; it can only be reversed' USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'issue' AND EXISTS (
    SELECT 1 FROM stock_movements WHERE tenant_id = NEW.tenant_id AND return_of_id = NEW.id
      AND status = 'posted'
  ) THEN
    RAISE EXCEPTION 'Reverse an issue''s returns before the issue' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER stock_movement_guard BEFORE INSERT OR UPDATE ON "stock_movements"
  FOR EACH ROW EXECUTE FUNCTION app.guard_stock_movement();

ALTER TABLE "stock_movement_lines" ADD CONSTRAINT "stock_movement_lines_check" CHECK (
  line_no BETWEEN 1 AND 50 AND quantity > 0 AND base_quantity > 0
);

-- Lines are written with their movement. A return line names a line of the returned issue with
-- the same material and never takes more than is still outstanding on it (the issue row is
-- locked by the return's guard, so two returns of the same issue are serialised).
CREATE FUNCTION app.guard_stock_movement_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent record;
  issued record;
  returned numeric;
BEGIN
  SELECT kind, status, return_of_id INTO parent FROM stock_movements
   WHERE tenant_id = NEW.tenant_id AND id = NEW.movement_id;
  IF parent.status IS DISTINCT FROM 'posted' THEN
    RAISE EXCEPTION 'Lines are added only to a posted movement' USING ERRCODE = '23514';
  END IF;
  IF (parent.kind = 'return') <> (NEW.return_of_line_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Only a return line names an issue line' USING ERRCODE = '23514';
  END IF;
  IF parent.kind = 'return' THEN
    SELECT movement_id, material_id, base_quantity INTO issued FROM stock_movement_lines
     WHERE tenant_id = NEW.tenant_id AND id = NEW.return_of_line_id;
    IF issued.movement_id IS DISTINCT FROM parent.return_of_id
       OR issued.material_id IS DISTINCT FROM NEW.material_id THEN
      RAISE EXCEPTION 'A return line names a line of the returned issue' USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(sum(l.base_quantity), 0) INTO returned FROM stock_movement_lines l
      JOIN stock_movements m ON m.tenant_id = l.tenant_id AND m.id = l.movement_id
     WHERE l.tenant_id = NEW.tenant_id AND l.return_of_line_id = NEW.return_of_line_id
       AND m.status = 'posted' AND l.id <> NEW.id;
    IF returned + NEW.base_quantity > issued.base_quantity THEN
      RAISE EXCEPTION 'A return cannot exceed what is still outstanding on the issue'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER stock_movement_line_guard BEFORE INSERT ON "stock_movement_lines"
  FOR EACH ROW EXECUTE FUNCTION app.guard_stock_movement_line();

-- At commit: the line count matches, every line is posted once and, once reversed, every posting
-- is reversed.
CREATE FUNCTION app.check_stock_movement_postings() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target record;
BEGIN
  SELECT * INTO target FROM stock_movements WHERE tenant_id = NEW.tenant_id AND id = NEW.id;
  IF target.line_count IS DISTINCT FROM (SELECT count(*)::int FROM stock_movement_lines
       WHERE tenant_id = target.tenant_id AND movement_id = target.id)
     OR EXISTS (
       SELECT 1 FROM stock_movement_lines l
        WHERE l.tenant_id = target.tenant_id AND l.movement_id = target.id
          AND (SELECT count(*) FROM stock_ledger_entries e WHERE e.tenant_id = l.tenant_id
                 AND e.movement_line_id = l.id AND e.reverses_entry_id IS NULL) <> 1
     )
     OR (target.status = 'reversed' AND EXISTS (
       SELECT 1 FROM stock_ledger_entries e
        WHERE e.tenant_id = target.tenant_id AND e.movement_id = target.id
          AND e.reverses_entry_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM stock_ledger_entries r
                           WHERE r.tenant_id = e.tenant_id AND r.reverses_entry_id = e.id)
     )) THEN
    RAISE EXCEPTION 'A stock movement''s lines are posted (and reversed) with it'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER stock_movement_postings AFTER INSERT OR UPDATE ON "stock_movements"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_stock_movement_postings();

-- Transfers -------------------------------------------------------------------------------------
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_check" CHECK (
  number ~ '^TRF-[0-9]{4,12}$' AND from_store_id <> to_store_id AND version >= 1
  AND line_count BETWEEN 1 AND 50 AND source IN ('web', 'site_app')
  AND request_digest ~ '^[0-9a-f]{64}$' AND char_length(idempotency_key) >= 8
  AND (receive_idempotency_key IS NULL) = (received_at IS NULL)
  AND (receive_digest IS NULL) = (received_at IS NULL)
  AND (received_by IS NULL) = (received_at IS NULL)
  AND (receive_captured_at IS NULL) = (received_at IS NULL)
  AND (receive_idempotency_key IS NULL OR char_length(receive_idempotency_key) >= 8)
  AND COALESCE(CASE status
    WHEN 'dispatched' THEN received_at IS NULL AND resolved_at IS NULL AND cancelled_at IS NULL
    WHEN 'received' THEN received_at IS NOT NULL AND resolved_at IS NULL AND cancelled_at IS NULL
    WHEN 'disputed' THEN received_at IS NOT NULL AND resolved_at IS NULL AND cancelled_at IS NULL
    WHEN 'resolved' THEN received_at IS NOT NULL AND resolved_by IS NOT NULL
      AND resolved_at IS NOT NULL AND char_length(btrim(resolution_note)) >= 3
      AND cancelled_at IS NULL
    WHEN 'cancelled' THEN received_at IS NULL AND resolved_at IS NULL AND cancelled_by IS NOT NULL
      AND cancelled_at IS NOT NULL AND char_length(btrim(cancel_reason)) >= 3
    ELSE false
  END, false)
);

-- packages/domain TRANSFER_TRANSITIONS. The dispatch never changes; each step is taken by the
-- signed-in user; a dispute is resolved by someone other than the sender and the receiver.
CREATE FUNCTION app.guard_stock_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'dispatched' OR NEW.dispatched_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'A transfer is dispatched by the signed-in user' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.number IS DISTINCT FROM OLD.number
     OR NEW.from_store_id IS DISTINCT FROM OLD.from_store_id
     OR NEW.to_store_id IS DISTINCT FROM OLD.to_store_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_digest IS DISTINCT FROM OLD.request_digest
     OR NEW.dispatched_by IS DISTINCT FROM OLD.dispatched_by
     OR NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at
     OR NEW.line_count IS DISTINCT FROM OLD.line_count THEN
    RAISE EXCEPTION 'A transfer''s dispatch never changes' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('received', 'resolved', 'cancelled') THEN
    RAISE EXCEPTION 'A % transfer never changes', OLD.status USING ERRCODE = '23514';
  END IF;
  IF (OLD.status, NEW.status) NOT IN (('dispatched', 'received'), ('dispatched', 'disputed'),
       ('disputed', 'resolved'), ('dispatched', 'cancelled')) THEN
    RAISE EXCEPTION 'Transfer status cannot change from % to %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  IF (NEW.status IN ('received', 'disputed') AND NEW.received_by IS DISTINCT FROM app.current_user_id())
     OR (NEW.status = 'resolved' AND NEW.resolved_by IS DISTINCT FROM app.current_user_id())
     OR (NEW.status = 'cancelled' AND NEW.cancelled_by IS DISTINCT FROM app.current_user_id()) THEN
    RAISE EXCEPTION 'A transfer step is taken by the signed-in user' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'resolved' AND NEW.resolved_by IN (OLD.dispatched_by, OLD.received_by) THEN
    RAISE EXCEPTION 'A disputed transfer is resolved by someone who neither sent nor received it'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'disputed' AND (NEW.received_at IS DISTINCT FROM OLD.received_at
     OR NEW.received_by IS DISTINCT FROM OLD.received_by) THEN
    RAISE EXCEPTION 'A receipt never changes' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER stock_transfer_guard BEFORE INSERT OR UPDATE ON "stock_transfers"
  FOR EACH ROW EXECUTE FUNCTION app.guard_stock_transfer();

ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_check" CHECK (
  line_no BETWEEN 1 AND 50 AND quantity > 0 AND base_quantity > 0 AND unit_cost_minor >= 0
  AND dispatched_value_minor >= 0
  AND (received_base_quantity IS NULL OR received_base_quantity >= 0)
  AND (received_base_quantity IS NULL OR received_base_quantity = base_quantity
       OR COALESCE(char_length(btrim(difference_reason)), 0) >= 3)
  AND (received_base_quantity IS NOT NULL OR difference_reason IS NULL)
);

-- Lines are written with a dispatched transfer; afterwards only what was received (once, while
-- the transfer is still dispatched) is recorded.
CREATE FUNCTION app.guard_stock_transfer_line() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT status FROM stock_transfers WHERE tenant_id = NEW.tenant_id AND id = NEW.transfer_id)
     IS DISTINCT FROM 'dispatched' THEN
    RAISE EXCEPTION 'Transfer lines change only while the transfer is in transit'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    (to_jsonb(NEW) - 'received_base_quantity' - 'difference_reason')
      IS DISTINCT FROM (to_jsonb(OLD) - 'received_base_quantity' - 'difference_reason')
    OR OLD.received_base_quantity IS NOT NULL OR NEW.received_base_quantity IS NULL) THEN
    RAISE EXCEPTION 'A transfer line records what was received once' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.received_base_quantity IS NOT NULL THEN
    RAISE EXCEPTION 'A transfer line is received after dispatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER stock_transfer_line_guard BEFORE INSERT OR UPDATE ON "stock_transfer_lines"
  FOR EACH ROW EXECUTE FUNCTION app.guard_stock_transfer_line();

-- At commit: every line left the source store once; a received or disputed transfer has every
-- line's receipt recorded and posted (received exactly when nothing differs); a cancelled one has
-- its dispatch reversed and nothing received.
CREATE FUNCTION app.check_stock_transfer_postings() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target record;
  differs boolean;
BEGIN
  SELECT * INTO target FROM stock_transfers WHERE tenant_id = NEW.tenant_id AND id = NEW.id;
  IF target.line_count IS DISTINCT FROM (SELECT count(*)::int FROM stock_transfer_lines
       WHERE tenant_id = target.tenant_id AND transfer_id = target.id)
     OR EXISTS (
       SELECT 1 FROM stock_transfer_lines l WHERE l.tenant_id = target.tenant_id
          AND l.transfer_id = target.id
          AND (SELECT count(*) FROM stock_ledger_entries e WHERE e.tenant_id = l.tenant_id
                 AND e.transfer_line_id = l.id AND e.kind = 'transfer_out'
                 AND e.reverses_entry_id IS NULL) <> 1
     ) THEN
    RAISE EXCEPTION 'A transfer''s lines leave the source store with it' USING ERRCODE = '23514';
  END IF;
  IF target.status IN ('received', 'disputed', 'resolved') THEN
    SELECT bool_or(received_base_quantity <> base_quantity) INTO differs FROM stock_transfer_lines
     WHERE tenant_id = target.tenant_id AND transfer_id = target.id;
    IF EXISTS (
         SELECT 1 FROM stock_transfer_lines l WHERE l.tenant_id = target.tenant_id
            AND l.transfer_id = target.id
            AND (l.received_base_quantity IS NULL
                 OR (SELECT count(*) FROM stock_ledger_entries e WHERE e.tenant_id = l.tenant_id
                       AND e.transfer_line_id = l.id AND e.kind = 'transfer_in')
                    <> (CASE WHEN l.received_base_quantity > 0 THEN 1 ELSE 0 END))
       ) OR (target.status = 'received' AND differs) OR (target.status = 'disputed' AND NOT differs)
    THEN
      RAISE EXCEPTION 'A received transfer records and posts what arrived' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF target.status = 'cancelled' AND EXISTS (
       SELECT 1 FROM stock_ledger_entries e WHERE e.tenant_id = target.tenant_id
          AND e.transfer_id = target.id AND e.kind = 'transfer_out' AND e.reverses_entry_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM stock_ledger_entries r
                           WHERE r.tenant_id = e.tenant_id AND r.reverses_entry_id = e.id)
     ) THEN
    RAISE EXCEPTION 'A cancelled transfer puts its stock back' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER stock_transfer_postings AFTER INSERT OR UPDATE ON "stock_transfers"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_stock_transfer_postings();

-- Stock takes -----------------------------------------------------------------------------------
ALTER TABLE "stock_takes" ADD CONSTRAINT "stock_takes_state_check" CHECK (
  number ~ '^STK-[0-9]{4,12}$' AND version >= 1 AND line_count BETWEEN 1 AND 300
  AND created_by = ANY (contributors)
  AND COALESCE(CASE status
    WHEN 'draft' THEN submitted_at IS NULL AND approved_by IS NULL AND cancelled_at IS NULL
    WHEN 'submitted' THEN submitted_by IS NOT NULL AND submitted_at IS NOT NULL
      AND approved_by IS NULL AND cancelled_at IS NULL
    WHEN 'approved' THEN submitted_by IS NOT NULL AND approved_by IS NOT NULL
      AND approved_at IS NOT NULL AND cancelled_at IS NULL
    WHEN 'cancelled' THEN cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL
      AND char_length(btrim(cancel_reason)) >= 3 AND approved_by IS NULL
    ELSE false
  END, false)
  AND (approved_by IS NULL) = (approved_at IS NULL)
  AND (approved_by IS NULL OR NOT (approved_by = ANY (contributors)))
  AND (return_reason IS NULL OR char_length(btrim(return_reason)) >= 3)
);
-- One open count per store.
CREATE UNIQUE INDEX "stock_takes_one_open_per_store" ON "stock_takes"("tenant_id", "store_id")
  WHERE status IN ('draft', 'submitted');

-- packages/domain STOCK_TAKE_TRANSITIONS. Submission needs every line counted; the approver is the
-- signed-in user and never a contributor (creator, counters, submitters: the list only grows).
CREATE FUNCTION app.guard_stock_take() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.created_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'A stock take starts as a draft by the signed-in user' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.store_id IS DISTINCT FROM OLD.store_id
       OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.number IS DISTINCT FROM OLD.number
       OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.line_count IS DISTINCT FROM OLD.line_count THEN
      RAISE EXCEPTION 'A stock take keeps its store and lines' USING ERRCODE = '23514';
    END IF;
    IF OLD.status IN ('approved', 'cancelled') THEN
      RAISE EXCEPTION 'A % stock take never changes', OLD.status USING ERRCODE = '23514';
    END IF;
    IF NOT (NEW.contributors @> OLD.contributors) THEN
      RAISE EXCEPTION 'A stock take''s contributors are only ever added' USING ERRCODE = '23514';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND (OLD.status, NEW.status) NOT IN (
      ('draft', 'submitted'), ('submitted', 'approved'), ('submitted', 'draft'),
      ('draft', 'cancelled'), ('submitted', 'cancelled')
    ) THEN
      RAISE EXCEPTION 'Stock take status cannot change from % to %', OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'submitted' AND NEW.status = 'submitted' THEN
      RAISE EXCEPTION 'A submitted stock take is decided, returned or cancelled' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'submitted' AND OLD.status = 'draft' AND EXISTS (
      SELECT 1 FROM stock_take_lines WHERE tenant_id = NEW.tenant_id AND stock_take_id = NEW.id
        AND counted_quantity IS NULL
    ) THEN
      RAISE EXCEPTION 'Every line is counted before submission' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'approved' AND NEW.approved_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'A stock take is approved by the signed-in user' USING ERRCODE = '23514';
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
CREATE TRIGGER stock_take_guard BEFORE INSERT OR UPDATE ON "stock_takes"
  FOR EACH ROW EXECUTE FUNCTION app.guard_stock_take();

ALTER TABLE "stock_take_lines" ADD CONSTRAINT "stock_take_lines_check" CHECK (
  line_no BETWEEN 1 AND 300 AND snapshot_quantity >= 0 AND snapshot_seq >= 0
  AND (counted_quantity IS NULL OR counted_quantity >= 0)
  AND (expected_quantity IS NULL OR expected_quantity >= 0)
  AND num_nonnulls(counted_quantity, expected_quantity, counted_seq, counted_by, counted_at, count_id)
      IN (0, 6)
);

-- Lines are written with their draft stock take; afterwards only the latest count changes, by the
-- signed-in user, while the stock take is a draft.
CREATE FUNCTION app.guard_stock_take_line() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT status FROM stock_takes WHERE tenant_id = NEW.tenant_id AND id = NEW.stock_take_id)
     IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Counts change only while the stock take is a draft' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.counted_quantity IS NOT NULL THEN
    RAISE EXCEPTION 'A count-sheet line starts uncounted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    (to_jsonb(NEW) - 'counted_quantity' - 'expected_quantity' - 'counted_seq' - 'counted_by'
       - 'counted_at' - 'count_id')
      IS DISTINCT FROM (to_jsonb(OLD) - 'counted_quantity' - 'expected_quantity' - 'counted_seq'
       - 'counted_by' - 'counted_at' - 'count_id')
    OR NEW.counted_by IS DISTINCT FROM app.current_user_id()
    OR NOT EXISTS (SELECT 1 FROM stock_take_counts c WHERE c.tenant_id = NEW.tenant_id
                     AND c.id = NEW.count_id AND c.line_id = NEW.id
                     AND c.counted_quantity = NEW.counted_quantity
                     AND c.expected_quantity = NEW.expected_quantity)) THEN
    RAISE EXCEPTION 'A count-sheet line follows its latest recorded count' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER stock_take_line_guard BEFORE INSERT OR UPDATE ON "stock_take_lines"
  FOR EACH ROW EXECUTE FUNCTION app.guard_stock_take_line();

ALTER TABLE "stock_take_counts" ADD CONSTRAINT "stock_take_counts_check" CHECK (
  counted_quantity >= 0 AND expected_quantity >= 0 AND counted_seq >= 0
  AND request_digest ~ '^[0-9a-f]{64}$' AND char_length(idempotency_key) >= 8
);

-- Counts are evidence: recorded by the signed-in user on a draft stock take, who becomes a
-- contributor (and so can never approve it).
CREATE FUNCTION app.guard_stock_take_count() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.counted_by IS DISTINCT FROM app.current_user_id()
     OR (SELECT status FROM stock_takes WHERE tenant_id = NEW.tenant_id AND id = NEW.stock_take_id)
        IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Counts are recorded by the signed-in user on a draft stock take'
      USING ERRCODE = '23514';
  END IF;
  UPDATE stock_takes SET contributors = app.add_contributors(contributors, NEW.counted_by)
   WHERE tenant_id = NEW.tenant_id AND id = NEW.stock_take_id
     AND NOT (NEW.counted_by = ANY (contributors));
  RETURN NEW;
END
$$;
CREATE TRIGGER stock_take_count_guard BEFORE INSERT ON "stock_take_counts"
  FOR EACH ROW EXECUTE FUNCTION app.guard_stock_take_count();

-- At commit: the line count matches and an approved stock take has every variance posted once.
CREATE FUNCTION app.check_stock_take_postings() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target record;
BEGIN
  SELECT * INTO target FROM stock_takes WHERE tenant_id = NEW.tenant_id AND id = NEW.id;
  IF target.line_count IS DISTINCT FROM (SELECT count(*)::int FROM stock_take_lines
       WHERE tenant_id = target.tenant_id AND stock_take_id = target.id)
     OR (target.status = 'approved' AND EXISTS (
       SELECT 1 FROM stock_take_lines l WHERE l.tenant_id = target.tenant_id
          AND l.stock_take_id = target.id
          AND (SELECT count(*) FROM stock_ledger_entries e WHERE e.tenant_id = l.tenant_id
                 AND e.stock_take_line_id = l.id)
             <> (CASE WHEN l.counted_quantity <> l.expected_quantity THEN 1 ELSE 0 END)
     )) THEN
    RAISE EXCEPTION 'An approved stock take posts each variance once' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER stock_take_postings AFTER INSERT OR UPDATE ON "stock_takes"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_stock_take_postings();

-- Reorder levels --------------------------------------------------------------------------------
ALTER TABLE "stock_reorder_levels" ADD CONSTRAINT "stock_reorder_levels_check" CHECK (
  reorder_level > 0
);

-- GRNs post to stores ---------------------------------------------------------------------------
-- At commit: a newly recorded GRN has a receipt for every line with accepted goods; a voided GRN
-- has every receipt reversed (stock already used is never silently driven negative: the void is
-- refused instead).
CREATE FUNCTION app.check_grn_stock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND EXISTS (
    SELECT 1 FROM grn_lines l WHERE l.tenant_id = NEW.tenant_id AND l.grn_id = NEW.id
       AND l.accepted_base_quantity > 0
       AND (SELECT count(*) FROM stock_ledger_entries e WHERE e.tenant_id = l.tenant_id
              AND e.grn_line_id = l.id AND e.reverses_entry_id IS NULL) <> 1
  ) THEN
    RAISE EXCEPTION 'A recorded GRN receives its accepted goods into a store' USING ERRCODE = '23514';
  END IF;
  IF (SELECT status FROM grns WHERE tenant_id = NEW.tenant_id AND id = NEW.id) = 'voided'
     AND EXISTS (
       SELECT 1 FROM stock_ledger_entries e WHERE e.tenant_id = NEW.tenant_id AND e.grn_id = NEW.id
          AND e.reverses_entry_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM stock_ledger_entries r
                           WHERE r.tenant_id = e.tenant_id AND r.reverses_entry_id = e.id)
     ) THEN
    RAISE EXCEPTION 'A voided GRN''s receipts are reversed' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER grn_stock AFTER INSERT OR UPDATE ON "grns"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_grn_stock();

-- A material's base unit is fixed once it has stock (quantities are kept in it).
CREATE FUNCTION app.guard_material_stock_unit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.base_unit IS DISTINCT FROM OLD.base_unit AND EXISTS (
    SELECT 1 FROM stock_balances WHERE tenant_id = NEW.tenant_id AND material_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'A material with stock keeps its base unit' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER material_stock_unit_guard BEFORE UPDATE OF base_unit ON "materials"
  FOR EACH ROW EXECUTE FUNCTION app.guard_material_stock_unit();

-- Progress measurements -------------------------------------------------------------------------
ALTER TABLE "progress_measurements" ADD CONSTRAINT "progress_measurements_check" CHECK (
  quantity_to_date >= 0 AND status IN ('recorded')
  AND (corrects_id IS NULL) = (correction_reason IS NULL)
  AND (correction_reason IS NULL OR char_length(btrim(correction_reason)) >= 3)
  AND (note IS NULL OR char_length(btrim(note)) >= 1)
);

-- Measured by the signed-in user, not in the future (Africa/Nairobi), against an item of an
-- approved BQ version; a correction names an earlier measurement of the same item. Never changed.
CREATE FUNCTION app.guard_progress_measurement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  approved boolean;
  corrected record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'A measurement never changes; record a correction' USING ERRCODE = '23514';
  END IF;
  IF NEW.measured_by IS DISTINCT FROM app.current_user_id() OR NEW.measured_on > app.business_today()
  THEN
    RAISE EXCEPTION 'A measurement is recorded by the signed-in user, not in the future'
      USING ERRCODE = '23514';
  END IF;
  SELECT status = 'approved' INTO approved FROM bq_versions
   WHERE tenant_id = NEW.tenant_id AND id = NEW.version_id;
  IF NOT COALESCE(approved, false) THEN
    RAISE EXCEPTION 'Work is measured against an approved BQ version' USING ERRCODE = '23514';
  END IF;
  IF NEW.corrects_id IS NOT NULL THEN
    SELECT project_id, item_lineage_id INTO corrected FROM progress_measurements
     WHERE tenant_id = NEW.tenant_id AND id = NEW.corrects_id;
    IF corrected.item_lineage_id IS DISTINCT FROM NEW.item_lineage_id
       OR corrected.project_id IS DISTINCT FROM NEW.project_id THEN
      RAISE EXCEPTION 'A correction names a measurement of the same item' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER progress_measurement_guard BEFORE INSERT OR UPDATE OR DELETE
  ON "progress_measurements" FOR EACH ROW EXECUTE FUNCTION app.guard_progress_measurement();

-- Build-up line → material mappings -------------------------------------------------------------
ALTER TABLE "rate_buildup_line_materials" ADD CONSTRAINT "rate_buildup_line_materials_check" CHECK (
  base_per_unit ~ '^[1-9][0-9]*/[1-9][0-9]*$' AND unit ~ '^[a-z][a-z0-9_]{0,19}$'
  AND (unmapped_by IS NULL) = (unmapped_at IS NULL)
);
CREATE UNIQUE INDEX "rate_buildup_line_materials_one_active" ON "rate_buildup_line_materials"
  ("tenant_id", "line_id") WHERE unmapped_at IS NULL;

-- A mapping names a material line of its build-up version and records the material's base unit;
-- afterwards only the unmapped stamp is set (once, by the signed-in user).
CREATE FUNCTION app.guard_buildup_line_material() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.mapped_by IS DISTINCT FROM app.current_user_id() OR NEW.unmapped_at IS NOT NULL
       OR (SELECT kind FROM rate_buildup_lines WHERE tenant_id = NEW.tenant_id AND id = NEW.line_id)
          IS DISTINCT FROM 'material'
       OR (SELECT base_unit FROM materials WHERE tenant_id = NEW.tenant_id AND id = NEW.material_id)
          IS DISTINCT FROM NEW.base_unit THEN
      RAISE EXCEPTION 'A material line is mapped to a catalogue material by the signed-in user'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'unmapped_by' - 'unmapped_at') IS DISTINCT FROM
       (to_jsonb(OLD) - 'unmapped_by' - 'unmapped_at')
     OR OLD.unmapped_at IS NOT NULL OR NEW.unmapped_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A mapping is only ever unmapped' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER buildup_line_material_guard BEFORE INSERT OR UPDATE ON "rate_buildup_line_materials"
  FOR EACH ROW EXECUTE FUNCTION app.guard_buildup_line_material();

-- Row-level security ---------------------------------------------------------------------------
DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['stores', 'stock_balances', 'stock_ledger_entries',
    'stock_movements', 'stock_movement_lines', 'stock_transfers', 'stock_transfer_lines',
    'stock_takes', 'stock_take_lines', 'stock_take_counts', 'stock_reorder_levels',
    'progress_measurements', 'rate_buildup_line_materials']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = app.current_tenant_id()) '
      'WITH CHECK (tenant_id = app.current_tenant_id())', target || '_isolation', target);
  END LOOP;
END
$$;

-- The runtime role never deletes stores history; the ledger, counts, measurements and documents
-- are append-only. Reorder levels are configuration and may be removed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmb_app') THEN
    REVOKE DELETE ON "stores", "stock_balances", "stock_ledger_entries", "stock_movements",
      "stock_movement_lines", "stock_transfers", "stock_transfer_lines", "stock_takes",
      "stock_take_lines", "stock_take_counts", "progress_measurements",
      "rate_buildup_line_materials" FROM pmb_app;
    REVOKE UPDATE ON "stock_ledger_entries", "stock_movement_lines", "stock_take_counts",
      "progress_measurements" FROM pmb_app;
    REVOKE TRUNCATE, REFERENCES, TRIGGER
      ON "stores", "stock_balances", "stock_ledger_entries", "stock_movements",
         "stock_movement_lines", "stock_transfers", "stock_transfer_lines", "stock_takes",
         "stock_take_lines", "stock_take_counts", "stock_reorder_levels", "progress_measurements",
         "rate_buildup_line_materials"
      FROM pmb_app;
  END IF;
END
$$;
REVOKE EXECUTE ON FUNCTION app.guard_store() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_stock_balance() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_stock_entry_source(stock_ledger_entries, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.post_stock_entry() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.apply_stock_entry() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.refuse_stock_entry_change() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_stock_movement() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_stock_movement_line() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_stock_movement_postings() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_stock_transfer() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_stock_transfer_line() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_stock_transfer_postings() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_stock_take() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_stock_take_line() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_stock_take_count() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_stock_take_postings() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_grn_stock() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_material_stock_unit() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_progress_measurement() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_buildup_line_material() FROM PUBLIC;

COMMIT;
