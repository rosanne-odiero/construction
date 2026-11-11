import { Injectable, NotFoundException } from "@nestjs/common";
import { nairobiDate, normaliseDecimal } from "@pm-buddy/domain";
import type {
  AdvanceDisbursementMethod,
  AdvanceDisplayStatus,
  AdvanceStatus,
  Permission,
} from "@pm-buddy/types";
import {
  advanceResponseSchema,
  advancesResponseSchema,
  type Advance,
  type advanceListQuerySchema,
  type approveAdvanceRequestSchema,
  type cancelAdvanceRequestSchema,
  type createAdvanceRequestSchema,
  type disburseAdvanceRequestSchema,
  type rejectAdvanceRequestSchema,
} from "@pm-buddy/validation";
import type { Request } from "express";
import type { z } from "zod";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import { AuthService, type Principal } from "../identity/auth.service.js";
import { displayNames } from "../labour/labour-mappers.js";
import { fromCalendarDate, toCalendarDate } from "../projects/project-mappers.js";
import { loadPayrollSettings } from "./batch-builder.js";
import { actor, iso, optionalActor } from "./payroll-mappers.js";
import {
  PayrollAccess,
  PayrollCommands,
  inProjects,
  money,
  payrollBadRequest,
  payrollConflict,
  requireStepUp,
  samePerson,
  versionConflict,
} from "./payroll-support.js";

type Tx = Prisma.TransactionClient;
type AdvanceRow = Prisma.SalaryAdvanceGetPayload<object>;

const ADVANCE_VIEW: readonly Permission[] = [
  "advances.request",
  "advances.approve",
  "payroll.view",
  "payroll.prepare",
];
/** Recoveries of advances with the status and period of their batch (one query at a time). */
async function recoveriesOf(tx: Tx, tenantId: string, advanceIds: readonly string[]) {
  if (!advanceIds.length) return [];
  const rows = await tx.advanceRecovery.findMany({
    where: { tenantId, advanceId: { in: [...advanceIds] } },
  });
  const batches = await tx.payrollBatch.findMany({
    where: { tenantId, id: { in: [...new Set(rows.map((row) => row.batchId))] } },
    select: { id: true, status: true, periodStart: true, periodEnd: true },
  });
  return rows.map((row) => ({ ...row, batch: batches.find((batch) => batch.id === row.batchId)! }));
}

/**
 * Salary advances (brief §5.6, D4.1): requested by site or office staff, approved by someone else
 * within the company limits, recorded as paid outside PM-Buddy (cash, M-Pesa or bank, with a
 * reference and evidence note, fresh MFA, not by the requester) and then recovered automatically
 * by later batches of the same project (packages/domain planRecoveries). Real M-Pesa
 * disbursement arrives with D4.3. COMPLIANCE-REVIEW CR-PAY-15, CR-PAY-16.
 */
@Injectable()
export class AdvancesService {
  constructor(
    private readonly auth: AuthService,
    private readonly access: PayrollAccess,
    private readonly commands: PayrollCommands,
  ) {}

  list(principal: Principal, query: z.output<typeof advanceListQuerySchema>, req: Request) {
    return this.commands.read(principal, req, async (scope) => {
      const { tx, access } = scope;
      const visible = await this.access.projectsWithAny(scope, ADVANCE_VIEW);
      if (visible !== "all" && !visible.length)
        await this.access.companyAny(scope, [...ADVANCE_VIEW]);
      if (query.projectId) await this.access.project(scope, query.projectId, ADVANCE_VIEW);
      const rows = await tx.salaryAdvance.findMany({
        where: {
          tenantId: access.tenantId,
          ...(visible === "all" ? {} : { projectId: { in: [...visible] } }),
          ...(query.projectId ? { projectId: query.projectId } : {}),
          ...(query.labourerId ? { labourerId: query.labourerId } : {}),
          ...(query.status ? { status: query.status } : {}),
        },
        orderBy: { requestedAt: "desc" },
        take: 300,
      });
      const requestable = await this.access.projects(scope, ["advances.request"]);
      return advancesResponseSchema.parse({
        today: nairobiDate(),
        advances: await this.toAdvances(scope, rows),
        limits: await loadPayrollSettings(tx, access.tenantId),
        requestableProjects: requestable.map((project) => ({
          id: project.id,
          code: project.code,
          name: project.name,
        })),
      });
    });
  }

