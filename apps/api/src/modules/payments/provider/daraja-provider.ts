import { Injectable, Logger } from "@nestjs/common";
import {
  darajaAmount,
  parseCallback,
  stkTimestamp,
  type ParseResult,
  type SubmissionTransport,
} from "@pm-buddy/domain";
import type { CallbackKind } from "@pm-buddy/types";
import { RedisService } from "../../../infra/redis.service.js";
import { PaymentsCrypto } from "../payments-crypto.js";
import { PaymentsRuntime } from "../payments-runtime.js";
import { canonicalJson, sha256 } from "../payments-support.js";
import {
  ProviderNotReady,
  type AttemptInstruction,
  type OutgoingCall,
  type PaymentProvider,
  type ProviderAccount,
} from "./payment-provider.js";
import { CertificateStore, securityCredential } from "./security-credential.js";

/**
 * Daraja endpoint paths, from the official API catalogue (developer.safaricom.co.ke, GraphQL
 * `populateApi`, retrieved 11/11/2026). The portal's own simulator posts B2C to
 * `mpesa/b2c/v1/paymentrequest` with an OriginatorConversationID while the documentation lists
 * v3: v3 is used here (flagged in docs/ARCHITECTURE.md §4.5, to confirm in the sandbox).
 */
export const DARAJA_PATHS = {
  oauth: "/oauth/v1/generate?grant_type=client_credentials",
  stkPush: "/mpesa/stkpush/v1/processrequest",
  stkQuery: "/mpesa/stkpushquery/v1/query",
  c2bRegister: "/mpesa/c2b/v2/registerurl",
  b2c: "/mpesa/b2c/v3/paymentrequest",
  b2b: "/mpesa/b2b/v1/paymentrequest",
  transactionStatus: "/mpesa/transactionstatus/v1/query",
  accountBalance: "/mpesa/accountbalance/v1/query",
  reversal: "/mpesa/reversal/v1/request",
} as const;

/** Errors that mean the request never left this process (no bytes reached the provider). */
const NOT_SENT = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "ERR_INVALID_URL",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

function errorCode(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return "UNKNOWN";
}

const isTimeout = (error: unknown) =>
  error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");

/** Strips secrets from a body before it is hashed into the persisted call intent. */
const digestOf = (body: Record<string, unknown>) => {
  const { SecurityCredential: _credential, Password: _password, ...rest } = body;
  return sha256(canonicalJson(rest));
};

@Injectable()
export class DarajaProvider implements PaymentProvider {
  readonly name = "daraja";
  private readonly logger = new Logger(DarajaProvider.name);
  private readonly memory = new Map<string, { token: string; expiresAt: number }>();

  constructor(
    private readonly runtime: PaymentsRuntime,
    private readonly certificates: CertificateStore,
    private readonly crypto: PaymentsCrypto,
    private readonly redis: RedisService,
  ) {}

  // OAuth --------------------------------------------------------------------------------------

  private cacheKey(
    account: Pick<ProviderAccount, "tenantId" | "environment" | "credentialsVersion">,
  ) {
    return `pmb:payments:daraja-token:${account.tenantId}:${account.environment}:${account.credentialsVersion}`;
  }

  /**
   * A bearer token per company, environment and credentials version, cached in memory and in
   * Valkey (sealed) until shortly before `expires_in` (3600 s per the Authorization API). Daraja
   * says each new token invalidates the previous one, so instances share the cached token instead
   * of each fetching their own. Never logged.
   */
  private async accessToken(account: ProviderAccount): Promise<string> {
    const key = this.cacheKey(account);
    const now = Date.now();
    const remembered = this.memory.get(key);
    if (remembered && remembered.expiresAt > now) return remembered.token;
    try {
      await this.redis.ping();
      const sealed = await this.redis.client.get(key);
      if (sealed) {
        const ttl = await this.redis.client.pttl(key);
        const token = this.crypto.openAccessToken(account.tenantId, key, sealed);
        this.memory.set(key, { token, expiresAt: now + Math.max(ttl, 0) });
        return token;
      }
    } catch {
      // Valkey is a cache here: without it, fetch a token for this process only.
    }
    const { consumerKey, consumerSecret } = account.credentials;
    if (!consumerKey || !consumerSecret)
      throw new ProviderNotReady(
        "credentials-missing",
        "Consumer key and secret are not configured",
      );
    let response: Response;
    try {
      response = await fetch(`${this.runtime.baseUrl(account.environment)}${DARAJA_PATHS.oauth}`, {
        headers: {
          authorization: `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64")}`,
        },
        signal: AbortSignal.timeout(this.runtime.httpTimeoutMs),
        redirect: "error",
      });
    } catch {
      throw new ProviderNotReady("token-unavailable", "The Daraja token endpoint did not answer");
    }
    const body = (await response.json().catch(() => null)) as {
      access_token?: unknown;
      expires_in?: unknown;
    } | null;
    const token = typeof body?.access_token === "string" ? body.access_token : null;
    const expiresIn = Number(body?.expires_in ?? 0);
    if (!response.ok || !token || !Number.isFinite(expiresIn) || expiresIn <= 0)
      throw new ProviderNotReady(
        "token-unavailable",
        `Daraja refused the token request (${response.status})`,
      );
    const ttlSeconds = Math.max(60, Math.floor(expiresIn) - 120);
    this.memory.set(key, { token, expiresAt: now + ttlSeconds * 1000 });
    try {
      await this.redis.client.set(
        key,
        this.crypto.sealAccessToken(account.tenantId, key, token),
        "EX",
        ttlSeconds,
      );
    } catch {
      this.logger.warn("Could not share the Daraja access token through Valkey");
    }
    return token;
  }

