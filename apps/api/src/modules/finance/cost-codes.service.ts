import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import {
  BUDGET_PREPARE_PERMISSIONS,
  DEFAULT_COST_CODES,
  PETTY_CASH_READ_PERMISSIONS,
  SPENDING_READ_PERMISSIONS,
  type CostCategory,
  type Permission,
} from "@pm-buddy/types";
import {
  costCodeResponseSchema,
  costCodesResponseSchema,
  loadCostCodeDefaultsResponseSchema,
  spendingSettingsResponseSchema,
  type CreateCostCodeRequest,
  type UpdateSpendingSettingsRequest,
} from "@pm-buddy/validation";
import { isUniqueViolation } from "../../common/database-errors.js";
import { nextId } from "../procurement/catalogue-store.js";
import type { Principal } from "../identity/auth.service.js";
import type { Scope } from "../identity/access-policy.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import {
  SpendingAccess,
  spendingConflict,
  spendingSettings,
  spendingVersionConflict,
} from "./spending-common.js";

type CostCodeRow = {
  id: string;
  code: string;
  name: string;
  category: string;
  active: boolean;
  version: number;
};
const toCostCode = (row: CostCodeRow) => ({
  id: row.id,
  code: row.code,
  name: row.name,
  category: row.category as CostCategory,
  active: row.active,
  version: row.version,
});

/** Who manages company cost codes and spending settings: finance managers (owner, finance). */
const MANAGERS = ["finance.manage"] as const;

/** Who may read cost codes: anyone who budgets, tags or reads spending somewhere. */
const CODE_READERS = [
  ...new Set([
    ...SPENDING_READ_PERMISSIONS,
    ...PETTY_CASH_READ_PERMISSIONS,
    ...BUDGET_PREPARE_PERMISSIONS,
  ]),
];

/**
 * Company cost codes and spending settings (D5.4, CONFIGURATION "Spending"). Cost codes are read
 * by anyone who budgets, tags or reads spending on some project (the expense form needs them);
 * the settings by spending readers, with the company's opening cash only for company-wide
 * finance roles. Portal-only roles (client, supplier) read neither. Changes need a company-wide
 * `finance.manage` role. Codes in use are deactivated, never deleted. Audit events carry field
 * names, never values.
 */
