import { createHash } from "node:crypto";
import type { INestApplicationContext } from "@nestjs/common";
import { addCalendarDays, nairobiDate } from "@pm-buddy/domain";
import { WORKED_ATTENDANCE_STATUSES } from "@pm-buddy/types";
import { TenantDatabase } from "../modules/identity/tenant-database.service.js";
import { fromCalendarDate } from "../modules/projects/project-mappers.js";

/**
 * Worker ratings part of the development seed (D3.5): on each of the five days before today,
 * about half of the workers that attendance records as working are rated, by the first of `raters`
 * holding labour.rate on the project, with deterministic scores (mostly 3–5) and a few short
 * synthetic comments. Today stays unrated for the demo. Must run after the attendance seed, on the
 * day it runs (the database only accepts the last seven days). Idempotent: nothing is added if the
 * company already has a rating.
 */

const SOURCE = { source: "seed" } as const;
const DAYS = 5;
const COMMENTS = [
  "Kazi nzuri kwenye fomu za slabu.",
  "Alifika mapema na kusaidia wenzake.",
  "Good, careful work on the block walls.",
  "Remember the helmet on the scaffold.",
  "Alichelewa kidogo asubuhi.",
] as const;

export type RatingsSeedSummary = { created: boolean; ratings: number };

/** A deterministic number 0–99 for the given parts (no randomness in the seed). */
function roll(...parts: string[]): number {
  return createHash("sha256").update(parts.join("|")).digest().readUInt16BE(0) % 100;
}

function score(labourerId: string, date: string, criterion: string): number {
  const value = roll(labourerId, date, criterion);
  if (value < 8) return 2;
  return 3 + (value % 3);
}

export async function seedRatings(
  app: INestApplicationContext,
  tenantId: string,
  raters: readonly string[],
): Promise<RatingsSeedSummary> {
  const db = app.get(TenantDatabase);
  const as = (userId: string) => ({ userId, tenantId, requestId: "seed" });
  const [first] = raters;
  if (!first) return { created: false, ratings: 0 };
  const existing = await db.run(as(first), (tx) =>
    tx.labourerRating.count({ where: { tenantId } }),
  );
  if (existing) return { created: false, ratings: existing };

  const today = nairobiDate();
  const days = Array.from({ length: DAYS }, (_, index) => addCalendarDays(today, -(index + 1)));
  const covered = new Set<string>();
  let ratings = 0;
  for (const raterId of raters) {
    ratings += await db.run(
      as(raterId),
      async (tx) => {
        const projects = await tx.projectMembership.findMany({
          where: { tenantId, userId: raterId, permissions: { has: "labour.rate" } },
          select: { projectId: true, project: { select: { status: true } } },
        });
        let created = 0;
        for (const { projectId, project } of projects) {
          if (
            covered.has(projectId) ||
            project.status === "closed" ||
            project.status === "cancelled"
          )
            continue;
          covered.add(projectId);
          const records = await tx.attendanceRecord.findMany({
            where: {
              tenantId,
              projectId,
              workDate: { in: days.map(fromCalendarDate) },
              status: { in: [...WORKED_ATTENDANCE_STATUSES] },
            },
            select: { labourerId: true, workDate: true },
            orderBy: [{ workDate: "asc" }, { labourerId: "asc" }],
          });
          const seen = new Set<string>();
          for (const record of records) {
            const date = record.workDate.toISOString().slice(0, 10);
            const key = `${record.labourerId}|${date}`;
            if (seen.has(key) || roll(record.labourerId, date, "rated") >= 50) continue;
            seen.add(key);
            const commentRoll = roll(record.labourerId, date, "comment");
            const row = await tx.labourerRating.create({
              data: {
                tenantId,
                projectId,
                labourerId: record.labourerId,
                workDate: record.workDate,
                punctuality: score(record.labourerId, date, "punctuality"),
                quality: score(record.labourerId, date, "quality"),
                safety: score(record.labourerId, date, "safety"),
                teamwork: score(record.labourerId, date, "teamwork"),
                comment: commentRoll < 15 ? COMMENTS[commentRoll % COMMENTS.length]! : null,
                ratedBy: raterId,
              },
            });
            await tx.auditEvent.create({
              data: {
                tenantId,
                actorId: raterId,
                requestId: "seed",
                action: "labourer.rated",
                resourceId: record.labourerId,
                metadata: {
                  ...SOURCE,
                  ratingId: row.id,
                  projectId,
                  workDate: date,
                  punctuality: row.punctuality,
                  quality: row.quality,
                  safety: row.safety,
                  teamwork: row.teamwork,
                  comment: row.comment !== null,
                },
              },
            });
            created += 1;
          }
        }
        return created;
      },
      120_000,
    );
  }
  return { created: true, ratings };
}
