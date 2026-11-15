import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { nairobiDate } from "@pm-buddy/domain";
import { TOP_UP_METHODS } from "@pm-buddy/types";
import {
  countsResponseSchema,
  custodiansResponseSchema,
  expensesResponseSchema,
  floatLedgerResponseSchema,
  floatResponseSchema,
  topUpsResponseSchema,
} from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { SpendingAction } from "@/components/spending/spending-action";
import {
  SentenceBadge,
  SpendingEyebrow,
  SpendingSubnav,
} from "@/components/spending/spending-subnav";
import { StatusBadge } from "@/components/status-badge";
import { ScrollTable } from "@/components/stores/stores-subnav";
import { Button } from "@/components/ui/button";
import { formatCalendarDate, formatDateTime, formatKES } from "@/lib/format";
import { apiQuery, Pager } from "@/components/procurement/p2p/list-filters";
import { loadOrRedirect } from "@/lib/p2p-server";
import { pickParam } from "@/lib/p2p";
import { requireSession, serverApi } from "@/lib/server-api";
import { countTone, expenseTone, minorToInput, topUpTone } from "@/lib/spending";
import { isUuid } from "@/lib/stores";

export async function generateMetadata() {
  const t = await getTranslations("spending.float");
  return { title: t("metaTitle") };
}

/**
 * One float: the book balance, expenses waiting for approval, top-ups (asked, approved, paid by
 * three different people), counts against the book and the float's own ledger (D5.4).
 */
