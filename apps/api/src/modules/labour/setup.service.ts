import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import {
  DEFAULT_ACCREDITATION_ALERT_DAYS,
  DEFAULT_SKILL_LEVELS,
  DEFAULT_TRADES,
} from "@pm-buddy/types";
import {
  labourSetupResponseSchema,
  skillLevelResponseSchema,
  tradeResponseSchema,
} from "@pm-buddy/validation";
import type { z } from "zod";
import type {
  createSkillLevelRequestSchema,
  createTradeRequestSchema,
  updateLabourSettingsRequestSchema,
  updateSkillLevelRequestSchema,
  updateTradeRequestSchema,
} from "@pm-buddy/validation";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { isEmpty, LabourAccess, rethrowLabourDbError, versionConflict } from "./labour-support.js";
import { toSkillLevel, toTrade } from "./labour-mappers.js";

type Tx = Prisma.TransactionClient;
const changedFields = (input: object) =>
  Object.entries(input)
    .filter(([key, value]) => key !== "version" && value !== undefined)
    .map(([key]) => key)
    .sort();

/** The company's alert lead time (`labour.accreditation_alert_days`, default 30). */
export async function alertDays(tx: Tx, tenantId: string): Promise<number> {
  const settings = await tx.labourSettings.findUnique({ where: { tenantId } });
  return settings?.accreditationAlertDays ?? DEFAULT_ACCREDITATION_ALERT_DAYS;
}

/**
 * Company labour configuration (D3.1): trades, skill levels and settings. Reading needs any labour
 * permission or config.manage; changing needs config.manage (company-level) and is audited.
 */
