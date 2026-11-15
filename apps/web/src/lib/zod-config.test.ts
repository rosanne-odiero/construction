import { afterEach, describe, expect, it, vi } from "vitest";

describe("zod in the browser bundle", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("never probes eval, which the production CSP blocks", async () => {
    const probe = vi.fn(() => {
      throw new EvalError("Refused to evaluate a string as JavaScript (CSP)");
    });
    vi.stubGlobal("Function", probe);
    await import("./zod-config");
    const { z } = await import("zod");
    expect(z.object({ name: z.string() }).parse({ name: "Ruiru" })).toEqual({ name: "Ruiru" });
    expect(probe).not.toHaveBeenCalled();
  });
});
