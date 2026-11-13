import { Injectable, NotFoundException } from "@nestjs/common";
import { nairobiDate, outputAmountMinor, splitEqually, normaliseDecimal } from "@pm-buddy/domain";
import type { OutputStatus } from "@pm-buddy/types";
import {
  allowanceResponseSchema,
  allowancesResponseSchema,
  outputResponseSchema,
  outputsResponseSchema,
  type Allowance,
  type approveOutputRequestSchema,
  type createAllowanceRequestSchema,
  type createOutputRequestSchema,
  type endAllowanceRequestSchema,
  type outputListQuerySchema,
  type PieceRateOutput,
  type rejectOutputRequestSchema,
} from "@pm-buddy/validation";
import type { Request } from "express";
import type { z } from "zod";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { displayNames } from "../labour/labour-mappers.js";
import { fromCalendarDate, toCalendarDate } from "../projects/project-mappers.js";
import { actor, iso, optionalActor, type Names } from "./payroll-mappers.js";
import {
  PAYROLL_VIEW,
  PayrollAccess,
  PayrollCommands,
  money,
  payrollBadRequest,
  payrollConflict,
  samePerson,
  versionConflict,
} from "./payroll-support.js";

type Tx = Prisma.TransactionClient;

const OUTPUT_VIEW = [...PAYROLL_VIEW, "attendance.record", "timesheets.approve"] as const;
const OUTPUT_RECORD = ["attendance.record", "payroll.prepare"] as const;

/**
 * Earnings inputs besides attendance (D4.1): allowances per project, trade or labourer (taxable or
 * not; never edited, only ended) and piece-rate output per labourer or gang per day, approved by
 * someone other than the recorder. Approval splits a gang's output equally between the members on
 * that day (CR-PAY-16) and writes the shares payroll consumes.
 */
@Injectable()
export class PayrollInputsService {
  constructor(
    private readonly access: PayrollAccess,
    private readonly commands: PayrollCommands,
  ) {}

  // Allowances ------------------------------------------------------------------------------------

  allowances(principal: Principal, projectId: string, req: Request) {
    return this.commands.read(principal, req, async (scope) => {
      const { project, effective } = await this.access.project(scope, projectId, PAYROLL_VIEW);
      return this.allowancesView(scope, project, effective.has("payroll.prepare"));
    });
  }

  createAllowance(
    principal: Principal,
    projectId: string,
    input: z.output<typeof createAllowanceRequestSchema>,
    req: Request,
  ) {
    return this.commands.run(
      principal,
      req,
      "payroll.allowance.create",
      { projectId, input },
      async (scope) => {
        const { tx, access } = scope;
        const { project } = await this.access.project(scope, projectId, ["payroll.prepare"]);
        this.access.assertWritable(project);
        if (input.labourerId) {
          const engaged = await tx.labourEngagement.count({
            where: { tenantId: access.tenantId, projectId, labourerId: input.labourerId },
          });
          if (!engaged)
            throw payrollConflict("not-engaged", "The labourer is not engaged on this project.");
        }
        if (input.tradeId) {
          const trade = await tx.trade.findUnique({
            where: { tenantId_id: { tenantId: access.tenantId, id: input.tradeId } },
          });
          if (!trade) throw new NotFoundException("Trade not found");
        }
        const row = await tx.payrollAllowance.create({
          data: {
            tenantId: access.tenantId,
            projectId,
            code: input.code,
            nameEn: input.nameEn,
            nameSw: input.nameSw,
            basis: input.basis,
            amountMinor: BigInt(input.amountMinor),
            taxable: input.taxable,
            tradeId: input.tradeId,
            labourerId: input.labourerId,
            effectiveFrom: fromCalendarDate(input.effectiveFrom),
            createdBy: access.userId,
          },
        });
        await this.commands.audit(scope, "payroll.allowance_created", row.id, {
          projectId,
          code: input.code,
          basis: input.basis,
          scope: input.labourerId ? "labourer" : input.tradeId ? "trade" : "project",
          taxable: input.taxable,
        });
        return allowanceResponseSchema.parse({ allowance: await this.allowance(tx, row.id) });
      },
    );
  }

