import { REVISION_PATTERN } from "@pm-buddy/domain";
import {
  APPROVAL_CHANNELS,
  APPROVAL_DECISIONS,
  APPROVAL_REQUEST_KINDS,
  APPROVAL_STATUSES,
  COMPLIANCE_LIMITS,
  COMPLIANCE_RECORD_KINDS,
  COMPLIANCE_RECORD_STATES,
  COMPLIANCE_SCOPES,
  COMPLIANCE_STATUSES,
  DOCUMENT_CATEGORIES,
  DOCUMENT_CONTENT_TYPES,
  DOCUMENT_LIMITS,
  DOCUMENT_REMINDER_KINDS,
  DOCUMENT_STATUSES,
  DRAWING_DISCIPLINES,
  INSTRUCTION_ATTACHMENT_KINDS,
  INSTRUCTION_ISSUER_ROLES,
  INSTRUCTION_KINDS,
  INSTRUCTION_LIFECYCLE,
  INSTRUCTION_RESPONSE_KINDS,
  ISSUE_PURPOSES,
  VERSION_STATES,
} from "@pm-buddy/types";
import { z } from "zod";
import { planningDateSchema } from "./primitives.js";

/**
 * Documents and the compliance register (D8.4): versioned project documents, compliance items
 * with derived statuses, the consultant instructions log and approval requests. Requests are
 * strict (a body never carries a tenant ID); responses are strict so the web never trusts an
 * unexpected shape. Dates are Nairobi business dates (YYYY-MM-DD). Upload fields arrive as
 * multipart text, so empty strings mean "not given".
 */

const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
const version = z.number().int().min(1).max(2_147_483_647);
const person = z.strictObject({ id: uuid, displayName: z.string() });
const count = z.number().int().min(0);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "invalid_sha256");

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
/** Optional text: an empty string is stored as null. */
const optionalText = (max: number, multiline = false) =>
  z
    .string()
    .trim()
    .refine((value) => characters(value) <= max, "length")
    .refine((value) => printable(value, multiline), "control_characters")
    .transform((value) => (value === "" ? null : value))
    .nullable();
/** A multipart text field: missing or empty → undefined. */
const field = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === "" || value === null ? undefined : value), schema.optional());
const reason = text(3, 500, true);
const search = z.string().trim().max(100).optional();
const offsetCursor = z.coerce.number().int().min(0).max(100_000).optional();
const limit = z.coerce.number().int().min(1).max(DOCUMENT_LIMITS.maxPageSize).default(30);

export const documentCategorySchema = z.enum(DOCUMENT_CATEGORIES);
export const drawingDisciplineSchema = z.enum(DRAWING_DISCIPLINES);
export const issuePurposeSchema = z.enum(ISSUE_PURPOSES);
export const complianceStatusSchema = z.enum(COMPLIANCE_STATUSES);
export const instructionKindSchema = z.enum(INSTRUCTION_KINDS);
export const instructionLifecycleSchema = z.enum(INSTRUCTION_LIFECYCLE);
export const approvalStatusSchema = z.enum(APPROVAL_STATUSES);

/** A revision label as on the drawing: 1–10 of letters, digits, "." and "-". */
export const revisionSchema = z.string().trim().regex(REVISION_PATTERN, "invalid_revision");
/** A drawing number: 1–40 of letters, digits, space and "./_-()". */
export const drawingNumberSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ./_()-]{0,39}$/, "invalid_drawing_number");

// Documents --------------------------------------------------------------------------------------

