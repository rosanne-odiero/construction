import { createHmac, randomBytes } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { AppConfig } from "../../config/app-config.js";
import { hashPassword, verifyPassword } from "./auth-security.service.js";

/**
 * Server-side pepper for labourer PINs. A six-digit PIN has only 10⁶ values, so an Argon2id hash
 * alone falls to a dictionary run once a database or backup leaks. Each PIN is first keyed with
 * HMAC-SHA-256 under a secret that never lives in the database (`AUTH_PIN_PEPPER_KEYS`, from the
 * secrets manager in production), then hashed with Argon2id. Keys are versioned like the field
 * keys: new hashes use the active version, older versions stay listed until every PIN using them
 * has been re-hashed (a correct sign-in does that), and `pin_pepper_version` records which key a
 * hash used (null: an older, unpeppered hash).
 */

export type PinPepperKeys = { keys: ReadonlyMap<number, Buffer>; active: number };

/**
 * Parses `AUTH_PIN_PEPPER_KEYS` ("1:<64 hex>,2:<64 hex>") and the active version, which is required
 * once more than one key is listed: otherwise an instance that already lists a new key would hash
 * with it while others cannot verify it yet. So a rotation is two deploys: list the new key
 * everywhere (active version unchanged), then make it active.
 */
export function parsePinPepperKeys(
  raw: string | undefined,
  activeVersion: number | undefined,
): PinPepperKeys | null {
  if (!raw) return null;
  const keys = new Map<number, Buffer>();
  for (const entry of raw.split(",")) {
    const match = /^\s*(\d{1,3}):([0-9a-fA-F]{64})\s*$/.exec(entry);
    if (!match) throw new Error("AUTH_PIN_PEPPER_KEYS entries must be <version>:<64 hex>");
    const version = Number(match[1]);
    if (version < 1 || version > 255)
      throw new Error("AUTH_PIN_PEPPER_KEYS versions must be 1–255");
    if (keys.has(version)) throw new Error(`AUTH_PIN_PEPPER_KEYS lists version ${version} twice`);
    keys.set(version, Buffer.from(match[2]!, "hex"));
  }
  if (keys.size > 1 && activeVersion === undefined)
    throw new Error(
      "AUTH_PIN_PEPPER_ACTIVE_VERSION is required when AUTH_PIN_PEPPER_KEYS lists more than one key",
    );
  const active = activeVersion ?? Math.max(...keys.keys());
  if (!keys.has(active))
    throw new Error(`AUTH_PIN_PEPPER_ACTIVE_VERSION ${active} is not in AUTH_PIN_PEPPER_KEYS`);
  return { keys, active };
}

/** The keyed PIN that Argon2id hashes (base64url HMAC-SHA-256 with a purpose prefix). */
export function pepperPin(key: Buffer, pin: string): string {
  return createHmac("sha256", key).update(`pm-buddy:pin:${pin}`).digest("base64url");
}

export type StoredPin = { pinHash: string; pinPepperVersion: number | null };

@Injectable()
export class PinHasher {
  private readonly logger = new Logger(PinHasher.name);
  private readonly pepper: PinPepperKeys | null;

  constructor(config: AppConfig) {
    this.pepper = parsePinPepperKeys(
      config.get("AUTH_PIN_PEPPER_KEYS"),
      config.get("AUTH_PIN_PEPPER_ACTIVE_VERSION"),
    );
    if (!this.pepper) {
      if (config.isProduction)
        throw new Error("Production requires AUTH_PIN_PEPPER_KEYS (labourer PIN pepper)");
      this.logger.warn(
        "AUTH_PIN_PEPPER_KEYS is not set: new labourer PINs are stored without a pepper",
      );
    }
  }

  /** A new PIN's hash and the pepper version it used. */
  async hash(pin: string): Promise<StoredPin> {
    if (!this.pepper) return { pinHash: await hashPassword(pin), pinPepperVersion: null };
    const { keys, active } = this.pepper;
    return {
      pinHash: await hashPassword(pepperPin(keys.get(active)!, pin)),
      pinPepperVersion: active,
    };
  }

  /**
   * Checks a PIN against a stored hash. A hash under a pepper version this instance does not list
   * (a key retired too early, or a rotation not yet deployed everywhere) never matches; it still
   * costs a full Argon2id check, so timing looks the same, and logs a warning (version only).
   */
  async verify(stored: StoredPin, pin: string): Promise<boolean> {
    if (stored.pinPepperVersion === null) return verifyPassword(stored.pinHash, pin);
    const key = this.pepper?.keys.get(stored.pinPepperVersion);
    if (!key) {
      this.logger.warn(
        { event: "pin_pepper_version_missing", pinPepperVersion: stored.pinPepperVersion },
        "A stored PIN uses a pepper version that is not configured; that PIN cannot sign in",
      );
      await verifyPassword(stored.pinHash, pepperPin(randomBytes(32), pin));
      return false;
    }
    return verifyPassword(stored.pinHash, pepperPin(key, pin));
  }

  /** Keys an unknown number's guess like a real one, so timing does not reveal registered numbers. */
  dummyInput(pin: string): string {
    return this.pepper ? pepperPin(this.pepper.keys.get(this.pepper.active)!, pin) : pin;
  }

  /** Whether a correct PIN should be re-hashed under the active pepper. */
  needsRehash(stored: StoredPin): boolean {
    return this.pepper !== null && stored.pinPepperVersion !== this.pepper.active;
  }
}
