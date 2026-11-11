import { describe, expect, it } from "vitest";
import {
  createDiaryRequestSchema,
  diaryActionRequestSchema,
  diaryListQuerySchema,
  diarySchema,
  updateDiaryRequestSchema,
} from "./site-diary.js";

const entry = {
  siteId: "31000000-0000-4000-8000-000000000001",
  date: "2026-11-11",
  workPerformed: "  Ground floor slab  ",
  weather: null,
  delays: null,
  workforceCount: null,
};

describe("site diary contracts", () => {
  it("trims content and distinguishes unknown workforce from zero", () => {
    expect(createDiaryRequestSchema.parse(entry).workPerformed).toBe("Ground floor slab");
    for (const workforceCount of [null, 0, 100_000])
      expect(createDiaryRequestSchema.parse({ ...entry, workforceCount }).workforceCount).toBe(
        workforceCount,
      );
  });

  it("rejects invalid dates, quantities, blank work and injected identity", () => {
    for (const changes of [
      { date: "2026-02-30" },
      { workforceCount: -1 },
      { workforceCount: 1.5 },
      { workforceCount: 100_001 },
      { workPerformed: " " },
      { workPerformed: "a".repeat(6001) },
      { tenantId: entry.siteId },
      { status: "approved" },
      { workforceSource: "attendance" },
    ])
      expect(createDiaryRequestSchema.safeParse({ ...entry, ...changes }).success).toBe(false);
    expect(updateDiaryRequestSchema.safeParse({ version: 1, ...entry }).success).toBe(false);
  });

  it("requires a rejection reason and prevents ambiguous transition payloads", () => {
    expect(
      diaryActionRequestSchema.parse({ version: 1, action: "reject", reason: " revise " }),
    ).toEqual({ version: 1, action: "reject", reason: "revise" });
    for (const input of [
      { version: 1, action: "reject" },
      { version: 1, action: "reject", reason: "  " },
      { version: 1, action: "approve", reason: "ignored" },
      { version: 0, action: "submit" },
      { version: 1, action: "approve", reviewedBy: entry.siteId },
    ])
      expect(diaryActionRequestSchema.safeParse(input).success).toBe(false);
  });

  it("bounds and validates pagination", () => {
    expect(diaryListQuerySchema.parse({}).limit).toBe(30);
    expect(diaryListQuerySchema.parse({ limit: "50" }).limit).toBe(50);
    for (const limit of ["0", "101", "all"])
      expect(diaryListQuerySchema.safeParse({ limit }).success).toBe(false);
  });

  it("refuses success-shaped diary records with impossible sign-off metadata", () => {
    const author = "21000000-0000-4000-8000-000000000001";
    const reviewer = "21000000-0000-4000-8000-000000000002";
    const timestamp = "2026-11-11T08:00:00Z";
    const draft = {
      ...entry,
      id: entry.siteId,
      projectId: entry.siteId,
      workforceSource: "manual",
      status: "draft",
      version: 1,
      createdBy: author,
      submittedBy: null,
      submittedAt: null,
      reviewedBy: null,
      reviewedAt: null,
      reviewReason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    expect(diarySchema.safeParse(draft).success).toBe(true);
    const approved = {
      ...draft,
      status: "approved",
      submittedBy: author,
      submittedAt: timestamp,
      reviewedBy: reviewer,
      reviewedAt: timestamp,
    };
    expect(diarySchema.safeParse(approved).success).toBe(true);
    for (const invalid of [
      { ...draft, status: "approved" },
      { ...draft, status: "submitted", submittedBy: author },
      { ...draft, submittedAt: timestamp },
      { ...approved, reviewedBy: author },
      { ...approved, status: "rejected" },
      { ...approved, reviewReason: "Unexpected reason" },
    ])
      expect(diarySchema.safeParse(invalid).success).toBe(false);
  });
});