  create(
    principal: Principal,
    projectId: string,
    input: z.output<typeof createAdvanceRequestSchema>,
    req: Request,
  ) {
    return this.commands.run(
      principal,
      req,
      "payroll.advance.create",
      { projectId, input },
      async (scope) => {
        const { tx, access } = scope;
        const { project } = await this.access.project(scope, projectId, ["advances.request"]);
        this.access.assertWritable(project);
        const today = fromCalendarDate(nairobiDate());
        const engaged = await tx.labourEngagement.count({
          where: {
            tenantId: access.tenantId,
            projectId,
            labourerId: input.labourerId,
            startDate: { lte: today },
            OR: [{ endDate: null }, { endDate: { gte: today } }],
          },
        });
        if (!engaged)
          throw payrollConflict("not-engaged", "The labourer is not engaged on this project.");
        await this.assertLimits(tx, access.tenantId, input.labourerId, input.amountMinor, null);
        const row = await tx.salaryAdvance.create({
          data: {
            tenantId: access.tenantId,
            projectId,
            labourerId: input.labourerId,
            amountMinor: BigInt(input.amountMinor),
            reason: input.reason,
            instalmentMinor: input.instalmentMinor === null ? null : BigInt(input.instalmentMinor),
            maxRecoveryPercent: input.maxRecoveryPercent,
            requestedBy: access.userId,
          },
        });
        await this.commands.audit(scope, "advance.requested", row.id, {
          projectId,
          instalmentSet: input.instalmentMinor !== null,
        });
        return this.response(scope, row.id);
      },
    );
  }

  approve(
    principal: Principal,
    advanceId: string,
    input: z.output<typeof approveAdvanceRequestSchema>,
    req: Request,
  ) {
    return this.commands.run(
      principal,
      req,
      "payroll.advance.approve",
      { advanceId, input },
      async (scope) => {
        const { tx, access } = scope;
        const row = await this.decidable(scope, advanceId, input.version);
        await this.assertLimits(
          tx,
          access.tenantId,
          row.labourerId,
          money(row.amountMinor),
          row.id,
        );
        await this.transition(tx, access.tenantId, advanceId, input.version, {
          status: "approved",
          decidedBy: access.userId,
          decisionNote: input.note?.length ? input.note : null,
        });
        await this.commands.audit(scope, "advance.approved", advanceId, {
          projectId: row.projectId,
        });
        return this.response(scope, advanceId);
      },
    );
  }

  reject(
    principal: Principal,
    advanceId: string,
    input: z.output<typeof rejectAdvanceRequestSchema>,
    req: Request,
  ) {
    return this.commands.run(
      principal,
      req,
      "payroll.advance.reject",
      { advanceId, input },
      async (scope) => {
        const { tx, access } = scope;
        const row = await this.decidable(scope, advanceId, input.version);
        await this.transition(tx, access.tenantId, advanceId, input.version, {
          status: "rejected",
          decidedBy: access.userId,
          decisionNote: input.note,
        });
        await this.commands.audit(scope, "advance.rejected", advanceId, {
          projectId: row.projectId,
          noteGiven: true,
        });
        return this.response(scope, advanceId);
      },
    );
  }

  /** Records an advance paid outside PM-Buddy: payments.record_cash, fresh MFA, not the requester. */
  disburse(
    principal: Principal,
    advanceId: string,
    input: z.output<typeof disburseAdvanceRequestSchema>,
    req: Request,
  ) {
    return this.commands.run(
      principal,
      req,
      "payroll.advance.disburse",
      { advanceId, input },
      async (scope) => {
        const { tx, access } = scope;
        const row = await this.advance(tx, access.tenantId, advanceId);
        await this.access.project(scope, row.projectId, ["payments.record_cash"]);
        requireStepUp(this.auth, principal);
        if (row.version !== input.version) throw versionConflict();
        if (row.status !== "approved")
          throw payrollConflict("invalid-transition", "Only an approved advance can be paid.");
        if (row.requestedBy === access.userId)
          throw samePerson("The person who requested an advance cannot record its payment.");
        if (input.paidOn > nairobiDate())
          throw payrollBadRequest("date-in-future", "The payment date cannot be in the future.");
        await this.transition(tx, access.tenantId, advanceId, input.version, {
          status: "disbursed",
          disbursementMethod: input.method,
          disbursementReference: input.reference,
          paidOn: fromCalendarDate(input.paidOn),
          evidenceNote: input.evidenceNote,
          disbursedBy: access.userId,
        });
        await this.commands.audit(scope, "advance.disbursed", advanceId, {
          projectId: row.projectId,
          method: input.method,
          recordedOutsidePmBuddy: true,
        });
        await this.commands.outbox(scope, "advance.disbursed", advanceId, {
          projectId: row.projectId,
          method: input.method,
        });
        return this.response(scope, advanceId);
      },
    );
  }

