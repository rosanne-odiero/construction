import type { Permission } from "./permissions.js";

/**
 * Health and safety vocabulary (D8.2, brief §5.12 and §15 C/F; ARCHITECTURE §4.8; WORKFLOWS
 * "Health and safety"). The database CHECK constraints and triggers in migration
 * `20261124090000_health_safety` list the same values, so adding one needs a migration as well as
 * a change here. Regulator (DOSH) notification and the registers the Occupational Safety and
 * Health Act 2007 and the Work Injury Benefits Act 2007 require are flagged COMPLIANCE-REVIEW
 * (CR-HS-01 to CR-HS-04): this module records facts and flags reviews; it never decides that a
 * legal duty is met.
 */

/** Who was inducted at a site: a registered labourer, a staff member (user) or a named visitor. */
export const INDUCTION_PERSON_KINDS = ["labourer", "staff", "visitor"] as const;
export type InductionPersonKind = (typeof INDUCTION_PERSON_KINDS)[number];

/** How the inducted person acknowledged the induction. */
export const INDUCTION_ACKNOWLEDGEMENTS = ["signed", "thumbprint", "verbal"] as const;
export type InductionAcknowledgement = (typeof INDUCTION_ACKNOWLEDGEMENTS)[number];

/** Induction records are append-only; a mistake is voided with a reason (never edited). */
export const INDUCTION_STATUSES = ["recorded", "voided"] as const;
export type InductionStatus = (typeof INDUCTION_STATUSES)[number];

/**
 * A labourer's induction at one site: `valid`, `expired` (older than the company's validity
 * period) or `none`.
 */
export const INDUCTION_STATES = ["valid", "expired", "none"] as const;
export type InductionState = (typeof INDUCTION_STATES)[number];

/**
 * The starter induction checklist (company settings may replace it). Starter topics are stored by
 * key and translated on screen; topics a company adds are stored with their own label.
 */
export const STARTER_INDUCTION_TOPICS = [
  "site_rules",
  "emergency_procedures",
  "first_aid",
  "ppe",
  "site_hazards",
  "working_at_height",
  "excavations",
  "electrical_safety",
  "housekeeping",
  "reporting_incidents",
] as const;
export type StarterInductionTopic = (typeof STARTER_INDUCTION_TOPICS)[number];
export type InductionTopic = { key: string; label: string | null };

/** Toolbox talks: draft (attendees being taken) → confirmed (LOCKED), or cancelled with a reason. */
export const TOOLBOX_TALK_STATUSES = ["draft", "confirmed", "cancelled"] as const;
export type ToolboxTalkStatus = (typeof TOOLBOX_TALK_STATUSES)[number];
export const TOOLBOX_TALK_ACTIONS = ["confirm", "cancel"] as const;
export type ToolboxTalkAction = (typeof TOOLBOX_TALK_ACTIONS)[number];

/** Personal protective equipment issued to labourers (a register; see decision D-72). */
export const PPE_ITEMS = [
  "helmet",
  "safety_boots",
  "reflective_vest",
  "gloves",
  "harness",
  "goggles",
  "ear_protection",
  "dust_mask",
  "overalls",
] as const;
export type PpeItem = (typeof PPE_ITEMS)[number];

/**
 * Company default replacement periods in days (CONFIGURATION "Health and safety"). These are
 * planning prompts from typical manufacturer guidance, not legal periods (COMPLIANCE-REVIEW
 * CR-HS-03): damaged or expired equipment is replaced whatever the date says.
 */
export const DEFAULT_PPE_REPLACEMENT_DAYS: Readonly<Record<PpeItem, number>> = {
  helmet: 1095,
  safety_boots: 365,
  reflective_vest: 180,
  gloves: 30,
  harness: 1825,
  goggles: 180,
  ear_protection: 90,
  dust_mask: 7,
  overalls: 365,
};

