import type { INestApplicationContext } from "@nestjs/common";
import { addCalendarDays, nairobiDate } from "@pm-buddy/domain";
import { WORKED_ATTENDANCE_STATUSES, type PpeItem } from "@pm-buddy/types";
import type { Request } from "express";
import { PrismaService } from "../infra/prisma.service.js";
import { TenantDatabase } from "../modules/identity/tenant-database.service.js";
import { fromCalendarDate } from "../modules/projects/project-mappers.js";
import { CorrectiveActionsService } from "../modules/safety/corrective-actions.service.js";
import { FirstAidService } from "../modules/safety/first-aid.service.js";
import { IncidentsService } from "../modules/safety/incidents.service.js";
import { InductionsService } from "../modules/safety/inductions.service.js";
import { PpeService } from "../modules/safety/ppe.service.js";
import { SafetySettingsService } from "../modules/safety/safety-settings.service.js";
import { ToolboxTalksService } from "../modules/safety/toolbox-talks.service.js";
import { seedPrincipal } from "./demo-procure-to-pay.js";

/**
 * D8.2 demo health and safety data on RUI-HTS (synthetic), written through the real services as
 * the runtime role so every trigger applies: inductions on the Main plot for the labourers who
 * worked there in the look-back window except two (so the attendance flags show), the site agent
 * and a visiting engineer; two confirmed toolbox talks (gang A and gang B) and a draft; PPE issued
 * to gang A (gloves due for replacement, one helmet returned); a near miss investigated, its
 * action verified and the incident closed; an injury investigated with two corrective actions (one
 * verified, one overdue) and a linked first-aid treatment; two first-aid kits (one needing a
 * check) and a first-aider. Dates are relative to the seed day (Africa/Nairobi). Idempotent:
 * skipped when RUI-HTS already has an incident.
 */

export type SafetySeedSummary = {
  created: boolean;
  inductions: number;
  flaggedLabourers: number;
  talks: number;
  ppeIssues: number;
  ppeDue: number;
  incidents: { code: string; kind: string; status: string }[];
  actions: { total: number; verified: number; overdue: number };
  kits: number;
  treatments: number;
};

type SeedUsers = { ownerId: string; projectManagerId: string; siteAgentId: string };

const seedRequest = { headers: {} } as Request;

