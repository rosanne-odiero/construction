import { classifyEtimsInvoiceNumber, normaliseVehicleRegistration } from "@pm-buddy/domain";
import {
  ETIMS_NUMBER_FORMATS,
  ETIMS_STATUSES,
  GRN_LOCATION_STATES,
  GRN_PHOTO_KINDS,
  GRN_SOURCES,
  GRN_STATUSES,
  INBOX_KINDS,
  INVOICE_STATUSES,
  LOCATION_ERRORS,
  LPO_DELIVERY_STATES,
  LPO_STATUSES,
  MATCH_HEADER_REASONS,
  MATCH_LINE_REASONS,
  MATCH_OUTCOMES,
  MATCH_STALE_REASONS,
  MATCH_WARNINGS,
  MPESA_PAYOUT_KINDS,
  P2P_LIMITS,
  PAYABLE_STATUSES,
  PAYOUT_STATUSES,
  PROCUREMENT_DOCUMENT_KINDS,
  PROCUREMENT_DOCUMENT_TYPES,
  QUOTATION_LINE_STATUSES,
  QUOTATION_STATUSES,
  REQUISITION_STATUSES,
  RFQ_EXCEPTION_STATUSES,
  RFQ_STATUSES,
  SETTLEMENT_METHODS,
  VAT_TREATMENTS,
  VEHICLE_REG_FORMATS,
} from "@pm-buddy/types";
import { z } from "zod";
import { pageInfoSchema } from "./api.js";
import { positiveQuantitySchema, quantitySchema, unitCodeSchema } from "./procurement.js";

/**
 * D5.2 procure-to-pay contracts: requisitions, RFQs and quotations with the comparison matrix,
 * LPOs, Goods Received Notes (offline-ready: client IDs and idempotency keys), supplier invoices
 * with eTIMS, the three-way match, payables (approval snapshots) and recorded settlements.
 * Requests are strict and never carry a tenant, maker, approver or amount the server computes;
 * responses are strict. Money is KES minor units; quantities are decimal strings (six places).
 */

const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
const calendarDate = z.iso.date();
const version = z.number().int().min(1).max(2_147_483_647);
const person = z.strictObject({ id: uuid, displayName: z.string() });
const minor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveMinor = z.number().int().min(1).max(1_000_000_000_000_000);
const listLimit = z.coerce.number().int().min(1).max(200).default(P2P_LIMITS.pageSize);

function printable(value: string, multiline: boolean): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (multiline && (code === 9 || code === 10 || code === 13)) continue;
    if (code < 32 || (code >= 127 && code <= 159)) return false;
  }
  return true;
}
const text = (min: number, max: number, multiline = false) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((value) => printable(value, multiline), "control_characters");
const optionalText = (max: number, multiline = false) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => printable(value, multiline), "control_characters")
    .transform((value) => (value === "" ? null : value))
    .nullable();

const projectRef = z.strictObject({ id: uuid, code: z.string(), name: z.string() });
const siteRef = z.strictObject({ id: uuid, name: z.string() });
const supplierRef = z.strictObject({ id: uuid, code: z.string(), name: z.string() });
const materialRef = z.strictObject({
  id: uuid,
  code: z.string(),
  name: z.string(),
  baseUnit: z.string(),
});
const linkRef = z.strictObject({ id: uuid, number: z.string(), status: z.string() });
/** A BQ item of an approved version, by lineage (D2.3), for cost tagging. */
const bqItemRef = z.strictObject({
  versionId: uuid,
  lineageId: uuid,
  ref: z.string().nullable(),
  description: z.string(),
});

export const procurementDocumentSchema = z.strictObject({
  id: uuid,
  kind: z.enum(PROCUREMENT_DOCUMENT_KINDS),
  contentType: z.enum(PROCUREMENT_DOCUMENT_TYPES),
  sizeBytes: z.number().int().min(1),
  /** `not_scanned` only in development (the no-op scanner). */
  scanStatus: z.enum(["clean", "not_scanned"]),
  uploadedAt: timestamp,
  uploadedBy: person,
});
export type ProcurementDocument = z.infer<typeof procurementDocumentSchema>;
export const procurementDocumentResponseSchema = z.strictObject({
  document: procurementDocumentSchema,
});

export const versionRequestSchema = z.strictObject({ version });
export const reasonRequestSchema = z.strictObject({ version, reason: text(3, 500) });
export type VersionRequest = z.infer<typeof versionRequestSchema>;
export type ReasonRequest = z.infer<typeof reasonRequestSchema>;

// Requisitions -------------------------------------------------------------------------------

export const requisitionLineInputSchema = z.strictObject({
  materialId: uuid,
  quantity: positiveQuantitySchema,
  unit: unitCodeSchema,
  /** A BQ item lineage of the project's newest approved BQ version (optional cost tag). */
  bqItemLineageId: uuid.nullable().default(null),
  note: optionalText(300).optional(),
});
export type RequisitionLineInput = z.infer<typeof requisitionLineInputSchema>;

