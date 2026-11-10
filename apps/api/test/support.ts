import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Secret, TOTP } from "otpauth";
import request from "supertest";
import type { App } from "supertest/types.js";
import { expect } from "vitest";
import {
  auditEventsResponseSchema,
  authResponseSchema,
  csrfResponseSchema,
  invitationResponseSchema,
  membersResponseSchema,
  messageResponseSchema,
  mfaEnrollmentResponseSchema,
  mfaVerificationResponseSchema,
  permissionCatalogueResponseSchema,
  projectResponseSchema,
  projectsResponseSchema,
  roleResponseSchema,
  rolesResponseSchema,
  sessionsResponseSchema,
  tenantCreatedResponseSchema,
  tenantsResponseSchema,
  type AuthResponse as SharedAuthResponse,
} from "@pm-buddy/validation";

/** Shared e2e helpers: a cookie-carrying browser and the response contract of every endpoint. */
export type AuthResponse = SharedAuthResponse & { recoveryCodes?: string[] };
export const password = "Unique construction foundation! 918";
export const origin = "http://localhost:3000";
export const notifications = new Map<string, { subject: string; text: string }[]>();

export function responseContract(method: string, path: string) {
  if (path === "auth/csrf") return csrfResponseSchema;
  if (path === "auth/mfa/enroll") return mfaEnrollmentResponseSchema;
  if (path === "auth/mfa/verify") return mfaVerificationResponseSchema;
  if (path === "auth/sessions" && method === "get") return sessionsResponseSchema;
  if (
    ["auth/login", "auth/me", "auth/refresh", "auth/mfa/step-up", "auth/mfa/recover"].includes(
      path,
    ) ||
    /^tenants\/[^/]+\/select$/.test(path)
  )
    return authResponseSchema;
  if (path === "tenants")
    return method === "get" ? tenantsResponseSchema : tenantCreatedResponseSchema;
  if (path === "tenants/current/members") return membersResponseSchema;
  if (path === "tenants/current/audit") return auditEventsResponseSchema;
  if (path === "tenants/current/invitations") return invitationResponseSchema;
  if (path === "permissions") return permissionCatalogueResponseSchema;
  if (path === "tenants/current/roles")
    return method === "get" ? rolesResponseSchema : roleResponseSchema;
  if (/^tenants\/current\/roles\/[^/]+$/.test(path) && method === "patch")
    return roleResponseSchema;
  if (path === "projects") return method === "get" ? projectsResponseSchema : projectResponseSchema;
  if (/^projects\/[^/]+$/.test(path) && method === "patch") return projectResponseSchema;
  return messageResponseSchema;
}

export class Browser {
  readonly cookies = new Map<string, string>();
  csrf = "";
  auth!: AuthResponse;
  identifier = `${randomUUID()}@example.test`;
  mfaSecret = "";
  enrollmentCode = "";
  constructor(private readonly app: INestApplication<App>) {}

  async call(
    method: "get" | "post" | "delete" | "patch" | "put",
    path: string,
    body?: object,
    csrf = true,
  ): Promise<request.Response> {
    const operation = request(this.app.getHttpServer())[method](`/api/v1/${path}`);
    operation.set("Cookie", [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "));
    operation.set("Origin", origin);
    if (csrf) operation.set("X-CSRF-Token", this.csrf);
    const res = body === undefined ? await operation : await operation.send(body);
    if (res.status >= 200 && res.status < 300) {
      expect(
        responseContract(method, path).safeParse(res.body).success,
        `Wire contract mismatch for ${method.toUpperCase()} ${path}: ${JSON.stringify(res.body)}`,
      ).toBe(true);
    }
    const values = res.headers["set-cookie"] as unknown as string[] | undefined;
    for (const value of values ?? []) {
      const pair = value.split(";")[0]!;
      const position = pair.indexOf("=");
      this.cookies.set(pair.slice(0, position), pair.slice(position + 1));
    }
    return res;
  }

  async initialize() {
    const res = await this.call("get", "auth/csrf");
    expect(res.status).toBe(200);
    this.csrf = (res.body as { csrfToken: string }).csrfToken;
  }

  async register() {
    await this.initialize();
    const res = await this.call("post", "auth/register", {
      identifier: this.identifier,
      password,
      displayName: "Foundation test user",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const text = notifications.get(this.identifier)?.at(-1)?.text;
    const code = text?.match(/Verification code: (\d{6})/)?.[1];
    expect(code).toMatch(/^\d{6}$/);
    const verified = await this.call("post", "auth/verify", {
      identifier: this.identifier,
      code,
      password,
    });
    expect(verified.status, JSON.stringify(verified.body)).toBe(200);
    await this.login();
  }

  async login(): Promise<request.Response> {
    const res = await this.call("post", "auth/login", { identifier: this.identifier, password });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    this.auth = res.body as AuthResponse;
    return res;
  }

  code(offset = 0) {
    return new TOTP({ secret: Secret.fromBase32(this.mfaSecret) }).generate({
      timestamp: Date.now() + offset,
    });
  }

  async enroll() {
    const start = await this.call("post", "auth/mfa/enroll", {});
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    this.mfaSecret = (start.body as { secret: string }).secret;
    this.enrollmentCode = this.code();
    const verified = await this.call("post", "auth/mfa/verify", { code: this.enrollmentCode });
    expect(verified.status, JSON.stringify(verified.body)).toBe(200);
    this.auth = verified.body as AuthResponse;
    expect(this.auth.recoveryCodes).toHaveLength(10);
  }
}
