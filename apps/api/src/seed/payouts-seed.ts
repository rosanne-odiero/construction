import type { INestApplicationContext } from "@nestjs/common";
import { maskPhone } from "@pm-buddy/domain";
import { uuidv7 } from "../common/uuid.js";
import { TenantDatabase } from "../modules/identity/tenant-database.service.js";
import { LabourCrypto } from "../modules/labour/labour-support.js";

/**
 * Payout part of the development seed (D4.3, owner decision 5): the project manager — someone
 * other than whoever registered the workers — records an in-person ID check of every active demo
 * worker's current M-Pesa number, so the submitted Ruiru batch can be reviewed (finance) and
 * approved (owner) without first verifying 40 numbers by hand. The numbers are the synthetic 0700
 * 000 0xx block; nothing is ever sent to them. Idempotent: a number already verified is skipped.
 */
export type PayoutsSeedSummary = {
  created: boolean;
  /** Active workers with an M-Pesa number, and those whose current number is verified. */
  workersWithNumber: number;
  verifiedWorkers: number;
};

export async function seedPayouts(
  app: INestApplicationContext,
  tenantId: string,
  accounts: { verifierId: string },
): Promise<PayoutsSeedSummary> {
  const db = app.get(TenantDatabase);
  const crypto = app.get(LabourCrypto);
  return db.run({ userId: accounts.verifierId, tenantId, requestId: "seed" }, async (tx) => {
    await tx.$queryRaw`SELECT tenant_id FROM tenants WHERE tenant_id = ${tenantId}::uuid FOR UPDATE`;
    const workers = await tx.labourer.findMany({
      where: { tenantId, status: "active", phoneBidx: { not: null } },
      orderBy: { workerNo: "asc" },
    });
    const existing = await tx.labourerPayoutVerification.findMany({
      where: { tenantId, labourerId: { in: workers.map((worker) => worker.id) } },
      select: { labourerId: true, phoneBidx: true },
    });
    let created = 0;
    for (const worker of workers) {
      if (
        existing.some(
          (row) => row.labourerId === worker.id && row.phoneBidx === worker.phoneBidx,
        ) ||
        !worker.phoneEnc ||
        worker.createdBy === accounts.verifierId ||
        worker.phoneChangedBy === accounts.verifierId
      )
        continue;
      const id = uuidv7();
      await tx.labourerPayoutVerification.create({
        data: {
          id,
          tenantId,
          labourerId: worker.id,
          phoneBidx: worker.phoneBidx!,
          phoneMasked: maskPhone(crypto.open(tenantId, worker.id, "phone_enc", worker.phoneEnc)),
          method: "in_person_id_check",
          note: "Synthetic demo: national ID checked in person at the site office.",
          verifiedBy: accounts.verifierId,
        },
      });
      await tx.auditEvent.create({
        data: {
          tenantId,
          actorId: accounts.verifierId,
          requestId: "seed",
          action: "labour.payout_number_verified",
          resourceId: worker.id,
          metadata: { source: "seed", verificationId: id, method: "in_person_id_check" },
        },
      });
      created += 1;
    }
    const verified = await tx.labourerPayoutVerification.findMany({
      where: { tenantId, labourerId: { in: workers.map((worker) => worker.id) } },
      select: { labourerId: true, phoneBidx: true },
    });
    return {
      created: created > 0,
      workersWithNumber: workers.length,
      verifiedWorkers: workers.filter((worker) =>
        verified.some((row) => row.labourerId === worker.id && row.phoneBidx === worker.phoneBidx),
      ).length,
    };
  });
}
