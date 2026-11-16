-- D4.2 independent review fixes (docs/IMPLEMENTATION_STATUS.md "Independent review of D4.2").
BEGIN;

-- A provider or transport code is kept up to 100 characters, the length the domain keeps
-- (PROVIDER_CODE_MAX). At 30, a long TLS error code (such as UNABLE_TO_GET_ISSUER_CERT_LOCALLY)
-- could not be stored, so a call that never left could not be recorded as failed and waited for
-- its lease to expire instead. Widening a varchar rewrites nothing.
ALTER TABLE "payment_attempts" ALTER COLUMN "provider_code" TYPE VARCHAR(100);

-- Timeline order: events written in one transaction (an attempt's "created" and "queued") shared
-- the transaction's now(), so the console could list them in either order. Each payment event is
-- stamped with the clock when it is inserted, so the timeline follows the order of writing.
CREATE FUNCTION app.stamp_payment_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION app.stamp_payment_event() FROM PUBLIC;
DROP TRIGGER payment_events_stamp ON "payment_events";
CREATE TRIGGER payment_events_stamp BEFORE INSERT ON "payment_events"
  FOR EACH ROW EXECUTE FUNCTION app.stamp_payment_event();

COMMIT;
