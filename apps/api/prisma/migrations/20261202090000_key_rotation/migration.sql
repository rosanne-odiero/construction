-- D9.1 key rotation (ARCHITECTURE §4.17, D-151, docs/OPERATIONS.md "Key rotation"). Field-level
-- ciphertexts carry their key version (byte 2 of the envelope); `pnpm --filter @pm-buddy/api
-- keys:rotate rewrap` moves them to the active key, connected as the schema owner (never as
-- pmb_app). This migration lets the owner do exactly that and nothing more:
-- * key_rotation_runs: one row per rotation run (who, what, counts, outcome); pmb_app has no access,
--   and forced RLS lets only the schema owner read or write it.
-- * The owner can list companies (to set app.tenant_id per company) and update do-not-rehire
--   history in a company's context; company rows stay isolated by the usual tenant policies.
-- * The guards on append-only or immutable rows (do-not-rehire history, verified payout details) and
--   the contact phone-change log skip an UPDATE only when it is a re-encryption: made by the owner,
--   only the ciphertext column changes, both values are field ciphertexts and the key version
--   differs. Any other change still meets the original guard. The database cannot check that the
--   plaintext is unchanged; the tool decrypts and re-encrypts under the row's own associated data.
BEGIN;

CREATE TABLE "key_rotation_runs" (
    "id" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "target_version" SMALLINT NOT NULL,
    "tenant_id" UUID,
    "dry_run" BOOLEAN NOT NULL DEFAULT false,
    "operator" VARCHAR(100) NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'running',
    "rows_checked" INTEGER NOT NULL DEFAULT 0,
    "rows_rewrapped" INTEGER NOT NULL DEFAULT 0,
    "rows_failed" INTEGER NOT NULL DEFAULT 0,
    "details" JSONB NOT NULL DEFAULT '{}',
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ,

    CONSTRAINT "key_rotation_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "key_rotation_runs_started_at_idx" ON "key_rotation_runs"("started_at");

ALTER TABLE "key_rotation_runs" ADD CONSTRAINT "key_rotation_runs_state_check" CHECK (
  kind IN ('field', 'mfa')
  AND target_version BETWEEN 1 AND 255
  AND char_length(btrim(operator)) BETWEEN 2 AND 100
  AND status IN ('running', 'completed', 'completed_with_errors', 'failed')
  AND rows_checked >= 0 AND rows_rewrapped >= 0 AND rows_failed >= 0
  AND (status = 'running') = (finished_at IS NULL)
);

-- The runtime role never reads or writes rotation records (default privileges would grant it).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmb_app') THEN
    REVOKE ALL ON "key_rotation_runs" FROM pmb_app;
  END IF;
END
$$;

DO $$
BEGIN
  -- Re-encryption by the schema owner: only the ciphertext column changes, to a field ciphertext
  -- under another key version. Bound to the role running this migration (the schema owner).
  EXECUTE format($fn$
    CREATE FUNCTION app.is_field_rewrap(
      old_rest jsonb, new_rest jsonb, old_value bytea, new_value bytea
    ) RETURNS boolean LANGUAGE sql STABLE AS $body$
      SELECT current_user = %L
        AND old_rest = new_rest
        AND old_value IS NOT NULL AND new_value IS NOT NULL
        AND app.is_field_ciphertext(old_value) AND app.is_field_ciphertext(new_value)
        AND get_byte(new_value, 1) <> get_byte(old_value, 1)
    $body$
  $fn$, current_user);

  -- Rotation records: the schema owner only (forced RLS, like every table with a tenant_id).
  ALTER TABLE "key_rotation_runs" ENABLE ROW LEVEL SECURITY;
  ALTER TABLE "key_rotation_runs" FORCE ROW LEVEL SECURITY;
  EXECUTE format(
    'CREATE POLICY key_rotation_runs_owner ON key_rotation_runs '
    'USING (current_user = %L) WITH CHECK (current_user = %L)',
    current_user, current_user
  );

  -- The owner lists companies to rotate each one in its own context.
  EXECUTE format(
    'CREATE POLICY tenants_key_rotation_scan ON tenants FOR SELECT USING (current_user = %L)',
    current_user
  );
  -- Do-not-rehire history has no UPDATE policy (append-only); the owner may update in a company's
  -- context, and the trigger below still refuses anything but a re-encryption.
  EXECUTE format(
    'CREATE POLICY do_not_rehire_events_key_rotation ON do_not_rehire_events FOR UPDATE '
    'USING (current_user = %L AND tenant_id = app.current_tenant_id()) '
    'WITH CHECK (current_user = %L AND tenant_id = app.current_tenant_id())',
    current_user, current_user
  );
END
$$;

-- Do-not-rehire history stays append-only except for re-encrypting the reason.
DROP TRIGGER do_not_rehire_events_append_only ON "do_not_rehire_events";
CREATE TRIGGER do_not_rehire_events_append_only BEFORE DELETE ON "do_not_rehire_events"
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();
CREATE TRIGGER do_not_rehire_events_append_only_update BEFORE UPDATE ON "do_not_rehire_events"
  FOR EACH ROW
  WHEN (NOT app.is_field_rewrap(
    to_jsonb(OLD) - 'reason_enc', to_jsonb(NEW) - 'reason_enc', OLD.reason_enc, NEW.reason_enc
  ))
  EXECUTE FUNCTION app.reject_history_mutation();

-- Payout details never change except for re-encrypting the account number.
DROP TRIGGER supplier_payout_version_guard ON "supplier_payout_versions";
CREATE TRIGGER supplier_payout_version_guard BEFORE INSERT ON "supplier_payout_versions"
  FOR EACH ROW EXECUTE FUNCTION app.guard_payout_version();
CREATE TRIGGER supplier_payout_version_guard_update BEFORE UPDATE ON "supplier_payout_versions"
  FOR EACH ROW
  WHEN (NOT app.is_field_rewrap(
    to_jsonb(OLD) - 'account_number_enc', to_jsonb(NEW) - 'account_number_enc',
    OLD.account_number_enc, NEW.account_number_enc
  ))
  EXECUTE FUNCTION app.guard_payout_version();

-- Re-encrypting a contact's phone is not a phone change: no change record, no payout warning.
DROP TRIGGER supplier_contact_phone ON "supplier_contacts";
CREATE TRIGGER supplier_contact_phone BEFORE INSERT OR DELETE ON "supplier_contacts"
  FOR EACH ROW EXECUTE FUNCTION app.record_contact_phone_change();
CREATE TRIGGER supplier_contact_phone_update BEFORE UPDATE ON "supplier_contacts"
  FOR EACH ROW
  WHEN (NOT app.is_field_rewrap(
    to_jsonb(OLD) - 'phone_enc', to_jsonb(NEW) - 'phone_enc', OLD.phone_enc, NEW.phone_enc
  ))
  EXECUTE FUNCTION app.record_contact_phone_change();

COMMIT;
