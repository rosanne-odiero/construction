import { Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import { headerSignature, templateFromMapping, type BqMapping } from "@pm-buddy/domain";
import type { BqField } from "@pm-buddy/types";
import {
  BQ_TEMPLATE_MAX_DATA_OFFSET,
  bqTemplateResponseSchema,
  bqTemplatesResponseSchema,
  type BqTemplate,
  type CreateBqTemplateRequest,
} from "@pm-buddy/validation";
import { isUniqueViolation } from "../../common/database-errors.js";
import { uuidv7 } from "../../common/uuid.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { BqAccess, bqBadRequest, bqConflict } from "./bq-access.js";
import { BqObjectStore } from "./bq-object-store.js";

type TemplateRow = Prisma.BqMappingTemplateGetPayload<object>;

const toTemplate = (row: TemplateRow, people: ReadonlyMap<string, string>): BqTemplate => ({
  id: row.id,
  name: row.name,
  signature: row.signature,
  columns: row.columns as Partial<Record<BqField, number>>,
  dataOffset: row.dataOffset,
  createdAt: row.createdAt.toISOString(),
  createdBy: { id: row.createdBy, displayName: people.get(row.createdBy) ?? "—" },
});

/**
 * Saved mapping templates (company-wide tenant data). Managed by anyone holding bq.import on the
 * project they are working in; created from an import's confirmed mapping so the header
 * signature and column offsets come from the server, never from the client.
 */
@Injectable()
export class BqTemplatesService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: BqAccess,
    private readonly objects: BqObjectStore,
  ) {}

  private async people(tx: Prisma.TransactionClient, ids: string[]) {
    const users = await tx.user.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, displayName: true },
    });
    return new Map(users.map((user) => [user.id, user.displayName]));
  }

  list(principal: Principal, projectId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      await this.access.load(scope, projectId, "bq.import");
      const rows = await scope.tx.bqMappingTemplate.findMany({
        where: { tenantId: scope.access.tenantId },
        orderBy: [{ name: "asc" }],
        take: 200,
      });
      const people = await this.people(
        scope.tx,
        rows.map((row) => row.createdBy),
      );
      return bqTemplatesResponseSchema.parse({
        templates: rows.map((row) => toTemplate(row, people)),
      });
    });
  }

  async create(
    principal: Principal,
    projectId: string,
    input: CreateBqTemplateRequest,
    req: Request,
  ) {
    const row = await this.scope.run(principal, req, async (scope) => {
      await this.access.load(scope, projectId, "bq.import");
      return this.access.importRow(scope, projectId, input.importId);
    });
    const mapping = row.mapping as unknown as BqMapping | null;
    const sheetMapping = mapping?.sheets.find((sheet) => sheet.sheetIndex === input.sheetIndex);
    if (
      !row.parsedKey ||
      !["mapped", "validated", "committed", "superseded"].includes(row.status) ||
      !sheetMapping ||
      !sheetMapping.include ||
      sheetMapping.role !== "bill"
    )
      throw bqBadRequest(
        "mapping-invalid",
        "Save a mapping for this bill sheet before saving it as a template",
      );
    const grid = await this.objects.getGrid(row.parsedKey);
    const sheet = grid.sheets[input.sheetIndex];
    if (!sheet) throw bqBadRequest("mapping-invalid", "Sheet not found");
    const signature = headerSignature(sheet, sheetMapping.headerRow);
    if (!signature)
      throw bqBadRequest("mapping-invalid", "The mapped header row has no column titles");
    const body = templateFromMapping(sheet, sheetMapping);
    if (body.columns.description === undefined)
      throw bqBadRequest("mapping-invalid", "The mapping has no description column");
    if (body.dataOffset > BQ_TEMPLATE_MAX_DATA_OFFSET)
      throw bqBadRequest(
        "mapping-invalid",
        `A template needs the data to start within ${BQ_TEMPLATE_MAX_DATA_OFFSET} rows of the header`,
      );
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          await this.access.load(scope, projectId, "bq.import");
          const created = await scope.tx.bqMappingTemplate.create({
            data: {
              id: uuidv7(),
              tenantId: scope.access.tenantId,
              name: input.name,
              signature,
              columns: body.columns,
              dataOffset: body.dataOffset,
              createdBy: scope.access.userId,
            },
          });
          await this.scope.audit(scope.tx, "bq.template.created", created.id, {
            projectId,
            fields: Object.keys(body.columns).sort(),
          });
          const people = await this.people(scope.tx, [created.createdBy]);
          return bqTemplateResponseSchema.parse({ template: toTemplate(created, people) });
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error))
          throw bqConflict("template-name-taken", "Another template in this company has this name");
        throw error;
      });
  }

  remove(principal: Principal, projectId: string, templateId: string, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        await this.access.load(scope, projectId, "bq.import");
        const deleted = await scope.tx.bqMappingTemplate.deleteMany({
          where: { tenantId: scope.access.tenantId, id: templateId },
        });
        if (!deleted.count) throw new NotFoundException("Template not found");
        await this.scope.audit(scope.tx, "bq.template.deleted", templateId, { projectId });
        return { message: "Template deleted" };
      },
      true,
    );
  }
}
