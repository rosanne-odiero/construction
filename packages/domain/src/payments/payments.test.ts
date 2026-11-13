import {
  PAYMENT_ATTEMPT_STATUSES,
  PAYMENT_ATTEMPT_TRANSITIONS,
  DEMO_PAYMENT_LIMITS,
  type PaymentAttemptStatus,
} from "@pm-buddy/types";
import { describe, expect, it } from "vitest";
import {
  assertAttemptTransition,
  callbackUrlProblems,
  canTransitionAttempt,
  checkPaymentLimits,
  classifySubmission,
  darajaAmount,
  interpretStkQuery,
  interpretTransactionStatus,
  InvalidAttemptTransition,
  isFinalOutcome,
  isLiveAttempt,
  isShortcode,
  isUncertainAttempt,
  parseBalances,
  parseCallback,
  parseProviderAmount,
  redactCallbackBody,
  requestStatusFor,
  stkTimestamp,
  verifyCallback,
  verifySettlement,
  type ExpectedOutcome,
  type ParsedCallback,
} from "./index.js";

const ALLOWED: ReadonlyArray<[PaymentAttemptStatus, PaymentAttemptStatus]> = [
  ["created", "queued"],
  ["queued", "submitting"],
  ["submitting", "pending"],
  ["submitting", "unknown"],
  ["submitting", "failed"],
  ["pending", "unknown"],
  ["pending", "confirmed"],
  ["pending", "failed"],
  ["unknown", "confirmed"],
  ["unknown", "failed"],
  ["confirmed", "reversal_pending"],
  ["reversal_pending", "reversed"],
  ["reversal_pending", "confirmed"],
];

describe("payment attempt state machine (WORKFLOWS: Payment attempts)", () => {
  it("allows exactly the documented edges and refuses every other pair", () => {
    const allowed = new Set(ALLOWED.map(([from, to]) => `${from}->${to}`));
    let checked = 0;
    for (const from of PAYMENT_ATTEMPT_STATUSES)
      for (const to of PAYMENT_ATTEMPT_STATUSES) {
        checked += 1;
        const key = `${from}->${to}`;
        expect(canTransitionAttempt(from, to), key).toBe(allowed.has(key));
        if (allowed.has(key)) expect(() => assertAttemptTransition(from, to)).not.toThrow();
        else expect(() => assertAttemptTransition(from, to)).toThrow(InvalidAttemptTransition);
      }
    expect(checked).toBe(81);
    expect(Object.values(PAYMENT_ATTEMPT_TRANSITIONS).flat()).toHaveLength(ALLOWED.length);
  });

  it("never regresses a final outcome and never resubmits an uncertain one", () => {
    for (const final of ["confirmed", "failed", "reversed"] as const) {
      for (const earlier of ["created", "queued", "submitting", "pending", "unknown"] as const)
        expect(canTransitionAttempt(final, earlier), `${final}->${earlier}`).toBe(false);
      expect(isFinalOutcome(final)).toBe(true);
    }
    expect(canTransitionAttempt("confirmed", "failed")).toBe(false);
    expect(canTransitionAttempt("failed", "confirmed")).toBe(false);
    for (const uncertain of ["submitting", "pending", "unknown"] as const) {
      expect(isUncertainAttempt(uncertain)).toBe(true);
      expect(canTransitionAttempt(uncertain, "queued")).toBe(false);
      expect(canTransitionAttempt(uncertain, "submitting")).toBe(false);
    }
    expect(canTransitionAttempt("submitting", "confirmed")).toBe(false);
    expect(isLiveAttempt("unknown")).toBe(true);
    expect(isLiveAttempt("failed")).toBe(false);
    expect(isUncertainAttempt("queued")).toBe(false);
  });

  it("derives the request summary from the latest attempt", () => {
    expect(requestStatusFor("queued")).toBe("in_progress");
    expect(requestStatusFor("pending")).toBe("in_progress");
    expect(requestStatusFor("unknown")).toBe("uncertain");
    expect(requestStatusFor("confirmed")).toBe("confirmed");
    expect(requestStatusFor("failed")).toBe("failed");
    expect(requestStatusFor("reversal_pending")).toBe("reversal_pending");
    expect(requestStatusFor("reversed")).toBe("reversed");
  });
});

