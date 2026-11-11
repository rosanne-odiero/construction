import { Injectable } from "@nestjs/common";
import { AppConfig } from "../../config/app-config.js";
import { FieldCipher, parseFieldKeys, type FieldContext } from "../labour/field-cipher.js";

/** Encrypted supplier columns (ARCHITECTURE §10); each ciphertext is bound to its row. */
export type SupplierEncryptedColumn =
  | { table: "suppliers"; column: "kra_pin_enc" }
  | { table: "supplier_contacts"; column: "phone_enc" }
  | { table: "supplier_payout_versions"; column: "account_number_enc" };

export const KRA_PIN_COLUMN = { table: "suppliers", column: "kra_pin_enc" } as const;
export const CONTACT_PHONE_COLUMN = { table: "supplier_contacts", column: "phone_enc" } as const;
export const ACCOUNT_NUMBER_COLUMN = {
  table: "supplier_payout_versions",
  column: "account_number_enc",
} as const;

/**
 * Field encryption and blind indexes for supplier identifiers (KRA PIN, contact phones, bank
 * account numbers), with keys from configuration. Uses the shared FieldCipher (currently in
 * modules/labour; it moves to a shared module once D3.1 merges). Values never reach logs or audit.
 */
@Injectable()
export class SupplierCrypto {
  readonly cipher: FieldCipher;

  constructor(config: AppConfig) {
    this.cipher = new FieldCipher(
      parseFieldKeys(
        config.get("FIELD_ENCRYPTION_KEYS"),
        config.get("FIELD_ENCRYPTION_ACTIVE_KEY_VERSION"),
        config.get("FIELD_BLIND_INDEX_KEY"),
      ),
    );
  }

  private context(tenantId: string, rowId: string, target: SupplierEncryptedColumn): FieldContext {
    return { tenantId, table: target.table, column: target.column, rowId };
  }

  seal(tenantId: string, rowId: string, target: SupplierEncryptedColumn, value: string) {
    return this.cipher.encrypt(this.context(tenantId, rowId, target), value);
  }

  open(
    tenantId: string,
    rowId: string,
    target: SupplierEncryptedColumn,
    value: Uint8Array,
  ): string {
    return this.cipher.decrypt(this.context(tenantId, rowId, target), value);
  }

  kraPinIndex(tenantId: string, pin: string): string {
    return this.cipher.blindIndex(tenantId, "kra_pin", pin);
  }

  phoneIndex(tenantId: string, phone: string): string {
    return this.cipher.blindIndex(tenantId, "phone", phone);
  }
}
