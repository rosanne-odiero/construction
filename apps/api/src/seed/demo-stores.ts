import { randomUUID } from "node:crypto";
import type { INestApplicationContext } from "@nestjs/common";
import type { Request } from "express";
import { BQ_ROUNDING, BQ_VAT_RULE } from "@pm-buddy/types";
import { nairobiDate } from "@pm-buddy/domain";
import {
  awardRfqRequestSchema,
  createGrnRequestSchema,
  createIssueRequestSchema,
  createMeasurementRequestSchema,
  createRequisitionRequestSchema,
  createReturnRequestSchema,
  createRfqRequestSchema,
  createWastageRequestSchema,
  dispatchTransferRequestSchema,
  receiveTransferRequestSchema,
  recordCountsRequestSchema,
  recordQuotationRequestSchema,
} from "@pm-buddy/validation";
import { uuidv7 } from "../common/uuid.js";
import { PrismaService } from "../infra/prisma.service.js";
import { BuildupsService } from "../modules/bq/buildups.service.js";
import { TenantDatabase } from "../modules/identity/tenant-database.service.js";
import { GrnsService } from "../modules/procurement/p2p/grns.service.js";
import { LposService } from "../modules/procurement/p2p/lpos.service.js";
import { RequisitionsService } from "../modules/procurement/p2p/requisitions.service.js";
import { RfqsService } from "../modules/procurement/p2p/rfqs.service.js";
import { BuildupMaterialsService } from "../modules/procurement/stores/buildup-materials.service.js";
import { MovementsService } from "../modules/procurement/stores/movements.service.js";
import { StockTakesService } from "../modules/procurement/stores/stock-takes.service.js";
import { StoresService } from "../modules/procurement/stores/stores.service.js";
import { TransfersService } from "../modules/procurement/stores/transfers.service.js";
import { VarianceService } from "../modules/procurement/stores/variance.service.js";
import { MeasurementsService } from "../modules/progress/measurements/measurements.service.js";
import { DEMO_BUILDUP } from "./demo-seed.js";
import { DEMO_SUPPLIERS } from "./demo-procurement.js";
import { seedPrincipal } from "./demo-procure-to-pay.js";

/**
 * D5.3 demo data (synthetic): a cement delivery received into the Ruiru Heights store, an approved
 * BQ baseline with concrete items linked to the CONC-C25-SYN build-up (its material lines mapped
 * to catalogue materials), 12.5 m³ of column bases measured, and issues to that item well above
 * what the measured concrete needs — so the cement VARIANCE ALERT FIRES — plus a return, wastage,
 * reorder levels with low stock, a Kitengela store with one disputed and one in-transit transfer,
 * and a submitted stock take waiting for the project manager's independent approval. Every step
 * goes through the real services and database triggers (permissions, maker-checker, the ledger
 * lock and valuation). The BQ rows are written directly because the import pipeline needs an
 * uploaded workbook; they still pass the BQ triggers and are approved by someone who did not
 * write them.
 */
const STORES_NOTE = "Demo stores flow (synthetic)";

export type StoresSeedSummary = {
  created: boolean;
  stores: string[];
  movements: string[];
  transfers: string[];
  stockTake: string;
  varianceAlerts: number;
  lowStock: number;
};

type SeedUsers = {
  ownerId: string;
  projectManagerId: string;
  siteAgentId: string;
  storekeeperId: string;
};

