-- D7.2 supplier portal (ARCHITECTURE §4.12, ERD, WORKFLOWS "Supplier invoices through the portal",
-- brief §3, §5.3 and §15 B/C/D/F). Enforces, in the database as well as the API:
-- * A SUPPLIER USER IS BOUND TO EXACTLY ONE SUPPLIER: supplier_portal_users moves invited →
--   active (only by the invited person accepting, as a member with the `supplier` system role and
--   no project assignment) → revoked (by staff with a reason, or automatically when the membership
--   is removed or changes role); one active binding per user and company; never deleted.
-- * A SUPPLIER MEMBER SEES ONLY ITS OWN SUPPLIER'S PROCUREMENT ROWS: restrictive RLS policies on
--   suppliers, contacts, payout versions, prices, conversions, RFQ invitations, quotations, LPOs,
--   GRNs, invoices, matches, payables, settlements and documents. Members with any other role are
--   unaffected (tenant isolation as before); a `supplier`-role member without an active binding
--   sees none of them.
-- * A SUPPLIER NEVER APPROVES, SETTLES, EXCEPTS, REOPENS OR EDITS AFTER SUBMISSION: its writes to
--   supplier_invoices are limited to creating its own draft and submitting it (matched or disputed
--   by the match in the same transaction); LPOs, GRNs, payables and settlements refuse it; a
--   supplier-submitted invoice is never reopened by staff (cancel it and ask for a new one).
-- * Submissions (idempotency key + request digest) and LPO acknowledgements are append-only and
--   database-stamped; a supplier portal user is never given a project assignment.
-- Every new table has tenant_id, forced RLS with WITH CHECK and composite (tenant_id, …) foreign
-- keys (including the supplier, so a submission or acknowledgement can only name a portal user,
-- invoice or LPO of the same supplier); pmb_app holds no DELETE on them and no UPDATE on the
-- append-only ones. No permission was added (portal.supplier and the supplier role exist).
BEGIN;

-- AlterTable
ALTER TABLE "procurement_documents" ADD COLUMN     "uploaded_by_supplier" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "supplier_portal_users" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "invitation_id" UUID NOT NULL,
    "identifier" VARCHAR(254) NOT NULL,
    "contact_name" VARCHAR(100) NOT NULL,
    "user_id" UUID,
    "status" VARCHAR(10) NOT NULL DEFAULT 'invited',
    "version" INTEGER NOT NULL DEFAULT 1,
    "invited_by" UUID NOT NULL,
    "invited_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activated_at" TIMESTAMPTZ,
    "revoked_by" UUID,
    "revoked_at" TIMESTAMPTZ,
    "revoke_cause" VARCHAR(20),
    "revoke_reason" VARCHAR(500),

    CONSTRAINT "supplier_portal_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_invoice_submissions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "portal_user_id" UUID NOT NULL,
    "submitted_by" UUID NOT NULL,
    "idempotency_key" VARCHAR(100) NOT NULL,
    "request_digest" CHAR(64) NOT NULL,
    "submitted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_invoice_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lpo_acknowledgements" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "lpo_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "portal_user_id" UUID NOT NULL,
    "acknowledged_by" UUID NOT NULL,
    "acknowledged_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lpo_acknowledgements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "supplier_portal_users_tenant_id_supplier_id_idx" ON "supplier_portal_users"("tenant_id", "supplier_id");

