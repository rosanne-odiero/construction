import { describe, expect, it } from "vitest";
import {
  addWorkingDays,
  checkActivityProgress,
  checkDelayDays,
  computeSchedule,
  countWorkingDays,
  dependencyCreatesCycle,
  findDependencyCycle,
  isWorkingDay,
  nextWorkingDay,
  previousWorkingDay,
  quantityPercent,
  scheduleProgress,
  WorkdayIndex,
  workingCalendar,
  workingDaysBetween,
  workingDayVariance,
  type ScheduleDependencyInput,
  type ScheduleInput,
  type ScheduleItemInput,
  type ScheduleResult,
} from "../index.js";

// March 2026: Monday 2nd. Monday to Saturday is the default Kenyan site week.
const monSat = workingCalendar([1, 2, 3, 4, 5, 6]);
const monFri = workingCalendar([1, 2, 3, 4, 5]);
const task = (id: string, durationDays: number, extra: Partial<ScheduleItemInput> = {}) =>
  ({ id, kind: "task", durationDays, ...extra }) as ScheduleItemInput;
const link = (
  predecessorId: string,
  successorId: string,
  type: ScheduleDependencyInput["type"] = "FS",
  lagDays = 0,
): ScheduleDependencyInput => ({
  id: `${predecessorId}-${successorId}`,
  predecessorId,
  successorId,
  type,
  lagDays,
});
const run = (
  items: ScheduleItemInput[],
  dependencies: ScheduleDependencyInput[] = [],
  options: Partial<ScheduleInput> = {},
) => {
  const result = computeSchedule({
    calendar: monSat,
    start: "2026-03-02",
    dataDate: null,
    items,
    dependencies,
    ...options,
  });
  if (!result.ok) throw new Error(`schedule failed: ${result.error}`);
  return result;
};
const item = (result: Extract<ScheduleResult, { ok: true }>, id: string) =>
  result.items.find((entry) => entry.id === id)!;

describe("working calendar", () => {
  it("refuses an empty or invalid working week and invalid holidays", () => {
    expect(() => workingCalendar([])).toThrow(RangeError);
    expect(() => workingCalendar([0, 1])).toThrow(RangeError);
    expect(() => workingCalendar([1], ["12/12/2026"])).toThrow(RangeError);
  });

  it("skips Sundays (Monday to Saturday) and public holidays", () => {
    const calendar = workingCalendar([1, 2, 3, 4, 5, 6], ["2026-12-25", "2026-12-26"]);
    expect(isWorkingDay(calendar, "2026-12-24")).toBe(true);
    expect(isWorkingDay(calendar, "2026-12-25")).toBe(false);
    expect(isWorkingDay(calendar, "2026-12-27")).toBe(false);
    expect(nextWorkingDay(calendar, "2026-12-25")).toBe("2026-12-28");
    expect(previousWorkingDay(calendar, "2026-12-27")).toBe("2026-12-24");
    expect(addWorkingDays(calendar, "2026-12-24", 1)).toBe("2026-12-28");
    expect(addWorkingDays(calendar, "2026-12-28", -1)).toBe("2026-12-24");
    expect(addWorkingDays(calendar, "2026-12-26", 0)).toBe("2026-12-28");
    expect(countWorkingDays(calendar, "2026-12-21", "2026-12-31")).toBe(8);
  });

  it("counts signed working days, a Monday-to-Friday week skipping the weekend", () => {
    expect(workingDaysBetween(monSat, "2026-03-06", "2026-03-09")).toBe(2);
    expect(workingDaysBetween(monFri, "2026-03-06", "2026-03-09")).toBe(1);
    expect(workingDaysBetween(monSat, "2026-03-09", "2026-03-06")).toBe(-2);
    expect(workingDaysBetween(monSat, "2026-03-09", "2026-03-09")).toBe(0);
    expect(countWorkingDays(monSat, "2026-03-09", "2026-03-02")).toBe(0);
  });

  it("numbers working days around an anchor in both directions", () => {
    const index = new WorkdayIndex(monSat, "2026-03-01");
    expect(index.origin).toBe("2026-03-02");
    expect(index.dateOf(0)).toBe("2026-03-02");
    expect(index.dateOf(6)).toBe("2026-03-09");
    expect(index.dateOf(-1)).toBe("2026-02-28");
    expect(index.dateOf(-6)).toBe("2026-02-23");
    expect(index.onOrAfter("2026-03-08")).toBe(6);
    expect(index.onOrBefore("2026-03-08")).toBe(5);
    expect(index.onOrAfter("2026-02-22")).toBe(-6);
    expect(index.onOrBefore("2026-02-22")).toBe(-7);
    for (const at of [-40, -1, 0, 1, 250]) expect(index.onOrAfter(index.dateOf(at))).toBe(at);
    expect(() => index.dateOf(40_001)).toThrow(RangeError);
    expect(() => new WorkdayIndex(monSat, "2026-03-02", 10).onOrAfter("2027-01-01")).toThrow(
      RangeError,
    );
  });
});

