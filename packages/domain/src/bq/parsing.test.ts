import { describe, expect, it } from "vitest";
import {
  analyseSheet,
  billKind,
  cellText,
  contentDisposition,
  decimalFromNumber,
  detectHeader,
  editDistance,
  isFormulaLike,
  isUpperCaseHeading,
  itemKind,
  matchHeaderField,
  normaliseBillNumber,
  normaliseUnit,
  parseBillHeading,
  readNumeric,
  rowMarker,
  sanitiseCellText,
  sanitiseFileName,
  spreadsheetSafeText,
  templateColumns,
  templateFromMapping,
  headerSignature,
  type GridSheet,
} from "../index.js";

const sheet = (rows: (string | number | null)[][], name = "Sheet1"): GridSheet => ({
  name,
  hidden: false,
  rows: rows.map((row) =>
    row.map((value) =>
      value === null
        ? null
        : typeof value === "number"
          ? { t: "n", v: value }
          : { t: "s", v: value },
    ),
  ),
});

describe("untrusted text", () => {
  it("removes control, zero-width and bidirectional characters and counts them", () => {
    const result = sanitiseCellText("Con\u0000crete\u202E class\u200B 25\u0007");
    expect(result).toEqual({ text: "Concrete class 25", removed: 4, truncated: false });
  });

  it("normalises line endings, tabs and spaces and keeps line breaks", () => {
    expect(sanitiseCellText("  Excavate\r\n  for bases\t\tdeep \r\r\r\rend").text).toBe(
      "Excavate\nfor bases deep\n\nend",
    );
  });

  it("truncates long text to the limit", () => {
    const result = sanitiseCellText("x".repeat(5_000), 4_000);
    expect(result.text).toHaveLength(4_000);
    expect(result.truncated).toBe(true);
  });

  it("neutralises formula-like export text with a leading apostrophe", () => {
    for (const text of ["=SUM(A1:A3)", "+254712345678", "-ditto", "@cmd", "\tx", "\rx"]) {
      expect(isFormulaLike(text)).toBe(true);
      expect(spreadsheetSafeText(text)).toBe(`'${text}`);
    }
    expect(spreadsheetSafeText("Excavate = 150 mm")).toBe("Excavate = 150 mm");
    expect(spreadsheetSafeText("")).toBe("");
  });

  it("makes display-only file names from user input", () => {
    expect(sanitiseFileName("../../etc/passwd.xlsx")).toBe("passwd.xlsx");
    expect(sanitiseFileName("C:\\Users\\QS\\Ruiru BQ (final) v2.xlsx")).toBe(
      "Ruiru BQ (final) v2.xlsx",
    );
    expect(sanitiseFileName("bq<script>.xlsx")).toBe("bq_script_.xlsx");
    expect(sanitiseFileName("\u202Exslx.exe")).toBe("xslx.exe");
    expect(sanitiseFileName("...")).toBe("upload");
    const long = sanitiseFileName(`${"a".repeat(300)}.xlsx`);
    expect(long).toHaveLength(120);
    expect(long.endsWith(".xlsx")).toBe(true);
  });

  it("builds safe Content-Disposition headers", () => {
    expect(contentDisposition('RUI "BQ".xlsx')).toBe(
      "attachment; filename=\"RUI _BQ_.xlsx\"; filename*=UTF-8''RUI%20_BQ_.xlsx",
    );
    expect(contentDisposition("Mradi wa Ruiru – BQ.pdf")).toContain(
      "filename*=UTF-8''Mradi%20wa%20Ruiru",
    );
  });
});

