import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { catchError, throwError, type Observable } from "rxjs";
import {
  measurementBasis,
  measurementsInForce,
  sumQuantities,
  subcontractAdvanceCode,
  subcontractCertificateCode,
  subcontractCode,
  subcontractVariationCode,
  type SubcontractLineTerms,
} from "@pm-buddy/domain";
import {
  SUBCONTRACT_READ_PERMISSIONS,
  type Permission,
  type SubcontractLineBasis,
  type SubcontractVatTreatment,
} from "@pm-buddy/types";
import type { SpendingBqItem, SubcontractorRef } from "@pm-buddy/validation";
import {
  hasDatabaseCode,
  isCheckViolation,
  isForeignKeyViolation,
  isUniqueViolation,
} from "../../common/database-errors.js";
import type { Prisma } from "../../generated/prisma/client.js";
import {
  SpendingAccess,
  minorOf,
  trimDecimal,
  type ProjectAccess,
} from "../finance/spending-common.js";
import type { Scope } from "../identity/access-policy.js";
import { toCalendarDate } from "../projects/project-mappers.js";
import {
  approvedMeasurements,
  bqInForce,
  measurable,
} from "../progress/valuations/valuation-common.js";

export type Tx = Prisma.TransactionClient;

/** Stable problem codes of subcontracts (the web maps them to EN/SW messages). */
export type SubcontractProblem =
  | "version-conflict"
  | "project-read-only"
  | "invalid-transition"
  | "maker-checker"
  | "bq-not-approved"
  | "bq-item-not-found"
  | "item-not-measurable"
  | "subcontractor-not-eligible"
  | "subcontract-empty"
  | "line-exists"
  | "too-many-lines"
  | "over-bq-quantity"
  | "advance-not-recoverable"
  | "subcontract-stale"
  | "subcontract-has-open-items"
  | "subcontract-variation-open"
  | "subcontract-variation-stale"
  | "line-below-certified"
  | "advance-exceeds-limit"
  | "certificate-open"
  | "certificate-stale"
  | "certificate-date-invalid"
  | "completion-not-certified"
  | "release-exists"
  | "nothing-to-release"
  | "release-exceeds-held"
  | "no-certified-certificate"
  | "claim-exceeds-line"
  | "claim-exceeds-measured"
  | "basis-changed"
  | "payment-exceeds-payable"
  | "payment-reference-taken"
  | "payment-date-invalid"
  | "idempotency-key-required"
  | "idempotency-key-reused"
  | "invoice-amount-mismatch"
  | "invoice-number-taken"
  | "invoice-exists"
  | "export-too-large"
  | "subcontract-rule";

export function subcontractProblem(
  status: 400 | 403 | 404 | 409 | 422,
  code: SubcontractProblem,
  message: string,
  extra: Record<string, unknown> = {},
): HttpException {
  const body = { code, message, ...extra };
  if (status === 403) return new ForbiddenException(body);
  if (status === 404) return new NotFoundException(body);
  if (status === 409) return new ConflictException(body);
  return new HttpException(
    body,
    status === 400 ? HttpStatus.BAD_REQUEST : HttpStatus.UNPROCESSABLE_ENTITY,
  );
}
export const subcontractConflict = (code: SubcontractProblem, message: string) =>
  subcontractProblem(409, code, message);
export const versionConflict = () =>
  subcontractConflict(
    "version-conflict",
    "This record was changed by someone else. Reload and try again.",
  );
export const invalidTransition = (status: string) =>
  subcontractConflict("invalid-transition", `Not possible while the record is ${status}`);
export const makerChecker = (message: string) => subcontractProblem(403, "maker-checker", message);

/** The database's own message, wherever the driver adapter put it. */
function databaseMessage(error: unknown): string {
  const seen = new Set<unknown>();
  const pending: unknown[] = [error];
  const messages: string[] = [];
  while (pending.length) {
    const current = pending.pop();
    if (typeof current !== "object" || current === null || seen.has(current)) continue;
    seen.add(current);
    const fields = current as Record<string, unknown>;
    if (typeof fields["message"] === "string") messages.push(fields["message"]);
    pending.push(fields["cause"], fields["meta"], fields["driverAdapterError"]);
  }
  return messages.join(" ");
}

