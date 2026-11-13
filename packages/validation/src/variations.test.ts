import { describe, expect, it } from "vitest";
import {
  approveVariationRequestSchema,
  bqDecimalInputSchema,
  buildupCodeSchema,
  buildupLineInputSchema,
  createBuildupRequestSchema,
  createInstructionRequestSchema,
  rejectVariationRequestSchema,
  saveVariationLinesRequestSchema,
  updateInstructionRequestSchema,
} from "./index.js";

const ID = "01900000-0000-7000-8000-000000000001";

describe("D2.3 request schemas", () => {
  it("accepts BQ decimals with up to four places and refuses anything else", () => {
    for (const value of ["0", "12.5", "999999999999.9999"])
      expect(bqDecimalInputSchema.safeParse(value).success, value).toBe(true);
    for (const value of ["-1", "1e3", "12.34567", "1,000", "1000000000000", ""])
      expect(bqDecimalInputSchema.safeParse(value).success, value).toBe(false);
  });

  it("validates instructions and refuses control characters or unknown fields", () => {
    const valid = {
      number: "AI-007",
      issuedOn: "2026-11-02",
      issuerName: "Arch. Achieng Otieno",
      issuerRole: "architect",
      subject: "Add a store room",
    };
    expect(createInstructionRequestSchema.parse(valid)).toMatchObject({ attachments: [] });
    expect(createInstructionRequestSchema.safeParse({ ...valid, number: "AI 7!" }).success).toBe(
      false,
    );
    expect(
      createInstructionRequestSchema.safeParse({ ...valid, subject: "Store\u0007room" }).success,
    ).toBe(false);
    expect(createInstructionRequestSchema.safeParse({ ...valid, tenantId: ID }).success).toBe(
      false,
    );
    expect(
      createInstructionRequestSchema.parse({ ...valid, description: "Line one\nLine two" })
        .description,
    ).toBe("Line one\nLine two");
    expect(updateInstructionRequestSchema.safeParse({ status: "closed" }).success).toBe(false);
    expect(updateInstructionRequestSchema.parse({ status: "closed", version: 2 }).status).toBe(
      "closed",
    );
  });

  it("distinguishes adjust, omit and add lines", () => {
    const parse = (line: object) =>
      saveVariationLinesRequestSchema.safeParse({ lines: [line], version: 1 });
    expect(parse({ action: "adjust", itemLineageId: ID, quantity: "14.75" }).success).toBe(true);
    expect(parse({ action: "omit", itemLineageId: ID }).success).toBe(true);
    expect(parse({ action: "omit", itemLineageId: ID, quantity: "0" }).success).toBe(false);
    expect(
      parse({
        action: "add",
        billLineageId: ID,
        newSection: { title: "Drainage" },
        description: "uPVC pipe",
        unit: "m",
        kind: "measured",
        quantity: "30",
        rate: "1250.33",
      }).success,
    ).toBe(true);
    expect(
      parse({ action: "add", billLineageId: ID, description: "x", kind: "pc_profit" }).success,
    ).toBe(false);
    expect(parse({ action: "adjust", itemLineageId: ID, baseVersionId: ID }).success).toBe(false);
    expect(parse({ action: "adjust", itemLineageId: ID, amountMinor: -5 }).success).toBe(false);
  });

  it("binds approvals to a snapshot digest and requires a rejection reason", () => {
    const snapshotDigest = "a".repeat(64);
    expect(approveVariationRequestSchema.safeParse({ version: 3, snapshotDigest }).success).toBe(
      true,
    );
    expect(approveVariationRequestSchema.safeParse({ version: 3 }).success).toBe(false);
    expect(
      approveVariationRequestSchema.safeParse({ version: 3, snapshotDigest: "A".repeat(64) })
        .success,
    ).toBe(false);
    expect(
      rejectVariationRequestSchema.safeParse({ version: 3, snapshotDigest, reason: "no" }).success,
    ).toBe(false);
    expect(
      rejectVariationRequestSchema.safeParse({ version: 3, snapshotDigest, reason: "Over budget" })
        .success,
    ).toBe(true);
  });

  it("validates build-ups: code, decimals with six places, waste up to 100 %", () => {
    expect(buildupCodeSchema.parse(" conc-c25 ")).toBe("CONC-C25");
    const line = {
      kind: "material",
      resourceName: "Cement",
      unit: "bag (50 kg)",
      quantity: "6.500001",
      wastePercent: "5",
      unitCostMinor: 85_000,
    };
    expect(buildupLineInputSchema.safeParse(line).success).toBe(true);
    expect(buildupLineInputSchema.safeParse({ ...line, quantity: "0" }).success).toBe(false);
    expect(buildupLineInputSchema.safeParse({ ...line, quantity: "1.1234567" }).success).toBe(
      false,
    );
    expect(buildupLineInputSchema.safeParse({ ...line, wastePercent: "100.5" }).success).toBe(
      false,
    );
    expect(buildupLineInputSchema.safeParse({ ...line, unitCostMinor: null }).success).toBe(true);
    expect(
      createBuildupRequestSchema.safeParse({
        code: "CONC-C25",
        name: "Concrete class 25",
        unit: "pct",
        lines: [line],
      }).success,
    ).toBe(false);
    expect(
      createBuildupRequestSchema.safeParse({
        code: "CONC-C25",
        name: "Concrete class 25",
        unit: "m3",
        lines: [],
      }).success,
    ).toBe(false);
  });
});
