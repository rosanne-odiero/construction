import { Injectable, NotFoundException } from "@nestjs/common";
import {
  addCalendarDays,
  inductionStatus,
  nairobiDate,
  uninductedAttendance,
} from "@pm-buddy/domain";
import {
  SAFETY_RECORD_PERMISSIONS,
  WORKED_ATTENDANCE_STATUSES,
  type InductionState,
} from "@pm-buddy/types";
import {
  inductionResponseSchema,
  inductionsResponseSchema,
  inductionStatusResponseSchema,
  type CreateInductionRequest,
  type InductionsQuery,
  type InductionStatusQuery,
  type InductionStatusRow,
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
  labourerOf,
  labourerRefs,
  lockProject,
  notFuture,
  requireCompanyUsers,
  requireProjectLabourers,
  requireSite,
  requireStaff,
  SafetyAccess,
  safetyProblem,
  safetySettings,
  searchNumber,
  versionConflict,
  type SafetyContext,
} from "./safety-access.js";
import { inductionInclude, inductionPeople, toInduction } from "./safety-mappers.js";

type Tx = Prisma.TransactionClient;

/**
 * Site inductions (D8.2): who was inducted at which site, when, by whom, on which checklist topics
 * and how they acknowledged it. Fixed once recorded; voided with a reason by safety.manage. The
 * status view reads attendance to flag labourers who worked at a site without a valid induction
 * there; attendance itself is never blocked (decision D-71).
 */
