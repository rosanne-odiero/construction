import { Injectable, NotFoundException } from "@nestjs/common";
import { nairobiDate, payCalendarIssues } from "@pm-buddy/domain";
import {
  DEFAULT_MINIMUM_WAGE_OCCUPATION,
  KENYA_MINIMUM_WAGES_2026,
  KENYA_STATUTORY_SEED,
} from "@pm-buddy/types";
import {
  minimumWageResponseSchema,
  payCalendarResponseSchema,
  payrollRulesResponseSchema,
  payrollSettingsResponseSchema,
  statutoryRuleResponseSchema,
  type createMinimumWageRequestSchema,
  type createStatutoryRuleRequestSchema,
  type updatePayCalendarRequestSchema,
  type updatePayrollSettingsRequestSchema,
  type verifyStatutoryRuleRequestSchema,
} from "@pm-buddy/validation";
import type { Request } from "express";
import type { z } from "zod";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import { AuthService, type Principal } from "../identity/auth.service.js";
import { displayNames } from "../labour/labour-mappers.js";
import { fromCalendarDate } from "../projects/project-mappers.js";
import { loadCalendar, loadPayrollSettings } from "./batch-builder.js";
import { toMinimumWage, toRule } from "./payroll-mappers.js";
import {
  PAYROLL_VIEW,
  PayrollAccess,
  PayrollCommands,
  payrollBadRequest,
  payrollConflict,
  requireStepUp,
  samePerson,
  versionConflict,
} from "./payroll-support.js";

type Tx = Prisma.TransactionClient;

/**
 * Payroll configuration (D4.1): company settings (advance limits, recovery cap), project pay
 * calendars, effective-dated statutory rule versions with verification, and the minimum-wage table.
 * Rule versions are never edited; verification needs payroll.verify_rules, fresh MFA, a note and a
 * person other than the author (COMPLIANCE-REVIEW CR-PAY-01 … CR-PAY-09).
 */
@Injectable()
export class PayrollRulesService {
  constructor(
    private readonly auth: AuthService,
    private readonly access: PayrollAccess,
    private readonly commands: PayrollCommands,
  ) {}

  // Settings and calendars ------------------------------------------------------------------------

  getSettings(principal: Principal, req: Request) {
    return this.commands.read(principal, req, (scope) => this.settingsView(scope));
  }

  updateSettings(
    principal: Principal,
    input: z.output<typeof updatePayrollSettingsRequestSchema>,
    req: Request,
  ) {
    return this.commands.run(principal, req, "payroll.settings.update", input, async (scope) => {
      const { tx, access } = scope;
      await this.access.company(scope, "config.manage");
      const current = await loadPayrollSettings(tx, access.tenantId);
      if (current.version !== input.version) throw versionConflict();
      const data = {
        advanceMaxMinor: BigInt(input.advanceMaxMinor),
        advanceMaxOutstandingMinor: BigInt(input.advanceMaxOutstandingMinor),
        recoveryMaxPercent: input.recoveryMaxPercent,
        updatedBy: access.userId,
      };
      if (input.version === 0)
        await tx.payrollSettings.create({ data: { tenantId: access.tenantId, ...data } });
      else {
        const updated = await tx.payrollSettings.updateMany({
          where: { tenantId: access.tenantId, version: input.version },
          data: { ...data, version: { increment: 1 } },
        });
        if (!updated.count) throw versionConflict();
      }
      await this.commands.audit(scope, "payroll.settings_updated", access.tenantId, {
        fields: ["advanceMaxMinor", "advanceMaxOutstandingMinor", "recoveryMaxPercent"],
      });
      return this.settingsView(scope);
    });
  }

