import type { Locale } from "@pm-buddy/types";
import { IntlMessageFormat } from "intl-messageformat";
import { catalogues, DEFAULT_LOCALE, isLocale, type Messages } from "./catalogues.js";

/**
 * Server-side ICU rendering (ARCHITECTURE §15): the API renders notification texts such as the
 * payout SMS (`payoutSms`, D4.3) at send time from immutable records, in the recipient's language.
 * The web renders its own messages with next-intl and never needs this module.
 */

type Leaves<T, Prefix extends string> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

/** Keys of the messages rendered on the server: `payoutSms.payslip.text`, … */
export type ServerMessageKey = Leaves<Messages["payoutSms"], "payoutSms.">;

/** Already formatted text (amounts, dates, names) and plain numbers for plural counts. */
export type ServerMessageValues = Readonly<Record<string, string | number>>;

const compiled = new Map<string, IntlMessageFormat>();

function lookup(locale: Locale, key: string): string {
  let node: unknown = catalogues[locale];
  for (const part of key.split(".")) {
    node =
      typeof node === "object" && node !== null ? (node as Record<string, unknown>)[part] : null;
  }
  if (typeof node !== "string") throw new Error(`Unknown server message: ${key}`);
  return node;
}

/**
 * Renders the server message `key` in `locale` (English for anything that isn't a supported
 * locale) with `values`. A missing value throws instead of sending a text with a gap; compiled
 * messages are cached per locale and key.
 */
export function formatServerMessage(
  locale: string | undefined,
  key: ServerMessageKey,
  values: ServerMessageValues = {},
): string {
  const resolved = isLocale(locale) ? locale : DEFAULT_LOCALE;
  const cacheKey = `${resolved}:${key}`;
  let format = compiled.get(cacheKey);
  if (!format) {
    format = new IntlMessageFormat(lookup(resolved, key), resolved);
    compiled.set(cacheKey, format);
  }
  const output = format.format<string>(values);
  return Array.isArray(output) ? output.join("") : String(output);
}