describe("amounts and limits", () => {
  it("parses provider amounts exactly or refuses them", () => {
    expect(parseProviderAmount(1.0)).toBe(100);
    expect(parseProviderAmount(10500)).toBe(1_050_000);
    expect(parseProviderAmount("190.00")).toBe(19_000);
    expect(parseProviderAmount(8959269.6)).toBe(895_926_960);
    expect(parseProviderAmount("300")).toBe(30_000);
    for (const bad of [
      -1,
      Number.NaN,
      Infinity,
      1e21,
      "1.005",
      "abc",
      "",
      null,
      undefined,
      {},
      "1e3",
    ])
      expect(parseProviderAmount(bad), JSON.stringify(bad) ?? "undefined").toBeNull();
  });

  it("sends whole shillings only", () => {
    expect(darajaAmount(125_000)).toBe("1250");
    expect(() => darajaAmount(125_050)).toThrow(RangeError);
    expect(() => darajaAmount(0)).toThrow(RangeError);
  });

  it("checks per-transaction and daily limits at their boundaries", () => {
    const limits = DEMO_PAYMENT_LIMITS;
    expect(checkPaymentLimits("b2c", 1_050, limits, 0)).toEqual({
      code: "amount-not-whole-shillings",
    });
    expect(checkPaymentLimits("b2c", 900, limits, 0)).toEqual({
      code: "amount-below-minimum",
      limitMinor: limits.b2cMinMinor,
    });
    expect(checkPaymentLimits("b2c", limits.b2cMinMinor, limits, 0)).toBeNull();
    expect(checkPaymentLimits("b2c", limits.b2cMaxMinor, limits, 0)).toBeNull();
    expect(checkPaymentLimits("b2c", limits.b2cMaxMinor + 100, limits, 0)).toMatchObject({
      code: "amount-above-limit",
    });
    expect(checkPaymentLimits("b2b_paybill", limits.b2bMaxMinor + 100, limits, 0)).toMatchObject({
      code: "amount-above-limit",
    });
    expect(checkPaymentLimits("stk_push", limits.stkMaxMinor, limits, 10 ** 12)).toBeNull();
    expect(checkPaymentLimits("stk_push", limits.stkMaxMinor + 100, limits, 0)).toMatchObject({
      code: "amount-above-limit",
    });
    const used = limits.dailyPayoutMaxMinor - 10_000;
    expect(checkPaymentLimits("b2c", 10_000, limits, used)).toBeNull();
    expect(checkPaymentLimits("b2c", 10_100, limits, used)).toEqual({
      code: "daily-limit-exceeded",
      limitMinor: limits.dailyPayoutMaxMinor,
      usedMinor: used,
    });
    expect(checkPaymentLimits("reversal", 10_100, limits, used)).toMatchObject({
      code: "daily-limit-exceeded",
    });
  });

  it("validates shortcodes, URL words and the STK timestamp in Nairobi time", () => {
    expect(isShortcode("174379")).toBe(true);
    expect(isShortcode("1234")).toBe(false);
    expect(isShortcode("60099A")).toBe(false);
    expect(callbackUrlProblems("https://api.example.com/api/v1/payments/hooks/abc/stk")).toEqual(
      [],
    );
    expect(callbackUrlProblems("https://mpesa.example.com/query")).toEqual(["mpesa", "query"]);
    // 21:24:08 UTC is 00:24:08 the next day in Nairobi (UTC+3).
    expect(stkTimestamp(new Date("2026-11-10T21:24:08Z"))).toBe("20261111002408");
  });
});

const stkSuccess = {
  Body: {
    stkCallback: {
      MerchantRequestID: "29115-34620561-1",
      CheckoutRequestID: "ws_CO_191220191020363925",
      ResultCode: 0,
      ResultDesc: "The service request is processed successfully.",
      CallbackMetadata: {
        Item: [
          { Name: "Amount", Value: 1.0 },
          { Name: "MpesaReceiptNumber", Value: "NLJ7RT61SV" },
          { Name: "TransactionDate", Value: 20191219102115 },
          { Name: "PhoneNumber", Value: 254708374149 },
        ],
      },
    },
  },
};

const b2cSuccess = {
  Result: {
    ResultType: 0,
    ResultCode: 0,
    ResultDesc: "The service request is processed successfully.",
    OriginatorConversationID: "pmb-8f2a",
    ConversationID: "AG_20240706_2010364430d9bbdaf872",
    TransactionID: "SG632NMUAB",
    ResultParameters: {
      ResultParameter: [
        { Key: "TransactionAmount", Value: 10 },
        { Key: "TransactionReceipt", Value: "SG632NMUAB" },
        { Key: "ReceiverPartyPublicName", Value: "254705912645 - NICHOLAS JOHN SONGOK" },
        { Key: "TransactionCompletedDateTime", Value: "06.07.2024 22:48:52" },
      ],
    },
  },
};

