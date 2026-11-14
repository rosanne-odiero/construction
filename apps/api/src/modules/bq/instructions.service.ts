import { Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import { isInstructionOpen, isProjectReadOnly, nairobiDate } from "@pm-buddy/domain";
import type {
  InstructionIssuerRole,
  InstructionKind,
  InstructionLifecycleStatus,
  ProjectStatus,
} from "@pm-buddy/types";
import {
  instructionResponseSchema,
  instructionsResponseSchema,
  type CreateInstructionRequest,
  type Instruction,
  type UpdateInstructionRequest,
} from "@pm-buddy/validation";
import {
  hasDatabaseCode,
  isCheckViolation,
  isUniqueViolation,
} from "../../common/database-errors.js";
import { uuidv7 } from "../../common/uuid.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { BqAccess, bqConflict, bqProblem, recordConflict } from "./bq-access.js";
import { peopleOf, personOf, type People } from "./bq-mappers.js";

type InstructionRow = Prisma.InstructionGetPayload<object>;
type Counts = { total: number; approved: number; pending: number };

const calendar = (value: string) => new Date(`${value}T00:00:00.000Z`);
const calendarText = (value: Date) => value.toISOString().slice(0, 10);

/** The log's kind from the issuer's role (D8.4 adds the kind; the BQ register does not ask). */
const kindOf = (role: InstructionIssuerRole): InstructionKind =>
  role === "architect"
    ? "architect_instruction"
    : role === "engineer"
      ? "engineer_instruction"
      : "other";

/** The BQ register's two-state view of the D8.4 lifecycle: open until closed. */
const registerStatus = (status: string): Instruction["status"] =>
  isInstructionOpen(status as InstructionLifecycleStatus) ? "open" : "closed";

const futureIssue = () =>
  bqProblem(422, "invalid-transition", "An instruction cannot be issued in the future");

/** Field names (never values) for audit summaries. */
const changedFields = (input: object) =>
  Object.entries(input)
    .filter(([key, value]) => key !== "version" && value !== undefined)
    .map(([key]) => key)
    .sort();

type InstructionEdits = Omit<UpdateInstructionRequest, "version" | "status">;

/** The submitted fields whose values differ from the stored row (undefined = not sent). */
function fieldChanges(row: InstructionRow, fields: InstructionEdits): InstructionEdits {
  const attachments = (value: unknown) =>
    JSON.stringify(
      ((value ?? []) as { name: string; reference?: string | null }[]).map((entry) => ({
        name: entry.name,
        reference: entry.reference ?? null,
      })),
    );
  const changes: InstructionEdits = {};
  if (fields.number !== undefined && fields.number !== row.number) changes.number = fields.number;
  if (fields.issuedOn !== undefined && fields.issuedOn !== calendarText(row.issuedOn))
    changes.issuedOn = fields.issuedOn;
  if (fields.issuerName !== undefined && fields.issuerName !== row.issuerName)
    changes.issuerName = fields.issuerName;
  if (fields.issuerRole !== undefined && fields.issuerRole !== row.issuerRole)
    changes.issuerRole = fields.issuerRole;
  if (fields.subject !== undefined && fields.subject !== row.subject)
    changes.subject = fields.subject;
  if (
    fields.description !== undefined &&
    (fields.description ?? null) !== (row.description ?? null)
  )
    changes.description = fields.description;
  if (
    fields.attachments !== undefined &&
    attachments(fields.attachments) !== attachments(row.attachments)
  )
    changes.attachments = fields.attachments;
  return changes;
}

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
    status: registerStatus(row.status),
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
          ...(query.status === "open"
            ? { status: { not: "closed" } }
            : query.status === "closed"
              ? { status: "closed" }
              : {}),
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
          if (input.issuedOn > nairobiDate()) throw futureIssue();
          const row = await tx.instruction.create({
            data: {
              id: uuidv7(),
              tenantId: access.tenantId,
              projectId,
              number: input.number,
              issuedOn: calendar(input.issuedOn),
              receivedOn: calendar(input.issuedOn),
              kind: kindOf(input.issuerRole),
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
        // A rule of the instructions log (D8.4) the checks above did not catch: never a 500.
        if (isCheckViolation(error) || hasDatabaseCode(error, ["42501"]))
          throw bqConflict(
            "invalid-transition",
            "This change breaks an instructions log rule; reload the instruction and try again",
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
          const wasOpen = isInstructionOpen(row.status as InstructionLifecycleStatus);
          const closing = fields.status === "closed" && wasOpen;
          const reopening = fields.status === "open" && !wasOpen;
          // The register's edit form sends every field; only values that differ are edits.
          const changes = fieldChanges(row, fields);
          // The log (D8.4) locks a closed instruction: reopen it (the same save may then edit it).
          if (!wasOpen && !reopening && Object.keys(changes).length)
            throw bqConflict(
              "instruction-closed",
              "A closed instruction is locked; reopen it first",
            );
          if (changes.issuedOn !== undefined && changes.issuedOn > nairobiDate())
            throw futureIssue();
          if (!closing && !reopening && !Object.keys(changes).length) {
            // Nothing to change (e.g. saving a closed instruction as closed): the record as it is.
            const [instruction] = await this.wire(scope, projectId, [row]);
            return instructionResponseSchema.parse({ instruction });
          }
          const data: Prisma.InstructionUpdateManyMutationInput = {
            version: { increment: 1 },
            updatedBy: access.userId,
            updatedAt: new Date(),
          };
          if (changes.number !== undefined) data.number = changes.number;
          if (changes.issuedOn !== undefined) {
            data.issuedOn = calendar(changes.issuedOn);
            // The date received is never before the date issued; a date received equal to the
            // date issued (as the D2.3 backfill set it) follows a corrected date issued.
            const received = row.receivedOn ? calendarText(row.receivedOn) : null;
            if (!received || received === calendarText(row.issuedOn) || received < changes.issuedOn)
              data.receivedOn = calendar(changes.issuedOn);
          }
          if (changes.issuerName !== undefined) data.issuerName = changes.issuerName;
          if (changes.issuerRole !== undefined) data.issuerRole = changes.issuerRole;
          if (changes.subject !== undefined) data.subject = changes.subject;
          if (changes.description !== undefined) data.description = changes.description;
          if (changes.attachments !== undefined) data.attachments = changes.attachments;
          let current = version;
          if (closing || reopening) {
            // The status moves only through the log's append-only responses (D-115).
            const to: InstructionLifecycleStatus = closing ? "closed" : "received";
            await tx.instructionResponse.create({
              data: {
                id: uuidv7(),
                tenantId: access.tenantId,
                instructionId,
                kind: closing ? "close" : "reopen",
                body: closing
                  ? "Closed in the BQ instruction register"
                  : "Reopened in the BQ instruction register",
                fromStatus: row.status,
                toStatus: to,
                recordedBy: access.userId,
              },
            });
            if (reopening && Object.keys(changes).length) {
              // Reopening changes nothing but the status (the database locks a closed row), so the
              // edits follow as a second version.
              const reopened = await tx.instruction.updateMany({
                where: { tenantId: access.tenantId, id: instructionId, version },
                data: {
                  status: to,
                  version: { increment: 1 },
                  updatedBy: access.userId,
                  updatedAt: new Date(),
                },
              });
              if (!reopened.count) throw recordConflict();
              current = version + 1;
            } else data.status = to;
          }
          const updated = await tx.instruction.updateMany({
            where: { tenantId: access.tenantId, id: instructionId, version: current },
            data,
          });
          if (!updated.count) throw recordConflict();
          await this.scope.audit(tx, "instruction.updated", instructionId, {
            projectId,
            fields: changedFields({
              ...changes,
              status: closing || reopening ? fields.status : undefined,
            }),
            ...(closing || reopening
              ? { from: registerStatus(row.status), to: fields.status }
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
        // A rule of the instructions log (D8.4) the checks above did not catch: never a 500.
        if (isCheckViolation(error) || hasDatabaseCode(error, ["42501"]))
          throw bqConflict(
            "invalid-transition",
            "This change breaks an instructions log rule; reload the instruction and try again",
          );
        throw error;
      });
  }
}
