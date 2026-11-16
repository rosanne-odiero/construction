BEGIN;

CREATE TABLE worker_notification_jobs (
  event_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (tenant_id, event_id),
  FOREIGN KEY (tenant_id, event_id) REFERENCES outbox_events(tenant_id, id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX worker_notification_jobs_processed_at_created_at_idx ON worker_notification_jobs(processed_at, created_at);

CREATE TABLE worker_notifications (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  event_id uuid,
  project_id uuid,
  topic varchar(80) NOT NULL CHECK (topic IN ('worker.reminder', 'attendance.day_confirmed', 'payroll.batch_submitted', 'payroll.batch_cancelled', 'advance.disbursed')),
  channel varchar(10) NOT NULL CHECK (channel IN ('sms', 'whatsapp')),
  status varchar(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'accepted', 'unconfirmed', 'skipped')),
  reason varchar(20) CHECK (reason IN ('opted-out', 'access-lost', 'expired', 'budget', 'provider', 'interrupted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, event_id) REFERENCES outbox_events(tenant_id, id) ON DELETE CASCADE ON UPDATE CASCADE,
  UNIQUE (tenant_id, event_id, user_id, channel)
);
CREATE INDEX worker_notifications_tenant_id_user_id_created_at_idx ON worker_notifications(tenant_id, user_id, created_at);
CREATE INDEX worker_notifications_status_created_at_idx ON worker_notifications(status, created_at);

ALTER TABLE worker_notification_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_notification_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY worker_notification_jobs_tenant ON worker_notification_jobs
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
ALTER TABLE worker_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY worker_notifications_self ON worker_notifications
  USING (tenant_id = app.current_tenant_id() AND user_id = app.current_user_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND user_id = app.current_user_id());

-- Only new committed events enter this consumer; existing outbox consumers keep their own state.
CREATE FUNCTION app.enqueue_worker_notification() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.topic IN ('attendance.day_confirmed', 'payroll.batch_submitted', 'payroll.batch_cancelled', 'advance.disbursed') THEN
    INSERT INTO public.worker_notification_jobs(event_id, tenant_id) VALUES (NEW.id, NEW.tenant_id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER worker_notification_enqueue AFTER INSERT ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION app.enqueue_worker_notification();

-- Discovery exposes routing identifiers only, never contacts, preferences, wages or payloads.
DO $$
BEGIN
  EXECUTE format('CREATE POLICY worker_notification_jobs_scan ON worker_notification_jobs FOR SELECT USING (current_user = %L)', current_user);
  EXECUTE format('CREATE POLICY worker_notifications_scan ON worker_notifications FOR SELECT USING (current_user = %L)', current_user);
END $$;
CREATE FUNCTION app.due_worker_notification_jobs()
  RETURNS TABLE(tenant_id uuid, event_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT j.tenant_id, j.event_id FROM public.worker_notification_jobs j
  WHERE j.processed_at IS NULL
    AND (app.current_tenant_id() IS NULL OR j.tenant_id = app.current_tenant_id())
  ORDER BY j.created_at, j.event_id LIMIT 20
$$;
CREATE FUNCTION app.due_worker_notifications()
  RETURNS TABLE(tenant_id uuid, user_id uuid, id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT n.tenant_id, n.user_id, n.id FROM public.worker_notifications n
  WHERE (n.status = 'pending' OR (n.status = 'sending' AND n.updated_at < now() - interval '2 minutes'))
    AND (app.current_tenant_id() IS NULL OR n.tenant_id = app.current_tenant_id())
  ORDER BY n.created_at, n.id LIMIT 50
$$;
REVOKE ALL ON FUNCTION app.enqueue_worker_notification() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.due_worker_notification_jobs() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.due_worker_notifications() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmb_app') THEN
    REVOKE ALL ON worker_notification_jobs, worker_notifications FROM pmb_app;
    GRANT SELECT, INSERT, UPDATE ON worker_notification_jobs, worker_notifications TO pmb_app;
    GRANT EXECUTE ON FUNCTION app.due_worker_notification_jobs(), app.due_worker_notifications() TO pmb_app;
  END IF;
END $$;
COMMIT;
