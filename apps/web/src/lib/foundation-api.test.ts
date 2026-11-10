import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { FoundationApiError, foundationRequest } from "./foundation-api";

afterEach(() => vi.unstubAllGlobals());

it("uses same-origin cookies and validates successful API responses", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ value: "saved" })));
  vi.stubGlobal("fetch", fetchMock);
  expect(
    await foundationRequest("/example", z.object({ value: z.string() }), {
      method: "POST",
      body: { name: "Synthetic" },
      headers: { "X-CSRF-Token": "synthetic-token" },
    }),
  ).toEqual({ value: "saved" });
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/v1/example",
    expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: expect.objectContaining({ "X-CSRF-Token": "synthetic-token" }),
    }),
  );
});

it("never treats an invalid response as saved data", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ unexpected: true }))),
  );
  await expect(
    foundationRequest("/example", z.object({ value: z.string() })),
  ).rejects.toMatchObject({ code: "invalidResponse" });
});

it("preserves error codes and trace IDs without exposing arbitrary response fields", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "forbidden",
          traceId: "synthetic-trace",
          detail: "Not displayed directly",
        }),
        { status: 403 },
      ),
    ),
  );
  await expect(foundationRequest("/example", z.unknown())).rejects.toMatchObject({
    status: 403,
    code: "forbidden",
    traceId: "synthetic-trace",
  });
});

it("surfaces connectivity failure without retrying state-changing requests", async () => {
  const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
  vi.stubGlobal("fetch", fetchMock);
  await expect(
    foundationRequest("/example", z.unknown(), { method: "POST" }),
  ).rejects.toBeInstanceOf(FoundationApiError);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("rejects malformed JSON and permits a deliberately empty response", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response("<html>Proxy error</html>"))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
  await expect(foundationRequest("/example", z.unknown())).rejects.toMatchObject({
    code: "invalidResponse",
  });
  expect(await foundationRequest("/example", z.undefined(), { method: "DELETE" })).toBeUndefined();
});
