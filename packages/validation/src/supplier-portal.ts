import { normalizeKenyanPhone } from "@pm-buddy/domain";
import {
  ETIMS_NUMBER_FORMATS,
  GRN_STATUSES,
  INVOICE_SOURCES,
  LOCALES,
  LPO_DELIVERY_STATES,
  MATCH_HEADER_REASONS,
  MATCH_LINE_REASONS,
  PROCUREMENT_DOCUMENT_TYPES,
  SETTLEMENT_METHODS,
  STATEMENT_ENTRY_KINDS,
  SUPPLIER_INVOICE_STATUSES,
  SUPPLIER_PORTAL_LIMITS,
  SUPPLIER_PORTAL_REVOKE_CAUSES,
  SUPPLIER_PORTAL_USER_STATUSES,
  VAT_TREATMENTS,
} from "@pm-buddy/types";
import { z } from "zod";
import { pageInfoSchema } from "./api.js";
import { planningDateSchema } from "./primitives.js";
import { checkInvoice, etimsInvoiceNumberSchema, invoiceFields } from "./procure-to-pay.js";

/**
 * D7.2 supplier portal contracts. Staff invite, list and revoke a supplier's portal users; a
 * portal user sees only their own supplier's approved LPOs, deliveries, invoices, recorded
 * payments and statements, and submits invoices into the same procure-to-pay workflow staff use.
 * Responses are curated (never internal notes, photos, people's names other than the portal
 * user's own, payee details or other suppliers' prices) and strict. Money is KES minor units.
 */

const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
const calendarDate = z.iso.date();
const version = z.number().int().min(1).max(2_147_483_647);
const person = z.strictObject({ id: uuid, displayName: z.string() });
const minor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const signedMinor = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const listLimit = z.coerce.number().int().min(1).max(200).default(SUPPLIER_PORTAL_LIMITS.pageSize);
function printable(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || (code >= 127 && code <= 159)) return false;
  }
  return true;
}
const text = (min: number, max: number) =>
  z.string().trim().min(min).max(max).refine(printable, "control_characters");

// Staff: the supplier's portal users ---------------------------------------------------------

/** An email address (lower-cased) or a Kenyan mobile number (normalised to 2547…/2541…). */
export const portalUserIdentifierSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .transform((value, ctx) => {
    if (value.includes("@")) {
      const email = z.email().safeParse(value.toLowerCase());
      if (email.success) return email.data;
    } else {
      const phone = normalizeKenyanPhone(value);
      if (phone) return phone;
    }
    ctx.addIssue({ code: "custom", message: "invalid_identifier" });
    return z.NEVER;
  });

export const invitePortalUserRequestSchema = z.strictObject({
  identifier: portalUserIdentifierSchema,
  contactName: text(2, 100),
});
export type InvitePortalUserRequest = z.input<typeof invitePortalUserRequestSchema>;

export const revokePortalUserRequestSchema = z.strictObject({ version, reason: text(3, 500) });
export type RevokePortalUserRequest = z.infer<typeof revokePortalUserRequestSchema>;

export const supplierPortalUserSchema = z.strictObject({
  id: uuid,
  supplierId: uuid,
  contactName: z.string(),
  /** The email address or phone number invited (staff with the manage permission only). */
  identifier: z.string(),
  status: z.enum(SUPPLIER_PORTAL_USER_STATUSES),
  version,
  invitedAt: timestamp,
  invitedBy: person,
  /** When an invitation not yet accepted stops working. */
  invitationExpiresAt: timestamp.nullable(),
  activatedAt: timestamp.nullable(),
  account: person.nullable(),
  revokedAt: timestamp.nullable(),
  revokedBy: person.nullable(),
  revokeCause: z.enum(SUPPLIER_PORTAL_REVOKE_CAUSES).nullable(),
  revokeReason: z.string().nullable(),
  submittedInvoices: z.number().int().min(0),
});
export type SupplierPortalUser = z.infer<typeof supplierPortalUserSchema>;

