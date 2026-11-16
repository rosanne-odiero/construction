CREATE TABLE attendance_devices (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  name varchar(100) NOT NULL,
  public_key char(64) NOT NULL CHECK (public_key ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, public_key),
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE attendance_device_leases (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  device_id uuid NOT NULL,
  boot_id uuid NOT NULL,
  device_time timestamptz NOT NULL,
  monotonic_ms double precision NOT NULL CHECK (monotonic_ms >= 0 AND monotonic_ms < 'Infinity'::float8),
  server_time timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  UNIQUE (tenant_id, device_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES attendance_devices(tenant_id, id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CHECK (expires_at > server_time AND expires_at <= server_time + interval '72 hours')
);
CREATE TABLE attendance_worker_cards (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  labourer_id uuid NOT NULL,
  token_digest char(64) NOT NULL UNIQUE CHECK (token_digest ~ '^[a-f0-9]{64}$'),
  issued_by uuid NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, labourer_id) REFERENCES labourers(tenant_id, id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE attendance_capture_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  device_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  project_id uuid NOT NULL,
  site_id uuid NOT NULL,
  labourer_id uuid NOT NULL,
  card_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  direction varchar(3) NOT NULL CHECK (direction IN ('in', 'out')),
  captured_at timestamptz NOT NULL,
  user_id uuid NOT NULL,
  fingerprint char(64) NOT NULL,
  envelope jsonb NOT NULL,
  signature char(128) NOT NULL,
  photo_encrypted text NOT NULL,
  receipt_id uuid NOT NULL UNIQUE,
  received_at timestamptz NOT NULL DEFAULT now(),
  status varchar(20) NOT NULL CHECK (status IN ('confirmed', 'quarantined')),
  flags text[] NOT NULL,
  record_id uuid,
  decision varchar(10),
  review_reason varchar(500),
  reviewed_by uuid,
  reviewed_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id, lease_id) REFERENCES attendance_device_leases(tenant_id, device_id, id) ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY (tenant_id, project_id, site_id) REFERENCES sites(tenant_id, project_id, id) ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY (tenant_id, card_id) REFERENCES attendance_worker_cards(tenant_id, id) ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY (tenant_id, record_id) REFERENCES attendance_records(tenant_id, id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CHECK ((status = 'confirmed' AND cardinality(flags) = 0) OR (status = 'quarantined' AND cardinality(flags) > 0)),
  CHECK (
    (decision IS NULL AND review_reason IS NULL AND reviewed_by IS NULL AND reviewed_at IS NULL)
    OR (decision IN ('resolve', 'dismiss') AND length(review_reason) BETWEEN 10 AND 500
      AND reviewed_by IS NOT NULL AND reviewed_by <> user_id AND reviewed_at IS NOT NULL)
  )
);
CREATE INDEX attendance_capture_events_tenant_id_labourer_id_captured_at_idx
  ON attendance_capture_events(tenant_id, labourer_id, captured_at);
CREATE INDEX attendance_capture_events_tenant_id_project_id_received_at_idx
  ON attendance_capture_events(tenant_id, project_id, received_at);
CREATE INDEX attendance_capture_events_tenant_id_device_id_shift_id_direction_idx
  ON attendance_capture_events(tenant_id, device_id, shift_id, direction);

DO $$
DECLARE tab text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['attendance_devices','attendance_device_leases','attendance_worker_cards','attendance_capture_events']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tab);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tab);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id())', tab);
    EXECUTE format('REVOKE ALL ON %I FROM pmb_app', tab);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO pmb_app', tab);
  END LOOP;
END $$;
GRANT UPDATE (revoked_at) ON attendance_devices, attendance_worker_cards TO pmb_app;
GRANT UPDATE (record_id, decision, review_reason, reviewed_by, reviewed_at)
  ON attendance_capture_events TO pmb_app;

