/**
 * Supplier identifiers (D5.1). KRA PINs are an `A` (individual) or `P` (non-individual) followed
 * by nine digits and a check letter, e.g. P051234567Q. They are stored encrypted with a blind
 * index (ARCHITECTURE §10) and shown masked unless a permitted user reveals them.
 */
const KRA_PIN = /^[AP]\d{9}[A-Z]$/;

/** Upper-cases and removes spaces and hyphens; null when the result is not a KRA PIN. */
export function normaliseKraPin(input: string): string | null {
  const candidate = input.replace(/[\s-]/g, "").toUpperCase();
  return KRA_PIN.test(candidate) ? candidate : null;
}

export const isKraPin = (value: string) => KRA_PIN.test(value);

/** P051234567Q → P•••••••67Q (the type letter and the last three characters). */
export function maskKraPin(pin: string): string {
  return `${pin.slice(0, 1)}•••••••${pin.slice(-3)}`;
}

/** Bank account numbers: digits and capital letters, 5–30 characters, spaces and hyphens removed. */
export function normaliseAccountNumber(input: string): string | null {
  const candidate = input.replace(/[\s-]/g, "").toUpperCase();
  return /^[0-9A-Z]{5,30}$/.test(candidate) ? candidate : null;
}

/**
 * 01234567891234 → ••••1234: the last four characters of a number of ten or more, the last two of
 * a shorter one, so a masked short number does not give most of it away.
 */
export function maskAccountNumber(account: string): string {
  return `••••${account.slice(account.length >= 10 ? -4 : -2)}`;
}
