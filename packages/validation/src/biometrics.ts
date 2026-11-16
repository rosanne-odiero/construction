import { methodReads } from "@pm-buddy/domain";
import {
  BIOMETRIC_CAPTURE_METHODS,
  BIOMETRIC_CONSENT_STATUSES,
  BIOMETRIC_DELETION_REASONS,
  BIOMETRIC_ENROLMENT_STATES,
  BIOMETRIC_ENROLMENT_STATUSES,
  BIOMETRIC_GATE_REASONS,
  BIOMETRIC_MODALITIES,
  BIOMETRIC_TEMPLATE_LIMITS,
  CONSENT_METHODS,
  CONSENT_NOTICE_VERSIONS,
  CONTROLLER_DECISIONS,
  DPIA_APPROVAL_GAPS,
  DPIA_GO_LIVE_CONDITIONS,
  DPIA_LIMITS,
  DPIA_STATES,
  DPIA_STATUSES,
  DPO_OPINIONS,
  LABOURER_STATUSES,
  LOCALES,
  PROJECT_STATUSES,
  RESIDUAL_RISK_LEVELS,
} from "@pm-buddy/types";
import { z } from "zod";
import { planningDateSchema } from "./primitives.js";

/**
 * Biometric attendance (D3.4): the company's DPIA records, the signed document, approval with
 * every go-live condition confirmed, biometric capture switched on per site and method, consent
 * per modality, enrolment with templates (accepted, never returned) and the deletion log.
 * Requests are strict (a body never carries a tenant ID); responses are strict so the web never
 * trusts an unexpected shape. Dates are Nairobi business dates (YYYY-MM-DD).
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
/** The DPO's phone as written; 9 to 15 digits. An empty string or null is stored as null. */
const optionalPhone = z
  .string()
  .trim()
  .refine(
    (value) =>
      value === "" ||
      (DPIA_LIMITS.phonePattern.test(value) &&
        value.replace(/\D/g, "").length >= 9 &&
        value.replace(/\D/g, "").length <= 15),
    "phone",
  )
  .transform((value) => (value === "" ? null : value))
  .nullable();

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
  dpoPhone: optionalPhone,
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
    phone: z.string().nullable(),
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

const consentCounts = z.strictObject({ granted: count, refused: count, withdrawn: count });
/** The installation's retention period and whether the deletion job runs in this API. */
const retentionSchema = z.strictObject({
  daysAfterEngagement: z.number().int().min(0),
  jobEnabled: z.boolean(),
});

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
  /** Active enrolments per modality, and how many are held (DPIA lapsed) or due for deletion. */
  enrolments: z.strictObject({
    face: count,
    fingerprint: count,
    held: count,
    deletionDue: count,
  }),
  /**
   * Consent decisions this calendar month (Nairobi) per modality, for the DPO's refusal and
   * withdrawal monitoring (DPIA §7.1).
   */
  consentsThisMonth: z.strictObject({
    month: z.string().regex(/^\d{4}-\d{2}$/),
    face: consentCounts,
    fingerprint: consentCounts,
  }),
  retention: retentionSchema,
  /** Whether a template public key is configured: without one nothing can be enrolled. */
  templateKeyConfigured: z.boolean(),
  permissions: z.strictObject({
    canPrepare: z.boolean(),
    canApprove: z.boolean(),
    canSwitchOn: z.boolean(),
    canSwitchOff: z.boolean(),
    /** Run the retention deletions now and delete templates on a worker's request. */
    canManageTemplates: z.boolean(),
  }),
});
export type BiometricsOverviewResponse = z.infer<typeof biometricsOverviewResponseSchema>;

export const biometricSwitchResponseSchema = z.strictObject({ site: biometricSiteSchema });
export type BiometricSwitchResponse = z.infer<typeof biometricSwitchResponseSchema>;

// Consent, enrolment and deletion (D3.4 second slice) ----------------------------------------------

const modality = z.enum(BIOMETRIC_MODALITIES);
const consentMethod = z.enum(CONSENT_METHODS);
const witnessName = text(3, 120);
export const biometricModalitySchema = modality;

const witnessRule = (
  value: { method: (typeof CONSENT_METHODS)[number]; witnessName?: string | undefined },
  ctx: z.RefinementCtx,
) => {
  if (value.method === "witnessed_verbal" && !value.witnessName)
    ctx.addIssue({ code: "custom", path: ["witnessName"], message: "witness_required" });
};

/**
 * A worker's answer to the biometric notice of one modality, in the language they chose: yes
 * (`granted`) or no (a refusal, recorded with no reason asked). Read aloud needs a witness.
 */