  endAllowance(
    principal: Principal,
    allowanceId: string,
    input: z.output<typeof endAllowanceRequestSchema>,
    req: Request,
  ) {
    return this.commands.run(
      principal,
      req,
      "payroll.allowance.end",
      { allowanceId, input },
      async (scope) => {
        const { tx, access } = scope;
        const row = await tx.payrollAllowance.findUnique({
          where: { tenantId_id: { tenantId: access.tenantId, id: allowanceId } },
        });
        if (!row) throw new NotFoundException("Allowance not found");
        const { project } = await this.access.project(scope, row.projectId, ["payroll.prepare"]);
        this.access.assertWritable(project);
        if (row.endedOn) throw payrollConflict("allowance-ended", "This allowance has ended.");
        if (input.endedOn < toCalendarDate(row.effectiveFrom))
          throw payrollBadRequest("allowance-ended", "An allowance cannot end before it starts.");
        await tx.payrollAllowance.update({
          where: { tenantId_id: { tenantId: access.tenantId, id: allowanceId } },
          data: { endedOn: fromCalendarDate(input.endedOn), endedBy: access.userId },
        });
        await this.commands.audit(scope, "payroll.allowance_ended", allowanceId, {
          projectId: row.projectId,
        });
        return allowanceResponseSchema.parse({ allowance: await this.allowance(tx, allowanceId) });
      },
    );
  }

  private async allowancesView(
    scope: Scope,
    project: { id: string; code: string; name: string },
    canManage: boolean,
  ) {
    const { tx, access } = scope;
    const rows = await withRefs(
      tx,
      access.tenantId,
      await tx.payrollAllowance.findMany({
        where: { tenantId: access.tenantId, projectId: project.id },
        orderBy: [{ code: "asc" }, { effectiveFrom: "desc" }],
      }),
    );
    const names = await displayNames(
      tx,
      rows.map((row) => row.createdBy),
    );
    const trades = await tx.trade.findMany({
      where: { tenantId: access.tenantId, active: true },
      orderBy: [{ sortOrder: "asc" }, { nameEn: "asc" }],
    });
    return allowancesResponseSchema.parse({
      project: { id: project.id, code: project.code, name: project.name },
      today: nairobiDate(),
      allowances: rows.map((row) => toAllowance(row, names)),
      trades: trades.map((trade) => ({ id: trade.id, nameEn: trade.nameEn, nameSw: trade.nameSw })),
      canManage,
    });
  }

  private async allowance(tx: Tx, id: string): Promise<Allowance> {
    const [row] = await withRefs(tx, null, [
      await tx.payrollAllowance.findFirstOrThrow({ where: { id } }),
    ]);
    const names = await displayNames(tx, [row.createdBy]);
    return toAllowance(row!, names);
  }

  // Piece-rate output -----------------------------------------------------------------------------

  outputs(
    principal: Principal,
    projectId: string,
    query: z.output<typeof outputListQuerySchema>,
    req: Request,
  ) {
    return this.commands.read(principal, req, async (scope) => {
      const { project, effective } = await this.access.project(scope, projectId, OUTPUT_VIEW);
      const { tx, access } = scope;
      const rows = await tx.pieceRateOutput.findMany({
        where: {
          tenantId: access.tenantId,
          projectId,
          ...(query.status ? { status: query.status } : {}),
        },
        orderBy: [{ workDate: "desc" }, { recordedAt: "desc" }],
        take: 300,
      });
      const outputs = await this.toOutputs(tx, access.tenantId, rows);
      const gangs = await tx.gang.findMany({
        where: { tenantId: access.tenantId, projectId, status: "active" },
        include: { members: { where: { leftOn: null } } },
        orderBy: { name: "asc" },
      });
      return outputsResponseSchema.parse({
        project: { id: project.id, code: project.code, name: project.name },
        today: nairobiDate(),
        outputs,
        gangs: gangs.map((gang) => ({
          id: gang.id,
          name: gang.name,
          members: gang.members.length,
        })),
        permissions: {
          canRecord: OUTPUT_RECORD.some((permission) => effective.has(permission)),
          canDecide: effective.has("timesheets.approve"),
        },
      });
    });
  }

