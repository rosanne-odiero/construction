import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { STOCK_ENTRY_KINDS, type StandardUnitCode, type StockEntryKind } from "@pm-buddy/types";
import { ledgerResponseSchema, storeDetailResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { apiQuery, listHrefs, Pager } from "@/components/procurement/p2p/list-filters";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { ScrollTable, StoresEyebrow } from "@/components/stores/stores-subnav";
import { Button } from "@/components/ui/button";
import { formatCalendarDate } from "@/lib/format";
import { loadOrRedirect, unitOptions } from "@/lib/p2p-server";
import { formatMinorDecimal, unitLabel } from "@/lib/procurement";
import { pickParam } from "@/lib/p2p";
import { requireSession, serverApi } from "@/lib/server-api";
import { entryTone, formatStock, isUuid } from "@/lib/stores";

export async function generateMetadata() {
  const t = await getTranslations("stores.ledger");
  return { title: t("title") };
}

const selectClass =
  "h-9 max-w-[16rem] rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";
const SOURCE_HREF = {
  grn: "/procurement/grns",
  movement: "/stores/movements",
  transfer: "/stores/transfers",
  stock_take: "/stores/stock-takes",
} as const;

/** A store's append-only stock ledger with filters and cursor pages (D5.3). */
export default async function LedgerPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { storeId } = await params;
  if (!isUuid(storeId)) notFound();
  const raw = await searchParams;
  const materialId = isUuid(pickParam(raw, "materialId"))
    ? pickParam(raw, "materialId")
    : undefined;
  const kindParam = pickParam(raw, "kind");
  const kind = STOCK_ENTRY_KINDS.includes(kindParam as StockEntryKind) ? kindParam : undefined;
  const cursor = isUuid(pickParam(raw, "cursor")) ? pickParam(raw, "cursor") : undefined;
  const path = `/stores/${storeId}/ledger${apiQuery({ materialId, kind, cursor })}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [result, store, units] = await Promise.all([
    loadOrRedirect(
      `/stores/${storeId}/ledger${apiQuery({ materialId, kind, cursor })}`,
      ledgerResponseSchema,
      path,
    ),
    serverApi(`/stores/${storeId}`, storeDetailResponseSchema),
    unitOptions(),
  ]);
  if (!result.ok) {
    if (result.status === 404 || result.status === 400) notFound();
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  }
  const t = await getTranslations("stores.ledger");
  const tCommon = await getTranslations("stores.common");
  const tStatus = await getTranslations("stores.status");
  const tUnits = await getTranslations("catalogue.units");
  const label = (code: string) => unitLabel(code, (unit: StandardUnitCode) => tUnits(unit), units);
  const { entries, page } = result.data;
  const hrefs = listHrefs(`/stores/${storeId}/ledger`, { materialId, kind }, page.nextCursor);
  const materials = store.ok ? store.data.balances.map((row) => row.material) : [];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <StoresEyebrow trail={{ href: `/stores/${storeId}`, label: result.data.store.name }} />
        }
        title={t("title")}
        description={t("description")}
      />
      <form
        method="get"
        action={`/stores/${storeId}/ledger`}
        className="flex flex-wrap items-end gap-3"
        role="search"
      >
        <div className="space-y-1.5">
          <label htmlFor="ledger-material" className="block text-sm font-medium">
            {tCommon("material")}
          </label>
          <select
            id="ledger-material"
            name="materialId"
            defaultValue={materialId ?? ""}
            className={selectClass}
          >
            <option value="">{t("allMaterials")}</option>
            {materials.map((material) => (
              <option key={material.id} value={material.id}>
                {material.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="ledger-kind" className="block text-sm font-medium">
            {t("kind")}
          </label>
          <select id="ledger-kind" name="kind" defaultValue={kind ?? ""} className={selectClass}>
            <option value="">{t("allKinds")}</option>
            {STOCK_ENTRY_KINDS.map((entry) => (
              <option key={entry} value={entry}>
                {tStatus(`entryKind.${entry}`)}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" variant="secondary">
          {tCommon("apply")}
        </Button>
        {materialId || kind ? (
          <Button asChild variant="ghost">
            <Link href={`/stores/${storeId}/ledger`}>{tCommon("clear")}</Link>
          </Button>
        ) : null}
      </form>
      {entries.length === 0 ? (
        <p className="rounded-xl border border-dashed p-8 text-center font-medium">{t("empty")}</p>
      ) : (
        <ScrollTable label={t("title")} minWidth={900}>
          <thead>
            <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
              <th scope="col" className="py-2 pl-4 font-medium">
                {t("cols.date")}
              </th>
              <th scope="col" className="py-2 pr-2 font-medium">
                {t("cols.kind")}
              </th>
              <th scope="col" className="py-2 pr-2 font-medium">
                {tCommon("material")}
              </th>
              <th scope="col" className="py-2 pr-2 text-right font-medium">
                {t("cols.quantity")}
              </th>
              <th scope="col" className="py-2 pr-2 text-right font-medium">
                {t("cols.value")}
              </th>
              <th scope="col" className="py-2 pr-2 text-right font-medium">
                {t("cols.balance")}
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                {t("cols.source")}
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id} className="border-b align-top last:border-0">
                <td className="py-2 pl-4">
                  {formatCalendarDate(entry.businessDate)}
                  <span className="block text-xs text-muted-foreground">
                    {entry.recordedBy.displayName}
                  </span>
                </td>
                <td className="py-2 pr-2">
                  <span className="flex flex-wrap gap-1">
                    <StatusBadge tone={entryTone[entry.kind]}>
                      {tStatus(`entryKind.${entry.kind}`)}
                    </StatusBadge>
                    {entry.reversesEntryId ? (
                      <StatusBadge tone="neutral">{t("correction")}</StatusBadge>
                    ) : null}
                  </span>
                </td>
                <td className="py-2 pr-2">
                  {entry.material.name}
                  {entry.bqItem ? (
                    <span className="block text-xs text-muted-foreground">
                      {t("toItem", {
                        item: `${entry.bqItem.ref ?? ""} ${Array.from(entry.bqItem.description).slice(0, 48).join("")}`.trim(),
                      })}
                    </span>
                  ) : null}
                </td>
                <td className="py-2 pr-2 text-right tabular-nums">
                  {formatStock(entry.quantity)} {label(entry.material.baseUnit)}
                </td>
                <td className="py-2 pr-2 text-right tabular-nums">
                  {formatMinorDecimal(entry.valueMinor)}
                </td>
                <td className="py-2 pr-2 text-right tabular-nums">
                  {formatStock(entry.balanceQuantity)}
                  <span className="block text-xs text-muted-foreground">
                    {formatMinorDecimal(entry.balanceValueMinor)}
                  </span>
                </td>
                <td className="py-2 pr-4">
                  <Link
                    href={`${SOURCE_HREF[entry.source.type]}/${entry.source.id}`}
                    className="font-mono underline underline-offset-4"
                  >
                    {entry.source.number}
                  </Link>
                  <span className="block text-xs text-muted-foreground">#{entry.seq}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </ScrollTable>
      )}
      <Pager
        label={t("title")}
        firstHref={hrefs.first}
        nextHref={hrefs.next}
        paged={Boolean(cursor)}
      />
    </div>
  );
}
