-- D6.1 Quality (brief §5.9 "inspections and quality … snag list / defects, practical completion,
-- defects liability period tracking" and §15 C/G; ARCHITECTURE §4.7; ERD §9; WORKFLOWS "Quality").
-- Enforces, in the database as well as the API:
-- * quality_settings: the company's default DLP (months) and cube-result grace days.
-- * checklist_templates + checklist_template_items: company templates, VERSIONED and append-only
--   (a revision or a retirement appends the next version; inspections keep the version they used).
-- * inspections + inspection_items + inspection_item_photos: draft (the author answers pass / fail /
--   N/A with notes and site photos) → submitted (every item answered, every failure explained; the
--   result follows the items) → signed off by someone who neither created nor submitted it, then
--   LOCKED; or returned to draft with a reason by such a reviewer.
-- * snags + snag_photos: open → fixed → closed (verified by someone other than the fixer) or
--   reopened with a reason; closed snags are final; a snag raised after practical completion is a
--   defects liability period (dlp) snag.
-- * cube_sets + cube_results: results are append-only, the stored mean and outcome are re-checked
--   against rule KE-CUBE-1, and a correction supersedes a result once with a reason.
-- * slump_tests: append-only, outcome = |measured − target| ≤ tolerance (KE-SLUMP-1), corrections
--   supersede once with a reason.
-- * project_completions: practical and final completion certificates, proposed then certified by
--   someone other than the proposer (LOCKED) or withdrawn with a reason; practical completion is
--   refused with open critical snags (final: any open snag) unless an exception reason is recorded.
-- * Every record is numbered in order per project; closed and cancelled projects are read-only.
-- Every table has tenant_id, forced RLS with WITH CHECK and composite (tenant_id, …) foreign keys.
-- No new permissions (quality.manage, site.diary and projects.manage already exist), so the
-- permission CHECK constraints are unchanged.
BEGIN;

-- CreateTable
CREATE TABLE "quality_settings" (
    "tenant_id" UUID NOT NULL,
    "dlp_months" INTEGER NOT NULL DEFAULT 6,
    "cube_overdue_grace_days" INTEGER NOT NULL DEFAULT 2,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quality_settings_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "checklist_templates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "lineage_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "category" VARCHAR(20) NOT NULL,
    "description" VARCHAR(500),
    "retired" BOOLEAN NOT NULL DEFAULT false,
    "item_count" INTEGER NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "checklist_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checklist_template_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "text" VARCHAR(300) NOT NULL,

    CONSTRAINT "checklist_template_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inspections" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "template_id" UUID NOT NULL,
    "category" VARCHAR(20) NOT NULL,
    "location" VARCHAR(200) NOT NULL,
    "inspector_type" VARCHAR(12) NOT NULL,
    "inspector_name" VARCHAR(150),
    "inspected_on" DATE NOT NULL,
    "wbs_node_id" UUID,
    "schedule_activity_id" UUID,
    "bq_version_id" UUID,
    "bq_item_lineage_id" UUID,
    "notes" VARCHAR(2000),
    "status" VARCHAR(12) NOT NULL DEFAULT 'draft',
    "result" VARCHAR(4),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_by" UUID,
    "submitted_at" TIMESTAMPTZ,
    "signed_off_by" UUID,
    "signed_off_at" TIMESTAMPTZ,
    "returned_by" UUID,
    "returned_at" TIMESTAMPTZ,
    "return_reason" VARCHAR(500),
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inspections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inspection_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "inspection_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "text" VARCHAR(300) NOT NULL,
    "result" VARCHAR(8) NOT NULL DEFAULT 'pending',
    "note" VARCHAR(1000),
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inspection_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inspection_item_photos" (
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "photo_id" UUID NOT NULL,

    CONSTRAINT "inspection_item_photos_pkey" PRIMARY KEY ("tenant_id","item_id","photo_id")
);

-- CreateTable
CREATE TABLE "snags" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "location" VARCHAR(200) NOT NULL,
    "description" VARCHAR(2000) NOT NULL,
    "severity" VARCHAR(10) NOT NULL,
    "responsible_kind" VARCHAR(15) NOT NULL,
    "responsible_name" VARCHAR(150) NOT NULL,
    "due_on" DATE,
    "phase" VARCHAR(12) NOT NULL,
    "inspection_item_id" UUID,
    "status" VARCHAR(8) NOT NULL DEFAULT 'open',
    "fix_note" VARCHAR(1000),
    "reopen_count" INTEGER NOT NULL DEFAULT 0,
    "last_reopen_reason" VARCHAR(500),
    "raised_by" UUID NOT NULL,
    "raised_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fixed_by" UUID,
    "fixed_at" TIMESTAMPTZ,
    "closed_by" UUID,
    "closed_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "snags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "snag_photos" (
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "snag_id" UUID NOT NULL,
    "photo_id" UUID NOT NULL,
    "stage" VARCHAR(8) NOT NULL,
    "added_by" UUID NOT NULL,
    "added_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "snag_photos_pkey" PRIMARY KEY ("tenant_id","snag_id","photo_id")
);

-- CreateTable
CREATE TABLE "cube_sets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "element" VARCHAR(200) NOT NULL,
    "concrete_class" VARCHAR(4) NOT NULL,
    "specified_strength" INTEGER NOT NULL,
    "cast_on" DATE NOT NULL,
    "cubes_per_age" INTEGER NOT NULL,
    "batch_reference" VARCHAR(60),
    "notes" VARCHAR(1000),
    "status" VARCHAR(6) NOT NULL DEFAULT 'active',
    "void_reason" VARCHAR(500),
    "voided_by" UUID,
    "voided_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cube_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cube_results" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "cube_set_id" UUID NOT NULL,
    "age_days" INTEGER NOT NULL,
    "tested_on" DATE NOT NULL,
    "strengths" DECIMAL(4,1)[],
    "mean_strength" DECIMAL(5,2) NOT NULL,
    "min_strength" DECIMAL(4,1) NOT NULL,
    "outcome" VARCHAR(16) NOT NULL,
    "rule_version" VARCHAR(20) NOT NULL,
    "laboratory" VARCHAR(120),
    "report_reference" VARCHAR(60),
    "supersedes_id" UUID,
    "correction_reason" VARCHAR(500),
    "recorded_by" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cube_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slump_tests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "tested_on" DATE NOT NULL,
    "element" VARCHAR(200) NOT NULL,
    "concrete_class" VARCHAR(4),
    "cube_set_id" UUID,
    "target_mm" INTEGER NOT NULL,
    "tolerance_mm" INTEGER NOT NULL,
    "measured_mm" INTEGER NOT NULL,
    "outcome" VARCHAR(4) NOT NULL,
    "rule_version" VARCHAR(20) NOT NULL,
    "notes" VARCHAR(1000),
    "supersedes_id" UUID,
    "correction_reason" VARCHAR(500),
    "recorded_by" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "slump_tests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_completions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "kind" VARCHAR(10) NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'proposed',
    "completion_date" DATE NOT NULL,
    "dlp_months" INTEGER,
    "dlp_ends_on" DATE,
    "open_critical_snags" INTEGER NOT NULL,
    "open_snags" INTEGER NOT NULL,
    "exception_reason" VARCHAR(500),
    "notes" VARCHAR(1000),
    "version" INTEGER NOT NULL DEFAULT 1,
    "proposed_by" UUID NOT NULL,
    "proposed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "certified_by" UUID,
    "certified_at" TIMESTAMPTZ,
    "withdrawn_by" UUID,
    "withdrawn_at" TIMESTAMPTZ,
    "withdraw_reason" VARCHAR(500),

    CONSTRAINT "project_completions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "checklist_templates_tenant_id_id_key" ON "checklist_templates"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "checklist_templates_tenant_id_lineage_id_version_key" ON "checklist_templates"("tenant_id", "lineage_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "checklist_template_items_tenant_id_template_id_position_key" ON "checklist_template_items"("tenant_id", "template_id", "position");

-- CreateIndex
CREATE INDEX "inspections_tenant_id_project_id_status_idx" ON "inspections"("tenant_id", "project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "inspections_tenant_id_id_key" ON "inspections"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inspections_tenant_id_project_id_id_key" ON "inspections"("tenant_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inspections_tenant_id_project_id_number_key" ON "inspections"("tenant_id", "project_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "inspection_items_tenant_id_project_id_id_key" ON "inspection_items"("tenant_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inspection_items_tenant_id_inspection_id_position_key" ON "inspection_items"("tenant_id", "inspection_id", "position");

-- CreateIndex
CREATE INDEX "inspection_item_photos_tenant_id_project_id_photo_id_idx" ON "inspection_item_photos"("tenant_id", "project_id", "photo_id");

-- CreateIndex
CREATE INDEX "snags_tenant_id_project_id_status_idx" ON "snags"("tenant_id", "project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "snags_tenant_id_id_key" ON "snags"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "snags_tenant_id_project_id_id_key" ON "snags"("tenant_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "snags_tenant_id_project_id_number_key" ON "snags"("tenant_id", "project_id", "number");

-- CreateIndex
CREATE INDEX "snag_photos_tenant_id_project_id_photo_id_idx" ON "snag_photos"("tenant_id", "project_id", "photo_id");

-- CreateIndex
CREATE INDEX "cube_sets_tenant_id_project_id_cast_on_idx" ON "cube_sets"("tenant_id", "project_id", "cast_on");

-- CreateIndex
CREATE UNIQUE INDEX "cube_sets_tenant_id_id_key" ON "cube_sets"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "cube_sets_tenant_id_project_id_id_key" ON "cube_sets"("tenant_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "cube_sets_tenant_id_project_id_number_key" ON "cube_sets"("tenant_id", "project_id", "number");

-- CreateIndex
CREATE INDEX "cube_results_tenant_id_cube_set_id_age_days_idx" ON "cube_results"("tenant_id", "cube_set_id", "age_days");

-- CreateIndex
CREATE UNIQUE INDEX "cube_results_tenant_id_project_id_id_key" ON "cube_results"("tenant_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "cube_results_tenant_id_project_id_supersedes_id_key" ON "cube_results"("tenant_id", "project_id", "supersedes_id");

-- CreateIndex
CREATE INDEX "slump_tests_tenant_id_project_id_number_idx" ON "slump_tests"("tenant_id", "project_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "slump_tests_tenant_id_project_id_id_key" ON "slump_tests"("tenant_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "slump_tests_tenant_id_project_id_supersedes_id_key" ON "slump_tests"("tenant_id", "project_id", "supersedes_id");

-- CreateIndex
CREATE INDEX "project_completions_tenant_id_project_id_kind_idx" ON "project_completions"("tenant_id", "project_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "project_completions_tenant_id_id_key" ON "project_completions"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "site_photos_tenant_id_project_id_id_key" ON "site_photos"("tenant_id", "project_id", "id");

-- AddForeignKey
ALTER TABLE "quality_settings" ADD CONSTRAINT "quality_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_tenant_id_lineage_id_fkey" FOREIGN KEY ("tenant_id", "lineage_id") REFERENCES "checklist_templates"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_template_items" ADD CONSTRAINT "checklist_template_items_tenant_id_template_id_fkey" FOREIGN KEY ("tenant_id", "template_id") REFERENCES "checklist_templates"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_tenant_id_project_id_site_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "site_id") REFERENCES "sites"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_tenant_id_template_id_fkey" FOREIGN KEY ("tenant_id", "template_id") REFERENCES "checklist_templates"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_tenant_id_project_id_wbs_node_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "wbs_node_id") REFERENCES "wbs_nodes"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_tenant_id_project_id_schedule_activity_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "schedule_activity_id") REFERENCES "schedule_activities"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_tenant_id_bq_version_id_bq_item_lineage_id_fkey" FOREIGN KEY ("tenant_id", "bq_version_id", "bq_item_lineage_id") REFERENCES "bq_items"("tenant_id", "version_id", "lineage_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspection_items" ADD CONSTRAINT "inspection_items_tenant_id_project_id_inspection_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "inspection_id") REFERENCES "inspections"("tenant_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspection_item_photos" ADD CONSTRAINT "inspection_item_photos_tenant_id_project_id_item_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "item_id") REFERENCES "inspection_items"("tenant_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspection_item_photos" ADD CONSTRAINT "inspection_item_photos_tenant_id_project_id_photo_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "photo_id") REFERENCES "site_photos"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "snags" ADD CONSTRAINT "snags_tenant_id_project_id_site_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "site_id") REFERENCES "sites"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "snags" ADD CONSTRAINT "snags_tenant_id_project_id_inspection_item_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "inspection_item_id") REFERENCES "inspection_items"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "snag_photos" ADD CONSTRAINT "snag_photos_tenant_id_project_id_snag_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "snag_id") REFERENCES "snags"("tenant_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "snag_photos" ADD CONSTRAINT "snag_photos_tenant_id_project_id_photo_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "photo_id") REFERENCES "site_photos"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cube_sets" ADD CONSTRAINT "cube_sets_tenant_id_project_id_site_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "site_id") REFERENCES "sites"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cube_results" ADD CONSTRAINT "cube_results_tenant_id_project_id_cube_set_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "cube_set_id") REFERENCES "cube_sets"("tenant_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cube_results" ADD CONSTRAINT "cube_results_tenant_id_project_id_supersedes_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "supersedes_id") REFERENCES "cube_results"("tenant_id", "project_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slump_tests" ADD CONSTRAINT "slump_tests_tenant_id_project_id_site_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "site_id") REFERENCES "sites"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slump_tests" ADD CONSTRAINT "slump_tests_tenant_id_project_id_cube_set_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "cube_set_id") REFERENCES "cube_sets"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slump_tests" ADD CONSTRAINT "slump_tests_tenant_id_project_id_supersedes_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "supersedes_id") REFERENCES "slump_tests"("tenant_id", "project_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_completions" ADD CONSTRAINT "project_completions_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Shared guard -----------------------------------------------------------------------------------
-- Closed and cancelled projects are read-only (packages/domain isProjectReadOnly). FOR SHARE waits
-- for a concurrent status change.
CREATE FUNCTION app.assert_quality_writable(target_tenant uuid, target_project uuid)
  RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  project_status text;
BEGIN
  SELECT status INTO project_status FROM projects
    WHERE tenant_id = target_tenant AND id = target_project FOR SHARE;
  IF project_status IN ('closed', 'cancelled') THEN
    RAISE EXCEPTION 'Closed and cancelled projects are read-only' USING ERRCODE = '23514';
  END IF;
END
$$;

-- Snags that are not closed on a project (all, and critical): what completion is checked against.
CREATE FUNCTION app.open_snag_counts(target_tenant uuid, target_project uuid,
  OUT open_all integer, OUT open_critical integer) LANGUAGE sql STABLE AS $$
  SELECT count(*)::integer, (count(*) FILTER (WHERE severity = 'critical'))::integer
    FROM snags
   WHERE tenant_id = target_tenant AND project_id = target_project AND status <> 'closed'
$$;

-- Settings ---------------------------------------------------------------------------------------
-- packages/types QUALITY_SETTINGS_LIMITS.
ALTER TABLE "quality_settings" ADD CONSTRAINT "quality_settings_check" CHECK (
  dlp_months BETWEEN 1 AND 24 AND cube_overdue_grace_days BETWEEN 0 AND 14 AND version >= 1
);
CREATE FUNCTION app.guard_quality_settings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.updated_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'Settings are changed by the signed-in user' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION 'Settings start at version 1' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.tenant_id <> OLD.tenant_id OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'The company is fixed and the version must advance' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER quality_settings_guard BEFORE INSERT OR UPDATE ON "quality_settings"
  FOR EACH ROW EXECUTE FUNCTION app.guard_quality_settings();

-- Checklist templates (versioned, append-only) ---------------------------------------------------
-- packages/types INSPECTION_CATEGORIES, QUALITY_LIMITS.maxTemplateItems / maxTemplateItemChars.
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_check" CHECK (
  version >= 1
  AND (version = 1) = (lineage_id = id)
  AND char_length(name) BETWEEN 3 AND 120 AND name = btrim(name)
  AND category IN ('setting_out', 'excavation', 'foundations', 'blockwork', 'columns_beams',
    'slab', 'roofing', 'plumbing', 'electrical', 'finishes', 'handover', 'other')
  AND (description IS NULL OR char_length(btrim(description)) >= 1)
  AND item_count BETWEEN 1 AND 60
  AND (version > 1 OR NOT retired)
);
ALTER TABLE "checklist_template_items" ADD CONSTRAINT "checklist_template_items_check" CHECK (
  position BETWEEN 1 AND 60 AND char_length(btrim(text)) BETWEEN 3 AND 300
);
-- A version follows the newest version of its lineage, which must not be retired; it is created
-- by the signed-in user and stamped with the database clock. Concurrent revisions of the same
-- version collide on (tenant_id, lineage_id, version).
CREATE FUNCTION app.guard_checklist_template() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  latest checklist_templates%ROWTYPE;
BEGIN
  IF NEW.created_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A template is written by the signed-in user' USING ERRCODE = '23514';
  END IF;
  IF NEW.version > 1 THEN
    SELECT * INTO latest FROM checklist_templates
      WHERE tenant_id = NEW.tenant_id AND lineage_id = NEW.lineage_id
      ORDER BY version DESC LIMIT 1;
    IF latest.id IS NULL OR NEW.version <> latest.version + 1 THEN
      RAISE EXCEPTION 'Template versions follow each other' USING ERRCODE = '23514';
    END IF;
    IF latest.retired THEN
      RAISE EXCEPTION 'A retired template cannot be revised' USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER checklist_template_guard BEFORE INSERT ON "checklist_templates"
  FOR EACH ROW EXECUTE FUNCTION app.guard_checklist_template();
-- Items are written only in their version's own transaction.
CREATE FUNCTION app.guard_checklist_template_item() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM checklist_templates
     WHERE tenant_id = NEW.tenant_id AND id = NEW.template_id AND created_at = now()
  ) THEN
    RAISE EXCEPTION 'Template items are written only with their version' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER checklist_template_item_guard BEFORE INSERT ON "checklist_template_items"
  FOR EACH ROW EXECUTE FUNCTION app.guard_checklist_template_item();
-- At commit, a version holds exactly its declared items, numbered 1…n.
CREATE FUNCTION app.check_checklist_template_items() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM checklist_template_items
       WHERE tenant_id = NEW.tenant_id AND template_id = NEW.id AND position <= NEW.item_count)
     <> NEW.item_count
    OR (SELECT count(*) FROM checklist_template_items
       WHERE tenant_id = NEW.tenant_id AND template_id = NEW.id) <> NEW.item_count THEN
    RAISE EXCEPTION 'A template version must hold exactly its declared items'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER checklist_template_items_complete AFTER INSERT ON "checklist_templates"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_checklist_template_items();
CREATE TRIGGER checklist_templates_append_only BEFORE UPDATE OR DELETE ON "checklist_templates"
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
CREATE TRIGGER checklist_template_items_append_only BEFORE UPDATE OR DELETE ON "checklist_template_items"
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();

-- Inspections ------------------------------------------------------------------------------------
-- packages/types INSPECTION_STATUSES, INSPECTOR_TYPES, INSPECTION_RESULTS; packages/domain
-- INSPECTION_TRANSITIONS. A signed-off inspection was signed by someone who neither created nor
-- submitted it.
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_check" CHECK (
  number >= 1 AND version >= 1
  AND category IN ('setting_out', 'excavation', 'foundations', 'blockwork', 'columns_beams',
    'slab', 'roofing', 'plumbing', 'electrical', 'finishes', 'handover', 'other')
  AND inspector_type IN ('internal', 'consultant', 'county')
  AND char_length(location) BETWEEN 2 AND 200 AND location = btrim(location)
  AND (inspector_name IS NULL OR char_length(btrim(inspector_name)) BETWEEN 1 AND 150)
  AND (notes IS NULL OR char_length(btrim(notes)) >= 1)
  AND (bq_version_id IS NULL) = (bq_item_lineage_id IS NULL)
  AND (result IS NULL OR result IN ('pass', 'fail'))
  AND COALESCE(CASE status
    WHEN 'draft' THEN submitted_by IS NULL AND submitted_at IS NULL AND signed_off_by IS NULL
      AND signed_off_at IS NULL AND result IS NULL
    WHEN 'submitted' THEN submitted_by IS NOT NULL AND submitted_at IS NOT NULL
      AND signed_off_by IS NULL AND signed_off_at IS NULL AND result IS NOT NULL
    WHEN 'signed_off' THEN submitted_by IS NOT NULL AND submitted_at IS NOT NULL
      AND signed_off_by IS NOT NULL AND signed_off_at IS NOT NULL AND result IS NOT NULL
      AND signed_off_by <> created_by AND signed_off_by <> submitted_by
    ELSE false END, false)
  AND (returned_by IS NULL) = (returned_at IS NULL)
  AND (returned_by IS NULL) = (return_reason IS NULL)
  AND (return_reason IS NULL OR char_length(btrim(return_reason)) BETWEEN 3 AND 500)
  AND (returned_by IS NULL OR returned_by <> created_by)
);
ALTER TABLE "inspection_items" ADD CONSTRAINT "inspection_items_check" CHECK (
  position BETWEEN 1 AND 60
  AND char_length(btrim(text)) BETWEEN 3 AND 300
  AND result IN ('pending', 'pass', 'fail', 'na')
  AND (note IS NULL OR char_length(btrim(note)) BETWEEN 1 AND 1000)
);

CREATE FUNCTION app.guard_inspection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  latest integer;
  template checklist_templates%ROWTYPE;
  newest integer;
  bq_project uuid;
  bq_status text;
  pending integer;
  failed integer;
  unexplained integer;
  total integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Inspections cannot be deleted' USING ERRCODE = '42501';
  END IF;
  PERFORM app.assert_quality_writable(NEW.tenant_id, NEW.project_id);
  IF NEW.updated_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'Inspections are changed by the signed-in user' USING ERRCODE = '23514';
  END IF;
  IF NEW.inspected_on > app.business_today() THEN
    RAISE EXCEPTION 'An inspection cannot be dated in the future' USING ERRCODE = '23514';
  END IF;
  IF NEW.bq_version_id IS NOT NULL AND (TG_OP = 'INSERT'
      OR NEW.bq_version_id IS DISTINCT FROM OLD.bq_version_id) THEN
    SELECT project_id, status INTO bq_project, bq_status FROM bq_versions
      WHERE tenant_id = NEW.tenant_id AND id = NEW.bq_version_id;
    IF bq_project IS DISTINCT FROM NEW.project_id OR bq_status IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION 'A BQ link must name an approved version of the same project'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.updated_at := now();
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.version <> 1 OR NEW.returned_by IS NOT NULL
      OR NEW.created_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'An inspection starts as the signed-in author''s draft'
        USING ERRCODE = '23514';
    END IF;
    SELECT * INTO template FROM checklist_templates
      WHERE tenant_id = NEW.tenant_id AND id = NEW.template_id;
    SELECT max(version) INTO newest FROM checklist_templates
      WHERE tenant_id = NEW.tenant_id AND lineage_id = template.lineage_id;
    IF template.id IS NULL OR template.version <> newest OR template.retired
      OR template.category <> NEW.category THEN
      RAISE EXCEPTION 'An inspection uses the current version of a template that is not retired'
        USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM projects WHERE tenant_id = NEW.tenant_id AND id = NEW.project_id FOR UPDATE;
    SELECT max(number) INTO latest FROM inspections
      WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id;
    IF NEW.number <> COALESCE(latest, 0) + 1 THEN
      RAISE EXCEPTION 'Inspections are numbered in order' USING ERRCODE = '23514';
    END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  IF OLD.status = 'signed_off' THEN
    RAISE EXCEPTION 'Signed-off inspections are locked' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.id, NEW.tenant_id, NEW.project_id, NEW.site_id, NEW.number, NEW.template_id,
      NEW.category, NEW.created_by, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.project_id, OLD.site_id, OLD.number,
      OLD.template_id, OLD.category, OLD.created_by, OLD.created_at)
    OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Inspection identity is fixed and its version must advance'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = OLD.status THEN
    IF OLD.status <> 'draft' OR OLD.created_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'Only the author can edit a draft inspection' USING ERRCODE = '23514';
    END IF;
    IF ROW(NEW.returned_by, NEW.returned_at, NEW.return_reason)
      IS DISTINCT FROM ROW(OLD.returned_by, OLD.returned_at, OLD.return_reason) THEN
      RAISE EXCEPTION 'Sign-off records change only with a transition' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.location, NEW.inspector_type, NEW.inspector_name, NEW.inspected_on, NEW.notes,
      NEW.wbs_node_id, NEW.schedule_activity_id, NEW.bq_version_id, NEW.bq_item_lineage_id)
    IS DISTINCT FROM ROW(OLD.location, OLD.inspector_type, OLD.inspector_name, OLD.inspected_on,
      OLD.notes, OLD.wbs_node_id, OLD.schedule_activity_id, OLD.bq_version_id,
      OLD.bq_item_lineage_id) THEN
    RAISE EXCEPTION 'Content cannot change during sign-off' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'draft' AND NEW.status = 'submitted' THEN
    IF OLD.created_by IS DISTINCT FROM app.current_user_id()
      OR NEW.submitted_by IS DISTINCT FROM app.current_user_id()
      OR ROW(NEW.returned_by, NEW.returned_at, NEW.return_reason)
        IS DISTINCT FROM ROW(OLD.returned_by, OLD.returned_at, OLD.return_reason) THEN
      RAISE EXCEPTION 'Only the author can submit' USING ERRCODE = '23514';
    END IF;
    SELECT count(*) FILTER (WHERE result = 'pending'), count(*) FILTER (WHERE result = 'fail'),
      count(*) FILTER (WHERE result = 'fail' AND (note IS NULL OR char_length(btrim(note)) < 3)),
      count(*)
      INTO pending, failed, unexplained, total
      FROM inspection_items WHERE tenant_id = NEW.tenant_id AND inspection_id = NEW.id;
    IF total = 0 OR pending > 0 OR unexplained > 0 THEN
      RAISE EXCEPTION 'Every item needs an answer and every failed item a note'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.result IS DISTINCT FROM (CASE WHEN failed > 0 THEN 'fail' ELSE 'pass' END) THEN
      RAISE EXCEPTION 'The result follows the items' USING ERRCODE = '23514';
    END IF;
    NEW.submitted_at := now();
  ELSIF OLD.status = 'submitted' AND NEW.status = 'signed_off' THEN
    IF NEW.signed_off_by IS DISTINCT FROM app.current_user_id()
      OR app.current_user_id() IN (OLD.created_by, OLD.submitted_by)
      OR ROW(NEW.submitted_by, NEW.submitted_at, NEW.result, NEW.returned_by, NEW.returned_at,
        NEW.return_reason) IS DISTINCT FROM ROW(OLD.submitted_by, OLD.submitted_at, OLD.result,
        OLD.returned_by, OLD.returned_at, OLD.return_reason) THEN
      RAISE EXCEPTION 'An independent reviewer signs off an inspection' USING ERRCODE = '23514';
    END IF;
    NEW.signed_off_at := now();
  ELSIF OLD.status = 'submitted' AND NEW.status = 'draft' THEN
    IF NEW.returned_by IS DISTINCT FROM app.current_user_id()
      OR app.current_user_id() IN (OLD.created_by, OLD.submitted_by) THEN
      RAISE EXCEPTION 'An independent reviewer returns an inspection' USING ERRCODE = '23514';
    END IF;
    NEW.returned_at := now();
  ELSE
    RAISE EXCEPTION 'Invalid inspection transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER inspection_guard BEFORE INSERT OR UPDATE OR DELETE ON "inspections"
  FOR EACH ROW EXECUTE FUNCTION app.guard_inspection();
