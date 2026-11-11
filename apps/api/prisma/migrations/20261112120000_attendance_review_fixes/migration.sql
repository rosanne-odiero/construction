-- D3.3 review fixes (follow-up to 20261112090000_attendance_timesheets; that migration is unchanged
-- so a database that already applied it simply migrates forward).
-- 1. A person who rejected a period can submit it again after it is reopened: maker ≠ checker for
--    a rejection applies while the period is rejected (the last rejection stays on the row as
--    history; every rejection is in the audit log). Approval keeps approved_by <> submitted_by.
-- 2. A new anomaly kind, locked_share_changed: another record of a labourer's day changed after one
--    project's period was approved, so that project's approved share no longer matches the
--    recomputed day (the API proposes an adjustment and blocks the open period until it is decided).
-- 3. No lost update on corrections: a day cannot be returned to draft while a correction is
--    pending, and a correction is approved only while its day is submitted or confirmed and the
--    record still holds the values the correction was asked against.

ALTER TABLE "timesheet_periods" DROP CONSTRAINT "timesheet_periods_maker_checker_check";
ALTER TABLE "timesheet_periods" ADD CONSTRAINT "timesheet_periods_maker_checker_check" CHECK (
  (approved_by IS NULL OR approved_by <> submitted_by)
  AND (status <> 'rejected' OR rejected_by <> submitted_by)
);

ALTER TABLE "attendance_anomalies" DROP CONSTRAINT "attendance_anomalies_vocabulary_check";
ALTER TABLE "attendance_anomalies" ADD CONSTRAINT "attendance_anomalies_vocabulary_check" CHECK (
  kind IN ('two_sites', 'overlapping_times', 'excess_hours', 'not_engaged', 'labourer_inactive',
    'do_not_rehire', 'accreditation_invalid', 'manual_override', 'locked_share_changed')
  AND severity IN ('critical', 'warning', 'info')
  AND status IN ('open', 'resolved', 'dismissed', 'cleared')
  AND jsonb_typeof(details) = 'object' AND version >= 1
  AND (review_note IS NULL OR char_length(btrim(review_note)) BETWEEN 3 AND 500)
);

-- "07:30" → 450 (null stays null); the same 24-hour format as packages/validation clockSchema.
CREATE FUNCTION app.clock_minutes(value text) RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN value IS NULL THEN NULL
    ELSE split_part(value, ':', 1)::integer * 60 + split_part(value, ':', 2)::integer END
$$;

CREATE OR REPLACE FUNCTION app.guard_attendance_day() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  period record;
BEGIN
  SELECT status, start_date, end_date INTO period FROM timesheet_periods
  WHERE tenant_id = NEW.tenant_id AND id = NEW.period_id;
  IF period.status IS NULL OR period.status NOT IN ('open', 'rejected') THEN
    RAISE EXCEPTION 'The timesheet period is locked' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'A muster day starts as a draft' USING ERRCODE = '23514';
    END IF;
    IF NEW.work_date NOT BETWEEN period.start_date AND period.end_date THEN
      RAISE EXCEPTION 'The day is outside its period' USING ERRCODE = '23514';
    END IF;
    IF NEW.work_date > app.nairobi_today() THEN
      RAISE EXCEPTION 'Attendance cannot be recorded for a future date' USING ERRCODE = '23514';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.site_id IS DISTINCT FROM OLD.site_id
     OR NEW.work_date IS DISTINCT FROM OLD.work_date OR NEW.period_id IS DISTINCT FROM OLD.period_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Muster day identity cannot change' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'confirmed' THEN
    RAISE EXCEPTION 'A confirmed day is final; use a correction' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status = 'draft' AND NEW.status = 'submitted' THEN
      IF NOT EXISTS (
        SELECT 1 FROM attendance_records r WHERE r.tenant_id = NEW.tenant_id AND r.day_id = NEW.id
      ) THEN
        RAISE EXCEPTION 'An empty day cannot be submitted' USING ERRCODE = '23514';
      END IF;
      NEW.submitted_at := now();
    ELSIF OLD.status = 'submitted' AND NEW.status = 'confirmed' THEN
      IF EXISTS (
        SELECT 1 FROM attendance_records r
        WHERE r.tenant_id = NEW.tenant_id AND r.day_id = NEW.id
          AND (r.created_by = NEW.confirmed_by OR r.updated_by = NEW.confirmed_by)
      ) THEN
        RAISE EXCEPTION 'Someone who recorded the day cannot confirm it' USING ERRCODE = '23514';
      END IF;
      NEW.confirmed_at := now();
    ELSIF OLD.status = 'submitted' AND NEW.status = 'draft' THEN
      IF NEW.returned_by IS NULL OR NEW.returned_by = OLD.submitted_by THEN
        RAISE EXCEPTION 'A day is returned by someone other than its submitter'
          USING ERRCODE = '23514';
      END IF;
      -- Review fix: a pending correction was asked against the submitted values; returning the
      -- day would let the recorder change them and the correction overwrite the newer values.
      IF EXISTS (
        SELECT 1 FROM attendance_corrections c
        WHERE c.tenant_id = NEW.tenant_id AND c.day_id = NEW.id AND c.status = 'pending'
      ) THEN
        RAISE EXCEPTION 'Decide the pending corrections before returning the day'
          USING ERRCODE = '23514';
      END IF;
      NEW.returned_at := now();
    ELSE
      RAISE EXCEPTION 'Invalid muster day transition' USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'A submitted day changes only through a transition' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION app.guard_attendance_correction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  day record;
  period_status text;
