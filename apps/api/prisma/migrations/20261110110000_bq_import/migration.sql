-- D2.2 BQ import (ARCHITECTURE §4 bq module, ERD §4, brief §15 C/F/G).
-- * bq_mapping_templates: saved column mappings per company, matched by header signature.
-- * bq_imports: one row per uploaded workbook. It keeps the source (private object key, SHA-256,
--   size, sanitised name, uploader, malware-scan result), the parsed sheet summaries, the confirmed
--   mapping, the validation report and its digest, the per-row resolutions and accepted warnings,
--   and the BQ version it produced. Its status follows packages/domain BQ_IMPORT_TRANSITIONS
--   (app.guard_bq_import); the source columns never change and imports are never deleted.
-- * bqs, bq_versions, bq_bills, bq_sections, bq_items: Bill → Section/Element → Item. D2.2 creates
--   the project's original-contract BQ as version 1 in draft; a re-import replaces a draft's
--   content in one transaction. Content of a version that is not a draft cannot change
--   (app.guard_bq_version_content). Each item's computed amount is quantity × rate rounded half-up
--   to the cent (CHECK), and the version's totals are checked against its bills and items when any
--   transaction that wrote them commits (deferred constraint triggers, app.check_bq_version_totals).
-- Every new table has tenant_id, forced RLS with WITH CHECK, and composite (tenant_id, …) foreign
-- keys for every tenant-to-tenant reference, including to the project.
BEGIN;

-- Mapping templates ------------------------------------------------------------------------------
CREATE TABLE "bq_mapping_templates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "signature" VARCHAR(500) NOT NULL,
    "columns" JSONB NOT NULL,
    "data_offset" INTEGER NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bq_mapping_templates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "bq_mapping_templates_tenant_id_id_key" ON "bq_mapping_templates"("tenant_id", "id");
CREATE UNIQUE INDEX "bq_mapping_templates_tenant_id_name_key" ON "bq_mapping_templates"("tenant_id", "name");
CREATE INDEX "bq_mapping_templates_tenant_id_signature_idx" ON "bq_mapping_templates"("tenant_id", "signature");
ALTER TABLE "bq_mapping_templates" ADD CONSTRAINT "bq_mapping_templates_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bq_mapping_templates" ADD CONSTRAINT "bq_mapping_templates_name_check" CHECK (
  char_length(name) >= 1 AND name = btrim(name)
);
ALTER TABLE "bq_mapping_templates" ADD CONSTRAINT "bq_mapping_templates_signature_check" CHECK (
  char_length(signature) >= 1
);
ALTER TABLE "bq_mapping_templates" ADD CONSTRAINT "bq_mapping_templates_columns_check" CHECK (
  jsonb_typeof(columns) = 'object' AND columns ? 'description'
);
ALTER TABLE "bq_mapping_templates" ADD CONSTRAINT "bq_mapping_templates_data_offset_check" CHECK (
  data_offset BETWEEN 1 AND 20
);

-- BQ and versions --------------------------------------------------------------------------------
CREATE TABLE "bqs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bqs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "bqs_tenant_id_id_key" ON "bqs"("tenant_id", "id");
-- One BQ per project; its versions carry the history (D2.3 adds variations and revisions).
CREATE UNIQUE INDEX "bqs_tenant_id_project_id_key" ON "bqs"("tenant_id", "project_id");
CREATE UNIQUE INDEX "bqs_tenant_id_project_id_id_key" ON "bqs"("tenant_id", "project_id", "id");
ALTER TABLE "bqs" ADD CONSTRAINT "bqs_tenant_id_project_id_fkey"
  FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bqs" ADD CONSTRAINT "bqs_name_check" CHECK (char_length(name) >= 1 AND name = btrim(name));

