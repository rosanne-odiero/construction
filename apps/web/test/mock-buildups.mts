/**
 * The company rate build-up library in the Playwright mock API (`/rate-buildups`). Rates come from
 * the real packages/domain buildupRate; editing appends a version.
 */
import { randomUUID } from "node:crypto";
import { buildupRate } from "@pm-buddy/domain";
import type { Permission } from "@pm-buddy/types";
import {
  buildupResponseSchema,
  buildupsResponseSchema,
  buildupVersionResponseSchema,
  createBuildupRequestSchema,
  updateBuildupRequestSchema,
  type BuildupVersion,
} from "@pm-buddy/validation";
import type { BqState, MockBuildup, MockBuildupVersion, Person, Reply } from "./mock-bq-model.mts";

export type BuildupDeps = {
  fail: (status: number, code: string) => Error;
  parse<T>(schema: import("zod").ZodType<T>, body: unknown): T;
  /** Permissions held company-wide or on at least one assigned project. */
  somewhere(): Permission[];
  actor: Person;
};

const NOW = "2026-11-10T07:45:00.000Z";
const OWNER = { id: "21000000-0000-4000-8000-000000000001", displayName: "Wanjiru Kamau" };

/** The seeded synthetic example (mirrors apps/api/src/seed DEMO_BUILDUP). */
export function initialBuildups(): MockBuildup[] {
  return [
    {
      id: "50000000-0000-4000-8000-000000000001",
      code: "CONC-C25-SYN",
      updatedAt: NOW,
      version: 1,
      versions: [
        {
          id: "51000000-0000-4000-8000-000000000001",
          versionNo: 1,
          name: "Concrete class 25 (1:2:4), per m³ (synthetic example)",
          unit: "m3",
          assumptions:
            "SYNTHETIC EXAMPLE VALUES, not market prices. Cement in 50 kg bags; sand and ballast in tonnes.",
          lines: [
            {
              kind: "material",
              resourceName: "Cement, 50 kg bag",
              unit: "bag (50 kg)",
              quantity: "6.5",
              wastePercent: "5",
              unitCostMinor: 85_000,
            },
            {
              kind: "material",
              resourceName: "River sand",
              unit: "t",
              quantity: "0.7",
              wastePercent: "10",
              unitCostMinor: 250_000,
            },
            {
              kind: "material",
              resourceName: "Ballast 20 mm",
              unit: "t",
              quantity: "1.4",
              wastePercent: "5",
              unitCostMinor: 220_000,
            },
            {
              kind: "labour",
              resourceName: "Mason and two helpers",
              unit: "hr",
              quantity: "4.5",
              wastePercent: null,
              unitCostMinor: 35_000,
            },
            {
              kind: "plant",
              resourceName: "Concrete mixer (0.5 m³)",
              unit: "hr",
              quantity: "0.5",
              wastePercent: null,
              unitCostMinor: 150_000,
            },
          ],
          createdAt: NOW,
          createdBy: OWNER,
        },
      ],
    },
  ];
}

function versionWire(version: MockBuildupVersion): BuildupVersion {
  const rate = buildupRate(version.lines);
  return {
    id: version.id,
    versionNo: version.versionNo,
    name: version.name,
    unit: version.unit,
    assumptions: version.assumptions,
    rateMinor: rate.rateMinor,
    pricedMinor: rate.pricedMinor,
    unpricedLines: rate.unpricedLines,
    byKind: rate.byKind,
    lines: version.lines.map((line, index) => ({
      lineNo: index + 1,
      ...line,
      amountMinor: rate.lineAmountsMinor[index] ?? null,
    })),
    createdAt: version.createdAt,
    createdBy: version.createdBy,
  };
}

