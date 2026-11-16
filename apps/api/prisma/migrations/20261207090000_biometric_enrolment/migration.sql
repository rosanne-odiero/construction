-- D3.4 biometric attendance, second slice: consent per modality, enrolment with sealed templates,
-- and template deletion (DPIA_TEMPLATE §7, §8; ARCHITECTURE §4.19; ERD §6; decisions D-166–D-171).
-- * labourer_consents gains the kinds biometric_face and biometric_fingerprint. A biometric consent
--   (granted, or a refusal recorded as granted = false) names the DPIA in force when its notice was
--   shown (dpia_record_id), which must cover the modality. Withdrawing it deletes the templates it
--   allowed in the same transaction (deferred check).
-- * biometric_enrolments: one active enrolment per worker and modality, made where the gate is open
--   for the site and method today, under the DPIA in force, with the worker's consent and an
--   engagement on the site's project that day. Deleted enrolments keep their metadata only.
-- * biometric_templates: sealed to the biometrics-only public key (format 2 envelopes). pmb_app may
--   insert and delete them but never read template_enc; nothing changes them except a key rotation
--   by the schema owner. They are stored with their enrolment and deleted only with it.
-- * biometric_deletions: the deletion log, written by the database when an enrolment is marked
--   deleted (who, what, when, why; never template content). Append-only.
-- * A DPIA can stop being the approved one (withdrawn, superseded) only if no active enrolment is
--   left that no approved DPIA covers (deferred check): a lapse keeps templates (held), a
--   withdrawal or a renewal dropping the modality deletes them (owner's choice, 16 November 2026).
-- * Retention: app.biometric_retention_due_on (the day templates fall due after the last
--   engagement) and app.biometric_retention_tenants() (SECURITY DEFINER: which companies hold
--   active enrolments, for the retention job). The retention period itself is the installation's
--   BIOMETRICS_RETENTION_DAYS_AFTER_ENGAGEMENT; the database checks that a retention deletion never
--   removes an engaged worker's templates or comes before their last engagement ended.
-- * Permission biometrics.enrol (project-scoped, assignable). key_rotation_runs gains the kind
--   `biometric` (keys:rotate re-seals templates with the operator-held private keys).
-- * The commit-time checks read through row-level security, so each refuses to run outside the
--   changed row's company context (a session that cleared or switched app.tenant_id would
--   otherwise see nothing and pass). An enrolment takes share locks on its consent and DPIA rows,
--   so their withdrawal and the enrolment never commit past each other.
BEGIN;

-- AlterTable
ALTER TABLE "labourer_consents" ADD COLUMN     "dpia_record_id" UUID;

-- CreateTable
CREATE TABLE "biometric_enrolments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "labourer_id" UUID NOT NULL,
    "modality" VARCHAR(12) NOT NULL,
    "capture_method" VARCHAR(12) NOT NULL,
    "consent_id" UUID NOT NULL,
    "dpia_record_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'active',
    "template_count" SMALLINT NOT NULL,
    "algorithm" VARCHAR(60) NOT NULL,
    "algorithm_version" VARCHAR(40) NOT NULL,
    "enrolled_by" UUID NOT NULL,
    "enrolled_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,
    "deleted_by" UUID,
    "deletion_reason" VARCHAR(20),
    "deletion_due_on" DATE,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "biometric_enrolments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "biometric_templates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "enrolment_id" UUID NOT NULL,
    "ordinal" SMALLINT NOT NULL,
    "template_enc" BYTEA NOT NULL,
    "quality_score" DECIMAL(5,2) NOT NULL,
    "key_version" SMALLINT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "biometric_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "biometric_deletions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "enrolment_id" UUID NOT NULL,
    "labourer_id" UUID NOT NULL,
    "modality" VARCHAR(12) NOT NULL,
    "reason" VARCHAR(20) NOT NULL,
    "template_count" SMALLINT NOT NULL,
    "due_on" DATE,
    "deleted_by" UUID NOT NULL,
    "deleted_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "biometric_deletions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "biometric_enrolments_tenant_id_labourer_id_modality_idx" ON "biometric_enrolments"("tenant_id", "labourer_id", "modality");

-- CreateIndex
CREATE INDEX "biometric_enrolments_tenant_id_status_idx" ON "biometric_enrolments"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "biometric_enrolments_tenant_id_id_key" ON "biometric_enrolments"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "biometric_templates_tenant_id_enrolment_id_ordinal_key" ON "biometric_templates"("tenant_id", "enrolment_id", "ordinal");