  cancel(
    principal: Principal,
    advanceId: string,
    input: z.output<typeof cancelAdvanceRequestSchema>,
    req: Request,
  ) {
    return this.commands.run(
      principal,
      req,
      "payroll.advance.cancel",
      { advanceId, input },
      async (scope) => {
        const { tx, access } = scope;
        const row = await this.advance(tx, access.tenantId, advanceId);
        const { effective } = await this.access.project(scope, row.projectId, [
          "advances.request",
          "advances.approve",
        ]);
        if (!effective.has("advances.approve") && row.requestedBy !== access.userId)
          throw samePerson("Only the requester or an approver can cancel an advance.");
        if (row.version !== input.version) throw versionConflict();
        if (row.status !== "requested" && row.status !== "approved")
          throw payrollConflict(
            "invalid-transition",
            "Only a requested or approved advance can be cancelled.",
          );
        await this.transition(tx, access.tenantId, advanceId, input.version, {
          status: "cancelled",
          cancelledBy: access.userId,
          cancellationReason: input.reason,
        });
        await this.commands.audit(scope, "advance.cancelled", advanceId, {
          projectId: row.projectId,
          from: row.status,
          reasonGiven: true,
        });
        return this.response(scope, advanceId);
      },
    );
  }

  private async decidable(scope: Scope, advanceId: string, version: number) {
    const { tx, access } = scope;
    const row = await this.advance(tx, access.tenantId, advanceId);
    await this.access.project(scope, row.projectId, ["advances.approve"]);
    if (row.version !== version) throw versionConflict();
    if (row.status !== "requested")
      throw payrollConflict("invalid-transition", "This advance was already decided.");
    if (row.requestedBy === access.userId)
      throw samePerson("The person who requested an advance cannot decide it.");
    return row;
  }

