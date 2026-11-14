/**
 * The client portal for the mock API (D7.1): the client persona's `/portal/client/*` replies
 * (cookie `pmb_at=client.<id>`, its own copy of the data per <id>), and the staff side (client
 * payments, client terms, Paybill instructions and FX rates). Requests are validated with the
 * shared request schemas and every reply is checked against the shared response schema by
 * mock-api.mts. Synthetic data only.
 */
import { createHash, randomUUID } from "node:crypto";
import type { z } from "zod";
import {
  addCalendarDays,
  certificateDueDate,
  clientStatement,
  clientVariationText,
  fxRateUsable,
  nairobiDate,
  paybillAccountReference,
  receiptFits,
  type ClientVariationView,
} from "@pm-buddy/domain";
import type { DisplayCurrency, FxCurrency, Permission } from "@pm-buddy/types";
import {
  clientDecisionRequestSchema,
  clientDiariesResponseSchema,
  clientPayResponseSchema,
  clientPaymentsResponseSchema,
  clientPhotosResponseSchema,
  clientPortalOverviewResponseSchema,
  clientPortalProjectsResponseSchema,
  clientPreferencesResponseSchema,
  clientProgressResponseSchema,
  clientStatementResponseSchema,
  clientStkPushRequestSchema,
  clientVariationDetailResponseSchema,
  clientVariationsResponseSchema,
  createFxRateRequestSchema,
  fxRatesResponseSchema,
  paymentInstructionsResponseSchema,
  recordClientPaymentRequestSchema,
  reverseClientPaymentRequestSchema,
  updateClientPreferencesRequestSchema,
  updateClientSettingsRequestSchema,
  updatePaymentInstructionsRequestSchema,
  type ClientCertificate,
  type ClientDisplay,
  type FxRate,
  type PaymentInstructions,
  type StaffClientPayment,
} from "@pm-buddy/validation";

type Reply = { status?: number; body: unknown; schema: z.ZodType<unknown> };
type Fail = (status: number, code: string) => Error;
type Parse = <T>(schema: z.ZodType<T>, body: unknown) => T;
type Person = { id: string; displayName: string };

const TENANT = { id: "20000000-0000-4000-8000-000000000001", name: "Jenga Bora Builders Ltd" };
export const CLIENT_PROJECT_ID = "30000000-0000-4000-8000-000000000001";
const CLIENT = { id: "21000000-0000-4000-8000-000000000011", displayName: "Grace Wambui" };
const FINANCE = { id: "21000000-0000-4000-8000-000000000005", displayName: "Daniel Mwangi" };
const PM = { id: "21000000-0000-4000-8000-000000000002", displayName: "Brian Otieno" };
const ruiru = {
  id: CLIENT_PROJECT_ID,
  code: "RUI-HTS",
  name: "Ruiru Heights Apartments",
  status: "active" as const,
};
const CERT_1 = "34000000-0000-4000-8000-000000000001";
const CERT_2 = "34000000-0000-4000-8000-000000000002";
const PHOTO_VERIFIED = "35000000-0000-4000-8000-000000000001";
const PHOTO_UNVERIFIED = "35000000-0000-4000-8000-000000000002";
const REQUEST = "36000000-0000-4000-8000-000000000001";
const TERMS_DAYS = 14;
const VAT = "16";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const now = () => new Date().toISOString();
const day = (offset: number) => addCalendarDays(nairobiDate(), offset);

// Shared fixture ------------------------------------------------------------------------------

type Certificate = {
  id: string;
  number: string;
  valuationDate: string;
  certifiedOn: string;
  amountDueMinor: number;
  vatMinor: number;
};
type Payment = {
  id: string;
  kind: "receipt" | "reversal";
  certificateId: string;
  receivedOn: string;
  amountMinor: number;
  method: StaffClientPayment["method"];
  reference: string | null;
  reversesId: string | null;
  reason: string | null;
  note: string | null;
  recordedBy: Person;
  recordedAt: string;
};
type Instructions = PaymentInstructions & { updatedBy: Person };
type Decision = {
  decision: "approved" | "rejected";
  comment: string | null;
  decidedBy: Person;
  decidedAt: string;
};