describe("numbers in cells", () => {
  it("keeps 15 significant digits and never exposes floating-point noise", () => {
    expect(decimalFromNumber(0.1 + 0.2)).toBe("0.3");
    expect(decimalFromNumber(974_400)).toBe("974400");
    expect(decimalFromNumber(1e-7)).toBe("0.0000001");
    expect(() => decimalFromNumber(Number.NaN)).toThrow(RangeError);
  });

  it("reads numbers, rounding beyond four decimals half-up and reporting it", () => {
    expect(readNumeric({ t: "n", v: 145.5 })).toEqual({
      kind: "number",
      value: "145.5",
      rounded: false,
    });
    expect(readNumeric({ t: "n", v: 1.234_56 })).toEqual({
      kind: "number",
      value: "1.2346",
      rounded: true,
    });
    expect(readNumeric({ t: "n", v: 0 })).toEqual({ kind: "number", value: "0", rounded: false });
  });

  it("reads numbers written as text in Kenyan formats", () => {
    expect(readNumeric({ t: "s", v: "1,234,500.50" })).toMatchObject({ value: "1234500.5" });
    expect(readNumeric({ t: "s", v: "KShs 1,250/=" })).toMatchObject({ value: "1250" });
    expect(readNumeric({ t: "s", v: "(500.00)" })).toMatchObject({ value: "-500" });
    expect(readNumeric({ t: "s", v: ".5" })).toMatchObject({ value: "0.5" });
    expect(readNumeric({ t: "s", v: "Kes 3 000" })).toMatchObject({ value: "3000" });
  });

  it("recognises blank, included and rate-only tokens and refuses everything else", () => {
    for (const text of ["", " ", "-", "—", "Nil", "N/A"])
      expect(readNumeric({ t: "s", v: text })).toEqual({ kind: "blank" });
    for (const text of ["Incl.", "Included", "incl"])
      expect(readNumeric({ t: "s", v: text })).toEqual({ kind: "token", token: "included" });
    expect(readNumeric({ t: "s", v: "Rate only" })).toEqual({ kind: "token", token: "rate_only" });
    expect(readNumeric({ t: "s", v: "12,5,0" })).toEqual({ kind: "invalid", raw: "12,5,0" });
    expect(readNumeric({ t: "s", v: "about 40" }).kind).toBe("invalid");
    expect(readNumeric({ t: "e", v: "#REF!" })).toEqual({ kind: "invalid", raw: "#REF!" });
    expect(readNumeric({ t: "b", v: true }).kind).toBe("invalid");
    expect(readNumeric({ t: "n", v: 1e15 }).kind).toBe("invalid");
    expect(readNumeric(null)).toEqual({ kind: "blank" });
  });

  it("shows references stored as numbers as written", () => {
    expect(cellText({ t: "n", v: 2.1 })).toBe("2.1");
    expect(cellText({ t: "s", v: " A " })).toBe("A");
    expect(cellText({ t: "f" })).toBe("");
  });
});

describe("unit normalisation", () => {
  it.each([
    ["m³", "m3"],
    ["M3", "m3"],
    ["Cu.m", "m3"],
    ["cum", "m3"],
    ["m^3", "m3"],
    ["m²", "m2"],
    ["Sq.M", "m2"],
    ["sqm", "m2"],
    ["Lm", "m"],
    ["m", "m"],
    ["Kgs", "kg"],
    ["Tonnes", "t"],
    ["No.", "nr"],
    ["Nr", "nr"],
    ["Pcs", "nr"],
    ["Item", "item"],
    ["LS", "ls"],
    ["L.S.", "ls"],
    ["Sum", "ls"],
    ["%", "pct"],
    ["Month", "month"],
  ])("%s → %s", (raw, code) => {
    expect(normaliseUnit(raw)?.code).toBe(code);
  });

  it("keeps unknown units as written and ignores blanks", () => {
    expect(normaliseUnit("Bags")).toEqual({ code: "other", label: "Bags", raw: "Bags" });
    expect(normaliseUnit("  ")).toBeNull();
    expect(normaliseUnit(null)).toBeNull();
    expect(normaliseUnit("m3")?.label).toBe("m³");
  });
});