/** Text fields sent with a new document's first file (multipart). */
export const createDocumentFieldsSchema = z
  .strictObject({
    category: documentCategorySchema,
    title: text(3, 200),
    drawingNumber: field(drawingNumberSchema),
    discipline: field(drawingDisciplineSchema),
    reference: field(text(1, 80)),
    revision: revisionSchema,
    issuePurpose: field(issuePurposeSchema),
    changeNote: field(text(3, 1000, true)),
  })
  .superRefine((value, ctx) => {
    const drawing = value.category === "drawing";
    if (drawing && !value.drawingNumber)
      ctx.addIssue({ code: "custom", path: ["drawingNumber"], message: "required" });
    if (drawing && !value.discipline)
      ctx.addIssue({ code: "custom", path: ["discipline"], message: "required" });
    if (!drawing && (value.drawingNumber || value.discipline))
      ctx.addIssue({ code: "custom", path: ["drawingNumber"], message: "drawings_only" });
  });
export type CreateDocumentFields = z.infer<typeof createDocumentFieldsSchema>;

/** Text fields sent with a new version (multipart). `basedOnVersionId` is the current version seen. */
export const newVersionFieldsSchema = z.strictObject({
  revision: revisionSchema,
  issuePurpose: field(issuePurposeSchema),
  changeNote: text(3, 1000, true),
  basedOnVersionId: uuid,
});
export type NewVersionFields = z.infer<typeof newVersionFieldsSchema>;

export const updateDocumentRequestSchema = z.strictObject({
  title: text(3, 200).optional(),
  drawingNumber: drawingNumberSchema.optional(),
  discipline: drawingDisciplineSchema.optional(),
  reference: optionalText(80).optional(),
  version,
});
export type UpdateDocumentRequest = z.infer<typeof updateDocumentRequestSchema>;

export const withdrawDocumentRequestSchema = z.strictObject({ reason, version });
export type WithdrawDocumentRequest = z.infer<typeof withdrawDocumentRequestSchema>;

export const documentListQuerySchema = z.strictObject({
  category: documentCategorySchema.optional(),
  discipline: drawingDisciplineSchema.optional(),
  status: z.enum([...DOCUMENT_STATUSES, "all"]).default("active"),
  search,
  cursor: offsetCursor,
  limit,
});
export type DocumentListQuery = z.infer<typeof documentListQuerySchema>;

export const drawingRegisterQuerySchema = z.strictObject({
  discipline: drawingDisciplineSchema.optional(),
  search,
});
export type DrawingRegisterQuery = z.infer<typeof drawingRegisterQuerySchema>;

const versionApproval = z.strictObject({
  id: uuid,
  code: z.string(),
  status: approvalStatusSchema,
});

export const documentVersionSchema = z.strictObject({
  id: uuid,
  versionNo: z.number().int().min(1).max(DOCUMENT_LIMITS.maxVersionsPerDocument),
  revision: z.string(),
  issuePurpose: issuePurposeSchema.nullable(),
  changeNote: z.string().nullable(),
  fileName: z.string(),
  contentType: z.enum(DOCUMENT_CONTENT_TYPES),
  sizeBytes: z.number().int().min(1),
  sha256,
  scanStatus: z.enum(["clean", "not_scanned"]),
  uploadedBy: person,
  uploadedAt: timestamp,
  /** Exactly one version is current; every earlier one is superseded (and labelled so). */
  state: z.enum(VERSION_STATES),
  supersededAt: timestamp.nullable(),
  supersededBy: z.strictObject({ id: uuid, revision: z.string() }).nullable(),
  /** The latest approval request on this version, if any. */
  approval: versionApproval.nullable(),
});
export type DocumentVersion = z.infer<typeof documentVersionSchema>;

const currentVersion = z.strictObject({
  id: uuid,
  versionNo: z.number().int().min(1),
  revision: z.string(),
  issuePurpose: issuePurposeSchema.nullable(),
  fileName: z.string(),
  contentType: z.enum(DOCUMENT_CONTENT_TYPES),
  sizeBytes: z.number().int().min(1),
  uploadedBy: person,
  uploadedAt: timestamp,
  state: z.literal("current"),
  approval: versionApproval.nullable(),
});

