import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { checklistTemplateResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { TemplateDetail } from "@/components/quality/templates";
import { loadLive, requireSession, serverApi } from "@/lib/server-api";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata({ params }: { params: Promise<{ templateId: string }> }) {
  const { templateId } = await params;
  const t = await getTranslations("quality");
  if (!UUID.test(templateId)) return { title: t("templates.title") };
  const detail = await serverApi(
    `/quality/templates/${templateId}`,
    checklistTemplateResponseSchema,
  );
  return { title: detail.ok ? detail.data.template.name : t("templates.title") };
}

/** One checklist template version (D6.1). */
export default async function TemplatePage({
  params,
}: {
  params: Promise<{ templateId: string }>;
}) {
  const { templateId } = await params;
  if (!UUID.test(templateId)) notFound();
  const path = `/quality/templates/${templateId}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await loadLive(path, checklistTemplateResponseSchema, path);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("quality");
  const { template } = result.data;
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <span className="flex flex-wrap items-center gap-2">
            <Link href="/quality" className="hover:underline">
              {t("title")}
            </Link>
            <span aria-hidden>/</span>
            <Link href="/quality/templates" className="hover:underline">
              {t("templates.title")}
            </Link>
          </span>
        }
        title={template.name}
        description={t(`category.${template.category}`)}
      />
      <TemplateDetail key={template.id} data={result.data} />
    </div>
  );
}
