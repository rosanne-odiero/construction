import { decodeProtectedHeader, EncryptJWT, jwtDecrypt, type JWEHeaderParameters } from "jose";

/**
 * Small secrets sealed with AUTH_MFA_ENCRYPTION_KEY: TOTP seeds (users.mfa_secret, mfa_pending),
 * CSRF tokens and the pending Google sign-in cookie. Compact JWE, `dir` + A256GCM (jose), with the
 * key version in the integrity-protected `kid` header so the key can rotate (D-151): new values
 * use the active version, older listed versions stay readable, and `keys:rotate rewrap` moves
 * stored values to the active key. Values sealed before versioning have no `kid`: version 1.
 */
export type SealKeys = { keys: ReadonlyMap<number, Uint8Array>; active: number };

const SINGLE = /^[0-9a-fA-F]{64}$/;
const ENTRY = /^\s*(\d{1,3}):([0-9a-fA-F]{64})\s*$/;
const KID = /^\d{1,3}$/;

/**
 * `<64 hex>` (version 1, the original single key) or `<version>:<64 hex>,…`. The active version
 * defaults to the highest; with more than one key it must be explicit, so every instance seals
 * with the same key during a rotation. Errors never include key material.
 */
export function parseSealKeys(raw: string | undefined, activeVersion?: number): SealKeys | null {
  if (!raw) return null;
  const keys = new Map<number, Uint8Array>();
  if (SINGLE.test(raw.trim())) keys.set(1, Buffer.from(raw.trim(), "hex"));
  else
    for (const entry of raw.split(",")) {
      const match = ENTRY.exec(entry);
      if (!match) throw new Error("AUTH_MFA_ENCRYPTION_KEY entries must be <version>:<64 hex>");
      const version = Number(match[1]);
      if (version < 1 || version > 255)
        throw new Error("AUTH_MFA_ENCRYPTION_KEY versions must be 1–255");
      if (keys.has(version))
        throw new Error(`AUTH_MFA_ENCRYPTION_KEY lists version ${version} twice`);
      keys.set(version, Buffer.from(match[2]!, "hex"));
    }
  if (keys.size > 1 && activeVersion === undefined)
    throw new Error(
      "AUTH_MFA_ENCRYPTION_ACTIVE_KEY_VERSION is required when AUTH_MFA_ENCRYPTION_KEY lists more than one key",
    );
  const active = activeVersion ?? Math.max(...keys.keys());
  if (!keys.has(active))
    throw new Error(
      `AUTH_MFA_ENCRYPTION_ACTIVE_KEY_VERSION ${active} is not in AUTH_MFA_ENCRYPTION_KEY`,
    );
  return { keys, active };
}

function versionOfHeader(header: Pick<JWEHeaderParameters, "kid">): number {
  if (header.kid === undefined) return 1;
  if (!KID.test(header.kid)) throw new Error("Sealed value has an invalid key version");
  return Number(header.kid);
}

export class SealedSecrets {
  constructor(private readonly ring: SealKeys) {}

  get activeVersion(): number {
    return this.ring.active;
  }

  async seal(secret: string, purpose: string, expiration?: string): Promise<string> {
    const value = new EncryptJWT({ secret, purpose })
      .setProtectedHeader({ alg: "dir", enc: "A256GCM", kid: String(this.ring.active) })
      .setIssuedAt();
    if (expiration) value.setExpirationTime(expiration);
    return value.encrypt(this.ring.keys.get(this.ring.active)!);
  }

  async open(value: string, purpose: string): Promise<string> {
    const { payload } = await jwtDecrypt(
      value,
      (header) => {
        const key = this.ring.keys.get(versionOfHeader(header));
        if (!key) throw new Error("Sealed value uses a key version that is not configured");
        return key;
      },
      { keyManagementAlgorithms: ["dir"], contentEncryptionAlgorithms: ["A256GCM"] },
    );
    if (payload["purpose"] !== purpose || typeof payload["secret"] !== "string") {
      throw new Error("Encrypted credential has the wrong purpose");
    }
    return payload["secret"];
  }

  /** The key version a sealed value was written with (from its protected header). */
  versionOf(value: string): number {
    return versionOfHeader(decodeProtectedHeader(value));
  }

  needsRewrap(value: string): boolean {
    return this.versionOf(value) !== this.ring.active;
  }

  /** Re-seals a stored value (no expiry) under the active key. */
  async rewrap(value: string, purpose: string): Promise<string> {
    return this.seal(await this.open(value, purpose), purpose);
  }
}
