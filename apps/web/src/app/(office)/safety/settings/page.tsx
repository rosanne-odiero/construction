import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { safetySettingsResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { SafetySettingsForm } from "@/components/safety/settings-form";
import { loadLive, requireSession } from "@/lib/server-api";

const PATH = "/safety/settings";

export async function generateMetadata() {
  const t = await getTranslations("safety");
  return { title: t("settings.title") };
}

/** The company's health and safety settings (D8.2; config.manage to change). */
export default async function SafetySettingsPage() {
  const session = await requireSession(PATH);
  if (!session) return <LiveUnavailable retryHref={PATH} />;
  const result = await loadLive("/safety/settings", safetySettingsResponseSchema, PATH);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={PATH} />;
  const t = await getTranslations("safety");
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/safety" className="hover:underline">
            {t("title")}
          </Link>
        }
        title={t("settings.title")}
        description={t("settings.description")}
      />
      <SafetySettingsForm key={result.data.settings.version} settings={result.data.settings} />
    </div>
  );
}
