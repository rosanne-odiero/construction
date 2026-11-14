import { describe, expect, it } from "vitest";
import { checkProcurementTransition, statusChanges } from "../procurement/lifecycle.js";
import {
  addCalendarMonths,
  assessCubes,
  assessSlump,
  classStrength,
  COMPLETION_TRANSITIONS,
  completionBlockers,
  cubeAgeState,
  cubeDueDate,
  dlpEndDate,
  dlpState,
  INSPECTION_TRANSITIONS,
  inspectionOutcome,
  inspectionReviewIndependent,
  inspectionSubmitIssues,
  SNAG_TRANSITIONS,
  snagDecisionIndependent,
  strengthTenths,
  suggestedSlumpTolerance,
  summariseWorkforce,
} from "./index.js";

describe("cube rule KE-CUBE-1", () => {
  it("reads strengths as whole tenths and refuses anything else", () => {
    expect(strengthTenths("27.5")).toBe(275);
    expect(strengthTenths("30")).toBe(300);
    expect(strengthTenths("0.1")).toBe(1);
    expect(strengthTenths("27.55")).toBeNull();
    expect(strengthTenths("-1")).toBeNull();
    expect(strengthTenths("1e2")).toBeNull();
    expect(classStrength("C25")).toBe(25);
  });

  it("passes a 28-day set at exactly the class mean with no cube below f_cu − 3", () => {
    // 22.0 is exactly f_cu − 3 for C25 and the mean is exactly 25.00.
    expect(assessCubes("C25", 28, ["22.0", "26.5", "26.5"])).toEqual({
      meanStrength: "25.00",
      minStrength: "22.0",
      percentOfClass: "100.0",
      outcome: "pass",
      ruleVersion: "KE-CUBE-1",
    });
  });

  it("fails a 28-day set whose mean is a tenth short, or with one cube below f_cu − 3", () => {
    expect(assessCubes("C25", 28, ["25.0", "25.0", "24.9"]).outcome).toBe("fail");
    // Mean 27.03 is above the class but 21.9 < 22.
    const low = assessCubes("C25", 28, ["21.9", "29.6", "29.6"]);
    expect(low).toMatchObject({ meanStrength: "27.03", minStrength: "21.9", outcome: "fail" });
    expect(assessCubes("C30", 28, ["33.1", "34.0", "31.8"]).outcome).toBe("pass");
  });

  it("rounds the mean half up to 0.01 without binary error", () => {
    // (25.1 + 25.1 + 25.2) / 3 = 25.1333… → 25.13; (25.0 + 25.0 + 25.1 + 25.1 + 25.1 + 25.2) / 6
    // = 25.0833… → 25.08; 0.5 / 2 = 0.25 exactly.
    expect(assessCubes("C20", 28, ["25.1", "25.1", "25.2"]).meanStrength).toBe("25.13");
    expect(
      assessCubes("C20", 28, ["25.0", "25.0", "25.1", "25.1", "25.1", "25.2"]).meanStrength,
    ).toBe("25.08");
    expect(assessCubes("C10", 7, ["0.2", "0.3"]).meanStrength).toBe("0.25");
    expect(assessCubes("C20", 28, ["20.1", "20.0"]).meanStrength).toBe("20.05");
  });

  it("treats 7-day results as indicative only, low below 65 % of the class", () => {
    // 65 % of 25 = 16.25: a mean of 16.25 is ok, 16.23 is low; never pass or fail.
    expect(assessCubes("C25", 7, ["16.2", "16.3"]).outcome).toBe("indicative_ok");
    expect(assessCubes("C25", 7, ["16.2", "16.2", "16.3"])).toMatchObject({
      meanStrength: "16.23",
      percentOfClass: "64.9",
      outcome: "indicative_low",
    });
    expect(assessCubes("C25", 7, ["5.0"]).outcome).toBe("indicative_low");
  });

  it("refuses an empty set or a malformed strength", () => {
    expect(() => assessCubes("C25", 28, [])).toThrow(/at least one cube/);
    expect(() => assessCubes("C25", 28, ["25.25"])).toThrow(/Invalid cube strength/);
  });

  it("flags a result overdue after the grace days, in Nairobi calendar days", () => {
    const cast = "2026-10-01";
    expect(cubeDueDate(cast, 7)).toBe("2026-10-08");
    expect(cubeDueDate(cast, 28)).toBe("2026-10-29");
    const state = (today: string, recorded = false) =>
      cubeAgeState({ castOn: cast, ageDays: 28, today, graceDays: 2, recorded });
    expect(state("2026-10-28")).toBe("not_due");
    expect(state("2026-10-29")).toBe("due");
    expect(state("2026-10-31")).toBe("due");
    expect(state("2026-11-01")).toBe("overdue");
    expect(state("2026-11-01", true)).toBe("recorded");
    expect(
      cubeAgeState({
        castOn: cast,
        ageDays: 7,
        today: "2026-10-09",
        graceDays: 0,
        recorded: false,
      }),
    ).toBe("overdue");
  });
});