function certificates(): Certificate[] {
  return [
    {
      id: CERT_1,
      number: "IPC-0001",
      valuationDate: day(-47),
      certifiedOn: day(-45),
      amountDueMinor: 500_000_000,
      vatMinor: 80_000_000,
    },
    {
      id: CERT_2,
      number: "IPC-0002",
      valuationDate: day(-12),
      certifiedOn: day(-10),
      amountDueMinor: 300_000_000,
      vatMinor: 48_000_000,
    },
  ];
}

function firstReceipt(): Payment {
  return {
    id: "37000000-0000-4000-8000-000000000001",
    kind: "receipt",
    certificateId: CERT_1,
    receivedOn: day(-35),
    amountMinor: 348_000_000,
    method: "mpesa_paybill",
    reference: "SLK4H7J2PQ",
    reversesId: null,
    reason: null,
    note: "Synthetic: part payment of IPC-0001.",
    recordedBy: FINANCE,
    recordedAt: `${day(-35)}T10:00:00.000Z`,
  };
}

function instructions(): Instructions {
  return {
    version: 1,
    paybillNumber: "174379",
    tillNumber: null,
    accountName: "Jenga Bora Builders Ltd (synthetic)",
    accountFormat: "project_certificate",
    bankInstructions: null,
    updatedAt: `${day(-60)}T08:00:00.000Z`,
    updatedBy: { id: "21000000-0000-4000-8000-000000000001", displayName: "Wanjiru Kamau" },
  };
}

const publicInstructions = (entry: Instructions): PaymentInstructions => ({
  version: entry.version,
  paybillNumber: entry.paybillNumber,
  tillNumber: entry.tillNumber,
  accountName: entry.accountName,
  accountFormat: entry.accountFormat,
  bankInstructions: entry.bankInstructions,
  updatedAt: entry.updatedAt,
});

function rates(): FxRate[] {
  const entry = (id: string, currency: FxCurrency, kesPerUnit: string): FxRate => ({
    id,
    currency,
    kesPerUnit,
    rateDate: day(-1),
    source: "Synthetic indicative rate for the demo",
    enteredBy: FINANCE,
    enteredAt: `${day(-1)}T07:00:00.000Z`,
    usable: true,
  });
  return [
    entry("38000000-0000-4000-8000-000000000001", "USD", "129.4500"),
    entry("38000000-0000-4000-8000-000000000002", "GBP", "170.1000"),
    entry("38000000-0000-4000-8000-000000000003", "EUR", "150.3000"),
  ];
}

const variationView: ClientVariationView = {
  number: "VO-001",
  title: "Porcelain floor tiles in living rooms",
  description: "Synthetic: upgrade living-room floor tiles from ceramic to 600 × 600 mm porcelain.",
  instruction: { number: "AI-004", subject: "Floor finishes to living rooms" },
  lines: [
    {
      lineNo: 1,
      action: "add",
      ref: "F/12",
      description: "600 × 600 mm porcelain floor tiles, laid on screed",
      unit: "m2",
      quantity: "120.000",
      rate: "3200.00",
      baseAmountMinor: 0,
      newAmountMinor: 38_400_000,
      deltaMinor: 38_400_000,
    },
    {
      lineNo: 2,
      action: "omit",
      ref: "F/04",
      description: "300 × 300 mm ceramic floor tiles",
      unit: "m2",
      quantity: null,
      rate: null,
      baseAmountMinor: 15_600_000,
      newAmountMinor: 0,
      deltaMinor: -15_600_000,
    },
  ],
  totals: { additionsMinor: 38_400_000, omissionsMinor: 15_600_000, netMinor: 22_800_000 },
  vatRatePercent: VAT,
  baseGrandTotalMinor: 8_640_000_000,
  projectedGrandTotalMinor: 8_666_448_000,
  grandTotalEffectMinor: 26_448_000,
};
const CLIENT_DIGEST = sha256(clientVariationText(variationView));

