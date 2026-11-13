import { randomUUID } from "node:crypto";
import {
  createDiaryRequestSchema,
  diariesResponseSchema,
  diaryActionRequestSchema,
  diaryListQuerySchema,
  diaryResponseSchema,
  updateDiaryRequestSchema,
  type SiteDiary,
} from "@pm-buddy/validation";
import { diaryTransition, nairobiDate } from "@pm-buddy/domain";

/** Synthetic web fixtures only; real authorization and locking are tested in the API suite. */
export function initialDiaries(
  projectId: string,
  siteId: string,
  owner: string,
  agent: string,
): SiteDiary[] {
  const base: SiteDiary = {
    id: randomUUID(),
    projectId,
    siteId,
    date: "2026-10-25",
    workPerformed: "Synthetic draft: slab curing",
    weather: "Dry",
    delays: null,
    workforceCount: null,
    workforceSource: "manual",
    status: "draft",
    version: 1,
    createdBy: owner,
    submittedBy: null,
    submittedAt: null,
    reviewedBy: null,
    reviewedAt: null,
    reviewReason: null,
    createdAt: "2026-10-25T10:00:00Z",
    updatedAt: "2026-10-25T10:00:00Z",
  };
  return [
    base,
    {
      ...base,
      id: randomUUID(),
      date: "2026-10-26",
      workPerformed: "Synthetic submitted: walling",
      status: "submitted",
      version: 2,
      createdBy: agent,
      submittedBy: agent,
      submittedAt: "2026-10-26T10:00:00Z",
      workforceCount: 12,
    },
  ];
}

export function handleDiaries(
  rows: SiteDiary[],
  userId: string,
  projectId: string,
  siteIds: string[],
  method: string,
  rest: string,
  query: URLSearchParams,
  body: unknown,
  fail: (status: number, code: string) => Error,
) {
  if (rest === "diaries" && method === "GET") {
    const parsed = diaryListQuerySchema.parse(Object.fromEntries(query));
    const matching = rows.filter(
      (row) => row.projectId === projectId && (!parsed.siteId || row.siteId === parsed.siteId),
    );
    return { body: { diaries: matching, nextCursor: null }, schema: diariesResponseSchema };
  }
  if (rest === "diaries" && method === "POST") {
    const input = createDiaryRequestSchema.parse(body);
    if (!siteIds.includes(input.siteId)) throw fail(404, "not-found");
    if (input.date > nairobiDate()) throw fail(409, "diary-future-date");
    if (rows.some((row) => row.siteId === input.siteId && row.date === input.date))
      throw fail(409, "diary-date-taken");
    const timestamp = new Date().toISOString();
    const diary: SiteDiary = {
      ...input,
      id: randomUUID(),
      projectId,
      workforceSource: "manual",
      status: "draft",
      version: 1,
      createdBy: userId,
      submittedBy: null,
      submittedAt: null,
      reviewedBy: null,
      reviewedAt: null,
      reviewReason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    rows.unshift(diary);
    return { status: 201, body: { diary }, schema: diaryResponseSchema };
  }
  const match = /^diaries\/([^/]+)(\/actions)?$/.exec(rest);
  const diary = rows.find((row) => row.id === match?.[1] && row.projectId === projectId);
  if (!diary) throw fail(404, "not-found");
  if (method === "PATCH" && !match?.[2]) {
    const input = updateDiaryRequestSchema.parse(body);
    if (input.version !== diary.version) throw fail(409, "version-conflict");
    if (userId !== diary.createdBy) throw fail(403, "diary-author-required");
    if (diary.status !== "draft") throw fail(409, "diary-not-draft");
    Object.assign(diary, input);
  } else if (method === "POST" && match?.[2]) {
    const input = diaryActionRequestSchema.parse(body);
    if (input.version !== diary.version) throw fail(409, "version-conflict");
    const status = diaryTransition(diary.status, input.action);
    if (!status) throw fail(409, "diary-invalid-transition");
    if (input.action === "submit") {
      if (userId !== diary.createdBy) throw fail(403, "diary-author-required");
      diary.submittedBy = userId;
      diary.submittedAt = new Date().toISOString();
    } else if (input.action === "reopen") {
      if (userId !== diary.createdBy) throw fail(403, "diary-author-required");
      Object.assign(diary, {
        submittedBy: null,
        submittedAt: null,
        reviewedBy: null,
        reviewedAt: null,
        reviewReason: null,
      });
    } else {
      if (userId === diary.createdBy || userId === diary.submittedBy)
        throw fail(403, "diary-independent-review");
      Object.assign(diary, {
        reviewedBy: userId,
        reviewedAt: new Date().toISOString(),
        reviewReason: input.reason ?? null,
      });
    }
    diary.status = status;
  } else throw fail(404, "not-found");
  diary.version += 1;
  diary.updatedAt = new Date().toISOString();
  return { body: { diary }, schema: diaryResponseSchema };
}
