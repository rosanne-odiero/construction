-- Permission-based RBAC with tenant custom roles (D1.4, ARCHITECTURE §8).
-- System roles stay immutable in code (packages/types SYSTEM_ROLE_PERMISSIONS). A company can add
-- custom roles made of catalogue permissions; memberships and invitations reference either a
-- system role key or a custom role through a composite (tenant_id, id) foreign key, so a row can
-- never point at another company's role. No existing rows are read or rewritten: the new columns
-- are nullable and the new CHECK constraints hold for every existing system-role row.
BEGIN;

CREATE TABLE "tenant_roles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" CITEXT NOT NULL,
    "permissions" TEXT[],
    "tenant_wide" BOOLEAN NOT NULL DEFAULT false,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "tenant_roles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tenant_roles_tenant_id_id_key" ON "tenant_roles"("tenant_id", "id");
-- citext: role names are unique per company regardless of case.
CREATE UNIQUE INDEX "tenant_roles_tenant_id_name_key" ON "tenant_roles"("tenant_id", "name");
ALTER TABLE "tenant_roles" ADD CONSTRAINT "tenant_roles_tenant_id_fkey" FOREIGN KEY ("tenant_id")
  REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Only tenant catalogue permissions (packages/types TENANT_PERMISSIONS); platform.admin is never
-- grantable by a company. A new catalogue permission needs a migration extending this list.
ALTER TABLE "tenant_roles" ADD CONSTRAINT "tenant_roles_permissions_check" CHECK (
  permissions IS NOT NULL
  AND cardinality(permissions) >= 1
  AND permissions <@ ARRAY[
    'tenancy.manage', 'users.invite', 'roles.manage', 'audit.view', 'config.manage',
    'config.manage_statutory', 'projects.view', 'projects.create', 'projects.manage', 'bq.view',
    'bq.edit', 'bq.import', 'bq.approve_variation', 'labour.view', 'labour.manage',
    'labour.view_sensitive', 'attendance.view', 'attendance.record', 'attendance.override',
    'attendance.review_anomalies', 'payroll.prepare', 'payroll.review', 'payroll.approve',
    'payments.view', 'payments.approve', 'payments.disburse', 'payments.record_cash',
    'payments.reverse', 'procurement.requisition', 'procurement.approve',
    'procurement.manage_suppliers', 'stores.manage', 'finance.view', 'finance.manage',
    'finance.view_sensitive', 'site.diary', 'site.photos', 'quality.manage', 'safety.manage',
    'plant.manage', 'documents.manage', 'reports.view', 'portal.client', 'portal.supplier'
  ]::text[]
);
ALTER TABLE "tenant_roles" ADD CONSTRAINT "tenant_roles_no_platform_admin_check" CHECK (
  NOT ('platform.admin' = ANY (permissions))
);
-- Custom names cannot impersonate a system role (citext comparison is case-insensitive).
ALTER TABLE "tenant_roles" ADD CONSTRAINT "tenant_roles_name_check" CHECK (
  char_length(name) BETWEEN 2 AND 60
  AND name = btrim(name)
  AND name NOT IN (
    'platform_admin', 'platform admin', 'owner', 'project_manager', 'project manager',
    'site_agent', 'site agent', 'foreman', 'quantity_surveyor', 'quantity surveyor',
    'storekeeper', 'finance', 'client', 'consultant', 'supplier', 'admin', 'custom'
  )
);

-- Memberships and invitations: a system role key, or 'custom' plus the custom role.
ALTER TABLE "memberships" ADD COLUMN "custom_role_id" UUID;
ALTER TABLE "invitations" ADD COLUMN "custom_role_id" UUID;
CREATE INDEX "memberships_tenant_id_custom_role_id_idx" ON "memberships"("tenant_id", "custom_role_id");
CREATE INDEX "invitations_tenant_id_custom_role_id_idx" ON "invitations"("tenant_id", "custom_role_id");
-- A role still held by a member cannot be deleted. Deleting a role removes invitations that
-- reference it; the API refuses while any of them is still pending.
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_custom_role_id_fkey"
  FOREIGN KEY ("tenant_id", "custom_role_id") REFERENCES "tenant_roles"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenant_id_custom_role_id_fkey"
  FOREIGN KEY ("tenant_id", "custom_role_id") REFERENCES "tenant_roles"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "memberships" DROP CONSTRAINT "memberships_role_check";
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_role_check" CHECK (
  role IN ('owner','project_manager','site_agent','foreman','quantity_surveyor','storekeeper','finance','client','consultant','supplier','custom')
);
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_custom_role_check" CHECK (
  (role = 'custom') = (custom_role_id IS NOT NULL)
);
ALTER TABLE "invitations" DROP CONSTRAINT "invitations_role_check";
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_role_check" CHECK (
  role IN ('owner','project_manager','site_agent','foreman','quantity_surveyor','storekeeper','finance','client','consultant','supplier','custom')
);
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_custom_role_check" CHECK (
  (role = 'custom') = (custom_role_id IS NOT NULL)
);

