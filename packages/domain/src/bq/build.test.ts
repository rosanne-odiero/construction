import { describe, expect, it } from "vitest";
import {
  analyseSheet,
  BQ_IMPORT_TRANSITIONS,
  buildBqImport,
  canTransitionImport,
  invalidResolutions,
  isImportResumable,
  proposeMapping,
  templateColumns,
  templateFromMapping,
  vatMinor,
  type BqMapping,
  type BqSheetMapping,
  type GridCell,
  type GridSheet,
  type WorkbookGrid,
} from "../index.js";

type Value = string | number | null | { f: string; v?: number };
const cell = (value: Value): GridCell | null => {
  if (value === null) return null;
  if (typeof value === "number") return { t: "n", v: value };
  if (typeof value === "string") return { t: "s", v: value };
  return value.v === undefined ? { t: "f" } : { t: "n", v: value.v, f: 1 };
};
const sheetOf = (name: string, rows: Value[][]): GridSheet => ({
  name,
  hidden: false,
  rows: rows.map((row) => row.map(cell)),
});
const HEADER: Value[] = ["ITEM", "DESCRIPTION", "UNIT", "QTY", "RATE", "AMOUNT"];
const COLUMNS = { ref: 0, description: 1, unit: 2, quantity: 3, rate: 4, amount: 5 };

/** A bill sheet: header on row 1, data from row 2. */
const bill = (rows: Value[][], number = "2", title = "SUBSTRUCTURE", name = `BILL ${number}`) => ({
  sheet: sheetOf(name, [HEADER, ...rows]),
  mapping: {
    sheetIndex: 0,
    include: true,
    role: "bill",
    billNumber: number,
    billTitle: title,
    headerRow: 1,
    firstDataRow: 2,
    lastDataRow: rows.length + 1,
    columns: COLUMNS,
  } satisfies BqSheetMapping,
});

function build(
  sheets: { sheet: GridSheet; mapping: BqSheetMapping }[],
  options: {
    contractSumMinor?: number | null;
    resolutions?: Parameters<typeof buildBqImport>[3];
  } = {},
) {
  const grid: WorkbookGrid = { fileType: "xlsx", sheets: sheets.map((entry) => entry.sheet) };
  const mapping: BqMapping = {
    sheets: sheets.map((entry, index) => ({ ...entry.mapping, sheetIndex: index })),
    templateId: null,
  };
  return buildBqImport(
    grid,
    mapping,
    { vatRatePercent: "16", contractSumMinor: options.contractSumMinor ?? null },
    options.resolutions,
  );
}
const codes = (result: ReturnType<typeof build>) =>
  result.issues
    .filter((issue) => issue.severity !== "info")
    .map((issue) => [issue.code, issue.row]);