CREATE TABLE "bq_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "bq_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'draft',
    "source" VARCHAR(20) NOT NULL DEFAULT 'import',
    "vat_rate_percent" DECIMAL(7,4) NOT NULL,
    "vat_rule_key" VARCHAR(40) NOT NULL,
    "vat_rule_status" VARCHAR(30) NOT NULL,
    "rounding" VARCHAR(20) NOT NULL,
    "subtotal_minor" BIGINT NOT NULL,
    "vat_minor" BIGINT NOT NULL,
    "grand_total_minor" BIGINT NOT NULL,
    "bill_count" INTEGER NOT NULL,
    "item_count" INTEGER NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "bq_versions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "bq_versions_tenant_id_id_key" ON "bq_versions"("tenant_id", "id");
CREATE UNIQUE INDEX "bq_versions_tenant_id_bq_id_version_no_key" ON "bq_versions"("tenant_id", "bq_id", "version_no");
CREATE INDEX "bq_versions_tenant_id_project_id_idx" ON "bq_versions"("tenant_id", "project_id");
-- The version's project is its BQ's project.
ALTER TABLE "bq_versions" ADD CONSTRAINT "bq_versions_tenant_id_project_id_bq_id_fkey"
  FOREIGN KEY ("tenant_id", "project_id", "bq_id") REFERENCES "bqs"("tenant_id", "project_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
-- packages/types BQ_VERSION_STATUSES
ALTER TABLE "bq_versions" ADD CONSTRAINT "bq_versions_status_check" CHECK (
  status IN ('draft', 'approved', 'superseded')
);
ALTER TABLE "bq_versions" ADD CONSTRAINT "bq_versions_source_check" CHECK (
  source IN ('import', 'variation', 'manual')
);
ALTER TABLE "bq_versions" ADD CONSTRAINT "bq_versions_version_no_check" CHECK (version_no >= 1);
ALTER TABLE "bq_versions" ADD CONSTRAINT "bq_versions_vat_rate_check" CHECK (
  vat_rate_percent >= 0 AND vat_rate_percent <= 100
);
-- packages/types BQ_ROUNDING: half-up to the cent per line (FINANCIAL_MODEL.md)
ALTER TABLE "bq_versions" ADD CONSTRAINT "bq_versions_rounding_check" CHECK (rounding = 'half_up_line');
-- VAT is computed once on the subtotal, half-up to the cent (PostgreSQL round(numeric) rounds a
-- tie away from zero, which is half-up for these non-negative amounts).
ALTER TABLE "bq_versions" ADD CONSTRAINT "bq_versions_totals_check" CHECK (
  grand_total_minor = subtotal_minor + vat_minor
  AND vat_minor = round(subtotal_minor * vat_rate_percent / 100)
  AND grand_total_minor BETWEEN -9007199254740991 AND 9007199254740991
);
ALTER TABLE "bq_versions" ADD CONSTRAINT "bq_versions_counts_check" CHECK (
  bill_count >= 0 AND item_count >= 0
);
ALTER TABLE "bq_versions" ADD CONSTRAINT "bq_versions_version_check" CHECK (version >= 1);

-- Bills, sections and items ----------------------------------------------------------------------
CREATE TABLE "bq_bills" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "number" VARCHAR(20) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "total_minor" BIGINT NOT NULL,
    "sheet_total_minor" BIGINT,
    "source_sheet" VARCHAR(100) NOT NULL,

    CONSTRAINT "bq_bills_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "bq_bills_tenant_id_version_id_id_key" ON "bq_bills"("tenant_id", "version_id", "id");
CREATE UNIQUE INDEX "bq_bills_tenant_id_version_id_number_key" ON "bq_bills"("tenant_id", "version_id", "number");
CREATE INDEX "bq_bills_tenant_id_version_id_sort_order_idx" ON "bq_bills"("tenant_id", "version_id", "sort_order");
ALTER TABLE "bq_bills" ADD CONSTRAINT "bq_bills_tenant_id_version_id_fkey"
  FOREIGN KEY ("tenant_id", "version_id") REFERENCES "bq_versions"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
-- packages/types BQ_BILL_KINDS
ALTER TABLE "bq_bills" ADD CONSTRAINT "bq_bills_kind_check" CHECK (
  kind IN ('preliminaries', 'measured', 'provisional', 'dayworks', 'contingency')
);
ALTER TABLE "bq_bills" ADD CONSTRAINT "bq_bills_text_check" CHECK (
  char_length(number) >= 1 AND number = btrim(number) AND char_length(title) >= 1
);
ALTER TABLE "bq_bills" ADD CONSTRAINT "bq_bills_sort_order_check" CHECK (sort_order >= 0);

CREATE TABLE "bq_sections" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "bill_id" UUID NOT NULL,
    "code" VARCHAR(30),
    "title" VARCHAR(300),
    "notes" VARCHAR(4000),
    "sort_order" INTEGER NOT NULL,
    "total_minor" BIGINT NOT NULL,

    CONSTRAINT "bq_sections_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "bq_sections_tenant_id_version_id_id_key" ON "bq_sections"("tenant_id", "version_id", "id");
CREATE INDEX "bq_sections_tenant_id_version_id_bill_id_sort_order_idx"
  ON "bq_sections"("tenant_id", "version_id", "bill_id", "sort_order");
ALTER TABLE "bq_sections" ADD CONSTRAINT "bq_sections_tenant_id_version_id_bill_id_fkey"
  FOREIGN KEY ("tenant_id", "version_id", "bill_id") REFERENCES "bq_bills"("tenant_id", "version_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bq_sections" ADD CONSTRAINT "bq_sections_sort_order_check" CHECK (sort_order >= 0);

CREATE TABLE "bq_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "bill_id" UUID NOT NULL,
    "section_id" UUID,
    "lineage_id" UUID NOT NULL,
    "ref" VARCHAR(30),
    "description" VARCHAR(4000) NOT NULL,
    "unit" VARCHAR(10),
    "unit_raw" VARCHAR(30),
    "quantity" DECIMAL(20,4),
    "rate" DECIMAL(20,4),
    "amount_minor" BIGINT NOT NULL,
    "sheet_amount_minor" BIGINT,
    "amount_source" VARCHAR(20) NOT NULL,
    "override_reason" VARCHAR(500),
    "kind" VARCHAR(20) NOT NULL,
    "notes" VARCHAR(1000),
    "source_sheet" VARCHAR(100) NOT NULL,
    "source_row" INTEGER NOT NULL,
    "has_formula" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL,

    CONSTRAINT "bq_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "bq_items_tenant_id_id_key" ON "bq_items"("tenant_id", "id");
CREATE INDEX "bq_items_tenant_id_version_id_bill_id_sort_order_idx"
  ON "bq_items"("tenant_id", "version_id", "bill_id", "sort_order");
CREATE INDEX "bq_items_tenant_id_version_id_section_id_idx"
  ON "bq_items"("tenant_id", "version_id", "section_id");
ALTER TABLE "bq_items" ADD CONSTRAINT "bq_items_tenant_id_version_id_bill_id_fkey"
  FOREIGN KEY ("tenant_id", "version_id", "bill_id") REFERENCES "bq_bills"("tenant_id", "version_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bq_items" ADD CONSTRAINT "bq_items_tenant_id_version_id_section_id_fkey"
  FOREIGN KEY ("tenant_id", "version_id", "section_id") REFERENCES "bq_sections"("tenant_id", "version_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
-- packages/types BQ_ITEM_KINDS, BQ_AMOUNT_SOURCES, BQ_UNITS
ALTER TABLE "bq_items" ADD CONSTRAINT "bq_items_kind_check" CHECK (
  kind IN ('measured', 'preliminary', 'provisional_sum', 'pc_sum', 'pc_attendance', 'pc_profit',
           'contingency', 'daywork')
);
ALTER TABLE "bq_items" ADD CONSTRAINT "bq_items_amount_source_check" CHECK (
  amount_source IN ('computed', 'percentage', 'lump_sum', 'sheet_override', 'unpriced', 'included')
);
ALTER TABLE "bq_items" ADD CONSTRAINT "bq_items_unit_check" CHECK (
  unit IS NULL OR unit IN ('m3', 'm2', 'm', 'kg', 't', 'nr', 'item', 'ls', 'pct', 'hr', 'day',
                           'week', 'month', 'l', 'set', 'pair', 'other')
);
ALTER TABLE "bq_items" ADD CONSTRAINT "bq_items_description_check" CHECK (char_length(description) >= 1);
ALTER TABLE "bq_items" ADD CONSTRAINT "bq_items_quantity_check" CHECK (quantity IS NULL OR quantity >= 0);
ALTER TABLE "bq_items" ADD CONSTRAINT "bq_items_amount_range_check" CHECK (
  amount_minor BETWEEN -100000000000000 AND 100000000000000
);
-- How each amount was obtained (packages/domain bq/bill.ts). A computed line is quantity × rate
-- rounded half-up to the cent; a sheet override keeps the sheet's amount and needs a reason; a
-- lump sum is the sheet's amount on a line without a rate.
ALTER TABLE "bq_items" ADD CONSTRAINT "bq_items_amount_rule_check" CHECK (
  CASE amount_source
    WHEN 'computed' THEN quantity IS NOT NULL AND rate IS NOT NULL
      AND amount_minor = round(quantity * rate * 100)
    WHEN 'sheet_override' THEN sheet_amount_minor IS NOT NULL AND amount_minor = sheet_amount_minor
      AND override_reason IS NOT NULL AND char_length(btrim(override_reason)) >= 3
    WHEN 'lump_sum' THEN rate IS NULL AND sheet_amount_minor IS NOT NULL
      AND amount_minor = sheet_amount_minor
    WHEN 'percentage' THEN unit = 'pct' AND quantity IS NOT NULL
    ELSE amount_minor = 0
  END
);
ALTER TABLE "bq_items" ADD CONSTRAINT "bq_items_override_reason_check" CHECK (
  override_reason IS NULL OR amount_source = 'sheet_override'
);
ALTER TABLE "bq_items" ADD CONSTRAINT "bq_items_source_row_check" CHECK (source_row >= 1);
ALTER TABLE "bq_items" ADD CONSTRAINT "bq_items_sort_order_check" CHECK (sort_order >= 0);

-- Imports ----------------------------------------------------------------------------------------
CREATE TABLE "bq_imports" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'uploaded',
    "file_name" VARCHAR(150) NOT NULL,
    "file_type" VARCHAR(4) NOT NULL,
    "file_size_bytes" INTEGER NOT NULL,
    "file_sha256" CHAR(64) NOT NULL,
    "source_key" VARCHAR(300) NOT NULL,
    "parsed_key" VARCHAR(300),
    "scan_status" VARCHAR(20) NOT NULL,
    "scan_engine" VARCHAR(60) NOT NULL,
    "scanned_at" TIMESTAMPTZ NOT NULL,
    "failure_code" VARCHAR(40),
    "sheets" JSONB,
    "mapping" JSONB,
    "resolutions" JSONB NOT NULL DEFAULT '{"rows": [], "accepted": []}',
    "report" JSONB,
    "report_digest" CHAR(64),
    "bq_version_id" UUID,
    "uploaded_by" UUID NOT NULL,
    "committed_by" UUID,
    "committed_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bq_imports_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "bq_imports_tenant_id_id_key" ON "bq_imports"("tenant_id", "id");
CREATE INDEX "bq_imports_tenant_id_project_id_created_at_idx"
  ON "bq_imports"("tenant_id", "project_id", "created_at");
CREATE INDEX "bq_imports_tenant_id_bq_version_id_idx" ON "bq_imports"("tenant_id", "bq_version_id");
-- At most one import is the current source of a version.
CREATE UNIQUE INDEX "bq_imports_one_committed_per_version"
  ON "bq_imports"("tenant_id", "bq_version_id") WHERE status = 'committed';
ALTER TABLE "bq_imports" ADD CONSTRAINT "bq_imports_tenant_id_project_id_fkey"
  FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bq_imports" ADD CONSTRAINT "bq_imports_tenant_id_bq_version_id_fkey"
  FOREIGN KEY ("tenant_id", "bq_version_id") REFERENCES "bq_versions"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
-- packages/types BQ_IMPORT_STATUSES, BQ_FILE_TYPES, BQ_SCAN_STATUSES, BQ_IMPORT_FAILURES
ALTER TABLE "bq_imports" ADD CONSTRAINT "bq_imports_status_check" CHECK (
  status IN ('uploaded', 'parsed', 'mapped', 'validated', 'committed', 'failed', 'abandoned',
             'superseded')
);
ALTER TABLE "bq_imports" ADD CONSTRAINT "bq_imports_file_type_check" CHECK (file_type IN ('xlsx', 'xls'));
-- packages/types BQ_IMPORT_LIMITS.maxFileBytes (10 MB)
ALTER TABLE "bq_imports" ADD CONSTRAINT "bq_imports_file_size_check" CHECK (
  file_size_bytes BETWEEN 1 AND 10485760
);
ALTER TABLE "bq_imports" ADD CONSTRAINT "bq_imports_sha256_check" CHECK (file_sha256 ~ '^[0-9a-f]{64}$');
ALTER TABLE "bq_imports" ADD CONSTRAINT "bq_imports_file_name_check" CHECK (char_length(file_name) >= 1);
-- Object keys are generated by the API under the tenant and project, never from a file name.
ALTER TABLE "bq_imports" ADD CONSTRAINT "bq_imports_source_key_check" CHECK (
  source_key = 'tenants/' || tenant_id || '/projects/' || project_id || '/bq-imports/' || id
    || '/source.' || file_type
);
ALTER TABLE "bq_imports" ADD CONSTRAINT "bq_imports_parsed_key_check" CHECK (
  parsed_key IS NULL
  OR parsed_key = 'tenants/' || tenant_id || '/projects/' || project_id || '/bq-imports/' || id
    || '/parsed.json.gz'
);
ALTER TABLE "bq_imports" ADD CONSTRAINT "bq_imports_scan_check" CHECK (scan_status IN ('clean', 'not_scanned'));
ALTER TABLE "bq_imports" ADD CONSTRAINT "bq_imports_failure_check" CHECK (
  (status = 'failed') = (failure_code IS NOT NULL)
  AND (failure_code IS NULL OR failure_code IN (
    'workbook-encrypted', 'workbook-unreadable', 'too-many-sheets', 'too-many-rows',
    'too-many-columns', 'too-many-cells', 'parse-timeout', 'parse-memory', 'no-sheets'
  ))
);
-- What each stage has produced (a parse, a mapping, a validated report, a committed version).
ALTER TABLE "bq_imports" ADD CONSTRAINT "bq_imports_stage_check" CHECK (
  (status IN ('uploaded', 'failed', 'abandoned') OR (parsed_key IS NOT NULL AND sheets IS NOT NULL))
  AND (status NOT IN ('mapped', 'validated', 'committed', 'superseded') OR mapping IS NOT NULL)
  AND (status NOT IN ('validated', 'committed', 'superseded')
       OR (report IS NOT NULL AND report_digest ~ '^[0-9a-f]{64}$'))
  AND ((status IN ('committed', 'superseded'))
       = (bq_version_id IS NOT NULL AND committed_by IS NOT NULL AND committed_at IS NOT NULL))
);
ALTER TABLE "bq_imports" ADD CONSTRAINT "bq_imports_version_check" CHECK (version >= 1);

-- Database backstop for packages/domain BQ_IMPORT_TRANSITIONS. The source of an import never
-- changes; a failed, abandoned or superseded import is read-only; a committed import can only be
-- superseded.
CREATE FUNCTION app.guard_bq_import() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'uploaded' THEN
      RAISE EXCEPTION 'A BQ import starts as uploaded' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.file_name IS DISTINCT FROM OLD.file_name
     OR NEW.file_type IS DISTINCT FROM OLD.file_type
     OR NEW.file_size_bytes IS DISTINCT FROM OLD.file_size_bytes
     OR NEW.file_sha256 IS DISTINCT FROM OLD.file_sha256
     OR NEW.source_key IS DISTINCT FROM OLD.source_key
     OR NEW.scan_status IS DISTINCT FROM OLD.scan_status
     OR NEW.scan_engine IS DISTINCT FROM OLD.scan_engine
     OR NEW.scanned_at IS DISTINCT FROM OLD.scanned_at
     OR NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'The source of a BQ import never changes' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('failed', 'abandoned', 'superseded') THEN
    RAISE EXCEPTION 'A % BQ import is read-only', OLD.status USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'committed' AND (
    NEW.status <> 'superseded' OR NEW.mapping IS DISTINCT FROM OLD.mapping
    OR NEW.report IS DISTINCT FROM OLD.report OR NEW.resolutions IS DISTINCT FROM OLD.resolutions
    OR NEW.bq_version_id IS DISTINCT FROM OLD.bq_version_id
  ) THEN
    RAISE EXCEPTION 'A committed BQ import can only be superseded' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND (OLD.status, NEW.status) NOT IN (
    ('uploaded', 'parsed'), ('uploaded', 'failed'), ('uploaded', 'abandoned'),
    ('parsed', 'mapped'), ('parsed', 'abandoned'),
    ('mapped', 'validated'), ('mapped', 'abandoned'),
    ('validated', 'mapped'), ('validated', 'committed'), ('validated', 'abandoned'),
    ('committed', 'superseded')
  ) THEN
    RAISE EXCEPTION 'BQ import status cannot change from % to %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER bq_import_guard BEFORE INSERT OR UPDATE ON "bq_imports"
  FOR EACH ROW EXECUTE FUNCTION app.guard_bq_import();

-- Only a draft version's bills, sections and items can be written (approval arrives in D2.3).
CREATE FUNCTION app.guard_bq_version_content() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT status INTO target_status FROM bq_versions
      WHERE tenant_id = OLD.tenant_id AND id = OLD.version_id;
    IF target_status IS NOT NULL AND target_status <> 'draft' THEN
      RAISE EXCEPTION 'Only a draft BQ version can change' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  SELECT status INTO target_status FROM bq_versions
    WHERE tenant_id = NEW.tenant_id AND id = NEW.version_id;
  IF target_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Only a draft BQ version can change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER bq_bills_draft_only BEFORE INSERT OR UPDATE OR DELETE ON "bq_bills"
  FOR EACH ROW EXECUTE FUNCTION app.guard_bq_version_content();
CREATE TRIGGER bq_sections_draft_only BEFORE INSERT OR UPDATE OR DELETE ON "bq_sections"
  FOR EACH ROW EXECUTE FUNCTION app.guard_bq_version_content();
CREATE TRIGGER bq_items_draft_only BEFORE INSERT OR UPDATE OR DELETE ON "bq_items"
  FOR EACH ROW EXECUTE FUNCTION app.guard_bq_version_content();

-- When a transaction that wrote a version, or any of its bills, sections or items, commits, the
-- version's stored totals must equal the sums of its content: subtotal = Σ bill totals, bill total
-- = Σ item amounts, section total = Σ item amounts, and the bill/item counts. The deferred row
-- triggers run at COMMIT; a transaction-local marker makes each version's check run once.
CREATE FUNCTION app.check_bq_version_totals_of(target_tenant uuid, target_version uuid)
  RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  marker text := 'app.bq_checked_' || replace(target_version::text, '-', '');
  current_subtotal bigint;
  current_bills integer;
  current_items integer;
  bills_total numeric;
  bills_count integer;
  items_count integer;
BEGIN
  IF current_setting(marker, true) = '1' THEN
    RETURN;
  END IF;
  PERFORM set_config(marker, '1', true);
  SELECT subtotal_minor, bill_count, item_count INTO current_subtotal, current_bills, current_items
    FROM bq_versions WHERE tenant_id = target_tenant AND id = target_version;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT COALESCE(sum(total_minor), 0), count(*) INTO bills_total, bills_count
    FROM bq_bills WHERE tenant_id = target_tenant AND version_id = target_version;
  SELECT count(*) INTO items_count
    FROM bq_items WHERE tenant_id = target_tenant AND version_id = target_version;
  IF bills_total <> current_subtotal OR bills_count <> current_bills
     OR items_count <> current_items THEN
    RAISE EXCEPTION 'BQ version totals do not match its bills' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM bq_bills b
      LEFT JOIN (
        SELECT bill_id, sum(amount_minor) AS total FROM bq_items
          WHERE tenant_id = target_tenant AND version_id = target_version GROUP BY bill_id
      ) i ON i.bill_id = b.id
      WHERE b.tenant_id = target_tenant AND b.version_id = target_version
        AND b.total_minor <> COALESCE(i.total, 0)
  ) OR EXISTS (
    SELECT 1 FROM bq_sections s
      LEFT JOIN (
        SELECT section_id, sum(amount_minor) AS total FROM bq_items
          WHERE tenant_id = target_tenant AND version_id = target_version
            AND section_id IS NOT NULL
          GROUP BY section_id
      ) i ON i.section_id = s.id
      WHERE s.tenant_id = target_tenant AND s.version_id = target_version
        AND s.total_minor <> COALESCE(i.total, 0)
  ) THEN
    RAISE EXCEPTION 'BQ bill or section totals do not match their items' USING ERRCODE = '23514';
  END IF;
END
$$;

CREATE FUNCTION app.check_bq_version_totals() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'bq_versions' THEN
    PERFORM app.check_bq_version_totals_of(NEW.tenant_id, NEW.id);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM app.check_bq_version_totals_of(OLD.tenant_id, OLD.version_id);
  ELSE
    PERFORM app.check_bq_version_totals_of(NEW.tenant_id, NEW.version_id);
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER bq_version_totals AFTER INSERT OR UPDATE ON "bq_versions"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_bq_version_totals();
CREATE CONSTRAINT TRIGGER bq_bill_totals AFTER INSERT OR UPDATE OR DELETE ON "bq_bills"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_bq_version_totals();
CREATE CONSTRAINT TRIGGER bq_section_totals AFTER INSERT OR UPDATE OR DELETE ON "bq_sections"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_bq_version_totals();
CREATE CONSTRAINT TRIGGER bq_item_totals AFTER INSERT OR UPDATE OR DELETE ON "bq_items"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_bq_version_totals();

-- Row-level security -----------------------------------------------------------------------------
ALTER TABLE "bq_mapping_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bq_mapping_templates" FORCE ROW LEVEL SECURITY;
ALTER TABLE "bqs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bqs" FORCE ROW LEVEL SECURITY;
ALTER TABLE "bq_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bq_versions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "bq_bills" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bq_bills" FORCE ROW LEVEL SECURITY;
ALTER TABLE "bq_sections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bq_sections" FORCE ROW LEVEL SECURITY;
ALTER TABLE "bq_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bq_items" FORCE ROW LEVEL SECURITY;
ALTER TABLE "bq_imports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bq_imports" FORCE ROW LEVEL SECURITY;

CREATE POLICY bq_mapping_templates_isolation ON bq_mapping_templates
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY bqs_isolation ON bqs
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY bq_versions_isolation ON bq_versions
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY bq_bills_isolation ON bq_bills
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY bq_sections_isolation ON bq_sections
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY bq_items_isolation ON bq_items
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY bq_imports_isolation ON bq_imports
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

-- Imports, BQs and versions are history: the runtime role never deletes them. No TRUNCATE,
-- REFERENCES or TRIGGER on the new tables.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmb_app') THEN
    REVOKE DELETE ON "bq_imports", "bqs", "bq_versions" FROM pmb_app;
    REVOKE TRUNCATE, REFERENCES, TRIGGER
      ON "bq_mapping_templates", "bqs", "bq_versions", "bq_bills", "bq_sections", "bq_items",
         "bq_imports" FROM pmb_app;
  END IF;
END
$$;
REVOKE EXECUTE ON FUNCTION app.guard_bq_import() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_bq_version_content() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_bq_version_totals() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_bq_version_totals_of(uuid, uuid) FROM PUBLIC;

COMMIT;
