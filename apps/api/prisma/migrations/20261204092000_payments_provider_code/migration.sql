-- D4.2 independent review: a provider or transport code is kept up to 100 characters, the length
-- the domain keeps (PROVIDER_CODE_MAX). At 30, a long TLS error code (such as
-- UNABLE_TO_GET_ISSUER_CERT_LOCALLY) could not be stored, so a call that never left could not be
-- recorded as failed and waited for its lease to expire instead. Widening a varchar rewrites nothing.
BEGIN;

ALTER TABLE "payment_attempts" ALTER COLUMN "provider_code" TYPE VARCHAR(100);

COMMIT;
