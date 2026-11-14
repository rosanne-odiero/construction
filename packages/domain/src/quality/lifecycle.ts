import type {
  CompletionAction,
  CompletionStatus,
  InspectionAction,
  InspectionItemResult,
  InspectionResult,
  InspectionStatus,
  SnagAction,
  SnagStatus,
} from "@pm-buddy/types";
import type { TransitionTable } from "../procurement/lifecycle.js";

/**
 * Quality state machines (docs/WORKFLOWS.md "Quality", brief §15 C). Each table is enforced by
 * the API and repeated by a database trigger in migration `20261122100000_quality`
 * (`app.guard_inspection`, `app.guard_snag`, `app.guard_project_completion`), so a bypassed API
 * check still cannot skip a state or a sign-off.
 */

/**
 * Inspections: draft → submitted (by the author, every item answered) → signed off (locked) by an
 * independent `quality.manage` holder; submitted → draft when returned with a reason.
 */
export const INSPECTION_TRANSITIONS: TransitionTable<InspectionStatus, InspectionAction> = {
  submit: { from: ["draft"], to: "submitted", reason: false },
  sign_off: { from: ["submitted"], to: "signed_off", reason: false },
  return: { from: ["submitted"], to: "draft", reason: true },
};

/**
 * Snags: open → fixed (recorded for the responsible party) → closed (verified) or back to open
 * (reopened with a reason). Closing and reopening are decided by someone other than whoever
 * recorded the fix; a closed snag is final (a recurrence is a new snag).
 */
export const SNAG_TRANSITIONS: TransitionTable<SnagStatus, SnagAction> = {
  fix: { from: ["open"], to: "fixed", reason: false },
  close: { from: ["fixed"], to: "closed", reason: false },
  reopen: { from: ["fixed"], to: "open", reason: true },
};

/** Completion certificates: proposed → certified (independent, locked) or withdrawn (reason). */
export const COMPLETION_TRANSITIONS: TransitionTable<CompletionStatus, CompletionAction> = {
  certify: { from: ["proposed"], to: "certified", reason: false },
  withdraw: { from: ["proposed"], to: "withdrawn", reason: true },
};

/** Whether `actor` may sign off or return an inspection: never its author or submitter. */
export const inspectionReviewIndependent = (
  inspection: { createdBy: string; submittedBy: string | null },
  actor: string,
): boolean => actor !== inspection.createdBy && actor !== inspection.submittedBy;

/** Whether `actor` may close or reopen a fixed snag: never whoever recorded the fix. */
export const snagDecisionIndependent = (snag: { fixedBy: string | null }, actor: string): boolean =>
  snag.fixedBy !== null && actor !== snag.fixedBy;

/**
 * The inspection's result from its items: null while any item is pending; `fail` when any item
 * failed; otherwise `pass` (every item passed or is not applicable).
 */
export function inspectionOutcome(
  results: readonly InspectionItemResult[],
): InspectionResult | null {
  if (!results.length || results.includes("pending")) return null;
  return results.includes("fail") ? "fail" : "pass";
}

export type InspectionSubmitIssue = "items_pending" | "fail_note_required";

/** Why a draft cannot be submitted yet: unanswered items, or a failed item without a note. */
export function inspectionSubmitIssues(
  items: readonly { result: InspectionItemResult; note: string | null }[],
): InspectionSubmitIssue[] {
  const issues: InspectionSubmitIssue[] = [];
  if (!items.length || items.some((item) => item.result === "pending"))
    issues.push("items_pending");
  if (items.some((item) => item.result === "fail" && (item.note?.trim().length ?? 0) < 3))
    issues.push("fail_note_required");
  return issues;
}
