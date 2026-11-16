/**
 * Biometric attendance (D3.4; DPIA_TEMPLATE §7, §8, §12.4, ARCHITECTURE §4.19). Each company, as
 * data controller, records its own DPIA for biometric attendance in the app: the signed
 * document, the DPO's opinion, the controller's decision, the capture methods and sites in scope
 * and the next review date. Biometric capture can be switched on only per site and method, only
 * while an approved DPIA covering them is in force, and only where the installation allows it
 * (`BIOMETRICS_CAPTURE`). Everything fails closed: a lapsed, withdrawn or superseded DPIA stops
 * biometric capture at once; the card, photo and supervisor fallback is never affected.
 *
 * Under an approved DPIA, each worker gives (or refuses) consent separately per modality; an
 * enrolment stores templates only, sealed to a biometrics-only key the API cannot open; and
 * templates are deleted on withdrawal, on request, when the DPIA is withdrawn or stops covering
 * the modality, and a set number of days after the worker's last engagement ends.
 */
import type { CaptureMethod } from "./attendance.js";
import type { ConsentKind } from "./labour.js";

/** The biometric capture methods (the reserved ones in CAPTURE_METHODS). */
export const BIOMETRIC_CAPTURE_METHODS = [
  "face",
  "fingerprint",
  "terminal",
] as const satisfies readonly CaptureMethod[];
export type BiometricCaptureMethod = (typeof BIOMETRIC_CAPTURE_METHODS)[number];
export const isBiometricCaptureMethod = (value: string): value is BiometricCaptureMethod =>
  (BIOMETRIC_CAPTURE_METHODS as readonly string[]).includes(value);

/**
 * Stored DPIA statuses. A draft is approved (then later superseded by a renewal or withdrawn) or
 * closed as not approved (`rejected`); the last three are final.
 */
export const DPIA_STATUSES = ["draft", "approved", "rejected", "superseded", "withdrawn"] as const;
export type DpiaStatus = (typeof DPIA_STATUSES)[number];

/**
 * What the app shows: an approved DPIA is in force until the end of its review date (Africa/Nairobi)
 * and lapsed after it. Lapsing is computed on read, never stored.
 */
export const DPIA_STATES = [
  "draft",
  "in_force",
  "lapsed",
  "rejected",
  "superseded",
  "withdrawn",
] as const;
export type DpiaState = (typeof DPIA_STATES)[number];

/** DPIA §12.2: the DPO's opinion. A DPO rejection blocks approval in the app (decision D-162). */
export const DPO_OPINIONS = ["approve", "approve_with_conditions", "reject"] as const;
export type DpoOpinion = (typeof DPO_OPINIONS)[number];

/** DPIA §12.2: the controller's decision. */
export const CONTROLLER_DECISIONS = [
  "proceed",
  "proceed_with_conditions",
  "do_not_proceed",
] as const;
export type ControllerDecision = (typeof CONTROLLER_DECISIONS)[number];

/**
 * DPIA §12.1: the residual risk after the measures. A high residual risk needs the reference of
 * the ODPC prior consultation before approval (COMPLIANCE-REVIEW CR-DP-02, decision D-162).
 */
export const RESIDUAL_RISK_LEVELS = ["low", "medium", "high"] as const;
export type ResidualRiskLevel = (typeof RESIDUAL_RISK_LEVELS)[number];

/**
 * DPIA §12.3 conditions before go-live, each confirmed by the approver. The next review date
 * (the template's last condition) is a required field of the approval instead.
 */
export const DPIA_GO_LIVE_CONDITIONS = [
  "fallback_ready",
  "accuracy_tested",
  "vendor_assessed",
  "notices_reviewed",
  "staff_trained",
  "retention_set",
  "hosting_recorded",
  "odpc_registered",
] as const;
export type DpiaGoLiveCondition = (typeof DPIA_GO_LIVE_CONDITIONS)[number];

/**
 * What still stops a draft from being approved (packages/domain dpiaApprovalGaps). The database
 * guard checks the same rules again.
 */
export const DPIA_APPROVAL_GAPS = [
  "document",
  "methods",
  "sites",
  "dpo",
  "dpo_phone",
  "dpo_rejected",
  "dpo_conditions",
  "controller",
  "controller_declined",
  "controller_conditions",
  "signature_dates",
  "residual_risk",
  "odpc_consultation",
] as const;
export type DpiaApprovalGap = (typeof DPIA_APPROVAL_GAPS)[number];

/**
 * Why biometric capture is off for a site and method: the first check that fails, in this order.
 * `switched_off` means everything allows it but nobody has switched it on (or it was switched off).
 */
export const BIOMETRIC_GATE_REASONS = [
  "platform_off",
  "project_closed",
  "no_dpia",
  "dpia_lapsed",
  "not_in_scope",
  "switched_off",
] as const;
export type BiometricGateReason = (typeof BIOMETRIC_GATE_REASONS)[number];