const requisitionLines = z
  .array(requisitionLineInputSchema)
  .min(1)
  .max(P2P_LIMITS.linesPerDocument);

export const createRequisitionRequestSchema = z.strictObject({
  projectId: uuid,
  siteId: uuid.nullable().default(null),
  neededBy: calendarDate,
  notes: optionalText(2000, true).optional(),
  lines: requisitionLines,
});
export type CreateRequisitionRequest = z.infer<typeof createRequisitionRequestSchema>;

export const updateRequisitionRequestSchema = z.strictObject({
  version,
  siteId: uuid.nullable().optional(),
  neededBy: calendarDate.optional(),
  notes: optionalText(2000, true).optional(),
  lines: requisitionLines.optional(),
});
export type UpdateRequisitionRequest = z.infer<typeof updateRequisitionRequestSchema>;

export const requisitionLineSchema = z.strictObject({
  id: uuid,
  lineNo: z.number().int().min(1),
  material: materialRef,
  quantity: z.string(),
  unit: z.string(),
  /** In the material's base unit (rounded half-up to six places once). */
  baseQuantity: z.string(),
  bqItem: bqItemRef.nullable(),
  note: z.string().nullable(),
});
export type RequisitionLine = z.infer<typeof requisitionLineSchema>;

export const requisitionSchema = z.strictObject({
  id: uuid,
  number: z.string(),
  project: projectRef,
  site: siteRef.nullable(),
  status: z.enum(REQUISITION_STATUSES),
  neededBy: calendarDate,
  notes: z.string().nullable(),
  lineCount: z.number().int().min(0),
  version,
  createdAt: timestamp,
  createdBy: person,
  submittedAt: timestamp.nullable(),
  submittedBy: person.nullable(),
  decidedAt: timestamp.nullable(),
  decidedBy: person.nullable(),
  rejectionReason: z.string().nullable(),
  cancelledAt: timestamp.nullable(),
  cancelReason: z.string().nullable(),
  /** The open or awarded RFQ that carries it, and the LPO once one exists. */
  rfq: linkRef.nullable(),
  lpo: linkRef.nullable(),
});
export type Requisition = z.infer<typeof requisitionSchema>;

export const requisitionListQuerySchema = z.object({
  projectId: uuid.optional(),
  status: z.enum(REQUISITION_STATUSES).optional(),
  cursor: uuid.optional(),
  limit: listLimit,
});
export const requisitionsResponseSchema = z.strictObject({
  requisitions: z.array(requisitionSchema),
  page: pageInfoSchema,
  permissions: z.strictObject({ canCreate: z.boolean() }),
});
export type RequisitionsResponse = z.infer<typeof requisitionsResponseSchema>;

export const requisitionDetailResponseSchema = z.strictObject({
  requisition: requisitionSchema,
  lines: z.array(requisitionLineSchema),
  /** Everyone who wrote it (none of them may approve or reject it). */
  contributors: z.array(person),
  permissions: z.strictObject({
    canEdit: z.boolean(),
    canDecide: z.boolean(),
    canCancel: z.boolean(),
    canCreateRfq: z.boolean(),
  }),
});
export type RequisitionDetailResponse = z.infer<typeof requisitionDetailResponseSchema>;

// RFQs and quotations ------------------------------------------------------------------------

export const createRfqRequestSchema = z.strictObject({
  requisitionIds: z.array(uuid).min(1).max(P2P_LIMITS.requisitionsPerRfq),
  supplierIds: z.array(uuid).min(1).max(P2P_LIMITS.suppliersPerRfq),
  respondBy: calendarDate.nullable().default(null),
  notes: optionalText(2000, true).optional(),
});
export type CreateRfqRequest = z.infer<typeof createRfqRequestSchema>;

export const updateRfqRequestSchema = z.strictObject({
  version,
  supplierIds: z.array(uuid).min(1).max(P2P_LIMITS.suppliersPerRfq).optional(),
  respondBy: calendarDate.nullable().optional(),
  notes: optionalText(2000, true).optional(),
});
export type UpdateRfqRequest = z.infer<typeof updateRfqRequestSchema>;

export const quotationLineInputSchema = z
  .strictObject({
    requisitionLineId: uuid,
    noBid: z.boolean().default(false),
    priceUnit: unitCodeSchema.nullable().default(null),
    unitPriceMinor: z.number().int().min(1).max(1_000_000_000_000).nullable().default(null),
    vatTreatment: z.enum(VAT_TREATMENTS).nullable().default(null),
  })
  .superRefine((value, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    if (value.noBid) {
      if (value.priceUnit || value.unitPriceMinor !== null || value.vatTreatment)
        issue("noBid", "no_price_with_no_bid");
    } else {
      if (!value.priceUnit) issue("priceUnit", "required");
      if (value.unitPriceMinor === null) issue("unitPriceMinor", "required");
      if (!value.vatTreatment) issue("vatTreatment", "required");
    }
  });

