-- Google sign-in: external identities linked to users. User-scoped like sessions and passkeys
-- (no tenant data, no RLS). One Google account per user and one user per Google account.
BEGIN;

CREATE TABLE "user_identities" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" VARCHAR(20) NOT NULL,
    "subject" VARCHAR(255) NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_identities_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "user_identities_provider_subject_key" ON "user_identities"("provider", "subject");
CREATE UNIQUE INDEX "user_identities_user_id_provider_key" ON "user_identities"("user_id", "provider");
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_fkey" FOREIGN KEY ("user_id")
  REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_provider_check" CHECK (provider = 'google');
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_subject_check" CHECK (
  char_length(subject) BETWEEN 1 AND 255 AND subject !~ '[[:cntrl:]]'
);
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_email_check" CHECK (
  email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+$'
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmb_app') THEN
    REVOKE TRUNCATE, REFERENCES, TRIGGER ON "user_identities" FROM pmb_app;
  END IF;
END
$$;

COMMIT;
