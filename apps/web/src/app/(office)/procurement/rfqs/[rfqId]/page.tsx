import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { nairobiDate } from "@pm-buddy/domain";
import { rfqDetailResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { ComparisonMatrix } from "@/components/procurement/p2p/comparison-matrix";
import { DocumentUpload } from "@/components/procurement/p2p/document-upload";
import { MakerChecker } from "@/components/procurement/p2p/maker-checker";
import { P2pEyebrow } from "@/components/procurement/p2p/p2p-subnav";
import { RecordActions } from "@/components/procurement/p2p/record-actions";
import { AwardDialog, QuotationDialog } from "@/components/procurement/p2p/rfq-panels";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCalendarDate, formatDate, formatKES } from "@/lib/format";
import { isUuid, rfqTone } from "@/lib/p2p";
import { loadOrRedirect, sitesByProject, unitOptions } from "@/lib/p2p-server";
import { requireSession } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("p2p.rfqs");
  return { title: t("title") };
}

/**
 * An RFQ (D5.2): the comparison matrix, recorded quotations, the minimum-quotes status with the
 * single-source exception (approved by someone who did not prepare the RFQ) and the award.
 */
export default async function RfqPage({ params }: { params: Promise<{ rfqId: string }> }) {
  const { rfqId } = await params;
  if (!isUuid(rfqId)) notFound();
  const path = `/procurement/rfqs/${rfqId}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [result, units] = await Promise.all([
    loadOrRedirect(path, rfqDetailResponseSchema, path),
    unitOptions(),
  ]);
  if (!result.ok) {
    if (result.status === 404 || result.status === 400) notFound();
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  }
  const detail = result.data;
  const { rfq, quotations, award, permissions } = detail;
  const sites = (await sitesByProject([rfq.project.id]))[rfq.project.id] ?? [];
  const t = await getTranslations("p2p.rfqs");
  const tStatus = await getTranslations("p2p.status");
  const tActions = await getTranslations("p2p.actions");
  const tCommon = await getTranslations("p2p.common");
  const today = nairobiDate();
  const live = quotations.filter((quote) => quote.status === "received");
  const quotedSuppliers = new Set(live.map((quote) => quote.supplier.id));
  const candidates = live
    .filter((quote) => quote.complete && !quote.expired)
    .map((quote) => ({
      id: quote.id,
      label: t("award.quotationLabel", {
        supplier: quote.supplier.name,
        total: formatKES(quote.netTotalMinor),
      }),
    }));
  const canAward =
    permissions.canManage && award.basis !== "not-enough-quotes" && candidates.length > 0;
  const exceptionPending = rfq.exception.status === "requested";

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<P2pEyebrow trail={{ href: "/procurement/rfqs", label: t("title") }} />}
        title={rfq.number}
        description={`${rfq.project.code} · ${rfq.project.name} · ${t("detail.requisitions", {
          numbers: rfq.requisitions.map((entry) => entry.number).join(", "),
        })}${rfq.respondBy ? ` · ${t("detail.respondBy", { date: formatCalendarDate(rfq.respondBy) })}` : ""}`}
        actions={
          <>
            <StatusBadge tone={rfqTone[rfq.status]}>{tStatus(`rfq.${rfq.status}`)}</StatusBadge>
            {permissions.canManage ? (
              <QuotationDialog
                rfqId={rfq.id}
                lines={detail.lines}
                suppliers={rfq.suppliers.filter((supplier) => !quotedSuppliers.has(supplier.id))}
                units={units}
                today={today}
              />
            ) : null}
            {canAward ? (
              <AwardDialog
                rfqId={rfq.id}
                number={rfq.number}
                version={rfq.version}
                candidates={candidates}
                sites={sites}
              />
            ) : null}
            {permissions.canManage ? (
              <RecordActions
                entity="rfq"
                basePath={path}
                number={rfq.number}
                version={rfq.version}
                actions={[
                  {
                    action: "cancel",
                    reason: true,
                    destructive: true,
                    text: {
                      button: t("cancel.button"),
                      title: t("cancel.title", { number: rfq.number }),
                      description: tActions("cancel.description"),
                      confirm: t("cancel.confirm"),
                    },
                  },
                ]}
              />
            ) : null}
          </>
        }
      />
      {rfq.lpo ? (
        <p className="text-sm">
          <Link href={`/procurement/lpos/${rfq.lpo.id}`} className="underline">
            {t("detail.lpo", { number: rfq.lpo.number })}
          </Link>{" "}
          · {tStatus(`lpo.${rfq.lpo.status as "draft" | "submitted" | "approved" | "cancelled"}`)}
        </p>
      ) : null}

      <Card data-testid="min-quotes">
        <CardHeader>
          <CardTitle>
            <h2>{t("award.title")}</h2>
          </CardTitle>
          <CardDescription>
            {t("award.status", { complete: award.completeQuotes, min: award.minQuotes })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <StatusBadge
            tone={
              award.basis === "enough-quotes"
                ? "success"
                : award.basis === "exception-approved"
                  ? "info"
                  : "warning"
            }
          >
            {t(`award.basis.${award.basis}`)}
          </StatusBadge>
          <div className="space-y-2 text-sm">
            <p className="font-medium">{t("exception.title")}</p>
            <p className="text-muted-foreground">{t("exception.description")}</p>
            {rfq.exception.requestedBy && rfq.exception.requestedAt ? (
              <p>
                {t("exception.requestedBy", {
                  name: rfq.exception.requestedBy.displayName,
                  date: formatDate(rfq.exception.requestedAt),
                  reason: rfq.exception.reason ?? "",
                })}
              </p>
            ) : null}
            {rfq.exception.approvedBy && rfq.exception.approvedAt ? (
              <p>
                {t("exception.approvedBy", {
                  name: rfq.exception.approvedBy.displayName,
                  date: formatDate(rfq.exception.approvedAt),
                })}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <RecordActions
                entity="rfq"
                basePath={path}
                number={rfq.number}
                version={rfq.version}
                actions={[
                  ...(permissions.canManage &&
                  rfq.status === "open" &&
                  rfq.exception.status === "none" &&
                  award.basis === "not-enough-quotes"
                    ? [
                        {
                          action: "exception",
                          reason: true,
                          text: {
                            button: t("exception.request"),
                            title: t("exception.requestTitle"),
                            description: t("exception.description"),
                            confirm: t("exception.requestConfirm"),
                          },
                        },
                      ]
                    : []),
                  ...(permissions.canApproveException
                    ? [
                        {
                          action: "approve",
                          path: `${path}/exception/approve`,
                          primary: true,
                          text: {
                            button: t("exception.approve"),
                            title: t("exception.approveTitle"),
                            description: t("exception.approveDescription", {
                              reason: rfq.exception.reason ?? "",
                            }),
                            confirm: t("exception.approveConfirm"),
                          },
                        },
                      ]
                    : []),
                ]}
              />
            </div>
          </div>
        </CardContent>
      </Card>
      {exceptionPending ? (
        <MakerChecker contributors={detail.contributors} userId={session.user.id} pending />
      ) : null}

      <ComparisonMatrix detail={detail} units={units} />

      <section aria-labelledby="rfq-quotations" className="space-y-3">
        <h2 id="rfq-quotations" className="text-base font-semibold">
          {t("detail.quotationsTitle")}
        </h2>
        {quotations.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("detail.noQuotations")}</p>
        ) : (
          <ul className="grid gap-3 lg:grid-cols-2">
            {quotations.map((quote) => (
              <li key={quote.id} className="space-y-2 rounded-xl border p-4 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{quote.supplier.name}</span>
                  <StatusBadge tone={quote.status === "received" ? "success" : "neutral"}>
                    {tStatus(`quotation.${quote.status}`)}
                  </StatusBadge>
                  {quote.status === "received" ? (
                    <StatusBadge tone={quote.complete ? "success" : "warning"}>
                      {quote.complete ? t("detail.complete") : t("detail.incomplete")}
                    </StatusBadge>
                  ) : null}
                  {quote.expired ? (
                    <StatusBadge tone="warning">{t("detail.expired")}</StatusBadge>
                  ) : null}
                  {rfq.awardedQuotationId === quote.id ? (
                    <StatusBadge tone="info">{t("detail.awarded")}</StatusBadge>
                  ) : null}
                </div>
                <p className="tabular-nums">{formatKES(quote.netTotalMinor)}</p>
                <p className="text-muted-foreground">
                  {[
                    quote.reference ? t("detail.reference", { reference: quote.reference }) : null,
                    t("detail.quotedOn", { date: formatCalendarDate(quote.quotedOn) }),
                    t("detail.validUntil", { date: formatCalendarDate(quote.validUntil) }),
                    t("detail.deliveryDays", { days: quote.deliveryDays }),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                <p className="text-muted-foreground">
                  {t("detail.recordedBy", { name: quote.recordedBy.displayName })}
                </p>
                {quote.withdrawnReason ? (
                  <p>{t("detail.withdrawnBecause", { reason: quote.withdrawnReason })}</p>
                ) : null}
                {quote.document ? (
                  <a
                    href={`/api/v1/procurement/documents/${quote.document.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    {tCommon("openDocument", { kind: quote.document.contentType })}
                  </a>
                ) : permissions.canManage && quote.status === "received" ? (
                  <DocumentUpload
                    id={`quotation-file-${quote.id}`}
                    path={`${path}/quotations/${quote.id}/document`}
                    label={t("quotationForm.file")}
                  />
                ) : null}
                {permissions.canManage && quote.status === "received" ? (
                  <div className="flex flex-wrap gap-2">
                    <RecordActions
                      entity="rfq"
                      basePath={path}
                      number={rfq.number}
                      version={rfq.version}
                      actions={[
                        {
                          action: "withdraw",
                          path: `${path}/quotations/${quote.id}/withdraw`,
                          unversioned: true,
                          reason: true,
                          destructive: true,
                          text: {
                            button: t("detail.withdraw"),
                            title: t("detail.withdrawTitle", { supplier: quote.supplier.name }),
                            description: tActions("cancel.description"),
                            confirm: t("detail.withdrawConfirm"),
                          },
                        },
                      ]}
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="rfq-suppliers" className="space-y-2">
        <h2 id="rfq-suppliers" className="text-base font-semibold">
          {t("detail.suppliers")}
        </h2>
        <ul className="flex flex-wrap gap-2 text-sm">
          {rfq.suppliers.map((supplier) => (
            <li key={supplier.id} className="rounded-full border px-3 py-1">
              {supplier.name} ·{" "}
              {quotedSuppliers.has(supplier.id) ? t("detail.quoted") : t("detail.notQuoted")}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
