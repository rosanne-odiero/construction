-- D5.1 Material catalogue, units, conversions, suppliers and price history (ARCHITECTURE §4.4,
-- ERD §5, brief §5.3, §5.7 and §15 C/D/F/G). Enforces, in the database as well as the API:
-- * Units: standard units live in code (packages/domain STANDARD_UNITS, mirrored by
--   app.standard_unit_dimension); company units are immutable once created (only archived).
-- * Conversions: explicit, effective-dated factors per material (optionally per supplier); never
--   between units of one sized dimension (those convert exactly by standard factors); at most one
--   factor per unit-class pair, scope and date (app.guard_unit_conversion, serialised on the
--   material row); rows are never deleted and only ever ended.
-- * Suppliers: KRA PIN encrypted with a blind index unique per company; contact phones encrypted
--   and every phone change logged (supplier_phone_changes, append-only).
-- * Payout details (maker-checker, brief §15 D): versions are immutable; a new proposal supersedes
--   the current version, so changed details are unusable until verified; at most one current
--   version per supplier; the verifier or rejecter may not be a contributor (proposer, writer, or
--   anyone who changed a contact phone in the 30 days before or while it was pending).
-- * Price history is append-only; corrections are new rows referencing the corrected one (each
--   corrected once); VAT net/gross amounts are re-checked.
-- Every table has tenant_id, forced RLS with WITH CHECK and composite (tenant_id, …) foreign keys.
-- CHECK expressions are wrapped in COALESCE(…, false) wherever a NULL would otherwise pass.
BEGIN;

-- Standard units (packages/types STANDARD_UNIT_CODES; packages/domain STANDARD_UNITS) -----------
CREATE FUNCTION app.standard_unit_dimension(unit_code text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE unit_code
    WHEN 'kg' THEN 'mass' WHEN 'g' THEN 'mass' WHEN 't' THEN 'mass'
    WHEN 'bag_50kg' THEN 'mass' WHEN 'bag_25kg' THEN 'mass'
    WHEN 'mm' THEN 'length' WHEN 'm' THEN 'length' WHEN 'ft' THEN 'length'
    WHEN 'm2' THEN 'area'
    WHEN 'm3' THEN 'volume' WHEN 'l' THEN 'volume'
    WHEN 'nr' THEN 'count' WHEN 'pair' THEN 'count'
    WHEN 'trip' THEN 'trip'
    WHEN 'bag' THEN 'package' WHEN 'sheet' THEN 'package' WHEN 'roll' THEN 'package'
    WHEN 'bundle' THEN 'package' WHEN 'packet' THEN 'package' WHEN 'box' THEN 'package'
    WHEN 'drum' THEN 'package' WHEN 'tin' THEN 'package' WHEN 'set' THEN 'package'
    ELSE NULL
  END
$$;

-- Company units ----------------------------------------------------------------------------------
CREATE TABLE "units" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "name_sw" VARCHAR(60),
    "dimension" VARCHAR(10) NOT NULL,
    "equals_quantity" DECIMAL(20,6),
    "equals_unit" VARCHAR(20),
    "status" VARCHAR(10) NOT NULL DEFAULT 'active',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "units_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "units_tenant_id_id_key" ON "units"("tenant_id", "id");
CREATE UNIQUE INDEX "units_tenant_id_code_key" ON "units"("tenant_id", "code");
ALTER TABLE "units" ADD CONSTRAINT "units_tenant_id_fkey" FOREIGN KEY ("tenant_id")
  REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "units" ADD CONSTRAINT "units_code_check" CHECK (
  code ~ '^[a-z][a-z0-9_]{1,19}$' AND app.standard_unit_dimension(code) IS NULL
);
-- packages/types UNIT_DIMENSIONS; sized units state their size in a standard unit of the dimension.
ALTER TABLE "units" ADD CONSTRAINT "units_dimension_check" CHECK (
  dimension IN ('mass', 'length', 'area', 'volume', 'count', 'trip', 'package')
  AND CASE WHEN dimension IN ('trip', 'package')
    THEN equals_quantity IS NULL AND equals_unit IS NULL
    ELSE COALESCE(equals_quantity > 0 AND app.standard_unit_dimension(equals_unit) = dimension, false)
  END
);
ALTER TABLE "units" ADD CONSTRAINT "units_text_check" CHECK (
  char_length(name) >= 2 AND name = btrim(name) AND status IN ('active', 'archived') AND version >= 1
);

-- The class two units share when standard factors alone convert them (COLLATE "C" below gives
-- the key order packages/domain uses).
CREATE FUNCTION app.unit_class(target_tenant uuid, unit_code text) RETURNS text
  LANGUAGE plpgsql STABLE AS $$
DECLARE
  found_dimension text;
  sized boolean;
BEGIN
  found_dimension := app.standard_unit_dimension(unit_code);
  IF found_dimension IS NOT NULL THEN
    RETURN CASE WHEN found_dimension IN ('trip', 'package') THEN 'unit:' || unit_code
      ELSE 'dim:' || found_dimension END;
  END IF;
  SELECT u.dimension, u.equals_quantity IS NOT NULL INTO found_dimension, sized
    FROM units u WHERE u.tenant_id = target_tenant AND u.code = unit_code;
  IF found_dimension IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN CASE WHEN sized THEN 'dim:' || found_dimension ELSE 'unit:' || unit_code END;
END
$$;

-- A company unit's definition never changes (conversions, materials and prices refer to it).
CREATE FUNCTION app.guard_unit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'status' - 'version' - 'updated_by' - 'updated_at')
     IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'version' - 'updated_by' - 'updated_at') THEN
    RAISE EXCEPTION 'A unit''s definition never changes; archive it and add another'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER unit_guard BEFORE UPDATE ON "units" FOR EACH ROW EXECUTE FUNCTION app.guard_unit();

