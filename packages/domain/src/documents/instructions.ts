import type {
  InstructionKind,
  InstructionLifecycleStatus,
  InstructionResponseKind,
} from "@pm-buddy/types";
import type { TransitionTable } from "../procurement/lifecycle.js";

/**
 * The consultant instructions log (D8.4, decision D-115; WORKFLOWS "Instructions"). The status
 * moves only through append-only responses, and the database checks at commit that it equals the
 * latest moving response (`app.check_instruction_status`):
 *
 *   received → acknowledged → actioned → closed
 *   received | acknowledged → closed (with a note: nothing to do, or superseded)
 *   received | acknowledged → actioned (with a note saying what was done)
 *   closed → received (reopen, with a reason)
 *
 * Notes can be added to any open instruction. Whoever recorded an instruction as its issuer (a
 * consultant on the project) cannot acknowledge or action it: that is the contractor's side.
 */
export type InstructionMove = Exclude<InstructionResponseKind, "note">;

export const INSTRUCTION_TRANSITIONS: TransitionTable<InstructionLifecycleStatus, InstructionMove> =
  {
    acknowledge: { from: ["received"], to: "acknowledged", reason: false },
    action: { from: ["received", "acknowledged"], to: "actioned", reason: true },
    close: { from: ["received", "acknowledged", "actioned"], to: "closed", reason: false },
    reopen: { from: ["closed"], to: "received", reason: true },
  };

export type InstructionResponseProblem =
  | "invalid-transition"
  | "note-required"
  | "instruction-closed"
  | "instruction-issuer-cannot-respond";

/** The status after a response, or why the response is refused. */
export function instructionResponse(input: {
  kind: InstructionResponseKind;
  status: InstructionLifecycleStatus;
  body: string | null;
  actorId: string;
  issuedBy: string | null;
}):
  | { ok: true; to: InstructionLifecycleStatus; moves: boolean }
  | { ok: false; problem: InstructionResponseProblem } {
  const hasBody = input.body !== null && input.body.trim().length > 0;
  if (input.kind === "note") {
    if (input.status === "closed") return { ok: false, problem: "instruction-closed" };
    if (!hasBody) return { ok: false, problem: "note-required" };
    return { ok: true, to: input.status, moves: false };
  }
  const transition = INSTRUCTION_TRANSITIONS[input.kind];
  if (!transition.from.includes(input.status)) return { ok: false, problem: "invalid-transition" };
  if (
    (input.kind === "acknowledge" || input.kind === "action") &&
    input.issuedBy !== null &&
    input.issuedBy === input.actorId
  )
    return { ok: false, problem: "instruction-issuer-cannot-respond" };
  const needsBody = transition.reason || (input.kind === "close" && input.status !== "actioned");
  if (needsBody && !hasBody) return { ok: false, problem: "note-required" };
  return { ok: true, to: transition.to, moves: true };
}

/** The moves available from a status (for permission flags and buttons). */
export const instructionMoves = (status: InstructionLifecycleStatus): InstructionMove[] =>
  (Object.keys(INSTRUCTION_TRANSITIONS) as InstructionMove[]).filter((move) =>
    INSTRUCTION_TRANSITIONS[move].from.includes(status),
  );

/** Open = anything before closed (the BQ register's two-state view, D2.3). */
export const isInstructionOpen = (status: InstructionLifecycleStatus) => status !== "closed";

// Numbering -------------------------------------------------------------------------------------

/** "APR-0007": a per-project sequence number with a prefix, zero-padded to four digits. */
export const sequenceCode = (prefix: string, number: number) =>
  `${prefix}-${String(number).padStart(4, "0")}`;

export const approvalRequestCode = (number: number) => sequenceCode("APR", number);

/** The usual Kenyan prefixes: Architect's (AI), Engineer's (EI) and Site (SI) Instructions. */
export const INSTRUCTION_NUMBER_PREFIXES: Readonly<Record<InstructionKind, string>> = {
  architect_instruction: "AI",
  engineer_instruction: "EI",
  site_instruction: "SI",
  other: "INS",
};

/**
 * A suggestion for the next instruction number of a kind: its prefix and the highest number used
 * with that prefix plus one, three digits ("AI-003" after "AI-002" and "ai 1"). The person
 * recording types the number on the consultant's paper; the database keeps numbers unique per
 * project.
 */
export function suggestInstructionNumber(existing: readonly string[], kind: InstructionKind) {
  const prefix = INSTRUCTION_NUMBER_PREFIXES[kind];
  const pattern = new RegExp(`^${prefix}[\\s./_-]*0*([0-9]{1,6})$`, "i");
  let highest = 0;
  for (const number of existing) {
    const match = pattern.exec(number.trim());
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `${prefix}-${String(highest + 1).padStart(3, "0")}`;
}
