import { describe, expect, it } from "vitest";
import {
  approvalDaysOverdue,
  approvalOverdue,
  approvalRequestCode,
  approvalResponseProblem,
  approvalStatus,
  checkNextRevision,
  compareReminders,
  compareRevisions,
  complianceCounts,
  complianceDatesProblem,
  complianceStatus,
  complianceToday,
  documentDownloadName,
  documentFileStem,
  instructionMoves,
  instructionResponse,
  reminderKindOf,
  documentFileName,
  suggestInstructionNumber,
  suggestNextRevision,
} from "../index.js";

const rule = { expires: true, reminderDays: 30 };
const record = (expiresOn: string | null) => ({ kind: "record" as const, expiresOn });

describe("compliance status (Nairobi business dates)", () => {
  it("is missing without a record and not applicable when recorded so", () => {
    expect(complianceStatus(null, rule, "2026-11-14").status).toBe("missing");
    expect(
      complianceStatus({ kind: "not_applicable", expiresOn: null }, rule, "2026-11-14").status,
    ).toBe("not_applicable");
  });

  it("is valid without an expiry, or for a type that does not expire", () => {
    expect(complianceStatus(record(null), rule, "2026-11-14")).toEqual({
      status: "valid",
      daysLeft: null,
      remindFrom: null,
    });
    expect(
      complianceStatus(record("2026-11-01"), { expires: false, reminderDays: 30 }, "2026-11-14")
        .status,
    ).toBe("valid");
  });

  it("turns expiring exactly when the reminder window starts, and expired the day after expiry", () => {
    // Expiry 2026-12-31, 30-day window: the reminder starts on 2026-12-01.
    expect(complianceStatus(record("2026-12-31"), rule, "2026-11-30")).toEqual({
      status: "valid",
      daysLeft: 31,
      remindFrom: "2026-12-01",
    });
    expect(complianceStatus(record("2026-12-31"), rule, "2026-12-01")).toEqual({
      status: "expiring",
      daysLeft: 30,
      remindFrom: "2026-12-01",
    });
    expect(complianceStatus(record("2026-12-31"), rule, "2026-12-31").status).toBe("expiring");
    expect(complianceStatus(record("2026-12-31"), rule, "2026-12-31").daysLeft).toBe(0);
    expect(complianceStatus(record("2026-12-31"), rule, "2027-01-01")).toEqual({
      status: "expired",
      daysLeft: -1,
      remindFrom: "2026-12-01",
    });
  });

  it("uses the type's own window (1 and 365 days)", () => {
    const short = { expires: true, reminderDays: 1 };
    expect(complianceStatus(record("2026-12-31"), short, "2026-12-29").status).toBe("valid");
    expect(complianceStatus(record("2026-12-31"), short, "2026-12-30").status).toBe("expiring");
    const long = { expires: true, reminderDays: 365 };
    expect(complianceStatus(record("2027-12-31"), long, "2026-12-30").status).toBe("valid");
    expect(complianceStatus(record("2027-12-31"), long, "2026-12-31").status).toBe("expiring");
  });

  it("counts leap days", () => {
    // 2028 is a leap year: 30 days before 29 February is 30 January.
    expect(complianceStatus(record("2028-02-29"), rule, "2028-01-29").status).toBe("valid");
    expect(complianceStatus(record("2028-02-29"), rule, "2028-01-30")).toEqual({
      status: "expiring",
      daysLeft: 30,
      remindFrom: "2028-01-30",
    });
    expect(complianceStatus(record("2028-02-29"), rule, "2028-02-29").status).toBe("expiring");
    expect(complianceStatus(record("2028-02-29"), rule, "2028-03-01").status).toBe("expired");
    // Across 29 February: 1 March is two days after 28 February in a leap year, one otherwise.
    expect(complianceStatus(record("2028-03-01"), rule, "2028-02-28").daysLeft).toBe(2);
    expect(complianceStatus(record("2027-03-01"), rule, "2027-02-28").daysLeft).toBe(1);
  });

  it("turns the day at midnight in Nairobi (21:00 UTC), not at UTC midnight", () => {
    expect(complianceToday(new Date("2026-12-31T20:59:59.999Z"))).toBe("2026-12-31");
    expect(complianceToday(new Date("2026-12-31T21:00:00.000Z"))).toBe("2027-01-01");
    const before = complianceStatus(
      record("2026-12-31"),
      rule,
      complianceToday(new Date("2026-12-31T20:59:59.999Z")),
    );
    const after = complianceStatus(
      record("2026-12-31"),
      rule,
      complianceToday(new Date("2026-12-31T21:00:00.000Z")),
    );
    expect([before.status, after.status]).toEqual(["expiring", "expired"]);
  });

  it("counts statuses and names their reminders", () => {
    expect(complianceCounts(["valid", "expired", "expired", "missing"])).toEqual({
      missing: 1,
      valid: 1,
      expiring: 0,
      expired: 2,
      not_applicable: 0,
    });
    expect(
      ["missing", "expiring", "expired", "valid", "not_applicable"].map((s) =>
        reminderKindOf(s as "missing"),
      ),
    ).toEqual(["compliance_missing", "compliance_expiring", "compliance_expired", null, null]);
  });

  it("orders reminders: expired, overdue approvals, missing, then expiring soonest first", () => {
    const list = [
      { kind: "compliance_expiring" as const, daysLeft: 20, label: "b" },
      { kind: "compliance_missing" as const, daysLeft: null, label: "m" },
      { kind: "compliance_expired" as const, daysLeft: -1, label: "x" },
      { kind: "compliance_expiring" as const, daysLeft: 3, label: "a" },
      { kind: "approval_overdue" as const, daysLeft: -4, label: "o" },
      { kind: "compliance_expired" as const, daysLeft: -40, label: "y" },
    ];
    expect([...list].sort(compareReminders).map((entry) => entry.label)).toEqual([
      "y",
      "x",
      "o",
      "m",
      "a",
      "b",
    ]);
  });

  it("checks a record's dates", () => {
    const today = "2026-11-14";
    expect(
      complianceDatesProblem({ issuedOn: "2026-11-15", expiresOn: null, expires: false }, today),
    ).toBe("compliance-issued-future");
    expect(
      complianceDatesProblem({ issuedOn: "2026-11-14", expiresOn: null, expires: true }, today),
    ).toBe("compliance-expiry-required");
    expect(
      complianceDatesProblem(
        { issuedOn: "2026-11-14", expiresOn: "2026-11-13", expires: true },
        today,
      ),
    ).toBe("compliance-expiry-before-issue");
    expect(
      complianceDatesProblem(
        { issuedOn: "2026-11-14", expiresOn: "2026-11-14", expires: true },
        today,
      ),
    ).toBeNull();
  });
});

