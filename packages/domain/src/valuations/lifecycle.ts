import type { ValuationAction, ValuationStatus } from "@pm-buddy/types";
import type { TransitionTable } from "../procurement/lifecycle.js";

/**
 * Valuations and their certificates (docs/WORKFLOWS.md "Valuations", brief §15 C): draft →
 * submitted (lines and figures frozen with a digest) → certified (finance.manage + step-up, never a
 * contributor, on the digest seen; numbered IPC-NNNN; never changes again); submitted → draft when
 * returned (reason); draft or submitted → cancelled (reason). Enforced by the API and repeated by
 * `app.guard_valuation` in migration `20261125090000_valuations`.
 */
export const VALUATION_TRANSITIONS: TransitionTable<ValuationStatus, ValuationAction> = {
  submit: { from: ["draft"], to: "submitted", reason: false },
  certify: { from: ["submitted"], to: "certified", reason: false },
  return: { from: ["submitted"], to: "draft", reason: true },
  cancel: { from: ["draft", "submitted"], to: "cancelled", reason: true },
};

/** "VAL-0007" / "IPC-0003": per project, four digits at least. */
export const valuationCode = (prefix: "VAL" | "IPC", number: number): string =>
  `${prefix}-${String(number).padStart(4, "0")}`;