-- At commit, a new inspection holds every item of its template version.
CREATE FUNCTION app.check_inspection_items() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM inspection_items
       WHERE tenant_id = NEW.tenant_id AND inspection_id = NEW.id)
    <> (SELECT item_count FROM checklist_templates
         WHERE tenant_id = NEW.tenant_id AND id = NEW.template_id) THEN
    RAISE EXCEPTION 'An inspection must hold every item of its template'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER inspection_items_complete AFTER INSERT ON "inspections"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_inspection_items();

-- Items are copied from the template version with the inspection; afterwards only the author
-- answers them, and only while the inspection is a draft.
CREATE FUNCTION app.guard_inspection_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent inspections%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Inspection items cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF NEW.updated_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'Items are answered by the signed-in user' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO parent FROM inspections
    WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id AND id = NEW.inspection_id
    FOR SHARE;
  NEW.updated_at := now();
  IF TG_OP = 'INSERT' THEN
    IF parent.created_at IS DISTINCT FROM now() OR NEW.result <> 'pending' OR NEW.note IS NOT NULL
      OR NEW.text IS DISTINCT FROM (SELECT text FROM checklist_template_items
        WHERE tenant_id = NEW.tenant_id AND template_id = parent.template_id
          AND position = NEW.position) THEN
      RAISE EXCEPTION 'Items are copied from the template with their inspection'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.tenant_id, NEW.project_id, NEW.inspection_id, NEW.position, NEW.text)
    IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.project_id, OLD.inspection_id, OLD.position,
      OLD.text) THEN
    RAISE EXCEPTION 'An item''s identity and text are fixed' USING ERRCODE = '23514';
  END IF;
  IF parent.status IS DISTINCT FROM 'draft'
    OR parent.created_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'Only the author answers items of a draft inspection'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER inspection_item_guard BEFORE INSERT OR UPDATE OR DELETE ON "inspection_items"
  FOR EACH ROW EXECUTE FUNCTION app.guard_inspection_item();