export const supplierPortalUsersResponseSchema = z.strictObject({
  supplier: z.strictObject({ id: uuid, code: z.string(), name: z.string() }),
  users: z.array(supplierPortalUserSchema),
  permissions: z.strictObject({ canInvite: z.boolean(), canRevoke: z.boolean() }),
});
export type SupplierPortalUsersResponse = z.infer<typeof supplierPortalUsersResponseSchema>;

export const supplierPortalUserResponseSchema = z.strictObject({ user: supplierPortalUserSchema });

// The supplier's side ------------------------------------------------------------------------

const projectRef = z.strictObject({ id: uuid, code: z.string(), name: z.string() });
const materialRef = z.strictObject({ code: z.string(), name: z.string(), baseUnit: z.string() });
const acknowledgementSchema = z
  .strictObject({ acknowledgedAt: timestamp, acknowledgedBy: person })
  .nullable();

export const supplierPortalOverviewResponseSchema = z.strictObject({
  company: z.strictObject({ id: uuid, name: z.string() }),
  supplier: z.strictObject({ id: uuid, code: z.string(), name: z.string() }),
  displayName: z.string(),
  /** Projects with at least one approved LPO to this supplier (for filters). */
  projects: z.array(projectRef),
  counts: z.strictObject({
    openLpos: z.number().int().min(0),
    unacknowledgedLpos: z.number().int().min(0),
    deliveries: z.number().int().min(0),
    invoicesUnderReview: z.number().int().min(0),
    invoicesDisputed: z.number().int().min(0),
    invoicesAwaitingPayment: z.number().int().min(0),
  }),
  /** Approved invoices less the payments the company recorded (incl. VAT). */
  outstandingMinor: minor,
  permissions: z.strictObject({ canSubmitInvoices: z.boolean() }),
});
export type SupplierPortalOverview = z.infer<typeof supplierPortalOverviewResponseSchema>;

export const portalLpoSchema = z.strictObject({
  id: uuid,
  number: z.string(),
  project: projectRef,
  deliverySite: z
    .strictObject({ id: uuid, name: z.string(), address: z.string().nullable() })
    .nullable(),
  deliveryDate: calendarDate.nullable(),
  /** Only approved LPOs reach the portal; a later cancellation (amendment) shows as cancelled. */
  status: z.enum(["approved", "cancelled"]),
  deliveryState: z.enum(LPO_DELIVERY_STATES),
  approvedAt: timestamp,
  cancelledAt: timestamp.nullable(),
  creditDays: z.number().int(),
  vatRatePercent: z.string(),
  subtotalMinor: minor,
  vatMinor: minor,
  totalMinor: minor,
  acknowledgement: acknowledgementSchema,
});
export type PortalLpo = z.infer<typeof portalLpoSchema>;

export const portalLposQuerySchema = z.object({
  projectId: uuid.optional(),
  status: z.enum(["approved", "cancelled"]).optional(),
  cursor: uuid.optional(),
  limit: listLimit,
});
export const portalLposResponseSchema = z.strictObject({
  lpos: z.array(portalLpoSchema),
  page: pageInfoSchema,
});
export type PortalLposResponse = z.infer<typeof portalLposResponseSchema>;

export const portalLpoLineSchema = z.strictObject({
  id: uuid,
  lineNo: z.number().int().min(1),
  material: materialRef,
  quantity: z.string(),
  unit: z.string(),
  baseQuantity: z.string(),
  priceUnit: z.string(),
  unitPriceMinor: z.number().int().positive(),
  vatTreatment: z.enum(VAT_TREATMENTS),
  /** The ordered price net of VAT per base unit (six places), as the three-way match uses it. */
  netUnitPriceBaseMinor: z.string(),
  netAmountMinor: minor,
  /** In the material's base unit: accepted on recorded deliveries, on approved invoices, on
   * invoices still under review, and what can still be invoiced (accepted − both). */
  receivedBaseQuantity: z.string(),
  invoicedBaseQuantity: z.string(),
  pendingBaseQuantity: z.string(),
  invoiceableBaseQuantity: z.string(),
});
export type PortalLpoLine = z.infer<typeof portalLpoLineSchema>;

export const portalDeliveryLineSchema = z.strictObject({
  lineNo: z.number().int().min(1),
  lpoLineId: uuid,
  material: materialRef,
  unit: z.string(),
  receivedQuantity: z.string(),
  rejectedQuantity: z.string(),
  rejectionReason: z.string().nullable(),
  acceptedBaseQuantity: z.string(),
});

