import { approvalRequestCode } from "@pm-buddy/domain";
import {
  isConfidentialCategory,
  type ApprovalStatus,
  type DocumentCategory,
  type DocumentContentType,
  type DrawingDiscipline,
  type IssuePurpose,
} from "@pm-buddy/types";
import type { DocumentSummary, DocumentVersion } from "@pm-buddy/validation";
import type { Prisma } from "../../generated/prisma/client.js";
import { peopleOf, personOf, type People } from "../procurement/procurement-mappers.js";
import type { DocumentsCaller } from "./documents-access.js";

type Tx = Prisma.TransactionClient;
export type DocumentRow = Prisma.DocumentGetPayload<object>;
export type VersionRow = Prisma.DocumentVersionGetPayload<object>;
export type VersionApproval = { id: string; code: string; status: ApprovalStatus };

export { peopleOf, personOf, type People };

/** The latest approval request on each version (by request number). */
export async function approvalsOf(
  tx: Tx,
  tenantId: string,
  versionIds: readonly string[],
): Promise<Map<string, VersionApproval>> {
  const result = new Map<string, VersionApproval>();
  if (!versionIds.length) return result;
  const rows = await tx.approvalRequest.findMany({
    where: { tenantId, documentVersionId: { in: [...new Set(versionIds)] } },
    select: { id: true, number: true, status: true, documentVersionId: true },
    orderBy: { number: "desc" },
  });
  for (const row of rows)
    if (!result.has(row.documentVersionId))
      result.set(row.documentVersionId, {
        id: row.id,
        code: approvalRequestCode(row.number),
        status: row.status as ApprovalStatus,
      });
  return result;
}

export function toVersion(
  row: VersionRow,
  people: People,
  approvals: ReadonlyMap<string, VersionApproval>,
  successors: ReadonlyMap<string, string>,
): DocumentVersion {
  return {
    id: row.id,
    versionNo: row.versionNo,
    revision: row.revision,
    issuePurpose: row.issuePurpose as IssuePurpose | null,
    changeNote: row.changeNote,
    fileName: row.fileName,
    contentType: row.contentType as DocumentContentType,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    scanStatus: row.scanStatus as "clean" | "not_scanned",
    uploadedBy: personOf(people, row.uploadedBy),
    uploadedAt: row.uploadedAt.toISOString(),
    state: row.isCurrent ? "current" : "superseded",
    supersededAt: row.supersededAt?.toISOString() ?? null,
    supersededBy: row.supersededById
      ? { id: row.supersededById, revision: successors.get(row.supersededById) ?? "" }
      : null,
    approval: approvals.get(row.id) ?? null,
  };
}

export function toSummary(
  doc: DocumentRow,
  current: VersionRow,
  versionCount: number,
  people: People,
  approvals: ReadonlyMap<string, VersionApproval>,
): DocumentSummary {
  const updated = current.uploadedAt > doc.updatedAt ? current.uploadedAt : doc.updatedAt;
  return {
    id: doc.id,
    projectId: doc.projectId,
    category: doc.category as DocumentCategory,
    title: doc.title,
    drawingNumber: doc.drawingNumber,
    discipline: doc.discipline as DrawingDiscipline | null,
    reference: doc.reference,
    status: doc.status as "active" | "withdrawn",
    confidential: isConfidentialCategory(doc.category as DocumentCategory),
    current: {
      id: current.id,
      versionNo: current.versionNo,
      revision: current.revision,
      issuePurpose: current.issuePurpose as IssuePurpose | null,
      fileName: current.fileName,
      contentType: current.contentType as DocumentContentType,
      sizeBytes: current.sizeBytes,
      uploadedBy: personOf(people, current.uploadedBy),
      uploadedAt: current.uploadedAt.toISOString(),
      state: "current",
      approval: approvals.get(current.id) ?? null,
    },
    versionCount,
    updatedAt: updated.toISOString(),
    version: doc.version,
  };
}

/** Documents with their current version, mapped (the current version always exists). */
export async function summariesOf(
  tx: Tx,
  tenantId: string,
  rows: (DocumentRow & { versions: VersionRow[]; _count: { versions: number } })[],
): Promise<DocumentSummary[]> {
  const currents = rows.map((row) => row.versions[0]!);
  const [people, approvals] = await Promise.all([
    peopleOf(
      tx,
      currents.map((version) => version.uploadedBy),
    ),
    approvalsOf(
      tx,
      tenantId,
      currents.map((version) => version.id),
    ),
  ]);
  return rows.map((row, index) =>
    toSummary(row, currents[index]!, row._count.versions, people, approvals),
  );
}

/** Include for a document row with its current version and how many versions it has. */
export const withCurrent = {
  versions: { where: { isCurrent: true }, take: 1 },
  _count: { select: { versions: true } },
} as const;

export type LinkedVersion = {
  documentId: string;
  versionId: string;
  projectId: string;
  title: string;
  category: DocumentCategory;
  revision: string;
  state: "current" | "superseded";
  documentStatus: "active" | "withdrawn";
  sha256: string;
  fileName: string;
  uploadedBy: string;
  uploadedAt: Date;
};

/** Document versions by ID with their document's title, category and status. */
export async function linkedVersions(
  tx: Tx,
  tenantId: string,
  ids: readonly (string | null | undefined)[],
): Promise<Map<string, LinkedVersion>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  const result = new Map<string, LinkedVersion>();
  if (!unique.length) return result;
  const rows = await tx.documentVersion.findMany({
    where: { tenantId, id: { in: unique } },
    include: { document: { select: { title: true, category: true, status: true } } },
  });
  for (const row of rows)
    result.set(row.id, {
      documentId: row.documentId,
      versionId: row.id,
      projectId: row.projectId,
      title: row.document.title,
      category: row.document.category as DocumentCategory,
      revision: row.revision,
      state: row.isCurrent ? "current" : "superseded",
      documentStatus: row.document.status as "active" | "withdrawn",
      sha256: row.sha256,
      fileName: row.fileName,
      uploadedBy: row.uploadedBy,
      uploadedAt: row.uploadedAt,
    });
  return result;
}

/** Whether the caller may see a linked version (its project and its category). */
export const canSeeLinked = (caller: DocumentsCaller, linked: LinkedVersion) =>
  caller.canSeeCategory(linked.projectId, linked.category);

/** Field names (never values) for audit summaries. */
export const changedFields = (input: object) =>
  Object.entries(input)
    .filter(([key, value]) => key !== "version" && value !== undefined)
    .map(([key]) => key)
    .sort();
