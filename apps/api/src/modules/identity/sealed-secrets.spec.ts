import { randomBytes } from "node:crypto";
import { EncryptJWT } from "jose";
import { describe, expect, it } from "vitest";
import { parseSealKeys, SealedSecrets } from "./sealed-secrets.js";

const k1 = randomBytes(32).toString("hex");
const k2 = randomBytes(32).toString("hex");
const box = (raw: string, active?: number) => new SealedSecrets(parseSealKeys(raw, active)!);

describe("SealedSecrets (AUTH_MFA_ENCRYPTION_KEY rotation)", () => {
  it("reads values sealed before versioning (no kid) as version 1", async () => {
    const legacy = await new EncryptJWT({ secret: "JBSWY3DPEHPK3PXP", purpose: "totp:u1" })
      .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
      .encrypt(Buffer.from(k1, "hex"));
    const rotating = box(`1:${k1},2:${k2}`, 2);
    expect(rotating.versionOf(legacy)).toBe(1);
    expect(await rotating.open(legacy, "totp:u1")).toBe("JBSWY3DPEHPK3PXP");
    expect(rotating.needsRewrap(legacy)).toBe(true);
  });

  it("seals under the active version and moves old values to it", async () => {
    const old = await box(k1).seal("seed", "totp:u2");
    expect(box(k1).versionOf(old)).toBe(1);
    const rotating = box(`1:${k1},2:${k2}`, 2);
    const moved = await rotating.rewrap(old, "totp:u2");
    expect(rotating.versionOf(moved)).toBe(2);
    expect(rotating.needsRewrap(moved)).toBe(false);
    // Once version 1 is removed, only the moved value reads.
    const retired = box(`2:${k2}`, 2);
    expect(await retired.open(moved, "totp:u2")).toBe("seed");
    await expect(retired.open(old, "totp:u2")).rejects.toThrow();
    // The purpose is bound: a value sealed for one user is refused for another.
    await expect(retired.open(moved, "totp:u3")).rejects.toThrow(/purpose/);
  });

  it("refuses malformed or ambiguous key lists without echoing key material", () => {
    expect(parseSealKeys(undefined)).toBeNull();
    expect(parseSealKeys(k1)!.active).toBe(1);
    expect(() => parseSealKeys(`1:${k1},2:${k2}`)).toThrow(/ACTIVE_KEY_VERSION is required/);
    expect(() => parseSealKeys(`1:${k1},1:${k2}`, 1)).toThrow(/twice/);
    expect(() => parseSealKeys(`1:${k1}`, 2)).toThrow(/not in/);
    try {
      parseSealKeys(`1:${k1},x:${k2}`, 1);
    } catch (error) {
      expect(String(error)).not.toContain(k1);
      expect(String(error)).not.toContain(k2);
    }
  });
});
