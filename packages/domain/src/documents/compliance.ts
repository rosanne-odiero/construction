import type {
  ApprovalDecision,
  ApprovalStatus,
  ComplianceRecordKind,
  ComplianceStatus,
  DocumentReminderKind,
} from "@pm-buddy/types";
import { addCalendarDays, calendarDaysBetween } from "../labour.js";
import { nairobiDate } from "../project-lifecycle.js";

/**
 * The compliance register's rules (D8.4, decision D-116). Statuses are derived on read from the
 * current record and the item type, in Africa/Nairobi business dates: a certificate is valid up
 * to and including its expiry date, `expiring` from `reminderDays` before it (the window
 * includes both ends), and `expired` from the next day. Nothing is stored, so a changed
 * reminder window or a new day changes the status without a job.
 */

/** Today in Nairobi (UTC+3, no daylight saving): the day turns at 21:00 UTC. */
export const complianceToday = (now: Date = new Date()) => nairobiDate(now);

export type ComplianceRule = {
  /** Whether records of this type carry an expiry date. */
  expires: boolean;
  /** Days before the expiry date when the reminder starts (1–365). */
  reminderDays: number;
};

export type ComplianceRecordFacts = {
  kind: ComplianceRecordKind;
  expiresOn: string | null;
};

export type ComplianceState = {
  status: ComplianceStatus;
  /** Days from today to the expiry date (0 on the day, negative once expired). */
  daysLeft: number | null;
  /** The first day of the reminder window (expiry − reminder days). */
  remindFrom: string | null;
};

export function complianceStatus(
  record: ComplianceRecordFacts | null,
  rule: ComplianceRule,
  today: string,
): ComplianceState {
  if (!record) return { status: "missing", daysLeft: null, remindFrom: null };
  if (record.kind === "not_applicable")
    return { status: "not_applicable", daysLeft: null, remindFrom: null };
  if (!rule.expires || record.expiresOn === null)
    return { status: "valid", daysLeft: null, remindFrom: null };
  const daysLeft = calendarDaysBetween(today, record.expiresOn);
  const remindFrom = addCalendarDays(record.expiresOn, -rule.reminderDays);
  if (daysLeft < 0) return { status: "expired", daysLeft, remindFrom };
  if (daysLeft <= rule.reminderDays) return { status: "expiring", daysLeft, remindFrom };
  return { status: "valid", daysLeft, remindFrom };
}

/** Whether a status needs attention (raises a reminder). */
export const complianceNeedsAttention = (status: ComplianceStatus) =>
  status === "missing" || status === "expiring" || status === "expired";

export type ComplianceCounts = Record<ComplianceStatus, number>;

export function complianceCounts(statuses: readonly ComplianceStatus[]): ComplianceCounts {
  const counts: ComplianceCounts = {
    missing: 0,
    valid: 0,
    expiring: 0,
    expired: 0,
    not_applicable: 0,
  };
  for (const status of statuses) counts[status] += 1;
  return counts;
}

export const reminderKindOf = (status: ComplianceStatus): DocumentReminderKind | null =>
  status === "missing"
    ? "compliance_missing"
    : status === "expiring"
      ? "compliance_expiring"
      : status === "expired"
        ? "compliance_expired"
        : null;

export type ReminderOrderFacts = {
  kind: DocumentReminderKind;
  /** Days left (negative when expired or overdue); null for missing items. */
  daysLeft: number | null;
  label: string;
};

const REMINDER_RANK: Readonly<Record<DocumentReminderKind, number>> = {
  compliance_expired: 0,
  approval_overdue: 1,
  compliance_missing: 2,
  compliance_expiring: 3,
};

/**
 * Reminder order: expired items first (longest expired first), then overdue approval requests
 * (most overdue first), then missing items, then items expiring (soonest first); ties by label.
 */
export function compareReminders(a: ReminderOrderFacts, b: ReminderOrderFacts): number {
  const rank = REMINDER_RANK[a.kind] - REMINDER_RANK[b.kind];
  if (rank) return rank;
  const left = a.daysLeft ?? 0;
  const right = b.daysLeft ?? 0;
  if (left !== right) return left - right;
  return a.label.localeCompare(b.label);
}

/** Validity of a record's dates: issued not in the future, expiry not before issue. */
export function complianceDatesProblem(
  input: { issuedOn: string | null; expiresOn: string | null; expires: boolean },
  today: string,
):
  | "compliance-issued-future"
  | "compliance-expiry-before-issue"
  | "compliance-expiry-required"
  | null {
  if (input.issuedOn !== null && input.issuedOn > today) return "compliance-issued-future";
  if (input.expires && input.expiresOn === null) return "compliance-expiry-required";
  if (input.issuedOn !== null && input.expiresOn !== null && input.expiresOn < input.issuedOn)
    return "compliance-expiry-before-issue";
  return null;
}

// Approval requests ----------------------------------------------------------------------------

/** pending until the one response decides it; cancelled with a reason (D-117). */
export function approvalStatus(facts: {
  cancelled: boolean;
  decision: ApprovalDecision | null;
}): ApprovalStatus {
  if (facts.decision) return facts.decision;
  return facts.cancelled ? "cancelled" : "pending";
}

/** A pending request is overdue from the day after its due date (Nairobi). */
export const approvalOverdue = (status: ApprovalStatus, dueOn: string, today: string) =>
  status === "pending" && dueOn < today;

/** Days a pending request is overdue (0 when not overdue). */
export const approvalDaysOverdue = (status: ApprovalStatus, dueOn: string, today: string) =>
  approvalOverdue(status, dueOn, today) ? calendarDaysBetween(dueOn, today) : 0;

export type ApprovalResponseProblem =
  "approval-raiser-cannot-respond" | "approval-uploader-cannot-respond";

/**
 * Independence of an approval (decision D-117): someone answering in the app answers as
 * themselves and is neither the person who raised the request nor the uploader of the document
 * version under review. A paper response transcribes an external consultant's signed answer (the
 * consultant's name and the scan are required), so the recorder may be anyone who manages
 * documents, including the person who raised it.
 */
export function approvalResponseProblem(input: {
  channel: "in_app" | "paper";
  actorId: string;
  raisedBy: string;
  uploadedBy: string;
}): ApprovalResponseProblem | null {
  if (input.channel === "paper") return null;
  if (input.actorId === input.raisedBy) return "approval-raiser-cannot-respond";
  if (input.actorId === input.uploadedBy) return "approval-uploader-cannot-respond";
  return null;
}