export const recordQuotationRequestSchema = z
  .strictObject({
    supplierId: uuid,
    reference: optionalText(60).optional(),
    quotedOn: calendarDate,
    validUntil: calendarDate,
    deliveryDays: z.number().int().min(0).max(365),
    lines: z.array(quotationLineInputSchema).min(1).max(P2P_LIMITS.linesPerDocument),
  })
  .superRefine((value, ctx) => {
    if (value.validUntil < value.quotedOn)
      ctx.addIssue({ code: "custom", path: ["validUntil"], message: "before_quoted_on" });
    const ids = value.lines.map((line) => line.requisitionLineId);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: "custom", path: ["lines"], message: "duplicate_line" });
  });
export type RecordQuotationRequest = z.infer<typeof recordQuotationRequestSchema>;
export const withdrawQuotationRequestSchema = z.strictObject({ reason: text(3, 500) });

export const rfqExceptionRequestSchema = z.strictObject({ version, reason: text(3, 500) });

export const awardRfqRequestSchema = z.strictObject({
  version,
  quotationId: uuid,
  deliverySiteId: uuid.nullable().default(null),
  deliveryDate: calendarDate.nullable().default(null),
  terms: optionalText(2000, true).optional(),
});
export type AwardRfqRequest = z.infer<typeof awardRfqRequestSchema>;

export const rfqLineSchema = z.strictObject({
  /** The requisition line this RFQ line asks prices for. */
  requisitionLineId: uuid,
  requisition: z.strictObject({ id: uuid, number: z.string() }),
  material: materialRef,
  quantity: z.string(),
  unit: z.string(),
  baseQuantity: z.string(),
});
export type RfqLine = z.infer<typeof rfqLineSchema>;

export const quotationLineSchema = z.strictObject({
  requisitionLineId: uuid,
  status: z.enum(QUOTATION_LINE_STATUSES),
  priceUnit: z.string().nullable(),
  unitPriceMinor: z.number().int().nullable(),
  vatTreatment: z.enum(VAT_TREATMENTS).nullable(),
  /** Net of VAT per base unit of the material, minor units with six decimals. */
  netUnitPriceBaseMinor: z.string().nullable(),
  /** Requested base quantity × that price, rounded half-up to the cent once. */
  netAmountMinor: minor.nullable(),
  /** The price-history row this line wrote (source `quotation`). */
  priceId: uuid.nullable(),
});

export const quotationSchema = z.strictObject({
  id: uuid,
  supplier: supplierRef,
  reference: z.string().nullable(),
  quotedOn: calendarDate,
  validUntil: calendarDate,
  deliveryDays: z.number().int(),
  status: z.enum(QUOTATION_STATUSES),
  withdrawnReason: z.string().nullable(),
  /** Every line priced (no "no bid"). Only complete, valid quotations count and can win. */
  complete: z.boolean(),
  expired: z.boolean(),
  netTotalMinor: minor,
  recordedAt: timestamp,
  recordedBy: person,
  document: procurementDocumentSchema.nullable(),
  lines: z.array(quotationLineSchema),
});
export type Quotation = z.infer<typeof quotationSchema>;

export const comparisonSchema = z.strictObject({
  lines: z.array(
    z.strictObject({
      requisitionLineId: uuid,
      cells: z.array(
        z.strictObject({
          quotationId: uuid,
          netUnitPriceBaseMinor: z.string().nullable(),
          netAmountMinor: minor.nullable(),
          lowest: z.boolean(),
        }),
      ),
    }),
  ),
  totals: z.array(
    z.strictObject({
      quotationId: uuid,
      netTotalMinor: minor,
      complete: z.boolean(),
      lowest: z.boolean(),
    }),
  ),
});
export type Comparison = z.infer<typeof comparisonSchema>;

export const rfqSchema = z.strictObject({
  id: uuid,
  number: z.string(),
  project: projectRef,
  status: z.enum(RFQ_STATUSES),
  respondBy: calendarDate.nullable(),
  notes: z.string().nullable(),
  requisitions: z.array(z.strictObject({ id: uuid, number: z.string() })),
  suppliers: z.array(supplierRef),
  quotationCount: z.number().int().min(0),
  exception: z.strictObject({
    status: z.enum(RFQ_EXCEPTION_STATUSES),
    reason: z.string().nullable(),
    requestedAt: timestamp.nullable(),
    requestedBy: person.nullable(),
    approvedAt: timestamp.nullable(),
    approvedBy: person.nullable(),
  }),
  awardedQuotationId: uuid.nullable(),
  lpo: linkRef.nullable(),
  version,
  createdAt: timestamp,
  createdBy: person,
  cancelledAt: timestamp.nullable(),
  cancelReason: z.string().nullable(),
});
export type Rfq = z.infer<typeof rfqSchema>;

