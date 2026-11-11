BEGIN;

-- D3.3 (attendance) creates the same key; keep whichever ran first.
CREATE UNIQUE INDEX IF NOT EXISTS "sites_tenant_id_project_id_id_key" ON sites(tenant_id, project_id, id);
CREATE TABLE site_diaries (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  project_id UUID NOT NULL,
  site_id UUID NOT NULL,
  date DATE NOT NULL,
  work_performed VARCHAR(6000) NOT NULL CHECK (char_length(btrim(work_performed)) >= 1),
  weather VARCHAR(250),
  delays VARCHAR(2000),
  workforce_count INTEGER CHECK (workforce_count BETWEEN 0 AND 100000),
  status VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'rejected', 'approved')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by UUID NOT NULL,
  submitted_by UUID,
  submitted_at TIMESTAMPTZ,
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  review_reason VARCHAR(500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT site_diaries_tenant_id_site_id_date_key UNIQUE (tenant_id, site_id, date),
  CONSTRAINT site_diaries_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT site_diaries_site_fkey FOREIGN KEY (tenant_id, project_id, site_id)
    REFERENCES sites(tenant_id, project_id, id) ON DELETE RESTRICT,
  CONSTRAINT site_diaries_submission_check CHECK (
    (status = 'draft' AND submitted_by IS NULL AND submitted_at IS NULL)
    OR (status <> 'draft' AND submitted_by IS NOT NULL AND submitted_at IS NOT NULL)
  ),
  CONSTRAINT site_diaries_review_check CHECK (
    (status IN ('draft', 'submitted') AND reviewed_by IS NULL
      AND reviewed_at IS NULL AND review_reason IS NULL)
    OR (status IN ('approved', 'rejected') AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL
      AND reviewed_by <> created_by AND reviewed_by <> submitted_by
      AND ((status = 'approved' AND review_reason IS NULL)
        OR (status = 'rejected' AND review_reason IS NOT NULL
          AND char_length(btrim(review_reason)) BETWEEN 3 AND 500)))
  )
);
CREATE INDEX site_diaries_tenant_id_project_id_id_idx ON site_diaries(tenant_id, project_id, id);

CREATE FUNCTION app.guard_site_diary() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE project_status text;
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
  IF ROW(NEW.work_performed, NEW.weather, NEW.delays, NEW.workforce_count)
    IS DISTINCT FROM ROW(OLD.work_performed, OLD.weather, OLD.delays, OLD.workforce_count) THEN
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
CREATE TRIGGER site_diary_guard BEFORE INSERT OR UPDATE OR DELETE ON site_diaries
  FOR EACH ROW EXECUTE FUNCTION app.guard_site_diary();
ALTER TABLE site_diaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_diaries FORCE ROW LEVEL SECURITY;
CREATE POLICY site_diaries_isolation ON site_diaries
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmb_app') THEN
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON site_diaries FROM pmb_app;
  END IF;
END
$$;
REVOKE EXECUTE ON FUNCTION app.guard_site_diary() FROM PUBLIC;
COMMIT;
