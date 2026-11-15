import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Download } from "lucide-react";
import { subcontractCertificateResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { ScrollTable } from "@/components/stores/stores-subnav";
import { Button } from "@/components/ui/button";
import { SubcontractAction } from "@/components/subcontracts/subcontract-action";
import { ClaimsForm, InvoiceForm, PaymentForm } from "@/components/subcontracts/subcontract-forms";
import { SubcontractsEyebrow } from "@/components/subcontracts/subcontracts-nav";
import { formatCalendarDate, formatDateTime, formatDecimalString, formatKES } from "@/lib/format";
import { loadOrRedirect } from "@/lib/p2p-server";
import { requireSession } from "@/lib/server-api";
import { isUuid } from "@/lib/stores";
import { certificateStatusTone, problemKey } from "@/lib/subcontracts";

export async function generateMetadata() {
  const t = await getTranslations("subcontracts.certificate");
  return { title: t("metaTitle") };
}

/**
 * A subcontract payment certificate (D6.3 part B, rule KE-SUB-1): work done from the claims on
 * approved measurement, retention (to its limit), advance recovery (never above what was paid),
 * previous certificates, the amount due with VAT and withholding tax shown separately; submit
 * (bq.edit) freezes it, finance certifies with step-up on the digest it saw (never a
 * contributor); payments recorded outside PM-Buddy and the subcontractor's invoice matched to it.
 */
export default async function SubcontractCertificatePage({
  params,
}: {
  params: Promise<{ certificateId: string }>;
}) {
  const { certificateId } = await params;
  if (!isUuid(certificateId)) notFound();
  const path = `/subcontracts/certificates/${certificateId}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await loadOrRedirect(
    `/subcontract-certificates/${certificateId}`,
    subcontractCertificateResponseSchema,
    path,
  );
  if (!result.ok) {
    if (result.status === 404 || result.status === 400) notFound();
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  }
  const t = await getTranslations("subcontracts.certificate");
  const tStatus = await getTranslations("subcontracts.certificateStatus");
  const tProblem = await getTranslations("subcontracts.problems");
  const tMethod = await getTranslations("subcontracts.methods");
  const tStage = await getTranslations("subcontracts.stages");
  const c = result.data.certificate;
  const f = c.figures;
  const p = c.permissions;
  const limit =
    f.retentionLimitMinor === null
      ? ""
      : t("limitSuffix", { amount: formatKES(f.retentionLimitMinor) });
  const summary: { label: string; amount: number; strong?: boolean }[] = [
    { label: t("summary.work"), amount: f.workDoneMinor, strong: true },
    {
      label:
        f.retentionStage === "none"
          ? t("summary.retention", { percent: c.terms.retentionPercent, limit })
          : t("summary.retentionAfter", { stage: tStage(f.retentionStage) }),
      amount: -f.retentionHeldMinor,
    },
    {
      label: t("summary.recovery", { percent: c.terms.advanceRecoveryPercent }),
      amount: -f.recoveredToDateMinor,
    },
    { label: t("summary.net"), amount: f.netToDateMinor, strong: true },
    { label: t("summary.previous"), amount: -f.previousCertifiedMinor },
    { label: t("summary.due"), amount: f.amountDueMinor, strong: true },
    { label: t("summary.vat", { rate: c.terms.vatPercent }), amount: f.vatMinor },
    { label: t("summary.wht", { rate: c.terms.whtPercent }), amount: -f.whtMinor },
    { label: t("summary.payable"), amount: f.payableMinor, strong: true },
  ];
  const title = c.certificateNumber ? c.code : t("titleDraft", { code: c.code });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <SubcontractsEyebrow
            trail={{ href: `/subcontracts/${c.subcontract.id}`, label: c.subcontract.code }}
          />
        }
        title={`${title} · ${c.subcontract.title}`}
        description={`${c.project.code} · ${c.subcontract.supplier.name} · ${formatCalendarDate(c.valuationDate)}`}
        actions={
          <>
            <StatusBadge tone={certificateStatusTone[c.status]}>{tStatus(c.status)}</StatusBadge>
            <StatusBadge tone="neutral">
              {c.kind === "interim"
                ? t("interim")
                : t("release", { stage: tStage(c.releaseStage!) })}
            </StatusBadge>
            {p.canSubmit ? (
              <SubcontractAction
                path={`/subcontract-certificates/${c.id}/submit`}
                entity="certificate"
                body={{ version: c.version }}
                primary
                text={{
                  button: t("actions.submit"),
                  title: t("actions.submitTitle"),
                  description: t("actions.submitDescription", {
                    amount: formatKES(f.amountDueMinor),
                  }),
                  confirm: t("actions.submit"),
                }}
              />
            ) : null}
            {p.canCertify && c.digest ? (
              <SubcontractAction
                path={`/subcontract-certificates/${c.id}/certify`}
                entity="certificate"
                body={{ version: c.version, digest: c.digest }}
                primary
                text={{
                  button: t("actions.certify"),
                  title: t("actions.certifyTitle", { amount: formatKES(f.amountDueMinor) }),
                  description: t("actions.certifyDescription", {
                    payable: formatKES(f.payableMinor),
                  }),
                  confirm: t("actions.certify"),
                }}
              />
            ) : null}
            {p.canReturn ? (
              <SubcontractAction
                path={`/subcontract-certificates/${c.id}/return`}
                entity="certificate"
                body={{ version: c.version }}
                reason
                text={{
                  button: t("actions.return"),
                  title: t("actions.returnTitle"),
                  description: t("actions.returnDescription"),
                  confirm: t("actions.return"),
                }}
              />
            ) : null}
            {p.canCancel ? (
              <SubcontractAction
                path={`/subcontract-certificates/${c.id}/cancel`}
                entity="certificate"
                body={{ version: c.version }}
                reason
                destructive
                text={{
                  button: t("actions.cancel"),
                  title: t("actions.cancelTitle"),
                  description: t("actions.cancelDescription"),
                  confirm: t("actions.cancel"),
                }}
              />
            ) : null}
          </>
        }
      />
      {c.status === "draft" ? (
        <p className="rounded-xl border border-info/30 bg-info/10 p-3 text-sm">
          {t("previewNote")}
        </p>
      ) : null}
      {c.status === "certified" && c.certifiedBy && c.certifiedAt ? (
        <p className="rounded-xl border border-success/30 bg-success/10 p-3 text-sm">
          {t("certifiedNote", {
            name: c.certifiedBy.displayName,
            when: formatDateTime(c.certifiedAt),
          })}
        </p>
      ) : null}
      {c.returnReason && c.status === "draft" ? (
        <p className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm">
          {t("returned", { reason: c.returnReason })}
        </p>
      ) : null}
      {c.cancelReason ? (
        <p className="text-sm">{t("cancelled", { reason: c.cancelReason })}</p>
      ) : null}
      {c.problems.length || c.warnings.length ? (
        <ul className="space-y-1 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm">
          {[...c.problems, ...c.warnings].map((entry) => (
            <li key={`${entry.code}-${entry.ref ?? ""}`}>
              {tProblem(problemKey(entry.code))}
              {entry.ref ? ` (${entry.ref})` : ""}
            </li>
          ))}
        </ul>
      ) : null}
      {p.canExport ? (
        <div className="flex flex-wrap gap-2">
          {(["en", "sw"] as const).map((locale) => (
            <Button key={locale} asChild size="sm" variant="outline">
              <a
                href={`/api/v1/subcontract-certificates/${c.id}/export/pdf?locale=${locale}`}
                download
              >
                <Download aria-hidden /> {t(`downloadPdf.${locale}`)}
              </a>
            </Button>
          ))}
          <Button asChild size="sm" variant="outline">
            <a href={`/api/v1/subcontract-certificates/${c.id}/export/xlsx`} download>
              <Download aria-hidden /> {t("downloadExcel")}
            </a>
          </Button>
        </div>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">{t("summaryTitle")}</h2>
          <ScrollTable label={t("summaryTitle")} minWidth={320}>
            <tbody>
              {summary.map((row) => (
                <tr key={row.label} className="border-b last:border-0">
                  <th
                    scope="row"
                    className={`py-2 pl-4 text-left ${row.strong ? "font-semibold" : "font-normal"}`}
                  >
                    {row.label}
                  </th>
                  <td
                    className={`py-2 pr-4 text-right whitespace-nowrap tabular-nums ${row.strong ? "font-semibold" : ""}`}
                  >
                    {formatKES(row.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
          <p className="text-xs text-muted-foreground">
            {t("recoveryNote", {
              paid: formatKES(f.advancesPaidMinor),
              outstanding: formatKES(f.advancesOutstandingMinor),
            })}
          </p>
          <p className="text-xs text-muted-foreground">{t("taxNote")}</p>
        </section>
        <section
          aria-labelledby="certificate-settlement"
          className="space-y-2 rounded-xl border p-4 text-sm"
        >
          <h2 id="certificate-settlement" className="font-semibold">
            {t("settlementTitle")}
          </h2>
          <dl className="grid grid-cols-2 gap-2">
            <dt className="text-muted-foreground">{t("payable")}</dt>
            <dd className="text-right tabular-nums">{formatKES(c.payableMinor ?? 0)}</dd>
            <dt className="text-muted-foreground">{t("paid")}</dt>
            <dd className="text-right tabular-nums">{formatKES(c.paidMinor)}</dd>
            <dt className="text-muted-foreground">{t("outstanding")}</dt>
            <dd className="text-right font-medium tabular-nums">{formatKES(c.outstandingMinor)}</dd>
          </dl>
          {c.invoice ? (
            <p>
              {t("invoiceMatched", {
                number: c.invoice.invoiceNumber,
                date: formatCalendarDate(c.invoice.invoiceDate),
                amount: formatKES(c.invoice.amountMinor),
              })}
              {c.invoice.etimsNumber ? ` · eTIMS ${c.invoice.etimsNumber}` : ""}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">{t("ledgerNote")}</p>
        </section>
      </div>

      <section aria-labelledby="certificate-lines" className="space-y-2">
        <h2 id="certificate-lines" className="text-lg font-semibold">
          {t("linesTitle")}
        </h2>
        <ScrollTable label={t("linesTitle")} minWidth={900}>
          <thead className="bg-muted/50 text-left">
            <tr>
              {(
                [
                  "item",
                  "line",
                  "measured",
                  "otherClaims",
                  "toDate",
                  "previous",
                  "value",
                  "period",
                ] as const
              ).map((key) => (
                <th
                  key={key}
                  scope="col"
                  className={`px-3 py-2 font-medium ${key === "item" ? "" : "text-right"}`}
                >
                  {t(`lines.${key}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {c.lines.map((line) => (
              <tr key={line.lineId} className="border-t align-top">
                <th scope="row" className="px-3 py-2 text-left font-normal">
                  <span className="font-medium">
                    {line.lineNo}. {line.bqItem.ref ?? "—"}
                  </span>{" "}
                  {line.description}
                </th>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatDecimalString(line.lineQuantity)} {line.unit ?? ""}
                  <span className="block text-xs text-muted-foreground">
                    {line.rateMinor === null
                      ? formatKES(line.lineAmountMinor)
                      : `@ ${formatKES(line.rateMinor)}`}
                  </span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {line.measuredToDate === null ? "—" : formatDecimalString(line.measuredToDate)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatDecimalString(line.otherClaims)}
                </td>
                <td className="px-3 py-2 text-right font-medium tabular-nums">
                  {formatDecimalString(line.quantityToDate)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatDecimalString(line.previousQuantity)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatKES(line.valueToDateMinor)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatKES(line.thisPeriodMinor)}
                </td>
              </tr>
            ))}
          </tbody>
        </ScrollTable>
        <p className="text-xs text-muted-foreground">{t("poolNote")}</p>
        {p.canEdit && c.kind === "interim" ? (
          <ClaimsForm
            certificateId={c.id}
            version={c.version}
            lines={c.lines.map((line) => ({
              lineId: line.lineId,
              label: `${line.lineNo}. ${line.bqItem.ref ?? ""} ${line.description}`.slice(0, 90),
              unit: line.basis === "percent" ? "%" : (line.unit ?? ""),
              quantityToDate: line.quantityToDate,
              availableQuantity: line.availableQuantity,
              percent: line.basis === "percent",
            }))}
          />
        ) : null}
      </section>

      <section aria-labelledby="certificate-payments" className="space-y-2">
        <h2 id="certificate-payments" className="text-lg font-semibold">
          {t("paymentsTitle")}
        </h2>
        {c.payments.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noPayments")}</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {c.payments.map((payment) => (
              <li key={payment.id} className="rounded-lg border p-2">
                {t("paymentLine", {
                  amount: formatKES(payment.amountMinor),
                  date: formatCalendarDate(payment.paidOn),
                  method: tMethod(payment.method),
                  reference: payment.reference,
                  name: payment.recordedBy.displayName,
                })}
              </li>
            ))}
          </ul>
        )}
        {p.canPay && c.outstandingMinor > 0 ? (
          <PaymentForm
            certificateId={c.id}
            outstandingMinor={c.outstandingMinor}
            minDate={c.valuationDate}
          />
        ) : null}
        {p.canMatchInvoice && !c.invoice ? (
          <InvoiceForm certificateId={c.id} amountMinor={f.amountDueMinor + f.vatMinor} />
        ) : null}
        <p className="text-xs text-muted-foreground">
          {t("b2bNote")}{" "}
          <Link href={`/subcontracts/${c.subcontract.id}`} className="underline underline-offset-4">
            {t("statementLink")}
          </Link>
        </p>
      </section>
    </div>
  );
}