export const rfqListQuerySchema = z.object({
  projectId: uuid.optional(),
  status: z.enum(RFQ_STATUSES).optional(),
  cursor: uuid.optional(),
  limit: listLimit,
});
export const rfqsResponseSchema = z.strictObject({
  rfqs: z.array(rfqSchema),
  page: pageInfoSchema,
  permissions: z.strictObject({ canCreate: z.boolean() }),
});
export type RfqsResponse = z.infer<typeof rfqsResponseSchema>;

export const rfqDetailResponseSchema = z.strictObject({
  rfq: rfqSchema,
  lines: z.array(rfqLineSchema),
  quotations: z.array(quotationSchema),
  comparison: comparisonSchema,
  award: z.strictObject({
    /** `procurement.min_quotes` now in force. */
    minQuotes: z.number().int().min(1),
    /** Complete, received, unexpired quotations. */
    completeQuotes: z.number().int().min(0),
    basis: z.enum(["enough-quotes", "exception-approved", "not-enough-quotes"]),
  }),
  contributors: z.array(person),
  permissions: z.strictObject({
    canManage: z.boolean(),
    canApproveException: z.boolean(),
  }),
});
export type RfqDetailResponse = z.infer<typeof rfqDetailResponseSchema>;

// LPOs ----------------------------------------------------------------------------------------

export const updateLpoRequestSchema = z.strictObject({
  version,
  deliverySiteId: uuid.nullable().optional(),
  deliveryDate: calendarDate.nullable().optional(),
  terms: optionalText(2000, true).optional(),
});
export type UpdateLpoRequest = z.infer<typeof updateLpoRequestSchema>;

export const lpoLineSchema = z.strictObject({
  id: uuid,
  lineNo: z.number().int().min(1),
  requisitionLineId: uuid,
  material: materialRef,
  quantity: z.string(),
  unit: z.string(),
  baseQuantity: z.string(),
  priceUnit: z.string(),
  unitPriceMinor: z.number().int().positive(),
  vatTreatment: z.enum(VAT_TREATMENTS),
  netUnitPriceBaseMinor: z.string(),
  netAmountMinor: minor,
  bqItem: bqItemRef.nullable(),
  /** Accepted base quantity over recorded GRNs; billed base quantity over approved invoices. */
  receivedBaseQuantity: z.string(),
  invoicedBaseQuantity: z.string(),
});
export type LpoLine = z.infer<typeof lpoLineSchema>;

export const lpoSchema = z.strictObject({
  id: uuid,
  number: z.string(),
  project: projectRef,
  deliverySite: siteRef.nullable(),
  /** Snapshot of the supplier when the LPO was created. */
  supplier: supplierRef.extend({
    kraPinMasked: z.string().nullable(),
    etimsStatus: z.enum(ETIMS_STATUSES),
  }),
  status: z.enum(LPO_STATUSES),
  deliveryState: z.enum(LPO_DELIVERY_STATES),
  rfq: z.strictObject({ id: uuid, number: z.string() }),
  quotationId: uuid,
  replacesLpo: z.strictObject({ id: uuid, number: z.string() }).nullable(),
  deliveryDate: calendarDate.nullable(),
  terms: z.string().nullable(),
  creditDays: z.number().int(),
  vatRatePercent: z.string(),
  subtotalMinor: minor,
  vatMinor: minor,
  totalMinor: minor,
  version,
  createdAt: timestamp,
  createdBy: person,
  submittedAt: timestamp.nullable(),
  submittedBy: person.nullable(),
  approvedAt: timestamp.nullable(),
  approvedBy: person.nullable(),
  returnReason: z.string().nullable(),
  cancelledAt: timestamp.nullable(),
  cancelReason: z.string().nullable(),
});
export type Lpo = z.infer<typeof lpoSchema>;

const grnSummary = z.strictObject({
  id: uuid,
  number: z.string(),
  status: z.enum(GRN_STATUSES),
  receivedAt: timestamp,
  locationState: z.enum(GRN_LOCATION_STATES),
});
const invoiceSummary = z.strictObject({
  id: uuid,
  invoiceNumber: z.string(),
  status: z.enum(INVOICE_STATUSES),
  totalMinor: minor,
});

export const lpoListQuerySchema = z.object({
  projectId: uuid.optional(),
  status: z.enum(LPO_STATUSES).optional(),
  supplierId: uuid.optional(),
  cursor: uuid.optional(),
  limit: listLimit,
});
export const lposResponseSchema = z.strictObject({
  lpos: z.array(lpoSchema),
  page: pageInfoSchema,
});
export type LposResponse = z.infer<typeof lposResponseSchema>;

export const lpoDetailResponseSchema = z.strictObject({
  lpo: lpoSchema,
  lines: z.array(lpoLineSchema),
  grns: z.array(grnSummary),
  invoices: z.array(invoiceSummary),
  /** Net of VAT: approved LPO amount, approved invoices against it, and what is still open. */
  commitment: z.strictObject({
    committedMinor: minor,
    accruedMinor: minor,
    openMinor: minor,
  }),
  contributors: z.array(person),
  permissions: z.strictObject({
    canManage: z.boolean(),
    canApprove: z.boolean(),
    canReceive: z.boolean(),
    canInvoice: z.boolean(),
  }),
});
export type LpoDetailResponse = z.infer<typeof lpoDetailResponseSchema>;

