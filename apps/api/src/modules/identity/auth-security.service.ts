import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
  type OnModuleInit,
} from "@nestjs/common";
import { hash, verify } from "@node-rs/argon2";
import {
  EncryptJWT,
  SignJWT,
  exportJWK,
  generateKeyPair,
  importJWK,
  importPKCS8,
  jwtDecrypt,
  jwtVerify,
} from "jose";
import type { Request, Response } from "express";
import { csrfResponseSchema } from "@pm-buddy/validation";
import { describeError } from "../../common/errors.js";
import { AppConfig, trustProxySetting } from "../../config/app-config.js";
import { RedisService } from "../../infra/redis.service.js";
import {
  channelFor,
  NotificationProvider,
  type NotificationChannel,
} from "../notifications/notification.provider.js";

export const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const rateKey = (key: string) => `pmb:auth:rate:${digest(key)}`;
export type CookieKind = "at" | "rt" | "csrf" | "oauth";
export const opaqueToken = (): string => randomBytes(32).toString("base64url");
export const hashPassword = (value: string): Promise<string> =>
  hash(value, {
    // Argon2id = 2; the library exposes an ambient const enum, unavailable with isolatedModules.
    algorithm: 2,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
    outputLen: 32,
  });
export const verifyPassword = (encoded: string, value: string): Promise<boolean> =>
  verify(encoded, value);

export function cookie(req: Request, name: string): string | undefined {
  const entries = (req.headers.cookie ?? "").split(";").map((part) => part.trim());
  const matches = entries.filter((entry) => entry.startsWith(`${name}=`));
  if (matches.length !== 1) return undefined;
  return matches[0]?.slice(name.length + 1);
}

@Injectable()
export class AuthSecurity implements OnModuleInit {
  private readonly logger = new Logger(AuthSecurity.name);
  private readonly encryptionKey: Uint8Array;
  private readonly keys: Promise<{ privateKey: CryptoKey; publicKey: CryptoKey }>;
  readonly dummyPassword = hashPassword(opaqueToken());

  constructor(
    private readonly config: AppConfig,
    private readonly redis: RedisService,
    private readonly notifications: NotificationProvider,
  ) {
    const key = config.get("AUTH_MFA_ENCRYPTION_KEY");
    const signingKey = config.get("AUTH_SIGNING_PRIVATE_KEY");
    if (config.isProduction && (!key || !signingKey)) {
      throw new Error("Production requires AUTH_MFA_ENCRYPTION_KEY and AUTH_SIGNING_PRIVATE_KEY");
    }
    if (!key) throw new Error("AUTH_MFA_ENCRYPTION_KEY is required; generate a random 32-byte key");
    if (config.isProduction && config.get("AUTH_NOTIFICATION_TRANSPORT") === "development") {
      throw new Error("Development notification transport is forbidden in production");
    }
    if (config.isProduction && new URL(config.get("WEB_ORIGIN")).protocol !== "https:") {
      throw new Error("Production WEB_ORIGIN must use HTTPS");
    }
    this.encryptionKey = Buffer.from(key, "hex");
    this.keys = signingKey
      ? this.importSigningKey(signingKey)
      : generateKeyPair("EdDSA", { crv: "Ed25519" });
  }

  async onModuleInit(): Promise<void> {
    await this.keys;
    await this.dummyPassword;
  }

  private async importSigningKey(encoded: string) {
    const privateKey = await importPKCS8(Buffer.from(encoded, "base64").toString("utf8"), "EdDSA", {
      extractable: true,
    });
    const { d: _private, ...publicJwk } = await exportJWK(privateKey);
    const publicKey = await importJWK(publicJwk, "EdDSA");
    if (publicKey instanceof Uint8Array) throw new Error("Expected an asymmetric signing key");
    return { privateKey, publicKey };
  }

  /** `oauth` holds a pending Google sign-in (state, nonce, PKCE verifier), encrypted, 10 minutes. */
  name(kind: CookieKind): string {
    if (!this.config.isProduction) return `pmb_${kind}`;
    return kind === "rt" || kind === "oauth" ? `__Secure-pmb_${kind}` : `__Host-pmb_${kind}`;
  }

  setCookie(res: Response, kind: CookieKind, value: string, maxAge: number): void {
    res.cookie(this.name(kind), value, {
      httpOnly: true,
      secure: this.config.isProduction,
      sameSite: "lax",
      path: kind === "rt" ? "/api/v1/auth" : kind === "oauth" ? "/api/v1/auth/google" : "/",
      maxAge,
    });
    res.setHeader("Cache-Control", "no-store");
  }

  clearCookies(res: Response): void {
    for (const kind of ["at", "rt", "csrf"] as const) this.setCookie(res, kind, "", 0);
  }

  async csrf(req: Request, res: Response): Promise<{ csrfToken: string }> {
    let token = cookie(req, this.name("csrf")) || undefined; // a cleared cookie can arrive empty
    if (token) {
      try {
        await this.decrypt(token, "csrf");
      } catch {
        token = undefined;
      }
    }
    token ??= await this.encrypt(opaqueToken(), "csrf", "1h");
    this.setCookie(res, "csrf", token, 3_600_000);
    return csrfResponseSchema.parse({ csrfToken: token });
  }

