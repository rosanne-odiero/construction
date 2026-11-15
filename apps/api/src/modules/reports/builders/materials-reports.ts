import {
  addCalendarDays,
  AGEING_BUCKETS,
  ageInvoices,
  nairobiDate,
  stockValueToMinor,
  zonedDateTime,
} from "@pm-buddy/domain";
import type { LpoStatus, StockEntryKind } from "@pm-buddy/types";
import type { ReportCell } from "@pm-buddy/validation";
import {
  bounded,
  column,
  dayOf,
  fromDay,
  money,
  projectCode,
  projectIds,
  quantity,
  sum,
  supplierName,
  type BuildContext,
  type BuildResult,
} from "../report-model.js";

const materialName = (ctx: BuildContext, material: { name: string; nameSw: string | null }) =>
  ctx.locale === "sw" && material.nameSw ? material.nameSw : material.name;

/**
 * Stock: on hand now per store and material (quantity in the base unit, weighted average cost and
 * value in whole cents, as the stores screen), then every stock ledger movement of the period with
 * its document. Same permission as the stores screens (STORES_VIEW_PERMISSIONS on the project).
 */
export async function stock(ctx: BuildContext): Promise<BuildResult> {
  const { tx, access } = ctx.scope;
  const t = ctx.t.stock;
  const { from, to } = ctx.params.period!;
  const stores = await tx.store.findMany({
    where: {
      tenantId: access.tenantId,
      projectId: { in: projectIds(ctx) },
      ...(ctx.params.storeId ? { id: ctx.params.storeId } : {}),
    },
    select: { id: true, name: true, projectId: true },
  });
  const storeIds = stores.map((store) => store.id);
  const storeOf = new Map(stores.map((store) => [store.id, store]));
  const balances = bounded(
    await tx.stockBalance.findMany({
      where: { tenantId: access.tenantId, storeId: { in: storeIds }, quantity: { not: 0 } },
      select: {
        storeId: true,
        quantity: true,
        valueMinor: true,
        material: { select: { code: true, name: true, nameSw: true, baseUnit: true } },
      },
      orderBy: [{ store: { name: "asc" } }, { material: { code: "asc" } }],
      take: ctx.maxRows + 1,
    }),
    ctx.maxRows,
  );
  const onHand: ReportCell[][] = balances.map((balance) => {
    const store = storeOf.get(balance.storeId)!;
    return [
      store.name,
      projectCode(ctx, store.projectId),
      balance.material.code,
      materialName(ctx, balance.material),
      balance.material.baseUnit,
      quantity(balance.quantity),
      stockValueToMinor(balance.valueMinor.div(balance.quantity).toFixed(6)),
      stockValueToMinor(balance.valueMinor.toFixed(6)),
    ];
  });
  const entries = bounded(
    await tx.stockLedgerEntry.findMany({
      where: {
        tenantId: access.tenantId,
        projectId: { in: projectIds(ctx) },
        storeId: { in: storeIds },
        businessDate: { gte: fromDay(from), lte: fromDay(to) },
      },
      select: {
        businessDate: true,
        storeId: true,
        kind: true,
        quantity: true,
        valueMinor: true,
        baseUnit: true,
        material: { select: { code: true, name: true, nameSw: true } },
        grn: { select: { number: true } },
        movement: { select: { number: true } },
        transfer: { select: { number: true } },
        stockTake: { select: { number: true } },
      },
      orderBy: [{ businessDate: "asc" }, { recordedAt: "asc" }, { id: "asc" }],
      take: ctx.maxRows + 1,
    }),
    ctx.maxRows,
  );
  const kinds = ctx.m.stores.status.entryKind;
  const movements: ReportCell[][] = entries.map((entry) => {
    const moved = quantity(entry.quantity)!;
    const negative = moved.startsWith("-");
    return [
      dayOf(entry.businessDate),
      storeOf.get(entry.storeId)?.name ?? "",
      `${entry.material.code} ${materialName(ctx, entry.material)}`,
      entry.baseUnit,
      kinds[entry.kind as StockEntryKind],
      entry.grn?.number ??
        entry.movement?.number ??
        entry.transfer?.number ??
        entry.stockTake?.number ??
        null,
      negative ? null : moved,
      negative ? moved.slice(1) : null,
      stockValueToMinor(entry.valueMinor.toFixed(6)),
    ];
  });
  return {
    sections: [
      {
        key: "on-hand",
        title: t.onHand,
        columns: [
          column("store", t.store, "text"),
          column("project", t.project, "text"),
          column("code", t.code, "text"),
          column("material", t.material, "text"),
          column("unit", t.unit, "text"),
          column("quantity", t.quantity, "quantity"),
          column("averageCost", t.averageCost, "money"),
          column("value", t.value, "money"),
        ],
        rows: onHand,
        totals: onHand.length
          ? [ctx.t.total, null, null, null, null, null, null, sum(onHand, 7)]
          : null,
        notes: [],
      },
      {
        key: "movements",
        title: t.movements,
        columns: [
          column("date", t.date, "date"),
          column("store", t.store, "text"),
          column("material", t.material, "text"),
          column("unit", t.unit, "text"),
          column("kind", t.kind, "text"),
          column("reference", t.reference, "text"),
          column("in", t.in, "quantity"),
          column("out", t.out, "quantity"),
          column("value", t.value, "money"),
        ],
        rows: movements,
        totals: movements.length
          ? [ctx.t.total, null, null, null, null, null, null, null, sum(movements, 8)]
          : null,
        notes: [],
      },
    ],
    notes: [t.note],
  };
}

