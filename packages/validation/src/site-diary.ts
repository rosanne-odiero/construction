import { DIARY_ACTIONS, DIARY_STATUSES } from "@pm-buddy/domain";
import { z } from "zod";

const version = z.number().int().min(1).max(2_147_483_647);
const optionalNote = (max: number) => z.string().trim().max(max).nullable();
const content = {
  workPerformed: z.string().trim().min(1).max(6000),
  weather: optionalNote(250),
  delays: optionalNote(2000),
  workforceCount: z.number().int().min(0).max(100_000).nullable(),
};

export const createDiaryRequestSchema = z
  .object({ siteId: z.uuid(), date: z.iso.date(), ...content })
  .strict();
export const updateDiaryRequestSchema = z.object({ version, ...content }).strict();
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
    workforceSource: z.literal("manual"),
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
