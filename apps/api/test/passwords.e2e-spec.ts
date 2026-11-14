import { randomUUID } from "node:crypto";
import { Logger, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { App } from "supertest/types.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { PrismaService } from "../src/infra/prisma.service.js";
import { AuthSecurity } from "../src/modules/identity/auth-security.service.js";
import { PasswordBreachChecker } from "../src/modules/identity/password-policy.js";
import { Browser, notifications, password } from "./support.js";

/** Stands in for the Have I Been Pwned lookup: no network calls in tests. */
class FakeBreachChecker extends PasswordBreachChecker {
  readonly breached = new Set<string>();
  readonly checked: string[] = [];
  isBreached(candidate: string): Promise<boolean> {
    this.checked.push(candidate);
    return Promise.resolve(this.breached.has(candidate));
  }
}

const weak = "password12345678";
const breached = "Leaked construction phrase 2019!";
const problem = (body: unknown) => body as { code: string; detail: string };

describe("Password strength and breached-password checks", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let notificationSpy: ReturnType<typeof vi.spyOn>;
  const breaches = new FakeBreachChecker();

  beforeAll(async () => {
    breaches.breached.add(breached);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PasswordBreachChecker)
      .useValue(breaches)
      .compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    notificationSpy = vi
      .spyOn(app.get(AuthSecurity), "notify")
      .mockImplementation(async (identifier, subject, text) => {
        notifications.set(identifier, [
          ...(notifications.get(identifier) ?? []),
          { subject, text },
        ]);
      });
  });

  beforeEach(() => {
    breaches.checked.length = 0;
  });

  afterAll(async () => {
    notificationSpy?.mockRestore();
    await app?.close();
  });

  it("refuses weak registrations with a generic, localisable code and stores nothing", async () => {
    const visitor = new Browser(app);
    await visitor.initialize();
    for (const candidate of [weak, "Kenya2026Kenya2026", visitor.identifier]) {
      const res = await visitor.call("post", "auth/register", {
        identifier: visitor.identifier,
        password: candidate,
        displayName: "Weak password visitor",
      });
      expect(res.status, candidate).toBe(400);
      expect(problem(res.body).code).toBe("password-too-weak");
      expect(JSON.stringify(res.body)).not.toMatch(/score|guesses|feedback/i);
    }
    // Context words: the person's own name and the product name make a password guessable.
    const named = await visitor.call("post", "auth/register", {
      identifier: visitor.identifier,
      password: "Wanjiru Kamau 1",
      displayName: "Wanjiru Kamau",
    });
    expect(problem(named.body).code).toBe("password-too-weak");
    const product = await visitor.call("post", "auth/register", {
      identifier: visitor.identifier,
      password: "PMBuddy123456", // gitleaks:allow (deliberately weak synthetic test password)
      displayName: "Product fan",
    });
    expect(problem(product.body).code).toBe("password-too-weak");
    expect(await prisma.user.findUnique({ where: { identifier: visitor.identifier } })).toBeNull();
    expect(notifications.get(visitor.identifier)).toBeUndefined();
    // Strength is checked first; weak passwords never reach the breach lookup.
    expect(breaches.checked).toEqual([]);
  });

  it("refuses breached passwords and answers the same whether or not the account exists", async () => {
    const existing = new Browser(app);
    await existing.register();
    breaches.checked.length = 0;
    const visitor = new Browser(app);
    await visitor.initialize();
    const attempt = (identifier: string, candidate: string) =>
      visitor.call("post", "auth/register", {
        identifier,
        password: candidate,
        displayName: "Probe",
      });
    const fresh = await attempt(`${randomUUID()}@example.test`, breached);
    const known = await attempt(existing.identifier, breached);
    expect([fresh.status, known.status]).toEqual([400, 400]);
    expect(problem(fresh.body).code).toBe("password-breached");
    expect(problem(known.body).code).toBe("password-breached");
    expect(problem(known.body).detail).toBe(problem(fresh.body).detail);
    const weakFresh = await attempt(`${randomUUID()}@example.test`, weak);
    const weakKnown = await attempt(existing.identifier, weak);
    expect([weakFresh.status, weakKnown.status]).toEqual([400, 400]);
    expect(problem(weakKnown.body).code).toBe(problem(weakFresh.body).code);
    expect(breaches.checked).toEqual([breached, breached]);
    // A strong, unbreached password still registers normally.
    const ok = await attempt(`${randomUUID()}@example.test`, password);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it("applies both checks to password resets, leaving the token usable", async () => {
    const user = new Browser(app);
    await user.register();
    expect(
      (await user.call("post", "auth/password/forgot", { identifier: user.identifier })).status,
    ).toBe(200);
    const token = notifications
      .get(user.identifier)
      ?.at(-1)
      ?.text.match(/Password reset token: ([A-Za-z0-9_-]+)/)?.[1];
    expect(token).toHaveLength(43);
    const tooWeak = await user.call("post", "auth/password/reset", { token, password: weak });
    expect(tooWeak.status).toBe(400);
    expect(problem(tooWeak.body).code).toBe("password-too-weak");
    // The identifier is context: an email-derived password is too weak for this account.
    const derived = await user.call("post", "auth/password/reset", {
      token,
      password: `${user.identifier.split("@")[0]!}1`,
    });
    expect(problem(derived.body).code).toBe("password-too-weak");
    const leaked = await user.call("post", "auth/password/reset", { token, password: breached });
    expect(leaked.status).toBe(400);
    expect(problem(leaked.body).code).toBe("password-breached");
    // Refusals did not spend the token or change the password.
    expect((await user.call("get", "auth/me")).status).toBe(200);
    const next = "Fresh scaffolding phrase for Thika 7";
    const changed = await user.call("post", "auth/password/reset", { token, password: next });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(
      (await user.call("post", "auth/login", { identifier: user.identifier, password: next }))
        .status,
    ).toBe(200);
  });

  it("changes a password only with the current one and signs out the other sessions (D9.1)", async () => {
    const user = new Browser(app);
    await user.register();
    const other = new Browser(app);
    other.identifier = user.identifier;
    await other.initialize();
    await other.login();
    const next = "Murram road to Kitengela, 2026 edition";
    const change = (body: object) => user.call("post", "auth/password/change", body);
    breaches.checked.length = 0;

    const wrong = await change({ currentPassword: "not the current one", newPassword: next });
    expect(wrong.status).toBe(400);
    expect(problem(wrong.body).code).toBe("current-password-incorrect");
    expect(breaches.checked).toEqual([]);
    // The same policy as registration, in the account's context.
    for (const [candidate, code] of [
      [weak, "password-too-weak"],
      [`${user.identifier.split("@")[0]!}1`, "password-too-weak"],
      [breached, "password-breached"],
    ] as const) {
      const refused = await change({ currentPassword: password, newPassword: candidate });
      expect(refused.status, candidate).toBe(400);
      expect(problem(refused.body).code).toBe(code);
    }
    expect(
      (await change({ currentPassword: password, newPassword: next, role: "owner" })).status,
    ).toBe(400);
    expect((await other.call("get", "auth/me")).status).toBe(200);

    const changed = await change({ currentPassword: password, newPassword: next });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect((await user.call("get", "auth/me")).status).toBe(200);
    expect((await other.call("get", "auth/me")).status).toBe(401);
    expect((await other.call("post", "auth/refresh", {})).status).toBe(401);
    const login = async (secret: string) => {
      const browser = new Browser(app);
      await browser.initialize();
      return browser.call("post", "auth/login", { identifier: user.identifier, password: secret });
    };
    expect((await login(password)).status).toBe(401);
    expect((await login(next)).status).toBe(200);
    expect(notifications.get(user.identifier)?.at(-1)?.subject).toBe("Password changed");
  });

  it("keeps other sessions when asked, and needs a fresh step-up once MFA is on", async () => {
    const user = new Browser(app);
    await user.register();
    await user.enroll();
    const other = new Browser(app);
    other.identifier = user.identifier;
    await other.initialize();
    await other.login();
    await prisma.session.update({
      where: { id: user.auth.session.id },
      data: { mfaVerifiedAt: new Date(Date.now() - 10 * 60_000) },
    });
    const body = {
      currentPassword: password,
      newPassword: "Kiambu ring road ballast, phase two",
      signOutOtherSessions: false,
    };
    const stale = await user.call("post", "auth/password/change", body);
    expect(stale.status).toBe(403);
    expect(problem(stale.body).code).toBe("step-up-required");
    expect((await user.call("post", "auth/mfa/step-up", { code: user.code(30_000) })).status).toBe(
      200,
    );
    const changed = await user.call("post", "auth/password/change", body);
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect((await other.call("get", "auth/me")).status).toBe(200);
  });

  it("logs authentication outcomes as security events without identifiers or secrets", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn");
    const log = vi.spyOn(Logger.prototype, "log");
    try {
      const user = new Browser(app);
      await user.register();
      const visitor = new Browser(app);
      await visitor.initialize();
      await visitor.call("post", "auth/login", { identifier: user.identifier, password: weak });
      await visitor.call("post", "auth/login", {
        identifier: `${randomUUID()}@example.test`,
        password: weak,
      });
      const events = [...warn.mock.calls, ...log.mock.calls]
        .map(([entry]) => entry as { securityEvent?: string; userId?: string; reason?: string })
        .filter((entry) => typeof entry === "object" && entry?.securityEvent);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            securityEvent: "auth.login.succeeded",
            userId: user.auth.user.id,
            method: "password",
          }),
          expect.objectContaining({
            securityEvent: "auth.login.failed",
            userId: user.auth.user.id,
            reason: "wrong-password",
          }),
          expect.objectContaining({
            securityEvent: "auth.login.failed",
            reason: "unknown-account",
          }),
        ]),
      );
      const text = JSON.stringify(events);
      expect(text).not.toContain(user.identifier);
      expect(text).not.toContain(weak);
      expect(text).not.toContain(password);
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  it("checks the reset token before the password, so invalid tokens trigger no lookup", async () => {
    const visitor = new Browser(app);
    await visitor.initialize();
    const res = await visitor.call("post", "auth/password/reset", {
      token: "A".repeat(43),
      password: weak,
    });
    expect(res.status).toBe(401);
    expect(breaches.checked).toEqual([]);
  });
});
