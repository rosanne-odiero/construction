/**
 * D6.3 part B subcontracts and piece-rate jobs in the Playwright mock API, on Ruiru Heights.
 * Fixture (synthetic, KES minor units; rule KE-SUB-1 through the real packages/domain functions):
 *   D internal plaster 450 m² @ 350 (measured 200); E aluminium windows 36 m² @ 9,500 (measured
 *   12); C walling 120 m² @ 1,450 (measured 80).
 *   SC-0001 labour-only plastering (Kamau Plastering): D 450 m² @ 280 = 126,000; retention 5 %
 *   limited to 5 %; advance ADV-01 20,000 paid, recovered at 20 %; WHT 3 %; no VAT. SCC-0001
 *   certified on D 200 m²: work 56,000, retention 2,800, recovery 11,200, due 42,000, WHT 1,260,
 *   payable 40,740 (20,000 paid).
 *   SC-0002 supply-and-fix windows (Nyali Aluminium): E 36 m² @ 8,200 = 295,200, VAT 16 %,
 *   retention 10 % limited to 5 %; draft SCV-0001 with no claims yet.
 *   PRJ-0001 Gang B walling @ 150/m², 100 m² agreed, 96 m² approved against 80 m² measured →
 *   "paid above measured" (16 m²).
 * Permissions follow the API (SUBCONTRACT_* and PIECE_RATE_* lists, role ∩ assignment);
 * maker-checker, step-up and the measured-quantity pool are enforced as the API does.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  checkJobOutput,
  computeSubcontractCertificate,
  jobQuantityInForce,
  nairobiDate,
  outputAmountMinor,
  pieceRateJobCode,
  reconcileItem,
  subcontractAdvanceCode,
  subcontractCertificateCode,
  subcontractCode,
  subcontractLineValueMinor,
  subcontractVariationCode,
  sumQuantities,
} from "@pm-buddy/domain";
import {
  PIECE_RATE_JOB_APPROVE_PERMISSIONS,
  PIECE_RATE_JOB_PREPARE_PERMISSIONS,
  PIECE_RATE_OUTPUT_RECORD_PERMISSIONS,
  PIECE_RATE_READ_PERMISSIONS,
  PIECE_RATE_RECONCILIATION_PERMISSIONS,
  SUBCONTRACT_ADVANCE_APPROVE_PERMISSIONS,
  SUBCONTRACT_ADVANCE_REQUEST_PERMISSIONS,
  SUBCONTRACT_APPROVE_PERMISSIONS,
  SUBCONTRACT_CERTIFY_PERMISSIONS,
  SUBCONTRACT_INVOICE_PERMISSIONS,
  SUBCONTRACT_PAY_PERMISSIONS,
  SUBCONTRACT_PREPARE_PERMISSIONS,
  SUBCONTRACT_READ_PERMISSIONS,
  SUBCONTRACT_RULE_VERSION,
  type Permission,
  type PieceRateJobStatus,
  type SubcontractAdvanceStatus,
  type SubcontractCertificateStatus,
  type SubcontractStatus,
} from "@pm-buddy/types";
import {
  addSubcontractLineRequestSchema,
  createPieceRateExtensionRequestSchema,
  createPieceRateJobRequestSchema,
  createSubcontractAdvanceRequestSchema,
  createSubcontractCertificateRequestSchema,
  createSubcontractRequestSchema,
  createSubcontractVariationRequestSchema,
  matchSubcontractInvoiceRequestSchema,
  outputResponseSchema,
  paySubcontractAdvanceRequestSchema,
  pieceRateJobOptionsResponseSchema,
  pieceRateJobReasonRequestSchema,
  pieceRateJobResponseSchema,
  pieceRateJobsResponseSchema,
  pieceRateJobVersionRequestSchema,
  pieceRateReconciliationResponseSchema,
  projectSubcontractsResponseSchema,
  recordJobOutputRequestSchema,
  recordSubcontractPaymentRequestSchema,
  setSubcontractClaimsRequestSchema,
  subcontractCertificateResponseSchema,
  subcontractDigestRequestSchema,
  subcontractItemsResponseSchema,
  subcontractReasonRequestSchema,
  subcontractResponseSchema,
  subcontractsOverviewResponseSchema,
  subcontractVersionRequestSchema,
  type PieceRateOutput,
  type SubcontractCertificateDetail,
  type SubcontractDetail,
} from "@pm-buddy/validation";
import { z } from "zod";

type Person = { id: string; displayName: string };
type Reply = { status?: number; body: unknown; schema: z.ZodType<unknown> };
type ProjectInfo = { id: string; code: string; name: string };

export type SubcontractsDeps = {
  fail: (status: number, code: string) => Error;
  parse<T>(schema: z.ZodType<T>, body: unknown): T;
  actor: Person;
  projects: ProjectInfo[];
  projectPermissions(projectId: string): readonly Permission[];
  requireStepUp(): void;
  idempotencyKey: string | undefined;
};

type Item = {
  lineageId: string;
  ref: string;
  description: string;
  unit: string;
  quantity: string;
  rate: string;
  measured: string;
};
type Line = {
  id: string;
  lineNo: number;
  lineageId: string;
  quantity: string;
  originalQuantity: string;
  rateMinor: number;
  vatTreatment: "standard" | "zero_rated" | "exempt";
  description: string;
  overQuantityReason: string | null;
};
type Variation = {
  id: string;
  number: number;
  reason: string;
  status: "pending" | "approved" | "rejected";
  changes: { lineId: string; quantityChange: string; amountChangeMinor: number }[];
  createdBy: Person;
  createdAt: string;
  decidedBy: Person | null;
  decisionReason: string | null;
  resultingVersion: number | null;
  version: number;
};
type Advance = {
  id: string;
  number: number;
  amountMinor: number;
  reason: string;
  status: SubcontractAdvanceStatus;
  requestedBy: Person;
  requestedAt: string;
  decidedBy: Person | null;
  paidBy: Person | null;
  paidOn: string | null;
  method: "bank_transfer" | "cheque" | "mpesa" | "cash" | "other" | null;
  reference: string | null;
  version: number;
};
type Subcontract = {
  id: string;
  number: number;
  projectId: string;
  supplierId: string;
  kind: "labour_only" | "supply_and_fix";
  title: string;
  scope: string | null;
  status: SubcontractStatus;
  startDate: string;
  endDate: string;
  terms: {
    retentionPercent: string;
    retentionLimitPercent: string | null;
    practicalReleasePercent: string;
    vatPercent: string;
    whtPercent: string;
    advanceLimitMinor: number;
    advanceRecoveryPercent: string;
    paymentTermsDays: number;
    paymentTermsNote: string | null;
  };
  contractVersion: number;
  originalValueMinor: number | null;
  digest: string | null;
  lines: Line[];
  variations: Variation[];
  advances: Advance[];
  contributors: string[];
  createdBy: Person;
  submittedBy: Person | null;
  approvedBy: Person | null;
  returnReason: string | null;
  cancelReason: string | null;
  version: number;
};
type Payment = {
  id: string;
  amountMinor: number;
  paidOn: string;
  method: "bank_transfer" | "cheque" | "mpesa" | "cash" | "other";
  reference: string;
  recordedBy: Person;
  key: string;
};
type Certificate = {
  id: string;
  number: number;
  subcontractId: string;
  certificateNumber: number | null;
  status: SubcontractCertificateStatus;
  valuationDate: string;
  claims: Map<string, string>;
  frozen: ReturnType<typeof figuresOf> | null;
  digest: string | null;
  contributors: string[];
  createdBy: Person;
  submittedBy: Person | null;
  certifiedBy: Person | null;
  certifiedAt: string | null;
  returnReason: string | null;
  cancelReason: string | null;
  payments: Payment[];
  invoice: {
    id: string;
    invoiceNumber: string;
    invoiceDate: string;
    etimsNumber: string | null;
    amountMinor: number;
    recordedBy: Person;
  } | null;
  version: number;
};
type Job = {
  id: string;
  number: number;
  lineageId: string;
  gangId: string | null;
  labourerId: string | null;
  description: string;
  unit: string;
  rateMinor: number;
  agreedQuantity: string;
  startDate: string;
  endDate: string;
  status: PieceRateJobStatus;
  createdBy: Person;
  decidedBy: Person | null;
  extensions: {
    id: string;
    quantity: string;
    reason: string;
    status: "pending" | "approved" | "rejected";
    requestedBy: Person;
    decidedBy: Person | null;
    version: number;
  }[];
  version: number;
};
type Output = {
  id: string;
  jobId: string;
  workDate: string;
  quantity: string;
  status: "pending" | "approved" | "rejected";
  recordedBy: Person;
  decidedBy: Person | null;
  version: number;
};

export type SubcontractsState = {
  projectId: string;
  items: Item[];
  suppliers: { id: string; code: string; name: string; kraPinMasked: string | null }[];
  subcontracts: Subcontract[];
  certificates: Certificate[];
  jobs: Job[];
  outputs: Output[];
  gangs: {
    id: string;
    name: string;
    members: { id: string; workerNo: string; fullName: string }[];
  }[];
};

const NOW = "2026-11-20T08:00:00.000Z";
const VERSION_ID = "88000000-0000-4000-8000-000000000001";
const BILL = {
  lineageId: "88000000-0000-4000-8000-000000000002",
  number: "3",
  title: "Finishes and windows",
};
const PM: Person = { id: "11111111-1111-4111-8111-111111111113", displayName: "Brian Otieno" };
const OWNER: Person = { id: "11111111-1111-4111-8111-111111111111", displayName: "Wanjiru Kamau" };
const FINANCE: Person = {
  id: "11111111-1111-4111-8111-111111111114",
  displayName: "Daniel Mwangi",
};
const AGENT: Person = { id: "11111111-1111-4111-8111-111111111112", displayName: "Kevin Kiprono" };
export const SC1_ID = "88200000-0000-4000-8000-000000000001";
export const SC2_ID = "88200000-0000-4000-8000-000000000002";
export const SCC1_ID = "88300000-0000-4000-8000-000000000001";
export const SCV2_ID = "88300000-0000-4000-8000-000000000002";
export const JOB1_ID = "88400000-0000-4000-8000-000000000001";

const day = (offset: number) => {
  const date = new Date(`${nairobiDate()}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};
const digestOf = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** The fixture on a project (ids are stable so the specs can open pages directly). */
export function initialSubcontracts(
  projectId: string,
  people: Record<string, Person> = {},
): SubcontractsState {
  const pm = people["pm"] ?? PM;
  const owner = people["owner"] ?? OWNER;
  const finance = people["finance"] ?? FINANCE;
  const agent = people["agent"] ?? AGENT;
  const items: Item[] = [
    {
      lineageId: "88100000-0000-4000-8000-000000000004",
      ref: "D",
      description: "Internal plaster 12 mm to block walls (synthetic)",
      unit: "m2",
      quantity: "450",
      rate: "350",
      measured: "200",
    },
    {
      lineageId: "88100000-0000-4000-8000-000000000005",
      ref: "E",
      description: "Aluminium casement windows, powder-coated (synthetic)",
      unit: "m2",
      quantity: "36",
      rate: "9500",
      measured: "12",
    },
    {
      lineageId: "88100000-0000-4000-8000-000000000003",
      ref: "C",
      description: "Machine-cut stone walling, 200 mm thick (synthetic)",
      unit: "m2",
      quantity: "120",
      rate: "1450",
      measured: "80",
    },
  ];
  const sc1: Subcontract = {
    id: SC1_ID,
    number: 1,
    projectId,
    supplierId: "88500000-0000-4000-8000-000000000001",
    kind: "labour_only",
    title: "Internal plastering (labour only)",
    scope: "Internal plaster to block walls, all floors (synthetic).",
    status: "active",
    startDate: day(-30),
    endDate: day(120),
    terms: {
      retentionPercent: "5",
      retentionLimitPercent: "5",
      practicalReleasePercent: "50",
      vatPercent: "0",
      whtPercent: "3",
      advanceLimitMinor: 2_000_000,
      advanceRecoveryPercent: "20",
      paymentTermsDays: 14,
      paymentTermsNote: null,
    },
    contractVersion: 1,
    originalValueMinor: 12_600_000,
    digest: "a".repeat(64),
    lines: [
      {
        id: "88600000-0000-4000-8000-000000000001",
        lineNo: 1,
        lineageId: items[0]!.lineageId,
        quantity: "450",
        originalQuantity: "450",
        rateMinor: 28_000,
        vatTreatment: "standard",
        description: items[0]!.description,
        overQuantityReason: null,
      },
    ],
    variations: [],
    advances: [
      {
        id: "88700000-0000-4000-8000-000000000001",
        number: 1,
        amountMinor: 2_000_000,
        reason: "Mobilisation advance (synthetic)",
        status: "paid",
        requestedBy: pm,
        requestedAt: NOW,
        decidedBy: finance,
        paidBy: owner,
        paidOn: day(-20),
        method: "bank_transfer",
        reference: "EFT-SC1-ADV-01",
        version: 3,
      },
    ],
    contributors: [pm.id],
    createdBy: pm,
    submittedBy: pm,
    approvedBy: owner,
    returnReason: null,
    cancelReason: null,
    version: 4,
  };
  const sc2: Subcontract = {
    ...sc1,
    id: SC2_ID,
    number: 2,
    supplierId: "88500000-0000-4000-8000-000000000002",
    kind: "supply_and_fix",
    title: "Aluminium windows (supply and fix)",
    scope: null,
    terms: {
      retentionPercent: "10",
      retentionLimitPercent: "5",
      practicalReleasePercent: "50",
      vatPercent: "16",
      whtPercent: "0",
      advanceLimitMinor: 0,
      advanceRecoveryPercent: "0",
      paymentTermsDays: 30,
      paymentTermsNote: null,
    },
    originalValueMinor: 29_520_000,
    lines: [
      {
        id: "88600000-0000-4000-8000-000000000002",
        lineNo: 1,
        lineageId: items[1]!.lineageId,
        quantity: "36",
        originalQuantity: "36",
        rateMinor: 820_000,
        vatTreatment: "standard",
        description: items[1]!.description,
        overQuantityReason: null,
      },
    ],
    advances: [],
  };
  const state: SubcontractsState = {
    projectId,
    items,
    suppliers: [
      {
        id: sc1.supplierId,
        code: "SUP-0005",
        name: "Kamau Plastering",
        kraPinMasked: "P********1Z",
      },
      {
        id: sc2.supplierId,
        code: "SUP-0006",
        name: "Nyali Aluminium",
        kraPinMasked: "P********2Z",
      },
    ],
    subcontracts: [sc1, sc2],
    certificates: [],
    jobs: [
      {
        id: JOB1_ID,
        number: 1,
        lineageId: items[2]!.lineageId,
        gangId: "88800000-0000-4000-8000-000000000001",
        labourerId: null,
        description: "Walling 200 mm (blockwork), first floor",
        unit: "m2",
        rateMinor: 15_000,
        agreedQuantity: "100",
        startDate: day(-14),
        endDate: day(14),
        status: "approved",
        createdBy: pm,
        decidedBy: finance,
        extensions: [],
        version: 2,
      },
    ],
    outputs: (
      [
        ["88900000-0000-4000-8000-000000000001", day(-6), "40"],
        ["88900000-0000-4000-8000-000000000002", day(-4), "30"],
        ["88900000-0000-4000-8000-000000000003", day(-2), "26"],
      ] as const
    ).map(([id, workDate, quantity]) => ({
      id,
      jobId: JOB1_ID,
      workDate,
      quantity,
      status: "approved" as const,
      recordedBy: agent,
      decidedBy: pm,
      version: 2,
    })),
    gangs: [
      {
        id: "88800000-0000-4000-8000-000000000001",
        name: "Gang B: masonry and plaster",
        members: [
          {
            id: "88800000-0000-4000-8000-000000000011",
            workerNo: "W-0011",
            fullName: "Juma Otieno (synthetic)",
          },
          {
            id: "88800000-0000-4000-8000-000000000012",
            workerNo: "W-0012",
            fullName: "Achieng Wafula (synthetic)",
          },
        ],
      },
    ],
  };
  const scc1: Certificate = {
    id: SCC1_ID,
    number: 1,
    subcontractId: SC1_ID,
    certificateNumber: null,
    status: "draft",
    valuationDate: day(-7),
    claims: new Map([[sc1.lines[0]!.id, "200"]]),
    frozen: null,
    digest: null,
    contributors: [pm.id],
    createdBy: pm,
    submittedBy: pm,
    certifiedBy: null,
    certifiedAt: null,
    returnReason: null,
    cancelReason: null,
    payments: [],
    invoice: null,
    version: 4,
  };
  state.certificates.push(scc1);
  scc1.frozen = figuresOf(state, sc1, scc1);
  scc1.digest = digestOf(scc1.frozen);
  scc1.status = "certified";
  scc1.certificateNumber = 1;
  scc1.certifiedBy = finance;
  scc1.certifiedAt = NOW;
  scc1.payments.push({
    id: "88a00000-0000-4000-8000-000000000001",
    amountMinor: 2_000_000,
    paidOn: day(-2),
    method: "bank_transfer",
    reference: "EFT-SC1-SCC1-01",
    recordedBy: owner,
    key: "seed-1",
  });
  state.certificates.push({
    ...scc1,
    id: SCV2_ID,
    number: 1,
    subcontractId: SC2_ID,
    certificateNumber: null,
    status: "draft",
    valuationDate: nairobiDate(),
    claims: new Map(),
    frozen: null,
    digest: null,
    certifiedBy: null,
    certifiedAt: null,
    payments: [],
    invoice: null,
    version: 1,
  });
  return state;
}

