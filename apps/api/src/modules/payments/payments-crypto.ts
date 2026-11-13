import { Injectable } from "@nestjs/common";
import type { PaymentSecretField } from "@pm-buddy/types";
import { AppConfig } from "../../config/app-config.js";
import { FieldCipher, parseFieldKeys, type FieldContext } from "../labour/field-cipher.js";

const SECRET_COLUMNS: Readonly<Record<PaymentSecretField, string>> = {
  consumerKey: "consumer_key_enc",
  consumerSecret: "consumer_secret_enc",
  initiatorName: "initiator_name_enc",
  initiatorPassword: "initiator_password_enc",
  passkey: "passkey_enc",
};

/**
 * Field encryption for payments (D4.2) reusing the D3.1 mechanism (ARCHITECTURE §10): AES-256-GCM
 * under per-company keys derived from the versioned master keys, with associated data binding
 * each ciphertext to its company, table, column and row. Daraja secrets, recipients' phone numbers,
 * callback path tokens, raw callback bodies and cached OAuth tokens are sealed; none is ever
 * logged, audited or returned.
 */
@Injectable()
export class PaymentsCrypto {
  private readonly cipher: FieldCipher;

  constructor(config: AppConfig) {
    this.cipher = new FieldCipher(
      parseFieldKeys(
        config.get("FIELD_ENCRYPTION_KEYS"),
        config.get("FIELD_ENCRYPTION_ACTIVE_KEY_VERSION"),
        config.get("FIELD_BLIND_INDEX_KEY"),
      ),
    );
  }

  private seal(context: FieldContext, value: string) {
    return this.cipher.encrypt(context, value);
  }

  private open(context: FieldContext, value: Uint8Array) {
    return this.cipher.decrypt(context, value);
  }

  sealSecret(tenantId: string, field: PaymentSecretField, value: string) {
    return this.seal(
      { tenantId, table: "payment_settings", column: SECRET_COLUMNS[field], rowId: tenantId },
      value,
    );
  }

  openSecret(tenantId: string, field: PaymentSecretField, value: Uint8Array) {
    return this.open(
      { tenantId, table: "payment_settings", column: SECRET_COLUMNS[field], rowId: tenantId },
      value,
    );
  }

  sealMsisdn(tenantId: string, requestId: string, msisdn: string) {
    return this.seal(
      { tenantId, table: "payment_requests", column: "msisdn_enc", rowId: requestId },
      msisdn,
    );
  }

  openMsisdn(tenantId: string, requestId: string, value: Uint8Array) {
    return this.open(
      { tenantId, table: "payment_requests", column: "msisdn_enc", rowId: requestId },
      value,
    );
  }

  sealToken(tenantId: string, routeId: string, token: string) {
    return this.seal(
      { tenantId, table: "payment_callback_routes", column: "token_enc", rowId: routeId },
      token,
    );
  }

  openToken(tenantId: string, routeId: string, value: Uint8Array) {
    return this.open(
      { tenantId, table: "payment_callback_routes", column: "token_enc", rowId: routeId },
      value,
    );
  }

  sealBody(tenantId: string, callbackId: string, body: string) {
    return this.seal(
      { tenantId, table: "payment_callback_inbox", column: "body_enc", rowId: callbackId },
      body,
    );
  }

  openBody(tenantId: string, callbackId: string, value: Uint8Array) {
    return this.open(
      { tenantId, table: "payment_callback_inbox", column: "body_enc", rowId: callbackId },
      value,
    );
  }

  /** OAuth access tokens cached in Valkey are sealed too (bound to the company and cache key). */
  sealAccessToken(tenantId: string, cacheKey: string, token: string) {
    return Buffer.from(
      this.seal(
        { tenantId, table: "valkey", column: "daraja_access_token", rowId: cacheKey },
        token,
      ),
    ).toString("base64");
  }

  openAccessToken(tenantId: string, cacheKey: string, sealed: string) {
    return this.open(
      { tenantId, table: "valkey", column: "daraja_access_token", rowId: cacheKey },
      Buffer.from(sealed, "base64"),
    );
  }
}