/** Balances of the certificates with the payments recorded so far (rule D-133). */
function ledger(rows: Certificate[], payments: Payment[], format: Instructions | null) {
  const today = nairobiDate();
  const statement = clientStatement({
    certificates: rows.map((row) => ({
      id: row.id,
      number: row.number,
      certifiedOn: row.certifiedOn,
      dueDate: certificateDueDate(row.certifiedOn, TERMS_DAYS),
      totalMinor: row.amountDueMinor + row.vatMinor,
    })),
    payments,
    today,
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const wire: ClientCertificate[] = statement.certificates.map((row) => {
    const source = byId.get(row.id)!;
    return {
      id: row.id,
      number: row.number,
      kind: "interim",
      releaseStage: null,
      valuationDate: source.valuationDate,
      certifiedOn: row.certifiedOn,
      dueDate: row.dueDate,
      amountDueMinor: source.amountDueMinor,
      vatPercent: VAT,
      vatMinor: source.vatMinor,
      totalMinor: row.totalMinor,
      receivedMinor: row.receivedMinor,
      creditedMinor: row.creditedMinor,
      outstandingMinor: row.outstandingMinor,
      state: row.state,
      overdue: row.overdue,
      overdueDays: row.overdueDays,
      accountReference:
        format?.paybillNumber || format?.tillNumber
          ? paybillAccountReference(format.accountFormat, ruiru.code, Number(row.number.slice(4)))
          : null,
    };
  });
  return {
    today,
    certificates: wire,
    entries: statement.entries,
    totals: {
      certifiedMinor: statement.certifiedMinor,
      receivedMinor: statement.receivedMinor,
      outstandingMinor: statement.outstandingMinor,
      overdueMinor: statement.overdueMinor,
    },
  };
}

const reversedIds = (payments: Payment[]) =>
  new Map(
    payments
      .filter((payment) => payment.kind === "reversal" && payment.reversesId)
      .map((payment) => [payment.reversesId!, payment.id]),
  );

function clientReceipts(payments: Payment[], rows: Certificate[]) {
  const reversed = reversedIds(payments);
  const numbers = new Map(rows.map((row) => [row.id, row.number]));
  return payments.map((payment) => ({
    id: payment.id,
    kind: payment.kind,
    certificateId: payment.certificateId,
    certificateNumber: numbers.get(payment.certificateId)!,
    receivedOn: payment.receivedOn,
    amountMinor: payment.amountMinor,
    method: payment.method,
    reference: payment.reference,
    reversesId: payment.reversesId,
    reason: payment.reason,
    reversed: reversed.has(payment.id),
    recordedAt: payment.recordedAt,
  }));
}

// The client persona --------------------------------------------------------------------------

type ClientState = {
  currency: DisplayCurrency;
  payments: Payment[];
  decision: Decision | null;
};
const clientStates = new Map<string, ClientState>();

function clientState(session: string): ClientState {
  let state = clientStates.get(session);
  if (!state) {
    state = { currency: "GBP", payments: [firstReceipt()], decision: null };
    clientStates.set(session, state);
  }
  return state;
}

function display(currency: DisplayCurrency): ClientDisplay {
  if (currency === "KES") return { currency, rate: null };
  const rate = rates().find(
    (entry) => entry.currency === currency && fxRateUsable(entry.rateDate, nairobiDate()),
  );
  return {
    currency,
    rate: rate
      ? {
          currency: rate.currency,
          kesPerUnit: rate.kesPerUnit,
          rateDate: rate.rateDate,
          source: rate.source,
        }
      : null,
  };
}

const milestones = [
  {
    id: "32000000-0000-4000-8000-000000000001",
    name: "Foundations complete",
    dueDate: "2026-05-15",
    status: "achieved" as const,
    actualDate: "2026-05-12",
  },
  {
    id: "32000000-0000-4000-8000-000000000002",
    name: "First floor slab",
    dueDate: "2026-12-01",
    status: "in_progress" as const,
    actualDate: null,
  },
  {
    id: "32000000-0000-4000-8000-000000000003",
    name: "Roof",
    dueDate: "2027-02-15",
    status: "planned" as const,
    actualDate: null,
  },
];

const diaries = () => [
  {
    id: "33000000-0000-4000-8000-000000000001",
    date: day(-1),
    siteName: "Main plot",
    workPerformed: "Synthetic: first-floor columns cast and cured.",
    weather: "Dry",
    delays: null,
    workforceCount: 18,
    workforce: {
      total: 18,
      trades: [
        { key: "mason", nameEn: "Mason", nameSw: "Mwashi", headcount: 6 },
        { key: "general_labour", nameEn: "General labour", nameSw: "Kibarua", headcount: 12 },
      ],
    },
    approvedAt: `${day(-1)}T15:00:00.000Z`,
  },
];

const photos = () => [
  {
    id: PHOTO_VERIFIED,
    siteName: "Main plot",
    caption: "Synthetic: first-floor columns",
    capturedAt: `${day(-1)}T08:30:00.000Z`,
    timeSource: "gps" as const,
    uploadedAt: `${day(-1)}T09:00:00.000Z`,
    verified: true,
    checks: { location: "inside" as const, time: "ok" as const, distanceM: null },
    width: 1600,
    height: 1200,
  },
  {
    id: PHOTO_UNVERIFIED,
    siteName: "Main plot",
    caption: "Synthetic: scaffold seen from the road",
    capturedAt: `${day(-3)}T13:10:00.000Z`,
    timeSource: "assumed_nairobi" as const,
    uploadedAt: `${day(-3)}T14:00:00.000Z`,
    verified: false,
    checks: { location: "missing" as const, time: "ok" as const, distanceM: null },
    width: 1600,
    height: 1200,
  },
];

function progress() {
  const bac = 8_000_000_000;
  const curve = Array.from({ length: 8 }, (_, index) => {
    const week = index - 7;
    const pv = Math.round(bac * (0.1 + index * 0.05));
    const ev = Math.round(bac * (0.09 + index * 0.048));
    return {
      weekEnd: day(week * 7),
      pvMinor: pv,
      evMinor: ev,
      plannedPercent: ((pv / bac) * 100).toFixed(1),
      earnedPercent: ((ev / bac) * 100).toFixed(1),
    };
  });
  const last = curve.at(-1)!;
  return {
    curve,
    figures: {
      bacMinor: bac,
      evMinor: last.evMinor,
      pvMinor: last.pvMinor,
      percentComplete: last.earnedPercent,
      plannedPercent: last.plannedPercent,
      variancePoints: (Number(last.earnedPercent) - Number(last.plannedPercent)).toFixed(1),
    },
  };
}

function requestWire(state: ClientState) {
  const outcome = state.decision?.decision === "rejected" ? "rejected" : "in_review";
  return {
    id: REQUEST,
    number: variationView.number,
    title: variationView.title,
    sentAt: `${day(-2)}T11:00:00.000Z`,
    message: "Synthetic: please confirm the tile upgrade before we order.",
    netMinor: variationView.totals.netMinor,
    grandTotalEffectMinor: variationView.grandTotalEffectMinor,
    state: state.decision?.decision ?? ("awaiting_decision" as const),
    outcome: outcome as "in_review" | "rejected",
    decision: state.decision,
  };
}

const PROJECT_PATH = new RegExp(`^/portal/client/projects/([^/]+)(?:/(.*))?$`);

/** The client persona's `/portal/client/*` replies (JSON); files are `clientPortalFile`. */
export function handleClientPortal(
  session: string,
  method: string,
  path: string,
  query: URLSearchParams,
  body: unknown,
  fail: Fail,
  parse: Parse,
): Reply {
  const state = clientState(session);
  const chosen = (query.get("currency") as DisplayCurrency | null) ?? state.currency;
  const shown = display(["KES", "USD", "GBP", "EUR"].includes(chosen) ? chosen : state.currency);
  const paying = instructions();
  const money = ledger(certificates(), state.payments, paying);
  const project = {
    ...ruiru,
    county: "kiambu" as const,
    town: "Ruiru",
    startDate: "2026-03-02",
    endDate: "2027-04-30",
    contractSumMinor: 8_640_000_000,
    currency: "KES" as const,
    milestones: { total: 3, achieved: 1 },
    balance: money.totals,
    awaitingDecisions: state.decision ? 0 : 1,
  };
  if (method === "GET" && path === "/portal/client/preferences")
    return {
      body: { displayCurrency: state.currency, rates: rates() },
      schema: clientPreferencesResponseSchema,
    };
  if (method === "PUT" && path === "/portal/client/preferences") {
    state.currency = parse(updateClientPreferencesRequestSchema, body).displayCurrency;
    return {
      body: { displayCurrency: state.currency, rates: rates() },
      schema: clientPreferencesResponseSchema,
    };
  }
  if (method === "GET" && path === "/portal/client/projects")
    return {
      body: { company: TENANT, projects: [project], display: shown },
      schema: clientPortalProjectsResponseSchema,
    };
  const match = PROJECT_PATH.exec(path);
  if (!match) throw fail(404, "not-found");
  // Projects the client is not assigned to do not exist for them.
  if (match[1] !== CLIENT_PROJECT_ID) throw fail(404, "not-found");
  const rest = match[2] ?? "";
  if (method === "GET" && rest === "") {
    const { figures } = progress();
    const next = money.certificates.find((row) => row.outstandingMinor > 0) ?? null;
    return {
      body: {
        project,
        progress: {
          dataDate: nairobiDate(),
          percentComplete: figures.percentComplete,
          plannedPercent: figures.plannedPercent,
          variancePoints: figures.variancePoints,
          bqVersionNo: 2,
          baselineName: "Contract programme",
        },
        milestones,
        diaries: diaries(),
        nextDue: next
          ? {
              certificateId: next.id,
              number: next.number,
              dueDate: next.dueDate,
              outstandingMinor: next.outstandingMinor,
              overdue: next.overdue,
            }
          : null,
        photos: { total: 2, verified: 1 },
        display: shown,
      },
      schema: clientPortalOverviewResponseSchema,
    };
  }
  if (method === "GET" && rest === "progress") {
    const { curve, figures } = progress();
    return {
      body: {
        project: ruiru,
        dataDate: nairobiDate(),
        bqVersion: { versionNo: 2 },
        baseline: { name: "Contract programme", startDate: "2026-03-02", finishDate: "2027-04-30" },
        figures,
        curve,
        curveTruncated: false,
        milestones,
        display: shown,
      },
      schema: clientProgressResponseSchema,
    };
  }
  if (method === "GET" && rest === "photos")
    return {
      body: {
        project: ruiru,
        photos: photos(),
        nextCursor: null,
        counts: { total: 2, verified: 1 },
      },
      schema: clientPhotosResponseSchema,
    };
  if (method === "GET" && rest === "diaries")
    return {
      body: { project: ruiru, diaries: diaries(), nextCursor: null },
      schema: clientDiariesResponseSchema,
    };
  if (method === "GET" && rest === "statement")
    return {
      body: {
        project: ruiru,
        company: { name: TENANT.name },
        clientName: "Ruiru Heights Developers Ltd (synthetic)",
        today: money.today,
        paymentTermsDays: TERMS_DAYS,
        certificates: money.certificates,
        receipts: clientReceipts(state.payments, certificates()),
        entries: money.entries,
        totals: money.totals,
        generatedAt: now(),
        display: shown,
      },
      schema: clientStatementResponseSchema,
    };
  if (method === "GET" && rest === "pay")
    return {
      body: {
        project: ruiru,
        instructions: publicInstructions(paying),
        certificates: money.certificates.filter((row) => row.outstandingMinor > 0),
        totals: money.totals,
        stk: { available: false, reason: "provider-not-connected" },
        display: shown,
      },
      schema: clientPayResponseSchema,
    };
  const stk = /^certificates\/([^/]+)\/stk-push$/.exec(rest);
  if (method === "POST" && stk) {
    parse(clientStkPushRequestSchema, body);
    const row = money.certificates.find((entry) => entry.id === stk[1]);
    if (!row) throw fail(404, "not-found");
    if (row.outstandingMinor <= 0) throw fail(409, "nothing-outstanding");
    throw fail(503, "stk-push-unavailable");
  }
  if (method === "GET" && rest === "variations")
    return {
      body: {
        project: ruiru,
        approvalRequired: true,
        requests: [requestWire(state)],
        display: shown,
      },
      schema: clientVariationsResponseSchema,
    };
  const variation = /^variations\/([^/]+)(\/decision)?$/.exec(rest);
  if (variation && variation[1] !== REQUEST) throw fail(404, "not-found");
  if (variation && method === "GET" && !variation[2])
    return {
      body: {
        project: ruiru,
        approvalRequired: true,
        request: {
          ...requestWire(state),
          view: variationView,
          clientDigest: CLIENT_DIGEST,
          canDecide: state.decision === null,
        },
        display: shown,
      },
      schema: clientVariationDetailResponseSchema,
    };
  if (variation && method === "POST" && variation[2]) {
    const input = parse(clientDecisionRequestSchema, body);
    if (state.decision) throw fail(409, "already-decided");
    if (input.clientDigest !== CLIENT_DIGEST) throw fail(409, "variation-stale");
    state.decision = {
      decision: input.decision,
      comment: input.comment?.trim() || null,
      decidedBy: CLIENT,
      decidedAt: now(),
    };
    return {
      status: 201,
      body: {
        project: ruiru,
        approvalRequired: true,
        request: {
          ...requestWire(state),
          view: variationView,
          clientDigest: CLIENT_DIGEST,
          canDecide: false,
        },
        display: shown,
      },
      schema: clientVariationDetailResponseSchema,
    };
  }
  throw fail(404, "not-found");
}

// A tiny JPEG with no metadata: the portal's photos are re-encoded without EXIF or GPS.
const TINY_JPEG = Buffer.from(
  "/9j/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAGAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAgT/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCgClf/2Q==",
  "base64",
);

/** Bytes the client downloads: photo images (no EXIF), statements and certificate PDFs. */
export function clientPortalFile(
  path: string,
): { contentType: string; content: Buffer; filename?: string } | null {
  const match = PROJECT_PATH.exec(path);
  if (!match || match[1] !== CLIENT_PROJECT_ID) return null;
  const rest = match[2] ?? "";
  const image = /^photos\/([^/]+)\/image$/.exec(rest);
  if (image)
    return [PHOTO_VERIFIED, PHOTO_UNVERIFIED].includes(image[1]!)
      ? { contentType: "image/jpeg", content: TINY_JPEG }
      : null;
  const exported = /^statement\/export\/(pdf|xlsx)$/.exec(rest);
  if (exported) return exportFile(exported[1] as "pdf" | "xlsx", "client-statement");
  const certificate = /^certificates\/([^/]+)\/pdf$/.exec(rest);
  if (certificate)
    return [CERT_1, CERT_2].includes(certificate[1]!)
      ? {
          contentType: "application/pdf",
          content: Buffer.from("%PDF-1.4\n% mock certificate\n%%EOF\n"),
          filename: "certificate.pdf",
        }
      : null;
  return null;
}

function exportFile(kind: "pdf" | "xlsx", name: string) {
  return kind === "pdf"
    ? {
        contentType: "application/pdf",
        content: Buffer.from(`%PDF-1.4\n% mock ${name}\n%%EOF\n`),
        filename: `${name}.pdf`,
      }
    : {
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        content: Buffer.from(`PK mock ${name}`),
        filename: `${name}.xlsx`,
      };
}

// Staff ---------------------------------------------------------------------------------------

export type ClientPortalStaffState = {
  payments: Payment[];
  settings: {
    version: number;
    clientApprovalRequired: boolean;
    paymentTermsDays: number;
    updatedBy: Person | null;
    updatedAt: string | null;
  };
  instructions: Instructions | null;
  rates: FxRate[];
  replays: Map<string, string>;
};

export const initialClientPortalStaff = (): ClientPortalStaffState => ({
  payments: [firstReceipt()],
  settings: {
    version: 1,
    clientApprovalRequired: true,
    paymentTermsDays: TERMS_DAYS,
    updatedBy: PM,
    updatedAt: `${day(-60)}T08:00:00.000Z`,
  },
  instructions: instructions(),
  rates: rates(),
  replays: new Map(),
});

export type ClientPortalStaffDeps = {
  fail: Fail;
  parse: Parse;
  actor: Person;
  project(projectId: string): { id: string; code: string; name: string; status: string } | null;
  projectPermissions(projectId: string): readonly Permission[];
  companyPermissions: readonly Permission[];
  tenantWide: boolean;
  requireStepUp(): void;
  idempotencyKey?: string;
};

const readOnly = (status: string) => status === "closed" || status === "cancelled";

/** `/projects/:id/client-payments…`, `/projects/:id/client-settings` and `/client-portal/*`. */
export function handleClientPortalStaff(
  deps: ClientPortalStaffDeps,
  state: ClientPortalStaffState,
  method: string,
  path: string,
  body: unknown,
): Reply | null {
  if (path === "/client-portal/payment-instructions")
    return instructionsReply(deps, state, method, body);
  if (path === "/client-portal/fx-rates") return ratesReply(deps, state, method, body);
  const match =
    /^\/projects\/([^/]+)\/(client-payments|client-settings)(?:\/([^/]+)\/reverse)?$/.exec(path);
  if (!match) return null;
  const project = deps.project(match[1]!);
  if (!project) throw deps.fail(404, "not-found");
  const permissions = deps.projectPermissions(project.id);
  if (
    !["bq.edit", "finance.view", "finance.manage"].some((p) =>
      permissions.includes(p as Permission),
    )
  )
    throw deps.fail(403, "forbidden");
  const rows = project.id === CLIENT_PROJECT_ID ? certificates() : [];
  const payments = project.id === CLIENT_PROJECT_ID ? state.payments : [];
  const view = (status?: number): Reply => {
    const money = ledger(rows, payments, state.instructions);
    const reversed = reversedIds(payments);
    return {
      status,
      body: {
        project: { id: project.id, code: project.code, name: project.name, status: project.status },
        clientName:
          project.id === CLIENT_PROJECT_ID ? "Ruiru Heights Developers Ltd (synthetic)" : null,
        today: money.today,
        certificates: money.certificates,
        payments: clientReceipts(payments, rows).map((payment, index) => ({
          ...payment,
          note: payments[index]!.note,
          recordedBy: payments[index]!.recordedBy,
          reversedBy: reversed.get(payment.id) ?? null,
        })),
        entries: money.entries,
        totals: money.totals,
        settings: state.settings,
        clientMembers: project.id === CLIENT_PROJECT_ID ? 1 : 0,
        readOnly: readOnly(project.status),
        permissions: {
          canRecord: permissions.includes("finance.manage") && !readOnly(project.status),
          canManageSettings: permissions.includes("projects.manage") && !readOnly(project.status),
        },
      },
      schema: clientPaymentsResponseSchema,
    };
  };
  if (method === "GET" && match[2] === "client-payments" && !match[3]) return view();
  if (readOnly(project.status)) throw deps.fail(409, "project-read-only");
  if (method === "PUT" && match[2] === "client-settings") {
    if (!permissions.includes("projects.manage")) throw deps.fail(403, "forbidden");
    const input = deps.parse(updateClientSettingsRequestSchema, body);
    if (input.version !== state.settings.version) throw deps.fail(409, "version-conflict");
    state.settings = {
      version: state.settings.version + 1,
      clientApprovalRequired: input.clientApprovalRequired,
      paymentTermsDays: input.paymentTermsDays,
      updatedBy: deps.actor,
      updatedAt: now(),
    };
    return view();
  }
  if (method !== "POST" || match[2] !== "client-payments") throw deps.fail(404, "not-found");
  if (!permissions.includes("finance.manage")) throw deps.fail(403, "forbidden");
  if (!deps.idempotencyKey) throw deps.fail(400, "idempotency-key-required");
  const replay = (id: string, digest: string): Reply | null => {
    const seen = state.replays.get(deps.idempotencyKey!);
    if (seen === undefined) {
      if (state.payments.some((payment) => payment.id === id))
        throw deps.fail(409, "payment-id-conflict");
      state.replays.set(deps.idempotencyKey!, digest);
      return null;
    }
    if (seen !== digest) throw deps.fail(409, "idempotency-key-reused");
    return view(201);
  };
  if (match[3]) {
    const input = deps.parse(reverseClientPaymentRequestSchema, body);
    const replayed = replay(input.id, sha256(`reverse:${match[3]}:${JSON.stringify(input)}`));
    if (replayed) return replayed;
    const original = state.payments.find((payment) => payment.id === match[3]);
    if (!original) throw deps.fail(404, "not-found");
    if (original.kind !== "receipt") throw deps.fail(409, "receipt-not-reversible");
    if (reversedIds(state.payments).has(original.id))
      throw deps.fail(409, "receipt-already-reversed");
    state.payments.push({
      ...original,
      id: input.id,
      kind: "reversal",
      receivedOn: nairobiDate(),
      method: null,
      reference: null,
      reversesId: original.id,
      reason: input.reason.trim(),
      note: null,
      recordedBy: deps.actor,
      recordedAt: now(),
    });
    return view(201);
  }
  const input = deps.parse(recordClientPaymentRequestSchema, body);
  const replayed = replay(input.id, sha256(`record:${JSON.stringify(input)}`));
  if (replayed) return replayed;
  const money = ledger(rows, payments, state.instructions);
  const row = money.certificates.find((entry) => entry.id === input.valuationId);
  if (!row) throw deps.fail(409, "certificate-not-certified");
  if (input.receivedOn > money.today || input.receivedOn < row.certifiedOn)
    throw deps.fail(422, "receipt-date-invalid");
  if (!receiptFits(input.amountMinor, row.outstandingMinor))
    throw deps.fail(409, "receipt-exceeds-outstanding");
  state.payments.push({
    id: input.id,
    kind: "receipt",
    certificateId: row.id,
    receivedOn: input.receivedOn,
    amountMinor: input.amountMinor,
    method: input.method,
    reference: input.reference.trim(),
    reversesId: null,
    reason: null,
    note: input.note?.trim() || null,
    recordedBy: deps.actor,
    recordedAt: now(),
  });
  return view(201);
}

const COMPANY_READERS: Permission[] = ["config.manage", "finance.view", "finance.manage"];

function instructionsReply(
  deps: ClientPortalStaffDeps,
  state: ClientPortalStaffState,
  method: string,
  body: unknown,
): Reply {
  if (!COMPANY_READERS.some((permission) => deps.companyPermissions.includes(permission)))
    throw deps.fail(403, "forbidden");
  const canEdit = deps.companyPermissions.includes("config.manage");
  const reply = (): Reply => {
    const current = state.instructions;
    return {
      body: {
        instructions: current ? publicInstructions(current) : null,
        updatedBy: current?.updatedBy ?? null,
        permissions: { canEdit },
      },
      schema: paymentInstructionsResponseSchema,
    };
  };
  if (method === "GET") return reply();
  if (method !== "PUT") throw deps.fail(404, "not-found");
  if (!canEdit) throw deps.fail(403, "forbidden");
  const input = deps.parse(updatePaymentInstructionsRequestSchema, body);
  deps.requireStepUp();
  if (input.version !== (state.instructions?.version ?? 0))
    throw deps.fail(409, "version-conflict");
  state.instructions = {
    version: input.version + 1,
    paybillNumber: input.paybillNumber,
    tillNumber: input.tillNumber,
    accountName: input.accountName.trim(),
    accountFormat: input.accountFormat,
    bankInstructions: input.bankInstructions?.trim() || null,
    updatedAt: now(),
    updatedBy: deps.actor,
  };
  return reply();
}

function ratesReply(
  deps: ClientPortalStaffDeps,
  state: ClientPortalStaffState,
  method: string,
  body: unknown,
): Reply {
  if (!COMPANY_READERS.some((permission) => deps.companyPermissions.includes(permission)))
    throw deps.fail(403, "forbidden");
  const canEnter =
    deps.companyPermissions.includes("config.manage") ||
    (deps.tenantWide && deps.companyPermissions.includes("finance.manage"));
  const reply = (status?: number): Reply => {
    const today = nairobiDate();
    const ordered = [...state.rates].sort(
      (left, right) =>
        right.rateDate.localeCompare(left.rateDate) ||
        right.enteredAt.localeCompare(left.enteredAt),
    );
    const withUse = ordered.map((rate) => ({
      ...rate,
      usable: fxRateUsable(rate.rateDate, today),
    }));
    return {
      status,
      body: {
        rates: withUse,
        current: (["USD", "GBP", "EUR"] as const).map((currency) => ({
          currency,
          rate: withUse.find((rate) => rate.currency === currency && rate.usable) ?? null,
        })),
        permissions: { canEnter },
      },
      schema: fxRatesResponseSchema,
    };
  };
  if (method === "GET") return reply();
  if (method !== "POST") throw deps.fail(404, "not-found");
  if (!canEnter) throw deps.fail(403, "forbidden");
  const input = deps.parse(createFxRateRequestSchema, body);
  if (input.rateDate > nairobiDate()) throw deps.fail(422, "fx-rate-invalid");
  const [whole, fraction = ""] = input.kesPerUnit.split(".");
  state.rates.push({
    id: randomUUID(),
    currency: input.currency,
    kesPerUnit: `${whole}.${fraction.padEnd(4, "0")}`,
    rateDate: input.rateDate,
    source: input.source.trim(),
    enteredBy: deps.actor,
    enteredAt: now(),
    usable: true,
  });
  return reply(201);
}
