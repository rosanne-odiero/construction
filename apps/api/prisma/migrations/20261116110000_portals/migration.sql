-- Portals: a `labourer` system role holding only `portal.worker`; the client and labourer portal
-- permissions become project-assignable (a client or labourer sees only assigned projects);
-- labourers sign in with a phone number and a six-digit PIN; sessions record how they were
-- signed in, and PIN sessions are limited to the labourer portal by the API.
BEGIN;

-- Roles and permissions (packages/types SYSTEM_ROLES, PERMISSIONS, PROJECT_ASSIGNABLE_PERMISSIONS).
-- Runs after the D3.1–D5.1 migrations, so the lists include their permissions too.
ALTER TABLE "memberships" DROP CONSTRAINT "memberships_role_check";
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_role_check" CHECK (
  role IN ('owner','project_manager','site_agent','foreman','quantity_surveyor','storekeeper','finance','client','consultant','supplier','labourer','custom')
);
ALTER TABLE "invitations" DROP CONSTRAINT "invitations_role_check";
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_role_check" CHECK (
  role IN ('owner','project_manager','site_agent','foreman','quantity_surveyor','storekeeper','finance','client','consultant','supplier','labourer','custom')
);
ALTER TABLE "tenant_roles" DROP CONSTRAINT "tenant_roles_permissions_check";
ALTER TABLE "tenant_roles" ADD CONSTRAINT "tenant_roles_permissions_check" CHECK (
  permissions IS NOT NULL
  AND cardinality(permissions) >= 1
  AND permissions <@ ARRAY[
    'tenancy.manage', 'users.invite', 'roles.manage', 'audit.view', 'config.manage',
    'config.manage_statutory', 'projects.view', 'projects.create', 'projects.manage', 'bq.view',
    'bq.edit', 'bq.import', 'bq.approve_variation', 'labour.view', 'labour.manage',
    'labour.view_sensitive', 'labour.do_not_rehire', 'labour.consent', 'attendance.view',
    'attendance.record', 'attendance.override', 'attendance.review_anomalies',
    'attendance.confirm', 'timesheets.submit', 'timesheets.approve', 'timesheets.manage_rules',
    'payroll.view', 'payroll.prepare', 'payroll.review', 'payroll.approve',
    'payroll.manage_rules', 'payroll.verify_rules', 'payroll.export', 'advances.request',
    'advances.approve', 'payments.view', 'payments.approve', 'payments.disburse',
    'payments.record_cash', 'payments.reverse', 'procurement.requisition',
    'procurement.approve', 'procurement.manage_suppliers', 'stores.manage', 'finance.view',
    'finance.manage', 'finance.view_sensitive', 'site.diary', 'site.photos', 'quality.manage',
    'safety.manage', 'plant.manage', 'documents.manage', 'reports.view', 'portal.client',
    'portal.supplier', 'portal.worker'
  ]::text[]
);
ALTER TABLE "tenant_roles" DROP CONSTRAINT "tenant_roles_name_check";
ALTER TABLE "tenant_roles" ADD CONSTRAINT "tenant_roles_name_check" CHECK (
  char_length(name) BETWEEN 2 AND 60
  AND name = btrim(name)
  AND name NOT IN (
    'platform_admin', 'platform admin', 'owner', 'project_manager', 'project manager',
    'site_agent', 'site agent', 'foreman', 'quantity_surveyor', 'quantity surveyor',
    'storekeeper', 'finance', 'client', 'consultant', 'supplier', 'labourer', 'admin', 'custom'
  )
);
ALTER TABLE "project_memberships" DROP CONSTRAINT "project_permissions_check";
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_permissions_check" CHECK (
  permissions <@ ARRAY[
    'projects.view', 'projects.manage', 'bq.view', 'bq.edit', 'bq.import',
    'bq.approve_variation', 'labour.view', 'labour.manage', 'labour.view_sensitive',
    'labour.do_not_rehire', 'labour.consent', 'attendance.view', 'attendance.record',
    'attendance.override', 'attendance.review_anomalies', 'attendance.confirm',
    'timesheets.submit', 'timesheets.approve', 'timesheets.manage_rules', 'payroll.view',
    'payroll.prepare', 'payroll.review', 'advances.request', 'advances.approve',
    'procurement.requisition', 'procurement.approve', 'stores.manage', 'finance.view',
    'site.diary', 'site.photos', 'quality.manage', 'safety.manage', 'plant.manage',
    'documents.manage', 'reports.view', 'portal.client', 'portal.worker'
  ]::text[]
);

-- Existing clients keep seeing the projects they were assigned to, now in the client portal. The
-- schema owner is subject to FORCE ROW LEVEL SECURITY without a tenant context, so FORCE is lifted
-- only for this backfill (ALTER TABLE holds an exclusive lock) and restored.
ALTER TABLE "project_memberships" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "memberships" NO FORCE ROW LEVEL SECURITY;
UPDATE project_memberships pm
  SET permissions = array_append(pm.permissions, 'portal.client')
  FROM memberships m
  WHERE m.tenant_id = pm.tenant_id AND m.user_id = pm.user_id AND m.role = 'client'
    AND NOT ('portal.client' = ANY (pm.permissions));
ALTER TABLE "memberships" FORCE ROW LEVEL SECURITY;
ALTER TABLE "project_memberships" FORCE ROW LEVEL SECURITY;

-- Labourer PINs (Argon2id, like passwords) and how each session was signed in.
ALTER TABLE "users" ADD COLUMN "pin_hash" TEXT;
ALTER TABLE "sessions" ADD COLUMN "auth_method" VARCHAR(10) NOT NULL DEFAULT 'password';
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_auth_method_check" CHECK (
  auth_method IN ('password', 'google', 'pin')
);

COMMIT;