-- CreateIndex
CREATE INDEX "biometric_deletions_tenant_id_deleted_at_idx" ON "biometric_deletions"("tenant_id", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "biometric_deletions_tenant_id_enrolment_id_key" ON "biometric_deletions"("tenant_id", "enrolment_id");

-- AddForeignKey
ALTER TABLE "labourer_consents" ADD CONSTRAINT "labourer_consents_tenant_id_dpia_record_id_fkey" FOREIGN KEY ("tenant_id", "dpia_record_id") REFERENCES "dpia_records"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biometric_enrolments" ADD CONSTRAINT "biometric_enrolments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biometric_enrolments" ADD CONSTRAINT "biometric_enrolments_tenant_id_labourer_id_fkey" FOREIGN KEY ("tenant_id", "labourer_id") REFERENCES "labourers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biometric_enrolments" ADD CONSTRAINT "biometric_enrolments_tenant_id_consent_id_fkey" FOREIGN KEY ("tenant_id", "consent_id") REFERENCES "labourer_consents"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biometric_enrolments" ADD CONSTRAINT "biometric_enrolments_tenant_id_dpia_record_id_fkey" FOREIGN KEY ("tenant_id", "dpia_record_id") REFERENCES "dpia_records"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biometric_enrolments" ADD CONSTRAINT "biometric_enrolments_tenant_id_project_id_site_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "site_id") REFERENCES "sites"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biometric_templates" ADD CONSTRAINT "biometric_templates_tenant_id_enrolment_id_fkey" FOREIGN KEY ("tenant_id", "enrolment_id") REFERENCES "biometric_enrolments"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biometric_deletions" ADD CONSTRAINT "biometric_deletions_tenant_id_enrolment_id_fkey" FOREIGN KEY ("tenant_id", "enrolment_id") REFERENCES "biometric_enrolments"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Consent ----------------------------------------------------------------------------------------
-- packages/types CONSENT_KINDS. A biometric consent names the DPIA it was recorded under and its
-- notice belongs to its kind (biometric-face-…, biometric-fingerprint-…); only a granted consent
-- can be withdrawn.
ALTER TABLE "labourer_consents" DROP CONSTRAINT "labourer_consents_kind_check";
ALTER TABLE "labourer_consents" ADD CONSTRAINT "labourer_consents_kind_check" CHECK (
  kind IN ('registration_data', 'biometric_face', 'biometric_fingerprint')
  AND (kind = 'registration_data') = (dpia_record_id IS NULL)
  AND (kind <> 'biometric_face' OR notice_version LIKE 'biometric-face-%')
  AND (kind <> 'biometric_fingerprint' OR notice_version LIKE 'biometric-fingerprint-%')
  AND (withdrawn_at IS NULL OR granted)
);
-- At most one granted, unwithdrawn biometric consent per worker, kind and notice version.
CREATE UNIQUE INDEX "labourer_consents_biometric_active_key" ON "labourer_consents"
  ("tenant_id", "labourer_id", "kind", "notice_version")
  WHERE granted AND withdrawn_at IS NULL AND kind <> 'registration_data';

-- A consent record is evidence: never deleted (except with its labourer) and changed only to record
-- one withdrawal. Replaces the D3.1 guard to keep dpia_record_id fixed as well.
CREATE OR REPLACE FUNCTION app.guard_consent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Consent records are kept' USING ERRCODE = '42501';
  END IF;
  IF OLD.withdrawn_at IS NOT NULL OR NEW.withdrawn_at IS NULL
     OR (NEW.id, NEW.tenant_id, NEW.labourer_id, NEW.kind, NEW.notice_version, NEW.notice_digest,
         NEW.language, NEW.method, NEW.witness_name, NEW.granted, NEW.captured_by, NEW.captured_at,
         NEW.dpia_record_id)
        IS DISTINCT FROM
        (OLD.id, OLD.tenant_id, OLD.labourer_id, OLD.kind, OLD.notice_version, OLD.notice_digest,
         OLD.language, OLD.method, OLD.witness_name, OLD.granted, OLD.captured_by, OLD.captured_at,
         OLD.dpia_record_id)
  THEN
    RAISE EXCEPTION 'A consent record can only be withdrawn, once' USING ERRCODE = '23514';
  END IF;
  NEW.withdrawn_at := now();
  RETURN NEW;
