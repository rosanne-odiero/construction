import { Injectable } from "@nestjs/common";
import type { Request } from "express";
import { activationGaps, checkProjectTransition, type ActivationFacts } from "@pm-buddy/domain";
import { PROJECT_ASSIGNABLE_PERMISSIONS, type ProjectStatus } from "@pm-buddy/types";
import {
  projectDetailResponseSchema,
  projectResponseSchema,
  projectsResponseSchema,
  type CreateProjectInput,
  type ProjectListQuery,
  type ProjectStatusRequest,
  type UpdateProjectInput,
} from "@pm-buddy/validation";
import { isUniqueViolation } from "../../common/database-errors.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { AccessPolicy, type Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { badRequest, conflict, ProjectAccess, versionConflict } from "./project-access.js";
import {
  fromCalendarDate,
  inCatalogueOrder,
  toProject,
  type ProjectRow,
} from "./project-mappers.js";

type Tx = Prisma.TransactionClient;
const AUTO_CODE = /^PRJ-(\d{1,16})$/;

/** Field names (never values) for audit summaries: client details and sums stay out of the log. */
const changedFields = (input: object) =>
  Object.entries(input)
    .filter(([key, value]) => key !== "version" && value !== undefined)
    .map(([key]) => key)
    .sort();

/** Drops keys whose value is undefined ("not supplied"), keeping explicit nulls ("clear"). */
const supplied = <T extends object>(input: T): Partial<T> =>
  Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Partial<T>;

type ProjectColumns = {
  code?: string;
  name?: string;
  description?: string | null;
  clientName?: string | null;
  clientEmail?: string | null;
  clientPhone?: string | null;
  contractSumMinor?: bigint | null;
  contractType?: string | null;
  startDate?: Date | null;
  endDate?: Date | null;
  county?: string | null;
  town?: string | null;
  latitude?: number | null;
  longitude?: number | null;
};

function projectData(input: Omit<UpdateProjectInput, "version">): ProjectColumns {
  const data: ProjectColumns = {};
  if (input.code !== undefined) data.code = input.code;
  if (input.name !== undefined) data.name = input.name;
  if (input.description !== undefined) data.description = input.description;
  if (input.clientName !== undefined) data.clientName = input.clientName;
  if (input.clientEmail !== undefined) data.clientEmail = input.clientEmail;
  if (input.clientPhone !== undefined) data.clientPhone = input.clientPhone;
  if (input.contractSumMinor !== undefined)
    data.contractSumMinor = input.contractSumMinor === null ? null : BigInt(input.contractSumMinor);
  if (input.contractType !== undefined) data.contractType = input.contractType;
  if (input.startDate !== undefined)
    data.startDate = input.startDate === null ? null : fromCalendarDate(input.startDate);
  if (input.endDate !== undefined)
    data.endDate = input.endDate === null ? null : fromCalendarDate(input.endDate);
  if (input.county !== undefined) data.county = input.county;
  if (input.town !== undefined) data.town = input.town;
  if (input.latitude !== undefined) data.latitude = input.latitude;
  if (input.longitude !== undefined) data.longitude = input.longitude;
  return data;
}

/**
 * Projects (D2.1): list, create, read, update and lifecycle transitions. Every operation runs in
 * the caller's company transaction (TenantScope) and authorises through AccessPolicy.
 */
