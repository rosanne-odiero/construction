import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { VARIANCE_STATES, type StandardUnitCode, type VarianceState } from "@pm-buddy/types";
import { varianceResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { apiQuery } from "@/components/procurement/p2p/list-filters";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { MeasurementDialog } from "@/components/stores/stores-forms";
import { ScrollTable, StoresEyebrow, StoresSubnav } from "@/components/stores/stores-subnav";
import { Button } from "@/components/ui/button";
import { formatCalendarDate } from "@/lib/format";
import { pickParam } from "@/lib/p2p";
import { loadOrRedirect, projectOptions, unitOptions } from "@/lib/p2p-server";
import { unitLabel } from "@/lib/procurement";
import { requireSession } from "@/lib/server-api";
import { formatStock, isUuid, varianceTone } from "@/lib/stores";

export async function generateMetadata() {
  const t = await getTranslations("stores.variance");
  return { title: t("title") };
}

const selectClass =
  "h-9 max-w-[16rem] rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

/**
 * Theoretical versus actual consumption per BQ item and material (D5.3): every alert shows its
 * inputs (measured quantity, build-up quantity per unit, waste, theoretical, issued, returned,
 * actual, variance). Estimates for review, never proof of theft.
 */
export default async function VariancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const projectId = isUuid(pickParam(raw, "project")) ? pickParam(raw, "project") : undefined;
  const stateParam = pickParam(raw, "state");
  const state = VARIANCE_STATES.includes(stateParam as VarianceState) ? stateParam : undefined;
  const path = `/stores/variance${apiQuery({ project: projectId, state })}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [result, projects, units] = await Promise.all([
    loadOrRedirect(
      `/stores/variance${apiQuery({ projectId, state })}`,
      varianceResponseSchema,
      path,
    ),
    projectOptions(),
    unitOptions(),
  ]);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("stores.variance");
  const tCommon = await getTranslations("stores.common");
  const tStatus = await getTranslations("stores.status");
  const tUnits = await getTranslations("catalogue.units");
  const label = (code: string) => unitLabel(code, (unit: StandardUnitCode) => tUnits(unit), units);
  const { rows, counts, thresholdPercent, generatedOn } = result.data;
  const q = (value: string | null, unit?: string) =>
    value === null ? t("unavailable") : `${formatStock(value)}${unit ? ` ${unit}` : ""}`;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<StoresEyebrow />}
        title={t("title")}
        description={t("description", { percent: thresholdPercent })}
      />
      <StoresSubnav current="variance" />
      <p className="rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm" role="note">
        {t("estimateNote")}
      </p>
      <p className="flex flex-wrap gap-2 text-sm" role="status">
        <StatusBadge tone="danger">{t("countAlert", { count: counts.alert })}</StatusBadge>
        <StatusBadge tone="success">{t("countWithin", { count: counts.within })}</StatusBadge>
        <StatusBadge tone="neutral">
          {t("countUnavailable", { count: counts.unavailable })}
        </StatusBadge>
        <span className="text-muted-foreground">
          {t("asOf", { date: formatCalendarDate(generatedOn) })}
        </span>
      </p>
      <form
        method="get"
        action="/stores/variance"
        className="flex flex-wrap items-end gap-3"
        role="search"
      >
        <div className="space-y-1.5">
          <label htmlFor="variance-project" className="block text-sm font-medium">
            {tCommon("project")}
          </label>
          <select
            id="variance-project"
            name="project"
            defaultValue={projectId ?? ""}
            className={selectClass}
          >
            <option value="">{tCommon("allProjects")}</option>
            {projects.map((option) => (
              <option key={option.id} value={option.id}>
                {option.code} · {option.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="variance-state" className="block text-sm font-medium">
            {t("state")}
          </label>
          <select
            id="variance-state"
            name="state"
            defaultValue={state ?? ""}
            className={selectClass}
          >
            <option value="">{t("allStates")}</option>
            {VARIANCE_STATES.map((entry) => (
              <option key={entry} value={entry}>
                {tStatus(`variance.${entry}`)}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" variant="secondary">
          {tCommon("apply")}
        </Button>
        {projectId || state ? (
          <Button asChild variant="ghost">
            <Link href="/stores/variance">{tCommon("clear")}</Link>
          </Button>
        ) : null}
      </form>
      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed p-8 text-center font-medium">{t("empty")}</p>
      ) : (
        <ScrollTable label={t("title")} minWidth={1100}>
          <thead>
            <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
              <th scope="col" className="py-2 pl-4 font-medium">
                {t("cols.item")}
              </th>
              <th scope="col" className="py-2 pr-2 font-medium">
                {tCommon("material")}
              </th>
              <th scope="col" className="py-2 pr-2 text-right font-medium">
                {t("cols.measured")}
              </th>
              <th scope="col" className="py-2 pr-2 text-right font-medium">
                {t("cols.perUnit")}
              </th>
              <th scope="col" className="py-2 pr-2 text-right font-medium">
                {t("cols.waste")}
              </th>
              <th scope="col" className="py-2 pr-2 text-right font-medium">
                {t("cols.theoretical")}
              </th>
              <th scope="col" className="py-2 pr-2 text-right font-medium">
                {t("cols.issued")}
              </th>
              <th scope="col" className="py-2 pr-2 text-right font-medium">
                {t("cols.returned")}
              </th>
              <th scope="col" className="py-2 pr-2 text-right font-medium">
                {t("cols.actual")}
              </th>
              <th scope="col" className="py-2 pr-2 text-right font-medium">
                {t("cols.variance")}
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                {t("state")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const base = row.material ? label(row.material.baseUnit) : "";
              return (
                <tr
                  key={`${row.bqItem.lineageId}-${row.material?.id ?? row.buildup?.lineNo ?? index}`}
                  className="border-b align-top last:border-0"
                  data-state={row.state}
                >
                  <th scope="row" className="max-w-[16rem] py-2 pl-4 text-left font-medium">
                    {row.bqItem.ref ? `${row.bqItem.ref} · ` : ""}
                    {row.bqItem.description}
                    <span className="block text-xs font-normal text-muted-foreground">
                      {row.project.code}
                    </span>
                    {row.canMeasure ? (
                      <span className="mt-1 block">
                        <MeasurementDialog projectId={row.project.id} item={row.bqItem} />
                      </span>
                    ) : null}
                  </th>
                  <td className="py-2 pr-2">
                    {row.material?.name ?? row.buildup?.resourceName ?? "—"}
                    {row.buildup ? (
                      <span className="block text-xs text-muted-foreground">
                        {t("buildupLine", {
                          code: row.buildup.code,
                          version: row.buildup.versionNo,
                          line: row.buildup.lineNo,
                        })}
                      </span>
                    ) : null}
                    {row.mapping && row.material ? (
                      <span className="block text-xs text-muted-foreground">
                        {t("mapping", {
                          unit: label(row.mapping.unit),
                          quantity: formatStock(row.mapping.basePerUnitDecimal),
                          base,
                        })}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {row.measurement ? (
                      <>
                        {formatStock(row.measurement.quantityToDate)} {row.bqItem.unit ?? ""}
                        <span className="block text-xs text-muted-foreground">
                          {formatCalendarDate(row.measurement.measuredOn)}
                        </span>
                      </>
                    ) : (
                      t("notMeasured")
                    )}
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {row.buildup
                      ? `${formatStock(row.buildup.quantityPerUnit)} ${row.buildup.unit}`
                      : "—"}
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {row.buildup?.wastePercent ? `${formatStock(row.buildup.wastePercent)} %` : "—"}
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {q(row.theoreticalQuantity, base)}
                    {row.limitQuantity ? (
                      <span className="block text-xs text-muted-foreground">
                        {t("limit", { quantity: formatStock(row.limitQuantity) })}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {formatStock(row.issuedQuantity)}
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {formatStock(row.returnedQuantity)}
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {formatStock(row.actualQuantity)} {base}
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {row.varianceQuantity === null
                      ? t("unavailable")
                      : formatStock(row.varianceQuantity)}
                    {row.variancePercent !== null ? (
                      <span className="block text-xs text-muted-foreground">
                        {formatStock(row.variancePercent)} %
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-4">
                    <StatusBadge
                      tone={varianceTone[row.state]}
                      className="h-auto whitespace-normal"
                    >
                      {tStatus(`variance.${row.state}`)}
                    </StatusBadge>
                    {row.state === "not_mapped" && row.buildup ? (
                      <Link
                        href={`/rate-buildups/${row.buildup.id}`}
                        className="mt-1 block text-xs underline underline-offset-4"
                      >
                        {t("mapIt")}
                      </Link>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </ScrollTable>
      )}
    </div>
  );
}
