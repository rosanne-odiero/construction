import {
  BIOMETRIC_CAPTURE_METHODS,
  BIOMETRIC_GATE_REASONS,
  CONTROLLER_DECISIONS,
  DPIA_APPROVAL_GAPS,
  DPIA_GO_LIVE_CONDITIONS,
  DPIA_LIMITS,
  DPIA_STATES,
  DPIA_STATUSES,
  DPO_OPINIONS,
  PROJECT_STATUSES,
  RESIDUAL_RISK_LEVELS,
} from "@pm-buddy/types";
import { z } from "zod";
import { planningDateSchema } from "./primitives.js";

/**
 * Biometric attendance gate (D3.4 first slice): the company's DPIA records, the signed document,
 * approval with every go-live condition confirmed, and biometric capture switched on per site and
 * method. Requests are strict (a body never carries a tenant ID); responses are strict so the web
 * never trusts an unexpected shape. Dates are Nairobi business dates (YYYY-MM-DD).
 */

const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
const version = z.number().int().min(1).max(2_147_483_647);
const person = z.strictObject({ id: uuid, displayName: z.string() });
const count = z.number().int().min(0);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "invalid_sha256");
const method = z.enum(BIOMETRIC_CAPTURE_METHODS);

const characters = (value: string) => Array.from(value).length;
const printable = (value: string, multiline: boolean) =>
  Array.from(value).every((char) => {
    const code = char.codePointAt(0)!;
    if (multiline && (code === 9 || code === 10 || code === 13)) return true;
    return code >= 32 && !(code >= 127 && code <= 159);
  });
const text = (min: number, max: number, multiline = false) =>
  z
    .string()
    .trim()
    .refine((value) => characters(value) >= min && characters(value) <= max, "length")
    .refine((value) => printable(value, multiline), "control_characters");
/** Optional text: an empty string or null is stored as null. */
const optionalText = (max: number, multiline = false) =>
  z
    .string()
    .trim()
    .refine((value) => characters(value) <= max, "length")
    .refine((value) => printable(value, multiline), "control_characters")
    .transform((value) => (value === "" ? null : value))
    .nullable();
const distinct = <T>(values: readonly T[]) => new Set(values).size === values.length;

export const biometricCaptureMethodSchema = method;
export const dpiaGoLiveConditionSchema = z.enum(DPIA_GO_LIVE_CONDITIONS);

// Requests ---------------------------------------------------------------------------------------

/**
 * Everything a draft records. A draft may be incomplete; dpiaApprovalGaps (packages/domain) lists
 * what still stops approval. Saving replaces every field.
 */
const draftFields = {
  methods: z.array(method).max(BIOMETRIC_CAPTURE_METHODS.length).refine(distinct, "duplicate"),
  siteIds: z.array(uuid).max(DPIA_LIMITS.maxSites).refine(distinct, "duplicate"),
  dpoName: optionalText(DPIA_LIMITS.nameMax),
  dpoOpinion: z.enum(DPO_OPINIONS).nullable(),
  dpoOpinionOn: planningDateSchema.nullable(),
  dpoNote: optionalText(DPIA_LIMITS.noteMax, true),
  controllerName: optionalText(DPIA_LIMITS.nameMax),
  controllerRole: optionalText(DPIA_LIMITS.nameMax),
  controllerDecision: z.enum(CONTROLLER_DECISIONS).nullable(),
  controllerDecisionOn: planningDateSchema.nullable(),
  controllerNote: optionalText(DPIA_LIMITS.noteMax, true),
  residualRisk: z.enum(RESIDUAL_RISK_LEVELS).nullable(),
  odpcReference: optionalText(DPIA_LIMITS.odpcReferenceMax),
};

export const createDpiaRequestSchema = z.strictObject(draftFields);
export type CreateDpiaRequest = z.infer<typeof createDpiaRequestSchema>;

export const updateDpiaRequestSchema = z.strictObject({ ...draftFields, version });
export type UpdateDpiaRequest = z.infer<typeof updateDpiaRequestSchema>;

/**
 * Approval binds to what the approver reviewed: the record's version, the SHA-256 of the signed
 * document they opened, the next review date and every go-live condition confirmed (the API
 * refuses a missing one with 422 conditions-unconfirmed).
 */
export const approveDpiaRequestSchema = z.strictObject({
  version,
  documentSha256: sha256,
  reviewDue: planningDateSchema,
  confirmations: z
    .array(dpiaGoLiveConditionSchema)
    .max(DPIA_GO_LIVE_CONDITIONS.length)
    .refine(distinct, "duplicate"),
});
export type ApproveDpiaRequest = z.infer<typeof approveDpiaRequestSchema>;

const reason = text(DPIA_LIMITS.reasonMin, DPIA_LIMITS.reasonMax, true);

/** Closing a draft as not approved (the controller decided not to proceed). */
export const rejectDpiaRequestSchema = z.strictObject({ version, reason });
export type RejectDpiaRequest = z.infer<typeof rejectDpiaRequestSchema>;

/** Withdrawing the approved DPIA: biometric capture stops on every site at once. */
export const withdrawDpiaRequestSchema = z.strictObject({ version, reason });
export type WithdrawDpiaRequest = z.infer<typeof withdrawDpiaRequestSchema>;

/** Switching biometric capture on or off for one site and method. */
export const biometricSwitchRequestSchema = z.strictObject({
  enabled: z.boolean(),
  reason: optionalText(DPIA_LIMITS.reasonMax, true).optional(),
});
export type BiometricSwitchRequest = z.infer<typeof biometricSwitchRequestSchema>;

// Responses --------------------------------------------------------------------------------------