END
$$;

-- Biometric consent is recorded only under the approved DPIA in force covering the modality (a
-- face or fingerprint method, or a terminal), one decision at a time: no refusal while a granted
-- consent stands (that is a withdrawal), no second grant to the same notice.
CREATE FUNCTION app.guard_biometric_consent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  covered boolean;
BEGIN
  IF NEW.kind = 'registration_data' THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM labourers WHERE tenant_id = NEW.tenant_id AND id = NEW.labourer_id FOR UPDATE;
  SELECT d.status = 'approved' AND d.review_due >= app.nairobi_today()
         AND d.capture_methods && (CASE NEW.kind
           WHEN 'biometric_face' THEN ARRAY['face', 'terminal']
           ELSE ARRAY['fingerprint', 'terminal'] END)::varchar[]
    INTO covered
    FROM dpia_records d
   WHERE d.tenant_id = NEW.tenant_id AND d.id = NEW.dpia_record_id;
  IF NOT COALESCE(covered, false) THEN
    RAISE EXCEPTION 'Biometric consent is recorded under the DPIA in force for its modality'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM labourer_consents c
     WHERE c.tenant_id = NEW.tenant_id AND c.labourer_id = NEW.labourer_id AND c.kind = NEW.kind
       AND c.granted AND c.withdrawn_at IS NULL
       AND (NOT NEW.granted OR c.notice_version = NEW.notice_version)
  ) THEN
    RAISE EXCEPTION 'The worker''s decision for this modality is already recorded'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER labourer_consent_biometric_guard BEFORE INSERT ON "labourer_consents"
  FOR EACH ROW EXECUTE FUNCTION app.guard_biometric_consent();

-- Withdrawing a biometric consent deletes, in the same transaction, the templates it allowed.
-- Like every commit-time check below, it reads through row-level security, so it runs only in the
-- changed row's company context: cleared or switched, the check would see nothing (fail closed).
CREATE FUNCTION app.check_biometric_consent_withdrawal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.current_tenant_id() IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'Biometric changes are checked in their company''s context'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM biometric_enrolments e
              WHERE e.tenant_id = NEW.tenant_id AND e.consent_id = NEW.id
                AND e.status = 'active') THEN
    RAISE EXCEPTION 'Withdrawing biometric consent deletes the templates it allowed'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER labourer_consent_biometric_withdrawal AFTER UPDATE ON "labourer_consents"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD.withdrawn_at IS NULL AND NEW.withdrawn_at IS NOT NULL AND NEW.kind <> 'registration_data')
  EXECUTE FUNCTION app.check_biometric_consent_withdrawal();

-- Enrolments -------------------------------------------------------------------------------------
-- packages/types BIOMETRIC_MODALITIES, MODALITY_METHODS, BIOMETRIC_DELETION_REASONS.
ALTER TABLE "biometric_enrolments" ADD CONSTRAINT "biometric_enrolments_check" CHECK (
  ((modality = 'face' AND capture_method IN ('face', 'terminal'))
    OR (modality = 'fingerprint' AND capture_method IN ('fingerprint', 'terminal')))
  AND status IN ('active', 'deleted')
  AND template_count BETWEEN 1 AND 10
  AND algorithm ~ '^[A-Za-z0-9][A-Za-z0-9 ._+-]{1,59}$'
  AND algorithm_version ~ '^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,39}$'
  AND (status = 'active') = (deleted_at IS NULL)
  AND (status = 'active') = (deleted_by IS NULL)
  AND (status = 'active') = (deletion_reason IS NULL)
  AND (deletion_reason IS NULL OR deletion_reason IN ('consent_withdrawn', 're_enrolled',
    'engagement_ended', 'dpia_withdrawn', 'out_of_scope', 'request'))
  AND COALESCE(deletion_reason = 'engagement_ended', false) = (deletion_due_on IS NOT NULL)
);
CREATE UNIQUE INDEX "biometric_enrolments_one_active_key" ON "biometric_enrolments"
  ("tenant_id", "labourer_id", "modality") WHERE status = 'active';

