import { LOCALES, type Locale } from "@pm-buddy/types";
import en from "./messages/en.json" with { type: "json" };
import sw from "./messages/sw.json" with { type: "json" };

export { LOCALES, type Locale };

/** The message tree. English is the reference catalogue; Kiswahili must have identical keys. */
export type Messages = typeof en;

export const DEFAULT_LOCALE: Locale = "en";

/** The EN and SW catalogues. `pnpm --filter @pm-buddy/i18n i18n:check` keeps them in step. */
export const catalogues: Readonly<Record<Locale, Messages>> = { en, sw };

export const isLocale = (value: string | undefined): value is Locale =>
  value !== undefined && (LOCALES as readonly string[]).includes(value);

/** Messages for a locale, falling back to English for anything that isn't a supported locale. */
export function messages(locale: string | undefined): Messages {
  return catalogues[isLocale(locale) ? locale : DEFAULT_LOCALE];
}