// Figures -------------------------------------------------------------------------------------------

function itemOf(state: SubcontractsState, lineageId: string) {
  return state.items.find((item) => item.lineageId === lineageId)!;
}
const bqItem = (item: Item) => ({
  versionId: VERSION_ID,
  lineageId: item.lineageId,
  ref: item.ref,
  description: item.description,
  unit: item.unit,
  bill: BILL,
});
const lineTerms = (line: Line) => ({
  basis: "quantity" as const,
  quantity: line.quantity,
  rateMinor: line.rateMinor,
  amountMinor: subcontractLineValueMinor(
    {
      basis: "quantity",
      quantity: line.quantity,
      rateMinor: line.rateMinor,
      amountMinor: 0,
      vatTreatment: line.vatTreatment,
    },
    line.quantity,
  ),
  vatTreatment: line.vatTreatment,
});
const valueOf = (sc: Subcontract) =>
  sc.lines.reduce((sum, line) => sum + lineTerms(line).amountMinor, 0);
const certifiedOf = (state: SubcontractsState, sc: Subcontract) =>
  state.certificates
    .filter((row) => row.subcontractId === sc.id && row.status === "certified")
    .sort((a, b) => (a.certificateNumber ?? 0) - (b.certificateNumber ?? 0));
/** Other subcontracts' latest certified claims on an item. */
function otherClaims(state: SubcontractsState, sc: Subcontract, lineageId: string) {
  const values: string[] = [];
  for (const other of state.subcontracts.filter((row) => row.id !== sc.id)) {
    const last = certifiedOf(state, other).at(-1);
    for (const line of other.lines.filter((row) => row.lineageId === lineageId))
      values.push(last?.claims.get(line.id) ?? "0");
  }
  return sumQuantities(values);
}

