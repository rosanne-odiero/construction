-- D4.2 Daraja integration (ARCHITECTURE §4.5, ERD §7; brief §5.7, §15 D; WORKFLOWS "Payment
-- attempts"). Provider-neutral payment tables:
-- * payment_settings: a company's environment (mock/sandbox; production refused by CHECK until the
--   go-live gate, CR-PMT-04), shortcodes, limits (DEMO placeholders, CR-PMT-02), the payout master
--   switch (off by default) and write-only Daraja secrets sealed with the field cipher.
-- * payment_callback_routes: unguessable, rotatable callback path tokens (digest lookup).
-- * payment_requests (immutable intent) and payment_attempts (one provider call each, with the state
--   machine enforced by a guard trigger; one live attempt per request; provider identifiers and
--   receipts unique per company and written once; call intent persisted before `submitting`).
-- * payment_events: the append-only state timeline.
-- * payment_callback_inbox: durable intake (sealed raw body, redacted copy, duplicate fingerprint).
-- * payment_cases: reconciliation cases (unknown outcomes, quarantined callbacks, disputes).
-- * payment_provider_queries / payment_provider_transactions: status/balance queries and receipts.
-- * payment_outbox: the transactional outbox relayed to BullMQ.
-- * The catalogue gains payments.manage_credentials, payments.review and payments.initiate_test.
-- Every new table has tenant_id, forced RLS with WITH CHECK, composite (tenant_id, …) foreign keys
-- and no DELETE/TRUNCATE/REFERENCES/TRIGGER for pmb_app; the timeline and receipts are insert-only.
-- Two SECURITY DEFINER functions return identifiers only for cross-company discovery (callback
-- token → company, due outbox work and stuck attempts).
BEGIN;

