import { randomUUID } from "node:crypto";
import type { INestApplicationContext } from "@nestjs/common";
import type { Request } from "express";
import { nairobiDate, polygonCentre } from "@pm-buddy/domain";
import {
  awardRfqRequestSchema,
  createGrnRequestSchema,
  createInvoiceRequestSchema,
  createRequisitionRequestSchema,
  createRfqRequestSchema,
  recordQuotationRequestSchema,
  recordSettlementRequestSchema,
} from "@pm-buddy/validation";
import type { Session } from "../generated/prisma/client.js";
import { PrismaService } from "../infra/prisma.service.js";
import type { Principal } from "../modules/identity/auth.service.js";
import { TenantDatabase } from "../modules/identity/tenant-database.service.js";
import { GrnsService } from "../modules/procurement/p2p/grns.service.js";
import { InvoicesService } from "../modules/procurement/p2p/invoices.service.js";
import { LposService } from "../modules/procurement/p2p/lpos.service.js";
import { RequisitionsService } from "../modules/procurement/p2p/requisitions.service.js";
import { RfqsService } from "../modules/procurement/p2p/rfqs.service.js";
import { DEMO_SUPPLIERS } from "./demo-procurement.js";

/**
 * D5.2 demo data on the RUI-HTS project: a requisition by the site agent approved by the project
 * manager, an RFQ to the three demo suppliers with three quotations, the quarry's LPO approved by
 * the project manager, a partial delivery (two 7 t lorry trips of sand and half the ballast), one
 * invoice that matches, is approved by the owner and settled by the finance user, and one invoice
 * for ballast not yet delivered that the three-way match blocks. Every step goes through the real
 * services and database triggers (maker-checker, the match and the payable rules). Synthetic
 * values only; the eTIMS numbers are made up.
 */
const DEMO_NOTE = "Demo procure-to-pay flow (synthetic)";

export type ProcureToPaySeedSummary = {
  created: boolean;
  requisition: string;
  rfq: string;
  lpo: string;
  grn: string;
  invoices: { number: string; status: string }[];
};

type SeedUsers = { ownerId: string; projectManagerId: string; siteAgentId: string; financeId: string };

/**
 * A signed-in principal for the development seed only: MFA counts as verified just now, so the
 * seed can take steps that need a step-up. Permissions, maker-checker and every database rule
 * still apply (the seed never bypasses the services or the triggers).
 */
async function seedPrincipal(prisma: PrismaService, userId: string, tenantId: string): Promise<Principal> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const now = new Date();
  return {
    user: { ...user, mfaEnabled: true },
    session: {
      id: randomUUID(),
      userId,
      activeTenantId: tenantId,
      authTime: now,
      mfaVerifiedAt: now,
    } as unknown as Session,
    mfaRequired: false,
    passkeys: 0,
  };
}

