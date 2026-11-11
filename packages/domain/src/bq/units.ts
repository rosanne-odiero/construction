import type { BqUnit } from "@pm-buddy/types";
import { sanitiseCellText } from "./text.js";

/** How each normalised unit is shown (brief §5.2: m³, m², m, kg, t, No., Item, LS). */
export const BQ_UNIT_LABELS: Record<Exclude<BqUnit, "other">, string> = {
  m3: "m³",
  m2: "m²",
  m: "m",
  kg: "kg",
  t: "t",
  nr: "No.",
  item: "Item",
  ls: "LS",
  pct: "%",
  hr: "hr",
  day: "day",
  week: "wk",
  month: "month",
  l: "litre",
  set: "set",
  pair: "pair",
};

/** Spellings found in Kenyan QS practice, compared after lower-casing and removing . _ / - and spaces. */
const ALIASES: Record<Exclude<BqUnit, "other">, readonly string[]> = {
  m3: [
    "m3",
    "m³",
    "cum",
    "cubm",
    "cbm",
    "cum3",
    "cubicmetre",
    "cubicmetres",
    "cubicmeter",
    "cubicmeters",
  ],
  m2: [
    "m2",
    "m²",
    "sqm",
    "sm",
    "sqmt",
    "sqmtr",
    "squaremetre",
    "squaremetres",
    "squaremeter",
    "squaremeters",
  ],
  m: [
    "m",
    "lm",
    "rm",
    "linm",
    "lin",
    "mrun",
    "run",
    "metre",
    "metres",
    "meter",
    "meters",
    "linearmetre",
    "linearmetres",
    "mtr",
    "mtrs",
  ],
  kg: ["kg", "kgs", "kilo", "kilos", "kilogram", "kilograms", "kilogramme", "kilogrammes"],
  t: ["t", "tonne", "tonnes", "ton", "tons", "tn", "tns"],
  nr: ["no", "nos", "nr", "nrs", "number", "numbers", "pc", "pcs", "piece", "pieces", "each", "ea"],
  item: ["item", "items", "itm"],
  ls: ["ls", "lumpsum", "sum", "sums", "psum", "provsum"],
  pct: ["%", "pct", "percent", "percentage"],
  hr: ["hr", "hrs", "hour", "hours"],
  day: ["day", "days", "dy"],
  week: ["wk", "wks", "week", "weeks"],
  month: ["month", "months", "mth", "mths", "mon", "mo"],
  l: ["l", "ltr", "ltrs", "litre", "litres", "liter", "liters"],
  set: ["set", "sets"],
  pair: ["pair", "pairs", "pr", "prs"],
};

const LOOKUP = new Map<string, Exclude<BqUnit, "other">>(
  (Object.entries(ALIASES) as [Exclude<BqUnit, "other">, readonly string[]][]).flatMap(
    ([code, aliases]) => aliases.map((alias) => [alias, code] as const),
  ),
);

export type NormalisedUnit = { code: BqUnit; label: string; raw: string };

/**
 * Normalises a unit as written (m3, m³, cum → m3; m2, sqm → m2; No., Nr → nr; LS, Sum → ls; …).
 * An unrecognised unit is kept as written with the code `other`; blank input gives null.
 */
export function normaliseUnit(raw: string | null | undefined): NormalisedUnit | null {
  const text = sanitiseCellText(raw ?? "", 30).text;
  if (!text) return null;
  const key = text
    .toLowerCase()
    .replace(/\^/g, "")
    .replace(/[\s._/'’-]/g, "");
  const code = LOOKUP.get(key);
  return code
    ? { code, label: BQ_UNIT_LABELS[code], raw: text }
    : { code: "other", label: text, raw: text };
}