/**
 * `dp.dpia_review_interval_months` (CONFIGURATION §3, DPIA §13): the next review date is at most
 * this many months after the approval. Fixed for every company in this slice; the database guard
 * uses the same value.
 */
export const DPIA_REVIEW_INTERVAL_MONTHS = 12;

export const DPIA_LIMITS = {
  nameMax: 120,
  noteMax: 2000,
  odpcReferenceMax: 80,
  reasonMin: 10,
  reasonMax: 500,
  maxSites: 200,
  /** The DPO's phone number as written (digits, spaces, hyphens, an optional leading +). */
  phonePattern: /^\+?[0-9][0-9 -]{7,18}[0-9]$/,
} as const;

/** What is read from the worker. A terminal reads one of the two. */
export const BIOMETRIC_MODALITIES = ["face", "fingerprint"] as const;
export type BiometricModality = (typeof BIOMETRIC_MODALITIES)[number];

/** The capture methods that read each modality: a DPIA covering one of them covers the modality. */
export const MODALITY_METHODS: Readonly<
  Record<BiometricModality, readonly BiometricCaptureMethod[]>
> = {
  face: ["face", "terminal"],
  fingerprint: ["fingerprint", "terminal"],
};

/** Separate consent per modality (DPIA §7.1). */
export const BIOMETRIC_CONSENT_KINDS = {
  face: "biometric_face",
  fingerprint: "biometric_fingerprint",
} as const satisfies Record<BiometricModality, ConsentKind>;
export type BiometricConsentKind = (typeof BIOMETRIC_CONSENT_KINDS)[BiometricModality];

/**
 * A worker's biometric consent for one modality: `granted` while a granted consent is not
 * withdrawn; otherwise the latest decision: `refused` (recorded as granted = false, no reason
 * asked) or `withdrawn`; `none` before any decision.
 */
export const BIOMETRIC_CONSENT_STATUSES = ["none", "granted", "refused", "withdrawn"] as const;
export type BiometricConsentStatus = (typeof BIOMETRIC_CONSENT_STATUSES)[number];

/** Stored enrolment statuses: a deleted enrolment keeps its metadata, never its templates. */
export const BIOMETRIC_ENROLMENT_STATUSES = ["active", "deleted"] as const;
export type BiometricEnrolmentStatus = (typeof BIOMETRIC_ENROLMENT_STATUSES)[number];

/**
 * What the app shows for an enrolment: `held` = kept but unusable because the DPIA has lapsed
 * (decision D-170); `deletion_due` = the retention period has passed and the deletion job has not
 * run yet.
 */
export const BIOMETRIC_ENROLMENT_STATES = ["active", "held", "deletion_due", "deleted"] as const;
export type BiometricEnrolmentState = (typeof BIOMETRIC_ENROLMENT_STATES)[number];

/** Why an enrolment's templates were deleted (the deletion log, DPIA §8). */
export const BIOMETRIC_DELETION_REASONS = [
  "consent_withdrawn",
  "re_enrolled",
  "engagement_ended",
  "dpia_withdrawn",
  "out_of_scope",
  "request",
] as const;
export type BiometricDeletionReason = (typeof BIOMETRIC_DELETION_REASONS)[number];

/**
 * Templates from the capture device: opaque bytes (an SDK's face embedding or fingerprint
 * template), never images. At most `maxTemplates` per enrolment (several fingers or samples).
 */
export const BIOMETRIC_TEMPLATE_LIMITS = {
  maxTemplates: 10,
  minBytes: 16,
  maxBytes: 16_384,
  algorithmPattern: /^[A-Za-z0-9][A-Za-z0-9 ._+-]{1,59}$/,
  algorithmVersionPattern: /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,39}$/,
} as const;

/**
 * `biometrics.retention_days_after_engagement` (CONFIGURATION §3): one installation-wide value
 * (`BIOMETRICS_RETENTION_DAYS_AFTER_ENGAGEMENT`; owner's choice, 16 November 2026). Templates are
 * deleted this many days after the end of the worker's last engagement in the company.
 * COMPLIANCE-REVIEW CR-DP-06: the default is a placeholder until an adviser sets the period.
 */
export const BIOMETRIC_RETENTION_DAYS = { default: 30, min: 0, max: 365 } as const;

/** The retention job: how often it looks for due deletions, and how many it takes per run. */
export const BIOMETRIC_JOB = { intervalMinutes: 60, firstRunDelaySeconds: 60, batch: 500 } as const;

/**
 * The retention job acts as this fixed system actor (audit events need an actor), never as a
 * user. It is not a user row and holds no permissions.
 */
export const BIOMETRICS_SYSTEM_ACTOR = "00000000-0000-4000-8000-00000000d340";