  updateCalendar(
    principal: Principal,
    projectId: string,
    input: z.output<typeof updatePayCalendarRequestSchema>,
    req: Request,
  ) {
    return this.commands.run(
      principal,
      req,
      "payroll.calendar.update",
      { projectId, input },
      async (scope) => {
        const { tx, access } = scope;
        const { project } = await this.access.project(scope, projectId, ["payroll.prepare"]);
        this.access.assertWritable(project);
        if (payCalendarIssues(input).length)
          throw payrollBadRequest("period-not-in-calendar", "The calendar is not valid.");
        const current = await loadCalendar(tx, access.tenantId, projectId);
        if (current.version !== input.version) throw versionConflict();
        const data = {
          frequency: input.frequency,
          anchorDate: fromCalendarDate(input.anchorDate),
          paydayOffsetDays: input.paydayOffsetDays,
          minimumWageArea: input.minimumWageArea,
          updatedBy: access.userId,
        };
        if (input.version === 0)
          await tx.payCalendar.create({ data: { tenantId: access.tenantId, projectId, ...data } });
        else {
          const updated = await tx.payCalendar.updateMany({
            where: { tenantId: access.tenantId, projectId, version: input.version },
            data: { ...data, version: { increment: 1 } },
          });
          if (!updated.count) throw versionConflict();
        }
        await this.commands.audit(scope, "payroll.calendar_updated", projectId, {
          frequency: input.frequency,
          minimumWageAreaSet: input.minimumWageArea !== null,
        });
        return payCalendarResponseSchema.parse({
          project: { id: project.id, code: project.code, name: project.name },
          calendar: await loadCalendar(tx, access.tenantId, projectId),
        });
      },
    );
  }

  private async settingsView(scope: Scope) {
    const { tx, access } = scope;
    const viewable = await this.access.projects(scope, PAYROLL_VIEW);
    if (!viewable.length && !access.permissions.has("config.manage"))
      await this.access.companyAny(scope, ["payroll.view", "config.manage"]);
    const editable = await this.access.projectsWithAny(scope, ["payroll.prepare"]);
    const calendars = [];
    for (const project of viewable)
      calendars.push({
        project: { id: project.id, code: project.code, name: project.name },
        calendar: await loadCalendar(tx, access.tenantId, project.id),
        canEdit: editable === "all" || editable.includes(project.id),
      });
    return payrollSettingsResponseSchema.parse({
      today: nairobiDate(),
      settings: await loadPayrollSettings(tx, access.tenantId),
      calendars,
      canConfigure: access.permissions.has("config.manage"),
    });
  }

  // Statutory rules -------------------------------------------------------------------------------

  rules(principal: Principal, req: Request) {
    return this.commands.read(principal, req, (scope) => this.rulesView(scope));
  }

  private async rulesView(scope: Scope) {
    const { tx, access } = scope;
    const viewable = await this.access.projectsWithAny(scope, PAYROLL_VIEW);
    if (viewable !== "all" && !viewable.length)
      await this.access.companyAny(scope, [
        "payroll.manage_rules",
        "payroll.verify_rules",
        "config.manage",
      ]);
    const rows = await tx.statutoryRuleVersion.findMany({
      where: { tenantId: access.tenantId },
      orderBy: [{ kind: "asc" }, { effectiveFrom: "desc" }],
    });
    const submitted = await tx.payrollBatch.findMany({
      where: { tenantId: access.tenantId, status: "submitted" },
      select: { ruleVersionIds: true },
    });
    const names = await displayNames(tx, [
      ...rows.map((row) => row.createdBy),
      ...rows.map((row) => row.verifiedBy),
    ]);
    const today = nairobiDate();
    const wages = await tx.minimumWageRate.findMany({
      where: { tenantId: access.tenantId },
      orderBy: [{ effectiveFrom: "desc" }, { area: "asc" }, { occupation: "asc" }],
    });
    return payrollRulesResponseSchema.parse({
      today,
      rules: rows.map((row) =>
        toRule(
          row,
          rows,
          today,
          names,
          submitted.filter((batch) => batch.ruleVersionIds.includes(row.id)).length,
        ),
      ),
      minimumWages: wages.map(toMinimumWage),
      occupationByCategory: DEFAULT_MINIMUM_WAGE_OCCUPATION,
      permissions: {
        canManage: access.permissions.has("payroll.manage_rules"),
        canVerify: access.permissions.has("payroll.verify_rules"),
      },
      production: this.access.production,
    });
  }

  createRule(
    principal: Principal,
    input: z.output<typeof createStatutoryRuleRequestSchema>,
    req: Request,
  ) {
    return this.commands.run(principal, req, "payroll.rule.create", input, async (scope) => {
      const { tx, access } = scope;
      await this.access.company(scope, "payroll.manage_rules");
      await this.assertRuleDate(tx, access.tenantId, input.kind, input.effectiveFrom);
      const row = await tx.statutoryRuleVersion.create({
        data: {
          tenantId: access.tenantId,
          kind: input.kind,
          effectiveFrom: fromCalendarDate(input.effectiveFrom),
          parameters: input.parameters as Prisma.InputJsonValue,
          sourceReference: input.sourceReference,
          notes: input.notes,
          createdBy: access.userId,
        },
      });
      await this.commands.audit(scope, "payroll.rule_created", row.id, {
        kind: input.kind,
        effectiveFrom: input.effectiveFrom,
      });
      return this.ruleResponse(scope, row.id);
    });
  }

