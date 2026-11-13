import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { randomUUID } from "node:crypto";
import request from "supertest";
import type { App } from "supertest/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { nairobiDate } from "@pm-buddy/domain";
import {
  grnResponseSchema,
  inboxResponseSchema,
  invoiceDetailResponseSchema,
  lpoDetailResponseSchema,
  materialsResponseSchema,
  procurementDocumentResponseSchema,
  projectResponseSchema,
  receivableLposResponseSchema,
  requisitionDetailResponseSchema,
  requisitionsResponseSchema,
  rfqDetailResponseSchema,
  siteResponseSchema,
  supplierDetailResponseSchema,
  type InvoiceDetailResponse,
  type LpoDetailResponse,
  type RfqDetailResponse,
} from "@pm-buddy/validation";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { PrismaService } from "../src/infra/prisma.service.js";
import { AuthSecurity } from "../src/modules/identity/auth-security.service.js";
import { TenantDatabase } from "../src/modules/identity/tenant-database.service.js";
import { Browser, notifications } from "./support.js";

/**
 * D5.2 procure-to-pay end to end under the real runtime role (pmb_app, forced RLS): requisition →
 * RFQ with three quotations and the comparison matrix → LPO → GRNs (idempotent, geofenced) →
 * supplier invoices with eTIMS → the three-way match → approval binding the verified payee →
 * recorded settlements. "The three-way match blocks bad payments" is checked through the API and
 * again with direct SQL as the runtime role. Expected figures are worked out by hand in comments
 * (VAT 16 %, every line rounded half-up once, VAT once on the subtotal). Synthetic data only.
 */
const today = nairobiDate();
const inDays = (days: number) => {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
const ETIMS = "KRACU0400000078/2231";
/** A 1×1 PNG (a delivery-note "photo"). */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);
const SITE = { lat: -1.2921, lng: 36.8219 };

