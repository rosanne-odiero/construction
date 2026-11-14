import { Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import { SUPPLIER_PORTAL_LIMITS } from "@pm-buddy/types";
import {
  supplierPortalUserResponseSchema,
  supplierPortalUsersResponseSchema,
  type RevokePortalUserRequest,
  type SupplierPortalUser,
} from "@pm-buddy/validation";
import type { Prisma } from "../../../generated/prisma/client.js";
import { AccessPolicy, type Scope } from "../../identity/access-policy.js";
import { AuthSecurity } from "../../identity/auth-security.service.js";
import type { Principal } from "../../identity/auth.service.js";
import { TenancyService } from "../../identity/tenancy.service.js";
import { TenantScope } from "../../identity/tenant-scope.service.js";
import { peopleOf, personOf, type People } from "../../procurement/procurement-mappers.js";
import { SupplierPortalAccess, supplierPortalProblem } from "./supplier-portal-access.js";

type PortalUserRow = Prisma.SupplierPortalUserGetPayload<{
  include: { invitation: { select: { expiresAt: true; acceptedAt: true } } };
}>;

const iso = (value: Date | null) => (value ? value.toISOString() : null);

/**
 * Company staff and a supplier's portal users (D7.2): invite a contact by email or Kenyan phone
 * (the `supplier` role, no project, bound to this supplier once they accept), list them, and
 * revoke access (a pending invitation stops working; an active user loses the membership and
 * their sessions in this company at once). Needs `procurement.manage_suppliers` or company-wide
 * `finance.manage`; inviting also needs a step-up. Audit events carry IDs and statuses only.
 */
@Injectable()
export class SupplierPortalUsersService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: SupplierPortalAccess,
    private readonly tenancy: TenancyService,
    private readonly security: AuthSecurity,
    private readonly policy: AccessPolicy,
  ) {}

  list(principal: Principal, supplierId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      this.access.requireManager(scope);
      const supplier = await this.access.supplier(scope, supplierId);
      const rows = await scope.tx.supplierPortalUser.findMany({
        where: { tenantId: scope.access.tenantId, supplierId },
        include: { invitation: { select: { expiresAt: true, acceptedAt: true } } },
        orderBy: [{ invitedAt: "desc" }, { id: "desc" }],
      });
      const [people, counts] = await Promise.all([
        peopleOf(
          scope.tx,
          rows.flatMap((row) => [row.invitedBy, row.revokedBy, row.userId]),
        ),
        this.submissionCounts(scope, supplierId),
      ]);
      return supplierPortalUsersResponseSchema.parse({
        supplier: {
          id: supplier.id,
          code: supplier.code,
          name: supplier.tradingName ?? supplier.legalName,
        },
        users: rows.map((row) => this.wire(row, people, counts.get(row.id) ?? 0)),
        permissions: { canInvite: supplier.status !== "blocked", canRevoke: true },
      });
    });
  }

  async invite(
    principal: Principal,
    supplierId: string,
    input: { identifier: string; contactName: string },
    req: Request,
  ) {
    await this.security.limit(
      `supplier-portal-invite:${principal.user.id}`,
      SUPPLIER_PORTAL_LIMITS.invitationsPerHour,
      3_600,
    );
    const result = await this.scope.run(
      principal,
      req,
      (scope) => this.inviteInScope(scope, supplierId, input),
      true,
    );
    await this.tenancy.sendSupplierInvitation(input.identifier, result.token);
    return supplierPortalUserResponseSchema.parse({ user: result.user });
  }

  /**
   * The invitation and the binding in the caller's company transaction; returns the token to
   * send (the development seed accepts it directly instead of sending it).
   */
  async inviteInScope(
    scope: Scope,
    supplierId: string,
    input: { identifier: string; contactName: string },
  ) {
    const { tx, access } = scope;
    this.access.requireManager(scope);
    this.policy.stepUp(scope);
    const supplier = await this.access.supplier(scope, supplierId);
    if (supplier.status === "blocked")
      throw supplierPortalProblem(
        409,
        "supplier-blocked",
        "A blocked supplier's contacts cannot be invited",
      );
    const open = await tx.supplierPortalUser.findMany({
      where: {
        tenantId: access.tenantId,
        identifier: input.identifier,
        status: { in: ["invited", "active"] },
      },
      include: { invitation: { select: { expiresAt: true, acceptedAt: true } } },
    });
    const now = new Date();
    // A new invitation replaces one nobody accepted that has expired, or one still pending for
    // this same supplier (a resend, e.g. after a failed send). Access, or a pending invitation
    // for another supplier, still blocks it.
    const replaceable = (row: (typeof open)[number]) =>
      row.status === "invited" &&
      row.invitation.acceptedAt === null &&
      (row.invitation.expiresAt <= now || row.supplierId === supplierId);
    if (open.some((row) => !replaceable(row)))
      throw supplierPortalProblem(
        409,
        "portal-user-exists",
        "This email address or phone number already has supplier portal access or an invitation in this company",
      );
    for (const row of open) {
      const superseded = await tx.supplierPortalUser.updateMany({
        where: { tenantId: access.tenantId, id: row.id, version: row.version, status: "invited" },
        data: {
          status: "revoked",
          revokeCause: "superseded",
          revokedBy: access.userId,
          version: { increment: 1 },
        },
      });
      if (!superseded.count)
        throw supplierPortalProblem(
          409,
          "version-conflict",
          "This record was changed by someone else. Reload and try again.",
        );
      await tx.invitation.updateMany({
        where: { tenantId: access.tenantId, id: row.invitationId, acceptedAt: null },
        data: { expiresAt: now },
      });
      await this.scope.audit(tx, "supplier_portal.invitation_superseded", row.id, {
        supplierId: row.supplierId,
        invitationId: row.invitationId,
      });
    }
    const invitation = await this.tenancy.createSupplierInvitation(scope, input.identifier);
    const created = await tx.supplierPortalUser.create({
      data: {
        tenantId: access.tenantId,
        supplierId,
        invitationId: invitation.id,
        identifier: input.identifier,
        contactName: input.contactName,
        invitedBy: access.userId,
      },
      include: { invitation: { select: { expiresAt: true, acceptedAt: true } } },
    });
    await this.scope.audit(tx, "supplier_portal.user_invited", created.id, {
      supplierId,
      invitationId: invitation.id,
    });
    const people = await peopleOf(tx, [created.invitedBy]);
    return { token: invitation.token, user: this.wire(created, people, 0) };
  }

  revoke(
    principal: Principal,
    supplierId: string,
    portalUserId: string,
    input: RevokePortalUserRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        this.access.requireManager(scope);
        await this.access.supplier(scope, supplierId);
        const row = await tx.supplierPortalUser.findUnique({
          where: { tenantId_id: { tenantId: access.tenantId, id: portalUserId } },
        });
        if (!row || row.supplierId !== supplierId)
          throw new NotFoundException("Portal user not found");
        if (row.status === "revoked")
          throw supplierPortalProblem(409, "invalid-transition", "This access is already revoked");
        if (row.version !== input.version)
          throw supplierPortalProblem(
            409,
            "version-conflict",
            "This record was changed by someone else. Reload and try again.",
          );
        const updated = await tx.supplierPortalUser.updateMany({
          where: { tenantId: access.tenantId, id: row.id, version: row.version },
          data: {
            status: "revoked",
            revokeCause: "revoked",
            revokedBy: access.userId,
            revokeReason: input.reason,
            version: { increment: 1 },
          },
        });
        if (!updated.count)
          throw supplierPortalProblem(
            409,
            "version-conflict",
            "This record was changed by someone else. Reload and try again.",
          );
        if (row.status === "invited") {
          // The invitation link stops working at once.
          await tx.invitation.updateMany({
            where: { tenantId: access.tenantId, id: row.invitationId, acceptedAt: null },
            data: { expiresAt: new Date() },
          });
        } else if (row.userId) {
          // Offboarding: the supplier-role membership and its sessions in this company end now.
          const removed = await tx.membership.deleteMany({
            where: { tenantId: access.tenantId, userId: row.userId, role: "supplier" },
          });
          await tx.session.updateMany({
            where: { userId: row.userId, activeTenantId: access.tenantId, revokedAt: null },
            data: { revokedAt: new Date() },
          });
          if (removed.count)
            await this.scope.audit(tx, "membership.removed", row.userId, { role: "supplier" });
        }
        await this.scope.audit(tx, "supplier_portal.user_revoked", row.id, {
          supplierId,
          from: row.status,
          reasonGiven: true,
        });
        const fresh = await tx.supplierPortalUser.findUniqueOrThrow({
          where: { tenantId_id: { tenantId: access.tenantId, id: row.id } },
          include: { invitation: { select: { expiresAt: true, acceptedAt: true } } },
        });
        const people = await peopleOf(tx, [fresh.invitedBy, fresh.revokedBy, fresh.userId]);
        const counts = await this.submissionCounts(scope, supplierId);
        return supplierPortalUserResponseSchema.parse({
          user: this.wire(fresh, people, counts.get(fresh.id) ?? 0),
        });
      },
      true,
    );
  }

  private async submissionCounts(scope: Scope, supplierId: string) {
    const rows = await scope.tx.supplierInvoiceSubmission.groupBy({
      by: ["portalUserId"],
      where: { tenantId: scope.access.tenantId, supplierId },
      _count: true,
    });
    return new Map(rows.map((row) => [row.portalUserId, row._count]));
  }

  private wire(row: PortalUserRow, people: People, submitted: number): SupplierPortalUser {
    return {
      id: row.id,
      supplierId: row.supplierId,
      contactName: row.contactName,
      identifier: row.identifier,
      status: row.status as SupplierPortalUser["status"],
      version: row.version,
      invitedAt: row.invitedAt.toISOString(),
      invitedBy: personOf(people, row.invitedBy),
      invitationExpiresAt:
        row.status === "invited" && !row.invitation.acceptedAt
          ? row.invitation.expiresAt.toISOString()
          : null,
      activatedAt: iso(row.activatedAt),
      account: row.userId ? personOf(people, row.userId) : null,
      revokedAt: iso(row.revokedAt),
      revokedBy: row.revokedBy ? personOf(people, row.revokedBy) : null,
      revokeCause: row.revokeCause as SupplierPortalUser["revokeCause"],
      revokeReason: row.revokeReason,
      submittedInvoices: submitted,
    };
  }
}