export const documentSummarySchema = z.strictObject({
  id: uuid,
  projectId: uuid,
  category: documentCategorySchema,
  title: z.string(),
  drawingNumber: z.string().nullable(),
  discipline: drawingDisciplineSchema.nullable(),
  reference: z.string().nullable(),
  status: z.enum(DOCUMENT_STATUSES),
  confidential: z.boolean(),
  current: currentVersion,
  versionCount: count,
  updatedAt: timestamp,
  version,
});
export type DocumentSummary = z.infer<typeof documentSummarySchema>;

export const documentPermissionsSchema = z.strictObject({
  canUpload: z.boolean(),
  canEdit: z.boolean(),
  canWithdraw: z.boolean(),
  canRaiseApproval: z.boolean(),
});

export const documentDetailSchema = z.strictObject({
  ...documentSummarySchema.shape,
  versions: z.array(documentVersionSchema),
  createdBy: person,
  createdAt: timestamp,
  withdrawal: z.strictObject({ by: person, at: timestamp, reason: z.string() }).nullable(),
  /** The suggestion for the next revision label (packages/domain suggestNextRevision). */
  nextRevision: z.string(),
  permissions: documentPermissionsSchema,
});
export type DocumentDetail = z.infer<typeof documentDetailSchema>;
export const documentResponseSchema = z.strictObject({ document: documentDetailSchema });

const categoryCounts = z.strictObject(
  Object.fromEntries(DOCUMENT_CATEGORIES.map((category) => [category, count])) as Record<
    (typeof DOCUMENT_CATEGORIES)[number],
    typeof count
  >,
);

export const documentListResponseSchema = z.strictObject({
  documents: z.array(documentSummarySchema),
  /** Active documents per category that the caller may see. */
  counts: categoryCounts,
  total: count,
  nextCursor: z.number().int().nullable(),
  permissions: z.strictObject({ canUpload: z.boolean(), canSeeConfidential: z.boolean() }),
});
export type DocumentListResponse = z.infer<typeof documentListResponseSchema>;

export const drawingRegisterResponseSchema = z.strictObject({
  /** Active drawings with their current revision only (a superseded revision is never listed). */
  drawings: z.array(documentSummarySchema),
  disciplines: z.strictObject(
    Object.fromEntries(DRAWING_DISCIPLINES.map((discipline) => [discipline, count])) as Record<
      (typeof DRAWING_DISCIPLINES)[number],
      typeof count
    >,
  ),
});
export type DrawingRegisterResponse = z.infer<typeof drawingRegisterResponseSchema>;

// Compliance ------------------------------------------------------------------------------------

export const complianceTypeSchema = z.strictObject({
  id: uuid,
  /** A starter key (translated by the web) or `custom_<n>`. */
  key: z.string(),
  /** The company's own label (custom types; null for starter types, which are translated). */
  label: z.string().nullable(),
  starter: z.boolean(),
  /** Starter types are flagged for legal review (COMPLIANCE-REVIEW CR-DOC-01). */
  complianceReview: z.boolean(),
  scope: z.enum(COMPLIANCE_SCOPES),
  expires: z.boolean(),
  reminderDays: z
    .number()
    .int()
    .min(COMPLIANCE_LIMITS.minReminderDays)
    .max(COMPLIANCE_LIMITS.maxReminderDays),
  active: z.boolean(),
  sortOrder: z.number().int(),
  version,
});
export type ComplianceType = z.infer<typeof complianceTypeSchema>;

const evidence = z.union([
  z.strictObject({
    restricted: z.literal(false),
    documentId: uuid,
    versionId: uuid,
    projectId: uuid,
    title: z.string(),
    revision: z.string(),
    state: z.enum(VERSION_STATES),
    documentStatus: z.enum(DOCUMENT_STATUSES),
  }),
  z.strictObject({ restricted: z.literal(true) }),
]);

