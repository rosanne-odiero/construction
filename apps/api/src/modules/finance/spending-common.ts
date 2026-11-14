import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { isProjectReadOnly } from "@pm-buddy/domain";
import {
  DEFAULT_SPENDING_SETTINGS,
  PETTY_CASH_APPROVE_PERMISSIONS,
  PETTY_CASH_READ_PERMISSIONS,
  SPENDING_READ_PERMISSIONS,
  type CostCategory,
  type Permission,
  type ProjectStatus,
} from "@pm-buddy/types";
import type { SpendingBqItem } from "@pm-buddy/validation";
import { isCheckViolation } from "../../common/database-errors.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { AccessPolicy, type Scope } from "../identity/access-policy.js";
import { effectiveProjectPermissions } from "../identity/role-grants.js";
import { toCalendarDate, type ProjectRow } from "../projects/project-mappers.js";

export type Tx = Prisma.TransactionClient;

/** Stable problem codes for spending (the web maps them to EN/SW messages). */
export type SpendingProblem =
  | "version-conflict"
  | "project-read-only"
  | "invalid-transition"
  | "reason-required"
  | "maker-checker"
  | "budget-open"
  | "budget-stale"
  | "budget-empty"
  | "budget-too-large"
  | "bq-not-approved"
  | "bq-item-not-found"
  | "cost-code-taken"
  | "cost-code-not-found"
  | "cost-code-inactive"
  | "budget-line-exists"
  | "site-not-in-project"
  | "supplier-not-found"
  | "entry-not-found"
  | "entry-already-reversed"
  | "entry-is-reversal"
  | "float-exists"
  | "float-closed"
  | "float-not-empty"
  | "float-has-open-items"
  | "float-insufficient"
  | "float-limit-exceeded"
  | "custodian-not-eligible"
  | "not-custodian"
  | "handover-needs-count"
  | "count-open"
  | "receipt-required"
  | "too-many-receipts"
  | "mpesa-code-duplicate"
  | "expense-date-invalid"
  | "top-up-date-invalid"
  | "top-up-reference-taken"
  | "received-date-invalid"
  | "idempotency-key-required"
  | "idempotency-key-reused"
  | "expense-id-conflict"
  | "file-required"
  | "unsupported-file-type"
  | "payload-too-large"
  | "malware-detected";

export const spendingConflict = (code: SpendingProblem, message: string) =>
  new ConflictException({ message, code });
export const spendingProblem = (status: number, code: SpendingProblem, message: string) =>
  new HttpException({ message, code }, status);
export const spendingVersionConflict = () =>
  spendingConflict(
    "version-conflict",
    "This record was changed by someone else. Reload and try again.",
  );
export const spendingInvalidTransition = (status: string) =>
  spendingConflict("invalid-transition", `Not possible while the record is ${status}`);
export const makerChecker = (message: string) => spendingProblem(403, "maker-checker", message);

/** The full text of a database error (trigger refusals carry their sentence). */
export const databaseMessage = (error: unknown) =>
  JSON.stringify(error, Object.getOwnPropertyNames(error as object));

/**
 * Maps spending trigger refusals (SQLSTATE 23514) to the API's problems, so a check that the API
 * missed still answers with a stable code; null for anything else.
 */
export function spendingDatabaseProblem(error: unknown): Error | null {
  if (!isCheckViolation(error)) return null;
  const text = databaseMessage(error);
  if (/never goes below zero/.test(text))
    return spendingConflict("float-insufficient", "The float does not hold enough cash for this");
  if (/above its limit/.test(text))
    return spendingConflict("float-limit-exceeded", "This would take the float above its limit");
  if (/someone other than|neither counted nor holds|other than its author/.test(text))
    return makerChecker("Someone independent must decide this");
  if (/with a receipt photo/.test(text))
    return spendingConflict("receipt-required", "Add a receipt photo before approving");
  if (/within the last 90 days/.test(text))
    return spendingProblem(400, "expense-date-invalid", "The expense date is out of range");
  return null;
}

/** Project-scoped access on a record's project (role ∩ assignment, 404 outside the company). */
export type ProjectAccess = { project: ProjectRow; permissions: ReadonlySet<Permission> };

/**
 * Spending authorisation (ARCHITECTURE §4.8), always on the record's project:
 * - budgets, the cost ledger, budget vs actual, the forecast and alerts: SPENDING_READ_PERMISSIONS
 *   (`finance.view`, `finance.manage`); clients, suppliers and site agents hold neither;
 * - petty cash: PETTY_CASH_READ_PERMISSIONS (custodians with `finance.petty_cash`, finance, and the
 *   approvers of expenses, top-ups and counts);
 * - every record's `permissions` flags are computed from the same project permissions and the
 *   record's state as the actions themselves.
 */
@Injectable()
export class SpendingAccess {
  constructor(private readonly policy: AccessPolicy) {}

