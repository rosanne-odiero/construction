-- D8.4 Documents and compliance register (brief §5.11 "document repository with version control:
-- drawings, contracts, BQs, permits, certificates, insurance policies; compliance register per
-- project with expiry reminders; consultant instructions and approvals log", §6 and §15;
-- ARCHITECTURE §4.13; ERD §10; WORKFLOWS "Documents, compliance and instructions"). Enforces, in
-- the database as well as the API:
-- * documents: category, project and creator fixed; drawings carry a number (unique per project),
--   a discipline and nothing else does; withdrawn (with a reason) is FINAL; nothing is deleted.
-- * document_versions (append-only): numbered in order per document, at most 50, uploaded by the
--   signed-in user, stamped with the database clock, stored under a key derived from the IDs, a
--   detected content type with a matching extension; EXACTLY ONE CURRENT VERSION per document (a
--   partial unique index, and app.check_document_versions at commit: the current version is the
--   newest and every other is superseded by the next). A new version supersedes the previous one;
--   is_current, superseded_at and superseded_by_id are the only columns that ever change, once.
-- * compliance_types: the company's item types (starter keys flagged COMPLIANCE-REVIEW, or custom
--   labels); key, scope and starter flag fixed; retired, never deleted.
-- * compliance_records (append-only): a record or "not applicable" (with a reason), one current
--   record per item (partial unique indexes); a renewal supersedes exactly the current record
--   (unique supersedes_id); company items have no project; evidence is a version of the project.
-- * instructions (D2.3's register, extended into the consultant instructions log): kind, firm,
--   date received, cost/time flags, a D6.2 delay; the status moves ONLY through append-only
--   instruction_responses (received → acknowledged → actioned → closed; reopen with a reason) and
--   app.check_instruction_status checks at commit that it is the latest response's; a closed
--   instruction is locked; whoever recorded an instruction as its issuer never acknowledges or
--   actions it. A variation needs an instruction that is not closed (app.guard_variation_order).
-- * instruction_attachments (append-only): a document version or a VERIFIED general site photo of
--   the same project, at most 10, never on a closed instruction.
-- * approval_requests (APR-NNNN per project, numbered in order): a current version of an active
--   document, sent on a date, due on or after it; pending until its ONE response decides it
--   (set by the response trigger) or cancelled with a reason; final once decided or cancelled; a
--   rejected or "resubmit" request is answered by at most one resubmission.
-- * approval_responses (append-only, one per request): the reviewed SHA-256 must be the version's;
--   an in-app response is by the signed-in user, who is NEITHER the raiser NOR the uploader; a
--   paper response names the external consultant and attaches the scan (another version).
-- * Every record is stamped by the database clock; closed and cancelled projects are read-only.
-- Every new table has tenant_id, forced RLS with WITH CHECK and composite (tenant_id, …) foreign
-- keys. No new permissions (documents.manage, projects.view, site.diary, bq.edit, finance.view …
-- already exist), so the permission CHECK constraints are unchanged.
BEGIN;

-- The D2.3 register had two states (open, closed); the log has four (decision D-115).
ALTER TABLE "instructions" DROP CONSTRAINT "instructions_status_check";

-- AlterTable
ALTER TABLE "instructions" ADD COLUMN     "captured_at" TIMESTAMPTZ,
ADD COLUMN     "cost_implication" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "delay_id" UUID,
ADD COLUMN     "idempotency_key" VARCHAR(100),
ADD COLUMN     "issued_by_user_id" UUID,
ADD COLUMN     "issuer_firm" VARCHAR(150),
ADD COLUMN     "kind" VARCHAR(30) NOT NULL DEFAULT 'other',
ADD COLUMN     "received_on" DATE,
ADD COLUMN     "request_digest" CHAR(64),
ADD COLUMN     "time_implication" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "status" SET DEFAULT 'received',
ALTER COLUMN "status" SET DATA TYPE VARCHAR(20);

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "category" VARCHAR(20) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "drawing_number" VARCHAR(40),
    "discipline" VARCHAR(20),
    "reference" VARCHAR(80),
    "status" VARCHAR(10) NOT NULL DEFAULT 'active',
    "withdrawn_by" UUID,
    "withdrawn_at" TIMESTAMPTZ,
    "withdraw_reason" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "revision" VARCHAR(10) NOT NULL,
    "issue_purpose" VARCHAR(20),
    "change_note" VARCHAR(1000),
    "file_name" VARCHAR(120) NOT NULL,
    "content_type" VARCHAR(100) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "object_key" VARCHAR(300) NOT NULL,
    "scan_status" VARCHAR(20) NOT NULL,
    "scan_engine" VARCHAR(60) NOT NULL,
    "scanned_at" TIMESTAMPTZ NOT NULL,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "superseded_at" TIMESTAMPTZ,
    "superseded_by_id" UUID,
    "uploaded_by" UUID NOT NULL,
    "uploaded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_types" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" VARCHAR(40) NOT NULL,
    "label" VARCHAR(120),
    "starter" BOOLEAN NOT NULL DEFAULT false,
    "scope" VARCHAR(10) NOT NULL,
    "expires" BOOLEAN NOT NULL,
    "reminder_days" INTEGER NOT NULL DEFAULT 30,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_records" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "type_id" UUID NOT NULL,
    "project_id" UUID,
    "kind" VARCHAR(16) NOT NULL,
    "reference_no" VARCHAR(80),
    "issuer" VARCHAR(150),
    "issued_on" DATE,
    "expires_on" DATE,
    "evidence_version_id" UUID,
    "notes" VARCHAR(1000),
    "reason" VARCHAR(500),
    "supersedes_id" UUID,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "superseded_at" TIMESTAMPTZ,
    "recorded_by" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "instruction_responses" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "instruction_id" UUID NOT NULL,
    "kind" VARCHAR(12) NOT NULL,
    "body" VARCHAR(2000),
    "from_status" VARCHAR(20) NOT NULL,
    "to_status" VARCHAR(20) NOT NULL,
    "recorded_by" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "instruction_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "instruction_attachments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "instruction_id" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "document_version_id" UUID,
    "photo_id" UUID,
    "added_by" UUID NOT NULL,
    "added_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "instruction_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" VARCHAR(2000),
    "document_version_id" UUID NOT NULL,
    "addressed_to" VARCHAR(150) NOT NULL,
    "sent_on" DATE NOT NULL,
    "due_on" DATE NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'pending',
    "resubmission_of_id" UUID,
    "raised_by" UUID NOT NULL,
    "raised_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelled_by" UUID,
    "cancelled_at" TIMESTAMPTZ,
    "cancel_reason" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_responses" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "decision" VARCHAR(30) NOT NULL,
    "comments" VARCHAR(2000),
    "responded_on" DATE NOT NULL,
    "channel" VARCHAR(10) NOT NULL,
    "responder_user_id" UUID,
    "responder_name" VARCHAR(150) NOT NULL,
    "responder_firm" VARCHAR(150),
    "evidence_version_id" UUID,
    "reviewed_sha256" CHAR(64) NOT NULL,
    "recorded_by" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_responses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "documents_tenant_id_project_id_category_status_idx" ON "documents"("tenant_id", "project_id", "category", "status");

-- CreateIndex
CREATE UNIQUE INDEX "documents_tenant_id_id_key" ON "documents"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "documents_tenant_id_project_id_id_key" ON "documents"("tenant_id", "project_id", "id");

-- CreateIndex
CREATE INDEX "document_versions_tenant_id_project_id_uploaded_at_idx" ON "document_versions"("tenant_id", "project_id", "uploaded_at");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_tenant_id_id_key" ON "document_versions"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_tenant_id_project_id_id_key" ON "document_versions"("tenant_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_tenant_id_document_id_version_no_key" ON "document_versions"("tenant_id", "document_id", "version_no");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_tenant_id_document_id_sha256_key" ON "document_versions"("tenant_id", "document_id", "sha256");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_types_tenant_id_id_key" ON "compliance_types"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_types_tenant_id_key_key" ON "compliance_types"("tenant_id", "key");

-- CreateIndex
CREATE INDEX "compliance_records_tenant_id_project_id_type_id_idx" ON "compliance_records"("tenant_id", "project_id", "type_id");

-- CreateIndex
CREATE INDEX "compliance_records_tenant_id_type_id_idx" ON "compliance_records"("tenant_id", "type_id");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_records_tenant_id_id_key" ON "compliance_records"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_records_tenant_id_supersedes_id_key" ON "compliance_records"("tenant_id", "supersedes_id");

-- CreateIndex
CREATE INDEX "instruction_responses_tenant_id_instruction_id_recorded_at_idx" ON "instruction_responses"("tenant_id", "instruction_id", "recorded_at");

-- CreateIndex
CREATE UNIQUE INDEX "instruction_responses_tenant_id_id_key" ON "instruction_responses"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "instruction_attachments_tenant_id_id_key" ON "instruction_attachments"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "instruction_attachments_tenant_id_instruction_id_document_v_key" ON "instruction_attachments"("tenant_id", "instruction_id", "document_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "instruction_attachments_tenant_id_instruction_id_photo_id_key" ON "instruction_attachments"("tenant_id", "instruction_id", "photo_id");

-- CreateIndex
CREATE INDEX "approval_requests_tenant_id_project_id_status_idx" ON "approval_requests"("tenant_id", "project_id", "status");

-- CreateIndex
CREATE INDEX "approval_requests_tenant_id_document_version_id_idx" ON "approval_requests"("tenant_id", "document_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "approval_requests_tenant_id_id_key" ON "approval_requests"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "approval_requests_tenant_id_project_id_id_key" ON "approval_requests"("tenant_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "approval_requests_tenant_id_project_id_number_key" ON "approval_requests"("tenant_id", "project_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "approval_requests_tenant_id_project_id_resubmission_of_id_key" ON "approval_requests"("tenant_id", "project_id", "resubmission_of_id");

-- CreateIndex
CREATE UNIQUE INDEX "approval_responses_tenant_id_id_key" ON "approval_responses"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "approval_responses_tenant_id_project_id_request_id_key" ON "approval_responses"("tenant_id", "project_id", "request_id");

-- CreateIndex
CREATE INDEX "instructions_tenant_id_project_id_delay_id_idx" ON "instructions"("tenant_id", "project_id", "delay_id");

-- CreateIndex
CREATE UNIQUE INDEX "instructions_tenant_id_idempotency_key_key" ON "instructions"("tenant_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "instructions" ADD CONSTRAINT "instructions_tenant_id_project_id_delay_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "delay_id") REFERENCES "schedule_delays"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_tenant_id_project_id_document_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "document_id") REFERENCES "documents"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_types" ADD CONSTRAINT "compliance_types_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_records" ADD CONSTRAINT "compliance_records_tenant_id_type_id_fkey" FOREIGN KEY ("tenant_id", "type_id") REFERENCES "compliance_types"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_records" ADD CONSTRAINT "compliance_records_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_records" ADD CONSTRAINT "compliance_records_tenant_id_evidence_version_id_fkey" FOREIGN KEY ("tenant_id", "evidence_version_id") REFERENCES "document_versions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_records" ADD CONSTRAINT "compliance_records_tenant_id_supersedes_id_fkey" FOREIGN KEY ("tenant_id", "supersedes_id") REFERENCES "compliance_records"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instruction_responses" ADD CONSTRAINT "instruction_responses_tenant_id_instruction_id_fkey" FOREIGN KEY ("tenant_id", "instruction_id") REFERENCES "instructions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instruction_attachments" ADD CONSTRAINT "instruction_attachments_tenant_id_project_id_instruction_i_fkey" FOREIGN KEY ("tenant_id", "project_id", "instruction_id") REFERENCES "instructions"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instruction_attachments" ADD CONSTRAINT "instruction_attachments_tenant_id_project_id_document_vers_fkey" FOREIGN KEY ("tenant_id", "project_id", "document_version_id") REFERENCES "document_versions"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instruction_attachments" ADD CONSTRAINT "instruction_attachments_tenant_id_project_id_photo_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "photo_id") REFERENCES "site_photos"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_tenant_id_project_id_document_version_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "document_version_id") REFERENCES "document_versions"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_tenant_id_project_id_resubmission_of_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "resubmission_of_id") REFERENCES "approval_requests"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_responses" ADD CONSTRAINT "approval_responses_tenant_id_project_id_request_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "request_id") REFERENCES "approval_requests"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_responses" ADD CONSTRAINT "approval_responses_tenant_id_project_id_evidence_version_i_fkey" FOREIGN KEY ("tenant_id", "project_id", "evidence_version_id") REFERENCES "document_versions"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill the D2.3 register (FORCE RLS would hide its rows from the schema owner) ---------------
ALTER TABLE "instructions" NO FORCE ROW LEVEL SECURITY;
UPDATE "instructions" SET "status" = 'received' WHERE "status" = 'open';
UPDATE "instructions" SET
  "kind" = CASE "issuer_role" WHEN 'architect' THEN 'architect_instruction'
    WHEN 'engineer' THEN 'engineer_instruction' ELSE 'other' END,
  "received_on" = "issued_on";
