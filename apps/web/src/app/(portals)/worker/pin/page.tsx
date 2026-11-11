import { getTranslations } from "next-intl/server";
import { PinForm } from "./pin-form";

export async function generateMetadata() {
  const t = await getTranslations("portals.pin");
  return { title: t("title") };
}

/** Forgotten PIN: request an SMS link, then (with its token) choose a new PIN. */
export default async function WorkerPinPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await searchParams;
  const value = Array.isArray(token) ? token[0] : token;
  return <PinForm token={value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null} />;
}
