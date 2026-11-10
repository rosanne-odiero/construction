import { describe, expect, it } from "vitest";
import {
  apiEnvSchema,
  kenyanPhoneSchema,
  moneySchema,
  paginationQuerySchema,
  problemDetailsSchema,
  readyResponseSchema,
} from "./index.js";

const validEnv = {
  DATABASE_URL: "postgresql://pmb_app:secret@localhost:55432/pmb",
  REDIS_URL: "redis://localhost:56379",
  S3_ENDPOINT: "http://localhost:9000",
  S3_BUCKET: "pmb-local",
  S3_ACCESS_KEY_ID: "pmbdev",
  S3_SECRET_ACCESS_KEY: "pmbdevsecret",
};

describe("apiEnvSchema", () => {
  it("applies safe defaults", () => {
    const env = apiEnvSchema.parse(validEnv);
    expect(env.PORT).toBe(4000);
    expect(env.NODE_ENV).toBe("development");
    expect(env.S3_FORCE_PATH_STYLE).toBe(true);
    expect(env.S3_AUTO_CREATE_BUCKET).toBe(false);
  });

  it("coerces string values from the environment", () => {
    const env = apiEnvSchema.parse({ ...validEnv, PORT: "4100", S3_AUTO_CREATE_BUCKET: "true" });
    expect(env.PORT).toBe(4100);
    expect(env.S3_AUTO_CREATE_BUCKET).toBe(true);
  });

  it("fails fast on missing or malformed settings", () => {
    expect(apiEnvSchema.safeParse({ ...validEnv, DATABASE_URL: "not a url" }).success).toBe(false);
    const { REDIS_URL: _omitted, ...withoutRedis } = validEnv;
    expect(apiEnvSchema.safeParse(withoutRedis).success).toBe(false);
  });
});

describe("kenyanPhoneSchema", () => {
  it("normalises valid numbers", () => {
    expect(kenyanPhoneSchema.parse("0712 345 678")).toBe("254712345678");
  });

  it("rejects invalid numbers with a stable message", () => {
    const result = kenyanPhoneSchema.safeParse("020 123 4567");
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("invalid_kenyan_phone");
  });
});

describe("moneySchema", () => {
  it("accepts integer minor units only", () => {
    expect(moneySchema.safeParse({ amountMinor: 125_000_050, currency: "KES" }).success).toBe(true);
    expect(moneySchema.safeParse({ amountMinor: 1250.5, currency: "KES" }).success).toBe(false);
    expect(moneySchema.safeParse({ amountMinor: 100, currency: "TZS" }).success).toBe(false);
  });
});

describe("paginationQuerySchema", () => {
  it("defaults and bounds the page size", () => {
    expect(paginationQuerySchema.parse({}).limit).toBe(50);
    expect(paginationQuerySchema.parse({ limit: "200" }).limit).toBe(200);
    expect(paginationQuerySchema.safeParse({ limit: "500" }).success).toBe(false);
  });
});

describe("health and problem schemas", () => {
  it("parses a ready response", () => {
    const up = { status: "up", latencyMs: 3 };
    const result = readyResponseSchema.safeParse({
      status: "ok",
      service: "pm-buddy-api",
      version: "0.1.0",
      time: "2026-11-10T10:00:00.000+03:00",
      checks: { database: up, redis: up, storage: up },
    });
    expect(result.success).toBe(true);
  });

  it("parses RFC 9457 problem details", () => {
    expect(
      problemDetailsSchema.safeParse({
        type: "https://pm-buddy.dev/problems/not-found",
        title: "Not Found",
        status: 404,
        traceId: "abc",
      }).success,
    ).toBe(true);
  });
});
