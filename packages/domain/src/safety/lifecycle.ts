import type {
  CorrectiveActionAction,
  CorrectiveActionStatus,
  IncidentStatus,
  ToolboxTalkAction,
  ToolboxTalkStatus,
} from "@pm-buddy/types";
import type { TransitionTable } from "../procurement/lifecycle.js";

/**
 * Health and safety state machines (docs/WORKFLOWS.md "Health and safety", brief §15 C). Each
 * table is enforced by the API and repeated by a database trigger in migration
 * `20261124090000_health_safety` (`app.guard_safety_incident`, `app.guard_corrective_action`,
 * `app.guard_toolbox_talk`), so a bypassed API check still cannot skip a state or a sign-off.
 */

export type IncidentAction = "investigate" | "close" | "void";

/**
 * Incidents: reported → investigated (root cause recorded; the investigation can be revised while
 * investigated) → closed (LOCKED) once every corrective action is verified or cancelled and any
 * required regulator decision is recorded; reported or investigated → voided with a reason.
 */
export const INCIDENT_TRANSITIONS: TransitionTable<IncidentStatus, IncidentAction> = {
  investigate: { from: ["reported", "investigated"], to: "investigated", reason: false },
  close: { from: ["investigated"], to: "closed", reason: false },
  void: { from: ["reported", "investigated"], to: "voided", reason: true },
};

/**
 * Corrective actions: open → done (by the owner) → verified (independently); done → open
 * (rejected with a reason); open or done → cancelled (reason). Verified and cancelled are final.
 */
export const CORRECTIVE_ACTION_TRANSITIONS: TransitionTable<
  CorrectiveActionStatus,
  CorrectiveActionAction
> = {
  done: { from: ["open"], to: "done", reason: false },
  verify: { from: ["done"], to: "verified", reason: false },
  reject: { from: ["done"], to: "open", reason: true },
  cancel: { from: ["open", "done"], to: "cancelled", reason: true },
};

/** Toolbox talks: draft → confirmed (LOCKED) or cancelled (reason). */
export const TOOLBOX_TALK_TRANSITIONS: TransitionTable<ToolboxTalkStatus, ToolboxTalkAction> = {
  confirm: { from: ["draft"], to: "confirmed", reason: false },
  cancel: { from: ["draft"], to: "cancelled", reason: true },
};

/** Only the action's owner records it as done. */
export const correctiveActionDoneAllowed = (action: { ownerId: string }, actor: string): boolean =>
  action.ownerId === actor;

/**
 * Whether `actor` may verify or reject a done action: never its owner and never whoever marked it
 * done (maker-checker by identity, not by role).
 */
export const correctiveActionVerifierIndependent = (
  action: { ownerId: string; doneBy: string | null },
  actor: string,
): boolean => action.doneBy !== null && actor !== action.ownerId && actor !== action.doneBy;