const parsed = (kind: Parameters<typeof parseCallback>[0], body: unknown): ParsedCallback => {
  const result = parseCallback(kind, body);
  if (!result.ok) throw new Error(`parse failed: ${result.reason}`);
  return result.value;
};

describe("callback parsing (official Daraja shapes)", () => {
  it("parses STK success and failure callbacks keyed by request IDs", () => {
    const success = parsed("stk", stkSuccess);
    expect(success).toMatchObject({
      outcome: "success",
      amountMinor: 100,
      receipt: "NLJ7RT61SV",
      identifiers: {
        merchantRequestId: "29115-34620561-1",
        checkoutRequestId: "ws_CO_191220191020363925",
      },
    });
    const failure = parsed("stk", {
      Body: {
        stkCallback: {
          MerchantRequestID: "f1e2",
          CheckoutRequestID: "ws_CO_2",
          ResultCode: 1032,
          ResultDesc: "Request cancelled by user",
        },
      },
    });
    expect(failure).toMatchObject({ outcome: "failure", resultCode: "1032", amountMinor: null });
  });

  it("parses B2C, B2B, reversal, status, balance and timeout results", () => {
    expect(parsed("b2c_result", b2cSuccess)).toMatchObject({
      outcome: "success",
      amountMinor: 1_000,
      receipt: "SG632NMUAB",
      identifiers: { originatorConversationId: "pmb-8f2a" },
    });
    // A single ResultParameter may arrive as an object instead of an array.
    const single = JSON.parse(JSON.stringify(b2cSuccess)) as typeof b2cSuccess;
    (single.Result.ResultParameters as { ResultParameter: unknown }).ResultParameter = {
      Key: "TransactionAmount",
      Value: "10",
    };
    expect(parsed("b2c_result", single)).toMatchObject({
      amountMinor: 1_000,
      receipt: "SG632NMUAB",
    });
    expect(
      parsed("b2c_result", {
        Result: { ...b2cSuccess.Result, ResultCode: 2001, ResultParameters: undefined },
      }),
    ).toMatchObject({ outcome: "failure", resultCode: "2001" });
    expect(parsed("b2c_result", { Result: { ...b2cSuccess.Result, ResultType: 1 } }).outcome).toBe(
      "in_progress",
    );
    expect(
      parsed("b2b_result", {
        Result: {
          ResultType: "0",
          ResultCode: "0",
          OriginatorConversationID: "o-1",
          ConversationID: "c-1",
          TransactionID: "QKA81LK5CY",
          ResultParameters: {
            ResultParameter: [
              { Key: "Amount", Value: "190.00" },
              { Key: "Currency", Value: "KES" },
            ],
          },
        },
      }),
    ).toMatchObject({
      outcome: "success",
      amountMinor: 19_000,
      currency: "KES",
      receipt: "QKA81LK5CY",
    });
    expect(
      parsed("reversal_result", {
        Result: {
          ResultType: 0,
          ResultCode: 0,
          OriginatorConversationID: "r-1",
          ConversationID: "c-2",
          TransactionID: "SKE52PAWR9",
          ResultParameters: {
            ResultParameter: [
              {
                Key: "DebitAccountBalance",
                Value: "Utility Account|KES|7722179.62|7722179.62|0.00|0.00",
              },
              { Key: "Amount", Value: 1.0 },
              { Key: "DebitPartyPublicName", Value: "600992 - Safaricom Daraja 992" },
            ],
          },
        },
      }),
    ).toMatchObject({
      amountMinor: 100,
      currency: "KES",
      shortcode: "600992",
      receipt: "SKE52PAWR9",
    });
    const status = parsed("status_result", {
      Result: {
        ResultType: 0,
        ResultCode: 0,
        OriginatorConversationID: "q-1",
        ConversationID: "AG_q",
        ResultParameters: {
          ResultParameter: [
            { Key: "ReceiptNo", Value: "MBN31H462N" },
            { Key: "Amount", Value: "300" },
            { Key: "TransactionStatus", Value: "Completed" },
            { Key: "OriginatorConversationID", Value: "pmb-orig" },
            { Key: "DebitPartyName", Value: "600310 - Safaricom333" },
          ],
        },
      },
    });
    expect(status.outcome).toBe("information");
    expect(status.original).toMatchObject({
      receipt: "MBN31H462N",
      amountMinor: 30_000,
      status: "Completed",
      originatorConversationId: "pmb-orig",
      debitParty: "600310",
    });
    const balance = parsed("balance_result", {
      Result: {
        ResultType: "0",
        ResultCode: "0",
        OriginatorConversationID: "b-1",
        ConversationID: "AG_b",
        ResultParameters: {
          ResultParameter: [
            {
              Key: "AccountBalance",
              Value:
                "Working Account|KES|700000.00|700000.00|0.00|0.00&Utility Account|KES|228037.00|228037.00|0.00|0.00",
            },
          ],
        },
      },
    });
    expect(balance.balances).toEqual([
      { account: "Working Account", currency: "KES", availableMinor: 70_000_000 },
      { account: "Utility Account", currency: "KES", availableMinor: 22_803_700 },
    ]);
    expect(parseBalances("nonsense")).toBeNull();
    expect(
      parsed("timeout", { Result: { OriginatorConversationID: "pmb-1", ConversationID: "AG_1" } }),
    ).toMatchObject({ outcome: "timeout", identifiers: { originatorConversationId: "pmb-1" } });
  });

  it("parses C2B confirmations with a masked MSISDN and refuses malformed bodies", () => {
    expect(
      parsed("c2b_confirmation", {
        TransactionType: "Pay Bill",
        TransID: "RKL51ZDR4F",
        TransTime: "20231121121325",
        TransAmount: "5.00",
        BusinessShortCode: "600966",
        BillRefNumber: "INV-1",
        MSISDN: "2547 ***** 126",
        FirstName: "NICHOLAS",
      }),
    ).toMatchObject({
      outcome: "success",
      amountMinor: 500,
      shortcode: "600966",
      billReference: "INV-1",
    });
    for (const [kind, body] of [
      ["stk", {}],
      ["stk", { Body: { stkCallback: { CheckoutRequestID: "x", ResultCode: 0 } } }],
      ["b2c_result", { Result: { ResultCode: 0 } }],
      ["b2c_result", "not json"],
      ["c2b_confirmation", { TransID: "X", TransAmount: "1.005", BusinessShortCode: "600966" }],
      ["balance_result", { Result: { ResultCode: 0, OriginatorConversationID: "b" } }],
    ] as const)
      expect(parseCallback(kind, body).ok, `${kind} ${JSON.stringify(body)}`).toBe(false);
  });

  it("redacts names and phone numbers but keeps identifiers and amounts", () => {
    const redacted = JSON.stringify(redactCallbackBody(stkSuccess));
    expect(redacted).not.toContain("254708374149");
    expect(redacted).toContain("2547•••••149");
    expect(redacted).toContain("ws_CO_191220191020363925");
    const b2c = JSON.stringify(redactCallbackBody(b2cSuccess));
    expect(b2c).not.toContain("NICHOLAS");
    expect(b2c).not.toContain("254705912645");
    expect(
      JSON.stringify(redactCallbackBody({ FirstName: "Wanjiru", Note: "pay 0712345678" })),
    ).toBe('{"FirstName":"[redacted]","Note":"pay 0712•••••678"}');
  });
});

