/**
 * D5.2 procure-to-pay in the Playwright mock API: requisitions, RFQs with quotations and the
 * comparison matrix, LPOs, Goods Received Notes (idempotent, geofenced), supplier invoices with
 * eTIMS, the three-way match, approval bound to the verified payee, settlements, the inbox and
 * commitments. Amounts, conversions, the geofence check and the match use the real
 * packages/domain functions; requests and responses go through the shared schemas (the server
 * rejects a response that breaks them). Permissions follow the API (P2pAccess): owner and
 * finance company-wide, the project manager and the site agent through their project assignment
 * (the agent needs procurement.requisition granted on Ruiru Heights first); maker-checker by
 * contributor lists. Synthetic data only.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  assessDeliveryLocation,
  checkProcurementTransition,
  comparableUnitPrice,
  convertQuantity,
  documentTotals,
  exactNetPrice,
  invoiceNumberKey,
  isVatable,
  lineNetAmountMinor,
  nairobiDate,
  netPricePerBase,
  perBaseMinor,
  Ratio,
  REQUISITION_TRANSITIONS,
  LPO_TRANSITIONS,
  settlementReferenceKey,
  STANDARD_UNITS,
  threeWayMatch,
  type Geofence,
  type ThreeWayMatchResult,
} from "@pm-buddy/domain";
import {
  P2P_LIMITS,
  SYSTEM_ROLE_PERMISSIONS,
  TENANT_PERMISSIONS,
  type EtimsNumberFormat,
  type GrnLocationState,
  type GrnPhotoKind,
  type InboxKind,
  type InvoiceSource,
  type InvoiceStatus,
  type LocationError,
  type LpoAction,
  type LpoStatus,
  type MatchStaleReason,
  type Permission,
  type ProcurementDocumentKind,
  type ProcurementDocumentType,
  type RequisitionAction,
  type RequisitionStatus,
  type SettlementMethod,
  type VatTreatment,
  type VehicleRegFormat,
} from "@pm-buddy/types";
import {
  approveInvoiceRequestSchema,
  awardRfqRequestSchema,
  commitmentsResponseSchema,
  createGrnRequestSchema,
  createInvoiceRequestSchema,
  createRequisitionRequestSchema,
  createRfqRequestSchema,
  grnResponseSchema,
  grnsResponseSchema,
  idempotencyKeySchema,
  inboxResponseSchema,
  invoiceDetailResponseSchema,
  invoicesResponseSchema,
  lpoDetailResponseSchema,
  lposResponseSchema,
  matchExceptionRequestSchema,
  procurementDocumentResponseSchema,
  reasonRequestSchema,
  receivableLposResponseSchema,
  recordQuotationRequestSchema,
  recordSettlementRequestSchema,
  requisitionDetailResponseSchema,
  requisitionsResponseSchema,
  rfqDetailResponseSchema,
  rfqExceptionRequestSchema,
  rfqsResponseSchema,
  updateInvoiceRequestSchema,
  updateLpoRequestSchema,
  updateRequisitionRequestSchema,
  versionRequestSchema,
  voidGrnRequestSchema,
  withdrawQuotationRequestSchema,
  type InboxItem,
  type PayoutVersion,
} from "@pm-buddy/validation";
import type { Person, Reply } from "./mock-bq-model.mts";
import { context as conversionContext, type ProcurementState } from "./mock-procurement.mts";

const VAT = "16";
const RUIRU_ID = "30000000-0000-4000-8000-000000000001";
export type P2pPersona = "owner" | "agent" | "pm" | "finance";
const ROLE = {
  owner: "owner",
  agent: "site_agent",
  pm: "project_manager",
  finance: "finance",
} as const;
export const P2P_PEOPLE: Record<P2pPersona, Person> = {
  owner: { id: "21000000-0000-4000-8000-000000000001", displayName: "Wanjiru Kamau" },
  pm: { id: "21000000-0000-4000-8000-000000000002", displayName: "Brian Otieno" },
  agent: { id: "21000000-0000-4000-8000-000000000003", displayName: "Kevin Kiprono" },
  finance: { id: "21000000-0000-4000-8000-000000000005", displayName: "Daniel Mwangi" },
};

type ProjectInfo = {
  id: string;
  code: string;
  name: string;
  status: string;
  sites: { id: string; name: string; geofence: Geofence | null; geofenceVersion: number | null }[];
};
type BqItemRef = { versionId: string; lineageId: string; ref: string | null; description: string };

export type P2pDeps = {
  fail: (status: number, code: string) => Error;
  parse<T>(schema: import("zod").ZodType<T>, body: unknown): T;
  persona: P2pPersona;
  requireStepUp(): void;
  projects: ProjectInfo[];
  catalogue: ProcurementState;
  /** The persona's project assignment (role ∩ assignment, as the API computes it). */
  projectPermissions(projectId: string): readonly Permission[];
  bqItem(projectId: string, lineageId: string): BqItemRef | null;
  idempotencyKey: string | undefined;
  contentType: string | undefined;
  raw: Buffer;
};

type MockReqLine = {
  id: string;
  lineNo: number;
  materialId: string;
  quantity: string;
  unit: string;
  baseQuantity: string;
  bqItem: BqItemRef | null;
  note: string | null;
};
type MockRequisition = {
  id: string;
  number: string;
  projectId: string;
  siteId: string | null;
  status: RequisitionStatus;
  neededBy: string;
  notes: string | null;
  version: number;
  createdAt: string;
  createdBy: Person;
  submittedAt: string | null;
  submittedBy: Person | null;
  decidedAt: string | null;
  decidedBy: Person | null;
  rejectionReason: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  contributors: Person[];
  lines: MockReqLine[];
};
type MockQuoteLine = {
  requisitionLineId: string;
  status: "quoted" | "no_bid";
  priceUnit: string | null;
  unitPriceMinor: number | null;
  vatTreatment: VatTreatment | null;
  netPerBase: Ratio | null;
  netAmountMinor: number | null;
};
type MockQuotation = {
  id: string;
  supplierId: string;
  reference: string | null;
  quotedOn: string;
  validUntil: string;
  deliveryDays: number;
  status: "received" | "withdrawn";
  withdrawnReason: string | null;
  recordedAt: string;
  recordedBy: Person;
  documentId: string | null;
  lines: MockQuoteLine[];
};
type MockRfq = {
  id: string;
  number: string;
  projectId: string;
  status: "open" | "awarded" | "cancelled";
  respondBy: string | null;
  notes: string | null;
  requisitionIds: string[];
  supplierIds: string[];
  exceptionReason: string | null;
  exceptionRequestedAt: string | null;
  exceptionRequestedBy: Person | null;
  exceptionApprovedAt: string | null;
  exceptionApprovedBy: Person | null;
  version: number;
  createdAt: string;
  createdBy: Person;
  cancelledAt: string | null;
  cancelReason: string | null;
  contributors: Person[];
  quotations: MockQuotation[];
};
type MockLpoLine = {
  id: string;
  lineNo: number;
  requisitionLineId: string;
  materialId: string;
  quantity: string;
  unit: string;
  baseQuantity: string;
  priceUnit: string;
  unitPriceMinor: number;
  vatTreatment: VatTreatment;
  netPerBase: Ratio;
  netAmountMinor: number;
  bqItem: BqItemRef | null;
};
type MockLpo = {
  id: string;
  number: string;
  projectId: string;
  rfqId: string;
  quotationId: string;
  supplier: {
    id: string;
    code: string;
    name: string;
    kraPinMasked: string | null;
    etimsStatus: "registered" | "unknown" | "not_registered";
  };
  replacesLpoId: string | null;
  deliverySiteId: string | null;
  deliveryDate: string | null;
  terms: string | null;
  creditDays: number;
  status: LpoStatus;
  version: number;
  createdAt: string;
  createdBy: Person;
  submittedAt: string | null;
  submittedBy: Person | null;
  approvedAt: string | null;
  approvedBy: Person | null;
  returnReason: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  contributors: Person[];
  lines: MockLpoLine[];
  subtotalMinor: number;
  vatMinor: number;
  totalMinor: number;
};
type MockGrnLine = {
  id: string;
  lineNo: number;
  lpoLineId: string;
  unit: string;
  receivedQuantity: string;
  rejectedQuantity: string;
  rejectionReason: string | null;
  acceptedBaseQuantity: string;
  overDelivery: boolean;
};
type MockGrn = {
  id: string;
  number: string;
  projectId: string;
  lpoId: string;
  siteId: string | null;
  status: "recorded" | "voided";
  capturedAt: string;
  receivedAt: string;
  receivedByName: string;
  recordedBy: Person;
  vehicle: { value: string; format: VehicleRegFormat };
  deliveryNoteNumber: string | null;
  location: {
    state: GrnLocationState;
    latitude: number | null;
    longitude: number | null;
    accuracyM: number | null;
    lowAccuracy: boolean;
    error: LocationError | null;
    geofenceVersion: number | null;
  };
  overDelivery: boolean;
  source: "web" | "site_app";
  notes: string | null;
  voidedAt: string | null;
  voidedBy: Person | null;
  voidReason: string | null;
  key: string;
  digest: string;
  lines: MockGrnLine[];
};
type MockInvoiceLine = {
  id: string;
  lineNo: number;
  lpoLineId: string;
  quantity: string;
  unit: string;
  baseQuantity: string;
  unitPriceMinor: number;
  vatTreatment: VatTreatment;
  netPerBase: Ratio;
  netAmountMinor: number;
};
type MockMatch = {
  id: string;
  result: ThreeWayMatchResult;
  contentVersion: number;
  grnIds: string[];
  priorIds: string[];
  qty: string;
  price: string;
  block: boolean;
  computedAt: string;
  computedBy: Person;
  exception: { reason: string; approvedAt: string; approvedBy: Person } | null;
};
type MockPayable = {
  id: string;
  contentVersion: number;
  matchId: string;
  payoutVersionId: string;
  authorisedMinor: number;
  approvedAt: string;
  approvedBy: Person;
  supersededAt: string | null;
};
type MockSettlement = {
  id: string;
  payableId: string;
  method: SettlementMethod;
  externalReference: string;
  amountMinor: number;
  paidOn: string;
  note: string | null;
  recordedAt: string;
  recordedBy: Person;
  key: string;
  digest: string;
};
type MockInvoice = {
  id: string;
  projectId: string;
  lpoId: string;
  supplierId: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  etims: { value: string; format: EtimsNumberFormat } | null;
  status: InvoiceStatus;
  /** Keyed by staff, or submitted by the supplier through the supplier portal (D7.2). */
  source: InvoiceSource;
  contentVersion: number;
  subtotalMinor: number;
  vatMinor: number;
  totalMinor: number;
  notes: string | null;
  version: number;
  createdAt: string;
  createdBy: Person;
  submittedAt: string | null;
  submittedBy: Person | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  contributors: Person[];
  lines: MockInvoiceLine[];
  matches: MockMatch[];
  payables: MockPayable[];
  settlements: MockSettlement[];
};
type MockDocument = {
  id: string;
  kind: ProcurementDocumentKind;
  contentType: ProcurementDocumentType;
  sizeBytes: number;
  uploadedAt: string;
  uploadedBy: Person;
  content: Buffer;
  owner: string;
};
export type P2pState = {
  requisitions: MockRequisition[];
  rfqs: MockRfq[];
  lpos: MockLpo[];
  grns: MockGrn[];
  invoices: MockInvoice[];
  documents: MockDocument[];
};

const now = () => new Date().toISOString();
const qty = (value: Ratio) => value.toDecimal(6).value;
const addDays = (date: string, days: number) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};
const contributes = (list: Person[], person: Person) =>
  list.some((entry) => entry.id === person.id) ? list : [...list, person];
const isContributor = (list: Person[], person: Person) =>
  list.some((entry) => entry.id === person.id);
const digestOf = (operation: string, body: unknown) =>
  createHash("sha256").update(JSON.stringify({ operation, body })).digest("hex");
const nextNumber = (prefix: string, count: number) =>
  `${prefix}-${String(count + 1).padStart(4, "0")}`;
const ACCRUED: InvoiceStatus[] = ["approved", "partly_settled", "settled"];
const VIEW: Permission[] = [
  "procurement.requisition",
  "procurement.approve",
  "stores.manage",
  "finance.view",
  "finance.manage",
  "payments.approve",
  "payments.disburse",
];
const RECEIVERS: Permission[] = ["stores.manage", "procurement.requisition"];
const RECORDERS: Permission[] = ["finance.manage", "procurement.manage_suppliers"];

export const emptyP2p = (): P2pState => ({
  requisitions: [],
  rfqs: [],
  lpos: [],
  grns: [],
  invoices: [],
  documents: [],
});

/** The procure-to-pay operations, as one persona, on one test's fixture data. */
class P2p {
  readonly actor: Person;
  readonly deps: P2pDeps;
  readonly state: P2pState;
  constructor(deps: P2pDeps, state: P2pState) {
    this.deps = deps;
    this.state = state;
    this.actor = P2P_PEOPLE[deps.persona];
  }

  fail(status: number, code: string): never {
    throw this.deps.fail(status, code);
  }

  // Access -----------------------------------------------------------------------------------

