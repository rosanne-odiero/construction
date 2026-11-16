/**
 * Worker ratings (D3.5): a supervisor's scores for one worker's day on one project. The database
 * CHECKs and guard trigger (migration 20261216090000_worker_ratings) use the same values, so a
 * change here needs a migration too.
 */

/** Each criterion is scored from 1 (poor) to 5 (excellent). */
export const RATING_CRITERIA = ["punctuality", "quality", "safety", "teamwork"] as const;
export type RatingCriterion = (typeof RATING_CRITERIA)[number];

export const RATING_SCORE_LIMITS = { min: 1, max: 5 } as const;

/**
 * A worked day can be rated on that day or during the six days after it, so every rating is
 * recent. A worker gets at most one rating per project per day, from whoever rates first.
 */
export const RATING_WINDOW_DAYS = 7;

/** Optional comment, trimmed; the worker sees it in their portal. */
export const RATING_COMMENT_MAX_LENGTH = 500;

/** Ratings returned in one history page (newest first); the summary covers the whole range. */
export const RATING_HISTORY_LIMITS = { default: 20, max: 100 } as const;
