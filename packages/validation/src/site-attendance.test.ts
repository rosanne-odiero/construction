import { describe, expect, it } from "vitest";
import { signedAttendanceEventSchema } from "./site-attendance.js";

describe("signed site attendance envelope", () => {
  const id = "01986c50-cacd-7000-8000-000000000001";
  const event = {
    schemaVersion: 1,
    id,
    deviceId: id,
    leaseId: id,
    tenantId: id,
    projectId: id,
    siteId: id,
    bootId: id,
    monotonicMs: 1500,
    capturedAt: "2026-11-15T04:00:00Z",
    direction: "in",
    shiftId: id,
    cardToken: `PMB1:${"a".repeat(64)}`,
    method: "nfc_card",
    position: null,
    photoSha256: "b".repeat(64),
    supervisorConfirmed: true,
  };
  it("requires explicit supervisor confirmation, a photo digest and bounded evidence", () => {
    expect(signedAttendanceEventSchema.safeParse(event).success).toBe(true);
    for (const change of [
      { supervisorConfirmed: false },
      { photoSha256: "" },
      { monotonicMs: Infinity },
      { position: { lat: 91, lng: 36, accuracyM: 1 } },
      { signature: "unsigned-extra" },
      { schemaVersion: 2 },
    ])
      expect(signedAttendanceEventSchema.safeParse({ ...event, ...change }).success).toBe(false);
  });
});