-- Materials --------------------------------------------------------------------------------------
CREATE TABLE "materials" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" CITEXT NOT NULL,
    "name_sw" VARCHAR(150),
    "category" VARCHAR(20) NOT NULL,
    "base_unit" VARCHAR(20) NOT NULL,
    "spec" VARCHAR(200),
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "notes" VARCHAR(2000),
    "status" VARCHAR(10) NOT NULL DEFAULT 'active',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "materials_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "materials_tenant_id_id_key" ON "materials"("tenant_id", "id");
CREATE UNIQUE INDEX "materials_tenant_id_code_key" ON "materials"("tenant_id", "code");
CREATE UNIQUE INDEX "materials_tenant_id_name_key" ON "materials"("tenant_id", "name");
CREATE INDEX "materials_tenant_id_category_idx" ON "materials"("tenant_id", "category");
ALTER TABLE "materials" ADD CONSTRAINT "materials_tenant_id_fkey" FOREIGN KEY ("tenant_id")
  REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;
-- packages/types MATERIAL_CATEGORIES, MATERIAL_STATUSES, STEEL_BAR_DIAMETERS_MM, ROOFING_GAUGES
ALTER TABLE "materials" ADD CONSTRAINT "materials_category_check" CHECK (
  category IN ('cement', 'aggregates', 'blocks_stones', 'steel', 'brc_mesh', 'timber', 'roofing',
               'plumbing', 'electrical', 'finishes', 'other')
);
ALTER TABLE "materials" ADD CONSTRAINT "materials_text_check" CHECK (
  code ~ '^MAT-[0-9]{4,12}$'
  AND char_length(name) BETWEEN 2 AND 150 AND name = btrim(name)
  AND base_unit ~ '^[a-z][a-z0-9_]{0,19}$'
  AND status IN ('active', 'archived') AND version >= 1
);
ALTER TABLE "materials" ADD CONSTRAINT "materials_attributes_check" CHECK (
  jsonb_typeof(attributes) = 'object'
  AND (NOT attributes ? 'diameterMm' OR COALESCE(category = 'steel'
       AND attributes->>'diameterMm' IN ('8', '10', '12', '16', '20', '25', '32'), false))
  AND (NOT attributes ? 'gauge' OR COALESCE(category = 'roofing'
       AND attributes->>'gauge' IN ('24', '26', '28', '30', '32'), false))
);

-- Suppliers --------------------------------------------------------------------------------------
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "legal_name" VARCHAR(200) NOT NULL,
    "trading_name" VARCHAR(200),
    "kra_pin_enc" BYTEA,
    "kra_pin_bidx" CHAR(64),
    "kra_pin_masked" VARCHAR(16),
    "etims_status" VARCHAR(20) NOT NULL DEFAULT 'unknown',
    "etims_checked_on" DATE,
    "status" VARCHAR(10) NOT NULL DEFAULT 'active',
    "status_reason" VARCHAR(500),
    "credit_days" INTEGER NOT NULL DEFAULT 0,
    "credit_limit_minor" BIGINT,
    "notes" VARCHAR(2000),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "suppliers_tenant_id_id_key" ON "suppliers"("tenant_id", "id");
CREATE UNIQUE INDEX "suppliers_tenant_id_code_key" ON "suppliers"("tenant_id", "code");
-- One supplier per KRA PIN per company, through the blind index (NULLs are distinct).
CREATE UNIQUE INDEX "suppliers_tenant_id_kra_pin_bidx_key" ON "suppliers"("tenant_id", "kra_pin_bidx");
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_tenant_id_fkey" FOREIGN KEY ("tenant_id")
  REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;
