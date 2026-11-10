/**
 * Kenyan mobile numbers are stored and compared in one canonical form: 2547XXXXXXXX or 2541XXXXXXXX
 * (brief §2). Inputs commonly arrive as 07…, 01…, +2547…, 7… or with spaces and dashes.
 */
const CANONICAL = /^254[17]\d{8}$/;

export function normalizeKenyanPhone(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  let candidate = digits;
  if (digits.length === 10 && digits.startsWith("0")) candidate = `254${digits.slice(1)}`;
  else if (digits.length === 9 && /^[17]/.test(digits)) candidate = `254${digits}`;
  return CANONICAL.test(candidate) ? candidate : null;
}

export function isKenyanMobile(value: string): boolean {
  return CANONICAL.test(value);
}

/** Masks a canonical number for display, e.g. 254712345678 → 2547•••••678. */
export function maskPhone(canonical: string): string {
  return `${canonical.slice(0, 4)}•••••${canonical.slice(-3)}`;
}
