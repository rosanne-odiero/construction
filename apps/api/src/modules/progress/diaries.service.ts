import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { diaryTransition, nairobiDate, summariseWorkforce } from "@pm-buddy/domain";
import type { AttendanceStatus, WorkforceMusterState } from "@pm-buddy/types";
import {
  diariesResponseSchema,
  diaryAttendanceResponseSchema,
  diaryResponseSchema,
  diarySchema,
  workforceTradeSchema,
  type CreateDiaryRequest,
  type DiaryActionRequest,
  type DiaryListQuery,
  type UpdateDiaryRequest,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { isUniqueViolation } from "../../common/database-errors.js";
import { Prisma } from "../../generated/prisma/client.js";
import { AccessPolicy, type Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { ProjectAccess, versionConflict } from "../projects/project-access.js";
import { fromCalendarDate, toCalendarDate } from "../projects/project-mappers.js";

type DiaryRow = Prisma.SiteDiaryGetPayload<object>;
/** Site diaries (drafts included) are staff records; clients see approved ones in their portal. */
const DIARY_READERS = ["site.diary", "quality.manage", "projects.manage", "reports.view"] as const;
const problem = (code: string, message: string) => new ConflictException({ code, message });
const toDiary = (row: DiaryRow) =>
  diarySchema.parse({
    id: row.id,
    projectId: row.projectId,
    siteId: row.siteId,
    date: toCalendarDate(row.date),
    workPerformed: row.workPerformed,
    weather: row.weather,
    delays: row.delays,
    workforceCount: row.workforceCount,
    workforceSource: row.workforceSource,
    workforce:
      row.workforceSource === "attendance"
        ? {
            snapshotAt: row.workforceSnapshotAt!.toISOString(),
            musterStatus: row.workforceMusterStatus,
            trades: workforceTradeSchema.array().parse(row.workforceByTrade),
          }
        : null,
    status: row.status,
    version: row.version,
    createdBy: row.createdBy,
    submittedBy: row.submittedBy,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    reviewReason: row.reviewReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });

@Injectable()
export class DiariesService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: ProjectAccess,
    private readonly policy: AccessPolicy,
  ) {}

  list(principal: Principal, projectId: string, query: DiaryListQuery, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      await this.access.load(scope, projectId, "projects.view");
      await this.policy.requireAny(scope, DIARY_READERS, { projectId });
      const rows = await scope.tx.siteDiary.findMany({
        where: {
          tenantId: scope.access.tenantId,
          projectId,
          ...(query.siteId ? { siteId: query.siteId } : {}),
          ...(query.cursor ? { id: { lt: query.cursor } } : {}),
        },
        orderBy: { id: "desc" },
        take: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      return diariesResponseSchema.parse({
        diaries: page.map(toDiary),
        nextCursor: rows.length > query.limit ? page.at(-1)?.id : null,
      });
    });
  }

  create(principal: Principal, projectId: string, input: CreateDiaryRequest, req: Request) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          await this.editable(scope, projectId, "site.diary");
          if (input.date > nairobiDate())
            throw problem("diary-future-date", "A diary cannot be future dated in Africa/Nairobi");
          const site = await scope.tx.site.findFirst({
            where: { tenantId: scope.access.tenantId, projectId, id: input.siteId },
            select: { id: true },
          });
          if (!site) throw new NotFoundException("Site not found in this project");
          const { workforceSource, workforceCount, ...content } = input;
          const diary = await scope.tx.siteDiary.create({
            data: {
              ...content,
              ...(await this.workforceColumns(
                scope,
                input.siteId,
                input.date,
                workforceSource,
                workforceCount,
              )),
              date: fromCalendarDate(input.date),
              tenantId: scope.access.tenantId,
              projectId,
              createdBy: scope.access.userId,
            },
          });
          await this.scope.audit(scope.tx, "diary.created", diary.id, {
            projectId,
            siteId: diary.siteId,
            date: input.date,
            version: diary.version,
            workforceSource,
          });
          return diaryResponseSchema.parse({ diary: toDiary(diary) });
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error))
          throw problem("diary-date-taken", "This site already has a diary for that day");
        throw error;
      });
  }

  update(
    principal: Principal,
    projectId: string,
    diaryId: string,
    input: UpdateDiaryRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        await this.editable(scope, projectId, "site.diary");
        const diary = await this.load(scope, projectId, diaryId, input.version);
        this.author(scope, diary);
        if (diary.status !== "draft")
          throw problem("diary-not-draft", "Only a draft diary can be edited");
        const { version, workforceSource, workforceCount, ...content } = input;
        const changed = await scope.tx.siteDiary.updateMany({
          where: { id: diaryId, tenantId: scope.access.tenantId, projectId, version },
          data: {
            ...content,
            ...(await this.workforceColumns(
              scope,
              diary.siteId,
              toCalendarDate(diary.date),
              workforceSource,
              workforceCount,
            )),
            version: { increment: 1 },
          },
        });
        if (changed.count !== 1) throw versionConflict();
        await this.scope.audit(scope.tx, "diary.updated", diary.id, {
          projectId,
          version: version + 1,
          workforceSource,
        });
        return this.response(scope, projectId, diaryId);
      },
      true,
    );
  }

  action(
    principal: Principal,
    projectId: string,
    diaryId: string,
    input: DiaryActionRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const review = input.action === "approve" || input.action === "reject";
        await this.editable(scope, projectId, review ? "quality.manage" : "site.diary");
        const row = await this.load(scope, projectId, diaryId, input.version);
        const diary = toDiary(row);
        const status = diaryTransition(diary.status, input.action);
        if (!status)
          throw problem("diary-invalid-transition", "This diary action is not available");
        if (review) {
          if (row.createdBy === scope.access.userId || row.submittedBy === scope.access.userId)
            throw new ForbiddenException({
              code: "diary-independent-review",
              message: "An independent reviewer is required",
            });
        } else {
          this.author(scope, row);
        }
        const metadata = review
          ? {
              reviewedBy: scope.access.userId,
              reviewedAt: new Date(),
              reviewReason: input.reason ?? null,
            }
          : input.action === "submit"
            ? { submittedBy: scope.access.userId, submittedAt: new Date() }
            : {
                submittedBy: null,
                submittedAt: null,
                reviewedBy: null,
                reviewedAt: null,
                reviewReason: null,
              };
        // Submitting an attendance-sourced diary takes a fresh snapshot first (a draft edit), so the
        // submitted record shows attendance as it stood at submission.
        let expected = input.version;
        const refresh = input.action === "submit" && row.workforceSource === "attendance";
        if (refresh) {
          const refreshed = await scope.tx.siteDiary.updateMany({
            where: { tenantId: scope.access.tenantId, projectId, id: diaryId, version: expected },
            data: {
              ...(await this.workforceColumns(
                scope,
                row.siteId,
                toCalendarDate(row.date),
                "attendance",
                null,
              )),
              version: { increment: 1 },
            },
          });
          if (refreshed.count !== 1) throw versionConflict();
          expected += 1;
        }
        const changed = await scope.tx.siteDiary.updateMany({
          where: {
            tenantId: scope.access.tenantId,
            projectId,
            id: diaryId,
            version: expected,
          },
          data: { status, ...metadata, version: { increment: 1 } },
        });
        if (changed.count !== 1) throw versionConflict();
        await this.scope.audit(
          scope.tx,
          input.action === "reopen" ? "diary.reopened" : `diary.${status}`,
          diaryId,
          {
            projectId,
            from: diary.status,
            to: status,
            version: expected + 1,
            ...(refresh ? { workforceRefreshed: true } : {}),
          },
        );
        return this.response(scope, projectId, diaryId);
      },
      true,
    );
  }

  /** Live attendance on a site and date by trade: what an attendance snapshot would store. */
  attendance(
    principal: Principal,
    projectId: string,
    query: { siteId: string; date: string },
    req: Request,
  ) {
    return this.scope.run(principal, req, async (scope) => {
      await this.access.load(scope, projectId, "projects.view");
      await this.policy.requireAny(scope, DIARY_READERS, { projectId });
      const site = await scope.tx.site.findFirst({
        where: { tenantId: scope.access.tenantId, projectId, id: query.siteId },
        select: { id: true },
      });
      if (!site) throw new NotFoundException("Site not found in this project");
      const summary = await this.workforce(scope, query.siteId, query.date);
      return diaryAttendanceResponseSchema.parse({
        siteId: query.siteId,
        date: query.date,
        musterStatus: summary.musterStatus,
        total: summary.total,
        trades: summary.trades,
        countedAt: new Date().toISOString(),
      });
    });
  }

  /**
   * Attendance on the site and date by trade (packages/domain summariseWorkforce); the database
   * recomputes the same summary when a diary stores it (app.diary_attendance_workforce).
   */
  private async workforce(scope: Scope, siteId: string, date: string) {
    const { tenantId } = scope.access;
    const workDate = fromCalendarDate(date);
    const [records, day] = await Promise.all([
      scope.tx.attendanceRecord.findMany({
        where: { tenantId, siteId, workDate, status: { in: ["present", "half_day"] } },
        select: {
          status: true,
          labourer: {
            select: {
              trade: {
                select: { id: true, key: true, nameEn: true, nameSw: true, sortOrder: true },
              },
            },
          },
        },
      }),
      scope.tx.attendanceDay.findFirst({
        where: { tenantId, siteId, workDate },
        select: { status: true },
      }),
    ]);
    const summary = summariseWorkforce(
      records.map(({ status, labourer: { trade } }) => ({
        tradeId: trade.id,
        tradeKey: trade.key,
        nameEn: trade.nameEn,
        nameSw: trade.nameSw,
        sortOrder: trade.sortOrder,
        status: status as AttendanceStatus,
      })),
    );
    return { ...summary, musterStatus: (day?.status ?? "none") as WorkforceMusterState };
  }

  /** The diary's workforce columns: a manual count, or an attendance snapshot taken now. */
  private async workforceColumns(
    scope: Scope,
    siteId: string,
    date: string,
    source: "manual" | "attendance",
    count: number | null,
  ) {
    if (source === "manual")
      return {
        workforceSource: "manual",
        workforceCount: count,
        workforceSnapshotAt: null,
        workforceMusterStatus: null,
        workforceByTrade: Prisma.DbNull,
      };
    const summary = await this.workforce(scope, siteId, date);
    return {
      workforceSource: "attendance",
      workforceCount: summary.total,
      workforceSnapshotAt: new Date(),
      workforceMusterStatus: summary.musterStatus,
      workforceByTrade: summary.trades,
    };
  }

  private async editable(
    scope: Scope,
    projectId: string,
    permission: "site.diary" | "quality.manage",
  ) {
    const { project } = await this.access.load(scope, projectId, permission);
    if (project.status === "closed" || project.status === "cancelled")
      throw problem("project-read-only", "Closed and cancelled projects are read-only");
  }

  private author(scope: Scope, row: DiaryRow) {
    if (row.createdBy !== scope.access.userId)
      throw new ForbiddenException({
        code: "diary-author-required",
        message: "Only the diary author can edit, submit or reopen it",
      });
  }

  private async load(scope: Scope, projectId: string, diaryId: string, version?: number) {
    const row = await scope.tx.siteDiary.findFirst({
      where: { tenantId: scope.access.tenantId, projectId, id: diaryId },
    });
    if (!row) throw new NotFoundException("Site diary not found");
    if (version !== undefined && row.version !== version) throw versionConflict();
    return row;
  }

  private async response(scope: Scope, projectId: string, diaryId: string) {
    return diaryResponseSchema.parse({
      diary: toDiary(await this.load(scope, projectId, diaryId)),
    });
  }
}
