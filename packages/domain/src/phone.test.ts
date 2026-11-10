import { describe, expect, it } from "vitest";
import { isKenyanMobile, maskPhone, normalizeKenyanPhone } from "./phone.js";

describe("normalizeKenyanPhone", () => {
  it.each([
    ["0712 345 678", "254712345678"],
    ["+254 712-345-678", "254712345678"],
    ["712345678", "254712345678"],
    ["254712345678", "254712345678"],
    ["0110 123 456", "254110123456"],
  ])("normalises %s to %s", (input, expected) => {
    expect(normalizeKenyanPhone(input)).toBe(expected);
  });

  it.each([["020 123 4567"], ["07123"], ["254812345678"], [""], ["not a number"]])(
    "rejects %s",
    (input) => {
      expect(normalizeKenyanPhone(input)).toBeNull();
    },
  );
});

describe("isKenyanMobile and maskPhone", () => {
  it("accepts only the canonical form", () => {
    expect(isKenyanMobile("254712345678")).toBe(true);
    expect(isKenyanMobile("0712345678")).toBe(false);
  });

  it("masks the middle digits", () => {
    expect(maskPhone("254712345678")).toBe("2547•••••678");
  });
});