  company(): readonly Permission[] {
    return this.deps.persona === "owner"
      ? TENANT_PERMISSIONS
      : SYSTEM_ROLE_PERMISSIONS[ROLE[this.deps.persona]];
  }
  on(projectId: string): Set<Permission> {
    const role = this.company();
    // Owner and finance are company-wide; the others hold role ∩ their project assignment.
    const assigned = new Set(this.deps.projectPermissions(projectId));
    const scoped =
      this.deps.persona === "owner" || this.deps.persona === "finance"
        ? role
        : role.filter((key) => assigned.has(key));
    const held = new Set<Permission>(scoped);
    if (role.includes("procurement.manage_suppliers")) held.add("procurement.manage_suppliers");
    return held;
  }
  project(projectId: string): ProjectInfo {
    const found = this.deps.projects.find((entry) => entry.id === projectId);
    if (!found) this.fail(404, "not-found");
    return found;
  }
  viewer(projectId: string) {
    const held = this.on(projectId);
    if (!held.has("procurement.manage_suppliers") && !VIEW.some((key) => held.has(key)))
      this.fail(403, "forbidden");
    return held;
  }
  require(projectId: string, permissions: Permission[], writable = false) {
    const held = this.on(projectId);
    if (!permissions.some((key) => held.has(key))) this.fail(403, "forbidden");
    if (writable && ["closed", "cancelled"].includes(this.project(projectId).status))
      this.fail(409, "project-read-only");
    return held;
  }
  visible(): string[] {
    return this.deps.projects
      .map((entry) => entry.id)
      .filter((id) => {
        const held = this.on(id);
        return held.has("procurement.manage_suppliers") || VIEW.some((key) => held.has(key));
      });
  }
  manager() {
    if (!this.company().includes("procurement.manage_suppliers")) this.fail(403, "forbidden");
  }

  // Catalogue ---------------------------------------------------------------------------------

  material(id: string) {
    const found = this.deps.catalogue.materials.find((entry) => entry.id === id);
    if (!found) this.fail(404, "not-found");
    return found;
  }
  supplier(id: string) {
    const found = this.deps.catalogue.suppliers.find((entry) => entry.supplier.id === id);
    if (!found) this.fail(404, "not-found");
    return found;
  }
  supplierRef(id: string) {
    const { supplier } = this.supplier(id);
    return {
      id: supplier.id,
      code: supplier.code,
      name: supplier.tradingName ?? supplier.legalName,
    };
  }
  unitKnown(code: string) {
    if (
      !STANDARD_UNITS.some((unit) => unit.code === code) &&
      !this.deps.catalogue.units.some((unit) => unit.code === code && unit.status === "active")
    )
      this.fail(422, "unit-unknown");
  }
  toBase(
    materialId: string,
    supplierId: string | null,
    on: string,
    quantity: string,
    unit: string,
  ) {
    const material = this.material(materialId);
    this.unitKnown(unit);
    const result = convertQuantity(
      quantity,
      unit,
      material.baseUnit,
      conversionContext(this.deps.catalogue, material, supplierId, on),
    );
    if (!result.ok)
      this.fail(422, result.reason === "unknown-unit" ? "unit-unknown" : result.reason);
    return result.quantity;
  }
  perBase(
    materialId: string,
    supplierId: string,
    on: string,
    price: { unit: string; minor: number; vat: VatTreatment },
  ) {
    const material = this.material(materialId);
    this.unitKnown(price.unit);
    const comparable = comparableUnitPrice(
      exactNetPrice(price.minor, price.vat, VAT),
      price.unit,
      material.baseUnit,
      conversionContext(this.deps.catalogue, material, supplierId, on),
    );
    if (!comparable.ok) this.fail(422, "no-conversion");
    return netPricePerBase(price.minor, price.vat, VAT, comparable.ratio);
  }
  materialWire(id: string) {
    const material = this.material(id);
    return {
      id: material.id,
      code: material.code,
      name: material.name,
      baseUnit: material.baseUnit,
    };
  }
  verifiedPayee(supplierId: string): PayoutVersion | undefined {
    return this.supplier(supplierId).payouts.find((payout) => payout.status === "verified") as
      PayoutVersion | undefined;
  }
  payoutWire(payoutId: string, supplierId: string) {
    const payout = this.supplier(supplierId).payouts.find((entry) => entry.id === payoutId)!;
    return {
      id: payout.id,
      versionNo: payout.versionNo,
      status: payout.status,
      mpesaKind: payout.mpesaKind,
      paybillNumber: payout.paybillNumber,
      accountReference: payout.accountReference,
      tillNumber: payout.tillNumber,
      bank: payout.bank
        ? { bankName: payout.bank.bankName, accountNumberMasked: payout.bank.accountNumberMasked }
        : null,
    };
  }
  settings() {
    return this.deps.catalogue.settings;
  }

  projectRef(projectId: string) {
    const project = this.project(projectId);
    return { id: project.id, code: project.code, name: project.name };
  }
  siteRef(projectId: string, siteId: string | null) {
    if (!siteId) return null;
    const site = this.project(projectId).sites.find((entry) => entry.id === siteId);
    return site ? { id: site.id, name: site.name } : null;
  }
  assertSite(projectId: string, siteId: string | null) {
    if (siteId && !this.project(projectId).sites.some((site) => site.id === siteId))
      this.fail(400, "site-not-in-project");
  }

  // Requisitions ------------------------------------------------------------------------------

  requisition(id: string) {
    const found = this.state.requisitions.find((entry) => entry.id === id);
    if (!found) this.fail(404, "not-found");
    return found;
  }
  requisitionLines(
    projectId: string,
    lines: {
      materialId: string;
      quantity: string;
      unit: string;
      bqItemLineageId: string | null;
      note?: string | null;
    }[],
  ): MockReqLine[] {
    return lines.map((line, index) => {
      const material = this.material(line.materialId);
      if (material.status !== "active") this.fail(409, "material-archived");
      const baseQuantity = this.toBase(material.id, null, nairobiDate(), line.quantity, line.unit);
      if (!/[1-9]/.test(baseQuantity)) this.fail(422, "invalid-quantity");
      let bqItem: BqItemRef | null = null;
      if (line.bqItemLineageId) {
        bqItem = this.deps.bqItem(projectId, line.bqItemLineageId);
        if (!bqItem) this.fail(422, "bq-item-not-found");
      }
      return {
        id: randomUUID(),
        lineNo: index + 1,
        materialId: material.id,
        quantity: line.quantity,
        unit: line.unit,
        baseQuantity,
        bqItem,
        note: line.note ?? null,
      };
    });
  }
  liveRfqOf(requisitionId: string) {
    return this.state.rfqs.find(
      (rfq) => rfq.status !== "cancelled" && rfq.requisitionIds.includes(requisitionId),
    );
  }
  requisitionWire(row: MockRequisition) {
    const rfq = this.liveRfqOf(row.id);
    const lpo = rfq
      ? this.state.lpos.find((entry) => entry.rfqId === rfq.id && entry.status !== "cancelled")
      : undefined;
    return {
      id: row.id,
      number: row.number,
      project: this.projectRef(row.projectId),
      site: this.siteRef(row.projectId, row.siteId),
      status: row.status,
      neededBy: row.neededBy,
      notes: row.notes,
      lineCount: row.lines.length,
      version: row.version,
      createdAt: row.createdAt,
      createdBy: row.createdBy,
      submittedAt: row.submittedAt,
      submittedBy: row.submittedBy,
      decidedAt: row.decidedAt,
      decidedBy: row.decidedBy,
      rejectionReason: row.rejectionReason,
      cancelledAt: row.cancelledAt,
      cancelReason: row.cancelReason,
      rfq: rfq ? { id: rfq.id, number: rfq.number, status: rfq.status } : null,
      lpo: lpo ? { id: lpo.id, number: lpo.number, status: lpo.status } : null,
    };
  }
  requisitionDetail(row: MockRequisition): Reply {
    const held = this.on(row.projectId);
    const requester = held.has("procurement.requisition");
    const approver = held.has("procurement.approve");
    const summary = this.requisitionWire(row);
    return {
      body: {
        requisition: summary,
        lines: row.lines.map((line) => ({
          id: line.id,
          lineNo: line.lineNo,
          material: this.materialWire(line.materialId),
          quantity: line.quantity,
          unit: line.unit,
          baseQuantity: line.baseQuantity,
          bqItem: line.bqItem,
          note: line.note,
        })),
        contributors: row.contributors,
        permissions: {
          canEdit: requester && ["draft", "rejected", "submitted"].includes(row.status),
          canDecide:
            approver && row.status === "submitted" && !isContributor(row.contributors, this.actor),
          canCancel: (requester || approver) && ["draft", "submitted"].includes(row.status),
          canCreateRfq:
            held.has("procurement.manage_suppliers") &&
            row.status === "approved" &&
            summary.rfq === null,
        },
      },
      schema: requisitionDetailResponseSchema,
    };
  }
  createRequisition(body: unknown): MockRequisition {
    const input = this.deps.parse(createRequisitionRequestSchema, body);
    this.require(input.projectId, ["procurement.requisition"], true);
    this.assertSite(input.projectId, input.siteId);
    const row: MockRequisition = {
      id: randomUUID(),
      number: nextNumber("REQ", this.state.requisitions.length),
      projectId: input.projectId,
      siteId: input.siteId,
      status: "draft",
      neededBy: input.neededBy,
      notes: input.notes ?? null,
      version: 1,
      createdAt: now(),
      createdBy: this.actor,
      submittedAt: null,
      submittedBy: null,
      decidedAt: null,
      decidedBy: null,
      rejectionReason: null,
      cancelledAt: null,
      cancelReason: null,
      contributors: [this.actor],
      lines: this.requisitionLines(input.projectId, input.lines),
    };
    this.state.requisitions.push(row);
    return row;
  }
  updateRequisition(row: MockRequisition, body: unknown) {
    const input = this.deps.parse(updateRequisitionRequestSchema, body);
    this.require(row.projectId, ["procurement.requisition"], true);
    if (row.status !== "draft") this.fail(409, "invalid-transition");
    if (row.version !== input.version) this.fail(409, "version-conflict");
    if (input.siteId !== undefined) {
      this.assertSite(row.projectId, input.siteId);
      row.siteId = input.siteId;
    }
    if (input.lines) row.lines = this.requisitionLines(row.projectId, input.lines);
    if (input.neededBy) row.neededBy = input.neededBy;
    if (input.notes !== undefined) row.notes = input.notes;
    row.version += 1;
    row.contributors = contributes(row.contributors, this.actor);
  }
  transitionRequisition(row: MockRequisition, action: RequisitionAction, body: unknown) {
    const decides = action === "approve" || action === "reject";
    const withReason = action === "reject" || action === "cancel";
    const input = withReason
      ? this.deps.parse(reasonRequestSchema, body)
      : { ...this.deps.parse(versionRequestSchema, body), reason: undefined };
    const held = this.on(row.projectId);
    const allowed = decides
      ? held.has("procurement.approve")
      : held.has("procurement.requisition") ||
        (action === "cancel" && held.has("procurement.approve"));
    if (!allowed) this.fail(403, "forbidden");
    const check = checkProcurementTransition(
      REQUISITION_TRANSITIONS,
      row.status,
      action,
      input.reason,
    );
    if (!check.ok)
      this.fail(
        check.error === "reason_required" ? 400 : 409,
        check.error === "reason_required" ? "reason-required" : "invalid-transition",
      );
    if (row.version !== input.version) this.fail(409, "version-conflict");
    if (decides && isContributor(row.contributors, this.actor)) this.fail(403, "maker-checker");
    if (action === "reopen" && row.status === "approved" && this.liveRfqOf(row.id))
      this.fail(409, "requisition-on-rfq");
    const at = now();
    row.status = check.to;
    row.version += 1;
    if (action === "submit") Object.assign(row, { submittedAt: at, submittedBy: this.actor });
    if (decides)
      Object.assign(row, {
        decidedAt: at,
        decidedBy: this.actor,
        rejectionReason: action === "reject" ? input.reason!.trim() : null,
      });
    if (action === "reopen")
      Object.assign(row, {
        submittedAt: null,
        submittedBy: null,
        decidedAt: null,
        decidedBy: null,
        rejectionReason: null,
      });
    if (action === "cancel")
      Object.assign(row, { cancelledAt: at, cancelReason: input.reason!.trim() });
    if (row.status === "draft" || row.status === "submitted")
      row.contributors = contributes(row.contributors, this.actor);
  }

  // RFQs --------------------------------------------------------------------------------------

