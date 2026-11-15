-- D6.1 site diary workforce from attendance (brief §5.9 "workforce by trade (auto-filled from
-- attendance)"; ARCHITECTURE §4.7; WORKFLOWS "Site diary"). A diary's workforce is either typed in
-- (`manual`, the count may be unknown) or a snapshot of attendance on the diary's site and date
-- (`attendance`): headcount by trade (present or half day), the muster sheet's state and the time
-- of the snapshot. The database recomputes the snapshot from attendance whenever one is stored, so
-- an attendance-sourced count can never be forged, and the existing sign-off guard now also keeps
-- the workforce fixed during sign-off and after approval.
-- Existing diaries keep their manual counts (the new column defaults to `manual`).
BEGIN;

-- AlterTable
ALTER TABLE "site_diaries" ADD COLUMN     "workforce_by_trade" JSONB,
ADD COLUMN     "workforce_muster_status" VARCHAR(12),
ADD COLUMN     "workforce_snapshot_at" TIMESTAMPTZ,
ADD COLUMN     "workforce_source" VARCHAR(12) NOT NULL DEFAULT 'manual';

-- packages/types WORKFORCE_SOURCES and WORKFORCE_MUSTER_STATES.
ALTER TABLE "site_diaries" ADD CONSTRAINT "site_diaries_workforce_check" CHECK (
  workforce_source IN ('manual', 'attendance')
  AND CASE workforce_source
    WHEN 'manual' THEN workforce_snapshot_at IS NULL AND workforce_muster_status IS NULL
      AND workforce_by_trade IS NULL
    ELSE workforce_count IS NOT NULL AND workforce_snapshot_at IS NOT NULL
      AND workforce_muster_status IN ('none', 'draft', 'submitted', 'confirmed')
      AND jsonb_typeof(workforce_by_trade) = 'array'
  END
);

-- Attendance on one site and date by trade (packages/domain summariseWorkforce): everyone present
-- or on a half day counts once under their trade, in the company's trade order then by key
-- (code-point order); `muster` is the muster sheet's state or `none`.
CREATE FUNCTION app.diary_attendance_workforce(
  target_tenant uuid, target_site uuid, target_date date,
  OUT by_trade jsonb, OUT total integer, OUT muster text
) LANGUAGE plpgsql STABLE AS $$
BEGIN
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'tradeId', t.id, 'key', t.key, 'nameEn', t.name_en, 'nameSw', t.name_sw,
      'headcount', c.headcount, 'halfDays', c.half_days)
      ORDER BY t.sort_order, t.key COLLATE "C"), '[]'::jsonb),
    COALESCE(sum(c.headcount), 0)::integer
    INTO by_trade, total
    FROM (
      SELECT l.trade_id, count(*)::integer AS headcount,
        (count(*) FILTER (WHERE r.status = 'half_day'))::integer AS half_days
        FROM attendance_records r
        JOIN labourers l ON l.tenant_id = r.tenant_id AND l.id = r.labourer_id
       WHERE r.tenant_id = target_tenant AND r.site_id = target_site
         AND r.work_date = target_date AND r.status IN ('present', 'half_day')
       GROUP BY l.trade_id
    ) c
    JOIN trades t ON t.tenant_id = target_tenant AND t.id = c.trade_id;
  SELECT COALESCE((SELECT d.status FROM attendance_days d
     WHERE d.tenant_id = target_tenant AND d.site_id = target_site AND d.work_date = target_date),
    'none') INTO muster;
END
$$;

