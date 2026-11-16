import { describe, expect, it } from "vitest";
import { PAYOUT_DISPLAY_STATUSES } from "@pm-buddy/types";
import {
  batchTimeline,
  displayTone,
  payoutsInFlight,
  pollDelay,
  ratioInput,
  wholeShillingsToMinor,
} from "./payouts";

const person = (displayName: string) => ({
  id: "10000000-0000-4000-8000-000000000001",
  displayName,
});
const batch = {
  status: "submitted" as const,
  createdBy: person("Preparer"),
  createdAt: "2026-11-06T06:00:00.000Z",
  submittedBy: person("Preparer"),
  submittedAt: "2026-11-06T07:00:00.000Z",
  cancelledBy: null,
  cancelledAt: null,
  cancellationReason: null,
};
const decision = (
  action: "review" | "reject" | "reopen" | "approve",
  actor: string,
  createdAt: string,
  extra: { note?: string; underWaiver?: boolean } = {},
) => ({
  action,
  actor: person(actor),
  createdAt,
  note: extra.note ?? null,
  underWaiver: extra.underWaiver ?? false,
});

describe("payout display", () => {
  it("never shows an unfinished or uncertain payout as successful", () => {
    for (const status of PAYOUT_DISPLAY_STATUSES)
      if (status !== "confirmed") expect(displayTone[status]).not.toBe("success");
  });

  it("polls only while a payout or a first payslip send is on its way", () => {
    const obligation = (displayStatus: string, payslip = "not_due", attempts = 0) => ({
      payouts: [{ displayStatus }],
      payslip: { state: payslip, notification: payslip === "not_due" ? null : { attempts } },
    });
    const data = (...rows: ReturnType<typeof obligation>[]) =>
      ({ obligations: rows }) as unknown as Parameters<typeof payoutsInFlight>[0];
    expect(payoutsInFlight(data(obligation("pending")))).toBe(true);
    expect(payoutsInFlight(data(obligation("queued")))).toBe(true);
    expect(payoutsInFlight(data(obligation("uncertain"), obligation("confirmed")))).toBe(false);
    expect(payoutsInFlight(data(obligation("pending_confirmation")))).toBe(false);
    expect(payoutsInFlight(data(obligation("confirmed", "queued", 0)))).toBe(true);
    expect(payoutsInFlight(data(obligation("confirmed", "queued", 2)))).toBe(false);
  });

  it("backs off after failed polls instead of hammering the API", () => {
    expect([0, 1, 2, 3, 4, 9].map(pollDelay)).toEqual([
      5_000, 10_000, 20_000, 40_000, 80_000, 80_000,
    ]);
  });

  it("takes whole shillings and two-decimal ratios only", () => {
    expect(wholeShillingsToMinor("2,500")).toBe(250_000);
    for (const value of ["", "0", "12.50", "-5", "1e3"])
      expect(wholeShillingsToMinor(value)).toBeNull();
    expect(ratioInput("0.85")).toBe(0.85);
    expect(ratioInput("1")).toBe(1);
    for (const value of ["1.5", "0.855", "x"]) expect(ratioInput(value)).toBeNull();
  });
});

describe("batch timeline", () => {
  it("walks submitted → reviewed → approved → the derived settlement status", () => {
    const steps = batchTimeline({ ...batch, status: "partially_settled" }, [
      decision("review", "Reviewer", "2026-11-06T08:00:00.000Z"),
      decision("approve", "Owner", "2026-11-06T09:00:00.000Z", { underWaiver: true }),
    ]);
    expect(steps.map((step) => [step.key, step.state, step.actor])).toEqual([
      ["prepared", "done", "Preparer"],
      ["submitted", "done", "Preparer"],
      ["reviewed", "done", "Reviewer"],
      ["approved", "done", "Owner"],
      ["payout", "current", null],
    ]);
    expect(steps[3]!.underWaiver).toBe(true);
    expect(steps[4]!.status).toBe("partially_settled");
  });

  it("marks the step reached and leaves later ones upcoming", () => {
    const steps = batchTimeline(batch, []);
    expect(steps.map((step) => step.state)).toEqual([
      "done",
      "current",
      "upcoming",
      "upcoming",
      "upcoming",
    ]);
  });

  it("shows where a batch was rejected and ignores decisions before a reopening", () => {
    const steps = batchTimeline({ ...batch, status: "rejected" }, [
      decision("review", "Old reviewer", "2026-11-05T08:00:00.000Z"),
      decision("reject", "Old reviewer", "2026-11-05T09:00:00.000Z"),
      decision("reopen", "Preparer", "2026-11-05T10:00:00.000Z"),
      decision("reject", "Reviewer", "2026-11-06T08:00:00.000Z", { note: "Wrong rates used" }),
    ]);
    expect(steps.map((step) => [step.key, step.state])).toEqual([
      ["prepared", "done"],
      ["submitted", "done"],
      ["rejected", "current"],
    ]);
    expect(steps[2]!.note).toBe("Wrong rates used");
  });
});
