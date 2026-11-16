import { Injectable } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { accessIdentity } from "../../common/access-context.js";
import { AuthSecurity } from "../identity/auth-security.service.js";
import { accessEntry } from "./access-entry.js";
import { AccessLogWriter } from "./access-log.writer.js";

/** The client went away before the response was sent (as nginx logs it). */
const CLIENT_CLOSED = 499;

/**
 * Who accessed what and when (D9.3): records every signed-in request made in a company, reads and
 * refusals included, once its response is done — the identity AuthService.principal noted, the
 * outcome and the duration. Requests that never resolve a session (sign-in, health, CSRF) are not
 * recorded. Registered for every route by configureApp.
 */
@Injectable()
export class AccessLog {
  constructor(
    private readonly writer: AccessLogWriter,
    private readonly security: AuthSecurity,
  ) {}

  readonly middleware = (req: Request, res: Response, next: NextFunction): void => {
    const occurredAt = new Date();
    const started = performance.now();
    let recorded = false;
    const done = () => {
      if (recorded) return;
      recorded = true;
      const identity = accessIdentity(req);
      if (!identity) return;
      const entry = accessEntry({
        identity,
        method: req.method,
        status: res.writableFinished ? res.statusCode : CLIENT_CLOSED,
        durationMs: performance.now() - started,
        clientAddress: this.security.clientAddress(req),
        // Assigned by the request logger and echoed to the client as X-Request-Id.
        requestId: (req as { id?: unknown }).id ?? res.getHeader("X-Request-Id"),
        occurredAt,
      });
      if (entry) this.writer.record(entry);
    };
    res.once("finish", done);
    res.once("close", done);
    next();
  };
}
