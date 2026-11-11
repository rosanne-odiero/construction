import type {
  InvoiceAction,
  InvoiceStatus,
  LpoAction,
  LpoStatus,
  RequisitionAction,
  RequisitionStatus,
  RfqAction,
  RfqStatus,
} from "@pm-buddy/types";
import { REASON_LIMITS } from "../project-lifecycle.js";

/**
 * Procure-to-pay state machines (docs/WORKFLOWS.md "Procurement and certification", brief §15 C).
 * Each table is enforced by the API and repeated by a database trigger in migration
 * `20261115100000_procure_to_pay` (`app.guard_requisition`, `app.guard_rfq`, `app.guard_lpo`,
 * `app.guard_supplier_invoice`), so a bypassed API check still cannot skip a state.
 */
export type TransitionTable<S extends string, A extends string> = Readonly<
  Record<A, { from: readonly S[]; to: S; reason: boolean }>
>;

/**
 * Requisitions: draft → submitted → approved | rejected; rejected → draft. Material edits after
 * submission need a return to draft (`reopen` also from submitted and from an approved
 * requisition that is not on an open RFQ), which clears the decision. Approved → ordered when its
 * LPO is approved; ordered → approved when that LPO is cancelled before anything was received or
 * invoiced. Draft and submitted requisitions can be cancelled with a reason.
 */
export const REQUISITION_TRANSITIONS: TransitionTable<RequisitionStatus, RequisitionAction> = {
  submit: { from: ["draft"], to: "submitted", reason: false },
  approve: { from: ["submitted"], to: "approved", reason: false },
  reject: { from: ["submitted"], to: "rejected", reason: true },
  reopen: { from: ["rejected", "submitted", "approved"], to: "draft", reason: false },
  cancel: { from: ["draft", "submitted"], to: "cancelled", reason: true },
  order: { from: ["approved"], to: "ordered", reason: false },
  unorder: { from: ["ordered"], to: "approved", reason: false },
};

/** RFQs: open → awarded (an LPO is created); awarded → open when that LPO is cancelled. */
export const RFQ_TRANSITIONS: TransitionTable<RfqStatus, RfqAction> = {
  award: { from: ["open"], to: "awarded", reason: false },
  reopen: { from: ["awarded"], to: "open", reason: false },
  cancel: { from: ["open"], to: "cancelled", reason: true },
};

/**
 * LPOs: draft → submitted → approved; submitted → draft (returned with a reason); draft,
 * submitted or approved → cancelled (approved only while nothing was received or invoiced).
 * Approved LPOs are immutable: an amendment is a cancellation and a reissue from the same RFQ.
 */
export const LPO_TRANSITIONS: TransitionTable<LpoStatus, LpoAction> = {
  submit: { from: ["draft"], to: "submitted", reason: false },
  approve: { from: ["submitted"], to: "approved", reason: false },
  return: { from: ["submitted"], to: "draft", reason: true },
  cancel: { from: ["draft", "submitted", "approved"], to: "cancelled", reason: true },
};

/**
 * Supplier invoices: draft → submitted → matched | disputed (the three-way match, run in the
 * same transaction as the submission); a re-run can move matched ↔ disputed; disputed → matched
 * by an independent approved exception; disputed or matched → draft for a corrected version;
 * matched → approved; approved → partly_settled → settled from recorded settlements; anything
 * not yet approved can be cancelled with a reason (for example after a credit note).
 */
export const INVOICE_TRANSITIONS: TransitionTable<InvoiceStatus, InvoiceAction> = {
  submit: { from: ["draft"], to: "submitted", reason: false },
  match: { from: ["submitted", "disputed", "matched"], to: "matched", reason: false },
  dispute: { from: ["submitted", "matched", "disputed"], to: "disputed", reason: false },
  except: { from: ["disputed"], to: "matched", reason: true },
  reopen: { from: ["disputed", "matched"], to: "draft", reason: false },
  approve: { from: ["matched"], to: "approved", reason: false },
  settle_part: { from: ["approved", "partly_settled"], to: "partly_settled", reason: false },
  settle: { from: ["approved", "partly_settled"], to: "settled", reason: false },
  cancel: { from: ["draft", "submitted", "disputed", "matched"], to: "cancelled", reason: true },
};

export type ProcurementTransitionCheck<S extends string> =
  | { ok: true; to: S }
  | { ok: false; error: "invalid_transition" | "reason_required" };

/** Checks one command against a table; reasons need at least three characters. */
export function checkProcurementTransition<S extends string, A extends string>(
  table: TransitionTable<S, A>,
  status: S,
  action: A,
  reason?: string | null,
): ProcurementTransitionCheck<S> {
  const transition = table[action];
  if (!transition.from.includes(status)) return { ok: false, error: "invalid_transition" };
  if (transition.reason && (reason?.trim() ?? "").length < REASON_LIMITS.min)
    return { ok: false, error: "reason_required" };
  return { ok: true, to: transition.to };
}

/** Every distinct (from, to) status change a table allows (what the database triggers accept). */
export function statusChanges<S extends string, A extends string>(
  table: TransitionTable<S, A>,
): [S, S][] {
  const pairs = new Map<string, [S, S]>();
  for (const { from, to } of Object.values(table) as { from: readonly S[]; to: S }[])
    for (const source of from) if (source !== to) pairs.set(`${source}>${to}`, [source, to]);
  return [...pairs.values()];
}

/** Commands available from a status (the UI hides the others; the API still checks). */
export function allowedActions<S extends string, A extends string>(
  table: TransitionTable<S, A>,
  status: S,
): A[] {
  return (Object.keys(table) as A[]).filter((action) => table[action].from.includes(status));
}