function figuresOf(state: SubcontractsState, sc: Subcontract, certificate: Certificate) {
  const previous = certifiedOf(state, sc).filter((row) => row.id !== certificate.id);
  const last = previous.at(-1);
  const lines = sc.lines.map((line) => {
    const item = itemOf(state, line.lineageId);
    const toDate = certificate.claims.get(line.id) ?? last?.claims.get(line.id) ?? "0";
    const previousQuantity = last?.claims.get(line.id) ?? "0";
    const terms = lineTerms(line);
    const others = otherClaims(state, sc, line.lineageId);
    const pool = sumQuantities([item.measured, `-${others}`]);
    const available = Number(pool) < Number(line.quantity) ? pool : line.quantity;
    return {
      line,
      item,
      toDate,
      previousQuantity,
      others,
      available: Number(available) > 0 ? available : "0",
      valueMinor: subcontractLineValueMinor(terms, toDate),
      previousMinor: subcontractLineValueMinor(terms, previousQuantity),
    };
  });
  const workDoneMinor = lines.reduce((sum, row) => sum + row.valueMinor, 0);
  const figures = computeSubcontractCertificate({
    workDoneMinor,
    vatableWorkDoneMinor: lines
      .filter((row) => row.line.vatTreatment === "standard")
      .reduce((sum, row) => sum + row.valueMinor, 0),
    originalValueMinor: sc.originalValueMinor ?? valueOf(sc),
    stage: "none",
    advancesPaidMinor: sc.advances
      .filter((row) => row.status === "paid" && (row.paidOn ?? "") <= certificate.valuationDate)
      .reduce((sum, row) => sum + row.amountMinor, 0),
    previousCertifiedMinor: previous.reduce(
      (sum, row) => sum + (row.frozen?.figures.amountDueMinor ?? 0),
      0,
    ),
    terms: sc.terms,
  });
  const problems = lines.flatMap((row) =>
    Number(row.toDate) > Number(row.line.quantity)
      ? [{ code: "claim-exceeds-line", ref: row.item.ref }]
      : Number(row.toDate) > Number(row.item.measured) - Number(row.others)
        ? [{ code: "claim-exceeds-measured", ref: row.item.ref }]
        : [],
  );
  return { lines, figures, problems };
}

// Views ---------------------------------------------------------------------------------------------

class Subcontracts {
  private readonly deps: SubcontractsDeps;
  private readonly state: SubcontractsState;
  constructor(deps: SubcontractsDeps, state: SubcontractsState) {
    this.deps = deps;
    this.state = state;
  }

  private permissions() {
    return this.deps.projectPermissions(this.state.projectId);
  }
  private has(list: readonly Permission[]) {
    return list.some((permission) => this.permissions().includes(permission));
  }
  private require(list: readonly Permission[], stepUp = false) {
    if (!this.has(list)) throw this.deps.fail(403, "forbidden");
    if (stepUp) this.deps.requireStepUp();
  }
  private project() {
    const found = this.deps.projects.find((entry) => entry.id === this.state.projectId)!;
    return { id: found.id, code: found.code, name: found.name };
  }
  private supplier(id: string) {
    const found = this.state.suppliers.find((entry) => entry.id === id)!;
    return { ...found, etimsStatus: "registered" };
  }
  private subcontract(id: string) {
    const found = this.state.subcontracts.find((entry) => entry.id === id);
    if (!found) throw this.deps.fail(404, "not-found");
    return found;
  }
  private certificate(id: string) {
    const found = this.state.certificates.find((entry) => entry.id === id);
    if (!found) throw this.deps.fail(404, "not-found");
    return found;
  }
  private checkVersion(current: number, sent: number) {
    if (current !== sent) throw this.deps.fail(409, "version-conflict");
  }

  private position(sc: Subcontract) {
    const certified = certifiedOf(this.state, sc);
    const last = certified.at(-1)?.frozen?.figures;
    const sum = (pick: (f: NonNullable<typeof last>) => number) =>
      certified.reduce((total, row) => total + (row.frozen ? pick(row.frozen.figures) : 0), 0);
    const paid = certified.reduce(
      (total, row) => total + row.payments.reduce((s, p) => s + p.amountMinor, 0),
      0,
    );
    const advancesPaid = sc.advances
      .filter((row) => row.status === "paid")
      .reduce((s, row) => s + row.amountMinor, 0);
    const recovered = last?.recoveredToDateMinor ?? 0;
    return {
      certifiedWorkMinor: last?.workDoneMinor ?? 0,
      certifiedDueMinor: sum((f) => f.amountDueMinor),
      vatMinor: sum((f) => f.vatMinor),
      whtMinor: sum((f) => f.whtMinor),
      payableMinor: sum((f) => f.payableMinor),
      paidMinor: paid,
      outstandingMinor: sum((f) => f.payableMinor) - paid,
      retentionHeldMinor: last?.retentionHeldMinor ?? 0,
      advancesPaidMinor: advancesPaid,
      advancesRecoveredMinor: recovered,
      advancesOutstandingMinor: advancesPaid - recovered,
    };
  }
  private committed(sc: Subcontract) {
    if (!["approved", "active"].includes(sc.status)) return 0;
    return Math.max(0, valueOf(sc) - this.position(sc).certifiedWorkMinor);
  }
  private summary(sc: Subcontract) {
    const open = this.state.certificates.find(
      (row) => row.subcontractId === sc.id && ["draft", "submitted"].includes(row.status),
    );
    return {
      id: sc.id,
      number: sc.number,
      code: subcontractCode(sc.number),
      project: this.project(),
      supplier: this.supplier(sc.supplierId),
      kind: sc.kind,
      title: sc.title,
      status: sc.status,
      startDate: sc.startDate,
      endDate: sc.endDate,
      contractVersion: sc.contractVersion,
      valueMinor: valueOf(sc),
      originalValueMinor: sc.originalValueMinor,
      committedMinor: this.committed(sc),
      position: this.position(sc),
      openCertificate: open
        ? {
            id: open.id,
            number: open.number,
            code: subcontractCertificateCode(open.number, false),
            status: open.status,
          }
        : null,
      version: sc.version,
      updatedAt: NOW,
    };
  }
  private certificateSummary(row: Certificate) {
    const f = row.frozen?.figures;
    return {
      id: row.id,
      number: row.number,
      code: subcontractCertificateCode(
        row.certificateNumber ?? row.number,
        row.certificateNumber !== null,
      ),
      certificateNumber: row.certificateNumber,
      kind: "interim" as const,
      releaseStage: null,
      status: row.status,
      valuationDate: row.valuationDate,
      workDoneMinor: f?.workDoneMinor ?? null,
      amountDueMinor: f?.amountDueMinor ?? null,
      payableMinor: f?.payableMinor ?? null,
      paidMinor: row.payments.reduce((sum, payment) => sum + payment.amountMinor, 0),
      certifiedAt: row.certifiedAt,
    };
  }

