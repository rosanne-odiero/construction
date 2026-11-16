import { describe, expect, it } from "vitest";
import {
  biometricConsentStatus,
  biometricGate,
  carriedForwardSwitches,
  coversModality,
  dpiaApprovalContent,
  dpiaApprovalGaps,
  dpiaReviewDueRange,
  dpiaState,
  enrolmentState,
  isDpiaReviewDueValid,
  looksLikeImage,
  methodReads,
  retentionDueOn,
  smsCompanyName,
  type BiometricGateInput,
  type DpiaDraftFacts,
} from "./biometrics.js";

const complete: DpiaDraftFacts = {
  hasDocument: true,
  methods: ["face"],
  siteCount: 1,
  dpoName: "Achieng Otieno",
  dpoPhone: "+254 712 345 678",
  dpoOpinion: "approve",
  dpoOpinionOn: "2026-11-10",
  dpoNote: null,
  controllerName: "Wanjiru Kamau",
  controllerDecision: "proceed",
  controllerDecisionOn: "2026-11-12",
  controllerNote: null,
  residualRisk: "medium",
  odpcReference: null,
};

describe("dpiaState", () => {
  it("keeps an approved DPIA in force through its review date and lapses it the day after", () => {
    expect(dpiaState("approved", "2026-11-15", "2026-11-15")).toBe("in_force");
    expect(dpiaState("approved", "2026-11-15", "2026-11-16")).toBe("lapsed");
    expect(dpiaState("approved", null, "2026-11-15")).toBe("lapsed");
    for (const status of ["draft", "rejected", "superseded", "withdrawn"] as const)
      expect(dpiaState(status, "2099-01-01", "2026-11-15")).toBe(status);
  });
});

describe("review date", () => {
  it("runs from tomorrow to twelve calendar months ahead, clamped like PostgreSQL", () => {
    expect(dpiaReviewDueRange("2026-11-15")).toEqual({
      earliest: "2026-11-16",
      latest: "2027-11-15",
    });
    expect(dpiaReviewDueRange("2028-02-29").latest).toBe("2029-02-28");
    expect(isDpiaReviewDueValid("2026-11-15", "2026-11-15")).toBe(false);
    expect(isDpiaReviewDueValid("2026-11-16", "2026-11-15")).toBe(true);
    expect(isDpiaReviewDueValid("2027-11-15", "2026-11-15")).toBe(true);
    expect(isDpiaReviewDueValid("2027-11-16", "2026-11-15")).toBe(false);
  });
});

describe("dpiaApprovalGaps", () => {
  const today = "2026-11-15";
  const gaps = (change: Partial<DpiaDraftFacts>) =>
    dpiaApprovalGaps({ ...complete, ...change }, today);

  it("finds nothing missing in a complete draft", () => {
    expect(gaps({})).toEqual([]);
  });

  it("requires the signed document, a method, a site and both sign-offs", () => {
    expect(
      gaps({
        hasDocument: false,
        methods: [],
        siteCount: 0,
        dpoName: null,
        dpoPhone: null,
        controllerDecision: null,
      }),
    ).toEqual(["document", "methods", "sites", "dpo", "dpo_phone", "controller"]);
  });

  it("never approves a DPO rejection or a decision not to proceed", () => {
    expect(gaps({ dpoOpinion: "reject" })).toEqual(["dpo_rejected"]);
    expect(gaps({ controllerDecision: "do_not_proceed" })).toEqual(["controller_declined"]);
  });

  it("needs the conditions written down when an opinion or decision has them", () => {
    expect(gaps({ dpoOpinion: "approve_with_conditions" })).toEqual(["dpo_conditions"]);
    expect(
      gaps({ dpoOpinion: "approve_with_conditions", dpoNote: "Quarterly accuracy review" }),
    ).toEqual([]);
    expect(gaps({ controllerDecision: "proceed_with_conditions" })).toEqual([
      "controller_conditions",
    ]);
  });

  it("refuses signatures dated after today", () => {
    expect(gaps({ dpoOpinionOn: "2026-11-16" })).toEqual(["signature_dates"]);
    expect(gaps({ controllerDecisionOn: "2026-11-16" })).toEqual(["signature_dates"]);
    expect(gaps({ dpoOpinionOn: today, controllerDecisionOn: today })).toEqual([]);
  });

  it("needs a residual risk, and the ODPC consultation reference when it is high", () => {
    expect(gaps({ residualRisk: null })).toEqual(["residual_risk"]);
    expect(gaps({ residualRisk: "high" })).toEqual(["odpc_consultation"]);
    expect(gaps({ residualRisk: "high", odpcReference: "ODPC/PC/2026/014" })).toEqual([]);
  });
});

