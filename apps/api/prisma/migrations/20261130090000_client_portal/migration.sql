-- D7.1 client portal (ARCHITECTURE §4.15, ERD "Implemented in D7.1", WORKFLOWS "Client receipts"
-- and "Variation decisions by the client", brief §3, §5.7, §5.10 and §15 C/D/F). Enforces, in the
-- database as well as the API:
-- * NOTHING IS PAID UNLESS RECORDED: client_payments are append-only receipts against CERTIFIED
--   certificates of open projects (never dated in the future, never past the certificate's total,
--   serialised per certificate) and reversals that undo one receipt in full, once, with a reason.
-- * A CLIENT DECIDES ONLY WHAT IT WAS SENT: variation_client_requests freeze the client's view of
--   the current submission (status, snapshot digest and submission time as stored); one decision
--   per sending, by an assigned client (portal.client, no staff permission), quoting the view's
--   digest while the variation is still that submission; append-only. When the project's client
--   terms require it, a submitted variation is approved only after the client approved it.
-- * CLIENT ISOLATION: restrictive RLS policies limit `client`-role members to their assigned
--   projects' rows (certified certificates, general photos and variations sent to them only) and
--   keep the company's working records (instructions, variation lines, build-ups, workers,
--   attendance, payroll, costs, cash flow, incidents, payout details) from them entirely.
-- * Client terms and Paybill instructions are versioned (append-only, next version, database-
--   stamped); FX rates are dated entries (append-only); a display preference is its owner's only.
-- Every new table has tenant_id, forced RLS with WITH CHECK and composite (tenant_id, …) foreign
-- keys; pmb_app holds no DELETE/TRUNCATE on them and no UPDATE except on preferences. No
-- permission was added (portal.client, finance.manage, bq.edit, projects.manage and config.manage
-- exist).
BEGIN;

-- CreateTable
CREATE TABLE "project_client_settings" (
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "client_approval_required" BOOLEAN NOT NULL,
    "payment_terms_days" INTEGER NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_client_settings_pkey" PRIMARY KEY ("tenant_id","project_id","version")
);

-- CreateTable
CREATE TABLE "client_payment_instructions" (
    "tenant_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "paybill_number" VARCHAR(7),
    "till_number" VARCHAR(7),
    "account_name" VARCHAR(150) NOT NULL,
    "account_format" VARCHAR(20) NOT NULL,
    "bank_instructions" VARCHAR(500),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_payment_instructions_pkey" PRIMARY KEY ("tenant_id","version")
);

-- CreateTable
CREATE TABLE "fx_rates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "kes_per_unit" DECIMAL(9,4) NOT NULL,
    "rate_date" DATE NOT NULL,
    "source" VARCHAR(200) NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fx_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_preferences" (
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "display_currency" CHAR(3) NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_preferences_pkey" PRIMARY KEY ("tenant_id","user_id")
);

-- CreateTable
CREATE TABLE "client_payments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "valuation_id" UUID NOT NULL,
    "kind" VARCHAR(10) NOT NULL,
    "reverses_id" UUID,
    "amount_minor" BIGINT NOT NULL,
    "received_on" DATE NOT NULL,
    "method" VARCHAR(20),
    "reference" VARCHAR(60),
    "note" VARCHAR(500),
    "reason" VARCHAR(500),
    "idempotency_key" VARCHAR(100) NOT NULL,
    "request_digest" CHAR(64) NOT NULL,
    "recorded_by" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "variation_client_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "variation_id" UUID NOT NULL,
    "snapshot_digest" CHAR(64) NOT NULL,
    "submitted_at" TIMESTAMPTZ NOT NULL,
    "client_view" JSONB NOT NULL,
    "client_digest" CHAR(64) NOT NULL,
    "message" VARCHAR(1000),
    "sent_by" UUID NOT NULL,
    "sent_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "variation_client_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "variation_client_decisions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "variation_id" UUID NOT NULL,
    "decision" VARCHAR(10) NOT NULL,
    "comment" VARCHAR(1000),
    "client_digest" CHAR(64) NOT NULL,
    "decided_by" UUID NOT NULL,
    "decided_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "variation_client_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fx_rates_tenant_id_currency_rate_date_idx" ON "fx_rates"("tenant_id", "currency", "rate_date");