export async function seedSafety(
  app: INestApplicationContext,
  tenantId: string,
  users: SeedUsers,
): Promise<SafetySeedSummary> {
  const prisma = app.get(PrismaService);
  const db = app.get(TenantDatabase);
  const read = <T>(work: (tx: Parameters<Parameters<TenantDatabase["run"]>[1]>[0]) => Promise<T>) =>
    db.run({ userId: users.ownerId, tenantId, requestId: "seed" }, work);
  const today = nairobiDate();
  const day = (offset: number) => addCalendarDays(today, offset);
  const facts = await read(async (tx) => {
    const project = await tx.project.findUniqueOrThrow({
      where: { tenantId_code: { tenantId, code: "RUI-HTS" } },
      include: { sites: true },
    });
    const main = project.sites.find((site) => site.name === "Main plot")!;
    const yard = project.sites.find((site) => site.name === "Materials yard");
    const gangs = await tx.gang.findMany({
      where: { tenantId, projectId: project.id },
      include: {
        members: { where: { leftOn: null }, orderBy: { joinedOn: "asc" } },
      },
      orderBy: { name: "asc" },
    });
    // Labourers who worked at a site in the last 14 days (the default look-back).
    const workedAt = async (siteId: string | undefined) =>
      siteId
        ? (
            await tx.attendanceRecord.findMany({
              where: {
                tenantId,
                projectId: project.id,
                siteId,
                status: { in: [...WORKED_ATTENDANCE_STATUSES] },
                workDate: { gte: fromCalendarDate(day(-13)), lte: fromCalendarDate(today) },
              },
              select: { labourerId: true, labourer: { select: { workerNo: true } } },
              distinct: ["labourerId"],
            })
          )
            .sort((a, b) => a.labourer.workerNo.localeCompare(b.labourer.workerNo))
            .map((row) => row.labourerId)
        : [];
    return {
      projectId: project.id,
      mainSite: main.id,
      yardSite: yard?.id ?? null,
      gangs,
      worked: await workedAt(main.id),
      workedAtYard: await workedAt(yard?.id),
      existing: await tx.safetyIncident.count({ where: { tenantId, projectId: project.id } }),
    };
  });
  if (facts.existing) return summarise(read, facts.projectId, false);

  const [owner, pm, agent] = await Promise.all(
    [users.ownerId, users.projectManagerId, users.siteAgentId].map((id) =>
      seedPrincipal(prisma, id, tenantId),
    ),
  );
  const inductions = app.get(InductionsService);
  const talks = app.get(ToolboxTalksService);
  const ppe = app.get(PpeService);
  const incidents = app.get(IncidentsService);
  const actions = app.get(CorrectiveActionsService);
  const firstAid = app.get(FirstAidService);
  const { projectId, mainSite: siteId } = facts;
  const options = await app.get(SafetySettingsService).options(owner, projectId, seedRequest);
  const topics = options.inductionTopics.map((topic) => topic.key);

  // Inductions: every labourer who worked on the Main plot lately except the last two (they are
  // flagged), everyone at the yard, the site agent and a visiting engineer.
  const induct = async (target: string, labourerIds: string[]) => {
    for (const [index, labourerId] of labourerIds.entries())
      await inductions.create(
        agent,
        projectId,
        {
          siteId: target,
          personKind: "labourer",
          labourerId,
          inductedOn: day(-40 - (index % 10)),
          inductorId: users.siteAgentId,
          topics: index % 4 === 0 ? topics.slice(0, 6) : topics,
          acknowledgement: index % 3 === 0 ? "thumbprint" : "signed",
          visitorOrganisation: null,
          notes: null,
        },
        seedRequest,
      );
  };
  await induct(siteId, facts.worked.slice(0, Math.max(facts.worked.length - 2, 0)));
  if (facts.yardSite) await induct(facts.yardSite, facts.workedAtYard);
  await inductions.create(
    pm,
    projectId,
    {
      siteId,
      personKind: "staff",
      userId: users.siteAgentId,
      inductedOn: day(-60),
      inductorId: users.projectManagerId,
      topics,
      acknowledgement: "signed",
      visitorOrganisation: null,
      notes: null,
    },
    seedRequest,
  );
  await inductions.create(
    agent,
    projectId,
    {
      siteId,
      personKind: "visitor",
      visitorName: "Eng. Synthetic Mutua",
      visitorOrganisation: "Kiambu County works office",
      inductedOn: day(-6),
      inductorId: users.siteAgentId,
      topics: ["site_rules", "emergency_procedures", "ppe", "site_hazards"],
      acknowledgement: "signed",
      notes: "Escorted visit for the county inspection",
    },
    seedRequest,
  );

  // Toolbox talks: gang A and gang B confirmed, one draft for this morning.
  const gang = (letter: string) =>
    facts.gangs.find((entry) => entry.name.startsWith(`Gang ${letter}:`));
  const talk = async (
    letter: string,
    heldOn: string,
    topic: string,
    confirm: boolean,
    durationMinutes: number,
  ) => {
    const chosen = gang(letter);
    if (!chosen) return null;
    return talks.create(
      agent,
      projectId,
      {
        siteId,
        heldOn,
        topic,
        notes: null,
        durationMinutes,
        presenterId: users.siteAgentId,
        photoId: null,
        otherAttendees: 0,
        gangIds: [chosen.id],
        labourerIds: [],
        confirm,
      },
      seedRequest,
    );
  };
  await talk(
    "A",
    day(-7),
    "Working at height: scaffold boards, toe boards and harness checks",
    true,
    20,
  );
  await talk("B", day(-3), "Manual handling of blocks and cement bags", true, 15);
  await talk("C", today, "Rebar caps and cutting discs", false, 10);

  // PPE for gang A: helmets, boots and gloves (gloves past their replacement date).
  let ppeIssues = 0;
  const issue = async (
    labourerId: string,
    item: PpeItem,
    issuedOn: string,
    size: string | null,
  ) => {
    ppeIssues += 1;
    return ppe.issue(
      agent,
      projectId,
      { siteId, labourerId, item, size, quantity: item === "gloves" ? 2 : 1, issuedOn },
      seedRequest,
    );
  };
  const crew = (gang("A")?.members ?? []).map((member) => member.labourerId).slice(0, 5);
  for (const [index, labourerId] of crew.entries()) {
    await issue(labourerId, "helmet", day(-50), null);
    await issue(labourerId, "safety_boots", day(-50), String(40 + index));
    await issue(labourerId, "gloves", day(-35 + index), "L");
  }
  if (crew[0]) await issue(crew[0], "harness", day(-20), "M");
  if (crew[1]) {
    const reflective = await issue(crew[1], "reflective_vest", day(-30), "XL");
    await ppe.returnIssue(
      agent,
      projectId,
      reflective.issue.id,
      { version: reflective.issue.version, returnedOn: day(-2), condition: "damaged" },
      seedRequest,
    );
  }

  // A near miss: investigated, its action done and verified, then closed (locked).
  const at = (offset: number, time: string) => `${day(offset)}T${time}:00+03:00`;
  let nearMiss = await incidents.report(
    agent,
    projectId,
    {
      siteId,
      kind: "near_miss",
      severity: "serious",
      occurredAt: at(-12, "10:40"),
      location: "First-floor slab edge, grid C/4",
      description:
        "Three concrete blocks stacked at the slab edge fell to the ground floor walkway. Nobody was below.",
      immediateActions: "Walkway closed; remaining blocks moved back from the edge",
      firstAidGiven: false,
      people: [],
      photoIds: [],
    },
    seedRequest,
  );
  nearMiss = await incidents.investigate(
    pm,
    projectId,
    nearMiss.incident.id,
    {
      version: nearMiss.incident.version,
      rootCauseCategory: "procedure_not_followed",
      rootCause: "Blocks were stacked within a metre of an unprotected slab edge to save carrying.",
      contributingFactors: "No edge barrier on that bay yet",
    },
    seedRequest,
  );
  const edge = await actions.create(
    pm,
    projectId,
    {
      source: "incident",
      incidentId: nearMiss.incident.id,
      description: "Fix an edge barrier and mark a no-stacking zone 2 m from every open slab edge",
      ownerId: users.siteAgentId,
      dueOn: day(-8),
    },
    seedRequest,
  );
  const edgeDone = await actions.action(
    agent,
    projectId,
    edge.action.id,
    { version: edge.action.version, action: "done", note: "Barrier fixed and zone painted" },
    seedRequest,
  );
  await actions.action(
    pm,
    projectId,
    edge.action.id,
    { version: edgeDone.action.version, action: "verify" },
    seedRequest,
  );
  nearMiss = await incidents.get(pm, projectId, nearMiss.incident.id, seedRequest);
  await incidents.close(
    pm,
    projectId,
    nearMiss.incident.id,
    {
      version: nearMiss.incident.version,
      closureNote: "Edge barriers checked at the weekly inspection",
      noActionReason: null,
    },
    seedRequest,
  );

  // An injury: investigated, two actions (one verified, one overdue) and a first-aid treatment.
  const injuredId = facts.worked[0] ?? crew[0];
  const witnessId = facts.worked[1] ?? crew[1];
  let injury = await incidents.report(
    agent,
    projectId,
    {
      siteId,
      kind: "injury",
      severity: "moderate",
      occurredAt: at(-9, "14:15"),
      location: "Scaffold, gable wall, second lift",
      description:
        "A mason slipped on a wet scaffold board and twisted an ankle while carrying mortar.",
      immediateActions: "Work on the lift stopped; boards dried and sanded",
      firstAidGiven: true,
      people: [
        ...(injuredId
          ? [
              {
                role: "injured" as const,
                labourerId: injuredId,
                injuryType: "sprain" as const,
                bodyPart: "foot" as const,
              },
            ]
          : []),
        ...(witnessId ? [{ role: "witness" as const, labourerId: witnessId }] : []),
      ],
      photoIds: [],
    },
    seedRequest,
  );
  injury = await incidents.investigate(
    pm,
    projectId,
    injury.incident.id,
    {
      version: injury.incident.version,
      rootCauseCategory: "unsafe_condition",
      rootCause: "Boards were wet after overnight rain and had no anti-slip treatment.",
      contributingFactors: "Morning scaffold check not recorded",
    },
    seedRequest,
  );
  const boards = await actions.create(
    pm,
    projectId,
    {
      source: "incident",
      incidentId: injury.incident.id,
      description: "Replace smooth scaffold boards on the gable lift with anti-slip boards",
      ownerId: users.siteAgentId,
      dueOn: day(-4),
    },
    seedRequest,
  );
  const boardsDone = await actions.action(
    agent,
    projectId,
    boards.action.id,
    { version: boards.action.version, action: "done", note: "Six boards replaced" },
    seedRequest,
  );
  await actions.action(
    pm,
    projectId,
    boards.action.id,
    { version: boardsDone.action.version, action: "verify" },
    seedRequest,
  );
  await actions.create(
    pm,
    projectId,
    {
      source: "incident",
      incidentId: injury.incident.id,
      description: "Record the morning scaffold inspection on the scaffold tag every working day",
      ownerId: users.siteAgentId,
      dueOn: day(-2),
    },
    seedRequest,
  );

  // First aid: two kits (the yard kit never checked), a first-aider and the treatment.
  const officeKit = await firstAid.createKit(
    pm,
    projectId,
    { siteId, label: "Site office kit", location: "Container office, by the door" },
    seedRequest,
  );
  await firstAid.checkKit(
    agent,
    projectId,
    officeKit.kit.id,
    { checkedOn: day(-10), outcome: "restocked", expiresOn: day(200), notes: null },
    seedRequest,
  );
  const scaffoldKit = await firstAid.createKit(
    pm,
    projectId,
    { siteId, label: "Scaffold kit", location: "Hoist base" },
    seedRequest,
  );
  await firstAid.checkKit(
    agent,
    projectId,
    scaffoldKit.kit.id,
    { checkedOn: day(-45), outcome: "incomplete", expiresOn: day(20), notes: "Eye wash used up" },
    seedRequest,
  );
  const aider = await firstAid.addFirstAider(
    pm,
    projectId,
    {
      siteId,
      userId: users.siteAgentId,
      certificateExpiresOn: day(300),
      certificateReference: "SYN-FA-2041",
    },
    seedRequest,
  );
  if (injuredId)
    await firstAid.recordTreatment(
      agent,
      projectId,
      {
        siteId,
        treatedAt: at(-9, "14:25"),
        labourerId: injuredId,
        injuryType: "sprain",
        treatment: "cold_compress",
        referral: "clinic",
        firstAiderId: aider.firstAider.id,
        incidentId: injury.incident.id,
      },
      seedRequest,
    );
  return summarise(read, projectId, true);
}

