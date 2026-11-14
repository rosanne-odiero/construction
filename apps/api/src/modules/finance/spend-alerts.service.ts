import { Injectable } from "@nestjs/common";
import type { Request } from "express";
import {
  addCalendarDays,
  budgetLevel,
  counterpartyKey,
  duplicatePayments,
  nairobiDate,
  percentOf,
  sumFigures,
  unusualSpend,
  type PaymentFact,
} from "@pm-buddy/domain";
import {
  COST_CATEGORIES,
  SPEND_ALERT_KINDS,
  SPENDING_LIMITS,
  SPENDING_READ_PERMISSIONS,
  type SpendAlertKind,
} from "@pm-buddy/types";
import { spendAlertsResponseSchema, type SpendAlert } from "@pm-buddy/validation";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { toCalendarDate } from "../procurement/procurement-mappers.js";
import {
  minorOf,
  projectRef,
  SpendingAccess,
  spendingSettings,
  type SpendingSettingsValues,
} from "./spending-common.js";
import {
  itemFigures,
  loadProjectFacts,
  projectTotals,
  SpendingReportService,
} from "./spending-report.service.js";

type ProjectRef = { id: string; code: string; name: string };
const SEVERITY_ORDER = { critical: 0, warning: 1 } as const;

/**
 * Spend alerts (D5.4, brief §5.8): in-app review signals computed on read from recorded facts (no
 * notifications before Phase 8; nothing is blocked or changed by an alert):
 * - `budget_threshold`: actual + committed reaches the configured % of the budget in force for
 *   the project, a category or a bill (warning), or exceeds it (critical);
 * - `unusual_spend`: an expense above the multiplier × the median of the float's earlier expenses
 *   (at least the minimum number of them; packages/domain unusualSpend);
 * - `duplicate_payment`: two payments with the same M-Pesa code or reference (critical), or the
 *   same counterparty and amount within the window (warning), across expenses, supplier
 *   settlements and top-ups of the projects the caller can see;
 * - `missing_documents`: an expense without a receipt photo, or a supplier settlement whose
 *   invoice has no document attached.
 * Expenses and settlements are looked at for the last SPENDING_LIMITS.alertLookbackDays days.
 */
