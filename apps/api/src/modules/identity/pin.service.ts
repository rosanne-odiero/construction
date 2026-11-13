import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { pinProblem } from "@pm-buddy/domain";
import { pinAllowed } from "@pm-buddy/types";
import { AppConfig } from "../../config/app-config.js";
import { PrismaService } from "../../infra/prisma.service.js";
import {
  AuthSecurity,
  digest,
  hashPassword,
  opaqueToken,
  verifyPassword,
} from "./auth-security.service.js";
import { AuthService, newSessionData, requestId } from "./auth.service.js";
import { PinHasher } from "./pin-pepper.js";
import { TenancyService } from "./tenancy.service.js";
import { pinSessionLimited } from "./tenant-scope.service.js";
import { TenantDatabase } from "./tenant-database.service.js";

const MINUTE = 60_000;
const HOUR_SECONDS = 3_600;
const DAY_SECONDS = 86_400;
/** Wrong PINs per number per day before sign-in needs a PIN reset by SMS. */
export const PIN_DAILY_FAILURES = 30;
/**
 * Wrong PINs per number per hour while the platform-wide budget (PIN_GLOBAL_FAILURES_PER_HOUR) is
 * spent. Only failures made while it is spent count, so earlier typos never lock anyone out.
 */
export const PIN_FAILURES_UNDER_ATTACK = 1;
const dailyFailures = (identifier: string) => `pin-day:key:${identifier}`;
const attackFailures = (identifier: string) => `pin-attack:key:${identifier}`;
/** Wrong PINs across every number in the current hour (pre-sign-in, so platform-wide). */
export const PIN_GLOBAL_FAILURES = "pin-fail:global";
const resetRequired = () =>
  new HttpException(
    {
      code: "pin-reset-required",
      message: "Too many wrong PINs today. Reset your PIN with the link we send by SMS.",
    },
    429,
  );
const temporarilyLimited = () =>
  new HttpException(
    {
      code: "pin-temporarily-limited",
      message: "Too many wrong PINs right now. Try again in an hour, or reset your PIN by SMS.",
    },
    429,
  );
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
 * guessing is bounded by the shared five-failure lockout, the per-number and per-address request
 * limits, a daily budget of wrong PINs per number and a platform-wide hourly budget. Only wrong
 * PINs count; a spent number budget needs an SMS PIN reset, which also clears it. When the
 * platform-wide budget is spent (guessing across many numbers), an alert is logged once and each
 * number gets one wrong PIN per hour; failures from before that never count, so correct PINs keep
 * working. Every wrong PIN counts towards that budget, whatever address it came from: one client
 * can trip it, but that only tightens guessing, and a cap per address would let one client guess
 * on unseen. Each attempt
 * reserves its place in the budgets before the PIN is checked, so parallel guesses cannot all
 * pass a check, and a correct PIN gives the reservation back. PINs are peppered (PinHasher).
 */
@Injectable()
export class PinService {
  private readonly logger = new Logger(PinService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly db: TenantDatabase,
    private readonly auth: AuthService,
    private readonly security: AuthSecurity,
    private readonly tenancy: TenancyService,
    private readonly hasher: PinHasher,
    private readonly config: AppConfig,
  ) {}

  async login(identifier: string, pin: string, req: Request, res: Response) {
    await this.auth.throttle(req, "pin-login", identifier);
    const globalBudget = this.config.get("PIN_GLOBAL_FAILURES_PER_HOUR");
    const underAttack = (await this.security.counted(PIN_GLOBAL_FAILURES)) >= globalBudget;
    // Reserve this attempt in each budget first (INCR is atomic), so parallel requests cannot all
    // read a count below the limit. Reservations are given back unless a wrong PIN was checked, so
    // the counts are exactly the wrong PINs checked.
    const daily = dailyFailures(identifier);
    const reserved = [daily];
    if ((await this.security.increment(daily, DAY_SECONDS)) > PIN_DAILY_FAILURES) {
      await this.releaseAll(reserved);
      throw resetRequired();
    }
    if (underAttack) {
      const attack = attackFailures(identifier);
      reserved.push(attack);
      if ((await this.security.increment(attack, HOUR_SECONDS)) > PIN_FAILURES_UNDER_ATTACK) {
        await this.releaseAll(reserved);
        throw temporarilyLimited();
      }
    }
    const result = await this.prisma
      .$transaction(
        async (tx) => {
          const found = await tx.user.findUnique({ where: { identifier } });
          if (!found?.pinHash) {
            await verifyPassword(await this.security.dummyPassword, this.hasher.dummyInput(pin));
            return null;
          }
          await tx.$queryRaw`SELECT id FROM users WHERE id = ${found.id}::uuid FOR UPDATE`;
          const user = await tx.user.findUniqueOrThrow({ where: { id: found.id } });
          const stored = { pinHash: user.pinHash!, pinPepperVersion: user.pinPepperVersion };
          const matches = await this.hasher.verify(stored, pin);
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
          // A correct PIN under an older (or no) pepper is re-hashed under the active key.
          const rehash = this.hasher.needsRehash(stored) ? await this.hasher.hash(pin) : {};
          await tx.user.update({
            where: { id: user.id },
            data: { failedLogins: 0, lockedUntil: null, ...rehash },
          });
          return tx.session.create({ data: newSessionData(user, "pin") });
        },
        { timeout: 10_000 },
      )
      .catch(async (error: unknown) => {
        await this.releaseAll(reserved);
        throw error;
      });
    if (!result) {
      // The reservations stay as failures, for unknown numbers too, so the response never
      // reveals whether a number exists.
      await this.recordGlobalFailure(globalBudget);
      throw new UnauthorizedException("Invalid phone number or PIN, or account unavailable");
    }
    await this.releaseAll(reserved);
    return this.auth.issue(result.id, res);
  }

  /** Adds a wrong PIN to the platform-wide hourly count; one request sees the budget reached. */
  private async recordGlobalFailure(globalBudget: number): Promise<void> {
    const failures = await this.security.increment(PIN_GLOBAL_FAILURES, HOUR_SECONDS);
    if (failures === globalBudget)
      this.logger.error(
        { event: "pin_failure_budget_exceeded", alert: true, failuresPerHour: globalBudget },
        "PIN sign-in failures reached the platform-wide hourly budget; each number now gets one wrong PIN per hour",
      );
  }

  private async releaseAll(keys: readonly string[]) {
    for (const key of keys) await this.security.release(key);
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
    const [pin, unusable] = await Promise.all([
      this.hasher.hash(input.pin),
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
          ...pin,
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
          if (!pinAllowed(grant.permissions)) throw pinSessionLimited();
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
    const stored = await this.hasher.hash(pin);
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
        data: { ...stored, failedLogins: 0, lockedUntil: null },
      });
      await tx.session.updateMany({
        where: { userId: found.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return true;
    });
    if (!valid) throw new UnauthorizedException("Invalid or expired reset token");
    await this.security.forget(dailyFailures(pending.user.identifier));
    await this.security.forget(attackFailures(pending.user.identifier));
    return { message: "PIN changed. Sign in again." };
  }

  private accountExists() {
    return new ConflictException({
      code: "account-exists",
      message: "This phone number already has an account. Sign in, then open the invitation again.",
    });
  }
}
