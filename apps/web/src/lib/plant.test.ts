import { describe, expect, it } from "vitest";
import { FoundationApiError } from "./foundation-api";
import {
  parseLitresInput,
  parseTenthsInput,
  plantAccess,
  plantTabHref,
  recordRetryPlan,
  runBetween,
  signedPercent,
} from "./plant";

describe("plant screens", () => {
  it("applies the API's read, record, fuel and manage rules to project permissions", () => {
    expect(plantAccess(["projects.view", "site.diary"])).toEqual({
      read: true,
      record: true,
      fuel: true,
      manage: false,
    });
    expect(plantAccess(["projects.view", "stores.manage"])).toMatchObject({
      read: true,
      record: false,
      fuel: true,
    });
    expect(plantAccess(["projects.view", "portal.client"]).read).toBe(false);
    expect(plantAccess(["plant.manage"]).read).toBe(false);
    expect(plantTabHref("p1", "fuel")).toBe("/projects/p1?tab=plant&saved=fuel");
  });

  it("reads meter readings and litres typed on site with one decimal place", () => {
    expect(parseTenthsInput(" 1208 ")).toBe("1208.0");
    expect(parseTenthsInput("1 208.5")).toBe("1208.5");
    for (const bad of ["1,208.5", "12,5", "1208.55", "-3", "abc", ""])
      expect(parseTenthsInput(bad), bad).toBeNull();
    expect(parseLitresInput("182")).toBe("182.0");
    expect(parseLitresInput("0")).toBeNull();
    expect(parseLitresInput("2000.1")).toBeNull();
    expect(runBetween("1200", "1208.5")).toBe("8.5");
    expect(runBetween("1208.5", "1200")).toBeNull();
    expect(runBetween("", "1200")).toBeNull();
  });

  it("keeps the record ID and key when a submit may have been recorded", () => {
    expect(recordRetryPlan(new FoundationApiError(409, "usage-id-conflict"))).toBe("recorded");
    expect(recordRetryPlan(new FoundationApiError(409, "idempotency-key-reused"))).toBe("recorded");
    expect(recordRetryPlan(new FoundationApiError(409, "meter-out-of-order"))).toBe("renew");
    expect(recordRetryPlan(new FoundationApiError(0, "network"))).toBe("keep");
    expect(recordRetryPlan(new FoundationApiError(503, "service-unavailable"))).toBe("keep");
    expect(recordRetryPlan(new Error("boom"))).toBe("keep");
  });

  it("signs variance percentages", () => {
    expect(signedPercent("30.0")).toBe("+30.0 %");
    expect(signedPercent("-7.1")).toBe("−7.1 %");
  });
});