-- Item photos are attached or removed by the author while the inspection is a draft (at most six
-- per item, packages/types QUALITY_LIMITS.maxPhotosPerItem).
CREATE FUNCTION app.guard_inspection_item_photo() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target inspection_item_photos%ROWTYPE;
  parent inspections%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    target := OLD;
  ELSE
    target := NEW;
  END IF;
  SELECT i.* INTO parent FROM inspections i
    JOIN inspection_items t ON t.tenant_id = i.tenant_id AND t.inspection_id = i.id
   WHERE t.tenant_id = target.tenant_id AND t.project_id = target.project_id AND t.id = target.item_id
   FOR SHARE OF i;
  PERFORM app.assert_quality_writable(target.tenant_id, target.project_id);
  IF parent.status IS DISTINCT FROM 'draft'
    OR parent.created_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'Only the author changes photos of a draft inspection'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF (SELECT count(*) FROM inspection_item_photos
       WHERE tenant_id = NEW.tenant_id AND item_id = NEW.item_id) >= 6 THEN
    RAISE EXCEPTION 'An item holds at most six photos' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER inspection_item_photo_guard BEFORE INSERT OR DELETE ON "inspection_item_photos"
  FOR EACH ROW EXECUTE FUNCTION app.guard_inspection_item_photo();
