import { constants, privateDecrypt, randomBytes, randomInt } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { generateTestCertificate, type TestCertificate } from "./certificate.js";
import {
  isScenario,
  MAGIC_AMOUNTS,
  MOCK_SCENARIOS,
  scenarioForAmount,
  SCENARIO_HELP,
  type MockScenario,
} from "./scenarios.js";

/**
 * A local stand-in for Safaricom's Daraja API (D4.2): OAuth, M-Pesa Express (STK Push + Query),
 * C2B URL registration and simulation, B2C, B2B, Transaction Status, Account Balance and Reversal,
 * with asynchronous callbacks shaped like the official documentation (developer.safaricom.co.ke,
 * retrieved 11/11/2026). It moves no money and never calls Safaricom. Scenarios: scenarios.ts.
 */

export type MockDarajaOptions = {
  port?: number;
  host?: string;
  /** Delay before a callback is sent (Daraja results are asynchronous). */
  callbackDelayMs?: number;
  /** How long a "lost" HTTP response is held back (longer than the client's timeout). */
  responseDelayMs?: number;
  /** Re-deliveries of a callback the receiver did not acknowledge with 2xx. */
  callbackRetries?: number;
  /** Send C2B validation requests before confirmations (external validation enabled). */
  externalValidation?: boolean;
  log?: (line: string) => void;
};

export type RecordedRequest = {
  at: string;
  method: string;
  path: string;
  scenario: MockScenario | null;
  status: number;
  /** The request body with SecurityCredential and Password removed. */
  body: unknown;
};

export type SentCallback = {
  at: string;
  url: string;
  label: string;
  body: unknown;
  status: number | null;
  attempt: number;
};

type Kind = "stk" | "b2c" | "b2b" | "reversal";
type Transaction = {
  kind: Kind;
  amount: number;
  scenario: MockScenario;
  receipt: string;
  status: "Completed" | "Failed";
  resultCode: string;
  resultDesc: string;
  originatorConversationId: string;
  conversationId: string;
  merchantRequestId?: string;
  checkoutRequestId?: string;
  partyA: string;
  partyB: string;
  phone?: string;
};

export type MockDaraja = {
  url: string;
  port: number;
  certificatePem: string;
  requests: RecordedRequest[];
  callbacks: SentCallback[];
  setNextScenario(scenario: MockScenario | null): void;
  /** Customer pays a Paybill/till (sends C2B validation/confirmation to the registered URLs). */
  simulateC2b(input: {
    shortCode: string;
    amount: number;
    billRefNumber?: string;
    msisdn?: string;
  }): Promise<{ transId: string }>;
  /** Resolves once at least `count` callbacks have been delivered (any status). */
  waitForCallbacks(count: number, timeoutMs?: number): Promise<void>;
  reset(): void;
  close(): Promise<void>;
};

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const pad = (value: number) => String(value).padStart(2, "0");
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function nairobi(now = new Date()) {
  const local = new Date(now.getTime() + 3 * 3_600_000);
  return {
    compact: `${local.getUTCFullYear()}${pad(local.getUTCMonth() + 1)}${pad(local.getUTCDate())}${pad(local.getUTCHours())}${pad(local.getUTCMinutes())}${pad(local.getUTCSeconds())}`,
    dotted: `${pad(local.getUTCDate())}.${pad(local.getUTCMonth() + 1)}.${local.getUTCFullYear()} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`,
  };
}
const receiptId = () =>
  `T${Array.from({ length: 9 }, () => ALNUM[randomInt(ALNUM.length)]).join("")}`;
const conversationId = () => `AG_${nairobi().compact.slice(0, 8)}_${hex(10)}`;
const originatorId = () =>
  `${hex(2)}-${hex(2)}-${hex(2)}-${hex(6)}${randomInt(1_000_000, 9_999_999)}`;
const merchantId = () => `${randomInt(10_000, 99_999)}-${randomInt(10_000_000, 99_999_999)}-1`;
const checkoutId = () => `ws_CO_${nairobi().compact}${randomInt(100_000_000, 999_999_999)}`;
const money = (value: number) => value.toFixed(2);

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 65_536) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** The same JSON with object keys in reverse order: equal content, different bytes. */
const reserialised = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(reserialised)
    : isObject(value)
      ? Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reserialised(entry)]))
      : value;

const redactRequest = (body: unknown): unknown => {
  if (!isObject(body)) return body;
  const { SecurityCredential: _credential, Password: _password, ...rest } = body;
  return rest;
};