-- A closed D2.3 instruction gets the response that closed it, so its status is its latest response.
INSERT INTO "instruction_responses"
  ("id", "tenant_id", "instruction_id", "kind", "body", "from_status", "to_status", "recorded_by",
   "recorded_at")
SELECT gen_random_uuid(), "tenant_id", "id", 'close',
  'Closed in the BQ instruction register before the instructions log (D8.4)', 'received', 'closed',
  "updated_by", "updated_at"
FROM "instructions" WHERE "status" = 'closed';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "instructions" WHERE "status" NOT IN ('received', 'closed')
               OR "received_on" IS NULL) THEN
    RAISE EXCEPTION 'instructions backfill is incomplete';
  END IF;
END $$;
ALTER TABLE "instructions" FORCE ROW LEVEL SECURITY;

-- Shared helpers ---------------------------------------------------------------------------------
-- Closed and cancelled projects are read-only (packages/domain isProjectReadOnly). FOR SHARE waits
-- for a concurrent status change.
CREATE FUNCTION app.assert_documents_writable(target_tenant uuid, target_project uuid)
  RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  project_status text;
BEGIN
  SELECT status INTO project_status FROM projects
    WHERE tenant_id = target_tenant AND id = target_project FOR SHARE;
  IF project_status IS NULL OR project_status IN ('closed', 'cancelled') THEN
    RAISE EXCEPTION 'Closed and cancelled projects are read-only' USING ERRCODE = '23514';
  END IF;
