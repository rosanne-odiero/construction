import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import * as wire from "@pm-buddy/validation";
import { PaymentsFrame } from "@/components/payments/payments-frame";
import { ItemActions } from "@/components/payments/reconciliation";
import { DisputeButton } from "@/components/payroll/obligation-sheet";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { formatCalendarDate, formatDateTime, formatKES } from "@/lib/format";
import { paymentsAllowed } from "@/lib/payments";
import { reconciliationSeverityTone } from "@/lib/payouts";
import { loadLive, requireSession } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("reconciliation");
  return { title: t("itemTitle") };
}

/** One reconciliation item: its evidence, append-only history and the reviewer's actions. */
export default async function ReconciliationItemPage({
  params,
}: {
  params: Promise<{ itemId: string }>;
}) {
  const { itemId } = await params;
  if (!z.uuid().safeParse(itemId).success) notFound();
  const href = `/payments/reconciliation/items/${itemId}`;
  const session = await requireSession(href);
  if (!session) return <LiveUnavailable retryHref={href} />;
  if (!paymentsAllowed(session.company, ["payments.view", "payments.review"]))
    return <LiveForbidden />;
  const result = await loadLive(href, wire.reconciliationItemResponseSchema, href);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={href} />;
  const value = result.data;
  const { item } = value;
  const t = await getTranslations("reconciliation");
  const canDispute =
    session.company.permissions.includes("payments.review") &&
    item.payout !== null &&
    item.kind !== "worker_dispute";
  const line = (statementLine: wire.StatementLineWire) => (
    <li key={statementLine.id} className="space-y-0.5 rounded-lg border p-2">
      <p className="font-mono text-xs">
        {statementLine.receipt} · {t(`lineClasses.${statementLine.lineClass}`)} ·{" "}
        {formatDateTime(statementLine.completedAt)}
      </p>
      <p>
        {statementLine.withdrawnMinor
          ? t("withdrawn", { amount: formatKES(statementLine.withdrawnMinor) })
          : t("paidIn", { amount: formatKES(statementLine.paidInMinor) })}
        {statementLine.details ? ` · ${statementLine.details}` : ""}
      </p>
      {statementLine.otherPartyMasked ? (
        <p className="text-xs">{statementLine.otherPartyMasked}</p>
      ) : null}
      <Link className="text-xs underline" href={`/payments/statements/${statementLine.statementId}`}>
        {t("statementRow", { row: statementLine.row })}
      </Link>
    </li>
  );
  return (
    <PaymentsFrame
      current="reconciliation"
      title={t("itemTitle")}
      canTest={session.company.permissions.includes("payments.initiate_test")}
    >
      <Link
        className="text-sm underline"
        href={`/payments/reconciliation?date=${item.businessDate}`}
      >
        {t("backToDay", { date: formatCalendarDate(item.businessDate) })}
      </Link>
      <section aria-labelledby="item-heading" className="min-w-0 space-y-3 rounded-xl border p-4">
        <h2 id="item-heading" className="text-lg font-semibold">
          {t(`kinds.${item.kind}`)}
        </h2>
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <StatusBadge tone={reconciliationSeverityTone[item.severity]}>
            {t(`severities.${item.severity}`)}
          </StatusBadge>
          <StatusBadge tone={item.status === "open" ? "warning" : "neutral"}>
            {t(`statuses.${item.status}`)}
          </StatusBadge>
          <span>{t(`categories.${item.category}`)}</span>
        </p>
        <p className="text-sm">{t(`kindHints.${item.kind}`)}</p>
        {item.awaitingStatement ? (
          <p role="note" className="text-sm">
            {t("awaitingHint")}
          </p>
        ) : null}
        <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
          <dt className="text-muted-foreground">{t("businessDate")}</dt>
          <dd>{formatCalendarDate(item.businessDate)}</dd>
          <dt className="text-muted-foreground">{t("opened")}</dt>
          <dd>
            {formatDateTime(item.openedAt)} · {t("ageHours", { hours: item.ageHours })}
          </dd>
          <dt className="text-muted-foreground">{t("owner")}</dt>
          <dd>{item.owner?.displayName ?? t("unassigned")}</dd>
          {item.worker ? (
            <>
              <dt className="text-muted-foreground">{t("columns.worker")}</dt>
              <dd>
                {item.worker.nameMasked} · {item.worker.workerNo}
              </dd>
            </>
          ) : null}
          {item.receipt ? (
            <>
              <dt className="text-muted-foreground">{t("columns.receipt")}</dt>
              <dd className="font-mono">{item.receipt}</dd>
            </>
          ) : null}
          {item.amountMinor !== null || item.statementAmountMinor !== null ? (
            <>
              <dt className="text-muted-foreground">{t("amounts")}</dt>
              <dd>
                {t("amountPair", {
                  booked: item.amountMinor === null ? "—" : formatKES(item.amountMinor),
                  statement:
                    item.statementAmountMinor === null ? "—" : formatKES(item.statementAmountMinor),
                })}
              </dd>
            </>
          ) : null}
          {item.bookedChargeMinor !== null || item.statementChargeMinor !== null ? (
            <>
              <dt className="text-muted-foreground">{t("charges")}</dt>
              <dd>
                {t("amountPair", {
                  booked: item.bookedChargeMinor === null ? "—" : formatKES(item.bookedChargeMinor),
                  statement:
                    item.statementChargeMinor === null
                      ? "—"
                      : formatKES(item.statementChargeMinor),
                })}
              </dd>
            </>
          ) : null}
        </dl>
        <div className="space-y-1 text-sm">
          <h3 className="font-semibold">{t("evidence")}</h3>
          <ul className="space-y-1">
            {item.payout ? (
              <li>
                <Link
                  className="underline"
                  href={`/payroll/batches/${item.payout.batchId}/payouts`}
                >
                  {t("payoutLink", { method: t(`methods.${item.payout.method}`) })}
                </Link>
                {item.payout.createdBy
                  ? ` · ${t("payoutBy", { name: item.payout.createdBy.displayName })}`
                  : ""}
              </li>
            ) : null}
            {item.paymentRequestId ? (
              <li>
                <Link className="underline" href={`/payments/requests/${item.paymentRequestId}`}>
                  {t("requestLink")}
                </Link>
              </li>
            ) : null}
            {item.caseId ? (
              <li>
                <Link className="underline" href={`/payments/cases/${item.caseId}`}>
                  {t("caseLink")}
                </Link>
              </li>
            ) : null}
            {item.journalId ? (
              <li>
                <Link className="underline" href={`/spending/journals/${item.journalId}`}>
                  {t("journalLink")}
                </Link>
              </li>
            ) : null}
          </ul>
          {value.statementLine ? (
            <>
              <h4 className="font-medium">{t("statementLine")}</h4>
              <ul className="space-y-1">{line(value.statementLine)}</ul>
            </>
          ) : null}
          {value.chargeLines.length ? (
            <>
              <h4 className="font-medium">{t("chargeLines")}</h4>
              <ul className="space-y-1">{value.chargeLines.map(line)}</ul>
            </>
          ) : null}
          {item.relatedLineIds.length > 1 ? (
            <p>{t("relatedLines", { count: item.relatedLineIds.length })}</p>
          ) : null}
        </div>
        {item.outcome ? (
          <p className="text-sm">
            {t("resolvedAs", { outcome: t(`outcomes.${item.outcome}`) })}
            {item.resolvedBy && item.resolvedAt
              ? ` · ${item.resolvedBy.displayName} · ${formatDateTime(item.resolvedAt)}`
              : ""}
            {item.resolutionReason ? (
              <span className="block break-words">{item.resolutionReason}</span>
            ) : null}
          </p>
        ) : null}
        {canDispute && item.payout ? <DisputeButton payout={item.payout} /> : null}
      </section>
      <ItemActions value={value} userId={session.user.id} />
      <section aria-labelledby="history-heading" className="space-y-2">
        <h2 id="history-heading" className="text-lg font-semibold">
          {t("history")}
        </h2>
        <ol className="space-y-2 border-l pl-4 text-sm">
          {[...value.events]
            .sort((a, b) => a.at.localeCompare(b.at))
            .map((event) => (
              <li key={event.id} className="space-y-0.5 break-words">
                <p>
                  <span className="font-medium">{t(`events.${event.event}`)}</span> ·{" "}
                  {event.actor?.displayName ?? t("system")} · {formatDateTime(event.at)}
                </p>
                {event.owner ? <p>{t("ownerSet", { name: event.owner.displayName })}</p> : null}
                {event.outcome ? <p>{t(`outcomes.${event.outcome}`)}</p> : null}
                {event.note ? <p className="text-muted-foreground">{event.note}</p> : null}
              </li>
            ))}
        </ol>
        <p className="text-xs text-muted-foreground">{t("appendOnly")}</p>
      </section>
    </PaymentsFrame>
  );
}
