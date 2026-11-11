import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { isProjectReadOnly } from "@pm-buddy/domain";
import { geofenceHistoryResponseSchema, sitesResponseSchema } from "@pm-buddy/validation";
import { GeofenceMap } from "@/components/maps/geofence-map";
import { LiveUnavailable } from "@/components/projects/live-state";
import { SiteDetailsForm } from "@/components/projects/site-details-form";
import { SiteEditor } from "@/components/projects/site-editor";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatArea, formatDateTime, formatLength } from "@/lib/format";
import { loadLive } from "@/lib/server-api";
import { loadSitePage, SitePageHeader } from "../site-page-shell";

export async function generateMetadata() {
  const t = await getTranslations("sites");
  return { title: t("title") };
}

export default async function SitePage({
  params,
}: {
  params: Promise<{ projectId: string; siteId: string }>;
}) {
  const { projectId, siteId } = await params;
  const path = `/projects/${projectId}/sites/${siteId}`;
  const loaded = await loadSitePage(projectId, path);
  if (!loaded.ok) return loaded.element;
  const { detail } = loaded;
  const sites = await loadLive(`/projects/${projectId}/sites`, sitesResponseSchema, path);
  if (!sites.ok) return <LiveUnavailable retryHref={path} />;
  const site = sites.data.sites.find((candidate) => candidate.id === siteId);
  if (!site) notFound();
  const history = await loadLive(
    `/projects/${projectId}/sites/${siteId}/geofences`,
    geofenceHistoryResponseSchema,
    path,
  );
  if (!history.ok) return <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("sites");
  const tKind = await getTranslations("sites.kind");
  const canManage =
    detail.permissions.includes("projects.manage") && !isProjectReadOnly(detail.project.status);
  const centre =
    site.geofence.geofence.kind === "radius"
      ? site.geofence.geofence.center
      : site.geofence.geofence.vertices[0]!;

  return (
    <div className="space-y-6">
      <SitePageHeader
        detail={detail}
        title={canManage ? t("editor.editTitle", { name: site.name }) : site.name}
      />
      {canManage ? (
        <>
          <SiteDetailsForm projectId={projectId} site={site} />
          <SiteEditor projectId={projectId} site={site} fallbackCenter={centre} />
        </>
      ) : (
        <GeofenceMap
          label={t("map")}
          fences={[{ id: site.id, name: site.name, geofence: site.geofence.geofence }]}
        />
      )}
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("historyTitle")}</h2>
          </CardTitle>
          <p className="text-sm text-muted-foreground">{t("historyHint")}</p>
        </CardHeader>
        <CardContent>
          <ol className="space-y-2 text-sm">
            {history.data.versions.map((version) => (
              <li key={version.id} className="flex flex-wrap gap-x-4 gap-y-1 rounded-md border p-2">
                <span className="font-medium">{t("version", { version: version.version })}</span>
                <span>{tKind(version.geofence.kind)}</span>
                <span className="tabular-nums">{formatArea(version.areaM2)}</span>
                <span className="tabular-nums">{formatLength(version.perimeterM)}</span>
                <span className="text-muted-foreground tabular-nums">
                  {t("effectiveFrom", { date: formatDateTime(version.effectiveFrom) })}
                </span>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