export const portalDeliverySchema = z.strictObject({
  id: uuid,
  number: z.string(),
  lpo: z.strictObject({ id: uuid, number: z.string() }),
  project: projectRef,
  site: z.strictObject({ id: uuid, name: z.string() }).nullable(),
  status: z.enum(GRN_STATUSES),
  /** The server's receipt time (authoritative), not the device's clock. */
  receivedAt: timestamp,
  deliveryNoteNumber: z.string().nullable(),
  vehicleRegistration: z.string(),
  lines: z.array(portalDeliveryLineSchema),
});
export type PortalDelivery = z.infer<typeof portalDeliverySchema>;

export const portalDeliveriesQuerySchema = z.object({
  projectId: uuid.optional(),
  lpoId: uuid.optional(),
  cursor: uuid.optional(),
  limit: listLimit,
});
export const portalDeliveriesResponseSchema = z.strictObject({
  deliveries: z.array(portalDeliverySchema),
  page: pageInfoSchema,
});
export type PortalDeliveriesResponse = z.infer<typeof portalDeliveriesResponseSchema>;

export const portalInvoiceSchema = z.strictObject({
  id: uuid,
  invoiceNumber: z.string(),
  invoiceDate: calendarDate,
  dueDate: calendarDate,
  lpo: z.strictObject({ id: uuid, number: z.string() }),
  project: projectRef,
  etimsInvoiceNumber: z.string().nullable(),
  etimsFormat: z.enum(ETIMS_NUMBER_FORMATS).nullable(),
  status: z.enum(SUPPLIER_INVOICE_STATUSES),
  source: z.enum(INVOICE_SOURCES),
  subtotalMinor: minor,
  vatMinor: minor,
  totalMinor: minor,
  /** Recorded by the company; the portal never confirms a payment (brief §15 D). */
  paidMinor: minor,
  outstandingMinor: minor,
  /** Approved, not fully paid and past its due date (Nairobi business days). */
  overdue: z.boolean(),
  submittedAt: timestamp.nullable(),
});
export type PortalInvoice = z.infer<typeof portalInvoiceSchema>;

export const portalInvoicesQuerySchema = z.object({
  projectId: uuid.optional(),
  lpoId: uuid.optional(),
  status: z.enum(SUPPLIER_INVOICE_STATUSES).optional(),
  cursor: uuid.optional(),
  limit: listLimit,
});
export const portalInvoicesResponseSchema = z.strictObject({
  invoices: z.array(portalInvoiceSchema),
  page: pageInfoSchema,
  permissions: z.strictObject({ canSubmit: z.boolean() }),
});
export type PortalInvoicesResponse = z.infer<typeof portalInvoicesResponseSchema>;

export const portalLpoDetailResponseSchema = z.strictObject({
  lpo: portalLpoSchema,
  terms: z.string().nullable(),
  lines: z.array(portalLpoLineSchema),
  deliveries: z.array(portalDeliverySchema.omit({ lines: true })),
  invoices: z.array(portalInvoiceSchema),
  permissions: z.strictObject({ canAcknowledge: z.boolean(), canInvoice: z.boolean() }),
});
export type PortalLpoDetailResponse = z.infer<typeof portalLpoDetailResponseSchema>;

export const portalDocumentSchema = z.strictObject({
  id: uuid,
  contentType: z.enum(PROCUREMENT_DOCUMENT_TYPES),
  sizeBytes: z.number().int().min(1),
  scanStatus: z.enum(["clean", "not_scanned"]),
  uploadedAt: timestamp,
  /** Uploaded through the portal (else attached by the company's staff). */
  uploadedBySupplier: z.boolean(),
});
export const portalDocumentResponseSchema = z.strictObject({ document: portalDocumentSchema });

const matchReason = z.enum([...MATCH_HEADER_REASONS, ...MATCH_LINE_REASONS]);

