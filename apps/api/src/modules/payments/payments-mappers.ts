import { maskPhone } from "@pm-buddy/domain";
import {
  callbackPathSegment,
  CALLBACK_KINDS,
  ENABLED_PAYMENT_ENVIRONMENTS,
  PAYMENT_SECRET_FIELDS,
  type PaymentReasonCode,
} from "@pm-buddy/types";
import type {
  BalanceCheck,
  PaymentAttempt as WireAttempt,
  PaymentCallback,
  PaymentEvent as WireEvent,
  PaymentRequestSummary,
  PaymentSettings as WireSettings,
  ProviderQuery as WireQuery,
  ProviderTransaction as WireTransaction,
  ReconciliationCase,
} from "@pm-buddy/validation";
import type {
  PaymentAttempt,
  PaymentCallbackInbox,
  PaymentCase,
  PaymentEvent,
  PaymentRequest,
  PaymentSettings,
  Prisma,
  ProviderQuery,
  ProviderTransaction,
} from "../../generated/prisma/client.js";
import { minor, PAYMENTS_SYSTEM_ACTOR } from "./payments-support.js";

export type Names = ReadonlyMap<string, string>;
const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null);
const actor = (names: Names, id: string | null | undefined) =>
  id && id !== PAYMENTS_SYSTEM_ACTOR ? { id, displayName: names.get(id) ?? "—" } : null;

