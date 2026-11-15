import { describe, expect, it } from "vitest";
import {
  BUDGET_TRANSITIONS,
  bucketForecast,
  budgetLevel,
  budgetRow,
  counterpartyKey,
  duplicatePayments,
  expectedLpoPaymentDate,
  maskPhoneNumber,
  normaliseMpesaCode,
  parseKesAmount,
  parseMpesaSms,
  percentOf,
  projectPayroll,
  reachesPercent,
  settlementCostMinor,
  stockValueToMinor,
  sumFigures,
  TOP_UP_TRANSITIONS,
  unusualSpend,
  weekStartOf,
  type PaymentFact,
} from "../index.js";
import { checkProcurementTransition } from "../procurement/lifecycle.js";

/** Synthetic M-Pesa confirmations (made-up codes, names, numbers and balances). */
const SMS = {
  sent: "SKA1B2C3D4 Confirmed. Ksh1,250.00 sent to WANJIKU TESTNAME 0712000001 on 14/11/26 at 10:42 AM. New M-PESA balance is Ksh3,480.50. Transaction cost, Ksh13.00. Amount you can transact within the day is 498,750.00. Earn interest daily on Ziidi MMF,Dial *334#",
  sentMasked:
    "SKA1B2C3D5 Confirmed. Ksh600.00 sent to OTIENO SAMPLE 0722***001 on 3/11/26 at 7:05 PM. New M-PESA balance is Ksh1,200.00. Transaction cost, Ksh7.00.",
  paybill:
    "SKB2C3D4E5 Confirmed. Ksh2,300.00 sent to KPLC PREPAID for account 54000011122 on 14/11/26 at 9:05 AM New M-PESA balance is Ksh1,180.50. Transaction cost, Ksh34.00.Amount you can transact within the day is 497,700.00.",
  till: "SKC3D4E5F6 Confirmed. Ksh850.00 paid to MWANGI HARDWARE (SYNTHETIC). on 14/11/26 at 2:15 PM.New M-PESA balance is Ksh2,630.50. Transaction cost, Ksh0.00. Amount you can transact within the day is 499,150.00.",
  received:
    "SKD4E5F6G7 Confirmed.You have received Ksh5,000.00 from JENGA BORA TEST LTD 0733000002 on 14/11/26 at 8:00 AM  New M-PESA balance is Ksh8,480.50. Earn interest daily on Ziidi MMF,Dial *334#",
  withdraw:
    "SKE5F6G7H8 Confirmed.on 14/11/26 at 4:30 PMWithdraw Ksh3,000.00 from 123456 - SAMPLE AGENCIES JUJA New M-PESA balance is Ksh1,480.50. Transaction cost, Ksh67.00. Amount you can transact within the day is 496,000.00.",
  sentSw:
    "SKF6G7H8J9 Imethibitishwa. Ksh1,250.00 imetumwa kwa WANJIKU TESTNAME 0712000001 tarehe 14/11/26 saa 10:42 AM. Salio lako jipya la M-PESA ni Ksh3,480.50. Gharama ya kutuma ni Ksh13.00.",
  paybillSw:
    "SKG7H8J9K1 Imethibitishwa. Ksh2,300.00 imetumwa kwa KPLC PREPAID kwa akaunti nambari 54000011122 tarehe 14/11/26 saa 9:05 AM. Salio lako jipya la M-PESA ni Ksh1,180.50. Gharama ya kutuma ni Ksh34.00.",
  tillSw:
    "SKH8J9K1L2 Imethibitishwa. Ksh850.00 imelipwa kwa MWANGI HARDWARE (SYNTHETIC) tarehe 14/11/26 saa 2:15 PM. Salio lako jipya la M-PESA ni Ksh2,630.50.",
  receivedSw:
    "SKJ9K1L2M3 Imethibitishwa. Umepokea Ksh5,000.00 kutoka JENGA BORA TEST LTD 0733000002 tarehe 14/11/26 saa 8:00 AM. Salio lako jipya la M-PESA ni Ksh8,480.50.",
  withdrawSw:
    "SKK1L2M3N4 Imethibitishwa. Tarehe 14/11/26 saa 4:30 PM umetoa Ksh3,000.00 kutoka 123456 - SAMPLE AGENCIES JUJA. Salio lako jipya la M-PESA ni Ksh1,480.50. Gharama ya kutoa ni Ksh67.00.",
};