  rfq(id: string) {
    const found = this.state.rfqs.find((entry) => entry.id === id);
    if (!found) this.fail(404, "not-found");
    return found;
  }
  rfqLines(rfq: MockRfq) {
    return this.state.requisitions
      .filter((row) => rfq.requisitionIds.includes(row.id))
      .sort((left, right) => (left.number < right.number ? -1 : 1))
      .flatMap((row) => row.lines.map((line) => ({ requisition: row, line })));
  }
  expired(quote: MockQuotation) {
    return quote.validUntil < nairobiDate();
  }
  rfqWire(rfq: MockRfq) {
    const lpo = this.state.lpos.find(
      (entry) => entry.rfqId === rfq.id && entry.status !== "cancelled",
    );
    return {
      id: rfq.id,
      number: rfq.number,
      project: this.projectRef(rfq.projectId),
      status: rfq.status,
      respondBy: rfq.respondBy,
      notes: rfq.notes,
      requisitions: this.state.requisitions
        .filter((row) => rfq.requisitionIds.includes(row.id))
        .map((row) => ({ id: row.id, number: row.number }))
        .sort((left, right) => (left.number < right.number ? -1 : 1)),
      suppliers: rfq.supplierIds
        .map((id) => this.supplierRef(id))
        .sort((left, right) => (left.code < right.code ? -1 : 1)),
      quotationCount: rfq.quotations.filter((quote) => quote.status === "received").length,
      exception: {
        status: rfq.exceptionApprovedAt
          ? ("approved" as const)
          : rfq.exceptionRequestedAt
            ? ("requested" as const)
            : ("none" as const),
        reason: rfq.exceptionReason,
        requestedAt: rfq.exceptionRequestedAt,
        requestedBy: rfq.exceptionRequestedBy,
        approvedAt: rfq.exceptionApprovedAt,
        approvedBy: rfq.exceptionApprovedBy,
      },
      awardedQuotationId: lpo?.quotationId ?? null,
      lpo: lpo ? { id: lpo.id, number: lpo.number, status: lpo.status } : null,
      version: rfq.version,
      createdAt: rfq.createdAt,
      createdBy: rfq.createdBy,
      cancelledAt: rfq.cancelledAt,
      cancelReason: rfq.cancelReason,
    };
  }
  rfqDetail(rfq: MockRfq): Reply {
    const lines = this.rfqLines(rfq);
    const live = rfq.quotations.filter((quote) => quote.status === "received");
    const eligible = live.filter((quote) => this.complete(quote) && !this.expired(quote));
    const lowestTotal = eligible.reduce<number | null>(
      (min, quote) => (min === null || this.total(quote) < min ? this.total(quote) : min),
      null,
    );
    const minQuotes = this.settings().minQuotes;
    const held = this.on(rfq.projectId);
    return {
      body: {
        rfq: this.rfqWire(rfq),
        lines: lines.map(({ requisition, line }) => ({
          requisitionLineId: line.id,
          requisition: { id: requisition.id, number: requisition.number },
          material: this.materialWire(line.materialId),
          quantity: line.quantity,
          unit: line.unit,
          baseQuantity: line.baseQuantity,
        })),
        quotations: rfq.quotations.map((quote) => ({
          id: quote.id,
          supplier: this.supplierRef(quote.supplierId),
          reference: quote.reference,
          quotedOn: quote.quotedOn,
          validUntil: quote.validUntil,
          deliveryDays: quote.deliveryDays,
          status: quote.status,
          withdrawnReason: quote.withdrawnReason,
          complete: this.complete(quote),
          expired: this.expired(quote),
          netTotalMinor: this.total(quote),
          recordedAt: quote.recordedAt,
          recordedBy: quote.recordedBy,
          document: quote.documentId ? this.documentWire(quote.documentId) : null,
          lines: quote.lines.map((line) => ({
            requisitionLineId: line.requisitionLineId,
            status: line.status,
            priceUnit: line.priceUnit,
            unitPriceMinor: line.unitPriceMinor,
            vatTreatment: line.vatTreatment,
            netUnitPriceBaseMinor: line.netPerBase ? perBaseMinor(line.netPerBase) : null,
            netAmountMinor: line.netAmountMinor,
            priceId: null,
          })),
        })),
        comparison: {
          lines: lines.map(({ line }) => {
            const cells = live.map((quote) => {
              const cell = quote.lines.find((entry) => entry.requisitionLineId === line.id);
              return {
                quotationId: quote.id,
                price: cell?.netPerBase ?? null,
                netAmountMinor: cell?.netAmountMinor ?? null,
              };
            });
            const lowest = cells.reduce<Ratio | null>(
              (min, cell) =>
                cell.price && (!min || cell.price.compare(min) < 0) ? cell.price : min,
              null,
            );
            return {
              requisitionLineId: line.id,
              cells: cells.map((cell) => ({
                quotationId: cell.quotationId,
                netUnitPriceBaseMinor: cell.price ? perBaseMinor(cell.price) : null,
                netAmountMinor: cell.netAmountMinor,
                lowest: Boolean(lowest && cell.price && cell.price.equals(lowest)),
              })),
            };
          }),
          totals: live.map((quote) => ({
            quotationId: quote.id,
            netTotalMinor: this.total(quote),
            complete: this.complete(quote),
            lowest:
              this.complete(quote) && !this.expired(quote) && lowestTotal === this.total(quote),
          })),
        },
        award: {
          minQuotes,
          completeQuotes: eligible.length,
          basis:
            eligible.length >= minQuotes
              ? "enough-quotes"
              : rfq.exceptionApprovedAt
                ? "exception-approved"
                : "not-enough-quotes",
        },
        contributors: rfq.contributors,
        permissions: {
          canManage:
            this.company().includes("procurement.manage_suppliers") && rfq.status === "open",
          canApproveException:
            held.has("procurement.approve") &&
            rfq.status === "open" &&
            rfq.exceptionRequestedAt !== null &&
            rfq.exceptionApprovedAt === null &&
            !isContributor(rfq.contributors, this.actor),
        },
      },
      schema: rfqDetailResponseSchema,
    };
  }
  complete(quote: MockQuotation) {
    return quote.lines.every((line) => line.status === "quoted");
  }
  total(quote: MockQuotation) {
    return quote.lines.reduce((total, line) => total + (line.netAmountMinor ?? 0), 0);
  }
  touchRfq(rfq: MockRfq) {
    rfq.version += 1;
    if (rfq.status !== "cancelled") rfq.contributors = contributes(rfq.contributors, this.actor);
  }
  openRfq(rfq: MockRfq, version?: number) {
    if (rfq.status !== "open") this.fail(409, "rfq-not-open");
    if (version !== undefined && version !== rfq.version) this.fail(409, "version-conflict");
  }
  createRfq(body: unknown): MockRfq {
    this.manager();
    const input = this.deps.parse(createRfqRequestSchema, body);
    const rows = input.requisitionIds.map((id) => this.requisition(id));
    const projectId = rows[0]!.projectId;
    if (rows.some((row) => row.projectId !== projectId))
      this.fail(400, "requisitions-other-project");
    this.require(projectId, ["procurement.manage_suppliers"], true);
    for (const row of rows) {
      if (row.status !== "approved") this.fail(409, "requisition-not-approved");
      if (this.liveRfqOf(row.id)) this.fail(409, "requisition-on-rfq");
    }
    for (const id of input.supplierIds)
      if (this.supplier(id).supplier.status === "blocked") this.fail(409, "supplier-blocked");
    const rfq: MockRfq = {
      id: randomUUID(),
      number: nextNumber("RFQ", this.state.rfqs.length),
      projectId,
      status: "open",
      respondBy: input.respondBy,
      notes: input.notes ?? null,
      requisitionIds: rows.map((row) => row.id),
      supplierIds: [...new Set(input.supplierIds)],
      exceptionReason: null,
      exceptionRequestedAt: null,
      exceptionRequestedBy: null,
      exceptionApprovedAt: null,
      exceptionApprovedBy: null,
      version: 1,
      createdAt: now(),
      createdBy: this.actor,
      cancelledAt: null,
      cancelReason: null,
      contributors: [this.actor],
      quotations: [],
    };
    this.state.rfqs.push(rfq);
    return rfq;
  }
  recordQuotation(rfq: MockRfq, body: unknown) {
    this.manager();
    this.openRfq(rfq);
    const input = this.deps.parse(recordQuotationRequestSchema, body);
    this.require(rfq.projectId, ["procurement.manage_suppliers"], true);
    if (!rfq.supplierIds.includes(input.supplierId)) this.fail(409, "supplier-not-invited");
    if (
      rfq.quotations.some(
        (quote) => quote.supplierId === input.supplierId && quote.status === "received",
      )
    )
      this.fail(409, "quotation-exists");
    const lines = this.rfqLines(rfq);
    if (
      input.lines.length !== lines.length ||
      input.lines.some((line) => !lines.some((entry) => entry.line.id === line.requisitionLineId))
    )
      this.fail(400, "quotation-lines-mismatch");
    const quote: MockQuotation = {
      id: randomUUID(),
      supplierId: input.supplierId,
      reference: input.reference ?? null,
      quotedOn: input.quotedOn,
      validUntil: input.validUntil,
      deliveryDays: input.deliveryDays,
      status: "received",
      withdrawnReason: null,
      recordedAt: now(),
      recordedBy: this.actor,
      documentId: null,
      lines: lines.map(({ line }) => {
        const entry = input.lines.find((candidate) => candidate.requisitionLineId === line.id)!;
        if (entry.noBid)
          return {
            requisitionLineId: line.id,
            status: "no_bid" as const,
            priceUnit: null,
            unitPriceMinor: null,
            vatTreatment: null,
            netPerBase: null,
            netAmountMinor: null,
          };
        const netPerBase = this.perBase(line.materialId, input.supplierId, input.quotedOn, {
          unit: entry.priceUnit!,
          minor: entry.unitPriceMinor!,
          vat: entry.vatTreatment!,
        });
        return {
          requisitionLineId: line.id,
          status: "quoted" as const,
          priceUnit: entry.priceUnit,
          unitPriceMinor: entry.unitPriceMinor,
          vatTreatment: entry.vatTreatment,
          netPerBase,
          netAmountMinor: lineNetAmountMinor(line.baseQuantity, netPerBase),
        };
      }),
    };
    rfq.quotations.push(quote);
    this.touchRfq(rfq);
    return quote;
  }
  award(rfq: MockRfq, body: unknown): MockLpo {
    this.manager();
    const input = this.deps.parse(awardRfqRequestSchema, body);
    this.openRfq(rfq, input.version);
    this.require(rfq.projectId, ["procurement.manage_suppliers"], true);
    const quote = rfq.quotations.find((entry) => entry.id === input.quotationId);
    if (!quote) this.fail(404, "not-found");
    if (quote.status !== "received") this.fail(409, "quotation-not-received");
    if (!this.complete(quote)) this.fail(409, "quotation-incomplete");
    if (this.expired(quote)) this.fail(409, "quotation-expired");
    const { supplier } = this.supplier(quote.supplierId);
    if (supplier.status !== "active") this.fail(409, "supplier-not-active");
    const valid = rfq.quotations.filter(
      (entry) => entry.status === "received" && this.complete(entry) && !this.expired(entry),
    ).length;
    if (valid < this.settings().minQuotes && !rfq.exceptionApprovedAt)
      this.fail(409, "not-enough-quotes");
    this.assertSite(rfq.projectId, input.deliverySiteId);
    const lines: MockLpoLine[] = this.rfqLines(rfq).map(({ line }, index) => {
      const quoted = quote.lines.find((entry) => entry.requisitionLineId === line.id)!;
      return {
        id: randomUUID(),
        lineNo: index + 1,
        requisitionLineId: line.id,
        materialId: line.materialId,
        quantity: line.quantity,
        unit: line.unit,
        baseQuantity: line.baseQuantity,
        priceUnit: quoted.priceUnit!,
        unitPriceMinor: quoted.unitPriceMinor!,
        vatTreatment: quoted.vatTreatment!,
        netPerBase: quoted.netPerBase!,
        netAmountMinor: quoted.netAmountMinor!,
        bqItem: line.bqItem,
      };
    });
    const totals = documentTotals(
      lines.map((line) => ({
        netAmountMinor: line.netAmountMinor,
        vatable: isVatable(line.vatTreatment),
      })),
      VAT,
    );
    const replaced = [...this.state.lpos]
      .reverse()
      .find((entry) => entry.rfqId === rfq.id && entry.status === "cancelled");
    const lpo: MockLpo = {
      id: randomUUID(),
      number: nextNumber("LPO", this.state.lpos.length),
      projectId: rfq.projectId,
      rfqId: rfq.id,
      quotationId: quote.id,
      supplier: {
        id: supplier.id,
        code: supplier.code,
        name: supplier.tradingName ?? supplier.legalName,
        kraPinMasked: supplier.kraPinMasked,
        etimsStatus: supplier.etimsStatus,
      },
      replacesLpoId: replaced?.id ?? null,
      deliverySiteId: input.deliverySiteId,
      deliveryDate: input.deliveryDate,
      terms: input.terms ?? null,
      creditDays: supplier.creditDays,
      status: "draft",
      version: 1,
      createdAt: now(),
      createdBy: this.actor,
      submittedAt: null,
      submittedBy: null,
      approvedAt: null,
      approvedBy: null,
      returnReason: null,
      cancelledAt: null,
      cancelReason: null,
      contributors: [this.actor],
      lines,
      subtotalMinor: totals.subtotalMinor,
      vatMinor: totals.vatMinor,
      totalMinor: totals.totalMinor,
    };
    this.state.lpos.push(lpo);
    rfq.status = "awarded";
    this.touchRfq(rfq);
    return lpo;
  }

  // LPOs --------------------------------------------------------------------------------------