describe("hierarchy", () => {
  it("builds Bill → Section → Item with multi-line descriptions and section notes", () => {
    const result = build([
      bill([
        [null, "EXCAVATION AND EARTHWORKS"],
        [null, "All excavation shall be measured net."],
        [null, "Foundations"],
        ["A", "Excavate trenches for strip foundations"],
        [null, "not exceeding 1.5 m deep", "m3", 145, 650, 94_250],
        ["B", "Return, fill and ram", "m3", 180, 350, 63_000],
        [null, null],
        [null, "CONCRETE WORK"],
        ["A", "Blinding 50 mm thick", "m2", 610, 620, 378_200],
      ]),
    ]);
    const [built] = result.bills;
    expect(
      built!.sections.map((section) => [section.title, section.notes, section.items.length]),
    ).toEqual([
      ["EXCAVATION AND EARTHWORKS", "All excavation shall be measured net.", 0],
      ["Foundations", null, 2],
      ["CONCRETE WORK", null, 1],
    ]);
    expect(built!.sections[1]!.items[0]).toMatchObject({
      ref: "A",
      description: "Excavate trenches for strip foundations\nnot exceeding 1.5 m deep",
      unit: "m3",
      quantity: "145",
      rate: "650",
      amountMinor: 9_425_000,
      sheetAmountMinor: 9_425_000,
      amountSource: "computed",
      sheetRow: 6,
    });
    expect(built!.totalMinor).toBe(9_425_000 + 6_300_000 + 37_820_000);
    expect(result.totals.sectionCount).toBe(3);
    expect(result.readiness.canCommit).toBe(true);
  });

  it("puts items before any heading in an untitled section and excludes summary rows from items", () => {
    const result = build([
      bill([
        ["A", "Item one", "No.", 2, 100, 200],
        [null, "Carried to Collection", null, null, null, 200],
        [null, "COLLECTION"],
        [null, "Page 2/1", null, null, null, 200],
        [null, "Total for Bill No. 2 carried to Summary", null, null, null, 200],
      ]),
    ]);
    expect(result.bills[0]!.sections).toHaveLength(1);
    expect(result.bills[0]!.sections[0]).toMatchObject({ title: null, code: null });
    expect(result.bills[0]!.itemCount).toBe(1);
    expect(result.bills[0]!.sheetTotalMinor).toBe(20_000);
    expect(codes(result)).toEqual([]);
  });

  it("classifies lump sums, PC sums with percentage profit and attendance, and other special lines", () => {
    const result = build([
      bill(
        [
          [null, "PRIME COST SUMS"],
          [
            "A",
            "Provide the PC sum of KShs 500,000 for kitchen fittings",
            "Item",
            null,
            null,
            500_000,
          ],
          ["B", "Add for profit", "%", 5, null, 25_000],
          ["C", "Add for attendance", "%", 2.5, null, 12_500],
          [
            "D",
            "Provide the provisional sum of KShs 100,000 for power",
            "Sum",
            null,
            null,
            100_000,
          ],
          ["E", "Provide for dayworks", "Item", null, null, 50_000],
          ["F", "Allow for contingencies", "Item", null, null, 80_000],
          ["G", "Sanitary fittings", "No.", 4, "Incl.", null],
        ],
        "9",
        "PC AND PROVISIONAL SUMS",
      ),
    ]);
    const items = result.bills[0]!.sections[0]!.items;
    expect(items.map((item) => [item.ref, item.kind, item.amountSource, item.amountMinor])).toEqual(
      [
        ["A", "pc_sum", "lump_sum", 50_000_000],
        ["B", "pc_profit", "percentage", 2_500_000],
        ["C", "pc_attendance", "percentage", 1_250_000],
        ["D", "provisional_sum", "lump_sum", 10_000_000],
        ["E", "daywork", "lump_sum", 5_000_000],
        ["F", "contingency", "lump_sum", 8_000_000],
        ["G", "measured", "included", 0],
      ],
    );
    expect(result.bills[0]!.kind).toBe("provisional");
    expect(result.totals.byKind).toEqual({
      measured: 0,
      preliminaries: 0,
      provisionalSums: 10_000_000,
      pcSums: 50_000_000,
      pcAttendanceProfit: 3_750_000,
      contingencies: 8_000_000,
      dayworks: 5_000_000,
    });
    expect(result.counts).toMatchObject({
      "lump-sum": 4,
      "percentage-line": 2,
      "included-item": 1,
    });
  });

  it("treats a first bill of lump sums as preliminaries", () => {
    const result = build([
      bill(
        [
          ["A", "Site establishment", "Item", null, null, 650_000],
          ["B", "Insurances", "Item", null, null, 380_000],
          ["C", "Supervision", "Month", 14, 95_000, 1_330_000],
        ],
        "1",
        "GENERAL",
      ),
    ]);
    expect(result.bills[0]!.kind).toBe("preliminaries");
    expect(result.totals.byKind.preliminaries).toBe(236_000_000);
  });
});

