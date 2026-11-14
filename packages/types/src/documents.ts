import type { Permission } from "./permissions.js";

/**
 * Documents, the compliance register, consultant instructions and approval requests (D8.4, brief
 * §5.11, §6 and §15; ARCHITECTURE §4.13; WORKFLOWS "Documents, compliance and instructions"). The
 * database CHECK constraints and triggers in migration `20261128090000_documents` list the same
 * values, so adding one needs a migration as well as a change here. The compliance item types and
 * their reminder windows are company-configurable; the starter set is flagged COMPLIANCE-REVIEW
 * (COMPLIANCE_TODO CR-DOC-01 to CR-DOC-05, CR-NCA-01/02/04).
 */

/** What a project document is. Drawings carry a drawing number, title, discipline and revision. */
export const DOCUMENT_CATEGORIES = [
  "drawing",
  "contract",
  "bq",
  "specification",
  "permit",
  "certificate",
  "insurance",
  "submittal",
  "correspondence",
  "other",
] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

/**
 * Categories that carry commercial terms (contract sums, priced rates, sums insured). Their
 * documents, versions and downloads are visible only with `DOCUMENT_CONFIDENTIAL_PERMISSIONS`
 * (decision D-112); everyone else does not see that they exist.
 */
export const CONFIDENTIAL_DOCUMENT_CATEGORIES = [
  "contract",
  "bq",
  "insurance",
] as const satisfies readonly DocumentCategory[];
export const isConfidentialCategory = (category: DocumentCategory) =>
  (CONFIDENTIAL_DOCUMENT_CATEGORIES as readonly DocumentCategory[]).includes(category);

export const DRAWING_DISCIPLINES = [
  "architectural",
  "structural",
  "civil",
  "mechanical",
  "electrical",
  "plumbing",
  "landscape",
  "survey",
  "other",
] as const;
export type DrawingDiscipline = (typeof DRAWING_DISCIPLINES)[number];

/** Why a version was issued (a label the uploader chooses; it is not an approval, D-113). */
export const ISSUE_PURPOSES = [
  "for_information",
  "for_approval",
  "for_tender",
  "for_construction",
  "as_built",
] as const;
export type IssuePurpose = (typeof ISSUE_PURPOSES)[number];

/** active → withdrawn (with a reason; final). Nothing is deleted. */
export const DOCUMENT_STATUSES = ["active", "withdrawn"] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/** Exactly one version of a document is current; every earlier one is superseded (D-111). */
export const VERSION_STATES = ["current", "superseded"] as const;
export type VersionState = (typeof VERSION_STATES)[number];

/**
 * File types accepted, identified from the content (magic bytes), never from the name or the
 * declared type (decision D-114). DWG, DXF, legacy Office (OLE2) and macro-enabled Office files
 * are refused.
 */
export const DOCUMENT_CONTENT_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
] as const;
export type DocumentContentType = (typeof DOCUMENT_CONTENT_TYPES)[number];
export const DOCUMENT_FILE_EXTENSIONS: Readonly<Record<DocumentContentType, string>> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};

export const DOCUMENT_LIMITS = {
  /** One file: at most 25 MB (an A0 drawing set as PDF fits). */
  maxFileBytes: 25 * 1024 * 1024,
  /** Office files: at most 100 MB uncompressed, 100:1, 5,000 parts, no ZIP64 or encryption. */
  maxUncompressedBytes: 100 * 1024 * 1024,
  maxCompressionRatio: 100,
  maxArchiveEntries: 5_000,
  /** Versions kept per document (the database refuses the 51st). */
  maxVersionsPerDocument: 50,
  /** Documents per project (active and withdrawn). */
  maxDocumentsPerProject: 5_000,
  /** Uploads per user per hour and downloads per user per ten minutes. */
  uploadsPerHour: 120,
  downloadsPer10Minutes: 300,
  /** Compliance register exports per user per ten minutes. */
  exportsPer10Minutes: 30,
  maxPageSize: 100,
  /** Attachments (document versions or site photos) per instruction. */
  maxInstructionAttachments: 10,
  /** Sanitised original file names keep at most 120 characters. */
  maxFileNameLength: 120,
} as const;

/** Whether a compliance item belongs to one project or to the whole company (shown on every project). */
export const COMPLIANCE_SCOPES = ["project", "company"] as const;
export type ComplianceScope = (typeof COMPLIANCE_SCOPES)[number];

/**
 * Derived on read in Africa/Nairobi business dates (packages/domain complianceStatus): `missing`
 * (no record), `valid`, `expiring` (inside the type's reminder window), `expired` (after the
 * expiry date) or `not_applicable` (recorded with a reason).
 */
export const COMPLIANCE_STATUSES = [
  "missing",
  "valid",
  "expiring",
  "expired",
  "not_applicable",
] as const;
export type ComplianceStatus = (typeof COMPLIANCE_STATUSES)[number];
/** A record either evidences the item or states that it does not apply (with a reason). */
export const COMPLIANCE_RECORD_KINDS = ["record", "not_applicable"] as const;
export type ComplianceRecordKind = (typeof COMPLIANCE_RECORD_KINDS)[number];
export const COMPLIANCE_RECORD_STATES = ["current", "superseded"] as const;
export type ComplianceRecordState = (typeof COMPLIANCE_RECORD_STATES)[number];

export type ComplianceStarterType = {
  key: string;
  scope: ComplianceScope;
  expires: boolean;
  reminderDays: number;
};
/**
 * The seeded starter set (brief §5.11 and §6). COMPLIANCE-REVIEW: CR-DOC-01 (which items apply to
 * which projects), CR-NCA-01 (NCA project registration and levy), CR-NCA-02 (contractor
 * registration), CR-NCA-04 (county approval, NEMA, signboard), CR-DOC-02 (insurance), CR-OSH-01
 * (DOSHS workplace registration). Validity periods are what the certificate says; nothing here
 * computes an expiry date.
 */
