import { Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import {
  checkJobOutput,
  jobQuantityInForce,
  measurementBasis,
  nairobiDate,
  normaliseDecimal,
  outputAmountMinor,
  pieceRateJobCode,
  reconcileItem,
  resolveConversion,
  STANDARD_UNITS,
  sumQuantities,
  toBqQuantity,
} from "@pm-buddy/domain";
import {
  PIECE_RATE_JOB_APPROVE_PERMISSIONS,
  PIECE_RATE_JOB_PREPARE_PERMISSIONS,
  PIECE_RATE_LIMITS,
  PIECE_RATE_OUTPUT_RECORD_PERMISSIONS,
  PIECE_RATE_READ_PERMISSIONS,
  PIECE_RATE_RECONCILIATION_PERMISSIONS,
  type PieceRateExtensionStatus,
  type PieceRateJobStatus,
  type Permission,
} from "@pm-buddy/types";
import {
  pieceRateJobOptionsResponseSchema,
  pieceRateJobResponseSchema,
  pieceRateJobsResponseSchema,
  pieceRateReconciliationResponseSchema,
  type CreatePieceRateExtensionRequest,
  type PieceRateJob,
  type RecordJobOutputRequest,
} from "@pm-buddy/validation";
import type { z } from "zod";
import type { createPieceRateJobRequestSchema } from "@pm-buddy/validation";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { displayNames } from "../labour/labour-mappers.js";
import { unitDefinitions } from "../procurement/procurement-mappers.js";
import { fromCalendarDate, toCalendarDate } from "../projects/project-mappers.js";
import { bqInForce, measurable } from "../progress/valuations/valuation-common.js";
import { measuredAt } from "../subcontracts/subcontracts-common.js";
import { actor, optionalActor, type Names } from "./payroll-mappers.js";
import {
  PayrollAccess,
  PayrollCommands,
  money,
  payrollBadRequest,
  payrollConflict,
  samePerson,
  versionConflict,
} from "./payroll-support.js";
import { PayrollInputsService } from "./inputs.service.js";

type Tx = Prisma.TransactionClient;
type JobRow = Prisma.PieceRateJobGetPayload<{
  include: {
    bqItem: { include: { bill: { select: { lineageId: true; number: true; title: true } } } };
    labourer: { select: { id: true; workerNo: true; fullName: true } };
    gang: { select: { id: true; name: true } };
    extensions: true;
  };
}>;
const jobInclude = {
  bqItem: { include: { bill: { select: { lineageId: true, number: true, title: true } } } },
  labourer: { select: { id: true, workerNo: true, fullName: true } },
  gang: { select: { id: true, name: true } },
  extensions: { orderBy: { requestedAt: "asc" } },
} as const satisfies Prisma.PieceRateJobInclude;

const has = (effective: ReadonlySet<Permission>, permissions: readonly Permission[]) =>
  permissions.some((permission) => effective.has(permission));
const decimal = (value: { toString(): string }) => normaliseDecimal(value.toString());

/** Locks a job row so outputs, approvals and extensions on it are serialised. */
const lockJob = (tx: Tx, tenantId: string, jobId: string) =>
  tx.$queryRaw`SELECT id FROM piece_rate_jobs WHERE tenant_id = ${tenantId}::uuid AND id = ${jobId}::uuid FOR UPDATE`;

/**
 * Piece-rate jobs (D6.3 part B, brief §5.14; WORKFLOWS "Piece-rate jobs"; decision D-147): the
 * agreed rate and scope against a BQ item for a gang or a labourer, approved by someone other than
 * its creator. Output recorded against a job takes the job's rate, unit, worker and BQ item; the
 * cumulative approved output never exceeds the agreed quantity plus approved extensions (API and
 * database, the job row locked). The D4.1 approval, equal gang shares and payroll consumption are
 * unchanged. The reconciliation compares piece-rate quantities with approved measurement (D6.3)
 * and flags pay above measured work.
 */
@Injectable()
export class PieceRateJobsService {
  constructor(
    private readonly access: PayrollAccess,
    private readonly commands: PayrollCommands,
    private readonly inputs: PayrollInputsService,
  ) {}

  jobs(principal: Principal, projectId: string, req: Request) {
    return this.commands.read(principal, req, async (scope) => {
      const { project, effective } = await this.access.project(
        scope,
        projectId,
        PIECE_RATE_READ_PERMISSIONS,
      );
      const rows = await scope.tx.pieceRateJob.findMany({
        where: { tenantId: scope.access.tenantId, projectId },
        include: jobInclude,
        orderBy: { number: "desc" },
        take: PIECE_RATE_LIMITS.listSize,
      });
      const writable = !["closed", "cancelled"].includes(project.status);
      return pieceRateJobsResponseSchema.parse({
        project: { id: project.id, code: project.code, name: project.name },
        today: nairobiDate(),
        jobs: await this.toJobs(scope, rows, effective, writable),
        permissions: {
          canCreate: writable && has(effective, PIECE_RATE_JOB_PREPARE_PERMISSIONS),
          canDecide: writable && has(effective, PIECE_RATE_JOB_APPROVE_PERMISSIONS),
          canRecord: writable && has(effective, PIECE_RATE_OUTPUT_RECORD_PERMISSIONS),
          canReconcile: has(effective, PIECE_RATE_RECONCILIATION_PERMISSIONS),
        },
      });
    });
  }

  /** What the job form offers: items measured by quantity (with units), gangs and labourers. */
  options(principal: Principal, projectId: string, req: Request) {
    return this.commands.read(principal, req, async (scope) => {
      const { tx, access } = scope;
      const { project } = await this.access.project(
        scope,
        projectId,
        PIECE_RATE_JOB_PREPARE_PERMISSIONS,
      );
      const version = await bqInForce(tx, access.tenantId, projectId);
      const items = version
        ? await tx.bqItem.findMany({
            where: { tenantId: access.tenantId, versionId: version.id },
            include: {
              bill: { select: { lineageId: true, number: true, title: true, sortOrder: true } },
            },
            orderBy: [{ bill: { sortOrder: "asc" } }, { sortOrder: "asc" }],
          })
        : [];
      const custom = unitDefinitions(
        await tx.unit.findMany({ where: { tenantId: access.tenantId, status: "active" } }),
      );
      const today = nairobiDate();
      const gangs = await tx.gang.findMany({
        where: { tenantId: access.tenantId, projectId, status: "active" },
        include: { members: { where: { leftOn: null } } },
        orderBy: { name: "asc" },
      });
      const engaged = await tx.labourEngagement.findMany({
        where: {
          tenantId: access.tenantId,
          projectId,
          startDate: { lte: fromCalendarDate(today) },
          OR: [{ endDate: null }, { endDate: { gte: fromCalendarDate(today) } }],
        },
        select: { labourerId: true },
      });
      const labourers = await tx.labourer.findMany({
        where: {
          tenantId: access.tenantId,
          id: { in: [...new Set(engaged.map((row) => row.labourerId))] },
        },
        select: { id: true, workerNo: true, fullName: true },
        orderBy: { workerNo: "asc" },
        take: 500,
      });
      return pieceRateJobOptionsResponseSchema.parse({
        project: { id: project.id, code: project.code, name: project.name },
        items: items
          .filter((item) => measurementBasis(measurable(item)) === "quantity" && item.unit)
          .map((item) => ({
            versionId: item.versionId,
            lineageId: item.lineageId,
            ref: item.ref,
            description: item.description,
            unit: item.unit,
            bill: {
              lineageId: item.bill.lineageId,
              number: item.bill.number,
              title: item.bill.title,
            },
            quantity: item.quantity === null ? null : decimal(item.quantity),
            units: unitsFor(item.unit!, custom, today),
          })),
        gangs: gangs.map((gang) => ({
          id: gang.id,
          name: gang.name,
          members: gang.members.length,
        })),
        labourers,
      });
    });
  }

  create(
    principal: Principal,
    projectId: string,
    input: z.output<typeof createPieceRateJobRequestSchema>,
    req: Request,
  ) {
    return this.commands.run(
      principal,
      req,
      "payroll.piece_rate_job.create",
      { projectId, input },
      async (scope) => {
        const { tx, access } = scope;
        const { project } = await this.access.project(
          scope,
          projectId,
          PIECE_RATE_JOB_PREPARE_PERMISSIONS,
        );
        this.access.assertWritable(project);
        const version = await bqInForce(tx, access.tenantId, projectId);
        const item = version
          ? await tx.bqItem.findUnique({
              where: {
                tenantId_versionId_lineageId: {
                  tenantId: access.tenantId,
                  versionId: version.id,
                  lineageId: input.bqItemLineageId,
                },
              },
            })
          : null;
        if (!item) throw new NotFoundException("BQ item not found in the BQ in force");
        if (measurementBasis(measurable(item)) !== "quantity" || !item.unit)
          throw payrollConflict(
            "bq-item-not-in-project",
            "Piece-rate jobs are for BQ items measured by quantity",
          );
        const custom = unitDefinitions(
          await tx.unit.findMany({ where: { tenantId: access.tenantId, status: "active" } }),
        );
        const unit = unitsFor(item.unit, custom, nairobiDate()).find(
          (entry) => entry.unit === input.unit,
        );
        if (!unit)
          throw payrollBadRequest(
            "unit-not-convertible",
            `Use the BQ item's unit (${item.unit}) or one that converts to it exactly`,
          );
        if (input.labourerId) {
          const engaged = await tx.labourEngagement.count({
            where: { tenantId: access.tenantId, projectId, labourerId: input.labourerId },
          });
          if (!engaged)
            throw payrollConflict("not-engaged", "The labourer is not engaged on this project.");
        }
        if (input.gangId) {
          const gang = await tx.gang.findFirst({
            where: { tenantId: access.tenantId, projectId, id: input.gangId },
          });
          if (!gang) throw new NotFoundException("Gang not found");
        }
        await tx.$queryRaw`SELECT id FROM projects WHERE tenant_id = ${access.tenantId}::uuid AND id = ${projectId}::uuid FOR UPDATE`;
        const highest = await tx.pieceRateJob.aggregate({
          where: { tenantId: access.tenantId, projectId },
          _max: { number: true },
        });
        const number = (highest._max.number ?? 0) + 1;
        const row = await tx.pieceRateJob.create({
          data: {
            tenantId: access.tenantId,
            projectId,
            number,
            bqVersionId: item.versionId,
            bqItemLineageId: item.lineageId,
            labourerId: input.labourerId,
            gangId: input.gangId,
            description: input.description,
            unit: input.unit,
            bqUnit: item.unit,
            conversionFactor: unit.factor,
            rateMinor: BigInt(input.rateMinor),
            agreedQuantity: input.agreedQuantity,
            startDate: fromCalendarDate(input.startDate),
            endDate: fromCalendarDate(input.endDate),
            createdBy: access.userId,
          },
        });
        await this.commands.audit(scope, "payroll.piece_rate_job_created", row.id, {
          projectId,
          number,
          gang: Boolean(input.gangId),
        });
        return this.jobResponse(scope, row.id);
      },
    );
  }

  get(principal: Principal, jobId: string, req: Request) {
    return this.commands.read(principal, req, async (scope) => {
      const row = await this.row(scope, jobId);
      await this.access.project(scope, row.projectId, PIECE_RATE_READ_PERMISSIONS);
      return this.jobResponse(scope, jobId);
    });
  }

  /** approve | reject (timesheets.approve, never the creator) · close (a job preparer). */
  decide(
    principal: Principal,
    jobId: string,
    action: "approve" | "reject" | "close",
    input: { version: number; reason?: string },
    req: Request,
  ) {
    return this.commands.run(
      principal,
      req,
      `payroll.piece_rate_job.${action}`,
      { jobId, input },
      async (scope) => {
        const { tx, access } = scope;
        const row = await this.row(scope, jobId);
        const { project } = await this.access.project(
          scope,
          row.projectId,
          action === "close"
            ? PIECE_RATE_JOB_PREPARE_PERMISSIONS
            : PIECE_RATE_JOB_APPROVE_PERMISSIONS,
        );
        this.access.assertWritable(project);
        await lockJob(tx, access.tenantId, jobId);
        if (row.version !== input.version) throw versionConflict();
        const from: PieceRateJobStatus = action === "close" ? "approved" : "pending";
        if (row.status !== from)
          throw payrollConflict(
            "invalid-transition",
            `Not possible while the job is ${row.status}.`,
          );
        if (action !== "close" && row.createdBy === access.userId)
          throw samePerson("The person who created the job cannot decide it.");
        await tx.pieceRateJob.update({
          where: { tenantId_id: { tenantId: access.tenantId, id: jobId } },
          data:
            action === "close"
              ? {
                  status: "closed",
                  closedBy: access.userId,
                  closedAt: new Date(),
                  version: { increment: 1 },
                }
              : {
                  status: action === "approve" ? "approved" : "rejected",
                  decidedBy: access.userId,
                  decidedAt: new Date(),
                  decisionNote: input.reason ?? null,
                  version: { increment: 1 },
                },
        });
        await this.commands.audit(
          scope,
          `payroll.piece_rate_job_${action === "close" ? "closed" : `${action}d`}`,
          jobId,
          {
            projectId: row.projectId,
            number: row.number,
          },
        );
        return this.jobResponse(scope, jobId);
      },
    );
  }

  requestExtension(
    principal: Principal,
    jobId: string,
    input: CreatePieceRateExtensionRequest,
    req: Request,
  ) {
    return this.commands.run(
      principal,
      req,
      "payroll.piece_rate_job.extend",
      { jobId, input },
      async (scope) => {
        const { tx, access } = scope;
        const row = await this.row(scope, jobId);
        const { project } = await this.access.project(
          scope,
          row.projectId,
          PIECE_RATE_JOB_PREPARE_PERMISSIONS,
        );
        this.access.assertWritable(project);
        await lockJob(tx, access.tenantId, jobId);
        if (row.status !== "approved")
          throw payrollConflict("invalid-transition", "Only an approved job can be extended.");
        const extension = await tx.pieceRateJobExtension.create({
          data: {
            tenantId: access.tenantId,
            projectId: row.projectId,
            jobId,
            quantity: input.quantity,
            reason: input.reason,
            requestedBy: access.userId,
          },
        });
        await this.commands.audit(scope, "payroll.piece_rate_extension_requested", extension.id, {
          projectId: row.projectId,
          jobId,
        });
        return this.jobResponse(scope, jobId);
      },
    );
  }

  decideExtension(
    principal: Principal,
    jobId: string,
    extensionId: string,
    action: "approve" | "reject",
    input: { version: number; reason?: string },
    req: Request,
  ) {
    return this.commands.run(
      principal,
      req,
      `payroll.piece_rate_extension.${action}`,
      { jobId, extensionId, input },
      async (scope) => {
        const { tx, access } = scope;
        const row = await this.row(scope, jobId);
        const { project } = await this.access.project(
          scope,
          row.projectId,
          PIECE_RATE_JOB_APPROVE_PERMISSIONS,
        );
        this.access.assertWritable(project);
        await lockJob(tx, access.tenantId, jobId);
        const extension = row.extensions.find((entry) => entry.id === extensionId);
        if (!extension) throw new NotFoundException("Extension not found");
        if (extension.version !== input.version) throw versionConflict();
        if (extension.status !== "pending")
          throw payrollConflict("invalid-transition", "This extension was already decided.");
        if (extension.requestedBy === access.userId)
          throw samePerson("The person who asked for the extension cannot decide it.");
        await tx.pieceRateJobExtension.update({
          where: { tenantId_id: { tenantId: access.tenantId, id: extensionId } },
          data: {
            status: action === "approve" ? "approved" : "rejected",
            decidedBy: access.userId,
            decidedAt: new Date(),
            decisionNote: input.reason ?? null,
            version: { increment: 1 },
          },
        });
        await this.commands.audit(scope, `payroll.piece_rate_extension_${action}d`, extensionId, {
          projectId: row.projectId,
          jobId,
        });
        return this.jobResponse(scope, jobId);
      },
    );
  }

  /**
   * Output against a job (Idempotency-Key optional, as D4.1 output): the day and quantity only —
   * rate, unit, worker and BQ item are the job's. Recorded + pending output never exceeds the
   * quantity in force (the job row locked, 409 job-quantity-exceeded).
   */
  recordOutput(principal: Principal, jobId: string, input: RecordJobOutputRequest, req: Request) {
    return this.commands.run(
      principal,
      req,
      "payroll.output.create_for_job",
      { jobId, input },
      async (scope) => {
        const { tx, access } = scope;
        const row = await this.row(scope, jobId);
        const { project } = await this.access.project(
          scope,
          row.projectId,
          PIECE_RATE_OUTPUT_RECORD_PERMISSIONS,
        );
        this.access.assertWritable(project);
        await lockJob(tx, access.tenantId, jobId);
        if (row.status !== "approved")
          throw payrollConflict("job-not-approved", "Output is recorded against an approved job.");
        if (input.workDate > nairobiDate())
          throw payrollBadRequest("date-in-future", "Output cannot be recorded for a future date.");
        if (
          input.workDate < toCalendarDate(row.startDate) ||
          input.workDate > toCalendarDate(row.endDate)
        )
          throw payrollConflict("job-dates", "Output is recorded within the job's dates.");
        if (row.labourerId) {
          const engaged = await tx.labourEngagement.count({
            where: {
              tenantId: access.tenantId,
              projectId: row.projectId,
              labourerId: row.labourerId,
              startDate: { lte: fromCalendarDate(input.workDate) },
              OR: [{ endDate: null }, { endDate: { gte: fromCalendarDate(input.workDate) } }],
            },
          });
          if (!engaged)
            throw payrollConflict(
              "not-engaged",
              "The labourer is not engaged on this project on that date.",
            );
        }
        const totals = await this.totals(tx, access.tenantId, [jobId]);
        const check = checkJobOutput({
          inForce: jobQuantityInForce(row.agreedQuantity.toFixed(), approvedExtensions(row)),
          approved: totals.get(jobId)?.approved ?? "0",
          pending: totals.get(jobId)?.pending ?? "0",
          quantity: input.quantity,
          stage: "record",
        });
        if (!check.ok)
          throw payrollConflict(
            "job-quantity-exceeded",
            `Only ${check.remaining} ${row.unit} is left on this job; ask for an approved extension first.`,
          );
        const created = await tx.pieceRateOutput.create({
          data: {
            tenantId: access.tenantId,
            projectId: row.projectId,
            workDate: fromCalendarDate(input.workDate),
            labourerId: row.labourerId,
            gangId: row.gangId,
            bqItemId: row.bqItem.id,
            jobId,
            description: input.description ?? row.description,
            unit: row.unit,
            quantity: input.quantity,
            rateMinor: row.rateMinor,
            amountMinor: BigInt(outputAmountMinor(input.quantity, Number(row.rateMinor))),
            recordedBy: access.userId,
          },
        });
        await this.commands.audit(scope, "payroll.output_recorded", created.id, {
          projectId: row.projectId,
          workDate: input.workDate,
          gang: Boolean(row.gangId),
          jobId,
        });
        return this.jobResponse(scope, jobId);
      },
    );
  }

  /**
   * Piece-rate quantities paid against approved measurement per BQ item (D6.3), with what
   * subcontractors were certified on the same items; pay above measured work is flagged.
   */
  reconciliation(principal: Principal, projectId: string, req: Request) {
    return this.commands.read(principal, req, async (scope) => {
      const { tx, access } = scope;
      const { project } = await this.access.project(
        scope,
        projectId,
        PIECE_RATE_RECONCILIATION_PERMISSIONS,
      );
      const today = nairobiDate();
      const version = await bqInForce(tx, access.tenantId, projectId);
      const items = version
        ? await tx.bqItem.findMany({
            where: { tenantId: access.tenantId, versionId: version.id },
            include: {
              bill: { select: { lineageId: true, number: true, title: true, sortOrder: true } },
            },
            orderBy: [{ bill: { sortOrder: "asc" } }, { sortOrder: "asc" }],
          })
        : [];
      const jobs = await tx.pieceRateJob.findMany({
        where: { tenantId: access.tenantId, projectId },
        select: {
          id: true,
          number: true,
          status: true,
          bqItemLineageId: true,
          conversionFactor: true,
        },
      });
      const outputs = await tx.pieceRateOutput.findMany({
        where: {
          tenantId: access.tenantId,
          projectId,
          bqItemId: { not: null },
          status: { in: ["pending", "approved"] },
        },
        select: {
          bqItemId: true,
          jobId: true,
          quantity: true,
          unit: true,
          status: true,
          amountMinor: true,
        },
      });
      const outputItems = await tx.bqItem.findMany({
        where: {
          tenantId: access.tenantId,
          id: { in: [...new Set(outputs.map((row) => row.bqItemId!))] },
        },
        select: { id: true, lineageId: true },
      });
      const lineageOf = new Map(outputItems.map((item) => [item.id, item.lineageId]));
      const factorOf = new Map(jobs.map((job) => [job.id, job.conversionFactor.toFixed()]));
      const measured = await measuredAt(tx, access.tenantId, projectId, today);
      const subcontracted = await certifiedOnItems(tx, access.tenantId, projectId);
      const rows = items
        .filter(
          (item) =>
            jobs.some((job) => job.bqItemLineageId === item.lineageId) ||
            outputs.some((output) => lineageOf.get(output.bqItemId!) === item.lineageId),
        )
        .map((item) => {
          const own = outputs.filter(
            (output) => lineageOf.get(output.bqItemId!) === item.lineageId,
          );
          const inBqUnit = (output: (typeof own)[number]) =>
            output.jobId
              ? toBqQuantity(output.quantity.toFixed(), factorOf.get(output.jobId) ?? "1")
              : output.unit === item.unit
                ? output.quantity.toFixed()
                : "0";
          const approved = own.filter((output) => output.status === "approved");
          const pieceRate = sumQuantities(approved.map(inBqUnit));
          const reconciliation = reconcileItem({
            measured: measured.get(item.lineageId)?.quantity ?? null,
            pieceRate,
            subcontracted: subcontracted.get(item.lineageId) ?? "0",
            unlinkedApproved: approved.filter((output) => output.jobId === null).length,
          });
          return {
            bqItem: {
              versionId: item.versionId,
              lineageId: item.lineageId,
              ref: item.ref,
              description: item.description,
              unit: item.unit,
              bill: {
                lineageId: item.bill.lineageId,
                number: item.bill.number,
                title: item.bill.title,
              },
            },
            measured: reconciliation.measured,
            measuredOn: measured.get(item.lineageId)?.measuredOn ?? null,
            pieceRateQuantity: reconciliation.pieceRate,
            pieceRateAmountMinor: approved.reduce(
              (sum, output) => sum + money(output.amountMinor),
              0,
            ),
            pendingQuantity: sumQuantities(
              own.filter((output) => output.status === "pending").map(inBqUnit),
            ),
            subcontractedQuantity: reconciliation.subcontracted,
            excessPieceRate: reconciliation.excessPieceRate,
            excessCombined: reconciliation.excessCombined,
            unlinkedOutputs: approved.filter((output) => output.jobId === null).length,
            jobs: jobs
              .filter((job) => job.bqItemLineageId === item.lineageId)
              .map((job) => ({
                id: job.id,
                code: pieceRateJobCode(job.number),
                status: job.status as PieceRateJobStatus,
              })),
            flags: reconciliation.flags,
          };
        });
      return pieceRateReconciliationResponseSchema.parse({
        project: { id: project.id, code: project.code, name: project.name },
        asOf: today,
        items: rows,
        flagged: rows.filter((row) => row.flags.some((flag) => flag !== "unlinked-outputs")).length,
      });
    });
  }

  // Helpers --------------------------------------------------------------------------------------

  private async row(scope: Scope, jobId: string): Promise<JobRow> {
    const row = await scope.tx.pieceRateJob.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id: jobId } },
      include: jobInclude,
    });
    if (!row) throw new NotFoundException("Piece-rate job not found");
    return row;
  }

  private async totals(tx: Tx, tenantId: string, jobIds: string[]) {
    const grouped = await tx.pieceRateOutput.groupBy({
      by: ["jobId", "status"],
      where: { tenantId, jobId: { in: jobIds } },
      _sum: { quantity: true, amountMinor: true },
    });
    const result = new Map<string, { approved: string; pending: string; amountMinor: number }>();
    for (const jobId of jobIds) {
      const of = (status: string) =>
        grouped.find((row) => row.jobId === jobId && row.status === status);
      result.set(jobId, {
        approved: of("approved")?._sum.quantity?.toFixed() ?? "0",
        pending: of("pending")?._sum.quantity?.toFixed() ?? "0",
        amountMinor: money(of("approved")?._sum.amountMinor ?? 0n),
      });
    }
    return result;
  }

  private async jobResponse(scope: Scope, jobId: string) {
    const { tx, access } = scope;
    const row = await this.row(scope, jobId);
    const { project, effective } = await this.access.project(
      scope,
      row.projectId,
      PIECE_RATE_READ_PERMISSIONS,
    );
    const writable = !["closed", "cancelled"].includes(project.status);
    const outputs = await tx.pieceRateOutput.findMany({
      where: { tenantId: access.tenantId, jobId },
      orderBy: [{ workDate: "desc" }, { recordedAt: "desc" }],
      take: PIECE_RATE_LIMITS.outputsPerJob,
    });
    return pieceRateJobResponseSchema.parse({
      job: (await this.toJobs(scope, [row], effective, writable))[0],
      outputs: await this.inputs.toOutputs(tx, access.tenantId, outputs),
    });
  }

  private async toJobs(
    scope: Scope,
    rows: JobRow[],
    effective: ReadonlySet<Permission>,
    writable: boolean,
  ): Promise<PieceRateJob[]> {
    if (!rows.length) return [];
    const { tx, access } = scope;
    const totals = await this.totals(
      tx,
      access.tenantId,
      rows.map((row) => row.id),
    );
    const names: Names = await displayNames(tx, [
      ...rows.flatMap((row) => [row.createdBy, row.decidedBy, row.closedBy]),
      ...rows.flatMap((row) =>
        row.extensions.flatMap((entry) => [entry.requestedBy, entry.decidedBy]),
      ),
    ]);
    const prepare = writable && has(effective, PIECE_RATE_JOB_PREPARE_PERMISSIONS);
    const approve = writable && has(effective, PIECE_RATE_JOB_APPROVE_PERMISSIONS);
    const record = writable && has(effective, PIECE_RATE_OUTPUT_RECORD_PERMISSIONS);
    return rows.map((row) => {
      const total = totals.get(row.id)!;
      const inForce = jobQuantityInForce(row.agreedQuantity.toFixed(), approvedExtensions(row));
      const remaining = checkJobOutput({
        inForce,
        approved: total.approved,
        pending: total.pending,
        quantity: "0",
        stage: "record",
      }).remaining;
      return {
        id: row.id,
        number: row.number,
        code: pieceRateJobCode(row.number),
        projectId: row.projectId,
        bqItem: {
          versionId: row.bqItem.versionId,
          lineageId: row.bqItem.lineageId,
          ref: row.bqItem.ref,
          description: row.bqItem.description,
          unit: row.bqItem.unit,
          bill: {
            lineageId: row.bqItem.bill.lineageId,
            number: row.bqItem.bill.number,
            title: row.bqItem.bill.title,
          },
        },
        labourer: row.labourer,
        gang: row.gang,
        description: row.description,
        unit: row.unit,
        bqUnit: row.bqUnit,
        conversionFactor: decimal(row.conversionFactor),
        rateMinor: money(row.rateMinor),
        agreedQuantity: decimal(row.agreedQuantity),
        quantityInForce: inForce,
        approvedQuantity: normaliseDecimal(total.approved),
        pendingQuantity: normaliseDecimal(total.pending),
        remainingQuantity: remaining,
        approvedAmountMinor: total.amountMinor,
        startDate: toCalendarDate(row.startDate),
        endDate: toCalendarDate(row.endDate),
        status: row.status as PieceRateJobStatus,
        createdBy: actor(names, row.createdBy),
        createdAt: row.createdAt.toISOString(),
        decidedBy: optionalActor(names, row.decidedBy),
        decidedAt: row.decidedAt?.toISOString() ?? null,
        decisionNote: row.decisionNote,
        closedBy: optionalActor(names, row.closedBy),
        closedAt: row.closedAt?.toISOString() ?? null,
        version: row.version,
        extensions: row.extensions.map((entry) => ({
          id: entry.id,
          quantity: decimal(entry.quantity),
          reason: entry.reason,
          status: entry.status as PieceRateExtensionStatus,
          requestedBy: actor(names, entry.requestedBy),
          requestedAt: entry.requestedAt.toISOString(),
          decidedBy: optionalActor(names, entry.decidedBy),
          decidedAt: entry.decidedAt?.toISOString() ?? null,
          decisionNote: entry.decisionNote,
          version: entry.version,
          permissions: {
            canApprove:
              approve && entry.status === "pending" && entry.requestedBy !== access.userId,
            canReject: approve && entry.status === "pending" && entry.requestedBy !== access.userId,
          },
        })),
        permissions: {
          canApprove: approve && row.status === "pending" && row.createdBy !== access.userId,
          canReject: approve && row.status === "pending" && row.createdBy !== access.userId,
          canClose: prepare && row.status === "approved",
          canExtend: prepare && row.status === "approved",
          canRecord: record && row.status === "approved",
        },
      };
    });
  }
}