describe("CPM forward and backward pass", () => {
  it("handles an empty schedule", () => {
    expect(run([])).toEqual({
      ok: true,
      items: [],
      dependencies: [],
      start: null,
      finish: null,
      criticalPath: [],
    });
  });

  it("schedules a single activity from the project start, which is critical", () => {
    const result = run([task("A", 5)], [], { start: "2026-03-01" });
    expect(item(result, "A")).toEqual({
      id: "A",
      kind: "task",
      status: "not_started",
      start: "2026-03-02",
      finish: "2026-03-06",
      durationDays: 5,
      lateStart: "2026-03-02",
      lateFinish: "2026-03-06",
      totalFloatDays: 0,
      critical: true,
    });
    expect(result).toMatchObject({
      start: "2026-03-02",
      finish: "2026-03-06",
      criticalPath: ["A"],
    });
  });

  it("finish-to-start with lag, lead and holidays", () => {
    const result = run(
      [task("A", 5), task("B", 3), task("C", 2)],
      [link("A", "B", "FS", 2), link("B", "C", "FS", -1)],
    );
    // A Mon 2 – Fri 6; B after Sat 7 and Mon 9 (lag 2): Tue 10 – Thu 12; C overlaps B by a day.
    expect(item(result, "B")).toMatchObject({ start: "2026-03-10", finish: "2026-03-12" });
    expect(item(result, "C")).toMatchObject({ start: "2026-03-12", finish: "2026-03-13" });
    const withHoliday = computeSchedule({
      calendar: workingCalendar([1, 2, 3, 4, 5, 6], ["2026-03-04"]),
      start: "2026-03-02",
      dataDate: null,
      items: [task("A", 5)],
      dependencies: [],
    });
    expect(withHoliday.ok && withHoliday.items[0]).toMatchObject({ finish: "2026-03-07" });
  });

  it("start-to-start, finish-to-finish and start-to-finish", () => {
    const result = run(
      [task("A", 6), task("SS", 3), task("FF", 2), task("SF", 2)],
      [link("A", "SS", "SS", 2), link("A", "FF", "FF", 1), link("A", "SF", "SF", 4)],
    );
    // A Mon 2 – Sat 7 (boundaries 0–6).
    expect(item(result, "SS")).toMatchObject({ start: "2026-03-04", finish: "2026-03-06" });
    // FF: finish ≥ A finish + 1 → finishes Mon 9 (boundary 7), so starts Sat 7.
    expect(item(result, "FF")).toMatchObject({ start: "2026-03-07", finish: "2026-03-09" });
    // SF: finish ≥ A start + 4 → finishes Thu 5 (boundary 4), so starts Wed 4.
    expect(item(result, "SF")).toMatchObject({ start: "2026-03-04", finish: "2026-03-05" });
    expect(result.finish).toBe("2026-03-09");
    expect(item(result, "FF").critical).toBe(true);
    expect(item(result, "A").critical).toBe(true);
    expect(item(result, "SS")).toMatchObject({ totalFloatDays: 2, critical: false });
    expect(item(result, "SF")).toMatchObject({ totalFloatDays: 3, critical: false });
  });

  it("never schedules before the project start, even with a lead", () => {
    const result = run([task("A", 2), task("B", 3)], [link("A", "B", "SS", -5)]);
    expect(item(result, "B").start).toBe("2026-03-02");
  });

  it("finds the critical path and the float of a parallel branch", () => {
    const result = run(
      [task("Dig", 3), task("Steel", 2), task("Forms", 5), task("Pour", 1)],
      [link("Dig", "Steel"), link("Dig", "Forms"), link("Steel", "Pour"), link("Forms", "Pour")],
    );
    expect(result.criticalPath).toEqual(["Dig", "Forms", "Pour"]);
    expect(item(result, "Steel")).toMatchObject({
      start: "2026-03-05",
      finish: "2026-03-06",
      lateStart: "2026-03-09",
      lateFinish: "2026-03-10",
      totalFloatDays: 3,
      critical: false,
    });
    expect(item(result, "Pour")).toMatchObject({ start: "2026-03-11", finish: "2026-03-11" });
    const edges = new Map(result.dependencies.map((entry) => [entry.id, entry]));
    expect(edges.get("Forms-Pour")).toEqual({ id: "Forms-Pour", driving: true, critical: true });
    expect(edges.get("Steel-Pour")).toEqual({ id: "Steel-Pour", driving: false, critical: false });
    expect(edges.get("Dig-Steel")).toMatchObject({ driving: true, critical: false });
  });

  it("uses the working week setting", () => {
    const sixDays = run([task("A", 6)]);
    const fiveDays = run([task("A", 6)], [], { calendar: monFri });
    expect(item(sixDays, "A").finish).toBe("2026-03-07");
    expect(item(fiveDays, "A").finish).toBe("2026-03-09");
  });

  it("respects a start-no-earlier-than date; the link then does not drive", () => {
    const result = run(
      [task("A", 2), task("B", 2, { startNoEarlierThan: "2026-03-08" })],
      [link("A", "B")],
    );
    expect(item(result, "B").start).toBe("2026-03-09");
    expect(result.dependencies[0]).toMatchObject({ driving: false, critical: false });
    expect(item(result, "A")).toMatchObject({ totalFloatDays: 4, critical: false });
  });

  it("places milestones: after a task, at the due date, achieved, and before a successor", () => {
    const result = run(
      [
        task("Slab", 4),
        { id: "Done", kind: "milestone", targetDate: "2026-03-20" },
        task("Walls", 2),
        { id: "Possession", kind: "milestone", targetDate: "2026-03-02", actualDate: "2026-03-01" },
        { id: "Loose", kind: "milestone", targetDate: "2026-03-15" },
      ],
      [link("Slab", "Done"), link("Done", "Walls")],
    );
    // A finish milestone shares its predecessor's finish date; the successor starts next day.
    expect(item(result, "Done")).toMatchObject({
      kind: "milestone",
      start: "2026-03-05",
      finish: "2026-03-05",
      durationDays: 0,
      totalFloatDays: 7,
      critical: false,
    });
    expect(item(result, "Walls")).toMatchObject({ start: "2026-03-06", finish: "2026-03-07" });
    expect(item(result, "Possession")).toMatchObject({
      status: "complete",
      finish: "2026-03-01",
      totalFloatDays: null,
      critical: false,
    });
    // Without predecessors a milestone sits on its due date (Sunday → the next working day).
    expect(item(result, "Loose")).toMatchObject({ finish: "2026-03-16", critical: true });
    expect(result.finish).toBe("2026-03-16");
  });

  it("reaches any planning date, even 100 years on with a seven-day week", () => {
    const result = run([{ id: "Far", kind: "milestone", targetDate: "2099-12-31" }], [], {
      calendar: workingCalendar([1, 2, 3, 4, 5, 6, 7]),
      start: "2000-01-01",
    });
    expect(item(result, "Far")).toMatchObject({ finish: "2099-12-31" });
  });

  it("places a milestone linked from a task's start on the day that task starts", () => {
    const result = run(
      [
        task("Z", 1),
        task("A", 3),
        { id: "Started", kind: "milestone", targetDate: "2026-03-02" },
        { id: "Echo", kind: "milestone", targetDate: "2026-03-02" },
        { id: "Handover", kind: "milestone", targetDate: "2026-03-02" },
        task("B", 5),
      ],
      [
        link("Z", "A"),
        link("A", "Started", "SS"),
        link("Started", "Echo", "SS"),
        link("A", "Handover", "SF", 2),
        link("Started", "B"),
      ],
    );
    expect(item(result, "A")).toMatchObject({ start: "2026-03-03", finish: "2026-03-05" });
    // SS lag 0 from A: the day A starts (not the Monday before); milestone to milestone: same day.
    expect(item(result, "Started")).toMatchObject({ finish: "2026-03-03", critical: true });
    expect(item(result, "Echo")).toMatchObject({ finish: "2026-03-03" });
    expect(item(result, "Handover")).toMatchObject({ finish: "2026-03-05" });
    expect(item(result, "B")).toMatchObject({ start: "2026-03-04", finish: "2026-03-09" });
    // A's start drives the milestone that drives B, the last task: A and Z are critical.
    expect(item(result, "A")).toMatchObject({ totalFloatDays: 0, critical: true });
    expect(item(result, "Z")).toMatchObject({ totalFloatDays: 0, critical: true });
  });

  it("refuses cycles and names the loop; spots links that would close one", () => {
    const dependencies = [link("A", "B"), link("B", "C"), link("C", "A"), link("C", "D")];
    const result = computeSchedule({
      calendar: monSat,
      start: "2026-03-02",
      dataDate: null,
      items: ["A", "B", "C", "D"].map((id) => task(id, 1)),
      dependencies,
    });
    expect(result.ok).toBe(false);
    if (result.ok || result.error !== "cycle") throw new Error("expected a cycle");
    expect(result.cycle).toHaveLength(3);
    const rotated = result.cycle.join(">");
    expect(["A>B>C", "B>C>A", "C>A>B"]).toContain(rotated);
    expect(findDependencyCycle(["A", "B"], [link("A", "B")])).toBeNull();
    expect(dependencyCreatesCycle([link("A", "B"), link("B", "C")], "C", "A")).toBe(true);
    expect(dependencyCreatesCycle([link("A", "B"), link("B", "C")], "A", "C")).toBe(false);
    expect(dependencyCreatesCycle([], "A", "A")).toBe(true);
    expect(
      computeSchedule({
        calendar: monSat,
        start: "2026-03-02",
        dataDate: null,
        items: [task("A", 1)],
        dependencies: [link("A", "Z")],
      }),
    ).toEqual({ ok: false, error: "unknown-item", dependencyId: "A-Z" });
  });
});

