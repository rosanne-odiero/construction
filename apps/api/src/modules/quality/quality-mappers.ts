import {
  inspectionReviewIndependent,
  nairobiDate,
  snagDecisionIndependent,
} from "@pm-buddy/domain";
import {
  inspectionItemSchema,
  inspectionSchema,
  snagSchema,
  type Inspection,
  type InspectionItem,
  type QualityPhoto,
  type Snag,
} from "@pm-buddy/validation";
import type { Prisma } from "../../generated/prisma/client.js";
import { personOf, type People } from "../procurement/procurement-mappers.js";
import { toCalendarDate } from "../projects/project-mappers.js";
import { recordCode, type QualityContext } from "./quality-access.js";

const photoSelect = { select: { id: true, verified: true, caption: true } } as const;
const toPhoto = (photo: {
  id: string;
  verified: boolean;
  caption: string | null;
}): QualityPhoto => ({
  id: photo.id,
  verified: photo.verified,
  caption: photo.caption,
});
const optionalPerson = (people: People, id: string | null) => (id ? personOf(people, id) : null);
const iso = (value: Date | null) => value?.toISOString() ?? null;

// Snags ------------------------------------------------------------------------------------------

export const snagInclude = {
  site: { select: { name: true } },
  inspectionItem: {
    select: { text: true, inspection: { select: { id: true, number: true } } },
  },
  photos: { include: { photo: photoSelect }, orderBy: { addedAt: "asc" } },
} as const;
export type SnagRow = Prisma.SnagGetPayload<{ include: typeof snagInclude }>;

export const snagPeople = (row: SnagRow) => [row.raisedBy, row.fixedBy, row.closedBy];

export function toSnag(row: SnagRow, people: People, context: QualityContext): Snag {
  const today = nairobiDate();
  const dueOn = row.dueOn ? toCalendarDate(row.dueOn) : null;
  const decider = snagDecisionIndependent(row, context.userId);
  return snagSchema.parse({
    id: row.id,
    projectId: row.projectId,
    siteId: row.siteId,
    siteName: row.site.name,
    number: row.number,
    code: recordCode("SNG", row.number),
    location: row.location,
    description: row.description,
    severity: row.severity,
    responsibleKind: row.responsibleKind,
    responsibleName: row.responsibleName,
    dueOn,
    overdue: row.status === "open" && dueOn !== null && dueOn < today,
    phase: row.phase,
    inspection: row.inspectionItem
      ? {
          id: row.inspectionItem.inspection.id,
          code: recordCode("INS", row.inspectionItem.inspection.number),
          itemText: row.inspectionItem.text,
        }
      : null,
    status: row.status,
    fixNote: row.fixNote,
    reopenCount: row.reopenCount,
    lastReopenReason: row.lastReopenReason,
    photos: {
      raised: row.photos
        .filter((link) => link.stage === "raised")
        .map((link) => toPhoto(link.photo)),
      fixed: row.photos.filter((link) => link.stage === "fixed").map((link) => toPhoto(link.photo)),
    },
    raisedBy: personOf(people, row.raisedBy),
    raisedAt: row.raisedAt.toISOString(),
    fixedBy: optionalPerson(people, row.fixedBy),
    fixedAt: iso(row.fixedAt),
    closedBy: optionalPerson(people, row.closedBy),
    closedAt: iso(row.closedAt),
    version: row.version,
    permissions: {
      // Editing can change severity, which decides whether completion is blocked: quality.manage.
      canEdit: context.canReview && row.status === "open",
      canFix: context.canRecord && row.status === "open",
      canClose: context.canReview && row.status === "fixed" && decider,
      canReopen: context.canReview && row.status === "fixed" && decider,
    },
  });
}

// Inspections ------------------------------------------------------------------------------------

export const inspectionInclude = {
  site: { select: { name: true } },
  template: { select: { id: true, name: true, version: true } },
  wbsNode: { select: { id: true, code: true, name: true } },
  scheduleActivity: { select: { id: true, code: true, name: true } },
  bqItem: { select: { versionId: true, lineageId: true, ref: true, description: true } },
  items: { select: { result: true } },
} as const;
export type InspectionRow = Prisma.InspectionGetPayload<{ include: typeof inspectionInclude }>;

export const inspectionPeople = (row: InspectionRow) => [
  row.createdBy,
  row.submittedBy,
  row.signedOffBy,
  row.returnedBy,
];

export function toInspection(
  row: InspectionRow,
  people: People,
  context: QualityContext,
): Inspection {
  const count = (result: string) => row.items.filter((item) => item.result === result).length;
  const author = row.createdBy === context.userId;
  const reviewer =
    context.canReview &&
    row.status === "submitted" &&
    inspectionReviewIndependent(row, context.userId);
  return inspectionSchema.parse({
    id: row.id,
    projectId: row.projectId,
    siteId: row.siteId,
    siteName: row.site.name,
    number: row.number,
    code: recordCode("INS", row.number),
    template: row.template,
    category: row.category,
    location: row.location,
    inspectorType: row.inspectorType,
    inspectorName: row.inspectorName,
    inspectedOn: toCalendarDate(row.inspectedOn),
    links: {
      wbsNode: row.wbsNode,
      scheduleActivity: row.scheduleActivity
        ? {
            id: row.scheduleActivity.id,
            code: row.scheduleActivity.code,
            name: row.scheduleActivity.name ?? "—",
          }
        : null,
      bqItem: row.bqItem
        ? {
            versionId: row.bqItem.versionId,
            lineageId: row.bqItem.lineageId,
            reference: row.bqItem.ref,
            description: row.bqItem.description,
          }
        : null,
    },
    status: row.status,
    result: row.result,
    itemCounts: {
      total: row.items.length,
      pass: count("pass"),
      fail: count("fail"),
      na: count("na"),
      pending: count("pending"),
    },
    notes: row.notes,
    version: row.version,
    createdBy: personOf(people, row.createdBy),
    createdAt: row.createdAt.toISOString(),
    submittedBy: optionalPerson(people, row.submittedBy),
    submittedAt: iso(row.submittedAt),
    signedOffBy: optionalPerson(people, row.signedOffBy),
    signedOffAt: iso(row.signedOffAt),
    returnedBy: optionalPerson(people, row.returnedBy),
    returnedAt: iso(row.returnedAt),
    returnReason: row.returnReason,
    permissions: {
      canEdit: context.canRecord && author && row.status === "draft",
      canSubmit: context.canRecord && author && row.status === "draft",
      canSignOff: reviewer,
      canReturn: reviewer,
      canRaiseSnags: context.canRecord && row.status !== "draft" && row.result === "fail",
    },
  });
}

export const itemInclude = {
  photos: { include: { photo: photoSelect }, orderBy: { photoId: "asc" } },
  _count: { select: { snags: true } },
} as const;
export type ItemRow = Prisma.InspectionItemGetPayload<{ include: typeof itemInclude }>;

export const toItem = (row: ItemRow): InspectionItem =>
  inspectionItemSchema.parse({
    id: row.id,
    position: row.position,
    text: row.text,
    result: row.result,
    note: row.note,
    photos: row.photos.map((link) => toPhoto(link.photo)),
    snagCount: row._count.snags,
  });
