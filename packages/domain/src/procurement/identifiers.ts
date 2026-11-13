import type { EtimsNumberFormat, VehicleRegFormat } from "@pm-buddy/types";

/**
 * Identifier helpers for deliveries and invoices (D5.2). Both are format checks only: PM-Buddy
 * does not query NTSA for vehicles or KRA for eTIMS invoices (CR-TAX-02).
 */

const VEHICLE_CHARACTERS = /^[A-Z0-9 -]{2,15}$/;
// Kenyan plates (heuristic, for flagging only): cars and lorries KAA 123A (and the older KAA 123),
// motorcycles KMAA 123A, government GK A123B, trailers ZA 1234.
const KENYAN_PLATES: readonly [RegExp, (compact: string) => string][] = [
  [/^K[A-Z]{2}\d{3}[A-Z]?$/, (c) => `${c.slice(0, 3)} ${c.slice(3)}`],
  [/^KM[A-Z]{2}\d{3}[A-Z]$/, (c) => `${c.slice(0, 4)} ${c.slice(4)}`],
  [/^GK[A-Z]\d{3,4}[A-Z]?$/, (c) => `GK ${c.slice(2)}`],
  [/^Z[A-Z]\d{4}$/, (c) => `${c.slice(0, 2)} ${c.slice(2)}`],
];

/**
 * A vehicle registration as written on a GRN: upper-case, single spaces. Kenyan formats are
 * recognised and spaced canonically (`kda123a` → `KDA 123A`); anything else of 2–15 letters,
 * digits, spaces or hyphens is kept as `other` (a foreign or unusual plate, flagged for review).
 * Null when it cannot be a registration at all.
 */
export function normaliseVehicleRegistration(
  input: string,
): { value: string; format: VehicleRegFormat } | null {
  const spaced = input.trim().toUpperCase().replace(/\s+/g, " ");
  if (!VEHICLE_CHARACTERS.test(spaced)) return null;
  const compact = spaced.replace(/[ -]/g, "");
  if (compact.length < 2 || !/[A-Z0-9]/.test(compact)) return null;
  for (const [pattern, format] of KENYAN_PLATES)
    if (pattern.test(compact)) return { value: format(compact), format: "kenyan" };
  return { value: spaced, format: "other" };
}

/** A KRA eTIMS control-unit invoice number: `KRACU0400000078/2231` (CU ID, slash, sequence). */
export const ETIMS_INVOICE_NUMBER = /^KRA[A-Z]{2}\d{10}\/\d{1,10}$/;
const ETIMS_CHARACTERS = /^[A-Z0-9][A-Z0-9/-]{5,39}$/;

/**
 * Normalises and classifies the eTIMS number written on a supplier invoice. `etims` when it has
 * the control-unit shape; `unrecognised` for other plausible references (shown as a warning, so a
 * format this check does not know never blocks an invoice); null when it cannot be a reference.
 */
export function classifyEtimsInvoiceNumber(
  input: string,
): { value: string; format: EtimsNumberFormat } | null {
  const value = input.trim().toUpperCase().replace(/\s+/g, "");
  if (!ETIMS_CHARACTERS.test(value)) return null;
  return { value, format: ETIMS_INVOICE_NUMBER.test(value) ? "etims" : "unrecognised" };
}

/**
 * The key that makes a supplier's invoice number unique: upper-case without spaces, hyphens,
 * slashes or dots, so `inv-001` and `INV 001` are the same invoice.
 */
export function invoiceNumberKey(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/[\s./-]+/g, "");
}

/** The key that makes a settlement's external reference unique per method. */
export const settlementReferenceKey = invoiceNumberKey;
