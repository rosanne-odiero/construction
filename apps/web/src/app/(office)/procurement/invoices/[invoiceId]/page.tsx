import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Ban, Pencil } from "lucide-react";
import { nairobiDate } from "@pm-buddy/domain";
import type { StandardUnitCode } from "@pm-buddy/types";
import { invoiceDetailResponseSchema, type PayoutSummary } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { etimsTone } from "@/components/procurement/tones";
import { DocumentUpload } from "@/components/procurement/p2p/document-upload";
import {
  ApproveInvoice,
  ExceptInvoice,
  SettlementForm,
} from "@/components/procurement/p2p/invoice-panels";
import { MakerChecker } from "@/components/procurement/p2p/maker-checker";
import { MatchPanel } from "@/components/procurement/p2p/match-panel";
import { P2pEyebrow } from "@/components/procurement/p2p/p2p-subnav";
import { RecordActions, type RecordAction } from "@/components/procurement/p2p/record-actions";
import { Timeline } from "@/components/procurement/p2p/timeline";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCalendarDate, formatDate, formatDateTime, formatKES } from "@/lib/format";
import { formatQuantity, invoiceTone, isUuid, pickParam } from "@/lib/p2p";
import { loadOrRedirect, unitOptions } from "@/lib/p2p-server";
import { formatMinorDecimal, unitLabel } from "@/lib/procurement";
import { requireSession } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("p2p.match");
  return { title: t("title") };
}

/**
 * A supplier invoice and its three-way match (the D5.2 acceptance screen): the eTIMS flag, the
 * match per LPO line with explicit reasons and staleness, the independent exception, approval
 * bound to the verified payee (blocked while unmatched), and recorded settlements.
 */
