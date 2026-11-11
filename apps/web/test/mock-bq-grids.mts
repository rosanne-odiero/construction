/**
 * Parsed-workbook grids for the Playwright mock API, mirroring the committed synthetic fixtures in
 * apps/api/test/fixtures/bq (the web app has no Excel parser; the real API reads the files).
 * Synthetic data only.
 */
import type { GridCell, GridSheet, WorkbookGrid } from "@pm-buddy/domain";

type Value = string | number | null | { f: string; v: number };
const cell = (value: Value): GridCell | null => {
  if (value === null) return null;
  if (typeof value === "number") return { t: "n", v: value };
  if (typeof value === "string") return { t: "s", v: value };
  return { t: "n", v: value.v, f: 1 };
};
const sheet = (name: string, rows: Value[][]): GridSheet => ({
  name,
  hidden: false,
  rows: rows.map((row) => row.map(cell)),
});

const TITLE = "RUIRU HEIGHTS APARTMENTS (SYNTHETIC) – PROPOSED 4-STOREY RESIDENTIAL BLOCK";
const HEADER: Value[] = ["ITEM", "DESCRIPTION", "UNIT", "QTY", "RATE", "AMOUNT"];
const CURRENCY: Value[] = [null, null, null, null, "KShs", "KShs"];
type Item = [
  ref: string,
  description: string,
  unit: string,
  qty: number | null,
  rate: number | null,
  amount: number,
];
const rowOf = ([ref, description, unit, qty, rate, amount]: Item): Value[] => [
  ref,
  description,
  unit,
  qty,
  rate,
  amount,
];

