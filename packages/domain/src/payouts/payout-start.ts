import type { PayoutBlockReason, TariffBand } from "@pm-buddy/types";
import { parseClock } from "../attendance/time.js";
import type { ProviderBalance } from "../payments/callbacks.js";
import { tariffCharge } from "./tariff.js";

/**
 * Starting payouts for a batch (D4.3 §6; THREAT_MODEL A-05, A-08, A-17; ARCHITECTURE §14.3, §14.5).
 * Never automatic: a person with `payments.disburse` starts it with step-up after a fresh float
 * check (owner decision 4). The API reads every fact in one transaction holding the company lock
 * and acts on the plan all-or-nothing, so two simultaneous starts cannot both pay an obligation.
 */

/** Minutes after midnight on the Africa/Nairobi wall clock at `at`. */
export function nairobiMinutesOfDay(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return value("hour") * 60 + value("minute");
}

/**
 * Whether `at` falls in the business-hours window (`HH:MM`, Africa/Nairobi): the start is
 * inside, the end outside. Malformed times count as outside (nothing is sent by mistake).
 */
export function isWithinBusinessHours(at: Date, start: string, end: string): boolean {
  const from = parseClock(start);
  const to = parseClock(end);
  if (from === null || to === null || from >= to) return false;
  const now = nairobiMinutesOfDay(at);
  return now >= from && now < to;
}

/** The B2C float: the `Utility Account` balance of a D4.2 Account Balance answer. */
export function utilityBalanceMinor(balances: readonly ProviderBalance[] | null): number | null {
  const utility = balances?.find((balance) => /utility/i.test(balance.account));
  return utility?.availableMinor ?? null;
}

/** The latest answered Account Balance query (D4.2) for the company. */
export type FloatBalance = { answeredAt: string; availableMinor: number | null };

export type FloatFigures = {
  /** The utility balance when the float check was answered. */
  availableMinor: number;
  /** Payroll payouts created after that answer and not failed (amounts and charges). */
  inFlightMinor: number;
  /** Σ outstanding amounts about to be paid. */
  amountsMinor: number;
  /** Σ tariff charges estimated for them. */
  chargesMinor: number;
  requiredMinor: number;
  shortfallMinor: number;
  answeredAt: string;
};

/** One obligation considered by a start, with its block reasons now (empty = eligible). */
export type StartCandidate = {
  obligationId: string;
  outstandingMinor: number;
  reasons: readonly PayoutBlockReason[];
};

export type StartInput = {
  payoutsEnabled: boolean;
  now: Date;
  candidates: readonly StartCandidate[];
  balance: FloatBalance | null;
  floatCheckMaxAgeMinutes: number;
  inFlightMinor: number;
  /** The B2C tariff bands in force on the payout date. */
  bands: readonly TariffBand[] | null;
  dailyLimitMinor: number;
  /** Today's (Africa/Nairobi) payout attempts that are not failed (D4.2 daily limit). */
  usedTodayMinor: number;
  businessHoursStart: string;
  businessHoursEnd: string;
};

export type Ineligible = { obligationId: string; reasons: readonly PayoutBlockReason[] };

export type PlannedPayout = { obligationId: string; amountMinor: number; chargeMinor: number };

export type StartPlan =
  | { ok: false; code: "payouts-paused" }
  | { ok: false; code: "nothing-eligible"; ineligible: Ineligible[] }
  | {
      ok: false;
      code: "float-check-required";
      answeredAt: string | null;
      ageMinutes: number | null;
      maxAgeMinutes: number;
    }
  | { ok: false; code: "tariff-missing"; obligationIds: string[] }
  | { ok: false; code: "insufficient-float"; figures: FloatFigures }
  | {
      ok: false;
      code: "daily-limit-exceeded";
      dailyLimitMinor: number;
      usedTodayMinor: number;
      amountsMinor: number;
    }
  | {
      ok: true;
      outcome: "outside_business_hours";
      /** Each eligible obligation gets an open `outside_business_hours` flag; nothing is sent. */
      flagObligationIds: string[];
      ineligible: Ineligible[];
    }
  | {
      ok: true;
      outcome: "submit";
      payouts: PlannedPayout[];
      ineligible: Ineligible[];
      figures: FloatFigures;
    };