const RULES: [RegExp, 403 | 409 | 422, SubcontractProblem, string][] = [
  [/read-only/, 409, "project-read-only", "Closed and cancelled projects are read-only"],
  [
    /someone other than|other than its maker|other than its creator|neither asked for nor approved|other than the certifier/,
    403,
    "maker-checker",
    "Someone independent must do this",
  ],
  [
    /never exceeds the BQ quantity in force/,
    409,
    "over-bq-quantity",
    "The subcontracted quantity on this BQ item would exceed the BQ quantity; give a reason",
  ],
  [
    /never exceed its approved measured quantity/,
    409,
    "claim-exceeds-measured",
    "This claims more than was measured and approved on the BQ item",
  ],
  [
    /recoverable within the subcontract value/,
    409,
    "advance-not-recoverable",
    "The advance cannot be recovered by the terms",
  ],
  [
    /never exceed the advance agreed/,
    409,
    "advance-exceeds-limit",
    "This is more than the advance agreed",
  ],
  [
    /never exceed what the certificate made payable/,
    409,
    "payment-exceeds-payable",
    "This is more than is still payable",
  ],
  [
    /already a supplier invoice|matched to a subcontract certificate/,
    409,
    "invoice-number-taken",
    "This invoice number is already used for this supplier",
  ],
  [
    /for its amount due and VAT/,
    409,
    "invoice-amount-mismatch",
    "The invoice must be for the certificate's amount due plus VAT",
  ],
  [
    /below what was certified/,
    409,
    "line-below-certified",
    "A line cannot go below what was certified",
  ],
  [
    /flagged as a subcontractor/,
    409,
    "subcontractor-not-eligible",
    "Choose an active supplier flagged as a subcontractor",
  ],
  [
    /appears once on a subcontract/,
    409,
    "line-exists",
    "This BQ item is already on the subcontract",
  ],
  [/at most 500 lines/, 409, "too-many-lines", "A subcontract has at most 500 lines"],
  [
    /item's basis|in its unit|measured by quantity/,
    422,
    "item-not-measurable",
    "This BQ item cannot be let this way",
  ],
  [/item of the BQ in force/, 409, "bq-not-approved", "Use an item of the BQ in force"],
  [
    /certified % completion|after the certified/,
    409,
    "completion-not-certified",
    "Retention is released after the completion is certified",
  ],
  [
    /releases no more than is held/,
    409,
    "release-exceeds-held",
    "This would release more than is held",
  ],
  [
    /dated on or after the last one/,
    409,
    "certificate-date-invalid",
    "The date is in the future or before the last certificate",
  ],
  [
    /not recorded in the future|paid as approved, not in the future/,
    409,
    "payment-date-invalid",
    "A payment date cannot be in the future",
  ],
  [
    /no certificate or variation open/,
    409,
    "subcontract-has-open-items",
    "Finish or cancel the open certificate or variation first",
  ],
  [
    /terms and version in force|nets off every certificate|advances paid by its date|lines add up|terms in force|exactly as submitted|retention left/,
    409,
    "certificate-stale",
    "Something changed since it was submitted; return it and submit again",
  ],
  [
    /never change|never deleted|never rewritten|cannot change from|only with their submission|only ever added|keeps its|only on an interim draft|while it is pending|starts as|on an approved|for an active subcontract|at least one line/,
    409,
    "invalid-transition",
    "Not possible in this state",
  ],
  [
    /numbered one after another/,
    409,
    "version-conflict",
    "Someone else changed this; reload and try again",
  ],
];

/**
 * Maps a database refusal that the API's own checks did not catch first (a trigger's rule, a
 * unique key, a privilege) to a stable problem instead of a 500. The database message is matched
 * but never echoed.
 */