@Injectable()
export class LabourSetupService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: LabourAccess,
  ) {}

  get(principal: Principal, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const canConfigure = scope.access.permissions.has("config.manage");
      if (!canConfigure && isEmpty(await this.access.projectsWith(scope, "labour.view")))
        throw new ForbiddenException("Permission required: labour.view");
      return this.setup(scope);
    });
  }

  installDefaults(principal: Principal, req: Request) {
    return this.mutate(principal, req, async (scope) => {
      const { tx, access } = scope;
      const trades = await tx.trade.findMany({
        where: { tenantId: access.tenantId },
        select: { key: true },
      });
      const levels = await tx.skillLevel.findMany({
        where: { tenantId: access.tenantId },
        select: { key: true },
      });
      const haveTrades = new Set(trades.map((trade) => trade.key));
      const haveLevels = new Set(levels.map((level) => level.key));
      const newTrades = DEFAULT_TRADES.filter((trade) => !haveTrades.has(trade.key));
      const newLevels = DEFAULT_SKILL_LEVELS.filter((level) => !haveLevels.has(level.key));
      for (const [index, trade] of DEFAULT_TRADES.entries())
        if (newTrades.includes(trade))
          await tx.trade.create({
            data: {
              tenantId: access.tenantId,
              key: trade.key,
              nameEn: trade.nameEn,
              nameSw: trade.nameSw,
              sortOrder: index * 10,
              createdBy: access.userId,
            },
          });
      for (const [index, level] of DEFAULT_SKILL_LEVELS.entries())
        if (newLevels.includes(level))
          await tx.skillLevel.create({
            data: {
              tenantId: access.tenantId,
              key: level.key,
              nameEn: level.nameEn,
              nameSw: level.nameSw,
              ncaCategory: level.ncaCategory,
              accreditationExpected: level.accreditationExpected,
              sortOrder: index * 10,
              createdBy: access.userId,
            },
          });
      await this.scope.audit(tx, "labour.defaults_installed", access.tenantId, {
        trades: newTrades.length,
        skillLevels: newLevels.length,
      });
      return this.setup(scope);
    });
  }

  createTrade(
    principal: Principal,
    input: z.output<typeof createTradeRequestSchema>,
    req: Request,
  ) {
    return this.mutate(
      principal,
      req,
      async (scope) => {
        const row = await scope.tx.trade.create({
          data: {
            tenantId: scope.access.tenantId,
            key: input.key,
            nameEn: input.nameEn,
            nameSw: input.nameSw,
            sortOrder: input.sortOrder ?? 1_000,
            createdBy: scope.access.userId,
          },
        });
        await this.scope.audit(scope.tx, "labour.trade_created", row.id, { key: row.key });
        return tradeResponseSchema.parse({ trade: toTrade(row) });
      },
      "trade-key-taken",
    );
  }

  updateTrade(
    principal: Principal,
    tradeId: string,
    input: z.output<typeof updateTradeRequestSchema>,
    req: Request,
  ) {
    return this.mutate(principal, req, async (scope) => {
      const { version, ...fields } = input;
      const where = { tenantId: scope.access.tenantId, id: tradeId };
      if (!(await scope.tx.trade.findFirst({ where, select: { id: true } })))
        throw new NotFoundException("Trade not found");
      const updated = await scope.tx.trade.updateMany({
        where: { ...where, version },
        data: { ...fields, version: { increment: 1 } },
      });
      if (!updated.count) throw versionConflict();
      await this.scope.audit(scope.tx, "labour.trade_updated", tradeId, {
        fields: changedFields(fields),
      });
      const row = await scope.tx.trade.findFirstOrThrow({ where });
      return tradeResponseSchema.parse({ trade: toTrade(row) });
    });
  }

  createSkillLevel(
    principal: Principal,
    input: z.output<typeof createSkillLevelRequestSchema>,
    req: Request,
  ) {
    return this.mutate(
      principal,
      req,
      async (scope) => {
        const row = await scope.tx.skillLevel.create({
          data: {
            tenantId: scope.access.tenantId,
            key: input.key,
            nameEn: input.nameEn,
            nameSw: input.nameSw,
            ncaCategory: input.ncaCategory,
            accreditationExpected: input.accreditationExpected,
            sortOrder: input.sortOrder ?? 1_000,
            createdBy: scope.access.userId,
          },
        });
        await this.scope.audit(scope.tx, "labour.skill_level_created", row.id, {
          key: row.key,
          ncaCategory: row.ncaCategory,
        });
        return skillLevelResponseSchema.parse({ skillLevel: toSkillLevel(row) });
      },
      "skill-level-key-taken",
    );
  }

  updateSkillLevel(
    principal: Principal,
    skillLevelId: string,
    input: z.output<typeof updateSkillLevelRequestSchema>,
    req: Request,
  ) {
    return this.mutate(principal, req, async (scope) => {
      const { version, ...fields } = input;
      const where = { tenantId: scope.access.tenantId, id: skillLevelId };
      if (!(await scope.tx.skillLevel.findFirst({ where, select: { id: true } })))
        throw new NotFoundException("Skill level not found");
      const updated = await scope.tx.skillLevel.updateMany({
        where: { ...where, version },
        data: { ...fields, version: { increment: 1 } },
      });
      if (!updated.count) throw versionConflict();
      await this.scope.audit(scope.tx, "labour.skill_level_updated", skillLevelId, {
        fields: changedFields(fields),
      });
      const row = await scope.tx.skillLevel.findFirstOrThrow({ where });
      return skillLevelResponseSchema.parse({ skillLevel: toSkillLevel(row) });
    });
  }

  updateSettings(
    principal: Principal,
    input: z.output<typeof updateLabourSettingsRequestSchema>,
    req: Request,
  ) {
    return this.mutate(principal, req, async (scope) => {
      const { tx, access } = scope;
      const current = await tx.labourSettings.findUnique({ where: { tenantId: access.tenantId } });
      if ((current?.version ?? 0) !== input.version) throw versionConflict();
      if (current)
        await tx.labourSettings.update({
          where: { tenantId: access.tenantId },
          data: {
            accreditationAlertDays: input.accreditationAlertDays,
            updatedBy: access.userId,
            version: { increment: 1 },
          },
        });
      else
        await tx.labourSettings.create({
          data: {
            tenantId: access.tenantId,
            accreditationAlertDays: input.accreditationAlertDays,
            updatedBy: access.userId,
          },
        });
      await this.scope.audit(tx, "labour.settings_updated", access.tenantId, {
        accreditationAlertDays: input.accreditationAlertDays,
      });
      return this.setup(scope);
    });
  }

  private async setup(scope: Scope) {
    const { tx, access } = scope;
    const trades = await tx.trade.findMany({
      where: { tenantId: access.tenantId },
      orderBy: [{ sortOrder: "asc" }, { nameEn: "asc" }],
    });
    const skillLevels = await tx.skillLevel.findMany({
      where: { tenantId: access.tenantId },
      orderBy: [{ sortOrder: "asc" }, { nameEn: "asc" }],
    });
    const settings = await tx.labourSettings.findUnique({ where: { tenantId: access.tenantId } });
    const manage = await this.access.projectsWith(scope, "labour.manage");
    const manageableProjects =
      manage === "all" || manage.length
        ? await tx.project.findMany({
            where: {
              tenantId: access.tenantId,
              status: { notIn: ["closed", "cancelled"] },
              ...(manage === "all" ? {} : { id: { in: [...manage] } }),
            },
            select: { id: true, code: true, name: true },
            orderBy: { code: "asc" },
          })
        : [];
    return labourSetupResponseSchema.parse({
      trades: trades.map(toTrade),
      skillLevels: skillLevels.map(toSkillLevel),
      settings: {
        accreditationAlertDays:
          settings?.accreditationAlertDays ?? DEFAULT_ACCREDITATION_ALERT_DAYS,
        version: settings?.version ?? 0,
      },
      canConfigure: access.permissions.has("config.manage"),
      manageableProjects,
    });
  }

  /** config.manage, in a serialised company transaction; database refusals become problems. */
  private mutate<T>(
    principal: Principal,
    req: Request,
    operation: (scope: Scope) => Promise<T>,
    uniqueCode: Parameters<typeof rethrowLabourDbError>[1] = "labour-rule",
  ): Promise<T> {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          if (!scope.access.permissions.has("config.manage"))
            throw new ForbiddenException("Permission required: config.manage");
          return operation(scope);
        },
        true,
      )
      .catch((error: unknown) => rethrowLabourDbError(error, uniqueCode));
  }
}