-- A new enrolment: recorded by the signed-in user (never the retention job) for an active worker
-- with an unwithdrawn granted consent of the modality, engaged on the site's project today, where
-- the gate is open for the site and method today, under the approved DPIA in force. The labourer
-- row lock serialises it with consent decisions; share locks on its consent and DPIA rows make a
-- withdrawal of either wait for the enrolment (or the enrolment wait for the withdrawal and then
-- see it), so neither commits past the other. Afterwards an enrolment changes once: active →
-- deleted, after its templates are gone, with the reason, by the signed-in user or (for a
-- retention deletion only) the retention job, which never deletes an engaged worker's templates.
CREATE FUNCTION app.guard_biometric_enrolment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  today date := app.nairobi_today();
  actor uuid := app.current_user_id();
  job uuid := '00000000-0000-4000-8000-00000000d340';
  worker record;
  consent record;
  earliest date;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Enrolments are kept; their templates are deleted' USING ERRCODE = '42501';
  END IF;
  IF actor IS NULL THEN
    RAISE EXCEPTION 'Enrolments change only in a signed-in context' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.enrolled_by IS DISTINCT FROM actor OR actor = job THEN
      RAISE EXCEPTION 'An enrolment is recorded by the signed-in user' USING ERRCODE = '42501';
    END IF;
    IF NEW.status <> 'active' THEN
      RAISE EXCEPTION 'A new enrolment is active' USING ERRCODE = '23514';
    END IF;
    NEW.enrolled_at := clock_timestamp();
    SELECT status INTO worker FROM labourers
     WHERE tenant_id = NEW.tenant_id AND id = NEW.labourer_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Unknown labourer' USING ERRCODE = '23503';
    END IF;
    IF worker.status <> 'active' THEN
      RAISE EXCEPTION 'Only an active labourer can be enrolled' USING ERRCODE = '23514';
    END IF;
    SELECT labourer_id, kind, granted, withdrawn_at INTO consent FROM labourer_consents
     WHERE tenant_id = NEW.tenant_id AND id = NEW.consent_id FOR SHARE;
    IF NOT FOUND OR consent.labourer_id <> NEW.labourer_id
       OR consent.kind <> 'biometric_' || NEW.modality
       OR NOT consent.granted OR consent.withdrawn_at IS NOT NULL THEN
      RAISE EXCEPTION 'An enrolment needs the worker''s consent for its modality'
        USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM labour_engagements e
       WHERE e.tenant_id = NEW.tenant_id AND e.labourer_id = NEW.labourer_id
         AND e.project_id = NEW.project_id AND e.start_date <= today
         AND (e.end_date IS NULL OR e.end_date >= today)
    ) THEN
      RAISE EXCEPTION 'The worker is not engaged on the site''s project today'
        USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM dpia_records d
     WHERE d.tenant_id = NEW.tenant_id AND d.id = NEW.dpia_record_id
       AND d.status = 'approved' AND d.review_due >= today
       FOR SHARE;
    IF NOT FOUND
       OR NOT app.biometric_capture_allowed(NEW.tenant_id, NEW.site_id, NEW.capture_method, today)
    THEN
      RAISE EXCEPTION 'Biometric capture is off for this site and method'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status <> 'active' OR NEW.status <> 'deleted'
     OR (NEW.id, NEW.tenant_id, NEW.labourer_id, NEW.modality, NEW.capture_method,
         NEW.consent_id, NEW.dpia_record_id, NEW.project_id, NEW.site_id, NEW.template_count,
         NEW.algorithm, NEW.algorithm_version, NEW.enrolled_by, NEW.enrolled_at)
        IS DISTINCT FROM
        (OLD.id, OLD.tenant_id, OLD.labourer_id, OLD.modality, OLD.capture_method,
         OLD.consent_id, OLD.dpia_record_id, OLD.project_id, OLD.site_id, OLD.template_count,
         OLD.algorithm, OLD.algorithm_version, OLD.enrolled_by, OLD.enrolled_at) THEN
    RAISE EXCEPTION 'An enrolment changes only when its templates are deleted, once'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM biometric_templates t
              WHERE t.tenant_id = NEW.tenant_id AND t.enrolment_id = NEW.id) THEN
    RAISE EXCEPTION 'Delete the enrolment''s templates first' USING ERRCODE = '23514';
  END IF;
  IF actor = job AND NEW.deletion_reason IS DISTINCT FROM 'engagement_ended' THEN
    RAISE EXCEPTION 'The retention job deletes only after engagements end'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.deletion_reason = 'consent_withdrawn' AND NOT EXISTS (
    SELECT 1 FROM labourer_consents c
     WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.consent_id AND c.withdrawn_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'The consent was not withdrawn' USING ERRCODE = '23514';
  END IF;
  IF NEW.deletion_reason = 'engagement_ended' THEN
    earliest := app.biometric_retention_due_on(NEW.tenant_id, NEW.labourer_id, 0);
    IF earliest IS NULL OR NEW.deletion_due_on IS NULL OR NEW.deletion_due_on > today
       OR NEW.deletion_due_on < earliest THEN
      RAISE EXCEPTION 'The worker''s templates are not due for deletion' USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.deleted_by := actor;
  NEW.deleted_at := clock_timestamp();
  RETURN NEW;
END
$$;
CREATE TRIGGER biometric_enrolment_guard BEFORE INSERT OR UPDATE OR DELETE ON "biometric_enrolments"
  FOR EACH ROW EXECUTE FUNCTION app.guard_biometric_enrolment();

-- An enrolment stores all its templates when it is made (checked at commit).
CREATE FUNCTION app.check_biometric_enrolment_templates() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.current_tenant_id() IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'Biometric changes are checked in their company''s context'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM biometric_enrolments e
              WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.id AND e.status = 'active')
     AND (SELECT count(t.id) FROM biometric_templates t
           WHERE t.tenant_id = NEW.tenant_id AND t.enrolment_id = NEW.id) <> NEW.template_count
  THEN
    RAISE EXCEPTION 'An enrolment stores all its templates when it is made'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER biometric_enrolment_templates AFTER INSERT ON "biometric_enrolments"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION app.check_biometric_enrolment_templates();

