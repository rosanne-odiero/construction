import {
  ACTIVATION_REQUIREMENTS,
  FULL_WEIGHT_BP,
  KENYA_BOUNDS,
  normaliseGeofence,
  normalizeKenyanPhone,
  REASON_LIMITS,
  validateGeofence,
  type Geofence,
} from "@pm-buddy/domain";
import { CONTRACT_TYPES, COUNTY_KEYS, MILESTONE_STATUSES, PROJECT_STATUSES } from "@pm-buddy/types";
import { z } from "zod";
import { permissionSchema, projectPermissionSchema, roleReferenceSchema } from "./roles.js";

/**
 * Projects, sites, geofences, WBS, milestones and project teams (D2.1). Request schemas are
 * strict (unknown fields are refused, so a body can never carry a tenant or project ID) and
 * response schemas are strict (the web never trusts an unexpected shape).
 */

const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
/** A business calendar date (YYYY-MM-DD, Africa/Nairobi). */
const calendarDate = z.iso.date();
const version = z.number().int().min(1).max(2_147_483_647);

export const projectStatusSchema = z.enum(PROJECT_STATUSES);
export const contractTypeSchema = z.enum(CONTRACT_TYPES);
export const countySchema = z.enum(COUNTY_KEYS);
export const milestoneStatusSchema = z.enum(MILESTONE_STATUSES);
export const activationRequirementSchema = z.enum(ACTIVATION_REQUIREMENTS);

/** 2–20 characters: letters, digits and hyphens, stored in upper case (e.g. `RUI-HTS`). */
export const projectCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9-]{1,19}$/, "invalid_project_code");

/** Optional text: trimmed; an empty string clears the field (null). */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => (value === "" ? null : value));

/** Kenyan mobiles become 2547XXXXXXXX / 2541XXXXXXXX; other countries keep +<digits>. */
export const contactPhoneSchema = z
  .string()
  .trim()
  .max(32)
  .transform((value, ctx) => {
    const kenyan = normalizeKenyanPhone(value);
    if (kenyan) return kenyan;
    const digits = value.replace(/[\s().-]/g, "");
    if (/^\+[1-9]\d{7,14}$/.test(digits)) return digits;
    ctx.addIssue({ code: "custom", message: "invalid_phone" });
    return z.NEVER;
  });

const latitudeSchema = z.number().min(KENYA_BOUNDS.minLat).max(KENYA_BOUNDS.maxLat);
const longitudeSchema = z.number().min(KENYA_BOUNDS.minLng).max(KENYA_BOUNDS.maxLng);

const projectFields = {
  name: z.string().trim().min(1).max(150),
  description: optionalText(2000),
  clientName: optionalText(150),
  clientEmail: z
    .union([z.literal(""), z.email().max(254)])
    .nullable()
    .optional()
    .transform((value) =>
      value === "" ? null : typeof value === "string" ? value.toLowerCase() : value,
    ),
  clientPhone: z
    .union([z.literal(""), contactPhoneSchema])
    .nullable()
    .optional()
    .transform((value) => (value === "" ? null : value)),
  /** Contract sum in KES minor units (cents). */
  contractSumMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  contractType: contractTypeSchema.nullable().optional(),
  startDate: calendarDate.nullable().optional(),
  endDate: calendarDate.nullable().optional(),
  county: countySchema.nullable().optional(),
  town: optionalText(100),
  latitude: latitudeSchema.nullable().optional(),
  longitude: longitudeSchema.nullable().optional(),
};

type DatedLocated = {
  startDate?: string | null;
  endDate?: string | null;
  latitude?: number | null;
  longitude?: number | null;
};
/** End ≥ start; latitude and longitude are given (or cleared) together. */
function checkDatesAndLocation(value: DatedLocated, ctx: z.RefinementCtx) {
  if (value.startDate && value.endDate && value.endDate < value.startDate)
    ctx.addIssue({ code: "custom", path: ["endDate"], message: "end_before_start" });
  if ((value.latitude === undefined) !== (value.longitude === undefined))
    ctx.addIssue({ code: "custom", path: ["longitude"], message: "coordinates_incomplete" });
  else if ((value.latitude === null) !== (value.longitude === null))
    ctx.addIssue({ code: "custom", path: ["longitude"], message: "coordinates_incomplete" });
}