BEGIN
  SELECT status, period_id, work_date, site_id INTO day FROM attendance_days
  WHERE tenant_id = NEW.tenant_id AND id = NEW.day_id;
  SELECT status INTO period_status FROM timesheet_periods
  WHERE tenant_id = NEW.tenant_id AND id = day.period_id;
  IF period_status IS NULL OR period_status NOT IN ('open', 'rejected') THEN
    RAISE EXCEPTION 'The timesheet period is locked' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'A correction starts pending' USING ERRCODE = '23514';
    END IF;
    IF day.status NOT IN ('submitted', 'confirmed') THEN
      RAISE EXCEPTION 'Draft days are edited directly' USING ERRCODE = '23514';
    END IF;
    IF NEW.record_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM attendance_records r
      WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.record_id AND r.day_id = NEW.day_id
        AND r.labourer_id = NEW.labourer_id
    ) THEN
      RAISE EXCEPTION 'The record belongs to another day or labourer' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM attendance_corrections c
      WHERE c.tenant_id = NEW.tenant_id AND c.day_id = NEW.day_id
        AND c.labourer_id = NEW.labourer_id AND c.status = 'pending'
    ) THEN
      RAISE EXCEPTION 'A correction is already pending' USING ERRCODE = '23514';
    END IF;
    NEW.requested_at := now();
    RETURN NEW;
  END IF;
  IF OLD.status <> 'pending' OR NEW.status NOT IN ('approved', 'rejected')
     OR NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.day_id IS DISTINCT FROM OLD.day_id OR NEW.site_id IS DISTINCT FROM OLD.site_id
     OR NEW.work_date IS DISTINCT FROM OLD.work_date OR NEW.record_id IS DISTINCT FROM OLD.record_id
     OR NEW.labourer_id IS DISTINCT FROM OLD.labourer_id
     OR NEW.proposed IS DISTINCT FROM OLD.proposed OR NEW.previous IS DISTINCT FROM OLD.previous
     OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    RAISE EXCEPTION 'A correction is decided once and never rewritten' USING ERRCODE = '23514';
  END IF;
  -- Review fix: a correction is approved only while its day is still submitted or confirmed and
  -- the record still holds the values the correction was asked against (no lost update).
  IF NEW.status = 'approved' THEN
    IF day.status NOT IN ('submitted', 'confirmed') THEN
      RAISE EXCEPTION 'The day was returned; ask for the correction again' USING ERRCODE = '23514';
    END IF;
    IF OLD.record_id IS NULL THEN
      IF EXISTS (
        SELECT 1 FROM attendance_records r
        WHERE r.tenant_id = NEW.tenant_id AND r.day_id = NEW.day_id
          AND r.labourer_id = NEW.labourer_id
      ) THEN
        RAISE EXCEPTION 'The record changed after the correction was asked for'
          USING ERRCODE = '23514';
      END IF;
    ELSIF NOT EXISTS (
      SELECT 1 FROM attendance_records r
      WHERE r.tenant_id = NEW.tenant_id AND r.id = OLD.record_id
        AND r.status = OLD.previous ->> 'status'
        AND r.check_in_minutes IS NOT DISTINCT FROM app.clock_minutes(OLD.previous ->> 'checkIn')
        AND r.check_out_minutes IS NOT DISTINCT FROM app.clock_minutes(OLD.previous ->> 'checkOut')
        AND r.overnight = (OLD.previous ->> 'overnight')::boolean
        AND r.break_minutes IS NOT DISTINCT FROM (OLD.previous ->> 'breakMinutes')::integer
        AND r.notes IS NOT DISTINCT FROM OLD.previous ->> 'notes'
    ) THEN
      RAISE EXCEPTION 'The record changed after the correction was asked for'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.decided_at := now();
  RETURN NEW;
END
$$;
