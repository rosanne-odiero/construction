import { randomBytes, randomUUID } from "node:crypto";
import type { INestApplicationContext } from "@nestjs/common";
import type { Request } from "express";
import { addCalendarDays, nairobiDate, polygonCentre } from "@pm-buddy/domain";
import {
  awardRfqRequestSchema,
  createGrnRequestSchema,
  createRequisitionRequestSchema,
  createRfqRequestSchema,
  recordQuotationRequestSchema,
  recordSettlementRequestSchema,
  submitSupplierInvoiceRequestSchema,
} from "@pm-buddy/validation";
import { PrismaService } from "../infra/prisma.service.js";
import { hashPassword } from "../modules/identity/auth-security.service.js";
import { TenancyService } from "../modules/identity/tenancy.service.js";
import { TenantDatabase } from "../modules/identity/tenant-database.service.js";
import { TenantScope } from "../modules/identity/tenant-scope.service.js";
import { SupplierPortalUsersService } from "../modules/portals/supplier/supplier-portal-users.service.js";
import { SupplierPortalService } from "../modules/portals/supplier/supplier-portal.service.js";
import { GrnsService } from "../modules/procurement/p2p/grns.service.js";
import { InvoicesService } from "../modules/procurement/p2p/invoices.service.js";
import { LposService } from "../modules/procurement/p2p/lpos.service.js";
import { RequisitionsService } from "../modules/procurement/p2p/requisitions.service.js";
import { RfqsService } from "../modules/procurement/p2p/rfqs.service.js";
import { seedPrincipal } from "./demo-procure-to-pay.js";
import { DEMO_SUPPLIERS } from "./demo-procurement.js";

/**
 * D7.2 demo data: a portal user for Mlolongo Quarry (the D5.2 demo supplier) and, on the
 * Kitengela project, a requisition by the storekeeper approved by the project manager, an RFQ to
 * the three demo suppliers at the D5.2 prices (so no price alert), the quarry's LPO approved and
 * acknowledged by the supplier, a delivery with a rejected tonne, one invoice the supplier
 * submitted that the owner approved and finance partly paid, and one submitted invoice waiting
 * for the company's review (7 t of ballast stay to be invoiced in the portal). Every step goes through the real services and database rules
 * (maker-checker, the three-way match, the supplier's restrictions). Synthetic values only.
 */
export const DEMO_SUPPLIER_PORTAL_USER = {
  identifier: "accounts@mlolongo-quarry.example.test",
  displayName: "Achieng Otieno (synthetic)",
} as const;
const DEMO_NOTE = "Demo supplier portal flow (synthetic)";

export type SupplierPortalSeedSummary = {
  created: boolean;
  account: {
    identifier: string;
    displayName: string;
    /** Set when this run created the account or reset its credentials; otherwise unchanged. */
    password: string | null;
    created: boolean;
  };
  supplier: string;
  lpo: string;
  grn: string;
  invoices: { number: string; status: string }[];
};

type SeedUsers = {
  ownerId: string;
  projectManagerId: string;
  storekeeperId: string;
  financeId: string;
};

