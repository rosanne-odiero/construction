import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { accreditationAlertsResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { LabourNav } from "@/components/labour/labour-nav";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCalendarDate } from "@/lib/format";

import { loadLive, requireSession } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("labourLive.alerts");
  return { title: t("title") };
}

const tone = { expired: "danger", expiring: "warning", missing: "warning" } as const;

/**
 * NCA accreditation alerts (D3.1): computed on read for active labourers with the company's lead
 * time (labour.accreditation_alert_days). Nothing is sent; reminders come with notifications later.
 */
export default async function LabourAlertsPage() {
  const path = "/labour/alerts";
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await loadLive(
    "/labour/accreditation-alerts",
    accreditationAlertsResponseSchema,
    path,
  );
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const { alerts, alertDays, today } = result.data;
  const t = await getTranslations("labourLive");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<StatusBadge tone="info">{t("live")}</StatusBadge>}
        title={t("alerts.title")}
        description={t("alerts.description", { days: alertDays, today: formatCalendarDate(today) })}
      />
      <LabourNav current="alerts" alerts={alerts.length} />
      <p role="status" className="text-sm text-muted-foreground">
        {t("alerts.count", { count: alerts.length })}
      </p>
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableCaption className="sr-only">{t("alerts.title")}</TableCaption>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead>{t("alerts.columns.worker")}</TableHead>
              <TableHead>{t("alerts.columns.alert")}</TableHead>
              <TableHead>{t("alerts.columns.card")}</TableHead>
              <TableHead>{t("alerts.columns.expires")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {alerts.map((alert) => (
              <TableRow key={`${alert.labourerId}:${alert.accreditationId ?? "missing"}`}>
                <TableCell>
                  <Link
                    href={`/labour?worker=${alert.labourerId}`}
                    className="font-medium hover:underline"
                  >
                    {alert.fullName}
                  </Link>
                  <span className="block font-mono text-xs text-muted-foreground">
                    {alert.workerNo}
                  </span>
                </TableCell>
                <TableCell>
                  <StatusBadge tone={tone[alert.kind]}>
                    {t(`accreditation.${alert.kind}`)}
                  </StatusBadge>
                </TableCell>
                <TableCell className="text-sm">
                  {alert.category ? t(`panel.accreditations.categories.${alert.category}`) : "—"}
                </TableCell>
                <TableCell className="text-sm tabular-nums">
                  {alert.expiresOn ? (
                    <>
                      {formatCalendarDate(alert.expiresOn)}
                      <span className="block text-xs text-muted-foreground">
                        {alert.daysLeft !== null && alert.daysLeft < 0
                          ? t("alerts.daysAgo", { days: -alert.daysLeft })
                          : t("alerts.daysLeft", { days: alert.daysLeft ?? 0 })}
                      </span>
                    </>
                  ) : (
                    "—"
                  )}
                </TableCell>
              </TableRow>
            ))}
            {alerts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="py-10 text-center text-sm text-muted-foreground">
                  {t("alerts.none")}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
