import {
  APPROVAL_NOTICE_LIMITS,
  GSM7_BASIC_CHARACTERS,
  GSM7_EXTENSION_CHARACTERS,
  PAYSLIP_SMS_LIMITS,
  SMS_LIMITS,
  type ApprovalNoticeParams,
  type NumberChangeNoticeParams,
  type PayslipSmsParams,
} from "@pm-buddy/types";
import { IntlMessageFormat } from "intl-messageformat";
import { describe, expect, it } from "vitest";
import { catalogues, formatServerMessage, LOCALES } from "./index.js";

/**
 * Payout SMS (D4.3 §9, CR-PAY-12, D-167): the `payoutSms` messages rendered with the longest values
 * the domain builders (`payslipSmsParams`, `approvalNoticeParams`, `numberChangeNoticeParams`) can
 * produce must stay GSM-7 and within three segments (459 septets) in English and Kiswahili.
 */

const basic = new Set(Array.from(GSM7_BASIC_CHARACTERS));
const extension = new Set(Array.from(GSM7_EXTENSION_CHARACTERS));
/** GSM-7 septets of a text; Infinity when one character would force UCS-2. */
const septets = (text: string) =>
  Array.from(text).reduce(
    (total, char) => total + (basic.has(char) ? 1 : extension.has(char) ? 2 : Infinity),
    0,
  );

type AstElement = {
  type: number;
  value?: unknown;
  options?: Record<string, { value: AstElement[] }>;
  children?: AstElement[];
};
/** Argument names of an ICU message (argument, number, date, time, select and plural elements). */
function argumentNames(elements: readonly AstElement[], names = new Set<string>()): Set<string> {
  for (const element of elements) {
    if (element.type >= 1 && element.type <= 6 && typeof element.value === "string")
      names.add(element.value);
    for (const option of Object.values(element.options ?? {})) argumentNames(option.value, names);
    if (element.children) argumentNames(element.children, names);
  }
  return names;
}
const argumentsOf = (message: string, locale: string) =>
  [...argumentNames(new IntlMessageFormat(message, locale).getAst() as AstElement[])].sort();

const text = (length: number) => "W".repeat(length);
/** The widest amount the builders print ("-999,999,999.99"). */
const amount = "-999,999,999.99";
const date = "30/11/2026";

/** Every combination of the optional parts, each value at its longest. */
const worstPayslips: PayslipSmsParams[] = (["daily", "hourly", "none"] as const).flatMap(
  (rateBasis) =>
    (["mpesa", "cash", "bank"] as const).flatMap((method) =>
      (["yes", "no"] as const).flatMap((withBroughtForward) =>
        (["yes", "no"] as const).map((withCarryForward) => ({
          company: text(PAYSLIP_SMS_LIMITS.company),
          periodStart: date,
          periodEnd: date,
          days: "999.5",
          rateBasis,
          rate: amount,
          gross: amount,
          deductions: amount,
          net: amount,
          withBroughtForward,
          broughtForward: amount,
          paid: amount,
          method,
          reference: text(PAYSLIP_SMS_LIMITS.reference),
          others: PAYSLIP_SMS_LIMITS.others,
          withCarryForward,
          carryForward: "0.99",
        })),
      ),
    ),
);

const worstNotices: ApprovalNoticeParams[] = (["yes", "no"] as const).map((waiver) => ({
  company: text(APPROVAL_NOTICE_LIMITS.company),
  batchReference: text(APPROVAL_NOTICE_LIMITS.batchReference),
  project: text(APPROVAL_NOTICE_LIMITS.project),
  periodStart: date,
  periodEnd: date,
  net: amount,
  approver: text(APPROVAL_NOTICE_LIMITS.approver),
  approvedAt: "30/11/2026 23:59",
  waiver,
}));

const numberChange: NumberChangeNoticeParams = {
  company: text(PAYSLIP_SMS_LIMITS.company),
  date,
};

