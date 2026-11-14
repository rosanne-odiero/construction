/**
 * The supplier portal for the mock API (D7.2): a supplier persona (cookie `pmb_at=supplier.<id>`)
 * bound to Mlolongo Quarry, with its own copy of the data per <id>, and the staff side (a
 * supplier's portal users on the supplier page). Requests are validated with the shared request
 * schemas and every reply is checked against the shared response schema by mock-api.mts.
 * Synthetic data only.
 */
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import {
  addCalendarDays,
  invoiceNumberKey,
  nairobiDate,
  supplierStatement,
} from "@pm-buddy/domain";
import {
  SUPPLIER_PORTAL_LIMITS,
  type ProcurementDocumentType,
  type SettlementMethod,
  type SupplierInvoiceStatus,
} from "@pm-buddy/types";
import {
  authResponseSchema,
  invitePortalUserRequestSchema,
  portalDeliveriesResponseSchema,
  portalDocumentResponseSchema,
  portalInvoiceDetailResponseSchema,
  portalInvoicesResponseSchema,
  portalLpoDetailResponseSchema,
  portalLposResponseSchema,
  revokePortalUserRequestSchema,
  submitSupplierInvoiceRequestSchema,
  supplierPortalOverviewResponseSchema,
  supplierPortalUserResponseSchema,
  supplierPortalUsersResponseSchema,
  supplierStatementResponseSchema,
  tenantsResponseSchema,
  type PortalDelivery,
  type PortalInvoiceDetailResponse,
  type PortalLpo,
  type PortalLpoLine,
  type SupplierPortalUser,
} from "@pm-buddy/validation";

type Reply = { status?: number; body: unknown; schema: z.ZodType<unknown> };
type Fail = (status: number, code: string) => Error;
type Parse = <T>(schema: z.ZodType<T>, body: unknown) => T;

const TENANT = { id: "20000000-0000-4000-8000-000000000001", name: "Jenga Bora Builders Ltd" };
export const QUARRY_ID = "60000000-0000-4000-8000-000000000001";
const SUPPLIER = { id: QUARRY_ID, code: "SUP-0001", name: "Mlolongo Quarry (synthetic)" };
const USER = {
  id: "21000000-0000-4000-8000-000000000013",
  identifier: "accounts@mlolongo-quarry.example.test",
  displayName: "Achieng Otieno (synthetic)",
};
const RUIRU = {
  id: "30000000-0000-4000-8000-000000000001",
  code: "RUI-HTS",
  name: "Ruiru Heights Apartments",
};
const SYOKIMAU = {
  id: "30000000-0000-4000-8000-000000000002",
  code: "SYO-TWN",
  name: "Syokimau Townhouses",
};
const BALLAST = { code: "MAT-0003", name: "Ballast 20 mm", baseUnit: "t" };
const SAND = { code: "MAT-0002", name: "River sand", baseUnit: "t" };
const HARDCORE = { code: "MAT-0006", name: "Hardcore", baseUnit: "t" };
const VAT_RATE = "16";
const LPO_IDS = {
  open: "73000000-0000-4000-8000-000000000007",
  acknowledged: "73000000-0000-4000-8000-000000000005",
  cancelled: "73000000-0000-4000-8000-000000000003",
};
export const SUPPLIER_LPO_IDS = LPO_IDS;
export const SUPPLIER_INVOICE_IDS = {
  partlyPaid: "75000000-0000-4000-8000-000000000001",
  disputed: "75000000-0000-4000-8000-000000000002",
};

type MockLine = PortalLpoLine;
type MockLpo = { lpo: PortalLpo; terms: string | null; lines: MockLine[] };
type MockDocument = {
  id: string;
  invoiceId: string;
  contentType: ProcurementDocumentType;
  content: Buffer;
  uploadedAt: string;
  uploadedBySupplier: boolean;
};
type MockPayment = {
  id: string;
  amountMinor: number;
  paidOn: string;
  method: SettlementMethod;
  reference: string;
};
type MockInvoice = Omit<PortalInvoiceDetailResponse, "documents" | "replayed" | "permissions"> & {
  payments: MockPayment[];
};
type SupplierState = {
  lpos: MockLpo[];
  deliveries: PortalDelivery[];
  invoices: MockInvoice[];
  documents: MockDocument[];
  replays: Map<string, { digest: string; invoiceId: string }>;
};

