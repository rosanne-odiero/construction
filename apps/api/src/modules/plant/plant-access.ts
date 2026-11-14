import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { calendarDaysBetween, isProjectReadOnly, nairobiDate } from "@pm-buddy/domain";
import {
  DEFAULT_PLANT_SETTINGS,
  PLANT_COST_PERMISSIONS,
  PLANT_FUEL_PERMISSIONS,
  PLANT_READ_PERMISSIONS,
  PLANT_RECORD_PERMISSIONS,
  type Permission,
  type PlantCategory,
  type ProjectStatus,
} from "@pm-buddy/types";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import { effectiveProjectPermissions } from "../identity/role-grants.js";
import { versionConflict } from "../projects/project-access.js";

type Tx = Prisma.TransactionClient;

/** Stable problem codes for the plant module (the web maps them to EN/SW messages). */
export type PlantProblem =
  | "project-read-only"
  | "invalid-transition"
  | "plant-code-taken"
  | "plant-closed"
  | "plant-not-on-site"
  | "plant-not-metered"
  | "plant-no-fuel"
  | "plant-unsafe"
  | "plant-has-open-breakdowns"
  | "plant-date-future"
  | "plant-date-too-old"
  | "meter-out-of-order"
  | "meter-day-limit"
  | "meter-reset-order"
  | "usage-day-exists"
  | "record-superseded"
  | "record-already-void"
  | "operator-not-assigned"
  | "operator-overlap"
  | "labourer-not-on-project"
  | "person-not-in-company"
  | "move-strands-records"
  | "move-same-place"
  | "breakdown-resolution-invalid"
  | "supplier-not-found"
  | "lpo-not-found"
  | "bq-item-not-found"
  | "cost-code-not-found"
  | "idempotency-key-required"
  | "idempotency-key-reused"
  | "usage-id-conflict"
  | "fuel-id-conflict"
  | "plant-rule";

export function plantProblem(
  status: 400 | 403 | 404 | 409 | 422,
  code: PlantProblem,
  message: string,
  extra: Record<string, unknown> = {},
): HttpException {
  const body = { code, message, ...extra };
  if (status === 403) return new ForbiddenException(body);
  if (status === 404) return new NotFoundException(body);
  if (status === 409) return new ConflictException(body);
  return new HttpException(
    body,
    status === 400 ? HttpStatus.BAD_REQUEST : HttpStatus.UNPROCESSABLE_ENTITY,
  );
}

export { versionConflict };

const hasAny = (effective: ReadonlySet<Permission>, permissions: readonly Permission[]) =>
  permissions.some((permission) => effective.has(permission));

export type PlantProject = {
  id: string;
  code: string;
  name: string;
  status: string;
  readOnly: boolean;
  effective: ReadonlySet<Permission>;
};

/**
 * The caller's plant permissions on every project of the company (role ∩ assignment), computed
 * once per request with the same rules as the actions (decision D-90).
 */
export class PlantCaller {
  constructor(
    readonly userId: string,
    readonly tenantWide: boolean,
    private readonly role: ReadonlySet<Permission>,
    readonly projects: ReadonlyMap<string, PlantProject>,
  ) {}

  private has(projectId: string | null, test: (effective: ReadonlySet<Permission>) => boolean) {
    const project = projectId ? this.projects.get(projectId) : undefined;
    return project ? test(project.effective) : false;
  }
  private writable(projectId: string | null) {
    const project = projectId ? this.projects.get(projectId) : undefined;
    return project ? !project.readOnly : false;
  }
  private somewhere(test: (effective: ReadonlySet<Permission>) => boolean) {
    if (this.tenantWide && test(this.role)) return true;
    return [...this.projects.values()].some((project) => test(project.effective));
  }

  /** projects.view plus one of PLANT_READ_PERMISSIONS on the project. */
  canRead(projectId: string | null) {
    return this.has(
      projectId,
      (effective) => effective.has("projects.view") && hasAny(effective, PLANT_READ_PERMISSIONS),
    );
  }
  canRecord(projectId: string | null) {
    return (
      this.canRead(projectId) &&
      this.writable(projectId) &&
      this.has(projectId, (effective) => hasAny(effective, PLANT_RECORD_PERMISSIONS))
    );
  }
  canFuel(projectId: string | null) {
    return (
      this.canRead(projectId) &&
      this.writable(projectId) &&
      this.has(projectId, (effective) => hasAny(effective, PLANT_FUEL_PERMISSIONS))
    );
  }
  /** plant.manage on the project (a closed project's plant can still be moved off it). */
  holdsManage(projectId: string | null) {
    return this.has(projectId, (effective) => effective.has("plant.manage"));
  }
  canManage(projectId: string | null) {
    return this.holdsManage(projectId) && this.writable(projectId);
  }
  canSeeCostOn(projectId: string | null) {
    return this.has(projectId, (effective) => hasAny(effective, PLANT_COST_PERMISSIONS));
  }
  get readSomewhere() {
    return this.somewhere(
      (effective) => effective.has("projects.view") && hasAny(effective, PLANT_READ_PERMISSIONS),
    );
  }
  get manageSomewhere() {
    return this.somewhere((effective) => effective.has("plant.manage"));
  }
  get costSomewhere() {
    return this.somewhere((effective) => hasAny(effective, PLANT_COST_PERMISSIONS));
  }
  /** Register-level management of an item: on its project, or anywhere while it is in the yard. */
  canManageItem(item: { projectId: string | null }) {
    return item.projectId ? this.holdsManage(item.projectId) : this.manageSomewhere;
  }
}

