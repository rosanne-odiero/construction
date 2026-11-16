/**
 * Worker ratings for the mock API (D3.5): rateable projects, a project day's sheet built from the
 * attendance mock's records, rating and same-day correction, and a worker's history. "Today" is
 * the attendance mock's MOCK_TODAY (10/11/2026). Synthetic data only; mock-api.mts checks every
 * response against the shared schema.
 */
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import {
  isInRatingWindow,
  nairobiDate,
  ratingAverage,
  ratingTotals,
  ratingWindow,
  summarizeRatings,
  type RatingScores,
} from "@pm-buddy/domain";
import { WORKED_ATTENDANCE_STATUSES, type Permission } from "@pm-buddy/types";
import {
  createRatingRequestSchema,
  labourerRatingsQuerySchema,
  labourerRatingsResponseSchema,
  ratingProjectsResponseSchema,
  ratingResponseSchema,
  ratingSheetQuerySchema,
  ratingSheetResponseSchema,
  updateRatingRequestSchema,
  type LabourerRating,
} from "@pm-buddy/validation";
import { MOCK_TODAY, type AttendanceState } from "./mock-attendance.mts";
import type { LabourState } from "./mock-labour.mts";

type Reply = { status?: number; body: unknown; schema: z.ZodType<unknown> };
type Person = { id: string; displayName: string };

type MockRating = {
  id: string;
  projectId: string;
  labourerId: string;
  workDate: string;
  scores: RatingScores;
  comment: string | null;
  ratedBy: Person;
  ratedAt: string;
  changedAt: string | null;
  version: number;
};
export type RatingsState = { ratings: MockRating[] };

export type RatingsContext = {
  user: Person;
  permissions: readonly Permission[];
  projects: { id: string; code: string; name: string; status: string }[];
  sites: ReadonlyMap<string, string>;
  labour: LabourState;
  attendance: AttendanceState;
  fail: (status: number, code: string) => never;
  parse: <T>(schema: z.ZodType<T>, body: unknown) => T;
};

const RUIRU = "30000000-0000-4000-8000-000000000001";
const AMINA = "42000000-0000-4000-8000-000000000001";
const JOSEPH = "42000000-0000-4000-8000-000000000002";
const BRIAN = { id: "21000000-0000-4000-8000-000000000002", displayName: "Brian Otieno" };
const KEVIN = { id: "21000000-0000-4000-8000-000000000003", displayName: "Kevin Kiprono" };

/** Amina was rated on 04/11 and 06/11; Joseph already has today's rating from the project manager. */
export function ratingsFixture(): RatingsState {
  const rating = (
    labourerId: string,
    workDate: string,
    scores: RatingScores,
    ratedBy: Person,
    comment: string | null = null,
  ): MockRating => ({
    id: randomUUID(),
    projectId: RUIRU,
    labourerId,
    workDate,
    scores,
    comment,
    ratedBy,
    ratedAt: `${workDate}T14:30:00.000Z`,
    changedAt: null,
    version: 1,
  });
  return {
    ratings: [
      rating(AMINA, "2026-11-04", { punctuality: 3, quality: 4, safety: 5, teamwork: 4 }, KEVIN),
      rating(
        AMINA,
        "2026-11-06",
        { punctuality: 4, quality: 5, safety: 4, teamwork: 4 },
        BRIAN,
        "Kazi nzuri kwenye ukuta.",
      ),
      rating(JOSEPH, MOCK_TODAY, { punctuality: 5, quality: 4, safety: 4, teamwork: 5 }, BRIAN),
    ],
  };
}

const READ_ONLY = new Set(["closed", "cancelled"]);
const worked = (status: string) =>
  (WORKED_ATTENDANCE_STATUSES as readonly string[]).includes(status);

