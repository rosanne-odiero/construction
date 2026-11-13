import {
  LIVE_ATTEMPT_STATUSES,
  PAYMENT_ATTEMPT_TRANSITIONS,
  UNCERTAIN_ATTEMPT_STATUSES,
  type PaymentAttemptStatus,
  type PaymentRequestStatus,
} from "@pm-buddy/types";

/** Whether WORKFLOWS "Payment attempts" allows `from` → `to` (the database guard has the same table). */
export function canTransitionAttempt(from: PaymentAttemptStatus, to: PaymentAttemptStatus): boolean {
  return PAYMENT_ATTEMPT_TRANSITIONS[from].includes(to);
}

export class InvalidAttemptTransition extends Error {
  constructor(
    readonly from: PaymentAttemptStatus,
    readonly to: PaymentAttemptStatus,
  ) {
    super(`Payment attempt cannot move from ${from} to ${to}`);
    this.name = "InvalidAttemptTransition";
  }
}

export function assertAttemptTransition(from: PaymentAttemptStatus, to: PaymentAttemptStatus) {
  if (!canTransitionAttempt(from, to)) throw new InvalidAttemptTransition(from, to);
}

export const isLiveAttempt = (status: PaymentAttemptStatus): boolean =>
  (LIVE_ATTEMPT_STATUSES as readonly PaymentAttemptStatus[]).includes(status);

/** Acceptance or outcome uncertain: reconcile before anything new is sent. */
export const isUncertainAttempt = (status: PaymentAttemptStatus): boolean =>
  (UNCERTAIN_ATTEMPT_STATUSES as readonly PaymentAttemptStatus[]).includes(status);

/**
 * A late or out-of-order result never regresses a final outcome: once confirmed (or reversed)
 * only the reversal edges apply, and a failed attempt stays failed. Conflicting definitive
 * evidence opens a dispute instead of a transition.
 */
export const isFinalOutcome = (status: PaymentAttemptStatus): boolean =>
  status === "confirmed" ||
  status === "failed" ||
  status === "reversal_pending" ||
  status === "reversed";

/** The request's summary status for its current (latest) attempt. */
export function requestStatusFor(status: PaymentAttemptStatus): PaymentRequestStatus {
  switch (status) {
    case "created":
    case "queued":
    case "submitting":
    case "pending":
      return "in_progress";
    case "unknown":
      return "uncertain";
    case "confirmed":
      return "confirmed";
    case "failed":
      return "failed";
    case "reversal_pending":
      return "reversal_pending";
    case "reversed":
      return "reversed";
  }
}
