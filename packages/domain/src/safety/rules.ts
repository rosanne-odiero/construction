import {
  SAFETY_WARNING_DAYS,
  type CertificateState,
  type CorrectiveActionStatus,
  type IncidentKind,
  type IncidentSeverity,
  type IncidentStatus,
  type InductionState,
  type KitState,
  type PpeReplacementState,
  type RegulatorDecision,
  type RegulatorState,
} from "@pm-buddy/types";
import { addCalendarDays, calendarDaysBetween } from "../labour.js";

/**
 * Health and safety rules (D8.2; docs/WORKFLOWS.md "Health and safety"). Pure functions over
 * business dates (YYYY-MM-DD, Africa/Nairobi): the API, the web screens and the database triggers
 * of migration `20261124090000_health_safety` apply the same rules.
 */

// Corrective actions ----------------------------------------------------------------------------

type ActionFacts = { status: CorrectiveActionStatus; dueOn: string };

/** An open action whose due date has passed (a done action awaiting verification is not overdue). */
export const correctiveActionOverdue = (action: ActionFacts, today: string): boolean =>
  action.status === "open" && action.dueOn < today;

/** Days past the due date for an overdue action, otherwise null. */
export const correctiveActionDaysOverdue = (action: ActionFacts, today: string): number | null =>
  correctiveActionOverdue(action, today) ? calendarDaysBetween(action.dueOn, today) : null;

/**
 * List order: overdue first (most overdue first), then open by due date, then done (awaiting
 * verification), then verified and cancelled; ties by number.
 */
export function correctiveActionRank(action: ActionFacts, today: string): number {
  if (correctiveActionOverdue(action, today)) return 0;
  return { open: 1, done: 2, verified: 3, cancelled: 4 }[action.status];
}
export function compareCorrectiveActions<T extends ActionFacts & { number: number }>(
  today: string,
): (a: T, b: T) => number {
  return (a, b) =>
    correctiveActionRank(a, today) - correctiveActionRank(b, today) ||
    (a.dueOn < b.dueOn ? -1 : a.dueOn > b.dueOn ? 1 : 0) ||
    a.number - b.number;
}

// Inductions ------------------------------------------------------------------------------------

type InductionFact = { inductedOn: string };

/** The last day an induction counts, or null when inductions do not expire. */
export const inductionValidUntil = (inductedOn: string, validityDays: number | null) =>
  validityDays === null ? null : addCalendarDays(inductedOn, validityDays - 1);

/** Whether an induction covers a date: given on or before it and not yet expired. */
export function inductionCovers(
  induction: InductionFact,
  date: string,
  validityDays: number | null,
): boolean {
  if (induction.inductedOn > date) return false;
  const until = inductionValidUntil(induction.inductedOn, validityDays);
  return until === null || date <= until;
}

/**
 * A labourer's induction status at one site today, from their (unvoided) inductions there: the
 * newest induction given on or before today decides.
 */
export function inductionStatus(
  inductions: readonly InductionFact[],
  validityDays: number | null,
  today: string,
): { state: InductionState; inductedOn: string | null; validUntil: string | null } {
  const latest = inductions
    .map((induction) => induction.inductedOn)
    .filter((date) => date <= today)
    .sort()
    .at(-1);
  if (!latest) return { state: "none", inductedOn: null, validUntil: null };
  const validUntil = inductionValidUntil(latest, validityDays);
  return {
    state: validUntil === null || today <= validUntil ? "valid" : "expired",
    inductedOn: latest,
    validUntil,
  };
}

/**
 * Induction coverage: the days a labourer worked at a site (present or half day in attendance)
 * when no induction at that site covered the day, oldest first. Attendance is never blocked; these
 * days are flagged for the site team (decision D-71).
 */
export function uninductedAttendance(
  attendedDates: readonly string[],
  inductions: readonly InductionFact[],
  validityDays: number | null,
): string[] {
  return [...new Set(attendedDates)]
    .filter(
      (date) => !inductions.some((induction) => inductionCovers(induction, date, validityDays)),
    )
    .sort();
}

// PPE -------------------------------------------------------------------------------------------

/** When an item issued on `issuedOn` falls due for replacement under the company's period. */
export const ppeReplacementDueOn = (issuedOn: string, replacementDays: number): string =>
  addCalendarDays(issuedOn, replacementDays);

