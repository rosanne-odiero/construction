import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { FileText, Printer, Receipt, RotateCcw, Truck } from "lucide-react";
import type { StandardUnitCode } from "@pm-buddy/types";
import { lpoDetailResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { etimsTone } from "@/components/procurement/tones";
import { LpoDeliveryDialog } from "@/components/procurement/p2p/lpo-panels";
import { MakerChecker } from "@/components/procurement/p2p/maker-checker";
import { P2pEyebrow } from "@/components/procurement/p2p/p2p-subnav";
import { RecordActions, type RecordAction } from "@/components/procurement/p2p/record-actions";
import { Timeline } from "@/components/procurement/p2p/timeline";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCalendarDate, formatDateTime, formatKES } from "@/lib/format";
import {
  deliveryTone,
  formatQuantity,
  grnTone,
  invoiceTone,
  isUuid,
  locationTone,
  lpoTone,
} from "@/lib/p2p";
import { loadOrRedirect, sitesByProject, unitOptions } from "@/lib/p2p-server";
import { formatMinorDecimal, unitLabel } from "@/lib/procurement";
import { requireSession } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("p2p.lpos");
  return { title: t("title") };
}

/**
 * An LPO (D5.2): the supplier snapshot (masked KRA PIN, eTIMS status), delivery, lines with
 * what was received and invoiced, totals, the commitment, deliveries, invoices and commands.
 */
