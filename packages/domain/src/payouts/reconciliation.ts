import {
  RECONCILIATION_ITEM_SEVERITY,
  RECONCILIATION_UNCERTAIN_AFTER_MINUTES,
  type ReconciliationItemKind,
  type ReconciliationItemOutcome,
  type ReconciliationItemSeverity,
  type ReconciliationItemStatus,
  type ReconciliationSubjectType,
  type StatementLineClass,
} from "@pm-buddy/types";

/**
 * Daily M-Pesa reconciliation of payroll payouts (D4.3 §11; ARCHITECTURE §14.5; THREAT_MODEL A-05,
 * A-08). For one Africa/Nairobi business date the matcher turns facts into item drafts, unique per
 * (date, kind, subject), and `planReconciliationChanges` turns drafts and the stored items into
 * idempotent changes: re-running a date, or uploading a statement that covers it again, changes
 * nothing unless the evidence changed. Resolution never posts money.
 */

/** An M-Pesa payroll payout confirmed on the business date (later reversals included). */
export type ReconPayout = {
  payoutId: string;
  obligationId: string;
  requestId: string | null;
  receipt: string | null;
  amountMinor: number;
  /** The tariff estimate booked as a charge when it confirmed. */
  bookedChargeMinor: number;
  /** Its obligation's amount and the other confirmed, not reversed payouts towards it. */
  obligationAmountMinor: number;
  otherConfirmedMinor: number;
  /** Reversed since (the original withdrawal still appears on the statement). */
  reversed: boolean;
};

/** An M-Pesa payroll payout created on the business date whose D4.2 request is `uncertain`. */
export type ReconUncertainPayout = {
  payoutId: string;
  requestId: string;
  /** When the request became uncertain. */
  uncertainSince: string;
  /** The D4.2 reconciliation case to link to. */
  caseId: string | null;
};

/** A stored statement line (any uploaded statement); parsed by `parseStatementRows`. */
export type ReconStatementLine = {
  lineId: string;
  statementId: string;
  receipt: string;
  completedOn: string;
  completedAt: string;
  lineClass: StatementLineClass;
  withdrawnMinor: number;
  paidInMinor: number;
  chargeFor: string | null;
};

export type ReconciliationInput = {
  businessDate: string;
  now: Date;
  payouts: readonly ReconPayout[];
  uncertain: readonly ReconUncertainPayout[];
  /**
   * Lines of the statements covering the date, plus any line (from any statement) whose receipt
   * or `chargeFor` is the receipt of one of `payouts`. Overlapping statements may repeat a line.
   */
  lines: readonly ReconStatementLine[];
  /** A statement covering the date has been uploaded (else missing lines are only awaited). */
  statementCovers: boolean;
  /** Every outgoing provider receipt PM-Buddy knows (D4.2, any purpose). */
  knownReceipts: ReadonlySet<string>;
};

export type ReconciliationDraft = {
  businessDate: string;
  kind: ReconciliationItemKind;
  subjectType: ReconciliationSubjectType;
  subjectId: string;
  /** `matched` drafts are resolved automatically (`auto_matched`); everything else is open. */
  status: ReconciliationItemStatus;
  outcome: ReconciliationItemOutcome | null;
  severity: ReconciliationItemSeverity;
  /** `unmatched_internal` before any statement covering the date was uploaded. */
  awaitingStatement: boolean;
  payoutId: string | null;
  requestId: string | null;
  caseId: string | null;
  receipt: string | null;
  statementLineId: string | null;
  /** Every statement payout line with the receipt (more than one is a duplicate). */
  relatedLineIds: string[];
  chargeLineIds: string[];
  amountMinor: number | null;
  statementAmountMinor: number | null;
  bookedChargeMinor: number | null;
  statementChargeMinor: number | null;
  /** Equal keys mean equal evidence: a re-run with the same key changes nothing. */
  evidenceKey: string;
};

export type ReconciliationResult = {
  drafts: ReconciliationDraft[];
  /** `subjectType:subjectId` of everything examined; stale items of these are superseded. */
  subjects: string[];
};

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export const reconciliationSubjectKey = (type: ReconciliationSubjectType, id: string) =>
  `${type}:${id}`;

/** One line per transaction: overlapping statements repeat lines with the same values. */
function uniqueLines(lines: readonly ReconStatementLine[]): ReconStatementLine[] {
  const seen = new Map<string, ReconStatementLine>();
  for (const line of [...lines].sort(
    (a, b) => compare(a.statementId, b.statementId) || compare(a.lineId, b.lineId),
  )) {
    const key = [
      line.lineClass,
      line.receipt,
      line.chargeFor ?? "",
      line.withdrawnMinor,
      line.paidInMinor,
      line.completedAt,
    ].join("|");
    if (!seen.has(key)) seen.set(key, line);
  }
  return [...seen.values()];
}

