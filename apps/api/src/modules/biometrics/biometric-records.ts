import {
  coversModality,
  enrolmentState,
  retentionDueOn,
  type ApprovedDpia,
} from "@pm-buddy/domain";
import {
  BIOMETRICS_SYSTEM_ACTOR,
  type BiometricCaptureMethod,
  type BiometricDeletionReason,
  type BiometricEnrolmentStatus,
  type BiometricModality,
} from "@pm-buddy/types";
import type { BiometricDeletion, BiometricEnrolment } from "@pm-buddy/validation";
import type { Prisma } from "../../generated/prisma/client.js";
import { peopleOf, toCalendarDate } from "./biometrics-store.js";

type Tx = Prisma.TransactionClient;

export const enrolmentColumns = {
  id: true,
  labourerId: true,
  modality: true,
  captureMethod: true,
  projectId: true,
  siteId: true,
  status: true,
  templateCount: true,
  algorithm: true,
  algorithmVersion: true,
  enrolledBy: true,
  enrolledAt: true,
  deletedAt: true,
  deletedBy: true,
  deletionReason: true,
} as const satisfies Prisma.BiometricEnrolmentSelect;
export type EnrolmentRow = Prisma.BiometricEnrolmentGetPayload<{ select: typeof enrolmentColumns }>;

/** A person reference; the retention job's system actor is shown as nobody (null). */
const personOrJob = (people: Map<string, string>, id: string | null) =>
  id && id !== BIOMETRICS_SYSTEM_ACTOR ? { id, displayName: people.get(id) ?? "—" } : null;

async function labourerRefs(tx: Tx, tenantId: string, ids: readonly string[]) {
  const rows = ids.length
    ? await tx.labourer.findMany({
        where: { tenantId, id: { in: [...new Set(ids)] } },
        select: { id: true, workerNo: true, fullName: true },
      })
    : [];
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Enrolment metadata for display: the worker, the site, the template algorithm (never a template:
 * the runtime role cannot even read them), the state under the approved DPIA and, while templates
 * are held, the first day the retention job deletes them.
 */
export async function enrolmentViews(
  tx: Tx,
  tenantId: string,
  rows: readonly EnrolmentRow[],
  context: { today: string; retentionDays: number; approved: ApprovedDpia | null },
): Promise<BiometricEnrolment[]> {
  if (!rows.length) return [];
  const labourerIds = rows.map((row) => row.labourerId);
  const labourers = await labourerRefs(tx, tenantId, labourerIds);
  const sites = await tx.site.findMany({
    where: { tenantId, id: { in: [...new Set(rows.map((row) => row.siteId))] } },
    select: { id: true, name: true, project: { select: { code: true } } },
  });
  const siteById = new Map(sites.map((site) => [site.id, site]));
  const engagements = await tx.labourEngagement.findMany({
    where: { tenantId, labourerId: { in: [...new Set(labourerIds)] } },
    select: { labourerId: true, startDate: true, endDate: true },
  });
  const engagementsOf = new Map<string, { startDate: string; endDate: string | null }[]>();
  for (const engagement of engagements) {
    const list = engagementsOf.get(engagement.labourerId) ?? [];
    list.push({
      startDate: toCalendarDate(engagement.startDate),
      endDate: engagement.endDate ? toCalendarDate(engagement.endDate) : null,
    });
    engagementsOf.set(engagement.labourerId, list);
  }
  const people = await peopleOf(
    tx,
    rows.flatMap((row) => [row.enrolledBy, row.deletedBy]),
  );
  const { today, approved } = context;
  return rows.map((row) => {
    const status = row.status as BiometricEnrolmentStatus;
    const modality = row.modality as BiometricModality;
    const labourer = labourers.get(row.labourerId);
    const site = siteById.get(row.siteId);
    const dueOn =
      status === "active"
        ? retentionDueOn(engagementsOf.get(row.labourerId) ?? [], context.retentionDays, today)
        : null;
    return {
      id: row.id,
      labourer: {
        id: row.labourerId,
        workerNo: labourer?.workerNo ?? "—",
        fullName: labourer?.fullName ?? "—",
      },
      modality,
      method: row.captureMethod as BiometricCaptureMethod,
      site: { id: row.siteId, name: site?.name ?? "—", projectCode: site?.project.code ?? "—" },
      status,
      state: enrolmentState({
        status,
        approved: approved
          ? {
              covers: coversModality(approved.methods, modality),
              inForce: approved.reviewDue >= today,
            }
          : null,
        dueOn,
        today,
      }),
      templates: row.templateCount,
      algorithm: row.algorithm,
      algorithmVersion: row.algorithmVersion,
      enrolledAt: row.enrolledAt.toISOString(),
      enrolledBy: { id: row.enrolledBy, displayName: people.get(row.enrolledBy) ?? "—" },
      deletionDueOn: dueOn,
      deletion:
        status === "deleted" && row.deletedAt && row.deletionReason
          ? {
              at: row.deletedAt.toISOString(),
              reason: row.deletionReason as BiometricDeletionReason,
              by: personOrJob(people, row.deletedBy),
            }
          : null,
    };
  });
}

export const deletionColumns = {
  id: true,
  enrolmentId: true,
  labourerId: true,
  modality: true,
  reason: true,
  templateCount: true,
  dueOn: true,
  deletedBy: true,
  deletedAt: true,
} as const satisfies Prisma.BiometricDeletionSelect;
export type DeletionRow = Prisma.BiometricDeletionGetPayload<{ select: typeof deletionColumns }>;

/** Deletion log entries for display: who, what, when and why; never template content. */
export async function deletionViews(
  tx: Tx,
  tenantId: string,
  rows: readonly DeletionRow[],
): Promise<BiometricDeletion[]> {
  if (!rows.length) return [];
  const labourers = await labourerRefs(
    tx,
    tenantId,
    rows.map((row) => row.labourerId),
  );
  const people = await peopleOf(
    tx,
    rows.map((row) => row.deletedBy),
  );
  return rows.map((row) => {
    const labourer = labourers.get(row.labourerId);
    return {
      id: row.id,
      enrolmentId: row.enrolmentId,
      labourer: {
        id: row.labourerId,
        workerNo: labourer?.workerNo ?? "—",
        fullName: labourer?.fullName ?? "—",
      },
      modality: row.modality as BiometricModality,
      reason: row.reason as BiometricDeletionReason,
      templates: row.templateCount,
      deletedAt: row.deletedAt.toISOString(),
      deletedBy: personOrJob(people, row.deletedBy),
      dueOn: row.dueOn ? toCalendarDate(row.dueOn) : null,
    };
  });
}