  lpo(id: string) {
    const found = this.state.lpos.find((entry) => entry.id === id);
    if (!found) this.fail(404, "not-found");
    return found;
  }
  recordedGrns(lpoId: string) {
    return this.state.grns.filter((grn) => grn.lpoId === lpoId && grn.status === "recorded");
  }
  received(lpoId: string) {
    const totals = new Map<string, Ratio>();
    for (const grn of this.recordedGrns(lpoId))
      for (const line of grn.lines)
        totals.set(
          line.lpoLineId,
          (totals.get(line.lpoLineId) ?? Ratio.of(0)).plus(
            Ratio.fromDecimal(line.acceptedBaseQuantity),
          ),
        );
    return totals;
  }
  billed(lpoId: string, except?: string) {
    const totals = new Map<string, Ratio>();
    for (const invoice of this.state.invoices)
      if (invoice.lpoId === lpoId && invoice.id !== except && ACCRUED.includes(invoice.status))
        for (const line of invoice.lines)
          totals.set(
            line.lpoLineId,
            (totals.get(line.lpoLineId) ?? Ratio.of(0)).plus(Ratio.fromDecimal(line.baseQuantity)),
          );
    return totals;
  }
  deliveryState(lpo: MockLpo) {
    const received = this.received(lpo.id);
    let any = false;
    let all = true;
    let over = false;
    for (const line of lpo.lines) {
      const got = received.get(line.id) ?? Ratio.of(0);
      if (!got.isZero()) any = true;
      const ordered = Ratio.fromDecimal(line.baseQuantity);
      if (got.compare(ordered) < 0) all = false;
      if (got.compare(ordered) > 0) over = true;
    }
    return over ? "over" : all && any ? "complete" : any ? "partial" : "none";
  }
  lpoWire(lpo: MockLpo) {
    const rfq = this.rfq(lpo.rfqId);
    const replaces = lpo.replacesLpoId ? this.lpo(lpo.replacesLpoId) : null;
    return {
      id: lpo.id,
      number: lpo.number,
      project: this.projectRef(lpo.projectId),
      deliverySite: this.siteRef(lpo.projectId, lpo.deliverySiteId),
      supplier: lpo.supplier,
      status: lpo.status,
      deliveryState: this.deliveryState(lpo),
      rfq: { id: rfq.id, number: rfq.number },
      quotationId: lpo.quotationId,
      replacesLpo: replaces ? { id: replaces.id, number: replaces.number } : null,
      deliveryDate: lpo.deliveryDate,
      terms: lpo.terms,
      creditDays: lpo.creditDays,
      vatRatePercent: VAT,
      subtotalMinor: lpo.subtotalMinor,
      vatMinor: lpo.vatMinor,
      totalMinor: lpo.totalMinor,
      version: lpo.version,
      createdAt: lpo.createdAt,
      createdBy: lpo.createdBy,
      submittedAt: lpo.submittedAt,
      submittedBy: lpo.submittedBy,
      approvedAt: lpo.approvedAt,
      approvedBy: lpo.approvedBy,
      returnReason: lpo.returnReason,
      cancelledAt: lpo.cancelledAt,
      cancelReason: lpo.cancelReason,
    };
  }
  lpoDetail(lpo: MockLpo): Reply {
    const received = this.received(lpo.id);
    const billed = this.billed(lpo.id);
    const held = this.on(lpo.projectId);
    const committed = lpo.status === "approved" ? lpo.subtotalMinor : 0;
    const accrued = this.state.invoices
      .filter((invoice) => invoice.lpoId === lpo.id && ACCRUED.includes(invoice.status))
      .reduce(
        (total, invoice) => total + invoice.lines.reduce((s, line) => s + line.netAmountMinor, 0),
        0,
      );
    return {
      body: {
        lpo: this.lpoWire(lpo),
        lines: lpo.lines.map((line) => ({
          id: line.id,
          lineNo: line.lineNo,
          requisitionLineId: line.requisitionLineId,
          material: this.materialWire(line.materialId),
          quantity: line.quantity,
          unit: line.unit,
          baseQuantity: line.baseQuantity,
          priceUnit: line.priceUnit,
          unitPriceMinor: line.unitPriceMinor,
          vatTreatment: line.vatTreatment,
          netUnitPriceBaseMinor: perBaseMinor(line.netPerBase),
          netAmountMinor: line.netAmountMinor,
          bqItem: line.bqItem,
          receivedBaseQuantity: qty(received.get(line.id) ?? Ratio.of(0)),
          invoicedBaseQuantity: qty(billed.get(line.id) ?? Ratio.of(0)),
        })),
        grns: this.state.grns
          .filter((grn) => grn.lpoId === lpo.id)
          .map((grn) => ({
            id: grn.id,
            number: grn.number,
            status: grn.status,
            receivedAt: grn.receivedAt,
            locationState: grn.location.state,
          })),
        invoices: this.state.invoices
          .filter((invoice) => invoice.lpoId === lpo.id)
          .map((invoice) => ({
            id: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            status: invoice.status,
            totalMinor: invoice.totalMinor,
          })),
        commitment: {
          committedMinor: committed,
          accruedMinor: accrued,
          openMinor: Math.max(0, committed - accrued),
        },
        contributors: lpo.contributors,
        acknowledgement: null,
        permissions: {
          canManage: held.has("procurement.manage_suppliers") && lpo.status !== "cancelled",
          canApprove:
            held.has("procurement.approve") &&
            lpo.status === "submitted" &&
            !isContributor(lpo.contributors, this.actor),
          canReceive: RECEIVERS.some((key) => held.has(key)) && lpo.status === "approved",
          canInvoice: RECORDERS.some((key) => held.has(key)) && lpo.status === "approved",
        },
      },
      schema: lpoDetailResponseSchema,
    };
  }
  setRequisitions(rfq: MockRfq, from: RequisitionStatus, to: RequisitionStatus) {
    for (const row of this.state.requisitions)
      if (rfq.requisitionIds.includes(row.id) && row.status === from) {
        row.status = to;
        row.version += 1;
      }
  }
  transitionLpo(lpo: MockLpo, action: LpoAction, body: unknown) {
    const withReason = action === "return" || action === "cancel";
    const input = withReason
      ? this.deps.parse(reasonRequestSchema, body)
      : { ...this.deps.parse(versionRequestSchema, body), reason: undefined };
    const deciding = action === "approve" || action === "return";
    const held = this.on(lpo.projectId);
    if (!held.has(deciding ? "procurement.approve" : "procurement.manage_suppliers"))
      this.fail(403, "forbidden");
    if (action === "approve") this.deps.requireStepUp();
    const check = checkProcurementTransition(LPO_TRANSITIONS, lpo.status, action, input.reason);
    if (!check.ok)
      this.fail(
        check.error === "reason_required" ? 400 : 409,
        check.error === "reason_required" ? "reason-required" : "invalid-transition",
      );
    if (lpo.version !== input.version) this.fail(409, "version-conflict");
    if (deciding && isContributor(lpo.contributors, this.actor)) this.fail(403, "maker-checker");
    if (
      action === "cancel" &&
      lpo.status === "approved" &&
      (this.recordedGrns(lpo.id).length ||
        this.state.invoices.some(
          (invoice) => invoice.lpoId === lpo.id && invoice.status !== "cancelled",
        ))
    )
      this.fail(409, "lpo-has-deliveries");
    const at = now();
    const from = lpo.status;
    lpo.status = check.to;
    lpo.version += 1;
    if (action === "submit") {
      Object.assign(lpo, { submittedAt: at, submittedBy: this.actor, returnReason: null });
      lpo.contributors = contributes(lpo.contributors, this.actor);
    }
    if (action === "approve") Object.assign(lpo, { approvedAt: at, approvedBy: this.actor });
    if (action === "return")
      Object.assign(lpo, { submittedAt: null, submittedBy: null, returnReason: input.reason });
    if (action === "cancel") Object.assign(lpo, { cancelledAt: at, cancelReason: input.reason });
    const rfq = this.rfq(lpo.rfqId);
    if (action === "approve") this.setRequisitions(rfq, "approved", "ordered");
    if (action === "cancel") {
      if (from === "approved") this.setRequisitions(rfq, "ordered", "approved");
      rfq.status = "open";
      rfq.version += 1;
    }
  }

  // GRNs --------------------------------------------------------------------------------------

  grn(id: string) {
    const found = this.state.grns.find((entry) => entry.id === id);
    if (!found) this.fail(404, "not-found");
    return found;
  }
  grnWire(grn: MockGrn) {
    const lpo = this.lpo(grn.lpoId);
    const photos = this.state.documents.filter((document) => document.owner === grn.id);
    return {
      id: grn.id,
      number: grn.number,
      project: this.projectRef(grn.projectId),
      site: this.siteRef(grn.projectId, grn.siteId),
      lpo: { id: lpo.id, number: lpo.number },
      supplier: { id: lpo.supplier.id, code: lpo.supplier.code, name: lpo.supplier.name },
      status: grn.status,
      capturedAt: grn.capturedAt,
      receivedAt: grn.receivedAt,
      receivedByName: grn.receivedByName,
      recordedBy: grn.recordedBy,
      vehicleRegistration: grn.vehicle.value,
      vehicleRegistrationFormat: grn.vehicle.format,
      deliveryNoteNumber: grn.deliveryNoteNumber,
      location: grn.location,
      overDelivery: grn.overDelivery,
      source: grn.source,
      notes: grn.notes,
      photos: photos.map((document) => this.documentWire(document.id)),
      evidenceComplete:
        photos.some((document) => document.kind === "delivery_note") &&
        photos.some((document) => document.kind === "goods"),
      voidedAt: grn.voidedAt,
      voidedBy: grn.voidedBy,
      voidReason: grn.voidReason,
      lines: grn.lines.map((line) => {
        const ordered = lpo.lines.find((entry) => entry.id === line.lpoLineId)!;
        return {
          id: line.id,
          lineNo: line.lineNo,
          lpoLineId: line.lpoLineId,
          material: this.materialWire(ordered.materialId),
          unit: line.unit,
          receivedQuantity: line.receivedQuantity,
          rejectedQuantity: line.rejectedQuantity,
          rejectionReason: line.rejectionReason,
          acceptedBaseQuantity: line.acceptedBaseQuantity,
          overDelivery: line.overDelivery,
        };
      }),
    };
  }
  grnResponse(grn: MockGrn, replayed: boolean, status = 200): Reply {
    const held = this.on(grn.projectId);
    const photos = this.state.documents.filter((document) => document.owner === grn.id).length;
    return {
      status,
      body: {
        grn: this.grnWire(grn),
        replayed,
        permissions: {
          canVoid: held.has("stores.manage") && grn.status === "recorded",
          canAddPhotos:
            RECEIVERS.some((key) => held.has(key)) && grn.status === "recorded" && photos < 10,
        },
      },
      schema: grnResponseSchema,
    };
  }
  createGrn(body: unknown): Reply {
    const key = idempotencyKeySchema.safeParse(this.deps.idempotencyKey);
    if (!key.success) this.fail(400, "idempotency-key-required");
    const input = this.deps.parse(createGrnRequestSchema, body);
    const lpo = this.lpo(input.lpoId);
    this.require(lpo.projectId, RECEIVERS, true);
    const digest = digestOf("grn.create", input);
    const replay = this.state.grns.find((grn) => grn.key === key.data);
    if (replay) {
      if (replay.digest !== digest || replay.id !== input.id)
        this.fail(409, "idempotency-key-reused");
      return this.grnResponse(replay, true, 201);
    }
    if (this.state.grns.some((grn) => grn.id === input.id)) this.fail(409, "grn-id-conflict");
    if (lpo.status !== "approved") this.fail(409, "lpo-not-approved");
    const siteId = input.siteId ?? lpo.deliverySiteId;
    this.assertSite(lpo.projectId, siteId);
    if (input.lines.some((line) => !lpo.lines.some((entry) => entry.id === line.lpoLineId)))
      this.fail(400, "line-not-on-order");
    const before = this.received(lpo.id);
    const capturedOn = nairobiDate(new Date(input.capturedAt));
    const lines: MockGrnLine[] = input.lines.map((line, index) => {
      const ordered = lpo.lines.find((entry) => entry.id === line.lpoLineId)!;
      const unit = line.unit ?? ordered.unit;
      const received = Ratio.fromDecimal(line.receivedQuantity);
      const rejected = Ratio.fromDecimal(line.rejectedQuantity);
      if (rejected.compare(received) > 0) this.fail(400, "invalid-quantity");
      const accepted = received.distance(rejected).value;
      const base = accepted.isZero()
        ? "0"
        : this.toBase(ordered.materialId, lpo.supplier.id, capturedOn, qty(accepted), unit);
      const total = (before.get(ordered.id) ?? Ratio.of(0)).plus(Ratio.fromDecimal(base));
      return {
        id: randomUUID(),
        lineNo: index + 1,
        lpoLineId: ordered.id,
        unit,
        receivedQuantity: line.receivedQuantity,
        rejectedQuantity: line.rejectedQuantity,
        rejectionReason: line.rejectionReason ?? null,
        acceptedBaseQuantity: base,
        overDelivery: total.compare(Ratio.fromDecimal(ordered.baseQuantity)) > 0,
      };
    });
    const site = siteId
      ? this.project(lpo.projectId).sites.find((entry) => entry.id === siteId)
      : null;
    const fix = input.location
      ? {
          lat: input.location.latitude,
          lng: input.location.longitude,
          accuracyM: input.location.accuracyM,
        }
      : null;
    const location = assessDeliveryLocation(fix, site?.geofence ?? null);
    const grn: MockGrn = {
      id: input.id,
      number: nextNumber("GRN", this.state.grns.length),
      projectId: lpo.projectId,
      lpoId: lpo.id,
      siteId,
      status: "recorded",
      capturedAt: input.capturedAt,
      receivedAt: now(),
      receivedByName: input.receivedByName,
      recordedBy: this.actor,
      vehicle: input.vehicleRegistration,
      deliveryNoteNumber: input.deliveryNoteNumber ?? null,
      location: {
        state: location.state,
        latitude: fix ? Number(fix.lat.toFixed(6)) : null,
        longitude: fix ? Number(fix.lng.toFixed(6)) : null,
        accuracyM: fix ? Number(fix.accuracyM.toFixed(1)) : null,
        lowAccuracy: location.lowAccuracy,
        error: fix ? null : input.locationError,
        geofenceVersion:
          location.state === "inside" || location.state === "outside"
            ? (site?.geofenceVersion ?? null)
            : null,
      },
      overDelivery: lines.some((line) => line.overDelivery),
      source: input.source,
      notes: input.notes ?? null,
      voidedAt: null,
      voidedBy: null,
      voidReason: null,
      key: key.data,
      digest,
      lines,
    };
    this.state.grns.push(grn);
    return this.grnResponse(grn, false, 201);
  }
  receivable(projectId: string | null): Reply {
    const lpos = this.state.lpos
      .filter((lpo) => lpo.status === "approved" && (!projectId || lpo.projectId === projectId))
      .filter((lpo) => RECEIVERS.some((key) => this.on(lpo.projectId).has(key)))
      .sort((left, right) => (left.number < right.number ? -1 : 1));
    return {
      body: {
        lpos: lpos.map((lpo) => {
          const received = this.received(lpo.id);
          const project = this.project(lpo.projectId);
          return {
            id: lpo.id,
            number: lpo.number,
            project: this.projectRef(lpo.projectId),
            deliverySite: this.siteRef(lpo.projectId, lpo.deliverySiteId),
            supplier: { id: lpo.supplier.id, code: lpo.supplier.code, name: lpo.supplier.name },
            deliveryDate: lpo.deliveryDate,
            sites: project.sites
              .map((site) => ({ id: site.id, name: site.name }))
              .sort((left, right) => (left.name < right.name ? -1 : 1)),
            lines: lpo.lines.map((line) => ({
              id: line.id,
              lineNo: line.lineNo,
              material: this.materialWire(line.materialId),
              quantity: line.quantity,
              unit: line.unit,
              baseQuantity: line.baseQuantity,
              receivedBaseQuantity: qty(received.get(line.id) ?? Ratio.of(0)),
            })),
          };
        }),
      },
      schema: receivableLposResponseSchema,
    };
  }

