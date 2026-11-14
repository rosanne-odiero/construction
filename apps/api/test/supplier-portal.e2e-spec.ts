import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { randomUUID } from "node:crypto";
import request from "supertest";
import type { App } from "supertest/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { addCalendarDays, nairobiDate } from "@pm-buddy/domain";
import {
  invoiceDetailResponseSchema,
  invoicesResponseSchema,
  lpoDetailResponseSchema,
  materialsResponseSchema,
  portalDeliveriesResponseSchema,
  portalInvoiceDetailResponseSchema,
  portalInvoicesResponseSchema,
  portalLpoDetailResponseSchema,
  portalLposResponseSchema,
  projectResponseSchema,
  requisitionDetailResponseSchema,
  rfqDetailResponseSchema,
  siteResponseSchema,
  supplierDetailResponseSchema,
  supplierPortalOverviewResponseSchema,
  supplierPortalUserResponseSchema,
  supplierPortalUsersResponseSchema,
  supplierStatementResponseSchema,
  tenantsResponseSchema,
  inboxResponseSchema,
  type LpoDetailResponse,
} from "@pm-buddy/validation";
import { portalFor } from "@pm-buddy/types";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { PrismaService } from "../src/infra/prisma.service.js";
import { AuthSecurity } from "../src/modules/identity/auth-security.service.js";
import { TenantDatabase } from "../src/modules/identity/tenant-database.service.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { Browser, notifications } from "./support.js";
import { testDatabaseUrls } from "./test-database.js";

/**
 * D7.2 supplier portal end to end under the real runtime role (pmb_app, forced RLS and the
 * restrictive supplier policies): staff invite a supplier's contact, who joins bound to exactly
 * that supplier; the done-when (an approved LPO addressed to the supplier, an invoice submitted
 * through the portal that waits in the staff queue for the three-way match), isolation between
 * suppliers and companies (API and direct SQL), the supplier never approving, settling or editing,
 * statement arithmetic worked by hand, idempotent replays, immediate revocation and audit
 * hygiene. VAT 16 %; money in KES minor units; synthetic data only.
 */
const today = nairobiDate();
const ETIMS = "KRACU0100000001/501";
const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);
const SITE = { lat: -1.2921, lng: 36.8219 };

type Tx = {
  $executeRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<number>;
  $queryRaw: <T>(s: TemplateStringsArray, ...v: unknown[]) => Promise<T>;
};