-- CreateIndex
CREATE INDEX "supplier_portal_users_tenant_id_user_id_idx" ON "supplier_portal_users"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_portal_users_tenant_id_id_key" ON "supplier_portal_users"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_portal_users_tenant_id_supplier_id_id_key" ON "supplier_portal_users"("tenant_id", "supplier_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_portal_users_tenant_id_invitation_id_key" ON "supplier_portal_users"("tenant_id", "invitation_id");

-- CreateIndex
CREATE INDEX "supplier_invoice_submissions_tenant_id_supplier_id_portal_u_idx" ON "supplier_invoice_submissions"("tenant_id", "supplier_id", "portal_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_invoice_submissions_tenant_id_id_key" ON "supplier_invoice_submissions"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_invoice_submissions_tenant_id_invoice_id_key" ON "supplier_invoice_submissions"("tenant_id", "invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_invoice_submissions_tenant_id_idempotency_key_key" ON "supplier_invoice_submissions"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "lpo_acknowledgements_tenant_id_supplier_id_portal_user_id_idx" ON "lpo_acknowledgements"("tenant_id", "supplier_id", "portal_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "lpo_acknowledgements_tenant_id_id_key" ON "lpo_acknowledgements"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "lpo_acknowledgements_tenant_id_lpo_id_key" ON "lpo_acknowledgements"("tenant_id", "lpo_id");

-- CreateIndex
CREATE UNIQUE INDEX "lpos_tenant_id_supplier_id_id_key" ON "lpos"("tenant_id", "supplier_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_invoices_tenant_id_supplier_id_id_key" ON "supplier_invoices"("tenant_id", "supplier_id", "id");

-- AddForeignKey
ALTER TABLE "supplier_portal_users" ADD CONSTRAINT "supplier_portal_users_tenant_id_supplier_id_fkey" FOREIGN KEY ("tenant_id", "supplier_id") REFERENCES "suppliers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_portal_users" ADD CONSTRAINT "supplier_portal_users_tenant_id_invitation_id_fkey" FOREIGN KEY ("tenant_id", "invitation_id") REFERENCES "invitations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_invoice_submissions" ADD CONSTRAINT "supplier_invoice_submissions_tenant_id_supplier_id_invoice_fkey" FOREIGN KEY ("tenant_id", "supplier_id", "invoice_id") REFERENCES "supplier_invoices"("tenant_id", "supplier_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_invoice_submissions" ADD CONSTRAINT "supplier_invoice_submissions_tenant_id_supplier_id_portal__fkey" FOREIGN KEY ("tenant_id", "supplier_id", "portal_user_id") REFERENCES "supplier_portal_users"("tenant_id", "supplier_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lpo_acknowledgements" ADD CONSTRAINT "lpo_acknowledgements_tenant_id_supplier_id_lpo_id_fkey" FOREIGN KEY ("tenant_id", "supplier_id", "lpo_id") REFERENCES "lpos"("tenant_id", "supplier_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lpo_acknowledgements" ADD CONSTRAINT "lpo_acknowledgements_tenant_id_supplier_id_portal_user_id_fkey" FOREIGN KEY ("tenant_id", "supplier_id", "portal_user_id") REFERENCES "supplier_portal_users"("tenant_id", "supplier_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Supplier portal users ------------------------------------------------------------------------
ALTER TABLE "supplier_portal_users" ADD CONSTRAINT "supplier_portal_users_state_check" CHECK (
  version >= 1
  AND status IN ('invited', 'active', 'revoked')
  AND char_length(btrim(contact_name)) BETWEEN 2 AND 100
  AND char_length(identifier) BETWEEN 3 AND 254 AND identifier = lower(btrim(identifier))
  AND COALESCE(CASE status
    WHEN 'invited' THEN user_id IS NULL AND activated_at IS NULL AND revoked_at IS NULL
      AND revoked_by IS NULL AND revoke_cause IS NULL AND revoke_reason IS NULL
    WHEN 'active' THEN user_id IS NOT NULL AND activated_at IS NOT NULL AND revoked_at IS NULL
      AND revoked_by IS NULL AND revoke_cause IS NULL AND revoke_reason IS NULL
    ELSE revoked_at IS NOT NULL AND (user_id IS NULL) = (activated_at IS NULL)
      AND COALESCE(CASE revoke_cause
        WHEN 'revoked' THEN revoked_by IS NOT NULL
          AND COALESCE(char_length(btrim(revoke_reason)), 0) >= 3
        WHEN 'membership_ended' THEN user_id IS NOT NULL AND revoke_reason IS NULL
        WHEN 'superseded' THEN user_id IS NULL AND revoked_by IS NOT NULL
          AND revoke_reason IS NULL
      END, false)
  END, false)
);
-- One supplier per user and company; one open invitation or access per supplier and identifier.
CREATE UNIQUE INDEX "supplier_portal_users_one_supplier_per_user" ON "supplier_portal_users"
  ("tenant_id", "user_id") WHERE status = 'active';
CREATE UNIQUE INDEX "supplier_portal_users_one_open_per_identifier" ON "supplier_portal_users"
  ("tenant_id", "supplier_id", "identifier") WHERE status IN ('invited', 'active');

-- Whether the signed-in user is a member of `target_tenant` with the supplier system role.
CREATE FUNCTION app.is_supplier_member(target_tenant uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM memberships m
     WHERE m.tenant_id = target_tenant AND m.user_id = app.current_user_id() AND m.role = 'supplier'
  )
$$;

-- invited → active (the invited person, after accepting, as a supplier-role member with no
-- project assignment) → revoked (staff with a reason; or membership_ended once the membership is
-- gone or changed role). Identity columns never change; timestamps come from the database clock.
CREATE FUNCTION app.guard_supplier_portal_user() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Supplier portal access is revoked, never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'invited' OR NEW.version <> 1 THEN
      RAISE EXCEPTION 'Supplier portal access starts as an invitation' USING ERRCODE = '23514';
    END IF;
    IF NEW.invited_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'A supplier contact is invited by the signed-in user' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM invitations i
       WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.invitation_id AND i.role = 'supplier'
         AND i.custom_role_id IS NULL AND i.accepted_at IS NULL AND i.identifier = NEW.identifier
         AND NOT EXISTS (SELECT 1 FROM invitation_projects p
                          WHERE p.tenant_id = i.tenant_id AND p.invitation_id = i.id)
    ) THEN
      RAISE EXCEPTION 'A supplier contact is invited with the supplier role and no project'
        USING ERRCODE = '23514';
    END IF;
    NEW.invited_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
     OR NEW.invitation_id IS DISTINCT FROM OLD.invitation_id
     OR NEW.identifier IS DISTINCT FROM OLD.identifier
     OR NEW.contact_name IS DISTINCT FROM OLD.contact_name
     OR NEW.invited_by IS DISTINCT FROM OLD.invited_by
     OR NEW.invited_at IS DISTINCT FROM OLD.invited_at THEN
    RAISE EXCEPTION 'Supplier portal access keeps its supplier, invitation and contact'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'revoked' THEN
    RAISE EXCEPTION 'Revoked supplier portal access never changes; invite again'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
    RAISE EXCEPTION 'A change to supplier portal access takes the next version'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'invited' AND NEW.status = 'active' THEN
    IF NEW.user_id IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'Supplier portal access is activated by the invited person'
        USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM invitations
                    WHERE tenant_id = NEW.tenant_id AND id = NEW.invitation_id
                      AND accepted_at IS NOT NULL) THEN
      RAISE EXCEPTION 'Supplier portal access is activated by accepting its invitation'
        USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM memberships
                    WHERE tenant_id = NEW.tenant_id AND user_id = NEW.user_id
                      AND role = 'supplier') THEN
      RAISE EXCEPTION 'Supplier portal access belongs to a member with the supplier role'
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM project_memberships
                WHERE tenant_id = NEW.tenant_id AND user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'A supplier portal user has no project assignment' USING ERRCODE = '23514';
    END IF;
    NEW.activated_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF NEW.status = 'revoked' THEN
    IF NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.activated_at IS DISTINCT FROM OLD.activated_at THEN
      RAISE EXCEPTION 'Revoking keeps the account it was bound to' USING ERRCODE = '23514';
    END IF;
    IF NEW.revoke_cause = 'revoked' AND NEW.revoked_by IS DISTINCT FROM app.current_user_id() THEN
      RAISE EXCEPTION 'Supplier portal access is revoked by the signed-in user'
        USING ERRCODE = '23514';
    END IF;
    -- A new invitation replaces a pending or expired one (D-101): only an invitation nobody
    -- accepted, by the signed-in user sending the new one.
    IF NEW.revoke_cause = 'superseded' THEN
      IF OLD.status <> 'invited' OR NEW.revoked_by IS DISTINCT FROM app.current_user_id()
         OR EXISTS (SELECT 1 FROM invitations
                     WHERE tenant_id = NEW.tenant_id AND id = NEW.invitation_id
                       AND accepted_at IS NOT NULL) THEN
        RAISE EXCEPTION 'Only an invitation nobody accepted is replaced by a new one'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NEW.revoke_cause = 'membership_ended' THEN
      IF EXISTS (SELECT 1 FROM memberships
                  WHERE tenant_id = NEW.tenant_id AND user_id = NEW.user_id
                    AND role = 'supplier') THEN
        RAISE EXCEPTION 'Access ends with the membership only once the membership has ended'
          USING ERRCODE = '23514';
      END IF;
      NEW.revoked_by := app.current_user_id();
    END IF;
    NEW.revoked_at := clock_timestamp();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Supplier portal access cannot change from % to %', OLD.status, NEW.status
    USING ERRCODE = '23514';
END
$$;
CREATE TRIGGER supplier_portal_user_guard BEFORE INSERT OR UPDATE OR DELETE
  ON "supplier_portal_users" FOR EACH ROW EXECUTE FUNCTION app.guard_supplier_portal_user();

-- Stale access ends with the membership: removing a supplier-role member or changing their role
-- revokes their active binding in the same transaction.
CREATE FUNCTION app.end_supplier_portal_access() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.role = 'supplier' AND OLD.role = 'supplier' THEN
    RETURN NULL;
  END IF;
  UPDATE supplier_portal_users
     SET status = 'revoked', revoke_cause = 'membership_ended', version = version + 1
   WHERE tenant_id = OLD.tenant_id AND user_id = OLD.user_id AND status = 'active';
  RETURN NULL;
END
$$;
CREATE TRIGGER membership_supplier_portal_end AFTER UPDATE OF role OR DELETE ON "memberships"
  FOR EACH ROW EXECUTE FUNCTION app.end_supplier_portal_access();

-- A supplier portal user is scoped by its supplier, never by a project assignment.
CREATE FUNCTION app.guard_supplier_portal_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM supplier_portal_users
              WHERE tenant_id = NEW.tenant_id AND user_id = NEW.user_id AND status = 'active') THEN
    RAISE EXCEPTION 'A supplier portal user is scoped by their supplier, never by a project'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER project_membership_supplier_portal_guard BEFORE INSERT OR UPDATE
  ON "project_memberships" FOR EACH ROW EXECUTE FUNCTION app.guard_supplier_portal_assignment();

-- Submissions and acknowledgements -------------------------------------------------------------
ALTER TABLE "supplier_invoice_submissions" ADD CONSTRAINT "supplier_invoice_submissions_check"
  CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,100}$' AND request_digest ~ '^[0-9a-f]{64}$');

-- A submission is the supplier's own new invoice, written by an active portal user of the same
-- supplier who is signed in, in the transaction that creates the invoice; never changed.
CREATE FUNCTION app.guard_supplier_invoice_submission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  portal record;
  inv record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'An invoice submission never changes' USING ERRCODE = '23514';
  END IF;
  SELECT status, user_id INTO portal FROM supplier_portal_users
   WHERE tenant_id = NEW.tenant_id AND id = NEW.portal_user_id;
  IF portal.status IS DISTINCT FROM 'active' OR portal.user_id IS DISTINCT FROM app.current_user_id()
     OR NEW.submitted_by IS DISTINCT FROM portal.user_id THEN
    RAISE EXCEPTION 'An invoice is submitted by an active portal user of its supplier, signed in'
      USING ERRCODE = '23514';
  END IF;
  SELECT status, created_by INTO inv FROM supplier_invoices
   WHERE tenant_id = NEW.tenant_id AND id = NEW.invoice_id;
  IF inv.status IS DISTINCT FROM 'draft' OR inv.created_by IS DISTINCT FROM NEW.submitted_by THEN
    RAISE EXCEPTION 'A submission is the supplier''s own new invoice' USING ERRCODE = '23514';
  END IF;
  NEW.submitted_at := clock_timestamp();
  RETURN NEW;
END
$$;
CREATE TRIGGER supplier_invoice_submission_guard BEFORE INSERT OR UPDATE OR DELETE
  ON "supplier_invoice_submissions" FOR EACH ROW
  EXECUTE FUNCTION app.guard_supplier_invoice_submission();

-- An acknowledgement: an active portal user of the LPO's supplier, signed in, once per approved
-- LPO; it never changes the LPO (approval semantics are untouched).
CREATE FUNCTION app.guard_lpo_acknowledgement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  portal record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'An LPO acknowledgement never changes' USING ERRCODE = '23514';
  END IF;
  SELECT status, user_id INTO portal FROM supplier_portal_users
   WHERE tenant_id = NEW.tenant_id AND id = NEW.portal_user_id;
  IF portal.status IS DISTINCT FROM 'active' OR portal.user_id IS DISTINCT FROM app.current_user_id()
     OR NEW.acknowledged_by IS DISTINCT FROM portal.user_id THEN
    RAISE EXCEPTION 'An LPO is acknowledged by an active portal user of its supplier, signed in'
      USING ERRCODE = '23514';
  END IF;
  IF (SELECT status FROM lpos WHERE tenant_id = NEW.tenant_id AND id = NEW.lpo_id)
     IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'Only an approved LPO is acknowledged' USING ERRCODE = '23514';
  END IF;
  NEW.acknowledged_at := clock_timestamp();
  RETURN NEW;
END
$$;
CREATE TRIGGER lpo_acknowledgement_guard BEFORE INSERT OR UPDATE OR DELETE
  ON "lpo_acknowledgements" FOR EACH ROW EXECUTE FUNCTION app.guard_lpo_acknowledgement();

-- What a supplier may write ----------------------------------------------------------------------
-- A supplier member creates its own draft invoices for its own supplier and submits them through
-- the portal (draft → submitted → matched/disputed by the match in the same transaction); nothing
-- else. Whoever writes: a supplier-submitted invoice is never reopened (a correction is a new
-- invoice from the supplier after the company cancels this one with a reason).
CREATE FUNCTION app.guard_supplier_portal_invoice() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  submitted boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    submitted := EXISTS (SELECT 1 FROM supplier_invoice_submissions
                          WHERE tenant_id = NEW.tenant_id AND invoice_id = NEW.id);
    IF submitted AND NEW.status = 'draft' AND OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'A supplier-submitted invoice is never reopened; cancel it and ask the supplier for a new one'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NOT app.is_supplier_member(NEW.tenant_id) THEN
    RETURN NEW;
  END IF;
  IF NEW.created_by IS DISTINCT FROM app.current_user_id()
     OR NOT EXISTS (SELECT 1 FROM supplier_portal_users
                     WHERE tenant_id = NEW.tenant_id AND user_id = app.current_user_id()
                       AND status = 'active' AND supplier_id = NEW.supplier_id) THEN
    RAISE EXCEPTION 'A supplier writes only its own invoices, for the supplier it is bound to'
      USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' AND NOT (
       (OLD.status = 'draft' AND NEW.status = 'draft')
       OR (OLD.status = 'draft' AND NEW.status = 'submitted' AND submitted)
       OR (OLD.status = 'submitted' AND NEW.status IN ('matched', 'disputed'))
     ) THEN
    RAISE EXCEPTION 'A supplier never approves, settles, reopens, cancels or edits a submitted invoice'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER supplier_invoice_portal_guard BEFORE INSERT OR UPDATE ON "supplier_invoices"
  FOR EACH ROW EXECUTE FUNCTION app.guard_supplier_portal_invoice();

-- A supplier member records the match of its own invoice while submitting it, and never approves
-- an exception.
CREATE FUNCTION app.guard_supplier_portal_match() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT app.is_supplier_member(NEW.tenant_id) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' OR NOT EXISTS (
    SELECT 1 FROM supplier_invoices
     WHERE tenant_id = NEW.tenant_id AND id = NEW.invoice_id AND status = 'submitted'
       AND created_by = app.current_user_id()
  ) THEN
    RAISE EXCEPTION 'A supplier never runs or overrides the company''s three-way match'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER three_way_match_portal_guard BEFORE INSERT OR UPDATE ON "three_way_matches"
  FOR EACH ROW EXECUTE FUNCTION app.guard_supplier_portal_match();

