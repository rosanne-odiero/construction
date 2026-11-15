-- D3.4 biometric attendance, first slice: the DPIA gate (DPIA_TEMPLATE §12.4; ARCHITECTURE §4.17;
-- ERD §6; decisions D-160–D-165). Biometric capture is off for a company until its DPIA is approved
-- in the app, and then only for the sites and methods switched on under it. Enforced in the
-- database as well as the API:
-- * dpia_records: one row per version of the company's DPIA, numbered in order. draft → approved
--   (→ superseded by a renewal, or withdrawn with a reason) or draft → rejected with a reason; the
--   last three are final. One draft and one approved version per company (partial unique
--   indexes). Approval needs the signed document, a method, a site, the DPO's opinion (not a
--   rejection) and the controller's decision (not "do not proceed") with their conditions written
--   down, signatures not dated in the future, a residual risk (high needs the ODPC prior
--   consultation reference), a review date after today and at most 12 months ahead, every go-live
--   condition confirmed, the approved digest and the approver as the signed-in user. Approval never
--   edits the content; a superseded version's successor is approved at commit
--   (app.check_dpia_supersession). Every timestamp is the database clock.
-- * dpia_record_sites: the sites in scope, changed only while the version is a draft.
-- * dpia_documents (append-only): signed PDFs uploaded to a draft, under a key derived from the IDs;
--   the record points at its current one through a composite key, so it is always its own.
-- * biometric_switches (append-only; the latest row by seq is the position): switching on needs the
--   approved DPIA in force covering the site and method on an open project, recorded as the
--   signed-in user.
-- * app.biometric_capture_allowed(tenant, site, method, date): the gate, failing closed; every
--   biometric attendance record (face, fingerprint, terminal) is written on its own work date and
--   must pass it for that date.
-- * Permissions biometrics.manage and biometrics.approve (company-level; approve needs MFA).
-- The platform switch BIOMETRICS_CAPTURE lives in the API: the database cannot read it. Every new
-- table has tenant_id, forced RLS with WITH CHECK and composite (tenant_id, …) foreign keys.
BEGIN;

-- CreateTable
CREATE TABLE "dpia_records" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'draft',
    "capture_methods" VARCHAR(12)[] DEFAULT ARRAY[]::VARCHAR(12)[],
    "dpo_name" VARCHAR(120),
    "dpo_opinion" VARCHAR(30),
    "dpo_opinion_on" DATE,
    "dpo_note" VARCHAR(2000),
    "controller_name" VARCHAR(120),
    "controller_role" VARCHAR(120),
    "controller_decision" VARCHAR(30),
    "controller_decision_on" DATE,
    "controller_note" VARCHAR(2000),
    "residual_risk" VARCHAR(10),
    "odpc_reference" VARCHAR(80),
    "document_id" UUID,
    "review_due" DATE,
    "conditions_confirmed" VARCHAR(30)[] DEFAULT ARRAY[]::VARCHAR(30)[],
    "approved_digest" CHAR(64),
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ,
    "rejected_by" UUID,
    "rejected_at" TIMESTAMPTZ,
    "reject_reason" VARCHAR(500),
    "withdrawn_by" UUID,
    "withdrawn_at" TIMESTAMPTZ,
    "withdraw_reason" VARCHAR(500),
    "superseded_by_id" UUID,
    "superseded_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dpia_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dpia_record_sites" (
    "tenant_id" UUID NOT NULL,
    "dpia_record_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,

    CONSTRAINT "dpia_record_sites_pkey" PRIMARY KEY ("tenant_id","dpia_record_id","site_id")
);

-- CreateTable
CREATE TABLE "dpia_documents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "dpia_record_id" UUID NOT NULL,
    "file_name" VARCHAR(120) NOT NULL,
    "content_type" VARCHAR(100) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "object_key" VARCHAR(300) NOT NULL,
    "scan_status" VARCHAR(20) NOT NULL,
    "scan_engine" VARCHAR(60) NOT NULL,
    "scanned_at" TIMESTAMPTZ NOT NULL,
    "uploaded_by" UUID NOT NULL,
    "uploaded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dpia_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "biometric_switches" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "project_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "method" VARCHAR(12) NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "dpia_record_id" UUID,
    "reason" VARCHAR(500),
    "carried_forward" BOOLEAN NOT NULL DEFAULT false,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "biometric_switches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dpia_records_tenant_id_id_key" ON "dpia_records"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "dpia_records_tenant_id_version_no_key" ON "dpia_records"("tenant_id", "version_no");

