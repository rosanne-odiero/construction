import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { SPEND_ALERT_KINDS, type SpendAlertKind } from "@pm-buddy/types";
import { spendAlertsResponseSchema, type SpendAlert } from "@pm-buddy/validation";
import { apiQuery, listHrefs, Pager } from "@/components/procurement/p2p/list-filters";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { SentenceBadge } from "@/components/spending/sentence-badge";
import { spendingSelectClass } from "@/components/spending/spending-action";
import { SpendingEyebrow, SpendingSubnav } from "@/components/spending/spending-subnav";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { formatCalendarDate, formatKES } from "@/lib/format";
import { loadOrRedirect, projectOptions } from "@/lib/p2p-server";
import { pickParam } from "@/lib/p2p";
import { requireSession } from "@/lib/server-api";
import { alertTone } from "@/lib/spending";
import { isUuid } from "@/lib/stores";

export async function generateMetadata() {
  const t = await getTranslations("spending.alerts");
  return { title: t("title") };
}

function recordHref(record: SpendAlert["records"][number]): string | null {
  if (record.kind === "expense") return `/spending/petty-cash/expenses/${record.id}`;
  if (record.kind === "invoice") return `/procurement/invoices/${record.id}`;
  return null;
}

/**
 * Spend alerts, computed from the records on every read (D5.4): budget threshold reached,
 * unusual spend, possible duplicate payments and payments without supporting documents. In-app
 * only; notifications come with Phase 8.
 */
export default async function SpendAlertsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const project = isUuid(pickParam(raw, "project")) ? pickParam(raw, "project") : undefined;
  const kindParam = pickParam(raw, "kind");
  const kind = SPEND_ALERT_KINDS.includes(kindParam as SpendAlertKind) ? kindParam : undefined;
  const cursorParam = pickParam(raw, "cursor");
  const cursor = cursorParam && /^\d{1,6}$/.test(cursorParam) ? cursorParam : undefined;
  const path = `/spending/alerts${apiQuery({ project, kind, cursor })}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [result, projects] = await Promise.all([
    loadOrRedirect(
      `/spending/alerts${apiQuery({ projectId: project, kind, cursor, limit: "50" })}`,
      spendAlertsResponseSchema,
      path,
    ),
    projectOptions(),
  ]);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("spending.alerts");
  const tCategory = await getTranslations("spending.categories");
  const { alerts, counts, page } = result.data;
  const hrefs = listHrefs("/spending/alerts", { project, kind }, page.nextCursor);

  const describe = (alert: SpendAlert): string => {
    switch (alert.kind) {
      case "budget_threshold": {
        const scope =
          alert.scope?.kind === "category" && alert.scope.category
            ? tCategory(alert.scope.category)
            : alert.scope?.kind === "bill" && alert.scope.bill
              ? t("billScope", { number: alert.scope.bill.number, title: alert.scope.bill.title })
              : t("projectScope");
        return t("describe.budget_threshold", {
          scope,
          used: formatKES(alert.figures?.usedMinor ?? 0),
          budget: formatKES(alert.figures?.budgetMinor ?? 0),
          percent: alert.figures?.usedPercent ?? "—",
          threshold: alert.figures?.thresholdPercent ?? 0,
        });
      }
      case "unusual_spend":
        return t("describe.unusual_spend", {
          amount: formatKES(alert.amountMinor ?? 0),
          multiplier: alert.typical?.multiplier ?? "—",
          samples: alert.typical?.samples ?? 0,
          median: alert.typical ? formatKES(Number(alert.typical.medianMinor.split(".")[0])) : "—",
        });
      case "duplicate_payment":
        return alert.rule === "same_reference"
          ? t("describe.same_reference")
          : t("describe.same_counterparty_amount", { amount: formatKES(alert.amountMinor ?? 0) });
      default:
        return t("describe.missing_documents", { amount: formatKES(alert.amountMinor ?? 0) });
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={<SpendingEyebrow />} title={t("title")} description={t("description")} />
      <SpendingSubnav current="alerts" />
      <ul className="flex flex-wrap gap-2" aria-label={t("countsLabel")}>
        {SPEND_ALERT_KINDS.map((value) => (
          <li key={value}>
            <Link
              href={`/spending/alerts${apiQuery({ project, kind: value })}`}
              aria-current={kind === value ? "true" : undefined}
              className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm hover:bg-muted aria-[current=true]:border-primary"
            >
              {t(`kinds.${value}`)}
              <span className="tabular-nums font-semibold">{counts[value] ?? 0}</span>
            </Link>
          </li>
        ))}
      </ul>
      <form
        key={`${project ?? ""}|${kind ?? ""}`}
        method="get"
        action="/spending/alerts"
        role="search"
        className="flex flex-wrap items-end gap-2"
      >
        {kind ? <input type="hidden" name="kind" value={kind} /> : null}
        <div className="min-w-0 space-y-1.5">
          <label htmlFor="alerts-project" className="block text-sm font-medium">
            {t("project")}
          </label>
          <select
            id="alerts-project"
            name="project"
            defaultValue={project ?? ""}
            className={`${spendingSelectClass} max-w-xs`}
          >
            <option value="">{t("allProjects")}</option>
            {projects.map((option) => (
              <option key={option.id} value={option.id}>
                {option.code} · {option.name}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" variant="secondary">
          {t("apply")}
        </Button>
        {project || kind ? (
          <Button asChild variant="ghost">
            <Link href="/spending/alerts">{t("clear")}</Link>
          </Button>
        ) : null}
      </form>
      <SentenceBadge tone="info">{t("inAppOnly")}</SentenceBadge>
      {alerts.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm">{t("empty")}</p>
      ) : (
        <ul className="space-y-3">
          {alerts.map((alert) => (
            <li key={alert.id} className="space-y-2 rounded-xl border p-4 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge tone={alertTone[alert.severity]}>
                  {t(`severity.${alert.severity}`)}
                </StatusBadge>
                <span className="font-semibold">{t(`kinds.${alert.kind}`)}</span>
                <span className="text-muted-foreground">
                  {alert.project.code} · {formatCalendarDate(alert.detectedOn)}
                </span>
              </div>
              <p>{describe(alert)}</p>
              {alert.records.length ? (
                <ul className="flex flex-wrap gap-2">
                  {alert.records.map((record) => {
                    const href = recordHref(record);
                    const label = [
                      record.label,
                      record.date ? formatCalendarDate(record.date) : null,
                      record.amountMinor !== null ? formatKES(record.amountMinor) : null,
                    ]
                      .filter(Boolean)
                      .join(" · ");
                    return (
                      <li
                        key={`${record.kind}-${record.id}`}
                        className="rounded-md border px-2 py-1"
                      >
                        <span className="text-xs text-muted-foreground">
                          {t(`records.${record.kind}`)}{" "}
                        </span>
                        {href ? (
                          <Link href={href} className="underline underline-offset-4">
                            {label}
                          </Link>
                        ) : (
                          label
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
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
