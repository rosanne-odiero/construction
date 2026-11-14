import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { nairobiDate } from "@pm-buddy/domain";
import { FORECAST_LINE_KINDS } from "@pm-buddy/types";
import { cashFlowItemsResponseSchema, forecastResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { apiQuery, Pager } from "@/components/procurement/p2p/list-filters";
import { LiveUnavailable } from "@/components/projects/live-state";
import { ForecastChart } from "@/components/spending/forecast-chart";
import { SentenceBadge } from "@/components/spending/sentence-badge";
import { SpendingAction, spendingSelectClass } from "@/components/spending/spending-action";
import { SpendingEyebrow, SpendingSubnav } from "@/components/spending/spending-subnav";
import { StatusBadge } from "@/components/status-badge";
import { ScrollTable } from "@/components/stores/stores-subnav";
import { Button } from "@/components/ui/button";
import { formatCalendarDate, formatKES } from "@/lib/format";
import { loadOrRedirect, projectOptions } from "@/lib/p2p-server";
import { pickParam } from "@/lib/p2p";
import { requireSession, serverApi } from "@/lib/server-api";
import { isUuid } from "@/lib/stores";

export async function generateMetadata() {
  const t = await getTranslations("spending.forecast");
  return { title: t("title") };
}

/**
 * The weekly cash-flow forecast for the company or one project: opening position, payroll,
 * supplier invoices due, approved LPOs not yet invoiced, expected client receipts and petty-cash
 * top-ups (D5.4). Estimates are labelled; overdue items fall in the first week.
 */
export default async function ForecastPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const project = isUuid(pickParam(raw, "project")) ? pickParam(raw, "project") : undefined;
  const itemsCursor = isUuid(pickParam(raw, "items")) ? pickParam(raw, "items") : undefined;
  const path = `/spending/forecast${apiQuery({ project, items: itemsCursor })}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [result, projects, items] = await Promise.all([
    loadOrRedirect(
      `/spending/forecast${project ? `?projectId=${project}` : ""}`,
      forecastResponseSchema,
      path,
    ),
    projectOptions(),
    serverApi(
      `/cash-flow-items${apiQuery({ status: "expected", projectId: project, cursor: itemsCursor, limit: "50" })}`,
      cashFlowItemsResponseSchema,
    ),
  ]);
  if (!result.ok && result.status !== 403) return <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("spending.forecast");
  const tKind = await getTranslations("spending.forecastKinds");
  const canAddItems = session.company.permissions.includes("finance.manage");
  const today = nairobiDate();

  const picker = (
    <form
      method="get"
      action="/spending/forecast"
      role="search"
      className="flex flex-wrap items-end gap-2"
    >
      <div className="min-w-0 space-y-1.5">
        <label htmlFor="forecast-project" className="block text-sm font-medium">
          {t("scope")}
        </label>
        <select
          id="forecast-project"
          name="project"
          defaultValue={project ?? ""}
          className={`${spendingSelectClass} max-w-xs`}
        >
          <option value="">{t("company")}</option>
          {projects.map((option) => (
            <option key={option.id} value={option.id}>
              {option.code} · {option.name}
            </option>
          ))}
        </select>
      </div>
      <Button type="submit" variant="secondary">
        {t("show")}
      </Button>
    </form>
  );

  if (!result.ok)
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow={<SpendingEyebrow />}
          title={t("title")}
          description={t("description")}
        />
        <SpendingSubnav current="forecast" />
        {picker}
        <SentenceBadge tone="warning">
          {project ? t("forbiddenProject") : t("forbiddenCompany")}
        </SentenceBadge>
      </div>
    );

  const forecast = result.data;
  const { opening } = forecast;
  const kinds = FORECAST_LINE_KINDS.filter((kind) =>
    forecast.weeks.some((week) => week.byKind[kind]),
  );

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={<SpendingEyebrow />} title={t("title")} description={t("description")} />
      <SpendingSubnav current="forecast" />
      {picker}
      <section aria-labelledby="opening" className="space-y-2 rounded-xl border p-4 text-sm">
        <h2 id="opening" className="font-semibold">
          {forecast.project
            ? t("projectTitle", { code: forecast.project.code, name: forecast.project.name })
            : t("companyTitle")}
        </h2>
        <p>
          {opening.basis === "none"
            ? t("openingNone")
            : t(`opening.${opening.basis}`, {
                amount: formatKES(opening.amountMinor ?? 0),
                entered: formatKES(opening.enteredMinor ?? 0),
                on: opening.enteredOn ? formatCalendarDate(opening.enteredOn) : "—",
                received: formatKES(opening.receivedSinceMinor),
                paid: formatKES(opening.paidSinceMinor),
              })}
        </p>
        {opening.basis === "none" ? (
          <Link href="/spending/settings" className="font-medium underline underline-offset-4">
            {t("enterOpening")}
          </Link>
        ) : null}
        <p className="text-muted-foreground">{t("assumptions")}</p>
      </section>

      <ForecastChart
        label={t("chartLabel", { weeks: forecast.weeks.length })}
        weeks={forecast.weeks.map((week) => ({
          start: week.start,
          inMinor: week.inMinor,
          outMinor: week.outMinor,
          closingMinor: week.closingMinor,
        }))}
      />

      <ScrollTable label={t("tableLabel")} minWidth={720 + kinds.length * 110}>
        <thead>
          <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
            <th scope="col" className="py-2 pl-4 font-medium">
              {t("cols.week")}
            </th>
            {kinds.map((kind) => (
              <th key={kind} scope="col" className="py-2 pr-2 text-right font-medium">
                {tKind(kind)}
              </th>
            ))}
            <th scope="col" className="py-2 pr-2 text-right font-medium">
              {t("cols.in")}
            </th>
            <th scope="col" className="py-2 pr-2 text-right font-medium">
              {t("cols.out")}
            </th>
            <th scope="col" className="py-2 pr-2 text-right font-medium">
              {t("cols.net")}
            </th>
            <th scope="col" className="py-2 pr-4 text-right font-medium">
              {t("cols.closing")}
            </th>
          </tr>
        </thead>
        <tbody>
          {forecast.weeks.map((week, index) => (
            <tr key={week.start} className="border-b align-top last:border-0">
              <th scope="row" className="py-2 pl-4 text-left font-medium whitespace-nowrap">
                {formatCalendarDate(week.start)}
                <span className="block text-xs font-normal text-muted-foreground">
                  {index === 0 && week.overdueMinor
                    ? t("overdue", { amount: formatKES(week.overdueMinor) })
                    : null}
                  {week.estimatedMinor
                    ? ` ${t("estimated", { amount: formatKES(week.estimatedMinor) })}`
                    : null}
                </span>
              </th>
              {kinds.map((kind) => (
                <td key={kind} className="py-2 pr-2 text-right tabular-nums">
                  {week.byKind[kind] ? formatKES(week.byKind[kind]) : "—"}
                </td>
              ))}
              <td className="py-2 pr-2 text-right tabular-nums">{formatKES(week.inMinor)}</td>
              <td className="py-2 pr-2 text-right tabular-nums">{formatKES(week.outMinor)}</td>
              <td className="py-2 pr-2 text-right tabular-nums">{formatKES(week.netMinor)}</td>
              <td
                className={`py-2 pr-4 text-right tabular-nums ${week.closingMinor !== null && week.closingMinor < 0 ? "text-destructive" : ""}`}
              >
                {week.closingMinor === null ? "—" : formatKES(week.closingMinor)}
              </td>
            </tr>
          ))}
        </tbody>
      </ScrollTable>
      <p className="text-sm text-muted-foreground">
        {t("later", {
          in: formatKES(forecast.later.inMinor),
          out: formatKES(forecast.later.outMinor),
        })}
      </p>

      <section aria-labelledby="lines" className="space-y-3">
        <h2 id="lines" className="text-lg font-semibold">
          {t("linesTitle")}
        </h2>
        {forecast.lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noLines")}</p>
        ) : (
          <ul className="space-y-2">
            {forecast.lines.map((line, index) => (
              <li
                key={`${line.kind}-${line.document?.id ?? index}-${line.date}`}
                className="flex flex-wrap items-start justify-between gap-2 rounded-lg border p-3 text-sm"
              >
                <span className="min-w-0">
                  <span className="font-medium">{tKind(line.kind)}</span>
                  {line.document
                    ? ` · ${/^\d{4}-\d{2}-\d{2}$/.test(line.document.label) ? formatCalendarDate(line.document.label) : line.document.label}`
                    : ""}
                  <span className="block text-xs text-muted-foreground">
                    {formatCalendarDate(line.date)} · {line.project.code}
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  <span className="tabular-nums">
                    {line.direction === "in" ? "+" : "−"}
                    {formatKES(line.amountMinor)}
                  </span>
                  {line.basis === "estimated" ? (
                    <StatusBadge tone="neutral">{t("estimatedBadge")}</StatusBadge>
                  ) : null}
                  {line.overdue ? (
                    <StatusBadge tone="warning">{t("overdueBadge")}</StatusBadge>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
        {forecast.linesTruncated ? (
          <p className="text-xs text-muted-foreground">{t("truncated")}</p>
        ) : null}
      </section>

      <section aria-labelledby="expected" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="expected" className="text-lg font-semibold">
            {t("itemsTitle")}
          </h2>
          {canAddItems && projects.length ? (
            <SpendingAction
              path="/cash-flow-items"
              entity="cashFlowItem"
              fields={[
                {
                  kind: "select",
                  name: "projectId",
                  label: t("itemProject"),
                  defaultValue: project,
                  options: projects.map((option) => ({
                    value: option.id,
                    label: `${option.code} · ${option.name}`,
                  })),
                },
                {
                  kind: "select",
                  name: "direction",
                  label: t("itemDirection"),
                  options: [
                    { value: "in", label: t("directionIn") },
                    { value: "out", label: t("directionOut") },
                  ],
                },
                { kind: "text", name: "description", label: t("itemDescription"), maxLength: 200 },
                { kind: "date", name: "expectedOn", label: t("itemDate"), defaultValue: today },
                { kind: "money", name: "amountMinor", label: t("itemAmount") },
                {
                  kind: "text",
                  name: "reference",
                  label: t("itemReference"),
                  optional: true,
                  maxLength: 60,
                },
              ]}
              text={{
                button: t("addItem"),
                title: t("addItemTitle"),
                description: t("addItemDescription"),
                confirm: t("addItem"),
              }}
            />
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">{t("itemsHint")}</p>
        {!items.ok || items.data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noItems")}</p>
        ) : (
          <ul className="space-y-2">
            {items.data.items.map((item) => (
              <li key={item.id} className="space-y-2 rounded-lg border p-3 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="min-w-0">
                    <span className="font-medium">{item.description}</span>
                    <span className="block text-xs text-muted-foreground">
                      {formatCalendarDate(item.expectedOn)} · {item.project.code}
                      {item.reference ? ` · ${item.reference}` : ""}
                    </span>
                  </span>
                  <span className="tabular-nums">
                    {item.direction === "in" ? "+" : "−"}
                    {formatKES(item.amountMinor)}
                  </span>
                </div>
                {item.permissions.canEdit ? (
                  <div className="flex flex-wrap gap-2">
                    {item.direction === "in" ? (
                      <SpendingAction
                        path={`/cash-flow-items/${item.id}/receive`}
                        entity="cashFlowItem"
                        body={{ version: item.version }}
                        fields={[
                          {
                            kind: "date",
                            name: "receivedOn",
                            label: t("receivedOn"),
                            defaultValue: today,
                          },
                          { kind: "money", name: "receivedMinor", label: t("receivedAmount") },
                          {
                            kind: "text",
                            name: "reference",
                            label: t("itemReference"),
                            optional: true,
                            maxLength: 60,
                          },
                        ]}
                        text={{
                          button: t("receive"),
                          title: t("receiveTitle"),
                          description: t("receiveDescription"),
                          confirm: t("receive"),
                        }}
                      />
                    ) : null}
                    <SpendingAction
                      path={`/cash-flow-items/${item.id}/cancel`}
                      entity="cashFlowItem"
                      body={{ version: item.version }}
                      destructive
                      text={{
                        button: t("cancelItem"),
                        title: t("cancelItemTitle"),
                        description: t("cancelItemDescription"),
                        confirm: t("cancelItem"),
                      }}
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <Pager
          label={t("itemsTitle")}
          firstHref={`/spending/forecast${apiQuery({ project })}`}
          nextHref={
            items.ok && items.data.page.nextCursor
              ? `/spending/forecast${apiQuery({ project, items: items.data.page.nextCursor })}`
              : null
          }
          paged={Boolean(itemsCursor)}
        />
      </section>
    </div>
  );
}