  // Invoices and the three-way match ----------------------------------------------------------

  invoice(id: string) {
    const found = this.state.invoices.find((entry) => entry.id === id);
    if (!found) this.fail(404, "not-found");
    return found;
  }
  priceInvoiceLines(
    lpo: MockLpo,
    invoiceDate: string,
    lines: {
      lpoLineId: string;
      quantity: string;
      unit: string | null;
      unitPriceMinor: number;
      vatTreatment: VatTreatment;
    }[],
  ): MockInvoiceLine[] {
    return lines.map((line, index) => {
      const ordered = lpo.lines.find((entry) => entry.id === line.lpoLineId);
      if (!ordered) this.fail(400, "line-not-on-order");
      const unit = line.unit ?? ordered.unit;
      const baseQuantity = this.toBase(
        ordered.materialId,
        lpo.supplier.id,
        invoiceDate,
        line.quantity,
        unit,
      );
      const netPerBase = this.perBase(ordered.materialId, lpo.supplier.id, invoiceDate, {
        unit,
        minor: line.unitPriceMinor,
        vat: line.vatTreatment,
      });
      return {
        id: randomUUID(),
        lineNo: index + 1,
        lpoLineId: ordered.id,
        quantity: line.quantity,
        unit,
        baseQuantity,
        unitPriceMinor: line.unitPriceMinor,
        vatTreatment: line.vatTreatment,
        netPerBase,
        netAmountMinor: lineNetAmountMinor(baseQuantity, netPerBase),
      };
    });
  }
  numberFree(supplierId: string, number: string, self: string | null) {
    const key = invoiceNumberKey(number);
    if (
      this.state.invoices.some(
        (invoice) =>
          invoice.supplierId === supplierId &&
          invoice.id !== self &&
          invoice.status !== "cancelled" &&
          invoiceNumberKey(invoice.invoiceNumber) === key,
      )
    )
      this.fail(409, "invoice-number-taken");
  }
  computed(invoice: MockInvoice) {
    return documentTotals(
      invoice.lines.map((line) => ({
        netAmountMinor: line.netAmountMinor,
        vatable: isVatable(line.vatTreatment),
      })),
      VAT,
    );
  }
  priorIds(invoice: MockInvoice) {
    return this.state.invoices
      .filter(
        (entry) =>
          entry.lpoId === invoice.lpoId &&
          entry.id !== invoice.id &&
          ACCRUED.includes(entry.status),
      )
      .map((entry) => entry.id);
  }
  evaluate(invoice: MockInvoice) {
    const lpo = this.lpo(invoice.lpoId);
    const settings = this.settings();
    const priorIds = this.priorIds(invoice);
    const prior = this.state.invoices.filter((entry) => priorIds.includes(entry.id));
    const result = threeWayMatch({
      quantityTolerancePercent: settings.qtyTolerancePercent,
      priceTolerancePercent: settings.priceTolerancePercent,
      blockWithoutEtims: settings.blockPaymentWithoutEtims,
      etims: { number: invoice.etims?.value ?? null, format: invoice.etims?.format ?? null },
      vatRatePercent: VAT,
      order: {
        lines: lpo.lines.map((line) => ({
          lpoLineId: line.id,
          lineNo: line.lineNo,
          orderedBaseQuantity: line.baseQuantity,
          netPerBase: line.netPerBase,
        })),
        subtotalMinor: lpo.subtotalMinor,
      },
      received: new Map([...this.received(lpo.id)].map(([id, value]) => [id, qty(value)])),
      previouslyInvoiced: new Map(
        [...this.billed(lpo.id, invoice.id)].map(([id, value]) => [id, qty(value)]),
      ),
      previouslyInvoicedSubtotalMinor: prior.reduce(
        (total, entry) => total + this.computed(entry).subtotalMinor,
        0,
      ),
      invoice: {
        lines: invoice.lines.map((line) => ({
          lpoLineId: line.lpoLineId,
          baseQuantity: line.baseQuantity,
          netPerBase: line.netPerBase,
          netAmountMinor: line.netAmountMinor,
          vatable: isVatable(line.vatTreatment),
        })),
        subtotalMinor: invoice.subtotalMinor,
        vatMinor: invoice.vatMinor,
        totalMinor: invoice.totalMinor,
      },
    });
    return { result, priorIds, grnIds: this.recordedGrns(lpo.id).map((grn) => grn.id) };
  }
  matchAndMove(invoice: MockInvoice) {
    const { result, priorIds, grnIds } = this.evaluate(invoice);
    const settings = this.settings();
    invoice.matches.push({
      id: randomUUID(),
      result,
      contentVersion: invoice.contentVersion,
      grnIds,
      priorIds,
      qty: settings.qtyTolerancePercent,
      price: settings.priceTolerancePercent,
      block: settings.blockPaymentWithoutEtims,
      computedAt: now(),
      computedBy: this.actor,
      exception: null,
    });
    invoice.status = result.outcome === "matched" ? "matched" : "disputed";
    invoice.version += 1;
  }
  staleReasons(invoice: MockInvoice, match: MockMatch): MatchStaleReason[] {
    const same = (left: string[], right: string[]) =>
      left.length === right.length && [...left].sort().join() === [...right].sort().join();
    const settings = this.settings();
    const reasons: MatchStaleReason[] = [];
    if (match.contentVersion !== invoice.contentVersion) reasons.push("invoice-changed");
    if (
      !same(
        match.grnIds,
        this.recordedGrns(invoice.lpoId).map((grn) => grn.id),
      )
    )
      reasons.push("grns-changed");
    if (!same(match.priorIds, this.priorIds(invoice))) reasons.push("invoices-changed");
    if (
      !Ratio.fromDecimal(match.qty).equals(Ratio.fromDecimal(settings.qtyTolerancePercent)) ||
      !Ratio.fromDecimal(match.price).equals(Ratio.fromDecimal(settings.priceTolerancePercent)) ||
      match.block !== settings.blockPaymentWithoutEtims
    )
      reasons.push("settings-changed");
    return reasons;
  }
  settled(invoice: MockInvoice) {
    return invoice.settlements.reduce((total, entry) => total + entry.amountMinor, 0);
  }
  activePayable(invoice: MockInvoice) {
    return invoice.payables.find((payable) => !payable.supersededAt) ?? null;
  }
  payeeStatus(invoice: MockInvoice, payable: MockPayable) {
    return this.supplier(invoice.supplierId).payouts.find(
      (entry) => entry.id === payable.payoutVersionId,
    )?.status;
  }
  invoiceWire(invoice: MockInvoice) {
    const { supplier } = this.supplier(invoice.supplierId);
    const lpo = this.lpo(invoice.lpoId);
    const computed = this.computed(invoice);
    const settled = this.settled(invoice);
    return {
      id: invoice.id,
      project: this.projectRef(invoice.projectId),
      lpo: { id: lpo.id, number: lpo.number },
      supplier: { ...this.supplierRef(invoice.supplierId), etimsStatus: supplier.etimsStatus },
      invoiceNumber: invoice.invoiceNumber,
      invoiceDate: invoice.invoiceDate,
      dueDate: invoice.dueDate,
      etimsInvoiceNumber: invoice.etims?.value ?? null,
      etimsFormat: invoice.etims?.format ?? null,
      status: invoice.status,
      source: invoice.source,
      contentVersion: invoice.contentVersion,
      vatRatePercent: VAT,
      subtotalMinor: invoice.subtotalMinor,
      vatMinor: invoice.vatMinor,
      totalMinor: invoice.totalMinor,
      computedSubtotalMinor: computed.subtotalMinor,
      computedVatMinor: computed.vatMinor,
      settledMinor: settled,
      outstandingMinor: ACCRUED.includes(invoice.status) ? invoice.totalMinor - settled : 0,
      notes: invoice.notes,
      version: invoice.version,
      createdAt: invoice.createdAt,
      createdBy: invoice.createdBy,
      submittedAt: invoice.submittedAt,
      submittedBy: invoice.submittedBy,
      cancelledAt: invoice.cancelledAt,
      cancelReason: invoice.cancelReason,
    };
  }
  invoiceDetail(invoice: MockInvoice, status = 200): Reply {
    const lpo = this.lpo(invoice.lpoId);
    const match = invoice.matches.at(-1) ?? null;
    const stale = match ? this.staleReasons(invoice, match) : [];
    const held = this.on(invoice.projectId);
    const contributor = isContributor(invoice.contributors, this.actor);
    const payableWire = (payable: MockPayable) => {
      const settledOn = invoice.settlements
        .filter((entry) => entry.payableId === payable.id)
        .reduce((total, entry) => total + entry.amountMinor, 0);
      return {
        id: payable.id,
        status: payable.supersededAt ? ("superseded" as const) : ("active" as const),
        current: !payable.supersededAt && this.payeeStatus(invoice, payable) === "verified",
        authorisedMinor: payable.authorisedMinor,
        settledMinor: settledOn,
        outstandingMinor: Math.max(0, payable.authorisedMinor - settledOn),
        invoiceContentVersion: payable.contentVersion,
        matchId: payable.matchId,
        payout: this.payoutWire(payable.payoutVersionId, invoice.supplierId),
        approvedAt: payable.approvedAt,
        approvedBy: payable.approvedBy,
      };
    };
    const active = this.activePayable(invoice);
    const activeWire = active ? payableWire(active) : null;
    const payee = this.verifiedPayee(invoice.supplierId);
    const needsApproval =
      invoice.status === "matched" ||
      (["approved", "partly_settled"].includes(invoice.status) && !activeWire?.current);
    return {
      status,
      body: {
        invoice: this.invoiceWire(invoice),
        lines: invoice.lines.map((line) => ({
          id: line.id,
          lineNo: line.lineNo,
          lpoLineId: line.lpoLineId,
          material: this.materialWire(
            lpo.lines.find((entry) => entry.id === line.lpoLineId)!.materialId,
          ),
          quantity: line.quantity,
          unit: line.unit,
          baseQuantity: line.baseQuantity,
          unitPriceMinor: line.unitPriceMinor,
          vatTreatment: line.vatTreatment,
          netUnitPriceBaseMinor: perBaseMinor(line.netPerBase),
          netAmountMinor: line.netAmountMinor,
        })),
        match: match
          ? {
              id: match.id,
              outcome: match.result.outcome,
              passing: match.result.outcome === "matched" || match.exception !== null,
              current: stale.length === 0,
              staleReasons: stale,
              reasons: match.result.reasons,
              headerReasons: match.result.headerReasons,
              warnings: match.result.warnings,
              exceptable: match.result.exceptable && match.exception === null,
              lines: match.result.lines.map((line) => {
                const ordered = lpo.lines.find((entry) => entry.id === line.lpoLineId);
                return {
                  ...line,
                  material: ordered ? this.materialWire(ordered.materialId) : null,
                };
              }),
              totals: match.result.totals,
              tolerances: {
                qtyPercent: match.qty,
                pricePercent: match.price,
                blockWithoutEtims: match.block,
              },
              invoiceContentVersion: match.contentVersion,
              grnCount: match.grnIds.length,
              computedAt: match.computedAt,
              computedBy: match.computedBy,
              exception: match.exception,
            }
          : null,
        payable: activeWire,
        payables: [...invoice.payables].reverse().map(payableWire),
        settlements: invoice.settlements.map((entry) => ({
          id: entry.id,
          payableId: entry.payableId,
          method: entry.method,
          externalReference: entry.externalReference,
          amountMinor: entry.amountMinor,
          paidOn: entry.paidOn,
          note: entry.note,
          recordedAt: entry.recordedAt,
          recordedBy: entry.recordedBy,
        })),
        payee: payee ? this.payoutWire(payee.id, invoice.supplierId) : null,
        documents: this.state.documents
          .filter((document) => document.owner === invoice.id)
          .reverse()
          .map((document) => this.documentWire(document.id)),
        contributors: invoice.contributors,
        permissions: {
          canEdit: RECORDERS.some((key) => held.has(key)) && invoice.status === "draft",
          canRematch:
            (RECORDERS.some((key) => held.has(key)) || held.has("payments.approve")) &&
            ["submitted", "disputed", "matched"].includes(invoice.status),
          canReopen:
            RECORDERS.some((key) => held.has(key)) &&
            invoice.source === "company" &&
            ["disputed", "matched"].includes(invoice.status),
          canCancel:
            RECORDERS.some((key) => held.has(key)) &&
            ["draft", "submitted", "disputed", "matched"].includes(invoice.status),
          canAttach: RECORDERS.some((key) => held.has(key)) && invoice.status !== "cancelled",
          canApprove: held.has("payments.approve") && needsApproval && !contributor,
          canApproveException:
            held.has("payments.approve") &&
            invoice.status === "disputed" &&
            !contributor &&
            Boolean(match?.result.exceptable && !match.exception),
          canSettle:
            held.has("payments.disburse") &&
            ["approved", "partly_settled"].includes(invoice.status) &&
            Boolean(activeWire?.current) &&
            active?.approvedBy.id !== this.actor.id,
        },
      },
      schema: invoiceDetailResponseSchema,
    };
  }
  createInvoice(body: unknown): MockInvoice {
    const input = this.deps.parse(createInvoiceRequestSchema, body);
    const lpo = this.lpo(input.lpoId);
    this.require(lpo.projectId, RECORDERS);
    if (lpo.status !== "approved") this.fail(409, "lpo-not-approved");
    this.numberFree(lpo.supplier.id, input.invoiceNumber, null);
    const invoice: MockInvoice = {
      id: randomUUID(),
      projectId: lpo.projectId,
      lpoId: lpo.id,
      supplierId: lpo.supplier.id,
      invoiceNumber: input.invoiceNumber,
      invoiceDate: input.invoiceDate,
      dueDate: addDays(input.invoiceDate, lpo.creditDays),
      etims: input.etimsInvoiceNumber,
      status: "draft",
      source: "company",
      contentVersion: 1,
      subtotalMinor: input.subtotalMinor,
      vatMinor: input.vatMinor,
      totalMinor: input.totalMinor,
      notes: input.notes ?? null,
      version: 1,
      createdAt: now(),
      createdBy: this.actor,
      submittedAt: null,
      submittedBy: null,
      cancelledAt: null,
      cancelReason: null,
      contributors: [this.actor],
      lines: this.priceInvoiceLines(lpo, input.invoiceDate, input.lines),
      matches: [],
      payables: [],
      settlements: [],
    };
    this.state.invoices.push(invoice);
    return invoice;
  }
  updateInvoice(invoice: MockInvoice, body: unknown) {
    const input = this.deps.parse(updateInvoiceRequestSchema, body);
    this.require(invoice.projectId, RECORDERS);
    if (invoice.status !== "draft") this.fail(409, "invalid-transition");
    if (invoice.version !== input.version) this.fail(409, "version-conflict");
    const lpo = this.lpo(invoice.lpoId);
    if (input.invoiceNumber) this.numberFree(invoice.supplierId, input.invoiceNumber, invoice.id);
    const subtotal = input.subtotalMinor ?? invoice.subtotalMinor;
    const vat = input.vatMinor ?? invoice.vatMinor;
    const total = input.totalMinor ?? invoice.totalMinor;
    if (subtotal + vat !== total) this.fail(400, "invoice-total-arithmetic");
    const date = input.invoiceDate ?? invoice.invoiceDate;
    if (input.lines) invoice.lines = this.priceInvoiceLines(lpo, date, input.lines);
    if (input.invoiceNumber) invoice.invoiceNumber = input.invoiceNumber;
    if (input.invoiceDate) {
      invoice.invoiceDate = input.invoiceDate;
      invoice.dueDate = addDays(input.invoiceDate, lpo.creditDays);
    }
    if (input.etimsInvoiceNumber !== undefined) invoice.etims = input.etimsInvoiceNumber;
    if (input.notes !== undefined) invoice.notes = input.notes;
    Object.assign(invoice, { subtotalMinor: subtotal, vatMinor: vat, totalMinor: total });
    invoice.contentVersion += 1;
    invoice.version += 1;
    invoice.contributors = contributes(invoice.contributors, this.actor);
  }
  invoiceCommand(invoice: MockInvoice, action: string, body: unknown): Reply {
    if (action === "submit") {
      const input = this.deps.parse(versionRequestSchema, body);
      this.require(invoice.projectId, RECORDERS);
      if (invoice.status !== "draft") this.fail(409, "invalid-transition");
      if (invoice.version !== input.version) this.fail(409, "version-conflict");
      Object.assign(invoice, { status: "submitted", submittedAt: now(), submittedBy: this.actor });
      invoice.version += 1;
      invoice.contributors = contributes(invoice.contributors, this.actor);
      this.matchAndMove(invoice);
      return this.invoiceDetail(invoice);
    }
    if (action === "rematch") {
      const input = this.deps.parse(versionRequestSchema, body);
      this.require(invoice.projectId, [...RECORDERS, "payments.approve"]);
      if (!["submitted", "disputed", "matched"].includes(invoice.status))
        this.fail(409, "invalid-transition");
      if (invoice.version !== input.version) this.fail(409, "version-conflict");
      this.matchAndMove(invoice);
      return this.invoiceDetail(invoice);
    }
    if (action === "reopen") {
      const input = this.deps.parse(versionRequestSchema, body);
      this.require(invoice.projectId, RECORDERS);
      if (!["disputed", "matched"].includes(invoice.status)) this.fail(409, "invalid-transition");
      if (invoice.version !== input.version) this.fail(409, "version-conflict");
      Object.assign(invoice, { status: "draft", submittedAt: null, submittedBy: null });
      invoice.version += 1;
      invoice.contributors = contributes(invoice.contributors, this.actor);
      return this.invoiceDetail(invoice);
    }
    if (action === "cancel") {
      const input = this.deps.parse(reasonRequestSchema, body);
      this.require(invoice.projectId, RECORDERS);
      if (!["draft", "submitted", "disputed", "matched"].includes(invoice.status))
        this.fail(409, "invalid-transition");
      if (invoice.version !== input.version) this.fail(409, "version-conflict");
      Object.assign(invoice, {
        status: "cancelled",
        cancelledAt: now(),
        cancelReason: input.reason,
      });
      invoice.version += 1;
      return this.invoiceDetail(invoice);
    }
    if (action === "exception") {
      const input = this.deps.parse(matchExceptionRequestSchema, body);
      this.require(invoice.projectId, ["payments.approve"]);
      this.deps.requireStepUp();
      if (invoice.status !== "disputed") this.fail(409, "invalid-transition");
      if (invoice.version !== input.version) this.fail(409, "version-conflict");
      if (isContributor(invoice.contributors, this.actor)) this.fail(403, "maker-checker");
      const match = invoice.matches.at(-1);
      if (!match || match.id !== input.matchId) this.fail(409, "match-stale");
      if (this.staleReasons(invoice, match).length) this.fail(409, "match-stale");
      if (match.result.outcome !== "mismatch" || !match.result.exceptable)
        this.fail(409, "match-not-exceptable");
      match.exception = { reason: input.reason, approvedAt: now(), approvedBy: this.actor };
      invoice.status = "matched";
      invoice.version += 1;
      return this.invoiceDetail(invoice);
    }
    if (action === "approve") {
      const input = this.deps.parse(approveInvoiceRequestSchema, body);
      this.require(invoice.projectId, ["payments.approve"]);
      this.deps.requireStepUp();
      if (invoice.version !== input.version) this.fail(409, "version-conflict");
      if (isContributor(invoice.contributors, this.actor)) this.fail(403, "maker-checker");
      const previous = this.activePayable(invoice);
      const reapproval = invoice.status === "approved" || invoice.status === "partly_settled";
      if (!reapproval && invoice.status !== "matched") this.fail(409, "invalid-transition");
      if (reapproval) {
        if (previous && this.payeeStatus(invoice, previous) === "verified")
          this.fail(409, "approval-current");
        const latest = invoice.payables.at(-1);
        if (!latest || latest.matchId !== input.matchId) this.fail(409, "match-stale");
      } else {
        const match = invoice.matches.at(-1);
        if (!match || match.id !== input.matchId) this.fail(409, "match-stale");
        if (this.staleReasons(invoice, match).length) this.fail(409, "match-stale");
        if (match.result.outcome !== "matched" && !match.exception)
          this.fail(409, "match-not-passing");
      }
      const payee = this.verifiedPayee(invoice.supplierId);
      if (!payee) this.fail(409, "payee-not-verified");
      if (payee.id !== input.payoutVersionId) this.fail(409, "payee-changed");
      if (previous) previous.supersededAt = now();
      invoice.payables.push({
        id: randomUUID(),
        contentVersion: invoice.contentVersion,
        matchId: input.matchId,
        payoutVersionId: payee.id,
        authorisedMinor: invoice.totalMinor - this.settled(invoice),
        approvedAt: now(),
        approvedBy: this.actor,
        supersededAt: null,
      });
      if (!reapproval) invoice.status = "approved";
      invoice.version += 1;
      return this.invoiceDetail(invoice);
    }
    if (action === "settlements") {
      const key = idempotencyKeySchema.safeParse(this.deps.idempotencyKey);
      if (!key.success) this.fail(400, "idempotency-key-required");
      const input = this.deps.parse(recordSettlementRequestSchema, body);
      this.require(invoice.projectId, ["payments.disburse"]);
      this.deps.requireStepUp();
      const digest = digestOf(`invoice.settle:${invoice.id}`, input);
      const replay = invoice.settlements.find((entry) => entry.key === key.data);
      if (replay) {
        if (replay.digest !== digest) this.fail(409, "idempotency-key-reused");
        return this.invoiceDetail(invoice, 201);
      }
      if (!["approved", "partly_settled"].includes(invoice.status))
        this.fail(409, "invoice-not-payable");
      const payable = this.activePayable(invoice);
      if (!payable || this.payeeStatus(invoice, payable) !== "verified")
        this.fail(409, "payee-changed");
      if (payable.approvedBy.id === this.actor.id) this.fail(403, "maker-checker");
      const outstanding = invoice.totalMinor - this.settled(invoice);
      if (input.amountMinor > outstanding) this.fail(409, "settlement-exceeds-outstanding");
      if (input.paidOn > nairobiDate() || input.paidOn < invoice.invoiceDate)
        this.fail(400, "settlement-date-invalid");
      const referenceKey = settlementReferenceKey(input.externalReference);
      if (
        this.state.invoices.some((entry) =>
          entry.settlements.some(
            (settlement) =>
              settlement.method === input.method &&
              settlementReferenceKey(settlement.externalReference) === referenceKey,
          ),
        )
      )
        this.fail(409, "settlement-reference-taken");
      invoice.settlements.push({
        id: randomUUID(),
        payableId: payable.id,
        method: input.method,
        externalReference: input.externalReference,
        amountMinor: input.amountMinor,
        paidOn: input.paidOn,
        note: input.note ?? null,
        recordedAt: now(),
        recordedBy: this.actor,
        key: key.data,
        digest,
      });
      invoice.status = input.amountMinor === outstanding ? "settled" : "partly_settled";
      invoice.version += 1;
      return this.invoiceDetail(invoice, 201);
    }
    return this.fail(404, "not-found");
  }