-- CreateTable
CREATE TABLE "payment_settings" (
    "tenant_id" UUID NOT NULL,
    "environment" VARCHAR(12) NOT NULL DEFAULT 'mock',
    "payouts_enabled" BOOLEAN NOT NULL DEFAULT false,
    "payouts_changed_at" TIMESTAMPTZ,
    "payouts_changed_by" UUID,
    "stk_shortcode" VARCHAR(12),
    "stk_party_b" VARCHAR(12),
    "stk_transaction_type" VARCHAR(30) NOT NULL DEFAULT 'CustomerPayBillOnline',
    "c2b_shortcode" VARCHAR(12),
    "b2c_shortcode" VARCHAR(12),
    "b2b_shortcode" VARCHAR(12),
    "stk_max_minor" BIGINT NOT NULL,
    "b2c_min_minor" BIGINT NOT NULL,
    "b2c_max_minor" BIGINT NOT NULL,
    "b2b_max_minor" BIGINT NOT NULL,
    "daily_payout_max_minor" BIGINT NOT NULL,
    "limits_status" VARCHAR(12) NOT NULL DEFAULT 'demo',
    "consumer_key_enc" BYTEA,
    "consumer_key_set_at" TIMESTAMPTZ,
    "consumer_secret_enc" BYTEA,
    "consumer_secret_set_at" TIMESTAMPTZ,
    "initiator_name_enc" BYTEA,
    "initiator_name_set_at" TIMESTAMPTZ,
    "initiator_password_enc" BYTEA,
    "initiator_password_set_at" TIMESTAMPTZ,
    "passkey_enc" BYTEA,
    "passkey_set_at" TIMESTAMPTZ,
    "credentials_version" INTEGER NOT NULL DEFAULT 0,
    "credentials_updated_at" TIMESTAMPTZ,
    "credentials_updated_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_settings_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "payment_callback_routes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "token_digest" CHAR(64) NOT NULL,
    "token_enc" BYTEA NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'active',
    "active_marker" VARCHAR(2) DEFAULT 'on',
    "accept_until" TIMESTAMPTZ,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retired_by" UUID,
    "retired_at" TIMESTAMPTZ,

    CONSTRAINT "payment_callback_routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "reference" VARCHAR(20) NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "direction" VARCHAR(3) NOT NULL,
    "purpose" VARCHAR(30) NOT NULL,
    "purpose_ref" UUID,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'KES',
    "msisdn_enc" BYTEA,
    "msisdn_masked" VARCHAR(20),
    "party_b" VARCHAR(12),
    "account_reference" VARCHAR(20),
    "command" VARCHAR(30),
    "description" VARCHAR(100),
    "occasion" VARCHAR(100),
    "project_id" UUID,
    "environment" VARCHAR(12) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'in_progress',
    "idempotency_key" VARCHAR(128) NOT NULL,
    "fingerprint" CHAR(64) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_attempts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "direction" VARCHAR(3) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'KES',
    "reverses_attempt_id" UUID,
    "status" VARCHAR(20) NOT NULL DEFAULT 'created',
    "live_marker" VARCHAR(2),
    "reversal_marker" VARCHAR(2),
    "version" INTEGER NOT NULL DEFAULT 1,
    "environment" VARCHAR(12) NOT NULL,
    "shortcode" VARCHAR(12),
    "route_id" UUID NOT NULL,
    "originator_conversation_id" VARCHAR(100),
    "conversation_id" VARCHAR(100),
    "merchant_request_id" VARCHAR(100),
    "checkout_request_id" VARCHAR(100),
    "receipt" VARCHAR(30),
    "result_code" VARCHAR(20),
    "result_desc" VARCHAR(300),
    "reason" VARCHAR(40),
    "provider_code" VARCHAR(30),
    "request_digest" CHAR(64),
    "lease_owner" VARCHAR(80),
    "lease_expires_at" TIMESTAMPTZ,
    "submitted_at" TIMESTAMPTZ,
    "accepted_at" TIMESTAMPTZ,
    "result_due_at" TIMESTAMPTZ,
    "finalized_at" TIMESTAMPTZ,
    "status_queries" INTEGER NOT NULL DEFAULT 0,
    "next_status_query_at" TIMESTAMPTZ,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "subject_type" VARCHAR(12) NOT NULL,
    "subject_id" UUID NOT NULL,
    "request_id" UUID,
    "event" VARCHAR(60) NOT NULL,
    "from_status" VARCHAR(20),
    "to_status" VARCHAR(20),
    "reason" VARCHAR(40),
    "actor_id" UUID,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_callback_inbox" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "route_id" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'received',
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source_ip" VARCHAR(45),
    "body_sha256" CHAR(64) NOT NULL,
    "body_bytes" INTEGER NOT NULL,
    "body_enc" BYTEA NOT NULL,
    "redacted_body" JSONB NOT NULL,
    "fingerprint" CHAR(64) NOT NULL,
    "duplicates" INTEGER NOT NULL DEFAULT 0,
    "last_duplicate_at" TIMESTAMPTZ,
    "processed_at" TIMESTAMPTZ,
    "attempt_id" UUID,
    "query_id" UUID,
    "quarantine_reason" VARCHAR(30),
    "review_decision" VARCHAR(10),
    "review_reason" VARCHAR(500),
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "payment_callback_inbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_cases" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'open',
    "open_marker" VARCHAR(4) DEFAULT 'open',
    "request_id" UUID,
    "attempt_id" UUID,
    "callback_id" UUID,
    "reason" VARCHAR(40) NOT NULL,
    "owner" VARCHAR(40) NOT NULL DEFAULT 'finance',
    "opened_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolution" VARCHAR(20),
    "resolution_note" VARCHAR(500),
    "resolved_by" UUID,
    "resolved_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "payment_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_provider_queries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'sent',
    "attempt_id" UUID,
    "originator_conversation_id" VARCHAR(100),
    "conversation_id" VARCHAR(100),
    "result_code" VARCHAR(20),
    "summary" VARCHAR(300),
    "balances" JSONB,
    "requested_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answered_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "payment_provider_queries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_provider_transactions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" VARCHAR(10) NOT NULL,
    "direction" VARCHAR(3) NOT NULL,
    "status" VARCHAR(12) NOT NULL,
    "receipt" VARCHAR(30) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'KES',
    "shortcode" VARCHAR(12),
    "account_reference" VARCHAR(40),
    "attempt_id" UUID,
    "callback_id" UUID,
    "completed_at_raw" VARCHAR(30),
    "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_provider_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_outbox" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "topic" VARCHAR(40) NOT NULL,
    "ref_id" UUID NOT NULL,
    "pending_marker" VARCHAR(1) DEFAULT 'p',
    "available_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatched_at" TIMESTAMPTZ,
    "processed_at" TIMESTAMPTZ,
    "dead_at" TIMESTAMPTZ,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" VARCHAR(80),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_callback_routes_token_digest_key" ON "payment_callback_routes"("token_digest");

-- CreateIndex
CREATE UNIQUE INDEX "payment_callback_routes_tenant_id_id_key" ON "payment_callback_routes"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_callback_routes_tenant_id_active_marker_key" ON "payment_callback_routes"("tenant_id", "active_marker");

-- CreateIndex
CREATE INDEX "payment_requests_tenant_id_status_created_at_idx" ON "payment_requests"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_requests_tenant_id_id_key" ON "payment_requests"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_requests_tenant_id_reference_key" ON "payment_requests"("tenant_id", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "payment_requests_tenant_id_idempotency_key_key" ON "payment_requests"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "payment_attempts_tenant_id_status_idx" ON "payment_attempts"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "payment_attempts_status_updated_at_idx" ON "payment_attempts"("status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_tenant_id_id_key" ON "payment_attempts"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_tenant_id_request_id_sequence_key" ON "payment_attempts"("tenant_id", "request_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_tenant_id_request_id_live_marker_key" ON "payment_attempts"("tenant_id", "request_id", "live_marker");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_tenant_id_reverses_attempt_id_reversal_mar_key" ON "payment_attempts"("tenant_id", "reverses_attempt_id", "reversal_marker");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_tenant_id_originator_conversation_id_key" ON "payment_attempts"("tenant_id", "originator_conversation_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_tenant_id_conversation_id_key" ON "payment_attempts"("tenant_id", "conversation_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_tenant_id_merchant_request_id_key" ON "payment_attempts"("tenant_id", "merchant_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_tenant_id_checkout_request_id_key" ON "payment_attempts"("tenant_id", "checkout_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_tenant_id_receipt_key" ON "payment_attempts"("tenant_id", "receipt");

-- CreateIndex
CREATE INDEX "payment_events_tenant_id_request_id_created_at_idx" ON "payment_events"("tenant_id", "request_id", "created_at");

-- CreateIndex
CREATE INDEX "payment_events_tenant_id_subject_id_created_at_idx" ON "payment_events"("tenant_id", "subject_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_events_tenant_id_id_key" ON "payment_events"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "payment_callback_inbox_tenant_id_status_received_at_idx" ON "payment_callback_inbox"("tenant_id", "status", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_callback_inbox_tenant_id_id_key" ON "payment_callback_inbox"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_callback_inbox_tenant_id_fingerprint_key" ON "payment_callback_inbox"("tenant_id", "fingerprint");

-- CreateIndex
CREATE INDEX "payment_cases_tenant_id_status_opened_at_idx" ON "payment_cases"("tenant_id", "status", "opened_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_cases_tenant_id_id_key" ON "payment_cases"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_cases_tenant_id_attempt_id_kind_open_marker_key" ON "payment_cases"("tenant_id", "attempt_id", "kind", "open_marker");

-- CreateIndex
CREATE UNIQUE INDEX "payment_cases_tenant_id_callback_id_open_marker_key" ON "payment_cases"("tenant_id", "callback_id", "open_marker");

-- CreateIndex
CREATE INDEX "payment_provider_queries_tenant_id_kind_created_at_idx" ON "payment_provider_queries"("tenant_id", "kind", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_provider_queries_tenant_id_id_key" ON "payment_provider_queries"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_provider_queries_tenant_id_originator_conversation__key" ON "payment_provider_queries"("tenant_id", "originator_conversation_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_provider_queries_tenant_id_conversation_id_key" ON "payment_provider_queries"("tenant_id", "conversation_id");

-- CreateIndex
CREATE INDEX "payment_provider_transactions_tenant_id_kind_recorded_at_idx" ON "payment_provider_transactions"("tenant_id", "kind", "recorded_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_provider_transactions_tenant_id_id_key" ON "payment_provider_transactions"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_provider_transactions_tenant_id_receipt_key" ON "payment_provider_transactions"("tenant_id", "receipt");

-- CreateIndex
CREATE INDEX "payment_outbox_processed_at_dead_at_available_at_idx" ON "payment_outbox"("processed_at", "dead_at", "available_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_outbox_tenant_id_id_key" ON "payment_outbox"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_outbox_tenant_id_topic_ref_id_pending_marker_key" ON "payment_outbox"("tenant_id", "topic", "ref_id", "pending_marker");

-- AddForeignKey
ALTER TABLE "payment_settings" ADD CONSTRAINT "payment_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_callback_routes" ADD CONSTRAINT "payment_callback_routes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_tenant_id_request_id_fkey" FOREIGN KEY ("tenant_id", "request_id") REFERENCES "payment_requests"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_tenant_id_route_id_fkey" FOREIGN KEY ("tenant_id", "route_id") REFERENCES "payment_callback_routes"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_tenant_id_reverses_attempt_id_fkey" FOREIGN KEY ("tenant_id", "reverses_attempt_id") REFERENCES "payment_attempts"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_callback_inbox" ADD CONSTRAINT "payment_callback_inbox_tenant_id_route_id_fkey" FOREIGN KEY ("tenant_id", "route_id") REFERENCES "payment_callback_routes"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_callback_inbox" ADD CONSTRAINT "payment_callback_inbox_tenant_id_attempt_id_fkey" FOREIGN KEY ("tenant_id", "attempt_id") REFERENCES "payment_attempts"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_callback_inbox" ADD CONSTRAINT "payment_callback_inbox_tenant_id_query_id_fkey" FOREIGN KEY ("tenant_id", "query_id") REFERENCES "payment_provider_queries"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_callback_inbox" ADD CONSTRAINT "payment_callback_inbox_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_cases" ADD CONSTRAINT "payment_cases_tenant_id_attempt_id_fkey" FOREIGN KEY ("tenant_id", "attempt_id") REFERENCES "payment_attempts"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_cases" ADD CONSTRAINT "payment_cases_tenant_id_callback_id_fkey" FOREIGN KEY ("tenant_id", "callback_id") REFERENCES "payment_callback_inbox"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_cases" ADD CONSTRAINT "payment_cases_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_provider_queries" ADD CONSTRAINT "payment_provider_queries_tenant_id_attempt_id_fkey" FOREIGN KEY ("tenant_id", "attempt_id") REFERENCES "payment_attempts"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_provider_queries" ADD CONSTRAINT "payment_provider_queries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_provider_transactions" ADD CONSTRAINT "payment_provider_transactions_tenant_id_attempt_id_fkey" FOREIGN KEY ("tenant_id", "attempt_id") REFERENCES "payment_attempts"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_provider_transactions" ADD CONSTRAINT "payment_provider_transactions_tenant_id_callback_id_fkey" FOREIGN KEY ("tenant_id", "callback_id") REFERENCES "payment_callback_inbox"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_provider_transactions" ADD CONSTRAINT "payment_provider_transactions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_outbox" ADD CONSTRAINT "payment_outbox_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written part ===============================================================================

-- Settings ---------------------------------------------------------------------------------------
-- Production stays refused here and in the API until a company passes the go-live gate
-- (COMPLIANCE-REVIEW CR-PMT-04): a reviewed migration has to lift this CHECK.
ALTER TABLE "payment_settings" ADD CONSTRAINT "payment_settings_environment_check" CHECK (
  environment IN ('mock', 'sandbox')
);
ALTER TABLE "payment_settings" ADD CONSTRAINT "payment_settings_values_check" CHECK (
  stk_transaction_type IN ('CustomerPayBillOnline', 'CustomerBuyGoodsOnline')
  AND (stk_shortcode IS NULL OR stk_shortcode ~ '^\d{5,9}$')
  AND (stk_party_b IS NULL OR stk_party_b ~ '^\d{5,9}$')
  AND (c2b_shortcode IS NULL OR c2b_shortcode ~ '^\d{5,9}$')
  AND (b2c_shortcode IS NULL OR b2c_shortcode ~ '^\d{5,9}$')
  AND (b2b_shortcode IS NULL OR b2b_shortcode ~ '^\d{5,9}$')
  AND limits_status IN ('demo', 'reviewed')
  AND stk_max_minor BETWEEN 100 AND 100000000000 AND stk_max_minor % 100 = 0
  AND b2c_min_minor BETWEEN 100 AND 100000000000 AND b2c_min_minor % 100 = 0
  AND b2c_max_minor BETWEEN b2c_min_minor AND 100000000000 AND b2c_max_minor % 100 = 0
  AND b2b_max_minor BETWEEN 100 AND 100000000000 AND b2b_max_minor % 100 = 0
  AND daily_payout_max_minor BETWEEN 100 AND 100000000000 AND daily_payout_max_minor % 100 = 0
  AND credentials_version >= 0 AND version >= 1
);
ALTER TABLE "payment_settings" ADD CONSTRAINT "payment_settings_secrets_check" CHECK (
  app.is_field_ciphertext(consumer_key_enc) AND app.is_field_ciphertext(consumer_secret_enc)
  AND app.is_field_ciphertext(initiator_name_enc) AND app.is_field_ciphertext(initiator_password_enc)
  AND app.is_field_ciphertext(passkey_enc)
  AND (consumer_key_enc IS NULL) = (consumer_key_set_at IS NULL)
  AND (consumer_secret_enc IS NULL) = (consumer_secret_set_at IS NULL)
  AND (initiator_name_enc IS NULL) = (initiator_name_set_at IS NULL)
  AND (initiator_password_enc IS NULL) = (initiator_password_set_at IS NULL)
  AND (passkey_enc IS NULL) = (passkey_set_at IS NULL)
);

CREATE FUNCTION app.guard_payment_settings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 OR NEW.payouts_enabled THEN
      RAISE EXCEPTION 'Payment settings start at version 1 with payouts off' USING ERRCODE = '23514';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Payment settings identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Payment settings change needs the next version' USING ERRCODE = '23514';
  END IF;
  IF NEW.payouts_enabled IS DISTINCT FROM OLD.payouts_enabled THEN
    NEW.payouts_changed_at := now();
    IF NEW.payouts_changed_by IS NULL THEN
      RAISE EXCEPTION 'Switching payouts records who did it' USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER payment_settings_guard BEFORE INSERT OR UPDATE ON "payment_settings"
  FOR EACH ROW EXECUTE FUNCTION app.guard_payment_settings();

-- Callback routes --------------------------------------------------------------------------------
ALTER TABLE "payment_callback_routes" ADD CONSTRAINT "payment_callback_routes_check" CHECK (
  token_digest ~ '^[0-9a-f]{64}$' AND app.is_field_ciphertext(token_enc) AND token_enc IS NOT NULL
  AND status IN ('active', 'retired')
  AND (status = 'active') = (retired_at IS NULL)
  AND (status = 'active') = (active_marker IS NOT NULL)
  AND (active_marker IS NULL OR active_marker = 'on')
);

CREATE FUNCTION app.guard_payment_callback_route() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' THEN
      RAISE EXCEPTION 'A callback route starts active' USING ERRCODE = '23514';
    END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  IF OLD.status <> 'active' OR NEW.status <> 'retired' OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.token_digest IS DISTINCT FROM OLD.token_digest
     OR NEW.token_enc IS DISTINCT FROM OLD.token_enc OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.retired_by IS NULL THEN
    RAISE EXCEPTION 'A callback route is only ever retired' USING ERRCODE = '23514';
  END IF;
  NEW.active_marker := NULL;
  NEW.retired_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER payment_callback_route_guard BEFORE INSERT OR UPDATE ON "payment_callback_routes"
  FOR EACH ROW EXECUTE FUNCTION app.guard_payment_callback_route();

-- Requests ---------------------------------------------------------------------------------------
ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_values_check" CHECK (
  reference ~ '^PAY-[0-9A-F]{8}$'
  AND kind IN ('stk_push', 'b2c', 'b2b_paybill', 'b2b_buygoods')
  AND direction IN ('in', 'out') AND (kind = 'stk_push') = (direction = 'in')
  AND purpose IN ('test', 'payroll_obligation', 'client_invoice', 'supplier_invoice')
  AND amount_minor BETWEEN 100 AND 100000000000 AND amount_minor % 100 = 0 AND currency = 'KES'
  AND environment IN ('mock', 'sandbox', 'production')
  AND status IN ('in_progress', 'uncertain', 'confirmed', 'failed', 'reversal_pending', 'reversed')
  AND idempotency_key ~ '^[A-Za-z0-9_-]{8,128}$' AND fingerprint ~ '^[0-9a-f]{64}$'
  AND app.is_field_ciphertext(msisdn_enc) AND version >= 1
);
-- STK and B2C reach a phone number (sealed, masked copy for display); B2B a shortcode and account.
ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_counterparty_check" CHECK (
  (kind IN ('stk_push', 'b2c') AND msisdn_enc IS NOT NULL AND msisdn_masked IS NOT NULL
    AND party_b IS NULL)
  OR (kind IN ('b2b_paybill', 'b2b_buygoods') AND msisdn_enc IS NULL AND msisdn_masked IS NULL
    AND party_b ~ '^\d{5,9}$' AND account_reference IS NOT NULL)
);

CREATE FUNCTION app.guard_payment_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'in_progress' OR NEW.version <> 1 THEN
      RAISE EXCEPTION 'A payment request starts in progress at version 1' USING ERRCODE = '23514';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.reference IS DISTINCT FROM OLD.reference OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.direction IS DISTINCT FROM OLD.direction OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.purpose_ref IS DISTINCT FROM OLD.purpose_ref
     OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.msisdn_enc IS DISTINCT FROM OLD.msisdn_enc OR NEW.msisdn_masked IS DISTINCT FROM OLD.msisdn_masked
     OR NEW.party_b IS DISTINCT FROM OLD.party_b
     OR NEW.account_reference IS DISTINCT FROM OLD.account_reference
     OR NEW.command IS DISTINCT FROM OLD.command OR NEW.description IS DISTINCT FROM OLD.description
     OR NEW.occasion IS DISTINCT FROM OLD.occasion OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.environment IS DISTINCT FROM OLD.environment
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.fingerprint IS DISTINCT FROM OLD.fingerprint
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'A payment request is immutable; only its derived status changes' USING ERRCODE = '23514';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Payment request change needs the next version' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER payment_request_guard BEFORE INSERT OR UPDATE ON "payment_requests"
  FOR EACH ROW EXECUTE FUNCTION app.guard_payment_request();

-- Attempts: the state machine of WORKFLOWS "Payment attempts" (packages/types
-- PAYMENT_ATTEMPT_TRANSITIONS lists the same edges; the e2e suite checks both agree).
CREATE FUNCTION app.payment_attempt_transition_allowed(from_status text, to_status text)
  RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT (from_status, to_status) IN (
    ('created', 'queued'), ('queued', 'submitting'),
    ('submitting', 'pending'), ('submitting', 'unknown'), ('submitting', 'failed'),
    ('pending', 'unknown'), ('pending', 'confirmed'), ('pending', 'failed'),
    ('unknown', 'confirmed'), ('unknown', 'failed'),
    ('confirmed', 'reversal_pending'),
    ('reversal_pending', 'reversed'), ('reversal_pending', 'confirmed')
  ) $$;

CREATE FUNCTION app.payment_request_status(attempt_status text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT CASE
    WHEN attempt_status IN ('created', 'queued', 'submitting', 'pending') THEN 'in_progress'
    WHEN attempt_status = 'unknown' THEN 'uncertain'
    ELSE attempt_status END $$;

ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_values_check" CHECK (
  kind IN ('stk_push', 'b2c', 'b2b_paybill', 'b2b_buygoods', 'reversal')
  AND direction IN ('in', 'out')
  AND amount_minor BETWEEN 100 AND 100000000000 AND amount_minor % 100 = 0 AND currency = 'KES'
  AND environment IN ('mock', 'sandbox', 'production')
  AND status IN ('created', 'queued', 'submitting', 'pending', 'unknown', 'confirmed', 'failed',
    'reversal_pending', 'reversed')
  AND sequence >= 1 AND version >= 1 AND status_queries >= 0
  AND (shortcode IS NULL OR shortcode ~ '^\d{5,9}$')
  AND (request_digest IS NULL OR request_digest ~ '^[0-9a-f]{64}$')
  AND (kind = 'reversal') = (reverses_attempt_id IS NOT NULL)
  AND (live_marker IS NULL OR live_marker = 'on') AND (reversal_marker IS NULL OR reversal_marker = 'on')
);
-- Call intent is persisted before the call (digest, lease, time); acceptance and settlement need
-- their evidence. A confirmed (or reversed) payment always has its M-Pesa receipt.
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_evidence_check" CHECK (
  (status <> 'submitting' OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL
    AND submitted_at IS NOT NULL AND request_digest IS NOT NULL))
  AND (status <> 'pending' OR accepted_at IS NOT NULL)
  AND (status NOT IN ('confirmed', 'reversal_pending', 'reversed') OR receipt IS NOT NULL)
);

CREATE FUNCTION app.guard_payment_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  original record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'created' OR NEW.version <> 1 OR NEW.receipt IS NOT NULL
       OR NEW.conversation_id IS NOT NULL OR NEW.merchant_request_id IS NOT NULL
       OR NEW.checkout_request_id IS NOT NULL THEN
      RAISE EXCEPTION 'A payment attempt starts created, without provider evidence' USING ERRCODE = '23514';
    END IF;
    IF NEW.kind = 'reversal' THEN
      SELECT status, amount_minor, direction INTO original FROM payment_attempts
      WHERE tenant_id = NEW.tenant_id AND id = NEW.reverses_attempt_id;
      IF original.status IS NULL OR original.status NOT IN ('confirmed', 'reversal_pending')
         OR original.amount_minor <> NEW.amount_minor OR original.direction = NEW.direction THEN
        RAISE EXCEPTION 'A reversal reverses a confirmed attempt in full, in the other direction'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
  ELSE
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.sequence IS DISTINCT FROM OLD.sequence
       OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.direction IS DISTINCT FROM OLD.direction
       OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.reverses_attempt_id IS DISTINCT FROM OLD.reverses_attempt_id
       OR NEW.environment IS DISTINCT FROM OLD.environment OR NEW.shortcode IS DISTINCT FROM OLD.shortcode
       OR NEW.route_id IS DISTINCT FROM OLD.route_id OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'A payment attempt''s amount, parties and identity are immutable' USING ERRCODE = '23514';
    END IF;
    -- Provider identifiers, the receipt and the call intent are written once.
    IF (OLD.originator_conversation_id IS NOT NULL AND NEW.originator_conversation_id IS DISTINCT FROM OLD.originator_conversation_id)
       OR (OLD.conversation_id IS NOT NULL AND NEW.conversation_id IS DISTINCT FROM OLD.conversation_id)
       OR (OLD.merchant_request_id IS NOT NULL AND NEW.merchant_request_id IS DISTINCT FROM OLD.merchant_request_id)
       OR (OLD.checkout_request_id IS NOT NULL AND NEW.checkout_request_id IS DISTINCT FROM OLD.checkout_request_id)
       OR (OLD.receipt IS NOT NULL AND NEW.receipt IS DISTINCT FROM OLD.receipt)
       OR (OLD.request_digest IS NOT NULL AND NEW.request_digest IS DISTINCT FROM OLD.request_digest)
       OR (OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS DISTINCT FROM OLD.submitted_at) THEN
      RAISE EXCEPTION 'Provider evidence is never rewritten' USING ERRCODE = '23514';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'Payment attempt change needs the next version' USING ERRCODE = '23514';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF NOT app.payment_attempt_transition_allowed(OLD.status, NEW.status) THEN
        RAISE EXCEPTION 'Payment attempt cannot move from % to %', OLD.status, NEW.status
          USING ERRCODE = '23514';
      END IF;
      IF NEW.status IN ('confirmed', 'failed', 'reversed') AND OLD.status NOT IN ('confirmed', 'reversal_pending') THEN
        NEW.finalized_at := now();
      END IF;
    END IF;
    NEW.updated_at := now();
  END IF;
  NEW.live_marker := CASE WHEN NEW.kind <> 'reversal' AND NEW.status NOT IN ('failed', 'reversed')
    THEN 'on' END;
  NEW.reversal_marker := CASE WHEN NEW.kind = 'reversal' AND NEW.status <> 'failed' THEN 'on' END;
  RETURN NEW;
END
$$;
CREATE TRIGGER payment_attempt_guard BEFORE INSERT OR UPDATE ON "payment_attempts"
  FOR EACH ROW EXECUTE FUNCTION app.guard_payment_attempt();

-- The request's summary status follows its latest (non-reversal) attempt in the same transaction.
CREATE FUNCTION app.sync_payment_request_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'reversal' THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM payment_attempts a
    WHERE a.tenant_id = NEW.tenant_id AND a.request_id = NEW.request_id AND a.kind <> 'reversal'
      AND a.sequence > NEW.sequence
  ) THEN
    UPDATE payment_requests SET status = app.payment_request_status(NEW.status), version = version + 1
    WHERE tenant_id = NEW.tenant_id AND id = NEW.request_id
      AND status IS DISTINCT FROM app.payment_request_status(NEW.status);
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER payment_attempt_request_status AFTER INSERT OR UPDATE OF status ON "payment_attempts"
  FOR EACH ROW EXECUTE FUNCTION app.sync_payment_request_status();

-- Timeline (append-only) -------------------------------------------------------------------------
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_check" CHECK (
  subject_type IN ('request', 'attempt', 'callback', 'case', 'settings', 'query')
  AND event ~ '^[a-z][a-z0-9_.]{2,59}$' AND jsonb_typeof(detail) = 'object'
);
CREATE TRIGGER payment_events_stamp BEFORE INSERT ON "payment_events"
  FOR EACH ROW EXECUTE FUNCTION app.stamp_created_at();
CREATE TRIGGER payment_events_append_only BEFORE UPDATE OR DELETE ON "payment_events"
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();

-- Callback inbox ---------------------------------------------------------------------------------
ALTER TABLE "payment_callback_inbox" ADD CONSTRAINT "payment_callback_inbox_check" CHECK (
  kind IN ('stk', 'b2c_result', 'b2b_result', 'status_result', 'balance_result', 'reversal_result',
    'timeout', 'c2b_validation', 'c2b_confirmation')
  AND status IN ('received', 'processed', 'quarantined', 'resolved', 'dismissed')
  AND body_sha256 ~ '^[0-9a-f]{64}$' AND fingerprint ~ '^[0-9a-f]{64}$' AND body_bytes >= 0
  AND body_enc IS NOT NULL AND app.is_field_ciphertext(body_enc)
  AND jsonb_typeof(redacted_body) = 'object' AND duplicates >= 0 AND version >= 1
  AND (quarantine_reason IS NULL OR quarantine_reason IN ('unknown_request', 'malformed',
    'amount_mismatch', 'currency_mismatch', 'direction_mismatch', 'shortcode_mismatch',
    'kind_mismatch', 'conflicting_result', 'duplicate_receipt', 'unsupported'))
  AND (status NOT IN ('quarantined', 'resolved', 'dismissed') OR quarantine_reason IS NOT NULL)
  AND (status IN ('resolved', 'dismissed')) = (review_decision IS NOT NULL)
  AND (review_decision IS NULL OR (review_decision = status AND review_reason IS NOT NULL
    AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);

CREATE FUNCTION app.guard_payment_callback() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'received' OR NEW.version <> 1 OR NEW.review_decision IS NOT NULL THEN
      RAISE EXCEPTION 'A callback enters the inbox as received' USING ERRCODE = '23514';
    END IF;
    NEW.received_at := now();
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.route_id IS DISTINCT FROM OLD.route_id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.received_at IS DISTINCT FROM OLD.received_at OR NEW.source_ip IS DISTINCT FROM OLD.source_ip
     OR NEW.body_sha256 IS DISTINCT FROM OLD.body_sha256 OR NEW.body_bytes IS DISTINCT FROM OLD.body_bytes
     OR NEW.body_enc IS DISTINCT FROM OLD.body_enc OR NEW.redacted_body IS DISTINCT FROM OLD.redacted_body
     OR NEW.fingerprint IS DISTINCT FROM OLD.fingerprint THEN
    RAISE EXCEPTION 'Received callback evidence is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Callback change needs the next version' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'received' AND NEW.status IN ('processed', 'quarantined'))
    OR (OLD.status = 'quarantined' AND NEW.status IN ('processed', 'resolved', 'dismissed'))
  ) THEN
    RAISE EXCEPTION 'Callback cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('resolved', 'dismissed') AND (NEW.review_decision IS DISTINCT FROM OLD.review_decision
     OR NEW.review_reason IS DISTINCT FROM OLD.review_reason OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by) THEN
    RAISE EXCEPTION 'A review is recorded once' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('resolved', 'dismissed') AND OLD.status = 'quarantined' THEN
    NEW.reviewed_at := now();
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER payment_callback_guard BEFORE INSERT OR UPDATE ON "payment_callback_inbox"
  FOR EACH ROW EXECUTE FUNCTION app.guard_payment_callback();

-- Reconciliation cases ---------------------------------------------------------------------------
ALTER TABLE "payment_cases" ADD CONSTRAINT "payment_cases_check" CHECK (
  kind IN ('unknown_outcome', 'quarantined_callback', 'conflicting_evidence', 'unverified_success')
  AND status IN ('open', 'resolved', 'dismissed')
  AND (attempt_id IS NOT NULL OR callback_id IS NOT NULL)
  AND (status = 'open') = (open_marker IS NOT NULL) AND (open_marker IS NULL OR open_marker = 'open')
  AND (status = 'open') = (resolution IS NULL AND resolved_at IS NULL)
  AND (resolution IS NULL OR resolution IN ('confirmed', 'failed', 'no_payment_effect', 'dismissed'))
  AND (status <> 'dismissed' OR resolution = 'dismissed')
  AND reason ~ '^[a-z][a-z0-9_]{2,39}$' AND version >= 1
);

CREATE FUNCTION app.guard_payment_case() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' OR NEW.version <> 1 THEN
      RAISE EXCEPTION 'A reconciliation case opens open' USING ERRCODE = '23514';
    END IF;
    NEW.opened_at := now();
    RETURN NEW;
  END IF;
  IF OLD.status <> 'open' OR NEW.status NOT IN ('resolved', 'dismissed')
     OR NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id OR NEW.callback_id IS DISTINCT FROM OLD.callback_id
     OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.opened_at IS DISTINCT FROM OLD.opened_at
     OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'A reconciliation case is closed once and never rewritten' USING ERRCODE = '23514';
  END IF;
  NEW.open_marker := NULL;
  NEW.resolved_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER payment_case_guard BEFORE INSERT OR UPDATE ON "payment_cases"
  FOR EACH ROW EXECUTE FUNCTION app.guard_payment_case();

-- Provider queries and receipts ------------------------------------------------------------------
ALTER TABLE "payment_provider_queries" ADD CONSTRAINT "payment_provider_queries_check" CHECK (
  kind IN ('transaction_status', 'stk_query', 'account_balance', 'c2b_register')
  AND status IN ('sent', 'answered', 'failed', 'unknown')
  AND (balances IS NULL OR jsonb_typeof(balances) = 'array') AND version >= 1
);

CREATE FUNCTION app.guard_provider_query() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.originator_conversation_id IS NOT NULL AND NEW.originator_conversation_id IS DISTINCT FROM OLD.originator_conversation_id)
     OR (OLD.conversation_id IS NOT NULL AND NEW.conversation_id IS DISTINCT FROM OLD.conversation_id)
     OR OLD.status = 'answered' OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'A provider query is answered once' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'answered' THEN
    NEW.answered_at := now();
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER provider_query_guard BEFORE INSERT OR UPDATE ON "payment_provider_queries"
  FOR EACH ROW EXECUTE FUNCTION app.guard_provider_query();

CREATE FUNCTION app.stamp_recorded_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.recorded_at := now();
  RETURN NEW;
END
$$;
ALTER TABLE "payment_provider_transactions" ADD CONSTRAINT "payment_provider_transactions_check" CHECK (
  kind IN ('stk', 'c2b', 'b2c', 'b2b', 'reversal') AND direction IN ('in', 'out')
  AND status IN ('matched', 'unallocated', 'disputed')
  AND receipt ~ '^[A-Za-z0-9_-]{4,30}$'
  AND amount_minor BETWEEN 1 AND 100000000000 AND currency = 'KES'
  AND (status <> 'matched' OR attempt_id IS NOT NULL)
);
CREATE TRIGGER payment_provider_transactions_stamp BEFORE INSERT ON "payment_provider_transactions"
  FOR EACH ROW EXECUTE FUNCTION app.stamp_recorded_at();
CREATE TRIGGER payment_provider_transactions_append_only BEFORE UPDATE OR DELETE
  ON "payment_provider_transactions" FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();

-- Outbox -----------------------------------------------------------------------------------------
ALTER TABLE "payment_outbox" ADD CONSTRAINT "payment_outbox_check" CHECK (
  topic IN ('attempt.submit', 'attempt.status_query', 'callback.process', 'balance.query',
    'c2b.register')
  AND attempts >= 0
  AND (pending_marker IS NULL OR pending_marker = 'p')
  AND (pending_marker IS NULL) = (processed_at IS NOT NULL OR dead_at IS NOT NULL)
);

CREATE FUNCTION app.guard_payment_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
    NEW.pending_marker := 'p';
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.topic IS DISTINCT FROM OLD.topic OR NEW.ref_id IS DISTINCT FROM OLD.ref_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.processed_at IS NOT NULL AND NEW.processed_at IS DISTINCT FROM OLD.processed_at)
     OR (OLD.dead_at IS NOT NULL AND NEW.dead_at IS DISTINCT FROM OLD.dead_at) THEN
    RAISE EXCEPTION 'Outbox work is completed once and never rewritten' USING ERRCODE = '23514';
  END IF;
  NEW.pending_marker := CASE WHEN NEW.processed_at IS NULL AND NEW.dead_at IS NULL THEN 'p' END;
  RETURN NEW;
END
$$;
CREATE TRIGGER payment_outbox_guard BEFORE INSERT OR UPDATE ON "payment_outbox"
  FOR EACH ROW EXECUTE FUNCTION app.guard_payment_outbox();

-- The catalogue gains payments.manage_credentials, payments.review and payments.initiate_test
-- (packages/types PERMISSIONS; not project-assignable). Both constraints only widen.
-- REBASE NOTE: this list must stay the union of every permission added by earlier migrations.
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
    'payments.record_cash', 'payments.reverse', 'payments.manage_credentials',
    'payments.review', 'payments.initiate_test', 'procurement.requisition',
    'procurement.approve', 'procurement.manage_suppliers', 'stores.manage', 'finance.view',
    'finance.manage', 'finance.view_sensitive', 'site.diary', 'site.photos', 'quality.manage',
    'safety.manage', 'plant.manage', 'documents.manage', 'reports.view', 'portal.client',
    'portal.supplier', 'portal.worker'
  ]::text[]
);

