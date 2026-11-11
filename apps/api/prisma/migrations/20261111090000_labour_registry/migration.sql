-- D3.1 Labour registry (ARCHITECTURE §4.2, ERD §6; brief §5.4, §6, §7).
-- * trades, skill_levels and labour_settings: company configuration (EN/SW names, NCA categories,
--   the NCA expiry alert lead time).
-- * labourers: identifiers are stored only as AES-256-GCM ciphertext (`*_enc`, format byte 1 and a
--   key-version byte first) plus keyed HMAC blind indexes (`*_bidx`); the API encrypts, the database
--   refuses anything that is not in the ciphertext envelope. `registered_on` is set here from the
--   Africa/Nairobi clock and nobody under 18 on that date can be stored (CHECK). A deferred
--   constraint trigger refuses to commit a labourer without a granted consent record.
-- * labour_engagements (labourer on a project), labourer_consents (versioned notice, language,
--   method, withdrawal), labourer_accreditations (NCA cards), do_not_rehire_events (append-only,
--   encrypted reasons and overrides), labour_rates (effective-dated, never updated), gangs and
--   gang_memberships (join/leave history) and labour_saved_views (per user).
-- * The catalogue gains labour.do_not_rehire and labour.consent (custom roles and assignments).
-- Every new table has tenant_id, forced RLS with WITH CHECK, composite (tenant_id, …) foreign keys,
-- and no TRUNCATE/REFERENCES/TRIGGER for pmb_app; history tables lose UPDATE/DELETE.
BEGIN;