  // Documents ---------------------------------------------------------------------------------

  documentWire(id: string) {
    const document = this.state.documents.find((entry) => entry.id === id)!;
    return {
      id: document.id,
      kind: document.kind,
      contentType: document.contentType,
      sizeBytes: document.sizeBytes,
      scanStatus: "not_scanned" as const,
      uploadedAt: document.uploadedAt,
      uploadedBy: document.uploadedBy,
    };
  }
  upload(kind: ProcurementDocumentKind, owner: string): MockDocument {
    const file = multipartFile(this.deps.raw, this.deps.contentType);
    if (!file) this.fail(400, "file-required");
    const contentType = sniff(file);
    const image = kind === "delivery_note" || kind === "goods";
    if (!contentType || (image && contentType === "application/pdf"))
      this.fail(415, "unsupported-file-type");
    if (file.length > (image ? P2P_LIMITS.imageMaxBytes : P2P_LIMITS.documentMaxBytes))
      this.fail(413, "payload-too-large");
    const document: MockDocument = {
      id: randomUUID(),
      kind,
      contentType,
      sizeBytes: file.length,
      uploadedAt: now(),
      uploadedBy: this.actor,
      content: file,
      owner,
    };
    this.state.documents.push(document);
    return document;
  }

  // Inbox and commitments ---------------------------------------------------------------------

