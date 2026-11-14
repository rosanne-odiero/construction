import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { measurementDetailResponseSchema, sitesResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { PhotoThumbs } from "@/components/quality/photos";
import { StatusBadge } from "@/components/status-badge";
import { ScrollTable } from "@/components/stores/stores-subnav";
import { Button } from "@/components/ui/button";
import { ValuationAction } from "@/components/valuations/valuation-action";
import { AddMeasurementPhoto } from "@/components/valuations/valuation-forms";
import { ValuationsEyebrow } from "@/components/valuations/valuations-nav";
import { formatCalendarDate, formatDateTime, formatDecimalString, formatKES } from "@/lib/format";
import { pickParam } from "@/lib/p2p";
import { loadOrRedirect } from "@/lib/p2p-server";
import { requireSession, serverApi } from "@/lib/server-api";
import { isUuid } from "@/lib/stores";
import { itemLabel, measurementStateTone } from "@/lib/valuations";

export async function generateMetadata() {
  const t = await getTranslations("valuations.measurement");
  return { title: t("metaTitle") };
}

/**
 * One measurement: quantity, value, evidence, the independent review and the item's history,
 * with approve, reject, add photo and correct where the caller may (D6.3).
 */
export default async function MeasurementPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; measurementId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId, measurementId } = await params;
  if (!isUuid(projectId) || !isUuid(measurementId)) notFound();
  const recorded = pickParam(await searchParams, "recorded") === "1";
  const path = `/valuations/projects/${projectId}/measurements/${measurementId}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [result, sites] = await Promise.all([
    loadOrRedirect(
      `/projects/${projectId}/measurements/${measurementId}`,
      measurementDetailResponseSchema,
      path,
    ),
    serverApi(`/projects/${projectId}/sites`, sitesResponseSchema),
  ]);
  if (!result.ok) {
    if (result.status === 404 || result.status === 400) notFound();
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  }
  const t = await getTranslations("valuations.measurement");
  const tState = await getTranslations("valuations.states");
  const tBasis = await getTranslations("valuations.basis");
  const { measurement, project, history } = result.data;
  const siteId = sites.ok ? sites.data.sites[0]?.id : undefined;
  const quantity =
    measurement.basis === "percent"
      ? `${formatDecimalString(measurement.quantityToDate)}%`
      : `${formatDecimalString(measurement.quantityToDate)} ${measurement.bqItem.unit ?? ""}`;
  const own = measurement.measuredBy.id === session.user.id;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <ValuationsEyebrow
            trail={{ href: `/valuations/projects/${projectId}?tab=measurements`, label: t("back") }}
          />
        }
        title={`${itemLabel(measurement.bqItem)} · ${measurement.bqItem.description}`}
        description={`${project.code} · ${project.name}`}
        actions={
          <>
            <StatusBadge tone={measurementStateTone[measurement.state]}>
              {tState(measurement.state)}
            </StatusBadge>
            {measurement.permissions.canApprove ? (
              <ValuationAction
                path={`/projects/${projectId}/measurements/${measurement.id}/approve`}
                entity="measurement"
                primary
                text={{
                  button: t("approve"),
                  title: t("approveTitle"),
                  description: t("approveDescription", {
                    value: formatKES(measurement.valueMinor),
                  }),
                  confirm: t("approve"),
                }}
              />
            ) : null}
            {measurement.permissions.canReject ? (
              <ValuationAction
                path={`/projects/${projectId}/measurements/${measurement.id}/reject`}
                entity="measurement"
                reason
                destructive
                text={{
                  button: t("reject"),
                  title: t("rejectTitle"),
                  description: t("rejectDescription"),
                  confirm: t("reject"),
                }}
              />
            ) : null}
            {measurement.permissions.canCorrect ? (
              <Button asChild size="sm" variant="outline">
                <Link href={`/valuations/projects/${projectId}/measure?corrects=${measurement.id}`}>
                  {t("correct")}
                </Link>
              </Button>
            ) : null}
          </>
        }
      />
      {recorded ? (
        <p role="status" className="rounded-xl border border-success/30 bg-success/10 p-3 text-sm">
          {t("recorded")}
        </p>
      ) : null}
      {measurement.state === "pending" && own ? (
        <p className="text-sm text-muted-foreground">{t("ownPending")}</p>
      ) : null}
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border p-4">
          <dt className="text-sm text-muted-foreground">{t("quantity")}</dt>
          <dd className="text-xl font-semibold tabular-nums">{quantity}</dd>
          <dd className="text-xs text-muted-foreground">
            {measurement.basis ? tBasis(measurement.basis) : t("legacy")}
            {measurement.itemQuantity
              ? ` · ${t("ofBq", { quantity: formatDecimalString(measurement.itemQuantity) })}`
              : ""}
          </dd>
        </div>
        <div className="rounded-xl border p-4">
          <dt className="text-sm text-muted-foreground">{t("percent")}</dt>
          <dd className="text-xl font-semibold tabular-nums">
            {measurement.percentComplete ? `${measurement.percentComplete}%` : t("unavailable")}
          </dd>
        </div>
        <div className="rounded-xl border p-4">
          <dt className="text-sm text-muted-foreground">{t("value")}</dt>
          <dd className="text-xl font-semibold tabular-nums">
            {formatKES(measurement.valueMinor)}
          </dd>
          <dd className="text-xs text-muted-foreground">{t("valueHint")}</dd>
        </div>
        <div className="rounded-xl border p-4">
          <dt className="text-sm text-muted-foreground">{t("measured")}</dt>
          <dd className="text-sm">
            {t("measuredLine", {
              name: measurement.measuredBy.displayName,
              date: formatCalendarDate(measurement.measuredOn),
            })}
          </dd>
          <dd className="text-xs text-muted-foreground">
            {t("recordedAt", { when: formatDateTime(measurement.recordedAt) })}
          </dd>
        </div>
      </dl>
      {measurement.overMeasured ? (
        <p className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm">
          {t("overMeasured", { reason: measurement.overMeasureReason ?? "" })}
        </p>
      ) : null}
      {measurement.correctionReason ? (
        <p className="text-sm">{t("correction", { reason: measurement.correctionReason })}</p>
      ) : null}
      {measurement.note ? <p className="text-sm">{t("note", { note: measurement.note })}</p> : null}
      {measurement.review ? (
        <p className="text-sm">
          {t(measurement.review.decision === "approved" ? "approvedBy" : "rejectedBy", {
            name: measurement.review.decidedBy.displayName,
            when: formatDateTime(measurement.review.decidedAt),
          })}
          {measurement.review.reason
            ? ` ${t("because", { reason: measurement.review.reason })}`
            : ""}
        </p>
      ) : null}
      <section aria-labelledby="measurement-photos" className="space-y-2">
        <h2 id="measurement-photos" className="text-lg font-semibold">
          {t("photos")}
        </h2>
        {measurement.photos.length ? (
          <PhotoThumbs projectId={projectId} photos={measurement.photos} label={t("photos")} />
        ) : (
          <p className="text-sm text-warning-foreground dark:text-warning">{t("noPhotos")}</p>
        )}
        {measurement.permissions.canAddPhotos && siteId ? (
          <AddMeasurementPhoto
            projectId={projectId}
            siteId={siteId}
            measurementId={measurement.id}
            caption={itemLabel(measurement.bqItem)}
          />
        ) : null}
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{t("history")}</h2>
        <ScrollTable label={t("history")} minWidth={620}>
          <thead>
            <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
              <th scope="col" className="py-2 pl-4 font-medium">
                {t("cols.date")}
              </th>
              <th scope="col" className="py-2 pr-2 text-right font-medium">
                {t("cols.quantity")}
              </th>
              <th scope="col" className="py-2 pr-2 text-right font-medium">
                {t("cols.value")}
              </th>
              <th scope="col" className="py-2 pr-2 font-medium">
                {t("cols.state")}
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                {t("cols.by")}
              </th>
            </tr>
          </thead>
          <tbody>
            {history.map((entry) => (
              <tr
                key={entry.id}
                className="border-b last:border-0"
                aria-current={entry.id === measurement.id ? "true" : undefined}
              >
                <th scope="row" className="py-2 pl-4 text-left font-normal">
                  <Link
                    href={`/valuations/projects/${projectId}/measurements/${entry.id}`}
                    className="underline underline-offset-4"
                  >
                    {formatCalendarDate(entry.measuredOn)}
                  </Link>
                </th>
                <td className="py-2 pr-2 text-right tabular-nums">
                  {formatDecimalString(entry.quantityToDate)}
                </td>
                <td className="py-2 pr-2 text-right tabular-nums">{formatKES(entry.valueMinor)}</td>
                <td className="py-2 pr-2">
                  <StatusBadge tone={measurementStateTone[entry.state]}>
                    {tState(entry.state)}
                  </StatusBadge>
                </td>
                <td className="py-2 pr-4">{entry.measuredBy.displayName}</td>
              </tr>
            ))}
          </tbody>
        </ScrollTable>
      </section>
    </div>
  );
}