  detail(sc: Subcontract): SubcontractDetail {
    const me = this.deps.actor.id;
    const prepare = this.has(SUBCONTRACT_PREPARE_PERMISSIONS);
    const approve = this.has(SUBCONTRACT_APPROVE_PERMISSIONS);
    const last = certifiedOf(this.state, sc).at(-1);
    const lets = (lineageId: string) =>
      sumQuantities(
        this.state.subcontracts
          .filter((row) => row.id !== sc.id && ["approved", "active"].includes(row.status))
          .flatMap((row) =>
            row.lines.filter((line) => line.lineageId === lineageId).map((line) => line.quantity),
          ),
      );
    const open = ["approved", "active"].includes(sc.status);
    return {
      ...this.summary(sc),
      scope: sc.scope,
      terms: sc.terms,
      digest: sc.digest,
      currentDigest: digestOf({ id: sc.id, terms: sc.terms, lines: sc.lines }),
      createdBy: sc.createdBy,
      createdAt: NOW,
      submittedBy: sc.submittedBy,
      submittedAt: sc.submittedBy ? NOW : null,
      approvedBy: sc.approvedBy,
      approvedAt: sc.approvedBy ? NOW : null,
      activatedBy: sc.status === "active" ? PM : null,
      activatedAt: sc.status === "active" ? NOW : null,
      closedBy: null,
      closedAt: null,
      closeReason: null,
      cancelledBy: sc.cancelReason ? this.deps.actor : null,
      cancelledAt: sc.cancelReason ? NOW : null,
      cancelReason: sc.cancelReason,
      returnReason: sc.returnReason,
      lines: sc.lines.map((line) => {
        const item = itemOf(this.state, line.lineageId);
        const terms = lineTerms(line);
        const certified = last?.claims.get(line.id) ?? "0";
        return {
          id: line.id,
          lineNo: line.lineNo,
          bqItem: bqItem(item),
          basis: "quantity" as const,
          description: line.description,
          unit: item.unit,
          quantity: line.quantity,
          originalQuantity: line.originalQuantity,
          rateMinor: line.rateMinor,
          amountMinor: terms.amountMinor,
          vatTreatment: line.vatTreatment,
          overQuantityReason: line.overQuantityReason,
          addedBy: null,
          inForce: true,
          bqQuantity: item.quantity,
          bqRate: item.rate,
          rateAboveBq: line.rateMinor > Number(item.rate) * 100,
          letElsewhere: lets(line.lineageId),
          measuredToDate: item.measured,
          certifiedQuantity: certified,
          certifiedMinor: subcontractLineValueMinor(terms, certified),
        };
      }),
      variations: sc.variations.map((variation) => ({
        id: variation.id,
        number: variation.number,
        code: subcontractVariationCode(variation.number),
        reason: variation.reason,
        status: variation.status,
        valueChangeMinor: variation.changes.reduce(
          (sum, change) => sum + change.amountChangeMinor,
          0,
        ),
        digest: digestOf(variation.changes),
        resultingVersion: variation.resultingVersion,
        additions: [],
        changes: variation.changes.map((change) => ({
          ...change,
          lineNo: sc.lines.find((line) => line.id === change.lineId)!.lineNo,
          overQuantityReason: null,
        })),
        createdBy: variation.createdBy,
        createdAt: variation.createdAt,
        decidedBy: variation.decidedBy,
        decidedAt: variation.decidedBy ? NOW : null,
        decisionReason: variation.decisionReason,
        version: variation.version,
        permissions: {
          canApprove: variation.status === "pending" && approve && variation.createdBy.id !== me,
          canReject: variation.status === "pending" && approve && variation.createdBy.id !== me,
        },
      })),
      advances: sc.advances.map((advance) => ({
        id: advance.id,
        number: advance.number,
        code: subcontractAdvanceCode(advance.number),
        amountMinor: advance.amountMinor,
        reason: advance.reason,
        status: advance.status,
        requestedBy: advance.requestedBy,
        requestedAt: advance.requestedAt,
        decidedBy: advance.decidedBy,
        decidedAt: advance.decidedBy ? NOW : null,
        decisionNote: null,
        paidBy: advance.paidBy,
        paidAt: advance.paidBy ? NOW : null,
        paidOn: advance.paidOn,
        method: advance.method,
        reference: advance.reference,
        version: advance.version,
        permissions: {
          canApprove:
            advance.status === "requested" &&
            this.has(SUBCONTRACT_ADVANCE_APPROVE_PERMISSIONS) &&
            advance.requestedBy.id !== me,
          canReject:
            advance.status === "requested" &&
            this.has(SUBCONTRACT_ADVANCE_APPROVE_PERMISSIONS) &&
            advance.requestedBy.id !== me,
          canPay:
            advance.status === "approved" &&
            this.has(SUBCONTRACT_PAY_PERMISSIONS) &&
            advance.requestedBy.id !== me &&
            advance.decidedBy?.id !== me,
          canCancel:
            ["requested", "approved"].includes(advance.status) &&
            (advance.requestedBy.id === me || this.has(SUBCONTRACT_ADVANCE_APPROVE_PERMISSIONS)),
        },
      })),
      certificates: this.state.certificates
        .filter((row) => row.subcontractId === sc.id)
        .map((row) => this.certificateSummary(row)),
      problems: sc.lines.length ? [] : [{ code: "subcontract-empty", ref: null }],
      warnings: [],
      permissions: {
        canEdit: sc.status === "draft" && prepare,
        canSubmit: sc.status === "draft" && prepare && sc.lines.length > 0,
        canApprove: sc.status === "submitted" && approve && !sc.contributors.includes(me),
        canReturn: sc.status === "submitted" && approve,
        canActivate: sc.status === "approved" && (prepare || approve),
        canComplete: sc.status === "active" && (prepare || approve),
        canTerminate: open && approve,
        canCancel: ["draft", "submitted"].includes(sc.status) && (prepare || approve),
        canVary: open && prepare && !sc.variations.some((row) => row.status === "pending"),
        canRequestAdvance: open && this.has(SUBCONTRACT_ADVANCE_REQUEST_PERMISSIONS),
        canCreateCertificate:
          sc.status === "active" &&
          prepare &&
          !this.state.certificates.some(
            (row) => row.subcontractId === sc.id && ["draft", "submitted"].includes(row.status),
          ),
        canExport: true,
      },
    };
  }

  certificateDetail(row: Certificate): SubcontractCertificateDetail {
    const sc = this.subcontract(row.subcontractId);
    const live = figuresOf(this.state, sc, row);
    const view = row.frozen ?? live;
    const me = this.deps.actor.id;
    const paid = row.payments.reduce((sum, payment) => sum + payment.amountMinor, 0);
    const prepare = this.has(SUBCONTRACT_PREPARE_PERMISSIONS);
    const certify = this.has(SUBCONTRACT_CERTIFY_PERMISSIONS);
    return {
      ...this.certificateSummary(row),
      workDoneMinor: row.frozen ? row.frozen.figures.workDoneMinor : null,
      project: this.project(),
      subcontract: {
        id: sc.id,
        code: subcontractCode(sc.number),
        title: sc.title,
        kind: sc.kind,
        status: sc.status,
        contractVersion: sc.contractVersion,
        supplier: this.supplier(sc.supplierId),
      },
      notes: null,
      revision: row.frozen ? 1 : 0,
      ruleVersion: SUBCONTRACT_RULE_VERSION,
      terms: sc.terms,
      originalValueMinor: sc.originalValueMinor ?? valueOf(sc),
      figures: view.figures,
      lines: view.lines.map((line) => ({
        lineId: line.line.id,
        lineNo: line.line.lineNo,
        bqItem: bqItem(line.item),
        basis: "quantity" as const,
        description: line.line.description,
        unit: line.item.unit,
        rateMinor: line.line.rateMinor,
        lineQuantity: line.line.quantity,
        lineAmountMinor: lineTerms(line.line).amountMinor,
        vatTreatment: line.line.vatTreatment,
        measuredToDate: line.item.measured,
        otherClaims: line.others,
        availableQuantity: line.available,
        quantityToDate: line.toDate,
        previousQuantity: line.previousQuantity,
        previousMinor: line.previousMinor,
        valueToDateMinor: line.valueMinor,
        thisPeriodMinor: line.valueMinor - line.previousMinor,
      })),
      digest: row.digest,
      currentDigest: digestOf(live),
      problems: row.status === "draft" ? live.problems : [],
      warnings: [],
      payments: row.payments.map((payment) => ({
        id: payment.id,
        amountMinor: payment.amountMinor,
        paidOn: payment.paidOn,
        method: payment.method,
        reference: payment.reference,
        recordedBy: payment.recordedBy,
        recordedAt: NOW,
      })),
      invoice: row.invoice ? { ...row.invoice, recordedAt: NOW } : null,
      outstandingMinor:
        row.status === "certified" ? (row.frozen?.figures.payableMinor ?? 0) - paid : 0,
      createdBy: row.createdBy,
      createdAt: NOW,
      submittedBy: row.frozen ? row.submittedBy : null,
      submittedAt: row.frozen ? NOW : null,
      certifiedBy: row.certifiedBy,
      cancelledBy: row.cancelReason ? this.deps.actor : null,
      cancelledAt: row.cancelReason ? NOW : null,
      cancelReason: row.cancelReason,
      returnReason: row.returnReason,
      version: row.version,
      permissions: {
        canEdit: row.status === "draft" && prepare,
        canSubmit: row.status === "draft" && prepare,
        canCertify: row.status === "submitted" && certify && !row.contributors.includes(me),
        canReturn: row.status === "submitted" && certify,
        canCancel: ["draft", "submitted"].includes(row.status) && (prepare || certify),
        canPay:
          row.status === "certified" &&
          this.has(SUBCONTRACT_PAY_PERMISSIONS) &&
          row.certifiedBy?.id !== me,
        canMatchInvoice:
          row.status === "certified" && this.has(SUBCONTRACT_INVOICE_PERMISSIONS) && !row.invoice,
        canExport: true,
      },
    };
  }

  overview(): Reply {
    const read = this.has(SUBCONTRACT_READ_PERMISSIONS);
    const pieceRate = this.has(PIECE_RATE_READ_PERMISSIONS);
    if (!read && !pieceRate) throw this.deps.fail(403, "forbidden");
    const rows = this.state.subcontracts.map((sc) => this.summary(sc));
    return {
      body: {
        projects: read
          ? [
              {
                project: this.project(),
                subcontracts: rows.length,
                live: rows.filter((row) => ["approved", "active"].includes(row.status)).length,
                committedMinor: rows.reduce((sum, row) => sum + row.committedMinor, 0),
                certifiedWorkMinor: rows.reduce(
                  (sum, row) => sum + row.position.certifiedWorkMinor,
                  0,
                ),
                retentionHeldMinor: rows.reduce(
                  (sum, row) => sum + row.position.retentionHeldMinor,
                  0,
                ),
                advancesOutstandingMinor: rows.reduce(
                  (sum, row) => sum + row.position.advancesOutstandingMinor,
                  0,
                ),
                openCertificates: rows.filter((row) => row.openCertificate).length,
                pendingApprovals: rows.filter((row) => row.status === "submitted").length,
              },
            ]
          : [],
        subcontractors: read ? this.state.suppliers.map((row) => this.supplier(row.id)) : [],
        pieceRateProjects: pieceRate ? [this.project()] : [],
      },
      schema: subcontractsOverviewResponseSchema,
    };
  }

