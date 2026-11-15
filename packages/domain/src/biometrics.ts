import {
  DPIA_REVIEW_INTERVAL_MONTHS,
  type BiometricCaptureMethod,
  type BiometricGateReason,
  type ControllerDecision,
  type DpiaApprovalGap,
  type DpiaState,
  type DpiaStatus,
  type DpoOpinion,
  type ProjectStatus,
  type ResidualRiskLevel,
} from "@pm-buddy/types";
import { addCalendarDays } from "./labour.js";
import { isProjectReadOnly } from "./project-lifecycle.js";
import { addCalendarMonths } from "./quality/completion.js";

/**
 * The biometric attendance gate (D3.4 first slice, DPIA_TEMPLATE §12.4). Pure rules shared by the
 * API, the web app and later the site app; the database checks the same rules in its guards and in
 * app.biometric_capture_allowed. Dates are Africa/Nairobi business dates (YYYY-MM-DD).
 */

/** An approved DPIA is in force up to and including its review date, then lapsed (fail closed). */
export function dpiaState(status: DpiaStatus, reviewDue: string | null, today: string): DpiaState {
  if (status !== "approved") return status;
  return reviewDue !== null && reviewDue >= today ? "in_force" : "lapsed";
}

/**
 * The next review date an approver may choose: after today and at most
 * DPIA_REVIEW_INTERVAL_MONTHS calendar months ahead (clamped to the end of a shorter month, as
 * PostgreSQL's `date + interval '12 months'`).
 */
export function dpiaReviewDueRange(
  today: string,
  months: number = DPIA_REVIEW_INTERVAL_MONTHS,
): { earliest: string; latest: string } {
  return { earliest: addCalendarDays(today, 1), latest: addCalendarMonths(today, months) };
}

export function isDpiaReviewDueValid(reviewDue: string, today: string): boolean {
  const { earliest, latest } = dpiaReviewDueRange(today);
  return reviewDue >= earliest && reviewDue <= latest;
}

/** What a draft records (the signed document is checked separately by its presence). */
export type DpiaDraftFacts = {
  hasDocument: boolean;
  methods: readonly BiometricCaptureMethod[];
  siteCount: number;
  dpoName: string | null;
  dpoOpinion: DpoOpinion | null;
  dpoOpinionOn: string | null;
  dpoNote: string | null;
  controllerName: string | null;
  controllerDecision: ControllerDecision | null;
  controllerDecisionOn: string | null;
  controllerNote: string | null;
  residualRisk: ResidualRiskLevel | null;
  odpcReference: string | null;
};

/**
 * Everything that still stops a draft from being approved, in a fixed order (empty when it can be
 * approved). A DPO rejection or a controller's decision not to proceed can be recorded but never
 * approved; "with conditions" needs the conditions written down; a high residual risk needs the
 * ODPC prior consultation reference (decision D-162, COMPLIANCE-REVIEW CR-DP-02); signatures are
 * never dated in the future.
 */
export function dpiaApprovalGaps(facts: DpiaDraftFacts, today: string): DpiaApprovalGap[] {
  const gaps: DpiaApprovalGap[] = [];
  if (!facts.hasDocument) gaps.push("document");
  if (facts.methods.length === 0) gaps.push("methods");
  if (facts.siteCount === 0) gaps.push("sites");
  if (!facts.dpoName || !facts.dpoOpinion || !facts.dpoOpinionOn) gaps.push("dpo");
  if (facts.dpoOpinion === "reject") gaps.push("dpo_rejected");
  if (facts.dpoOpinion === "approve_with_conditions" && !facts.dpoNote) gaps.push("dpo_conditions");
  if (!facts.controllerName || !facts.controllerDecision || !facts.controllerDecisionOn)
    gaps.push("controller");
  if (facts.controllerDecision === "do_not_proceed") gaps.push("controller_declined");
  if (facts.controllerDecision === "proceed_with_conditions" && !facts.controllerNote)
    gaps.push("controller_conditions");
  if (
    (facts.dpoOpinionOn !== null && facts.dpoOpinionOn > today) ||
    (facts.controllerDecisionOn !== null && facts.controllerDecisionOn > today)
  )
    gaps.push("signature_dates");
  if (!facts.residualRisk) gaps.push("residual_risk");
  if (facts.residualRisk === "high" && !facts.odpcReference) gaps.push("odpc_consultation");
  return gaps;
}

/** The company's approved DPIA (in force or lapsed by date), as the gate sees it. */
export type ApprovedDpia = {
  id: string;
  reviewDue: string;
  methods: readonly BiometricCaptureMethod[];
  siteIds: readonly string[];
};

