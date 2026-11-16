/** Worker ratings in the web app (D3.5). */

/** Score labels in order (`labourLive.ratings.scale`): index 0 is a score of 1. */
export const RATING_SCALE = ["poor", "fair", "good", "veryGood", "excellent"] as const;
export type RatingScaleKey = (typeof RATING_SCALE)[number];

export const scaleKey = (score: number): RatingScaleKey =>
  RATING_SCALE[Math.min(Math.max(Math.round(score), 1), RATING_SCALE.length) - 1]!;

/** The ratings page of a project day; the page picks a project and today when they are absent. */
export function ratingsHref(params: { project?: string | null; date?: string | null }): string {
  const query = new URLSearchParams();
  if (params.project) query.set("project", params.project);
  if (params.date) query.set("date", params.date);
  const search = query.toString();
  return `/labour/ratings${search ? `?${search}` : ""}`;
}

/** Without a chosen project the sheet opens on the first where anyone is working today. */
export function defaultRatingProject<T extends { workingToday: number }>(
  projects: readonly T[],
): T | undefined {
  return projects.find((project) => project.workingToday > 0) ?? projects[0];
}

const averages = {
  en: new Intl.NumberFormat("en-KE", { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
  sw: new Intl.NumberFormat("sw-KE", { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
};

/** A mean score with one decimal place ("4.3"). */
export const formatAverage = (value: number, locale: string): string =>
  (locale === "sw" ? averages.sw : averages.en).format(value);
