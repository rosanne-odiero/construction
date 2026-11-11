import { randomInt, randomUUID } from "node:crypto";
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { Secret, TOTP } from "otpauth";
import {
  authResponseSchema,
  messageResponseSchema,
  mfaEnrollmentResponseSchema,
  mfaVerificationResponseSchema,
  sessionsResponseSchema,
} from "@pm-buddy/validation";
import type { Prisma, Session, User } from "../../generated/prisma/client.js";
import { AppConfig } from "../../config/app-config.js";
import { PrismaService } from "../../infra/prisma.service.js";
import {
  AuthSecurity,
  cookie,
  digest,
  hashPassword,
  opaqueToken,
  verifyPassword,
} from "./auth-security.service.js";
import { PasswordPolicy } from "./password-policy.js";
import { grantOf, requiresMfa } from "./role-grants.js";
import { TenantDatabase } from "./tenant-database.service.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY_SECONDS = 86_400;
/** Consecutive wrong MFA or recovery codes before MFA locks (brief §7: lockout on OTP attempts). */
const MFA_MAX_FAILURES = 5;
const MFA_LOCK_MINUTES = 15;
/** Fresh sign-in or step-up window for enrolling factors and sensitive actions. */
export const FRESH_MINUTES = 5;
export type MfaOutcome = "ok" | "invalid" | "locked" | "locked-now";
export const genericMessage = messageResponseSchema.parse({
  message: "If the account is eligible, instructions have been sent.",
});
export type Principal = {
  user: User;
  session: Session;
  mfaRequired: boolean;
  /** Registered passkeys (MFA factors besides the TOTP secret). */
  passkeys: number;
};
type UserWithFactors = User & { _count: { passkeys: number } };
const withFactors = { _count: { select: { passkeys: true } } } as const;
export const isFresh = (at: Date | null | undefined): boolean =>
  Boolean(at && Date.now() - at.getTime() <= FRESH_MINUTES * MINUTE);
export const requestId = (req: Request): string =>
  typeof req.headers["x-request-id"] === "string" &&
  /^[A-Za-z0-9-]{8,64}$/.test(req.headers["x-request-id"])
    ? req.headers["x-request-id"]
    : randomUUID();