-- packages/types SUPPLIER_STATUSES, ETIMS_STATUSES
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_state_check" CHECK (
  code ~ '^SUP-[0-9]{4,12}$'
  AND char_length(legal_name) >= 2 AND legal_name = btrim(legal_name)
  AND etims_status IN ('registered', 'unknown', 'not_registered')
  AND status IN ('active', 'on_hold', 'blocked')
  AND (status = 'active' OR COALESCE(char_length(btrim(status_reason)), 0) >= 3)
  AND credit_days BETWEEN 0 AND 365
  AND (credit_limit_minor IS NULL OR credit_limit_minor >= 0)
  AND version >= 1
);
-- The PIN is stored only as ciphertext, its blind index and a mask; all three or none.
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_kra_pin_check" CHECK (
  (kra_pin_enc IS NULL) = (kra_pin_bidx IS NULL) AND (kra_pin_bidx IS NULL) = (kra_pin_masked IS NULL)
  AND (kra_pin_bidx IS NULL OR kra_pin_bidx ~ '^[0-9a-f]{64}$')
  AND (kra_pin_masked IS NULL OR kra_pin_masked ~ '^[AP]•{7}[0-9]{2}[A-Z]$')
);

CREATE FUNCTION app.guard_supplier() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'A supplier keeps its code' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER supplier_guard BEFORE UPDATE ON "suppliers"
  FOR EACH ROW EXECUTE FUNCTION app.guard_supplier();

CREATE TABLE "supplier_contacts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "role" VARCHAR(60),
    "phone_enc" BYTEA,
    "phone_bidx" CHAR(64),
    "phone_masked" VARCHAR(20),
    "phone_changed_by" UUID,
    "phone_changed_at" TIMESTAMPTZ,
    "email" VARCHAR(254),
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_contacts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "supplier_contacts_tenant_id_id_key" ON "supplier_contacts"("tenant_id", "id");
CREATE INDEX "supplier_contacts_tenant_id_supplier_id_idx"
  ON "supplier_contacts"("tenant_id", "supplier_id");
CREATE INDEX "supplier_contacts_tenant_id_phone_bidx_idx"
  ON "supplier_contacts"("tenant_id", "phone_bidx");
-- At most one primary contact per supplier.
CREATE UNIQUE INDEX "supplier_contacts_one_primary"
  ON "supplier_contacts"("tenant_id", "supplier_id") WHERE is_primary;
ALTER TABLE "supplier_contacts" ADD CONSTRAINT "supplier_contacts_tenant_id_supplier_id_fkey"
  FOREIGN KEY ("tenant_id", "supplier_id") REFERENCES "suppliers"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "supplier_contacts" ADD CONSTRAINT "supplier_contacts_check" CHECK (
  char_length(name) >= 2 AND name = btrim(name)
  AND (phone_enc IS NULL) = (phone_bidx IS NULL) AND (phone_bidx IS NULL) = (phone_masked IS NULL)
  AND (phone_bidx IS NULL OR phone_bidx ~ '^[0-9a-f]{64}$')
  AND (phone_masked IS NULL OR phone_masked ~ '^254[17]•{5}[0-9]{3}$')
  AND (phone_changed_by IS NULL) = (phone_changed_at IS NULL)
);

-- Every change to a contact phone (set, cleared or the contact removed), append-only.
CREATE TABLE "supplier_phone_changes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "action" VARCHAR(10) NOT NULL,
    "changed_by" UUID,
    "changed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_phone_changes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "supplier_phone_changes_tenant_id_supplier_id_changed_at_idx"
  ON "supplier_phone_changes"("tenant_id", "supplier_id", "changed_at");
ALTER TABLE "supplier_phone_changes" ADD CONSTRAINT "supplier_phone_changes_tenant_id_supplier_id_fkey"
  FOREIGN KEY ("tenant_id", "supplier_id") REFERENCES "suppliers"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "supplier_phone_changes" ADD CONSTRAINT "supplier_phone_changes_action_check" CHECK (
  action IN ('set', 'cleared', 'removed')
);