-- The deletion log row, written by the database when an enrolment is marked deleted.
CREATE FUNCTION app.log_biometric_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO biometric_deletions (id, tenant_id, enrolment_id, labourer_id, modality, reason,
    template_count, due_on, deleted_by, deleted_at)
  VALUES (gen_random_uuid(), NEW.tenant_id, NEW.id, NEW.labourer_id, NEW.modality,
    NEW.deletion_reason, NEW.template_count, NEW.deletion_due_on, NEW.deleted_by, NEW.deleted_at);
  RETURN NULL;
END
$$;
CREATE TRIGGER biometric_enrolment_deletion_log AFTER UPDATE ON "biometric_enrolments"
  FOR EACH ROW WHEN (OLD.status = 'active' AND NEW.status = 'deleted')
  EXECUTE FUNCTION app.log_biometric_deletion();

-- Templates --------------------------------------------------------------------------------------
-- Sealed envelopes (apps/api TemplateSealer): [format 2][key version][32-byte ephemeral X25519
-- public key][12-byte nonce][ciphertext][16-byte tag], for 16–16 384 bytes of template.
ALTER TABLE "biometric_templates" ADD CONSTRAINT "biometric_templates_check" CHECK (
  ordinal BETWEEN 1 AND 10
  AND octet_length(template_enc) BETWEEN 78 AND 16446
  AND get_byte(template_enc, 0) = 2
  AND key_version BETWEEN 1 AND 255
  AND key_version = get_byte(template_enc, 1)
  AND quality_score BETWEEN 0 AND 100
);

-- Templates are added only to an active enrolment, up to its template count (so only when it is
-- made: the commit check above requires all of them then). They never change, except a
-- re-sealing under another key version by the schema owner (keys:rotate, bound to the role running
-- this migration). Deleting them is allowed only together with their enrolment (checked at commit).
DO $$
BEGIN
  EXECUTE format($fn$
    CREATE FUNCTION app.guard_biometric_template() RETURNS trigger LANGUAGE plpgsql AS $body$
    DECLARE
      enrolment record;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      END IF;
      IF TG_OP = 'UPDATE' THEN
        IF current_user = %L
           AND (NEW.id, NEW.tenant_id, NEW.enrolment_id, NEW.ordinal, NEW.quality_score,
                NEW.created_at)
               IS NOT DISTINCT FROM
               (OLD.id, OLD.tenant_id, OLD.enrolment_id, OLD.ordinal, OLD.quality_score,
                OLD.created_at)
           AND NEW.key_version <> OLD.key_version THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'Biometric templates never change' USING ERRCODE = '42501';
      END IF;
      SELECT status, template_count INTO enrolment FROM biometric_enrolments
       WHERE tenant_id = NEW.tenant_id AND id = NEW.enrolment_id FOR UPDATE;
      IF NOT FOUND OR enrolment.status <> 'active' THEN
        RAISE EXCEPTION 'Templates are stored only with an active enrolment'
          USING ERRCODE = '23514';
      END IF;
      IF (SELECT count(t.id) FROM biometric_templates t
           WHERE t.tenant_id = NEW.tenant_id AND t.enrolment_id = NEW.enrolment_id)
         >= enrolment.template_count THEN
        RAISE EXCEPTION 'An enrolment''s templates are stored once, when it is made'
          USING ERRCODE = '23514';
      END IF;
      NEW.created_at := clock_timestamp();
      RETURN NEW;
    END
    $body$
  $fn$, current_user);
