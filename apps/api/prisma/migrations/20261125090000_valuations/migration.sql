-- D6.3 part A: measurement and valuations (ARCHITECTURE §4.10, ERD, WORKFLOWS "Measurements" and
-- "Valuations", brief §5.2 and §15 C/G). Enforces, in the database as well as the API:
-- * MEASUREMENTS STAY APPEND-ONLY EVIDENCE: progress_measurements gains the basis (quantity or
--   percent complete; provisional sums, PC sums and contingencies are refused), an over-measure
--   reason (required exactly when the quantity exceeds the BQ quantity; percent never above 100),
--   the offline contract (idempotency key + request digest) and a clock stamp; corrections keep
--   the item and the date. Photos of the same project are added while it waits for review; one
--   review per measurement, by someone other than the measurer, approval only with a photo.
-- * CERTIFICATES NEVER CHANGE ONCE CERTIFIED: valuations move draft → submitted → certified (or
--   returned, or cancelled) under app.guard_valuation; submission freezes the figures (rule
--   KE-VAL-1, recomputed by a CHECK) and writes the lines in the same transaction; certification
--   is by someone who never contributed, numbers the certificate IPC-NNNN and changes nothing
--   else; app.check_valuation re-verifies previous certificates, the BQ and contract settings in
--   force, the retention stage and the release limits at submission and certification; at commit
--   app.check_valuation_lines proves the lines are the approved measurements in force, the stores
--   at cost and the adjustments, materials never above what remains of an item and recoveries
--   never above advances. Certified and cancelled valuations never change; nothing is deleted.
-- * Contract settings are append-only versions; certificates store the version and values used.
-- Every new table has tenant_id, forced RLS with WITH CHECK and composite (tenant_id, …) foreign
-- keys; pmb_app holds no UPDATE or DELETE on append-only tables.
BEGIN;

-- AlterTable
ALTER TABLE "progress_measurements" ADD COLUMN     "basis" VARCHAR(10),
ADD COLUMN     "idempotency_key" VARCHAR(100),
ADD COLUMN     "over_measure_reason" VARCHAR(500),
ADD COLUMN     "request_digest" CHAR(64);

-- CreateTable
CREATE TABLE "progress_measurement_photos" (
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "measurement_id" UUID NOT NULL,
    "photo_id" UUID NOT NULL,
    "added_by" UUID NOT NULL,
    "added_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "progress_measurement_photos_pkey" PRIMARY KEY ("tenant_id","measurement_id","photo_id")
);

-- CreateTable
CREATE TABLE "progress_measurement_reviews" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "measurement_id" UUID NOT NULL,
    "decision" VARCHAR(10) NOT NULL,
    "reason" VARCHAR(500),
    "decided_by" UUID NOT NULL,
    "decided_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "progress_measurement_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_settings" (
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "retention_percent" DECIMAL(5,2) NOT NULL,
    "retention_cap_percent" DECIMAL(5,2),
    "vat_percent" DECIMAL(5,2) NOT NULL,
    "materials_percent" DECIMAL(5,2) NOT NULL,
    "practical_release_percent" DECIMAL(5,2) NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contract_settings_pkey" PRIMARY KEY ("tenant_id","project_id","version")
);

-- CreateTable
CREATE TABLE "valuations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "certificate_number" INTEGER,
    "kind" VARCHAR(20) NOT NULL,
    "release_stage" VARCHAR(10),
    "status" VARCHAR(10) NOT NULL DEFAULT 'draft',
    "valuation_date" DATE NOT NULL,
    "notes" VARCHAR(1000),
    "materials_from_stores" BOOLEAN NOT NULL DEFAULT false,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "bq_version_id" UUID,
    "settings_version" INTEGER,
    "rule_version" VARCHAR(20),
    "retention_percent" DECIMAL(5,2),
    "retention_cap_percent" DECIMAL(5,2),
    "vat_percent" DECIMAL(5,2),
    "materials_percent" DECIMAL(5,2),
    "practical_release_percent" DECIMAL(5,2),
    "original_contract_sum_minor" BIGINT,
    "revised_contract_sum_minor" BIGINT,
    "work_done_minor" BIGINT,
    "materials_gross_minor" BIGINT,
    "materials_minor" BIGINT,
    "gross_minor" BIGINT,
    "retention_stage" VARCHAR(10),
    "retention_cap_minor" BIGINT,
    "retention_computed_minor" BIGINT,
    "retention_held_minor" BIGINT,
    "adjustments_minor" BIGINT,
    "adjustments_to_date_minor" BIGINT,
    "net_to_date_minor" BIGINT,
    "previous_certified_minor" BIGINT,
    "amount_due_minor" BIGINT,
    "vat_minor" BIGINT,
    "total_minor" BIGINT,
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

    CONSTRAINT "valuations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "valuation_lines" (
    "tenant_id" UUID NOT NULL,
    "valuation_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "line_no" INTEGER NOT NULL,
    "kind" VARCHAR(12) NOT NULL,
    "bq_version_id" UUID,
    "bq_item_lineage_id" UUID,
    "bill_lineage_id" UUID,
    "item_kind" VARCHAR(20),
    "ref" VARCHAR(30),
    "description" VARCHAR(4000) NOT NULL,
    "unit" VARCHAR(20),
    "basis" VARCHAR(10),
    "item_quantity" DECIMAL(20,4),
    "rate" DECIMAL(20,4),
    "item_amount_minor" BIGINT,
    "measurement_id" UUID,
    "measured_on" DATE,
    "quantity_to_date" DECIMAL(20,4),
    "percent_complete" VARCHAR(20),
    "over_measured" BOOLEAN NOT NULL DEFAULT false,
    "previous_minor" BIGINT NOT NULL DEFAULT 0,
    "amount_minor" BIGINT NOT NULL,
    "source" VARCHAR(10),
    "store_id" UUID,
    "material_id" UUID,
    "quantity" DECIMAL(24,6),
    "reference" VARCHAR(60),
    "adjustment_kind" VARCHAR(20),

    CONSTRAINT "valuation_lines_pkey" PRIMARY KEY ("tenant_id","valuation_id","revision","line_no")
);

-- CreateTable
CREATE TABLE "valuation_materials" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "valuation_id" UUID NOT NULL,
    "bq_version_id" UUID NOT NULL,
    "bq_item_lineage_id" UUID NOT NULL,
    "description" VARCHAR(200) NOT NULL,
    "unit" VARCHAR(20),
    "quantity" DECIMAL(20,4) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "reference" VARCHAR(60),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "valuation_materials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "valuation_adjustments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "valuation_id" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "description" VARCHAR(200) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "valuation_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "progress_measurement_photos_tenant_id_project_id_photo_id_idx" ON "progress_measurement_photos"("tenant_id", "project_id", "photo_id");