-- Payout details, versioned (maker-checker) ----------------------------------------------------
CREATE TABLE "supplier_payout_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'pending',
    "mpesa_kind" VARCHAR(10) NOT NULL,
    "paybill_number" VARCHAR(7),
    "account_reference" VARCHAR(20),
    "till_number" VARCHAR(7),
    "bank_name" VARCHAR(100),
    "bank_branch" VARCHAR(100),
    "account_name" VARCHAR(150),
    "account_number_enc" BYTEA,
    "account_number_masked" VARCHAR(10),
    "proposed_by" UUID NOT NULL,
    "proposed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "contributors" UUID[] NOT NULL DEFAULT '{}',
    "contact_change_warning" BOOLEAN NOT NULL DEFAULT false,
    "verified_by" UUID,
    "verified_at" TIMESTAMPTZ,
    "verification_method" VARCHAR(30),
    "verification_note" VARCHAR(500),
    "rejected_by" UUID,
    "rejected_at" TIMESTAMPTZ,
    "rejection_reason" VARCHAR(500),
    "superseded_by" UUID,
    "superseded_at" TIMESTAMPTZ,

    CONSTRAINT "supplier_payout_versions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "supplier_payout_versions_tenant_id_id_key"
  ON "supplier_payout_versions"("tenant_id", "id");
CREATE UNIQUE INDEX "supplier_payout_versions_tenant_id_supplier_id_version_no_key"
  ON "supplier_payout_versions"("tenant_id", "supplier_id", "version_no");
-- At most one current (pending or verified) version per supplier.
CREATE UNIQUE INDEX "supplier_payout_versions_one_current"
  ON "supplier_payout_versions"("tenant_id", "supplier_id") WHERE status IN ('pending', 'verified');
ALTER TABLE "supplier_payout_versions" ADD CONSTRAINT "supplier_payout_versions_tenant_id_supplier_id_fkey"
  FOREIGN KEY ("tenant_id", "supplier_id") REFERENCES "suppliers"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
-- packages/types MPESA_PAYOUT_KINDS; packages/validation proposePayoutRequestSchema
ALTER TABLE "supplier_payout_versions" ADD CONSTRAINT "supplier_payout_versions_channel_check" CHECK (
  version_no >= 1
  AND COALESCE(CASE mpesa_kind
    WHEN 'paybill' THEN paybill_number ~ '^[0-9]{5,7}$' AND account_reference IS NOT NULL
      AND till_number IS NULL
    WHEN 'till' THEN till_number ~ '^[0-9]{5,7}$' AND paybill_number IS NULL
      AND account_reference IS NULL
    WHEN 'none' THEN paybill_number IS NULL AND account_reference IS NULL AND till_number IS NULL
    ELSE false
  END, false)
  AND (bank_name IS NULL) = (account_name IS NULL)
  AND (account_name IS NULL) = (account_number_enc IS NULL)
  AND (account_number_enc IS NULL) = (account_number_masked IS NULL)
  AND (bank_name IS NOT NULL OR bank_branch IS NULL)
  AND (mpesa_kind <> 'none' OR bank_name IS NOT NULL)
  AND (account_number_masked IS NULL OR account_number_masked ~ '^•{4}([0-9A-Z]{2}|[0-9A-Z]{4})$')
);
-- packages/types PAYOUT_STATUSES, PAYOUT_VERIFICATION_METHODS. Maker-checker by identity: the
-- proposer is a contributor, and nobody on the list may verify or reject the version.
ALTER TABLE "supplier_payout_versions" ADD CONSTRAINT "supplier_payout_versions_state_check" CHECK (
  proposed_by = ANY (contributors)
  AND COALESCE(CASE status
    WHEN 'pending' THEN verified_by IS NULL AND verified_at IS NULL AND rejected_by IS NULL
      AND rejected_at IS NULL AND superseded_at IS NULL
    WHEN 'verified' THEN verified_by IS NOT NULL AND verified_at IS NOT NULL
      AND verification_method IS NOT NULL AND char_length(btrim(verification_note)) >= 3
      AND rejected_by IS NULL AND superseded_at IS NULL
    WHEN 'rejected' THEN rejected_by IS NOT NULL AND rejected_at IS NOT NULL
      AND char_length(btrim(rejection_reason)) >= 3 AND verified_by IS NULL
      AND superseded_at IS NULL
    WHEN 'superseded' THEN superseded_at IS NOT NULL AND rejected_by IS NULL
    ELSE false
  END, false)
  AND (verification_method IS NULL OR verification_method IN
    ('call_back_known_number', 'in_person_documents', 'bank_confirmation_letter', 'other'))
  AND (verified_by IS NULL OR NOT (verified_by = ANY (contributors)))
  AND (rejected_by IS NULL OR NOT (rejected_by = ANY (contributors)))
);