/**
 * Decides a payout start (§6), in this order: payouts paused (409 `payouts-paused`); nothing
 * eligible (409 `nothing-eligible`); no float answer within the maximum age (409
 * `float-check-required`); a payout the tariff cannot price (409 `tariff-missing`); utility
 * available − in-flight < Σ amounts + Σ charges (409 `insufficient-float`, with the figures); the
 * D4.2 daily limit (409 `daily-limit-exceeded`); outside business hours the eligible obligations
 * are flagged instead (200, nothing sent); otherwise one payout per eligible obligation for its
 * whole outstanding amount.
 */
export function planPayoutStart(input: StartInput): StartPlan {
  if (!input.payoutsEnabled) return { ok: false, code: "payouts-paused" };
  const ineligible: Ineligible[] = input.candidates
    .filter((candidate) => candidate.reasons.length > 0)
    .map((candidate) => ({ obligationId: candidate.obligationId, reasons: candidate.reasons }));
  const eligible = input.candidates
    .filter((candidate) => candidate.reasons.length === 0 && candidate.outstandingMinor > 0)
    .sort((a, b) =>
      a.obligationId < b.obligationId ? -1 : a.obligationId > b.obligationId ? 1 : 0,
    );
  if (!eligible.length) return { ok: false, code: "nothing-eligible", ineligible };

  const answeredAt = input.balance?.answeredAt ?? null;
  const ageMinutes =
    answeredAt === null ? null : (input.now.getTime() - Date.parse(answeredAt)) / 60_000;
  if (
    !input.balance ||
    input.balance.availableMinor === null ||
    ageMinutes === null ||
    Number.isNaN(ageMinutes) ||
    ageMinutes < 0 ||
    ageMinutes > input.floatCheckMaxAgeMinutes
  )
    return {
      ok: false,
      code: "float-check-required",
      answeredAt,
      ageMinutes: ageMinutes === null || Number.isNaN(ageMinutes) ? null : Math.floor(ageMinutes),
      maxAgeMinutes: input.floatCheckMaxAgeMinutes,
    };

  const payouts: PlannedPayout[] = [];
  const unpriced: string[] = [];
  for (const candidate of eligible) {
    const charge = input.bands ? tariffCharge(input.bands, candidate.outstandingMinor) : null;
    if (charge === null) unpriced.push(candidate.obligationId);
    else
      payouts.push({
        obligationId: candidate.obligationId,
        amountMinor: candidate.outstandingMinor,
        chargeMinor: charge,
      });
  }
  if (unpriced.length) return { ok: false, code: "tariff-missing", obligationIds: unpriced };

  const amountsMinor = payouts.reduce((total, payout) => total + payout.amountMinor, 0);
  const chargesMinor = payouts.reduce((total, payout) => total + payout.chargeMinor, 0);
  const requiredMinor = amountsMinor + chargesMinor;
  const spare = input.balance.availableMinor - input.inFlightMinor;
  const figures: FloatFigures = {
    availableMinor: input.balance.availableMinor,
    inFlightMinor: input.inFlightMinor,
    amountsMinor,
    chargesMinor,
    requiredMinor,
    shortfallMinor: Math.max(0, requiredMinor - spare),
    answeredAt: input.balance.answeredAt,
  };
  if (spare < requiredMinor) return { ok: false, code: "insufficient-float", figures };
  if (input.usedTodayMinor + amountsMinor > input.dailyLimitMinor)
    return {
      ok: false,
      code: "daily-limit-exceeded",
      dailyLimitMinor: input.dailyLimitMinor,
      usedTodayMinor: input.usedTodayMinor,
      amountsMinor,
    };
  if (!isWithinBusinessHours(input.now, input.businessHoursStart, input.businessHoursEnd))
    return {
      ok: true,
      outcome: "outside_business_hours",
      flagObligationIds: eligible.map((candidate) => candidate.obligationId),
      ineligible,
    };
  return { ok: true, outcome: "submit", payouts, ineligible, figures };
}
