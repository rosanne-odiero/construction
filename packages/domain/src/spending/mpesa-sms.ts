import { MPESA_OUTFLOW_KINDS, SPENDING_LIMITS, type MpesaSmsKind } from "@pm-buddy/types";

/**
 * M-Pesa confirmation SMS parser (brief §5.8, §15 D). A pasted message becomes a DRAFT expense or
 * payment record: transaction code, kind, amount, counterparty, date and time, and the balance and
 * transaction cost when present. **A parsed message never confirms settlement**: anyone can type
 * or edit an SMS, so the result is labelled `confirmsSettlement: false` and is only a starting
 * point that a person checks and approves. Phone numbers are masked in the result (only the first
 * four and last three digits are kept) and the raw text is never stored.
 *
 * Recognised wording (synthetic examples in `spending.test.ts`): Safaricom's English messages for
 * money sent, Pay Bill, Buy Goods (till), money received and agent withdrawals, and the Kiswahili
 * equivalents ("Imethibitishwa", "imetumwa kwa", "kwa akaunti", "imelipwa kwa", "Umepokea …
 * kutoka", "umetoa"). Wording varies between handsets and over time, so the parser looks for
 * keywords rather than one exact template, and reports what it could not find as warnings instead
 * of guessing. The Kiswahili templates are reconstructed and need checking against real messages
 * (COMPLIANCE_TODO CR-SPD-03).
 */

export type MpesaSmsDraft = {
  kind: MpesaSmsKind;
  language: "en" | "sw";
  /** The 10-character M-Pesa transaction code (uppercase letters and digits). */
  code: string;
  amountMinor: number;
  /** The business or person named in the message (as written, trimmed). */
  counterpartyName: string | null;
  /** A phone number in the message, masked (e.g. 0712***678); never the full number. */
  counterpartyPhoneMasked: string | null;
  /** The account number of a Pay Bill payment, or the agent number of a withdrawal. */
  account: string | null;
  /** The message's local date (Africa/Nairobi) and time, as written. */
  occurredOn: string | null;
  occurredAt: string | null;
  /** The sender's M-Pesa balance after the transaction, when the message gives it. */
  balanceMinor: number | null;
  /** The M-Pesa transaction charge, when the message gives it. */
  chargeMinor: number | null;
  /** Money left the account (an expense draft) or came in (`received`). */
  direction: "out" | "in";
  /** Always false: SMS text is evidence to check, never proof that money moved (brief §15 D). */
  confirmsSettlement: false;
};

export type MpesaSmsWarning = "no_counterparty" | "no_date" | "no_balance" | "no_charge";
export type MpesaSmsError = "empty" | "too_long" | "no_code" | "unrecognised" | "no_amount";

export type MpesaSmsResult =
  | { ok: true; draft: MpesaSmsDraft; warnings: MpesaSmsWarning[] }
  | { ok: false; error: MpesaSmsError };

