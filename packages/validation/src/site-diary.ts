import { DIARY_ACTIONS, DIARY_STATUSES } from "@pm-buddy/domain";
import { WORKFORCE_MUSTER_STATES, WORKFORCE_SOURCES } from "@pm-buddy/types";
import { z } from "zod";

const version = z.number().int().min(1).max(2_147_483_647);
const optionalNote = (max: number) => z.string().trim().max(max).nullable();
const content = {
  workPerformed: z.string().trim().min(1).max(6000),
  weather: optionalNote(250),
  delays: optionalNote(2000),
  workforceCount: z.number().int().min(0).max(100_000).nullable(),
};
/**
 * `manual`: the count typed in (null when unknown). `attendance`: the server takes a snapshot of
 * attendance on the site and date (by trade, with the muster state and time); the count is never
 * sent by the client, so it must be null.
 */
const workforceSource = z.enum(WORKFORCE_SOURCES);
const requestContent = {
  ...content,
  workforceSource: workforceSource.optional().default("manual"),
};
const attendanceHasNoCount = (
  value: { workforceSource: string; workforceCount: number | null },
  ctx: z.RefinementCtx,
) => {
  if (value.workforceSource === "attendance" && value.workforceCount !== null)
    ctx.addIssue({
      code: "custom",
      path: ["workforceCount"],
      message: "attendance_count_from_server",
    });
};

export const createDiaryRequestSchema = z
  .object({ siteId: z.uuid(), date: z.iso.date(), ...requestContent })
  .strict()
  .superRefine(attendanceHasNoCount);
export const updateDiaryRequestSchema = z
  .object({ version, ...requestContent })
  .strict()
  .superRefine(attendanceHasNoCount);

export const workforceTradeSchema = z
  .object({
    tradeId: z.uuid(),
    key: z.string(),
    nameEn: z.string(),
    nameSw: z.string(),
    headcount: z.number().int().min(1),
    halfDays: z.number().int().min(0),
  })
  .strict();
/** A diary's attendance snapshot: who was on site by trade, the muster state and when. */
export const diaryWorkforceSchema = z
  .object({
    snapshotAt: z.iso.datetime({ offset: true }),
    musterStatus: z.enum(WORKFORCE_MUSTER_STATES),
    trades: z.array(workforceTradeSchema),
  })
  .strict();
/** Live attendance on a site and date, offered before a diary takes its snapshot. */
export const diaryAttendanceQuerySchema = z
  .object({ siteId: z.uuid(), date: z.iso.date() })
  .strict();
export const diaryAttendanceResponseSchema = z
  .object({
    siteId: z.uuid(),
    date: z.iso.date(),
    musterStatus: z.enum(WORKFORCE_MUSTER_STATES),
    total: z.number().int().min(0),
    trades: z.array(workforceTradeSchema),
    countedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export const diaryActionRequestSchema = z
  .object({
    version,
    action: z.enum(DIARY_ACTIONS),
    reason: z.string().trim().min(3).max(500).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.action === "reject" && !value.reason)
      ctx.addIssue({ code: "custom", path: ["reason"], message: "reason_required" });
    if (value.action !== "reject" && value.reason !== undefined)
      ctx.addIssue({ code: "custom", path: ["reason"], message: "reason_not_allowed" });
  });

export const diarySchema = z
  .object({
    id: z.uuid(),
    projectId: z.uuid(),
    siteId: z.uuid(),
    date: z.iso.date(),
    ...content,
    workforceSource,
    workforce: diaryWorkforceSchema.nullable(),
    status: z.enum(DIARY_STATUSES),
    version,
    createdBy: z.uuid(),
    submittedBy: z.uuid().nullable(),
    submittedAt: z.iso.datetime({ offset: true }).nullable(),
    reviewedBy: z.uuid().nullable(),
    reviewedAt: z.iso.datetime({ offset: true }).nullable(),
    reviewReason: z.string().min(3).max(500).nullable(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, ctx) => {
    const submitted = value.submittedBy !== null && value.submittedAt !== null;
    const reviewed = value.reviewedBy !== null && value.reviewedAt !== null;
    const independent =
      value.reviewedBy !== value.createdBy && value.reviewedBy !== value.submittedBy;
    const snapshot = value.workforce;
    if (
      value.workforceSource === "attendance"
        ? !snapshot ||
          value.workforceCount !== snapshot.trades.reduce((sum, trade) => sum + trade.headcount, 0)
        : snapshot !== null
    )
      ctx.addIssue({ code: "custom", path: ["workforce"], message: "inconsistent_workforce" });
    if (
      (value.status === "draft"
        ? value.submittedBy !== null || value.submittedAt !== null
        : !submitted || value.submittedBy !== value.createdBy) ||
      (value.status === "draft" || value.status === "submitted"
        ? value.reviewedBy !== null || value.reviewedAt !== null || value.reviewReason !== null
        : !reviewed ||
          !independent ||
          (value.status === "approved" ? value.reviewReason !== null : value.reviewReason === null))
    )
      ctx.addIssue({ code: "custom", message: "inconsistent_diary_state" });
  });
export const diaryResponseSchema = z.object({ diary: diarySchema }).strict();
export const diariesResponseSchema = z
  .object({ diaries: z.array(diarySchema), nextCursor: z.uuid().nullable() })
  .strict();
export const diaryListQuerySchema = z
  .object({
    siteId: z.uuid().optional(),
    cursor: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();

export type SiteDiary = z.infer<typeof diarySchema>;
export type CreateDiaryRequest = z.infer<typeof createDiaryRequestSchema>;
export type UpdateDiaryRequest = z.infer<typeof updateDiaryRequestSchema>;
export type DiaryActionRequest = z.infer<typeof diaryActionRequestSchema>;
export type DiaryListQuery = z.infer<typeof diaryListQuerySchema>;
export type DiaryWorkforce = z.infer<typeof diaryWorkforceSchema>;
export type WorkforceTradeWire = z.infer<typeof workforceTradeSchema>;
export type DiaryAttendanceResponse = z.infer<typeof diaryAttendanceResponseSchema>;
