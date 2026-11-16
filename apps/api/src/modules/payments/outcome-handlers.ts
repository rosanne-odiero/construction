import { Injectable, Logger } from "@nestjs/common";
import type { PaymentPurpose } from "@pm-buddy/types";
import type { Prisma } from "../../generated/prisma/client.js";

/**
 * What a final attempt outcome means to the module that owns the request's purpose. D4.3 registers
 * a handler for `payroll_obligation` (settlement allocation and journal in the same transaction as
 * the confirmation, WORKFLOWS "pending/unknown → confirmed"); D5/D7 for invoices. `test` requests
 * have no business effect.
 */
export type PaymentOutcome = {
  tenantId: string;
  requestId: string;
  attemptId: string;
  purpose: PaymentPurpose;
  purposeRef: string | null;
  outcome: "confirmed" | "failed" | "reversed";
  amountMinor: number;
  receipt: string | null;
};

export interface PaymentOutcomeHandler {
  readonly purpose: PaymentPurpose;
  /** Runs inside the transaction that records the outcome; throwing rolls the outcome back. */
  handle(tx: Prisma.TransactionClient, outcome: PaymentOutcome): Promise<void>;
}

@Injectable()
export class PaymentOutcomeHandlers {
  private readonly logger = new Logger(PaymentOutcomeHandlers.name);
  private readonly handlers = new Map<PaymentPurpose, PaymentOutcomeHandler>();

  register(handler: PaymentOutcomeHandler) {
    if (this.handlers.has(handler.purpose))
      throw new Error(`A payment outcome handler for ${handler.purpose} is already registered`);
    this.handlers.set(handler.purpose, handler);
  }

  async dispatch(tx: Prisma.TransactionClient, outcome: PaymentOutcome) {
    const handler = this.handlers.get(outcome.purpose);
    if (handler) return handler.handle(tx, outcome);
    if (outcome.purpose !== "test")
      this.logger.warn(`No outcome handler for purpose ${outcome.purpose}; outcome recorded only`);
  }
}