export const complianceRecordSchema = z.strictObject({
  id: uuid,
  kind: z.enum(COMPLIANCE_RECORD_KINDS),
  referenceNo: z.string().nullable(),
  issuer: z.string().nullable(),
  issuedOn: z.iso.date().nullable(),
  expiresOn: z.iso.date().nullable(),
  notes: z.string().nullable(),
  reason: z.string().nullable(),
  evidence: evidence.nullable(),
  recordedBy: person,
  recordedAt: timestamp,
  state: z.enum(COMPLIANCE_RECORD_STATES),
});
export type ComplianceRecord = z.infer<typeof complianceRecordSchema>;

export const complianceItemSchema = z.strictObject({
  type: complianceTypeSchema,
  status: complianceStatusSchema,
  daysLeft: z.number().int().nullable(),
  remindFrom: z.iso.date().nullable(),
  current: complianceRecordSchema.nullable(),
  historyCount: count,
  canRecord: z.boolean(),
});
export type ComplianceItem = z.infer<typeof complianceItemSchema>;

const complianceCounts = z.strictObject({
  missing: count,
  valid: count,
  expiring: count,
  expired: count,
  not_applicable: count,
});

export const documentReminderSchema = z.strictObject({
  kind: z.enum(DOCUMENT_REMINDER_KINDS),
  project: z.strictObject({ id: uuid, code: z.string(), name: z.string() }).nullable(),
  /** The compliance item type (compliance reminders). */
  type: z.strictObject({ id: uuid, key: z.string(), label: z.string().nullable() }).nullable(),
  /** The approval request (overdue approvals). */
  approval: z.strictObject({ id: uuid, code: z.string(), title: z.string() }).nullable(),
  expiresOn: z.iso.date().nullable(),
  dueOn: z.iso.date().nullable(),
  /** Days left (negative once expired or overdue); null for missing items. */
  daysLeft: z.number().int().nullable(),
});
export type DocumentReminder = z.infer<typeof documentReminderSchema>;

export const complianceRegisterResponseSchema = z.strictObject({
  project: z.strictObject({ id: uuid, code: z.string(), name: z.string() }),
  today: z.iso.date(),
  items: z.array(complianceItemSchema),
  counts: complianceCounts,
  reminders: z.array(documentReminderSchema),
  permissions: z.strictObject({
    canRecord: z.boolean(),
    canRecordCompany: z.boolean(),
    canExport: z.boolean(),
    canConfigure: z.boolean(),
  }),
});
export type ComplianceRegisterResponse = z.infer<typeof complianceRegisterResponseSchema>;

export const complianceHistoryResponseSchema = z.strictObject({
  item: complianceItemSchema,
  records: z.array(complianceRecordSchema),
});
export type ComplianceHistoryResponse = z.infer<typeof complianceHistoryResponseSchema>;

export const recordComplianceRequestSchema = z
  .strictObject({
    typeId: uuid,
    kind: z.enum(COMPLIANCE_RECORD_KINDS),
    referenceNo: optionalText(80).optional(),
    issuer: optionalText(150).optional(),
    issuedOn: planningDateSchema.nullable().optional(),
    expiresOn: planningDateSchema.nullable().optional(),
    evidenceVersionId: uuid.nullable().optional(),
    notes: optionalText(1000, true).optional(),
    reason: optionalText(500, true).optional(),
    /** The current record the user saw (null when none): a renewal supersedes exactly it. */
    supersedesId: uuid.nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "not_applicable") {
      if (!value.reason || characters(value.reason) < 3)
        ctx.addIssue({ code: "custom", path: ["reason"], message: "required" });
      for (const key of [
        "referenceNo",
        "issuer",
        "issuedOn",
        "expiresOn",
        "evidenceVersionId",
      ] as const)
        if (value[key])
          ctx.addIssue({ code: "custom", path: [key], message: "not_with_not_applicable" });
    } else if (value.reason) {
      ctx.addIssue({ code: "custom", path: ["reason"], message: "not_applicable_only" });
    }
  });
export type RecordComplianceRequest = z.infer<typeof recordComplianceRequestSchema>;

export const complianceExportQuerySchema = z.strictObject({
  locale: z.enum(["en", "sw"]).default("en"),
});