  /** Company limits: the single-advance maximum and the outstanding balance per labourer. */
  private async assertLimits(
    tx: Tx,
    tenantId: string,
    labourerId: string,
    amountMinor: number,
    excludeId: string | null,
  ) {
    const settings = await loadPayrollSettings(tx, tenantId);
    if (amountMinor > settings.advanceMaxMinor)
      throw payrollConflict(
        "advance-over-limit",
        "The advance is above the company's single-advance limit.",
      );
    const open = await tx.salaryAdvance.findMany({
      where: {
        tenantId,
        labourerId,
        status: { in: ["requested", "approved", "disbursed"] },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });
    const recoveries = await recoveriesOf(
      tx,
      tenantId,
      open.map((row) => row.id),
    );
    const outstanding = open.reduce(
      (sum, row) =>
        sum +
        money(row.amountMinor) -
        recoveries
          .filter((entry) => entry.advanceId === row.id && entry.batch.status === "submitted")
          .reduce((total, entry) => total + money(entry.amountMinor), 0),
      0,
    );
    if (outstanding + amountMinor > settings.advanceMaxOutstandingMinor)
      throw payrollConflict(
        "advance-outstanding-limit",
        "The labourer's outstanding advances would exceed the company limit.",
      );
  }

  private async transition(
    tx: Tx,
    tenantId: string,
    advanceId: string,
    version: number,
    data: Prisma.SalaryAdvanceUpdateManyMutationInput,
  ) {
    const updated = await tx.salaryAdvance.updateMany({
      where: { tenantId, id: advanceId, version },
      data: { ...data, version: { increment: 1 } },
    });
    if (!updated.count) throw versionConflict();
  }

  private async advance(tx: Tx, tenantId: string, advanceId: string) {
    const row = await tx.salaryAdvance.findUnique({
      where: { tenantId_id: { tenantId, id: advanceId } },
    });
    if (!row) throw new NotFoundException("Advance not found");
    return row;
  }

  private async response(scope: Scope, advanceId: string) {
    const row = await scope.tx.salaryAdvance.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id: advanceId } },
    });
    return advanceResponseSchema.parse({ advance: (await this.toAdvances(scope, [row]))[0] });
  }

  private async toAdvances(scope: Scope, rows: AdvanceRow[]): Promise<Advance[]> {
    const { tx, access } = scope;
    const names = await displayNames(
      tx,
      rows.flatMap((row) => [row.requestedBy, row.decidedBy, row.disbursedBy, row.cancelledBy]),
    );
    const approveOn = await this.access.projectsWithAny(scope, ["advances.approve"]);
    const projects = await tx.project.findMany({
      where: {
        tenantId: access.tenantId,
        id: { in: [...new Set(rows.map((row) => row.projectId))] },
      },
      select: { id: true, code: true, name: true },
    });
    const labourers = await tx.labourer.findMany({
      where: {
        tenantId: access.tenantId,
        id: { in: [...new Set(rows.map((row) => row.labourerId))] },
      },
      select: { id: true, workerNo: true, fullName: true },
    });
    const allRecoveries = await recoveriesOf(
      tx,
      access.tenantId,
      rows.map((row) => row.id),
    );
    const canRecordPayment = access.permissions.has("payments.record_cash") && access.tenantWide;
    return rows.map((row) => {
      const recoveries = allRecoveries.filter((entry) => entry.advanceId === row.id);
      const recovered = recoveries
        .filter((entry) => entry.batch.status === "submitted")
        .reduce((sum, entry) => sum + money(entry.amountMinor), 0);
      const amount = money(row.amountMinor);
      const status = row.status as AdvanceStatus;
      const displayStatus: AdvanceDisplayStatus =
        status !== "disbursed"
          ? status
          : recovered === 0
            ? "disbursed"
            : recovered >= amount
              ? "recovered"
              : "recovering";
      const approver = inProjects(approveOn, row.projectId);
      const own = row.requestedBy === access.userId;
      return {
        id: row.id,
        project: projects.find((project) => project.id === row.projectId)!,
        labourer: labourers.find((labourer) => labourer.id === row.labourerId)!,
        amountMinor: amount,
        reason: row.reason,
        instalmentMinor: row.instalmentMinor === null ? null : money(row.instalmentMinor),
        maxRecoveryPercent:
          row.maxRecoveryPercent === null
            ? null
            : normaliseDecimal(row.maxRecoveryPercent.toString()),
        status,
        displayStatus,
        recoveredMinor: recovered,
        outstandingMinor: status === "disbursed" ? amount - recovered : 0,
        version: row.version,
        requestedBy: actor(names, row.requestedBy),
        requestedAt: row.requestedAt.toISOString(),
        decidedBy: optionalActor(names, row.decidedBy),
        decidedAt: iso(row.decidedAt),
        decisionNote: row.decisionNote,
        disbursement:
          status === "disbursed" && row.disbursedBy && row.disbursedAt && row.paidOn
            ? {
                method: row.disbursementMethod as AdvanceDisbursementMethod,
                reference: row.disbursementReference ?? "",
                paidOn: toCalendarDate(row.paidOn),
                evidenceNote: row.evidenceNote ?? "",
                recordedBy: actor(names, row.disbursedBy),
                recordedAt: row.disbursedAt.toISOString(),
              }
            : null,
        cancelledBy: optionalActor(names, row.cancelledBy),
        cancelledAt: iso(row.cancelledAt),
        cancellationReason: row.cancellationReason,
        recoveries: recoveries
          .map((entry) => ({
            batchId: entry.batchId,
            batchStatus: entry.batch.status as Advance["recoveries"][number]["batchStatus"],
            periodStart: toCalendarDate(entry.batch.periodStart),
            periodEnd: toCalendarDate(entry.batch.periodEnd),
            amountMinor: money(entry.amountMinor),
          }))
          .sort((a, b) => a.periodStart.localeCompare(b.periodStart)),
        permissions: {
          canDecide: status === "requested" && approver && !own,
          canDisburse: status === "approved" && canRecordPayment && !own,
          canCancel: (status === "requested" || status === "approved") && (approver || own),
        },
      };
    });
  }
}