-- CreateIndex
CREATE UNIQUE INDEX "fx_rates_tenant_id_id_key" ON "fx_rates"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "client_payments_tenant_id_project_id_received_on_idx" ON "client_payments"("tenant_id", "project_id", "received_on");

-- CreateIndex
CREATE UNIQUE INDEX "client_payments_tenant_id_id_key" ON "client_payments"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "client_payments_tenant_id_valuation_id_id_key" ON "client_payments"("tenant_id", "valuation_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "client_payments_tenant_id_reverses_id_key" ON "client_payments"("tenant_id", "reverses_id");

-- CreateIndex
CREATE UNIQUE INDEX "client_payments_tenant_id_idempotency_key_key" ON "client_payments"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "variation_client_requests_tenant_id_project_id_sent_at_idx" ON "variation_client_requests"("tenant_id", "project_id", "sent_at");

-- CreateIndex
CREATE UNIQUE INDEX "variation_client_requests_tenant_id_id_key" ON "variation_client_requests"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "variation_client_requests_tenant_id_project_id_id_key" ON "variation_client_requests"("tenant_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "variation_client_requests_tenant_id_variation_id_submitted__key" ON "variation_client_requests"("tenant_id", "variation_id", "submitted_at");

-- CreateIndex
CREATE INDEX "variation_client_decisions_tenant_id_variation_id_idx" ON "variation_client_decisions"("tenant_id", "variation_id");

-- CreateIndex
CREATE UNIQUE INDEX "variation_client_decisions_tenant_id_id_key" ON "variation_client_decisions"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "variation_client_decisions_tenant_id_request_id_key" ON "variation_client_decisions"("tenant_id", "request_id");

-- CreateIndex
CREATE UNIQUE INDEX "variation_orders_tenant_id_project_id_id_key" ON "variation_orders"("tenant_id", "project_id", "id");

-- AddForeignKey
ALTER TABLE "project_client_settings" ADD CONSTRAINT "project_client_settings_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_payment_instructions" ADD CONSTRAINT "client_payment_instructions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fx_rates" ADD CONSTRAINT "fx_rates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_preferences" ADD CONSTRAINT "client_preferences_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_payments" ADD CONSTRAINT "client_payments_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_payments" ADD CONSTRAINT "client_payments_tenant_id_project_id_valuation_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "valuation_id") REFERENCES "valuations"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_payments" ADD CONSTRAINT "client_payments_reverses_fkey" FOREIGN KEY ("tenant_id", "valuation_id", "reverses_id") REFERENCES "client_payments"("tenant_id", "valuation_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "variation_client_requests" ADD CONSTRAINT "variation_client_requests_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variation_client_requests" ADD CONSTRAINT "variation_client_requests_tenant_id_project_id_variation_i_fkey" FOREIGN KEY ("tenant_id", "project_id", "variation_id") REFERENCES "variation_orders"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variation_client_decisions" ADD CONSTRAINT "variation_client_decisions_tenant_id_project_id_request_id_fkey" FOREIGN KEY ("tenant_id", "project_id", "request_id") REFERENCES "variation_client_requests"("tenant_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Client terms, Paybill instructions, FX rates and preferences ---------------------------------
-- packages/types CLIENT_PORTAL_LIMITS, PAYBILL_ACCOUNT_FORMATS, FX_CURRENCIES, DISPLAY_CURRENCIES.
ALTER TABLE "project_client_settings" ADD CONSTRAINT "project_client_settings_check" CHECK (
  version >= 1 AND payment_terms_days BETWEEN 0 AND 120
);
ALTER TABLE "client_payment_instructions" ADD CONSTRAINT "client_payment_instructions_check" CHECK (
  version >= 1
  AND (paybill_number IS NULL OR paybill_number ~ '^[0-9]{5,7}$')
  AND (till_number IS NULL OR till_number ~ '^[0-9]{5,7}$')
  AND account_format IN ('project_certificate', 'project')
  AND char_length(btrim(account_name)) BETWEEN 3 AND 150
  AND (bank_instructions IS NULL OR char_length(btrim(bank_instructions)) >= 3)
  AND (paybill_number IS NOT NULL OR till_number IS NOT NULL OR bank_instructions IS NOT NULL)
);
ALTER TABLE "fx_rates" ADD CONSTRAINT "fx_rates_check" CHECK (
  currency IN ('USD', 'GBP', 'EUR')
  AND kes_per_unit BETWEEN 1 AND 10000
  AND rate_date >= DATE '2000-01-01'
  AND char_length(btrim(source)) BETWEEN 3 AND 200
);
ALTER TABLE "client_preferences" ADD CONSTRAINT "client_preferences_check" CHECK (
  display_currency IN ('KES', 'USD', 'GBP', 'EUR')
);

-- Versioned rows (client terms, Paybill instructions) take the next version, are written by the
-- signed-in user, stamped by the database clock and never changed; closed and cancelled projects
-- keep their terms.
CREATE FUNCTION app.guard_project_client_settings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Client terms are versioned, never changed' USING ERRCODE = '23514';
  END IF;
  IF NEW.created_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'Client terms are saved by the signed-in user' USING ERRCODE = '23514';
  END IF;
  IF (SELECT status FROM projects WHERE tenant_id = NEW.tenant_id AND id = NEW.project_id)
     IN ('closed', 'cancelled') THEN
    RAISE EXCEPTION 'Closed and cancelled projects are read-only' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM projects WHERE tenant_id = NEW.tenant_id AND id = NEW.project_id FOR UPDATE;
  IF NEW.version IS DISTINCT FROM COALESCE((SELECT max(version) FROM project_client_settings
      WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id), 0) + 1 THEN
    RAISE EXCEPTION 'New client terms take the next version' USING ERRCODE = '23514';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END
$$;
CREATE TRIGGER project_client_settings_guard BEFORE INSERT OR UPDATE OR DELETE
  ON "project_client_settings" FOR EACH ROW EXECUTE FUNCTION app.guard_project_client_settings();

CREATE FUNCTION app.guard_client_payment_instructions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Paybill instructions are versioned, never changed' USING ERRCODE = '23514';
  END IF;
  IF NEW.created_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'Paybill instructions are saved by the signed-in user' USING ERRCODE = '23514';
  END IF;
  IF NEW.version IS DISTINCT FROM COALESCE((SELECT max(version) FROM client_payment_instructions
      WHERE tenant_id = NEW.tenant_id), 0) + 1 THEN
    RAISE EXCEPTION 'New Paybill instructions take the next version' USING ERRCODE = '23514';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END
$$;
CREATE TRIGGER client_payment_instructions_guard BEFORE INSERT OR UPDATE OR DELETE
  ON "client_payment_instructions" FOR EACH ROW
  EXECUTE FUNCTION app.guard_client_payment_instructions();

-- An FX rate is an entry by the signed-in user, dated today or earlier; a correction is a newer
-- entry, never an edit.
CREATE FUNCTION app.guard_fx_rate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'FX rates are append-only; enter a newer rate instead' USING ERRCODE = '23514';
  END IF;
  IF NEW.created_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'An FX rate is entered by the signed-in user' USING ERRCODE = '23514';
  END IF;
  IF NEW.rate_date > app.nairobi_today() THEN
    RAISE EXCEPTION 'An FX rate is dated today or earlier' USING ERRCODE = '23514';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END
$$;
CREATE TRIGGER fx_rate_guard BEFORE INSERT OR UPDATE OR DELETE ON "fx_rates"
  FOR EACH ROW EXECUTE FUNCTION app.guard_fx_rate();

CREATE FUNCTION app.stamp_client_preference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$;
CREATE TRIGGER client_preference_stamp BEFORE INSERT OR UPDATE ON "client_preferences"
  FOR EACH ROW EXECUTE FUNCTION app.stamp_client_preference();

-- Client receipts --------------------------------------------------------------------------------
-- packages/types CLIENT_PAYMENT_KINDS and CLIENT_PAYMENT_METHODS. A receipt names how and when the
-- money came in (method and reference); a reversal undoes one receipt in full with a reason.
ALTER TABLE "client_payments" ADD CONSTRAINT "client_payments_check" CHECK (
  kind IN ('receipt', 'reversal')
  AND amount_minor > 0 AND amount_minor <= 100000000000000
  AND received_on >= DATE '2000-01-01'
  AND idempotency_key ~ '^[A-Za-z0-9._:-]{8,100}$' AND request_digest ~ '^[0-9a-f]{64}$'
  AND (note IS NULL OR char_length(btrim(note)) >= 1)
  AND COALESCE(CASE kind
    WHEN 'receipt' THEN reverses_id IS NULL AND reason IS NULL
      AND method IN ('mpesa_paybill', 'bank', 'cheque', 'cash')
      AND reference IS NOT NULL AND char_length(btrim(reference)) >= 3
    ELSE reverses_id IS NOT NULL AND reverses_id <> id AND method IS NULL AND reference IS NULL
      AND note IS NULL AND reason IS NOT NULL AND char_length(btrim(reason)) >= 3
  END, false)
);

-- Receipts are append-only, recorded by the signed-in user against a CERTIFIED certificate of an
-- open project, never dated in the future, and never take the certificate past its total (under
-- a lock on the certificate, so parallel receipts cannot pass it together). A reversal undoes one
-- receipt of the same certificate in full, once (unique reverses_id), dated on or after it.
CREATE FUNCTION app.guard_client_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  certificate record;
  original record;
  received numeric;
  entries integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Client receipts are append-only; reverse a receipt instead'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.recorded_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A receipt is recorded by the signed-in user' USING ERRCODE = '23514';
  END IF;
  SELECT status, total_minor INTO certificate FROM valuations
   WHERE tenant_id = NEW.tenant_id AND id = NEW.valuation_id FOR UPDATE;
  IF certificate.status IS DISTINCT FROM 'certified' OR certificate.total_minor IS NULL THEN
    RAISE EXCEPTION 'Receipts are recorded against certified certificates' USING ERRCODE = '23514';
  END IF;
  IF (SELECT status FROM projects WHERE tenant_id = NEW.tenant_id AND id = NEW.project_id)
     IN ('closed', 'cancelled') THEN
    RAISE EXCEPTION 'Closed and cancelled projects are read-only' USING ERRCODE = '23514';
  END IF;
  IF NEW.received_on > app.nairobi_today() THEN
    RAISE EXCEPTION 'Money is recorded as received today or earlier' USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO entries FROM client_payments
   WHERE tenant_id = NEW.tenant_id AND valuation_id = NEW.valuation_id;
  IF entries >= 200 THEN
    RAISE EXCEPTION 'A certificate keeps at most 200 receipts and reversals' USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'receipt' THEN
    SELECT COALESCE(sum(CASE kind WHEN 'receipt' THEN amount_minor ELSE -amount_minor END), 0)
      INTO received FROM client_payments
     WHERE tenant_id = NEW.tenant_id AND valuation_id = NEW.valuation_id;
    IF received + NEW.amount_minor > certificate.total_minor THEN
      RAISE EXCEPTION 'A receipt never takes a certificate past its total' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT kind, amount_minor, received_on INTO original FROM client_payments
     WHERE tenant_id = NEW.tenant_id AND valuation_id = NEW.valuation_id AND id = NEW.reverses_id;
    IF original.kind IS DISTINCT FROM 'receipt' OR original.amount_minor <> NEW.amount_minor THEN
      RAISE EXCEPTION 'A reversal undoes one receipt of the certificate in full'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.received_on < original.received_on THEN
      RAISE EXCEPTION 'A reversal is dated on or after its receipt' USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END
$$;
CREATE TRIGGER client_payment_guard BEFORE INSERT OR UPDATE OR DELETE ON "client_payments"
  FOR EACH ROW EXECUTE FUNCTION app.guard_client_payment();

-- Manual cash-flow lines for a certificate's payment (D-138) ------------------------------------
-- D5.4 told finance to enter expected client receipts as manual "in" lines until certificates
-- existed. A line can now be linked, once, to the certified certificate it pays: a linked line
-- leaves the forecast, the opening position and earned value (the certificate's outstanding amount
-- and the client receipts take its place), and linking a line already received records the same
-- money as a client receipt in the same transaction, so it is never counted twice.
ALTER TABLE "cash_flow_items" ADD COLUMN "valuation_id" UUID;
CREATE INDEX "cash_flow_items_tenant_id_valuation_id_idx" ON "cash_flow_items"("tenant_id", "valuation_id");
ALTER TABLE "cash_flow_items" ADD CONSTRAINT "cash_flow_items_tenant_id_valuation_id_fkey" FOREIGN KEY ("tenant_id", "valuation_id") REFERENCES "valuations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cash_flow_items" ADD CONSTRAINT "cash_flow_items_valuation_check" CHECK (
  valuation_id IS NULL OR direction = 'in'
);
CREATE OR REPLACE FUNCTION app.guard_cash_flow_item() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'expected' OR NEW.created_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'A cash-flow line starts as expected, by the signed-in user'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.project_id IS DISTINCT FROM OLD.project_id
       OR NEW.direction IS DISTINCT FROM OLD.direction OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'A cash-flow line keeps its project and direction' USING ERRCODE = '23514';
    END IF;
    IF OLD.valuation_id IS NOT NULL AND NEW.valuation_id IS DISTINCT FROM OLD.valuation_id THEN
      RAISE EXCEPTION 'A cash-flow line stays linked to its certificate' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.valuation_id IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.valuation_id IS NULL) THEN
    IF NOT EXISTS (SELECT 1 FROM valuations
                    WHERE tenant_id = NEW.tenant_id AND id = NEW.valuation_id
                      AND project_id = NEW.project_id AND status = 'certified') THEN
      RAISE EXCEPTION 'A cash-flow line is linked to a certified certificate of its project'
        USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' THEN
      -- Linking changes nothing else; a received line is linked together with its client receipt.
      IF ROW(NEW.status, NEW.description, NEW.expected_on, NEW.amount_minor, NEW.received_on,
             NEW.received_minor, NEW.reference)
         IS DISTINCT FROM ROW(OLD.status, OLD.description, OLD.expected_on, OLD.amount_minor,
             OLD.received_on, OLD.received_minor, OLD.reference) THEN
        RAISE EXCEPTION 'Linking a cash-flow line to its certificate changes nothing else'
          USING ERRCODE = '23514';
      END IF;
      IF OLD.status = 'received' AND NOT EXISTS (
           SELECT 1 FROM client_payments
            WHERE tenant_id = NEW.tenant_id AND valuation_id = NEW.valuation_id
              AND kind = 'receipt' AND idempotency_key = 'cash-flow-item:' || NEW.id
              AND amount_minor = OLD.received_minor) THEN
        RAISE EXCEPTION 'A received cash-flow line is linked with the client receipt it becomes'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  IF OLD.status <> 'expected' THEN
    RAISE EXCEPTION 'A % cash-flow line never changes', OLD.status USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'received' AND NEW.received_on > app.business_today() THEN
    RAISE EXCEPTION 'Money is received on or before today' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

-- Variation decisions by the client --------------------------------------------------------------
ALTER TABLE "variation_client_requests" ADD CONSTRAINT "variation_client_requests_check" CHECK (
  snapshot_digest ~ '^[0-9a-f]{64}$' AND client_digest ~ '^[0-9a-f]{64}$'
  AND jsonb_typeof(client_view) = 'object'
  AND (message IS NULL OR char_length(btrim(message)) BETWEEN 1 AND 1000)
);
ALTER TABLE "variation_client_decisions" ADD CONSTRAINT "variation_client_decisions_check" CHECK (
  decision IN ('approved', 'rejected') AND client_digest ~ '^[0-9a-f]{64}$'
  AND (comment IS NULL OR char_length(btrim(comment)) BETWEEN 1 AND 1000)
  AND (decision <> 'rejected' OR (comment IS NOT NULL AND char_length(btrim(comment)) >= 3))
);

-- Whether the signed-in user acts as the project's client: assigned to it with portal.client and
-- holding no staff permission (the client system role, or a custom role made only of
-- projects.view, bq.view and portal.client), as packages/types portalFor decides.
CREATE FUNCTION app.acts_as_client(target_tenant uuid, target_project uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM memberships m
      JOIN project_memberships pm ON pm.tenant_id = m.tenant_id AND pm.user_id = m.user_id
      LEFT JOIN tenant_roles r ON r.tenant_id = m.tenant_id AND r.id = m.custom_role_id
     WHERE m.tenant_id = target_tenant AND m.user_id = app.current_user_id()
       AND pm.project_id = target_project AND 'portal.client' = ANY (pm.permissions)
       AND (m.role = 'client' OR (m.role = 'custom' AND 'portal.client' = ANY (r.permissions)
         AND r.permissions <@ ARRAY['projects.view', 'bq.view', 'portal.client']::text[]))
  )
$$;

-- A sending is made by the signed-in user from the variation's CURRENT submission (status,
-- snapshot digest and submission time as stored), on an open project; it never changes. One per
-- submission (unique variation_id, submitted_at).
CREATE FUNCTION app.guard_variation_client_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  variation record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'A variation sent to the client never changes' USING ERRCODE = '23514';
  END IF;
  IF NEW.sent_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A variation is sent by the signed-in user' USING ERRCODE = '23514';
  END IF;
  SELECT status, snapshot_digest, submitted_at INTO variation FROM variation_orders
   WHERE tenant_id = NEW.tenant_id AND id = NEW.variation_id FOR SHARE;
  IF variation.status IS DISTINCT FROM 'submitted'
     OR variation.snapshot_digest IS DISTINCT FROM NEW.snapshot_digest
     OR variation.submitted_at IS DISTINCT FROM NEW.submitted_at THEN
    RAISE EXCEPTION 'Only the current submitted proposal is sent to the client'
      USING ERRCODE = '23514';
  END IF;
  IF (SELECT status FROM projects WHERE tenant_id = NEW.tenant_id AND id = NEW.project_id)
     IN ('closed', 'cancelled') THEN
    RAISE EXCEPTION 'Closed and cancelled projects are read-only' USING ERRCODE = '23514';
  END IF;
  NEW.sent_at := clock_timestamp();
  RETURN NEW;
END
$$;
CREATE TRIGGER variation_client_request_guard BEFORE INSERT OR UPDATE OR DELETE
  ON "variation_client_requests" FOR EACH ROW EXECUTE FUNCTION app.guard_variation_client_request();

-- A decision: once per sending (unique request_id), by the signed-in project client, quoting the
-- digest of the view they were sent, while the variation is still that submission; never changed.
CREATE FUNCTION app.guard_variation_client_decision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  sent record;
  variation record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'A client decision never changes' USING ERRCODE = '23514';
  END IF;
  IF NEW.decided_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'A decision is made by the signed-in client' USING ERRCODE = '23514';
  END IF;
  IF NOT app.acts_as_client(NEW.tenant_id, NEW.project_id) THEN
    RAISE EXCEPTION 'Only a client assigned to the project decides its variations'
      USING ERRCODE = '42501';
  END IF;
  SELECT variation_id, snapshot_digest, submitted_at, client_digest INTO sent
    FROM variation_client_requests WHERE tenant_id = NEW.tenant_id AND id = NEW.request_id;
  IF sent.variation_id IS DISTINCT FROM NEW.variation_id
     OR sent.client_digest IS DISTINCT FROM NEW.client_digest THEN
    RAISE EXCEPTION 'A decision quotes the figures the client was sent' USING ERRCODE = '23514';
  END IF;
  SELECT status, snapshot_digest, submitted_at INTO variation FROM variation_orders
   WHERE tenant_id = NEW.tenant_id AND id = NEW.variation_id FOR SHARE;
  IF variation.status IS DISTINCT FROM 'submitted'
     OR variation.snapshot_digest IS DISTINCT FROM sent.snapshot_digest
     OR variation.submitted_at IS DISTINCT FROM sent.submitted_at THEN
    RAISE EXCEPTION 'The variation changed after it was sent; it can no longer be decided'
      USING ERRCODE = '23514';
  END IF;
  IF (SELECT status FROM projects WHERE tenant_id = NEW.tenant_id AND id = NEW.project_id)
     IN ('closed', 'cancelled') THEN
    RAISE EXCEPTION 'Closed and cancelled projects are read-only' USING ERRCODE = '23514';
  END IF;
  NEW.decided_at := clock_timestamp();
  RETURN NEW;
END
$$;
CREATE TRIGGER variation_client_decision_guard BEFORE INSERT OR UPDATE OR DELETE
  ON "variation_client_decisions" FOR EACH ROW
  EXECUTE FUNCTION app.guard_variation_client_decision();

-- When the project's newest client terms require it, a submitted variation is approved only once
-- the client approved that same submission (D2.3's state machine is otherwise unchanged; a
-- rejection, rebase or cancellation never waits for the client).
CREATE FUNCTION app.hold_variation_for_client() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  required boolean;
BEGIN
  IF NOT (OLD.status = 'submitted' AND NEW.status = 'approved') THEN
    RETURN NEW;
  END IF;
  SELECT client_approval_required INTO required FROM project_client_settings
   WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id
   ORDER BY version DESC LIMIT 1;
  IF COALESCE(required, false) AND NOT EXISTS (
    SELECT 1 FROM variation_client_decisions d
      JOIN variation_client_requests r ON r.tenant_id = d.tenant_id AND r.id = d.request_id
     WHERE r.tenant_id = NEW.tenant_id AND r.variation_id = NEW.id
       AND r.snapshot_digest = OLD.snapshot_digest AND r.submitted_at = OLD.submitted_at
       AND d.decision = 'approved'
  ) THEN
    RAISE EXCEPTION 'This project needs the client''s approval of the submitted variation first'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER variation_order_client_approval BEFORE UPDATE OF status ON "variation_orders"
  FOR EACH ROW EXECUTE FUNCTION app.hold_variation_for_client();

-- Row-level security -----------------------------------------------------------------------------
DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['project_client_settings', 'client_payment_instructions',
    'fx_rates', 'client_preferences', 'client_payments', 'variation_client_requests',
    'variation_client_decisions']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = app.current_tenant_id()) '
      'WITH CHECK (tenant_id = app.current_tenant_id())', target || '_isolation', target);
  END LOOP;
