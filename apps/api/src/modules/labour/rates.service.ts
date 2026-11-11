import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import { nairobiDate, rateEffectiveTo, resolveRate, type RateCandidate } from "@pm-buddy/domain";
import type { Permission, RateBasis } from "@pm-buddy/types";
import {
  labourRateResponseSchema,
  labourRatesResponseSchema,
  resolvedRateResponseSchema,
  type CreateLabourRateInput,
} from "@pm-buddy/validation";
import type { z } from "zod";
import type { labourRateListQuerySchema, resolvedRateQuerySchema } from "@pm-buddy/validation";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { fromCalendarDate, toCalendarDate } from "../projects/project-mappers.js";
import { displayNames, toRate, type RateRow } from "./labour-mappers.js";
import {
  LabourAccess,
  labourBadRequest,
  labourConflict,
  rethrowLabourDbError,
} from "./labour-support.js";

// COMPLIANCE-REVIEW: CR-PAY-09. Rates are not checked against a statutory minimum wage until an
// authorised reviewer approves a wage table (`payroll.minimum_wage_table`); the API says so
// explicitly instead of inventing a minimum.
const MINIMUM_WAGE = { status: "not_configured", reference: "CR-PAY-09" } as const;
const READERS: Permission[] = ["labour.manage", "finance.view"];

const candidate = (row: RateRow): RateCandidate & { row: RateRow } => ({
  id: row.id,
  projectId: row.projectId,
  labourerId: row.labourerId,
  tradeId: row.tradeId,
  skillLevelId: row.skillLevelId,
  basis: row.basis as RateBasis,
  rateMinor: Number(row.rateMinor),
  effectiveFrom: toCalendarDate(row.effectiveFrom),
  row,
});

/**
 * Effective-dated labour rates (D3.1): company defaults per trade (and skill level), project rates
 * and a labourer's own rate on a project, in KES minor units. A new rate is a new row starting today
 * or later; rows are never updated, and only a rate that has not started can be cancelled.
 */
