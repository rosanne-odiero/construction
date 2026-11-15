import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { catchError, throwError, type Observable } from "rxjs";
import { isProjectReadOnly } from "@pm-buddy/domain";
import { portalFor, type Permission, type ProjectStatus } from "@pm-buddy/types";
import {
  hasDatabaseCode,
  isCheckViolation,
  isForeignKeyViolation,
  isUniqueViolation,
} from "../../../common/database-errors.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { Scope } from "../../identity/access-policy.js";
import { effectiveProjectPermissions } from "../../identity/role-grants.js";

/** Stable problem codes of the client portal (the web maps them to EN/SW messages). */
export type ClientPortalProblem =
  | "client-portal-only"
  | "client-portal-rule"
  | "client-portal-forbidden"
  | "project-read-only"
  | "certificate-not-certified"
  | "receipt-exceeds-outstanding"
  | "receipt-date-invalid"
  | "receipt-already-reversed"
  | "receipt-not-reversible"
  | "receipt-method-required"
  | "cash-flow-item-not-linkable"
  | "too-many-client-payments"
  | "payment-id-conflict"
  | "idempotency-key-required"
  | "idempotency-key-reused"
  | "version-conflict"
  | "invalid-transition"
  | "variation-stale"
  | "already-sent"
  | "no-client-assigned"
  | "client-approval-required"
  | "request-closed"
  | "already-decided"
  | "stk-push-unavailable"
  | "nothing-outstanding"
  | "amount-exceeds-outstanding"
  | "fx-rate-invalid"
  | "export-too-large";

export function clientPortalProblem(
  status: 400 | 403 | 409 | 422 | 503,
  code: ClientPortalProblem,
  message: string,
): HttpException {
  const body = { message, code };
  if (status === 400) return new BadRequestException(body);
  if (status === 403) return new ForbiddenException(body);
  if (status === 409) return new ConflictException(body);
  if (status === 503) return new ServiceUnavailableException(body);
  return new HttpException(body, HttpStatus.UNPROCESSABLE_ENTITY);
}

export type ClientProjectRow = Prisma.ProjectGetPayload<object>;

/**
 * Who may use the client portal (D7.1, ARCHITECTURE §4.15): a member whose role holds
 * `portal.client` and no staff permission (`portalFor` = client), on the projects they are assigned
 * to with `portal.client` (role ∩ assignment). Any other project ID — unassigned, another
 * company's or unknown — is a 404, so a client cannot learn which projects exist. Every portal
 * query is then filtered by that project; the database's restrictive RLS policies filter again.
 */
@Injectable()
export class ClientPortalAccess {
  requireClient(scope: Scope): void {
    const { permissions } = scope.access;
    if (!permissions.has("portal.client"))
      throw new ForbiddenException("Permission required: portal.client");
    if (portalFor(permissions) !== "client")
      throw clientPortalProblem(
        403,
        "client-portal-only",
        "The client portal is for the project's client; staff use the office app",
      );
  }

  /** An assigned project of the client (404 for any other ID). */
  async project(scope: Scope, projectId: string): Promise<ClientProjectRow> {
    this.requireClient(scope);
    const { tx, access } = scope;
    const found = await tx.project.findUnique({
      where: { tenantId_id: { tenantId: access.tenantId, id: projectId } },
      include: { members: { where: { userId: access.userId }, select: { permissions: true } } },
    });
    if (!found) throw new NotFoundException("Project not found");
    const { members, ...row } = found;
    const effective = effectiveProjectPermissions(access, members[0]?.permissions ?? null);
    if (!effective.has("portal.client")) throw new NotFoundException("Project not found");
    return row;
  }

  /** The client's assigned projects. */
  projects(scope: Scope): Promise<ClientProjectRow[]> {
    this.requireClient(scope);
    const { tx, access } = scope;
    return tx.project.findMany({
      where: access.tenantWide
        ? { tenantId: access.tenantId }
        : {
            tenantId: access.tenantId,
            members: { some: { userId: access.userId, permissions: { has: "portal.client" } } },
          },
      orderBy: { name: "asc" },
    });
  }
}

/** A project the caller holds one of `permissions` on (role ∩ assignment; 404/403 otherwise). */
export async function staffProject(
  scope: Scope,
  projectId: string,
  permissions: readonly Permission[],
) {
  const { tx, access } = scope;
  const found = await tx.project.findUnique({
    where: { tenantId_id: { tenantId: access.tenantId, id: projectId } },
    include: { members: { where: { userId: access.userId }, select: { permissions: true } } },
  });
  if (!found) throw new NotFoundException("Project not found");
  const { members, ...project } = found;
  const effective = effectiveProjectPermissions(access, members[0]?.permissions ?? null);
  if (!permissions.some((permission) => effective.has(permission)))
    throw new ForbiddenException(
      `One of these permissions is required on the project: ${permissions.join(", ")}`,
    );
  return { project, effective, readOnly: isProjectReadOnly(project.status as ProjectStatus) };
}

/**
 * Office endpoints that expose the company's working records (variations, instructions, rate
 * build-ups) refuse members whose role uses the client portal: a client sees a variation only
 * through the view frozen when it was sent to them (D-134). Restrictive RLS repeats it.
 */
export function refuseClientPortalMember(scope: Scope): void {
  if (portalFor(scope.access.permissions) === "client")
    throw clientPortalProblem(
      403,
      "client-portal-only",
      "Clients see variations sent to them in the client portal",
    );
}

/**
 * Maps a database refusal the API's own checks did not catch first (a trigger's rule, a unique
 * key, a privilege) to a problem instead of a 500. The database message is not echoed.
 */
export function clientPortalDatabaseProblem(error: unknown): HttpException | null {
  if (error instanceof HttpException) return null;
  if (isUniqueViolation(error))
    return clientPortalProblem(409, "client-portal-rule", "This conflicts with a record.");
  if (isCheckViolation(error) || isForeignKeyViolation(error))
    return clientPortalProblem(
      409,
      "client-portal-rule",
      "The change breaks a client portal rule.",
    );
  if (hasDatabaseCode(error, ["42501"]))
    return clientPortalProblem(
      403,
      "client-portal-forbidden",
      "You cannot make this change in the client portal.",
    );
  return null;
}

/** Applies clientPortalDatabaseProblem to every client portal endpoint (client and staff). */
@Injectable()
export class ClientPortalDatabaseErrors implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next
      .handle()
      .pipe(
        catchError((error: unknown) =>
          throwError(() => clientPortalDatabaseProblem(error) ?? error),
        ),
      );
  }
}
