import { COUNTY_KEYS, MILESTONE_STATUSES, PROJECT_STATUSES } from "@pm-buddy/types";
import { z } from "zod";

/**
 * Client and labourer portal responses. Curated on purpose: a client sees their project's
 * progress (milestones and approved site diaries, never drafts or reviewers); a labourer sees
 * only where they are assigned, never contract sums, teams or diaries.
 */
const uuid = z.uuid();
const calendarDate = z.iso.date();

const portalProjectBase = {
  id: uuid,
  code: z.string().min(2).max(20),
  name: z.string().min(1).max(150),
  status: z.enum(PROJECT_STATUSES),
  county: z.enum(COUNTY_KEYS).nullable(),
  town: z.string().max(100).nullable(),
};

export const clientProjectSchema = z
  .object({
    ...portalProjectBase,
    startDate: calendarDate.nullable(),
    endDate: calendarDate.nullable(),
    contractSumMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    currency: z.literal("KES"),
    milestones: z
      .object({ total: z.number().int().min(0), achieved: z.number().int().min(0) })
      .strict(),
  })
  .strict();

export const clientProjectsResponseSchema = z
  .object({
    company: z.object({ id: uuid, name: z.string().min(1) }).strict(),
    projects: z.array(clientProjectSchema),
  })
  .strict();

export const clientMilestoneSchema = z
  .object({
    id: uuid,
    name: z.string().min(1).max(150),
    dueDate: calendarDate,
    status: z.enum(MILESTONE_STATUSES),
    actualDate: calendarDate.nullable(),
  })
  .strict();

export const clientDiarySchema = z
  .object({
    id: uuid,
    date: calendarDate,
    siteName: z.string().min(1).max(120),
    workPerformed: z.string().min(1).max(6000),
    weather: z.string().max(250).nullable(),
    delays: z.string().max(2000).nullable(),
    workforceCount: z.number().int().min(0).nullable(),
    approvedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const clientProjectResponseSchema = z
  .object({
    project: clientProjectSchema,
    milestones: z.array(clientMilestoneSchema),
    /** Approved (locked) diaries only, newest day first, at most 30. */
    diaries: z.array(clientDiarySchema),
  })
  .strict();

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

export type ClientProject = z.infer<typeof clientProjectSchema>;
export type ClientProjectsResponse = z.infer<typeof clientProjectsResponseSchema>;
export type ClientProjectResponse = z.infer<typeof clientProjectResponseSchema>;
export type WorkerPortalResponse = z.infer<typeof workerPortalResponseSchema>;
