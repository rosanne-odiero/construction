import { describe, expect, it } from "vitest";
import { DPIA_GO_LIVE_CONDITIONS } from "@pm-buddy/types";
import {
  approveDpiaRequestSchema,
  biometricSwitchRequestSchema,
  biometricTemplateInputSchema,
  createDpiaRequestSchema,
  enrolBiometricRequestSchema,
  recordBiometricConsentRequestSchema,
  withdrawDpiaRequestSchema,
} from "./biometrics.js";

const site = "31000000-0000-4000-8000-000000000001";
const empty = {
  methods: [],
  siteIds: [],
  dpoName: null,
  dpoPhone: null,
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

describe("biometric consent and enrolment contracts", () => {
  it("takes a written DPO phone number and stores a blank one as null", () => {
    const phone = (dpoPhone: string) => createDpiaRequestSchema.safeParse({ ...empty, dpoPhone });
    expect(phone("+254 712 345 678").data?.dpoPhone).toBe("+254 712 345 678");
    expect(phone(" ").data?.dpoPhone).toBeNull();
    expect(phone("0712-34").success).toBe(false);
    expect(phone("call me").success).toBe(false);
  });

  it("records a yes or a no to the notice, with a witness when it was read aloud", () => {
    const consent = {
      modality: "face",
      noticeVersion: "biometric-face-2026-11-v1",
      language: "sw",
      method: "signed",
      granted: false,
    };
    expect(recordBiometricConsentRequestSchema.safeParse(consent).success).toBe(true);
    expect(
      recordBiometricConsentRequestSchema.safeParse({ ...consent, method: "witnessed_verbal" })
        .success,
    ).toBe(false);
    expect(
      recordBiometricConsentRequestSchema.safeParse({ ...consent, modality: "iris" }).success,
    ).toBe(false);
  });

  it("accepts base64 templates of one algorithm from a method that reads the modality", () => {
    /** Base64 of `size` bytes of 0x07. */
    const bytes = (size: number) =>
      "BwcH".repeat(Math.floor(size / 3)) + ["", "Bw==", "Bwc="][size % 3];
    const template = {
      data: bytes(64),
      algorithm: "Vendor FaceNet",
      algorithmVersion: "2.1",
      qualityScore: 87.5,
    };
    const enrolment = {
      id: "41000000-0000-4000-8000-000000000001",
      labourerId: "41000000-0000-4000-8000-000000000002",
      siteId: site,
      method: "terminal",
      modality: "fingerprint",
      templates: [template],
    };
    const ok = (change: Record<string, unknown>) =>
      enrolBiometricRequestSchema.safeParse({ ...enrolment, ...change }).success;
    expect(ok({})).toBe(true);
    expect(ok({ method: "face" })).toBe(false);
    expect(ok({ templates: [] })).toBe(false);
    expect(ok({ templates: [template, { ...template, algorithmVersion: "3.0" }] })).toBe(false);
    expect(ok({ templates: [{ ...template, data: "not base64!" }] })).toBe(false);
    expect(ok({ templates: [{ ...template, data: bytes(8) }] })).toBe(false);
    expect(ok({ templates: [{ ...template, data: bytes(16_384) }] })).toBe(true);
    expect(ok({ templates: [{ ...template, data: bytes(16_385) }] })).toBe(false);
    expect(ok({ templates: [{ ...template, qualityScore: 101 }] })).toBe(false);
    expect(ok({ tenantId: site })).toBe(false);
  });

  it("takes every quality score with up to two decimals, despite binary floating point", () => {
    const score = (qualityScore: number) =>
      biometricTemplateInputSchema.safeParse({
        data: "BwcHBwcHBwcHBwcHBwcHBwcH",
        algorithm: "Vendor FaceNet",
        algorithmVersion: "2.1",
        qualityScore,
      }).success;
    // 64.1 * 100 is 6409.999999999999 in binary floating point.
    const refused = Array.from({ length: 10_001 }, (_, cents) => cents / 100).filter(
      (value) => !score(value),
    );
    expect(refused).toEqual([]);
    expect([64.1, 33.3, 72.57, 0.29].every(score)).toBe(true);
    expect(score(64.123)).toBe(false);
    expect(score(64.105)).toBe(false);
    expect(score(-0.01)).toBe(false);
  });
});
