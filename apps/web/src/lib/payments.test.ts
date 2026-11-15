import { describe, expect, it } from "vitest";
import { paymentRoute, paymentTone, wholeKesMinor } from "./payments";

describe("payments console safety", () => {
  it("never gives uncertain, reversed or accepted outcomes a successful payment tone", () => {
    for (const status of [
      "unknown",
      "uncertain",
      "pending",
      "submitting",
      "queued",
      "reversal_pending",
      "reversed",
      "accepted",
    ])
      expect(paymentTone(status)).not.toBe("success");
    expect(paymentTone("confirmed")).toBe("success");
  });
  it("takes whole shillings only, without rounding or unsafe integer conversion", () => {
    expect(wholeKesMinor("100")).toBe(10000);
    for (const value of ["", "0", "-1", "1.01", "1e3", "Infinity", "99999999999999999"])
      expect(wholeKesMinor(value)).toBeNull();
  });
  it("rejects malformed or extra path segments", () => {
    expect(paymentRoute(["callbacks", "not-an-id"])).toBeNull();
    expect(paymentRoute(["requests", "90000000-0000-4000-8000-000000000001", "retry"])).toBeNull();
    expect(paymentRoute(["requests", "90000000-0000-4000-8000-000000000001"])?.kind).toBe(
      "requestsDetail",
    );
  });
});
