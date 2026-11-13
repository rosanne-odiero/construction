import { type INestApplication, VersioningType } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import type { NextFunction, Request, Response } from "express";
import helmet from "helmet";
import { Logger } from "nestjs-pino";
import { ProblemDetailsFilter } from "./common/problem-details.filter.js";
import { AppConfig, trustProxySetting } from "./config/app-config.js";
import { callbackBodyReader } from "./modules/payments/callback-body.js";

export const API_PREFIX = "api";
export const DOCS_PATH = "api/docs";

/**
 * Shared by main.ts and the e2e tests so both run the exact same pipeline:
 * /api/v1 routes, problem+json errors, security headers and OpenAPI docs.
 */
export function configureApp(app: INestApplication): void {
  const config = app.get(AppConfig);
  app.useLogger(app.get(Logger));
  app.setGlobalPrefix(API_PREFIX);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.enableShutdownHooks();

  // req.ip comes from X-Forwarded-For only for proxies listed in TRUST_PROXY (see env.ts).
  const trustProxy = trustProxySetting(config.get("TRUST_PROXY"));
  if (trustProxy !== false) {
    (app.getHttpAdapter().getInstance() as { set(name: string, value: unknown): void }).set(
      "trust proxy",
      trustProxy,
    );
  }

  // JSON responses need no CSP sources at all (OWASP REST Security Cheat Sheet). Swagger UI loads
  // only same-origin scripts, so helmet's defaults suit it. Upgrading insecure requests is
  // production-only: over plain http (e.g. a phone on the LAN) it would break the docs page.
  const apiHeaders = helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { "default-src": ["'none'"], "frame-ancestors": ["'none'"] },
    },
    frameguard: { action: "deny" },
  });
  const docsHeaders = helmet({
    contentSecurityPolicy: {
      directives: { "upgrade-insecure-requests": config.isProduction ? [] : null },
    },
  });
  app.use((req: Request, res: Response, next: NextFunction) =>
    req.path.startsWith(`/${DOCS_PATH}`) ? docsHeaders(req, res, next) : apiHeaders(req, res, next),
  );
  // Payment provider callbacks are read raw (and size-limited) before the JSON parser runs (D4.2).
  app.use(callbackBodyReader(config.get("PAYMENTS_CALLBACK_MAX_BYTES")));

  if (config.get("API_DOCS_ENABLED")) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle("PM-Buddy API")
        .setDescription(
          "Live API generated from code. The full design outline is docs/api/openapi-outline.yaml. " +
            "Errors use RFC 9457 problem+json; every response carries X-Request-Id.",
        )
        .setVersion(config.get("APP_VERSION"))
        .addCookieAuth(config.isProduction ? "__Host-pmb_at" : "pmb_at")
        .build(),
    );
    SwaggerModule.setup(DOCS_PATH, app, document, {
      jsonDocumentUrl: `${DOCS_PATH}/openapi.json`,
      customSiteTitle: "PM-Buddy API",
    });
  }
}