export default async function InvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ invoiceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { invoiceId } = await params;
  // Set by the invoice form when the invoice saved but its document did not upload.
  const uploadFailed = pickParam(await searchParams, "upload") === "failed";
  if (!isUuid(invoiceId)) notFound();
  const path = `/procurement/invoices/${invoiceId}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [result, units] = await Promise.all([
    loadOrRedirect(path, invoiceDetailResponseSchema, path),
    unitOptions(),
  ]);
  if (!result.ok) {
    if (result.status === 404 || result.status === 400) notFound();
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  }
  const detail = result.data;
  const { invoice, lines, match, payable, payee, permissions } = detail;
  const t = await getTranslations("p2p.invoiceDetail");
  const tInvoices = await getTranslations("p2p.invoices");
  const tMatch = await getTranslations("p2p.match");
  const tApproval = await getTranslations("p2p.approval");
  const tSettlement = await getTranslations("p2p.settlement");
  const tStatus = await getTranslations("p2p.status");
  const tCommon = await getTranslations("p2p.common");
  const tEtims = await getTranslations("suppliers.etims");
  const tPayout = await getTranslations("suppliers.payout");
  const tVat = await getTranslations("catalogue.detail.vat");
  const tUnits = await getTranslations("catalogue.units");
  const label = (code: string) => unitLabel(code, (unit: StandardUnitCode) => tUnits(unit), units);
  const held = new Set(session.company.permissions);
  const contributor = detail.contributors.some((person) => person.id === session.user.id);
  const payeeText = (payout: PayoutSummary) =>
    [
      payout.mpesaKind === "paybill"
        ? tPayout("paybill", {
            number: payout.paybillNumber ?? "",
            reference: payout.accountReference ?? "",
          })
        : null,
      payout.mpesaKind === "till" ? tPayout("till", { number: payout.tillNumber ?? "" }) : null,
      payout.bank ? `${payout.bank.bankName} · ${payout.bank.accountNumberMasked}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  const outstanding = invoice.totalMinor - invoice.settledMinor;
  const matchCurrent = Boolean(match?.current);
  const approvable = invoice.status === "matched" && Boolean(match?.passing) && matchCurrent;
  const reapproval =
    payable !== null && !payable.current && ["approved", "partly_settled"].includes(invoice.status);

  const actions: RecordAction[] = [];
  if (invoice.status === "draft" && permissions.canEdit)
    actions.push({
      action: "submit",
      primary: true,
      text: {
        button: t("submit"),
        title: t("submitTitle", { number: invoice.invoiceNumber }),
        description: t("submitDescription"),
        confirm: t("submit"),
      },
    });
  if (permissions.canRematch && match && !match.current)
    actions.push({
      action: "rematch",
      primary: true,
      text: {
        button: tMatch("rematch"),
        title: tMatch("rematch"),
        description: tMatch("description"),
        confirm: tMatch("rematch"),
      },
    });
  if (permissions.canReopen)
    actions.push({
      action: "reopen",
      text: {
        button: t("reopen"),
        title: t("reopenTitle", { number: invoice.invoiceNumber }),
        description: t("reopenDescription"),
        confirm: t("reopen"),
      },
    });
  if (permissions.canCancel)
    actions.push({
      action: "cancel",
      reason: true,
      destructive: true,
      text: {
        button: t("cancel"),
        title: t("cancelTitle", { number: invoice.invoiceNumber }),
        description: t("cancelDescription"),
        confirm: t("cancelTitle", { number: invoice.invoiceNumber }),
      },
    });
  const rematchAction = actions.find((entry) => entry.action === "rematch") ?? null;
  const otherActions = actions.filter((entry) => entry.action !== "rematch");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <P2pEyebrow trail={{ href: "/procurement/invoices", label: tInvoices("title") }} />
        }
        title={`${invoice.invoiceNumber} · ${invoice.supplier.name}`}
        description={`${invoice.project.code} · ${invoice.project.name} · ${t("dates", {
          date: formatCalendarDate(invoice.invoiceDate),
          due: formatCalendarDate(invoice.dueDate),
        })}`}
        actions={
          <>
            <StatusBadge tone={invoiceTone[invoice.status]}>
              {tStatus(`invoice.${invoice.status}`)}
            </StatusBadge>
            {permissions.canEdit ? (
              <Button asChild variant="outline">
                <Link href={`${path}/edit`}>
                  <Pencil aria-hidden /> {t("edit")}
                </Link>
              </Button>
            ) : null}
            <RecordActions
              entity="invoice"
              basePath={path}
              number={invoice.invoiceNumber}
              version={invoice.version}
              actions={otherActions}
            />
          </>
        }
      />
      <p className="text-sm">
        <Link href={`/procurement/lpos/${invoice.lpo.id}`} className="underline">
          {t("lpo", { number: invoice.lpo.number })}
        </Link>
      </p>

      <Card data-testid="etims">
        <CardHeader>
          <CardTitle>
            <h2>{t("etimsTitle")}</h2>
          </CardTitle>
          <CardDescription>
            {t("supplierEtims", { status: tEtims(invoice.supplier.etimsStatus) })}{" "}
            <StatusBadge tone={etimsTone[invoice.supplier.etimsStatus]}>
              {tEtims(invoice.supplier.etimsStatus)}
            </StatusBadge>
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2 text-sm">
          {invoice.etimsInvoiceNumber ? (
            <>
              <span className="font-mono">{invoice.etimsInvoiceNumber}</span>
              {invoice.etimsFormat ? (
                <StatusBadge tone={invoice.etimsFormat === "etims" ? "success" : "warning"}>
                  {t(`etimsFormat.${invoice.etimsFormat}`)}
                </StatusBadge>
              ) : null}
            </>
          ) : (
            <StatusBadge tone="danger">{t("etimsMissing")}</StatusBadge>
          )}
        </CardContent>
      </Card>

      <MatchPanel
        match={match}
        units={units}
        rematch={
          rematchAction ? (
            <RecordActions
              entity="invoice"
              basePath={path}
              number={invoice.invoiceNumber}
              version={invoice.version}
              actions={[rematchAction]}
            />
          ) : null
        }
      />

      {invoice.status === "disputed" && match ? (
        <Card data-testid="exception">
          <CardHeader>
            <CardTitle>
              <h2>{tMatch("exception.title")}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {!match.exceptable ? (
              <p>{tMatch("exception.notExceptable")}</p>
            ) : permissions.canApproveException && match.current ? (
              <ExceptInvoice
                invoiceId={invoice.id}
                number={invoice.invoiceNumber}
                version={invoice.version}
                matchId={match.id}
              />
            ) : contributor ? (
              <p>{tMatch("exception.contributor")}</p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card data-testid="approval">
        <CardHeader>
          <CardTitle>
            <h2>{tApproval("title")}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {payable && payable.current ? (
            <p data-testid="approved-by">
              {tApproval("approvedBy", {
                name: payable.approvedBy.displayName,
                date: formatDate(payable.approvedAt),
                amount: formatKES(payable.authorisedMinor),
                version: payable.payout.versionNo,
              })}
            </p>
          ) : null}
          {reapproval ? (
            <p
              role="alert"
              data-testid="reapproval-needed"
              className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-destructive"
            >
              {tApproval("reapprovalNeeded")}
            </p>
          ) : null}
          {["draft", "submitted", "disputed"].includes(invoice.status) ? (
            <div className="flex flex-wrap items-center gap-3" data-testid="approval-blocked">
              <Button disabled aria-disabled>
                <Ban aria-hidden /> {tApproval("approve")}
              </Button>
              <p>{tApproval("blocked")}</p>
            </div>
          ) : null}
          {invoice.status === "matched" && match && !match.current ? (
            <div className="flex flex-wrap items-center gap-3" data-testid="approval-blocked">
              <Button disabled aria-disabled>
                <Ban aria-hidden /> {tApproval("approve")}
              </Button>
              <p>{tApproval("staleBlocked")}</p>
            </div>
          ) : null}
          {approvable || reapproval ? (
            payee ? (
              <div className="space-y-2" data-testid="approval-payee">
                <p>{tApproval("payee", { version: payee.versionNo })}</p>
                <p className="font-medium">{payeeText(payee)}</p>
                <p>{tApproval("amount", { amount: formatKES(outstanding) })}</p>
                {permissions.canApprove && match ? (
                  <ApproveInvoice
                    invoiceId={invoice.id}
                    number={invoice.invoiceNumber}
                    version={invoice.version}
                    matchId={reapproval && payable ? payable.matchId : match.id}
                    payoutVersionId={payee.id}
                    amountMinor={outstanding}
                    payee={payeeText(payee)}
                    reapproval={reapproval}
                  />
                ) : contributor ? (
                  <p>{tApproval("contributor")}</p>
                ) : !held.has("payments.approve") ? (
                  <p className="text-muted-foreground">{tApproval("noPermission")}</p>
                ) : null}
              </div>
            ) : (
              <p className="text-destructive">{tApproval("noPayee")}</p>
            )
          ) : null}
          {detail.payables.length ? (
            <div className="space-y-1">
              <h3 className="font-semibold">{tApproval("approvals")}</h3>
              <ul className="space-y-1">
                {detail.payables.map((entry) => (
                  <li key={entry.id} className="flex flex-wrap items-center gap-2">
                    <StatusBadge tone={entry.status === "active" ? "success" : "neutral"}>
                      {tStatus(`payable.${entry.status}`)}
                    </StatusBadge>
                    <span>
                      {tApproval("authorised", { amount: formatKES(entry.authorisedMinor) })} ·{" "}
                      {tApproval("payout", { version: entry.payout.versionNo })} ·{" "}
                      {tCommon("byOn", {
                        name: entry.approvedBy.displayName,
                        date: formatDateTime(entry.approvedAt),
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>
      {["submitted", "disputed", "matched"].includes(invoice.status) ? (
        <MakerChecker contributors={detail.contributors} userId={session.user.id} pending />
      ) : null}

      <Card data-testid="settlements">
        <CardHeader>
          <CardTitle>
            <h2>{tSettlement("title")}</h2>
          </CardTitle>
          <CardDescription>{tSettlement("description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {["approved", "partly_settled", "settled"].includes(invoice.status) ? (
            <p className="font-medium" data-testid="outstanding">
              {invoice.status === "settled"
                ? tSettlement("settled")
                : tSettlement("outstanding", {
                    amount: formatKES(invoice.outstandingMinor),
                    total: formatKES(invoice.totalMinor),
                  })}
            </p>
          ) : (
            <p className="text-muted-foreground">{tSettlement("notApproved")}</p>
          )}
          {detail.settlements.length ? (
            <div
              role="region"
              tabIndex={0}
              aria-label={tSettlement("title")}
              className="relative overflow-x-auto rounded-lg border outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <table className="w-full min-w-[560px] text-sm">
                <caption className="sr-only">{tSettlement("title")}</caption>
                <thead>
                  <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                    <th scope="col" className="py-2 pl-3 font-medium">
                      {tSettlement("cols.paidOn")}
                    </th>
                    <th scope="col" className="py-2 font-medium">
                      {tSettlement("cols.method")}
                    </th>
                    <th scope="col" className="py-2 font-medium">
                      {tSettlement("cols.reference")}
                    </th>
                    <th scope="col" className="py-2 text-right font-medium">
                      {tSettlement("cols.amount")}
                    </th>
                    <th scope="col" className="py-2 pr-3 pl-3 font-medium">
                      {tSettlement("cols.recordedBy")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {detail.settlements.map((settlement) => (
                    <tr key={settlement.id} className="border-b last:border-0">
                      <td className="py-2 pl-3">{formatCalendarDate(settlement.paidOn)}</td>
                      <td className="py-2">{tStatus(`method.${settlement.method}`)}</td>
                      <td className="py-2 font-mono text-xs">{settlement.externalReference}</td>
                      <td className="py-2 text-right tabular-nums">
                        {formatKES(settlement.amountMinor)}
                      </td>
                      <td className="py-2 pr-3 pl-3">{settlement.recordedBy.displayName}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-muted-foreground">{tSettlement("none")}</p>
          )}
          {permissions.canSettle ? (
            <SettlementForm
              invoiceId={invoice.id}
              outstandingMinor={invoice.outstandingMinor}
              invoiceDate={invoice.invoiceDate}
              today={nairobiDate()}
            />
          ) : ["approved", "partly_settled"].includes(invoice.status) ? (
            <p className="text-muted-foreground" data-testid="settle-refusal">
              {reapproval
                ? tSettlement("payeeChanged")
                : payable?.approvedBy.id === session.user.id
                  ? tSettlement("approverCannot")
                  : tSettlement("noPermission")}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <section aria-labelledby="invoice-lines" className="space-y-2">
        <h2 id="invoice-lines" className="text-base font-semibold">
          {t("lines")}
        </h2>
        <div
          role="region"
          tabIndex={0}
          aria-label={t("lines")}
          className="relative overflow-x-auto rounded-xl border outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2 pl-4 font-medium">
                  {tCommon("material")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {tCommon("quantity")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {tInvoices("form.unitPrice")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {tMatch("cols.invoicePrice")}
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">
                  {tCommon("subtotal")}
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.id} className="border-b align-top last:border-0">
                  <th scope="row" className="py-2 pl-4 text-left font-medium">
                    {line.material.name}
                  </th>
                  <td className="py-2 pr-2 tabular-nums">
                    {formatQuantity(line.quantity)} {label(line.unit)}
                  </td>
                  <td className="py-2 pr-2 tabular-nums">
                    {tCommon("perUnit", {
                      price: formatKES(line.unitPriceMinor),
                      unit: label(line.unit),
                    })}
                    <span className="block text-xs text-muted-foreground">
                      {tVat(line.vatTreatment)}
                    </span>
                  </td>
                  <td className="py-2 pr-2 tabular-nums">
                    {tCommon("perUnit", {
                      price: formatMinorDecimal(line.netUnitPriceBaseMinor),
                      unit: label(line.material.baseUnit),
                    })}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {formatKES(line.netAmountMinor)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="tabular-nums">
              <tr className="border-t">
                <th scope="row" colSpan={4} className="py-1 pl-4 text-right font-normal">
                  {tCommon("subtotal")}
                </th>
                <td className="py-1 pr-4 text-right">{formatKES(invoice.subtotalMinor)}</td>
              </tr>
              <tr>
                <th scope="row" colSpan={4} className="py-1 pl-4 text-right font-normal">
                  {tCommon("vat", { rate: invoice.vatRatePercent })}
                </th>
                <td className="py-1 pr-4 text-right">{formatKES(invoice.vatMinor)}</td>
              </tr>
              <tr>
                <th scope="row" colSpan={4} className="py-1 pl-4 text-right font-semibold">
                  {tCommon("total")}
                </th>
                <td className="py-1 pr-4 text-right font-semibold">
                  {formatKES(invoice.totalMinor)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      <section aria-labelledby="invoice-documents" className="space-y-2">
        <h2 id="invoice-documents" className="text-base font-semibold">
          {t("documents")}
        </h2>
        {uploadFailed && !detail.documents.length ? (
          <p role="alert" className="text-sm text-destructive">
            {t("uploadFailed")}
          </p>
        ) : null}
        {detail.documents.length ? (
          <ul className="space-y-1 text-sm">
            {detail.documents.map((document) => (
              <li key={document.id}>
                <a
                  href={`/api/v1/procurement/documents/${document.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  {tCommon("openDocument", { kind: document.contentType })}
                </a>{" "}
                <span className="text-muted-foreground">
                  {tCommon("byOn", {
                    name: document.uploadedBy.displayName,
                    date: formatDateTime(document.uploadedAt),
                  })}
                  {document.scanStatus === "not_scanned" ? ` · ${tCommon("notScanned")}` : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{tCommon("noDocument")}</p>
        )}
        {permissions.canAttach ? (
          <DocumentUpload
            id="invoice-document"
            path={`${path}/document`}
            label={tCommon("attach")}
          />
        ) : null}
      </section>

      <Timeline
        events={[
          {
            label: t("events.recorded"),
            at: invoice.createdAt,
            by: invoice.createdBy.displayName,
          },
          {
            label: t("events.submitted"),
            at: invoice.submittedAt,
            by: invoice.submittedBy?.displayName,
          },
          {
            label: t("events.cancelled", { reason: invoice.cancelReason ?? "" }),
            at: invoice.cancelledAt,
          },
        ]}
      />
    </div>
  );
}
