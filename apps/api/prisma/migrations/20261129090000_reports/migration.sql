-- D8.1 dashboards and reports (ARCHITECTURE §4.14, ERD, WORKFLOWS "Report subscriptions", brief
-- §5.17 and §15 F). Reports are built on read from the other modules' tables; this migration adds
-- only what scheduled emails need, plus three indexes the bounded report queries use:
-- * report_subscriptions: a user's scheduled report (weekly on a weekday or monthly on a day of the
--   month, Africa/Nairobi), with fixed parameters (IDs only) and a locale. Created by the signed-in
--   user for themselves, changed only by them (pause, resume, delete); active ⇄ paused, either →
--   deleted (final, kept with its runs); the report, parameters and schedule never change.
-- * report_subscription_runs: one append-only row per subscription and due time — sent, failed or
--   skipped with a reason code — recorded as the subscriber. Never report data.
-- * The scheduler finds due subscriptions across companies only through app.due_report_subscriptions()
--   (SECURITY DEFINER, returning tenant, ID and due time); inside a company context it sees that
--   company only. It then claims each one in that company's context with FOR UPDATE SKIP LOCKED.
-- Both tables have tenant_id, forced RLS with WITH CHECK and composite (tenant_id, …) foreign keys;
-- pmb_app holds no DELETE on them and no UPDATE on the runs. No permission was added (reports.view
-- exists; each report also needs its source screen's permission).
BEGIN;
-- CreateTable
CREATE TABLE "report_subscriptions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "report_id" VARCHAR(40) NOT NULL,
    "parameters" JSONB NOT NULL DEFAULT '{}',
    "frequency" VARCHAR(10) NOT NULL,
    "weekday" SMALLINT,
    "day_of_month" SMALLINT,
    "locale" VARCHAR(2) NOT NULL DEFAULT 'en',
    "status" VARCHAR(10) NOT NULL DEFAULT 'active',
    "next_run_at" TIMESTAMPTZ,
    "last_run_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "report_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_subscription_runs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "due_at" TIMESTAMPTZ NOT NULL,
    "outcome" VARCHAR(10) NOT NULL,
    "reason" VARCHAR(30),
    "period_from" DATE,
    "period_to" DATE,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_subscription_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "report_subscriptions_tenant_id_user_id_status_idx" ON "report_subscriptions"("tenant_id", "user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "report_subscriptions_tenant_id_id_key" ON "report_subscriptions"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "report_subscription_runs_tenant_id_created_at_idx" ON "report_subscription_runs"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "report_subscription_runs_tenant_id_id_key" ON "report_subscription_runs"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "report_subscription_runs_tenant_id_subscription_id_due_at_key" ON "report_subscription_runs"("tenant_id", "subscription_id", "due_at");

-- CreateIndex
CREATE INDEX "audit_events_tenant_id_created_at_idx" ON "audit_events"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "cost_entries_tenant_id_project_id_occurred_on_idx" ON "cost_entries"("tenant_id", "project_id", "occurred_on");

-- CreateIndex
CREATE INDEX "stock_ledger_entries_tenant_id_project_id_business_date_idx" ON "stock_ledger_entries"("tenant_id", "project_id", "business_date");

-- AddForeignKey
ALTER TABLE "report_subscriptions" ADD CONSTRAINT "report_subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_subscriptions" ADD CONSTRAINT "report_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_subscription_runs" ADD CONSTRAINT "report_subscription_runs_tenant_id_subscription_id_fkey" FOREIGN KEY ("tenant_id", "subscription_id") REFERENCES "report_subscriptions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Report subscriptions -------------------------------------------------------------------------
-- The M-Pesa reconciliation report is not available until D4.3, so it cannot be subscribed to.
ALTER TABLE "report_subscriptions" ADD CONSTRAINT "report_subscriptions_state_check" CHECK (
  report_id IN ('muster-roll', 'payroll-register', 'cost-ledger', 'budget-vs-actual', 'stock',
    'valuations-register', 'lpo-register', 'invoice-ageing', 'supplier-payments', 'petty-cash',
    'safety-actions', 'audit-log')
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

-- The scheduler's scan of due subscriptions.
CREATE INDEX "report_subscriptions_due_idx" ON "report_subscriptions" ("next_run_at")
  WHERE status = 'active';
-- The same report, parameters and schedule only once per user (409 subscription-exists).
CREATE UNIQUE INDEX "report_subscriptions_live_key" ON "report_subscriptions" ("tenant_id",
  "user_id", "report_id", "parameters", "frequency", COALESCE("weekday", 0),
  COALESCE("day_of_month", 0)) WHERE status <> 'deleted';

CREATE FUNCTION app.guard_report_subscription() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.user_id IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'A subscription belongs to the signed-in user' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM memberships m
                    WHERE m.tenant_id = NEW.tenant_id AND m.user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'Only a member of the company subscribes' USING ERRCODE = '42501';
    END IF;
    IF NEW.status <> 'active' OR NEW.version <> 1 OR NEW.last_run_at IS NOT NULL
       OR NEW.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'A new subscription starts active' USING ERRCODE = '23514';
    END IF;
    NEW.created_at := clock_timestamp();
    NEW.updated_at := NEW.created_at;
    RETURN NEW;
  END IF;
  IF OLD.user_id IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'Only the subscriber changes a subscription' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'deleted' THEN
    RAISE EXCEPTION 'A deleted subscription never changes' USING ERRCODE = '23514';
  END IF;
  IF (NEW.tenant_id, NEW.user_id, NEW.report_id, NEW.parameters, NEW.frequency, NEW.weekday,
      NEW.day_of_month, NEW.locale, NEW.created_at)
     IS DISTINCT FROM (OLD.tenant_id, OLD.user_id, OLD.report_id, OLD.parameters, OLD.frequency,
      OLD.weekday, OLD.day_of_month, OLD.locale, OLD.created_at) THEN
    RAISE EXCEPTION 'A subscription''s report, parameters and schedule never change'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'A status change moves the version on' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'deleted' THEN
      NEW.deleted_at := clock_timestamp();
      NEW.next_run_at := NULL;
    END IF;
  ELSIF NEW.version <> OLD.version OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'Only a status change moves the version on' USING ERRCODE = '23514';
  END IF;
  IF NEW.last_run_at IS DISTINCT FROM OLD.last_run_at
     AND (NEW.last_run_at IS NULL OR NEW.last_run_at < OLD.last_run_at) THEN
    RAISE EXCEPTION 'The last run only moves forward' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$;
CREATE TRIGGER report_subscription_guard BEFORE INSERT OR UPDATE ON "report_subscriptions"
  FOR EACH ROW EXECUTE FUNCTION app.guard_report_subscription();

-- Runs ------------------------------------------------------------------------------------------
ALTER TABLE "report_subscription_runs" ADD CONSTRAINT "report_subscription_runs_state_check" CHECK (
  outcome IN ('sent', 'failed', 'skipped')
  AND ((outcome = 'sent' AND reason IS NULL)
    OR (outcome = 'failed' AND reason = 'delivery-failed')
    OR (outcome = 'skipped' AND reason IN ('permission-lost', 'membership-ended',
      'report-unavailable', 'no-email-address')))
  AND (period_from IS NULL) = (period_to IS NULL)
  AND (period_from IS NULL OR period_from <= period_to)
);

CREATE FUNCTION app.guard_report_subscription_run() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  s record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Report runs are append-only' USING ERRCODE = '42501';
  END IF;
  SELECT user_id, status INTO s FROM report_subscriptions
   WHERE tenant_id = NEW.tenant_id AND id = NEW.subscription_id;
  IF NOT FOUND OR s.user_id IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A run is recorded as its subscriber' USING ERRCODE = '42501';
  END IF;
  IF s.status <> 'active' THEN
    RAISE EXCEPTION 'Only an active subscription runs' USING ERRCODE = '23514';
  END IF;
  IF NEW.due_at > clock_timestamp() THEN
    RAISE EXCEPTION 'A run is never recorded before it is due' USING ERRCODE = '23514';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END
$$;
CREATE TRIGGER report_subscription_run_guard BEFORE INSERT OR UPDATE OR DELETE
  ON "report_subscription_runs" FOR EACH ROW EXECUTE FUNCTION app.guard_report_subscription_run();
CREATE TRIGGER report_subscription_run_no_truncate BEFORE TRUNCATE ON "report_subscription_runs"
  FOR EACH STATEMENT EXECUTE FUNCTION app.guard_report_subscription_run();

-- Row-level security ---------------------------------------------------------------------------
DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['report_subscriptions', 'report_subscription_runs']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = app.current_tenant_id()) '
      'WITH CHECK (tenant_id = app.current_tenant_id())', target || '_isolation', target);
  END LOOP;
  -- The scheduler's scan: only the schema owner (inside app.due_report_subscriptions, a SECURITY
  -- DEFINER function) reads due active subscriptions across companies; pmb_app never does.
  EXECUTE format('CREATE POLICY report_subscriptions_due_scan ON report_subscriptions FOR SELECT '
    'USING (current_user = %L AND status = %L AND next_run_at <= now())', current_user, 'active');
END
$$;

-- Due subscriptions (company, ID and due time only), oldest first; inside a company context only
-- that company's. The caller claims each one in its own company context (FOR UPDATE SKIP LOCKED).
CREATE FUNCTION app.due_report_subscriptions(p_limit integer)
  RETURNS TABLE (tenant_id uuid, id uuid, next_run_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT s.tenant_id, s.id, s.next_run_at
    FROM public.report_subscriptions s
   WHERE s.status = 'active' AND s.next_run_at <= now()
     AND (app.current_tenant_id() IS NULL OR s.tenant_id = app.current_tenant_id())
   ORDER BY s.next_run_at, s.id
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 1), 1), 100)
$$;

-- The runtime role never deletes subscriptions or runs, and never rewrites a run.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmb_app') THEN
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER
      ON "report_subscriptions", "report_subscription_runs" FROM pmb_app;
    REVOKE UPDATE ON "report_subscription_runs" FROM pmb_app;
    GRANT EXECUTE ON FUNCTION app.due_report_subscriptions(integer) TO pmb_app;
  END IF;
END
$$;
REVOKE EXECUTE ON FUNCTION app.guard_report_subscription() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_report_subscription_run() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.due_report_subscriptions(integer) FROM PUBLIC;

COMMIT;