const draftOf = (text: string) => {
  const result = parseMpesaSms(text);
  if (!result.ok) throw new Error(`not parsed: ${result.error}`);
  return result;
};

describe("M-Pesa SMS parser", () => {
  it("drafts money sent to a person, masking the phone and never confirming settlement", () => {
    const { draft, warnings } = draftOf(SMS.sent);
    expect(draft).toEqual({
      kind: "sent",
      language: "en",
      code: "SKA1B2C3D4",
      amountMinor: 125_000,
      counterpartyName: "WANJIKU TESTNAME",
      counterpartyPhoneMasked: "0712***001",
      account: null,
      occurredOn: "2026-11-14",
      occurredAt: "2026-11-14T10:42:00+03:00",
      balanceMinor: 348_050,
      chargeMinor: 1_300,
      direction: "out",
      confirmsSettlement: false,
    });
    expect(warnings).toEqual([]);
    expect(JSON.stringify(draft)).not.toContain("0712000001");
  });

  it("keeps an already masked phone masked and reads a PM time on a one-digit day", () => {
    const { draft } = draftOf(SMS.sentMasked);
    expect(draft.counterpartyName).toBe("OTIENO SAMPLE");
    expect(draft.counterpartyPhoneMasked).toBe("0722***001");
    expect(draft.occurredAt).toBe("2026-11-03T19:05:00+03:00");
  });

  it("drafts Pay Bill, Buy Goods, received and withdrawal messages", () => {
    const paybill = draftOf(SMS.paybill).draft;
    expect([paybill.kind, paybill.counterpartyName, paybill.account, paybill.amountMinor]).toEqual([
      "paybill",
      "KPLC PREPAID",
      "54000011122",
      230_000,
    ]);
    expect([paybill.chargeMinor, paybill.balanceMinor]).toEqual([3_400, 118_050]);
    const till = draftOf(SMS.till).draft;
    expect([till.kind, till.counterpartyName, till.chargeMinor, till.direction]).toEqual([
      "till",
      "MWANGI HARDWARE (SYNTHETIC)",
      0,
      "out",
    ]);
    const received = draftOf(SMS.received);
    expect([
      received.draft.kind,
      received.draft.direction,
      received.draft.counterpartyName,
      received.draft.counterpartyPhoneMasked,
      received.draft.amountMinor,
    ]).toEqual(["received", "in", "JENGA BORA TEST LTD", "0733***002", 500_000]);
    // A received message has no transaction cost to report.
    expect(received.warnings).toEqual([]);
    const withdraw = draftOf(SMS.withdraw).draft;
    expect([
      withdraw.kind,
      withdraw.amountMinor,
      withdraw.account,
      withdraw.counterpartyName,
      withdraw.chargeMinor,
      withdraw.occurredAt,
    ]).toEqual([
      "withdraw",
      300_000,
      "123456",
      "SAMPLE AGENCIES JUJA",
      6_700,
      "2026-11-14T16:30:00+03:00",
    ]);
  });

  it("reads the Kiswahili wording of every kind with the same figures", () => {
    const pairs = [
      [SMS.sent, SMS.sentSw],
      [SMS.paybill, SMS.paybillSw],
      [SMS.received, SMS.receivedSw],
      [SMS.withdraw, SMS.withdrawSw],
    ] as const;
    for (const [en, sw] of pairs) {
      const a = draftOf(en).draft;
      const b = draftOf(sw).draft;
      expect(b.language, sw).toBe("sw");
      expect(
        [b.kind, b.amountMinor, b.counterpartyName, b.account, b.occurredAt, b.balanceMinor],
        sw,
      ).toEqual([
        a.kind,
        a.amountMinor,
        a.counterpartyName,
        a.account,
        a.occurredAt,
        a.balanceMinor,
      ]);
    }
    const till = draftOf(SMS.tillSw);
    expect([till.draft.kind, till.draft.counterpartyName, till.draft.chargeMinor]).toEqual([
      "till",
      "MWANGI HARDWARE (SYNTHETIC)",
      null,
    ]);
    expect(till.warnings).toEqual(["no_charge"]);
  });

  it("tolerates wrapped lines and extra spaces as pasted from a phone", () => {
    const wrapped = SMS.paybill.replaceAll(" ", "\n ").replace("Ksh2,300.00", "Ksh 2,300.00");
    const { draft } = draftOf(wrapped);
    expect([draft.amountMinor, draft.account, draft.code]).toEqual([
      230_000,
      "54000011122",
      "SKB2C3D4E5",
    ]);
  });

  it("refuses what is not an M-Pesa confirmation instead of guessing", () => {
    expect(parseMpesaSms("")).toEqual({ ok: false, error: "empty" });
    expect(parseMpesaSms("   \n ")).toEqual({ ok: false, error: "empty" });
    expect(parseMpesaSms("Your OTP is 123456")).toEqual({ ok: false, error: "no_code" });
    // A ten-digit phone number is not a transaction code.
    expect(parseMpesaSms("0712000001 Confirmed. Ksh50.00 sent to X on 1/1/26 at 1:00 PM")).toEqual({
      ok: false,
      error: "no_code",
    });
    expect(parseMpesaSms("SKA1B2C3D4 Confirmed. Your airtime balance is low.")).toEqual({
      ok: false,
      error: "unrecognised",
    });
    expect(parseMpesaSms("SKA1B2C3D4 Confirmed. sent to X on 1/1/26 at 1:00 PM")).toEqual({
      ok: false,
      error: "no_amount",
    });
    expect(parseMpesaSms(`${SMS.sent} ${"x".repeat(1_000)}`)).toEqual({
      ok: false,
      error: "too_long",
    });
    // The limit counts characters (code points), not UTF-16 units.
    expect(parseMpesaSms(`${SMS.sent}${"😀".repeat(1_000 - Array.from(SMS.sent).length)}`).ok).toBe(
      true,
    );
  });

  it("reports missing pieces as warnings and refuses impossible dates", () => {
    const bare = draftOf("SKA1B2C3D4 Confirmed. Ksh1,000.00 sent to SITE SHOP");
    expect(bare.warnings).toEqual(["no_date", "no_balance", "no_charge"]);
    expect(bare.draft.counterpartyName).toBe("SITE SHOP");
    const impossible = draftOf(SMS.sent.replace("14/11/26", "31/11/26"));
    expect(impossible.draft.occurredOn).toBeNull();
    expect(impossible.warnings).toContain("no_date");
  });

  it("parses amounts exactly and normalises codes", () => {
    expect(parseKesAmount("1,250.50")).toBe(125_050);
    expect(parseKesAmount("0.1")).toBe(10);
    expect(parseKesAmount("1,25.00")).toBeNull();
    expect(parseKesAmount("12.345")).toBeNull();
    expect(parseKesAmount("9,007,199,254,740,991.99")).toBeNull();
    expect(normaliseMpesaCode(" ska1b2c3d4 ")).toBe("SKA1B2C3D4");
    expect(normaliseMpesaCode("1234567890")).toBeNull();
    expect(normaliseMpesaCode("SKA1B2C3D")).toBeNull();
    expect(maskPhoneNumber("+254 712 000 001")).toBe("0712***001");
    expect(maskPhoneNumber("12345")).toBeNull();
  });
});