/** An item still with the labourer against its replacement date (due on the date itself). */
export function ppeReplacementState(
  dueOn: string,
  today: string,
  warnDays: number = SAFETY_WARNING_DAYS.ppe,
): PpeReplacementState {
  if (dueOn <= today) return "due";
  return dueOn <= addCalendarDays(today, warnDays) ? "due_soon" : "ok";
}

// Incidents -------------------------------------------------------------------------------------

/**
 * Serious and fatal injuries, and every dangerous occurrence, need a recorded decision on
 * notifying the regulator before the incident can close (COMPLIANCE-REVIEW CR-HS-01: the legal
 * thresholds and deadlines are for a reviewer to confirm; this rule errs towards asking). A near
 * miss records its potential severity, which never triggers a notification by itself.
 */
export const regulatorReviewRequired = (kind: IncidentKind, severity: IncidentSeverity): boolean =>
  kind === "dangerous_occurrence" ||
  (kind === "injury" && (severity === "serious" || severity === "fatal"));

export function regulatorState(
  kind: IncidentKind,
  severity: IncidentSeverity,
  decision: RegulatorDecision | null,
): RegulatorState {
  if (decision) return decision;
  return regulatorReviewRequired(kind, severity) ? "required" : "not_required";
}

export type IncidentCloseBlocker =
  "not_investigated" | "actions_outstanding" | "no_verified_action" | "regulator_decision_required";

/**
 * Why an incident cannot close yet. Closing needs: an investigation (root cause); every corrective
 * action verified or cancelled; at least one verified action unless a reason for needing none is
 * given; and a regulator decision when one is required.
 */
export function incidentCloseBlockers(
  incident: {
    status: IncidentStatus;
    kind: IncidentKind;
    severity: IncidentSeverity;
    regulatorDecision: RegulatorDecision | null;
  },
  actions: readonly { status: CorrectiveActionStatus }[],
  noActionReason: string | null,
): IncidentCloseBlocker[] {
  const blockers: IncidentCloseBlocker[] = [];
  if (incident.status !== "investigated") blockers.push("not_investigated");
  if (actions.some((action) => action.status === "open" || action.status === "done"))
    blockers.push("actions_outstanding");
  if (
    !actions.some((action) => action.status === "verified") &&
    (noActionReason?.trim().length ?? 0) < 3
  )
    blockers.push("no_verified_action");
  if (regulatorState(incident.kind, incident.severity, incident.regulatorDecision) === "required")
    blockers.push("regulator_decision_required");
  return blockers;
}

// First aid -------------------------------------------------------------------------------------

/** The date the next kit check is due, or null for a kit never checked. */
export const kitNextCheckOn = (lastCheckedOn: string | null, intervalDays: number) =>
  lastCheckedOn === null ? null : addCalendarDays(lastCheckedOn, intervalDays);

/**
 * A kit against today: retired; never checked; expired contents (the earliest expiry has passed);
 * check overdue (more than the interval since the last check); contents expiring within the
 * warning window; otherwise ok. Expiry outranks an overdue check because the kit must not be
 * relied on.
 */
export function kitState(
  kit: { status: "active" | "retired"; lastCheckedOn: string | null; expiresOn: string | null },
  intervalDays: number,
  today: string,
  warnDays: number = SAFETY_WARNING_DAYS.kitExpiry,
): KitState {
  if (kit.status === "retired") return "retired";
  if (kit.lastCheckedOn === null) return "never_checked";
  if (kit.expiresOn !== null && kit.expiresOn < today) return "expired";
  if (kitNextCheckOn(kit.lastCheckedOn, intervalDays)! < today) return "check_due";
  return kit.expiresOn !== null && kit.expiresOn <= addCalendarDays(today, warnDays)
    ? "expiring"
    : "ok";
}

/** A first-aid certificate against today: expired after its date, expiring within the window. */
export function certificateState(
  expiresOn: string,
  today: string,
  warnDays: number = SAFETY_WARNING_DAYS.certificate,
): CertificateState {
  if (expiresOn < today) return "expired";
  return expiresOn <= addCalendarDays(today, warnDays) ? "expiring" : "valid";
}
