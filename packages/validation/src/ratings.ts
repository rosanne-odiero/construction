import {
  RATING_COMMENT_MAX_LENGTH,
  RATING_HISTORY_LIMITS,
  RATING_SCORE_LIMITS,
  WORKED_ATTENDANCE_STATUSES,
  type RatingCriterion,
} from "@pm-buddy/types";
import { z } from "zod";

/**
 * Worker ratings (D3.5): a supervisor scores a worker's day on a project from 1 to 5 for
 * punctuality, quality, safety and teamwork, with an optional comment the worker can read.
 * Requests and responses are strict.
 */

const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
/** A business calendar date (YYYY-MM-DD, Africa/Nairobi). */
const calendarDate = z.iso.date();
const version = z.number().int().min(1).max(2_147_483_647);
const mean = z.number().min(RATING_SCORE_LIMITS.min).max(RATING_SCORE_LIMITS.max);

const score = z.number().int().min(RATING_SCORE_LIMITS.min).max(RATING_SCORE_LIMITS.max);
const scoreShape = {
  punctuality: score,
  quality: score,
  safety: score,
  teamwork: score,
} satisfies Record<RatingCriterion, typeof score>;
export const ratingScoresSchema = z.object(scoreShape).strict();

/** Trimmed; empty or absent means no comment. */
const commentInput = z
  .string()
  .trim()
  .max(RATING_COMMENT_MAX_LENGTH)
  .nullish()
  .transform((value) => value || null);

export const createRatingRequestSchema = z
  .object({
    labourerId: uuid,
    workDate: calendarDate,
    scores: ratingScoresSchema,
    comment: commentInput,
  })
  .strict();

/** Replaces the scores and comment; send the version you read. */
export const updateRatingRequestSchema = z
  .object({ version, scores: ratingScoresSchema, comment: commentInput })
  .strict();

export const ratingSummarySchema = z
  .object({
    count: z.number().int().min(0),
    average: mean.nullable(),
    criteria: z
      .object({
        punctuality: mean.nullable(),
        quality: mean.nullable(),
        safety: mean.nullable(),
        teamwork: mean.nullable(),
      } satisfies Record<RatingCriterion, z.ZodType>)
      .strict(),
  })
  .strict();

const ratingProject = z.object({ id: uuid, code: z.string(), name: z.string() }).strict();

export const labourerRatingSchema = z
  .object({
    id: uuid,
    project: ratingProject,
    labourerId: uuid,
    workDate: calendarDate,
    scores: ratingScoresSchema,
    average: mean,
    comment: z.string().nullable(),
    ratedBy: z.object({ id: uuid, displayName: z.string().min(1).max(100) }).strict(),
    ratedAt: timestamp,
    /** When the rater last corrected it (same day only); null when never changed. */
    changedAt: timestamp.nullable(),
    version,
    /** Whether the caller may still change it: they gave it, today. */
    canChange: z.boolean(),
  })
  .strict();
export type LabourerRating = z.infer<typeof labourerRatingSchema>;

export const ratingResponseSchema = z.object({ rating: labourerRatingSchema }).strict();

const ratingWindowSchema = z.object({ from: calendarDate, to: calendarDate }).strict();

/** Projects where the caller may rate workers, with the days that can be rated today. */
export const ratingProjectsResponseSchema = z
  .object({
    today: calendarDate,
    window: ratingWindowSchema,
    projects: z.array(
      ratingProject
        .extend({
          readOnly: z.boolean(),
          /** Workers attendance records as present or half day on the project today. */
          workingToday: z.number().int().min(0),
        })
        .strict(),
    ),
  })
  .strict();

export const ratingSheetQuerySchema = z.object({ date: calendarDate.optional() }).strict();

/** One project day: everyone recorded as having worked (present or half day) and their rating. */
export const ratingSheetResponseSchema = z
  .object({
    project: ratingProject.extend({ readOnly: z.boolean() }).strict(),
    date: calendarDate,
    today: calendarDate,
    window: ratingWindowSchema,
    /** The day is in the window and the project is open, so unrated workers can be rated. */
    canRate: z.boolean(),
    workers: z.array(
      z
        .object({
          labourer: z
            .object({
              id: uuid,
              workerNo: z.string(),
              fullName: z.string(),
              trade: z.object({ id: uuid, nameEn: z.string(), nameSw: z.string() }).strict(),
            })
            .strict(),
          attendance: z.enum(WORKED_ATTENDANCE_STATUSES),
          sites: z.array(z.string()),
          rating: labourerRatingSchema.nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type RatingSheetResponse = z.infer<typeof ratingSheetResponseSchema>;

export const labourerRatingsQuerySchema = z
  .object({
    projectId: uuid.optional(),
    from: calendarDate.optional(),
    to: calendarDate.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(RATING_HISTORY_LIMITS.max)
      .default(RATING_HISTORY_LIMITS.default),
  })
  .strict()
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    message: "from_after_to",
    path: ["to"],
  });

/** A worker's ratings on projects where the caller can view labour; the summary covers them all. */
export const labourerRatingsResponseSchema = z
  .object({
    labourerId: uuid,
    summary: ratingSummarySchema,
    /** Newest first, at most `limit`. */
    ratings: z.array(labourerRatingSchema),
    /** The caller can rate on at least one of the worker's projects. */
    canRate: z.boolean(),
  })
  .strict();
export type LabourerRatingsResponse = z.infer<typeof labourerRatingsResponseSchema>;

/** What a worker sees of their own ratings: no rater identities. */
export const workerRatingSchema = z
  .object({
    id: uuid,
    project: ratingProject,
    workDate: calendarDate,
    scores: ratingScoresSchema,
    average: mean,
    comment: z.string().nullable(),
  })
  .strict();

export const workerRatingsResponseSchema = z
  .object({
    /** False when the account's phone number matches no single registered worker. */
    linked: z.boolean(),
    summary: ratingSummarySchema,
    /** Newest first, at most the default history page. */
    ratings: z.array(workerRatingSchema),
  })
  .strict();
export type WorkerRatingsResponse = z.infer<typeof workerRatingsResponseSchema>;