function groupBy(
  lines: readonly ReconStatementLine[],
  key: (line: ReconStatementLine) => string | null,
): Map<string, ReconStatementLine[]> {
  const groups = new Map<string, ReconStatementLine[]>();
  for (const line of lines) {
    const value = key(line);
    if (value === null) continue;
    groups.set(value, [...(groups.get(value) ?? []), line]);
  }
  return groups;
}

function draft(
  input: ReconciliationInput,
  fields: Partial<ReconciliationDraft> &
    Pick<ReconciliationDraft, "kind" | "subjectType" | "subjectId">,
): ReconciliationDraft {
  const base: ReconciliationDraft = {
    businessDate: input.businessDate,
    status: fields.kind === "matched" ? "resolved" : "open",
    outcome: fields.kind === "matched" ? "auto_matched" : null,
    severity: RECONCILIATION_ITEM_SEVERITY[fields.kind],
    awaitingStatement: false,
    payoutId: null,
    requestId: null,
    caseId: null,
    receipt: null,
    statementLineId: null,
    relatedLineIds: [],
    chargeLineIds: [],
    amountMinor: null,
    statementAmountMinor: null,
    bookedChargeMinor: null,
    statementChargeMinor: null,
    evidenceKey: "",
    ...fields,
  };
  base.evidenceKey = [
    base.receipt,
    base.statementLineId,
    base.relatedLineIds.join(","),
    base.chargeLineIds.join(","),
    base.amountMinor,
    base.statementAmountMinor,
    base.bookedChargeMinor,
    base.statementChargeMinor,
    base.awaitingStatement,
    base.caseId,
  ].join("|");
  return base;
}

/**
 * The items of one business date (§11):
 * - each confirmed payout: `matched` (one statement payout line with its receipt and amount, and
 *   its charge lines summing to the booked charge), `amount_mismatch`, `charge_mismatch`,
 *   `duplicate` (two different statement lines with its receipt, or more confirmed than the
 *   obligation's amount) or `unmatched_internal` (no line yet: awaited until a statement covers
 *   the date, then an exception);
 * - each statement payout line of the date whose receipt PM-Buddy never requested:
 *   `unmatched_statement` (critical, possible float drain);
 * - each payout uncertain for over an hour: `uncertain`, linked to its D4.2 case.
 */
