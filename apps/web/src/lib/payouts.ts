import {
  PAYROLL_SETTLEMENT_STATUSES,
  type ObligationProgressStatus,
  type PayoutDisplayStatus,
  type PayrollBatchStatus,
  type PayslipNoticeState,
  type RecipientVerificationState,
  type ReconciliationItemSeverity,
} from "@pm-buddy/types";
import type { BatchDecision, BatchPayoutsResponse, PayrollBatch } from "@pm-buddy/validation";
import type { Tone } from "@/components/status-badge";

/**
 * Payroll approvals and payouts in the browser (D4.3). Statuses, eligibility and amounts come from
 * the API; these helpers only choose how they look and when the payouts screen polls.
 */

/** Uncertain or still-moving payouts never get the successful-payment tone. */
export const displayTone: Record<PayoutDisplayStatus, Tone> = {
  queued: "neutral",
  submitting: "warning",
  pending: "warning",
  uncertain: "warning",
  confirmed: "success",
  failed: "danger",
  reversal_pending: "warning",
  reversed: "danger",
  pending_confirmation: "warning",
  rejected: "danger",
};

export const progressTone: Record<ObligationProgressStatus, Tone> = {
  ready: "info",
  blocked: "warning",
  in_flight: "warning",
  uncertain: "warning",
  failed: "danger",
  reversed: "danger",
  partially_paid: "warning",
  settled: "success",
};

export const verificationTone: Record<RecipientVerificationState, Tone> = {
  verified: "success",
  unverified: "warning",
  no_number: "neutral",
};

export const payslipTone: Record<PayslipNoticeState, Tone> = {
  not_due: "neutral",
  no_number: "neutral",
  queued: "info",
  sent: "success",
  failed: "danger",
};

export const reconciliationSeverityTone: Record<ReconciliationItemSeverity, Tone> = {
  info: "info",
  warning: "warning",
  critical: "danger",
};

/** Payouts that move without anyone acting (the provider or the worker answers). */
export const MOVING_DISPLAY_STATUSES: readonly PayoutDisplayStatus[] = [
  "queued",
  "submitting",
  "pending",
  "reversal_pending",
];

/**
 * Whether the payouts screen should keep polling: an M-Pesa payout still on its way, or a payslip
 * SMS waiting for its first send. Uncertain payouts wait for reconciliation and cash waits for a
 * second person, so neither keeps the screen polling.
 */
export function payoutsInFlight(data: Pick<BatchPayoutsResponse, "obligations">): boolean {
  return data.obligations.some(
    (obligation) =>
      obligation.payouts.some((payout) => MOVING_DISPLAY_STATUSES.includes(payout.displayStatus)) ||
      (obligation.payslip.state === "queued" && obligation.payslip.notification?.attempts === 0),
  );
}

/** Polls every 5 s; each failed poll doubles the wait, up to 80 s (no refresh storms). */
export const POLL_INTERVAL_MS = 5_000;
export const pollDelay = (failures: number) => POLL_INTERVAL_MS * 2 ** Math.min(failures, 4);

/** A whole-shilling amount typed by a user ("2,500") → minor units, or null (no cents, no zero). */
export function wholeShillingsToMinor(value: string): number | null {
  const cleaned = value.replace(/[,\s]/g, "");
  if (!/^[1-9]\d{0,9}$/.test(cleaned)) return null;
  return Number(cleaned) * 100;
}

/** A decimal ratio typed by a user ("0.85") with at most two decimals, or null. */
export function ratioInput(value: string): number | null {
  const cleaned = value.trim();
  if (!/^(0(\.\d{1,2})?|1(\.0{1,2})?)$/.test(cleaned)) return null;
  return Number(cleaned);
}

export const isSettlementStatus = (status: PayrollBatchStatus) =>
  (PAYROLL_SETTLEMENT_STATUSES as readonly PayrollBatchStatus[]).includes(status);

