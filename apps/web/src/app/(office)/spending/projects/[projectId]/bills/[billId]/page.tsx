import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { billItemsResponseSchema } from "@pm-buddy/validation";
import { apiQuery, listHrefs, Pager } from "@/components/procurement/p2p/list-filters";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { FiguresTable, SpendingEyebrow } from "@/components/spending/spending-subnav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatKES } from "@/lib/format";
import { loadOrRedirect } from "@/lib/p2p-server";
import { pickParam } from "@/lib/p2p";
import { requireSession } from "@/lib/server-api";
import { isUuid } from "@/lib/stores";

export async function generateMetadata() {
  const t = await getTranslations("spending.bill");
  return { title: t("metaTitle") };
}

/** One bill's BQ items: budget against committed, actual and paid, searchable and paged (D5.4). */
export default async function BillSpendingPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; billId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId, billId } = await params;
  if (!isUuid(projectId) || !isUuid(billId)) notFound();
  const raw = await searchParams;
  const search = pickParam(raw, "search")?.slice(0, 100);
  const cursorParam = pickParam(raw, "cursor");
  const cursor = cursorParam && /^\d{1,6}$/.test(cursorParam) ? cursorParam : undefined;
  const base = `/spending/projects/${projectId}/bills/${billId}`;
  const path = `${base}${apiQuery({ search, cursor })}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await loadOrRedirect(
    `/spending/projects/${projectId}/bills/${billId}/items${apiQuery({ search, cursor, limit: "50" })}`,
    billItemsResponseSchema,
    path,
  );
  if (!result.ok) {
    if (result.status === 404 || result.status === 400) notFound();
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  }
  const t = await getTranslations("spending.bill");
  const { project, bill, items, page } = result.data;
  const hrefs = listHrefs(base, { search }, page.nextCursor);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <SpendingEyebrow
            trail={{
              href: `/spending/projects/${projectId}`,
              label: `${project.code} · ${project.name}`,
            }}
          />
        }
        title={t("title", { number: bill.number, title: bill.title })}
        description={t("description")}
      />
      <form method="get" action={base} role="search" className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 space-y-1.5 sm:max-w-sm">
          <label htmlFor="bill-search" className="block text-sm font-medium">
            {t("search")}
          </label>
          <Input id="bill-search" name="search" defaultValue={search ?? ""} maxLength={100} />
        </div>
        <Button type="submit" variant="secondary">
          {t("apply")}
        </Button>
      </form>
      {items.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm">{t("empty")}</p>
      ) : (
        <FiguresTable
          label={t("itemsTitle")}
          firstColumn={t("item")}
          rows={items.map((row) => ({
            key: row.item.lineageId,
            label: (
              <>
                <Link
                  href={`/spending/ledger?project=${projectId}&item=${row.item.lineageId}`}
                  className="underline underline-offset-4"
                >
                  {row.item.ref ? `${row.item.ref} · ` : ""}
                  {row.item.description}
                </Link>
                <span className="block text-xs font-normal text-muted-foreground">
                  {row.contractAmountMinor === null
                    ? t("noContractAmount")
                    : t("contractAmount", { amount: formatKES(row.contractAmountMinor) })}
                </span>
              </>
            ),
            figures: row,
          }))}
        />
      )}
      <Pager
        label={t("itemsTitle")}
        firstHref={hrefs.first}
        nextHref={hrefs.next}
        paged={Boolean(cursor)}
      />
    </div>
  );
}