  projectList(): Reply {
    this.require(SUBCONTRACT_READ_PERMISSIONS);
    const rows = [...this.state.subcontracts]
      .sort((a, b) => b.number - a.number)
      .map((sc) => this.summary(sc));
    return {
      body: {
        project: this.project(),
        subcontracts: rows,
        subcontractors: this.state.suppliers.map((row) => this.supplier(row.id)),
        totals: {
          committedMinor: rows.reduce((sum, row) => sum + row.committedMinor, 0),
          certifiedWorkMinor: rows.reduce((sum, row) => sum + row.position.certifiedWorkMinor, 0),
          retentionHeldMinor: rows.reduce((sum, row) => sum + row.position.retentionHeldMinor, 0),
          advancesOutstandingMinor: rows.reduce(
            (sum, row) => sum + row.position.advancesOutstandingMinor,
            0,
          ),
          outstandingMinor: rows.reduce((sum, row) => sum + row.position.outstandingMinor, 0),
        },
        permissions: {
          canCreate: this.has(SUBCONTRACT_PREPARE_PERMISSIONS),
          canReadPieceRate: this.has(PIECE_RATE_READ_PERMISSIONS),
        },
      },
      schema: projectSubcontractsResponseSchema,
    };
  }

  items(): Reply {
    this.require(SUBCONTRACT_READ_PERMISSIONS);
    return {
      body: {
        bqVersion: { id: VERSION_ID, versionNo: 2 },
        items: this.state.items.map((item) => {
          const letQuantity = sumQuantities(
            this.state.subcontracts
              .filter((row) => ["approved", "active"].includes(row.status))
              .flatMap((row) =>
                row.lines
                  .filter((line) => line.lineageId === item.lineageId)
                  .map((line) => line.quantity),
              ),
          );
          const available = Number(item.quantity) - Number(letQuantity);
          return {
            ...bqItem(item),
            basis: "quantity" as const,
            bqQuantity: item.quantity,
            bqRate: item.rate,
            letQuantity,
            availableQuantity: available > 0 ? String(available) : "0",
          };
        }),
        page: { hasMore: false, nextCursor: null },
      },
      schema: subcontractItemsResponseSchema,
    };
  }

  reply(sc: Subcontract, status = 200): Reply {
    return { status, body: { subcontract: this.detail(sc) }, schema: subcontractResponseSchema };
  }
  certificateReply(row: Certificate, status = 200, replayed = false): Reply {
    return {
      status,
      body: { certificate: this.certificateDetail(row), replayed },
      schema: subcontractCertificateResponseSchema,
    };
  }

  create(body: unknown): Reply {
    this.require(SUBCONTRACT_PREPARE_PERMISSIONS);
    const input = this.deps.parse(createSubcontractRequestSchema, body);
    if (!this.state.suppliers.some((row) => row.id === input.supplierId))
      throw this.deps.fail(409, "subcontractor-not-eligible");
    const sc: Subcontract = {
      id: randomUUID(),
      number: this.state.subcontracts.length + 1,
      projectId: this.state.projectId,
      supplierId: input.supplierId,
      kind: input.kind,
      title: input.title,
      scope: input.scope ?? null,
      status: "draft",
      startDate: input.startDate,
      endDate: input.endDate,
      terms: {
        retentionPercent: input.retentionPercent,
        retentionLimitPercent: input.retentionLimitPercent,
        practicalReleasePercent: input.practicalReleasePercent,
        vatPercent: input.vatPercent,
        whtPercent: input.whtPercent,
        advanceLimitMinor: input.advanceLimitMinor,
        advanceRecoveryPercent: input.advanceRecoveryPercent,
        paymentTermsDays: input.paymentTermsDays,
        paymentTermsNote: input.paymentTermsNote ?? null,
      },
      contractVersion: 0,
      originalValueMinor: null,
      digest: null,
      lines: [],
      variations: [],
      advances: [],
      contributors: [this.deps.actor.id],
      createdBy: this.deps.actor,
      submittedBy: null,
      approvedBy: null,
      returnReason: null,
      cancelReason: null,
      version: 1,
    };
    this.state.subcontracts.push(sc);
    return this.reply(sc, 201);
  }

  addLine(sc: Subcontract, body: unknown): Reply {
    this.require(SUBCONTRACT_PREPARE_PERMISSIONS);
    const input = this.deps.parse(addSubcontractLineRequestSchema, body);
    if (sc.status !== "draft") throw this.deps.fail(409, "invalid-transition");
    this.checkVersion(sc.version, input.version);
    const item = this.state.items.find((row) => row.lineageId === input.bqItemLineageId);
    if (!item) throw this.deps.fail(404, "bq-item-not-found");
    if (input.rateMinor === null) throw this.deps.fail(422, "item-not-measurable");
    if (sc.lines.some((line) => line.lineageId === item.lineageId))
      throw this.deps.fail(409, "line-exists");
    const lets = this.state.subcontracts
      .filter((row) => row.id !== sc.id && ["approved", "active"].includes(row.status))
      .flatMap((row) => row.lines.filter((line) => line.lineageId === item.lineageId))
      .reduce((sum, line) => sum + Number(line.quantity), 0);
    if (lets + Number(input.quantity) > Number(item.quantity) && !input.overQuantityReason)
      throw this.deps.fail(409, "over-bq-quantity");
    sc.lines.push({
      id: randomUUID(),
      lineNo: sc.lines.length + 1,
      lineageId: item.lineageId,
      quantity: input.quantity,
      originalQuantity: input.quantity,
      rateMinor: input.rateMinor,
      vatTreatment: input.vatTreatment,
      description: input.description ?? item.description,
      overQuantityReason: input.overQuantityReason ?? null,
    });
    sc.contributors = [...new Set([...sc.contributors, this.deps.actor.id])];
    sc.version += 1;
    return this.reply(sc);
  }

  removeLine(sc: Subcontract, lineId: string, query: URLSearchParams): Reply {
    this.require(SUBCONTRACT_PREPARE_PERMISSIONS);
    if (sc.status !== "draft") throw this.deps.fail(409, "invalid-transition");
    this.checkVersion(sc.version, Number(query.get("version")));
    sc.lines = sc.lines.filter((line) => line.id !== lineId);
    sc.version += 1;
    return this.reply(sc);
  }

  transition(sc: Subcontract, action: string, body: unknown): Reply {
    const me = this.deps.actor;
    if (action === "submit") {
      this.require(SUBCONTRACT_PREPARE_PERMISSIONS);
      const input = this.deps.parse(subcontractVersionRequestSchema, body);
      if (sc.status !== "draft") throw this.deps.fail(409, "invalid-transition");
      this.checkVersion(sc.version, input.version);
      if (!sc.lines.length) throw this.deps.fail(409, "subcontract-empty");
      sc.status = "submitted";
      sc.submittedBy = me;
      sc.digest = digestOf({ id: sc.id, terms: sc.terms, lines: sc.lines });
      sc.contributors = [...new Set([...sc.contributors, me.id])];
    } else if (action === "approve") {
      this.require(SUBCONTRACT_APPROVE_PERMISSIONS, true);
      const input = this.deps.parse(subcontractDigestRequestSchema, body);
      if (sc.status !== "submitted") throw this.deps.fail(409, "invalid-transition");
      this.checkVersion(sc.version, input.version);
      if (sc.contributors.includes(me.id)) throw this.deps.fail(403, "maker-checker");
      if (input.digest !== sc.digest) throw this.deps.fail(409, "subcontract-stale");
      sc.status = "approved";
      sc.approvedBy = me;
      sc.originalValueMinor = valueOf(sc);
      sc.contractVersion = 1;
    } else if (["return", "cancel", "terminate", "complete"].includes(action)) {
      const input = this.deps.parse(subcontractReasonRequestSchema, body);
      this.require(
        action === "return"
          ? SUBCONTRACT_APPROVE_PERMISSIONS
          : [...SUBCONTRACT_PREPARE_PERMISSIONS, ...SUBCONTRACT_APPROVE_PERMISSIONS],
        action === "terminate",
      );
      this.checkVersion(sc.version, input.version);
      const from: Record<string, SubcontractStatus[]> = {
        return: ["submitted"],
        cancel: ["draft", "submitted"],
        terminate: ["approved", "active"],
        complete: ["active"],
      };
      if (!from[action]!.includes(sc.status)) throw this.deps.fail(409, "invalid-transition");
      sc.status =
        action === "return"
          ? "draft"
          : action === "cancel"
            ? "cancelled"
            : action === "terminate"
              ? "terminated"
              : "completed";
      if (action === "return") {
        sc.returnReason = input.reason;
        sc.digest = null;
      }
      if (action === "cancel") sc.cancelReason = input.reason;
    } else if (action === "activate") {
      this.require([...SUBCONTRACT_PREPARE_PERMISSIONS, ...SUBCONTRACT_APPROVE_PERMISSIONS]);
      const input = this.deps.parse(subcontractVersionRequestSchema, body);
      if (sc.status !== "approved") throw this.deps.fail(409, "invalid-transition");
      this.checkVersion(sc.version, input.version);
      sc.status = "active";
    } else return { status: 404, body: { code: "not-found" }, schema: z.unknown() };
    sc.version += 1;
    return this.reply(sc);
  }

  vary(sc: Subcontract, body: unknown): Reply {
    this.require(SUBCONTRACT_PREPARE_PERMISSIONS);
    const input = this.deps.parse(createSubcontractVariationRequestSchema, body);
    if (!["approved", "active"].includes(sc.status))
      throw this.deps.fail(409, "invalid-transition");
    if (sc.variations.some((row) => row.status === "pending"))
      throw this.deps.fail(409, "subcontract-variation-open");
    const last = certifiedOf(this.state, sc).at(-1);
    const changes = input.changes.map((change) => {
      const line = sc.lines.find((row) => row.id === change.lineId);
      if (!line) throw this.deps.fail(404, "not-found");
      const next = Number(line.quantity) + Number(change.quantityChange);
      if (next < Number(last?.claims.get(line.id) ?? "0"))
        throw this.deps.fail(409, "line-below-certified");
      if (next > Number(itemOf(this.state, line.lineageId).quantity) && !change.overQuantityReason)
        throw this.deps.fail(409, "over-bq-quantity");
      return {
        lineId: line.id,
        quantityChange: change.quantityChange,
        amountChangeMinor: Math.round(Number(change.quantityChange) * line.rateMinor),
      };
    });
    sc.variations.push({
      id: randomUUID(),
      number: sc.variations.length + 1,
      reason: input.reason,
      status: "pending",
      changes,
      createdBy: this.deps.actor,
      createdAt: NOW,
      decidedBy: null,
      decisionReason: null,
      resultingVersion: null,
      version: 1,
    });
    return this.reply(sc, 201);
  }