describe("Procure-to-pay (real runtime role)", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let db: TenantDatabase;
  let owner: Browser;
  let ownerB: Browser;
  let finance: Browser;
  let financeTwo: Browser;
  let pm: Browser;
  let pmTwo: Browser;
  let agent: Browser;
  let storekeeper: Browser;
  let foreman: Browser;
  let tenantA: string;
  let tenantB: string;
  let projectId: string;
  let siteId: string;
  let notificationSpy: ReturnType<typeof vi.spyOn>;
  const material: Record<"sand" | "cement" | "ballast", string> = {
    sand: "",
    cement: "",
    ballast: "",
  };
  const supplier: Record<"a" | "b" | "c", string> = { a: "", b: "", c: "" };
  let requisitionId: string;
  let rfq: RfqDetailResponse;
  let lpo: LpoDetailResponse;
  let grnOne: string;
  let invoiceOne: InvoiceDetailResponse;

  const fresh = (browser: Browser) =>
    prisma.session.update({
      where: { id: browser.auth.session.id },
      data: { mfaVerifiedAt: new Date() },
    });
  const join = async (member: Browser, role: string, projectIds: string[]) => {
    await fresh(owner);
    const invited = await owner.call("post", "tenants/current/invitations", {
      identifier: member.identifier,
      role,
      projectIds,
    });
    expect(invited.status, JSON.stringify(invited.body)).toBe(201);
    const token = notifications
      .get(member.identifier)
      ?.at(-1)
      ?.text.match(/Invitation token: ([A-Za-z0-9_-]+)/)?.[1];
    expect((await member.call("post", "tenants/invitations/accept", { token })).status).toBe(200);
    expect((await member.call("post", `tenants/${tenantA}/select`, {})).status).toBe(200);
  };
  const problem = (res: request.Response) => (res.body as { code?: string }).code;
  const ok = (res: request.Response, status = 200) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body as unknown;
  };
  const refused = (res: request.Response, status: number, code?: string) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    if (code) expect(problem(res)).toBe(code);
  };
  const context = (browser: Browser, tenantId = tenantA) => ({
    userId: browser.auth.user.id,
    tenantId,
    requestId: "d52-direct",
  });
  /** Direct SQL as the runtime role (pmb_app, RLS), as `browser`; expects a refusal. */
  const sqlRefused = (
    browser: Browser,
    statement: (tx: never) => Promise<unknown>,
    pattern: RegExp,
  ) => expect(db.run(context(browser), statement as never)).rejects.toThrow(pattern);
  const invoiceOf = async (browser: Browser, id: string) =>
    invoiceDetailResponseSchema.parse(ok(await browser.call("get", `procurement/invoices/${id}`)));
  const grn = (browser: Browser, body: object, key: string) =>
    browser.call("post", "procurement/grns", body, true, { "Idempotency-Key": key });
  const settle = (browser: Browser, id: string, body: object, key: string) =>
    browser.call("post", `procurement/invoices/${id}/settlements`, body, true, {
      "Idempotency-Key": key,
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    db = app.get(TenantDatabase);
    notificationSpy = vi
      .spyOn(app.get(AuthSecurity), "notify")
      .mockImplementation(async (identifier, subject, text) => {
        notifications.set(identifier, [
          ...(notifications.get(identifier) ?? []),
          { subject, text },
        ]);
      });
    owner = new Browser(app);
    ownerB = new Browser(app);
    finance = new Browser(app);
    financeTwo = new Browser(app);
    pm = new Browser(app);
    pmTwo = new Browser(app);
    agent = new Browser(app);
    storekeeper = new Browser(app);
    foreman = new Browser(app);
    for (const browser of [owner, ownerB, finance, financeTwo, pm, pmTwo]) {
      await browser.register();
      await browser.enroll();
    }
    for (const browser of [agent, storekeeper, foreman]) await browser.register();
    const a = await owner.call("post", "tenants", { name: "Procure-to-pay company A" });
    const b = await ownerB.call("post", "tenants", { name: "Procure-to-pay company B" });
    expect([a.status, b.status]).toEqual([201, 201]);
    tenantA = (a.body as { tenant: { id: string } }).tenant.id;
    tenantB = (b.body as { tenant: { id: string } }).tenant.id;
    await fresh(owner);
    projectId = projectResponseSchema.parse(
      ok(await owner.call("post", "projects", { name: "P2P project (synthetic)" }), 201),
    ).project.id;
    siteId = siteResponseSchema.parse(
      ok(
        await owner.call("post", `projects/${projectId}/sites`, {
          name: "Main yard",
          geofence: { kind: "radius", center: SITE, radiusM: 200 },
        }),
        201,
      ),
    ).site.id;
    await join(finance, "finance", []);
    await join(financeTwo, "finance", []);
    await join(pm, "project_manager", [projectId]);
    await join(pmTwo, "project_manager", [projectId]);
    await join(agent, "site_agent", [projectId]);
    await join(storekeeper, "storekeeper", [projectId]);
    await join(foreman, "foreman", [projectId]);
    ok(await owner.call("post", "materials/defaults", {}));
    const materials = materialsResponseSchema.parse(
      ok(await owner.call("get", "materials?limit=200")),
    ).materials;
    const named = (name: string) => materials.find((entry) => entry.name === name)!.id;
    material.sand = named("River sand");
    material.cement = named("Cement 42.5N (50 kg bag)");
    material.ballast = named("Ballast 20 mm");
    for (const [key, name] of [
      ["a", "Quarry A (synthetic)"],
      ["b", "Hardware B (synthetic)"],
      ["c", "Depot C (synthetic)"],
    ] as const)
      supplier[key] = supplierDetailResponseSchema.parse(
        ok(
          await owner.call("post", "suppliers", {
            legalName: name,
            etimsStatus: "registered",
            creditDays: 30,
          }),
          201,
        ),
      ).supplier.id;
    // Supplier B sells sand by the 7-tonne lorry trip.
    ok(
      await owner.call("post", `materials/${material.sand}/conversions`, {
        supplierId: supplier.b,
        fromUnit: "trip",
        fromQuantity: "1",
        toUnit: "t",
        toQuantity: "7",
        effectiveFrom: "2026-01-01",
      }),
      201,
    );
    // Supplier A's Paybill, proposed by the owner and verified independently.
    await fresh(owner);
    const proposed = supplierDetailResponseSchema.parse(
      ok(
        await owner.call("post", `suppliers/${supplier.a}/payout-details`, {
          replaces: null,
          mpesaKind: "paybill",
          paybillNumber: "600000",
          accountReference: "P2P-TEST",
        }),
        201,
      ),
    );
    await fresh(financeTwo);
    ok(
      await financeTwo.call(
        "post",
        `suppliers/${supplier.a}/payout-details/${proposed.payout.current!.id}/verify`,
        { method: "call_back_known_number", note: "Called the number on file (test)." },
      ),
    );
  }, 240_000);

  afterAll(async () => {
    notificationSpy?.mockRestore();
    await app?.close();
  });

  it("documents every D5.2 operation in OpenAPI", async () => {
    const openApi = await request(app.getHttpServer()).get("/api/docs/openapi.json").expect(200);
    const operations = Object.values(
      (openApi.body as { paths: Record<string, Record<string, { operationId?: string }>> }).paths,
    ).flatMap((path) => Object.values(path).map((operation) => operation.operationId));
    for (const id of [
      "listRequisitions",
      "createRequisition",
      "getRequisition",
      "updateRequisition",
      "submitRequisition",
      "approveRequisition",
      "rejectRequisition",
      "reopenRequisition",
      "cancelRequisition",
      "listRfqs",
      "createRfq",
      "getRfq",
      "updateRfq",
      "recordQuotation",
      "withdrawQuotation",
      "uploadQuotationDocument",
      "requestRfqException",
      "approveRfqException",
      "awardRfq",
      "cancelRfq",
      "listLpos",
      "getLpo",
      "updateLpo",
      "submitLpo",
      "approveLpo",
      "returnLpo",
      "cancelLpo",
      "listGrns",
      "listReceivableLpos",
      "createGrn",
      "getGrn",
      "uploadGrnPhoto",
      "voidGrn",
      "listInvoices",
      "recordInvoice",
      "getInvoice",
      "updateInvoice",
      "submitInvoice",
      "rematchInvoice",
      "reopenInvoice",
      "cancelInvoice",
      "exceptInvoiceMatch",
      "approveInvoice",
      "recordSettlement",
      "uploadInvoiceDocument",
      "procurementInbox",
      "procurementCommitments",
      "downloadProcurementDocument",
    ])
      expect(operations, id).toContain(id);
  });

  it("raises requisitions with base quantities; decisions are maker-checked in the API and the database", async () => {
    // 21 t of sand and 100 bags of cement; base units t and bag_50kg (no conversion needed).
    const created = requisitionDetailResponseSchema.parse(
      ok(
        await agent.call("post", "procurement/requisitions", {
          projectId,
          siteId,
          neededBy: inDays(7),
          lines: [
            { materialId: material.sand, quantity: "21", unit: "t" },
            { materialId: material.cement, quantity: "5000", unit: "kg" },
          ],
        }),
        201,
      ),
    );
    requisitionId = created.requisition.id;
    expect(created.requisition).toMatchObject({
      number: "REQ-0001",
      status: "draft",
      lineCount: 2,
    });
    // 5,000 kg of cement = 100 bags of 50 kg (exact standard factor).
    expect(created.lines.map((line) => [line.quantity, line.unit, line.baseQuantity])).toEqual([
      ["21", "t", "21"],
      ["5000", "kg", "100"],
    ]);
    // Edit while draft: change the cement to 100 bags directly.
    const edited = requisitionDetailResponseSchema.parse(
      ok(
        await agent.call("patch", `procurement/requisitions/${requisitionId}`, {
          version: created.requisition.version,
          lines: [
            { materialId: material.sand, quantity: "21", unit: "t" },
            { materialId: material.cement, quantity: "100", unit: "bag_50kg" },
          ],
        }),
      ),
    );
    // Trips without a factor are refused, not guessed.
    refused(
      await agent.call("post", "procurement/requisitions", {
        projectId,
        neededBy: today,
        lines: [{ materialId: material.sand, quantity: "3", unit: "trip" }],
      }),
      422,
      "no-conversion",
    );
    // The foreman has no procurement permission.
    refused(
      await foreman.call("post", "procurement/requisitions", {
        projectId,
        neededBy: today,
        lines: [{ materialId: material.sand, quantity: "1", unit: "t" }],
      }),
      403,
    );
    const submitted = requisitionDetailResponseSchema.parse(
      ok(
        await agent.call("post", `procurement/requisitions/${requisitionId}/submit`, {
          version: edited.requisition.version,
        }),
      ),
    );
    // Editing after submission needs a return to draft.
    refused(
      await agent.call("patch", `procurement/requisitions/${requisitionId}`, {
        version: submitted.requisition.version,
        notes: "late change",
      }),
      409,
      "invalid-transition",
    );
    // The site agent cannot approve (no procurement.approve).
    refused(
      await agent.call("post", `procurement/requisitions/${requisitionId}/approve`, {
        version: submitted.requisition.version,
      }),
      403,
    );
    // A second requisition raised by the PM: the PM cannot approve their own (API and database).
    const own = requisitionDetailResponseSchema.parse(
      ok(
        await pm.call("post", "procurement/requisitions", {
          projectId,
          neededBy: today,
          lines: [{ materialId: material.ballast, quantity: "20", unit: "t" }],
        }),
        201,
      ),
    );
    const ownSubmitted = requisitionDetailResponseSchema.parse(
      ok(
        await pm.call("post", `procurement/requisitions/${own.requisition.id}/submit`, {
          version: own.requisition.version,
        }),
      ),
    );
    expect(ownSubmitted.permissions.canDecide).toBe(false);
    refused(
      await pm.call("post", `procurement/requisitions/${own.requisition.id}/approve`, {
        version: ownSubmitted.requisition.version,
      }),
      403,
      "maker-checker",
    );
    await sqlRefused(
      pm,
      ((tx: { $executeRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<number> }) =>
        tx.$executeRaw`UPDATE requisitions SET status = 'approved', decided_by = ${pm.auth.user.id}::uuid,
          decided_at = now() WHERE id = ${own.requisition.id}::uuid`) as never,
      /requisitions_state_check/,
    );
    // Rejection needs a reason; pmTwo rejects, the PM reopens (new draft) and cancels it.
    refused(
      await pmTwo.call("post", `procurement/requisitions/${own.requisition.id}/reject`, {
        version: ownSubmitted.requisition.version,
        reason: " ",
      }),
      400,
    );
    const rejected = requisitionDetailResponseSchema.parse(
      ok(
        await pmTwo.call("post", `procurement/requisitions/${own.requisition.id}/reject`, {
          version: ownSubmitted.requisition.version,
          reason: "Ballast already on site",
        }),
      ),
    );
    expect(rejected.requisition).toMatchObject({
      status: "rejected",
      rejectionReason: "Ballast already on site",
    });
    const reopened = requisitionDetailResponseSchema.parse(
      ok(
        await pm.call("post", `procurement/requisitions/${own.requisition.id}/reopen`, {
          version: rejected.requisition.version,
        }),
      ),
    );
    expect(reopened.requisition).toMatchObject({
      status: "draft",
      decidedBy: null,
      rejectionReason: null,
    });
    ok(
      await pm.call("post", `procurement/requisitions/${own.requisition.id}/cancel`, {
        version: reopened.requisition.version,
        reason: "Not needed",
      }),
    );
    // The PM did not write REQ-0001, so they may approve it.
    const approved = requisitionDetailResponseSchema.parse(
      ok(
        await pm.call("post", `procurement/requisitions/${requisitionId}/approve`, {
          version: submitted.requisition.version,
        }),
      ),
    );
    expect(approved.requisition).toMatchObject({
      status: "approved",
      decidedBy: { id: pm.auth.user.id },
    });
    expect(approved.contributors.map((person) => person.id)).toEqual([agent.auth.user.id]);
    // The approved requisition's lines are frozen in the database too.
    await sqlRefused(
      agent,
      ((tx: { $executeRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<number> }) =>
        tx.$executeRaw`UPDATE requisition_lines SET quantity = 30 WHERE requisition_id = ${requisitionId}::uuid`) as never,
      /only while the requisition is a draft/,
    );
    const list = requisitionsResponseSchema.parse(
      ok(await pm.call("get", `procurement/requisitions?projectId=${projectId}`)),
    );
    expect(list.requisitions.map((entry) => entry.number)).toEqual(["REQ-0002", "REQ-0001"]);
  });

  it("compares quotations net of VAT per base unit and enforces the minimum number of quotes", async () => {
    // Created by the owner (procurement.manage_suppliers); the PM cannot create RFQs.
    refused(
      await pm.call("post", "procurement/rfqs", {
        requisitionIds: [requisitionId],
        supplierIds: [supplier.a],
      }),
      403,
    );
    rfq = rfqDetailResponseSchema.parse(
      ok(
        await owner.call("post", "procurement/rfqs", {
          requisitionIds: [requisitionId],
          supplierIds: [supplier.a, supplier.b, supplier.c],
          respondBy: inDays(3),
        }),
        201,
      ),
    );
    expect(rfq.rfq).toMatchObject({ number: "RFQ-0001", status: "open" });
    expect(rfq.lines.map((line) => [line.material.name, line.baseQuantity])).toEqual([
      ["River sand", "21"],
      ["Cement 42.5N (50 kg bag)", "100"],
    ]);
    const [sandLine, cementLine] = rfq.lines.map((line) => line.requisitionLineId) as [
      string,
      string,
    ];
    // A requisition is on at most one live RFQ.
    refused(
      await owner.call("post", "procurement/rfqs", {
        requisitionIds: [requisitionId],
        supplierIds: [supplier.a],
      }),
      409,
      "requisition-on-rfq",
    );
    const quote = async (supplierId: string, lines: object[]) =>
      rfqDetailResponseSchema.parse(
        ok(
          await owner.call("post", `procurement/rfqs/${rfq.rfq.id}/quotations`, {
            supplierId,
            reference: "Q-1",
            quotedOn: today,
            validUntil: inDays(30),
            deliveryDays: 3,
            lines,
          }),
          201,
        ),
      );
    // A: sand KES 2,000.00 per t excl. VAT; cement KES 900 per 50 kg bag incl. VAT.
    rfq = await quote(supplier.a, [
      {
        requisitionLineId: sandLine,
        priceUnit: "t",
        unitPriceMinor: 200_000,
        vatTreatment: "exclusive",
      },
      {
        requisitionLineId: cementLine,
        priceUnit: "bag_50kg",
        unitPriceMinor: 90_000,
        vatTreatment: "inclusive",
      },
    ]);
    // B: sand KES 15,400.00 per 7 t lorry trip excl. VAT (= 2,200.00 per t); cement KES 920 incl.
    rfq = await quote(supplier.b, [
      {
        requisitionLineId: sandLine,
        priceUnit: "trip",
        unitPriceMinor: 1_540_000,
        vatTreatment: "exclusive",
      },
      {
        requisitionLineId: cementLine,
        priceUnit: "bag_50kg",
        unitPriceMinor: 92_000,
        vatTreatment: "inclusive",
      },
    ]);
    // C: no bid for sand; cement KES 880 incl.
    rfq = await quote(supplier.c, [
      { requisitionLineId: sandLine, noBid: true },
      {
        requisitionLineId: cementLine,
        priceUnit: "bag_50kg",
        unitPriceMinor: 88_000,
        vatTreatment: "inclusive",
      },
    ]);
    // A second live quotation from the same supplier is refused; so is a quote missing a line.
    refused(
      await owner.call("post", `procurement/rfqs/${rfq.rfq.id}/quotations`, {
        supplierId: supplier.a,
        quotedOn: today,
        validUntil: inDays(30),
        deliveryDays: 3,
        lines: [
          { requisitionLineId: sandLine, noBid: true },
          { requisitionLineId: cementLine, noBid: true },
        ],
      }),
      409,
      "quotation-exists",
    );
    const [qa, qb, qc] = rfq.quotations;
    // Hand-worked: A sand 21 × 200,000 = 4,200,000; cement 100 × 90,000 × 100/116 = 7,758,620.69 →
    // 7,758,621; total 11,958,621. B sand 1,540,000 / 7 = 220,000 per t → 4,620,000; cement
    // 100 × 92,000 × 100/116 = 7,931,034.48 → 7,931,034; total 12,551,034. C cement
    // 100 × 88,000 × 100/116 = 7,586,206.90 → 7,586,207 (incomplete: no sand).
    expect(
      rfq.quotations.map((quotation) => [quotation.netTotalMinor, quotation.complete]),
    ).toEqual([
      [11_958_621, true],
      [12_551_034, true],
      [7_586_207, false],
    ]);
    expect(qb!.lines[0]).toMatchObject({ priceUnit: "trip", netUnitPriceBaseMinor: "220000" });
    expect(qa!.lines[1]).toMatchObject({
      netUnitPriceBaseMinor: "77586.206897",
      netAmountMinor: 7_758_621,
    });
    const lowest = (line: string) =>
      rfq.comparison.lines
        .find((entry) => entry.requisitionLineId === line)!
        .cells.filter((cell) => cell.lowest)
        .map((cell) => cell.quotationId);
    expect(lowest(sandLine)).toEqual([qa!.id]);
    expect(lowest(cementLine)).toEqual([qc!.id]);
    expect(
      rfq.comparison.totals.filter((total) => total.lowest).map((total) => total.quotationId),
    ).toEqual([qa!.id]);
    // Quoted prices are in the D5.1 price history as `quotation`.
    const quoted = await db.run(context(owner), (tx) =>
      tx.materialPrice.count({ where: { tenantId: tenantA, source: "quotation" } }),
    );
    expect(quoted).toBe(5);
    // Two complete quotations, three required by default.
    expect(rfq.award).toEqual({ minQuotes: 3, completeQuotes: 2, basis: "not-enough-quotes" });
    refused(
      await owner.call("post", `procurement/rfqs/${rfq.rfq.id}/award`, {
        version: rfq.rfq.version,
        quotationId: qa!.id,
      }),
      409,
      "not-enough-quotes",
    );
    // An incomplete quotation can never win.
    refused(
      await owner.call("post", `procurement/rfqs/${rfq.rfq.id}/award`, {
        version: rfq.rfq.version,
        quotationId: qc!.id,
      }),
      409,
      "quotation-incomplete",
    );
    // Single-source exception: requested with a reason, approved by a different person.
    rfq = rfqDetailResponseSchema.parse(
      ok(
        await owner.call("post", `procurement/rfqs/${rfq.rfq.id}/exception`, {
          version: rfq.rfq.version,
          reason: "Only two quarries deliver to this site",
        }),
      ),
    );
    refused(
      await owner.call("post", `procurement/rfqs/${rfq.rfq.id}/exception/approve`, {
        version: rfq.rfq.version,
      }),
      403,
      "maker-checker",
    );
    await sqlRefused(
      owner,
      ((tx: { $executeRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<number> }) =>
        tx.$executeRaw`UPDATE rfqs SET exception_approved_by = ${owner.auth.user.id}::uuid,
          exception_approved_at = now() WHERE id = ${rfq.rfq.id}::uuid`) as never,
      /rfqs_state_check/,
    );
    rfq = rfqDetailResponseSchema.parse(
      ok(
        await pm.call("post", `procurement/rfqs/${rfq.rfq.id}/exception/approve`, {
          version: rfq.rfq.version,
        }),
      ),
    );
    expect(rfq.award.basis).toBe("exception-approved");
    lpo = lpoDetailResponseSchema.parse(
      ok(
        await owner.call("post", `procurement/rfqs/${rfq.rfq.id}/award`, {
          version: rfq.rfq.version,
          quotationId: qa!.id,
          deliverySiteId: siteId,
          deliveryDate: inDays(5),
          terms: "Deliver to the main yard gate.",
        }),
        201,
      ),
    );
    // Subtotal 11,958,621; VAT 16 % once = 1,913,379.36 → 1,913,379; total 13,872,000 (= the
    // VAT-inclusive 21 × 2,320 + 100 × 900 = 138,720 shillings).
    expect(lpo.lpo).toMatchObject({
      number: "LPO-0001",
      status: "draft",
      subtotalMinor: 11_958_621,
      vatMinor: 1_913_379,
      totalMinor: 13_872_000,
      creditDays: 30,
      supplier: { id: supplier.a, name: "Quarry A (synthetic)", etimsStatus: "registered" },
      deliverySite: { id: siteId, name: "Main yard" },
    });
    expect(lpo.lines.map((line) => [line.quantity, line.unit, line.netAmountMinor])).toEqual([
      ["21", "t", 4_200_000],
      ["100", "bag_50kg", 7_758_621],
    ]);
    refused(
      await owner.call("post", `procurement/rfqs/${rfq.rfq.id}/quotations/${qa!.id}/withdraw`, {
        reason: "Too late",
      }),
      409,
      "rfq-not-open",
    );
  });

  it("approves LPOs independently with step-up; approved LPOs are immutable commitments", async () => {
    lpo = lpoDetailResponseSchema.parse(
      ok(
        await owner.call("post", `procurement/lpos/${lpo.lpo.id}/submit`, {
          version: lpo.lpo.version,
        }),
      ),
    );
    await fresh(owner);
    refused(
      await owner.call("post", `procurement/lpos/${lpo.lpo.id}/approve`, {
        version: lpo.lpo.version,
      }),
      403,
      "maker-checker",
    );
    await sqlRefused(
      owner,
      ((tx: { $executeRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<number> }) =>
        tx.$executeRaw`UPDATE lpos SET status = 'approved', approved_by = ${owner.auth.user.id}::uuid,
          approved_at = now() WHERE id = ${lpo.lpo.id}::uuid`) as never,
      /lpos_state_check/,
    );
    await prisma.session.update({
      where: { id: pm.auth.session.id },
      data: { mfaVerifiedAt: new Date(Date.now() - 10 * 60_000) },
    });
    refused(
      await pm.call("post", `procurement/lpos/${lpo.lpo.id}/approve`, { version: lpo.lpo.version }),
      403,
      "step-up-required",
    );
    await fresh(pm);
    lpo = lpoDetailResponseSchema.parse(
      ok(
        await pm.call("post", `procurement/lpos/${lpo.lpo.id}/approve`, {
          version: lpo.lpo.version,
        }),
      ),
    );
    expect(lpo.lpo).toMatchObject({ status: "approved", deliveryState: "none" });
    expect(lpo.commitment).toEqual({
      committedMinor: 11_958_621,
      accruedMinor: 0,
      openMinor: 11_958_621,
    });
    const requisition = requisitionDetailResponseSchema.parse(
      ok(await agent.call("get", `procurement/requisitions/${requisitionId}`)),
    );
    expect(requisition.requisition).toMatchObject({
      status: "ordered",
      lpo: { id: lpo.lpo.id, number: "LPO-0001" },
    });
    await sqlRefused(
      owner,
      ((tx: { $executeRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<number> }) =>
        tx.$executeRaw`UPDATE lpos SET terms = 'changed' WHERE id = ${lpo.lpo.id}::uuid`) as never,
      /Only a draft LPO changes/,
    );
    await sqlRefused(
      owner,
      ((tx: { $executeRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<number> }) =>
        tx.$executeRaw`DELETE FROM lpo_lines WHERE lpo_id = ${lpo.lpo.id}::uuid`) as never,
      /permission denied/,
    );
  });

  it("records GRNs idempotently with photos, geofence and vehicle checks", async () => {
    const receivable = receivableLposResponseSchema.parse(
      ok(await agent.call("get", `procurement/grns/receivable?projectId=${projectId}`)),
    );
    expect(receivable.lpos.map((entry) => entry.number)).toEqual(["LPO-0001"]);
    const [sand, cement] = lpo.lines;
    grnOne = randomUUID();
    const body = {
      id: grnOne,
      lpoId: lpo.lpo.id,
      capturedAt: new Date().toISOString(),
      receivedByName: "Mary Wanjiku (synthetic)",
      vehicleRegistration: "kda 123a",
      deliveryNoteNumber: "DN-7781",
      location: { latitude: SITE.lat, longitude: SITE.lng, accuracyM: 12 },
      source: "site_app",
      lines: [
        { lpoLineId: sand!.id, receivedQuantity: "14" },
        {
          lpoLineId: cement!.id,
          receivedQuantity: "100",
          rejectedQuantity: "2",
          rejectionReason: "Torn bags",
        },
      ],
    };
    refused(await agent.call("post", "procurement/grns", body), 400, "idempotency-key-required");
    refused(await grn(foreman, body, "grn-key-foreman"), 403);
    const first = await grn(agent, body, "grn-key-0001");
    const recorded = grnResponseSchema.parse(ok(first, 201));
    expect(recorded.replayed).toBe(false);
    expect(recorded.grn).toMatchObject({
      id: grnOne,
      number: "GRN-0001",
      vehicleRegistration: "KDA 123A",
      vehicleRegistrationFormat: "kenyan",
      location: { state: "inside", geofenceVersion: 1, lowAccuracy: false },
      overDelivery: false,
      evidenceComplete: false,
      source: "site_app",
    });
    expect(
      recorded.grn.lines.map((line) => [line.acceptedBaseQuantity, line.rejectionReason]),
    ).toEqual([
      ["14", null],
      ["98", "Torn bags"],
    ]);
    // A replay returns the original; a changed payload under the key conflicts; so does the ID.
    const replay = await grn(agent, body, "grn-key-0001");
    expect(grnResponseSchema.parse(ok(replay, 201))).toMatchObject({
      replayed: true,
      grn: { id: grnOne, number: "GRN-0001" },
    });
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    refused(
      await grn(
        agent,
        { ...body, lines: [{ lpoLineId: sand!.id, receivedQuantity: "15" }] },
        "grn-key-0001",
      ),
      409,
      "idempotency-key-reused",
    );
    refused(await grn(agent, body, "grn-key-0002"), 409, "grn-id-conflict");
    expect(
      await db.run(context(agent), (tx) => tx.grn.count({ where: { tenantId: tenantA } })),
    ).toBe(1);
    // Photos: images only; both kinds make the evidence complete.
    refused(
      await agent.upload(
        `procurement/grns/${grnOne}/photos?kind=goods`,
        Buffer.from("not an image"),
        "x.png",
      ),
      415,
      "unsupported-file-type",
    );
    const photo = procurementDocumentResponseSchema.parse(
      ok(
        await agent.upload(`procurement/grns/${grnOne}/photos?kind=delivery_note`, PNG, "note.png"),
        201,
      ),
    );
    expect(photo.document).toMatchObject({ kind: "delivery_note", contentType: "image/png" });
    ok(await agent.upload(`procurement/grns/${grnOne}/photos?kind=goods`, PNG, "goods.jpg"), 201);
    const withPhotos = grnResponseSchema.parse(
      ok(await pm.call("get", `procurement/grns/${grnOne}`)),
    );
    expect(withPhotos.grn.evidenceComplete).toBe(true);
    const download = await pm.download(`procurement/documents/${photo.document.id}`);
    expect(download.status).toBe(200);
    expect(Buffer.compare(download.body as Buffer, PNG)).toBe(0);
    expect((await ownerB.download(`procurement/documents/${photo.document.id}`)).status).toBe(404);
    // GRNs never change except to be voided.
    await sqlRefused(
      agent,
      ((tx: { $executeRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<number> }) =>
        tx.$executeRaw`UPDATE grns SET vehicle_registration = 'KZZ 999Z' WHERE id = ${grnOne}::uuid`) as never,
      /never changes/,
    );
    lpo = lpoDetailResponseSchema.parse(ok(await pm.call("get", `procurement/lpos/${lpo.lpo.id}`)));
    expect(lpo.lpo.deliveryState).toBe("partial");
    expect(lpo.lines.map((line) => line.receivedBaseQuantity)).toEqual(["14", "98"]);
    refused(
      await owner.call("post", `procurement/lpos/${lpo.lpo.id}/cancel`, {
        version: lpo.lpo.version,
        reason: "Change supplier",
      }),
      409,
      "lpo-has-deliveries",
    );
  });

  it("blocks bad payments: a mismatched invoice is not approvable, in the API or in SQL", async () => {
    const [sand, cement] = lpo.lines;
    // Billing the whole order while only 14 t of sand and 98 bags were accepted.
    invoiceOne = invoiceDetailResponseSchema.parse(
      ok(
        await finance.call("post", "procurement/invoices", {
          lpoId: lpo.lpo.id,
          invoiceNumber: "INV-0001",
          invoiceDate: today,
          etimsInvoiceNumber: ETIMS.toLowerCase(),
          subtotalMinor: 11_958_621,
          vatMinor: 1_913_379,
          totalMinor: 13_872_000,
          lines: [
            {
              lpoLineId: sand!.id,
              quantity: "21",
              unitPriceMinor: 200_000,
              vatTreatment: "exclusive",
            },
            {
              lpoLineId: cement!.id,
              quantity: "100",
              unitPriceMinor: 90_000,
              vatTreatment: "inclusive",
            },
          ],
        }),
        201,
      ),
    );
    expect(invoiceOne.invoice).toMatchObject({
      status: "draft",
      etimsInvoiceNumber: ETIMS,
      etimsFormat: "etims",
      computedSubtotalMinor: 11_958_621,
      computedVatMinor: 1_913_379,
    });
    // A supplier's invoice number is used once (normalised: "inv 0001" is "INV-0001").
    refused(
      await finance.call("post", "procurement/invoices", {
        lpoId: lpo.lpo.id,
        invoiceNumber: "inv 0001",
        invoiceDate: today,
        etimsInvoiceNumber: ETIMS,
        subtotalMinor: 200_000,
        vatMinor: 32_000,
        totalMinor: 232_000,
        lines: [
          {
            lpoLineId: sand!.id,
            quantity: "1",
            unitPriceMinor: 200_000,
            vatTreatment: "exclusive",
          },
        ],
      }),
      409,
      "invoice-number-taken",
    );
    invoiceOne = invoiceDetailResponseSchema.parse(
      ok(
        await finance.call("post", `procurement/invoices/${invoiceOne.invoice.id}/submit`, {
          version: invoiceOne.invoice.version,
        }),
      ),
    );
    expect(invoiceOne.invoice.status).toBe("disputed");
    expect(invoiceOne.match).toMatchObject({
      outcome: "mismatch",
      passing: false,
      current: true,
      reasons: ["qty-exceeds-received"],
      exceptable: true,
    });
    expect(
      invoiceOne.match!.lines.map((line) => [
        line.orderedQuantity,
        line.receivedQuantity,
        line.invoicedQuantity,
        line.allowedQuantity,
        line.reasons,
      ]),
    ).toEqual([
      ["21", "14", "21", "14", ["qty-exceeds-received"]],
      ["100", "98", "100", "98", ["qty-exceeds-received"]],
    ]);
    expect(invoiceOne.permissions.canApprove).toBe(false);
    await fresh(owner);
    refused(
      await owner.call("post", `procurement/invoices/${invoiceOne.invoice.id}/approve`, {
        version: invoiceOne.invoice.version,
        matchId: invoiceOne.match!.id,
        payoutVersionId: invoiceOne.payee!.id,
      }),
      409,
      "invalid-transition",
    );
    // The same refusals with direct SQL as the runtime role.
    const id = invoiceOne.invoice.id;
    const matchId = invoiceOne.match!.id;
    const payee = invoiceOne.payee!.id;
    const content = invoiceOne.invoice.contentVersion;
    type Raw = { $executeRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<number> };
    await sqlRefused(
      owner,
      ((tx: Raw) => tx.$executeRaw`INSERT INTO invoice_payables (id, tenant_id, invoice_id,
        invoice_content_version, match_id, payout_version_id, authorised_minor, approved_by)
        VALUES (gen_random_uuid(), ${tenantA}::uuid, ${id}::uuid, ${content}, ${matchId}::uuid,
        ${payee}::uuid, 13872000, ${owner.auth.user.id}::uuid)`) as never,
      /passing match/,
    );
    await sqlRefused(
      owner,
      ((tx: Raw) =>
        tx.$executeRaw`UPDATE supplier_invoices SET status = 'approved' WHERE id = ${id}::uuid`) as never,
      /cannot change from disputed to approved/,
    );
    await sqlRefused(
      owner,
      ((tx: Raw) => tx.$executeRaw`INSERT INTO three_way_matches (id, tenant_id, invoice_id, lpo_id,
        invoice_content_version, grn_ids, prior_invoice_ids, qty_tolerance_percent,
        price_tolerance_percent, block_without_etims, outcome, reasons, evidence, computed_by)
        VALUES (gen_random_uuid(), ${tenantA}::uuid, ${id}::uuid, ${lpo.lpo.id}::uuid, ${content},
        app.lpo_grn_set(${tenantA}::uuid, ${lpo.lpo.id}::uuid), '{}', 0, 0, true, 'matched', '{}',
        '{}', ${owner.auth.user.id}::uuid)`) as never,
      /three-way match fails/,
    );
    // The recorder cannot approve an exception for their own invoice.
    await fresh(finance);
    refused(
      await finance.call("post", `procurement/invoices/${id}/exception`, {
        version: invoiceOne.invoice.version,
        matchId,
        reason: "Delivered, GRN pending",
      }),
      403,
      "maker-checker",
    );
  });

  it("matches a corrected invoice; a new GRN makes the match stale; approval binds match and payee", async () => {
    const [sand, cement] = lpo.lines;
    const id = invoiceOne.invoice.id;
    invoiceOne = invoiceDetailResponseSchema.parse(
      ok(
        await finance.call("post", `procurement/invoices/${id}/reopen`, {
          version: invoiceOne.invoice.version,
        }),
      ),
    );
    // Corrected to what was accepted: sand 14 × 200,000 = 2,800,000; cement 98 × 77,586.2069 =
    // 7,603,448.28 → 7,603,448; subtotal 10,403,448; VAT 1,664,551.68 → 1,664,552; total
    // 12,068,000 (= 14 × 2,320 + 98 × 900 = 120,680 shillings).
    invoiceOne = invoiceDetailResponseSchema.parse(
      ok(
        await finance.call("patch", `procurement/invoices/${id}`, {
          version: invoiceOne.invoice.version,
          subtotalMinor: 10_403_448,
          vatMinor: 1_664_552,
          totalMinor: 12_068_000,
          lines: [
            {
              lpoLineId: sand!.id,
              quantity: "14",
              unitPriceMinor: 200_000,
              vatTreatment: "exclusive",
            },
            {
              lpoLineId: cement!.id,
              quantity: "98",
              unitPriceMinor: 90_000,
              vatTreatment: "inclusive",
            },
          ],
        }),
      ),
    );
    expect(invoiceOne.invoice.computedSubtotalMinor).toBe(10_403_448);
    expect(invoiceOne.match?.current).toBe(false);
    invoiceOne = invoiceDetailResponseSchema.parse(
      ok(
        await finance.call("post", `procurement/invoices/${id}/submit`, {
          version: invoiceOne.invoice.version,
        }),
      ),
    );
    expect(invoiceOne.invoice.status).toBe("matched");
    expect(invoiceOne.match).toMatchObject({
      outcome: "matched",
      passing: true,
      current: true,
      reasons: [],
    });
    const staleMatch = invoiceOne.match!.id;
    // Another delivery (7 t of sand) recorded 2 km from the site with a poor fix: flagged only.
    const second = grnResponseSchema.parse(
      ok(
        await grn(
          storekeeper,
          {
            id: randomUUID(),
            lpoId: lpo.lpo.id,
            capturedAt: new Date().toISOString(),
            receivedByName: "John Otieno (synthetic)",
            vehicleRegistration: "T 123 ABC",
            location: { latitude: SITE.lat + 0.018, longitude: SITE.lng, accuracyM: 150 },
            lines: [{ lpoLineId: sand!.id, receivedQuantity: "7" }],
          },
          "grn-key-0003",
        ),
        201,
      ),
    );
    expect(second.grn).toMatchObject({
      number: "GRN-0002",
      vehicleRegistrationFormat: "other",
      location: { state: "outside", lowAccuracy: true },
    });
    invoiceOne = await invoiceOf(finance, id);
    expect(invoiceOne.match).toMatchObject({ current: false, staleReasons: ["grns-changed"] });
    await fresh(owner);
    refused(
      await owner.call("post", `procurement/invoices/${id}/approve`, {
        version: invoiceOne.invoice.version,
        matchId: staleMatch,
        payoutVersionId: invoiceOne.payee!.id,
      }),
      409,
      "match-stale",
    );
    type Raw = { $executeRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<number> };
    await sqlRefused(
      owner,
      ((tx: Raw) => tx.$executeRaw`INSERT INTO invoice_payables (id, tenant_id, invoice_id,
        invoice_content_version, match_id, payout_version_id, authorised_minor, approved_by)
        VALUES (gen_random_uuid(), ${tenantA}::uuid, ${id}::uuid, ${invoiceOne.invoice.contentVersion},
        ${staleMatch}::uuid, ${invoiceOne.payee!.id}::uuid, 12068000, ${owner.auth.user.id}::uuid)`) as never,
      /current three-way match/,
    );
    invoiceOne = invoiceDetailResponseSchema.parse(
      ok(
        await finance.call("post", `procurement/invoices/${id}/rematch`, {
          version: invoiceOne.invoice.version,
        }),
      ),
    );
    expect(invoiceOne.match).toMatchObject({ outcome: "matched", current: true, grnCount: 2 });
    expect(invoiceOne.match!.id).not.toBe(staleMatch);
    // The recorder may not approve (API and SQL); step-up and the payee seen are required.
    await fresh(finance);
    refused(
      await finance.call("post", `procurement/invoices/${id}/approve`, {
        version: invoiceOne.invoice.version,
        matchId: invoiceOne.match!.id,
        payoutVersionId: invoiceOne.payee!.id,
      }),
      403,
      "maker-checker",
    );
    await sqlRefused(
      finance,
      ((tx: Raw) => tx.$executeRaw`INSERT INTO invoice_payables (id, tenant_id, invoice_id,
        invoice_content_version, match_id, payout_version_id, authorised_minor, approved_by)
        VALUES (gen_random_uuid(), ${tenantA}::uuid, ${id}::uuid, ${invoiceOne.invoice.contentVersion},
        ${invoiceOne.match!.id}::uuid, ${invoiceOne.payee!.id}::uuid, 12068000,
        ${finance.auth.user.id}::uuid)`) as never,
      /did not prepare it/,
    );
    await prisma.session.update({
      where: { id: owner.auth.session.id },
      data: { mfaVerifiedAt: new Date(Date.now() - 10 * 60_000) },
    });
    const body = {
      version: invoiceOne.invoice.version,
      matchId: invoiceOne.match!.id,
      payoutVersionId: invoiceOne.payee!.id,
    };
    refused(
      await owner.call("post", `procurement/invoices/${id}/approve`, body),
      403,
      "step-up-required",
    );
    await fresh(owner);
    refused(
      await owner.call("post", `procurement/invoices/${id}/approve`, {
        ...body,
        payoutVersionId: randomUUID(),
      }),
      409,
      "payee-changed",
    );
    // Two approvers at once: exactly one wins.
    await fresh(financeTwo);
    const results = await Promise.all([
      owner.call("post", `procurement/invoices/${id}/approve`, body),
      financeTwo.call("post", `procurement/invoices/${id}/approve`, body),
    ]);
    expect(results.map((res) => res.status).sort((left, right) => left - right)).toEqual([
      200, 409,
    ]);
    invoiceOne = await invoiceOf(finance, id);
    expect(invoiceOne.invoice).toMatchObject({ status: "approved", outstandingMinor: 12_068_000 });
    expect(invoiceOne.payable).toMatchObject({
      status: "active",
      current: true,
      authorisedMinor: 12_068_000,
      matchId: invoiceOne.match!.id,
      payout: { id: invoiceOne.payee!.id, paybillNumber: "600000" },
    });
    lpo = lpoDetailResponseSchema.parse(ok(await pm.call("get", `procurement/lpos/${lpo.lpo.id}`)));
    expect(lpo.commitment).toEqual({
      committedMinor: 11_958_621,
      accruedMinor: 10_403_448,
      openMinor: 1_555_173,
    });
    // A GRN an approved invoice relies on cannot be voided.
    refused(
      await storekeeper.call("post", `procurement/grns/${grnOne}/void`, {
        reason: "Entered twice",
      }),
      409,
      "grn-supports-approved-invoice",
    );
    await sqlRefused(
      storekeeper,
      ((
        tx: Raw,
      ) => tx.$executeRaw`UPDATE grns SET status = 'voided', voided_by = ${storekeeper.auth.user.id}::uuid,
        voided_at = now(), void_reason = 'Entered twice' WHERE id = ${grnOne}::uuid`) as never,
      /supports an approved invoice/,
    );
  });

  it("prevents double billing and blocks a missing eTIMS number when configured", async () => {
    const [sand] = lpo.lines;
    const record = async (number: string, quantity: string, etims: string | null) =>
      invoiceDetailResponseSchema.parse(
        ok(
          await finance.call("post", "procurement/invoices", {
            lpoId: lpo.lpo.id,
            invoiceNumber: number,
            invoiceDate: today,
            etimsInvoiceNumber: etims,
            subtotalMinor: Number(quantity) * 200_000,
            vatMinor: Number(quantity) * 32_000,
            totalMinor: Number(quantity) * 232_000,
            lines: [
              { lpoLineId: sand!.id, quantity, unitPriceMinor: 200_000, vatTreatment: "exclusive" },
            ],
          }),
          201,
        ),
      );
    const submit = async (invoice: InvoiceDetailResponse) =>
      invoiceDetailResponseSchema.parse(
        ok(
          await finance.call("post", `procurement/invoices/${invoice.invoice.id}/submit`, {
            version: invoice.invoice.version,
          }),
        ),
      );
    // INV-0001 (approved) billed 14 t; 21 t were accepted; billing 14 t again is double billing.
    const double = await submit(await record("INV-0003", "14", ETIMS));
    expect(double.invoice.status).toBe("disputed");
    expect(double.match!.reasons).toEqual([
      "total-exceeds-order",
      "qty-exceeds-received",
      "qty-exceeds-ordered",
    ]);
    expect(double.match!.lines[0]).toMatchObject({
      previouslyInvoicedQuantity: "14",
      invoicedQuantity: "14",
      cumulativeQuantity: "28",
    });
    // No eTIMS number, blocked by default and never excepted.
    let missing = await submit(await record("INV-0002", "7", null));
    expect(missing.match).toMatchObject({ reasons: ["etims-missing"], exceptable: false });
    // Only a mismatch an exception may override is offered to (and waits for) an approver.
    expect((await invoiceOf(owner, missing.invoice.id)).permissions.canApproveException).toBe(
      false,
    );
    expect((await invoiceOf(owner, double.invoice.id)).permissions.canApproveException).toBe(true);
    const waiting = inboxResponseSchema
      .parse(ok(await owner.call("get", "procurement/inbox")))
      .items.filter((item) => item.kind === "invoice-exception")
      .map((item) => item.label);
    expect(waiting).toContain("INV-0003");
    expect(waiting).not.toContain("INV-0002");
    await fresh(owner);
    refused(
      await owner.call("post", `procurement/invoices/${missing.invoice.id}/exception`, {
        version: missing.invoice.version,
        matchId: missing.match!.id,
        reason: "Supplier will send it",
      }),
      409,
      "match-not-exceptable",
    );
    type Raw = { $executeRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<number> };
    await sqlRefused(
      owner,
      ((
        tx: Raw,
      ) => tx.$executeRaw`UPDATE three_way_matches SET exception_reason = 'Supplier will send it',
        exception_by = ${owner.auth.user.id}::uuid, exception_at = now()
        WHERE id = ${missing.match!.id}::uuid`) as never,
      /missing eTIMS number cannot be excepted/,
    );
    // Configurable: with the block off it is only a warning; turning it back on makes the match stale.
    const settings = (await owner.call("get", "procurement/settings")).body as {
      settings: { version: number; blockPaymentWithoutEtims: boolean; minQuotes: number };
    };
    expect(settings.settings).toMatchObject({ blockPaymentWithoutEtims: true, minQuotes: 3 });
    const off = ok(
      await owner.call("put", "procurement/settings", {
        priceChangeAlertPercent: "10",
        blockPaymentWithoutEtims: false,
        version: settings.settings.version,
      }),
    ) as { settings: { version: number } };
    missing = invoiceDetailResponseSchema.parse(
      ok(
        await finance.call("post", `procurement/invoices/${missing.invoice.id}/rematch`, {
          version: missing.invoice.version,
        }),
      ),
    );
    expect(missing.match).toMatchObject({ outcome: "matched", warnings: ["etims-missing"] });
    ok(
      await owner.call("put", "procurement/settings", {
        priceChangeAlertPercent: "10",
        blockPaymentWithoutEtims: true,
        version: off.settings.version,
      }),
    );
    missing = await invoiceOf(finance, missing.invoice.id);
    expect(missing.match).toMatchObject({ current: false, staleReasons: ["settings-changed"] });
    await fresh(owner);
    refused(
      await owner.call("post", `procurement/invoices/${missing.invoice.id}/approve`, {
        version: missing.invoice.version,
        matchId: missing.match!.id,
        payoutVersionId: missing.payee!.id,
      }),
      409,
      "match-stale",
    );
    // A credit note: the double-billed invoice is cancelled.
    const cancelled = invoiceDetailResponseSchema.parse(
      ok(
        await finance.call("post", `procurement/invoices/${double.invoice.id}/cancel`, {
          version: double.invoice.version,
          reason: "Credit note CN-12",
        }),
      ),
    );
    expect(cancelled.invoice.status).toBe("cancelled");
  });

  it("records settlements idempotently up to the outstanding balance; a payee change stops payment", async () => {
    const id = invoiceOne.invoice.id;
    const approver = invoiceOne.payable!.approvedBy.id;
    const approverBrowser = approver === owner.auth.user.id ? owner : financeTwo;
    const transfer = {
      method: "bank_transfer",
      externalReference: "FT26111500001",
      amountMinor: 5_000_000,
      paidOn: today,
    };
    await fresh(approverBrowser);
    refused(await settle(approverBrowser, id, transfer, "settle-key-0000"), 403, "maker-checker");
    await fresh(finance);
    let detail = invoiceDetailResponseSchema.parse(
      ok(await settle(finance, id, transfer, "settle-key-0001"), 201),
    );
    expect(detail.invoice).toMatchObject({
      status: "partly_settled",
      settledMinor: 5_000_000,
      outstandingMinor: 7_068_000,
    });
    detail = invoiceDetailResponseSchema.parse(
      ok(await settle(finance, id, transfer, "settle-key-0001"), 201),
    );
    expect(detail.settlements).toHaveLength(1);
    refused(
      await settle(finance, id, { ...transfer, amountMinor: 1 }, "settle-key-0001"),
      409,
      "idempotency-key-reused",
    );
    refused(
      await settle(finance, id, { ...transfer, amountMinor: 1 }, "settle-key-0002"),
      409,
      "settlement-reference-taken",
    );
    refused(
      await settle(
        finance,
        id,
        { ...transfer, externalReference: "FT26111500002", amountMinor: 7_068_001 },
        "settle-key-0003",
      ),
      409,
      "settlement-exceeds-outstanding",
    );
    refused(
      await settle(
        finance,
        id,
        { ...transfer, externalReference: "FT2", paidOn: inDays(1) },
        "settle-key-0004",
      ),
      400,
      "settlement-date-invalid",
    );
    type Raw = { $executeRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<number> };
    const insert = (browser: Browser, amount: number, reference: string) =>
      ((
        tx: Raw,
      ) => tx.$executeRaw`INSERT INTO invoice_settlements (id, tenant_id, invoice_id, payable_id,
        method, external_reference, reference_key, amount_minor, paid_on, idempotency_key,
        request_digest, recorded_by) VALUES (gen_random_uuid(), ${tenantA}::uuid, ${id}::uuid,
        ${detail.payable!.id}::uuid, 'other', ${reference}, ${reference}, ${amount}, app.business_today(),
        ${`sql-${reference}`}, ${"0".repeat(64)}, ${browser.auth.user.id}::uuid)`) as never;
    const other = approverBrowser === owner ? financeTwo : owner;
    await sqlRefused(other, insert(other, 7_068_001, "SQLREF0001"), /outstanding balance/);
    // The supplier's payout details change after approval: settlement stops until re-approval.
    await fresh(owner);
    const supplierA = supplierDetailResponseSchema.parse(
      ok(await owner.call("get", `suppliers/${supplier.a}`)),
    );
    const proposed = supplierDetailResponseSchema.parse(
      ok(
        await owner.call("post", `suppliers/${supplier.a}/payout-details`, {
          replaces: supplierA.payout.current!.id,
          mpesaKind: "till",
          tillNumber: "174379",
        }),
        201,
      ),
    );
    detail = await invoiceOf(finance, id);
    expect(detail.payable).toMatchObject({ current: false });
    expect(detail.permissions.canSettle).toBe(false);
    await fresh(finance);
    refused(
      await settle(
        finance,
        id,
        { ...transfer, externalReference: "FT26111500003", amountMinor: 1_000 },
        "settle-key-0005",
      ),
      409,
      "payee-changed",
    );
    await sqlRefused(other, insert(other, 1_000, "SQLREF0002"), /current payee/);
    const inbox = inboxResponseSchema.parse(ok(await financeTwo.call("get", "procurement/inbox")));
    expect(inbox.items.map((item) => item.kind)).toContain("invoice-reapproval");
    await fresh(financeTwo);
    ok(
      await financeTwo.call(
        "post",
        `suppliers/${supplier.a}/payout-details/${proposed.payout.current!.id}/verify`,
        { method: "call_back_known_number", note: "Called the number on file (test)." },
      ),
    );
    // Verified again, but the approval named the old details: a fresh approval is needed.
    refused(
      await settle(
        finance,
        id,
        { ...transfer, externalReference: "FT26111500004", amountMinor: 1_000 },
        "settle-key-0006",
      ),
      409,
      "payee-changed",
    );
    await fresh(owner);
    detail = invoiceDetailResponseSchema.parse(
      ok(
        await owner.call("post", `procurement/invoices/${id}/approve`, {
          version: detail.invoice.version,
          matchId: detail.payable!.matchId,
          payoutVersionId: proposed.payout.current!.id,
        }),
      ),
    );
    expect(detail.payable).toMatchObject({
      current: true,
      authorisedMinor: 7_068_000,
      payout: { tillNumber: "174379" },
    });
    expect(detail.payables.map((payable) => payable.status)).toEqual(["active", "superseded"]);
    await fresh(financeTwo);
    detail = invoiceDetailResponseSchema.parse(
      ok(
        await settle(
          financeTwo,
          id,
          {
            method: "cheque",
            externalReference: "CHQ-000123",
            amountMinor: 7_068_000,
            paidOn: today,
          },
          "settle-key-0007",
        ),
        201,
      ),
    );
    expect(detail.invoice).toMatchObject({
      status: "settled",
      settledMinor: 12_068_000,
      outstandingMinor: 0,
    });
    await sqlRefused(
      owner,
      ((tx: Raw) =>
        tx.$executeRaw`UPDATE supplier_invoices SET notes = 'edited' WHERE id = ${id}::uuid`) as never,
      /settled invoice never changes/,
    );
    const commitments = ok(
      await pm.call("get", `procurement/commitments?projectId=${projectId}`),
    ) as { totals: Record<string, number> };
    expect(commitments.totals).toEqual({
      committedMinor: 11_958_621,
      accruedMinor: 10_403_448,
      openCommitmentMinor: 1_555_173,
      paidMinor: 12_068_000,
    });
  });

  it("honours a configured minimum of quotes and reissues a cancelled LPO from its RFQ", async () => {
    const raised = requisitionDetailResponseSchema.parse(
      ok(
        await agent.call("post", "procurement/requisitions", {
          projectId,
          neededBy: inDays(10),
          lines: [{ materialId: material.ballast, quantity: "10", unit: "t" }],
        }),
        201,
      ),
    );
    const submitted = requisitionDetailResponseSchema.parse(
      ok(
        await agent.call("post", `procurement/requisitions/${raised.requisition.id}/submit`, {
          version: raised.requisition.version,
        }),
      ),
    );
    ok(
      await pmTwo.call("post", `procurement/requisitions/${raised.requisition.id}/approve`, {
        version: submitted.requisition.version,
      }),
    );
    let second = rfqDetailResponseSchema.parse(
      ok(
        await owner.call("post", "procurement/rfqs", {
          requisitionIds: [raised.requisition.id],
          supplierIds: [supplier.a, supplier.b],
        }),
        201,
      ),
    );
    const line = second.lines[0]!.requisitionLineId;
    for (const [supplierId, price] of [
      [supplier.a, 230_000],
      [supplier.b, 240_000],
    ] as const)
      second = rfqDetailResponseSchema.parse(
        ok(
          await owner.call("post", `procurement/rfqs/${second.rfq.id}/quotations`, {
            supplierId,
            quotedOn: today,
            validUntil: inDays(14),
            deliveryDays: 2,
            lines: [
              {
                requisitionLineId: line,
                priceUnit: "t",
                unitPriceMinor: price,
                vatTreatment: "exclusive",
              },
            ],
          }),
          201,
        ),
      );
    const settings = (await owner.call("get", "procurement/settings")).body as {
      settings: { version: number };
    };
    ok(
      await owner.call("put", "procurement/settings", {
        priceChangeAlertPercent: "10",
        minQuotes: 2,
        version: settings.settings.version,
      }),
    );
    second = rfqDetailResponseSchema.parse(
      ok(await owner.call("get", `procurement/rfqs/${second.rfq.id}`)),
    );
    expect(second.award).toEqual({ minQuotes: 2, completeQuotes: 2, basis: "enough-quotes" });
    let first = lpoDetailResponseSchema.parse(
      ok(
        await owner.call("post", `procurement/rfqs/${second.rfq.id}/award`, {
          version: second.rfq.version,
          quotationId: second.quotations[0]!.id,
        }),
        201,
      ),
    );
    first = lpoDetailResponseSchema.parse(
      ok(
        await owner.call("post", `procurement/lpos/${first.lpo.id}/submit`, {
          version: first.lpo.version,
        }),
      ),
    );
    await fresh(pmTwo);
    first = lpoDetailResponseSchema.parse(
      ok(
        await pmTwo.call("post", `procurement/lpos/${first.lpo.id}/approve`, {
          version: first.lpo.version,
        }),
      ),
    );
    // Nothing received or invoiced: the approved LPO can be cancelled and reissued.
    first = lpoDetailResponseSchema.parse(
      ok(
        await owner.call("post", `procurement/lpos/${first.lpo.id}/cancel`, {
          version: first.lpo.version,
          reason: "Supplier cannot deliver this week",
        }),
      ),
    );
    expect(first.lpo.status).toBe("cancelled");
    const reopened = requisitionDetailResponseSchema.parse(
      ok(await agent.call("get", `procurement/requisitions/${raised.requisition.id}`)),
    );
    expect(reopened.requisition.status).toBe("approved");
    second = rfqDetailResponseSchema.parse(
      ok(await owner.call("get", `procurement/rfqs/${second.rfq.id}`)),
    );
    expect(second.rfq).toMatchObject({ status: "open", lpo: null });
    const reissued = lpoDetailResponseSchema.parse(
      ok(
        await owner.call("post", `procurement/rfqs/${second.rfq.id}/award`, {
          version: second.rfq.version,
          quotationId: second.quotations[1]!.id,
        }),
        201,
      ),
    );
    expect(reissued.lpo).toMatchObject({
      status: "draft",
      supplier: { id: supplier.b },
      replacesLpo: { id: first.lpo.id, number: first.lpo.number },
    });
    // Back to the default of three for the rest of the suite.
    const now = (await owner.call("get", "procurement/settings")).body as {
      settings: { version: number };
    };
    ok(
      await owner.call("put", "procurement/settings", {
        priceChangeAlertPercent: "10",
        minQuotes: 3,
        version: now.settings.version,
      }),
    );
  });

  it("keeps companies apart, denies the unpermitted and keeps amounts and identifiers out of the audit log", async () => {
    for (const path of [
      `procurement/requisitions/${requisitionId}`,
      `procurement/rfqs/${rfq.rfq.id}`,
      `procurement/lpos/${lpo.lpo.id}`,
      `procurement/grns/${grnOne}`,
      `procurement/invoices/${invoiceOne.invoice.id}`,
    ])
      refused(await ownerB.call("get", path), 404);
    for (const path of ["procurement/requisitions", "procurement/lpos", "procurement/invoices"]) {
      const body = ok(await ownerB.call("get", path)) as Record<string, unknown[]>;
      expect(Object.values(body).find(Array.isArray)).toEqual([]);
    }
    const leaked = await db.run(context(ownerB, tenantB), (tx) =>
      tx.supplierInvoice.count({ where: { id: invoiceOne.invoice.id } }),
    );
    expect(leaked).toBe(0);
    refused(await foreman.call("get", `procurement/invoices/${invoiceOne.invoice.id}`), 403);
    const foremanList = ok(await foreman.call("get", "procurement/invoices")) as {
      invoices: unknown[];
    };
    expect(foremanList.invoices).toEqual([]);
    refused(
      await agent.call("post", `procurement/invoices/${invoiceOne.invoice.id}/rematch`, {
        version: 1,
      }),
      403,
    );
    const events = await db.run(context(owner), (tx) =>
      tx.auditEvent.findMany({
        where: {
          tenantId: tenantA,
          OR: [
            "requisition.",
            "rfq.",
            "quotation.",
            "lpo.",
            "grn.",
            "invoice.",
            "procurement.",
          ].map((prefix) => ({ action: { startsWith: prefix } })),
        },
      }),
    );
    expect(events.length).toBeGreaterThan(20);
    const text = JSON.stringify(events.map((event) => event.metadata));
    for (const secret of [
      "12068000",
      "13872000",
      "7068000",
      "KDA 123A",
      "FT26111500001",
      "CHQ-000123",
      "INV-0001",
      ETIMS,
      "Mary Wanjiku",
      "Torn bags",
      "Only two quarries",
    ])
      expect(text, secret).not.toContain(secret);
  });
});