export function handleRatings(
  ctx: RatingsContext,
  state: RatingsState,
  method: string,
  path: string,
  query: URLSearchParams,
  body: unknown,
): Reply | null {
  const can = (permission: Permission) => ctx.permissions.includes(permission);
  const project = (projectId: string) => {
    const found = ctx.projects.find((entry) => entry.id === projectId);
    if (!found) return ctx.fail(404, "not-found");
    if (!can("labour.rate")) return ctx.fail(403, "forbidden");
    return { ...found, readOnly: READ_ONLY.has(found.status) };
  };
  const wire = ({ projectId, ...rating }: MockRating): LabourerRating => {
    const entry = ctx.projects.find((row) => row.id === projectId)!;
    return {
      ...rating,
      project: { id: entry.id, code: entry.code, name: entry.name },
      average: ratingAverage(rating.scores),
      canChange:
        rating.ratedBy.id === ctx.user.id && nairobiDate(new Date(rating.ratedAt)) === MOCK_TODAY,
    };
  };

  if (method === "GET" && path === "/labour/ratings/projects") {
    if (!can("labour.rate")) return ctx.fail(403, "forbidden");
    return {
      body: {
        today: MOCK_TODAY,
        window: ratingWindow(MOCK_TODAY),
        projects: ctx.projects
          .filter((entry) => !READ_ONLY.has(entry.status))
          .map(({ id, code, name }) => ({
            id,
            code,
            name,
            readOnly: false,
            workingToday: new Set(
              ctx.attendance.records
                .filter(
                  (record) =>
                    record.projectId === id && record.date === MOCK_TODAY && worked(record.status),
                )
                .map((record) => record.labourerId),
            ).size,
          })),
      },
      schema: ratingProjectsResponseSchema,
    };
  }

  const sheet = path.match(/^\/labour\/projects\/([^/]+)\/ratings$/);
  if (sheet && method === "GET") {
    const target = project(sheet[1]!);
    const { date = MOCK_TODAY } = ctx.parse(ratingSheetQuerySchema, Object.fromEntries(query));
    if (date > MOCK_TODAY) return ctx.fail(400, "date-in-future");
    const days = new Map<string, { attendance: "present" | "half_day"; sites: string[] }>();
    for (const record of ctx.attendance.records) {
      if (record.projectId !== target.id || record.date !== date || !worked(record.status))
        continue;
      const day = days.get(record.labourerId) ?? { attendance: "half_day", sites: [] };
      if (record.status === "present") day.attendance = "present";
      day.sites = [...new Set([...day.sites, ctx.sites.get(record.siteId) ?? "—"])].sort();
      days.set(record.labourerId, day);
    }
    const workers = ctx.labour.labourers
      .filter((labourer) => days.has(labourer.id))
      .sort((a, b) => a.fullName.localeCompare(b.fullName))
      .map((labourer) => {
        const trade = ctx.labour.trades.find((entry) => entry.id === labourer.tradeId)!;
        const rating = state.ratings.find(
          (entry) =>
            entry.projectId === target.id &&
            entry.labourerId === labourer.id &&
            entry.workDate === date,
        );
        return {
          labourer: {
            id: labourer.id,
            workerNo: labourer.workerNo,
            fullName: labourer.fullName,
            trade: { id: trade.id, nameEn: trade.nameEn, nameSw: trade.nameSw },
          },
          ...days.get(labourer.id)!,
          rating: rating ? wire(rating) : null,
        };
      });
    return {
      body: {
        project: { id: target.id, code: target.code, name: target.name, readOnly: target.readOnly },
        date,
        today: MOCK_TODAY,
        window: ratingWindow(MOCK_TODAY),
        canRate: !target.readOnly && isInRatingWindow(date, MOCK_TODAY),
        workers,
      },
      schema: ratingSheetResponseSchema,
    };
  }

  if (sheet && method === "POST") {
    const target = project(sheet[1]!);
    const input = ctx.parse(createRatingRequestSchema, body);
    if (target.readOnly) return ctx.fail(409, "project-read-only");
    if (input.workDate > MOCK_TODAY) return ctx.fail(400, "date-in-future");
    if (!isInRatingWindow(input.workDate, MOCK_TODAY)) return ctx.fail(409, "rating-window");
    const attended = ctx.attendance.records.some(
      (record) =>
        record.projectId === target.id &&
        record.labourerId === input.labourerId &&
        record.date === input.workDate &&
        worked(record.status),
    );
    if (!attended) return ctx.fail(409, "not-worked");
    if (
      state.ratings.some(
        (entry) =>
          entry.projectId === target.id &&
          entry.labourerId === input.labourerId &&
          entry.workDate === input.workDate,
      )
    )
      return ctx.fail(409, "already-rated");
    const rating: MockRating = {
      id: randomUUID(),
      projectId: target.id,
      labourerId: input.labourerId,
      workDate: input.workDate,
      scores: input.scores,
      comment: input.comment,
      ratedBy: ctx.user,
      ratedAt: `${MOCK_TODAY}T15:05:00.000Z`,
      changedAt: null,
      version: 1,
    };
    state.ratings.push(rating);
    return { status: 201, body: { rating: wire(rating) }, schema: ratingResponseSchema };
  }

  const change = path.match(/^\/labour\/ratings\/([^/]+)$/);
  if (change && method === "PATCH") {
    const rating = state.ratings.find((entry) => entry.id === change[1]);
    if (!rating) return ctx.fail(404, "not-found");
    const target = project(rating.projectId);
    const input = ctx.parse(updateRatingRequestSchema, body);
    if (target.readOnly) return ctx.fail(409, "project-read-only");
    if (!wire(rating).canChange) return ctx.fail(409, "rating-locked");
    if (input.version !== rating.version) return ctx.fail(409, "version-conflict");
    Object.assign(rating, {
      scores: input.scores,
      comment: input.comment,
      changedAt: `${MOCK_TODAY}T15:20:00.000Z`,
      version: rating.version + 1,
    });
    return { body: { rating: wire(rating) }, schema: ratingResponseSchema };
  }

  const history = path.match(/^\/labour\/labourers\/([^/]+)\/ratings$/);
  if (history && method === "GET") {
    if (!can("labour.view")) return ctx.fail(403, "forbidden");
    const labourer = ctx.labour.labourers.find((entry) => entry.id === history[1]);
    if (!labourer) return ctx.fail(404, "not-found");
    const filters = ctx.parse(labourerRatingsQuerySchema, Object.fromEntries(query));
    const matching = state.ratings
      .filter(
        (entry) =>
          entry.labourerId === labourer.id &&
          (!filters.projectId || entry.projectId === filters.projectId) &&
          (!filters.from || entry.workDate >= filters.from) &&
          (!filters.to || entry.workDate <= filters.to),
      )
      .sort((a, b) => b.workDate.localeCompare(a.workDate));
    return {
      body: {
        labourerId: labourer.id,
        summary: summarizeRatings(ratingTotals(matching.map((entry) => entry.scores))),
        ratings: matching.slice(0, filters.limit).map(wire),
        canRate: can("labour.rate"),
      },
      schema: labourerRatingsResponseSchema,
    };
  }
  return null;
}
