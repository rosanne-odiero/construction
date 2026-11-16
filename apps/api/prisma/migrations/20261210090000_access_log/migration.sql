-- Access log (D9.3): who accessed what and when. One row per signed-in API request made in a
-- company context, reads included, written in batches after the response (AccessLogWriter):
-- person, session and sign-in method, HTTP method and route template, record IDs (path parameters
-- and UUID query values), outcome, duration, request ID and, only behind a trusted proxy, the
-- client IP. Never request bodies, search text or other query values.
-- * Append-only: pmb_app may insert and read its company's rows only (forced RLS, WITH CHECK); it
--   holds no UPDATE, DELETE or TRUNCATE, and a trigger refuses any change for every role.
-- * Retention 365 days (CONFIGURATION access_log.retention_days, COMPLIANCE-REVIEW): only
--   app.purge_access_events() (SECURITY DEFINER) deletes, and only rows past that age, so the
--   runtime role cannot erase recent evidence. Changing the period needs a new migration.
-- * The access-log report joins the reports registry, so the subscription CHECK lists it.
BEGIN;
-- CreateTable
CREATE TABLE "access_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "auth_method" VARCHAR(10) NOT NULL,
    "method" VARCHAR(7) NOT NULL,
    "route" VARCHAR(200) NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "resource_ids" UUID[] NOT NULL DEFAULT '{}',
    "status" SMALLINT NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "ip_address" INET,
    "request_id" VARCHAR(64) NOT NULL,
    "occurred_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "access_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "access_events_tenant_id_occurred_at_idx" ON "access_events"("tenant_id", "occurred_at");

-- CreateIndex
CREATE INDEX "access_events_tenant_id_user_id_occurred_at_idx" ON "access_events"("tenant_id", "user_id", "occurred_at");

-- CreateIndex
CREATE INDEX "access_events_resource_ids_idx" ON "access_events" USING GIN ("resource_ids");

-- CreateIndex
CREATE INDEX "access_events_occurred_at_idx" ON "access_events" USING BRIN ("occurred_at");

-- AddForeignKey
ALTER TABLE "access_events" ADD CONSTRAINT "access_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Shape (the writer builds rows that fit; this is the database's own check) ---------------------
ALTER TABLE "access_events" ADD CONSTRAINT "access_events_state_check" CHECK (
  auth_method ~ '^[a-z]{1,10}$'
  AND method IN ('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS')
  AND char_length(route) >= 1
  AND jsonb_typeof(params) = 'object'
  AND octet_length(params::text) <= 2000
  AND cardinality(resource_ids) <= 10
  AND status BETWEEN 100 AND 599
  AND duration_ms >= 0
  AND request_id ~ '^[A-Za-z0-9-]{8,64}$'
);

-- Append-only: rows never change; only rows past the retention period may be deleted.
CREATE FUNCTION app.guard_access_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.occurred_at < now() - interval '365 days' THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'Access events are append-only' USING ERRCODE = '42501';
END
$$;
CREATE TRIGGER access_event_guard BEFORE UPDATE OR DELETE ON "access_events"
  FOR EACH ROW EXECUTE FUNCTION app.guard_access_event();
CREATE TRIGGER access_event_no_truncate BEFORE TRUNCATE ON "access_events"
  FOR EACH STATEMENT EXECUTE FUNCTION app.guard_access_event();

-- Row-level security ---------------------------------------------------------------------------
ALTER TABLE "access_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "access_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY access_events_isolation ON "access_events"
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DO $$
BEGIN
  -- Retention: only the schema owner (inside app.purge_access_events, a SECURITY DEFINER function)
  -- sees and deletes rows past the retention period, across companies; pmb_app never does.
  EXECUTE format('CREATE POLICY access_events_retention_scan ON access_events FOR SELECT '
    'USING (current_user = %L AND occurred_at < now() - interval %L)', current_user, '365 days');
  EXECUTE format('CREATE POLICY access_events_retention_purge ON access_events FOR DELETE '
    'USING (current_user = %L AND occurred_at < now() - interval %L)', current_user, '365 days');
END
$$;

-- Deletes up to p_limit (1–10,000) rows older than 365 days and returns how many. The API calls
-- it in batches every hour (AccessLogRetention).
CREATE FUNCTION app.purge_access_events(p_limit integer) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  deleted integer;
BEGIN
  DELETE FROM public.access_events
   WHERE id IN (SELECT e.id FROM public.access_events e
                 WHERE e.occurred_at < now() - interval '365 days'
                 LIMIT LEAST(GREATEST(COALESCE(p_limit, 1), 1), 10000));
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmb_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "access_events" FROM pmb_app;
    GRANT EXECUTE ON FUNCTION app.purge_access_events(integer) TO pmb_app;
  END IF;
END
$$;
REVOKE EXECUTE ON FUNCTION app.guard_access_event() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.purge_access_events(integer) FROM PUBLIC;

-- The access-log report can be subscribed to like the audit log ---------------------------------
ALTER TABLE "report_subscriptions" DROP CONSTRAINT "report_subscriptions_state_check";
ALTER TABLE "report_subscriptions" ADD CONSTRAINT "report_subscriptions_state_check" CHECK (
  report_id IN ('muster-roll', 'payroll-register', 'cost-ledger', 'budget-vs-actual', 'stock',
    'valuations-register', 'lpo-register', 'invoice-ageing', 'supplier-payments', 'petty-cash',
    'safety-actions', 'audit-log', 'access-log')
  AND ((frequency = 'weekly' AND weekday BETWEEN 1 AND 7 AND day_of_month IS NULL)
    OR (frequency = 'monthly' AND day_of_month BETWEEN 1 AND 31 AND weekday IS NULL))
  AND locale IN ('en', 'sw')
  AND status IN ('active', 'paused', 'deleted')
  AND (status = 'deleted') = (deleted_at IS NOT NULL)
  AND (status <> 'active' OR next_run_at IS NOT NULL)
  AND jsonb_typeof(parameters) = 'object'
  AND octet_length(parameters::text) <= 2000
  AND version >= 1
);

COMMIT;
