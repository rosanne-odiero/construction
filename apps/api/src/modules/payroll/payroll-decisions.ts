import { decisionActionText } from "@pm-buddy/domain";
import type { PayrollDecisionAction } from "@pm-buddy/types";
import { uuidv7 } from "../../common/uuid.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { sha256 } from "./payroll-support.js";

/**
 * Appends one row to a batch's decision log (non-repudiation, T-12, A-17): who decided what about
 * which version, digest and approval digest, with the action hash
 * `sha256(batchId|version|digest|approvalDigest|net|action)` the database checks again. Written by
 * the signed-in user in the command's transaction.
 */
export function recordDecision(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string;
    projectId: string;
    batchId: string;
    action: PayrollDecisionAction;
    actorId: string;
    batchVersion: number;
    digest: string;
    approvalDigest?: string | null;
    netMinor: number;
    appliedLimitMinor?: number | null;
    underWaiver?: boolean;
    stepUpAt?: Date | null;
    note?: string | null;
    obligationId?: string | null;
  },
) {
  const approvalDigest = input.approvalDigest ?? null;
  return tx.payrollBatchDecision.create({
    data: {
      id: uuidv7(),
      tenantId: input.tenantId,
      projectId: input.projectId,
      batchId: input.batchId,
      action: input.action,
      actorId: input.actorId,
      batchVersion: input.batchVersion,
      digest: input.digest,
      approvalDigest,
      netMinor: BigInt(input.netMinor),
      appliedLimitMinor:
        input.appliedLimitMinor === null || input.appliedLimitMinor === undefined
          ? null
          : BigInt(input.appliedLimitMinor),
      underWaiver: input.underWaiver ?? false,
      stepUpAt: input.stepUpAt ?? null,
      actionHash: sha256(
        decisionActionText({
          batchId: input.batchId,
          version: input.batchVersion,
          digest: input.digest,
          approvalDigest,
          netMinor: input.netMinor,
          action: input.action,
        }),
      ),
      note: input.note ?? null,
      obligationId: input.obligationId ?? null,
    },
  });
}
