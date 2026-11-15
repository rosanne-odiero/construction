import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { StandardUnitCode } from "@pm-buddy/types";
import { transferResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { StoresAction } from "@/components/stores/stores-action";
import { ScrollTable, StoresEyebrow } from "@/components/stores/stores-subnav";
import { ReceiveForm } from "@/components/stores/transfer-forms";
import { formatDateTime, formatKES } from "@/lib/format";
import { loadOrRedirect, unitOptions } from "@/lib/p2p-server";
import { formatMinorDecimal, unitLabel } from "@/lib/procurement";
import { requireSession } from "@/lib/server-api";
import { formatStock, isUuid, transferTone } from "@/lib/stores";

export async function generateMetadata() {
  const t = await getTranslations("stores.transfers");
  return { title: t("title") };
}

/** A transfer: what was sent and received, the transit loss, receipt, resolution, cancel (D5.3). */
export default async function TransferPage({
  params,
}: {
  params: Promise<{ transferId: string }>;
}) {
  const { transferId } = await params;
  if (!isUuid(transferId)) notFound();
  const path = `/stores/transfers/${transferId}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [result, units] = await Promise.all([
    loadOrRedirect(`/stock-transfers/${transferId}`, transferResponseSchema, path),
    unitOptions(),
  ]);
  if (!result.ok) {
    if (result.status === 404 || result.status === 400) notFound();
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  }
  const t = await getTranslations("stores.transfers");
  const tCommon = await getTranslations("stores.common");
  const tStatus = await getTranslations("stores.status");
  const tUnits = await getTranslations("catalogue.units");
  const label = (code: string) => unitLabel(code, (unit: StandardUnitCode) => tUnits(unit), units);
  const { transfer, permissions } = result.data;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<StoresEyebrow trail={{ href: "/stores/transfers", label: t("title") }} />}
        title={t("detailTitle", { number: transfer.number })}
        description={t("route", { from: transfer.fromStore.name, to: transfer.toStore.name })}
        actions={
          <>
            {permissions.canResolve ? (
              <StoresAction
                path={`/stock-transfers/${transfer.id}/resolve`}
                entity="transfer"
                body={{ version: transfer.version }}
                reason
                primary
                text={{
                  button: t("resolve.button"),
                  title: t("resolve.title", { number: transfer.number }),
                  description: t("resolve.description"),
                  confirm: t("resolve.confirm"),
                }}
              />
            ) : null}
            {permissions.canCancel ? (
              <StoresAction
                path={`/stock-transfers/${transfer.id}/cancel`}
                entity="transfer"
                body={{ version: transfer.version }}
                reason
                destructive
                text={{
                  button: t("cancel.button"),
                  title: t("cancel.title", { number: transfer.number }),
                  description: t("cancel.description"),
                  confirm: t("cancel.confirm"),
                }}
              />
            ) : null}
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={transferTone[transfer.status]}>
          {tStatus(`transfer.${transfer.status}`)}
        </StatusBadge>
        {transfer.transitLossValueMinor ? (
          <StatusBadge tone="danger" className="h-auto whitespace-normal">
            {t("loss", { value: formatKES(transfer.transitLossValueMinor) })}
          </StatusBadge>
        ) : null}
      </div>
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">{t("dispatchedBy")}</dt>
          <dd>
            {transfer.dispatchedBy.displayName} · {formatDateTime(transfer.dispatchedAt)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("value")}</dt>
          <dd>{formatKES(transfer.dispatchedValueMinor)}</dd>
        </div>
        {transfer.receivedBy ? (
          <div>
            <dt className="text-muted-foreground">{t("receivedBy")}</dt>
            <dd>
              {transfer.receivedBy.displayName} ·{" "}
              {transfer.receivedAt ? formatDateTime(transfer.receivedAt) : ""}
            </dd>
          </div>
        ) : null}
        {transfer.resolutionNote ? (
          <div>
            <dt className="text-muted-foreground">{t("resolution")}</dt>
            <dd>
              {transfer.resolvedBy?.displayName}: {transfer.resolutionNote}
            </dd>
          </div>
        ) : null}
        {transfer.cancelReason ? (
          <div>
            <dt className="text-muted-foreground">{t("cancelled")}</dt>
            <dd>
              {transfer.cancelledBy?.displayName}: {transfer.cancelReason}
            </dd>
          </div>
        ) : null}
        {transfer.dispatchNotes ? (
          <div className="sm:col-span-2">
            <dt className="text-muted-foreground">{tCommon("notesLabel")}</dt>
            <dd>{transfer.dispatchNotes}</dd>
          </div>
        ) : null}
      </dl>
      <ScrollTable label={t("lines")} minWidth={680}>
        <thead>
          <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
            <th scope="col" className="py-2 pl-4 font-medium">
              {tCommon("material")}
            </th>
            <th scope="col" className="py-2 pr-2 text-right font-medium">
              {t("cols.sent")}
            </th>
            <th scope="col" className="py-2 pr-2 text-right font-medium">
              {t("cols.received")}
            </th>
            <th scope="col" className="py-2 pr-2 text-right font-medium">
              {t("cols.difference")}
            </th>
            <th scope="col" className="py-2 pr-4 text-right font-medium">
              {t("cols.value")}
            </th>
          </tr>
        </thead>
        <tbody>
          {transfer.lines.map((line) => (
            <tr key={line.id} className="border-b align-top last:border-0">
              <th scope="row" className="py-2 pl-4 text-left font-medium">
                {line.material.name}
                {line.differenceReason ? (
                  <span className="block text-xs font-normal text-muted-foreground">
                    {line.differenceReason}
                  </span>
                ) : null}
              </th>
              <td className="py-2 pr-2 text-right tabular-nums">
                {formatStock(line.baseQuantity)} {label(line.material.baseUnit)}
              </td>
              <td className="py-2 pr-2 text-right tabular-nums">
                {line.receivedBaseQuantity === null ? "—" : formatStock(line.receivedBaseQuantity)}
              </td>
              <td className="py-2 pr-2 text-right tabular-nums">
                {line.differenceBaseQuantity === null
                  ? "—"
                  : formatStock(line.differenceBaseQuantity)}
              </td>
              <td className="py-2 pr-4 text-right tabular-nums">
                {formatMinorDecimal(line.dispatchedValueMinor)}
              </td>
            </tr>
          ))}
        </tbody>
      </ScrollTable>
      {permissions.canReceive ? (
        <section className="max-w-2xl rounded-xl border p-4">
          <ReceiveForm transfer={result.data} units={units} />
        </section>
      ) : null}
    </div>
  );
}
