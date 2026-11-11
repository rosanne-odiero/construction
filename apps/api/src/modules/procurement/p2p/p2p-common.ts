import { createHash } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  comparableUnitPrice,
  convertQuantity,
  exactNetPrice,
  isProjectReadOnly,
  netPricePerBase,
  Ratio,
  type ConversionStep,
} from "@pm-buddy/domain";
import {
  DEFAULT_BLOCK_PAYMENT_WITHOUT_ETIMS,
  DEFAULT_MIN_QUOTES,
  type Permission,
  type ProjectStatus,
  type VatTreatment,
} from "@pm-buddy/types";
import type { Prisma } from "../../../generated/prisma/client.js";
import { AccessPolicy, type Scope } from "../../identity/access-policy.js";
import { effectiveProjectPermissions } from "../../identity/role-grants.js";
import type { ProjectRow } from "../../projects/project-mappers.js";
import { CatalogueStore } from "../catalogue-store.js";
import type { MaterialRow, People, Tx, UnitRow } from "../procurement-mappers.js";

/** Stable problem codes for procure-to-pay (the web maps them to EN/SW messages). */
export type P2pProblem =
  | "version-conflict"
  | "project-read-only"
  | "invalid-transition"
  | "reason-required"
  | "maker-checker"
  | "site-not-in-project"
  | "material-archived"
  | "unit-unknown"
  | "unit-archived"
  | "no-conversion"
  | "invalid-quantity"
  | "negative-quantity"
  | "quantity-too-large"
  | "path-too-long"
  | "bq-item-not-found"
  | "requisition-on-rfq"
  | "requisition-not-approved"
  | "requisitions-other-project"
  | "supplier-blocked"
  | "supplier-not-active"
  | "supplier-not-invited"
  | "supplier-has-quotation"
  | "quotation-exists"
  | "quotation-lines-mismatch"
  | "quotation-incomplete"
  | "quotation-expired"
  | "quotation-not-received"
  | "not-enough-quotes"
  | "exception-not-requested"
  | "exception-exists"
  | "rfq-not-open"
  | "lpo-not-approved"
  | "lpo-has-deliveries"
  | "line-not-on-order"
  | "idempotency-key-required"
  | "idempotency-key-reused"
  | "grn-id-conflict"
  | "grn-supports-approved-invoice"
  | "too-many-photos"
  | "file-required"
  | "unsupported-file-type"
  | "payload-too-large"
  | "malware-detected"
  | "invoice-number-taken"
  | "invoice-total-arithmetic"
  | "match-stale"
  | "match-not-passing"
  | "match-not-exceptable"
  | "payee-not-verified"
  | "payee-changed"
  | "approval-current"
  | "invoice-not-payable"
  | "settlement-exceeds-outstanding"
  | "settlement-reference-taken"
  | "settlement-date-invalid";

export const p2pConflict = (code: P2pProblem, message: string) =>
  new ConflictException({ message, code });
export const p2pBadRequest = (code: P2pProblem, message: string) =>
  new BadRequestException({ message, code });
export const p2pProblem = (status: number, code: P2pProblem, message: string) =>
  new HttpException({ message, code }, status);
export const p2pVersionConflict = () =>
  p2pConflict("version-conflict", "This record was changed by someone else. Reload and try again.");
export const makerChecker = (message: string) => p2pProblem(403, "maker-checker", message);
export const invalidTransition = (status: string) =>
  p2pConflict("invalid-transition", `Not possible while the record is ${status}`);

/** Project-scoped permissions that let someone see a project's procurement records. */
export const P2P_VIEW_PERMISSIONS = [
  "procurement.requisition",
  "procurement.approve",
  "stores.manage",
  "finance.view",
  "finance.manage",
  "payments.approve",
  "payments.disburse",
] as const satisfies readonly Permission[];

export type ProjectAccess = { project: ProjectRow; permissions: ReadonlySet<Permission> };

/**
 * Procure-to-pay authorisation (ARCHITECTURE §4.5, §8), always on the record's project, resolved in
 * the caller's company (404 otherwise):
 * - see: any P2P_VIEW_PERMISSIONS on the project, or company-level procurement.manage_suppliers;
 * - requisitions: procurement.requisition; decide: procurement.approve (not a contributor);
 * - RFQs, quotations, awards and LPO drafts: procurement.manage_suppliers (company-level);
 *   single-source exceptions and LPO approval: procurement.approve (+ step-up for LPOs);
 * - GRNs: stores.manage or procurement.requisition; voiding: stores.manage;
 * - invoices: finance.manage or procurement.manage_suppliers; approval and match exceptions:
 *   payments.approve + step-up; settlements: payments.disburse + step-up (company-wide roles,
 *   as payment permissions cannot be assigned per project).
 */
@Injectable()
export class P2pAccess {
  constructor(private readonly policy: AccessPolicy) {}