/** The worker's record (registry panel) where numbers are verified and holds released. */
export const workerHref = (labourerId: string) => `/labour?worker=${labourerId}`;

export type TimelineKey =
  | "prepared"
  | "submitted"
  | "reviewed"
  | "approved"
  | "payout"
  | "rejected"
  | "cancelled";

export type TimelineStep = {
  key: TimelineKey;
  /** For `payout`: the settlement status reached, or null while none is. */
  status: PayrollBatchStatus | null;
  state: "done" | "current" | "upcoming";
  actor: string | null;
  at: string | null;
  note: string | null;
  underWaiver: boolean;
};

const RANK: Record<PayrollBatchStatus, number> = {
  draft: 0,
  submitted: 1,
  reviewed: 2,
  rejected: -1,
  cancelled: -1,
  approved: 3,
  disbursing: 4,
  partially_settled: 4,
  settled: 4,
};

/**
 * The batch's path through its workflow for the status timeline: prepared → submitted → reviewed
 * → approved → paying out (the derived settlement status), with a rejection or cancellation shown
 * where it happened. Only the current cycle counts: decisions before the latest reopening are
 * history, not progress.
 */
export function batchTimeline(
  batch: Pick<
    PayrollBatch,
    | "status"
    | "createdBy"
    | "createdAt"
    | "submittedBy"
    | "submittedAt"
    | "cancelledBy"
    | "cancelledAt"
    | "cancellationReason"
  >,
  decisions: readonly Pick<BatchDecision, "action" | "actor" | "createdAt" | "note" | "underWaiver">[],
): TimelineStep[] {
  const ordered = [...decisions].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const reopened = ordered.findLastIndex((decision) => decision.action === "reopen");
  const cycle = ordered.slice(reopened + 1);
  const last = (action: BatchDecision["action"]) =>
    cycle.findLast((decision) => decision.action === action) ?? null;
  const review = last("review");
  const approve = last("approve");
  const reject = batch.status === "rejected" ? last("reject") : null;
  let rank = RANK[batch.status];
  if (batch.status === "rejected") rank = review ? 2 : 1;
  if (batch.status === "cancelled") rank = review ? 2 : batch.submittedAt ? 1 : 0;
  const stopped = batch.status === "rejected" || batch.status === "cancelled";
  const state = (index: number): TimelineStep["state"] =>
    index < rank || (index === rank && stopped) ? "done" : index === rank ? "current" : "upcoming";
  const step = (
    key: TimelineKey,
    index: number,
    actor: { displayName: string } | null,
    at: string | null,
    extra: Partial<TimelineStep> = {},
  ): TimelineStep => ({
    key,
    status: null,
    state: state(index),
    actor: actor?.displayName ?? null,
    at,
    note: null,
    underWaiver: false,
    ...extra,
  });
  const steps: TimelineStep[] = [
    step("prepared", 0, batch.createdBy, batch.createdAt),
    step("submitted", 1, rank >= 1 ? batch.submittedBy : null, rank >= 1 ? batch.submittedAt : null),
    step("reviewed", 2, review?.actor ?? null, review?.createdAt ?? null, {
      note: review?.note ?? null,
    }),
  ];
  if (stopped) {
    steps.push(
      batch.status === "rejected"
        ? step("rejected", rank, reject?.actor ?? null, reject?.createdAt ?? null, {
            state: "current",
            note: reject?.note ?? null,
          })
        : step("cancelled", rank, batch.cancelledBy, batch.cancelledAt, {
            state: "current",
            note: batch.cancellationReason,
          }),
    );
    return steps.filter((entry) => entry.state !== "upcoming");
  }
  steps.push(
    step("approved", 3, approve?.actor ?? null, approve?.createdAt ?? null, {
      note: approve?.note ?? null,
      underWaiver: approve?.underWaiver ?? false,
    }),
    step("payout", 4, null, null, {
      status: rank >= 4 ? batch.status : null,
      state: batch.status === "settled" ? "done" : state(4),
    }),
  );
  return steps;
}
