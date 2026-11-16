import type { BiometricDeletionReason, BiometricModality } from "@pm-buddy/types";
import type { Prisma } from "../../generated/prisma/client.js";
import { type AfterCommit, journal } from "./biometric-journal.js";
import { fromCalendarDate } from "./biometrics-store.js";

type Tx = Prisma.TransactionClient;

/**
 * Deletes an active enrolment's templates and marks it deleted (D3.4, DPIA §8). The database
 * stamps who and when, writes the deletion log row and refuses a deletion that breaks a rule
 * (templates left behind, consent not withdrawn, a retention deletion before it is due), and the
 * deletion is journalled once committed. Returns how many templates were deleted, or null when the
 * enrolment was no longer active (someone else deleted it first; nothing is logged twice).
 */
export async function deleteEnrolment(
  tx: Tx,
  after: AfterCommit,
  tenantId: string,
  enrolmentId: string,
  reason: BiometricDeletionReason,
  dueOn: string | null = null,
): Promise<number | null> {
  const removed = await tx.biometricTemplate.deleteMany({ where: { tenantId, enrolmentId } });
  const changed = await tx.biometricEnrolment.updateMany({
    where: { tenantId, id: enrolmentId, status: "active" },
    data: {
      status: "deleted",
      deletionReason: reason,
      deletionDueOn: dueOn ? fromCalendarDate(dueOn) : null,
      version: { increment: 1 },
    },
  });
  if (!changed.count) return null;
  journal(
    after,
    `Biometric templates deleted: company ${tenantId}, enrolment ${enrolmentId}, ${reason}`,
  );
  return removed.count;
}

/**
 * Deletes every active enrolment of the company matching `where` (a labourer and modality, or all
 * enrolments of some modalities), one by one so each gets its own log row.
 */
export async function deleteEnrolments(
  tx: Tx,
  after: AfterCommit,
  tenantId: string,
  where: { labourerId?: string; modalities?: readonly BiometricModality[] },
  reason: BiometricDeletionReason,
): Promise<{ enrolments: number; templates: number }> {
  const rows = await tx.biometricEnrolment.findMany({
    where: {
      tenantId,
      status: "active",
      ...(where.labourerId ? { labourerId: where.labourerId } : {}),
      ...(where.modalities ? { modality: { in: [...where.modalities] } } : {}),
    },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  let enrolments = 0;
  let templates = 0;
  for (const row of rows) {
    const deleted = await deleteEnrolment(tx, after, tenantId, row.id, reason);
    if (deleted === null) continue;
    enrolments += 1;
    templates += deleted;
  }
  return { enrolments, templates };
}