const states = new Map<string, SupplierState>();
const at = (date: string, time = "07:30:00") => `${date}T${time}.000Z`;
const quantity = (value: number) => value.toFixed(6);
const net = (qty: number, priceMinor: number) => Math.round(qty * priceMinor);
const vatOf = (netMinor: number) => Math.round((netMinor * 16) / 100);

function line(
  id: string,
  lineNo: number,
  material: typeof BALLAST,
  ordered: number,
  priceMinor: number,
  received: number,
  invoiced: number,
): MockLine {
  return {
    id,
    lineNo,
    material,
    quantity: quantity(ordered),
    unit: material.baseUnit,
    baseQuantity: quantity(ordered),
    priceUnit: material.baseUnit,
    unitPriceMinor: priceMinor,
    vatTreatment: "exclusive",
    netUnitPriceBaseMinor: quantity(priceMinor),
    netAmountMinor: net(ordered, priceMinor),
    receivedBaseQuantity: quantity(received),
    invoicedBaseQuantity: quantity(invoiced),
    pendingBaseQuantity: quantity(0),
    invoiceableBaseQuantity: quantity(Math.max(received - invoiced, 0)),
  };
}

function lpoRecord(
  id: string,
  number: string,
  project: typeof RUIRU,
  lines: MockLine[],
  approvedOn: string,
  extra: Partial<PortalLpo>,
): MockLpo {
  const subtotal = lines.reduce((sum, entry) => sum + entry.netAmountMinor, 0);
  return {
    lpo: {
      id,
      number,
      project,
      deliverySite: {
        id: "31000000-0000-4000-8000-000000000001",
        name: "Main plot",
        address: "Off Eastern Bypass, Ruiru",
      },
      deliveryDate: addCalendarDays(approvedOn, 7),
      status: "approved",
      deliveryState: "partial",
      approvedAt: at(approvedOn),
      cancelledAt: null,
      creditDays: 30,
      vatRatePercent: VAT_RATE,
      subtotalMinor: subtotal,
      vatMinor: vatOf(subtotal),
      totalMinor: subtotal + vatOf(subtotal),
      acknowledgement: null,
      ...extra,
    },
    terms: "Deliver between 07:00 and 16:00. Payment 30 days from the approved invoice.",
    lines,
  };
}

