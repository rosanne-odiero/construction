import { clientApprovalSatisfied } from "@pm-buddy/domain";
import type { ClientDecision } from "@pm-buddy/types";
import type { Prisma } from "../../generated/prisma/client.js";
import { clientTermsHistory, currentTerms } from "../finance/client-ledger.js";

type Tx = Prisma.TransactionClient;

export type ClientApproval = {
  /** Whether the project's client terms make internal approval wait for the client. */
  required: boolean;
  /** The client's decision on the variation's current submission (null when none yet). */
  currentDecision: ClientDecision | null;
  /** Whether internal approval may proceed now (rule D-134). */
  satisfied: boolean;
};

/**
 * The client-approval state of a variation (D7.1, rule D-134): the project's newest client terms,
 * and the decision on the sending made from the variation's current submission (the same
 * snapshot digest and submission time). The database repeats the hold on approval
 * (`app.hold_variation_for_client`).
 */
export async function clientApprovalOf(
  tx: Tx,
  tenantId: string,
  variation: {
    id: string;
    projectId: string;
    status: string;
    snapshotDigest: string | null;
    submittedAt: Date | null;
  },
): Promise<ClientApproval> {
  const required = currentTerms(
    await clientTermsHistory(tx, tenantId, variation.projectId),
  ).clientApprovalRequired;
  let currentDecision: ClientDecision | null = null;
  if (variation.status === "submitted" && variation.snapshotDigest && variation.submittedAt) {
    const request = await tx.variationClientRequest.findFirst({
      where: {
        tenantId,
        variationId: variation.id,
        snapshotDigest: variation.snapshotDigest,
        submittedAt: variation.submittedAt,
      },
      include: { decisions: { select: { decision: true } } },
    });
    currentDecision = (request?.decisions[0]?.decision as ClientDecision | undefined) ?? null;
  }
  return {
    required,
    currentDecision,
    satisfied: clientApprovalSatisfied({ required, currentDecision }),
  };
}