export const portalInvoiceDetailResponseSchema = z.strictObject({
  invoice: portalInvoiceSchema,
  lines: z.array(
    z.strictObject({
      lineNo: z.number().int().min(1),
      lpoLineId: uuid,
      material: materialRef,
      quantity: z.string(),
      unit: z.string(),
      unitPriceMinor: z.number().int().positive(),
      vatTreatment: z.enum(VAT_TREATMENTS),
      netAmountMinor: minor,
    }),
  ),
  /** Why the three-way match did not pass (codes; the company's own notes stay internal). */
  dispute: z
    .strictObject({
      reasons: z.array(matchReason),
      lines: z.array(z.strictObject({ lineNo: z.number().int(), reasons: z.array(matchReason) })),
    })
    .nullable(),
  payments: z.array(
    z.strictObject({
      id: uuid,
      amountMinor: z.number().int().positive(),
      paidOn: calendarDate,
      method: z.enum(SETTLEMENT_METHODS),
      reference: z.string(),
    }),
  ),
  documents: z.array(portalDocumentSchema),
  /** True when this response replays an earlier submission with the same idempotency key. */
  replayed: z.boolean(),
  permissions: z.strictObject({ canAttach: z.boolean() }),
});
export type PortalInvoiceDetailResponse = z.infer<typeof portalInvoiceDetailResponseSchema>;

/**
 * An invoice as the supplier submits it. `id` is generated by the client so a retried or
 * offline submission keeps its identity; the `Idempotency-Key` header makes a replay return the
 * original (a changed payload under the same key is 409 idempotency-key-reused). The eTIMS
 * number is required in the portal and classified as in D5.2.
 */
export const submitSupplierInvoiceRequestSchema = z
  .strictObject({
    id: uuid,
    lpoId: uuid,
    ...invoiceFields,
    invoiceDate: planningDateSchema,
    etimsInvoiceNumber: etimsInvoiceNumberSchema,
  })
  .superRefine(checkInvoice);
export type SubmitSupplierInvoiceRequest = z.input<typeof submitSupplierInvoiceRequestSchema>;
export type ParsedSupplierInvoiceRequest = z.infer<typeof submitSupplierInvoiceRequestSchema>;

export const supplierStatementQuerySchema = z.object({
  projectId: uuid.optional(),
  from: planningDateSchema.optional(),
  to: planningDateSchema.optional(),
});
export const supplierStatementExportQuerySchema = supplierStatementQuerySchema.extend({
  locale: z.enum(LOCALES).default("en"),
});

export const supplierStatementResponseSchema = z.strictObject({
  company: z.strictObject({ id: uuid, name: z.string() }),
  supplier: z.strictObject({ id: uuid, code: z.string(), name: z.string() }),
  /** One project, or null for every project of the company. */
  project: projectRef.nullable(),
  from: calendarDate,
  to: calendarDate,
  generatedAt: timestamp,
  openingMinor: signedMinor,
  invoicedMinor: minor,
  paidMinor: minor,
  closingMinor: signedMinor,
  entries: z.array(
    z.strictObject({
      kind: z.enum(STATEMENT_ENTRY_KINDS),
      date: calendarDate,
      invoiceId: uuid,
      invoiceNumber: z.string(),
      method: z.enum(SETTLEMENT_METHODS).nullable(),
      reference: z.string().nullable(),
      debitMinor: minor,
      creditMinor: minor,
      balanceMinor: signedMinor,
    }),
  ),
  /** Accepted invoices not fully paid today, whatever their date. */
  outstanding: z.array(
    z.strictObject({
      invoiceId: uuid,
      invoiceNumber: z.string(),
      project: projectRef,
      invoiceDate: calendarDate,
      dueDate: calendarDate,
      totalMinor: minor,
      paidMinor: minor,
      outstandingMinor: minor,
      overdue: z.boolean(),
    }),
  ),
  /** Invoices the company has not accepted (yet): not on the balance. */
  notAccepted: z.array(
    z.strictObject({
      invoiceId: uuid,
      invoiceNumber: z.string(),
      invoiceDate: calendarDate,
      totalMinor: minor,
      status: z.enum(SUPPLIER_INVOICE_STATUSES),
    }),
  ),
});
export type SupplierStatementResponse = z.infer<typeof supplierStatementResponseSchema>;
