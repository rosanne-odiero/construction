import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { CalendarDays, MapPin, Search } from "lucide-react";
import { countyName, PROJECT_STATUSES, type County } from "@pm-buddy/types";
import { projectListQuerySchema, projectsResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { NewProjectButton } from "@/components/projects/project-form";
import { ProjectStatusBadge } from "@/components/projects/project-status-badge";
import { LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatCalendarDate, formatKES } from "@/lib/format";
import { loadLive, requireSession } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("liveProjects");
  return { title: t("title") };
}

const selectClass =
  "h-9 rounded-md border border-input bg-background px-3 text-sm shadow-xs focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 outline-none";

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslations("liveProjects");
  const tStatus = await getTranslations("projectStatus");
  const raw = await searchParams;
  const filters = projectListQuerySchema.safeParse({
    status: typeof raw.status === "string" && raw.status ? raw.status : undefined,
    search: typeof raw.search === "string" && raw.search.trim() ? raw.search.trim() : undefined,
  });
  const query = filters.success ? filters.data : {};
  const params = new URLSearchParams(
    Object.entries(query).filter((entry): entry is [string, string] => Boolean(entry[1])),
  ).toString();
  const path = `/projects${params ? `?${params}` : ""}`;

  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await loadLive(path, projectsResponseSchema, path);
  if (!result.ok) return <LiveUnavailable retryHref={path} />;
  const { projects } = result.data;
  const canCreate = session.company.permissions.includes("projects.create");
  const filtered = Boolean(query.status || query.search);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<StatusBadge tone="info">{t("live")}</StatusBadge>}
        title={t("title")}
        description={t("description", { company: session.company.name })}
        actions={canCreate ? <NewProjectButton /> : null}
      />
      {/* Keyed by the query so uncontrolled fields reset after "Clear filters" or back/forward. */}
      <form
        key={`${query.search ?? ""}|${query.status ?? ""}`}
        method="get"
        action="/projects"
        className="flex flex-wrap items-end gap-3"
        role="search"
      >
        <div className="min-w-0 flex-1 space-y-1.5 sm:max-w-xs">
          <label htmlFor="project-search" className="text-sm font-medium">
            {t("searchLabel")}
          </label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              id="project-search"
              name="search"
              defaultValue={query.search ?? ""}
              placeholder={t("searchPlaceholder")}
              maxLength={100}
              className="pl-8"
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="project-status" className="block text-sm font-medium">
            {t("statusLabel")}
          </label>
          <select
            id="project-status"
            name="status"
            defaultValue={query.status ?? ""}
            className={selectClass}
          >
            <option value="">{t("allStatuses")}</option>
            {PROJECT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {tStatus(status)}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" variant="secondary">
          {t("apply")}
        </Button>
        {filtered ? (
          <Button asChild variant="ghost">
            <Link href="/projects">{t("clear")}</Link>
          </Button>
        ) : null}
      </form>
      <p className="text-sm text-muted-foreground" role="status">
        {t("count", { count: projects.length })}
      </p>
      {projects.length === 0 ? (
        <div className="rounded-xl border border-dashed p-8 text-center">
          <p className="font-medium">{filtered ? t("noMatches") : t("empty")}</p>
          {!filtered ? (
            <p className="mt-1 text-sm text-muted-foreground">
              {canCreate ? t("emptyHint") : t("emptyNoCreate")}
            </p>
          ) : null}
        </div>
      ) : (
        <ul className="grid gap-4 lg:grid-cols-2">
          {projects.map((project) => (
            <li key={project.id}>
              <Card className="h-full">
                <CardHeader>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <CardTitle className="text-lg">
                        <h2>
                          <Link href={`/projects/${project.id}`} className="hover:underline">
                            {project.name}
                          </Link>
                        </h2>
                      </CardTitle>
                      <CardDescription className="font-mono text-xs">
                        {project.code}
                      </CardDescription>
                    </div>
                    <ProjectStatusBadge status={project.status} />
                  </div>
                </CardHeader>
                <CardContent>
                  <dl className="grid grid-cols-1 gap-x-4 gap-y-3 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="text-muted-foreground">{t("client")}</dt>
                      <dd className="truncate font-medium">{project.clientName ?? t("notSet")}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">{t("contractSum")}</dt>
                      <dd className="font-medium tabular-nums">
                        {project.contractSumMinor === null
                          ? t("notSet")
                          : formatKES(project.contractSumMinor)}
                      </dd>
                    </div>
                    <div>
                      <dt className="flex items-center gap-1.5 text-muted-foreground">
                        <MapPin className="size-3.5" aria-hidden /> {t("location")}
                      </dt>
                      <dd>
                        {[
                          project.town,
                          project.county ? countyName(project.county as County) : null,
                        ]
                          .filter(Boolean)
                          .join(", ") || t("notSet")}
                      </dd>
                    </div>
                    <div>
                      <dt className="flex items-center gap-1.5 text-muted-foreground">
                        <CalendarDays className="size-3.5" aria-hidden /> {t("dates")}
                      </dt>
                      <dd className="tabular-nums">
                        {project.startDate && project.endDate
                          ? `${formatCalendarDate(project.startDate)} – ${formatCalendarDate(project.endDate)}`
                          : t("notSet")}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">{t("progress")}</dt>
                      <dd className="text-muted-foreground">{t("unavailable")}</dd>
                    </div>
                  </dl>
                </CardContent>
                <CardFooter>
                  <Button asChild size="sm">
                    <Link href={`/projects/${project.id}`}>
                      {t("open")}
                      <span className="sr-only">: {project.name}</span>
                    </Link>
                  </Button>
                </CardFooter>
              </Card>
            </li>
          ))}
        </ul>
      )}
      <p className="text-sm text-muted-foreground">
        <Link href="/prototype/projects" className="underline underline-offset-4">
          {t("prototypeLink")}
        </Link>
      </p>
    </div>
  );
}
