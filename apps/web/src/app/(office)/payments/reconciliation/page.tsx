import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { addCalendarDays } from "@pm-buddy/domain";
import {
  RECONCILIATION_ITEM_CATEGORIES,
  RECONCILIATION_ITEM_CATEGORY,
  RECONCILIATION_ITEM_KINDS,
  RECONCILIATION_ITEM_SEVERITIES,
  RECONCILIATION_ITEM_STATUSES,
} from "@pm-buddy/types";
import * as wire from "@pm-buddy/validation";
import { PaymentsFrame } from "@/components/payments/payments-frame";
import { ReconciliationActions } from "@/components/payments/reconciliation";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { selectClass } from "@/components/labour/action-dialog";
import { formatCalendarDate, formatDateTime, formatKES } from "@/lib/format";
import { paymentsAllowed } from "@/lib/payments";
import { reconciliationSeverityTone } from "@/lib/payouts";
import { loadLive, requireSession, serverApi } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("reconciliation");
  return { title: t("title") };
}

const PAGE = 25;

/**
 * Daily M-Pesa reconciliation (D4.3 §11): the day at a glance by category and severity, run now,
 * statement upload and the items with their filters. Resolution happens on each item's page.
 */
export default async function ReconciliationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const one = (key: string) => (typeof raw[key] === "string" ? raw[key] : undefined);
  const date = z.iso.date().safeParse(one("date"));
  const kind = wire.reconciliationItemKindSchema.safeParse(one("kind"));
  const status = wire.reconciliationItemStatusSchema.safeParse(one("status"));
  const severity = wire.reconciliationItemSeveritySchema.safeParse(one("severity"));
  const offset = Math.min(100_000, Math.max(0, Math.trunc(Number(one("offset")) || 0)));
  const filters = new URLSearchParams();
  if (date.success) filters.set("date", date.data);
  if (kind.success) filters.set("kind", kind.data);
  if (status.success) filters.set("status", status.data);
  if (severity.success) filters.set("severity", severity.data);
  const href = `/payments/reconciliation${filters.size ? `?${filters}` : ""}`;
  const session = await requireSession(href);
  if (!session) return <LiveUnavailable retryHref={href} />;
  if (!paymentsAllowed(session.company, ["payments.view", "payments.review"]))
    return <LiveForbidden />;
  const day = await loadLive(
    `/payments/reconciliation${date.success ? `?date=${date.data}` : ""}`,
    wire.reconciliationDayResponseSchema,
    href,
  );
  if (!day.ok)
    return day.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={href} />;
  const v = day.data;
  const query = new URLSearchParams({ date: v.date, limit: String(PAGE), offset: String(offset) });
  if (kind.success) query.set("kind", kind.data);
  if (status.success) query.set("status", status.data);
  if (severity.success) query.set("severity", severity.data);
  const items = await serverApi(
    `/payments/reconciliation/items?${query}`,
    wire.reconciliationItemsResponseSchema,
  );
  const t = await getTranslations("reconciliation");
  const tPayments = await getTranslations("payments");
  const byCategory = RECONCILIATION_ITEM_CATEGORIES.map((category) => ({
    category,
    count: RECONCILIATION_ITEM_KINDS.filter(
      (entry) => RECONCILIATION_ITEM_CATEGORY[entry] === category,
    ).reduce((sum, entry) => sum + v.counts.byKind[entry], 0),
  }));
  const dayHref = (value: string) => `/payments/reconciliation?date=${value}`;
  const pageHref = (next: number) => {
    const params = new URLSearchParams(filters);
    params.set("date", v.date);
    if (next > 0) params.set("offset", String(next));
    else params.delete("offset");
    return `/payments/reconciliation?${params}`;
  };
  const kindLabel = (value: (typeof RECONCILIATION_ITEM_KINDS)[number]) => t(`kinds.${value}`);
  const statusLabel = (value: (typeof RECONCILIATION_ITEM_STATUSES)[number]) =>
    t(`statuses.${value}`);
  const severityLabel = (value: (typeof RECONCILIATION_ITEM_SEVERITIES)[number]) =>
    t(`severities.${value}`);
  return (
    <PaymentsFrame
      current="reconciliation"
      title={t("title")}
      description={t("description")}
      canTest={session.company.permissions.includes("payments.initiate_test")}
    >
      <form
        action="/payments/reconciliation"
        className="flex flex-wrap items-end gap-2"
        aria-label={t("chooseDay")}
      >
        <label className="space-y-1 text-sm">
          <span className="block">{t("businessDate")}</span>
          <input
            type="date"
            name="date"
            defaultValue={v.date}
            max={v.today}
            className={`${selectClass} w-auto`}
          />
        </label>
        <Button type="submit" variant="outline">
          {t("show")}
        </Button>
        <Link className="text-sm underline" href={dayHref(addCalendarDays(v.date, -1))}>
          {t("previousDay")}
        </Link>
        {v.date < v.today ? (
          <Link className="text-sm underline" href={dayHref(addCalendarDays(v.date, 1))}>
            {t("nextDay")}
          </Link>
        ) : null}
        {v.date !== v.today ? (
          <Link className="text-sm underline" href={dayHref(v.today)}>
            {t("today")}
          </Link>
        ) : null}
      </form>

      <section aria-labelledby="day-heading" className="space-y-3">
        <h2 id="day-heading" className="text-lg font-semibold">
          {t("dayTitle", { date: formatCalendarDate(v.date) })}
        </h2>
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <StatusBadge tone={v.statementCovered ? "success" : "warning"}>
            {t(v.statementCovered ? "statementCovered" : "statementMissing")}
          </StatusBadge>
          {v.lastRun
            ? t("lastRun", {
                date: formatDateTime(v.lastRun.startedAt),
                trigger: t(`triggers.${v.lastRun.trigger}`),
              })
            : t("neverRun")}
        </p>
        {v.counts.critical > 0 ? (
          <p
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm"
          >
            {t("criticalAlert", { count: v.counts.critical })}
          </p>
        ) : null}
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          {byCategory.map(({ category, count }) => (
            <div key={category} className="rounded-lg border p-3">
              <dt className="text-muted-foreground">{t(`categories.${category}`)}</dt>
              <dd className="text-2xl font-semibold">{count}</dd>
            </div>
          ))}
        </dl>
        <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          {(
            [
              ["open", String(v.counts.open)],
              ["resolved", String(v.counts.resolved)],
              ["critical", String(v.counts.critical)],
              ["awaitingStatement", String(v.counts.awaitingStatement)],
              ["payouts", `${v.totals.payouts} · ${formatKES(v.totals.payoutsMinor)}`],
              ["matchedAmount", formatKES(v.totals.matchedMinor)],
              ["bookedCharges", formatKES(v.totals.bookedChargesMinor)],
              ["statementCharges", formatKES(v.totals.statementChargesMinor)],
            ] as const
          ).map(([key, value]) => (
            <div key={key} className="rounded-lg border p-3">
              <dt className="text-muted-foreground">{t(`totals.${key}`)}</dt>
              <dd className="font-semibold">{value}</dd>
            </div>
          ))}
        </dl>
        <details className="text-sm">
          <summary className="cursor-pointer">{t("byKind")}</summary>
          <ul className="mt-2 grid gap-1 sm:grid-cols-2">
            {RECONCILIATION_ITEM_KINDS.map((entry) => (
              <li key={entry}>
                {kindLabel(entry)}: {v.counts.byKind[entry]}
              </li>
            ))}
          </ul>
        </details>
      </section>

      <ReconciliationActions
        date={v.date}
        canRun={v.permissions.canRun}
        canUpload={v.permissions.canUpload}
      />

      <section aria-labelledby="statements-heading" className="space-y-2">
        <h2 id="statements-heading" className="text-lg font-semibold">
          {t("statementsForDay")}
        </h2>
        {v.statements.length ? (
          <ul className="space-y-1 text-sm">
            {v.statements.map((statement) => (
              <li key={statement.id} className="break-words">
                <Link className="underline" href={`/payments/statements/${statement.id}`}>
                  {statement.fileName}
                </Link>{" "}
                · {t("statementLines", { lines: statement.lines, issues: statement.issues })}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm">{t("noStatementForDay")}</p>
        )}
        <Link className="text-sm underline" href="/payments/statements">
          {t("allStatements")}
        </Link>
      </section>

      <section aria-labelledby="items-heading" className="space-y-3">
        <h2 id="items-heading" className="text-lg font-semibold">
          {t("items")}
        </h2>
        <form action="/payments/reconciliation" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="date" value={v.date} />
          <label className="space-y-1 text-sm">
            <span className="block">{t("filters.kind")}</span>
            <select
              name="kind"
              defaultValue={kind.success ? kind.data : ""}
              className={`${selectClass} w-auto`}
            >
              <option value="">{tPayments("all")}</option>
              {RECONCILIATION_ITEM_KINDS.map((value) => (
                <option key={value} value={value}>
                  {kindLabel(value)}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="block">{t("filters.status")}</span>
            <select
              name="status"
              defaultValue={status.success ? status.data : ""}
              className={`${selectClass} w-auto`}
            >
              <option value="">{tPayments("all")}</option>
              {RECONCILIATION_ITEM_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {statusLabel(value)}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="block">{t("filters.severity")}</span>
            <select
              name="severity"
              defaultValue={severity.success ? severity.data : ""}
              className={`${selectClass} w-auto`}
            >
              <option value="">{tPayments("all")}</option>
              {RECONCILIATION_ITEM_SEVERITIES.map((value) => (
                <option key={value} value={value}>
                  {severityLabel(value)}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="outline">
            {tPayments("filter")}
          </Button>
        </form>
        {items.ok ? (
          <>
            <p className="text-sm">
              {t("itemCount", { count: items.data.total, open: items.data.open })}
            </p>
            <Table aria-label={t("items")}>
              <TableHeader>
                <TableRow>
                  {(
                    [
                      "kind",
                      "severity",
                      "status",
                      "worker",
                      "amount",
                      "receipt",
                      "owner",
                      "age",
                    ] as const
                  ).map((key) => (
                    <TableHead key={key}>{t(`columns.${key}`)}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.data.items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <Link
                        className="underline"
                        href={`/payments/reconciliation/items/${item.id}`}
                      >
                        {kindLabel(item.kind)}
                      </Link>
                      <span className="block text-xs text-muted-foreground">
                        {t(`categories.${item.category}`)}
                        {item.awaitingStatement ? ` · ${t("awaiting")}` : ""}
                      </span>
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={reconciliationSeverityTone[item.severity]}>
                        {severityLabel(item.severity)}
                      </StatusBadge>
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={item.status === "open" ? "warning" : "neutral"}>
                        {statusLabel(item.status)}
                      </StatusBadge>
                      {item.outcome ? (
                        <span className="block text-xs">{t(`outcomes.${item.outcome}`)}</span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      {item.worker ? `${item.worker.nameMasked} · ${item.worker.workerNo}` : "—"}
                    </TableCell>
                    <TableCell>
                      {item.amountMinor !== null ? formatKES(item.amountMinor) : "—"}
                      {item.statementAmountMinor !== null &&
                      item.statementAmountMinor !== item.amountMinor ? (
                        <span className="block text-xs">
                          {t("statementAmount", { amount: formatKES(item.statementAmountMinor) })}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{item.receipt ?? "—"}</TableCell>
                    <TableCell>{item.owner?.displayName ?? "—"}</TableCell>
                    <TableCell>{t("ageHours", { hours: item.ageHours })}</TableCell>
                  </TableRow>
                ))}
                {!items.data.items.length ? (
                  <TableRow>
                    <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                      {t("noItems")}
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
            <nav aria-label={t("pages")} className="flex gap-4 text-sm">
              {offset > 0 ? (
                <Link className="underline" href={pageHref(Math.max(0, offset - PAGE))}>
                  {tPayments("previous")}
                </Link>
              ) : null}
              {offset + PAGE < items.data.total ? (
                <Link className="underline" href={pageHref(offset + PAGE)}>
                  {tPayments("next")}
                </Link>
              ) : null}
            </nav>
          </>
        ) : (
          <p role="alert" className="text-sm text-destructive">
            {t("itemsUnavailable")}
          </p>
        )}
      </section>
    </PaymentsFrame>
  );
}
