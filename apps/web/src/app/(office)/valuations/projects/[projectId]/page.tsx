import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Ruler } from "lucide-react";
import {
  costToCompleteResponseSchema,
  earnedValueResponseSchema,
  measurementItemsResponseSchema,
  projectValuationsResponseSchema,
  type CostToCompleteRow,
} from "@pm-buddy/validation";
import { KpiCard } from "@/components/kpi-card";
import { PageHeader } from "@/components/page-header";
import { apiQuery, listHrefs, Pager } from "@/components/procurement/p2p/list-filters";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { ScrollTable } from "@/components/stores/stores-subnav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SCurve } from "@/components/valuations/s-curve";
import { ContractSettingsForm, CreateValuationForm } from "@/components/valuations/valuation-forms";
import { ProjectTabs, ValuationsEyebrow } from "@/components/valuations/valuations-nav";
import { formatCalendarDate, formatDateTime, formatDecimalString, formatKES } from "@/lib/format";
import { pickParam } from "@/lib/p2p";
import { loadOrRedirect } from "@/lib/p2p-server";
import { requireSession, serverApi } from "@/lib/server-api";
import { isUuid } from "@/lib/stores";
import {
  itemLabel,
  measurementStateTone,
  ratioLabel,
  VALUATION_TABS,
  valuationAccess,
  valuationStatusTone,
  type ValuationTab,
} from "@/lib/valuations";

export async function generateMetadata() {
  const t = await getTranslations("valuations.project");
  return { title: t("metaTitle") };
}

/**
 * A project's measurement and valuations (D6.3): the measurement sheet, certificates with the
 * contract settings, the retention ledger, and earned value with the S-curve and cost to
 * complete. Tabs follow the caller's permissions; the API decides every figure.
 */
export default async function ProjectValuationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  if (!isUuid(projectId)) notFound();
  const raw = await searchParams;
  const base = `/valuations/projects/${projectId}`;
  const session = await requireSession(base);
  if (!session) return <LiveUnavailable retryHref={base} />;
  const access = valuationAccess(session.company.permissions);
  const tabs = VALUATION_TABS.filter((tab) =>
    tab === "measurements"
      ? access.measurements
      : tab === "earned-value"
        ? access.earnedValue
        : access.certificates,
  );
  const requested = pickParam(raw, "tab") as ValuationTab | undefined;
  const tab: ValuationTab =
    requested && (VALUATION_TABS as readonly string[]).includes(requested)
      ? requested
      : (tabs.find((entry) => entry === "certificates") ?? "measurements");
  const t = await getTranslations("valuations.project");
  const path = `${base}?tab=${tab}`;

  let body: React.ReactNode;
  let project: { code: string; name: string } | null = null;
  if (tab === "measurements") {
    const search = pickParam(raw, "search")?.slice(0, 100);
    const bill = pickParam(raw, "bill");
    const cursorParam = pickParam(raw, "cursor");
    const cursor = cursorParam && /^\d{1,7}$/.test(cursorParam) ? cursorParam : undefined;
    const result = await loadOrRedirect(
      `/projects/${projectId}/measurements/items${apiQuery({
        search,
        billLineageId: bill && isUuid(bill) ? bill : undefined,
        cursor,
        limit: "50",
      })}`,
      measurementItemsResponseSchema,
      path,
    );
    if (!result.ok) return failed(result.status, path);
    project = result.data.project;
    body = await MeasurementSheet({
      projectId,
      data: result.data,
      search,
      bill: bill && isUuid(bill) ? bill : undefined,
      cursor,
    });
  } else if (tab === "earned-value") {
    const bill = pickParam(raw, "bill");
    const [evm, cost] = await Promise.all([
      loadOrRedirect(`/projects/${projectId}/earned-value`, earnedValueResponseSchema, path),
      serverApi(
        `/projects/${projectId}/cost-to-complete${apiQuery({
          billLineageId: bill && isUuid(bill) ? bill : undefined,
          limit: "100",
        })}`,
        costToCompleteResponseSchema,
      ),
    ]);
    if (!evm.ok) return failed(evm.status, path);
    project = evm.data.project;
    body = await EarnedValue({
      projectId,
      evm: evm.data,
      cost: cost.ok ? cost.data : null,
    });
  } else {
    const result = await loadOrRedirect(
      `/projects/${projectId}/valuations`,
      projectValuationsResponseSchema,
      path,
    );
    if (!result.ok) return failed(result.status, path);
    project = result.data.project;
    body =
      tab === "retention"
        ? await Retention({ data: result.data })
        : await Certificates({ projectId, data: result.data });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<ValuationsEyebrow trail={{ href: "/valuations", label: t("back") }} />}
        title={project ? `${project.code} · ${project.name}` : t("metaTitle")}
        description={t("description")}
        actions={
          access.measurements ? (
            <Button asChild size="sm" variant="outline">
              <Link href={`${base}/measure`}>
                <Ruler aria-hidden /> {t("measure")}
              </Link>
            </Button>
          ) : null
        }
      />
      <ProjectTabs projectId={projectId} current={tab} tabs={tabs} />
      {body}
    </div>
  );
}

