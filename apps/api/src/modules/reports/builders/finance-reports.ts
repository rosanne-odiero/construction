import {
  addCalendarDays,
  floatPeriod,
  paymentState,
  zonedDateTime,
  type FloatEntry,
} from "@pm-buddy/domain";
import type { CostCategory, CountStatus, FloatEntryKind } from "@pm-buddy/types";
import type { ReportCell } from "@pm-buddy/validation";
import {
  bounded,
  column,
  dayOf,
  displayNames,
  fill,
  fromDay,
  money,
  projectCode,
  projectIds,
  sum,
  type BuildContext,
  type BuildResult,
} from "../report-model.js";

const tagOf = (entry: {
  bqItem: { ref: string | null; description: string } | null;
  costCode: { code: string; name: string } | null;
}) => {
  if (entry.bqItem)
    return `${entry.bqItem.ref ?? "—"} ${entry.bqItem.description.replace(/\s+/g, " ").slice(0, 80)}`;
  if (entry.costCode) return `${entry.costCode.code} ${entry.costCode.name}`;
  return null;
};

/**
 * Cost ledger: the D5.4 entries of the period (by the date the cost happened) on the projects in
 * scope, with accrued and paid in separate columns, and the same entries summed by category. Same
 * permission as the ledger screen: finance.view or finance.manage on the project.
 */
export async function costLedger(ctx: BuildContext): Promise<BuildResult> {
  const { tx, access } = ctx.scope;
  const t = ctx.t.costLedger;
  const period = ctx.params.period!;
  const entries = bounded(
    await tx.costEntry.findMany({
      where: {
        tenantId: access.tenantId,
        projectId: { in: projectIds(ctx) },
        occurredOn: { gte: fromDay(period.from), lte: fromDay(period.to) },
      },
      select: {
        occurredOn: true,
        projectId: true,
        category: true,
        measure: true,
        amountMinor: true,
        counterpartyName: true,
        paymentReference: true,
        source: true,
        bqItem: { select: { ref: true, description: true } },
        costCode: { select: { code: true, name: true } },
        supplier: { select: { legalName: true, tradingName: true } },
        invoice: { select: { invoiceNumber: true } },
        expense: { select: { number: true } },
        floatCount: { select: { number: true } },
        journal: { select: { number: true } },
      },
      orderBy: [{ occurredOn: "asc" }, { recordedAt: "asc" }, { id: "asc" }],
      take: ctx.maxRows + 1,
    }),
    ctx.maxRows,
  );
  const category = (value: string) => ctx.m.spending.categories[value as CostCategory];
  const rows: ReportCell[][] = entries.map((entry) => {
    const amount = money(entry.amountMinor);
    const document =
      entry.invoice?.invoiceNumber ??
      entry.expense?.number ??
      entry.floatCount?.number ??
      entry.journal?.number ??
      null;
    return [
      dayOf(entry.occurredOn),
      projectCode(ctx, entry.projectId),
      category(entry.category),
      tagOf(entry),
      entry.supplier
        ? (entry.supplier.tradingName ?? entry.supplier.legalName)
        : entry.counterpartyName,
      document
        ? `${ctx.m.spending.sources[entry.source as keyof typeof ctx.m.spending.sources]} ${document}`
        : null,
      entry.paymentReference,
      entry.measure === "accrued" ? amount : null,
      entry.measure === "paid" ? amount : null,
    ];
  });
  const byCategory = new Map<string, { accrued: number; paid: number }>();
  for (const entry of entries) {
    const row = byCategory.get(entry.category) ?? { accrued: 0, paid: 0 };
    if (entry.measure === "accrued") row.accrued += Number(entry.amountMinor);
    else row.paid += Number(entry.amountMinor);
    byCategory.set(entry.category, row);
  }
  const categories: ReportCell[][] = [...byCategory.entries()]
    .sort(([a], [b]) => category(a).localeCompare(category(b)))
    .map(([key, value]) => [category(key), value.accrued, value.paid]);
  return {
    sections: [
      {
        key: "entries",
        title: t.entries,
        columns: [
          column("date", t.date, "date"),
          column("project", t.project, "text"),
          column("category", t.category, "text"),
          column("tag", t.tag, "text"),
          column("counterparty", t.counterparty, "text"),
          column("document", t.document, "text"),
          column("reference", t.reference, "text"),
          column("accrued", t.accrued, "money"),
          column("paid", t.paid, "money"),
        ],
        rows,
        totals: rows.length
          ? [ctx.t.total, null, null, null, null, null, null, sum(rows, 7), sum(rows, 8)]
          : null,
        notes: [t.note],
      },
      {
        key: "by-category",
        title: t.byCategory,
        columns: [
          column("category", t.category, "text"),
          column("accrued", t.accrued, "money"),
          column("paid", t.paid, "money"),
        ],
        rows: categories,
        totals: categories.length ? [ctx.t.total, sum(categories, 1), sum(categories, 2)] : null,
        notes: [],
      },
    ],
    notes: [],
  };
}