describe("CPM with progress (data date)", () => {
  const dataDate = "2026-03-12"; // Thursday of week 2

  it("keeps actual dates of complete work, even on a non-working day", () => {
    const result = run(
      [task("A", 3, { actualStart: "2026-03-02", actualFinish: "2026-03-08" }), task("B", 2)],
      [link("A", "B")],
      { dataDate },
    );
    expect(item(result, "A")).toMatchObject({
      status: "complete",
      start: "2026-03-02",
      finish: "2026-03-08",
      durationDays: 6,
      totalFloatDays: null,
      critical: false,
    });
    // Finished on Sunday: the successor could start on Monday 9th, but not before the data date.
    expect(item(result, "B")).toMatchObject({ start: "2026-03-12", finish: "2026-03-13" });
  });

  it("forecasts work in progress from the reported percentage", () => {
    const result = run(
      [
        task("A", 10, { actualStart: "2026-03-02", percentComplete: 40 }),
        task("B", 4, { actualStart: "2026-03-02" }),
        task("C", 3, { actualStart: "2026-03-02", percentComplete: 90 }),
        task("D", 2),
      ],
      [link("A", "D")],
      { dataDate },
    );
    // Remaining 6 days from Thursday 12th: 12, 13, 14, 16, 17, 18.
    expect(item(result, "A")).toMatchObject({
      status: "in_progress",
      start: "2026-03-02",
      finish: "2026-03-18",
    });
    // No percentage reported and the planned finish (Thu 5th) has passed: finishes today.
    expect(item(result, "B").finish).toBe("2026-03-12");
    // 90 % of 3 days leaves 0.3, rounded up to one day.
    expect(item(result, "C").finish).toBe("2026-03-12");
    expect(item(result, "D")).toMatchObject({ start: "2026-03-19", critical: true });
  });

  it("pushes unstarted work to the data date and uses forecast dates downstream", () => {
    const result = run(
      [task("A", 2), { id: "M", kind: "milestone", targetDate: "2026-03-03" }],
      [link("A", "M")],
      { dataDate },
    );
    expect(item(result, "A")).toMatchObject({ start: "2026-03-12", finish: "2026-03-13" });
    expect(item(result, "M").finish).toBe("2026-03-13");
    const lonely = run([{ id: "M", kind: "milestone", targetDate: "2026-03-03" }], [], {
      dataDate,
    });
    expect(item(lonely, "M").finish).toBe("2026-03-12");
  });
});

