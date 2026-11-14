import type { INestApplicationContext } from "@nestjs/common";
import type { Request } from "express";
import sharp from "sharp";
import { addCalendarDays, nairobiDate } from "@pm-buddy/domain";
import { BQ_ROUNDING, BQ_VAT_RULE } from "@pm-buddy/types";
import {
  addValuationAdjustmentRequestSchema,
  createJournalRequestSchema,
  createMeasurementRequestSchema,
  createValuationRequestSchema,
  updateContractSettingsRequestSchema,
} from "@pm-buddy/validation";
import { uuidv7 } from "../common/uuid.js";
import { PrismaService } from "../infra/prisma.service.js";
import { CostLedgerService } from "../modules/finance/cost-ledger.service.js";
import { TenantDatabase } from "../modules/identity/tenant-database.service.js";
import { MeasurementsService } from "../modules/progress/measurements/measurements.service.js";
import { PhotosService } from "../modules/progress/photos.service.js";
import { EarnedValueService } from "../modules/progress/valuations/earned-value.service.js";
import { ValuationsService } from "../modules/progress/valuations/valuations.service.js";
import { seedPrincipal } from "./demo-procure-to-pay.js";

/**
 * D6.3 part A demo data (synthetic). RUI-HTS: contract settings (retention 10 % limited to 5 %,
 * VAT 16 %, materials at cost, half released at practical completion), site photos, measurements
 * by the site agent approved by the project manager (and the D5.3 measurement approved by the
 * owner once the project manager added a photo), one left pending for the approval queue,
 * IPC-0001 with a mobilisation advance and IPC-0002 (materials in stores at cost, an advance
 * recovery) netting off IPC-0001, both certified by finance; schedule tasks linked to the BQ
 * items and a maker-checked labour cost journal so earned value has planned, earned and actual
 * figures. JUJ-DPX (handed over): a small BQ, two certified interim certificates and the
 * practical-completion retention release. Every step goes through the real services and the
 * database triggers. Idempotent: skipped when RUI-HTS already has a valuation.
 */
export type ValuationsSeedSummary = {
  created: boolean;
  certificates: string[];
  measurements: { approved: number; pending: number };
  retentionHeld: string[];
  earnedValue: { cpi: string | null; spi: string | null };
};

type SeedUsers = {
  ownerId: string;
  projectManagerId: string;
  siteAgentId: string;
  financeId: string;
};

const seedRequest = { headers: {} } as Request;

const dms = (value: number) => {
  const magnitude = Math.abs(value);
  const degrees = Math.floor(magnitude);
  const minutesFull = (magnitude - degrees) * 60;
  const minutes = Math.floor(minutesFull);
  const hundredths = Math.round((minutesFull - minutes) * 60 * 100);
  return `${degrees}/1 ${minutes}/1 ${hundredths}/100`;
};

/** A small synthetic JPEG with GPS and capture time (Nairobi) so the server can verify it. */
async function sitePhoto(lat: number, lng: number, caption: string): Promise<Buffer> {
  const now = new Date(Date.now() + 3 * 3_600_000).toISOString();
  const taken = `${now.slice(0, 10).replaceAll("-", ":")} ${now.slice(11, 19)}`;
  return sharp({
    create: { width: 96, height: 72, channels: 3, background: { r: 120, g: 110, b: 95 } },
  })
    .jpeg()
    .withExif({
      IFD0: { ImageDescription: `${caption} ${uuidv7()}`, Make: "Demo", Model: "Synthetic" },
      IFD2: { DateTimeOriginal: taken, OffsetTimeOriginal: "+03:00" },
      IFD3: {
        GPSLatitudeRef: lat < 0 ? "S" : "N",
        GPSLatitude: dms(lat),
        GPSLongitudeRef: lng < 0 ? "W" : "E",
        GPSLongitude: dms(lng),
      },
    })
    .toBuffer();
}