END
$$;

-- A display preference is its owner's alone (read and written by that user only).
CREATE POLICY client_preferences_own ON "client_preferences" AS RESTRICTIVE
  USING (user_id = app.current_user_id()) WITH CHECK (user_id = app.current_user_id());

-- Restrictive policies (added to tenant isolation) for client members — the `client` system role,
-- or a custom role made only of projects.view, bq.view and portal.client (packages/types
-- portalFor, as app.acts_as_client):
-- they read only rows of the projects they are assigned to (the portal API further requires
-- portal.client in role ∩ assignment), certified certificates only, general (never incident)
-- photos only and only variations sent to them; they write only their own variation decisions.
-- Anyone else is unaffected. The subqueries do not depend on the row, so PostgreSQL evaluates
-- them once per statement.
DO $$
DECLARE
  not_client constant text := 'NOT EXISTS (SELECT 1 FROM memberships m '
    'LEFT JOIN tenant_roles r ON r.tenant_id = m.tenant_id AND r.id = m.custom_role_id '
    'WHERE m.tenant_id = app.current_tenant_id() AND m.user_id = app.current_user_id() '
    'AND (m.role = ''client'' OR (m.role = ''custom'' AND ''portal.client'' = ANY (r.permissions) '
    'AND r.permissions <@ ARRAY[''projects.view'', ''bq.view'', ''portal.client'']::text[])))';
  assigned constant text := 'SELECT pm.project_id FROM project_memberships pm '
    'WHERE pm.tenant_id = app.current_tenant_id() AND pm.user_id = app.current_user_id()';
  rule record;
