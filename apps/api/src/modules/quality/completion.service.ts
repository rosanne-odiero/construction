import { Injectable, NotFoundException } from "@nestjs/common";
import {
  checkProcurementTransition,
  completionBlockers,
  COMPLETION_TRANSITIONS,
  dlpEndDate,
  dlpState,
  nairobiDate,
  type CompletionBlocker,
} from "@pm-buddy/domain";
import type { CompletionKind, CompletionStatus } from "@pm-buddy/types";
import {
  completionCertificateSchema,
  completionResponseSchema,
  type CompletionActionRequest,
  type ProposeCompletionRequest,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { isUniqueViolation } from "../../common/database-errors.js";
import { uuidv7 } from "../../common/uuid.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { peopleOf, personOf, type People } from "../procurement/procurement-mappers.js";
import { fromCalendarDate, toCalendarDate } from "../projects/project-mappers.js";
import {
  lockProject,
  QualityAccess,
  qualityProblem,
  qualitySettings,
  versionConflict,
  type QualityContext,
} from "./quality-access.js";

type CompletionRow = Prisma.ProjectCompletionGetPayload<object>;

const blockerProblems: Record<CompletionBlocker, () => Error> = {
  open_critical_snags: () =>
    qualityProblem(
      409,
      "completion-open-critical-snags",
      "Open critical snags block practical completion unless an exception reason is recorded",
    ),
  open_snags: () =>
    qualityProblem(
      409,
      "completion-open-snags",
      "Open snags block final completion unless an exception reason is recorded",
    ),
  practical_not_certified: () =>
    qualityProblem(
      409,
      "completion-practical-required",
      "Final completion needs certified practical completion",
    ),
  dlp_not_ended: () =>
    qualityProblem(
      409,
      "completion-dlp-not-ended",
      "Final completion cannot be dated before the defects liability period ends",
    ),
  date_future: () =>
    qualityProblem(409, "quality-date-future", "A completion date cannot be in the future"),
};

/**
 * Practical and final completion (D6.1). Practical completion starts the defects liability period
 * (DLP, the company default unless the proposal says otherwise) and is refused while critical
 * snags are open unless an exception reason is recorded; final completion follows the end of the
 * DLP with no open snags (or an exception). Each certificate is proposed (projects.manage) and
 * certified by someone else holding quality.manage, then locked; D6.3 releases retention against
 * the two certificates.
 */
@Injectable()
export class CompletionService {
  constructor(
    private readonly scope: TenantScope,
    private readonly quality: QualityAccess,
  ) {}

  get(principal: Principal, projectId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const context = await this.quality.load(scope, projectId);
      return this.view(scope, context);
    });
  }

  propose(principal: Principal, projectId: string, input: ProposeCompletionRequest, req: Request) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const context = await this.quality.proposer(scope, projectId);
          const { tenantId, userId } = scope.access;
          await lockProject(scope.tx, tenantId, projectId);
          const live = await scope.tx.projectCompletion.findFirst({
            where: { tenantId, projectId, kind: input.kind, status: { not: "withdrawn" } },
            select: { id: true },
          });
          if (live)
            throw qualityProblem(
              409,
              "completion-exists",
              "This project already has a live certificate of this kind",
            );
          const counts = await this.check(scope, projectId, {
            kind: input.kind,
            completionDate: input.completionDate,
            exceptionReason: input.exceptionReason,
          });
          const dlpMonths =
            input.kind === "practical"
              ? (input.dlpMonths ?? (await qualitySettings(scope.tx, tenantId)).dlpMonths)
              : null;
          const id = uuidv7();
          await scope.tx.projectCompletion.create({
            data: {
              id,
              tenantId,
              projectId,
              kind: input.kind,
              completionDate: fromCalendarDate(input.completionDate),
              dlpMonths,
              dlpEndsOn:
                dlpMonths === null
                  ? null
                  : fromCalendarDate(dlpEndDate(input.completionDate, dlpMonths)),
              openCriticalSnags: counts.openCritical,
              openSnags: counts.open,
              exceptionReason: input.exceptionReason,
              notes: input.notes,
              proposedBy: userId,
            },
          });
          await this.scope.audit(scope.tx, "quality.completion_proposed", id, {
            projectId,
            kind: input.kind,
            completionDate: input.completionDate,
            dlpMonths,
            openSnags: counts.open,
            openCriticalSnags: counts.openCritical,
            exception: input.exceptionReason !== null,
          });
          return this.view(scope, context);
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error))
          throw qualityProblem(
            409,
            "completion-exists",
            "This project already has a live certificate of this kind",
          );
        throw error;
      });
  }

  action(
    principal: Principal,
    projectId: string,
    completionId: string,
    input: CompletionActionRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const context =
          input.action === "certify"
            ? await this.quality.reviewer(scope, projectId)
            : await this.quality.proposer(scope, projectId);
        const { tenantId, userId } = scope.access;
        await lockProject(scope.tx, tenantId, projectId);
        const row = await scope.tx.projectCompletion.findFirst({
          where: { tenantId, projectId, id: completionId },
        });
        if (!row) throw new NotFoundException("Completion certificate not found");
        if (row.version !== input.version) throw versionConflict();
        const check = checkProcurementTransition(
          COMPLETION_TRANSITIONS,
          row.status as CompletionStatus,
          input.action,
          input.reason,
        );
        if (!check.ok)
          throw qualityProblem(409, "invalid-transition", "This action is not available now");
        let data: Prisma.ProjectCompletionUncheckedUpdateManyInput;
        if (input.action === "certify") {
          if (row.proposedBy === userId)
            throw qualityProblem(
              403,
              "completion-independent",
              "Someone other than the proposer must certify completion",
            );
          const counts = await this.check(scope, projectId, {
            kind: row.kind as CompletionKind,
            completionDate: toCalendarDate(row.completionDate),
            exceptionReason: row.exceptionReason,
          });
          data = {
            status: "certified",
            certifiedBy: userId,
            openSnags: counts.open,
            openCriticalSnags: counts.openCritical,
          };
        } else {
          data = { status: "withdrawn", withdrawnBy: userId, withdrawReason: input.reason! };
        }
        const changed = await scope.tx.projectCompletion.updateMany({
          where: { tenantId, projectId, id: completionId, version: input.version },
          data: { ...data, version: { increment: 1 } },
        });
        if (changed.count !== 1) throw versionConflict();
        await this.scope.audit(
          scope.tx,
          input.action === "certify"
            ? "quality.completion_certified"
            : "quality.completion_withdrawn",
          completionId,
          {
            projectId,
            kind: row.kind,
            version: input.version + 1,
            ...(input.action === "certify"
              ? { openSnags: data.openSnags, openCriticalSnags: data.openCriticalSnags }
              : {}),
          },
        );
        return this.view(scope, context);
      },
      true,
    );
  }

  /** Today's snag counts and the blockers for this certificate (refused with a problem code). */
  private async check(
    scope: Scope,
    projectId: string,
    input: { kind: CompletionKind; completionDate: string; exceptionReason: string | null },
  ) {
    const counts = await this.snagCounts(scope, projectId);
    const practical = await this.certifiedPractical(scope, projectId);
    const blockers = completionBlockers({
      kind: input.kind,
      completionDate: input.completionDate,
      today: nairobiDate(),
      openCriticalSnags: counts.openCritical,
      openSnags: counts.open,
      exceptionReason: input.exceptionReason,
      practical: practical ? { dlpEndsOn: toCalendarDate(practical.dlpEndsOn!) } : null,
    });
    if (blockers.length) throw blockerProblems[blockers[0]!]();
    return counts;
  }

  private async snagCounts(scope: Scope, projectId: string) {
    const { tenantId } = scope.access;
    const [open, openCritical] = await Promise.all([
      scope.tx.snag.count({ where: { tenantId, projectId, status: { not: "closed" } } }),
      scope.tx.snag.count({
        where: { tenantId, projectId, status: { not: "closed" }, severity: "critical" },
      }),
    ]);
    return { open, openCritical };
  }

  private certifiedPractical(scope: Scope, projectId: string) {
    return scope.tx.projectCompletion.findFirst({
      where: { tenantId: scope.access.tenantId, projectId, kind: "practical", status: "certified" },
    });
  }

  private toCertificate(row: CompletionRow, people: People, context: QualityContext) {
    const proposed = row.status === "proposed";
    return completionCertificateSchema.parse({
      id: row.id,
      kind: row.kind,
      status: row.status,
      completionDate: toCalendarDate(row.completionDate),
      dlpMonths: row.dlpMonths,
      dlpEndsOn: row.dlpEndsOn ? toCalendarDate(row.dlpEndsOn) : null,
      openCriticalSnags: row.openCriticalSnags,
      openSnags: row.openSnags,
      exceptionReason: row.exceptionReason,
      notes: row.notes,
      version: row.version,
      proposedBy: personOf(people, row.proposedBy),
      proposedAt: row.proposedAt.toISOString(),
      certifiedBy: row.certifiedBy ? personOf(people, row.certifiedBy) : null,
      certifiedAt: row.certifiedAt?.toISOString() ?? null,
      withdrawnBy: row.withdrawnBy ? personOf(people, row.withdrawnBy) : null,
      withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
      withdrawReason: row.withdrawReason,
      permissions: {
        canCertify: context.canReview && proposed && row.proposedBy !== context.userId,
        canWithdraw: context.canPropose && proposed,
      },
    });
  }

  private async view(scope: Scope, context: QualityContext) {
    const { tenantId } = scope.access;
    const projectId = context.project.id;
    const today = nairobiDate();
    const rows = await scope.tx.projectCompletion.findMany({
      where: { tenantId, projectId },
      orderBy: { proposedAt: "desc" },
    });
    const people = await peopleOf(
      scope.tx,
      rows.flatMap((row) => [row.proposedBy, row.certifiedBy, row.withdrawnBy]),
    );
    const live = (kind: CompletionKind) =>
      rows.find((row) => row.kind === kind && row.status !== "withdrawn") ?? null;
    const practical = live("practical");
    const final = live("final");
    const counts = await this.snagCounts(scope, projectId);
    const settings = await qualitySettings(scope.tx, tenantId);
    let dlp = null;
    if (practical?.status === "certified" && practical.dlpEndsOn && practical.dlpMonths) {
      const endsOn = toCalendarDate(practical.dlpEndsOn);
      const [open, fixed, closed] = await Promise.all(
        (["open", "fixed", "closed"] as const).map((status) =>
          scope.tx.snag.count({ where: { tenantId, projectId, phase: "dlp", status } }),
        ),
      );
      dlp = {
        startsOn: toCalendarDate(practical.completionDate),
        endsOn,
        months: practical.dlpMonths,
        ...dlpState(today, endsOn),
        defects: { open: open!, fixed: fixed!, closed: closed! },
      };
    }
    const certifiedEnd =
      practical?.status === "certified" && practical.dlpEndsOn
        ? { dlpEndsOn: toCalendarDate(practical.dlpEndsOn) }
        : null;
    const blockers = (kind: CompletionKind) =>
      completionBlockers({
        kind,
        completionDate: today,
        today,
        openCriticalSnags: counts.openCritical,
        openSnags: counts.open,
        exceptionReason: null,
        practical: certifiedEnd,
      });
    return completionResponseSchema.parse({
      practical: practical ? this.toCertificate(practical, people, context) : null,
      final: final ? this.toCertificate(final, people, context) : null,
      history: rows.map((row) => this.toCertificate(row, people, context)),
      dlp,
      readiness: {
        openCriticalSnags: counts.openCritical,
        openSnags: counts.open,
        practicalBlockers: blockers("practical"),
        finalBlockers: blockers("final"),
      },
      defaultDlpMonths: settings.dlpMonths,
      permissions: { canPropose: context.canPropose },
    });
  }
}
