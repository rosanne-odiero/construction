import type { ConfigService } from "@nestjs/config";
import type { ApiEnv } from "@pm-buddy/validation";
import { describe, expect, it } from "vitest";
import { AppConfig, trustProxySetting } from "./app-config.js";

const config = (values: Partial<Record<keyof ApiEnv, unknown>>) =>
  new AppConfig({
    get: (key: keyof ApiEnv) => values[key],
  } as unknown as ConfigService<ApiEnv, true>);

describe("AppConfig production defaults", () => {
  it("hides the API docs in production unless explicitly enabled", () => {
    expect(config({ NODE_ENV: "development" }).apiDocsEnabled).toBe(true);
    expect(config({ NODE_ENV: "production" }).apiDocsEnabled).toBe(false);
    expect(config({ NODE_ENV: "production", API_DOCS_ENABLED: true }).apiDocsEnabled).toBe(true);
    expect(config({ NODE_ENV: "development", API_DOCS_ENABLED: false }).apiDocsEnabled).toBe(false);
  });
});

describe("trustProxySetting", () => {
  it("trusts no proxy unless configured", () => {
    expect(trustProxySetting(undefined)).toBe(false);
    expect(trustProxySetting("false")).toBe(false);
  });

  it("accepts a hop count or a list of addresses and ranges", () => {
    expect(trustProxySetting("1")).toBe(1);
    expect(trustProxySetting("loopback, 10.0.0.0/8")).toEqual(["loopback", "10.0.0.0/8"]);
  });
});