CREATE TRIGGER inspection_item_photos_no_update BEFORE UPDATE ON "inspection_item_photos"
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();

-- Snags ------------------------------------------------------------------------------------------
-- packages/types SNAG_SEVERITIES, SNAG_RESPONSIBLE_KINDS, SNAG_STATUSES, SNAG_PHASES; packages/domain
-- SNAG_TRANSITIONS. A closed snag was verified by someone other than whoever recorded the fix.
ALTER TABLE "snags" ADD CONSTRAINT "snags_check" CHECK (
  number >= 1 AND version >= 1
  AND char_length(location) BETWEEN 2 AND 200 AND location = btrim(location)
  AND char_length(btrim(description)) BETWEEN 3 AND 2000
  AND severity IN ('critical', 'major', 'minor')
  AND responsible_kind IN ('gang', 'subcontractor', 'supplier', 'other')
  AND char_length(responsible_name) BETWEEN 2 AND 150 AND responsible_name = btrim(responsible_name)
  AND phase IN ('construction', 'dlp')
  AND reopen_count >= 0 AND (reopen_count = 0) = (last_reopen_reason IS NULL)
  AND (last_reopen_reason IS NULL OR char_length(btrim(last_reopen_reason)) BETWEEN 3 AND 500)
  AND (fix_note IS NULL OR (status <> 'open' AND char_length(btrim(fix_note)) BETWEEN 3 AND 1000))
  AND COALESCE(CASE status
    WHEN 'open' THEN fixed_by IS NULL AND fixed_at IS NULL AND closed_by IS NULL
      AND closed_at IS NULL
    WHEN 'fixed' THEN fixed_by IS NOT NULL AND fixed_at IS NOT NULL AND closed_by IS NULL
      AND closed_at IS NULL
    WHEN 'closed' THEN fixed_by IS NOT NULL AND fixed_at IS NOT NULL AND closed_by IS NOT NULL
      AND closed_at IS NOT NULL AND closed_by <> fixed_by
    ELSE false END, false)
);
ALTER TABLE "snag_photos" ADD CONSTRAINT "snag_photos_check" CHECK (stage IN ('raised', 'fixed'));

