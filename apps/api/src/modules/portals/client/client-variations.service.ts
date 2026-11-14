import { createHash } from "node:crypto";
import { Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import {
  clientRequestOpen,
  clientRequestState,
  clientVariationText,
  projectedTotals,
  type ClientVariationView,
} from "@pm-buddy/domain";
import {
  CLIENT_REQUEST_READ_PERMISSIONS,
  CLIENT_SEND_VARIATION_PERMISSIONS,
  type ClientDecision,
  type VariationLineAction,
  type VariationStatus,
} from "@pm-buddy/types";
import {
  variationClientResponseSchema,
  type SendVariationToClientRequest,
  type VariationClientResponse,
} from "@pm-buddy/validation";
import { uuidv7 } from "../../../common/uuid.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { loadContent } from "../../bq/bq-content.js";
import { safeMinor } from "../../bq/bq-mappers.js";
import { latestApproved, versionsOf } from "../../bq/bq-versions.service.js";
import { clientApprovalOf } from "../../bq/variation-client-approval.js";
import type { Scope } from "../../identity/access-policy.js";
import type { Principal } from "../../identity/auth.service.js";
import { TenantScope } from "../../identity/tenant-scope.service.js";
import { peopleOf, personOf } from "../../procurement/procurement-mappers.js";
import {
  clientPortalProblem,
  refuseClientPortalMember,
  staffProject,
} from "./client-portal-access.js";

type Tx = Prisma.TransactionClient;
type VariationRow = Prisma.VariationOrderGetPayload<object>;

const decimal = (value: Prisma.Decimal | null) => (value === null ? null : value.toFixed());
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Sending a submitted variation to the client (D7.1, WORKFLOWS "Variation decisions by the
 * client", rule D-134). Staff who prepare variations (`bq.edit`) send the CURRENT submission: the
 * client's view is built from the stored lines on the base version — what the variation shows
 * (references, descriptions, units, quantities, contract rates, amounts and totals), never line
 * notes or rate build-ups — and frozen with its SHA-256. One sending per submission; the client
 * decides it once. The D2.3 state machine is unchanged.
 */
@Injectable()
export class ClientVariationsService {
  constructor(private readonly scope: TenantScope) {}

  view(principal: Principal, projectId: string, variationId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const found = await staffProject(scope, projectId, CLIENT_REQUEST_READ_PERMISSIONS);
      refuseClientPortalMember(scope);
      return this.viewOf(scope, found, await this.row(scope.tx, scope, projectId, variationId));
    });
  }

  send(
    principal: Principal,
    projectId: string,
    variationId: string,
    input: SendVariationToClientRequest & { message?: string },
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        const found = await staffProject(scope, projectId, CLIENT_REQUEST_READ_PERMISSIONS);
        refuseClientPortalMember(scope);
        await tx.$queryRaw`SELECT id FROM variation_orders WHERE tenant_id = ${access.tenantId}::uuid
          AND id = ${variationId}::uuid FOR UPDATE`;
        const row = await this.row(tx, scope, projectId, variationId);
        const blocker = await this.sendBlocker(scope, found, row);
        if (blocker === "permission")
          throw clientPortalProblem(403, "client-portal-forbidden", "Permission required: bq.edit");
        if (blocker === "read-only")
          throw clientPortalProblem(409, "project-read-only", "Closed projects are read-only");
        if (blocker === "status")
          throw clientPortalProblem(
            409,
            "invalid-transition",
            "Only a submitted variation is sent to the client",
          );
        if (blocker === "stale" || row.snapshotDigest !== input.snapshotDigest)
          throw clientPortalProblem(
            409,
            "variation-stale",
            "This variation changed since you opened it. Reload and review it again.",
          );
        if (row.version !== input.version)
          throw clientPortalProblem(
            409,
            "version-conflict",
            "This variation was changed by someone else. Reload and try again.",
          );
        if (blocker === "already-sent")
          throw clientPortalProblem(409, "already-sent", "This submission was already sent");
        if (blocker === "no-client")
          throw clientPortalProblem(
            409,
            "no-client-assigned",
            "No client is assigned to this project yet; invite the client first",
          );
        const view = await this.clientView(tx, access.tenantId, row);
        const id = uuidv7();
        await tx.variationClientRequest.create({
          data: {
            id,
            tenantId: access.tenantId,
            projectId,
            variationId,
            snapshotDigest: row.snapshotDigest!,
            submittedAt: row.submittedAt!,
            clientView: view as unknown as Prisma.InputJsonValue,
            clientDigest: sha256(clientVariationText(view)),
            message: input.message?.trim() ? input.message.trim() : null,
            sentBy: access.userId,
          },
        });
        await this.scope.audit(tx, "client_portal.variation_sent", id, {
          projectId,
          variationId,
          number: row.number,
          digest: row.snapshotDigest,
        });
        return this.viewOf(scope, found, row);
      },
      true,
    );
  }

  // Helpers -------------------------------------------------------------------------------------

  private async row(tx: Tx, scope: Scope, projectId: string, variationId: string) {
    const row = await tx.variationOrder.findFirst({
      where: { tenantId: scope.access.tenantId, projectId, id: variationId },
    });
    if (!row) throw new NotFoundException("Variation not found");
    return row;
  }

  private async clientMembers(tx: Tx, tenantId: string, projectId: string) {
    return tx.projectMembership.count({
      where: {
        tenantId,
        projectId,
        permissions: { has: "portal.client" },
        membership: { role: { in: ["client", "custom"] } },
      },
    });
  }

  private async sendBlocker(
    scope: Scope,
    found: Awaited<ReturnType<typeof staffProject>>,
    row: VariationRow,
  ): Promise<VariationClientResponse["permissions"]["sendBlocker"]> {
    const { tx, access } = scope;
    if (!CLIENT_SEND_VARIATION_PERMISSIONS.some((permission) => found.effective.has(permission)))
      return "permission";
    if (found.readOnly) return "read-only";
    if (row.status !== "submitted" || !row.snapshotDigest || !row.submittedAt) return "status";
    const versions = await versionsOf(tx, access.tenantId, row.projectId);
    if (!versions || latestApproved(versions.versions)?.id !== row.baseVersionId) return "stale";
    if (
      await tx.variationClientRequest.count({
        where: { tenantId: access.tenantId, variationId: row.id, submittedAt: row.submittedAt },
      })
    )
      return "already-sent";
    if (!(await this.clientMembers(tx, access.tenantId, row.projectId))) return "no-client";
    return null;
  }

  private async viewOf(
    scope: Scope,
    found: Awaited<ReturnType<typeof staffProject>>,
    first: VariationRow,
  ) {
    const { tx, access } = scope;
    const row = await this.row(tx, scope, first.projectId, first.id);
    const [requests, approval, clientMembers, blocker] = await Promise.all([
      tx.variationClientRequest.findMany({
        where: { tenantId: access.tenantId, variationId: row.id },
        include: { decisions: true },
        orderBy: [{ sentAt: "desc" }, { id: "desc" }],
      }),
      clientApprovalOf(tx, access.tenantId, row),
      this.clientMembers(tx, access.tenantId, row.projectId),
      this.sendBlocker(scope, found, row),
    ]);
    const people = await peopleOf(tx, [
      ...requests.map((request) => request.sentBy),
      ...requests.flatMap((request) => request.decisions.map((decision) => decision.decidedBy)),
    ]);
    return variationClientResponseSchema.parse({
      approvalRequired: approval.required,
      clientMembers,
      requests: requests.map((request) => {
        const decision = request.decisions[0] ?? null;
        const open = clientRequestOpen({
          decided: decision !== null,
          variation: {
            status: row.status as VariationStatus,
            snapshotDigest: row.snapshotDigest,
            submittedAt: row.submittedAt?.toISOString() ?? null,
          },
          request: {
            snapshotDigest: request.snapshotDigest,
            submittedAt: request.submittedAt.toISOString(),
          },
        });
        return {
          id: request.id,
          sentAt: request.sentAt.toISOString(),
          sentBy: personOf(people, request.sentBy),
          message: request.message,
          snapshotDigest: request.snapshotDigest,
          clientDigest: request.clientDigest,
          state: clientRequestState(
            (decision?.decision as ClientDecision | undefined) ?? null,
            open,
          ),
          decision: decision
            ? {
                decision: decision.decision as ClientDecision,
                comment: decision.comment,
                decidedBy: personOf(people, decision.decidedBy),
                decidedAt: decision.decidedAt.toISOString(),
              }
            : null,
        };
      }),
      currentDecision: approval.currentDecision,
      permissions: { canSend: blocker === null, sendBlocker: blocker },
    });
  }

  /** What the client is shown: the variation's own figures on its base version, nothing more. */
  private async clientView(
    tx: Tx,
    tenantId: string,
    row: VariationRow,
  ): Promise<ClientVariationView> {
    const [lines, base, instruction, content] = await Promise.all([
      tx.variationLine.findMany({
        where: { tenantId, variationId: row.id },
        orderBy: { lineNo: "asc" },
      }),
      tx.bqVersion.findUniqueOrThrow({
        where: { tenantId_id: { tenantId, id: row.baseVersionId } },
      }),
      tx.instruction.findUniqueOrThrow({
        where: { tenantId_id: { tenantId, id: row.instructionId } },
        select: { number: true, subject: true },
      }),
      loadContent(tx, tenantId, row.baseVersionId),
    ]);
    const items = new Map(content.items.map((item) => [item.lineageId, item]));
    const projected = projectedTotals(
      {
        subtotalMinor: safeMinor(base.subtotalMinor),
        grandTotalMinor: safeMinor(base.grandTotalMinor),
      },
      safeMinor(row.netMinor),
      base.vatRatePercent.toFixed(),
    );
    return {
      number: row.number,
      title: row.title,
      description: row.description,
      instruction,
      lines: lines.map((line) => {
        const item = line.itemLineageId ? items.get(line.itemLineageId) : undefined;
        const action = line.action as VariationLineAction;
        const amountOnly = line.amountMinor !== null;
        return {
          lineNo: line.lineNo,
          action,
          ref: item ? item.ref : line.ref,
          description: item ? item.description : (line.description ?? ""),
          unit: item ? item.unit : line.unit,
          quantity:
            action === "omit"
              ? "0"
              : amountOnly
                ? null
                : (decimal(line.quantity) ?? item?.quantity ?? null),
          rate: action === "omit" || amountOnly ? null : (decimal(line.rate) ?? item?.rate ?? null),
          baseAmountMinor: safeMinor(line.baseAmountMinor),
          newAmountMinor: safeMinor(line.newAmountMinor),
          deltaMinor: safeMinor(line.deltaMinor),
        };
      }),
      totals: {
        additionsMinor: safeMinor(row.additionsMinor),
        omissionsMinor: safeMinor(row.omissionsMinor),
        netMinor: safeMinor(row.netMinor),
      },
      vatRatePercent: base.vatRatePercent.toFixed(),
      baseGrandTotalMinor: safeMinor(base.grandTotalMinor),
      projectedGrandTotalMinor: projected.grandTotalMinor,
      grandTotalEffectMinor: projected.grandTotalEffectMinor,
    };
  }
}
