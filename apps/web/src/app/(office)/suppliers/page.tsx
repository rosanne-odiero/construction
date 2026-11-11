import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Plus, Search } from "lucide-react";
import { ETIMS_STATUSES, SUPPLIER_STATUSES } from "@pm-buddy/types";
import { supplierListQuerySchema, suppliersResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { CatalogueSubnav } from "@/components/procurement/catalogue-subnav";
import { etimsTone, payoutTone, supplierStatusTone } from "@/components/procurement/tones";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatKES } from "@/lib/format";
import { requireSession, serverApi } from "@/lib/server-api";
import { signInHref } from "@/lib/safe-next";

export async function generateMetadata() {
  const t = await getTranslations("suppliers");
  return { title: t("title") };
}

const selectClass =
  "h-9 rounded-md border border-input bg-background px-3 text-sm shadow-xs focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 outline-none";

/** The company's suppliers with masked identifiers and payout verification state (D5.1). */
export default async function SuppliersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const pick = (key: string) =>
    typeof raw[key] === "string" && raw[key].trim() ? raw[key].trim() : undefined;
  const parsed = supplierListQuerySchema.safeParse({
    search: pick("search"),
    status: pick("status"),
    etims: pick("etims"),
    cursor: pick("cursor"),
  });
  const query = parsed.success ? parsed.data : { limit: 50 };
  const filters = new URLSearchParams(
    Object.entries({ search: query.search, status: query.status, etims: query.etims }).filter(
      (entry): entry is [string, string] => Boolean(entry[1]),
    ),
  );
  const pageParams = new URLSearchParams(filters);
  if (query.cursor) pageParams.set("cursor", query.cursor);
  const path = `/suppliers${pageParams.size ? `?${pageParams.toString()}` : ""}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await serverApi(path, suppliersResponseSchema);
  if (!result.ok) {
    if (result.status === 401) redirect(signInHref(path));
    if (result.status === 403) return <LiveForbidden />;
    return <LiveUnavailable retryHref={path} />;
  }
  const t = await getTranslations("suppliers");
  const tStatuses = await getTranslations("suppliers.statuses");
  const tEtims = await getTranslations("suppliers.etims");
  const tPayout = await getTranslations("suppliers.payoutStates");
  const { suppliers, page, permissions } = result.data;
  const filtered = Boolean(query.search || query.status || query.etims);
  const nextHref = page.nextCursor
    ? `/suppliers?${new URLSearchParams([...filters, ["cursor", page.nextCursor]]).toString()}`
    : null;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<StatusBadge tone="info">{t("live")}</StatusBadge>}
        title={t("title")}
        description={t("description", { company: session.company.name })}
        actions={
          permissions.canManage ? (
            <Button asChild>
              <Link href="/suppliers/new">
                <Plus aria-hidden /> {t("new")}
              </Link>
            </Button>
          ) : null
        }
      />
      <CatalogueSubnav current="suppliers" />
      <form
        key={`${query.search ?? ""}|${query.status ?? ""}|${query.etims ?? ""}`}
        method="get"
        action="/suppliers"
        className="flex flex-wrap items-end gap-3"
        role="search"
      >
        <div className="min-w-0 flex-1 space-y-1.5 sm:max-w-xs">
          <label htmlFor="supplier-search" className="block text-sm font-medium">
            {t("searchLabel")}
          </label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              id="supplier-search"
              name="search"
              defaultValue={query.search ?? ""}
              placeholder={t("searchPlaceholder")}
              maxLength={100}
              className="h-9 pl-8"
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="supplier-status-filter" className="block text-sm font-medium">
            {t("statusLabel")}
          </label>
          <select
            id="supplier-status-filter"
            name="status"
            defaultValue={query.status ?? ""}
            className={selectClass}
          >
            <option value="">{t("allStatuses")}</option>
            {SUPPLIER_STATUSES.map((status) => (
              <option key={status} value={status}>
                {tStatuses(status)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="supplier-etims-filter" className="block text-sm font-medium">
            {t("etimsLabel")}
          </label>
          <select
            id="supplier-etims-filter"
            name="etims"
            defaultValue={query.etims ?? ""}
            className={selectClass}
          >
            <option value="">{t("allEtims")}</option>
            {ETIMS_STATUSES.map((status) => (
              <option key={status} value={status}>
                {tEtims(status)}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" variant="secondary">
          {t("apply")}
        </Button>
        {filtered ? (
          <Button asChild variant="ghost">
            <Link href="/suppliers">{t("clear")}</Link>
          </Button>
        ) : null}
      </form>
      <p className="text-sm text-muted-foreground" role="status">
        {t("count", { count: suppliers.length })}
      </p>
      {suppliers.length === 0 ? (
        <div className="rounded-xl border border-dashed p-8 text-center">
          <p className="font-medium">{filtered ? t("noMatches") : t("empty")}</p>
          {!filtered && permissions.canManage ? (
            <p className="mt-1 text-sm text-muted-foreground">{t("emptyHint")}</p>
          ) : null}
        </div>
      ) : (
        <div className="relative overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[820px] text-sm">
            <caption className="sr-only">{t("title")}</caption>
            <thead>
              <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2 pl-4 font-medium">
                  {t("cols.code")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.name")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.kraPin")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.etims")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.status")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.payout")}
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  {t("cols.terms")}
                </th>
              </tr>
            </thead>
            <tbody>
              {suppliers.map((supplier) => (
                <tr key={supplier.id} className="border-b align-top last:border-0">
                  <th scope="row" className="py-2 pl-4 text-left font-mono font-medium">
                    <Link
                      href={`/suppliers/${supplier.id}`}
                      className="underline underline-offset-4"
                    >
                      {supplier.code}
                    </Link>
                  </th>
                  <td className="py-2 pr-2">
                    {supplier.tradingName ?? supplier.legalName}
                    {supplier.tradingName ? (
                      <span className="block text-xs text-muted-foreground">
                        {supplier.legalName}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-2 font-mono">{supplier.kraPinMasked ?? t("noPin")}</td>
                  <td className="py-2 pr-2">
                    <StatusBadge tone={etimsTone[supplier.etimsStatus]}>
                      {tEtims(supplier.etimsStatus)}
                    </StatusBadge>
                  </td>
                  <td className="py-2 pr-2">
                    <StatusBadge tone={supplierStatusTone[supplier.status]}>
                      {tStatuses(supplier.status)}
                    </StatusBadge>
                  </td>
                  <td className="py-2 pr-2">
                    <StatusBadge tone={payoutTone[supplier.payout.status]}>
                      {tPayout(supplier.payout.status)}
                    </StatusBadge>
                  </td>
                  <td className="py-2 pr-4">
                    {t("terms", { days: supplier.creditDays })}
                    {supplier.creditLimitMinor !== null ? (
                      <span className="block text-xs text-muted-foreground">
                        {formatKES(supplier.creditLimitMinor)}
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {query.cursor || nextHref ? (
        <nav className="flex gap-2" aria-label={t("title")}>
          {query.cursor ? (
            <Button asChild variant="outline">
              <Link href={`/suppliers${filters.size ? `?${filters.toString()}` : ""}`}>
                {t("firstPage")}
              </Link>
            </Button>
          ) : null}
          {nextHref ? (
            <Button asChild variant="outline">
              <Link href={nextHref}>{t("nextPage")}</Link>
            </Button>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