-- Contributors: the proposer, the writer and whoever changed a contact phone of the supplier in
-- the 30 days before the proposal (packages/types PAYOUT_CONTACT_CHANGE_WINDOW_DAYS).
CREATE FUNCTION app.guard_payout_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  recent uuid[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'Payout details start as a pending proposal' USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(array_agg(DISTINCT changed_by), '{}') INTO recent FROM supplier_phone_changes
      WHERE tenant_id = NEW.tenant_id AND supplier_id = NEW.supplier_id
        AND changed_by IS NOT NULL AND changed_at >= now() - interval '30 days';
    NEW.contributors := app.add_contributors(
      app.add_contributors(NEW.contributors, NEW.proposed_by, app.current_user_id()), VARIADIC recent
    );
    NEW.contact_change_warning := cardinality(recent) > 0;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'contributors' - 'contact_change_warning' - 'verified_by'
      - 'verified_at' - 'verification_method' - 'verification_note' - 'rejected_by' - 'rejected_at'
      - 'rejection_reason' - 'superseded_by' - 'superseded_at')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'status' - 'contributors' - 'contact_change_warning' - 'verified_by'
      - 'verified_at' - 'verification_method' - 'verification_note' - 'rejected_by' - 'rejected_at'
      - 'rejection_reason' - 'superseded_by' - 'superseded_at') THEN
    RAISE EXCEPTION 'Payout details never change; propose a new version' USING ERRCODE = '23514';
  END IF;
  IF NOT (NEW.contributors @> OLD.contributors) THEN
    RAISE EXCEPTION 'Contributors are only ever added' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('rejected', 'superseded') THEN
    RAISE EXCEPTION 'A % payout version never changes', OLD.status USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND (OLD.status, NEW.status) NOT IN (
    ('pending', 'verified'), ('pending', 'rejected'), ('pending', 'superseded'),
    ('verified', 'superseded')
  ) THEN
    RAISE EXCEPTION 'Payout status cannot change from % to %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'verified' AND (NEW.contributors IS DISTINCT FROM OLD.contributors
     OR NEW.verified_by IS DISTINCT FROM OLD.verified_by
     OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
     OR NEW.verification_method IS DISTINCT FROM OLD.verification_method
     OR NEW.verification_note IS DISTINCT FROM OLD.verification_note) THEN
    RAISE EXCEPTION 'A verification is never edited' USING ERRCODE = '23514';
  END IF;
  -- A decision is recorded by the signed-in person making it.
  IF NEW.status IN ('verified', 'rejected') AND NEW.status IS DISTINCT FROM OLD.status
     AND app.current_user_id() IS DISTINCT FROM COALESCE(NEW.verified_by, NEW.rejected_by) THEN
    RAISE EXCEPTION 'Payout details are decided by the signed-in user' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER supplier_payout_version_guard BEFORE INSERT OR UPDATE ON "supplier_payout_versions"
  FOR EACH ROW EXECUTE FUNCTION app.guard_payout_version();

-- Contact phone changes are logged, stamped and make the writer a contributor to a pending
-- payout proposal (and flag it), so nobody can change the "known number" and then verify.
CREATE FUNCTION app.record_contact_phone_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  change text;
  target_tenant uuid;
  target_supplier uuid;
  target_contact uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_tenant := OLD.tenant_id;
    target_supplier := OLD.supplier_id;
    target_contact := OLD.id;
    change := CASE WHEN OLD.phone_enc IS NOT NULL THEN 'removed' END;
  ELSE
    target_tenant := NEW.tenant_id;
    target_supplier := NEW.supplier_id;
    target_contact := NEW.id;
    IF TG_OP = 'INSERT' THEN
      change := CASE WHEN NEW.phone_enc IS NOT NULL THEN 'set' END;
    ELSE
      IF NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
         OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id THEN
        RAISE EXCEPTION 'A contact stays with its supplier' USING ERRCODE = '23514';
      END IF;
      IF NEW.phone_enc IS DISTINCT FROM OLD.phone_enc THEN
        change := CASE WHEN NEW.phone_enc IS NULL THEN 'cleared' ELSE 'set' END;
      ELSIF NEW.phone_changed_by IS DISTINCT FROM OLD.phone_changed_by
         OR NEW.phone_changed_at IS DISTINCT FROM OLD.phone_changed_at THEN
        RAISE EXCEPTION 'Phone change stamps are set by the database' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  IF change IS NOT NULL THEN
    INSERT INTO supplier_phone_changes (tenant_id, supplier_id, contact_id, action, changed_by)
      VALUES (target_tenant, target_supplier, target_contact, change, app.current_user_id());
    UPDATE supplier_payout_versions
      SET contributors = app.add_contributors(contributors, app.current_user_id()),
          contact_change_warning = true
      WHERE tenant_id = target_tenant AND supplier_id = target_supplier AND status = 'pending';
    IF TG_OP <> 'DELETE' THEN
      NEW.phone_changed_by := app.current_user_id();
      NEW.phone_changed_at := CASE WHEN NEW.phone_changed_by IS NULL THEN NULL ELSE now() END;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER supplier_contact_phone BEFORE INSERT OR UPDATE OR DELETE ON "supplier_contacts"
  FOR EACH ROW EXECUTE FUNCTION app.record_contact_phone_change();

