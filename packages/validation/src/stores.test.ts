import { describe, expect, it } from "vitest";
import {
  createIssueRequestSchema,
  createMeasurementRequestSchema,
  createWastageRequestSchema,
  dispatchTransferRequestSchema,
  recordCountsRequestSchema,
  updateStoresSettingsRequestSchema,
} from "./index.js";

const ID = "01900000-0000-7000-8000-000000000001";
const OTHER = "01900000-0000-7000-8000-000000000002";
const AT = "2026-11-14T08:00:00+03:00";
const issues = (result: { success: boolean; error?: { issues: { message: string }[] } }) =>
  result.success ? [] : result.error!.issues.map((issue) => issue.message);
const line = { materialId: ID, quantity: "10", unit: "bag_50kg" };

describe("D5.3 stores schemas", () => {
  it("needs a BQ item or a gang for an issue, and one line per material", () => {
    const base = { id: ID, storeId: ID, capturedAt: AT, issuedToName: "Mason gang", lines: [line] };
    expect(issues(createIssueRequestSchema.safeParse(base))).toEqual(["issue_target_required"]);
    expect(createIssueRequestSchema.safeParse({ ...base, gangId: OTHER }).success).toBe(true);
    expect(
      issues(createIssueRequestSchema.safeParse({ ...base, gangId: OTHER, lines: [line, line] })),
    ).toEqual(["duplicate_line"]);
    expect(
      issues(
        createIssueRequestSchema.safeParse({
          ...base,
          gangId: OTHER,
          lines: [{ ...line, quantity: "0" }],
        }),
      ),
    ).toEqual(["quantity_not_positive"]);
  });

  it("requires a wastage note, two different stores for a transfer and unique count lines", () => {
    const wastage = { id: ID, storeId: ID, capturedAt: AT, reason: "damaged", lines: [line] };
    expect(
      createWastageRequestSchema.safeParse({ ...wastage, notes: "Bags burst in rain" }).success,
    ).toBe(true);
    expect(createWastageRequestSchema.safeParse(wastage).success).toBe(false);
    expect(
      issues(
        dispatchTransferRequestSchema.safeParse({
          id: ID,
          fromStoreId: ID,
          toStoreId: ID,
          capturedAt: AT,
          lines: [line],
        }),
      ),
    ).toEqual(["same_store"]);
    expect(
      issues(
        recordCountsRequestSchema.safeParse({
          capturedAt: AT,
          counts: [
            { id: ID, lineId: OTHER, countedQuantity: "4" },
            { id: OTHER, lineId: OTHER, countedQuantity: "5" },
          ],
        }),
      ),
    ).toEqual(["duplicate_line"]);
  });

  it("keeps the variance threshold a bounded percentage and needs a reason for a correction", () => {
    expect(
      updateStoresSettingsRequestSchema.safeParse({
        version: null,
        varianceThresholdPercent: "12.5",
      }).success,
    ).toBe(true);
    expect(
      issues(
        updateStoresSettingsRequestSchema.safeParse({
          version: 1,
          varianceThresholdPercent: "1001",
        }),
      ),
    ).toEqual(["percent_too_large"]);
    expect(
      issues(
        createMeasurementRequestSchema.safeParse({
          bqItemLineageId: ID,
          measuredOn: "2026-11-13",
          quantityToDate: "12.5",
          correctsMeasurementId: OTHER,
        }),
      ),
    ).toEqual(["required"]);
    expect(
      issues(
        createMeasurementRequestSchema.safeParse({
          bqItemLineageId: ID,
          measuredOn: "2026-11-13",
          quantityToDate: "12.12345",
        }),
      ),
    ).toEqual(["invalid_quantity"]);
  });
});
