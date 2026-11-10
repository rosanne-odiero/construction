/**
 * Sample BQ for Ruiru Heights (4-storey, 16 units). Amounts are computed from quantity × rate,
 * so bill totals, summary and contract sum always reconcile. Demo data only.
 */

export type BillKind = "preliminaries" | "measured" | "provisional";

export interface BqItem {
  ref: string;
  description: string;
  unit: string;
  qty: number;
  rate: number; // KES per unit (whole shillings in this mock)
  done: number; // 0..1 measured progress to date
}

export interface BqSection {
  code: string;
  title: string;
  items: BqItem[];
}

export interface BqBill {
  number: number;
  title: string;
  kind: BillKind;
  sections: BqSection[];
  costFactor: number; // actual cost ÷ earned value for the budget chart (CPI⁻¹)
}

const s = (code: string, title: string, items: BqItem[]): BqSection => ({ code, title, items });
const i = (
  ref: string,
  description: string,
  unit: string,
  qty: number,
  rate: number,
  done: number,
): BqItem => ({
  ref,
  description,
  unit,
  qty,
  rate,
  done,
});

export const ruiruBills: BqBill[] = [
  {
    number: 1,
    title: "Preliminaries",
    kind: "preliminaries",
    costFactor: 1.07,
    sections: [
      s("1", "General items", [
        i("1.1", "Site establishment, hoarding and signboard", "Item", 1, 650_000, 1),
        i("1.2", "Site offices, stores and welfare facilities", "Item", 1, 480_000, 1),
        i("1.3", "Water and electricity for the works", "Item", 1, 420_000, 0.55),
        i("1.4", "Insurances: Contractor's All Risk and WIBA", "Item", 1, 380_000, 0.55),
        i("1.5", "Scaffolding, edge protection and safety", "Item", 1, 920_000, 0.45),
        i("1.6", "Site supervision and management", "Month", 14, 95_000, 0.57),
        i("1.7", "Clear site and make good on completion", "Item", 1, 170_000, 0),
      ]),
    ],
  },
  {
    number: 2,
    title: "Substructure",
    kind: "measured",
    costFactor: 0.98,
    sections: [
      s("2.A", "Excavation and earthworks", [
        i(
          "2.A.1",
          "Excavate oversite to remove vegetable soil average 150 mm deep",
          "m²",
          620,
          180,
          1,
        ),
        i("2.A.2", "Excavate for column bases not exceeding 1.5 m deep", "m³", 310, 650, 1),
        i("2.A.3", "Excavate trenches for strip foundations", "m³", 145, 650, 1),
        i("2.A.4", "Return, fill and ram selected excavated material", "m³", 180, 350, 1),
        i("2.A.5", "Hardcore filling 300 mm thick, well compacted", "m²", 540, 1_150, 1),
        i("2.A.6", "Anti-termite treatment to surfaces of hardcore", "m²", 540, 160, 1),
      ]),
      s("2.B", "Concrete work", [
        i("2.B.1", "Blinding 50 mm thick, class 15", "m²", 610, 620, 1),
        i("2.B.2", "Reinforced concrete class 25 in column bases", "m³", 96, 16_500, 1),
        i("2.B.3", "Reinforced concrete class 25 in ground beams", "m³", 58, 16_800, 1),
        i("2.B.4", "Ground floor slab 150 mm thick, class 25", "m³", 81, 16_200, 1),
      ]),
      s("2.C", "Reinforcement", [
        i("2.C.1", "High-yield steel bars Y12", "kg", 9_800, 165, 1),
        i("2.C.2", "High-yield steel bars Y16", "kg", 7_400, 162, 1),
        i("2.C.3", "BRC mesh A142 in ground slab", "m²", 540, 520, 1),
      ]),
      s("2.D", "Formwork and damp-proofing", [
        i("2.D.1", "Sawn formwork to sides of bases and beams", "m²", 420, 780, 1),
        i("2.D.2", "1000-gauge polythene damp-proof membrane", "m²", 560, 120, 1),
      ]),
    ],
  },
  {
    number: 3,
    title: "Superstructure: frame",
    kind: "measured",
    costFactor: 1.12,
    sections: [
      s("3.A", "Concrete work", [
        i("3.A.1", "Reinforced concrete class 25 in columns", "m³", 142, 17_200, 0.78),
        i(
          "3.A.2",
          "Reinforced concrete class 25 in suspended slabs 150 mm",
          "m³",
          386,
          16_400,
          0.75,
        ),
        i("3.A.3", "Reinforced concrete class 25 in beams", "m³", 118, 17_000, 0.75),
        i("3.A.4", "Reinforced concrete class 25 in staircase", "m³", 24, 18_500, 0.7),
      ]),
      s("3.B", "Reinforcement", [
        i("3.B.1", "High-yield steel bars Y10", "kg", 14_600, 168, 0.82),
        i("3.B.2", "High-yield steel bars Y12", "kg", 11_200, 165, 0.8),
        i("3.B.3", "High-yield steel bars Y16", "kg", 6_900, 162, 0.78),
      ]),
      s("3.C", "Formwork", [
        i("3.C.1", "Formwork to soffits of suspended slabs", "m²", 2_480, 820, 0.75),
        i("3.C.2", "Formwork to sides of columns and beams", "m²", 1_640, 860, 0.76),
      ]),
    ],
  },
  {
    number: 4,
    title: "Walling",
    kind: "measured",
    costFactor: 1.01,
    sections: [
      s("4", "Masonry", [
        i(
          "4.1",
          "200 mm machine-cut natural stone walling in cement-sand mortar (1:4)",
          "m²",
          1_860,
          2_150,
          0.55,
        ),
        i("4.2", "150 mm machine-cut stone partition walling", "m²", 1_240, 1_780, 0.4),
        i("4.3", "Hoop-iron reinforcement to alternate courses", "m", 5_200, 45, 0.5),
        i("4.4", "Reinforced concrete lintels class 25", "m³", 22, 17_500, 0.45),
      ]),
    ],
  },
  {
    number: 5,
    title: "Roofing",
    kind: "measured",
    costFactor: 1,
    sections: [
      s("5", "Roof structure and covering", [
        i("5.1", "Treated structural timber trusses 50 × 150 mm", "m", 1_380, 620, 0),
        i("5.2", "Pre-painted gauge 28 roofing sheets, fixed", "m²", 760, 1_450, 0),
        i("5.3", "Ridge capping", "m", 64, 850, 0),
        i("5.4", "PVC gutters and downpipes", "m", 180, 1_250, 0),
        i("5.5", "Fascia board 25 × 225 mm, painted", "m", 150, 680, 0),
      ]),
    ],
  },
  {
    number: 6,
    title: "Finishes",
    kind: "measured",
    costFactor: 1,
    sections: [
      s("6.A", "Floor finishes", [
        i("6.A.1", "Cement-sand screed 40 mm thick", "m²", 2_350, 650, 0.12),
        i("6.A.2", "600 × 600 mm ceramic floor tiles", "m²", 1_980, 2_400, 0),
      ]),
      s("6.B", "Wall finishes", [
        i("6.B.1", "Internal plaster 15 mm thick", "m²", 6_200, 520, 0.08),
        i("6.B.2", "External render 20 mm thick", "m²", 2_100, 680, 0),
        i("6.B.3", "Wall tiles to kitchens and bathrooms", "m²", 640, 2_600, 0),
      ]),
      s("6.C", "Painting", [
        i("6.C.1", "Three coats emulsion paint to internal walls", "m²", 6_200, 240, 0),
        i("6.C.2", "Weatherproof paint to external walls", "m²", 2_100, 320, 0),
      ]),
    ],
  },
  {
    number: 7,
    title: "Services",
    kind: "measured",
    costFactor: 0.96,
    sections: [
      s("7.A", "Plumbing and drainage", [
        i("7.A.1", "PPR water supply pipework, complete", "Item", 1, 1_850_000, 0.2),
        i("7.A.2", "Sanitary fittings (WC, basin, shower) per apartment", "No.", 16, 68_000, 0),
        i("7.A.3", "10,000-litre water storage tank on stand", "No.", 2, 145_000, 0),
      ]),
      s("7.B", "Electrical", [
        i("7.B.1", "Electrical installation per apartment, complete", "No.", 16, 112_000, 0.15),
        i("7.B.2", "Main distribution board and sub-mains", "Item", 1, 480_000, 0),
      ]),
    ],
  },
  {
    number: 8,
    title: "External works",
    kind: "measured",
    costFactor: 1,
    sections: [
      s("8", "External works", [
        i("8.1", "Cabro paving 80 mm on hardcore base", "m²", 820, 1_750, 0),
        i("8.2", "Foul drainage, manholes and connection", "Item", 1, 620_000, 0),
      ]),
    ],
  },
  {
    number: 9,
    title: "Provisional and PC sums",
    kind: "provisional",
    costFactor: 1,
    sections: [
      s("9", "Provisional sums, PC sums and dayworks", [
        i("9.1", "Provisional sum: power connection", "Sum", 1, 350_000, 0),
        i("9.2", "Provisional sum: water and sewer connection fees", "Sum", 1, 180_000, 0),
        i("9.3", "PC sum: kitchen cabinets (16 units)", "Sum", 1, 1_280_000, 0),
        i("9.4", "PC sum: security doors and burglar-proofing", "Sum", 1, 940_000, 0),
        i("9.5", "Profit and attendance on PC sums", "Item", 1, 222_000, 0),
        i("9.6", "Dayworks (provisional)", "Sum", 1, 250_000, 0),
      ]),
    ],
  },
];

