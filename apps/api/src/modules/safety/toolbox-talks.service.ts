import { Injectable, NotFoundException } from "@nestjs/common";
import { checkProcurementTransition, TOOLBOX_TALK_TRANSITIONS } from "@pm-buddy/domain";
import { SAFETY_RECORD_PERMISSIONS, type ToolboxTalkStatus } from "@pm-buddy/types";
import {
  toolboxTalkResponseSchema,
  toolboxTalksResponseSchema,
  type CreateToolboxTalkRequest,
  type ToolboxTalkActionRequest,
  type ToolboxTalksQuery,
  type UpdateToolboxTalkRequest,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { uuidv7 } from "../../common/uuid.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { peopleOf } from "../procurement/procurement-mappers.js";
import { fromCalendarDate } from "../projects/project-mappers.js";
import {
  labourerRefs,
  lockProject,
  notFuture,
  requireProjectLabourers,
  requireSite,
  requireSitePhotos,
  requireStaff,
  SafetyAccess,
  safetyProblem,
  searchNumber,
  versionConflict,
  type SafetyContext,
} from "./safety-access.js";
import { talkInclude, talkPeople, toTalk, toTalkSummary } from "./safety-mappers.js";

type TalkContent = Omit<UpdateToolboxTalkRequest, "version">;

/**
 * Toolbox talks (D8.2): a topic presented at a site on a day, with the labourers who attended
 * (whole gangs as they stood that day, or picked one by one) and an optional site photo. A draft
 * can be edited; confirming it (at least one attendee) LOCKS it, as does cancelling it with a
 * reason (database guard).
 */
@Injectable()
export class ToolboxTalksService {
  constructor(
    private readonly scope: TenantScope,
    private readonly safety: SafetyAccess,
  ) {}

  list(principal: Principal, projectId: string, query: ToolboxTalksQuery, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const context = await this.safety.load(scope, projectId);
      const where: Prisma.ToolboxTalkWhereInput = {
        tenantId: scope.access.tenantId,
        projectId,
        ...(query.siteId ? { siteId: query.siteId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.cursor ? { number: { lt: query.cursor } } : {}),
      };
      const search = query.search?.trim();
      if (search) {
        const number = searchNumber(search, "TBT");
        where.OR = [
          { topic: { contains: search, mode: "insensitive" } },
          ...(number !== null ? [{ number }] : []),
        ];
      }
      const rows = await scope.tx.toolboxTalk.findMany({
        where,
        include: talkInclude,
        orderBy: { number: "desc" },
        take: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      const people = await peopleOf(scope.tx, page.flatMap(talkPeople));
      return toolboxTalksResponseSchema.parse({
        talks: page.map((row) => toTalkSummary(row, people, context)),
        nextCursor: rows.length > query.limit ? page.at(-1)!.number : null,
        permissions: { canCreate: context.canRecord },
      });
    });
  }

  get(principal: Principal, projectId: string, talkId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const context = await this.safety.load(scope, projectId);
      return this.detail(scope, context, talkId);
    });
  }

  create(principal: Principal, projectId: string, input: CreateToolboxTalkRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const context = await this.safety.recorder(scope, projectId);
        const { tenantId, userId } = scope.access;
        await requireSite(scope.tx, tenantId, projectId, input.siteId);
        const attendees = await this.checkContent(scope, projectId, input.siteId, input);
        await lockProject(scope.tx, tenantId, projectId);
        const latest = await scope.tx.toolboxTalk.findFirst({
          where: { tenantId, projectId },
          orderBy: { number: "desc" },
          select: { number: true },
        });
        const id = uuidv7();
        const number = (latest?.number ?? 0) + 1;
        await scope.tx.toolboxTalk.create({
          data: {
            id,
            tenantId,
            projectId,
            siteId: input.siteId,
            number,
            ...this.content(input),
            createdBy: userId,
            updatedBy: userId,
          },
        });
        await this.writeAttendees(scope, projectId, id, attendees);
        await this.scope.audit(scope.tx, "safety.talk_recorded", id, {
          projectId,
          siteId: input.siteId,
          number,
          attendees: attendees.size,
          otherAttendees: input.otherAttendees,
          gangs: input.gangIds.length,
          photo: Boolean(input.photoId),
        });
        if (input.confirm) await this.confirm(scope, projectId, id, 1, number);
        return this.detail(scope, context, id);
      },
      true,
    );
  }

  update(
    principal: Principal,
    projectId: string,
    talkId: string,
    input: UpdateToolboxTalkRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const context = await this.safety.recorder(scope, projectId);
        const { tenantId, userId } = scope.access;
        const row = await this.load(scope, projectId, talkId, input.version);
        if (row.status !== "draft")
          throw safetyProblem(
            409,
            "invalid-transition",
            "Confirmed and cancelled talks are locked",
          );
        const attendees = await this.checkContent(scope, projectId, row.siteId, input);
        const changed = await scope.tx.toolboxTalk.updateMany({
          where: { tenantId, projectId, id: talkId, version: input.version },
          data: { ...this.content(input), updatedBy: userId, version: { increment: 1 } },
        });
        if (changed.count !== 1) throw versionConflict();
        await scope.tx.toolboxTalkAttendee.deleteMany({ where: { tenantId, talkId } });
        await this.writeAttendees(scope, projectId, talkId, attendees);
        await this.scope.audit(scope.tx, "safety.talk_updated", talkId, {
          projectId,
          number: row.number,
          attendees: attendees.size,
          otherAttendees: input.otherAttendees,
          version: input.version + 1,
        });
        return this.detail(scope, context, talkId);
      },
      true,
    );
  }

  action(
    principal: Principal,
    projectId: string,
    talkId: string,
    input: ToolboxTalkActionRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const context = await this.safety.recorder(scope, projectId);
        const { tenantId, userId } = scope.access;
        const row = await this.load(scope, projectId, talkId, input.version);
        const check = checkProcurementTransition(
          TOOLBOX_TALK_TRANSITIONS,
          row.status as ToolboxTalkStatus,
          input.action,
          input.reason,
        );
        if (!check.ok)
          throw safetyProblem(409, "invalid-transition", "This action is not available now");
        if (input.action === "confirm") {
          await this.confirm(scope, projectId, talkId, input.version, row.number);
        } else {
          const changed = await scope.tx.toolboxTalk.updateMany({
            where: { tenantId, projectId, id: talkId, version: input.version },
            data: {
              status: "cancelled",
              cancelledBy: userId,
              cancelReason: input.reason!,
              updatedBy: userId,
              version: { increment: 1 },
            },
          });
          if (changed.count !== 1) throw versionConflict();
          await this.scope.audit(scope.tx, "safety.talk_cancelled", talkId, {
            projectId,
            number: row.number,
            version: input.version + 1,
          });
        }
        return this.detail(scope, context, talkId);
      },
      true,
    );
  }

  /** Confirms (and locks) a draft: at least one registered or other attendee. */
  private async confirm(
    scope: Scope,
    projectId: string,
    talkId: string,
    version: number,
    number: number,
  ) {
    const { tenantId, userId } = scope.access;
    const [registered, talk] = await Promise.all([
      scope.tx.toolboxTalkAttendee.count({ where: { tenantId, talkId } }),
      scope.tx.toolboxTalk.findFirst({
        where: { tenantId, id: talkId },
        select: { otherAttendees: true },
      }),
    ]);
    if (registered + (talk?.otherAttendees ?? 0) < 1)
      throw safetyProblem(409, "talk-no-attendees", "A toolbox talk needs at least one attendee");
    const changed = await scope.tx.toolboxTalk.updateMany({
      where: { tenantId, projectId, id: talkId, version },
      data: {
        status: "confirmed",
        confirmedBy: userId,
        updatedBy: userId,
        version: { increment: 1 },
      },
    });
    if (changed.count !== 1) throw versionConflict();
    await this.scope.audit(scope.tx, "safety.talk_confirmed", talkId, {
      projectId,
      number,
      attendees: registered,
      version: version + 1,
    });
  }

  private content(input: TalkContent) {
    return {
      heldOn: fromCalendarDate(input.heldOn),
      topic: input.topic,
      notes: input.notes,
      durationMinutes: input.durationMinutes,
      presenterId: input.presenterId,
      photoId: input.photoId,
      otherAttendees: input.otherAttendees,
    };
  }

  /**
   * Checks the date, presenter and photo, and resolves the attendees: every member of each chosen
   * gang on the day of the talk plus the labourers picked (labourer → the gang that brought them).
   */
  private async checkContent(
    scope: Scope,
    projectId: string,
    siteId: string,
    input: TalkContent,
  ): Promise<Map<string, string | null>> {
    const { tenantId } = scope.access;
    notFuture(input.heldOn);
    await requireStaff(scope, projectId, input.presenterId, SAFETY_RECORD_PERMISSIONS);
    if (input.photoId)
      await requireSitePhotos(scope.tx, tenantId, projectId, siteId, [input.photoId], "general");
    const attendees = new Map<string, string | null>();
    if (input.gangIds.length) {
      const gangs = await scope.tx.gang.count({
        where: { tenantId, projectId, id: { in: input.gangIds } },
      });
      if (gangs !== input.gangIds.length)
        throw safetyProblem(422, "gang-not-in-project", "A gang is not on this project");
      const heldOn = fromCalendarDate(input.heldOn);
      const members = await scope.tx.gangMembership.findMany({
        where: {
          tenantId,
          projectId,
          gangId: { in: input.gangIds },
          joinedOn: { lte: heldOn },
          OR: [{ leftOn: null }, { leftOn: { gte: heldOn } }],
        },
        select: { gangId: true, labourerId: true },
        orderBy: { joinedOn: "asc" },
      });
      for (const member of members)
        if (!attendees.has(member.labourerId)) attendees.set(member.labourerId, member.gangId);
    }
    await requireProjectLabourers(scope.tx, tenantId, projectId, input.labourerIds);
    for (const labourerId of input.labourerIds)
      if (!attendees.has(labourerId)) attendees.set(labourerId, null);
    if (attendees.size > 200)
      throw safetyProblem(409, "invalid-transition", "A talk holds at most 200 attendees");
    return attendees;
  }

  private async writeAttendees(
    scope: Scope,
    projectId: string,
    talkId: string,
    attendees: Map<string, string | null>,
  ) {
    if (!attendees.size) return;
    const { tenantId, userId } = scope.access;
    await scope.tx.toolboxTalkAttendee.createMany({
      data: [...attendees].map(([labourerId, viaGangId]) => ({
        tenantId,
        projectId,
        talkId,
        labourerId,
        viaGangId,
        addedBy: userId,
      })),
    });
  }

  private async load(scope: Scope, projectId: string, talkId: string, version: number) {
    const row = await scope.tx.toolboxTalk.findFirst({
      where: { tenantId: scope.access.tenantId, projectId, id: talkId },
    });
    if (!row) throw new NotFoundException("Toolbox talk not found");
    if (row.version !== version) throw versionConflict();
    return row;
  }

  private async detail(scope: Scope, context: SafetyContext, talkId: string) {
    const { tenantId } = scope.access;
    const row = await scope.tx.toolboxTalk.findFirst({
      where: { tenantId, projectId: context.project.id, id: talkId },
      include: talkInclude,
    });
    if (!row) throw new NotFoundException("Toolbox talk not found");
    const attendees = await scope.tx.toolboxTalkAttendee.findMany({
      where: { tenantId, talkId },
      select: { labourerId: true, viaGang: { select: { id: true, name: true } } },
    });
    const [people, labourers] = await Promise.all([
      peopleOf(scope.tx, talkPeople(row)),
      labourerRefs(
        scope.tx,
        tenantId,
        attendees.map((attendee) => attendee.labourerId),
      ),
    ]);
    const sorted = [...attendees].sort((a, b) =>
      (labourers.get(a.labourerId)?.fullName ?? "").localeCompare(
        labourers.get(b.labourerId)?.fullName ?? "",
      ),
    );
    return toolboxTalkResponseSchema.parse({
      talk: toTalk(row, sorted, people, labourers, context),
    });
  }
}