// Goods Received Notes ------------------------------------------------------------------------

/** A vehicle registration; Kenyan formats are recognised, others kept and flagged. */
export const vehicleRegistrationSchema = z.string().transform((value, ctx) => {
  const reg = normaliseVehicleRegistration(value);
  if (!reg) {
    ctx.addIssue({ code: "custom", message: "invalid_vehicle_registration" });
    return z.NEVER;
  }
  return reg;
});

export const grnLineInputSchema = z
  .strictObject({
    lpoLineId: uuid,
    /** Defaults to the LPO line's unit. */
    unit: unitCodeSchema.nullable().default(null),
    receivedQuantity: quantitySchema,
    rejectedQuantity: quantitySchema.default("0"),
    rejectionReason: optionalText(300).optional(),
  })
  .superRefine((value, ctx) => {
    const rejected = Number(value.rejectedQuantity);
    if (rejected > Number(value.receivedQuantity))
      ctx.addIssue({
        code: "custom",
        path: ["rejectedQuantity"],
        message: "rejected_above_received",
      });
    if (rejected > 0 && !value.rejectionReason)
      ctx.addIssue({ code: "custom", path: ["rejectionReason"], message: "required" });
  });

/**
 * A GRN as the web page or the site app sends it. `id` is generated by the client so an offline
 * capture keeps its identity; the `Idempotency-Key` header makes a replay return the original
 * result (a changed payload under the same key is 409 idempotency-key-reused).
 */
export const createGrnRequestSchema = z
  .strictObject({
    id: uuid,
    lpoId: uuid,
    siteId: uuid.nullable().default(null),
    capturedAt: timestamp,
    receivedByName: text(2, 100),
    vehicleRegistration: vehicleRegistrationSchema,
    deliveryNoteNumber: optionalText(60).optional(),
    location: z
      .strictObject({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        accuracyM: z.number().min(0).max(100_000),
      })
      .nullable()
      .default(null),
    locationError: z.enum(LOCATION_ERRORS).nullable().default(null),
    notes: optionalText(1000, true).optional(),
    source: z.enum(GRN_SOURCES).default("web"),
    lines: z.array(grnLineInputSchema).min(1).max(P2P_LIMITS.linesPerDocument),
  })
  .superRefine((value, ctx) => {
    const ids = value.lines.map((line) => line.lpoLineId);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: "custom", path: ["lines"], message: "duplicate_line" });
    if (!value.lines.some((line) => /[1-9]/.test(line.receivedQuantity)))
      ctx.addIssue({ code: "custom", path: ["lines"], message: "nothing_received" });
  });
export type CreateGrnRequest = z.input<typeof createGrnRequestSchema>;
export type ParsedGrnRequest = z.infer<typeof createGrnRequestSchema>;

/** Idempotency keys: 8–100 visible ASCII characters (a UUID from the client is typical). */
export const idempotencyKeySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._:-]{8,100}$/, "invalid_idempotency_key");

export const grnLineSchema = z.strictObject({
  id: uuid,
  lineNo: z.number().int().min(1),
  lpoLineId: uuid,
  material: materialRef,
  unit: z.string(),
  receivedQuantity: z.string(),
  rejectedQuantity: z.string(),
  rejectionReason: z.string().nullable(),
  acceptedBaseQuantity: z.string(),
  /** Accepted beyond what the LPO line still expected (flagged, not refused). */
  overDelivery: z.boolean(),
});

export const grnSchema = z.strictObject({
  id: uuid,
  number: z.string(),
  project: projectRef,
  site: siteRef.nullable(),
  lpo: z.strictObject({ id: uuid, number: z.string() }),
  supplier: supplierRef,
  status: z.enum(GRN_STATUSES),
  /** The device's clock (a claim) and the server's receipt time (authoritative). */
  capturedAt: timestamp,
  receivedAt: timestamp,
  receivedByName: z.string(),
  recordedBy: person,
  vehicleRegistration: z.string(),
  vehicleRegistrationFormat: z.enum(VEHICLE_REG_FORMATS),
  deliveryNoteNumber: z.string().nullable(),
  location: z.strictObject({
    state: z.enum(GRN_LOCATION_STATES),
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
    accuracyM: z.number().nullable(),
    lowAccuracy: z.boolean(),
    error: z.enum(LOCATION_ERRORS).nullable(),
    geofenceVersion: z.number().int().nullable(),
  }),
  overDelivery: z.boolean(),
  source: z.enum(GRN_SOURCES),
  notes: z.string().nullable(),
  photos: z.array(procurementDocumentSchema),
  /** At least one delivery-note photo and one goods photo were uploaded. */
  evidenceComplete: z.boolean(),
  voidedAt: timestamp.nullable(),
  voidedBy: person.nullable(),
  voidReason: z.string().nullable(),
  lines: z.array(grnLineSchema),
});
export type Grn = z.infer<typeof grnSchema>;
export const grnResponseSchema = z.strictObject({
  grn: grnSchema,
  /** True when this response replays an earlier submission with the same idempotency key. */
  replayed: z.boolean(),
  permissions: z.strictObject({ canVoid: z.boolean(), canAddPhotos: z.boolean() }),
});
export type GrnResponse = z.infer<typeof grnResponseSchema>;

