import { readFile } from "node:fs/promises";
import { constants, createPublicKey, publicEncrypt, X509Certificate, type KeyObject } from "node:crypto";
import { Injectable } from "@nestjs/common";
import type { PaymentEnvironment } from "@pm-buddy/types";
import { PaymentsRuntime } from "../payments-runtime.js";
import { ProviderNotReady } from "./payment-provider.js";

/**
 * Daraja `SecurityCredential` (official documentation, Transaction Status "Security credentials",
 * retrieved 11/11/2026): write the initiator password into a byte array, encrypt it with the
 * M-Pesa public key certificate using RSA with PKCS #1 v1.5 padding (not OAEP), then base64-encode
 * the result. ASSUMPTION (flagged): some Daraja pages say "the base64 encoded initiator password";
 * the step-by-step algorithm encrypts the password bytes themselves, which is what this does.
 * Each credential differs (random padding); none is stored or logged.
 */
export function securityCredential(initiatorPassword: string, publicKey: KeyObject): string {
  return publicEncrypt(
    { key: publicKey, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(initiatorPassword, "utf8"),
  ).toString("base64");
}

/** A PEM certificate (preferred, as Safaricom publishes) or a PEM public key. */
export function publicKeyFromPem(pem: string): { key: KeyObject; fingerprint: string | null; validTo: string | null } {
  if (pem.includes("BEGIN CERTIFICATE")) {
    const certificate = new X509Certificate(pem);
    return { key: certificate.publicKey, fingerprint: certificate.fingerprint256, validTo: certificate.validTo };
  }
  return { key: createPublicKey(pem), fingerprint: null, validTo: null };
}

/**
 * Where the encryption certificate of each environment comes from: the mock server's generated
 * test certificate (development and tests), Safaricom's public sandbox certificate from
 * DARAJA_SANDBOX_CERTIFICATE_PATH, and, once production is enabled, the secrets manager. Loaded
 * certificates are cached in memory.
 */
@Injectable()
export class CertificateStore {
  private readonly cache = new Map<string, KeyObject>();

  constructor(private readonly runtime: PaymentsRuntime) {}

  configured(environment: PaymentEnvironment): boolean {
    if (environment === "mock") return true;
    if (environment === "sandbox") return Boolean(this.runtime.sandboxCertificatePath);
    return false;
  }

  async publicKey(environment: PaymentEnvironment): Promise<KeyObject> {
    const source =
      environment === "mock"
        ? `mock:${this.runtime.mockBaseUrl}`
        : environment === "sandbox"
          ? `file:${this.runtime.sandboxCertificatePath ?? ""}`
          : "production";
    const cached = this.cache.get(source);
    if (cached) return cached;
    let pem: string;
    try {
      if (environment === "mock") {
        const response = await fetch(`${this.runtime.baseUrl("mock")}/__mock/certificate`, {
          signal: AbortSignal.timeout(this.runtime.httpTimeoutMs),
          redirect: "error",
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        pem = await response.text();
      } else if (environment === "sandbox" && this.runtime.sandboxCertificatePath) {
        pem = await readFile(this.runtime.sandboxCertificatePath, "utf8");
      } else {
        throw new Error("no certificate source");
      }
      const { key } = publicKeyFromPem(pem);
      this.cache.set(source, key);
      return key;
    } catch {
      throw new ProviderNotReady(
        "certificate-unavailable",
        `The ${environment} Daraja certificate is not available`,
      );
    }
  }

  /** Forget cached certificates (a restarted mock server generates a new one). */
  clear() {
    this.cache.clear();
  }
}
