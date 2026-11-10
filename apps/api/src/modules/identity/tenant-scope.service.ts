import { ForbiddenException, Injectable } from "@nestjs/common";
import type { Request } from "express";
import type { Prisma } from "../../generated/prisma/client.js";
import { AccessPolicy, type Scope } from "./access-policy.js";
import { AuthService, type Principal, requestId } from "./auth.service.js";
import { requiresMfa } from "./role-grants.js";
import { TenantDatabase } from "./tenant-database.service.js";

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

  /** `mutation` serialises changes per company by locking the tenant row first. */
  async run<T>(
    principal: Principal,
    req: Request,
    operation: (scope: Scope) => Promise<T>,
    mutation = false,
  ): Promise<T> {
    this.auth.requireMfa(principal);
    const tenantId = principal.session.activeTenantId;
    if (!tenantId) throw new ForbiddenException("Select a tenant first");
    return this.db.run(this.context(principal, req), async (tx) => {
      if (mutation) {
        await tx.$queryRaw`SELECT tenant_id FROM tenants WHERE tenant_id = ${tenantId}::uuid FOR UPDATE`;
      }
      await tx.$queryRaw`SELECT user_id FROM memberships WHERE tenant_id = ${tenantId}::uuid
        AND user_id = ${principal.user.id}::uuid FOR SHARE`;
      const access = await this.policy.load(tx, tenantId, principal.user.id);
      if (!access) throw new ForbiddenException("Tenant membership required");
      if (requiresMfa(access) && (!principal.user.mfaEnabled || !principal.session.mfaVerifiedAt)) {
        throw new ForbiddenException("This role requires MFA");
      }
      return operation({ tx, principal, access });
    });
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