describe("progress, variance and delay rules", () => {
  const base = {
    actualStart: null,
    actualFinish: null,
    basis: "physical" as const,
    percentComplete: null,
    quantityDone: null,
    quantityTotal: null,
    quantityUnit: null,
  };
  const today = "2026-03-12";

  it("checks actual dates", () => {
    expect(checkActivityProgress({ ...base, actualStart: "2026-03-13" }, today)).toEqual({
      ok: false,
      error: "actual-date-future",
    });
    expect(checkActivityProgress({ ...base, actualFinish: "2026-03-05" }, today)).toEqual({
      ok: false,
      error: "finish-without-start",
    });
    expect(
      checkActivityProgress(
        { ...base, actualStart: "2026-03-05", actualFinish: "2026-03-04" },
        today,
      ),
    ).toEqual({ ok: false, error: "finish-before-start" });
  });

  it("keeps physical progress consistent with the actual dates", () => {
    expect(checkActivityProgress({ ...base, percentComplete: 10 }, today)).toEqual({
      ok: false,
      error: "progress-without-start",
    });
    expect(
      checkActivityProgress({ ...base, actualStart: "2026-03-02", percentComplete: 100 }, today),
    ).toEqual({ ok: false, error: "progress-inconsistent" });
    expect(
      checkActivityProgress({ ...base, actualStart: "2026-03-02", percentComplete: 12.5 }, today),
    ).toEqual({ ok: false, error: "progress-inconsistent" });
    expect(
      checkActivityProgress(
        { ...base, actualStart: "2026-03-02", actualFinish: "2026-03-10", percentComplete: 80 },
        today,
      ),
    ).toEqual({ ok: false, error: "progress-inconsistent" });
    expect(
      checkActivityProgress(
        { ...base, actualStart: "2026-03-02", actualFinish: "2026-03-10" },
        today,
      ),
    ).toMatchObject({ ok: true, status: "complete", percentComplete: 100 });
    expect(
      checkActivityProgress({ ...base, actualStart: "2026-03-02", percentComplete: 35 }, today),
    ).toMatchObject({ ok: true, status: "in_progress", percentComplete: 35 });
    expect(checkActivityProgress(base, today)).toMatchObject({
      ok: true,
      status: "not_started",
      percentComplete: null,
    });
  });

  it("measures progress by quantity, rounding down", () => {
    const quantity = { ...base, basis: "quantity" as const, quantityUnit: "m2" };
    expect(quantityPercent("1", "3")).toBe(33.33);
    expect(
      checkActivityProgress(
        { ...quantity, actualStart: "2026-03-02", quantityDone: "1200", quantityTotal: "4000.0" },
        today,
      ),
    ).toEqual({
      ok: true,
      status: "in_progress",
      percentComplete: 30,
      quantityDone: "1200",
      quantityTotal: "4000",
      quantityUnit: "m2",
    });
    expect(
      checkActivityProgress(
        { ...quantity, actualStart: "2026-03-02", quantityDone: "4000", quantityTotal: "4000" },
        today,
      ),
    ).toEqual({ ok: false, error: "progress-inconsistent" });
    expect(
      checkActivityProgress(
        { ...quantity, actualStart: "2026-03-02", quantityDone: "5000", quantityTotal: "4000" },
        today,
      ),
    ).toEqual({ ok: false, error: "quantity-invalid" });
    expect(checkActivityProgress({ ...quantity, quantityTotal: "0" }, today)).toEqual({
      ok: false,
      error: "quantity-invalid",
    });
    expect(
      checkActivityProgress({ ...quantity, quantityDone: "1", quantityTotal: "10" }, today),
    ).toEqual({ ok: false, error: "progress-without-start" });
    expect(
      checkActivityProgress(
        { ...quantity, actualStart: "2026-03-02", actualFinish: "2026-03-09", quantityTotal: "10" },
        today,
      ),
    ).toMatchObject({ ok: true, percentComplete: 100, quantityDone: "10" });
  });

  it("weights progress by duration and leaves undefined ratios unavailable", () => {
    expect(scheduleProgress([])).toBeNull();
    expect(
      scheduleProgress([
        { durationDays: 10, status: "complete", percentComplete: null },
        { durationDays: 10, status: "in_progress", percentComplete: 50 },
        { durationDays: 20, status: "not_started", percentComplete: null },
      ]),
    ).toBe(0.375);
    expect(
      scheduleProgress([{ durationDays: 10, status: "in_progress", percentComplete: null }]),
    ).toBeNull();
  });

  it("measures variance in working days, positive for a slip", () => {
    expect(workingDayVariance(monSat, "2026-03-06", "2026-03-10")).toBe(3);
    expect(workingDayVariance(monSat, "2026-03-10", "2026-03-06")).toBe(-3);
    expect(workingDayVariance(monSat, null, "2026-03-10")).toBeNull();
    expect(workingDayVariance(monSat, "2026-03-10", undefined)).toBeNull();
  });

  it("checks delay periods and working days lost (half days allowed)", () => {
    const check = (startDate: string, endDate: string | null, workingDaysLost: number) =>
      checkDelayDays(monSat, { startDate, endDate, workingDaysLost }, today);
    expect(check("2026-03-02", "2026-03-08", 6)).toEqual({ ok: true, workingDaysInPeriod: 6 });
    expect(check("2026-03-02", "2026-03-08", 6.5)).toEqual({
      ok: false,
      error: "delay-days-exceed-range",
    });
    expect(check("2026-03-02", "2026-03-03", 1.5)).toEqual({ ok: true, workingDaysInPeriod: 2 });
    expect(check("2026-03-02", "2026-03-03", 1.25)).toEqual({
      ok: false,
      error: "delay-dates-invalid",
    });
    expect(check("2026-03-05", "2026-03-04", 0)).toEqual({
      ok: false,
      error: "delay-dates-invalid",
    });
    expect(check("2026-03-13", null, 0)).toEqual({ ok: false, error: "delay-date-future" });
    expect(check("2026-03-09", null, 4)).toEqual({ ok: true, workingDaysInPeriod: 4 });
    expect(check("2026-03-08", "2026-03-08", 0.5)).toEqual({
      ok: false,
      error: "delay-days-exceed-range",
    });
  });
});
