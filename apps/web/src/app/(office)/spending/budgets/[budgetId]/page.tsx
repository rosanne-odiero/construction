import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { budgetDetailResponseSchema, budgetLinesResponseSchema } from "@pm-buddy/validation";
import { apiQuery, listHrefs, Pager } from "@/components/procurement/p2p/list-filters";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { BudgetLineForm } from "@/components/spending/budget-line-form";
import { SentenceBadge } from "@/components/spending/sentence-badge";
import { SpendingAction } from "@/components/spending/spending-action";
import { SpendingEyebrow } from "@/components/spending/spending-subnav";
import { StatusBadge } from "@/components/status-badge";
import { ScrollTable } from "@/components/stores/stores-subnav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDateTime, formatKES } from "@/lib/format";
import { loadOrRedirect } from "@/lib/p2p-server";
import { pickParam } from "@/lib/p2p";
import { requireSession, serverApi } from "@/lib/server-api";
import { budgetStatusTone, minorToInput } from "@/lib/spending";
import { isUuid } from "@/lib/stores";

export async function generateMetadata() {
  const t = await getTranslations("spending.budget");
  return { title: t("metaTitle") };
}

/**
 * One budget version: lines (BQ items or cost codes), totals by category and bill, and the
 * prepare → submit → approve workflow. Approval quotes the digest of what the approver saw, so a
 * change after submission cannot slip through (D5.4).
 */
