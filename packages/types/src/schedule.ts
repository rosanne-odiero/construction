import type { IsoWeekday } from "./attendance.js";

/**
 * Schedule vocabulary (D6.2, brief §5.9 and §15 G). The database CHECK constraints list the same
 * keys, so adding a value needs a migration as well as a change here.
 */

/** A schedule item: a task with a duration, or a project milestone linked as a zero-duration marker. */
export const SCHEDULE_ITEM_KINDS = ["task", "milestone"] as const;
export type ScheduleItemKind = (typeof SCHEDULE_ITEM_KINDS)[number];

/**
 * Dependency types, predecessor → successor:
 * - FS finish-to-start: the successor starts after the predecessor finishes (+ lag).
 * - SS start-to-start: the successor starts after the predecessor starts (+ lag).
 * - FF finish-to-finish: the successor finishes after the predecessor finishes (+ lag).
 * - SF start-to-finish: the successor finishes after the predecessor starts (+ lag).
 */
export const DEPENDENCY_TYPES = ["FS", "SS", "FF", "SF"] as const;
export type DependencyType = (typeof DEPENDENCY_TYPES)[number];

/**
 * How an activity's percentage complete is measured. Both are PHYSICAL progress reported from
 * site, never earned or certified value (brief §15 G):
 * - physical: the reporter's estimate of the share of the activity's physical work done (0–100 %).
 * - quantity: installed quantity ÷ total quantity in a stated unit (for example m² of blockwork).
 */
export const PROGRESS_BASES = ["physical", "quantity"] as const;
export type ProgressBasis = (typeof PROGRESS_BASES)[number];

/** Where an activity stands, derived from its actual dates. */
export const ACTIVITY_STATUSES = ["not_started", "in_progress", "complete"] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];

/** Causes for the delay log (fixed list; `other` needs the description to explain). */
export const DELAY_CAUSES = [
  "weather",
  "client_instruction",
  "design_information",
  "supplier_material",
  "labour",
  "plant",
  "statutory_permits",
  "site_conditions",
  "late_payment",
  "other",
] as const;
export type DelayCause = (typeof DELAY_CAUSES)[number];

/**
 * The company's own position on a delay, recorded to support a later claim. PM-Buddy makes no
 * legal determination: the contract and the parties (or an adjudicator) decide entitlement.
 * - not_assessed: no position recorded yet.
 * - non_excusable: the contractor's own risk.
 * - excusable: may justify an extension of time.
 * - compensable: may justify an extension of time and additional cost.
 */
export const DELAY_CLAIM_FLAGS = [
  "not_assessed",
  "non_excusable",
  "excusable",
  "compensable",
] as const;
export type DelayClaimFlag = (typeof DELAY_CLAIM_FLAGS)[number];

/** A delay record is versioned: each change appends a version; withdrawal is the last version. */
export const DELAY_STATUSES = ["recorded", "withdrawn"] as const;
export type DelayStatus = (typeof DELAY_STATUSES)[number];

/** The default working week on Kenyan sites: Monday to Saturday (ISO weekdays; a project setting). */
export const DEFAULT_WORKING_WEEKDAYS: readonly IsoWeekday[] = [1, 2, 3, 4, 5, 6];

export const SCHEDULE_LIMITS = {
  /** Tasks per project (milestone markers are not counted). */
  maxActivities: 500,
  maxDependencies: 2000,
  /** Working days. */
  maxDurationDays: 1000,
  /** Negative lag (lead) in working days is allowed down to this value. */
  minLagDays: -60,
  maxLagDays: 365,
  /** Affected activities on one delay record. */
  maxDelayActivities: 50,
  /** Working days lost on one delay record (half days allowed). */
  maxDelayDays: 1000,
  maxBaselines: 50,
} as const;