@Injectable()
export class CostCodesService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: SpendingAccess,
  ) {}

  list(
    principal: Principal,
    query: { search?: string; includeInactive?: boolean; cursor?: string; limit: number },
    req: Request,
  ) {
    return this.scope.run(principal, req, async (scope) => {
      await this.requireSomewhere(scope, CODE_READERS);
      const search = query.search?.trim();
      const rows = await scope.tx.costCode.findMany({
        where: {
          tenantId: scope.access.tenantId,
          ...(query.includeInactive ? {} : { active: true }),
          ...(search
            ? {
                OR: [
                  { code: { contains: search, mode: "insensitive" } },
                  { name: { contains: search, mode: "insensitive" } },
                ],
              }
            : {}),
          ...(query.cursor ? { code: { gt: query.cursor } } : {}),
        },
        orderBy: { code: "asc" },
        take: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      return costCodesResponseSchema.parse({
        costCodes: page.map(toCostCode),
        page: {
          hasMore: rows.length > query.limit,
          nextCursor: rows.length > query.limit ? page.at(-1)!.code : null,
        },
        permissions: { canManage: this.access.company(scope, MANAGERS) },
      });
    });
  }

  create(principal: Principal, input: CreateCostCodeRequest & { code: string }, req: Request) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          this.access.requireCompany(scope, MANAGERS);
          const { tx, access } = scope;
          const row = await tx.costCode.create({
            data: {
              id: nextId(),
              tenantId: access.tenantId,
              code: input.code,
              name: input.name,
              category: input.category,
              createdBy: access.userId,
              updatedBy: access.userId,
            },
          });
          await this.scope.audit(tx, "cost_code.created", row.id, { category: row.category });
          return costCodeResponseSchema.parse({ costCode: toCostCode(row) });
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error))
          throw spendingConflict("cost-code-taken", "This cost code already exists");
        throw error;
      });
  }

  update(
    principal: Principal,
    id: string,
    input: { version: number; name?: string; category?: CostCategory; active?: boolean },
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        this.access.requireCompany(scope, MANAGERS);
        const { tx, access } = scope;
        const row = await tx.costCode.findUnique({
          where: { tenantId_id: { tenantId: access.tenantId, id } },
        });
        if (!row) throw new NotFoundException("Cost code not found");
        if (row.version !== input.version) throw spendingVersionConflict();
        const updated = await tx.costCode.update({
          where: { tenantId_id: { tenantId: access.tenantId, id } },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.category !== undefined ? { category: input.category } : {}),
            ...(input.active !== undefined ? { active: input.active } : {}),
            version: { increment: 1 },
            updatedBy: access.userId,
            updatedAt: new Date(),
          },
        });
        await this.scope.audit(tx, "cost_code.updated", id, {
          fields: Object.keys(input)
            .filter((key) => key !== "version")
            .sort(),
        });
        return costCodeResponseSchema.parse({ costCode: toCostCode(updated) });
      },
      true,
    );
  }

  /** Adds the default codes the company does not have yet (by code). */
  loadDefaults(principal: Principal, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        this.access.requireCompany(scope, MANAGERS);
        const { tx, access } = scope;
        const existing = await tx.costCode.findMany({
          where: { tenantId: access.tenantId, code: { in: DEFAULT_COST_CODES.map((c) => c.code) } },
          select: { code: true },
        });
        const have = new Set(existing.map((row) => row.code));
        const missing = DEFAULT_COST_CODES.filter((entry) => !have.has(entry.code));
        if (missing.length)
          await tx.costCode.createMany({
            data: missing.map((entry) => ({
              id: nextId(),
              tenantId: access.tenantId,
              code: entry.code,
              name: entry.nameEn,
              category: entry.category,
              createdBy: access.userId,
              updatedBy: access.userId,
            })),
          });
        await this.scope.audit(tx, "cost_code.defaults_loaded", access.tenantId, {
          created: missing.length,
        });
        return loadCostCodeDefaultsResponseSchema.parse({
          created: missing.length,
          existing: have.size,
        });
      },
      true,
    );
  }

  settings(principal: Principal, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      await this.requireSomewhere(scope, SPENDING_READ_PERMISSIONS);
      const { updatedAt, ...settings } = await spendingSettings(scope.tx, scope.access.tenantId);
      // The company's cash position is for company-wide finance roles only.
      const company = this.access.company(scope, SPENDING_READ_PERMISSIONS);
      return spendingSettingsResponseSchema.parse({
        settings: {
          ...settings,
          openingCashMinor: company ? settings.openingCashMinor : null,
          openingCashOn: company ? settings.openingCashOn : null,
          updatedAt,
        },
        permissions: { canEdit: this.access.company(scope, MANAGERS) },
      });
    });
  }

  /** 403 unless the caller holds one of `permissions` company-wide or on some project. */
  private async requireSomewhere(scope: Scope, permissions: readonly Permission[]) {
    if (this.access.company(scope, permissions)) return;
    if ((await this.access.projectIds(scope, permissions)).length) return;
    throw new ForbiddenException("No spending permission in this company");
  }

  updateSettings(principal: Principal, input: UpdateSpendingSettingsRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        this.access.requireCompany(scope, MANAGERS);
        const { tx, access } = scope;
        const current = await spendingSettings(tx, access.tenantId);
        if (current.version !== input.version) throw spendingVersionConflict();
        const data = {
          budgetAlertPercent: input.budgetAlertPercent,
          unusualSpendMultiplier: input.unusualSpendMultiplier,
          unusualSpendMinSamples: input.unusualSpendMinSamples,
          duplicateWindowDays: input.duplicateWindowDays,
          forecastWeeks: input.forecastWeeks,
          openingCashMinor: input.openingCashMinor === null ? null : BigInt(input.openingCashMinor),
          openingCashOn: input.openingCashOn ? new Date(`${input.openingCashOn}T00:00:00Z`) : null,
          updatedBy: access.userId,
          updatedAt: new Date(),
        };
        if (current.version === 0)
          await tx.spendingSettings.create({ data: { tenantId: access.tenantId, ...data } });
        else
          await tx.spendingSettings.update({
            where: { tenantId: access.tenantId },
            data: { ...data, version: { increment: 1 } },
          });
        await this.scope.audit(tx, "spending.settings_updated", access.tenantId, {
          openingCash: input.openingCashMinor !== null,
        });
        const { updatedAt, ...settings } = await spendingSettings(tx, access.tenantId);
        return spendingSettingsResponseSchema.parse({
          settings: { ...settings, updatedAt },
          permissions: { canEdit: true },
        });
      },
      true,
    );
  }
}