describe("approval requests", () => {
  it("derives the status from the one response or the cancellation", () => {
    expect(approvalStatus({ cancelled: false, decision: null })).toBe("pending");
    expect(approvalStatus({ cancelled: true, decision: null })).toBe("cancelled");
    expect(approvalStatus({ cancelled: false, decision: "resubmit" })).toBe("resubmit");
  });

  it("is overdue from the day after the due date, only while pending", () => {
    expect(approvalOverdue("pending", "2026-11-14", "2026-11-14")).toBe(false);
    expect(approvalOverdue("pending", "2026-11-14", "2026-11-15")).toBe(true);
    expect(approvalOverdue("approved", "2026-11-14", "2026-11-20")).toBe(false);
    expect(approvalDaysOverdue("pending", "2026-11-14", "2026-11-20")).toBe(6);
    expect(approvalDaysOverdue("pending", "2028-02-28", "2028-03-01")).toBe(2);
    expect(approvalDaysOverdue("cancelled", "2026-11-14", "2026-11-20")).toBe(0);
  });

  it("refuses an in-app answer by the raiser or the uploader, but not a paper record", () => {
    const base = { actorId: "u1", raisedBy: "u1", uploadedBy: "u2" };
    expect(approvalResponseProblem({ channel: "in_app", ...base })).toBe(
      "approval-raiser-cannot-respond",
    );
    expect(
      approvalResponseProblem({
        channel: "in_app",
        actorId: "u2",
        raisedBy: "u1",
        uploadedBy: "u2",
      }),
    ).toBe("approval-uploader-cannot-respond");
    expect(
      approvalResponseProblem({
        channel: "in_app",
        actorId: "u3",
        raisedBy: "u1",
        uploadedBy: "u2",
      }),
    ).toBeNull();
    expect(approvalResponseProblem({ channel: "paper", ...base })).toBeNull();
  });

  it("numbers requests per project", () => {
    expect(approvalRequestCode(7)).toBe("APR-0007");
    expect(approvalRequestCode(12_345)).toBe("APR-12345");
  });
});