CREATE FUNCTION app.guard_snag() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  latest integer;
  item_result text;
  item_inspection text;
  expected_phase text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Snags cannot be deleted' USING ERRCODE = '42501';
  END IF;
  PERFORM app.assert_quality_writable(NEW.tenant_id, NEW.project_id);
  IF NEW.updated_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'Snags are changed by the signed-in user' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' OR NEW.version <> 1 OR NEW.reopen_count <> 0
      OR NEW.fix_note IS NOT NULL OR NEW.raised_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'A snag is raised open by the signed-in user' USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM projects WHERE tenant_id = NEW.tenant_id AND id = NEW.project_id FOR UPDATE;
    SELECT max(number) INTO latest FROM snags
      WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id;
    IF NEW.number <> COALESCE(latest, 0) + 1 THEN
      RAISE EXCEPTION 'Snags are numbered in order' USING ERRCODE = '23514';
    END IF;
    -- Defects reported once practical completion is certified are defects liability period snags.
    expected_phase := CASE WHEN EXISTS (
      SELECT 1 FROM project_completions
       WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id
         AND kind = 'practical' AND status = 'certified'
    ) THEN 'dlp' ELSE 'construction' END;
    IF NEW.phase IS DISTINCT FROM expected_phase THEN
      RAISE EXCEPTION 'A snag''s phase follows practical completion' USING ERRCODE = '23514';
    END IF;
    IF NEW.inspection_item_id IS NOT NULL THEN
      SELECT t.result, i.status INTO item_result, item_inspection FROM inspection_items t
        JOIN inspections i ON i.tenant_id = t.tenant_id AND i.id = t.inspection_id
       WHERE t.tenant_id = NEW.tenant_id AND t.project_id = NEW.project_id
         AND t.id = NEW.inspection_item_id;
      IF item_result IS DISTINCT FROM 'fail' OR item_inspection = 'draft' THEN
        RAISE EXCEPTION 'Snags are raised from failed items of submitted inspections'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    NEW.raised_at := now();
    RETURN NEW;
  END IF;
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'Closed snags are final' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.id, NEW.tenant_id, NEW.project_id, NEW.site_id, NEW.number, NEW.phase,
      NEW.inspection_item_id, NEW.raised_by, NEW.raised_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.project_id, OLD.site_id, OLD.number, OLD.phase,
      OLD.inspection_item_id, OLD.raised_by, OLD.raised_at)
    OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Snag identity is fixed and its version must advance' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = OLD.status THEN
    IF OLD.status <> 'open' OR ROW(NEW.fixed_by, NEW.fixed_at, NEW.fix_note, NEW.reopen_count,
        NEW.last_reopen_reason) IS DISTINCT FROM ROW(OLD.fixed_by, OLD.fixed_at, OLD.fix_note,
        OLD.reopen_count, OLD.last_reopen_reason) THEN
      RAISE EXCEPTION 'Only an open snag can be edited' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.location, NEW.description, NEW.severity, NEW.responsible_kind, NEW.responsible_name,
      NEW.due_on) IS DISTINCT FROM ROW(OLD.location, OLD.description, OLD.severity,
      OLD.responsible_kind, OLD.responsible_name, OLD.due_on) THEN
    RAISE EXCEPTION 'A snag''s content cannot change with its status' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'open' AND NEW.status = 'fixed' THEN
    IF NEW.fixed_by IS DISTINCT FROM app.current_user_id()
      OR ROW(NEW.reopen_count, NEW.last_reopen_reason)
        IS DISTINCT FROM ROW(OLD.reopen_count, OLD.last_reopen_reason) THEN
      RAISE EXCEPTION 'A fix is recorded by the signed-in user' USING ERRCODE = '23514';
    END IF;
    NEW.fixed_at := now();
  ELSIF OLD.status = 'fixed' AND NEW.status = 'closed' THEN
    IF NEW.closed_by IS DISTINCT FROM app.current_user_id()
      OR app.current_user_id() IS NOT DISTINCT FROM OLD.fixed_by
      OR ROW(NEW.fixed_by, NEW.fixed_at, NEW.fix_note, NEW.reopen_count, NEW.last_reopen_reason)
        IS DISTINCT FROM ROW(OLD.fixed_by, OLD.fixed_at, OLD.fix_note, OLD.reopen_count,
        OLD.last_reopen_reason) THEN
      RAISE EXCEPTION 'Someone other than the fixer verifies and closes a snag'
        USING ERRCODE = '23514';
    END IF;
    NEW.closed_at := now();
  ELSIF OLD.status = 'fixed' AND NEW.status = 'open' THEN
    IF app.current_user_id() IS NOT DISTINCT FROM OLD.fixed_by
      OR NEW.reopen_count <> OLD.reopen_count + 1 OR NEW.last_reopen_reason IS NULL
      OR NEW.fix_note IS NOT NULL THEN
      RAISE EXCEPTION 'Someone other than the fixer reopens a snag, with a reason'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'Invalid snag transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER snag_guard BEFORE INSERT OR UPDATE OR DELETE ON "snags"
  FOR EACH ROW EXECUTE FUNCTION app.guard_snag();

