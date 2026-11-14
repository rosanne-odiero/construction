import { Injectable, NotFoundException } from "@nestjs/common";
import {
  complianceToday,
  instructionMoves,
  instructionResponse,
  suggestInstructionNumber,
} from "@pm-buddy/domain";
import {
  DOCUMENT_LIMITS,
  INSTRUCTION_KINDS,
  type InstructionAttachmentKind,
  type InstructionIssuerRole,
  type InstructionKind,
  type InstructionLifecycleStatus,
  type InstructionResponseKind,
} from "@pm-buddy/types";
import {
  instructionLogListResponseSchema,
  instructionLogResponseSchema,
  instructionOptionsResponseSchema,
  type InstructionAttachmentRequest,
  type InstructionLogQuery,
  type InstructionLogRow,
  type InstructionResponseRequest,
  type RecordInstructionRequest,
  type UpdateInstructionLogRequest,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { isUniqueViolation } from "../../common/database-errors.js";
import { uuidv7 } from "../../common/uuid.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { requestDigest } from "../procurement/p2p/p2p-common.js";
import { fromCalendarDate, toCalendarDate } from "../projects/project-mappers.js";
import {
  documentsProblem,
  DocumentsAccess,
  requirePermission,
  requireWritable,
  versionConflict,
  type DocumentsCaller,
} from "./documents-access.js";
import {
  canSeeLinked,
  changedFields,
  linkedVersions,
  peopleOf,
  personOf,
} from "./documents-mappers.js";

type InstructionRow = Prisma.InstructionGetPayload<object>;
type CountedRow = InstructionRow & {
  _count: { responses: number; attachmentLinks: number; variations: number };
};

const counted = {
  _count: { select: { responses: true, attachmentLinks: true, variations: true } },
} as const;
const numberTaken = () =>
  documentsProblem(
    409,
    "instruction-number-taken",
    "Another instruction on this project has this number",
  );

function toRow(row: CountedRow): InstructionLogRow {
  return {
    id: row.id,
    number: row.number,
    kind: row.kind as InstructionKind,
    subject: row.subject,
    issuerName: row.issuerName,
    issuerRole: row.issuerRole as InstructionIssuerRole,
    issuerFirm: row.issuerFirm,
    issuedOn: toCalendarDate(row.issuedOn),
    receivedOn: toCalendarDate(row.receivedOn ?? row.issuedOn),
    status: row.status as InstructionLifecycleStatus,
    costImplication: row.costImplication,
    timeImplication: row.timeImplication,
    attachments: row._count.attachmentLinks,
    responses: row._count.responses,
    variations: row._count.variations,
    delayLinked: row.delayId !== null,
    version: row.version,
  };
}

/** A delay's identity (its first version) and its latest version's cause and status. */
async function delaysOf(scope: Scope, projectId: string, ids: readonly string[] | null) {
  const rows = await scope.tx.scheduleDelay.findMany({
    where: {
      tenantId: scope.access.tenantId,
      projectId,
      ...(ids ? { delayId: { in: [...ids] } } : {}),
    },
    select: { delayId: true, delayNo: true, versionNo: true, cause: true, status: true },
    orderBy: [{ delayNo: "asc" }, { versionNo: "desc" }],
  });
  const result = new Map<string, { id: string; number: number; cause: string; status: string }>();
  for (const row of rows)
    if (!result.has(row.delayId))
      result.set(row.delayId, {
        id: row.delayId,
        number: row.delayNo,
        cause: row.cause,
        status: row.status,
      });
  return result;
}

/**
 * The consultant instructions log (D8.4, decision D-115): D2.3's instruction register with the
 * kind, the issuer's firm, the date received, cost and time flags, a D6.2 delay, attachments
 * (document versions or verified site photos) and append-only responses that move the status
 * received → acknowledged → actioned → closed. Variations are raised against an instruction in
 * the BQ area (D2.3) and listed here. Recording is offline-ready (client ID + Idempotency-Key).
 */
@Injectable()
export class InstructionsLogService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: DocumentsAccess,
  ) {}

  private async instructionRow(scope: Scope, projectId: string, instructionId: string) {
    const row = await scope.tx.instruction.findFirst({
      where: { tenantId: scope.access.tenantId, projectId, id: instructionId },
    });
    if (!row) throw new NotFoundException("Instruction not found");
    return row;
  }

  list(principal: Principal, projectId: string, query: InstructionLogQuery, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const caller = await this.access.reader(scope, projectId);
      const { tx, access } = scope;
      const search = query.search?.trim();
      const base: Prisma.InstructionWhereInput = { tenantId: access.tenantId, projectId };
      const where: Prisma.InstructionWhereInput = {
        ...base,
        ...(query.status === "open"
          ? { status: { not: "closed" } }
          : query.status
            ? { status: query.status }
            : {}),
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.flag === "cost" ? { costImplication: true } : {}),
        ...(query.flag === "time" ? { timeImplication: true } : {}),
        ...(search
          ? {
              OR: [
                { number: { contains: search, mode: "insensitive" } },
                { subject: { contains: search, mode: "insensitive" } },
                { issuerName: { contains: search, mode: "insensitive" } },
                { issuerFirm: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
      };
      const offset = query.cursor ?? 0;
      const [rows, total, groups, cost, time] = await Promise.all([
        tx.instruction.findMany({
          where,
          include: counted,
          orderBy: [{ receivedOn: "desc" }, { number: "desc" }, { id: "desc" }],
          skip: offset,
          take: query.limit + 1,
        }),
        tx.instruction.count({ where }),
        tx.instruction.groupBy({ by: ["status"], where: base, _count: { _all: true } }),
        tx.instruction.count({ where: { ...base, costImplication: true } }),
        tx.instruction.count({ where: { ...base, timeImplication: true } }),
      ]);
      const counts = { received: 0, acknowledged: 0, actioned: 0, closed: 0, cost, time };
      for (const group of groups)
        counts[group.status as InstructionLifecycleStatus] = group._count._all;
      return instructionLogListResponseSchema.parse({
        instructions: rows.slice(0, query.limit).map(toRow),
        counts,
        total,
        nextCursor: rows.length > query.limit ? offset + query.limit : null,
        permissions: { canRecord: caller.canRecordInstruction(projectId) },
      });
    });
  }

  options(principal: Principal, projectId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const caller = await this.access.reader(scope, projectId);
      const { tx, access } = scope;
      const [numbers, delays, versions, photos] = await Promise.all([
        tx.instruction.findMany({
          where: { tenantId: access.tenantId, projectId },
          select: { number: true },
        }),
        delaysOf(scope, projectId, null),
        tx.documentVersion.findMany({
          where: { tenantId: access.tenantId, projectId, document: { status: "active" } },
          include: { document: { select: { title: true, category: true } } },
          orderBy: { uploadedAt: "desc" },
          take: 200,
        }),
        tx.sitePhoto.findMany({
          where: { tenantId: access.tenantId, projectId, purpose: "general", verified: true },
          select: { id: true, caption: true, verified: true, capturedAt: true },
          orderBy: { id: "desc" },
          take: 50,
        }),
      ]);
      const existing = numbers.map((row) => row.number);
      return instructionOptionsResponseSchema.parse({
        nextNumbers: Object.fromEntries(
          INSTRUCTION_KINDS.map((kind) => [kind, suggestInstructionNumber(existing, kind)]),
        ),
        delays: [...delays.values()],
        versions: versions
          .filter((row) => caller.canSeeCategory(projectId, row.document.category as never))
          .slice(0, 100)
          .map((row) => ({
            documentId: row.documentId,
            versionId: row.id,
            title: row.document.title,
            category: row.document.category,
            revision: row.revision,
            state: row.isCurrent ? "current" : "superseded",
          })),
        photos: photos.map((photo) => ({
          ...photo,
          capturedAt: photo.capturedAt?.toISOString() ?? null,
        })),
        isConsultant: caller.isConsultantOn(projectId),
      });
    });
  }

  detail(principal: Principal, projectId: string, instructionId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const caller = await this.access.reader(scope, projectId);
      return this.detailOf(scope, caller, projectId, instructionId, false);
    });
  }

  private async detailOf(
    scope: Scope,
    caller: DocumentsCaller,
    projectId: string,
    instructionId: string,
    replayed: boolean,
  ) {
    const { tx, access } = scope;
    const row = await tx.instruction.findFirst({
      where: { tenantId: access.tenantId, projectId, id: instructionId },
      include: counted,
    });
    if (!row) throw new NotFoundException("Instruction not found");
    const [responses, attachments, variations, delays] = await Promise.all([
      tx.instructionResponse.findMany({
        where: { tenantId: access.tenantId, instructionId },
        orderBy: [{ recordedAt: "asc" }, { id: "asc" }],
      }),
      tx.instructionAttachment.findMany({
        where: { tenantId: access.tenantId, instructionId },
        include: {
          photo: { select: { id: true, caption: true, verified: true, capturedAt: true } },
        },
        orderBy: [{ addedAt: "asc" }, { id: "asc" }],
      }),
      tx.variationOrder.findMany({
        where: { tenantId: access.tenantId, instructionId },
        select: { id: true, number: true, title: true, status: true },
        orderBy: { number: "asc" },
      }),
      row.delayId ? delaysOf(scope, projectId, [row.delayId]) : Promise.resolve(new Map()),
    ]);
    const [people, linked] = await Promise.all([
      peopleOf(tx, [
        row.createdBy,
        row.issuedByUserId,
        ...responses.map((entry) => entry.recordedBy),
        ...attachments.map((entry) => entry.addedBy),
      ]),
      linkedVersions(
        tx,
        access.tenantId,
        attachments.map((entry) => entry.documentVersionId),
      ),
    ]);
    const status = row.status as InstructionLifecycleStatus;
    const record = caller.canRecordInstruction(projectId);
    const manage = caller.canManageInstruction(projectId);
    const issuer = row.issuedByUserId === caller.userId;
    const moves = instructionMoves(status).filter((move) =>
      move === "close" || move === "reopen" ? manage : record && !issuer,
    );
    return instructionLogResponseSchema.parse({
      instruction: {
        ...toRow(row),
        description: row.description,
        issuedBy: row.issuedByUserId ? personOf(people, row.issuedByUserId) : null,
        delay: row.delayId ? (delays.get(row.delayId) ?? null) : null,
        variationList: variations,
        legacyAttachments: (row.attachments as { name: string; reference: string | null }[]) ?? [],
        attachmentList: attachments.map((entry) => {
          const version = entry.documentVersionId ? linked.get(entry.documentVersionId) : undefined;
          const visible = version ? canSeeLinked(caller, version) : true;
          return {
            id: entry.id,
            kind: entry.kind as InstructionAttachmentKind,
            document:
              version && visible
                ? {
                    documentId: version.documentId,
                    versionId: version.versionId,
                    title: version.title,
                    category: version.category,
                    revision: version.revision,
                    state: version.state,
                  }
                : null,
            photo: entry.photo
              ? { ...entry.photo, capturedAt: entry.photo.capturedAt?.toISOString() ?? null }
              : null,
            restricted: !visible,
            addedBy: personOf(people, entry.addedBy),
            addedAt: entry.addedAt.toISOString(),
          };
        }),
        responseList: responses.map((entry) => ({
          id: entry.id,
          kind: entry.kind as InstructionResponseKind,
          body: entry.body,
          fromStatus: entry.fromStatus as InstructionLifecycleStatus,
          toStatus: entry.toStatus as InstructionLifecycleStatus,
          recordedBy: personOf(people, entry.recordedBy),
          recordedAt: entry.recordedAt.toISOString(),
        })),
        createdBy: personOf(people, row.createdBy),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        permissions: {
          canEdit: manage && status !== "closed",
          canNote: record && status !== "closed",
          canAttach:
            record &&
            status !== "closed" &&
            row._count.attachmentLinks < DOCUMENT_LIMITS.maxInstructionAttachments,
          moves,
        },
      },
      ...(replayed ? { replayed: true } : {}),
    });
  }

  /** A delay of the project, by its identity (its first version). */
  private async checkDelay(scope: Scope, projectId: string, delayId: string | null | undefined) {
    if (!delayId) return;
    const delay = await scope.tx.scheduleDelay.findFirst({
      where: { tenantId: scope.access.tenantId, projectId, id: delayId, delayId },
      select: { id: true },
    });
    if (!delay) throw documentsProblem(422, "delay-not-found", "This delay is not on the project");
  }

  private async numberFree(scope: Scope, projectId: string, number: string, except: string | null) {
    const clash = await scope.tx.instruction.findFirst({
      where: {
        tenantId: scope.access.tenantId,
        projectId,
        number,
        ...(except ? { id: { not: except } } : {}),
      },
      select: { id: true },
    });
    if (clash) throw numberTaken();
  }

  record(
    principal: Principal,
    projectId: string,
    input: RecordInstructionRequest,
    key: string,
    req: Request,
  ) {
    const digest = requestDigest("documents.instruction", { projectId, ...input });
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          const replay = await tx.instruction.findUnique({
            where: { tenantId_idempotencyKey: { tenantId: access.tenantId, idempotencyKey: key } },
          });
          if (replay) {
            if (
              replay.requestDigest !== digest ||
              replay.id !== input.id ||
              replay.projectId !== projectId
            )
              throw documentsProblem(
                409,
                "idempotency-key-reused",
                "This idempotency key was used for a different instruction",
              );
            const caller = await this.access.reader(scope, projectId);
            return this.detailOf(scope, caller, projectId, replay.id, true);
          }
          const clash = await tx.instruction.findUnique({
            where: { tenantId_id: { tenantId: access.tenantId, id: input.id } },
            select: { id: true },
          });
          if (clash)
            throw documentsProblem(
              409,
              "instruction-id-conflict",
              "An instruction with this ID was sent with another key",
            );
          const caller = await this.access.reader(scope, projectId);
          requireWritable(caller, projectId);
          requirePermission(
            caller.canRecordInstruction(projectId),
            "documents.manage, bq.edit or site.diary is required on the project",
          );
          if (input.receivedOn > complianceToday())
            throw documentsProblem(
              422,
              "instruction-date-future",
              "The date received cannot be in the future",
            );
          if (input.issuedByMe && !caller.isConsultantOn(projectId))
            throw documentsProblem(
              422,
              "invalid-transition",
              "Only a consultant records an instruction as issued by themselves",
            );
          await this.checkDelay(scope, projectId, input.delayId);
          await this.numberFree(scope, projectId, input.number, null);
          await tx.instruction.create({
            data: {
              id: input.id,
              tenantId: access.tenantId,
              projectId,
              number: input.number,
              kind: input.kind,
              issuedOn: fromCalendarDate(input.issuedOn),
              receivedOn: fromCalendarDate(input.receivedOn),
              issuerName: input.issuerName,
              issuerRole: input.issuerRole,
              issuerFirm: input.issuerFirm ?? null,
              subject: input.subject,
              description: input.description ?? null,
              costImplication: input.costImplication,
              timeImplication: input.timeImplication,
              delayId: input.delayId ?? null,
              issuedByUserId: input.issuedByMe ? access.userId : null,
              idempotencyKey: key,
              requestDigest: digest,
              capturedAt: input.capturedAt ? new Date(input.capturedAt) : null,
              createdBy: access.userId,
              updatedBy: access.userId,
            },
          });
          await this.scope.audit(tx, "instruction.recorded", input.id, {
            projectId,
            kind: input.kind,
            issuerRole: input.issuerRole,
            costImplication: input.costImplication,
            timeImplication: input.timeImplication,
            delayLinked: Boolean(input.delayId),
            issuedByMe: input.issuedByMe,
            offline: Boolean(input.capturedAt),
          });
          return this.detailOf(scope, caller, projectId, input.id, false);
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw numberTaken();
        throw error;
      });
  }

  update(
    principal: Principal,
    projectId: string,
    instructionId: string,
    input: UpdateInstructionLogRequest,
    req: Request,
  ) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const caller = await this.access.reader(scope, projectId);
          const row = await this.instructionRow(scope, projectId, instructionId);
          requireWritable(caller, projectId);
          requirePermission(
            caller.canManageInstruction(projectId),
            "documents.manage or bq.edit is required on the project",
          );
          if (row.status === "closed")
            throw documentsProblem(
              409,
              "instruction-closed",
              "A closed instruction is locked; reopen it first",
            );
          if (row.version !== input.version) throw versionConflict();
          const issuedOn = input.issuedOn ?? toCalendarDate(row.issuedOn);
          const receivedOn = input.receivedOn ?? toCalendarDate(row.receivedOn ?? row.issuedOn);
          if (receivedOn > complianceToday())
            throw documentsProblem(
              422,
              "instruction-date-future",
              "The date received cannot be in the future",
            );
          if (receivedOn < issuedOn)
            throw documentsProblem(
              422,
              "instruction-date-future",
              "An instruction is received on or after the day it was issued",
            );
          if (input.number !== undefined)
            await this.numberFree(scope, projectId, input.number, instructionId);
          await this.checkDelay(scope, projectId, input.delayId);
          const { version, ...fields } = input;
          const updated = await scope.tx.instruction.updateMany({
            where: { tenantId: scope.access.tenantId, id: instructionId, version },
            data: {
              ...(fields.number !== undefined ? { number: fields.number } : {}),
              ...(fields.kind !== undefined ? { kind: fields.kind } : {}),
              ...(fields.issuerName !== undefined ? { issuerName: fields.issuerName } : {}),
              ...(fields.issuerRole !== undefined ? { issuerRole: fields.issuerRole } : {}),
              ...(fields.issuerFirm !== undefined ? { issuerFirm: fields.issuerFirm } : {}),
              ...(fields.issuedOn !== undefined
                ? { issuedOn: fromCalendarDate(fields.issuedOn) }
                : {}),
              ...(fields.receivedOn !== undefined
                ? { receivedOn: fromCalendarDate(fields.receivedOn) }
                : {}),
              ...(fields.subject !== undefined ? { subject: fields.subject } : {}),
              ...(fields.description !== undefined ? { description: fields.description } : {}),
              ...(fields.costImplication !== undefined
                ? { costImplication: fields.costImplication }
                : {}),
              ...(fields.timeImplication !== undefined
                ? { timeImplication: fields.timeImplication }
                : {}),
              ...(fields.delayId !== undefined ? { delayId: fields.delayId } : {}),
              version: { increment: 1 },
              updatedBy: scope.access.userId,
              updatedAt: new Date(),
            },
          });
          if (!updated.count) throw versionConflict();
          await this.scope.audit(scope.tx, "instruction.updated", instructionId, {
            projectId,
            fields: changedFields(fields),
          });
          return this.detailOf(scope, caller, projectId, instructionId, false);
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw numberTaken();
        throw error;
      });
  }

  respond(
    principal: Principal,
    projectId: string,
    instructionId: string,
    input: InstructionResponseRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const caller = await this.access.reader(scope, projectId);
        const { tx, access } = scope;
        await tx.$queryRaw`SELECT id FROM instructions WHERE tenant_id = ${access.tenantId}::uuid AND id = ${instructionId}::uuid FOR UPDATE`;
        const row = await this.instructionRow(scope, projectId, instructionId);
        requireWritable(caller, projectId);
        const managing = input.kind === "close" || input.kind === "reopen";
        requirePermission(
          managing
            ? caller.canManageInstruction(projectId)
            : caller.canRecordInstruction(projectId),
          managing
            ? "documents.manage or bq.edit is required to close or reopen an instruction"
            : "documents.manage, bq.edit or site.diary is required on the project",
        );
        if (row.version !== input.version) throw versionConflict();
        const status = row.status as InstructionLifecycleStatus;
        const outcome = instructionResponse({
          kind: input.kind,
          status,
          body: input.body ?? null,
          actorId: access.userId,
          issuedBy: row.issuedByUserId,
        });
        if (!outcome.ok)
          throw documentsProblem(
            outcome.problem === "note-required" ? 422 : 409,
            outcome.problem,
            outcome.problem === "note-required"
              ? "Add a note saying what was done or why"
              : outcome.problem === "instruction-closed"
                ? "A closed instruction is locked; reopen it first"
                : outcome.problem === "instruction-issuer-cannot-respond"
                  ? "The issuer of an instruction does not acknowledge or action it"
                  : `An instruction that is ${status} cannot be given this response`,
          );
        const id = uuidv7();
        await tx.instructionResponse.create({
          data: {
            id,
            tenantId: access.tenantId,
            instructionId,
            kind: input.kind,
            body: input.body ?? null,
            fromStatus: status,
            toStatus: outcome.to,
            recordedBy: access.userId,
          },
        });
        if (outcome.moves) {
          const updated = await tx.instruction.updateMany({
            where: { tenantId: access.tenantId, id: instructionId, version: input.version },
            data: {
              status: outcome.to,
              version: { increment: 1 },
              updatedBy: access.userId,
              updatedAt: new Date(),
            },
          });
          if (!updated.count) throw versionConflict();
        }
        await this.scope.audit(tx, "instruction.responded", instructionId, {
          projectId,
          responseId: id,
          kind: input.kind,
          from: status,
          to: outcome.to,
        });
        return this.detailOf(scope, caller, projectId, instructionId, false);
      },
      true,
    );
  }

  attach(
    principal: Principal,
    projectId: string,
    instructionId: string,
    input: InstructionAttachmentRequest,
    req: Request,
  ) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const caller = await this.access.reader(scope, projectId);
          const { tx, access } = scope;
          await tx.$queryRaw`SELECT id FROM instructions WHERE tenant_id = ${access.tenantId}::uuid AND id = ${instructionId}::uuid FOR UPDATE`;
          const row = await this.instructionRow(scope, projectId, instructionId);
          requireWritable(caller, projectId);
          requirePermission(
            caller.canRecordInstruction(projectId),
            "documents.manage, bq.edit or site.diary is required on the project",
          );
          if (row.status === "closed")
            throw documentsProblem(409, "instruction-closed", "A closed instruction is locked");
          const existing = await tx.instructionAttachment.count({
            where: { tenantId: access.tenantId, instructionId },
          });
          if (existing >= DOCUMENT_LIMITS.maxInstructionAttachments)
            throw documentsProblem(
              409,
              "attachment-limit",
              `An instruction keeps at most ${DOCUMENT_LIMITS.maxInstructionAttachments} attachments`,
            );
          let kind: InstructionAttachmentKind;
          if (input.documentVersionId) {
            kind = "document_version";
            const linked = (
              await linkedVersions(tx, access.tenantId, [input.documentVersionId])
            ).get(input.documentVersionId);
            if (!linked || linked.projectId !== projectId || !canSeeLinked(caller, linked))
              throw documentsProblem(
                422,
                "attachment-not-found",
                "This document is not on the project",
              );
          } else {
            kind = "site_photo";
            const photo = await tx.sitePhoto.findFirst({
              where: {
                tenantId: access.tenantId,
                projectId,
                id: input.photoId!,
                purpose: "general",
              },
              select: { verified: true },
            });
            if (!photo)
              throw documentsProblem(
                422,
                "attachment-not-found",
                "This photo is not on the project",
              );
            if (!photo.verified)
              throw documentsProblem(
                422,
                "photo-not-verified",
                "Only verified site photos are attached to instructions",
              );
          }
          const id = uuidv7();
          await tx.instructionAttachment.create({
            data: {
              id,
              tenantId: access.tenantId,
              projectId,
              instructionId,
              kind,
              documentVersionId: input.documentVersionId ?? null,
              photoId: input.photoId ?? null,
              addedBy: access.userId,
            },
          });
          await this.scope.audit(tx, "instruction.attachment_added", instructionId, {
            projectId,
            attachmentId: id,
            kind,
          });
          return this.detailOf(scope, caller, projectId, instructionId, false);
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error))
          throw documentsProblem(409, "attachment-exists", "This is already attached");
        throw error;
      });
  }
}