describe("instruction lifecycle", () => {
  const respond = (
    kind: Parameters<typeof instructionResponse>[0]["kind"],
    status: Parameters<typeof instructionResponse>[0]["status"],
    body: string | null = null,
    actorId = "u1",
    issuedBy: string | null = null,
  ) => instructionResponse({ kind, status, body, actorId, issuedBy });

  it("moves received → acknowledged → actioned → closed", () => {
    expect(respond("acknowledge", "received")).toEqual({
      ok: true,
      to: "acknowledged",
      moves: true,
    });
    expect(respond("action", "acknowledged", "Done on site")).toEqual({
      ok: true,
      to: "actioned",
      moves: true,
    });
    expect(respond("close", "actioned")).toEqual({ ok: true, to: "closed", moves: true });
    expect(respond("reopen", "closed", "Not finished")).toEqual({
      ok: true,
      to: "received",
      moves: true,
    });
  });

  it("needs a note to action, to close before actioning, and to reopen", () => {
    expect(respond("action", "received")).toEqual({ ok: false, problem: "note-required" });
    expect(respond("close", "received")).toEqual({ ok: false, problem: "note-required" });
    expect(respond("close", "received", "For information only").ok).toBe(true);
    expect(respond("reopen", "closed", " ")).toEqual({ ok: false, problem: "note-required" });
  });

  it("refuses skipped or backward moves and notes on a closed instruction", () => {
    expect(respond("acknowledge", "actioned")).toEqual({
      ok: false,
      problem: "invalid-transition",
    });
    expect(respond("reopen", "received", "x")).toEqual({
      ok: false,
      problem: "invalid-transition",
    });
    expect(respond("close", "closed", "x")).toEqual({ ok: false, problem: "invalid-transition" });
    expect(respond("note", "closed", "late note")).toEqual({
      ok: false,
      problem: "instruction-closed",
    });
    expect(respond("note", "acknowledged", "Called the architect")).toEqual({
      ok: true,
      to: "acknowledged",
      moves: false,
    });
  });

  it("keeps the issuer from acknowledging or actioning their own instruction", () => {
    expect(respond("acknowledge", "received", null, "c1", "c1")).toEqual({
      ok: false,
      problem: "instruction-issuer-cannot-respond",
    });
    expect(respond("action", "acknowledged", "x", "c1", "c1").ok).toBe(false);
    expect(respond("close", "received", "Withdrawn by the architect", "c1", "c1").ok).toBe(true);
    expect(respond("acknowledge", "received", null, "u1", "c1").ok).toBe(true);
  });

  it("lists the moves available from each status", () => {
    expect(instructionMoves("received")).toEqual(["acknowledge", "action", "close"]);
    expect(instructionMoves("actioned")).toEqual(["close"]);
    expect(instructionMoves("closed")).toEqual(["reopen"]);
  });

  it("suggests the next number of a kind", () => {
    expect(suggestInstructionNumber([], "architect_instruction")).toBe("AI-001");
    expect(
      suggestInstructionNumber(["AI-001", "ai 7", "EI-020", "AI-0003"], "architect_instruction"),
    ).toBe("AI-008");
    expect(suggestInstructionNumber(["EI-020"], "engineer_instruction")).toBe("EI-021");
    expect(suggestInstructionNumber(["SI/4"], "site_instruction")).toBe("SI-005");
    expect(suggestInstructionNumber(["AIR-9"], "architect_instruction")).toBe("AI-001");
  });
});