ALTER TABLE "tenant_roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_roles" FORCE ROW LEVEL SECURITY;
-- Like memberships_read: before selecting a company a user may read the custom role they hold
-- there (to show its name and permissions), never the company's other roles.
CREATE POLICY tenant_roles_read ON tenant_roles FOR SELECT USING (
  tenant_id = app.current_tenant_id() OR EXISTS (
    SELECT 1 FROM memberships m
    WHERE m.tenant_id = tenant_roles.tenant_id
      AND m.custom_role_id = tenant_roles.id
      AND m.user_id = app.current_user_id()
  )
);
CREATE POLICY tenant_roles_insert ON tenant_roles FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id() AND created_by = app.current_user_id());
CREATE POLICY tenant_roles_update ON tenant_roles FOR UPDATE
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY tenant_roles_delete ON tenant_roles FOR DELETE
  USING (tenant_id = app.current_tenant_id());

-- Permission-based MFA (brief §7). The lists mirror packages/types MFA_REQUIRED_PERMISSIONS and
-- the system roles whose default permissions include one of them; the API e2e suite checks both
-- against the shared code.
CREATE FUNCTION app.permissions_require_mfa(permissions text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT COALESCE(permissions && ARRAY[
    'payroll.approve', 'payments.approve', 'payments.disburse', 'payments.reverse',
    'finance.manage', 'config.manage_statutory', 'roles.manage', 'tenancy.manage',
    'platform.admin'
  ]::text[], false) $$;

CREATE FUNCTION app.system_role_requires_mfa(role text) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT role IN ('platform_admin', 'owner', 'finance') $$;

CREATE OR REPLACE FUNCTION app.require_privileged_mfa() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  granted text[];
  privileged boolean;
BEGIN
  IF NEW.custom_role_id IS NULL THEN
    privileged := app.system_role_requires_mfa(NEW.role);
  ELSE
    -- FOR SHARE serialises with a concurrent permission change on the same role (whose
    -- tenant_role_mfa trigger waits for this transaction), so the two checks cannot both pass
    -- on stale data even without the application's tenant lock.
    SELECT permissions INTO granted FROM tenant_roles
      WHERE tenant_id = NEW.tenant_id AND id = NEW.custom_role_id
      FOR SHARE;
    IF NOT FOUND THEN
      -- Fail closed: the role must exist in, and be visible from, the membership's own tenant.
      RAISE EXCEPTION 'Custom role not found in this tenant' USING ERRCODE = '23503';
    END IF;
    privileged := app.permissions_require_mfa(granted);
  END IF;
  IF privileged AND NOT EXISTS (
    SELECT 1 FROM users WHERE id = NEW.user_id AND mfa_enabled AND verified_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Privileged membership requires verified identity and enrolled MFA' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

-- Adding a privileged permission to a custom role requires every holder to have MFA already.
CREATE FUNCTION app.require_role_member_mfa() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.permissions_require_mfa(NEW.permissions) AND EXISTS (
    SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.tenant_id = NEW.tenant_id AND m.custom_role_id = NEW.id
      AND NOT (u.mfa_enabled AND u.verified_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'Every holder of a privileged role requires verified identity and enrolled MFA' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER tenant_role_mfa BEFORE UPDATE OF permissions ON tenant_roles
  FOR EACH ROW EXECUTE FUNCTION app.require_role_member_mfa();

REVOKE EXECUTE ON FUNCTION app.require_privileged_mfa() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.require_role_member_mfa() FROM PUBLIC;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON tenant_roles FROM pmb_app;

COMMIT;
