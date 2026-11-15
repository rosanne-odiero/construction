import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import {
  compareReminders,
  complianceCounts,
  complianceDatesProblem,
  complianceStatus,
  complianceToday,
  reminderKindOf,
} from "@pm-buddy/domain";
import {
  COMPLIANCE_LIMITS,
  COMPLIANCE_STARTER_TYPES,
  type ComplianceRecordKind,
  type ComplianceScope,
} from "@pm-buddy/types";
import {
  complianceHistoryResponseSchema,
  complianceRegisterResponseSchema,
  complianceTypeResponseSchema,
  complianceTypesResponseSchema,
  type ComplianceItem,
  type ComplianceRecord,
  type ComplianceType,
  type CreateComplianceTypeRequest,
  type DocumentReminder,
  type RecordComplianceRequest,
  type UpdateComplianceTypeRequest,
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
  type LinkedVersion,
  type People,
} from "./documents-mappers.js";

type TypeRow = Prisma.ComplianceTypeGetPayload<object>;
type RecordRow = Prisma.ComplianceRecordGetPayload<object>;
type ProjectRef = { id: string; code: string; name: string };

const optionalDate = (value: Date | null) => (value ? toCalendarDate(value) : null);
const itemKey = (typeId: string, projectId: string | null) => `${typeId}:${projectId ?? "company"}`;

export function toType(row: TypeRow): ComplianceType {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    starter: row.starter,
    complianceReview: row.starter,
    scope: row.scope as ComplianceScope,
    expires: row.expires,
    reminderDays: row.reminderDays,
    active: row.active,
    sortOrder: row.sortOrder,
    version: row.version,
  };
}

function toRecord(
  row: RecordRow,
  people: People,
  linked: ReadonlyMap<string, LinkedVersion>,
  caller: DocumentsCaller,
): ComplianceRecord {
  const version = row.evidenceVersionId ? linked.get(row.evidenceVersionId) : undefined;
  return {
    id: row.id,
    kind: row.kind as ComplianceRecordKind,
    referenceNo: row.referenceNo,
    issuer: row.issuer,
    issuedOn: optionalDate(row.issuedOn),
    expiresOn: optionalDate(row.expiresOn),
    notes: row.notes,
    reason: row.reason,
    evidence: !version
      ? null
      : canSeeLinked(caller, version)
        ? {
            restricted: false,
            documentId: version.documentId,
            versionId: version.versionId,
            projectId: version.projectId,
            title: version.title,
            revision: version.revision,
            state: version.state,
            documentStatus: version.documentStatus,
          }
        : { restricted: true },
    recordedBy: personOf(people, row.recordedBy),
    recordedAt: row.recordedAt.toISOString(),
    state: row.isCurrent ? "current" : "superseded",
  };
}

/** Everything the register needs for a set of projects, loaded in a few queries. */
export type ComplianceFacts = {
  today: string;
  types: TypeRow[];
  current: Map<string, RecordRow>;
  counts: Map<string, number>;
  people: People;
  linked: Map<string, LinkedVersion>;
};

/**
 * The compliance register (D8.4, decision D-116): company-configurable item types (a starter set
 * flagged COMPLIANCE-REVIEW), append-only records per project item (company items once for the
 * company), and statuses derived on read in Nairobi business dates. Renewals supersede the current
 * record; "not applicable" is a record with a reason. Reminders are computed on read.
 */
