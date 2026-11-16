CREATE FUNCTION app.hold_timesheet_for_capture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('submitted', 'approved') AND NEW.status IS DISTINCT FROM OLD.status
    AND EXISTS (
      SELECT 1 FROM attendance_capture_events e
      WHERE e.tenant_id = NEW.tenant_id AND e.project_id = NEW.project_id
        AND e.record_id IS NULL AND e.decision IS NULL
        AND (e.captured_at AT TIME ZONE 'Africa/Nairobi')::date BETWEEN NEW.start_date AND NEW.end_date
    ) THEN
    RAISE EXCEPTION 'Unallocated site evidence needs human review' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION app.hold_timesheet_for_capture() FROM PUBLIC;
CREATE TRIGGER timesheet_capture_hold BEFORE UPDATE OF status ON timesheet_periods
  FOR EACH ROW EXECUTE FUNCTION app.hold_timesheet_for_capture();