describe("validation report", () => {
  it("flags the row-23 typo (947,400 written for 58 × 16,800) and resolves it per row", () => {
    const rows: Value[][] = [
      ["C", "Reinforced concrete class 25 in ground beams", "m3", 58, 16_800, 947_400],
    ];
    const first = build([bill(rows)]);
    expect(first.issues).toEqual([
      expect.objectContaining({
        code: "amount-mismatch",
        severity: "error",
        row: 2,
        column: "F",
        ref: "C",
        values: { sheet: "947400.00", computed: "974400.00" },
        actions: ["computed", "sheet", "exclude"],
        resolution: null,
      }),
      expect.objectContaining({ code: "no-summary" }),
      expect.objectContaining({ code: "contract-sum-unset" }),
    ]);
    expect(first.readiness).toEqual({ blocking: 1, unacceptedWarnings: [], canCommit: false });
    expect(first.bills[0]!.totalMinor).toBe(97_440_000);

    const computed = build([bill(rows)], {
      resolutions: { rows: [{ sheetIndex: 0, row: 2, action: "computed" }], accepted: [] },
    });
    expect(computed.readiness.canCommit).toBe(true);
    expect(computed.bills[0]!.totalMinor).toBe(97_440_000);

    const sheet = build([bill(rows)], {
      resolutions: {
        rows: [{ sheetIndex: 0, row: 2, action: "sheet", reason: "QS confirmed" }],
        accepted: [],
      },
    });
    expect(sheet.bills[0]!.sections[0]!.items[0]).toMatchObject({
      amountSource: "sheet_override",
      amountMinor: 94_740_000,
      overrideReason: "QS confirmed",
    });

    const excluded = build([bill(rows)], {
      resolutions: { rows: [{ sheetIndex: 0, row: 2, action: "exclude" }], accepted: [] },
    });
    expect(excluded.bills[0]!.itemCount).toBe(0);
    expect(excluded.issues.map((issue) => issue.code)).toContain("no-items");
  });

  it("treats differences up to KES 1.00 as rounding", () => {
    const result = build([bill([["A", "Rounded", "m2", 12.5, 333.33, 4_167]])]);
    expect(result.bills[0]!.totalMinor).toBe(416_663);
    expect(codes(result)).toEqual([]);
  });

  it("reports duplicate references within a section and page, but not across pages", () => {
    const result = build([
      bill([
        ["A", "One", "m", 1, 10, 10],
        ["A", "Two", "m", 1, 10, 10],
        [null, "Carried to Collection", null, null, null, 20],
        ["A", "Three (next page)", "m", 1, 10, 10],
      ]),
    ]);
    expect(codes(result)).toEqual([["duplicate-ref", 3]]);
    const resolved = build(
      [
        bill([
          ["A", "One", "m", 1, 10, 10],
          ["A", "Two", "m", 1, 10, 10],
        ]),
      ],
      {
        resolutions: { rows: [{ sheetIndex: 0, row: 3, action: "exclude" }], accepted: [] },
      },
    );
    expect(resolved.readiness.blocking).toBe(0);
  });

  it("flags missing units, half-priced lines, negative and non-numeric values and formulas", () => {
    const result = build([
      bill([
        ["A", "No unit", null, 10, 5, 50],
        ["B", "Quantity only", "m", 10, null, null],
        ["C", "Rate only", "m", null, 25, null],
        ["D", "Negative", "m", -3, 10, -30],
        ["E", "Text in rate", "m", 2, "about 40", null],
        ["F", "Formula amount", "m", 2, 10, { f: "D7*E7", v: 20 }],
        ["G", "Formula without value", "m", 2, 10, { f: "D8*E8" }],
        ["H", "Described only"],
        [null, null, null, null, null, null],
        ["J", "Priced at", "m", 1.234_56, 10, 12.35],
      ]),
    ]);
    expect(codes(result)).toEqual([
      ["missing-unit", 2],
      ["quantity-without-rate", 3],
      ["rate-without-quantity", 4],
      ["negative-quantity", 5],
      ["non-numeric", 6],
      ["formula-cell", 7],
      ["formula-without-value", 8],
      ["formula-cell", 8],
      ["unpriced-item", 9],
      ["precision-rounded", 11],
    ]);
    expect(result.readiness).toMatchObject({
      blocking: 3,
      unacceptedWarnings: [
        "formula-cell",
        "missing-unit",
        "precision-rounded",
        "quantity-without-rate",
        "rate-without-quantity",
        "unpriced-item",
      ],
    });
    const priced = result.bills[0]!.sections[0]!.items;
    expect(priced.find((item) => item.ref === "F")).toMatchObject({
      hasFormula: true,
      amountMinor: 2_000,
    });
    expect(priced.find((item) => item.ref === "J")).toMatchObject({
      quantity: "1.2346",
      amountMinor: 1_235,
    });
    expect(priced.find((item) => item.ref === "B")).toMatchObject({
      amountSource: "unpriced",
      amountMinor: 0,
    });
  });

  it("reconciles page, brought-forward, collection and bill totals", () => {
    const result = build([
      bill([
        ["A", "One", "m", 1, 100, 100],
        [null, "Carried forward", null, null, null, 100],
        [null, "Brought forward", null, null, null, 90],
        ["B", "Two", "m", 1, 50, 50],
        [null, "Carried to Collection", null, null, null, 55],
        [null, "COLLECTION"],
        [null, "Page 1", null, null, null, 100],
        [null, "Page 2", null, null, null, 40],
        [null, "Total carried to Summary", null, null, null, 152],
      ]),
    ]);
    expect(codes(result)).toEqual([
      ["brought-forward-mismatch", 4],
      ["page-total-mismatch", 6],
      ["bill-total-mismatch", 10],
      ["collection-total-mismatch", 9],
    ]);
    // Cumulative carried-forward values are accepted too.
    const cumulative = build([
      bill([
        ["A", "One", "m", 1, 100, 100],
        [null, "Carried forward", null, null, null, 100],
        [null, "Brought forward", null, null, null, 100],
        ["B", "Two", "m", 1, 50, 50],
        [null, "Carried forward", null, null, null, 150],
      ]),
    ]);
    expect(codes(cumulative)).toEqual([]);
  });

  it("reconciles the grand summary, recomputes VAT and compares the contract sum", () => {
    const billTwo = bill([["A", "Work", "m3", 10, 1_000, 10_000]]);
    const billThree = { ...bill([["A", "More", "m2", 5, 2_000, 10_000]], "3", "SUPERSTRUCTURE") };
    const summary = {
      sheet: sheetOf("GRAND SUMMARY", [
        ["ITEM", "DESCRIPTION", "AMOUNT"],
        [2, "BILL NO. 2 – SUBSTRUCTURE", 10_000],
        [3, "BILL NO. 3 – SUPERSTRUCTURE", 10_500],
        [4, "BILL NO. 4 – EXTERNAL WORKS", 1_000],
        [null, "Contingencies", 2_000],
        [null, "SUB-TOTAL", 21_500],
        [null, "ADD VAT AT 16%", 3_500],
        [null, "GRAND TOTAL", 25_000],
      ]),
      mapping: {
        sheetIndex: 2,
        include: true,
        role: "summary",
        billNumber: "",
        billTitle: "GRAND SUMMARY",
        headerRow: 1,
        firstDataRow: 2,
        lastDataRow: 8,
        columns: { ref: 0, description: 1, amount: 2 },
      } satisfies BqSheetMapping,
    };
    const result = build([billTwo, billThree, summary], { contractSumMinor: 2_000_000 });
    expect(result.totals).toMatchObject({
      subtotalMinor: 2_000_000,
      vatMinor: 320_000,
      grandTotalMinor: 2_320_000,
      sheet: { subtotalMinor: 2_150_000, vatMinor: 350_000, grandTotalMinor: 2_500_000 },
    });
    expect(result.issues.map((issue) => [issue.code, issue.row, issue.values])).toEqual([
      ["summary-bill-mismatch", 3, { sheet: "10500.00", computed: "10000.00" }],
      ["summary-bill-missing", 4, { sheet: "1000.00" }],
      ["summary-unmatched-line", 5, { sheet: "2000.00", text: "Contingencies" }],
      ["subtotal-mismatch", 6, { sheet: "21500.00", computed: "20000.00" }],
      ["vat-mismatch", 7, { sheet: "3500.00", computed: "3200.00", rate: "16", sheetRate: "16" }],
      ["grand-total-mismatch", 8, { sheet: "25000.00", computed: "23200.00" }],
      ["contract-sum-mismatch", null, { contractSum: "20000.00", computed: "23200.00" }],
    ]);
    expect(result.readiness.unacceptedWarnings).toHaveLength(7);
    const accepted = build([billTwo, billThree, summary], {
      contractSumMinor: 2_000_000,
      resolutions: {
        rows: [],
        accepted: result.readiness.unacceptedWarnings.map((code) => ({ code, reason: "Checked" })),
      },
    });
    expect(accepted.readiness).toEqual({ blocking: 0, unacceptedWarnings: [], canCommit: true });
  });

  it("refuses duplicate bill numbers and an import without bills", () => {
    const one = bill([["A", "Work", "m", 1, 1, 1]], "2");
    const two = bill([["A", "Work", "m", 1, 1, 1]], "2");
    const result = build([one, two]);
    expect(result.issues.map((issue) => issue.code)).toContain("duplicate-bill-number");
    expect(result.readiness.canCommit).toBe(false);
    const none = buildBqImport(
      { fileType: "xlsx", sheets: [] },
      { sheets: [], templateId: null },
      {
        vatRatePercent: "16",
        contractSumMinor: null,
      },
    );
    expect(none.issues.map((issue) => issue.code)).toContain("no-bills");
    expect(none.readiness.canCommit).toBe(false);
  });

  it("rounds VAT once on the subtotal, half-up to the cent", () => {
    expect(vatMinor(3_331_654_203, "16")).toBe(533_064_672);
    expect(vatMinor(3_125, "16")).toBe(500);
    expect(vatMinor(1_003_125, "16")).toBe(160_500);
    expect(vatMinor(100, "0")).toBe(0);
  });

  it("caps the stored issues per code but keeps complete counts", () => {
    const rows: Value[][] = Array.from({ length: 30 }, (_, index) => [
      String(index + 1),
      `Line ${index + 1}`,
      null,
      1,
      1,
      { f: `D${index + 2}*E${index + 2}`, v: 1 },
    ]);
    const grid: WorkbookGrid = { fileType: "xlsx", sheets: [bill(rows).sheet] };
    const result = buildBqImport(
      grid,
      { sheets: [bill(rows).mapping], templateId: null },
      {
        vatRatePercent: "16",
        contractSumMinor: null,
        maxIssuesPerCode: 5,
      },
    );
    expect(result.counts).toMatchObject({ "formula-cell": 30, "missing-unit": 30 });
    expect(result.issues.filter((issue) => issue.code === "formula-cell")).toHaveLength(5);
  });

  it("accepts row resolutions only where a finding offers them", () => {
    const result = build([
      bill([
        ["C", "Typo", "m3", 58, 16_800, 947_400],
        ["D", "Fine", "m", 1, 1, 1],
      ]),
    ]);
    expect(invalidResolutions(result, [{ sheetIndex: 0, row: 2, action: "computed" }])).toEqual([]);
    expect(invalidResolutions(result, [{ sheetIndex: 0, row: 2, action: "sheet" }])).toHaveLength(
      1,
    );
    expect(
      invalidResolutions(result, [{ sheetIndex: 0, row: 2, action: "sheet", reason: "QS letter" }]),
    ).toEqual([]);
    expect(invalidResolutions(result, [{ sheetIndex: 0, row: 3, action: "exclude" }])).toHaveLength(
      1,
    );
  });
});