-- The diary guard from 20261116090000_site_diary_foundation, extended: an attendance snapshot is
-- re-checked against attendance and stamped with the database clock when a draft stores one, and
-- the workforce columns are content (fixed during sign-off and once approved).
CREATE OR REPLACE FUNCTION app.guard_site_diary() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  project_status text;
  snapshot record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Site diaries cannot be deleted' USING ERRCODE = '42501';
  END IF;
  SELECT status INTO project_status FROM projects
    WHERE tenant_id = NEW.tenant_id AND id = NEW.project_id FOR SHARE;
  IF project_status IN ('closed', 'cancelled') THEN
    RAISE EXCEPTION 'Closed and cancelled projects are read-only' USING ERRCODE = '23514';
  END IF;
  IF NEW.date > (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi')::date THEN
    RAISE EXCEPTION 'A diary cannot be future dated' USING ERRCODE = '23514';
  END IF;
  IF NEW.workforce_source = 'attendance' AND NEW.status = 'draft' AND (TG_OP = 'INSERT'
      OR (OLD.status = 'draft' AND ROW(NEW.workforce_source, NEW.workforce_count,
        NEW.workforce_muster_status, NEW.workforce_by_trade, NEW.workforce_snapshot_at)
        IS DISTINCT FROM ROW(OLD.workforce_source, OLD.workforce_count,
        OLD.workforce_muster_status, OLD.workforce_by_trade, OLD.workforce_snapshot_at))) THEN
    SELECT * INTO snapshot FROM app.diary_attendance_workforce(NEW.tenant_id, NEW.site_id, NEW.date);
    IF NEW.workforce_by_trade IS DISTINCT FROM snapshot.by_trade
      OR NEW.workforce_count IS DISTINCT FROM snapshot.total
      OR NEW.workforce_muster_status IS DISTINCT FROM snapshot.muster THEN
      RAISE EXCEPTION 'An attendance workforce must match attendance when the snapshot is taken'
        USING ERRCODE = '23514';
    END IF;
    NEW.workforce_snapshot_at := now();
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.version <> 1
      OR NEW.created_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'A diary starts as the authenticated author draft' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'approved' THEN
    RAISE EXCEPTION 'Approved diaries are locked' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.id, NEW.tenant_id, NEW.project_id, NEW.site_id, NEW.date, NEW.created_by, NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.id, OLD.tenant_id, OLD.project_id, OLD.site_id, OLD.date, OLD.created_by, OLD.created_at)
    OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Diary identity is fixed and its version must advance' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = OLD.status THEN
    IF OLD.status <> 'draft' OR OLD.created_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'Only the author can edit a draft' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.work_performed, NEW.weather, NEW.delays, NEW.workforce_count, NEW.workforce_source,
      NEW.workforce_snapshot_at, NEW.workforce_muster_status, NEW.workforce_by_trade)
    IS DISTINCT FROM ROW(OLD.work_performed, OLD.weather, OLD.delays, OLD.workforce_count,
      OLD.workforce_source, OLD.workforce_snapshot_at, OLD.workforce_muster_status,
      OLD.workforce_by_trade) THEN
    RAISE EXCEPTION 'Content cannot change during sign-off' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'draft' AND NEW.status = 'submitted' THEN
    IF OLD.created_by IS DISTINCT FROM app.current_user_id()
      OR NEW.submitted_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'Only the author can submit' USING ERRCODE = '23514';
    END IF;
    NEW.submitted_at := CURRENT_TIMESTAMP;
  ELSIF OLD.status = 'submitted' AND NEW.status IN ('approved', 'rejected') THEN
    IF NEW.reviewed_by IS DISTINCT FROM app.current_user_id()
      OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
      OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
      RAISE EXCEPTION 'Review must identify the authenticated reviewer' USING ERRCODE = '23514';
    END IF;
    NEW.reviewed_at := CURRENT_TIMESTAMP;
  ELSIF OLD.status = 'rejected' AND NEW.status = 'draft' THEN
    IF OLD.created_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'Only the author can reopen' USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'Invalid diary transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmb_app') THEN
    GRANT EXECUTE ON FUNCTION app.diary_attendance_workforce(uuid, uuid, date) TO pmb_app;
  END IF;
END
$$;
REVOKE EXECUTE ON FUNCTION app.diary_attendance_workforce(uuid, uuid, date) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_site_diary() FROM PUBLIC;

COMMIT;
