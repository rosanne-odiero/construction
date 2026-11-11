import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { pinProblem } from "@pm-buddy/domain";
import { portalFor } from "@pm-buddy/types";
import { PrismaService } from "../../infra/prisma.service.js";
import {
  AuthSecurity,
  digest,
  hashPassword,
  opaqueToken,
  verifyPassword,
} from "./auth-security.service.js";
import { AuthService, newSessionData, requestId } from "./auth.service.js";
import { TenancyService } from "./tenancy.service.js";
import { pinSessionLimited } from "./tenant-scope.service.js";
import { TenantDatabase } from "./tenant-database.service.js";

const MINUTE = 60_000;
const DAY_SECONDS = 86_400;
const weakPin = (problem: string) =>
  new BadRequestException({
    code: "pin-too-weak",
    reason: problem,
    message: "Choose a PIN that is not repeated, a run of digits or the end of your phone number",
  });

/**
 * Labourer sign-in with a Kenyan phone number and a six-digit PIN. Accounts are created only
 * from a labourer invitation (the SMS link proves control of the phone). PIN sessions are
 * limited to the labourer portal (TenantScope), so a guessed PIN never unlocks staff data;
 * guessing is bounded by the shared five-failure lockout and per-number limits.
 */
@Injectable()
export class PinService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly db: TenantDatabase,
    private readonly auth: AuthService,
    private readonly security: AuthSecurity,
    private readonly tenancy: TenancyService,
  ) {}

  async login(identifier: string, pin: string, req: Request, res: Response) {
    await this.auth.throttle(req, "pin-login", identifier);
    await this.security.limit(`pin-day:key:${identifier}`, 30, DAY_SECONDS);
    const result = await this.prisma.$transaction(
      async (tx) => {
        const found = await tx.user.findUnique({ where: { identifier } });
        if (!found?.pinHash) {
          await verifyPassword(await this.security.dummyPassword, pin);
          return null;
        }
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${found.id}::uuid FOR UPDATE`;
        const user = await tx.user.findUniqueOrThrow({ where: { id: found.id } });
        const matches = await verifyPassword(user.pinHash!, pin);
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
        return tx.session.create({ data: newSessionData(user, "pin") });
      },
      { timeout: 10_000 },
    );
    if (!result)
      throw new UnauthorizedException("Invalid phone number or PIN, or account unavailable");
    return this.auth.issue(result.id, res);
  }

  /**
   * Creates a labourer's account from their invitation link and joins the company, in one
   * transaction: the account, membership, project assignment and session commit together or not
   * at all. An existing verified account must sign in and accept the invitation instead.
   */
  async join(
    input: { identifier: string; token: string; displayName: string; pin: string },
    req: Request,
    res: Response,
  ) {
    await this.auth.throttle(req, "pin-join", digest(input.token), { maximum: 5, seconds: 900 });
    const problem = pinProblem(input.pin, input.identifier);
    if (problem) throw weakPin(problem);
    const [pinHash, unusable] = await Promise.all([
      hashPassword(input.pin),
      hashPassword(opaqueToken()),
    ]);
    const existing = await this.prisma.user.findUnique({ where: { identifier: input.identifier } });
    if (existing?.verifiedAt) {
      // Only the holder of a valid invitation learns that the number already has an account.
      const invited = await this.db.run(
        { userId: existing.id, tenantId: null, requestId: requestId(req) },
        (tx) =>
          tx.invitation.findFirst({
            where: {
              digest: digest(input.token),
              identifier: input.identifier,
              acceptedAt: null,
              expiresAt: { gt: new Date() },
            },
            select: { id: true },
          }),
      );
      if (invited) throw this.accountExists();
      throw new UnauthorizedException("Invalid or expired invitation");
    }
    const userId = existing?.id ?? randomUUID();
    const sessionId = await this.db.run(
      { userId, tenantId: null, requestId: requestId(req) },
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`identifier:${input.identifier}`}, 0))`;
        const now = new Date();
        const current = await tx.user.findUnique({ where: { identifier: input.identifier } });
        if (current?.verifiedAt) throw this.accountExists();
        const data = {
          displayName: input.displayName,
          passwordHash: unusable,
          pinHash,
          verifiedAt: now,
          failedLogins: 0,
          lockedUntil: null,
        };
        if (current) {
          // A pending password registration for this number may have been made by someone else;
          // the invitation link proves control of the phone, so its password is discarded.
          await tx.user.update({ where: { id: current.id }, data });
          await tx.authChallenge.updateMany({
            where: { userId: current.id, consumedAt: null },
            data: { consumedAt: now },
          });
        } else {
          await tx.user.create({ data: { id: userId, identifier: input.identifier, ...data } });
        }
        // Readable under RLS only for the (now verified) recipient, and only with the exact token.
        const invitation = await tx.invitation.findFirst({
          where: {
            digest: digest(input.token),
            identifier: input.identifier,
            acceptedAt: null,
            expiresAt: { gt: now },
          },
          select: { id: true, tenantId: true },
        });
        if (!invitation) throw new UnauthorizedException("Invalid or expired invitation");
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${invitation.tenantId}, true)`;
        await this.tenancy.redeem(tx, invitation, userId, (grant) => {
          if (portalFor(grant.permissions) !== "worker") throw pinSessionLimited();
        });
        const session = await tx.session.create({
          data: {
            ...newSessionData({ id: userId, mfaEnabled: false }, "pin"),
            activeTenantId: invitation.tenantId,
          },
        });
        return session.id;
      },
    );
    return this.auth.issue(sessionId, res);
  }

  /** Sets a new PIN with a reset token (POST auth/password/forgot sends a link for PIN accounts). */
  async reset(token: string, pin: string, req: Request) {
    await this.auth.throttle(req, "pin-reset", digest(token), { maximum: 5, seconds: 900 });
    const pending = await this.prisma.authChallenge.findFirst({
      where: {
        purpose: "reset",
        digest: digest(token),
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { user: { select: { identifier: true, pinHash: true } } },
    });
    if (!pending?.user.pinHash) throw new UnauthorizedException("Invalid or expired reset token");
    const problem = pinProblem(pin, pending.user.identifier);
    if (problem) throw weakPin(problem);
    const pinHash = await hashPassword(pin);
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
        data: { pinHash, failedLogins: 0, lockedUntil: null },
      });
      await tx.session.updateMany({
        where: { userId: found.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return true;
    });
    if (!valid) throw new UnauthorizedException("Invalid or expired reset token");
    return { message: "PIN changed. Sign in again." };
  }

  private accountExists() {
    return new ConflictException({
      code: "account-exists",
      message: "This phone number already has an account. Sign in, then open the invitation again.",
    });
  }
}