describe("payout SMS messages (payoutSms)", () => {
  it("renders the worst-case payslip within three GSM-7 segments in English and Kiswahili", () => {
    expect(amount).toHaveLength(PAYSLIP_SMS_LIMITS.amount);
    expect(worstPayslips).toHaveLength(36);
    for (const locale of LOCALES)
      for (const values of worstPayslips) {
        const rendered = formatServerMessage(locale, "payoutSms.payslip.text", values);
        const label = `${locale} ${values.rateBasis} ${values.method} bf:${values.withBroughtForward} cf:${values.withCarryForward}`;
        expect(rendered, label).not.toMatch(/[{}]/);
        expect(septets(rendered), label).toBeLessThanOrEqual(SMS_LIMITS.maxSeptets);
      }
  });

  it("states the exact net, what was paid and the cents carried to the next pay", () => {
    const values = {
      ...worstPayslips[0]!,
      company: "Mjenzi Bora",
      rateBasis: "daily",
      rate: "800",
      gross: "4,400",
      deductions: "312.50",
      net: "4,087.90",
      withBroughtForward: "yes",
      broughtForward: "0.40",
      paid: "4,087",
      method: "mpesa",
      reference: "TKG7AB12CD",
      others: 1,
      withCarryForward: "yes",
      carryForward: "0.90",
    };
    expect(formatServerMessage("en", "payoutSms.payslip.text", values)).toBe(
      "Mjenzi Bora: payslip 30/11/2026-30/11/2026. Days worked 999.5, daily rate KES 800. Gross KES 4,400, deductions KES 312.50, net pay KES 4,087.90 (includes KES 0.40 brought forward). Paid KES 4,087 by M-Pesa, receipt TKG7AB12CD and 1 other payment; KES 0.90 carried to your next pay. Queries: your site office.",
    );
    expect(formatServerMessage("sw", "payoutSms.payslip.text", values)).toBe(
      "Mjenzi Bora: hati ya mshahara 30/11/2026-30/11/2026. Siku za kazi 999.5, kiwango cha siku KES 800. Ghafi KES 4,400, makato KES 312.50, mshahara halisi KES 4,087.90 (pamoja na KES 0.40 za awali). Umelipwa KES 4,087 kwa M-Pesa, risiti TKG7AB12CD na malipo mengine 1; KES 0.90 zitaongezwa kwa malipo yako yajayo. Maswali: ofisi ya eneo la kazi.",
    );
    const whole = {
      ...values,
      net: "4,087",
      withBroughtForward: "no",
      broughtForward: "",
      method: "cash",
      reference: "",
      others: 0,
      withCarryForward: "no",
      carryForward: "",
    };
    expect(formatServerMessage("en", "payoutSms.payslip.text", whole)).toContain(
      "net pay KES 4,087. Paid KES 4,087 in cash. Queries",
    );
    expect(formatServerMessage("sw", "payoutSms.payslip.text", whole)).toContain(
      "mshahara halisi KES 4,087. Umelipwa KES 4,087 kwa pesa taslimu. Maswali",
    );
  });

  it("keeps the approval and number-change notices within three GSM-7 segments", () => {
    for (const locale of LOCALES) {
      for (const values of worstNotices) {
        const rendered = formatServerMessage(locale, "payoutSms.approvalNotice.text", values);
        expect(rendered, `${locale} waiver ${values.waiver}`).not.toMatch(/[{}]/);
        expect(septets(rendered)).toBeLessThanOrEqual(SMS_LIMITS.maxSeptets);
      }
      for (const key of [
        "payoutSms.numberChange.oldNumber",
        "payoutSms.numberChange.newNumber",
      ] as const)
        expect(septets(formatServerMessage(locale, key, numberChange))).toBeLessThanOrEqual(
          SMS_LIMITS.maxSeptets,
        );
    }
  });

  it("uses exactly the values the domain builders provide, in both languages", () => {
    for (const locale of LOCALES) {
      const sms = catalogues[locale].payoutSms;
      expect(argumentsOf(sms.payslip.text, locale)).toEqual(Object.keys(worstPayslips[0]!).sort());
      expect(argumentsOf(sms.approvalNotice.text, locale)).toEqual(
        Object.keys(worstNotices[0]!).sort(),
      );
      for (const message of [sms.numberChange.oldNumber, sms.numberChange.newNumber])
        expect(argumentsOf(message, locale)).toEqual(Object.keys(numberChange).sort());
      expect(argumentsOf(sms.payslip.subject, locale)).toEqual(["periodEnd", "periodStart"]);
      expect(argumentsOf(sms.approvalNotice.subject, locale)).toEqual(["batchReference"]);
    }
  });
});
