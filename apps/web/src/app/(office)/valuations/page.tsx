import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ClipboardCheck, Ruler } from "lucide-react";
import { valuationsOverviewResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { ValuationsEyebrow } from "@/components/valuations/valuations-nav";
import { formatCalendarDate, formatKES } from "@/lib/format";
import { loadOrRedirect } from "@/lib/p2p-server";
import { requireSession } from "@/lib/server-api";
import { valuationStatusTone } from "@/lib/valuations";

export async function generateMetadata() {
  const t = await getTranslations("valuations.home");
  return { title: t("title") };
}

/**
 * Measurement and valuations home (D6.3): every project where the caller measures or reads
 * valuations, with certified value, retention held and work waiting for review. Site staff see
 * the measuring side only; certificate figures need bq.edit, finance.view or finance.manage.
 */
export default async function ValuationsPage() {
  const path = "/valuations";
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await loadOrRedirect("/valuations", valuationsOverviewResponseSchema, path);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("valuations.home");
  const tStatus = await getTranslations("valuations.status");
  const { projects, approvalQueue } = result.data;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<ValuationsEyebrow />}
        title={t("title")}
        description={t("description")}
        actions={
          approvalQueue > 0 ? (
            <Button asChild size="sm">
              <Link href="/valuations/approvals">
                <ClipboardCheck aria-hidden /> {t("queue", { count: approvalQueue })}
              </Link>
            </Button>
          ) : null
        }
      />
      {projects.length === 0 ? (
        <div className="space-y-2 rounded-xl border border-dashed p-6 text-sm">
          <p className="font-medium">{t("noProjects")}</p>
          <p className="text-muted-foreground">{t("noProjectsHint")}</p>
        </div>
      ) : (
        <ul className="grid gap-4 lg:grid-cols-2">
          {projects.map((row) => (
            <li key={row.project.id} className="space-y-3 rounded-xl border p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="font-semibold">
                    <Link
                      href={`/valuations/projects/${row.project.id}`}
                      className="underline underline-offset-4"
                    >
                      {row.project.code} · {row.project.name}
                    </Link>
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {t("pending", { count: row.pendingMeasurements })}
                  </p>
                </div>
                {row.openValuation ? (
                  <StatusBadge tone={valuationStatusTone[row.openValuation.status]}>
                    {row.openValuation.number} · {tStatus(row.openValuation.status)}
                  </StatusBadge>
                ) : null}
              </div>
              {row.canReadValuations ? (
                <dl className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <dt className="text-muted-foreground">{t("contractSum")}</dt>
                    <dd className="tabular-nums">
                      {row.contractSum ? formatKES(row.contractSum.revisedMinor) : t("noBq")}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t("certified")}</dt>
                    <dd className="tabular-nums">{formatKES(row.certifiedMinor ?? 0)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t("retentionHeld")}</dt>
                    <dd className="tabular-nums">{formatKES(row.retentionHeldMinor ?? 0)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t("latest")}</dt>
                    <dd>
                      {row.latestCertificate ? (
                        <Link
                          href={`/valuations/${row.latestCertificate.id}`}
                          className="underline underline-offset-4"
                        >
                          {t("latestLine", {
                            number: row.latestCertificate.certificateNumber,
                            date: formatCalendarDate(row.latestCertificate.valuationDate),
                          })}
                        </Link>
                      ) : (
                        t("none")
                      )}
                    </dd>
                  </div>
                </dl>
              ) : (
                <p className="text-sm text-muted-foreground">{t("measureOnly")}</p>
              )}
              <div className="flex flex-wrap gap-2">
                {row.canMeasure ? (
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/valuations/projects/${row.project.id}/measure`}>
                      <Ruler aria-hidden /> {t("measure")}
                    </Link>
                  </Button>
                ) : null}
                <Button asChild size="sm" variant="ghost">
                  <Link href={`/valuations/projects/${row.project.id}`}>{t("open")}</Link>
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