describe("callback verification", () => {
  const expected: ExpectedOutcome = {
    kind: "b2c",
    direction: "out",
    amountMinor: 1_000,
    currency: "KES",
    shortcode: "600992",
  };

  it("accepts a matching success and refuses amount, kind, direction, currency and shortcode mismatches", () => {
    const success = parsed("b2c_result", b2cSuccess);
    expect(verifyCallback(success, expected)).toEqual({ ok: true });
    expect(verifyCallback(success, { ...expected, amountMinor: 1_100 })).toEqual({
      ok: false,
      reason: "amount_mismatch",
    });
    expect(verifyCallback(parsed("stk", stkSuccess), expected)).toEqual({
      ok: false,
      reason: "direction_mismatch",
    });
    expect(verifyCallback(success, { ...expected, kind: "b2b_paybill" })).toEqual({
      ok: false,
      reason: "kind_mismatch",
    });
    expect(
      verifySettlement(
        { amountMinor: 1_000, currency: "USD", receipt: "X", shortcode: null },
        expected,
      ),
    ).toEqual({ ok: false, reason: "currency_mismatch" });
    expect(
      verifySettlement(
        { amountMinor: 1_000, currency: null, receipt: "X", shortcode: "123456" },
        expected,
      ),
    ).toEqual({ ok: false, reason: "shortcode_mismatch" });
    expect(
      verifySettlement(
        { amountMinor: 1_000, currency: null, receipt: null, shortcode: null },
        expected,
      ),
    ).toEqual({ ok: false, reason: "malformed" });
    // Failures need no amount: they settle nothing.
    const failure = parsed("b2c_result", {
      Result: { ...b2cSuccess.Result, ResultCode: 1, ResultParameters: undefined },
    });
    expect(verifyCallback(failure, expected)).toEqual({ ok: true });
  });

  it("interprets status answers conservatively", () => {
    expect(interpretTransactionStatus("Completed")).toBe("completed");
    expect(interpretTransactionStatus("Failed")).toBe("failed");
    expect(interpretTransactionStatus("Pending")).toBe("undetermined");
    expect(interpretTransactionStatus(null)).toBe("undetermined");
    expect(interpretStkQuery("0")).toBe("completed");
    expect(interpretStkQuery("1032")).toBe("failed");
    expect(interpretStkQuery("500.001.1001")).toBe("undetermined");
    expect(interpretStkQuery(null)).toBe("undetermined");
  });
});

