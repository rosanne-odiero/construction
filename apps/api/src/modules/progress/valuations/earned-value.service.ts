import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Request } from "express";
import {
  costToComplete,
  earnedValueFigures,
  measuredValueMinor,
  measurementBasis,
  nairobiDate,
  PlannedValue,
  runningTotal,
  sCurve,
  scheduleProgress,
  stockValueToMinor,
  weekEnds,
  workingCalendar,
  type DatedValue,
  type PlannedWindow,
} from "@pm-buddy/domain";
import { EARNED_VALUE_READ_PERMISSIONS, VALUATION_LIMITS } from "@pm-buddy/types";
import {
  costToCompleteResponseSchema,
  earnedValueResponseSchema,
  type CostToCompleteRow,
} from "@pm-buddy/validation";
import type { Scope } from "../../identity/access-policy.js";
import type { Principal } from "../../identity/auth.service.js";
import { TenantScope } from "../../identity/tenant-scope.service.js";
import { clientReceiptsMinor } from "../../finance/client-ledger.js";
import { minorOf, projectRef, SpendingAccess, type Tx } from "../../finance/spending-common.js";
import { itemFigures, loadProjectFacts } from "../../finance/spending-report.service.js";
import { toCalendarDate } from "../../projects/project-mappers.js";
import { compute, loadSchedule, taskKey } from "../../schedule/schedule-model.js";
import { valuedInForce } from "../measurements/measurements.service.js";
import { certifiedOf } from "./valuation-calculator.js";
import {
  approvedMeasurements,
  bqInForce,
  bqItemWire,
  itemWithBill,
  measurable,
  type ItemRow,
} from "./valuation-common.js";

/**
 * Earned value with the weekly S-curve, and cost to complete per bill and BQ item (D6.3 part A,
 * brief §5.2 and §15 G; formulas in packages/domain valuations/evm.ts and ARCHITECTURE §4.10).
 * Readers hold finance.view or finance.manage on the project (the figures include the cost
 * ledger). Physical progress, earned value, certified value, invoiced value and cash received
 * are reported separately; undefined ratios are null.
 */
