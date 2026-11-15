import { Logger } from "@nestjs/common";

/**
 * Authentication outcomes as structured log entries (ASVS 5.0.0 V16.3.1, ARCHITECTURE §4.17,
 * D-154). They carry IDs, the method and a reason code only: never an identifier (email or phone),
 * password, PIN, code, token or IP address beyond what the request log already holds. Each request
 * log line also names the user, session and company (common/logging.ts), so these entries and the
 * 401/403/429 request lines together form the authentication and authorisation trail.
 */
export type SecurityEventName =
  | "auth.login.succeeded"
  | "auth.login.failed"
  | "auth.login.locked"
  | "auth.mfa.succeeded"
  | "auth.mfa.failed"
  | "auth.mfa.locked"
  | "auth.password.reset"
  | "auth.password.changed"
  | "auth.password.change_failed"
  | "auth.session.refresh_reused"
  | "auth.session.revoked"
  | "auth.logout";

export type AuthMethod =
  "password" | "pin" | "google" | "totp" | "totp-enrolment" | "recovery-code" | "passkey";

export type SecurityEventFields = {
  userId?: string;
  sessionId?: string;
  method?: AuthMethod;
  /** A short stable code such as `wrong-password`, `unknown-account` or `locked`. */
  reason?: string;
};

const logger = new Logger("SecurityEvent");

const WARN = new Set<SecurityEventName>([
  "auth.login.failed",
  "auth.login.locked",
  "auth.mfa.failed",
  "auth.mfa.locked",
  "auth.password.change_failed",
  "auth.session.refresh_reused",
]);

export function securityEvent(event: SecurityEventName, fields: SecurityEventFields = {}): void {
  const entry = { securityEvent: event, ...fields };
  if (WARN.has(event)) logger.warn(entry);
  else logger.log(entry);
}