  async on(scope: Scope, projectId: string): Promise<ProjectAccess> {
    const project = await scope.tx.project.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id: projectId } },
      include: {
        members: { where: { userId: scope.access.userId }, select: { permissions: true } },
      },
    });
    if (!project) throw new NotFoundException("Project not found");
    const { members, ...row } = project;
    return {
      project: row,
      permissions: new Set<Permission>(
        effectiveProjectPermissions(scope.access, members[0]?.permissions ?? null),
      ),
    };
  }

  holds(access: ProjectAccess, permissions: readonly Permission[]): boolean {
    return permissions.some((permission) => access.permissions.has(permission));
  }

  canRead(access: ProjectAccess): boolean {
    return this.holds(access, SPENDING_READ_PERMISSIONS);
  }

  canReadPettyCash(access: ProjectAccess): boolean {
    return this.holds(access, PETTY_CASH_READ_PERMISSIONS);
  }

  canApprovePettyCash(access: ProjectAccess): boolean {
    return this.can(access, PETTY_CASH_APPROVE_PERMISSIONS);
  }

  /** 403 unless the caller may read the project's spending figures. */
  async reader(scope: Scope, projectId: string): Promise<ProjectAccess> {
    const access = await this.on(scope, projectId);
    if (!this.canRead(access))
      throw new ForbiddenException("No finance permission on this project");
    return access;
  }

  /** 403 unless the caller may see the project's petty cash. */
  async pettyCashReader(scope: Scope, projectId: string): Promise<ProjectAccess> {
    const access = await this.on(scope, projectId);
    if (!this.canReadPettyCash(access))
      throw new ForbiddenException("No petty-cash permission on this project");
    return access;
  }

  /** 403 unless one of `permissions` is held on the project; optionally step-up and writable. */
  async require(
    scope: Scope,
    projectId: string,
    permissions: readonly Permission[],
    options: { stepUp?: boolean; writable?: boolean } = {},
  ): Promise<ProjectAccess> {
    const access = await this.on(scope, projectId);
    if (!this.holds(access, permissions))
      throw new ForbiddenException(
        `One of these permissions is required: ${permissions.join(", ")}`,
      );
    if (options.stepUp) this.policy.stepUp(scope);
    if (options.writable) this.writable(access);
    return access;
  }

  writable(access: ProjectAccess): void {
    if (isProjectReadOnly(access.project.status as ProjectStatus))
      throw spendingConflict("project-read-only", "Closed and cancelled projects are read-only");
  }

  isWritable(access: ProjectAccess): boolean {
    return !isProjectReadOnly(access.project.status as ProjectStatus);
  }

  /** Holds one of `permissions` on the project and the project accepts changes. */
  can(access: ProjectAccess, permissions: readonly Permission[]): boolean {
    return this.holds(access, permissions) && this.isWritable(access);
  }

  /** A company-wide permission (company settings, cost codes and the company forecast). */
  company(scope: Scope, permissions: readonly Permission[]): boolean {
    return (
      scope.access.tenantWide &&
      permissions.some((permission) => scope.access.permissions.has(permission))
    );
  }

  requireCompany(scope: Scope, permissions: readonly Permission[], stepUp = false): void {
    if (!this.company(scope, permissions))
      throw new ForbiddenException(
        `A company-wide role with one of these permissions is required: ${permissions.join(", ")}`,
      );
    if (stepUp) this.policy.stepUp(scope);
  }

  stepUp(scope: Scope): void {
    this.policy.stepUp(scope);
  }

  /** The projects where the caller holds one of `permissions` (role ∩ assignment). */
  async projectIds(scope: Scope, permissions: readonly Permission[], only?: string) {
    const { access } = scope;
    const held = permissions.filter((permission) => access.permissions.has(permission));
    if (!held.length) return [];
    const rows = await scope.tx.project.findMany({
      where: {
        tenantId: access.tenantId,
        ...(only ? { id: only } : {}),
        ...(access.tenantWide
          ? {}
          : { members: { some: { userId: access.userId, permissions: { hasSome: [...held] } } } }),
      },
      select: { id: true },
      orderBy: { code: "asc" },
    });
    return rows.map((row) => row.id);
  }
}

// Numbering -----------------------------------------------------------------------------------

const NUMBERED = {
  expense: { table: "petty_cash_expenses", prefix: "EXP-" },
  topUp: { table: "petty_cash_top_ups", prefix: "TOP-" },
  count: { table: "petty_cash_counts", prefix: "CNT-" },
  journal: { table: "cost_journals", prefix: "JNL-" },
} as const;

/** The next EXP-/TOP-/CNT-/JNL-NNNN of the company (the tenant row lock serialises them). */
export async function nextSpendingNumber(tx: Tx, tenantId: string, kind: keyof typeof NUMBERED) {
  const { table, prefix } = NUMBERED[kind];
  const rows = await tx.$queryRawUnsafe<{ highest: number | null }[]>(
    `SELECT max(substring(number FROM 5)::bigint)::float8 AS highest FROM ${table}
      WHERE tenant_id = $1::uuid AND number ~ '^[A-Z]{3}-[0-9]{1,12}$'`,
    tenantId,
  );
  return `${prefix}${String((rows[0]?.highest ?? 0) + 1).padStart(4, "0")}`;
}