export const recordBiometricConsentRequestSchema = z
  .strictObject({
    modality,
    noticeVersion: z.enum(CONSENT_NOTICE_VERSIONS),
    language: z.enum(LOCALES),
    method: consentMethod,
    witnessName: witnessName.optional(),
    granted: z.boolean(),
  })
  .superRefine(witnessRule);
export type RecordBiometricConsentRequest = z.infer<typeof recordBiometricConsentRequestSchema>;

/** The worker stops: every granted consent of the modality is withdrawn and its templates deleted. */
export const withdrawBiometricConsentRequestSchema = z
  .strictObject({ modality, method: consentMethod, witnessName: witnessName.optional() })
  .superRefine(witnessRule);
export type WithdrawBiometricConsentRequest = z.infer<typeof withdrawBiometricConsentRequestSchema>;

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const decodedLength = (value: string) =>
  (value.length / 4) * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);
/** At most two decimals (NUMERIC(5,2)), allowing for binary floating point: 64.1 × 100 is 6409.999…. */
const twoDecimals = (value: number) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;

/**
 * One template from the capture device, base64: the SDK's face embedding or fingerprint template
 * (never an image: the API refuses image signatures). Quality is the SDK's score on 0–100.
 */
export const biometricTemplateInputSchema = z.strictObject({
  data: z
    .string()
    .max(Math.ceil(BIOMETRIC_TEMPLATE_LIMITS.maxBytes / 3) * 4)
    .regex(BASE64, "base64")
    .refine(
      (value) =>
        decodedLength(value) >= BIOMETRIC_TEMPLATE_LIMITS.minBytes &&
        decodedLength(value) <= BIOMETRIC_TEMPLATE_LIMITS.maxBytes,
      "size",
    ),
  algorithm: z.string().regex(BIOMETRIC_TEMPLATE_LIMITS.algorithmPattern),
  algorithmVersion: z.string().regex(BIOMETRIC_TEMPLATE_LIMITS.algorithmVersionPattern),
  qualityScore: z.number().min(0).max(100).refine(twoDecimals, "two_decimals"),
});
export type BiometricTemplateInput = z.infer<typeof biometricTemplateInputSchema>;

/**
 * An enrolment from a capture device. The client chooses the ID, so a retry returns the same
 * enrolment instead of enrolling twice. The method must read the modality; every template comes
 * from one algorithm and version.
 */
export const enrolBiometricRequestSchema = z
  .strictObject({
    id: uuid,
    labourerId: uuid,
    siteId: uuid,
    method,
    modality,
    templates: z
      .array(biometricTemplateInputSchema)
      .min(1)
      .max(BIOMETRIC_TEMPLATE_LIMITS.maxTemplates),
  })
  .superRefine((value, ctx) => {
    if (!methodReads(value.method, value.modality))
      ctx.addIssue({ code: "custom", path: ["modality"], message: "method_modality" });
    const [first] = value.templates;
    if (
      first &&
      value.templates.some(
        (template) =>
          template.algorithm !== first.algorithm ||
          template.algorithmVersion !== first.algorithmVersion,
      )
    )
      ctx.addIssue({ code: "custom", path: ["templates"], message: "one_algorithm" });
  });
export type EnrolBiometricRequest = z.infer<typeof enrolBiometricRequestSchema>;

/** Deleting an enrolment's templates on the worker's request (a data subject request). */
export const deleteBiometricEnrolmentRequestSchema = z.strictObject({
  reason: z.literal("request"),
});
export type DeleteBiometricEnrolmentRequest = z.infer<typeof deleteBiometricEnrolmentRequestSchema>;

const labourerRef = z.strictObject({ id: uuid, workerNo: z.string(), fullName: z.string() });
const siteRef = z.strictObject({ id: uuid, name: z.string(), projectCode: z.string() });

/** An enrolment's metadata. Templates are never returned, in any form. */
export const biometricEnrolmentSchema = z.strictObject({
  id: uuid,
  labourer: labourerRef,
  modality,
  method,
  site: siteRef,
  status: z.enum(BIOMETRIC_ENROLMENT_STATUSES),
  state: z.enum(BIOMETRIC_ENROLMENT_STATES),
  templates: z.number().int().min(1).max(BIOMETRIC_TEMPLATE_LIMITS.maxTemplates),
  algorithm: z.string(),
  algorithmVersion: z.string(),
  enrolledAt: timestamp,
  enrolledBy: person,
  /** The first day the retention job deletes the templates (null while the worker is engaged). */
  deletionDueOn: z.iso.date().nullable(),
  deletion: z
    .strictObject({
      at: timestamp,
      reason: z.enum(BIOMETRIC_DELETION_REASONS),
      /** Null when the retention job deleted them. */
      by: person.nullable(),
    })
    .nullable(),
});
export type BiometricEnrolment = z.infer<typeof biometricEnrolmentSchema>;

