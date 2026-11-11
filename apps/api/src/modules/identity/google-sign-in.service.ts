import { HttpException, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import type { Request, Response } from "express";
import * as oidc from "openid-client";
import { z } from "zod";
import type { GoogleSignInOutcome } from "@pm-buddy/validation";
import { isUniqueViolation } from "../../common/database-errors.js";
import { describeError } from "../../common/errors.js";
import { AppConfig } from "../../config/app-config.js";
import { PrismaService } from "../../infra/prisma.service.js";
import {
  AuthSecurity,
  cookie,
  digest,
  hashPassword,
  opaqueToken,
} from "./auth-security.service.js";
import { AuthService, newSessionData } from "./auth.service.js";
import { GOOGLE_ISSUER, googleProfile, type GoogleProfile } from "./google-profile.js";

const PENDING_MINUTES = 10;
const CALLBACK_PATH = "/api/v1/auth/google/callback";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const pendingSchema = z
  .object({
    state: z.string().min(16).max(256),
    nonce: z.string().min(16).max(256),
    verifier: z.string().min(43).max(128),
    next: z.string().max(512).nullable(),
  })
  .strict();
type Pending = z.infer<typeof pendingSchema>;
type Settings = { clientId: string; clientSecret: string; issuer: URL; insecure: boolean };
type SignedIn = { sessionId: string; linkedIdentifier: string | null };

/**
 * "Continue with Google": OpenID Connect authorisation code flow with PKCE, state and nonce
 * (openid-client). Google proves the email; PM-Buddy still owns the session, MFA and company
 * access, so an MFA-required account must still verify TOTP or a passkey after Google.
 */
@Injectable()
export class GoogleSignIn {
  private readonly logger = new Logger(GoogleSignIn.name);
  private readonly settings: Settings | null;
  private readonly webOrigin: string;
  private configuration: Promise<oidc.Configuration> | null = null;

  constructor(
    config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly security: AuthSecurity,
  ) {
    const clientId = config.get("AUTH_GOOGLE_CLIENT_ID");
    const clientSecret = config.get("AUTH_GOOGLE_CLIENT_SECRET");
    const override = config.get("AUTH_GOOGLE_ISSUER");
    if (Boolean(clientId) !== Boolean(clientSecret))
      throw new Error("Set both AUTH_GOOGLE_CLIENT_ID and AUTH_GOOGLE_CLIENT_SECRET, or neither");
    if (override && config.isProduction)
      throw new Error("AUTH_GOOGLE_ISSUER is a test-only override and is refused in production");
    const issuer = new URL(override ?? GOOGLE_ISSUER);
    const insecure = issuer.protocol === "http:";
    if (insecure && !LOOPBACK.has(issuer.hostname))
      throw new Error("A plain-HTTP Google issuer is only allowed on loopback, for tests");
    this.webOrigin = new URL(config.get("WEB_ORIGIN")).origin;
    this.settings = clientId && clientSecret ? { clientId, clientSecret, issuer, insecure } : null;
  }

  get enabled(): boolean {
    return this.settings !== null;
  }

  /** Where Google returns the browser: the web origin, proxied to the API (ARCHITECTURE D-16). */
  get redirectUri(): string {
    return `${this.webOrigin}${CALLBACK_PATH}`;
  }

  /** Starts a sign-in: remembers the pending checks in an encrypted cookie, returns Google's URL. */
  async start(next: string | undefined, req: Request, res: Response): Promise<string> {
    const target = next && next.length <= 512 ? next : null;
    if (!this.settings) return this.back("unavailable", target);
    try {
      await this.auth.throttle(req, "google-start");
      const config = await this.discover();
      const pending: Pending = {
        state: oidc.randomState(),
        nonce: oidc.randomNonce(),
        verifier: oidc.randomPKCECodeVerifier(),
        next: target,
      };
      const url = oidc.buildAuthorizationUrl(config, {
        redirect_uri: this.redirectUri,
        scope: "openid email profile",
        state: pending.state,
        nonce: pending.nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(pending.verifier),
        code_challenge_method: "S256",
        prompt: "select_account",
      });
      const sealed = await this.security.encrypt(
        JSON.stringify(pending),
        "google-oauth",
        `${PENDING_MINUTES}m`,
      );
      this.security.setCookie(res, "oauth", sealed, PENDING_MINUTES * 60_000);
      return url.href;
    } catch (error) {
      return this.failure(error, target);
    }
  }

  /** Completes a sign-in. Always clears the pending cookie, so a callback URL works once. */
  async callback(req: Request, res: Response): Promise<string> {
    const pending = await this.pending(req);
    this.security.setCookie(res, "oauth", "", 0);
    const next = pending?.next ?? null;
    if (!this.settings) return this.back("unavailable", next);
    if (req.query["error"] !== undefined)
      return this.back(req.query["error"] === "access_denied" ? "cancelled" : "failed", next);
    if (!pending) return this.back("failed", null);
    try {
      await this.auth.throttle(req, "google-callback", digest(pending.state));
      const config = await this.discover();
      const current = new URL(this.redirectUri);
      current.search = new URL(req.originalUrl, this.webOrigin).search;
      const tokens = await oidc.authorizationCodeGrant(config, current, {
        pkceCodeVerifier: pending.verifier,
        expectedState: pending.state,
        expectedNonce: pending.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      const profile = claims ? googleProfile(claims) : null;
      if (!profile) return this.back("email-unsupported", next);
      const signedIn = await this.signIn(profile);
      if (!signedIn) return this.back("account-conflict", next);
      await this.auth.issue(signedIn.sessionId, res);
      if (signedIn.linkedIdentifier)
        this.security.notifyLater(
          signedIn.linkedIdentifier,
          "Google sign-in linked",
          "Your Google account was linked to your PM-Buddy account and used to sign in. Two-step verification still applies. If this was not you, reset your password and contact your company administrator.",
        );
      return next
        ? `${this.webOrigin}/sign-in?next=${encodeURIComponent(next)}`
        : `${this.webOrigin}/sign-in`;
    } catch (error) {
      return this.failure(error, next);
    }
  }

  private discover(): Promise<oidc.Configuration> {
    const settings = this.settings!;
    this.configuration ??= oidc
      .discovery(settings.issuer, settings.clientId, settings.clientSecret, undefined, {
        // ID token signatures are also checked against Google's published keys (defence in
        // depth; TLS to the token endpoint is the minimum OpenID Connect requires).
        execute: [
          oidc.enableNonRepudiationChecks,
          ...(settings.insecure ? [oidc.allowInsecureRequests] : []),
        ],
        timeout: 5,
      })
      .catch((error: unknown) => {
        this.configuration = null; // retry discovery on the next attempt
        this.logger.warn(`Google discovery failed: ${describeError(error)}`);
        throw new ServiceUnavailableException("Google sign-in is unavailable");
      });
    return this.configuration;
  }

  private async pending(req: Request): Promise<Pending | null> {
    const sealed = cookie(req, this.security.name("oauth"));
    if (!sealed) return null;
    try {
      return pendingSchema.parse(JSON.parse(await this.security.decrypt(sealed, "google-oauth")));
    } catch {
      return null;
    }
  }

  /**
   * Finds or creates the user, links the Google identity and opens a session, in one
   * transaction serialised per Google account and per email. Null: this email's account is
   * already linked to a different Google account.
   */
  private async signIn(profile: GoogleProfile, retry = true): Promise<SignedIn | null> {
    // An unusable password for accounts created or taken over here (password reset can set one).
    const unusable = await hashPassword(opaqueToken());
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`google:${profile.subject}`}, 0))`;
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`identifier:${profile.email}`}, 0))`;
          const now = new Date();
          const identity = await tx.userIdentity.findUnique({
            where: { provider_subject: { provider: "google", subject: profile.subject } },
          });
          let userId: string;
          let linkedIdentifier: string | null = null;
          if (identity) {
            userId = identity.userId;
            await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
            await tx.userIdentity.update({
              where: { id: identity.id },
              data: { email: profile.email, lastUsedAt: now },
            });
          } else {
            const existing = await tx.user.findUnique({ where: { identifier: profile.email } });
            if (existing) {
              await tx.$queryRaw`SELECT id FROM users WHERE id = ${existing.id}::uuid FOR UPDATE`;
              const linked = await tx.userIdentity.findUnique({
                where: { userId_provider: { userId: existing.id, provider: "google" } },
              });
              if (linked) return null;
              if (existing.verifiedAt) {
                linkedIdentifier = existing.identifier;
              } else {
                // Google proved control of the address. A pending registration's password may
                // have been chosen by someone else (pre-hijacking), so it is replaced.
                await tx.user.update({
                  where: { id: existing.id },
                  data: {
                    verifiedAt: now,
                    passwordHash: unusable,
                    failedLogins: 0,
                    lockedUntil: null,
                  },
                });
                await tx.authChallenge.updateMany({
                  where: { userId: existing.id, consumedAt: null },
                  data: { consumedAt: now },
                });
              }
              userId = existing.id;
            } else {
              const created = await tx.user.create({
                data: {
                  identifier: profile.email,
                  displayName: profile.displayName,
                  passwordHash: unusable,
                  verifiedAt: now,
                },
              });
              userId = created.id;
            }
            await tx.userIdentity.create({
              data: {
                userId,
                provider: "google",
                subject: profile.subject,
                email: profile.email,
                lastUsedAt: now,
              },
            });
          }
          const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
          const session = await tx.session.create({ data: newSessionData(user, "google") });
          return { sessionId: session.id, linkedIdentifier };
        },
        { timeout: 10_000 },
      );
    } catch (error) {
      // A concurrent registration of the same address won the race: link to it instead.
      if (retry && isUniqueViolation(error)) return this.signIn(profile, false);
      throw error;
    }
  }

  private failure(error: unknown, next: string | null): string {
    if (error instanceof HttpException && error.getStatus() === 429)
      return this.back("rate-limited", next);
    if (error instanceof ServiceUnavailableException) return this.back("unavailable", next);
    // Never log codes, tokens or claims: only the error's message or code.
    this.logger.warn(`Google sign-in failed: ${describeError(error)}`);
    return this.back("failed", next);
  }

  private back(outcome: GoogleSignInOutcome, next: string | null): string {
    const query = new URLSearchParams({ google: outcome });
    if (next) query.set("next", next);
    return `${this.webOrigin}/sign-in?${query.toString()}`;
  }
}