export const complianceTypesResponseSchema = z.strictObject({
  types: z.array(complianceTypeSchema),
  permissions: z.strictObject({ canConfigure: z.boolean() }),
});
export const createComplianceTypeRequestSchema = z.strictObject({
  label: text(3, 120),
  scope: z.enum(COMPLIANCE_SCOPES),
  expires: z.boolean(),
  reminderDays: z
    .number()
    .int()
    .min(COMPLIANCE_LIMITS.minReminderDays)
    .max(COMPLIANCE_LIMITS.maxReminderDays)
    .default(COMPLIANCE_LIMITS.defaultReminderDays),
});
export type CreateComplianceTypeRequest = z.infer<typeof createComplianceTypeRequestSchema>;
export const updateComplianceTypeRequestSchema = z.strictObject({
  label: text(3, 120).optional(),
  expires: z.boolean().optional(),
  reminderDays: z
    .number()
    .int()
    .min(COMPLIANCE_LIMITS.minReminderDays)
    .max(COMPLIANCE_LIMITS.maxReminderDays)
    .optional(),
  active: z.boolean().optional(),
  version,
});
export type UpdateComplianceTypeRequest = z.infer<typeof updateComplianceTypeRequestSchema>;
export const complianceTypeResponseSchema = z.strictObject({ type: complianceTypeSchema });

// Instructions ------------------------------------------------------------------------------------

export const instructionLogNumberSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ./_-]{0,29}$/, "invalid_instruction_number");

export const recordInstructionRequestSchema = z
  .strictObject({
    /** Generated once on the device (offline-ready, with an Idempotency-Key). */
    id: uuid,
    capturedAt: timestamp.optional(),
    number: instructionLogNumberSchema,
    kind: instructionKindSchema,
    issuerName: text(2, 150),
    issuerRole: z.enum(INSTRUCTION_ISSUER_ROLES),
    issuerFirm: optionalText(150).optional(),
    issuedOn: planningDateSchema,
    receivedOn: planningDateSchema,
    subject: text(3, 200),
    description: optionalText(4000, true).optional(),
    costImplication: z.boolean().default(false),
    timeImplication: z.boolean().default(false),
    delayId: uuid.nullable().optional(),
    /** A consultant recording an instruction they issue themselves. */
    issuedByMe: z.boolean().default(false),
  })
  .refine((value) => value.receivedOn >= value.issuedOn, {
    path: ["receivedOn"],
    message: "received_before_issued",
  });
export type RecordInstructionRequest = z.infer<typeof recordInstructionRequestSchema>;

export const updateInstructionLogRequestSchema = z.strictObject({
  number: instructionLogNumberSchema.optional(),
  kind: instructionKindSchema.optional(),
  issuerName: text(2, 150).optional(),
  issuerRole: z.enum(INSTRUCTION_ISSUER_ROLES).optional(),
  issuerFirm: optionalText(150).optional(),
  issuedOn: planningDateSchema.optional(),
  receivedOn: planningDateSchema.optional(),
  subject: text(3, 200).optional(),
  description: optionalText(4000, true).optional(),
  costImplication: z.boolean().optional(),
  timeImplication: z.boolean().optional(),
  delayId: uuid.nullable().optional(),
  version,
});
export type UpdateInstructionLogRequest = z.infer<typeof updateInstructionLogRequestSchema>;

export const instructionResponseRequestSchema = z.strictObject({
  kind: z.enum(INSTRUCTION_RESPONSE_KINDS),
  body: optionalText(2000, true).optional(),
  version,
});
export type InstructionResponseRequest = z.infer<typeof instructionResponseRequestSchema>;

export const instructionAttachmentRequestSchema = z
  .strictObject({
    documentVersionId: uuid.optional(),
    photoId: uuid.optional(),
  })
  .refine((value) => Boolean(value.documentVersionId) !== Boolean(value.photoId), {
    message: "one_attachment",
  });
export type InstructionAttachmentRequest = z.infer<typeof instructionAttachmentRequestSchema>;

