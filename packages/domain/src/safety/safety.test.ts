import { describe, expect, it } from "vitest";
import { checkProcurementTransition, statusChanges } from "../procurement/lifecycle.js";
import {
  certificateState,
  compareCorrectiveActions,
  correctiveActionDaysOverdue,
  correctiveActionDoneAllowed,
  correctiveActionOverdue,
  correctiveActionVerifierIndependent,
  CORRECTIVE_ACTION_TRANSITIONS,
  INCIDENT_TRANSITIONS,
  incidentCloseBlockers,
  inductionCovers,
  inductionStatus,
  kitState,
  ppeReplacementDueOn,
  ppeReplacementState,
  regulatorReviewRequired,
  regulatorState,
  TOOLBOX_TALK_TRANSITIONS,
  uninductedAttendance,
} from "./index.js";

const TODAY = "2026-11-14";

describe("corrective actions", () => {
  it("is overdue only while open and past its due date", () => {
    expect(correctiveActionOverdue({ status: "open", dueOn: "2026-11-13" }, TODAY)).toBe(true);
    // Due today is not overdue yet (Nairobi business date).
    expect(correctiveActionOverdue({ status: "open", dueOn: TODAY }, TODAY)).toBe(false);
    // Done (awaiting verification), verified and cancelled actions are never overdue.
    for (const status of ["done", "verified", "cancelled"] as const)
      expect(correctiveActionOverdue({ status, dueOn: "2026-01-01" }, TODAY)).toBe(false);
    expect(correctiveActionDaysOverdue({ status: "open", dueOn: "2026-11-04" }, TODAY)).toBe(10);
    expect(correctiveActionDaysOverdue({ status: "open", dueOn: "2026-12-04" }, TODAY)).toBeNull();
  });

  it("lists overdue actions first, most overdue first, then open by due date, then the rest", () => {
    const actions = [
      { number: 1, status: "verified" as const, dueOn: "2026-10-01" },
      { number: 2, status: "open" as const, dueOn: "2026-11-20" },
      { number: 3, status: "open" as const, dueOn: "2026-11-10" },
      { number: 4, status: "done" as const, dueOn: "2026-11-01" },
      { number: 5, status: "open" as const, dueOn: "2026-11-01" },
      { number: 6, status: "cancelled" as const, dueOn: "2026-09-01" },
      { number: 7, status: "open" as const, dueOn: "2026-11-15" },
    ];
    expect(actions.sort(compareCorrectiveActions(TODAY)).map((action) => action.number)).toEqual([
      5, 3, 7, 2, 4, 1, 6,
    ]);
  });

  it("moves open → done → verified, rejects back to open with a reason, and keeps final states final", () => {
    const check = (
      status: "open" | "done" | "verified" | "cancelled",
      action: string,
      reason?: string,
    ) =>
      checkProcurementTransition(
        CORRECTIVE_ACTION_TRANSITIONS,
        status,
        action as "done" | "verify" | "reject" | "cancel",
        reason,
      );
    expect(check("open", "done")).toEqual({ ok: true, to: "done" });
    expect(check("done", "verify")).toEqual({ ok: true, to: "verified" });
    expect(check("open", "verify")).toEqual({ ok: false, error: "invalid_transition" });
    expect(check("done", "reject")).toEqual({ ok: false, error: "reason_required" });
    expect(check("done", "reject", "Guard rail still loose")).toEqual({ ok: true, to: "open" });
    for (const action of ["done", "verify", "reject", "cancel"]) {
      expect(check("verified", action, "reason text").ok).toBe(false);
      expect(check("cancelled", action, "reason text").ok).toBe(false);
    }
    expect(statusChanges(CORRECTIVE_ACTION_TRANSITIONS)).toHaveLength(5);
  });

  it("lets only the owner mark an action done and only someone else verify it", () => {
    const action = { ownerId: "owner", doneBy: "owner" };
    expect(correctiveActionDoneAllowed(action, "owner")).toBe(true);
    expect(correctiveActionDoneAllowed(action, "manager")).toBe(false);
    expect(correctiveActionVerifierIndependent(action, "owner")).toBe(false);
    expect(correctiveActionVerifierIndependent(action, "manager")).toBe(true);
    // Not done yet: nothing to verify.
    expect(correctiveActionVerifierIndependent({ ownerId: "owner", doneBy: null }, "manager")).toBe(
      false,
    );
  });
});