const seedRequest = { headers: {} } as Request;
const addDays = (days: number) => {
  const date = new Date(`${nairobiDate()}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
const at = () => new Date().toISOString();

/** Synthetic BQ items: [ref, description, unit, quantity, rate (KES)]. */
const BQ_ITEMS = [
  ["A", "Reinforced concrete class 25 in column bases (synthetic)", "m3", "24", "16500"],
  ["B", "Concrete class 25 in ground floor slab, 150 mm thick (synthetic)", "m3", "36", "15800"],
  ["C", "Machine-cut stone walling, 200 mm thick (synthetic)", "m2", "120", "1450"],
] as const;

export async function seedStores(
  app: INestApplicationContext,
  tenantId: string,
  users: SeedUsers,
): Promise<StoresSeedSummary> {
  const prisma = app.get(PrismaService);
  const db = app.get(TenantDatabase);
  const read = <T>(work: (tx: Parameters<Parameters<TenantDatabase["run"]>[1]>[0]) => Promise<T>) =>
    db.run({ userId: users.ownerId, tenantId, requestId: "seed" }, work);
  const existing = await read((tx) =>
    tx.stockMovement.findFirst({ where: { tenantId, notes: STORES_NOTE } }),
  );
  const [owner, pm, agent, keeper] = await Promise.all(
    [users.ownerId, users.projectManagerId, users.siteAgentId, users.storekeeperId].map((id) =>
      seedPrincipal(prisma, id, tenantId),
    ),
  );
  if (existing) return summarise(app, owner, false);

  const facts = await read(async (tx) => {
    const project = async (code: string) =>
      tx.project.findUniqueOrThrow({ where: { tenantId_code: { tenantId, code } } });
    const ruiru = await project("RUI-HTS");
    const kitengela = await project("KIT-BNG");
    const firstSite = (projectId: string) =>
      tx.site.findFirstOrThrow({ where: { tenantId, projectId }, orderBy: { name: "asc" } });
    const material = async (name: string) =>
      (await tx.material.findFirstOrThrow({ where: { tenantId, name } })).id;
    const supplier = async (legalName: string) =>
      (await tx.supplier.findFirstOrThrow({ where: { tenantId, legalName } })).id;
    const buildup = await tx.rateBuildup.findUniqueOrThrow({
      where: { tenantId_code: { tenantId, code: DEMO_BUILDUP.code } },
      include: { versions: { where: { versionNo: 1 }, include: { lines: true } } },
    });
    const gang = await tx.gang.findFirst({
      where: { tenantId, projectId: ruiru.id, status: "active" },
      orderBy: { name: "asc" },
    });
    return {
      ruiru: ruiru.id,
      ruiruSite: (await firstSite(ruiru.id)).id,
      kitengela: kitengela.id,
      kitengelaSite: (await firstSite(kitengela.id)).id,
      cement: await material("Cement 42.5N (50 kg bag)"),
      sand: await material("River sand"),
      ballast: await material("Ballast 20 mm"),
      suppliers: await Promise.all(DEMO_SUPPLIERS.map((entry) => supplier(entry.legalName))),
      buildupId: buildup.id,
      buildupVersion: buildup.versions[0]!,
      gangId: gang?.id ?? null,
    };
  });

  // 1. 120 bags of cement: requisition → RFQ (three quotations) → LPO → GRN into the store.
  const requisitions = app.get(RequisitionsService);
  const rfqs = app.get(RfqsService);
  const lpos = app.get(LposService);
  let requisition = await requisitions.create(
    agent,
    createRequisitionRequestSchema.parse({
      projectId: facts.ruiru,
      siteId: facts.ruiruSite,
      neededBy: addDays(5),
      notes: "Cement for column bases (synthetic stores demo)",
      lines: [{ materialId: facts.cement, quantity: "120", unit: "bag_50kg" }],
    }),
    seedRequest,
  );
  requisition = await requisitions.transition(
    agent,
    requisition.requisition.id,
    "submit",
    { version: requisition.requisition.version },
    seedRequest,
  );
  await requisitions.transition(
    pm,
    requisition.requisition.id,
    "approve",
    { version: requisition.requisition.version },
    seedRequest,
  );
  let rfq = await rfqs.create(
    owner,
    createRfqRequestSchema.parse({
      requisitionIds: [requisition.requisition.id],
      supplierIds: facts.suppliers,
      respondBy: addDays(2),
    }),
    seedRequest,
  );
  const cementLine = rfq.lines[0]!.requisitionLineId;
  for (const [index, supplierId] of facts.suppliers.entries())
    rfq = await rfqs.recordQuotation(
      owner,
      rfq.rfq.id,
      recordQuotationRequestSchema.parse({
        supplierId,
        reference: "Demo cement quote",
        quotedOn: nairobiDate(),
        validUntil: addDays(30),
        deliveryDays: 1,
        lines: [
          {
            requisitionLineId: cementLine,
            priceUnit: "bag_50kg",
            unitPriceMinor: [79_000, 85_000, 82_000][index] ?? 85_000,
            vatTreatment: "exclusive",
          },
        ],
      }),
      seedRequest,
    );
  // The quarry (an active supplier) quotes lowest and is awarded.
  const cheapest = rfq.quotations.find((quote) => quote.supplier.id === facts.suppliers[0])!;
  let lpo = await rfqs.award(
    owner,
    rfq.rfq.id,
    awardRfqRequestSchema.parse({
      version: rfq.rfq.version,
      quotationId: cheapest.id,
      deliverySiteId: facts.ruiruSite,
      deliveryDate: addDays(1),
      terms: "Deliver to the site store (demo).",
    }),
    seedRequest,
  );
  lpo = await lpos.transition(
    owner,
    lpo.lpo.id,
    "submit",
    { version: lpo.lpo.version },
    seedRequest,
  );
  lpo = await lpos.transition(pm, lpo.lpo.id, "approve", { version: lpo.lpo.version }, seedRequest);
  await app.get(GrnsService).create(
    keeper,
    createGrnRequestSchema.parse({
      id: randomUUID(),
      lpoId: lpo.lpo.id,
      siteId: facts.ruiruSite,
      capturedAt: at(),
      receivedByName: "Grace Wambui (demo)",
      vehicleRegistration: "KCB 456B",
      deliveryNoteNumber: "KH-DN-0042",
      locationError: "unavailable",
      source: "web",
      lines: [{ lpoLineId: lpo.lines[0]!.id, receivedQuantity: "120" }],
    }),
    `seed-stores-grn-${requisition.requisition.id}`,
    seedRequest,
  );

  // 2. The approved BQ baseline (written by the owner, approved by the project manager).
  const items = await seedBq(db, tenantId, facts.ruiru, users);

  // 3. Column bases and the slab priced by the concrete build-up; its material lines mapped.
  const buildups = app.get(BuildupsService);
  for (const lineage of [items[0]!, items[1]!])
    await buildups.link(
      owner,
      facts.ruiru,
      lineage,
      { buildupVersionId: facts.buildupVersion.id },
      seedRequest,
    );
  const mappings = app.get(BuildupMaterialsService);
  const lines = [...facts.buildupVersion.lines].sort((a, b) => a.lineNo - b.lineNo);
  for (const [lineNo, materialId, unit] of [
    [1, facts.cement, "bag_50kg"],
    [2, facts.sand, "t"],
    [3, facts.ballast, "t"],
  ] as const)
    await mappings.map(
      owner,
      facts.buildupId,
      1,
      lines.find((line) => line.lineNo === lineNo)!.id,
      { materialId, unit },
      seedRequest,
    );

  // 4. 12.5 m³ of column bases measured (the slab is not measured yet: its variance is unavailable).
  await app.get(MeasurementsService).record(
    pm,
    facts.ruiru,
    createMeasurementRequestSchema.parse({
      bqItemLineageId: items[0],
      measuredOn: nairobiDate(),
      quantityToDate: "12.5",
      note: "Column bases C1–C10 cast (synthetic)",
    }),
    seedRequest,
  );

  // 5. Issues, a return and wastage. 12.5 m³ needs 85.3125 bags (6.5 × 1.05 × 12.5); 110 issued
  //    and 5 returned is 105, 23.1 % above: the variance alert fires (threshold 10 %).
  const movements = app.get(MovementsService);
  const store = await read((tx) =>
    tx.store.findUniqueOrThrow({
      where: { tenantId_siteId: { tenantId, siteId: facts.ruiruSite } },
    }),
  );
  const issueId = randomUUID();
  const issue = await movements.issue(
    keeper,
    createIssueRequestSchema.parse({
      id: issueId,
      storeId: store.id,
      capturedAt: at(),
      bqItemLineageId: items[0],
      gangId: facts.gangId,
      issuedToName: "Concrete gang leader (demo)",
      notes: STORES_NOTE,
      lines: [
        { materialId: facts.cement, quantity: "110", unit: "bag_50kg" },
        { materialId: facts.sand, quantity: "9", unit: "t" },
        { materialId: facts.ballast, quantity: "8", unit: "t" },
      ],
    }),
    `seed-stores-issue-${issueId}`,
    seedRequest,
  );
  const cementIssueLine = issue.movement.lines.find((line) => line.material.id === facts.cement)!;
  const returnId = randomUUID();
  await movements.return(
    keeper,
    createReturnRequestSchema.parse({
      id: returnId,
      issueId,
      capturedAt: at(),
      notes: "Unused bags brought back (demo)",
      lines: [{ issueLineId: cementIssueLine.id, quantity: "5" }],
    }),
    `seed-stores-return-${returnId}`,
    seedRequest,
  );
  const wastageId = randomUUID();
  await movements.wastage(
    keeper,
    createWastageRequestSchema.parse({
      id: wastageId,
      storeId: store.id,
      capturedAt: at(),
      reason: "weather",
      notes: "Two bags split in the rain (demo)",
      lines: [{ materialId: facts.cement, quantity: "2", unit: "bag_50kg" }],
    }),
    `seed-stores-wastage-${wastageId}`,
    seedRequest,
  );

  // 6. Reorder levels: 13 bags of cement and 2 t of ballast left are low.
  const stores = app.get(StoresService);
  await stores.reorderLevels(
    keeper,
    store.id,
    {
      levels: [
        { materialId: facts.cement, reorderLevel: "20" },
        { materialId: facts.sand, reorderLevel: "1" },
        { materialId: facts.ballast, reorderLevel: "5" },
      ],
    },
    seedRequest,
  );

  // 7. A Kitengela store; 2 t of sand sent and 1.8 t received (disputed), 1 t still in transit.
  const kitengela = await stores.create(
    keeper,
    { siteId: facts.kitengelaSite, storekeeperUserId: users.storekeeperId },
    seedRequest,
  );
  const transfers = app.get(TransfersService);
  const sendSand = (quantity: string) => {
    const id = randomUUID();
    return transfers.dispatch(
      keeper,
      dispatchTransferRequestSchema.parse({
        id,
        fromStoreId: store.id,
        toStoreId: kitengela.store.id,
        capturedAt: at(),
        notes: "Sand for the bungalow footings (demo)",
        lines: [{ materialId: facts.sand, quantity, unit: "t" }],
      }),
      `seed-stores-transfer-${id}`,
      seedRequest,
    );
  };
  const first = await sendSand("2");
  await transfers.receive(
    keeper,
    first.transfer.id,
    receiveTransferRequestSchema.parse({
      capturedAt: at(),
      lines: [
        {
          lineId: first.transfer.lines[0]!.id,
          receivedQuantity: "1.8",
          differenceReason: "Spillage on the Kitengela road (demo)",
        },
      ],
    }),
    `seed-stores-receive-${first.transfer.id}`,
    seedRequest,
  );
  await sendSand("1");

  // 8. A stock take counted and submitted by the storekeeper, waiting for the project manager.
  const takes = app.get(StockTakesService);
  const take = await takes.create(
    keeper,
    {
      storeId: store.id,
      materialIds: [facts.cement, facts.ballast],
      notes: "Month-end count (demo)",
    },
    seedRequest,
  );
  const counted = await takes.count(
    keeper,
    take.stockTake.id,
    recordCountsRequestSchema.parse({
      capturedAt: at(),
      counts: take.stockTake.lines.map((line) => ({
        id: randomUUID(),
        lineId: line.id,
        countedQuantity: line.material.id === facts.cement ? "12" : line.snapshotQuantity,
      })),
    }),
    `seed-stores-count-${take.stockTake.id}`,
    seedRequest,
  );
  await takes.submit(keeper, take.stockTake.id, counted.stockTake.version, seedRequest);

  return summarise(app, owner, true);
}

/** One measured bill of three items, approved by someone other than its writer. */
async function seedBq(
  db: TenantDatabase,
  tenantId: string,
  projectId: string,
  users: SeedUsers,
): Promise<string[]> {
  const priced = BQ_ITEMS.map(([ref, description, unit, quantity, rate]) => ({
    ref,
    description,
    unit,
    quantity,
    rate,
    // quantity × rate × 100, exact for these whole-shilling rates (rounded half-up per line).
    amountMinor: BigInt(quantity) * BigInt(rate) * 100n,
    lineageId: uuidv7(),
  }));
  const subtotal = priced.reduce((total, item) => total + item.amountMinor, 0n);
  const vat = (subtotal * 16n + 50n) / 100n;
  const versionId = uuidv7();
  await db.run({ userId: users.ownerId, tenantId, requestId: "seed" }, async (tx) => {
    const existing = await tx.bq.findUnique({
      where: { tenantId_projectId: { tenantId, projectId } },
    });
    if (existing) return;
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
        billCount: 1,
        itemCount: priced.length,
        createdBy: users.ownerId,
        updatedBy: users.ownerId,
      },
    });
    const billId = uuidv7();
    await tx.bqBill.create({
      data: {
        id: billId,
        tenantId,
        versionId,
        number: "2",
        title: "Substructure (synthetic demo)",
        kind: "measured",
        sortOrder: 0,
        totalMinor: subtotal,
        sourceSheet: "Bill 2",
        lineageId: uuidv7(),
      },
    });
    const sectionId = uuidv7();
    await tx.bqSection.create({
      data: {
        id: sectionId,
        tenantId,
        versionId,
        billId,
        code: "A",
        title: "Concrete and walling (synthetic)",
        sortOrder: 0,
        totalMinor: subtotal,
        lineageId: uuidv7(),
      },
    });
    await tx.bqItem.createMany({
      data: priced.map((item, index) => ({
        id: uuidv7(),
        tenantId,
        versionId,
        billId,
        sectionId,
        lineageId: item.lineageId,
        ref: item.ref,
        description: item.description,
        unit: item.unit,
        unitRaw: item.unit,
        quantity: item.quantity,
        rate: item.rate,
        amountMinor: item.amountMinor,
        amountSource: "computed",
        kind: "measured",
        sortOrder: index,
      })),
    });
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
  return priced.map((item) => item.lineageId);
}

async function summarise(
  app: INestApplicationContext,
  owner: Awaited<ReturnType<typeof seedPrincipal>>,
  created: boolean,
): Promise<StoresSeedSummary> {
  const [stores, movements, transfers, takes, variance] = await Promise.all([
    app.get(StoresService).list(owner, seedRequest),
    app.get(MovementsService).list(owner, { limit: 20 }, seedRequest),
    app.get(TransfersService).list(owner, { limit: 20 }, seedRequest),
    app.get(StockTakesService).list(owner, { limit: 5 }, seedRequest),
    app.get(VarianceService).report(owner, {}, seedRequest),
  ]);
  return {
    created,
    stores: stores.stores.map((store) => store.name),
    movements: movements.movements.map((movement) => movement.number).reverse(),
    transfers: transfers.transfers
      .map((transfer) => `${transfer.number} (${transfer.status})`)
      .reverse(),
    stockTake: takes.stockTakes[0]
      ? `${takes.stockTakes[0].number} (${takes.stockTakes[0].status})`
      : "none",
    varianceAlerts: variance.counts.alert,
    lowStock: stores.lowStock.length,
  };
}
