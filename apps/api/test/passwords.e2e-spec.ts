import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
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
