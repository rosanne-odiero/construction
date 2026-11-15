import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  measurementDetailResponseSchema,
  measurementItemsResponseSchema,
  sitesResponseSchema,
} from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { MeasurementForm } from "@/components/valuations/measurement-form";
import { ValuationsEyebrow } from "@/components/valuations/valuations-nav";
import { pickParam } from "@/lib/p2p";
import { loadOrRedirect } from "@/lib/p2p-server";
import { requireSession, serverApi } from "@/lib/server-api";
import { isUuid } from "@/lib/stores";

export async function generateMetadata() {
  const t = await getTranslations("valuations.measure");
  return { title: t("title") };
}

/**
 * Record a measurement (site agent, foreman with site.diary; QS and PM with bq.edit), or correct
 * one (?corrects=<id>): the item, the quantity done to date and site photos (D6.3).
 */
export default async function MeasurePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  if (!isUuid(projectId)) notFound();
  const raw = await searchParams;
  const item = pickParam(raw, "item");
  const corrects = pickParam(raw, "corrects");
  const path = `/valuations/projects/${projectId}/measure`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [sheet, project, corrected] = await Promise.all([
    loadOrRedirect(
      `/projects/${projectId}/measurements/items?limit=100`,
      measurementItemsResponseSchema,
      path,
    ),
    serverApi(`/projects/${projectId}/sites`, sitesResponseSchema),
    corrects && isUuid(corrects)
      ? serverApi(
          `/projects/${projectId}/measurements/${corrects}`,
          measurementDetailResponseSchema,
        )
      : Promise.resolve(null),
  ]);
  if (!sheet.ok) {
    if (sheet.status === 404 || sheet.status === 400) notFound();
    return sheet.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  }
  const t = await getTranslations("valuations.measure");
  if (!sheet.data.permissions.canRecord) return <LiveForbidden />;
  const correction = corrected?.ok ? corrected.data.measurement : null;
  let initialItems = sheet.data.items;
  if (item && isUuid(item) && !initialItems.some((row) => row.item.lineageId === item)) {
    const found = await serverApi(
      `/projects/${projectId}/measurements/items?limit=200`,
      measurementItemsResponseSchema,
    );
    if (found.ok) initialItems = found.data.items;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <ValuationsEyebrow
            trail={{ href: `/valuations/projects/${projectId}?tab=measurements`, label: t("back") }}
          />
        }
        title={correction ? t("correctTitle") : t("title")}
        description={`${sheet.data.project.code} · ${sheet.data.project.name}`}
      />
      {sheet.data.bqVersion ? (
        <MeasurementForm
          projectId={projectId}
          sites={
            project.ok ? project.data.sites.map((site) => ({ id: site.id, name: site.name })) : []
          }
          initialItems={initialItems}
          preselected={item && isUuid(item) ? item : null}
          correction={
            correction
              ? {
                  id: correction.id,
                  lineageId: correction.bqItem.lineageId,
                  measuredOn: correction.measuredOn,
                  quantityToDate: correction.quantityToDate,
                }
              : null
          }
        />
      ) : (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm">{t("noBq")}</p>
      )}
    </div>
  );
}
