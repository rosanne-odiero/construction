import { Injectable } from "@nestjs/common";
import type { PaymentEnvironment } from "@pm-buddy/types";
import { AppConfig } from "../../config/app-config.js";

/** One parsed allow-list entry: an exact address or an IPv4 CIDR block. */
type AllowEntry = { address: string } | { network: number; mask: number };

const ipv4 = (value: string): number | null => {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    result = result * 256 + Number(part);
  }
  return result;
};

export function parseAllowList(raw: string | undefined): AllowEntry[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry): AllowEntry => {
      const [address, bits] = entry.split("/");
      if (bits === undefined) return { address: address! };
      const base = ipv4(address!);
      const length = Number(bits);
      if (base === null || !Number.isInteger(length) || length < 0 || length > 32)
        throw new Error(`PAYMENTS_CALLBACK_IP_ALLOWLIST has an invalid entry: ${entry}`);
      const mask = length === 0 ? 0 : (0xffffffff << (32 - length)) >>> 0;
      return { network: (base & mask) >>> 0, mask };
    });
}

export function allowedSource(entries: readonly AllowEntry[], ip: string | undefined): boolean {
  if (entries.length === 0) return true;
  if (!ip) return false;
  const address = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  const numeric = ipv4(address);
  return entries.some((entry) =>
    "address" in entry
      ? entry.address === address
      : numeric !== null && (numeric & entry.mask) >>> 0 === entry.network,
  );
}

/**
 * Payments runtime settings from the validated environment (docs/CONFIGURATION.md §4, §8). The
 * provider base URLs come only from configuration, never from company input (no SSRF through
 * settings). Fields are plain properties so the e2e suite can point them at an in-process mock.
 */
@Injectable()
export class PaymentsRuntime {
  workersEnabled: boolean;
  callbackBaseUrl: string;
  mockBaseUrl: string;
  sandboxBaseUrl: string;
  sandboxCertificatePath: string | undefined;
  httpTimeoutMs: number;
  leaseSeconds: number;
  resultTimeoutSeconds: number;
  statusQueryIntervalSeconds: number;
  statusQueryMax: number;
  relayIntervalMs: number;
  outboxMaxAttempts: number;
  maxCallbackBytes: number;
  readonly allowList: AllowEntry[];
  readonly production: boolean;

  constructor(config: AppConfig) {
    this.production = config.isProduction;
    this.workersEnabled = config.get("PAYMENTS_WORKERS_ENABLED");
    this.callbackBaseUrl =
      config.get("PAYMENTS_CALLBACK_BASE_URL") ?? `http://localhost:${config.get("PORT")}`;
    this.mockBaseUrl = config.get("DARAJA_MOCK_BASE_URL");
    this.sandboxBaseUrl = config.get("DARAJA_SANDBOX_BASE_URL");
    this.sandboxCertificatePath = config.get("DARAJA_SANDBOX_CERTIFICATE_PATH");
    this.httpTimeoutMs = config.get("DARAJA_HTTP_TIMEOUT_MS");
    this.leaseSeconds = config.get("PAYMENTS_SUBMIT_LEASE_SECONDS");
    this.resultTimeoutSeconds = config.get("PAYMENTS_RESULT_TIMEOUT_SECONDS");
    this.statusQueryIntervalSeconds = config.get("PAYMENTS_STATUS_QUERY_INTERVAL_SECONDS");
    this.statusQueryMax = config.get("PAYMENTS_STATUS_QUERY_MAX");
    this.relayIntervalMs = config.get("PAYMENTS_RELAY_INTERVAL_MS");
    this.outboxMaxAttempts = config.get("PAYMENTS_OUTBOX_MAX_ATTEMPTS");
    this.maxCallbackBytes = config.get("PAYMENTS_CALLBACK_MAX_BYTES");
    this.allowList = parseAllowList(config.get("PAYMENTS_CALLBACK_IP_ALLOWLIST"));
    // A lease shorter than the HTTP timeout would let the watchdog act on a call still in flight.
    if (this.leaseSeconds * 1000 < this.httpTimeoutMs + 5_000)
      throw new Error("PAYMENTS_SUBMIT_LEASE_SECONDS must exceed DARAJA_HTTP_TIMEOUT_MS by 5 s");
    if (this.production && !config.get("PAYMENTS_CALLBACK_BASE_URL"))
      throw new Error("Production requires PAYMENTS_CALLBACK_BASE_URL (public HTTPS)");
  }

  /** The Daraja base URL of an environment; production is not wired in this deliverable. */
  baseUrl(environment: PaymentEnvironment): string {
    if (environment === "mock") {
      if (this.production) throw new Error("The mock Daraja environment is refused in production");
      return this.mockBaseUrl.replace(/\/$/, "");
    }
    if (environment === "sandbox") return this.sandboxBaseUrl.replace(/\/$/, "");
    throw new Error("The Daraja production environment is not enabled (CR-PMT-04)");
  }

  callbackUrl(token: string, segment: string): string {
    return `${this.callbackBaseUrl.replace(/\/$/, "")}/api/v1/payments/hooks/${token}/${segment}`;
  }
}