describe("settlement cost (net of VAT)", () => {
  it("splits partial settlements cumulatively so the pieces add up to the subtotal", () => {
    // Invoice: 10,000.00 net + 16 % VAT = 11,600.00. Paid 4,000.00 then 7,600.00.
    const invoice = { subtotalMinor: 1_000_000, totalMinor: 1_160_000 };
    const first = settlementCostMinor({ ...invoice, settledBeforeMinor: 0, amountMinor: 400_000 });
    const second = settlementCostMinor({
      ...invoice,
      settledBeforeMinor: 400_000,
      amountMinor: 760_000,
    });
    expect([first, second]).toEqual([344_828, 655_172]);
    expect(first + second).toBe(1_000_000);
  });

  it("never rounds a payment's cost below zero or the total above the subtotal", () => {
    const invoice = { subtotalMinor: 333, totalMinor: 387 };
    let settled = 0;
    let total = 0;
    for (const amount of [1, 1, 1, 100, 1, 283]) {
      const piece = settlementCostMinor({
        ...invoice,
        settledBeforeMinor: settled,
        amountMinor: amount,
      });
      expect(piece).toBeGreaterThanOrEqual(0);
      settled += amount;
      total += piece;
      expect(total).toBeLessThanOrEqual(333);
    }
    expect([settled, total]).toEqual([387, 333]);
    expect(() =>
      settlementCostMinor({ ...invoice, settledBeforeMinor: 300, amountMinor: 100 }),
    ).toThrow(RangeError);
  });
});