export function subcontractDatabaseProblem(error: unknown): HttpException | null {
  if (error instanceof HttpException) return null;
  if (isUniqueViolation(error)) {
    const text = databaseMessage(error);
    if (/one_open/.test(text))
      return subcontractConflict("certificate-open", "A certificate is already being prepared");
    if (/one_pending/.test(text))
      return subcontractConflict(
        "subcontract-variation-open",
        "A variation is already waiting for a decision",
      );
    if (/reference_key/.test(text))
      return subcontractConflict(
        "payment-reference-taken",
        "This payment reference is already recorded",
      );
    if (/invoice_number_key/.test(text))
      return subcontractConflict(
        "invoice-number-taken",
        "This invoice number is already used for this supplier",
      );
    if (/one_release_per_stage/.test(text))
      return subcontractConflict("release-exists", "This retention was already released");
    return subcontractConflict("subcontract-rule", "This conflicts with an existing record.");
  }
  if (isCheckViolation(error)) {
    const text = databaseMessage(error);
    for (const [pattern, status, code, message] of RULES)
      if (pattern.test(text)) return subcontractProblem(status, code, message);
    return subcontractConflict("subcontract-rule", "The change breaks a subcontract rule.");
  }
  if (isForeignKeyViolation(error) || hasDatabaseCode(error, ["23P01"]))
    return subcontractConflict("subcontract-rule", "The change breaks a subcontract rule.");
  if (hasDatabaseCode(error, ["42501"]))
    return subcontractProblem(
      403,
      "subcontract-rule",
      "This subcontract record cannot be changed.",
    );
  return null;
}

/** Applies subcontractDatabaseProblem to every subcontract endpoint (never a 500). */
@Injectable()
export class SubcontractDatabaseErrors implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next
      .handle()
      .pipe(
        catchError((error: unknown) =>
          throwError(() => subcontractDatabaseProblem(error) ?? error),
        ),
      );
  }
}

// Access ------------------------------------------------------------------------------------------

/**
 * Subcontract access (ARCHITECTURE §4.16, decision D-149): always on the record's project, role ∩
 * assignment, 404 outside the company; reading needs SUBCONTRACT_READ_PERMISSIONS; each action
 * its own list (and step-up where money is committed, certified or paid).
 */
@Injectable()
export class SubcontractAccess {
  constructor(private readonly spending: SpendingAccess) {}

  on(scope: Scope, projectId: string): Promise<ProjectAccess> {
    return this.spending.on(scope, projectId);
  }
  holds(access: ProjectAccess, permissions: readonly Permission[]) {
    return this.spending.holds(access, permissions);
  }
  can(access: ProjectAccess, permissions: readonly Permission[]) {
    return this.spending.can(access, permissions);
  }
  async reader(scope: Scope, projectId: string): Promise<ProjectAccess> {
    const access = await this.on(scope, projectId);
    if (!this.holds(access, SUBCONTRACT_READ_PERMISSIONS))
      throw new ForbiddenException("No permission to see subcontracts on this project");
    return access;
  }
  require(
    scope: Scope,
    projectId: string,
    permissions: readonly Permission[],
    options: { stepUp?: boolean; writable?: boolean } = {},
  ) {
    return this.spending.require(scope, projectId, permissions, options);
  }
  projectIds(scope: Scope, permissions: readonly Permission[]) {
    return this.spending.projectIds(scope, permissions);
  }
}

/** Locks the subcontract row (FOR UPDATE) so its lines, advances and certificates serialise. */
export const lockSubcontract = (tx: Tx, tenantId: string, id: string) =>
  tx.$queryRaw`SELECT id FROM subcontracts WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid FOR UPDATE`;

/** The per-item advisory lock the database takes when it checks claims against measurement. */
export const lockItemClaims = (tx: Tx, tenantId: string, lineage: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`subcontract-claim:${tenantId}:${lineage}`}, 0))`;

/** The per-item advisory lock the database takes for BQ caps (subcontract approvals). */
export const lockItemCap = (tx: Tx, tenantId: string, lineage: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`subcontract-item:${tenantId}:${lineage}`}, 0))`;

// Wire helpers -------------------------------------------------------------------------------------

export const codes = {
  subcontract: subcontractCode,
  certificate: subcontractCertificateCode,
  variation: subcontractVariationCode,
  advance: subcontractAdvanceCode,
};

export const decimalOrNull = (value: { toFixed(): string } | null) =>
  value === null ? null : trimDecimal(value);

export const supplierSelect = {
  id: true,
  code: true,
  legalName: true,
  tradingName: true,
  kraPinMasked: true,
  etimsStatus: true,
} as const;

export const supplierRef = (row: {
  id: string;
  code: string;
  legalName: string;
  tradingName: string | null;
  kraPinMasked: string | null;
  etimsStatus: string;
}): SubcontractorRef => ({
  id: row.id,
  code: row.code,
  name: row.tradingName ?? row.legalName,
  kraPinMasked: row.kraPinMasked,
  etimsStatus: row.etimsStatus,
});