END
$$;
CREATE TRIGGER biometric_template_guard BEFORE INSERT OR UPDATE OR DELETE ON "biometric_templates"
  FOR EACH ROW EXECUTE FUNCTION app.guard_biometric_template();

CREATE FUNCTION app.check_biometric_template_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.current_tenant_id() IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'Biometric changes are checked in their company''s context'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM biometric_enrolments e
              WHERE e.tenant_id = OLD.tenant_id AND e.id = OLD.enrolment_id
                AND e.status = 'active') THEN
    RAISE EXCEPTION 'Templates are deleted only together with their enrolment'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER biometric_template_deleted AFTER DELETE ON "biometric_templates"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION app.check_biometric_template_deletion();

-- Deletion log -----------------------------------------------------------------------------------
ALTER TABLE "biometric_deletions" ADD CONSTRAINT "biometric_deletions_check" CHECK (
  modality IN ('face', 'fingerprint')
  AND reason IN ('consent_withdrawn', 're_enrolled', 'engagement_ended', 'dpia_withdrawn',
    'out_of_scope', 'request')
  AND template_count BETWEEN 1 AND 10
  AND (reason = 'engagement_ended') = (due_on IS NOT NULL)
);
-- Only the enrolment trigger writes it (a direct insert runs at trigger depth 1); never changed.
CREATE FUNCTION app.guard_biometric_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'The deletion log is append-only' USING ERRCODE = '42501';
  END IF;
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'The deletion log is written by the database' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER biometric_deletion_guard BEFORE INSERT OR UPDATE OR DELETE ON "biometric_deletions"
  FOR EACH ROW EXECUTE FUNCTION app.guard_biometric_deletion();

-- DPIA coverage ----------------------------------------------------------------------------------
-- When the approved DPIA is withdrawn or superseded, every active enrolment must still be covered
-- by an approved DPIA (a renewal covering its modality) at commit; otherwise its templates must
-- have been deleted in the same transaction. A lapse changes no row, so lapsed templates are kept.
CREATE FUNCTION app.check_biometric_coverage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.current_tenant_id() IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'Biometric changes are checked in their company''s context'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM biometric_enrolments e
     WHERE e.tenant_id = NEW.tenant_id AND e.status = 'active'
       AND NOT EXISTS (
         SELECT 1 FROM dpia_records d
          WHERE d.tenant_id = e.tenant_id AND d.status = 'approved'
            AND d.capture_methods && (CASE e.modality
              WHEN 'face' THEN ARRAY['face', 'terminal']
              ELSE ARRAY['fingerprint', 'terminal'] END)::varchar[])
  ) THEN
    RAISE EXCEPTION 'Templates no approved DPIA covers must be deleted' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER dpia_record_biometric_coverage AFTER UPDATE ON "dpia_records"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD.status = 'approved' AND NEW.status <> 'approved')
  EXECUTE FUNCTION app.check_biometric_coverage();

-- Retention --------------------------------------------------------------------------------------
-- The first day a worker's templates are due for deletion: p_days full days after the last day of
-- their last engagement in the company, once none is open or ends today or later; NULL while
-- engaged; today when there was never an engagement (packages/domain retentionDueOn).
CREATE FUNCTION app.biometric_retention_due_on(p_tenant uuid, p_labourer uuid, p_days integer)
  RETURNS date LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN bool_or(e.end_date IS NULL OR e.end_date >= app.nairobi_today()) THEN NULL
    ELSE COALESCE(max(e.end_date) + p_days + 1, app.nairobi_today())
  END
    FROM labour_engagements e
   WHERE e.tenant_id = p_tenant AND e.labourer_id = p_labourer
$$;

