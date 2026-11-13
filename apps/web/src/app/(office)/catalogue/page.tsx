import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Search } from "lucide-react";
import { MATERIAL_CATEGORIES, MATERIAL_STATUSES, type StandardUnitCode } from "@pm-buddy/types";
import {
  materialListQuerySchema,
  materialsResponseSchema,
  unitsResponseSchema,
} from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { CatalogueSubnav } from "@/components/procurement/catalogue-subnav";
import { LoadDefaultsButton } from "@/components/procurement/load-defaults-button";
import { MaterialFormButton } from "@/components/procurement/material-form";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCalendarDate, formatKES } from "@/lib/format";
import { unitLabel } from "@/lib/procurement";
import { requireSession, serverApi } from "@/lib/server-api";
import { signInHref } from "@/lib/safe-next";

export async function generateMetadata() {
  const t = await getTranslations("catalogue");
  return { title: t("title") };
}

const selectClass =
  "h-9 rounded-md border border-input bg-background px-3 text-sm shadow-xs focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 outline-none";

/** The company's material catalogue (D5.1): search, category filter and cursor pages. */
export default async function CataloguePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const pick = (key: string) =>
    typeof raw[key] === "string" && raw[key].trim() ? raw[key].trim() : undefined;
  const parsed = materialListQuerySchema.safeParse({
    search: pick("search"),
    category: pick("category"),
    status: pick("status"),
    cursor: pick("cursor"),
  });
  const query = parsed.success ? parsed.data : { limit: 50 };
  const filters = new URLSearchParams(
    Object.entries({
      search: query.search,
      category: query.category,
      status: query.status,
    }).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
  const pageParams = new URLSearchParams(filters);
  if (query.cursor) pageParams.set("cursor", query.cursor);
  const path = `/catalogue${pageParams.size ? `?${pageParams.toString()}` : ""}`;

  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [result, unitsResult] = await Promise.all([
    serverApi(
      `/materials${pageParams.size ? `?${pageParams.toString()}` : ""}`,
      materialsResponseSchema,
    ),
    serverApi("/units", unitsResponseSchema),
  ]);
  if (!result.ok) {
    if (result.status === 401) redirect(signInHref(path));
    if (result.status === 403) return <LiveForbidden />;
    return <LiveUnavailable retryHref={path} />;
  }
  const units = unitsResult.ok ? unitsResult.data.units : [];
  const t = await getTranslations("catalogue");
  const tCategories = await getTranslations("catalogue.categories");
  const tStatuses = await getTranslations("catalogue.statuses");
  const tUnits = await getTranslations("catalogue.units");
  const label = (code: string) => unitLabel(code, (unit: StandardUnitCode) => tUnits(unit), units);
  const { materials, page, permissions } = result.data;
  const filtered = Boolean(query.search || query.category || query.status);
  const nextHref = page.nextCursor
    ? `/catalogue?${new URLSearchParams([...filters, ["cursor", page.nextCursor]]).toString()}`
    : null;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<StatusBadge tone="info">{t("live")}</StatusBadge>}
        title={t("title")}
        description={t("description", { company: session.company.name })}
        actions={permissions.canManage ? <MaterialFormButton units={units} /> : null}
      />
      <CatalogueSubnav current="materials" />
      <form
        key={`${query.search ?? ""}|${query.category ?? ""}|${query.status ?? ""}`}
        method="get"
        action="/catalogue"
        className="flex flex-wrap items-end gap-3"
        role="search"
      >
        <div className="min-w-0 flex-1 space-y-1.5 sm:max-w-xs">
          <label htmlFor="material-search" className="block text-sm font-medium">
            {t("searchLabel")}
          </label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              id="material-search"
              name="search"
              defaultValue={query.search ?? ""}
              placeholder={t("searchPlaceholder")}
              maxLength={100}
              className="h-9 pl-8"
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="material-category" className="block text-sm font-medium">
            {t("categoryLabel")}
          </label>
          <select
            id="material-category"
            name="category"
            defaultValue={query.category ?? ""}
            className={selectClass}
          >
            <option value="">{t("allCategories")}</option>
            {MATERIAL_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {tCategories(category)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="material-status" className="block text-sm font-medium">
            {t("statusLabel")}
          </label>
          <select
            id="material-status"
            name="status"
            defaultValue={query.status ?? ""}
            className={selectClass}
          >
            <option value="">{t("allStatuses")}</option>
            {MATERIAL_STATUSES.map((status) => (
              <option key={status} value={status}>
                {tStatuses(status)}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" variant="secondary">
          {t("apply")}
        </Button>
        {filtered ? (
          <Button asChild variant="ghost">
            <Link href="/catalogue">{t("clear")}</Link>
          </Button>
        ) : null}
      </form>
      <p className="text-sm text-muted-foreground" role="status">
        {t("count", { count: materials.length })}
      </p>
      {materials.length === 0 ? (
        <div className="space-y-3 rounded-xl border border-dashed p-8 text-center">
          <p className="font-medium">{filtered ? t("noMatches") : t("empty")}</p>
          {!filtered ? (
            <p className="text-sm text-muted-foreground">
              {permissions.canManage ? t("emptyHint") : t("emptyNoManage")}
            </p>
          ) : null}
          {!filtered && permissions.canManage ? (
            <div className="flex justify-center">
              <LoadDefaultsButton />
            </div>
          ) : null}
        </div>
      ) : (
        <div className="relative overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[720px] text-sm">
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
                  {t("cols.category")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.baseUnit")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.latestPrice")}
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  {t("cols.alerts")}
                </th>
              </tr>
            </thead>
            <tbody>
              {materials.map((material) => (
                <tr key={material.id} className="border-b align-top last:border-0">
                  <th scope="row" className="py-2 pl-4 text-left font-mono font-medium">
                    <Link
                      href={`/catalogue/${material.id}`}
                      className="underline underline-offset-4"
                    >
                      {material.code}
                    </Link>
                  </th>
                  <td className="py-2 pr-2">
                    {material.name}
                    {material.nameSw ? (
                      <span className="block text-xs text-muted-foreground" lang="sw">
                        {material.nameSw}
                      </span>
                    ) : null}
                    {material.status === "archived" ? (
                      <StatusBadge tone="neutral" className="mt-1">
                        {tStatuses("archived")}
                      </StatusBadge>
                    ) : null}
                  </td>
                  <td className="py-2 pr-2">{tCategories(material.category)}</td>
                  <td className="py-2 pr-2">{label(material.baseUnit)}</td>
                  <td className="py-2 pr-2 tabular-nums">
                    {material.latestPrice ? (
                      <>
                        {t("priceBy", {
                          price: formatKES(material.latestPrice.unitPriceMinor),
                          unit: label(material.latestPrice.unit),
                        })}
                        <span className="block text-xs text-muted-foreground">
                          {t("fromSupplier", {
                            supplier: material.latestPrice.supplier.name,
                            date: formatCalendarDate(material.latestPrice.effectiveOn),
                          })}
                        </span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">{t("noPrice")}</span>
                    )}
                  </td>
                  <td className="py-2 pr-4">
                    {material.alertCount ? (
                      <StatusBadge tone="warning">
                        {t("alertCount", { count: material.alertCount })}
                      </StatusBadge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {query.cursor || nextHref ? (
        <nav className="flex gap-2" aria-label={t("nav.materials")}>
          {query.cursor ? (
            <Button asChild variant="outline">
              <Link href={`/catalogue${filters.size ? `?${filters.toString()}` : ""}`}>
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
      {permissions.canManage && materials.length > 0 && !filtered ? (
        <div className="rounded-xl border p-4">
          <p className="mb-2 text-sm text-muted-foreground">{t("defaults.hint")}</p>
          <LoadDefaultsButton />
        </div>
      ) : null}
    </div>
  );
}
