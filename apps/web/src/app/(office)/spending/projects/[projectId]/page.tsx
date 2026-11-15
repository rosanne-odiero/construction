import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { projectSpendingResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import {
  FiguresTable,
  SentenceBadge,
  SpendingEyebrow,
  SpendingSubnav,
} from "@/components/spending/spending-subnav";
import { Button } from "@/components/ui/button";
import { formatDate, formatKES } from "@/lib/format";
import { loadOrRedirect } from "@/lib/p2p-server";
import { requireSession } from "@/lib/server-api";
import { CATEGORY_ORDER } from "@/lib/spending";
import { isUuid } from "@/lib/stores";

export async function generateMetadata() {
  const t = await getTranslations("spending.project");
  return { title: t("metaTitle") };
}

/**
 * A project's budget against committed, actual and paid: the totals, by category and by bill
 * (drilling down to BQ items), the cost on no BQ item, and how materials bought relate to stock
 * issued to items (D5.4).
 */
export default async function ProjectSpendingPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  if (!isUuid(projectId)) notFound();
  const path = `/spending/projects/${projectId}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await loadOrRedirect(
    `/spending/projects/${projectId}`,
    projectSpendingResponseSchema,
    path,
  );
  if (!result.ok) {
    if (result.status === 404 || result.status === 400) notFound();
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  }
  const t = await getTranslations("spending.project");
  const tCategory = await getTranslations("spending.categories");
  const data = result.data;
  const categories = [...data.categories].sort(
    (a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<SpendingEyebrow trail={{ href: "/spending", label: t("back") }} />}
        title={t("title", { code: data.project.code, name: data.project.name })}
        description={
          data.budget
            ? t("budgetInForce", {
                version: data.budget.versionNo,
                name: data.budget.name,
                date: data.budget.approvedAt ? formatDate(data.budget.approvedAt) : "—",
              })
            : t("noBudget")
        }
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link href={`/spending/budgets?project=${projectId}`}>{t("budgets")}</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={`/spending/ledger?project=${projectId}`}>{t("ledger")}</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={`/spending/forecast?project=${projectId}`}>{t("forecast")}</Link>
            </Button>
          </>
        }
      />
      <SpendingSubnav current={null} />
      {data.budget ? null : <SentenceBadge tone="warning">{t("noBudgetHint")}</SentenceBadge>}

      <section aria-labelledby="totals" className="space-y-3">
        <h2 id="totals" className="text-lg font-semibold">
          {t("totalsTitle")}
        </h2>
        <FiguresTable
          label={t("totalsTitle")}
          firstColumn={t("measure")}
          rows={[{ key: "project", label: t("wholeProject"), figures: data.totals }]}
        />
        <p className="text-sm text-muted-foreground">
          {t("cashPaid", { amount: formatKES(data.cashPaidMinor) })}
        </p>
      </section>

      <section aria-labelledby="by-category" className="space-y-3">
        <h2 id="by-category" className="text-lg font-semibold">
          {t("categoriesTitle")}
        </h2>
        <FiguresTable
          label={t("categoriesTitle")}
          firstColumn={t("category")}
          rows={categories.map((row) => ({
            key: row.category,
            label: (
              <Link
                href={`/spending/ledger?project=${projectId}&category=${row.category}`}
                className="underline underline-offset-4"
              >
                {tCategory(row.category)}
              </Link>
            ),
            figures: row,
          }))}
        />
        {data.uncategorisedBudgetMinor ? (
          <p className="text-sm text-muted-foreground">
            {t("uncategorised", { amount: formatKES(data.uncategorisedBudgetMinor) })}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="by-bill" className="space-y-3">
        <h2 id="by-bill" className="text-lg font-semibold">
          {t("billsTitle")}
        </h2>
        {data.bills.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noBills")}</p>
        ) : (
          <FiguresTable
            label={t("billsTitle")}
            firstColumn={t("bill")}
            rows={[
              ...data.bills.map((row) => ({
                key: row.bill.lineageId,
                label: (
                  <>
                    <Link
                      href={`/spending/projects/${projectId}/bills/${row.bill.lineageId}`}
                      className="underline underline-offset-4"
                    >
                      {t("billLabel", { number: row.bill.number, title: row.bill.title })}
                    </Link>
                    <span className="block text-xs font-normal text-muted-foreground">
                      {t("itemCount", { count: row.itemCount })}
                    </span>
                  </>
                ),
                figures: row,
              })),
              { key: "none", label: t("notOnBqItems"), figures: data.notOnBqItems },
            ]}
          />
        )}
      </section>

      <section aria-labelledby="materials" className="space-y-3 rounded-xl border p-4">
        <h2 id="materials" className="text-lg font-semibold">
          {t("materialsTitle")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("materialsHint")}</p>
        {data.materials.notIssuedMinor < 0 ? (
          <SentenceBadge tone="info">
            {t("receivedNotInvoiced", { amount: formatKES(-data.materials.notIssuedMinor) })}
          </SentenceBadge>
        ) : null}
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          {(
            [
              ["accrued", data.materials.accruedMinor],
              ["issued", data.materials.issuedMinor],
              ["notIssued", data.materials.notIssuedMinor],
              ["transferredIn", data.materials.transferredInMinor],
              ["transferredOut", data.materials.transferredOutMinor],
            ] as const
          ).map(([key, amount]) => (
            <div key={key} className="flex flex-wrap justify-between gap-2 border-b pb-1">
              <dt className="text-muted-foreground">{t(`materials.${key}`)}</dt>
              <dd className="tabular-nums">{formatKES(amount)}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