/** issued → returned (with the condition) | replaced (by a newer issue) | voided (a mistake). */
export const PPE_ISSUE_STATUSES = ["issued", "returned", "replaced", "voided"] as const;
export type PpeIssueStatus = (typeof PPE_ISSUE_STATUSES)[number];
export const PPE_RETURN_CONDITIONS = ["good", "damaged", "lost"] as const;
export type PpeReturnCondition = (typeof PPE_RETURN_CONDITIONS)[number];
/** An issued item's replacement date against today: fine, due within the warning window, due. */
export const PPE_REPLACEMENT_STATES = ["ok", "due_soon", "due"] as const;
export type PpeReplacementState = (typeof PPE_REPLACEMENT_STATES)[number];

/** What happened. A near miss records the potential severity. */
export const INCIDENT_KINDS = [
  "injury",
  "near_miss",
  "property_damage",
  "environmental",
  "dangerous_occurrence",
] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];

/**
 * minor: first aid or less; moderate: medical treatment; serious: lost time, hospitalisation or a
 * major injury; fatal. Serious and fatal injuries, and every dangerous occurrence, need a recorded
 * regulator decision before closing (COMPLIANCE-REVIEW CR-HS-01).
 */
export const INCIDENT_SEVERITIES = ["minor", "moderate", "serious", "fatal"] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

/**
 * reported → investigated (root cause recorded) → closed (LOCKED; every corrective action
 * verified or cancelled), or voided with a reason before closing (a duplicate or a mistake).
 */