describe("revisions", () => {
  it("orders numbers numerically and letters by length then alphabet", () => {
    expect(compareRevisions("P2", "P10")).toBe("after");
    expect(compareRevisions("P10", "P2")).toBe("before");
    expect(compareRevisions("A", "B")).toBe("after");
    expect(compareRevisions("B", "A")).toBe("before");
    expect(compareRevisions("Z", "AA")).toBe("after");
    expect(compareRevisions("01", "02")).toBe("after");
    expect(compareRevisions("01", "1")).toBe("same");
    expect(compareRevisions("1.1", "1.2")).toBe("after");
    expect(compareRevisions("1", "1.1")).toBe("after");
    expect(compareRevisions("C", "C1")).toBe("after");
    expect(compareRevisions("C1", "C")).toBe("before");
    expect(compareRevisions("rev-1", "REV-2")).toBe("after");
  });

  it("treats a change of letter series or of kind as a new series", () => {
    expect(compareRevisions("P3", "A")).toBe("new_series");
    expect(compareRevisions("P3", "C1")).toBe("new_series");
    expect(compareRevisions("A", "P1")).toBe("new_series");
    expect(compareRevisions("3", "A")).toBe("new_series");
  });

  it("accepts a new, later or new-series revision and refuses the rest", () => {
    expect(checkNextRevision([], null, "A")).toEqual({ ok: true, order: null });
    expect(checkNextRevision(["A"], "A", "B")).toEqual({ ok: true, order: "after" });
    expect(checkNextRevision(["P1", "P2"], "P2", "A")).toEqual({ ok: true, order: "new_series" });
    expect(checkNextRevision(["A", "B"], "B", "b")).toEqual({
      ok: false,
      problem: "revision-exists",
    });
    expect(checkNextRevision(["P1", "P2", "A"], "A", "P2")).toEqual({
      ok: false,
      problem: "revision-exists",
    });
    expect(checkNextRevision(["A", "C"], "C", "B")).toEqual({
      ok: false,
      problem: "revision-not-after",
    });
    expect(checkNextRevision(["01"], "01", "1")).toEqual({
      ok: false,
      problem: "revision-not-after",
    });
    expect(checkNextRevision([], null, "")).toEqual({ ok: false, problem: "revision-invalid" });
    expect(checkNextRevision([], null, "rev c/1")).toEqual({
      ok: false,
      problem: "revision-invalid",
    });
    expect(checkNextRevision([], null, "ABCDEFGHIJK")).toEqual({
      ok: false,
      problem: "revision-invalid",
    });
  });

  it("suggests the next revision", () => {
    expect(suggestNextRevision(null)).toBe("A");
    expect(suggestNextRevision("A")).toBe("B");
    expect(suggestNextRevision("Z")).toBe("AA");
    expect(suggestNextRevision("AZ")).toBe("BA");
    expect(suggestNextRevision("P09")).toBe("P10");
    expect(suggestNextRevision("c1")).toBe("C2");
    expect(suggestNextRevision("1.9")).toBe("1.10");
    expect(suggestNextRevision("ZZZZZZZZZZ")).toBe("A");
  });
});

describe("file names", () => {
  it("keeps a safe stem and the detected extension", () => {
    expect(documentFileName("A-101 Ground floor (rev B).PDF", "pdf")).toBe(
      "A-101 Ground floor (rev B).pdf",
    );
    expect(documentFileName("..\\..\\etc/passwd", "pdf")).toBe("passwd.pdf");
    expect(documentFileName("report.exe", "pdf")).toBe("report.pdf");
    expect(documentFileName('Bé"ton<script>.docx', "docx")).toBe("Be_ton_script.docx");
    expect(documentFileName("....", "png")).toBe("document.png");
    expect(documentFileStem("x".repeat(300))).toHaveLength(100);
  });

  it("labels a superseded download", () => {
    expect(
      documentDownloadName({
        storedName: "A-101 Ground floor.pdf",
        revision: "B",
        superseded: true,
        extension: "pdf",
      }),
    ).toBe("A-101 Ground floor_rev-B_SUPERSEDED.pdf");
    expect(
      documentDownloadName({
        storedName: "Policy.pdf",
        revision: "2",
        superseded: false,
        extension: "pdf",
      }),
    ).toBe("Policy_rev-2.pdf");
  });
});