export const dpiaSummarySchema = z.strictObject({
  id: uuid,
  versionNo: z.number().int().min(1),
  status: z.enum(DPIA_STATUSES),
  /** In force or lapsed for an approved DPIA (Nairobi date), otherwise the status. */
  state: z.enum(DPIA_STATES),
  methods: z.array(method),
  siteCount: count,
  reviewDue: z.iso.date().nullable(),
  approvedAt: timestamp.nullable(),
  approvedBy: person.nullable(),
  createdAt: timestamp,
  createdBy: person,
});
export type DpiaSummary = z.infer<typeof dpiaSummarySchema>;

const scopeSite = z.strictObject({
  id: uuid,
  name: z.string(),
  projectId: uuid,
  projectCode: z.string(),
  projectName: z.string(),
  projectStatus: z.enum(PROJECT_STATUSES),
});

export const dpiaDocumentSchema = z.strictObject({
  id: uuid,
  fileName: z.string(),
  sizeBytes: z.number().int().min(1),
  sha256,
  scanStatus: z.enum(["clean", "not_scanned"]),
  uploadedBy: person,
  uploadedAt: timestamp,
});
export type DpiaDocument = z.infer<typeof dpiaDocumentSchema>;

const closure = z.strictObject({ by: person, at: timestamp, reason: z.string() });

export const dpiaDetailSchema = z.strictObject({
  ...dpiaSummarySchema.shape,
  sites: z.array(scopeSite),
  dpo: z.strictObject({
    name: z.string().nullable(),
    opinion: z.enum(DPO_OPINIONS).nullable(),
    opinionOn: z.iso.date().nullable(),
    note: z.string().nullable(),
  }),
  controller: z.strictObject({
    name: z.string().nullable(),
    role: z.string().nullable(),
    decision: z.enum(CONTROLLER_DECISIONS).nullable(),
    decisionOn: z.iso.date().nullable(),
    note: z.string().nullable(),
  }),
  residualRisk: z.enum(RESIDUAL_RISK_LEVELS).nullable(),
  odpcReference: z.string().nullable(),
  /** The signed DPIA (PDF) the record rests on; earlier uploads to a draft are counted only. */
  document: dpiaDocumentSchema.nullable(),
  replacedDocuments: count,
  approval: z
    .strictObject({
      by: person,
      at: timestamp,
      reviewDue: z.iso.date(),
      conditions: z.array(dpiaGoLiveConditionSchema),
      /** SHA-256 of the approved content (packages/domain dpiaApprovalContent). */
      digest: sha256,
    })
    .nullable(),
  rejection: closure.nullable(),
  withdrawal: closure.nullable(),
  supersession: z
    .strictObject({
      by: z.strictObject({ id: uuid, versionNo: z.number().int().min(1) }),
      at: timestamp,
    })
    .nullable(),
  /** What still stops approval (always empty unless a draft). */
  approvalGaps: z.array(z.enum(DPIA_APPROVAL_GAPS)),
  /** The next review dates an approver may choose today. */
  reviewDueRange: z.strictObject({ earliest: z.iso.date(), latest: z.iso.date() }),
  updatedAt: timestamp,
  updatedBy: person,
  version,
  permissions: z.strictObject({
    canEdit: z.boolean(),
    canApprove: z.boolean(),
    canReject: z.boolean(),
    canWithdraw: z.boolean(),
  }),
});
export type DpiaDetail = z.infer<typeof dpiaDetailSchema>;
export const dpiaResponseSchema = z.strictObject({ dpia: dpiaDetailSchema });
export type DpiaResponse = z.infer<typeof dpiaResponseSchema>;

export const biometricMethodStateSchema = z.strictObject({
  method,
  /** Whether biometric capture may run today (packages/domain biometricGate). */
  on: z.boolean(),
  reason: z.enum(BIOMETRIC_GATE_REASONS).nullable(),
  /** Switched on under the DPIA in force (the switch position, whatever else is off). */
  switchedOn: z.boolean(),
  /** Whether the DPIA in force covers this site and method. */
  inScope: z.boolean(),
  lastChange: z
    .strictObject({
      enabled: z.boolean(),
      at: timestamp,
      by: person,
      carriedForward: z.boolean(),
    })
    .nullable(),
});
export type BiometricMethodState = z.infer<typeof biometricMethodStateSchema>;

export const biometricSiteSchema = z.strictObject({
  ...scopeSite.shape,
  methods: z.array(biometricMethodStateSchema),
});
export type BiometricSite = z.infer<typeof biometricSiteSchema>;

export const biometricsOverviewResponseSchema = z.strictObject({
  today: z.iso.date(),
  /** BIOMETRICS_CAPTURE on this installation (off in production until the go-live gates). */
  platformAvailable: z.boolean(),
  reviewIntervalMonths: z.number().int().min(1),
  /** The approved DPIA, in force or lapsed; null when none was approved or it was withdrawn. */
  current: dpiaSummarySchema.nullable(),
  draft: dpiaSummarySchema.nullable(),
  /** Every version, newest first. */
  history: z.array(dpiaSummarySchema),
  sites: z.array(biometricSiteSchema),
  permissions: z.strictObject({
    canPrepare: z.boolean(),
    canApprove: z.boolean(),
    canSwitchOn: z.boolean(),
    canSwitchOff: z.boolean(),
  }),
});
export type BiometricsOverviewResponse = z.infer<typeof biometricsOverviewResponseSchema>;

export const biometricSwitchResponseSchema = z.strictObject({ site: biometricSiteSchema });
export type BiometricSwitchResponse = z.infer<typeof biometricSwitchResponseSchema>;