const CODE = /\b([A-Z0-9]{10})\b\s*(?:Confirmed|Imethibitishwa)/i;
// "Ksh1,250.00", "KES 1250", "Kshs.300": commas in thousands, up to two decimals.
const MONEY_SOURCE = String.raw`(?:Kshs?|KES)\.?\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)`;
const DATE_TIME =
  /(?:\bon\b|\btarehe\b)\s*(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\s*(?:\bat\b|\bsaa\b)\s*(\d{1,2}):(\d{2})\s*(AM|PM)?/i;
const BALANCE = /(?:balance\s+is|salio\s+lako\s+jipya\s+la\s+m-?pesa\s+ni|salio\s+ni)\s*/i;
const CHARGE = /(?:transaction\s+cost,?|gharama\s+ya\s+(?:kutuma|kutoa|kulipa|muamala)\s+ni)\s*/i;
const PHONE = /(?:\+?254|\b0)[17](?:\s?[\d*]){6,9}$/;

/** Collapses whitespace (pasted messages wrap), without changing the characters themselves. */
const tidy = (text: string) => text.replace(/\s+/g, " ").trim();

/** "1,250.50" → 125050 minor units, exactly (string arithmetic, never floats). */
export function parseKesAmount(text: string): number | null {
  const match = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const whole = match[1]!.replaceAll(",", "");
  const cents = (match[2] ?? "").padEnd(2, "0");
  const value = BigInt(whole) * 100n + BigInt(cents);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

/** Keeps the first four and last three digits of a Kenyan phone number (0712***678). */
export function maskPhoneNumber(text: string): string | null {
  const digits = text.replace(/[^\d*]/g, "");
  const local = digits.startsWith("254") ? `0${digits.slice(3)}` : digits;
  if (!/^0[17][\d*]{6,9}$/.test(local) || !/\d{3}$/.test(local)) return null;
  return `${local.slice(0, 4)}***${local.slice(-3)}`;
}

/** The first amount within a few characters after `marker`. */
function amountAfter(text: string, marker: RegExp): number | null {
  const found = marker.exec(text);
  if (!found) return null;
  const rest = text.slice(found.index + found[0].length);
  const money = new RegExp(MONEY_SOURCE, "i").exec(rest);
  if (!money || money.index > 3) return null;
  return parseKesAmount(money[1]!);
}

function localDateTime(text: string): { date: string; time: string } | null {
  const match = DATE_TIME.exec(text);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = match[3]!.length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
  let hour = Number(match[4]);
  const minute = Number(match[5]);
  const meridiem = match[6]?.toUpperCase();
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "AM" && hour === 12) hour = 0;
    if (meridiem === "PM" && hour !== 12) hour += 12;
  }
  if (hour > 23 || minute > 59 || month < 1 || month > 12 || day < 1) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  const pad = (value: number) => String(value).padStart(2, "0");
  return { date: `${year}-${pad(month)}-${pad(day)}`, time: `${pad(hour)}:${pad(minute)}` };
}

function kindOf(text: string): MpesaSmsKind | null {
  if (/withdraw\s*(?:Kshs?|KES)|\bumetoa\b/i.test(text)) return "withdraw";
  if (/you have received|\bumepokea\b/i.test(text)) return "received";
  if (/\bsent to\b.*\bfor account\b|\bimetumwa kwa\b.*\bkwa akaunti\b/i.test(text))
    return "paybill";
  if (/\bpaid to\b|\bimelipwa kwa\b/i.test(text)) return "till";
  if (/\bsent to\b|\bimetumwa kwa\b/i.test(text)) return "sent";
  return null;
}

/** The text between a start marker and the first end marker after it. */
function between(text: string, start: RegExp, end: RegExp): string | null {
  const opened = start.exec(text);
  if (!opened) return null;
  const rest = text.slice(opened.index + opened[0].length);
  const closed = end.exec(rest);
  const value = (closed ? rest.slice(0, closed.index) : rest).trim().replace(/[.,\s]+$/, "");
  return value ? value : null;
}

const UNTIL_DATE = /\.?\s*\b(?:on|tarehe)\s*\d{1,2}\/\d{1,2}\/\d{2,4}/i;
const UNTIL_BALANCE = /\.?\s*(?:New M-?PESA balance|Salio)\b/i;
const UNTIL_DATE_OR_BALANCE = new RegExp(`${UNTIL_DATE.source}|${UNTIL_BALANCE.source}`, "i");

/** Splits "JOHN KAMAU 0712345678" into the name and a masked phone. */
function namedParty(value: string | null): { name: string | null; phone: string | null } {
  if (!value) return { name: null, phone: null };
  const phone = PHONE.exec(value);
  if (!phone) return { name: value, phone: null };
  const name = value
    .slice(0, phone.index)
    .trim()
    .replace(/[-–,\s]+$/, "");
  return { name: name || null, phone: maskPhoneNumber(phone[0]) };
}

type Party = { name: string | null; phone: string | null; account: string | null };