export const grnListQuerySchema = z.object({
  projectId: uuid.optional(),
  lpoId: uuid.optional(),
  cursor: uuid.optional(),
  limit: listLimit,
});
export const grnsResponseSchema = z.strictObject({
  grns: z.array(grnSchema.omit({ lines: true, photos: true })),
  page: pageInfoSchema,
});
export type GrnsResponse = z.infer<typeof grnsResponseSchema>;
export const grnPhotoQuerySchema = z.object({ kind: z.enum(GRN_PHOTO_KINDS) });
export const voidGrnRequestSchema = z.strictObject({ reason: text(3, 500) });

/** LPOs that can be received (approved, not cancelled) with what each line still expects. */
export const receivableLposResponseSchema = z.strictObject({
  lpos: z.array(
    z.strictObject({
      id: uuid,
      number: z.string(),
      project: projectRef,
      deliverySite: siteRef.nullable(),
      supplier: supplierRef,
      deliveryDate: calendarDate.nullable(),
      sites: z.array(siteRef),
      lines: z.array(
        z.strictObject({
          id: uuid,
          lineNo: z.number().int(),
          material: materialRef,
          quantity: z.string(),
          unit: z.string(),
          baseQuantity: z.string(),
          receivedBaseQuantity: z.string(),
        }),
      ),
    }),
  ),
});
export type ReceivableLposResponse = z.infer<typeof receivableLposResponseSchema>;

// Supplier invoices, the three-way match, payables and settlements ----------------------------

/** An eTIMS number on an invoice: normalised and classified by format (CR-TAX-02). */
export const etimsInvoiceNumberSchema = z.string().transform((value, ctx) => {
  const classified = classifyEtimsInvoiceNumber(value);
  if (!classified) {
    ctx.addIssue({ code: "custom", message: "invalid_etims_number" });
    return z.NEVER;
  }
  return classified;
});

export const invoiceLineInputSchema = z.strictObject({
  lpoLineId: uuid,
  quantity: positiveQuantitySchema,
  /** Defaults to the LPO line's unit. */
  unit: unitCodeSchema.nullable().default(null),
  unitPriceMinor: z.number().int().min(1).max(1_000_000_000_000),
  vatTreatment: z.enum(VAT_TREATMENTS),
});

const invoiceFields = {
  invoiceNumber: text(1, 60),
  invoiceDate: calendarDate,
  etimsInvoiceNumber: etimsInvoiceNumberSchema.nullable().default(null),
  subtotalMinor: minor,
  vatMinor: minor,
  totalMinor: positiveMinor,
  notes: optionalText(1000, true).optional(),
  lines: z.array(invoiceLineInputSchema).min(1).max(P2P_LIMITS.linesPerDocument),
};
const checkInvoice = (
  value: {
    subtotalMinor?: number;
    vatMinor?: number;
    totalMinor?: number;
    lines?: { lpoLineId: string }[];
  },
  ctx: z.RefinementCtx,
) => {
  if (
    value.subtotalMinor !== undefined &&
    value.vatMinor !== undefined &&
    value.totalMinor !== undefined &&
    value.subtotalMinor + value.vatMinor !== value.totalMinor
  )
    ctx.addIssue({ code: "custom", path: ["totalMinor"], message: "total_not_subtotal_plus_vat" });
  const ids = value.lines?.map((line) => line.lpoLineId) ?? [];
  if (new Set(ids).size !== ids.length)
    ctx.addIssue({ code: "custom", path: ["lines"], message: "duplicate_line" });
};

export const createInvoiceRequestSchema = z
  .strictObject({ lpoId: uuid, ...invoiceFields })
  .superRefine(checkInvoice);
export type CreateInvoiceRequest = z.input<typeof createInvoiceRequestSchema>;
export type ParsedCreateInvoiceRequest = z.infer<typeof createInvoiceRequestSchema>;

export const updateInvoiceRequestSchema = z
  .strictObject({
    version,
    invoiceNumber: invoiceFields.invoiceNumber.optional(),
    invoiceDate: calendarDate.optional(),
    etimsInvoiceNumber: etimsInvoiceNumberSchema.nullable().optional(),
    subtotalMinor: minor.optional(),
    vatMinor: minor.optional(),
    totalMinor: positiveMinor.optional(),
    notes: invoiceFields.notes,
    lines: invoiceFields.lines.optional(),
  })
  .superRefine(checkInvoice);