/**
 * Budget against actual for one project, read through the D5.4 spending report itself (the same
 * service, permission check and figures as the project's spending page), by category and by bill.
 */
export async function budgetVsActual(ctx: BuildContext): Promise<BuildResult> {
  const t = ctx.t.budget;
  const report = await ctx.spending.project(ctx.principal, ctx.params.projectId!, ctx.req);
  type Row = (typeof report)["totals"];
  const figures = (row: Row): ReportCell[] => [
    row.budgetMinor,
    row.committedMinor,
    row.actualMinor,
    row.paidMinor,
    row.forecastMinor,
    row.remainingMinor,
    row.usedPercent,
  ];
  const columns = (first: string, label: string) => [
    column(first, label, "text"),
    column("budget", t.budget, "money"),
    column("committed", t.committed, "money"),
    column("actual", t.actual, "money"),
    column("paid", t.paid, "money"),
    column("forecast", t.forecast, "money"),
    column("remaining", t.remaining, "money"),
    column("used", t.used, "percent"),
  ];
  const totals = [ctx.t.total, ...figures(report.totals)];
  return {
    sections: [
      {
        key: "categories",
        title: t.categories,
        columns: columns("category", t.category),
        rows: report.categories.map((row) => [
          ctx.m.spending.categories[row.category],
          ...figures(row),
        ]),
        totals,
        notes: [],
      },
      {
        key: "bills",
        title: t.bills,
        columns: columns("bill", t.bill),
        rows: [
          ...report.bills.map((row) => [`${row.bill.number} ${row.bill.title}`, ...figures(row)]),
          [t.notOnItems, ...figures(report.notOnBqItems)],
        ],
        totals,
        notes: [],
      },
    ],
    notes: [
      report.budget ? fill(t.version, { version: report.budget.versionNo }) : t.noBudget,
      t.note,
    ],
  };
}

type InvoiceRow = {
  id: string;
  invoice_number: string;
  project_id: string;
  supplier: string;
  authorised_minor: bigint;
  before_minor: bigint;
  during_minor: bigint;
};
type PaymentRow = {
  paid_on: Date;
  invoice_number: string;
  supplier: string;
  method: string;
  external_reference: string;
  amount_minor: bigint;
};

/**
 * Supplier payments against approved invoices (D5.2 settlements): every invoice approved by the
 * end of the period that was still owed at its start or paid during it — approved (the current
 * payable's authorised amount), paid before, paid in the period, outstanding and the state — and
 * each payment recorded in the period. Same permission as the invoice screens.
 */