@Injectable()
export class LabourRatesService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: LabourAccess,
  ) {}

  list(principal: Principal, query: z.output<typeof labourRateListQuerySchema>, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      if (query.projectId) await this.access.requireAnyOnProject(scope, READERS, query.projectId);
      else await this.requireReaderSomewhere(scope);
      const rows = await tx.labourRate.findMany({
        where: {
          tenantId: access.tenantId,
          OR: [{ projectId: null }, ...(query.projectId ? [{ projectId: query.projectId }] : [])],
          ...(query.tradeId ? { tradeId: query.tradeId } : {}),
          ...(query.labourerId ? { labourerId: query.labourerId } : {}),
        },
        orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
      });
      return labourRatesResponseSchema.parse({
        rates: await this.wire(tx, rows),
        today: nairobiDate(),
        minimumWage: MINIMUM_WAGE,
      });
    });
  }

  create(principal: Principal, input: CreateLabourRateInput, req: Request) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          const projectId = input.projectId ?? null;
          await this.requireWriter(scope, projectId);
          if (input.effectiveFrom < nairobiDate())
            throw labourBadRequest(
              "rate-backdated",
              "A new rate starts today or later; past days keep the rate they had.",
            );
          if (input.tradeId) await this.exists(tx, "trade", access.tenantId, input.tradeId);
          if (input.skillLevelId)
            await this.exists(tx, "skillLevel", access.tenantId, input.skillLevelId);
          if (input.labourerId) {
            const engaged = await tx.labourEngagement.findFirst({
              where: {
                tenantId: access.tenantId,
                labourerId: input.labourerId,
                projectId: projectId!,
              },
              select: { id: true },
            });
            if (!engaged)
              throw new NotFoundException("The labourer is not engaged on this project");
          }
          const row = await tx.labourRate.create({
            data: {
              tenantId: access.tenantId,
              projectId,
              labourerId: input.labourerId ?? null,
              tradeId: input.tradeId ?? null,
              skillLevelId: input.skillLevelId ?? null,
              basis: input.basis,
              rateMinor: BigInt(input.rateMinor),
              effectiveFrom: fromCalendarDate(input.effectiveFrom),
              createdBy: access.userId,
            },
          });
          // Amounts and the labourer's pay stay out of the audit log; the scope and dates suffice.
          await this.scope.audit(tx, "labour.rate_created", row.id, {
            projectId,
            labourerId: row.labourerId,
            tradeId: row.tradeId,
            skillLevelId: row.skillLevelId,
            basis: row.basis,
            effectiveFrom: input.effectiveFrom,
          });
          const [rate] = await this.wire(tx, [row], await this.history(tx, row));
          return labourRateResponseSchema.parse({ rate, minimumWage: MINIMUM_WAGE });
        },
        true,
      )
      .catch((error: unknown) => rethrowLabourDbError(error, "rate-exists"));
  }

  cancel(principal: Principal, rateId: string, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const row = await tx.labourRate.findUnique({
          where: { tenantId_id: { tenantId: access.tenantId, id: rateId } },
        });
        if (!row) throw new NotFoundException("Rate not found");
        await this.requireWriter(scope, row.projectId);
        if (toCalendarDate(row.effectiveFrom) <= nairobiDate())
          throw labourConflict(
            "rate-in-force",
            "This rate has started and may have been used; add a new rate instead.",
          );
        await tx.labourRate.delete({
          where: { tenantId_id: { tenantId: access.tenantId, id: rateId } },
        });
        await this.scope.audit(tx, "labour.rate_cancelled", rateId, {
          effectiveFrom: toCalendarDate(row.effectiveFrom),
        });
        return { message: "Scheduled rate cancelled." };
      },
      true,
    );
  }

  /** The rate in force for a labourer on a project and date (domain `resolveRate`). */
  resolve(
    principal: Principal,
    labourerId: string,
    query: z.output<typeof resolvedRateQuerySchema>,
    req: Request,
  ) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      await this.access.requireAnyOnProject(scope, READERS, query.projectId);
      const labourer = await tx.labourer.findUnique({
        where: { tenantId_id: { tenantId: access.tenantId, id: labourerId } },
        select: { tradeId: true, skillLevelId: true, rateBasis: true },
      });
      const engaged = labourer
        ? await tx.labourEngagement.findFirst({
            where: { tenantId: access.tenantId, labourerId, projectId: query.projectId },
            select: { id: true },
          })
        : null;
      if (!labourer || !engaged) throw new NotFoundException("Labourer not found on this project");
      const onDate = query.date ?? nairobiDate();
      const basis = query.basis ?? (labourer.rateBasis as RateBasis);
      const rows = await tx.labourRate.findMany({
        where: {
          tenantId: access.tenantId,
          basis,
          OR: [
            { labourerId, projectId: query.projectId },
            { labourerId: null, tradeId: labourer.tradeId, projectId: query.projectId },
            { labourerId: null, tradeId: labourer.tradeId, projectId: null },
          ],
        },
      });
      const candidates = rows.map(candidate);
      const resolved = resolveRate(candidates, {
        onDate,
        basis,
        projectId: query.projectId,
        labourerId,
        tradeId: labourer.tradeId,
        skillLevelId: labourer.skillLevelId,
      });
      const [rate] = resolved ? await this.wire(tx, [resolved.rate.row], rows) : [null];
      return resolvedRateResponseSchema.parse({
        labourerId,
        projectId: query.projectId,
        onDate,
        basis,
        rate,
        minimumWage: MINIMUM_WAGE,
      });
    });
  }

  private async requireReaderSomewhere(scope: Scope) {
    for (const permission of READERS)
      if (
        await this.access.projectsWith(scope, permission).then((set) => set === "all" || set.length)
      )
        return;
    throw new ForbiddenException("Permission required: labour.manage or finance.view");
  }

  /** Company rates need config.manage; project and labourer rates labour.manage on the project. */
  private async requireWriter(scope: Scope, projectId: string | null) {
    if (projectId) {
      await this.access.requireOnProject(scope, "labour.manage", projectId);
      return;
    }
    if (!scope.access.permissions.has("config.manage"))
      throw new ForbiddenException("Permission required: config.manage");
  }

  private async exists(
    tx: Prisma.TransactionClient,
    model: "trade" | "skillLevel",
    tenantId: string,
    id: string,
  ) {
    const found =
      model === "trade"
        ? await tx.trade.findFirst({ where: { tenantId, id }, select: { id: true } })
        : await tx.skillLevel.findFirst({ where: { tenantId, id }, select: { id: true } });
    if (!found)
      throw new NotFoundException(model === "trade" ? "Trade not found" : "Skill level not found");
  }

  private history(tx: Prisma.TransactionClient, row: RateRow) {
    return tx.labourRate.findMany({ where: { tenantId: row.tenantId, scopeKey: row.scopeKey } });
  }

  /** Wire rows with `effectiveTo` derived from the rows of the same kind. */
  private async wire(tx: Prisma.TransactionClient, rows: RateRow[], all: RateRow[] = rows) {
    const today = nairobiDate();
    const names = await displayNames(
      tx,
      rows.map((row) => row.createdBy),
    );
    const everything = all.map(candidate);
    return rows.map((row) =>
      toRate(row, rateEffectiveTo(candidate(row), everything), today, names),
    );
  }
}
