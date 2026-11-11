import type { BqImportStatus } from "@pm-buddy/types";

/**
 * The BQ import state machine (brief §15 C/G): uploaded → parsed → mapped → validated → committed,
 * or failed/abandoned. Mapping again after validation returns to `mapped`; a committed import is
 * superseded when a later import replaces the draft it created. Enforced by the API and repeated
 * by the database trigger `app.guard_bq_import`.
 */
export const BQ_IMPORT_TRANSITIONS: Readonly<Record<BqImportStatus, readonly BqImportStatus[]>> = {
  uploaded: ["parsed", "failed", "abandoned"],
  parsed: ["mapped", "abandoned"],
  mapped: ["mapped", "validated", "abandoned"],
  validated: ["mapped", "validated", "committed", "abandoned"],
  committed: ["superseded"],
  failed: [],
  abandoned: [],
  superseded: [],
};

export const canTransitionImport = (from: BqImportStatus, to: BqImportStatus): boolean =>
  BQ_IMPORT_TRANSITIONS[from].includes(to);

/** Imports the user can come back to and continue. */
export const isImportResumable = (status: BqImportStatus): boolean =>
  status === "uploaded" || status === "parsed" || status === "mapped" || status === "validated";
