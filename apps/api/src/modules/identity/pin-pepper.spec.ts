import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../config/app-config.js";
import { hashPassword, verifyPassword } from "./auth-security.service.js";
import { parsePinPepperKeys, pepperPin, PinHasher } from "./pin-pepper.js";

const key = () => randomBytes(32).toString("hex");
const hasher = (keys?: string, active?: number, production = false) =>
  new PinHasher({
    get: (name: string) =>
      ({ AUTH_PIN_PEPPER_KEYS: keys, AUTH_PIN_PEPPER_ACTIVE_VERSION: active })[name],
    isProduction: production,
  } as unknown as AppConfig);

describe("labourer PIN pepper", () => {
  it("parses versioned keys and refuses malformed or inconsistent ones", () => {
    const [one, two] = [key(), key()];
    expect(parsePinPepperKeys(undefined, undefined)).toBeNull();
    expect(parsePinPepperKeys(`1:${one}`, undefined)?.active).toBe(1);
    expect(parsePinPepperKeys(`1:${one}, 2:${two}`, 2)?.active).toBe(2);
    expect(parsePinPepperKeys(`1:${one},2:${two}`, 1)?.active).toBe(1);
    // With two keys an implicit active version would differ between instances mid-rotation.
    expect(() => parsePinPepperKeys(`1:${one},2:${two}`, undefined)).toThrow("is required");
    expect(() => parsePinPepperKeys(`1:${one},1:${two}`, 1)).toThrow("twice");
    expect(() => parsePinPepperKeys(`1:${one}`, 3)).toThrow("not in");
    expect(() => parsePinPepperKeys(`0:${one}`, undefined)).toThrow("1–255");
    expect(() => parsePinPepperKeys("1:abc", undefined)).toThrow("<version>:<64 hex>");
  });

  it("keys the PIN with the secret, so the stored hash alone cannot be checked", async () => {
    const one = key();
    expect(pepperPin(Buffer.from(one, "hex"), "530718")).toBe(
      pepperPin(Buffer.from(one, "hex"), "530718"),
    );
    expect(pepperPin(Buffer.from(one, "hex"), "530718")).not.toBe(
      pepperPin(Buffer.from(key(), "hex"), "530718"),
    );
    const pins = hasher(`1:${one}`);
    const stored = await pins.hash("530718");
    expect(stored.pinPepperVersion).toBe(1);
    expect(await verifyPassword(stored.pinHash, "530718")).toBe(false);
    expect(await pins.verify(stored, "530718")).toBe(true);
    expect(await pins.verify(stored, "530719")).toBe(false);
    expect(pins.needsRehash(stored)).toBe(false);
  });

  it("still accepts older unpeppered hashes and asks for them to be re-hashed", async () => {
    const legacy = { pinHash: await hashPassword("530718"), pinPepperVersion: null };
    const pins = hasher(`1:${key()}`);
    expect(await pins.verify(legacy, "530718")).toBe(true);
    expect(pins.needsRehash(legacy)).toBe(true);
  });

  it("moves PINs to the active key and refuses hashes whose key is no longer listed", async () => {
    const [one, two] = [key(), key()];
    const old = await hasher(`1:${one}`).hash("530718");
    const rotated = hasher(`1:${one},2:${two}`, 2);
    expect(await rotated.verify(old, "530718")).toBe(true);
    expect(rotated.needsRehash(old)).toBe(true);
    expect((await rotated.hash("530718")).pinPepperVersion).toBe(2);
    expect(await hasher(`2:${two}`).verify(old, "530718")).toBe(false);
  });

  it("spends a full Argon2id check on a hash whose key is not listed", async () => {
    const old = await hasher(`1:${key()}`).hash("530718");
    const pins = hasher(`2:${key()}`);
    const started = performance.now();
    expect(await pins.verify(old, "530718")).toBe(false);
    const missing = performance.now() - started;
    const listed = await pins.hash("530718");
    const again = performance.now();
    await pins.verify(listed, "530718");
    // Same order of cost as a real check, not an instant refusal that would reveal the version.
    expect(missing).toBeGreaterThan((performance.now() - again) / 4);
  });

  it("is required in production and optional locally (unpeppered, never re-hashed)", async () => {
    expect(() => hasher(undefined, undefined, true)).toThrow("Production requires");
    const local = hasher();
    const stored = await local.hash("530718");
    expect(stored.pinPepperVersion).toBeNull();
    expect(await local.verify(stored, "530718")).toBe(true);
    expect(local.needsRehash(stored)).toBe(false);
  });
});