-- Photos of a snag are added when it is raised, or when a fix is recorded, in the same
-- transaction; they are never removed.
CREATE FUNCTION app.guard_snag_photo() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent snags%ROWTYPE;
BEGIN
  IF NEW.added_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'Snag photos are added by the signed-in user' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO parent FROM snags
    WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id AND id = NEW.snag_id;
  IF NOT (CASE NEW.stage
      WHEN 'raised' THEN parent.raised_at = now()
      ELSE parent.status = 'fixed' AND parent.fixed_at = now() END) THEN
    RAISE EXCEPTION 'Snag photos are added when it is raised or a fix is recorded'
      USING ERRCODE = '23514';
  END IF;
  NEW.added_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER snag_photo_guard BEFORE INSERT ON "snag_photos"
  FOR EACH ROW EXECUTE FUNCTION app.guard_snag_photo();
CREATE TRIGGER snag_photos_append_only BEFORE UPDATE OR DELETE ON "snag_photos"
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();

-- Concrete cube sets and results -----------------------------------------------------------------
-- packages/types CONCRETE_CLASSES, CUBE_TEST_AGES, CUBE_RULE (KE-CUBE-1, COMPLIANCE-REVIEW
-- CR-QA-01), QUALITY_LIMITS.
ALTER TABLE "cube_sets" ADD CONSTRAINT "cube_sets_check" CHECK (
  number >= 1 AND version >= 1
  AND concrete_class IN ('C10', 'C15', 'C20', 'C25', 'C30', 'C35', 'C40', 'C45', 'C50')
  AND specified_strength = substr(concrete_class, 2)::integer
  AND cubes_per_age BETWEEN 1 AND 6
  AND char_length(element) BETWEEN 3 AND 200 AND element = btrim(element)
  AND (batch_reference IS NULL OR char_length(btrim(batch_reference)) BETWEEN 1 AND 60)
  AND (notes IS NULL OR char_length(btrim(notes)) >= 1)
  AND status IN ('active', 'void')
  AND (status = 'void') = (void_reason IS NOT NULL)
  AND (status = 'void') = (voided_by IS NOT NULL)
  AND (status = 'void') = (voided_at IS NOT NULL)
  AND (void_reason IS NULL OR char_length(btrim(void_reason)) BETWEEN 3 AND 500)
);
CREATE FUNCTION app.guard_cube_set() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  latest integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Cube sets cannot be deleted' USING ERRCODE = '42501';
  END IF;
  PERFORM app.assert_quality_writable(NEW.tenant_id, NEW.project_id);
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' OR NEW.version <> 1
      OR NEW.created_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'A cube set is recorded active by the signed-in user'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.cast_on > app.business_today() THEN
      RAISE EXCEPTION 'Cubes cannot be cast in the future' USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM projects WHERE tenant_id = NEW.tenant_id AND id = NEW.project_id FOR UPDATE;
    SELECT max(number) INTO latest FROM cube_sets
      WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id;
    IF NEW.number <> COALESCE(latest, 0) + 1 THEN
      RAISE EXCEPTION 'Cube sets are numbered in order' USING ERRCODE = '23514';
    END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  -- The only change: an active set is voided (entered in error), with a reason.
  IF OLD.status <> 'active' OR NEW.status <> 'void'
    OR NEW.voided_by IS DISTINCT FROM app.current_user_id()
    OR NEW.version <> OLD.version + 1
    OR ROW(NEW.id, NEW.tenant_id, NEW.project_id, NEW.site_id, NEW.number, NEW.element,
      NEW.concrete_class, NEW.specified_strength, NEW.cast_on, NEW.cubes_per_age,
      NEW.batch_reference, NEW.notes, NEW.created_by, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.project_id, OLD.site_id, OLD.number,
      OLD.element, OLD.concrete_class, OLD.specified_strength, OLD.cast_on, OLD.cubes_per_age,
      OLD.batch_reference, OLD.notes, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'A recorded cube set can only be voided, with a reason'
      USING ERRCODE = '23514';
  END IF;
  NEW.voided_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER cube_set_guard BEFORE INSERT OR UPDATE OR DELETE ON "cube_sets"
  FOR EACH ROW EXECUTE FUNCTION app.guard_cube_set();

ALTER TABLE "cube_results" ADD CONSTRAINT "cube_results_check" CHECK (
  age_days IN (7, 28)
  AND strengths IS NOT NULL AND cardinality(strengths) BETWEEN 1 AND 6
  AND array_position(strengths, NULL) IS NULL
  AND 0 <= ALL (strengths) AND 150 >= ALL (strengths)
  AND CASE age_days WHEN 28 THEN outcome IN ('pass', 'fail')
    ELSE outcome IN ('indicative_ok', 'indicative_low') END
  AND rule_version = 'KE-CUBE-1'
  AND (supersedes_id IS NULL) = (correction_reason IS NULL)
  AND (correction_reason IS NULL OR char_length(btrim(correction_reason)) BETWEEN 3 AND 500)
  AND (laboratory IS NULL OR char_length(btrim(laboratory)) BETWEEN 1 AND 120)
  AND (report_reference IS NULL OR char_length(btrim(report_reference)) BETWEEN 1 AND 60)
);
-- One original result per set and age; corrections supersede a result once (unique supersedes_id).
CREATE UNIQUE INDEX "cube_results_one_original_per_age"
  ON "cube_results"("tenant_id", "cube_set_id", "age_days") WHERE supersedes_id IS NULL;
-- The stored mean, minimum and outcome follow rule KE-CUBE-1 (packages/domain assessCubes): the
-- mean is rounded half up to 0.01; at 28 days a set passes when the cubes' total is at least
-- f_cu × n and no cube is below f_cu − 3; at 7 days the result is low below 65 % of f_cu.
CREATE FUNCTION app.guard_cube_result() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cube_set cube_sets%ROWTYPE;
  previous cube_results%ROWTYPE;
  total numeric;
  lowest numeric;
  cubes integer;
  expected text;
BEGIN
  PERFORM app.assert_quality_writable(NEW.tenant_id, NEW.project_id);
  IF NEW.recorded_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'Results are recorded by the signed-in user' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO cube_set FROM cube_sets
    WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id AND id = NEW.cube_set_id
    FOR SHARE;
  IF cube_set.status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'Results are recorded on active cube sets only' USING ERRCODE = '23514';
  END IF;
  IF NEW.tested_on < cube_set.cast_on OR NEW.tested_on > app.business_today() THEN
    RAISE EXCEPTION 'Cubes are tested after casting and not in the future'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.supersedes_id IS NOT NULL THEN
    SELECT * INTO previous FROM cube_results
      WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id AND id = NEW.supersedes_id;
    IF previous.id IS NULL OR previous.cube_set_id <> NEW.cube_set_id
      OR previous.age_days <> NEW.age_days THEN
      RAISE EXCEPTION 'A correction replaces a result of the same set and age'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT sum(s), min(s), count(*) INTO total, lowest, cubes FROM unnest(NEW.strengths) AS s;
  expected := CASE NEW.age_days
    WHEN 28 THEN CASE WHEN total >= cube_set.specified_strength * cubes
        AND lowest >= cube_set.specified_strength - 3 THEN 'pass' ELSE 'fail' END
    ELSE CASE WHEN total * 100 < 65 * cube_set.specified_strength * cubes
        THEN 'indicative_low' ELSE 'indicative_ok' END
  END;
  IF NEW.mean_strength IS DISTINCT FROM round(total / cubes, 2)
    OR NEW.min_strength IS DISTINCT FROM lowest OR NEW.outcome IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'The mean and outcome must follow rule KE-CUBE-1' USING ERRCODE = '23514';
  END IF;
  NEW.recorded_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER cube_result_guard BEFORE INSERT ON "cube_results"
  FOR EACH ROW EXECUTE FUNCTION app.guard_cube_result();
CREATE TRIGGER cube_results_append_only BEFORE UPDATE OR DELETE ON "cube_results"
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();

-- Slump tests ------------------------------------------------------------------------------------
-- packages/types SLUMP_RULE (KE-SLUMP-1, COMPLIANCE-REVIEW CR-QA-02): pass when the measured slump
-- is within the tolerance of the target.
ALTER TABLE "slump_tests" ADD CONSTRAINT "slump_tests_check" CHECK (
  number >= 1
  AND char_length(element) BETWEEN 3 AND 200 AND element = btrim(element)
  AND (concrete_class IS NULL OR concrete_class IN ('C10', 'C15', 'C20', 'C25', 'C30', 'C35',
    'C40', 'C45', 'C50'))
  AND target_mm BETWEEN 10 AND 250 AND tolerance_mm BETWEEN 5 AND 60
  AND measured_mm BETWEEN 0 AND 300
  AND outcome = CASE WHEN abs(measured_mm - target_mm) <= tolerance_mm THEN 'pass' ELSE 'fail' END
  AND rule_version = 'KE-SLUMP-1'
  AND (notes IS NULL OR char_length(btrim(notes)) >= 1)
  AND (supersedes_id IS NULL) = (correction_reason IS NULL)
  AND (correction_reason IS NULL OR char_length(btrim(correction_reason)) BETWEEN 3 AND 500)
);
-- One original per number; a correction keeps its original's number.
CREATE UNIQUE INDEX "slump_tests_one_original_per_number"
  ON "slump_tests"("tenant_id", "project_id", "number") WHERE supersedes_id IS NULL;
CREATE FUNCTION app.guard_slump_test() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  latest integer;
  previous slump_tests%ROWTYPE;
BEGIN
  PERFORM app.assert_quality_writable(NEW.tenant_id, NEW.project_id);
  IF NEW.recorded_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'Slump tests are recorded by the signed-in user' USING ERRCODE = '23514';
  END IF;
  IF NEW.tested_on > app.business_today() THEN
    RAISE EXCEPTION 'A slump test cannot be dated in the future' USING ERRCODE = '23514';
  END IF;
  IF NEW.supersedes_id IS NULL THEN
    PERFORM 1 FROM projects WHERE tenant_id = NEW.tenant_id AND id = NEW.project_id FOR UPDATE;
    SELECT max(number) INTO latest FROM slump_tests
      WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id;
    IF NEW.number <> COALESCE(latest, 0) + 1 THEN
      RAISE EXCEPTION 'Slump tests are numbered in order' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT * INTO previous FROM slump_tests
      WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id AND id = NEW.supersedes_id;
    IF previous.id IS NULL OR previous.number <> NEW.number OR previous.site_id <> NEW.site_id
      OR previous.cube_set_id IS DISTINCT FROM NEW.cube_set_id THEN
      RAISE EXCEPTION 'A correction keeps the test''s number, site and cube set'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.recorded_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER slump_test_guard BEFORE INSERT ON "slump_tests"
  FOR EACH ROW EXECUTE FUNCTION app.guard_slump_test();
CREATE TRIGGER slump_tests_append_only BEFORE UPDATE OR DELETE ON "slump_tests"
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();

-- Practical and final completion -----------------------------------------------------------------
-- packages/types COMPLETION_KINDS, COMPLETION_STATUSES; packages/domain COMPLETION_TRANSITIONS,
-- completionBlockers, dlpEndDate. The DLP ends dlp_months calendar months after practical
-- completion (clamped to the month end, COMPLIANCE-REVIEW CR-QA-03).
ALTER TABLE "project_completions" ADD CONSTRAINT "project_completions_check" CHECK (
  kind IN ('practical', 'final') AND version >= 1
  AND COALESCE(CASE kind
    WHEN 'practical' THEN dlp_months BETWEEN 1 AND 24
      AND dlp_ends_on = (completion_date + make_interval(months => dlp_months))::date
    ELSE dlp_months IS NULL AND dlp_ends_on IS NULL END, false)
  AND open_critical_snags >= 0 AND open_snags >= open_critical_snags
  AND (exception_reason IS NULL OR char_length(btrim(exception_reason)) BETWEEN 3 AND 500)
  AND (notes IS NULL OR char_length(btrim(notes)) >= 1)
  AND COALESCE(CASE status
    WHEN 'proposed' THEN certified_by IS NULL AND certified_at IS NULL AND withdrawn_by IS NULL
      AND withdrawn_at IS NULL AND withdraw_reason IS NULL
    WHEN 'certified' THEN certified_by IS NOT NULL AND certified_at IS NOT NULL
      AND certified_by <> proposed_by AND withdrawn_by IS NULL AND withdrawn_at IS NULL
      AND withdraw_reason IS NULL
    WHEN 'withdrawn' THEN certified_by IS NULL AND certified_at IS NULL
      AND withdrawn_by IS NOT NULL AND withdrawn_at IS NOT NULL
      AND char_length(btrim(withdraw_reason)) BETWEEN 3 AND 500
    ELSE false END, false)
);
-- One live (proposed or certified) certificate of each kind per project.
CREATE UNIQUE INDEX "project_completions_one_live_per_kind"
  ON "project_completions"("tenant_id", "project_id", "kind") WHERE status <> 'withdrawn';

-- Proposing and certifying check the snags as they are now (counts must match): practical
-- completion needs no open critical snag and final completion no open snag at all, unless an
-- exception reason is recorded; final completion follows a certified practical completion on or
-- after the DLP end. Certification is by someone other than the proposer; certified and withdrawn
-- certificates are locked. The project row lock serialises this with raising snags.
CREATE FUNCTION app.guard_project_completion() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  counts record;
  practical_end date;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Completion certificates cannot be deleted' USING ERRCODE = '42501';
  END IF;
  PERFORM app.assert_quality_writable(NEW.tenant_id, NEW.project_id);
  PERFORM 1 FROM projects WHERE tenant_id = NEW.tenant_id AND id = NEW.project_id FOR UPDATE;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'proposed' OR NEW.version <> 1
      OR NEW.proposed_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'A completion is proposed by the signed-in user' USING ERRCODE = '23514';
    END IF;
    IF NEW.completion_date > app.business_today() THEN
      RAISE EXCEPTION 'A completion date cannot be in the future' USING ERRCODE = '23514';
    END IF;
    NEW.proposed_at := now();
  ELSE
    IF OLD.status <> 'proposed' THEN
      RAISE EXCEPTION 'Certified and withdrawn completions are locked' USING ERRCODE = '23514';
    END IF;
    IF ROW(NEW.id, NEW.tenant_id, NEW.project_id, NEW.kind, NEW.completion_date, NEW.dlp_months,
        NEW.dlp_ends_on, NEW.exception_reason, NEW.notes, NEW.proposed_by, NEW.proposed_at)
      IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.project_id, OLD.kind, OLD.completion_date,
        OLD.dlp_months, OLD.dlp_ends_on, OLD.exception_reason, OLD.notes, OLD.proposed_by,
        OLD.proposed_at)
      OR NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'A completion''s content is fixed and its version must advance'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'withdrawn' THEN
      IF NEW.withdrawn_by IS DISTINCT FROM app.current_user_id()
        OR ROW(NEW.open_snags, NEW.open_critical_snags)
          IS DISTINCT FROM ROW(OLD.open_snags, OLD.open_critical_snags) THEN
        RAISE EXCEPTION 'A completion is withdrawn by the signed-in user' USING ERRCODE = '23514';
      END IF;
      NEW.withdrawn_at := now();
      RETURN NEW;
    END IF;
    IF NEW.status <> 'certified' OR NEW.certified_by IS DISTINCT FROM app.current_user_id()
      OR NEW.certified_by = OLD.proposed_by THEN
      RAISE EXCEPTION 'Someone other than the proposer certifies completion'
        USING ERRCODE = '23514';
    END IF;
    NEW.certified_at := now();
  END IF;
  SELECT * INTO counts FROM app.open_snag_counts(NEW.tenant_id, NEW.project_id);
  IF NEW.open_snags <> counts.open_all OR NEW.open_critical_snags <> counts.open_critical THEN
    RAISE EXCEPTION 'The snag counts must be today''s' USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'practical' THEN
    IF counts.open_critical > 0 AND NEW.exception_reason IS NULL THEN
      RAISE EXCEPTION 'Open critical snags block practical completion without an exception'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT dlp_ends_on INTO practical_end FROM project_completions
      WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id AND kind = 'practical'
        AND status = 'certified';
    IF practical_end IS NULL OR NEW.completion_date < practical_end THEN
      RAISE EXCEPTION 'Final completion follows certified practical completion and the DLP'
        USING ERRCODE = '23514';
    END IF;
    IF counts.open_all > 0 AND NEW.exception_reason IS NULL THEN
      RAISE EXCEPTION 'Open snags block final completion without an exception'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER project_completion_guard BEFORE INSERT OR UPDATE OR DELETE ON "project_completions"
  FOR EACH ROW EXECUTE FUNCTION app.guard_project_completion();

