import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { messages } from "@pm-buddy/i18n";
import { defaultLocale, isLocale, LOCALE_COOKIE } from "./config";

export default getRequestConfig(async () => {
  const cookieLocale = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale = isLocale(cookieLocale) ? cookieLocale : defaultLocale;

  return {
    locale,
    timeZone: "Africa/Nairobi",
    messages: messages(locale),
  };
});