// Settings ------------------------------------------------------------------------------------

export type SpendingSettingsValues = {
  budgetAlertPercent: number;
  unusualSpendMultiplier: string;
  unusualSpendMinSamples: number;
  duplicateWindowDays: number;
  forecastWeeks: number;
  openingCashMinor: number | null;
  openingCashOn: string | null;
  version: number;
  updatedAt: string | null;
};

/** A decimal column without trailing zeros ("3.00" → "3", "2.50" → "2.5"). */
export const trimDecimal = (value: { toFixed(): string }) => {
  const text = value.toFixed();
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
};

export async function spendingSettings(tx: Tx, tenantId: string): Promise<SpendingSettingsValues> {
  const row = await tx.spendingSettings.findUnique({ where: { tenantId } });
  if (!row)
    return {
      ...DEFAULT_SPENDING_SETTINGS,
      openingCashMinor: null,
      openingCashOn: null,
      version: 0,
      updatedAt: null,
    };
  return {
    budgetAlertPercent: row.budgetAlertPercent,
    unusualSpendMultiplier: trimDecimal(row.unusualSpendMultiplier),
    unusualSpendMinSamples: row.unusualSpendMinSamples,
    duplicateWindowDays: row.duplicateWindowDays,
    forecastWeeks: row.forecastWeeks,
    openingCashMinor: row.openingCashMinor === null ? null : minorOf(row.openingCashMinor),
    openingCashOn: row.openingCashOn ? toCalendarDate(row.openingCashOn) : null,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// References ----------------------------------------------------------------------------------

/** The newest approved BQ version of a project (the BQ in force), or null. */
export async function approvedBqVersion(tx: Tx, tenantId: string, projectId: string) {
  return tx.bqVersion.findFirst({
    where: { tenantId, projectId, status: "approved" },
    orderBy: [{ approvedAt: "desc" }, { versionNo: "desc" }],
    select: { id: true, versionNo: true },
  });
}

type ItemKey = { versionId: string; lineageId: string };
export const itemKey = (versionId: string | null, lineageId: string | null) =>
  versionId && lineageId ? `${versionId}|${lineageId}` : null;

const bqItemSelect = {
  versionId: true,
  lineageId: true,
  ref: true,
  description: true,
  unit: true,
  bill: { select: { lineageId: true, number: true, title: true } },
} as const;

export const toBqItem = (row: {
  versionId: string;
  lineageId: string;
  ref: string | null;
  description: string;
  unit: string | null;
  bill: { lineageId: string; number: string; title: string } | null;
}): SpendingBqItem => ({
  versionId: row.versionId,
  lineageId: row.lineageId,
  ref: row.ref,
  description: row.description,
  unit: row.unit,
  bill: row.bill,
});

export { bqItemSelect };

/** BQ item references (with their bill) for (version, lineage) pairs. */
export async function bqItemRefs(
  tx: Tx,
  tenantId: string,
  keys: readonly (ItemKey | null)[],
): Promise<Map<string, SpendingBqItem>> {
  const wanted = new Map<string, ItemKey>();
  for (const key of keys) if (key) wanted.set(`${key.versionId}|${key.lineageId}`, key);
  if (!wanted.size) return new Map();
  const rows = await tx.bqItem.findMany({
    where: {
      tenantId,
      OR: [...wanted.values()].map((key) => ({
        versionId: key.versionId,
        lineageId: key.lineageId,
      })),
    },
    select: bqItemSelect,
  });
  return new Map(rows.map((row) => [`${row.versionId}|${row.lineageId}`, toBqItem(row)]));
}

export const costCodeRef = (row: { id: string; code: string; name: string; category: string }) => ({
  id: row.id,
  code: row.code,
  name: row.name,
  category: row.category as CostCategory,
});

/** Cost code references by ID. */
export async function costCodeRefs(tx: Tx, tenantId: string, ids: readonly (string | null)[]) {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!unique.length) return new Map<string, ReturnType<typeof costCodeRef>>();
  const rows = await tx.costCode.findMany({ where: { tenantId, id: { in: unique } } });
  return new Map(rows.map((row) => [row.id, costCodeRef(row)]));
}

/** Display names of suppliers (trading name first). */
export async function supplierNames(tx: Tx, tenantId: string, ids: readonly (string | null)[]) {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!unique.length) return new Map<string, string>();
  const rows = await tx.supplier.findMany({
    where: { tenantId, id: { in: unique } },
    select: { id: true, legalName: true, tradingName: true },
  });
  return new Map(rows.map((row) => [row.id, row.tradingName ?? row.legalName]));
}

export const minorOf = (value: bigint | number): number => {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new RangeError("Amount out of the safe integer range");
  return result;
};

export const projectRef = (row: { id: string; code: string; name: string }) => ({
  id: row.id,
  code: row.code,
  name: row.name,
});
