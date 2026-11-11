-- Passkeys (WebAuthn) as an MFA factor (D1.3, ARCHITECTURE §7).
-- * webauthn_credentials: user-scoped like users/sessions (no tenant data, no RLS). Credential IDs
--   are globally unique; the public key is stored as COSE bytes.
-- * auth_challenges gains session_id: passkey challenges are bound to the requesting session.
-- * users.mfa_enabled keeps its meaning, "has at least one MFA factor" (a TOTP secret or a
--   passkey), and is now maintained by the database, so the privileged-MFA triggers
--   (app.require_privileged_mfa, app.require_role_member_mfa) accept passkey-only users and stay
--   correct when a factor is removed. Losing the last factor while holding an MFA-required
--   permission is refused.
-- No existing rows are rewritten.
BEGIN;

ALTER TABLE "auth_challenges" ADD COLUMN "session_id" UUID;

CREATE TABLE "webauthn_credentials" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "credential_id" TEXT NOT NULL,
    "public_key" BYTEA NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[],
    "name" VARCHAR(60) NOT NULL,
    "device_type" VARCHAR(20) NOT NULL,
    "backed_up" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ,

    CONSTRAINT "webauthn_credentials_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "webauthn_credentials_credential_id_key" ON "webauthn_credentials"("credential_id");
CREATE UNIQUE INDEX "webauthn_credentials_user_id_name_key" ON "webauthn_credentials"("user_id", "name");
CREATE INDEX "auth_challenges_session_id_purpose_idx" ON "auth_challenges"("session_id", "purpose");
ALTER TABLE "auth_challenges" ADD CONSTRAINT "auth_challenges_session_id_fkey" FOREIGN KEY ("session_id")
  REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_user_id_fkey" FOREIGN KEY ("user_id")
  REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Base64url credential IDs (WebAuthn caps them at 1023 bytes), an unsigned 32-bit signature
-- counter, the shared transport list (packages/validation PASSKEY_TRANSPORTS) and trimmed names.
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_credential_id_check" CHECK (
  char_length(credential_id) BETWEEN 1 AND 1364 AND credential_id ~ '^[A-Za-z0-9_-]+$'
);
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_public_key_check" CHECK (
  octet_length(public_key) BETWEEN 1 AND 8192
);
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_counter_check" CHECK (
  counter BETWEEN 0 AND 4294967295
);
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_transports_check" CHECK (
  transports IS NOT NULL
  AND transports <@ ARRAY['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']::text[]
);
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_name_check" CHECK (
  char_length(name) >= 1 AND name = btrim(name)
);
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_device_type_check" CHECK (
  device_type IN ('singleDevice', 'multiDevice')
);
ALTER TABLE "auth_challenges" ADD CONSTRAINT "auth_challenges_passkey_session_check" CHECK (
  purpose NOT IN ('passkey-register', 'passkey-step-up') OR session_id IS NOT NULL
);

-- Until now a TOTP secret was the only factor, so mfa_enabled must mirror it exactly.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE mfa_enabled <> (mfa_secret IS NOT NULL)) THEN
    RAISE EXCEPTION 'users.mfa_enabled does not match the stored TOTP secrets; investigate first';
  END IF;
END
$$;

-- mfa_enabled = at least one factor. Recomputed whenever it or the TOTP secret is written (the
-- passkey trigger below writes it), so neither the application nor a bug can set it wrongly.
-- Dropping to no factor is refused while the user holds a membership whose role needs MFA.
CREATE FUNCTION app.maintain_user_mfa() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous_user text;
  privileged boolean;