  async invalidateToken(
    account: Pick<ProviderAccount, "tenantId" | "environment" | "credentialsVersion">,
  ) {
    const key = this.cacheKey(account);
    this.memory.delete(key);
    try {
      await this.redis.client.del(key);
    } catch {
      // A stale Valkey entry expires on its own.
    }
  }

  // Preparation --------------------------------------------------------------------------------

  private require<T>(value: T | null | undefined, code: ProviderNotReady["code"], what: string): T {
    if (value === null || value === undefined || value === "")
      throw new ProviderNotReady(code, `${what} is not configured`);
    return value;
  }

  private async initiator(account: ProviderAccount) {
    const name = this.require(
      account.credentials.initiatorName,
      "credentials-missing",
      "The initiator name",
    );
    const password = this.require(
      account.credentials.initiatorPassword,
      "credentials-missing",
      "The initiator password",
    );
    const key = await this.certificates.publicKey(account.environment);
    return { name, credential: securityCredential(password, key) };
  }

  private async call(
    account: ProviderAccount,
    operation: OutgoingCall["operation"],
    path: string,
    shortcode: string | null,
    body: Record<string, unknown>,
  ): Promise<OutgoingCall> {
    const token = await this.accessToken(account);
    return {
      operation,
      shortcode,
      url: `${this.runtime.baseUrl(account.environment)}${path}`,
      authorization: `Bearer ${token}`,
      body,
      digest: digestOf(body),
    };
  }

  async prepareAttempt(
    account: ProviderAccount,
    instruction: AttemptInstruction,
  ): Promise<OutgoingCall> {
    const amount = darajaAmount(instruction.amountMinor);
    switch (instruction.kind) {
      case "stk_push": {
        const shortcode = this.require(
          account.shortcodes.stk,
          "shortcode-missing",
          "The STK shortcode",
        );
        const passkey = this.require(
          account.credentials.passkey,
          "credentials-missing",
          "The passkey",
        );
        const msisdn = this.require(instruction.msisdn, "credentials-missing", "The phone number");
        const timestamp = stkTimestamp(new Date());
        return this.call(account, "stk_push", DARAJA_PATHS.stkPush, shortcode, {
          BusinessShortCode: shortcode,
          Password: Buffer.from(`${shortcode}${passkey}${timestamp}`).toString("base64"),
          Timestamp: timestamp,
          TransactionType: account.stkTransactionType,
          Amount: amount,
          PartyA: msisdn,
          PartyB: account.shortcodes.stkPartyB ?? shortcode,
          PhoneNumber: msisdn,
          CallBackURL: account.callbackUrl("stk"),
          AccountReference: instruction.accountReference ?? "PM-Buddy",
          TransactionDesc: instruction.description ?? "Payment",
        });
      }
      case "b2c": {
        const shortcode = this.require(
          account.shortcodes.b2c,
          "shortcode-missing",
          "The B2C shortcode",
        );
        const msisdn = this.require(instruction.msisdn, "credentials-missing", "The phone number");
        const originator = this.require(
          instruction.originatorConversationId,
          "credentials-missing",
          "The OriginatorConversationID",
        );
        const initiator = await this.initiator(account);
        return this.call(account, "b2c", DARAJA_PATHS.b2c, shortcode, {
          OriginatorConversationID: originator,
          InitiatorName: initiator.name,
          SecurityCredential: initiator.credential,
          CommandID: instruction.command ?? "BusinessPayment",
          Amount: amount,
          PartyA: shortcode,
          PartyB: msisdn,
          Remarks: instruction.description ?? "Payment",
          QueueTimeOutURL: account.callbackUrl("timeout"),
          ResultURL: account.callbackUrl("b2c_result"),
          Occassion: instruction.occasion ?? "",
        });
      }
      case "b2b_paybill":
      case "b2b_buygoods": {
        const shortcode = this.require(
          account.shortcodes.b2b,
          "shortcode-missing",
          "The B2B shortcode",
        );
        const initiator = await this.initiator(account);
        return this.call(account, instruction.kind, DARAJA_PATHS.b2b, shortcode, {
          Initiator: initiator.name,
          SecurityCredential: initiator.credential,
          CommandID: instruction.kind === "b2b_paybill" ? "BusinessPayBill" : "BusinessBuyGoods",
          SenderIdentifierType: "4",
          RecieverIdentifierType: "4",
          Amount: amount,
          PartyA: shortcode,
          PartyB: this.require(instruction.partyB, "shortcode-missing", "The receiving shortcode"),
          AccountReference: instruction.accountReference ?? "",
          Remarks: instruction.description ?? "Payment",
          QueueTimeOutURL: account.callbackUrl("timeout"),
          ResultURL: account.callbackUrl("b2b_result"),
        });
      }
      case "reversal": {
        const reversal = this.require(
          instruction.reversal,
          "credentials-missing",
          "The original receipt",
        );
        const initiator = await this.initiator(account);
        return this.call(account, "reversal", DARAJA_PATHS.reversal, reversal.shortcode, {
          Initiator: initiator.name,
          SecurityCredential: initiator.credential,
          CommandID: "TransactionReversal",
          TransactionID: reversal.receipt,
          Amount: amount,
          ReceiverParty: reversal.shortcode,
          RecieverIdentifierType: "11",
          ResultURL: account.callbackUrl("reversal_result"),
          QueueTimeOutURL: account.callbackUrl("timeout"),
          Remarks: instruction.description ?? "Reversal",
          Occasion: "",
        });
      }
    }
  }