export default async function FloatPage({
  params,
  searchParams,
}: {
  params: Promise<{ floatId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { floatId } = await params;
  if (!isUuid(floatId)) notFound();
  const raw = await searchParams;
  // Each list pages on its own cursor (they all grow); the URL keeps the others.
  const uuidParam = (name: string) =>
    isUuid(pickParam(raw, name)) ? pickParam(raw, name) : undefined;
  const entriesParam = pickParam(raw, "entries");
  const cursors: Record<"expenses" | "topUps" | "counts" | "entries", string | undefined> = {
    expenses: uuidParam("expenses"),
    topUps: uuidParam("topUps"),
    counts: uuidParam("counts"),
    entries: entriesParam && /^\d{1,9}$/.test(entriesParam) ? entriesParam : undefined,
  };
  const base = `/spending/petty-cash/${floatId}`;
  const path = `${base}${apiQuery(cursors)}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [result, expenses, topUps, counts, ledger] = await Promise.all([
    loadOrRedirect(`/petty-cash/floats/${floatId}`, floatResponseSchema, path),
    serverApi(
      `/petty-cash/expenses${apiQuery({ floatId, cursor: cursors.expenses, limit: "20" })}`,
      expensesResponseSchema,
    ),
    serverApi(
      `/petty-cash/top-ups${apiQuery({ floatId, cursor: cursors.topUps, limit: "10" })}`,
      topUpsResponseSchema,
    ),
    serverApi(
      `/petty-cash/counts${apiQuery({ floatId, cursor: cursors.counts, limit: "5" })}`,
      countsResponseSchema,
    ),
    serverApi(
      `/petty-cash/floats/${floatId}/ledger${apiQuery({ cursor: cursors.entries, limit: "15" })}`,
      floatLedgerResponseSchema,
    ),
  ]);
  /** First/next links for one list, keeping the other lists' positions. */
  const pages = (name: keyof typeof cursors, next: string | null | undefined) => {
    const others = { ...cursors, [name]: undefined };
    return {
      firstHref: `${base}${apiQuery(others)}`,
      nextHref: next ? `${base}${apiQuery({ ...others, [name]: next })}` : null,
      paged: Boolean(cursors[name]),
    };
  };
  if (!result.ok) {
    if (result.status === 404 || result.status === 400) notFound();
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  }
  const t = await getTranslations("spending.float");
  const tStatus = await getTranslations("spending.status");
  const tMethod = await getTranslations("spending.topUpMethods");
  const tKind = await getTranslations("spending.floatEntryKinds");
  const { float, permissions } = result.data;
  const custodians = permissions.canEdit
    ? await serverApi(
        `/petty-cash/floats/custodians?projectId=${float.project.id}`,
        custodiansResponseSchema,
      )
    : null;
  const today = nairobiDate();

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<SpendingEyebrow trail={{ href: "/spending/petty-cash", label: t("back") }} />}
        title={float.name}
        description={t("description", {
          project: `${float.project.code} · ${float.project.name}`,
          site: float.site.name,
          custodian: float.custodian.displayName,
        })}
        actions={
          <>
            {permissions.canRecordExpense ? (
              <Button asChild size="sm">
                <Link href={`/spending/petty-cash/${floatId}/expense`}>{t("recordExpense")}</Link>
              </Button>
            ) : null}
            {permissions.canRequestTopUp ? (
              <SpendingAction
                path="/petty-cash/top-ups"
                entity="topUp"
                body={{ floatId }}
                fields={[
                  { kind: "money", name: "amountMinor", label: t("topUpAmount") },
                  { kind: "reason", label: t("topUpReason") },
                ]}
                text={{
                  button: t("requestTopUp"),
                  title: t("requestTopUpTitle"),
                  description: t("requestTopUpDescription", {
                    room: formatKES(Math.max(0, float.limitMinor - float.balanceMinor)),
                  }),
                  confirm: t("requestTopUp"),
                }}
              />
            ) : null}
            {permissions.canCount ? (
              <SpendingAction
                path="/petty-cash/counts"
                entity="count"
                body={{ floatId }}
                fields={[
                  { kind: "money", name: "countedMinor", label: t("counted"), allowZero: true },
                  {
                    kind: "text",
                    name: "note",
                    label: t("countNote"),
                    optional: true,
                    maxLength: 500,
                  },
                ]}
                text={{
                  button: t("count"),
                  title: t("countTitle"),
                  description: t("countDescription"),
                  confirm: t("count"),
                }}
              />
            ) : null}
            {permissions.canEdit ? (
              <SpendingAction
                path={`/petty-cash/floats/${floatId}`}
                method="PATCH"
                entity="float"
                body={{ version: float.version }}
                fields={[
                  {
                    kind: "select",
                    name: "custodianUserId",
                    label: t("custodian"),
                    defaultValue: float.custodian.id,
                    options: (custodians?.ok ? custodians.data.people : [float.custodian]).map(
                      (person) => ({
                        value: person.id,
                        label: person.displayName,
                      }),
                    ),
                  },
                  {
                    kind: "money",
                    name: "limitMinor",
                    label: t("limit"),
                    defaultValue: minorToInput(float.limitMinor),
                  },
                ]}
                text={{
                  button: t("edit"),
                  title: t("editTitle"),
                  description: t("editDescription"),
                  confirm: t("save"),
                }}
              />
            ) : null}
          </>
        }
      />
      <SpendingSubnav current="pettyCash" />
      <dl className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border p-4">
          <dt className="text-sm text-muted-foreground">{t("balance")}</dt>
          <dd className="text-2xl font-semibold tabular-nums">{formatKES(float.balanceMinor)}</dd>
        </div>
        <div className="rounded-xl border p-4">
          <dt className="text-sm text-muted-foreground">{t("limit")}</dt>
          <dd className="text-2xl font-semibold tabular-nums">{formatKES(float.limitMinor)}</dd>
        </div>
        <div className="rounded-xl border p-4">
          <dt className="text-sm text-muted-foreground">{t("lastCount")}</dt>
          <dd className="text-sm">
            {float.lastApprovedCount
              ? t("lastCountLine", {
                  number: float.lastApprovedCount.number,
                  when: formatDateTime(float.lastApprovedCount.countedAt),
                  variance: formatKES(float.lastApprovedCount.varianceMinor),
                })
              : t("neverCounted")}
          </dd>
        </div>
      </dl>
      <SentenceBadge tone="info">{t("bookNote")}</SentenceBadge>

      <section aria-labelledby="expenses" className="space-y-3">
        <h2 id="expenses" className="text-lg font-semibold">
          {t("expensesTitle")}
        </h2>
        {!expenses.ok || expenses.data.expenses.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noExpenses")}</p>
        ) : (
          <ul className="space-y-2">
            {expenses.data.expenses.map((expense) => (
              <li
                key={expense.id}
                className="flex flex-wrap items-start justify-between gap-2 rounded-lg border p-3 text-sm"
              >
                <span className="min-w-0">
                  <Link
                    href={`/spending/petty-cash/expenses/${expense.id}`}
                    className="font-medium underline underline-offset-4"
                  >
                    {expense.number}
                  </Link>{" "}
                  · {expense.payeeName}
                  <span className="block text-xs text-muted-foreground">
                    {formatCalendarDate(expense.spentOn)} · {expense.description}
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  <span className="tabular-nums">
                    {formatKES(expense.amountMinor + expense.chargeMinor)}
                  </span>
                  <StatusBadge tone={expenseTone[expense.status]}>
                    {tStatus(`expense.${expense.status}`)}
                  </StatusBadge>
                  {expense.receiptCount === 0 ? (
                    <StatusBadge tone="warning">{t("noReceipt")}</StatusBadge>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
        <Pager
          label={t("expensesTitle")}
          {...pages("expenses", expenses.ok ? expenses.data.page.nextCursor : null)}
        />
      </section>

      <section aria-labelledby="top-ups" className="space-y-3">
        <h2 id="top-ups" className="text-lg font-semibold">
          {t("topUpsTitle")}
        </h2>
        {!topUps.ok || topUps.data.topUps.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noTopUps")}</p>
        ) : (
          <ul className="space-y-2">
            {topUps.data.topUps.map((topUp) => (
              <li key={topUp.id} className="space-y-2 rounded-lg border p-3 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="min-w-0">
                    <span className="font-medium">{topUp.number}</span> · {topUp.reason}
                    <span className="block text-xs text-muted-foreground">
                      {t("requestedBy", {
                        name: topUp.requestedBy.displayName,
                        when: formatDateTime(topUp.requestedAt),
                      })}
                      {topUp.decidedBy
                        ? ` · ${t("decidedBy", { name: topUp.decidedBy.displayName })}`
                        : ""}
                      {topUp.paidBy && topUp.method
                        ? ` · ${t("paidBy", { name: topUp.paidBy.displayName, method: tMethod(topUp.method), reference: topUp.reference ?? "" })}`
                        : ""}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="tabular-nums">{formatKES(topUp.amountMinor)}</span>
                    <StatusBadge tone={topUpTone[topUp.status]}>
                      {tStatus(`topUp.${topUp.status}`)}
                    </StatusBadge>
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {topUp.permissions.canApprove ? (
                    <SpendingAction
                      path={`/petty-cash/top-ups/${topUp.id}/approve`}
                      entity="topUp"
                      body={{ version: topUp.version }}
                      primary
                      text={{
                        button: t("approveTopUp"),
                        title: t("approveTopUpTitle", { number: topUp.number }),
                        description: t("approveTopUpDescription"),
                        confirm: t("approveTopUp"),
                      }}
                    />
                  ) : null}
                  {topUp.permissions.canPay ? (
                    <SpendingAction
                      path={`/petty-cash/top-ups/${topUp.id}/pay`}
                      entity="topUp"
                      body={{ version: topUp.version }}
                      primary
                      fields={[
                        {
                          kind: "select",
                          name: "method",
                          label: t("payMethod"),
                          options: TOP_UP_METHODS.map((method) => ({
                            value: method,
                            label: tMethod(method),
                          })),
                        },
                        {
                          kind: "text",
                          name: "reference",
                          label: t("payReference"),
                          maxLength: 60,
                        },
                        { kind: "date", name: "paidOn", label: t("paidOn"), defaultValue: today },
                      ]}
                      text={{
                        button: t("payTopUp"),
                        title: t("payTopUpTitle", { number: topUp.number }),
                        description: t("payTopUpDescription"),
                        confirm: t("payTopUp"),
                      }}
                    />
                  ) : null}
                  {topUp.permissions.canReject ? (
                    <SpendingAction
                      path={`/petty-cash/top-ups/${topUp.id}/reject`}
                      entity="topUp"
                      body={{ version: topUp.version }}
                      fields={[{ kind: "reason" }]}
                      destructive
                      text={{
                        button: t("rejectTopUp"),
                        title: t("rejectTopUpTitle", { number: topUp.number }),
                        description: t("rejectTopUpDescription"),
                        confirm: t("rejectTopUp"),
                      }}
                    />
                  ) : null}
                  {topUp.permissions.canCancel ? (
                    <SpendingAction
                      path={`/petty-cash/top-ups/${topUp.id}/cancel`}
                      entity="topUp"
                      body={{ version: topUp.version }}
                      fields={[{ kind: "reason" }]}
                      destructive
                      text={{
                        button: t("cancelTopUp"),
                        title: t("cancelTopUpTitle", { number: topUp.number }),
                        description: t("cancelTopUpDescription"),
                        confirm: t("cancelTopUp"),
                      }}
                    />
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        <Pager
          label={t("topUpsTitle")}
          {...pages("topUps", topUps.ok ? topUps.data.page.nextCursor : null)}
        />
      </section>

      <section aria-labelledby="counts" className="space-y-3">
        <h2 id="counts" className="text-lg font-semibold">
          {t("countsTitle")}
        </h2>
        {!counts.ok || counts.data.counts.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noCounts")}</p>
        ) : (
          <ul className="space-y-2">
            {counts.data.counts.map((count) => (
              <li key={count.id} className="space-y-2 rounded-lg border p-3 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="min-w-0">
                    <span className="font-medium">{count.number}</span>
                    <span className="block text-xs text-muted-foreground">
                      {t("countedBy", {
                        name: count.countedBy.displayName,
                        when: formatDateTime(count.countedAt),
                      })}
                      {count.note ? ` · ${count.note}` : ""}
                    </span>
                  </span>
                  <StatusBadge tone={countTone[count.status]}>
                    {tStatus(`count.${count.status}`)}
                  </StatusBadge>
                </div>
                <dl className="grid grid-cols-3 gap-2 tabular-nums">
                  <div>
                    <dt className="text-xs text-muted-foreground">{t("counted")}</dt>
                    <dd>{formatKES(count.countedMinor)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">{t("book")}</dt>
                    <dd>{formatKES(count.bookMinor)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">{t("variance")}</dt>
                    <dd className={count.varianceMinor < 0 ? "text-destructive" : undefined}>
                      {formatKES(count.varianceMinor)}
                      <span className="block text-xs text-muted-foreground">
                        {count.varianceMinor < 0
                          ? t("shortage")
                          : count.varianceMinor > 0
                            ? t("overage")
                            : t("balanced")}
                      </span>
                    </dd>
                  </div>
                </dl>
                <div className="flex flex-wrap gap-2">
                  {count.permissions.canApprove ? (
                    <SpendingAction
                      path={`/petty-cash/counts/${count.id}/approve`}
                      entity="count"
                      body={{ version: count.version }}
                      primary
                      text={{
                        button: t("approveCount"),
                        title: t("approveCountTitle", { number: count.number }),
                        description: t("approveCountDescription"),
                        confirm: t("approveCount"),
                      }}
                    />
                  ) : null}
                  {count.permissions.canReturn ? (
                    <SpendingAction
                      path={`/petty-cash/counts/${count.id}/return`}
                      entity="count"
                      body={{ version: count.version }}
                      fields={[{ kind: "reason" }]}
                      text={{
                        button: t("returnCount"),
                        title: t("returnCountTitle", { number: count.number }),
                        description: t("returnCountDescription"),
                        confirm: t("returnCount"),
                      }}
                    />
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        <Pager
          label={t("countsTitle")}
          {...pages("counts", counts.ok ? counts.data.page.nextCursor : null)}
        />
      </section>

      <section aria-labelledby="float-ledger" className="space-y-3">
        <h2 id="float-ledger" className="text-lg font-semibold">
          {t("ledgerTitle")}
        </h2>
        {!ledger.ok || ledger.data.entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noEntries")}</p>
        ) : (
          <ScrollTable label={t("ledgerTitle")} minWidth={560}>
            <thead>
              <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2 pl-4 font-medium">
                  {t("cols.entry")}
                </th>
                <th scope="col" className="py-2 pr-2 font-medium">
                  {t("cols.document")}
                </th>
                <th scope="col" className="py-2 pr-2 text-right font-medium">
                  {t("cols.amount")}
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">
                  {t("cols.balance")}
                </th>
              </tr>
            </thead>
            <tbody>
              {ledger.data.entries.map((entry) => (
                <tr key={entry.id} className="border-b align-top last:border-0">
                  <td className="py-2 pl-4">
                    {tKind(entry.kind)}
                    <span className="block text-xs text-muted-foreground">
                      #{entry.seq} · {formatDateTime(entry.recordedAt)}
                    </span>
                  </td>
                  <td className="py-2 pr-2">
                    {entry.document.kind === "expense" ? (
                      <Link
                        href={`/spending/petty-cash/expenses/${entry.document.id}`}
                        className="underline underline-offset-4"
                      >
                        {entry.document.number}
                      </Link>
                    ) : (
                      entry.document.number
                    )}
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {formatKES(entry.amountMinor)}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {formatKES(entry.balanceMinor)}
                  </td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
        )}
        <Pager
          label={t("ledgerTitle")}
          {...pages("entries", ledger.ok ? ledger.data.page.nextCursor : null)}
        />
      </section>
    </div>
  );
}