/** Only code and name are needed to start planning; activation needs the rest (see domain). */
export const createProjectRequestSchema = z
  .object({ code: projectCodeSchema.optional(), ...projectFields })
  .strict()
  .superRefine(checkDatesAndLocation);

export const updateProjectRequestSchema = z
  .object({
    code: projectCodeSchema.optional(),
    ...projectFields,
    name: projectFields.name.optional(),
    /** The version the client last read (optimistic concurrency). */
    version,
  })
  .strict()
  .superRefine((value, ctx) => {
    checkDatesAndLocation(value, ctx);
    const { version: _version, ...fields } = value;
    if (!Object.values(fields).some((field) => field !== undefined))
      ctx.addIssue({ code: "custom", message: "no_changes" });
  });

export const reasonSchema = z.string().trim().max(REASON_LIMITS.max);

export const projectStatusRequestSchema = z
  .object({ to: projectStatusSchema, reason: reasonSchema.optional(), version })
  .strict();

export const projectListQuerySchema = z
  .object({
    status: projectStatusSchema.optional(),
    search: z.string().trim().max(100).optional(),
  })
  .strict();

export const projectSchema = z
  .object({
    id: uuid,
    code: z.string().regex(/^[A-Z0-9][A-Z0-9-]{1,19}$/),
    name: z.string().min(1).max(150),
    description: z.string().max(2000).nullable(),
    clientName: z.string().max(150).nullable(),
    clientEmail: z.string().max(254).nullable(),
    clientPhone: z.string().max(32).nullable(),
    contractSumMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    currency: z.literal("KES"),
    contractType: contractTypeSchema.nullable(),
    startDate: calendarDate.nullable(),
    endDate: calendarDate.nullable(),
    county: countySchema.nullable(),
    town: z.string().max(100).nullable(),
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
    status: projectStatusSchema,
    version,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export const projectsResponseSchema = z.object({ projects: z.array(projectSchema) }).strict();
export const projectResponseSchema = z.object({ project: projectSchema }).strict();

const actor = z.object({ id: uuid, displayName: z.string().min(1).max(100) }).strict();
export const projectStatusChangeSchema = z
  .object({
    from: projectStatusSchema,
    to: projectStatusSchema,
    reason: z.string().max(REASON_LIMITS.max).nullable(),
    changedAt: timestamp,
    changedBy: actor,
  })
  .strict();

export const projectDetailResponseSchema = z
  .object({
    project: projectSchema,
    /** The caller's effective permissions on this project (role ∩ assignment). */
    permissions: z.array(permissionSchema),
    siteCount: z.number().int().min(0),
    /** What still blocks planning → active (empty when ready, or once past planning). */
    activationGaps: z.array(activationRequirementSchema),
    history: z.array(projectStatusChangeSchema),
  })
  .strict();

export const latLngSchema = z
  .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })
  .strict();

const geofenceShapeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("radius"), center: latLngSchema, radiusM: z.number().int() }).strict(),
  z.object({ kind: z.literal("polygon"), vertices: z.array(latLngSchema).max(500) }).strict(),
]);

/**
 * A geofence as submitted: coordinates are rounded to six decimals, then checked with the shared
 * domain rules. Each issue is reported with its stable code (see GEOFENCE_ISSUES) as the message.
 */
export const geofenceInputSchema = geofenceShapeSchema
  .transform((value): Geofence => normaliseGeofence(value))
  .superRefine((value, ctx) => {
    for (const issue of validateGeofence(value))
      ctx.addIssue({
        code: "custom",
        path: [
          value.kind === "radius"
            ? issue === "radius_out_of_range"
              ? "radiusM"
              : "center"
            : "vertices",
        ],
        message: issue,
      });
  });

/** A stored geofence version. Versions are append-only; the newest is in force. */
export const geofenceVersionSchema = z
  .object({
    id: uuid,
    version,
    /** When this version came into force (server time); attendance uses the version in force then. */
    effectiveFrom: timestamp,
    areaM2: z.number().min(0),
    perimeterM: z.number().min(0),
    geofence: geofenceShapeSchema,
  })
  .strict();

export const siteSchema = z
  .object({
    id: uuid,
    name: z.string().min(1).max(120),
    address: z.string().max(250).nullable(),
    version,
    createdAt: timestamp,
    updatedAt: timestamp,
    geofence: geofenceVersionSchema,
  })
  .strict();
