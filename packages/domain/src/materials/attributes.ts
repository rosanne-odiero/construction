import {
  STEEL_BAR_DIAMETERS_MM,
  STEEL_MASS_DIVISOR,
  STEEL_STANDARD_BAR_LENGTH_M,
  type ConversionSource,
  type DerivedConversionRule,
  type MaterialCategory,
} from "@pm-buddy/types";
import { Ratio } from "./ratio.js";

/**
 * Optional, category-specific material attributes. Lengths are exact decimal strings in metres
 * (sections in millimetres); they feed the standard conversions below.
 */
export interface MaterialAttributes {
  /** Steel bars: nominal diameter in mm (Y8–Y32). */
  diameterMm?: number;
  /** Length of one piece in metres: a steel bar (12 m if unset), a pipe, a sheet, a timber piece. */
  pieceLengthM?: string;
  /** Roofing sheets: gauge (24–32). */
  gauge?: number;
  /** Roofing sheets: effective cover width in metres (turns running metres into m²). */
  coverWidthM?: string;
  /** Timber: section in mm (width × depth). */
  sectionWidthMm?: string;
  sectionDepthMm?: string;
  /** BRC mesh: reference (A98, A142…) and sheet/roll sizes in metres. */
  meshType?: string;
  sheetWidthM?: string;
  sheetLengthM?: string;
  rollLengthM?: string;
}

/** One way to turn 1 `from` into `ratio` × `to` (used in both directions). */
export interface ConversionEdge {
  from: string;
  to: string;
  ratio: Ratio;
  source: ConversionSource;
  /** The explicit conversion row, for supplier and material factors. */
  conversionId: string | null;
  /** The standard formula, for factors derived from material attributes. */
  rule: DerivedConversionRule | null;
}

export const isSteelBarDiameter = (value: number) =>
  (STEEL_BAR_DIAMETERS_MM as readonly number[]).includes(value);

/**
 * Nominal steel mass per metre, d² / 162 kg/m with d in mm (the formula used on Kenyan sites; it
 * is within 0.15 % of BS 4449 / KS EAS 412 nominal masses: π/4 × d² × 7,850 kg/m³). Exact as a
 * fraction; Y12 = 144/162 = 0.888… kg/m.
 */
export function steelMassPerMetre(diameterMm: number): Ratio {
  if (!Number.isInteger(diameterMm) || diameterMm <= 0)
    throw new RangeError("A bar diameter is a positive whole number of millimetres");
  return Ratio.of(diameterMm * diameterMm, STEEL_MASS_DIVISOR);
}

const derived = (
  from: string,
  to: string,
  ratio: Ratio,
  rule: DerivedConversionRule,
): ConversionEdge => ({
  from,
  to,
  ratio,
  source: "material_attribute",
  conversionId: null,
  rule,
});

const positive = (value: string | undefined): Ratio | null => {
  if (value === undefined) return null;
  try {
    const ratio = Ratio.fromDecimal(value);
    return ratio.isZero() ? null : ratio;
  } catch {
    return null;
  }
};

/** Standard conversions that follow from a material's category and attributes. */
export function derivedEdges(
  category: MaterialCategory,
  attributes: MaterialAttributes,
): ConversionEdge[] {
  const edges: ConversionEdge[] = [];
  const pieceLength =
    positive(attributes.pieceLengthM) ??
    (category === "steel" ? Ratio.fromDecimal(STEEL_STANDARD_BAR_LENGTH_M) : null);
  if (category === "steel" && attributes.diameterMm && isSteelBarDiameter(attributes.diameterMm))
    edges.push(
      derived("m", "kg", steelMassPerMetre(attributes.diameterMm), "steel_mass_per_metre"),
    );
  if (pieceLength) edges.push(derived("nr", "m", pieceLength, "piece_length"));
  const cover = positive(attributes.coverWidthM);
  if (category === "roofing" && cover) edges.push(derived("m", "m2", cover, "cover_width"));
  const width = positive(attributes.sectionWidthMm);
  const depth = positive(attributes.sectionDepthMm);
  if (category === "timber" && width && depth)
    edges.push(
      derived("m", "m3", width.times(depth).dividedBy(Ratio.of(1_000_000)), "timber_section"),
    );
  const sheetWidth = positive(attributes.sheetWidthM);
  const sheetLength = positive(attributes.sheetLengthM);
  const rollLength = positive(attributes.rollLengthM);
  if (category === "brc_mesh" && sheetWidth && sheetLength)
    edges.push(derived("sheet", "m2", sheetWidth.times(sheetLength), "mesh_sheet_area"));
  if (category === "brc_mesh" && sheetWidth && rollLength)
    edges.push(derived("roll", "m2", sheetWidth.times(rollLength), "mesh_roll_area"));
  return edges;
}