DO $$
BEGIN
  -- The retention job's scan: only the schema owner (inside app.biometric_retention_tenants, a
  -- SECURITY DEFINER function) sees which companies hold active enrolments; pmb_app never does.
  EXECUTE format('CREATE POLICY biometric_enrolments_retention_scan ON biometric_enrolments '
    'FOR SELECT USING (current_user = %L AND status = %L)', current_user, 'active');
END
$$;
-- Companies holding active enrolments (IDs only); inside a company context only that company.
CREATE FUNCTION app.biometric_retention_tenants() RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT DISTINCT e.tenant_id
    FROM public.biometric_enrolments e
   WHERE e.status = 'active'
     AND (app.current_tenant_id() IS NULL OR e.tenant_id = app.current_tenant_id())
   ORDER BY 1
$$;

-- Permissions (packages/types PERMISSIONS): biometrics.enrol, project-scoped and assignable ------
-- MERGE NOTE: these lists must stay the union of every permission added by earlier migrations (as
-- of 20261206090000_dpia_gate).
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
    'biometrics.manage', 'biometrics.approve', 'biometrics.enrol',
    'payroll.view', 'payroll.prepare', 'payroll.review', 'payroll.approve',
    'payroll.manage_rules', 'payroll.verify_rules', 'payroll.export', 'advances.request',
    'advances.approve', 'payments.view', 'payments.approve', 'payments.disburse',
    'payments.record_cash', 'payments.reverse', 'payments.manage_credentials',
    'payments.review', 'payments.initiate_test', 'procurement.requisition',
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
    'timesheets.submit', 'timesheets.approve', 'timesheets.manage_rules', 'biometrics.enrol',
    'payroll.view', 'payroll.prepare', 'payroll.review', 'advances.request', 'advances.approve',
    'procurement.requisition', 'procurement.approve', 'stores.manage', 'finance.view',
    'finance.petty_cash', 'site.diary', 'site.photos', 'quality.manage', 'safety.manage',
    'plant.manage', 'documents.manage', 'reports.view', 'portal.client', 'portal.worker'
  ]::text[]
);

-- Key rotation: keys:rotate re-seals biometric templates too (operator-held private keys).
ALTER TABLE "key_rotation_runs" DROP CONSTRAINT "key_rotation_runs_state_check";
ALTER TABLE "key_rotation_runs" ADD CONSTRAINT "key_rotation_runs_state_check" CHECK (
  kind IN ('field', 'mfa', 'biometric')
  AND target_version BETWEEN 1 AND 255
  AND char_length(btrim(operator)) BETWEEN 2 AND 100
  AND status IN ('running', 'completed', 'completed_with_errors', 'failed')
  AND rows_checked >= 0 AND rows_rewrapped >= 0 AND rows_failed >= 0
  AND (status = 'running') = (finished_at IS NULL)
);

-- Row-level security -----------------------------------------------------------------------------
DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['biometric_enrolments', 'biometric_templates',
    'biometric_deletions']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = app.current_tenant_id()) '
      'WITH CHECK (tenant_id = app.current_tenant_id())', target || '_isolation', target);
  END LOOP;
END
$$;

-- The runtime role: enrolments are inserted and marked deleted, never deleted; templates are
-- inserted and deleted, never changed, and template_enc is never readable (column privileges: the
-- API has nothing to decrypt it with either); the deletion log is only inserted (by the trigger).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmb_app') THEN
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON "biometric_enrolments" FROM pmb_app;
    REVOKE SELECT, UPDATE, TRUNCATE, REFERENCES, TRIGGER ON "biometric_templates" FROM pmb_app;
    GRANT SELECT ("id", "tenant_id", "enrolment_id", "ordinal", "quality_score", "key_version",
      "created_at") ON "biometric_templates" TO pmb_app;
    REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "biometric_deletions" FROM pmb_app;
    GRANT EXECUTE ON FUNCTION app.biometric_retention_due_on(uuid, uuid, integer) TO pmb_app;
    GRANT EXECUTE ON FUNCTION app.biometric_retention_tenants() TO pmb_app;
  END IF;
END
$$;
REVOKE EXECUTE ON FUNCTION app.guard_biometric_consent() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_biometric_consent_withdrawal() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_biometric_enrolment() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_biometric_enrolment_templates() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.log_biometric_deletion() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_biometric_template() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_biometric_template_deletion() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_biometric_deletion() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.check_biometric_coverage() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.biometric_retention_due_on(uuid, uuid, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.biometric_retention_tenants() FROM PUBLIC;

COMMIT;
