ALTER TABLE attendance_capture_events ADD COLUMN initial_receipt jsonb;
GRANT UPDATE (initial_receipt) ON attendance_capture_events TO pmb_app;

CREATE FUNCTION app.freeze_attendance_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.initial_receipt IS NOT NULL AND NEW.initial_receipt IS DISTINCT FROM OLD.initial_receipt THEN
    RAISE EXCEPTION 'A durable capture receipt is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.initial_receipt IS NULL
    OR NEW.initial_receipt->>'eventId' IS DISTINCT FROM NEW.id::text
    OR NEW.initial_receipt->>'receiptId' IS DISTINCT FROM NEW.receipt_id::text THEN
    RAISE EXCEPTION 'Capture receipt identity mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION app.freeze_attendance_receipt() FROM PUBLIC;
CREATE TRIGGER attendance_receipt_freeze BEFORE UPDATE OF initial_receipt ON attendance_capture_events
  FOR EACH ROW EXECUTE FUNCTION app.freeze_attendance_receipt();
