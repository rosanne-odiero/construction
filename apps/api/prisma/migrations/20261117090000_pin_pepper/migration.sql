-- Labourer PIN pepper (apps/api/src/modules/identity/pin-pepper.ts): the version of
-- AUTH_PIN_PEPPER_KEYS a PIN hash was made with. Null means an older, unpeppered hash; a correct
-- sign-in re-hashes it under the active key.
BEGIN;

ALTER TABLE "users" ADD COLUMN "pin_pepper_version" SMALLINT;
ALTER TABLE "users" ADD CONSTRAINT "users_pin_pepper_version_check" CHECK (
  pin_pepper_version IS NULL
  OR (pin_pepper_version BETWEEN 1 AND 255 AND pin_hash IS NOT NULL)
);

COMMIT;