export const INCIDENT_STATUSES = ["reported", "investigated", "closed", "voided"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const ROOT_CAUSE_CATEGORIES = [
  "unsafe_act",
  "unsafe_condition",
  "equipment_failure",
  "lack_of_training",
  "lack_of_ppe",
  "procedure_not_followed",
  "supervision",
  "environment",
  "other",
] as const;
export type RootCauseCategory = (typeof ROOT_CAUSE_CATEGORIES)[number];

/** How a person was involved. Injury details are kept to two coded fields (decision D-74). */
export const INCIDENT_PERSON_ROLES = ["injured", "involved", "witness"] as const;
export type IncidentPersonRole = (typeof INCIDENT_PERSON_ROLES)[number];
export const INJURY_TYPES = [
  "cut",
  "bruise",
  "fracture",
  "sprain",
  "burn",
  "eye_injury",
  "crush",
  "electric_shock",
  "other",
] as const;
export type InjuryType = (typeof INJURY_TYPES)[number];
export const BODY_PARTS = [
  "head",
  "eye",
  "face",
  "neck",
  "back",
  "trunk",
  "arm",
  "hand",
  "leg",
  "foot",
  "multiple",
  "other",
] as const;
export type BodyPart = (typeof BODY_PARTS)[number];

/**
 * The company's recorded decision on notifying the regulator (the area occupational safety and
 * health officer, DOSH): notified (date and reference) or not notifiable (with a reason). The
 * deadlines and forms are COMPLIANCE-REVIEW CR-HS-01; the system does not file anything.
 */
export const REGULATOR_DECISIONS = ["notified", "not_notifiable"] as const;
export type RegulatorDecision = (typeof REGULATOR_DECISIONS)[number];
/** Whether a regulator decision is required, recorded, or not needed for this incident. */
export const REGULATOR_STATES = ["not_required", "required", "notified", "not_notifiable"] as const;
export type RegulatorState = (typeof REGULATOR_STATES)[number];

/** Where a corrective action came from. */
export const CORRECTIVE_ACTION_SOURCES = [
  "incident",
  "inspection",
  "toolbox_talk",
  "other",
] as const;
export type CorrectiveActionSource = (typeof CORRECTIVE_ACTION_SOURCES)[number];
/**
 * open → done (by its owner) → verified (by an independent safety.manage holder: never the owner
 * or whoever marked it done); done → open when the verifier rejects it with a reason; open or
 * done → cancelled with a reason. Verified and cancelled actions are final.
 */
export const CORRECTIVE_ACTION_STATUSES = ["open", "done", "verified", "cancelled"] as const;
export type CorrectiveActionStatus = (typeof CORRECTIVE_ACTION_STATUSES)[number];
export const CORRECTIVE_ACTION_ACTIONS = ["done", "verify", "reject", "cancel"] as const;
export type CorrectiveActionAction = (typeof CORRECTIVE_ACTION_ACTIONS)[number];

/** First-aid kits are checked regularly; each check is append-only evidence. */
export const FIRST_AID_KIT_STATUSES = ["active", "retired"] as const;
export type FirstAidKitStatus = (typeof FIRST_AID_KIT_STATUSES)[number];
export const KIT_CHECK_OUTCOMES = ["complete", "restocked", "incomplete"] as const;
export type KitCheckOutcome = (typeof KIT_CHECK_OUTCOMES)[number];
/** A kit against today: fine, contents expiring soon, check overdue, contents expired, never checked. */
export const KIT_STATES = [
  "ok",
  "expiring",
  "check_due",
  "expired",
  "never_checked",
  "retired",
] as const;
export type KitState = (typeof KIT_STATES)[number];

export const FIRST_AIDER_STATUSES = ["active", "removed"] as const;
export type FirstAiderStatus = (typeof FIRST_AIDER_STATUSES)[number];
/** A first-aider's certificate against today. */
export const CERTIFICATE_STATES = ["valid", "expiring", "expired"] as const;
export type CertificateState = (typeof CERTIFICATE_STATES)[number];

export const FIRST_AID_TREATMENTS = [
  "cleaned_dressed",
  "bandaged",
  "eye_wash",
  "cold_compress",
  "burn_dressing",
  "rest_observation",
  "other",
] as const;
export type FirstAidTreatment = (typeof FIRST_AID_TREATMENTS)[number];
export const FIRST_AID_REFERRALS = ["none", "clinic", "hospital"] as const;
export type FirstAidReferral = (typeof FIRST_AID_REFERRALS)[number];
export const TREATMENT_STATUSES = ["recorded", "voided"] as const;
export type TreatmentStatus = (typeof TREATMENT_STATUSES)[number];

/**
 * Company defaults (CONFIGURATION "Health and safety"): inductions do not expire unless the
 * company sets a validity; attendance in the last 14 days is checked for uninducted labourers;
 * kits are checked every 30 days; PPE replacement and first-aid certificates warn 14 and 30 days
 * ahead.
 */
export const DEFAULT_SAFETY_SETTINGS = {
  inductionValidityDays: null,
  inductionLookbackDays: 14,
  kitCheckIntervalDays: 30,
} as const;
export const SAFETY_SETTINGS_LIMITS = {
  inductionValidityDays: { min: 30, max: 1095 },
  inductionLookbackDays: { min: 1, max: 90 },
  kitCheckIntervalDays: { min: 7, max: 180 },
  ppeReplacementDays: { min: 1, max: 3650 },
  inductionTopics: { min: 1, max: 30 },
  topicLabelChars: 120,
} as const;
/** Warning windows (days) for PPE replacement, kit expiry and first-aid certificates. */
export const SAFETY_WARNING_DAYS = { ppe: 14, kitExpiry: 30, certificate: 30 } as const;

/**
 * Who may read the project's health and safety records (on top of `projects.view`): the
 * contractor's site and project staff. Portal-only roles (client, supplier), labourers, and
 * office roles without a site permission (QS, finance, consultant) hold none of these (D-70).
 */
export const SAFETY_READ_PERMISSIONS = [
  "safety.manage",
  "site.diary",
  "projects.manage",
] as const satisfies readonly Permission[];
/**
 * Who may record inductions, toolbox talks, PPE issues and returns, incidents (report), first-aid
 * treatments and kit checks.
 */
export const SAFETY_RECORD_PERMISSIONS = [
  "safety.manage",
  "site.diary",
] as const satisfies readonly Permission[];

export const SAFETY_LIMITS = {
  /** Rows per list page. */
  maxPageSize: 100,
  /** Labourers on one toolbox talk. */
  maxTalkAttendees: 200,
  /** People named on one incident. */
  maxIncidentPeople: 20,
  /** Photos linked to one incident. */
  maxIncidentPhotos: 6,
  maxPpeQuantity: 20,
  maxOtherAttendees: 500,
} as const;
