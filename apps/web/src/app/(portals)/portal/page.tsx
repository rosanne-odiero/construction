import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { CalendarDays, Flag, MapPin } from "lucide-react";
import { countyName } from "@pm-buddy/types";
import { clientProjectsResponseSchema } from "@pm-buddy/validation";
import { LiveUnavailable } from "@/components/projects/live-state";
import { ProjectStatusBadge } from "@/components/projects/project-status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCalendarDate, formatKES } from "@/lib/format";
import { loadLive, requirePortal } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("portals");
  return { title: t("clientName") };
}

/** Client portal home: the projects the client is assigned to (live, never mock data). */
export default async function ClientPortalPage() {
  const session = await requirePortal("client", "/portal");
  if (!session) return <LiveUnavailable retryHref="/portal" />;
  const result = await loadLive("/portal/client/projects", clientProjectsResponseSchema, "/portal");
  if (!result.ok) return <LiveUnavailable retryHref="/portal" />;
  const t = await getTranslations("portals.client");
  const { projects, company } = result.data;
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground">{t("description", { company: company.name })}</p>
      </div>
      {projects.length ? (
        <ul className="grid gap-4 md:grid-cols-2">
          {projects.map((project) => (
            <li key={project.id}>
              <Card className="h-full">
                <CardHeader>
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="min-w-0 text-lg">
                      <h2>{project.name}</h2>
                    </CardTitle>
                    <ProjectStatusBadge status={project.status} />
                  </div>
                  <p className="font-mono text-xs text-muted-foreground">{project.code}</p>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  {project.town || project.county ? (
                    <p className="flex items-center gap-2">
                      <MapPin className="size-4 text-muted-foreground" aria-hidden />
                      {[project.town, project.county ? countyName(project.county) : null]
                        .filter(Boolean)
                        .join(", ")}
                    </p>
                  ) : null}
                  {project.endDate ? (
                    <p className="flex items-center gap-2">
                      <CalendarDays className="size-4 text-muted-foreground" aria-hidden />
                      {t("completion", { date: formatCalendarDate(project.endDate) })}
                    </p>
                  ) : null}
                  <p className="flex items-center gap-2">
                    <Flag className="size-4 text-muted-foreground" aria-hidden />
                    {t("milestones", project.milestones)}
                  </p>
                  {project.contractSumMinor !== null ? (
                    <p>{t("contractSum", { amount: formatKES(project.contractSumMinor) })}</p>
                  ) : null}
                </CardContent>
                <CardFooter>
                  <Button asChild>
                    <Link href={`/portal/projects/${project.id}`}>{t("open")}</Link>
                  </Button>
                </CardFooter>
              </Card>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-xl border border-dashed p-6 text-center">{t("empty")}</p>
      )}
      <p className="rounded-md border bg-muted p-3 text-sm">{t("coming")}</p>
    </div>
  );
}