BEGIN
  NEW.mfa_enabled := NEW.mfa_secret IS NOT NULL OR EXISTS (
    SELECT 1 FROM webauthn_credentials WHERE user_id = NEW.id
  );
  IF TG_OP = 'UPDATE' AND OLD.mfa_enabled AND NOT NEW.mfa_enabled THEN
    -- memberships and tenant_roles have forced RLS. Their read policies show a user's own
    -- memberships and the custom roles they hold, so look as the affected user (whatever the
    -- caller's context), then restore the caller's transaction-local context.
    previous_user := current_setting('app.user_id', true);
    PERFORM set_config('app.user_id', NEW.id::text, true);
    SELECT EXISTS (
      SELECT 1 FROM memberships m
      LEFT JOIN tenant_roles r ON r.tenant_id = m.tenant_id AND r.id = m.custom_role_id
      WHERE m.user_id = NEW.id AND CASE
        WHEN m.custom_role_id IS NULL THEN app.system_role_requires_mfa(m.role)
        -- An unreadable custom role fails closed, like the API's unresolved grant.
        ELSE COALESCE(app.permissions_require_mfa(r.permissions), true)
      END
    ) INTO privileged;
    PERFORM set_config('app.user_id', COALESCE(previous_user, ''), true);
    IF privileged THEN
      RAISE EXCEPTION 'A member holding an MFA-required permission must keep an MFA factor'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER user_mfa BEFORE INSERT OR UPDATE OF mfa_enabled, mfa_secret ON users
  FOR EACH ROW EXECUTE FUNCTION app.maintain_user_mfa();

-- Adding, moving or removing a passkey recomputes its owner's mfa_enabled (through user_mfa).
CREATE FUNCTION app.sync_passkey_factor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    UPDATE users SET mfa_enabled = (mfa_secret IS NOT NULL OR EXISTS (
      SELECT 1 FROM webauthn_credentials c WHERE c.user_id = users.id
    )) WHERE id = NEW.user_id;
  END IF;
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    UPDATE users SET mfa_enabled = (mfa_secret IS NOT NULL OR EXISTS (
      SELECT 1 FROM webauthn_credentials c WHERE c.user_id = users.id
    )) WHERE id = OLD.user_id;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER webauthn_credential_factor AFTER INSERT OR DELETE OR UPDATE OF user_id
  ON webauthn_credentials FOR EACH ROW EXECUTE FUNCTION app.sync_passkey_factor();

-- The privileged-MFA checks now share-lock the user rows they rely on. With user_mfa (which runs
-- under the row lock of the users UPDATE), a concurrent factor removal and role grant serialise:
-- whichever commits second sees the other and is refused. Otherwise unchanged from
-- 20261110080000_custom_roles.
CREATE OR REPLACE FUNCTION app.require_privileged_mfa() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  granted text[];
  privileged boolean;
BEGIN
  IF NEW.custom_role_id IS NULL THEN
    privileged := app.system_role_requires_mfa(NEW.role);
  ELSE
    -- FOR SHARE serialises with a concurrent permission change on the same role (whose
    -- tenant_role_mfa trigger waits for this transaction), so the two checks cannot both pass
    -- on stale data even without the application's tenant lock.
    SELECT permissions INTO granted FROM tenant_roles
      WHERE tenant_id = NEW.tenant_id AND id = NEW.custom_role_id
      FOR SHARE;
    IF NOT FOUND THEN
      -- Fail closed: the role must exist in, and be visible from, the membership's own tenant.
      RAISE EXCEPTION 'Custom role not found in this tenant' USING ERRCODE = '23503';
    END IF;
    privileged := app.permissions_require_mfa(granted);
  END IF;
  IF privileged THEN
    PERFORM 1 FROM users WHERE id = NEW.user_id FOR SHARE;
  END IF;
  IF privileged AND NOT EXISTS (
    SELECT 1 FROM users WHERE id = NEW.user_id AND mfa_enabled AND verified_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Privileged membership requires verified identity and enrolled MFA' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION app.require_role_member_mfa() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.permissions_require_mfa(NEW.permissions) THEN
    PERFORM 1 FROM users u WHERE u.id IN (
      SELECT m.user_id FROM memberships m
      WHERE m.tenant_id = NEW.tenant_id AND m.custom_role_id = NEW.id
    ) FOR SHARE OF u;
  END IF;
  IF app.permissions_require_mfa(NEW.permissions) AND EXISTS (
    SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.tenant_id = NEW.tenant_id AND m.custom_role_id = NEW.id
      AND NOT (u.mfa_enabled AND u.verified_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'Every holder of a privileged role requires verified identity and enrolled MFA' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION app.maintain_user_mfa() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.sync_passkey_factor() FROM PUBLIC;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON webauthn_credentials FROM pmb_app;

COMMIT;
