import { Injectable } from "@nestjs/common";
import { clientPortalProblem } from "./client-portal-access.js";

/** An STK Push request checked against the certificate, ready for a payment provider. */
export type ClientPaymentRequestInput = {
  tenantId: string;
  projectId: string;
  valuationId: string;
  /** What M-Pesa shows as the account (the Paybill account reference). */
  accountReference: string;
  amountMinor: number;
  /** The payer's phone (2547…/2541…); never used to look the payment up later (brief §5.7). */
  phone: string;
  idempotencyKey: string;
  requestDigest: string;
};

/**
 * The client-side STK Push boundary (D7.1, rule D-135). D4.2's Daraja integration implements it:
 * store a request record (created, keyed by tenant + Idempotency-Key + request digest; a changed
 * payload under the same key is refused), submit it through the provider's outbox, keep the
 * outcome `unknown` after a timeout until reconciled, and mark it `confirmed` only when a provider
 * callback is matched to the stored request (CheckoutRequestID, amount, currency, direction) and
 * reconciled into a client receipt. Nothing is ever shown as paid from the request or its first
 * response (brief §15 D; packages/domain CLIENT_PAYMENT_REQUEST_TRANSITIONS).
 */
export abstract class ClientPaymentRequests {
  abstract readonly available: boolean;
  abstract request(input: ClientPaymentRequestInput): Promise<never>;
}

/** Until D4.2 is on main there is no provider: every request is refused, nothing is stored. */
@Injectable()
export class DisabledClientPaymentRequests extends ClientPaymentRequests {
  readonly available = false;

  request(_input: ClientPaymentRequestInput): Promise<never> {
    return Promise.reject(
      clientPortalProblem(
        503,
        "stk-push-unavailable",
        "Pay with M-Pesa will be available soon; use the Paybill instructions",
      ),
    );
  }
}
