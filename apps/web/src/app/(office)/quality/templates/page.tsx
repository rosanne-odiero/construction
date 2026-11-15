import Link from "next/link";
import { getTranslations } from "next-intl/server";
import {
  checklistTemplatesResponseSchema,
  qualitySettingsResponseSchema,
} from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { QualitySettingsCard, TemplatesPanel } from "@/components/quality/templates";
import { loadLive, requireSession } from "@/lib/server-api";

const PATH = "/quality/templates";

export async function generateMetadata() {
  const t = await getTranslations("quality");
  return { title: t("templates.title") };
}

/** The company's checklist templates and quality settings (D6.1). */
export default async function TemplatesPage() {
  const session = await requireSession(PATH);
  if (!session) return <LiveUnavailable retryHref={PATH} />;
  const [templates, settings] = await Promise.all([
    loadLive(PATH, checklistTemplatesResponseSchema, PATH),
    loadLive("/quality/settings", qualitySettingsResponseSchema, PATH),
  ]);
  if (!templates.ok || !settings.ok) {
    const forbidden =
      (!templates.ok && templates.status === 403) || (!settings.ok && settings.status === 403);
    return forbidden ? <LiveForbidden /> : <LiveUnavailable retryHref={PATH} />;
  }
  const t = await getTranslations("quality");
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/quality" className="hover:underline">
            {t("title")}
          </Link>
        }
        title={t("templates.title")}
        description={t("templates.pageDescription")}
      />
      <TemplatesPanel data={templates.data} />
      <QualitySettingsCard settings={settings.data.settings} />
    </div>
  );
}