const approvedExtensions = (row: {
  extensions: { status: string; quantity: { toFixed(): string } }[];
}) =>
  row.extensions
    .filter((entry) => entry.status === "approved")
    .map((entry) => entry.quantity.toFixed());

/**
 * Units a job on an item may use: the item's unit (factor 1) first, then every standard or
 * company unit that converts to it exactly by D5.1 sizes (factor to six decimals).
 */
export function unitsFor(
  bqUnit: string,
  custom: ReturnType<typeof unitDefinitions>,
  on: string,
): { unit: string; factor: string }[] {
  const result = [{ unit: bqUnit, factor: "1" }];
  for (const candidate of [...STANDARD_UNITS, ...custom]) {
    if (candidate.code === bqUnit) continue;
    const path = resolveConversion(candidate.code, bqUnit, { customUnits: custom, on });
    if (!path.ok) continue;
    const factor = path.ratio.toDecimal(6);
    if (factor.exact && factor.value !== "0")
      result.push({ unit: candidate.code, factor: factor.value });
  }
  return result;
}

/** Quantity certified to subcontractors per BQ item: each subcontract's latest certified claim. */
async function certifiedOnItems(tx: Tx, tenantId: string, projectId: string) {
  const certificates = await tx.subcontractCertificate.findMany({
    where: { tenantId, projectId, status: "certified" },
    orderBy: [{ subcontractId: "asc" }, { certificateNumber: "desc" }],
    select: { id: true, subcontractId: true, revision: true },
  });
  const latest = new Map<string, (typeof certificates)[number]>();
  for (const row of certificates)
    if (!latest.has(row.subcontractId)) latest.set(row.subcontractId, row);
  const result = new Map<string, string>();
  for (const certificate of latest.values())
    for (const line of await tx.subcontractCertificateLine.findMany({
      where: { tenantId, certificateId: certificate.id, revision: certificate.revision },
      select: { bqItemLineageId: true, quantityToDate: true },
    }))
      result.set(
        line.bqItemLineageId,
        sumQuantities([result.get(line.bqItemLineageId) ?? "0", line.quantityToDate.toFixed()]),
      );
  return result;
}
