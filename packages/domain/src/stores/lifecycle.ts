import type {
  StockTakeAction,
  StockTakeStatus,
  TransferAction,
  TransferStatus,
} from "@pm-buddy/types";
import type { TransitionTable } from "../procurement/lifecycle.js";

/**
 * Stores state machines (docs/WORKFLOWS.md "Stores", brief §15 C). Each table is enforced by the
 * API and repeated by a database trigger in migration `20261118090000_stores`
 * (`app.guard_stock_transfer`, `app.guard_stock_take`), so a bypassed API check still cannot skip
 * a state.
 */

/**
 * Transfers: dispatched → received (every line arrived as sent) or disputed (a line differs; the
 * difference needs a reason) → resolved (reviewed, with a note); a dispatched transfer can be
 * cancelled with a reason, which puts the stock back into the source store.
 */
export const TRANSFER_TRANSITIONS: TransitionTable<TransferStatus, TransferAction> = {
  receive: { from: ["dispatched"], to: "received", reason: false },
  dispute: { from: ["dispatched"], to: "disputed", reason: false },
  resolve: { from: ["disputed"], to: "resolved", reason: true },
  cancel: { from: ["dispatched"], to: "cancelled", reason: true },
};

/**
 * Stock takes: draft → submitted → approved (by someone who did not count or submit; the
 * variances are posted as adjustments); submitted → draft when returned for a recount (reason);
 * draft or submitted → cancelled (reason).
 */
export const STOCK_TAKE_TRANSITIONS: TransitionTable<StockTakeStatus, StockTakeAction> = {
  submit: { from: ["draft"], to: "submitted", reason: false },
  approve: { from: ["submitted"], to: "approved", reason: false },
  return: { from: ["submitted"], to: "draft", reason: true },
  cancel: { from: ["draft", "submitted"], to: "cancelled", reason: true },
};
