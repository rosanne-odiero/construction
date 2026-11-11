-- D2.3 BQ versions and variations (ARCHITECTURE §4.3, ERD §4, WORKFLOWS Variation, brief §5.2 and
-- §15 C/F/G). Enforces, in the database as well as the API:
-- * Lineage: bills and sections get a lineage_id like items (stable across versions); each is
--   unique within a version, so variation lines and build-up links can reference "this item of
--   that version" through composite (tenant_id, version_id, lineage_id) foreign keys.
-- * Versions: version 1 (import) is approved as the contract baseline; every later version comes
--   from exactly one approved variation, is version_no + 1 of its approved parent (one child per
--   parent: a linear history), and is approved from birth. An approved version never changes
--   (app.guard_bq_version, plus app.guard_bq_version_content for its bills, sections and items).
--   Maker-checker by identity: the approver is neither the version's creator nor its last writer.
-- * Instructions (AI/EI register) and Variation Orders with the WORKFLOWS state machine
--   (app.guard_variation_order), lines editable only while the variation is a draft
--   (app.guard_variation_line), a snapshot digest frozen on submission, decisions by someone other
--   than the creator or submitter, and an approved variation always linked to its version.
-- * Rate build-ups per company: append-only versions and lines whose amounts and rate are
--   re-checked at commit; BQ item links to a build-up version, never edited (only unlinked).
-- Every new table has tenant_id, forced RLS with WITH CHECK and composite (tenant_id, …) foreign
-- keys for every tenant-to-tenant reference (project, BQ, version, bill, section, item).
BEGIN;

-- Lineage on bills and sections ------------------------------------------------------------------
-- Existing rows get a fresh lineage (adding a column fires no row triggers); new rows must set it.
ALTER TABLE "bq_bills" ADD COLUMN "lineage_id" UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE "bq_bills" ALTER COLUMN "lineage_id" DROP DEFAULT;
ALTER TABLE "bq_sections" ADD COLUMN "lineage_id" UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE "bq_sections" ALTER COLUMN "lineage_id" DROP DEFAULT;
CREATE UNIQUE INDEX "bq_bills_tenant_id_version_id_lineage_id_key"
  ON "bq_bills"("tenant_id", "version_id", "lineage_id");
CREATE UNIQUE INDEX "bq_sections_tenant_id_version_id_lineage_id_key"
  ON "bq_sections"("tenant_id", "version_id", "lineage_id");
CREATE UNIQUE INDEX "bq_items_tenant_id_version_id_lineage_id_key"
  ON "bq_items"("tenant_id", "version_id", "lineage_id");

-- Items added by a variation have no spreadsheet row; approved variations add two amount sources:
-- `fixed` (an amount set by the variation, no rate) and `omitted` (quantity 0, amount 0).
ALTER TABLE "bq_items" ALTER COLUMN "source_sheet" DROP NOT NULL;
ALTER TABLE "bq_items" ALTER COLUMN "source_row" DROP NOT NULL;
ALTER TABLE "bq_items" ADD CONSTRAINT "bq_items_source_pair_check" CHECK (
  (source_sheet IS NULL) = (source_row IS NULL)
);
ALTER TABLE "bq_items" DROP CONSTRAINT "bq_items_amount_source_check";
ALTER TABLE "bq_items" ADD CONSTRAINT "bq_items_amount_source_check" CHECK (
  amount_source IN ('computed', 'percentage', 'lump_sum', 'sheet_override', 'unpriced', 'included',
                    'fixed', 'omitted')
);
ALTER TABLE "bq_items" DROP CONSTRAINT "bq_items_amount_rule_check";
ALTER TABLE "bq_items" ADD CONSTRAINT "bq_items_amount_rule_check" CHECK (
  CASE amount_source
    WHEN 'computed' THEN quantity IS NOT NULL AND rate IS NOT NULL
      AND amount_minor = round(quantity * rate * 100)
    WHEN 'sheet_override' THEN sheet_amount_minor IS NOT NULL AND amount_minor = sheet_amount_minor
      AND override_reason IS NOT NULL AND char_length(btrim(override_reason)) >= 3
    WHEN 'lump_sum' THEN rate IS NULL AND sheet_amount_minor IS NOT NULL
      AND amount_minor = sheet_amount_minor
    WHEN 'percentage' THEN unit = 'pct' AND quantity IS NOT NULL
    WHEN 'fixed' THEN rate IS NULL AND amount_minor >= 0
    WHEN 'omitted' THEN amount_minor = 0 AND (quantity IS NULL OR quantity = 0)
    ELSE amount_minor = 0
  END
);

-- Versions: parent, producing variation, approval ------------------------------------------------
ALTER TABLE "bq_versions" ADD COLUMN "parent_version_id" UUID;
ALTER TABLE "bq_versions" ADD COLUMN "variation_id" UUID;
ALTER TABLE "bq_versions" ADD COLUMN "approved_by" UUID;
ALTER TABLE "bq_versions" ADD COLUMN "approved_at" TIMESTAMPTZ;
CREATE UNIQUE INDEX "bq_versions_tenant_id_bq_id_id_key" ON "bq_versions"("tenant_id", "bq_id", "id");
-- One child per parent (a linear history) and one version per variation.
CREATE UNIQUE INDEX "bq_versions_tenant_id_parent_version_id_key"
  ON "bq_versions"("tenant_id", "parent_version_id");
CREATE UNIQUE INDEX "bq_versions_tenant_id_variation_id_key"
  ON "bq_versions"("tenant_id", "variation_id");