  async prepareTransactionStatus(
    account: ProviderAccount,
    target: {
      originatorConversationId: string | null;
      receipt: string | null;
      shortcode: string | null;
    },
  ): Promise<OutgoingCall> {
    const shortcode = this.require(target.shortcode, "shortcode-missing", "The shortcode");
    const initiator = await this.initiator(account);
    return this.call(account, "transaction_status", DARAJA_PATHS.transactionStatus, shortcode, {
      Initiator: initiator.name,
      SecurityCredential: initiator.credential,
      CommandID: "TransactionStatusQuery",
      ...(target.receipt ? { TransactionID: target.receipt } : {}),
      ...(target.originatorConversationId
        ? { OriginalConversationID: target.originatorConversationId }
        : {}),
      PartyA: shortcode,
      IdentifierType: "4",
      ResultURL: account.callbackUrl("status_result"),
      QueueTimeOutURL: account.callbackUrl("timeout"),
      Remarks: "Reconciliation",
      Occasion: "",
    });
  }

  async prepareStkQuery(
    account: ProviderAccount,
    checkoutRequestId: string,
  ): Promise<OutgoingCall> {
    const shortcode = this.require(
      account.shortcodes.stk,
      "shortcode-missing",
      "The STK shortcode",
    );
    const passkey = this.require(account.credentials.passkey, "credentials-missing", "The passkey");
    const timestamp = stkTimestamp(new Date());
    return this.call(account, "stk_query", DARAJA_PATHS.stkQuery, shortcode, {
      BusinessShortCode: shortcode,
      Password: Buffer.from(`${shortcode}${passkey}${timestamp}`).toString("base64"),
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId,
    });
  }

  async prepareAccountBalance(account: ProviderAccount): Promise<OutgoingCall> {
    const shortcode = this.require(
      account.shortcodes.b2c ?? account.shortcodes.b2b,
      "shortcode-missing",
      "A B2C or B2B shortcode",
    );
    const initiator = await this.initiator(account);
    return this.call(account, "account_balance", DARAJA_PATHS.accountBalance, shortcode, {
      Initiator: initiator.name,
      SecurityCredential: initiator.credential,
      CommandID: "AccountBalance",
      PartyA: shortcode,
      IdentifierType: "4",
      Remarks: "Float check",
      QueueTimeOutURL: account.callbackUrl("timeout"),
      ResultURL: account.callbackUrl("balance_result"),
    });
  }

  async prepareC2bRegistration(
    account: ProviderAccount,
    responseType: "Completed" | "Cancelled",
  ): Promise<OutgoingCall> {
    const shortcode = this.require(
      account.shortcodes.c2b,
      "shortcode-missing",
      "The C2B shortcode",
    );
    return this.call(account, "c2b_register", DARAJA_PATHS.c2bRegister, shortcode, {
      ShortCode: shortcode,
      ResponseType: responseType,
      ConfirmationURL: account.callbackUrl("c2b_confirmation"),
      ValidationURL: account.callbackUrl("c2b_validation"),
    });
  }

  // Transport ----------------------------------------------------------------------------------

  /** One POST, no redirects, bounded by DARAJA_HTTP_TIMEOUT_MS; never retried here. */
  async send(call: OutgoingCall): Promise<SubmissionTransport> {
    let response: Response;
    try {
      response = await fetch(call.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: call.authorization },
        body: JSON.stringify(call.body),
        signal: AbortSignal.timeout(this.runtime.httpTimeoutMs),
        redirect: "error",
      });
    } catch (error) {
      if (isTimeout(error)) return { type: "timeout" };
      const code = errorCode(error);
      return NOT_SENT.has(code) ? { type: "not_sent", code } : { type: "network", code };
    }
    let body: unknown = null;
    try {
      const text = await response.text();
      body = text ? JSON.parse(text) : null;
    } catch (error) {
      if (isTimeout(error)) return { type: "timeout" };
      body = null;
    }
    return { type: "response", httpStatus: response.status, body };
  }

  parseCallback(kind: CallbackKind, body: unknown): ParseResult {
    return parseCallback(kind, body);
  }
}
