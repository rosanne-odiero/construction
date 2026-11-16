import { fetch } from "expo/fetch";
import {
  authResponseSchema,
  captureReceiptSchema,
  csrfResponseSchema,
  tenantsResponseSchema,
  type AuthResponse,
  type CaptureReceipt,
} from "@pm-buddy/validation";
import {
  cookieHeader,
  mergeCookies,
  responseCookies,
  validateEndpoints,
  type Cookie,
} from "./cookies";
import { HttpError, problemCode } from "./core";
import { deleteSecret, readSecret, saveSecret } from "./secrets";

export class Api {
  private jar: Cookie[] = [];
  private csrf = "";
  private api: string;
  private origin: string;
  private tail: Promise<unknown> = Promise.resolve();
  auth: AuthResponse | null = null;
  constructor() {
    const endpoints = validateEndpoints(
      process.env.EXPO_PUBLIC_API_URL,
      process.env.EXPO_PUBLIC_WEB_ORIGIN,
      __DEV__,
    );
    this.api = endpoints.api;
    this.origin = endpoints.origin;
  }
  async restore() {
    const saved = await readSecret("site.session");
    if (!saved) return;
    const data = JSON.parse(saved) as {
      api: string;
      origin: string;
      cookies: Cookie[];
      auth: unknown;
    };
    if (data.api !== this.api || data.origin !== this.origin) {
      throw new Error(
        "API configuration changed. Restore the original endpoint before using this device.",
      );
    }
    this.auth = data.auth === null ? null : authResponseSchema.parse(data.auth);
    this.jar = data.cookies;
  }
  private persist() {
    return saveSecret(
      "site.session",
      JSON.stringify({
        api: this.api,
        origin: this.origin,
        cookies: this.jar,
        auth: this.auth,
      }),
    );
  }
  private async raw(path: string, method: "GET" | "POST", body?: string): Promise<unknown> {
    const url = new URL(`${this.api}/${path}`);
    // Hermes has no AbortSignal.timeout(); the timer also covers reading the body.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    let response: Awaited<ReturnType<typeof fetch>>;
    let text: string;
    try {
      response = await fetch(url.toString(), {
        method,
        redirect: "error",
        credentials: "omit",
        headers: {
          Accept: "application/json",
          Origin: this.origin,
          Cookie: cookieHeader(this.jar, url),
          ...(method === "POST"
            ? { "Content-Type": "application/json", "X-CSRF-Token": this.csrf }
            : {}),
        },
        body,
        signal: controller.signal,
      });
      // Never split Set-Cookie on commas (Expires contains a comma).
      this.jar = mergeCookies(this.jar, responseCookies(response), url);
      await this.persist();
      text = await response.text();
    } finally {
      clearTimeout(timer);
    }
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`API returned invalid JSON (${response.status}).`);
    }
    if (!response.ok) {
      // Do not surface arbitrary response bodies which may contain personal data or tokens.
      throw new HttpError(
        response.status,
        `API ${response.status}. ${
          response.status === 401
            ? "Sign in again or refresh the session."
            : response.status === 403
              ? "Permission, MFA or CSRF check failed."
              : response.status === 409
                ? "Conflict: review this event in the office app."
                : "Request not accepted; retry or contact the office."
        }`,
        problemCode(data),
      );
    }
    return data;
  }
  request(
    path: string,
    method: "GET" | "POST" = "GET",
    data?: unknown,
    exactBody?: string,
  ): Promise<unknown> {
    const operation = this.tail.then(async () => {
      if (method === "POST") {
        this.csrf = csrfResponseSchema.parse(await this.raw("auth/csrf", "GET")).csrfToken;
      }
      return this.raw(
        path,
        method,
        exactBody ?? (method === "POST" ? JSON.stringify(data ?? {}) : undefined),
      );
    });
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
  async login(
    identifier: string,
    password: string,
    expectedUser?: string,
    expectedTenant?: string,
  ) {
    // Clear local auth first: a partial login failure must not retain an old identity.
    this.auth = null;
    await this.persist();
    const auth = authResponseSchema.parse(
      await this.request("auth/login", "POST", { identifier, password }),
    );
    if (expectedUser && auth.user.id !== expectedUser) {
      throw new Error(
        "A different supervisor signed in. Capture is locked; sign in as the original supervisor.",
      );
    }
    this.auth = auth;
    await this.persist();
    if (expectedTenant && !auth.mfaRequired) await this.select(expectedTenant);
    return this.auth;
  }
  async stepUp(code: string) {
    this.auth = authResponseSchema.parse(await this.request("auth/mfa/step-up", "POST", { code }));
    await this.persist();
    return this.auth;
  }
  async select(tenantId: string) {
    const expected = this.auth?.user.id;
    if (!expected || this.auth?.mfaRequired) throw new Error("Complete sign-in first.");
    this.auth = null;
    await this.persist();
    const auth = authResponseSchema.parse(await this.request(`tenants/${tenantId}/select`, "POST"));
    if (auth.user.id !== expected || auth.session.tenantId !== tenantId) {
      throw new Error("Selected session identity mismatch. Sign in again.");
    }
    this.auth = auth;
    await this.persist();
    return auth;
  }
  async refresh() {
    const expectedUser = this.auth?.user.id;
    const expectedTenant = this.auth?.session.tenantId;
    const auth = authResponseSchema.parse(await this.request("auth/refresh", "POST"));
    if (auth.user.id !== expectedUser || auth.session.tenantId !== expectedTenant) {
      this.auth = null;
      await this.persist();
      throw new Error("Session identity changed. Capture locked; sign in again.");
    }
    this.auth = auth;
    await this.persist();
    return auth;
  }
  async tenants() {
    return tenantsResponseSchema.parse(await this.request("tenants")).tenants;
  }
  async push(payload: string): Promise<CaptureReceipt> {
    return captureReceiptSchema.parse(
      await this.request("attendance/capture/events", "POST", undefined, payload),
    );
  }
  async logout() {
    await this.request("auth/logout", "POST");
    this.auth = null;
    this.jar = [];
    this.csrf = "";
    await deleteSecret("site.session");
  }
}
