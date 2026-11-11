import { Injectable, NotFoundException } from "@nestjs/common";
import {
  addCalendarDays,
  isPeriodStart,
  nairobiDate,
  payPeriodFor,
  payPeriodsBetween,
  normaliseDecimal,
} from "@pm-buddy/domain";
import type { DayType, EmployeeStatutory, EmployerCost, Permission } from "@pm-buddy/types";
import {
  batchDetailResponseSchema,
  batchSnapshotResponseSchema,
  payrollOverviewResponseSchema,
  payslipResponseSchema,
  projectPayrollResponseSchema,
  type batchActionRequestSchema,
  type cancelBatchRequestSchema,
  type createBatchRequestSchema,
  type PayPeriodRow,
  type PayrollExclusion,
  type PayrollTotals,
} from "@pm-buddy/validation";
import type { Request } from "express";
import type { z } from "zod";
import { uuidv7 } from "../../common/uuid.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { displayNames } from "../labour/labour-mappers.js";
import { fromCalendarDate, toCalendarDate } from "../projects/project-mappers.js";
import {
  BatchBuilder,
  loadCalendar,
  type BatchTarget,
  type ProjectCalendar,
} from "./batch-builder.js";
import { batchNames, toBatch, toLineSummary, type BatchRow } from "./payroll-mappers.js";
import {
  PAYROLL_VIEW,
  PayrollAccess,
  PayrollCommands,
  money,
  payrollBadRequest,
  payrollConflict,
  versionConflict,
} from "./payroll-support.js";

type Tx = Prisma.TransactionClient;
type ProjectRow = Prisma.ProjectGetPayload<object>;

const LOOKBACK_DAYS = { daily: 14, weekly: 63, fortnightly: 112, monthly: 120 } as const;

/**
 * Payroll batches (D4.1, WORKFLOWS "Payroll"): the builder per project and pay period, the draft
 * (recalculated freely, expected versions), submission into an immutable snapshot bound to its
 * digest, cancellation, payslips and the snapshot integrity check. Production refuses to submit a
 * batch computed with unverified rules (COMPLIANCE-REVIEW); development marks it "not for filing".
 * Review, approval and payout are D4.3.
 */
@Injectable()
export class PayrollBatchesService {
  constructor(
    private readonly access: PayrollAccess,
    private readonly commands: PayrollCommands,
    private readonly builder: BatchBuilder,
  ) {}

  overview(principal: Principal, req: Request) {
    return this.commands.read(principal, req, async (scope) => {
      const { tx, access } = scope;
      const projects = await this.access.projects(scope, PAYROLL_VIEW);
      const preparable = await this.access.projectsWithAny(scope, ["payroll.prepare"]);
      const today = nairobiDate();
      const rows = [];
      for (const project of projects) {
        const calendar = await loadCalendar(tx, access.tenantId, project.id);
        const [current] = await this.periodRows(scope, project, calendar, [
          payPeriodFor(today, calendar),
        ]);
        const counts = await tx.payrollBatch.groupBy({
          by: ["status"],
          where: { tenantId: access.tenantId, projectId: project.id },
          _count: { _all: true },
        });
        rows.push({
          project: { id: project.id, code: project.code, name: project.name },
          calendar,
          current: current!,
          drafts: counts.find((entry) => entry.status === "draft")?._count._all ?? 0,
          submitted: counts.find((entry) => entry.status === "submitted")?._count._all ?? 0,
          canPrepare: preparable === "all" || preparable.includes(project.id),
        });
      }
      const has = (permission: Permission) => access.permissions.has(permission);
      if (!rows.length)
        await this.access.companyAny(scope, [
          ...PAYROLL_VIEW,
          "payroll.export",
          "payroll.manage_rules",
          "payroll.verify_rules",
          "advances.request",
          "advances.approve",
        ]);
      return payrollOverviewResponseSchema.parse({
        today,
        production: this.access.production,
        unverifiedRuleVersions: await tx.statutoryRuleVersion.count({
          where: { tenantId: access.tenantId, status: "unverified" },
        }),
        projects: rows,
        permissions: {
          canViewRules:
            rows.length > 0 || has("payroll.manage_rules") || has("payroll.verify_rules"),
          canExport: has("payroll.export"),
          canSeeAdvances: (
            ["advances.request", "advances.approve", ...PAYROLL_VIEW] as Permission[]
          ).some(has),
          canConfigure: has("config.manage"),
        },
      });
    });
  }

