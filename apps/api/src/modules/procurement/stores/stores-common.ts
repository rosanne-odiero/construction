import { ConflictException, ForbiddenException, HttpException, Injectable } from "@nestjs/common";
import { fromMicro, toMicro } from "@pm-buddy/domain";
import type { Permission } from "@pm-buddy/types";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { Scope } from "../../identity/access-policy.js";
import { P2pAccess, projectRef, type ProjectAccess } from "../p2p/p2p-common.js";
import type { Tx } from "../procurement-mappers.js";

/** Stable problem codes for stores (the web maps them to EN/SW messages). */
export type StoresProblem =
  | "version-conflict"
  | "project-read-only"
  | "invalid-transition"
  | "reason-required"
  | "maker-checker"
  | "insufficient-stock"
  | "store-exists"
  | "site-not-in-project"
  | "site-required"
  | "storekeeper-not-member"
  | "grn-stock-consumed"
  | "bq-not-approved"
  | "bq-item-not-found"
  | "gang-not-in-project"
  | "material-archived"
  | "unit-unknown"
  | "unit-archived"
  | "no-conversion"
  | "invalid-quantity"
  | "negative-quantity"
  | "quantity-too-large"
  | "path-too-long"
  | "line-not-on-issue"
  | "return-exceeds-issued"
  | "issue-not-posted"
  | "movement-has-returns"
  | "idempotency-key-required"
  | "idempotency-key-reused"
  | "movement-id-conflict"
  | "transfer-id-conflict"
  | "count-id-conflict"
  | "transfer-lines-mismatch"
  | "difference-reason-required"
  | "stock-take-open"
  | "stock-take-incomplete"
  | "stock-take-empty"
  | "line-not-on-stock-take"
  | "buildup-line-not-material"
  | "measurement-future"
  | "measurement-not-found";

export const storesConflict = (code: StoresProblem, message: string) =>
  new ConflictException({ message, code });
export const storesProblem = (status: number, code: StoresProblem, message: string) =>
  new HttpException({ message, code }, status);
export const storesVersionConflict = () =>
  storesConflict(
    "version-conflict",
    "This record was changed by someone else. Reload and try again.",
  );
export const storesInvalidTransition = (status: string) =>
  storesConflict("invalid-transition", `Not possible while the record is ${status}`);

/**
 * Project-scoped permissions that let someone see a project's stores, stock ledger, movements,
 * transfers, stock takes and consumption variance (ARCHITECTURE §4.6): the storekeeper
 * (stores.manage), the people who request and approve materials, and finance viewers. Clients,
 * consultants and foremen do not see stock.
 */
export const STORES_VIEW_PERMISSIONS = [
  "stores.manage",
  "procurement.requisition",
  "procurement.approve",
  "finance.view",
  "finance.manage",
] as const satisfies readonly Permission[];

/** Records stock (issues, returns, wastage, transfers, counts, reorder levels, stores). */
export const STORES_MANAGE: Permission = "stores.manage";
/**
 * Approves stock takes and resolves disputed transfers: the people who approve material spending
 * (project manager, owner). The storekeeper role does not hold it, and the approver is never a
 * contributor to the count (identity-based maker-checker).
 */
export const STORES_APPROVE: Permission = "procurement.approve";

/**
 * Stores authorisation, always on the record's project (role ∩ assignment, resolved in the
 * caller's company; 404 otherwise). Every response's `permissions` flags use the same project
 * permissions and record state as the actions (D5.2 review finding 9).
 */
@Injectable()
export class StoresAccess {
  constructor(private readonly p2p: P2pAccess) {}

  on(scope: Scope, projectId: string): Promise<ProjectAccess> {
    return this.p2p.on(scope, projectId);
  }

  canView(access: ProjectAccess): boolean {
    return STORES_VIEW_PERMISSIONS.some((permission) => access.permissions.has(permission));
  }

