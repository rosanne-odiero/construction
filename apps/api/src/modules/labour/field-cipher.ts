import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Field-level encryption for labourer identifiers (brief §7, ARCHITECTURE §10). AES-256-GCM from
 * Node's crypto (OpenSSL); nothing is hand-rolled. Each value is encrypted under a per-company key
 * derived with HKDF-SHA-256 from a versioned master key, with associated data binding the
 * ciphertext to its company, table, column and row, so a ciphertext copied to another row or
 * company fails to decrypt.
 *
 * Envelope: [format 0x01][key version 1–255][12-byte nonce][ciphertext][16-byte tag]. The key
 * version lets keys rotate: new values use the active version, older versions stay readable while
 * they are listed, and `needsRotation`/`reencrypt` move a value to the active key.
 *
 * Blind indexes are HMAC-SHA-256 under a separate, per-company derived key, over a purpose prefix
 * and the canonical value: exact-match lookups and uniqueness without storing plaintext. The same
 * identifier in two companies has unrelated indexes.
 */

const FORMAT = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 2;
const KEY_BYTES = 32;
const MAX_DERIVED = 10_000;

export type FieldKeys = {
  keys: ReadonlyMap<number, Buffer>;
  activeVersion: number;
  blindIndexKey: Buffer;
};

/** Binds a ciphertext to where it is stored. */
export type FieldContext = { tenantId: string; table: string; column: string; rowId: string };

export type BlindIndexPurpose = "id" | "phone" | "kra_pin";

/** Deliberately vague: never carries plaintext, ciphertext or key material. */
export class FieldCipherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FieldCipherError";
  }
}

/**
 * Parses `FIELD_ENCRYPTION_KEYS` ("1:<64 hex>,2:<64 hex>"), the optional active version and the
 * blind-index key. Throws a readable configuration error (without key material) when anything is
 * missing or inconsistent.
 */
export function parseFieldKeys(
  rawKeys: string | undefined,
  activeVersion: number | undefined,
  rawBlindIndexKey: string | undefined,
): FieldKeys {
  if (!rawKeys || !rawBlindIndexKey)
    throw new Error(
      "FIELD_ENCRYPTION_KEYS and FIELD_BLIND_INDEX_KEY are required (labourer field encryption); " +
        "see apps/api/README.md for how to generate them",
    );
  const keys = new Map<number, Buffer>();
  for (const entry of rawKeys.split(",")) {
    const match = /^\s*(\d{1,3}):([0-9a-fA-F]{64})\s*$/.exec(entry);
    if (!match) throw new Error("FIELD_ENCRYPTION_KEYS entries must be <version>:<64 hex>");
    const version = Number(match[1]);
    if (version < 1 || version > 255)
      throw new Error("FIELD_ENCRYPTION_KEYS versions must be 1–255");
    if (keys.has(version)) throw new Error(`FIELD_ENCRYPTION_KEYS lists version ${version} twice`);
    keys.set(version, Buffer.from(match[2]!, "hex"));
  }
  const active = activeVersion ?? Math.max(...keys.keys());
  if (!keys.has(active))
    throw new Error(
      `FIELD_ENCRYPTION_ACTIVE_KEY_VERSION ${active} is not in FIELD_ENCRYPTION_KEYS`,
    );
  if (!/^[0-9a-fA-F]{64}$/.test(rawBlindIndexKey))
    throw new Error("FIELD_BLIND_INDEX_KEY must be 64 hex characters");
  const blindIndexKey = Buffer.from(rawBlindIndexKey, "hex");
  for (const key of keys.values())
    if (timingSafeEqual(key, blindIndexKey))
      throw new Error("FIELD_BLIND_INDEX_KEY must differ from every encryption key");
  return { keys, activeVersion: active, blindIndexKey };
}

const associatedData = ({ tenantId, table, column, rowId }: FieldContext) =>
  Buffer.from(`pmb-field-v1|${tenantId}|${table}|${column}|${rowId}`, "utf8");

export class FieldCipher {
  private readonly derived = new Map<string, Buffer>();

  constructor(private readonly config: FieldKeys) {}

  get activeVersion(): number {
    return this.config.activeVersion;
  }

  encrypt(context: FieldContext, plaintext: string): Uint8Array<ArrayBuffer> {
    const version = this.config.activeVersion;
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.dataKey(version, context.tenantId), nonce, {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(associatedData(context));
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const envelope = new Uint8Array(HEADER_BYTES + NONCE_BYTES + body.length + TAG_BYTES);
    envelope[0] = FORMAT;
    envelope[1] = version;
    envelope.set(nonce, HEADER_BYTES);
    envelope.set(body, HEADER_BYTES + NONCE_BYTES);
    envelope.set(cipher.getAuthTag(), HEADER_BYTES + NONCE_BYTES + body.length);
    return envelope;
  }

  decrypt(context: FieldContext, envelope: Uint8Array): string {
    const version = this.keyVersionOf(envelope);
    if (!this.config.keys.has(version))
      throw new FieldCipherError(`No field key with version ${version} is configured`);
    const bytes = Buffer.from(envelope.buffer, envelope.byteOffset, envelope.byteLength);
    const nonce = bytes.subarray(HEADER_BYTES, HEADER_BYTES + NONCE_BYTES);
    const tag = bytes.subarray(bytes.length - TAG_BYTES);
    const body = bytes.subarray(HEADER_BYTES + NONCE_BYTES, bytes.length - TAG_BYTES);
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.dataKey(version, context.tenantId),
        nonce,
        { authTagLength: TAG_BYTES },
      );
      decipher.setAAD(associatedData(context));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    } catch {
      throw new FieldCipherError("Field decryption failed (wrong key, row or tampered value)");
    }
  }

  /** The key version an envelope was written with. */
  keyVersionOf(envelope: Uint8Array): number {
    if (envelope.length < HEADER_BYTES + NONCE_BYTES + TAG_BYTES + 1 || envelope[0] !== FORMAT)
      throw new FieldCipherError("Not a field ciphertext");
    return envelope[1]!;
  }

  /** Written with an older key version: re-encrypt it (key rotation). */
  needsRotation(envelope: Uint8Array): boolean {
    return this.keyVersionOf(envelope) !== this.config.activeVersion;
  }

  reencrypt(context: FieldContext, envelope: Uint8Array): Uint8Array<ArrayBuffer> {
    return this.encrypt(context, this.decrypt(context, envelope));
  }

  /** HMAC-SHA-256 (hex) of `purpose:canonical` under the company's blind-index key. */
  blindIndex(tenantId: string, purpose: BlindIndexPurpose, canonical: string): string {
    return createHmac("sha256", this.derive("blind-index", this.config.blindIndexKey, tenantId))
      .update(`${purpose}:${canonical}`, "utf8")
      .digest("hex");
  }

  private dataKey(version: number, tenantId: string): Buffer {
    return this.derive(`data-v${version}`, this.config.keys.get(version)!, tenantId);
  }

  private derive(label: string, master: Buffer, tenantId: string): Buffer {
    const cacheKey = `${label}:${tenantId}`;
    const cached = this.derived.get(cacheKey);
    if (cached) return cached;
    if (this.derived.size >= MAX_DERIVED) this.derived.clear();
    const key = Buffer.from(
      hkdfSync("sha256", master, `pm-buddy/${label}`, `tenant:${tenantId}`, KEY_BYTES),
    );
    this.derived.set(cacheKey, key);
    return key;
  }
}