-- CreateTable
CREATE TABLE "trades" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" VARCHAR(40) NOT NULL,
    "name_en" VARCHAR(80) NOT NULL,
    "name_sw" VARCHAR(80) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_levels" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" VARCHAR(40) NOT NULL,
    "name_en" VARCHAR(80) NOT NULL,
    "name_sw" VARCHAR(80) NOT NULL,
    "nca_category" VARCHAR(20) NOT NULL,
    "accreditation_expected" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "labour_settings" (
    "tenant_id" UUID NOT NULL,
    "accreditation_alert_days" INTEGER NOT NULL DEFAULT 30,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "labour_settings_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "labourers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "worker_no" VARCHAR(20) NOT NULL,
    "full_name" VARCHAR(150) NOT NULL,
    "date_of_birth" DATE NOT NULL,
    "gender" VARCHAR(20) NOT NULL,
    "home_county" VARCHAR(30),
    "trade_id" UUID NOT NULL,
    "skill_level_id" UUID NOT NULL,
    "engagement_type" VARCHAR(20) NOT NULL,
    "rate_basis" VARCHAR(10) NOT NULL DEFAULT 'daily',
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "id_type" VARCHAR(20) NOT NULL,
    "id_number_enc" BYTEA NOT NULL,
    "id_number_bidx" CHAR(64) NOT NULL,
    "phone_enc" BYTEA,
    "phone_bidx" CHAR(64),
    "kra_pin_enc" BYTEA,
    "kra_pin_bidx" CHAR(64),
    "nssf_number_enc" BYTEA,
    "sha_number_enc" BYTEA,
    "next_of_kin_enc" BYTEA,
    "registered_on" DATE NOT NULL,
    "do_not_rehire" BOOLEAN NOT NULL DEFAULT false,
    "do_not_rehire_at" TIMESTAMPTZ,
    "do_not_rehire_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "labourers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "labour_engagements" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "labourer_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "end_reason" VARCHAR(500),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_by" UUID,
    "ended_at" TIMESTAMPTZ,

    CONSTRAINT "labour_engagements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "labourer_consents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "labourer_id" UUID NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "notice_version" VARCHAR(60) NOT NULL,
    "notice_digest" CHAR(64) NOT NULL,
    "language" VARCHAR(5) NOT NULL,
    "method" VARCHAR(20) NOT NULL,
    "witness_name" VARCHAR(120),
    "granted" BOOLEAN NOT NULL,
    "captured_by" UUID NOT NULL,
    "captured_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawn_at" TIMESTAMPTZ,
    "withdrawn_by" UUID,
    "withdrawal_method" VARCHAR(20),
    "withdrawal_witness" VARCHAR(120),

    CONSTRAINT "labourer_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "labourer_accreditations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "labourer_id" UUID NOT NULL,
    "category" VARCHAR(30) NOT NULL,
    "card_number" VARCHAR(40) NOT NULL,
    "issued_on" DATE,
    "expires_on" DATE NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "labourer_accreditations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "do_not_rehire_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "labourer_id" UUID NOT NULL,
    "action" VARCHAR(10) NOT NULL,
    "context" VARCHAR(20),
    "project_id" UUID,
    "related_labourer_id" UUID,
    "reason_enc" BYTEA NOT NULL,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "do_not_rehire_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "labour_rates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID,
    "labourer_id" UUID,
    "trade_id" UUID,
    "skill_level_id" UUID,
    "basis" VARCHAR(10) NOT NULL,
    "rate_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'KES',
    "effective_from" DATE NOT NULL,
    "scope_key" VARCHAR(200) NOT NULL DEFAULT '',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "labour_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gangs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "site_id" UUID,
    "name" VARCHAR(80) NOT NULL,
    "leader_labourer_id" UUID,
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gangs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gang_memberships" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "gang_id" UUID NOT NULL,
    "labourer_id" UUID NOT NULL,
    "joined_on" DATE NOT NULL,
    "left_on" DATE,
    "added_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_by" UUID,

    CONSTRAINT "gang_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "labour_saved_views" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "labour_saved_views_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trades_tenant_id_id_key" ON "trades"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "trades_tenant_id_key_key" ON "trades"("tenant_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "skill_levels_tenant_id_id_key" ON "skill_levels"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "skill_levels_tenant_id_key_key" ON "skill_levels"("tenant_id", "key");

-- CreateIndex
CREATE INDEX "labourers_tenant_id_phone_bidx_idx" ON "labourers"("tenant_id", "phone_bidx");

-- CreateIndex
CREATE INDEX "labourers_tenant_id_status_idx" ON "labourers"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "labourers_tenant_id_id_key" ON "labourers"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "labourers_tenant_id_worker_no_key" ON "labourers"("tenant_id", "worker_no");

-- CreateIndex
CREATE UNIQUE INDEX "labourers_tenant_id_id_number_bidx_key" ON "labourers"("tenant_id", "id_number_bidx");

-- CreateIndex
CREATE UNIQUE INDEX "labourers_tenant_id_kra_pin_bidx_key" ON "labourers"("tenant_id", "kra_pin_bidx");

-- CreateIndex
CREATE INDEX "labour_engagements_tenant_id_labourer_id_idx" ON "labour_engagements"("tenant_id", "labourer_id");

-- CreateIndex
CREATE INDEX "labour_engagements_tenant_id_project_id_idx" ON "labour_engagements"("tenant_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "labour_engagements_tenant_id_id_key" ON "labour_engagements"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "labourer_consents_tenant_id_labourer_id_captured_at_idx" ON "labourer_consents"("tenant_id", "labourer_id", "captured_at");

-- CreateIndex
CREATE UNIQUE INDEX "labourer_consents_tenant_id_id_key" ON "labourer_consents"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "labourer_accreditations_tenant_id_labourer_id_idx" ON "labourer_accreditations"("tenant_id", "labourer_id");

-- CreateIndex
CREATE INDEX "labourer_accreditations_tenant_id_expires_on_idx" ON "labourer_accreditations"("tenant_id", "expires_on");

-- CreateIndex
CREATE UNIQUE INDEX "labourer_accreditations_tenant_id_id_key" ON "labourer_accreditations"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "do_not_rehire_events_tenant_id_labourer_id_created_at_idx" ON "do_not_rehire_events"("tenant_id", "labourer_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "do_not_rehire_events_tenant_id_id_key" ON "do_not_rehire_events"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "labour_rates_tenant_id_trade_id_idx" ON "labour_rates"("tenant_id", "trade_id");

-- CreateIndex
CREATE INDEX "labour_rates_tenant_id_labourer_id_idx" ON "labour_rates"("tenant_id", "labourer_id");

-- CreateIndex
CREATE UNIQUE INDEX "labour_rates_tenant_id_id_key" ON "labour_rates"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "labour_rates_tenant_id_scope_key_effective_from_key" ON "labour_rates"("tenant_id", "scope_key", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "gangs_tenant_id_id_key" ON "gangs"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "gangs_tenant_id_project_id_id_key" ON "gangs"("tenant_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "gangs_tenant_id_project_id_name_key" ON "gangs"("tenant_id", "project_id", "name");

-- CreateIndex
CREATE INDEX "gang_memberships_tenant_id_gang_id_idx" ON "gang_memberships"("tenant_id", "gang_id");

-- CreateIndex
CREATE INDEX "gang_memberships_tenant_id_labourer_id_idx" ON "gang_memberships"("tenant_id", "labourer_id");

-- CreateIndex
CREATE UNIQUE INDEX "gang_memberships_tenant_id_id_key" ON "gang_memberships"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "labour_saved_views_tenant_id_user_id_name_key" ON "labour_saved_views"("tenant_id", "user_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "sites_tenant_id_project_id_id_key" ON "sites"("tenant_id", "project_id", "id");

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_levels" ADD CONSTRAINT "skill_levels_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "labour_settings" ADD CONSTRAINT "labour_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "labourers" ADD CONSTRAINT "labourers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "labourers" ADD CONSTRAINT "labourers_tenant_id_trade_id_fkey" FOREIGN KEY ("tenant_id", "trade_id") REFERENCES "trades"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "labourers" ADD CONSTRAINT "labourers_tenant_id_skill_level_id_fkey" FOREIGN KEY ("tenant_id", "skill_level_id") REFERENCES "skill_levels"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "labour_engagements" ADD CONSTRAINT "labour_engagements_tenant_id_labourer_id_fkey" FOREIGN KEY ("tenant_id", "labourer_id") REFERENCES "labourers"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "labour_engagements" ADD CONSTRAINT "labour_engagements_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "labourer_consents" ADD CONSTRAINT "labourer_consents_tenant_id_labourer_id_fkey" FOREIGN KEY ("tenant_id", "labourer_id") REFERENCES "labourers"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "labourer_accreditations" ADD CONSTRAINT "labourer_accreditations_tenant_id_labourer_id_fkey" FOREIGN KEY ("tenant_id", "labourer_id") REFERENCES "labourers"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "do_not_rehire_events" ADD CONSTRAINT "do_not_rehire_events_tenant_id_labourer_id_fkey" FOREIGN KEY ("tenant_id", "labourer_id") REFERENCES "labourers"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "do_not_rehire_events" ADD CONSTRAINT "do_not_rehire_events_tenant_id_related_labourer_id_fkey" FOREIGN KEY ("tenant_id", "related_labourer_id") REFERENCES "labourers"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "do_not_rehire_events" ADD CONSTRAINT "do_not_rehire_events_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "labour_rates" ADD CONSTRAINT "labour_rates_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "labour_rates" ADD CONSTRAINT "labour_rates_tenant_id_labourer_id_fkey" FOREIGN KEY ("tenant_id", "labourer_id") REFERENCES "labourers"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "labour_rates" ADD CONSTRAINT "labour_rates_tenant_id_trade_id_fkey" FOREIGN KEY ("tenant_id", "trade_id") REFERENCES "trades"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "labour_rates" ADD CONSTRAINT "labour_rates_tenant_id_skill_level_id_fkey" FOREIGN KEY ("tenant_id", "skill_level_id") REFERENCES "skill_levels"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gangs" ADD CONSTRAINT "gangs_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gangs" ADD CONSTRAINT "gangs_tenant_id_project_id_site_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "site_id") REFERENCES "sites"("tenant_id", "project_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gangs" ADD CONSTRAINT "gangs_tenant_id_leader_labourer_id_fkey" FOREIGN KEY ("tenant_id", "leader_labourer_id") REFERENCES "labourers"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gang_memberships" ADD CONSTRAINT "gang_memberships_tenant_id_project_id_gang_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "gang_id") REFERENCES "gangs"("tenant_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gang_memberships" ADD CONSTRAINT "gang_memberships_tenant_id_labourer_id_fkey" FOREIGN KEY ("tenant_id", "labourer_id") REFERENCES "labourers"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "labour_saved_views" ADD CONSTRAINT "labour_saved_views_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "memberships"("tenant_id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Field ciphertext envelope (apps/api FieldCipher): format byte 1, key version 1–255, a 12-byte
-- nonce, at least one byte of ciphertext and a 16-byte GCM tag. Plaintext written by mistake fails.
CREATE FUNCTION app.is_field_ciphertext(value bytea) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT value IS NULL OR (
    octet_length(value) >= 31 AND get_byte(value, 0) = 1 AND get_byte(value, 1) >= 1
  ) $$;

-- Configuration ----------------------------------------------------------------------------------
ALTER TABLE "trades" ADD CONSTRAINT "trades_key_check" CHECK (key ~ '^[a-z][a-z0-9_]{1,39}$');
ALTER TABLE "trades" ADD CONSTRAINT "trades_names_check" CHECK (
  char_length(name_en) >= 1 AND name_en = btrim(name_en)
  AND char_length(name_sw) >= 1 AND name_sw = btrim(name_sw)
);
ALTER TABLE "trades" ADD CONSTRAINT "trades_order_version_check" CHECK (sort_order >= 0 AND version >= 1);

ALTER TABLE "skill_levels" ADD CONSTRAINT "skill_levels_key_check" CHECK (key ~ '^[a-z][a-z0-9_]{1,39}$');
ALTER TABLE "skill_levels" ADD CONSTRAINT "skill_levels_names_check" CHECK (
  char_length(name_en) >= 1 AND name_en = btrim(name_en)
  AND char_length(name_sw) >= 1 AND name_sw = btrim(name_sw)
);
-- packages/types NCA_CATEGORIES (COMPLIANCE-REVIEW: CR-NCA-03)
ALTER TABLE "skill_levels" ADD CONSTRAINT "skill_levels_nca_category_check" CHECK (
  nca_category IN ('skilled', 'semi_skilled', 'unskilled', 'supervisor')
);
ALTER TABLE "skill_levels" ADD CONSTRAINT "skill_levels_order_version_check" CHECK (
  sort_order >= 0 AND version >= 1
);

-- packages/types ACCREDITATION_ALERT_DAYS_LIMITS (`labour.accreditation_alert_days`)
ALTER TABLE "labour_settings" ADD CONSTRAINT "labour_settings_alert_days_check" CHECK (
  accreditation_alert_days BETWEEN 1 AND 365
);
ALTER TABLE "labour_settings" ADD CONSTRAINT "labour_settings_version_check" CHECK (version >= 1);

-- Labourers --------------------------------------------------------------------------------------
ALTER TABLE "labourers" ADD CONSTRAINT "labourers_worker_no_check" CHECK (worker_no ~ '^WRK-[0-9]{4,15}$');
ALTER TABLE "labourers" ADD CONSTRAINT "labourers_full_name_check" CHECK (
  char_length(full_name) >= 3 AND full_name = btrim(full_name)
);
-- packages/types GENDERS, ENGAGEMENT_TYPES, RATE_BASES, LABOURER_STATUSES, ID_DOCUMENT_TYPES
ALTER TABLE "labourers" ADD CONSTRAINT "labourers_vocabulary_check" CHECK (
  gender IN ('female', 'male', 'intersex', 'undisclosed')
  AND engagement_type IN ('casual', 'term', 'piece_rate')
  AND rate_basis IN ('daily', 'hourly')
  AND status IN ('active', 'inactive', 'left')
  AND id_type IN ('national_id', 'alien_id', 'passport')
);
-- packages/types KENYA_COUNTIES
ALTER TABLE "labourers" ADD CONSTRAINT "labourers_home_county_check" CHECK (
  home_county IS NULL OR home_county IN (
    'mombasa', 'kwale', 'kilifi', 'tana-river', 'lamu', 'taita-taveta', 'garissa', 'wajir',
    'mandera', 'marsabit', 'isiolo', 'meru', 'tharaka-nithi', 'embu', 'kitui', 'machakos',
    'makueni', 'nyandarua', 'nyeri', 'kirinyaga', 'muranga', 'kiambu', 'turkana', 'west-pokot',
    'samburu', 'trans-nzoia', 'uasin-gishu', 'elgeyo-marakwet', 'nandi', 'baringo', 'laikipia',
    'nakuru', 'narok', 'kajiado', 'kericho', 'bomet', 'kakamega', 'vihiga', 'bungoma', 'busia',
    'siaya', 'kisumu', 'homa-bay', 'migori', 'kisii', 'nyamira', 'nairobi'
  )
);
-- Identifiers exist only as ciphertext envelopes with matching HMAC-SHA-256 blind indexes.
ALTER TABLE "labourers" ADD CONSTRAINT "labourers_ciphertext_check" CHECK (
  app.is_field_ciphertext(id_number_enc) AND app.is_field_ciphertext(phone_enc)
  AND app.is_field_ciphertext(kra_pin_enc) AND app.is_field_ciphertext(nssf_number_enc)
  AND app.is_field_ciphertext(sha_number_enc) AND app.is_field_ciphertext(next_of_kin_enc)
);
ALTER TABLE "labourers" ADD CONSTRAINT "labourers_blind_index_check" CHECK (
  id_number_bidx ~ '^[0-9a-f]{64}$'
  AND (phone_bidx IS NULL OR phone_bidx ~ '^[0-9a-f]{64}$')
  AND (kra_pin_bidx IS NULL OR kra_pin_bidx ~ '^[0-9a-f]{64}$')
  AND (phone_enc IS NULL) = (phone_bidx IS NULL)
  AND (kra_pin_enc IS NULL) = (kra_pin_bidx IS NULL)
);
-- Brief §6: nobody under 18 on the registration date (packages/types MINIMUM_LABOURER_AGE_YEARS;
-- packages/domain latestAllowedBirthDate uses the same calendar rule). COMPLIANCE-REVIEW: CR-DP-10.
ALTER TABLE "labourers" ADD CONSTRAINT "labourers_minimum_age_check" CHECK (
  date_of_birth >= DATE '1900-01-01'
  AND date_of_birth <= (registered_on - interval '18 years')::date
);
ALTER TABLE "labourers" ADD CONSTRAINT "labourers_do_not_rehire_check" CHECK (
  (do_not_rehire AND do_not_rehire_at IS NOT NULL AND do_not_rehire_by IS NOT NULL)
  OR (NOT do_not_rehire AND do_not_rehire_at IS NULL AND do_not_rehire_by IS NULL)
);
ALTER TABLE "labourers" ADD CONSTRAINT "labourers_version_check" CHECK (version >= 1);

-- The registration date comes from the database clock (Africa/Nairobi), never from the client, and
-- identity columns never change. A do-not-rehire change, or reactivating a flagged labourer, needs
-- the matching event written in the same transaction (do_not_rehire_events.created_at = now()).
CREATE FUNCTION app.guard_labourer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.registered_on := (now() AT TIME ZONE 'Africa/Nairobi')::date;
    IF NEW.do_not_rehire THEN
      RAISE EXCEPTION 'A labourer is registered without a do-not-rehire flag' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.worker_no IS DISTINCT FROM OLD.worker_no
     OR NEW.registered_on IS DISTINCT FROM OLD.registered_on
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Labourer identity columns cannot change' USING ERRCODE = '23514';
  END IF;
  IF NEW.do_not_rehire IS DISTINCT FROM OLD.do_not_rehire AND NOT EXISTS (
    SELECT 1 FROM do_not_rehire_events e
    WHERE e.tenant_id = NEW.tenant_id AND e.labourer_id = NEW.id AND e.created_at = now()
      AND e.action = CASE WHEN NEW.do_not_rehire THEN 'set' ELSE 'clear' END
  ) THEN
    RAISE EXCEPTION 'A do-not-rehire change needs a recorded reason' USING ERRCODE = '23514';
  END IF;
  IF NEW.do_not_rehire AND OLD.status <> 'active' AND NEW.status = 'active' AND NOT EXISTS (
    SELECT 1 FROM do_not_rehire_events e
    WHERE e.tenant_id = NEW.tenant_id AND e.labourer_id = NEW.id AND e.created_at = now()
      AND e.action = 'override'
  ) THEN
    RAISE EXCEPTION 'Reactivating a do-not-rehire labourer needs a recorded override'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER labourer_guard BEFORE INSERT OR UPDATE ON "labourers"
  FOR EACH ROW EXECUTE FUNCTION app.guard_labourer();

-- Personal data is registered only with consent: a labourer cannot be committed without a granted
-- registration-data consent record (checked at commit, so both rows go in one transaction).
CREATE FUNCTION app.require_labourer_consent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM labourer_consents c
    WHERE c.tenant_id = NEW.tenant_id AND c.labourer_id = NEW.id
      AND c.kind = 'registration_data' AND c.granted
  ) THEN
    RAISE EXCEPTION 'A labourer needs a recorded consent' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER labourer_consent_required AFTER INSERT ON "labourers"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.require_labourer_consent();

-- Engagements ------------------------------------------------------------------------------------
ALTER TABLE "labour_engagements" ADD CONSTRAINT "labour_engagements_dates_check" CHECK (
  end_date IS NULL OR end_date >= start_date
);
ALTER TABLE "labour_engagements" ADD CONSTRAINT "labour_engagements_end_check" CHECK (
  (end_date IS NULL AND ended_by IS NULL AND ended_at IS NULL AND end_reason IS NULL)
  OR (end_date IS NOT NULL AND ended_by IS NOT NULL AND ended_at IS NOT NULL)
);
ALTER TABLE "labour_engagements" ADD CONSTRAINT "labour_engagements_reason_check" CHECK (
  end_reason IS NULL OR char_length(btrim(end_reason)) BETWEEN 3 AND 500
);

-- The labourer row lock serialises engagements of one labourer. An engagement needs an active
-- labourer who is 18 on the start date, has a granted consent that is not withdrawn, has no other
-- open engagement on the project and, if flagged do-not-rehire, an override recorded in the same
-- transaction for this project. Only the end can be recorded later, once.
CREATE FUNCTION app.guard_engagement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  worker record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.labourer_id IS DISTINCT FROM OLD.labourer_id
       OR NEW.project_id IS DISTINCT FROM OLD.project_id
       OR NEW.start_date IS DISTINCT FROM OLD.start_date
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR OLD.end_date IS NOT NULL THEN
      RAISE EXCEPTION 'Only the end of an open engagement can be recorded' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT date_of_birth, status, do_not_rehire INTO worker FROM labourers
    WHERE tenant_id = NEW.tenant_id AND id = NEW.labourer_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown labourer' USING ERRCODE = '23503';
  END IF;
  IF worker.status <> 'active' THEN
    RAISE EXCEPTION 'Only an active labourer can be engaged' USING ERRCODE = '23514';
  END IF;
  IF worker.date_of_birth > (NEW.start_date - interval '18 years')::date THEN
    RAISE EXCEPTION 'A labourer must be 18 on the engagement start date' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM labourer_consents c
    WHERE c.tenant_id = NEW.tenant_id AND c.labourer_id = NEW.labourer_id
      AND c.kind = 'registration_data' AND c.granted AND c.withdrawn_at IS NULL
  ) THEN
    RAISE EXCEPTION 'An engagement needs consent that has not been withdrawn' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM labour_engagements e
    WHERE e.tenant_id = NEW.tenant_id AND e.labourer_id = NEW.labourer_id
      AND e.project_id = NEW.project_id AND e.end_date IS NULL
  ) THEN
    RAISE EXCEPTION 'The labourer is already engaged on this project' USING ERRCODE = '23505';
  END IF;
  IF worker.do_not_rehire AND NOT EXISTS (
    SELECT 1 FROM do_not_rehire_events d
    WHERE d.tenant_id = NEW.tenant_id AND d.labourer_id = NEW.labourer_id
      AND d.action = 'override' AND d.project_id = NEW.project_id AND d.created_at = now()
  ) THEN
    RAISE EXCEPTION 'Engaging a do-not-rehire labourer needs a recorded override'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER labour_engagement_guard BEFORE INSERT OR UPDATE ON "labour_engagements"
  FOR EACH ROW EXECUTE FUNCTION app.guard_engagement();

-- Consent ----------------------------------------------------------------------------------------
-- packages/types CONSENT_KINDS: biometric kinds are added in D3.4 with their own notice and gate.
ALTER TABLE "labourer_consents" ADD CONSTRAINT "labourer_consents_kind_check" CHECK (
  kind IN ('registration_data')
);
ALTER TABLE "labourer_consents" ADD CONSTRAINT "labourer_consents_notice_check" CHECK (
  notice_version ~ '^[a-z0-9][a-z0-9-]{2,59}$' AND notice_digest ~ '^[0-9a-f]{64}$'
  AND language IN ('en', 'sw')
);
ALTER TABLE "labourer_consents" ADD CONSTRAINT "labourer_consents_method_check" CHECK (
  method IN ('signed', 'witnessed_verbal')
  AND (method <> 'witnessed_verbal' OR char_length(btrim(witness_name)) >= 3)
);
ALTER TABLE "labourer_consents" ADD CONSTRAINT "labourer_consents_withdrawal_check" CHECK (
  (withdrawn_at IS NULL AND withdrawn_by IS NULL AND withdrawal_method IS NULL
    AND withdrawal_witness IS NULL)
  OR (withdrawn_at IS NOT NULL AND withdrawn_by IS NOT NULL
    AND withdrawal_method IN ('signed', 'witnessed_verbal')
    AND (withdrawal_method <> 'witnessed_verbal' OR char_length(btrim(withdrawal_witness)) >= 3))
);

-- A consent record is evidence: never deleted (except with its labourer) and changed only to record
-- one withdrawal.
CREATE FUNCTION app.guard_consent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Consent records are kept' USING ERRCODE = '42501';
  END IF;
  IF OLD.withdrawn_at IS NOT NULL OR NEW.withdrawn_at IS NULL
     OR (NEW.id, NEW.tenant_id, NEW.labourer_id, NEW.kind, NEW.notice_version, NEW.notice_digest,
         NEW.language, NEW.method, NEW.witness_name, NEW.granted, NEW.captured_by, NEW.captured_at)
        IS DISTINCT FROM
        (OLD.id, OLD.tenant_id, OLD.labourer_id, OLD.kind, OLD.notice_version, OLD.notice_digest,
         OLD.language, OLD.method, OLD.witness_name, OLD.granted, OLD.captured_by, OLD.captured_at)
  THEN
    RAISE EXCEPTION 'A consent record can only be withdrawn, once' USING ERRCODE = '23514';
  END IF;
  NEW.withdrawn_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER labourer_consent_guard BEFORE UPDATE OR DELETE ON "labourer_consents"
  FOR EACH ROW EXECUTE FUNCTION app.guard_consent();
-- Capture time comes from the database clock.
CREATE FUNCTION app.stamp_captured_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.captured_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER labourer_consents_stamp BEFORE INSERT ON "labourer_consents"
  FOR EACH ROW EXECUTE FUNCTION app.stamp_captured_at();

-- Accreditation ----------------------------------------------------------------------------------
-- packages/types ACCREDITATION_CATEGORIES (COMPLIANCE-REVIEW: CR-NCA-03)
ALTER TABLE "labourer_accreditations" ADD CONSTRAINT "labourer_accreditations_category_check" CHECK (
  category IN ('nca_skilled_worker', 'nca_site_supervisor')
);
ALTER TABLE "labourer_accreditations" ADD CONSTRAINT "labourer_accreditations_card_check" CHECK (
  card_number ~ '^[A-Z0-9][A-Z0-9/-]{2,39}$'
);
ALTER TABLE "labourer_accreditations" ADD CONSTRAINT "labourer_accreditations_dates_check" CHECK (
  issued_on IS NULL OR expires_on >= issued_on
);
ALTER TABLE "labourer_accreditations" ADD CONSTRAINT "labourer_accreditations_version_check" CHECK (
  version >= 1
);

-- Do-not-rehire history --------------------------------------------------------------------------
ALTER TABLE "do_not_rehire_events" ADD CONSTRAINT "do_not_rehire_events_action_check" CHECK (
  (action IN ('set', 'clear') AND context IS NULL AND related_labourer_id IS NULL)
  OR (action = 'override' AND context IN ('registration', 'engagement', 'reactivation'))
);
ALTER TABLE "do_not_rehire_events" ADD CONSTRAINT "do_not_rehire_events_reason_check" CHECK (
  reason_enc IS NOT NULL AND app.is_field_ciphertext(reason_enc)
);
CREATE TRIGGER do_not_rehire_events_append_only BEFORE UPDATE OR DELETE ON "do_not_rehire_events"
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
-- The database clock stamps history rows: evidence times never come from the client, and the
-- "recorded in the same transaction" checks above compare created_at with now().
CREATE FUNCTION app.stamp_created_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.created_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER do_not_rehire_events_stamp BEFORE INSERT ON "do_not_rehire_events"
  FOR EACH ROW EXECUTE FUNCTION app.stamp_created_at();

-- Rates ------------------------------------------------------------------------------------------
ALTER TABLE "labour_rates" ADD CONSTRAINT "labour_rates_amount_check" CHECK (
  basis IN ('daily', 'hourly') AND rate_minor BETWEEN 1 AND 1000000000 AND currency = 'KES'
);
-- A company or project rate is for a trade (optionally a skill level); a labourer's own rate is for
-- one project and has neither.
ALTER TABLE "labour_rates" ADD CONSTRAINT "labour_rates_scope_check" CHECK (
  (labourer_id IS NOT NULL AND project_id IS NOT NULL AND trade_id IS NULL AND skill_level_id IS NULL)
  OR (labourer_id IS NULL AND trade_id IS NOT NULL)
);

-- Rates are effective-dated history (brief §11, §15 C): the database derives scope_key (the same
-- key as packages/domain rateKey) and refuses a start date before today in Africa/Nairobi, so a day
-- that may already have been worked keeps its rate. Rows are never updated; a rate that has not
-- started yet can be deleted (cancelled).
CREATE FUNCTION app.guard_labour_rate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.scope_key := concat_ws('|',
      COALESCE(NEW.project_id::text, '-'), COALESCE(NEW.labourer_id::text, '-'),
      COALESCE(NEW.trade_id::text, '-'), COALESCE(NEW.skill_level_id::text, '-'), NEW.basis);
    IF NEW.effective_from < (now() AT TIME ZONE 'Africa/Nairobi')::date THEN
      RAISE EXCEPTION 'A new rate cannot start before today' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 OR OLD.effective_from > (now() AT TIME ZONE 'Africa/Nairobi')::date THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'A rate that has come into force cannot be deleted' USING ERRCODE = '42501';
  END IF;
  RAISE EXCEPTION 'Rates are never changed in place; add a new effective-dated rate'
    USING ERRCODE = '42501';
END
$$;
CREATE TRIGGER labour_rate_guard BEFORE INSERT OR UPDATE OR DELETE ON "labour_rates"
  FOR EACH ROW EXECUTE FUNCTION app.guard_labour_rate();

-- Gangs ------------------------------------------------------------------------------------------
ALTER TABLE "gangs" ADD CONSTRAINT "gangs_name_check" CHECK (
  char_length(name) >= 2 AND name = btrim(name)
);
ALTER TABLE "gangs" ADD CONSTRAINT "gangs_status_check" CHECK (status IN ('active', 'archived'));
ALTER TABLE "gangs" ADD CONSTRAINT "gangs_version_check" CHECK (version >= 1);

-- A gang's leader is one of its current members.
CREATE FUNCTION app.guard_gang() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.leader_labourer_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM gang_memberships m
    WHERE m.tenant_id = NEW.tenant_id AND m.gang_id = NEW.id
      AND m.labourer_id = NEW.leader_labourer_id AND m.left_on IS NULL
  ) THEN
    RAISE EXCEPTION 'The gang leader must be a current member' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER gang_guard BEFORE INSERT OR UPDATE OF "leader_labourer_id" ON "gangs"
  FOR EACH ROW EXECUTE FUNCTION app.guard_gang();

ALTER TABLE "gang_memberships" ADD CONSTRAINT "gang_memberships_dates_check" CHECK (
  left_on IS NULL OR left_on >= joined_on
);
ALTER TABLE "gang_memberships" ADD CONSTRAINT "gang_memberships_removed_check" CHECK (
  (left_on IS NULL) = (removed_by IS NULL)
);

-- One open gang per labourer and project; the labourer must be engaged on the project on the join
-- date; an active gang only; the leader cannot leave while leading. Leaving is recorded once.
CREATE FUNCTION app.guard_gang_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.gang_id IS DISTINCT FROM OLD.gang_id
       OR NEW.labourer_id IS DISTINCT FROM OLD.labourer_id
       OR NEW.joined_on IS DISTINCT FROM OLD.joined_on
       OR NEW.added_by IS DISTINCT FROM OLD.added_by OR OLD.left_on IS NOT NULL THEN
      RAISE EXCEPTION 'Only leaving a gang can be recorded' USING ERRCODE = '23514';
    END IF;
    IF NEW.left_on IS NOT NULL AND EXISTS (
      SELECT 1 FROM gangs g
      WHERE g.tenant_id = NEW.tenant_id AND g.id = NEW.gang_id
        AND g.leader_labourer_id = NEW.labourer_id
    ) THEN
      RAISE EXCEPTION 'Choose another gang leader first' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM 1 FROM labourers WHERE tenant_id = NEW.tenant_id AND id = NEW.labourer_id FOR UPDATE;
  IF NOT EXISTS (
    SELECT 1 FROM gangs g
    WHERE g.tenant_id = NEW.tenant_id AND g.id = NEW.gang_id AND g.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Members join active gangs only' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM labour_engagements e
    WHERE e.tenant_id = NEW.tenant_id AND e.labourer_id = NEW.labourer_id
      AND e.project_id = NEW.project_id AND e.start_date <= NEW.joined_on
      AND (e.end_date IS NULL OR e.end_date >= NEW.joined_on)
  ) THEN
    RAISE EXCEPTION 'A gang member must be engaged on the project' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM gang_memberships m
    WHERE m.tenant_id = NEW.tenant_id AND m.project_id = NEW.project_id
      AND m.labourer_id = NEW.labourer_id AND m.left_on IS NULL
  ) THEN
    RAISE EXCEPTION 'The labourer is already in a gang on this project' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER gang_membership_guard BEFORE INSERT OR UPDATE ON "gang_memberships"
  FOR EACH ROW EXECUTE FUNCTION app.guard_gang_membership();

-- Saved views ------------------------------------------------------------------------------------
-- A saved view stores structured filters only: never search text, which could hold an ID, phone
-- or KRA PIN in plaintext (identifiers are looked up through blind indexes instead).
ALTER TABLE "labour_saved_views" ADD CONSTRAINT "labour_saved_views_check" CHECK (
  char_length(name) >= 2 AND name = btrim(name) AND jsonb_typeof(filters) = 'object'
  AND NOT (filters ? 'search')
);

-- The catalogue gains labour.do_not_rehire and labour.consent (packages/types PERMISSIONS and
-- PROJECT_ASSIGNABLE_PERMISSIONS). Existing rows keep their values; both constraints only widen.
ALTER TABLE "tenant_roles" DROP CONSTRAINT "tenant_roles_permissions_check";
ALTER TABLE "tenant_roles" ADD CONSTRAINT "tenant_roles_permissions_check" CHECK (
  permissions IS NOT NULL
  AND cardinality(permissions) >= 1
  AND permissions <@ ARRAY[
    'tenancy.manage', 'users.invite', 'roles.manage', 'audit.view', 'config.manage',
    'config.manage_statutory', 'projects.view', 'projects.create', 'projects.manage', 'bq.view',
    'bq.edit', 'bq.import', 'bq.approve_variation', 'labour.view', 'labour.manage',
    'labour.view_sensitive', 'labour.do_not_rehire', 'labour.consent', 'attendance.view',
    'attendance.record', 'attendance.override', 'attendance.review_anomalies', 'payroll.prepare',
    'payroll.review', 'payroll.approve', 'payments.view', 'payments.approve', 'payments.disburse',
    'payments.record_cash', 'payments.reverse', 'procurement.requisition', 'procurement.approve',
    'procurement.manage_suppliers', 'stores.manage', 'finance.view', 'finance.manage',
    'finance.view_sensitive', 'site.diary', 'site.photos', 'quality.manage', 'safety.manage',
    'plant.manage', 'documents.manage', 'reports.view', 'portal.client', 'portal.supplier'
  ]::text[]
);
ALTER TABLE "project_memberships" DROP CONSTRAINT "project_permissions_check";
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_permissions_check" CHECK (
  permissions <@ ARRAY[
    'projects.view', 'projects.manage', 'bq.view', 'bq.edit', 'bq.import',
    'bq.approve_variation', 'labour.view', 'labour.manage', 'labour.view_sensitive',
    'labour.do_not_rehire', 'labour.consent', 'attendance.view', 'attendance.record',
    'attendance.override', 'attendance.review_anomalies', 'payroll.prepare', 'payroll.review',
    'procurement.requisition', 'procurement.approve', 'stores.manage', 'finance.view',
    'site.diary', 'site.photos', 'quality.manage', 'safety.manage', 'plant.manage',
    'documents.manage', 'reports.view'
  ]::text[]
);

-- Row-level security -----------------------------------------------------------------------------
ALTER TABLE "trades" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "trades" FORCE ROW LEVEL SECURITY;
ALTER TABLE "skill_levels" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "skill_levels" FORCE ROW LEVEL SECURITY;
ALTER TABLE "labour_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "labour_settings" FORCE ROW LEVEL SECURITY;
ALTER TABLE "labourers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "labourers" FORCE ROW LEVEL SECURITY;
ALTER TABLE "labour_engagements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "labour_engagements" FORCE ROW LEVEL SECURITY;
ALTER TABLE "labourer_consents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "labourer_consents" FORCE ROW LEVEL SECURITY;
ALTER TABLE "labourer_accreditations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "labourer_accreditations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "do_not_rehire_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "do_not_rehire_events" FORCE ROW LEVEL SECURITY;
ALTER TABLE "labour_rates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "labour_rates" FORCE ROW LEVEL SECURITY;
ALTER TABLE "gangs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "gangs" FORCE ROW LEVEL SECURITY;
ALTER TABLE "gang_memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "gang_memberships" FORCE ROW LEVEL SECURITY;
ALTER TABLE "labour_saved_views" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "labour_saved_views" FORCE ROW LEVEL SECURITY;

CREATE POLICY trades_isolation ON trades
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY skill_levels_isolation ON skill_levels
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY labour_settings_isolation ON labour_settings
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY labourers_isolation ON labourers
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY labour_engagements_isolation ON labour_engagements
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY labourer_consents_read ON labourer_consents FOR SELECT
  USING (tenant_id = app.current_tenant_id());
CREATE POLICY labourer_consents_insert ON labourer_consents FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id() AND captured_by = app.current_user_id());
CREATE POLICY labourer_consents_withdraw ON labourer_consents FOR UPDATE
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND withdrawn_by = app.current_user_id());
CREATE POLICY labourer_accreditations_isolation ON labourer_accreditations
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY do_not_rehire_events_read ON do_not_rehire_events FOR SELECT
  USING (tenant_id = app.current_tenant_id());
