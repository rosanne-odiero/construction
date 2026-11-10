CREATE OR REPLACE FUNCTION app.chain_audit_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text, 0));
  -- Allocate the authoritative sequence only after locking. The column's default may
  -- already have allocated an unused value; gaps are intentional, ordering is not.
  NEW.sequence := nextval(pg_get_serial_sequence('audit_events', 'sequence'));
  SELECT hash INTO NEW.previous_hash FROM audit_events
    WHERE tenant_id = NEW.tenant_id ORDER BY sequence DESC LIMIT 1;
  NEW.previous_hash := COALESCE(NEW.previous_hash, repeat('0',64));
  NEW.hash := encode(digest(convert_to(jsonb_build_object(
    'id', NEW.id, 'tenant_id', NEW.tenant_id, 'actor_id', NEW.actor_id,
    'action', NEW.action, 'resource_id', NEW.resource_id, 'request_id', NEW.request_id,
    'metadata', NEW.metadata, 'created_at', NEW.created_at, 'sequence', NEW.sequence,
    'previous_hash', NEW.previous_hash
  )::text, 'UTF8'), 'sha256'), 'hex');
  RETURN NEW;
END
$$;
