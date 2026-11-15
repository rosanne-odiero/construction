import type { ClientPaymentRequestState, PaybillAccountFormat } from "@pm-buddy/types";
import type { TransitionTable } from "../procurement/lifecycle.js";

/**
 * Paying the contractor (D7.1, brief §5.7). C2B Paybill instructions are text a client follows on
 * their phone; STK Push requests go through the `ClientPaymentRequests` boundary, disabled until
 * the Daraja provider (D4.2) exists. Neither ever marks anything paid: only a receipt the company
 * records (or, from D4.2, a provider callback matched and reconciled) does.
 */

const PAYBILL = /^\d{5,7}$/;

/** A Paybill or till number: five to seven digits (COMPLIANCE-REVIEW CR-CLI-04). */
export const isPaybillNumber = (value: string): boolean => PAYBILL.test(value);

/**
 * The account number a client types in the M-Pesa Paybill menu, so finance can match the receipt:
 * the project code and the certificate's number (`RUI-HTS` + 2 → `RUI-HTS-0002`), or the project
 * code alone. Upper case letters, digits and hyphens only (what a phone keypad types).
 */
export function paybillAccountReference(
  format: PaybillAccountFormat,
  projectCode: string,
  certificateNumber: number | null,
): string {
  const code = projectCode.toUpperCase();
  if (format === "project" || certificateNumber === null) return code;
  if (!Number.isInteger(certificateNumber) || certificateNumber < 1)
    throw new RangeError("A certificate number is a positive whole number");
  return `${code}-${String(certificateNumber).padStart(4, "0")}`;
}

/**
 * STK Push request states (rule D-135): created → submitting → pending → confirmed | failed; a
 * timeout or crash after submitting leaves the outcome `unknown`, reconciled before anything else
 * (never resubmitted blindly); a request not yet submitted may be cancelled. `confirm` is only
 * applied by matching and reconciling a provider callback (D4.2), never by the client or the
 * initial provider response.
 */
export type ClientPaymentRequestAction =
  "submit" | "accept" | "timeout" | "confirm" | "fail" | "cancel";

export const CLIENT_PAYMENT_REQUEST_TRANSITIONS: TransitionTable<
  ClientPaymentRequestState,
  ClientPaymentRequestAction
> = {
  submit: { from: ["created"], to: "submitting", reason: false },
  accept: { from: ["submitting"], to: "pending", reason: false },
  timeout: { from: ["submitting", "pending"], to: "unknown", reason: false },
  confirm: { from: ["pending", "unknown"], to: "confirmed", reason: false },
  fail: { from: ["submitting", "pending", "unknown"], to: "failed", reason: false },
  cancel: { from: ["created"], to: "cancelled", reason: false },
};

/** The state after `action`, or null when the request cannot take it. */
export function nextPaymentRequestState(
  state: ClientPaymentRequestState,
  action: ClientPaymentRequestAction,
): ClientPaymentRequestState | null {
  const rule = CLIENT_PAYMENT_REQUEST_TRANSITIONS[action];
  return (rule.from as readonly ClientPaymentRequestState[]).includes(state) ? rule.to : null;
}

/**
 * Whether a request counts as paid: only `confirmed`, and only with a reconciled provider callback
 * (its identifiers, amount, currency and direction matched to the stored request).
 */
export function paymentRequestPaid(
  state: ClientPaymentRequestState,
  callbackReconciled: boolean,
): boolean {
  return state === "confirmed" && callbackReconciled;
}