BEGIN
  FOR rule IN SELECT * FROM (VALUES
    ('projects', 'id IN (' || assigned || ')', false),
    ('sites', 'project_id IN (' || assigned || ')', false),
    ('milestones', 'project_id IN (' || assigned || ')', false),
    ('site_diaries', 'project_id IN (' || assigned || ')', false),
    ('site_photos', 'purpose = ''general'' AND project_id IN (' || assigned || ')', false),
    ('progress_measurements', 'project_id IN (' || assigned || ')', false),
    ('schedule_activities', 'project_id IN (' || assigned || ')', false),
    ('schedule_baselines', 'project_id IN (' || assigned || ')', false),
    ('schedule_baseline_items', 'baseline_id IN (SELECT b.id FROM schedule_baselines b)', false),
    ('bqs', 'project_id IN (' || assigned || ')', false),
    ('bq_versions', 'project_id IN (' || assigned || ')', false),
    ('valuations', 'status = ''certified'' AND project_id IN (' || assigned || ')', false),
    ('valuation_lines', 'valuation_id IN (SELECT v.id FROM valuations v)', false),
    ('valuation_materials', 'valuation_id IN (SELECT v.id FROM valuations v)', false),
    ('valuation_adjustments', 'valuation_id IN (SELECT v.id FROM valuations v)', false),
    ('variation_orders',
      'id IN (SELECT r.variation_id FROM variation_client_requests r)', false),
    ('project_client_settings', 'project_id IN (' || assigned || ')', false),
    ('client_payments', 'project_id IN (' || assigned || ')', false),
    ('variation_client_requests', 'project_id IN (' || assigned || ')', false),
    ('variation_client_decisions', 'project_id IN (' || assigned || ')', true)
  ) AS rules(target, scope, writable)
  LOOP
    EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE USING (%s OR (%s)) WITH CHECK (%s%s)',
      rule.target || '_client_portal', rule.target, not_client, rule.scope, not_client,
      CASE WHEN rule.writable THEN ' OR (' || rule.scope || ')' ELSE '' END);
  END LOOP;