  project(principal: Principal, projectId: string, req: Request) {
    return this.commands.read(principal, req, (scope) => this.projectView(scope, projectId));
  }

  private async projectView(scope: Scope, projectId: string) {
    const { tx, access } = scope;
    const { project, effective } = await this.access.project(scope, projectId, PAYROLL_VIEW);
    const calendar = await loadCalendar(tx, access.tenantId, projectId);
    const today = nairobiDate();
    let from = addCalendarDays(today, -LOOKBACK_DAYS[calendar.frequency]);
    if (from < calendar.anchorDate) from = calendar.anchorDate;
    const periods = payPeriodsBetween(from, today, calendar).reverse();
    const batches = await tx.payrollBatch.findMany({
      where: { tenantId: access.tenantId, projectId },
      orderBy: [{ periodStart: "desc" }, { createdAt: "desc" }],
      take: 100,
    });
    const names = await displayNames(tx, batches.flatMap(batchNames));
    return projectPayrollResponseSchema.parse({
      project: { id: project.id, code: project.code, name: project.name },
      today,
      calendar,
      periods: await this.periodRows(scope, project, calendar, periods),
      batches: batches.map((row) => toBatch(row, names)),
      permissions: {
        canPrepare: effective.has("payroll.prepare"),
        canRecordOutput: effective.has("attendance.record") || effective.has("payroll.prepare"),
        canDecideOutput: effective.has("timesheets.approve"),
      },
    });
  }

  private async periodRows(
    scope: Scope,
    project: ProjectRow,
    calendar: ProjectCalendar,
    periods: { startDate: string; endDate: string; payDate: string }[],
  ): Promise<PayPeriodRow[]> {
    const { tx, access } = scope;
    const today = nairobiDate();
    const rows: PayPeriodRow[] = [];
    for (const period of periods) {
      const live = await tx.payrollBatch.findFirst({
        where: {
          tenantId: access.tenantId,
          projectId: project.id,
          periodStart: fromCalendarDate(period.startDate),
          activeMarker: "active",
        },
      });
      const timesheets = await tx.timesheetPeriod.groupBy({
        by: ["status"],
        where: {
          tenantId: access.tenantId,
          projectId: project.id,
          endDate: {
            gte: fromCalendarDate(period.startDate),
            lte: fromCalendarDate(period.endDate),
          },
        },
        _count: { _all: true },
      });
      const names = live ? await displayNames(tx, batchNames(live)) : new Map<string, string>();
      rows.push({
        ...period,
        ended: period.endDate <= today,
        batch: live ? toBatch(live, names) : null,
        timesheetPeriods: {
          approved: timesheets.find((entry) => entry.status === "approved")?._count._all ?? 0,
          notApproved: timesheets
            .filter((entry) => entry.status !== "approved")
            .reduce((sum, entry) => sum + entry._count._all, 0),
        },
      });
    }
    return rows;
  }

  create(
    principal: Principal,
    projectId: string,
    input: z.output<typeof createBatchRequestSchema>,
    req: Request,
  ) {
    return this.commands.run(
      principal,
      req,
      "payroll.batch.create",
      { projectId, input },
      async (scope) => {
        const { tx, access } = scope;
        const { project } = await this.access.project(scope, projectId, ["payroll.prepare"]);
        this.access.assertWritable(project);
        const calendar = await loadCalendar(tx, access.tenantId, projectId);
        if (!isPeriodStart(input.periodStart, calendar))
          throw payrollBadRequest(
            "period-not-in-calendar",
            "That date does not start a pay period of this project's calendar.",
          );
        if (input.periodStart > nairobiDate())
          throw payrollConflict("period-not-started", "The pay period has not started yet.");
        const period = payPeriodFor(input.periodStart, calendar);
        const overlapping = await tx.payrollBatch.findFirst({
          where: {
            tenantId: access.tenantId,
            projectId,
            activeMarker: "active",
            periodStart: { lte: fromCalendarDate(period.endDate) },
            periodEnd: { gte: fromCalendarDate(period.startDate) },
          },
        });
        if (overlapping)
          throw payrollConflict(
            overlapping.periodStart.getTime() === fromCalendarDate(period.startDate).getTime()
              ? "batch-exists"
              : "period-overlap",
            "A live batch already covers this pay period.",
          );
        const target: BatchTarget = {
          id: uuidv7(),
          projectId,
          periodStart: period.startDate,
          periodEnd: period.endDate,
          payDate: period.payDate,
          frequency: calendar.frequency,
        };
        const built = await this.builder.compute(
          tx,
          access.tenantId,
          target,
          calendar,
          this.access.production,
        );
        await this.builder.persist(tx, access.tenantId, access.userId, built, null);
        await this.commands.audit(scope, "payroll.batch_created", target.id, {
          projectId,
          periodStart: target.periodStart,
          periodEnd: target.periodEnd,
          lines: built.result.lines.length,
          exclusions: built.result.exclusions.length,
          unverifiedRules: built.result.unverified,
          digest: built.digest,
        });
        return this.view(scope, await this.batch(tx, access.tenantId, target.id));
      },
    );
  }