describe("biometricGate", () => {
  const approved = {
    id: "dpia-2",
    reviewDue: "2027-06-30",
    methods: ["face"] as const,
    siteIds: ["site-a"],
  };
  const open: BiometricGateInput = {
    platformAvailable: true,
    projectStatus: "active",
    approved,
    latestSwitch: { enabled: true, dpiaRecordId: "dpia-2" },
    siteId: "site-a",
    method: "face",
    today: "2026-11-15",
  };
  const gate = (change: Partial<BiometricGateInput>) => biometricGate({ ...open, ...change });

  it("is on only when switched on under the DPIA in force that covers the site and method", () => {
    expect(gate({})).toEqual({ on: true, reason: null });
    expect(gate({ latestSwitch: null }).reason).toBe("switched_off");
    expect(gate({ latestSwitch: { enabled: false, dpiaRecordId: "dpia-2" } }).reason).toBe(
      "switched_off",
    );
    // A switch made under an earlier (superseded or withdrawn) DPIA does not count.
    expect(gate({ latestSwitch: { enabled: true, dpiaRecordId: "dpia-1" } }).reason).toBe(
      "switched_off",
    );
  });

  it("fails closed in a fixed order: platform, project, DPIA, review date, scope", () => {
    expect(gate({ platformAvailable: false, approved: null }).reason).toBe("platform_off");
    expect(gate({ projectStatus: "closed", approved: null }).reason).toBe("project_closed");
    expect(gate({ projectStatus: "cancelled" }).reason).toBe("project_closed");
    expect(gate({ approved: null }).reason).toBe("no_dpia");
    expect(gate({ today: "2027-06-30" }).on).toBe(true);
    expect(gate({ today: "2027-07-01" }).reason).toBe("dpia_lapsed");
    expect(gate({ method: "fingerprint" }).reason).toBe("not_in_scope");
    expect(gate({ siteId: "site-b" }).reason).toBe("not_in_scope");
  });
});

describe("carriedForwardSwitches", () => {
  it("keeps on only what was on under the superseded DPIA and the renewal still covers", () => {
    const latest = [
      { siteId: "a", method: "face", enabled: true, dpiaRecordId: "v1", projectStatus: "active" },
      {
        siteId: "a",
        method: "fingerprint",
        enabled: true,
        dpiaRecordId: "v1",
        projectStatus: "active",
      },
      { siteId: "b", method: "face", enabled: true, dpiaRecordId: "v1", projectStatus: "closed" },
      { siteId: "c", method: "face", enabled: false, dpiaRecordId: "v1", projectStatus: "active" },
      { siteId: "d", method: "face", enabled: true, dpiaRecordId: "v0", projectStatus: "active" },
      { siteId: "e", method: "face", enabled: true, dpiaRecordId: "v1", projectStatus: "active" },
    ] as const;
    expect(
      carriedForwardSwitches(latest, "v1", { methods: ["face"], siteIds: ["a", "b", "c", "d"] }),
    ).toEqual([{ siteId: "a", method: "face" }]);
  });
});

describe("dpiaApprovalContent", () => {
  it("does not depend on the order of methods, sites or conditions", () => {
    const base = {
      ...complete,
      versionNo: 2,
      controllerRole: "Director",
      documentSha256: "a".repeat(64),
      reviewDue: "2027-11-15",
    };
    expect(
      dpiaApprovalContent({
        ...base,
        methods: ["fingerprint", "face"],
        siteIds: ["s2", "s1"],
        conditions: ["staff_trained", "fallback_ready"],
      }),
    ).toEqual(
      dpiaApprovalContent({
        ...base,
        methods: ["face", "fingerprint"],
        siteIds: ["s1", "s2"],
        conditions: ["fallback_ready", "staff_trained"],
      }),
    );
  });
});

describe("modalities", () => {
  it("are covered by their own method or a terminal, and read by the same methods", () => {
    expect(coversModality(["face"], "face")).toBe(true);
    expect(coversModality(["face"], "fingerprint")).toBe(false);
    expect(coversModality(["terminal"], "fingerprint")).toBe(true);
    expect(methodReads("terminal", "face")).toBe(true);
    expect(methodReads("fingerprint", "face")).toBe(false);
  });
});