  /** 403 unless the caller can see the project's stores. */
  async viewer(scope: Scope, projectId: string): Promise<ProjectAccess> {
    const access = await this.on(scope, projectId);
    if (!this.canView(access)) throw new ForbiddenException("No stores permission on this project");
    return access;
  }

  require(
    scope: Scope,
    projectId: string,
    permissions: readonly Permission[],
    options: { writable?: boolean } = {},
  ): Promise<ProjectAccess> {
    return this.p2p.require(scope, projectId, permissions, { writable: options.writable });
  }

  writable(access: ProjectAccess): void {
    this.p2p.writable(access);
  }

  /** Whether the project accepts changes (not closed or cancelled). */
  isWritable(access: ProjectAccess): boolean {
    try {
      this.p2p.writable(access);
      return true;
    } catch {
      return false;
    }
  }

  /** `permission` held on the project and the project accepts changes. */
  can(access: ProjectAccess, permission: Permission): boolean {
    return access.permissions.has(permission) && this.isWritable(access);
  }

  /** A filter for the projects whose stores the caller may see. */
  visibleProjects(scope: Scope): Prisma.ProjectWhereInput {
    const { access } = scope;
    const held = STORES_VIEW_PERMISSIONS.filter((permission) => access.permissions.has(permission));
    if (!held.length) return { id: { in: [] } };
    if (access.tenantWide) return { tenantId: access.tenantId };
    return {
      tenantId: access.tenantId,
      members: { some: { userId: access.userId, permissions: { hasSome: [...held] } } },
    };
  }

  async visibleProjectIds(scope: Scope, only?: string): Promise<string[]> {
    const rows = await scope.tx.project.findMany({
      where: { AND: [this.visibleProjects(scope), ...(only ? [{ id: only }] : [])] },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }
}

// Numbering ---------------------------------------------------------------------------------------

const NUMBERED = {
  issue: { table: "stock_movements", prefix: "ISS-" },
  return: { table: "stock_movements", prefix: "RTN-" },
  wastage: { table: "stock_movements", prefix: "WST-" },
  transfer: { table: "stock_transfers", prefix: "TRF-" },
  stockTake: { table: "stock_takes", prefix: "STK-" },
} as const;

/** The next ISS-/RTN-/WST-/TRF-/STK-NNNN of the company (the tenant row lock serialises them). */
export async function nextStoresNumber(tx: Tx, tenantId: string, kind: keyof typeof NUMBERED) {
  const { table, prefix } = NUMBERED[kind];
  const rows = await tx.$queryRawUnsafe<{ highest: number | null }[]>(
    `SELECT max(substring(number FROM 5)::bigint)::float8 AS highest FROM ${table}
      WHERE tenant_id = $1::uuid AND number LIKE $2 AND number ~ '^[A-Z]{3}-[0-9]{1,12}$'`,
    tenantId,
    `${prefix}%`,
  );
  return `${prefix}${String((rows[0]?.highest ?? 0) + 1).padStart(4, "0")}`;
}

// Wire helpers --------------------------------------------------------------------------------

/** A numeric column as an exact decimal string without trailing zeros. */
export const dec = (value: { toFixed(): string }) => fromMicro(toMicro(value.toFixed()));
export const decOrNull = (value: { toFixed(): string } | null) =>
  value === null ? null : dec(value);

export type StoreRefWire = {
  id: string;
  name: string;
  project: { id: string; code: string; name: string };
  site: { id: string; name: string };
};

/** Store references (name, project and site) for a set of store IDs. */
export async function storeRefs(
  scope: Scope,
  storeIds: readonly string[],
): Promise<Map<string, StoreRefWire>> {
  const unique = [...new Set(storeIds)];
  if (!unique.length) return new Map();
  const rows = await scope.tx.store.findMany({
    where: { tenantId: scope.access.tenantId, id: { in: unique } },
    include: { site: { include: { project: { select: { id: true, code: true, name: true } } } } },
  });
  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        name: row.name,
        project: projectRef(row.site.project),
        site: { id: row.site.id, name: row.site.name },
      },
    ]),
  );
}
