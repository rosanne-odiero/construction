import { PERMISSIONS, type Permission } from "@pm-buddy/types";
import type { GeofenceVersion, Milestone, Project, Site, WbsNode } from "@pm-buddy/validation";
import type { Prisma } from "../../generated/prisma/client.js";

/** Business dates are calendar dates: `date` columns arrive as UTC midnight. */
export const toCalendarDate = (value: Date): string => value.toISOString().slice(0, 10);
export const fromCalendarDate = (value: string): Date => new Date(`${value}T00:00:00.000Z`);
const optionalDate = (value: Date | null) => (value ? toCalendarDate(value) : null);
const optionalNumber = (value: Prisma.Decimal | null) => (value === null ? null : value.toNumber());

export type ProjectRow = Prisma.ProjectGetPayload<object>;
export type SiteGeofenceRow = Prisma.SiteGeofenceGetPayload<object>;
export type SiteRow = Prisma.SiteGetPayload<object>;
export type WbsNodeRow = Prisma.WbsNodeGetPayload<object>;
export type MilestoneRow = Prisma.MilestoneGetPayload<object>;

export function toProject(row: ProjectRow): Project {
  const contractSum = row.contractSumMinor === null ? null : Number(row.contractSumMinor);
  if (contractSum !== null && !Number.isSafeInteger(contractSum))
    throw new RangeError("Contract sum out of the safe integer range");
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    clientName: row.clientName,
    clientEmail: row.clientEmail,
    clientPhone: row.clientPhone,
    contractSumMinor: contractSum,
    currency: "KES",
    contractType: row.contractType as Project["contractType"],
    startDate: optionalDate(row.startDate),
    endDate: optionalDate(row.endDate),
    county: row.county as Project["county"],
    town: row.town,
    latitude: optionalNumber(row.latitude),
    longitude: optionalNumber(row.longitude),
    status: row.status as Project["status"],
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toGeofenceVersion(row: SiteGeofenceRow): GeofenceVersion {
  const geofence: GeofenceVersion["geofence"] =
    row.kind === "radius"
      ? {
          kind: "radius",
          center: {
            lat: optionalNumber(row.centerLat) ?? 0,
            lng: optionalNumber(row.centerLng) ?? 0,
          },
          radiusM: row.radiusM ?? 0,
        }
      : { kind: "polygon", vertices: row.polygon as { lat: number; lng: number }[] };
  return {
    id: row.id,
    version: row.version,
    effectiveFrom: row.effectiveFrom.toISOString(),
    areaM2: row.areaM2.toNumber(),
    perimeterM: row.perimeterM.toNumber(),
    geofence,
  };
}

export function toSite(row: SiteRow, current: SiteGeofenceRow): Site {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    geofence: toGeofenceVersion(current),
  };
}

export function toWbsNode(row: WbsNodeRow): WbsNode {
  return {
    id: row.id,
    parentId: row.parentId,
    code: row.code,
    name: row.name,
    sortOrder: row.sortOrder,
    weightBasisPoints: row.weightBasisPoints,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toMilestone(row: MilestoneRow): Milestone {
  return {
    id: row.id,
    wbsNodeId: row.wbsNodeId,
    name: row.name,
    dueDate: toCalendarDate(row.dueDate),
    status: row.status as Milestone["status"],
    actualDate: optionalDate(row.actualDate),
    statusReason: row.statusReason,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** A permission set in catalogue order, for stable responses. */
export const inCatalogueOrder = (permissions: ReadonlySet<Permission>): Permission[] =>
  PERMISSIONS.filter((permission) => permissions.has(permission));
