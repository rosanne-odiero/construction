import { normalizeKenyanPhone } from "@pm-buddy/domain";
import { CURRENCIES } from "@pm-buddy/types";
import { z } from "zod";

/** Integer minor units, safe for JSON numbers (|n| ≤ 2^53 − 1). */
export const minorUnitsSchema = z
  .number()
  .int()
  .refine(Number.isSafeInteger, "amount_out_of_range");

export const moneySchema = z.object({
  amountMinor: minorUnitsSchema,
  currency: z.enum(CURRENCIES),
});

/** Quantities and rates travel as decimal strings (ARCHITECTURE §9). */
export const decimalStringSchema = z.string().regex(/^-?\d+(\.\d+)?$/, "invalid_decimal");

/** Accepts any common Kenyan mobile format and outputs the canonical 2547XXXXXXXX / 2541XXXXXXXX. */
export const kenyanPhoneSchema = z.string().transform((value, ctx) => {
  const normalised = normalizeKenyanPhone(value);
  if (!normalised) {
    ctx.addIssue({ code: "custom", message: "invalid_kenyan_phone" });
    return z.NEVER;
  }
  return normalised;
});

export const isoDateSchema = z.iso.date();