export function multiBillGrid(): WorkbookGrid {
  const billOne = sheet("BILL 1 - PRELIMS", [
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
    ...(
      [
        ["A", "Site establishment, hoarding and signboard", "Item", null, null, 650_000],
        ["B", "Site offices, stores and welfare facilities", "Item", null, null, 480_000],
        ["C", "Water and electricity for the works", "Item", null, null, 420_000],
        ["D", "Insurances: Contractor's All Risk and WIBA", "Item", null, null, 380_000],
        ["E", "Site supervision and management", "Month", 14, 95_000, 1_330_000],
        ["F", "Clear site and make good on completion", "Item", null, null, 170_000],
      ] as Item[]
    ).map(rowOf),
    [null, "Total carried to Summary", null, null, null, 3_430_000],
  ]);
  const pageOne: Item[] = [
    [
      "A",
      "Excavate oversite to remove vegetable soil average 150 mm deep",
      "m2",
      620,
      180,
      111_600,
    ],
    ["B", "Excavate for column bases not exceeding 1.5 m deep", "m3", 310, 650, 201_500],
    ["C", "Excavate trenches for strip foundations", "Cu.m", 145.5, 650, 94_575],
    ["D", "Return, fill and ram selected excavated material", "m³", 180, 350, 63_000],
    ["E", "Hardcore filling 300 mm thick, well compacted", "Sq.m", 540, 1_150, 621_000],
    ["F", "Anti-termite treatment to surfaces of hardcore", "m2", 540, 160.5, 86_670],
  ];
  const pageTwo: Item[] = [
    ["A", "Blinding 50 mm thick, class 15", "m2", 610, 620, 378_200],
    ["B", "Reinforced concrete class 25 in column bases", "m3", 96, 16_500, 1_584_000],
    ["C", "Reinforced concrete class 25 in ground beams", "m3", 58, 16_800, 974_400],
    ["D", "Ground floor slab 150 mm thick, class 25", "m3", 81.25, 16_200, 1_316_250],
    ["E", "High-yield steel bars Y12", "kg", 9_800, 165, 1_617_000],
    ["F", "High-yield steel bars Y16", "t", 7.4, 162_000, 1_198_800],
    ["G", "Galvanised binding wire", "kg", 1.5, 4.75, 7.13],
    ["H", "BRC mesh A142 in ground slab, lapped 300 mm", "m2", 540, 520, 280_800],
    ["J", "1000-gauge polythene damp-proof membrane", "m2", 560, 120, 67_200],
  ];
  const billTwo = sheet("BILL 2 - SUBSTRUCTURE", [
    [null, TITLE],
    [],
    [null, "BILL NO. 2"],
    [null, "SUBSTRUCTURE"],
    [],
    HEADER,
    CURRENCY,
    [],
    [null, "EXCAVATION AND EARTHWORKS"],
    ...pageOne.map(rowOf),
    [],
    [null, "Carried to Collection", null, null, null, 1_178_345],
    [],
    [null, "CONCRETE WORK"],
    ...pageTwo.slice(0, 4).map(rowOf),
    [null, "REINFORCEMENT"],
    ...pageTwo.slice(4).map(rowOf),
    [],
    [null, "Carried to Collection", null, null, null, 7_416_657.13],
    [],
    [null, "COLLECTION"],
    [null, "Page 2/1", null, null, null, 1_178_345],
    [null, "Page 2/2", null, null, null, 7_416_657.13],
    [],
    [null, "Total for Bill No. 2 carried to Summary", null, null, null, 8_595_002.13],
  ]);
  const billThree = sheet("BILL 3 - SUPERSTRUCTURE", [
    [null, TITLE],
    [],
    [null, "BILL NO. 3 – SUPERSTRUCTURE"],
    [],
    HEADER,
    CURRENCY,
    [],
    [null, "CONCRETE WORK"],
    ...(
      [
        ["A", "Reinforced concrete class 25 in columns", "m3", 142, 17_200, 2_442_400],
        [
          "B",
          "Reinforced concrete class 25 in suspended slabs 150 mm thick",
          "cum",
          386,
          16_400,
          6_330_400,
        ],
        ["C", "Formwork to soffits of suspended slabs", "sqm", 2_480, 820, 2_033_600],
        ["D", "Precast concrete lintels 150 × 200 mm", "No.", 64, 2_850, 182_400],
      ] as Item[]
    ).map(rowOf),
    [],
    [null, "Carried forward", null, null, null, 10_988_800],
    [],
    [null, "Brought forward", null, null, null, 10_988_800],
    [],
    [null, "WALLING AND OPENINGS"],
    ...(
      [
        [
          "A",
          "200 mm machine-cut natural stone walling in cement-sand mortar (1:4)",
          "m2",
          1_860,
          2_150,
          3_999_000,
        ],
        ["B", "Ditto, 150 mm thick partition walling", "M2", 12.345, 1_234.5, 15_239.9],
        ["C", "Hoop-iron reinforcement to alternate courses", "Lm", 5_200, 45, 234_000],
        ["D", "Steel casement windows, primed", "Nr", 48, 18_500, 888_000],
      ] as Item[]
    ).map(rowOf),
    [],
    [null, "Total carried to Summary", null, null, null, 16_125_039.9],
  ]);
  const billFour = sheet("BILL 4 - PC & PROV SUMS", [
    [null, TITLE],
    [],
    [null, "BILL NO. 4"],
    [null, "PC AND PROVISIONAL SUMS"],
    [],
    HEADER,
    CURRENCY,
    [],
    [null, "PRIME COST SUMS"],
    [
      "A",
      "Provide the PC sum of KShs 1,280,000 for kitchen fittings (16 units)",
      "Item",
      null,
      null,
      1_280_000,
    ],
    ["B", "Add for profit", "%", 5, null, 64_000],
    ["C", "Add for attendance", "%", 2.5, null, 32_000],
    ["D", "Provide the PC sum of KShs 940,000 for security doors", "Item", null, null, 940_000],
    ["E", "Add for profit", "%", 5, null, 47_000],
    ["F", "Add for attendance", "%", 2.5, null, 23_500],
    [null, "PROVISIONAL SUMS"],
    [
      "G",
      "Provide the provisional sum of KShs 350,000 for power connection",
      "Item",
      null,
      null,
      350_000,
    ],
    [
      "H",
      "Provide the provisional sum of KShs 180,000 for water and sewer connection fees",
      "Item",
      null,
      null,
      180_000,
    ],
    [null, "DAYWORKS"],
    ["J", "Provide the sum of KShs 250,000 for dayworks", "Sum", null, null, 250_000],
    [null, "CONTINGENCIES"],
    ["K", "Provide the sum of KShs 2,000,000 for contingencies", "Sum", null, null, 2_000_000],
    [],
    [null, "Total carried to Summary", null, null, null, 5_166_500],
  ]);
  const summary = sheet("GRAND SUMMARY", [
    [null, TITLE],
    [],
    [null, "GRAND SUMMARY"],
    [],
    ["ITEM", "DESCRIPTION", null, null, null, "AMOUNT (KSHS)"],
    [],
    [1, "BILL NO. 1 – PRELIMINARIES", null, null, null, 3_430_000],
    [2, "BILL NO. 2 – SUBSTRUCTURE", null, null, null, 8_595_002.13],
    [3, "BILL NO. 3 – SUPERSTRUCTURE", null, null, null, 16_125_039.9],
    [4, "BILL NO. 4 – PC AND PROVISIONAL SUMS", null, null, null, 5_166_500],
    [],
    [null, "SUB-TOTAL", null, null, null, 33_316_542.03],
    [null, "ADD VAT AT 16%", null, null, null, 5_330_646.72],
    [],
    [null, "GRAND TOTAL CARRIED TO FORM OF TENDER", null, null, null, 38_647_188.75],
  ]);
  return { fileType: "xlsx", sheets: [billOne, billTwo, billThree, billFour, summary] };
}

/** The messy bill: duplicate ref, missing unit, a formula, the row-23 typo and a wrong page total. */
export function messyGrid(): WorkbookGrid {
  return {
    fileType: "xlsx",
    sheets: [
      sheet("BILL 2", [
        [null, "KITENGELA BUNGALOW (SYNTHETIC)"],
        [],
        [null, "BILL NO. 2 – SUBSTRUCTURE"],
        [],
        HEADER,
        [],
        [null, "EXCAVATION AND EARTHWORKS"],
        ["A", "Excavate oversite average 150 mm deep", "m2", 620, 180, 111_600],
        ["B", "Excavate for column bases not exceeding 1.5 m deep", "m3", 310, 650, 201_500],
        ["B", "Excavate trenches for strip foundations", "m3", 145, 650, 94_250],
        ["C", "Return, fill and ram selected excavated material", null, 180, 350, 63_000],
        ["D", "Hardcore filling 300 mm thick", "m2", 540, 1_150, { f: "D12*E12", v: 621_000 }],
        [],
        [null, "CONCRETE WORK"],
        ["A", "Blinding 50 mm thick, class 15", "m2", 610, 620, 378_200],
        ["B", "Reinforced concrete class 25 in column bases", "m3", 96, 16_500, 1_584_000],
        [],
        [],
        [],
        [],
        [],
        [],
        ["C", "Reinforced concrete class 25 in ground beams", "m3", 58, 16_800, 947_400],
        [],
        [null, "Carried to Collection", null, null, null, 3_316_950],
      ]),
    ],
  };
}
