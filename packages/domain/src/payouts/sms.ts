import {
  APPROVAL_NOTICE_LIMITS,
  GSM7_BASIC_CHARACTERS,
  GSM7_EXTENSION_CHARACTERS,
  NOTIFICATION_RETRY_DELAYS_MINUTES,
  PAYSLIP_SMS_LIMITS,
  SMS_AMOUNT_MAX_MINOR,
  SMS_LIMITS,
  type ApprovalNoticeParams,
  type NumberChangeNoticeParams,
  type PayrollPayoutMethod,
  type PayslipSmsParams,
  type RateBasis,
} from "@pm-buddy/types";

/**
 * Payout SMS (D4.3 §9; CR-PAY-12; ARCHITECTURE §15): the values for the EN/SW ICU messages under
 * `payoutSms` in packages/i18n, and the dispatcher's retry schedule. Every value is formatted here
 * and reduced to the GSM-7 basic alphabet, so the rendered text stays GSM-7 (one character outside
 * it would turn the SMS into UCS-2 at 70 characters a segment) and within three segments (459
 * septets; the worst case is unit-tested in packages/i18n). Texts are rendered at send time from
 * immutable records and never stored.
 */

const BASIC = new Set(Array.from(GSM7_BASIC_CHARACTERS));
const EXTENSION = new Set(Array.from(GSM7_EXTENSION_CHARACTERS));

/** Septets `text` needs in GSM-7 (extension characters count twice); null when it is not GSM-7. */
export function gsm7Septets(text: string): number | null {
  let septets = 0;
  for (const char of text) {
    if (BASIC.has(char)) septets += 1;
    else if (EXTENSION.has(char)) septets += 2;
    else return null;
  }
  return septets;
}

/** Segments a GSM-7 text of `septets` uses: one up to 160, else ⌈septets ÷ 153⌉. */
export const smsSegments = (septets: number): number =>
  septets <= SMS_LIMITS.singleSegmentSeptets
    ? 1
    : Math.ceil(septets / SMS_LIMITS.multipartSegmentSeptets);

const REPLACEMENTS: Readonly<Record<string, string>> = {
  "\u2018": "'",
  "\u2019": "'",
  "\u201a": "'",
  "\u02bc": "'",
  "\u00b4": "'",
  "`": "'",
  "\u201c": '"',
  "\u201d": '"',
  "\u201e": '"',
  "\u2010": "-",
  "\u2011": "-",
  "\u2012": "-",
  "\u2013": "-",
  "\u2014": "-",
  "\u2212": "-",
  "\u2026": "...",
};

const isPlain = (char: string) => BASIC.has(char) && char !== "\n" && char !== "\r";

/**
 * `text` in the GSM-7 basic alphabet only, on one line: typographic quotes and dashes become ASCII,
 * letters with accents outside GSM-7 lose them ("Ngʼang'a" → "Ng'ang'a", "ó" → "o"), anything else
 * (emoji, other scripts, extension characters such as `{` or `€`) becomes a space; spaces collapse
 * and the result is cut to `max` characters.
 */
export function toGsm7(text: string, max: number): string {
  let out = "";
  for (const char of text.normalize("NFC")) {
    if (isPlain(char)) out += char;
    else if (REPLACEMENTS[char] !== undefined) out += REPLACEMENTS[char];
    else {
      const stripped = char.normalize("NFKD").replace(/\p{M}/gu, "");
      out += stripped !== "" && Array.from(stripped).every(isPlain) ? stripped : " ";
    }
  }
  return Array.from(out.replace(/\s+/g, " ").trim()).slice(0, Math.max(0, max)).join("").trim();
}

