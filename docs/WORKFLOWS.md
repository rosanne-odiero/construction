# PM-Buddy: Workflow contracts

Design requirements, not implemented payment/procurement APIs. See [brief §15](./PROJECT_BRIEF.md#15-mandatory-safeguards-pm-buddy-additions) and [acceptance matrix](./ACCEPTANCE_MATRIX.md).

## Shared transition rules

Every command resolves tenant/project membership on the server, checks permission and expected record version, and commits state, redacted audit event and outbox event atomically. Retried commands with the same tenant/operation/idempotency key and payload return the original result; a changed payload conflicts. Competing commands must not both consume the same version or outstanding balance.

Approvals bind an immutable snapshot of recipients, amounts, allocations and effective rules. Preparers cannot review/approve their own submission. Material edits before final approval create a new version and invalidate approvals. Approved financial records are immutable; subsequent corrections are separately approved linked records.

The tables below inherit these scope, audit and retry requirements. A failed precondition returns an explicit conflict/forbidden response without side effects.

## Site diary (D6.1 online foundation)

Implemented locally for the web diary, not the offline site app. The API resolves
tenant/project permission and version for each command; state and a safe-summary
audit event commit together. There are no attachment or external-notification effects
in this increment. Retries conflict on site/day uniqueness or a consumed version;
offline event identity/replay and outbox integration remain future work.

| Transition | Actor / preconditions | Effect / audit |
|---|---|---|
| new → draft | `site.diary`; site belongs to project; day is not future in Nairobi; site/day unused | Version 1; `diary.created`; manual or unknown workforce |
| draft → draft | Original author + `site.diary`; expected version | Replace draft content; `diary.updated` |
| draft → submitted | Original author + `site.diary`; expected version | Freeze content pending review; `diary.submitted` |
| submitted → rejected | Independent `quality.manage` reviewer; expected version; reason 3–500 characters | Store reviewer/time/reason; `diary.rejected` |
| rejected → draft | Original author + `site.diary`; expected version | Clear current sign-off; retain audited transition history; `diary.reopened` |
| submitted → approved | Independent `quality.manage` reviewer; expected version | Store reviewer/time; lock record permanently; `diary.approved` |

Approved diaries have no edit/reopen/delete transition. Database triggers backstop the
lifecycle, author/reviewer identities and lock; RLS and composite foreign keys isolate
company/project/site references. Closed/cancelled projects allow reads but no changes.
Attendance auto-fill, verified photos and quality workflows are not supplied by this
foundation. Financial certificate approval is a separate workflow below.

## Payroll

```mermaid
stateDiagram-v2
  draft --> submitted
  submitted --> reviewed
  submitted --> rejected
  rejected --> draft
  reviewed --> approved
  reviewed --> rejected
  draft --> cancelled
  submitted --> cancelled
  reviewed --> cancelled
  approved --> disbursing
  disbursing --> partially_settled
  disbursing --> settled
  partially_settled --> settled
```

| Transition | Actor, scope and preconditions | Side effects and audit event | Retry |
|---|---|---|---|
| draft → submitted | Project payroll preparer; validated earnings, reviewed rules and funding proposal | Freeze submitted snapshot; `payroll.submitted` | Shared command rules |
| submitted → reviewed | Finance reviewer, distinct from preparer; matching snapshot | Record review; `payroll.reviewed` | Expected version |
| submitted/reviewed → rejected | Assigned reviewer/approver; reason required | No payable created; `payroll.rejected` | Expected version |
| rejected → draft | Preparer; increment version | Clear obsolete approvals; `payroll.reopened` | Expected version |
| reviewed → approved | Owner/authorised approver, distinct from preparer and reviewer; fresh MFA, limits and snapshot match | Immutable batch and authorised obligations; `payroll.approved` | Database uniqueness/version guard |
| draft/submitted/reviewed → cancelled | Authorised project manager; reason | Release provisional reservations; `payroll.cancelled` | Expected version |
| approved → disbursing | Payment worker acting for tenant; approved obligations and payout switch enabled | Reserve outstanding amounts; create attempts/outbox; `payroll.disbursing` | Unique attempt/reservation rules |
| disbursing → partially_settled/settled; partially_settled → settled | Settlement processor; derive from confirmed allocations across obligations, not independent flags | Record derived state; `payroll.settlement_updated` | Duplicate allocation prevented |

Failed lines remain outstanding, not automatically resubmittable if any attempt is uncertain. Closed-period attendance routes to an adjustment run referencing the original batch; never mutate settled payroll.

## Payment attempts

```mermaid
stateDiagram-v2
  created --> queued
  queued --> submitting
  submitting --> pending
  submitting --> unknown
  submitting --> failed
  pending --> unknown
  pending --> confirmed
  pending --> failed
  unknown --> confirmed
  unknown --> failed
  confirmed --> reversal_pending
  reversal_pending --> reversed
  reversal_pending --> confirmed
```

| Transition | Actor, scope and preconditions | Side effects and audit event | Retry |
|---|---|---|---|
| created → queued | Tenant payment service; authorised obligation, reservation and immutable recipient snapshot | Outbox work; `attempt.queued` | Unique key/fingerprint |
| queued → submitting | Worker; payout enabled, reservation still valid, no uncertain prior attempt | Persist call intent before external call; `attempt.submitting` | CAS ownership; never blindly repeat call |
| submitting → pending | Worker; provider accepted with expected identifiers | Save protected provider evidence; `attempt.pending` | Persist same result once |
| submitting/pending → unknown | Watchdog/worker; timeout, lost response or expired lease | Hold reservation; reconciliation case; `attempt.unknown` | No automatic resubmission |
| submitting/pending/unknown → failed | Verified definitive non-settlement result, not timeout; authorised reconciler for manual evidence review | Release reservation only when safe; `attempt.failed` | Deduplicate result |
| pending/unknown → confirmed | Durable inbox/reconciler; verified identifiers, amount, KES currency and direction | Allocation and balanced journal in transaction; `attempt.confirmed` | Unique provider receipt/allocation |
| confirmed → reversal_pending | Independent authorised approver; fresh MFA and reversal reason | Separate reversal request; `attempt.reversal_requested` | Reversal has separate idempotency key |
| reversal_pending → reversed/confirmed | Verified reversal success/definitive rejection | Compensating journal only on success; `attempt.reversed`/`attempt.reversal_rejected` | Unknown reversal remains pending review |

Late/out-of-order results never regress confirmed settlement to pending/failed. Conflicting definitive evidence opens a dispute. A callback can be processed after a timeout even if local state is still `submitting`; route through reconciliation with the same verification/atomic settlement controls. New payouts target only demonstrably unpaid outstanding obligations.

## Procurement and certification

```mermaid
stateDiagram-v2
  state Requisition {
    [*] --> req_draft
    req_draft --> req_submitted
    req_submitted --> req_approved
    req_submitted --> req_rejected
    req_rejected --> req_draft
    req_approved --> req_ordered
    req_draft --> req_cancelled
    req_submitted --> req_cancelled
  }
  state Invoice {
    [*] --> inv_draft
    inv_draft --> inv_submitted
    inv_submitted --> inv_matched
    inv_submitted --> inv_disputed
    inv_disputed --> inv_submitted
    inv_matched --> inv_approved
    inv_approved --> inv_partly_settled
    inv_approved --> inv_settled
    inv_partly_settled --> inv_settled
  }
  state Variation {
    [*] --> vo_draft
    vo_draft --> vo_submitted
    vo_submitted --> vo_approved
    vo_submitted --> vo_rejected
    vo_rejected --> vo_draft
    vo_draft --> vo_cancelled
    vo_submitted --> vo_draft : rebase when stale
  }
  state Certificate {
    [*] --> cert_draft
    cert_draft --> cert_submitted
    cert_submitted --> cert_reviewed
    cert_submitted --> cert_rejected
    cert_rejected --> cert_draft
    cert_reviewed --> cert_issued
    cert_issued --> cert_partly_settled
    cert_issued --> cert_settled
    cert_partly_settled --> cert_settled
  }
```

| Workflow / transition | Actor, scope and preconditions | Side effects and audit event | Retry |
|---|---|---|---|
| Requisition draft → submitted | Site requester; item/unit/version valid | `requisition.submitted` | Expected version |
| submitted → approved/rejected | Independent project approver; budget/limits or reason | Reserve commitment proposal or record rejection; `requisition.approved/rejected` | Expected version |
| rejected → draft | Requester; new version | Clear approval; `requisition.reopened` | Expected version |
| approved → ordered | Procurement; quote policy and LPO approved | Link LPO and committed cost; `requisition.ordered` | Unique conversion to order |
| draft/submitted → cancelled | Requester/manager; no issued LPO | `requisition.cancelled` | Expected version |
| Invoice draft → submitted | Finance clerk; source invoice and supplier identity verified | `invoice.submitted` | Duplicate supplier reference prevented |
| submitted → matched/disputed | Matching service/reviewer; LPO/GRN tolerance, eTIMS review, approved service exceptions | Matching evidence or dispute; `invoice.matched/disputed` | Expected version |
| disputed → submitted | Clerk; corrected draft version and evidence | Invalidate old match; `invoice.resubmitted` | Expected version |
| matched → approved | Independent Finance approver; limits, snapshot, review complete | Accrue cost and obligation once; `invoice.approved` | Unique accrual source |
| approved → partly_settled/settled; partly_settled → settled | Verified allocation processor | Derived cash/settlement state; `invoice.settlement_updated` | Allocation uniqueness |
| Variation draft → submitted | QS; instruction and BQ baseline/version attached | Freeze proposal; `variation.submitted` | Expected version |
| submitted → approved/rejected | Independent contract-authorised approver; reason/limits | New BQ version only on approval; `variation.approved/rejected` | Unique approved variation version |
| rejected → draft; draft → cancelled | QS; new version or cancellation reason | `variation.reopened/cancelled` | Expected version |
| draft/submitted/rejected → draft (rebase) | QS; base is no longer the newest approved BQ version | Re-point proposal and lines to the newest version, reprice, clear the snapshot; `variation.rebased` | Expected version |
| Certificate draft → submitted | QS; measured work and materials reconciled | Snapshot valuation; `certificate.submitted` | Expected version |
| submitted → reviewed/rejected | Independent reviewer; retention, advance recovery and prior certificates checked | `certificate.reviewed/rejected` | Expected version |
| rejected → draft | QS; new version | Clear approvals; `certificate.reopened` | Expected version |
| reviewed → issued | Contract-authorised issuer; snapshot unchanged | Immutable certificate/receivable; `certificate.issued` | Unique issued version |
| issued → partly_settled/settled; partly_settled → settled | Verified receipts allocation processor | Derived settlement state; `certificate.settlement_updated` | Allocation uniqueness |

Approved invoices, issued LPOs and certificates use linked credits, cancellations or amendments with fresh approval rather than deletion. Detailed cancellation/return policies require QS/accounting review before their implementation.

### Variation as implemented (D2.3)

The Variation workflow is implemented ([ARCHITECTURE §4.3](./ARCHITECTURE.md#43-bq-versions-variations-and-rate-build-ups-d23)); the transition table lives in `packages/domain/src/bq/variation-lifecycle.ts` and is repeated by the `app.guard_variation_order` trigger. Additions to the contract above:

- **Rebase.** When another variation on the same base is approved, this one is stale. Approval is refused (409 `variation-stale`) until someone with `bq.edit` rebases it: from draft, submitted or rejected it returns to draft on the newest approved version, its lines move with it and are repriced, and lines that no longer apply are flagged for correction. Rebase from a non-stale variation is 409 `variation-not-stale`. Draft → draft rebase is not a status change, so only the history row and the audit event record it.
- **Snapshot binding.** Submission stores a SHA-256 digest of the proposal (instruction, base version and its total, VAT rate, every line and the totals). Approve and reject must quote that digest; the server recomputes it and refuses any mismatch with 409 `variation-stale`.
- **Who may decide.** `bq.approve_variation` on the project; approval also needs MFA verified within five minutes (403 `step-up-required`). The decider must be neither the creator nor the submitter (403 `maker-checker`), for rejection as well as approval. Rejection and cancellation need a reason (at least three characters), kept in `variation_status_changes`.
- **Approval side effect.** One transaction, serialised per BQ: the next BQ version is created from the base plus the lines, with totals and VAT recomputed at the base's snapshotted VAT rate. Approval limits by amount are not implemented yet.
- **Baseline.** Before any variation, the imported draft (BQ version 1) is approved as the contract baseline (`bq.approve_variation`, step-up, not the importer); it is then immutable.

### Procure-to-pay as implemented (D5.2)

Requisitions, RFQs, LPOs and supplier invoices are implemented ([ARCHITECTURE §4.5](./ARCHITECTURE.md#45-procure-to-pay-d52)); the transition tables live in `packages/domain/src/procurement/lifecycle.ts` and are repeated by `app.guard_requisition`, `app.guard_rfq`, `app.guard_lpo` and `app.guard_supplier_invoice`. Differences from and additions to the contract above:

- **Requisition.** `reopen` returns a submitted, rejected or approved requisition (not one on an open RFQ) to draft and clears the decision; material edits are only possible in draft. `approved → ordered` happens when its LPO is approved (`ordered → approved` again if that LPO is cancelled before anything was received or invoiced). Approve and reject need `procurement.approve` and someone who is not a contributor (creator, editor, submitter); reject and cancel need a reason. Budget and approval limits by amount are **not** implemented.
- **RFQ** (new): `open → awarded | cancelled`, `awarded → open` when its LPO is cancelled (so it can be reissued). Award needs `procurement.min_quotes` complete, valid quotations or an approved single-source exception (requested with a reason by someone with `procurement.manage_suppliers`, approved by a `procurement.approve` holder who did not contribute to the RFQ).
- **LPO** (new): `draft → submitted → approved`, `submitted → draft` (returned with a reason), `draft | submitted | approved → cancelled` (approved only while nothing was received or invoiced). Approval needs `procurement.approve`, step-up and a non-contributor; an approved LPO never changes (amend = cancel + reissue from the RFQ).
- **GRN** (new, not a state machine): `recorded → voided` with a reason, refused while an approved invoice relies on it. Recording is idempotent (client ID + `Idempotency-Key`).
- **Invoice.** `submitted → matched | disputed` happens in the submission transaction (no separate reviewer step). `matched ↔ disputed` on `rematch`; `disputed → matched` by an **exception** (independent `payments.approve`, step-up, reason; never for a missing eTIMS number, inconsistent totals, an empty invoice or a line not on the order); `disputed | matched → draft` on `reopen` for a corrected version (a new content version; the old match no longer counts). `matched → approved` by an independent `payments.approve` holder with step-up, only while the current match passes and is not stale, binding the match, the content version and the supplier's verified payout version. `approved → partly_settled → settled` follow recorded settlements (`payments.disburse`, step-up, not the approver, amount ≤ outstanding, idempotent). A payee change after approval stops settlement until the invoice is approved again (`approved | partly_settled` re-approval creates a new payable). Anything not yet approved can be cancelled with a reason (e.g. after a credit note); approved invoices are not cancelled in D5.2.
- **Audit events:** `requisition.created/updated/submitted/approved/rejected/reopened/cancelled`, `rfq.created/updated/exception_requested/exception_approved/awarded/cancelled`, `quotation.recorded/withdrawn`, `lpo.created/updated/…` (one per transition), `grn.recorded/voided`, `invoice.recorded/updated/submitted/matched/disputed/match_excepted/approved/reapproved/reopened/cancelled`, `invoice.settlement_recorded`, `procurement.document_added`; metadata carries IDs, statuses, field names and match reason codes, never amounts or free text.

## Stores (D5.3)

Implemented in D5.3 ([ARCHITECTURE §4.6](./ARCHITECTURE.md#46-stores-d53)). The transition tables live in `packages/domain/src/stores/lifecycle.ts` and are repeated by `app.guard_stock_transfer` and `app.guard_stock_take`; stock itself only changes through ledger entries (`app.post_stock_entry`), never by editing a balance.

```mermaid
stateDiagram-v2
  state Transfer {
    [*] --> trf_dispatched : dispatch (stock leaves the source store)
    trf_dispatched --> trf_received : receive, every line as sent
    trf_dispatched --> trf_disputed : receive, a line differs (reason per line)
    trf_disputed --> trf_resolved : resolve (note; not the sender or receiver)
    trf_dispatched --> trf_cancelled : cancel (reason; dispatch reversed)
  }
  state StockTake {
    [*] --> stk_draft : start (system quantities snapshotted)
    stk_draft --> stk_draft : record counts
    stk_draft --> stk_submitted : submit (every line counted)
    stk_submitted --> stk_approved : approve (not a contributor; variances posted)
    stk_submitted --> stk_draft : return for recount (reason)
    stk_draft --> stk_cancelled : cancel (reason)
    stk_submitted --> stk_cancelled : cancel (reason)
  }
```

| Workflow / transition | Actor, scope and preconditions | Side effects and audit event | Retry |
|---|---|---|---|
| Issue / return / wastage recorded | `stores.manage` on the store's project; an issue names an approved-BQ item (lineage) and/or a project gang; a return names a posted issue and ≤ what is outstanding per line; wastage has a reason and a note; never more than on hand | Ledger entries at the average cost (returns at the issue's cost); `stock.issued`, `stock.returned`, `stock.wasted` | Client ID + `Idempotency-Key` (replay returns the original) |
| Movement posted → reversed | `stores.manage`; reason; an issue only after its returns are reversed | Reversing entries naming the originals; `stock.movement_reversed` | Refused once reversed |
| Transfer → dispatched | `stores.manage` on the source store; target is another store the caller can see; ≤ on hand | `transfer_out` entries at the average; in transit on both stores; `stock.transfer_dispatched` | Client ID + `Idempotency-Key` |
| dispatched → received / disputed | `stores.manage` on the destination store; a quantity for every line, a reason for each line that differs | `transfer_in` entries at the dispatch unit cost for what arrived; the shortfall's value is the transit loss; `stock.transfer_received` / `stock.transfer_disputed` | `Idempotency-Key` (replay returns the result) |
| disputed → resolved | `procurement.approve` on either project; neither the sender nor the receiver; note | No stock moves; `stock.transfer_resolved` | Expected version |
| dispatched → cancelled | `stores.manage` on the source store; reason | Dispatch reversed into the source store; `stock.transfer_cancelled` | Expected version |
| Stock take started (draft) | `stores.manage`; one open count per store | Lines snapshot the system quantity of every material held or with a reorder level; `stock_take.created` | Refused while another is open |
| Counts recorded | `stores.manage`; draft; lines of this count | Each count keeps the system quantity **at the moment it is counted** (snapshot + movements since), so movements during the count are not variances; the counter becomes a contributor; `stock_take.counted` | Count IDs + `Idempotency-Key` |
| draft → submitted | `stores.manage`; every line counted | Submitter becomes a contributor; `stock_take.submitted` | Expected version |
| submitted → approved | `procurement.approve`; **not a contributor** (creator, counters, submitter) | Each variance posted as an `adjustment` at the average cost (refused if a shortfall exceeds what is now on hand); `stock_take.approved` | Expected version |
| submitted → draft (return) | `procurement.approve`; reason | Recount; `stock_take.returned` | Expected version |
| draft / submitted → cancelled | `stores.manage` or `procurement.approve`; reason | Nothing posted, counts kept as evidence; `stock_take.cancelled` | Expected version |

GRNs post to stores as part of their own workflow (D5.2): recording receives the accepted quantities into the site's store; a void reverses them and is refused (`grn-stock-consumed`) when the goods were already issued or moved.
