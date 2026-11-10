import { PERMISSIONS, SYSTEM_ROLES } from "@pm-buddy/types";
import { z } from "zod";

const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });

export const tenantRoleSchema = z.enum(SYSTEM_ROLES.filter((role) => role !== "platform_admin"));
export const projectPermissionSchema = z
  .enum(PERMISSIONS)
  .extract(["projects.view", "projects.manage"]);

export const csrfResponseSchema = z.object({ csrfToken: z.string().min(1) }).strict();
export const messageResponseSchema = z.object({ message: z.string().min(1) }).strict();

export const authResponseSchema = z
  .object({
    user: z
      .object({
        id: uuid,
        identifier: z.string().min(3).max(254),
        displayName: z.string().min(1).max(100),
        verified: z.boolean(),
        mfaEnabled: z.boolean(),
      })
      .strict(),
    session: z
      .object({
        id: uuid,
        tenantId: uuid.nullable(),
        mfaVerified: z.boolean(),
        expiresAt: timestamp,
      })
      .strict(),
    mfaRequired: z.boolean(),
  })
  .strict();

export const mfaEnrollmentResponseSchema = z
  .object({
    secret: z.string().regex(/^[A-Z2-7]+$/),
    uri: z.url().startsWith("otpauth://totp/"),
  })
  .strict();

export const mfaVerificationResponseSchema = authResponseSchema.extend({
  recoveryCodes: z.array(z.string().min(16).max(64)).length(10),
});

export const sessionsResponseSchema = z
  .object({
    sessions: z.array(
      z
        .object({
          id: uuid,
          createdAt: timestamp,
          lastSeenAt: timestamp,
          expiresAt: timestamp,
          current: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

const tenant = z.object({ id: uuid, name: z.string().min(1).max(150) }).strict();
export const tenantCreatedResponseSchema = z.object({ tenant }).strict();
export const tenantsResponseSchema = z
  .object({
    tenants: z.array(tenant.extend({ role: tenantRoleSchema })),
  })
  .strict();

export const projectSchema = z
  .object({
    id: uuid,
    name: z.string().min(1).max(150),
    createdAt: timestamp,
  })
  .strict();
export const projectsResponseSchema = z.object({ projects: z.array(projectSchema) }).strict();
export const projectResponseSchema = z.object({ project: projectSchema }).strict();

export const invitationResponseSchema = z
  .object({
    invitation: z
      .object({
        id: uuid,
        identifier: z.string().min(3).max(254),
        role: tenantRoleSchema,
        expiresAt: timestamp,
      })
      .strict(),
  })
  .strict();

export const membersResponseSchema = z
  .object({
    members: z.array(
      z
        .object({
          userId: uuid,
          role: tenantRoleSchema,
          joinedAt: timestamp,
          user: z
            .object({
              displayName: z.string().min(1).max(100),
              identifier: z.string().min(3).max(254),
              mfaEnabled: z.boolean(),
            })
            .strict(),
        })
        .strict(),
    ),
  })
  .strict();

export const auditEventsResponseSchema = z
  .object({
    events: z.array(
      z
        .object({
          id: uuid,
          tenantId: uuid,
          actorId: uuid,
          action: z.string().min(1).max(100),
          resourceId: z.string(),
          requestId: z.string(),
          metadata: z.json(),
          createdAt: timestamp,
          sequence: z.string().regex(/^[1-9]\d*$/),
          previousHash: z.string().regex(/^[a-f0-9]{64}$/),
          hash: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    ),
  })
  .strict();

export type TenantRole = z.infer<typeof tenantRoleSchema>;
export type ProjectPermission = z.infer<typeof projectPermissionSchema>;
export type CsrfResponse = z.infer<typeof csrfResponseSchema>;
export type MessageResponse = z.infer<typeof messageResponseSchema>;
export type AuthResponse = z.infer<typeof authResponseSchema>;
export type MfaEnrollmentResponse = z.infer<typeof mfaEnrollmentResponseSchema>;
export type MfaVerificationResponse = z.infer<typeof mfaVerificationResponseSchema>;
export type SessionsResponse = z.infer<typeof sessionsResponseSchema>;
export type TenantsResponse = z.infer<typeof tenantsResponseSchema>;
export type TenantCreatedResponse = z.infer<typeof tenantCreatedResponseSchema>;
export type Project = z.infer<typeof projectSchema>;
export type ProjectsResponse = z.infer<typeof projectsResponseSchema>;
export type ProjectResponse = z.infer<typeof projectResponseSchema>;
export type InvitationResponse = z.infer<typeof invitationResponseSchema>;
export type MembersResponse = z.infer<typeof membersResponseSchema>;
export type AuditEventsResponse = z.infer<typeof auditEventsResponseSchema>;