function fixture(): SupplierState {
  const today = nairobiDate();
  const ballastOpen = line("74000000-0000-4000-8000-000000000071", 1, BALLAST, 20, 250_000, 12, 0);
  const sandOpen = line("74000000-0000-4000-8000-000000000072", 2, SAND, 10, 180_000, 9, 0);
  const ballastDone = line("74000000-0000-4000-8000-000000000051", 1, BALLAST, 30, 250_000, 30, 30);
  const hardcore = line("74000000-0000-4000-8000-000000000031", 1, HARDCORE, 15, 120_000, 0, 0);
  const lpos = [
    lpoRecord(
      LPO_IDS.open,
      "LPO-0007",
      RUIRU,
      [ballastOpen, sandOpen],
      addCalendarDays(today, -6),
      {},
    ),
    lpoRecord(
      LPO_IDS.acknowledged,
      "LPO-0005",
      SYOKIMAU,
      [ballastDone],
      addCalendarDays(today, -30),
      {
        deliveryState: "complete",
        deliverySite: null,
        acknowledgement: {
          acknowledgedAt: at(addCalendarDays(today, -29), "08:10:00"),
          acknowledgedBy: { id: USER.id, displayName: USER.displayName },
        },
      },
    ),
    lpoRecord(LPO_IDS.cancelled, "LPO-0003", RUIRU, [hardcore], addCalendarDays(today, -40), {
      status: "cancelled",
      deliveryState: "none",
      cancelledAt: at(addCalendarDays(today, -38)),
    }),
  ];
  const deliveries: PortalDelivery[] = [
    {
      id: "76000000-0000-4000-8000-000000000011",
      number: "GRN-0011",
      lpo: { id: LPO_IDS.open, number: "LPO-0007" },
      project: RUIRU,
      site: { id: "31000000-0000-4000-8000-000000000001", name: "Main plot" },
      status: "recorded",
      receivedAt: at(addCalendarDays(today, -3), "09:15:00"),
      deliveryNoteNumber: "DN-4471",
      vehicleRegistration: "KDA 123B",
      lines: [
        {
          lineNo: 1,
          lpoLineId: ballastOpen.id,
          material: BALLAST,
          unit: "t",
          receivedQuantity: quantity(12),
          rejectedQuantity: quantity(0),
          rejectionReason: null,
          acceptedBaseQuantity: quantity(12),
        },
        {
          lineNo: 2,
          lpoLineId: sandOpen.id,
          material: SAND,
          unit: "t",
          receivedQuantity: quantity(10),
          rejectedQuantity: quantity(1),
          rejectionReason: "Wet and silty",
          acceptedBaseQuantity: quantity(9),
        },
      ],
    },
    {
      id: "76000000-0000-4000-8000-000000000009",
      number: "GRN-0009",
      lpo: { id: LPO_IDS.acknowledged, number: "LPO-0005" },
      project: SYOKIMAU,
      site: null,
      status: "recorded",
      receivedAt: at(addCalendarDays(today, -25), "10:40:00"),
      deliveryNoteNumber: "DN-4410",
      vehicleRegistration: "KCZ 456K",
      lines: [
        {
          lineNo: 1,
          lpoLineId: ballastDone.id,
          material: BALLAST,
          unit: "t",
          receivedQuantity: quantity(30),
          rejectedQuantity: quantity(0),
          rejectionReason: null,
          acceptedBaseQuantity: quantity(30),
        },
      ],
    },
  ];
  const approvedOn = addCalendarDays(today, -20);
  const invoices: MockInvoice[] = [
    {
      invoice: {
        id: SUPPLIER_INVOICE_IDS.partlyPaid,
        invoiceNumber: "MQ-INV-1001",
        invoiceDate: approvedOn,
        dueDate: addCalendarDays(approvedOn, 30),
        lpo: { id: LPO_IDS.acknowledged, number: "LPO-0005" },
        project: SYOKIMAU,
        etimsInvoiceNumber: "KRACU0400000078/2231",
        etimsFormat: "etims",
        status: "partly_paid",
        source: "supplier_portal",
        subtotalMinor: 7_500_000,
        vatMinor: 1_200_000,
        totalMinor: 8_700_000,
        paidMinor: 4_000_000,
        outstandingMinor: 4_700_000,
        overdue: false,
        submittedAt: at(approvedOn, "11:00:00"),
      },
      lines: [
        {
          lineNo: 1,
          lpoLineId: ballastDone.id,
          material: BALLAST,
          quantity: quantity(30),
          unit: "t",
          unitPriceMinor: 250_000,
          vatTreatment: "exclusive",
          netAmountMinor: 7_500_000,
        },
      ],
      dispute: null,
      payments: [
        {
          id: "77000000-0000-4000-8000-000000000001",
          amountMinor: 4_000_000,
          paidOn: addCalendarDays(today, -5),
          method: "bank_transfer",
          reference: "FT-0001",
        },
      ],
    },
    {
      invoice: {
        id: SUPPLIER_INVOICE_IDS.disputed,
        invoiceNumber: "MQ-INV-0998",
        invoiceDate: addCalendarDays(today, -10),
        dueDate: addCalendarDays(today, 20),
        lpo: { id: LPO_IDS.acknowledged, number: "LPO-0005" },
        project: SYOKIMAU,
        etimsInvoiceNumber: "KRACU0400000078/2240",
        etimsFormat: "etims",
        status: "disputed",
        source: "supplier_portal",
        subtotalMinor: 1_000_000,
        vatMinor: 160_000,
        totalMinor: 1_160_000,
        paidMinor: 0,
        outstandingMinor: 0,
        overdue: false,
        submittedAt: at(addCalendarDays(today, -10), "12:00:00"),
      },
      lines: [
        {
          lineNo: 1,
          lpoLineId: ballastDone.id,
          material: BALLAST,
          quantity: quantity(4),
          unit: "t",
          unitPriceMinor: 250_000,
          vatTreatment: "exclusive",
          netAmountMinor: 1_000_000,
        },
      ],
      dispute: { reasons: [], lines: [{ lineNo: 1, reasons: ["qty-exceeds-received"] }] },
      payments: [],
    },
  ];
  return { lpos, deliveries, invoices, documents: [], replays: new Map() };
}

