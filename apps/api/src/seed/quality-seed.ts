import type { INestApplicationContext } from "@nestjs/common";
import { addCalendarDays, nairobiDate } from "@pm-buddy/domain";
import type { InspectionItemResult } from "@pm-buddy/types";
import type { InspectionDetailResponse } from "@pm-buddy/validation";
import type { Request } from "express";
import { PrismaService } from "../infra/prisma.service.js";
import { TenantDatabase } from "../modules/identity/tenant-database.service.js";
import { DiariesService } from "../modules/progress/diaries.service.js";
import { toCalendarDate } from "../modules/projects/project-mappers.js";
import { CompletionService } from "../modules/quality/completion.service.js";
import { ConcreteService } from "../modules/quality/concrete.service.js";
import { InspectionsService } from "../modules/quality/inspections.service.js";
import { SnagsService } from "../modules/quality/snags.service.js";
import { TemplatesService } from "../modules/quality/templates.service.js";
import { seedPrincipal } from "./demo-procure-to-pay.js";

/**
 * D6.1 demo quality data (synthetic), written through the real services as the runtime role so
 * every trigger applies: the starter checklist templates (English); on RUI-HTS a signed-off slab
 * inspection, a failed walling inspection (county inspector) with snags raised from its failed
 * items, a roofing inspection awaiting sign-off, four cube sets (one failing at 28 days, one with
 * an overdue 7-day result), three slump tests (one failing), and site diaries whose workforce is
 * an attendance snapshot (one approved, one draft); on JUJ-DPX a pre-handover inspection,
 * construction snags closed before handover, practical completion certified 75 days ago with a
 * six-month defects liability period, and two DLP defects. Dates are relative to the seed day
 * (Africa/Nairobi). Idempotent: skipped when RUI-HTS already has an inspection.
 */

export type QualitySeedSummary = {
  created: boolean;
  templates: number;
  inspections: number;
  snags: number;
  cubeSets: number;
  failedCubeSets: number;
  overdueCubeSets: number;
  slumpTests: number;
  diaries: number;
  practicalCompletion: string | null;
  dlpEndsOn: string | null;
};

type SeedUsers = { ownerId: string; projectManagerId: string; siteAgentId: string };

const seedRequest = { headers: {} } as Request;

