import type { CallbackKind, QuarantineReason } from "@pm-buddy/types";
import { parseProviderAmount } from "./amounts.js";

/**
 * Daraja callback parsing (D4.2). Shapes follow the official Daraja documentation retrieved on
 * 11/11/2026 (developer.safaricom.co.ke, see docs/ARCHITECTURE.md §4.5): the STK `Body.stkCallback`
 * envelope, the `Result` envelope shared by B2C, B2B, Transaction Status, Account Balance and
 * Reversal results, and the flat C2B validation/confirmation body. Daraja callbacks carry no
 * signature, so a parsed callback is only a claim until it matches stored request identifiers and
 * passes verification.
 */

export type CallbackIdentifiers = {
  merchantRequestId?: string;
  checkoutRequestId?: string;
  originatorConversationId?: string;
  conversationId?: string;
};

/**
 * `success`/`failure` are definitive outcomes for the matched request; `in_progress` is a
 * `ResultType` 1 interim message; `timeout` is a QueueTimeOutURL notification (never treated as
 * failure); `information` is a validation request or a query answer.
 */
export type CallbackOutcome = "success" | "failure" | "in_progress" | "timeout" | "information";

export type ProviderBalance = {
  account: string;
  currency: string;
  availableMinor: number | null;
};

export type ParsedCallback = {
  kind: CallbackKind;
  identifiers: CallbackIdentifiers;
  resultCode: string | null;
  resultDesc: string | null;
  outcome: CallbackOutcome;
  amountMinor: number | null;
  currency: string | null;
  receipt: string | null;
  shortcode: string | null;
  completedAt: string | null;
  billReference: string | null;
  /** Transaction Status answers describe another transaction. */
  original: {
    originatorConversationId: string | null;
    conversationId: string | null;
    receipt: string | null;
    amountMinor: number | null;
    status: string | null;
    debitParty: string | null;
    creditParty: string | null;
  } | null;
  balances: ProviderBalance[] | null;
};

export type ParseResult =
  | { ok: true; value: ParsedCallback }
  | { ok: false; reason: Extract<QuarantineReason, "malformed" | "unsupported"> };

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const MAX_ID = 100;

/** An identifier or code as a short trimmed string; numbers are accepted (Daraja mixes both). */
function text(value: unknown, max = MAX_ID): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

const description = (value: unknown): string | null =>
  typeof value === "string" ? value.trim().slice(0, 300) || null : null;

/** `ResultParameter` / `Item` lists arrive as an array or, for a single entry, an object. */
function entries(list: unknown, keyName: "Key" | "Name"): Map<string, unknown> {
  const map = new Map<string, unknown>();
  const items = Array.isArray(list) ? list : isObject(list) ? [list] : [];
  for (const item of items) {
    if (!isObject(item)) continue;
    const key = typeof item[keyName] === "string" ? (item[keyName] as string) : null;
    if (key && !map.has(key)) map.set(key, item["Value"]);
  }
  return map;
}

function identifiers(source: Json): CallbackIdentifiers {
  const out: CallbackIdentifiers = {};
  const merchant = text(source["MerchantRequestID"]);
  const checkout = text(source["CheckoutRequestID"]);
  const originator = text(source["OriginatorConversationID"]);
  const conversation = text(source["ConversationID"]);
  if (merchant) out.merchantRequestId = merchant;
  if (checkout) out.checkoutRequestId = checkout;
  if (originator) out.originatorConversationId = originator;
  if (conversation) out.conversationId = conversation;
  return out;
}

const base = (kind: CallbackKind): ParsedCallback => ({
  kind,
  identifiers: {},
  resultCode: null,
  resultDesc: null,
  outcome: "information",
  amountMinor: null,
  currency: null,
  receipt: null,
  shortcode: null,
  completedAt: null,
  billReference: null,
  original: null,
  balances: null,
});

/** "600310 - Safaricom333" or "254708374149 - John Doe" → the leading party number. */
export function partyNumber(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^\s*(\d{5,12})\b/.exec(value);
  return match ? match[1]! : null;
}