@Injectable()
export class EarnedValueService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: SpendingAccess,
  ) {}

  private async reader(scope: Scope, projectId: string) {
    const project = await this.access.on(scope, projectId);
    if (!this.access.holds(project, EARNED_VALUE_READ_PERMISSIONS))
      throw new ForbiddenException("No finance permission on this project");
    return project;
  }

  earnedValue(principal: Principal, projectId: string, asOf: string | undefined, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const project = await this.reader(scope, projectId);
      const today = nairobiDate();
      if (asOf && asOf > today)
        throw new BadRequestException({
          code: "as-of-future",
          message: "Earned value is reported up to today",
        });
      const dataDate = asOf ?? today;
      const { version, bacMinor, evChanges, ev, baseline, pv, linked, spread, baselineFinish } =
        await plannedAndEarned(tx, access.tenantId, projectId);
      const costRows = await tx.costEntry.groupBy({
        by: ["occurredOn"],
        where: { tenantId: access.tenantId, projectId, measure: "accrued" },
        _sum: { amountMinor: true },
      });
      const ac = runningTotal(
        costRows.map((row) => ({
          date: toCalendarDate(row.occurredOn),
          valueMinor: minorOf(row._sum.amountMinor ?? 0n),
        })),
      );

      const stock = await tx.$queryRaw<{ value: string | null }[]>`
        SELECT sum(b.balance_value_minor)::text AS value FROM (
          SELECT DISTINCT ON (e.store_id, e.material_id) e.balance_value_minor
            FROM stock_ledger_entries e
           WHERE e.tenant_id = ${access.tenantId}::uuid AND e.project_id = ${projectId}::uuid
             AND e.business_date <= ${dataDate}::date
           ORDER BY e.store_id, e.material_id, e.seq DESC) b`;
      const firstDates = [
        ...evChanges.map((change) => change.date),
        ...costRows.map((row) => toCalendarDate(row.occurredOn)),
        ...(pv ? [pv.span.start] : []),
      ].sort();
      const from = firstDates[0] ?? dataDate;
      const to = baselineFinish && baselineFinish > dataDate ? baselineFinish : dataDate;
      const all = weekEnds(from < dataDate ? from : dataDate, to, Number.MAX_SAFE_INTEGER);
      const weeks = all.slice(-VALUATION_LIMITS.sCurveMaxWeeks);
      const curve = sCurve({
        weekEnds: weeks,
        dataDate,
        pv: pv ? (date) => pv.at(date) : null,
        ev,
        ac,
      });
      const certified = (await certifiedOf(tx, access.tenantId, projectId)).filter(
        (row) => toCalendarDate(row.valuationDate) <= dataDate,
      );
      const received = await tx.cashFlowItem.aggregate({
        where: {
          tenantId: access.tenantId,
          projectId,
          direction: "in",
          status: "received",
          // A line linked to a certificate became a client receipt (counted below).
          valuationId: null,
          receivedOn: { lte: new Date(`${dataDate}T00:00:00.000Z`) },
        },
        _sum: { receivedMinor: true },
      });
      const clientReceipts = await clientReceiptsMinor(tx, access.tenantId, [projectId], {
        to: dataDate,
      });
      return earnedValueResponseSchema.parse({
        project: projectRef(project.project),
        dataDate,
        bqVersion: version ? { id: version.id, versionNo: version.versionNo } : null,
        baseline: baseline
          ? {
              id: baseline.id,
              baselineNo: baseline.baselineNo,
              name: baseline.name,
              startDate: toCalendarDate(baseline.startDate),
              finishDate: baselineFinish,
            }
          : null,
        figures: earnedValueFigures({
          bacMinor,
          pvMinor: pv ? pv.at(dataDate) : null,
          evMinor: ev(dataDate),
          acMinor: ac(dataDate),
        }),
        curve,
        curveTruncated: all.length > weeks.length,
        values: {
          physicalPercent: await physicalPercent(tx, access.tenantId, project.project),
          earnedMinor: ev(dataDate),
          certifiedWorkMinor: certified.length ? minorOf(certified.at(-1)!.workDoneMinor!) : null,
          certifiedNetMinor: certified.reduce((sum, row) => sum + minorOf(row.amountDueMinor!), 0),
          invoicedMinor: null,
          // Manual cash-flow receipts plus client receipts recorded against certificates (D7.1,
          // net of reversals); null while neither exists.
          receivedMinor:
            received._sum.receivedMinor === null && clientReceipts === null
              ? null
              : minorOf(received._sum.receivedMinor ?? 0n) + (clientReceipts ?? 0),
        },
        notes: {
          stockOnHandMinor: stock[0]?.value ? stockValueToMinor(stock[0].value) : 0,
          itemsLinkedToBaseline: linked,
          itemsSpreadOverBaseline: spread,
        },
      });
    });
  }

  costToComplete(
    principal: Principal,
    projectId: string,
    query: { billLineageId?: string; search?: string; cursor?: string; limit: number },
    req: Request,
  ) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const project = await this.reader(scope, projectId);
      const version = await bqInForce(tx, access.tenantId, projectId);
      const items: ItemRow[] = version
        ? await tx.bqItem.findMany({
            where: { tenantId: access.tenantId, versionId: version.id },
            include: itemWithBill,
            orderBy: [{ bill: { sortOrder: "asc" } }, { sortOrder: "asc" }],
          })
        : [];
      const [approved, facts] = await Promise.all([
        approvedMeasurements(tx, access.tenantId, projectId),
        loadProjectFacts(tx, access.tenantId, projectId),
      ]);
      const inForce = valuedInForce(items, approved, nairobiDate());
      const figures = itemFigures(facts);
      const rowOf = (input: {
        contractMinor: number;
        evMinor: number;
        budgetMinor: number | null;
        actualMinor: number;
      }): CostToCompleteRow => ({ ...input, ...costToComplete(input) });
      const perItem = items.map((item) => {
        const own = figures.get(item.lineageId);
        const valued = inForce.get(item.lineageId);
        return {
          item,
          input: {
            contractMinor: minorOf(item.amountMinor),
            evMinor: valued?.valueMinor ?? 0,
            budgetMinor: own?.budgetMinor ?? null,
            actualMinor: own?.actualMinor ?? 0,
          },
          percentComplete: valued?.percentComplete ?? null,
        };
      });
      const sum = (rows: typeof perItem) => ({
        contractMinor: rows.reduce((total, row) => total + row.input.contractMinor, 0),
        evMinor: rows.reduce((total, row) => total + row.input.evMinor, 0),
        budgetMinor: rows.reduce<number | null>(
          (total, row) =>
            row.input.budgetMinor === null ? total : (total ?? 0) + row.input.budgetMinor,
          null,
        ),
        actualMinor: rows.reduce((total, row) => total + row.input.actualMinor, 0),
      });
      const billMap = new Map<string, { bill: ItemRow["bill"]; rows: typeof perItem }>();
      for (const row of perItem) {
        const entry = billMap.get(row.item.bill.lineageId) ?? { bill: row.item.bill, rows: [] };
        entry.rows.push(row);
        billMap.set(row.item.bill.lineageId, entry);
      }
      // Accrued cost not on an item of the BQ in force (cost codes, materials still in stores).
      const accrued = facts.entries
        .filter((entry) => entry.measure === "accrued")
        .reduce((total, entry) => total + entry.sum, 0);
      const notOnItemsActual =
        accrued - perItem.reduce((total, row) => total + row.input.actualMinor, 0);
      const costCodeBudget = facts.budgetLines
        .filter((line) => line.costCodeId !== null)
        .reduce<number | null>((total, line) => (total ?? 0) + line.amountMinor, null);

      let bill: { lineageId: string; number: string; title: string } | null = null;
      let pageItems: ReturnType<typeof itemRow>[] = [];
      let page = null;
      if (query.billLineageId) {
        const entry = billMap.get(query.billLineageId);
        if (!entry) throw new NotFoundException("Bill not found in the BQ in force");
        bill = {
          lineageId: entry.bill.lineageId,
          number: entry.bill.number,
          title: entry.bill.title,
        };
        const needle = query.search?.trim().toLowerCase();
        const filtered = entry.rows.filter(
          (row) =>
            !needle ||
            (row.item.ref ?? "").toLowerCase().includes(needle) ||
            row.item.description.toLowerCase().includes(needle),
        );
        const offset = query.cursor ? Number(query.cursor) : 0;
        pageItems = filtered.slice(offset, offset + query.limit).map((row) => itemRow(row, rowOf));
        const hasMore = offset + query.limit < filtered.length;
        page = { hasMore, nextCursor: hasMore ? String(offset + query.limit) : null };
      }
      return costToCompleteResponseSchema.parse({
        project: projectRef(project.project),
        bqVersion: version ? { id: version.id, versionNo: version.versionNo } : null,
        budget: facts.budget
          ? { id: facts.budget.id, versionNo: facts.budget.versionNo, name: facts.budget.name }
          : null,
        totals: rowOf(sum(perItem)),
        bills: [...billMap.values()]
          .sort((a, b) => a.bill.sortOrder - b.bill.sortOrder)
          .map((entry) => ({
            bill: {
              lineageId: entry.bill.lineageId,
              number: entry.bill.number,
              title: entry.bill.title,
            },
            ...rowOf(sum(entry.rows)),
          })),
        bill,
        items: pageItems,
        page,
        notOnBqItems: { actualMinor: notOnItemsActual, budgetMinor: costCodeBudget },
      });
    });
  }
}

