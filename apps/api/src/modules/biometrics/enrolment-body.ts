import { problemType } from "@pm-buddy/types";
import type { NextFunction, Request, Response } from "express";

export const ENROLMENT_PATH = "/api/v1/biometrics/enrolments";
/**
 * Up to ten templates of at most 16 KiB each arrive base64-encoded (about 22 KB each), above the
 * 100 KB default JSON limit; this one route reads up to 256 KB. Everything else keeps the default.
 */
export const ENROLMENT_BODY_MAX_BYTES = 262_144;

const problem = (res: Response, status: number, code: string, title: string) =>
  res
    .status(status)
    .type("application/problem+json")
    .json({ type: problemType(code), title, status, code });

/**
 * Parses `POST /api/v1/biometrics/enrolments` JSON bodies with the larger limit before Nest's
 * JSON parser (registered first in configureApp; the parser then skips the parsed body). The body
 * is never logged; validation happens in the controller.
 */
export function enrolmentBodyReader(maxBytes = ENROLMENT_BODY_MAX_BYTES) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "POST" || req.path !== ENROLMENT_PATH) return next();
    const type = String(req.headers["content-type"] ?? "")
      .split(";")[0]!
      .trim()
      .toLowerCase();
    if (type !== "application/json") return next();
    const declared = Number(req.headers["content-length"] ?? "0");
    if (Number.isFinite(declared) && declared > maxBytes)
      return problem(res, 413, "payload-too-large", "An enrolment may be at most 256 KB");
    const chunks: Buffer[] = [];
    let size = 0;
    let refused = false;
    req.on("data", (chunk: Buffer) => {
      if (refused) return;
      size += chunk.length;
      if (size > maxBytes) {
        refused = true;
        problem(res, 413, "payload-too-large", "An enrolment may be at most 256 KB");
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (refused) return;
      const text = Buffer.concat(chunks).toString("utf8");
      for (const chunk of chunks) chunk.fill(0);
      try {
        req.body = text ? (JSON.parse(text) as unknown) : {};
      } catch {
        problem(res, 400, "invalid-json", "The body is not valid JSON");
        return;
      }
      // Tells Nest's JSON parser (body-parser) the body is already read.
      (req as Request & { _body?: boolean })._body = true;
      next();
    });
    req.on("error", next);
  };
}
