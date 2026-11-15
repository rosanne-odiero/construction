import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { nairobiDate } from "@pm-buddy/domain";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden } from "@/components/projects/live-state";
import { FuelForm } from "@/components/plant/site-forms";
import { formatTime } from "@/lib/format";
import { calendarInput } from "@/lib/project-input";
import { loadPlantFormPage, PlantEyebrow, UUID } from "../page-shell";

export async function generateMetadata() {
  const t = await getTranslations("plant");
  return { title: t("fuel.title") };
}

/** Record fuel issued to plant (D8.3), laid out for a phone on site. */
export default async function PlantFuelPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  if (!UUID.test(projectId)) notFound();
  const { plantId } = await searchParams;
  const page = await loadPlantFormPage(`/projects/${projectId}/plant/fuel`, projectId);
  if (!page.ok) return page.element;
  if (!page.plant.permissions.canRecordFuel) return <LiveForbidden />;
  const t = await getTranslations("plant");
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<PlantEyebrow projectId={projectId} code={page.code} />}
        title={t("fuel.title")}
        description={t("fuel.hint")}
      />
      <FuelForm
        projectId={projectId}
        items={page.plant.items}
        initialPlantId={typeof plantId === "string" ? plantId : null}
        today={calendarInput(nairobiDate())}
        now={formatTime(new Date())}
      />
    </div>
  );
}
