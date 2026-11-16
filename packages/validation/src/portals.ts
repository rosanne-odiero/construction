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
    attendance: z
      .object({
        from: z.iso.date(),
        to: z.iso.date(),
        daysWorked: z.number().nonnegative(),
        records: z.array(
          z
            .object({
              id: uuid,
              date: z.iso.date(),
              project: z.string(),
              site: z.string(),
              status: z.enum(["present", "half_day", "absent", "leave", "sick"]),
              confirmed: z.boolean(),
            })
            .strict(),
        ),
      })
      .strict()
      .nullable(),
    pay: z
      .object({
        lines: z.array(
          z
            .object({
              id: uuid,
              project: z.string(),
              from: z.iso.date(),
              to: z.iso.date(),
              grossMinor: z.string().regex(/^-?\d+$/),
              deductionsMinor: z.string().regex(/^-?\d+$/),
              netMinor: z.string().regex(/^-?\d+$/),
              daysWorked: z.number().int().nonnegative(),
            })
            .strict(),
        ),
        advancesOutstandingMinor: z.string().regex(/^\d+$/),
        /** There is no settled payroll payment source until D4.3. Never infer payment from net pay. */
        payments: z.null(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type WorkerPortalResponse = z.infer<typeof workerPortalResponseSchema>;

export const workerNotificationPreferencesSchema = z
  .object({
    sms: z.boolean(),
    whatsapp: z.boolean(),
    locale: z.enum(["en", "sw"]),
  })
  .strict();
export const workerNotificationRequestSchema = z
  .object({
    channel: z.enum(["sms", "whatsapp"]),
  })
  .strict();

export const workerNotificationHistorySchema = z
  .object({
    items: z
      .array(
        z
          .object({
            id: uuid,
            topic: z.enum([
              "worker.reminder",
              "attendance.day_confirmed",
              "payroll.batch_submitted",
              "payroll.batch_cancelled",
              "advance.disbursed",
            ]),
            channel: z.enum(["sms", "whatsapp"]),
            status: z.enum(["pending", "sending", "accepted", "unconfirmed", "skipped"]),
            reason: z
              .enum(["opted-out", "access-lost", "expired", "budget", "provider", "interrupted"])
              .nullable(),
            createdAt: z.iso.datetime(),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();
