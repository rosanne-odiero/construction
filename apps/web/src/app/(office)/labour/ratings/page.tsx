import Link from "next/link";
import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { addCalendarDays } from "@pm-buddy/domain";
import { RATING_CRITERIA } from "@pm-buddy/types";
import { ratingProjectsResponseSchema, ratingSheetResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { selectClass } from "@/components/labour/action-dialog";
import { localName } from "@/components/labour/labour-badges";
import { LabourNav } from "@/components/labour/labour-nav";
import { RateWorkerButton } from "@/components/labour/rating-dialog";
import { RatingStars } from "@/components/labour/rating-stars";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { dateParam, uuidParam } from "@/lib/attendance";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { calendarInput } from "@/lib/project-input";
import { defaultRatingProject, formatAverage, ratingsHref } from "@/lib/ratings";
import { loadLive, requireSession } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("labourLive.ratings");
  return { title: t("title") };
}

/**
 * Worker ratings (D3.5): one project day, listing the workers that attendance records as working with
 * their rating. The filter is a plain GET form (works without JavaScript); rating opens a dialog.
 */
export default async function RatingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const projectParam = uuidParam(raw.project);
  const typedDate = dateParam(raw.date);
  const path = ratingsHref({ project: projectParam, date: typedDate });

  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const options = await loadLive("/labour/ratings/projects", ratingProjectsResponseSchema, path);
  if (!options.ok)
    return options.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("labourLive.ratings");
  const tLive = await getTranslations("labourLive");
  const tStatus = await getTranslations("attendanceLive.status");
  const locale = await getLocale();
  const { projects, today, window } = options.data;
  const projectId = projectParam ?? defaultRatingProject(projects)?.id;
  const header = (
    <PageHeader
      eyebrow={<StatusBadge tone="info">{tLive("live")}</StatusBadge>}
      title={t("title")}
      description={t("description")}
    />
  );
  if (!projectId)
    return (
      <div className="space-y-6">
        {header}
        <LabourNav current="ratings" />
        <p
          role="status"
          className="rounded-lg border p-6 text-center text-sm text-muted-foreground"
        >
          {t("noProjects")}
        </p>
      </div>
    );
  // Nothing in the future can be rated; a typed DD/MM/YYYY date becomes the canonical ISO address.
  const date = typedDate && typedDate <= today ? typedDate : today;
  if (!projectParam || (raw.date !== undefined && raw.date !== date))
    redirect(ratingsHref({ project: projectId, date }));

  const sheet = await loadLive(
    `/labour/projects/${projectId}/ratings?date=${date}`,
    ratingSheetResponseSchema,
    path,
  );
  if (!sheet.ok)
    return sheet.status === 403 || sheet.status === 404 ? (
      <LiveForbidden />
    ) : (
      <LiveUnavailable retryHref={path} />
    );
  const data = sheet.data;
  const previous = addCalendarDays(date, -1);
  const next = addCalendarDays(date, 1);
  const projectName = `${data.project.code} ${data.project.name}`;
  const caption = t("table.caption", { project: projectName, date: formatCalendarDate(data.date) });

  type Worker = (typeof data.workers)[number];
  type Rating = NonNullable<Worker["rating"]>;
  const identity = (labourer: Worker["labourer"]) => (
    <>
      <span className="block font-medium">{labourer.fullName}</span>
      <span className="block text-xs text-muted-foreground">
        <span className="font-mono">{labourer.workerNo}</span> · {localName(labourer.trade, locale)}
      </span>
    </>
  );
  const details = (rating: Rating) => (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <RatingStars
          value={rating.average}
          label={t("average", { average: formatAverage(rating.average, locale) })}
        />
        <span className="text-sm tabular-nums">{formatAverage(rating.average, locale)}</span>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 text-xs text-muted-foreground">
        {RATING_CRITERIA.map((criterion) => (
          <div key={criterion} className="flex justify-between gap-2">
            <dt>{t(`criteria.${criterion}`)}</dt>
            <dd className="tabular-nums">{rating.scores[criterion]}</dd>
          </div>
        ))}
      </dl>
      {rating.comment ? <p className="max-w-xs text-xs">“{rating.comment}”</p> : null}
    </div>
  );
  const given = (rating: Rating) =>
    `${formatDateTime(rating.ratedAt)}${
      rating.changedAt ? ` · ${t("changed", { time: formatDateTime(rating.changedAt) })}` : ""
    }`;
  const action = ({ labourer, rating }: Worker) =>
    data.canRate && (!rating || rating.canChange) ? (
      <RateWorkerButton
        projectId={data.project.id}
        projectName={projectName}
        date={data.date}
        worker={labourer}
        rating={rating}
      />
    ) : null;

  return (
    <div className="space-y-6">
      {header}
      <LabourNav current="ratings" />

      <form
        method="get"
        action="/labour/ratings"
        aria-label={t("filters.label")}
        className="flex flex-wrap items-end gap-3 rounded-lg border p-3"
      >
        <div className="space-y-1.5">
          <label htmlFor="ratings-project" className="block text-sm font-medium">
            {t("filters.project")}
          </label>
          <select
            id="ratings-project"
            name="project"
            defaultValue={data.project.id}
            className={selectClass}
          >
            {(projects.some((entry) => entry.id === data.project.id)
              ? projects
              : [data.project, ...projects]
            ).map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.code} · {entry.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="ratings-date" className="block text-sm font-medium">
            {t("filters.date")}
          </label>
          <Input
            id="ratings-date"
            name="date"
            defaultValue={calendarInput(date)}
            placeholder="DD/MM/YYYY"
            inputMode="numeric"
            className="w-36 tabular-nums"
            aria-describedby="ratings-window"
          />
        </div>
        <Button type="submit" variant="outline">
          {t("filters.show")}
        </Button>
        <div className="flex gap-1 sm:ml-auto">
          <Button asChild variant="ghost" size="sm">
            <Link href={ratingsHref({ project: data.project.id, date: previous })}>
              <ChevronLeft aria-hidden /> {formatCalendarDate(previous)}
            </Link>
          </Button>
          {next <= today ? (
            <Button asChild variant="ghost" size="sm">
              <Link href={ratingsHref({ project: data.project.id, date: next })}>
                {formatCalendarDate(next)} <ChevronRight aria-hidden />
              </Link>
            </Button>
          ) : null}
        </div>
        <p id="ratings-window" className="basis-full text-sm text-muted-foreground">
          {t("filters.window", {
            from: formatCalendarDate(window.from),
            to: formatCalendarDate(window.to),
          })}
        </p>
      </form>

      {data.project.readOnly || !data.canRate ? (
        <p role="status" className="rounded-lg border border-dashed p-3 text-sm">
          {data.project.readOnly ? t("readOnly") : t("closed")}
        </p>
      ) : null}

      {/* Phones and tablets: one card per worker with its Rate button in reach; the table from lg. */}
      {data.workers.length ? (
        <ul aria-label={caption} className="space-y-3 lg:hidden">
          {data.workers.map((worker) => (
            <li key={worker.labourer.id} className="space-y-3 rounded-lg border p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  {identity(worker.labourer)}
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {tStatus(worker.attendance)} · {worker.sites.join(", ")}
                  </span>
                </div>
                {action(worker)}
              </div>
              {worker.rating ? (
                <div className="space-y-2 border-t pt-3">
                  {details(worker.rating)}
                  <p className="text-xs text-muted-foreground">
                    {t("table.ratedBy")} {worker.rating.ratedBy.displayName} ·{" "}
                    {given(worker.rating)}
                  </p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">{t("notRated")}</p>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-lg border py-10 text-center text-sm text-muted-foreground lg:hidden">
          {t("table.empty")}
        </p>
      )}

      <div className="relative hidden overflow-x-auto rounded-lg border lg:block">
        <Table>
          <TableCaption className="sr-only">{caption}</TableCaption>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead>{t("table.worker")}</TableHead>
              <TableHead>{t("table.attendance")}</TableHead>
              <TableHead>{t("table.rating")}</TableHead>
              <TableHead>{t("table.ratedBy")}</TableHead>
              <TableHead>
                <span className="sr-only">{t("table.actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.workers.map((worker) => (
              <TableRow key={worker.labourer.id}>
                <TableCell>{identity(worker.labourer)}</TableCell>
                <TableCell className="text-sm">
                  {tStatus(worker.attendance)}
                  <span className="block text-xs text-muted-foreground">
                    {worker.sites.join(", ")}
                  </span>
                </TableCell>
                <TableCell>
                  {worker.rating ? (
                    details(worker.rating)
                  ) : (
                    <span className="text-sm text-muted-foreground">{t("notRated")}</span>
                  )}
                </TableCell>
                <TableCell className="text-sm">
                  {worker.rating ? (
                    <>
                      {worker.rating.ratedBy.displayName}
                      <span className="block text-xs text-muted-foreground">
                        {given(worker.rating)}
                      </span>
                    </>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell className="text-right">{action(worker)}</TableCell>
              </TableRow>
            ))}
            {data.workers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                  {t("table.empty")}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