/** JUJ-DPX's BQ (excl. VAT): 12,276,000.00, of which the provisional sum is never measured. */
const JUJA_BQ = [
  [
    "1",
    "P1",
    "preliminary",
    "Site establishment, insurances and supervision",
    "item",
    null,
    null,
    120_000_000n,
  ],
  ["2", "W1", "measured", "Machine-cut stone walling, 200 mm", "m2", "1600", "2150", 344_000_000n],
  [
    "2",
    "C1",
    "measured",
    "Reinforced concrete class 25 in slabs and beams",
    "m3",
    "180",
    "18200",
    327_600_000n,
  ],
  [
    "2",
    "R1",
    "measured",
    "Roof covering, pre-painted iron sheets",
    "m2",
    "320",
    "3250",
    104_000_000n,
  ],
  ["2", "F1", "measured", "Plaster, screed and paint finishes", "m2", "2400", "1175", 282_000_000n],
  [
    "3",
    "PS1",
    "provisional_sum",
    "Provisional sum for landscaping",
    "item",
    null,
    null,
    50_000_000n,
  ],
] as const;

export async function seedValuations(
  app: INestApplicationContext,
  tenantId: string,
  users: SeedUsers,
): Promise<ValuationsSeedSummary> {
  const prisma = app.get(PrismaService);
  const db = app.get(TenantDatabase);
  const read = <T>(work: (tx: Parameters<Parameters<TenantDatabase["run"]>[1]>[0]) => Promise<T>) =>
    db.run({ userId: users.ownerId, tenantId, requestId: "seed" }, work);
  const [owner, pm, agent, finance] = await Promise.all(
    [users.ownerId, users.projectManagerId, users.siteAgentId, users.financeId].map((id) =>
      seedPrincipal(prisma, id, tenantId),
    ),
  );
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
      existing: await tx.valuation.count({ where: { tenantId, projectId: ruiru.id } }),
    };
  });
  if (facts.existing) return summarise(app, read, owner, facts, false);

  const today = nairobiDate();
  const day = (offset: number) => addCalendarDays(today, offset);
  const photos = app.get(PhotosService);
  const measurements = app.get(MeasurementsService);
  const valuations = app.get(ValuationsService);
  const upload = async (projectId: string, siteId: string, at: [number, number], caption: string) =>
    (
      await photos.upload(
        agent,
        projectId,
        {
          buffer: await sitePhoto(at[0], at[1], caption),
          originalname: "measurement.jpg",
          size: 1,
        },
        { siteId, caption },
        seedRequest,
      )
    ).photo.id;
  const measure = async (
    projectId: string,
    lineageId: string,
    measuredOn: string,
    quantityToDate: string,
    photoIds: string[],
    extra: { overMeasureReason?: string; note?: string } = {},
  ) =>
    (
      await measurements.record(
        agent,
        projectId,
        createMeasurementRequestSchema.parse({
          bqItemLineageId: lineageId,
          measuredOn,
          quantityToDate,
          photoIds,
          ...extra,
        }),
        seedRequest,
      )
    ).measurement;
  const approve = (projectId: string, id: string, reviewer = pm) =>
    measurements.decide(reviewer, projectId, id, "approved", null, seedRequest);
  /** Prepared by the project manager (bq.edit), certified by finance (never a contributor). */
  const certificate = async (
    projectId: string,
    input: Parameters<typeof createValuationRequestSchema.parse>[0],
    adjustment?: { kind: "advance" | "advance_recovery"; description: string; amountMinor: number },
  ) => {
    let detail = (
      await valuations.create(pm, projectId, createValuationRequestSchema.parse(input), seedRequest)
    ).valuation;
    if (adjustment)
      detail = (
        await valuations.addAdjustment(
          pm,
          detail.id,
          addValuationAdjustmentRequestSchema.parse({ version: detail.version, ...adjustment }),
          seedRequest,
        )
      ).valuation;
    detail = (await valuations.submit(pm, detail.id, detail.version, seedRequest)).valuation;
    return (
      await valuations.certify(
        finance,
        detail.id,
        { version: detail.version, digest: detail.digest! },
        seedRequest,
      )
    ).valuation;
  };

  // RUI-HTS ----------------------------------------------------------------------------------------
  await valuations.updateSettings(
    finance,
    facts.ruiru,
    updateContractSettingsRequestSchema.parse({
      version: 0,
      retentionPercent: "10",
      retentionCapPercent: "5",
      vatPercent: "16",
      materialsPercent: "100",
      practicalReleasePercent: "50",
    }),
    seedRequest,
  );
  const ruiruItems = await read(async (tx) => {
    const version = await tx.bqVersion.findFirstOrThrow({
      where: { tenantId, projectId: facts.ruiru, status: "approved" },
      orderBy: { versionNo: "desc" },
    });
    const items = await tx.bqItem.findMany({ where: { tenantId, versionId: version.id } });
    return Object.fromEntries(items.map((item) => [item.ref!, item.lineageId]));
  });
  const ruiruAt: [number, number] = [-1.14888, 36.9612];
  const columns = await upload(facts.ruiru, facts.ruiruSite, ruiruAt, "Column bases cast");
  const slab = await upload(facts.ruiru, facts.ruiruSite, ruiruAt, "Ground floor slab");
  const walling = await upload(facts.ruiru, facts.ruiruSite, ruiruAt, "Substructure walling");
  for (const [ref, quantity, photo] of [
    ["A", "8", columns],
    ["B", "10", slab],
    ["C", "40", walling],
  ] as const) {
    const measurement = await measure(facts.ruiru, ruiruItems[ref]!, day(-50), quantity, [photo]);
    await approve(facts.ruiru, measurement.id);
  }
  await certificate(
    facts.ruiru,
    { kind: "interim", valuationDate: day(-45) },
    { kind: "advance", description: "Mobilisation advance (synthetic)", amountMinor: 5_000_000 },
  );

  // The D5.3 measurement (by the project manager, today): evidence added, approved by the owner.
  const earlier = await read((tx) =>
    tx.progressMeasurement.findFirst({
      where: { tenantId, projectId: facts.ruiru, review: { is: null }, correctedBy: { is: null } },
    }),
  );
  if (earlier) {
    await measurements.addPhotos(pm, facts.ruiru, earlier.id, [columns], seedRequest);
    await approve(facts.ruiru, earlier.id, owner);
  }
  for (const [ref, quantity, photo] of [
    ["B", "24", slab],
    ["C", "90", walling],
  ] as const) {
    const measurement = await measure(facts.ruiru, ruiruItems[ref]!, day(-3), quantity, [photo]);
    await approve(facts.ruiru, measurement.id);
  }
  // Waiting in the approval queue.
  await measure(facts.ruiru, ruiruItems["C"]!, today, "100", [walling], {
    note: "Walling to DPC level complete on grid lines A–D (synthetic)",
  });
  await certificate(
    facts.ruiru,
    { kind: "interim", valuationDate: today, materialsFromStores: true },
    {
      kind: "advance_recovery",
      description: "Advance recovery (synthetic)",
      amountMinor: -2_000_000,
    },
  );

  // Earned value: the substructure tasks name the BQ items they build; labour cost reaches the
  // ledger by a maker-checked journal (payroll costs are not posted yet, D5.4).
  await db.run({ userId: users.ownerId, tenantId, requestId: "seed" }, async (tx) => {
    for (const [code, ref] of [
      ["S02", "A"],
      ["S04", "B"],
      ["S03", "C"],
    ] as const) {
      const activity = await tx.scheduleActivity.findUnique({
        where: { tenantId_projectId_code: { tenantId, projectId: facts.ruiru, code } },
      });
      if (!activity) continue;
      const version = await tx.bqVersion.findFirstOrThrow({
        where: { tenantId, projectId: facts.ruiru, status: "approved" },
        orderBy: { versionNo: "desc" },
      });
      await tx.scheduleActivity.update({
        where: { tenantId_id: { tenantId, id: activity.id } },
        data: {
          bqVersionId: version.id,
          bqItemLineageId: ruiruItems[ref]!,
          updatedBy: users.ownerId,
          version: { increment: 1 },
        },
      });
    }
  });
  const ledger = app.get(CostLedgerService);
  const journal = await ledger.createJournal(
    finance,
    createJournalRequestSchema.parse({
      projectId: facts.ruiru,
      reason: "Substructure labour (payroll costs are not in the ledger yet; synthetic)",
      lines: (
        [
          ["A", 15_000_000],
          ["B", 21_000_000],
          ["C", 6_000_000],
        ] as const
      ).map(([ref, amountMinor]) => ({
        measure: "accrued",
        category: "labour",
        bqItemLineageId: ruiruItems[ref]!,
        siteId: facts.ruiruSite,
        counterpartyKind: "other",
        counterpartyName: "Substructure gangs (synthetic)",
        occurredOn: day(-20),
        amountMinor,
      })),
    }),
    seedRequest,
  );
  await ledger.approveJournal(owner, journal.journal.id, journal.journal.version, seedRequest);

  // JUJ-DPX: a BQ, two interim certificates and the practical-completion release -----------------
  const jujaItems = await seedJujaBq(db, tenantId, facts.juja, users);
  const jujaAt: [number, number] = [-1.1012, 37.0144];
  const shell = await upload(facts.juja, facts.jujaSite, jujaAt, "Shell and roof");
  const handover = await upload(facts.juja, facts.jujaSite, jujaAt, "Handover finishes");
  for (const [ref, quantity] of [
    ["P1", "50"],
    ["W1", "900"],
    ["C1", "120"],
  ] as const) {
    const measurement = await measure(facts.juja, jujaItems[ref]!, day(-240), quantity, [shell]);
    await approve(facts.juja, measurement.id);
  }
  await certificate(facts.juja, { kind: "interim", valuationDate: day(-235) });
  for (const [ref, quantity] of [
    ["P1", "100"],
    ["W1", "1600"],
    ["C1", "180"],
    ["R1", "320"],
    ["F1", "2400"],
  ] as const) {
    const measurement = await measure(facts.juja, jujaItems[ref]!, day(-90), quantity, [handover]);
    await approve(facts.juja, measurement.id);
  }
  await certificate(facts.juja, { kind: "interim", valuationDate: day(-85) });
  await certificate(facts.juja, {
    kind: "retention_release",
    releaseStage: "practical",
    valuationDate: day(-70),
  });
  return summarise(app, read, owner, facts, true);
}