export async function seedQuality(
  app: INestApplicationContext,
  tenantId: string,
  users: SeedUsers,
): Promise<QualitySeedSummary> {
  const prisma = app.get(PrismaService);
  const db = app.get(TenantDatabase);
  const read = <T>(work: (tx: Parameters<Parameters<TenantDatabase["run"]>[1]>[0]) => Promise<T>) =>
    db.run({ userId: users.ownerId, tenantId, requestId: "seed" }, work);
  const facts = await read(async (tx) => {
    const project = (code: string) =>
      tx.project.findUniqueOrThrow({
        where: { tenantId_code: { tenantId, code } },
        include: { sites: { orderBy: { name: "asc" } } },
      });
    const ruiru = await project("RUI-HTS");
    const juja = await project("JUJ-DPX");
    return {
      ruiru: ruiru.id,
      ruiruSite: ruiru.sites.find((site) => site.name === "Main plot")!.id,
      juja: juja.id,
      jujaSite: juja.sites[0]!.id,
      existing: await tx.inspection.count({ where: { tenantId, projectId: ruiru.id } }),
    };
  });
  if (facts.existing) return summarise(read, facts, false);

  const [owner, pm, agent] = await Promise.all(
    [users.ownerId, users.projectManagerId, users.siteAgentId].map((id) =>
      seedPrincipal(prisma, id, tenantId),
    ),
  );
  const templates = app.get(TemplatesService);
  const inspections = app.get(InspectionsService);
  const snags = app.get(SnagsService);
  const concrete = app.get(ConcreteService);
  const completion = app.get(CompletionService);
  const diaries = app.get(DiariesService);
  const today = nairobiDate();
  const day = (offset: number) => addCalendarDays(today, offset);

  await templates.loadStarter(owner, "en", seedRequest);
  const list = await templates.list(owner, false, seedRequest);
  const template = (category: string) =>
    list.templates.find((entry) => entry.category === category)!.id;

  /** Records an inspection as the site agent, answers it and submits it. */
  const inspect = async (
    projectId: string,
    siteId: string,
    input: {
      category: string;
      location: string;
      inspectorType: "internal" | "consultant" | "county";
      inspectorName: string | null;
      inspectedOn: string;
      failures?: Record<number, string>;
    },
  ): Promise<InspectionDetailResponse> => {
    let detail = await inspections.create(
      agent,
      projectId,
      {
        siteId,
        templateId: template(input.category),
        location: input.location,
        inspectorType: input.inspectorType,
        inspectorName: input.inspectorName,
        inspectedOn: input.inspectedOn,
        notes: null,
      },
      seedRequest,
    );
    detail = await inspections.update(
      agent,
      projectId,
      detail.inspection.id,
      {
        version: detail.inspection.version,
        items: detail.items.map((item, index) => {
          const failure = input.failures?.[index];
          return {
            id: item.id,
            result: (failure ? "fail" : "pass") as InspectionItemResult,
            note: failure ?? null,
            photoIds: [],
          };
        }),
      },
      seedRequest,
    );
    return inspections.action(
      agent,
      projectId,
      detail.inspection.id,
      { version: detail.inspection.version, action: "submit" },
      seedRequest,
    );
  };
  const signOff = (projectId: string, detail: InspectionDetailResponse) =>
    inspections.action(
      pm,
      projectId,
      detail.inspection.id,
      { version: detail.inspection.version, action: "sign_off" },
      seedRequest,
    );
  const raise = (
    projectId: string,
    siteId: string,
    input: {
      location: string;
      description: string;
      severity: "critical" | "major" | "minor";
      responsibleKind: "gang" | "subcontractor" | "supplier" | "other";
      responsibleName: string;
      dueOn: string | null;
      inspectionItemId?: string;
    },
  ) =>
    snags
      .create(agent, projectId, { siteId, ...input, photoIds: [] }, seedRequest)
      .then((response) => response.snag);
  const fixAndClose = async (projectId: string, snag: { id: string; version: number }) => {
    const fixed = await snags.action(
      agent,
      projectId,
      snag.id,
      { version: snag.version, action: "fix", note: "Made good and checked on site" },
      seedRequest,
    );
    return snags.action(
      pm,
      projectId,
      snag.id,
      { version: fixed.snag.version, action: "close" },
      seedRequest,
    );
  };

  // RUI-HTS inspections and snags ------------------------------------------------------------------
  await signOff(
    facts.ruiru,
    await inspect(facts.ruiru, facts.ruiruSite, {
      category: "slab",
      location: "First floor slab, bays 1–4",
      inspectorType: "consultant",
      inspectorName: "Eng. Synthetic Njoroge (structural consultant)",
      inspectedOn: day(-41),
    }),
  );
  const walling = await signOff(
    facts.ruiru,
    await inspect(facts.ruiru, facts.ruiruSite, {
      category: "blockwork",
      location: "Second floor, block A walling",
      inspectorType: "county",
      inspectorName: "County building inspector (synthetic)",
      inspectedOn: day(-6),
      failures: {
        2: "Hoop iron missing at course 6 on gridline C",
        3: "Lintel over door D3 bears 100 mm; 150 mm required",
      },
    }),
  );
  await inspect(facts.ruiru, facts.ruiruSite, {
    category: "roofing",
    location: "Roof beam formwork and wall plates",
    inspectorType: "internal",
    inspectorName: null,
    inspectedOn: day(-1),
  });
  await raise(facts.ruiru, facts.ruiruSite, {
    location: "Second floor, door D3",
    description: "Lintel bearing short (100 mm against 150 mm): extend the bearing before loading",
    severity: "critical",
    responsibleKind: "gang",
    responsibleName: "Gang B: masonry and plaster",
    dueOn: day(3),
    inspectionItemId: walling.items[3]!.id,
  });
  const hoop = await raise(facts.ruiru, facts.ruiruSite, {
    location: "Second floor, gridline C",
    description: "Hoop iron missing at course 6: open up and lay the missing run",
    severity: "major",
    responsibleKind: "gang",
    responsibleName: "Gang B: masonry and plaster",
    dueOn: day(5),
    inspectionItemId: walling.items[2]!.id,
  });
  await snags.action(
    agent,
    facts.ruiru,
    hoop.id,
    { version: hoop.version, action: "fix", note: "Hoop iron laid and photographed" },
    seedRequest,
  );
  await fixAndClose(
    facts.ruiru,
    await raise(facts.ruiru, facts.ruiruSite, {
      location: "Ground floor stair core",
      description: "Honeycombing at the base of column C4",
      severity: "major",
      responsibleKind: "gang",
      responsibleName: "Gang A: concrete and formwork",
      dueOn: day(-20),
    }),
  );
  await raise(facts.ruiru, facts.ruiruSite, {
    location: "Main plot hoarding by the gate",
    description: "Hoarding panel loose at the yard gate",
    severity: "minor",
    responsibleKind: "supplier",
    responsibleName: "Hoarding hire company (synthetic)",
    dueOn: day(-5),
  });

  // RUI-HTS concrete tests --------------------------------------------------------------------------
  const cubes = async (
    element: string,
    concreteClass: "C25" | "C30",
    castOffset: number,
    results: { age: 7 | 28; strengths: string[] }[],
  ) => {
    const castOn = day(castOffset);
    const set = await concrete.createCubes(
      agent,
      facts.ruiru,
      {
        siteId: facts.ruiruSite,
        element,
        concreteClass,
        castOn,
        cubesPerAge: 3,
        batchReference: null,
        notes: null,
      },
      seedRequest,
    );
    for (const result of results)
      await concrete.recordResult(
        agent,
        facts.ruiru,
        set.cubeSet.id,
        {
          ageDays: result.age,
          testedOn: addCalendarDays(castOn, result.age),
          strengths: result.strengths,
          laboratory: "Synthetic Materials Testing Lab",
          reportReference: null,
        },
        seedRequest,
      );
    return set.cubeSet.id;
  };
  const groundSlab = await cubes("Ground floor slab", "C25", -60, [
    { age: 7, strengths: ["17.8", "18.4", "18.1"] },
    { age: 28, strengths: ["27.6", "28.9", "26.8"] },
  ]);
  const firstSlab = await cubes("First floor slab, bay 2", "C25", -40, [
    { age: 7, strengths: ["15.0", "15.6", "14.8"] },
    { age: 28, strengths: ["22.4", "21.6", "23.9"] },
  ]);
  const columns = await cubes("Second floor columns", "C30", -12, [
    { age: 7, strengths: ["21.0", "22.4", "21.8"] },
  ]);
  await cubes("Roof beam, gridlines A–C", "C25", -10, []);
  const slump = (
    element: string,
    cubeSetId: string,
    testedOn: string,
    measuredMm: number,
    concreteClass: "C25" | "C30" = "C25",
  ) =>
    concrete.createSlump(
      agent,
      facts.ruiru,
      {
        siteId: facts.ruiruSite,
        cubeSetId,
        testedOn,
        element,
        concreteClass,
        targetMm: 75,
        toleranceMm: 20,
        measuredMm,
        notes: null,
      },
      seedRequest,
    );
  await slump("Ground floor slab", groundSlab, day(-60), 80);
  await slump("First floor slab, bay 2", firstSlab, day(-40), 110);
  await slump("Second floor columns", columns, day(-12), 70, "C30");

  // RUI-HTS site diaries with an attendance snapshot --------------------------------------------------
  const musterDays = await read((tx) =>
    tx.attendanceDay.findMany({
      where: {
        tenantId,
        siteId: facts.ruiruSite,
        workDate: { lt: new Date(`${today}T00:00:00Z`) },
      },
      orderBy: { workDate: "desc" },
      take: 2,
      select: { workDate: true },
    }),
  );
  let diaryCount = 0;
  for (const [index, entry] of musterDays.entries()) {
    const date = toCalendarDate(entry.workDate);
    const diary = await diaries.create(
      agent,
      facts.ruiru,
      {
        siteId: facts.ruiruSite,
        date,
        workPerformed:
          index === 0
            ? "Second floor walling to block A; roof beam formwork started (synthetic)"
            : "Second floor columns cast; cubes taken for CUBE-0003 (synthetic)",
        weather: index === 0 ? "Overcast, dry" : "Sunny",
        delays: null,
        workforceCount: null,
        workforceSource: "attendance",
      },
      seedRequest,
    );
    diaryCount += 1;
    if (index === 0) continue;
    const submitted = await diaries.action(
      agent,
      facts.ruiru,
      diary.diary.id,
      { version: diary.diary.version, action: "submit" },
      seedRequest,
    );
    await diaries.action(
      pm,
      facts.ruiru,
      diary.diary.id,
      { version: submitted.diary.version, action: "approve" },
      seedRequest,
    );
  }

  // JUJ-DPX: handed over, practical completion certified, DLP running ------------------------------
  await signOff(
    facts.juja,
    await inspect(facts.juja, facts.jujaSite, {
      category: "handover",
      location: "Whole house, pre-handover walk-round",
      inspectorType: "consultant",
      inspectorName: "Arch. Synthetic Mutua (project architect)",
      inspectedOn: day(-80),
    }),
  );
  for (const snag of [
    {
      location: "Bedroom 2 window",
      description: "Window stay missing",
      severity: "minor" as const,
      responsibleName: "Glazing subcontractor (synthetic)",
    },
    {
      location: "Main entrance",
      description: "Front door does not lock",
      severity: "critical" as const,
      responsibleName: "Joinery subcontractor (synthetic)",
    },
  ])
    await fixAndClose(
      facts.juja,
      await raise(facts.juja, facts.jujaSite, {
        ...snag,
        responsibleKind: "subcontractor",
        dueOn: day(-78),
      }),
    );
  const proposed = await completion.propose(
    pm,
    facts.juja,
    {
      kind: "practical",
      completionDate: day(-75),
      dlpMonths: 6,
      exceptionReason: null,
      notes: "Handed over to the client with keys and manuals (synthetic)",
    },
    seedRequest,
  );
  await completion.action(
    owner,
    facts.juja,
    proposed.practical!.id,
    { version: proposed.practical!.version, action: "certify" },
    seedRequest,
  );
  const leak = await raise(facts.juja, facts.jujaSite, {
    location: "Kitchen",
    description: "Kitchen sink mixer tap leaking at the base",
    severity: "major",
    responsibleKind: "subcontractor",
    responsibleName: "Plumbing subcontractor (synthetic)",
    dueOn: day(-10),
  });
  await snags.action(
    agent,
    facts.juja,
    leak.id,
    { version: leak.version, action: "fix", note: "Mixer re-seated and new washer fitted" },
    seedRequest,
  );
  await raise(facts.juja, facts.jujaSite, {
    location: "Lounge ceiling",
    description: "Hairline crack along the gypsum ceiling joint",
    severity: "minor",
    responsibleKind: "subcontractor",
    responsibleName: "Ceiling subcontractor (synthetic)",
    dueOn: day(14),
  });
  return summarise(read, facts, true, diaryCount);
}

