import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Secret, TOTP } from "otpauth";
import request from "supertest";
import type { App } from "supertest/types.js";
import { expect } from "vitest";
import { z } from "zod";
import {
  bqBillResponseSchema,
  bqCompareResponseSchema,
  bqContractSumResponseSchema,
  bqItemLinkResponseSchema,
  bqVersionResponseSchema,
  bqVersionsResponseSchema,
  buildupResponseSchema,
  buildupsResponseSchema,
  buildupVersionResponseSchema,
  instructionResponseSchema,
  instructionsResponseSchema,
  variationResponseSchema,
  variationsResponseSchema,
  bqImportResponseSchema,
  bqImportsResponseSchema,
  bqPreviewResponseSchema,
  bqResponseSchema,
  bqSearchResponseSchema,
  bqSheetRowsResponseSchema,
  bqTemplateResponseSchema,
  bqTemplatesResponseSchema,
  auditEventsResponseSchema,
  authResponseSchema,
  csrfResponseSchema,
  invitationResponseSchema,
  membersResponseSchema,
  messageResponseSchema,
  mfaEnrollmentResponseSchema,
  mfaVerificationResponseSchema,
  passkeyAuthenticationOptionsResponseSchema,
  passkeyRegistrationOptionsResponseSchema,
  passkeyRegistrationResponseSchema,
  passkeysResponseSchema,
  permissionCatalogueResponseSchema,
  geofenceHistoryResponseSchema,
  milestoneResponseSchema,
  milestonesResponseSchema,
  projectDetailResponseSchema,
  projectResponseSchema,
  projectsResponseSchema,
  projectTeamResponseSchema,
  siteResponseSchema,
  sitesResponseSchema,
  wbsNodeResponseSchema,
  wbsResponseSchema,
  roleResponseSchema,
  rolesResponseSchema,
  sessionsResponseSchema,
  tenantCreatedResponseSchema,
  tenantsResponseSchema,
  conversionResponseSchema,
  conversionResultResponseSchema,
  loadDefaultsResponseSchema,
  materialDetailResponseSchema,
  materialResponseSchema,
  materialsResponseSchema,
  priceAlertsResponseSchema,
  priceResponseSchema,
  procurementSettingsResponseSchema,
  supplierDetailResponseSchema,
  supplierRevealResponseSchema,
  suppliersResponseSchema,
  unitResponseSchema,
  unitsResponseSchema,
  type AuthResponse as SharedAuthResponse,
  type PasskeyRegistrationResponse,
} from "@pm-buddy/validation";
import type { CeremonyOverrides, SoftwareAuthenticator } from "./webauthn.js";

/** Shared e2e helpers: a cookie-carrying browser and the response contract of every endpoint. */
export type AuthResponse = SharedAuthResponse & { recoveryCodes?: string[] };
export const password = "Unique construction foundation! 918";
export const origin = "http://localhost:3000";
export const notifications = new Map<string, { subject: string; text: string }[]>();