describe("slump rule KE-SLUMP-1", () => {
  it("suggests the BS EN 206 tolerance bands", () => {
    expect(suggestedSlumpTolerance(30)).toBe(10);
    expect(suggestedSlumpTolerance(49)).toBe(10);
    expect(suggestedSlumpTolerance(50)).toBe(20);
    expect(suggestedSlumpTolerance(75)).toBe(20);
    expect(suggestedSlumpTolerance(100)).toBe(30);
    expect(suggestedSlumpTolerance(150)).toBe(30);
  });

  it("passes within the tolerance either side, inclusive", () => {
    expect(assessSlump(75, 20, 95)).toEqual({
      outcome: "pass",
      deviationMm: 20,
      ruleVersion: "KE-SLUMP-1",
    });
    expect(assessSlump(75, 20, 55).outcome).toBe("pass");
    expect(assessSlump(75, 20, 96)).toMatchObject({ outcome: "fail", deviationMm: 21 });
    expect(assessSlump(75, 20, 54)).toMatchObject({ outcome: "fail", deviationMm: -21 });
  });
});

describe("defects liability period", () => {
  it("adds calendar months like PostgreSQL, clamping to the month end", () => {
    expect(addCalendarMonths("2026-07-15", 6)).toBe("2027-01-15");
    expect(addCalendarMonths("2026-08-31", 6)).toBe("2027-02-28");
    expect(addCalendarMonths("2027-08-31", 6)).toBe("2028-02-29");
    expect(addCalendarMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addCalendarMonths("2026-11-30", 12)).toBe("2027-11-30");
    expect(addCalendarMonths("2026-12-15", 1)).toBe("2027-01-15");
    expect(dlpEndDate("2026-03-31", 24)).toBe("2028-03-31");
  });

  it("runs up to and including its end date", () => {
    expect(dlpState("2026-11-14", "2027-01-15")).toEqual({ state: "running", daysRemaining: 62 });
    expect(dlpState("2027-01-15", "2027-01-15")).toEqual({ state: "running", daysRemaining: 0 });
    expect(dlpState("2027-01-16", "2027-01-15")).toEqual({ state: "ended", daysRemaining: 0 });
  });

  it("refuses practical completion with open critical snags unless excepted with a reason", () => {
    const base = {
      kind: "practical" as const,
      completionDate: "2026-11-10",
      today: "2026-11-14",
      openCriticalSnags: 1,
      openSnags: 3,
      exceptionReason: null,
      practical: null,
    };
    expect(completionBlockers(base)).toEqual(["open_critical_snags"]);
    expect(completionBlockers({ ...base, exceptionReason: "  " })).toEqual(["open_critical_snags"]);
    expect(completionBlockers({ ...base, exceptionReason: "Client accepts the gate" })).toEqual([]);
    // Minor and major snags never block practical completion.
    expect(completionBlockers({ ...base, openCriticalSnags: 0 })).toEqual([]);
    expect(
      completionBlockers({ ...base, openCriticalSnags: 0, completionDate: "2026-11-15" }),
    ).toEqual(["date_future"]);
  });

  it("needs a certified practical completion, the DLP ended and no open snags for final completion", () => {
    const base = {
      kind: "final" as const,
      completionDate: "2027-01-15",
      today: "2027-01-20",
      openCriticalSnags: 0,
      openSnags: 0,
      exceptionReason: null,
      practical: { dlpEndsOn: "2027-01-15" },
    };
    expect(completionBlockers(base)).toEqual([]);
    expect(completionBlockers({ ...base, practical: null })).toEqual(["practical_not_certified"]);
    expect(completionBlockers({ ...base, completionDate: "2027-01-14" })).toEqual([
      "dlp_not_ended",
    ]);
    expect(completionBlockers({ ...base, openSnags: 2 })).toEqual(["open_snags"]);
    expect(completionBlockers({ ...base, openSnags: 2, exceptionReason: "Retained" })).toEqual([]);
  });
});