/** JUJ-DPX's BQ written by the owner and approved by the project manager (as the stores seed). */
async function seedJujaBq(
  db: TenantDatabase,
  tenantId: string,
  projectId: string,
  users: SeedUsers,
): Promise<Record<string, string>> {
  const lineages: Record<string, string> = {};
  const versionId = uuidv7();
  const subtotal = JUJA_BQ.reduce((total, row) => total + row[7], 0n);
  const vat = (subtotal * 16n + 50n) / 100n;
  await db.run({ userId: users.ownerId, tenantId, requestId: "seed" }, async (tx) => {
    const bqId = uuidv7();
    await tx.bq.create({
      data: { id: bqId, tenantId, projectId, name: "Bill of Quantities", createdBy: users.ownerId },
    });
    await tx.bqVersion.create({
      data: {
        id: versionId,
        tenantId,
        projectId,
        bqId,
        versionNo: 1,
        status: "draft",
        source: "import",
        vatRatePercent: BQ_VAT_RULE.defaultRatePercent,
        vatRuleKey: BQ_VAT_RULE.key,
        vatRuleStatus: BQ_VAT_RULE.status,
        rounding: BQ_ROUNDING,
        subtotalMinor: subtotal,
        vatMinor: vat,
        grandTotalMinor: subtotal + vat,
        billCount: 3,
        itemCount: JUJA_BQ.length,
        createdBy: users.ownerId,
        updatedBy: users.ownerId,
      },
    });
    const bills = new Map<string, string>();
    for (const [index, [number, title, kind]] of (
      [
        ["1", "Preliminaries (synthetic demo)", "preliminaries"],
        ["2", "Building works (synthetic demo)", "measured"],
        ["3", "Provisional sums (synthetic demo)", "provisional"],
      ] as const
    ).entries()) {
      const id = uuidv7();
      bills.set(number, id);
      await tx.bqBill.create({
        data: {
          id,
          tenantId,
          versionId,
          number,
          title,
          kind,
          sortOrder: index,
          totalMinor: JUJA_BQ.filter((row) => row[0] === number).reduce(
            (total, row) => total + row[7],
            0n,
          ),
          sourceSheet: `Bill ${number}`,
          lineageId: uuidv7(),
        },
      });
    }
    for (const [
      index,
      [bill, ref, kind, description, unit, quantity, rate, amount],
    ] of JUJA_BQ.entries()) {
      const lineageId = uuidv7();
      lineages[ref] = lineageId;
      await tx.bqItem.create({
        data: {
          id: uuidv7(),
          tenantId,
          versionId,
          billId: bills.get(bill)!,
          lineageId,
          ref,
          description: `${description} (synthetic)`,
          unit,
          unitRaw: unit,
          quantity,
          rate,
          amountMinor: amount,
          sheetAmountMinor: quantity === null ? amount : null,
          amountSource: quantity === null ? "lump_sum" : "computed",
          kind,
          sortOrder: index,
        },
      });
    }
  });
  await db.run({ userId: users.projectManagerId, tenantId, requestId: "seed" }, async (tx) => {
    await tx.bqVersion.updateMany({
      where: { tenantId, id: versionId, status: "draft" },
      data: {
        status: "approved",
        approvedBy: users.projectManagerId,
        approvedAt: new Date(),
        version: { increment: 1 },
      },
    });
    await tx.auditEvent.create({
      data: {
        tenantId,
        actorId: users.projectManagerId,
        requestId: "seed",
        action: "bq.baseline.approved",
        resourceId: versionId,
        metadata: { projectId, versionNo: 1, source: "seed" },
      },
    });
  });
  return lineages;
}