describe("budget arithmetic", () => {
  it("truncates percentages so a figure below a threshold never displays as the threshold", () => {
    expect(percentOf(79_960, 100_000)).toBe("79.9");
    expect(reachesPercent(79_960, 100_000, 80)).toBe(false);
    expect(percentOf(80_000, 100_000)).toBe("80.0");
    expect(reachesPercent(80_000, 100_000, 80)).toBe(true);
    expect(percentOf(99_999, 100_000)).toBe("99.9");
    expect(percentOf(250_000, 100_000)).toBe("250.0");
    expect(percentOf(-5, 100_000)).toBe("-0.1");
    expect(percentOf(5, 0)).toBeNull();
    expect(percentOf(5, null)).toBeNull();
  });

  it("classifies levels and keeps undefined ratios unavailable", () => {
    expect(budgetLevel(79_999, 100_000, 80)).toBe("within");
    expect(budgetLevel(80_000, 100_000, 80)).toBe("threshold");
    expect(budgetLevel(100_000, 100_000, 80)).toBe("threshold");
    expect(budgetLevel(100_001, 100_000, 80)).toBe("over");
    expect(budgetLevel(1, null, 80)).toBe("unavailable");
    expect(budgetLevel(1, 0, 80)).toBe("unavailable");
  });

  it("adds actual and committed into the forecast and the remaining budget", () => {
    const row = budgetRow(
      { budgetMinor: 1_000_000, committedMinor: 250_000, actualMinor: 600_000, paidMinor: 400_000 },
      80,
    );
    expect(row).toMatchObject({
      forecastMinor: 850_000,
      remainingMinor: 150_000,
      usedPercent: "85.0",
      level: "threshold",
    });
    const unbudgeted = budgetRow(
      { budgetMinor: null, committedMinor: 0, actualMinor: 5_000, paidMinor: 5_000 },
      80,
    );
    expect([unbudgeted.remainingMinor, unbudgeted.usedPercent, unbudgeted.level]).toEqual([
      null,
      null,
      "unavailable",
    ]);
    expect(
      sumFigures([
        { budgetMinor: null, committedMinor: 1, actualMinor: 2, paidMinor: 3 },
        { budgetMinor: 10, committedMinor: 1, actualMinor: 2, paidMinor: 3 },
      ]),
    ).toEqual({ budgetMinor: 10, committedMinor: 2, actualMinor: 4, paidMinor: 6 });
    expect(sumFigures([]).budgetMinor).toBeNull();
  });

  it("rounds reallocated stock value to cents once, half away from zero", () => {
    expect(stockValueToMinor("-6400000.000000")).toBe(-6_400_000);
    expect(stockValueToMinor("1234.5")).toBe(1_235);
    expect(stockValueToMinor("-1234.5")).toBe(-1_235);
    expect(stockValueToMinor("1234.499999")).toBe(1_234);
  });

  it("follows the budget and top-up state machines", () => {
    expect(checkProcurementTransition(BUDGET_TRANSITIONS, "draft", "approve")).toEqual({
      ok: false,
      error: "invalid_transition",
    });
    expect(
      checkProcurementTransition(BUDGET_TRANSITIONS, "submitted", "return", "Fix rates"),
    ).toEqual({ ok: true, to: "draft" });
    expect(checkProcurementTransition(BUDGET_TRANSITIONS, "submitted", "return")).toEqual({
      ok: false,
      error: "reason_required",
    });
    expect(checkProcurementTransition(TOP_UP_TRANSITIONS, "requested", "pay")).toEqual({
      ok: false,
      error: "invalid_transition",
    });
    expect(checkProcurementTransition(TOP_UP_TRANSITIONS, "approved", "pay")).toEqual({
      ok: true,
      to: "paid",
    });
  });
});

