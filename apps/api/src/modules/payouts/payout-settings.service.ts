import { Injectable, NotFoundException } from "@nestjs/common";
import { approvalLimitFor, type ApprovalLimit, type ApprovalLimitRow } from "@pm-buddy/domain";
import {
  DEFAULT_OWNER_APPROVAL_LIMIT_MINOR,
  DEFAULT_PAYOUT_SETTINGS,
  SYSTEM_ROLE_PERMISSIONS,
  TENANT_SYSTEM_ROLES,
  type PayoutSettingsValues,
  type TenantSystemRole,
} from "@pm-buddy/types";
import {
  approvalLimitsResponseSchema,
  payoutSettingsResponseSchema,
  type ApprovalLimitsResponse,
  type PayoutSettingsResponse,
  type UpdateApprovalLimitsRequest,
  type UpdatePayoutSettingsRequest,
  type UpdateWaiverRequest,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { uuidv7 } from "../../common/uuid.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { displayNames } from "../labour/labour-mappers.js";
import { PayrollCommands } from "../payroll/payroll-support.js";
import { isOwner, minor, PayoutAccess, payoutVersionConflict } from "./payouts-support.js";

type Tx = Prisma.TransactionClient;

export type LoadedPayoutSettings = PayoutSettingsValues & {
  version: number;
  updatedBy: string | null;
  updatedAt: Date | null;
  waiverChangedBy: string | null;
  waiverChangedAt: Date | null;
  limitsVersion: number;
  limitsUpdatedBy: string | null;
  limitsUpdatedAt: Date | null;
  exists: boolean;
};

/** The company's payout settings, or the defaults (CONFIGURATION "D4.3") while none are saved. */
export async function loadPayoutSettings(tx: Tx, tenantId: string): Promise<LoadedPayoutSettings> {
  const row = await tx.payoutSettings.findUnique({ where: { tenantId } });
  if (!row)
    return {
      ...DEFAULT_PAYOUT_SETTINGS,
      version: 0,
      updatedBy: null,
      updatedAt: null,
      waiverChangedBy: null,
      waiverChangedAt: null,
      limitsVersion: 0,
      limitsUpdatedBy: null,
      limitsUpdatedAt: null,
      exists: false,
    };
  return {
    cashMaxPerWorkerPeriodMinor: minor(row.cashMaxPerWorkerPeriodMinor),
    nameMatchThreshold: Number(row.nameMatchThreshold.toString()),
    nameMismatchHold: row.nameMismatchHold,
    payeeChangeHoldHours: row.payeeChangeHoldHours,
    unusualNewRecipientMinor: minor(row.unusualNewRecipientMinor),
    businessHoursStart: row.businessHoursStart,
    businessHoursEnd: row.businessHoursEnd,
    floatCheckMaxAgeMinutes: row.floatCheckMaxAgeMinutes,
    waiverEnabled: row.waiverEnabled,
    waiverReason: row.waiverReason,
    waiverLimitMinor: minor(row.waiverLimitMinor),
    version: row.version,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
    waiverChangedBy: row.waiverChangedBy,
    waiverChangedAt: row.waiverChangedAt,
    limitsVersion: row.limitsVersion,
    limitsUpdatedBy: row.limitsUpdatedBy,
    limitsUpdatedAt: row.limitsUpdatedAt,
    exists: true,
  };
}

/** The configured approval-limit rows of the company. */
export async function loadApprovalLimits(tx: Tx, tenantId: string): Promise<ApprovalLimitRow[]> {
  const rows = await tx.payrollApprovalLimit.findMany({ where: { tenantId } });
  return rows.map((row) => ({
    systemRole: row.systemRole,
    customRoleId: row.customRoleId,
    maxBatchNetMinor: minor(row.maxBatchNetMinor),
  }));
}

/** The caller's batch approval limit (their custom role's, their system role's, or the owner's). */
export async function approverLimit(scope: Scope): Promise<ApprovalLimit> {
  const rows = await loadApprovalLimits(scope.tx, scope.access.tenantId);
  return approvalLimitFor(
    { role: scope.access.role, customRoleId: scope.access.customRoleId },
    rows,
    DEFAULT_OWNER_APPROVAL_LIMIT_MINOR,
  );
}

const iso = (value: Date | null) => (value ? value.toISOString() : null);

/**
 * Payout settings, the OR-04 segregation waiver and batch approval limits (D4.3 §3, §14): read with
 * payments.view, payroll.approve or config.manage; changed with config.manage and a fresh step-up;
 * the waiver only by a member whose system role is owner. All changes are audited.
 */
@Injectable()
export class PayoutSettingsService {
  constructor(
    private readonly commands: PayrollCommands,
    private readonly access: PayoutAccess,
  ) {}

  get(principal: Principal, req: Request): Promise<PayoutSettingsResponse> {
    return this.commands.read(principal, req, async (scope) => {
      await this.access.require(scope, "viewSettings");
      return this.view(scope);
    });
  }

  update(principal: Principal, req: Request, input: UpdatePayoutSettingsRequest) {
    return this.commands.run(principal, req, "payroll.payout_settings.update", input, async (scope) => {
      await this.access.require(scope, "updateSettings");
      const { tx, access } = scope;
      const current = await loadPayoutSettings(tx, access.tenantId);
      if (current.version !== input.version) throw payoutVersionConflict();
      const values = {
        cashMaxPerWorkerPeriodMinor: BigInt(input.cashMaxPerWorkerPeriodMinor),
        nameMatchThreshold: input.nameMatchThreshold,
        nameMismatchHold: input.nameMismatchHold,
        payeeChangeHoldHours: input.payeeChangeHoldHours,
        unusualNewRecipientMinor: BigInt(input.unusualNewRecipientMinor),
        businessHoursStart: input.businessHoursStart,
        businessHoursEnd: input.businessHoursEnd,
        floatCheckMaxAgeMinutes: input.floatCheckMaxAgeMinutes,
        updatedBy: access.userId,
        updatedAt: new Date(),
      };
      if (current.exists) {
        const updated = await tx.payoutSettings.updateMany({
          where: { tenantId: access.tenantId, version: input.version },
          data: { ...values, version: { increment: 1 } },
        });
        if (!updated.count) throw payoutVersionConflict();
      } else
        await tx.payoutSettings.create({
          data: { tenantId: access.tenantId, ...values, version: 1 },
        });
      await this.commands.audit(scope, "payroll.payout_settings_updated", access.tenantId, {
        fields: Object.keys(input)
          .filter((key) => key !== "version")
          .sort(),
      });
      return this.view(scope);
    });
  }

  updateWaiver(principal: Principal, req: Request, input: UpdateWaiverRequest) {
    return this.commands.run(principal, req, "payroll.payout_settings.waiver", input, async (scope) => {
      await this.access.require(scope, "updateWaiver");
      const { tx, access } = scope;
      const current = await loadPayoutSettings(tx, access.tenantId);
      if (current.version !== input.version) throw payoutVersionConflict();
      const values = {
        waiverEnabled: input.enabled,
        waiverReason: input.reason,
        waiverLimitMinor: BigInt(input.limitMinor ?? current.waiverLimitMinor),
        waiverChangedBy: access.userId,
      };
      if (current.exists) {
        const updated = await tx.payoutSettings.updateMany({
          where: { tenantId: access.tenantId, version: input.version },
          data: { ...values, version: { increment: 1 } },
        });
        if (!updated.count) throw payoutVersionConflict();
      } else await tx.payoutSettings.create({ data: { tenantId: access.tenantId, ...values, version: 1 } });
      await this.commands.audit(
        scope,
        input.enabled ? "payroll.waiver_enabled" : "payroll.waiver_disabled",
        access.tenantId,
        { limitMinor: Number(values.waiverLimitMinor), reasonGiven: true },
      );
      return this.view(scope);
    });
  }

  private async view(scope: Scope): Promise<PayoutSettingsResponse> {
    const { tx, access } = scope;
    const settings = await loadPayoutSettings(tx, access.tenantId);
    const names = await displayNames(tx, [settings.updatedBy, settings.waiverChangedBy]);
    const actor = (id: string | null) =>
      id ? { id, displayName: names.get(id) ?? "—" } : null;
    const canManage = await this.access.allows(scope, "updateSettings");
    return payoutSettingsResponseSchema.parse({
      settings: {
        cashMaxPerWorkerPeriodMinor: settings.cashMaxPerWorkerPeriodMinor,
        nameMatchThreshold: settings.nameMatchThreshold,
        nameMismatchHold: settings.nameMismatchHold,
        payeeChangeHoldHours: settings.payeeChangeHoldHours,
        unusualNewRecipientMinor: settings.unusualNewRecipientMinor,
        businessHoursStart: settings.businessHoursStart,
        businessHoursEnd: settings.businessHoursEnd,
        floatCheckMaxAgeMinutes: settings.floatCheckMaxAgeMinutes,
        waiver: {
          enabled: settings.waiverEnabled,
          reason: settings.waiverReason,
          limitMinor: settings.waiverLimitMinor,
          changedBy: actor(settings.waiverChangedBy),
          changedAt: iso(settings.waiverChangedAt),
        },
        version: settings.version,
        updatedBy: actor(settings.updatedBy),
        updatedAt: iso(settings.updatedAt),
      },
      canManage,
      canManageWaiver: canManage && isOwner(scope),
    });
  }

  // Approval limits --------------------------------------------------------------------------------

  limits(principal: Principal, req: Request): Promise<ApprovalLimitsResponse> {
    return this.commands.read(principal, req, async (scope) => {
      await this.access.require(scope, "viewApprovalLimits");
      return this.limitsView(scope);
    });
  }

  updateLimits(principal: Principal, req: Request, input: UpdateApprovalLimitsRequest) {
    return this.commands.run(principal, req, "payroll.approval_limits.update", input, async (scope) => {
      await this.access.require(scope, "updateApprovalLimits");
      const { tx, access } = scope;
      const settings = await loadPayoutSettings(tx, access.tenantId);
      if (settings.limitsVersion !== input.version) throw payoutVersionConflict();
      const customIds = input.limits.flatMap((row) => (row.customRoleId ? [row.customRoleId] : []));
      if (customIds.length) {
        const found = await tx.tenantRole.count({
          where: { tenantId: access.tenantId, id: { in: customIds } },
        });
        if (found !== new Set(customIds).size) throw new NotFoundException("Role not found");
      }
      await tx.payrollApprovalLimit.deleteMany({ where: { tenantId: access.tenantId } });
      if (input.limits.length)
        await tx.payrollApprovalLimit.createMany({
          data: input.limits.map((row) => ({
            id: uuidv7(),
            tenantId: access.tenantId,
            systemRole: row.systemRole,
            customRoleId: row.customRoleId,
            maxBatchNetMinor: BigInt(row.maxBatchNetMinor),
            updatedBy: access.userId,
          })),
        });
      const stamp = { limitsUpdatedBy: access.userId, limitsUpdatedAt: new Date() };
      if (settings.exists) {
        const updated = await tx.payoutSettings.updateMany({
          where: { tenantId: access.tenantId, limitsVersion: input.version },
          data: { ...stamp, limitsVersion: { increment: 1 } },
        });
        if (!updated.count) throw payoutVersionConflict();
      } else
        await tx.payoutSettings.create({
          data: { tenantId: access.tenantId, ...stamp, limitsVersion: 1 },
        });
      await this.commands.audit(scope, "payroll.approval_limits_updated", access.tenantId, {
        limits: input.limits.length,
      });
      return this.limitsView(scope);
    });
  }

  private async limitsView(scope: Scope): Promise<ApprovalLimitsResponse> {
    const { tx, access } = scope;
    const settings = await loadPayoutSettings(tx, access.tenantId);
    const rows = await tx.payrollApprovalLimit.findMany({
      where: { tenantId: access.tenantId },
      orderBy: [{ systemRole: "asc" }, { customRoleId: "asc" }],
    });
    const customRoles = await tx.tenantRole.findMany({
      where: { tenantId: access.tenantId },
      select: { id: true, name: true, permissions: true },
      orderBy: { name: "asc" },
    });
    const names = await displayNames(
      tx,
      rows.map((row) => row.updatedBy),
    );
    const roleName = (systemRole: string | null, customRoleId: string | null) =>
      systemRole ?? customRoles.find((role) => role.id === customRoleId)?.name ?? "—";
    const systemRoles = TENANT_SYSTEM_ROLES.filter((role: TenantSystemRole) =>
      (SYSTEM_ROLE_PERMISSIONS[role] as readonly string[]).includes("payroll.approve"),
    );
    return approvalLimitsResponseSchema.parse({
      limits: rows.map((row) => ({
        systemRole: row.systemRole,
        customRoleId: row.customRoleId,
        roleName: roleName(row.systemRole, row.customRoleId),
        maxBatchNetMinor: minor(row.maxBatchNetMinor),
        updatedBy: { id: row.updatedBy, displayName: names.get(row.updatedBy) ?? "—" },
        updatedAt: row.updatedAt.toISOString(),
      })),
      ownerDefaultMinor: DEFAULT_OWNER_APPROVAL_LIMIT_MINOR,
      roles: [
        ...systemRoles.map((role) => ({ systemRole: role, customRoleId: null, name: role })),
        ...customRoles
          .filter((role) => role.permissions.includes("payroll.approve"))
          .map((role) => ({ systemRole: null, customRoleId: role.id, name: role.name })),
      ],
      version: settings.limitsVersion,
      canManage: await this.access.allows(scope, "updateApprovalLimits"),
    });
  }
}
