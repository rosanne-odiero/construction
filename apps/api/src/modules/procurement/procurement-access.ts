import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
} from "@nestjs/common";
import { TENANT_LEVEL_PERMISSIONS, type Permission } from "@pm-buddy/types";
import { AccessPolicy, type Scope } from "../identity/access-policy.js";

/** Stable problem codes for the procurement module (the web maps them to EN/SW messages). */
export type ProcurementProblem =
  | "version-conflict"
  | "material-name-taken"
  | "material-archived"
  | "unit-code-taken"
  | "unit-unknown"
  | "unit-archived"
  | "unit-invalid"
  | "unit-limit"
  | "base-unit-fixed"
  | "attribute-not-allowed"
  | "same-unit"
  | "standard-conversion-exists"
  | "conversion-overlap"
  | "conversion-ended"
  | "conversion-end-invalid"
  | "no-conversion"
  | "invalid-quantity"
  | "negative-quantity"
  | "quantity-too-large"
  | "path-too-long"
  | "price-already-corrected"
  | "kra-pin-taken"
  | "contact-not-found"
  | "maker-checker"
  | "payout-stale"
  | "payout-not-pending"
  | "payout-not-found"
  | "nothing-to-reveal"
  | "sensitive-value-unreadable";

export const procurementConflict = (code: ProcurementProblem, message: string) =>
  new ConflictException({ message, code });
export const procurementBadRequest = (code: ProcurementProblem, message: string) =>
  new BadRequestException({ message, code });
export const procurementProblem = (status: number, code: ProcurementProblem, message: string) =>
  new HttpException({ message, code }, status);
export const versionConflict = () =>
  procurementConflict(
    "version-conflict",
    "This record was changed by someone else. Reload and try again.",
  );

/**
 * Reading the catalogue and the supplier list (identifiers masked) is open to anyone who will
 * use them: procurement, stores and finance roles, held company-wide or on at least one project.
 */
export const CATALOGUE_VIEW_PERMISSIONS = [
  "procurement.manage_suppliers",
  "procurement.requisition",
  "procurement.approve",
  "stores.manage",
  "finance.view",
] as const satisfies readonly Permission[];

/**
 * Procurement authorisation (ARCHITECTURE §4.4, §8), all through AccessPolicy:
 * - view: any CATALOGUE_VIEW_PERMISSIONS;
 * - manage the catalogue, conversions, prices and suppliers, and propose payout details:
 *   `procurement.manage_suppliers` (company-level; payout proposals also need step-up);
 * - reveal a KRA PIN or contact phone: `procurement.manage_suppliers` or company-wide
 *   `finance.view_sensitive`; reveal a bank account number: company-wide `finance.view_sensitive`;
 * - verify or reject payout details: company-wide `payments.approve` + step-up, by someone who is
 *   not a contributor (maker-checker);
 * - change company procurement settings: `config.manage`.
 */
@Injectable()
export class ProcurementAccess {
  constructor(private readonly policy: AccessPolicy) {}

  /** Company-level permissions apply company-wide; project ones need a project or company role. */
  async holds(scope: Scope, permission: Permission): Promise<boolean> {
    if ((TENANT_LEVEL_PERMISSIONS as readonly Permission[]).includes(permission))
      return scope.access.permissions.has(permission);
    return this.policy.holdsSomewhere(scope, permission);
  }

  /** A project-scoped permission used company-wide (needs a company-wide role holding it). */
  holdsCompanyWide(scope: Scope, permission: Permission): boolean {
    return scope.access.permissions.has(permission) && scope.access.tenantWide;
  }

  async viewer(scope: Scope): Promise<void> {
    for (const permission of CATALOGUE_VIEW_PERMISSIONS)
      if (await this.holds(scope, permission)) return;
    throw new ForbiddenException(
      `One of these permissions is required: ${CATALOGUE_VIEW_PERMISSIONS.join(", ")}`,
    );
  }

  canManage(scope: Scope): boolean {
    return scope.access.permissions.has("procurement.manage_suppliers");
  }

  async manager(scope: Scope, stepUp = false): Promise<void> {
    await this.policy.require(scope, "procurement.manage_suppliers", { stepUp });
  }

  canRevealIdentifiers(scope: Scope): boolean {
    return this.canManage(scope) || this.holdsCompanyWide(scope, "finance.view_sensitive");
  }

  canRevealBank(scope: Scope): boolean {
    return this.holdsCompanyWide(scope, "finance.view_sensitive");
  }

  canVerifyPayout(scope: Scope): boolean {
    return this.holdsCompanyWide(scope, "payments.approve");
  }

  /** payments.approve company-wide and MFA verified within five minutes. */
  verifier(scope: Scope): void {
    if (!this.canVerifyPayout(scope))
      throw new ForbiddenException("Company-wide permission required: payments.approve");
    this.policy.stepUp(scope);
  }

  async settingsManager(scope: Scope): Promise<void> {
    await this.policy.require(scope, "config.manage");
  }
}