CREATE POLICY do_not_rehire_events_insert ON do_not_rehire_events FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id() AND actor_id = app.current_user_id());
CREATE POLICY labour_rates_read ON labour_rates FOR SELECT
  USING (tenant_id = app.current_tenant_id());
CREATE POLICY labour_rates_insert ON labour_rates FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id() AND created_by = app.current_user_id());
CREATE POLICY labour_rates_cancel ON labour_rates FOR DELETE
  USING (tenant_id = app.current_tenant_id());
CREATE POLICY gangs_isolation ON gangs
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY gang_memberships_isolation ON gang_memberships
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
-- Saved views are private to their owner within the company.
CREATE POLICY labour_saved_views_owner ON labour_saved_views
  USING (tenant_id = app.current_tenant_id() AND user_id = app.current_user_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND user_id = app.current_user_id());

-- Runtime role: history is never rewritten or deleted; configuration is deactivated, not deleted;
-- labourers, engagements, consents and gang memberships are kept (retention: COMPLIANCE-REVIEW
-- CR-DP-06); no TRUNCATE, REFERENCES or TRIGGER on any new table.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmb_app') THEN
    REVOKE UPDATE, DELETE ON "do_not_rehire_events" FROM pmb_app;
    REVOKE UPDATE ON "labour_rates" FROM pmb_app;
    REVOKE DELETE ON "trades", "skill_levels", "labour_settings", "labourers",
      "labour_engagements", "labourer_consents", "gangs", "gang_memberships" FROM pmb_app;
    REVOKE TRUNCATE, REFERENCES, TRIGGER ON "trades", "skill_levels", "labour_settings",
      "labourers", "labour_engagements", "labourer_consents", "labourer_accreditations",
      "do_not_rehire_events", "labour_rates", "gangs", "gang_memberships", "labour_saved_views"
      FROM pmb_app;
  END IF;
END
$$;
REVOKE EXECUTE ON FUNCTION app.guard_labourer() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.require_labourer_consent() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_engagement() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_consent() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.stamp_created_at() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.stamp_captured_at() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_labour_rate() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_gang() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_gang_membership() FROM PUBLIC;

COMMIT;