-- Unit conversions -------------------------------------------------------------------------------
CREATE TABLE "unit_conversions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "material_id" UUID NOT NULL,
    "supplier_id" UUID,
    "from_unit" VARCHAR(20) NOT NULL,
    "from_quantity" DECIMAL(20,6) NOT NULL,
    "to_unit" VARCHAR(20) NOT NULL,
    "to_quantity" DECIMAL(20,6) NOT NULL,
    "pair_key" VARCHAR(60) NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "note" VARCHAR(300),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_by" UUID,
    "ended_at" TIMESTAMPTZ,

    CONSTRAINT "unit_conversions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "unit_conversions_tenant_id_id_key" ON "unit_conversions"("tenant_id", "id");
CREATE INDEX "unit_conversions_tenant_id_material_id_idx"
  ON "unit_conversions"("tenant_id", "material_id");
ALTER TABLE "unit_conversions" ADD CONSTRAINT "unit_conversions_tenant_id_material_id_fkey"
  FOREIGN KEY ("tenant_id", "material_id") REFERENCES "materials"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "unit_conversions" ADD CONSTRAINT "unit_conversions_tenant_id_supplier_id_fkey"
  FOREIGN KEY ("tenant_id", "supplier_id") REFERENCES "suppliers"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "unit_conversions" ADD CONSTRAINT "unit_conversions_check" CHECK (
  from_unit <> to_unit AND from_quantity > 0 AND to_quantity > 0
  AND from_quantity <= 1000000000000 AND to_quantity <= 1000000000000
  AND (effective_to IS NULL OR effective_to > effective_from)
  AND (effective_to IS NULL) = (ended_at IS NULL) AND (ended_by IS NULL) = (ended_at IS NULL)
);

CREATE FUNCTION app.guard_unit_conversion() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  from_class text;
  to_class text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.effective_to IS NOT NULL OR NEW.effective_to IS NULL
       OR (to_jsonb(NEW) - 'effective_to' - 'ended_by' - 'ended_at')
          IS DISTINCT FROM (to_jsonb(OLD) - 'effective_to' - 'ended_by' - 'ended_at') THEN
      RAISE EXCEPTION 'A conversion is never edited; end it and add another'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  -- Serialise factors for one material (concurrent writers queue on the material row).
  PERFORM 1 FROM materials WHERE tenant_id = NEW.tenant_id AND id = NEW.material_id FOR UPDATE;
  from_class := app.unit_class(NEW.tenant_id, NEW.from_unit);
  to_class := app.unit_class(NEW.tenant_id, NEW.to_unit);
  IF from_class IS NULL OR to_class IS NULL THEN
    RAISE EXCEPTION 'Unknown unit in a conversion' USING ERRCODE = '23514';
  END IF;
  IF from_class = to_class THEN
    RAISE EXCEPTION 'These units already convert by a standard factor' USING ERRCODE = '23514';
  END IF;
  NEW.pair_key := least(from_class COLLATE "C", to_class COLLATE "C") || '|'
    || greatest(from_class COLLATE "C", to_class COLLATE "C");
  IF EXISTS (
    SELECT 1 FROM unit_conversions c
    WHERE c.tenant_id = NEW.tenant_id AND c.material_id = NEW.material_id
      AND c.supplier_id IS NOT DISTINCT FROM NEW.supplier_id AND c.pair_key = NEW.pair_key
      AND daterange(c.effective_from, c.effective_to) && daterange(NEW.effective_from, NEW.effective_to)
  ) THEN
    RAISE EXCEPTION 'Another conversion for these units is in force on these dates'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER unit_conversion_guard BEFORE INSERT OR UPDATE ON "unit_conversions"
  FOR EACH ROW EXECUTE FUNCTION app.guard_unit_conversion();

