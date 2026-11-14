import { Injectable, NotFoundException } from "@nestjs/common";
import { addCalendarDays, nairobiDate, ppeReplacementDueOn } from "@pm-buddy/domain";
import { SAFETY_WARNING_DAYS } from "@pm-buddy/types";
import {
  ppeIssueResponseSchema,
  ppeIssuesResponseSchema,
  type IssuePpeRequest,
  type PpeQuery,
  type ReturnPpeRequest,
  type VoidRequest,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { uuidv7 } from "../../common/uuid.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { peopleOf } from "../procurement/procurement-mappers.js";
import { fromCalendarDate, toCalendarDate } from "../projects/project-mappers.js";
import {
  labourerRefs,
  notFuture,
  requireProjectLabourers,
  requireSite,
  SafetyAccess,
  safetyProblem,
  safetySettings,
  versionConflict,
  type SafetyContext,
} from "./safety-access.js";
import { ppeInclude, ppePeople, toPpeIssue } from "./safety-mappers.js";

/**
 * The PPE register (D8.2): items issued to labourers with size, quantity and date, the company's
 * replacement date fixed at issue, returns with the condition, replacements (a new issue naming the
 * one it replaces) and voids. A register only: it posts no stock movement (decision D-72).
 */
@Injectable()
export class PpeService {
  constructor(
    private readonly scope: TenantScope,
    private readonly safety: SafetyAccess,
  ) {}

  list(principal: Principal, projectId: string, query: PpeQuery, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const context = await this.safety.load(scope, projectId);
      const { tenantId } = scope.access;
      const today = nairobiDate();
      const soon = fromCalendarDate(addCalendarDays(today, SAFETY_WARNING_DAYS.ppe));
      const scoped = { tenantId, projectId };
      const where: Prisma.PpeIssueWhereInput = {
        ...scoped,
        ...(query.siteId ? { siteId: query.siteId } : {}),
        ...(query.labourerId ? { labourerId: query.labourerId } : {}),
        ...(query.item ? { item: query.item } : {}),
        ...(query.status === "due"
          ? { status: "issued", replacementDueOn: { lte: soon } }
          : query.status
            ? { status: query.status }
            : {}),
      };
      const search = query.search?.trim();
      if (search)
        where.labourer = {
          OR: [
            { fullName: { contains: search, mode: "insensitive" } },
            { workerNo: { contains: search, mode: "insensitive" } },
          ],
        };
      const offset = query.cursor ?? 0;
      const [rows, issued, due, dueSoon] = await Promise.all([
        // Items still with labourers first ("issued" sorts first), soonest replacement first.
        scope.tx.ppeIssue.findMany({
          where,
          include: ppeInclude,
          orderBy: [{ status: "asc" }, { replacementDueOn: "asc" }, { id: "asc" }],
          skip: offset,
          take: query.limit + 1,
        }),
        scope.tx.ppeIssue.count({ where: { ...scoped, status: "issued" } }),
        scope.tx.ppeIssue.count({
          where: {
            ...scoped,
            status: "issued",
            replacementDueOn: { lte: fromCalendarDate(today) },
          },
        }),
        scope.tx.ppeIssue.count({
          where: {
            ...scoped,
            status: "issued",
            replacementDueOn: { gt: fromCalendarDate(today), lte: soon },
          },
        }),
      ]);
      const page = rows.slice(0, query.limit);
      const [people, labourers] = await Promise.all([
        peopleOf(scope.tx, page.flatMap(ppePeople)),
        labourerRefs(
          scope.tx,
          tenantId,
          page.map((row) => row.labourerId),
        ),
      ]);
      return ppeIssuesResponseSchema.parse({
        issues: page.map((row) => toPpeIssue(row, people, labourers, context)),
        nextCursor: rows.length > query.limit ? offset + query.limit : null,
        counts: { issued, due, dueSoon },
        permissions: { canIssue: context.canRecord },
      });
    });
  }

  issue(principal: Principal, projectId: string, input: IssuePpeRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const context = await this.safety.recorder(scope, projectId);
        const { tenantId, userId } = scope.access;
        await requireSite(scope.tx, tenantId, projectId, input.siteId);
        notFuture(input.issuedOn);
        await requireProjectLabourers(scope.tx, tenantId, projectId, [input.labourerId]);
        const replaced = input.replacesIssueId
          ? await scope.tx.ppeIssue.findFirst({
              where: { tenantId, projectId, id: input.replacesIssueId },
            })
          : null;
        if (input.replacesIssueId) {
          if (!replaced) throw new NotFoundException("PPE issue not found");
          if (
            replaced.status !== "issued" ||
            replaced.labourerId !== input.labourerId ||
            replaced.item !== input.item ||
            toCalendarDate(replaced.issuedOn) > input.issuedOn
          )
            throw safetyProblem(
              409,
              "ppe-replacement-invalid",
              "A replacement follows the same item still issued to the same labourer",
            );
        }
        const settings = await safetySettings(scope.tx, tenantId);
        const days = settings.ppeReplacementDays[input.item];
        const id = uuidv7();
        await scope.tx.ppeIssue.create({
          data: {
            id,
            tenantId,
            projectId,
            siteId: input.siteId,
            labourerId: input.labourerId,
            item: input.item,
            size: input.size,
            quantity: input.quantity,
            issuedOn: fromCalendarDate(input.issuedOn),
            replacementDays: days,
            replacementDueOn: fromCalendarDate(ppeReplacementDueOn(input.issuedOn, days)),
            replacesIssueId: input.replacesIssueId ?? null,
            issuedBy: userId,
            updatedBy: userId,
          },
        });
        if (replaced) {
          const changed = await scope.tx.ppeIssue.updateMany({
            where: { tenantId, projectId, id: replaced.id, version: replaced.version },
            data: { status: "replaced", updatedBy: userId, version: { increment: 1 } },
          });
          if (changed.count !== 1) throw versionConflict();
        }
        await this.scope.audit(scope.tx, "safety.ppe_issued", id, {
          projectId,
          siteId: input.siteId,
          labourerId: input.labourerId,
          item: input.item,
          quantity: input.quantity,
          replacementDays: days,
          replacesIssueId: input.replacesIssueId ?? null,
        });
        return this.detail(scope, context, id);
      },
      true,
    );
  }

  returnIssue(
    principal: Principal,
    projectId: string,
    issueId: string,
    input: ReturnPpeRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const context = await this.safety.recorder(scope, projectId);
        const { tenantId, userId } = scope.access;
        const row = await this.load(scope, projectId, issueId, input.version);
        notFuture(input.returnedOn);
        if (input.returnedOn < toCalendarDate(row.issuedOn))
          throw safetyProblem(
            409,
            "ppe-return-before-issue",
            "An item cannot be returned before it was issued",
          );
        const changed = await scope.tx.ppeIssue.updateMany({
          where: { tenantId, projectId, id: issueId, version: input.version },
          data: {
            status: "returned",
            returnedOn: fromCalendarDate(input.returnedOn),
            returnCondition: input.condition,
            returnedBy: userId,
            updatedBy: userId,
            version: { increment: 1 },
          },
        });
        if (changed.count !== 1) throw versionConflict();
        await this.scope.audit(scope.tx, "safety.ppe_returned", issueId, {
          projectId,
          item: row.item,
          condition: input.condition,
          version: input.version + 1,
        });
        return this.detail(scope, context, issueId);
      },
      true,
    );
  }

  void(principal: Principal, projectId: string, issueId: string, input: VoidRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const context = await this.safety.manager(scope, projectId);
        const { tenantId, userId } = scope.access;
        const row = await this.load(scope, projectId, issueId, input.version);
        const changed = await scope.tx.ppeIssue.updateMany({
          where: { tenantId, projectId, id: issueId, version: input.version },
          data: {
            status: "voided",
            voidedBy: userId,
            voidReason: input.reason,
            updatedBy: userId,
            version: { increment: 1 },
          },
        });
        if (changed.count !== 1) throw versionConflict();
        // A replacement recorded by mistake: the item it replaced is in use again.
        const restored = row.replacesIssueId
          ? await scope.tx.ppeIssue.updateMany({
              where: { tenantId, projectId, id: row.replacesIssueId, status: "replaced" },
              data: { status: "issued", updatedBy: userId, version: { increment: 1 } },
            })
          : { count: 0 };
        await this.scope.audit(scope.tx, "safety.ppe_voided", issueId, {
          projectId,
          item: row.item,
          restoredIssueId: restored.count ? row.replacesIssueId : null,
          version: input.version + 1,
        });
        return this.detail(scope, context, issueId);
      },
      true,
    );
  }

  /** An issued item at the version the caller read. */
  private async load(scope: Scope, projectId: string, issueId: string, version: number) {
    const row = await scope.tx.ppeIssue.findFirst({
      where: { tenantId: scope.access.tenantId, projectId, id: issueId },
    });
    if (!row) throw new NotFoundException("PPE issue not found");
    if (row.status !== "issued")
      throw safetyProblem(409, "invalid-transition", "This item is no longer issued");
    if (row.version !== version) throw versionConflict();
    return row;
  }

  private async detail(scope: Scope, context: SafetyContext, issueId: string) {
    const row = await scope.tx.ppeIssue.findFirst({
      where: { tenantId: scope.access.tenantId, projectId: context.project.id, id: issueId },
      include: ppeInclude,
    });
    if (!row) throw new NotFoundException("PPE issue not found");
    const [people, labourers] = await Promise.all([
      peopleOf(scope.tx, ppePeople(row)),
      labourerRefs(scope.tx, scope.access.tenantId, [row.labourerId]),
    ]);
    return ppeIssueResponseSchema.parse({ issue: toPpeIssue(row, people, labourers, context) });
  }
}