export const isSupplierPersona = (value: string | undefined): value is "supplier" =>
  value === "supplier";

function stateOf(session: string): SupplierState {
  let state = states.get(session);
  if (!state) {
    state = fixture();
    states.set(session, state);
  }
  return state;
}

const page = { nextCursor: null, hasMore: false };
const ACCEPTED: SupplierInvoiceStatus[] = ["approved", "partly_paid", "paid"];

function documentsOf(state: SupplierState, invoiceId: string) {
  return state.documents
    .filter((document) => document.invoiceId === invoiceId)
    .map((document) => ({
      id: document.id,
      contentType: document.contentType,
      sizeBytes: document.content.length,
      scanStatus: "not_scanned" as const,
      uploadedAt: document.uploadedAt,
      uploadedBySupplier: document.uploadedBySupplier,
    }));
}

function detail(state: SupplierState, entry: MockInvoice, replayed = false): Reply {
  const open = ["submitted", "under_review", "disputed"].includes(entry.invoice.status);
  return {
    body: {
      ...entry,
      documents: documentsOf(state, entry.invoice.id),
      replayed,
      permissions: {
        canAttach:
          open &&
          entry.invoice.source === "supplier_portal" &&
          documentsOf(state, entry.invoice.id).length < SUPPLIER_PORTAL_LIMITS.documentsPerInvoice,
      },
    },
    schema: portalInvoiceDetailResponseSchema,
  };
}

function lpoDetail(state: SupplierState, entry: MockLpo): Reply {
  return {
    body: {
      lpo: entry.lpo,
      terms: entry.terms,
      lines: entry.lines,
      deliveries: state.deliveries
        .filter((delivery) => delivery.lpo.id === entry.lpo.id)
        .map((delivery) =>
          Object.fromEntries(Object.entries(delivery).filter(([key]) => key !== "lines")),
        ),
      invoices: state.invoices
        .filter((invoice) => invoice.invoice.lpo.id === entry.lpo.id)
        .map((invoice) => invoice.invoice),
      permissions: {
        canAcknowledge: entry.lpo.status === "approved" && entry.lpo.acknowledgement === null,
        canInvoice:
          entry.lpo.status === "approved" &&
          entry.lines.some((candidate) => /[1-9]/.test(candidate.invoiceableBaseQuantity)),
      },
    },
    schema: portalLpoDetailResponseSchema,
  };
}

function sniff(content: Buffer): ProcurementDocumentType | null {
  if (content.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff)
    return "image/jpeg";
  if (content.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return "image/png";
  return null;
}

function multipartFile(raw: Buffer, contentType: string | undefined): Buffer | null {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType ?? "");
  const marker = boundary?.[1] ?? boundary?.[2];
  if (!marker) return null;
  const delimiter = Buffer.from(`--${marker}`);
  const start = raw.indexOf(delimiter);
  const next = start === -1 ? -1 : raw.indexOf(delimiter, start + delimiter.length);
  if (next === -1) return null;
  const part = raw.subarray(start + delimiter.length, next);
  const split = part.indexOf("\r\n\r\n");
  if (split === -1) return null;
  const body = part.subarray(split + 4, part.length - 2);
  return body.length ? body : null;
}

