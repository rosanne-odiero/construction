import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { MapPin, Plus } from "lucide-react";
import { sitesResponseSchema, type Project } from "@pm-buddy/validation";
import { GeofenceMap } from "@/components/maps/geofence-map";
import { LiveUnavailable } from "@/components/projects/live-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { formatArea, formatDateTime, formatLength } from "@/lib/format";
import { loadLive } from "@/lib/server-api";

export async function SitesTab({
  project,
  canManage,
  returnTo,
}: {
  project: Project;
  canManage: boolean;
  returnTo: string;
}) {
  const t = await getTranslations("sites");
  const result = await loadLive(`/projects/${project.id}/sites`, sitesResponseSchema, returnTo);
  if (!result.ok) return <LiveUnavailable retryHref={returnTo} />;
  const { sites } = result.data;

  return (
    <section aria-labelledby="sites-heading" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h2 id="sites-heading" className="text-lg font-semibold">
            {t("title")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>
        {canManage ? (
          <Button asChild>
            <Link href={`/projects/${project.id}/sites/new`}>
              <Plus aria-hidden /> {t("addSite")}
            </Link>
          </Button>
        ) : null}
      </div>
      {sites.length ? (
        <>
          <GeofenceMap
            label={t("map")}
            fences={sites.map((site) => ({
              id: site.id,
              name: site.name,
              geofence: site.geofence.geofence,
            }))}
          />
          <ul className="grid gap-4 lg:grid-cols-2">
            {sites.map((site) => {
              const shape = site.geofence.geofence;
              return (
                <li key={site.id}>
                  <Card className="h-full">
                    <CardHeader>
                      <CardTitle>
                        <h3 className="flex items-center gap-2">
                          <MapPin className="size-4 text-muted-foreground" aria-hidden />
                          {site.name}
                        </h3>
                      </CardTitle>
                      <p className="text-sm text-muted-foreground">
                        {site.address ?? t("noAddress")}
                      </p>
                    </CardHeader>
                    <CardContent>
                      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                        <div>
                          <dt className="text-muted-foreground">{t("geofence")}</dt>
                          <dd>
                            {shape.kind === "radius"
                              ? t("radiusValue", { radius: shape.radiusM })
                              : t("polygonValue", { count: shape.vertices.length })}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">{t("versionLabel")}</dt>
                          <dd>{t("version", { version: site.geofence.version })}</dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">{t("area")}</dt>
                          <dd className="tabular-nums">{formatArea(site.geofence.areaM2)}</dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">{t("perimeter")}</dt>
                          <dd className="tabular-nums">{formatLength(site.geofence.perimeterM)}</dd>
                        </div>
                        <div className="col-span-2">
                          <dt className="text-muted-foreground">{t("effectiveFromLabel")}</dt>
                          <dd className="tabular-nums">
                            {formatDateTime(site.geofence.effectiveFrom)}
                          </dd>
                        </div>
                      </dl>
                    </CardContent>
                    <CardFooter>
                      <Button asChild size="sm" variant="outline">
                        <Link href={`/projects/${project.id}/sites/${site.id}`}>
                          {canManage ? t("editGeofence") : t("viewSite")}
                          <span className="sr-only">: {site.name}</span>
                        </Link>
                      </Button>
                    </CardFooter>
                  </Card>
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <div className="rounded-xl border border-dashed p-8 text-center">
          <p className="font-medium">{t("empty")}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {canManage ? t("emptyHint") : t("emptyViewer")}
          </p>
        </div>
      )}
    </section>
  );
}