const seedRequest = { headers: {} } as Request;
const addDays = (days: number) => {
  const date = new Date(`${nairobiDate()}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

export async function seedProcureToPay(
  app: INestApplicationContext,
  tenantId: string,
  users: SeedUsers,
): Promise<ProcureToPaySeedSummary> {
  const prisma = app.get(PrismaService);
  const db = app.get(TenantDatabase);
  const requisitions = app.get(RequisitionsService);
  const rfqs = app.get(RfqsService);
  const lpos = app.get(LposService);
  const grns = app.get(GrnsService);
  const invoices = app.get(InvoicesService);
  const read = <T>(work: (tx: Parameters<Parameters<TenantDatabase["run"]>[1]>[0]) => Promise<T>) =>
    db.run({ userId: users.ownerId, tenantId, requestId: "seed" }, work);

  const existing = await read((tx) =>
    tx.requisition.findFirst({ where: { tenantId, notes: DEMO_NOTE } }),
  );
  if (existing) return summarise(read, existing.id, false);

  const [owner, pm, agent, finance] = await Promise.all(
    [users.ownerId, users.projectManagerId, users.siteAgentId, users.financeId].map((id) =>
      seedPrincipal(prisma, id, tenantId),
    ),
  );
  const facts = await read(async (tx) => {
    const project = await tx.project.findUniqueOrThrow({
      where: { tenantId_code: { tenantId, code: "RUI-HTS" } },
    });
    const site = await tx.site.findFirstOrThrow({
      where: { tenantId, projectId: project.id },
      orderBy: { name: "asc" },
    });
    const geofence = await tx.siteGeofence.findFirstOrThrow({
      where: { tenantId, siteId: site.id },
      orderBy: { version: "desc" },
    });
    const material = async (name: string) =>
      (await tx.material.findFirstOrThrow({ where: { tenantId, name } })).id;
    const supplier = async (legalName: string) =>
      (await tx.supplier.findFirstOrThrow({ where: { tenantId, legalName } })).id;
    const centre =
      geofence.kind === "radius"
        ? { lat: geofence.centerLat!.toNumber(), lng: geofence.centerLng!.toNumber() }
        : polygonCentre(geofence.polygon as { lat: number; lng: number }[]);
    return {
      projectId: project.id,
      siteId: site.id,
      centre,
      sand: await material("River sand"),
      ballast: await material("Ballast 20 mm"),
      quarry: await supplier(DEMO_SUPPLIERS[0]!.legalName),
      steel: await supplier(DEMO_SUPPLIERS[1]!.legalName),
      hardware: await supplier(DEMO_SUPPLIERS[2]!.legalName),
    };
  });

  // Requisition: 14 t of sand and 20 t of ballast, approved by the project manager.
  let requisition = await requisitions.create(
    agent,
    createRequisitionRequestSchema.parse({
      projectId: facts.projectId,
      siteId: facts.siteId,
      neededBy: addDays(7),
      notes: DEMO_NOTE,
      lines: [
        { materialId: facts.sand, quantity: "14", unit: "t" },
        { materialId: facts.ballast, quantity: "20", unit: "t" },
      ],
    }),
    seedRequest,
  );
  const id = requisition.requisition.id;
  requisition = await requisitions.transition(agent, id, "submit", { version: requisition.requisition.version }, seedRequest);
  await requisitions.transition(pm, id, "approve", { version: requisition.requisition.version }, seedRequest);

  // RFQ to the three demo suppliers; three complete quotations (VAT exclusive).
  let rfq = await rfqs.create(
    owner,
    createRfqRequestSchema.parse({
      requisitionIds: [id],
      supplierIds: [facts.quarry, facts.steel, facts.hardware],
      respondBy: addDays(2),
    }),
    seedRequest,
  );
  const [sandLine, ballastLine] = rfq.lines.map((line) => line.requisitionLineId) as [string, string];
  // The quarry quotes sand per 7 t lorry trip: KES 28,000 per trip = KES 4,000 per tonne.
  const quotes: [string, [string, number], [string, number]][] = [
    [facts.quarry, ["trip", 2_800_000], ["t", 220_000]],
    [facts.steel, ["t", 430_000], ["t", 240_000]],
    [facts.hardware, ["t", 420_000], ["t", 230_000]],
  ];
  for (const [supplierId, sand, ballast] of quotes)
    rfq = await rfqs.recordQuotation(
      owner,
      rfq.rfq.id,
      recordQuotationRequestSchema.parse({
        supplierId,
        reference: "Demo quote",
        quotedOn: nairobiDate(),
        validUntil: addDays(30),
        deliveryDays: 2,
        lines: [
          { requisitionLineId: sandLine, priceUnit: sand[0], unitPriceMinor: sand[1], vatTreatment: "exclusive" },
          { requisitionLineId: ballastLine, priceUnit: ballast[0], unitPriceMinor: ballast[1], vatTreatment: "exclusive" },
        ],
      }),
      seedRequest,
    );
  const quarryQuote = rfq.quotations.find((quote) => quote.supplier.id === facts.quarry)!;
  // LPO: 14 t × 400,000 + 20 t × 220,000 = 10,000,000 minor; VAT 1,600,000; total 11,600,000.
  let lpo = await rfqs.award(
    owner,
    rfq.rfq.id,
    awardRfqRequestSchema.parse({
      version: rfq.rfq.version,
      quotationId: quarryQuote.id,
      deliverySiteId: facts.siteId,
      deliveryDate: addDays(3),
      terms: "Deliver to the site gate between 08:00 and 16:00 (demo).",
    }),
    seedRequest,
  );
  lpo = await lpos.transition(owner, lpo.lpo.id, "submit", { version: lpo.lpo.version }, seedRequest);
  lpo = await lpos.transition(pm, lpo.lpo.id, "approve", { version: lpo.lpo.version }, seedRequest);
  const [sand, ballast] = lpo.lines as [(typeof lpo.lines)[number], (typeof lpo.lines)[number]];

  // A partial delivery at the site: two lorry trips of sand (2 × 7 t) and 10 t of ballast.
  await grns.create(
    agent,
    createGrnRequestSchema.parse({
      id: randomUUID(),
      lpoId: lpo.lpo.id,
      capturedAt: new Date().toISOString(),
      receivedByName: "Kevin Kiprono (demo)",
      vehicleRegistration: "KDA 123A",
      deliveryNoteNumber: "MQ-DN-5521",
      location: { latitude: facts.centre.lat, longitude: facts.centre.lng, accuracyM: 8 },
      source: "web",
      lines: [
        { lpoLineId: sand.id, unit: "trip", receivedQuantity: "2" },
        { lpoLineId: ballast.id, receivedQuantity: "10" },
      ],
    }),
    `seed-grn-${id}`,
    seedRequest,
  );

  // Invoice 1 bills what was received: 14 t × 400,000 + 10 t × 220,000 = 7,800,000; VAT
  // 1,248,000; total 9,048,000. It matches, the owner approves it and finance settles it.
  let first = await invoices.create(
    finance,
    createInvoiceRequestSchema.parse({
      lpoId: lpo.lpo.id,
      invoiceNumber: "MQ-INV-1001",
      invoiceDate: nairobiDate(),
      etimsInvoiceNumber: "KRACU0100000001/101",
      subtotalMinor: 7_800_000,
      vatMinor: 1_248_000,
      totalMinor: 9_048_000,
      lines: [
        { lpoLineId: sand.id, quantity: "14", unitPriceMinor: 400_000, vatTreatment: "exclusive" },
        { lpoLineId: ballast.id, quantity: "10", unitPriceMinor: 220_000, vatTreatment: "exclusive" },
      ],
    }),
    seedRequest,
  );
  first = await invoices.submit(finance, first.invoice.id, { version: first.invoice.version }, seedRequest);
  first = await invoices.approve(
    owner,
    first.invoice.id,
    { version: first.invoice.version, matchId: first.match!.id, payoutVersionId: first.payee!.id },
    seedRequest,
  );
  await invoices.settle(
    finance,
    first.invoice.id,
    recordSettlementRequestSchema.parse({
      method: "bank_transfer",
      externalReference: "DEMO-FT-0001",
      amountMinor: 9_048_000,
      paidOn: nairobiDate(),
      note: "Demo settlement recorded by hand (no money moved).",
    }),
    `seed-settlement-${first.invoice.id}`,
    seedRequest,
  );

  // Invoice 2 bills the other 10 t of ballast before it arrived: the match blocks it.
  const second = await invoices.create(
    finance,
    createInvoiceRequestSchema.parse({
      lpoId: lpo.lpo.id,
      invoiceNumber: "MQ-INV-1002",
      invoiceDate: nairobiDate(),
      etimsInvoiceNumber: "KRACU0100000001/102",
      subtotalMinor: 2_200_000,
      vatMinor: 352_000,
      totalMinor: 2_552_000,
      lines: [{ lpoLineId: ballast.id, quantity: "10", unitPriceMinor: 220_000, vatTreatment: "exclusive" }],
    }),
    seedRequest,
  );
  await invoices.submit(finance, second.invoice.id, { version: second.invoice.version }, seedRequest);
  return summarise(read, id, true);
}

async function summarise(
  read: <T>(work: (tx: Parameters<Parameters<TenantDatabase["run"]>[1]>[0]) => Promise<T>) => Promise<T>,
  requisitionId: string,
  created: boolean,
): Promise<ProcureToPaySeedSummary> {
  return read(async (tx) => {
    const requisition = await tx.requisition.findFirstOrThrow({ where: { id: requisitionId } });
    const link = await tx.rfqRequisition.findFirstOrThrow({
      where: { requisitionId },
      include: { rfq: true },
    });
    const lpo = await tx.lpo.findFirstOrThrow({
      where: { rfqId: link.rfqId, status: { not: "cancelled" } },
    });
    const grn = await tx.grn.findFirstOrThrow({ where: { lpoId: lpo.id }, orderBy: { number: "asc" } });
    const invoices = await tx.supplierInvoice.findMany({
      where: { lpoId: lpo.id },
      orderBy: { invoiceNumber: "asc" },
      select: { invoiceNumber: true, status: true },
    });
    return {
      created,
      requisition: requisition.number,
      rfq: link.rfq.number,
      lpo: lpo.number,
      grn: grn.number,
      invoices: invoices.map((invoice) => ({ number: invoice.invoiceNumber, status: invoice.status })),
    };
  });
}
