import { describe, expect, it } from "vitest";
import { trustProxySetting } from "./app-config.js";

describe("trustProxySetting", () => {
  it("trusts no proxy unless configured", () => {
    expect(trustProxySetting(undefined)).toBe(false);
    expect(trustProxySetting("false")).toBe(false);
  });

  it("accepts a hop count or a list of addresses and ranges", () => {
    expect(trustProxySetting("1")).toBe(1);
    expect(trustProxySetting("loopback, 10.0.0.0/8")).toEqual(["loopback", "10.0.0.0/8"]);
  });
});
