import {
  BadRequestException,
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
import { portalFor, SUPPLIER_PORTAL_MANAGE_PERMISSIONS } from "@pm-buddy/types";
import {
  hasDatabaseCode,
  isCheckViolation,
  isForeignKeyViolation,
  isUniqueViolation,
} from "../../../common/database-errors.js";
import type { Scope } from "../../identity/access-policy.js";

/** Stable problem codes of the supplier portal (the web maps them to EN/SW messages). */
export type SupplierPortalProblem =
  | "supplier-portal-not-linked"
  | "supplier-portal-rule"
  | "supplier-portal-forbidden"
  | "portal-user-exists"
  | "supplier-blocked"
  | "lpo-already-acknowledged"
  | "lpo-not-approved"
  | "invoice-id-conflict"
  | "invoice-date-invalid"
  | "idempotency-key-required"
  | "idempotency-key-reused"
  | "too-many-documents"
  | "invoice-not-attachable"
  | "statement-period-invalid"
  | "version-conflict"
  | "invalid-transition";

export function supplierPortalProblem(
  status: 400 | 403 | 409 | 422,
  code: SupplierPortalProblem,
  message: string,
): HttpException {
  const body = { message, code };
  if (status === 400) return new BadRequestException(body);
  if (status === 403) return new ForbiddenException(body);
  if (status === 409) return new ConflictException(body);
  return new HttpException(body, HttpStatus.UNPROCESSABLE_ENTITY);
}

export type Binding = {
  portalUserId: string;
  supplierId: string;
  supplier: { id: string; code: string; name: string };
};

/**
 * Who may use the supplier portal (D7.2, ARCHITECTURE §4.12): a member whose role holds
 * `portal.supplier` and no staff permission (`portalFor` = supplier) with an ACTIVE binding to
 * exactly one supplier. Every supplier-side query is then filtered by that supplier (and the
 * database's restrictive RLS policies filter again). Staff manage portal users with
 * `procurement.manage_suppliers` or company-wide `finance.manage`.
 */
@Injectable()
export class SupplierPortalAccess {
  async binding(scope: Scope): Promise<Binding> {
    const { tx, access } = scope;
    if (!access.permissions.has("portal.supplier") || portalFor(access.permissions) !== "supplier")
      throw new ForbiddenException("Permission required: portal.supplier");
    const row = await tx.supplierPortalUser.findFirst({
      where: { tenantId: access.tenantId, userId: access.userId, status: "active" },
      include: {
        supplier: { select: { id: true, code: true, legalName: true, tradingName: true } },
      },
    });
    if (!row)
      throw supplierPortalProblem(
        403,
        "supplier-portal-not-linked",
        "Your access to this company's supplier portal has ended or is not linked to a supplier",
      );
    return {
      portalUserId: row.id,
      supplierId: row.supplierId,
      supplier: {
        id: row.supplier.id,
        code: row.supplier.code,
        name: row.supplier.tradingName ?? row.supplier.legalName,
      },
    };
  }

  /** Whether the caller may invite, list and revoke supplier portal users. */
  canManage(scope: Scope): boolean {
    const { permissions, tenantWide } = scope.access;
    return SUPPLIER_PORTAL_MANAGE_PERMISSIONS.some(
      (permission) =>
        permissions.has(permission) &&
        (permission === "procurement.manage_suppliers" || tenantWide),
    );
  }

  requireManager(scope: Scope): void {
    if (!this.canManage(scope))
      throw new ForbiddenException(
        "One of these permissions is required company-wide: procurement.manage_suppliers, finance.manage",
      );
  }

  /** A supplier of the caller's company (404 otherwise). */
  async supplier(scope: Scope, supplierId: string) {
    const row = await scope.tx.supplier.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id: supplierId } },
    });
    if (!row) throw new NotFoundException("Supplier not found");
    return row;
  }
}

/**
 * Maps a database refusal the API's own checks did not catch first (a trigger's rule, a unique
 * key, a privilege) to a problem instead of a 500. The database message is not echoed.
 */
export function supplierPortalDatabaseProblem(error: unknown): HttpException | null {
  if (error instanceof HttpException) return null;
  if (isUniqueViolation(error))
    return supplierPortalProblem(409, "supplier-portal-rule", "This conflicts with a record.");
  if (isCheckViolation(error) || isForeignKeyViolation(error))
    return supplierPortalProblem(409, "supplier-portal-rule", "The change breaks a portal rule.");
  if (hasDatabaseCode(error, ["42501"]))
    return supplierPortalProblem(
      403,
      "supplier-portal-forbidden",
      "A supplier cannot make this change.",
    );
  return null;
}

/** Applies supplierPortalDatabaseProblem to every supplier portal endpoint. */
@Injectable()
export class SupplierPortalDatabaseErrors implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next
      .handle()
      .pipe(
        catchError((error: unknown) =>
          throwError(() => supplierPortalDatabaseProblem(error) ?? error),
        ),
      );
  }
}
