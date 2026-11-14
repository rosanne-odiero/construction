import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { CalendarDays, Coins, Flag, MapPin, Scale } from "lucide-react";
import { nairobiDate } from "@pm-buddy/domain";
import { countyName } from "@pm-buddy/types";
import { clientPortalProjectsResponseSchema } from "@pm-buddy/validation";
import { ConversionNote, Money } from "@/components/client-portal/client-shell";
import { LiveUnavailable } from "@/components/projects/live-state";
import { ProjectStatusBadge } from "@/components/projects/project-status-badge";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { loadClientPage } from "@/lib/client-portal-server";
import { formatCalendarDate } from "@/lib/format";

export async function generateMetadata() {
  const t = await getTranslations("portals");
  return { title: t("clientName") };
}

/** Client portal home: the client's assigned projects, what is owed and what waits for them. */
export default async function ClientPortalPage() {
  const page = await loadClientPage(
    "/portal",
    "/portal/client/projects",
    clientPortalProjectsResponseSchema,
  );
  if (page.kind !== "ok") return <LiveUnavailable retryHref="/portal" />;
  const t = await getTranslations("clientPortal.home");
  const { projects, company, display } = page.data;
  const today = nairobiDate();
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
          <p className="text-muted-foreground">{t("description", { company: company.name })}</p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/portal/settings">
            <Coins aria-hidden /> {t("settings")}
          </Link>
        </Button>
      </div>
      <ConversionNote display={display} />
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
                  <div className="flex items-start gap-2">
                    <Scale className="mt-0.5 size-4 text-muted-foreground" aria-hidden />
                    <div>
                      <p className="text-muted-foreground">{t("outstanding")}</p>
                      <Money
                        minor={project.balance.outstandingMinor}
                        display={display}
                        today={today}
                        className="font-semibold"
                      />
                      {project.balance.overdueMinor > 0 ? (
                        <StatusBadge tone="danger" className="mt-1">
                          {t("overdue")}
                        </StatusBadge>
                      ) : null}
                    </div>
                  </div>
                  {project.awaitingDecisions ? (
                    <StatusBadge tone="warning">
                      {t("awaiting", { count: project.awaitingDecisions })}
                    </StatusBadge>
                  ) : null}
                </CardContent>
                <CardFooter className="flex flex-wrap gap-2">
                  <Button asChild>
                    <Link href={`/portal/projects/${project.id}`}>{t("open")}</Link>
                  </Button>
                  <Button asChild variant="outline">
                    <Link href={`/portal/projects/${project.id}/pay`}>{t("pay")}</Link>
                  </Button>
                </CardFooter>
              </Card>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-xl border border-dashed p-6 text-center">{t("empty")}</p>
      )}
    </div>
  );
}