export const itemWithBill = {
  bill: { select: { lineageId: true, number: true, title: true, sortOrder: true } },
} as const;
export type ItemRow = Prisma.BqItemGetPayload<{ include: typeof itemWithBill }>;

export const itemWire = (item: ItemRow): SpendingBqItem => ({
  versionId: item.versionId,
  lineageId: item.lineageId,
  ref: item.ref,
  description: item.description,
  unit: item.unit,
  bill: { lineageId: item.bill.lineageId, number: item.bill.number, title: item.bill.title },
});

// Lines in force --------------------------------------------------------------------------------

export const lineInclude = {
  bqItem: { include: itemWithBill },
  variation: { select: { id: true, number: true, status: true } },
} as const satisfies Prisma.SubcontractLineInclude;
export type LineRecord = Prisma.SubcontractLineGetPayload<{ include: typeof lineInclude }>;

export type LineInForce = {
  row: LineRecord;
  inForce: boolean;
  quantity: string;
  amountMinor: number;
  terms: SubcontractLineTerms;
};

/** A subcontract's lines with their quantity and value in force (approved variations applied). */
export async function linesOf(
  tx: Tx,
  tenantId: string,
  subcontractId: string,
): Promise<LineInForce[]> {
  const [rows, changes] = await Promise.all([
    tx.subcontractLine.findMany({
      where: { tenantId, subcontractId },
      include: lineInclude,
      orderBy: { lineNo: "asc" },
    }),
    tx.subcontractLineChange.findMany({
      where: { tenantId, subcontractId, variation: { status: "approved" } },
    }),
  ]);
  return rows.map((row) => {
    const own = changes.filter((change) => change.lineId === row.id);
    const quantity = sumQuantities([
      row.quantity.toFixed(),
      ...own.map((change) => change.quantityChange.toFixed()),
    ]);
    const amountMinor =
      minorOf(row.amountMinor) +
      own.reduce((sum, change) => sum + minorOf(change.amountChangeMinor), 0);
    return {
      row,
      inForce: row.variationId === null || row.variation?.status === "approved",
      quantity,
      amountMinor,
      terms: {
        basis: row.basis as SubcontractLineBasis,
        quantity,
        rateMinor: row.rateMinor === null ? null : minorOf(row.rateMinor),
        amountMinor,
        vatTreatment: row.vatTreatment as SubcontractVatTreatment,
      },
    };
  });
}

/** The lines of a subcontract's latest certified certificate: quantity and value to date. */
export async function lastCertifiedLines(tx: Tx, tenantId: string, subcontractId: string) {
  const last = await tx.subcontractCertificate.findFirst({
    where: { tenantId, subcontractId, status: "certified" },
    orderBy: { certificateNumber: "desc" },
    select: { id: true, revision: true },
  });
  const map = new Map<string, { quantity: string; valueMinor: number }>();
  if (!last) return map;
  const rows = await tx.subcontractCertificateLine.findMany({
    where: { tenantId, certificateId: last.id, revision: last.revision },
  });
  for (const row of rows)
    map.set(row.lineId, {
      quantity: trimDecimal(row.quantityToDate),
      valueMinor: minorOf(row.valueToDateMinor),
    });
  return map;
}

/**
 * Quantity let on each BQ item (lineage) by each live subcontract of a project, mirroring
 * app.subcontract_item_let: lines in force while approved or active; the last certified quantity
 * once completed or terminated.
 */
export async function projectLets(
  tx: Tx,
  tenantId: string,
  projectId: string,
): Promise<Map<string, Map<string, string>>> {
  const subcontracts = await tx.subcontract.findMany({
    where: {
      tenantId,
      projectId,
      status: { in: ["approved", "active", "completed", "terminated"] },
    },
    select: { id: true, status: true },
  });
  const result = new Map<string, Map<string, string>>();
  for (const subcontract of subcontracts) {
    const lines = (await linesOf(tx, tenantId, subcontract.id)).filter((line) => line.inForce);
    const closed = subcontract.status === "completed" || subcontract.status === "terminated";
    const certified = closed
      ? await lastCertifiedLines(tx, tenantId, subcontract.id)
      : new Map<string, { quantity: string; valueMinor: number }>();
    for (const line of lines) {
      const quantity = closed ? (certified.get(line.row.id)?.quantity ?? "0") : line.quantity;
      const byItem = result.get(line.row.bqItemLineageId) ?? new Map<string, string>();
      byItem.set(subcontract.id, sumQuantities([byItem.get(subcontract.id) ?? "0", quantity]));
      result.set(line.row.bqItemLineageId, byItem);
    }
  }
  return result;
}