END
$$;

-- Documents --------------------------------------------------------------------------------------
-- packages/types DOCUMENT_CATEGORIES, DRAWING_DISCIPLINES, DOCUMENT_STATUSES.
ALTER TABLE "documents" ADD CONSTRAINT "documents_check" CHECK (
  category IN ('drawing', 'contract', 'bq', 'specification', 'permit', 'certificate', 'insurance',
    'submittal', 'correspondence', 'other')
  AND char_length(title) BETWEEN 3 AND 200 AND title = btrim(title)
  AND (category = 'drawing') = (drawing_number IS NOT NULL)
  AND (category = 'drawing') = (discipline IS NOT NULL)
  AND (drawing_number IS NULL OR drawing_number ~ '^[A-Za-z0-9][A-Za-z0-9 ./_()-]{0,39}$')
  AND (discipline IS NULL OR discipline IN ('architectural', 'structural', 'civil', 'mechanical',
    'electrical', 'plumbing', 'landscape', 'survey', 'other'))
  AND (reference IS NULL OR (char_length(reference) BETWEEN 1 AND 80 AND reference = btrim(reference)))
  AND status IN ('active', 'withdrawn')
  AND (status = 'withdrawn') = (withdrawn_by IS NOT NULL)
  AND (status = 'withdrawn') = (withdrawn_at IS NOT NULL)
  AND (status = 'withdrawn') = (withdraw_reason IS NOT NULL)
  AND (withdraw_reason IS NULL OR char_length(btrim(withdraw_reason)) BETWEEN 3 AND 500)
  AND version >= 1
);
-- A drawing number is used once per project (case-insensitive), withdrawn drawings included.
CREATE UNIQUE INDEX "documents_drawing_number_key" ON "documents"
  ("tenant_id", "project_id", upper("drawing_number")) WHERE category = 'drawing';

CREATE FUNCTION app.guard_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Documents are never deleted; withdraw them' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_by IS DISTINCT FROM app.current_user_id()
      OR NEW.updated_by IS DISTINCT FROM NEW.created_by
      OR NEW.status <> 'active' OR NEW.version <> 1 THEN
      RAISE EXCEPTION 'A document is created active by the signed-in user' USING ERRCODE = '23514';
    END IF;
    PERFORM app.assert_documents_writable(NEW.tenant_id, NEW.project_id);
    NEW.created_at := clock_timestamp();
    NEW.updated_at := NEW.created_at;
    RETURN NEW;
  END IF;
  IF OLD.status = 'withdrawn' THEN
    RAISE EXCEPTION 'A withdrawn document is final' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.id, NEW.tenant_id, NEW.project_id, NEW.category, NEW.created_by, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.project_id, OLD.category, OLD.created_by,
      OLD.created_at)
    OR NEW.version <> OLD.version + 1
    OR NEW.updated_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A document keeps its project and category; changes are versioned by the signed-in user'
      USING ERRCODE = '23514';
  END IF;
  PERFORM app.assert_documents_writable(NEW.tenant_id, NEW.project_id);
  IF NEW.status = 'withdrawn' THEN
    IF NEW.withdrawn_by IS DISTINCT FROM app.current_user_id()
      OR ROW(NEW.title, NEW.drawing_number, NEW.discipline, NEW.reference)
        IS DISTINCT FROM ROW(OLD.title, OLD.drawing_number, OLD.discipline, OLD.reference) THEN
      RAISE EXCEPTION 'Withdrawing a document changes nothing else' USING ERRCODE = '23514';
    END IF;
    NEW.withdrawn_at := now();
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER document_guard BEFORE INSERT OR UPDATE OR DELETE ON "documents"
  FOR EACH ROW EXECUTE FUNCTION app.guard_document();

-- At commit, a document has at least one version (its first file is uploaded with it).
CREATE FUNCTION app.check_document_has_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM document_versions
                  WHERE tenant_id = NEW.tenant_id AND document_id = NEW.id) THEN
    RAISE EXCEPTION 'A document is created with its first version' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER document_has_version AFTER INSERT ON "documents"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_document_has_version();

-- Document versions ------------------------------------------------------------------------------
-- packages/types DOCUMENT_CONTENT_TYPES, ISSUE_PURPOSES, DOCUMENT_LIMITS; packages/domain
-- REVISION_PATTERN and documentFileName.
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_check" CHECK (
  version_no BETWEEN 1 AND 50
  AND revision ~ '^[A-Za-z0-9][A-Za-z0-9.-]{0,9}$'
  AND (issue_purpose IS NULL OR issue_purpose IN ('for_information', 'for_approval', 'for_tender',
    'for_construction', 'as_built'))
  AND (change_note IS NULL OR char_length(btrim(change_note)) BETWEEN 3 AND 1000)
  AND (version_no = 1 OR change_note IS NOT NULL)
  AND file_name ~ '^[A-Za-z0-9 ._()-]{1,100}\.(pdf|jpg|png|webp|docx|xlsx)$'
  AND CASE content_type
    WHEN 'application/pdf' THEN file_name LIKE '%.pdf'
    WHEN 'image/jpeg' THEN file_name LIKE '%.jpg'
    WHEN 'image/png' THEN file_name LIKE '%.png'
    WHEN 'image/webp' THEN file_name LIKE '%.webp'
    WHEN 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      THEN file_name LIKE '%.docx'
    WHEN 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      THEN file_name LIKE '%.xlsx'
    ELSE false END
  AND size_bytes BETWEEN 1 AND 26214400
  AND sha256 ~ '^[0-9a-f]{64}$'
  AND object_key = 'tenants/' || tenant_id::text || '/projects/' || project_id::text
    || '/documents/' || document_id::text || '/' || id::text
  AND scan_status IN ('clean', 'not_scanned')
  AND char_length(scan_engine) BETWEEN 1 AND 60
  AND is_current = (superseded_at IS NULL)
  AND is_current = (superseded_by_id IS NULL)
  AND (superseded_by_id IS NULL OR superseded_by_id <> id)
);
-- Exactly one current version per document (the done-when: a superseded drawing is never current).
CREATE UNIQUE INDEX "document_versions_one_current" ON "document_versions" ("tenant_id", "document_id")
  WHERE is_current;