-- Row-level security -----------------------------------------------------------------------------
ALTER TABLE "payment_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_settings" FORCE ROW LEVEL SECURITY;
ALTER TABLE "payment_callback_routes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_callback_routes" FORCE ROW LEVEL SECURITY;
ALTER TABLE "payment_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_requests" FORCE ROW LEVEL SECURITY;
ALTER TABLE "payment_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_attempts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "payment_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_events" FORCE ROW LEVEL SECURITY;
ALTER TABLE "payment_callback_inbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_callback_inbox" FORCE ROW LEVEL SECURITY;
ALTER TABLE "payment_cases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_cases" FORCE ROW LEVEL SECURITY;
ALTER TABLE "payment_provider_queries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_provider_queries" FORCE ROW LEVEL SECURITY;
ALTER TABLE "payment_provider_transactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_provider_transactions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "payment_outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_outbox" FORCE ROW LEVEL SECURITY;

CREATE POLICY payment_settings_isolation ON payment_settings
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY payment_callback_routes_isolation ON payment_callback_routes
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY payment_requests_isolation ON payment_requests
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY payment_attempts_isolation ON payment_attempts
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY payment_events_read ON payment_events FOR SELECT
  USING (tenant_id = app.current_tenant_id());
CREATE POLICY payment_events_insert ON payment_events FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY payment_callback_inbox_isolation ON payment_callback_inbox
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY payment_cases_isolation ON payment_cases
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY payment_provider_queries_isolation ON payment_provider_queries
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY payment_provider_transactions_read ON payment_provider_transactions FOR SELECT
  USING (tenant_id = app.current_tenant_id());