-- Who uploaded a procurement document is stamped by the database, never sent by the API: a
-- supplier member's upload is the supplier's (its own limit and label), anyone else's is staff's.
-- Documents are append-only (no UPDATE for pmb_app), so the stamp never changes. An invoice keeps
-- at most 3 documents from the supplier, counted across all its portal users under a lock on the
-- invoice, so parallel uploads cannot pass the limit together (SUPPLIER_PORTAL_LIMITS).
CREATE FUNCTION app.stamp_procurement_document_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  uploaded integer;
BEGIN
  NEW.uploaded_by_supplier := app.is_supplier_member(NEW.tenant_id);
  IF NEW.uploaded_by_supplier THEN
    PERFORM 1 FROM supplier_invoices
      WHERE tenant_id = NEW.tenant_id AND id = NEW.invoice_id FOR UPDATE;
    SELECT count(*) INTO uploaded FROM procurement_documents
     WHERE tenant_id = NEW.tenant_id AND invoice_id = NEW.invoice_id AND uploaded_by_supplier;
    IF uploaded >= 3 THEN
      RAISE EXCEPTION 'An invoice keeps at most 3 documents from the supplier'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER procurement_document_source BEFORE INSERT ON "procurement_documents"
  FOR EACH ROW EXECUTE FUNCTION app.stamp_procurement_document_source();

