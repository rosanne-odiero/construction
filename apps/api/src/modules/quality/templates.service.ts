import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import {
  QUALITY_READ_PERMISSIONS,
  STARTER_CHECKLIST_TEMPLATES,
  type InspectionCategory,
} from "@pm-buddy/types";
import {
  checklistTemplateResponseSchema,
  checklistTemplatesResponseSchema,
  checklistTemplateSummarySchema,
  type CreateChecklistTemplateRequest,
  type ReviseChecklistTemplateRequest,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { isUniqueViolation } from "../../common/database-errors.js";
import { uuidv7 } from "../../common/uuid.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { AccessPolicy, type Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { peopleOf, personOf, type People } from "../procurement/procurement-mappers.js";
import { qualityProblem, versionConflict } from "./quality-access.js";

type TemplateRow = Prisma.ChecklistTemplateGetPayload<object>;
type Content = {
  name: string;
  category: InspectionCategory;
  description: string | null;
  items: readonly { text: string }[];
};

const toSummary = (row: TemplateRow, people: People) =>
  checklistTemplateSummarySchema.parse({
    id: row.id,
    lineageId: row.lineageId,
    version: row.version,
    name: row.name,
    category: row.category,
    description: row.description,
    retired: row.retired,
    itemCount: row.itemCount,
    createdBy: personOf(people, row.createdBy),
    createdAt: row.createdAt.toISOString(),
  });

/**
 * Company checklist templates (D6.1): versioned and append-only. Reading needs a quality
 * permission held somewhere in the company; writing needs quality.manage held somewhere (like the
 * rate build-up library, ARCHITECTURE §8). Revising or retiring appends the next version of the
 * lineage; inspections keep the version they were made from.
 */
@Injectable()
export class TemplatesService {
  constructor(
    private readonly scope: TenantScope,
    private readonly policy: AccessPolicy,
  ) {}

  list(principal: Principal, includeRetired: boolean, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      await this.readable(scope);
      const rows = await scope.tx.checklistTemplate.findMany({
        where: { tenantId: scope.access.tenantId },
        orderBy: [{ name: "asc" }, { version: "desc" }],
      });
      const current = new Map<string, TemplateRow>();
      for (const row of rows) {
        const seen = current.get(row.lineageId);
        if (!seen || row.version > seen.version) current.set(row.lineageId, row);
      }
      const visible = [...current.values()].filter((row) => includeRetired || !row.retired);
      const people = await peopleOf(
        scope.tx,
        visible.map((row) => row.createdBy),
      );
      return checklistTemplatesResponseSchema.parse({
        templates: visible
          .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
          .map((row) => toSummary(row, people)),
        permissions: { canCreate: await this.policy.holdsSomewhere(scope, "quality.manage") },
      });
    });
  }

  get(principal: Principal, templateId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      await this.readable(scope);
      return this.detail(scope, templateId);
    });
  }

  create(principal: Principal, input: CreateChecklistTemplateRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        await this.policy.requireSomewhere(scope, "quality.manage");
        const id = uuidv7();
        await this.write(scope, id, id, 1, false, input);
        await this.scope.audit(scope.tx, "quality.template_created", id, {
          lineageId: id,
          version: 1,
          category: input.category,
          itemCount: input.items.length,
        });
        return this.detail(scope, id);
      },
      true,
    );
  }

  revise(
    principal: Principal,
    templateId: string,
    input: ReviseChecklistTemplateRequest,
    req: Request,
  ) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          await this.policy.requireSomewhere(scope, "quality.manage");
          const current = await this.current(scope, templateId, input.expectedVersion);
          const { expectedVersion: _expected, ...content } = input;
          const id = uuidv7();
          await this.write(scope, id, current.lineageId, current.version + 1, false, content);
          await this.scope.audit(scope.tx, "quality.template_revised", id, {
            lineageId: current.lineageId,
            version: current.version + 1,
            category: content.category,
            itemCount: content.items.length,
          });
          return this.detail(scope, id);
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw versionConflict();
        throw error;
      });
  }

  retire(principal: Principal, templateId: string, expectedVersion: number, req: Request) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          await this.policy.requireSomewhere(scope, "quality.manage");
          const current = await this.current(scope, templateId, expectedVersion);
          const items = await scope.tx.checklistTemplateItem.findMany({
            where: { tenantId: scope.access.tenantId, templateId: current.id },
            orderBy: { position: "asc" },
            select: { text: true },
          });
          const id = uuidv7();
          await this.write(scope, id, current.lineageId, current.version + 1, true, {
            name: current.name,
            category: current.category as InspectionCategory,
            description: current.description,
            items,
          });
          await this.scope.audit(scope.tx, "quality.template_retired", id, {
            lineageId: current.lineageId,
            version: current.version + 1,
          });
          return this.detail(scope, id);
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw versionConflict();
        throw error;
      });
  }

  /** Loads the starter templates (packages/types) in one language; existing names are skipped. */
  loadStarter(principal: Principal, language: "en" | "sw", req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        await this.policy.requireSomewhere(scope, "quality.manage");
        const existing = new Set(
          (
            await scope.tx.checklistTemplate.findMany({
              where: { tenantId: scope.access.tenantId },
              select: { name: true },
            })
          ).map((row) => row.name.toLowerCase()),
        );
        let created = 0;
        for (const starter of STARTER_CHECKLIST_TEMPLATES) {
          const name = starter.name[language];
          if (existing.has(name.toLowerCase())) continue;
          const id = uuidv7();
          await this.write(scope, id, id, 1, false, {
            name,
            category: starter.category,
            description: null,
            items: starter.items.map((item) => ({ text: item[language] })),
          });
          created += 1;
        }
        await this.scope.audit(scope.tx, "quality.templates_loaded", scope.access.tenantId, {
          language,
          created,
        });
        return created;
      },
      true,
    );
  }

  private async readable(scope: Scope) {
    for (const permission of QUALITY_READ_PERMISSIONS)
      if (await this.policy.holdsSomewhere(scope, permission)) return;
    throw new ForbiddenException(
      `One of these permissions is required: ${QUALITY_READ_PERMISSIONS.join(", ")}`,
    );
  }

  /** The newest version of the template's lineage, which must be the one the caller read. */
  private async current(scope: Scope, templateId: string, expectedVersion: number) {
    const { tenantId } = scope.access;
    const row = await scope.tx.checklistTemplate.findFirst({ where: { tenantId, id: templateId } });
    if (!row) throw new NotFoundException("Template not found");
    const latest = await scope.tx.checklistTemplate.findFirst({
      where: { tenantId, lineageId: row.lineageId },
      orderBy: { version: "desc" },
    });
    if (latest!.retired)
      throw qualityProblem(409, "template-retired", "A retired template cannot be changed");
    if (latest!.version !== expectedVersion) throw versionConflict();
    return latest!;
  }

  private async write(
    scope: Scope,
    id: string,
    lineageId: string,
    version: number,
    retired: boolean,
    content: Content,
  ) {
    const { tenantId, userId } = scope.access;
    await scope.tx.checklistTemplate.create({
      data: {
        id,
        tenantId,
        lineageId,
        version,
        name: content.name,
        category: content.category,
        description: content.description,
        retired,
        itemCount: content.items.length,
        createdBy: userId,
      },
    });
    await scope.tx.checklistTemplateItem.createMany({
      data: content.items.map((item, index) => ({
        id: uuidv7(),
        tenantId,
        templateId: id,
        position: index + 1,
        text: item.text,
      })),
    });
  }

  private async detail(scope: Scope, templateId: string) {
    const { tenantId } = scope.access;
    const row = await scope.tx.checklistTemplate.findFirst({
      where: { tenantId, id: templateId },
      include: { items: { orderBy: { position: "asc" } } },
    });
    if (!row) throw new NotFoundException("Template not found");
    const lineage = await scope.tx.checklistTemplate.findMany({
      where: { tenantId, lineageId: row.lineageId },
      orderBy: { version: "desc" },
    });
    const newest = lineage[0]!;
    const current = newest.id === row.id;
    const people = await peopleOf(
      scope.tx,
      lineage.map((entry) => entry.createdBy),
    );
    const canWrite =
      current && !row.retired && (await this.policy.holdsSomewhere(scope, "quality.manage"));
    return checklistTemplateResponseSchema.parse({
      template: {
        ...toSummary(row, people),
        current,
        items: row.items.map((item) => ({
          id: item.id,
          position: item.position,
          text: item.text,
        })),
        permissions: { canRevise: canWrite, canRetire: canWrite },
      },
      history: lineage
        .filter((entry) => entry.id !== row.id)
        .map((entry) => toSummary(entry, people)),
    });
  }
}