ALTER TABLE "bq_versions" ADD CONSTRAINT "bq_versions_tenant_id_bq_id_parent_version_id_fkey"
  FOREIGN KEY ("tenant_id", "bq_id", "parent_version_id")
  REFERENCES "bq_versions"("tenant_id", "bq_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bq_versions" ADD CONSTRAINT "bq_versions_approval_check" CHECK (
  (status = 'approved') = (approved_by IS NOT NULL AND approved_at IS NOT NULL)
  AND (approved_by IS NULL OR (approved_by <> created_by AND approved_by <> updated_by))
);
ALTER TABLE "bq_versions" ADD CONSTRAINT "bq_versions_lineage_check" CHECK (
  CASE source
    WHEN 'import' THEN version_no = 1 AND parent_version_id IS NULL AND variation_id IS NULL
    WHEN 'variation' THEN parent_version_id IS NOT NULL AND variation_id IS NOT NULL
      AND version_no > 1
    ELSE false
  END
);

-- Instructions (Architect's/Engineer's Instructions register) ------------------------------------
CREATE TABLE "instructions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "number" VARCHAR(30) NOT NULL,
    "issued_on" DATE NOT NULL,
    "issuer_name" VARCHAR(150) NOT NULL,
    "issuer_role" VARCHAR(30) NOT NULL,
    "subject" VARCHAR(200) NOT NULL,
    "description" VARCHAR(4000),
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "status" VARCHAR(10) NOT NULL DEFAULT 'open',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "instructions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "instructions_tenant_id_id_key" ON "instructions"("tenant_id", "id");
CREATE UNIQUE INDEX "instructions_tenant_id_project_id_id_key"
  ON "instructions"("tenant_id", "project_id", "id");
CREATE UNIQUE INDEX "instructions_tenant_id_project_id_number_key"
  ON "instructions"("tenant_id", "project_id", "number");
ALTER TABLE "instructions" ADD CONSTRAINT "instructions_tenant_id_project_id_fkey"
  FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
-- packages/types INSTRUCTION_ISSUER_ROLES, INSTRUCTION_STATUSES
ALTER TABLE "instructions" ADD CONSTRAINT "instructions_issuer_role_check" CHECK (
  issuer_role IN ('architect', 'engineer', 'quantity_surveyor', 'client', 'project_manager', 'other')
);
ALTER TABLE "instructions" ADD CONSTRAINT "instructions_status_check" CHECK (status IN ('open', 'closed'));
ALTER TABLE "instructions" ADD CONSTRAINT "instructions_text_check" CHECK (
  number ~ '^[A-Za-z0-9][A-Za-z0-9 ./_-]{0,29}$'
  AND char_length(issuer_name) >= 2 AND issuer_name = btrim(issuer_name)
  AND char_length(subject) >= 3 AND subject = btrim(subject)
);
ALTER TABLE "instructions" ADD CONSTRAINT "instructions_attachments_check" CHECK (
  jsonb_typeof(attachments) = 'array' AND jsonb_array_length(attachments) <= 10
);
ALTER TABLE "instructions" ADD CONSTRAINT "instructions_version_check" CHECK (version >= 1);

-- Variation Orders -------------------------------------------------------------------------------
CREATE TABLE "variation_orders" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "bq_id" UUID NOT NULL,
    "instruction_id" UUID NOT NULL,
    "base_version_id" UUID NOT NULL,
    "number" VARCHAR(30) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" VARCHAR(4000),
    "status" VARCHAR(20) NOT NULL DEFAULT 'draft',
    "additions_minor" BIGINT NOT NULL DEFAULT 0,
    "omissions_minor" BIGINT NOT NULL DEFAULT 0,
    "net_minor" BIGINT NOT NULL DEFAULT 0,
    "line_count" INTEGER NOT NULL DEFAULT 0,
    "snapshot_digest" CHAR(64),
    "submitted_by" UUID,
    "submitted_at" TIMESTAMPTZ,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ,
    "decision_reason" VARCHAR(500),
    "cancel_reason" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Everyone who wrote the proposal (app.record_variation_contributors); none may decide on it.
    "contributors" UUID[] NOT NULL DEFAULT '{}',

    CONSTRAINT "variation_orders_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "variation_orders_tenant_id_id_key" ON "variation_orders"("tenant_id", "id");
CREATE UNIQUE INDEX "variation_orders_tenant_id_bq_id_id_key"
  ON "variation_orders"("tenant_id", "bq_id", "id");
CREATE UNIQUE INDEX "variation_orders_tenant_id_id_base_version_id_key"
  ON "variation_orders"("tenant_id", "id", "base_version_id");
CREATE UNIQUE INDEX "variation_orders_tenant_id_project_id_number_key"
  ON "variation_orders"("tenant_id", "project_id", "number");
CREATE INDEX "variation_orders_tenant_id_project_id_status_idx"
  ON "variation_orders"("tenant_id", "project_id", "status");
CREATE INDEX "variation_orders_tenant_id_instruction_id_idx"
  ON "variation_orders"("tenant_id", "instruction_id");
ALTER TABLE "variation_orders" ADD CONSTRAINT "variation_orders_tenant_id_project_id_fkey"
  FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "variation_orders" ADD CONSTRAINT "variation_orders_tenant_id_project_id_bq_id_fkey"
  FOREIGN KEY ("tenant_id", "project_id", "bq_id") REFERENCES "bqs"("tenant_id", "project_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "variation_orders" ADD CONSTRAINT "variation_orders_tenant_id_project_id_instruction_id_fkey"
  FOREIGN KEY ("tenant_id", "project_id", "instruction_id")
  REFERENCES "instructions"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "variation_orders" ADD CONSTRAINT "variation_orders_tenant_id_bq_id_base_version_id_fkey"
  FOREIGN KEY ("tenant_id", "bq_id", "base_version_id")
  REFERENCES "bq_versions"("tenant_id", "bq_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- packages/types VARIATION_STATUSES
ALTER TABLE "variation_orders" ADD CONSTRAINT "variation_orders_status_check" CHECK (
  status IN ('draft', 'submitted', 'approved', 'rejected', 'cancelled')
);
ALTER TABLE "variation_orders" ADD CONSTRAINT "variation_orders_text_check" CHECK (
  number ~ '^VO-[0-9]{3,10}$' AND char_length(title) >= 3 AND title = btrim(title)
);
ALTER TABLE "variation_orders" ADD CONSTRAINT "variation_orders_totals_check" CHECK (
  additions_minor >= 0 AND omissions_minor >= 0 AND net_minor = additions_minor - omissions_minor
  AND line_count BETWEEN 0 AND 500
);
-- What each state carries: a frozen snapshot from submission on; a decision by someone who neither
-- created nor submitted the variation (maker-checker by identity); a reason for rejection and
-- cancellation.
ALTER TABLE "variation_orders" ADD CONSTRAINT "variation_orders_state_check" CHECK (
  ((status IN ('submitted', 'approved', 'rejected'))
    = (snapshot_digest IS NOT NULL AND submitted_by IS NOT NULL AND submitted_at IS NOT NULL))
  AND (snapshot_digest IS NULL OR snapshot_digest ~ '^[0-9a-f]{64}$')
  AND (status NOT IN ('submitted', 'approved') OR line_count >= 1)
  AND ((status IN ('approved', 'rejected')) = (decided_by IS NOT NULL AND decided_at IS NOT NULL))
  AND (decided_by IS NULL OR (decided_by <> created_by AND decided_by <> submitted_by
    AND NOT (decided_by = ANY (contributors))))
  AND ((status = 'rejected') = (decision_reason IS NOT NULL))
  AND (decision_reason IS NULL OR char_length(btrim(decision_reason)) >= 3)
  AND ((status = 'cancelled') = (cancel_reason IS NOT NULL))
  AND (cancel_reason IS NULL OR char_length(btrim(cancel_reason)) >= 3)
);
ALTER TABLE "variation_orders" ADD CONSTRAINT "variation_orders_version_check" CHECK (version >= 1);

-- The version an approved variation produced belongs to the same BQ.
ALTER TABLE "bq_versions" ADD CONSTRAINT "bq_versions_tenant_id_bq_id_variation_id_fkey"
  FOREIGN KEY ("tenant_id", "bq_id", "variation_id")
  REFERENCES "variation_orders"("tenant_id", "bq_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "variation_lines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "variation_id" UUID NOT NULL,
    "base_version_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "action" VARCHAR(10) NOT NULL,
    "item_lineage_id" UUID,
    "bill_lineage_id" UUID,
    "section_lineage_id" UUID,
    "new_section_code" VARCHAR(30),
    "new_section_title" VARCHAR(300),
    "new_lineage_id" UUID,
    "ref" VARCHAR(30),
    "description" VARCHAR(4000),
    "unit" VARCHAR(10),
    "unit_raw" VARCHAR(30),
    "kind" VARCHAR(20),
    "quantity" DECIMAL(20,4),
    "rate" DECIMAL(20,4),
    "amount_minor" BIGINT,
    "note" VARCHAR(500),
    "base_amount_minor" BIGINT NOT NULL,
    "new_amount_minor" BIGINT NOT NULL,
    "delta_minor" BIGINT NOT NULL,

    CONSTRAINT "variation_lines_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "variation_lines_tenant_id_id_key" ON "variation_lines"("tenant_id", "id");
CREATE UNIQUE INDEX "variation_lines_tenant_id_variation_id_line_no_key"
  ON "variation_lines"("tenant_id", "variation_id", "line_no");
-- One line per existing item in a variation; every added item has its own lineage.
CREATE UNIQUE INDEX "variation_lines_tenant_id_variation_id_item_lineage_id_key"
  ON "variation_lines"("tenant_id", "variation_id", "item_lineage_id");
CREATE UNIQUE INDEX "variation_lines_tenant_id_new_lineage_id_key"
  ON "variation_lines"("tenant_id", "new_lineage_id");
-- A line follows its variation's base version (a rebase cascades to the lines).
ALTER TABLE "variation_lines" ADD CONSTRAINT "variation_lines_tenant_id_variation_id_base_version_id_fkey"
  FOREIGN KEY ("tenant_id", "variation_id", "base_version_id")
  REFERENCES "variation_orders"("tenant_id", "id", "base_version_id")
  ON DELETE CASCADE ON UPDATE CASCADE;
-- Changed and omitted items, target bills and sections exist in that base version.
ALTER TABLE "variation_lines" ADD CONSTRAINT "variation_lines_tenant_id_base_version_id_item_lineage_id_fkey"
  FOREIGN KEY ("tenant_id", "base_version_id", "item_lineage_id")
  REFERENCES "bq_items"("tenant_id", "version_id", "lineage_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "variation_lines" ADD CONSTRAINT "variation_lines_tenant_id_base_version_id_bill_lineage_id_fkey"
  FOREIGN KEY ("tenant_id", "base_version_id", "bill_lineage_id")
  REFERENCES "bq_bills"("tenant_id", "version_id", "lineage_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "variation_lines" ADD CONSTRAINT "variation_lines_base_version_section_fkey"
  FOREIGN KEY ("tenant_id", "base_version_id", "section_lineage_id")
  REFERENCES "bq_sections"("tenant_id", "version_id", "lineage_id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- packages/types VARIATION_LINE_ACTIONS, VARIATION_ADD_KINDS, BQ_UNITS
ALTER TABLE "variation_lines" ADD CONSTRAINT "variation_lines_action_check" CHECK (
  CASE action
    WHEN 'adjust' THEN item_lineage_id IS NOT NULL AND bill_lineage_id IS NULL
      AND section_lineage_id IS NULL AND new_section_title IS NULL AND new_lineage_id IS NULL
      AND kind IS NULL AND description IS NULL
      AND (amount_minor IS NULL OR new_amount_minor = amount_minor)
    WHEN 'omit' THEN item_lineage_id IS NOT NULL AND bill_lineage_id IS NULL
      AND section_lineage_id IS NULL AND new_section_title IS NULL AND new_lineage_id IS NULL
      AND kind IS NULL AND description IS NULL AND quantity IS NULL AND rate IS NULL
      AND amount_minor IS NULL AND new_amount_minor = 0
    WHEN 'add' THEN item_lineage_id IS NULL AND bill_lineage_id IS NOT NULL
      AND new_lineage_id IS NOT NULL AND kind IS NOT NULL AND description IS NOT NULL
      AND char_length(btrim(description)) >= 1 AND base_amount_minor = 0
      AND ((section_lineage_id IS NULL) = (new_section_title IS NOT NULL))
      AND (new_section_code IS NULL OR new_section_title IS NOT NULL)
      AND CASE WHEN amount_minor IS NULL
        THEN quantity IS NOT NULL AND rate IS NOT NULL AND unit IS NOT NULL
          AND new_amount_minor = round(quantity * rate * 100)
        ELSE new_amount_minor = amount_minor END
    ELSE false
  END
);
ALTER TABLE "variation_lines" ADD CONSTRAINT "variation_lines_values_check" CHECK (
  (kind IS NULL OR kind IN ('measured', 'preliminary', 'provisional_sum', 'pc_sum', 'contingency',
                            'daywork'))
  AND (unit IS NULL OR unit IN ('m3', 'm2', 'm', 'kg', 't', 'nr', 'item', 'ls', 'pct', 'hr', 'day',
                                'week', 'month', 'l', 'set', 'pair', 'other'))
  AND (quantity IS NULL OR quantity >= 0) AND (rate IS NULL OR rate >= 0)
  AND (amount_minor IS NULL OR (amount_minor >= 0 AND rate IS NULL))
  AND delta_minor = new_amount_minor - base_amount_minor
  AND new_amount_minor BETWEEN 0 AND 100000000000000
  AND base_amount_minor BETWEEN -100000000000000 AND 100000000000000
  AND line_no BETWEEN 1 AND 500
);

-- Status history of each variation (append-only; reasons live here, never in the audit log).
CREATE TABLE "variation_status_changes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "variation_id" UUID NOT NULL,
    "from_status" VARCHAR(20),
    "to_status" VARCHAR(20) NOT NULL,
    "action" VARCHAR(20) NOT NULL,
    "reason" VARCHAR(500),
    "snapshot_digest" CHAR(64),
    "changed_by" UUID NOT NULL,
    "changed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "variation_status_changes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "variation_status_changes_tenant_id_variation_id_changed_at_idx"
  ON "variation_status_changes"("tenant_id", "variation_id", "changed_at");
ALTER TABLE "variation_status_changes" ADD CONSTRAINT "variation_status_changes_tenant_id_variation_id_fkey"
  FOREIGN KEY ("tenant_id", "variation_id") REFERENCES "variation_orders"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "variation_status_changes" ADD CONSTRAINT "variation_status_changes_values_check" CHECK (
  action IN ('create', 'submit', 'approve', 'reject', 'reopen', 'cancel', 'rebase')
  AND to_status IN ('draft', 'submitted', 'approved', 'rejected', 'cancelled')
  AND (from_status IS NULL OR from_status IN ('draft', 'submitted', 'approved', 'rejected', 'cancelled'))
  AND (snapshot_digest IS NULL OR snapshot_digest ~ '^[0-9a-f]{64}$')
);

-- Rate build-up library (per company) -------------------------------------------------------------
CREATE TABLE "rate_buildups" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" VARCHAR(30) NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "unit" VARCHAR(10) NOT NULL,
    "current_version_no" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_buildups_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "rate_buildups_tenant_id_id_key" ON "rate_buildups"("tenant_id", "id");
CREATE UNIQUE INDEX "rate_buildups_tenant_id_code_key" ON "rate_buildups"("tenant_id", "code");
ALTER TABLE "rate_buildups" ADD CONSTRAINT "rate_buildups_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;
-- packages/types BUILDUP_OUTPUT_UNITS
ALTER TABLE "rate_buildups" ADD CONSTRAINT "rate_buildups_values_check" CHECK (
  code ~ '^[A-Z0-9][A-Z0-9./-]{0,29}$' AND char_length(name) >= 3 AND name = btrim(name)
  AND unit IN ('m3', 'm2', 'm', 'kg', 't', 'nr', 'item', 'ls', 'hr', 'day', 'week', 'month', 'l',
               'set', 'pair')
  AND current_version_no >= 1 AND version >= 1
);

-- One row per edit; never updated or deleted (links keep pointing at the version they used).
CREATE TABLE "rate_buildup_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "buildup_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "unit" VARCHAR(10) NOT NULL,
    "assumptions" VARCHAR(2000),
    "rate_minor" BIGINT,
    "priced_minor" BIGINT NOT NULL,
    "unpriced_lines" INTEGER NOT NULL,
    "line_count" INTEGER NOT NULL,
    "rounding" VARCHAR(20) NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_buildup_versions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "rate_buildup_versions_tenant_id_id_key" ON "rate_buildup_versions"("tenant_id", "id");
CREATE UNIQUE INDEX "rate_buildup_versions_tenant_id_buildup_id_id_key"
  ON "rate_buildup_versions"("tenant_id", "buildup_id", "id");
CREATE UNIQUE INDEX "rate_buildup_versions_tenant_id_buildup_id_version_no_key"
  ON "rate_buildup_versions"("tenant_id", "buildup_id", "version_no");
ALTER TABLE "rate_buildup_versions" ADD CONSTRAINT "rate_buildup_versions_tenant_id_buildup_id_fkey"
  FOREIGN KEY ("tenant_id", "buildup_id") REFERENCES "rate_buildups"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
-- The rate is defined only when every line is priced (packages/domain buildupRate).
ALTER TABLE "rate_buildup_versions" ADD CONSTRAINT "rate_buildup_versions_values_check" CHECK (
  version_no >= 1 AND char_length(name) >= 3
  AND unit IN ('m3', 'm2', 'm', 'kg', 't', 'nr', 'item', 'ls', 'hr', 'day', 'week', 'month', 'l',
               'set', 'pair')
  AND line_count BETWEEN 1 AND 50 AND unpriced_lines BETWEEN 0 AND line_count
  AND priced_minor >= 0
  AND ((rate_minor IS NULL) = (unpriced_lines > 0))
  AND (rate_minor IS NULL OR rate_minor = priced_minor)
  AND rounding = 'half_up_line'
);

CREATE TABLE "rate_buildup_lines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "kind" VARCHAR(10) NOT NULL,
    "resource_name" VARCHAR(120) NOT NULL,
    "unit" VARCHAR(30) NOT NULL,
    "quantity" DECIMAL(15,6) NOT NULL,
    "waste_percent" DECIMAL(7,4),
    "unit_cost_minor" BIGINT,
    "amount_minor" BIGINT,

    CONSTRAINT "rate_buildup_lines_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "rate_buildup_lines_tenant_id_id_key" ON "rate_buildup_lines"("tenant_id", "id");
CREATE UNIQUE INDEX "rate_buildup_lines_tenant_id_version_id_line_no_key"
  ON "rate_buildup_lines"("tenant_id", "version_id", "line_no");
ALTER TABLE "rate_buildup_lines" ADD CONSTRAINT "rate_buildup_lines_tenant_id_version_id_fkey"
  FOREIGN KEY ("tenant_id", "version_id") REFERENCES "rate_buildup_versions"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
-- Each line: quantity × (1 + waste % / 100) × unit cost, rounded half-up to the cent
-- (PostgreSQL round(numeric) rounds a tie away from zero: half-up for these amounts).
ALTER TABLE "rate_buildup_lines" ADD CONSTRAINT "rate_buildup_lines_values_check" CHECK (
  kind IN ('material', 'labour', 'plant')
  AND char_length(resource_name) >= 1 AND char_length(unit) >= 1
  AND quantity > 0 AND (waste_percent IS NULL OR waste_percent BETWEEN 0 AND 100)
  AND line_no BETWEEN 1 AND 50
  AND ((unit_cost_minor IS NULL) = (amount_minor IS NULL))
  AND (unit_cost_minor IS NULL OR (
    unit_cost_minor >= 0
    AND amount_minor = round(quantity * (1 + COALESCE(waste_percent, 0) / 100) * unit_cost_minor)
  ))
);

-- A BQ item's link to a build-up version, by item lineage (it follows the item into later
-- versions). Never deleted: unlinking stamps unlinked_at/by; at most one active link per item.
CREATE TABLE "bq_item_rate_links" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "bq_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "item_lineage_id" UUID NOT NULL,
    "buildup_id" UUID NOT NULL,
    "buildup_version_id" UUID NOT NULL,
    "linked_by" UUID NOT NULL,
    "linked_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unlinked_by" UUID,
    "unlinked_at" TIMESTAMPTZ,

    CONSTRAINT "bq_item_rate_links_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "bq_item_rate_links_tenant_id_id_key" ON "bq_item_rate_links"("tenant_id", "id");
CREATE INDEX "bq_item_rate_links_tenant_id_bq_id_item_lineage_id_idx"
  ON "bq_item_rate_links"("tenant_id", "bq_id", "item_lineage_id");
CREATE INDEX "bq_item_rate_links_tenant_id_buildup_id_idx"
  ON "bq_item_rate_links"("tenant_id", "buildup_id");
CREATE UNIQUE INDEX "bq_item_rate_links_one_active"
  ON "bq_item_rate_links"("tenant_id", "bq_id", "item_lineage_id") WHERE unlinked_at IS NULL;
ALTER TABLE "bq_item_rate_links" ADD CONSTRAINT "bq_item_rate_links_tenant_id_project_id_bq_id_fkey"
  FOREIGN KEY ("tenant_id", "project_id", "bq_id") REFERENCES "bqs"("tenant_id", "project_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bq_item_rate_links" ADD CONSTRAINT "bq_item_rate_links_tenant_id_bq_id_version_id_fkey"
  FOREIGN KEY ("tenant_id", "bq_id", "version_id") REFERENCES "bq_versions"("tenant_id", "bq_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bq_item_rate_links" ADD CONSTRAINT "bq_item_rate_links_tenant_id_version_id_item_lineage_id_fkey"
  FOREIGN KEY ("tenant_id", "version_id", "item_lineage_id")
  REFERENCES "bq_items"("tenant_id", "version_id", "lineage_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bq_item_rate_links" ADD CONSTRAINT "bq_item_rate_links_tenant_id_buildup_id_buildup_version_id_fkey"
  FOREIGN KEY ("tenant_id", "buildup_id", "buildup_version_id")
  REFERENCES "rate_buildup_versions"("tenant_id", "buildup_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bq_item_rate_links" ADD CONSTRAINT "bq_item_rate_links_unlinked_check" CHECK (
  (unlinked_by IS NULL) = (unlinked_at IS NULL)
);

-- Version guard ----------------------------------------------------------------------------------
-- A version starts as a draft. An import version is version 1; a variation version is version_no
-- + 1 of an approved parent and references a submitted variation on that parent. A draft may be
-- rewritten (re-import) or approved, with an approver who is neither its creator nor its last
-- writer (CHECK bq_versions_approval_check) and, for a variation version, who decided the
-- variation. Approval does not change the totals. An approved version never changes again.
CREATE FUNCTION app.guard_bq_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent record;
  variation record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.approved_by IS NOT NULL THEN
      RAISE EXCEPTION 'A BQ version starts as a draft' USING ERRCODE = '23514';
    END IF;
    IF NEW.source = 'variation' THEN
      SELECT status, version_no INTO parent FROM bq_versions
        WHERE tenant_id = NEW.tenant_id AND bq_id = NEW.bq_id AND id = NEW.parent_version_id;
      IF NOT FOUND OR parent.status <> 'approved' THEN
        RAISE EXCEPTION 'A variation applies to an approved version' USING ERRCODE = '23514';
      END IF;
      IF NEW.version_no <> parent.version_no + 1 THEN
        RAISE EXCEPTION 'A variation version follows its parent' USING ERRCODE = '23514';
      END IF;
      SELECT status, base_version_id INTO variation FROM variation_orders
        WHERE tenant_id = NEW.tenant_id AND id = NEW.variation_id;
      IF NOT FOUND OR variation.status <> 'submitted'
         OR variation.base_version_id <> NEW.parent_version_id THEN
        RAISE EXCEPTION 'Only a submitted variation on the parent version creates a version'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'An approved BQ version never changes' USING ERRCODE = '23514';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.bq_id IS DISTINCT FROM OLD.bq_id OR NEW.version_no IS DISTINCT FROM OLD.version_no
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.parent_version_id IS DISTINCT FROM OLD.parent_version_id
     OR NEW.variation_id IS DISTINCT FROM OLD.variation_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'A BQ version keeps its identity and lineage' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'approved' THEN
    IF NEW.subtotal_minor IS DISTINCT FROM OLD.subtotal_minor
       OR NEW.vat_minor IS DISTINCT FROM OLD.vat_minor
       OR NEW.grand_total_minor IS DISTINCT FROM OLD.grand_total_minor
       OR NEW.vat_rate_percent IS DISTINCT FROM OLD.vat_rate_percent
       OR NEW.bill_count IS DISTINCT FROM OLD.bill_count
       OR NEW.item_count IS DISTINCT FROM OLD.item_count
       OR NEW.updated_by IS DISTINCT FROM OLD.updated_by THEN
      RAISE EXCEPTION 'Approval does not change a BQ version' USING ERRCODE = '23514';
    END IF;
    -- Nobody who made the imported baseline (uploaded, mapped, resolved or committed it) approves it.
    IF NEW.source = 'import' AND (NEW.approved_by IN (OLD.created_by, OLD.updated_by) OR EXISTS (
      SELECT 1 FROM bq_imports WHERE tenant_id = NEW.tenant_id AND bq_version_id = NEW.id
        AND NEW.approved_by = ANY (contributors)
    )) THEN
      RAISE EXCEPTION 'The baseline''s makers cannot approve it' USING ERRCODE = '23514';
    END IF;
    IF NEW.source = 'variation' THEN
      SELECT status, decided_by INTO variation FROM variation_orders
        WHERE tenant_id = NEW.tenant_id AND id = NEW.variation_id;
      IF NOT FOUND OR variation.status <> 'approved' OR variation.decided_by <> NEW.approved_by THEN
        RAISE EXCEPTION 'A variation version is approved with its variation' USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSIF NEW.status <> 'draft' THEN
    RAISE EXCEPTION 'BQ version status cannot change from % to %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER bq_version_guard BEFORE INSERT OR UPDATE ON "bq_versions"
  FOR EACH ROW EXECUTE FUNCTION app.guard_bq_version();

-- Variation guard: packages/domain VARIATION_TRANSITIONS / VARIATION_STATUS_CHANGES -----------------
CREATE FUNCTION app.guard_variation_order() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  base_status text;
  instruction_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'A variation starts as a draft' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.project_id IS DISTINCT FROM OLD.project_id
       OR NEW.bq_id IS DISTINCT FROM OLD.bq_id OR NEW.number IS DISTINCT FROM OLD.number
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'A variation keeps its identity' USING ERRCODE = '23514';
    END IF;
    IF OLD.status IN ('approved', 'cancelled') THEN
      RAISE EXCEPTION 'A % variation never changes', OLD.status USING ERRCODE = '23514';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND (OLD.status, NEW.status) NOT IN (
      ('draft', 'submitted'), ('submitted', 'approved'), ('submitted', 'rejected'),
      ('rejected', 'draft'), ('draft', 'cancelled'), ('submitted', 'draft')
    ) THEN
      RAISE EXCEPTION 'Variation status cannot change from % to %', OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;
    -- Submitted and rejected variations are frozen; only a transition moves them.
    IF OLD.status IN ('submitted', 'rejected') AND NEW.status = OLD.status THEN
      RAISE EXCEPTION 'A % variation cannot change', OLD.status USING ERRCODE = '23514';
    END IF;
    IF OLD.status <> 'draft' AND NEW.status IN ('approved', 'rejected') AND (
      NEW.instruction_id IS DISTINCT FROM OLD.instruction_id
      OR NEW.base_version_id IS DISTINCT FROM OLD.base_version_id
      OR NEW.title IS DISTINCT FROM OLD.title OR NEW.description IS DISTINCT FROM OLD.description
      OR NEW.additions_minor IS DISTINCT FROM OLD.additions_minor
      OR NEW.omissions_minor IS DISTINCT FROM OLD.omissions_minor
      OR NEW.line_count IS DISTINCT FROM OLD.line_count
      OR NEW.snapshot_digest IS DISTINCT FROM OLD.snapshot_digest
      OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
      OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
    ) THEN
      RAISE EXCEPTION 'A decision does not change the submitted proposal' USING ERRCODE = '23514';
    END IF;
    -- Only a rebase (a new base) returns a submitted variation to draft.
    IF OLD.status = 'submitted' AND NEW.status = 'draft'
       AND NEW.base_version_id IS NOT DISTINCT FROM OLD.base_version_id THEN
      RAISE EXCEPTION 'Only a rebase returns a submitted variation to draft' USING ERRCODE = '23514';
    END IF;
    IF NEW.base_version_id IS DISTINCT FROM OLD.base_version_id AND NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'Only a draft variation changes its base' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'approved' AND NOT EXISTS (
      SELECT 1 FROM bq_versions WHERE tenant_id = NEW.tenant_id AND variation_id = NEW.id
        AND parent_version_id = NEW.base_version_id
    ) THEN
      RAISE EXCEPTION 'An approved variation creates its BQ version' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.base_version_id IS DISTINCT FROM OLD.base_version_id THEN
    SELECT status INTO base_status FROM bq_versions
      WHERE tenant_id = NEW.tenant_id AND bq_id = NEW.bq_id AND id = NEW.base_version_id;
    IF base_status IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION 'A variation is based on an approved version' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.instruction_id IS DISTINCT FROM OLD.instruction_id THEN
    SELECT status INTO instruction_status FROM instructions
      WHERE tenant_id = NEW.tenant_id AND id = NEW.instruction_id;
    IF instruction_status IS DISTINCT FROM 'open' THEN
      RAISE EXCEPTION 'A variation needs an open instruction' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER variation_order_guard BEFORE INSERT OR UPDATE ON "variation_orders"
  FOR EACH ROW EXECUTE FUNCTION app.guard_variation_order();

-- At commit, an approved variation's version is approved too (same transaction).
CREATE FUNCTION app.check_variation_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'approved' AND NOT EXISTS (
    SELECT 1 FROM bq_versions WHERE tenant_id = NEW.tenant_id AND variation_id = NEW.id
      AND status = 'approved' AND approved_by = NEW.decided_by
  ) THEN
    RAISE EXCEPTION 'An approved variation has an approved BQ version' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER variation_order_version AFTER INSERT OR UPDATE ON "variation_orders"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_variation_version();

-- Lines change only while their variation is a draft.
CREATE FUNCTION app.guard_variation_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT status INTO parent_status FROM variation_orders
      WHERE tenant_id = OLD.tenant_id AND id = OLD.variation_id;
  ELSE
    SELECT status INTO parent_status FROM variation_orders
      WHERE tenant_id = NEW.tenant_id AND id = NEW.variation_id;
  END IF;
  IF parent_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Variation lines change only while the variation is a draft'
      USING ERRCODE = '23514';
  END IF;
  -- Whoever writes a line contributes to the proposal (maker-checker by identity).
  IF app.current_user_id() IS NOT NULL THEN
    UPDATE variation_orders SET contributors = contributors || app.current_user_id()
      WHERE tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id)
        AND id = COALESCE(NEW.variation_id, OLD.variation_id)
        AND NOT (app.current_user_id() = ANY (contributors));
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER variation_line_guard BEFORE INSERT OR UPDATE OR DELETE ON "variation_lines"
  FOR EACH ROW EXECUTE FUNCTION app.guard_variation_line();

-- Build-up versions and lines are re-checked when the transaction that wrote them commits: the
-- version's priced total, unpriced count and line count equal its lines (so no line can be added
-- to an existing version later), and the build-up's current version is its newest one.
CREATE FUNCTION app.check_buildup_version_of(target_tenant uuid, target_version uuid)
  RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  stored record;
  lines_total numeric;
  lines_unpriced integer;
  lines_count integer;
BEGIN
  SELECT priced_minor, unpriced_lines, line_count INTO stored FROM rate_buildup_versions
    WHERE tenant_id = target_tenant AND id = target_version;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT COALESCE(sum(amount_minor), 0), count(*) FILTER (WHERE unit_cost_minor IS NULL), count(*)
    INTO lines_total, lines_unpriced, lines_count
    FROM rate_buildup_lines WHERE tenant_id = target_tenant AND version_id = target_version;
  IF lines_total <> stored.priced_minor OR lines_unpriced <> stored.unpriced_lines
     OR lines_count <> stored.line_count THEN
    RAISE EXCEPTION 'Build-up version totals do not match its lines' USING ERRCODE = '23514';
  END IF;
END
$$;
CREATE FUNCTION app.check_buildup_totals() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'rate_buildup_versions' THEN
    PERFORM app.check_buildup_version_of(NEW.tenant_id, NEW.id);
  ELSIF TG_TABLE_NAME = 'rate_buildup_lines' THEN
    PERFORM app.check_buildup_version_of(NEW.tenant_id, NEW.version_id);
  ELSIF NOT EXISTS (
    SELECT 1 FROM rate_buildup_versions v WHERE v.tenant_id = NEW.tenant_id
      AND v.buildup_id = NEW.id AND v.version_no = NEW.current_version_no
      AND v.unit = NEW.unit AND v.name = NEW.name
  ) OR EXISTS (
    SELECT 1 FROM rate_buildup_versions v WHERE v.tenant_id = NEW.tenant_id
      AND v.buildup_id = NEW.id AND v.version_no > NEW.current_version_no
  ) THEN
    RAISE EXCEPTION 'A build-up shows its newest version' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER rate_buildup_current AFTER INSERT OR UPDATE ON "rate_buildups"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_buildup_totals();
CREATE CONSTRAINT TRIGGER rate_buildup_version_totals AFTER INSERT ON "rate_buildup_versions"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_buildup_totals();
CREATE CONSTRAINT TRIGGER rate_buildup_line_totals AFTER INSERT ON "rate_buildup_lines"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_buildup_totals();

-- Rate links: only the unlink stamp may be set, once.
CREATE FUNCTION app.guard_bq_item_rate_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.unlinked_at IS NOT NULL
     OR NEW.unlinked_at IS NULL
     OR (to_jsonb(NEW) - 'unlinked_at' - 'unlinked_by')
        IS DISTINCT FROM (to_jsonb(OLD) - 'unlinked_at' - 'unlinked_by') THEN
    RAISE EXCEPTION 'A build-up link is never edited; unlink it and link again'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER bq_item_rate_link_guard BEFORE UPDATE ON "bq_item_rate_links"
  FOR EACH ROW EXECUTE FUNCTION app.guard_bq_item_rate_link();

-- Row-level security -----------------------------------------------------------------------------
ALTER TABLE "instructions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "instructions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "variation_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "variation_orders" FORCE ROW LEVEL SECURITY;
ALTER TABLE "variation_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "variation_lines" FORCE ROW LEVEL SECURITY;
ALTER TABLE "variation_status_changes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "variation_status_changes" FORCE ROW LEVEL SECURITY;
ALTER TABLE "rate_buildups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rate_buildups" FORCE ROW LEVEL SECURITY;
ALTER TABLE "rate_buildup_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rate_buildup_versions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "rate_buildup_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rate_buildup_lines" FORCE ROW LEVEL SECURITY;
ALTER TABLE "bq_item_rate_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bq_item_rate_links" FORCE ROW LEVEL SECURITY;

CREATE POLICY instructions_isolation ON instructions
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY variation_orders_isolation ON variation_orders
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY variation_lines_isolation ON variation_lines
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY variation_status_changes_isolation ON variation_status_changes
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY rate_buildups_isolation ON rate_buildups
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY rate_buildup_versions_isolation ON rate_buildup_versions
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY rate_buildup_lines_isolation ON rate_buildup_lines
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY bq_item_rate_links_isolation ON bq_item_rate_links
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

-- History is never deleted by the runtime role; status changes, build-up versions and their lines
-- are append-only. Variation lines may be deleted (drafts only, app.guard_variation_line).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmb_app') THEN
    REVOKE DELETE ON "instructions", "variation_orders", "variation_status_changes", "rate_buildups",
      "rate_buildup_versions", "rate_buildup_lines", "bq_item_rate_links" FROM pmb_app;
    REVOKE UPDATE ON "variation_status_changes", "rate_buildup_versions", "rate_buildup_lines"
      FROM pmb_app;
    REVOKE TRUNCATE, REFERENCES, TRIGGER
      ON "instructions", "variation_orders", "variation_lines", "variation_status_changes",
         "rate_buildups", "rate_buildup_versions", "rate_buildup_lines", "bq_item_rate_links"
      FROM pmb_app;
  END IF;
END
$$;
REVOKE EXECUTE ON FUNCTION app.guard_bq_version() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_variation_order() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_variation_version() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_variation_line() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_buildup_version_of(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_buildup_totals() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_bq_item_rate_link() FROM PUBLIC;

-- Maker-checker by identity ---------------------------------------------------------------------
-- Every user who writes a variation's proposal (creates, edits, saves lines, submits, reopens or
-- rebases it) or an import (uploads, maps, resolves, validates or commits it) is recorded, and the
-- lists only grow. Nobody on a variation's list may decide on it, and nobody on the import's list
-- may approve the baseline it produced (the API refuses first; these rules hold for any writer).
ALTER TABLE "bq_imports" ADD COLUMN "contributors" UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE "bq_imports" NO FORCE ROW LEVEL SECURITY;
UPDATE "bq_imports" SET "contributors" =
  array_remove(ARRAY["uploaded_by", "committed_by"], NULL);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "bq_imports" WHERE NOT ("uploaded_by" = ANY ("contributors"))) THEN
    RAISE EXCEPTION 'bq_imports.contributors backfill is incomplete';
  END IF;
END $$;
ALTER TABLE "bq_imports" FORCE ROW LEVEL SECURITY;

CREATE FUNCTION app.add_contributors(current_list uuid[], VARIADIC people uuid[]) RETURNS uuid[]
  LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(current_list, '{}') || COALESCE(ARRAY(
    SELECT DISTINCT person FROM unnest(people) AS person
    WHERE person IS NOT NULL AND NOT (person = ANY (COALESCE(current_list, '{}')))
  ), '{}')
$$;

CREATE FUNCTION app.record_variation_contributors() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NOT (NEW.contributors @> OLD.contributors) THEN
    RAISE EXCEPTION 'A variation''s contributors are only ever added' USING ERRCODE = '23514';
  END IF;
  -- Deciding on or cancelling a variation does not make that person a contributor.
  IF NEW.status IN ('approved', 'rejected', 'cancelled') THEN
    RETURN NEW;
  END IF;
  NEW.contributors := app.add_contributors(
    NEW.contributors, NEW.created_by, NEW.updated_by, NEW.submitted_by, app.current_user_id()
  );
  RETURN NEW;
END
$$;
CREATE TRIGGER variation_order_contributors BEFORE INSERT OR UPDATE ON "variation_orders"
  FOR EACH ROW EXECUTE FUNCTION app.record_variation_contributors();

CREATE FUNCTION app.record_import_contributors() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NOT (NEW.contributors @> OLD.contributors) THEN
    RAISE EXCEPTION 'An import''s contributors are only ever added' USING ERRCODE = '23514';
  END IF;
  NEW.contributors := app.add_contributors(
    NEW.contributors, NEW.uploaded_by, NEW.committed_by, app.current_user_id()
  );
  RETURN NEW;
END
$$;
CREATE TRIGGER bq_import_contributors BEFORE INSERT OR UPDATE ON "bq_imports"
  FOR EACH ROW EXECUTE FUNCTION app.record_import_contributors();

-- Approved content never moves: an UPDATE may not change a row's version or lineage, and the row's
-- current version must be a draft (the D2.2 guard only checked the new version, so content could
-- be re-pointed out of an approved version).
CREATE OR REPLACE FUNCTION app.guard_bq_version_content() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_status text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT status INTO target_status FROM bq_versions
      WHERE tenant_id = OLD.tenant_id AND id = OLD.version_id;
    IF target_status IS NOT NULL AND target_status <> 'draft' THEN
      RAISE EXCEPTION 'Only a draft BQ version can change' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.version_id IS DISTINCT FROM OLD.version_id
       OR to_jsonb(NEW) -> 'lineage_id' IS DISTINCT FROM to_jsonb(OLD) -> 'lineage_id' THEN
      RAISE EXCEPTION 'BQ content keeps its version and lineage' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT status INTO target_status FROM bq_versions
    WHERE tenant_id = NEW.tenant_id AND id = NEW.version_id;
  IF target_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Only a draft BQ version can change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

-- The totals check also re-validates the version a row left (defence in depth).
CREATE OR REPLACE FUNCTION app.check_bq_version_totals() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'bq_versions' THEN
    PERFORM app.check_bq_version_totals_of(NEW.tenant_id, NEW.id);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM app.check_bq_version_totals_of(OLD.tenant_id, OLD.version_id);
  ELSE
    PERFORM app.check_bq_version_totals_of(NEW.tenant_id, NEW.version_id);
    IF TG_OP = 'UPDATE' AND OLD.version_id IS DISTINCT FROM NEW.version_id THEN
      PERFORM app.check_bq_version_totals_of(OLD.tenant_id, OLD.version_id);
    END IF;
  END IF;
  RETURN NULL;
END
$$;

REVOKE EXECUTE ON FUNCTION app.add_contributors(uuid[], uuid[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.record_variation_contributors() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.record_import_contributors() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.add_contributors(uuid[], uuid[]) TO pmb_app;

COMMIT;