-- Row-level security -----------------------------------------------------------------------------
DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['quality_settings', 'checklist_templates',
    'checklist_template_items', 'inspections', 'inspection_items', 'inspection_item_photos',
    'snags', 'snag_photos', 'cube_sets', 'cube_results', 'slump_tests', 'project_completions']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = app.current_tenant_id()) '
      'WITH CHECK (tenant_id = app.current_tenant_id())', target || '_isolation', target);
  END LOOP;
END
$$;

-- The runtime role never rewrites templates, results, slump tests or snag photos, and never
-- deletes quality records; it may only unlink a photo from a draft inspection's item.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmb_app') THEN
    REVOKE UPDATE, DELETE ON "checklist_templates", "checklist_template_items", "cube_results",
      "slump_tests", "snag_photos" FROM pmb_app;
    REVOKE UPDATE ON "inspection_item_photos" FROM pmb_app;
    REVOKE DELETE ON "quality_settings", "inspections", "inspection_items", "snags", "cube_sets",
      "project_completions" FROM pmb_app;
    REVOKE TRUNCATE, REFERENCES, TRIGGER
      ON "quality_settings", "checklist_templates", "checklist_template_items", "inspections",
         "inspection_items", "inspection_item_photos", "snags", "snag_photos", "cube_sets",
         "cube_results", "slump_tests", "project_completions"
      FROM pmb_app;
    GRANT EXECUTE ON FUNCTION app.assert_quality_writable(uuid, uuid) TO pmb_app;
    GRANT EXECUTE ON FUNCTION app.open_snag_counts(uuid, uuid) TO pmb_app;
  END IF;
END
$$;
REVOKE EXECUTE ON FUNCTION app.assert_quality_writable(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.open_snag_counts(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_quality_settings() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_checklist_template() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_checklist_template_item() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_checklist_template_items() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_inspection() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_inspection_items() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_inspection_item() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_inspection_item_photo() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_snag() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_snag_photo() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_cube_set() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_cube_result() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_slump_test() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_project_completion() FROM PUBLIC;

COMMIT;
