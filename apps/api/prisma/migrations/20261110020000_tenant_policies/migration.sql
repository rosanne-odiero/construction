CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
ALTER TABLE project_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;

-- A user may discover their own memberships before selecting a tenant. This does not grant
-- write access or visibility of other members. All other data uses transaction-local context.
CREATE POLICY memberships_read ON memberships FOR SELECT USING (
  tenant_id = app.current_tenant_id() OR user_id = app.current_user_id()
);
CREATE POLICY memberships_insert ON memberships FOR INSERT WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY memberships_update ON memberships FOR UPDATE
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY memberships_delete ON memberships FOR DELETE USING (tenant_id = app.current_tenant_id());

CREATE POLICY tenants_read ON tenants FOR SELECT USING (
  tenant_id = app.current_tenant_id() OR EXISTS (
    SELECT 1 FROM memberships m WHERE m.tenant_id = tenants.tenant_id AND m.user_id = app.current_user_id()
  )
);
CREATE POLICY tenants_insert ON tenants FOR INSERT WITH CHECK (
  tenant_id = app.current_tenant_id() AND created_by = app.current_user_id()
);
CREATE POLICY tenants_update ON tenants FOR UPDATE
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY projects_isolation ON projects
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY project_memberships_isolation ON project_memberships
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

-- Invitation redemption bootstraps tenant context only for the verified recipient. Tokens
-- remain hashed and the API additionally requires the exact unexpired, single-use token.
CREATE POLICY invitations_read ON invitations FOR SELECT USING (
  tenant_id = app.current_tenant_id() OR identifier = (
    SELECT identifier FROM users WHERE id = app.current_user_id() AND verified_at IS NOT NULL
  )
);
CREATE POLICY invitations_insert ON invitations FOR INSERT WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY invitations_update ON invitations FOR UPDATE
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY invitations_delete ON invitations FOR DELETE USING (tenant_id = app.current_tenant_id());

CREATE POLICY audit_read ON audit_events FOR SELECT USING (tenant_id = app.current_tenant_id());
CREATE POLICY audit_insert ON audit_events FOR INSERT WITH CHECK (
  tenant_id = app.current_tenant_id() AND actor_id = app.current_user_id()
);

ALTER TABLE memberships ADD CONSTRAINT memberships_role_check CHECK (
  role IN ('owner','project_manager','site_agent','foreman','quantity_surveyor','storekeeper','finance','client','consultant','supplier')
);
ALTER TABLE invitations ADD CONSTRAINT invitations_role_check CHECK (
  role IN ('owner','project_manager','site_agent','foreman','quantity_surveyor','storekeeper','finance','client','consultant','supplier')
);
ALTER TABLE project_memberships ADD CONSTRAINT project_permissions_check CHECK (
  permissions <@ ARRAY['project.read','project.update','project.members.manage']::text[]
);

CREATE FUNCTION app.require_privileged_mfa() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role IN ('owner', 'finance') AND NOT EXISTS (
    SELECT 1 FROM users WHERE id = NEW.user_id AND mfa_enabled AND verified_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Privileged membership requires verified identity and enrolled MFA' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER membership_mfa BEFORE INSERT OR UPDATE ON memberships
  FOR EACH ROW EXECUTE FUNCTION app.require_privileged_mfa();

CREATE FUNCTION app.chain_audit_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text, 0));
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
CREATE TRIGGER audit_chain BEFORE INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION app.chain_audit_event();

CREATE FUNCTION app.reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Audit events are append-only' USING ERRCODE = '42501';
END
$$;
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_audit_mutation();

REVOKE ALL ON audit_events FROM pmb_app;
GRANT SELECT, INSERT ON audit_events TO pmb_app;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM pmb_app;
REVOKE EXECUTE ON FUNCTION app.chain_audit_event() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.reject_audit_mutation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.require_privileged_mfa() FROM PUBLIC;
