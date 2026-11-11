import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  FieldCipher,
  FieldCipherError,
  parseFieldKeys,
  type FieldContext,
} from "./field-cipher.js";

const hex = () => randomBytes(32).toString("hex");
const context: FieldContext = {
  tenantId: "20000000-0000-4000-8000-000000000001",
  table: "labourers",
  column: "id_number_enc",
  rowId: "50000000-0000-4000-8000-000000000001",
};

describe("field encryption keys", () => {
  it("requires keys and refuses malformed, duplicate or inconsistent settings without echoing them", () => {
    const key = hex();
    expect(() => parseFieldKeys(undefined, undefined, hex())).toThrow(/required/);
    expect(() => parseFieldKeys(`1:${key}`, undefined, undefined)).toThrow(/required/);
    expect(() => parseFieldKeys(key, undefined, hex())).toThrow(/<version>:<64 hex>/);
    expect(() => parseFieldKeys(`1:${key},1:${hex()}`, undefined, hex())).toThrow(/twice/);
    expect(() => parseFieldKeys(`0:${key}`, undefined, hex())).toThrow(/1–255/);
    expect(() => parseFieldKeys(`1:${key}`, 2, hex())).toThrow(/not in/);
    expect(() => parseFieldKeys(`1:${key}`, undefined, key)).toThrow(/differ/);
    try {
      parseFieldKeys(`1:${key}`, undefined, key);
    } catch (error) {
      expect((error as Error).message).not.toContain(key);
    }
  });

  it("uses the highest version unless another active version is chosen", () => {
    expect(parseFieldKeys(`1:${hex()}, 3:${hex()}`, undefined, hex()).activeVersion).toBe(3);
    expect(parseFieldKeys(`1:${hex()},3:${hex()}`, 1, hex()).activeVersion).toBe(1);
  });
});

describe("FieldCipher", () => {
  const keys = parseFieldKeys(`1:${hex()}`, undefined, hex());
  const cipher = new FieldCipher(keys);

  it("round-trips with a fresh nonce and never contains the plaintext", () => {
    const first = cipher.encrypt(context, "23456789");
    const second = cipher.encrypt(context, "23456789");
    expect(cipher.decrypt(context, first)).toBe("23456789");
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false);
    expect(first[0]).toBe(1);
    expect(first[1]).toBe(1);
    expect(first.length).toBe(2 + 12 + 8 + 16);
    expect(Buffer.from(first).includes(Buffer.from("23456789"))).toBe(false);
    expect(cipher.decrypt(context, cipher.encrypt(context, "Mama Wanjiru — dada"))).toBe(
      "Mama Wanjiru — dada",
    );
  });

  it("detects tampering of the nonce, body, tag and key-version byte", () => {
    const envelope = cipher.encrypt(context, "254700000001");
    for (const position of [2, 14, envelope.length - 1]) {
      const tampered = Uint8Array.from(envelope);
      tampered[position]! ^= 0x01;
      expect(() => cipher.decrypt(context, tampered)).toThrow(FieldCipherError);
    }
    const otherVersion = Uint8Array.from(envelope);
    otherVersion[1] = 2;
    expect(() => cipher.decrypt(context, otherVersion)).toThrow(/version 2/);
    expect(() => cipher.decrypt(context, Uint8Array.from([0x32, 0x33, 0x34]))).toThrow(
      /Not a field ciphertext/,
    );
  });

  it("binds a ciphertext to its company, table, column and row", () => {
    const envelope = cipher.encrypt(context, "A900000001Z");
    for (const moved of [
      { ...context, tenantId: "20000000-0000-4000-8000-000000000002" },
      { ...context, table: "gangs" },
      { ...context, column: "phone_enc" },
      { ...context, rowId: "50000000-0000-4000-8000-000000000002" },
    ])
      expect(() => cipher.decrypt(moved, envelope)).toThrow(FieldCipherError);
  });

  it("fails with the wrong key and never leaks values in the error", () => {
    const envelope = cipher.encrypt(context, "23456789");
    const stranger = new FieldCipher(parseFieldKeys(`1:${hex()}`, undefined, hex()));
    try {
      stranger.decrypt(context, envelope);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FieldCipherError);
      expect((error as Error).message).not.toMatch(/23456789/);
    }
  });

  it("rotates keys: old versions stay readable while listed, new values use the active key", () => {
    const v1 = hex();
    const old = new FieldCipher(parseFieldKeys(`1:${v1}`, undefined, hex()));
    const envelope = old.encrypt(context, "AK0123456");
    const rotated = new FieldCipher(parseFieldKeys(`1:${v1},2:${hex()}`, undefined, hex()));
    expect(rotated.decrypt(context, envelope)).toBe("AK0123456");
    expect(rotated.needsRotation(envelope)).toBe(true);
    const fresh = rotated.reencrypt(context, envelope);
    expect(rotated.keyVersionOf(fresh)).toBe(2);
    expect(rotated.needsRotation(fresh)).toBe(false);
    expect(rotated.decrypt(context, fresh)).toBe("AK0123456");
    // Once version 1 is removed, values still under it can no longer be read.
    const retired = new FieldCipher(
      parseFieldKeys(`2:${Buffer.from(hex(), "hex").toString("hex")}`, undefined, hex()),
    );
    expect(() => retired.decrypt(context, envelope)).toThrow(/version 1/);
  });

  it("derives keyed, per-company blind indexes for exact matching", () => {
    const tenantB = "20000000-0000-4000-8000-000000000002";
    const index = cipher.blindIndex(context.tenantId, "id", "national_id:23456789");
    expect(index).toMatch(/^[0-9a-f]{64}$/);
    expect(cipher.blindIndex(context.tenantId, "id", "national_id:23456789")).toBe(index);
    expect(cipher.blindIndex(context.tenantId, "id", "national_id:23456780")).not.toBe(index);
    expect(cipher.blindIndex(context.tenantId, "phone", "national_id:23456789")).not.toBe(index);
    expect(cipher.blindIndex(tenantB, "id", "national_id:23456789")).not.toBe(index);
    const otherKey = new FieldCipher(parseFieldKeys(`1:${hex()}`, undefined, hex()));
    expect(otherKey.blindIndex(context.tenantId, "id", "national_id:23456789")).not.toBe(index);
  });
});
