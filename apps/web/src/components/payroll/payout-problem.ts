"use client";

import { useTranslations } from "next-intl";
import { PAYOUT_PROBLEMS, type PayoutProblem } from "@pm-buddy/types";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { formatKES } from "@/lib/format";
import { LiveApiError } from "@/lib/live-api";

/** The action a refusal answered: maker-checker explains who must act instead. */
export type PayoutAction =
  | "review"
  | "approve"
  | "destination"
  | "flag"
  | "confirm"
  | "verify"
  | "resolve";

type Facts = LiveApiError["facts"];
const amount = (facts: Facts, key: string) => {
  const value = facts?.[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? formatKES(value) : null;
};
const count = (facts: Facts, key: string) => {
  const value = facts?.[key];
  return typeof value === "number" ? value : null;
};

/**
 * EN/SW text for a refused D4.3 command: the stable problem code, with the safe figures of its
 * `facts` when the API sent them (limit and net, float figures, the cash cap). Codes outside the
 * D4.3 list fall back to the shared API messages.
 */
export function usePayoutProblem(action?: PayoutAction) {
  const t = useTranslations("payouts");
  const generic = useProblemMessage("payroll");
  return (error: unknown): string => {
    if (
      !(error instanceof LiveApiError) ||
      !(PAYOUT_PROBLEMS as readonly string[]).includes(error.code)
    )
      return generic(error);
    const code = error.code as PayoutProblem;
    const facts = error.facts;
    if (code === "maker-checker" && action) return t(`makerChecker.${action}`);
    if (code === "approval-limit-exceeded") {
      const limit = amount(facts, "limitMinor");
      const net = amount(facts, "netMinor");
      if (limit && net) return t("problemFacts.approvalLimit", { limit, net });
    }
    if (code === "unverified-recipients" && Array.isArray(facts?.labourerIds))
      return t("problemFacts.unverified", { count: facts.labourerIds.length });
    if (code === "insufficient-float") {
      const available = amount(facts, "availableMinor");
      const inFlight = amount(facts, "inFlightMinor");
      const required = amount(facts, "requiredMinor");
      const shortfall = amount(facts, "shortfallMinor");
      if (available && inFlight && required && shortfall)
        return t("problemFacts.insufficientFloat", { available, inFlight, required, shortfall });
    }
    if (code === "float-check-required") {
      const age = count(facts, "ageMinutes");
      const max = count(facts, "maxAgeMinutes");
      if (age !== null && max !== null) return t("problemFacts.floatAge", { age, max });
    }
    if (code === "daily-limit-exceeded") {
      const limit = amount(facts, "dailyLimitMinor");
      const used = amount(facts, "usedTodayMinor");
      if (limit && used) return t("problemFacts.dailyLimit", { limit, used });
    }
    if (code === "cash-cap-exceeded") {
      const cap = amount(facts, "capMinor");
      const used = amount(facts, "usedMinor");
      if (cap && used) return t("problemFacts.cashCap", { cap, used });
    }
    if (code === "amount-above-outstanding") {
      const outstanding = amount(facts, "outstandingMinor");
      if (outstanding) return t("problemFacts.aboveOutstanding", { outstanding });
    }
    return t(`problems.${code}`);
  };
}