  inbox(): Reply {
    const items: InboxItem[] = [];
    const visible = new Set(this.visible());
    const push = (
      kind: InboxKind,
      projectId: string,
      id: string,
      label: string,
      since: string,
      href: string,
      amountMinor: number | null = null,
      supplierId: string | null = null,
    ) =>
      items.push({
        kind,
        id,
        label,
        project: this.projectRef(projectId),
        supplier: supplierId ? this.supplierRef(supplierId) : null,
        amountMinor,
        since,
        href,
      });
    for (const row of this.state.requisitions)
      if (
        visible.has(row.projectId) &&
        row.status === "submitted" &&
        this.on(row.projectId).has("procurement.approve") &&
        !isContributor(row.contributors, this.actor)
      )
        push(
          "requisition-approval",
          row.projectId,
          row.id,
          row.number,
          row.submittedAt!,
          `/procurement/requisitions/${row.id}`,
        );
    for (const rfq of this.state.rfqs)
      if (
        visible.has(rfq.projectId) &&
        rfq.status === "open" &&
        rfq.exceptionRequestedAt &&
        !rfq.exceptionApprovedAt &&
        this.on(rfq.projectId).has("procurement.approve") &&
        !isContributor(rfq.contributors, this.actor)
      )
        push(
          "rfq-exception",
          rfq.projectId,
          rfq.id,
          rfq.number,
          rfq.exceptionRequestedAt,
          `/procurement/rfqs/${rfq.id}`,
        );
    for (const lpo of this.state.lpos)
      if (
        visible.has(lpo.projectId) &&
        lpo.status === "submitted" &&
        this.on(lpo.projectId).has("procurement.approve") &&
        !isContributor(lpo.contributors, this.actor)
      )
        push(
          "lpo-approval",
          lpo.projectId,
          lpo.id,
          lpo.number,
          lpo.submittedAt!,
          `/procurement/lpos/${lpo.id}`,
          lpo.totalMinor,
          lpo.supplier.id,
        );
    for (const invoice of this.state.invoices) {
      if (!visible.has(invoice.projectId)) continue;
      const href = `/procurement/invoices/${invoice.id}`;
      const approver =
        this.on(invoice.projectId).has("payments.approve") &&
        !isContributor(invoice.contributors, this.actor);
      const since = invoice.submittedAt ?? invoice.createdAt;
      const match = invoice.matches.at(-1);
      // Only mismatches an exception can override (the API's inbox, after the D5.2 fix).
      if (invoice.status === "disputed" && approver && match?.result.exceptable && !match.exception)
        push(
          "invoice-exception",
          invoice.projectId,
          invoice.id,
          invoice.invoiceNumber,
          since,
          href,
          invoice.totalMinor,
          invoice.supplierId,
        );
      if (invoice.status === "matched" && approver)
        push(
          "invoice-approval",
          invoice.projectId,
          invoice.id,
          invoice.invoiceNumber,
          since,
          href,
          invoice.totalMinor,
          invoice.supplierId,
        );
      if (["approved", "partly_settled"].includes(invoice.status)) {
        const active = this.activePayable(invoice);
        const current = active && this.payeeStatus(invoice, active) === "verified";
        const outstanding = invoice.totalMinor - this.settled(invoice);
        if (!current && approver)
          push(
            "invoice-reapproval",
            invoice.projectId,
            invoice.id,
            invoice.invoiceNumber,
            since,
            href,
            outstanding,
            invoice.supplierId,
          );
        if (
          current &&
          active.approvedBy.id !== this.actor.id &&
          this.on(invoice.projectId).has("payments.disburse")
        )
          push(
            "invoice-settlement",
            invoice.projectId,
            invoice.id,
            invoice.invoiceNumber,
            since,
            href,
            outstanding,
            invoice.supplierId,
          );
      }
    }
    return { body: { items }, schema: inboxResponseSchema };
  }
  commitments(projectId: string): Reply {
    this.project(projectId);
    this.viewer(projectId);
    type Bucket = { bqItem: BqItemRef | null; committed: number; accrued: number };
    const buckets = new Map<string, Bucket>();
    const bucket = (item: BqItemRef | null) => {
      const key = item?.lineageId ?? "untagged";
      if (!buckets.has(key)) buckets.set(key, { bqItem: item, committed: 0, accrued: 0 });
      return buckets.get(key)!;
    };
    for (const lpo of this.state.lpos)
      if (lpo.projectId === projectId && lpo.status === "approved")
        for (const line of lpo.lines) bucket(line.bqItem).committed += line.netAmountMinor;
    for (const invoice of this.state.invoices)
      if (invoice.projectId === projectId && ACCRUED.includes(invoice.status)) {
        const lpo = this.lpo(invoice.lpoId);
        for (const line of invoice.lines)
          bucket(lpo.lines.find((entry) => entry.id === line.lpoLineId)?.bqItem ?? null).accrued +=
            line.netAmountMinor;
      }
    const items = [...buckets.values()].map((entry) => ({
      bqItem: entry.bqItem,
      committedMinor: entry.committed,
      accruedMinor: entry.accrued,
      openCommitmentMinor: Math.max(0, entry.committed - entry.accrued),
    }));
    const total = (pick: (item: (typeof items)[number]) => number) =>
      items.reduce((s, item) => s + pick(item), 0);
    return {
      body: {
        project: this.projectRef(projectId),
        totals: {
          committedMinor: total((item) => item.committedMinor),
          accruedMinor: total((item) => item.accruedMinor),
          openCommitmentMinor: total((item) => item.openCommitmentMinor),
          paidMinor: this.state.invoices
            .filter((invoice) => invoice.projectId === projectId)
            .reduce((s, invoice) => s + this.settled(invoice), 0),
        },
        items,
      },
      schema: commitmentsResponseSchema,
    };
  }
}

/** The first file part of a multipart body (the mock reads the raw request). */
function multipartFile(raw: Buffer, contentType: string | undefined): Buffer | null {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType ?? "");
  const marker = boundary?.[1] ?? boundary?.[2];
  if (!marker) return null;
  const delimiter = Buffer.from(`--${marker}`);
  let start = raw.indexOf(delimiter);
  while (start !== -1) {
    const next = raw.indexOf(delimiter, start + delimiter.length);
    if (next === -1) break;
    const part = raw.subarray(start + delimiter.length, next);
    const split = part.indexOf("\r\n\r\n");
    if (split !== -1 && /name="file"/.test(part.subarray(0, split).toString("latin1"))) {
      const body = part.subarray(split + 4, part.length - 2);
      return body.length ? body : null;
    }
    start = next;
  }
  return null;
}