async function summarise(
  app: INestApplicationContext,
  read: <T>(
    work: (tx: Parameters<Parameters<TenantDatabase["run"]>[1]>[0]) => Promise<T>,
  ) => Promise<T>,
  owner: Awaited<ReturnType<typeof seedPrincipal>>,
  facts: { ruiru: string; juja: string },
  created: boolean,
): Promise<ValuationsSeedSummary> {
  const valuations = app.get(ValuationsService);
  const [ruiru, juja, counts, evm] = await Promise.all([
    valuations.projectView(owner, facts.ruiru, seedRequest),
    valuations.projectView(owner, facts.juja, seedRequest),
    read(async (tx) => ({
      approved: await tx.progressMeasurementReview.count({ where: { decision: "approved" } }),
      pending: await tx.progressMeasurement.count({
        where: { review: { is: null }, correctedBy: { is: null } },
      }),
    })),
    app.get(EarnedValueService).earnedValue(owner, facts.ruiru, undefined, seedRequest),
  ]);
  const certificates = [ruiru, juja].flatMap((view) =>
    [...view.valuations]
      .filter((row) => row.certificateNumber)
      .reverse()
      .map(
        (row) =>
          `${view.project.code} ${row.certificateNumber} (${row.kind === "interim" ? "interim" : `${row.releaseStage} retention release`})`,
      ),
  );
  const kes = (minor: number) =>
    `KES ${(minor / 100).toLocaleString("en-KE", { minimumFractionDigits: 2 })}`;
  return {
    created,
    certificates,
    measurements: counts,
    retentionHeld: [ruiru, juja].map(
      (view) => `${view.project.code} ${kes(view.retention.heldMinor)}`,
    ),
    earnedValue: { cpi: evm.figures.cpi, spi: evm.figures.spi },
  };
}