-- A revision label is used once per document (case-insensitive).
CREATE UNIQUE INDEX "document_versions_revision_key" ON "document_versions"
  ("tenant_id", "document_id", upper("revision"));

CREATE FUNCTION app.guard_document_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  doc documents%ROWTYPE;
  latest integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Document versions are never deleted' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO doc FROM documents WHERE tenant_id = NEW.tenant_id AND id = NEW.document_id
      FOR UPDATE;
    IF doc.id IS NULL OR doc.project_id <> NEW.project_id THEN
      RAISE EXCEPTION 'A version belongs to a document of its project' USING ERRCODE = '23514';
    END IF;
    IF doc.status <> 'active' THEN
      RAISE EXCEPTION 'A withdrawn document takes no new versions' USING ERRCODE = '23514';
    END IF;
    PERFORM app.assert_documents_writable(NEW.tenant_id, NEW.project_id);
    IF NEW.uploaded_by IS DISTINCT FROM app.current_user_id() OR NOT NEW.is_current
      OR NEW.superseded_at IS NOT NULL OR NEW.superseded_by_id IS NOT NULL THEN
      RAISE EXCEPTION 'A new version is current and uploaded by the signed-in user'
        USING ERRCODE = '23514';
    END IF;
    SELECT max(version_no) INTO latest FROM document_versions
      WHERE tenant_id = NEW.tenant_id AND document_id = NEW.document_id;
    IF NEW.version_no <> COALESCE(latest, 0) + 1 THEN
      RAISE EXCEPTION 'Versions are numbered in order' USING ERRCODE = '23514';
    END IF;
    NEW.uploaded_at := clock_timestamp();
    -- The previous current version is superseded by this one (the only change a version allows).
    UPDATE document_versions
       SET is_current = false, superseded_at = NEW.uploaded_at, superseded_by_id = NEW.id
     WHERE tenant_id = NEW.tenant_id AND document_id = NEW.document_id AND is_current;
    RETURN NEW;
  END IF;
  IF NOT OLD.is_current OR NEW.is_current OR NEW.superseded_at IS NULL
    OR NEW.superseded_by_id IS NULL
    OR ROW(NEW.id, NEW.tenant_id, NEW.project_id, NEW.document_id, NEW.version_no, NEW.revision,
      NEW.issue_purpose, NEW.change_note, NEW.file_name, NEW.content_type, NEW.size_bytes,
      NEW.sha256, NEW.object_key, NEW.scan_status, NEW.scan_engine, NEW.scanned_at,
      NEW.uploaded_by, NEW.uploaded_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.project_id, OLD.document_id, OLD.version_no,
      OLD.revision, OLD.issue_purpose, OLD.change_note, OLD.file_name, OLD.content_type,
      OLD.size_bytes, OLD.sha256, OLD.object_key, OLD.scan_status, OLD.scan_engine,
      OLD.scanned_at, OLD.uploaded_by, OLD.uploaded_at) THEN
    RAISE EXCEPTION 'A document version never changes; a newer version supersedes it, once'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER document_version_guard BEFORE INSERT OR UPDATE OR DELETE ON "document_versions"
  FOR EACH ROW EXECUTE FUNCTION app.guard_document_version();

-- At commit: exactly one current version, the newest, and every other superseded by the next.
CREATE FUNCTION app.check_document_versions() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  newest integer;
BEGIN
  SELECT max(version_no) INTO newest FROM document_versions
    WHERE tenant_id = NEW.tenant_id AND document_id = NEW.document_id;
  IF (SELECT count(*) FROM document_versions
       WHERE tenant_id = NEW.tenant_id AND document_id = NEW.document_id AND is_current) <> 1
    OR NOT EXISTS (SELECT 1 FROM document_versions
                    WHERE tenant_id = NEW.tenant_id AND document_id = NEW.document_id
                      AND is_current AND version_no = newest) THEN
    RAISE EXCEPTION 'A document has exactly one current version: the newest'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM document_versions v
     WHERE v.tenant_id = NEW.tenant_id AND v.document_id = NEW.document_id AND NOT v.is_current
       AND NOT EXISTS (SELECT 1 FROM document_versions n
                        WHERE n.tenant_id = v.tenant_id AND n.document_id = v.document_id
                          AND n.id = v.superseded_by_id AND n.version_no = v.version_no + 1)
  ) THEN
    RAISE EXCEPTION 'Each superseded version is superseded by the next one'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER document_versions_state AFTER INSERT OR UPDATE ON "document_versions"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_document_versions();

-- Compliance item types --------------------------------------------------------------------------
-- packages/types COMPLIANCE_STARTER_TYPES, COMPLIANCE_SCOPES, COMPLIANCE_LIMITS.
ALTER TABLE "compliance_types" ADD CONSTRAINT "compliance_types_check" CHECK (
  key ~ '^[a-z][a-z0-9_]{1,39}$'
  AND starter = (label IS NULL)
  AND (starter OR key ~ '^custom_[0-9]{1,6}$')
  AND (NOT starter OR key IN ('county_building_approval', 'nca_project_registration', 'nca_levy',
    'nema_licence', 'nca_contractor_registration', 'car_insurance', 'wiba_insurance',
    'osh_workplace_registration', 'site_signboard'))
  AND (label IS NULL OR (char_length(label) BETWEEN 3 AND 120 AND label = btrim(label)))
  AND scope IN ('project', 'company')
  AND reminder_days BETWEEN 1 AND 365
  AND version >= 1
);

CREATE FUNCTION app.guard_compliance_type() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Compliance item types are never deleted; retire them'
      USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_by IS DISTINCT FROM app.current_user_id()
      OR NEW.updated_by IS DISTINCT FROM NEW.created_by OR NEW.version <> 1 THEN
      RAISE EXCEPTION 'A compliance item type is added by the signed-in user'
        USING ERRCODE = '23514';
    END IF;
    NEW.created_at := clock_timestamp();
    NEW.updated_at := NEW.created_at;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.tenant_id, NEW.key, NEW.starter, NEW.scope, NEW.created_by, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.key, OLD.starter, OLD.scope, OLD.created_by,
      OLD.created_at)
    OR NEW.version <> OLD.version + 1
    OR NEW.updated_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A compliance item type keeps its key and scope; changes are versioned'
      USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER compliance_type_guard BEFORE INSERT OR UPDATE OR DELETE ON "compliance_types"
  FOR EACH ROW EXECUTE FUNCTION app.guard_compliance_type();

