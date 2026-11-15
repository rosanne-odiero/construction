import { describe, expect, it } from "vitest";
import { DPIA_GO_LIVE_CONDITIONS } from "@pm-buddy/types";
import {
  approveDpiaRequestSchema,
  biometricSwitchRequestSchema,
  createDpiaRequestSchema,
  withdrawDpiaRequestSchema,
} from "./biometrics.js";

const site = "31000000-0000-4000-8000-000000000001";
const empty = {
  methods: [],
  siteIds: [],
  dpoName: null,
  dpoOpinion: null,
  dpoOpinionOn: null,
  dpoNote: null,
  controllerName: null,
  controllerRole: null,
  controllerDecision: null,
  controllerDecisionOn: null,
  controllerNote: null,
  residualRisk: null,
  odpcReference: null,
};

describe("DPIA contracts", () => {
  it("accepts an empty draft and stores blank text as null", () => {
    expect(createDpiaRequestSchema.parse({ ...empty, dpoName: "  ", dpoNote: "" })).toMatchObject({
      dpoName: null,
      dpoNote: null,
    });
  });

  it("refuses repeated methods or sites, unknown methods and a tenant ID in the body", () => {
    const refused = (change: Record<string, unknown>) =>
      createDpiaRequestSchema.safeParse({ ...empty, ...change }).success;
    expect(refused({ methods: ["face", "face"] })).toBe(false);
    expect(refused({ siteIds: [site, site] })).toBe(false);
    expect(refused({ methods: ["web_manual"] })).toBe(false);
    expect(refused({ tenantId: site })).toBe(false);
    expect(refused({ methods: ["face", "terminal"], siteIds: [site] })).toBe(true);
  });

  it("binds approval to a document hash, a review date and distinct confirmations", () => {
    const approval = {
      version: 3,
      documentSha256: "a".repeat(64),
      reviewDue: "2027-11-15",
      confirmations: [...DPIA_GO_LIVE_CONDITIONS],
    };
    expect(approveDpiaRequestSchema.safeParse(approval).success).toBe(true);
    expect(
      approveDpiaRequestSchema.safeParse({ ...approval, documentSha256: "A".repeat(64) }).success,
    ).toBe(false);
    expect(
      approveDpiaRequestSchema.safeParse({
        ...approval,
        confirmations: ["fallback_ready", "fallback_ready"],
      }).success,
    ).toBe(false);
  });

  it("needs a real reason to withdraw, and only a boolean to switch", () => {
    expect(withdrawDpiaRequestSchema.safeParse({ version: 1, reason: "short" }).success).toBe(
      false,
    );
    expect(
      withdrawDpiaRequestSchema.safeParse({ version: 1, reason: "Vendor SDK sends telemetry" })
        .success,
    ).toBe(true);
    expect(biometricSwitchRequestSchema.safeParse({ enabled: "yes" }).success).toBe(false);
    expect(biometricSwitchRequestSchema.parse({ enabled: false, reason: "" })).toEqual({
      enabled: false,
      reason: null,
    });
  });
});