  detail(principal: Principal, batchId: string, req: Request) {
    return this.commands.read(principal, req, async (scope) =>
      this.view(scope, await this.batch(scope.tx, scope.access.tenantId, batchId)),
    );
  }

  recalculate(
    principal: Principal,
    batchId: string,
    input: z.output<typeof batchActionRequestSchema>,
    req: Request,
  ) {
    return this.commands.run(
      principal,
      req,
      "payroll.batch.recalculate",
      { batchId, input },
      async (scope) => {
        const { tx, access } = scope;
        const row = await this.preparable(scope, batchId, input.version);
        const built = await this.compute(scope, row);
        await this.builder.persist(tx, access.tenantId, access.userId, built, row.version);
        await this.commands.audit(scope, "payroll.batch_recalculated", batchId, {
          projectId: row.projectId,
          lines: built.result.lines.length,
          exclusions: built.result.exclusions.length,
          unverifiedRules: built.result.unverified,
          digest: built.digest,
          changed: built.digest !== row.digest,
        });
        return this.view(scope, await this.batch(tx, access.tenantId, batchId));
      },
    );
  }

  /**
   * draft → submitted: recomputes the batch and refuses unless the result is exactly what was last
   * calculated and reviewed (same digest), so the frozen snapshot is the one the preparer saw.
   */
  submit(
    principal: Principal,
    batchId: string,
    input: z.output<typeof batchActionRequestSchema>,
    req: Request,
  ) {
    return this.commands.run(
      principal,
      req,
      "payroll.batch.submit",
      { batchId, input },
      async (scope) => {
        const { tx, access } = scope;
        const row = await this.preparable(scope, batchId, input.version);
        // COMPLIANCE-REVIEW (INVARIANTS): unverified legal rules cannot drive production payroll.
        if (row.unverifiedRules && this.access.production)
          throw payrollConflict(
            "rules-unverified",
            "This batch uses rule versions that a compliance reviewer has not verified.",
          );
        const built = await this.compute(scope, row);
        if (built.digest !== row.digest)
          throw payrollConflict(
            "batch-stale",
            "Inputs changed since the last calculation. Recalculate and review before submitting.",
          );
        if (!row.lineCount)
          throw payrollConflict("batch-empty", "There is nothing to pay in this batch.");
        const updated = await tx.payrollBatch.updateMany({
          where: { tenantId: access.tenantId, id: batchId, version: row.version, status: "draft" },
          data: { status: "submitted", submittedBy: access.userId, version: { increment: 1 } },
        });
        if (!updated.count) throw versionConflict();
        await this.commands.audit(scope, "payroll.batch_submitted", batchId, {
          projectId: row.projectId,
          lines: row.lineCount,
          digest: row.digest,
          unverifiedRules: row.unverifiedRules,
        });
        await this.commands.outbox(scope, "payroll.batch_submitted", batchId, {
          projectId: row.projectId,
          version: row.version + 1,
          digest: row.digest,
          lines: row.lineCount,
          payDate: toCalendarDate(row.payDate),
          statutoryMonth: row.statutoryMonth,
          unverifiedRules: row.unverifiedRules,
        });
        return this.view(scope, await this.batch(tx, access.tenantId, batchId));
      },
    );
  }

