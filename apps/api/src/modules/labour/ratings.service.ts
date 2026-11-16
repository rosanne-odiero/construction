import { Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import {
  canChangeRating,
  isInRatingWindow,
  isProjectReadOnly,
  nairobiDate,
  ratingAverage,
  ratingTotals,
  ratingWindow,
  summarizeRatings,
  type RatingScores,
} from "@pm-buddy/domain";
import {
  RATING_HISTORY_LIMITS,
  WORKED_ATTENDANCE_STATUSES,
  type ProjectStatus,
} from "@pm-buddy/types";
import {
  labourerRatingsResponseSchema,
  ratingProjectsResponseSchema,
  ratingResponseSchema,
  ratingSheetResponseSchema,
  workerRatingsResponseSchema,
  type LabourerRating,
} from "@pm-buddy/validation";
import type { z } from "zod";
import type {
  createRatingRequestSchema,
  labourerRatingsQuerySchema,
  ratingSheetQuerySchema,
  updateRatingRequestSchema,
} from "@pm-buddy/validation";
import type { Prisma } from "../../generated/prisma/client.js";
import { AccessPolicy, type Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { fromCalendarDate, toCalendarDate } from "../projects/project-mappers.js";
import { displayNames } from "./labour-mappers.js";
import {
  inProjects,
  LabourAccess,
  labourBadRequest,
  labourConflict,
  LabourCrypto,
  rethrowLabourDbError,
  versionConflict,
} from "./labour-support.js";

type CreateRating = z.output<typeof createRatingRequestSchema>;
type UpdateRating = z.output<typeof updateRatingRequestSchema>;
type SheetQuery = z.output<typeof ratingSheetQuerySchema>;
type HistoryQuery = z.output<typeof labourerRatingsQuerySchema>;
type Tx = Prisma.TransactionClient;
type RatingRow = Prisma.LabourerRatingGetPayload<{
  include: { project: { select: { id: true; code: true; name: true } } };
}>;

const projectRef = { select: { id: true, code: true, name: true } } as const;
const worked = [...WORKED_ATTENDANCE_STATUSES];
const KENYAN_PHONE = /^254[17]\d{8}$/;

const scoresOf = (row: RatingScores): RatingScores => ({
  punctuality: row.punctuality,
  quality: row.quality,
  safety: row.safety,
  teamwork: row.teamwork,
});

/** Integer totals for summarizeRatings (SUM/COUNT in the database, never averages of averages). */
async function totals(tx: Tx, where: Prisma.LabourerRatingWhereInput) {
  const result = await tx.labourerRating.aggregate({
    where,
    _count: { _all: true },
    _sum: { punctuality: true, quality: true, safety: true, teamwork: true },
  });
  return summarizeRatings({
    count: result._count._all,
    sums: {
      punctuality: result._sum.punctuality ?? 0,
      quality: result._sum.quality ?? 0,
      safety: result._sum.safety ?? 0,
      teamwork: result._sum.teamwork ?? 0,
    },
  });
}

/**
 * Narrows `where` to the ratings that count: those whose day attendance still records as worked on
 * the project (D-180). A muster re-saved as absent, or an approved correction, sets a rating aside
 * without deleting it; it counts again if the day is restored.
 */
async function counted(
  tx: Tx,
  tenantId: string,
  where: Prisma.LabourerRatingWhereInput,
): Promise<Prisma.LabourerRatingWhereInput> {
  const ratings = await tx.labourerRating.findMany({
    where,
    select: { id: true, projectId: true, labourerId: true, workDate: true },
  });
  const key = (row: { projectId: string; labourerId: string; workDate: Date }) =>
    `${row.projectId}/${row.labourerId}/${toCalendarDate(row.workDate)}`;
  const unique = (values: string[]) => [...new Set(values)];
  const records = ratings.length
    ? await tx.attendanceRecord.findMany({
        where: {
          tenantId,
          projectId: { in: unique(ratings.map((row) => row.projectId)) },
          labourerId: { in: unique(ratings.map((row) => row.labourerId)) },
          workDate: {
            in: unique(ratings.map((row) => toCalendarDate(row.workDate))).map((date) =>
              fromCalendarDate(date),
            ),
          },
          status: { in: worked },
        },
        select: { projectId: true, labourerId: true, workDate: true },
      })
    : [];
  const workedDays = new Set(records.map(key));
  const ids = ratings.filter((row) => workedDays.has(key(row))).map((row) => row.id);
  return { AND: [where, { id: { in: ids } }] };
}

/**
 * Worker ratings (D3.5, WORKFLOWS "Worker ratings"): holders of labour.rate on a project score the
 * workers that attendance records as working there on a day (today or the six days before), once
 * per worker and day; only the rater may correct a rating, on the day they gave it. A rating counts
 * only while attendance still records its day as worked. Office roles see ratings on projects where
 * they hold labour.view; workers see their own, without rater names.
 */
@Injectable()
export class LabourRatingsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: LabourAccess,
    private readonly policy: AccessPolicy,
    private readonly crypto: LabourCrypto,
  ) {}

  /** Open projects where the caller may rate, with the days that can be rated today. */
  projects(principal: Principal, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      await this.access.requireSomewhere(scope, "labour.rate");
      const rows = await scope.tx.project.findMany({
        where: this.policy.projectWhere(scope, "labour.rate"),
        select: { id: true, code: true, name: true, status: true },
        orderBy: [{ name: "asc" }, { code: "asc" }],
      });
      const today = nairobiDate();
      const open = rows.filter((row) => !isProjectReadOnly(row.status as ProjectStatus));
      // One row per project and worker recorded as working today, counted per project.
      const pairs = open.length
        ? await scope.tx.attendanceRecord.groupBy({
            by: ["projectId", "labourerId"],
            where: {
              tenantId: scope.access.tenantId,
              projectId: { in: open.map((row) => row.id) },
              workDate: fromCalendarDate(today),
              status: { in: worked },
            },
          })
        : [];
      const working = new Map<string, number>();
      for (const pair of pairs) working.set(pair.projectId, (working.get(pair.projectId) ?? 0) + 1);
      return ratingProjectsResponseSchema.parse({
        today,
        window: ratingWindow(today),
        projects: open.map(({ id, code, name }) => ({
          id,
          code,
          name,
          readOnly: false,
          workingToday: working.get(id) ?? 0,
        })),
      });
    });
  }

  /** One project day: everyone that attendance records as working there, with their rating. */
  sheet(principal: Principal, projectId: string, query: SheetQuery, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const project = await this.project(scope, projectId);
      const today = nairobiDate();
      const date = query.date ?? today;
      if (date > today) throw labourBadRequest("date-in-future", "That day has not happened yet.");
      const records = await tx.attendanceRecord.findMany({
        where: {
          tenantId: access.tenantId,
          projectId,
          workDate: fromCalendarDate(date),
          status: { in: worked },
        },
        select: { labourerId: true, status: true, site: { select: { name: true } } },
      });
      const days = new Map<string, { attendance: "present" | "half_day"; sites: string[] }>();
      for (const record of records) {
        const day = days.get(record.labourerId) ?? { attendance: "half_day", sites: [] };
        // Someone present on one site and half a day on another counts as present.
        if (record.status === "present") day.attendance = "present";
        day.sites = [...new Set([...day.sites, record.site.name])].sort();
        days.set(record.labourerId, day);
      }
      const ids = [...days.keys()];
      const labourers = ids.length
        ? await tx.labourer.findMany({
            where: { tenantId: access.tenantId, id: { in: ids } },
            select: {
              id: true,
              workerNo: true,
              fullName: true,
              trade: { select: { id: true, nameEn: true, nameSw: true } },
            },
            orderBy: [{ fullName: "asc" }, { workerNo: "asc" }],
          })
        : [];
      const ratings = ids.length
        ? await tx.labourerRating.findMany({
            where: {
              tenantId: access.tenantId,
              projectId,
              workDate: fromCalendarDate(date),
              labourerId: { in: ids },
            },
            include: { project: projectRef },
          })
        : [];
      const mapped = await this.toRatings(tx, ratings, access.userId);
      const byLabourer = new Map(mapped.map((rating) => [rating.labourerId, rating]));
      const readOnly = isProjectReadOnly(project.status as ProjectStatus);
      return ratingSheetResponseSchema.parse({
        project: { id: project.id, code: project.code, name: project.name, readOnly },
        date,
        today,
        window: ratingWindow(today),
        canRate: !readOnly && isInRatingWindow(date, today),
        workers: labourers.map((labourer) => ({
          labourer,
          ...days.get(labourer.id)!,
          rating: byLabourer.get(labourer.id) ?? null,
        })),
      });
    });
  }

  create(principal: Principal, projectId: string, input: CreateRating, req: Request) {
    return this.mutate(principal, req, async (scope) => {
      const { tx, access } = scope;
      const project = await this.project(scope, projectId);
      this.assertWritable(project);
      const today = nairobiDate();
      if (input.workDate > today)
        throw labourBadRequest("date-in-future", "That day has not happened yet.");
      if (!isInRatingWindow(input.workDate, today))
        throw labourConflict("rating-window", "Only today and the six days before can be rated.");
      const labourer = await tx.labourer.findUnique({
        where: { tenantId_id: { tenantId: access.tenantId, id: input.labourerId } },
        select: { id: true, phoneBidx: true },
      });
      if (!labourer) throw new NotFoundException("Labourer not found");
      if (this.isSelf(principal, access.tenantId, labourer.phoneBidx))
        throw labourConflict("self-rating", "Nobody rates their own work.");
      const workDate = fromCalendarDate(input.workDate);
      await this.assertWorked(tx, access.tenantId, projectId, labourer.id, workDate);
      const existing = await tx.labourerRating.findUnique({
        where: {
          tenantId_projectId_labourerId_workDate: {
            tenantId: access.tenantId,
            projectId,
            labourerId: labourer.id,
            workDate,
          },
        },
        select: { id: true },
      });
      if (existing)
        throw labourConflict("already-rated", "This worker is already rated for that day.");
      const row = await tx.labourerRating.create({
        data: {
          tenantId: access.tenantId,
          projectId,
          labourerId: labourer.id,
          workDate,
          ...input.scores,
          comment: input.comment,
          ratedBy: access.userId,
        },
        include: { project: projectRef },
      });
      await this.scope.audit(tx, "labourer.rated", labourer.id, {
        ratingId: row.id,
        projectId,
        workDate: input.workDate,
        ...input.scores,
        comment: input.comment !== null,
      });
      return ratingResponseSchema.parse({ rating: await this.toRating(tx, row, access.userId) });
    });
  }

  /** The rater's same-day correction of the scores and comment. */
  update(principal: Principal, ratingId: string, input: UpdateRating, req: Request) {
    return this.mutate(principal, req, async (scope) => {
      const { tx, access } = scope;
      const current = await tx.labourerRating.findUnique({
        where: { tenantId_id: { tenantId: access.tenantId, id: ratingId } },
      });
      if (!current) throw new NotFoundException("Rating not found");
      const project = await this.project(scope, current.projectId);
      this.assertWritable(project);
      if (!canChangeRating(current, access.userId))
        throw labourConflict(
          "rating-locked",
          "Only the person who gave a rating can change it, on the day they gave it.",
        );
      await this.assertWorked(
        tx,
        access.tenantId,
        current.projectId,
        current.labourerId,
        current.workDate,
      );
      const updated = await tx.labourerRating.updateMany({
        where: { tenantId: access.tenantId, id: ratingId, version: input.version },
        data: { ...input.scores, comment: input.comment, version: { increment: 1 } },
      });
      if (!updated.count) throw versionConflict();
      const row = await tx.labourerRating.findUniqueOrThrow({
        where: { tenantId_id: { tenantId: access.tenantId, id: ratingId } },
        include: { project: projectRef },
      });
      await this.scope.audit(tx, "labourer.rating_changed", row.labourerId, {
        ratingId,
        projectId: row.projectId,
        workDate: toCalendarDate(row.workDate),
        ...input.scores,
        comment: input.comment !== null,
        version: row.version,
      });
      return ratingResponseSchema.parse({ rating: await this.toRating(tx, row, access.userId) });
    });
  }

  /** A worker's ratings on projects where the caller holds labour.view (newest first). */
  history(principal: Principal, labourerId: string, query: HistoryQuery, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { tx, access } = scope;
      const { projectIds } = await this.access.labourer(scope, labourerId);
      const visible = await this.access.projectsWith(scope, "labour.view");
      const raters = await this.access.projectsWith(scope, "labour.rate");
      const canRate = projectIds.some((projectId) => inProjects(raters, projectId));
      const where: Prisma.LabourerRatingWhereInput = {
        tenantId: access.tenantId,
        labourerId,
        ...(visible === "all" ? {} : { projectId: { in: [...visible] } }),
        ...(query.from || query.to
          ? {
              workDate: {
                ...(query.from ? { gte: fromCalendarDate(query.from) } : {}),
                ...(query.to ? { lte: fromCalendarDate(query.to) } : {}),
              },
            }
          : {}),
      };
      const filter = await counted(
        tx,
        access.tenantId,
        query.projectId ? { AND: [where, { projectId: query.projectId }] } : where,
      );
      const summary = await totals(tx, filter);
      const rows = await tx.labourerRating.findMany({
        where: filter,
        include: { project: projectRef },
        orderBy: [{ workDate: "desc" }, { ratedAt: "desc" }],
        take: query.limit,
      });
      return labourerRatingsResponseSchema.parse({
        labourerId,
        summary,
        ratings: await this.toRatings(tx, rows, access.userId),
        canRate,
      });
    });
  }

  /**
   * The signed-in worker's own ratings on their portal projects. The account is linked to a
   * registry record only through an unambiguous match of its verified phone number (as the D7.2
   * self-service); nothing is shown otherwise. Rater identities are never shown to workers.
   */
  async forWorker(tx: Tx, tenantId: string, identifier: string, projectIds: readonly string[]) {
    const empty = summarizeRatings(ratingTotals([]));
    if (!KENYAN_PHONE.test(identifier))
      return workerRatingsResponseSchema.parse({ linked: false, summary: empty, ratings: [] });
    const matches = await tx.labourer.findMany({
      where: { tenantId, phoneBidx: this.crypto.index(tenantId, "phone", identifier) },
      select: { id: true },
      take: 2,
    });
    if (matches.length !== 1)
      return workerRatingsResponseSchema.parse({ linked: false, summary: empty, ratings: [] });
    const where = await counted(tx, tenantId, {
      tenantId,
      labourerId: matches[0]!.id,
      projectId: { in: [...projectIds] },
    });
    const summary = await totals(tx, where);
    const rows = await tx.labourerRating.findMany({
      where,
      include: { project: projectRef },
      orderBy: [{ workDate: "desc" }, { ratedAt: "desc" }],
      take: RATING_HISTORY_LIMITS.default,
    });
    return workerRatingsResponseSchema.parse({
      linked: true,
      summary,
      ratings: rows.map((row) => {
        const scores = scoresOf(row);
        return {
          id: row.id,
          project: row.project,
          workDate: toCalendarDate(row.workDate),
          scores,
          average: ratingAverage(scores),
          comment: row.comment,
        };
      }),
    });
  }

  /** The project with labour.rate on it (404 outside the company, 403 without the permission). */
  private async project(scope: Scope, projectId: string) {
    await this.access.requireOnProject(scope, "labour.rate", projectId);
    const project = await scope.tx.project.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id: projectId } },
      select: { id: true, code: true, name: true, status: true },
    });
    if (!project) throw new NotFoundException("Project not found");
    return project;
  }

  /** Attendance records the worker as working on the project that day (present or half day). */
  private async assertWorked(
    tx: Tx,
    tenantId: string,
    projectId: string,
    labourerId: string,
    workDate: Date,
  ) {
    const attended = await tx.attendanceRecord.findFirst({
      where: { tenantId, projectId, labourerId, workDate, status: { in: worked } },
      select: { id: true },
    });
    if (!attended)
      throw labourConflict(
        "not-worked",
        "Attendance does not record this worker as working on the project that day.",
      );
  }

  private assertWritable(project: { status: string }) {
    if (isProjectReadOnly(project.status as ProjectStatus))
      throw labourConflict("project-read-only", "Closed and cancelled projects are read-only.");
  }

  /** A rater who signs in with the worker's registered phone number is rating themselves. */
  private isSelf(principal: Principal, tenantId: string, phoneBidx: string | null) {
    const identifier = principal.user.identifier;
    return (
      phoneBidx !== null &&
      KENYAN_PHONE.test(identifier) &&
      this.crypto.index(tenantId, "phone", identifier) === phoneBidx
    );
  }

  private async toRatings(tx: Tx, rows: readonly RatingRow[], userId: string) {
    const names = await displayNames(
      tx,
      rows.map((row) => row.ratedBy),
    );
    return rows.map((row) => this.map(row, names, userId));
  }

  private async toRating(tx: Tx, row: RatingRow, userId: string) {
    return (await this.toRatings(tx, [row], userId))[0]!;
  }

  private map(row: RatingRow, names: Map<string, string>, userId: string): LabourerRating {
    const scores = scoresOf(row);
    return {
      id: row.id,
      project: row.project,
      labourerId: row.labourerId,
      workDate: toCalendarDate(row.workDate),
      scores,
      average: ratingAverage(scores),
      comment: row.comment,
      ratedBy: { id: row.ratedBy, displayName: names.get(row.ratedBy) ?? "—" },
      ratedAt: row.ratedAt.toISOString(),
      changedAt: row.changedAt?.toISOString() ?? null,
      version: row.version,
      canChange: canChangeRating(row, userId),
    };
  }

  private mutate<T>(
    principal: Principal,
    req: Request,
    operation: (scope: Scope) => Promise<T>,
  ): Promise<T> {
    return this.scope
      .run(principal, req, operation, true)
      .catch((error: unknown) => rethrowLabourDbError(error, "already-rated"));
  }
}