export function responseContract(method: string, target: string) {
  const path = target.split("?")[0]!;
  if (path === "auth/csrf") return csrfResponseSchema;
  if (path === "auth/mfa/enroll") return mfaEnrollmentResponseSchema;
  if (path === "auth/mfa/verify") return mfaVerificationResponseSchema;
  if (path === "auth/sessions" && method === "get") return sessionsResponseSchema;
  if (path === "auth/passkeys" && method === "get") return passkeysResponseSchema;
  if (path === "auth/passkeys/registration/options")
    return passkeyRegistrationOptionsResponseSchema;
  if (path === "auth/passkeys/registration") return passkeyRegistrationResponseSchema;
  if (path === "auth/passkeys/step-up/options") return passkeyAuthenticationOptionsResponseSchema;
  if (
    [
      "auth/login",
      "auth/me",
      "auth/refresh",
      "auth/mfa/step-up",
      "auth/mfa/recover",
      "auth/passkeys/step-up",
    ].includes(path) ||
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
  if (/^projects\/[^/]+$/.test(path))
    return method === "get" ? projectDetailResponseSchema : projectResponseSchema;
  if (/^projects\/[^/]+\/status$/.test(path)) return projectResponseSchema;
  if (/^projects\/[^/]+\/sites$/.test(path))
    return method === "get" ? sitesResponseSchema : siteResponseSchema;
  if (/^projects\/[^/]+\/sites\/[^/]+(\/geofence)?$/.test(path)) return siteResponseSchema;
  if (/^projects\/[^/]+\/sites\/[^/]+\/geofences$/.test(path)) return geofenceHistoryResponseSchema;
  if (/^projects\/[^/]+\/wbs$/.test(path))
    return method === "get" ? wbsResponseSchema : wbsNodeResponseSchema;
  if (/^projects\/[^/]+\/wbs\/[^/]+$/.test(path) && method === "patch" && !path.endsWith("/order"))
    return wbsNodeResponseSchema;
  if (/^projects\/[^/]+\/milestones$/.test(path))
    return method === "get" ? milestonesResponseSchema : milestoneResponseSchema;
  if (/^projects\/[^/]+\/milestones\/[^/]+(\/status)?$/.test(path) && method !== "delete")
    return milestoneResponseSchema;
  if (/^projects\/[^/]+\/team$/.test(path)) return projectTeamResponseSchema;
  const bqMatch = /^projects\/[^/]+\/bq(\/.*)?$/.exec(path);
  if (bqMatch) {
    const bq = bqMatch[1] ?? "";
    if (bq === "") return bqResponseSchema;
    if (/^\/bills\/[^/]+$/.test(bq)) return bqBillResponseSchema;
    if (bq === "/search") return bqSearchResponseSchema;
    if (/^\/export\/(xlsx|pdf)$/.test(bq) || /^\/imports\/[^/]+\/source$/.test(bq))
      return z.unknown();
    if (bq === "/imports")
      return method === "get" ? bqImportsResponseSchema : bqImportResponseSchema;
    if (/^\/imports\/[^/]+\/sheets\/\d+\/rows$/.test(bq)) return bqSheetRowsResponseSchema;
    if (/^\/imports\/[^/]+\/preview$/.test(bq)) return bqPreviewResponseSchema;
    if (
      /^\/imports\/[^/]+(\/(parse|mapping|apply-template|validate|resolutions|commit|abandon))?$/.test(
        bq,
      )
    )
      return bqImportResponseSchema;
    if (bq === "/templates")
      return method === "get" ? bqTemplatesResponseSchema : bqTemplateResponseSchema;
    if (bq === "/versions") return bqVersionsResponseSchema;
    if (bq === "/versions/compare") return bqCompareResponseSchema;
    if (/^\/versions\/[^/]+\/bills\/[^/]+$/.test(bq)) return bqBillResponseSchema;
    if (/^\/versions\/[^/]+\/approve$/.test(bq)) return bqVersionResponseSchema;
    if (bq === "/contract-sum") return bqContractSumResponseSchema;
    if (bq === "/instructions")
      return method === "get" ? instructionsResponseSchema : instructionResponseSchema;
    if (/^\/instructions\/[^/]+$/.test(bq)) return instructionResponseSchema;
    if (bq === "/variations")
      return method === "get" ? variationsResponseSchema : variationResponseSchema;
    if (/^\/variations\/[^/]+(\/(lines|submit|approve|reject|reopen|cancel|rebase))?$/.test(bq))
      return variationResponseSchema;
    if (/^\/items\/[^/]+\/rate-buildup$/.test(bq)) return bqItemLinkResponseSchema;
  }
  if (path === "rate-buildups")
    return method === "get" ? buildupsResponseSchema : buildupResponseSchema;
  if (/^rate-buildups\/[^/]+$/.test(path)) return buildupResponseSchema;
  if (/^rate-buildups\/[^/]+\/versions\/\d+$/.test(path)) return buildupVersionResponseSchema;
  const procurement = procurementContract(method, path);
  if (procurement) return procurement;
  return messageResponseSchema;
}

/** The D5.1 catalogue and supplier endpoints' success contracts. */
function procurementContract(method: string, path: string) {
  if (path === "materials")
    return method === "get" ? materialsResponseSchema : materialResponseSchema;
  if (path === "materials/defaults") return loadDefaultsResponseSchema;
  if (/^materials\/[^/]+$/.test(path))
    return method === "get" ? materialDetailResponseSchema : materialResponseSchema;
  if (/^materials\/[^/]+\/conversions(\/[^/]+\/end)?$/.test(path)) return conversionResponseSchema;
  if (/^materials\/[^/]+\/prices(\/[^/]+\/corrections)?$/.test(path)) return priceResponseSchema;
  if (path === "price-alerts") return priceAlertsResponseSchema;
  if (path === "conversions/calculate") return conversionResultResponseSchema;
  if (path === "units") return method === "get" ? unitsResponseSchema : unitResponseSchema;
  if (/^units\/[^/]+$/.test(path)) return unitResponseSchema;
  if (path === "procurement/settings") return procurementSettingsResponseSchema;
  if (path === "suppliers")
    return method === "get" ? suppliersResponseSchema : supplierDetailResponseSchema;
  if (/^suppliers\/[^/]+\/reveal$/.test(path)) return supplierRevealResponseSchema;
  if (/^suppliers\/[^/]+(\/payout-details(\/[^/]+\/(verify|reject))?)?$/.test(path))
    return supplierDetailResponseSchema;
  return null;
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

  /** A multipart upload of one file as the `file` field (as the web app sends it). */
  async upload(path: string, content: Buffer, fileName: string): Promise<request.Response> {
    const operation = request(this.app.getHttpServer()).post(`/api/v1/${path}`);
    operation.set("Cookie", [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "));
    operation.set("Origin", origin);
    operation.set("X-CSRF-Token", this.csrf);
    const res = await operation.attach("file", content, fileName);
    if (res.status >= 200 && res.status < 300)
      expect(
        responseContract("post", path).safeParse(res.body).success,
        `Wire contract mismatch for upload ${path}: ${JSON.stringify(res.body)}`,
      ).toBe(true);
    return res;
  }

  /** A GET whose body is a file (exports, sources). */
  async download(path: string): Promise<request.Response> {
    return request(this.app.getHttpServer())
      .get(`/api/v1/${path}`)
      .set("Cookie", [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "))
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      });
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

  /** Runs a real WebAuthn registration ceremony with a software authenticator. */
  async registerPasskey(
    authenticator: SoftwareAuthenticator,
    name = "Test passkey",
    overrides: CeremonyOverrides = {},
  ): Promise<request.Response> {
    const options = await this.call("post", "auth/passkeys/registration/options", {});
    expect(options.status, JSON.stringify(options.body)).toBe(200);
    const credential = authenticator.register(
      passkeyRegistrationOptionsResponseSchema.parse(options.body).options,
      overrides,
    );
    const res = await this.call("post", "auth/passkeys/registration", { name, credential });
    if (res.status === 201) this.auth = res.body as PasskeyRegistrationResponse;
    return res;
  }

  /** Requests step-up options, then answers them with an assertion (optionally tampered with). */
  async passkeyStepUp(
    authenticator: SoftwareAuthenticator,
    overrides: CeremonyOverrides = {},
  ): Promise<request.Response> {
    const options = await this.call("post", "auth/passkeys/step-up/options", {});
    expect(options.status, JSON.stringify(options.body)).toBe(200);
    const credential = authenticator.assert(
      passkeyAuthenticationOptionsResponseSchema.parse(options.body).options,
      overrides,
    );
    const res = await this.call("post", "auth/passkeys/step-up", { credential });
    if (res.status === 200) this.auth = res.body as AuthResponse;
    return res;
  }
}
