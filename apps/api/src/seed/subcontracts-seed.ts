import type { INestApplicationContext } from "@nestjs/common";
import type { Request } from "express";
import { addCalendarDays, nairobiDate } from "@pm-buddy/domain";
import {
  addSubcontractLineRequestSchema,
  clientDecisionRequestSchema,
  createInstructionRequestSchema,
  createMeasurementRequestSchema,
  createPieceRateJobRequestSchema,
  createSubcontractAdvanceRequestSchema,
  createSubcontractCertificateRequestSchema,
  createSubcontractRequestSchema,
  createSupplierRequestSchema,
  createVariationRequestSchema,
  matchSubcontractInvoiceRequestSchema,
  paySubcontractAdvanceRequestSchema,
  recordJobOutputRequestSchema,
  recordSubcontractPaymentRequestSchema,
  saveVariationLinesRequestSchema,
  sendVariationToClientRequestSchema,
  setSubcontractClaimsRequestSchema,
  type CreateSubcontractRequest,
  type SubcontractDetail,
} from "@pm-buddy/validation";
import { PrismaService } from "../infra/prisma.service.js";
import { InstructionsService } from "../modules/bq/instructions.service.js";
import { VariationsService } from "../modules/bq/variations.service.js";
import { TenantDatabase } from "../modules/identity/tenant-database.service.js";
import { PayrollInputsService } from "../modules/payroll/inputs.service.js";
import { PieceRateJobsService } from "../modules/payroll/piece-rate-jobs.service.js";
import { SuppliersService } from "../modules/procurement/suppliers.service.js";
import { MeasurementsService } from "../modules/progress/measurements/measurements.service.js";
import { SubcontractCertificatesService } from "../modules/subcontracts/subcontract-certificates.service.js";
import { ClientPortalService } from "../modules/portals/client/client-portal.service.js";
import { ClientVariationsService } from "../modules/portals/client/client-variations.service.js";
import { SubcontractsService } from "../modules/subcontracts/subcontracts.service.js";
import { DEMO_CLIENT_USER } from "./demo-client-portal.js";
import { seedPrincipal } from "./demo-procure-to-pay.js";

/**
 * D6.3 part B demo data on RUI-HTS (synthetic), through the real services and database triggers:
 * - BQ variation VO for instruction AI-002 adding D internal plaster (450 m² @ 350) and E aluminium
 *   windows (36 m² @ 9,500), prepared by the project manager and approved by the owner;
 * - two suppliers flagged as subcontractors (decision D-140);
 * - SC-0001 labour-only plastering (D 450 m² @ 280; retention 5 % limited to 5 %; advance
 *   20,000.00 recovered at 20 %; WHT 3 %) and SC-0002 supply-and-fix windows (E 36 m² @ 8,200,
 *   VAT 16 %; retention 10 % limited to 5 %), both approved by the owner and active;
 * - ADV-01 on SC-0001 asked for by the project manager, approved by finance, paid by the owner;
 * - approved measurements (D 200 m², E 12 m²); SCC-0001 on SC-0001 certified by finance (work
 *   56,000.00, retention 2,800.00, recovery 11,200.00, due 42,000.00, WHT 1,260.00, payable
 *   40,740.00) with a part payment and the subcontractor's invoice matched; a draft certificate on
 *   SC-0002 (E 12 m²);
 * - piece-rate job PRJ-0001 for Gang B on C (walling) at KES 150/m², 100 m² agreed, approved by
 *   finance, with 96 m² of output approved against 90 m² measured, so the reconciliation flags
 *   piece-rate pay above measured quantities.
 * Idempotent and resumable: every step is skipped once done.
 */
export type SubcontractsSeedSummary = {
  created: boolean;
  variation: string | null;
  subcontracts: { code: string; status: string }[];
  certificates: { code: string; status: string }[];
  advances: number;
  pieceRateJobs: { code: string; status: string }[];
  flaggedItems: number;
};

