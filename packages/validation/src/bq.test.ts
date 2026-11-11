import { describe, expect, it } from "vitest";
import {
  bqTemplateColumnsSchema,
  bqExportQuerySchema,
  bqSearchQuerySchema,
  bqSheetRowsQuerySchema,
  createBqTemplateRequestSchema,
  saveBqMappingRequestSchema,
  saveBqResolutionsRequestSchema,
} from "./index.js";

const sheet = {
  sheetIndex: 1,
  include: true,
  role: "bill" as const,
  billNumber: "2",
  billTitle: "SUBSTRUCTURE",
  headerRow: 5,
  firstDataRow: 6,
  lastDataRow: 40,
  columns: { ref: 0, description: 1, unit: 2, quantity: 3, rate: 4, amount: 5 },
};

function mappingIssues(overrides: Record<string, unknown>, extra: object[] = []) {
  const result = saveBqMappingRequestSchema.safeParse({
    mapping: { sheets: [{ ...sheet, ...overrides }, ...extra], templateId: null },
    version: 1,
  });
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe("BQ mapping requests", () => {
  it("accepts a complete bill mapping and a summary sheet", () => {
    expect(mappingIssues({})).toEqual([]);
    expect(
      mappingIssues({}, [
        { ...sheet, sheetIndex: 4, role: "summary", billNumber: "", billTitle: "" },
      ]),
    ).toEqual([]);
  });

  it("refuses inconsistent rows, columns and bill details with stable codes", () => {
    expect(mappingIssues({ lastDataRow: 5 })).toContain("last_before_first");
    expect(mappingIssues({ billNumber: "=1+1" })).toContain("invalid_bill_number");
    expect(mappingIssues({ billTitle: "  " })).toContain("bill_title_required");
    expect(mappingIssues({ columns: { quantity: 3, rate: 4, amount: 5 } })).toContain(
      "description_required",
    );
    expect(mappingIssues({ columns: { description: 1, quantity: 1, rate: 4 } })).toContain(
      "column_mapped_twice",
    );
    expect(mappingIssues({ columns: { description: 1, quantity: 3 } })).toContain(
      "amount_or_quantity_rate_required",
    );
    expect(mappingIssues({}, [{ ...sheet }])).toContain("sheet_listed_twice");
    expect(mappingIssues({ include: false })).toContain("no_bill_sheet");
    expect(mappingIssues({ headerRow: 0 }).length).toBeGreaterThan(0);
    expect(
      mappingIssues({ columns: { description: 1, amount: 5, total: 6 } }).length,
    ).toBeGreaterThan(0);
  });
});

describe("BQ resolutions, templates and queries", () => {
  it("requires a reason of at least three characters for accepted warnings", () => {
    const base = { rows: [{ sheetIndex: 1, row: 23, action: "computed" }], accepted: [] };
    expect(
      saveBqResolutionsRequestSchema.safeParse({ resolutions: base, version: 2 }).success,
    ).toBe(true);
    expect(
      saveBqResolutionsRequestSchema.safeParse({
        resolutions: { ...base, accepted: [{ code: "missing-unit", reason: "ok" }] },
        version: 2,
      }).success,
    ).toBe(false);
    expect(
      saveBqResolutionsRequestSchema.safeParse({
        resolutions: { ...base, accepted: [{ code: "not-a-code", reason: "Checked by the QS" }] },
        version: 2,
      }).success,
    ).toBe(false);
    expect(
      saveBqResolutionsRequestSchema.safeParse({
        resolutions: { rows: [{ sheetIndex: 1, row: 23, action: "delete" }], accepted: [] },
        version: 2,
      }).success,
    ).toBe(false);
  });

  it("bounds template names, searches, row windows and export locales", () => {
    const importId = "01890000-0000-7000-8000-000000000001";
    expect(
      createBqTemplateRequestSchema.safeParse({ name: "QS firm", importId, sheetIndex: 1 }).success,
    ).toBe(true);
    expect(
      createBqTemplateRequestSchema.safeParse({ name: "", importId, sheetIndex: 1 }).success,
    ).toBe(false);
    expect(bqSearchQuerySchema.safeParse({ q: "a" }).success).toBe(false);
    expect(bqSheetRowsQuerySchema.parse({ from: "3" })).toEqual({ from: 3, count: 60 });
    expect(bqSheetRowsQuerySchema.safeParse({ count: "201" }).success).toBe(false);
    expect(bqExportQuerySchema.parse({})).toEqual({ locale: "en" });
    expect(bqExportQuerySchema.safeParse({ locale: "fr" }).success).toBe(false);
  });
});

describe("template columns", () => {
  it("accepts offsets left of the first titled header cell and bounds the data offset", () => {
    expect(bqTemplateColumnsSchema.safeParse({ ref: -1, description: 0, amount: 4 }).success).toBe(
      true,
    );
    expect(bqTemplateColumnsSchema.safeParse({ description: -100 }).success).toBe(false);
    expect(bqTemplateColumnsSchema.safeParse({ description: 0.5 }).success).toBe(false);
  });
});