export async function supplierPayments(ctx: BuildContext): Promise<BuildResult> {
  const { tx, access } = ctx.scope;
  const t = ctx.t.payments;
  const { from, to } = ctx.params.period!;
  const ids = projectIds(ctx);
  const invoices = bounded(
    await tx.$queryRaw<InvoiceRow[]>`
      SELECT i.id, i.invoice_number, i.project_id,
             COALESCE(su.trading_name, su.legal_name) AS supplier,
             p.authorised_minor,
             COALESCE(SUM(s.amount_minor) FILTER (WHERE s.paid_on < ${fromDay(from)}::date), 0)::bigint AS before_minor,
             COALESCE(SUM(s.amount_minor) FILTER (WHERE s.paid_on >= ${fromDay(from)}::date AND s.paid_on <= ${fromDay(to)}::date), 0)::bigint AS during_minor
        FROM supplier_invoices i
        JOIN invoice_payables p ON p.tenant_id = i.tenant_id AND p.invoice_id = i.id AND p.superseded_at IS NULL
        JOIN suppliers su ON su.tenant_id = i.tenant_id AND su.id = i.supplier_id
        LEFT JOIN invoice_settlements s ON s.tenant_id = i.tenant_id AND s.invoice_id = i.id
       WHERE i.tenant_id = ${access.tenantId}::uuid
         AND i.project_id = ANY(${ids}::uuid[])
         AND i.status IN ('approved', 'partly_settled', 'settled')
         AND (p.approved_at AT TIME ZONE 'Africa/Nairobi')::date <= ${fromDay(to)}::date
       GROUP BY i.id, su.id, p.id
      HAVING p.authorised_minor > COALESCE(SUM(s.amount_minor) FILTER (WHERE s.paid_on < ${fromDay(from)}::date), 0)
          OR COUNT(s.id) FILTER (WHERE s.paid_on >= ${fromDay(from)}::date AND s.paid_on <= ${fromDay(to)}::date) > 0
       ORDER BY i.invoice_number, i.id
       LIMIT ${ctx.maxRows + 1}`,
    ctx.maxRows,
  );
  const rows: ReportCell[][] = invoices.map((invoice) => {
    const approved = Number(invoice.authorised_minor);
    const before = Number(invoice.before_minor);
    const during = Number(invoice.during_minor);
    const toDate = before + during;
    return [
      invoice.invoice_number,
      projectCode(ctx, invoice.project_id),
      invoice.supplier,
      approved,
      before,
      during,
      toDate,
      approved - toDate,
      t.states[paymentState(approved, toDate)],
    ];
  });
  const payments = bounded(
    await tx.$queryRaw<PaymentRow[]>`
      SELECT s.paid_on, i.invoice_number, COALESCE(su.trading_name, su.legal_name) AS supplier,
             s.method, s.external_reference, s.amount_minor
        FROM invoice_settlements s
        JOIN supplier_invoices i ON i.tenant_id = s.tenant_id AND i.id = s.invoice_id
        JOIN suppliers su ON su.tenant_id = i.tenant_id AND su.id = i.supplier_id
       WHERE s.tenant_id = ${access.tenantId}::uuid
         AND i.project_id = ANY(${ids}::uuid[])
         AND s.paid_on >= ${fromDay(from)}::date AND s.paid_on <= ${fromDay(to)}::date
       ORDER BY s.paid_on, i.invoice_number, s.id
       LIMIT ${ctx.maxRows + 1}`,
    ctx.maxRows,
  );
  const methods = ctx.m.p2p.status.method as Record<string, string>;
  const paymentRows: ReportCell[][] = payments.map((payment) => [
    dayOf(payment.paid_on),
    payment.invoice_number,
    payment.supplier,
    methods[payment.method] ?? payment.method,
    payment.external_reference,
    money(payment.amount_minor),
  ]);
  return {
    sections: [
      {
        key: "invoices",
        title: t.invoices,
        columns: [
          column("invoice", t.invoice, "text"),
          column("project", t.project, "text"),
          column("supplier", t.supplier, "text"),
          column("approved", t.approved, "money"),
          column("before", t.before, "money"),
          column("during", t.during, "money"),
          column("toDate", t.toDate, "money"),
          column("outstanding", t.outstanding, "money"),
          column("state", t.state, "text"),
        ],
        rows,
        totals: rows.length
          ? [ctx.t.total, null, null, ...[3, 4, 5, 6, 7].map((index) => sum(rows, index)), null]
          : null,
        notes: [],
      },
      {
        key: "payments",
        title: t.payments,
        columns: [
          column("paidOn", t.paidOn, "date"),
          column("invoice", t.invoice, "text"),
          column("supplier", t.supplier, "text"),
          column("method", t.method, "text"),
          column("reference", t.reference, "text"),
          column("amount", t.amount, "money"),
        ],
        rows: paymentRows,
        totals: paymentRows.length
          ? [ctx.t.total, null, null, null, null, sum(paymentRows, 5)]
          : null,
        notes: [],
      },
    ],
    notes: [t.note],
  };
}

type FloatTotals = { float_id: string; kind: FloatEntryKind; before: boolean; amount: bigint };

/**
 * Petty-cash floats over a period (D-125): book balance before the period, top-ups, expenses,
 * rejected expenses and approved count adjustments in it, and the closing book balance
 * (packages/domain floatPeriod), plus the cash counts made in the period with their variances.
 * Same permission as the float screens (PETTY_CASH_READ_PERMISSIONS on the project).
 */