-- CreateIndex
CREATE INDEX "dpia_record_sites_tenant_id_site_id_idx" ON "dpia_record_sites"("tenant_id", "site_id");

-- CreateIndex
CREATE UNIQUE INDEX "dpia_documents_tenant_id_id_key" ON "dpia_documents"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "dpia_documents_tenant_id_dpia_record_id_id_key" ON "dpia_documents"("tenant_id", "dpia_record_id", "id");

-- CreateIndex
CREATE INDEX "biometric_switches_tenant_id_site_id_method_seq_idx" ON "biometric_switches"("tenant_id", "site_id", "method", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "biometric_switches_tenant_id_id_key" ON "biometric_switches"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "dpia_records" ADD CONSTRAINT "dpia_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dpia_records" ADD CONSTRAINT "dpia_records_tenant_id_id_document_id_fkey" FOREIGN KEY ("tenant_id", "id", "document_id") REFERENCES "dpia_documents"("tenant_id", "dpia_record_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dpia_records" ADD CONSTRAINT "dpia_records_tenant_id_superseded_by_id_fkey" FOREIGN KEY ("tenant_id", "superseded_by_id") REFERENCES "dpia_records"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dpia_record_sites" ADD CONSTRAINT "dpia_record_sites_tenant_id_dpia_record_id_fkey" FOREIGN KEY ("tenant_id", "dpia_record_id") REFERENCES "dpia_records"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dpia_record_sites" ADD CONSTRAINT "dpia_record_sites_tenant_id_site_id_fkey" FOREIGN KEY ("tenant_id", "site_id") REFERENCES "sites"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dpia_documents" ADD CONSTRAINT "dpia_documents_tenant_id_dpia_record_id_fkey" FOREIGN KEY ("tenant_id", "dpia_record_id") REFERENCES "dpia_records"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biometric_switches" ADD CONSTRAINT "biometric_switches_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biometric_switches" ADD CONSTRAINT "biometric_switches_tenant_id_project_id_site_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "site_id") REFERENCES "sites"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biometric_switches" ADD CONSTRAINT "biometric_switches_tenant_id_dpia_record_id_fkey" FOREIGN KEY ("tenant_id", "dpia_record_id") REFERENCES "dpia_records"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- One draft and one approved version per company -----------------------------------------------
CREATE UNIQUE INDEX "dpia_records_one_draft" ON "dpia_records" ("tenant_id") WHERE status = 'draft';
CREATE UNIQUE INDEX "dpia_records_one_approved" ON "dpia_records" ("tenant_id")
  WHERE status = 'approved';

-- DPIA records (packages/types biometrics.ts) ---------------------------------------------------
CREATE FUNCTION app.has_distinct_varchar_elements(values_in varchar[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT count(*) = count(DISTINCT value) FROM unnest(values_in) AS value
$$;
ALTER TABLE "dpia_records" ADD CONSTRAINT "dpia_records_vocabulary_check" CHECK (
  version_no >= 1 AND version >= 1
  AND status IN ('draft', 'approved', 'rejected', 'superseded', 'withdrawn')
  AND capture_methods IS NOT NULL
  AND capture_methods <@ ARRAY['face', 'fingerprint', 'terminal']::varchar[]
  AND app.has_distinct_varchar_elements(capture_methods)
  AND conditions_confirmed IS NOT NULL
  AND conditions_confirmed <@ ARRAY['fallback_ready', 'accuracy_tested', 'vendor_assessed',
    'notices_reviewed', 'staff_trained', 'retention_set', 'hosting_recorded',
    'odpc_registered']::varchar[]
  AND app.has_distinct_varchar_elements(conditions_confirmed)
  AND (dpo_opinion IS NULL OR dpo_opinion IN ('approve', 'approve_with_conditions', 'reject'))
  AND (controller_decision IS NULL
    OR controller_decision IN ('proceed', 'proceed_with_conditions', 'do_not_proceed'))
  AND (residual_risk IS NULL OR residual_risk IN ('low', 'medium', 'high'))
  AND (dpo_name IS NULL OR char_length(btrim(dpo_name)) >= 1)
  AND (dpo_note IS NULL OR char_length(btrim(dpo_note)) >= 1)
  AND (controller_name IS NULL OR char_length(btrim(controller_name)) >= 1)
  AND (controller_role IS NULL OR char_length(btrim(controller_role)) >= 1)
  AND (controller_note IS NULL OR char_length(btrim(controller_note)) >= 1)
  AND (odpc_reference IS NULL OR char_length(btrim(odpc_reference)) >= 1)
  AND (approved_digest IS NULL OR approved_digest ~ '^[0-9a-f]{64}$')
);
-- What each status carries, so no row can claim an approval, rejection, supersession or
-- withdrawal it never had.
ALTER TABLE "dpia_records" ADD CONSTRAINT "dpia_records_state_check" CHECK (
  ((status = 'draft') = (approved_at IS NULL AND rejected_at IS NULL))
  AND ((approved_by IS NULL) = (approved_at IS NULL))
  AND ((approved_at IS NULL) = (approved_digest IS NULL))
  AND ((approved_at IS NULL) = (review_due IS NULL))
  AND (approved_at IS NULL OR (document_id IS NOT NULL AND cardinality(conditions_confirmed) = 8))
  AND (approved_at IS NOT NULL OR cardinality(conditions_confirmed) = 0)
  AND ((status = 'rejected') = (rejected_at IS NOT NULL))
  AND ((rejected_at IS NULL) = (rejected_by IS NULL))
  AND ((rejected_at IS NULL) = (reject_reason IS NULL))
  AND (reject_reason IS NULL OR char_length(btrim(reject_reason)) BETWEEN 10 AND 500)
  AND ((status = 'withdrawn') = (withdrawn_at IS NOT NULL))
  AND ((withdrawn_at IS NULL) = (withdrawn_by IS NULL))
  AND ((withdrawn_at IS NULL) = (withdraw_reason IS NULL))
  AND (withdraw_reason IS NULL OR char_length(btrim(withdraw_reason)) BETWEEN 10 AND 500)
  AND ((status = 'superseded') = (superseded_at IS NOT NULL))
  AND ((superseded_at IS NULL) = (superseded_by_id IS NULL))
  AND (status NOT IN ('approved', 'superseded', 'withdrawn') OR approved_at IS NOT NULL)
  AND (status <> 'rejected' OR (approved_at IS NULL AND cardinality(conditions_confirmed) = 0))
  AND (superseded_by_id IS NULL OR superseded_by_id <> id)
);

-- `dp.dpia_review_interval_months` (packages/types DPIA_REVIEW_INTERVAL_MONTHS = 12).
CREATE FUNCTION app.guard_dpia_record() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  today date := app.nairobi_today();
  actor uuid := app.current_user_id();
  successor record;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'DPIA records are never deleted' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.version <> 1 OR NEW.document_id IS NOT NULL THEN
      RAISE EXCEPTION 'A DPIA starts as a draft without a document' USING ERRCODE = '23514';
    END IF;
    IF NEW.created_by IS DISTINCT FROM actor OR NEW.updated_by IS DISTINCT FROM actor THEN
      RAISE EXCEPTION 'A DPIA is created by the signed-in user' USING ERRCODE = '42501';
    END IF;
    NEW.version_no := COALESCE((SELECT max(version_no) FROM dpia_records
                                 WHERE tenant_id = NEW.tenant_id), 0) + 1;
    NEW.created_at := clock_timestamp();
    NEW.updated_at := NEW.created_at;
    RETURN NEW;
  END IF;

  IF (NEW.id, NEW.tenant_id, NEW.version_no, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.version_no, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'A DPIA''s identity never changes' USING ERRCODE = '23514';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Every change moves the version on' USING ERRCODE = '23514';
  END IF;
  IF NEW.updated_by IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'A DPIA is changed by the signed-in user' USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := clock_timestamp();

  IF OLD.status = 'draft' AND NEW.status = 'draft' THEN
    RETURN NEW;
  END IF;

  -- Approval, rejection, supersession and withdrawal never edit the content.
  IF (NEW.capture_methods, NEW.dpo_name, NEW.dpo_opinion, NEW.dpo_opinion_on, NEW.dpo_note,
      NEW.controller_name, NEW.controller_role, NEW.controller_decision,
      NEW.controller_decision_on, NEW.controller_note, NEW.residual_risk, NEW.odpc_reference,
      NEW.document_id)
     IS DISTINCT FROM
     (OLD.capture_methods, OLD.dpo_name, OLD.dpo_opinion, OLD.dpo_opinion_on, OLD.dpo_note,
      OLD.controller_name, OLD.controller_role, OLD.controller_decision,
      OLD.controller_decision_on, OLD.controller_note, OLD.residual_risk, OLD.odpc_reference,
      OLD.document_id) THEN
    RAISE EXCEPTION 'Only a draft''s content can change' USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'approved' THEN
    IF NEW.approved_by IS DISTINCT FROM actor THEN
      RAISE EXCEPTION 'A DPIA is approved by the signed-in user' USING ERRCODE = '42501';
    END IF;
    IF NEW.document_id IS NULL
       OR cardinality(NEW.capture_methods) = 0
       OR NOT EXISTS (SELECT 1 FROM dpia_record_sites s
                       WHERE s.tenant_id = NEW.tenant_id AND s.dpia_record_id = NEW.id)
       OR NEW.dpo_name IS NULL OR NEW.dpo_opinion_on IS NULL OR NEW.dpo_opinion_on > today
       OR NEW.dpo_opinion IS NULL OR NEW.dpo_opinion NOT IN ('approve', 'approve_with_conditions')
       OR (NEW.dpo_opinion = 'approve_with_conditions' AND NEW.dpo_note IS NULL)
       OR NEW.controller_name IS NULL OR NEW.controller_decision_on IS NULL
       OR NEW.controller_decision_on > today OR NEW.controller_decision IS NULL
       OR NEW.controller_decision NOT IN ('proceed', 'proceed_with_conditions')
       OR (NEW.controller_decision = 'proceed_with_conditions' AND NEW.controller_note IS NULL)
       OR NEW.residual_risk IS NULL
       OR (NEW.residual_risk = 'high' AND NEW.odpc_reference IS NULL) THEN
      RAISE EXCEPTION 'The DPIA is not complete enough to approve' USING ERRCODE = '23514';
    END IF;
    IF NEW.review_due IS NULL OR NEW.review_due <= today
       OR NEW.review_due > (today + interval '12 months')::date THEN
      RAISE EXCEPTION 'The review date must be after today and at most 12 months ahead'
        USING ERRCODE = '23514';
    END IF;
    IF NOT (NEW.conditions_confirmed @> ARRAY['fallback_ready', 'accuracy_tested',
        'vendor_assessed', 'notices_reviewed', 'staff_trained', 'retention_set',
        'hosting_recorded', 'odpc_registered']::varchar[]) THEN
      RAISE EXCEPTION 'Every go-live condition must be confirmed' USING ERRCODE = '23514';
    END IF;
    NEW.approved_at := clock_timestamp();
    RETURN NEW;
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'rejected' THEN
    IF NEW.rejected_by IS DISTINCT FROM actor THEN
      RAISE EXCEPTION 'A DPIA is rejected by the signed-in user' USING ERRCODE = '42501';
    END IF;
    NEW.rejected_at := clock_timestamp();
    RETURN NEW;
  END IF;

  IF OLD.status = 'approved' AND NEW.status IN ('superseded', 'withdrawn') THEN
    IF (NEW.review_due, NEW.conditions_confirmed, NEW.approved_digest, NEW.approved_by,
        NEW.approved_at)
       IS DISTINCT FROM
       (OLD.review_due, OLD.conditions_confirmed, OLD.approved_digest, OLD.approved_by,
        OLD.approved_at) THEN
      RAISE EXCEPTION 'An approval never changes' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'superseded' THEN
      SELECT version_no INTO successor FROM dpia_records
       WHERE tenant_id = NEW.tenant_id AND id = NEW.superseded_by_id;
      IF NOT FOUND OR successor.version_no <= NEW.version_no THEN
        RAISE EXCEPTION 'A DPIA is superseded by a later version' USING ERRCODE = '23514';
      END IF;
      NEW.superseded_at := clock_timestamp();
    ELSE
      IF NEW.withdrawn_by IS DISTINCT FROM actor THEN
        RAISE EXCEPTION 'A DPIA is withdrawn by the signed-in user' USING ERRCODE = '42501';
      END IF;
      NEW.withdrawn_at := clock_timestamp();
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'This DPIA can no longer change' USING ERRCODE = '23514';
END
$$;
CREATE TRIGGER dpia_record_guard BEFORE INSERT OR UPDATE OR DELETE ON "dpia_records"
  FOR EACH ROW EXECUTE FUNCTION app.guard_dpia_record();
CREATE TRIGGER dpia_record_no_truncate BEFORE TRUNCATE ON "dpia_records"
  FOR EACH STATEMENT EXECUTE FUNCTION app.guard_dpia_record();

-- At commit: a superseded version's successor is the approved version.
CREATE FUNCTION app.check_dpia_supersession() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM dpia_records r
                  WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.superseded_by_id
                    AND r.status = 'approved') THEN
    RAISE EXCEPTION 'A superseded DPIA needs its renewal approved in the same transaction'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER dpia_record_supersession AFTER UPDATE ON "dpia_records"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.status = 'superseded' AND OLD.status = 'approved')
  EXECUTE FUNCTION app.check_dpia_supersession();

-- Sites in scope: only while the version is a draft ------------------------------------------
CREATE FUNCTION app.guard_dpia_record_site() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target record;
  record_status text;
BEGIN
  IF TG_OP = 'UPDATE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'A DPIA''s sites are added or removed, never rewritten' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN
    target := OLD;
  ELSE
    target := NEW;
  END IF;
  SELECT status INTO record_status FROM dpia_records
   WHERE tenant_id = target.tenant_id AND id = target.dpia_record_id FOR SHARE;
  IF record_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Only a draft DPIA''s sites can change' USING ERRCODE = '23514';
  END IF;
  RETURN target;
END
$$;
CREATE TRIGGER dpia_record_site_guard BEFORE INSERT OR UPDATE OR DELETE ON "dpia_record_sites"
  FOR EACH ROW EXECUTE FUNCTION app.guard_dpia_record_site();
CREATE TRIGGER dpia_record_site_no_truncate BEFORE TRUNCATE ON "dpia_record_sites"
  FOR EACH STATEMENT EXECUTE FUNCTION app.guard_dpia_record_site();

-- Signed documents (append-only) --------------------------------------------------------------
ALTER TABLE "dpia_documents" ADD CONSTRAINT "dpia_documents_check" CHECK (
  content_type = 'application/pdf'
  AND size_bytes BETWEEN 1 AND 26214400
  AND sha256 ~ '^[0-9a-f]{64}$'
  AND scan_status IN ('clean', 'not_scanned')
  AND char_length(btrim(file_name)) >= 1
  AND char_length(btrim(scan_engine)) >= 1
);

CREATE FUNCTION app.guard_dpia_document() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  record_status text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Signed DPIA documents are append-only' USING ERRCODE = '42501';
  END IF;
  SELECT status INTO record_status FROM dpia_records
   WHERE tenant_id = NEW.tenant_id AND id = NEW.dpia_record_id FOR SHARE;
  IF record_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'A signed document is uploaded to a draft only' USING ERRCODE = '23514';
  END IF;
  IF NEW.uploaded_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A document is uploaded by the signed-in user' USING ERRCODE = '42501';
  END IF;
  IF NEW.object_key IS DISTINCT FROM
     format('tenants/%s/dpias/%s/%s', NEW.tenant_id, NEW.dpia_record_id, NEW.id) THEN
    RAISE EXCEPTION 'The storage key is derived from the IDs' USING ERRCODE = '23514';
  END IF;
  NEW.uploaded_at := clock_timestamp();
  RETURN NEW;
END
$$;
CREATE TRIGGER dpia_document_guard BEFORE INSERT OR UPDATE OR DELETE ON "dpia_documents"
  FOR EACH ROW EXECUTE FUNCTION app.guard_dpia_document();
CREATE TRIGGER dpia_document_no_truncate BEFORE TRUNCATE ON "dpia_documents"
  FOR EACH STATEMENT EXECUTE FUNCTION app.guard_dpia_document();

-- The gate ------------------------------------------------------------------------------------
-- Whether biometric capture may run for a site and method on a date: the latest switch is on, the
-- DPIA it was made under is still the approved one, in force on that date and covering the site
-- and method, and the project is open. Anything else (no switch, no DPIA) is false.
CREATE FUNCTION app.biometric_capture_allowed(p_tenant uuid, p_site uuid, p_method text,
  p_on date) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE((
    SELECT s.enabled
       AND d.status = 'approved'
       AND d.review_due >= p_on
       AND s.method = ANY (d.capture_methods)
       AND EXISTS (SELECT 1 FROM dpia_record_sites x
                    WHERE x.tenant_id = d.tenant_id AND x.dpia_record_id = d.id
                      AND x.site_id = s.site_id)
       AND p.status NOT IN ('closed', 'cancelled')
      FROM biometric_switches s
      JOIN projects p ON p.tenant_id = s.tenant_id AND p.id = s.project_id
      LEFT JOIN dpia_records d ON d.tenant_id = s.tenant_id AND d.id = s.dpia_record_id
     WHERE s.tenant_id = p_tenant AND s.site_id = p_site AND s.method = p_method
     ORDER BY s.seq DESC
     LIMIT 1), false)
$$;

-- Switches (append-only) ----------------------------------------------------------------------
ALTER TABLE "biometric_switches" ADD CONSTRAINT "biometric_switches_check" CHECK (
  method IN ('face', 'fingerprint', 'terminal')
  AND (NOT enabled OR dpia_record_id IS NOT NULL)
  AND (NOT carried_forward OR enabled)
  AND (reason IS NULL OR char_length(btrim(reason)) BETWEEN 1 AND 500)
);

CREATE FUNCTION app.guard_biometric_switch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  dpia record;
  project_status text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Biometric switches are append-only' USING ERRCODE = '42501';
  END IF;
  IF NEW.actor_id IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A switch is recorded as the signed-in user' USING ERRCODE = '42501';
  END IF;
  -- The order of switches is the database's, never the client's.
  NEW.seq := nextval(pg_get_serial_sequence('biometric_switches', 'seq'));
  NEW.created_at := clock_timestamp();
  IF NEW.enabled THEN
    SELECT status INTO project_status FROM projects
     WHERE tenant_id = NEW.tenant_id AND id = NEW.project_id;
    IF project_status IN ('closed', 'cancelled') THEN
      RAISE EXCEPTION 'Closed and cancelled projects are read-only' USING ERRCODE = '23514';
    END IF;
    SELECT status, review_due, capture_methods INTO dpia FROM dpia_records
     WHERE tenant_id = NEW.tenant_id AND id = NEW.dpia_record_id FOR SHARE;
    IF NOT FOUND OR dpia.status <> 'approved' OR dpia.review_due < app.nairobi_today()
       OR NOT (NEW.method = ANY (dpia.capture_methods))
       OR NOT EXISTS (SELECT 1 FROM dpia_record_sites x
                       WHERE x.tenant_id = NEW.tenant_id AND x.dpia_record_id = NEW.dpia_record_id
                         AND x.site_id = NEW.site_id) THEN
      RAISE EXCEPTION 'Biometric capture is switched on only under the approved DPIA in force covering the site and method'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER biometric_switch_guard BEFORE INSERT OR UPDATE OR DELETE ON "biometric_switches"
  FOR EACH ROW EXECUTE FUNCTION app.guard_biometric_switch();
CREATE TRIGGER biometric_switch_no_truncate BEFORE TRUNCATE ON "biometric_switches"
  FOR EACH STATEMENT EXECUTE FUNCTION app.guard_biometric_switch();

-- Biometric attendance records pass the gate when written. The capture method of a record never
-- changes (app.guard_attendance_record), so checking inserts is enough. Until the kiosk slice
-- defines the rule for records captured offline, a biometric record is written on its own work
-- date (Africa/Nairobi), so the gate checked is the one in force that day: a backdated record
-- (captured while the DPIA had lapsed, say, and synced after a renewal) is refused.
CREATE FUNCTION app.guard_biometric_attendance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.capture_method IN ('face', 'fingerprint', 'terminal') THEN
    IF NEW.work_date IS DISTINCT FROM app.nairobi_today() THEN
      RAISE EXCEPTION 'A biometric attendance record is written on its work date'
        USING ERRCODE = '23514';
    END IF;
    IF NOT app.biometric_capture_allowed(NEW.tenant_id, NEW.site_id, NEW.capture_method,
        NEW.work_date) THEN
      RAISE EXCEPTION 'Biometric capture is not switched on for this site under an approved DPIA'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER attendance_record_biometric_gate BEFORE INSERT ON "attendance_records"
  FOR EACH ROW EXECUTE FUNCTION app.guard_biometric_attendance();

-- Permissions (packages/types PERMISSIONS): biometrics.manage and biometrics.approve ----------
-- Both are company-level, so project assignments (project_permissions_check) do not change.
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
    'biometrics.manage', 'biometrics.approve',
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
-- MFA-required permissions only grow (CONFIGURATION auth.mfa.required_permissions): approving a
-- DPIA switches on the processing of sensitive personal data. Only the owner system role holds it,
-- so app.system_role_requires_mfa is unchanged.
CREATE OR REPLACE FUNCTION app.permissions_require_mfa(permissions text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT COALESCE(permissions && ARRAY[
    'biometrics.approve', 'payroll.approve', 'payroll.verify_rules', 'payroll.export',
    'payments.approve', 'payments.disburse', 'payments.reverse', 'finance.manage',
    'config.manage_statutory', 'roles.manage', 'tenancy.manage', 'platform.admin'
  ]::text[], false) $$;

-- Row-level security --------------------------------------------------------------------------
DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['dpia_records', 'dpia_record_sites', 'dpia_documents',
    'biometric_switches']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = app.current_tenant_id()) '
      'WITH CHECK (tenant_id = app.current_tenant_id())', target || '_isolation', target);
  END LOOP;
END
$$;

-- The runtime role never deletes DPIA records, documents or switches and never rewrites a
-- document or a switch; a draft's sites are inserted and deleted (the guard keeps them fixed
-- after approval).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmb_app') THEN
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER
      ON "dpia_records", "dpia_documents", "biometric_switches" FROM pmb_app;
    REVOKE UPDATE ON "dpia_documents", "biometric_switches", "dpia_record_sites" FROM pmb_app;
    REVOKE TRUNCATE, REFERENCES, TRIGGER ON "dpia_record_sites" FROM pmb_app;
    GRANT EXECUTE ON FUNCTION app.biometric_capture_allowed(uuid, uuid, text, date) TO pmb_app;
    GRANT EXECUTE ON FUNCTION app.has_distinct_varchar_elements(varchar[]) TO pmb_app;
  END IF;
END
$$;
REVOKE EXECUTE ON FUNCTION app.guard_dpia_record() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_dpia_supersession() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_dpia_record_site() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_dpia_document() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_biometric_switch() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_biometric_attendance() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.biometric_capture_allowed(uuid, uuid, text, date) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.has_distinct_varchar_elements(varchar[]) FROM PUBLIC;

COMMIT;
