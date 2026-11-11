/** Labourer sign-in PINs: six digits, refusing the guesses an attacker would try first. */
export const PIN_LENGTH = 6;
export const PIN_PROBLEMS = ["format", "repeated", "sequence", "phone"] as const;
export type PinProblem = (typeof PIN_PROBLEMS)[number];

/**
 * Why a PIN is refused, or null. Six digits only; not one repeated digit or a repeated pair or
 * triple (111111, 121212, 123123); not a run up or down (123456, 987654, 890123); not the
 * last six digits of the labourer's phone number. Online guessing is also limited by the API's
 * lockout and rate limits.
 */
export function pinProblem(pin: string, phone?: string | null): PinProblem | null {
  if (!/^\d{6}$/.test(pin)) return "format";
  if (/^(\d)\1{5}$/.test(pin) || /^(\d\d)\1\1$/.test(pin) || /^(\d{3})\1$/.test(pin))
    return "repeated";
  const digits = pin.split("").map(Number);
  const steps = digits.slice(1).map((digit, index) => (digit - digits[index]! + 10) % 10);
  if (steps.every((step) => step === 1) || steps.every((step) => step === 9)) return "sequence";
  if (phone && phone.replace(/\D/g, "").endsWith(pin)) return "phone";
  return null;
}
