import { describe, expect, it } from "vitest";
import type { DpiaDetail } from "@pm-buddy/validation";
import { dpiaRequest, renewalRequest, type DpiaFormState } from "./biometrics";

const form: DpiaFormState = {
  methods: ["face"],
  siteIds: ["31000000-0000-4000-8000-000000000001"],
  dpoName: "Achieng Otieno",
  dpoOpinion: "approve",
  dpoOpinionOn: "12/11/2026",
  dpoNote: "",
  controllerName: "Wanjiru Kamau",
  controllerRole: "Director",
  controllerDecision: "",
  controllerDecisionOn: "",
  controllerNote: "",
  residualRisk: "",
  odpcReference: "",
};

describe("DPIA form", () => {
  it("sends typed dates as ISO dates, unchosen options as null, and nothing while a date is malformed", () => {
    expect(dpiaRequest(form)).toMatchObject({
      dpoOpinion: "approve",
      dpoOpinionOn: "2026-11-12",
      controllerDecision: null,
      controllerDecisionOn: null,
      residualRisk: null,
    });
    expect(dpiaRequest({ ...form, controllerDecisionOn: "2026-11-12" })).toBeNull();
    expect(dpiaRequest({ ...form, dpoOpinionOn: "31/02/2026" })).toBeNull();
  });

  it("starts a renewal from the DPIA in force but never reuses its sign-offs", () => {
    const current = {
      methods: ["face", "fingerprint"],
      sites: [{ id: "31000000-0000-4000-8000-000000000001" }],
      dpo: { name: "Achieng Otieno", opinion: "approve", opinionOn: "2026-01-05", note: "x" },
      controller: {
        name: "Wanjiru Kamau",
        role: "Director",
        decision: "proceed",
        decisionOn: "2026-01-06",
        note: "y",
      },
      residualRisk: "high",
      odpcReference: "ODPC/PC/2026/014",
    } as unknown as DpiaDetail;
    expect(renewalRequest(current)).toEqual({
      methods: ["face", "fingerprint"],
      siteIds: ["31000000-0000-4000-8000-000000000001"],
      dpoName: "Achieng Otieno",
      dpoOpinion: null,
      dpoOpinionOn: null,
      dpoNote: null,
      controllerName: "Wanjiru Kamau",
      controllerRole: "Director",
      controllerDecision: null,
      controllerDecisionOn: null,
      controllerNote: null,
      residualRisk: "high",
      odpcReference: null,
    });
    expect(renewalRequest(null).methods).toEqual([]);
  });
});
