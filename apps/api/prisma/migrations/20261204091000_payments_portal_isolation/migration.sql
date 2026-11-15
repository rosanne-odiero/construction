BEGIN;

-- Payments are company working records, not portal data. Keep the same portal-role
-- classification as the earlier client and supplier policies, including client-only custom roles.
DO $$
DECLARE
  staff constant text := 'NOT EXISTS (SELECT 1 FROM memberships m '
    'LEFT JOIN tenant_roles r ON r.tenant_id = m.tenant_id AND r.id = m.custom_role_id '
    'WHERE m.tenant_id = app.current_tenant_id() AND m.user_id = app.current_user_id() '
    'AND (m.role IN (''client'', ''supplier'') OR (m.role = ''custom'' '
    'AND ''portal.client'' = ANY (r.permissions) '
    'AND r.permissions <@ ARRAY[''projects.view'', ''bq.view'', ''portal.client'']::text[])))';
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['payment_settings', 'payment_callback_routes',
    'payment_requests', 'payment_attempts', 'payment_events', 'payment_callback_inbox',
    'payment_cases', 'payment_provider_queries', 'payment_provider_transactions', 'payment_outbox']
  LOOP
    EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE USING (%s) WITH CHECK (%s)',
      target || '_staff_only', target, staff, staff);
  END LOOP;
END
$$;

COMMIT;
