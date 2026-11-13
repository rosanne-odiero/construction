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
  // Without it, rate limits use accounts, users and sessions only (no per-IP limit).
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

  API_DOCS_ENABLED: z.stringbool().default(true),
  HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(2_000),

  // Payments and Daraja (D4.2; docs/CONFIGURATION.md §4 and §8). Workers (outbox relay, BullMQ
  // consumers, watchdog) run inside the API process unless switched off.
  PAYMENTS_WORKERS_ENABLED: z.stringbool().default(true),
  // Public HTTPS base URL Safaricom posts callbacks to (required for the sandbox; production is
  // gated off). Defaults to http://localhost:<PORT> outside production, which only the mock reaches.
  PAYMENTS_CALLBACK_BASE_URL: z.url().optional(),
  // Optional source-IP allow-list for callbacks (comma-separated addresses or IPv4 CIDRs). Defence
  // in depth only, never proof of payment; needs TRUST_PROXY behind a proxy. Empty: disabled.
  PAYMENTS_CALLBACK_IP_ALLOWLIST: z.string().trim().optional(),
  PAYMENTS_CALLBACK_MAX_BYTES: z.coerce.number().int().min(1_024).max(1_048_576).default(32_768),
  DARAJA_MOCK_BASE_URL: z.url().default("http://localhost:4690"),
  DARAJA_SANDBOX_BASE_URL: z.url().default("https://sandbox.safaricom.co.ke"),
  // Safaricom's public sandbox certificate (PEM) used to encrypt the initiator password. The
  // production certificate comes from the secrets manager when production is enabled.
  DARAJA_SANDBOX_CERTIFICATE_PATH: z.string().min(1).optional(),
  DARAJA_HTTP_TIMEOUT_MS: z.coerce.number().int().min(500).max(120_000).default(15_000),
  PAYMENTS_SUBMIT_LEASE_SECONDS: z.coerce.number().int().min(5).max(3_600).default(120),
  PAYMENTS_RESULT_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(86_400).default(600),
  PAYMENTS_STATUS_QUERY_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(86_400).default(300),
  PAYMENTS_STATUS_QUERY_MAX: z.coerce.number().int().min(0).max(20).default(3),
  PAYMENTS_RELAY_INTERVAL_MS: z.coerce.number().int().min(100).max(600_000).default(2_000),
  PAYMENTS_OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(8),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;