@Injectable()
export class ProjectsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly policy: AccessPolicy,
    private readonly access: ProjectAccess,
  ) {}

  list(principal: Principal, query: ProjectListQuery, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const filters: Prisma.ProjectWhereInput[] = [
        this.policy.projectWhere(scope, "projects.view"),
      ];
      if (query.status) filters.push({ status: query.status });
      if (query.search) {
        const contains = { contains: query.search, mode: "insensitive" as const };
        filters.push({
          OR: [
            { code: contains },
            { name: contains },
            { clientName: contains },
            { town: contains },
          ],
        });
      }
      const rows = await scope.tx.project.findMany({
        where: { AND: filters },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      return projectsResponseSchema.parse({ projects: rows.map(toProject) });
    });
  }

  create(principal: Principal, input: CreateProjectInput, req: Request) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { tx, access } = scope;
          await this.policy.require(scope, "projects.create", { stepUp: true });
          const code = input.code ?? (await this.nextCode(tx, access.tenantId));
          const { code: _code, ...fields } = input;
          const row = await tx.project.create({
            data: {
              ...projectData(fields),
              tenantId: access.tenantId,
              code,
              name: input.name,
              createdBy: access.userId,
            },
          });
          // A creator without a company-wide role keeps access through an assignment carrying
          // their role's project permissions (nothing beyond what the role already grants).
          if (!access.tenantWide) {
            const permissions = PROJECT_ASSIGNABLE_PERMISSIONS.filter((permission) =>
              access.permissions.has(permission),
            );
            await tx.projectMembership.create({
              data: {
                tenantId: access.tenantId,
                projectId: row.id,
                userId: access.userId,
                permissions,
              },
            });
          }
          await this.scope.audit(tx, "project.created", row.id, {
            code,
            fields: changedFields(fields),
          });
          return projectResponseSchema.parse({ project: toProject(row) });
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error))
          throw conflict("project-code-taken", "Another project in this company uses this code");
        throw error;
      });
  }

  get(principal: Principal, projectId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const { project, effective } = await this.access.load(scope, projectId, "projects.view");
      const facts = await this.facts(scope, project);
      const changes = await scope.tx.projectStatusChange.findMany({
        where: { tenantId: scope.access.tenantId, projectId },
        orderBy: { changedAt: "desc" },
        take: 50,
      });
      const names = await this.displayNames(
        scope.tx,
        changes.map((change) => change.changedBy),
      );
      return projectDetailResponseSchema.parse({
        project: toProject(project),
        permissions: inCatalogueOrder(effective),
        siteCount: facts.geofencedSites,
        activationGaps: project.status === "planning" ? activationGaps(facts) : [],
        history: changes.map((change) => ({
          from: change.fromStatus,
          to: change.toStatus,
          reason: change.reason,
          changedAt: change.changedAt.toISOString(),
          changedBy: { id: change.changedBy, displayName: names.get(change.changedBy) ?? "—" },
        })),
      });
    });
  }

  update(principal: Principal, projectId: string, input: UpdateProjectInput, req: Request) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const { project } = await this.access.editable(scope, projectId);
          if (project.version !== input.version) throw versionConflict();
          const { version, ...fields } = input;
          if (
            fields.code !== undefined &&
            fields.code !== project.code &&
            project.status !== "planning"
          )
            throw conflict(
              "project-code-fixed",
              "The project code is fixed once the project leaves planning",
            );
          const merged = { ...toProject(project), ...supplied(fields) };
          if (merged.startDate && merged.endDate && merged.endDate < merged.startDate)
            throw badRequest("end-before-start", "The end date must be on or after the start date");
          if (
            project.status !== "planning" &&
            activationGaps({ ...merged, geofencedSites: 1 }).length
          )
            throw conflict(
              "activation-details-required",
              "Client, contract and location details stay required once a project has started",
            );
          const updated = await scope.tx.project.updateMany({
            where: { tenantId: scope.access.tenantId, id: projectId, version },
            data: { ...projectData(fields), version: { increment: 1 } },
          });
          if (!updated.count) throw versionConflict();
          await this.scope.audit(scope.tx, "project.updated", projectId, {
            fields: changedFields(fields),
            version: version + 1,
          });
          const row = await scope.tx.project.findUniqueOrThrow({
            where: { tenantId_id: { tenantId: scope.access.tenantId, id: projectId } },
          });
          return projectResponseSchema.parse({ project: toProject(row) });
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error))
          throw conflict("project-code-taken", "Another project in this company uses this code");
        throw error;
      });
  }

  changeStatus(principal: Principal, projectId: string, input: ProjectStatusRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { project } = await this.access.load(scope, projectId, "projects.manage");
        if (project.version !== input.version) throw versionConflict();
        const reason = input.reason?.trim() || null;
        const check = checkProjectTransition({
          from: project.status as ProjectStatus,
          to: input.to,
          reason,
          facts: await this.facts(scope, project),
        });
        if (!check.ok) {
          if (check.error === "reason_required")
            throw badRequest("reason-required", "A reason is required for this change");
          if (check.error === "activation_incomplete")
            throw conflict(
              "activation-incomplete",
              `Complete these before activating: ${check.missing.join(", ")}`,
            );
          throw conflict(
            "invalid-transition",
            `A project cannot move from ${project.status} to ${input.to}`,
          );
        }
        const updated = await scope.tx.project.updateMany({
          where: { tenantId: scope.access.tenantId, id: projectId, version: input.version },
          data: { status: input.to, version: { increment: 1 } },
        });
        if (!updated.count) throw versionConflict();
        await scope.tx.projectStatusChange.create({
          data: {
            tenantId: scope.access.tenantId,
            projectId,
            fromStatus: project.status,
            toStatus: input.to,
            reason,
            changedBy: scope.access.userId,
          },
        });
        // The reason is free text (it may name people), so the audit log records only that one
        // was given; the project history keeps it for project members.
        await this.scope.audit(scope.tx, "project.status_changed", projectId, {
          from: project.status,
          to: input.to,
          action: check.transition.action,
          reasonGiven: reason !== null,
        });
        const row = await scope.tx.project.findUniqueOrThrow({
          where: { tenantId_id: { tenantId: scope.access.tenantId, id: projectId } },
        });
        return projectResponseSchema.parse({ project: toProject(row) });
      },
      true,
    );
  }

  /** The next free PRJ-NNN code in the company (the tenant lock serialises concurrent creates). */
  private async nextCode(tx: Tx, tenantId: string): Promise<string> {
    const rows = await tx.project.findMany({
      where: { tenantId, code: { startsWith: "PRJ-" } },
      select: { code: true },
    });
    const highest = rows.reduce((max, { code }) => {
      const match = AUTO_CODE.exec(code);
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0);
    const next = String(highest + 1);
    return `PRJ-${next.padStart(3, "0")}`;
  }

  private async facts(scope: Scope, project: ProjectRow): Promise<ActivationFacts> {
    const sites = await scope.tx.site.count({
      where: { tenantId: scope.access.tenantId, projectId: project.id, geofences: { some: {} } },
    });
    const wire = toProject(project);
    return {
      clientName: wire.clientName,
      contractSumMinor: wire.contractSumMinor,
      contractType: wire.contractType,
      startDate: wire.startDate,
      endDate: wire.endDate,
      county: wire.county,
      town: wire.town,
      geofencedSites: sites,
    };
  }

  private async displayNames(tx: Tx, ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const users = await tx.user.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, displayName: true },
    });
    return new Map(users.map((user) => [user.id, user.displayName]));
  }
}