-- Orders, deliveries, approvals (payables) and payments (settlements) are the company's.
CREATE FUNCTION app.refuse_supplier_member_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.is_supplier_member(COALESCE(NEW.tenant_id, OLD.tenant_id)) THEN
    RAISE EXCEPTION 'A supplier never changes % rows', TG_TABLE_NAME USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;
DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['lpos', 'grns', 'invoice_payables', 'invoice_settlements']
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW '
      'EXECUTE FUNCTION app.refuse_supplier_member_write()', target || '_supplier_portal_guard',
      target);
  END LOOP;
END
$$;

-- Row-level security ---------------------------------------------------------------------------
DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['supplier_portal_users', 'supplier_invoice_submissions',
    'lpo_acknowledgements']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = app.current_tenant_id()) '
      'WITH CHECK (tenant_id = app.current_tenant_id())', target || '_isolation', target);
  END LOOP;
END
$$;

-- Restrictive policies (added to tenant isolation): a member with the supplier system role reads
-- and writes only rows of the supplier it is actively bound to; anyone else is unaffected. The
-- subqueries do not depend on the row, so PostgreSQL evaluates them once per statement.
DO $$
DECLARE
  not_supplier constant text := 'NOT EXISTS (SELECT 1 FROM memberships m '
    'WHERE m.tenant_id = app.current_tenant_id() AND m.user_id = app.current_user_id() '
    'AND m.role = ''supplier'')';
  own constant text := 'SELECT s.supplier_id FROM supplier_portal_users s '
    'WHERE s.tenant_id = app.current_tenant_id() AND s.user_id = app.current_user_id() '
    'AND s.status = ''active''';
  rule record;