-- CreateIndex
CREATE INDEX "progress_measurement_reviews_tenant_id_project_id_decided_a_idx" ON "progress_measurement_reviews"("tenant_id", "project_id", "decided_at");

-- CreateIndex
CREATE UNIQUE INDEX "progress_measurement_reviews_tenant_id_id_key" ON "progress_measurement_reviews"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "progress_measurement_reviews_tenant_id_project_id_measureme_key" ON "progress_measurement_reviews"("tenant_id", "project_id", "measurement_id");

-- CreateIndex
CREATE INDEX "valuations_tenant_id_project_id_status_idx" ON "valuations"("tenant_id", "project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "valuations_tenant_id_id_key" ON "valuations"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "valuations_tenant_id_project_id_id_key" ON "valuations"("tenant_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "valuations_tenant_id_project_id_number_key" ON "valuations"("tenant_id", "project_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "valuations_tenant_id_project_id_certificate_number_key" ON "valuations"("tenant_id", "project_id", "certificate_number");

-- CreateIndex
CREATE INDEX "valuation_lines_tenant_id_measurement_id_idx" ON "valuation_lines"("tenant_id", "measurement_id");

-- CreateIndex
CREATE INDEX "valuation_materials_tenant_id_valuation_id_idx" ON "valuation_materials"("tenant_id", "valuation_id");

-- CreateIndex
CREATE UNIQUE INDEX "valuation_materials_tenant_id_id_key" ON "valuation_materials"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "valuation_adjustments_tenant_id_valuation_id_idx" ON "valuation_adjustments"("tenant_id", "valuation_id");

-- CreateIndex
CREATE UNIQUE INDEX "valuation_adjustments_tenant_id_id_key" ON "valuation_adjustments"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "progress_measurements_tenant_id_project_id_id_key" ON "progress_measurements"("tenant_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "progress_measurements_tenant_id_idempotency_key_key" ON "progress_measurements"("tenant_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "progress_measurement_photos" ADD CONSTRAINT "progress_measurement_photos_tenant_id_project_id_measureme_fkey" FOREIGN KEY ("tenant_id", "project_id", "measurement_id") REFERENCES "progress_measurements"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "progress_measurement_photos" ADD CONSTRAINT "progress_measurement_photos_tenant_id_project_id_photo_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "photo_id") REFERENCES "site_photos"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "progress_measurement_reviews" ADD CONSTRAINT "progress_measurement_reviews_tenant_id_project_id_measurem_fkey" FOREIGN KEY ("tenant_id", "project_id", "measurement_id") REFERENCES "progress_measurements"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_settings" ADD CONSTRAINT "contract_settings_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "valuations" ADD CONSTRAINT "valuations_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "valuations" ADD CONSTRAINT "valuations_tenant_id_bq_version_id_fkey" FOREIGN KEY ("tenant_id", "bq_version_id") REFERENCES "bq_versions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "valuation_lines" ADD CONSTRAINT "valuation_lines_tenant_id_valuation_id_fkey" FOREIGN KEY ("tenant_id", "valuation_id") REFERENCES "valuations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "valuation_lines" ADD CONSTRAINT "valuation_lines_tenant_id_bq_version_id_bq_item_lineage_id_fkey" FOREIGN KEY ("tenant_id", "bq_version_id", "bq_item_lineage_id") REFERENCES "bq_items"("tenant_id", "version_id", "lineage_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "valuation_lines" ADD CONSTRAINT "valuation_lines_tenant_id_measurement_id_fkey" FOREIGN KEY ("tenant_id", "measurement_id") REFERENCES "progress_measurements"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "valuation_materials" ADD CONSTRAINT "valuation_materials_tenant_id_project_id_valuation_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "valuation_id") REFERENCES "valuations"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "valuation_materials" ADD CONSTRAINT "valuation_materials_tenant_id_bq_version_id_bq_item_lineag_fkey" FOREIGN KEY ("tenant_id", "bq_version_id", "bq_item_lineage_id") REFERENCES "bq_items"("tenant_id", "version_id", "lineage_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "valuation_adjustments" ADD CONSTRAINT "valuation_adjustments_tenant_id_project_id_valuation_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "valuation_id") REFERENCES "valuations"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Shared helpers -----------------------------------------------------------------------------------
-- n ÷ d rounded half away from zero, exactly (n and d whole numbers, d > 0): packages/domain
-- divideHalfUp. Numeric division would round at its own scale first.
CREATE FUNCTION app.div_half_up(n numeric, d numeric) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT sign(n) * div(2 * abs(n) + d, 2 * d)
$$;

-- packages/domain measurementBasis: provisional sums, PC sums (with their attendance and profit)
-- and contingencies are expended through variations and never measured; neither is an item worth
-- nothing. An item with a quantity is measured by quantity, a priced lump sum by percent complete.
CREATE FUNCTION app.measurement_basis(item_kind text, item_quantity numeric, item_amount bigint)
  RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN item_kind IN ('provisional_sum', 'pc_sum', 'pc_attendance', 'pc_profit', 'contingency')
      THEN NULL
    WHEN item_amount <= 0 THEN NULL
    WHEN item_quantity IS NOT NULL AND item_quantity > 0 THEN 'quantity'
    ELSE 'percent'
  END
$$;

-- packages/domain measuredValueMinor (KES minor units): quantity × rate for a computed item, the
-- amount pro rata for any other priced item with a quantity, the amount × percent ÷ 100 for a
-- lump sum; one rounding, half away from zero. Quantities and rates have at most four places.
CREATE FUNCTION app.measured_value_minor(item_kind text, amount_source text, item_quantity numeric,
  item_rate numeric, item_amount bigint, done numeric) RETURNS bigint LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE app.measurement_basis(item_kind, item_quantity, item_amount)
    WHEN 'percent' THEN app.div_half_up(item_amount * (done * 10000), 1000000)::bigint
    WHEN 'quantity' THEN CASE
      WHEN amount_source = 'computed' AND item_rate IS NOT NULL
        THEN app.div_half_up((done * 10000) * (item_rate * 10000) * 100, 100000000)::bigint
      ELSE app.div_half_up(item_amount * (done * 10000), item_quantity * 10000)::bigint
    END
    ELSE 0
  END
$$;

-- Progress measurements (D5.3 table, extended) --------------------------------------------------
ALTER TABLE "progress_measurements" ADD CONSTRAINT "progress_measurements_d63_check" CHECK (
  (basis IS NULL OR basis IN ('quantity', 'percent'))
  AND (basis IS DISTINCT FROM 'percent' OR quantity_to_date <= 100)
  AND (over_measure_reason IS NULL OR char_length(btrim(over_measure_reason)) >= 3)
  AND (idempotency_key IS NULL) = (request_digest IS NULL)
  AND (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 8 AND 100)
  AND (request_digest IS NULL OR request_digest ~ '^[0-9a-f]{64}$')
);

-- Measured by the signed-in user, not in the future (Africa/Nairobi), against an item of an
-- approved BQ version of an open project, using the item's basis (provisional sums, PC sums and
-- contingencies are refused); a quantity above the BQ quantity carries a reason and only then; a
-- correction names a measurement of the same item and date. Stamped with the clock (two
-- measurements of one item and day are ordered by when they were recorded). Never changed.
CREATE OR REPLACE FUNCTION app.guard_progress_measurement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  approved boolean;
  corrected record;
  item record;
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
  PERFORM app.assert_quality_writable(NEW.tenant_id, NEW.project_id);
  SELECT kind, quantity, amount_minor INTO item FROM bq_items
   WHERE tenant_id = NEW.tenant_id AND version_id = NEW.version_id
     AND lineage_id = NEW.item_lineage_id;
  IF NEW.basis IS NULL
     OR NEW.basis IS DISTINCT FROM app.measurement_basis(item.kind, item.quantity, item.amount_minor)
  THEN
    RAISE EXCEPTION 'A measurement uses its item''s basis; provisional sums, PC sums and contingencies are not measured'
      USING ERRCODE = '23514';
  END IF;
  IF (NEW.basis = 'quantity' AND NEW.quantity_to_date > item.quantity)
     IS DISTINCT FROM (NEW.over_measure_reason IS NOT NULL) THEN
    RAISE EXCEPTION 'An over-measure carries a reason, and only an over-measure'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.corrects_id IS NOT NULL THEN
    SELECT project_id, item_lineage_id, measured_on INTO corrected FROM progress_measurements
     WHERE tenant_id = NEW.tenant_id AND id = NEW.corrects_id;
    IF corrected.item_lineage_id IS DISTINCT FROM NEW.item_lineage_id
       OR corrected.project_id IS DISTINCT FROM NEW.project_id
       OR corrected.measured_on IS DISTINCT FROM NEW.measured_on THEN
      RAISE EXCEPTION 'A correction names a measurement of the same item and date'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END
$$;

-- Evidence: site photos of the same project (composite FK), added by the signed-in user while the
-- measurement waits for review (not reviewed, not corrected), at most six; never removed.
CREATE FUNCTION app.guard_measurement_photo() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Measurement evidence is never changed or removed' USING ERRCODE = '23514';
  END IF;
  IF NEW.added_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'Evidence is added by the signed-in user' USING ERRCODE = '23514';
  END IF;
  PERFORM app.assert_quality_writable(NEW.tenant_id, NEW.project_id);
  IF EXISTS (SELECT 1 FROM progress_measurement_reviews
              WHERE tenant_id = NEW.tenant_id AND measurement_id = NEW.measurement_id)
     OR EXISTS (SELECT 1 FROM progress_measurements
                 WHERE tenant_id = NEW.tenant_id AND corrects_id = NEW.measurement_id) THEN
    RAISE EXCEPTION 'Photos are added to a measurement only while it waits for review'
      USING ERRCODE = '23514';
  END IF;
  IF (SELECT count(*) FROM progress_measurement_photos
       WHERE tenant_id = NEW.tenant_id AND measurement_id = NEW.measurement_id) >= 6 THEN
    RAISE EXCEPTION 'A measurement has at most six photos' USING ERRCODE = '23514';
  END IF;
  NEW.added_at := clock_timestamp();
  RETURN NEW;
END
$$;
CREATE TRIGGER measurement_photo_guard BEFORE INSERT OR UPDATE OR DELETE
  ON "progress_measurement_photos" FOR EACH ROW EXECUTE FUNCTION app.guard_measurement_photo();

ALTER TABLE "progress_measurement_reviews" ADD CONSTRAINT "progress_measurement_reviews_check" CHECK (
  decision IN ('approved', 'rejected')
  AND (decision <> 'rejected' OR char_length(btrim(reason)) >= 3)
  AND (reason IS NULL OR char_length(btrim(reason)) >= 3)
);

-- One review per measurement (unique), by the signed-in user who did NOT measure it (maker-checker
-- by identity), while it is not corrected; approval needs at least one photo. Never changed.
CREATE FUNCTION app.guard_measurement_review() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  measurer uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'A measurement review never changes' USING ERRCODE = '23514';
  END IF;
  SELECT measured_by INTO measurer FROM progress_measurements
   WHERE tenant_id = NEW.tenant_id AND id = NEW.measurement_id;
  IF NEW.decided_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A measurement is reviewed by the signed-in user' USING ERRCODE = '23514';
  END IF;
  IF NEW.decided_by = measurer THEN
    RAISE EXCEPTION 'A measurement is reviewed by someone other than its measurer'
      USING ERRCODE = '23514';
  END IF;
  PERFORM app.assert_quality_writable(NEW.tenant_id, NEW.project_id);
  IF EXISTS (SELECT 1 FROM progress_measurements
              WHERE tenant_id = NEW.tenant_id AND corrects_id = NEW.measurement_id) THEN
    RAISE EXCEPTION 'A corrected measurement is no longer reviewed' USING ERRCODE = '23514';
  END IF;
  IF NEW.decision = 'approved' AND NOT EXISTS (
    SELECT 1 FROM progress_measurement_photos
     WHERE tenant_id = NEW.tenant_id AND measurement_id = NEW.measurement_id
  ) THEN
    RAISE EXCEPTION 'A measurement is approved with photo evidence' USING ERRCODE = '23514';
  END IF;
  NEW.decided_at := clock_timestamp();
  RETURN NEW;
END
$$;
CREATE TRIGGER measurement_review_guard BEFORE INSERT OR UPDATE OR DELETE
  ON "progress_measurement_reviews" FOR EACH ROW EXECUTE FUNCTION app.guard_measurement_review();

-- Contract settings (CONFIGURATION "Valuations") -------------------------------------------------
ALTER TABLE "contract_settings" ADD CONSTRAINT "contract_settings_check" CHECK (
  version >= 1
  AND retention_percent BETWEEN 0 AND 20
  AND (retention_cap_percent IS NULL OR retention_cap_percent BETWEEN 0 AND 100)
  AND vat_percent BETWEEN 0 AND 30
  AND materials_percent BETWEEN 0 AND 100
  AND practical_release_percent BETWEEN 0 AND 100
);
-- Append-only versions numbered one after another, by the signed-in user, on an open project.
CREATE FUNCTION app.guard_contract_settings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Contract settings are versioned, never changed' USING ERRCODE = '23514';
  END IF;
  IF NEW.created_by IS DISTINCT FROM app.current_user_id()
     OR NEW.version <> COALESCE((SELECT max(version) FROM contract_settings
          WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id), 0) + 1 THEN
    RAISE EXCEPTION 'Contract settings versions are numbered one after another by the signed-in user'
      USING ERRCODE = '23514';
  END IF;
  PERFORM app.assert_quality_writable(NEW.tenant_id, NEW.project_id);
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END
$$;
CREATE TRIGGER contract_settings_guard BEFORE INSERT OR UPDATE OR DELETE ON "contract_settings"
  FOR EACH ROW EXECUTE FUNCTION app.guard_contract_settings();

-- Valuations and certificates ----------------------------------------------------------------------
ALTER TABLE "valuations" ADD CONSTRAINT "valuations_check" CHECK (
  number >= 1 AND version >= 1 AND revision >= 0 AND line_count BETWEEN 0 AND 6000
  AND kind IN ('interim', 'retention_release')
  AND (kind = 'retention_release') = (release_stage IS NOT NULL)
  AND (release_stage IS NULL OR release_stage IN ('practical', 'final'))
  AND (kind = 'interim' OR NOT materials_from_stores)
  AND valuation_date BETWEEN DATE '2000-01-01' AND DATE '2099-12-31'
  AND contributors IS NOT NULL AND created_by = ANY (contributors)
  AND (digest IS NULL OR digest ~ '^[0-9a-f]{64}$')
  AND (certificate_number IS NULL OR certificate_number >= 1)
  AND (notes IS NULL OR char_length(btrim(notes)) >= 1)
  AND (return_reason IS NULL OR char_length(btrim(return_reason)) >= 3)
  AND COALESCE(CASE status
    WHEN 'draft' THEN digest IS NULL AND submitted_at IS NULL AND certified_at IS NULL
      AND cancelled_at IS NULL AND certificate_number IS NULL AND amount_due_minor IS NULL
    WHEN 'submitted' THEN digest IS NOT NULL AND submitted_by IS NOT NULL
      AND submitted_at IS NOT NULL AND certified_at IS NULL AND cancelled_at IS NULL
      AND certificate_number IS NULL AND total_minor IS NOT NULL
    WHEN 'certified' THEN digest IS NOT NULL AND certified_by IS NOT NULL
      AND certified_at IS NOT NULL AND certificate_number IS NOT NULL AND total_minor IS NOT NULL
      AND cancelled_at IS NULL AND NOT (certified_by = ANY (contributors))
    WHEN 'cancelled' THEN cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL
      AND char_length(btrim(cancel_reason)) >= 3 AND certificate_number IS NULL
    ELSE false
  END, false)
  -- Frozen figures: all or none, and packages/domain computeCertificate (rule KE-VAL-1).
  AND num_nulls(bq_version_id, settings_version, rule_version, retention_percent, vat_percent,
      materials_percent, practical_release_percent, original_contract_sum_minor,
      revised_contract_sum_minor, work_done_minor, materials_gross_minor, materials_minor,
      gross_minor, retention_stage, retention_computed_minor, retention_held_minor,
      adjustments_minor, adjustments_to_date_minor, net_to_date_minor, previous_certified_minor,
      amount_due_minor, vat_minor, total_minor) IN (0, 23)
  AND (total_minor IS NULL OR (
    rule_version = 'KE-VAL-1' AND settings_version >= 0
    AND retention_stage IN ('none', 'practical', 'final')
    AND (kind = 'interim' OR retention_stage = release_stage)
    AND work_done_minor >= 0 AND materials_gross_minor >= 0
    AND materials_minor = round(materials_gross_minor * materials_percent / 100)
    AND gross_minor = work_done_minor + materials_minor
    AND (retention_cap_percent IS NULL) = (retention_cap_minor IS NULL)
    AND (retention_cap_minor IS NULL
         OR retention_cap_minor = round(original_contract_sum_minor * retention_cap_percent / 100))
    AND retention_computed_minor = LEAST(GREATEST(round(gross_minor * retention_percent / 100), 0),
                                         COALESCE(retention_cap_minor, 9223372036854775807))
    AND retention_held_minor = CASE retention_stage
      WHEN 'none' THEN retention_computed_minor
      WHEN 'practical' THEN retention_computed_minor
        - round(retention_computed_minor * practical_release_percent / 100)
      ELSE 0 END
    AND net_to_date_minor = gross_minor - retention_held_minor + adjustments_to_date_minor
    AND amount_due_minor = net_to_date_minor - previous_certified_minor
    AND vat_minor = round(amount_due_minor * vat_percent / 100)
    AND total_minor = amount_due_minor + vat_minor
  ))
);
-- One valuation in preparation per project; one live release per completion stage.
CREATE UNIQUE INDEX "valuations_one_open_per_project" ON "valuations"("tenant_id", "project_id")
  WHERE status IN ('draft', 'submitted');
CREATE UNIQUE INDEX "valuations_one_release_per_stage" ON "valuations"
  ("tenant_id", "project_id", "release_stage")
  WHERE kind = 'retention_release' AND status <> 'cancelled';

-- The checks a submitted or certified certificate must pass against the rest of the database
-- (called on submission and on certification, so a certificate that went stale is refused):
-- it nets off every certified certificate, uses the BQ in force, the contract settings in force
-- and the retention stage reached, its valuation date is not before the last certified one nor in
-- the future, and a retention release carries the last certificate forward and releases no more
-- than is held. COMPLIANCE-REVIEW CR-VAL-01–04.
CREATE FUNCTION app.check_valuation(v valuations) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  prior record;
  last record;
  settings record;
  in_force uuid;
  baseline bigint;
  revised bigint;
  stage text;
  completed date;
  cap_percent numeric;
BEGIN
  SELECT COALESCE(sum(amount_due_minor), 0)::bigint AS due,
         COALESCE(sum(adjustments_minor), 0)::bigint AS adjustments,
         max(valuation_date) AS latest,
         bool_or(kind = 'retention_release' AND release_stage = 'final') AS final_released,
         bool_or(kind = 'retention_release' AND release_stage = 'practical') AS practical_released,
         count(*) AS certified
    INTO prior FROM valuations
   WHERE tenant_id = v.tenant_id AND project_id = v.project_id AND status = 'certified'
     AND id <> v.id;
  IF v.previous_certified_minor <> prior.due
     OR v.adjustments_to_date_minor <> prior.adjustments + v.adjustments_minor THEN
    RAISE EXCEPTION 'A certificate nets off every certificate already certified'
      USING ERRCODE = '23514';
  END IF;
  IF v.valuation_date > app.business_today()
     OR (prior.latest IS NOT NULL AND v.valuation_date < prior.latest) THEN
    RAISE EXCEPTION 'A valuation is dated on or after the last certificate and not in the future'
      USING ERRCODE = '23514';
  END IF;
  SELECT id INTO in_force FROM bq_versions
   WHERE tenant_id = v.tenant_id AND project_id = v.project_id AND status = 'approved'
   ORDER BY approved_at DESC NULLS LAST, version_no DESC LIMIT 1;
  SELECT subtotal_minor INTO baseline FROM bq_versions
   WHERE tenant_id = v.tenant_id AND project_id = v.project_id AND status = 'approved'
   ORDER BY version_no LIMIT 1;
  SELECT subtotal_minor INTO revised FROM bq_versions
   WHERE tenant_id = v.tenant_id AND id = v.bq_version_id;
  IF v.bq_version_id IS DISTINCT FROM in_force OR v.original_contract_sum_minor <> baseline
     OR v.revised_contract_sum_minor <> revised THEN
    RAISE EXCEPTION 'A certificate values the BQ in force against the original contract sum'
      USING ERRCODE = '23514';
  END IF;
  SELECT * INTO settings FROM contract_settings
   WHERE tenant_id = v.tenant_id AND project_id = v.project_id ORDER BY version DESC LIMIT 1;
  -- No row: the packages/types DEFAULT_CONTRACT_SETTINGS (10 %, 5 %, 16 %, 100 %, 50 %).
  cap_percent := CASE WHEN settings.version IS NULL THEN 5 ELSE settings.retention_cap_percent END;
  IF v.settings_version <> COALESCE(settings.version, 0)
     OR v.retention_percent <> COALESCE(settings.retention_percent, 10)
     OR v.retention_cap_percent IS DISTINCT FROM cap_percent
     OR v.vat_percent <> COALESCE(settings.vat_percent, 16)
     OR v.materials_percent <> COALESCE(settings.materials_percent, 100)
     OR v.practical_release_percent <> COALESCE(settings.practical_release_percent, 50) THEN
    RAISE EXCEPTION 'A certificate uses the contract settings in force' USING ERRCODE = '23514';
  END IF;
  IF v.kind = 'interim' THEN
    stage := CASE WHEN prior.final_released THEN 'final'
                  WHEN prior.practical_released THEN 'practical' ELSE 'none' END;
    IF v.retention_stage IS DISTINCT FROM stage THEN
      RAISE EXCEPTION 'An interim certificate holds the retention left after the releases so far'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT completion_date INTO completed FROM project_completions
     WHERE tenant_id = v.tenant_id AND project_id = v.project_id AND kind = v.release_stage
       AND status = 'certified';
    IF completed IS NULL OR v.valuation_date < completed
       OR (v.release_stage = 'practical' AND prior.final_released) THEN
      RAISE EXCEPTION 'Retention is released after the certified % completion', v.release_stage
        USING ERRCODE = '23514';
    END IF;
    SELECT * INTO last FROM valuations
     WHERE tenant_id = v.tenant_id AND project_id = v.project_id AND status = 'certified'
       AND id <> v.id ORDER BY certificate_number DESC LIMIT 1;
    IF last.id IS NULL OR v.work_done_minor <> last.work_done_minor
       OR v.materials_gross_minor <> last.materials_gross_minor OR v.adjustments_minor <> 0
       OR v.amount_due_minor < 0 OR v.amount_due_minor > last.retention_held_minor THEN
      RAISE EXCEPTION 'A retention release carries the last certificate forward and releases no more than is held'
        USING ERRCODE = '23514';
    END IF;
  END IF;
END
$$;

-- packages/domain VALUATION_TRANSITIONS. A valuation starts as a draft numbered after the last
-- one; a release needs the certified completion; only a draft is edited; submission stamps the
-- clock, takes the next revision and freezes the figures (checked by app.check_valuation and,
-- at commit, against the lines); certification is by the signed-in user who never contributed,
-- numbers the certificate after the last one and changes nothing else; returned → draft clears
-- the figures; certified and cancelled valuations never change and nothing is ever deleted.
CREATE FUNCTION app.guard_valuation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  frozen_old jsonb;
  frozen_new jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A valuation is never deleted; cancel it' USING ERRCODE = '23514';
  END IF;
  PERFORM app.assert_quality_writable(NEW.tenant_id, NEW.project_id);
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.created_by IS DISTINCT FROM app.current_user_id()
       OR NEW.revision <> 0 OR NEW.total_minor IS NOT NULL OR NEW.line_count <> 0 THEN
      RAISE EXCEPTION 'A valuation starts as an empty draft by the signed-in user'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.number <> COALESCE((SELECT max(number) FROM valuations
         WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id), 0) + 1 THEN
      RAISE EXCEPTION 'Valuations are numbered one after another' USING ERRCODE = '23514';
    END IF;
    IF NEW.valuation_date > app.business_today() THEN
      RAISE EXCEPTION 'A valuation is dated on or after the last certificate and not in the future'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.kind = 'retention_release' AND NOT EXISTS (
      SELECT 1 FROM project_completions
       WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id
         AND kind = NEW.release_stage AND status = 'certified'
    ) THEN
      RAISE EXCEPTION 'Retention is released after the certified % completion', NEW.release_stage
        USING ERRCODE = '23514';
    END IF;
    NEW.contributors := app.add_contributors(NEW.contributors, NEW.created_by, NEW.updated_by);
    RETURN NEW;
  END IF;

  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.number IS DISTINCT FROM OLD.number OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.release_stage IS DISTINCT FROM OLD.release_stage
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'A valuation keeps its project, number and kind' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('certified', 'cancelled') THEN
    RAISE EXCEPTION 'A % valuation never changes', OLD.status USING ERRCODE = '23514';
  END IF;
  IF NOT (NEW.contributors @> OLD.contributors) THEN
    RAISE EXCEPTION 'A valuation''s contributors are only ever added' USING ERRCODE = '23514';
  END IF;
  frozen_old := to_jsonb(OLD) - 'status' - 'certificate_number' - 'certified_by' - 'certified_at'
    - 'version' - 'updated_by' - 'updated_at' - 'contributors' - 'cancelled_by' - 'cancelled_at'
    - 'cancel_reason';
  frozen_new := to_jsonb(NEW) - 'status' - 'certificate_number' - 'certified_by' - 'certified_at'
    - 'version' - 'updated_by' - 'updated_at' - 'contributors' - 'cancelled_by' - 'cancelled_at'
    - 'cancel_reason';

  IF OLD.status = 'draft' AND NEW.status = 'draft' THEN
    IF NEW.total_minor IS NOT NULL OR NEW.revision <> OLD.revision
       OR NEW.digest IS NOT NULL OR NEW.submitted_at IS NOT NULL THEN
      RAISE EXCEPTION 'A draft has no figures until it is submitted' USING ERRCODE = '23514';
    END IF;
    IF NEW.valuation_date > app.business_today() THEN
      RAISE EXCEPTION 'A valuation is dated on or after the last certificate and not in the future'
        USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.status = 'draft' AND NEW.status = 'submitted' THEN
    IF NEW.submitted_by IS DISTINCT FROM app.current_user_id()
       OR NEW.revision <> OLD.revision + 1 THEN
      RAISE EXCEPTION 'A valuation is submitted by the signed-in user as its next revision'
        USING ERRCODE = '23514';
    END IF;
    NEW.submitted_at := now();
    -- Whoever entered materials or adjustments contributed to what is certified.
    NEW.contributors := app.add_contributors(NEW.contributors, VARIADIC ARRAY(
      SELECT created_by FROM valuation_materials
       WHERE tenant_id = NEW.tenant_id AND valuation_id = NEW.id
      UNION SELECT created_by FROM valuation_adjustments
       WHERE tenant_id = NEW.tenant_id AND valuation_id = NEW.id));
    PERFORM app.check_valuation(NEW);
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
         FROM valuations WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id), 0) + 1
    THEN
      RAISE EXCEPTION 'Certificates are numbered one after another' USING ERRCODE = '23514';
    END IF;
    NEW.certified_at := now();
    PERFORM app.check_valuation(NEW);
  ELSIF OLD.status = 'submitted' AND NEW.status = 'draft' THEN
    IF NEW.return_reason IS NULL OR NEW.total_minor IS NOT NULL OR NEW.digest IS NOT NULL
       OR NEW.revision <> OLD.revision THEN
      RAISE EXCEPTION 'A returned valuation goes back to draft with a reason and no figures'
        USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.status IN ('draft', 'submitted') AND NEW.status = 'cancelled' THEN
    IF NEW.cancelled_by IS DISTINCT FROM app.current_user_id()
       OR frozen_new IS DISTINCT FROM frozen_old THEN
      RAISE EXCEPTION 'A valuation is cancelled by the signed-in user, unchanged'
        USING ERRCODE = '23514';
    END IF;
    NEW.cancelled_at := now();
  ELSE
    RAISE EXCEPTION 'Valuation status cannot change from % to %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('draft', 'submitted') AND NOT (OLD.status = 'submitted' AND NEW.status = 'draft')
  THEN
    NEW.contributors := app.add_contributors(
      NEW.contributors, NEW.created_by, NEW.updated_by, NEW.submitted_by, app.current_user_id()
    );
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER valuation_guard BEFORE INSERT OR UPDATE OR DELETE ON "valuations"
  FOR EACH ROW EXECUTE FUNCTION app.guard_valuation();

