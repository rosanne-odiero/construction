import { Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import { isProjectReadOnly } from "@pm-buddy/domain";
import type { ProjectStatus } from "@pm-buddy/types";
import {
  instructionResponseSchema,
  instructionsResponseSchema,
  type CreateInstructionRequest,
  type Instruction,
  type UpdateInstructionRequest,
} from "@pm-buddy/validation";
import { isUniqueViolation } from "../../common/database-errors.js";
import { uuidv7 } from "../../common/uuid.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { BqAccess, bqConflict, recordConflict } from "./bq-access.js";
import { peopleOf, personOf, type People } from "./bq-mappers.js";

type InstructionRow = Prisma.InstructionGetPayload<object>;
type Counts = { total: number; approved: number; pending: number };

const calendar = (value: string) => new Date(`${value}T00:00:00.000Z`);
const calendarText = (value: Date) => value.toISOString().slice(0, 10);

/** Field names (never values) for audit summaries. */
const changedFields = (input: object) =>
  Object.entries(input)
    .filter(([key, value]) => key !== "version" && value !== undefined)
    .map(([key]) => key)
    .sort();

function toInstruction(row: InstructionRow, people: People, counts: Counts): Instruction {
  return {
    id: row.id,
    number: row.number,
    issuedOn: calendarText(row.issuedOn),
    issuerName: row.issuerName,
    issuerRole: row.issuerRole as Instruction["issuerRole"],
    subject: row.subject,
    description: row.description,
    attachments: row.attachments as Instruction["attachments"],
    status: row.status as Instruction["status"],
    variations: counts,
    createdBy: personOf(people, row.createdBy),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  };
}

/**
 * The project's register of Architect's/Engineer's Instructions (D2.3). Reading needs bq.view;
 * creating and changing need bq.edit on a project that is not read-only. Numbers are unique per
 * project. Audit events carry field names and IDs only (never subjects or descriptions).
 */
@Injectable()
export class InstructionsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: BqAccess,
  ) {}

  private async counts(scope: Scope, projectId: string, ids: string[]) {
    const groups = ids.length
      ? await scope.tx.variationOrder.groupBy({
          by: ["instructionId", "status"],
          where: { tenantId: scope.access.tenantId, projectId, instructionId: { in: ids } },
          _count: { _all: true },
        })
      : [];
    const result = new Map<string, Counts>();
    for (const group of groups) {
      const entry = result.get(group.instructionId) ?? { total: 0, approved: 0, pending: 0 };
      entry.total += group._count._all;
      if (group.status === "approved") entry.approved += group._count._all;
      if (group.status === "submitted") entry.pending += group._count._all;
      result.set(group.instructionId, entry);
    }
    return result;
  }

  private async wire(scope: Scope, projectId: string, rows: InstructionRow[]) {
    const [people, counts] = await Promise.all([
      peopleOf(
        scope.tx,
        rows.map((row) => row.createdBy),
      ),
      this.counts(
        scope,
        projectId,
        rows.map((row) => row.id),
      ),
    ]);
    return rows.map((row) =>
      toInstruction(row, people, counts.get(row.id) ?? { total: 0, approved: 0, pending: 0 }),
    );
  }

  /** An instruction of this project in the caller's company (404 otherwise). */
  static async row(scope: Scope, projectId: string, instructionId: string) {
    const row = await scope.tx.instruction.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id: instructionId } },
    });
    if (!row || row.projectId !== projectId) throw new NotFoundException("Instruction not found");
    return row;
  }

  list(principal: Principal, projectId: string, query: { status?: string }, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { project, effective } = await this.access.load(scope, projectId, "bq.view");
      const rows = await scope.tx.instruction.findMany({
        where: {
          tenantId: scope.access.tenantId,
          projectId,
          ...(query.status ? { status: query.status } : {}),
        },
        orderBy: [{ issuedOn: "desc" }, { number: "desc" }],
      });
      return instructionsResponseSchema.parse({
        instructions: await this.wire(scope, projectId, rows),
        permissions: {
          canEdit: effective.has("bq.edit") && !isProjectReadOnly(project.status as ProjectStatus),
        },
      });
    });
  }

  get(principal: Principal, projectId: string, instructionId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      await this.access.load(scope, projectId, "bq.view");
      const row = await InstructionsService.row(scope, projectId, instructionId);
      const [instruction] = await this.wire(scope, projectId, [row]);
      return instructionResponseSchema.parse({ instruction });
    });
  }

  create(principal: Principal, projectId: string, input: CreateInstructionRequest, req: Request) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          await this.access.editable(scope, projectId);
          const row = await tx.instruction.create({
            data: {
              id: uuidv7(),
              tenantId: access.tenantId,
              projectId,
              number: input.number,
              issuedOn: calendar(input.issuedOn),
              issuerName: input.issuerName,
              issuerRole: input.issuerRole,
              subject: input.subject,
              description: input.description ?? null,
              attachments: input.attachments,
              createdBy: access.userId,
              updatedBy: access.userId,
            },
          });
          await this.scope.audit(tx, "instruction.created", row.id, {
            projectId,
            issuerRole: input.issuerRole,
            attachments: input.attachments.length,
            fields: changedFields(input),
          });
          const [instruction] = await this.wire(scope, projectId, [row]);
          return instructionResponseSchema.parse({ instruction });
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error))
          throw bqConflict(
            "instruction-number-taken",
            "Another instruction on this project has this number",
          );
        throw error;
      });
  }

  update(
    principal: Principal,
    projectId: string,
    instructionId: string,
    input: UpdateInstructionRequest,
    req: Request,
  ) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          await this.access.editable(scope, projectId);
          const row = await InstructionsService.row(scope, projectId, instructionId);
          if (row.version !== input.version) throw recordConflict();
          const { version, ...fields } = input;
          const data: Prisma.InstructionUpdateManyMutationInput = {
            version: { increment: 1 },
            updatedBy: access.userId,
            updatedAt: new Date(),
          };
          if (fields.number !== undefined) data.number = fields.number;
          if (fields.issuedOn !== undefined) data.issuedOn = calendar(fields.issuedOn);
          if (fields.issuerName !== undefined) data.issuerName = fields.issuerName;
          if (fields.issuerRole !== undefined) data.issuerRole = fields.issuerRole;
          if (fields.subject !== undefined) data.subject = fields.subject;
          if (fields.description !== undefined) data.description = fields.description;
          if (fields.attachments !== undefined) data.attachments = fields.attachments;
          if (fields.status !== undefined) data.status = fields.status;
          const updated = await tx.instruction.updateMany({
            where: { tenantId: access.tenantId, id: instructionId, version },
            data,
          });
          if (!updated.count) throw recordConflict();
          await this.scope.audit(tx, "instruction.updated", instructionId, {
            projectId,
            fields: changedFields(fields),
            ...(fields.status !== undefined && fields.status !== row.status
              ? { from: row.status, to: fields.status }
              : {}),
          });
          const after = await InstructionsService.row(scope, projectId, instructionId);
          const [instruction] = await this.wire(scope, projectId, [after]);
          return instructionResponseSchema.parse({ instruction });
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error))
          throw bqConflict(
            "instruction-number-taken",
            "Another instruction on this project has this number",
          );
        throw error;
      });
  }
}