export const instructionLogQuerySchema = z.strictObject({
  status: z.enum([...INSTRUCTION_LIFECYCLE, "open"]).optional(),
  kind: instructionKindSchema.optional(),
  flag: z.enum(["cost", "time"]).optional(),
  search,
  cursor: offsetCursor,
  limit,
});
export type InstructionLogQuery = z.infer<typeof instructionLogQuerySchema>;

const linkedVersion = z.strictObject({
  documentId: uuid,
  versionId: uuid,
  title: z.string(),
  category: documentCategorySchema,
  revision: z.string(),
  state: z.enum(VERSION_STATES),
});

export const instructionAttachmentSchema = z.strictObject({
  id: uuid,
  kind: z.enum(INSTRUCTION_ATTACHMENT_KINDS),
  /** A document version (null when the caller may not see its confidential category). */
  document: linkedVersion.nullable(),
  photo: z
    .strictObject({
      id: uuid,
      caption: z.string().nullable(),
      verified: z.boolean(),
      capturedAt: timestamp.nullable(),
    })
    .nullable(),
  restricted: z.boolean(),
  addedBy: person,
  addedAt: timestamp,
});

export const instructionResponseEntrySchema = z.strictObject({
  id: uuid,
  kind: z.enum(INSTRUCTION_RESPONSE_KINDS),
  body: z.string().nullable(),
  fromStatus: instructionLifecycleSchema,
  toStatus: instructionLifecycleSchema,
  recordedBy: person,
  recordedAt: timestamp,
});

export const instructionLogRowSchema = z.strictObject({
  id: uuid,
  number: z.string(),
  kind: instructionKindSchema,
  subject: z.string(),
  issuerName: z.string(),
  issuerRole: z.enum(INSTRUCTION_ISSUER_ROLES),
  issuerFirm: z.string().nullable(),
  issuedOn: z.iso.date(),
  receivedOn: z.iso.date(),
  status: instructionLifecycleSchema,
  costImplication: z.boolean(),
  timeImplication: z.boolean(),
  attachments: count,
  responses: count,
  variations: count,
  delayLinked: z.boolean(),
  version,
});
export type InstructionLogRow = z.infer<typeof instructionLogRowSchema>;

export const instructionLogDetailSchema = z.strictObject({
  ...instructionLogRowSchema.shape,
  description: z.string().nullable(),
  issuedBy: person.nullable(),
  delay: z
    .strictObject({ id: uuid, number: z.number().int(), cause: z.string(), status: z.string() })
    .nullable(),
  variationList: z.array(
    z.strictObject({ id: uuid, number: z.string(), title: z.string(), status: z.string() }),
  ),
  /** Name and reference attachments from the D2.3 register (metadata only). */
  legacyAttachments: z.array(
    z.strictObject({ name: z.string(), reference: z.string().nullable() }),
  ),
  attachmentList: z.array(instructionAttachmentSchema),
  responseList: z.array(instructionResponseEntrySchema),
  createdBy: person,
  createdAt: timestamp,
  updatedAt: timestamp,
  permissions: z.strictObject({
    canEdit: z.boolean(),
    canNote: z.boolean(),
    canAttach: z.boolean(),
    moves: z.array(z.enum(["acknowledge", "action", "close", "reopen"])),
  }),
});
export type InstructionLogDetail = z.infer<typeof instructionLogDetailSchema>;
export const instructionLogResponseSchema = z.strictObject({
  instruction: instructionLogDetailSchema,
  replayed: z.boolean().optional(),
});

export const instructionLogListResponseSchema = z.strictObject({
  instructions: z.array(instructionLogRowSchema),
  counts: z.strictObject({
    received: count,
    acknowledged: count,
    actioned: count,
    closed: count,
    cost: count,
    time: count,
  }),
  total: count,
  nextCursor: z.number().int().nullable(),
  permissions: z.strictObject({ canRecord: z.boolean() }),
});
export type InstructionLogListResponse = z.infer<typeof instructionLogListResponseSchema>;