  /** Installs the researched seed versions that are missing (all `unverified`). */
  installDefaults(principal: Principal, req: Request) {
    return this.commands.run(principal, req, "payroll.rule.defaults", {}, async (scope) => {
      const { tx, access } = scope;
      await this.access.company(scope, "payroll.manage_rules");
      const created = await installStatutoryDefaults(tx, access.tenantId, access.userId);
      const wages = await installMinimumWageDefaults(tx, access.tenantId, access.userId);
      await this.commands.audit(scope, "payroll.rules_installed", access.tenantId, {
        ruleVersions: created,
        minimumWages: wages,
      });
      return this.rulesView(scope);
    });
  }

  verifyRule(
    principal: Principal,
    ruleId: string,
    input: z.output<typeof verifyStatutoryRuleRequestSchema>,
    req: Request,
  ) {
    return this.commands.run(
      principal,
      req,
      "payroll.rule.verify",
      { ruleId, input },
      async (scope) => {
        const { tx, access } = scope;
        await this.access.company(scope, "payroll.verify_rules");
        requireStepUp(this.auth, principal);
        const row = await this.rule(tx, access.tenantId, ruleId);
        if (row.status !== "unverified")
          throw payrollConflict("rule-verified", "This rule version is already verified.");
        if (row.createdBy === access.userId)
          throw samePerson("The author of a rule version cannot verify it.");
        const updated = await tx.statutoryRuleVersion.updateMany({
          where: { tenantId: access.tenantId, id: ruleId, status: "unverified" },
          data: { status: "verified", verifiedBy: access.userId, verificationNote: input.note },
        });
        if (!updated.count) throw versionConflict();
        await this.commands.audit(scope, "payroll.rule_verified", ruleId, {
          kind: row.kind,
          noteGiven: true,
        });
        await this.commands.outbox(scope, "payroll.rule_verified", ruleId, { kind: row.kind });
        return this.ruleResponse(scope, ruleId);
      },
    );
  }

  deleteRule(principal: Principal, ruleId: string, req: Request) {
    return this.commands.run(principal, req, "payroll.rule.delete", { ruleId }, async (scope) => {
      const { tx, access } = scope;
      await this.access.company(scope, "payroll.manage_rules");
      const row = await this.rule(tx, access.tenantId, ruleId);
      if (row.status !== "unverified")
        throw payrollConflict("rule-verified", "A verified rule version is kept for history.");
      const used = await tx.payrollBatch.count({
        where: { tenantId: access.tenantId, ruleVersionIds: { has: ruleId } },
      });
      if (used) throw payrollConflict("rule-in-use", "A batch used this rule version; it is kept.");
      await tx.statutoryRuleVersion.delete({
        where: { tenantId_id: { tenantId: access.tenantId, id: ruleId } },
      });
      await this.commands.audit(scope, "payroll.rule_deleted", ruleId, { kind: row.kind });
      return { message: "Rule version deleted." };
    });
  }

  createMinimumWage(
    principal: Principal,
    input: z.output<typeof createMinimumWageRequestSchema>,
    req: Request,
  ) {
    return this.commands.run(
      principal,
      req,
      "payroll.minimum_wage.create",
      input,
      async (scope) => {
        const { tx, access } = scope;
        await this.access.company(scope, "payroll.manage_rules");
        const exists = await tx.minimumWageRate.findFirst({
          where: {
            tenantId: access.tenantId,
            area: input.area,
            occupation: input.occupation,
            effectiveFrom: fromCalendarDate(input.effectiveFrom),
          },
        });
        if (exists)
          throw payrollConflict(
            "minimum-wage-exists",
            "A minimum wage for this area and occupation already starts on that date.",
          );
        const row = await tx.minimumWageRate.create({
          data: {
            tenantId: access.tenantId,
            effectiveFrom: fromCalendarDate(input.effectiveFrom),
            area: input.area,
            occupation: input.occupation,
            monthlyMinor: BigInt(input.monthlyMinor),
            dailyMinor: input.dailyMinor === null ? null : BigInt(input.dailyMinor),
            hourlyMinor: input.hourlyMinor === null ? null : BigInt(input.hourlyMinor),
            source: input.source,
            createdBy: access.userId,
          },
        });
        await this.commands.audit(scope, "payroll.minimum_wage_created", row.id, {
          area: input.area,
          occupation: input.occupation,
          effectiveFrom: input.effectiveFrom,
        });
        return minimumWageResponseSchema.parse({ minimumWage: toMinimumWage(row) });
      },
    );
  }