describe("submission classification (never settlement from the initial response)", () => {
  it("treats undelivered requests as failed and anything possibly delivered as unknown", () => {
    expect(
      classifySubmission("b2c", { type: "not_sent", code: "ECONNREFUSED" }, "o"),
    ).toMatchObject({
      outcome: "failed",
      reason: "not_delivered",
    });
    expect(classifySubmission("b2c", { type: "timeout" }, "o")).toMatchObject({
      outcome: "unknown",
      reason: "timeout",
    });
    expect(classifySubmission("b2c", { type: "network", code: "ECONNRESET" }, "o")).toMatchObject({
      outcome: "unknown",
      reason: "lost_response",
    });
  });

  it("accepts only complete, consistent acknowledgements", () => {
    const accepted = classifySubmission(
      "b2c",
      {
        type: "response",
        httpStatus: 200,
        body: { ConversationID: "AG_1", OriginatorConversationID: "o", ResponseCode: "0" },
      },
      "o",
    );
    expect(accepted).toMatchObject({
      outcome: "pending",
      identifiers: { conversationId: "AG_1", originatorConversationId: "o" },
    });
    expect(
      classifySubmission(
        "b2c",
        {
          type: "response",
          httpStatus: 200,
          body: { ConversationID: "AG_1", OriginatorConversationID: "other", ResponseCode: "0" },
        },
        "o",
      ),
    ).toMatchObject({ outcome: "unknown" });
    expect(
      classifySubmission(
        "stk_push",
        { type: "response", httpStatus: 200, body: { MerchantRequestID: "m", ResponseCode: "0" } },
        null,
      ),
    ).toMatchObject({ outcome: "unknown", reason: "lost_response" });
    expect(
      classifySubmission(
        "stk_push",
        {
          type: "response",
          httpStatus: 200,
          body: { MerchantRequestID: "m", CheckoutRequestID: "ws_CO_1", ResponseCode: 0 },
        },
        null,
      ),
    ).toMatchObject({ outcome: "pending" });
    expect(
      classifySubmission("b2c", { type: "response", httpStatus: 200, body: "<html>" }, "o"),
    ).toMatchObject({ outcome: "unknown" });
    expect(
      classifySubmission(
        "b2c",
        { type: "response", httpStatus: 200, body: { ResponseCode: "1" } },
        "o",
      ),
    ).toMatchObject({ outcome: "failed", reason: "rejected_by_provider", providerCode: "1" });
  });

  it("maps Daraja error codes: rejections fail, duplicates and server errors stay unknown", () => {
    const error = (httpStatus: number, errorCode?: string) =>
      classifySubmission(
        "b2c",
        { type: "response", httpStatus, body: errorCode ? { errorCode, errorMessage: "x" } : null },
        "o",
      );
    expect(error(400, "400.002.02")).toMatchObject({
      outcome: "failed",
      providerCode: "400.002.02",
    });
    expect(error(500, "500.003.02")).toMatchObject({ outcome: "failed" });
    expect(error(500, "500.002.1001")).toMatchObject({
      outcome: "unknown",
      reason: "duplicate_originator_id",
    });
    expect(error(500, "500.003.1001")).toMatchObject({ outcome: "unknown" });
    expect(error(503)).toMatchObject({ outcome: "unknown", providerCode: "http_503" });
  });
});
