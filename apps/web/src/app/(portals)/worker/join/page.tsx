import { getTranslations } from "next-intl/server";
import { JoinForm } from "./join-form";

export async function generateMetadata() {
  const t = await getTranslations("portals.join");
  return { title: t("title") };
}

/** Opened from a labourer's invitation SMS: create the account with a PIN, or accept if signed in. */
export default async function WorkerJoinPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await searchParams;
  const value = Array.isArray(token) ? token[0] : token;
  return <JoinForm token={value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null} />;
}
