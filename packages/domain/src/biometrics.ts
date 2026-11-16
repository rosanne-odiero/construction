import {
  DPIA_REVIEW_INTERVAL_MONTHS,
  MODALITY_METHODS,
  type BiometricCaptureMethod,
  type BiometricConsentStatus,
  type BiometricEnrolmentState,
  type BiometricEnrolmentStatus,
  type BiometricGateReason,
  type BiometricModality,
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
 * Biometric attendance (D3.4, DPIA_TEMPLATE §7, §8, §12.4): the DPIA gate, consent per modality,
 * enrolment states and template retention. Pure rules shared by the API, the web app and later the
 * site app; the database checks the same rules in its guards, in app.biometric_capture_allowed and
 * in app.biometric_retention_due_on. Dates are Africa/Nairobi business dates (YYYY-MM-DD).
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
  /** How workers reach the DPO: the consent notice tells them to call or SMS this number. */
  dpoPhone: string | null;
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
  if (!facts.dpoPhone) gaps.push("dpo_phone");
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
      phone: input.dpoPhone,
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

/** Whether DPIA methods cover a modality: a face or fingerprint method, or a terminal (either). */
export const coversModality = (
  methods: readonly BiometricCaptureMethod[],
  modality: BiometricModality,
): boolean => MODALITY_METHODS[modality].some((method) => methods.includes(method));

/** Whether a capture method can read a modality (a terminal reads either). */
export const methodReads = (method: BiometricCaptureMethod, modality: BiometricModality): boolean =>
  MODALITY_METHODS[modality].includes(method);

/** One recorded biometric consent decision of a worker for one modality. */
export type BiometricConsentFact = {
  granted: boolean;
  noticeVersion: string;
  /** ISO timestamp (Date#toISOString), so decisions sort as text. */
  capturedAt: string;
  withdrawnAt: string | null;
};

/**
 * A worker's consent for one modality (DPIA §7.1): granted while a granted consent is not
 * withdrawn (current when one is to the current notice); otherwise the latest decision — refused
 * or withdrawn — or none.
 */
export function biometricConsentStatus(
  consents: readonly BiometricConsentFact[],
  currentNoticeVersion: string,
): { status: BiometricConsentStatus; current: boolean } {
  const active = consents.filter((consent) => consent.granted && !consent.withdrawnAt);
  if (active.length)
    return {
      status: "granted",
      current: active.some((consent) => consent.noticeVersion === currentNoticeVersion),
    };
  const latest = [...consents].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))[0];
  if (!latest) return { status: "none", current: false };
  return { status: latest.granted ? "withdrawn" : "refused", current: false };
}

/** A worker's engagement in the company (any project). */
export type EngagementFact = { startDate: string; endDate: string | null };

/**
 * The first day a worker's biometric templates are due for deletion (DPIA §8): `retentionDays`
 * full days after the last day of their last engagement in the company, once no engagement is open
 * (or ends today or later); null while engaged. Without any engagement there is nothing to keep
 * them for: due today. The database computes the same date (app.biometric_retention_due_on).
 */
export function retentionDueOn(
  engagements: readonly EngagementFact[],
  retentionDays: number,
  today: string,
): string | null {
  if (engagements.some((engagement) => engagement.endDate === null || engagement.endDate >= today))
    return null;
  const lastEnd = engagements.reduce<string | null>(
    (latest, engagement) =>
      latest === null || engagement.endDate! > latest ? engagement.endDate : latest,
    null,
  );
  return lastEnd === null ? today : addCalendarDays(lastEnd, retentionDays + 1);
}

/**
 * What the app shows for an enrolment: deleted; due for deletion (the retention date has come, or
 * no approved DPIA covers its modality any more); held — kept but unusable — while the DPIA has
 * lapsed (decision D-170); otherwise active.
 */
export function enrolmentState(input: {
  status: BiometricEnrolmentStatus;
  /** The company's approved DPIA: whether it covers the enrolment's modality and is in force. */
  approved: { covers: boolean; inForce: boolean } | null;
  dueOn: string | null;
  today: string;
}): BiometricEnrolmentState {
  if (input.status === "deleted") return "deleted";
  if (!input.approved?.covers || (input.dueOn !== null && input.dueOn <= input.today))
    return "deletion_due";
  return input.approved.inForce ? "active" : "held";
}

type Signature = { offset: number; bytes: readonly number[] };
const ascii = (text: string) => Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
/**
 * Image and image-record signatures a template must never start with (DPIA §2.1: templates only,
 * raw images are never stored or uploaded). ISO/IEC 19794-2 minutiae records ("FMR") are templates
 * and pass; finger and face image records ("FIR", "FAC") do not.
 */
const IMAGE_SIGNATURES: readonly (readonly Signature[])[] = [
  [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }], // JPEG
  [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }], // PNG
  [{ offset: 0, bytes: ascii("GIF8") }],
  [
    { offset: 0, bytes: ascii("BM") },
    { offset: 6, bytes: [0, 0, 0, 0] },
  ], // BMP (reserved bytes are zero)
  [{ offset: 0, bytes: [0x49, 0x49, 0x2a, 0x00] }], // TIFF, little-endian
  [{ offset: 0, bytes: [0x4d, 0x4d, 0x00, 0x2a] }], // TIFF, big-endian
  [
    { offset: 0, bytes: ascii("RIFF") },
    { offset: 8, bytes: ascii("WEBP") },
  ],
  [{ offset: 4, bytes: ascii("ftyp") }], // HEIC, AVIF and other ISO media files
  [{ offset: 0, bytes: [0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20] }], // JPEG 2000
  [{ offset: 0, bytes: [0xff, 0x4f, 0xff, 0x51] }], // JPEG 2000 codestream
  [{ offset: 0, bytes: [0xff, 0xa0, 0xff] }], // WSQ fingerprint image
  ...["P2", "P5", "P3", "P6"].flatMap((magic) =>
    [0x0a, 0x0d, 0x20, 0x09].map((space) => [{ offset: 0, bytes: [...ascii(magic), space] }]),
  ), // PGM, PPM
  [{ offset: 0, bytes: [...ascii("FIR"), 0] }], // ISO/IEC 19794-4 finger image record
  [{ offset: 0, bytes: [...ascii("FAC"), 0] }], // ISO/IEC 19794-5 face image record
];

/** True when bytes start like an image or an image record rather than a template. */
export function looksLikeImage(bytes: Uint8Array): boolean {
  return IMAGE_SIGNATURES.some((parts) =>
    parts.every(({ offset, bytes: expected }) =>
      expected.every((byte, index) => bytes[offset + index] === byte),
    ),
  );
}

/**
 * The company name in a consent confirmation SMS, cut to fit one 160-character segment (DPIA §7.4)
 * without a non-GSM ellipsis.
 */
export const smsCompanyName = (name: string, max = 20): string =>
  name.length > max ? name.slice(0, max).trimEnd() : name;