describe("edge cases", () => {
  it("reconciles VAT and grand-total rows at the foot of a single-sheet BQ", () => {
    const result = build([
      bill([
        ["A", "Work", "m2", 10, 1_000, 10_000],
        [null, "TOTAL", null, null, null, 10_000],
        [null, "ADD VAT 16%", null, null, null, 1_700],
        [null, "GRAND TOTAL", null, null, null, 11_700],
      ]),
    ]);
    expect(result.totals.sheet).toEqual({
      subtotalMinor: null,
      vatMinor: 170_000,
      grandTotalMinor: 1_170_000,
    });
    expect(codes(result)).toEqual([
      ["vat-mismatch", 4],
      ["grand-total-mismatch", 5],
    ]);
    expect(result.issues.map((issue) => issue.code)).not.toContain("no-summary");
  });

  it("reads summary amounts from the right-most number when no amount column is mapped", () => {
    const summary = {
      sheet: sheetOf("Summary", [
        ["Bill No. 2", null, "10,000.00"],
        ["Grand total", 11_600],
      ]),
      mapping: {
        sheetIndex: 1,
        include: true,
        role: "summary",
        billNumber: "",
        billTitle: "Summary",
        headerRow: 1,
        firstDataRow: 1,
        lastDataRow: 2,
        columns: {},
      } satisfies BqSheetMapping,
    };
    const result = build([bill([["A", "Work", "m2", 10, 1_000, 10_000]]), summary]);
    expect(
      result.summaryLines.map((line) => [line.kind, line.billNumber, line.amountMinor]),
    ).toEqual([
      ["bill", "2", 1_000_000],
      ["grand", null, 1_160_000],
    ]);
    expect(codes(result)).toEqual([]);
  });

  it("handles percentage lines without a PC sum, unpriced references and out-of-range values", () => {
    const result = build([
      bill([
        ["A", "Add for profit", "%", 5, null, 2_500],
        ["B", "Add for attendance", "%", 2.5, null, null],
        ["C", "Huge", "m", 999_999_999_999, 999_999_999_999, null],
        ["D", "A clause with a reference but no price"],
      ]),
    ]);
    const items = result.bills[0]!.sections[0]!.items;
    expect(items.map((item) => [item.ref, item.amountSource, item.amountMinor])).toEqual([
      ["A", "lump_sum", 250_000],
      ["B", "unpriced", 0],
      ["C", "unpriced", 0],
      ["D", "unpriced", 0],
    ]);
    expect(codes(result)).toEqual([
      ["unpriced-item", 3],
      ["non-numeric", 4],
      ["unpriced-item", 5],
    ]);
  });

  it("reports removed control characters and truncated descriptions", () => {
    const result = build([bill([["A", `Long\u0007 ${"x".repeat(4_100)}`, "m", 1, 1, 1]])]);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["control-characters-removed", "text-truncated"]),
    );
    expect(result.bills[0]!.sections[0]!.items[0]!.description.length).toBeLessThanOrEqual(4_000);
  });
});

