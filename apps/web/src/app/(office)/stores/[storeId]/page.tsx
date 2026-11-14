import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArrowLeftRight, ClipboardCheck, PackageMinus, Trash2 } from "lucide-react";
import type { StandardUnitCode } from "@pm-buddy/types";
import { movementsResponseSchema, storeDetailResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { StoresAction } from "@/components/stores/stores-action";
import { ScrollTable, StoresEyebrow, StoresSubnav } from "@/components/stores/stores-subnav";
import { Button } from "@/components/ui/button";
import { formatDateTime, formatKES } from "@/lib/format";
import { loadOrRedirect, unitOptions } from "@/lib/p2p-server";
import { formatMinorDecimal, unitLabel } from "@/lib/procurement";
import { requireSession, serverApi } from "@/lib/server-api";
import { formatStock, isUuid, movementKindTone, movementTone } from "@/lib/stores";

export async function generateMetadata() {
  const t = await getTranslations("stores.store");
  return { title: t("metaTitle") };
}

/** A store: balances at weighted average cost, stock in transit and recent movements (D5.3). */
export default async function StorePage({ params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;
  if (!isUuid(storeId)) notFound();
  const path = `/stores/${storeId}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [result, movements, units] = await Promise.all([
    loadOrRedirect(`/stores/${storeId}`, storeDetailResponseSchema, path),
    serverApi(`/stock-movements?storeId=${storeId}&limit=10`, movementsResponseSchema),
    unitOptions(),
  ]);
  if (!result.ok) {
    if (result.status === 404 || result.status === 400) notFound();
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  }
  const t = await getTranslations("stores.store");
  const tCommon = await getTranslations("stores.common");
  const tStatus = await getTranslations("stores.status");
  const tUnits = await getTranslations("catalogue.units");
  const label = (code: string) => unitLabel(code, (unit: StandardUnitCode) => tUnits(unit), units);
  const { store, balances, inTransit, openStockTake, permissions } = result.data;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<StoresEyebrow trail={{ href: "/stores", label: tCommon("allStores") }} />}
        title={store.name}
        description={t("description", {
          project: `${store.project.code} · ${store.project.name}`,
          site: store.site.name,
          keeper: store.storekeeper?.displayName ?? t("noStorekeeper"),
        })}
        actions={
          <>
            {permissions.canIssue ? (
              <Button asChild>
                <Link href={`/stores/${store.id}/issue`}>
                  <PackageMinus aria-hidden /> {t("issue")}
                </Link>
              </Button>
            ) : null}
            {permissions.canWaste ? (
              <Button asChild variant="outline">
                <Link href={`/stores/${store.id}/wastage`}>
                  <Trash2 aria-hidden /> {t("wastage")}
                </Link>
              </Button>
            ) : null}
            {permissions.canTransfer ? (
              <Button asChild variant="outline">
                <Link href={`/stores/${store.id}/transfer`}>
                  <ArrowLeftRight aria-hidden /> {t("transfer")}
                </Link>
              </Button>
            ) : null}
            {permissions.canCount ? (
              <StoresAction
                path="/stock-takes"
                entity="stockTake"
                body={{ storeId: store.id }}
                openResult
                icon={<ClipboardCheck aria-hidden />}
                text={{
                  button: t("count"),
                  title: t("countTitle"),
                  description: t("countDescription"),
                  confirm: t("count"),
                }}
              />
            ) : null}
          </>
        }
      />
      <StoresSubnav current={null} />
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <span>{t("value", { value: formatKES(store.valueMinor) })}</span>
        <Link href={`/stores/${store.id}/ledger`} className="underline underline-offset-4">
          {t("ledger")}
        </Link>
        {permissions.canEditReorderLevels ? (
          <Link
            href={`/stores/${store.id}/reorder-levels`}
            className="underline underline-offset-4"
          >
            {t("reorder")}
          </Link>
        ) : null}
        {openStockTake ? (
          <Link
            href={`/stores/stock-takes/${openStockTake.id}`}
            className="underline underline-offset-4"
          >
            {t("openCount", { number: openStockTake.number })}
          </Link>
        ) : null}
      </p>

      <section aria-labelledby="balances" className="space-y-3">
        <h2 id="balances" className="text-lg font-semibold">
          {t("balances")}
        </h2>
        {balances.length === 0 ? (
          <p className="rounded-xl border border-dashed p-8 text-center font-medium">
            {t("noStock")}
          </p>
        ) : (
          <ScrollTable label={t("balances")} minWidth={680}>
            <thead>
              <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2 pl-4 font-medium">
                  {tCommon("material")}
                </th>
                <th scope="col" className="py-2 pr-2 text-right font-medium">
                  {t("cols.onHand")}
                </th>
                <th scope="col" className="py-2 pr-2 text-right font-medium">
                  {t("cols.averageCost")}
                </th>
                <th scope="col" className="py-2 pr-2 text-right font-medium">
                  {t("cols.value")}
                </th>
                <th scope="col" className="py-2 pr-2 text-right font-medium">
                  {t("cols.reorder")}
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  {t("cols.status")}
                </th>
              </tr>
            </thead>
            <tbody>
              {balances.map((row) => (
                <tr key={row.material.id} className="border-b align-top last:border-0">
                  <th scope="row" className="py-2 pl-4 text-left font-medium">
                    <Link
                      href={`/stores/${store.id}/ledger?materialId=${row.material.id}`}
                      className="underline underline-offset-4"
                    >
                      {row.material.name}
                    </Link>
                  </th>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {formatStock(row.quantity)} {label(row.material.baseUnit)}
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {row.averageUnitCostMinor === null
                      ? "—"
                      : t("perUnit", {
                          price: formatMinorDecimal(row.averageUnitCostMinor),
                          unit: label(row.material.baseUnit),
                        })}
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums">{formatKES(row.valueMinor)}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {row.reorderLevel === null ? "—" : formatStock(row.reorderLevel)}
                  </td>
                  <td className="py-2 pr-4">
                    {row.low ? <StatusBadge tone="warning">{tStatus("low")}</StatusBadge> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
        )}
      </section>

      {inTransit.length ? (
        <section aria-labelledby="in-transit" className="space-y-3">
          <h2 id="in-transit" className="text-lg font-semibold">
            {t("inTransit")}
          </h2>
          <ul className="space-y-2">
            {inTransit.map((entry) => (
              <li key={entry.transfer.id} className="space-y-1 rounded-lg border p-3 text-sm">
                <p className="font-medium">
                  <Link
                    href={`/stores/transfers/${entry.transfer.id}`}
                    className="underline underline-offset-4"
                  >
                    {entry.transfer.number}
                  </Link>{" "}
                  ·{" "}
                  {entry.direction === "in"
                    ? t("arrivingFrom", { store: entry.otherStore.name })
                    : t("sentTo", { store: entry.otherStore.name })}
                </p>
                <p className="text-muted-foreground">
                  {entry.lines
                    .map(
                      (line) =>
                        `${line.material.name} ${formatStock(line.baseQuantity)} ${label(line.material.baseUnit)}`,
                    )
                    .join(" · ")}{" "}
                  · {formatKES(entry.valueMinor)} · {formatDateTime(entry.dispatchedAt)}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="recent" className="space-y-3">
        <h2 id="recent" className="text-lg font-semibold">
          {t("recent")}
        </h2>
        {!movements.ok || movements.data.movements.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noMovements")}</p>
        ) : (
          <ul className="space-y-2">
            {movements.data.movements.map((movement) => (
              <li
                key={movement.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/stores/movements/${movement.id}`}
                    className="font-mono font-medium underline underline-offset-4"
                  >
                    {movement.number}
                  </Link>
                  <StatusBadge tone={movementKindTone[movement.kind]}>
                    {tStatus(`movementKind.${movement.kind}`)}
                  </StatusBadge>
                  {movement.status === "reversed" ? (
                    <StatusBadge tone={movementTone[movement.status]}>
                      {tStatus(`movement.${movement.status}`)}
                    </StatusBadge>
                  ) : null}
                </span>
                <span className="text-muted-foreground">
                  {movement.bqItem
                    ? `${movement.bqItem.ref ?? ""} ${Array.from(movement.bqItem.description).slice(0, 40).join("")}`
                    : (movement.gang?.name ?? "")}{" "}
                  · {formatKES(movement.totalValueMinor)} · {formatDateTime(movement.recordedAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