CREATE FUNCTION app.guard_attendance_capture() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'attendance_devices' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.user_id <> app.current_user_id() THEN
        RAISE EXCEPTION 'Device owner must be the actor' USING ERRCODE = '23514';
      END IF;
      NEW.created_at := now();
      NEW.revoked_at := NULL;
    ELSIF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
      RAISE EXCEPTION 'Device revocation is final' USING ERRCODE = '23514';
    ELSE NEW.revoked_at := now();
    END IF;
  ELSIF TG_TABLE_NAME = 'attendance_worker_cards' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.issued_by <> app.current_user_id() THEN
        RAISE EXCEPTION 'Card issuer must be the actor' USING ERRCODE = '23514';
      END IF;
      NEW.issued_at := now();
      NEW.revoked_at := NULL;
    ELSIF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
      RAISE EXCEPTION 'Card revocation is final' USING ERRCODE = '23514';
    ELSE NEW.revoked_at := now();
    END IF;
  ELSIF TG_TABLE_NAME = 'attendance_device_leases' THEN
    IF NOT EXISTS (SELECT 1 FROM attendance_devices d WHERE d.tenant_id = NEW.tenant_id
      AND d.id = NEW.device_id AND d.user_id = app.current_user_id() AND d.revoked_at IS NULL) THEN
      RAISE EXCEPTION 'Active owned device required' USING ERRCODE = '23514';
    END IF;
    NEW.server_time := now();
    NEW.expires_at := NEW.server_time + interval '72 hours';
  ELSIF TG_TABLE_NAME = 'attendance_capture_events' THEN
    IF TG_OP = 'INSERT' THEN
      SELECT user_id INTO owner_id FROM attendance_devices
        WHERE tenant_id = NEW.tenant_id AND id = NEW.device_id AND revoked_at IS NULL;
      IF owner_id IS DISTINCT FROM app.current_user_id() OR NEW.user_id <> owner_id
        OR NOT EXISTS (SELECT 1 FROM attendance_worker_cards c
          WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.card_id AND c.labourer_id = NEW.labourer_id) THEN
        RAISE EXCEPTION 'Capture identity mismatch' USING ERRCODE = '23514';
      END IF;
      NEW.received_at := now();
      IF NEW.decision IS NOT NULL OR NEW.record_id IS NOT NULL THEN
        RAISE EXCEPTION 'New capture must be undecided' USING ERRCODE = '23514';
      END IF;
    ELSE
      IF OLD.decision IS NOT NULL AND
        (NEW.decision, NEW.review_reason, NEW.reviewed_by, NEW.reviewed_at)
          IS DISTINCT FROM (OLD.decision, OLD.review_reason, OLD.reviewed_by, OLD.reviewed_at) THEN
        RAISE EXCEPTION 'Review is final' USING ERRCODE = '23514';
      END IF;
      IF OLD.record_id IS NOT NULL AND NEW.record_id IS DISTINCT FROM OLD.record_id THEN
        RAISE EXCEPTION 'Capture allocation is final' USING ERRCODE = '23514';
      END IF;
      IF NEW.decision IS DISTINCT FROM OLD.decision THEN
        IF NEW.reviewed_by IS DISTINCT FROM app.current_user_id() THEN
          RAISE EXCEPTION 'Reviewer must be the actor' USING ERRCODE = '23514';
        END IF;
        NEW.reviewed_at := now();
      END IF;
      IF NEW.record_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM attendance_records r WHERE r.tenant_id = NEW.tenant_id
          AND r.id = NEW.record_id AND r.labourer_id = NEW.labourer_id
          AND r.site_id = NEW.site_id AND r.project_id = NEW.project_id
      ) THEN
        RAISE EXCEPTION 'Capture allocation identity mismatch' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION app.guard_attendance_capture() FROM PUBLIC;
CREATE TRIGGER attendance_device_guard BEFORE INSERT OR UPDATE ON attendance_devices
  FOR EACH ROW EXECUTE FUNCTION app.guard_attendance_capture();
CREATE TRIGGER attendance_lease_guard BEFORE INSERT ON attendance_device_leases
  FOR EACH ROW EXECUTE FUNCTION app.guard_attendance_capture();
CREATE TRIGGER attendance_card_guard BEFORE INSERT OR UPDATE ON attendance_worker_cards
  FOR EACH ROW EXECUTE FUNCTION app.guard_attendance_capture();
CREATE TRIGGER attendance_capture_guard BEFORE INSERT OR UPDATE ON attendance_capture_events
  FOR EACH ROW EXECUTE FUNCTION app.guard_attendance_capture();