-- Lines ---------------------------------------------------------------------------------------------
ALTER TABLE "valuation_lines" ADD CONSTRAINT "valuation_lines_check" CHECK (
  revision >= 1 AND line_no >= 1
  AND char_length(btrim(description)) >= 1
  AND COALESCE(CASE kind
    WHEN 'item' THEN bq_version_id IS NOT NULL AND bq_item_lineage_id IS NOT NULL
      AND item_kind IS NOT NULL AND item_amount_minor IS NOT NULL AND source IS NULL
      AND adjustment_kind IS NULL AND (basis IS NULL OR basis IN ('quantity', 'percent'))
      AND (measurement_id IS NULL) = (quantity_to_date IS NULL)
      AND (measurement_id IS NULL) = (measured_on IS NULL)
      AND (measurement_id IS NOT NULL OR amount_minor = 0)
      AND amount_minor >= 0
    WHEN 'materials' THEN source IN ('stores', 'manual') AND adjustment_kind IS NULL
      AND measurement_id IS NULL AND amount_minor > 0 AND quantity > 0
      AND (source = 'manual') = (bq_item_lineage_id IS NOT NULL)
      AND (source = 'stores') = (store_id IS NOT NULL AND material_id IS NOT NULL)
    WHEN 'adjustment' THEN adjustment_kind IN ('advance', 'advance_recovery', 'contra_charge',
      'other') AND source IS NULL AND measurement_id IS NULL AND bq_item_lineage_id IS NULL
      AND amount_minor <> 0
      AND (adjustment_kind <> 'advance' OR amount_minor > 0)
      AND (adjustment_kind NOT IN ('advance_recovery', 'contra_charge') OR amount_minor < 0)
    ELSE false
  END, false)
);