export const sitesResponseSchema = z.object({ sites: z.array(siteSchema) }).strict();
export const siteResponseSchema = z.object({ site: siteSchema }).strict();
export const geofenceHistoryResponseSchema = z
  .object({ versions: z.array(geofenceVersionSchema) })
  .strict();

const siteName = z.string().trim().min(1).max(120);
export const createSiteRequestSchema = z
  .object({ name: siteName, address: optionalText(250), geofence: geofenceInputSchema })
  .strict();
export const updateSiteRequestSchema = z
  .object({ name: siteName.optional(), address: optionalText(250), version })
  .strict()
  .refine((value) => value.name !== undefined || value.address !== undefined, "no_changes");
export const changeGeofenceRequestSchema = z
  .object({
    geofence: geofenceInputSchema,
    /** The geofence version the editor started from; a newer one means someone else changed it. */
    currentVersion: version,
  })
  .strict();

export const wbsCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,29}$/, "invalid_wbs_code");
export const weightBasisPointsSchema = z.number().int().min(0).max(FULL_WEIGHT_BP);

export const wbsNodeSchema = z
  .object({
    id: uuid,
    parentId: uuid.nullable(),
    code: z.string().min(1).max(30),
    name: z.string().min(1).max(150),
    sortOrder: z.number().int().min(0),
    weightBasisPoints: weightBasisPointsSchema,
    version,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export const wbsResponseSchema = z
  .object({
    nodes: z.array(wbsNodeSchema),
    weights: z
      .object({
        /** Every sibling group sums to exactly 100 % (10,000 basis points). */
        complete: z.boolean(),
        groups: z.array(
          z
            .object({
              parentId: uuid.nullable(),
              sumBasisPoints: z.number().int().min(0),
              complete: z.boolean(),
            })
            .strict(),
        ),
      })
      .strict(),
    /** Weighted % complete as a ratio; null ("unavailable") until weights and measurements exist. */
    progress: z.number().min(0).max(1).nullable(),
  })
  .strict();
export const wbsNodeResponseSchema = z.object({ node: wbsNodeSchema }).strict();

const wbsName = z.string().trim().min(1).max(150);
export const createWbsNodeRequestSchema = z
  .object({
    parentId: uuid.nullable().optional(),
    code: wbsCodeSchema,
    name: wbsName,
    weightBasisPoints: weightBasisPointsSchema.default(0),
  })
  .strict();
export const updateWbsNodeRequestSchema = z
  .object({
    parentId: uuid.nullable().optional(),
    code: wbsCodeSchema.optional(),
    name: wbsName.optional(),
    weightBasisPoints: weightBasisPointsSchema.optional(),
    version,
  })
  .strict()
  .refine(
    ({ version: _version, ...fields }) =>
      Object.values(fields).some((field) => field !== undefined),
    "no_changes",
  );
export const reorderWbsRequestSchema = z
  .object({
    parentId: uuid.nullable(),
    nodeIds: z
      .array(uuid)
      .min(1)
      .max(200)
      .refine((ids) => new Set(ids).size === ids.length, "duplicate_ids"),
  })
  .strict();

export const milestoneSchema = z
  .object({
    id: uuid,
    wbsNodeId: uuid.nullable(),
    name: z.string().min(1).max(150),
    dueDate: calendarDate,
    status: milestoneStatusSchema,
    actualDate: calendarDate.nullable(),
    statusReason: z.string().max(REASON_LIMITS.max).nullable(),
    version,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export const milestonesResponseSchema = z.object({ milestones: z.array(milestoneSchema) }).strict();
export const milestoneResponseSchema = z.object({ milestone: milestoneSchema }).strict();

const milestoneName = z.string().trim().min(1).max(150);
export const createMilestoneRequestSchema = z
  .object({ name: milestoneName, dueDate: calendarDate, wbsNodeId: uuid.nullable().optional() })
  .strict();
export const updateMilestoneRequestSchema = z
  .object({
    name: milestoneName.optional(),
    dueDate: calendarDate.optional(),
    wbsNodeId: uuid.nullable().optional(),
    version,
  })
  .strict()
  .refine(
    ({ version: _version, ...fields }) =>
      Object.values(fields).some((field) => field !== undefined),
    "no_changes",
  );
export const milestoneStatusRequestSchema = z
  .object({
    to: milestoneStatusSchema,
    reason: reasonSchema.optional(),
    actualDate: calendarDate.optional(),
    version,
  })
  .strict();

/** PUT /projects/:id/members/:userId: the project permissions to assign (role ∩ assignment). */
export const projectAssignmentRequestSchema = z
  .object({
    permissions: z
      .array(projectPermissionSchema)
      .max(projectPermissionSchema.options.length)
      .refine((permissions) => new Set(permissions).size === permissions.length, "duplicates"),
  })
  .strict();

const roleName = z.string().min(1).max(60).nullable();
export const projectTeamResponseSchema = z
  .object({
    members: z.array(
      z
        .object({
          userId: uuid,
          displayName: z.string().min(1).max(100),
          role: roleReferenceSchema,
          roleName,
          /** A company-wide role acts on every project without an assignment. */
          companyWide: z.boolean(),
          /** The stored project assignment; null when access comes from a company-wide role. */
          assignment: z.array(projectPermissionSchema).nullable(),
          /** Effective project permissions: role ∩ assignment (or the role's, company-wide). */
          effective: z.array(permissionSchema),
        })
        .strict(),
    ),
    /** Company members without an assignment here (only for callers who may assign). */
    candidates: z.array(
      z
        .object({
          userId: uuid,
          displayName: z.string().min(1).max(100),
          role: roleReferenceSchema,
          roleName,
        })
        .strict(),
    ),
    /** Whether the caller may assign or remove members (users.invite + projects.manage). */
    canAssign: z.boolean(),
    /** The project permissions the caller may grant here (those they hold on this project). */
    grantable: z.array(projectPermissionSchema),
  })
  .strict();

export type ProjectStatusValue = z.infer<typeof projectStatusSchema>;
export type CreateProjectRequest = z.input<typeof createProjectRequestSchema>;
export type CreateProjectInput = z.output<typeof createProjectRequestSchema>;
export type UpdateProjectRequest = z.input<typeof updateProjectRequestSchema>;
export type UpdateProjectInput = z.output<typeof updateProjectRequestSchema>;
export type ProjectStatusRequest = z.infer<typeof projectStatusRequestSchema>;
export type ProjectListQuery = z.infer<typeof projectListQuerySchema>;
export type Project = z.infer<typeof projectSchema>;
export type ProjectsResponse = z.infer<typeof projectsResponseSchema>;
export type ProjectResponse = z.infer<typeof projectResponseSchema>;
export type ProjectDetailResponse = z.infer<typeof projectDetailResponseSchema>;
export type ProjectStatusChange = z.infer<typeof projectStatusChangeSchema>;
export type GeofenceInput = z.input<typeof geofenceInputSchema>;
export type GeofenceVersion = z.infer<typeof geofenceVersionSchema>;
export type Site = z.infer<typeof siteSchema>;
export type SitesResponse = z.infer<typeof sitesResponseSchema>;
export type SiteResponse = z.infer<typeof siteResponseSchema>;
export type GeofenceHistoryResponse = z.infer<typeof geofenceHistoryResponseSchema>;
export type CreateSiteRequest = z.input<typeof createSiteRequestSchema>;
export type UpdateSiteRequest = z.input<typeof updateSiteRequestSchema>;
export type ChangeGeofenceRequest = z.input<typeof changeGeofenceRequestSchema>;
export type WbsNode = z.infer<typeof wbsNodeSchema>;
export type WbsResponse = z.infer<typeof wbsResponseSchema>;
export type CreateWbsNodeRequest = z.input<typeof createWbsNodeRequestSchema>;
export type UpdateWbsNodeRequest = z.input<typeof updateWbsNodeRequestSchema>;
export type ReorderWbsRequest = z.infer<typeof reorderWbsRequestSchema>;
export type Milestone = z.infer<typeof milestoneSchema>;
export type MilestonesResponse = z.infer<typeof milestonesResponseSchema>;
export type CreateMilestoneRequest = z.input<typeof createMilestoneRequestSchema>;
export type UpdateMilestoneRequest = z.input<typeof updateMilestoneRequestSchema>;
export type MilestoneStatusRequest = z.infer<typeof milestoneStatusRequestSchema>;
export type ProjectAssignmentRequest = z.infer<typeof projectAssignmentRequestSchema>;
export type ProjectTeamResponse = z.infer<typeof projectTeamResponseSchema>;
