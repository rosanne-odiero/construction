/**
 * Builds the synthetic BQ workbooks used by the D2.2 tests and demo (run from apps/api):
 *
 *   node test/fixtures/bq/generate.mts
 *
 * Every name, figure and project is invented. Expected totals are computed here with exact
 * integer arithmetic (independently of packages/domain) and printed, so the tests can assert them
 * to the cent. The committed files are the output of this script.
 */
import { writeFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import * as XLSX from "xlsx";

const here = new URL("./", import.meta.url);
const out = (name: string) => new URL(name, here);

// ---------------------------------------------------------------------------------------------
// Exact money: decimal strings → BigInt cents, half-up per line.
// ---------------------------------------------------------------------------------------------
function scaled(value: string): { digits: bigint; places: number } {
  const [whole, fraction = ""] = value.split(".");
  return { digits: BigInt(`${whole}${fraction}`), places: fraction.length };
}
function lineCents(quantity: string, rate: string): bigint {
  const q = scaled(quantity);
  const r = scaled(rate);
  const divisor = 10n ** BigInt(q.places + r.places);
  const numerator = q.digits * r.digits * 100n;
  return (numerator * 2n + divisor) / (2n * divisor);
}
const centsOf = (amount: string) => lineCents(amount, "1");
/** percent % of a base in cents, half-up to the cent. */
function percentCents(percent: string, base: bigint): bigint {
  const p = scaled(percent);
  const divisor = 10n ** BigInt(p.places) * 100n;
  return (p.digits * base * 2n + divisor) / (2n * divisor);
}
function kes(cents: bigint): number {
  return Number(cents) / 100;
}
function show(cents: bigint): string {
  const whole = cents / 100n;
  const fraction = (cents % 100n).toString().padStart(2, "0");
  return `${whole.toLocaleString("en-KE")}.${fraction}`;
}

type Cell = string | number | null | { f: string; v: number } | { s: string };
type Row = Cell[];
type Item = {
  ref: string;
  lines: string[];
  unit?: string;
  qty?: string;
  rate?: string;
  amount?: string;
  /** Write this instead of the computed amount (to plant a mistake). */
  sheetAmount?: string;
  percentOf?: bigint;
  note?: string;
};

/** Item rows in a 6-column layout (ITEM, DESCRIPTION, UNIT, QTY, RATE, AMOUNT). */
function itemRows(item: Item): { rows: Row[]; cents: bigint } {
  let cents: bigint;
  if (item.percentOf !== undefined && item.qty) cents = percentCents(item.qty, item.percentOf);
  else if (item.qty && item.rate) cents = lineCents(item.qty, item.rate);
  else cents = centsOf(item.amount ?? "0");
  const written = item.sheetAmount ? Number(item.sheetAmount) : kes(cents);
  const rows: Row[] = item.lines
    .slice(0, -1)
    .map((line, index) => [index === 0 ? item.ref : null, line]);
  rows.push([
    item.lines.length === 1 ? item.ref : null,
    item.lines.at(-1)!,
    item.unit ?? null,
    item.qty ? Number(item.qty) : null,
    item.rate ? Number(item.rate) : null,
    written,
  ]);
  return { rows, cents };
}

const TITLE = "RUIRU HEIGHTS APARTMENTS (SYNTHETIC) – PROPOSED 4-STOREY RESIDENTIAL BLOCK";
const HEADER: Row = ["ITEM", "DESCRIPTION", "UNIT", "QTY", "RATE", "AMOUNT"];
const CURRENCY: Row = [null, null, null, null, "KShs", "KShs"];

function sheetFrom(rows: Row[]): XLSX.WorkSheet {
  const aoa = rows.map((row) =>
    row.map((cell) => (cell !== null && typeof cell === "object" ? null : cell)),
  );
  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  rows.forEach((row, r) =>
    row.forEach((cell, c) => {
      const address = XLSX.utils.encode_cell({ r, c });
      if (cell !== null && typeof cell === "object" && "f" in cell)
        sheet[address] = { t: "n", v: cell.v, f: cell.f, z: "#,##0.00" };
      else if (cell !== null && typeof cell === "object" && "s" in cell)
        sheet[address] = { t: "s", v: cell.s };
      else if (typeof cell === "number" && c >= 3) sheet[address].z = "#,##0.00";
    }),
  );
  sheet["!cols"] = [{ wch: 6 }, { wch: 60 }, { wch: 8 }, { wch: 10 }, { wch: 12 }, { wch: 16 }];
  return sheet;
}

// ---------------------------------------------------------------------------------------------
// (a) A typical multi-bill Kenyan layout: Bill 1 Preliminaries, Bill 2 Substructure (two pages
//     and a collection), Bill 3 Superstructure (carried/brought forward), Bill 4 PC & provisional
//     sums, and a Grand Summary with VAT at 16 %.
// ---------------------------------------------------------------------------------------------
type Bill = { number: number; title: string; sheet: XLSX.WorkSheet; cents: bigint };

function billOne(): Bill {
  const items: Item[] = [
    {
      ref: "A",
      lines: ["Site establishment, hoarding and signboard"],
      unit: "Item",
      amount: "650000",
    },
    {
      ref: "B",
      lines: [
        "Site offices, stores and welfare facilities including",
        "maintenance and removal on completion",
      ],
      unit: "Item",
      amount: "480000",
    },
    { ref: "C", lines: ["Water and electricity for the works"], unit: "Item", amount: "420000" },
    {
      ref: "D",
      lines: ["Insurances: Contractor's All Risk and WIBA"],
      unit: "Item",
      amount: "380000",
    },
    {
      ref: "E",
      lines: ["Site supervision and management"],
      unit: "Month",
      qty: "14",
      rate: "95000",
    },
    { ref: "F", lines: ["Clear site and make good on completion"], unit: "Item", amount: "170000" },
  ];
  const rows: Row[] = [
    [null, TITLE],
    [null, "BILLS OF QUANTITIES"],
    [],
    [null, "BILL NO. 1"],
    [null, "PRELIMINARIES AND GENERAL ITEMS"],
    [],
    HEADER,
    CURRENCY,
    [],
    [null, "GENERAL ITEMS"],
  ];
  let total = 0n;
  for (const item of items) {
    const built = itemRows(item);
    rows.push(...built.rows, []);
    total += built.cents;
  }
  rows.push([null, "Total carried to Summary", null, null, null, kes(total)]);
  return { number: 1, title: "PRELIMINARIES", sheet: sheetFrom(rows), cents: total };
}

function billTwo(): Bill {
  const pageOne: Item[] = [
    {
      ref: "A",
      lines: ["Excavate oversite to remove vegetable soil average 150 mm deep"],
      unit: "m2",
      qty: "620",
      rate: "180",
    },
    {
      ref: "B",
      lines: ["Excavate for column bases not exceeding 1.5 m deep"],
      unit: "m3",
      qty: "310",
      rate: "650",
    },
    {
      ref: "C",
      lines: ["Excavate trenches for strip foundations"],
      unit: "Cu.m",
      qty: "145.5",
      rate: "650",
    },
    {
      ref: "D",
      lines: ["Return, fill and ram selected excavated material"],
      unit: "m³",
      qty: "180",
      rate: "350",
    },
    {
      ref: "E",
      lines: ["Hardcore filling 300 mm thick, well compacted"],
      unit: "Sq.m",
      qty: "540",
      rate: "1150",
    },
    {
      ref: "F",
      lines: ["Anti-termite treatment to surfaces of hardcore"],
      unit: "m2",
      qty: "540",
      rate: "160.5",
    },
  ];
  const pageTwo: Item[] = [
    { ref: "A", lines: ["Blinding 50 mm thick, class 15"], unit: "m2", qty: "610", rate: "620" },
    {
      ref: "B",
      lines: ["Reinforced concrete class 25 in column bases"],
      unit: "m3",
      qty: "96",
      rate: "16500",
    },
    {
      ref: "C",
      lines: ["Reinforced concrete class 25 in ground beams"],
      unit: "m3",
      qty: "58",
      rate: "16800",
    },
    {
      ref: "D",
      lines: ["Ground floor slab 150 mm thick, class 25"],
      unit: "m3",
      qty: "81.25",
      rate: "16200",
    },
    { ref: "E", lines: ["High-yield steel bars Y12"], unit: "kg", qty: "9800", rate: "165" },
    { ref: "F", lines: ["High-yield steel bars Y16"], unit: "t", qty: "7.4", rate: "162000" },
    // 1.5 × 4.75 = 7.125: half-up to the cent gives 7.13 (half-even would give 7.12).
    { ref: "G", lines: ["Galvanised binding wire"], unit: "kg", qty: "1.5", rate: "4.75" },
    {
      ref: "H",
      lines: ["BRC mesh A142 in ground slab, lapped 300 mm"],
      unit: "m2",
      qty: "540",
      rate: "520",
    },
    {
      ref: "J",
      lines: ["1000-gauge polythene damp-proof membrane"],
      unit: "m2",
      qty: "560",
      rate: "120",
    },
  ];
  const rows: Row[] = [
    [null, TITLE],
    [],
    [null, "BILL NO. 2"],
    [null, "SUBSTRUCTURE"],
    [],
    HEADER,
    CURRENCY,
    [],
    [null, "EXCAVATION AND EARTHWORKS"],
  ];
  const pages: bigint[] = [];
  let page = 0n;
  for (const item of pageOne) {
    const built = itemRows(item);
    rows.push(...built.rows);
    page += built.cents;
  }
  rows.push([], [null, "Carried to Collection", null, null, null, kes(page)], []);
  pages.push(page);
  page = 0n;
  rows.push([null, "CONCRETE WORK"]);
  pageTwo.forEach((item, index) => {
    if (index === 4) rows.push([null, "REINFORCEMENT"]);
    const built = itemRows(item);
    rows.push(...built.rows);
    page += built.cents;
  });
  rows.push([], [null, "Carried to Collection", null, null, null, kes(page)], []);
  pages.push(page);
  const total = pages.reduce((sum, value) => sum + value, 0n);
  rows.push(
    [null, "COLLECTION"],
    [null, "Page 2/1", null, null, null, kes(pages[0]!)],
    [null, "Page 2/2", null, null, null, kes(pages[1]!)],
    [],
    [null, "Total for Bill No. 2 carried to Summary", null, null, null, kes(total)],
  );
  return { number: 2, title: "SUBSTRUCTURE", sheet: sheetFrom(rows), cents: total };
}

function billThree(): Bill {
  const pageOne: Item[] = [
    {
      ref: "A",
      lines: ["Reinforced concrete class 25 in columns"],
      unit: "m3",
      qty: "142",
      rate: "17200",
    },
    {
      ref: "B",
      lines: [
        "Reinforced concrete class 25 in suspended slabs 150 mm thick,",
        "including all necessary propping",
      ],
      unit: "cum",
      qty: "386",
      rate: "16400",
    },
    {
      ref: "C",
      lines: ["Formwork to soffits of suspended slabs"],
      unit: "sqm",
      qty: "2480",
      rate: "820",
    },
    {
      ref: "D",
      lines: ["Precast concrete lintels 150 × 200 mm"],
      unit: "No.",
      qty: "64",
      rate: "2850",
    },
  ];
  const pageTwo: Item[] = [
    {
      ref: "A",
      lines: ["200 mm machine-cut natural stone walling in cement-sand mortar (1:4)"],
      unit: "m2",
      qty: "1860",
      rate: "2150",
    },
    // 12.345 × 1,234.50 = 15,239.9025 → 15,239.90
    {
      ref: "B",
      lines: ["Ditto, 150 mm thick partition walling"],
      unit: "M2",
      qty: "12.345",
      rate: "1234.5",
    },
    {
      ref: "C",
      lines: ["Hoop-iron reinforcement to alternate courses"],
      unit: "Lm",
      qty: "5200",
      rate: "45",
    },
    { ref: "D", lines: ["Steel casement windows, primed"], unit: "Nr", qty: "48", rate: "18500" },
  ];
  const rows: Row[] = [
    [null, TITLE],
    [],
    [null, "BILL NO. 3 – SUPERSTRUCTURE"],
    [],
    HEADER,
    CURRENCY,
    [],
    [null, "CONCRETE WORK"],
  ];
  let running = 0n;
  for (const item of pageOne) {
    const built = itemRows(item);
    rows.push(...built.rows);
    running += built.cents;
  }
  rows.push(
    [],
    [null, "Carried forward", null, null, null, kes(running)],
    [],
    [null, "Brought forward", null, null, null, kes(running)],
    [],
    [null, "WALLING AND OPENINGS"],
  );
  for (const item of pageTwo) {
    const built = itemRows(item);
    rows.push(...built.rows);
    running += built.cents;
  }
  rows.push([], [null, "Total carried to Summary", null, null, null, kes(running)]);
  return { number: 3, title: "SUPERSTRUCTURE", sheet: sheetFrom(rows), cents: running };
}

function billFour(): Bill {
  const kitchen = centsOf("1280000");
  const doors = centsOf("940000");
  const items: (Item | string)[] = [
    "PRIME COST SUMS",
    {
      ref: "A",
      lines: [
        "Provide the PC sum of KShs 1,280,000 for kitchen fittings (16 units) by a nominated supplier",
      ],
      unit: "Item",
      amount: "1280000",
    },
    { ref: "B", lines: ["Add for profit"], unit: "%", qty: "5", percentOf: kitchen },
    { ref: "C", lines: ["Add for attendance"], unit: "%", qty: "2.5", percentOf: kitchen },
    {
      ref: "D",
      lines: ["Provide the PC sum of KShs 940,000 for security doors and burglar-proofing"],
      unit: "Item",
      amount: "940000",
    },
    { ref: "E", lines: ["Add for profit"], unit: "%", qty: "5", percentOf: doors },
    { ref: "F", lines: ["Add for attendance"], unit: "%", qty: "2.5", percentOf: doors },
    "PROVISIONAL SUMS",
    {
      ref: "G",
      lines: ["Provide the provisional sum of KShs 350,000 for power connection"],
      unit: "Item",
      amount: "350000",
    },
    {
      ref: "H",
      lines: ["Provide the provisional sum of KShs 180,000 for water and sewer connection fees"],
      unit: "Item",
      amount: "180000",
    },
    "DAYWORKS",
    {
      ref: "J",
      lines: ["Provide the sum of KShs 250,000 for dayworks"],
      unit: "Sum",
      amount: "250000",
    },
    "CONTINGENCIES",
    {
      ref: "K",
      lines: ["Provide the sum of KShs 2,000,000 for contingencies"],
      unit: "Sum",
      amount: "2000000",
    },
  ];
  const rows: Row[] = [
    [null, TITLE],
    [],
    [null, "BILL NO. 4"],
    [null, "PC AND PROVISIONAL SUMS"],
    [],
    HEADER,
    CURRENCY,
    [],
  ];
  let total = 0n;
  for (const entry of items) {
    if (typeof entry === "string") {
      rows.push([null, entry]);
      continue;
    }
    const built = itemRows(entry);
    rows.push(...built.rows);
    total += built.cents;
  }
  rows.push([], [null, "Total carried to Summary", null, null, null, kes(total)]);
  return { number: 4, title: "PC AND PROVISIONAL SUMS", sheet: sheetFrom(rows), cents: total };
}

function grandSummary(bills: Bill[]) {
  const subtotal = bills.reduce((sum, bill) => sum + bill.cents, 0n);
  const vat = percentCents("16", subtotal);
  const rows: Row[] = [
    [null, TITLE],
    [],
    [null, "GRAND SUMMARY"],
    [],
    ["ITEM", "DESCRIPTION", null, null, null, "AMOUNT (KSHS)"],
    [],
    ...bills.map((bill): Row => [
      bill.number,
      `BILL NO. ${bill.number} – ${bill.title}`,
      null,
      null,
      null,
      kes(bill.cents),
    ]),
    [],
    [null, "SUB-TOTAL", null, null, null, kes(subtotal)],
    [null, "ADD VAT AT 16%", null, null, null, kes(vat)],
    [],
    [null, "GRAND TOTAL CARRIED TO FORM OF TENDER", null, null, null, kes(subtotal + vat)],
  ];
  return { sheet: sheetFrom(rows), subtotal, vat, grand: subtotal + vat };
}

function workbook(sheets: [string, XLSX.WorkSheet][]): XLSX.WorkBook {
  const book = XLSX.utils.book_new();
  for (const [name, sheet] of sheets) XLSX.utils.book_append_sheet(book, sheet, name);
  book.Props = {
    Title: "Synthetic BQ fixture",
    Author: "PM-Buddy test fixtures",
    CreatedDate: new Date("2026-11-10T08:00:00Z"),
  };
  return book;
}

const bills = [billOne(), billTwo(), billThree(), billFour()];
const summary = grandSummary(bills);
const bookA = workbook([
  ["BILL 1 - PRELIMS", bills[0]!.sheet],
  ["BILL 2 - SUBSTRUCTURE", bills[1]!.sheet],
  ["BILL 3 - SUPERSTRUCTURE", bills[2]!.sheet],
  ["BILL 4 - PC & PROV SUMS", bills[3]!.sheet],
  ["GRAND SUMMARY", summary.sheet],
]);
writeFileSync(
  out("kenyan-multi-bill.xlsx"),
  XLSX.write(bookA, { type: "buffer", bookType: "xlsx", compression: true }),
);
// (d) the same workbook as a legacy Excel 97–2003 (.xls, BIFF8) file.
writeFileSync(
  out("kenyan-multi-bill.xls"),
  XLSX.write(bookA, { type: "buffer", bookType: "biff8" }),
);

// ---------------------------------------------------------------------------------------------
// (b) One sheet, headings in capitals and in title case, a different column order and names,
//     unit spellings, a description and a remark that look like formulas, VAT and grand total
//     at the foot.
// ---------------------------------------------------------------------------------------------
type AltItem = {
  desc: string;
  qty: string;
  unit: string;
  rate: string;
  ref: string;
  remark?: string;
};
const altSections: [string, AltItem[]][] = [
  [
    "SITE CLEARANCE",
    [
      { desc: "Clear site of bushes and shrubs", qty: "1200", unit: "sqm", rate: "45", ref: "1.1" },
      {
        desc: "Excavate topsoil 150 mm deep and cart away",
        qty: "180",
        unit: "cum",
        rate: "520",
        ref: "1.2",
        remark: "Spoil to approved tip",
      },
    ],
  ],
  [
    "Foundations",
    [
      // 42.75 × 15,850.50 = 677,608.875 → 677,608.88 (half-up)
      {
        desc: "Concrete class 20 in strip footings",
        qty: "42.75",
        unit: "m³",
        rate: "15850.5",
        ref: "2.1",
      },
      {
        desc: "Natural stone foundation walling 200 mm thick",
        qty: "96",
        unit: "M2",
        rate: "2150",
        ref: "2.2",
      },
      {
        desc: "=2+3 risk allowance (synthetic formula-injection probe)",
        qty: "1",
        unit: "Item",
        rate: "10000",
        ref: "2.3",
        remark: "+check with the QS",
      },
    ],
  ],
  [
    "WALLING AND FINISHES",
    [
      {
        desc: "200 mm machine-cut stone walling",
        qty: "310.5",
        unit: "sq.m",
        rate: "2150",
        ref: "3.1",
      },
      { desc: "Internal plaster 15 mm thick", qty: "620", unit: "m2", rate: "520", ref: "3.2" },
      {
        desc: "Ceramic floor tiles 600 × 600 mm",
        qty: "145",
        unit: "Sq.M",
        rate: "2400",
        ref: "3.3",
      },
      { desc: "Hoop-iron reinforcement", qty: "1240", unit: "Lm", rate: "45", ref: "3.4" },
      { desc: "Steel casement windows", qty: "24", unit: "Nr", rate: "18500", ref: "3.5" },
    ],
  ],
];
{
  const rows: Row[] = [
    [{ s: "SYOKIMAU TOWNHOUSES (SYNTHETIC) – BILL OF QUANTITIES" }],
    [],
    ["Description of Works", "Qty", "Unit", "Unit Rate (KES)", "Total (KES)", "Ref.", "Remarks"],
  ];
  let total = 0n;
  for (const [heading, items] of altSections) {
    rows.push([heading]);
    for (const item of items) {
      const cents = lineCents(item.qty, item.rate);
      total += cents;
      rows.push([
        { s: item.desc },
        Number(item.qty),
        item.unit,
        Number(item.rate),
        kes(cents),
        item.ref,
        item.remark ? { s: item.remark } : null,
      ]);
    }
    rows.push([]);
  }
  const vat = percentCents("16", total);
  rows.push(
    ["TOTAL", null, null, null, kes(total)],
    ["ADD 16% VAT", null, null, null, kes(vat)],
    ["GRAND TOTAL", null, null, null, kes(total + vat)],
  );
  const sheet = sheetFrom(rows);
  sheet["!cols"] = [
    { wch: 55 },
    { wch: 10 },
    { wch: 8 },
    { wch: 14 },
    { wch: 16 },
    { wch: 6 },
    { wch: 24 },
  ];
  writeFileSync(
    out("single-sheet-alt-columns.xlsx"),
    XLSX.write(workbook([["BQ", sheet]]), { type: "buffer", bookType: "xlsx", compression: true }),
  );
  console.log(
    `(b) single sheet: subtotal ${show(total)}, VAT ${show(vat)}, grand total ${show(total + vat)} (${total + vat} cents)`,
  );
}

// ---------------------------------------------------------------------------------------------
// (c) A messy bill: duplicate references, missing units, a formula cell, the prototype's
//     row-23 typo (947,400 written for 58 × 16,800 = 974,400) and a wrong page total.
// ---------------------------------------------------------------------------------------------
{
  const rows: Row[] = [
    [null, "KITENGELA BUNGALOW (SYNTHETIC)"],
    [],
    [null, "BILL NO. 2 – SUBSTRUCTURE"],
    [],
    HEADER,
    [],
    [null, "EXCAVATION AND EARTHWORKS"],
    ["A", "Excavate oversite average 150 mm deep", "m2", 620, 180, 111600],
    ["B", "Excavate for column bases not exceeding 1.5 m deep", "m3", 310, 650, 201500],
    // Duplicate reference B on the same page and section.
    ["B", "Excavate trenches for strip foundations", "m3", 145, 650, 94250],
    // Missing unit.
    ["C", "Return, fill and ram selected excavated material", null, 180, 350, 63000],
    // A formula: the amount is =D12*E12 with its cached value.
    ["D", "Hardcore filling 300 mm thick", "m2", 540, 1150, { f: "D12*E12", v: 621000 }],
    [],
    [null, "CONCRETE WORK"],
    ["A", "Blinding 50 mm thick, class 15", "m2", 610, 620, 378200],
    ["B", "Reinforced concrete class 25 in column bases", "m3", 96, 16500, 1584000],
    [],
    [],
    [],
    [],
    [],
    [],
    // Excel row 23: the typo.
    ["C", "Reinforced concrete class 25 in ground beams", "m3", 58, 16800, 947400],
    [],
    // Wrong page total: the amounts as written add up to 4,000,950.00 and the computed sum is
    // 4,027,950.00, but the sheet carries 3,316,950.00.
    [null, "Carried to Collection", null, null, null, 3316950],
  ];
  writeFileSync(
    out("messy.xlsx"),
    XLSX.write(workbook([["BILL 2", sheetFrom(rows)]]), {
      type: "buffer",
      bookType: "xlsx",
      compression: true,
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// (e) Unsafe uploads: a zip bomb with an .xlsx name, and a PNG renamed .xlsx.
// ---------------------------------------------------------------------------------------------
function zip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const compressed = deflateRawSync(entry.data, { level: 9 });
    const name = Buffer.from(entry.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt32LE(0, 12);
    header.writeUInt32LE(0, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += 30 + name.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const types = Buffer.from(
  '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
);
writeFileSync(
  out("zip-bomb.xlsx"),
  zip([
    { name: "[Content_Types].xml", data: types },
    { name: "xl/workbook.xml", data: Buffer.from("<workbook/>") },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.alloc(150 * 1024 * 1024, 0x20) },
  ]),
);
writeFileSync(
  out("not-excel.xlsx"),
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    "base64",
  ),
);

for (const bill of bills)
  console.log(`(a) Bill ${bill.number} ${bill.title}: ${show(bill.cents)} (${bill.cents} cents)`);
console.log(
  `(a) subtotal ${show(summary.subtotal)}, VAT ${show(summary.vat)}, grand total ${show(summary.grand)} (${summary.grand} cents)`,
);
