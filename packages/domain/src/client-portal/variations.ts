import type {
  ClientDecision,
  ClientRequestState,
  VariationLineAction,
  VariationStatus,
} from "@pm-buddy/types";

/**
 * Variation approval by the client (D7.1, rule D-134). Staff send a SUBMITTED variation to the
 * project's client: the sending freezes the client's view of the proposal (what the variation
 * shows: lines with their quantities, contract rates and amounts, never build-ups or internal
 * notes) and its digest. The client approves or rejects that exact view once, with comments; the
 * D2.3 state machine is unchanged, and when the project requires it, internal approval waits for
 * the client's approval of the current submission.
 */

export type ClientVariationLine = {
  lineNo: number;
  action: VariationLineAction;
  ref: string | null;
  description: string;
  unit: string | null;
  /** The quantity after the variation (null for an amount-only line). */
  quantity: string | null;
  /** The contract rate after the variation (null for an amount-only line). */
  rate: string | null;
  baseAmountMinor: number;
  newAmountMinor: number;
  deltaMinor: number;
};

export type ClientVariationView = {
  number: string;
  title: string;
  description: string | null;
  instruction: { number: string; subject: string };
  lines: ClientVariationLine[];
  totals: { additionsMinor: number; omissionsMinor: number; netMinor: number };
  vatRatePercent: string;
  /** The contract sum (incl. VAT) before and after the variation, and the change. */
  baseGrandTotalMinor: number;
  projectedGrandTotalMinor: number;
  grandTotalEffectMinor: number;
};

/**
 * The canonical text of what the client is shown; its SHA-256 is the digest the client's decision
 * quotes, so a decision binds to exactly the figures the client saw.
 */
export function clientVariationText(view: ClientVariationView): string {
  return JSON.stringify([
    "pm-buddy.variation-client.v1",
    view.number,
    view.title,
    view.description,
    [view.instruction.number, view.instruction.subject],
    view.lines.map((line) => [
      line.lineNo,
      line.action,
      line.ref,
      line.description,
      line.unit,
      line.quantity,
      line.rate,
      line.baseAmountMinor,
      line.newAmountMinor,
      line.deltaMinor,
    ]),
    [view.totals.additionsMinor, view.totals.omissionsMinor, view.totals.netMinor],
    view.vatRatePercent,
    view.baseGrandTotalMinor,
    view.projectedGrandTotalMinor,
    view.grandTotalEffectMinor,
  ]);
}

/**
 * Whether a sending can still be decided by the client: nobody decided it, and the variation is
 * still the submitted proposal it was sent from (same submission time and snapshot digest).
 */
export function clientRequestOpen(input: {
  decided: boolean;
  variation: { status: VariationStatus; snapshotDigest: string | null; submittedAt: string | null };
  request: { snapshotDigest: string; submittedAt: string };
}): boolean {
  const { variation, request } = input;
  return (
    !input.decided &&
    variation.status === "submitted" &&
    variation.snapshotDigest === request.snapshotDigest &&
    variation.submittedAt === request.submittedAt
  );
}

/** A sending as the client sees it. */
export function clientRequestState(
  decision: ClientDecision | null,
  open: boolean,
): ClientRequestState {
  if (decision) return decision;
  return open ? "awaiting_decision" : "withdrawn";
}

/**
 * Whether the contractor may approve the variation internally now: always when the project does
 * not require the client's approval; otherwise only once the client approved the current
 * submission (the sending made from it). Rejection never waits for the client.
 */
export function clientApprovalSatisfied(input: {
  required: boolean;
  currentDecision: ClientDecision | null;
}): boolean {
  return !input.required || input.currentDecision === "approved";
}