  decideVariation(
    sc: Subcontract,
    variationId: string,
    action: "approve" | "reject",
    body: unknown,
  ): Reply {
    this.require(SUBCONTRACT_APPROVE_PERMISSIONS, action === "approve");
    const variation = sc.variations.find((row) => row.id === variationId);
    if (!variation) throw this.deps.fail(404, "not-found");
    const input = this.deps.parse(
      z.object({
        version: z.number(),
        digest: z.string().optional(),
        reason: z.string().optional(),
      }),
      body,
    );
    if (variation.status !== "pending") throw this.deps.fail(409, "invalid-transition");
    this.checkVersion(variation.version, input.version);
    if (variation.createdBy.id === this.deps.actor.id) throw this.deps.fail(403, "maker-checker");
    variation.decidedBy = this.deps.actor;
    variation.version += 1;
    if (action === "reject") {
      variation.status = "rejected";
      variation.decisionReason = input.reason ?? null;
    } else {
      if (input.digest !== digestOf(variation.changes))
        throw this.deps.fail(409, "subcontract-variation-stale");
      variation.status = "approved";
      sc.contractVersion += 1;
      variation.resultingVersion = sc.contractVersion;
      for (const change of variation.changes) {
        const line = sc.lines.find((row) => row.id === change.lineId)!;
        line.quantity = String(Number(line.quantity) + Number(change.quantityChange));
      }
      sc.version += 1;
    }
    return this.reply(sc);
  }

  requestAdvance(sc: Subcontract, body: unknown): Reply {
    this.require(SUBCONTRACT_ADVANCE_REQUEST_PERMISSIONS);
    const input = this.deps.parse(createSubcontractAdvanceRequestSchema, body);
    const committed = sc.advances
      .filter((row) => ["requested", "approved", "paid"].includes(row.status))
      .reduce((sum, row) => sum + row.amountMinor, 0);
    if (committed + input.amountMinor > sc.terms.advanceLimitMinor)
      throw this.deps.fail(409, "advance-exceeds-limit");
    sc.advances.push({
      id: randomUUID(),
      number: sc.advances.length + 1,
      amountMinor: input.amountMinor,
      reason: input.reason,
      status: "requested",
      requestedBy: this.deps.actor,
      requestedAt: NOW,
      decidedBy: null,
      paidBy: null,
      paidOn: null,
      method: null,
      reference: null,
      version: 1,
    });
    return this.reply(sc, 201);
  }

  decideAdvance(advanceId: string, action: string, body: unknown): Reply {
    const sc = this.state.subcontracts.find((row) =>
      row.advances.some((advance) => advance.id === advanceId),
    );
    if (!sc) throw this.deps.fail(404, "not-found");
    const advance = sc.advances.find((row) => row.id === advanceId)!;
    const me = this.deps.actor.id;
    if (action === "pay") {
      this.require(SUBCONTRACT_PAY_PERMISSIONS, true);
      const input = this.deps.parse(paySubcontractAdvanceRequestSchema, body);
      if (advance.status !== "approved") throw this.deps.fail(409, "invalid-transition");
      this.checkVersion(advance.version, input.version);
      if (advance.requestedBy.id === me || advance.decidedBy?.id === me)
        throw this.deps.fail(403, "maker-checker");
      Object.assign(advance, {
        status: "paid",
        paidBy: this.deps.actor,
        paidOn: input.paidOn,
        method: input.method,
        reference: input.reference,
      });
    } else {
      this.require(
        action === "cancel"
          ? [...SUBCONTRACT_ADVANCE_REQUEST_PERMISSIONS, ...SUBCONTRACT_ADVANCE_APPROVE_PERMISSIONS]
          : SUBCONTRACT_ADVANCE_APPROVE_PERMISSIONS,
        action === "approve",
      );
      const input = this.deps.parse(
        z.object({ version: z.number(), reason: z.string().optional() }),
        body,
      );
      this.checkVersion(advance.version, input.version);
      if (action !== "cancel" && advance.requestedBy.id === me)
        throw this.deps.fail(403, "maker-checker");
      advance.status =
        action === "approve" ? "approved" : action === "reject" ? "rejected" : "cancelled";
      advance.decidedBy = this.deps.actor;
    }
    advance.version += 1;
    return this.reply(sc);
  }

  createCertificate(sc: Subcontract, body: unknown): Reply {
    this.require(SUBCONTRACT_PREPARE_PERMISSIONS);
    const input = this.deps.parse(createSubcontractCertificateRequestSchema, body);
    if (
      this.state.certificates.some(
        (row) => row.subcontractId === sc.id && ["draft", "submitted"].includes(row.status),
      )
    )
      throw this.deps.fail(409, "certificate-open");
    if (input.kind !== "interim") throw this.deps.fail(409, "completion-not-certified");
    if (sc.status !== "active") throw this.deps.fail(409, "invalid-transition");
    const row: Certificate = {
      id: randomUUID(),
      number: this.state.certificates.filter((entry) => entry.subcontractId === sc.id).length + 1,
      subcontractId: sc.id,
      certificateNumber: null,
      status: "draft",
      valuationDate: input.valuationDate,
      claims: new Map(),
      frozen: null,
      digest: null,
      contributors: [this.deps.actor.id],
      createdBy: this.deps.actor,
      submittedBy: null,
      certifiedBy: null,
      certifiedAt: null,
      returnReason: null,
      cancelReason: null,
      payments: [],
      invoice: null,
      version: 1,
    };
    this.state.certificates.push(row);
    return this.certificateReply(row, 201);
  }

  certificateCommand(row: Certificate, action: string, body: unknown, method: string): Reply {
    const sc = this.subcontract(row.subcontractId);
    const me = this.deps.actor;
    if (action === "claims" && method === "PUT") {
      this.require(SUBCONTRACT_PREPARE_PERMISSIONS);
      const input = this.deps.parse(setSubcontractClaimsRequestSchema, body);
      if (row.status !== "draft") throw this.deps.fail(409, "invalid-transition");
      this.checkVersion(row.version, input.version);
      for (const claim of input.claims) {
        const line = sc.lines.find((entry) => entry.id === claim.lineId);
        if (!line) throw this.deps.fail(404, "not-found");
        if (Number(claim.quantityToDate) > Number(line.quantity))
          throw this.deps.fail(409, "claim-exceeds-line");
        row.claims.set(line.id, claim.quantityToDate);
      }
      row.contributors = [...new Set([...row.contributors, me.id])];
    } else if (action === "submit") {
      this.require(SUBCONTRACT_PREPARE_PERMISSIONS);
      const input = this.deps.parse(subcontractVersionRequestSchema, body);
      if (row.status !== "draft") throw this.deps.fail(409, "invalid-transition");
      this.checkVersion(row.version, input.version);
      const computed = figuresOf(this.state, sc, row);
      if (computed.problems[0]) throw this.deps.fail(409, computed.problems[0].code);
      row.frozen = computed;
      row.digest = digestOf(computed);
      row.status = "submitted";
      row.submittedBy = me;
      row.contributors = [...new Set([...row.contributors, me.id])];
    } else if (action === "certify") {
      this.require(SUBCONTRACT_CERTIFY_PERMISSIONS, true);
      const input = this.deps.parse(subcontractDigestRequestSchema, body);
      if (row.status !== "submitted") throw this.deps.fail(409, "invalid-transition");
      this.checkVersion(row.version, input.version);
      if (row.contributors.includes(me.id)) throw this.deps.fail(403, "maker-checker");
      if (input.digest !== row.digest) throw this.deps.fail(409, "certificate-stale");
      row.certificateNumber = certifiedOf(this.state, sc).length + 1;
      row.status = "certified";
      row.certifiedBy = me;
      row.certifiedAt = NOW;
    } else if (action === "return" || action === "cancel") {
      this.require(
        action === "return"
          ? SUBCONTRACT_CERTIFY_PERMISSIONS
          : [...SUBCONTRACT_PREPARE_PERMISSIONS, ...SUBCONTRACT_CERTIFY_PERMISSIONS],
      );
      const input = this.deps.parse(subcontractReasonRequestSchema, body);
      const allowed = action === "return" ? ["submitted"] : ["draft", "submitted"];
      if (!allowed.includes(row.status)) throw this.deps.fail(409, "invalid-transition");
      this.checkVersion(row.version, input.version);
      if (action === "return") {
        row.status = "draft";
        row.frozen = null;
        row.digest = null;
        row.returnReason = input.reason;
      } else {
        row.status = "cancelled";
        row.cancelReason = input.reason;
      }
    } else if (action === "payments") {
      const key = this.deps.idempotencyKey;
      if (!key) throw this.deps.fail(400, "idempotency-key-required");
      const replay = row.payments.find((payment) => payment.key === key);
      if (replay) return this.certificateReply(row, 200, true);
      this.require(SUBCONTRACT_PAY_PERMISSIONS, true);
      const input = this.deps.parse(recordSubcontractPaymentRequestSchema, body);
      if (row.status !== "certified") throw this.deps.fail(409, "invalid-transition");
      if (row.certifiedBy?.id === me.id) throw this.deps.fail(403, "maker-checker");
      const paid = row.payments.reduce((sum, payment) => sum + payment.amountMinor, 0);
      if (input.amountMinor > (row.frozen?.figures.payableMinor ?? 0) - paid)
        throw this.deps.fail(409, "payment-exceeds-payable");
      row.payments.push({ id: randomUUID(), ...input, recordedBy: me, key });
      return this.certificateReply(row);
    } else if (action === "invoice") {
      this.require(SUBCONTRACT_INVOICE_PERMISSIONS);
      const input = this.deps.parse(matchSubcontractInvoiceRequestSchema, body);
      if (row.status !== "certified") throw this.deps.fail(409, "invalid-transition");
      if (row.invoice) throw this.deps.fail(409, "invoice-exists");
      const f = row.frozen!.figures;
      row.invoice = {
        id: randomUUID(),
        invoiceNumber: input.invoiceNumber,
        invoiceDate: input.invoiceDate,
        etimsNumber: input.etimsNumber ?? null,
        amountMinor: f.amountDueMinor + f.vatMinor,
        recordedBy: me,
      };
      return this.certificateReply(row);
    } else return { status: 404, body: { code: "not-found" }, schema: z.unknown() };
    row.version += 1;
    return this.certificateReply(row);
  }

