import { getTranslations } from "next-intl/server";
import { storesSettingsResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StoresSettingsForm } from "@/components/stores/stores-forms";
import { StoresEyebrow, StoresSubnav } from "@/components/stores/stores-subnav";
import { loadOrRedirect } from "@/lib/p2p-server";
import { requireSession } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("stores.settings");
  return { title: t("title") };
}

/** Stores settings (D5.3): the variance threshold; negative stock is never allowed. */
export default async function StoresSettingsPage() {
  const path = "/stores/settings";
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await loadOrRedirect("/stores/settings", storesSettingsResponseSchema, path);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("stores.settings");
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={<StoresEyebrow />} title={t("title")} description={t("description")} />
      <StoresSubnav current="settings" />
      <StoresSettingsForm settings={result.data} />
      <section aria-labelledby="stores-policies" className="max-w-2xl space-y-2 text-sm">
        <h2 id="stores-policies" className="text-lg font-semibold">
          {t("policies")}
        </h2>
        <p>{t("negativeStock")}</p>
        <p>{t("valuation")}</p>
        <p>{t("reorderHint")}</p>
      </section>
    </div>
  );
}
