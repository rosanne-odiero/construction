import { Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import { geofenceMetrics, type Geofence } from "@pm-buddy/domain";
import {
  geofenceHistoryResponseSchema,
  siteResponseSchema,
  sitesResponseSchema,
} from "@pm-buddy/validation";
import { isUniqueViolation } from "../../common/database-errors.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { conflict, ProjectAccess, versionConflict } from "./project-access.js";
import { toGeofenceVersion, toSite, type SiteGeofenceRow } from "./project-mappers.js";

type Tx = Prisma.TransactionClient;

/** Column values for a new geofence version; version and effective_from come from the database. */
function geofenceColumns(geofence: Geofence) {
  const metrics = geofenceMetrics(geofence);
  const measures = {
    areaM2: Math.round(metrics.areaM2 * 10) / 10,
    perimeterM: Math.round(metrics.perimeterM * 10) / 10,
  };
  return geofence.kind === "radius"
    ? {
        kind: "radius",
        centerLat: geofence.center.lat,
        centerLng: geofence.center.lng,
        radiusM: geofence.radiusM,
        ...measures,
      }
    : {
        kind: "polygon",
        polygon: geofence.vertices.map(({ lat, lng }) => ({ lat, lng })),
        ...measures,
      };
}

const siteNameTaken = () =>
  conflict("site-name-taken", "This project already has a site with this name");

/**
 * Sites and their versioned geofences (D2.1). A geofence change appends a new version; earlier
 * versions are never modified, so attendance (D3.3) can evaluate the version in force at capture.
 */
@Injectable()
export class SitesService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: ProjectAccess,
  ) {}

  list(principal: Principal, projectId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      await this.access.load(scope, projectId, "projects.view");
      const sites = await scope.tx.site.findMany({
        where: { tenantId: scope.access.tenantId, projectId },
        include: { geofences: { orderBy: { version: "desc" }, take: 1 } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      return sitesResponseSchema.parse({
        sites: sites.map(({ geofences, ...site }) => toSite(site, geofences[0]!)),
      });
    });
  }

  create(
    principal: Principal,
    projectId: string,
    input: { name: string; address?: string | null; geofence: Geofence },
    req: Request,
  ) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          await this.access.editable(scope, projectId);
          const { tx, access } = scope;
          const site = await tx.site.create({
            data: {
              tenantId: access.tenantId,
              projectId,
              name: input.name,
              address: input.address ?? null,
              createdBy: access.userId,
            },
          });
          const geofence = await tx.siteGeofence.create({
            data: {
              tenantId: access.tenantId,
              siteId: site.id,
              createdBy: access.userId,
              ...geofenceColumns(input.geofence),
            },
          });
          await this.scope.audit(tx, "site.created", site.id, {
            projectId,
            geofence: { version: geofence.version, kind: geofence.kind },
          });
          return siteResponseSchema.parse({ site: toSite(site, geofence) });
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw siteNameTaken();
        throw error;
      });
  }

  update(
    principal: Principal,
    projectId: string,
    siteId: string,
    input: { name?: string; address?: string | null; version: number },
    req: Request,
  ) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          await this.access.editable(scope, projectId);
          const site = await this.site(scope, projectId, siteId);
          if (site.version !== input.version) throw versionConflict();
          const data: Prisma.SiteUncheckedUpdateManyInput = { version: { increment: 1 } };
          if (input.name !== undefined) data.name = input.name;
          if (input.address !== undefined) data.address = input.address;
          const updated = await scope.tx.site.updateMany({
            where: {
              tenantId: scope.access.tenantId,
              projectId,
              id: siteId,
              version: input.version,
            },
            data,
          });
          if (!updated.count) throw versionConflict();
          await this.scope.audit(scope.tx, "site.updated", siteId, {
            projectId,
            fields: ["name", "address"].filter(
              (key) => input[key as "name" | "address"] !== undefined,
            ),
          });
          const row = await this.site(scope, projectId, siteId);
          return siteResponseSchema.parse({
            site: toSite(row, await this.current(scope.tx, scope.access.tenantId, siteId)),
          });
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw siteNameTaken();
        throw error;
      });
  }

  /** Appends a new geofence version. `currentVersion` must still be the newest (else 409). */
  changeGeofence(
    principal: Principal,
    projectId: string,
    siteId: string,
    input: { geofence: Geofence; currentVersion: number },
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        await this.access.editable(scope, projectId);
        const { tx, access } = scope;
        const site = await this.site(scope, projectId, siteId);
        const previous = await this.current(tx, access.tenantId, siteId);
        if (previous.version !== input.currentVersion) throw versionConflict();
        const geofence = await tx.siteGeofence.create({
          data: {
            tenantId: access.tenantId,
            siteId,
            createdBy: access.userId,
            ...geofenceColumns(input.geofence),
          },
        });
        await this.scope.audit(tx, "site.geofence_changed", siteId, {
          projectId,
          previousVersion: previous.version,
          version: geofence.version,
          kind: geofence.kind,
        });
        return siteResponseSchema.parse({ site: toSite(site, geofence) });
      },
      true,
    );
  }

  /**
   * Every geofence version of a site, newest first; with `at`, only the version in force at that
   * moment (none before the site existed).
   */
  history(principal: Principal, projectId: string, siteId: string, at: Date | null, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      await this.access.load(scope, projectId, "projects.view");
      await this.site(scope, projectId, siteId);
      const where: Prisma.SiteGeofenceWhereInput = { tenantId: scope.access.tenantId, siteId };
      // Wire timestamps resolve to the millisecond: `at` covers its whole millisecond.
      if (at) where.effectiveFrom = { lt: new Date(at.getTime() + 1) };
      const versions = await scope.tx.siteGeofence.findMany({
        where,
        orderBy: { version: "desc" },
        ...(at ? { take: 1 } : {}),
      });
      return geofenceHistoryResponseSchema.parse({ versions: versions.map(toGeofenceVersion) });
    });
  }

  private async site(scope: Scope, projectId: string, siteId: string) {
    const site = await scope.tx.site.findFirst({
      where: { tenantId: scope.access.tenantId, projectId, id: siteId },
    });
    if (!site) throw new NotFoundException("Site not found");
    return site;
  }

  private async current(tx: Tx, tenantId: string, siteId: string): Promise<SiteGeofenceRow> {
    const current = await tx.siteGeofence.findFirst({
      where: { tenantId, siteId },
      orderBy: { version: "desc" },
    });
    if (!current) throw new NotFoundException("Site geofence not found");
    return current;
  }
}
