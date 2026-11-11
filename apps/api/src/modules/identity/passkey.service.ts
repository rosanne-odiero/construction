import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import {
  isPasskeyTransport,
  MAX_PASSKEYS,
  messageResponseSchema,
  passkeyAuthenticationOptionsResponseSchema,
  passkeyRegistrationOptionsResponseSchema,
  passkeyRegistrationResponseSchema,
  passkeysResponseSchema,
  type PasskeyAuthenticationRequest,
  type PasskeyRegistrationRequest,
} from "@pm-buddy/validation";
import type { Request, Response } from "express";
import type { Prisma, WebAuthnCredential } from "../../generated/prisma/client.js";
import { AppConfig } from "../../config/app-config.js";
import { PrismaService } from "../../infra/prisma.service.js";
import { digest, opaqueToken } from "./auth-security.service.js";
import { AuthService, FRESH_MINUTES, type MfaOutcome, type Principal } from "./auth.service.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY_SECONDS = 86_400;
/** Challenges are single-use and expire within the fresh window (brief §7, ARCHITECTURE §7). */
const CHALLENGE_TTL_MS = FRESH_MINUTES * MINUTE;
const REGISTER = "passkey-register";
const STEP_UP = "passkey-step-up";
/**
 * EdDSA, ES256 and RS256. ML-DSA (post-quantum) is left out while Node marks it experimental;
 * the same list is offered at registration and enforced when verifying it.
 */
const ALGORITHMS = [-8, -7, -257];

type RegistrationOutcome =
  | { kind: "ok"; passkey: WebAuthnCredential; recoveryCodes: string[] | null }
  | { kind: "invalid" | "duplicate" | "name-taken" | "limit" };

/**
 * Passkeys (WebAuthn) as an MFA factor and for step-up (ARCHITECTURE §7), built on
 * @simplewebauthn/server. The relying party is WEB_ORIGIN: its exact origin, with the hostname as
 * RP ID. Every ceremony demands user verification.
 */