describe("induction coverage", () => {
  it("reads the newest induction at a site, with or without a validity period", () => {
    expect(inductionStatus([], null, TODAY)).toEqual({
      state: "none",
      inductedOn: null,
      validUntil: null,
    });
    expect(inductionStatus([{ inductedOn: "2025-01-10" }], null, TODAY)).toEqual({
      state: "valid",
      inductedOn: "2025-01-10",
      validUntil: null,
    });
    // 365 days of validity: 10/01/2025 counts up to and including 09/01/2026.
    expect(inductionStatus([{ inductedOn: "2025-01-10" }], 365, TODAY)).toEqual({
      state: "expired",
      inductedOn: "2025-01-10",
      validUntil: "2026-01-09",
    });
    expect(
      inductionStatus([{ inductedOn: "2025-01-10" }, { inductedOn: "2026-03-01" }], 365, TODAY),
    ).toMatchObject({ state: "valid", inductedOn: "2026-03-01", validUntil: "2027-02-28" });
    // An induction dated after today does not count yet.
    expect(inductionStatus([{ inductedOn: "2026-11-15" }], null, TODAY).state).toBe("none");
  });

  it("covers a day from the induction date to the last valid day", () => {
    const induction = { inductedOn: "2026-11-10" };
    expect(inductionCovers(induction, "2026-11-09", null)).toBe(false);
    expect(inductionCovers(induction, "2026-11-10", null)).toBe(true);
    expect(inductionCovers(induction, "2026-12-09", 30)).toBe(true);
    expect(inductionCovers(induction, "2026-12-10", 30)).toBe(false);
  });

  it("flags the days worked at a site before an induction or after it expired", () => {
    const attended = ["2026-11-12", "2026-11-03", "2026-11-10", "2026-11-03", "2026-11-11"];
    expect(uninductedAttendance(attended, [], null)).toEqual([
      "2026-11-03",
      "2026-11-10",
      "2026-11-11",
      "2026-11-12",
    ]);
    // Inducted on 10/11: only the earlier day is flagged.
    expect(uninductedAttendance(attended, [{ inductedOn: "2026-11-10" }], null)).toEqual([
      "2026-11-03",
    ]);
    // A 7-day validity from 01/11 covers 01–07/11 only.
    expect(uninductedAttendance(attended, [{ inductedOn: "2026-11-01" }], 7)).toEqual([
      "2026-11-10",
      "2026-11-11",
      "2026-11-12",
    ]);
  });
});

describe("PPE replacement", () => {
  it("dates the replacement from the issue date and the company period", () => {
    expect(ppeReplacementDueOn("2026-11-14", 30)).toBe("2026-12-14");
    expect(ppeReplacementDueOn("2024-02-29", 365)).toBe("2025-02-28");
  });

  it("is due on the date itself, due soon within the warning window, otherwise fine", () => {
    expect(ppeReplacementState("2026-11-14", TODAY)).toBe("due");
    expect(ppeReplacementState("2026-10-01", TODAY)).toBe("due");
    expect(ppeReplacementState("2026-11-28", TODAY)).toBe("due_soon");
    expect(ppeReplacementState("2026-11-29", TODAY)).toBe("ok");
    expect(ppeReplacementState("2026-11-20", TODAY, 3)).toBe("ok");
  });
});