@Injectable()
export class SpendAlertsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: SpendingAccess,
    private readonly report: SpendingReportService,
  ) {}

  list(
    principal: Principal,
    query: { projectId?: string; kind?: SpendAlertKind; cursor?: string; limit: number },
    req: Request,
  ) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      if (query.projectId) await this.access.reader(scope, query.projectId);
      const projectIds = await this.access.projectIds(
        scope,
        SPENDING_READ_PERMISSIONS,
        query.projectId,
      );
      const settings = await spendingSettings(tx, access.tenantId);
      const projects = await tx.project.findMany({
        where: { tenantId: access.tenantId, id: { in: projectIds } },
        select: { id: true, code: true, name: true },
      });
      const refs = new Map(projects.map((project) => [project.id, projectRef(project)]));
      const alerts = [
        ...(await this.budgetAlerts(scope, projects, settings)),
        ...(await this.paymentAlerts(scope, refs, settings)),
      ];
      alerts.sort(
        (a, b) =>
          SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
          (a.detectedOn < b.detectedOn ? 1 : a.detectedOn > b.detectedOn ? -1 : 0) ||
          (a.id < b.id ? -1 : 1),
      );
      const counts = Object.fromEntries(
        SPEND_ALERT_KINDS.map((kind) => [
          kind,
          alerts.filter((alert) => alert.kind === kind).length,
        ]),
      );
      const filtered = query.kind ? alerts.filter((alert) => alert.kind === query.kind) : alerts;
      const offset = query.cursor ? Number(query.cursor) : 0;
      const page = filtered.slice(offset, offset + query.limit);
      return spendAlertsResponseSchema.parse({
        alerts: page,
        counts,
        page: {
          hasMore: filtered.length > offset + query.limit,
          nextCursor: filtered.length > offset + query.limit ? String(offset + query.limit) : null,
        },
      });
    });
  }

  private async budgetAlerts(
    scope: Scope,
    projects: ProjectRef[],
    settings: SpendingSettingsValues,
  ): Promise<SpendAlert[]> {
    const { tx, access } = scope;
    const today = nairobiDate();
    const threshold = settings.budgetAlertPercent;
    const alerts: SpendAlert[] = [];
    for (const project of projects) {
      const facts = await loadProjectFacts(tx, access.tenantId, project.id);
      if (!facts.budget) continue;
      const add = (
        scopeOf: {
          kind: "project" | "category" | "bill";
          category: string | null;
          bill: { lineageId: string; number: string; title: string } | null;
        },
        used: number,
        budget: number | null,
        key: string,
      ) => {
        const level = budgetLevel(used, budget, threshold);
        if (level !== "threshold" && level !== "over") return;
        alerts.push({
          id: `budget_threshold:${project.id}:${key}`,
          kind: "budget_threshold",
          severity: level === "over" ? "critical" : "warning",
          project,
          detectedOn: today,
          amountMinor: used,
          scope: scopeOf as SpendAlert["scope"],
          figures: {
            usedMinor: used,
            budgetMinor: budget!,
            usedPercent: percentOf(used, budget)!,
            thresholdPercent: threshold,
          },
          typical: null,
          rule: null,
          records: [],
        });
      };
      const totals = projectTotals(facts);
      add(
        { kind: "project", category: null, bill: null },
        totals.actualMinor + totals.committedMinor,
        totals.budgetMinor,
        "project",
      );
      for (const category of COST_CATEGORIES) {
        const lines = facts.budgetLines.filter((line) => line.category === category);
        if (!lines.length) continue;
        const budget = lines.reduce((sum, line) => sum + line.amountMinor, 0);
        let used = 0;
        for (const entry of facts.entries)
          if (entry.category === category && entry.measure === "accrued") used += entry.sum;
        if (category === "materials")
          for (const commitment of facts.commitments) used += commitment.open;
        add({ kind: "category", category, bill: null }, used, budget, `category:${category}`);
      }
      const bills = await this.report.billsOf(scope, project.id, itemFigures(facts), facts);
      for (const bill of bills) {
        const figures = sumFigures([bill.figures]);
        if (figures.budgetMinor === null) continue;
        add(
          { kind: "bill", category: null, bill: bill.bill },
          figures.actualMinor + figures.committedMinor,
          figures.budgetMinor,
          `bill:${bill.bill.lineageId}`,
        );
      }
    }
    return alerts;
  }

  private async paymentAlerts(
    scope: Scope,
    refs: Map<string, ProjectRef>,
    settings: SpendingSettingsValues,
  ): Promise<SpendAlert[]> {
    const { tx, access } = scope;
    const projectIds = [...refs.keys()];
    if (!projectIds.length) return [];
    const since = new Date(
      `${addCalendarDays(nairobiDate(), -SPENDING_LIMITS.alertLookbackDays)}T00:00:00.000Z`,
    );
    const [expenses, settlements, topUps] = await Promise.all([
      tx.pettyCashExpense.findMany({
        where: {
          tenantId: access.tenantId,
          projectId: { in: projectIds },
          status: { not: "rejected" },
          spentOn: { gte: since },
        },
        orderBy: [{ recordedAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          number: true,
          projectId: true,
          floatId: true,
          spentOn: true,
          amountMinor: true,
          chargeMinor: true,
          supplierId: true,
          payeeName: true,
          payeeAccount: true,
          mpesaCode: true,
          recordedAt: true,
          _count: { select: { receipts: true } },
        },
      }),
      tx.invoiceSettlement.findMany({
        where: {
          tenantId: access.tenantId,
          paidOn: { gte: since },
          payable: { invoice: { projectId: { in: projectIds } } },
        },
        select: {
          id: true,
          amountMinor: true,
          paidOn: true,
          recordedAt: true,
          referenceKey: true,
          invoiceId: true,
          payable: {
            select: {
              invoice: {
                select: {
                  invoiceNumber: true,
                  projectId: true,
                  supplierId: true,
                  _count: { select: { documents: true } },
                },
              },
            },
          },
        },
      }),
      tx.pettyCashTopUp.findMany({
        where: {
          tenantId: access.tenantId,
          projectId: { in: projectIds },
          status: "paid",
          paidOn: { gte: since },
        },
        select: {
          id: true,
          number: true,
          projectId: true,
          amountMinor: true,
          paidOn: true,
          paidAt: true,
          referenceKey: true,
        },
      }),
    ]);
    const alerts: SpendAlert[] = [];
    const base = {
      scope: null,
      figures: null,
      typical: null,
      rule: null,
    };

    // Unusual spend: each expense against the float's earlier ones.
    const byFloat = new Map<string, number[]>();
    for (const expense of expenses) {
      const earlier = byFloat.get(expense.floatId) ?? [];
      const amount = minorOf(expense.amountMinor);
      const result = unusualSpend(
        amount,
        earlier.slice(-SPENDING_LIMITS.unusualSpendWindow),
        settings.unusualSpendMultiplier,
        settings.unusualSpendMinSamples,
      );
      if (result.unusual)
        alerts.push({
          ...base,
          id: `unusual_spend:${expense.id}`,
          kind: "unusual_spend",
          severity: "warning",
          project: refs.get(expense.projectId)!,
          detectedOn: toCalendarDate(expense.spentOn),
          amountMinor: amount,
          typical: {
            medianMinor: result.medianMinor!,
            multiplier: settings.unusualSpendMultiplier,
            samples: result.samples,
          },
          records: [
            {
              kind: "expense",
              id: expense.id,
              label: expense.number,
              date: toCalendarDate(expense.spentOn),
              amountMinor: amount,
            },
          ],
        });
      earlier.push(amount);
      byFloat.set(expense.floatId, earlier);
    }

    // Duplicate payments across expenses, settlements and top-ups.
    const labels = new Map<string, { label: string; kind: "expense" | "settlement" | "top_up" }>();
    const facts: PaymentFact[] = [];
    for (const expense of expenses) {
      labels.set(expense.id, { label: expense.number, kind: "expense" });
      facts.push({
        id: expense.id,
        source: "expense",
        projectId: expense.projectId,
        counterparty: counterpartyKey({
          supplierId: expense.supplierId,
          account: expense.payeeAccount,
          name: expense.payeeName,
        }),
        amountMinor: minorOf(expense.amountMinor),
        date: toCalendarDate(expense.spentOn),
        reference: expense.mpesaCode,
        recordedAt: expense.recordedAt.toISOString(),
      });
    }
    for (const settlement of settlements) {
      const invoice = settlement.payable.invoice;
      labels.set(settlement.id, { label: invoice.invoiceNumber, kind: "settlement" });
      facts.push({
        id: settlement.id,
        source: "settlement",
        projectId: invoice.projectId,
        counterparty: counterpartyKey({ supplierId: invoice.supplierId }),
        amountMinor: minorOf(settlement.amountMinor),
        date: toCalendarDate(settlement.paidOn),
        reference: settlement.referenceKey,
        recordedAt: settlement.recordedAt.toISOString(),
      });
    }
    for (const topUp of topUps) {
      labels.set(topUp.id, { label: topUp.number, kind: "top_up" });
      facts.push({
        id: topUp.id,
        source: "top_up",
        projectId: topUp.projectId,
        counterparty: null,
        amountMinor: minorOf(topUp.amountMinor),
        date: toCalendarDate(topUp.paidOn!),
        reference: topUp.referenceKey,
        recordedAt: topUp.paidAt?.toISOString(),
      });
    }
    for (const pair of duplicatePayments(facts, settings.duplicateWindowDays)) {
      const record = (fact: PaymentFact) => ({
        kind: labels.get(fact.id)!.kind,
        id: fact.id,
        label: labels.get(fact.id)!.label,
        date: fact.date,
        amountMinor: fact.amountMinor,
      });
      alerts.push({
        ...base,
        id: `duplicate_payment:${pair.first.id}:${pair.second.id}`,
        kind: "duplicate_payment",
        severity: pair.rule === "same_reference" ? "critical" : "warning",
        project: refs.get(pair.second.projectId)!,
        detectedOn: pair.second.date,
        amountMinor: pair.second.amountMinor,
        rule: pair.rule,
        records: [record(pair.first), record(pair.second)],
      });
    }

    // Payments without supporting documents.
    for (const expense of expenses)
      if (expense._count.receipts === 0)
        alerts.push({
          ...base,
          id: `missing_documents:expense:${expense.id}`,
          kind: "missing_documents",
          severity: "warning",
          project: refs.get(expense.projectId)!,
          detectedOn: nairobiDate(expense.recordedAt),
          amountMinor: minorOf(expense.amountMinor + expense.chargeMinor),
          records: [
            {
              kind: "expense",
              id: expense.id,
              label: expense.number,
              date: toCalendarDate(expense.spentOn),
              amountMinor: minorOf(expense.amountMinor),
            },
          ],
        });
    for (const settlement of settlements) {
      const invoice = settlement.payable.invoice;
      if (invoice._count.documents > 0) continue;
      alerts.push({
        ...base,
        id: `missing_documents:settlement:${settlement.id}`,
        kind: "missing_documents",
        severity: "warning",
        project: refs.get(invoice.projectId)!,
        detectedOn: toCalendarDate(settlement.paidOn),
        amountMinor: minorOf(settlement.amountMinor),
        records: [
          {
            kind: "invoice",
            id: settlement.invoiceId,
            label: invoice.invoiceNumber,
            date: toCalendarDate(settlement.paidOn),
            amountMinor: minorOf(settlement.amountMinor),
          },
        ],
      });
    }
    return alerts;
  }
}
