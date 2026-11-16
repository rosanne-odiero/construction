import type { ParseResult, SubmissionTransport } from "@pm-buddy/domain";
import type {
  B2cCommand,
  CallbackKind,
  PaymentAttemptKind,
  PaymentEnvironment,
  StkTransactionType,
} from "@pm-buddy/types";

/**
 * Provider-neutral payment interface (brief §5.7, ARCHITECTURE §4.5). Every outgoing call is two
 * steps: `prepare*` does all pre-flight work that may fail safely (credentials, certificate,
 * access token, request body) without any state change, then `send` makes the single HTTP call
 * whose acceptance may be uncertain. Results are asynchronous: nothing here ever reports a
 * payment as settled; callbacks and status answers are parsed into evidence for verification.
 */

/** A company's provider account as the worker sees it (secrets decrypted only in memory). */
export type ProviderAccount = {
  tenantId: string;
  environment: PaymentEnvironment;
  credentialsVersion: number;
  credentials: {
    consumerKey: string | null;
    consumerSecret: string | null;
    initiatorName: string | null;
    initiatorPassword: string | null;
    passkey: string | null;
  };
  shortcodes: {
    stk: string | null;
    stkPartyB: string | null;
    c2b: string | null;
    b2c: string | null;
    b2b: string | null;
  };
  stkTransactionType: StkTransactionType;
  /** The URL the provider must call back for one callback kind (built from the route token). */
  callbackUrl(kind: CallbackKind): string;
};

/** What one attempt asks the provider to do (from the immutable request and attempt rows). */
export type AttemptInstruction = {
  kind: PaymentAttemptKind;
  amountMinor: number;
  msisdn: string | null;
  partyB: string | null;
  accountReference: string | null;
  command: string | null;
  description: string | null;
  occasion: string | null;
  /** B2C: chosen by PM-Buddy and persisted before the call (Daraja OriginatorConversationID). */
  originatorConversationId: string | null;
  /** Reversal: the original receipt and the shortcode that received or paid it. */
  reversal: { receipt: string; shortcode: string } | null;
};

/**
 * A prepared call. `digest` is SHA-256 of the canonical body without SecurityCredential and
 * Password: the persisted call intent. `authorization` is a bearer token and is never logged.
 */
export type OutgoingCall = {
  operation:
    PaymentAttemptKind | "transaction_status" | "stk_query" | "account_balance" | "c2b_register";
  shortcode: string | null;
  url: string;
  authorization: string;
  body: Record<string, unknown>;
  digest: string;
};

/** Pre-flight could not prepare a call; nothing was sent and nothing changed. */
export class ProviderNotReady extends Error {
  constructor(
    readonly code:
      | "credentials-missing"
      | "shortcode-missing"
      | "certificate-unavailable"
      | "token-unavailable"
      | "environment-unavailable",
    message: string,
  ) {
    super(message);
    this.name = "ProviderNotReady";
  }
}

export interface PaymentProvider {
  readonly name: string;
  prepareAttempt(account: ProviderAccount, instruction: AttemptInstruction): Promise<OutgoingCall>;
  prepareTransactionStatus(
    account: ProviderAccount,
    target: {
      originatorConversationId: string | null;
      receipt: string | null;
      shortcode: string | null;
    },
  ): Promise<OutgoingCall>;
  prepareStkQuery(account: ProviderAccount, checkoutRequestId: string): Promise<OutgoingCall>;
  prepareAccountBalance(account: ProviderAccount): Promise<OutgoingCall>;
  prepareC2bRegistration(
    account: ProviderAccount,
    responseType: "Completed" | "Cancelled",
  ): Promise<OutgoingCall>;
  send(call: OutgoingCall): Promise<SubmissionTransport>;
  parseCallback(kind: CallbackKind, body: unknown): ParseResult;
  /** Forget a cached access token (after the provider said it is invalid, or credentials changed). */
  invalidateToken(
    account: Pick<ProviderAccount, "tenantId" | "environment" | "credentialsVersion">,
  ): Promise<void>;
}

export const PAYMENT_PROVIDER = Symbol("PAYMENT_PROVIDER");
export type { B2cCommand };
