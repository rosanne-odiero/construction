import type {
  CaptureReceipt,
  PushAttendanceEvent,
  SiteLease,
  SiteRoster,
} from "@pm-buddy/validation";

export type Identity = { userId: string; tenantId: string; deviceId: string };
export type Clock = { bootId: string; monotonicMs: number; wallMs: number };
export type QueueStatus = "pending" | "failed" | "conflicted" | "confirmed" | "quarantined";
export type QueueEntry = {
  id: string;
  owner: Identity;
  payload: string;
  status: QueueStatus;
  error: string | null;
  receipt: CaptureReceipt | null;
};
export type Snapshot = { roster: SiteRoster; checkpoint: string };
export const MAX_LEASE_MS = 72 * 60 * 60 * 1_000;

export function sameIdentity(a: Identity, b: Identity): boolean {
  return a.userId === b.userId && a.tenantId === b.tenantId && a.deviceId === b.deviceId;
}

export function assertLease(lease: SiteLease, identity: Identity, clock: Clock): void {
  if (
    !sameIdentity(identity, {
      userId: lease.userId,
      tenantId: lease.tenantId,
      deviceId: lease.deviceId,
    })
  )
    throw new Error("Lease belongs to another supervisor, company or device.");
  if (lease.bootId !== clock.bootId)
    throw new Error("Restart detected. Renew the online lease first.");
  const duration = Date.parse(lease.expiresAt) - Date.parse(lease.serverTime);
  const elapsed = clock.monotonicMs - lease.monotonicMs;
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > MAX_LEASE_MS ||
    !Number.isFinite(elapsed) ||
    elapsed < 0 ||
    elapsed >= duration
  ) {
    throw new Error("Offline lease expired or invalid. Renew online.");
  }
  // Neither rolling the wall clock back nor rebooting can extend the monotonic lease.
  const estimated = Date.parse(lease.serverTime) + elapsed;
  if (!Number.isFinite(clock.wallMs) || Math.abs(clock.wallMs - estimated) > 120_000) {
    throw new Error("Device clock changed. Correct the clock and renew online.");
  }
}

export function assertCaptureScope(
  snapshot: Snapshot,
  identity: Identity,
  clock: Clock,
  projectId: string,
  siteId: string,
  workerId: string,
  shiftStartedAt?: string,
) {
  assertLease(snapshot.roster.lease, identity, clock);
  const project = snapshot.roster.projects.find((item) => item.id === projectId);
  const site = project?.sites.find((item) => item.id === siteId);
  const worker = project?.workers.find((item) => item.id === workerId);
  if (!project || !site || !worker) throw new Error("Worker or site is not in this leased roster.");
  const day = new Date(
    shiftStartedAt === undefined
      ? Date.parse(snapshot.roster.lease.serverTime) +
          clock.monotonicMs -
          snapshot.roster.lease.monotonicMs
      : Date.parse(shiftStartedAt),
  )
    .toISOString()
    .slice(0, 10);
  if (day < worker.engagementStart || (worker.engagementEnd && day > worker.engagementEnd)) {
    throw new Error("Worker engagement is not active today.");
  }
  return worker;
}

export function assertShift(
  direction: "in" | "out",
  open: { shiftId: string; projectId: string; siteId: string } | null,
  projectId: string,
  siteId: string,
): string | null {
  if (direction === "in" && open) throw new Error("Worker is already checked in. Check out first.");
  if (direction === "out" && !open)
    throw new Error("No matching local check-in. Use the original device.");
  if (direction === "out" && open && (open.projectId !== projectId || open.siteId !== siteId)) {
    throw new Error("Check out at the site of the open shift.");
  }
  return open?.shiftId ?? null;
}

export class HttpError extends Error {
  status: number;
  code: string | null;
  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Only a well-formed problem code leaves an error body; other content may hold personal data. */
export function problemCode(body: unknown): string | null {
  const code = typeof body === "object" && body !== null ? (body as { code?: unknown }).code : null;
  return typeof code === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(code) ? code : null;
}

/** The server's authoritative statement that this device registration is revoked (T-38). */
export const isDeviceRevoked = (error: unknown): boolean =>
  error instanceof HttpError && error.status === 403 && error.code === "device-revoked";

export interface SyncStore {
  pending(identity: Identity): Promise<QueueEntry[]>;
  acknowledge(id: string, identity: Identity, receipt: CaptureReceipt): Promise<void>;
  mark(
    id: string,
    identity: Identity,
    status: "failed" | "conflicted",
    error: string,
  ): Promise<void>;
}

/** Snapshot payload strings are sent verbatim; identity is rechecked before every send and ack. */
export class Synchronizer {
  private running = false;
  async run(
    store: SyncStore,
    current: () => Identity | null,
    send: (payload: string) => Promise<CaptureReceipt>,
  ): Promise<void> {
    if (this.running) return;
    const identity = current();
    if (!identity) throw new Error("Sign in and select a company before syncing.");
    this.running = true;
    try {
      for (const entry of await store.pending(identity)) {
        const active = current();
        if (!active || !sameIdentity(active, identity) || !sameIdentity(entry.owner, identity)) {
          throw new Error("Identity changed. Outbox preserved; no further events sent.");
        }
        try {
          const receipt = await send(entry.payload);
          if (receipt.eventId !== entry.id)
            throw new Error("Server receipt does not match the saved event.");
          const after = current();
          if (!after || !sameIdentity(after, identity)) {
            throw new Error("Identity changed during sync. Retry under the original identity.");
          }
          await store.acknowledge(entry.id, identity, receipt);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Sync failed.";
          const conflict =
            error instanceof HttpError && [400, 403, 404, 409, 410, 422].includes(error.status);
          await store.mark(entry.id, identity, conflict ? "conflicted" : "failed", message);
          // A missing in-event must never be followed by an out-event on the server.
          throw error;
        }
      }
    } finally {
      this.running = false;
    }
  }
}

export function assertPersistedPayload(entry: QueueEntry, payload: PushAttendanceEvent): void {
  if (
    payload.event.id !== entry.id ||
    payload.event.tenantId !== entry.owner.tenantId ||
    payload.event.deviceId !== entry.owner.deviceId
  ) {
    throw new Error("Outbox integrity failure. Do not send; retain database for recovery.");
  }
}
