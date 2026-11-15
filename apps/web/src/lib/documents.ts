import {
  COMPLIANCE_STARTER_KEYS,
  DOCUMENT_CONFIDENTIAL_PERMISSIONS,
  DOCUMENT_LIMITS,
  DOCUMENT_READ_PERMISSIONS,
  INSTRUCTION_MANAGE_PERMISSIONS,
  INSTRUCTION_RECORD_PERMISSIONS,
  type ApprovalStatus,
  type ComplianceStatus,
  type DocumentReminderKind,
  type InstructionLifecycleStatus,
  type VersionState,
} from "@pm-buddy/types";
import type { Tone } from "@/components/status-badge";
import { FoundationApiError } from "./foundation-api";

/** Display and input helpers for the documents and compliance screens (D8.4). */

/** The rules the API applies to a caller's project permissions (decisions D-110, D-112). */
export function documentsAccess(permissions: readonly string[]) {
  const has = (list: readonly string[]) => list.some((key) => permissions.includes(key));
  const read = permissions.includes("projects.view") && has(DOCUMENT_READ_PERMISSIONS);
  return {
    read,
    confidential: read && has(DOCUMENT_CONFIDENTIAL_PERMISSIONS),
    manage: read && permissions.includes("documents.manage"),
    recordInstruction: read && has(INSTRUCTION_RECORD_PERMISSIONS),
    manageInstruction: read && has(INSTRUCTION_MANAGE_PERMISSIONS),
  };
}

export const DOCUMENT_VIEWS = ["all", "drawings"] as const;
export type DocumentView = (typeof DOCUMENT_VIEWS)[number];
export const INSTRUCTION_VIEWS = ["instructions", "approvals"] as const;
export type InstructionView = (typeof INSTRUCTION_VIEWS)[number];

export const complianceTone: Record<ComplianceStatus, Tone> = {
  missing: "warning",
  valid: "success",
  expiring: "warning",
  expired: "danger",
  not_applicable: "neutral",
};
export const reminderTone: Record<DocumentReminderKind, Tone> = {
  compliance_missing: "warning",
  compliance_expiring: "warning",
  compliance_expired: "danger",
  approval_overdue: "danger",
};
export const versionTone: Record<VersionState, Tone> = {
  current: "success",
  superseded: "neutral",
};
export const instructionTone: Record<InstructionLifecycleStatus, Tone> = {
  received: "warning",
  acknowledged: "info",
  actioned: "success",
  closed: "neutral",
};
export const approvalTone: Record<ApprovalStatus, Tone> = {
  pending: "info",
  approved: "success",
  approved_with_comments: "success",
  rejected: "danger",
  resubmit: "warning",
  cancelled: "neutral",
};

const sizeFormat = new Intl.NumberFormat("en-KE", { maximumFractionDigits: 1 });
/** "812 B", "14.2 KB", "3.4 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${sizeFormat.format(bytes / 1024)} KB`;
  return `${sizeFormat.format(bytes / (1024 * 1024))} MB`;
}

/** Whether a chosen file is within the upload limit (checked again by the API). */
export const fileTooLarge = (size: number) => size > DOCUMENT_LIMITS.maxFileBytes;

/** The same-origin download link of a version (the API checks permissions and audits it). */
export const downloadHref = (projectId: string, documentId: string, versionId: string) =>
  `/api/v1/projects/${projectId}/documents/${documentId}/versions/${versionId}/content`;

/** The compliance register export in a format and language. */
export const exportHref = (projectId: string, format: "pdf" | "xlsx", locale: "en" | "sw") =>
  `/api/v1/projects/${projectId}/compliance/export/${format}?locale=${locale}`;

/** A project tab with optional query values (empty values dropped). */
export function projectTabHref(
  projectId: string,
  tab: "documents" | "compliance" | "instructions",
  values: Record<string, string | number | undefined> = {},
) {
  const params = new URLSearchParams({ tab });
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && value !== "") params.set(key, String(value));
  return `/projects/${projectId}?${params.toString()}`;
}

/**
 * What a form does with its record ID and Idempotency-Key after a failed submit (the
 * offline-ready contract): a collision with its own ID or key means an earlier attempt was
 * recorded; any other refusal recorded nothing, so the corrected form is a new request; a dropped
 * connection or a server error keeps both, so a retry cannot record twice.
 */
export function instructionRetryPlan(error: unknown): "recorded" | "renew" | "keep" {
  if (!(error instanceof FoundationApiError)) return "keep";
  if (error.code === "idempotency-key-reused" || error.code === "instruction-id-conflict")
    return "recorded";
  return error.status >= 400 && error.status < 500 ? "renew" : "keep";
}

export const newClientId = () => crypto.randomUUID();

const STARTER_KEYS = new Set<string>(COMPLIANCE_STARTER_KEYS);
/** A compliance item type's name: the company's own label, or the translated starter name. */
export function complianceTypeLabel(
  type: { key: string; label: string | null },
  translate: (key: string) => string,
): string {
  if (type.label) return type.label;
  return STARTER_KEYS.has(type.key) ? translate(`complianceTypes.${type.key}`) : type.key;
}

/** Where a reminder leads: the item's history, the company item, or the approval request. */
export function reminderHref(reminder: {
  kind: DocumentReminderKind;
  project: { id: string } | null;
  type: { id: string } | null;
  approval: { id: string } | null;
}): string | null {
  if (reminder.kind === "approval_overdue")
    return reminder.project && reminder.approval
      ? `/projects/${reminder.project.id}/approvals/${reminder.approval.id}`
      : null;
  if (!reminder.type) return null;
  return reminder.project
    ? `/projects/${reminder.project.id}/compliance/${reminder.type.id}`
    : `/documents/company/${reminder.type.id}`;
}
