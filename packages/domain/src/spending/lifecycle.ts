import type { BudgetAction, BudgetStatus, TopUpStatus } from "@pm-buddy/types";
import type { TransitionTable } from "../procurement/lifecycle.js";

/**
 * Spending state machines (docs/WORKFLOWS.md "Budgets" and "Petty cash", brief §15 C). Each table
 * is enforced by the API and repeated by a database trigger in migration `20261121090000_spending`
 * (`app.guard_budget`, `app.guard_petty_cash_top_up`), so a bypassed API check cannot skip a state.
 */

/**
 * Budgets: draft → submitted → approved (finance.manage + step-up, never a contributor);
 * submitted → draft when returned (reason); draft or submitted → cancelled (reason). An approved
 * version never changes; a new version replaces it when approved.
 */
export const BUDGET_TRANSITIONS: TransitionTable<BudgetStatus, BudgetAction> = {
  submit: { from: ["draft"], to: "submitted", reason: false },
  approve: { from: ["submitted"], to: "approved", reason: false },
  return: { from: ["submitted"], to: "draft", reason: true },
  cancel: { from: ["draft", "submitted"], to: "cancelled", reason: true },
};

export type TopUpAction = "approve" | "reject" | "pay" | "cancel";

/**
 * Petty-cash top-ups: requested → approved (payments.approve + step-up, not the requester) → paid
 * (payments.disburse + step-up, not the approver; the float balance rises, never above its
 * limit); requested → rejected (reason, approver) or cancelled (reason, requester); approved →
 * cancelled (reason).
 */
export const TOP_UP_TRANSITIONS: TransitionTable<TopUpStatus, TopUpAction> = {
  approve: { from: ["requested"], to: "approved", reason: false },
  reject: { from: ["requested"], to: "rejected", reason: true },
  pay: { from: ["approved"], to: "paid", reason: false },
  cancel: { from: ["requested", "approved"], to: "cancelled", reason: true },
};
