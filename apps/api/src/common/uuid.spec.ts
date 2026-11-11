import { describe, expect, it } from "vitest";
import { uuidv7 } from "./uuid.js";

describe("uuidv7", () => {
  it("is a version 7, variant 1 UUID that sorts by creation time", () => {
    const first = uuidv7(1_700_000_000_000);
    const second = uuidv7(1_700_000_000_001);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first.slice(0, 13)).toBe("018bcfe5-6800");
    expect(second > first).toBe(true);
    expect(new Set(Array.from({ length: 1_000 }, () => uuidv7())).size).toBe(1_000);
  });
});