describe("header detection", () => {
  it("finds the classic ITEM/DESCRIPTION/UNIT/QTY/RATE/AMOUNT header", () => {
    const found = detectHeader(
      sheet([
        [null, "RUIRU HEIGHTS"],
        [null, "BILL NO. 2"],
        ["ITEM", "DESCRIPTION", "UNIT", "QTY", "RATE", "AMOUNT"],
        [null, null, null, null, "KShs", "KShs"],
      ]),
    );
    expect(found).toMatchObject({
      row: 3,
      confidence: 1,
      columns: { ref: 0, description: 1, unit: 2, quantity: 3, rate: 4, amount: 5 },
      signature: "item|description|unit|qty|rate|amount",
    });
  });

  it("tolerates other names, orders, misspellings and Kiswahili titles", () => {
    expect(
      detectHeader(
        sheet([["Description of Works", "Qty", "Unit", "Unit Rate (KES)", "Total (KES)", "Ref."]]),
      )?.columns,
    ).toEqual({ description: 0, quantity: 1, unit: 2, rate: 3, amount: 4, ref: 5 });
    expect(
      detectHeader(sheet([["No.", "Discription", "Units", "Quantitiy", "Rates", "Ammount"]]))
        ?.columns,
    ).toEqual({ ref: 0, description: 1, unit: 2, quantity: 3, rate: 4, amount: 5 });
    expect(
      detectHeader(sheet([["Namba", "Maelezo", "Kipimo", "Idadi", "Bei", "Jumla"]]))?.columns,
    ).toEqual({
      ref: 0,
      description: 1,
      unit: 2,
      quantity: 3,
      rate: 4,
      amount: 5,
    });
  });

  it("uses currency-only columns (KShs) as rate and amount", () => {
    const found = detectHeader(
      sheet([
        ["ITEM", "DESCRIPTION", "UNIT", "QTY", "KSHS", "KSHS"],
        [null, null, null, null, null, null],
      ]),
    );
    expect(found?.columns).toMatchObject({ rate: 4, amount: 5 });
  });

  it("returns null when nothing looks like a BQ header", () => {
    expect(detectHeader(sheet([["Notes"], ["The contractor shall allow for…"]]))).toBeNull();
    expect(detectHeader(sheet([["Description", "Comments"]]))).toBeNull();
  });

  it("matches tolerant spellings with bounded edit distance", () => {
    expect(editDistance("description", "discription")).toBe(1);
    expect(editDistance("quantity", "quantitiy")).toBe(1);
    expect(editDistance("rate", "date", 2)).toBe(1);
    expect(matchHeaderField("Date")).toBeNull();
    expect(matchHeaderField("Amount (KShs)")).toEqual({ field: "amount", score: 1 });
    expect(matchHeaderField("Rate per unit")).toEqual({ field: "rate", score: 0.85 });
    expect(matchHeaderField("KShs")).toEqual({ field: "currency", score: 0.5 });
  });
});

