import type { MaterialCategory } from "@pm-buddy/types";
import type { MaterialAttributes } from "./attributes.js";

/**
 * The Kenyan starter catalogue a company can load (D5.1, `POST /materials/defaults`). Factors are
 * written as assumptions (`note`): densities, coverage and pack sizes vary by source and supplier,
 * so each company should confirm or end them. A lorry trip is never a default: trips are defined
 * per supplier (brief §15 G). Kiswahili names await a native speaker's review.
 */
export interface StarterConversion {
  fromUnit: string;
  fromQuantity: string;
  toUnit: string;
  toQuantity: string;
  note: string;
}

export interface StarterMaterial {
  name: string;
  nameSw: string;
  category: MaterialCategory;
  baseUnit: string;
  spec: string | null;
  attributes: MaterialAttributes;
  conversions: StarterConversion[];
}

const steel = (diameterMm: number): StarterMaterial => ({
  name: `Steel bar Y${diameterMm} (high yield, 12 m)`,
  nameSw: `Nondo Y${diameterMm} (mita 12)`,
  category: "steel",
  baseUnit: "kg",
  spec: "Deformed high-yield bar, KS EAS 412 / BS 4449 grade B500",
  attributes: { diameterMm, pieceLengthM: "12" },
  conversions: [],
});

export const KENYAN_STARTER_CATALOGUE: readonly StarterMaterial[] = [
  {
    name: "Cement 42.5N (50 kg bag)",
    nameSw: "Saruji 42.5N (mfuko wa kilo 50)",
    category: "cement",
    baseUnit: "bag_50kg",
    spec: "CEM I / CEM II 42.5N, KS EAS 18-1",
    attributes: {},
    conversions: [],
  },
  {
    name: "Cement 32.5R (50 kg bag)",
    nameSw: "Saruji 32.5R (mfuko wa kilo 50)",
    category: "cement",
    baseUnit: "bag_50kg",
    spec: "CEM IV 32.5R, KS EAS 18-1",
    attributes: {},
    conversions: [],
  },
  {
    name: "River sand",
    nameSw: "Mchanga wa mto",
    category: "aggregates",
    baseUnit: "t",
    spec: "Clean, washed, for concrete and mortar",
    attributes: {},
    conversions: [
      {
        fromUnit: "m3",
        fromQuantity: "1",
        toUnit: "t",
        toQuantity: "1.6",
        note: "ASSUMPTION: loose bulk density 1.6 t/m³; confirm locally",
      },
    ],
  },
  {
    name: "Ballast 20 mm",
    nameSw: "Kokoto milimita 20",
    category: "aggregates",
    baseUnit: "t",
    spec: "Crushed stone aggregate, 20 mm (¾ inch)",
    attributes: {},
    conversions: [
      {
        fromUnit: "m3",
        fromQuantity: "1",
        toUnit: "t",
        toQuantity: "1.5",
        note: "ASSUMPTION: loose bulk density 1.5 t/m³; confirm locally",
      },
    ],
  },
  {
    name: "Machine-cut stone 200 × 200 × 400 mm",
    nameSw: "Mawe ya mashine 200 × 200 × 400 mm",
    category: "blocks_stones",
    baseUnit: "nr",
    spec: "9 × 9 inch walling stone",
    attributes: {},
    conversions: [
      {
        fromUnit: "m2",
        fromQuantity: "1",
        toUnit: "nr",
        toQuantity: "12.5",
        note: "ASSUMPTION: 12.5 stones per m² of wall face with 10 mm joints",
      },
    ],
  },
  {
    name: "Concrete block 150 mm (hollow)",
    nameSw: "Kitalu cha zege 150 mm (chenye uwazi)",
    category: "blocks_stones",
    baseUnit: "nr",
    spec: "150 × 200 × 400 mm",
    attributes: {},
    conversions: [
      {
        fromUnit: "m2",
        fromQuantity: "1",
        toUnit: "nr",
        toQuantity: "12.5",
        note: "ASSUMPTION: 12.5 blocks per m² of wall face with 10 mm joints",
      },
    ],
  },
  steel(8),
  steel(10),
  steel(12),
  steel(16),
  steel(20),
  steel(25),
  steel(32),
  {
    name: "BRC mesh A142",
    nameSw: "Wavu wa BRC A142",
    category: "brc_mesh",
    baseUnit: "m2",
    spec: "Welded fabric, 6 mm at 200 mm centres",
    attributes: { meshType: "A142", sheetWidthM: "2.4", sheetLengthM: "4.8", rollLengthM: "48" },
    conversions: [],
  },
  {
    name: "Cypress timber 50 × 100 mm (2 × 4 in)",
    nameSw: "Mbao ya msonobari 50 × 100 mm (2 × 4)",
    category: "timber",
    baseUnit: "m",
    spec: "Sawn, treated",
    attributes: { sectionWidthMm: "50", sectionDepthMm: "100" },
    conversions: [],
  },
  {
    name: "Roofing sheet, box profile, gauge 30",
    nameSw: "Bati la paa, box profile, geji 30",
    category: "roofing",
    baseUnit: "m",
    spec: "Pre-painted, sold by running metre",
    attributes: { gauge: 30 },
    conversions: [],
  },
  {
    name: "Roofing sheet, corrugated, gauge 32, 3 m",
    nameSw: "Bati la paa, mawimbi, geji 32, mita 3",
    category: "roofing",
    baseUnit: "nr",
    spec: "Galvanised, 3 m sheets",
    attributes: { gauge: 32, pieceLengthM: "3" },
    conversions: [],
  },
  {
    name: "uPVC pipe 110 mm (6 m)",
    nameSw: "Bomba la uPVC 110 mm (mita 6)",
    category: "plumbing",
    baseUnit: "nr",
    spec: "Soil and waste, class B",
    attributes: { pieceLengthM: "6" },
    conversions: [],
  },
  {
    name: "Cable 2.5 mm² twin and earth",
    nameSw: "Waya wa umeme 2.5 mm² (twin and earth)",
    category: "electrical",
    baseUnit: "m",
    spec: "PVC insulated, KS 04-206",
    attributes: {},
    conversions: [
      {
        fromUnit: "roll",
        fromQuantity: "1",
        toUnit: "m",
        toQuantity: "100",
        note: "Standard 100 m roll",
      },
    ],
  },
  {
    name: "Emulsion paint (interior)",
    nameSw: "Rangi ya emulsheni (ndani)",
    category: "finishes",
    baseUnit: "l",
    spec: null,
    attributes: {},
    conversions: [],
  },
  {
    name: "Binding wire",
    nameSw: "Waya wa kufunga nondo",
    category: "other",
    baseUnit: "kg",
    spec: "Soft annealed, 1.2 mm",
    attributes: {},
    conversions: [
      {
        fromUnit: "roll",
        fromQuantity: "1",
        toUnit: "kg",
        toQuantity: "25",
        note: "ASSUMPTION: 25 kg roll; confirm with the supplier",
      },
    ],
  },
];