/**
 * Plant access (ARCHITECTURE §4.11, decision D-90): the register is company-level and readable by
 * anyone who reads plant somewhere; site records (usage, fuel, breakdowns, operators, moves) are
 * shown only for projects the caller can read; recording needs site.diary or plant.manage (fuel
 * also stores.manage) on the site's project; register changes need plant.manage on the item's
 * project (or anywhere while it is in the yard); rates and estimates need a cost permission.
 */
@Injectable()
export class PlantAccess {
  async caller(scope: Scope): Promise<PlantCaller> {
    const { tx, access } = scope;
    const rows = await tx.project.findMany({
      where: { tenantId: access.tenantId },
      select: {
        id: true,
        code: true,
        name: true,
        status: true,
        members: { where: { userId: access.userId }, select: { permissions: true } },
      },
      orderBy: { code: "asc" },
    });
    const projects = new Map<string, PlantProject>();
    for (const row of rows) {
      const assigned = row.members[0]?.permissions ?? null;
      if (!access.tenantWide && assigned === null) continue;
      projects.set(row.id, {
        id: row.id,
        code: row.code,
        name: row.name,
        status: row.status,
        readOnly: isProjectReadOnly(row.status as ProjectStatus),
        effective: effectiveProjectPermissions(access, assigned),
      });
    }
    return new PlantCaller(access.userId, access.tenantWide, access.permissions, projects);
  }

  /** Any plant reader somewhere (403 otherwise). */
  async reader(scope: Scope): Promise<PlantCaller> {
    const caller = await this.caller(scope);
    if (!caller.readSomewhere)
      throw new ForbiddenException(
        `One of these permissions is required on a project: ${PLANT_READ_PERMISSIONS.join(", ")}`,
      );
    return caller;
  }
}

/** Refuses a change on a closed or cancelled project (409 project-read-only). */
export function requireWritable(caller: PlantCaller, projectId: string) {
  if (caller.projects.get(projectId)?.readOnly)
    throw plantProblem(409, "project-read-only", "Closed and cancelled projects are read-only");
}

/** Refuses a business date after today in Nairobi or older than `maxAgeDays`. */
export function requireRecentDate(date: string, maxAgeDays: number, today = nairobiDate()) {
  if (date > today)
    throw plantProblem(409, "plant-date-future", "This date cannot be in the future");
  if (calendarDaysBetween(date, today) > maxAgeDays)
    throw plantProblem(
      409,
      "plant-date-too-old",
      `Records can be back-dated by at most ${maxAgeDays} days`,
    );
}

/** Refuses a moment more than five minutes ahead of the server clock. */
export function requireNotFutureMoment(iso: string) {
  if (new Date(iso).getTime() > Date.now() + 5 * 60_000)
    throw plantProblem(409, "plant-date-future", "This time cannot be in the future");
}

/** The company's plant settings, or the defaults (version 0). */
export async function plantSettings(tx: Tx, tenantId: string) {
  const row = await tx.plantSettings.findUnique({ where: { tenantId } });
  return {
    fuelVariancePercent: row?.fuelVariancePercent ?? DEFAULT_PLANT_SETTINGS.fuelVariancePercent,
    fuelMinHours: row?.fuelMinHours ?? DEFAULT_PLANT_SETTINGS.fuelMinHours,
    fuelMinKm: row?.fuelMinKm ?? DEFAULT_PLANT_SETTINGS.fuelMinKm,
    idleHireDays: row?.idleHireDays ?? DEFAULT_PLANT_SETTINGS.idleHireDays,
    hireEndingDays: row?.hireEndingDays ?? DEFAULT_PLANT_SETTINGS.hireEndingDays,
    serviceDueSoonPercent:
      row?.serviceDueSoonPercent ?? DEFAULT_PLANT_SETTINGS.serviceDueSoonPercent,
    certificateCategories: (row?.certificateCategories ?? [
      ...DEFAULT_PLANT_SETTINGS.certificateCategories,
    ]) as PlantCategory[],
    version: row?.version ?? 0,
    updatedAt: row?.updatedAt ?? null,
  };
}
export type PlantSettingsValues = Awaited<ReturnType<typeof plantSettings>>;

/** Locks the item row so readings, moves and status changes on one item are serialised. */
export const lockPlant = (tx: Tx, tenantId: string, plantId: string) =>
  tx.$queryRaw`SELECT id FROM plant_items WHERE tenant_id = ${tenantId}::uuid AND id = ${plantId}::uuid FOR UPDATE`;

/** BRK-0001. */
export const breakdownCode = (number: number) => `BRK-${String(number).padStart(4, "0")}`;
