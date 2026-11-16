import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { nairobiDate } from "@pm-buddy/domain";
import {
  attendanceOverviewResponseSchema,
  captureQueueResponseSchema,
  musterResponseSchema,
  siteDevicesResponseSchema,
  workerCardsResponseSchema,
} from "@pm-buddy/validation";
import { AttendanceNav } from "@/components/attendance/attendance-nav";
import {
  CaptureReview,
  CaptureRevoke,
  WorkerCardIssue,
} from "@/components/attendance/capture-actions";
import { selectClass } from "@/components/labour/action-dialog";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import { uuidParam } from "@/lib/attendance";
import { loadLive, requireSession, serverApi } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("attendanceLive.capture");
  return { title: t("title") };
}

export default async function CapturePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const path = "/attendance/capture";
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const overview = await loadLive("/attendance/overview", attendanceOverviewResponseSchema, path);
  if (!overview.ok)
    return overview.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const raw = await searchParams;
  const selected = uuidParam(raw.project) ?? overview.data.projects[0]?.id;
  const project = overview.data.projects.find((item) => item.id === selected);
  if (selected && !project) return <LiveForbidden />;
  const t = await getTranslations("attendanceLive.capture");
  const common = await getTranslations("attendanceLive.common");
  const before = uuidParam(raw.before);
  const canManageCards = session.company.permissions.includes("labour.manage");
  const [queue, muster, cards, devices] = await Promise.all([
    project
      ? serverApi(
          `/attendance/capture/events?projectId=${project.id}${before ? `&before=${before}` : ""}`,
          captureQueueResponseSchema,
        )
      : null,
    project?.sites[0] && canManageCards
      ? serverApi(
          `/attendance/projects/${project.id}/muster?siteId=${project.sites[0].id}&date=${nairobiDate()}`,
          musterResponseSchema,
        )
      : null,
    project && canManageCards
      ? serverApi(`/attendance/capture/cards?projectId=${project.id}`, workerCardsResponseSchema)
      : null,
    session.company.permissions.some(
      (permission) => permission === "attendance.record" || permission === "config.manage",
    )
      ? serverApi("/attendance/capture/devices", siteDevicesResponseSchema)
      : null,
  ]);
  if (queue && !queue.ok)
    return queue.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const workers = muster?.ok
    ? muster.data.rows.map((row) => ({ id: row.labourer.id, name: row.labourer.fullName }))
    : [];
  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("description")} />
      <AttendanceNav current="capture" project={selected} />
      <form action={path} className="flex items-end gap-3">
        <div className="space-y-1">
          <label htmlFor="capture-project" className="block text-sm font-medium">
            {common("project")}
          </label>
          <select
            id="capture-project"
            name="project"
            defaultValue={selected}
            className={selectClass}
          >
            {overview.data.projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.code} - {item.name}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" variant="outline">
          {common("show")}
        </Button>
      </form>
      {!project ? <p>{t("selectProject")}</p> : null}
      {canManageCards && project ? (
        <section className="space-y-3 rounded-lg border p-4">
          <h2 className="font-semibold">{t("cards")}</h2>
          <p className="text-sm text-muted-foreground">{t("cardHint")}</p>
          {muster && !muster.ok ? (
            <LiveUnavailable retryHref={`${path}?project=${project.id}`} />
          ) : (
            <WorkerCardIssue workers={workers} />
          )}
          {cards?.ok ? (
            <ul className="space-y-2">
              {cards.data.cards.map((card) => (
                <li
                  key={card.id}
                  className="flex flex-wrap items-center justify-between gap-2 text-sm"
                >
                  <span>
                    {workers.find((worker) => worker.id === card.labourerId)?.name ??
                      card.labourerId}{" "}
                    - {formatDateTime(card.issuedAt)}
                  </span>
                  <CaptureRevoke kind="cards" id={card.id} />
                </li>
              ))}
            </ul>
          ) : cards ? (
            <LiveUnavailable retryHref={path} />
          ) : null}
        </section>
      ) : null}
      <section aria-labelledby="capture-events" className="space-y-3">
        <h2 id="capture-events" className="font-semibold">
          {t("records")}
        </h2>
        {queue?.ok && !queue.data.events.length ? <p>{t("none")}</p> : null}
        {queue?.ok ? (
          <ul className="space-y-3">
            {queue.data.events.map((row) => (
              <li key={row.event.id} className="space-y-2 rounded-lg border p-4">
                <p className="font-medium">
                  {row.labourerName} - {t(row.event.direction)} -{" "}
                  {formatDateTime(row.event.capturedAt)}
                </p>
                <p className="text-sm">
                  {t(row.receipt.status)}. {row.recordId ? t("allocated") : t("unallocated")}
                </p>
                {row.receipt.flags.length ? (
                  <ul className="list-inside list-disc text-sm">
                    {row.receipt.flags.map((flag) => (
                      <li key={flag}>{t(flag)}</li>
                    ))}
                  </ul>
                ) : null}
                <a
                  href={`/api/v1/attendance/capture/events/${row.event.id}/photo`}
                  target="_blank"
                  rel="noreferrer"
                  className="block text-sm underline"
                >
                  {t("photo")}
                </a>
                {row.review ? (
                  <p className="text-sm">
                    {t("reviewed", { decision: t(row.review.decision) })}: {row.review.reason}
                  </p>
                ) : session.company.permissions.includes("attendance.review_anomalies") ? (
                  <CaptureReview eventId={row.event.id} name={row.labourerName} />
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {queue?.ok && queue.data.nextCursor && project ? (
          <Link
            className="text-sm underline"
            href={`${path}?project=${project.id}&before=${queue.data.nextCursor}`}
          >
            {t("next")}
          </Link>
        ) : null}
      </section>
      {devices ? (
        <section className="space-y-3 rounded-lg border p-4">
          <h2 className="font-semibold">{t("devices")}</h2>
          <p className="text-sm text-muted-foreground">{t("deviceHint")}</p>
          {devices.ok ? (
            <ul className="space-y-2">
              {devices.data.devices.map((device) => (
                <li key={device.id} className="flex items-center justify-between gap-2 text-sm">
                  <span>{device.name}</span>
                  {device.revokedAt ? (
                    <span>{t("revoked")}</span>
                  ) : (
                    <CaptureRevoke kind="devices" id={device.id} />
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <LiveUnavailable retryHref={path} />
          )}
        </section>
      ) : null}
    </div>
  );
}