function failed(status: number, path: string) {
  if (status === 404 || status === 400) notFound();
  return status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
}

type Sheet = import("@pm-buddy/validation").MeasurementItemsResponse;

async function MeasurementSheet({
  projectId,
  data,
  search,
  bill,
  cursor,
}: {
  projectId: string;
  data: Sheet;
  search?: string;
  bill?: string;
  cursor?: string;
}) {
  const t = await getTranslations("valuations.measurements");
  const tState = await getTranslations("valuations.states");
  const tBasis = await getTranslations("valuations.basis");
  const base = `/valuations/projects/${projectId}`;
  const hrefs = listHrefs(base, { tab: "measurements", search, bill }, data.page.nextCursor);
  if (!data.bqVersion)
    return <p className="rounded-xl border border-dashed p-6 text-center text-sm">{t("noBq")}</p>;
  return (
    <section aria-labelledby="sheet-title" className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <KpiCard label={t("measurable")} value={formatKES(data.totals.measurableMinor)} />
        <KpiCard
          label={t("approvedValue")}
          value={formatKES(data.totals.approvedValueMinor)}
          hint={
            data.totals.percentComplete === null
              ? t("unavailable")
              : t("percentOfBq", { percent: data.totals.percentComplete })
          }
        />
        <KpiCard
          label={t("pending")}
          value={String(data.totals.pendingCount)}
          hint={
            data.permissions.canApprove && data.totals.pendingCount ? (
              <Link href="/valuations/approvals" className="underline underline-offset-4">
                {t("review")}
              </Link>
            ) : undefined
          }
        />
      </div>
      <h2 id="sheet-title" className="text-lg font-semibold">
        {t("title", { version: data.bqVersion.versionNo })}
      </h2>
      <form method="get" action={base} role="search" className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="tab" value="measurements" />
        <div className="min-w-0 flex-1 space-y-1.5 sm:max-w-xs">
          <label htmlFor="sheet-search" className="block text-sm font-medium">
            {t("search")}
          </label>
          <Input id="sheet-search" name="search" defaultValue={search ?? ""} maxLength={100} />
        </div>
        <div className="min-w-0 space-y-1.5">
          <label htmlFor="sheet-bill" className="block text-sm font-medium">
            {t("bill")}
          </label>
          <select
            id="sheet-bill"
            name="bill"
            defaultValue={bill ?? ""}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">{t("allBills")}</option>
            {data.bills.map((entry) => (
              <option key={entry.lineageId} value={entry.lineageId}>
                {entry.number} · {entry.title}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" variant="secondary">
          {t("apply")}
        </Button>
      </form>
      {data.items.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm">{t("empty")}</p>
      ) : (
        <ScrollTable label={t("tableLabel")} minWidth={860}>
          <thead>
            <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
              <th scope="col" className="py-2 pl-4 font-medium">
                {t("cols.item")}
              </th>
              <th scope="col" className="py-2 pr-2 font-medium">
                {t("cols.basis")}
              </th>
              <th scope="col" className="py-2 pr-2 text-right font-medium">
                {t("cols.bq")}
              </th>
              <th scope="col" className="py-2 pr-2 text-right font-medium">
                {t("cols.approved")}
              </th>
              <th scope="col" className="py-2 pr-2 text-right font-medium">
                {t("cols.percent")}
              </th>
              <th scope="col" className="py-2 pr-2 text-right font-medium">
                {t("cols.value")}
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                {t("cols.latest")}
              </th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((row) => (
              <tr key={row.item.lineageId} className="border-b align-top last:border-0">
                <th scope="row" className="py-2 pl-4 text-left font-normal">
                  <span className="font-medium">{itemLabel(row.item)}</span>
                  <span className="block max-w-xs text-xs text-muted-foreground">
                    {row.item.description}
                  </span>
                </th>
                <td className="py-2 pr-2">
                  {row.basis ? (
                    tBasis(row.basis)
                  ) : (
                    <span className="text-muted-foreground">{t("notMeasured")}</span>
                  )}
                </td>
                <td className="py-2 pr-2 text-right tabular-nums">
                  {row.quantity
                    ? `${formatDecimalString(row.quantity)} ${row.item.unit ?? ""}`
                    : formatKES(row.amountMinor)}
                </td>
                <td className="py-2 pr-2 text-right tabular-nums">
                  {row.approved
                    ? `${formatDecimalString(row.approved.quantityToDate)}${row.basis === "percent" ? "%" : ""}`
                    : "—"}
                </td>
                <td className="py-2 pr-2 text-right tabular-nums">
                  {row.approved?.percentComplete ? `${row.approved.percentComplete}%` : "—"}
                </td>
                <td className="py-2 pr-2 text-right tabular-nums">
                  {row.approved ? formatKES(row.approved.valueMinor) : "—"}
                </td>
                <td className="py-2 pr-4">
                  <span className="flex flex-wrap items-center gap-2">
                    {row.latest ? (
                      <Link
                        href={`${base}/measurements/${row.latest.measurementId}`}
                        className="underline underline-offset-4"
                      >
                        <StatusBadge tone={measurementStateTone[row.latest.state]}>
                          {tState(row.latest.state)}
                        </StatusBadge>
                      </Link>
                    ) : null}
                    {row.pendingCount > 1 ? (
                      <span className="text-xs text-muted-foreground">
                        {t("pendingCount", { count: row.pendingCount })}
                      </span>
                    ) : null}
                    {row.basis && data.permissions.canRecord ? (
                      <Link
                        href={`${base}/measure?item=${row.item.lineageId}`}
                        className="text-sm underline underline-offset-4"
                      >
                        {t("measure")}
                      </Link>
                    ) : null}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </ScrollTable>
      )}
      <Pager
        label={t("tableLabel")}
        firstHref={hrefs.first}
        nextHref={hrefs.next}
        paged={Boolean(cursor)}
      />
    </section>
  );
}

type ProjectData = import("@pm-buddy/validation").ProjectValuationsResponse;

async function Certificates({ projectId, data }: { projectId: string; data: ProjectData }) {
  const t = await getTranslations("valuations.certificates");
  const tStatus = await getTranslations("valuations.status");
  const tKinds = await getTranslations("valuations.kinds");
  const lastDate = data.valuations.find((row) => row.status === "certified")?.valuationDate ?? null;
  const previousFromStores =
    data.valuations.find((row) => row.status === "certified" && row.kind === "interim")
      ?.materialsFromStores ?? false;
  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label={t("originalSum")}
          value={data.contractSum ? formatKES(data.contractSum.originalMinor) : "—"}
        />
        <KpiCard
          label={t("revisedSum")}
          value={data.contractSum ? formatKES(data.contractSum.revisedMinor) : "—"}
          hint={
            data.contractSum
              ? t("revisedHint", { version: data.contractSum.revisedVersionNo })
              : t("noBq")
          }
        />
        <KpiCard
          label={t("certifiedNet")}
          value={formatKES(data.certified.amountDueMinor)}
          hint={t("certifiedHint", {
            count: data.certified.count,
            total: formatKES(data.certified.totalMinor),
          })}
        />
        <KpiCard label={t("retentionHeld")} value={formatKES(data.retention.heldMinor)} />
      </div>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{t("listTitle")}</h2>
        {data.valuations.length === 0 ? (
          <p className="rounded-xl border border-dashed p-6 text-center text-sm">{t("empty")}</p>
        ) : (
          <ScrollTable label={t("listTitle")} minWidth={760}>
            <thead>
              <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2 pl-4 font-medium">
                  {t("cols.number")}
                </th>
                <th scope="col" className="py-2 pr-2 font-medium">
                  {t("cols.kind")}
                </th>
                <th scope="col" className="py-2 pr-2 font-medium">
                  {t("cols.date")}
                </th>
                <th scope="col" className="py-2 pr-2 font-medium">
                  {t("cols.status")}
                </th>
                <th scope="col" className="py-2 pr-2 text-right font-medium">
                  {t("cols.due")}
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">
                  {t("cols.total")}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.valuations.map((row) => (
                <tr key={row.id} className="border-b align-top last:border-0">
                  <th scope="row" className="py-2 pl-4 text-left font-normal">
                    <Link
                      href={`/valuations/${row.id}`}
                      className="font-medium underline underline-offset-4"
                    >
                      {row.certificateNumber ?? row.number}
                    </Link>
                    {row.certificateNumber ? (
                      <span className="block text-xs text-muted-foreground">{row.number}</span>
                    ) : null}
                  </th>
                  <td className="py-2 pr-2">
                    {row.kind === "interim"
                      ? tKinds("interim")
                      : tKinds(`release.${row.releaseStage!}`)}
                  </td>
                  <td className="py-2 pr-2">{formatCalendarDate(row.valuationDate)}</td>
                  <td className="py-2 pr-2">
                    <StatusBadge tone={valuationStatusTone[row.status]}>
                      {tStatus(row.status)}
                    </StatusBadge>
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {row.amountDueMinor === null ? "—" : formatKES(row.amountDueMinor)}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {row.totalMinor === null ? "—" : formatKES(row.totalMinor)}
                  </td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
        )}
      </section>
      {data.permissions.canCreate ? (
        <CreateValuationForm
          projectId={projectId}
          release={data.permissions.canRelease}
          minDate={lastDate}
          previousFromStores={previousFromStores}
        />
      ) : null}
      {data.permissions.canEditSettings ? (
        <ContractSettingsForm projectId={projectId} settings={data.settings} />
      ) : (
        <SettingsSummary data={data} />
      )}
    </div>
  );
}

async function SettingsSummary({ data }: { data: ProjectData }) {
  const t = await getTranslations("valuations.settings");
  const { settings } = data;
  return (
    <section aria-labelledby="settings-summary" className="space-y-2 rounded-xl border p-4 text-sm">
      <h2 id="settings-summary" className="font-semibold">
        {t("title")}
      </h2>
      <p>
        {t("summary", {
          retention: settings.retentionPercent,
          cap: settings.retentionCapPercent ?? "—",
          vat: settings.vatPercent,
          materials: settings.materialsPercent,
          release: settings.practicalReleasePercent,
        })}
      </p>
      <p className="text-xs text-muted-foreground">
        {settings.version === 0
          ? t("defaults")
          : t("version", {
              version: settings.version,
              when: settings.updatedAt ? formatDateTime(settings.updatedAt) : "—",
            })}
      </p>
    </section>
  );
}

async function Retention({ data }: { data: ProjectData }) {
  const t = await getTranslations("valuations.retention");
  const tKinds = await getTranslations("valuations.kinds");
  const completion = (key: "practical" | "final") => {
    const value = data.completions[key];
    return value ? formatCalendarDate(value.completionDate) : t("notCertified");
  };
  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <KpiCard
          label={t("held")}
          value={formatKES(data.retention.heldMinor)}
          hint={t(`stage.${data.retention.stage}`)}
        />
        <KpiCard label={t("released")} value={formatKES(data.retention.releasedMinor)} />
        <KpiCard
          label={t("completions")}
          value={completion("practical")}
          hint={t("finalLine", {
            final: completion("final"),
            dlp: data.completions.practical?.dlpEndsOn
              ? formatCalendarDate(data.completions.practical.dlpEndsOn)
              : "—",
          })}
        />
      </div>
      <p className="text-sm text-muted-foreground">
        {t("rule", { percent: data.settings.practicalReleasePercent })}
      </p>
      {data.retention.ledger.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm">{t("empty")}</p>
      ) : (
        <ScrollTable label={t("ledger")} minWidth={640}>
          <thead>
            <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
              <th scope="col" className="py-2 pl-4 font-medium">
                {t("cols.certificate")}
              </th>
              <th scope="col" className="py-2 pr-2 font-medium">
                {t("cols.date")}
              </th>
              <th scope="col" className="py-2 pr-2 text-right font-medium">
                {t("cols.movement")}
              </th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">
                {t("cols.held")}
              </th>
            </tr>
          </thead>
          <tbody>
            {data.retention.ledger.map((entry) => (
              <tr key={entry.valuationId} className="border-b last:border-0">
                <th scope="row" className="py-2 pl-4 text-left font-normal">
                  <Link
                    href={`/valuations/${entry.valuationId}`}
                    className="font-medium underline underline-offset-4"
                  >
                    {entry.certificateNumber}
                  </Link>
                  <span className="block text-xs text-muted-foreground">
                    {entry.kind === "interim"
                      ? tKinds("interim")
                      : tKinds(`release.${entry.releaseStage!}`)}
                  </span>
                </th>
                <td className="py-2 pr-2">{formatCalendarDate(entry.valuationDate)}</td>
                <td className="py-2 pr-2 text-right tabular-nums">
                  {entry.movementMinor > 0 ? "+" : ""}
                  {formatKES(entry.movementMinor)}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">{formatKES(entry.heldMinor)}</td>
              </tr>
            ))}
          </tbody>
        </ScrollTable>
      )}
    </div>
  );
}

type Evm = import("@pm-buddy/validation").EarnedValueResponse;
type Cost = import("@pm-buddy/validation").CostToCompleteResponse;

async function EarnedValue({
  projectId,
  evm,
  cost,
}: {
  projectId: string;
  evm: Evm;
  cost: Cost | null;
}) {
  const t = await getTranslations("valuations.evm");
  const tCtc = await getTranslations("valuations.ctc");
  const { figures } = evm;
  const money = (value: number | null) => (value === null ? t("unavailable") : formatKES(value));
  const base = `/valuations/projects/${projectId}?tab=earned-value`;
  const ctcRow = (row: CostToCompleteRow) => (
    <>
      <td className="py-2 pr-2 text-right tabular-nums">{formatKES(row.contractMinor)}</td>
      <td className="py-2 pr-2 text-right tabular-nums">{formatKES(row.evMinor)}</td>
      <td className="py-2 pr-2 text-right tabular-nums">
        {row.budgetMinor === null ? tCtc("noBudget") : formatKES(row.budgetMinor)}
      </td>
      <td className="py-2 pr-2 text-right tabular-nums">{formatKES(row.actualMinor)}</td>
      <td className="py-2 pr-2 text-right tabular-nums">{ratioLabel(row.cpi)}</td>
      <td className="py-2 pr-2 text-right tabular-nums">{money(row.etcMinor)}</td>
      <td className="py-2 pr-2 text-right tabular-nums">{money(row.eacMinor)}</td>
      <td className="py-2 pr-4 text-right tabular-nums">{money(row.vacMinor)}</td>
    </>
  );
  const ctcHead = (first: string) => (
    <thead>
      <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
        <th scope="col" className="py-2 pl-4 font-medium">
          {first}
        </th>
        {(["contract", "earned", "budget", "actual", "cpi", "etc", "eac", "vac"] as const).map(
          (key) => (
            <th key={key} scope="col" className="py-2 pr-2 text-right font-medium last:pr-4">
              {tCtc(`cols.${key}`)}
            </th>
          ),
        )}
      </tr>
    </thead>
  );
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        {t("dataDate", { date: formatCalendarDate(evm.dataDate) })}{" "}
        {evm.baseline
          ? t("baseline", { number: evm.baseline.baselineNo, name: evm.baseline.name })
          : t("noBaseline")}
      </p>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label={t("bac")} value={formatKES(figures.bacMinor)} />
        <KpiCard
          label={t("pv")}
          value={money(figures.pvMinor)}
          hint={
            figures.percentPlanned === null
              ? undefined
              : t("ofBac", { percent: figures.percentPlanned })
          }
        />
        <KpiCard
          label={t("ev")}
          value={formatKES(figures.evMinor)}
          hint={
            figures.percentComplete === null
              ? undefined
              : t("ofBac", { percent: figures.percentComplete })
          }
        />
        <KpiCard label={t("ac")} value={formatKES(figures.acMinor)} />
        <KpiCard
          label={t("cpi")}
          value={ratioLabel(figures.cpi)}
          hint={t("cv", { amount: formatKES(figures.cvMinor) })}
        />
        <KpiCard
          label={t("spi")}
          value={ratioLabel(figures.spi)}
          hint={
            figures.svMinor === null
              ? t("unavailable")
              : t("sv", { amount: formatKES(figures.svMinor) })
          }
        />
        <KpiCard
          label={t("eac")}
          value={money(figures.eacMinor)}
          hint={t("etc", { amount: money(figures.etcMinor) })}
        />
        <KpiCard label={t("vac")} value={money(figures.vacMinor)} hint={t("vacHint")} />
      </div>
      <section aria-labelledby="values-apart" className="space-y-2 rounded-xl border p-4 text-sm">
        <h2 id="values-apart" className="font-semibold">
          {t("valuesTitle")}
        </h2>
        <dl className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <div>
            <dt className="text-muted-foreground">{t("values.physical")}</dt>
            <dd>
              {evm.values.physicalPercent === null
                ? t("unavailable")
                : `${evm.values.physicalPercent}%`}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("values.earned")}</dt>
            <dd className="tabular-nums">{formatKES(evm.values.earnedMinor)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("values.certified")}</dt>
            <dd className="tabular-nums">{formatKES(evm.values.certifiedNetMinor)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("values.invoiced")}</dt>
            <dd>{money(evm.values.invoicedMinor)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("values.received")}</dt>
            <dd>{money(evm.values.receivedMinor)}</dd>
          </div>
        </dl>
        <p className="text-xs text-muted-foreground">
          {t("notes", {
            stock: formatKES(evm.notes.stockOnHandMinor),
            linked: evm.notes.itemsLinkedToBaseline,
            spread: evm.notes.itemsSpreadOverBaseline,
          })}
        </p>
      </section>
      <section aria-labelledby="s-curve" className="space-y-3">
        <h2 id="s-curve" className="text-lg font-semibold">
          {t("curveTitle")}
        </h2>
        {evm.curve.length === 0 ? (
          <p className="rounded-xl border border-dashed p-6 text-center text-sm">{t("noCurve")}</p>
        ) : (
          <>
            <SCurve points={evm.curve} label={t("curveLabel")} />
            {evm.curveTruncated ? (
              <p className="text-xs text-muted-foreground">{t("truncated")}</p>
            ) : null}
            <ScrollTable label={t("curveTable")} minWidth={560}>
              <thead>
                <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-2 pl-4 font-medium">
                    {t("cols.week")}
                  </th>
                  <th scope="col" className="py-2 pr-2 text-right font-medium">
                    {t("cols.pv")}
                  </th>
                  <th scope="col" className="py-2 pr-2 text-right font-medium">
                    {t("cols.ev")}
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">
                    {t("cols.ac")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {evm.curve.map((point) => (
                  <tr key={point.weekEnd} className="border-b last:border-0">
                    <th scope="row" className="py-1.5 pl-4 text-left font-normal">
                      {formatCalendarDate(point.weekEnd)}
                    </th>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{money(point.pvMinor)}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">
                      {point.evMinor === null ? "—" : formatKES(point.evMinor)}
                    </td>
                    <td className="py-1.5 pr-4 text-right tabular-nums">
                      {point.acMinor === null ? "—" : formatKES(point.acMinor)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </ScrollTable>
          </>
        )}
        <p className="text-xs text-muted-foreground">{t("formulas")}</p>
      </section>
      {cost ? (
        <section aria-labelledby="cost-to-complete" className="space-y-3">
          <h2 id="cost-to-complete" className="text-lg font-semibold">
            {tCtc("title")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {cost.budget
              ? tCtc("budget", { version: cost.budget.versionNo, name: cost.budget.name })
              : tCtc("noApprovedBudget")}{" "}
            {tCtc("rule")}
          </p>
          <ScrollTable label={tCtc("billsLabel")} minWidth={900}>
            {ctcHead(tCtc("cols.bill"))}
            <tbody>
              {cost.bills.map((row) => (
                <tr key={row.bill.lineageId} className="border-b align-top last:border-0">
                  <th scope="row" className="py-2 pl-4 text-left font-normal">
                    <Link
                      href={`${base}&bill=${row.bill.lineageId}#cost-items`}
                      className="font-medium underline underline-offset-4"
                    >
                      {row.bill.number} · {row.bill.title}
                    </Link>
                  </th>
                  {ctcRow(row)}
                </tr>
              ))}
              <tr className="border-t bg-muted/30 font-medium">
                <th scope="row" className="py-2 pl-4 text-left">
                  {tCtc("total")}
                </th>
                {ctcRow(cost.totals)}
              </tr>
            </tbody>
          </ScrollTable>
          <p className="text-xs text-muted-foreground">
            {tCtc("notOnItems", { amount: formatKES(cost.notOnBqItems.actualMinor) })}
          </p>
          {cost.bill ? (
            <div id="cost-items" className="space-y-2">
              <h3 className="font-semibold">
                {tCtc("itemsTitle", { bill: `${cost.bill.number} · ${cost.bill.title}` })}
              </h3>
              <ScrollTable label={tCtc("itemsLabel")} minWidth={960}>
                {ctcHead(tCtc("cols.item"))}
                <tbody>
                  {cost.items.map((row) => (
                    <tr key={row.item.lineageId} className="border-b align-top last:border-0">
                      <th scope="row" className="py-2 pl-4 text-left font-normal">
                        <span className="font-medium">{itemLabel(row.item)}</span>
                        <span className="block max-w-xs text-xs text-muted-foreground">
                          {row.item.description}
                          {row.percentComplete ? ` · ${row.percentComplete}%` : ""}
                        </span>
                      </th>
                      {ctcRow(row)}
                    </tr>
                  ))}
                </tbody>
              </ScrollTable>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
