import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Params } from "nestjs-pino";
import type { SerializedRequest, SerializedResponse } from "pino";
import type { AppConfig } from "../config/app-config.js";

/**
 * Never log secrets or personal data (brief §7, ARCHITECTURE §19). Paths are matched by pino's
 * fast-redact; the wildcard covers request and response bodies when they are logged.
 */
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-step-up-token"]',
  'req.headers["x-device-proof"]',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  "*.password",
  "*.token",
  "*.refreshToken",
  "*.secret",
  "*.otp",
  "*.code",
  "*.recoveryCodes",
  "*.uri",
  "*.identifier",
  "*.phone",
  "*.idNumber",
  "*.kraPin",
];

const SAFE_REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

/** Reuses a well-formed inbound X-Request-Id (from a proxy) or creates one, and echoes it back. */
export function requestId(req: IncomingMessage, res: ServerResponse): string {
  const inbound = req.headers["x-request-id"];
  const id = typeof inbound === "string" && SAFE_REQUEST_ID.test(inbound) ? inbound : randomUUID();
  res.setHeader("X-Request-Id", id);
  return id;
}

/** Request logs keep what is needed to trace a call; headers and query strings can hold personal data. */
export function serializeRequest(req: SerializedRequest) {
  const queryStart = req.url.indexOf("?");
  return {
    id: req.id,
    method: req.method,
    url: queryStart === -1 ? req.url : req.url.slice(0, queryStart),
    remoteAddress: req.remoteAddress,
  };
}

export function serializeResponse(res: SerializedResponse) {
  return { statusCode: res.statusCode };
}

export function loggerOptions(config: AppConfig): Params {
  const pretty = config.get("NODE_ENV") === "development";
  return {
    pinoHttp: {
      level: config.get("LOG_LEVEL"),
      redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
      serializers: { req: serializeRequest, res: serializeResponse },
      genReqId: requestId,
      customProps: () => ({ service: config.get("OTEL_SERVICE_NAME") }),
      autoLogging: { ignore: (req) => req.url?.startsWith("/api/v1/health") ?? false },
      ...(pretty
        ? {
            transport: {
              target: "pino-pretty",
              options: { singleLine: true, translateTime: "SYS:HH:MM:ss" },
            },
          }
        : {}),
    },
  };
}