  /** The project in the caller's company and their effective permissions on it (404 if absent). */
  async on(scope: Scope, projectId: string): Promise<ProjectAccess> {
    const project = await scope.tx.project.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id: projectId } },
      include: { members: { where: { userId: scope.access.userId }, select: { permissions: true } } },
    });
    if (!project) throw new NotFoundException("Project not found");
    const { members, ...row } = project;
    const permissions = new Set<Permission>(
      effectiveProjectPermissions(scope.access, members[0]?.permissions ?? null),
    );
    if (scope.access.permissions.has("procurement.manage_suppliers"))
      permissions.add("procurement.manage_suppliers");
    return { project: row, permissions };
  }

  canView(access: ProjectAccess): boolean {
    return (
      access.permissions.has("procurement.manage_suppliers") ||
      P2P_VIEW_PERMISSIONS.some((permission) => access.permissions.has(permission))
    );
  }

  /** 403 unless the caller can see the project's procurement records. */
  async viewer(scope: Scope, projectId: string): Promise<ProjectAccess> {
    const access = await this.on(scope, projectId);
    if (!this.canView(access))
      throw new ForbiddenException("No procurement permission on this project");
    return access;
  }

  /** 403 unless the caller holds one of `permissions` on the project; optionally step-up. */
  async require(
    scope: Scope,
    projectId: string,
    permissions: readonly Permission[],
    options: { stepUp?: boolean; writable?: boolean } = {},
  ): Promise<ProjectAccess> {
    const access = await this.on(scope, projectId);
    if (!permissions.some((permission) => access.permissions.has(permission)))
      throw new ForbiddenException(`One of these permissions is required: ${permissions.join(", ")}`);
    if (options.stepUp) this.policy.stepUp(scope);
    if (options.writable) this.writable(access);
    return access;
  }

  /** 409 when the project is closed or cancelled (read-only). */
  writable(access: ProjectAccess): void {
    if (isProjectReadOnly(access.project.status as ProjectStatus))
      throw p2pConflict("project-read-only", "Closed and cancelled projects are read-only");
  }

  /** A filter for the projects whose procurement records the caller may see. */
  visibleProjects(scope: Scope): Prisma.ProjectWhereInput {
    const { access } = scope;
    if (access.permissions.has("procurement.manage_suppliers") || access.tenantWide) {
      if (
        access.permissions.has("procurement.manage_suppliers") ||
        P2P_VIEW_PERMISSIONS.some((permission) => access.permissions.has(permission))
      )
        return { tenantId: access.tenantId };
      return { id: { in: [] } };
    }
    const held = P2P_VIEW_PERMISSIONS.filter((permission) => access.permissions.has(permission));
    if (!held.length) return { id: { in: [] } };
    return {
      tenantId: access.tenantId,
      members: {
        some: { userId: access.userId, permissions: { hasSome: [...held] } },
      },
    };
  }

  /** Project IDs (for list filters), optionally narrowed to one project. */
  async visibleProjectIds(scope: Scope, only?: string): Promise<string[]> {
    const rows = await scope.tx.project.findMany({
      where: { AND: [this.visibleProjects(scope), ...(only ? [{ id: only }] : [])] },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  stepUp(scope: Scope): void {
    this.policy.stepUp(scope);
  }
}

// Numbering ---------------------------------------------------------------------------------------

const NUMBERED = {
  requisition: { table: "requisitions", prefix: "REQ-" },
  rfq: { table: "rfqs", prefix: "RFQ-" },
  lpo: { table: "lpos", prefix: "LPO-" },
  grn: { table: "grns", prefix: "GRN-" },
} as const;

/** The next REQ-/RFQ-/LPO-/GRN-NNNN of the company (the tenant row lock serialises creates). */
export async function nextNumber(tx: Tx, tenantId: string, kind: keyof typeof NUMBERED) {
  const { table, prefix } = NUMBERED[kind];
  const rows = await tx.$queryRawUnsafe<{ highest: number | null }[]>(
    `SELECT max(substring(number FROM 5)::bigint)::float8 AS highest FROM ${table}
      WHERE tenant_id = $1::uuid AND number ~ '^[A-Z]{3}-[0-9]{1,12}$'`,
    tenantId,
  );
  return `${prefix}${String((rows[0]?.highest ?? 0) + 1).padStart(4, "0")}`;
}

// Settings, sets and digests ------------------------------------------------------------------

export type P2pSettings = {
  minQuotes: number;
  qtyTolerancePercent: string;
  priceTolerancePercent: string;
  blockPaymentWithoutEtims: boolean;
};

export async function p2pSettings(scope: Scope): Promise<P2pSettings> {
  const row = await scope.tx.procurementSettings.findUnique({
    where: { tenantId: scope.access.tenantId },
  });
  return {
    minQuotes: row?.minQuotes ?? DEFAULT_MIN_QUOTES,
    qtyTolerancePercent: row ? row.qtyTolerancePercent.toFixed() : "0",
    priceTolerancePercent: row ? row.priceTolerancePercent.toFixed() : "0",
    blockPaymentWithoutEtims: row?.blockPaymentWithoutEtims ?? DEFAULT_BLOCK_PAYMENT_WITHOUT_ETIMS,
  };
}

/** The recorded GRNs of an LPO, in the database's order (what a match counts). */
export async function grnSet(tx: Tx, tenantId: string, lpoId: string): Promise<string[]> {
  const rows = await tx.$queryRaw<{ ids: string[] }[]>`
    SELECT app.lpo_grn_set(${tenantId}::uuid, ${lpoId}::uuid)::text[] AS ids`;
  return rows[0]?.ids ?? [];
}

/** The LPO's other approved invoices, in the database's order (already billed). */
export async function priorInvoiceSet(
  tx: Tx,
  tenantId: string,
  lpoId: string,
  invoiceId: string,
): Promise<string[]> {
  const rows = await tx.$queryRaw<{ ids: string[] }[]>`
    SELECT app.lpo_prior_invoice_set(${tenantId}::uuid, ${lpoId}::uuid, ${invoiceId}::uuid)::text[] AS ids`;
  return rows[0]?.ids ?? [];
}

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
};

/** SHA-256 of a request's canonical JSON (idempotency fingerprint, brief §15 D). */
export const requestDigest = (operation: string, body: unknown) =>
  createHash("sha256")
    .update(JSON.stringify({ operation, body: canonical(body) }))
    .digest("hex");

export const sameMembers = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && [...left].sort().join() === [...right].sort().join();

// Conversions and prices ----------------------------------------------------------------------

const refusalCode = (reason: string): P2pProblem =>
  reason === "unknown-unit" ? "unit-unknown" : (reason as P2pProblem);

/** A quantity in `unit` converted to the material's base unit (422 with the refusal code). */
export async function toBaseQuantity(
  store: CatalogueStore,
  scope: Scope,
  material: MaterialRow,
  supplierId: string | null,
  on: string,
  quantity: string,
  unit: string,
  units: UnitRow[],
): Promise<{ baseQuantity: string; ratio: string; steps: ConversionStep[] }> {
  const context = await store.context(scope, material, supplierId, on, units);
  const result = convertQuantity(quantity, unit, material.baseUnit, context);
  if (!result.ok)
    throw p2pProblem(422, refusalCode(result.reason), `Cannot convert ${unit} to ${material.baseUnit}`);
  return { baseQuantity: result.quantity, ratio: result.ratio.toString(), steps: result.steps };
}

/**
 * A price per `priceUnit` taken net of VAT and per base unit (exact), with the ratio of price units
 * per base unit (422 when the units cannot be converted for this material and supplier).
 */
export async function pricePerBase(
  store: CatalogueStore,
  scope: Scope,
  material: MaterialRow,
  supplierId: string | null,
  on: string,
  input: { priceUnit: string; unitPriceMinor: number; vatTreatment: VatTreatment },
  vatRatePercent: string,
  units: UnitRow[],
): Promise<{ ratio: Ratio; netPerBase: Ratio }> {
  const context = await store.context(scope, material, supplierId, on, units);
  const comparable = comparableUnitPrice(
    exactNetPrice(input.unitPriceMinor, input.vatTreatment, vatRatePercent),
    input.priceUnit,
    material.baseUnit,
    context,
  );
  if (!comparable.ok)
    throw p2pProblem(
      422,
      "no-conversion",
      `Cannot express a price per ${input.priceUnit} per ${material.baseUnit}`,
    );
  return {
    ratio: comparable.ratio,
    netPerBase: netPricePerBase(
      input.unitPriceMinor,
      input.vatTreatment,
      vatRatePercent,
      comparable.ratio,
    ),
  };
}

/** The exact net price per base unit of a stored priced line. */
export const storedNetPerBase = (
  line: { unitPriceMinor: bigint; vatTreatment: string; priceRatio: string },
  vatRatePercent: string,
) =>
  netPricePerBase(
    Number(line.unitPriceMinor),
    line.vatTreatment as VatTreatment,
    vatRatePercent,
    Ratio.parse(line.priceRatio),
  );

/** Sums six-decimal quantities exactly. */
export const sumQuantities = (values: readonly { toFixed(): string }[]): Ratio =>
  values.reduce((total, value) => total.plus(Ratio.fromDecimal(value.toFixed())), Ratio.of(0));

export const qtyText = (value: Ratio) => value.toDecimal(6).value;

// Wire helpers --------------------------------------------------------------------------------

export const iso = (value: Date) => value.toISOString();
export const isoOrNull = (value: Date | null) => (value ? value.toISOString() : null);
export const personOrNull = (people: People, id: string | null) =>
  id ? { id, displayName: people.get(id) ?? "—" } : null;
export const projectRef = (row: { id: string; code: string; name: string }) => ({
  id: row.id,
  code: row.code,
  name: row.name,
});
export const materialWire = (row: Pick<MaterialRow, "id" | "code" | "name" | "baseUnit">) => ({
  id: row.id,
  code: row.code,
  name: row.name,
  baseUnit: row.baseUnit,
});