describe("incident closing rules", () => {
  const investigated = {
    status: "investigated" as const,
    kind: "injury" as const,
    severity: "moderate" as const,
    regulatorDecision: null,
  };

  it("asks for a regulator decision on serious and fatal injuries and dangerous occurrences", () => {
    expect(regulatorReviewRequired("injury", "moderate")).toBe(false);
    expect(regulatorReviewRequired("injury", "serious")).toBe(true);
    // A near miss's severity is its potential: no notification by itself.
    expect(regulatorReviewRequired("near_miss", "fatal")).toBe(false);
    expect(regulatorReviewRequired("property_damage", "serious")).toBe(false);
    expect(regulatorReviewRequired("dangerous_occurrence", "minor")).toBe(true);
    expect(regulatorState("injury", "minor", null)).toBe("not_required");
    expect(regulatorState("injury", "fatal", null)).toBe("required");
    expect(regulatorState("injury", "fatal", "notified")).toBe("notified");
  });

  it("closes only an investigated incident whose every action is verified or cancelled", () => {
    expect(incidentCloseBlockers(investigated, [{ status: "verified" }], null)).toEqual([]);
    expect(
      incidentCloseBlockers(
        { ...investigated, status: "reported" },
        [{ status: "verified" }],
        null,
      ),
    ).toEqual(["not_investigated"]);
    expect(
      incidentCloseBlockers(investigated, [{ status: "verified" }, { status: "done" }], null),
    ).toEqual(["actions_outstanding"]);
    expect(
      incidentCloseBlockers(investigated, [{ status: "verified" }, { status: "open" }], null),
    ).toEqual(["actions_outstanding"]);
    // Cancelled actions do not count either way.
    expect(
      incidentCloseBlockers(investigated, [{ status: "verified" }, { status: "cancelled" }], null),
    ).toEqual([]);
  });

  it("needs a verified action unless a reason for none is given", () => {
    expect(incidentCloseBlockers(investigated, [], null)).toEqual(["no_verified_action"]);
    expect(incidentCloseBlockers(investigated, [{ status: "cancelled" }], "  ")).toEqual([
      "no_verified_action",
    ]);
    expect(
      incidentCloseBlockers(investigated, [], "Isolated slip; area already dry and signed"),
    ).toEqual([]);
  });

  it("refuses to close a serious injury without a recorded regulator decision", () => {
    const serious = { ...investigated, severity: "serious" as const };
    expect(incidentCloseBlockers(serious, [{ status: "verified" }], null)).toEqual([
      "regulator_decision_required",
    ]);
    expect(
      incidentCloseBlockers(
        { ...serious, regulatorDecision: "notified" },
        [{ status: "verified" }],
        null,
      ),
    ).toEqual([]);
  });

  it("allows investigating twice (revision) but never reopening a closed or voided incident", () => {
    expect(checkProcurementTransition(INCIDENT_TRANSITIONS, "reported", "investigate")).toEqual({
      ok: true,
      to: "investigated",
    });
    expect(checkProcurementTransition(INCIDENT_TRANSITIONS, "investigated", "investigate").ok).toBe(
      true,
    );
    expect(checkProcurementTransition(INCIDENT_TRANSITIONS, "reported", "close").ok).toBe(false);
    for (const status of ["closed", "voided"] as const)
      for (const action of ["investigate", "close", "void"] as const)
        expect(
          checkProcurementTransition(INCIDENT_TRANSITIONS, status, action, "a reason").ok,
        ).toBe(false);
    expect(checkProcurementTransition(INCIDENT_TRANSITIONS, "reported", "void").ok).toBe(false);
  });

  it("locks a toolbox talk once confirmed", () => {
    expect(checkProcurementTransition(TOOLBOX_TALK_TRANSITIONS, "draft", "confirm")).toEqual({
      ok: true,
      to: "confirmed",
    });
    expect(checkProcurementTransition(TOOLBOX_TALK_TRANSITIONS, "confirmed", "confirm").ok).toBe(
      false,
    );
    expect(
      checkProcurementTransition(TOOLBOX_TALK_TRANSITIONS, "confirmed", "cancel", "mistake").ok,
    ).toBe(false);
  });
});

describe("first aid", () => {
  const kit = { status: "active" as const, lastCheckedOn: "2026-11-01", expiresOn: "2027-06-30" };

  it("reads a kit's state: expired outranks an overdue check, which outranks expiring", () => {
    expect(kitState(kit, 30, TODAY)).toBe("ok");
    expect(kitState({ ...kit, lastCheckedOn: null }, 30, TODAY)).toBe("never_checked");
    expect(kitState({ ...kit, status: "retired" }, 30, TODAY)).toBe("retired");
    // Checked 01/11 every 7 days: next due 08/11, overdue on 14/11.
    expect(kitState(kit, 7, TODAY)).toBe("check_due");
    expect(kitState({ ...kit, expiresOn: "2026-11-13" }, 7, TODAY)).toBe("expired");
    // Usable through the expiry date itself.
    expect(kitState({ ...kit, expiresOn: TODAY }, 30, TODAY)).toBe("expiring");
    expect(kitState({ ...kit, expiresOn: "2026-12-14" }, 30, TODAY)).toBe("expiring");
    expect(kitState({ ...kit, expiresOn: "2026-12-15" }, 30, TODAY)).toBe("ok");
  });

  it("reads a first-aid certificate as valid, expiring within 30 days, or expired", () => {
    expect(certificateState("2027-11-14", TODAY)).toBe("valid");
    expect(certificateState("2026-12-14", TODAY)).toBe("expiring");
    expect(certificateState(TODAY, TODAY)).toBe("expiring");
    expect(certificateState("2026-11-13", TODAY)).toBe("expired");
  });
});