export const CONTINGENCY_MINOR = 2_000_000_00;
// COMPLIANCE-REVIEW: VAT rate comes from effective-dated config (seed 16%) in the real system.
export const VAT_RATE = 0.16;

export const itemAmountMinor = (item: BqItem) => Math.round(item.qty * item.rate * 100);
export const itemDoneMinor = (item: BqItem) => Math.round(itemAmountMinor(item) * item.done);

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

export const sectionTotalMinor = (section: BqSection) => sum(section.items.map(itemAmountMinor));
export const billTotalMinor = (bill: BqBill) => sum(bill.sections.map(sectionTotalMinor));
export const billDoneMinor = (bill: BqBill) =>
  sum(bill.sections.flatMap((sec) => sec.items.map(itemDoneMinor)));

export function bqSummary(bills: BqBill[]) {
  const billsTotalMinor = sum(bills.map(billTotalMinor));
  const subtotalMinor = billsTotalMinor + CONTINGENCY_MINOR;
  const vatMinor = Math.round(subtotalMinor * VAT_RATE);
  const contractSumMinor = subtotalMinor + vatMinor;
  const doneMinor = sum(bills.map(billDoneMinor));
  const measuredMinor = sum(bills.filter((b) => b.kind !== "provisional").map(billTotalMinor));
  return {
    billsTotalMinor,
    contingencyMinor: CONTINGENCY_MINOR,
    subtotalMinor,
    vatMinor,
    contractSumMinor,
    doneMinor,
    progress: doneMinor / measuredMinor,
    itemCount: bills.flatMap((b) => b.sections.flatMap((sec) => sec.items)).length,
  };
}