  async assertCsrf(req: Request): Promise<void> {
    const origin = req.headers.origin;
    if (
      origin !== new URL(this.config.get("WEB_ORIGIN")).origin ||
      req.headers["sec-fetch-site"] === "cross-site"
    ) {
      throw new ForbiddenException("Same-origin request required");
    }
    const header = req.headers["x-csrf-token"];
    const token = cookie(req, this.name("csrf"));
    if (
      !token ||
      typeof header !== "string" ||
      Buffer.byteLength(header) !== Buffer.byteLength(token) ||
      !timingSafeEqual(Buffer.from(header), Buffer.from(token))
    ) {
      throw new ForbiddenException("CSRF token required");
    }
    try {
      await this.decrypt(token, "csrf");
    } catch {
      throw new ForbiddenException("Invalid or expired CSRF token");
    }
  }

  async encrypt(secret: string, purpose: string, expiration?: string): Promise<string> {
    const value = new EncryptJWT({ secret, purpose })
      .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
      .setIssuedAt();
    if (expiration) value.setExpirationTime(expiration);
    return value.encrypt(this.encryptionKey);
  }

  async decrypt(value: string, purpose: string): Promise<string> {
    const { payload } = await jwtDecrypt(value, this.encryptionKey, {
      keyManagementAlgorithms: ["dir"],
      contentEncryptionAlgorithms: ["A256GCM"],
    });
    if (payload["purpose"] !== purpose || typeof payload["secret"] !== "string") {
      throw new Error("Encrypted credential has the wrong purpose");
    }
    return payload["secret"];
  }

  async accessToken(userId: string, sessionId: string, generation: number): Promise<string> {
    return new SignJWT({ sid: sessionId, generation })
      .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
      .setSubject(userId)
      .setIssuer("pm-buddy-api")
      .setAudience("pm-buddy-web")
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign((await this.keys).privateKey);
  }

  async accessClaims(
    req: Request,
  ): Promise<{ userId: string; sessionId: string; generation: number }> {
    const token = cookie(req, this.name("at"));
    if (!token) throw new UnauthorizedException("Sign in required");
    try {
      const { payload } = await jwtVerify(token, (await this.keys).publicKey, {
        algorithms: ["EdDSA"],
        issuer: "pm-buddy-api",
        audience: "pm-buddy-web",
      });
      if (
        !payload.sub ||
        typeof payload["sid"] !== "string" ||
        !Number.isInteger(payload["generation"])
      ) {
        throw new Error("Invalid session claims");
      }
      return {
        userId: payload.sub,
        sessionId: payload["sid"],
        generation: payload["generation"] as number,
      };
    } catch {
      throw new UnauthorizedException("Invalid or expired access token");
    }
  }

  async limit(key: string, maximum: number, seconds: number): Promise<void> {
    if ((await this.increment(key, seconds)) > maximum)
      throw new HttpException("Too many attempts; retry later", 429);
  }

  /** Adds one to a rate-limit counter (window starts at the first hit) and returns the count. */
  async increment(key: string, seconds: number): Promise<number> {
    let count: unknown;
    try {
      await this.redis.ping();
      count = await this.redis.client.eval(
        "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n",
        1,
        rateKey(key),
        seconds,
      );
    } catch {
      throw new ServiceUnavailableException("Rate limiting is unavailable");
    }
    if (typeof count !== "number")
      throw new ServiceUnavailableException("Invalid rate limit response");
    return count;
  }

  /** A rate-limit counter's current value, without adding to it. */
  async counted(key: string): Promise<number> {
    try {
      await this.redis.ping();
      return Number((await this.redis.client.get(rateKey(key))) ?? 0);
    } catch {
      throw new ServiceUnavailableException("Rate limiting is unavailable");
    }
  }

  /** Forgets a rate-limit counter, for example once a PIN reset proves control of the phone. */
  async forget(key: string): Promise<void> {
    try {
      await this.redis.ping();
      await this.redis.client.del(rateKey(key));
    } catch {
      throw new ServiceUnavailableException("Rate limiting is unavailable");
    }
  }

  /**
   * The client IP, only when a proxy listed in TRUST_PROXY reported it. Behind the Next.js rewrite
   * without an edge proxy every request shares one address, and X-Forwarded-For is client-supplied.
   */
  clientAddress(req: Request): string | undefined {
    return trustProxySetting(this.config.get("TRUST_PROXY")) === false ? undefined : req.ip;
  }

  /**
   * Sends without delaying or failing the request, so neither the response status nor its timing
   * reveals whether an account exists (codes can be re-requested if delivery fails).
   */
  notifyLater(
    identifier: string,
    subject: string,
    text: string,
    channel: NotificationChannel = channelFor(identifier),
  ): void {
    this.notify(identifier, subject, text, channel).catch((error: unknown) => {
      this.logger.warn(
        `Notification "${subject}" (${channel}) not delivered: ${describeError(error)}`,
      );
    });
  }

  /** Delivers through the configured NotificationProvider: email for emails, SMS for phones. */
  async notify(
    identifier: string,
    subject: string,
    text: string,
    channel: NotificationChannel = channelFor(identifier),
  ): Promise<void> {
    await this.notifications.send({ channel, recipient: identifier, subject, text });
  }
}