-- Price history ----------------------------------------------------------------------------------
CREATE TABLE "material_prices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "material_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "unit" VARCHAR(20) NOT NULL,
    "unit_price_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'KES',
    "vat_treatment" VARCHAR(15) NOT NULL,
    "vat_rate_percent" DECIMAL(7,4),
    "vat_rule_status" VARCHAR(20),
    "net_unit_price_minor" BIGINT NOT NULL,
    "gross_unit_price_minor" BIGINT NOT NULL,
    "effective_on" DATE NOT NULL,
    "source" VARCHAR(10) NOT NULL,
    "source_reference" VARCHAR(100),
    "note" VARCHAR(500),
    "comparable_unit" VARCHAR(20),
    "comparable_unit_price_minor" DECIMAL(30,6),
    "conversion_snapshot" JSONB,
    "previous_price_id" UUID,
    "change_percent" DECIMAL(14,4),
    "alert_state" VARCHAR(20) NOT NULL,
    "alert_threshold_percent" DECIMAL(8,4) NOT NULL,
    "corrects_price_id" UUID,
    "correction_reason" VARCHAR(500),
    "recorded_by" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "material_prices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "material_prices_tenant_id_id_key" ON "material_prices"("tenant_id", "id");
CREATE UNIQUE INDEX "material_prices_tenant_id_material_id_id_key"
  ON "material_prices"("tenant_id", "material_id", "id");
-- A price is corrected at most once (a correction of a correction targets the newer row).
CREATE UNIQUE INDEX "material_prices_tenant_id_corrects_price_id_key"
  ON "material_prices"("tenant_id", "corrects_price_id");
CREATE INDEX "material_prices_history_idx"
  ON "material_prices"("tenant_id", "material_id", "supplier_id", "effective_on");
CREATE INDEX "material_prices_tenant_id_alert_state_idx"
  ON "material_prices"("tenant_id", "alert_state");