  // Piece-rate jobs ---------------------------------------------------------------------------------

  private job(id: string) {
    const found = this.state.jobs.find((entry) => entry.id === id);
    if (!found) throw this.deps.fail(404, "not-found");
    return found;
  }
  private output(row: Output, job: Job): PieceRateOutput {
    const gang = this.state.gangs.find((entry) => entry.id === job.gangId) ?? null;
    const amountMinor = outputAmountMinor(row.quantity, job.rateMinor);
    const members = gang?.members ?? [];
    return {
      id: row.id,
      projectId: this.state.projectId,
      workDate: row.workDate,
      labourer: null,
      gang: gang ? { id: gang.id, name: gang.name } : null,
      bqItem: { id: job.lineageId, ref: itemOf(this.state, job.lineageId).ref },
      job: { id: job.id, code: pieceRateJobCode(job.number) },
      description: job.description,
      unit: job.unit,
      quantity: row.quantity,
      rateMinor: job.rateMinor,
      amountMinor,
      status: row.status,
      version: row.version,
      recordedBy: row.recordedBy,
      recordedAt: NOW,
      decidedBy: row.decidedBy,
      decidedAt: row.decidedBy ? NOW : null,
      decisionNote: null,
      shares:
        row.status === "approved"
          ? members.map((member, index) => ({
              id: `${row.id.slice(0, 34)}${String(index).padStart(2, "0")}`,
              labourer: member,
              amountMinor:
                index === 0
                  ? amountMinor - Math.floor(amountMinor / members.length) * (members.length - 1)
                  : Math.floor(amountMinor / members.length),
              batchId: null,
            }))
          : [],
    };
  }
  private jobView(job: Job) {
    const me = this.deps.actor.id;
    const outputs = this.state.outputs.filter((row) => row.jobId === job.id);
    const approved = sumQuantities(
      outputs.filter((row) => row.status === "approved").map((row) => row.quantity),
      3,
    );
    const pending = sumQuantities(
      outputs.filter((row) => row.status === "pending").map((row) => row.quantity),
      3,
    );
    const inForce = jobQuantityInForce(
      job.agreedQuantity,
      job.extensions.filter((row) => row.status === "approved").map((row) => row.quantity),
    );
    const remaining = Math.max(0, Number(inForce) - Number(approved) - Number(pending));
    const gang = this.state.gangs.find((entry) => entry.id === job.gangId) ?? null;
    const decide = this.has(PIECE_RATE_JOB_APPROVE_PERMISSIONS);
    return {
      id: job.id,
      number: job.number,
      code: pieceRateJobCode(job.number),
      projectId: this.state.projectId,
      bqItem: bqItem(itemOf(this.state, job.lineageId)),
      labourer: null,
      gang: gang ? { id: gang.id, name: gang.name } : null,
      description: job.description,
      unit: job.unit,
      bqUnit: itemOf(this.state, job.lineageId).unit,
      conversionFactor: "1",
      rateMinor: job.rateMinor,
      agreedQuantity: job.agreedQuantity,
      quantityInForce: inForce,
      approvedQuantity: approved,
      pendingQuantity: pending,
      remainingQuantity: sumQuantities([String(remaining)], 3),
      approvedAmountMinor: outputs
        .filter((row) => row.status === "approved")
        .reduce((sum, row) => sum + outputAmountMinor(row.quantity, job.rateMinor), 0),
      startDate: job.startDate,
      endDate: job.endDate,
      status: job.status,
      createdBy: job.createdBy,
      createdAt: NOW,
      decidedBy: job.decidedBy,
      decidedAt: job.decidedBy ? NOW : null,
      decisionNote: null,
      closedBy: null,
      closedAt: null,
      version: job.version,
      extensions: job.extensions.map((extension) => ({
        ...extension,
        requestedAt: NOW,
        decidedAt: extension.decidedBy ? NOW : null,
        decisionNote: null,
        permissions: {
          canApprove: extension.status === "pending" && decide && extension.requestedBy.id !== me,
          canReject: extension.status === "pending" && decide && extension.requestedBy.id !== me,
        },
      })),
      permissions: {
        canApprove: job.status === "pending" && decide && job.createdBy.id !== me,
        canReject: job.status === "pending" && decide && job.createdBy.id !== me,
        canClose: job.status === "approved" && this.has(PIECE_RATE_JOB_PREPARE_PERMISSIONS),
        canExtend: job.status === "approved" && this.has(PIECE_RATE_JOB_PREPARE_PERMISSIONS),
        canRecord: job.status === "approved" && this.has(PIECE_RATE_OUTPUT_RECORD_PERMISSIONS),
      },
    };
  }
  jobReply(job: Job, status = 200): Reply {
    return {
      status,
      body: {
        job: this.jobView(job),
        outputs: this.state.outputs
          .filter((row) => row.jobId === job.id)
          .map((row) => this.output(row, job)),
      },
      schema: pieceRateJobResponseSchema,
    };
  }

  readJob(job: Job): Reply {
    this.require(PIECE_RATE_READ_PERMISSIONS);
    return this.jobReply(job);
  }

  jobs(): Reply {
    this.require(PIECE_RATE_READ_PERMISSIONS);
    return {
      body: {
        project: this.project(),
        today: nairobiDate(),
        jobs: this.state.jobs.map((job) => this.jobView(job)),
        permissions: {
          canCreate: this.has(PIECE_RATE_JOB_PREPARE_PERMISSIONS),
          canDecide: this.has(PIECE_RATE_JOB_APPROVE_PERMISSIONS),
          canRecord: this.has(PIECE_RATE_OUTPUT_RECORD_PERMISSIONS),
          canReconcile: this.has(PIECE_RATE_RECONCILIATION_PERMISSIONS),
        },
      },
      schema: pieceRateJobsResponseSchema,
    };
  }

  options(): Reply {
    this.require(PIECE_RATE_JOB_PREPARE_PERMISSIONS);
    return {
      body: {
        project: this.project(),
        items: this.state.items.map((item) => ({
          ...bqItem(item),
          quantity: item.quantity,
          units: [{ unit: item.unit, factor: "1" }],
        })),
        gangs: this.state.gangs.map((gang) => ({
          id: gang.id,
          name: gang.name,
          members: gang.members.length,
        })),
        labourers: this.state.gangs.flatMap((gang) => gang.members),
      },
      schema: pieceRateJobOptionsResponseSchema,
    };
  }

  reconciliation(): Reply {
    this.require(PIECE_RATE_RECONCILIATION_PERMISSIONS);
    const items = this.state.items
      .filter((item) => this.state.jobs.some((job) => job.lineageId === item.lineageId))
      .map((item) => {
        const jobs = this.state.jobs.filter((job) => job.lineageId === item.lineageId);
        const outputs = this.state.outputs.filter((row) =>
          jobs.some((job) => job.id === row.jobId),
        );
        const approved = outputs.filter((row) => row.status === "approved");
        const pieceRate = sumQuantities(
          approved.map((row) => row.quantity),
          3,
        );
        const result = reconcileItem({
          measured: item.measured,
          pieceRate,
          subcontracted: "0",
          unlinkedApproved: 0,
        });
        return {
          bqItem: bqItem(item),
          measured: result.measured,
          measuredOn: nairobiDate(),
          pieceRateQuantity: result.pieceRate,
          pieceRateAmountMinor: approved.reduce(
            (sum, row) =>
              sum +
              outputAmountMinor(row.quantity, jobs.find((job) => job.id === row.jobId)!.rateMinor),
            0,
          ),
          pendingQuantity: sumQuantities(
            outputs.filter((row) => row.status === "pending").map((row) => row.quantity),
            3,
          ),
          subcontractedQuantity: result.subcontracted,
          excessPieceRate: result.excessPieceRate,
          excessCombined: result.excessCombined,
          unlinkedOutputs: 0,
          jobs: jobs.map((job) => ({
            id: job.id,
            code: pieceRateJobCode(job.number),
            status: job.status,
          })),
          flags: result.flags,
        };
      });
    return {
      body: {
        project: this.project(),
        asOf: nairobiDate(),
        items,
        flagged: items.filter((row) => row.flags.some((flag) => flag !== "unlinked-outputs"))
          .length,
      },
      schema: pieceRateReconciliationResponseSchema,
    };
  }

