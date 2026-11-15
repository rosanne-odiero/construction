import { ForbiddenException, Injectable } from "@nestjs/common";
import type { Permission } from "@pm-buddy/types";
import { workerPortalResponseSchema } from "@pm-buddy/validation";
import type { Request } from "express";
import type { Prisma } from "../../generated/prisma/client.js";
import { AccessPolicy, type Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { toProject } from "../projects/project-mappers.js";

type ProjectRow = Prisma.ProjectGetPayload<object>;

const portalProject = (row: ProjectRow) => {
  const project = toProject(row);
  return {
    id: project.id,
    code: project.code,
    name: project.name,
    status: project.status,
    county: project.county,
    town: project.town,
  };
};

/**
 * Read-only data for the labourer portal (the client portal is in ./client, D7.1). Access is the
 * role's portal permission (role ∩ project assignment, so a labourer sees only assigned projects)
 * and every response is a curated view, not the office API's full records.
 */
@Injectable()
export class PortalsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly policy: AccessPolicy,
  ) {}

  worker(principal: Principal, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      this.requirePortal(scope, "portal.worker");
      const [company, rows] = await Promise.all([
        this.company(scope),
        scope.tx.project.findMany({
          where: this.policy.projectWhere(scope, "portal.worker"),
          include: {
            sites: { select: { id: true, name: true, address: true }, orderBy: { name: "asc" } },
          },
          orderBy: { name: "asc" },
        }),
      ]);
      return workerPortalResponseSchema.parse({
        displayName: principal.user.displayName,
        company,
        assignments: rows.map(({ sites, ...row }) => ({ project: portalProject(row), sites })),
        attendance: null,
        pay: null,
      });
    });
  }

  private requirePortal(scope: Scope, permission: Permission) {
    if (!scope.access.permissions.has(permission))
      throw new ForbiddenException(`Permission required: ${permission}`);
  }

  private company(scope: Scope) {
    return scope.tx.tenant.findUniqueOrThrow({
      where: { id: scope.access.tenantId },
      select: { id: true, name: true },
    });
  }
}