export const dpiaCovers = (
  dpia: Pick<ApprovedDpia, "methods" | "siteIds">,
  siteId: string,
  method: BiometricCaptureMethod,
): boolean => dpia.methods.includes(method) && dpia.siteIds.includes(siteId);

/** The latest switch recorded for a site and method. */
export type BiometricSwitchFact = { enabled: boolean; dpiaRecordId: string | null };

export type BiometricGateInput = {
  /** BIOMETRICS_CAPTURE on this installation (always off in production for now, decision D-163). */
  platformAvailable: boolean;
  projectStatus: ProjectStatus;
  approved: ApprovedDpia | null;
  latestSwitch: BiometricSwitchFact | null;
  siteId: string;
  method: BiometricCaptureMethod;
  today: string;
};

export type BiometricGate = { on: true; reason: null } | { on: false; reason: BiometricGateReason };

/**
 * Whether biometric capture may run for a site and method today, or the first reason it may not
 * (BIOMETRIC_GATE_REASONS order). A switch counts only under the DPIA in force: switches made under
 * a withdrawn or superseded DPIA stay off until switched on again (a renewal carries covered
 * switches forward when it is approved, see carriedForwardSwitches).
 */
export function biometricGate(input: BiometricGateInput): BiometricGate {
  const off = (reason: BiometricGateReason): BiometricGate => ({ on: false, reason });
  if (!input.platformAvailable) return off("platform_off");
  if (isProjectReadOnly(input.projectStatus)) return off("project_closed");
  if (!input.approved) return off("no_dpia");
  if (input.approved.reviewDue < input.today) return off("dpia_lapsed");
  if (!dpiaCovers(input.approved, input.siteId, input.method)) return off("not_in_scope");
  if (!input.latestSwitch?.enabled || input.latestSwitch.dpiaRecordId !== input.approved.id)
    return off("switched_off");
  return { on: true, reason: null };
}

/** Whether the switch for a site and method is on under the DPIA in force (ignoring dates). */
export const switchedOnUnder = (
  latest: BiometricSwitchFact | null,
  approved: Pick<ApprovedDpia, "id"> | null,
): boolean => Boolean(latest?.enabled && approved && latest.dpiaRecordId === approved.id);

export type SwitchCandidate = BiometricSwitchFact & {
  siteId: string;
  method: BiometricCaptureMethod;
  projectStatus: ProjectStatus;
};

/**
 * Approving a renewal keeps biometric capture on where it was on under the DPIA being superseded
 * (in force or lapsed) and the renewal still covers the site and method (owner decision,
 * 15 November 2026). Switches on closed or cancelled projects are not carried forward.
 */
export function carriedForwardSwitches(
  latest: readonly SwitchCandidate[],
  supersededId: string,
  renewal: Pick<ApprovedDpia, "methods" | "siteIds">,
): { siteId: string; method: BiometricCaptureMethod }[] {
  return latest
    .filter(
      (entry) =>
        entry.enabled &&
        entry.dpiaRecordId === supersededId &&
        !isProjectReadOnly(entry.projectStatus) &&
        dpiaCovers(renewal, entry.siteId, entry.method),
    )
    .map(({ siteId, method }) => ({ siteId, method }));
}

/**
 * The content an approval is bound to (hashed by the API into `approved_digest`): every field the
 * approver saw, the signed document's SHA-256, the review date and the confirmed conditions, with
 * lists sorted so the digest does not depend on input order.
 */
export function dpiaApprovalContent(
  input: Omit<DpiaDraftFacts, "hasDocument" | "siteCount"> & {
    versionNo: number;
    siteIds: readonly string[];
    controllerRole: string | null;
    documentSha256: string;
    reviewDue: string;
    conditions: readonly string[];
  },
): Record<string, unknown> {
  return {
    versionNo: input.versionNo,
    methods: [...input.methods].sort(),
    siteIds: [...input.siteIds].sort(),
    dpo: {
      name: input.dpoName,
      opinion: input.dpoOpinion,
      opinionOn: input.dpoOpinionOn,
      note: input.dpoNote,
    },
    controller: {
      name: input.controllerName,
      role: input.controllerRole,
      decision: input.controllerDecision,
      decisionOn: input.controllerDecisionOn,
      note: input.controllerNote,
    },
    residualRisk: input.residualRisk,
    odpcReference: input.odpcReference,
    documentSha256: input.documentSha256,
    reviewDue: input.reviewDue,
    conditions: [...input.conditions].sort(),
  };
}