-- Lines are written only with their valuation's submission (same transaction, that revision).
CREATE FUNCTION app.guard_valuation_line() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Certificate lines never change' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM valuations
     WHERE tenant_id = NEW.tenant_id AND id = NEW.valuation_id AND status = 'submitted'
       AND revision = NEW.revision AND submitted_at = now()
  ) THEN
    RAISE EXCEPTION 'Certificate lines are written only with their submission'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER valuation_line_guard BEFORE INSERT OR UPDATE OR DELETE ON "valuation_lines"
  FOR EACH ROW EXECUTE FUNCTION app.guard_valuation_line();

-- At commit of a submission or certification, the frozen lines must match the header and the
-- measurements: the declared line count; work done = the item lines, each the value of an approved
-- measurement in force on the valuation date (packages/domain measurementsInForce and
-- measuredValueMinor) on the BQ in force, every such measurement valued once; materials = the
-- materials lines, stores lines = the project's stores at cost on the valuation date, and entered
-- materials never take an item above its amount (no billing twice once they are built in);
-- adjustments = the adjustment lines, recoveries never above the advances certified.
CREATE FUNCTION app.check_valuation_lines() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  sums record;
  stock bigint;
  expected integer;
BEGIN
  IF NEW.status NOT IN ('submitted', 'certified') THEN
    RETURN NULL;
  END IF;
  SELECT count(*) AS lines,
         COALESCE(sum(amount_minor) FILTER (WHERE kind = 'item'), 0) AS items,
         COALESCE(sum(amount_minor) FILTER (WHERE kind = 'materials'), 0) AS materials,
         COALESCE(sum(amount_minor) FILTER (WHERE kind = 'materials' AND source = 'stores'), 0)
           AS stores,
         count(*) FILTER (WHERE kind = 'materials' AND source = 'stores') AS store_lines,
         COALESCE(sum(amount_minor) FILTER (WHERE kind = 'adjustment'), 0) AS adjustments
    INTO sums FROM valuation_lines
   WHERE tenant_id = NEW.tenant_id AND valuation_id = NEW.id AND revision = NEW.revision;
  IF sums.lines <> NEW.line_count OR sums.items <> NEW.work_done_minor
     OR sums.materials <> NEW.materials_gross_minor OR sums.adjustments <> NEW.adjustments_minor
  THEN
    RAISE EXCEPTION 'A certificate''s lines add up to its figures' USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'interim' THEN
    -- Each item line names the BQ in force and values the measurement in force exactly.
    IF EXISTS (
      SELECT 1 FROM valuation_lines l
        JOIN bq_items i ON i.tenant_id = l.tenant_id AND i.version_id = l.bq_version_id
                       AND i.lineage_id = l.bq_item_lineage_id
        LEFT JOIN progress_measurements m ON m.tenant_id = l.tenant_id AND m.id = l.measurement_id
       WHERE l.tenant_id = NEW.tenant_id AND l.valuation_id = NEW.id AND l.revision = NEW.revision
         AND l.kind = 'item'
         AND (l.bq_version_id <> NEW.bq_version_id
              OR (l.measurement_id IS NOT NULL AND (
                   m.project_id <> NEW.project_id OR m.item_lineage_id <> l.bq_item_lineage_id
                   OR m.measured_on > NEW.valuation_date OR m.quantity_to_date <> l.quantity_to_date
                   OR COALESCE(m.basis, 'quantity')
                      IS DISTINCT FROM app.measurement_basis(i.kind, i.quantity, i.amount_minor)
                   OR l.amount_minor <> app.measured_value_minor(i.kind, i.amount_source, i.quantity,
                        i.rate, i.amount_minor, m.quantity_to_date))))
    ) THEN
      RAISE EXCEPTION 'Each item is valued from its approved measurement on the BQ in force'
        USING ERRCODE = '23514';
    END IF;
    -- The measurements in force on the valuation date (the newest approved, not superseded, in
    -- the item's current basis), each valued once, and no other measurement.
    WITH in_force AS (
      SELECT DISTINCT ON (m.item_lineage_id) m.id
        FROM progress_measurements m
        JOIN progress_measurement_reviews r ON r.tenant_id = m.tenant_id
         AND r.measurement_id = m.id AND r.decision = 'approved'
        JOIN bq_items i ON i.tenant_id = m.tenant_id AND i.version_id = NEW.bq_version_id
         AND i.lineage_id = m.item_lineage_id
       WHERE m.tenant_id = NEW.tenant_id AND m.project_id = NEW.project_id
         AND m.measured_on <= NEW.valuation_date
         AND COALESCE(m.basis, 'quantity') = app.measurement_basis(i.kind, i.quantity, i.amount_minor)
         AND NOT EXISTS (
           SELECT 1 FROM progress_measurements c
             JOIN progress_measurement_reviews cr ON cr.tenant_id = c.tenant_id
              AND cr.measurement_id = c.id AND cr.decision = 'approved'
            WHERE c.tenant_id = m.tenant_id AND c.corrects_id = m.id)
       ORDER BY m.item_lineage_id, m.measured_on DESC, m.recorded_at DESC, m.id DESC
    ), valued AS (
      SELECT measurement_id AS id FROM valuation_lines
       WHERE tenant_id = NEW.tenant_id AND valuation_id = NEW.id AND revision = NEW.revision
         AND kind = 'item' AND measurement_id IS NOT NULL
    )
    SELECT (SELECT count(*) FROM in_force WHERE id NOT IN (SELECT id FROM valued))
         + (SELECT count(*) FROM valued WHERE id NOT IN (SELECT id FROM in_force))
         + (SELECT count(*) - count(DISTINCT id) FROM valued)
      INTO expected;
    IF expected > 0 THEN
      RAISE EXCEPTION 'A certificate values every approved measurement in force, once'
        USING ERRCODE = '23514';
    END IF;
    -- Materials on site: the stores at cost on the valuation date (when included).
    SELECT COALESCE(sum(round(b.balance_value_minor)), 0)::bigint, count(*)::integer
      INTO stock, expected
      FROM (
        SELECT DISTINCT ON (e.store_id, e.material_id) e.balance_quantity, e.balance_value_minor
          FROM stock_ledger_entries e
         WHERE e.tenant_id = NEW.tenant_id AND e.project_id = NEW.project_id
           AND e.business_date <= NEW.valuation_date
         ORDER BY e.store_id, e.material_id, e.seq DESC
      ) b
     WHERE b.balance_quantity > 0 AND round(b.balance_value_minor) > 0;
    IF (NEW.materials_from_stores AND (sums.stores <> stock OR sums.store_lines <> expected))
       OR (NOT NEW.materials_from_stores AND sums.store_lines > 0) THEN
      RAISE EXCEPTION 'Materials from stores are the stores at cost on the valuation date'
        USING ERRCODE = '23514';
    END IF;
    -- Entered materials never take an item above its amount with the work valued.
    IF EXISTS (
      SELECT 1 FROM valuation_lines l
        JOIN bq_items i ON i.tenant_id = l.tenant_id AND i.version_id = NEW.bq_version_id
                       AND i.lineage_id = l.bq_item_lineage_id
       WHERE l.tenant_id = NEW.tenant_id AND l.valuation_id = NEW.id AND l.revision = NEW.revision
         AND l.kind = 'materials' AND l.source = 'manual'
       GROUP BY l.bq_item_lineage_id, i.amount_minor
      HAVING sum(l.amount_minor) + COALESCE((
          SELECT sum(w.amount_minor) FROM valuation_lines w
           WHERE w.tenant_id = NEW.tenant_id AND w.valuation_id = NEW.id
             AND w.revision = NEW.revision AND w.kind = 'item'
             AND w.bq_item_lineage_id = l.bq_item_lineage_id), 0) > i.amount_minor
    ) THEN
      RAISE EXCEPTION 'Materials on site for an item never exceed what remains of it'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  -- Advance recovery never exceeds the advances (certified certificates and this one).
  IF (SELECT COALESCE(sum(l.amount_minor), 0)
        FROM valuation_lines l
        JOIN valuations c ON c.tenant_id = l.tenant_id AND c.id = l.valuation_id
                         AND l.revision = c.revision
       WHERE l.tenant_id = NEW.tenant_id AND c.project_id = NEW.project_id
         AND l.kind = 'adjustment' AND l.adjustment_kind IN ('advance', 'advance_recovery')
         AND (c.status = 'certified' OR c.id = NEW.id)) < 0 THEN
    RAISE EXCEPTION 'Advance recovery never exceeds the advances certified' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER valuation_lines_complete AFTER UPDATE ON "valuations"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_valuation_lines();

-- Draft inputs: entered materials and adjustments --------------------------------------------------
ALTER TABLE "valuation_materials" ADD CONSTRAINT "valuation_materials_check" CHECK (
  char_length(btrim(description)) >= 2 AND quantity > 0 AND amount_minor > 0
  AND (unit IS NULL OR char_length(btrim(unit)) >= 1)
);
ALTER TABLE "valuation_adjustments" ADD CONSTRAINT "valuation_adjustments_check" CHECK (
  kind IN ('advance', 'advance_recovery', 'contra_charge', 'other')
  AND char_length(btrim(description)) >= 3 AND amount_minor <> 0
  AND (kind <> 'advance' OR amount_minor > 0)
  AND (kind NOT IN ('advance_recovery', 'contra_charge') OR amount_minor < 0)
);
-- Added (by the signed-in user) or removed only while their valuation is an interim draft; never
-- edited (remove and add again); entered materials name a measured item; at most 100 materials
-- and 50 adjustments per valuation.
CREATE FUNCTION app.guard_valuation_input() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  row_tenant uuid;
  row_project uuid;
  row_valuation uuid;
  target record;
  item record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Valuation inputs are removed and added again, never edited'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    row_tenant := NEW.tenant_id;
    row_project := NEW.project_id;
    row_valuation := NEW.valuation_id;
  ELSE
    row_tenant := OLD.tenant_id;
    row_project := OLD.project_id;
    row_valuation := OLD.valuation_id;
  END IF;
  SELECT status, kind INTO target FROM valuations
   WHERE tenant_id = row_tenant AND id = row_valuation;
  IF target.status IS DISTINCT FROM 'draft' OR target.kind IS DISTINCT FROM 'interim' THEN
    RAISE EXCEPTION 'Materials and adjustments change only on an interim draft'
      USING ERRCODE = '23514';
  END IF;
  PERFORM app.assert_quality_writable(row_tenant, row_project);
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NEW.created_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'Valuation inputs are entered by the signed-in user' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'valuation_materials' THEN
    SELECT kind, quantity, amount_minor INTO item FROM bq_items
     WHERE tenant_id = NEW.tenant_id AND version_id = NEW.bq_version_id
       AND lineage_id = NEW.bq_item_lineage_id;
    IF app.measurement_basis(item.kind, item.quantity, item.amount_minor) IS NULL THEN
      RAISE EXCEPTION 'Materials on site are entered against a measured item'
        USING ERRCODE = '23514';
    END IF;
    IF (SELECT count(*) FROM valuation_materials
         WHERE tenant_id = NEW.tenant_id AND valuation_id = NEW.valuation_id) >= 100 THEN
      RAISE EXCEPTION 'A valuation has at most 100 materials lines' USING ERRCODE = '23514';
    END IF;
  ELSIF (SELECT count(*) FROM valuation_adjustments
          WHERE tenant_id = NEW.tenant_id AND valuation_id = NEW.valuation_id) >= 50 THEN
    RAISE EXCEPTION 'A valuation has at most 50 adjustments' USING ERRCODE = '23514';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END
$$;
CREATE TRIGGER valuation_material_guard BEFORE INSERT OR UPDATE OR DELETE ON "valuation_materials"
  FOR EACH ROW EXECUTE FUNCTION app.guard_valuation_input();
CREATE TRIGGER valuation_adjustment_guard BEFORE INSERT OR UPDATE OR DELETE
  ON "valuation_adjustments" FOR EACH ROW EXECUTE FUNCTION app.guard_valuation_input();

-- Row-level security ---------------------------------------------------------------------------------
DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['progress_measurement_photos', 'progress_measurement_reviews',
    'contract_settings', 'valuations', 'valuation_lines', 'valuation_materials',
    'valuation_adjustments']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = app.current_tenant_id()) '
      'WITH CHECK (tenant_id = app.current_tenant_id())', target || '_isolation', target);
  END LOOP;