function summary(state: BqState, buildup: MockBuildup) {
  const current = buildup.versions.at(-1)!;
  const rate = buildupRate(current.lines);
  const links = [...state.projects.values()].reduce(
    (sum, entry) =>
      sum + [...entry.links.values()].filter((link) => link.buildupId === buildup.id).length,
    0,
  );
  return {
    id: buildup.id,
    code: buildup.code,
    name: current.name,
    unit: current.unit,
    currentVersionId: current.id,
    currentVersionNo: current.versionNo,
    rateMinor: rate.rateMinor,
    unpricedLines: rate.unpricedLines,
    lineCount: current.lines.length,
    linkCount: links,
    updatedAt: buildup.updatedAt,
    version: buildup.version,
  };
}

export function handleBuildups(
  deps: BuildupDeps,
  state: BqState,
  method: string,
  path: string,
  body: unknown,
): Reply | null {
  const match = /^\/rate-buildups(?:\/([^/]+)(?:\/versions\/(\d+))?)?$/.exec(path);
  if (!match) return null;
  if (!deps.somewhere().includes("bq.view")) throw deps.fail(403, "forbidden");
  const canEdit = deps.somewhere().includes("bq.edit");
  const detail = (buildup: MockBuildup) => ({
    body: {
      buildup: summary(state, buildup),
      current: versionWire(buildup.versions.at(-1)!),
      versions: [...buildup.versions].reverse().map((version) => {
        const wire = versionWire(version);
        return {
          id: wire.id,
          versionNo: wire.versionNo,
          name: wire.name,
          rateMinor: wire.rateMinor,
          createdAt: wire.createdAt,
          createdBy: wire.createdBy,
        };
      }),
      permissions: { canEdit },
    },
    schema: buildupResponseSchema,
  });
  const [, buildupId, versionNo] = match;
  if (!buildupId) {
    if (method === "GET")
      return {
        body: {
          buildups: [...state.buildups]
            .sort((left, right) => left.code.localeCompare(right.code))
            .map((buildup) => summary(state, buildup)),
          permissions: { canEdit },
        },
        schema: buildupsResponseSchema,
      };
    if (method !== "POST") throw deps.fail(404, "not-found");
    if (!canEdit) throw deps.fail(403, "forbidden");
    const input = deps.parse(createBuildupRequestSchema, body);
    if (state.buildups.some((buildup) => buildup.code === input.code))
      throw deps.fail(409, "buildup-code-taken");
    const at = new Date().toISOString();
    const buildup: MockBuildup = {
      id: randomUUID(),
      code: input.code,
      updatedAt: at,
      version: 1,
      versions: [
        {
          id: randomUUID(),
          versionNo: 1,
          name: input.name,
          unit: input.unit,
          assumptions: input.assumptions ?? null,
          lines: input.lines,
          createdAt: at,
          createdBy: deps.actor,
        },
      ],
    };
    state.buildups.push(buildup);
    return { ...detail(buildup), status: 201 };
  }
  const buildup = state.buildups.find((candidate) => candidate.id === buildupId);
  if (!buildup) throw deps.fail(404, "not-found");
  if (versionNo) {
    const version = buildup.versions.find((candidate) => candidate.versionNo === Number(versionNo));
    if (!version || method !== "GET") throw deps.fail(404, "not-found");
    return { body: { version: versionWire(version) }, schema: buildupVersionResponseSchema };
  }
  if (method === "GET") return detail(buildup);
  if (method !== "PUT") throw deps.fail(404, "not-found");
  if (!canEdit) throw deps.fail(403, "forbidden");
  const input = deps.parse(updateBuildupRequestSchema, body);
  if (buildup.version !== input.version) throw deps.fail(409, "version-conflict");
  const at = new Date().toISOString();
  buildup.versions.push({
    id: randomUUID(),
    versionNo: buildup.versions.length + 1,
    name: input.name,
    unit: input.unit,
    assumptions: input.assumptions ?? null,
    lines: input.lines,
    createdAt: at,
    createdBy: deps.actor,
  });
  buildup.version += 1;
  buildup.updatedAt = at;
  return detail(buildup);
}
