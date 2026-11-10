import { DEFAULT_LOCALE, isLocale, LOCALES, type Locale } from "@pm-buddy/i18n";

export { isLocale, type Locale };
export const locales = LOCALES;
export const defaultLocale: Locale = DEFAULT_LOCALE;
export const LOCALE_COOKIE = "NEXT_LOCALE";
