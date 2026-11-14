import { getTranslations } from "next-intl/server";
import { SupplierJoinForm } from "./join-form";

export async function generateMetadata() {
  const t = await getTranslations("supplierPortal.join");
  return { title: t("title") };
}

/** Opened from a supplier contact's invitation: create an account or sign in, then accept. */
export default async function SupplierJoinPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await searchParams;
  const value = Array.isArray(token) ? token[0] : token;
  return <SupplierJoinForm token={value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null} />;
}