  cancel(
    principal: Principal,
    batchId: string,
    input: z.output<typeof cancelBatchRequestSchema>,
    req: Request,
  ) {
    return this.commands.run(
      principal,
      req,
      "payroll.batch.cancel",
      { batchId, input },
      async (scope) => {
        const { tx, access } = scope;
        const row = await this.batch(tx, access.tenantId, batchId);
        await this.access.project(scope, row.projectId, ["payroll.prepare"]);
        if (row.version !== input.version) throw versionConflict();
        if (row.status === "cancelled")
          throw payrollConflict("invalid-transition", "This batch is already cancelled.");
        const updated = await tx.payrollBatch.updateMany({
          where: { tenantId: access.tenantId, id: batchId, version: row.version },
          data: {
            status: "cancelled",
            cancelledBy: access.userId,
            cancellationReason: input.reason,
            version: { increment: 1 },
          },
        });
        if (!updated.count) throw versionConflict();
        // Releasing the sources and day claims lets a new batch pay them (the marker rule).
        await tx.payrollConsumption.updateMany({
          where: { tenantId: access.tenantId, batchId, activeMarker: "active" },
          data: { activeMarker: null },
        });
        await tx.payrollDayClaim.updateMany({
          where: { tenantId: access.tenantId, batchId, activeMarker: "active" },
          data: { activeMarker: null },
        });
        await this.commands.audit(scope, "payroll.batch_cancelled", batchId, {
          projectId: row.projectId,
          from: row.status,
          reasonGiven: true,
        });
        await this.commands.outbox(scope, "payroll.batch_cancelled", batchId, {
          projectId: row.projectId,
          from: row.status,
        });
        return this.view(scope, await this.batch(tx, access.tenantId, batchId));
      },
    );
  }