@Injectable()
export class InductionsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly safety: SafetyAccess,
  ) {}

  list(principal: Principal, projectId: string, query: InductionsQuery, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const context = await this.safety.load(scope, projectId);
      const { tenantId } = scope.access;
      const where: Prisma.SafetyInductionWhereInput = {
        tenantId,
        projectId,
        ...(query.siteId ? { siteId: query.siteId } : {}),
        ...(query.personKind ? { personKind: query.personKind } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.cursor ? { number: { lt: query.cursor } } : {}),
      };
      const search = query.search?.trim();
      if (search) {
        const number = searchNumber(search, "IND");
        where.OR = [
          { visitorName: { contains: search, mode: "insensitive" } },
          { labourer: { fullName: { contains: search, mode: "insensitive" } } },
          { labourer: { workerNo: { contains: search, mode: "insensitive" } } },
          ...(number !== null ? [{ number }] : []),
        ];
      }
      const [rows, settings] = await Promise.all([
        scope.tx.safetyInduction.findMany({
          where,
          include: inductionInclude,
          orderBy: { number: "desc" },
          take: query.limit + 1,
        }),
        safetySettings(scope.tx, tenantId),
      ]);
      const page = rows.slice(0, query.limit);
      const [people, labourers] = await Promise.all([
        peopleOf(scope.tx, page.flatMap(inductionPeople)),
        labourerRefs(
          scope.tx,
          tenantId,
          page.map((row) => row.labourerId),
        ),
      ]);
      return inductionsResponseSchema.parse({
        inductions: page.map((row) =>
          toInduction(row, people, labourers, context, settings.inductionValidityDays),
        ),
        nextCursor: rows.length > query.limit ? page.at(-1)!.number : null,
        permissions: { canCreate: context.canRecord },
      });
    });
  }

  create(principal: Principal, projectId: string, input: CreateInductionRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const context = await this.safety.recorder(scope, projectId);
        const { tenantId, userId } = scope.access;
        await requireSite(scope.tx, tenantId, projectId, input.siteId);
        notFuture(input.inductedOn);
        await requireStaff(scope, projectId, input.inductorId, SAFETY_RECORD_PERMISSIONS);
        if (input.labourerId)
          await requireProjectLabourers(scope.tx, tenantId, projectId, [input.labourerId]);
        if (input.userId) await requireCompanyUsers(scope.tx, tenantId, [input.userId]);
        const settings = await safetySettings(scope.tx, tenantId);
        const checklist = new Map(settings.inductionTopics.map((topic) => [topic.key, topic]));
        if (input.topics.some((key) => !checklist.has(key)))
          throw safetyProblem(
            422,
            "induction-topic-unknown",
            "A topic is not on the company's induction checklist",
          );
        // The topics covered are copied, so later checklist changes never alter this record.
        const topics = settings.inductionTopics.filter((topic) => input.topics.includes(topic.key));
        await lockProject(scope.tx, tenantId, projectId);
        const latest = await scope.tx.safetyInduction.findFirst({
          where: { tenantId, projectId },
          orderBy: { number: "desc" },
          select: { number: true },
        });
        const id = uuidv7();
        const number = (latest?.number ?? 0) + 1;
        await scope.tx.safetyInduction.create({
          data: {
            id,
            tenantId,
            projectId,
            siteId: input.siteId,
            number,
            personKind: input.personKind,
            labourerId: input.labourerId ?? null,
            userId: input.userId ?? null,
            visitorName: input.visitorName ?? null,
            visitorOrganisation: input.visitorOrganisation,
            inductedOn: fromCalendarDate(input.inductedOn),
            inductorId: input.inductorId,
            topics,
            topicsTotal: settings.inductionTopics.length,
            acknowledgement: input.acknowledgement,
            notes: input.notes,
            recordedBy: userId,
          },
        });
        // No visitor names or notes in the audit log.
        await this.scope.audit(scope.tx, "safety.induction_recorded", id, {
          projectId,
          siteId: input.siteId,
          number,
          personKind: input.personKind,
          labourerId: input.labourerId ?? null,
          topics: topics.length,
          topicsTotal: settings.inductionTopics.length,
        });
        return this.detail(scope, context, id, settings.inductionValidityDays);
      },
      true,
    );
  }

  void(
    principal: Principal,
    projectId: string,
    inductionId: string,
    input: VoidRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const context = await this.safety.manager(scope, projectId);
        const { tenantId, userId } = scope.access;
        const row = await scope.tx.safetyInduction.findFirst({
          where: { tenantId, projectId, id: inductionId },
        });
        if (!row) throw new NotFoundException("Induction not found");
        if (row.status !== "recorded")
          throw safetyProblem(409, "invalid-transition", "This induction is already voided");
        if (row.version !== input.version) throw versionConflict();
        const changed = await scope.tx.safetyInduction.updateMany({
          where: { tenantId, projectId, id: inductionId, version: input.version },
          data: {
            status: "voided",
            voidedBy: userId,
            voidReason: input.reason,
            version: { increment: 1 },
          },
        });
        if (changed.count !== 1) throw versionConflict();
        await this.scope.audit(scope.tx, "safety.induction_voided", inductionId, {
          projectId,
          number: row.number,
          version: input.version + 1,
        });
        const settings = await safetySettings(scope.tx, tenantId);
        return this.detail(scope, context, inductionId, settings.inductionValidityDays);
      },
      true,
    );
  }

  /**
   * Induction status per labourer at one site: the labourers engaged on the project (or who worked
   * at the site in the look-back window), their newest induction there, and the days in the window
   * they worked there without a valid induction. Flagged first, then not inducted, then by name.
   */
  status(principal: Principal, projectId: string, query: InductionStatusQuery, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      await this.safety.load(scope, projectId);
      const { tenantId } = scope.access;
      await requireSite(scope.tx, tenantId, projectId, query.siteId);
      const settings = await safetySettings(scope.tx, tenantId);
      const today = nairobiDate();
      const from = addCalendarDays(today, -(settings.inductionLookbackDays - 1));
      const rows = await siteCoverage(
        scope.tx,
        tenantId,
        projectId,
        query.siteId,
        from,
        today,
        settings.inductionValidityDays,
      );
      const counts = {
        labourers: rows.length,
        valid: rows.filter((row) => row.state === "valid").length,
        expired: rows.filter((row) => row.state === "expired").length,
        none: rows.filter((row) => row.state === "none").length,
        flagged: rows.filter((row) => row.flagged).length,
      };
      const search = query.search?.trim().toLowerCase();
      const rank: Record<InductionState, number> = { none: 0, expired: 1, valid: 2 };
      const filtered = rows
        .filter((row) =>
          query.filter === "flagged"
            ? row.flagged
            : query.filter === "not_inducted"
              ? row.state !== "valid"
              : true,
        )
        .filter(
          (row) =>
            !search ||
            row.labourer.fullName.toLowerCase().includes(search) ||
            row.labourer.workerNo.toLowerCase().includes(search),
        )
        .sort(
          (a, b) =>
            Number(b.flagged) - Number(a.flagged) ||
            rank[a.state] - rank[b.state] ||
            a.labourer.fullName.localeCompare(b.labourer.fullName) ||
            a.labourer.workerNo.localeCompare(b.labourer.workerNo),
        );
      const offset = query.cursor ?? 0;
      const page = filtered.slice(offset, offset + query.limit);
      return inductionStatusResponseSchema.parse({
        siteId: query.siteId,
        lookbackDays: settings.inductionLookbackDays,
        from,
        rows: page.map((row) => ({
          labourer: row.labourer,
          gang: row.gang,
          state: row.state,
          inductedOn: row.inductedOn,
          validUntil: row.validUntil,
          uninductedDays: row.uninductedDays,
          flagged: row.flagged,
        })),
        nextCursor: filtered.length > offset + query.limit ? offset + query.limit : null,
        counts,
      });
    });
  }

  private async detail(
    scope: Scope,
    context: SafetyContext,
    inductionId: string,
    validityDays: number | null,
  ) {
    const row = await scope.tx.safetyInduction.findFirst({
      where: { tenantId: scope.access.tenantId, projectId: context.project.id, id: inductionId },
      include: inductionInclude,
    });
    if (!row) throw new NotFoundException("Induction not found");
    const [people, labourers] = await Promise.all([
      peopleOf(scope.tx, inductionPeople(row)),
      labourerRefs(scope.tx, scope.access.tenantId, [row.labourerId]),
    ]);
    return inductionResponseSchema.parse({
      induction: toInduction(row, people, labourers, context, validityDays),
    });
  }
}