@Injectable()
export class ComplianceService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: DocumentsAccess,
  ) {}

  /** Installs the starter types a company does not have yet (idempotent, first use). */
  async ensureTypes(scope: Scope) {
    const { tx, access } = scope;
    const have = await tx.complianceType.findMany({
      where: { tenantId: access.tenantId, starter: true },
      select: { key: true },
    });
    if (have.length >= COMPLIANCE_STARTER_TYPES.length) return;
    const keys = new Set(have.map((row) => row.key));
    const missing = COMPLIANCE_STARTER_TYPES.map((type, index) => ({ type, index })).filter(
      ({ type }) => !keys.has(type.key),
    );
    await tx.complianceType.createMany({
      data: missing.map(({ type, index }) => ({
        id: uuidv7(),
        tenantId: access.tenantId,
        key: type.key,
        label: null,
        starter: true,
        scope: type.scope,
        expires: type.expires,
        reminderDays: type.reminderDays,
        sortOrder: (index + 1) * 10,
        createdBy: access.userId,
        updatedBy: access.userId,
      })),
      skipDuplicates: true,
    });
  }

  async facts(scope: Scope, projectIds: readonly string[]): Promise<ComplianceFacts> {
    await this.ensureTypes(scope);
    const { tx, access } = scope;
    const ids = [...projectIds];
    const projectScope: Prisma.ComplianceRecordWhereInput = {
      OR: [{ projectId: { in: ids } }, { projectId: null }],
    };
    const [types, records, groups] = await Promise.all([
      tx.complianceType.findMany({
        where: { tenantId: access.tenantId },
        orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
      }),
      tx.complianceRecord.findMany({
        where: { tenantId: access.tenantId, isCurrent: true, ...projectScope },
      }),
      tx.complianceRecord.groupBy({
        by: ["typeId", "projectId"],
        where: { tenantId: access.tenantId, ...projectScope },
        _count: { _all: true },
      }),
    ]);
    const [people, linked] = await Promise.all([
      peopleOf(
        tx,
        records.map((row) => row.recordedBy),
      ),
      linkedVersions(
        tx,
        access.tenantId,
        records.map((row) => row.evidenceVersionId),
      ),
    ]);
    return {
      today: complianceToday(),
      types,
      current: new Map(records.map((row) => [itemKey(row.typeId, row.projectId), row])),
      counts: new Map(
        groups.map((group) => [itemKey(group.typeId, group.projectId), group._count._all]),
      ),
      people,
      linked,
    };
  }

  /** The register's items for a project (project items and company items) or for the company. */
  items(
    facts: ComplianceFacts,
    caller: DocumentsCaller,
    projectId: string | null,
  ): ComplianceItem[] {
    return facts.types
      .filter((type) => type.active && (projectId !== null || type.scope === "company"))
      .map((type) => {
        const owner = type.scope === "company" ? null : projectId;
        const current = facts.current.get(itemKey(type.id, owner)) ?? null;
        const state = complianceStatus(
          current
            ? {
                kind: current.kind as ComplianceRecordKind,
                expiresOn: optionalDate(current.expiresOn),
              }
            : null,
          { expires: type.expires, reminderDays: type.reminderDays },
          facts.today,
        );
        return {
          type: toType(type),
          status: state.status,
          daysLeft: state.daysLeft,
          remindFrom: state.remindFrom,
          current: current ? toRecord(current, facts.people, facts.linked, caller) : null,
          historyCount: facts.counts.get(itemKey(type.id, owner)) ?? 0,
          canRecord:
            type.scope === "company"
              ? caller.canConfigure
              : owner !== null && caller.canManage(owner),
        };
      });
  }

  /** Compliance reminders (missing, expiring, expired) for the items, newest problems first. */
  static reminders(
    items: readonly ComplianceItem[],
    project: ProjectRef | null,
  ): DocumentReminder[] {
    const reminders: DocumentReminder[] = [];
    for (const item of items) {
      const kind = reminderKindOf(item.status);
      if (!kind) continue;
      reminders.push({
        kind,
        project: item.type.scope === "company" ? null : project,
        type: { id: item.type.id, key: item.type.key, label: item.type.label },
        approval: null,
        expiresOn: item.current?.expiresOn ?? null,
        dueOn: null,
        daysLeft: item.daysLeft,
      });
    }
    return reminders.sort((a, b) =>
      compareReminders(
        { kind: a.kind, daysLeft: a.daysLeft, label: a.type?.key ?? "" },
        { kind: b.kind, daysLeft: b.daysLeft, label: b.type?.key ?? "" },
      ),
    );
  }

  register(principal: Principal, projectId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const caller = await this.access.reader(scope, projectId);
      const project = caller.projects.get(projectId)!;
      const facts = await this.facts(scope, [projectId]);
      const items = this.items(facts, caller, projectId);
      return complianceRegisterResponseSchema.parse({
        project: { id: project.id, code: project.code, name: project.name },
        today: facts.today,
        items,
        counts: complianceCounts(items.map((item) => item.status)),
        reminders: ComplianceService.reminders(items, {
          id: project.id,
          code: project.code,
          name: project.name,
        }),
        permissions: {
          canRecord: caller.canManage(projectId),
          canRecordCompany: caller.canConfigure,
          canExport: true,
          canConfigure: caller.canConfigure,
        },
      });
    });
  }

  /** An item's records, newest first (project items of the project, or the company's item). */
  history(principal: Principal, projectId: string | null, typeId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const caller = projectId
        ? await this.access.reader(scope, projectId)
        : await this.access.anyReader(scope);
      return this.historyOf(scope, caller, projectId, typeId);
    });
  }

  private async typeRow(scope: Scope, typeId: string) {
    const row = await scope.tx.complianceType.findFirst({
      where: { tenantId: scope.access.tenantId, id: typeId },
    });
    if (!row) throw new NotFoundException("Compliance item type not found");
    return row;
  }

  private async historyOf(
    scope: Scope,
    caller: DocumentsCaller,
    projectId: string | null,
    typeId: string,
  ) {
    await this.ensureTypes(scope);
    const type = await this.typeRow(scope, typeId);
    if (projectId === null && type.scope !== "company")
      throw new NotFoundException("Compliance item type not found");
    const owner = type.scope === "company" ? null : projectId;
    const { tx, access } = scope;
    const rows = await tx.complianceRecord.findMany({
      where: { tenantId: access.tenantId, typeId, projectId: owner },
      orderBy: { recordedAt: "desc" },
    });
    const [people, linked] = await Promise.all([
      peopleOf(
        tx,
        rows.map((row) => row.recordedBy),
      ),
      linkedVersions(
        tx,
        access.tenantId,
        rows.map((row) => row.evidenceVersionId),
      ),
    ]);
    const facts: ComplianceFacts = {
      today: complianceToday(),
      types: [type],
      current: new Map(
        rows.filter((row) => row.isCurrent).map((row) => [itemKey(row.typeId, row.projectId), row]),
      ),
      counts: new Map([[itemKey(type.id, owner), rows.length]]),
      people,
      linked,
    };
    const item = this.items(
      { ...facts, types: [{ ...type, active: true }] },
      caller,
      projectId ?? null,
    )[0]!;
    return complianceHistoryResponseSchema.parse({
      item: { ...item, type: toType(type), canRecord: item.canRecord && type.active },
      records: rows.map((row) => toRecord(row, people, linked, caller)),
    });
  }

  /** Records an item (project items: documents.manage; company items: config.manage). */
  record(
    principal: Principal,
    projectId: string | null,
    input: RecordComplianceRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const caller = projectId
          ? await this.access.reader(scope, projectId)
          : await this.access.anyReader(scope);
        await this.ensureTypes(scope);
        const type = await this.typeRow(scope, input.typeId);
        if (projectId === null) {
          if (!caller.canConfigure)
            throw new ForbiddenException("Company items need config.manage");
          if (type.scope !== "company")
            throw new NotFoundException("Compliance item type not found");
        } else {
          requireWritable(caller, projectId);
          requirePermission(
            caller.canManage(projectId),
            "documents.manage is required on the project",
          );
          if (type.scope === "company")
            throw documentsProblem(
              409,
              "invalid-transition",
              "A company item is recorded once for the company, not on a project",
            );
        }
        if (!type.active)
          throw documentsProblem(409, "compliance-type-retired", "This item type is retired");
        const today = complianceToday();
        if (input.kind === "record") {
          const problem = complianceDatesProblem(
            {
              issuedOn: input.issuedOn ?? null,
              expiresOn: input.expiresOn ?? null,
              expires: type.expires,
            },
            today,
          );
          if (problem)
            throw documentsProblem(
              422,
              problem,
              problem === "compliance-issued-future"
                ? "The issue date cannot be in the future"
                : problem === "compliance-expiry-required"
                  ? "This item expires: enter its expiry date"
                  : "The expiry date cannot be before the issue date",
            );
        }
        const { tx, access } = scope;
        if (input.evidenceVersionId) {
          const linked = (await linkedVersions(tx, access.tenantId, [input.evidenceVersionId])).get(
            input.evidenceVersionId,
          );
          if (
            !linked ||
            !canSeeLinked(caller, linked) ||
            (projectId !== null && linked.projectId !== projectId)
          )
            throw documentsProblem(
              422,
              "evidence-not-found",
              "Evidence must be a document version of this project that you can see",
            );
        }
        const current = await tx.complianceRecord.findFirst({
          where: { tenantId: access.tenantId, typeId: type.id, projectId, isCurrent: true },
          select: { id: true },
        });
        if ((current?.id ?? null) !== input.supersedesId)
          throw documentsProblem(
            409,
            "compliance-stale",
            "This item was recorded by someone else meanwhile. Reload and try again.",
          );
        const id = uuidv7();
        await tx.complianceRecord.create({
          data: {
            id,
            tenantId: access.tenantId,
            typeId: type.id,
            projectId,
            kind: input.kind,
            referenceNo: input.kind === "record" ? (input.referenceNo ?? null) : null,
            issuer: input.kind === "record" ? (input.issuer ?? null) : null,
            issuedOn:
              input.kind === "record" && input.issuedOn ? fromCalendarDate(input.issuedOn) : null,
            expiresOn:
              input.kind === "record" && input.expiresOn ? fromCalendarDate(input.expiresOn) : null,
            evidenceVersionId: input.kind === "record" ? (input.evidenceVersionId ?? null) : null,
            notes: input.notes ?? null,
            reason: input.kind === "not_applicable" ? (input.reason ?? null) : null,
            supersedesId: input.supersedesId,
            recordedBy: access.userId,
          },
        });
        await this.scope.audit(tx, "compliance.recorded", id, {
          projectId,
          typeId: type.id,
          typeKey: type.key,
          kind: input.kind,
          renewal: input.supersedesId !== null,
          evidence: Boolean(input.evidenceVersionId),
        });
        return this.historyOf(scope, caller, projectId, type.id);
      },
      true,
    );
  }

  // Item types ------------------------------------------------------------------------------------

  types(principal: Principal, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const caller = await this.access.anyReader(scope);
      await this.ensureTypes(scope);
      const rows = await scope.tx.complianceType.findMany({
        where: { tenantId: scope.access.tenantId },
        orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
      });
      return complianceTypesResponseSchema.parse({
        types: rows.map(toType),
        permissions: { canConfigure: caller.canConfigure },
      });
    });
  }

  createType(principal: Principal, input: CreateComplianceTypeRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const caller = await this.access.caller(scope);
        if (!caller.canConfigure) throw new ForbiddenException("config.manage is required");
        await this.ensureTypes(scope);
        const { tx, access } = scope;
        const rows = await tx.complianceType.findMany({
          where: { tenantId: access.tenantId },
          select: { key: true, sortOrder: true },
        });
        if (rows.length >= COMPLIANCE_LIMITS.maxTypes)
          throw documentsProblem(
            409,
            "compliance-type-limit",
            `A company keeps at most ${COMPLIANCE_LIMITS.maxTypes} item types`,
          );
        const highest = rows.reduce((max, row) => {
          const match = /^custom_(\d+)$/.exec(row.key);
          return match ? Math.max(max, Number(match[1])) : max;
        }, 0);
        const row = await tx.complianceType.create({
          data: {
            id: uuidv7(),
            tenantId: access.tenantId,
            key: `custom_${highest + 1}`,
            label: input.label,
            starter: false,
            scope: input.scope,
            expires: input.expires,
            reminderDays: input.reminderDays,
            sortOrder: Math.max(...rows.map((entry) => entry.sortOrder), 0) + 10,
            createdBy: access.userId,
            updatedBy: access.userId,
          },
        });
        await this.scope.audit(tx, "compliance.type_created", row.id, {
          key: row.key,
          scope: row.scope,
          expires: row.expires,
          reminderDays: row.reminderDays,
        });
        return complianceTypeResponseSchema.parse({ type: toType(row) });
      },
      true,
    );
  }

  updateType(
    principal: Principal,
    typeId: string,
    input: UpdateComplianceTypeRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const caller = await this.access.caller(scope);
        if (!caller.canConfigure) throw new ForbiddenException("config.manage is required");
        const row = await this.typeRow(scope, typeId);
        if (row.version !== input.version) throw versionConflict();
        if (row.starter && input.label !== undefined)
          throw documentsProblem(
            422,
            "invalid-transition",
            "Starter items keep their translated names; add your own item instead",
          );
        const { version, ...fields } = input;
        const updated = await scope.tx.complianceType.updateMany({
          where: { tenantId: scope.access.tenantId, id: typeId, version },
          data: {
            ...(fields.label !== undefined ? { label: fields.label } : {}),
            ...(fields.expires !== undefined ? { expires: fields.expires } : {}),
            ...(fields.reminderDays !== undefined ? { reminderDays: fields.reminderDays } : {}),
            ...(fields.active !== undefined ? { active: fields.active } : {}),
            version: { increment: 1 },
            updatedBy: scope.access.userId,
          },
        });
        if (!updated.count) throw versionConflict();
        await this.scope.audit(scope.tx, "compliance.type_updated", typeId, {
          key: row.key,
          fields: changedFields(fields),
          ...(fields.active !== undefined && fields.active !== row.active
            ? { active: fields.active }
            : {}),
        });
        return complianceTypeResponseSchema.parse({
          type: toType(await this.typeRow(scope, typeId)),
        });
      },
      true,
    );
  }

  /** The register for an export (same rules as the screen). */
  async exportData(scope: Scope, caller: DocumentsCaller, projectId: string) {
    const project = caller.projects.get(projectId)!;
    const facts = await this.facts(scope, [projectId]);
    const items = this.items(facts, caller, projectId);
    return {
      project: { id: project.id, code: project.code, name: project.name },
      today: facts.today,
      items,
      counts: complianceCounts(items.map((item) => item.status)),
    };
  }
}
