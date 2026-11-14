import { describe, expect, it } from "vitest";
import {
  addValuationAdjustmentRequestSchema,
  addValuationMaterialRequestSchema,
  certifyValuationRequestSchema,
  createMeasurementRequestSchema,
  createValuationRequestSchema,
  measurementPhotosRequestSchema,
  updateContractSettingsRequestSchema,
} from "./index.js";

const ID = "01900000-0000-7000-8000-000000000001";
const OTHER = "01900000-0000-7000-8000-000000000002";
const issues = (result: { success: boolean; error?: { issues: { message: string }[] } }) =>
  result.success ? [] : (result.error?.issues ?? []).map((issue) => issue.message);

describe("measurement requests", () => {
  const base = { bqItemLineageId: ID, measuredOn: "2026-11-13", quantityToDate: "12.5" };

  it("accepts photos, an over-measure reason and defaults", () => {
    const parsed = createMeasurementRequestSchema.parse({
      ...base,
      id: OTHER,
      photoIds: [OTHER],
      overMeasureReason: "  Remeasured with the consultant  ",
    });
    expect(parsed).toMatchObject({
      photoIds: [OTHER],
      correctsMeasurementId: null,
      overMeasureReason: "Remeasured with the consultant",
    });
    expect(createMeasurementRequestSchema.parse(base).photoIds).toEqual([]);
  });

  it("refuses bad quantities, missing or short reasons and duplicate photos", () => {
    expect(
      issues(createMeasurementRequestSchema.safeParse({ ...base, correctsMeasurementId: OTHER })),
    ).toEqual(["required"]);
    expect(
      issues(
        createMeasurementRequestSchema.safeParse({
          ...base,
          correctsMeasurementId: OTHER,
          correctionReason: "no",
        }),
      ),
    ).toEqual(["too_short"]);
    expect(
      issues(createMeasurementRequestSchema.safeParse({ ...base, quantityToDate: "12.12345" })),
    ).toEqual(["invalid_quantity"]);
    expect(
      issues(createMeasurementRequestSchema.safeParse({ ...base, quantityToDate: "-1" })),
    ).toEqual(["invalid_quantity"]);
    expect(
      issues(createMeasurementRequestSchema.safeParse({ ...base, overMeasureReason: "ab" })),
    ).toEqual(["too_short"]);
    expect(
      issues(createMeasurementRequestSchema.safeParse({ ...base, photoIds: [ID, ID] })),
    ).toEqual(["duplicate_photo"]);
    expect(createMeasurementRequestSchema.safeParse({ ...base, measuredBy: ID }).success).toBe(
      false,
    );
    expect(measurementPhotosRequestSchema.safeParse({ photoIds: [] }).success).toBe(false);
  });
});

describe("valuation requests", () => {
  it("ties a release stage to retention releases only", () => {
    // Omitted, the stores choice is left to the API (the last certified interim's choice).
    const parsed = createValuationRequestSchema.parse({
      kind: "interim",
      valuationDate: "2026-11-13",
    });
    expect(parsed).toMatchObject({ releaseStage: null });
    expect(parsed.materialsFromStores).toBeUndefined();
    expect(
      issues(
        createValuationRequestSchema.safeParse({
          kind: "retention_release",
          valuationDate: "2026-11-13",
        }),
      ),
    ).toEqual(["release_stage_mismatch"]);
    expect(
      issues(
        createValuationRequestSchema.safeParse({
          kind: "interim",
          releaseStage: "practical",
          valuationDate: "2026-11-13",
        }),
      ),
    ).toEqual(["release_stage_mismatch"]);
    expect(
      issues(
        createValuationRequestSchema.safeParse({
          kind: "retention_release",
          releaseStage: "final",
          valuationDate: "2026-11-13",
          materialsFromStores: true,
        }),
      ),
    ).toEqual(["interim_only"]);
  });

  it("checks adjustment signs and materials on site", () => {
    const adjustment = { version: 1, description: "Mobilisation advance" };
    expect(
      addValuationAdjustmentRequestSchema.safeParse({
        ...adjustment,
        kind: "advance",
        amountMinor: 10_000_000,
      }).success,
    ).toBe(true);
    expect(
      issues(
        addValuationAdjustmentRequestSchema.safeParse({
          ...adjustment,
          kind: "advance_recovery",
          amountMinor: 5_000_000,
        }),
      ),
    ).toEqual(["adjustment_sign"]);
    expect(
      issues(
        addValuationAdjustmentRequestSchema.safeParse({
          ...adjustment,
          kind: "other",
          amountMinor: 0,
        }),
      ),
    ).toEqual(["adjustment_sign"]);
    expect(
      addValuationMaterialRequestSchema.safeParse({
        version: 1,
        bqItemLineageId: ID,
        description: "Blocks on site",
        quantity: "0",
        amountMinor: 100,
      }).success,
    ).toBe(false);
    expect(
      addValuationMaterialRequestSchema.parse({
        version: 1,
        bqItemLineageId: ID,
        description: "Blocks on site",
        unit: "",
        quantity: "400",
        amountMinor: 4_000_000,
      }).unit,
    ).toBeNull();
  });

  it("certifies only on a digest and keeps settings in range", () => {
    expect(
      certifyValuationRequestSchema.safeParse({ version: 2, digest: "a".repeat(64) }).success,
    ).toBe(true);
    expect(
      issues(certifyValuationRequestSchema.safeParse({ version: 2, digest: "A".repeat(64) })),
    ).toEqual(["invalid_digest"]);
    const settings = {
      version: 0,
      retentionPercent: "10",
      retentionCapPercent: null,
      vatPercent: "16",
      materialsPercent: "80",
      practicalReleasePercent: "50",
    };
    expect(updateContractSettingsRequestSchema.safeParse(settings).success).toBe(true);
    expect(
      issues(
        updateContractSettingsRequestSchema.safeParse({ ...settings, retentionPercent: "25" }),
      ),
    ).toEqual(["out_of_range"]);
    expect(
      issues(updateContractSettingsRequestSchema.safeParse({ ...settings, vatPercent: "16.125" })),
    ).toEqual(["invalid_percent"]);
  });
});