describe("classification", () => {
  it("classifies bills by title, and Bill 1 of lump sums as preliminaries", () => {
    expect(billKind("PRELIMINARIES AND GENERAL ITEMS", "1")).toBe("preliminaries");
    expect(billKind("PC AND PROVISIONAL SUMS", "9")).toBe("provisional");
    expect(billKind("Prime Cost Sums", "8")).toBe("provisional");
    expect(billKind("DAYWORKS", "10")).toBe("dayworks");
    expect(billKind("Contingencies", "11")).toBe("contingency");
    expect(billKind("SUBSTRUCTURE", "2")).toBe("measured");
    expect(billKind("GENERAL", "1", 0.8)).toBe("preliminaries");
    expect(billKind("GENERAL", "1", 0.2)).toBe("measured");
  });

  it("classifies special lines, with PC attendance and profit after a PC sum", () => {
    const context = { billKind: "measured" as const, unit: null, afterPcSum: false };
    expect(itemKind("Provide the PC sum of KShs 500,000 for sanitary fittings", context)).toBe(
      "pc_sum",
    );
    expect(itemKind("Prime cost sum for ironmongery", context)).toBe("pc_sum");
    expect(itemKind("Add for profit", { ...context, unit: "pct", afterPcSum: true })).toBe(
      "pc_profit",
    );
    expect(itemKind("Add for attendance", { ...context, afterPcSum: true })).toBe("pc_attendance");
    expect(itemKind("Add for profit", context)).toBe("measured");
    expect(itemKind("Provide the provisional sum of KShs 350,000", context)).toBe(
      "provisional_sum",
    );
    expect(itemKind("Allow for contingencies", context)).toBe("contingency");
    expect(itemKind("Dayworks: labour", context)).toBe("daywork");
    expect(itemKind("Site huts", { ...context, billKind: "preliminaries" })).toBe("preliminary");
  });

  it("recognises carried/brought forward, page, collection, bill and summary rows", () => {
    expect(rowMarker("Carried to Collection")).toBe("page_total");
    expect(rowMarker("C/F")).toBe("page_total");
    expect(rowMarker("Carried forward")).toBe("page_total");
    expect(rowMarker("Brought forward")).toBe("brought_forward");
    expect(rowMarker("B/F")).toBe("brought_forward");
    expect(rowMarker("COLLECTION")).toBe("collection");
    expect(rowMarker("Total for Bill No. 2 carried to Summary")).toBe("bill_total");
    expect(rowMarker("TOTAL CARRIED TO SUMMARY")).toBe("bill_total");
    expect(rowMarker("Add VAT at 16%")).toBe("vat");
    expect(rowMarker("GRAND TOTAL")).toBe("grand_total");
    expect(rowMarker("BILL NO. 3")).toBe("bill_heading");
    expect(rowMarker("Total")).toBe("page_total");
    expect(rowMarker("Excavate trenches")).toBeNull();
  });

  it("reads bill headings, including Roman numerals", () => {
    expect(parseBillHeading("BILL NO. 2 – SUBSTRUCTURE")).toEqual({
      number: "2",
      title: "SUBSTRUCTURE",
    });
    expect(parseBillHeading("Bill No IV: Finishes")).toEqual({ number: "4", title: "Finishes" });
    expect(parseBillHeading("BILL 1 - PRELIMS")).toEqual({ number: "1", title: "PRELIMS" });
    expect(parseBillHeading("Billing notes")).toBeNull();
    expect(normaliseBillNumber("XII")).toBe("12");
    expect(normaliseBillNumber("02")).toBe("2");
    expect(isUpperCaseHeading("CONCRETE WORK")).toBe(true);
    expect(isUpperCaseHeading("Concrete work")).toBe(false);
    expect(isUpperCaseHeading("A1")).toBe(false);
  });
});

describe("hostile layouts", () => {
  it("analyses runs of Unicode spaces in linear time (no regex backtracking)", () => {
    // 200 characters, the length kept per cell here: "bill", 195 Unicode spaces, "!".
    const spaces = "\u00a0".repeat(190) + "\u2003".repeat(5);
    const rows = Array.from({ length: 400 }, (_, row) => [
      ...Array.from({ length: 20 }, () => `bill${spaces}!`),
      row,
    ]);
    const started = Date.now();
    analyseSheet(sheet(rows, "Hostile"), 0);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("saves and re-applies a template whose reference column has no title", () => {
    const layout = sheet([
      [null, "Description", "Unit", "Qty", "Rate", "Amount"],
      ["A", "Excavate topsoil", "m2", 120, 85, 10_200],
    ]);
    const body = templateFromMapping(layout, {
      sheetIndex: 0,
      include: true,
      role: "bill",
      billNumber: "1",
      billTitle: "Substructure",
      headerRow: 1,
      firstDataRow: 2,
      lastDataRow: 2,
      columns: { ref: 0, description: 1, unit: 2, quantity: 3, rate: 4, amount: 5 },
    });
    expect(body.columns.ref).toBe(-1);
    const template = { id: "t", signature: headerSignature(layout, 1)!, ...body };
    expect(templateColumns(layout, template)?.columns).toEqual({
      ref: 0,
      description: 1,
      unit: 2,
      quantity: 3,
      rate: 4,
      amount: 5,
    });
    // A sheet whose titles start in column A has no room for the reference column.
    const shifted = sheet([["Description", "Unit", "Qty", "Rate", "Amount"]]);
    expect(templateColumns(shifted, template)).toBeNull();
  });
});