function sniff(content: Buffer): ProcurementDocumentType | null {
  if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff)
    return "image/jpeg";
  if (content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "image/png";
  if (
    content.length >= 12 &&
    content.subarray(0, 4).toString("latin1") === "RIFF" &&
    content.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return "image/webp";
  if (content.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  return null;
}

/** A stored document for the download route (bytes and content type). */
export function p2pDocument(state: P2pState, id: string) {
  const document = state.documents.find((entry) => entry.id === id);
  return document ? { contentType: document.contentType, content: document.content } : null;
}

const listPage = <T,>(items: T[]) => ({ items, page: { nextCursor: null, hasMore: false } });

export function handleP2p(
  deps: P2pDeps,
  state: P2pState,
  method: string,
  path: string,
  query: URLSearchParams,
  body: unknown,
): Reply | null {
  if (!path.startsWith("/procurement/") || path === "/procurement/settings") return null;
  const p2p: P2p = new P2p(deps, state);
  const projectFilter = query.get("projectId");
  const statusFilter = query.get("status");
  const visible = () => p2p.visible().filter((id) => !projectFilter || id === projectFilter);

  if (path === "/procurement/inbox" && method === "GET") return p2p.inbox();
  if (path === "/procurement/commitments" && method === "GET")
    return p2p.commitments(query.get("projectId") ?? "");
  const download = /^\/procurement\/documents\/([^/]+)$/.exec(path);
  if (download) return null;

  // Requisitions
  if (path === "/procurement/requisitions") {
    if (method === "POST") {
      const row = p2p.createRequisition(body);
      return { ...p2p.requisitionDetail(row), status: 201 };
    }
    const ids = visible();
    const rows = [...state.requisitions]
      .reverse()
      .filter(
        (row) => ids.includes(row.projectId) && (!statusFilter || row.status === statusFilter),
      );
    const { items, page } = listPage(rows.map((row) => p2p.requisitionWire(row)));
    return {
      body: {
        requisitions: items,
        page,
        permissions: {
          canCreate: p2p.company().includes("procurement.requisition") && p2p.visible().length > 0,
        },
      },
      schema: requisitionsResponseSchema,
    };
  }
  const requisitionMatch = /^\/procurement\/requisitions\/([^/]+)(?:\/([a-z]+))?$/.exec(path);
  if (requisitionMatch) {
    const row = p2p.requisition(requisitionMatch[1]!);
    const action = requisitionMatch[2];
    if (!action && method === "GET") {
      p2p.viewer(row.projectId);
      return p2p.requisitionDetail(row);
    }
    if (!action && method === "PATCH") p2p.updateRequisition(row, body);
    else if (action && ["submit", "approve", "reject", "reopen", "cancel"].includes(action))
      p2p.transitionRequisition(row, action as RequisitionAction, body);
    else p2p.fail(404, "not-found");
    return p2p.requisitionDetail(row);
  }

  // RFQs
  if (path === "/procurement/rfqs") {
    if (method === "POST") return { ...p2p.rfqDetail(p2p.createRfq(body)), status: 201 };
    const ids = visible();
    const rows = [...state.rfqs]
      .reverse()
      .filter(
        (rfq) => ids.includes(rfq.projectId) && (!statusFilter || rfq.status === statusFilter),
      );
    const { items, page } = listPage(rows.map((rfq) => p2p.rfqWire(rfq)));
    return {
      body: {
        rfqs: items,
        page,
        permissions: { canCreate: p2p.company().includes("procurement.manage_suppliers") },
      },
      schema: rfqsResponseSchema,
    };
  }
  const rfqMatch =
    /^\/procurement\/rfqs\/([^/]+)(?:\/(quotations|exception|award|cancel)(?:\/(approve)|\/([^/]+)(?:\/(withdraw|document))?)?)?$/.exec(
      path,
    );
  if (rfqMatch) {
    const rfq = p2p.rfq(rfqMatch[1]!);
    const [, , section, exceptionApprove, quotationId, quotationAction] = rfqMatch;
    if (!section && method === "GET") {
      p2p.viewer(rfq.projectId);
      return p2p.rfqDetail(rfq);
    }
    if (section === "quotations" && !quotationId && method === "POST") {
      p2p.recordQuotation(rfq, body);
      return { ...p2p.rfqDetail(rfq), status: 201 };
    }
    if (section === "quotations" && quotationId) {
      p2p.manager();
      const quote = rfq.quotations.find((entry) => entry.id === quotationId);
      if (!quote) p2p.fail(404, "not-found");
      if (quotationAction === "withdraw") {
        const input = deps.parse(withdrawQuotationRequestSchema, body);
        p2p.openRfq(rfq);
        if (quote.status !== "received") p2p.fail(409, "invalid-transition");
        quote.status = "withdrawn";
        quote.withdrawnReason = input.reason;
        p2p.touchRfq(rfq);
        return p2p.rfqDetail(rfq);
      }
      if (quotationAction === "document") {
        const document = p2p.upload("quotation", quote.id);
        quote.documentId = document.id;
        return {
          status: 201,
          body: { document: p2p.documentWire(document.id) },
          schema: procurementDocumentResponseSchema,
        };
      }
    }
    if (section === "exception" && !exceptionApprove) {
      p2p.manager();
      const input = deps.parse(rfqExceptionRequestSchema, body);
      p2p.openRfq(rfq, input.version);
      if (rfq.exceptionRequestedAt) p2p.fail(409, "exception-exists");
      Object.assign(rfq, {
        exceptionReason: input.reason,
        exceptionRequestedAt: now(),
        exceptionRequestedBy: p2p.actor,
      });
      p2p.touchRfq(rfq);
      return p2p.rfqDetail(rfq);
    }
    if (section === "exception" && exceptionApprove) {
      const input = deps.parse(versionRequestSchema, body);
      p2p.require(rfq.projectId, ["procurement.approve"], true);
      p2p.openRfq(rfq, input.version);
      if (!rfq.exceptionRequestedAt) p2p.fail(409, "exception-not-requested");
      if (rfq.exceptionApprovedAt) p2p.fail(409, "exception-exists");
      if (isContributor(rfq.contributors, p2p.actor)) p2p.fail(403, "maker-checker");
      Object.assign(rfq, { exceptionApprovedAt: now(), exceptionApprovedBy: p2p.actor });
      rfq.version += 1;
      return p2p.rfqDetail(rfq);
    }
    if (section === "award") return { ...p2p.lpoDetail(p2p.award(rfq, body)), status: 201 };
    if (section === "cancel") {
      p2p.manager();
      const input = deps.parse(reasonRequestSchema, body);
      p2p.openRfq(rfq, input.version);
      Object.assign(rfq, { status: "cancelled", cancelledAt: now(), cancelReason: input.reason });
      rfq.version += 1;
      return p2p.rfqDetail(rfq);
    }
    return p2p.fail(404, "not-found");
  }

  // LPOs
  if (path === "/procurement/lpos" && method === "GET") {
    const ids = visible();
    const supplierFilter = query.get("supplierId");
    const rows = [...state.lpos]
      .reverse()
      .filter(
        (lpo) =>
          ids.includes(lpo.projectId) &&
          (!statusFilter || lpo.status === statusFilter) &&
          (!supplierFilter || lpo.supplier.id === supplierFilter),
      );
    const { items, page } = listPage(rows.map((lpo) => p2p.lpoWire(lpo)));
    return { body: { lpos: items, page }, schema: lposResponseSchema };
  }
  const lpoMatch = /^\/procurement\/lpos\/([^/]+)(?:\/([a-z]+))?$/.exec(path);
  if (lpoMatch) {
    const lpo = p2p.lpo(lpoMatch[1]!);
    const action = lpoMatch[2];
    if (!action && method === "GET") {
      p2p.viewer(lpo.projectId);
      return p2p.lpoDetail(lpo);
    }
    if (!action && method === "PATCH") {
      const input = deps.parse(updateLpoRequestSchema, body);
      p2p.require(lpo.projectId, ["procurement.manage_suppliers"], true);
      if (lpo.status !== "draft") p2p.fail(409, "invalid-transition");
      if (lpo.version !== input.version) p2p.fail(409, "version-conflict");
      if (input.deliverySiteId !== undefined) {
        p2p.assertSite(lpo.projectId, input.deliverySiteId);
        lpo.deliverySiteId = input.deliverySiteId;
      }
      if (input.deliveryDate !== undefined) lpo.deliveryDate = input.deliveryDate;
      if (input.terms !== undefined) lpo.terms = input.terms;
      lpo.version += 1;
      lpo.contributors = contributes(lpo.contributors, p2p.actor);
      return p2p.lpoDetail(lpo);
    }
    if (action && ["submit", "approve", "return", "cancel"].includes(action)) {
      p2p.transitionLpo(lpo, action as LpoAction, body);
      return p2p.lpoDetail(lpo);
    }
    return p2p.fail(404, "not-found");
  }

  // GRNs
  if (path === "/procurement/grns/receivable" && method === "GET")
    return p2p.receivable(projectFilter);
  if (path === "/procurement/grns") {
    if (method === "POST") return p2p.createGrn(body);
    const ids = visible();
    const lpoFilter = query.get("lpoId");
    const rows = [...state.grns]
      .reverse()
      .filter((grn) => ids.includes(grn.projectId) && (!lpoFilter || grn.lpoId === lpoFilter));
    const { items, page } = listPage(
      rows.map((grn) => {
        const wire: Partial<ReturnType<P2p["grnWire"]>> = p2p.grnWire(grn);
        delete wire.lines;
        delete wire.photos;
        return wire;
      }),
    );
    return { body: { grns: items, page }, schema: grnsResponseSchema };
  }
  const grnMatch = /^\/procurement\/grns\/([^/]+)(?:\/(photos|void))?$/.exec(path);
  if (grnMatch) {
    const grn = p2p.grn(grnMatch[1]!);
    if (!grnMatch[2] && method === "GET") {
      p2p.viewer(grn.projectId);
      return p2p.grnResponse(grn, false);
    }
    if (grnMatch[2] === "photos") {
      p2p.require(grn.projectId, RECEIVERS);
      if (grn.status !== "recorded") p2p.fail(409, "invalid-transition");
      const kind = query.get("kind");
      if (kind !== "delivery_note" && kind !== "goods") p2p.fail(400, "validation-error");
      if (state.documents.filter((document) => document.owner === grn.id).length >= 10)
        p2p.fail(409, "too-many-photos");
      const document = p2p.upload(kind as GrnPhotoKind, grn.id);
      return {
        status: 201,
        body: { document: p2p.documentWire(document.id) },
        schema: procurementDocumentResponseSchema,
      };
    }
    if (grnMatch[2] === "void") {
      const input = deps.parse(voidGrnRequestSchema, body);
      p2p.require(grn.projectId, ["stores.manage"]);
      if (grn.status !== "recorded") p2p.fail(409, "invalid-transition");
      if (
        state.invoices.some((invoice) =>
          invoice.payables.some((payable) =>
            invoice.matches.find((match) => match.id === payable.matchId)?.grnIds.includes(grn.id),
          ),
        )
      )
        p2p.fail(409, "grn-supports-approved-invoice");
      Object.assign(grn, {
        status: "voided",
        voidedAt: now(),
        voidedBy: p2p.actor,
        voidReason: input.reason,
      });
      return p2p.grnResponse(grn, false);
    }
    return p2p.fail(404, "not-found");
  }

  // Invoices
  if (path === "/procurement/invoices") {
    if (method === "POST") return p2p.invoiceDetail(p2p.createInvoice(body), 201);
    const ids = visible();
    const lpoFilter = query.get("lpoId");
    const sourceFilter = query.get("source");
    const rows = [...state.invoices]
      .reverse()
      .filter(
        (invoice) =>
          ids.includes(invoice.projectId) &&
          (!statusFilter || invoice.status === statusFilter) &&
          (!lpoFilter || invoice.lpoId === lpoFilter) &&
          (!sourceFilter || invoice.source === sourceFilter),
      );
    const { items, page } = listPage(rows.map((invoice) => p2p.invoiceWire(invoice)));
    return {
      body: {
        invoices: items,
        page,
        permissions: {
          canRecord: RECORDERS.some((key) => p2p.company().includes(key)) && ids.length > 0,
        },
      },
      schema: invoicesResponseSchema,
    };
  }
  const invoiceMatch = /^\/procurement\/invoices\/([^/]+)(?:\/([a-z]+))?$/.exec(path);
  if (invoiceMatch) {
    const invoice = p2p.invoice(invoiceMatch[1]!);
    const action = invoiceMatch[2];
    if (!action && method === "GET") {
      p2p.viewer(invoice.projectId);
      return p2p.invoiceDetail(invoice);
    }
    if (!action && method === "PATCH") {
      p2p.updateInvoice(invoice, body);
      return p2p.invoiceDetail(invoice);
    }
    if (action === "document") {
      p2p.require(invoice.projectId, RECORDERS);
      const document = p2p.upload("invoice", invoice.id);
      return {
        status: 201,
        body: { document: p2p.documentWire(document.id) },
        schema: procurementDocumentResponseSchema,
      };
    }
    if (action) return p2p.invoiceCommand(invoice, action, body);
  }
  return p2p.fail(404, "not-found");
}

/**
 * The fixture every test starts with, built through the same operations as the requests (as
 * the API's demo seed does through its services): REQ-0001 → RFQ-0001 with three quotations →
 * LPO-0001 approved → GRN-0001 (two lorry trips of sand, half the cement) → invoice MQ-INV-1001
 * matched, approved and settled, and MQ-INV-1002 billing cement not yet delivered: blocked.
 */
export function initialP2p(base: Omit<P2pDeps, "persona">): P2pState {
  const state = emptyP2p();
  const as = (persona: P2pPersona) => new P2p({ ...base, persona }, state);
  const today = nairobiDate();
  const sand = base.catalogue.materials.find((entry) => entry.name === "River sand")!;
  const cement = base.catalogue.materials.find((entry) => entry.code === "MAT-0001")!;
  const [quarry, steel, hardware] = base.catalogue.suppliers.map((entry) => entry.supplier.id) as [
    string,
    string,
    string,
  ];
  const site = base.projects.find((entry) => entry.id === RUIRU_ID)!.sites[0]!;
  const requisition = as("agent").createRequisition({
    projectId: RUIRU_ID,
    siteId: site.id,
    neededBy: addDays(today, 7),
    notes: "Demo procure-to-pay flow (synthetic)",
    lines: [
      { materialId: sand.id, quantity: "14", unit: "t" },
      { materialId: cement.id, quantity: "100", unit: "bag_50kg" },
    ],
  });
  as("agent").transitionRequisition(requisition, "submit", { version: requisition.version });
  as("pm").transitionRequisition(requisition, "approve", { version: requisition.version });
  const owner = as("owner");
  const rfq = owner.createRfq({
    requisitionIds: [requisition.id],
    supplierIds: [quarry, steel, hardware],
    respondBy: addDays(today, 2),
  });
  const [sandLine, cementLine] = requisition.lines.map((line) => line.id) as [string, string];
  const quotes: [string, [string, number], number][] = [
    [quarry, ["trip", 2_800_000], 90_000],
    [steel, ["t", 430_000], 88_000],
    [hardware, ["t", 420_000], 92_000],
  ];
  for (const [supplierId, [unit, price], cementPrice] of quotes)
    owner.recordQuotation(rfq, {
      supplierId,
      reference: "Demo quote",
      quotedOn: today,
      validUntil: addDays(today, 30),
      deliveryDays: 2,
      lines: [
        {
          requisitionLineId: sandLine,
          priceUnit: unit,
          unitPriceMinor: price,
          vatTreatment: "exclusive",
        },
        {
          requisitionLineId: cementLine,
          priceUnit: "bag_50kg",
          unitPriceMinor: cementPrice,
          vatTreatment: "inclusive",
        },
      ],
    });
  const lpo = owner.award(rfq, {
    version: rfq.version,
    quotationId: rfq.quotations[0]!.id,
    deliverySiteId: site.id,
    deliveryDate: addDays(today, 3),
    terms: "Deliver to the site gate between 08:00 and 16:00 (demo).",
  });
  owner.transitionLpo(lpo, "submit", { version: lpo.version });
  new P2p({ ...base, persona: "pm", requireStepUp: () => undefined }, state).transitionLpo(
    lpo,
    "approve",
    { version: lpo.version },
  );
  const [sandLpo, cementLpo] = lpo.lines as [MockLpoLine, MockLpoLine];
  new P2p({ ...base, persona: "agent", idempotencyKey: `seed-grn-${lpo.id}` }, state).createGrn({
    id: randomUUID(),
    lpoId: lpo.id,
    capturedAt: new Date().toISOString(),
    receivedByName: "Kevin Kiprono (demo)",
    vehicleRegistration: "KDA 123A",
    deliveryNoteNumber: "MQ-DN-5521",
    location: { latitude: -1.14872, longitude: 36.96147, accuracyM: 8 },
    source: "web",
    lines: [
      { lpoLineId: sandLpo.id, unit: "trip", receivedQuantity: "2" },
      { lpoLineId: cementLpo.id, receivedQuantity: "50" },
    ],
  });
  const finance = as("finance");
  const first = finance.createInvoice({
    lpoId: lpo.id,
    invoiceNumber: "MQ-INV-1001",
    invoiceDate: today,
    etimsInvoiceNumber: "KRACU0100000001/101",
    subtotalMinor: 9_479_310,
    vatMinor: 1_516_690,
    totalMinor: 10_996_000,
    lines: [
      { lpoLineId: sandLpo.id, quantity: "14", unitPriceMinor: 400_000, vatTreatment: "exclusive" },
      {
        lpoLineId: cementLpo.id,
        quantity: "50",
        unitPriceMinor: 90_000,
        vatTreatment: "inclusive",
      },
    ],
  });
  finance.invoiceCommand(first, "submit", { version: first.version });
  new P2p({ ...base, persona: "owner", requireStepUp: () => undefined }, state).invoiceCommand(
    first,
    "approve",
    {
      version: first.version,
      matchId: first.matches.at(-1)!.id,
      payoutVersionId: finance.verifiedPayee(first.supplierId)!.id,
    },
  );
  new P2p(
    {
      ...base,
      persona: "finance",
      requireStepUp: () => undefined,
      idempotencyKey: `seed-settle-${first.id}`,
    },
    state,
  ).invoiceCommand(first, "settlements", {
    method: "bank_transfer",
    externalReference: "DEMO-FT-0001",
    amountMinor: 10_996_000,
    paidOn: today,
    note: "Demo settlement recorded by hand (no money moved).",
  });
  const second = finance.createInvoice({
    lpoId: lpo.id,
    invoiceNumber: "MQ-INV-1002",
    invoiceDate: today,
    etimsInvoiceNumber: "KRACU0100000001/102",
    subtotalMinor: 3_879_310,
    vatMinor: 620_690,
    totalMinor: 4_500_000,
    lines: [
      {
        lpoLineId: cementLpo.id,
        quantity: "50",
        unitPriceMinor: 90_000,
        vatTreatment: "inclusive",
      },
    ],
  });
  finance.invoiceCommand(second, "submit", { version: second.version });
  // The supplier submitted this one through the supplier portal (D7.2): it cannot be reopened.
  second.source = "supplier_portal";
  return state;
}
