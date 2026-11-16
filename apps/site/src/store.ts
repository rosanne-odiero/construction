import type {
  CaptureReceipt,
  PushAttendanceEvent,
  SignedAttendanceEvent,
  SiteRoster,
} from "@pm-buddy/validation";
import {
  assertCaptureScope,
  assertLease,
  assertPersistedPayload,
  assertShift,
  type Clock,
  type Identity,
  type QueueEntry,
  type QueueStatus,
  type Snapshot,
  type SyncStore,
} from "./core.ts";

type Param = string | number | null;
export interface Connection {
  runAsync(sql: string, ...params: Param[]): Promise<unknown>;
  getFirstAsync<T>(sql: string, ...params: Param[]): Promise<T | null>;
  getAllAsync<T>(sql: string, ...params: Param[]): Promise<T[]>;
}
export interface Database extends Connection {
  execAsync(sql: string): Promise<void>;
  withExclusiveTransactionAsync(task: (tx: Connection) => Promise<void>): Promise<void>;
}
type EventRow = {
  id: string;
  user_id: string;
  tenant_id: string;
  device_id: string;
  payload: string;
  status: QueueStatus;
  error: string | null;
  receipt: string | null;
};
const scope = (identity: Identity): [string, string, string] => [
  identity.userId,
  identity.tenantId,
  identity.deviceId,
];
const where = "user_id = ? AND tenant_id = ? AND device_id = ?";

