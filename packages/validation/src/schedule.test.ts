import { describe, expect, it } from "vitest";
import {
  activityProgressRequestSchema,
  createDelayRequestSchema,
  createDependencyRequestSchema,
  updateScheduleCalendarRequestSchema,
} from "./index.js";

const id = "0190a5e0-0000-7000-8000-000000000001";

describe("schedule request schemas", () => {
  it("sorts working weekdays and refuses duplicates or an empty week", () => {
    expect(
      updateScheduleCalendarRequestSchema.parse({
        workingWeekdays: [6, 1, 3],
        includePublicHolidays: true,
        version: 0,
      }).workingWeekdays,
    ).toEqual([1, 3, 6]);
    for (const workingWeekdays of [[], [1, 1], [0], [8]])
      expect(
        updateScheduleCalendarRequestSchema.safeParse({
          workingWeekdays,
          includePublicHolidays: false,
          version: 1,
        }).success,
      ).toBe(false);
  });

  it("refuses a dependency on itself and lags outside the limits", () => {
    const ref = { kind: "task", id };
    const base = { predecessor: ref, successor: { kind: "milestone", id }, type: "FS", lagDays: 0 };
    expect(createDependencyRequestSchema.safeParse(base).success).toBe(true);
    expect(createDependencyRequestSchema.safeParse({ ...base, successor: ref }).success).toBe(
      false,
    );
    expect(createDependencyRequestSchema.safeParse({ ...base, lagDays: -61 }).success).toBe(false);
    expect(createDependencyRequestSchema.safeParse({ ...base, lagDays: 1.5 }).success).toBe(false);
  });

  it("keeps the progress fields to the declared basis", () => {
    const base = { version: 1, actualStart: "2026-03-02", actualFinish: null };
    expect(
      activityProgressRequestSchema.safeParse({ ...base, basis: "physical", percentComplete: 40 })
        .success,
    ).toBe(true);
    expect(
      activityProgressRequestSchema.safeParse({ ...base, basis: "physical", quantityTotal: "10" })
        .success,
    ).toBe(false);
    expect(
      activityProgressRequestSchema.safeParse({ ...base, basis: "quantity", percentComplete: 40 })
        .success,
    ).toBe(false);
    expect(
      activityProgressRequestSchema.safeParse({ ...base, basis: "physical", percentComplete: 40.5 })
        .success,
    ).toBe(false);
  });

  it("accepts half days lost and refuses finer fractions or duplicate activities", () => {
    const delay = {
      cause: "weather",
      startDate: "2026-04-06",
      endDate: null,
      workingDaysLost: 2.5,
      description: "Long rains flooded the trenches",
      activityIds: [id],
    };
    expect(createDelayRequestSchema.safeParse(delay).success).toBe(true);
    expect(createDelayRequestSchema.safeParse({ ...delay, workingDaysLost: 2.25 }).success).toBe(
      false,
    );
    expect(createDelayRequestSchema.safeParse({ ...delay, activityIds: [id, id] }).success).toBe(
      false,
    );
    expect(createDelayRequestSchema.safeParse({ ...delay, cause: "rain" }).success).toBe(false);
  });
});
