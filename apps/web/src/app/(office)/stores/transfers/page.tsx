import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { TRANSFER_STATUSES, type TransferStatus } from "@pm-buddy/types";
import { transfersResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { apiQuery, listHrefs, Pager } from "@/components/procurement/p2p/list-filters";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { ScrollTable, StoresEyebrow, StoresSubnav } from "@/components/stores/stores-subnav";
import { Button } from "@/components/ui/button";
import { formatDateTime, formatKES } from "@/lib/format";
import { pickParam } from "@/lib/p2p";
import { loadOrRedirect } from "@/lib/p2p-server";
import { requireSession } from "@/lib/server-api";
import { isUuid, transferTone } from "@/lib/stores";

export async function generateMetadata() {
  const t = await getTranslations("stores.transfers");
  return { title: t("title") };
}

const selectClass =
  "h-9 max-w-[16rem] rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

/** Inter-site transfers: in transit, received, disputed (D5.3). */
export default async function TransfersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const statusParam = pickParam(raw, "status");
  const status = TRANSFER_STATUSES.includes(statusParam as TransferStatus)
    ? statusParam
    : undefined;
  const cursor = isUuid(pickParam(raw, "cursor")) ? pickParam(raw, "cursor") : undefined;
  const path = `/stores/transfers${apiQuery({ status, cursor })}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await loadOrRedirect(
    `/stock-transfers${apiQuery({ status, cursor })}`,
    transfersResponseSchema,
    path,
  );
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("stores.transfers");
  const tCommon = await getTranslations("stores.common");
  const tStatus = await getTranslations("stores.status");
  const { transfers, page } = result.data;
  const hrefs = listHrefs("/stores/transfers", { status }, page.nextCursor);

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={<StoresEyebrow />} title={t("title")} description={t("description")} />
      <StoresSubnav current="transfers" />
      <form
        method="get"
        action="/stores/transfers"
        className="flex flex-wrap items-end gap-3"
        role="search"
      >
        <div className="space-y-1.5">
          <label htmlFor="transfer-status" className="block text-sm font-medium">
            {tCommon("status")}
          </label>
          <select
            id="transfer-status"
            name="status"
            defaultValue={status ?? ""}
            className={selectClass}
          >
            <option value="">{t("allStatuses")}</option>
            {TRANSFER_STATUSES.map((entry) => (
              <option key={entry} value={entry}>
                {tStatus(`transfer.${entry}`)}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" variant="secondary">
          {tCommon("apply")}
        </Button>
        {status ? (
          <Button asChild variant="ghost">
            <Link href="/stores/transfers">{tCommon("clear")}</Link>
          </Button>
        ) : null}
      </form>
      {transfers.length === 0 ? (
        <p className="rounded-xl border border-dashed p-8 text-center font-medium">{t("empty")}</p>
      ) : (
        <ScrollTable label={t("title")} minWidth={760}>
          <thead>
            <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
              <th scope="col" className="py-2 pl-4 font-medium">
                {t("cols.number")}
              </th>
              <th scope="col" className="py-2 pr-2 font-medium">
                {t("cols.from")}
              </th>
              <th scope="col" className="py-2 pr-2 font-medium">
                {t("cols.to")}
              </th>
              <th scope="col" className="py-2 pr-2 font-medium">
                {t("cols.dispatched")}
              </th>
              <th scope="col" className="py-2 pr-2 text-right font-medium">
                {t("cols.value")}
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                {tCommon("status")}
              </th>
            </tr>
          </thead>
          <tbody>
            {transfers.map((transfer) => (
              <tr key={transfer.id} className="border-b align-top last:border-0">
                <th scope="row" className="py-2 pl-4 text-left font-mono font-medium">
                  <Link
                    href={`/stores/transfers/${transfer.id}`}
                    className="underline underline-offset-4"
                  >
                    {transfer.number}
                  </Link>
                </th>
                <td className="py-2 pr-2">{transfer.fromStore.name}</td>
                <td className="py-2 pr-2">{transfer.toStore.name}</td>
                <td className="py-2 pr-2">{formatDateTime(transfer.dispatchedAt)}</td>
                <td className="py-2 pr-2 text-right tabular-nums">
                  {formatKES(transfer.dispatchedValueMinor)}
                </td>
                <td className="py-2 pr-4">
                  <StatusBadge tone={transferTone[transfer.status]}>
                    {tStatus(`transfer.${transfer.status}`)}
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