export const ruiruSummary = bqSummary(ruiruBills);

export type VoStatus = "approved" | "awaiting_client" | "draft";
export interface VariationOrder {
  number: string;
  instruction: string;
  title: string;
  amountMinor: number; // excluding VAT
  status: VoStatus;
  date: string;
}

export const ruiruVariations: VariationOrder[] = [
  {
    number: "VO-001",
    instruction: "AI-002",
    title: "Additional ground beam at grid C",
    amountMinor: 412_000_00,
    status: "approved",
    date: "2026-05-22",
  },
  {
    number: "VO-002",
    instruction: "AI-004",
    title: "Omit cabro paving to rear court",
    amountMinor: -286_000_00,
    status: "approved",
    date: "2026-07-30",
  },
  {
    number: "VO-003",
    instruction: "AI-006",
    title: "Upgrade living-area floor tiles to 600 × 600 porcelain",
    amountMinor: 1_158_000_00,
    status: "approved",
    date: "2026-11-02",
  },
  {
    number: "VO-004",
    instruction: "AI-007",
    title: "Additional rooftop water tanks (2 × 10,000 L)",
    amountMinor: 340_000_00,
    status: "awaiting_client",
    date: "2026-11-06",
  },
];

export const approvedVariationsMinor = sum(
  ruiruVariations.filter((v) => v.status === "approved").map((v) => v.amountMinor),
);
export const revisedContractSumMinor =
  ruiruSummary.contractSumMinor + Math.round(approvedVariationsMinor * (1 + VAT_RATE));

export const bqVersions = [
  { version: 1, label: "Original contract BQ", date: "2026-02-14", source: "import" },
  { version: 2, label: "VO-001, VO-002", date: "2026-07-30", source: "variation" },
  { version: 3, label: "VO-003", date: "2026-11-02", source: "variation" },
];

/** Raw rows as they appear in a typical QS Excel BQ, used by the import-mapping mock. */
export const importPreviewColumns = [
  "ITEM",
  "DESCRIPTION",
  "UNIT",
  "QTY",
  "RATE",
  "AMOUNT (KSHS)",
] as const;
export const importPreviewRows: string[][] = [
  ["", "BILL NO. 2 – SUBSTRUCTURE", "", "", "", ""],
  ["", "EXCAVATION AND EARTHWORKS", "", "", "", ""],
  [
    "A",
    "Excavate oversite to remove vegetable soil average 150 mm deep",
    "m2",
    "620",
    "180.00",
    "111,600.00",
  ],
  ["B", "Excavate for column bases not exceeding 1.5 m deep", "m3", "310", "650.00", "201,500.00"],
  ["C", "Excavate trenches for strip foundations", "m3", "145", "650.00", "94,250.00"],
  ["", "CONCRETE WORK", "", "", "", ""],
  ["A", "Blinding 50 mm thick, class 15", "m2", "610", "620.00", "378,200.00"],
  ["B", "Reinforced concrete class 25 in column bases", "m3", "96", "16,500.00", "1,584,000.00"],
  ["C", "Reinforced concrete class 25 in ground beams", "m3", "58", "16,800.00", "947,400.00"],
  ["", "Carried to Collection", "", "", "KSHS", "3,316,950.00"],
];
