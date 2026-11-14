import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import {
  addCalendarDays,
  bucketForecast,
  expectedLpoPaymentDate,
  nairobiDate,
  projectPayroll,
  weekStartOf,
  type ForecastItem,
} from "@pm-buddy/domain";
import { SPENDING_READ_PERMISSIONS, type ForecastLineKind } from "@pm-buddy/types";
import {
  cashFlowItemResponseSchema,
  cashFlowItemsResponseSchema,
  forecastResponseSchema,
  type CreateCashFlowItemRequest,
  type ForecastLine,
} from "@pm-buddy/validation";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { loadCalendar } from "../payroll/batch-builder.js";
import { nextId } from "../procurement/catalogue-store.js";
import { peopleOf, personOf, toCalendarDate } from "../procurement/procurement-mappers.js";
import {
  minorOf,
  projectRef,
  SpendingAccess,
  spendingInvalidTransition,
  spendingProblem,
  spendingSettings,
  spendingVersionConflict,
  type Tx,
} from "./spending-common.js";

type ItemRow = Prisma.CashFlowItemGetPayload<object>;
const MANAGER = ["finance.manage"] as const;
const LINES_LIMIT = 500;
const date = (value: string) => new Date(`${value}T00:00:00.000Z`);

type Line = ForecastItem & {
  project: { id: string; code: string; name: string };
  document: ForecastLine["document"];
};

/**
 * Manual cash-flow lines and the weekly cash-flow forecast (D5.4, brief §5.8). The forecast is a
 * read model over recorded facts, never stored:
 * - payroll: live batches (submitted = recorded, draft = estimated) on their pay date, and later
 *   pay periods of the project's calendar at the latest submitted batch's run rate (estimated);
 *   the amount is gross pay plus the employer's statutory cost (conservative: deductions are
 *   remitted later). Past pay dates are assumed paid outside PM-Buddy until D4.3 records payouts;
 * - supplier invoices: approved, outstanding (incl. VAT) on their due date; overdue shown now;
 * - LPO commitments: approved LPOs not yet invoiced (incl. VAT) at delivery date (else approval
 *   date) + credit days (estimated);
 * - petty-cash top-ups requested or approved and not yet paid, now;
 * - manual lines: expected client receipts (until certificates exist, D6.3/D7.1) and other
 *   expected payments, on their expected date (overdue shown now).
 * The opening position is the company's entered opening cash moved by what was recorded since
 * (company view), or a project's recorded receipts − payments to date (derived).
 */
