import { z } from "zod";

/**
 * API process environment. Validated once at startup so a misconfigured deployment fails fast.
 * Secrets come from the environment or a secrets manager, never from code (brief §7).
 */
export const apiEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  APP_VERSION: z.string().min(1).default("0.0.0-dev"),
  GIT_SHA: z.string().min(1).optional(),

  DATABASE_URL: z.url(),
  WEB_ORIGIN: z.url().default("http://localhost:3000"),
  // Express "trust proxy": the addresses (comma-separated, CIDR allowed) or hop count of proxies
  // allowed to report the client IP in X-Forwarded-For. Leave unset unless an edge proxy appends
  // the real client address: the Next.js /api rewrite passes client-supplied values through.
  // Without it, rate limits use accounts, users and sessions only (no per-IP limit), so production
  // refuses to start without it.
  TRUST_PROXY: z
    .string()
    .trim()
    .min(1)
    .refine((value) => value !== "true", "Never trust every proxy; list addresses or a hop count")
    .optional(),
  AUTH_SIGNING_PRIVATE_KEY: z.string().min(1).optional(),
  AUTH_MFA_ENCRYPTION_KEY: z
    .string()
    .regex(/^[a-fA-F0-9]{64}$/)
    .optional(),
  AUTH_NOTIFICATION_TRANSPORT: z.enum(["development", "disabled"]).default("disabled"),
  AUTH_MAILPIT_PORT: z.coerce.number().int().min(1).max(65535).default(8025),
  // Breached-password check on registration and reset: `hibp` asks the Have I Been Pwned range API
  // (k-anonymity: only the first five hex characters of the SHA-1 leave the server). It fails
  // open, with a warning, when the service is slow or unreachable.
  AUTH_BREACHED_PASSWORD_CHECK: z.enum(["off", "hibp"]).default("off"),
  // Field-level encryption of labourer identifiers (D3.1, ARCHITECTURE §10): comma-separated
  // `<version>:<64 hex characters>` keys (AES-256-GCM). New values use the active version (default:
  // the highest); older versions stay listed until every value is re-encrypted. The blind-index key
  // (HMAC-SHA-256) is separate. Secrets manager outside local development.
  FIELD_ENCRYPTION_KEYS: z
    .string()
    .trim()
    .regex(/^\d{1,3}:[0-9a-fA-F]{64}(,\s*\d{1,3}:[0-9a-fA-F]{64})*$/, "version:hexkey list")
    .optional(),
  FIELD_ENCRYPTION_ACTIVE_KEY_VERSION: z.coerce.number().int().min(1).max(255).optional(),
  FIELD_BLIND_INDEX_KEY: z
    .string()
    .regex(/^[a-fA-F0-9]{64}$/)
    .optional(),
  // Labourer PIN pepper (HMAC-SHA-256 before Argon2id): comma-separated `<version>:<64 hex>` keys,
  // like FIELD_ENCRYPTION_KEYS. New PINs use the active version (default: the highest); keep older
  // versions listed until every PIN using them has been re-hashed (each correct sign-in does it).
  // Required in production; from the secrets manager, never the database.
  AUTH_PIN_PEPPER_KEYS: z
    .string()
    .trim()
    .regex(/^\d{1,3}:[0-9a-fA-F]{64}(,\s*\d{1,3}:[0-9a-fA-F]{64})*$/, "version:hexkey list")
    .optional(),
  AUTH_PIN_PEPPER_ACTIVE_VERSION: z.coerce.number().int().min(1).max(255).optional(),
  // Wrong PINs per hour across every number before PIN sign-in tightens: an alert is logged and
  // each number then gets one wrong PIN before it needs an SMS reset (correct PINs still work).
  PIN_GLOBAL_FAILURES_PER_HOUR: z.coerce.number().int().min(10).max(100_000).default(200),
  // "Continue with Google" (OpenID Connect authorisation code flow with PKCE). Set both from a
  // Google Cloud OAuth "Web application" client, or neither to hide Google sign-in. The redirect
  // URI to register with Google is `${WEB_ORIGIN}/api/v1/auth/google/callback`.
  AUTH_GOOGLE_CLIENT_ID: z.string().trim().min(1).max(255).optional(),
  AUTH_GOOGLE_CLIENT_SECRET: z.string().trim().min(1).max(255).optional(),
  // Test-only issuer override (a local fake provider on loopback). Refused in production.
  AUTH_GOOGLE_ISSUER: z.url().optional(),

  REDIS_URL: z.url(),

  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().min(1).default("us-east-1"),
  S3_BUCKET: z.string().min(3),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z.stringbool().default(true),
  S3_AUTO_CREATE_BUCKET: z.stringbool().default(false),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  OTEL_SERVICE_NAME: z.string().min(1).default("pm-buddy-api"),

  // Malware scanning of uploads (ARCHITECTURE §17). `development` is a no-op that records
  // "not_scanned" and is refused in production; `disabled` (the default) refuses uploads until a
  // real scanner (ClamAV, TODO) is configured.
  MALWARE_SCANNER: z.enum(["development", "disabled"]).default("disabled"),
  // VAT on BQ grand summaries in percent (`bq.vat.rate`, COMPLIANCE-REVIEW CR-TAX-01). Each BQ
  // version stores the rate it was built with.
  BQ_VAT_RATE_PERCENT: z
    .string()
    .regex(
      /^(100(\.0{1,4})?|\d{1,2}(\.\d{1,4})?)$/,
      "A percentage between 0 and 100 with up to 4 decimals",
    )
    .default("16"),

  // The in-process report scheduler (D8.1, ARCHITECTURE §4.14): `on` checks for due report
  // subscriptions every minute (one instance at a time, under a Postgres advisory lock); `off`
  // leaves them for an administrator's "run due now". Unset: on, except under NODE_ENV=test.
  REPORT_SCHEDULER: z.enum(["on", "off"]).optional(),

  API_DOCS_ENABLED: z.stringbool().default(true),
  HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(2_000),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;