export const instructionOptionsResponseSchema = z.strictObject({
  nextNumbers: z.strictObject(
    Object.fromEntries(INSTRUCTION_KINDS.map((kind) => [kind, z.string()])) as Record<
      (typeof INSTRUCTION_KINDS)[number],
      z.ZodString
    >,
  ),
  delays: z.array(
    z.strictObject({ id: uuid, number: z.number().int(), cause: z.string(), status: z.string() }),
  ),
  versions: z.array(linkedVersion),
  photos: z.array(
    z.strictObject({
      id: uuid,
      caption: z.string().nullable(),
      verified: z.boolean(),
      capturedAt: timestamp.nullable(),
    }),
  ),
  /** Whether the caller holds the consultant's documents.manage without the contractor's keys. */
  isConsultant: z.boolean(),
});
export type InstructionOptionsResponse = z.infer<typeof instructionOptionsResponseSchema>;

// Approval requests -------------------------------------------------------------------------------

export const raiseApprovalRequestSchema = z
  .strictObject({
    kind: z.enum(APPROVAL_REQUEST_KINDS),
    title: text(3, 200),
    description: optionalText(2000, true).optional(),
    documentVersionId: uuid,
    addressedTo: text(2, 150),
    sentOn: planningDateSchema,
    dueOn: planningDateSchema,
    /** The rejected or "resubmit" request this one answers. */
    resubmissionOfId: uuid.nullable().optional(),
  })
  .refine((value) => value.dueOn >= value.sentOn, { path: ["dueOn"], message: "due_before_sent" });
export type RaiseApprovalRequest = z.infer<typeof raiseApprovalRequestSchema>;

export const approvalResponseRequestSchema = z
  .strictObject({
    decision: z.enum(APPROVAL_DECISIONS),
    comments: optionalText(2000, true).optional(),
    respondedOn: planningDateSchema,
    channel: z.enum(APPROVAL_CHANNELS),
    /** Paper responses: the external consultant who signed it. */
    responderName: optionalText(150).optional(),
    responderFirm: optionalText(150).optional(),
    /** Paper responses: the scan of the signed response (a document version of the project). */
    evidenceVersionId: uuid.nullable().optional(),
    /** The SHA-256 of the document version the responder reviewed (shown on the screen). */
    documentSha256: sha256,
    version,
  })
  .superRefine((value, ctx) => {
    if (value.channel === "paper") {
      if (!value.responderName)
        ctx.addIssue({ code: "custom", path: ["responderName"], message: "required" });
      if (!value.evidenceVersionId)
        ctx.addIssue({ code: "custom", path: ["evidenceVersionId"], message: "required" });
    } else if (value.responderName || value.responderFirm || value.evidenceVersionId) {
      ctx.addIssue({ code: "custom", path: ["channel"], message: "paper_only" });
    }
    if (
      (value.decision === "approved_with_comments" ||
        value.decision === "rejected" ||
        value.decision === "resubmit") &&
      !value.comments
    )
      ctx.addIssue({ code: "custom", path: ["comments"], message: "required" });
  });
export type ApprovalResponseRequest = z.infer<typeof approvalResponseRequestSchema>;

export const cancelApprovalRequestSchema = z.strictObject({ reason, version });
export type CancelApprovalRequest = z.infer<typeof cancelApprovalRequestSchema>;

export const approvalListQuerySchema = z.strictObject({
  status: z.enum(["pending", "overdue", "decided", "cancelled", "all"]).default("all"),
  kind: z.enum(APPROVAL_REQUEST_KINDS).optional(),
  search,
  cursor: offsetCursor,
  limit,
});
export type ApprovalListQuery = z.infer<typeof approvalListQuerySchema>;

const approvalDocument = z.union([
  z.strictObject({
    restricted: z.literal(false),
    ...linkedVersion.shape,
    sha256,
    fileName: z.string(),
    uploadedBy: person,
  }),
  z.strictObject({ restricted: z.literal(true) }),
]);