export class Store implements SyncStore {
  db: Database;
  constructor(db: Database) {
    this.db = db;
  }
  async initialize() {
    await this.db.execAsync(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS snapshots (
        user_id TEXT NOT NULL, tenant_id TEXT NOT NULL, device_id TEXT NOT NULL,
        roster TEXT NOT NULL, checkpoint TEXT NOT NULL,
        PRIMARY KEY (user_id, tenant_id, device_id)
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL, tenant_id TEXT NOT NULL, device_id TEXT NOT NULL,
        payload TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN
          ('pending','failed','conflicted','confirmed','quarantined')),
        receipt TEXT, error TEXT
      );
      CREATE INDEX IF NOT EXISTS events_scope ON events(user_id, tenant_id, device_id, seq);
      CREATE TABLE IF NOT EXISTS shifts (
        user_id TEXT NOT NULL, tenant_id TEXT NOT NULL, device_id TEXT NOT NULL,
        worker_id TEXT NOT NULL, shift_id TEXT NOT NULL PRIMARY KEY,
        project_id TEXT NOT NULL, site_id TEXT NOT NULL, in_event TEXT NOT NULL REFERENCES events(id),
        out_event TEXT REFERENCES events(id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_open_shift
        ON shifts(user_id, tenant_id, device_id, worker_id) WHERE out_event IS NULL;
    `);
    await this.health();
  }
  async health() {
    const result = await this.db.getFirstAsync<Record<string, string>>("PRAGMA quick_check");
    if (!result || Object.values(result)[0] !== "ok") {
      throw new Error(
        "Encrypted database integrity check failed. Preserve the app data and contact support.",
      );
    }
  }
  private async snapshotFrom(tx: Connection, identity: Identity): Promise<Snapshot | null> {
    const row = await tx.getFirstAsync<{ roster: string; checkpoint: string }>(
      `SELECT roster, checkpoint FROM snapshots WHERE ${where}`,
      ...scope(identity),
    );
    return row
      ? { roster: JSON.parse(row.roster) as SiteRoster, checkpoint: row.checkpoint }
      : null;
  }
  snapshot(identity: Identity) {
    return this.snapshotFrom(this.db, identity);
  }
  async install(identity: Identity, roster: SiteRoster, checkpoint: string, clock: () => Clock) {
    await this.health();
    await this.db.withExclusiveTransactionAsync(async (tx) => {
      assertLease(roster.lease, identity, clock());
      await tx.runAsync(
        `INSERT INTO snapshots(user_id, tenant_id, device_id, roster, checkpoint) VALUES(?,?,?,?,?)
         ON CONFLICT(user_id,tenant_id,device_id) DO UPDATE SET roster=excluded.roster, checkpoint=excluded.checkpoint`,
        ...scope(identity),
        JSON.stringify(roster),
        checkpoint,
      );
    });
  }
  async capture(input: {
    identity: Identity;
    clock: () => Clock;
    id: string;
    newShiftId: string;
    projectId: string;
    siteId: string;
    workerId: string;
    cardDigest: string;
    cardToken: string;
    direction: "in" | "out";
    method: "qr_card" | "nfc_card";
    photoSha256: string;
    photoBase64: string;
    position: SignedAttendanceEvent["position"];
    checkpoint: string;
    sign: (event: SignedAttendanceEvent, photo: string) => PushAttendanceEvent;
  }): Promise<void> {
    await this.health();
    await this.db.withExclusiveTransactionAsync(async (tx) => {
      const snapshot = await this.snapshotFrom(tx, input.identity);
      if (!snapshot || snapshot.checkpoint !== input.checkpoint) {
        throw new Error("Roster changed. Scan again and confirm the worker.");
      }
      const clock = input.clock();
      const open = await tx.getFirstAsync<{
        shiftId: string;
        projectId: string;
        siteId: string;
        inEvent: string;
      }>(
        `SELECT shift_id AS shiftId, project_id AS projectId, site_id AS siteId, in_event AS inEvent FROM shifts
         WHERE ${where} AND worker_id = ? AND out_event IS NULL`,
        ...scope(input.identity),
        input.workerId,
      );
      let shiftStartedAt: string | undefined;
      if (input.direction === "out" && open) {
        const checkIn = await tx.getFirstAsync<{ payload: string }>(
          `SELECT payload FROM events WHERE id=? AND ${where}`,
          open.inEvent,
          ...scope(input.identity),
        );
        if (!checkIn) throw new Error("Matching local check-in is missing. Outbox retained.");
        shiftStartedAt = (JSON.parse(checkIn.payload) as PushAttendanceEvent).event.capturedAt;
      }
      const worker = assertCaptureScope(
        snapshot,
        input.identity,
        clock,
        input.projectId,
        input.siteId,
        input.workerId,
        shiftStartedAt,
      );
      if (worker.cardDigest !== input.cardDigest)
        throw new Error("Worker card no longer matches the roster.");
      const existing = assertShift(input.direction, open, input.projectId, input.siteId);
      const event: SignedAttendanceEvent = {
        schemaVersion: 1,
        id: input.id,
        deviceId: input.identity.deviceId,
        tenantId: input.identity.tenantId,
        leaseId: snapshot.roster.lease.id,
        projectId: input.projectId,
        siteId: input.siteId,
        bootId: clock.bootId,
        monotonicMs: clock.monotonicMs,
        capturedAt: new Date(clock.wallMs).toISOString(),
        direction: input.direction,
        shiftId: existing ?? input.newShiftId,
        cardToken: input.cardToken,
        method: input.method,
        position: input.position,
        photoSha256: input.photoSha256,
        supervisorConfirmed: true,
      };
      const payload = JSON.stringify(input.sign(event, input.photoBase64));
      await tx.runAsync(
        "INSERT INTO events(id,user_id,tenant_id,device_id,payload,status) VALUES(?,?,?,?,?,'pending')",
        event.id,
        ...scope(input.identity),
        payload,
      );
      if (input.direction === "in") {
        await tx.runAsync(
          "INSERT INTO shifts(user_id,tenant_id,device_id,worker_id,shift_id,project_id,site_id,in_event) VALUES(?,?,?,?,?,?,?,?)",
          ...scope(input.identity),
          worker.id,
          event.shiftId,
          event.projectId,
          event.siteId,
          event.id,
        );
      } else {
        await tx.runAsync(
          `UPDATE shifts SET out_event=? WHERE shift_id=? AND ${where} AND out_event IS NULL`,
          event.id,
          event.shiftId,
          ...scope(input.identity),
        );
      }
    });
  }
  async entries(identity: Identity, summaryOnly = false): Promise<QueueEntry[]> {
    const rows = await this.db.getAllAsync<EventRow>(
      `SELECT id,user_id,tenant_id,device_id,${summaryOnly ? "'' AS payload" : "payload"},status,error,receipt
       FROM (SELECT * FROM events WHERE ${where} ORDER BY seq DESC LIMIT 100) ORDER BY seq`,
      ...scope(identity),
    );
    return rows.map((row) => ({
      id: row.id,
      owner: { userId: row.user_id, tenantId: row.tenant_id, deviceId: row.device_id },
      payload: row.payload,
      status: row.status,
      error: row.error,
      receipt: row.receipt ? (JSON.parse(row.receipt) as CaptureReceipt) : null,
    }));
  }
  async counts(identity: Identity): Promise<Partial<Record<QueueStatus, number>>> {
    const rows = await this.db.getAllAsync<{ status: QueueStatus; count: number }>(
      `SELECT status, COUNT(*) AS count FROM events WHERE ${where} GROUP BY status`,
      ...scope(identity),
    );
    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  }
  async pending(identity: Identity) {
    await this.health();
    const conflict = await this.db.getFirstAsync<{ id: string }>(
      `SELECT id FROM events WHERE ${where} AND status='conflicted' LIMIT 1`,
      ...scope(identity),
    );
    if (conflict) {
      throw new Error(
        "Conflicted events are retained. Resolve permissions/server issue, then explicitly retry conflicts.",
      );
    }
    const rows = await this.db.getAllAsync<EventRow>(
      `SELECT id,user_id,tenant_id,device_id,payload,status,error,receipt FROM events WHERE ${where}
       AND status IN ('pending','failed') ORDER BY seq LIMIT 25`,
      ...scope(identity),
    );
    return rows
      .map((row): QueueEntry => ({
        id: row.id,
        owner: { userId: row.user_id, tenantId: row.tenant_id, deviceId: row.device_id },
        payload: row.payload,
        status: row.status,
        error: row.error,
        receipt: null,
      }))
      .map((entry) => {
        assertPersistedPayload(entry, JSON.parse(entry.payload) as PushAttendanceEvent);
        return entry;
      });
  }
  async acknowledge(id: string, identity: Identity, receipt: CaptureReceipt) {
    if (receipt.eventId !== id) throw new Error("Receipt event mismatch. Outbox retained.");
    await this.db.withExclusiveTransactionAsync(async (tx) => {
      const row = await tx.getFirstAsync<{ receipt: string | null }>(
        `SELECT receipt FROM events WHERE id=? AND ${where}`,
        id,
        ...scope(identity),
      );
      if (!row) throw new Error("Receipt owner mismatch. Outbox retained.");
      if (row.receipt && row.receipt !== JSON.stringify(receipt))
        throw new Error("Conflicting durable receipt.");
      await tx.runAsync(
        `UPDATE events SET status=?,receipt=?,error=NULL WHERE id=? AND ${where}`,
        receipt.status,
        JSON.stringify(receipt),
        id,
        ...scope(identity),
      );
    });
  }
  async mark(id: string, identity: Identity, status: "failed" | "conflicted", error: string) {
    await this.db.runAsync(
      `UPDATE events SET status=?,error=? WHERE id=? AND ${where} AND receipt IS NULL`,
      status,
      error,
      id,
      ...scope(identity),
    );
  }
  async retryConflicts(identity: Identity) {
    await this.db.runAsync(
      `UPDATE events SET status='pending',error=NULL WHERE ${where} AND status='conflicted' AND receipt IS NULL`,
      ...scope(identity),
    );
  }
  /**
   * Erases one revoked device scope (THREAT_MODEL T-38): roster, open shifts and every event with
   * its photo and card token. Returns how many events never reached the server.
   */
  async purge(identity: Identity): Promise<{ unsynced: number; synced: number }> {
    const erased = { unsynced: 0, synced: 0 };
    await this.db.withExclusiveTransactionAsync(async (tx) => {
      const rows = await tx.getAllAsync<{ status: QueueStatus; count: number }>(
        `SELECT status, COUNT(*) AS count FROM events WHERE ${where} GROUP BY status`,
        ...scope(identity),
      );
      for (const row of rows) {
        if (row.status === "confirmed" || row.status === "quarantined") erased.synced += row.count;
        else erased.unsynced += row.count;
      }
      await tx.runAsync(`DELETE FROM shifts WHERE ${where}`, ...scope(identity));
      await tx.runAsync(`DELETE FROM events WHERE ${where}`, ...scope(identity));
      await tx.runAsync(`DELETE FROM snapshots WHERE ${where}`, ...scope(identity));
    });
    await this.db.execAsync("PRAGMA wal_checkpoint(TRUNCATE)");
    return erased;
  }
}