/** The supplier persona's session, company list and `/portal/supplier/*` replies. */
export function handleSupplierPersona(
  session: string,
  method: string,
  path: string,
  query: URLSearchParams,
  body: unknown,
  request: { idempotencyKey?: string; contentType?: string; raw: Buffer },
  fail: Fail,
  parse: Parse,
): Reply {
  const state = stateOf(session);
  const today = nairobiDate();
  if (method === "GET" && path === "/auth/me")
    return {
      body: {
        user: { ...USER, verified: true, mfaEnabled: false, totpEnabled: false, passkeys: 0 },
        session: {
          id: "22000000-0000-4000-8000-000000000013",
          tenantId: TENANT.id,
          mfaVerified: false,
          expiresAt: "2026-11-11T07:45:00.000Z",
        },
        mfaRequired: false,
      },
      schema: authResponseSchema,
    };
  if (method === "GET" && path === "/tenants")
    return {
      body: {
        tenants: [
          {
            ...TENANT,
            role: "supplier",
            roleName: null,
            tenantWide: false,
            permissions: ["projects.view", "portal.supplier"],
          },
        ],
      },
      schema: tenantsResponseSchema,
    };
  if (!path.startsWith("/portal/supplier")) throw fail(403, "forbidden");
  // A session named `revoked-…` stands for a portal user whose binding has ended.
  if (session.startsWith("revoked-")) throw fail(403, "supplier-portal-not-linked");
  const rest = path.slice("/portal/supplier".length);
  const projectId = query.get("projectId");
  const lpoId = query.get("lpoId");

  if (method === "GET" && rest === "") {
    const statuses = state.invoices.map((entry) => entry.invoice.status);
    return {
      body: {
        company: TENANT,
        supplier: SUPPLIER,
        displayName: USER.displayName,
        projects: [RUIRU, SYOKIMAU],
        counts: {
          openLpos: state.lpos.filter((entry) => entry.lpo.status === "approved").length,
          unacknowledgedLpos: state.lpos.filter(
            (entry) => entry.lpo.status === "approved" && !entry.lpo.acknowledgement,
          ).length,
          deliveries: state.deliveries.length,
          invoicesUnderReview: statuses.filter((s) => s === "submitted" || s === "under_review")
            .length,
          invoicesDisputed: statuses.filter((s) => s === "disputed").length,
          invoicesAwaitingPayment: statuses.filter((s) => s === "approved" || s === "partly_paid")
            .length,
        },
        outstandingMinor: state.invoices.reduce(
          (sum, entry) => sum + entry.invoice.outstandingMinor,
          0,
        ),
        permissions: { canSubmitInvoices: true },
      },
      schema: supplierPortalOverviewResponseSchema,
    };
  }
  if (method === "GET" && rest === "/lpos") {
    const status = query.get("status");
    return {
      body: {
        lpos: state.lpos
          .map((entry) => entry.lpo)
          .filter(
            (lpo) =>
              (!projectId || lpo.project.id === projectId) && (!status || lpo.status === status),
          ),
        page,
      },
      schema: portalLposResponseSchema,
    };
  }
  const lpoMatch = /^\/lpos\/([^/]+)(\/acknowledge)?$/.exec(rest);
  if (lpoMatch) {
    const entry = state.lpos.find((candidate) => candidate.lpo.id === lpoMatch[1]);
    if (!entry) throw fail(404, "not-found");
    if (method === "GET" && !lpoMatch[2]) return lpoDetail(state, entry);
    if (method === "POST" && lpoMatch[2]) {
      if (entry.lpo.status !== "approved") throw fail(409, "lpo-not-approved");
      if (entry.lpo.acknowledgement) throw fail(409, "lpo-already-acknowledged");
      entry.lpo.acknowledgement = {
        acknowledgedAt: new Date().toISOString(),
        acknowledgedBy: { id: USER.id, displayName: USER.displayName },
      };
      return lpoDetail(state, entry);
    }
  }
  if (method === "GET" && rest === "/deliveries")
    return {
      body: {
        deliveries: state.deliveries.filter(
          (delivery) =>
            (!projectId || delivery.project.id === projectId) &&
            (!lpoId || delivery.lpo.id === lpoId),
        ),
        page,
      },
      schema: portalDeliveriesResponseSchema,
    };
  if (method === "GET" && rest === "/invoices") {
    const status = query.get("status");
    return {
      body: {
        invoices: state.invoices
          .map((entry) => entry.invoice)
          .filter(
            (invoice) =>
              (!projectId || invoice.project.id === projectId) &&
              (!lpoId || invoice.lpo.id === lpoId) &&
              (!status || invoice.status === status),
          ),
        page,
        permissions: { canSubmit: true },
      },
      schema: portalInvoicesResponseSchema,
    };
  }
  if (method === "POST" && rest === "/invoices") {
    const key = request.idempotencyKey;
    if (!key || key.length < 8 || key.length > 100) throw fail(400, "idempotency-key-required");
    const input = parse(submitSupplierInvoiceRequestSchema, body);
    const digest = JSON.stringify(body);
    const replay = state.replays.get(key);
    if (replay) {
      if (replay.digest !== digest || replay.invoiceId !== input.id)
        throw fail(409, "idempotency-key-reused");
      const original = state.invoices.find((entry) => entry.invoice.id === replay.invoiceId)!;
      return { ...detail(state, original, true), status: 201 };
    }
    if (state.invoices.some((entry) => entry.invoice.id === input.id))
      throw fail(409, "invoice-id-conflict");
    const lpo = state.lpos.find((entry) => entry.lpo.id === input.lpoId);
    if (!lpo) throw fail(404, "not-found");
    if (lpo.lpo.status !== "approved") throw fail(409, "lpo-not-approved");
    if (input.invoiceDate > today) throw fail(422, "invoice-date-invalid");
    const numberKey = invoiceNumberKey(input.invoiceNumber);
    if (state.invoices.some((entry) => invoiceNumberKey(entry.invoice.invoiceNumber) === numberKey))
      throw fail(409, "invoice-number-taken");
    const lines = input.lines.map((entry, index) => {
      const lpoLine = lpo.lines.find((candidate) => candidate.id === entry.lpoLineId);
      if (!lpoLine) throw fail(400, "validation-error");
      const qty = Number(entry.quantity);
      const pending = Number(lpoLine.pendingBaseQuantity) + qty;
      lpoLine.pendingBaseQuantity = quantity(pending);
      lpoLine.invoiceableBaseQuantity = quantity(
        Math.max(
          Number(lpoLine.receivedBaseQuantity) - Number(lpoLine.invoicedBaseQuantity) - pending,
          0,
        ),
      );
      const price = entry.unitPriceMinor;
      return {
        lineNo: index + 1,
        lpoLineId: lpoLine.id,
        material: lpoLine.material,
        quantity: quantity(qty),
        unit: entry.unit ?? lpoLine.unit,
        unitPriceMinor: price,
        vatTreatment: entry.vatTreatment ?? lpoLine.vatTreatment,
        netAmountMinor:
          entry.vatTreatment === "inclusive"
            ? Math.round((qty * price * 100) / 116)
            : net(qty, price),
      };
    });
    const entry: MockInvoice = {
      invoice: {
        id: input.id,
        invoiceNumber: input.invoiceNumber,
        invoiceDate: input.invoiceDate,
        dueDate: addCalendarDays(input.invoiceDate, lpo.lpo.creditDays),
        lpo: { id: lpo.lpo.id, number: lpo.lpo.number },
        project: lpo.lpo.project,
        etimsInvoiceNumber: input.etimsInvoiceNumber.value,
        etimsFormat: input.etimsInvoiceNumber.format,
        status: "under_review",
        source: "supplier_portal",
        subtotalMinor: input.subtotalMinor,
        vatMinor: input.vatMinor,
        totalMinor: input.totalMinor,
        paidMinor: 0,
        outstandingMinor: 0,
        overdue: false,
        submittedAt: new Date().toISOString(),
      },
      lines,
      dispute: null,
      payments: [],
    };
    state.invoices.unshift(entry);
    state.replays.set(key, { digest, invoiceId: input.id });
    return { ...detail(state, entry), status: 201 };
  }
  const invoiceMatch = /^\/invoices\/([^/]+)(\/document)?$/.exec(rest);
  if (invoiceMatch) {
    const entry = state.invoices.find((candidate) => candidate.invoice.id === invoiceMatch[1]);
    if (!entry) throw fail(404, "not-found");
    if (method === "GET" && !invoiceMatch[2]) return detail(state, entry);
    if (method === "POST" && invoiceMatch[2]) {
      if (!(detail(state, entry).body as PortalInvoiceDetailResponse).permissions.canAttach)
        throw fail(409, "invoice-not-attachable");
      const file = multipartFile(request.raw, request.contentType);
      if (!file) throw fail(400, "file-required");
      const contentType = sniff(file);
      if (!contentType) throw fail(415, "unsupported-file-type");
      const document: MockDocument = {
        id: randomUUID(),
        invoiceId: entry.invoice.id,
        contentType,
        content: file,
        uploadedAt: new Date().toISOString(),
        uploadedBySupplier: true,
      };
      state.documents.push(document);
      return {
        status: 201,
        body: { document: documentsOf(state, entry.invoice.id).at(-1) },
        schema: portalDocumentResponseSchema,
      };
    }
  }
  if (method === "GET" && rest === "/statement") return statement(state, query, fail, today);
  throw fail(404, "not-found");
}

