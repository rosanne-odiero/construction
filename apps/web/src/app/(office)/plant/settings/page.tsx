import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { plantSettingsResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { PlantSettingsForm } from "@/components/plant/settings-form";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { loadLive, requireSession } from "@/lib/server-api";

const PATH = "/plant/settings";

export async function generateMetadata() {
  const t = await getTranslations("plant");
  return { title: t("settings.title") };
}

/** The company's plant settings: fuel variance tolerance, minimum sample, hire and service. */
export default async function PlantSettingsPage() {
  const session = await requireSession(PATH);
  if (!session) return <LiveUnavailable retryHref={PATH} />;
  const result = await loadLive("/plant/settings", plantSettingsResponseSchema, PATH);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={PATH} />;
  const t = await getTranslations("plant");
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/plant" className="hover:underline">
            {t("title")}
          </Link>
        }
        title={t("settings.title")}
        description={t("settings.hint")}
      />
      <PlantSettingsForm settings={result.data.settings} />
      <p className="text-xs text-muted-foreground">{t("complianceNote")}</p>
    </div>
  );
}
