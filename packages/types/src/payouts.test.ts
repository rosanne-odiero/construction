import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAYOUT_SETTINGS,
  DEMO_B2C_TARIFF_BANDS,
  DEMO_PAYMENT_LIMITS,
  PAYOUT_ACTION_RULES,
  PAYOUT_SETTINGS_LIMITS,
  PAYOUT_STEP_UP_ACTIONS,
  RECONCILIATION_OUTCOMES_BY_KIND,
  SYSTEM_ROLE_PERMISSIONS,
} from "./index.js";

describe("payout vocabulary (D4.3)", () => {
  it("keeps the default settings inside their limits", () => {
    for (const key of [
      "cashMaxPerWorkerPeriodMinor",
      "nameMatchThreshold",
      "payeeChangeHoldHours",
      "unusualNewRecipientMinor",
      "floatCheckMaxAgeMinutes",
      "waiverLimitMinor",
    ] as const) {
      expect(DEFAULT_PAYOUT_SETTINGS[key], key).toBeGreaterThanOrEqual(
        PAYOUT_SETTINGS_LIMITS[key].min,
      );
      expect(DEFAULT_PAYOUT_SETTINGS[key], key).toBeLessThanOrEqual(
        PAYOUT_SETTINGS_LIMITS[key].max,
      );
    }
  });

  it("prices every DEMO B2C amount with the DEMO tariff", () => {
    expect(DEMO_B2C_TARIFF_BANDS.at(-1)?.upToMinor).toBeGreaterThanOrEqual(
      DEMO_PAYMENT_LIMITS.b2cMaxMinor,
    );
  });

  it("leaves the system's own reconciliation outcomes to the system", () => {
    for (const outcomes of Object.values(RECONCILIATION_OUTCOMES_BY_KIND)) {
      expect(outcomes).not.toContain("auto_matched");
      expect(outcomes).not.toContain("superseded");
    }
  });

  it("lets the owner do every payout action and needs step-up for money and approvals", () => {
    for (const rule of Object.values(PAYOUT_ACTION_RULES))
      expect(
        rule.anyOf.some((permission) => SYSTEM_ROLE_PERMISSIONS.owner.includes(permission)),
      ).toBe(true);
    expect(PAYOUT_STEP_UP_ACTIONS).toEqual(
      expect.arrayContaining([
        "approve",
        "startPayouts",
        "recordManualPayment",
        "confirmManualPayment",
        "updateWaiver",
        "releaseHold",
        "resolveItem",
      ]),
    );
    expect(PAYOUT_STEP_UP_ACTIONS).not.toContain("floatCheck");
  });
});
