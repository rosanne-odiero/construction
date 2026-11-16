import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { consentNotice, LOCALES, type Locale } from "@pm-buddy/types";
import { catalogues, isLocale } from "@pm-buddy/i18n";
import { workerBiometricsResponseSchema } from "@pm-buddy/validation";
import { AttendanceNav } from "@/components/attendance/attendance-nav";
import {
  BiometricConsentForm,
  BiometricOutcomes,
  DeleteBiometricTemplates,
  ModalityOutcome,
  WithdrawBiometricConsent,
  type BiometricNoticeText,
} from "@/components/attendance/biometric-worker-actions";
import { BiometricsNav } from "@/components/attendance/biometrics-nav";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { consentStatusTone, dpiaStateTone, enrolmentStateTone } from "@/lib/biometrics";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { loadLive, requireSession } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("biometrics.worker");
  return { title: t("title") };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A worker's biometric consent per modality (D3.4, DPIA §7): the notice to read in their
 * language, their decisions, the enrolment and what was deleted. Recording consent needs
 * biometrics.enrol and an approved DPIA in force covering the modality; withdrawal is always open.
 */
export default async function WorkerBiometricsPage({
  params,
}: {
  params: Promise<{ labourerId: string }>;
}) {
  const { labourerId } = await params;
  const path = `/attendance/biometrics/workers/${labourerId}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  if (!UUID.test(labourerId)) notFound();
  const result = await loadLive(
    `/biometrics/labourers/${labourerId}`,
    workerBiometricsResponseSchema,
    path,
  );
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const view = result.data;
  const t = await getTranslations("biometrics");
  const ta = await getTranslations("attendanceLive");
  const locale = await getLocale();
  const values = {
    company: view.company.name,
    retentionDays: view.retention.daysAfterEngagement,
    dpoName: view.dpia?.dpoName ?? "—",
    dpoPhone: view.dpia?.dpoPhone ?? "—",
  };
  const noticesFor = (version: string) => {
    const key = consentNotice(version)!.messageKey;
    return Object.fromEntries(
      LOCALES.map((language) => [
        language,
        (catalogues[language].labourConsentNotices as Record<string, unknown>)[
          key
        ] as BiometricNoticeText,
      ]),
    ) as Record<Locale, BiometricNoticeText>;
  };

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={<StatusBadge tone="info">{ta("live")}</StatusBadge>}
        title={t("worker.heading", { name: view.labourer.fullName })}
        description={t("worker.description")}
        actions={
          <Button asChild variant="outline">
            <Link href={`/labour?worker=${view.labourer.id}`}>
              <ArrowLeft aria-hidden /> {t("worker.back", { workerNo: view.labourer.workerNo })}
            </Link>
          </Button>
        }
      />
      <AttendanceNav current="biometrics" />
      <BiometricsNav />

      <p className="flex flex-wrap items-center gap-2 text-sm" data-testid="worker-dpia">
        {view.dpia ? (
          <>
            <StatusBadge tone={dpiaStateTone[view.dpia.state]}>
              {t(`states.${view.dpia.state}`)}
            </StatusBadge>
            {t("worker.dpiaLine", {
              version: view.dpia.versionNo,
              dpo: [view.dpia.dpoName, view.dpia.dpoPhone].filter(Boolean).join(", "),
            })}
          </>
        ) : (
          t("worker.dpiaNone")
        )}
      </p>

      <BiometricOutcomes>
        {view.modalities.map((entry) => {
          const modality = t(`modalities.${entry.modality}`);
          const enrolment = entry.enrolment;
          const granted = entry.consent.status === "granted";
          const canRecord =
            view.permissions.canConsent &&
            entry.blocked === null &&
            !(granted && entry.consent.current);
          return (
            <section
              key={entry.modality}
              aria-labelledby={`modality-${entry.modality}`}
              className="space-y-4 rounded-xl border p-4"
              data-testid={`modality-${entry.modality}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <h2 id={`modality-${entry.modality}`} className="text-lg font-semibold">
                  {modality}
                </h2>
                <StatusBadge tone={consentStatusTone[entry.consent.status]}>
                  {t(`consentStatuses.${entry.consent.status}`)}
                </StatusBadge>
                {granted ? (
                  <span className="text-sm text-muted-foreground">
                    {entry.consent.current ? t("worker.current") : t("worker.outdated")}
                  </span>
                ) : null}
                {granted && view.permissions.canWithdraw ? (
                  <span className="ml-auto">
                    <WithdrawBiometricConsent
                      labourerId={view.labourer.id}
                      modality={entry.modality}
                    />
                  </span>
                ) : null}
              </div>
              <ModalityOutcome modality={entry.modality} />

              <div className="space-y-2 rounded-lg bg-muted/30 p-3 text-sm">
                <h3 className="font-medium">{t("worker.enrolment.title")}</h3>
                {enrolment ? (
                  <>
                    <p className="flex flex-wrap items-center gap-2">
                      <StatusBadge tone={enrolmentStateTone[enrolment.state]}>
                        {t(`enrolmentStates.${enrolment.state}`)}
                      </StatusBadge>
                      {t("worker.enrolment.summary", {
                        method: t(`methods.${enrolment.method}`),
                        site: `${enrolment.site.projectCode} · ${enrolment.site.name}`,
                        count: enrolment.templates,
                        algorithm: enrolment.algorithm,
                        version: enrolment.algorithmVersion,
                      })}
                    </p>
                    <p className="text-muted-foreground">
                      {t("worker.enrolment.enrolled", {
                        at: formatDateTime(enrolment.enrolledAt),
                        name: enrolment.enrolledBy.displayName,
                      })}{" "}
                      {enrolment.deletionDueOn
                        ? t("worker.enrolment.dueOn", {
                            date: formatCalendarDate(enrolment.deletionDueOn),
                          })
                        : t("worker.enrolment.engaged")}
                    </p>
                    {view.permissions.canDelete ? (
                      <DeleteBiometricTemplates
                        enrolmentId={enrolment.id}
                        modality={entry.modality}
                      />
                    ) : null}
                  </>
                ) : (
                  <p className="text-muted-foreground">
                    {t("worker.enrolment.none")} {t("worker.enrolment.noneHint")}
                  </p>
                )}
              </div>

              {canRecord ? (
                <BiometricConsentForm
                  labourerId={view.labourer.id}
                  modality={entry.modality}
                  noticeVersion={entry.noticeVersion}
                  notices={noticesFor(entry.noticeVersion)}
                  values={values}
                  initialLanguage={isLocale(locale) ? locale : "en"}
                />
              ) : entry.blocked && !granted ? (
                <p role="status" className="text-sm text-muted-foreground">
                  {t(`blocked.${entry.blocked}`)}
                </p>
              ) : !view.permissions.canConsent && !granted ? (
                <p className="text-sm text-muted-foreground">{t("worker.readOnly")}</p>
              ) : null}

              <div className="space-y-2">
                <h3 className="font-medium">{t("worker.decisions.title")}</h3>
                {entry.decisions.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("worker.decisions.none")}</p>
                ) : (
                  <div
                    role="region"
                    tabIndex={0}
                    aria-label={`${t("worker.decisions.title")}: ${modality}`}
                    className="overflow-x-auto rounded-lg border outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    <table className="w-full caption-bottom text-sm">
                      <TableCaption className="sr-only">
                        {`${t("worker.decisions.title")}: ${modality}`}
                      </TableCaption>
                      <TableHeader>
                        <TableRow className="bg-muted/50">
                          <TableHead>{t("worker.decisions.columns.answer")}</TableHead>
                          <TableHead>{t("worker.decisions.columns.notice")}</TableHead>
                          <TableHead>{t("worker.decisions.columns.method")}</TableHead>
                          <TableHead>{t("worker.decisions.columns.recorded")}</TableHead>
                          <TableHead>{t("worker.decisions.columns.withdrawn")}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {entry.decisions.map((decision) => (
                          <TableRow key={decision.id}>
                            <TableCell className="font-medium">
                              {decision.granted
                                ? t("worker.decisions.yes")
                                : t("worker.decisions.no")}
                            </TableCell>
                            <TableCell className="text-sm">
                              <span className="font-mono text-xs">{decision.noticeVersion}</span>
                              <span className="block text-xs text-muted-foreground">
                                {t(`worker.languages.${decision.language}`)} ·{" "}
                                {t("worker.decisions.dpia", { version: decision.dpiaVersionNo })}
                              </span>
                            </TableCell>
                            <TableCell className="text-sm">
                              {t(`worker.methods.${decision.method}`)}
                              {decision.witnessName ? (
                                <span className="block text-xs text-muted-foreground">
                                  {t("worker.decisions.witness", { name: decision.witnessName })}
                                </span>
                              ) : null}
                            </TableCell>
                            <TableCell className="text-sm">
                              <span className="tabular-nums">
                                {formatDateTime(decision.capturedAt)}
                              </span>
                              <span className="block text-xs text-muted-foreground">
                                {decision.capturedBy.displayName}
                              </span>
                            </TableCell>
                            <TableCell className="text-sm">
                              {decision.withdrawnAt ? (
                                <>
                                  <span className="tabular-nums">
                                    {formatDateTime(decision.withdrawnAt)}
                                  </span>
                                  <span className="block text-xs text-muted-foreground">
                                    {decision.withdrawnBy?.displayName}
                                    {decision.withdrawalMethod
                                      ? ` · ${t(`worker.methods.${decision.withdrawalMethod}`)}`
                                      : ""}
                                  </span>
                                </>
                              ) : (
                                "—"
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </table>
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <h3 className="font-medium">{t("worker.deletions.title")}</h3>
                {entry.deletions.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("worker.deletions.none")}</p>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {entry.deletions.map((deletion) => (
                      <li key={deletion.id}>
                        <span className="tabular-nums">{formatDateTime(deletion.deletedAt)}</span>
                        {" · "}
                        {t(`deletionReasons.${deletion.reason}`)}
                        {" · "}
                        {deletion.deletedBy?.displayName ?? t("deletionLog.job")}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          );
        })}
      </BiometricOutcomes>
    </div>
  );
}
