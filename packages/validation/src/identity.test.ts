import { isPermission, SYSTEM_ROLES } from "@pm-buddy/types";
import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import {
  auditEventsResponseSchema,
  authResponseSchema,
  csrfResponseSchema,
  invitationResponseSchema,
  membersResponseSchema,
  messageResponseSchema,
  mfaEnrollmentResponseSchema,
  mfaVerificationResponseSchema,
  projectPermissionSchema,
  projectResponseSchema,
  projectsResponseSchema,
  sessionsResponseSchema,
  tenantCreatedResponseSchema,
  tenantRoleSchema,
  tenantsResponseSchema,
  type AuthResponse,
} from "./index.js";

const id = "550e8400-e29b-41d4-a716-446655440000";
const date = "2026-11-10T20:00:00.000Z";
const auth: AuthResponse = {
  user: {
    id,
    identifier: "builder@example.test",
    displayName: "Builder",
    verified: true,
    mfaEnabled: true,
  },
  session: { id, tenantId: null, mfaVerified: true, expiresAt: date },
  mfaRequired: false,
};
const tenant = { id, name: "Construction company" };
const project = { id, name: "Construction project", createdAt: date };
const event = {
  id,
  tenantId: id,
  actorId: id,
  action: "project.created",
  resourceId: id,
  requestId: "test-request",
  metadata: { permissions: ["projects.view"], nested: [true, null, 12] },
  createdAt: date,
  sequence: "123",
  previousHash: "0".repeat(64),
  hash: "a".repeat(64),
};
const contracts: { name: string; schema: ZodType; value: unknown }[] = [
  { name: "csrf", schema: csrfResponseSchema, value: { csrfToken: "encrypted-csrf-token" } },
  { name: "auth", schema: authResponseSchema, value: auth },
  { name: "message", schema: messageResponseSchema, value: { message: "Done." } },
  {
    name: "MFA enrollment",
    schema: mfaEnrollmentResponseSchema,
    value: {
      secret: "JBSWY3DPEHPK3PXP",
      uri: "otpauth://totp/PM-Buddy:builder?secret=JBSWY3DPEHPK3PXP",
    },
  },
  {
    name: "MFA verification",
    schema: mfaVerificationResponseSchema,
    value: {
      ...auth,
      recoveryCodes: Array.from({ length: 10 }, (_, index) => `recovery-code-${index}-123456789`),
    },
  },
  {
    name: "sessions",
    schema: sessionsResponseSchema,
    value: {
      sessions: [{ id, createdAt: date, lastSeenAt: date, expiresAt: date, current: true }],
    },
  },
  { name: "tenant creation", schema: tenantCreatedResponseSchema, value: { tenant } },
  {
    name: "tenants",
    schema: tenantsResponseSchema,
    value: {
      tenants: [
        {
          ...tenant,
          role: "owner",
          roleName: null,
          tenantWide: true,
          permissions: ["roles.manage", "projects.view"],
        },
        {
          ...tenant,
          role: id,
          roleName: "Site clerk",
          tenantWide: false,
          permissions: ["projects.view"],
        },
      ],
    },
  },
  { name: "projects", schema: projectsResponseSchema, value: { projects: [project] } },
  { name: "project", schema: projectResponseSchema, value: { project } },
  {
    name: "invitation",
    schema: invitationResponseSchema,
    value: {
      invitation: {
        id,
        identifier: "builder@example.test",
        role: "client",
        roleName: null,
        expiresAt: date,
      },
    },
  },
  {
    name: "members",
    schema: membersResponseSchema,
    value: {
      members: [
        {
          userId: id,
          role: "project_manager",
          roleName: null,
          joinedAt: date,
          user: { displayName: "Builder", identifier: "builder@example.test", mfaEnabled: false },
        },
      ],
    },
  },
  { name: "audit events", schema: auditEventsResponseSchema, value: { events: [event] } },
];

describe("Shared foundation wire contracts", () => {
  it.each(contracts)("validates the $name response shape", ({ schema, value }) => {
    expect(schema.parse(value)).toEqual(value);
  });

  it("derives assignable roles from shared system roles and excludes platform administration", () => {
    expect(tenantRoleSchema.options).toEqual(
      SYSTEM_ROLES.filter((role) => role !== "platform_admin"),
    );
    expect(tenantRoleSchema.safeParse("platform_admin").success).toBe(false);
  });

  it("uses only canonical project permissions, rejecting the retired vocabulary", () => {
    expect(projectPermissionSchema.options).toEqual(["projects.view", "projects.manage"]);
    for (const permission of projectPermissionSchema.options)
      expect(isPermission(permission)).toBe(true);
    for (const value of ["project.read", "project.update", "projects.create", "payments.approve"]) {
      expect(projectPermissionSchema.safeParse(value).success).toBe(false);
    }
  });

  it("rejects leaked internal auth fields, missing fields, invalid booleans and non-wire dates", () => {
    expect(
      authResponseSchema.safeParse({
        ...auth,
        user: { ...auth.user, passwordHash: "must-not-leak" },
      }).success,
    ).toBe(false);
    expect(authResponseSchema.safeParse({ ...auth, mfaRequired: "false" }).success).toBe(false);
    expect(
      authResponseSchema.safeParse({
        ...auth,
        session: { ...auth.session, expiresAt: "tomorrow" },
      }).success,
    ).toBe(false);
    const { tenantId: _removed, ...session } = auth.session;
    expect(authResponseSchema.safeParse({ ...auth, session }).success).toBe(false);
    expect(
      projectResponseSchema.safeParse({ project: { ...project, createdAt: new Date(date) } })
        .success,
    ).toBe(false);
    expect(
      projectResponseSchema.safeParse({ project: { ...project, id: "not-a-uuid" } }).success,
    ).toBe(false);
  });

  it("requires decimal-string audit sequences, real JSON metadata and chain hashes", () => {
    for (const change of [
      { sequence: 123 },
      { sequence: "1.5" },
      { hash: "invalid" },
      { metadata: new Date() },
    ]) {
      expect(
        auditEventsResponseSchema.safeParse({ events: [{ ...event, ...change }] }).success,
      ).toBe(false);
    }
  });

  it("requires the complete one-time recovery-code response and accepts timezone offsets", () => {
    expect(mfaVerificationResponseSchema.safeParse(auth).success).toBe(false);
    expect(
      mfaVerificationResponseSchema.safeParse({ ...auth, recoveryCodes: ["too-short"] }).success,
    ).toBe(false);
    expect(
      authResponseSchema.safeParse({
        ...auth,
        session: { ...auth.session, expiresAt: "2026-11-10T23:00:00+03:00" },
      }).success,
    ).toBe(true);
  });
});
