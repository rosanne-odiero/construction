import { describe, expect, it } from "vitest";
import { allowedSource, parseAllowList } from "./payments-runtime.js";

describe("payment callback source allow-list", () => {
  it("matches exact addresses and IPv4 networks, including mapped IPv4 sources", () => {
    const entries = parseAllowList("192.0.2.4, 198.51.100.128/25, ::1");
    for (const ip of ["192.0.2.4", "::ffff:192.0.2.4", "198.51.100.128", "198.51.100.255", "::1"])
      expect(allowedSource(entries, ip), ip).toBe(true);
    for (const ip of [undefined, "192.0.2.5", "198.51.100.127", "2001:db8::1"])
      expect(allowedSource(entries, ip), ip).toBe(false);
    expect(allowedSource(parseAllowList("::ffff:192.0.2.4"), "192.0.2.4")).toBe(true);
  });

  it.each(["192.0.2.4/", "192.0.2.4/0/24", "192.0.2.4/33", "192.0.2.4/-1", "300.1.2.3", "host"])(
    "rejects malformed configuration instead of broadening the allowed network: %s",
    (entry) => {
      expect(() => parseAllowList(entry)).toThrow("PAYMENTS_CALLBACK_IP_ALLOWLIST");
    },
  );
});
