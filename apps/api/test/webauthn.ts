import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import type {
  PasskeyAuthenticationOptions,
  PasskeyRegistrationOptions,
} from "@pm-buddy/validation";

/**
 * A minimal software authenticator for e2e tests: an ES256 (P-256) key pair that produces genuine
 * `none`-attestation registration responses and signed assertions, so the API's real WebAuthn
 * verification (@simplewebauthn/server) runs unmocked. It also forges the failure cases (wrong
 * origin, replayed challenge, counter regression, no user verification) on request.
 */
type CborValue = number | string | Uint8Array | Map<CborValue, CborValue>;

/** Encodes the small CBOR subset WebAuthn needs (RFC 8949: ints, byte/text strings, maps). */
export function cbor(value: CborValue): Buffer {
  const head = (major: number, length: number): Buffer => {
    if (length < 24) return Buffer.from([(major << 5) | length]);
    if (length < 0x100) return Buffer.from([(major << 5) | 24, length]);
    if (length < 0x10000) {
      const bytes = Buffer.alloc(3);
      bytes[0] = (major << 5) | 25;
      bytes.writeUInt16BE(length, 1);
      return bytes;
    }
    const bytes = Buffer.alloc(5);
    bytes[0] = (major << 5) | 26;
    bytes.writeUInt32BE(length, 1);
    return bytes;
  };
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const text = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, text.length), text]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  const entries = [...value.entries()].flatMap(([key, item]) => [cbor(key), cbor(item)]);
  return Buffer.concat([head(5, value.size), ...entries]);
}

const b64url = (value: Uint8Array | string) => Buffer.from(value).toString("base64url");
const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest();
const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

export type CeremonyOverrides = {
  origin?: string;
  rpId?: string;
  challenge?: string;
  /** Signature counter to report; defaults to the next value (or 0 for a zero-counter key). */
  counter?: number;
  userVerified?: boolean;
  /** Sign with a different key than the registered one. */
  forgeSignature?: boolean;
};

export class SoftwareAuthenticator {
  readonly credentialId: Buffer;
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private counter = 0;

  /**
   * @param origin the web origin the "browser" reports
   * @param zeroCounter behave like authenticators (most synced passkeys) that always report 0
   */
  constructor(
    readonly origin = "http://localhost:3000",
    readonly zeroCounter = false,
    credentialId: Buffer = randomBytes(32),
  ) {
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
    this.credentialId = credentialId;
  }

  get id(): string {
    return b64url(this.credentialId);
  }

  private coseKey(): Buffer {
    const jwk = this.publicKey.export({ format: "jwk" });
    return cbor(
      new Map<CborValue, CborValue>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(jwk.x!, "base64url")],
        [-3, Buffer.from(jwk.y!, "base64url")],
      ]),
    );
  }

  private nextCounter(overrides: CeremonyOverrides): number {
    if (overrides.counter !== undefined) return overrides.counter;
    if (this.zeroCounter) return 0;
    this.counter += 1;
    return this.counter;
  }

  private authenticatorData(
    rpId: string,
    flags: number,
    counter: number,
    attested?: Buffer,
  ): Buffer {
    const signCount = Buffer.alloc(4);
    signCount.writeUInt32BE(counter, 0);
    return Buffer.concat([
      sha256(rpId),
      Buffer.from([flags]),
      signCount,
      attested ?? Buffer.alloc(0),
    ]);
  }

  private clientData(type: string, challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), "utf8");
  }

  /** navigator.credentials.create() with `none` attestation, as @simplewebauthn/browser sends it. */
  register(options: PasskeyRegistrationOptions, overrides: CeremonyOverrides = {}) {
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length, 0);
    const attested = Buffer.concat([Buffer.alloc(16), idLength, this.credentialId, this.coseKey()]);
    const flags = UP | AT | (overrides.userVerified === false ? 0 : UV);
    const authData = this.authenticatorData(
      overrides.rpId ?? options.rp.id,
      flags,
      this.zeroCounter ? 0 : this.counter,
      attested,
    );
    const attestationObject = cbor(
      new Map<CborValue, CborValue>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key" as const,
      response: {
        clientDataJSON: b64url(
          this.clientData(
            "webauthn.create",
            overrides.challenge ?? options.challenge,
            overrides.origin ?? this.origin,
          ),
        ),
        attestationObject: b64url(attestationObject),
        transports: ["internal"],
        publicKeyAlgorithm: -7,
      },
      authenticatorAttachment: "platform" as const,
      clientExtensionResults: { credProps: { rk: true } },
    };
  }

  /** navigator.credentials.get(): an ES256 signature over authenticatorData ‖ SHA-256(clientData). */
  assert(options: PasskeyAuthenticationOptions, overrides: CeremonyOverrides = {}) {
    const flags = UP | (overrides.userVerified === false ? 0 : UV);
    const authData = this.authenticatorData(
      overrides.rpId ?? options.rpId,
      flags,
      this.nextCounter(overrides),
    );
    const clientData = this.clientData(
      "webauthn.get",
      overrides.challenge ?? options.challenge,
      overrides.origin ?? this.origin,
    );
    const key = overrides.forgeSignature
      ? generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey
      : this.privateKey;
    const signature = sign("sha256", Buffer.concat([authData, sha256(clientData)]), key);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key" as const,
      response: {
        clientDataJSON: b64url(clientData),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
      },
      clientExtensionResults: {},
    };
  }
}