export const COMPLIANCE_STARTER_TYPES: readonly ComplianceStarterType[] = [
  { key: "county_building_approval", scope: "project", expires: true, reminderDays: 60 },
  { key: "nca_project_registration", scope: "project", expires: false, reminderDays: 30 },
  { key: "nca_levy", scope: "project", expires: false, reminderDays: 30 },
  { key: "nema_licence", scope: "project", expires: true, reminderDays: 60 },
  { key: "nca_contractor_registration", scope: "company", expires: true, reminderDays: 60 },
  { key: "car_insurance", scope: "project", expires: true, reminderDays: 30 },
  { key: "wiba_insurance", scope: "company", expires: true, reminderDays: 30 },
  { key: "osh_workplace_registration", scope: "project", expires: true, reminderDays: 30 },
  { key: "site_signboard", scope: "project", expires: false, reminderDays: 30 },
];
export const COMPLIANCE_STARTER_KEYS = COMPLIANCE_STARTER_TYPES.map((type) => type.key);

export const COMPLIANCE_LIMITS = {
  /** The reminder window before an expiry date: default 30 days, 1–365 per type. */
  defaultReminderDays: 30,
  minReminderDays: 1,
  maxReminderDays: 365,
  /** Item types per company (active and retired). */
  maxTypes: 60,
  /** Company-wide "expiring soon" lists at most this many reminders. */
  maxReminders: 500,
} as const;

/** The consultant instructions log (D2.3's instruction register, extended in D8.4, D-115). */
export const INSTRUCTION_KINDS = [
  "architect_instruction",
  "engineer_instruction",
  "site_instruction",
  "other",
] as const;
export type InstructionKind = (typeof INSTRUCTION_KINDS)[number];
/** received → acknowledged → actioned → closed; any open state → closed; closed → received (reopen). */
export const INSTRUCTION_LIFECYCLE = ["received", "acknowledged", "actioned", "closed"] as const;
export type InstructionLifecycleStatus = (typeof INSTRUCTION_LIFECYCLE)[number];
/** Append-only entries on an instruction; every kind but `note` moves the status. */
export const INSTRUCTION_RESPONSE_KINDS = [
  "note",
  "acknowledge",
  "action",
  "close",
  "reopen",
] as const;
export type InstructionResponseKind = (typeof INSTRUCTION_RESPONSE_KINDS)[number];
export const INSTRUCTION_ATTACHMENT_KINDS = ["document_version", "site_photo"] as const;
export type InstructionAttachmentKind = (typeof INSTRUCTION_ATTACHMENT_KINDS)[number];

/** Approval requests sent to consultants (D-117). */
export const APPROVAL_REQUEST_KINDS = [
  "material_sample",
  "shop_drawing",
  "method_statement",
  "other",
] as const;
export type ApprovalRequestKind = (typeof APPROVAL_REQUEST_KINDS)[number];
export const APPROVAL_DECISIONS = [
  "approved",
  "approved_with_comments",
  "rejected",
  "resubmit",
] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];
/** pending until the one response is recorded, which decides the status; cancelled with a reason. */
export const APPROVAL_STATUSES = ["pending", ...APPROVAL_DECISIONS, "cancelled"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
/**
 * in_app: the consultant (or another reviewer) answers as themselves; paper: someone records an
 * external consultant's signed response, with the consultant's name and the scan as evidence.
 */
export const APPROVAL_CHANNELS = ["in_app", "paper"] as const;
export type ApprovalChannel = (typeof APPROVAL_CHANNELS)[number];

/** What the company-wide and project reminder lists show (computed on read, D-116). */
export const DOCUMENT_REMINDER_KINDS = [
  "compliance_missing",
  "compliance_expiring",
  "compliance_expired",
  "approval_overdue",
] as const;
export type DocumentReminderKind = (typeof DOCUMENT_REMINDER_KINDS)[number];

/**
 * Who may read a project's documents, compliance register, instructions and approval requests (on
 * top of `projects.view`): project, site, commercial, finance and consultant staff. Portal-only
 * roles (client, supplier), storekeepers and labourers hold none of these (decision D-110).
 */
export const DOCUMENT_READ_PERMISSIONS = [
  "documents.manage",
  "projects.manage",
  "site.diary",
  "quality.manage",
  "safety.manage",
  "bq.edit",
  "finance.view",
  "finance.manage",
] as const satisfies readonly Permission[];
/** Who may also see documents in the confidential categories (decision D-112). */
export const DOCUMENT_CONFIDENTIAL_PERMISSIONS = [
  "finance.view",
  "finance.manage",
] as const satisfies readonly Permission[];
/**
 * Who uploads documents and versions, withdraws them, records project compliance items, raises
 * approval requests and responds to them.
 */
export const DOCUMENT_MANAGE_PERMISSIONS = [
  "documents.manage",
] as const satisfies readonly Permission[];
/**
 * Who records instructions received and adds notes, acknowledgements and actions (site staff
 * receive site instructions on site, hence `site.diary`; `bq.edit` keeps D2.3's register rights).
 */
export const INSTRUCTION_RECORD_PERMISSIONS = [
  "documents.manage",
  "bq.edit",
  "site.diary",
] as const satisfies readonly Permission[];
/** Who changes an instruction's details, closes and reopens it. */
export const INSTRUCTION_MANAGE_PERMISSIONS = [
  "documents.manage",
  "bq.edit",
] as const satisfies readonly Permission[];
