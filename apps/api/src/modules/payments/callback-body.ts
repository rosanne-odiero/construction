import { problemType } from "@pm-buddy/types";
import type { NextFunction, Request, Response } from "express";

export const CALLBACK_PATH_PREFIX = "/api/v1/payments/hooks/";

export type CallbackRequest = Request & { rawCallbackBody?: Buffer };

const problem = (res: Response, status: number, code: string, title: string) =>
  res
    .status(status)
    .type("application/problem+json")
    .json({ type: problemType(code), title, status, code });

/**
 * Reads provider callbacks as raw bytes before Nest's JSON parser (registered first in
 * configureApp): the exact body is what gets sealed into the inbox and hashed for deduplication.
 * Only `application/json` up to PAYMENTS_CALLBACK_MAX_BYTES; anything else is refused before any
 * persistence (non-success, so the provider can retry a genuine delivery).
 */
export function callbackBodyReader(maxBytes: number) {
  return (req: CallbackRequest, res: Response, next: NextFunction) => {
    if (req.method !== "POST" || !req.path.startsWith(CALLBACK_PATH_PREFIX)) return next();
    const type = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "application/json")
      return problem(res, 415, "unsupported-media-type", "Callbacks must be application/json");
    const declared = Number(req.headers["content-length"] ?? "0");
    if (Number.isFinite(declared) && declared > maxBytes)
      return problem(res, 413, "payload-too-large", "Callback body too large");
    const chunks: Buffer[] = [];
    let size = 0;
    let finished = false;
    req.on("data", (chunk: Buffer) => {
      if (finished) return;
      size += chunk.length;
      if (size > maxBytes) {
        finished = true;
        problem(res, 413, "payload-too-large", "Callback body too large");
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (finished) return;
      finished = true;
      req.rawCallbackBody = Buffer.concat(chunks);
      next();
    });
    req.on("error", () => {
      if (finished) return;
      finished = true;
      problem(res, 400, "bad-request", "Callback body could not be read");
    });
  };
}