export function settingsToWire(
  row: PaymentSettings,
  names: Names,
  callbackUrls: { kind: (typeof CALLBACK_KINDS)[number]; url: string }[],
  warnings: string[],
  extras: {
    callbackTokenRotatedAt: Date | null;
    ipAllowlistEnabled: boolean;
    certificateConfigured: boolean;
  },
): WireSettings {
  const secret = (enc: Uint8Array | null, at: Date | null) => ({
    configured: Boolean(enc),
    updatedAt: iso(at),
  });
  const secrets = {
    consumerKey: secret(row.consumerKeyEnc, row.consumerKeySetAt),
    consumerSecret: secret(row.consumerSecretEnc, row.consumerSecretSetAt),
    initiatorName: secret(row.initiatorNameEnc, row.initiatorNameSetAt),
    initiatorPassword: secret(row.initiatorPasswordEnc, row.initiatorPasswordSetAt),
    passkey: secret(row.passkeyEnc, row.passkeySetAt),
  } satisfies Record<(typeof PAYMENT_SECRET_FIELDS)[number], unknown>;
  return {
    environment: row.environment as WireSettings["environment"],
    availableEnvironments: [...ENABLED_PAYMENT_ENVIRONMENTS],
    productionEnabled: false,
    payoutsEnabled: row.payoutsEnabled,
    payoutsChangedAt: iso(row.payoutsChangedAt),
    payoutsChangedBy: actor(names, row.payoutsChangedBy),
    shortcodes: {
      stkShortcode: row.stkShortcode,
      stkPartyB: row.stkPartyB,
      stkTransactionType:
        row.stkTransactionType as WireSettings["shortcodes"]["stkTransactionType"],
      c2bShortcode: row.c2bShortcode,
      b2cShortcode: row.b2cShortcode,
      b2bShortcode: row.b2bShortcode,
    },
    limits: {
      stkMaxMinor: minor(row.stkMaxMinor),
      b2cMinMinor: minor(row.b2cMinMinor),
      b2cMaxMinor: minor(row.b2cMaxMinor),
      b2bMaxMinor: minor(row.b2bMaxMinor),
      dailyPayoutMaxMinor: minor(row.dailyPayoutMaxMinor),
    },
    limitsStatus: row.limitsStatus as "demo" | "reviewed",
    secrets,
    credentialsUpdatedAt: iso(row.credentialsUpdatedAt),
    credentialsUpdatedBy: actor(names, row.credentialsUpdatedBy),
    callbackUrls,
    callbackUrlWarnings: warnings,
    callbackTokenRotatedAt: iso(extras.callbackTokenRotatedAt),
    ipAllowlistEnabled: extras.ipAllowlistEnabled,
    certificateConfigured: extras.certificateConfigured,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const callbackUrlList = (url: (segment: string) => string) =>
  CALLBACK_KINDS.map((kind) => ({ kind, url: url(callbackPathSegment(kind)) }));

export function attemptToWire(row: PaymentAttempt): WireAttempt {
  return {
    id: row.id,
    sequence: row.sequence,
    kind: row.kind as WireAttempt["kind"],
    direction: row.direction as WireAttempt["direction"],
    status: row.status as WireAttempt["status"],
    version: row.version,
    amountMinor: minor(row.amountMinor),
    currency: "KES",
    environment: row.environment as WireAttempt["environment"],
    shortcode: row.shortcode,
    providerIds: {
      merchantRequestId: row.merchantRequestId,
      checkoutRequestId: row.checkoutRequestId,
      originatorConversationId: row.originatorConversationId,
      conversationId: row.conversationId,
    },
    receipt: row.receipt,
    resultCode: row.resultCode,
    resultDesc: row.resultDesc,
    reason: (row.reason as PaymentReasonCode | null) ?? null,
    reversesAttemptId: row.reversesAttemptId,
    statusQueries: row.statusQueries,
    createdAt: row.createdAt.toISOString(),
    submittedAt: iso(row.submittedAt),
    acceptedAt: iso(row.acceptedAt),
    finalizedAt: iso(row.finalizedAt),
  };
}

export function requestToWire(
  row: PaymentRequest,
  latest: PaymentAttempt | null,
  names: Names,
): PaymentRequestSummary {
  return {
    id: row.id,
    reference: row.reference,
    kind: row.kind as PaymentRequestSummary["kind"],
    direction: row.direction as PaymentRequestSummary["direction"],
    purpose: row.purpose as PaymentRequestSummary["purpose"],
    status: row.status as PaymentRequestSummary["status"],
    amountMinor: minor(row.amountMinor),
    currency: "KES",
    // Phone numbers leave the API masked only; B2B shows the receiving shortcode.
    counterparty: row.msisdnMasked ?? row.partyB ?? "—",
    accountReference: row.accountReference,
    description: row.description,
    environment: row.environment as PaymentRequestSummary["environment"],
    projectId: row.projectId,
    createdAt: row.createdAt.toISOString(),
    createdBy: actor(names, row.createdBy),
    latestAttempt: latest ? attemptToWire(latest) : null,
    version: row.version,
  };
}

export const maskedMsisdn = (msisdn: string) => maskPhone(msisdn);

const scalar = (value: unknown): string | number | boolean | null =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : null;

export function eventToWire(row: PaymentEvent, names: Names): WireEvent {
  const detail = Object.fromEntries(
    Object.entries((row.detail as Prisma.JsonObject | null) ?? {}).map(([key, value]) => [
      key,
      scalar(value),
    ]),
  );
  return {
    id: row.id,
    at: row.createdAt.toISOString(),
    subjectType: row.subjectType as WireEvent["subjectType"],
    subjectId: row.subjectId,
    event: row.event,
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    reason: row.reason,
    actor: actor(names, row.actorId),
    detail,
  };
}

export function callbackToWire(
  row: PaymentCallbackInbox,
  requestId: string | null,
  names: Names,
): PaymentCallback {
  return {
    id: row.id,
    kind: row.kind as PaymentCallback["kind"],
    status: row.status as PaymentCallback["status"],
    receivedAt: row.receivedAt.toISOString(),
    processedAt: iso(row.processedAt),
    quarantineReason: (row.quarantineReason as PaymentCallback["quarantineReason"]) ?? null,
    requestId,
    attemptId: row.attemptId,
    bodySha256: row.bodySha256,
    bodyBytes: row.bodyBytes,
    duplicates: row.duplicates,
    redactedBody: row.redactedBody,
    review:
      row.reviewDecision && row.reviewedAt
        ? {
            decision: row.reviewDecision as "resolved" | "dismissed",
            reason: row.reviewReason ?? "",
            by: actor(names, row.reviewedBy),
            at: row.reviewedAt.toISOString(),
          }
        : null,
    version: row.version,
  };
}

export function caseToWire(
  row: PaymentCase,
  attempt: PaymentAttempt | null,
  names: Names,
  canResolve: boolean,
): ReconciliationCase {
  return {
    id: row.id,
    kind: row.kind as ReconciliationCase["kind"],
    status: row.status as ReconciliationCase["status"],
    openedAt: row.openedAt.toISOString(),
    reason: row.reason,
    requestId: row.requestId ?? attempt?.requestId ?? null,
    attemptId: row.attemptId,
    callbackId: row.callbackId,
    attemptStatus: (attempt?.status as ReconciliationCase["attemptStatus"]) ?? null,
    amountMinor: attempt ? minor(attempt.amountMinor) : null,
    owner: row.owner,
    resolution: (row.resolution as ReconciliationCase["resolution"]) ?? null,
    resolutionNote: row.resolutionNote,
    resolvedAt: iso(row.resolvedAt),
    resolvedBy: actor(names, row.resolvedBy),
    canResolve: canResolve && row.status === "open",
    version: row.version,
  };
}

export function queryToWire(row: ProviderQuery): WireQuery {
  return {
    id: row.id,
    kind: row.kind as WireQuery["kind"],
    status: row.status as WireQuery["status"],
    attemptId: row.attemptId,
    resultCode: row.resultCode,
    summary: row.summary,
    createdAt: row.createdAt.toISOString(),
    answeredAt: iso(row.answeredAt),
  };
}

export function balanceToWire(row: ProviderQuery): BalanceCheck {
  const balances = Array.isArray(row.balances)
    ? (row.balances as { account?: unknown; currency?: unknown; availableMinor?: unknown }[]).map(
        (entry) => ({
          account: String(entry.account ?? ""),
          currency: String(entry.currency ?? ""),
          availableMinor: typeof entry.availableMinor === "number" ? entry.availableMinor : null,
        }),
      )
    : null;
  return {
    id: row.id,
    status: row.status as BalanceCheck["status"],
    requestedAt: row.createdAt.toISOString(),
    answeredAt: iso(row.answeredAt),
    balances,
  };
}

export function transactionToWire(row: ProviderTransaction): WireTransaction {
  return {
    id: row.id,
    kind: row.kind as WireTransaction["kind"],
    direction: row.direction as WireTransaction["direction"],
    status: row.status as WireTransaction["status"],
    receipt: row.receipt,
    amountMinor: minor(row.amountMinor),
    currency: "KES",
    shortcode: row.shortcode,
    accountReference: row.accountReference,
    attemptId: row.attemptId,
    callbackId: row.callbackId,
    recordedAt: row.recordedAt.toISOString(),
  };
}
