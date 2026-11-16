import { describe, expect, it } from "vitest";
import {
  generateTemplateKeyPair,
  parseTemplateKeyList,
  sealedKeyVersion,
  TemplateOpener,
  TemplateSealer,
} from "./template-sealer.js";

const pairs = [generateTemplateKeyPair(), generateTemplateKeyPair()];
const keyMap = (side: "publicKey" | "privateKey", versions = [1, 2]) =>
  new Map(versions.map((version) => [version, Buffer.from(pairs[version - 1]![side], "hex")]));
const context = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  templateId: "20000000-0000-4000-8000-000000000001",
};
const template = Buffer.from("not an image: an SDK's opaque template bytes", "utf8");

describe("TemplateSealer", () => {
  it("seals to the active public key; only the matching private key opens it", () => {
    const envelope = new TemplateSealer(keyMap("publicKey"), 2).seal(context, template);
    expect(envelope[0]).toBe(2);
    expect(sealedKeyVersion(envelope)).toBe(2);
    expect(envelope.length).toBe(2 + 32 + 12 + template.length + 16);
    expect(new TemplateOpener(keyMap("privateKey")).open(context, envelope)).toEqual(template);
    expect(() => new TemplateOpener(keyMap("privateKey", [1])).open(context, envelope)).toThrow(
      /No biometric template private key with version 2/,
    );
  });

  it("binds a ciphertext to its company and row, and never repeats one", () => {
    const sealer = new TemplateSealer(keyMap("publicKey"), 1);
    const opener = new TemplateOpener(keyMap("privateKey"));
    const envelope = sealer.seal(context, template);
    expect(Buffer.from(sealer.seal(context, template))).not.toEqual(Buffer.from(envelope));
    for (const moved of [
      { ...context, templateId: "20000000-0000-4000-8000-000000000002" },
      { ...context, tenantId: "10000000-0000-4000-8000-000000000002" },
    ])
      expect(() => opener.open(moved, envelope)).toThrow(/could not be opened/);
    const tampered = Uint8Array.from(envelope);
    tampered[60] = tampered[60]! ^ 1;
    expect(() => opener.open(context, tampered)).toThrow(/could not be opened/);
  });

  it("refuses malformed key lists and an active version without a key", () => {
    const hex = pairs[0]!.publicKey;
    expect(() => parseTemplateKeyList("KEYS", `1:${hex.slice(2)}`)).toThrow(/<version>:<64 hex>/);
    expect(() => parseTemplateKeyList("KEYS", `1:${hex},1:${hex}`)).toThrow(/twice/);
    expect(() => parseTemplateKeyList("KEYS", `1:${hex}`, 2)).toThrow(/active version 2/);
    expect(parseTemplateKeyList("KEYS", `1:${hex}, 3:${pairs[1]!.publicKey}`).activeVersion).toBe(
      3,
    );
  });
});