describe("biometricConsentStatus", () => {
  const at = (day: number) => `2026-11-${String(day).padStart(2, "0")}T08:00:00.000Z`;
  const current = "biometric-face-2026-11-v1";

  it("is granted while a grant is not withdrawn, current when it is to the current notice", () => {
    expect(biometricConsentStatus([], current)).toEqual({ status: "none", current: false });
    const grant = { granted: true, noticeVersion: current, capturedAt: at(2), withdrawnAt: null };
    expect(biometricConsentStatus([grant], current)).toEqual({ status: "granted", current: true });
    expect(biometricConsentStatus([{ ...grant, noticeVersion: "old" }], current).current).toBe(
      false,
    );
  });

  it("otherwise follows the latest decision: a refusal or a withdrawal", () => {
    const withdrawn = {
      granted: true,
      noticeVersion: current,
      capturedAt: at(2),
      withdrawnAt: at(5),
    };
    const refusal = {
      granted: false,
      noticeVersion: current,
      capturedAt: at(9),
      withdrawnAt: null,
    };
    expect(biometricConsentStatus([withdrawn], current).status).toBe("withdrawn");
    expect(biometricConsentStatus([withdrawn, refusal], current).status).toBe("refused");
    expect(
      biometricConsentStatus([{ ...refusal, capturedAt: at(1) }, withdrawn], current).status,
    ).toBe("withdrawn");
  });
});

describe("retentionDueOn", () => {
  const today = "2026-11-16";

  it("keeps templates while any engagement is open or ends today or later", () => {
    expect(retentionDueOn([{ startDate: "2026-10-01", endDate: null }], 30, today)).toBeNull();
    expect(retentionDueOn([{ startDate: "2026-10-01", endDate: today }], 30, today)).toBeNull();
  });

  it("is due the day after the retention days that follow the last engagement's last day", () => {
    const ended = [
      { startDate: "2026-09-01", endDate: "2026-09-30" },
      { startDate: "2026-10-01", endDate: "2026-10-16" },
    ];
    expect(retentionDueOn(ended, 30, today)).toBe("2026-11-16");
    expect(retentionDueOn(ended, 0, today)).toBe("2026-10-17");
    expect(retentionDueOn([], 30, today)).toBe(today);
  });
});

describe("enrolmentState", () => {
  const base = { status: "active" as const, dueOn: null, today: "2026-11-16" };

  it("holds templates while the DPIA has lapsed and marks them due once retention passes", () => {
    expect(enrolmentState({ ...base, approved: { covers: true, inForce: true } })).toBe("active");
    expect(enrolmentState({ ...base, approved: { covers: true, inForce: false } })).toBe("held");
    expect(
      enrolmentState({ ...base, dueOn: "2026-11-16", approved: { covers: true, inForce: true } }),
    ).toBe("deletion_due");
    expect(enrolmentState({ ...base, approved: { covers: false, inForce: true } })).toBe(
      "deletion_due",
    );
    expect(enrolmentState({ ...base, approved: null })).toBe("deletion_due");
    expect(enrolmentState({ ...base, status: "deleted", approved: null })).toBe("deleted");
  });
});

describe("looksLikeImage", () => {
  const bytes = (...values: number[]) =>
    Uint8Array.from([...values, ...Array.from({ length: 32 }, () => 7)]);
  const text = (value: string) =>
    Array.from({ length: value.length }, (_, i) => value.charCodeAt(i));

  it("refuses images and image records but accepts templates", () => {
    expect(looksLikeImage(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe(true);
    expect(looksLikeImage(bytes(0x89, ...text("PNG"), 0x0d, 0x0a, 0x1a, 0x0a))).toBe(true);
    expect(looksLikeImage(bytes(0, 0, 0, 0x18, ...text("ftypheic")))).toBe(true);
    expect(looksLikeImage(bytes(0xff, 0xa0, 0xff, 0xa8))).toBe(true);
    expect(looksLikeImage(bytes(...text("FIR"), 0))).toBe(true);
    expect(looksLikeImage(bytes(...text("FMR"), 0, ...text(" 20")))).toBe(false);
    expect(looksLikeImage(bytes(...text("BM"), 1, 2))).toBe(false);
    expect(looksLikeImage(bytes(0x42, 0x4d, 9, 9, 9, 9, 0, 0, 0, 0))).toBe(true);
  });
});

describe("smsCompanyName", () => {
  it("cuts long company names so the confirmation fits one SMS", () => {
    expect(smsCompanyName("Ruiru Builders")).toBe("Ruiru Builders");
    expect(smsCompanyName("Mombasa Road Construction Limited")).toBe("Mombasa Road Constru");
    expect(smsCompanyName("Twenty characters x Ltd")).toBe("Twenty characters x");
  });
});
