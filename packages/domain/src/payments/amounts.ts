import {
  DARAJA_FIELD_LIMITS,
  type PaymentAttemptKind,
  type PaymentLimits,
  type PaymentRequestKind,
} from "@pm-buddy/types";
import { toMinor } from "../money.js";

const AMOUNT = /^\d{1,13}(\.\d{1,2})?$/;

/**
 * A provider amount (Daraja sends numbers such as `1.0` or `8959269.6`, or strings such as
 * "190.00") → KES minor units. Anything negative, non-finite, in exponent form or with more than
 * two decimals is refused (null) rather than rounded: amounts are evidence.
 */
export function parseProviderAmount(value: unknown): number | null {
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    text = String(value);
  } else if (typeof value === "string") {
    text = value.trim();
  } else {
    return null;
  }
  if (!AMOUNT.test(text)) return null;
  return toMinor(text);
}

/** Minor units → the whole-shilling amount Daraja expects ("1250"); throws on cents. */
export function darajaAmount(amountMinor: number): string {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor % 100 !== 0)
    throw new RangeError("M-Pesa amounts are positive whole shillings");
  return String(amountMinor / 100);
}

export type LimitProblem =
  | { code: "amount-not-whole-shillings" }
  | { code: "amount-below-minimum"; limitMinor: number }
  | { code: "amount-above-limit"; limitMinor: number }
  | { code: "daily-limit-exceeded"; limitMinor: number; usedMinor: number };

/**
 * Checks a new attempt against the company's configured limits (DEMO placeholders until
 * COMPLIANCE-REVIEW CR-PMT-02). `payoutsTodayMinor` is the sum of today's (Africa/Nairobi) payout
 * attempts that are not failed, read under the company lock so two requests cannot both pass.
 */
export function checkPaymentLimits(
  kind: PaymentAttemptKind | PaymentRequestKind,
  amountMinor: number,
  limits: PaymentLimits,
  payoutsTodayMinor: number,
): LimitProblem | null {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor % 100 !== 0)
    return { code: "amount-not-whole-shillings" };
  if (kind === "stk_push") {
    if (amountMinor > limits.stkMaxMinor)
      return { code: "amount-above-limit", limitMinor: limits.stkMaxMinor };
    return null;
  }
  if (kind === "b2c") {
    if (amountMinor < limits.b2cMinMinor)
      return { code: "amount-below-minimum", limitMinor: limits.b2cMinMinor };
    if (amountMinor > limits.b2cMaxMinor)
      return { code: "amount-above-limit", limitMinor: limits.b2cMaxMinor };
  }
  if ((kind === "b2b_paybill" || kind === "b2b_buygoods") && amountMinor > limits.b2bMaxMinor)
    return { code: "amount-above-limit", limitMinor: limits.b2bMaxMinor };
  if (payoutsTodayMinor + amountMinor > limits.dailyPayoutMaxMinor)
    return {
      code: "daily-limit-exceeded",
      limitMinor: limits.dailyPayoutMaxMinor,
      usedMinor: payoutsTodayMinor,
    };
  return null;
}

/** A Daraja shortcode (Paybill, till or B2C), digits only within the documented length. */
export const isShortcode = (value: string): boolean =>
  new RegExp(`^\\d{${DARAJA_FIELD_LIMITS.shortcodeMin},${DARAJA_FIELD_LIMITS.shortcodeMax}}$`).test(
    value,
  );

/**
 * Daraja refuses callback URLs containing certain words (C2B documentation: M-PESA, Safaricom,
 * exe, exec, cmd, sql, query, …). Checked before a company's URLs are used.
 */
export function callbackUrlProblems(url: string): string[] {
  const lowered = url.toLowerCase();
  return ["m-pesa", "mpesa", "safaricom", "exe", "exec", "cmd", "sql", "query"].filter((word) =>
    lowered.includes(word),
  );
}

/** STK `Timestamp` in Africa/Nairobi (YYYYMMDDHHmmss) and the request `Password`. */
export function stkTimestamp(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}${value("month")}${value("day")}${value("hour")}${value("minute")}${value("second")}`;
}
