import { PROJECT_STATUSES, MILESTONE_STATUSES } from "@pm-buddy/types";
import { describe, expect, it } from "vitest";
import {
  activationGaps,
  allowedProjectTransitions,
  checkMilestoneTransition,
  checkProjectTransition,
  isProjectReadOnly,
  MILESTONE_TRANSITIONS,
  nairobiDate,
  PROJECT_TRANSITIONS,
  type ActivationFacts,
} from "./project-lifecycle.js";

const complete: ActivationFacts = {
  clientName: "Mavuno Homes Ltd",
  contractSumMinor: 8_640_000_000,
  contractType: "lump_sum",
  startDate: "2026-03-02",
  endDate: "2027-04-30",
  county: "kiambu",
  town: "Ruiru",
  geofencedSites: 1,
};

describe("project lifecycle", () => {
  it("allows only the documented transitions", () => {
    const allowed = new Set(PROJECT_TRANSITIONS.map((t) => `${t.from}->${t.to}`));
    expect([...allowed].sort()).toEqual(
      [
        "planning->active",
        "planning->cancelled",
        "active->on_hold",
        "on_hold->active",
        "on_hold->cancelled",
        "active->completed",
        "completed->closed",
      ].sort(),
    );
    for (const from of PROJECT_STATUSES)
      for (const to of PROJECT_STATUSES) {
        const result = checkProjectTransition({
          from,
          to,
          reason: "Valid reason",
          facts: complete,
        });
        expect(result.ok, `${from}->${to}`).toBe(allowed.has(`${from}->${to}`));
      }
  });

  it("treats closed and cancelled as final, read-only states", () => {
    expect(allowedProjectTransitions("closed")).toEqual([]);
    expect(allowedProjectTransitions("cancelled")).toEqual([]);
    expect(isProjectReadOnly("closed")).toBe(true);
    expect(isProjectReadOnly("cancelled")).toBe(true);
    expect(isProjectReadOnly("completed")).toBe(false);
    expect(isProjectReadOnly("on_hold")).toBe(false);
  });

  it("rejects skipping states and moving backwards", () => {
    for (const [from, to] of [
      ["planning", "completed"],
      ["planning", "closed"],
      ["active", "planning"],
      ["completed", "active"],
      ["active", "active"],
    ] as const)
      expect(checkProjectTransition({ from, to, facts: complete })).toEqual({
        ok: false,
        error: "invalid_transition",
      });
  });

  it("requires a reason to suspend or cancel", () => {
    expect(checkProjectTransition({ from: "active", to: "on_hold", facts: complete })).toEqual({
      ok: false,
      error: "reason_required",
    });
    expect(
      checkProjectTransition({ from: "planning", to: "cancelled", reason: "  ", facts: complete }),
    ).toEqual({ ok: false, error: "reason_required" });
    expect(
      checkProjectTransition({
        from: "active",
        to: "on_hold",
        reason: "Awaiting client payment",
        facts: complete,
      }).ok,
    ).toBe(true);
    expect(checkProjectTransition({ from: "on_hold", to: "active", facts: complete }).ok).toBe(
      true,
    );
  });

  it("activates only a project with contract details and a geofenced site", () => {
    expect(activationGaps(complete)).toEqual([]);
    const draft: ActivationFacts = {
      clientName: null,
      contractSumMinor: 0,
      contractType: null,
      startDate: null,
      endDate: "2027-01-01",
      county: "kiambu",
      town: null,
      geofencedSites: 0,
    };
    expect(checkProjectTransition({ from: "planning", to: "active", facts: draft })).toEqual({
      ok: false,
      error: "activation_incomplete",
      missing: [
        "client_name",
        "contract_sum",
        "contract_type",
        "start_date",
        "town",
        "site_with_geofence",
      ],
    });
  });
});

describe("milestone lifecycle", () => {
  const today = "2026-11-10";

  it("allows only the documented transitions; cancelled is final", () => {
    const allowed = new Set(MILESTONE_TRANSITIONS.map((t) => `${t.from}->${t.to}`));
    for (const from of MILESTONE_STATUSES)
      for (const to of MILESTONE_STATUSES) {
        const result = checkMilestoneTransition({
          from,
          to,
          reason: "Valid reason",
          actualDate: today,
          today,
        });
        expect(result.ok, `${from}->${to}`).toBe(allowed.has(`${from}->${to}`));
      }
    expect([...allowed].filter((key) => key.startsWith("cancelled->"))).toEqual([]);
  });

  it("needs a past or present actual date to achieve, and reasons to cancel or reopen", () => {
    expect(checkMilestoneTransition({ from: "in_progress", to: "achieved", today })).toEqual({
      ok: false,
      error: "actual_date_required",
    });
    expect(
      checkMilestoneTransition({
        from: "planned",
        to: "achieved",
        actualDate: "2026-11-11",
        today,
      }),
    ).toEqual({ ok: false, error: "actual_date_future" });
    expect(checkMilestoneTransition({ from: "planned", to: "cancelled", today })).toEqual({
      ok: false,
      error: "reason_required",
    });
    expect(checkMilestoneTransition({ from: "achieved", to: "in_progress", today })).toEqual({
      ok: false,
      error: "reason_required",
    });
  });
});

describe("nairobiDate", () => {
  it("uses the Africa/Nairobi calendar date (UTC+3)", () => {
    expect(nairobiDate(new Date("2026-11-10T21:30:00Z"))).toBe("2026-11-11");
    expect(nairobiDate(new Date("2026-11-10T20:59:59Z"))).toBe("2026-11-10");
  });
});
