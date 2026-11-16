import type { NodeSDKConfiguration } from "@opentelemetry/sdk-node";
import { redactCallbackPath } from "./common/callback-path.js";

type SpanExporter = NodeSDKConfiguration["traceExporter"];
type ReadableSpan = Parameters<SpanExporter["export"]>[0][number];
type Attributes = ReadableSpan["attributes"];

const redactValue = (value: unknown): unknown => {
  if (typeof value === "string") return redactCallbackPath(value);
  if (!Array.isArray(value)) return value;
  const items = value.map((item: unknown) =>
    typeof item === "string" ? redactCallbackPath(item) : item,
  );
  return items.some((item, index) => item !== value[index]) ? items : value;
};

function redactAttributes(attributes: Attributes): Attributes {
  let changed = false;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    result[key] = redactValue(value);
    if (result[key] !== value) changed = true;
  }
  return changed ? (result as Attributes) : attributes;
}

/**
 * The span as exported, without payment callback tokens. The HTTP instrumentation records the
 * request path (`url.path`, `http.target`) and the Nest one the full URL (`url.full`), and span
 * names can carry the path too; request logs already drop the token (common/logging.ts).
 */
export function redactSpan(span: ReadableSpan): ReadableSpan {
  const name = redactCallbackPath(span.name);
  const attributes = redactAttributes(span.attributes);
  const events = span.events.map((event) => {
    if (!event.attributes) return event;
    const redacted = redactAttributes(event.attributes);
    return redacted === event.attributes ? event : { ...event, attributes: redacted };
  });
  if (
    name === span.name &&
    attributes === span.attributes &&
    events.every((event, index) => event === span.events[index])
  )
    return span;
  return new Proxy(span, {
    get(target, property) {
      if (property === "name") return name;
      if (property === "attributes") return attributes;
      if (property === "events") return events;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

/** Wraps the trace exporter so every exported span is redacted first (ARCHITECTURE §19). */
export class RedactingSpanExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter) {}

  export(spans: ReadableSpan[], resultCallback: Parameters<SpanExporter["export"]>[1]): void {
    this.inner.export(spans.map(redactSpan), resultCallback);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}
