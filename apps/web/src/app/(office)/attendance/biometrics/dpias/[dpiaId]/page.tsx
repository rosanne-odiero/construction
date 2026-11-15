import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArrowLeft, Download } from "lucide-react";
import { biometricsOverviewResponseSchema, dpiaResponseSchema } from "@pm-buddy/validation";
import { AttendanceNav } from "@/components/attendance/attendance-nav";
import {
  DpiaDecisions,
  DpiaDocumentUpload,
  DpiaForm,
} from "@/components/attendance/biometrics-actions";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { dpiaStateTone } from "@/lib/biometrics";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { loadLive, requireSession } from "@/lib/server-api";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata() {
  const t = await getTranslations("biometrics");
  return { title: t("title") };
}

/**
 * One DPIA version (D3.4): a draft is edited here, gets its signed PDF and is approved with every
 * go-live condition confirmed or closed as not approved; the approved version can be withdrawn.
 * Approved and closed versions are read-only.
 */
export default async function DpiaPage({ params }: { params: Promise<{ dpiaId: string }> }) {
  const { dpiaId } = await params;
  const path = `/attendance/biometrics/dpias/${dpiaId}`;
  if (!UUID.test(dpiaId)) notFound();
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await loadLive(`/biometrics/dpias/${dpiaId}`, dpiaResponseSchema, path);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const { dpia } = result.data;
  const editing = dpia.status === "draft" && dpia.permissions.canEdit;
  const overview = editing
    ? await loadLive("/biometrics", biometricsOverviewResponseSchema, path)
    : null;
  if (overview && !overview.ok) return <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("biometrics");
  const ta = await getTranslations("attendanceLive");
  const recorded = (value: string | null) => value ?? t("detail.notRecorded");
  const dated = (value: string | null) =>
    value ? formatCalendarDate(value) : t("detail.notRecorded");

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge tone="info">{ta("live")}</StatusBadge>
            <Link
              href="/attendance/biometrics"
              className="inline-flex items-center gap-1 underline underline-offset-4"
            >
              <ArrowLeft className="size-3.5" aria-hidden /> {t("detail.back")}
            </Link>
          </span>
        }
        title={t("dpia.version", { version: dpia.versionNo })}
        description={t("detail.createdBy", {
          name: dpia.createdBy.displayName,
          at: formatDateTime(dpia.createdAt),
        })}
        actions={
          <StatusBadge tone={dpiaStateTone[dpia.state]}>{t(`states.${dpia.state}`)}</StatusBadge>
        }
      />
      <AttendanceNav current="biometrics" />

      {dpia.status === "draft" ? (
        <section aria-labelledby="gaps-title" className="space-y-2 rounded-xl border p-4">
          <h2 id="gaps-title" className="text-lg font-semibold">
            {t("detail.gapsTitle")}
          </h2>
          {dpia.approvalGaps.length ? (
            <ul className="list-disc space-y-1 pl-5 text-sm" data-testid="approval-gaps">
              {dpia.approvalGaps.map((gap) => (
                <li key={gap}>{t(`gaps.${gap}`)}</li>
              ))}
            </ul>
          ) : (
            <p className="text-sm">{t("detail.ready")}</p>
          )}
        </section>
      ) : null}

      <DpiaDecisions dpia={dpia} />

      {dpia.approval ? (
        <section aria-labelledby="approval-title" className="space-y-2 rounded-xl border p-4">
          <h2 id="approval-title" className="text-lg font-semibold">
            {t("detail.approval")}
          </h2>
          <p className="text-sm">
            {t("detail.approvedBy", {
              name: dpia.approval.by.displayName,
              at: formatDateTime(dpia.approval.at),
            })}
          </p>
          <p className="text-sm">
            {t("detail.reviewDue", { date: formatCalendarDate(dpia.approval.reviewDue) })}
          </p>
          <p className="text-sm font-medium">{t("detail.conditionsConfirmed")}</p>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {dpia.approval.conditions.map((condition) => (
              <li key={condition}>{t(`conditions.${condition}`)}</li>
            ))}
          </ul>
          <p className="text-xs break-all text-muted-foreground">
            {t("detail.digest")}: {dpia.approval.digest}
          </p>
        </section>
      ) : null}

      {dpia.rejection || dpia.withdrawal || dpia.supersession ? (
        <section
          className="space-y-1 rounded-xl border p-4 text-sm"
          aria-label={t(`states.${dpia.state}`)}
        >
          {dpia.rejection ? (
            <>
              <p>
                {t("detail.rejectedBy", {
                  name: dpia.rejection.by.displayName,
                  at: formatDateTime(dpia.rejection.at),
                })}
              </p>
              <p className="whitespace-pre-line text-muted-foreground">{dpia.rejection.reason}</p>
            </>
          ) : null}
          {dpia.withdrawal ? (
            <>
              <p>
                {t("detail.withdrawnBy", {
                  name: dpia.withdrawal.by.displayName,
                  at: formatDateTime(dpia.withdrawal.at),
                })}
              </p>
              <p className="whitespace-pre-line text-muted-foreground">{dpia.withdrawal.reason}</p>
            </>
          ) : null}
          {dpia.supersession ? (
            <p>
              {t("detail.supersededBy", {
                version: dpia.supersession.by.versionNo,
                at: formatDateTime(dpia.supersession.at),
              })}{" "}
              <Link
                href={`/attendance/biometrics/dpias/${dpia.supersession.by.id}`}
                className="font-medium underline underline-offset-4"
              >
                {t("dpia.open", { version: dpia.supersession.by.versionNo })}
              </Link>
            </p>
          ) : null}
        </section>
      ) : null}

      <section aria-labelledby="document-title" className="space-y-3 rounded-xl border p-4">
        <h2 id="document-title" className="text-lg font-semibold">
          {t("detail.document")}
        </h2>
        {dpia.document ? (
          <div className="space-y-1 text-sm" data-testid="dpia-document">
            <p className="font-medium break-words">{dpia.document.fileName}</p>
            <p className="text-muted-foreground">
              {t("detail.uploadedBy", {
                name: dpia.document.uploadedBy.displayName,
                at: formatDateTime(dpia.document.uploadedAt),
              })}
            </p>
            <p className="text-xs break-all text-muted-foreground">
              {t("detail.sha256")}: {dpia.document.sha256}
            </p>
            {dpia.document.scanStatus === "not_scanned" ? (
              <p className="text-xs text-muted-foreground">{t("detail.notScanned")}</p>
            ) : null}
            {dpia.replacedDocuments ? (
              <p className="text-xs text-muted-foreground">
                {t("detail.replaced", { count: dpia.replacedDocuments })}
              </p>
            ) : null}
            <a
              href={`/api/v1/biometrics/dpias/${dpia.id}/document`}
              className="inline-flex items-center gap-1 font-medium underline underline-offset-4"
            >
              <Download className="size-4" aria-hidden /> {t("detail.download")}
            </a>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("detail.noDocument")}</p>
        )}
        {editing ? <DpiaDocumentUpload dpia={dpia} /> : null}
      </section>

      {editing && overview?.ok ? (
        <DpiaForm key={dpia.version} dpia={dpia} sites={overview.data.sites} />
      ) : (
        <section aria-labelledby="scope-title" className="space-y-4 rounded-xl border p-4">
          <h2 id="scope-title" className="text-lg font-semibold">
            {t("detail.scope")}
          </h2>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">{t("detail.methods")}</dt>
              <dd>
                {dpia.methods.map((method) => t(`methods.${method}`)).join(", ") ||
                  t("detail.notRecorded")}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("detail.sites")}</dt>
              <dd>
                {dpia.sites.length ? (
                  <ul>
                    {dpia.sites.map((site) => (
                      <li key={site.id}>
                        {site.projectCode} · {site.name}
                      </li>
                    ))}
                  </ul>
                ) : (
                  t("detail.noSites")
                )}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("detail.dpo")}</dt>
              <dd>
                {recorded(dpia.dpo.name)}
                {" · "}
                {dpia.dpo.opinion ? t(`opinions.${dpia.dpo.opinion}`) : t("detail.notRecorded")}
                {" · "}
                {dated(dpia.dpo.opinionOn)}
                {dpia.dpo.note ? (
                  <span className="block whitespace-pre-line text-muted-foreground">
                    {dpia.dpo.note}
                  </span>
                ) : null}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("detail.controller")}</dt>
              <dd>
                {recorded(dpia.controller.name)}
                {dpia.controller.role ? ` (${dpia.controller.role})` : ""}
                {" · "}
                {dpia.controller.decision
                  ? t(`decisions.${dpia.controller.decision}`)
                  : t("detail.notRecorded")}
                {" · "}
                {dated(dpia.controller.decisionOn)}
                {dpia.controller.note ? (
                  <span className="block whitespace-pre-line text-muted-foreground">
                    {dpia.controller.note}
                  </span>
                ) : null}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("detail.residualRisk")}</dt>
              <dd>
                {dpia.residualRisk ? t(`risks.${dpia.residualRisk}`) : t("detail.notRecorded")}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("detail.odpcReference")}</dt>
              <dd>{recorded(dpia.odpcReference)}</dd>
            </div>
          </dl>
        </section>
      )}
    </div>
  );
}