BEGIN
  FOR rule IN SELECT * FROM (VALUES
    ('suppliers', 'id IN (' || own || ')'),
    ('supplier_contacts', 'supplier_id IN (' || own || ')'),
    ('supplier_phone_changes', 'supplier_id IN (' || own || ')'),
    ('supplier_payout_versions', 'supplier_id IN (' || own || ')'),
    ('material_prices', 'supplier_id IN (' || own || ')'),
    ('unit_conversions', 'supplier_id IS NULL OR supplier_id IN (' || own || ')'),
    ('rfq_suppliers', 'supplier_id IN (' || own || ')'),
    ('quotations', 'supplier_id IN (' || own || ')'),
    ('quotation_lines', 'quotation_id IN (SELECT q.id FROM quotations q)'),
    ('lpos', 'supplier_id IN (' || own || ')'),
    ('lpo_lines', 'lpo_id IN (SELECT l.id FROM lpos l)'),
    ('grns', 'lpo_id IN (SELECT l.id FROM lpos l)'),
    ('grn_lines', 'lpo_id IN (SELECT l.id FROM lpos l)'),
    ('supplier_invoices', 'supplier_id IN (' || own || ')'),
    ('supplier_invoice_lines', 'invoice_id IN (SELECT i.id FROM supplier_invoices i)'),
    ('three_way_matches', 'invoice_id IN (SELECT i.id FROM supplier_invoices i)'),
    ('invoice_payables', 'invoice_id IN (SELECT i.id FROM supplier_invoices i)'),
    ('invoice_settlements', 'invoice_id IN (SELECT i.id FROM supplier_invoices i)'),
    ('procurement_documents', 'invoice_id IN (SELECT i.id FROM supplier_invoices i)'),
    ('supplier_invoice_submissions', 'supplier_id IN (' || own || ')'),
    ('lpo_acknowledgements', 'supplier_id IN (' || own || ')'),
    ('supplier_portal_users', 'user_id = app.current_user_id() OR (status = ''invited'' '
      'AND identifier = (SELECT u.identifier FROM users u WHERE u.id = app.current_user_id() '
      'AND u.verified_at IS NOT NULL))')
  ) AS rules(target, scope)
  LOOP
    EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE USING (%s OR (%s)) '
      'WITH CHECK (%s OR (%s))', rule.target || '_supplier_portal', rule.target, not_supplier,
      rule.scope, not_supplier, rule.scope);
  END LOOP;