  createJob(body: unknown): Reply {
    this.require(PIECE_RATE_JOB_PREPARE_PERMISSIONS);
    const input = this.deps.parse(createPieceRateJobRequestSchema, body);
    const item = this.state.items.find((row) => row.lineageId === input.bqItemLineageId);
    if (!item) throw this.deps.fail(404, "not-found");
    if (input.unit !== item.unit) throw this.deps.fail(400, "unit-not-convertible");
    const job: Job = {
      id: randomUUID(),
      number: this.state.jobs.length + 1,
      lineageId: item.lineageId,
      gangId: input.gangId,
      labourerId: input.labourerId,
      description: input.description,
      unit: input.unit,
      rateMinor: input.rateMinor,
      agreedQuantity: input.agreedQuantity,
      startDate: input.startDate,
      endDate: input.endDate,
      status: "pending",
      createdBy: this.deps.actor,
      decidedBy: null,
      extensions: [],
      version: 1,
    };
    this.state.jobs.push(job);
    return this.jobReply(job, 201);
  }

  jobCommand(job: Job, action: string, rest: string[], body: unknown): Reply {
    const me = this.deps.actor;
    if (action === "approve" || action === "reject") {
      this.require(PIECE_RATE_JOB_APPROVE_PERMISSIONS);
      const input = this.deps.parse(
        action === "approve" ? pieceRateJobVersionRequestSchema : pieceRateJobReasonRequestSchema,
        body,
      );
      if (job.status !== "pending") throw this.deps.fail(409, "invalid-transition");
      this.checkVersion(job.version, input.version);
      if (job.createdBy.id === me.id) throw this.deps.fail(409, "same-person");
      job.status = action === "approve" ? "approved" : "rejected";
      job.decidedBy = me;
      job.version += 1;
      return this.jobReply(job);
    }
    if (action === "close") {
      this.require(PIECE_RATE_JOB_PREPARE_PERMISSIONS);
      job.status = "closed";
      job.version += 1;
      return this.jobReply(job);
    }
    if (action === "extensions" && rest.length === 0) {
      this.require(PIECE_RATE_JOB_PREPARE_PERMISSIONS);
      const input = this.deps.parse(createPieceRateExtensionRequestSchema, body);
      job.extensions.push({
        id: randomUUID(),
        quantity: input.quantity,
        reason: input.reason,
        status: "pending",
        requestedBy: me,
        decidedBy: null,
        version: 1,
      });
      return this.jobReply(job, 201);
    }
    if (action === "extensions" && rest.length === 2) {
      this.require(PIECE_RATE_JOB_APPROVE_PERMISSIONS);
      const extension = job.extensions.find((row) => row.id === rest[0]);
      if (!extension) throw this.deps.fail(404, "not-found");
      if (extension.requestedBy.id === me.id) throw this.deps.fail(409, "same-person");
      extension.status = rest[1] === "approve" ? "approved" : "rejected";
      extension.decidedBy = me;
      extension.version += 1;
      return this.jobReply(job);
    }
    if (action === "outputs") {
      this.require(PIECE_RATE_OUTPUT_RECORD_PERMISSIONS);
      const input = this.deps.parse(recordJobOutputRequestSchema, body);
      if (job.status !== "approved") throw this.deps.fail(409, "job-not-approved");
      if (input.workDate < job.startDate || input.workDate > job.endDate)
        throw this.deps.fail(409, "job-dates");
      const outputs = this.state.outputs.filter((row) => row.jobId === job.id);
      const check = checkJobOutput({
        inForce: jobQuantityInForce(
          job.agreedQuantity,
          job.extensions.filter((row) => row.status === "approved").map((row) => row.quantity),
        ),
        approved: sumQuantities(
          outputs.filter((row) => row.status === "approved").map((row) => row.quantity),
          3,
        ),
        pending: sumQuantities(
          outputs.filter((row) => row.status === "pending").map((row) => row.quantity),
          3,
        ),
        quantity: input.quantity,
        stage: "record",
      });
      if (!check.ok) throw this.deps.fail(409, "job-quantity-exceeded");
      this.state.outputs.push({
        id: randomUUID(),
        jobId: job.id,
        workDate: input.workDate,
        quantity: input.quantity,
        status: "pending",
        recordedBy: me,
        decidedBy: null,
        version: 1,
      });
      return this.jobReply(job, 201);
    }
    return { status: 404, body: { code: "not-found" }, schema: z.unknown() };
  }

  decideOutput(outputId: string, action: string, body: unknown): Reply | null {
    const row = this.state.outputs.find((entry) => entry.id === outputId);
    if (!row) return null;
    this.require(["timesheets.approve"]);
    const input = this.deps.parse(
      z.object({ version: z.number(), note: z.string().optional() }),
      body,
    );
    if (row.status !== "pending") throw this.deps.fail(409, "invalid-transition");
    this.checkVersion(row.version, input.version);
    if (row.recordedBy.id === this.deps.actor.id) throw this.deps.fail(409, "same-person");
    row.status = action === "approve" ? "approved" : "rejected";
    row.decidedBy = this.deps.actor;
    row.version += 1;
    const job = this.job(row.jobId);
    return { body: { output: this.output(row, job) }, schema: outputResponseSchema };
  }
}

/** Routes D6.3 part B requests; null when the path is not one of them. */
export function handleSubcontracts(
  deps: SubcontractsDeps,
  state: SubcontractsState,
  method: string,
  path: string,
  query: URLSearchParams,
  body: unknown,
): Reply | null {
  const api = new Subcontracts(deps, state);
  if (path === "/subcontracts" && method === "GET") return api.overview();
  const project = /^\/subcontracts\/projects\/([^/]+)(\/items)?$/.exec(path);
  if (project) {
    if (project[1] !== state.projectId) return null;
    if (project[2]) return method === "GET" ? api.items() : null;
    return method === "GET" ? api.projectList() : method === "POST" ? api.create(body) : null;
  }
  const advance = /^\/subcontracts\/advances\/([^/]+)\/(approve|reject|cancel|pay)$/.exec(path);
  if (advance && method === "POST") return api.decideAdvance(advance[1]!, advance[2]!, body);
  const sc = /^\/subcontracts\/([0-9a-f-]{36})(?:\/(.+))?$/.exec(path);
  if (sc) {
    const row = state.subcontracts.find((entry) => entry.id === sc[1]);
    if (!row) return null;
    const rest = sc[2]?.split("/") ?? [];
    if (!rest.length) return method === "GET" ? api.reply(row) : null;
    if (rest[0] === "lines")
      return rest.length === 1 && method === "POST"
        ? api.addLine(row, body)
        : rest.length === 2 && method === "DELETE"
          ? api.removeLine(row, rest[1]!, query)
          : null;
    if (rest[0] === "variations")
      return rest.length === 1
        ? api.vary(row, body)
        : api.decideVariation(row, rest[1]!, rest[2] === "approve" ? "approve" : "reject", body);
    if (rest[0] === "advances" && method === "POST") return api.requestAdvance(row, body);
    if (rest[0] === "certificates" && method === "POST") return api.createCertificate(row, body);
    if (method === "POST") return api.transition(row, rest[0]!, body);
    return null;
  }
  const certificate = /^\/subcontract-certificates\/([0-9a-f-]{36})(?:\/([a-z]+))?$/.exec(path);
  if (certificate) {
    const row = state.certificates.find((entry) => entry.id === certificate[1]);
    if (!row) return null;
    if (!certificate[2]) return method === "GET" ? api.certificateReply(row) : null;
    return api.certificateCommand(row, certificate[2], body, method);
  }
  const jobs =
    /^\/payroll\/projects\/([^/]+)\/(piece-rate-jobs|piece-rate-jobs\/options|piece-rate-reconciliation)$/.exec(
      path,
    );
  if (jobs && jobs[1] === state.projectId) {
    if (jobs[2] === "piece-rate-jobs")
      return method === "GET" ? api.jobs() : method === "POST" ? api.createJob(body) : null;
    if (jobs[2] === "piece-rate-jobs/options") return api.options();
    return api.reconciliation();
  }
  const job = /^\/payroll\/piece-rate-jobs\/([0-9a-f-]{36})(?:\/(.+))?$/.exec(path);
  if (job) {
    const row = state.jobs.find((entry) => entry.id === job[1]);
    if (!row) return null;
    const rest = job[2]?.split("/") ?? [];
    if (!rest.length) return method === "GET" ? api.readJob(row) : null;
    return method === "POST" ? api.jobCommand(row, rest[0]!, rest.slice(1), body) : null;
  }
  const output = /^\/payroll\/outputs\/([0-9a-f-]{36})\/(approve|reject)$/.exec(path);
  if (output && method === "POST") return api.decideOutput(output[1]!, output[2]!, body);
  return null;
}

/** The export endpoints' file for a known certificate or subcontract (a tiny synthetic file). */
export function subcontractExport(
  state: SubcontractsState,
  path: string,
): { type: string; name: string } | null {
  const certificate = /^\/subcontract-certificates\/([0-9a-f-]{36})\/export\/(pdf|xlsx)$/.exec(
    path,
  );
  if (certificate && state.certificates.some((row) => row.id === certificate[1]))
    return {
      type:
        certificate[2] === "pdf"
          ? "application/pdf"
          : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      name: `certificate.${certificate[2]}`,
    };
  const statement = /^\/subcontracts\/([0-9a-f-]{36})\/statement\/(pdf|xlsx)$/.exec(path);
  if (statement && state.subcontracts.some((row) => row.id === statement[1]))
    return {
      type:
        statement[2] === "pdf"
          ? "application/pdf"
          : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      name: `statement.${statement[2]}`,
    };
  return null;
}