describe("quality lifecycles", () => {
  it("signs off or returns a submitted inspection only, and only independently", () => {
    expect(checkProcurementTransition(INSPECTION_TRANSITIONS, "draft", "submit")).toEqual({
      ok: true,
      to: "submitted",
    });
    expect(checkProcurementTransition(INSPECTION_TRANSITIONS, "draft", "sign_off")).toEqual({
      ok: false,
      error: "invalid_transition",
    });
    expect(checkProcurementTransition(INSPECTION_TRANSITIONS, "submitted", "return")).toEqual({
      ok: false,
      error: "reason_required",
    });
    // A signed-off inspection is final: nothing leaves that state.
    for (const action of ["submit", "sign_off", "return"] as const)
      expect(
        checkProcurementTransition(INSPECTION_TRANSITIONS, "signed_off", action, "reason").ok,
      ).toBe(false);
    const inspection = { createdBy: "author", submittedBy: "author" };
    expect(inspectionReviewIndependent(inspection, "author")).toBe(false);
    expect(inspectionReviewIndependent({ createdBy: "a", submittedBy: "b" }, "b")).toBe(false);
    expect(inspectionReviewIndependent(inspection, "reviewer")).toBe(true);
  });

  it("derives the inspection result and what blocks submission", () => {
    expect(inspectionOutcome(["pass", "na", "pass"])).toBe("pass");
    expect(inspectionOutcome(["pass", "fail", "na"])).toBe("fail");
    expect(inspectionOutcome(["pass", "pending"])).toBeNull();
    expect(inspectionOutcome([])).toBeNull();
    expect(
      inspectionSubmitIssues([
        { result: "pending", note: null },
        { result: "fail", note: "ab" },
      ]),
    ).toEqual(["items_pending", "fail_note_required"]);
    expect(inspectionSubmitIssues([{ result: "fail", note: "Rebar cover 15 mm" }])).toEqual([]);
  });

  it("moves snags open → fixed → closed or reopened, with an independent verifier", () => {
    expect(statusChanges(SNAG_TRANSITIONS)).toEqual([
      ["open", "fixed"],
      ["fixed", "closed"],
      ["fixed", "open"],
    ]);
    expect(checkProcurementTransition(SNAG_TRANSITIONS, "open", "close").ok).toBe(false);
    expect(checkProcurementTransition(SNAG_TRANSITIONS, "fixed", "reopen")).toEqual({
      ok: false,
      error: "reason_required",
    });
    expect(checkProcurementTransition(SNAG_TRANSITIONS, "closed", "reopen", "Recurred").ok).toBe(
      false,
    );
    expect(snagDecisionIndependent({ fixedBy: "agent" }, "agent")).toBe(false);
    expect(snagDecisionIndependent({ fixedBy: "agent" }, "pm")).toBe(true);
    expect(snagDecisionIndependent({ fixedBy: null }, "pm")).toBe(false);
  });

  it("certifies or withdraws a proposed completion only", () => {
    expect(statusChanges(COMPLETION_TRANSITIONS)).toEqual([
      ["proposed", "certified"],
      ["proposed", "withdrawn"],
    ]);
  });
});

describe("diary workforce from attendance", () => {
  const record = (
    tradeId: string,
    tradeKey: string,
    sortOrder: number,
    status: "present" | "half_day" | "absent" | "leave" | "sick",
  ) => ({ tradeId, tradeKey, nameEn: tradeKey, nameSw: `${tradeKey}-sw`, sortOrder, status });

  it("counts people present or on a half day by trade, in the company's trade order", () => {
    expect(
      summariseWorkforce([
        record("t-mason", "mason", 2, "present"),
        record("t-mason", "mason", 2, "half_day"),
        record("t-mason", "mason", 2, "absent"),
        record("t-helper", "helper", 1, "present"),
        record("t-helper", "helper", 1, "sick"),
        record("t-fixer", "steel_fixer", 2, "present"),
        record("t-carpenter", "carpenter", 3, "leave"),
      ]),
    ).toEqual({
      total: 4,
      trades: [
        {
          tradeId: "t-helper",
          key: "helper",
          nameEn: "helper",
          nameSw: "helper-sw",
          headcount: 1,
          halfDays: 0,
        },
        {
          tradeId: "t-mason",
          key: "mason",
          nameEn: "mason",
          nameSw: "mason-sw",
          headcount: 2,
          halfDays: 1,
        },
        {
          tradeId: "t-fixer",
          key: "steel_fixer",
          nameEn: "steel_fixer",
          nameSw: "steel_fixer-sw",
          headcount: 1,
          halfDays: 0,
        },
      ],
    });
  });

  it("is zero, not unknown, when nobody worked", () => {
    expect(summariseWorkforce([record("t", "mason", 1, "absent")])).toEqual({
      total: 0,
      trades: [],
    });
  });
});
