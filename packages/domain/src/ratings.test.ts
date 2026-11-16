import { describe, expect, it } from "vitest";
import {
  canChangeRating,
  isInRatingWindow,
  isRatingScore,
  ratingAverage,
  ratingTotals,
  ratingWindow,
  summarizeRatings,
} from "./ratings.js";

const scores = (punctuality: number, quality: number, safety: number, teamwork: number) => ({
  punctuality,
  quality,
  safety,
  teamwork,
});

describe("rating window", () => {
  it("covers today and the six days before, across month ends", () => {
    expect(ratingWindow("2026-12-03")).toEqual({ from: "2026-11-27", to: "2026-12-03" });
    expect(isInRatingWindow("2026-11-27", "2026-12-03")).toBe(true);
    expect(isInRatingWindow("2026-11-26", "2026-12-03")).toBe(false);
    expect(isInRatingWindow("2026-12-04", "2026-12-03")).toBe(false);
  });
});

describe("changing a rating", () => {
  const rating = { ratedBy: "rater", ratedAt: new Date("2026-12-03T20:59:00Z") }; // 23:59 Nairobi

  it("is allowed to the rater until midnight in Nairobi", () => {
    expect(canChangeRating(rating, "rater", new Date("2026-12-03T20:59:59Z"))).toBe(true);
    expect(canChangeRating(rating, "rater", new Date("2026-12-03T21:00:00Z"))).toBe(false);
  });

  it("is never allowed to anyone else", () => {
    expect(canChangeRating(rating, "someone-else", new Date("2026-12-03T20:59:30Z"))).toBe(false);
  });
});

describe("scores and summaries", () => {
  it("accepts whole scores from 1 to 5 only", () => {
    expect([1, 5].every(isRatingScore)).toBe(true);
    expect([0, 6, 2.5, Number.NaN].some(isRatingScore)).toBe(false);
  });

  it("rounds means half up to one decimal place", () => {
    expect(ratingAverage(scores(5, 4, 4, 4))).toBe(4.3); // 4.25
    expect(ratingAverage(scores(1, 1, 1, 2))).toBe(1.3); // 1.25
    expect(ratingAverage(scores(3, 3, 3, 3))).toBe(3);
  });

  it("summarises per criterion and overall, with nulls when there is nothing", () => {
    const totals = ratingTotals([scores(5, 4, 3, 2), scores(4, 4, 4, 4), scores(3, 5, 4, 5)]);
    expect(totals).toEqual({
      count: 3,
      sums: { punctuality: 12, quality: 13, safety: 11, teamwork: 11 },
    });
    expect(summarizeRatings(totals)).toEqual({
      count: 3,
      average: 3.9, // 47 / 12 = 3.916…
      criteria: { punctuality: 4, quality: 4.3, safety: 3.7, teamwork: 3.7 },
    });
    expect(summarizeRatings(ratingTotals([]))).toEqual({
      count: 0,
      average: null,
      criteria: { punctuality: null, quality: null, safety: null, teamwork: null },
    });
  });
});