const itemRow = (
  row: {
    item: ItemRow;
    input: {
      contractMinor: number;
      evMinor: number;
      budgetMinor: number | null;
      actualMinor: number;
    };
    percentComplete: string | null;
  },
  rowOf: (input: {
    contractMinor: number;
    evMinor: number;
    budgetMinor: number | null;
    actualMinor: number;
  }) => CostToCompleteRow,
) => ({
  item: bqItemWire(row.item),
  percentComplete: row.percentComplete,
  ...rowOf(row.input),
});

/**
 * The planned and earned value inputs shared by the finance view and the client portal (D7.1):
 * the BQ in force, its measured items' budget at completion, earned value as a running total of
 * approved measurements in force (each replaces the item's previous value from its measurement
 * date) and planned value from the newest schedule baseline. No cost data.
 */
export async function plannedAndEarned(tx: Tx, tenantId: string, projectId: string) {
  const version = await bqInForce(tx, tenantId, projectId);
  const items: ItemRow[] = version
    ? await tx.bqItem.findMany({
        where: { tenantId, versionId: version.id },
        include: itemWithBill,
      })
    : [];
  const measured = items.filter((item) => measurementBasis(measurable(item)) !== null);
  const bacMinor = measured.reduce((sum, item) => sum + minorOf(item.amountMinor), 0);
  const approved = await approvedMeasurements(tx, tenantId, projectId);

  // EV as a running total of value changes: each approved measurement in force replaces the
  // item's previous value from its measurement date.
  const evChanges = earnedValueChanges(measured, approved);
  const ev = runningTotal(evChanges);
  // PV from the current (newest) schedule baseline.
  const baseline = await tx.scheduleBaseline.findFirst({
    where: { tenantId, projectId },
    orderBy: { baselineNo: "desc" },
    include: { items: true },
  });
  let pv: PlannedValue | null = null;
  let linked = 0;
  let spread = 0;
  let baselineFinish: string | null = null;
  if (baseline) {
    const holidays = baseline.includePublicHolidays
      ? (
          await tx.publicHoliday.findMany({
            where: { tenantId },
            select: { holidayDate: true },
          })
        ).map((row) => toCalendarDate(row.holidayDate))
      : [];
    const calendar = workingCalendar(baseline.workingWeekdays, holidays);
    const tasks = baseline.items.filter((item) => item.kind === "task");
    const activities = await tx.scheduleActivity.findMany({
      where: {
        tenantId,
        projectId,
        id: { in: tasks.map((item) => item.refId) },
        bqItemLineageId: { not: null },
      },
      select: { id: true, bqItemLineageId: true },
    });
    const windows = new Map<string, PlannedWindow[]>();
    for (const activity of activities) {
      const item = tasks.find((task) => task.refId === activity.id)!;
      const list = windows.get(activity.bqItemLineageId!) ?? [];
      list.push({
        start: toCalendarDate(item.startDate),
        finish: toCalendarDate(item.finishDate),
      });
      windows.set(activity.bqItemLineageId!, list);
    }
    const starts = baseline.items.map((item) => toCalendarDate(item.startDate));
    const finishes = baseline.items.map((item) => toCalendarDate(item.finishDate));
    const start = [toCalendarDate(baseline.startDate), ...starts].sort()[0]!;
    baselineFinish = baseline.projectFinish
      ? toCalendarDate(baseline.projectFinish)
      : ([...finishes].sort().at(-1) ?? start);
    const span = { start, finish: baselineFinish < start ? start : baselineFinish };
    pv = new PlannedValue(
      calendar,
      span,
      measured.map((item) => {
        const own = windows.get(item.lineageId) ?? [];
        if (own.length) linked += 1;
        else spread += 1;
        return { amountMinor: minorOf(item.amountMinor), windows: own };
      }),
    );
  }
  return {
    version,
    measured,
    bacMinor,
    evChanges,
    ev,
    baseline,
    pv,
    linked,
    spread,
    baselineFinish,
  };
}

