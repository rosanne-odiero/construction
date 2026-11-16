import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { biometricEnrolmentsResponseSchema } from "@pm-buddy/validation";
import { AttendanceNav } from "@/components/attendance/attendance-nav";
import { RunBiometricRetention } from "@/components/attendance/biometric-worker-actions";
import { BiometricsNav } from "@/components/attendance/biometrics-nav";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { enrolmentStateTone } from "@/lib/biometrics";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { loadLive, requireSession } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("biometrics.enrolmentList");
  return { title: t("title") };
}

/**
 * Every worker whose biometric templates are held (D3.4): where and how they were enrolled, the
 * state under the DPIA and when the retention job deletes them. Templates are never shown.
 */
export default async function BiometricEnrolmentsPage() {
  const path = "/attendance/biometrics/enrolments";
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await loadLive("/biometrics/enrolments", biometricEnrolmentsResponseSchema, path);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const view = result.data;
  const t = await getTranslations("biometrics");
  const ta = await getTranslations("attendanceLive");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<StatusBadge tone="info">{ta("live")}</StatusBadge>}
        title={t("enrolmentList.title")}
        description={t("enrolmentList.description")}
      />
      <AttendanceNav current="biometrics" />
      <BiometricsNav current="enrolments" />
      <div className="space-y-2 text-sm">
        <p>{t("templates.retention", { days: view.retention.daysAfterEngagement })}</p>
        <p className="text-muted-foreground">
          {view.retention.jobEnabled ? t("templates.jobOn") : t("templates.jobOff")}
        </p>
        {view.permissions.canManageTemplates ? <RunBiometricRetention /> : null}
      </div>
      {view.enrolments.length === 0 ? (
        <p className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
          {t("enrolmentList.none")}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableCaption className="sr-only">{t("enrolmentList.title")}</TableCaption>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead>{t("enrolmentList.columns.worker")}</TableHead>
                <TableHead>{t("enrolmentList.columns.method")}</TableHead>
                <TableHead>{t("enrolmentList.columns.site")}</TableHead>
                <TableHead>{t("enrolmentList.columns.state")}</TableHead>
                <TableHead>{t("enrolmentList.columns.enrolled")}</TableHead>
                <TableHead>{t("enrolmentList.columns.dueOn")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.enrolments.map((enrolment) => (
                <TableRow key={enrolment.id} data-testid={`enrolment-${enrolment.id}`}>
                  <TableCell>
                    <Link
                      href={`/attendance/biometrics/workers/${enrolment.labourer.id}`}
                      className="font-medium underline underline-offset-4"
                    >
                      {enrolment.labourer.fullName}
                    </Link>
                    <span className="block font-mono text-xs text-muted-foreground">
                      {enrolment.labourer.workerNo}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm">
                    {t(`modalities.${enrolment.modality}`)}
                    <span className="block text-xs text-muted-foreground">
                      {t(`methods.${enrolment.method}`)}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm">
                    {enrolment.site.projectCode} · {enrolment.site.name}
                  </TableCell>
                  <TableCell>
                    <StatusBadge tone={enrolmentStateTone[enrolment.state]}>
                      {t(`enrolmentStates.${enrolment.state}`)}
                    </StatusBadge>
                  </TableCell>
                  <TableCell className="text-sm">
                    <span className="tabular-nums">{formatDateTime(enrolment.enrolledAt)}</span>
                    <span className="block text-xs text-muted-foreground">
                      {enrolment.enrolledBy.displayName}
                    </span>
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {enrolment.deletionDueOn
                      ? formatCalendarDate(enrolment.deletionDueOn)
                      : t("enrolmentList.engaged")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
