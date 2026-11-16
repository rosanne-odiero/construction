import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";

/**
 * Sealed storage for biometric templates (D3.4, decision D-167; DPIA M-02, THREAT_MODEL OR-01).
 * A template is encrypted to a biometrics-only X25519 public key: the API holds public keys only,
 * so it can store templates but never read them back; the private keys stay with the future
 * biometrics worker (which prepares encrypted site rosters for kiosks) and the operator's
 * `keys:rotate` run. Everything comes from Node's crypto (OpenSSL); nothing is hand-rolled.
 *
 * Each seal uses a fresh ephemeral key pair: the AES-256-GCM key is HKDF-SHA-256 over the X25519
 * shared secret, salted with both public keys. The associated data binds the ciphertext to its
 * company, table, column and row, so a ciphertext copied to another template fails to open.
 *
 * Envelope: [format 0x02][key version 1–255][32-byte ephemeral public key][12-byte nonce]
 * [ciphertext][16-byte tag]. The database checks the format byte, the length and that
 * `key_version` matches byte 2 (biometric_templates_check).
 */

export const SEALED_TEMPLATE_FORMAT = 2;
const HEADER_BYTES = 2;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const INFO = "pm-buddy/biometric-template-v1";
// DER prefixes of X25519 SubjectPublicKeyInfo and PKCS #8 keys (RFC 8410), before the 32 raw bytes.
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

/** Where a template is stored: its company and row. */
export type TemplateContext = { tenantId: string; templateId: string };

/** Deliberately vague: never carries template bytes or key material. */
export class TemplateSealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateSealError";
  }
}

const associatedData = ({ tenantId, templateId }: TemplateContext) =>
  Buffer.from(`pmb-biometric-v1|${tenantId}|biometric_templates|template_enc|${templateId}`);

const publicKeyOf = (raw: Buffer) =>
  createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
const privateKeyOf = (raw: Buffer) =>
  createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: "der", type: "pkcs8" });
const rawPublic = (key: KeyObject) =>
  (key.export({ format: "der", type: "spki" }) as Buffer).subarray(SPKI_PREFIX.length);
const rawPrivate = (key: KeyObject) =>
  (key.export({ format: "der", type: "pkcs8" }) as Buffer).subarray(PKCS8_PREFIX.length);

const sessionKey = (shared: Buffer, ephemeral: Buffer, recipient: Buffer) =>
  Buffer.from(hkdfSync("sha256", shared, Buffer.concat([ephemeral, recipient]), INFO, KEY_BYTES));

/**
 * Parses a `<version>:<64 hex>` list (raw 32-byte X25519 keys) and the optional active version
 * (default: the highest). Throws a readable configuration error without key material.
 */
export function parseTemplateKeyList(
  name: string,
  raw: string,
  activeVersion?: number,
): { keys: Map<number, Buffer>; activeVersion: number } {
  const keys = new Map<number, Buffer>();
  for (const entry of raw.split(",")) {
    const match = /^\s*(\d{1,3}):([0-9a-fA-F]{64})\s*$/.exec(entry);
    if (!match) throw new Error(`${name} entries must be <version>:<64 hex>`);
    const version = Number(match[1]);
    if (version < 1 || version > 255) throw new Error(`${name} versions must be 1–255`);
    if (keys.has(version)) throw new Error(`${name} lists version ${version} twice`);
    keys.set(version, Buffer.from(match[2]!, "hex"));
  }
  const active = activeVersion ?? Math.max(...keys.keys());
  if (!keys.has(active)) throw new Error(`The active version ${active} is not in ${name}`);
  return { keys, activeVersion: active };
}

/** The key version an envelope was sealed with (format checked). */
export function sealedKeyVersion(envelope: Uint8Array): number {
  if (
    envelope.length < HEADER_BYTES + KEY_BYTES + NONCE_BYTES + TAG_BYTES + 1 ||
    envelope[0] !== SEALED_TEMPLATE_FORMAT
  )
    throw new TemplateSealError("Not a sealed template");
  return envelope[1]!;
}

/** Seals templates to the active public key. The API holds only this. */
export class TemplateSealer {
  private readonly keys: Map<number, { key: KeyObject; raw: Buffer }>;

