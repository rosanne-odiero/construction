import { getTranslations } from "next-intl/server";
import { Banknote, CalendarCheck, MapPin } from "lucide-react";
import { countyName } from "@pm-buddy/types";
import { workerPortalResponseSchema } from "@pm-buddy/validation";
import { LiveUnavailable } from "@/components/projects/live-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { loadLive, requirePortal } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("portals");
  return { title: t("workerName") };
}

/** Labourer portal home: where they are assigned; attendance and pay arrive with Phases 3–4. */
export default async function WorkerPortalPage() {
  const session = await requirePortal("worker", "/worker");
  if (!session) return <LiveUnavailable retryHref="/worker" />;
  const result = await loadLive("/portal/worker", workerPortalResponseSchema, "/worker");
  if (!result.ok) return <LiveUnavailable retryHref="/worker" />;
  const t = await getTranslations("portals.worker");
  const { displayName, company, assignments } = result.data;
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {t("greeting", { name: displayName })}
        </h1>
        <p className="text-muted-foreground">{t("company", { company: company.name })}</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("sitesTitle")}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {assignments.length ? (
            <ul className="space-y-4">
              {assignments.map(({ project, sites }) => (
                <li key={project.id} className="space-y-2">
                  <h3 className="font-medium">
                    {project.name}{" "}
                    <span className="font-mono text-xs text-muted-foreground">{project.code}</span>
                  </h3>
                  {sites.length ? (
                    <ul className="space-y-2">
                      {sites.map((site) => (
                        <li key={site.id} className="flex items-start gap-2 text-sm">
                          <MapPin
                            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                            aria-hidden
                          />
                          <span>
                            <span className="block font-medium">{site.name}</span>
                            <span className="text-muted-foreground">
                              {site.address ??
                                [project.town, project.county ? countyName(project.county) : null]
                                  .filter(Boolean)
                                  .join(", ")}
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground">{t("noSitesYet")}</p>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm">{t("noAssignments")}</p>
          )}
        </CardContent>
      </Card>
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CalendarCheck className="size-5 text-muted-foreground" aria-hidden />
              <h2>{t("attendanceTitle")}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">{t("attendanceSoon")}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Banknote className="size-5 text-muted-foreground" aria-hidden />
              <h2>{t("payTitle")}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">{t("paySoon")}</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