export async function startMockDaraja(options: MockDarajaOptions = {}): Promise<MockDaraja> {
  const callbackDelayMs = options.callbackDelayMs ?? 150;
  const responseDelayMs = options.responseDelayMs ?? 4_000;
  const callbackRetries = options.callbackRetries ?? 2;
  const log = options.log ?? (() => undefined);
  const certificate: TestCertificate = generateTestCertificate();
  const tokens = new Map<string, number>();
  const transactions = new Map<string, Transaction>();
  const seenOriginators = new Set<string>();
  const c2bUrls = new Map<
    string,
    { confirmation: string; validation: string; responseType: string }
  >();
  const requests: RecordedRequest[] = [];
  const callbacks: SentCallback[] = [];
  const timers = new Set<NodeJS.Timeout>();
  const waiters: { count: number; resolve: () => void }[] = [];
  let nextScenario: MockScenario | null = null;
  let utilityMinor = 50_000_000;

  const notifyWaiters = () => {
    const ready = waiters.filter((waiter) => callbacks.length >= waiter.count);
    for (const waiter of ready) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  };

  const later = (ms: number, task: () => Promise<void> | void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      void Promise.resolve(task()).catch((error: unknown) => log(`task failed: ${String(error)}`));
    }, ms);
    timers.add(timer);
  };

  async function deliver(
    url: string,
    body: unknown,
    label: string,
    attempt = 1,
  ): Promise<number | null> {
    let status: number | null = null;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      status = response.status;
      await response.arrayBuffer();
    } catch {
      status = null;
    }
    callbacks.push({ at: new Date().toISOString(), url, label, body, status, attempt });
    notifyWaiters();
    log(`callback ${label} -> ${status ?? "network error"} (attempt ${attempt})`);
    if ((status === null || status < 200 || status >= 300) && attempt <= callbackRetries) {
      await sleep(300 * attempt);
      return deliver(url, body, label, attempt + 1);
    }
    return status;
  }
  const deliverLater = (url: string, body: unknown, label: string, delay = callbackDelayMs) =>
    later(delay, async () => {
      await deliver(url, body, label);
    });

  const pickScenario = (amount: unknown): MockScenario => {
    if (nextScenario) {
      const chosen = nextScenario;
      nextScenario = null;
      return chosen;
    }
    return scenarioForAmount(amount);
  };

  /** RSA PKCS #1 v1.5 with the mock key; OpenSSL implicit rejection turns bad input into noise. */
  const credentialValid = (value: unknown): boolean => {
    try {
      const password = privateDecrypt(
        { key: certificate.privateKey, padding: constants.RSA_PKCS1_PADDING },
        Buffer.from(str(value), "base64"),
      ).toString("utf8");
      return /^[\x20-\x7e]{4,64}$/.test(password) && password !== "wrong-password";
    } catch {
      return false;
    }
  };

  // Result bodies (official shapes) -------------------------------------------------------------

  const stkCallback = (
    tx: Transaction,
    overrides: { code?: number; desc?: string; amount?: number } = {},
  ) => {
    const code = overrides.code ?? 0;
    return {
      Body: {
        stkCallback: {
          MerchantRequestID: tx.merchantRequestId,
          CheckoutRequestID: tx.checkoutRequestId,
          ResultCode: code,
          ResultDesc:
            overrides.desc ??
            (code === 0 ? "The service request is processed successfully." : tx.resultDesc),
          ...(code === 0
            ? {
                CallbackMetadata: {
                  Item: [
                    { Name: "Amount", Value: overrides.amount ?? tx.amount },
                    { Name: "MpesaReceiptNumber", Value: tx.receipt },
                    { Name: "TransactionDate", Value: Number(nairobi().compact) },
                    { Name: "PhoneNumber", Value: Number(tx.phone ?? "254708374149") },
                  ],
                },
              }
            : {}),
        },
      },
    };
  };

  const resultEnvelope = (
    tx: Transaction,
    queueTimeoutUrl: string,
    overrides: { code?: string | number; desc?: string; amount?: number; resultType?: number } = {},
  ) => {
    const code = overrides.code ?? 0;
    const success = String(code) === "0" && overrides.resultType !== 1;
    const amount = overrides.amount ?? tx.amount;
    const parameters = !success
      ? undefined
      : tx.kind === "b2c"
        ? [
            { Key: "TransactionAmount", Value: amount },
            { Key: "TransactionReceipt", Value: tx.receipt },
            { Key: "ReceiverPartyPublicName", Value: `${tx.partyB} - MOCK RECIPIENT` },
            { Key: "TransactionCompletedDateTime", Value: nairobi().dotted },
            { Key: "B2CUtilityAccountAvailableFunds", Value: utilityMinor / 100 },
            { Key: "B2CWorkingAccountAvailableFunds", Value: 700000.0 },
            { Key: "B2CRecipientIsRegisteredCustomer", Value: "Y" },
            { Key: "B2CChargesPaidAccountAvailableFunds", Value: -1980.0 },
          ]
        : tx.kind === "b2b"
          ? [
              { Key: "Amount", Value: money(amount) },
              { Key: "Currency", Value: "KES" },
              { Key: "TransCompletedTime", Value: nairobi().compact },
              { Key: "ReceiverPartyPublicName", Value: `${tx.partyB} - Mock Biller` },
              {
                Key: "DebitPartyAffectedAccountBalance",
                Value: `Working Account|KES|${money(utilityMinor / 100)}|${money(utilityMinor / 100)}|0.00|0.00`,
              },
            ]
          : [
              {
                Key: "DebitAccountBalance",
                Value: `Utility Account|KES|${money(utilityMinor / 100)}|${money(utilityMinor / 100)}|0.00|0.00`,
              },
              { Key: "Amount", Value: amount },
              { Key: "TransCompletedTime", Value: Number(nairobi().compact) },
              { Key: "OriginalTransactionID", Value: tx.partyB },
              { Key: "Charge", Value: 0.0 },
              { Key: "CreditPartyPublicName", Value: "254708374149 - MOCK CUSTOMER" },
              { Key: "DebitPartyPublicName", Value: `${tx.partyA} - Mock Daraja Org` },
            ];
    return {
      Result: {
        ResultType: overrides.resultType ?? 0,
        ResultCode: code,
        ResultDesc:
          overrides.desc ??
          (overrides.resultType === 1
            ? "The service request is being processed."
            : success
              ? "The service request is processed successfully."
              : tx.resultDesc),
        OriginatorConversationID: tx.originatorConversationId,
        ConversationID: tx.conversationId,
        TransactionID: success ? tx.receipt : `${tx.receipt.slice(0, 3)}0000000`,
        ...(parameters ? { ResultParameters: { ResultParameter: parameters } } : {}),
        ReferenceData: { ReferenceItem: { Key: "QueueTimeoutURL", Value: queueTimeoutUrl } },
      },
    };
  };

  /** Schedules the callbacks of an accepted request according to its scenario. */
  function scheduleResults(tx: Transaction, resultUrl: string, timeoutUrl: string) {
    const success = () => (tx.kind === "stk" ? stkCallback(tx) : resultEnvelope(tx, timeoutUrl));
    const failure = () =>
      tx.kind === "stk"
        ? stkCallback(tx, { code: Number(tx.resultCode), desc: tx.resultDesc })
        : resultEnvelope(tx, timeoutUrl, { code: tx.resultCode, desc: tx.resultDesc });
    const label = `${tx.kind}:${tx.scenario}`;
    switch (tx.scenario) {
      case "success":
      case "lost_response":
        deliverLater(
          resultUrl,
          success(),
          label,
          tx.scenario === "lost_response" ? responseDelayMs + 500 : callbackDelayMs,
        );
        break;
      case "result_before_response":
        deliverLater(resultUrl, success(), label, 50);
        break;
      case "failure":
      case "insufficient_balance":
      case "invalid_credentials":
        deliverLater(resultUrl, failure(), label);
        break;
      case "timeout_completed":
      case "timeout_failed":
        break;
      case "duplicate_callback": {
        const body = success();
        deliverLater(resultUrl, body, label);
        deliverLater(resultUrl, body, `${label}:duplicate`, callbackDelayMs + 250);
        break;
      }
      case "late_timeout":
        deliverLater(resultUrl, success(), label);
        if (tx.kind !== "stk")
          deliverLater(
            timeoutUrl,
            {
              Result: {
                ResultType: 0,
                ResultCode: "SVC0403",
                ResultDesc: "The request timed out while waiting in the queue.",
                OriginatorConversationID: tx.originatorConversationId,
                ConversationID: tx.conversationId,
              },
            },
            `${label}:queue-timeout`,
            callbackDelayMs + 400,
          );
        // STK has no queue-timeout URL: the same result arrives again, late and re-serialised.
        else deliverLater(resultUrl, reserialised(stkCallback(tx)), `${label}:late`, callbackDelayMs + 1_200);
        break;
      case "conflicting_results":
        deliverLater(resultUrl, success(), label);
        deliverLater(
          resultUrl,
          tx.kind === "stk"
            ? stkCallback(tx, { code: 1032, desc: "Request cancelled by user" })
            : resultEnvelope(tx, timeoutUrl, {
                code: 2001,
                desc: "The initiator information is invalid.",
              }),
          `${label}:conflict`,
          callbackDelayMs + 400,
        );
        break;
      case "unknown_callback": {
        deliverLater(resultUrl, success(), label);
        const stranger: Transaction = {
          ...tx,
          receipt: receiptId(),
          originatorConversationId: originatorId(),
          conversationId: conversationId(),
          merchantRequestId: merchantId(),
          checkoutRequestId: checkoutId(),
        };
        deliverLater(
          resultUrl,
          tx.kind === "stk" ? stkCallback(stranger) : resultEnvelope(stranger, timeoutUrl),
          `${label}:stranger`,
          callbackDelayMs + 300,
        );
        break;
      }
      case "amount_mismatch":
        deliverLater(
          resultUrl,
          tx.kind === "stk"
            ? stkCallback(tx, { amount: tx.amount + 1 })
            : resultEnvelope(tx, timeoutUrl, { amount: tx.amount + 1 }),
          label,
        );
        break;
      case "interim_then_success":
        if (tx.kind !== "stk")
          deliverLater(
            resultUrl,
            resultEnvelope(tx, timeoutUrl, { resultType: 1 }),
            `${label}:interim`,
          );
        deliverLater(resultUrl, success(), label, callbackDelayMs + 300);
        break;
      case "rejected":
      case "server_error":
        break;
    }
  }

  function outcomeOf(
    kind: Kind,
    scenario: MockScenario,
  ): Pick<Transaction, "status" | "resultCode" | "resultDesc"> {
    if (scenario === "failure")
      return kind === "stk"
        ? { status: "Failed", resultCode: "1032", resultDesc: "Request cancelled by user" }
        : {
            status: "Failed",
            resultCode: "2040",
            resultDesc:
              "Credit Party customer type (Unregistered or Registered Customer) can't be supported by the service.",
          };
    if (scenario === "insufficient_balance")
      return {
        status: "Failed",
        resultCode: "1",
        resultDesc: "The balance is insufficient for the transaction.",
      };
    if (scenario === "invalid_credentials")
      return {
        status: "Failed",
        resultCode: "2001",
        resultDesc: "The initiator information is invalid.",
      };
    if (scenario === "timeout_failed")
      return {
        status: "Failed",
        resultCode: kind === "stk" ? "1032" : "2001",
        resultDesc: "Request cancelled by user",
      };
    return {
      status: "Completed",
      resultCode: "0",
      resultDesc: "The service request is processed successfully.",
    };
  }

  // Handlers ------------------------------------------------------------------------------------

  type Reply = { status: number; body: unknown; delayMs?: number; scenario?: MockScenario | null };
  const gatewayError = (status: number, errorCode: string, errorMessage: string): Reply => ({
    status,
    body: { requestId: `${hex(2)}-${hex(2)}-${hex(4)}`, errorCode, errorMessage },
  });

  function oauth(req: IncomingMessage, url: URL): Reply {
    if (url.searchParams.get("grant_type") !== "client_credentials")
      return gatewayError(400, "400.008.02", "Invalid grant type passed");
    const header = req.headers.authorization ?? "";
    const [scheme, encoded] = header.split(" ");
    const decoded =
      scheme === "Basic" && encoded ? Buffer.from(encoded, "base64").toString("utf8") : "";
    const [key, secret] = decoded.split(":");
    if (!key || !secret)
      return gatewayError(400, "400.008.01", "Invalid authentication type passed");
    const token = randomBytes(21).toString("base64url");
    tokens.set(token, Date.now() + 3_599_000);
    return { status: 200, body: { access_token: token, expires_in: "3599" } };
  }

  function authorised(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const expiry = tokens.get(token);
    return expiry !== undefined && expiry > Date.now();
  }

  function stkPush(body: Json): Reply {
    const shortCode = str(body["BusinessShortCode"]);
    const timestamp = str(body["Timestamp"]);
    const password = Buffer.from(str(body["Password"]), "base64").toString("utf8");
    if (!/^\d{5,9}$/.test(shortCode) || !/^\d{14}$/.test(timestamp))
      return gatewayError(400, "400.002.02", "Bad Request - Invalid BusinessShortCode");
    if (
      !password.startsWith(shortCode) ||
      !password.endsWith(timestamp) ||
      password.length <= shortCode.length + timestamp.length
    )
      return gatewayError(500, "500.001.1001", "Wrong credentials");
    if (!/^254[17]\d{8}$/.test(str(body["PhoneNumber"])) || !str(body["CallBackURL"]))
      return gatewayError(400, "400.002.02", "Bad Request - Invalid PhoneNumber");
    if (str(body["AccountReference"]).length > 12)
      return gatewayError(400, "400.002.02", "Bad Request - Invalid AccountReference");
    const amount = Number(body["Amount"]);
    if (!Number.isInteger(amount) || amount < 1)
      return gatewayError(400, "400.002.02", "Bad Request - Invalid Amount");
    const scenario = pickScenario(amount);
    if (scenario === "rejected")
      return { ...gatewayError(400, "400.002.02", "Bad Request - Invalid PartyA"), scenario };
    const tx: Transaction = {
      kind: "stk",
      amount,
      scenario,
      receipt: receiptId(),
      ...outcomeOf("stk", scenario),
      originatorConversationId: originatorId(),
      conversationId: conversationId(),
      merchantRequestId: merchantId(),
      checkoutRequestId: checkoutId(),
      partyA: str(body["PartyA"]),
      partyB: str(body["PartyB"]),
      phone: str(body["PhoneNumber"]),
    };
    transactions.set(tx.checkoutRequestId!, tx);
    transactions.set(tx.receipt, tx);
    scheduleResults(tx, str(body["CallBackURL"]), "");
    if (scenario === "server_error")
      return { ...gatewayError(500, "500.003.1001", "Internal Server Error"), scenario };
    return {
      status: 200,
      scenario,
      delayMs:
        scenario === "lost_response" || scenario === "result_before_response" ? responseDelayMs : 0,
      body: {
        MerchantRequestID: tx.merchantRequestId,
        CheckoutRequestID: tx.checkoutRequestId,
        ResponseCode: "0",
        ResponseDescription: "Success. Request accepted for processing",
        CustomerMessage: "Success. Request accepted for processing",
      },
    };
  }

  function stkQuery(body: Json): Reply {
    const tx = transactions.get(str(body["CheckoutRequestID"]));
    if (!tx || tx.kind !== "stk")
      return gatewayError(400, "400.002.02", "Bad Request - Invalid CheckoutRequestID");
    return {
      status: 200,
      body: {
        ResponseCode: "0",
        ResponseDescription: "The service request has been accepted successsfully",
        MerchantRequestID: tx.merchantRequestId,
        CheckoutRequestID: tx.checkoutRequestId,
        ResultCode: tx.resultCode,
        ResultDesc: tx.resultDesc,
      },
    };
  }

  function initiatorRequest(kind: "b2c" | "b2b", body: Json): Reply {
    const resultUrl = str(body["ResultURL"]);
    const timeoutUrl = str(body["QueueTimeOutURL"]);
    if (!resultUrl || !timeoutUrl)
      return gatewayError(400, "400.002.02", "Bad Request - Invalid ResultURL");
    const initiator = str(body[kind === "b2c" ? "InitiatorName" : "Initiator"]);
    if (!initiator) return gatewayError(400, "400.002.02", "Bad Request - Invalid Initiator");
    const amount = Number(body["Amount"]);
    if (!Number.isInteger(amount) || amount < 1)
      return gatewayError(400, "400.002.02", "Bad Request - Invalid Amount");
    let originator = str(body["OriginatorConversationID"]);
    if (kind === "b2c") {
      if (!originator)
        return gatewayError(400, "400.002.02", "Bad Request - Invalid OriginatorConversationID");
      if (seenOriginators.has(originator))
        return gatewayError(500, "500.002.1001", "Duplicate OriginatorConversationID.");
      seenOriginators.add(originator);
    } else {
      originator = originatorId();
      if (str(body["AccountReference"]).length > 13)
        return gatewayError(400, "400.002.02", "Bad Request - Invalid AccountReference");
    }
    let scenario = pickScenario(amount);
    if (scenario === "rejected")
      return { ...gatewayError(400, "400.002.02", "Bad Request - Invalid PartyB"), scenario };
    if (!credentialValid(body["SecurityCredential"])) scenario = "invalid_credentials";
    const tx: Transaction = {
      kind,
      amount,
      scenario,
      receipt: receiptId(),
      ...outcomeOf(kind, scenario),
      originatorConversationId: originator,
      conversationId: conversationId(),
      partyA: str(body["PartyA"]),
      partyB: str(body["PartyB"]),
    };
    if (tx.status === "Completed") utilityMinor -= amount * 100;
    transactions.set(originator, tx);
    transactions.set(tx.receipt, tx);
    scheduleResults(tx, resultUrl, timeoutUrl);
    if (scenario === "server_error")
      return { ...gatewayError(500, "500.003.1001", "Internal Server Error"), scenario };
    return {
      status: 200,
      scenario,
      delayMs:
        scenario === "lost_response" || scenario === "result_before_response" ? responseDelayMs : 0,
      body: {
        ConversationID: tx.conversationId,
        OriginatorConversationID: originator,
        ResponseCode: "0",
        ResponseDescription: "Accept the service request successfully.",
      },
    };
  }

  /** Transaction Status, Account Balance and Reversal answer asynchronously on ResultURL. */
  function queryRequest(kind: "status" | "balance" | "reversal", body: Json): Reply {
    const resultUrl = str(body["ResultURL"]);
    if (!resultUrl || !str(body["QueueTimeOutURL"]))
      return gatewayError(400, "400.002.02", "Bad Request - Invalid ResultURL");
    if (!str(body["Initiator"]))
      return gatewayError(400, "400.002.02", "Bad Request - Invalid Initiator");
    const ids = { OriginatorConversationID: originatorId(), ConversationID: conversationId() };
    const valid = credentialValid(body["SecurityCredential"]);
    const failure = (code: string, desc: string) => ({
      Result: {
        ResultType: 0,
        ResultCode: code,
        ResultDesc: desc,
        ...ids,
        TransactionID: "OA90000000",
      },
    });
    let result: unknown;
    if (!valid) result = failure("2001", "The initiator information is invalid.");
    else if (kind === "balance") {
      result = {
        Result: {
          ResultType: "0",
          ResultCode: "0",
          ResultDesc: "The service request is processed successfully",
          ...ids,
          TransactionID: "OA90000000",
          ResultParameters: {
            ResultParameter: [
              {
                Key: "AccountBalance",
                Value: `Working Account|KES|700000.00|700000.00|0.00|0.00&Float Account|KES|0.00|0.00|0.00|0.00&Utility Account|KES|${money(utilityMinor / 100)}|${money(utilityMinor / 100)}|0.00|0.00&Charges Paid Account|KES|-1540.00|-1540.00|0.00|0.00&Organization Settlement Account|KES|0.00|0.00|0.00|0.00`,
              },
              { Key: "BOCompletedTime", Value: nairobi().compact },
            ],
          },
          ReferenceData: {
            ReferenceItem: { Key: "QueueTimeoutURL", Value: str(body["QueueTimeOutURL"]) },
          },
        },
      };
    } else if (kind === "status") {
      const tx =
        transactions.get(str(body["OriginalConversationID"])) ??
        transactions.get(str(body["TransactionID"]));
      if (!tx) result = failure("1", "The transaction could not be found.");
      else
        result = {
          Result: {
            ...ids,
            ReferenceData: { ReferenceItem: { Key: "Occasion" } },
            ResultCode: 0,
            ResultDesc: "The service request is processed successfully.",
            ResultParameters: {
              ResultParameter: [
                {
                  Key: "DebitPartyName",
                  Value:
                    tx.kind === "stk"
                      ? `${tx.phone ?? ""} - MOCK CUSTOMER`
                      : `${tx.partyA} - Mock Daraja Org`,
                },
                {
                  Key: "CreditPartyName",
                  Value:
                    tx.kind === "stk"
                      ? `${tx.partyB} - Mock Daraja Org`
                      : `${tx.partyB} - MOCK RECIPIENT`,
                },
                { Key: "OriginatorConversationID", Value: tx.originatorConversationId },
                { Key: "InitiatedTime", Value: nairobi().compact },
                { Key: "DebitAccountType", Value: "Utility Account" },
                {
                  Key: "DebitPartyCharges",
                  Value: tx.kind === "b2c" ? "Fee For B2C Payment|KES|22.40" : "",
                },
                { Key: "TransactionReason" },
                { Key: "ReasonType", Value: "Business Payment to Customer via API" },
                { Key: "TransactionStatus", Value: tx.status },
                { Key: "FinalisedTime", Value: nairobi().compact },
                { Key: "Amount", Value: String(tx.amount) },
                { Key: "ConversationID", Value: tx.conversationId },
                { Key: "ReceiptNo", Value: tx.status === "Completed" ? tx.receipt : "" },
              ],
            },
            ResultType: 0,
            TransactionID: "OA90000000",
          },
        };
    } else {
      const original = transactions.get(str(body["TransactionID"]));
      const amount = Number(body["Amount"]);
      if (!original || original.status !== "Completed" || original.amount !== amount)
        result = failure("R000002", "The OriginalTransactionID is invalid.");
      else {
        const reversal: Transaction = {
          kind: "reversal",
          amount,
          scenario: "success",
          receipt: receiptId(),
          status: "Completed",
          resultCode: "0",
          resultDesc: "The service request is processed successfully.",
          originatorConversationId: ids.OriginatorConversationID,
          conversationId: ids.ConversationID,
          partyA: str(body["ReceiverParty"]),
          partyB: original.receipt,
        };
        transactions.set(reversal.originatorConversationId, reversal);
        transactions.set(reversal.receipt, reversal);
        result = resultEnvelope(reversal, str(body["QueueTimeOutURL"]));
      }
    }
    deliverLater(resultUrl, result, `${kind}-result`);
    return {
      status: 200,
      body: {
        ...ids,
        ResponseCode: "0",
        ResponseDescription: "Accept the service request successfully.",
      },
    };
  }

  function registerUrls(body: Json): Reply {
    const shortCode = str(body["ShortCode"]);
    const responseType = str(body["ResponseType"]);
    if (!/^\d{5,9}$/.test(shortCode) || !["Completed", "Cancelled"].includes(responseType))
      return gatewayError(400, "400.002.02", "Bad Request - Invalid ShortCode");
    c2bUrls.set(shortCode, {
      confirmation: str(body["ConfirmationURL"]),
      validation: str(body["ValidationURL"]),
      responseType,
    });
    return {
      status: 200,
      body: {
        OriginatorCoversationID: originatorId(),
        ResponseCode: "0",
        ResponseDescription: "Success",
      },
    };
  }

  async function simulateC2b(input: {
    shortCode: string;
    amount: number;
    billRefNumber?: string;
    msisdn?: string;
  }) {
    const urls = c2bUrls.get(input.shortCode);
    const transId = receiptId();
    if (!urls) throw new Error(`No C2B URLs registered for ${input.shortCode}`);
    const msisdn = input.msisdn ?? "254708374126";
    const payload = {
      TransactionType: input.billRefNumber ? "Pay Bill" : "Buy Goods",
      TransID: transId,
      TransTime: nairobi().compact,
      TransAmount: money(input.amount),
      BusinessShortCode: input.shortCode,
      BillRefNumber: input.billRefNumber ?? "",
      InvoiceNumber: "",
      OrgAccountBalance: "",
      ThirdPartyTransID: "",
      MSISDN: `${msisdn.slice(0, 4)} ***** ${msisdn.slice(-3)}`,
      FirstName: "MOCK",
      MiddleName: "",
      LastName: "",
    };
    if (options.externalValidation && urls.validation) {
      const status = await deliver(urls.validation, payload, "c2b-validation");
      if (status === null && urls.responseType === "Cancelled") return { transId };
    }
    utilityMinor += Math.round(input.amount * 100);
    await deliver(
      urls.confirmation,
      { ...payload, OrgAccountBalance: money(utilityMinor / 100) },
      "c2b-confirmation",
    );
    return { transId };
  }

  // Routing -------------------------------------------------------------------------------------

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://mock.local");
    const path = url.pathname;
    const raw = req.method === "POST" ? await readBody(req) : "";
    let body: unknown = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        return json(res, 400, { errorCode: "400.002.05", errorMessage: "Invalid Request Payload" });
      }
    }
    const record = (reply: Reply) =>
      requests.push({
        at: new Date().toISOString(),
        method: req.method ?? "",
        path,
        scenario: reply.scenario ?? null,
        status: reply.status,
        body: redactRequest(body),
      });

    // Admin endpoints (local tooling; never exposed beyond loopback).
    if (path === "/__mock/health") return json(res, 200, { status: "ok" });
    if (path === "/__mock/certificate") {
      res.writeHead(200, { "content-type": "application/x-pem-file" });
      return res.end(certificate.certificatePem);
    }
    if (path === "/__mock/state")
      return json(res, 200, {
        requests,
        callbacks,
        scenarios: SCENARIO_HELP,
        magicAmounts: MAGIC_AMOUNTS,
      });
    if (path === "/__mock/scenario" && req.method === "POST") {
      const scenario = isObject(body) ? body["scenario"] : null;
      if (scenario !== null && !isScenario(scenario))
        return json(res, 400, { error: `scenario must be one of ${MOCK_SCENARIOS.join(", ")}` });
      nextScenario = scenario;
      return json(res, 200, { nextScenario });
    }
    if (path === "/__mock/reset" && req.method === "POST") {
      instance.reset();
      return json(res, 200, { reset: true });
    }
    if (path === "/__mock/c2b" && req.method === "POST" && isObject(body)) {
      try {
        return json(
          res,
          200,
          await simulateC2b({
            shortCode: str(body["shortCode"]),
            amount: Number(body["amount"]),
            ...(body["billRefNumber"] ? { billRefNumber: str(body["billRefNumber"]) } : {}),
          }),
        );
      } catch (error) {
        return json(res, 400, { error: error instanceof Error ? error.message : "failed" });
      }
    }

    if (path === "/oauth/v1/generate" && req.method === "GET") {
      const reply = oauth(req, url);
      record(reply);
      return json(res, reply.status, reply.body);
    }
    if (req.method !== "POST")
      return json(res, 405, { errorCode: "405.001", errorMessage: "Method Not Allowed" });
    if (!authorised(req)) {
      const reply = gatewayError(404, "404.001.03", "Invalid Access Token");
      record(reply);
      return json(res, reply.status, reply.body);
    }
    if (!isObject(body))
      return json(res, 400, { errorCode: "400.002.05", errorMessage: "Invalid Request Payload" });

    let reply: Reply;
    if (path === "/mpesa/stkpush/v1/processrequest") reply = stkPush(body);
    else if (path === "/mpesa/stkpushquery/v1/query") reply = stkQuery(body);
    else if (path === "/mpesa/c2b/v1/registerurl" || path === "/mpesa/c2b/v2/registerurl")
      reply = registerUrls(body);
    else if (path === "/mpesa/c2b/v1/simulate" || path === "/mpesa/c2b/v2/simulate") {
      const result = await simulateC2b({
        shortCode: str(body["ShortCode"]),
        amount: Number(body["Amount"]),
        ...(body["BillRefNumber"] ? { billRefNumber: str(body["BillRefNumber"]) } : {}),
        msisdn: str(body["Msisdn"]) || "254708374126",
      }).catch(() => null);
      reply = result
        ? {
            status: 200,
            body: {
              OriginatorCoversationID: originatorId(),
              ResponseCode: "0",
              ResponseDescription: "Accept the service request successfully.",
            },
          }
        : gatewayError(400, "400.002.02", "Bad Request - Invalid ShortCode");
    } else if (path === "/mpesa/b2c/v3/paymentrequest" || path === "/mpesa/b2c/v1/paymentrequest")
      reply = initiatorRequest("b2c", body);
    else if (path === "/mpesa/b2b/v1/paymentrequest") reply = initiatorRequest("b2b", body);
    else if (path === "/mpesa/transactionstatus/v1/query") reply = queryRequest("status", body);
    else if (path === "/mpesa/accountbalance/v1/query") reply = queryRequest("balance", body);
    else if (path === "/mpesa/reversal/v1/request") reply = queryRequest("reversal", body);
    else reply = gatewayError(404, "404.001.01", "Resource not found");
    record(reply);
    if (reply.delayMs) await sleep(reply.delayMs);
    if (!res.destroyed) json(res, reply.status, reply.body);
  }

  const server: Server = createServer((req, res) => {
    route(req, res).catch((error: unknown) => {
      log(`mock error: ${String(error)}`);
      if (!res.headersSent)
        json(res, 500, { errorCode: "500.003.1001", errorMessage: "Internal Server Error" });
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve),
  );
  const port = (server.address() as AddressInfo).port;

  const instance: MockDaraja = {
    url: `http://${options.host ?? "127.0.0.1"}:${port}`,
    port,
    certificatePem: certificate.certificatePem,
    requests,
    callbacks,
    setNextScenario(scenario) {
      nextScenario = scenario;
    },
    simulateC2b,
    waitForCallbacks(count, timeoutMs = 10_000) {
      if (callbacks.length >= count) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const waiter = { count, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) {
            waiters.splice(index, 1);
            reject(new Error(`Expected ${count} callbacks, saw ${callbacks.length}`));
          }
        }, timeoutMs).unref();
      });
    },
    reset() {
      requests.length = 0;
      callbacks.length = 0;
      transactions.clear();
      seenOriginators.clear();
      nextScenario = null;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
    async close() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  return instance;
}