/** Σ of the quantities let on an item, optionally without one subcontract. */
export const letOn = (lets: Map<string, Map<string, string>>, lineage: string, except?: string) =>
  sumQuantities(
    [...(lets.get(lineage)?.entries() ?? [])]
      .filter(([id]) => id !== except)
      .map(([, quantity]) => quantity),
  );

/**
 * The approved measured quantity in force per BQ item on a date (D6.3), in the item's basis on
 * the BQ in force — the same rule as app.measured_in_force.
 */
export async function measuredAt(tx: Tx, tenantId: string, projectId: string, date: string) {
  const version = await bqInForce(tx, tenantId, projectId);
  const result = new Map<string, { quantity: string; measuredOn: string }>();
  if (!version) return result;
  const [items, approved] = await Promise.all([
    tx.bqItem.findMany({ where: { tenantId, versionId: version.id } }),
    approvedMeasurements(tx, tenantId, projectId),
  ]);
  const basisOf = new Map(
    items.map((item) => [item.lineageId, measurementBasis(measurable(item))]),
  );
  const rows = approved
    .filter((row) => {
      const basis = basisOf.get(row.itemLineageId);
      return basis != null && (row.basis ?? "quantity") === basis;
    })
    .map((row) => ({
      id: row.id,
      lineageId: row.itemLineageId,
      measuredOn: toCalendarDate(row.measuredOn),
      recordedAt: row.recordedAt.toISOString(),
      state: "approved" as const,
      quantity: trimDecimal(row.quantityToDate),
    }));
  for (const [lineage, row] of measurementsInForce(rows, date))
    result.set(lineage, { quantity: row.quantity, measuredOn: row.measuredOn });
  return result;
}

/**
 * What the other subcontracts of a project claim per BQ item: the lines of each one's latest live
 * certificate (submitted or certified), with the latest of their dates.
 */
export async function otherClaims(
  tx: Tx,
  tenantId: string,
  projectId: string,
  exceptSubcontract: string,
): Promise<Map<string, { quantity: string; latest: string }>> {
  const certificates = await tx.subcontractCertificate.findMany({
    where: {
      tenantId,
      projectId,
      subcontractId: { not: exceptSubcontract },
      status: { in: ["submitted", "certified"] },
    },
    orderBy: [{ subcontractId: "asc" }, { number: "desc" }],
    select: { id: true, subcontractId: true, revision: true, valuationDate: true },
  });
  const latest = new Map<string, (typeof certificates)[number]>();
  for (const row of certificates)
    if (!latest.has(row.subcontractId)) latest.set(row.subcontractId, row);
  const result = new Map<string, { quantity: string; latest: string }>();
  for (const certificate of latest.values()) {
    const lines = await tx.subcontractCertificateLine.findMany({
      where: { tenantId, certificateId: certificate.id, revision: certificate.revision },
      select: { bqItemLineageId: true, quantityToDate: true },
    });
    const date = toCalendarDate(certificate.valuationDate);
    for (const line of lines) {
      const entry = result.get(line.bqItemLineageId);
      result.set(line.bqItemLineageId, {
        quantity: sumQuantities([entry?.quantity ?? "0", trimDecimal(line.quantityToDate)]),
        latest: entry && entry.latest > date ? entry.latest : date,
      });
    }
  }
  return result;
}

/** The advances of a subcontract paid on or before a date (Σ, minor units). */
export async function advancesPaidBy(
  tx: Tx,
  tenantId: string,
  subcontractId: string,
  date: string | null,
) {
  const rows = await tx.subcontractAdvance.findMany({
    where: { tenantId, subcontractId, status: "paid" },
    select: { amountMinor: true, paidOn: true },
  });
  return rows
    .filter((row) => date === null || (row.paidOn && toCalendarDate(row.paidOn) <= date))
    .reduce((sum, row) => sum + minorOf(row.amountMinor), 0);
}
