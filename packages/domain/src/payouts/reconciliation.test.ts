import { describe, expect, it } from "vitest";
import {
  planReconciliationChanges,
  reconcileDay,
  type ExistingReconciliationItem,
  type ReconciliationDraft,
  type ReconciliationInput,
  type ReconPayout,
  type ReconStatementLine,
} from "../index.js";

const date = "2026-11-16";
const payout = (
  id: string,
  receipt: string | null,
  amountMinor: number,
  extra: Partial<ReconPayout> = {},
): ReconPayout => ({
  payoutId: id,
  obligationId: `o-${id}`,
  requestId: `r-${id}`,
  receipt,
  amountMinor,
  bookedChargeMinor: 900,
  obligationAmountMinor: amountMinor,
  otherConfirmedMinor: 0,
  reversed: false,
  ...extra,
});
let sequence = 0;
const line = (
  receipt: string,
  lineClass: ReconStatementLine["lineClass"],
  withdrawnMinor: number,
  extra: Partial<ReconStatementLine> = {},
): ReconStatementLine => ({
  lineId: `line-${String((sequence += 1)).padStart(3, "0")}`,
  statementId: "s1",
  receipt,
  completedOn: date,
  completedAt: `${date}T09:00:00+03:00`,
  lineClass,
  withdrawnMinor,
  paidInMinor: 0,
  chargeFor: lineClass === "charge" ? receipt : null,
  ...extra,
});

const lines = [
  line("R1", "payout", 400_000),
  line("C1", "charge", 900, { chargeFor: "R1" }),
  line("R2", "payout", 450_000),
  line("R2", "charge", 900),
  line("R3", "payout", 300_000),
  line("R3", "charge", 1_100),
  line("R5", "payout", 200_000),
  line("R5", "payout", 200_000, { completedAt: `${date}T09:05:00+03:00` }),
  line("R6", "payout", 200_000),
  line("R6", "charge", 900),
  line("R9", "payout", 7_000_000),
  line("R10", "payout", 100_000),
  line("D1", "deposit", 0, { paidInMinor: 5_000_000 }),
];
// The same transaction exported again by an overlapping statement is not a duplicate.
const repeated = { ...lines[0]!, lineId: "line-900", statementId: "s2" };

const input: ReconciliationInput = {
  businessDate: date,
  now: new Date(`${date}T18:00:00+03:00`),
  payouts: [
    payout("p1", "R1", 400_000),
    payout("p2", "R2", 500_000),
    payout("p3", "R3", 300_000),
    payout("p4", "R4", 250_000),
    payout("p5", "R5", 200_000),
    payout("p6", "R6", 200_000, { otherConfirmedMinor: 200_000 }),
  ],
  uncertain: [
    {
      payoutId: "p7",
      requestId: "r-p7",
      uncertainSince: `${date}T16:30:00+03:00`,
      caseId: "case-7",
    },
    { payoutId: "p8", requestId: "r-p8", uncertainSince: `${date}T17:30:00+03:00`, caseId: null },
  ],
  lines: [...lines, repeated],
  statementCovers: true,
  knownReceipts: new Set(["R1", "R2", "R3", "R4", "R5", "R6", "R10"]),
};

const summary = (drafts: readonly ReconciliationDraft[]) =>
  drafts.map((item) => [item.kind, item.subjectId, item.status]);