-- Compliance records -----------------------------------------------------------------------------
-- packages/types COMPLIANCE_RECORD_KINDS; packages/domain complianceStatus (derived on read).
ALTER TABLE "compliance_records" ADD CONSTRAINT "compliance_records_check" CHECK (
  kind IN ('record', 'not_applicable')
  AND (kind = 'not_applicable') = (reason IS NOT NULL)
  AND (kind = 'record' OR (reference_no IS NULL AND issuer IS NULL AND issued_on IS NULL
    AND expires_on IS NULL AND evidence_version_id IS NULL))
  AND (reason IS NULL OR char_length(btrim(reason)) BETWEEN 3 AND 500)
  AND (reference_no IS NULL OR char_length(btrim(reference_no)) BETWEEN 1 AND 80)
  AND (issuer IS NULL OR char_length(btrim(issuer)) BETWEEN 1 AND 150)
  AND (notes IS NULL OR char_length(btrim(notes)) BETWEEN 1 AND 1000)
  AND (issued_on IS NULL OR expires_on IS NULL OR expires_on >= issued_on)
  AND is_current = (superseded_at IS NULL)
  AND (supersedes_id IS NULL OR supersedes_id <> id)
);
-- One current record per project item and per company item.
CREATE UNIQUE INDEX "compliance_records_current_project" ON "compliance_records"
  ("tenant_id", "type_id", "project_id") WHERE is_current AND project_id IS NOT NULL;
CREATE UNIQUE INDEX "compliance_records_current_company" ON "compliance_records"
  ("tenant_id", "type_id") WHERE is_current AND project_id IS NULL;

CREATE FUNCTION app.guard_compliance_record() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item compliance_types%ROWTYPE;
  head uuid;
  evidence_project uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Compliance records are never deleted' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NOT OLD.is_current OR NEW.is_current OR NEW.superseded_at IS NULL
      OR ROW(NEW.id, NEW.tenant_id, NEW.type_id, NEW.project_id, NEW.kind, NEW.reference_no,
        NEW.issuer, NEW.issued_on, NEW.expires_on, NEW.evidence_version_id, NEW.notes, NEW.reason,
        NEW.supersedes_id, NEW.recorded_by, NEW.recorded_at)
      IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.type_id, OLD.project_id, OLD.kind,
        OLD.reference_no, OLD.issuer, OLD.issued_on, OLD.expires_on, OLD.evidence_version_id,
        OLD.notes, OLD.reason, OLD.supersedes_id, OLD.recorded_by, OLD.recorded_at) THEN
      RAISE EXCEPTION 'A compliance record never changes; a renewal supersedes it, once'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.recorded_by IS DISTINCT FROM app.current_user_id() OR NOT NEW.is_current
    OR NEW.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'A compliance record is current and recorded by the signed-in user'
      USING ERRCODE = '23514';
  END IF;
  -- Serialises records of one type (renewals of the same item cannot race).
  SELECT * INTO item FROM compliance_types WHERE tenant_id = NEW.tenant_id AND id = NEW.type_id
    FOR UPDATE;
  IF NOT item.active THEN
    RAISE EXCEPTION 'A retired compliance item type takes no records' USING ERRCODE = '23514';
  END IF;
  IF (item.scope = 'project') <> (NEW.project_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Project items are recorded on a project; company items on none'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.project_id IS NOT NULL THEN
    PERFORM app.assert_documents_writable(NEW.tenant_id, NEW.project_id);
  END IF;
  IF NEW.kind = 'record' AND item.expires AND NEW.expires_on IS NULL THEN
    RAISE EXCEPTION 'This item expires: its record needs an expiry date' USING ERRCODE = '23514';
  END IF;
  IF NEW.issued_on > app.business_today() THEN
    RAISE EXCEPTION 'A certificate is not issued in the future' USING ERRCODE = '23514';
  END IF;
  IF NEW.evidence_version_id IS NOT NULL THEN
    SELECT project_id INTO evidence_project FROM document_versions
      WHERE tenant_id = NEW.tenant_id AND id = NEW.evidence_version_id;
    IF NEW.project_id IS NOT NULL AND evidence_project IS DISTINCT FROM NEW.project_id THEN
      RAISE EXCEPTION 'Evidence is a document of the same project' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT id INTO head FROM compliance_records
    WHERE tenant_id = NEW.tenant_id AND type_id = NEW.type_id
      AND project_id IS NOT DISTINCT FROM NEW.project_id AND is_current;
  IF NEW.supersedes_id IS DISTINCT FROM head THEN
    RAISE EXCEPTION 'A new record supersedes exactly the current record of the item'
      USING ERRCODE = '23514';
  END IF;
  NEW.recorded_at := clock_timestamp();
  IF head IS NOT NULL THEN
    UPDATE compliance_records SET is_current = false, superseded_at = NEW.recorded_at
     WHERE tenant_id = NEW.tenant_id AND id = head;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER compliance_record_guard BEFORE INSERT OR UPDATE OR DELETE ON "compliance_records"
  FOR EACH ROW EXECUTE FUNCTION app.guard_compliance_record();

-- At commit: one current record per item, and every other record superseded by a later one.
CREATE FUNCTION app.check_compliance_records() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM compliance_records
       WHERE tenant_id = NEW.tenant_id AND type_id = NEW.type_id
         AND project_id IS NOT DISTINCT FROM NEW.project_id AND is_current) <> 1
    OR EXISTS (
      SELECT 1 FROM compliance_records r
       WHERE r.tenant_id = NEW.tenant_id AND r.type_id = NEW.type_id
         AND r.project_id IS NOT DISTINCT FROM NEW.project_id AND NOT r.is_current
         AND NOT EXISTS (SELECT 1 FROM compliance_records s
                          WHERE s.tenant_id = r.tenant_id AND s.supersedes_id = r.id)
    ) THEN
    RAISE EXCEPTION 'An item has one current record; earlier ones are superseded'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER compliance_records_state AFTER INSERT OR UPDATE ON "compliance_records"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_compliance_records();