function statement(state: SupplierState, query: URLSearchParams, fail: Fail, today: string): Reply {
  const projectId = query.get("projectId");
  const to = query.get("to") ?? today;
  const from =
    query.get("from") ?? addCalendarDays(to, -(SUPPLIER_PORTAL_LIMITS.statementDefaultDays - 1));
  if (from > to) throw fail(422, "statement-period-invalid");
  const project = projectId ? [RUIRU, SYOKIMAU].find((entry) => entry.id === projectId) : null;
  if (projectId && !project) throw fail(404, "not-found");
  const scoped = state.invoices.filter(
    (entry) => !projectId || entry.invoice.project.id === projectId,
  );
  const accepted = scoped.filter((entry) => ACCEPTED.includes(entry.invoice.status));
  const result = supplierStatement({
    from,
    to,
    invoices: accepted.map((entry) => ({
      id: entry.invoice.id,
      invoiceNumber: entry.invoice.invoiceNumber,
      date: entry.invoice.invoiceDate,
      totalMinor: entry.invoice.totalMinor,
    })),
    payments: accepted.flatMap((entry) =>
      entry.payments.map((payment) => ({
        id: payment.id,
        invoiceId: entry.invoice.id,
        invoiceNumber: entry.invoice.invoiceNumber,
        date: payment.paidOn,
        amountMinor: payment.amountMinor,
        method: payment.method,
        reference: payment.reference,
      })),
    ),
  });
  return {
    body: {
      company: TENANT,
      supplier: SUPPLIER,
      project: project ?? null,
      from: result.from,
      to: result.to,
      generatedAt: new Date().toISOString(),
      openingMinor: result.openingMinor,
      invoicedMinor: result.invoicedMinor,
      paidMinor: result.paidMinor,
      closingMinor: result.closingMinor,
      entries: result.entries.map((entry) => ({
        kind: entry.kind,
        date: entry.date,
        invoiceId: entry.invoiceId,
        invoiceNumber: entry.invoiceNumber,
        method: entry.method,
        reference: entry.reference,
        debitMinor: entry.debitMinor,
        creditMinor: entry.creditMinor,
        balanceMinor: entry.balanceMinor,
      })),
      outstanding: accepted
        .filter((entry) => entry.invoice.outstandingMinor > 0)
        .map((entry) => ({
          invoiceId: entry.invoice.id,
          invoiceNumber: entry.invoice.invoiceNumber,
          project: entry.invoice.project,
          invoiceDate: entry.invoice.invoiceDate,
          dueDate: entry.invoice.dueDate,
          totalMinor: entry.invoice.totalMinor,
          paidMinor: entry.invoice.paidMinor,
          outstandingMinor: entry.invoice.outstandingMinor,
          overdue: entry.invoice.overdue,
        })),
      notAccepted: scoped
        .filter((entry) => !ACCEPTED.includes(entry.invoice.status))
        .map((entry) => ({
          invoiceId: entry.invoice.id,
          invoiceNumber: entry.invoice.invoiceNumber,
          invoiceDate: entry.invoice.invoiceDate,
          totalMinor: entry.invoice.totalMinor,
          status: entry.invoice.status,
        })),
    },
    schema: supplierStatementResponseSchema,
  };
}