export async function pettyCash(ctx: BuildContext): Promise<BuildResult> {
  const { tx, access } = ctx.scope;
  const t = ctx.t.pettyCash;
  const { from, to } = ctx.params.period!;
  const floats = bounded(
    await tx.pettyCashFloat.findMany({
      where: { tenantId: access.tenantId, projectId: { in: projectIds(ctx) } },
      select: {
        id: true,
        name: true,
        projectId: true,
        custodianUserId: true,
        balanceMinor: true,
        site: { select: { name: true } },
      },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: ctx.maxRows + 1,
    }),
    ctx.maxRows,
  );
  const floatIds = floats.map((float) => float.id);
  const grouped = floatIds.length
    ? await tx.$queryRaw<FloatTotals[]>`
        SELECT float_id, kind, business_date < ${fromDay(from)}::date AS before,
               SUM(amount_minor)::bigint AS amount
          FROM petty_cash_entries
         WHERE tenant_id = ${access.tenantId}::uuid AND float_id = ANY(${floatIds}::uuid[])
           AND business_date <= ${fromDay(to)}::date
         GROUP BY 1, 2, 3`
    : [];
  const before = addCalendarDays(from, -1);
  const people = await displayNames(
    tx,
    floats.map((float) => float.custodianUserId),
  );
  const rows: ReportCell[][] = floats.map((float) => {
    const entries: FloatEntry[] = grouped
      .filter((row) => row.float_id === float.id)
      .map((row) => ({
        kind: row.kind,
        amountMinor: Number(row.amount),
        businessDate: row.before ? before : from,
      }));
    const figures = floatPeriod(entries, from, to);
    return [
      float.name,
      projectCode(ctx, float.projectId),
      float.site.name,
      people.get(float.custodianUserId) ?? "—",
      figures.openingMinor,
      figures.topUpsMinor,
      -figures.expensesMinor,
      figures.rejectedMinor,
      figures.countAdjustmentsMinor,
      figures.closingMinor,
      money(float.balanceMinor),
    ];
  });
  const counts = floatIds.length
    ? bounded(
        await tx.pettyCashCount.findMany({
          where: {
            tenantId: access.tenantId,
            floatId: { in: floatIds },
            countedAt: {
              gte: zonedDateTime(from, 0),
              lt: zonedDateTime(addCalendarDays(to, 1), 0),
            },
          },
          select: {
            number: true,
            floatId: true,
            countedAt: true,
            bookMinor: true,
            countedMinor: true,
            varianceMinor: true,
            status: true,
          },
          orderBy: [{ countedAt: "asc" }, { id: "asc" }],
          take: ctx.maxRows + 1,
        }),
        ctx.maxRows,
      )
    : [];
  const floatName = new Map(floats.map((float) => [float.id, float.name]));
  const countRows: ReportCell[][] = counts.map((count) => [
    count.number,
    floatName.get(count.floatId) ?? "",
    count.countedAt.toISOString(),
    money(count.bookMinor),
    money(count.countedMinor),
    money(count.varianceMinor),
    ctx.m.spending.status.count[count.status as CountStatus],
  ]);
  return {
    sections: [
      {
        key: "floats",
        title: t.floats,
        columns: [
          column("float", t.float, "text"),
          column("project", t.project, "text"),
          column("site", t.site, "text"),
          column("custodian", t.custodian, "text"),
          column("opening", t.opening, "money"),
          column("topUps", t.topUps, "money"),
          column("expenses", t.expenses, "money"),
          column("rejected", t.rejected, "money"),
          column("adjustments", t.adjustments, "money"),
          column("closing", t.closing, "money"),
          column("balanceNow", t.balanceNow, "money"),
        ],
        rows,
        totals: rows.length
          ? [ctx.t.total, null, null, null, ...[4, 5, 6, 7, 8, 9, 10].map((i) => sum(rows, i))]
          : null,
        notes: [],
      },
      {
        key: "counts",
        title: t.counts,
        columns: [
          column("number", t.number, "text"),
          column("float", t.float, "text"),
          column("countedAt", t.countedAt, "datetime"),
          column("book", t.book, "money"),
          column("counted", t.counted, "money"),
          column("variance", t.variance, "money"),
          column("status", t.status, "text"),
        ],
        rows: countRows,
        totals: null,
        notes: [],
      },
    ],
    notes: [t.note],
  };
}