/** "Utility Account|KES|228037.00|228037.00|0.00|0.00&Working Account|KES|…" */
export function parseBalances(value: unknown): ProviderBalance[] | null {
  if (typeof value !== "string" || value.length > 4_000) return null;
  const balances: ProviderBalance[] = [];
  for (const part of value.split("&")) {
    const [account, currency, , available] = part.split("|");
    if (!account || !currency) return null;
    balances.push({
      account: account.trim().slice(0, 60),
      currency: currency.trim().slice(0, 3),
      availableMinor: parseProviderAmount(available ?? null),
    });
  }
  return balances.length > 0 ? balances : null;
}

/** "Utility Account|KES|…" → "KES" (the only place most results state a currency). */
const currencyOfBalance = (value: unknown): string | null => parseBalances(value)?.[0]?.currency ?? null;

function parseStk(body: Json): ParseResult {
  const envelope = isObject(body["Body"]) ? (body["Body"] as Json) : null;
  const callback = envelope && isObject(envelope["stkCallback"]) ? envelope["stkCallback"] : null;
  if (!isObject(callback)) return { ok: false, reason: "malformed" };
  const result = base("stk");
  result.identifiers = identifiers(callback);
  if (!result.identifiers.checkoutRequestId || !result.identifiers.merchantRequestId)
    return { ok: false, reason: "malformed" };
  result.resultCode = text(callback["ResultCode"], 20);
  result.resultDesc = description(callback["ResultDesc"]);
  if (result.resultCode === null) return { ok: false, reason: "malformed" };
  result.outcome = result.resultCode === "0" ? "success" : "failure";
  if (result.outcome === "success") {
    const metadata = isObject(callback["CallbackMetadata"]) ? callback["CallbackMetadata"] : {};
    const items = entries((metadata as Json)["Item"], "Name");
    result.amountMinor = parseProviderAmount(items.get("Amount"));
    result.receipt = text(items.get("MpesaReceiptNumber"), 30);
    result.completedAt = text(items.get("TransactionDate"), 20);
  }
  return { ok: true, value: result };
}

function parseResultEnvelope(kind: CallbackKind, body: Json): ParseResult {
  const envelope = body["Result"];
  if (!isObject(envelope)) {
    // QueueTimeOutURL notifications are not documented; keep whatever identifiers they carry.
    if (kind === "timeout") {
      const result = base(kind);
      result.identifiers = identifiers(body);
      result.outcome = "timeout";
      return { ok: true, value: result };
    }
    return { ok: false, reason: "malformed" };
  }
  const result = base(kind);
  result.identifiers = identifiers(envelope);
  result.resultCode = text(envelope["ResultCode"], 20);
  result.resultDesc = description(envelope["ResultDesc"]);
  if (kind === "timeout") {
    result.outcome = "timeout";
    return { ok: true, value: result };
  }
  if (!result.identifiers.originatorConversationId && !result.identifiers.conversationId)
    return { ok: false, reason: "malformed" };
  if (result.resultCode === null) return { ok: false, reason: "malformed" };
  const resultType = text(envelope["ResultType"], 5);
  const params = entries(
    isObject(envelope["ResultParameters"])
      ? (envelope["ResultParameters"] as Json)["ResultParameter"]
      : undefined,
    "Key",
  );
  const transactionId = text(envelope["TransactionID"], 30);
  if (resultType === "1") result.outcome = "in_progress";
  else result.outcome = result.resultCode === "0" ? "success" : "failure";

  switch (kind) {
    case "b2c_result":
      if (result.outcome === "success") {
        result.amountMinor = parseProviderAmount(params.get("TransactionAmount"));
        result.receipt = text(params.get("TransactionReceipt"), 30) ?? transactionId;
        result.completedAt = text(params.get("TransactionCompletedDateTime"), 30);
      }
      break;
    case "b2b_result":
      if (result.outcome === "success") {
        result.amountMinor = parseProviderAmount(params.get("Amount"));
        result.receipt = transactionId;
        result.currency = text(params.get("Currency"), 3);
        result.completedAt = text(params.get("TransCompletedTime"), 20);
      }
      break;
    case "reversal_result":
      if (result.outcome === "success") {
        result.amountMinor = parseProviderAmount(params.get("Amount"));
        result.receipt = transactionId;
        result.currency = currencyOfBalance(params.get("DebitAccountBalance"));
        result.shortcode = partyNumber(params.get("DebitPartyPublicName"));
        result.completedAt = text(params.get("TransCompletedTime"), 20);
      }
      break;
    case "status_result":
      // The query answer: success means M-Pesa reported on the original transaction.
      if (result.outcome === "success") result.outcome = "information";
      result.original = {
        originatorConversationId: text(params.get("OriginatorConversationID")),
        conversationId: text(params.get("ConversationID")),
        receipt: text(params.get("ReceiptNo"), 30),
        amountMinor: parseProviderAmount(params.get("Amount")),
        status: text(params.get("TransactionStatus"), 40),
        debitParty: partyNumber(params.get("DebitPartyName")),
        creditParty: partyNumber(params.get("CreditPartyName")),
      };
      break;
    case "balance_result":
      if (result.outcome === "success") {
        result.outcome = "information";
        result.balances = parseBalances(params.get("AccountBalance"));
        if (!result.balances) return { ok: false, reason: "malformed" };
      }
      break;
    default:
      return { ok: false, reason: "unsupported" };
  }
  return { ok: true, value: result };
}

