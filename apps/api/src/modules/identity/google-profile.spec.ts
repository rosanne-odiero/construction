import { describe, expect, it } from "vitest";
import { googleProfile } from "./google-profile.js";

const base = { sub: "109876543210", email: "Wanjiru.Kamau@Gmail.com", email_verified: true };

describe("googleProfile", () => {
  it("accepts verified Gmail addresses, lower-cased, with a safe display name", () => {
    expect(googleProfile({ ...base, name: "  Wanjiru\u0007 Kamau " })).toEqual({
      subject: "109876543210",
      email: "wanjiru.kamau@gmail.com",
      displayName: "Wanjiru Kamau",
    });
    expect(googleProfile({ ...base, email: "a@googlemail.com" })?.email).toBe("a@googlemail.com");
    expect(googleProfile(base)?.displayName).toBe("wanjiru.kamau");
    expect(googleProfile({ ...base, name: "x".repeat(300) })?.displayName).toHaveLength(100);
  });

  it("accepts Workspace addresses only when the hosted domain matches the email domain", () => {
    const workspace = { ...base, email: "qs@jenga-bora.co.ke" };
    expect(googleProfile({ ...workspace, hd: "jenga-bora.co.ke" })?.email).toBe(
      "qs@jenga-bora.co.ke",
    );
    expect(googleProfile({ ...workspace, hd: "JENGA-BORA.CO.KE" })).not.toBeNull();
    expect(googleProfile(workspace)).toBeNull();
    expect(googleProfile({ ...workspace, hd: "other.co.ke" })).toBeNull();
    expect(googleProfile({ ...base, email: "x@sub.gmail.com" })).toBeNull();
  });

  it("refuses unverified, missing or malformed identities", () => {
    for (const claims of [
      { ...base, email_verified: false },
      { ...base, email_verified: "true" },
      { ...base, email: undefined },
      { ...base, email: "0712345678" },
      { ...base, email: "not an email@gmail.com" },
      { ...base, sub: "" },
      { ...base, sub: "x".repeat(256) },
      { ...base, sub: "abc\n" },
      { ...base, sub: 42 },
    ])
      expect(googleProfile(claims), JSON.stringify(claims)).toBeNull();
  });
});
