import { describe, expect, it } from "vitest";
import { describeError } from "./errors.js";

describe("describeError", () => {
  it("uses the message when there is one", () => {
    expect(describeError(new Error("connection reset"))).toBe("connection reset");
  });

  it("falls back to the errno code for Node's empty-message connect failures", () => {
    const refused = Object.assign(new AggregateError([], ""), { code: "ECONNREFUSED" });
    expect(describeError(refused)).toBe("ECONNREFUSED");
  });

  it("falls back to the error name, then stringifies non-errors", () => {
    expect(describeError(new TypeError(""))).toBe("TypeError");
    expect(describeError("plain failure")).toBe("plain failure");
  });
});
