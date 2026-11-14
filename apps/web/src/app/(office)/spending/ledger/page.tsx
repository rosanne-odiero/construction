import Link from "next/link";
import { getTranslations } from "next-intl/server";
import {
  COST_CATEGORIES,
  COST_MEASURES,
  COST_SOURCES,
  type CostCategory,
  type CostMeasure,
  type CostSource,
} from "@pm-buddy/types";
import { costLedgerResponseSchema, type CostEntry } from "@pm-buddy/validation";
import { apiQuery, listHrefs, Pager } from "@/components/procurement/p2p/list-filters";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { SpendingAction, spendingSelectClass } from "@/components/spending/spending-action";
import { SpendingEyebrow, SpendingSubnav } from "@/components/spending/spending-subnav";
import { StatusBadge } from "@/components/status-badge";
import { ScrollTable } from "@/components/stores/stores-subnav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCalendarDate, formatKES } from "@/lib/format";
import { loadOrRedirect, projectOptions } from "@/lib/p2p-server";
import { pickParam } from "@/lib/p2p";
import { requireSession } from "@/lib/server-api";
import { isUuid } from "@/lib/stores";

export async function generateMetadata() {
  const t = await getTranslations("spending.ledger");
  return { title: t("title") };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const pickEnum = <T extends string>(value: string | undefined, values: readonly T[]) =>
  values.includes(value as T) ? (value as T) : undefined;

function documentHref(entry: CostEntry): string | null {
  switch (entry.document.kind) {
    case "supplier_invoice":
    case "invoice_settlement":
      return `/procurement/invoices/${entry.document.id}`;
    case "petty_cash_expense":
      return `/spending/petty-cash/expenses/${entry.document.id}`;
    case "cost_journal":
      return `/spending/journals/${entry.document.id}`;
    default:
      return null;
  }
}

/**
 * The append-only cost ledger with filters (D5.4). Every entry is tagged with its project, site,
 * BQ item or cost code, category, counterparty and reference; corrections are reversal journals
 * approved by a second person, never edits.
 */
export default async function CostLedgerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const project = isUuid(pickParam(raw, "project")) ? pickParam(raw, "project") : undefined;
  const item = isUuid(pickParam(raw, "item")) ? pickParam(raw, "item") : undefined;
  const measure = pickEnum<CostMeasure>(pickParam(raw, "measure"), COST_MEASURES);
  const category = pickEnum<CostCategory>(pickParam(raw, "category"), COST_CATEGORIES);
  const source = pickEnum<CostSource>(pickParam(raw, "source"), COST_SOURCES);
  const from = DATE.test(pickParam(raw, "from") ?? "") ? pickParam(raw, "from") : undefined;
  const to = DATE.test(pickParam(raw, "to") ?? "") ? pickParam(raw, "to") : undefined;
  const cursor = isUuid(pickParam(raw, "cursor")) ? pickParam(raw, "cursor") : undefined;
  const filters = { project, item, measure, category, source, from, to };
  const path = `/spending/ledger${apiQuery({ ...filters, cursor })}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [result, projects] = await Promise.all([
    loadOrRedirect(
      `/spending/ledger${apiQuery({
        projectId: project,
        bqItemLineageId: item,
        measure,
        category,
        source,
        from,
        to,
        cursor,
        limit: "50",
      })}`,
      costLedgerResponseSchema,
      path,
    ),
    projectOptions(),
  ]);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("spending.ledger");
  const tCategory = await getTranslations("spending.categories");
  const tSource = await getTranslations("spending.sources");
  const tPurpose = await getTranslations("spending.purposes");
  const tMeasure = await getTranslations("spending.measures");
  const { entries, totals, page, permissions } = result.data;
  const hrefs = listHrefs("/spending/ledger", filters, page.nextCursor);
  const filtered = Object.values(filters).some(Boolean);

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={<SpendingEyebrow />} title={t("title")} description={t("description")} />
      <SpendingSubnav current="ledger" />
      <form
        key={JSON.stringify(filters)}
        method="get"
        action="/spending/ledger"
        role="search"
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
      >
        {item ? <input type="hidden" name="item" value={item} /> : null}
        <div className="space-y-1.5">
          <label htmlFor="ledger-project" className="block text-sm font-medium">
            {t("project")}
          </label>
          <select
            id="ledger-project"
            name="project"
            defaultValue={project ?? ""}
            className={spendingSelectClass}
          >
            <option value="">{t("allProjects")}</option>
            {projects.map((option) => (
              <option key={option.id} value={option.id}>
                {option.code} · {option.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="ledger-measure" className="block text-sm font-medium">
            {t("measure")}
          </label>
          <select
            id="ledger-measure"
            name="measure"
            defaultValue={measure ?? ""}
            className={spendingSelectClass}
          >
            <option value="">{t("allMeasures")}</option>
            {COST_MEASURES.map((value) => (
              <option key={value} value={value}>
                {tMeasure(value)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="ledger-category" className="block text-sm font-medium">
            {t("category")}
          </label>
          <select
            id="ledger-category"
            name="category"
            defaultValue={category ?? ""}
            className={spendingSelectClass}
          >
            <option value="">{t("allCategories")}</option>
            {COST_CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {tCategory(value)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="ledger-source" className="block text-sm font-medium">
            {t("source")}
          </label>
          <select
            id="ledger-source"
            name="source"
            defaultValue={source ?? ""}
            className={spendingSelectClass}
          >
            <option value="">{t("allSources")}</option>
            {COST_SOURCES.map((value) => (
              <option key={value} value={value}>
                {tSource(value)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="ledger-from" className="block text-sm font-medium">
            {t("from")}
          </label>
          <Input id="ledger-from" name="from" type="date" defaultValue={from ?? ""} />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="ledger-to" className="block text-sm font-medium">
            {t("to")}
          </label>
          <Input id="ledger-to" name="to" type="date" defaultValue={to ?? ""} />
        </div>
        <div className="flex items-end gap-2">
          <Button type="submit" variant="secondary">
            {t("apply")}
          </Button>
          {filtered ? (
            <Button asChild variant="ghost">
              <Link href="/spending/ledger">{t("clear")}</Link>
            </Button>
          ) : null}
        </div>
      </form>
      <p className="text-sm text-muted-foreground" role="status">
        {t("totals", {
          count: totals.count,
          accrued: formatKES(totals.accruedMinor),
          paid: formatKES(totals.paidMinor),
        })}
      </p>
      {entries.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm">{t("empty")}</p>
      ) : (
        <ScrollTable label={t("title")} minWidth={980}>
          <thead>
            <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
              <th scope="col" className="py-2 pl-4 font-medium">
                {t("cols.date")}
              </th>
              <th scope="col" className="py-2 pr-2 font-medium">
                {t("cols.document")}
              </th>
              <th scope="col" className="py-2 pr-2 font-medium">
                {t("cols.tags")}
              </th>
              <th scope="col" className="py-2 pr-2 font-medium">
                {t("cols.counterparty")}
              </th>
              <th scope="col" className="py-2 pr-2 font-medium">
                {t("cols.measure")}
              </th>
              <th scope="col" className="py-2 pr-2 text-right font-medium">
                {t("cols.amount")}
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                <span className="sr-only">{t("cols.actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const href = documentHref(entry);
              return (
                <tr key={entry.id} className="border-b align-top last:border-0">
                  <td className="py-2 pl-4 whitespace-nowrap">
                    {formatCalendarDate(entry.occurredOn)}
                    <span className="block text-xs text-muted-foreground">
                      {t("recorded", { date: formatCalendarDate(entry.businessDate) })}
                    </span>
                  </td>
                  <td className="py-2 pr-2">
                    {href ? (
                      <Link href={href} className="font-medium underline underline-offset-4">
                        {entry.document.label}
                      </Link>
                    ) : (
                      <span className="font-medium">{entry.document.label}</span>
                    )}
                    <span className="block text-xs text-muted-foreground">
                      {tSource(entry.source)} · {tPurpose(entry.purpose)}
                    </span>
                  </td>
                  <td className="py-2 pr-2">
                    {entry.project.code}
                    {entry.site ? ` · ${entry.site.name}` : ""}
                    <span className="block text-xs text-muted-foreground">
                      {tCategory(entry.category)}
                      {entry.bqItem
                        ? ` · ${entry.bqItem.ref ? `${entry.bqItem.ref} ` : ""}${entry.bqItem.description}`
                        : entry.costCode
                          ? ` · ${entry.costCode.code} ${entry.costCode.name}`
                          : ` · ${t("heldInStores")}`}
                    </span>
                  </td>
                  <td className="py-2 pr-2">
                    {entry.supplier?.name ?? entry.counterpartyName ?? "—"}
                    {entry.paymentReference ? (
                      <span className="block font-mono text-xs text-muted-foreground">
                        {entry.paymentReference}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-2">
                    <StatusBadge tone={entry.measure === "paid" ? "success" : "info"}>
                      {tMeasure(entry.measure)}
                    </StatusBadge>
                    {entry.reversedByEntryId ? (
                      <span className="block text-xs text-muted-foreground">{t("reversed")}</span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {formatKES(entry.amountMinor)}
                  </td>
                  <td className="py-2 pr-4">
                    {permissions.canReverse &&
                    !entry.reversedByEntryId &&
                    !entry.reversesEntryId ? (
                      <SpendingAction
                        path="/cost-journals/reversal"
                        entity="journal"
                        body={{ entryId: entry.id }}
                        fields={[{ kind: "reason" }]}
                        openResult
                        text={{
                          button: t("reverse"),
                          title: t("reverseTitle", { label: entry.document.label }),
                          description: t("reverseDescription"),
                          confirm: t("reverseConfirm"),
                        }}
                      />
                    ) : null}
                  </td>
                </tr>
              );
            })}
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