describe("sheet analysis, proposals and templates", () => {
  const titleRows: Value[][] = [
    [null, "PROJECT"],
    [null, "BILL NO. 3"],
    [null, "SUPERSTRUCTURE"],
    [],
  ];
  const billSheet = sheetOf("Bill 3", [
    ...titleRows,
    HEADER,
    [null, null, null, null, "KShs", "KShs"],
    ["A", "Columns", "m3", 10, 100, 1_000],
    ["B", "Slabs", "m3", 10, 100, 1_000],
    ["C", "Beams", "m3", 10, 100, 1_000],
  ]);
  const summarySheet = sheetOf("Summary", [
    [null, "GRAND SUMMARY"],
    ["ITEM", "DESCRIPTION", "AMOUNT"],
    [1, "BILL NO. 1", 5],
    [3, "BILL NO. 3", 3_000],
    [null, "VAT 16%", 480],
    [null, "GRAND TOTAL", 3_485],
  ]);
  const notes = sheetOf("Notes", [["These bills are to be read with the drawings."]]);
  const grid: WorkbookGrid = { fileType: "xlsx", sheets: [billSheet, summarySheet, notes] };

  it("scores bills, summaries and other sheets and finds the bill number, title and rows", () => {
    const analyses = grid.sheets.map((sheet, index) => analyseSheet(sheet, index));
    expect(analyses.map((analysis) => analysis.kind)).toEqual(["bill", "summary", "other"]);
    expect(analyses[0]).toMatchObject({
      bill: { number: "3", title: "SUPERSTRUCTURE" },
      header: { row: 5 },
      firstDataRow: 7,
      lastDataRow: 9,
      itemRows: 3,
    });
    const { mapping } = proposeMapping(grid, analyses);
    expect(mapping.sheets.map((sheet) => [sheet.include, sheet.role, sheet.billNumber])).toEqual([
      [true, "bill", "3"],
      [true, "summary", ""],
      [false, "bill", ""],
    ]);
  });

  it("numbers bills without a number in order and applies matching templates", () => {
    const unnumbered = sheetOf("Works", [
      ["Description", "Qty", "Unit", "Rate", "Amount"],
      ["Walling", 10, "m2", 100, 1_000],
      ["Plaster", 10, "m2", 100, 1_000],
      ["Paint", 10, "m2", 100, 1_000],
    ]);
    const shifted = sheetOf("Shifted", [
      [],
      [null, "Description", "Qty", "Unit", "Rate", "Amount"],
      [null, "Walling", 10, "m2", 100, 1_000],
    ]);
    const twoBills: WorkbookGrid = { fileType: "xlsx", sheets: [unnumbered, shifted] };
    const analyses = twoBills.sheets.map((sheet, index) => analyseSheet(sheet, index));
    const plain = proposeMapping(twoBills, analyses).mapping;
    expect(plain.sheets[0]!.billNumber).toBe("1");

    const body = templateFromMapping(unnumbered, plain.sheets[0]!);
    expect(body).toEqual({
      columns: { description: 0, quantity: 1, unit: 2, rate: 3, amount: 4 },
      dataOffset: 1,
    });
    const template = { id: "t1", signature: "description|qty|unit|rate|amount", ...body };
    expect(templateColumns(shifted, template)).toEqual({
      headerRow: 2,
      firstDataRow: 3,
      columns: { description: 1, quantity: 2, unit: 3, rate: 4, amount: 5 },
    });
    const withTemplate = proposeMapping(twoBills, analyses, [template]);
    expect(withTemplate.templateMatches).toEqual({ 0: "t1", 1: "t1" });
    expect(withTemplate.mapping.templateId).toBe("t1");
    expect(templateColumns(notes, template)).toBeNull();
  });
});

describe("import lifecycle", () => {
  it("allows only the documented transitions", () => {
    expect(canTransitionImport("uploaded", "parsed")).toBe(true);
    expect(canTransitionImport("parsed", "validated")).toBe(false);
    expect(canTransitionImport("validated", "mapped")).toBe(true);
    expect(canTransitionImport("validated", "committed")).toBe(true);
    expect(canTransitionImport("committed", "abandoned")).toBe(false);
    expect(canTransitionImport("committed", "superseded")).toBe(true);
    for (const terminal of ["failed", "abandoned", "superseded"] as const)
      expect(BQ_IMPORT_TRANSITIONS[terminal]).toEqual([]);
    expect(isImportResumable("validated")).toBe(true);
    expect(isImportResumable("committed")).toBe(false);
  });
});
