import { STATUS_CODES } from "node:http";
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from "@nestjs/common";
import { problemType, type ProblemDetails } from "@pm-buddy/types";
import type { Request, Response } from "express";
import { ZodError } from "zod";

const CODES: Record<number, string> = {
  400: "bad-request",
  401: "unauthorized",
  403: "forbidden",
  404: "not-found",
  405: "method-not-allowed",
  409: "conflict",
  413: "payload-too-large",
  415: "unsupported-media-type",
  422: "unprocessable-entity",
  429: "rate-limited",
  503: "service-unavailable",
};

function messageOf(response: string | object): string | undefined {
  if (typeof response === "string") return response;
  const message = (response as { message?: unknown }).message;
  if (typeof message === "string") return message;
  if (Array.isArray(message)) return message.filter((m) => typeof m === "string").join("; ");
  return undefined;
}

/** A more specific stable code set by the thrower, e.g. `{ code: "password-too-weak" }`. */
function customCode(response: string | object): string | undefined {
  if (typeof response !== "object") return undefined;
  const code = (response as { code?: unknown }).code;
  return typeof code === "string" && /^[a-z][a-z0-9-]{1,62}$/.test(code) ? code : undefined;
}

/** Maps any thrown value to an RFC 9457 problem. Unknown errors never leak internals. */
export function toProblem(exception: unknown, instance: string, traceId?: string): ProblemDetails {
  if (exception instanceof ZodError) {
    return {
      type: problemType("validation-error"),
      title: "Validation failed",
      status: 400,
      code: "validation-error",
      instance,
      traceId,
      errors: exception.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    };
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const response = exception.getResponse();
    const code =
      customCode(response) ?? CODES[status] ?? (status >= 500 ? "internal-error" : "error");
    return {
      type: problemType(code),
      title: STATUS_CODES[status] ?? "Error",
      status,
      code,
      detail: status >= 500 ? undefined : messageOf(response),
      instance,
      traceId,
    };
  }

  return {
    type: problemType("internal-error"),
    title: "Internal Server Error",
    status: 500,
    code: "internal-error",
    detail: "An unexpected error occurred. Quote the trace ID when contacting support.",
    instance,
    traceId,
  };
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request & { id?: string }>();
    const res = http.getResponse<Response>();
    const problem = toProblem(exception, req.originalUrl ?? req.url, req.id);

    if (problem.status >= 500)
      this.logger.error(exception, `Unhandled error (traceId ${problem.traceId ?? "n/a"})`);

    res.status(problem.status).type("application/problem+json").json(problem);
  }
}