export default async function BudgetPage({
  params,
  searchParams,
}: {
  params: Promise<{ budgetId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { budgetId } = await params;
  if (!isUuid(budgetId)) notFound();
  const raw = await searchParams;
  const search = pickParam(raw, "search")?.slice(0, 100);
  const cursorParam = pickParam(raw, "cursor");
  const cursor = cursorParam && /^\d{1,7}$/.test(cursorParam) ? cursorParam : undefined;
  const base = `/spending/budgets/${budgetId}`;
  const path = `${base}${apiQuery({ search, cursor })}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [result, lines] = await Promise.all([
    loadOrRedirect(`/budgets/${budgetId}`, budgetDetailResponseSchema, path),
    serverApi(
      `/budgets/${budgetId}/lines${apiQuery({ search, cursor, limit: "50" })}`,
      budgetLinesResponseSchema,
    ),
  ]);
  if (!result.ok) {
    if (result.status === 404 || result.status === 400) notFound();
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  }
  const t = await getTranslations("spending.budget");
  const tStatus = await getTranslations("spending.status");
  const tCategory = await getTranslations("spending.categories");
  const { budget, totals, permissions } = result.data;
  const hrefs = listHrefs(base, { search }, lines.ok ? lines.data.page.nextCursor : null);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <SpendingEyebrow
            trail={{ href: `/spending/budgets?project=${budget.project.id}`, label: t("back") }}
          />
        }
        title={t("title", { version: budget.versionNo, name: budget.name })}
        description={`${budget.project.code} · ${budget.project.name}`}
        actions={
          <>
            <StatusBadge tone={budgetStatusTone[budget.status]}>
              {tStatus(`budget.${budget.status}`)}
            </StatusBadge>
            {budget.current ? <StatusBadge tone="success">{t("inForce")}</StatusBadge> : null}
            {permissions.canSubmit ? (
              <SpendingAction
                path={`/budgets/${budget.id}/submit`}
                entity="budget"
                body={{ version: budget.version }}
                primary
                text={{
                  button: t("submit"),
                  title: t("submitTitle"),
                  description: t("submitDescription"),
                  confirm: t("submit"),
                }}
              />
            ) : null}
            {permissions.canApprove && budget.digest ? (
              <SpendingAction
                path={`/budgets/${budget.id}/approve`}
                entity="budget"
                body={{ version: budget.version, digest: budget.digest }}
                primary
                text={{
                  button: t("approve"),
                  title: t("approveTitle", { total: formatKES(budget.totalMinor) }),
                  description: t("approveDescription"),
                  confirm: t("approve"),
                }}
              />
            ) : null}
            {permissions.canReturn ? (
              <SpendingAction
                path={`/budgets/${budget.id}/return`}
                entity="budget"
                body={{ version: budget.version }}
                fields={[{ kind: "reason" }]}
                text={{
                  button: t("return"),
                  title: t("returnTitle"),
                  description: t("returnDescription"),
                  confirm: t("return"),
                }}
              />
            ) : null}
            {permissions.canCancel ? (
              <SpendingAction
                path={`/budgets/${budget.id}/cancel`}
                entity="budget"
                body={{ version: budget.version }}
                fields={[{ kind: "reason" }]}
                destructive
                text={{
                  button: t("cancel"),
                  title: t("cancelTitle"),
                  description: t("cancelDescription"),
                  confirm: t("cancel"),
                }}
              />
            ) : null}
          </>
        }
      />
      {budget.returnReason ? (
        <SentenceBadge tone="warning">
          {t("returned", { reason: budget.returnReason })}
        </SentenceBadge>
      ) : null}
      {budget.status === "submitted" ? (
        <SentenceBadge tone="info">{t("submittedNote")}</SentenceBadge>
      ) : null}
      <dl className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border p-4">
          <dt className="text-sm text-muted-foreground">{t("total")}</dt>
          <dd className="text-2xl font-semibold tabular-nums">{formatKES(budget.totalMinor)}</dd>
        </div>
        <div className="rounded-xl border p-4">
          <dt className="text-sm text-muted-foreground">{t("bqVersion")}</dt>
          <dd className="text-sm">
            {budget.bqVersion
              ? t("bqVersionLine", { version: budget.bqVersion.versionNo })
              : t("noBq")}
          </dd>
        </div>
        <div className="rounded-xl border p-4">
          <dt className="text-sm text-muted-foreground">{t("people")}</dt>
          <dd className="text-sm">
            {t("preparedBy", { name: budget.createdBy.displayName })}
            {budget.submittedBy && budget.submittedAt
              ? ` · ${t("submittedBy", { name: budget.submittedBy.displayName, when: formatDateTime(budget.submittedAt) })}`
              : ""}
            {budget.approvedBy && budget.approvedAt
              ? ` · ${t("approvedBy", { name: budget.approvedBy.displayName, when: formatDateTime(budget.approvedAt) })}`
              : ""}
          </dd>
        </div>
      </dl>

      <section aria-labelledby="budget-totals" className="grid gap-4 lg:grid-cols-2">
        <h2 id="budget-totals" className="sr-only">
          {t("totalsTitle")}
        </h2>
        <div className="space-y-2 rounded-xl border p-4 text-sm">
          <h3 className="font-semibold">{t("byCategory")}</h3>
          <ul className="space-y-1">
            {totals.byCategory.map((row) => (
              <li key={row.category ?? "none"} className="flex flex-wrap justify-between gap-2">
                <span>{row.category ? tCategory(row.category) : t("uncategorised")}</span>
                <span className="tabular-nums">{formatKES(row.amountMinor)}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="space-y-2 rounded-xl border p-4 text-sm">
          <h3 className="font-semibold">{t("byBill")}</h3>
          <ul className="space-y-1">
            {totals.byBill.map((row) => (
              <li
                key={row.bill?.lineageId ?? "none"}
                className="flex flex-wrap justify-between gap-2"
              >
                <span>
                  {row.bill ? `${row.bill.number} · ${row.bill.title}` : t("costCodeLines")}
                </span>
                <span className="tabular-nums">{formatKES(row.amountMinor)}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section aria-labelledby="budget-lines" className="space-y-3">
        <h2 id="budget-lines" className="text-lg font-semibold">
          {t("linesTitle")}
        </h2>
        <form method="get" action={base} role="search" className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1 space-y-1.5 sm:max-w-sm">
            <label htmlFor="lines-search" className="block text-sm font-medium">
              {t("search")}
            </label>
            <Input id="lines-search" name="search" defaultValue={search ?? ""} maxLength={100} />
          </div>
          <Button type="submit" variant="secondary">
            {t("apply")}
          </Button>
          {search ? (
            <Button asChild variant="ghost">
              <Link href={base}>{t("clear")}</Link>
            </Button>
          ) : null}
        </form>
        {!lines.ok || lines.data.lines.length === 0 ? (
          <p className="rounded-xl border border-dashed p-6 text-center text-sm">{t("noLines")}</p>
        ) : (
          <ScrollTable label={t("linesTitle")} minWidth={720}>
            <thead>
              <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2 pl-4 font-medium">
                  {t("cols.line")}
                </th>
                <th scope="col" className="py-2 pr-2 font-medium">
                  {t("cols.category")}
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
              {lines.data.lines.map((line) => (
                <tr key={line.id} className="border-b align-top last:border-0">
                  <th scope="row" className="py-2 pl-4 text-left font-normal">
                    <span className="font-medium">
                      {line.bqItem
                        ? `${line.bqItem.bill ? `${line.bqItem.bill.number} · ` : ""}${line.bqItem.ref ?? ""}`
                        : (line.costCode?.code ?? "")}
                    </span>
                    <span className="block text-xs text-muted-foreground">{line.description}</span>
                  </th>
                  <td className="py-2 pr-2">{line.category ? tCategory(line.category) : "—"}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {formatKES(line.amountMinor)}
                  </td>
                  <td className="py-2 pr-4">
                    {permissions.canEdit ? (
                      <span className="flex flex-wrap gap-2">
                        <SpendingAction
                          path={`/budgets/${budget.id}/lines/${line.id}`}
                          method="PATCH"
                          entity="budget"
                          body={{ version: budget.version }}
                          fields={[
                            {
                              kind: "money",
                              name: "amountMinor",
                              label: t("amount"),
                              allowZero: true,
                              defaultValue: minorToInput(line.amountMinor),
                            },
                          ]}
                          text={{
                            button: t("editLine"),
                            title: t("editLineTitle"),
                            description: line.description,
                            confirm: t("save"),
                          }}
                        />
                        <SpendingAction
                          path={`/budgets/${budget.id}/lines/${line.id}?version=${budget.version}`}
                          method="DELETE"
                          entity="budget"
                          destructive
                          text={{
                            button: t("removeLine"),
                            title: t("removeLineTitle"),
                            description: line.description,
                            confirm: t("removeLine"),
                          }}
                        />
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
        )}
        <Pager
          label={t("linesTitle")}
          firstHref={hrefs.first}
          nextHref={hrefs.next}
          paged={Boolean(cursor)}
        />
      </section>
      {permissions.canEdit ? (
        <BudgetLineForm
          budgetId={budget.id}
          projectId={budget.project.id}
          version={budget.version}
        />
      ) : null}
    </div>
  );
}
