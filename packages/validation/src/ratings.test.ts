import { describe, expect, it } from "vitest";
import {
  createRatingRequestSchema,
  labourerRatingsQuerySchema,
  updateRatingRequestSchema,
} from "./ratings.js";

const scores = { punctuality: 5, quality: 4, safety: 3, teamwork: 1 };
const create = {
  labourerId: "0190a9e8-0000-7000-8000-000000000001",
  workDate: "2026-12-03",
  scores,
};

describe("rating requests", () => {
  it("treat a blank or missing comment as none and trim the rest", () => {
    expect(createRatingRequestSchema.parse(create).comment).toBeNull();
    expect(createRatingRequestSchema.parse({ ...create, comment: "   " }).comment).toBeNull();
    expect(createRatingRequestSchema.parse({ ...create, comment: " Kazi nzuri " }).comment).toBe(
      "Kazi nzuri",
    );
    expect(
      createRatingRequestSchema.safeParse({ ...create, comment: "x".repeat(501) }).success,
    ).toBe(false);
  });

  it("need every criterion as a whole score from 1 to 5, and nothing else", () => {
    for (const bad of [
      { ...scores, teamwork: 0 },
      { ...scores, safety: 6 },
      { ...scores, quality: 4.5 },
      { punctuality: 5, quality: 4, safety: 3 },
      { ...scores, attitude: 3 },
    ])
      expect(createRatingRequestSchema.safeParse({ ...create, scores: bad }).success).toBe(false);
    expect(
      createRatingRequestSchema.safeParse({ ...create, tenantId: create.labourerId }).success,
    ).toBe(false);
    expect(updateRatingRequestSchema.safeParse({ scores }).success).toBe(false);
  });

  it("refuse a history range that ends before it starts", () => {
    expect(labourerRatingsQuerySchema.parse({}).limit).toBe(20);
    expect(
      labourerRatingsQuerySchema.safeParse({ from: "2026-12-03", to: "2026-12-02" }).success,
    ).toBe(false);
  });
});