export type ParsedUpdateInvoiceRequest = z.infer<typeof updateInvoiceRequestSchema>;

/** Approval quotes the match and payee the approver saw (snapshot binding, brief §15 C/D). */
export const approveInvoiceRequestSchema = z.strictObject({
  version,
  matchId: uuid,
  payoutVersionId: uuid,
});
export type ApproveInvoiceRequest = z.infer<typeof approveInvoiceRequestSchema>;

export const matchExceptionRequestSchema = z.strictObject({
  version,
  matchId: uuid,
  reason: text(3, 500),
});

export const recordSettlementRequestSchema = z.strictObject({
  method: z.enum(SETTLEMENT_METHODS),
  externalReference: text(3, 60).refine(
    (value) => /^[A-Za-z0-9][A-Za-z0-9 ./_-]*$/.test(value),
    "invalid_reference",
  ),
  amountMinor: positiveMinor,
  paidOn: calendarDate,
  note: optionalText(500).optional(),
});
export type RecordSettlementRequest = z.infer<typeof recordSettlementRequestSchema>;

export const invoiceLineSchema = z.strictObject({
  id: uuid,
  lineNo: z.number().int().min(1),
  lpoLineId: uuid,
  material: materialRef,
  quantity: z.string(),
  unit: z.string(),
  baseQuantity: z.string(),
  unitPriceMinor: z.number().int().positive(),
  vatTreatment: z.enum(VAT_TREATMENTS),
  netUnitPriceBaseMinor: z.string(),
  netAmountMinor: minor,
});
export type InvoiceLine = z.infer<typeof invoiceLineSchema>;

export const invoiceSchema = z.strictObject({
  id: uuid,
  project: projectRef,
  lpo: z.strictObject({ id: uuid, number: z.string() }),
  supplier: supplierRef.extend({ etimsStatus: z.enum(ETIMS_STATUSES) }),
  invoiceNumber: z.string(),
  invoiceDate: calendarDate,
  dueDate: calendarDate,
  etimsInvoiceNumber: z.string().nullable(),
  etimsFormat: z.enum(ETIMS_NUMBER_FORMATS).nullable(),
  status: z.enum(INVOICE_STATUSES),
  /** Increments with every content change; matches and approvals bind to it. */
  contentVersion: z.number().int().min(1),
  vatRatePercent: z.string(),
  subtotalMinor: minor,
  vatMinor: minor,
  totalMinor: minor,
  computedSubtotalMinor: minor,
  computedVatMinor: minor,
  settledMinor: minor,
  outstandingMinor: minor,
  notes: z.string().nullable(),
  version,
  createdAt: timestamp,
  createdBy: person,
  submittedAt: timestamp.nullable(),
  submittedBy: person.nullable(),
  cancelledAt: timestamp.nullable(),
  cancelReason: z.string().nullable(),
});
export type Invoice = z.infer<typeof invoiceSchema>;

export const matchLineSchema = z.strictObject({
  lpoLineId: z.string(),
  lineNo: z.number().int().min(0),
  material: materialRef.nullable(),
  orderedQuantity: z.string(),
  receivedQuantity: z.string(),
  previouslyInvoicedQuantity: z.string(),
  invoicedQuantity: z.string(),
  cumulativeQuantity: z.string(),
  allowedQuantity: z.string(),
  orderNetUnitPriceMinor: z.string(),
  invoiceNetUnitPriceMinor: z.string().nullable(),
  allowedNetUnitPriceMinor: z.string(),
  reasons: z.array(z.enum(MATCH_LINE_REASONS)),
  warnings: z.array(z.enum(MATCH_WARNINGS)),
});

export const threeWayMatchSchema = z.strictObject({
  id: uuid,
  outcome: z.enum(MATCH_OUTCOMES),
  /** Matched, or a mismatch with an approved exception: the invoice may be approved. */
  passing: z.boolean(),
  /** The match still describes the invoice, its GRNs, other invoices and the settings. */
  current: z.boolean(),
  staleReasons: z.array(z.enum(MATCH_STALE_REASONS)),
  reasons: z.array(z.enum([...MATCH_HEADER_REASONS, ...MATCH_LINE_REASONS])),
  headerReasons: z.array(z.enum(MATCH_HEADER_REASONS)),
  warnings: z.array(z.enum(MATCH_WARNINGS)),
  exceptable: z.boolean(),
  lines: z.array(matchLineSchema),
  totals: z.strictObject({
    statedSubtotalMinor: minor,
    computedSubtotalMinor: minor,
    statedVatMinor: minor,
    computedVatMinor: minor,
    statedTotalMinor: minor,
    computedTotalMinor: minor,
    roundingAllowanceMinor: minor,
    orderSubtotalMinor: minor,
    previouslyInvoicedSubtotalMinor: minor,
    allowedSubtotalMinor: minor,
  }),
  tolerances: z.strictObject({
    qtyPercent: z.string(),
    pricePercent: z.string(),
    blockWithoutEtims: z.boolean(),
  }),
  invoiceContentVersion: z.number().int().min(1),
  grnCount: z.number().int().min(0),
  computedAt: timestamp,
  computedBy: person,
  exception: z
    .strictObject({ reason: z.string(), approvedAt: timestamp, approvedBy: person })
    .nullable(),
});
export type ThreeWayMatchWire = z.infer<typeof threeWayMatchSchema>;