describe("reconciliation matcher (§11)", () => {
  it("classifies every payout, unknown withdrawal and long-uncertain payout of the day", () => {
    const result = reconcileDay(input);
    expect(summary(result.drafts)).toEqual([
      ["matched", "p1", "resolved"],
      ["amount_mismatch", "p2", "open"],
      ["charge_mismatch", "p3", "open"],
      ["unmatched_internal", "p4", "open"],
      ["duplicate", "p5", "open"],
      ["duplicate", "p6", "open"],
      ["matched", "p6", "resolved"],
      ["unmatched_statement", "line-011", "open"],
      ["uncertain", "p7", "open"],
    ]);
    const byKind = (kind: string, subject: string) =>
      result.drafts.find((item) => item.kind === kind && item.subjectId === subject)!;
    expect(byKind("matched", "p1")).toMatchObject({
      outcome: "auto_matched",
      severity: "info",
      receipt: "R1",
      statementLineId: "line-001",
      chargeLineIds: ["line-002"],
      statementAmountMinor: 400_000,
      statementChargeMinor: 900,
    });
    expect(byKind("amount_mismatch", "p2")).toMatchObject({
      severity: "critical",
      amountMinor: 500_000,
      statementAmountMinor: 450_000,
    });
    expect(byKind("charge_mismatch", "p3")).toMatchObject({
      bookedChargeMinor: 900,
      statementChargeMinor: 1_100,
    });
    expect(byKind("unmatched_internal", "p4")).toMatchObject({
      awaitingStatement: false,
      severity: "warning",
    });
    expect(byKind("duplicate", "p5").relatedLineIds).toEqual(["line-007", "line-008"]);
    expect(byKind("unmatched_statement", "line-011")).toMatchObject({
      severity: "critical",
      receipt: "R9",
      statementAmountMinor: 7_000_000,
    });
    expect(byKind("uncertain", "p7")).toMatchObject({ caseId: "case-7", requestId: "r-p7" });
    expect(result.subjects).toContain("payout:p8");
    expect(result.subjects).toContain("statement_line:line-012");
  });

  it("awaits a statement before calling a missing line an exception", () => {
    const awaiting = reconcileDay({
      ...input,
      payouts: [payout("p4", "R4", 250_000)],
      uncertain: [],
      lines: [],
      statementCovers: false,
    });
    expect(awaiting.drafts).toHaveLength(1);
    expect(awaiting.drafts[0]).toMatchObject({
      kind: "unmatched_internal",
      awaitingStatement: true,
      severity: "info",
    });
  });
});

describe("reconciliation changes are idempotent (§11)", () => {
  const stored = (drafts: readonly ReconciliationDraft[]): ExistingReconciliationItem[] =>
    drafts.map((item, index) => ({
      id: `item-${index}`,
      kind: item.kind,
      subjectType: item.subjectType,
      subjectId: item.subjectId,
      status: item.status,
      outcome: item.outcome,
      evidenceKey: item.evidenceKey,
    }));

  it("creates once, then a re-run with the same evidence changes nothing", () => {
    const first = reconcileDay(input);
    expect(planReconciliationChanges([], first).create).toHaveLength(first.drafts.length);
    expect(planReconciliationChanges(stored(first.drafts), reconcileDay(input))).toEqual({
      create: [],
      update: [],
      supersede: [],
    });
  });

  it("updates an awaited item when a statement arrives and supersedes it once matched", () => {
    const only = {
      ...input,
      payouts: [payout("p1", "R1", 400_000)],
      uncertain: [],
      lines: lines.slice(0, 2),
    };
    const awaiting = reconcileDay({ ...only, lines: [], statementCovers: false });
    const existing = stored(awaiting.drafts);
    const covered = planReconciliationChanges(existing, reconcileDay({ ...only, lines: [] }));
    expect(covered.update).toEqual([
      { id: "item-0", draft: expect.objectContaining({ awaitingStatement: false }), reopen: false },
    ]);
    const matched = planReconciliationChanges(existing, reconcileDay(only));
    expect(matched.create.map((item) => item.kind)).toEqual(["matched"]);
    expect(matched.supersede).toEqual(["item-0"]);
  });

  it("reopens a resolved item on new evidence, restores superseded ones and never touches disputes", () => {
    const result = reconcileDay({
      ...input,
      payouts: [payout("p3", "R3", 300_000)],
      uncertain: [],
      lines: lines.slice(4, 6),
    });
    const charge = stored(result.drafts).map((item) => ({
      ...item,
      status: "resolved" as const,
      outcome: "charge_journal" as const,
    }));
    expect(planReconciliationChanges(charge, result)).toEqual({
      create: [],
      update: [],
      supersede: [],
    });
    const corrected = reconcileDay({
      ...input,
      payouts: [payout("p3", "R3", 300_000)],
      uncertain: [],
      lines: [line("R3", "payout", 300_000), line("R3", "charge", 1_300)],
    });
    expect(planReconciliationChanges(charge, corrected).update).toEqual([
      {
        id: "item-0",
        draft: expect.objectContaining({ statementChargeMinor: 1_300 }),
        reopen: true,
      },
    ]);
    const superseded = charge.map((item) => ({ ...item, outcome: "superseded" as const }));
    expect(planReconciliationChanges(superseded, result).update).toHaveLength(1);
    const dispute: ExistingReconciliationItem = {
      id: "dispute",
      kind: "worker_dispute",
      subjectType: "payout",
      subjectId: "p3",
      status: "open",
      outcome: null,
      evidenceKey: "",
    };
    expect(planReconciliationChanges([...charge, dispute], result).supersede).toEqual([]);
  });
});