  createOutput(
    principal: Principal,
    projectId: string,
    input: z.output<typeof createOutputRequestSchema>,
    req: Request,
  ) {
    return this.commands.run(
      principal,
      req,
      "payroll.output.create",
      { projectId, input },
      async (scope) => {
        const { tx, access } = scope;
        const { project } = await this.access.project(scope, projectId, OUTPUT_RECORD);
        this.access.assertWritable(project);
        if (input.workDate > nairobiDate())
          throw payrollBadRequest("date-in-future", "Output cannot be recorded for a future date.");
        if (input.labourerId) {
          const engaged = await tx.labourEngagement.count({
            where: {
              tenantId: access.tenantId,
              projectId,
              labourerId: input.labourerId,
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
        if (input.gangId) {
          const gang = await tx.gang.findFirst({
            where: { tenantId: access.tenantId, projectId, id: input.gangId },
          });
          if (!gang) throw new NotFoundException("Gang not found");
          if (!(await this.gangMembers(tx, access.tenantId, input.gangId, input.workDate)).length)
            throw payrollConflict("gang-empty", "The gang had no members on that date.");
        }
        if (input.bqItemId) {
          const item = await tx.bqItem.findFirst({
            where: { tenantId: access.tenantId, id: input.bqItemId },
            select: { versionId: true },
          });
          const version = item
            ? await tx.bqVersion.findFirst({
                where: { tenantId: access.tenantId, id: item.versionId },
                select: { projectId: true },
              })
            : null;
          if (!version || version.projectId !== projectId)
            throw payrollConflict("bq-item-not-in-project", "The BQ item is not on this project.");
        }
        const row = await tx.pieceRateOutput.create({
          data: {
            tenantId: access.tenantId,
            projectId,
            workDate: fromCalendarDate(input.workDate),
            labourerId: input.labourerId,
            gangId: input.gangId,
            bqItemId: input.bqItemId,
            description: input.description,
            unit: input.unit,
            quantity: input.quantity,
            rateMinor: BigInt(input.rateMinor),
            amountMinor: BigInt(outputAmountMinor(input.quantity, input.rateMinor)),
            recordedBy: access.userId,
          },
        });
        await this.commands.audit(scope, "payroll.output_recorded", row.id, {
          projectId,
          workDate: input.workDate,
          gang: Boolean(input.gangId),
        });
        return outputResponseSchema.parse({
          output: (await this.toOutputs(tx, access.tenantId, [row]))[0],
        });
      },
    );
  }

  approveOutput(
    principal: Principal,
    outputId: string,
    input: z.output<typeof approveOutputRequestSchema>,
    req: Request,
  ) {
    return this.commands.run(
      principal,
      req,
      "payroll.output.approve",
      { outputId, input },
      async (scope) => {
        const { tx, access } = scope;
        const row = await this.decidable(scope, outputId, input.version);
        const members = row.labourerId
          ? [{ labourerId: row.labourerId }]
          : await this.gangMembers(tx, access.tenantId, row.gangId!, toCalendarDate(row.workDate));
        if (!members.length)
          throw payrollConflict("gang-empty", "The gang had no members on that date.");
        const amounts = splitEqually(money(row.amountMinor), members.length);
        const updated = await tx.pieceRateOutput.updateMany({
          where: {
            tenantId: access.tenantId,
            id: outputId,
            version: input.version,
            status: "pending",
          },
          data: {
            status: "approved",
            decidedBy: access.userId,
            decisionNote: input.note?.length ? input.note : null,
            version: { increment: 1 },
          },
        });
        if (!updated.count) throw versionConflict();
        await tx.pieceRateOutputShare.createMany({
          data: members.map((member, index) => ({
            tenantId: access.tenantId,
            projectId: row.projectId,
            outputId,
            labourerId: member.labourerId,
            workDate: row.workDate,
            amountMinor: BigInt(amounts[index]!),
          })),
        });
        await this.commands.audit(scope, "payroll.output_approved", outputId, {
          projectId: row.projectId,
          shares: members.length,
        });
        return this.outputResponse(tx, access.tenantId, outputId);
      },
    );
  }

  rejectOutput(
    principal: Principal,
    outputId: string,
    input: z.output<typeof rejectOutputRequestSchema>,
    req: Request,
  ) {
    return this.commands.run(
      principal,
      req,
      "payroll.output.reject",
      { outputId, input },
      async (scope) => {
        const { tx, access } = scope;
        const row = await this.decidable(scope, outputId, input.version);
        const updated = await tx.pieceRateOutput.updateMany({
          where: {
            tenantId: access.tenantId,
            id: outputId,
            version: input.version,
            status: "pending",
          },
          data: {
            status: "rejected",
            decidedBy: access.userId,
            decisionNote: input.note,
            version: { increment: 1 },
          },
        });
        if (!updated.count) throw versionConflict();
        await this.commands.audit(scope, "payroll.output_rejected", outputId, {
          projectId: row.projectId,
          noteGiven: true,
        });
        return this.outputResponse(tx, access.tenantId, outputId);
      },
    );
  }

  private async decidable(scope: Scope, outputId: string, version: number) {
    const { tx, access } = scope;
    const row = await tx.pieceRateOutput.findUnique({
      where: { tenantId_id: { tenantId: access.tenantId, id: outputId } },
    });
    if (!row) throw new NotFoundException("Output not found");
    await this.access.project(scope, row.projectId, ["timesheets.approve"]);
    if (row.version !== version) throw versionConflict();
    if (row.status !== "pending")
      throw payrollConflict("invalid-transition", "This output was already decided.");
    if (row.recordedBy === access.userId)
      throw samePerson("The person who recorded the output cannot decide it.");
    return row;
  }

  /** Current members of a gang on a date, by worker number (the equal-split order). */
  private async gangMembers(tx: Tx, tenantId: string, gangId: string, date: string) {
    const day = fromCalendarDate(date);
    const rows = await tx.gangMembership.findMany({
      where: {
        tenantId,
        gangId,
        joinedOn: { lte: day },
        OR: [{ leftOn: null }, { leftOn: { gte: day } }],
      },
      include: { labourer: { select: { workerNo: true } } },
    });
    const gang = await tx.gang.findFirstOrThrow({ where: { tenantId, id: gangId } });
    const engaged = await tx.labourEngagement.findMany({
      where: {
        tenantId,
        projectId: gang.projectId,
        labourerId: { in: rows.map((row) => row.labourerId) },
        startDate: { lte: day },
        OR: [{ endDate: null }, { endDate: { gte: day } }],
      },
      select: { labourerId: true },
    });
    const engagedIds = new Set(engaged.map((row) => row.labourerId));
    return [...new Map(rows.map((row) => [row.labourerId, row])).values()]
      .filter((row) => engagedIds.has(row.labourerId))
      .sort((a, b) => a.labourer.workerNo.localeCompare(b.labourer.workerNo))
      .map((row) => ({ labourerId: row.labourerId }));
  }

  private async outputResponse(tx: Tx, tenantId: string, outputId: string) {
    const row = await tx.pieceRateOutput.findUniqueOrThrow({
      where: { tenantId_id: { tenantId, id: outputId } },
    });
    return outputResponseSchema.parse({ output: (await this.toOutputs(tx, tenantId, [row]))[0] });
  }

  private async toOutputs(
    tx: Tx,
    tenantId: string,
    rows: Prisma.PieceRateOutputGetPayload<object>[],
  ): Promise<PieceRateOutput[]> {
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
    const shareRows = await tx.pieceRateOutputShare.findMany({
      where: { tenantId, outputId: { in: ids } },
    });
    const shareLabourers = await tx.labourer.findMany({
      where: { tenantId, id: { in: [...new Set(shareRows.map((share) => share.labourerId))] } },
      select: { id: true, workerNo: true, fullName: true },
    });
    const consumed = shareRows.length
      ? await tx.payrollConsumption.findMany({
          where: {
            tenantId,
            shareId: { in: shareRows.map((share) => share.id) },
            activeMarker: "active",
          },
          select: { shareId: true, batchId: true },
        })
      : [];
    const shares = shareRows.map((share) => ({
      ...share,
      labourer: shareLabourers.find((labourer) => labourer.id === share.labourerId)!,
      consumptions: consumed.filter((entry) => entry.shareId === share.id),
    }));
    const labourers = await tx.labourer.findMany({
      where: {
        tenantId,
        id: { in: rows.flatMap((row) => (row.labourerId ? [row.labourerId] : [])) },
      },
      select: { id: true, workerNo: true, fullName: true },
    });
    const gangs = await tx.gang.findMany({
      where: { tenantId, id: { in: rows.flatMap((row) => (row.gangId ? [row.gangId] : [])) } },
      select: { id: true, name: true },
    });
    const items = await tx.bqItem.findMany({
      where: { tenantId, id: { in: rows.flatMap((row) => (row.bqItemId ? [row.bqItemId] : [])) } },
      select: { id: true, ref: true },
    });
    const names: Names = await displayNames(tx, [
      ...rows.map((row) => row.recordedBy),
      ...rows.map((row) => row.decidedBy),
    ]);
    return rows.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      workDate: toCalendarDate(row.workDate),
      labourer: labourers.find((entry) => entry.id === row.labourerId) ?? null,
      gang: gangs.find((entry) => entry.id === row.gangId) ?? null,
      bqItem: items.find((entry) => entry.id === row.bqItemId) ?? null,
      description: row.description,
      unit: row.unit,
      quantity: normaliseDecimal(row.quantity.toString()),
      rateMinor: money(row.rateMinor),
      amountMinor: money(row.amountMinor),
      status: row.status as OutputStatus,
      version: row.version,
      recordedBy: actor(names, row.recordedBy),
      recordedAt: row.recordedAt.toISOString(),
      decidedBy: optionalActor(names, row.decidedBy),
      decidedAt: iso(row.decidedAt),
      decisionNote: row.decisionNote,
      shares: shares
        .filter((share) => share.outputId === row.id)
        .sort((a, b) => a.labourer.workerNo.localeCompare(b.labourer.workerNo))
        .map((share) => ({
          id: share.id,
          labourer: share.labourer,
          amountMinor: money(share.amountMinor),
          batchId: share.consumptions[0]?.batchId ?? null,
        })),
    }));
  }
}

type AllowanceRow = Prisma.PayrollAllowanceGetPayload<object> & {
  trade: { id: string; nameEn: string; nameSw: string } | null;
  labourer: { id: string; workerNo: string; fullName: string } | null;
};

/** Adds each allowance's trade and labourer (one query at a time in the transaction). */
async function withRefs(
  tx: Tx,
  tenantId: string | null,
  rows: Prisma.PayrollAllowanceGetPayload<object>[],
): Promise<AllowanceRow[]> {
  const scoped = (ids: string[]) => ({
    ...(tenantId ? { tenantId } : {}),
    id: { in: [...new Set(ids)] },
  });
  const trades = await tx.trade.findMany({
    where: scoped(rows.flatMap((row) => (row.tradeId ? [row.tradeId] : []))),
    select: { id: true, nameEn: true, nameSw: true },
  });
  const labourers = await tx.labourer.findMany({
    where: scoped(rows.flatMap((row) => (row.labourerId ? [row.labourerId] : []))),
    select: { id: true, workerNo: true, fullName: true },
  });
  return rows.map((row) => ({
    ...row,
    trade: trades.find((trade) => trade.id === row.tradeId) ?? null,
    labourer: labourers.find((labourer) => labourer.id === row.labourerId) ?? null,
  }));
}

function toAllowance(row: AllowanceRow, names: Names): Allowance {
  return {
    id: row.id,
    projectId: row.projectId,
    code: row.code,
    nameEn: row.nameEn,
    nameSw: row.nameSw,
    basis: row.basis as Allowance["basis"],
    amountMinor: money(row.amountMinor),
    taxable: row.taxable,
    trade: row.trade
      ? { id: row.trade.id, nameEn: row.trade.nameEn, nameSw: row.trade.nameSw }
      : null,
    labourer: row.labourer
      ? { id: row.labourer.id, workerNo: row.labourer.workerNo, fullName: row.labourer.fullName }
      : null,
    effectiveFrom: toCalendarDate(row.effectiveFrom),
    endedOn: row.endedOn ? toCalendarDate(row.endedOn) : null,
    createdBy: actor(names, row.createdBy),
    createdAt: row.createdAt.toISOString(),
  };
}
