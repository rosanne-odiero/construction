import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { nairobiDate } from "@pm-buddy/domain";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden } from "@/components/projects/live-state";
import { UsageForm } from "@/components/plant/site-forms";
import { calendarInput } from "@/lib/project-input";
import { loadPlantFormPage, PlantEyebrow, UUID } from "../page-shell";

export async function generateMetadata() {
  const t = await getTranslations("plant");
  return { title: t("usage.title") };
}

/** Log a day's plant usage (D8.3), laid out for a phone on site. */
export default async function PlantUsagePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  if (!UUID.test(projectId)) notFound();
  const { plantId } = await searchParams;
  const page = await loadPlantFormPage(`/projects/${projectId}/plant/usage`, projectId);
  if (!page.ok) return page.element;
  if (!page.plant.permissions.canRecordUsage) return <LiveForbidden />;
  const t = await getTranslations("plant");
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<PlantEyebrow projectId={projectId} code={page.code} />}
        title={t("usage.title")}
        description={t("usage.hint")}
      />
      <UsageForm
        projectId={projectId}
        items={page.plant.items}
        options={page.options}
        initialPlantId={typeof plantId === "string" ? plantId : null}
        today={calendarInput(nairobiDate())}
      />
    </div>
  );
}