CREATE INDEX "material_prices_tenant_id_supplier_id_idx" ON "material_prices"("tenant_id", "supplier_id");
ALTER TABLE "material_prices" ADD CONSTRAINT "material_prices_tenant_id_material_id_fkey"
  FOREIGN KEY ("tenant_id", "material_id") REFERENCES "materials"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "material_prices" ADD CONSTRAINT "material_prices_tenant_id_supplier_id_fkey"
  FOREIGN KEY ("tenant_id", "supplier_id") REFERENCES "suppliers"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "material_prices" ADD CONSTRAINT "material_prices_previous_fkey"
  FOREIGN KEY ("tenant_id", "material_id", "previous_price_id")
  REFERENCES "material_prices"("tenant_id", "material_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "material_prices" ADD CONSTRAINT "material_prices_corrects_fkey"
  FOREIGN KEY ("tenant_id", "material_id", "corrects_price_id")
  REFERENCES "material_prices"("tenant_id", "material_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- packages/types PRICE_SOURCES, VAT_TREATMENTS; packages/domain splitVat (half-up to the cent,
-- as PostgreSQL round(numeric)).
ALTER TABLE "material_prices" ADD CONSTRAINT "material_prices_amount_check" CHECK (
  currency = 'KES' AND unit_price_minor > 0 AND unit_price_minor <= 1000000000000
  AND source IN ('manual', 'quotation', 'invoice')
  AND COALESCE(CASE vat_treatment
    WHEN 'inclusive' THEN vat_rate_percent IS NOT NULL AND gross_unit_price_minor = unit_price_minor
      AND net_unit_price_minor = round(unit_price_minor * 100 / (100 + vat_rate_percent))
    WHEN 'exclusive' THEN vat_rate_percent IS NOT NULL AND net_unit_price_minor = unit_price_minor
      AND gross_unit_price_minor = round(unit_price_minor * (100 + vat_rate_percent) / 100)
    WHEN 'not_applicable' THEN vat_rate_percent IS NULL
      AND net_unit_price_minor = unit_price_minor AND gross_unit_price_minor = unit_price_minor
    ELSE false
  END, false)
  AND (vat_rate_percent IS NULL OR vat_rate_percent BETWEEN 0 AND 100)
  AND net_unit_price_minor > 0
);
-- packages/types PRICE_ALERT_STATES: the change is stored to four places, the threshold snapshot.
ALTER TABLE "material_prices" ADD CONSTRAINT "material_prices_alert_check" CHECK (
  alert_threshold_percent > 0
  AND (comparable_unit IS NULL) = (comparable_unit_price_minor IS NULL)
  AND (comparable_unit IS NULL) = (conversion_snapshot IS NULL)
  AND COALESCE(CASE alert_state
    WHEN 'first_price' THEN comparable_unit IS NOT NULL AND previous_price_id IS NULL
      AND change_percent IS NULL
    WHEN 'within_threshold' THEN previous_price_id IS NOT NULL AND change_percent IS NOT NULL
      AND abs(change_percent) <= alert_threshold_percent
    WHEN 'above_threshold' THEN previous_price_id IS NOT NULL AND change_percent IS NOT NULL
      AND abs(change_percent) >= alert_threshold_percent
    WHEN 'not_comparable' THEN previous_price_id IS NULL AND change_percent IS NULL
    ELSE false
  END, false)
  AND (corrects_price_id IS NULL) = (correction_reason IS NULL)
  AND (correction_reason IS NULL OR char_length(btrim(correction_reason)) >= 3)
);

CREATE FUNCTION app.guard_material_price() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.unit_class(NEW.tenant_id, NEW.unit) IS NULL OR (NEW.comparable_unit IS NOT NULL
     AND app.unit_class(NEW.tenant_id, NEW.comparable_unit) IS NULL) THEN
    RAISE EXCEPTION 'Unknown unit in a price' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER material_price_guard BEFORE INSERT ON "material_prices"
  FOR EACH ROW EXECUTE FUNCTION app.guard_material_price();

-- The base unit must exist (standard or the company's); the code never changes; the base unit is
-- fixed once the material has prices (their comparable prices are in it).
CREATE FUNCTION app.guard_material() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.unit_class(NEW.tenant_id, NEW.base_unit) IS NULL THEN
    RAISE EXCEPTION 'Unknown unit %', NEW.base_unit USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.code IS DISTINCT FROM OLD.code OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
      RAISE EXCEPTION 'A material keeps its code' USING ERRCODE = '23514';
    END IF;
    IF NEW.base_unit IS DISTINCT FROM OLD.base_unit AND EXISTS (
      SELECT 1 FROM material_prices p WHERE p.tenant_id = NEW.tenant_id AND p.material_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'The base unit is fixed once the material has prices' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER material_guard BEFORE INSERT OR UPDATE ON "materials"
  FOR EACH ROW EXECUTE FUNCTION app.guard_material();

-- Company settings -------------------------------------------------------------------------------
CREATE TABLE "procurement_settings" (
    "tenant_id" UUID NOT NULL,
    "price_change_alert_percent" DECIMAL(8,4) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "procurement_settings_pkey" PRIMARY KEY ("tenant_id")
);
ALTER TABLE "procurement_settings" ADD CONSTRAINT "procurement_settings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "procurement_settings" ADD CONSTRAINT "procurement_settings_check" CHECK (
  price_change_alert_percent > 0 AND price_change_alert_percent <= 1000 AND version >= 1
);

-- Row-level security -----------------------------------------------------------------------------
ALTER TABLE "units" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "units" FORCE ROW LEVEL SECURITY;
ALTER TABLE "materials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "materials" FORCE ROW LEVEL SECURITY;
ALTER TABLE "suppliers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "suppliers" FORCE ROW LEVEL SECURITY;
ALTER TABLE "supplier_contacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supplier_contacts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "supplier_phone_changes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supplier_phone_changes" FORCE ROW LEVEL SECURITY;
ALTER TABLE "supplier_payout_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supplier_payout_versions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "unit_conversions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "unit_conversions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "material_prices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "material_prices" FORCE ROW LEVEL SECURITY;
ALTER TABLE "procurement_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "procurement_settings" FORCE ROW LEVEL SECURITY;

CREATE POLICY units_isolation ON units
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY materials_isolation ON materials
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY suppliers_isolation ON suppliers
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY supplier_contacts_isolation ON supplier_contacts
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY supplier_phone_changes_isolation ON supplier_phone_changes
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY supplier_payout_versions_isolation ON supplier_payout_versions
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY unit_conversions_isolation ON unit_conversions
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY material_prices_isolation ON material_prices
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY procurement_settings_isolation ON procurement_settings
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

-- History is never deleted by the runtime role; prices and phone changes are append-only.
-- Contacts may be deleted (each removal of a phone is logged by app.record_contact_phone_change).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmb_app') THEN
    REVOKE DELETE ON "units", "materials", "suppliers", "supplier_phone_changes",
      "supplier_payout_versions", "unit_conversions", "material_prices", "procurement_settings"
      FROM pmb_app;
    REVOKE UPDATE ON "material_prices", "supplier_phone_changes" FROM pmb_app;
    REVOKE TRUNCATE, REFERENCES, TRIGGER
      ON "units", "materials", "suppliers", "supplier_contacts", "supplier_phone_changes",
         "supplier_payout_versions", "unit_conversions", "material_prices", "procurement_settings"
      FROM pmb_app;
    GRANT EXECUTE ON FUNCTION app.standard_unit_dimension(text) TO pmb_app;
    GRANT EXECUTE ON FUNCTION app.unit_class(uuid, text) TO pmb_app;
  END IF;
END
$$;
REVOKE EXECUTE ON FUNCTION app.standard_unit_dimension(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.unit_class(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_unit() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_material() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_supplier() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_payout_version() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.record_contact_phone_change() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_unit_conversion() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_material_price() FROM PUBLIC;

COMMIT;
