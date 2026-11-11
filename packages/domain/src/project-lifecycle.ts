import type { MilestoneStatus, ProjectStatus } from "@pm-buddy/types";

/**
 * Explicit project and milestone lifecycles (brief §15 C). The API refuses any transition not
 * listed here; there are no independent status flags.
 */

export type ProjectAction = "activate" | "suspend" | "resume" | "complete" | "close" | "cancel";
export type ProjectTransition = {
  from: ProjectStatus;
  to: ProjectStatus;
  action: ProjectAction;
  /** A written reason (3–500 characters) is required. */
  reasonRequired: boolean;
};

export const PROJECT_TRANSITIONS: readonly ProjectTransition[] = [
  { from: "planning", to: "active", action: "activate", reasonRequired: false },
  { from: "planning", to: "cancelled", action: "cancel", reasonRequired: true },
  { from: "active", to: "on_hold", action: "suspend", reasonRequired: true },
  { from: "on_hold", to: "active", action: "resume", reasonRequired: false },
  { from: "on_hold", to: "cancelled", action: "cancel", reasonRequired: true },
  { from: "active", to: "completed", action: "complete", reasonRequired: false },
  { from: "completed", to: "closed", action: "close", reasonRequired: false },
];

export const projectTransition = (
  from: ProjectStatus,
  to: ProjectStatus,
): ProjectTransition | undefined =>
  PROJECT_TRANSITIONS.find((transition) => transition.from === from && transition.to === to);

export const allowedProjectTransitions = (from: ProjectStatus): ProjectTransition[] =>
  PROJECT_TRANSITIONS.filter((transition) => transition.from === from);

/** Closed and cancelled projects are read-only: no edits to details, sites, WBS or milestones. */
export const isProjectReadOnly = (status: ProjectStatus): boolean =>
  status === "closed" || status === "cancelled";

/** What a project needs before it can become active. */
export const ACTIVATION_REQUIREMENTS = [
  "client_name",
  "contract_sum",
  "contract_type",
  "start_date",
  "end_date",
  "county",
  "town",
  "site_with_geofence",
] as const;
export type ActivationRequirement = (typeof ACTIVATION_REQUIREMENTS)[number];

export type ActivationFacts = {
  clientName: string | null;
  contractSumMinor: number | null;
  contractType: string | null;
  startDate: string | null;
  endDate: string | null;
  county: string | null;
  town: string | null;
  /** Sites that have a current geofence. Every site has one, so this is the site count. */
  geofencedSites: number;
};

export function activationGaps(facts: ActivationFacts): ActivationRequirement[] {
  const missing: Record<ActivationRequirement, boolean> = {
    client_name: !facts.clientName,
    contract_sum: facts.contractSumMinor === null || facts.contractSumMinor <= 0,
    contract_type: !facts.contractType,
    start_date: !facts.startDate,
    end_date: !facts.endDate,
    county: !facts.county,
    town: !facts.town,
    site_with_geofence: facts.geofencedSites < 1,
  };
  return ACTIVATION_REQUIREMENTS.filter((requirement) => missing[requirement]);
}

export const REASON_LIMITS = { min: 3, max: 500 } as const;

export type TransitionCheck =
  | { ok: true; transition: ProjectTransition }
  | { ok: false; error: "invalid_transition" | "reason_required" }
  | { ok: false; error: "activation_incomplete"; missing: ActivationRequirement[] };

/** Validates a requested project status change against the lifecycle and its preconditions. */
export function checkProjectTransition(input: {
  from: ProjectStatus;
  to: ProjectStatus;
  reason?: string | null;
  facts: ActivationFacts;
}): TransitionCheck {
  const transition = projectTransition(input.from, input.to);
  if (!transition) return { ok: false, error: "invalid_transition" };
  const reason = input.reason?.trim() ?? "";
  if ((transition.reasonRequired || reason.length > 0) && reason.length < REASON_LIMITS.min)
    return { ok: false, error: "reason_required" };
  if (transition.action === "activate") {
    const missing = activationGaps(input.facts);
    if (missing.length) return { ok: false, error: "activation_incomplete", missing };
  }
  return { ok: true, transition };
}

export type MilestoneAction = "start" | "achieve" | "cancel" | "reopen";
export type MilestoneTransition = {
  from: MilestoneStatus;
  to: MilestoneStatus;
  action: MilestoneAction;
  reasonRequired: boolean;
};

/** Achieving a milestone records its actual date; reopening clears it. Cancelled is final. */
export const MILESTONE_TRANSITIONS: readonly MilestoneTransition[] = [
  { from: "planned", to: "in_progress", action: "start", reasonRequired: false },
  { from: "planned", to: "achieved", action: "achieve", reasonRequired: false },
  { from: "in_progress", to: "achieved", action: "achieve", reasonRequired: false },
  { from: "planned", to: "cancelled", action: "cancel", reasonRequired: true },
  { from: "in_progress", to: "cancelled", action: "cancel", reasonRequired: true },
  { from: "achieved", to: "in_progress", action: "reopen", reasonRequired: true },
];

export const milestoneTransition = (
  from: MilestoneStatus,
  to: MilestoneStatus,
): MilestoneTransition | undefined =>
  MILESTONE_TRANSITIONS.find((transition) => transition.from === from && transition.to === to);

export const allowedMilestoneTransitions = (from: MilestoneStatus): MilestoneTransition[] =>
  MILESTONE_TRANSITIONS.filter((transition) => transition.from === from);

export type MilestoneTransitionCheck =
  | { ok: true; transition: MilestoneTransition }
  | {
      ok: false;
      error:
        "invalid_transition" | "reason_required" | "actual_date_required" | "actual_date_future";
    };

/**
 * Validates a milestone status change. `today` is the business date in Africa/Nairobi
 * (YYYY-MM-DD); an achievement cannot be dated in the future.
 */
export function checkMilestoneTransition(input: {
  from: MilestoneStatus;
  to: MilestoneStatus;
  reason?: string | null;
  actualDate?: string | null;
  today: string;
}): MilestoneTransitionCheck {
  const transition = milestoneTransition(input.from, input.to);
  if (!transition) return { ok: false, error: "invalid_transition" };
  const reason = input.reason?.trim() ?? "";
  if ((transition.reasonRequired || reason.length > 0) && reason.length < REASON_LIMITS.min)
    return { ok: false, error: "reason_required" };
  if (transition.action === "achieve") {
    if (!input.actualDate) return { ok: false, error: "actual_date_required" };
    if (input.actualDate > input.today) return { ok: false, error: "actual_date_future" };
  }
  return { ok: true, transition };
}

/** Today's calendar date in Africa/Nairobi as YYYY-MM-DD. */
export function nairobiDate(at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
