import { ForbiddenException, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { pinAllowed } from "@pm-buddy/types";
import type { Prisma } from "../../generated/prisma/client.js";
import { AccessPolicy, type Scope } from "./access-policy.js";
import { AuthService, type Principal, requestId } from "./auth.service.js";
import { requiresMfa } from "./role-grants.js";
import { TenantDatabase } from "./tenant-database.service.js";

/** A PIN sign-in may only use the labourer portal (packages/types pinAllowed). */
export const pinSessionLimited = () =>
  new ForbiddenException({
    code: "pin-session-limited",
    message: "PIN sign-in is for the labourer portal only. Sign in with your password.",
  });

/**
 * Runs work for the caller's selected company in one tenant transaction (RLS context set by
 * TenantDatabase) with their resolved access, and writes hash-chained audit events.
 */
@Injectable()
export class TenantScope {
  constructor(
    private readonly db: TenantDatabase,
    private readonly auth: AuthService,
    private readonly policy: AccessPolicy,
  ) {}

  context(principal: Principal, req: Request, tenantId = principal.session.activeTenantId) {
    return { userId: principal.user.id, tenantId, requestId: requestId(req) };
  }

  /**
   * `mutation` serialises changes per company by locking the tenant row first; `timeoutMs`
   * extends the transaction limit (default 10 s) for long writes.
   */
  async run<T>(
    principal: Principal,
    req: Request,
    operation: (scope: Scope) => Promise<T>,
    mutation = false,
    timeoutMs?: number,
  ): Promise<T> {
    this.auth.requireMfa(principal);
    const tenantId = principal.session.activeTenantId;
    if (!tenantId) throw new ForbiddenException("Select a tenant first");
    return this.db.run(
      this.context(principal, req),
      async (tx) => {
        if (mutation) {
          await tx.$queryRaw`SELECT tenant_id FROM tenants WHERE tenant_id = ${tenantId}::uuid FOR UPDATE`;
        }
        await tx.$queryRaw`SELECT user_id FROM memberships WHERE tenant_id = ${tenantId}::uuid
        AND user_id = ${principal.user.id}::uuid FOR SHARE`;
        const access = await this.policy.load(tx, tenantId, principal.user.id);
        if (!access) throw new ForbiddenException("Tenant membership required");
        if (
          requiresMfa(access) &&
          (!principal.user.mfaEnabled || !principal.session.mfaVerifiedAt)
        ) {
          throw new ForbiddenException("This role requires MFA");
        }
        // A six-digit PIN is a weak credential: it never unlocks staff or client access.
        if (principal.session.authMethod === "pin" && !pinAllowed(access.permissions))
          throw pinSessionLimited();
        return operation({ tx, principal, access });
      },
      timeoutMs,
    );
  }

  /** Appends an audit event. Metadata must hold safe summaries only, never secrets. */
  async audit(
    tx: Prisma.TransactionClient,
    action: string,
    resourceId: string,
    metadata: Prisma.InputJsonValue = {},
  ) {
    const context = this.db.current();
    if (!context.tenantId) throw new Error("Audit requires a tenant");
    await tx.auditEvent.create({
      data: {
        tenantId: context.tenantId,
        actorId: context.userId,
        requestId: context.requestId,
        action,
        resourceId,
        metadata,
      },
    });
  }
}
