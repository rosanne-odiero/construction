import { describe, expect, it } from "vitest";
import { trustProxySetting, validateEnv } from "./app-config.js";

describe("trustProxySetting", () => {
  it("trusts no proxy unless configured", () => {
    expect(trustProxySetting(undefined)).toBe(false);
    expect(trustProxySetting("false")).toBe(false);
  });

  describe("notification environment", () => {
    const base = {
      DATABASE_URL: "postgresql://localhost/pmb",
      REDIS_URL: "redis://localhost",
      S3_ENDPOINT: "http://localhost:9000",
      S3_BUCKET: "pmb-local",
      S3_ACCESS_KEY_ID: "local",
      S3_SECRET_ACCESS_KEY: "local",
    };
    const sms = { AFRICAS_TALKING_USERNAME: "application", AFRICAS_TALKING_API_KEY: "synthetic" };
    const whatsapp = {
      WHATSAPP_ACCESS_TOKEN: "synthetic",
      WHATSAPP_PHONE_NUMBER_ID: "123456",
      WHATSAPP_GRAPH_API_VERSION: "v25.0",
    };

    it("defaults to disabled even in production and permits explicitly configured real channels", () => {
      expect(validateEnv({ ...base, NODE_ENV: "production" }).AUTH_NOTIFICATION_TRANSPORT).toBe(
        "disabled",
      );
      for (const channels of [sms, whatsapp, { ...sms, ...whatsapp }]) {
        expect(
          validateEnv({ ...base, AUTH_NOTIFICATION_TRANSPORT: "real", ...channels })
            .AUTH_NOTIFICATION_TRANSPORT,
        ).toBe("real");
      }
    });

    it.each([
      { AUTH_NOTIFICATION_TRANSPORT: "real" },
      { AFRICAS_TALKING_USERNAME: "application" },
      { AFRICAS_TALKING_SENDER_ID: "PMBuddy" },
      { WHATSAPP_ACCESS_TOKEN: "synthetic" },
      { ...sms, AFRICAS_TALKING_API_KEY: "bad\nheader" },
      { ...sms, AFRICAS_TALKING_SENDER_ID: "bad sender" },
      { ...sms, AUTH_NOTIFICATION_TRANSPORT: "real", AFRICAS_TALKING_USERNAME: "sandbox" },
      { ...whatsapp, WHATSAPP_PHONE_NUMBER_ID: "../messages" },
      { ...whatsapp, WHATSAPP_GRAPH_API_VERSION: "latest" },
      { ...whatsapp, WHATSAPP_ACCESS_TOKEN: " " },
      { NOTIFICATION_TIMEOUT_MS: "0" },
      { NOTIFICATION_TIMEOUT_MS: "30001" },
    ])("fails fast for invalid/incomplete configuration: %j", (overrides) => {
      expect(() => validateEnv({ ...base, ...overrides })).toThrow("Invalid API environment");
    });

    it("enables USSD only with a valid token and service code together", () => {
      expect(validateEnv(base).USSD_CALLBACK_TOKEN).toBeUndefined();
      const ussd = { USSD_CALLBACK_TOKEN: "a1".repeat(32), USSD_SERVICE_CODE: "*384*123#" };
      expect(validateEnv({ ...base, ...ussd }).USSD_SERVICE_CODE).toBe("*384*123#");
      for (const overrides of [
        { USSD_CALLBACK_TOKEN: ussd.USSD_CALLBACK_TOKEN },
        { USSD_SERVICE_CODE: ussd.USSD_SERVICE_CODE },
        { ...ussd, USSD_CALLBACK_TOKEN: "not-a-token" },
        { ...ussd, USSD_SERVICE_CODE: "*384/123#" },
      ]) {
        expect(() => validateEnv({ ...base, ...overrides })).toThrow("Invalid API environment");
      }
    });
  });

  it("accepts a hop count or a list of addresses and ranges", () => {
    expect(trustProxySetting("1")).toBe(1);
    expect(trustProxySetting("loopback, 10.0.0.0/8")).toEqual(["loopback", "10.0.0.0/8"]);
  });
});
