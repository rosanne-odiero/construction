import { COUNTY_KEYS, PROJECT_STATUSES } from "@pm-buddy/types";
import { z } from "zod";

/**
 * Labourer portal responses (the client portal's are in client-portal.ts). Curated on purpose: a
 * labourer sees only where they are assigned, never contract sums, teams or diaries.
 */
const uuid = z.uuid();

const portalProjectBase = {
  id: uuid,
  code: z.string().min(2).max(20),
  name: z.string().min(1).max(150),
  status: z.enum(PROJECT_STATUSES),
  county: z.enum(COUNTY_KEYS).nullable(),
  town: z.string().max(100).nullable(),
};

export const workerPortalResponseSchema = z
  .object({
    displayName: z.string().min(1).max(100),
    company: z.object({ id: uuid, name: z.string().min(1) }).strict(),
    assignments: z.array(
      z
        .object({
          project: z.object(portalProjectBase).strict(),
          sites: z.array(
            z
              .object({
                id: uuid,
                name: z.string().min(1).max(120),
                address: z.string().max(250).nullable(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    /** Not available until the attendance (Phase 3) and payroll (Phase 4) modules exist. */
    attendance: z.null(),
    pay: z.null(),
  })
  .strict();

export type WorkerPortalResponse = z.infer<typeof workerPortalResponseSchema>;
