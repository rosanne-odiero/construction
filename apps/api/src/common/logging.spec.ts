import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { requestId, serializeRequest, serializeResponse } from "./logging.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function exchange(inbound?: string) {
  const req = {
    headers: inbound === undefined ? {} : { "x-request-id": inbound },
  } as IncomingMessage;
  const setHeader = vi.fn();
  return { req, res: { setHeader } as unknown as ServerResponse, setHeader };
}

describe("requestId", () => {
  it("reuses a well-formed inbound X-Request-Id and echoes it", () => {
    const { req, res, setHeader } = exchange("trace-abc-12345");
    expect(requestId(req, res)).toBe("trace-abc-12345");
    expect(setHeader).toHaveBeenCalledWith("X-Request-Id", "trace-abc-12345");
  });

  it("creates a UUID when none is sent", () => {
    const { req, res, setHeader } = exchange();
    const id = requestId(req, res);
    expect(id).toMatch(UUID);
    expect(setHeader).toHaveBeenCalledWith("X-Request-Id", id);
  });

  it.each([
    "short",
    "has spaces in it",
    "x".repeat(65),
    "<script>alert(1)</script>",
    "line\nbreak-1234",
  ])("replaces the unsafe inbound value %j", (inbound) => {
    const { req, res } = exchange(inbound);
    expect(requestId(req, res)).toMatch(UUID);
  });
});

describe("log serializers", () => {
  it("keep request trace fields and drop headers and the query string", () => {
    const logged = serializeRequest({
      id: "req-1",
      method: "GET",
      url: "/api/v1/workers?phone=0712345678",
      headers: { authorization: "Bearer secret", cookie: "session=abc" },
      remoteAddress: "10.0.0.5",
      remotePort: 50_000,
      params: {},
      query: { phone: "0712345678" },
      raw: {} as IncomingMessage,
    });
    expect(logged).toEqual({
      id: "req-1",
      method: "GET",
      url: "/api/v1/workers",
      remoteAddress: "10.0.0.5",
    });
  });

  it("keep only the response status", () => {
    const logged = serializeResponse({
      statusCode: 201,
      headers: { "set-cookie": "__Host-pmb_rt=secret" },
      raw: {} as ServerResponse,
    });
    expect(logged).toEqual({ statusCode: 201 });
  });
});