END
$$;

-- The runtime role never deletes or rewrites evidence, reviews, settings, certificates or lines;
-- valuations change only through the guarded transitions; draft inputs may be removed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmb_app') THEN
    REVOKE UPDATE, DELETE ON "progress_measurement_photos", "progress_measurement_reviews",
      "contract_settings", "valuation_lines" FROM pmb_app;
    REVOKE DELETE ON "valuations" FROM pmb_app;
    REVOKE UPDATE ON "valuation_materials", "valuation_adjustments" FROM pmb_app;
    REVOKE TRUNCATE, REFERENCES, TRIGGER
      ON "progress_measurement_photos", "progress_measurement_reviews", "contract_settings",
         "valuations", "valuation_lines", "valuation_materials", "valuation_adjustments"
      FROM pmb_app;
    GRANT EXECUTE ON FUNCTION app.div_half_up(numeric, numeric) TO pmb_app;
    GRANT EXECUTE ON FUNCTION app.measurement_basis(text, numeric, bigint) TO pmb_app;
    GRANT EXECUTE ON FUNCTION app.measured_value_minor(text, text, numeric, numeric, bigint, numeric)
      TO pmb_app;
    GRANT EXECUTE ON FUNCTION app.check_valuation(valuations) TO pmb_app;
  END IF;
END
$$;
REVOKE EXECUTE ON FUNCTION app.div_half_up(numeric, numeric) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.measurement_basis(text, numeric, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.measured_value_minor(text, text, numeric, numeric, bigint, numeric)
  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_valuation(valuations) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_progress_measurement() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_measurement_photo() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_measurement_review() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_contract_settings() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_valuation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_valuation_line() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_valuation_lines() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_valuation_input() FROM PUBLIC;

COMMIT;