export const approvalRowSchema = z.strictObject({
  id: uuid,
  code: z.string().refine((value) => /^APR-\d{4,}$/.test(value)),
  number: z.number().int().min(1),
  kind: z.enum(APPROVAL_REQUEST_KINDS),
  title: z.string(),
  addressedTo: z.string(),
  sentOn: z.iso.date(),
  dueOn: z.iso.date(),
  status: approvalStatusSchema,
  overdue: z.boolean(),
  daysOverdue: count,
  document: approvalDocument,
  raisedBy: person,
  version,
});
export type ApprovalRow = z.infer<typeof approvalRowSchema>;

export const approvalDetailSchema = z.strictObject({
  ...approvalRowSchema.shape,
  description: z.string().nullable(),
  raisedAt: timestamp,
  resubmissionOf: z.strictObject({ id: uuid, code: z.string() }).nullable(),
  resubmittedAs: z.strictObject({ id: uuid, code: z.string() }).nullable(),
  response: z
    .strictObject({
      decision: z.enum(APPROVAL_DECISIONS),
      comments: z.string().nullable(),
      respondedOn: z.iso.date(),
      channel: z.enum(APPROVAL_CHANNELS),
      responderName: z.string(),
      responderFirm: z.string().nullable(),
      responder: person.nullable(),
      evidence: evidence.nullable(),
      reviewedSha256: sha256,
      recordedBy: person,
      recordedAt: timestamp,
    })
    .nullable(),
  cancellation: z.strictObject({ by: person, at: timestamp, reason: z.string() }).nullable(),
  permissions: z.strictObject({
    canRespond: z.boolean(),
    canRecordPaper: z.boolean(),
    canCancel: z.boolean(),
    canResubmit: z.boolean(),
    /** Why the caller cannot answer in the app (raiser or uploader), if so. */
    respondBlockedBy: z
      .enum(["approval-raiser-cannot-respond", "approval-uploader-cannot-respond"])
      .nullable(),
  }),
});
export type ApprovalDetail = z.infer<typeof approvalDetailSchema>;
export const approvalResponseSchema = z.strictObject({ approval: approvalDetailSchema });

export const approvalListResponseSchema = z.strictObject({
  approvals: z.array(approvalRowSchema),
  counts: z.strictObject({ pending: count, overdue: count, decided: count, cancelled: count }),
  total: count,
  nextCursor: z.number().int().nullable(),
  permissions: z.strictObject({ canRaise: z.boolean() }),
});
export type ApprovalListResponse = z.infer<typeof approvalListResponseSchema>;

// Summaries ---------------------------------------------------------------------------------------

export const projectDocumentsSummarySchema = z.strictObject({
  documents: z.strictObject({ active: count, drawings: count }),
  compliance: complianceCounts,
  reminders: z.array(documentReminderSchema),
  instructions: z.strictObject({ open: count, costOrTime: count }),
  approvals: z.strictObject({ pending: count, overdue: count }),
});
export type ProjectDocumentsSummary = z.infer<typeof projectDocumentsSummarySchema>;
export const projectDocumentsSummaryResponseSchema = z.strictObject({
  summary: projectDocumentsSummarySchema,
});

export const documentsOverviewResponseSchema = z.strictObject({
  today: z.iso.date(),
  projects: z.array(
    z.strictObject({
      id: uuid,
      code: z.string(),
      name: z.string(),
      status: z.string(),
      summary: projectDocumentsSummarySchema,
    }),
  ),
  /** Company-level items (contractor registration, WIBA cover): shown on every project. */
  companyItems: z.array(complianceItemSchema),
  /** The company-wide "expiring soon" list: reminders across every readable project. */
  reminders: z.array(documentReminderSchema),
  permissions: z.strictObject({ canRecordCompany: z.boolean(), canConfigure: z.boolean() }),
});
export type DocumentsOverviewResponse = z.infer<typeof documentsOverviewResponseSchema>;
