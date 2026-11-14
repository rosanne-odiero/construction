import { describe, expect, it } from "vitest";
import {
  completionActionRequestSchema,
  correctCubeResultRequestSchema,
  createCubeSetRequestSchema,
  createSnagRequestSchema,
  inspectionActionRequestSchema,
  proposeCompletionRequestSchema,
  recordCubeResultRequestSchema,
  snagActionRequestSchema,
  updateInspectionRequestSchema,
} from "./quality.js";

const id = "31000000-0000-4000-8000-000000000001";

describe("quality contracts", () => {
  it("takes cube strengths as decimal strings with one decimal place, 0–150 N/mm²", () => {
    const result = (strengths: string[]) =>
      recordCubeResultRequestSchema.safeParse({ ageDays: 28, testedOn: "2026-11-10", strengths })
        .success;
    expect(result(["27.5", " 30 ", "0.0"])).toBe(true);
    for (const bad of [["27.55"], ["-1"], ["150.1"], ["1e2"], [], Array(7).fill("25")])
      expect(result(bad)).toBe(false);
    expect(
      recordCubeResultRequestSchema.safeParse({
        ageDays: 14,
        testedOn: "2026-11-10",
        strengths: ["25"],
      }).success,
    ).toBe(false);
    // Corrections always carry a reason; planning dates stay within 2000–2099.
    expect(
      correctCubeResultRequestSchema.safeParse({ testedOn: "2026-11-10", strengths: ["25"] })
        .success,
    ).toBe(false);
    expect(
      createCubeSetRequestSchema.safeParse({
        siteId: id,
        element: "Slab",
        concreteClass: "C25",
        castOn: "2100-01-01",
      }).success,
    ).toBe(false);
  });

  it("asks for a reason exactly when returning, reopening or withdrawing", () => {
    expect(inspectionActionRequestSchema.safeParse({ version: 1, action: "return" }).success).toBe(
      false,
    );
    expect(
      inspectionActionRequestSchema.safeParse({ version: 1, action: "sign_off", reason: "ok ok" })
        .success,
    ).toBe(false);
    expect(snagActionRequestSchema.safeParse({ version: 1, action: "reopen" }).success).toBe(false);
    expect(
      snagActionRequestSchema.safeParse({ version: 1, action: "close", note: "fixed it" }).success,
    ).toBe(false);
    expect(
      completionActionRequestSchema.safeParse({ version: 1, action: "withdraw", reason: "Wrong" })
        .success,
    ).toBe(true);
  });

  it("counts characters as code points and refuses control characters", () => {
    const snag = {
      siteId: id,
      location: "Unit 3",
      description: "🧱🧱",
      severity: "minor",
      responsibleKind: "gang",
      responsibleName: "Masons",
    };
    // Two code points (four UTF-16 units) is shorter than the 3-character minimum.
    expect(createSnagRequestSchema.safeParse(snag).success).toBe(false);
    expect(createSnagRequestSchema.safeParse({ ...snag, description: "🧱🧱🧱" }).success).toBe(
      true,
    );
    expect(
      createSnagRequestSchema.safeParse({ ...snag, description: "Crack\u0007 in wall" }).success,
    ).toBe(false);
  });

  it("refuses duplicate items and photos and DLP months on a final certificate", () => {
    expect(
      updateInspectionRequestSchema.safeParse({
        version: 1,
        items: [
          { id, result: "pass", note: null, photoIds: [] },
          { id, result: "fail", note: "x", photoIds: [] },
        ],
      }).success,
    ).toBe(false);
    expect(
      updateInspectionRequestSchema.safeParse({
        version: 1,
        items: [{ id, result: "pass", note: null, photoIds: [id, id] }],
      }).success,
    ).toBe(false);
    expect(
      proposeCompletionRequestSchema.safeParse({
        kind: "final",
        completionDate: "2027-01-15",
        dlpMonths: 6,
      }).success,
    ).toBe(false);
  });
});