const payoutSummary = z.strictObject({
  id: uuid,
  versionNo: z.number().int().min(1),
  status: z.enum(PAYOUT_STATUSES),
  mpesaKind: z.enum(MPESA_PAYOUT_KINDS),
  paybillNumber: z.string().nullable(),
  accountReference: z.string().nullable(),
  tillNumber: z.string().nullable(),
  bank: z.strictObject({ bankName: z.string(), accountNumberMasked: z.string() }).nullable(),
});
export type PayoutSummary = z.infer<typeof payoutSummary>;

/**
 * A payable: the approval snapshot of an invoice (content version, match and the verified payee
 * version) with the amount authorised. D4.2/D4.3 payment attempts will settle payables; today
 * settlements are recorded by hand. `current` is false once the payee's details change (the
 * D5.1 version is superseded): settlement is refused until someone re-approves.
 */
export const payableSchema = z.strictObject({
  id: uuid,
  status: z.enum(PAYABLE_STATUSES),
  current: z.boolean(),
  authorisedMinor: minor,
  settledMinor: minor,
  outstandingMinor: minor,
  invoiceContentVersion: z.number().int().min(1),
  matchId: uuid,
  payout: payoutSummary,
  approvedAt: timestamp,
  approvedBy: person,
});
export type Payable = z.infer<typeof payableSchema>;

export const settlementSchema = z.strictObject({
  id: uuid,
  payableId: uuid,
  method: z.enum(SETTLEMENT_METHODS),
  externalReference: z.string(),
  amountMinor: positiveMinor,
  paidOn: calendarDate,
  note: z.string().nullable(),
  recordedAt: timestamp,
  recordedBy: person,
});
export type Settlement = z.infer<typeof settlementSchema>;

export const invoiceListQuerySchema = z.object({
  projectId: uuid.optional(),
  lpoId: uuid.optional(),
  supplierId: uuid.optional(),
  status: z.enum(INVOICE_STATUSES).optional(),
  cursor: uuid.optional(),
  limit: listLimit,
});
export const invoicesResponseSchema = z.strictObject({
  invoices: z.array(invoiceSchema),
  page: pageInfoSchema,
  permissions: z.strictObject({ canRecord: z.boolean() }),
});
export type InvoicesResponse = z.infer<typeof invoicesResponseSchema>;

export const invoiceDetailResponseSchema = z.strictObject({
  invoice: invoiceSchema,
  lines: z.array(invoiceLineSchema),
  match: threeWayMatchSchema.nullable(),
  payable: payableSchema.nullable(),
  payables: z.array(payableSchema),
  settlements: z.array(settlementSchema),
  /** The supplier's verified payout version now in force (null: none, or not yet verified). */
  payee: payoutSummary.nullable(),
  documents: z.array(procurementDocumentSchema),
  contributors: z.array(person),
  permissions: z.strictObject({
    canEdit: z.boolean(),
    canApprove: z.boolean(),
    canApproveException: z.boolean(),
    canSettle: z.boolean(),
  }),
});
export type InvoiceDetailResponse = z.infer<typeof invoiceDetailResponseSchema>;

// Inbox and commitments ----------------------------------------------------------------------

export const inboxItemSchema = z.strictObject({
  kind: z.enum(INBOX_KINDS),
  id: uuid,
  label: z.string(),
  project: projectRef,
  supplier: supplierRef.nullable(),
  amountMinor: minor.nullable(),
  since: timestamp,
  href: z.string(),
});
export type InboxItem = z.infer<typeof inboxItemSchema>;
export const inboxResponseSchema = z.strictObject({ items: z.array(inboxItemSchema) });
export type InboxResponse = z.infer<typeof inboxResponseSchema>;

export const commitmentsQuerySchema = z.object({ projectId: uuid });
/** Net of VAT: committed (approved LPOs), accrued (approved invoices), paid (settlements, gross). */
export const commitmentsResponseSchema = z.strictObject({
  project: projectRef,
  totals: z.strictObject({
    committedMinor: minor,
    accruedMinor: minor,
    openCommitmentMinor: minor,
    paidMinor: minor,
  }),
  items: z.array(
    z.strictObject({
      bqItem: bqItemRef.nullable(),
      committedMinor: minor,
      accruedMinor: minor,
      openCommitmentMinor: minor,
    }),
  ),
});
export type CommitmentsResponse = z.infer<typeof commitmentsResponseSchema>;
