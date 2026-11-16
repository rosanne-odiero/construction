import { describe, expect, it } from "vitest";
import { RedactingSpanExporter, redactSpan } from "./telemetry-redaction.js";

type Exported = Parameters<RedactingSpanExporter["export"]>[0];
type Span = Exported[number];

const TOKEN = "0f".repeat(32);
const HOOK = `/api/v1/payments/hooks/${TOKEN}/b2c-result`;

class FakeSpan {
  name = `POST ${HOOK}`;
  attributes: Record<string, unknown> = {
    "url.path": HOOK,
    "url.full": `https://api.example.test${HOOK}?attempt=1`,
    "http.target": HOOK,
    "http.route": "/api/v1/payments/hooks/:token/:kind",
    "http.request.header.referer": [`https://api.example.test${HOOK}`, "other"],
    "http.response.status_code": 200,
  };
  events = [
    { name: "exception", time: [0, 0], attributes: { "exception.message": `failed ${HOOK}` } },
    { name: "plain", time: [0, 0] },
  ];
  spanContext() {
    return { traceId: "1".repeat(32), spanId: "2".repeat(16), traceFlags: 1 };
  }
}

const span = (overrides: Partial<FakeSpan> = {}) =>
  Object.assign(new FakeSpan(), overrides) as unknown as Span;

describe("trace redaction (payment callback tokens)", () => {
  it("removes the token from the span name, attributes and event attributes", () => {
    const redacted = redactSpan(span());
    expect(JSON.stringify([redacted.name, redacted.attributes, redacted.events])).not.toContain(
      TOKEN,
    );
    expect(redacted.name).toBe("POST /api/v1/payments/hooks/[REDACTED]/b2c-result");
    expect(redacted.attributes).toEqual({
      "url.path": "/api/v1/payments/hooks/[REDACTED]/b2c-result",
      "url.full": "https://api.example.test/api/v1/payments/hooks/[REDACTED]/b2c-result?attempt=1",
      "http.target": "/api/v1/payments/hooks/[REDACTED]/b2c-result",
      "http.route": "/api/v1/payments/hooks/[REDACTED]/:kind",
      "http.request.header.referer": [
        "https://api.example.test/api/v1/payments/hooks/[REDACTED]/b2c-result",
        "other",
      ],
      "http.response.status_code": 200,
    });
    expect(redacted.events[0]!.attributes).toEqual({
      "exception.message": "failed /api/v1/payments/hooks/[REDACTED]/b2c-result",
    });
    expect(redacted.events[1]).toEqual({ name: "plain", time: [0, 0] });
    // Everything else is the original span's (methods bound to it).
    expect(redacted.spanContext().spanId).toBe("2".repeat(16));
  });

  it("exports other spans unchanged", () => {
    const other = span({
      name: "GET /api/v1/projects",
      attributes: { "url.path": "/api/v1/projects", "http.response.status_code": 200 },
      events: [],
    });
    expect(redactSpan(other)).toBe(other);
  });

  it("redacts every span before the wrapped exporter sees it and delegates the rest", async () => {
    const seen: Exported[] = [];
    const calls: string[] = [];
    const inner = {
      export(spans: Exported, done: (result: { code: number }) => void) {
        seen.push(spans);
        done({ code: 0 });
      },
      shutdown: async () => void calls.push("shutdown"),
      forceFlush: async () => void calls.push("flush"),
    };
    const exporter = new RedactingSpanExporter(
      inner as unknown as ConstructorParameters<typeof RedactingSpanExporter>[0],
    );
    const results: number[] = [];
    exporter.export([span(), span()], (result) => results.push(result.code));
    await exporter.forceFlush();
    await exporter.shutdown();
    expect(results).toEqual([0]);
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen[0]!.map((item) => [item.name, item.attributes]))).not.toContain(
      TOKEN,
    );
    expect(calls).toEqual(["flush", "shutdown"]);
  });
});