/**
 * Value changes over time: for each measured item, each approved measurement (newest of its day)
 * replaces the item's value from its measurement date; the running total is EV on any date.
 */
function earnedValueChanges(
  items: readonly ItemRow[],
  approved: Awaited<ReturnType<typeof approvedMeasurements>>,
): DatedValue[] {
  const byLineage = new Map(items.map((item) => [item.lineageId, item]));
  const series = new Map<string, typeof approved>();
  for (const row of approved) {
    const item = byLineage.get(row.itemLineageId);
    if (!item) continue;
    const basis = measurementBasis(measurable(item));
    if (basis === null || (row.basis ?? "quantity") !== basis) continue;
    series.set(row.itemLineageId, [...(series.get(row.itemLineageId) ?? []), row]);
  }
  const changes: DatedValue[] = [];
  for (const [lineage, rows] of series) {
    const item = measurable(byLineage.get(lineage)!);
    const sorted = [...rows].sort(
      (a, b) =>
        a.measuredOn.getTime() - b.measuredOn.getTime() ||
        a.recordedAt.getTime() - b.recordedAt.getTime() ||
        (a.id < b.id ? -1 : 1),
    );
    let previous = 0;
    for (let index = 0; index < sorted.length; index += 1) {
      const row = sorted[index]!;
      const next = sorted[index + 1];
      if (next && next.measuredOn.getTime() === row.measuredOn.getTime()) continue;
      const value = measuredValueMinor(item, row.quantityToDate.toFixed());
      changes.push({ date: toCalendarDate(row.measuredOn), valueMinor: value - previous });
      previous = value;
    }
  }
  return changes;
}

/** Duration-weighted physical progress of the schedule (D6.2), as a percentage; null if unavailable. */
async function physicalPercent(
  tx: Tx,
  tenantId: string,
  project: { id: string; status: string; startDate: Date | null },
): Promise<string | null> {
  const data = await loadSchedule(tx, tenantId, project, new Set());
  if (!data.tasks.length) return null;
  const computed = compute(data);
  const ratio = scheduleProgress(
    data.tasks.map((task) => ({
      durationDays: task.durationDays,
      status: computed.items.get(taskKey(task.id))!.status,
      percentComplete: task.percentComplete === null ? null : task.percentComplete.toNumber(),
    })),
  );
  return ratio === null ? null : (Math.floor(ratio * 1000) / 10).toFixed(1);
}
