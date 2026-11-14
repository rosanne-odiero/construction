import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { approvalQueueResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { PhotoThumbs } from "@/components/quality/photos";
import { StatusBadge } from "@/components/status-badge";
import { ValuationAction } from "@/components/valuations/valuation-action";
import { ValuationsEyebrow } from "@/components/valuations/valuations-nav";
import { formatCalendarDate, formatDateTime, formatDecimalString, formatKES } from "@/lib/format";
import { loadOrRedirect } from "@/lib/p2p-server";
import { requireSession } from "@/lib/server-api";
import { itemLabel } from "@/lib/valuations";

export async function generateMetadata() {
  const t = await getTranslations("valuations.approvals");
  return { title: t("title") };
}

/**
 * The approval queue: measurements waiting for an independent review on the projects where the
 * caller reviews them (bq.edit). Your own measurements are listed but only someone else approves.
 */
export default async function ApprovalsPage() {
  const path = "/valuations/approvals";
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await loadOrRedirect("/measurements/pending", approvalQueueResponseSchema, path);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("valuations.approvals");
  const tBasis = await getTranslations("valuations.basis");
  const { entries, truncated } = result.data;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<ValuationsEyebrow trail={{ href: "/valuations", label: t("back") }} />}
        title={t("title")}
        description={t("description")}
      />
      {entries.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm">{t("empty")}</p>
      ) : (
        <ul className="space-y-3">
          {entries.map(({ project, measurement }) => {
            const own = measurement.measuredBy.id === session.user.id;
            return (
              <li key={measurement.id} className="space-y-3 rounded-xl border p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 space-y-1">
                    <p className="text-xs text-muted-foreground">
                      {project.code} · {project.name}
                    </p>
                    <h2 className="font-semibold">
                      <Link
                        href={`/valuations/projects/${project.id}/measurements/${measurement.id}`}
                        className="underline underline-offset-4"
                      >
                        {itemLabel(measurement.bqItem)} · {measurement.bqItem.description}
                      </Link>
                    </h2>
                    <p className="text-sm">
                      {measurement.basis === "percent"
                        ? t("percentLine", {
                            percent: formatDecimalString(measurement.quantityToDate),
                          })
                        : t("quantityLine", {
                            quantity: formatDecimalString(measurement.quantityToDate),
                            unit: measurement.bqItem.unit ?? "",
                            of: measurement.itemQuantity
                              ? formatDecimalString(measurement.itemQuantity)
                              : "—",
                          })}{" "}
                      · {formatKES(measurement.valueMinor)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t("by", {
                        name: measurement.measuredBy.displayName,
                        date: formatCalendarDate(measurement.measuredOn),
                        recorded: formatDateTime(measurement.recordedAt),
                      })}
                      {measurement.basis ? ` · ${tBasis(measurement.basis)}` : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {measurement.overMeasured ? (
                      <StatusBadge tone="warning">{t("overMeasured")}</StatusBadge>
                    ) : null}
                    {measurement.correctsMeasurementId ? (
                      <StatusBadge tone="info">{t("correction")}</StatusBadge>
                    ) : null}
                  </div>
                </div>
                {measurement.overMeasureReason ? (
                  <p className="text-sm">
                    {t("overReason", { reason: measurement.overMeasureReason })}
                  </p>
                ) : null}
                <PhotoThumbs
                  projectId={project.id}
                  photos={measurement.photos}
                  label={t("photos")}
                />
                {measurement.photos.length === 0 ? (
                  <p className="text-sm text-warning-foreground dark:text-warning">
                    {t("noPhotos")}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {measurement.permissions.canApprove ? (
                    <ValuationAction
                      path={`/projects/${project.id}/measurements/${measurement.id}/approve`}
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
                      path={`/projects/${project.id}/measurements/${measurement.id}/reject`}
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
                  {own ? <p className="text-sm text-muted-foreground">{t("own")}</p> : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {truncated ? <p className="text-sm text-muted-foreground">{t("truncated")}</p> : null}
    </div>
  );
}