-- Instructions (the consultant instructions log) -------------------------------------------------
-- packages/types INSTRUCTION_KINDS, INSTRUCTION_LIFECYCLE, INSTRUCTION_RESPONSE_KINDS;
-- packages/domain INSTRUCTION_TRANSITIONS and instructionResponse.
ALTER TABLE "instructions" ADD CONSTRAINT "instructions_status_check" CHECK (
  status IN ('received', 'acknowledged', 'actioned', 'closed')
);
ALTER TABLE "instructions" ADD CONSTRAINT "instructions_log_check" CHECK (
  kind IN ('architect_instruction', 'engineer_instruction', 'site_instruction', 'other')
  AND (issuer_firm IS NULL OR (char_length(issuer_firm) BETWEEN 1 AND 150
    AND issuer_firm = btrim(issuer_firm)))
  AND (received_on IS NULL OR received_on >= issued_on)
  AND (idempotency_key IS NULL) = (request_digest IS NULL)
  AND (request_digest IS NULL OR request_digest ~ '^[0-9a-f]{64}$')
);

CREATE FUNCTION app.guard_instruction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Instructions are never deleted; close them' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'received' OR NEW.version <> 1
      OR NEW.created_by IS DISTINCT FROM app.current_user_id()
      OR NEW.updated_by IS DISTINCT FROM NEW.created_by THEN
      RAISE EXCEPTION 'An instruction is recorded as received by the signed-in user'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.issued_by_user_id IS NOT NULL AND NEW.issued_by_user_id <> NEW.created_by THEN
      RAISE EXCEPTION 'Only its issuer records an instruction as issued by themselves'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.received_on IS NULL OR NEW.received_on > app.business_today() THEN
      RAISE EXCEPTION 'An instruction is received on a date, not in the future'
        USING ERRCODE = '23514';
    END IF;
    PERFORM app.assert_documents_writable(NEW.tenant_id, NEW.project_id);
    NEW.created_at := clock_timestamp();
    NEW.updated_at := NEW.created_at;
  ELSE
    IF ROW(NEW.id, NEW.tenant_id, NEW.project_id, NEW.created_by, NEW.created_at,
        NEW.issued_by_user_id, NEW.idempotency_key, NEW.request_digest, NEW.captured_at)
      IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.project_id, OLD.created_by, OLD.created_at,
        OLD.issued_by_user_id, OLD.idempotency_key, OLD.request_digest, OLD.captured_at)
      OR NEW.version <> OLD.version + 1
      OR NEW.updated_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'An instruction keeps its identity; changes are versioned by the signed-in user'
        USING ERRCODE = '23514';
    END IF;
    PERFORM app.assert_documents_writable(NEW.tenant_id, NEW.project_id);
    IF NEW.status IS DISTINCT FROM OLD.status AND (OLD.status, NEW.status) NOT IN (
      ('received', 'acknowledged'), ('received', 'actioned'), ('acknowledged', 'actioned'),
      ('received', 'closed'), ('acknowledged', 'closed'), ('actioned', 'closed'),
      ('closed', 'received')
    ) THEN
      RAISE EXCEPTION 'An instruction cannot move from % to %', OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;
    -- A closed instruction is locked; reopening changes nothing but its status.
    IF OLD.status = 'closed' AND (NEW.status = 'closed' OR ROW(NEW.number, NEW.issued_on,
        NEW.issuer_name, NEW.issuer_role, NEW.subject, NEW.description, NEW.attachments, NEW.kind,
        NEW.issuer_firm, NEW.received_on, NEW.cost_implication, NEW.time_implication, NEW.delay_id)
      IS DISTINCT FROM ROW(OLD.number, OLD.issued_on, OLD.issuer_name, OLD.issuer_role,
        OLD.subject, OLD.description, OLD.attachments, OLD.kind, OLD.issuer_firm, OLD.received_on,
        OLD.cost_implication, OLD.time_implication, OLD.delay_id)) THEN
      RAISE EXCEPTION 'A closed instruction is locked; reopen it first' USING ERRCODE = '23514';
    END IF;
    IF NEW.received_on IS NULL OR NEW.received_on > app.business_today() THEN
      RAISE EXCEPTION 'An instruction is received on a date, not in the future'
        USING ERRCODE = '23514';
    END IF;
    NEW.updated_at := now();
  END IF;
  -- A linked delay is the delay itself (its first version), on the same project.
  IF NEW.delay_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.delay_id IS DISTINCT FROM OLD.delay_id)
    AND NOT EXISTS (SELECT 1 FROM schedule_delays
                     WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id
                       AND id = NEW.delay_id AND delay_id = id) THEN
    RAISE EXCEPTION 'A linked delay is a delay of the project' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER instruction_guard BEFORE INSERT OR UPDATE OR DELETE ON "instructions"
  FOR EACH ROW EXECUTE FUNCTION app.guard_instruction();

-- packages/types INSTRUCTION_RESPONSE_KINDS.
ALTER TABLE "instruction_responses" ADD CONSTRAINT "instruction_responses_check" CHECK (
  kind IN ('note', 'acknowledge', 'action', 'close', 'reopen')
  AND from_status IN ('received', 'acknowledged', 'actioned', 'closed')
  AND to_status IN ('received', 'acknowledged', 'actioned', 'closed')
  AND (body IS NULL OR char_length(btrim(body)) BETWEEN 1 AND 2000)
);

CREATE FUNCTION app.guard_instruction_response() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item instructions%ROWTYPE;
  expected text;
  needs_body boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Instruction responses are append-only' USING ERRCODE = '42501';
  END IF;
  IF NEW.recorded_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A response is recorded by the signed-in user' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO item FROM instructions WHERE tenant_id = NEW.tenant_id AND id = NEW.instruction_id
    FOR UPDATE;
  PERFORM app.assert_documents_writable(item.tenant_id, item.project_id);
  IF NEW.from_status IS DISTINCT FROM item.status THEN
    RAISE EXCEPTION 'A response starts from the instruction''s status' USING ERRCODE = '23514';
  END IF;
  expected := CASE
    WHEN NEW.kind = 'note' AND item.status <> 'closed' THEN item.status
    WHEN NEW.kind = 'acknowledge' AND item.status = 'received' THEN 'acknowledged'
    WHEN NEW.kind = 'action' AND item.status IN ('received', 'acknowledged') THEN 'actioned'
    WHEN NEW.kind = 'close' AND item.status IN ('received', 'acknowledged', 'actioned') THEN 'closed'
    WHEN NEW.kind = 'reopen' AND item.status = 'closed' THEN 'received'
  END;
  IF expected IS NULL OR NEW.to_status IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'A % response is not allowed while the instruction is %', NEW.kind, item.status
      USING ERRCODE = '23514';
  END IF;
  needs_body := NEW.kind IN ('note', 'action', 'reopen')
    OR (NEW.kind = 'close' AND item.status <> 'actioned');
  IF needs_body AND NEW.body IS NULL THEN
    RAISE EXCEPTION 'This response needs a note' USING ERRCODE = '23514';
  END IF;
  IF NEW.kind IN ('acknowledge', 'action') AND item.issued_by_user_id = NEW.recorded_by THEN
    RAISE EXCEPTION 'The issuer of an instruction does not acknowledge or action it'
      USING ERRCODE = '23514';
  END IF;
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END
$$;
CREATE TRIGGER instruction_response_guard BEFORE INSERT OR UPDATE OR DELETE
  ON "instruction_responses" FOR EACH ROW EXECUTE FUNCTION app.guard_instruction_response();

