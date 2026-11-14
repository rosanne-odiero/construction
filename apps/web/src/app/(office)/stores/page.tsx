import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { AlertTriangle, ArrowLeftRight, ClipboardList, Warehouse } from "lucide-react";
import type { StandardUnitCode } from "@pm-buddy/types";
import { storesResponseSchema, varianceResponseSchema } from "@pm-buddy/validation";
import { KpiCard } from "@/components/kpi-card";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { StoresAction } from "@/components/stores/stores-action";
import { ScrollTable, StoresEyebrow, StoresSubnav } from "@/components/stores/stores-subnav";
import { formatDateTime, formatKES } from "@/lib/format";
import { loadOrRedirect, unitOptions } from "@/lib/p2p-server";
import { unitLabel } from "@/lib/procurement";
import { requireSession, serverApi } from "@/lib/server-api";
import { formatStock } from "@/lib/stores";

export async function generateMetadata() {
  const t = await getTranslations("stores.home");
  return { title: t("title") };
}

/** Stores per site: stock value, low stock, stock in transit and variance alerts (D5.3). */
export default async function StoresPage() {
  const path = "/stores";
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [result, variance, units] = await Promise.all([
    loadOrRedirect("/stores", storesResponseSchema, path),
    serverApi("/stores/variance", varianceResponseSchema),
    unitOptions(),
  ]);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("stores.home");
  const tCommon = await getTranslations("stores.common");
  const tUnits = await getTranslations("catalogue.units");
  const label = (code: string) => unitLabel(code, (unit: StandardUnitCode) => tUnits(unit), units);
  const { stores, sitesWithoutStore, lowStock, totalValueMinor } = result.data;
  const alerts = variance.ok ? variance.data.counts.alert : null;
  const inTransit = stores.reduce((total, store) => total + store.inTransitIn, 0);

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={<StoresEyebrow />} title={t("title")} description={t("description")} />
      <StoresSubnav current="home" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label={t("totalValue")}
          value={formatKES(totalValueMinor)}
          icon={<Warehouse aria-hidden />}
        />
        <KpiCard
          label={t("lowStock")}
          value={String(lowStock.length)}
          icon={<ClipboardList aria-hidden />}
        />
        <KpiCard
          label={t("inTransit")}
          value={String(inTransit)}
          icon={<ArrowLeftRight aria-hidden />}
        />
        <KpiCard
          label={t("alerts")}
          value={alerts === null ? "—" : String(alerts)}
          icon={<AlertTriangle aria-hidden />}
          tone={alerts ? "danger" : "default"}
          hint={alerts ? t("alertsHint") : undefined}
        />
      </div>
      {alerts ? (
        <p
          className="flex flex-wrap items-center gap-2 rounded-xl border border-destructive/30 p-4 text-sm"
          role="status"
        >
          <StatusBadge tone="danger">{t("alertsBadge", { count: alerts })}</StatusBadge>
          <span>{t("alertsNote")}</span>
          <Link
            href="/stores/variance?state=alert"
            className="font-medium underline underline-offset-4"
          >
            {t("reviewAlerts")}
          </Link>
        </p>
      ) : null}

      <section aria-labelledby="stores-list" className="space-y-3">
        <h2 id="stores-list" className="text-lg font-semibold">
          {t("storesTitle")}
        </h2>
        {stores.length === 0 ? (
          <p className="rounded-xl border border-dashed p-8 text-center font-medium">
            {t("noStores")}
          </p>
        ) : (
          <ScrollTable label={t("storesTitle")} minWidth={720}>
            <thead>
              <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2 pl-4 font-medium">
                  {t("cols.store")}
                </th>
                <th scope="col" className="py-2 pr-2 font-medium">
                  {t("cols.project")}
                </th>
                <th scope="col" className="py-2 pr-2 font-medium">
                  {t("cols.storekeeper")}
                </th>
                <th scope="col" className="py-2 pr-2 text-right font-medium">
                  {t("cols.value")}
                </th>
                <th scope="col" className="py-2 pr-2 text-right font-medium">
                  {t("cols.materials")}
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  {t("cols.flags")}
                </th>
              </tr>
            </thead>
            <tbody>
              {stores.map((store) => (
                <tr key={store.id} className="border-b align-top last:border-0">
                  <th scope="row" className="py-2 pl-4 text-left font-medium">
                    <Link href={`/stores/${store.id}`} className="underline underline-offset-4">
                      {store.name}
                    </Link>
                    <span className="block text-xs font-normal text-muted-foreground">
                      {store.lastMovementAt
                        ? t("lastMovement", { when: formatDateTime(store.lastMovementAt) })
                        : t("noMovements")}
                    </span>
                  </th>
                  <td className="py-2 pr-2">
                    {store.project.code} · {store.site.name}
                  </td>
                  <td className="py-2 pr-2">{store.storekeeper?.displayName ?? "—"}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {formatKES(store.valueMinor)}
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums">{store.materialCount}</td>
                  <td className="py-2 pr-4">
                    <span className="flex flex-wrap gap-1">
                      {store.lowStockCount ? (
                        <StatusBadge tone="warning">
                          {t("lowCount", { count: store.lowStockCount })}
                        </StatusBadge>
                      ) : null}
                      {store.inTransitIn ? (
                        <StatusBadge tone="info">
                          {t("arriving", { count: store.inTransitIn })}
                        </StatusBadge>
                      ) : null}
                      {store.inTransitOut ? (
                        <StatusBadge tone="info">
                          {t("leaving", { count: store.inTransitOut })}
                        </StatusBadge>
                      ) : null}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
        )}
      </section>

      <section aria-labelledby="low-stock" className="space-y-3">
        <h2 id="low-stock" className="text-lg font-semibold">
          {t("lowTitle")}
        </h2>
        {lowStock.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("lowEmpty")}</p>
        ) : (
          <ul className="space-y-2">
            {lowStock.map((entry) => (
              <li
                key={`${entry.store.id}-${entry.material.id}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm"
              >
                <span>
                  <Link
                    href={`/stores/${entry.store.id}`}
                    className="font-medium underline underline-offset-4"
                  >
                    {entry.material.name}
                  </Link>{" "}
                  · {entry.store.name}
                </span>
                <span className="tabular-nums">
                  {t("lowLine", {
                    quantity: formatStock(entry.quantity),
                    level: formatStock(entry.reorderLevel),
                    unit: label(entry.material.baseUnit),
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {sitesWithoutStore.length ? (
        <section aria-labelledby="without-store" className="space-y-3">
          <h2 id="without-store" className="text-lg font-semibold">
            {t("withoutStore")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("withoutStoreHint")}</p>
          <ul className="space-y-2">
            {sitesWithoutStore.map((entry) => (
              <li
                key={entry.site.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm"
              >
                <span>
                  {entry.project.code} · {entry.site.name}
                </span>
                {entry.canCreate ? (
                  <StoresAction
                    path="/stores"
                    entity="store"
                    body={{ siteId: entry.site.id }}
                    openResult
                    text={{
                      button: t("create"),
                      title: t("createTitle", { site: entry.site.name }),
                      description: t("createDescription"),
                      confirm: t("create"),
                    }}
                  />
                ) : (
                  <span className="text-muted-foreground">{tCommon("noPermission")}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