function parseC2b(kind: "c2b_validation" | "c2b_confirmation", body: Json): ParseResult {
  const result = base(kind);
  result.receipt = text(body["TransID"], 30);
  result.amountMinor = parseProviderAmount(body["TransAmount"]);
  result.shortcode = text(body["BusinessShortCode"], 12);
  result.billReference = text(body["BillRefNumber"], 40);
  result.completedAt = text(body["TransTime"], 20);
  if (!result.receipt || result.amountMinor === null || !result.shortcode)
    return { ok: false, reason: "malformed" };
  result.outcome = kind === "c2b_confirmation" ? "success" : "information";
  return { ok: true, value: result };
}

/** Parses a JSON callback body of `kind` into normalised, size-bounded evidence. */
export function parseCallback(kind: CallbackKind, body: unknown): ParseResult {
  if (!isObject(body)) return { ok: false, reason: "malformed" };
  switch (kind) {
    case "stk":
      return parseStk(body);
    case "c2b_validation":
    case "c2b_confirmation":
      return parseC2b(kind, body);
    default:
      return parseResultEnvelope(kind, body);
  }
}

const PERSONAL_KEYS = /phone|msisdn|firstname|middlename|lastname|publicname|partyname/i;
const MSISDN = /(?<!\d)(254|0)(7|1)\d{8}(?!\d)/g;

const maskNumber = (digits: string) => `${digits.slice(0, 4)}•••••${digits.slice(-3)}`;

/**
 * Removes personal data from a callback for ordinary display (brief §15 F): names are dropped,
 * phone numbers masked; identifiers, codes and amounts stay. The raw body is kept only encrypted.
 */
export function redactCallbackBody(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactCallbackBody(item));
  if (isObject(value)) {
    // { Key/Name: "PhoneNumber", Value: … } pairs carry the field name in a sibling.
    const label =
      typeof value["Key"] === "string"
        ? value["Key"]
        : typeof value["Name"] === "string"
          ? value["Name"]
          : "";
    const out: Json = {};
    for (const [name, entry] of Object.entries(value).slice(0, 50)) {
      out[name] = name === "Value" && label ? redactCallbackBody(entry, label) : redactCallbackBody(entry, name);
    }
    return out;
  }
  if (typeof value === "string" || typeof value === "number") {
    const textValue = String(value);
    if (PERSONAL_KEYS.test(key)) {
      const party = /^\s*(\d{5,12})\b/.exec(textValue)?.[1];
      if (party && party.length >= 10) return maskNumber(party);
      if (party) return party;
      return /\d/.test(textValue) ? textValue.replace(/\d(?=\d{3})/g, "•") : "[redacted]";
    }
    if (typeof value === "string") return textValue.slice(0, 300).replace(MSISDN, (match) => maskNumber(match));
    return value;
  }
  return value;
}