  payslip(principal: Principal, batchId: string, lineId: string, req: Request) {
    return this.commands.read(principal, req, async (scope) => {
      const { tx, access } = scope;
      const batch = await this.batch(tx, access.tenantId, batchId);
      const { project } = await this.access.project(scope, batch.projectId, PAYROLL_VIEW);
      const found = await tx.payrollLine.findFirst({
        where: { tenantId: access.tenantId, batchId, id: lineId },
      });
      if (!found) throw new NotFoundException("Payslip not found");
      const line = {
        ...found,
        earnings: await tx.payrollEarning.findMany({
          where: { tenantId: access.tenantId, lineId },
          orderBy: { position: "asc" },
        }),
        deductions: await tx.payrollDeduction.findMany({
          where: { tenantId: access.tenantId, lineId },
        }),
        recoveries: await tx.advanceRecovery.findMany({
          where: { tenantId: access.tenantId, lineId },
        }),
      };
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: access.tenantId } });
      const names = await displayNames(tx, batchNames(batch));
      const advances = await tx.salaryAdvance.findMany({
        where: { tenantId: access.tenantId, labourerId: line.labourerId, status: "disbursed" },
      });
      const recoveries = advances.length
        ? await tx.advanceRecovery.findMany({
            where: { tenantId: access.tenantId, advanceId: { in: advances.map((row) => row.id) } },
          })
        : [];
      const submittedBatches = new Set(
        (
          await tx.payrollBatch.findMany({
            where: {
              tenantId: access.tenantId,
              id: { in: [...new Set(recoveries.map((row) => row.batchId))] },
              status: "submitted",
            },
            select: { id: true },
          })
        ).map((row) => row.id),
      );
      const advanceBalanceMinor = advances.reduce((sum, advance) => {
        const own = line.recoveries.find((entry) => entry.advanceId === advance.id);
        if (own) return sum + money(own.outstandingAfterMinor);
        const recovered = recoveries
          .filter((entry) => entry.advanceId === advance.id && submittedBatches.has(entry.batchId))
          .reduce((total, entry) => total + money(entry.amountMinor), 0);
        return sum + money(advance.amountMinor) - recovered;
      }, 0);
      const mtd = line.monthToDate as unknown as {
        statutoryMonth: string;
        priorBatchIds: string[];
        prior: { baseMinor: number };
        cumulativeBaseMinor: number;
        monthly: {
          employee: Record<EmployeeStatutory, number>;
          taxablePayMinor: number;
          payeBeforeReliefMinor: number;
          personalReliefMinor: number;
        };
      };
      return payslipResponseSchema.parse({
        company: tenant.name,
        project: { id: project.id, code: project.code, name: project.name },
        batch: toBatch(batch, names),
        line: {
          ...toLineSummary(line),
          trade:
            line.tradeNameEn && line.tradeNameSw
              ? { nameEn: line.tradeNameEn, nameSw: line.tradeNameSw }
              : null,
          earnings: line.earnings.map((row) => ({
            kind: row.kind,
            category: (row.category as DayType | null) ?? null,
            date: row.workDate ? toCalendarDate(row.workDate) : null,
            description: row.description,
            quantity: normaliseDecimal(row.quantity.toString()),
            unit: row.unit,
            rateMinor: row.rateMinor === null ? null : money(row.rateMinor),
            multiplier: row.multiplier === null ? null : row.multiplier.toFixed(2),
            labourRateId: row.labourRateId,
            amountMinor: money(row.amountMinor),
            taxable: row.taxable,
          })),
          deductions: line.deductions
            .filter((row) => row.party === "employee")
            .sort((a, b) => order(a.kind) - order(b.kind))
            .map((row) => ({
              kind: row.kind as EmployeeStatutory,
              dueMinor: money(row.dueMinor),
              withheldMinor: money(row.withheldMinor),
              shortfallMinor: money(row.shortfallMinor),
              ruleVersionId: row.ruleVersionId,
            })),
          recoveries: line.recoveries.map((row) => ({
            advanceId: row.advanceId,
            amountMinor: money(row.amountMinor),
            outstandingAfterMinor: money(row.outstandingAfterMinor),
          })),
          employerCosts: line.deductions
            .filter((row) => row.party === "employer")
            .sort((a, b) => order(a.kind) - order(b.kind))
            .map((row) => ({
              kind: row.kind as EmployerCost,
              amountMinor: money(row.withheldMinor),
              ruleVersionId: row.ruleVersionId,
            })),
          monthToDate: {
            statutoryMonth: mtd.statutoryMonth,
            priorBatches: mtd.priorBatchIds.length,
            priorBaseMinor: mtd.prior.baseMinor,
            cumulativeBaseMinor: mtd.cumulativeBaseMinor,
            taxablePayMinor: mtd.monthly.taxablePayMinor,
            payeBeforeReliefMinor: mtd.monthly.payeBeforeReliefMinor,
            personalReliefMinor: mtd.monthly.personalReliefMinor,
            monthly: mtd.monthly.employee,
          },
          advanceBalanceMinor,
        },
      });
    });
  }

  snapshot(principal: Principal, batchId: string, req: Request) {
    return this.commands.read(principal, req, async (scope) => {
      const { tx, access } = scope;
      const row = await this.batch(tx, access.tenantId, batchId);
      await this.access.project(scope, row.projectId, PAYROLL_VIEW);
      const stored = await this.builder.storedSnapshot(tx, access.tenantId, batchId);
      return batchSnapshotResponseSchema.parse({
        batchId,
        status: row.status,
        version: row.version,
        digest: row.digest,
        recomputedDigest: stored.digest,
        matches: stored.digest === row.digest,
        snapshot: stored.snapshot,
      });
    });
  }

  private async compute(scope: Scope, row: BatchRow) {
    const calendar = await loadCalendar(scope.tx, scope.access.tenantId, row.projectId);
    return this.builder.compute(
      scope.tx,
      scope.access.tenantId,
      {
        id: row.id,
        projectId: row.projectId,
        periodStart: toCalendarDate(row.periodStart),
        periodEnd: toCalendarDate(row.periodEnd),
        payDate: toCalendarDate(row.payDate),
        frequency: row.frequency as BatchTarget["frequency"],
      },
      calendar,
      this.access.production,
    );
  }

  private async preparable(scope: Scope, batchId: string, version: number) {
    const row = await this.batch(scope.tx, scope.access.tenantId, batchId);
    const { project } = await this.access.project(scope, row.projectId, ["payroll.prepare"]);
    this.access.assertWritable(project);
    if (row.version !== version) throw versionConflict();
    if (row.status !== "draft")
      throw payrollConflict("invalid-transition", "Only a draft batch can change.");
    return row;
  }

  private async batch(tx: Tx, tenantId: string, batchId: string): Promise<BatchRow> {
    const row = await tx.payrollBatch.findUnique({
      where: { tenantId_id: { tenantId, id: batchId } },
    });
    if (!row) throw new NotFoundException("Batch not found");
    return row;
  }

  private async view(scope: Scope, row: BatchRow) {
    const { tx, access } = scope;
    const { project, effective } = await this.access.project(scope, row.projectId, PAYROLL_VIEW);
    const lines = await tx.payrollLine.findMany({
      where: { tenantId: access.tenantId, batchId: row.id },
      orderBy: [{ workerNo: "asc" }],
    });
    const stored = row.exclusions as unknown as {
      sourceKind: PayrollExclusion["sourceKind"];
      sourceId: string;
      labourerId: string;
      reason: PayrollExclusion["reason"];
      date: string | null;
    }[];
    const excludedLabourers = await tx.labourer.findMany({
      where: {
        tenantId: access.tenantId,
        id: { in: [...new Set(stored.map((entry) => entry.labourerId))] },
      },
      select: { id: true, workerNo: true, fullName: true },
    });
    const unapproved = await tx.timesheetPeriod.findMany({
      where: {
        tenantId: access.tenantId,
        projectId: row.projectId,
        status: { not: "approved" },
        endDate: { gte: row.periodStart, lte: row.periodEnd },
      },
      orderBy: { startDate: "asc" },
    });
    const pendingOutputs = await tx.pieceRateOutput.count({
      where: {
        tenantId: access.tenantId,
        projectId: row.projectId,
        status: "pending",
        workDate: { lte: row.periodEnd },
      },
    });
    const statutory = await tx.statutoryRuleVersion.findMany({
      where: { tenantId: access.tenantId, id: { in: row.ruleVersionIds } },
    });
    const timesheet = await tx.timesheetRuleVersion.findMany({
      where: { tenantId: access.tenantId, id: { in: row.timesheetRuleIds } },
    });
    let snapshot: { digest: string | null; verified: boolean | null } = {
      digest: null,
      verified: null,
    };
    if (row.status === "submitted") {
      const recomputed = await this.builder.storedSnapshot(tx, access.tenantId, row.id);
      snapshot = { digest: row.digest, verified: recomputed.digest === row.digest };
    }
    const names = await displayNames(tx, batchNames(row));
    const writable = !["closed", "cancelled"].includes(project.status);
    const prepare = effective.has("payroll.prepare") && writable;
    return batchDetailResponseSchema.parse({
      project: { id: project.id, code: project.code, name: project.name },
      batch: toBatch(row, names),
      totals: row.totals as unknown as PayrollTotals,
      lines: lines.map(toLineSummary),
      exclusions: stored.map((entry) => ({
        sourceKind: entry.sourceKind,
        sourceId: entry.sourceId,
        labourer: excludedLabourers.find((labourer) => labourer.id === entry.labourerId) ?? null,
        reason: entry.reason,
        date: entry.date,
      })),
      unapprovedPeriods: unapproved.map((period) => ({
        id: period.id,
        startDate: toCalendarDate(period.startDate),
        endDate: toCalendarDate(period.endDate),
        status: period.status as "open" | "submitted" | "rejected",
      })),
      pendingOutputs,
      rules: [
        ...statutory
          .map((rule) => ({
            id: rule.id,
            kind: rule.kind as "paye",
            effectiveFrom: toCalendarDate(rule.effectiveFrom),
            status: rule.status as "unverified" | "verified",
          }))
          .sort((a, b) => a.kind.localeCompare(b.kind)),
        ...timesheet.map((rule) => ({
          id: rule.id,
          kind: "timesheet" as const,
          effectiveFrom: toCalendarDate(rule.effectiveFrom),
          status:
            rule.complianceStatus === "approved" ? ("verified" as const) : ("unverified" as const),
        })),
      ],
      snapshot,
      production: this.access.production,
      permissions: {
        canRecalculate: prepare && row.status === "draft",
        canSubmit: prepare && row.status === "draft",
        canCancel: effective.has("payroll.prepare") && row.status !== "cancelled",
      },
    });
  }
}

const KIND_ORDER = ["nssf", "shif", "ahl", "paye", "nssf_employer", "ahl_employer", "nita"];
const order = (kind: string) => KIND_ORDER.indexOf(kind);
