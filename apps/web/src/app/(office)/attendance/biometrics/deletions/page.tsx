import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { biometricDeletionsResponseSchema } from "@pm-buddy/validation";
import { AttendanceNav } from "@/components/attendance/attendance-nav";
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
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { loadLive, requireSession } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("biometrics.deletionLog");
  return { title: t("title") };
}

/**
 * The template deletion log (D3.4, DPIA §8): written by the database whenever templates are
 * deleted — who, which worker, when and why — and never changed. It holds no template content.
 */
export default async function BiometricDeletionsPage() {
  const path = "/attendance/biometrics/deletions";
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await loadLive("/biometrics/deletions", biometricDeletionsResponseSchema, path);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const { deletions } = result.data;
  const t = await getTranslations("biometrics");
  const ta = await getTranslations("attendanceLive");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<StatusBadge tone="info">{ta("live")}</StatusBadge>}
        title={t("deletionLog.title")}
        description={t("deletionLog.description")}
      />
      <AttendanceNav current="biometrics" />
      <BiometricsNav current="deletions" />
      {deletions.length === 0 ? (
        <p className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
          {t("deletionLog.none")}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableCaption className="sr-only">{t("deletionLog.title")}</TableCaption>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead>{t("deletionLog.columns.when")}</TableHead>
                <TableHead>{t("deletionLog.columns.worker")}</TableHead>
                <TableHead>{t("deletionLog.columns.method")}</TableHead>
                <TableHead>{t("deletionLog.columns.reason")}</TableHead>
                <TableHead>{t("deletionLog.columns.templates")}</TableHead>
                <TableHead>{t("deletionLog.columns.by")}</TableHead>
                <TableHead>{t("deletionLog.columns.dueOn")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deletions.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="tabular-nums">{formatDateTime(entry.deletedAt)}</TableCell>
                  <TableCell>
                    <Link
                      href={`/attendance/biometrics/workers/${entry.labourer.id}`}
                      className="font-medium underline underline-offset-4"
                    >
                      {entry.labourer.fullName}
                    </Link>
                    <span className="block font-mono text-xs text-muted-foreground">
                      {entry.labourer.workerNo}
                    </span>
                  </TableCell>
                  <TableCell>{t(`modalities.${entry.modality}`)}</TableCell>
                  <TableCell className="text-sm whitespace-normal">
                    {t(`deletionReasons.${entry.reason}`)}
                  </TableCell>
                  <TableCell className="tabular-nums">{entry.templates}</TableCell>
                  <TableCell className="text-sm">
                    {entry.deletedBy?.displayName ?? t("deletionLog.job")}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {entry.dueOn ? formatCalendarDate(entry.dueOn) : "—"}
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