/**
 * Induction coverage of one site (or every site when `siteId` is null): one row per labourer and
 * site for the labourers engaged on the project during the window or who worked at the site in it.
 */
export async function siteCoverage(
  tx: Tx,
  tenantId: string,
  projectId: string,
  siteId: string | null,
  from: string,
  today: string,
  validityDays: number | null,
): Promise<(InductionStatusRow & { siteId: string })[]> {
  const site = siteId ? { siteId } : {};
  const [engagements, attendance, inductions, sites] = await Promise.all([
    tx.labourEngagement.findMany({
      where: {
        tenantId,
        projectId,
        startDate: { lte: fromCalendarDate(today) },
        OR: [{ endDate: null }, { endDate: { gte: fromCalendarDate(from) } }],
      },
      select: { labourerId: true },
    }),
    tx.attendanceRecord.findMany({
      where: {
        tenantId,
        projectId,
        ...site,
        status: { in: [...WORKED_ATTENDANCE_STATUSES] },
        workDate: { gte: fromCalendarDate(from), lte: fromCalendarDate(today) },
      },
      select: { siteId: true, labourerId: true, workDate: true },
    }),
    tx.safetyInduction.findMany({
      where: { tenantId, projectId, ...site, status: "recorded", labourerId: { not: null } },
      select: { siteId: true, labourerId: true, inductedOn: true },
    }),
    tx.site.findMany({ where: { tenantId, projectId, ...(siteId ? { id: siteId } : {}) } }),
  ]);
  const key = (site: string, labourer: string) => `${site}|${labourer}`;
  const attended = new Map<string, string[]>();
  for (const record of attendance) {
    const entry = key(record.siteId, record.labourerId);
    attended.set(entry, [...(attended.get(entry) ?? []), toCalendarDate(record.workDate)]);
  }
  const inducted = new Map<string, { inductedOn: string }[]>();
  for (const induction of inductions) {
    const entry = key(induction.siteId, induction.labourerId!);
    inducted.set(entry, [
      ...(inducted.get(entry) ?? []),
      { inductedOn: toCalendarDate(induction.inductedOn) },
    ]);
  }
  // Every engaged labourer is listed for each site asked about; others only where they worked.
  const pairs = new Set<string>();
  for (const { id } of sites)
    for (const { labourerId } of engagements) pairs.add(key(id, labourerId));
  for (const entry of attended.keys()) pairs.add(entry);
  const labourerIds = [...new Set([...pairs].map((pair) => pair.split("|")[1]!))];
  const [refs, gangs] = await Promise.all([
    labourerRefs(tx, tenantId, labourerIds),
    tx.gangMembership.findMany({
      where: { tenantId, projectId, labourerId: { in: labourerIds }, leftOn: null },
      select: { labourerId: true, gang: { select: { id: true, name: true } } },
    }),
  ]);
  const gangOf = new Map(gangs.map((membership) => [membership.labourerId, membership.gang]));
  return [...pairs].map((pair) => {
    const [pairSite, labourerId] = pair.split("|") as [string, string];
    const given = inducted.get(pair) ?? [];
    const status = inductionStatus(given, validityDays, today);
    const days = uninductedAttendance(attended.get(pair) ?? [], given, validityDays).reverse();
    return {
      siteId: pairSite,
      labourer: labourerOf(refs, labourerId),
      gang: gangOf.get(labourerId) ?? null,
      state: status.state,
      inductedOn: status.inductedOn,
      validUntil: status.validUntil,
      uninductedDays: days,
      flagged: days.length > 0,
    };
  });
}