const ACCEPTED = ["approved", "partly_settled", "settled"];

/**
 * LPO register: LPOs raised in the period (Nairobi dates) on the projects in scope, with net, VAT,
 * total and the approved supplier invoices against each (incl. VAT). Totals leave out drafts and
 * cancelled LPOs. Same permission as the LPO screens.
 */
export async function lpoRegister(ctx: BuildContext): Promise<BuildResult> {
  const { tx, access } = ctx.scope;
  const t = ctx.t.lpo;
  const { from, to } = ctx.params.period!;
  const lpos = bounded(
    await tx.lpo.findMany({
      where: {
        tenantId: access.tenantId,
        projectId: { in: projectIds(ctx) },
        createdAt: { gte: zonedDateTime(from, 0), lt: zonedDateTime(addCalendarDays(to, 1), 0) },
      },
      select: {
        number: true,
        projectId: true,
        status: true,
        createdAt: true,
        approvedAt: true,
        deliveryDate: true,
        subtotalMinor: true,
        vatMinor: true,
        totalMinor: true,
        supplier: { select: { legalName: true, tradingName: true } },
        invoices: { where: { status: { in: ACCEPTED } }, select: { totalMinor: true } },
      },
      orderBy: [{ number: "asc" }],
      take: ctx.maxRows + 1,
    }),
    ctx.maxRows,
  );
  const statuses = ctx.m.p2p.status.lpo;
  const rows: ReportCell[][] = lpos.map((lpo) => [
    lpo.number,
    projectCode(ctx, lpo.projectId),
    supplierName(lpo.supplier),
    statuses[lpo.status as LpoStatus],
    nairobiDate(lpo.createdAt),
    lpo.approvedAt ? nairobiDate(lpo.approvedAt) : null,
    lpo.deliveryDate ? dayOf(lpo.deliveryDate) : null,
    money(lpo.subtotalMinor),
    money(lpo.vatMinor),
    money(lpo.totalMinor),
    lpo.invoices.reduce((total, invoice) => total + Number(invoice.totalMinor), 0),
  ]);
  const counted = rows.filter((_, index) => !["draft", "cancelled"].includes(lpos[index]!.status));
  return {
    sections: [
      {
        key: "lpos",
        title: t.section,
        columns: [
          column("number", t.number, "text"),
          column("project", t.project, "text"),
          column("supplier", t.supplier, "text"),
          column("status", t.status, "text"),
          column("created", t.created, "date"),
          column("approved", t.approved, "date"),
          column("delivery", t.delivery, "date"),
          column("subtotal", t.subtotal, "money"),
          column("vat", t.vat, "money"),
          column("total", t.total, "money"),
          column("invoiced", t.invoiced, "money"),
        ],
        rows,
        totals: rows.length
          ? [
              ctx.t.total,
              null,
              null,
              null,
              null,
              null,
              null,
              sum(counted, 7),
              sum(counted, 8),
              sum(counted, 9),
              sum(counted, 10),
            ]
          : null,
        notes: [t.note],
      },
    ],
    notes: [],
  };
}

type AgeingRow = {
  invoice_number: string;
  project_id: string;
  supplier: string;
  invoice_date: Date;
  due_date: Date;
  total_minor: bigint;
  paid_minor: bigint;
};

/**
 * Supplier invoice ageing at a date (D-123): approved invoices (incl. VAT) dated on or before it,
 * less the payments recorded by then, aged by days past the due date (packages/domain
 * ageInvoices); invoices fully paid in the 30 days before it are counted as paid. Same permission
 * as the invoice screens.
 */
