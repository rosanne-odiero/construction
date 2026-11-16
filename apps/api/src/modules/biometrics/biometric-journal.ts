import { Logger } from "@nestjs/common";
import type { TenantScope } from "../identity/tenant-scope.service.js";

/** Defers work until the transaction commits (TenantScope). */
export type AfterCommit = Pick<TenantScope, "afterCommit">;

const logger = new Logger("BiometricJournal");

/**
 * The biometric journal (DPIA_TEMPLATE §8): one log line per template deletion, consent
 * withdrawal and DPIA withdrawal, with IDs and reasons only, written once the transaction has
 * committed. Those records live in the database, so a restore to an earlier point loses the later
 * ones; these lines, kept by the log pipeline outside the database backups, are what the restore
 * procedure replays before the system goes live (docs/OPERATIONS.md).
 */
export function journal(after: AfterCommit, line: string): void {
  after.afterCommit(() => logger.log(line));
}