/** Bytes the supplier downloads: their invoice documents and statement exports. */
export function supplierPortalFile(
  session: string,
  path: string,
): { contentType: string; content: Buffer; filename?: string } | null {
  const state = stateOf(session);
  const document = /^\/portal\/supplier\/documents\/([^/]+)$/.exec(path);
  if (document) {
    const found = state.documents.find((entry) => entry.id === document[1]);
    return found ? { contentType: found.contentType, content: found.content } : null;
  }
  const exported = /^\/portal\/supplier\/statement\/export\/(pdf|xlsx)$/.exec(path);
  if (exported)
    return exported[1] === "pdf"
      ? {
          contentType: "application/pdf",
          content: Buffer.from("%PDF-1.4\n% mock supplier statement\n%%EOF\n"),
          filename: "statement.pdf",
        }
      : {
          contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          content: Buffer.from("PK mock supplier statement"),
          filename: "statement.xlsx",
        };
  return null;
}

// Staff: a supplier's portal users ------------------------------------------------------------

export type SupplierPortalStaffState = Map<string, SupplierPortalUser[]>;

export function initialSupplierPortalUsers(): SupplierPortalStaffState {
  return new Map([
    [
      QUARRY_ID,
      [
        {
          id: "78000000-0000-4000-8000-000000000001",
          supplierId: QUARRY_ID,
          contactName: USER.displayName,
          identifier: USER.identifier,
          status: "active",
          version: 2,
          invitedAt: "2026-10-01T06:00:00.000Z",
          invitedBy: { id: "21000000-0000-4000-8000-000000000001", displayName: "Wanjiru Kamau" },
          invitationExpiresAt: null,
          activatedAt: "2026-10-01T09:00:00.000Z",
          account: { id: USER.id, displayName: USER.displayName },
          revokedAt: null,
          revokedBy: null,
          revokeCause: null,
          revokeReason: null,
          submittedInvoices: 2,
        },
      ],
    ],
  ]);
}

