import { z } from "zod";

export const dependencyCheckSchema = z.object({
  status: z.enum(["up", "down"]),
  latencyMs: z.number().nonnegative(),
  error: z.string().optional(),
});

const base = {
  service: z.string(),
  version: z.string(),
  commit: z.string().optional(),
  time: z.iso.datetime({ offset: true }),
};

/** `GET /api/v1/health/live`: the process is running. No dependencies are checked. */
export const liveResponseSchema = z.object({
  ...base,
  status: z.literal("ok"),
  uptimeSeconds: z.number().nonnegative(),
});

/** `GET /api/v1/health/ready`: 200 when every dependency is up, 503 otherwise. */
export const readyResponseSchema = z.object({
  ...base,
  status: z.enum(["ok", "degraded"]),
  checks: z.object({
    database: dependencyCheckSchema,
    redis: dependencyCheckSchema,
    storage: dependencyCheckSchema,
  }),
});

export type DependencyCheck = z.infer<typeof dependencyCheckSchema>;
export type LiveResponse = z.infer<typeof liveResponseSchema>;
export type ReadyResponse = z.infer<typeof readyResponseSchema>;