  constructor(
    publicKeys: ReadonlyMap<number, Buffer>,
    readonly activeVersion: number,
  ) {
    this.keys = new Map(
      [...publicKeys].map(([version, raw]) => {
        try {
          return [version, { key: publicKeyOf(raw), raw }];
        } catch {
          throw new Error(`Biometric template public key ${version} is not an X25519 key`);
        }
      }),
    );
    if (!this.keys.has(activeVersion))
      throw new Error(`The active version ${activeVersion} has no public key`);
  }

  seal(context: TemplateContext, template: Uint8Array): Uint8Array<ArrayBuffer> {
    const recipient = this.keys.get(this.activeVersion)!;
    const ephemeral = generateKeyPairSync("x25519");
    const ephemeralRaw = rawPublic(ephemeral.publicKey);
    const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient.key });
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(
      "aes-256-gcm",
      sessionKey(shared, ephemeralRaw, recipient.raw),
      nonce,
      {
        authTagLength: TAG_BYTES,
      },
    );
    cipher.setAAD(associatedData(context));
    const body = Buffer.concat([cipher.update(template), cipher.final()]);
    const envelope = new Uint8Array(
      HEADER_BYTES + KEY_BYTES + NONCE_BYTES + body.length + TAG_BYTES,
    );
    envelope[0] = SEALED_TEMPLATE_FORMAT;
    envelope[1] = this.activeVersion;
    envelope.set(ephemeralRaw, HEADER_BYTES);
    envelope.set(nonce, HEADER_BYTES + KEY_BYTES);
    envelope.set(body, HEADER_BYTES + KEY_BYTES + NONCE_BYTES);
    envelope.set(cipher.getAuthTag(), HEADER_BYTES + KEY_BYTES + NONCE_BYTES + body.length);
    return envelope;
  }
}

/**
 * Opens sealed templates with the private keys. Never constructed by the API: only by the
 * operator's key rotation run (and, later, the biometrics worker) and by tests.
 */
export class TemplateOpener {
  private readonly keys: Map<number, { key: KeyObject; raw: Buffer }>;

  constructor(privateKeys: ReadonlyMap<number, Buffer>) {
    this.keys = new Map(
      [...privateKeys].map(([version, raw]) => {
        try {
          const key = privateKeyOf(raw);
          return [version, { key, raw: rawPublic(createPublicKey(key)) }];
        } catch {
          throw new Error(`Biometric template private key ${version} is not an X25519 key`);
        }
      }),
    );
  }

  open(context: TemplateContext, envelope: Uint8Array): Buffer {
    const version = sealedKeyVersion(envelope);
    const recipient = this.keys.get(version);
    if (!recipient)
      throw new TemplateSealError(`No biometric template private key with version ${version}`);
    const bytes = Buffer.from(envelope.buffer, envelope.byteOffset, envelope.byteLength);
    const ephemeralRaw = bytes.subarray(HEADER_BYTES, HEADER_BYTES + KEY_BYTES);
    const nonce = bytes.subarray(HEADER_BYTES + KEY_BYTES, HEADER_BYTES + KEY_BYTES + NONCE_BYTES);
    const tag = bytes.subarray(bytes.length - TAG_BYTES);
    const body = bytes.subarray(HEADER_BYTES + KEY_BYTES + NONCE_BYTES, bytes.length - TAG_BYTES);
    try {
      const shared = diffieHellman({
        privateKey: recipient.key,
        publicKey: publicKeyOf(Buffer.from(ephemeralRaw)),
      });
      const decipher = createDecipheriv(
        "aes-256-gcm",
        sessionKey(shared, ephemeralRaw, recipient.raw),
        nonce,
        { authTagLength: TAG_BYTES },
      );
      decipher.setAAD(associatedData(context));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]);
    } catch {
      throw new TemplateSealError(
        "A sealed template could not be opened (wrong key, row or value)",
      );
    }
  }
}

/** A new key pair as raw hex (operators may use OpenSSL instead; see apps/api/README.md). */
export function generateTemplateKeyPair(): { publicKey: string; privateKey: string } {
  const pair = generateKeyPairSync("x25519");
  return {
    publicKey: rawPublic(pair.publicKey).toString("hex"),
    privateKey: rawPrivate(pair.privateKey).toString("hex"),
  };
}