describe("cash-flow forecast", () => {
  it("buckets by Monday weeks, puts overdue items in the first week and the rest in later", () => {
    expect(weekStartOf("2026-11-14")).toBe("2026-11-09");
    expect(weekStartOf("2026-11-09")).toBe("2026-11-09");
    expect(weekStartOf("2026-11-15")).toBe("2026-11-09");
    const forecast = bucketForecast(
      [
        {
          kind: "supplier_invoices",
          direction: "out",
          date: "2026-10-30",
          amountMinor: 300,
          basis: "recorded",
        },
        {
          kind: "client_receipts",
          direction: "in",
          date: "2026-11-16",
          amountMinor: 1_000,
          basis: "recorded",
        },
        {
          kind: "payroll",
          direction: "out",
          date: "2026-11-20",
          amountMinor: 400,
          basis: "estimated",
        },
        {
          kind: "lpo_commitments",
          direction: "out",
          date: "2026-12-30",
          amountMinor: 50,
          basis: "estimated",
        },
        {
          kind: "other_payments",
          direction: "out",
          date: "2026-11-11",
          amountMinor: 0,
          basis: "recorded",
        },
      ],
      "2026-11-14",
      2,
      500,
    );
    expect(forecast.weeks.map((week) => [week.start, week.end])).toEqual([
      ["2026-11-09", "2026-11-15"],
      ["2026-11-16", "2026-11-22"],
    ]);
    expect(forecast.weeks[0]).toMatchObject({
      outMinor: 300,
      overdueMinor: 300,
      netMinor: -300,
      closingMinor: 200,
      byKind: { supplier_invoices: -300 },
    });
    expect(forecast.weeks[1]).toMatchObject({
      inMinor: 1_000,
      outMinor: 400,
      estimatedMinor: 400,
      closingMinor: 800,
      byKind: { client_receipts: 1_000, payroll: -400 },
    });
    expect(forecast.later).toEqual({ inMinor: 0, outMinor: 50 });
    expect(bucketForecast([], "2026-11-14", 1, null).weeks[0]!.closingMinor).toBeNull();
  });

  it("projects payroll from batches and the pay calendar's run rate", () => {
    const items = projectPayroll({
      calendar: { frequency: "weekly", anchorDate: "2026-11-06", paydayOffsetDays: 1 },
      today: "2026-11-14",
      until: "2026-11-30",
      batches: [
        { periodStart: "2026-10-30", payDate: "2026-11-06", amountMinor: 99, status: "submitted" },
        { periodStart: "2026-11-06", payDate: "2026-11-13", amountMinor: 70, status: "submitted" },
        { periodStart: "2026-11-13", payDate: "2026-11-20", amountMinor: 80, status: "draft" },
      ],
      runRateMinor: 75,
    });
    expect(items.map((item) => [item.date, item.amountMinor, item.basis])).toEqual([
      ["2026-11-20", 80, "estimated"],
      ["2026-11-27", 75, "estimated"],
    ]);
    expect(
      expectedLpoPaymentDate({
        deliveryDate: "2026-11-20",
        approvedOn: "2026-11-01",
        creditDays: 30,
      }),
    ).toBe("2026-12-20");
    expect(
      expectedLpoPaymentDate({ deliveryDate: null, approvedOn: "2026-11-01", creditDays: 0 }),
    ).toBe("2026-11-01");
  });
});

