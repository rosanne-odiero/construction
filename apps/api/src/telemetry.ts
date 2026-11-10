/**
 * OpenTelemetry bootstrap (ARCHITECTURE §19). Loaded before the app with
 * `node --import ./dist/telemetry.js dist/main.js` so ESM modules can be instrumented.
 * Does nothing unless OTEL_EXPORTER_OTLP_ENDPOINT is set.
 */
import { register } from "node:module";

if (process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]) {
  register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);

  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
  const { HttpInstrumentation } = await import("@opentelemetry/instrumentation-http");
  const { NestInstrumentation } = await import("@opentelemetry/instrumentation-nestjs-core");

  const sdk = new NodeSDK({
    serviceName: process.env["OTEL_SERVICE_NAME"] ?? "pm-buddy-api",
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [new HttpInstrumentation(), new NestInstrumentation()],
  });
  sdk.start();

  const shutdown = () => void sdk.shutdown();
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
