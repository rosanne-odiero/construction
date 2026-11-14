import { Injectable, NotFoundException } from "@nestjs/common";
import {
  approvalDaysOverdue,
  approvalOverdue,
  approvalRequestCode,
  approvalResponseProblem,
  complianceToday,
} from "@pm-buddy/domain";
import type {
  ApprovalChannel,
  ApprovalDecision,
  ApprovalRequestKind,
  ApprovalStatus,
} from "@pm-buddy/types";
import {
  approvalListResponseSchema,
  approvalResponseSchema,
  type ApprovalListQuery,
  type ApprovalResponseRequest,
  type ApprovalRow,
  type CancelApprovalRequest,
  type RaiseApprovalRequest,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { uuidv7 } from "../../common/uuid.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { fromCalendarDate, toCalendarDate } from "../projects/project-mappers.js";
import {
  documentsProblem,
  DocumentsAccess,
  lockProject,
  requirePermission,
  requireWritable,
  versionConflict,
  type DocumentsCaller,
} from "./documents-access.js";
import {
  canSeeLinked,
  linkedVersions,
  peopleOf,
  personOf,
  type LinkedVersion,
  type People,
} from "./documents-mappers.js";

type RequestRow = Prisma.ApprovalRequestGetPayload<object>;

const manageMessage = "documents.manage is required on the project";

function toRow(
  row: RequestRow,
  people: People,
  linked: ReadonlyMap<string, LinkedVersion>,
  caller: DocumentsCaller,
  today: string,
): ApprovalRow {
  const status = row.status as ApprovalStatus;
  const dueOn = toCalendarDate(row.dueOn);
  const version = linked.get(row.documentVersionId);
  return {
    id: row.id,
    code: approvalRequestCode(row.number),
    number: row.number,
    kind: row.kind as ApprovalRequestKind,
    title: row.title,
    addressedTo: row.addressedTo,
    sentOn: toCalendarDate(row.sentOn),
    dueOn,
    status,
    overdue: approvalOverdue(status, dueOn, today),
    daysOverdue: approvalDaysOverdue(status, dueOn, today),
    document:
      version && canSeeLinked(caller, version)
        ? {
            restricted: false,
            documentId: version.documentId,
            versionId: version.versionId,
            title: version.title,
            category: version.category,
            revision: version.revision,
            state: version.state,
            sha256: version.sha256,
            fileName: version.fileName,
            uploadedBy: personOf(people, version.uploadedBy),
          }
        : { restricted: true },
    raisedBy: personOf(people, row.raisedBy),
    version: row.version,
  };
}

/**
 * Approval requests sent to consultants (D8.4, decision D-117): material samples, shop drawings
 * and method statements as document versions, with a date sent and a due date; overdue from the
 * day after it (Nairobi). One response decides a request: in the app by someone who neither
 * raised it nor uploaded the version, on the SHA-256 they reviewed; or a paper response recorded
 * with the external consultant's name and the scan. A rejected or "resubmit" request is answered
 * by a resubmission with a new version.
 */
@Injectable()
export class ApprovalsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: DocumentsAccess,
  ) {}

  private async requestRow(scope: Scope, projectId: string, approvalId: string) {
    const row = await scope.tx.approvalRequest.findFirst({
      where: { tenantId: scope.access.tenantId, projectId, id: approvalId },
    });
    if (!row) throw new NotFoundException("Approval request not found");
    return row;
  }

  list(principal: Principal, projectId: string, query: ApprovalListQuery, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const caller = await this.access.reader(scope, projectId);
      const { tx, access } = scope;
      const today = complianceToday();
      const search = query.search?.trim();
      const base: Prisma.ApprovalRequestWhereInput = { tenantId: access.tenantId, projectId };
      const decided = ["approved", "approved_with_comments", "rejected", "resubmit"];
      const where: Prisma.ApprovalRequestWhereInput = {
        ...base,
        ...(query.status === "pending" ? { status: "pending" } : {}),
        ...(query.status === "overdue"
          ? { status: "pending", dueOn: { lt: fromCalendarDate(today) } }
          : {}),
        ...(query.status === "decided" ? { status: { in: decided } } : {}),
        ...(query.status === "cancelled" ? { status: "cancelled" } : {}),
        ...(query.kind ? { kind: query.kind } : {}),
        ...(search
          ? {
              OR: [
                { title: { contains: search, mode: "insensitive" } },
                { addressedTo: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
      };
      const offset = query.cursor ?? 0;
      const [rows, total, pending, overdue, decidedCount, cancelled] = await Promise.all([
        tx.approvalRequest.findMany({
          where,
          orderBy: [{ number: "desc" }],
          skip: offset,
          take: query.limit + 1,
        }),
        tx.approvalRequest.count({ where }),
        tx.approvalRequest.count({ where: { ...base, status: "pending" } }),
        tx.approvalRequest.count({
          where: { ...base, status: "pending", dueOn: { lt: fromCalendarDate(today) } },
        }),
        tx.approvalRequest.count({ where: { ...base, status: { in: decided } } }),
        tx.approvalRequest.count({ where: { ...base, status: "cancelled" } }),
      ]);
      const page = rows.slice(0, query.limit);
      const linked = await linkedVersions(
        tx,
        access.tenantId,
        page.map((row) => row.documentVersionId),
      );
      const people = await peopleOf(tx, [
        ...page.map((row) => row.raisedBy),
        ...[...linked.values()].map((version) => version.uploadedBy),
      ]);
      return approvalListResponseSchema.parse({
        approvals: page.map((row) => toRow(row, people, linked, caller, today)),
        counts: { pending, overdue, decided: decidedCount, cancelled },
        total,
        nextCursor: rows.length > query.limit ? offset + query.limit : null,
        permissions: { canRaise: caller.canManage(projectId) },
      });
    });
  }

  detail(principal: Principal, projectId: string, approvalId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const caller = await this.access.reader(scope, projectId);
      return this.detailOf(scope, caller, projectId, approvalId);
    });
  }

  private async detailOf(
    scope: Scope,
    caller: DocumentsCaller,
    projectId: string,
    approvalId: string,
  ) {
    const { tx, access } = scope;
    const row = await this.requestRow(scope, projectId, approvalId);
    const [response, original, resubmission] = await Promise.all([
      tx.approvalResponse.findFirst({ where: { tenantId: access.tenantId, requestId: row.id } }),
      row.resubmissionOfId
        ? tx.approvalRequest.findFirst({
            where: { tenantId: access.tenantId, id: row.resubmissionOfId },
            select: { id: true, number: true },
          })
        : Promise.resolve(null),
      tx.approvalRequest.findFirst({
        where: { tenantId: access.tenantId, resubmissionOfId: row.id },
        select: { id: true, number: true },
      }),
    ]);
    const linked = await linkedVersions(tx, access.tenantId, [
      row.documentVersionId,
      response?.evidenceVersionId,
    ]);
    const people = await peopleOf(tx, [
      row.raisedBy,
      row.cancelledBy,
      response?.recordedBy,
      response?.responderUserId,
      ...[...linked.values()].map((version) => version.uploadedBy),
    ]);
    const today = complianceToday();
    const base = toRow(row, people, linked, caller, today);
    const sent = linked.get(row.documentVersionId);
    const evidence = response?.evidenceVersionId
      ? linked.get(response.evidenceVersionId)
      : undefined;
    const pending = row.status === "pending";
    const manage = caller.canManage(projectId);
    const blocked = sent
      ? approvalResponseProblem({
          channel: "in_app",
          actorId: caller.userId,
          raisedBy: row.raisedBy,
          uploadedBy: sent.uploadedBy,
        })
      : null;
    return approvalResponseSchema.parse({
      approval: {
        ...base,
        description: row.description,
        raisedAt: row.raisedAt.toISOString(),
        resubmissionOf: original
          ? { id: original.id, code: approvalRequestCode(original.number) }
          : null,
        resubmittedAs: resubmission
          ? { id: resubmission.id, code: approvalRequestCode(resubmission.number) }
          : null,
        response: response
          ? {
              decision: response.decision as ApprovalDecision,
              comments: response.comments,
              respondedOn: toCalendarDate(response.respondedOn),
              channel: response.channel as ApprovalChannel,
              responderName: response.responderName,
              responderFirm: response.responderFirm,
              responder: response.responderUserId
                ? personOf(people, response.responderUserId)
                : null,
              evidence: !evidence
                ? null
                : canSeeLinked(caller, evidence)
                  ? {
                      restricted: false,
                      documentId: evidence.documentId,
                      versionId: evidence.versionId,
                      projectId: evidence.projectId,
                      title: evidence.title,
                      revision: evidence.revision,
                      state: evidence.state,
                      documentStatus: evidence.documentStatus,
                    }
                  : { restricted: true },
              reviewedSha256: response.reviewedSha256,
              recordedBy: personOf(people, response.recordedBy),
              recordedAt: response.recordedAt.toISOString(),
            }
          : null,
        cancellation:
          row.status === "cancelled"
            ? {
                by: personOf(people, row.cancelledBy!),
                at: row.cancelledAt!.toISOString(),
                reason: row.cancelReason!,
              }
            : null,
        permissions: {
          canRespond: manage && pending && blocked === null && !base.document.restricted,
          canRecordPaper: manage && pending && !base.document.restricted,
          canCancel: manage && pending && row.raisedBy === caller.userId,
          canResubmit:
            manage && (row.status === "rejected" || row.status === "resubmit") && !resubmission,
          respondBlockedBy: pending && manage ? blocked : null,
        },
      },
    });
  }

  raise(principal: Principal, projectId: string, input: RaiseApprovalRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const caller = await this.access.reader(scope, projectId);
        requireWritable(caller, projectId);
        requirePermission(caller.canManage(projectId), manageMessage);
        const { tx, access } = scope;
        const today = complianceToday();
        if (input.sentOn > today)
          throw documentsProblem(
            422,
            "approval-date-invalid",
            "The date sent cannot be in the future",
          );
        const linked = (await linkedVersions(tx, access.tenantId, [input.documentVersionId])).get(
          input.documentVersionId,
        );
        if (!linked || linked.projectId !== projectId || !canSeeLinked(caller, linked))
          throw documentsProblem(
            422,
            "attachment-not-found",
            "This document is not on the project",
          );
        if (linked.state !== "current" || linked.documentStatus !== "active")
          throw documentsProblem(
            409,
            "approval-document-not-current",
            "Approval is asked for the current version of an active document",
          );
        await lockProject(tx, access.tenantId, projectId);
        if (input.resubmissionOfId) {
          const original = await tx.approvalRequest.findFirst({
            where: { tenantId: access.tenantId, projectId, id: input.resubmissionOfId },
            select: { status: true },
          });
          const taken = await tx.approvalRequest.findFirst({
            where: { tenantId: access.tenantId, resubmissionOfId: input.resubmissionOfId },
            select: { id: true },
          });
          if (!original || !["rejected", "resubmit"].includes(original.status) || taken)
            throw documentsProblem(
              409,
              "approval-resubmission-invalid",
              'Only a rejected or "resubmit" request is resubmitted, once',
            );
        }
        const latest = await tx.approvalRequest.aggregate({
          where: { tenantId: access.tenantId, projectId },
          _max: { number: true },
        });
        const id = uuidv7();
        const number = (latest._max.number ?? 0) + 1;
        await tx.approvalRequest.create({
          data: {
            id,
            tenantId: access.tenantId,
            projectId,
            number,
            kind: input.kind,
            title: input.title,
            description: input.description ?? null,
            documentVersionId: input.documentVersionId,
            addressedTo: input.addressedTo,
            sentOn: fromCalendarDate(input.sentOn),
            dueOn: fromCalendarDate(input.dueOn),
            resubmissionOfId: input.resubmissionOfId ?? null,
            raisedBy: access.userId,
          },
        });
        await this.scope.audit(tx, "approval.raised", id, {
          projectId,
          code: approvalRequestCode(number),
          kind: input.kind,
          documentVersionId: input.documentVersionId,
          resubmission: Boolean(input.resubmissionOfId),
        });
        return this.detailOf(scope, caller, projectId, id);
      },
      true,
    );
  }

  respond(
    principal: Principal,
    projectId: string,
    approvalId: string,
    input: ApprovalResponseRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const caller = await this.access.reader(scope, projectId);
        const { tx, access } = scope;
        await tx.$queryRaw`SELECT id FROM approval_requests WHERE tenant_id = ${access.tenantId}::uuid AND id = ${approvalId}::uuid FOR UPDATE`;
        const row = await this.requestRow(scope, projectId, approvalId);
        requireWritable(caller, projectId);
        requirePermission(caller.canManage(projectId), manageMessage);
        if (row.status !== "pending")
          throw documentsProblem(
            409,
            "approval-not-pending",
            "This request was already answered or cancelled",
          );
        if (row.version !== input.version) throw versionConflict();
        const sent = (await linkedVersions(tx, access.tenantId, [row.documentVersionId])).get(
          row.documentVersionId,
        )!;
        if (!canSeeLinked(caller, sent))
          throw documentsProblem(403, "confidential-category", "You cannot see the document sent");
        const problem = approvalResponseProblem({
          channel: input.channel,
          actorId: access.userId,
          raisedBy: row.raisedBy,
          uploadedBy: sent.uploadedBy,
        });
        if (problem)
          throw documentsProblem(
            403,
            problem,
            problem === "approval-raiser-cannot-respond"
              ? "You raised this request: someone else answers it, or record the consultant's paper response"
              : "You uploaded this file: someone else answers it, or record the consultant's paper response",
          );
        if (input.documentSha256 !== sent.sha256)
          throw documentsProblem(
            409,
            "approval-digest-mismatch",
            "The file you reviewed is not the file sent. Reload and review it again.",
          );
        if (input.respondedOn < toCalendarDate(row.sentOn) || input.respondedOn > complianceToday())
          throw documentsProblem(
            422,
            "approval-date-invalid",
            "The response date is between the date sent and today",
          );
        if (input.channel === "paper") {
          const evidence = (
            await linkedVersions(tx, access.tenantId, [input.evidenceVersionId])
          ).get(input.evidenceVersionId!);
          if (
            !evidence ||
            evidence.projectId !== projectId ||
            evidence.versionId === row.documentVersionId ||
            !canSeeLinked(caller, evidence)
          )
            throw documentsProblem(
              422,
              "approval-evidence-invalid",
              "Attach the scan of the signed response (a document of this project)",
            );
        }
        const id = uuidv7();
        await tx.approvalResponse.create({
          data: {
            id,
            tenantId: access.tenantId,
            projectId,
            requestId: approvalId,
            decision: input.decision,
            comments: input.comments ?? null,
            respondedOn: fromCalendarDate(input.respondedOn),
            channel: input.channel,
            responderUserId: input.channel === "in_app" ? access.userId : null,
            responderName: input.channel === "in_app" ? caller.displayName : input.responderName!,
            responderFirm: input.responderFirm ?? null,
            evidenceVersionId: input.channel === "paper" ? input.evidenceVersionId! : null,
            reviewedSha256: input.documentSha256,
            recordedBy: access.userId,
          },
        });
        await this.scope.audit(tx, "approval.responded", approvalId, {
          projectId,
          code: approvalRequestCode(row.number),
          responseId: id,
          decision: input.decision,
          channel: input.channel,
        });
        return this.detailOf(scope, caller, projectId, approvalId);
      },
      true,
    );
  }

  cancel(
    principal: Principal,
    projectId: string,
    approvalId: string,
    input: CancelApprovalRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const caller = await this.access.reader(scope, projectId);
        const row = await this.requestRow(scope, projectId, approvalId);
        requireWritable(caller, projectId);
        requirePermission(caller.canManage(projectId), manageMessage);
        if (row.status !== "pending")
          throw documentsProblem(
            409,
            "approval-not-pending",
            "This request was already answered or cancelled",
          );
        if (row.raisedBy !== caller.userId)
          throw documentsProblem(
            403,
            "invalid-transition",
            "Only the person who raised a request cancels it",
          );
        if (row.version !== input.version) throw versionConflict();
        const updated = await scope.tx.approvalRequest.updateMany({
          where: { tenantId: scope.access.tenantId, id: approvalId, version: input.version },
          data: {
            status: "cancelled",
            cancelledBy: scope.access.userId,
            cancelledAt: new Date(),
            cancelReason: input.reason,
            version: { increment: 1 },
          },
        });
        if (!updated.count) throw versionConflict();
        await this.scope.audit(scope.tx, "approval.cancelled", approvalId, {
          projectId,
          code: approvalRequestCode(row.number),
        });
        return this.detailOf(scope, caller, projectId, approvalId);
      },
      true,
    );
  }
}