export function handleSupplierPortalUsers(
  deps: {
    fail: Fail;
    parse: Parse;
    actor: { id: string; displayName: string };
    canManage: boolean;
    requireStepUp: () => void;
    supplier: (id: string) => { id: string; code: string; name: string } | null;
  },
  state: SupplierPortalStaffState,
  method: string,
  path: string,
  body: unknown,
): Reply | null {
  const match = /^\/suppliers\/([^/]+)\/portal-users(?:\/([^/]+)\/revoke)?$/.exec(path);
  if (!match) return null;
  const supplier = deps.supplier(match[1]!);
  if (!supplier) throw deps.fail(404, "not-found");
  if (!deps.canManage) throw deps.fail(403, "forbidden");
  const users = state.get(supplier.id) ?? [];
  state.set(supplier.id, users);
  if (method === "GET" && !match[2])
    return {
      body: { supplier, users, permissions: { canInvite: true, canRevoke: true } },
      schema: supplierPortalUsersResponseSchema,
    };
  if (method === "POST" && !match[2]) {
    deps.requireStepUp();
    const input = deps.parse(invitePortalUserRequestSchema, body);
    if (users.some((user) => user.identifier === input.identifier && user.status !== "revoked"))
      throw deps.fail(409, "portal-user-exists");
    const now = new Date();
    const user: SupplierPortalUser = {
      id: randomUUID(),
      supplierId: supplier.id,
      contactName: input.contactName,
      identifier: input.identifier,
      status: "invited",
      version: 1,
      invitedAt: now.toISOString(),
      invitedBy: deps.actor,
      invitationExpiresAt: new Date(now.getTime() + 48 * 3_600_000).toISOString(),
      activatedAt: null,
      account: null,
      revokedAt: null,
      revokedBy: null,
      revokeCause: null,
      revokeReason: null,
      submittedInvoices: 0,
    };
    users.unshift(user);
    return { status: 201, body: { user }, schema: supplierPortalUserResponseSchema };
  }
  if (method === "POST" && match[2]) {
    const user = users.find((entry) => entry.id === match[2]);
    if (!user) throw deps.fail(404, "not-found");
    const input = deps.parse(revokePortalUserRequestSchema, body);
    if (user.version !== input.version) throw deps.fail(409, "version-conflict");
    if (user.status === "revoked") throw deps.fail(409, "invalid-transition");
    Object.assign(user, {
      status: "revoked",
      version: user.version + 1,
      revokedAt: new Date().toISOString(),
      revokedBy: deps.actor,
      revokeCause: "revoked",
      revokeReason: input.reason,
    });
    return { body: { user }, schema: supplierPortalUserResponseSchema };
  }
  throw deps.fail(405, "method-not-allowed");
}