END
$$;

-- The company's working records are never a client's: a client member (as above) reads and writes
-- none of them (instructions, variation lines and history, rate build-ups, workers, attendance,
-- payroll, costs, cash flow, safety incidents and supplier payout details); anyone else is
-- unaffected. Clients see a variation through the view frozen when it was sent to them.
DO $$
DECLARE
  not_client constant text := 'NOT EXISTS (SELECT 1 FROM memberships m '
    'LEFT JOIN tenant_roles r ON r.tenant_id = m.tenant_id AND r.id = m.custom_role_id '
    'WHERE m.tenant_id = app.current_tenant_id() AND m.user_id = app.current_user_id() '
    'AND (m.role = ''client'' OR (m.role = ''custom'' AND ''portal.client'' = ANY (r.permissions) '
    'AND r.permissions <@ ARRAY[''projects.view'', ''bq.view'', ''portal.client'']::text[])))';
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['instructions', 'variation_lines', 'variation_status_changes',
    'rate_buildups', 'rate_buildup_versions', 'rate_buildup_lines', 'bq_item_rate_links',
    'rate_buildup_line_materials', 'labourers', 'attendance_records', 'payroll_lines',
    'cost_entries', 'cost_journal_lines', 'petty_cash_expenses', 'cash_flow_items',
    'safety_incidents', 'safety_incident_people', 'first_aid_treatments',
    'supplier_payout_versions']
  LOOP
    EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE USING (%s) WITH CHECK (%s)',
      target || '_client_portal', target, not_client, not_client);
  END LOOP;
END
$$;

-- The runtime role never deletes these rows and never rewrites the append-only ones (only a
-- display preference is updated, by its owner).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmb_app') THEN
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON "project_client_settings",
      "client_payment_instructions", "fx_rates", "client_preferences", "client_payments",
      "variation_client_requests", "variation_client_decisions" FROM pmb_app;
    REVOKE UPDATE ON "project_client_settings", "client_payment_instructions", "fx_rates",
      "client_payments", "variation_client_requests", "variation_client_decisions" FROM pmb_app;
    GRANT EXECUTE ON FUNCTION app.acts_as_client(uuid, uuid) TO pmb_app;
  END IF;
END
$$;
REVOKE EXECUTE ON FUNCTION app.acts_as_client(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_project_client_settings() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_client_payment_instructions() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_fx_rate() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.stamp_client_preference() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_client_payment() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_variation_client_request() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_variation_client_decision() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.hold_variation_for_client() FROM PUBLIC;

COMMIT;
