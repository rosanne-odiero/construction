import { lastCertifiedLines, linesOf, type Tx } from "./subcontracts-common.js";

export type SubcontractCommitment = { lineageId: string; versionId: string; openMinor: number };

/**
 * Subcontract commitments for the D5.4 budget view (decision D-146): for each line in force of an
 * approved or active subcontract, its value in force less what its latest certified certificate
 * certified on it, never below zero — the value still to be certified. Completed, terminated,
 * draft, submitted and cancelled subcontracts commit nothing. Certified work is in the cost
 * ledger (accrued), so a line's committed and actual never count the same shilling twice.
 */
export async function subcontractCommitments(
  tx: Tx,
  tenantId: string,
  projectId: string,
): Promise<SubcontractCommitment[]> {
  const subcontracts = await tx.subcontract.findMany({
    where: { tenantId, projectId, status: { in: ["approved", "active"] } },
    select: { id: true },
  });
  const result: SubcontractCommitment[] = [];
  for (const subcontract of subcontracts) {
    const [lines, certified] = await Promise.all([
      linesOf(tx, tenantId, subcontract.id),
      lastCertifiedLines(tx, tenantId, subcontract.id),
    ]);
    for (const line of lines) {
      if (!line.inForce) continue;
      const openMinor = Math.max(
        0,
        line.amountMinor - (certified.get(line.row.id)?.valueMinor ?? 0),
      );
      if (openMinor > 0)
        result.push({
          lineageId: line.row.bqItemLineageId,
          versionId: line.row.bqVersionId,
          openMinor,
        });
    }
  }
  return result;
}
