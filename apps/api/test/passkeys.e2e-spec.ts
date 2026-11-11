import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { App } from "supertest/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MFA_REQUIRED_PERMISSIONS } from "@pm-buddy/types";
import {
  passkeyAuthenticationOptionsResponseSchema,
  passkeyRegistrationOptionsResponseSchema,
  passkeysResponseSchema,
  tenantsResponseSchema,
} from "@pm-buddy/validation";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { PrismaService } from "../src/infra/prisma.service.js";
import { AuthSecurity, digest } from "../src/modules/identity/auth-security.service.js";
import { AuthService } from "../src/modules/identity/auth.service.js";
import { Browser, notifications, type AuthResponse } from "./support.js";
import { SoftwareAuthenticator } from "./webauthn.js";

/**
 * Passkeys against the real API, database (pmb_app runtime role) and @simplewebauthn/server
 * verification. Nothing about WebAuthn is mocked: a software authenticator signs genuine
 * responses, and tampered ones must fail verification.
 */
describe("Passkeys (real WebAuthn verification)", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let owner: Browser;
  let tenant: string;
  let notificationSpy: ReturnType<typeof vi.spyOn>;

  /** A verified, signed-in user whose first and only factor is a fresh passkey. */
  const passkeyUser = async (authenticator = new SoftwareAuthenticator()) => {
    const user = new Browser(app);
    await user.register();
    const res = await user.registerPasskey(authenticator, "Site phone");
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { user, authenticator };
  };
  /** A second sign-in of the same account: a new session whose MFA is not yet verified. */
  const signInAgain = async (user: Browser) => {
    const other = new Browser(app);
    other.identifier = user.identifier;
    await other.initialize();
    await other.login();
    return other;
  };
  const stepUpOptions = async (user: Browser) => {
    const res = await user.call("post", "auth/passkeys/step-up/options", {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return passkeyAuthenticationOptionsResponseSchema.parse(res.body).options;
  };
  const failures = async (user: Browser) =>
    (await prisma.user.findUniqueOrThrow({ where: { id: user.auth.user.id } })).mfaFailedAttempts;
  const stale = (user: Browser) =>
    prisma.session.update({
      where: { id: user.auth.session.id },
      data: { mfaVerifiedAt: new Date(Date.now() - 6 * 60_000) },
    });
  const invite = async (target: Browser, role: string) => {
    await prisma.session.update({
      where: { id: owner.auth.session.id },
      data: { mfaVerifiedAt: new Date() },
    });
    const res = await owner.call("post", "tenants/current/invitations", {
      identifier: target.identifier,
      role,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return notifications
      .get(target.identifier)
      ?.at(-1)
      ?.text.match(/Invitation token: ([A-Za-z0-9_-]+)/)?.[1];
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
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
    owner = new Browser(app);
    await owner.register();
    await owner.enroll();
    const company = await owner.call("post", "tenants", { name: "Passkey company" });
    expect(company.status, JSON.stringify(company.body)).toBe(201);
    tenant = (company.body as { tenant: { id: string } }).tenant.id;
  });

  afterAll(async () => {
    notificationSpy?.mockRestore();
    await app?.close();
  });

  it("documents the passkey operations and requires a session for them", async () => {
    const openApi = await request(app.getHttpServer()).get("/api/docs/openapi.json").expect(200);
    const operations = Object.values(
      (openApi.body as { paths: Record<string, Record<string, { operationId?: string }>> }).paths,
    ).flatMap((path) => Object.values(path).map((operation) => operation.operationId));
    for (const id of [
      "listPasskeys",
      "getPasskeyRegistrationOptions",
      "registerPasskey",
      "removePasskey",
      "getPasskeyStepUpOptions",
      "stepUpWithPasskey",
    ])
      expect(operations, id).toContain(id);
    const visitor = new Browser(app);
    await visitor.initialize();
    expect((await visitor.call("get", "auth/passkeys")).status).toBe(401);
    expect((await visitor.call("post", "auth/passkeys/registration/options", {})).status).toBe(401);
    expect((await visitor.call("post", "auth/passkeys/step-up/options", {})).status).toBe(401);
    // Mutations also need the CSRF token.
    const user = new Browser(app);
    await user.register();
    expect((await user.call("post", "auth/passkeys/registration/options", {}, false)).status).toBe(
      403,
    );
  });

  it("registers a passkey as the first factor and issues the one-time recovery codes", async () => {
    const user = new Browser(app);
    await user.register();
    const authenticator = new SoftwareAuthenticator();
    const optionsRes = await user.call("post", "auth/passkeys/registration/options", {});
    expect(optionsRes.status, JSON.stringify(optionsRes.body)).toBe(200);
    const options = passkeyRegistrationOptionsResponseSchema.parse(optionsRes.body).options;
    expect(options.rp).toEqual({ name: "PM-Buddy", id: "localhost" });
    expect(options.attestation).toBe("none");
    expect(options.authenticatorSelection.userVerification).toBe("required");
    expect(options.pubKeyCredParams.map((param) => param.alg)).toEqual([-8, -7, -257]);
    // The user handle is the account UUID's 16 bytes, not the email or phone number.
    expect(Buffer.from(options.user.id, "base64url").toString("hex")).toBe(
      user.auth.user.id.replaceAll("-", ""),
    );
    const credential = authenticator.register(options);
    const res = await user.call("post", "auth/passkeys/registration", {
      name: "Site phone",
      credential,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const body = res.body as AuthResponse & { passkey: { id: string; name: string } };
    expect(body.user).toMatchObject({ mfaEnabled: true, totpEnabled: false, passkeys: 1 });
    expect(body.session.mfaVerified).toBe(true);
    expect(body.recoveryCodes).toHaveLength(10);
    expect(body.passkey.name).toBe("Site phone");
    expect(notifications.get(user.identifier)!.at(-1)!.subject).toBe("Passkey added");

    const stored = await prisma.webAuthnCredential.findUniqueOrThrow({
      where: { id: body.passkey.id },
    });
    expect(stored).toMatchObject({
      userId: user.auth.user.id,
      credentialId: authenticator.id,
      counter: 0n,
      transports: ["internal"],
      deviceType: "singleDevice",
    });
    expect(stored.publicKey.length).toBeGreaterThan(64);
    const account = await prisma.user.findUniqueOrThrow({ where: { id: user.auth.user.id } });
    expect(account.mfaEnabled).toBe(true);
    expect(account.mfaSecret).toBeNull();
    expect(
      await prisma.recoveryCode.count({ where: { userId: user.auth.user.id, consumedAt: null } }),
    ).toBe(10);
    // Challenges are stored as digests, bound to the session, and already consumed.
    const challenge = await prisma.authChallenge.findFirstOrThrow({
      where: { sessionId: user.auth.session.id, purpose: "passkey-register" },
    });
    expect(challenge.digest).toBe(digest(options.challenge));
    expect(challenge.consumedAt).not.toBeNull();
    expect(challenge.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(5 * 60_000);

    const listing = await user.call("get", "auth/passkeys");
    expect(listing.status).toBe(200);
    const passkeys = passkeysResponseSchema.parse(listing.body).passkeys;
    expect(passkeys).toHaveLength(1);
    expect(JSON.stringify(listing.body)).not.toContain(authenticator.id);

    // The consumed challenge cannot be replayed.
    const replay = await user.call("post", "auth/passkeys/registration", {
      name: "Replayed",
      credential,
    });
    expect(replay.status).toBe(400);
    expect((replay.body as { code: string }).code).toBe("passkey-invalid");
    expect(await prisma.webAuthnCredential.count({ where: { userId: user.auth.user.id } })).toBe(1);
  });

  it("refuses wrong origins, missing user verification and duplicate credential IDs", async () => {
    const { user, authenticator } = await passkeyUser();
    await user.passkeyStepUp(authenticator);
    const other = new SoftwareAuthenticator();
    for (const overrides of [
      { origin: "https://evil.example" },
      { rpId: "evil.example" },
      { userVerified: false },
    ]) {
      const res = await user.registerPasskey(other, "Second", overrides);
      expect(res.status, JSON.stringify(overrides)).toBe(400);
    }
    // Another account cannot register a credential ID that is already registered.
    const intruder = new Browser(app);
    await intruder.register();
    const clone = new SoftwareAuthenticator(undefined, false, authenticator.credentialId);
    expect((await intruder.registerPasskey(clone, "Clone")).status).toBe(409);
    // Duplicate names on one account are refused; distinct names are fine.
    expect((await user.registerPasskey(other, "Site phone")).status).toBe(409);
    expect((await user.registerPasskey(other, "Backup key")).status).toBe(201);
    expect(user.auth.user.passkeys).toBe(2);
    expect(user.auth).not.toHaveProperty("recoveryCodes");
  });

  it("needs a fresh sign-in, or a fresh step-up once the account has a factor", async () => {
    const fresh = new Browser(app);
    await fresh.register();
    await prisma.session.update({
      where: { id: fresh.auth.session.id },
      data: { authTime: new Date(Date.now() - 6 * 60_000) },
    });
    expect((await fresh.call("post", "auth/passkeys/registration/options", {})).status).toBe(403);

    const { user, authenticator } = await passkeyUser();
    // A password alone must never add a factor: a new, fully fresh sign-in is still refused.
    const second = await signInAgain(user);
    expect(second.auth.mfaRequired).toBe(true);
    expect((await second.call("post", "auth/passkeys/registration/options", {})).status).toBe(403);
    expect((await second.call("post", "auth/mfa/enroll", {})).status).toBe(403);
    expect((await second.passkeyStepUp(authenticator)).status).toBe(200);
    expect((await second.registerPasskey(new SoftwareAuthenticator(), "Laptop")).status).toBe(201);
    // A passkey-only account can add TOTP after a fresh step-up.
    const enroll = await second.call("post", "auth/mfa/enroll", {});
    expect(enroll.status, JSON.stringify(enroll.body)).toBe(200);
  });

  it("discards a TOTP enrolment started before the account gained a factor (no password-only takeover)", async () => {
    const victim = new Browser(app);
    await victim.register();
    // An attacker with the password signs in while the account has no factor and starts TOTP.
    const attacker = await signInAgain(victim);
    const start = await attacker.call("post", "auth/mfa/enroll", {});
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    attacker.mfaSecret = (start.body as { secret: string }).secret;
    // The victim then adds a passkey as their first factor, which signs the attacker out.
    expect((await victim.registerPasskey(new SoftwareAuthenticator(), "Victim phone")).status).toBe(
      201,
    );
    // Neither the revoked session nor a new password-only session can confirm the old secret.
    expect([401, 403]).toContain(
      (await attacker.call("post", "auth/mfa/verify", { code: attacker.code() })).status,
    );
    const again = await signInAgain(victim);
    again.mfaSecret = attacker.mfaSecret;
    expect([401, 403]).toContain(
      (await again.call("post", "auth/mfa/verify", { code: again.code(30_000) })).status,
    );
    const stored = await prisma.user.findUniqueOrThrow({
      where: { identifier: victim.identifier },
    });
    expect(stored.mfaSecret).toBeNull();
    expect(stored.mfaPending).toBeNull();
  });

  it("confirms TOTP only from the session that started enrolment", async () => {
    const user = new Browser(app);
    await user.register();
    const start = await user.call("post", "auth/mfa/enroll", {});
    expect(start.status).toBe(200);
    const secret = (start.body as { secret: string }).secret;
    const other = await signInAgain(user);
    other.mfaSecret = secret;
    expect((await other.call("post", "auth/mfa/verify", { code: other.code() })).status).toBe(401);
    user.mfaSecret = secret;
    const confirmed = await user.call("post", "auth/mfa/verify", { code: user.code(30_000) });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  });

  it("steps up with a passkey exactly like TOTP: sets the session's MFA time", async () => {
    const { user, authenticator } = await passkeyUser();
    const session = await signInAgain(user);
    expect(session.auth.mfaRequired).toBe(true);
    expect((await session.call("get", "tenants")).status).toBe(403);
    // A passkey-only account has no TOTP secret to step up with.
    expect((await session.call("post", "auth/mfa/step-up", { code: "123456" })).status).toBe(401);
    const before = Date.now();
    const res = await session.passkeyStepUp(authenticator);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(session.auth).toMatchObject({ mfaRequired: false, session: { mfaVerified: true } });
    const stored = await prisma.session.findUniqueOrThrow({
      where: { id: session.auth.session.id },
    });
    expect(stored.mfaVerifiedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    const credential = await prisma.webAuthnCredential.findFirstOrThrow({
      where: { userId: user.auth.user.id },
    });
    expect(credential.counter).toBe(1n);
    expect(credential.lastUsedAt).not.toBeNull();
    expect((await session.call("get", "tenants")).status).toBe(200);
    expect((await session.call("post", "tenants", { name: "Fresh MFA company" })).status).toBe(201);
  });

  it("rejects replayed, expired and other sessions' challenges", async () => {
    const { user, authenticator } = await passkeyUser();
    const options = await stepUpOptions(user);
    const credential = authenticator.assert(options);
    expect((await user.call("post", "auth/passkeys/step-up", { credential })).status).toBe(200);
    // Replay of the same signed assertion: its challenge was consumed.
    expect((await user.call("post", "auth/passkeys/step-up", { credential })).status).toBe(401);

    const expiring = await stepUpOptions(user);
    await prisma.authChallenge.updateMany({
      where: { sessionId: user.auth.session.id, purpose: "passkey-step-up", consumedAt: null },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const late = authenticator.assert(expiring);
    expect((await user.call("post", "auth/passkeys/step-up", { credential: late })).status).toBe(
      401,
    );

    // A challenge issued to one session cannot be answered from another session of the user.
    const elsewhere = await signInAgain(user);
    const foreign = authenticator.assert(await stepUpOptions(user));
    expect(
      (await elsewhere.call("post", "auth/passkeys/step-up", { credential: foreign })).status,
    ).toBe(401);
    // Requesting new options supersedes the previous challenge.
    const first = await stepUpOptions(user);
    await stepUpOptions(user);
    const superseded = authenticator.assert(first);
    expect(
      (await user.call("post", "auth/passkeys/step-up", { credential: superseded })).status,
    ).toBe(401);
    expect(await failures(user)).toBe(4);
  });

  it("rejects wrong origins, wrong RP IDs, forged signatures, missing user verification and foreign credentials", async () => {
    const { user, authenticator } = await passkeyUser();
    for (const overrides of [
      { origin: "https://evil.example" },
      { origin: "http://localhost:3001" },
      { rpId: "evil.example" },
      { forgeSignature: true },
      { userVerified: false },
    ]) {
      const res = await user.passkeyStepUp(authenticator, overrides);
      expect(res.status, JSON.stringify(overrides)).toBe(401);
      await prisma.user.update({
        where: { id: user.auth.user.id },
        data: { mfaFailedAttempts: 0 },
      });
    }
    // Another account's passkey is unknown here, even with a valid signature.
    const { authenticator: theirs } = await passkeyUser();
    expect((await user.passkeyStepUp(theirs)).status).toBe(401);
    expect(await failures(user)).toBe(1);
    expect((await user.passkeyStepUp(authenticator)).status).toBe(200);
    expect(await failures(user)).toBe(0);
  });

  it("rejects signature counter regressions but accepts authenticators that always report zero", async () => {
    const { user, authenticator } = await passkeyUser();
    expect((await user.passkeyStepUp(authenticator, { counter: 7 })).status).toBe(200);
    expect((await user.passkeyStepUp(authenticator, { counter: 7 })).status).toBe(401);
    expect((await user.passkeyStepUp(authenticator, { counter: 3 })).status).toBe(401);
    expect((await user.passkeyStepUp(authenticator, { counter: 0 })).status).toBe(401);
    expect((await user.passkeyStepUp(authenticator, { counter: 8 })).status).toBe(200);
    const stored = await prisma.webAuthnCredential.findFirstOrThrow({
      where: { userId: user.auth.user.id },
    });
    expect(stored.counter).toBe(8n);

    const synced = await passkeyUser(new SoftwareAuthenticator(undefined, true));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await synced.user.passkeyStepUp(synced.authenticator)).status).toBe(200);
    }
  });

  it("lets a passkey-only user hold a privileged permission (the Finance role)", async () => {
    const { user, authenticator } = await passkeyUser();
    expect(MFA_REQUIRED_PERMISSIONS).toContain("payments.approve");
    const token = await invite(user, "finance");
    await stale(user);
    expect((await user.call("post", "tenants/invitations/accept", { token })).status).toBe(403);
    expect((await user.passkeyStepUp(authenticator)).status).toBe(200);
    const accepted = await user.call("post", "tenants/invitations/accept", { token });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const select = await user.call("post", `tenants/${tenant}/select`, {});
    expect(select.status, JSON.stringify(select.body)).toBe(200);
    const companies = tenantsResponseSchema.parse((await user.call("get", "tenants")).body);
    expect(companies.tenants[0]).toMatchObject({ role: "finance" });
    expect(companies.tenants[0]!.permissions).toContain("payments.approve");
    const account = await prisma.user.findUniqueOrThrow({ where: { id: user.auth.user.id } });
    expect(account).toMatchObject({ mfaEnabled: true, mfaSecret: null });
  });

  it("refuses to remove a privileged user's last factor, in the API and in the database", async () => {
    const { user, authenticator } = await passkeyUser();
    const token = await invite(user, "finance");
    expect((await user.call("post", "tenants/invitations/accept", { token })).status).toBe(200);
    const [passkey] = passkeysResponseSchema.parse(
      (await user.call("get", "auth/passkeys")).body,
    ).passkeys;
    await stale(user);
    expect((await user.call("delete", `auth/passkeys/${passkey!.id}`)).status).toBe(403);
    expect((await user.passkeyStepUp(authenticator)).status).toBe(200);
    const refused = await user.call("delete", `auth/passkeys/${passkey!.id}`);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    // Database backstop: the users.mfa_enabled trigger refuses the same removal directly…
    await expect(
      prisma.webAuthnCredential.delete({ where: { id: passkey!.id } }),
    ).rejects.toThrow();
    // …and when the API's own check is bypassed (as in a race with a role grant), the
    // trigger's refusal still becomes a 409 rather than a server error.
    const bypass = vi.spyOn(app.get(AuthService), "holdsPrivilegedRole").mockResolvedValue(false);
    const raced = await user.call("delete", `auth/passkeys/${passkey!.id}`);
    bypass.mockRestore();
    expect(raced.status, JSON.stringify(raced.body)).toBe(409);
    expect(await prisma.webAuthnCredential.count({ where: { userId: user.auth.user.id } })).toBe(1);

    // With a second factor, either passkey can go.
    expect((await user.registerPasskey(new SoftwareAuthenticator(), "Backup key")).status).toBe(
      201,
    );
    const removed = await user.call("delete", `auth/passkeys/${passkey!.id}`);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(notifications.get(user.identifier)!.at(-1)!.subject).toBe("Passkey removed");
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.auth.user.id } })).mfaEnabled,
    ).toBe(true);
    // Someone else's passkey ID is simply not found.
    const { user: stranger } = await passkeyUser();
    const theirs = passkeysResponseSchema.parse((await stranger.call("get", "auth/passkeys")).body)
      .passkeys[0]!;
    expect((await user.call("delete", `auth/passkeys/${theirs.id}`)).status).toBe(404);
  });

  it("lets a user without an MFA-required permission remove their last passkey", async () => {
    const { user } = await passkeyUser();
    const [passkey] = passkeysResponseSchema.parse(
      (await user.call("get", "auth/passkeys")).body,
    ).passkeys;
    expect((await user.call("delete", `auth/passkeys/${passkey!.id}`)).status).toBe(200);
    const account = await prisma.user.findUniqueOrThrow({ where: { id: user.auth.user.id } });
    expect(account.mfaEnabled).toBe(false);
    const me = await user.call("get", "auth/me");
    expect((me.body as AuthResponse).user).toMatchObject({
      mfaEnabled: false,
      totpEnabled: false,
      passkeys: 0,
    });
    expect((await user.call("post", "auth/passkeys/step-up/options", {})).status).toBe(404);
  });

  it("adds a passkey next to TOTP without replacing the recovery codes", async () => {
    const user = new Browser(app);
    await user.register();
    await user.enroll();
    const recoveryCodes = () =>
      prisma.recoveryCode.findMany({
        where: { userId: user.auth.user.id },
        orderBy: { id: "asc" },
      });
    const codes = await recoveryCodes();
    expect(codes).toHaveLength(10);
    const res = await user.registerPasskey(new SoftwareAuthenticator(), "Office key");
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).not.toHaveProperty("recoveryCodes");
    expect(user.auth.user).toMatchObject({ mfaEnabled: true, totpEnabled: true, passkeys: 1 });
    expect(await recoveryCodes()).toEqual(codes);
  });

  it("locks MFA after five failed assertions, signs the session out and notifies the user", async () => {
    const { user, authenticator } = await passkeyUser();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect((await user.passkeyStepUp(authenticator, { forgeSignature: true })).status).toBe(401);
    }
    expect((await user.passkeyStepUp(authenticator, { forgeSignature: true })).status).toBe(429);
    expect(notifications.get(user.identifier)!.at(-1)!.subject).toBe(
      "Two-step verification locked",
    );
    expect((await user.call("get", "auth/me")).status).toBe(401);
    await user.initialize();
    await user.login();
    // Locked: no options, and a genuine assertion is refused before it is checked.
    expect((await user.call("post", "auth/passkeys/step-up/options", {})).status).toBe(429);
    await prisma.user.update({
      where: { id: user.auth.user.id },
      data: { mfaLockedUntil: new Date(Date.now() - 1000) },
    });
    expect((await user.passkeyStepUp(authenticator)).status).toBe(200);
  });
});
