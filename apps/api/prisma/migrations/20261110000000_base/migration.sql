-- D1.1 base migration: extensions and the helpers that row-level security policies use from D1.4
-- (ARCHITECTURE §6). Runs as the schema owner (pmb_migrator).

-- Trusted extensions: the database owner can create them without superuser rights.
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE SCHEMA IF NOT EXISTS app;

-- The API sets app.tenant_id / app.user_id with set_config(..., true) at the start of every
-- transaction. When they are unset these return NULL, so tenant policies match no rows (fail closed).
CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

-- The application role (created by infrastructure, not by migrations) may call the helpers.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmb_app') THEN
    GRANT USAGE ON SCHEMA app TO pmb_app;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO pmb_app;
  END IF;
END
$$;
