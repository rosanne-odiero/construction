import type { VariationAction, VariationStatus } from "@pm-buddy/types";
import { REASON_LIMITS } from "../project-lifecycle.js";

/**
 * The Variation Order state machine (docs/WORKFLOWS.md, brief §15 C):
 * draft → submitted → approved | rejected; rejected → draft (reopen); draft → cancelled; and
 * rebase, which re-points a stale variation (its base is no longer the newest approved version)
 * to the newest version and returns it to draft. Approved and cancelled are final. Enforced by
 * the API and repeated by the database trigger `app.guard_variation_order`.
 */
export const VARIATION_TRANSITIONS: Readonly<
  Record<
    VariationAction,
    { from: readonly VariationStatus[]; to: VariationStatus; reason: boolean }
  >
> = {
  submit: { from: ["draft"], to: "submitted", reason: false },
  approve: { from: ["submitted"], to: "approved", reason: false },
  reject: { from: ["submitted"], to: "rejected", reason: true },
  reopen: { from: ["rejected"], to: "draft", reason: false },
  cancel: { from: ["draft"], to: "cancelled", reason: true },
  rebase: { from: ["draft", "submitted", "rejected"], to: "draft", reason: false },
};

/** Every (from, to) status change the database accepts. */
export const VARIATION_STATUS_CHANGES: readonly (readonly [VariationStatus, VariationStatus])[] = [
  ["draft", "submitted"],
  ["submitted", "approved"],
  ["submitted", "rejected"],
  ["rejected", "draft"],
  ["draft", "cancelled"],
  ["submitted", "draft"],
];

export type VariationTransitionCheck =
  | { ok: true; to: VariationStatus }
  | { ok: false; error: "invalid_transition" | "reason_required" | "not_stale" };

/**
 * Checks a command against the state machine. `stale` says whether the variation's base is no
 * longer the newest approved version (rebase is only offered then). Reject and cancel need a
 * reason of at least three characters.
 */
export function checkVariationTransition(input: {
  status: VariationStatus;
  action: VariationAction;
  reason?: string | null;
  stale?: boolean;
}): VariationTransitionCheck {
  const transition = VARIATION_TRANSITIONS[input.action];
  if (!transition.from.includes(input.status)) return { ok: false, error: "invalid_transition" };
  const reason = input.reason?.trim() ?? "";
  if (transition.reason && reason.length < REASON_LIMITS.min)
    return { ok: false, error: "reason_required" };
  if (input.action === "rebase" && !input.stale) return { ok: false, error: "not_stale" };
  return { ok: true, to: transition.to };
}

/** Commands available from a status (the UI hides the others; the API still checks). */
export const allowedVariationActions = (status: VariationStatus): VariationAction[] =>
  (Object.keys(VARIATION_TRANSITIONS) as VariationAction[]).filter((action) =>
    VARIATION_TRANSITIONS[action].from.includes(status),
  );

/** Lines, title, instruction and base can change only while a variation is a draft. */
export const isVariationEditable = (status: VariationStatus): boolean => status === "draft";

/** Approved and cancelled variations never change again. */
export const isVariationFinal = (status: VariationStatus): boolean =>
  status === "approved" || status === "cancelled";