END
$$;

-- The company's other rows that name or concern suppliers (requisitions and RFQs, the cost ledger
-- and its journals, petty-cash expenses, plant hired from a supplier) are never a supplier's: a
-- `supplier`-role member reads and writes none of them; anyone else is unaffected.
DO $$
DECLARE
  not_supplier constant text := 'NOT EXISTS (SELECT 1 FROM memberships m '
    'WHERE m.tenant_id = app.current_tenant_id() AND m.user_id = app.current_user_id() '
    'AND m.role = ''supplier'')';
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['requisitions', 'requisition_lines', 'rfqs', 'rfq_requisitions',
    'cost_entries', 'cost_journal_lines', 'petty_cash_expenses', 'plant_items']
  LOOP
    EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE USING (%s) WITH CHECK (%s)',
      target || '_supplier_portal', target, not_supplier, not_supplier);
  END LOOP;
END
$$;

-- The runtime role never deletes portal access, submissions or acknowledgements, and never
-- rewrites the append-only ones.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmb_app') THEN
    REVOKE DELETE ON "supplier_portal_users", "supplier_invoice_submissions",
      "lpo_acknowledgements" FROM pmb_app;
    REVOKE UPDATE ON "supplier_invoice_submissions", "lpo_acknowledgements" FROM pmb_app;
    REVOKE TRUNCATE, REFERENCES, TRIGGER
      ON "supplier_portal_users", "supplier_invoice_submissions", "lpo_acknowledgements"
      FROM pmb_app;
    GRANT EXECUTE ON FUNCTION app.is_supplier_member(uuid) TO pmb_app;
  END IF;
END
$$;
REVOKE EXECUTE ON FUNCTION app.is_supplier_member(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_supplier_portal_user() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.end_supplier_portal_access() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_supplier_portal_assignment() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_supplier_invoice_submission() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_lpo_acknowledgement() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_supplier_portal_invoice() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_supplier_portal_match() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.stamp_procurement_document_source() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.refuse_supplier_member_write() FROM PUBLIC;

COMMIT;