/** 123456 → "1,234.56"; 150000 → "1,500" (whole shillings without decimals). Null out of range. */
export function formatSmsAmount(minor: number): string | null {
  if (!Number.isSafeInteger(minor) || Math.abs(minor) > SMS_AMOUNT_MAX_MINOR) return null;
  const value = Math.abs(minor);
  const shillings = String(Math.floor(value / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const cents = value % 100;
  return `${minor < 0 ? "-" : ""}${shillings}${cents ? `.${String(cents).padStart(2, "0")}` : ""}`;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "2026-11-09" → "09/11/2026" (the Kenyan order, the same in English and Kiswahili). */
export function formatSmsDate(isoDate: string): string | null {
  const match = ISO_DATE.exec(isoDate);
  if (!match) return null;
  const [, year, month, day] = match;
  const check = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (check.getUTCMonth() !== Number(month) - 1 || check.getUTCDate() !== Number(day)) return null;
  return `${day}/${month}/${year}`;
}

/** An instant as "16/11/2026 14:05" on the Africa/Nairobi clock. */
export function formatSmsDateTime(at: Date): string | null {
  if (Number.isNaN(at.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("day")}/${value("month")}/${value("year")} ${value("hour")}:${value("minute")}`;
}

/** A confirmed payment towards the obligation (net of reversals: reversed payouts are left out). */
export type PayslipPayment = {
  method: PayrollPayoutMethod;
  /** The M-Pesa receipt or the bank reference (cash references are not printed). */
  reference: string | null;
  amountMinor: number;
  confirmedAt: string;
};

export type PayslipSmsInput = {
  companyName: string;
  periodStart: string;
  periodEnd: string;
  /** Days worked as the line's decimal string ("4.5"). */
  days: string;
  /**
   * The attendance rate and its basis; null when pay was not attendance-based or the rate varied.
   */
  rateBasis: RateBasis | null;
  rateMinor: number | null;
  grossMinor: number;
  totalDeductionsMinor: number;
  /** The line's exact net, cents and brought-forward amount included. */
  netMinor: number;
  /** Carry-forwards of earlier payrolls included in that net (0 when none). */
  broughtForwardMinor: number;
  /** The obligation's whole shillings, settled by `payments` (D-167). */
  paidMinor: number;
  /** The cents carried to the worker's next payroll (0–99). */
  carryForwardMinor: number;
  payments: readonly PayslipPayment[];
};

export type PayslipSmsError =
  "no_payment" | "invalid_date" | "invalid_days" | "amount_out_of_range" | "amounts_mismatch";

const DAYS = /^\d{1,3}(\.5)?$/;

/**
 * The payslip SMS values (CR-PAY-12, D-167): company, period, days worked, the daily (or hourly)
 * rate when pay was attendance-based, gross, total deductions, the exact net (with any amount
 * brought forward), the whole shillings paid and how, and the cents carried to the next pay. With
 * several payments the largest (then the latest) is named with its reference and the rest are
 * counted. The amounts must agree: paid + carried forward = net (`amounts_mismatch`).
 */
export function payslipSmsParams(
  input: PayslipSmsInput,
): { ok: true; params: PayslipSmsParams } | { ok: false; error: PayslipSmsError } {
  const payments = [...input.payments].sort(
    (a, b) =>
      b.amountMinor - a.amountMinor ||
      Date.parse(b.confirmedAt) - Date.parse(a.confirmedAt) ||
      a.method.localeCompare(b.method),
  );
  const primary = payments[0];
  if (!primary) return { ok: false, error: "no_payment" };
  const periodStart = formatSmsDate(input.periodStart);
  const periodEnd = formatSmsDate(input.periodEnd);
  if (!periodStart || !periodEnd) return { ok: false, error: "invalid_date" };
  if (!DAYS.test(input.days)) return { ok: false, error: "invalid_days" };
  const withRate = input.rateBasis !== null && input.rateMinor !== null && input.rateMinor > 0;
  const rate = withRate ? formatSmsAmount(input.rateMinor!) : "";
  const gross = formatSmsAmount(input.grossMinor);
  const deductions = formatSmsAmount(input.totalDeductionsMinor);
  const net = formatSmsAmount(input.netMinor);
  const paid = formatSmsAmount(input.paidMinor);
  const forward = input.broughtForwardMinor > 0 ? formatSmsAmount(input.broughtForwardMinor) : "";
  const carry = input.carryForwardMinor > 0 ? formatSmsAmount(input.carryForwardMinor) : "";
  if ([rate, gross, deductions, net, paid, forward, carry].includes(null))
    return { ok: false, error: "amount_out_of_range" };
  if (
    input.carryForwardMinor < 0 ||
    input.carryForwardMinor > 99 ||
    input.broughtForwardMinor < 0 ||
    input.paidMinor + input.carryForwardMinor !== input.netMinor
  )
    return { ok: false, error: "amounts_mismatch" };
  return {
    ok: true,
    params: {
      company: toGsm7(input.companyName, PAYSLIP_SMS_LIMITS.company),
      periodStart,
      periodEnd,
      days: input.days,
      rateBasis: withRate ? input.rateBasis! : "none",
      rate: rate!,
      gross: gross!,
      deductions: deductions!,
      net: net!,
      withBroughtForward: forward ? "yes" : "no",
      broughtForward: forward!,
      paid: paid!,
      method: primary.method,
      reference:
        primary.method === "cash"
          ? ""
          : toGsm7(primary.reference ?? "", PAYSLIP_SMS_LIMITS.reference),
      others: Math.min(payments.length - 1, PAYSLIP_SMS_LIMITS.others),
      withCarryForward: carry ? "yes" : "no",
      carryForward: carry!,
    },
  };
}

/** The owner approval notice values (A-17); null when a date or the amount cannot be printed. */
export function approvalNoticeParams(input: {
  companyName: string;
  batchReference: string;
  projectName: string;
  periodStart: string;
  periodEnd: string;
  netMinor: number;
  approverName: string;
  approvedAt: Date;
  underWaiver: boolean;
}): ApprovalNoticeParams | null {
  const periodStart = formatSmsDate(input.periodStart);
  const periodEnd = formatSmsDate(input.periodEnd);
  const net = formatSmsAmount(input.netMinor);
  const approvedAt = formatSmsDateTime(input.approvedAt);
  if (!periodStart || !periodEnd || net === null || !approvedAt) return null;
  return {
    company: toGsm7(input.companyName, APPROVAL_NOTICE_LIMITS.company),
    batchReference: toGsm7(input.batchReference, APPROVAL_NOTICE_LIMITS.batchReference),
    project: toGsm7(input.projectName, APPROVAL_NOTICE_LIMITS.project),
    periodStart,
    periodEnd,
    net,
    approver: toGsm7(input.approverName, APPROVAL_NOTICE_LIMITS.approver),
    approvedAt,
    waiver: input.underWaiver ? "yes" : "no",
  };
}

/**
 * The number-change notice values (A-04): the company and the date of the change, never amounts.
 */
export function numberChangeNoticeParams(input: {
  companyName: string;
  changedAt: Date;
}): NumberChangeNoticeParams | null {
  const stamp = formatSmsDateTime(input.changedAt);
  if (!stamp) return null;
  return {
    company: toGsm7(input.companyName, PAYSLIP_SMS_LIMITS.company),
    date: stamp.slice(0, 10),
  };
}

/**
 * When to send a notification again after its `failures`-th failed send (1-based): 1 minute, 5
 * minutes, 30 minutes, 2 hours, then 6 hours later; null once those five retries are used (the
 * notification becomes `failed` and only a manual resend re-queues it).
 */
export function notificationRetryAt(failures: number, failedAt: Date): Date | null {
  const delay = Number.isInteger(failures)
    ? NOTIFICATION_RETRY_DELAYS_MINUTES[failures - 1]
    : undefined;
  return delay === undefined ? null : new Date(failedAt.getTime() + delay * 60_000);
}
