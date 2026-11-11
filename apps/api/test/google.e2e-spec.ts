import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { App } from "supertest/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { authProvidersResponseSchema, authResponseSchema } from "@pm-buddy/validation";
import { PrismaService } from "../src/infra/prisma.service.js";
import { AuthSecurity } from "../src/modules/identity/auth-security.service.js";
import { FakeGoogle, type Tweaks } from "./fake-google.js";
import { Browser, notifications, origin, password } from "./support.js";

const CLIENT_ID = "pm-buddy-test.apps.googleusercontent.com";
const CALLBACK = `${origin}/api/v1/auth/google/callback`;

describe("Continue with Google (local fake provider, real openid-client and database)", () => {
  const google = new FakeGoogle(CLIENT_ID, "test-only-google-secret", CALLBACK);
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let notificationSpy: ReturnType<typeof vi.spyOn>;

  const gmail = () => `t${randomUUID().slice(0, 8)}@gmail.com`;
  const subject = () => String(Math.floor(Math.random() * 1e15));
  const claims = (sub: string, email: string, extra: Record<string, unknown> = {}) => ({
    sub,
    email,
    email_verified: true,
    name: "Google Test User",
    ...extra,
  });
  const fresh = async () => {
    const browser = new Browser(app);
    await browser.initialize();
    return browser;
  };
  /** Start → "Google" → callback, as the browser would follow the redirects. */
  const signIn = async (
    browser: Browser,
    profile: Record<string, unknown>,
    tweaks: Tweaks = {},
    next = "/projects",
  ) => {
    const started = await browser.call("get", `auth/google/start?next=${encodeURIComponent(next)}`);
    expect(started.status).toBe(303);
    const callback = google.authorize(started.headers["location"] as string, profile, tweaks);
    const done = await browser.call("get", callback);
    expect(done.status).toBe(303);
    return { location: done.headers["location"] as string, callback, done };
  };
  const me = async (browser: Browser) => {
    const res = await browser.call("get", "auth/me");
    return res.status === 200 ? authResponseSchema.parse(res.body) : null;
  };
  const sessionCookieSet = (res: request.Response) =>
    ((res.headers["set-cookie"] as unknown as string[] | undefined) ?? []).some((value) =>
      /^pmb_at=[^;]+/.test(value),
    );

  beforeAll(async () => {
    await google.start();
    process.env["AUTH_GOOGLE_CLIENT_ID"] = CLIENT_ID;
    process.env["AUTH_GOOGLE_CLIENT_SECRET"] = "test-only-google-secret";
    process.env["AUTH_GOOGLE_ISSUER"] = google.issuer;
    // Imported after the environment is set: ConfigModule validates it when AppModule loads.
    const { AppModule } = await import("../src/app.module.js");
    const { configureApp } = await import("../src/app.setup.js");
    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication({ bufferLogs: true });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    notificationSpy = vi
      .spyOn(app.get(AuthSecurity), "notify")
      .mockImplementation(async (identifier, subjectLine, text) => {
        notifications.set(identifier, [
          ...(notifications.get(identifier) ?? []),
          { subject: subjectLine, text },
        ]);
      });
  });

  afterAll(async () => {
    notificationSpy?.mockRestore();
    await app?.close();
    await google.close();
  });

  it("advertises Google and documents its operations", async () => {
    const browser = await fresh();
    const res = await browser.call("get", "auth/providers");
    expect(authProvidersResponseSchema.parse(res.body)).toEqual({ google: true });
    const spec = await request(app.getHttpServer()).get("/api/docs/openapi.json").expect(200);
    const operations = Object.values(
      (spec.body as { paths: Record<string, Record<string, { operationId?: string }>> }).paths,
    ).flatMap((path) => Object.values(path).map((operation) => operation.operationId));
    for (const id of ["listAuthProviders", "startGoogleSignIn", "completeGoogleSignIn"])
      expect(operations).toContain(id);
  });

  it("starts with PKCE, state and nonce held in an encrypted, path-scoped cookie", async () => {
    const browser = await fresh();
    const res = await browser.call("get", "auth/google/start?next=%2Fdiary");
    expect(res.status).toBe(303);
    const url = new URL(res.headers["location"] as string);
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("prompt")).toBe("select_account");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const key of ["state", "nonce"])
      expect(url.searchParams.get(key)?.length).toBeGreaterThanOrEqual(32);
    const cookie = (res.headers["set-cookie"] as unknown as string[]).find((value) =>
      value.startsWith("pmb_oauth="),
    )!;
    expect(cookie).toMatch(/Path=\/api\/v1\/auth\/google/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).not.toContain(url.searchParams.get("state")!);
    expect(cookie).not.toContain("/diary");
  });

  it("creates a verified account for a new Gmail user and signs them in", async () => {
    const browser = await fresh();
    const email = gmail();
    const sub = subject();
    const { location, done } = await signIn(browser, claims(sub, email.toUpperCase()));
    expect(location).toBe(`${origin}/sign-in?next=%2Fprojects`);
    expect(sessionCookieSet(done)).toBe(true);
    const account = await me(browser);
    expect(account).toMatchObject({
      user: {
        identifier: email,
        displayName: "Google Test User",
        verified: true,
        mfaEnabled: false,
      },
      mfaRequired: false,
    });
    const identities = await prisma.userIdentity.findMany({ where: { subject: sub } });
    expect(identities).toEqual([
      expect.objectContaining({ provider: "google", email, userId: account!.user.id }),
    ]);
    // No usable password was set: password sign-in fails until a reset sets one.
    const login = await browser.call("post", "auth/login", { identifier: email, password });
    expect(login.status).toBe(401);

    const again = await fresh();
    await signIn(again, claims(sub, email, { name: "Renamed" }));
    expect((await me(again))?.user.id).toBe(account!.user.id);
    expect(await prisma.user.count({ where: { identifier: email } })).toBe(1);
    expect(await prisma.userIdentity.count({ where: { subject: sub } })).toBe(1);
  });

  it("links an existing verified password account, emails a notice and keeps the password", async () => {
    const owner = new Browser(app);
    owner.identifier = gmail();
    await owner.register();
    const browser = await fresh();
    await signIn(browser, claims(subject(), owner.identifier));
    expect((await me(browser))?.user.id).toBe(owner.auth.user.id);
    expect(notifications.get(owner.identifier)?.at(-1)?.subject).toBe("Google sign-in linked");
    expect((await owner.login()).status).toBe(200);
  });

  it("still requires PM-Buddy MFA after Google for accounts with a factor", async () => {
    const owner = new Browser(app);
    owner.identifier = gmail();
    await owner.register();
    await owner.enroll();
    const browser = await fresh();
    await signIn(browser, claims(subject(), owner.identifier));
    const account = await me(browser);
    expect(account).toMatchObject({ mfaRequired: true, session: { mfaVerified: false } });
    expect((await browser.call("get", "tenants")).status).toBe(403);
    expect(
      (await browser.call("post", "auth/mfa/step-up", { code: owner.code(30_000) })).status,
    ).toBe(200);
    expect((await browser.call("get", "tenants")).status).toBe(200);
  });

  it("takes over an unverified pre-registration and discards its password", async () => {
    const victim = gmail();
    const attacker = await fresh();
    const registered = await attacker.call("post", "auth/register", {
      identifier: victim,
      password,
      displayName: "Pre-registered",
    });
    expect(registered.status).toBe(201);
    const browser = await fresh();
    await signIn(browser, claims(subject(), victim));
    expect((await me(browser))?.user.verified).toBe(true);
    const attempt = await attacker.call("post", "auth/login", { identifier: victim, password });
    expect(attempt.status).toBe(401);
    const code = notifications
      .get(victim)
      ?.at(-1)
      ?.text.match(/Verification code: (\d{6})/)?.[1];
    const verify = await attacker.call("post", "auth/verify", {
      identifier: victim,
      code,
      password,
    });
    expect(verify.status).toBe(401);
  });

  it("accepts Google Workspace only with a matching hosted domain; refuses other addresses", async () => {
    const workspace = `qs-${randomUUID().slice(0, 8)}@jenga-bora.example.test`;
    const ok = await fresh();
    await signIn(ok, claims(subject(), workspace, { hd: "jenga-bora.example.test" }));
    expect((await me(ok))?.user.identifier).toBe(workspace);

    for (const profile of [
      claims(subject(), `x-${randomUUID()}@outlook.example.test`),
      claims(subject(), `y-${randomUUID()}@jenga-bora.example.test`, { hd: "other.example.test" }),
      claims(subject(), gmail(), { email_verified: false }),
    ]) {
      const browser = await fresh();
      const { location, done } = await signIn(browser, profile);
      expect(location).toBe(`${origin}/sign-in?google=email-unsupported&next=%2Fprojects`);
      expect(sessionCookieSet(done)).toBe(false);
      expect(await me(browser)).toBeNull();
      expect(await prisma.user.count({ where: { identifier: profile.email } })).toBe(0);
    }
  });

  it("refuses tampered, replayed, cookieless and invalid-token callbacks without a session", async () => {
    const fail = `${origin}/sign-in?google=failed&next=%2Fprojects`;
    for (const tweaks of [
      { nonce: "a-different-nonce-value-0123456789" },
      { audience: "someone-else.apps.googleusercontent.com" },
      { expiresIn: -120 },
      { forge: true },
    ] satisfies Tweaks[]) {
      const browser = await fresh();
      const email = gmail();
      const { location, done } = await signIn(browser, claims(subject(), email), tweaks);
      expect(location, JSON.stringify(tweaks)).toBe(fail);
      expect(sessionCookieSet(done)).toBe(false);
      expect(await prisma.user.count({ where: { identifier: email } })).toBe(0);
    }

    const browser = await fresh();
    const started = await browser.call("get", "auth/google/start?next=%2Fprojects");
    const callback = google.authorize(
      started.headers["location"] as string,
      claims(subject(), gmail()),
    );
    const tampered = callback.replace(/state=[^&]+/, "state=tampered-state-value-0123456789");
    expect((await browser.call("get", tampered)).headers["location"]).toBe(fail);

    const stranger = await fresh();
    const other = await stranger.call("get", "auth/google/start");
    const stolen = google.authorize(
      other.headers["location"] as string,
      claims(subject(), gmail()),
    );
    const thief = await fresh();
    const res = await thief.call("get", stolen);
    expect(res.headers["location"]).toBe(`${origin}/sign-in?google=failed`);
    expect(sessionCookieSet(res)).toBe(false);

    const owner = await fresh();
    const { callback: used } = await signIn(owner, claims(subject(), gmail()));
    const replay = await owner.call("get", used);
    expect(replay.headers["location"]).toBe(`${origin}/sign-in?google=failed`);
    expect(sessionCookieSet(replay)).toBe(false);
  });

  it("reports cancellation and keeps next opaque for the web app to sanitise", async () => {
    const browser = await fresh();
    const started = await browser.call("get", "auth/google/start?next=%2F%2Fevil.example");
    const state = new URL(started.headers["location"] as string).searchParams.get("state")!;
    const res = await browser.call(
      "get",
      `auth/google/callback?error=access_denied&state=${encodeURIComponent(state)}`,
    );
    expect(res.headers["location"]).toBe(
      `${origin}/sign-in?google=cancelled&next=%2F%2Fevil.example`,
    );
    expect(new URL(res.headers["location"] as string).origin).toBe(origin);
  });

  it("refuses a second Google account for an email already linked to another", async () => {
    const email = gmail();
    await signIn(await fresh(), claims(subject(), email));
    const browser = await fresh();
    const { location, done } = await signIn(browser, claims(subject(), email));
    expect(location).toBe(`${origin}/sign-in?google=account-conflict&next=%2Fprojects`);
    expect(sessionCookieSet(done)).toBe(false);
    expect(await prisma.userIdentity.count({ where: { email } })).toBe(1);
  });

  it("serialises concurrent first sign-ins into one account", async () => {
    const email = gmail();
    const sub = subject();
    const browsers = await Promise.all([fresh(), fresh(), fresh()]);
    const callbacks = await Promise.all(
      browsers.map(async (browser) => {
        const started = await browser.call("get", "auth/google/start");
        return google.authorize(started.headers["location"] as string, claims(sub, email));
      }),
    );
    const results = await Promise.all(
      browsers.map((browser, index) => browser.call("get", callbacks[index]!)),
    );
    for (const res of results) expect(res.headers["location"]).toBe(`${origin}/sign-in`);
    const ids = await Promise.all(browsers.map(async (browser) => (await me(browser))?.user.id));
    expect(new Set(ids).size).toBe(1);
    expect(await prisma.user.count({ where: { identifier: email } })).toBe(1);
    expect(await prisma.userIdentity.count({ where: { subject: sub } })).toBe(1);
  });
});
