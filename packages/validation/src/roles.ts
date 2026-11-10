import {
  isProjectPermission,
  MFA_REQUIRED_PERMISSIONS,
  PERMISSION_AREAS,
  PERMISSIONS,
  SYSTEM_ROLES,
  TENANT_PERMISSIONS,
  type Permission,
} from "@pm-buddy/types";
import { z } from "zod";

const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });

/** System roles a company can assign; platform administration is never a tenant role. */
export const tenantRoleSchema = z.enum(SYSTEM_ROLES.filter((role) => role !== "platform_admin"));
export const permissionSchema = z.enum(PERMISSIONS);
/** Permissions a tenant role may contain. `platform.admin` can never be granted by a tenant. */
export const tenantPermissionSchema = permissionSchema.exclude(["platform.admin"]);
export const projectPermissionSchema = permissionSchema.extract([
  "projects.view",
  "projects.manage",
]);

/** A role reference: a system role key (`project_manager`) or a tenant custom role ID. */
export const roleReferenceSchema = z.union([tenantRoleSchema, uuid]);

const reservedRoleNames = new Set(
  SYSTEM_ROLES.flatMap((role) => [role, role.replaceAll("_", " ")]).concat(["admin", "custom"]),
);
export const roleNameSchema = z
  .string()
  .trim()
  .min(2)
  .max(60)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} .,&()/'-]*$/u, "Use letters, numbers and simple punctuation")
  .refine(
    (name) => !reservedRoleNames.has(name.toLowerCase()),
    "This name is reserved for a system role",
  );

const permissionList = z
  .array(tenantPermissionSchema)
  .min(1)
  .max(TENANT_PERMISSIONS.length)
  .refine((permissions) => new Set(permissions).size === permissions.length, {
    message: "Duplicate permissions",
  });

export const createRoleRequestSchema = z
  .object({
    name: roleNameSchema,
    permissions: permissionList,
    tenantWide: z.boolean().default(false),
  })
  .strict();

export const updateRoleRequestSchema = z
  .object({
    name: roleNameSchema.optional(),
    permissions: permissionList.optional(),
    tenantWide: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "Change at least one field",
  });

export const memberRoleRequestSchema = z.object({ role: roleReferenceSchema }).strict();

const permissionEntry = z
  .object({
    key: permissionSchema,
    mfaRequired: z.boolean(),
    projectScoped: z.boolean(),
    assignable: z.boolean(),
  })
  .strict();
export const permissionCatalogueResponseSchema = z
  .object({
    areas: z.array(
      z
        .object({
          area: z.enum(PERMISSION_AREAS),
          permissions: z.array(permissionEntry).min(1),
        })
        .strict(),
    ),
  })
  .strict();

const roleFields = {
  permissions: z.array(permissionSchema),
  tenantWide: z.boolean(),
  mfaRequired: z.boolean(),
  memberCount: z.number().int().nonnegative(),
  /** Whether the caller may assign this role: it holds every permission in it. */
  assignable: z.boolean(),
};
export const roleSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("system"), id: tenantRoleSchema, name: z.null(), ...roleFields })
    .strict(),
  z
    .object({
      kind: z.literal("custom"),
      id: uuid,
      name: z.string().min(1).max(60),
      ...roleFields,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .strict(),
]);
export const rolesResponseSchema = z.object({ roles: z.array(roleSchema) }).strict();
export const roleResponseSchema = z.object({ role: roleSchema }).strict();

/** The catalogue grouped by area, as served by GET /permissions. */
export function permissionCatalogue(): PermissionCatalogueResponse {
  return {
    areas: PERMISSION_AREAS.map((area) => ({
      area,
      permissions: PERMISSIONS.filter((key) => key.startsWith(`${area}.`)).map(
        (key: Permission) => ({
          key,
          mfaRequired: (MFA_REQUIRED_PERMISSIONS as readonly Permission[]).includes(key),
          projectScoped: isProjectPermission(key),
          assignable: TENANT_PERMISSIONS.includes(key),
        }),
      ),
    })),
  };
}

export type TenantRole = z.infer<typeof tenantRoleSchema>;
export type ProjectPermission = z.infer<typeof projectPermissionSchema>;
export type TenantPermission = z.infer<typeof tenantPermissionSchema>;
export type RoleReference = z.infer<typeof roleReferenceSchema>;
export type CreateRoleRequest = z.infer<typeof createRoleRequestSchema>;
export type UpdateRoleRequest = z.infer<typeof updateRoleRequestSchema>;
export type MemberRoleRequest = z.infer<typeof memberRoleRequestSchema>;
export type PermissionCatalogueResponse = z.infer<typeof permissionCatalogueResponseSchema>;
export type Role = z.infer<typeof roleSchema>;
export type RolesResponse = z.infer<typeof rolesResponseSchema>;
export type RoleResponse = z.infer<typeof roleResponseSchema>;
