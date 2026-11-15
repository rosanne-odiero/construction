import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { stockTakesResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { listHrefs, Pager } from "@/components/procurement/p2p/list-filters";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { ScrollTable, StoresEyebrow, StoresSubnav } from "@/components/stores/stores-subnav";
import { formatDateTime } from "@/lib/format";
import { pickParam } from "@/lib/p2p";
import { loadOrRedirect } from "@/lib/p2p-server";
import { requireSession } from "@/lib/server-api";
import { isUuid, stockTakeTone } from "@/lib/stores";

export async function generateMetadata() {
  const t = await getTranslations("stores.stockTakes");
  return { title: t("title") };
}

/** Stock takes: count sheets, submissions waiting for approval, approved counts (D5.3). */
export default async function StockTakesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const cursor = isUuid(pickParam(raw, "cursor")) ? pickParam(raw, "cursor") : undefined;
  const path = `/stores/stock-takes${cursor ? `?cursor=${cursor}` : ""}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await loadOrRedirect(
    `/stock-takes${cursor ? `?cursor=${cursor}` : ""}`,
    stockTakesResponseSchema,
    path,
  );
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("stores.stockTakes");
  const tCommon = await getTranslations("stores.common");
  const tStatus = await getTranslations("stores.status");
  const { stockTakes, page } = result.data;
  const hrefs = listHrefs("/stores/stock-takes", {}, page.nextCursor);

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={<StoresEyebrow />} title={t("title")} description={t("description")} />
      <StoresSubnav current="stockTakes" />
      {stockTakes.length === 0 ? (
        <p className="rounded-xl border border-dashed p-8 text-center font-medium">{t("empty")}</p>
      ) : (
        <ScrollTable label={t("title")} minWidth={680}>
          <thead>
            <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
              <th scope="col" className="py-2 pl-4 font-medium">
                {t("cols.number")}
              </th>
              <th scope="col" className="py-2 pr-2 font-medium">
                {tCommon("store")}
              </th>
              <th scope="col" className="py-2 pr-2 font-medium">
                {t("cols.started")}
              </th>
              <th scope="col" className="py-2 pr-2 text-right font-medium">
                {t("cols.counted")}
              </th>
              <th scope="col" className="py-2 pr-2 text-right font-medium">
                {t("cols.variances")}
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                {tCommon("status")}
              </th>
            </tr>
          </thead>
          <tbody>
            {stockTakes.map((take) => (
              <tr key={take.id} className="border-b align-top last:border-0">
                <th scope="row" className="py-2 pl-4 text-left font-mono font-medium">
                  <Link
                    href={`/stores/stock-takes/${take.id}`}
                    className="underline underline-offset-4"
                  >
                    {take.number}
                  </Link>
                </th>
                <td className="py-2 pr-2">{take.store.name}</td>
                <td className="py-2 pr-2">{formatDateTime(take.createdAt)}</td>
                <td className="py-2 pr-2 text-right tabular-nums">
                  {take.countedCount}/{take.lineCount}
                </td>
                <td className="py-2 pr-2 text-right tabular-nums">{take.varianceCount}</td>
                <td className="py-2 pr-4">
                  <StatusBadge tone={stockTakeTone[take.status]}>
                    {tStatus(`stockTake.${take.status}`)}
                  </StatusBadge>
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