@Injectable()
export class CashFlowService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: SpendingAccess,
  ) {}

  // Manual lines ------------------------------------------------------------------------------

  items(
    principal: Principal,
    query: { projectId?: string; status?: string; cursor?: string; limit: number },
    req: Request,
  ) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const projectIds = await this.access.projectIds(
        scope,
        SPENDING_READ_PERMISSIONS,
        query.projectId,
      );
      const after = query.cursor
        ? await tx.cashFlowItem.findUnique({
            where: { tenantId_id: { tenantId: access.tenantId, id: query.cursor } },
            select: { id: true, expectedOn: true },
          })
        : null;
      const rows = await tx.cashFlowItem.findMany({
        where: {
          tenantId: access.tenantId,
          projectId: { in: projectIds },
          ...(query.status ? { status: query.status } : {}),
          ...(after
            ? {
                OR: [
                  { expectedOn: { gt: after.expectedOn } },
                  { expectedOn: after.expectedOn, id: { gt: after.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ expectedOn: "asc" }, { id: "asc" }],
        take: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      return cashFlowItemsResponseSchema.parse({
        items: await this.wire(scope, page),
        page: {
          hasMore: rows.length > query.limit,
          nextCursor: rows.length > query.limit ? page.at(-1)!.id : null,
        },
      });
    });
  }

  create(principal: Principal, input: CreateCashFlowItemRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        await this.access.require(scope, input.projectId, MANAGER, { writable: true });
        const id = nextId();
        await tx.cashFlowItem.create({
          data: {
            id,
            tenantId: access.tenantId,
            projectId: input.projectId,
            direction: input.direction,
            description: input.description,
            expectedOn: date(input.expectedOn),
            amountMinor: BigInt(input.amountMinor),
            reference: input.reference ?? null,
            createdBy: access.userId,
            updatedBy: access.userId,
          },
        });
        await this.scope.audit(tx, "cash_flow.item_created", id, {
          projectId: input.projectId,
          direction: input.direction,
        });
        return this.itemResponse(scope, id);
      },
      true,
    );
  }

  update(
    principal: Principal,
    id: string,
    action: "update" | "receive" | "cancel",
    input: {
      version: number;
      description?: string;
      expectedOn?: string;
      amountMinor?: number;
      reference?: string | null;
      receivedOn?: string;
      receivedMinor?: number;
    },
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const row = await this.row(scope, id);
        await this.access.require(scope, row.projectId, MANAGER, { writable: true });
        if (row.status !== "expected") throw spendingInvalidTransition(row.status);
        if (row.version !== input.version) throw spendingVersionConflict();
        if (action === "receive" && input.receivedOn! > nairobiDate())
          throw spendingProblem(
            400,
            "received-date-invalid",
            "Money is received on or before today",
          );
        await tx.cashFlowItem.update({
          where: { tenantId_id: { tenantId: access.tenantId, id } },
          data: {
            ...(action === "update"
              ? {
                  ...(input.description !== undefined ? { description: input.description } : {}),
                  ...(input.expectedOn !== undefined ? { expectedOn: date(input.expectedOn) } : {}),
                  ...(input.amountMinor !== undefined
                    ? { amountMinor: BigInt(input.amountMinor) }
                    : {}),
                  ...(input.reference !== undefined ? { reference: input.reference } : {}),
                }
              : action === "receive"
                ? {
                    status: "received",
                    receivedOn: date(input.receivedOn!),
                    receivedMinor: BigInt(input.receivedMinor!),
                    ...(input.reference !== undefined ? { reference: input.reference } : {}),
                  }
                : { status: "cancelled" }),
            updatedBy: access.userId,
            updatedAt: new Date(),
            version: { increment: 1 },
          },
        });
        await this.scope.audit(
          tx,
          `cash_flow.item_${action === "update" ? "updated" : action === "receive" ? "received" : "cancelled"}`,
          id,
          {
            projectId: row.projectId,
          },
        );
        return this.itemResponse(scope, id);
      },
      true,
    );
  }

  // Forecast ----------------------------------------------------------------------------------

  forecast(principal: Principal, projectId: string | undefined, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const settings = await spendingSettings(tx, access.tenantId);
      let projectIds: string[];
      let project: { id: string; code: string; name: string } | null = null;
      if (projectId) {
        const reader = await this.access.reader(scope, projectId);
        project = projectRef(reader.project);
        projectIds = [projectId];
      } else {
        if (!this.access.company(scope, SPENDING_READ_PERMISSIONS))
          throw new ForbiddenException("The company forecast needs a company-wide finance role");
        projectIds = await this.access.projectIds(scope, SPENDING_READ_PERMISSIONS);
      }
      const today = nairobiDate();
      const horizonEnd = addCalendarDays(weekStartOf(today), settings.forecastWeeks * 7 - 1);
      const lines: Line[] = [];
      for (const id of projectIds)
        lines.push(...(await this.projectLines(tx, access.tenantId, id, today, horizonEnd)));
      const opening = await this.opening(
        tx,
        access.tenantId,
        projectIds,
        projectId ? null : settings,
      );
      const forecast = bucketForecast(lines, today, settings.forecastWeeks, opening.amountMinor);
      const weekStart = weekStartOf(today);
      const sorted = [...lines].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      return forecastResponseSchema.parse({
        scope: projectId ? "project" : "company",
        project,
        today,
        opening,
        weeks: forecast.weeks,
        later: forecast.later,
        lines: sorted.slice(0, LINES_LIMIT).map((line) => ({
          kind: line.kind,
          direction: line.direction,
          date: line.date,
          amountMinor: line.amountMinor,
          basis: line.basis,
          overdue: line.date < weekStart,
          project: line.project,
          document: line.document,
        })),
        linesTruncated: sorted.length > LINES_LIMIT,
      });
    });
  }

  private async projectLines(
    tx: Tx,
    tenantId: string,
    projectId: string,
    today: string,
    until: string,
  ): Promise<Line[]> {
    const project = await tx.project.findUniqueOrThrow({
      where: { tenantId_id: { tenantId, id: projectId } },
      select: { id: true, code: true, name: true },
    });
    const ref = projectRef(project);
    const lines: Line[] = [];
    const push = (
      kind: ForecastLineKind,
      direction: "in" | "out",
      on: string,
      amountMinor: number,
      basis: "recorded" | "estimated",
      document: ForecastLine["document"],
    ) => {
      if (amountMinor > 0)
        lines.push({ kind, direction, date: on, amountMinor, basis, project: ref, document });
    };

    // Payroll: live batches and the calendar's later periods at the latest run rate.
    const batches = await tx.payrollBatch.findMany({
      where: { tenantId, projectId, status: { in: ["draft", "submitted"] } },
      orderBy: { periodStart: "desc" },
      select: {
        id: true,
        periodStart: true,
        payDate: true,
        status: true,
        grossMinor: true,
        employerCostMinor: true,
      },
    });
    const facts = batches.map((batch) => ({
      id: batch.id,
      periodStart: toCalendarDate(batch.periodStart),
      payDate: toCalendarDate(batch.payDate),
      amountMinor: minorOf(batch.grossMinor + batch.employerCostMinor),
      status: batch.status as "draft" | "submitted",
    }));
    const runRate = facts.find((batch) => batch.status === "submitted")?.amountMinor ?? null;
    const calendar = await loadCalendar(tx, tenantId, projectId);
    for (const item of projectPayroll({
      calendar,
      today,
      until,
      batches: facts,
      runRateMinor: runRate,
    })) {
      const batch = facts.find((entry) => entry.payDate === item.date);
      push("payroll", "out", item.date, item.amountMinor, item.basis, {
        kind: batch ? "payroll_batch" : "pay_period",
        id: batch?.id ?? null,
        label: batch ? `${batch.periodStart}` : item.date,
      });
    }

    // Supplier invoices approved and not fully paid: outstanding on the due date.
    const invoices = await tx.supplierInvoice.findMany({
      where: { tenantId, projectId, status: { in: ["approved", "partly_settled"] } },
      select: { id: true, invoiceNumber: true, dueDate: true, totalMinor: true },
    });
    const settled = await tx.invoiceSettlement.groupBy({
      by: ["invoiceId"],
      where: { tenantId, invoiceId: { in: invoices.map((invoice) => invoice.id) } },
      _sum: { amountMinor: true },
    });
    for (const invoice of invoices) {
      const paid = settled.find((row) => row.invoiceId === invoice.id)?._sum.amountMinor ?? 0n;
      push(
        "supplier_invoices",
        "out",
        toCalendarDate(invoice.dueDate),
        minorOf(invoice.totalMinor - paid),
        "recorded",
        {
          kind: "invoice",
          id: invoice.id,
          label: invoice.invoiceNumber,
        },
      );
    }

    // Approved LPOs not yet invoiced (incl. VAT), expected at delivery + credit days.
    const lpos = await tx.lpo.findMany({
      where: { tenantId, projectId, status: "approved" },
      select: {
        id: true,
        number: true,
        totalMinor: true,
        deliveryDate: true,
        approvedAt: true,
        creditDays: true,
        invoices: {
          where: { status: { in: ["approved", "partly_settled", "settled"] } },
          select: { totalMinor: true },
        },
      },
    });
    for (const lpo of lpos) {
      const invoiced = lpo.invoices.reduce((sum, invoice) => sum + invoice.totalMinor, 0n);
      const open = lpo.totalMinor - invoiced;
      if (open <= 0n) continue;
      push(
        "lpo_commitments",
        "out",
        expectedLpoPaymentDate({
          deliveryDate: lpo.deliveryDate ? toCalendarDate(lpo.deliveryDate) : null,
          approvedOn: nairobiDate(lpo.approvedAt ?? new Date()),
          creditDays: lpo.creditDays,
        }),
        minorOf(open),
        "estimated",
        { kind: "lpo", id: lpo.id, label: lpo.number },
      );
    }

    // Petty-cash top-ups not yet paid.
    const topUps = await tx.pettyCashTopUp.findMany({
      where: { tenantId, projectId, status: { in: ["requested", "approved"] } },
      select: { id: true, number: true, amountMinor: true, status: true },
    });
    for (const topUp of topUps)
      push(
        "petty_cash_top_ups",
        "out",
        today,
        minorOf(topUp.amountMinor),
        topUp.status === "approved" ? "recorded" : "estimated",
        {
          kind: "top_up",
          id: topUp.id,
          label: topUp.number,
        },
      );

    // Manual lines still expected.
    const items = await tx.cashFlowItem.findMany({
      where: { tenantId, projectId, status: "expected" },
      select: { id: true, direction: true, description: true, expectedOn: true, amountMinor: true },
    });
    for (const item of items)
      push(
        item.direction === "in" ? "client_receipts" : "other_payments",
        item.direction as "in" | "out",
        toCalendarDate(item.expectedOn),
        minorOf(item.amountMinor),
        "recorded",
        { kind: "cash_flow_item", id: item.id, label: item.description },
      );
    return lines;
  }

  /** The opening cash position (see the class comment). */
  private async opening(
    tx: Tx,
    tenantId: string,
    projectIds: string[],
    company: { openingCashMinor: number | null; openingCashOn: string | null } | null,
  ) {
    const since = company?.openingCashOn ?? null;
    const sinceDate = since ? date(since) : undefined;
    const [received, settled, topUps] = await Promise.all([
      tx.cashFlowItem.aggregate({
        where: {
          tenantId,
          projectId: { in: projectIds },
          status: "received",
          ...(sinceDate ? { receivedOn: { gte: sinceDate } } : {}),
        },
        _sum: { receivedMinor: true },
      }),
      tx.invoiceSettlement.aggregate({
        where: {
          tenantId,
          payable: { invoice: { projectId: { in: projectIds } } },
          ...(sinceDate ? { paidOn: { gte: sinceDate } } : {}),
        },
        _sum: { amountMinor: true },
      }),
      tx.pettyCashTopUp.aggregate({
        where: {
          tenantId,
          projectId: { in: projectIds },
          status: "paid",
          ...(sinceDate ? { paidOn: { gte: sinceDate } } : {}),
        },
        _sum: { amountMinor: true },
      }),
    ]);
    const receivedSinceMinor = minorOf(received._sum.receivedMinor ?? 0n);
    const paidSinceMinor =
      minorOf(settled._sum.amountMinor ?? 0n) + minorOf(topUps._sum.amountMinor ?? 0n);
    if (!company)
      return {
        basis: "derived" as const,
        amountMinor: receivedSinceMinor - paidSinceMinor,
        enteredMinor: null,
        enteredOn: null,
        receivedSinceMinor,
        paidSinceMinor,
      };
    if (company.openingCashMinor === null)
      return {
        basis: "none" as const,
        amountMinor: null,
        enteredMinor: null,
        enteredOn: null,
        receivedSinceMinor,
        paidSinceMinor,
      };
    return {
      basis: "entered" as const,
      amountMinor: company.openingCashMinor + receivedSinceMinor - paidSinceMinor,
      enteredMinor: company.openingCashMinor,
      enteredOn: company.openingCashOn,
      receivedSinceMinor,
      paidSinceMinor,
    };
  }

  // Helpers -----------------------------------------------------------------------------------

  private async row(scope: Scope, id: string): Promise<ItemRow> {
    const row = await scope.tx.cashFlowItem.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id } },
    });
    if (!row) throw new NotFoundException("Cash-flow line not found");
    return row;
  }

  private async itemResponse(scope: Scope, id: string) {
    const [item] = await this.wire(scope, [await this.row(scope, id)]);
    return cashFlowItemResponseSchema.parse({ item });
  }

  private async wire(scope: Scope, rows: ItemRow[]) {
    const { tx, access } = scope;
    if (!rows.length) return [];
    const [projects, people] = await Promise.all([
      tx.project.findMany({
        where: { tenantId: access.tenantId, id: { in: rows.map((row) => row.projectId) } },
        select: { id: true, code: true, name: true },
      }),
      peopleOf(
        tx,
        rows.map((row) => row.createdBy),
      ),
    ]);
    const wired = [];
    for (const row of rows) {
      const project = await this.access.on(scope, row.projectId);
      wired.push({
        id: row.id,
        project: projectRef(projects.find((entry) => entry.id === row.projectId)!),
        direction: row.direction as "in" | "out",
        description: row.description,
        expectedOn: toCalendarDate(row.expectedOn),
        amountMinor: minorOf(row.amountMinor),
        status: row.status as "expected" | "received" | "cancelled",
        receivedOn: row.receivedOn ? toCalendarDate(row.receivedOn) : null,
        receivedMinor: row.receivedMinor === null ? null : minorOf(row.receivedMinor),
        reference: row.reference,
        createdBy: personOf(people, row.createdBy),
        createdAt: row.createdAt.toISOString(),
        version: row.version,
        permissions: {
          canEdit: this.access.can(project, MANAGER) && row.status === "expected",
        },
      });
    }
    return wired;
  }
}
