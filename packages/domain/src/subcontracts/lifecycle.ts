import type {
  PieceRateJobStatus,
  SubcontractAction,
  SubcontractAdvanceStatus,
  SubcontractCertificateAction,
  SubcontractCertificateStatus,
  SubcontractStatus,
} from "@pm-buddy/types";
import type { TransitionTable } from "../procurement/lifecycle.js";

/**
 * Subcontracts (docs/WORKFLOWS.md "Subcontracts", brief §15 C): draft → submitted (frozen with a
 * digest) → approved (procurement.approve + step-up, never a contributor, on the digest seen) →
 * active → completed | terminated (reason); approved → terminated before work starts; submitted
 * → draft when returned (reason); draft | submitted → cancelled (reason). Enforced by the API and
 * repeated by `app.guard_subcontract` in migration `20261201090000_subcontracts`.
 */
export const SUBCONTRACT_TRANSITIONS: TransitionTable<SubcontractStatus, SubcontractAction> = {
  submit: { from: ["draft"], to: "submitted", reason: false },
  approve: { from: ["submitted"], to: "approved", reason: false },
  return: { from: ["submitted"], to: "draft", reason: true },
  activate: { from: ["approved"], to: "active", reason: false },
  complete: { from: ["active"], to: "completed", reason: false },
  terminate: { from: ["approved", "active"], to: "terminated", reason: true },
  cancel: { from: ["draft", "submitted"], to: "cancelled", reason: true },
};

/**
 * Subcontract certificates (WORKFLOWS "Subcontract certificates"): draft → submitted → certified
 * (finance.manage + step-up, never a contributor, on the digest seen; never changes again);
 * submitted → draft (returned, reason); draft | submitted → cancelled (reason). Enforced by the
 * API and repeated by `app.guard_subcontract_certificate`.
 */
export const SUBCONTRACT_CERTIFICATE_TRANSITIONS: TransitionTable<
  SubcontractCertificateStatus,
  SubcontractCertificateAction
> = {
  submit: { from: ["draft"], to: "submitted", reason: false },
  certify: { from: ["submitted"], to: "certified", reason: false },
  return: { from: ["submitted"], to: "draft", reason: true },
  cancel: { from: ["draft", "submitted"], to: "cancelled", reason: true },
};

/** Advances: requested → approved → paid; requested → rejected; requested | approved → cancelled. */
export const SUBCONTRACT_ADVANCE_TRANSITIONS: TransitionTable<
  SubcontractAdvanceStatus,
  "approve" | "reject" | "pay" | "cancel"
> = {
  approve: { from: ["requested"], to: "approved", reason: false },
  reject: { from: ["requested"], to: "rejected", reason: true },
  pay: { from: ["approved"], to: "paid", reason: false },
  cancel: { from: ["requested", "approved"], to: "cancelled", reason: true },
};

/** Piece-rate jobs: pending → approved | rejected (reason); approved → closed. */
export const PIECE_RATE_JOB_TRANSITIONS: TransitionTable<
  PieceRateJobStatus,
  "approve" | "reject" | "close"
> = {
  approve: { from: ["pending"], to: "approved", reason: false },
  reject: { from: ["pending"], to: "rejected", reason: true },
  close: { from: ["approved"], to: "closed", reason: false },
};

const padded = (prefix: string, number: number, width = 4) =>
  `${prefix}-${String(number).padStart(width, "0")}`;

/** "SC-0003": a subcontract, per project. */
export const subcontractCode = (number: number) => padded("SC", number);
/** "SCC-0002": a certified subcontract certificate, per subcontract ("SCV-0002" before). */
export const subcontractCertificateCode = (number: number, certified: boolean) =>
  padded(certified ? "SCC" : "SCV", number);
/** "SCV-03": a subcontract variation, per subcontract. */
export const subcontractVariationCode = (number: number) => padded("SCVO", number, 2);
/** "ADV-01": an advance, per subcontract. */
export const subcontractAdvanceCode = (number: number) => padded("ADV", number, 2);
/** "PRJ-0004": a piece-rate job, per project. */
export const pieceRateJobCode = (number: number) => padded("PRJ", number);