export function reconcileDay(input: ReconciliationInput): ReconciliationResult {
  const drafts: ReconciliationDraft[] = [];
  const subjects = new Set<string>();
  const lines = uniqueLines(input.lines);
  const payoutLines = groupBy(lines, (line) => (line.lineClass === "payout" ? line.receipt : null));
  const chargeLines = groupBy(lines, (line) =>
    line.lineClass === "charge" ? line.chargeFor : null,
  );

  for (const payout of [...input.payouts].sort((a, b) => compare(a.payoutId, b.payoutId))) {
    subjects.add(reconciliationSubjectKey("payout", payout.payoutId));
    const subject = { subjectType: "payout" as const, subjectId: payout.payoutId };
    const evidence = {
      payoutId: payout.payoutId,
      requestId: payout.requestId,
      receipt: payout.receipt,
      amountMinor: payout.amountMinor,
      bookedChargeMinor: payout.bookedChargeMinor,
    };
    const matching = payout.receipt ? (payoutLines.get(payout.receipt) ?? []) : [];
    const charges = payout.receipt ? (chargeLines.get(payout.receipt) ?? []) : [];
    const overpaid =
      !payout.reversed &&
      payout.amountMinor + payout.otherConfirmedMinor > payout.obligationAmountMinor;
    const relatedLineIds = matching.map((line) => line.lineId);
    if (overpaid || matching.length > 1) {
      drafts.push(
        draft(input, {
          kind: "duplicate",
          ...subject,
          ...evidence,
          statementLineId: matching[0]?.lineId ?? null,
          relatedLineIds,
        }),
      );
      if (matching.length > 1) continue;
    }
    const line = matching[0];
    if (!line) {
      drafts.push(
        draft(input, {
          kind: "unmatched_internal",
          ...subject,
          ...evidence,
          awaitingStatement: !input.statementCovers,
          severity: input.statementCovers
            ? RECONCILIATION_ITEM_SEVERITY.unmatched_internal
            : "info",
        }),
      );
      continue;
    }
    const statementChargeMinor = charges.reduce(
      (total, charge) => total + charge.withdrawnMinor,
      0,
    );
    const lineEvidence = {
      ...evidence,
      statementLineId: line.lineId,
      relatedLineIds,
      chargeLineIds: charges.map((charge) => charge.lineId),
      statementAmountMinor: line.withdrawnMinor,
      statementChargeMinor,
    };
    const kind: ReconciliationItemKind =
      line.withdrawnMinor !== payout.amountMinor
        ? "amount_mismatch"
        : statementChargeMinor !== payout.bookedChargeMinor
          ? "charge_mismatch"
          : "matched";
    drafts.push(draft(input, { kind, ...subject, ...lineEvidence }));
  }

  for (const line of lines) {
    if (line.lineClass !== "payout" || line.completedOn !== input.businessDate) continue;
    subjects.add(reconciliationSubjectKey("statement_line", line.lineId));
    if (input.knownReceipts.has(line.receipt)) continue;
    drafts.push(
      draft(input, {
        kind: "unmatched_statement",
        subjectType: "statement_line",
        subjectId: line.lineId,
        receipt: line.receipt,
        statementLineId: line.lineId,
        statementAmountMinor: line.withdrawnMinor,
        chargeLineIds: (chargeLines.get(line.receipt) ?? []).map((charge) => charge.lineId),
      }),
    );
  }

  const cutoff = input.now.getTime() - RECONCILIATION_UNCERTAIN_AFTER_MINUTES * 60_000;
  for (const payout of [...input.uncertain].sort((a, b) => compare(a.payoutId, b.payoutId))) {
    subjects.add(reconciliationSubjectKey("payout", payout.payoutId));
    const since = Date.parse(payout.uncertainSince);
    if (Number.isNaN(since) || since > cutoff) continue;
    drafts.push(
      draft(input, {
        kind: "uncertain",
        subjectType: "payout",
        subjectId: payout.payoutId,
        payoutId: payout.payoutId,
        requestId: payout.requestId,
        caseId: payout.caseId,
      }),
    );
  }
  return { drafts, subjects: [...subjects].sort(compare) };
}

/** A stored item of the same business date (as the planner needs it). */
export type ExistingReconciliationItem = {
  id: string;
  kind: ReconciliationItemKind;
  subjectType: ReconciliationSubjectType;
  subjectId: string;
  status: ReconciliationItemStatus;
  outcome: ReconciliationItemOutcome | null;
  evidenceKey: string;
};

export type ReconciliationChanges = {
  /** New items (event `opened`, or `auto_resolved` for `matched`). */
  create: ReconciliationDraft[];
  /**
   * Items whose evidence changed (event `evidence_updated`); `reopen` when a resolved item opens
   * again on new evidence (event `reopened`). A superseded item that applies again is restored.
   */
  update: { id: string; draft: ReconciliationDraft; reopen: boolean }[];
  /**
   * Items of an examined subject that no longer apply (their kind was not drafted again): resolved
   * with the system outcome `superseded`. Worker disputes are never superseded.
   */
  supersede: string[];
};

/** The idempotent changes a run makes to the stored items of its date. */
export function planReconciliationChanges(
  existing: readonly ExistingReconciliationItem[],
  result: ReconciliationResult,
): ReconciliationChanges {
  const key = (kind: string, type: string, id: string) => `${kind}|${type}|${id}`;
  const stored = new Map(
    existing.map((item) => [key(item.kind, item.subjectType, item.subjectId), item]),
  );
  const drafted = new Set(
    result.drafts.map((item) => key(item.kind, item.subjectType, item.subjectId)),
  );
  const changes: ReconciliationChanges = { create: [], update: [], supersede: [] };
  for (const item of result.drafts) {
    const current = stored.get(key(item.kind, item.subjectType, item.subjectId));
    if (!current) changes.create.push(item);
    else if (current.outcome === "superseded" || current.evidenceKey !== item.evidenceKey)
      changes.update.push({
        id: current.id,
        draft: item,
        reopen: current.status === "resolved" && item.status === "open",
      });
  }
  const examined = new Set(result.subjects);
  for (const item of [...existing].sort((a, b) => compare(a.id, b.id)))
    if (
      item.kind !== "worker_dispute" &&
      item.outcome !== "superseded" &&
      examined.has(reconciliationSubjectKey(item.subjectType, item.subjectId)) &&
      !drafted.has(key(item.kind, item.subjectType, item.subjectId))
    )
      changes.supersede.push(item.id);
  return changes;
}