export const biometricEnrolmentResponseSchema = z.strictObject({
  enrolment: biometricEnrolmentSchema,
  /** The previous enrolment of the modality, deleted by this re-enrolment. */
  replaced: uuid.nullable(),
});
export type BiometricEnrolmentResponse = z.infer<typeof biometricEnrolmentResponseSchema>;

/** One entry of the deletion log: who, what and when — never template content. */
export const biometricDeletionSchema = z.strictObject({
  id: uuid,
  enrolmentId: uuid,
  labourer: labourerRef,
  modality,
  reason: z.enum(BIOMETRIC_DELETION_REASONS),
  templates: count,
  deletedAt: timestamp,
  /** Null when the retention job deleted them. */
  deletedBy: person.nullable(),
  /** For a retention deletion, the day it became due. */
  dueOn: z.iso.date().nullable(),
});
export type BiometricDeletion = z.infer<typeof biometricDeletionSchema>;

export const biometricConsentRecordSchema = z.strictObject({
  id: uuid,
  granted: z.boolean(),
  noticeVersion: z.enum(CONSENT_NOTICE_VERSIONS),
  language: z.enum(LOCALES),
  method: consentMethod,
  witnessName: z.string().nullable(),
  capturedAt: timestamp,
  capturedBy: person,
  /** The DPIA version in force when it was recorded (the notice named its DPO and retention). */
  dpiaVersionNo: z.number().int().min(1),
  withdrawnAt: timestamp.nullable(),
  withdrawnBy: person.nullable(),
  withdrawalMethod: consentMethod.nullable(),
});
export type BiometricConsentRecord = z.infer<typeof biometricConsentRecordSchema>;

/** Why biometric consent cannot be recorded for a modality now. */
export const BIOMETRIC_CONSENT_BLOCKS = [
  "platform_off",
  "no_dpia",
  "dpia_lapsed",
  "not_in_scope",
] as const;
export type BiometricConsentBlock = (typeof BIOMETRIC_CONSENT_BLOCKS)[number];

export const workerBiometricsResponseSchema = z.strictObject({
  today: z.iso.date(),
  platformAvailable: z.boolean(),
  retention: retentionSchema,
  labourer: z.strictObject({
    id: uuid,
    workerNo: z.string(),
    fullName: z.string(),
    status: z.enum(LABOURER_STATUSES),
  }),
  company: z.strictObject({ name: z.string() }),
  /** The approved DPIA (in force or lapsed): its DPO and phone fill the notice. */
  dpia: z
    .strictObject({
      id: uuid,
      versionNo: z.number().int().min(1),
      state: z.enum(["in_force", "lapsed"]),
      methods: z.array(method),
      dpoName: z.string().nullable(),
      dpoPhone: z.string().nullable(),
    })
    .nullable(),
  modalities: z.array(
    z.strictObject({
      modality,
      /** Why consent cannot be recorded now (null: it can). Withdrawal is always possible. */
      blocked: z.enum(BIOMETRIC_CONSENT_BLOCKS).nullable(),
      noticeVersion: z.enum(CONSENT_NOTICE_VERSIONS),
      consent: z.strictObject({
        status: z.enum(BIOMETRIC_CONSENT_STATUSES),
        /** Granted to the current notice (enrolment needs this). */
        current: z.boolean(),
      }),
      enrolment: biometricEnrolmentSchema.nullable(),
      decisions: z.array(biometricConsentRecordSchema),
      deletions: z.array(biometricDeletionSchema),
    }),
  ),
  permissions: z.strictObject({
    canConsent: z.boolean(),
    canWithdraw: z.boolean(),
    canDelete: z.boolean(),
  }),
});
export type WorkerBiometricsResponse = z.infer<typeof workerBiometricsResponseSchema>;

export const biometricEnrolmentsResponseSchema = z.strictObject({
  today: z.iso.date(),
  retention: retentionSchema,
  /** Every enrolment that still holds templates (active, held or due for deletion). */
  enrolments: z.array(biometricEnrolmentSchema),
  permissions: z.strictObject({ canManageTemplates: z.boolean() }),
});
export type BiometricEnrolmentsResponse = z.infer<typeof biometricEnrolmentsResponseSchema>;

export const biometricDeletionsResponseSchema = z.strictObject({
  deletions: z.array(biometricDeletionSchema),
});
export type BiometricDeletionsResponse = z.infer<typeof biometricDeletionsResponseSchema>;

export const biometricRetentionRunResponseSchema = z.strictObject({ deleted: count });
export type BiometricRetentionRunResponse = z.infer<typeof biometricRetentionRunResponseSchema>;