CREATE POLICY payment_provider_transactions_insert ON payment_provider_transactions FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY payment_outbox_isolation ON payment_outbox
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

-- Cross-company discovery without a company context (ARCHITECTURE §4.5). Two SECURITY DEFINER
-- functions, owned by the schema owner, return identifiers only: which company a callback token
-- belongs to, and which outbox rows and stuck attempts are due. They read through SELECT policies
-- granted to the schema owner role alone; pmb_app gains no cross-company row access, and every
-- piece of work then runs in a transaction scoped to its own company.
DO $$
BEGIN
  EXECUTE format('CREATE POLICY payment_callback_routes_resolver ON payment_callback_routes '
    'FOR SELECT TO %I USING (true)', current_user);
  EXECUTE format('CREATE POLICY payment_outbox_dispatch ON payment_outbox '
    'FOR SELECT TO %I USING (true)', current_user);
  EXECUTE format('CREATE POLICY payment_attempts_watchdog ON payment_attempts '
    'FOR SELECT TO %I USING (true)', current_user);
END
$$;

CREATE FUNCTION app.payment_callback_route(digest text)
  RETURNS TABLE (tenant_id uuid, route_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
  AS $$
    SELECT r.tenant_id, r.id FROM payment_callback_routes r
    WHERE r.token_digest = digest AND (r.status = 'active' OR r.accept_until > now())
  $$;

CREATE FUNCTION app.payment_due_work(batch integer)
  RETURNS TABLE (tenant_id uuid, work text, ref_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
  AS $$
    (SELECT o.tenant_id, 'outbox'::text, o.id FROM payment_outbox o
      WHERE o.processed_at IS NULL AND o.dead_at IS NULL AND o.available_at <= now()
        AND (o.dispatched_at IS NULL OR o.dispatched_at < now() - interval '2 minutes')
      ORDER BY o.available_at LIMIT LEAST(GREATEST(batch, 1), 500))
    UNION ALL
    (SELECT a.tenant_id, 'watchdog'::text, a.id FROM payment_attempts a
      WHERE (a.status = 'submitting' AND a.lease_expires_at < now())
         OR (a.status = 'pending' AND a.result_due_at < now())
      ORDER BY a.updated_at LIMIT LEAST(GREATEST(batch, 1), 500))
  $$;

-- Runtime role: history, receipts and the timeline are insert-only; nothing payment-related is
-- deleted. No TRUNCATE, REFERENCES or TRIGGER on any new table.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmb_app') THEN
    REVOKE UPDATE ON "payment_events", "payment_provider_transactions" FROM pmb_app;
    REVOKE DELETE ON "payment_settings", "payment_callback_routes", "payment_requests",
      "payment_attempts", "payment_events", "payment_callback_inbox", "payment_cases",
      "payment_provider_queries", "payment_provider_transactions", "payment_outbox" FROM pmb_app;
    REVOKE TRUNCATE, REFERENCES, TRIGGER ON "payment_settings", "payment_callback_routes",
      "payment_requests", "payment_attempts", "payment_events", "payment_callback_inbox",
      "payment_cases", "payment_provider_queries", "payment_provider_transactions",
      "payment_outbox" FROM pmb_app;
    GRANT EXECUTE ON FUNCTION app.payment_callback_route(text) TO pmb_app;
    GRANT EXECUTE ON FUNCTION app.payment_due_work(integer) TO pmb_app;
  END IF;
END
$$;
REVOKE EXECUTE ON FUNCTION app.payment_callback_route(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.payment_due_work(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_payment_settings() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_payment_callback_route() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_payment_request() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_payment_attempt() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.sync_payment_request_status() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_payment_callback() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_payment_case() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_provider_query() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_payment_outbox() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.stamp_recorded_at() FROM PUBLIC;

COMMIT;
