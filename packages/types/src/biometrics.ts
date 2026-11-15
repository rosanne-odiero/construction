/**
 * Biometric attendance gate (D3.4 first slice; DPIA_TEMPLATE §12.4, ARCHITECTURE §4.17). Each
 * company, as data controller, records its own DPIA for biometric attendance in the app: the signed
 * document, the DPO's opinion, the controller's decision, the capture methods and sites in scope
 * and the next review date. Biometric capture can be switched on only per site and method, only
 * while an approved DPIA covering them is in force, and only where the installation allows it
 * (`BIOMETRICS_CAPTURE`). Everything fails closed: a lapsed, withdrawn or superseded DPIA stops
 * biometric capture at once; the card, photo and supervisor fallback is never affected.
 */
import type { CaptureMethod } from "./attendance.js";

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
} as const;