-- At commit, an instruction's status is the latest moving response's (or received without one).
CREATE FUNCTION app.check_instruction_status() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target uuid;
  stored text;
  latest text;
BEGIN
  -- Each branch reads its own table's column (a record has only its table's fields).
  IF TG_TABLE_NAME = 'instructions' THEN
    target := NEW.id;
  ELSE
    target := NEW.instruction_id;
  END IF;
  SELECT status INTO stored FROM instructions WHERE tenant_id = NEW.tenant_id AND id = target;
  SELECT to_status INTO latest FROM instruction_responses
    WHERE tenant_id = NEW.tenant_id AND instruction_id = target AND kind <> 'note'
    ORDER BY recorded_at DESC, id DESC LIMIT 1;
  IF stored IS DISTINCT FROM COALESCE(latest, 'received') THEN
    RAISE EXCEPTION 'An instruction''s status is its latest response' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER instruction_status_state AFTER INSERT OR UPDATE ON "instructions"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_instruction_status();
CREATE CONSTRAINT TRIGGER instruction_response_state AFTER INSERT ON "instruction_responses"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_instruction_status();

-- packages/types INSTRUCTION_ATTACHMENT_KINDS, DOCUMENT_LIMITS.maxInstructionAttachments.
ALTER TABLE "instruction_attachments" ADD CONSTRAINT "instruction_attachments_check" CHECK (
  kind IN ('document_version', 'site_photo')
  AND (kind = 'document_version') = (document_version_id IS NOT NULL)
  AND (kind = 'site_photo') = (photo_id IS NOT NULL)
);

CREATE FUNCTION app.guard_instruction_attachment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item instructions%ROWTYPE;
  photo_purpose text;
  photo_verified boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Instruction attachments are append-only' USING ERRCODE = '42501';
  END IF;
  IF NEW.added_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'An attachment is added by the signed-in user' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO item FROM instructions WHERE tenant_id = NEW.tenant_id AND id = NEW.instruction_id
    FOR UPDATE;
  IF item.status = 'closed' THEN
    RAISE EXCEPTION 'A closed instruction is locked' USING ERRCODE = '23514';
  END IF;
  PERFORM app.assert_documents_writable(NEW.tenant_id, NEW.project_id);
  IF (SELECT count(*) FROM instruction_attachments
       WHERE tenant_id = NEW.tenant_id AND instruction_id = NEW.instruction_id) >= 10 THEN
    RAISE EXCEPTION 'An instruction keeps at most 10 attachments' USING ERRCODE = '23514';
  END IF;
  IF NEW.photo_id IS NOT NULL THEN
    SELECT purpose, verified INTO photo_purpose, photo_verified FROM site_photos
      WHERE tenant_id = NEW.tenant_id AND id = NEW.photo_id;
    IF photo_purpose IS DISTINCT FROM 'general' OR photo_verified IS NOT TRUE THEN
      RAISE EXCEPTION 'Only verified general site photos are attached to instructions'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.added_at := clock_timestamp();
  RETURN NEW;
END
$$;
CREATE TRIGGER instruction_attachment_guard BEFORE INSERT OR UPDATE OR DELETE
  ON "instruction_attachments" FOR EACH ROW EXECUTE FUNCTION app.guard_instruction_attachment();

-- A variation needs an instruction that is not closed (D2.3 rule, with the D8.4 statuses).
CREATE OR REPLACE FUNCTION app.guard_variation_order() RETURNS trigger LANGUAGE plpgsql AS $$
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
    IF instruction_status IS NULL OR instruction_status = 'closed' THEN
      RAISE EXCEPTION 'A variation needs an open instruction' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- Approval requests ------------------------------------------------------------------------------
-- packages/types APPROVAL_REQUEST_KINDS, APPROVAL_STATUSES; packages/domain approvalStatus.
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_check" CHECK (
  number >= 1
  AND kind IN ('material_sample', 'shop_drawing', 'method_statement', 'other')
  AND char_length(title) BETWEEN 3 AND 200 AND title = btrim(title)
  AND (description IS NULL OR char_length(btrim(description)) BETWEEN 1 AND 2000)
  AND char_length(addressed_to) BETWEEN 2 AND 150 AND addressed_to = btrim(addressed_to)
  AND due_on >= sent_on
  AND status IN ('pending', 'approved', 'approved_with_comments', 'rejected', 'resubmit',
    'cancelled')
  AND (status = 'cancelled') = (cancelled_by IS NOT NULL)
  AND (status = 'cancelled') = (cancelled_at IS NOT NULL)
  AND (status = 'cancelled') = (cancel_reason IS NOT NULL)
  AND (cancel_reason IS NULL OR char_length(btrim(cancel_reason)) BETWEEN 3 AND 500)
  AND (resubmission_of_id IS NULL OR resubmission_of_id <> id)
  AND version >= 1
);

CREATE FUNCTION app.guard_approval_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  latest integer;
  target document_versions%ROWTYPE;
  document_status text;
  original_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Approval requests are never deleted; cancel them' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.raised_by IS DISTINCT FROM app.current_user_id() OR NEW.status <> 'pending'
      OR NEW.version <> 1 THEN
      RAISE EXCEPTION 'An approval request is raised, pending, by the signed-in user'
        USING ERRCODE = '23514';
    END IF;
    PERFORM app.assert_documents_writable(NEW.tenant_id, NEW.project_id);
    PERFORM 1 FROM projects WHERE tenant_id = NEW.tenant_id AND id = NEW.project_id FOR UPDATE;
    SELECT max(number) INTO latest FROM approval_requests
      WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id;
    IF NEW.number <> COALESCE(latest, 0) + 1 THEN
      RAISE EXCEPTION 'Approval requests are numbered in order' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO target FROM document_versions
      WHERE tenant_id = NEW.tenant_id AND id = NEW.document_version_id;
    SELECT status INTO document_status FROM documents
      WHERE tenant_id = NEW.tenant_id AND id = target.document_id;
    IF NOT target.is_current OR document_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'Approval is asked for the current version of an active document'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.sent_on > app.business_today() THEN
      RAISE EXCEPTION 'A request is not sent in the future' USING ERRCODE = '23514';
    END IF;
    IF NEW.resubmission_of_id IS NOT NULL THEN
      SELECT status INTO original_status FROM approval_requests
        WHERE tenant_id = NEW.tenant_id AND id = NEW.resubmission_of_id;
      IF original_status NOT IN ('rejected', 'resubmit') THEN
        RAISE EXCEPTION 'Only a rejected or "resubmit" request is resubmitted'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    NEW.raised_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'A decided or cancelled approval request is final' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.id, NEW.tenant_id, NEW.project_id, NEW.number, NEW.kind, NEW.title, NEW.description,
      NEW.document_version_id, NEW.addressed_to, NEW.sent_on, NEW.due_on, NEW.resubmission_of_id,
      NEW.raised_by, NEW.raised_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.project_id, OLD.number, OLD.kind, OLD.title,
      OLD.description, OLD.document_version_id, OLD.addressed_to, OLD.sent_on, OLD.due_on,
      OLD.resubmission_of_id, OLD.raised_by, OLD.raised_at)
    OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'An approval request never changes; it is answered or cancelled'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'cancelled' THEN
    IF NEW.cancelled_by IS DISTINCT FROM app.current_user_id()
      OR EXISTS (SELECT 1 FROM approval_responses
                  WHERE tenant_id = NEW.tenant_id AND request_id = NEW.id) THEN
      RAISE EXCEPTION 'A request is cancelled by the signed-in user before any response'
        USING ERRCODE = '23514';
    END IF;
    PERFORM app.assert_documents_writable(NEW.tenant_id, NEW.project_id);
    NEW.cancelled_at := now();
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM approval_responses
                  WHERE tenant_id = NEW.tenant_id AND request_id = NEW.id
                    AND decision = NEW.status) THEN
    RAISE EXCEPTION 'A request is decided only by its response' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER approval_request_guard BEFORE INSERT OR UPDATE OR DELETE ON "approval_requests"
  FOR EACH ROW EXECUTE FUNCTION app.guard_approval_request();

