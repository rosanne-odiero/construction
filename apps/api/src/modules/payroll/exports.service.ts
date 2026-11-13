import { Injectable } from "@nestjs/common";
import { fromMinor } from "@pm-buddy/domain";
import {
  EMPLOYEE_STATUTORY,
  EMPLOYER_COSTS,
  type EmployeeStatutory,
  type EmployerCost,
  type PayrollExportKind,
} from "@pm-buddy/types";
import {
  exportSummaryResponseSchema,
  type exportQuerySchema,
  type exportRequestSchema,
} from "@pm-buddy/validation";
import type { Request } from "express";
import type { z } from "zod";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import { AuthService, type Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { LabourCrypto, type LabourerColumn } from "../labour/labour-support.js";
import { toCalendarDate } from "../projects/project-mappers.js";
import {
  PayrollAccess,
  money,
  payrollConflict,
  requireStepUp,
  rethrowPayrollDbError,
} from "./payroll-support.js";

type Tx = Prisma.TransactionClient;

type MonthlyFigures = {
  employee: Record<EmployeeStatutory, number>;
  employer: Record<EmployerCost, number>;
  nssf: {
    pensionableMinor: number;
    tier1Minor: number;
    tier2Minor: number;
    employerTier1Minor: number;
    employerTier2Minor: number;
  };
  taxablePayMinor: number;
  payeBeforeReliefMinor: number;
  personalReliefMinor: number;
};

type Employee = {
  labourerId: string;
  workerNo: string;
  fullName: string;
  engagementType: string;
  grossMinor: number;
  baseMinor: number;
  withheld: Record<EmployeeStatutory, number>;
  shortfall: Record<EmployeeStatutory, number>;
  employer: Record<EmployerCost, number>;
  /** The month's figures from the employee's latest line (cumulative method). */
  monthly: MonthlyFigures;
};

/** Spreadsheet formula injection (brief §15 F): text cells never start a formula. */
export function csvText(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
const amount = (minor: number) => fromMinor(minor);

const HEADERS: Record<PayrollExportKind, { title: string; columns: string[] }> = {
  paye: {
    title:
      "PAYE return template (P10-style) with the Affordable Housing Levy (iTax Section M) columns",
    columns: [
      "KRA PIN",
      "Employee name",
      "Worker number",
      "Engagement type",
      "Gross pay",
      "NSSF employee",
      "SHIF",
      "AHL employee",
      "Taxable pay",
      "PAYE before relief",
      "Personal relief",
      "PAYE withheld",
      "PAYE not withheld",
      "AHL employer",
      "AHL total",
    ],
  },
  nssf: {
    title: "NSSF contribution return template (Tier I and Tier II)",
    columns: [
      "NSSF number",
      "Employee name",
      "Worker number",
      "Pensionable pay",
      "Tier I employee",
      "Tier II employee",
      "Employee total",
      "Tier I employer",
      "Tier II employer",
      "Employer total",
      "Total",
    ],
  },
  shif: {
    title: "SHA/SHIF employer monthly return template",
    columns: ["SHA number", "Employee name", "Worker number", "Gross pay", "SHIF contribution"],
  },
  nita: {
    title: "NITA industrial training levy schedule (employer only)",
    columns: ["Worker number", "Employee name", "Engagement type", "NITA levy"],
  },
};

const IDENTIFIER: Record<PayrollExportKind, LabourerColumn | null> = {
  paye: "kra_pin_enc",
  nssf: "nssf_number_enc",
  shif: "sha_number_enc",
  nita: null,
};

/**
 * Monthly statutory exports (D4.1; COMPLIANCE-REVIEW CR-PAY-11): one employer-wide aggregate per
 * statutory month across its submitted batches, as plain CSV templates to map to the official
 * upload formats. Identifiers are decrypted only here, server-side, with payroll.export and fresh
 * MFA; the audit event records the kind, month and counts, never the values. Production refuses
 * while any included batch used unverified rules. Exports are never stored, so they take no
 * Idempotency-Key (a stored response would keep decrypted identifiers).
 */
@Injectable()
export class PayrollExportsService {
  constructor(
    private readonly auth: AuthService,
    private readonly scope: TenantScope,
    private readonly access: PayrollAccess,
    private readonly crypto: LabourCrypto,
  ) {}

  summary(principal: Principal, query: z.output<typeof exportQuerySchema>, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      await this.access.company(scope, "payroll.export");
      const { batches, employees } = await this.collect(
        scope.tx,
        scope.access.tenantId,
        query.month,
      );
      const labourers = await scope.tx.labourer.findMany({
        where: { tenantId: scope.access.tenantId, id: { in: employees.map((e) => e.labourerId) } },
        select: { kraPinEnc: true, nssfNumberEnc: true, shaNumberEnc: true },
      });
      const sum = (pick: (employee: Employee) => number) =>
        employees.reduce((total, employee) => total + pick(employee), 0);
      const unverified = batches.some((batch) => batch.unverifiedRules);
      return exportSummaryResponseSchema.parse({
        month: query.month,
        production: this.access.production,
        batches: batches.map((batch) => ({
          id: batch.id,
          project: batch.project,
          periodStart: toCalendarDate(batch.periodStart),
          periodEnd: toCalendarDate(batch.periodEnd),
          payDate: toCalendarDate(batch.payDate),
          unverifiedRules: batch.unverifiedRules,
        })),
        employees: employees.length,
        totals: {
          grossMinor: sum((employee) => employee.grossMinor),
          employee: Object.fromEntries(
            EMPLOYEE_STATUTORY.map((item) => [item, sum((employee) => employee.withheld[item])]),
          ),
          employer: Object.fromEntries(
            EMPLOYER_COSTS.map((item) => [item, sum((employee) => employee.employer[item])]),
          ),
          shortfallMinor: sum((employee) =>
            EMPLOYEE_STATUTORY.reduce((total, item) => total + employee.shortfall[item], 0),
          ),
        },
        missingIdentifiers: {
          kraPin: labourers.filter((row) => !row.kraPinEnc).length,
          nssfNumber: labourers.filter((row) => !row.nssfNumberEnc).length,
          shaNumber: labourers.filter((row) => !row.shaNumberEnc).length,
        },
        unverified,
        blocked: unverified && this.access.production,
        canExport: true,
      });
    });
  }

  /** The CSV for one kind and month (payroll.export + step-up; audited without values). */
  generate(principal: Principal, input: z.output<typeof exportRequestSchema>, req: Request) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          await this.access.company(scope, "payroll.export");
          requireStepUp(this.auth, principal);
          const { tx, access } = scope;
          const { batches, employees } = await this.collect(tx, access.tenantId, input.month);
          if (!batches.length)
            throw payrollConflict("nothing-to-export", "No submitted payroll in that month.");
          const unverified = batches.some((batch) => batch.unverifiedRules);
          // COMPLIANCE-REVIEW (INVARIANTS): no filing exports from unverified rules in production.
          if (unverified && this.access.production)
            throw payrollConflict(
              "rules-unverified",
              "The month's payroll used rule versions that are not verified.",
            );
          const csv = await this.csv(scope, input.kind, input.month, employees, unverified);
          await this.scope.audit(tx, "payroll.export_generated", access.tenantId, {
            kind: input.kind,
            month: input.month,
            rows: csv.rows,
            batches: batches.length,
            unverified,
            identifiersMissing: csv.missing,
          });
          return {
            content: Buffer.from(csv.text, "utf8"),
            filename: `pm-buddy-${input.kind}-${input.month}.csv`,
          };
        },
        true,
        30_000,
      )
      .catch((error: unknown) => rethrowPayrollDbError(error));
  }

  private async collect(tx: Tx, tenantId: string, month: string) {
    const batches = await tx.payrollBatch.findMany({
      where: { tenantId, statutoryMonth: month, status: "submitted" },
      include: { project: { select: { id: true, code: true, name: true } } },
      orderBy: [{ payDate: "asc" }, { submittedAt: "asc" }],
    });
    const lines = batches.length
      ? await tx.payrollLine.findMany({
          where: { tenantId, batchId: { in: batches.map((batch) => batch.id) } },
          include: { deductions: true },
        })
      : [];
    const position = new Map(batches.map((batch, index) => [batch.id, index]));
    lines.sort(
      (a, b) =>
        (position.get(a.batchId) ?? 0) - (position.get(b.batchId) ?? 0) ||
        a.createdAt.getTime() - b.createdAt.getTime(),
    );
    const byLabourer = new Map<string, Employee>();
    for (const line of lines) {
      const entry =
        byLabourer.get(line.labourerId) ??
        ({
          labourerId: line.labourerId,
          workerNo: line.workerNo,
          fullName: line.fullName,
          engagementType: line.engagementType,
          grossMinor: 0,
          baseMinor: 0,
          withheld: { nssf: 0, shif: 0, ahl: 0, paye: 0 },
          shortfall: { nssf: 0, shif: 0, ahl: 0, paye: 0 },
          employer: { nssf_employer: 0, ahl_employer: 0, nita: 0 },
          monthly: undefined as unknown as MonthlyFigures,
        } satisfies Employee);
      entry.grossMinor += money(line.grossMinor);
      entry.baseMinor += money(line.statutoryBaseMinor);
      for (const deduction of line.deductions) {
        if (deduction.party === "employee") {
          entry.withheld[deduction.kind as EmployeeStatutory] += money(deduction.withheldMinor);
          entry.shortfall[deduction.kind as EmployeeStatutory] += money(deduction.shortfallMinor);
        } else entry.employer[deduction.kind as EmployerCost] += money(deduction.withheldMinor);
      }
      // The latest line of the month carries the month's cumulative figures.
      entry.monthly = (line.monthToDate as unknown as { monthly: MonthlyFigures }).monthly;
      entry.workerNo = line.workerNo;
      entry.fullName = line.fullName;
      byLabourer.set(line.labourerId, entry);
    }
    const employees = [...byLabourer.values()].sort((a, b) => a.workerNo.localeCompare(b.workerNo));
    return { batches, employees };
  }

  private async csv(
    scope: Scope,
    kind: PayrollExportKind,
    month: string,
    employees: Employee[],
    unverified: boolean,
  ) {
    const { tx, access } = scope;
    const column = IDENTIFIER[kind];
    const identifiers = new Map<string, string>();
    let missing = 0;
    if (column) {
      const rows = await tx.labourer.findMany({
        where: { tenantId: access.tenantId, id: { in: employees.map((e) => e.labourerId) } },
        select: { id: true, kraPinEnc: true, nssfNumberEnc: true, shaNumberEnc: true },
      });
      for (const row of rows) {
        const stored =
          column === "kra_pin_enc"
            ? row.kraPinEnc
            : column === "nssf_number_enc"
              ? row.nssfNumberEnc
              : row.shaNumberEnc;
        if (stored)
          identifiers.set(row.id, this.crypto.open(access.tenantId, row.id, column, stored));
        else missing += 1;
      }
    }
    const header = HEADERS[kind];
    const lines = [
      `# PM-Buddy ${header.title} for ${month}`,
      "# COMPLIANCE-REVIEW CR-PAY-11: a template to map to the current official upload format; check every column with your adviser before filing.",
      ...(unverified ? ["# UNVERIFIED RULES - NOT FOR FILING (development data)"] : []),
      header.columns.map(csvText).join(","),
    ];
    for (const employee of employees) {
      const id = csvText(identifiers.get(employee.labourerId) ?? "");
      const name = csvText(employee.fullName);
      const worker = csvText(employee.workerNo);
      const { monthly } = employee;
      let cells: string[];
      switch (kind) {
        case "paye":
          cells = [
            id,
            name,
            worker,
            csvText(employee.engagementType),
            amount(employee.grossMinor),
            amount(employee.withheld.nssf),
            amount(employee.withheld.shif),
            amount(employee.withheld.ahl),
            amount(monthly.taxablePayMinor),
            amount(monthly.payeBeforeReliefMinor),
            amount(monthly.personalReliefMinor),
            amount(employee.withheld.paye),
            amount(employee.shortfall.paye),
            amount(employee.employer.ahl_employer),
            amount(employee.withheld.ahl + employee.employer.ahl_employer),
          ];
          break;
        case "nssf":
          cells = [
            id,
            name,
            worker,
            amount(monthly.nssf.pensionableMinor),
            amount(monthly.nssf.tier1Minor),
            amount(monthly.nssf.tier2Minor),
            amount(employee.withheld.nssf),
            amount(monthly.nssf.employerTier1Minor),
            amount(monthly.nssf.employerTier2Minor),
            amount(employee.employer.nssf_employer),
            amount(employee.withheld.nssf + employee.employer.nssf_employer),
          ];
          break;
        case "shif":
          cells = [id, name, worker, amount(employee.baseMinor), amount(employee.withheld.shif)];
          break;
        case "nita":
          cells = [worker, name, csvText(employee.engagementType), amount(employee.employer.nita)];
          break;
      }
      lines.push(cells.join(","));
    }
    return { text: `${lines.join("\r\n")}\r\n`, rows: employees.length, missing };
  }
}