const seedRequest = { headers: {} } as Request;
const newPassword = () => `Demo-${randomBytes(18).toString("base64url")}`;
/** A minimal one-page PDF standing in for the supplier's invoice document (synthetic). */
const demoPdf = (label: string) =>
  Buffer.from(
    `%PDF-1.4\n% ${label} (synthetic demo invoice)\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
  );

export async function seedSupplierPortal(
  app: INestApplicationContext,
  tenantId: string,
  users: SeedUsers,
  options: { resetCredentials?: boolean } = {},
): Promise<SupplierPortalSeedSummary> {
  const prisma = app.get(PrismaService);
  const db = app.get(TenantDatabase);
  const read = <T>(work: (tx: Parameters<Parameters<TenantDatabase["run"]>[1]>[0]) => Promise<T>) =>
    db.run({ userId: users.ownerId, tenantId, requestId: "seed" }, work);

  // The supplier contact's account (password printed once, like the other demo accounts).
  const existing = await prisma.user.findUnique({
    where: { identifier: DEMO_SUPPLIER_PORTAL_USER.identifier },
  });
  const reset = !existing || options.resetCredentials === true;
  const password = reset ? newPassword() : null;
  const account =
    existing ??
    (await prisma.user.create({
      data: {
        id: randomUUID(),
        identifier: DEMO_SUPPLIER_PORTAL_USER.identifier,
        displayName: DEMO_SUPPLIER_PORTAL_USER.displayName,
        passwordHash: await hashPassword(password!),
        verifiedAt: new Date(),
      },
    }));
  if (existing && password) {
    await prisma.user.update({
      where: { id: account.id },
      data: {
        passwordHash: await hashPassword(password),
        failedLogins: 0,
        lockedUntil: null,
      },
    });
    await prisma.session.updateMany({
      where: { userId: account.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
  const accountSummary = {
    identifier: DEMO_SUPPLIER_PORTAL_USER.identifier,
    displayName: DEMO_SUPPLIER_PORTAL_USER.displayName,
    password,
    created: !existing,
  };

  const quarryId = (
    await read((tx) =>
      tx.supplier.findFirstOrThrow({
        where: { tenantId, legalName: DEMO_SUPPLIERS[0]!.legalName },
      }),
    )
  ).id;
  const bound = await read((tx) =>
    tx.supplierPortalUser.findFirst({
      where: { tenantId, supplierId: quarryId, identifier: DEMO_SUPPLIER_PORTAL_USER.identifier },
    }),
  );
  if (bound) return summarise(read, accountSummary, false);

  const scope = app.get(TenantScope);
  const tenancy = app.get(TenancyService);
  const portalUsers = app.get(SupplierPortalUsersService);
  const portal = app.get(SupplierPortalService);
  const requisitions = app.get(RequisitionsService);
  const rfqs = app.get(RfqsService);
  const lpos = app.get(LposService);
  const grns = app.get(GrnsService);
  const invoices = app.get(InvoicesService);
  const [owner, pm, keeper, finance] = await Promise.all(
    [users.ownerId, users.projectManagerId, users.storekeeperId, users.financeId].map((id) =>
      seedPrincipal(prisma, id, tenantId),
    ),
  );

  // Invited by the owner and accepted by the contact (no message is sent by the seed).
  const invitation = await scope.run(
    owner,
    seedRequest,
    (owned) =>
      portalUsers.inviteInScope(owned, quarryId, {
        identifier: DEMO_SUPPLIER_PORTAL_USER.identifier,
        contactName: "Achieng Otieno, accounts (synthetic)",
      }),
    true,
  );
  await db.run({ userId: account.id, tenantId, requestId: "seed" }, async (tx) => {
    const pending = await tx.supplierPortalUser.findUniqueOrThrow({
      where: { tenantId_id: { tenantId, id: invitation.user.id } },
      select: { invitationId: true },
    });
    await tenancy.redeem(tx, { id: pending.invitationId, tenantId }, account.id, () => undefined);
  });
  const supplierUser = await seedPrincipal(prisma, account.id, tenantId);

  const facts = await read(async (tx) => {
    const project = await tx.project.findUniqueOrThrow({
      where: { tenantId_code: { tenantId, code: "KIT-BNG" } },
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
      steel: await supplier(DEMO_SUPPLIERS[1]!.legalName),
      hardware: await supplier(DEMO_SUPPLIERS[2]!.legalName),
    };
  });
  const today = nairobiDate();

  // Requisition by the storekeeper (21 t of sand, 20 t of ballast), approved by the PM.
  let requisition = await requisitions.create(
    keeper,
    createRequisitionRequestSchema.parse({
      projectId: facts.projectId,
      siteId: facts.siteId,
      neededBy: addCalendarDays(today, 7),
      notes: DEMO_NOTE,
      lines: [
        { materialId: facts.sand, quantity: "21", unit: "t" },
        { materialId: facts.ballast, quantity: "20", unit: "t" },
      ],
    }),
    seedRequest,
  );
  const requisitionId = requisition.requisition.id;
  requisition = await requisitions.transition(
    keeper,
    requisitionId,
    "submit",
    { version: requisition.requisition.version },
    seedRequest,
  );
  await requisitions.transition(
    pm,
    requisitionId,
    "approve",
    { version: requisition.requisition.version },
    seedRequest,
  );

  // RFQ to the three demo suppliers at the D5.2 prices (VAT exclusive).
  let rfq = await rfqs.create(
    owner,
    createRfqRequestSchema.parse({
      requisitionIds: [requisitionId],
      supplierIds: [quarryId, facts.steel, facts.hardware],
      respondBy: addCalendarDays(today, 2),
    }),
    seedRequest,
  );
  const [sandLine, ballastLine] = rfq.lines.map((line) => line.requisitionLineId) as [
    string,
    string,
  ];
  const quotes: [string, [string, number], [string, number]][] = [
    [quarryId, ["trip", 2_800_000], ["t", 220_000]],
    [facts.steel, ["t", 430_000], ["t", 240_000]],
    [facts.hardware, ["t", 420_000], ["t", 230_000]],
  ];
  for (const [supplierId, sand, ballast] of quotes)
    rfq = await rfqs.recordQuotation(
      owner,
      rfq.rfq.id,
      recordQuotationRequestSchema.parse({
        supplierId,
        reference: "Demo quote (portal)",
        quotedOn: today,
        validUntil: addCalendarDays(today, 30),
        deliveryDays: 2,
        lines: [
          {
            requisitionLineId: sandLine,
            priceUnit: sand[0],
            unitPriceMinor: sand[1],
            vatTreatment: "exclusive",
          },
          {
            requisitionLineId: ballastLine,
            priceUnit: ballast[0],
            unitPriceMinor: ballast[1],
            vatTreatment: "exclusive",
          },
        ],
      }),
      seedRequest,
    );
  // LPO: 21 t × 400,000 + 20 t × 220,000 = 12,800,000 minor; VAT 2,048,000; total 14,848,000.
  let lpo = await rfqs.award(
    owner,
    rfq.rfq.id,
    awardRfqRequestSchema.parse({
      version: rfq.rfq.version,
      quotationId: rfq.quotations.find((quote) => quote.supplier.id === quarryId)!.id,
      deliverySiteId: facts.siteId,
      deliveryDate: addCalendarDays(today, 2),
      terms: "Deliver to the Kitengela plot between 08:00 and 16:00; call the storekeeper (demo).",
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
  const [sand, ballast] = lpo.lines as [(typeof lpo.lines)[number], (typeof lpo.lines)[number]];
  await portal.acknowledge(supplierUser, lpo.lpo.id, seedRequest);

  // Delivery: three 7 t trips of sand and 20 t of ballast, 1 t rejected (19 t accepted).
  await grns.create(
    keeper,
    createGrnRequestSchema.parse({
      id: randomUUID(),
      lpoId: lpo.lpo.id,
      capturedAt: new Date().toISOString(),
      receivedByName: "Grace Wambui (demo)",
      vehicleRegistration: "KCZ 456B",
      deliveryNoteNumber: "MQ-DN-6610",
      location: { latitude: facts.centre.lat, longitude: facts.centre.lng, accuracyM: 9 },
      source: "web",
      lines: [
        { lpoLineId: sand.id, unit: "trip", receivedQuantity: "3" },
        {
          lpoLineId: ballast.id,
          receivedQuantity: "20",
          rejectedQuantity: "1",
          rejectionReason: "Mixed with soil (demo)",
        },
      ],
    }),
    `seed-portal-grn-${requisitionId}`,
    seedRequest,
  );

  // Invoice 1 (the supplier): 21 t of sand = 8,400,000; VAT 1,344,000; total 9,744,000.
  // Matched, approved by the owner, partly paid (KES 40,000.00) by finance.
  const submitted = async (
    number: string,
    lines: { lpoLineId: string; quantity: string; unitPriceMinor: number }[],
    totals: [number, number, number],
    etims: string,
  ) => {
    const id = randomUUID();
    const result = await portal.submitInvoice(
      supplierUser,
      submitSupplierInvoiceRequestSchema.parse({
        id,
        lpoId: lpo.lpo.id,
        invoiceNumber: number,
        invoiceDate: today,
        etimsInvoiceNumber: etims,
        subtotalMinor: totals[0],
        vatMinor: totals[1],
        totalMinor: totals[2],
        lines: lines.map((line) => ({ ...line, vatTreatment: "exclusive" })),
      }),
      `seed-portal-invoice-${id}`,
      seedRequest,
    );
    await portal.uploadDocument(
      supplierUser,
      id,
      { buffer: demoPdf(number), originalname: `${number}.pdf`, size: 0 },
      seedRequest,
    );
    return result;
  };
  const first = await submitted(
    "MQ-INV-2001",
    [{ lpoLineId: sand.id, quantity: "21", unitPriceMinor: 400_000 }],
    [8_400_000, 1_344_000, 9_744_000],
    "KRACU0100000001/201",
  );
  const staff = await invoices.get(owner, first.invoice.id, seedRequest);
  const approved = await invoices.approve(
    owner,
    first.invoice.id,
    { version: staff.invoice.version, matchId: staff.match!.id, payoutVersionId: staff.payee!.id },
    seedRequest,
  );
  await invoices.settle(
    finance,
    approved.invoice.id,
    recordSettlementRequestSchema.parse({
      method: "bank_transfer",
      externalReference: "DEMO-FT-0002",
      amountMinor: 4_000_000,
      paidOn: today,
      note: "Demo part payment recorded by hand (no money moved).",
    }),
    `seed-portal-settlement-${first.invoice.id}`,
    seedRequest,
  );
  // Invoice 2 (the supplier): 12 of the 19 t of ballast accepted = 2,640,000; VAT 422,400;
  // total 3,062,400. Matched and waiting for the company's review; 7 t are left to invoice in
  // the portal.
  await submitted(
    "MQ-INV-2002",
    [{ lpoLineId: ballast.id, quantity: "12", unitPriceMinor: 220_000 }],
    [2_640_000, 422_400, 3_062_400],
    "KRACU0100000001/202",
  );
  return summarise(read, accountSummary, true);
}

async function summarise(
  read: <T>(
    work: (tx: Parameters<Parameters<TenantDatabase["run"]>[1]>[0]) => Promise<T>,
  ) => Promise<T>,
  account: SupplierPortalSeedSummary["account"],
  created: boolean,
): Promise<SupplierPortalSeedSummary> {
  return read(async (tx) => {
    const binding = await tx.supplierPortalUser.findFirstOrThrow({
      where: { identifier: DEMO_SUPPLIER_PORTAL_USER.identifier },
      include: { supplier: { select: { code: true, tradingName: true, legalName: true } } },
      orderBy: { invitedAt: "desc" },
    });
    const acknowledgement = await tx.lpoAcknowledgement.findFirstOrThrow({
      where: { supplierId: binding.supplierId },
      include: { lpo: { select: { id: true, number: true } } },
    });
    const grn = await tx.grn.findFirstOrThrow({
      where: { lpoId: acknowledgement.lpo.id },
      orderBy: { number: "asc" },
    });
    const invoices = await tx.supplierInvoice.findMany({
      where: { lpoId: acknowledgement.lpo.id },
      orderBy: { invoiceNumber: "asc" },
      select: { invoiceNumber: true, status: true },
    });
    return {
      created,
      account,
      supplier: `${binding.supplier.code} ${binding.supplier.tradingName ?? binding.supplier.legalName}`,
      lpo: acknowledgement.lpo.number,
      grn: grn.number,
      invoices: invoices.map((invoice) => ({
        number: invoice.invoiceNumber,
        status: invoice.status,
      })),
    };
  });
}