-- packages/types APPROVAL_DECISIONS, APPROVAL_CHANNELS; packages/domain approvalResponseProblem.
ALTER TABLE "approval_responses" ADD CONSTRAINT "approval_responses_check" CHECK (
  decision IN ('approved', 'approved_with_comments', 'rejected', 'resubmit')
  AND channel IN ('in_app', 'paper')
  AND (channel = 'in_app') = (responder_user_id IS NOT NULL)
  AND (channel = 'paper') = (evidence_version_id IS NOT NULL)
  AND char_length(responder_name) BETWEEN 2 AND 150 AND responder_name = btrim(responder_name)
  AND (responder_firm IS NULL OR char_length(btrim(responder_firm)) BETWEEN 1 AND 150)
  AND (comments IS NULL OR char_length(btrim(comments)) BETWEEN 1 AND 2000)
  AND (decision = 'approved' OR comments IS NOT NULL)
  AND reviewed_sha256 ~ '^[0-9a-f]{64}$'
);

CREATE FUNCTION app.guard_approval_response() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  request approval_requests%ROWTYPE;
  reviewed document_versions%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Approval responses are append-only' USING ERRCODE = '42501';
  END IF;
  IF NEW.recorded_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A response is recorded by the signed-in user' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO request FROM approval_requests
    WHERE tenant_id = NEW.tenant_id AND id = NEW.request_id FOR UPDATE;
  IF request.status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'Only a pending request is answered' USING ERRCODE = '23514';
  END IF;
  PERFORM app.assert_documents_writable(NEW.tenant_id, NEW.project_id);
  SELECT * INTO reviewed FROM document_versions
    WHERE tenant_id = NEW.tenant_id AND id = request.document_version_id;
  IF NEW.reviewed_sha256 IS DISTINCT FROM reviewed.sha256 THEN
    RAISE EXCEPTION 'The response is for the file sent (its SHA-256)' USING ERRCODE = '23514';
  END IF;
  IF NEW.responded_on < request.sent_on OR NEW.responded_on > app.business_today() THEN
    RAISE EXCEPTION 'A response is dated between the request and today' USING ERRCODE = '23514';
  END IF;
  IF NEW.channel = 'in_app' THEN
    -- Independence (decision D-117): never the raiser, never the uploader of the version.
    IF NEW.responder_user_id IS DISTINCT FROM NEW.recorded_by
      OR NEW.responder_user_id = request.raised_by
      OR NEW.responder_user_id = reviewed.uploaded_by THEN
      RAISE EXCEPTION 'An approval is answered by someone who neither raised it nor uploaded the file'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.evidence_version_id = request.document_version_id THEN
    RAISE EXCEPTION 'A paper response attaches the signed response, not the file sent'
      USING ERRCODE = '23514';
  END IF;
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END
$$;
CREATE TRIGGER approval_response_guard BEFORE INSERT OR UPDATE OR DELETE ON "approval_responses"
  FOR EACH ROW EXECUTE FUNCTION app.guard_approval_response();

-- The response decides the request (the request guard checks that the response exists).
CREATE FUNCTION app.apply_approval_response() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE approval_requests SET status = NEW.decision, version = version + 1
   WHERE tenant_id = NEW.tenant_id AND id = NEW.request_id;
  RETURN NULL;
END
$$;
CREATE TRIGGER approval_response_applied AFTER INSERT ON "approval_responses"
  FOR EACH ROW EXECUTE FUNCTION app.apply_approval_response();

-- Row-level security -----------------------------------------------------------------------------
DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['documents', 'document_versions', 'compliance_types',
    'compliance_records', 'instruction_responses', 'instruction_attachments', 'approval_requests',
    'approval_responses']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = app.current_tenant_id()) '
      'WITH CHECK (tenant_id = app.current_tenant_id())', target || '_isolation', target);
  END LOOP;
END
$$;

-- The runtime role never deletes these records and never rewrites responses or attachments.
-- document_versions, compliance_records and approval_requests keep UPDATE only for the
-- supersession, cancellation and decision the guards allow.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmb_app') THEN
    REVOKE UPDATE ON "instruction_responses", "instruction_attachments", "approval_responses"
      FROM pmb_app;
    REVOKE DELETE ON "documents", "document_versions", "compliance_types", "compliance_records",
      "instruction_responses", "instruction_attachments", "approval_requests",
      "approval_responses" FROM pmb_app;
    REVOKE TRUNCATE, REFERENCES, TRIGGER
      ON "documents", "document_versions", "compliance_types", "compliance_records",
         "instruction_responses", "instruction_attachments", "approval_requests",
         "approval_responses"
      FROM pmb_app;
    GRANT EXECUTE ON FUNCTION app.assert_documents_writable(uuid, uuid) TO pmb_app;
  END IF;
END
$$;
REVOKE EXECUTE ON FUNCTION app.assert_documents_writable(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_document() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_document_has_version() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_document_version() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_document_versions() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_compliance_type() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_compliance_record() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_compliance_records() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_instruction() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_instruction_response() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_instruction_status() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_instruction_attachment() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_variation_order() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_approval_request() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_approval_response() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.apply_approval_response() FROM PUBLIC;

COMMIT;