async function summarise(
  read: <T>(
    work: (tx: Parameters<Parameters<TenantDatabase["run"]>[1]>[0]) => Promise<T>,
  ) => Promise<T>,
  facts: { ruiru: string; juja: string },
  created: boolean,
  diaries?: number,
): Promise<QualitySeedSummary> {
  return read(async (tx) => {
    const projectIds = [facts.ruiru, facts.juja];
    const practical = await tx.projectCompletion.findFirst({
      where: { projectId: facts.juja, kind: "practical", status: "certified" },
    });
    const today = nairobiDate();
    const sets = await tx.cubeSet.findMany({
      where: { projectId: facts.ruiru, status: "active" },
      include: { results: { include: { supersededBy: { select: { id: true } } } } },
    });
    const overdue = sets.filter((set) =>
      ([7, 28] as const).some(
        (age) =>
          addCalendarDays(toCalendarDate(set.castOn), age + 2) < today &&
          !set.results.some((result) => result.ageDays === age),
      ),
    ).length;
    return {
      created,
      templates: await tx.checklistTemplate.count(),
      inspections: await tx.inspection.count({ where: { projectId: { in: projectIds } } }),
      snags: await tx.snag.count({ where: { projectId: { in: projectIds } } }),
      cubeSets: sets.length,
      failedCubeSets: sets.filter((set) =>
        set.results.some(
          (result) =>
            result.ageDays === 28 && result.outcome === "fail" && result.supersededBy === null,
        ),
      ).length,
      overdueCubeSets: overdue,
      slumpTests: await tx.slumpTest.count({ where: { projectId: facts.ruiru } }),
      diaries:
        diaries ??
        (await tx.siteDiary.count({
          where: { projectId: facts.ruiru, workforceSource: "attendance" },
        })),
      practicalCompletion: practical ? toCalendarDate(practical.completionDate) : null,
      dlpEndsOn: practical?.dlpEndsOn ? toCalendarDate(practical.dlpEndsOn) : null,
    };
  });
}