export async function invoiceAgeing(ctx: BuildContext): Promise<BuildResult> {
  const { tx, access } = ctx.scope;
  const t = ctx.t.ageing;
  const asAt = ctx.params.asAt!;
  const recent = addCalendarDays(asAt, -30);
  const invoices = bounded(
    await tx.$queryRaw<AgeingRow[]>`
      SELECT i.invoice_number, i.project_id, COALESCE(su.trading_name, su.legal_name) AS supplier,
             i.invoice_date, i.due_date, i.total_minor,
             COALESCE(SUM(s.amount_minor) FILTER (WHERE s.paid_on <= ${fromDay(asAt)}::date), 0)::bigint AS paid_minor
        FROM supplier_invoices i
        JOIN suppliers su ON su.tenant_id = i.tenant_id AND su.id = i.supplier_id
        LEFT JOIN invoice_settlements s ON s.tenant_id = i.tenant_id AND s.invoice_id = i.id
       WHERE i.tenant_id = ${access.tenantId}::uuid
         AND i.project_id = ANY(${projectIds(ctx)}::uuid[])
         AND i.status IN ('approved', 'partly_settled', 'settled')
         AND i.invoice_date <= ${fromDay(asAt)}::date
       GROUP BY i.id, su.id
      HAVING i.total_minor > COALESCE(SUM(s.amount_minor) FILTER (WHERE s.paid_on <= ${fromDay(asAt)}::date), 0)
          OR MAX(s.paid_on) FILTER (WHERE s.paid_on <= ${fromDay(asAt)}::date) > ${fromDay(recent)}::date
       ORDER BY i.due_date, i.invoice_number, i.id
       LIMIT ${ctx.maxRows + 1}`,
    ctx.maxRows,
  );
  const aged = ageInvoices(
    invoices.map((invoice) => ({
      number: invoice.invoice_number,
      projectId: invoice.project_id,
      supplier: invoice.supplier,
      invoiceDate: dayOf(invoice.invoice_date),
      dueDate: dayOf(invoice.due_date),
      totalMinor: Number(invoice.total_minor),
      paidMinor: Number(invoice.paid_minor),
    })),
    asAt,
  );
  const outstanding = aged.rows.filter((row) => row.bucket !== "paid");
  const paid = aged.rows.filter((row) => row.bucket === "paid");
  const summary: ReportCell[][] = [
    ...AGEING_BUCKETS.map((bucket): ReportCell[] => [
      t.buckets[bucket],
      String(outstanding.filter((row) => row.bucket === bucket).length),
      aged.totals[bucket],
    ]),
    [t.buckets.paid, String(paid.length), paid.reduce((total, row) => total + row.totalMinor, 0)],
  ];
  const rows: ReportCell[][] = outstanding.map((row) => [
    row.number,
    projectCode(ctx, row.projectId),
    row.supplier,
    row.invoiceDate,
    row.dueDate,
    row.totalMinor,
    row.paidMinor,
    row.outstandingMinor,
    String(row.daysOverdue),
    t.buckets[row.bucket as (typeof AGEING_BUCKETS)[number]],
  ]);
  return {
    sections: [
      {
        key: "summary",
        title: t.summary,
        columns: [
          column("bucket", t.bucket, "text"),
          column("count", t.count, "quantity"),
          column("outstanding", t.outstanding, "money"),
        ],
        rows: summary,
        totals: [ctx.t.total, String(outstanding.length), aged.outstandingMinor],
        notes: [],
      },
      {
        key: "invoices",
        title: t.invoices,
        columns: [
          column("invoice", t.invoice, "text"),
          column("project", t.project, "text"),
          column("supplier", t.supplier, "text"),
          column("invoiceDate", t.invoiceDate, "date"),
          column("dueDate", t.dueDate, "date"),
          column("total", t.total, "money"),
          column("paidToDate", t.paidToDate, "money"),
          column("outstanding", t.outstanding, "money"),
          column("daysOverdue", t.daysOverdue, "quantity"),
          column("bucket", t.bucket, "text"),
        ],
        rows,
        totals: rows.length
          ? [
              ctx.t.total,
              null,
              null,
              null,
              null,
              sum(rows, 5),
              sum(rows, 6),
              sum(rows, 7),
              null,
              null,
            ]
          : null,
        notes: [],
      },
    ],
    notes: [t.note],
  };
}
