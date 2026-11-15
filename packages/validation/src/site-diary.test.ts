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
      // An attendance count comes from the server's snapshot, never from the client.
      { workforceSource: "attendance", workforceCount: 3 },
      { workforceSource: "biometric" },
    ])
      expect(createDiaryRequestSchema.safeParse({ ...entry, ...changes }).success).toBe(false);
    expect(updateDiaryRequestSchema.safeParse({ version: 1, ...entry }).success).toBe(false);
    expect(
      createDiaryRequestSchema.parse({ ...entry, workforceSource: "attendance" }),
    ).toMatchObject({ workforceSource: "attendance", workforceCount: null });
    expect(createDiaryRequestSchema.parse(entry).workforceSource).toBe("manual");
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
      workforce: null,
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

  it("binds an attendance snapshot to its count and keeps manual counts without one", () => {
    const timestamp = "2026-11-11T08:00:00Z";
    const draft = {
      ...entry,
      id: entry.siteId,
      projectId: entry.siteId,
      workforceSource: "attendance",
      workforceCount: 3,
      workforce: {
        snapshotAt: timestamp,
        musterStatus: "submitted",
        trades: [
          {
            tradeId: entry.siteId,
            key: "mason",
            nameEn: "Mason",
            nameSw: "Fundi mwashi",
            headcount: 3,
            halfDays: 1,
          },
        ],
      },
      status: "draft",
      version: 1,
      createdBy: entry.siteId,
      submittedBy: null,
      submittedAt: null,
      reviewedBy: null,
      reviewedAt: null,
      reviewReason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    expect(diarySchema.safeParse(draft).success).toBe(true);
    for (const invalid of [
      { ...draft, workforceCount: 4 },
      { ...draft, workforce: null },
      { ...draft, workforceSource: "manual" },
    ])
      expect(diarySchema.safeParse(invalid).success).toBe(false);
  });
});
