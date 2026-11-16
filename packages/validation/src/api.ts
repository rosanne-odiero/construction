import { z } from "zod";

/** Cursor pagination used by every list endpoint (OpenAPI outline: Cursor, Limit). */
export const paginationQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const pageInfoSchema = z.object({
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

export const problemDetailsSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  detail: z.string().optional(),
  instance: z.string().optional(),
  code: z.string().optional(),
  traceId: z.string().optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  match: z.record(z.string(), z.string()).optional(),
  /** Safe figures explaining a refusal (D4.3; keys from PROBLEM_FACT_KEYS). */
  facts: z
    .record(
      z.string(),
      z.union([z.number(), z.string(), z.boolean(), z.null(), z.array(z.string())]),
    )
    .optional(),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