type SeedUsers = {
  ownerId: string;
  projectManagerId: string;
  siteAgentId: string;
  financeId: string;
};

const seedRequest = { headers: {} } as Request;
const VARIATION_TITLE = "Plastering and aluminium windows (synthetic)";
const SUPPLIERS = {
  plaster: {
    legalName: "Kamau Plastering Works Ltd (synthetic)",
    tradingName: "Kamau Plastering",
    kraPin: "P000000011Z",
  },
  windows: {
    legalName: "Nyali Aluminium and Glass Ltd (synthetic)",
    tradingName: "Nyali Aluminium",
    kraPin: "P000000012Z",
  },
} as const;
const PLASTER_TITLE = "Internal plastering (labour only)";
const WINDOWS_TITLE = "Aluminium windows (supply and fix)";

export async function seedSubcontracts(
  app: INestApplicationContext,
  tenantId: string,
  users: SeedUsers,
  /** The demo client's sign-in (namespaced for a copy of the demo company). */
  options: { clientIdentifier?: string } = {},
): Promise<SubcontractsSeedSummary> {
  const prisma = app.get(PrismaService);
  const db = app.get(TenantDatabase);
  const read = <T>(work: (tx: Parameters<Parameters<TenantDatabase["run"]>[1]>[0]) => Promise<T>) =>
    db.run({ userId: users.ownerId, tenantId, requestId: "seed" }, work);
  const [owner, pm, agent, finance] = await Promise.all(
    [users.ownerId, users.projectManagerId, users.siteAgentId, users.financeId].map((id) =>
      seedPrincipal(prisma, id, tenantId),
    ),
  );
  const today = nairobiDate();
  const day = (offset: number) => addCalendarDays(today, offset);
  const subcontracts = app.get(SubcontractsService);
  const certificates = app.get(SubcontractCertificatesService);
  const jobs = app.get(PieceRateJobsService);
  const inputs = app.get(PayrollInputsService);
  const measurements = app.get(MeasurementsService);
  let created = false;

  const facts = await read(async (tx) => {
    const project = await tx.project.findUniqueOrThrow({
      where: { tenantId_code: { tenantId, code: "RUI-HTS" } },
    });
    const photo = await tx.sitePhoto.findFirst({
      where: { tenantId, projectId: project.id, purpose: "general" },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    const gang = await tx.gang.findFirst({
      where: { tenantId, projectId: project.id, name: { startsWith: "Gang B" } },
      select: { id: true },
    });
    return { projectId: project.id, photoId: photo?.id ?? null, gangId: gang?.id ?? null };
  });
  const { projectId } = facts;
  const itemsInForce = () =>
    read(async (tx) => {
      const version = await tx.bqVersion.findFirstOrThrow({
        where: { tenantId, projectId, status: "approved" },
        orderBy: { versionNo: "desc" },
        include: { bills: { orderBy: { sortOrder: "asc" }, take: 1 } },
      });
      const items = await tx.bqItem.findMany({ where: { tenantId, versionId: version.id } });
      return {
        bill: version.bills[0]!.lineageId,
        items: Object.fromEntries(items.map((item) => [item.ref ?? item.id, item.lineageId])),
      };
    });

  // 1. The BQ variation adding the plaster and window items (instruction AI-002).
  const variation = await addItems();
  const { items } = await itemsInForce();

  // 2. Subcontractors: D5.1 suppliers flagged as such.
  const supplierIds: Record<keyof typeof SUPPLIERS, string> = { plaster: "", windows: "" };
  for (const key of ["plaster", "windows"] as const) {
    const demo = SUPPLIERS[key];
    const existing = await read((tx) =>
      tx.supplier.findFirst({ where: { tenantId, legalName: demo.legalName } }),
    );
    supplierIds[key] =
      existing?.id ??
      (
        await app.get(SuppliersService).create(
          owner,
          createSupplierRequestSchema.parse({
            ...demo,
            etimsStatus: "registered",
            etimsCheckedOn: day(-30),
            creditDays: 14,
            isSubcontractor: true,
            notes: "Synthetic demo subcontractor.",
          }),
          seedRequest,
        )
      ).supplier.id;
  }

  // 3. The two subcontracts, approved by the owner and active.
  const sc1 = await subcontract(
    {
      supplierId: supplierIds.plaster,
      kind: "labour_only",
      title: PLASTER_TITLE,
      scope: "Internal plaster to block walls, all floors, labour only (synthetic).",
      startDate: day(-30),
      endDate: day(120),
      retentionPercent: "5",
      retentionLimitPercent: "5",
      vatPercent: "0",
      whtPercent: "3",
      advanceLimitMinor: 2_000_000,
      advanceRecoveryPercent: "20",
      paymentTermsDays: 14,
      paymentTermsNote: "Paid fortnightly against certified work (synthetic).",
    },
    { bqItemLineageId: items["D"]!, quantity: "450", rateMinor: 28_000, vatTreatment: "standard" },
  );
  const sc2 = await subcontract(
    {
      supplierId: supplierIds.windows,
      kind: "supply_and_fix",
      title: WINDOWS_TITLE,
      scope: "Supply, fabricate and fix powder-coated casement windows (synthetic).",
      startDate: day(-30),
      endDate: day(150),
      retentionPercent: "10",
      retentionLimitPercent: "5",
      vatPercent: "16",
      whtPercent: "0",
      paymentTermsDays: 30,
    },
    { bqItemLineageId: items["E"]!, quantity: "36", rateMinor: 820_000, vatTreatment: "standard" },
  );

  // 4. The plasterer's advance: asked for by the PM, approved by finance, paid by the owner.
  let detail = (await subcontracts.get(owner, sc1.id, seedRequest)).subcontract;
  let advance = detail.advances[0];
  if (!advance) {
    detail = (
      await subcontracts.requestAdvance(
        pm,
        sc1.id,
        createSubcontractAdvanceRequestSchema.parse({
          amountMinor: 2_000_000,
          reason: "Mobilisation advance for scaffolding and tools (synthetic)",
        }),
        seedRequest,
      )
    ).subcontract;
    advance = detail.advances[0]!;
    created = true;
  }
  if (advance.status === "requested")
    advance = (
      await subcontracts.decideAdvance(
        finance,
        advance.id,
        "approve",
        { version: advance.version },
        seedRequest,
      )
    ).subcontract.advances[0]!;
  if (advance.status === "approved")
    await subcontracts.payAdvance(
      owner,
      advance.id,
      paySubcontractAdvanceRequestSchema.parse({
        version: advance.version,
        paidOn: day(-20),
        method: "bank_transfer",
        reference: "EFT-SC1-ADV-01",
      }),
      seedRequest,
    );

  // 5. Approved measurements of the new items (site agent, approved by the project manager).
  for (const [ref, quantity, measuredOn] of [
    ["D", "200", day(-9)],
    ["E", "12", day(-4)],
  ] as const) {
    const lineage = items[ref]!;
    const done = await read((tx) =>
      tx.progressMeasurement.count({ where: { tenantId, projectId, itemLineageId: lineage } }),
    );
    if (done || !facts.photoId) continue;
    const measurement = (
      await measurements.record(
        agent,
        projectId,
        createMeasurementRequestSchema.parse({
          bqItemLineageId: lineage,
          measuredOn,
          quantityToDate: quantity,
          photoIds: [facts.photoId],
        }),
        seedRequest,
      )
    ).measurement;
    await measurements.decide(pm, projectId, measurement.id, "approved", null, seedRequest);
  }

  // 6. SCC-0001 on SC-0001: prepared by the PM, certified by finance, part paid by the owner,
  // with the subcontractor's tax invoice matched to it.
  detail = (await subcontracts.get(owner, sc1.id, seedRequest)).subcontract;
  let first = detail.certificates.find((row) => row.status !== "cancelled");
  if (!first) {
    const draft = (
      await certificates.create(
        pm,
        sc1.id,
        createSubcontractCertificateRequestSchema.parse({ valuationDate: day(-7) }),
        seedRequest,
      )
    ).certificate;
    first = { ...draft };
    created = true;
  }
  let scc1 = (await certificates.get(owner, first.id, seedRequest)).certificate;
  if (scc1.status === "draft") {
    if (!scc1.lines.some((line) => line.quantityToDate !== line.previousQuantity))
      scc1 = (
        await certificates.setClaims(
          pm,
          scc1.id,
          setSubcontractClaimsRequestSchema.parse({
            version: scc1.version,
            claims: [{ lineId: scc1.lines[0]!.lineId, quantityToDate: "200" }],
          }),
          seedRequest,
        )
      ).certificate;
    scc1 = (await certificates.submit(pm, scc1.id, scc1.version, seedRequest)).certificate;
  }
  if (scc1.status === "submitted")
    scc1 = (
      await certificates.certify(
        finance,
        scc1.id,
        { version: scc1.version, digest: scc1.digest! },
        seedRequest,
      )
    ).certificate;
  if (scc1.status === "certified" && !scc1.payments.length)
    scc1 = (
      await certificates.pay(
        owner,
        scc1.id,
        recordSubcontractPaymentRequestSchema.parse({
          amountMinor: 2_000_000,
          paidOn: day(-2),
          method: "bank_transfer",
          reference: "EFT-SC1-SCC1-01",
        }),
        "seed-subcontract-scc1-payment-1",
        seedRequest,
      )
    ).certificate;
  if (scc1.status === "certified" && !scc1.invoice)
    await certificates.matchInvoice(
      finance,
      scc1.id,
      matchSubcontractInvoiceRequestSchema.parse({
        invoiceNumber: "KPW-INV-014",
        invoiceDate: day(-6),
        etimsNumber: "KRACU0100000014",
      }),
      seedRequest,
    );

  // 7. A draft certificate on SC-0002 (12 m² of windows measured).
  detail = (await subcontracts.get(owner, sc2.id, seedRequest)).subcontract;
  if (!detail.certificates.some((row) => row.status !== "cancelled")) {
    const draft = (
      await certificates.create(
        pm,
        sc2.id,
        createSubcontractCertificateRequestSchema.parse({ valuationDate: today }),
        seedRequest,
      )
    ).certificate;
    await certificates.setClaims(
      pm,
      draft.id,
      setSubcontractClaimsRequestSchema.parse({
        version: draft.version,
        claims: [{ lineId: draft.lines[0]!.lineId, quantityToDate: "12" }],
      }),
      seedRequest,
    );
    created = true;
  }

  // 8. The piece-rate job for walling with output paid above the measured quantity.
  if (facts.gangId) await pieceRate(items["C"]!, facts.gangId);

  return summarise(variation);

  // ---------------------------------------------------------------------------------------------

  async function addItems(): Promise<string | null> {
    const variations = app.get(VariationsService);
    const existing = await read((tx) =>
      tx.variationOrder.findFirst({ where: { tenantId, projectId, title: VARIATION_TITLE } }),
    );
    let current = existing
      ? (await variations.get(owner, projectId, existing.id, seedRequest)).variation
      : null;
    if (!current) {
      const found = await read((tx) =>
        tx.instruction.findFirst({ where: { tenantId, projectId, number: "AI-002" } }),
      );
      const instructionId =
        found?.id ??
        (
          await app.get(InstructionsService).create(
            pm,
            projectId,
            createInstructionRequestSchema.parse({
              number: "AI-002",
              issuedOn: day(-40),
              issuerName: "Arch. W. Njeri (synthetic)",
              issuerRole: "architect",
              subject: "Add internal plaster and aluminium windows to the contract",
              description: "Finishes and windows instructed by the client's architect (synthetic).",
            }),
            seedRequest,
          )
        ).instruction.id;
      current = (
        await variations.create(
          pm,
          projectId,
          createVariationRequestSchema.parse({
            instructionId,
            title: VARIATION_TITLE,
            description: "Adds the finishes let to subcontractors (synthetic).",
          }),
          seedRequest,
        )
      ).variation;
      created = true;
    }
    if (current.status === "draft") {
      if (!current.lines.length) {
        const { bill } = await itemsInForce();
        current = (
          await variations.saveLines(
            pm,
            projectId,
            current.id,
            saveVariationLinesRequestSchema.parse({
              version: current.version,
              lines: [
                {
                  action: "add",
                  billLineageId: bill,
                  newSection: { code: "F", title: "Finishes and windows (AI-002)" },
                  ref: "D",
                  description: "Internal plaster 12 mm to block walls, all floors (synthetic)",
                  unit: "m2",
                  kind: "measured",
                  quantity: "450",
                  rate: "350",
                },
                {
                  action: "add",
                  billLineageId: bill,
                  newSection: { code: "F", title: "Finishes and windows (AI-002)" },
                  ref: "E",
                  description: "Aluminium casement windows, powder-coated, glazed (synthetic)",
                  unit: "m2",
                  kind: "measured",
                  quantity: "36",
                  rate: "9500",
                },
              ],
            }),
            seedRequest,
          )
        ).variation;
      }
      current = (
        await variations.submit(
          pm,
          projectId,
          current.id,
          { version: current.version },
          seedRequest,
        )
      ).variation;
    }
    if (current.status === "submitted") {
      await clientApproves(current);
      current = (await variations.get(owner, projectId, current.id, seedRequest)).variation;
      current = (
        await variations.approve(
          owner,
          projectId,
          current.id,
          { version: current.version, snapshotDigest: current.snapshot!.digest },
          seedRequest,
        )
      ).variation;
    }
    return current.number;
  }

  /**
   * A database seeded with the client portal (D7.1) before this seed already has RUI-HTS's client
   * terms, so internal approval waits for the client (rule D-134): the variation is sent to the
   * demo client, who approves it on the view they were sent. A fresh seed runs this before the
   * client terms exist, and nothing is sent.
   */
  async function clientApproves(variation: {
    id: string;
    version: number;
    snapshot: { digest: string } | null;
  }) {
    const sending = app.get(ClientVariationsService);
    let view = await sending.view(pm, projectId, variation.id, seedRequest);
    if (!view.approvalRequired) return;
    let request = view.requests.find((row) => row.state === "awaiting_decision");
    if (!request) {
      view = await sending.send(
        pm,
        projectId,
        variation.id,
        sendVariationToClientRequestSchema.parse({
          version: variation.version,
          snapshotDigest: variation.snapshot!.digest,
          message: "Please approve the plaster and windows instructed under AI-002 (synthetic).",
        }),
        seedRequest,
      );
      request = view.requests.find((row) => row.state === "awaiting_decision")!;
    }
    const clientUser = await prisma.user.findUniqueOrThrow({
      where: { identifier: options.clientIdentifier ?? DEMO_CLIENT_USER.identifier },
      select: { id: true },
    });
    await app.get(ClientPortalService).decide(
      await seedPrincipal(prisma, clientUser.id, tenantId),
      projectId,
      request.id,
      clientDecisionRequestSchema.parse({
        decision: "approved",
        clientDigest: request.clientDigest,
      }),
      seedRequest,
    );
  }

  async function subcontract(
    input: CreateSubcontractRequest,
    line: {
      bqItemLineageId: string;
      quantity: string;
      rateMinor: number;
      vatTreatment: "standard";
    },
  ): Promise<SubcontractDetail> {
    const found = await read((tx) =>
      tx.subcontract.findFirst({
        where: { tenantId, projectId, title: input.title, status: { not: "cancelled" } },
      }),
    );
    let current = found
      ? (await subcontracts.get(owner, found.id, seedRequest)).subcontract
      : (
          await subcontracts.create(
            pm,
            projectId,
            createSubcontractRequestSchema.parse(input),
            seedRequest,
          )
        ).subcontract;
    if (!found) created = true;
    if (current.status === "draft") {
      if (!current.lines.length)
        current = (
          await subcontracts.addLine(
            pm,
            current.id,
            addSubcontractLineRequestSchema.parse({ version: current.version, ...line }),
            seedRequest,
          )
        ).subcontract;
      current = (
        await subcontracts.transition(
          pm,
          current.id,
          "submit",
          { version: current.version },
          seedRequest,
        )
      ).subcontract;
    }
    if (current.status === "submitted")
      current = (
        await subcontracts.transition(
          owner,
          current.id,
          "approve",
          { version: current.version, digest: current.digest! },
          seedRequest,
        )
      ).subcontract;
    if (current.status === "approved")
      current = (
        await subcontracts.transition(
          pm,
          current.id,
          "activate",
          { version: current.version },
          seedRequest,
        )
      ).subcontract;
    return current;
  }

  async function pieceRate(lineage: string, gangId: string) {
    const existing = await read((tx) =>
      tx.pieceRateJob.findFirst({
        where: { tenantId, projectId, bqItemLineageId: lineage, gangId },
      }),
    );
    let view = existing
      ? await jobs.get(owner, existing.id, seedRequest)
      : await jobs.create(
          pm,
          projectId,
          createPieceRateJobRequestSchema.parse({
            bqItemLineageId: lineage,
            gangId,
            description: "Walling 200 mm (blockwork), first floor (synthetic)",
            unit: "m2",
            rateMinor: 15_000,
            agreedQuantity: "100",
            startDate: day(-14),
            endDate: day(14),
          }),
          seedRequest,
        );
    if (!existing) created = true;
    if (view.job.status === "pending")
      view = await jobs.decide(
        finance,
        view.job.id,
        "approve",
        { version: view.job.version },
        seedRequest,
      );
    if (view.job.status !== "approved") return;
    if (!view.outputs.length)
      for (const [workDate, quantity] of [
        [day(-6), "40"],
        [day(-4), "30"],
        [day(-2), "26"],
      ] as const)
        view = await jobs.recordOutput(
          agent,
          view.job.id,
          recordJobOutputRequestSchema.parse({ workDate, quantity }),
          seedRequest,
        );
    for (const output of view.outputs.filter((row) => row.status === "pending"))
      await inputs.approveOutput(pm, output.id, { version: output.version }, seedRequest);
  }

  async function summarise(variationNumber: string | null): Promise<SubcontractsSeedSummary> {
    const flagged = (await jobs.reconciliation(owner, projectId, seedRequest)).flagged;
    return read(async (tx) => {
      const rows = await tx.subcontract.findMany({
        where: { tenantId, projectId },
        orderBy: { number: "asc" },
        select: { number: true, status: true },
      });
      const certs = await tx.subcontractCertificate.findMany({
        where: { tenantId, projectId },
        orderBy: [{ subcontractId: "asc" }, { number: "asc" }],
        select: { number: true, certificateNumber: true, status: true },
      });
      const jobRows = await tx.pieceRateJob.findMany({
        where: { tenantId, projectId },
        orderBy: { number: "asc" },
        select: { number: true, status: true },
      });
      const pad = (prefix: string, value: number) => `${prefix}-${String(value).padStart(4, "0")}`;
      return {
        created,
        variation: variationNumber,
        subcontracts: rows.map((row) => ({ code: pad("SC", row.number), status: row.status })),
        certificates: certs.map((row) => ({
          code: row.certificateNumber ? pad("SCC", row.certificateNumber) : pad("SCV", row.number),
          status: row.status,
        })),
        advances: await tx.subcontractAdvance.count({ where: { tenantId, projectId } }),
        pieceRateJobs: jobRows.map((row) => ({ code: pad("PRJ", row.number), status: row.status })),
        flaggedItems: flagged,
      };
    });
  }
}