/** A new sign-in session: 8 hours with an MFA factor, otherwise 24; 30 minutes idle. */
export const newSessionData = (
  user: Pick<User, "id" | "mfaEnabled">,
  authMethod: "password" | "google" | "pin" = "password",
) => ({
  userId: user.id,
  authMethod,
  expiresAt: new Date(Date.now() + (user.mfaEnabled ? 8 : 24) * HOUR),
  idleExpiresAt: new Date(Date.now() + 30 * MINUTE),
});

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    readonly security: AuthSecurity,
    private readonly tenantDb: TenantDatabase,
    private readonly passwords: PasswordPolicy,
    private readonly config: AppConfig,
  ) {}

  /**
   * The main limits key on what an attacker cannot share with other users: an account identifier,
   * user, session or token. A per-IP limit is added only when a trusted proxy reports the client
   * address (TRUST_PROXY); otherwise every request through the web app would share one bucket.
   */
  async throttle(
    req: Request,
    action: string,
    key?: string,
    limit: { maximum: number; seconds: number } = { maximum: 10, seconds: 300 },
  ): Promise<void> {
    const address = this.security.clientAddress(req);
    if (address) await this.security.limit(`${action}:ip:${address}`, 60, 60);
    if (key) await this.security.limit(`${action}:key:${key}`, limit.maximum, limit.seconds);
  }

  async register(
    input: { identifier: string; password: string; displayName: string },
    req: Request,
  ) {
    await this.throttle(req, "register", input.identifier);
    // Depends only on the submitted values, never on whether the account exists.
    await this.passwords.assertAcceptable(input.password, input);
    const passwordHash = await hashPassword(input.password);
    const existing = await this.prisma.user.findUnique({ where: { identifier: input.identifier } });
    if (existing?.verifiedAt) {
      // Same work as the other paths (a second hash), so timing doesn't reveal the account exists.
      await hashPassword(opaqueToken());
      this.security.notifyLater(
        existing.identifier,
        "Registration attempt",
        "Someone tried to register a PM-Buddy account with your details. You already have an account: sign in, or reset your password if you have forgotten it.",
      );
      return genericMessage;
    }
    let user: User;
    if (existing) {
      // Pre-hijacking defence: an unverified account takes the latest registration's password,
      // and verification must present that password, so whoever proves control of the identifier
      // also sets the password. Earlier codes are invalidated by sendVerification.
      user = await this.prisma.user.update({
        where: { id: existing.id },
        data: { passwordHash, displayName: input.displayName, failedLogins: 0, lockedUntil: null },
      });
    } else {
      try {
        user = await this.prisma.user.create({
          data: { identifier: input.identifier, displayName: input.displayName, passwordHash },
        });
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "P2002"
        ) {
          return genericMessage;
        }
        throw error;
      }
    }
    await this.sendVerification(user);
    return genericMessage;
  }

  private async sendVerification(user: User): Promise<void> {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const encoded = await hashPassword(code);
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id}::uuid FOR UPDATE`;
      await tx.authChallenge.updateMany({
        where: { userId: user.id, purpose: "verify", consumedAt: null },
        data: { consumedAt: new Date() },
      });
      await tx.authChallenge.create({
        data: {
          userId: user.id,
          purpose: "verify",
          digest: encoded,
          expiresAt: new Date(Date.now() + 5 * MINUTE),
        },
      });
    });
    this.security.notifyLater(
      user.identifier,
      "Verify your account",
      `Verification code: ${code}\nExpires in five minutes.`,
    );
  }

  async resend(identifier: string, req: Request) {
    await this.throttle(req, "verification-resend", identifier);
    const user = await this.prisma.user.findUnique({ where: { identifier } });
    if (user && !user.verifiedAt) await this.sendVerification(user);
    else await hashPassword(opaqueToken()); // matches sendVerification's cost (no timing oracle)
    return genericMessage;
  }

  async verifyIdentifier(identifier: string, code: string, password: string, req: Request) {
    await this.throttle(req, "verify", identifier);
    // Fresh challenges can be requested repeatedly, so cap guesses per identifier per day too.
    await this.security.limit(`verify-day:key:${identifier}`, 20, DAY_SECONDS);
    const valid = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { identifier } });
      if (!user || user.verifiedAt) {
        await verifyPassword(await this.security.dummyPassword, password);
        return false;
      }
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id}::uuid FOR UPDATE`;
      const challenge = await tx.authChallenge.findFirst({
        where: { userId: user.id, purpose: "verify", consumedAt: null },
        orderBy: { expiresAt: "desc" },
      });
      if (!challenge || challenge.expiresAt <= new Date() || challenge.attempts >= 5) return false;
      await tx.authChallenge.update({
        where: { id: challenge.id },
        data: { attempts: { increment: 1 } },
      });
      // Both checks always run: the code proves control of the identifier, the password proves
      // this person set it (see register).
      const codeMatches = await verifyPassword(challenge.digest, code);
      const passwordMatches = await verifyPassword(user.passwordHash, password);
      if (!codeMatches || !passwordMatches) return false;
      await tx.authChallenge.update({
        where: { id: challenge.id },
        data: { consumedAt: new Date() },
      });
      await tx.user.update({ where: { id: user.id }, data: { verifiedAt: new Date() } });
      return true;
    });
    if (!valid) {
      throw new UnauthorizedException("Invalid or expired verification code, or wrong password");
    }
    return { message: "Account verified. You can now sign in." };
  }

  async login(identifier: string, password: string, req: Request, res: Response) {
    await this.throttle(req, "login", identifier);
    const result = await this.prisma.$transaction(
      async (tx) => {
        const found = await tx.user.findUnique({ where: { identifier } });
        if (!found) {
          await verifyPassword(await this.security.dummyPassword, password);
          return null;
        }
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${found.id}::uuid FOR UPDATE`;
        const user = await tx.user.findUniqueOrThrow({ where: { id: found.id } });
        const matches = await verifyPassword(user.passwordHash, password);
        if (user.lockedUntil && user.lockedUntil > new Date()) return null;
        if (!matches) {
          const failures = (user.lockedUntil ? 0 : user.failedLogins) + 1;
          await tx.user.update({
            where: { id: user.id },
            data: {
              failedLogins: failures,
              lockedUntil: failures >= 5 ? new Date(Date.now() + 15 * MINUTE) : null,
            },
          });
          return null;
        }
        if (!user.verifiedAt) return null;
        await tx.user.update({
          where: { id: user.id },
          data: { failedLogins: 0, lockedUntil: null },
        });
        const session = await tx.session.create({ data: newSessionData(user) });
        return { user, session };
      },
      { timeout: 10_000 },
    );
    if (!result) throw new UnauthorizedException("Invalid credentials or account unavailable");
    return this.issue(result.session.id, res);
  }

  async principal(req: Request): Promise<Principal> {
    const claims = await this.security.accessClaims(req);
    const session = await this.prisma.session.findUnique({
      where: { id: claims.sessionId },
      include: { user: { include: withFactors } },
    });
    if (
      !session ||
      session.userId !== claims.userId ||
      session.generation !== claims.generation ||
      session.revokedAt ||
      session.expiresAt <= new Date() ||
      session.idleExpiresAt <= new Date() ||
      !session.user.verifiedAt
    ) {
      throw new UnauthorizedException("Session expired or revoked");
    }
    return this.describe(session.user, session);
  }

  /** Whether the user holds an MFA-required permission in any company (brief §7). */
  async holdsPrivilegedRole(userId: string): Promise<boolean> {
    const memberships = await this.tenantDb.run(
      {
        userId,
        tenantId: null,
        requestId: "authentication",
      },
      (tx) =>
        tx.membership.findMany({
          where: { userId },
          select: {
            role: true,
            customRoleId: true,
            customRole: { select: { name: true, permissions: true, tenantWide: true } },
          },
        }),
    );
    return memberships.some((membership) => requiresMfa(grantOf(membership)));
  }

  /** MFA is mandatory once the user has a factor or holds an MFA-required permission. */
  private async describe(
    { _count, ...user }: UserWithFactors,
    session: Session,
  ): Promise<Principal> {
    const privileged = await this.holdsPrivilegedRole(user.id);
    return {
      user,
      session,
      mfaRequired: user.mfaEnabled || privileged,
      passkeys: _count.passkeys,
    };
  }

  response(principal: Principal) {
    return authResponseSchema.parse({
      user: {
        id: principal.user.id,
        identifier: principal.user.identifier,
        displayName: principal.user.displayName,
        verified: Boolean(principal.user.verifiedAt),
        mfaEnabled: principal.user.mfaEnabled,
        totpEnabled: principal.user.mfaSecret !== null,
        passkeys: principal.passkeys,
      },
      session: {
        id: principal.session.id,
        tenantId: principal.session.activeTenantId,
        mfaVerified: Boolean(principal.session.mfaVerifiedAt),
        expiresAt: principal.session.expiresAt.toISOString(),
      },
      mfaRequired: principal.mfaRequired && !principal.session.mfaVerifiedAt,
    });
  }

  private async credentials(tx: Prisma.TransactionClient, sessionId: string) {
    const now = new Date();
    const session = await tx.session.update({
      where: { id: sessionId },
      data: {
        generation: { increment: 1 },
        lastSeenAt: now,
        idleExpiresAt: new Date(now.getTime() + 30 * MINUTE),
      },
    });
    await tx.refreshToken.updateMany({ where: { sessionId, usedAt: null }, data: { usedAt: now } });
    const refresh = opaqueToken();
    await tx.refreshToken.create({
      data: { digest: digest(refresh), sessionId, expiresAt: session.expiresAt },
    });
    return { session, refresh };
  }

  private async deliver(value: { session: Session; refresh: string }, res: Response) {
    const token = await this.security.accessToken(
      value.session.userId,
      value.session.id,
      value.session.generation,
    );
    this.security.setCookie(res, "at", token, 10 * MINUTE);
    this.security.setCookie(
      res,
      "rt",
      value.refresh,
      Math.max(0, value.session.expiresAt.getTime() - Date.now()),
    );
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: value.session.userId },
      include: withFactors,
    });
    return this.response(await this.describe(user, value.session));
  }

  async issue(sessionId: string, res: Response) {
    const value = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM sessions WHERE id = ${sessionId}::uuid FOR UPDATE`;
      const current = await tx.session.findUniqueOrThrow({ where: { id: sessionId } });
      if (
        current.revokedAt ||
        current.expiresAt <= new Date() ||
        current.idleExpiresAt <= new Date()
      ) {
        throw new UnauthorizedException("Session expired or revoked");
      }
      return this.credentials(tx, sessionId);
    });
    return this.deliver(value, res);
  }

  async refresh(req: Request, res: Response) {
    const token = cookie(req, this.security.name("rt"));
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new UnauthorizedException("Refresh credential required");
    await this.throttle(req, "refresh", digest(token), { maximum: 20, seconds: 60 });
    const value = await this.prisma.$transaction(async (tx) => {
      const credential = await tx.refreshToken.findUnique({ where: { digest: digest(token) } });
      if (!credential) return null;
      await tx.$queryRaw`SELECT id FROM sessions WHERE id = ${credential.sessionId}::uuid FOR UPDATE`;
      const session = await tx.session.findUniqueOrThrow({ where: { id: credential.sessionId } });
      const current = await tx.refreshToken.findUniqueOrThrow({ where: { digest: digest(token) } });
      if (current.usedAt) {
        await tx.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
        const user = await tx.user.findUniqueOrThrow({ where: { id: session.userId } });
        return { replayed: user.identifier };
      }
      if (
        session.revokedAt ||
        session.expiresAt <= new Date() ||
        session.idleExpiresAt <= new Date() ||
        current.expiresAt <= new Date()
      )
        return null;
      return this.credentials(tx, session.id);
    });
    if (!value || "replayed" in value) {
      this.security.clearCookies(res);
      if (value && "replayed" in value) {
        this.security.notifyLater(
          value.replayed,
          "Session security alert",
          "A previously used refresh credential was replayed. The entire affected session has been revoked. Sign in again.",
        );
      }
      throw new UnauthorizedException(
        "Refresh credential expired, revoked or reused; sign in again",
      );
    }
    return this.deliver(value, res);
  }

  requireMfa(principal: Principal, fresh = false): void {
    const at = principal.session.mfaVerifiedAt;
    if ((principal.mfaRequired || fresh) && (!principal.user.mfaEnabled || !at)) {
      throw new ForbiddenException("MFA verification required");
    }
    if (fresh && !isFresh(at)) {
      // A specific code lets clients offer a step-up prompt instead of a generic refusal.
      throw new ForbiddenException({
        message: "Fresh MFA step-up required",
        code: "step-up-required",
      });
    }
  }

  /**
   * Adding a factor needs a sign-in (or step-up) within five minutes. Once the account has a
   * factor, only a fresh step-up with an existing factor will do: a password alone must never be
   * enough to add a second factor of the attacker's choosing.
   */
  requireFactorEnrolment(principal: Principal): void {
    // A guessed six-digit PIN must never let someone attach a factor of their own choosing.
    if (principal.session.authMethod === "pin")
      throw new ForbiddenException("Sign in with your password before enrolling MFA");
    if (principal.user.mfaEnabled) {
      this.requireMfa(principal, true);
      return;
    }
    if (!isFresh(principal.session.authTime) && !isFresh(principal.session.mfaVerifiedAt)) {
      throw new ForbiddenException("Sign in again before enrolling MFA");
    }
  }

  /**
   * The same rule, checked against the user and session rows locked in the current transaction,
   * so a factor added by another session in the meantime is taken into account.
   */
  assertFactorEnrolment(user: User, session: Session): void {
    if (session.revokedAt) throw new UnauthorizedException("Session expired or revoked");
    if (session.authMethod === "pin")
      throw new ForbiddenException("Sign in with your password before enrolling MFA");
    if (user.mfaEnabled) {
      if (!isFresh(session.mfaVerifiedAt)) {
        throw new ForbiddenException("Fresh MFA step-up required");
      }
      return;
    }
    if (!isFresh(session.authTime) && !isFresh(session.mfaVerifiedAt)) {
      throw new ForbiddenException("Sign in again before enrolling MFA");
    }
  }

  async enroll(principal: Principal) {
    if (principal.user.mfaSecret) throw new ConflictException("MFA is already enrolled");
    this.requireFactorEnrolment(principal);
    const secret = new Secret({ size: 20 });
    const totp = new TOTP({ issuer: "PM-Buddy", label: principal.user.identifier, secret });
    await this.prisma.user.update({
      where: { id: principal.user.id },
      data: {
        mfaPending: await this.security.encrypt(secret.base32, `totp:${principal.user.id}`),
        mfaPendingUntil: new Date(Date.now() + 10 * MINUTE),
        mfaPendingSessionId: principal.session.id,
      },
    });
    return mfaEnrollmentResponseSchema.parse({ secret: secret.base32, uri: totp.toString() });
  }

  async verifyMfa(
    principal: Principal,
    code: string,
    req: Request,
    res: Response,
    enroll: boolean,
  ) {
    await this.throttle(req, "mfa", principal.user.id);
    await this.security.limit(`mfa-day:key:${principal.user.id}`, 30, DAY_SECONDS);
    const recoveryCodes = enroll
      ? Array.from({ length: 10 }, () => opaqueToken().slice(0, 24))
      : [];
    const outcome = await this.prisma.$transaction(async (tx): Promise<MfaOutcome> => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${principal.user.id}::uuid FOR UPDATE`;
      const user = await tx.user.findUniqueOrThrow({ where: { id: principal.user.id } });
      if (user.mfaLockedUntil && user.mfaLockedUntil > new Date()) return "locked";
      if (enroll) {
        // A pending secret only counts for the session that started enrolment, and that session
        // must still meet the enrolment rule now: the account may have gained a factor since.
        const session = await tx.session.findUniqueOrThrow({ where: { id: principal.session.id } });
        if (user.mfaPendingSessionId !== session.id) return "invalid";
        this.assertFactorEnrolment(user, session);
      }
      const encrypted = enroll ? user.mfaPending : user.mfaSecret;
      if (
        !encrypted ||
        (enroll &&
          (user.mfaSecret !== null || !user.mfaPendingUntil || user.mfaPendingUntil <= new Date()))
      )
        return "invalid";
      const secret = await this.security.decrypt(encrypted, `totp:${user.id}`);
      const totp = new TOTP({
        secret: Secret.fromBase32(secret),
        issuer: "PM-Buddy",
        label: user.identifier,
      });
      const timestamp = Date.now();
      const delta = totp.validate({ token: code, window: 1, timestamp });
      const counter = delta === null ? null : BigInt(totp.counter({ timestamp }) + delta);
      if (counter === null || counter <= user.mfaCounter) {
        return this.recordMfaFailure(tx, user, principal.session.id);
      }
      await tx.user.update({
        where: { id: user.id },
        data: {
          mfaCounter: counter,
          mfaFailedAttempts: 0,
          ...(enroll
            ? {
                mfaSecret: encrypted,
                mfaPending: null,
                mfaPendingUntil: null,
                mfaPendingSessionId: null,
                mfaEnabled: true,
              }
            : {}),
        },
      });
      if (enroll) {
        await tx.recoveryCode.deleteMany({ where: { userId: user.id } });
        await tx.recoveryCode.createMany({
          data: recoveryCodes.map((value) => ({ userId: user.id, digest: digest(value) })),
        });
        await tx.session.updateMany({
          where: { userId: user.id, id: { not: principal.session.id }, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
      await tx.session.update({
        where: { id: principal.session.id },
        data: {
          mfaVerifiedAt: new Date(),
          ...(enroll
            ? {
                expiresAt: new Date(
                  Math.min(principal.session.expiresAt.getTime(), Date.now() + 8 * HOUR),
                ),
              }
            : {}),
        },
      });
      return "ok";
    });
    this.rejectMfaOutcome(outcome, principal, res, "Invalid, expired or reused MFA code");
    const response = await this.issue(principal.session.id, res);
    return enroll ? mfaVerificationResponseSchema.parse({ ...response, recoveryCodes }) : response;
  }

  async recover(principal: Principal, code: string, req: Request, res: Response) {
    await this.throttle(req, "mfa-recovery", principal.user.id);
    if (!principal.user.mfaEnabled) throw new UnauthorizedException("MFA is not enabled");
    const outcome = await this.prisma.$transaction(async (tx): Promise<MfaOutcome> => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${principal.user.id}::uuid FOR UPDATE`;
      const user = await tx.user.findUniqueOrThrow({ where: { id: principal.user.id } });
      if (user.mfaLockedUntil && user.mfaLockedUntil > new Date()) return "locked";
      const updated = await tx.recoveryCode.updateMany({
        where: { userId: user.id, digest: digest(code), consumedAt: null },
        data: { consumedAt: new Date() },
      });
      if (!updated.count) return this.recordMfaFailure(tx, user, principal.session.id);
      await tx.user.update({ where: { id: user.id }, data: { mfaFailedAttempts: 0 } });
      await tx.session.update({
        where: { id: principal.session.id },
        data: { mfaVerifiedAt: new Date() },
      });
      return "ok";
    });
    this.rejectMfaOutcome(outcome, principal, res, "Invalid or used recovery code");
    return this.issue(principal.session.id, res);
  }

  /**
   * Counts a wrong MFA or recovery code. After MFA_MAX_FAILURES in a row, MFA locks for
   * MFA_LOCK_MINUTES and the session is revoked, so the password must be entered again too.
   */
  async recordMfaFailure(
    tx: Prisma.TransactionClient,
    user: User,
    sessionId: string,
  ): Promise<MfaOutcome> {
    const failures = user.mfaFailedAttempts + 1;
    if (failures < MFA_MAX_FAILURES) {
      await tx.user.update({ where: { id: user.id }, data: { mfaFailedAttempts: failures } });
      return "invalid";
    }
    await tx.user.update({
      where: { id: user.id },
      data: {
        mfaFailedAttempts: 0,
        mfaLockedUntil: new Date(Date.now() + MFA_LOCK_MINUTES * MINUTE),
      },
    });
    await tx.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
    return "locked-now";
  }

  rejectMfaOutcome(
    outcome: MfaOutcome,
    principal: Principal,
    res: Response,
    invalidMessage: string,
  ): void {
    if (outcome === "ok") return;
    if (outcome === "invalid") throw new UnauthorizedException(invalidMessage);
    if (outcome === "locked-now") {
      this.security.clearCookies(res);
      this.security.notifyLater(
        principal.user.identifier,
        "Two-step verification locked",
        `Too many wrong verification codes or failed passkey checks were entered for your PM-Buddy account. Two-step verification is locked for ${MFA_LOCK_MINUTES} minutes and you have been signed out. If this wasn't you, change your password.`,
      );
    }
    throw new HttpException(
      "Too many wrong codes; two-step verification is temporarily locked",
      429,
    );
  }

  async forgot(identifier: string, req: Request) {
    await this.throttle(req, "password-forgot", identifier);
    const user = await this.prisma.user.findUnique({ where: { identifier } });
    if (user?.verifiedAt) {
      const token = opaqueToken();
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id}::uuid FOR UPDATE`;
        await tx.authChallenge.updateMany({
          where: { userId: user.id, purpose: "reset", consumedAt: null },
          data: { consumedAt: new Date() },
        });
        await tx.authChallenge.create({
          data: {
            userId: user.id,
            purpose: "reset",
            digest: digest(token),
            expiresAt: new Date(Date.now() + 15 * MINUTE),
          },
        });
      });
      this.security.notifyLater(
        identifier,
        user.pinHash ? "Reset your PIN" : "Reset your password",
        user.pinHash
          ? `Reset your PM-Buddy PIN: ${new URL(this.config.get("WEB_ORIGIN")).origin}/worker/pin?token=${token}\nExpires in fifteen minutes. To set a password instead, use this token in the account console: ${token}`
          : `Password reset token: ${token}\nExpires in fifteen minutes.`,
      );
    }
    return genericMessage;
  }

  async reset(token: string, password: string, req: Request) {
    await this.throttle(req, "password-reset", digest(token), { maximum: 5, seconds: 900 });
    // The token is a 256-bit secret, so checking it first reveals nothing; the account it belongs
    // to supplies the context for the strength check.
    const pending = await this.prisma.authChallenge.findFirst({
      where: {
        purpose: "reset",
        digest: digest(token),
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { user: { select: { identifier: true, displayName: true } } },
    });
    if (!pending) throw new UnauthorizedException("Invalid or expired reset token");
    await this.passwords.assertAcceptable(password, pending.user);
    const passwordHash = await hashPassword(password);
    const valid = await this.prisma.$transaction(async (tx) => {
      const found = await tx.authChallenge.findFirst({
        where: {
          purpose: "reset",
          digest: digest(token),
          consumedAt: null,
          expiresAt: { gt: new Date() },
        },
      });
      if (!found) return false;
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${found.userId}::uuid FOR UPDATE`;
      const challenge = await tx.authChallenge.updateMany({
        where: { id: found.id, consumedAt: null, expiresAt: { gt: new Date() } },
        data: { consumedAt: new Date() },
      });
      if (!challenge.count) return false;
      await tx.user.update({
        where: { id: found.userId },
        data: { passwordHash, failedLogins: 0, lockedUntil: null },
      });
      await tx.session.updateMany({
        where: { userId: found.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return true;
    });
    if (!valid) throw new UnauthorizedException("Invalid or expired reset token");
    return { message: "Password changed. Sign in again." };
  }

  async sessions(principal: Principal) {
    const sessions = await this.prisma.session.findMany({
      where: {
        userId: principal.user.id,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        idleExpiresAt: { gt: new Date() },
      },
      select: { id: true, createdAt: true, lastSeenAt: true, expiresAt: true },
      orderBy: { createdAt: "desc" },
    });
    return sessionsResponseSchema.parse({
      sessions: sessions.map((session) => ({
        ...session,
        createdAt: session.createdAt.toISOString(),
        lastSeenAt: session.lastSeenAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        current: session.id === principal.session.id,
      })),
    });
  }

  /**
   * Always clears the cookies and succeeds. The session is found through the access token or,
   * once that has expired, the refresh token, so signing out works on a shared computer after any
   * idle time (a stale refresh cookie must not let the next person restore the session).
   */
  async logout(req: Request, res: Response) {
    let sessionId: string | undefined;
    try {
      sessionId = (await this.security.accessClaims(req)).sessionId;
    } catch {
      const token = cookie(req, this.security.name("rt"));
      if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) {
        const credential = await this.prisma.refreshToken.findUnique({
          where: { digest: digest(token) },
        });
        sessionId = credential?.sessionId;
      }
    }
    if (sessionId) {
      await this.prisma.session.updateMany({
        where: { id: sessionId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    this.security.clearCookies(res);
    return messageResponseSchema.parse({ message: "Signed out." });
  }

  async revoke(principal: Principal, id: string, res: Response) {
    const result = await this.prisma.session.updateMany({
      where: { id, userId: principal.user.id },
      data: { revokedAt: new Date() },
    });
    if (!result.count) throw new NotFoundException("Session not found");
    if (id === principal.session.id) this.security.clearCookies(res);
    return { message: "Session revoked." };
  }
}