export default async function LpoPage({ params }: { params: Promise<{ lpoId: string }> }) {
  const { lpoId } = await params;
  if (!isUuid(lpoId)) notFound();
  const path = `/procurement/lpos/${lpoId}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [result, units] = await Promise.all([
    loadOrRedirect(path, lpoDetailResponseSchema, path),
    unitOptions(),
  ]);
  if (!result.ok) {
    if (result.status === 404 || result.status === 400) notFound();
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  }
  const { lpo, lines, grns, invoices, commitment, contributors, permissions } = result.data;
  const t = await getTranslations("p2p.lpos");
  const tCommon = await getTranslations("p2p.common");
  const tStatus = await getTranslations("p2p.status");
  const tEtims = await getTranslations("suppliers.etims");
  const tVat = await getTranslations("catalogue.detail.vat");
  const tUnits = await getTranslations("catalogue.units");
  const label = (code: string) => unitLabel(code, (unit: StandardUnitCode) => tUnits(unit), units);
  const sites =
    lpo.status === "draft" && permissions.canManage
      ? ((await sitesByProject([lpo.project.id]))[lpo.project.id] ?? [])
      : [];
  const recorded = grns.filter((grn) => grn.status === "recorded");
  const live = invoices.filter((invoice) => invoice.status !== "cancelled");

  const actions: RecordAction[] = [];
  if (lpo.status === "draft" && permissions.canManage)
    actions.push({ action: "submit", primary: true });
  if (permissions.canApprove)
    actions.push(
      { action: "approve", primary: true, stepUp: true },
      { action: "return", reason: true, stepUp: true },
    );
  if (
    permissions.canManage &&
    (lpo.status === "draft" ||
      lpo.status === "submitted" ||
      (lpo.status === "approved" && !recorded.length && !live.length))
  )
    actions.push({ action: "cancel", reason: true, destructive: true });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<P2pEyebrow trail={{ href: "/procurement/lpos", label: t("title") }} />}
        title={lpo.number}
        description={`${lpo.project.code} · ${lpo.project.name} · ${lpo.supplier.name}`}
        actions={
          <>
            <StatusBadge tone={lpoTone[lpo.status]}>{tStatus(`lpo.${lpo.status}`)}</StatusBadge>
            {lpo.status === "approved" ? (
              <StatusBadge tone={deliveryTone[lpo.deliveryState]}>
                {tStatus(`delivery.${lpo.deliveryState}`)}
              </StatusBadge>
            ) : null}
            {lpo.status === "draft" && permissions.canManage ? (
              <LpoDeliveryDialog
                lpoId={lpo.id}
                number={lpo.number}
                version={lpo.version}
                sites={sites}
                initial={{
                  siteId: lpo.deliverySite?.id ?? null,
                  date: lpo.deliveryDate,
                  terms: lpo.terms,
                }}
              />
            ) : null}
            <RecordActions
              entity="lpo"
              basePath={path}
              number={lpo.number}
              version={lpo.version}
              actions={actions}
            />
            <Button asChild variant="outline">
              <Link href={`${path}/print`}>
                <Printer aria-hidden /> {t("detail.printView")}
              </Link>
            </Button>
            {permissions.canReceive ? (
              <Button asChild>
                <Link href={`/procurement/grns/new?lpo=${lpo.id}`}>
                  <Truck aria-hidden /> {t("detail.receive")}
                </Link>
              </Button>
            ) : null}
            {permissions.canInvoice ? (
              <Button asChild variant="outline">
                <Link href={`/procurement/invoices/new?lpo=${lpo.id}`}>
                  <Receipt aria-hidden /> {t("detail.invoice")}
                </Link>
              </Button>
            ) : null}
          </>
        }
      />
      {lpo.status === "submitted" ? (
        <MakerChecker contributors={contributors} userId={session.user.id} pending />
      ) : null}
      {lpo.returnReason && lpo.status === "draft" ? (
        <p className="rounded-lg border border-warning/40 p-3 text-sm" role="note">
          {t("detail.events.returned", { reason: lpo.returnReason })}
        </p>
      ) : null}
      {lpo.status === "cancelled" ? (
        <div className="space-y-2 rounded-lg border p-3 text-sm" role="note">
          <p>{t("detail.events.cancelled", { reason: lpo.cancelReason ?? "" })}</p>
          <p className="text-muted-foreground">{t("detail.reissueHint")}</p>
          <Button asChild size="sm" variant="outline">
            <Link href={`/procurement/rfqs/${lpo.rfq.id}`}>
              <RotateCcw aria-hidden /> {t("detail.reissue", { number: lpo.rfq.number })}
            </Link>
          </Button>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card data-testid="lpo-supplier">
          <CardHeader>
            <CardTitle>
              <h2>{t("detail.supplierTitle")}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p className="font-medium">
              {lpo.supplier.name}{" "}
              <Link
                href={`/suppliers/${lpo.supplier.id}`}
                className="font-mono text-xs text-muted-foreground underline"
              >
                {lpo.supplier.code}
              </Link>
            </p>
            <p>
              {t("detail.kraPin")}:{" "}
              <span className="font-mono">{lpo.supplier.kraPinMasked ?? t("detail.noPin")}</span>
            </p>
            <p className="flex items-center gap-2">
              {t("detail.etims")}:{" "}
              <StatusBadge tone={etimsTone[lpo.supplier.etimsStatus]}>
                {tEtims(lpo.supplier.etimsStatus)}
              </StatusBadge>
            </p>
            <p>{t("detail.creditDays", { days: lpo.creditDays })}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("detail.deliveryTitle")}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p>
              {t("detail.deliverySite")}: {lpo.deliverySite?.name ?? t("detail.notSet")}
            </p>
            <p>
              {t("detail.deliveryDate")}:{" "}
              {lpo.deliveryDate ? formatCalendarDate(lpo.deliveryDate) : t("detail.notSet")}
            </p>
            <p className="whitespace-pre-line">
              {t("detail.terms")}: {lpo.terms ?? t("detail.noTerms")}
            </p>
            <p className="text-muted-foreground">
              <Link href={`/procurement/rfqs/${lpo.rfq.id}`} className="underline">
                {t("detail.rfq", { number: lpo.rfq.number })}
              </Link>
              {lpo.replacesLpo ? (
                <>
                  {" · "}
                  <Link href={`/procurement/lpos/${lpo.replacesLpo.id}`} className="underline">
                    {t("detail.replaces", { number: lpo.replacesLpo.number })}
                  </Link>
                </>
              ) : null}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("detail.commitment")}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-1 text-sm tabular-nums">
              <dt>{t("detail.committed")}</dt>
              <dd className="text-right">{formatKES(commitment.committedMinor)}</dd>
              <dt>{t("detail.accrued")}</dt>
              <dd className="text-right">{formatKES(commitment.accruedMinor)}</dd>
              <dt className="font-medium">{t("detail.open")}</dt>
              <dd className="text-right font-medium">{formatKES(commitment.openMinor)}</dd>
            </dl>
          </CardContent>
        </Card>
      </div>

      <section aria-labelledby="lpo-lines" className="space-y-2">
        <h2 id="lpo-lines" className="text-base font-semibold">
          {t("detail.lines")}
        </h2>
        <div
          role="region"
          tabIndex={0}
          aria-label={t("detail.lines")}
          className="relative overflow-x-auto rounded-xl border outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2 pl-4 font-medium">
                  {tCommon("material")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {tCommon("quantity")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("detail.price")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("detail.netPerBase")}
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">
                  {t("detail.net")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("detail.received")}
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  {t("detail.invoiced")}
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.id} className="border-b align-top last:border-0">
                  <th scope="row" className="py-2 pl-4 text-left font-medium">
                    {line.material.name}
                    {line.bqItem ? (
                      <span className="block text-xs font-normal text-muted-foreground">
                        {line.bqItem.ref ? `${line.bqItem.ref} · ` : ""}
                        {line.bqItem.description}
                      </span>
                    ) : null}
                  </th>
                  <td className="py-2 pr-2 tabular-nums">
                    {formatQuantity(line.quantity)} {label(line.unit)}
                  </td>
                  <td className="py-2 pr-2 tabular-nums">
                    {tCommon("perUnit", {
                      price: formatKES(line.unitPriceMinor),
                      unit: label(line.priceUnit),
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
                  <td className="py-2 pr-2 tabular-nums">
                    {formatQuantity(line.receivedBaseQuantity)} /{" "}
                    {formatQuantity(line.baseQuantity)} {label(line.material.baseUnit)}
                  </td>
                  <td className="py-2 pr-4 tabular-nums">
                    {formatQuantity(line.invoicedBaseQuantity)} {label(line.material.baseUnit)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="tabular-nums">
              <tr className="border-t">
                <th scope="row" colSpan={4} className="py-1 pl-4 text-right font-normal">
                  {tCommon("subtotal")}
                </th>
                <td className="py-1 pr-4 text-right">{formatKES(lpo.subtotalMinor)}</td>
                <td colSpan={2} />
              </tr>
              <tr>
                <th scope="row" colSpan={4} className="py-1 pl-4 text-right font-normal">
                  {tCommon("vat", { rate: lpo.vatRatePercent })}
                </th>
                <td className="py-1 pr-4 text-right">{formatKES(lpo.vatMinor)}</td>
                <td colSpan={2} />
              </tr>
              <tr>
                <th scope="row" colSpan={4} className="py-1 pl-4 text-right font-semibold">
                  {tCommon("total")}
                </th>
                <td className="py-1 pr-4 text-right font-semibold">{formatKES(lpo.totalMinor)}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section aria-labelledby="lpo-grns" className="space-y-2">
          <h2 id="lpo-grns" className="text-base font-semibold">
            {t("detail.grns")}
          </h2>
          {grns.length ? (
            <ul className="space-y-1 text-sm">
              {grns.map((grn) => (
                <li key={grn.id} className="flex flex-wrap items-center gap-2">
                  <Link href={`/procurement/grns/${grn.id}`} className="font-mono underline">
                    {grn.number}
                  </Link>
                  <span className="text-muted-foreground">{formatDateTime(grn.receivedAt)}</span>
                  <StatusBadge tone={grnTone[grn.status]}>
                    {tStatus(`grn.${grn.status}`)}
                  </StatusBadge>
                  <StatusBadge tone={locationTone[grn.locationState]}>
                    {tStatus(`location.${grn.locationState}`)}
                  </StatusBadge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t("detail.noGrns")}</p>
          )}
        </section>
        <section aria-labelledby="lpo-invoices" className="space-y-2">
          <h2 id="lpo-invoices" className="text-base font-semibold">
            {t("detail.invoices")}
          </h2>
          {invoices.length ? (
            <ul className="space-y-1 text-sm">
              {invoices.map((invoice) => (
                <li key={invoice.id} className="flex flex-wrap items-center gap-2">
                  <FileText className="size-4 text-muted-foreground" aria-hidden />
                  <Link href={`/procurement/invoices/${invoice.id}`} className="underline">
                    {invoice.invoiceNumber}
                  </Link>
                  <span className="tabular-nums">{formatKES(invoice.totalMinor)}</span>
                  <StatusBadge tone={invoiceTone[invoice.status]}>
                    {tStatus(`invoice.${invoice.status}`)}
                  </StatusBadge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t("detail.noInvoices")}</p>
          )}
        </section>
      </div>

      <Timeline
        events={[
          { label: t("detail.events.created"), at: lpo.createdAt, by: lpo.createdBy.displayName },
          {
            label: t("detail.events.submitted"),
            at: lpo.submittedAt,
            by: lpo.submittedBy?.displayName,
          },
          {
            label: t("detail.events.approved"),
            at: lpo.approvedAt,
            by: lpo.approvedBy?.displayName,
          },
          {
            label: t("detail.events.cancelled", { reason: lpo.cancelReason ?? "" }),
            at: lpo.cancelledAt,
          },
        ]}
      />
    </div>
  );
}