  private async assertRuleDate(tx: Tx, tenantId: string, kind: string, effectiveFrom: string) {
    const exists = await tx.statutoryRuleVersion.findFirst({
      where: { tenantId, kind, effectiveFrom: fromCalendarDate(effectiveFrom) },
    });
    if (exists)
      throw payrollConflict(
        "rule-exists",
        "A version of this rule already starts on that date; add one with another date.",
      );
    const closed = await tx.payrollBatch.count({
      where: { tenantId, status: "submitted", payDate: { gte: fromCalendarDate(effectiveFrom) } },
    });
    if (closed)
      throw payrollConflict(
        "rule-in-closed-period",
        "A new version cannot take effect on or before the pay date of submitted payroll.",
      );
  }

  private async rule(tx: Tx, tenantId: string, ruleId: string) {
    const row = await tx.statutoryRuleVersion.findUnique({
      where: { tenantId_id: { tenantId, id: ruleId } },
    });
    if (!row) throw new NotFoundException("Rule version not found");
    return row;
  }

  private async ruleResponse(scope: Scope, ruleId: string) {
    const { tx, access } = scope;
    const rows = await tx.statutoryRuleVersion.findMany({ where: { tenantId: access.tenantId } });
    const row = rows.find((entry) => entry.id === ruleId)!;
    const names = await displayNames(tx, [row.createdBy, row.verifiedBy]);
    const submitted = await tx.payrollBatch.count({
      where: { tenantId: access.tenantId, status: "submitted", ruleVersionIds: { has: ruleId } },
    });
    return statutoryRuleResponseSchema.parse({
      rule: toRule(row, rows, nairobiDate(), names, submitted),
    });
  }
}

/** Seed versions not yet present (by kind and start date), all `unverified`. Returns the count. */
export async function installStatutoryDefaults(tx: Tx, tenantId: string, userId: string) {
  const existing = await tx.statutoryRuleVersion.findMany({
    where: { tenantId },
    select: { kind: true, effectiveFrom: true },
  });
  const missing = KENYA_STATUTORY_SEED.filter(
    (seed) =>
      !existing.some(
        (row) =>
          row.kind === seed.kind &&
          row.effectiveFrom.getTime() === fromCalendarDate(seed.effectiveFrom).getTime(),
      ),
  );
  for (const seed of missing)
    await tx.statutoryRuleVersion.create({
      data: {
        tenantId,
        kind: seed.kind,
        effectiveFrom: fromCalendarDate(seed.effectiveFrom),
        parameters: seed.parameters as Prisma.InputJsonValue,
        sourceReference: seed.sourceReference.slice(0, 2000),
        notes: seed.notes.slice(0, 1000),
        createdBy: userId,
      },
    });
  return missing.length;
}

/** The 2026 General Order rows not yet present (unverified). Returns the count. */
export async function installMinimumWageDefaults(tx: Tx, tenantId: string, userId: string) {
  const existing = await tx.minimumWageRate.findMany({
    where: { tenantId },
    select: { area: true, occupation: true, effectiveFrom: true },
  });
  const missing = KENYA_MINIMUM_WAGES_2026.filter(
    (seed) =>
      !existing.some(
        (row) =>
          row.area === seed.area &&
          row.occupation === seed.occupation &&
          row.effectiveFrom.getTime() === fromCalendarDate(seed.effectiveFrom).getTime(),
      ),
  );
  if (missing.length)
    await tx.minimumWageRate.createMany({
      data: missing.map((seed) => ({
        tenantId,
        effectiveFrom: fromCalendarDate(seed.effectiveFrom),
        area: seed.area,
        occupation: seed.occupation,
        monthlyMinor: BigInt(seed.monthlyMinor),
        source: seed.source.slice(0, 2000),
        createdBy: userId,
      })),
    });
  return missing.length;
}