@Injectable()
export class PasskeyService {
  private readonly origin: string;
  private readonly rpId: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    config: AppConfig,
  ) {
    const web = new URL(config.get("WEB_ORIGIN"));
    this.origin = web.origin;
    this.rpId = web.hostname;
  }

  async list(principal: Principal) {
    this.auth.requireMfa(principal);
    const passkeys = await this.prisma.webAuthnCredential.findMany({
      where: { userId: principal.user.id },
      orderBy: { createdAt: "asc" },
    });
    return passkeysResponseSchema.parse({ passkeys: passkeys.map(view) });
  }

  async registrationOptions(principal: Principal, req: Request) {
    await this.auth.throttle(req, "passkey-options", principal.user.id, {
      maximum: 20,
      seconds: 300,
    });
    this.auth.requireFactorEnrolment(principal);
    const existing = await this.prisma.webAuthnCredential.findMany({
      where: { userId: principal.user.id },
      select: { credentialId: true, transports: true },
    });
    if (existing.length >= MAX_PASSKEYS) throw new ConflictException("Passkey limit reached");
    const options = await generateRegistrationOptions({
      rpName: "PM-Buddy",
      rpID: this.rpId,
      userName: principal.user.identifier,
      userDisplayName: principal.user.displayName,
      // The user handle is the account's random UUID, never an identifier.
      userID: new Uint8Array(Buffer.from(principal.user.id.replaceAll("-", ""), "hex")),
      timeout: CHALLENGE_TTL_MS,
      attestationType: "none",
      excludeCredentials: existing.map((credential) => ({
        id: credential.credentialId,
        transports: credential.transports,
      })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      supportedAlgorithmIDs: ALGORITHMS,
    });
    await this.storeChallenge(principal, REGISTER, options.challenge);
    return passkeyRegistrationOptionsResponseSchema.parse({ options });
  }

  async register(
    principal: Principal,
    input: PasskeyRegistrationRequest,
    req: Request,
    res: Response,
  ) {
    await this.auth.throttle(req, "passkey-register", principal.user.id);
    this.auth.requireFactorEnrolment(principal);
    const codes = Array.from({ length: 10 }, () => opaqueToken().slice(0, 24));
    const outcome = await this.prisma
      .$transaction(async (tx): Promise<RegistrationOutcome> => {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${principal.user.id}::uuid FOR UPDATE`;
        const user = await tx.user.findUniqueOrThrow({ where: { id: principal.user.id } });
        // Re-check under the lock: another session may have added a factor (or revoked this one)
        // since the request began.
        const session = await tx.session.findUniqueOrThrow({ where: { id: principal.session.id } });
        this.auth.assertFactorEnrolment(user, session);
        const expected = await this.consumeChallenge(tx, principal, REGISTER);
        if (!expected) return { kind: "invalid" };
        // A failure's message can quote origins and challenges: it is neither logged nor returned.
        const verified = await verifyRegistrationResponse({
          // Shape and sizes were validated by passkeyRegistrationRequestSchema.
          response: input.credential as unknown as RegistrationResponseJSON,
          expectedChallenge: (challenge) => digest(challenge) === expected,
          expectedOrigin: this.origin,
          expectedRPID: this.rpId,
          requireUserVerification: true,
          supportedAlgorithmIDs: ALGORITHMS,
        }).catch(() => null);
        if (!verified?.verified) return { kind: "invalid" };
        const { credential, credentialDeviceType, credentialBackedUp } = verified.registrationInfo;
        if (await tx.webAuthnCredential.findUnique({ where: { credentialId: credential.id } })) {
          return { kind: "duplicate" };
        }
        const owned = await tx.webAuthnCredential.findMany({
          where: { userId: user.id },
          select: { name: true },
        });
        if (owned.length >= MAX_PASSKEYS) return { kind: "limit" };
        if (owned.some((passkey) => passkey.name === input.name)) return { kind: "name-taken" };
        const firstFactor = !user.mfaEnabled;
        // The users.mfa_enabled trigger records the new factor as part of this insert.
        const passkey = await tx.webAuthnCredential.create({
          data: {
            userId: user.id,
            credentialId: credential.id,
            publicKey: Buffer.from(credential.publicKey),
            counter: BigInt(credential.counter),
            transports: (credential.transports ?? []).filter(isPasskeyTransport),
            name: input.name,
            deviceType: credentialDeviceType,
            backedUp: credentialBackedUp,
          },
        });
        // Any TOTP enrolment still pending was started before this factor existed: discard it.
        await tx.user.update({
          where: { id: user.id },
          data: { mfaPending: null, mfaPendingUntil: null, mfaPendingSessionId: null },
        });
        let recoveryCodes: string[] | null = null;
        if (firstFactor) {
          // Like TOTP enrolment: the first factor brings recovery codes (unless unused ones exist),
          // signs out other sessions and counts as this session's MFA verification.
          if (!(await tx.recoveryCode.count({ where: { userId: user.id, consumedAt: null } }))) {
            await tx.recoveryCode.deleteMany({ where: { userId: user.id } });
            await tx.recoveryCode.createMany({
              data: codes.map((value) => ({ userId: user.id, digest: digest(value) })),
            });
            recoveryCodes = codes;
          }
          await tx.session.updateMany({
            where: { userId: user.id, id: { not: principal.session.id }, revokedAt: null },
            data: { revokedAt: new Date() },
          });
          await tx.session.update({
            where: { id: principal.session.id },
            data: {
              mfaVerifiedAt: new Date(),
              expiresAt: new Date(
                Math.min(principal.session.expiresAt.getTime(), Date.now() + 8 * HOUR),
              ),
            },
          });
        }
        return { kind: "ok", passkey, recoveryCodes };
      })
      .catch((error: unknown): RegistrationOutcome => {
        // Another account registered the same credential ID at the same moment.
        if (isUniqueViolation(error)) return { kind: "duplicate" };
        throw error;
      });
    if (outcome.kind !== "ok") throw registrationFailure(outcome.kind);
    this.auth.security.notifyLater(
      principal.user.identifier,
      "Passkey added",
      "A passkey was added to your PM-Buddy account. If this wasn't you, sign in, remove it and change your password.",
    );
    const response = await this.auth.issue(principal.session.id, res);
    return passkeyRegistrationResponseSchema.parse({
      ...response,
      passkey: view(outcome.passkey),
      ...(outcome.recoveryCodes ? { recoveryCodes: outcome.recoveryCodes } : {}),
    });
  }

  async stepUpOptions(principal: Principal, req: Request) {
    await this.auth.throttle(req, "passkey-options", principal.user.id, {
      maximum: 20,
      seconds: 300,
    });
    if (principal.user.mfaLockedUntil && principal.user.mfaLockedUntil > new Date()) {
      throw new HttpException(
        "Too many wrong codes; two-step verification is temporarily locked",
        429,
      );
    }
    const passkeys = await this.prisma.webAuthnCredential.findMany({
      where: { userId: principal.user.id },
      select: { credentialId: true, transports: true },
    });
    if (!passkeys.length) throw new NotFoundException("No passkey is registered");
    const options = await generateAuthenticationOptions({
      rpID: this.rpId,
      allowCredentials: passkeys.map((passkey) => ({
        id: passkey.credentialId,
        transports: passkey.transports,
      })),
      timeout: CHALLENGE_TTL_MS,
      userVerification: "required",
    });
    await this.storeChallenge(principal, STEP_UP, options.challenge);
    return passkeyAuthenticationOptionsResponseSchema.parse({ options });
  }

  /**
   * Verifies an assertion against this session's latest challenge. Success records the session's
   * MFA time exactly like a TOTP step-up; every failure (unknown, replayed or expired challenge,
   * wrong origin, bad signature, counter regression, no user verification) counts toward the
   * shared MFA lockout.
   */
  async stepUp(
    principal: Principal,
    input: PasskeyAuthenticationRequest,
    req: Request,
    res: Response,
  ) {
    await this.auth.throttle(req, "mfa", principal.user.id);
    await this.auth.security.limit(`mfa-day:key:${principal.user.id}`, 30, DAY_SECONDS);
    const outcome = await this.prisma.$transaction(async (tx): Promise<MfaOutcome> => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${principal.user.id}::uuid FOR UPDATE`;
      const user = await tx.user.findUniqueOrThrow({ where: { id: principal.user.id } });
      if (user.mfaLockedUntil && user.mfaLockedUntil > new Date()) return "locked";
      const fail = () => this.auth.recordMfaFailure(tx, user, principal.session.id);
      const expected = await this.consumeChallenge(tx, principal, STEP_UP);
      if (!expected) return fail();
      const passkey = await tx.webAuthnCredential.findFirst({
        where: { userId: user.id, credentialId: input.credential.id },
      });
      if (!passkey) return fail();
      const verified = await verifyAuthenticationResponse({
        // Shape and sizes were validated by passkeyAuthenticationRequestSchema.
        response: input.credential as unknown as AuthenticationResponseJSON,
        expectedChallenge: (challenge) => digest(challenge) === expected,
        expectedOrigin: this.origin,
        expectedRPID: this.rpId,
        // The library rejects a counter that does not increase, except authenticators that
        // always report zero.
        credential: {
          id: passkey.credentialId,
          publicKey: new Uint8Array(passkey.publicKey),
          counter: Number(passkey.counter),
          transports: passkey.transports,
        },
        requireUserVerification: true,
      }).catch(() => null);
      if (!verified?.verified || !verified.authenticationInfo.userVerified) return fail();
      await tx.webAuthnCredential.update({
        where: { id: passkey.id },
        data: {
          counter: BigInt(verified.authenticationInfo.newCounter),
          backedUp: verified.authenticationInfo.credentialBackedUp,
          lastUsedAt: new Date(),
        },
      });
      await tx.user.update({ where: { id: user.id }, data: { mfaFailedAttempts: 0 } });
      await tx.session.update({
        where: { id: principal.session.id },
        data: { mfaVerifiedAt: new Date() },
      });
      return "ok";
    });
    this.auth.rejectMfaOutcome(outcome, principal, res, "Passkey could not be verified");
    return this.auth.issue(principal.session.id, res);
  }

  /**
   * Needs MFA verified within five minutes. The last factor of someone holding an MFA-required
   * permission cannot be removed (409); the users.mfa_enabled trigger enforces the same rule.
   */
  async remove(principal: Principal, id: string) {
    this.auth.requireMfa(principal, true);
    const privileged = await this.auth.holdsPrivilegedRole(principal.user.id);
    const outcome = await this.prisma
      .$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${principal.user.id}::uuid FOR UPDATE`;
        const user = await tx.user.findUniqueOrThrow({
          where: { id: principal.user.id },
          include: { _count: { select: { passkeys: true } } },
        });
        const passkey = await tx.webAuthnCredential.findFirst({
          where: { id, userId: user.id },
        });
        if (!passkey) return "not-found" as const;
        const remainingFactors = user._count.passkeys - 1 + (user.mfaSecret ? 1 : 0);
        if (remainingFactors === 0 && privileged) return "last-factor" as const;
        await tx.webAuthnCredential.delete({ where: { id: passkey.id } });
        return "removed" as const;
      })
      .catch((error: unknown) => {
        // The database refused the removal because a role needing MFA was granted meanwhile.
        if (isCheckViolation(error)) return "last-factor" as const;
        throw error;
      });
    if (outcome === "not-found") throw new NotFoundException("Passkey not found");
    if (outcome === "last-factor") {
      throw new ConflictException(
        "Your role requires MFA: add another passkey or an authenticator app before removing this one",
      );
    }
    this.auth.security.notifyLater(
      principal.user.identifier,
      "Passkey removed",
      "A passkey was removed from your PM-Buddy account. If this wasn't you, sign in and change your password.",
    );
    return messageResponseSchema.parse({ message: "Passkey removed." });
  }

  private async storeChallenge(principal: Principal, purpose: string, challenge: string) {
    const now = Date.now();
    await this.prisma.$transaction(async (tx) => {
      await tx.authChallenge.updateMany({
        where: { sessionId: principal.session.id, purpose, consumedAt: null },
        data: { consumedAt: new Date(now) },
      });
      await tx.authChallenge.create({
        data: {
          userId: principal.user.id,
          sessionId: principal.session.id,
          purpose,
          digest: digest(challenge),
          expiresAt: new Date(now + CHALLENGE_TTL_MS),
        },
      });
    });
  }

  /** Consumes this session's latest challenge, valid or not; returns its digest if still live. */
  private async consumeChallenge(
    tx: Prisma.TransactionClient,
    principal: Principal,
    purpose: string,
  ): Promise<string | null> {
    const challenge = await tx.authChallenge.findFirst({
      where: {
        userId: principal.user.id,
        sessionId: principal.session.id,
        purpose,
        consumedAt: null,
      },
      orderBy: { expiresAt: "desc" },
    });
    if (!challenge) return null;
    const consumed = await tx.authChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    return consumed.count && challenge.expiresAt > new Date() ? challenge.digest : null;
  }
}

function registrationFailure(kind: Exclude<RegistrationOutcome["kind"], "ok">) {
  if (kind === "invalid") {
    return new BadRequestException({
      code: "passkey-invalid",
      message: "Passkey registration could not be verified; start again",
    });
  }
  return new ConflictException(
    kind === "duplicate"
      ? "Passkey already registered"
      : kind === "name-taken"
        ? "Passkey name already in use"
        : "Passkey limit reached",
  );
}

/** Listing view: never the credential ID or public key. */
function view(passkey: WebAuthnCredential) {
  return {
    id: passkey.id,
    name: passkey.name,
    createdAt: passkey.createdAt.toISOString(),
    lastUsedAt: passkey.lastUsedAt?.toISOString() ?? null,
    backedUp: passkey.backedUp,
    deviceType: passkey.deviceType,
  };
}

/**
 * Whether a database error, or one it wraps, carries one of these codes. Prisma's driver adapter
 * reports the PostgreSQL SQLSTATE at `meta.driverAdapterError.cause.code`.
 */
function hasCode(error: unknown, codes: readonly string[]): boolean {
  const seen = new Set<unknown>();
  const pending: unknown[] = [error];
  while (pending.length) {
    const current = pending.pop();
    if (typeof current !== "object" || current === null || seen.has(current)) continue;
    seen.add(current);
    const fields = current as Record<string, unknown>;
    if (codes.includes(String(fields["code"])) || codes.includes(String(fields["originalCode"])))
      return true;
    pending.push(fields["cause"], fields["meta"], fields["driverAdapterError"]);
  }
  return false;
}
/** PostgreSQL check_violation, as raised by the privileged-MFA triggers. */
const isCheckViolation = (error: unknown) => hasCode(error, ["23514"]);
const isUniqueViolation = (error: unknown) => hasCode(error, ["P2002", "23505"]);