async function summarise(
  read: <T>(
    work: (tx: Parameters<Parameters<TenantDatabase["run"]>[1]>[0]) => Promise<T>,
  ) => Promise<T>,
  projectId: string,
  created: boolean,
): Promise<SafetySeedSummary> {
  return read(async (tx) => {
    const today = fromCalendarDate(nairobiDate());
    const incidents = await tx.safetyIncident.findMany({
      where: { projectId },
      orderBy: { number: "asc" },
      select: { number: true, kind: true, status: true },
    });
    const flagged = await tx.$queryRaw<{ count: bigint }[]>`
      SELECT count(DISTINCT a.labourer_id) AS count FROM attendance_records a
       WHERE a.project_id = ${projectId}::uuid AND a.status IN ('present', 'half_day')
         AND a.work_date >= (app.business_today() - 13)
         AND NOT EXISTS (SELECT 1 FROM safety_inductions i
           WHERE i.project_id = a.project_id AND i.site_id = a.site_id
             AND i.labourer_id = a.labourer_id AND i.status = 'recorded'
             AND i.inducted_on <= a.work_date)`;
    return {
      created,
      inductions: await tx.safetyInduction.count({ where: { projectId } }),
      flaggedLabourers: Number(flagged[0]?.count ?? 0),
      talks: await tx.toolboxTalk.count({ where: { projectId } }),
      ppeIssues: await tx.ppeIssue.count({ where: { projectId } }),
      ppeDue: await tx.ppeIssue.count({
        where: { projectId, status: "issued", replacementDueOn: { lte: today } },
      }),
      incidents: incidents.map((row) => ({
        code: `INC-${String(row.number).padStart(4, "0")}`,
        kind: row.kind,
        status: row.status,
      })),
      actions: {
        total: await tx.correctiveAction.count({ where: { projectId } }),
        verified: await tx.correctiveAction.count({ where: { projectId, status: "verified" } }),
        overdue: await tx.correctiveAction.count({
          where: { projectId, status: "open", dueOn: { lt: today } },
        }),
      },
      kits: await tx.firstAidKit.count({ where: { projectId } }),
      treatments: await tx.firstAidTreatment.count({ where: { projectId } }),
    };
  });
}
