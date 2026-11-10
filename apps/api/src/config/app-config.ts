import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { apiEnvSchema, type ApiEnv } from "@pm-buddy/validation";
import { z } from "zod";

/** Typed access to the validated environment (packages/validation/src/env.ts). */
@Injectable()
export class AppConfig {
  constructor(private readonly config: ConfigService<ApiEnv, true>) {}

  get<K extends keyof ApiEnv>(key: K): ApiEnv[K] {
    return this.config.get(key, { infer: true });
  }

  get isProduction(): boolean {
    return this.get("NODE_ENV") === "production";
  }
}

/** Used by ConfigModule: fails fast with a readable message when the environment is invalid. */
export function validateEnv(raw: Record<string, unknown>): ApiEnv {
  const result = apiEnvSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid API environment:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** `.env` first; `.env.example` fills gaps outside production so `pnpm dev` works after cloning. */
export function envFilePaths(nodeEnv = process.env["NODE_ENV"]): string[] {
  return nodeEnv === "production" ? [] : [".env", ".env.example"];
}