describe("spend alert rules", () => {
  it("flags an expense far above the float's median, with enough history only", () => {
    const earlier = [1_000, 1_200, 900, 1_100, 50_000];
    // Median 1,100 (the 50,000 outlier does not move it); 3 × 1,100 = 3,300.
    expect(unusualSpend(3_300, earlier, "3", 5)).toEqual({
      unusual: false,
      medianMinor: "1100",
      samples: 5,
    });
    expect(unusualSpend(3_301, earlier, "3", 5).unusual).toBe(true);
    expect(unusualSpend(100_000, earlier.slice(0, 4), "3", 5)).toEqual({
      unusual: false,
      medianMinor: null,
      samples: 4,
    });
    // Even count: median (1,000 + 1,100) / 2 = 1,050; 2.5 × 1,050 = 2,625 exactly.
    expect(unusualSpend(2_625, [900, 1_000, 1_100, 1_200], "2.5", 4)).toMatchObject({
      unusual: false,
      medianMinor: "1050",
    });
    expect(unusualSpend(2_626, [900, 1_000, 1_100, 1_200], "2.5", 4).unusual).toBe(true);
    expect(unusualSpend(5, [1, 2], "1", 2).medianMinor).toBe("1.5");
  });

  it("finds duplicate payments by reference and by counterparty and amount", () => {
    const fact = (id: string, extra: Partial<PaymentFact>): PaymentFact => ({
      id,
      source: "expense",
      projectId: "p",
      counterparty: null,
      amountMinor: 1_000,
      date: "2026-11-10",
      reference: null,
      ...extra,
    });
    const shop = counterpartyKey({ name: "Mwangi  Hardware, (synthetic)" });
    expect(shop).toBe("name:MWANGI HARDWARE SYNTHETIC");
    expect(counterpartyKey({ supplierId: "s1", name: "x" })).toBe("supplier:s1");
    expect(counterpartyKey({ account: "54000011122", name: "KPLC Prepaid" })).toBe(
      "account:54000011122:KPLC PREPAID",
    );
    expect(counterpartyKey({ name: " , " })).toBeNull();
    const pairs = duplicatePayments(
      [
        fact("a", { counterparty: shop, reference: "SKA1B2C3D4" }),
        fact("b", { counterparty: shop, date: "2026-11-13" }),
        fact("c", { counterparty: shop, date: "2026-11-14" }),
        fact("d", { source: "settlement", reference: "SKA1B2C3D4", amountMinor: 5 }),
        fact("e", { source: "top_up", counterparty: shop }),
        fact("f", { counterparty: shop, amountMinor: 999 }),
      ],
      3,
    );
    expect(pairs.map((pair) => [pair.rule, pair.first.id, pair.second.id])).toEqual([
      ["same_reference", "a", "d"],
      ["same_counterparty_amount", "a", "b"],
      ["same_counterparty_amount", "b", "c"],
    ]);
    expect(
      duplicatePayments([fact("a", { counterparty: shop }), fact("b", { counterparty: shop })], 0),
    ).toHaveLength(1);
    // On the same day the one recorded first is the original, whatever the IDs.
    const sameDay = duplicatePayments(
      [
        fact("z", { counterparty: shop, recordedAt: "2026-11-10T06:00:00.000Z" }),
        fact("y", { counterparty: shop, recordedAt: "2026-11-10T09:30:00.000Z" }),
      ],
      3,
    );
    expect(sameDay.map((pair) => [pair.first.id, pair.second.id])).toEqual([["z", "y"]]);
  });
});