function counterparty(kind: MpesaSmsKind, text: string): Party {
  switch (kind) {
    case "paybill":
      return {
        name: between(text, /\bsent to\s+|\bimetumwa kwa\s+/i, /\s+(?:for account|kwa akaunti)\b/i),
        phone: null,
        account: between(
          text,
          /\bfor account\s+|\bkwa akaunti(?:\s+nambari)?\s+/i,
          UNTIL_DATE_OR_BALANCE,
        ),
      };
    case "till":
      return {
        name: between(text, /\bpaid to\s+|\bimelipwa kwa\s+/i, UNTIL_DATE_OR_BALANCE),
        phone: null,
        account: null,
      };
    case "sent":
      return {
        ...namedParty(between(text, /\bsent to\s+|\bimetumwa kwa\s+/i, UNTIL_DATE_OR_BALANCE)),
        account: null,
      };
    case "received":
      return {
        ...namedParty(between(text, /\s(?:from|kutoka)\s+/i, UNTIL_DATE_OR_BALANCE)),
        account: null,
      };
    case "withdraw": {
      const agent = between(text, /\s(?:from|kutoka)\s+/i, UNTIL_DATE_OR_BALANCE);
      const split = agent ? /^(\d{3,8})\s*-\s*(.+)$/.exec(agent) : null;
      return {
        name: split ? split[2]!.trim() : agent,
        phone: null,
        account: split ? split[1]! : null,
      };
    }
  }
}

/**
 * Parses a pasted M-Pesa confirmation. Returns a draft (never a confirmation of settlement) or the
 * reason it is not a recognisable M-Pesa message. Input is limited to
 * `SPENDING_LIMITS.smsMaxLength` characters (code points).
 */
export function parseMpesaSms(input: string): MpesaSmsResult {
  if (Array.from(input).length > SPENDING_LIMITS.smsMaxLength)
    return { ok: false, error: "too_long" };
  const text = tidy(input.normalize("NFKC"));
  if (!text) return { ok: false, error: "empty" };
  const code = CODE.exec(text);
  if (!code || !/[A-Z]/i.test(code[1]!)) return { ok: false, error: "no_code" };
  const kind = kindOf(text);
  if (!kind) return { ok: false, error: "unrecognised" };
  // The transaction amount is the first amount after the code (a withdrawal states its date
  // first, then the amount); the balance and the charge are read from their own markers.
  const first = new RegExp(MONEY_SOURCE, "i").exec(text.slice(code.index + code[0].length));
  const amountMinor = first ? parseKesAmount(first[1]!) : null;
  if (amountMinor === null || amountMinor <= 0) return { ok: false, error: "no_amount" };
  const when = localDateTime(text);
  const party = counterparty(kind, text);
  const balanceMinor = amountAfter(text, BALANCE);
  const chargeMinor = amountAfter(text, CHARGE);
  const language = /imethibitishwa|imetumwa|umepokea|imelipwa|umetoa|salio|tarehe/i.test(text)
    ? "sw"
    : "en";
  const warnings: MpesaSmsWarning[] = [];
  if (!party.name) warnings.push("no_counterparty");
  if (!when) warnings.push("no_date");
  if (balanceMinor === null) warnings.push("no_balance");
  if (chargeMinor === null && kind !== "received") warnings.push("no_charge");
  return {
    ok: true,
    warnings,
    draft: {
      kind,
      language,
      code: code[1]!.toUpperCase(),
      amountMinor,
      counterpartyName: party.name,
      counterpartyPhoneMasked: party.phone,
      account: party.account,
      occurredOn: when?.date ?? null,
      occurredAt: when ? `${when.date}T${when.time}:00+03:00` : null,
      balanceMinor,
      chargeMinor,
      direction: (MPESA_OUTFLOW_KINDS as readonly MpesaSmsKind[]).includes(kind) ? "out" : "in",
      confirmsSettlement: false,
    },
  };
}

/** A transaction code as typed: trimmed and uppercased; null unless it looks like one. */
export function normaliseMpesaCode(value: string): string | null {
  const code = value.trim().toUpperCase();
  return /^[A-Z0-9]{10}$/.test(code) && /[A-Z]/.test(code) ? code : null;
}