describe("Supplier portal (real runtime role)", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let db: TenantDatabase;
  let notificationSpy: ReturnType<typeof vi.spyOn>;
  let owner: Browser;
  let finance: Browser;
  let pm: Browser;
  let agent: Browser;
  let ownerB: Browser;
  let supA: Browser;
  let supB: Browser;
  let supC: Browser;
  let tenantA: string;
  let tenantB: string;
  let projectId: string;
  let otherProjectId: string;
  let siteId: string;
  const supplier = { a: "", b: "", c: "" };
  const material = { sand: "", ballast: "" };
  let lpoA: LpoDetailResponse;
  let lpoB: LpoDetailResponse;
  let draftLpoA: LpoDetailResponse;
  let grnId: string;
  let invoiceOne = "";
  let invoiceDisputed = "";
  let documentId = "";

  const fresh = (browser: Browser) =>
    prisma.session.update({
      where: { id: browser.auth.session.id },
      data: { mfaVerifiedAt: new Date() },
    });
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
    requestId: "d72-direct",
  });
  const asUser = <T>(browser: Browser, work: (tx: Tx) => Promise<T>, tenantId = tenantA) =>
    db.run(context(browser, tenantId), work as never) as Promise<T>;
  const join = async (member: Browser, role: string, projectIds: string[]) => {
    await fresh(owner);
    ok(
      await owner.call("post", "tenants/current/invitations", {
        identifier: member.identifier,
        role,
        projectIds,
      }),
      201,
    );
    const token = notifications
      .get(member.identifier)
      ?.at(-1)
      ?.text.match(/Invitation token: ([A-Za-z0-9_-]+)/)?.[1];
    ok(await member.call("post", "tenants/invitations/accept", { token }));
    ok(await member.call("post", `tenants/${tenantA}/select`, {}));
  };
  /** Staff invite a supplier contact; the contact accepts from the link and selects the company. */
  const inviteContact = async (
    inviter: Browser,
    contact: Browser,
    supplierId: string,
    tenantId: string,
    accept = true,
  ) => {
    await fresh(inviter);
    const created = supplierPortalUserResponseSchema.parse(
      ok(
        await inviter.call("post", `suppliers/${supplierId}/portal-users`, {
          identifier: contact.identifier.toUpperCase(),
          contactName: "Accounts clerk (synthetic)",
        }),
        201,
      ),
    ).user;
    const text = notifications.get(contact.identifier)?.at(-1)?.text ?? "";
    expect(text).toMatch(/\/supplier\/join\?token=/);
    const token = text.match(/token=([A-Za-z0-9_-]+)/)?.[1];
    if (accept) {
      ok(await contact.call("post", "tenants/invitations/accept", { token }));
      ok(await contact.call("post", `tenants/${tenantId}/select`, {}));
    }
    return { user: created, token };
  };
  /** Requisition (site agent) → approved (PM) → RFQ with one quotation → LPO (owner) → approved (PM). */
  const order = async (
    supplierId: string,
    lines: { materialId: string; quantity: string; price: number }[],
    approve = true,
    project = projectId,
  ): Promise<LpoDetailResponse> => {
    let requisition = requisitionDetailResponseSchema.parse(
      ok(
        await (project === projectId ? agent : owner).call("post", "procurement/requisitions", {
          projectId: project,
          neededBy: addCalendarDays(today, 7),
          lines: lines.map((line) => ({
            materialId: line.materialId,
            quantity: line.quantity,
            unit: "t",
          })),
        }),
        201,
      ),
    );
    const raiser = project === projectId ? agent : owner;
    requisition = requisitionDetailResponseSchema.parse(
      ok(
        await raiser.call("post", `procurement/requisitions/${requisition.requisition.id}/submit`, {
          version: requisition.requisition.version,
        }),
      ),
    );
    ok(
      await pm.call("post", `procurement/requisitions/${requisition.requisition.id}/approve`, {
        version: requisition.requisition.version,
      }),
    );
    let rfq = rfqDetailResponseSchema.parse(
      ok(
        await owner.call("post", "procurement/rfqs", {
          requisitionIds: [requisition.requisition.id],
          supplierIds: [supplierId],
        }),
        201,
      ),
    );
    rfq = rfqDetailResponseSchema.parse(
      ok(
        await owner.call("post", `procurement/rfqs/${rfq.rfq.id}/quotations`, {
          supplierId,
          reference: "Q-D72",
          quotedOn: today,
          validUntil: addCalendarDays(today, 30),
          deliveryDays: 3,
          lines: rfq.lines.map((line, index) => ({
            requisitionLineId: line.requisitionLineId,
            priceUnit: "t",
            unitPriceMinor: lines[index]!.price,
            vatTreatment: "exclusive",
          })),
        }),
        201,
      ),
    );
    let lpo = lpoDetailResponseSchema.parse(
      ok(
        await owner.call("post", `procurement/rfqs/${rfq.rfq.id}/award`, {
          version: rfq.rfq.version,
          quotationId: rfq.quotations[0]!.id,
          deliverySiteId: project === projectId ? siteId : null,
          deliveryDate: addCalendarDays(today, 3),
          terms: "Deliver to the main yard gate (synthetic).",
        }),
        201,
      ),
    );
    if (!approve) return lpo;
    lpo = lpoDetailResponseSchema.parse(
      ok(
        await owner.call("post", `procurement/lpos/${lpo.lpo.id}/submit`, {
          version: lpo.lpo.version,
        }),
      ),
    );
    await fresh(pm);
    return lpoDetailResponseSchema.parse(
      ok(
        await pm.call("post", `procurement/lpos/${lpo.lpo.id}/approve`, {
          version: lpo.lpo.version,
        }),
      ),
    );
  };
  const submit = (browser: Browser, body: object, key: string) =>
    browser.call("post", "portal/supplier/invoices", body, true, { "Idempotency-Key": key });
  const invoiceBody = (overrides: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    lpoId: lpoA.lpo.id,
    invoiceNumber: "A-1001",
    invoiceDate: addCalendarDays(today, -10),
    etimsInvoiceNumber: ETIMS,
    // 14 t × 200,000 = 2,800,000; VAT 16 % = 448,000; total 3,248,000.
    subtotalMinor: 2_800_000,
    vatMinor: 448_000,
    totalMinor: 3_248_000,
    lines: [
      {
        lpoLineId: lpoA.lines[0]!.id,
        quantity: "14",
        unitPriceMinor: 200_000,
        vatTreatment: "exclusive",
      },
    ],
    ...overrides,
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
    finance = new Browser(app);
    pm = new Browser(app);
    agent = new Browser(app);
    ownerB = new Browser(app);
    supA = new Browser(app);
    supB = new Browser(app);
    supC = new Browser(app);
    for (const browser of [owner, finance, pm, ownerB]) {
      await browser.register();
      await browser.enroll();
    }
    for (const browser of [agent, supA, supB, supC]) await browser.register();
    const a = await owner.call("post", "tenants", { name: "Supplier portal company A" });
    const b = await ownerB.call("post", "tenants", { name: "Supplier portal company B" });
    tenantA = (ok(a, 201) as { tenant: { id: string } }).tenant.id;
    tenantB = (ok(b, 201) as { tenant: { id: string } }).tenant.id;
    await fresh(owner);
    projectId = projectResponseSchema.parse(
      ok(await owner.call("post", "projects", { name: "Portal project (synthetic)" }), 201),
    ).project.id;
    otherProjectId = projectResponseSchema.parse(
      ok(await owner.call("post", "projects", { name: "Other project (synthetic)" }), 201),
    ).project.id;
    siteId = siteResponseSchema.parse(
      ok(
        await owner.call("post", `projects/${projectId}/sites`, {
          name: "Main yard",
          address: "Off Kangundo Road (synthetic)",
          geofence: { kind: "radius", center: SITE, radiusM: 200 },
        }),
        201,
      ),
    ).site.id;
    await join(finance, "finance", []);
    await join(pm, "project_manager", [projectId, otherProjectId]);
    await join(agent, "site_agent", [projectId]);
    ok(await owner.call("post", "materials/defaults", {}));
    const materials = materialsResponseSchema.parse(
      ok(await owner.call("get", "materials?limit=200")),
    ).materials;
    material.sand = materials.find((entry) => entry.name === "River sand")!.id;
    material.ballast = materials.find((entry) => entry.name === "Ballast 20 mm")!.id;
    const settings = (
      ok(await owner.call("get", "procurement/settings")) as {
        settings: { version: number };
      }
    ).settings;
    ok(
      await owner.call("put", "procurement/settings", {
        priceChangeAlertPercent: "10",
        minQuotes: 1,
        version: settings.version,
      }),
    );
    for (const [key, name] of [
      ["a", "Quarry A (synthetic)"],
      ["b", "Depot B (synthetic)"],
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
    await fresh(ownerB);
    supplier.c = supplierDetailResponseSchema.parse(
      ok(
        await ownerB.call("post", "suppliers", {
          legalName: "Company B's quarry (synthetic)",
          etimsStatus: "registered",
          creditDays: 30,
        }),
        201,
      ),
    ).supplier.id;
    // Supplier A's Paybill, proposed by the owner and verified by finance (needed for approval).
    await fresh(owner);
    const proposed = supplierDetailResponseSchema.parse(
      ok(
        await owner.call("post", `suppliers/${supplier.a}/payout-details`, {
          replaces: null,
          mpesaKind: "paybill",
          paybillNumber: "600100",
          accountReference: "D72-TEST",
        }),
        201,
      ),
    );
    await fresh(finance);
    ok(
      await finance.call(
        "post",
        `suppliers/${supplier.a}/payout-details/${proposed.payout.current!.id}/verify`,
        { method: "call_back_known_number", note: "Called the number on file (test)." },
      ),
    );
    // LPO-A: 21 t sand at KES 2,000 and 10 t ballast at KES 2,200 per t, excl. VAT:
    // 4,200,000 + 2,200,000 = 6,400,000; VAT 1,024,000; total 7,424,000.
    lpoA = await order(supplier.a, [
      { materialId: material.sand, quantity: "21", price: 200_000 },
      { materialId: material.ballast, quantity: "10", price: 220_000 },
    ]);
    // A draft LPO to A that was never approved, and an approved LPO to B on another project.
    draftLpoA = await order(
      supplier.a,
      [{ materialId: material.sand, quantity: "5", price: 200_000 }],
      false,
    );
    lpoB = await order(
      supplier.b,
      [{ materialId: material.sand, quantity: "5", price: 210_000 }],
      true,
      otherProjectId,
    );
  }, 300_000);

  afterAll(async () => {
    notificationSpy?.mockRestore();
    await app?.close();
  });

  it("documents every D7.2 operation in OpenAPI", async () => {
    const openApi = await request(app.getHttpServer()).get("/api/docs/openapi.json").expect(200);
    const operations = Object.values(
      (openApi.body as { paths: Record<string, Record<string, { operationId?: string }>> }).paths,
    ).flatMap((path) => Object.values(path).map((operation) => operation.operationId));
    for (const id of [
      "getSupplierPortal",
      "listSupplierPortalLpos",
      "getSupplierPortalLpo",
      "acknowledgeSupplierPortalLpo",
      "listSupplierPortalDeliveries",
      "listSupplierPortalInvoices",
      "submitSupplierPortalInvoice",
      "getSupplierPortalInvoice",
      "uploadSupplierPortalInvoiceDocument",
      "downloadSupplierPortalDocument",
      "getSupplierPortalStatement",
      "exportSupplierPortalStatementPdf",
      "exportSupplierPortalStatementExcel",
      "listSupplierPortalUsers",
      "inviteSupplierPortalUser",
      "revokeSupplierPortalUser",
    ])
      expect(operations, id).toContain(id);
  });

  it("invites a supplier's contacts, binds each to exactly one supplier and lands them in the supplier portal", async () => {
    // Inviting is for procurement or company-wide finance, with a step-up.
    refused(
      await pm.call("post", `suppliers/${supplier.a}/portal-users`, {
        identifier: supA.identifier,
        contactName: "Accounts clerk",
      }),
      403,
    );
    await prisma.session.update({
      where: { id: owner.auth.session.id },
      data: { mfaVerifiedAt: new Date(Date.now() - 10 * 60_000) },
    });
    refused(
      await owner.call("post", `suppliers/${supplier.a}/portal-users`, {
        identifier: supA.identifier,
        contactName: "Accounts clerk",
      }),
      403,
      "step-up-required",
    );
    // A staff member's identifier is already a member of the company.
    await fresh(owner);
    refused(
      await owner.call("post", `suppliers/${supplier.a}/portal-users`, {
        identifier: agent.identifier,
        contactName: "Not a supplier",
      }),
      409,
      "already-member",
    );
    const { user } = await inviteContact(owner, supA, supplier.a, tenantA);
    expect(user).toMatchObject({ status: "invited", identifier: supA.identifier });
    // The same contact cannot be invited again while access is open (any supplier).
    await fresh(finance);
    refused(
      await finance.call("post", `suppliers/${supplier.b}/portal-users`, {
        identifier: supA.identifier,
        contactName: "Same person",
      }),
      409,
      "portal-user-exists",
    );
    await inviteContact(finance, supB, supplier.b, tenantA);
    await inviteContact(ownerB, supC, supplier.c, tenantB);
    const listed = supplierPortalUsersResponseSchema.parse(
      ok(await finance.call("get", `suppliers/${supplier.a}/portal-users`)),
    );
    expect(listed.users).toHaveLength(1);
    expect(listed.users[0]).toMatchObject({
      status: "active",
      account: { id: supA.auth.user.id },
      invitationExpiresAt: null,
      submittedInvoices: 0,
    });
    expect(listed.permissions).toEqual({ canInvite: true, canRevoke: true });
    refused(await pm.call("get", `suppliers/${supplier.a}/portal-users`), 403);
    refused(await ownerB.call("get", `suppliers/${supplier.a}/portal-users`), 404);
    // Supplier users are routed to the supplier portal and hold nothing else.
    const company = tenantsResponseSchema
      .parse(ok(await supA.call("get", "tenants")))
      .tenants.find((tenant) => tenant.id === tenantA)!;
    expect(company.role).toBe("supplier");
    expect(portalFor(company.permissions)).toBe("supplier");
    const home = supplierPortalOverviewResponseSchema.parse(
      ok(await supA.call("get", "portal/supplier")),
    );
    expect(home).toMatchObject({
      supplier: { id: supplier.a, name: "Quarry A (synthetic)" },
      counts: { openLpos: 1, unacknowledgedLpos: 1, deliveries: 0, invoicesUnderReview: 0 },
      outstandingMinor: 0,
      permissions: { canSubmitInvoices: true },
    });
    expect(home.projects.map((project) => project.id)).toEqual([projectId]);
    // Staff get no supplier portal; a supplier contact is never assigned to a project.
    refused(await owner.call("get", "portal/supplier"), 403);
    await fresh(owner);
    refused(
      await owner.call("put", `projects/${projectId}/members/${supA.auth.user.id}`, {
        permissions: ["projects.view"],
      }),
      409,
      "supplier-portal-user",
    );
    await expect(
      asUser(
        owner,
        (tx) =>
          tx.$executeRaw`INSERT INTO project_memberships (tenant_id, project_id, user_id, permissions)
          VALUES (${tenantA}::uuid, ${projectId}::uuid, ${supA.auth.user.id}::uuid, '{projects.view}')`,
      ),
    ).rejects.toThrow(/scoped by their supplier, never by a project/);
  });

  it("DONE-WHEN: a supplier sees an approved LPO addressed to them and submits an invoice that waits in the staff queue for the three-way match", async () => {
    const lpos = portalLposResponseSchema.parse(ok(await supA.call("get", "portal/supplier/lpos")));
    // Only the approved LPO: never the draft, never supplier B's.
    expect(lpos.lpos.map((entry) => entry.id)).toEqual([lpoA.lpo.id]);
    expect(lpos.lpos[0]).toMatchObject({
      number: lpoA.lpo.number,
      status: "approved",
      deliveryState: "none",
      subtotalMinor: 6_400_000,
      vatMinor: 1_024_000,
      totalMinor: 7_424_000,
      creditDays: 30,
      deliverySite: { id: siteId, name: "Main yard", address: "Off Kangundo Road (synthetic)" },
      acknowledgement: null,
    });
    refused(await supA.call("get", `portal/supplier/lpos/${draftLpoA.lpo.id}`), 404);
    let detail = portalLpoDetailResponseSchema.parse(
      ok(await supA.call("get", `portal/supplier/lpos/${lpoA.lpo.id}`)),
    );
    expect(detail.terms).toBe("Deliver to the main yard gate (synthetic).");
    expect(
      detail.lines.map((line) => [
        line.material.name,
        line.quantity,
        line.unitPriceMinor,
        line.netAmountMinor,
      ]),
    ).toEqual([
      ["River sand", "21", 200_000, 4_200_000],
      ["Ballast 20 mm", "10", 220_000, 2_200_000],
    ]);
    expect(detail.permissions).toEqual({ canAcknowledge: true, canInvoice: true });
    // Acknowledge once (time and user); the LPO and its approval do not change.
    detail = portalLpoDetailResponseSchema.parse(
      ok(await supA.call("post", `portal/supplier/lpos/${lpoA.lpo.id}/acknowledge`, {})),
    );
    expect(detail.lpo.acknowledgement?.acknowledgedBy.id).toBe(supA.auth.user.id);
    refused(
      await supA.call("post", `portal/supplier/lpos/${lpoA.lpo.id}/acknowledge`, {}),
      409,
      "lpo-already-acknowledged",
    );
    const staffLpo = lpoDetailResponseSchema.parse(
      ok(await owner.call("get", `procurement/lpos/${lpoA.lpo.id}`)),
    );
    expect(staffLpo.lpo.status).toBe("approved");
    expect(staffLpo.lpo.version).toBe(lpoA.lpo.version);
    expect(staffLpo.acknowledgement?.acknowledgedBy.id).toBe(supA.auth.user.id);

    // A delivery: 14 t of sand, 10 t of ballast with 1 t rejected (9 t accepted).
    grnId = randomUUID();
    ok(
      await agent.call(
        "post",
        "procurement/grns",
        {
          id: grnId,
          lpoId: lpoA.lpo.id,
          capturedAt: new Date().toISOString(),
          receivedByName: "Mary Wanjiku (synthetic)",
          vehicleRegistration: "KDA 123A",
          deliveryNoteNumber: "DN-D72-1",
          notes: "Internal: driver late, gate log page 4",
          location: { latitude: SITE.lat, longitude: SITE.lng, accuracyM: 10 },
          lines: [
            { lpoLineId: lpoA.lines[0]!.id, receivedQuantity: "14" },
            {
              lpoLineId: lpoA.lines[1]!.id,
              receivedQuantity: "10",
              rejectedQuantity: "1",
              rejectionReason: "Wet ballast",
            },
          ],
        },
        true,
        { "Idempotency-Key": `grn-${grnId}` },
      ),
      201,
    );
    const deliveries = portalDeliveriesResponseSchema.parse(
      ok(await supA.call("get", "portal/supplier/deliveries")),
    );
    expect(deliveries.deliveries).toHaveLength(1);
    expect(deliveries.deliveries[0]).toMatchObject({
      id: grnId,
      status: "recorded",
      deliveryNoteNumber: "DN-D72-1",
      vehicleRegistration: "KDA 123A",
      site: { id: siteId, name: "Main yard" },
    });
    expect(
      deliveries.deliveries[0]!.lines.map((line) => [
        line.receivedQuantity,
        line.rejectedQuantity,
        line.rejectionReason,
        line.acceptedBaseQuantity,
      ]),
    ).toEqual([
      ["14", "0", null, "14"],
      ["10", "1", "Wet ballast", "9"],
    ]);
    // Never internal notes, GPS, photos or the receiver's name.
    const wire = JSON.stringify(deliveries);
    for (const hidden of ["driver late", "Mary Wanjiku", "latitude", "photos", "-1.2921"])
      expect(wire, hidden).not.toContain(hidden);

    // Submit: client ID + Idempotency-Key; 14 t of sand, as received.
    refused(
      await supA.call("post", "portal/supplier/invoices", invoiceBody()),
      400,
      "idempotency-key-required",
    );
    const body = invoiceBody();
    invoiceOne = body.id;
    const first = await submit(supA, body, `inv-${body.id}`);
    const submitted = portalInvoiceDetailResponseSchema.parse(ok(first, 201));
    expect(submitted.replayed).toBe(false);
    expect(submitted.invoice).toMatchObject({
      id: invoiceOne,
      invoiceNumber: "A-1001",
      status: "under_review",
      source: "supplier_portal",
      etimsInvoiceNumber: ETIMS,
      etimsFormat: "etims",
      totalMinor: 3_248_000,
      paidMinor: 0,
      outstandingMinor: 0,
      dueDate: addCalendarDays(today, 20),
    });
    // The same workflow the staff use: matched by the three-way match, waiting for approval.
    const queue = invoicesResponseSchema.parse(
      ok(await owner.call("get", "procurement/invoices?source=supplier_portal")),
    );
    expect(queue.invoices.map((invoice) => [invoice.id, invoice.status, invoice.source])).toEqual([
      [invoiceOne, "matched", "supplier_portal"],
    ]);
    const staffView = invoiceDetailResponseSchema.parse(
      ok(await owner.call("get", `procurement/invoices/${invoiceOne}`)),
    );
    expect(staffView.match).toMatchObject({ outcome: "matched", passing: true, current: true });
    expect(staffView.invoice.submittedBy?.id).toBe(supA.auth.user.id);
    expect(staffView.permissions).toMatchObject({ canApprove: true, canReopen: false });
    const inbox = inboxResponseSchema.parse(ok(await owner.call("get", "procurement/inbox")));
    expect(inbox.items).toContainEqual(
      expect.objectContaining({ kind: "invoice-approval", id: invoiceOne }),
    );
    const companyList = invoicesResponseSchema.parse(
      ok(await owner.call("get", "procurement/invoices?source=company")),
    );
    expect(companyList.invoices.map((invoice) => invoice.id)).not.toContain(invoiceOne);
    // The PDF goes through the upload guard and the malware hook.
    const uploaded = await supA.upload(
      `portal/supplier/invoices/${invoiceOne}/document`,
      PDF,
      "a-1001.pdf",
    );
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
    documentId = (uploaded.body as { document: { id: string } }).document.id;
    const withDocument = invoiceDetailResponseSchema.parse(
      ok(await owner.call("get", `procurement/invoices/${invoiceOne}`)),
    );
    expect(withDocument.documents.map((document) => [document.id, document.contentType])).toEqual([
      [documentId, "application/pdf"],
    ]);
    const downloaded = await supA.download(`portal/supplier/documents/${documentId}`);
    expect(downloaded.status).toBe(200);
    expect((downloaded.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");

    // Offline replay: the same key and payload return the original; changes are refused.
    const replay = await submit(supA, body, `inv-${body.id}`);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(portalInvoiceDetailResponseSchema.parse(ok(replay, 201))).toMatchObject({
      replayed: true,
      invoice: { id: invoiceOne, status: "under_review" },
    });
    refused(
      await submit(supA, { ...body, notes: "changed" }, `inv-${body.id}`),
      409,
      "idempotency-key-reused",
    );
    refused(await submit(supA, body, `other-${body.id}`), 409, "invoice-id-conflict");
    const count = await asUser(
      owner,
      (tx) =>
        tx.$queryRaw<{ total: bigint }[]>`SELECT count(*) AS total FROM supplier_invoices
        WHERE supplier_id = ${supplier.a}::uuid`,
    );
    expect(Number(count[0]!.total)).toBe(1);
  });

  it("refuses duplicate invoice numbers and malformed eTIMS numbers; shows a supplier why an invoice is disputed", async () => {
    // "a 1001" is the same supplier invoice number as "A-1001" (normalised key).
    refused(
      await submit(supA, invoiceBody({ invoiceNumber: "a 1001" }), `dup-${randomUUID()}`),
      409,
      "invoice-number-taken",
    );
    refused(
      await submit(
        supA,
        invoiceBody({ invoiceNumber: "A-2001", etimsInvoiceNumber: "!!" }),
        `etims-${randomUUID()}`,
      ),
      400,
    );
    refused(
      await submit(
        supA,
        invoiceBody({ invoiceNumber: "A-2002", etimsInvoiceNumber: null }),
        `etims-${randomUUID()}`,
      ),
      400,
    );
    refused(
      await submit(
        supA,
        invoiceBody({ invoiceNumber: "A-2003", invoiceDate: addCalendarDays(today, 1) }),
        `date-${randomUUID()}`,
      ),
      422,
      "invoice-date-invalid",
    );
    // Supplier B's LPO, a draft LPO and another company's IDs are unknown here.
    refused(
      await submit(
        supA,
        invoiceBody({ invoiceNumber: "A-2004", lpoId: lpoB.lpo.id }),
        `b-${randomUUID()}`,
      ),
      404,
    );
    refused(
      await submit(
        supA,
        invoiceBody({ invoiceNumber: "A-2005", lpoId: draftLpoA.lpo.id }),
        `d-${randomUUID()}`,
      ),
      404,
    );
    // 10 t of ballast billed while 9 t were accepted: disputed, and the supplier sees why.
    const body = invoiceBody({
      invoiceNumber: "A-1003",
      invoiceDate: today,
      etimsInvoiceNumber: "KRACU0100000001/503",
      subtotalMinor: 2_200_000,
      vatMinor: 352_000,
      totalMinor: 2_552_000,
      lines: [
        {
          lpoLineId: lpoA.lines[1]!.id,
          quantity: "10",
          unitPriceMinor: 220_000,
          vatTreatment: "exclusive",
        },
      ],
    });
    invoiceDisputed = body.id;
    const disputed = portalInvoiceDetailResponseSchema.parse(
      ok(await submit(supA, body, `inv-${body.id}`), 201),
    );
    expect(disputed.invoice.status).toBe("disputed");
    expect(disputed.dispute?.reasons).toContain("qty-exceeds-received");
    expect(disputed.dispute?.lines).toEqual([{ lineNo: 2, reasons: ["qty-exceeds-received"] }]);
    const lpo = portalLpoDetailResponseSchema.parse(
      ok(await supA.call("get", `portal/supplier/lpos/${lpoA.lpo.id}`)),
    );
    // Sand: 14 received, 14 under review → nothing more to invoice; ballast 9 received, 10 held.
    expect(
      lpo.lines.map((line) => [
        line.receivedBaseQuantity,
        line.invoicedBaseQuantity,
        line.pendingBaseQuantity,
        line.invoiceableBaseQuantity,
      ]),
    ).toEqual([
      ["14", "0", "14", "0"],
      ["9", "0", "10", "0"],
    ]);
    const disputedOnly = portalInvoicesResponseSchema.parse(
      ok(await supA.call("get", "portal/supplier/invoices?status=disputed")),
    );
    expect(disputedOnly.invoices.map((invoice) => invoice.id)).toEqual([invoiceDisputed]);
  });

  it("never lets a supplier approve, settle, reopen or edit — in the API or the database", async () => {
    for (const [method, path, payload] of [
      ["get", `procurement/invoices/${invoiceOne}`, undefined],
      ["patch", `procurement/invoices/${invoiceOne}`, { version: 1, notes: "edit" }],
      [
        "post",
        `procurement/invoices/${invoiceOne}/approve`,
        { version: 1, matchId: randomUUID(), payoutVersionId: randomUUID() },
      ],
      ["post", `procurement/invoices/${invoiceOne}/reopen`, { version: 1 }],
      ["post", `procurement/invoices/${invoiceOne}/cancel`, { version: 1, reason: "mine" }],
      ["post", `procurement/lpos/${lpoA.lpo.id}/cancel`, { version: 1, reason: "mine" }],
      ["get", `suppliers/${supplier.a}`, undefined],
      ["get", "suppliers", undefined],
      ["get", `suppliers/${supplier.a}/portal-users`, undefined],
      ["get", `spending/projects/${projectId}`, undefined],
      ["get", `projects/${projectId}/bq`, undefined],
    ] as const)
      expect((await supA.call(method, path, payload)).status, `${method} ${path}`).toBe(403);
    refused(
      await supA.call(
        "post",
        `procurement/invoices/${invoiceOne}/settlements`,
        { method: "bank_transfer", externalReference: "MINE-1", amountMinor: 1, paidOn: today },
        true,
        { "Idempotency-Key": `settle-${randomUUID()}` },
      ),
      403,
    );
    // Staff never reopen a supplier's invoice: cancel it with a reason and ask for a new one.
    const staff = invoiceDetailResponseSchema.parse(
      ok(await owner.call("get", `procurement/invoices/${invoiceDisputed}`)),
    );
    refused(
      await owner.call("post", `procurement/invoices/${invoiceDisputed}/reopen`, {
        version: staff.invoice.version,
      }),
      409,
      "supplier-invoice-locked",
    );
    await expect(
      asUser(
        owner,
        (tx) =>
          tx.$executeRaw`UPDATE supplier_invoices SET status = 'draft', submitted_by = NULL,
          submitted_at = NULL, version = version + 1 WHERE id = ${invoiceDisputed}::uuid`,
      ),
    ).rejects.toThrow(/never reopened/);
    // Direct SQL as the supplier (pmb_app): cancelling its own submitted invoice is refused.
    await expect(
      asUser(
        supA,
        (tx) =>
          tx.$executeRaw`UPDATE supplier_invoices SET status = 'cancelled', cancelled_at = now(),
          cancelled_by = ${supA.auth.user.id}::uuid, cancel_reason = 'Supplier cancelling',
          version = version + 1 WHERE id = ${invoiceOne}::uuid`,
      ),
    ).rejects.toThrow(/never approves, settles, reopens, cancels or edits/);
    await expect(
      asUser(
        supA,
        (tx) =>
          tx.$executeRaw`UPDATE three_way_matches SET exception_reason = 'mine',
          exception_by = ${supA.auth.user.id}::uuid, exception_at = now()
          WHERE invoice_id = ${invoiceDisputed}::uuid`,
      ),
    ).rejects.toThrow();
    // Approval and settlement stay with independent staff; the supplier never pays itself.
    const approvable = invoiceDetailResponseSchema.parse(
      ok(await owner.call("get", `procurement/invoices/${invoiceOne}`)),
    );
    await fresh(owner);
    const approved = invoiceDetailResponseSchema.parse(
      ok(
        await owner.call("post", `procurement/invoices/${invoiceOne}/approve`, {
          version: approvable.invoice.version,
          matchId: approvable.match!.id,
          payoutVersionId: approvable.payee!.id,
        }),
      ),
    );
    expect(approved.invoice.status).toBe("approved");
    const settlementId = randomUUID();
    await expect(
      asUser(
        supA,
        (tx) =>
          tx.$executeRaw`INSERT INTO invoice_settlements (id, tenant_id, invoice_id, payable_id,
          method, external_reference, reference_key, amount_minor, paid_on, idempotency_key,
          request_digest, recorded_by)
          VALUES (${settlementId}::uuid, ${tenantA}::uuid, ${invoiceOne}::uuid,
            ${approved.payable!.id}::uuid, 'other', 'SELF-PAID', 'SELFPAID', 100, ${today}::date,
            ${`self-${settlementId}`}, ${"a".repeat(64)}, ${supA.auth.user.id}::uuid)`,
      ),
    ).rejects.toThrow(/A supplier never changes invoice_settlements rows/);
    await fresh(finance);
    ok(
      await finance.call(
        "post",
        `procurement/invoices/${invoiceOne}/settlements`,
        {
          method: "bank_transfer",
          externalReference: "FT-SUP-0001",
          amountMinor: 1_000_000,
          paidOn: today,
          note: "Internal: paid from the Equity account (synthetic)",
        },
        true,
        { "Idempotency-Key": `settle-${invoiceOne}` },
      ),
      201,
    );
    const paid = portalInvoiceDetailResponseSchema.parse(
      ok(await supA.call("get", `portal/supplier/invoices/${invoiceOne}`)),
    );
    expect(paid.invoice).toMatchObject({
      status: "partly_paid",
      paidMinor: 1_000_000,
      outstandingMinor: 2_248_000,
      overdue: false,
    });
    expect(paid.payments).toEqual([
      {
        id: expect.any(String),
        amountMinor: 1_000_000,
        paidOn: today,
        method: "bank_transfer",
        reference: "FT-SUP-0001",
      },
    ]);
    expect(JSON.stringify(paid)).not.toContain("Equity account");
  });

  it("counts and labels invoice documents per supplier across its portal users, also under parallel uploads", async () => {
    // A colleague at supplier A: a second portal user of the same supplier.
    const colleague = new Browser(app);
    await colleague.register();
    await inviteContact(owner, colleague, supplier.a, tenantA);
    const path = `portal/supplier/invoices/${invoiceOne}/document`;
    const second = await colleague.upload(path, PDF, "a-1001-delivery.pdf");
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    const detail = async () =>
      portalInvoiceDetailResponseSchema.parse(
        ok(await supA.call("get", `portal/supplier/invoices/${invoiceOne}`)),
      );
    // supA sees the colleague's upload as the supplier's, not the company's.
    expect((await detail()).documents.map((document) => document.uploadedBySupplier)).toEqual([
      true,
      true,
    ]);
    expect((await detail()).permissions.canAttach).toBe(true);
    // Two more at once: the limit (3 from the supplier, whoever uploads) admits only one.
    const racing = await Promise.all([
      supA.upload(path, PDF, "a-1001-copy.pdf"),
      colleague.upload(path, PDF, "a-1001-copy-2.pdf"),
    ]);
    expect(racing.map((res) => res.status).sort()).toEqual([201, 409]);
    expect(problem(racing.find((res) => res.status === 409)!)).toBe("too-many-documents");
    refused(await colleague.upload(path, PDF, "a-1001-late.pdf"), 409, "too-many-documents");
    // A staff upload is stamped as the company's and does not count against the supplier.
    const staff = await owner.upload(
      `procurement/invoices/${invoiceOne}/document`,
      PDF,
      "a-1001-file-copy.pdf",
    );
    expect(staff.status, JSON.stringify(staff.body)).toBe(201);
    const full = await detail();
    expect(full.documents.map((document) => document.uploadedBySupplier)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(full.permissions.canAttach).toBe(false);
    // The database repeats the limit and decides the label itself.
    const insert = (browser: Browser) => {
      const id = randomUUID();
      return asUser(
        browser,
        (tx) => tx.$executeRaw`INSERT INTO procurement_documents (id, tenant_id, project_id, kind,
          invoice_id, object_key, content_type, size_bytes, sha256, scan_status, scan_engine,
          scanned_at, uploaded_by, uploaded_by_supplier)
          VALUES (${id}::uuid, ${tenantA}::uuid, ${projectId}::uuid, 'invoice', ${invoiceOne}::uuid,
          ${`tenants/${tenantA}/projects/${projectId}/procurement/invoice/${id}`}, 'application/pdf',
          5, ${"0".repeat(64)}, 'clean', 'direct-sql', now(), ${browser.auth.user.id}::uuid, false)`,
      );
    };
    await expect(insert(colleague)).rejects.toThrow(/at most 3 documents from the supplier/);
  });

  it("keeps suppliers apart (supplier B, another company) in the API and with direct SQL", async () => {
    const apiKeepsThemApart = async () => {
      const lposB = portalLposResponseSchema.parse(
        ok(await supB.call("get", "portal/supplier/lpos")),
      );
      expect(lposB.lpos.map((entry) => entry.id)).toEqual([lpoB.lpo.id]);
      for (const path of [
        `portal/supplier/lpos/${lpoA.lpo.id}`,
        `portal/supplier/invoices/${invoiceOne}`,
        `portal/supplier/documents/${documentId}`,
        `portal/supplier/statement?projectId=${projectId}`,
      ]) {
        refused(await supB.call("get", path), 404);
        refused(await supC.call("get", path), 404);
      }
      refused(await supB.call("post", `portal/supplier/lpos/${lpoA.lpo.id}/acknowledge`, {}), 404);
      const deliveriesB = portalDeliveriesResponseSchema.parse(
        ok(await supB.call("get", `portal/supplier/deliveries?lpoId=${lpoA.lpo.id}`)),
      );
      expect(deliveriesB.deliveries).toEqual([]);
      const invoicesB = portalInvoicesResponseSchema.parse(
        ok(await supB.call("get", "portal/supplier/invoices")),
      );
      expect(invoicesB.invoices).toEqual([]);
      const statementB = supplierStatementResponseSchema.parse(
        ok(await supB.call("get", "portal/supplier/statement")),
      );
      expect(statementB).toMatchObject({ openingMinor: 0, closingMinor: 0, entries: [] });
    };
    await apiKeepsThemApart();
    // The API's own filters, not only the database: with every supplier policy relaxed to `true`
    // (as the schema owner, restored afterwards), supplier B still reaches none of A's records.
    const schemaOwner = new PrismaClient({
      adapter: new PrismaPg({ connectionString: testDatabaseUrls().migrationUrl }),
    });
    const policies = await schemaOwner.$queryRaw<
      { tablename: string; policyname: string; qual: string; with_check: string }[]
    >`SELECT tablename, policyname, qual, with_check FROM pg_policies
      WHERE policyname LIKE '%supplier_portal' AND permissive = 'RESTRICTIVE'`;
    expect(policies.length).toBeGreaterThanOrEqual(30);
    try {
      for (const policy of policies)
        await schemaOwner.$executeRawUnsafe(
          `ALTER POLICY "${policy.policyname}" ON "${policy.tablename}" USING (true) WITH CHECK (true)`,
        );
      await apiKeepsThemApart();
    } finally {
      for (const policy of policies)
        await schemaOwner.$executeRawUnsafe(
          `ALTER POLICY "${policy.policyname}" ON "${policy.tablename}" USING (${policy.qual}) WITH CHECK (${policy.with_check})`,
        );
      await schemaOwner.$disconnect();
    }
    const homeC = supplierPortalOverviewResponseSchema.parse(
      ok(await supC.call("get", "portal/supplier")),
    );
    expect(homeC).toMatchObject({ counts: { openLpos: 0 }, outstandingMinor: 0, projects: [] });
    // The database repeats it: supplier B, as the runtime role in company A, reads only B's rows.
    const seen = await asUser(
      supB,
      (tx) =>
        tx.$queryRaw<{ table: string; total: bigint }[]>`
        SELECT 'lpos' AS table, count(*) AS total FROM lpos
        UNION ALL SELECT 'lpo_lines', count(*) FROM lpo_lines
        UNION ALL SELECT 'grns', count(*) FROM grns
        UNION ALL SELECT 'supplier_invoices', count(*) FROM supplier_invoices
        UNION ALL SELECT 'invoice_settlements', count(*) FROM invoice_settlements
        UNION ALL SELECT 'procurement_documents', count(*) FROM procurement_documents
        UNION ALL SELECT 'suppliers', count(*) FROM suppliers
        UNION ALL SELECT 'quotations', count(*) FROM quotations
        UNION ALL SELECT 'material_prices', count(*) FROM material_prices WHERE supplier_id IS NOT NULL
        UNION ALL SELECT 'supplier_portal_users', count(*) FROM supplier_portal_users`,
    );
    expect(Object.fromEntries(seen.map((row) => [row.table, Number(row.total)]))).toEqual({
      lpos: 1,
      lpo_lines: 1,
      grns: 0,
      supplier_invoices: 0,
      invoice_settlements: 0,
      procurement_documents: 0,
      suppliers: 1,
      quotations: 1,
      material_prices: 1,
      supplier_portal_users: 1,
    });
    // Staff are not restricted by the supplier policies.
    const staffSees = await asUser(
      owner,
      (tx) => tx.$queryRaw<{ total: bigint }[]>`SELECT count(*) AS total FROM lpos`,
    );
    expect(Number(staffSees[0]!.total)).toBe(3);
    // Another supplier's rows are invisible to update (USING) …
    await expect(
      asUser(
        supB,
        (tx) => tx.$executeRaw`UPDATE suppliers SET notes = 'x' WHERE id = ${supplier.a}::uuid`,
      ),
    ).resolves.toBe(0);
    // … and cannot be written either (WITH CHECK): a contact for supplier A, inserted by B.
    await expect(
      asUser(
        supB,
        (tx) => tx.$executeRaw`INSERT INTO supplier_contacts (id, tenant_id, supplier_id, name)
          VALUES (${randomUUID()}::uuid, ${tenantA}::uuid, ${supplier.a}::uuid, 'Not B''s')`,
      ),
    ).rejects.toThrow(/row-level security/);
    // The company's own rows about suppliers (requisitions, RFQs, the cost ledger and journals,
    // petty cash, plant) are never a supplier's, though staff see them.
    const internal = (browser: Browser) =>
      asUser(
        browser,
        (tx) =>
          tx.$queryRaw<{ table: string; total: bigint }[]>`
          SELECT 'requisitions' AS table, count(*) AS total FROM requisitions
          UNION ALL SELECT 'requisition_lines', count(*) FROM requisition_lines
          UNION ALL SELECT 'rfqs', count(*) FROM rfqs
          UNION ALL SELECT 'rfq_requisitions', count(*) FROM rfq_requisitions
          UNION ALL SELECT 'cost_entries', count(*) FROM cost_entries
          UNION ALL SELECT 'cost_journal_lines', count(*) FROM cost_journal_lines
          UNION ALL SELECT 'petty_cash_expenses', count(*) FROM petty_cash_expenses
          UNION ALL SELECT 'plant_items', count(*) FROM plant_items`,
      ).then((rows) => Object.fromEntries(rows.map((row) => [row.table, Number(row.total)])));
    expect(Object.values(await internal(supB))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    const staffRows = await internal(owner);
    expect(staffRows.requisitions).toBeGreaterThan(0);
    expect(staffRows.rfqs).toBeGreaterThan(0);
  });

  it("states opening balance, invoices, payments and closing balance (hand-computed) and exports them", async () => {
    // Default period (the last 90 days): A-1001 (dated 10 days ago) 3,248,000 accepted; paid
    // 1,000,000 today → closing 2,248,000. A-1003 (disputed, 2,552,000) is not on the balance.
    const statement = supplierStatementResponseSchema.parse(
      ok(await supA.call("get", "portal/supplier/statement")),
    );
    expect(statement).toMatchObject({
      from: addCalendarDays(today, -89),
      to: today,
      project: null,
      openingMinor: 0,
      invoicedMinor: 3_248_000,
      paidMinor: 1_000_000,
      closingMinor: 2_248_000,
    });
    expect(
      statement.entries.map((entry) => [
        entry.kind,
        entry.date,
        entry.invoiceNumber,
        entry.debitMinor,
        entry.creditMinor,
        entry.balanceMinor,
        entry.reference,
      ]),
    ).toEqual([
      ["invoice", addCalendarDays(today, -10), "A-1001", 3_248_000, 0, 3_248_000, null],
      ["payment", today, "A-1001", 0, 1_000_000, 2_248_000, "FT-SUP-0001"],
    ]);
    expect(statement.outstanding).toEqual([
      expect.objectContaining({
        invoiceId: invoiceOne,
        totalMinor: 3_248_000,
        paidMinor: 1_000_000,
        outstandingMinor: 2_248_000,
        overdue: false,
      }),
    ]);
    expect(statement.notAccepted).toEqual([
      expect.objectContaining({
        invoiceId: invoiceDisputed,
        totalMinor: 2_552_000,
        status: "disputed",
      }),
    ]);
    // From five days ago: the invoice is in the opening balance (3,248,000); only the payment is
    // a line; closing 3,248,000 − 1,000,000 = 2,248,000.
    const recent = supplierStatementResponseSchema.parse(
      ok(
        await supA.call(
          "get",
          `portal/supplier/statement?projectId=${projectId}&from=${addCalendarDays(today, -5)}&to=${today}`,
        ),
      ),
    );
    expect(recent).toMatchObject({
      project: { id: projectId },
      openingMinor: 3_248_000,
      invoicedMinor: 0,
      paidMinor: 1_000_000,
      closingMinor: 2_248_000,
    });
    expect(recent.entries.map((entry) => entry.kind)).toEqual(["payment"]);
    refused(
      await supA.call(
        "get",
        `portal/supplier/statement?from=${today}&to=${addCalendarDays(today, -1)}`,
      ),
      422,
      "statement-period-invalid",
    );
    refused(
      await supA.call("get", `portal/supplier/statement?from=2023-01-01&to=${today}`),
      422,
      "statement-period-invalid",
    );
    refused(await supA.call("get", `portal/supplier/statement?projectId=${otherProjectId}`), 404);
    const home = supplierPortalOverviewResponseSchema.parse(
      ok(await supA.call("get", "portal/supplier")),
    );
    expect(home).toMatchObject({
      outstandingMinor: 2_248_000,
      counts: {
        invoicesDisputed: 1,
        invoicesAwaitingPayment: 1,
        invoicesUnderReview: 0,
        deliveries: 1,
      },
    });
    const pdf = await supA.download("portal/supplier/statement/export/pdf?locale=sw");
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
    const xlsx = await supA.download("portal/supplier/statement/export/xlsx");
    expect(xlsx.status).toBe(200);
    expect((xlsx.body as Buffer).subarray(0, 2).toString()).toBe("PK");
    expect(
      (await supB.download(`portal/supplier/statement/export/pdf?projectId=${projectId}`)).status,
    ).toBe(404);
  });

  it("ends access at once when staff revoke it or the membership ends", async () => {
    const clerk = new Browser(app);
    await clerk.register();
    const { user } = await inviteContact(owner, clerk, supplier.a, tenantA);
    ok(await clerk.call("get", "portal/supplier"));
    refused(
      await owner.call("post", `suppliers/${supplier.a}/portal-users/${user.id}/revoke`, {
        version: 2,
        reason: "x",
      }),
      400,
    );
    const revoked = supplierPortalUserResponseSchema.parse(
      ok(
        await owner.call("post", `suppliers/${supplier.a}/portal-users/${user.id}/revoke`, {
          version: 2,
          reason: "Left the supplier (synthetic)",
        }),
      ),
    );
    expect(revoked.user).toMatchObject({ status: "revoked", revokeCause: "revoked" });
    // The next request already fails because the session itself was revoked (401, not only the
    // 403 a missing membership would give).
    expect((await clerk.call("get", "portal/supplier")).status).toBe(401);
    const session = await prisma.session.findUnique({ where: { id: clerk.auth.session.id } });
    expect(session?.revokedAt).not.toBeNull();
    // Read in company A's context (RLS): the membership itself is gone, not only hidden.
    const membership = await asUser(
      owner,
      (tx) =>
        tx.$queryRaw<{ total: bigint }[]>`
        SELECT count(*) AS total FROM memberships WHERE user_id = ${clerk.auth.user.id}::uuid`,
    );
    expect(Number(membership[0]!.total)).toBe(0);
    const before = await asUser(
      owner,
      (tx) =>
        tx.$queryRaw<{ total: bigint }[]>`
        SELECT count(*) AS total FROM memberships WHERE user_id = ${owner.auth.user.id}::uuid`,
    );
    expect(Number(before[0]!.total)).toBe(1);
    refused(
      await owner.call("post", `suppliers/${supplier.a}/portal-users/${user.id}/revoke`, {
        version: 3,
        reason: "Again",
      }),
      409,
      "invalid-transition",
    );
    // A pending invitation stops working when revoked.
    const pending = new Browser(app);
    await pending.register();
    const invitation = await inviteContact(owner, pending, supplier.a, tenantA, false);
    ok(
      await owner.call(
        "post",
        `suppliers/${supplier.a}/portal-users/${invitation.user.id}/revoke`,
        {
          version: 1,
          reason: "Wrong person (synthetic)",
        },
      ),
    );
    refused(
      await pending.call("post", "tenants/invitations/accept", { token: invitation.token }),
      404,
    );
    // Removing the member (roles.manage) revokes the binding in the same transaction.
    const leaver = new Browser(app);
    await leaver.register();
    const bound = await inviteContact(owner, leaver, supplier.a, tenantA);
    await fresh(owner);
    ok(await owner.call("delete", `tenants/current/members/${leaver.auth.user.id}`));
    const after = supplierPortalUsersResponseSchema
      .parse(ok(await owner.call("get", `suppliers/${supplier.a}/portal-users`)))
      .users.find((entry) => entry.id === bound.user.id);
    expect(after).toMatchObject({ status: "revoked", revokeCause: "membership_ended" });
    // The database refuses rewriting revoked access and deleting history.
    await expect(
      asUser(
        owner,
        (tx) =>
          tx.$executeRaw`UPDATE supplier_portal_users SET status = 'active', version = version + 1
          WHERE id = ${user.id}::uuid`,
      ),
    ).rejects.toThrow(/never changes/);
    await expect(
      asUser(
        owner,
        (tx) => tx.$executeRaw`DELETE FROM supplier_portal_users WHERE id = ${user.id}::uuid`,
      ),
    ).rejects.toThrow();
  });

  it("replaces an expired or resent invitation, never someone's access or another supplier's pending invitation", async () => {
    const late = new Browser(app);
    await late.register();
    const invite = (supplierId: string) =>
      owner.call("post", `suppliers/${supplierId}/portal-users`, {
        identifier: late.identifier,
        contactName: "Accounts clerk (synthetic)",
      });
    // The contact never acted on the first invitation and it expired.
    const first = await inviteContact(owner, late, supplier.a, tenantA, false);
    await asUser(
      owner,
      (tx) => tx.$executeRaw`UPDATE invitations SET expires_at = now() - interval '1 minute'
        WHERE tenant_id = ${tenantA}::uuid AND identifier = ${late.identifier.toLowerCase()}
          AND accepted_at IS NULL`,
    );
    // Inviting again (here for supplier B) replaces the dead invitation instead of a 409.
    const again = await inviteContact(owner, late, supplier.b, tenantA, false);
    const replaced = supplierPortalUsersResponseSchema
      .parse(ok(await owner.call("get", `suppliers/${supplier.a}/portal-users`)))
      .users.find((entry) => entry.id === first.user.id);
    expect(replaced).toMatchObject({
      status: "revoked",
      revokeCause: "superseded",
      revokedBy: { id: owner.auth.user.id },
      revokeReason: null,
    });
    // A pending invitation for supplier B still blocks one for supplier A …
    await fresh(owner);
    refused(await invite(supplier.a), 409, "portal-user-exists");
    // … but resending it for B (say after a failed send) replaces it: only the newest link works.
    const resent = await inviteContact(owner, late, supplier.b, tenantA, false);
    refused(await late.call("post", "tenants/invitations/accept", { token: first.token }), 404);
    refused(await late.call("post", "tenants/invitations/accept", { token: again.token }), 404);
    ok(await late.call("post", "tenants/invitations/accept", { token: resent.token }));
    ok(await late.call("post", `tenants/${tenantA}/select`, {}));
    ok(await late.call("get", "portal/supplier"));
    // Access is never replaced by a new invitation, in the API or the database.
    await fresh(owner);
    refused(await invite(supplier.b), 409, "portal-user-exists");
    await expect(
      asUser(
        owner,
        (tx) =>
          tx.$executeRaw`UPDATE supplier_portal_users SET status = 'revoked',
            revoke_cause = 'superseded', revoked_by = ${owner.auth.user.id}::uuid,
            version = version + 1
          WHERE id = ${resent.user.id}::uuid`,
      ),
    ).rejects.toThrow(/nobody accepted/);
  });

  it("keeps amounts, identifiers and personal data out of the audit log", async () => {
    const events = await asUser(
      owner,
      (tx) =>
        tx.$queryRaw<{ action: string; metadata: unknown }[]>`
        SELECT action, metadata FROM audit_events
         WHERE tenant_id = ${tenantA}::uuid
           AND (action LIKE 'supplier_portal.%' OR action LIKE 'invoice.%')`,
    );
    const actions = new Set(events.map((event) => event.action));
    for (const action of [
      "supplier_portal.user_invited",
      "supplier_portal.user_activated",
      "supplier_portal.user_revoked",
      "supplier_portal.lpo_acknowledged",
      "supplier_portal.invoice_submitted",
      "supplier_portal.statement_exported",
    ])
      expect(actions, action).toContain(action);
    const text = JSON.stringify(events.map((event) => event.metadata));
    for (const secret of [
      supA.identifier,
      "Accounts clerk",
      "A-1001",
      "3248000",
      "1000000",
      ETIMS,
      "FT-SUP-0001",
      "Left the supplier",
      "Wrong person",
    ])
      expect(text, secret).not.toContain(secret);
  });
});
