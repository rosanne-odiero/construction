import {
  RATING_CRITERIA,
  RATING_SCORE_LIMITS,
  RATING_WINDOW_DAYS,
  type RatingCriterion,
} from "@pm-buddy/types";
import { addCalendarDays } from "./labour.js";
import { nairobiDate } from "./project-lifecycle.js";

/**
 * Worker ratings (D3.5, WORKFLOWS "Worker ratings"): pure rules shared by the API, the web app and
 * the tests. The database guard (app.guard_labourer_rating) enforces the same window and change
 * rule.
 */

export type RatingScores = Readonly<Record<RatingCriterion, number>>;

/** Integer totals of a set of ratings (what SQL SUM/COUNT return). */
export interface RatingTotals {
  count: number;
  sums: Readonly<Record<RatingCriterion, number>>;
}

export interface RatingSummary {
  count: number;
  /** Mean of every score, to one decimal place; null without ratings. */
  average: number | null;
  /** Mean per criterion, to one decimal place; null without ratings. */
  criteria: Record<RatingCriterion, number | null>;
}

export const isRatingScore = (value: number): boolean =>
  Number.isInteger(value) && value >= RATING_SCORE_LIMITS.min && value <= RATING_SCORE_LIMITS.max;

/** The work days that may be rated on `today` (Africa/Nairobi): today and the six days before. */
export function ratingWindow(today: string): { from: string; to: string } {
  return { from: addCalendarDays(today, -(RATING_WINDOW_DAYS - 1)), to: today };
}

export function isInRatingWindow(workDate: string, today: string): boolean {
  const { from, to } = ratingWindow(today);
  return workDate >= from && workDate <= to;
}

/**
 * Only the person who gave a rating may change it, and only on the Nairobi calendar day they gave
 * it: a slip can be corrected, but nobody revises a rating after the worker may have seen it.
 */
export function canChangeRating(
  rating: { ratedBy: string; ratedAt: Date },
  userId: string,
  now: Date = new Date(),
): boolean {
  return rating.ratedBy === userId && nairobiDate(rating.ratedAt) === nairobiDate(now);
}

/** `sum / count` rounded half up to one decimal place, in exact integer arithmetic. */
function tenths(sum: number, count: number): number {
  return Math.floor((sum * 20 + count) / (2 * count)) / 10;
}

/** A rating's mean score, to one decimal place. */
export function ratingAverage(scores: RatingScores): number {
  return tenths(
    RATING_CRITERIA.reduce((total, criterion) => total + scores[criterion], 0),
    RATING_CRITERIA.length,
  );
}

/** Integer totals of ratings, for summaries computed outside the database. */
export function ratingTotals(ratings: readonly RatingScores[]): RatingTotals {
  const sums = Object.fromEntries(RATING_CRITERIA.map((criterion) => [criterion, 0])) as Record<
    RatingCriterion,
    number
  >;
  for (const rating of ratings)
    for (const criterion of RATING_CRITERIA) sums[criterion] += rating[criterion];
  return { count: ratings.length, sums };
}

/** Means per criterion and overall, each rounded half up to one decimal place. */
export function summarizeRatings({ count, sums }: RatingTotals): RatingSummary {
  const criteria = Object.fromEntries(
    RATING_CRITERIA.map((criterion) => [criterion, count ? tenths(sums[criterion], count) : null]),
  ) as Record<RatingCriterion, number | null>;
  const all = RATING_CRITERIA.reduce((total, criterion) => total + sums[criterion], 0);
  return {
    count,
    average: count ? tenths(all, count * RATING_CRITERIA.length) : null,
    criteria,
  };
}
