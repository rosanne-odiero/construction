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

  API_DOCS_ENABLED: z.stringbool().default(true),
  HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(2_000),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;
