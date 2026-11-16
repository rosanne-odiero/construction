import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  assertLease,
  HttpError,
  isDeviceRevoked,
  MAX_LEASE_MS,
  problemCode,
  Synchronizer,
  type Clock,
  type Identity,
} from "../src/core.ts";
import { androidBootId, leaseClock } from "../src/clock.ts";
import { Store, type Connection, type Database } from "../src/store.ts";
import { serializeDatabase } from "../src/database.ts";
import { siteLeaseRequestSchema } from "@pm-buddy/validation";
import type {
  CaptureReceipt,
  PushAttendanceEvent,
  SignedAttendanceEvent,
  SiteRoster,
} from "@pm-buddy/validation";

const owner: Identity = { userId: "user", tenantId: "tenant", deviceId: "device" };
const wall = Date.parse("2026-11-15T10:00:00Z");
const anchor: Clock = { bootId: "boot", monotonicMs: 1_000, wallMs: wall };
const roster: SiteRoster = {
  lease: {
    id: "lease",
    userId: owner.userId,
    tenantId: owner.tenantId,
    deviceId: owner.deviceId,
    bootId: anchor.bootId,
    serverTime: new Date(wall).toISOString(),
    expiresAt: new Date(wall + MAX_LEASE_MS).toISOString(),
    monotonicMs: anchor.monotonicMs,
    deviceTime: new Date(wall).toISOString(),
  },
  projects: [
    {
      id: "project",
      name: "Project",
      sites: [{ id: "site", name: "Site" }],
      workers: [
        {
          id: "worker",
          name: "Worker",
          cardDigest: "digest",
          engagementStart: "2026-01-01",
          engagementEnd: null,
        },
      ],
    },
  ],
};
const receipt = (id: string): CaptureReceipt => ({
  eventId: id,
  receiptId: `receipt-${id}`,
  receivedAt: new Date(wall).toISOString(),
  status: "confirmed",
  flags: [],
  recordId: null,
});
function fixture() {
  const native = new DatabaseSync(":memory:");
  let fail = "";
  const connection: Connection = {
    async runAsync(sql, ...params) {
      if (fail && sql.includes(fail)) {
        fail = "";
        throw new Error("Injected disk failure");
      }
      return native.prepare(sql).run(...params);
    },
    async getFirstAsync<T>(sql: string, ...params: (string | number | null)[]) {
      return (native.prepare(sql).get(...params) ?? null) as T | null;
    },
    async getAllAsync<T>(sql: string, ...params: (string | number | null)[]) {
      return native.prepare(sql).all(...params) as T[];
    },
  };
  const database: Database = serializeDatabase({
    ...connection,
    async execAsync(sql) {
      native.exec(sql);
    },
  });
  return {
    store: new Store(database),
    failOn: (text: string) => {
      fail = text;
    },
    close: () => native.close(),
    database,
  };
}
function capture(id: string, overrides: Record<string, unknown> = {}) {
  return {
    identity: owner,
    clock: () => anchor,
    id,
    newShiftId: `shift-${id}`,
    projectId: "project",
    siteId: "site",
    workerId: "worker",
    cardDigest: "digest",
    cardToken: `PMB1:${"0".repeat(64)}`,
    method: "qr_card" as const,
    direction: "in" as "in" | "out",
    photoSha256: "0".repeat(64),
    photoBase64: "/9j/2Q==",
    position: null,
    checkpoint: "checkpoint",
    sign: (event: SignedAttendanceEvent, photoBase64: string): PushAttendanceEvent => ({
      event,
      photoBase64,
      signature: "1".repeat(128),
    }),
    ...overrides,
  };
}
async function initialized() {
  const fixtureValue = fixture();
  await fixtureValue.store.initialize();
  await fixtureValue.store.install(owner, roster, "checkpoint", () => anchor);
  return fixtureValue;
}

test("lease is bounded, owner-scoped, same boot and monotonic; wall rollback cannot extend it", () => {
  assert.doesNotThrow(() => assertLease(roster.lease, owner, anchor));
  for (const changed of [
    { ...anchor, bootId: "restarted" },
    { ...anchor, monotonicMs: 999 },
    { ...anchor, monotonicMs: anchor.monotonicMs + MAX_LEASE_MS, wallMs: wall + MAX_LEASE_MS },
    { ...anchor, wallMs: wall - 121_000 },
  ])
    assert.throws(() => assertLease(roster.lease, owner, changed));
  assert.throws(() => assertLease(roster.lease, { ...owner, userId: "other" }, anchor));
  assert.throws(() => assertLease(roster.lease, { ...owner, tenantId: "other" }, anchor));
  assert.throws(() => assertLease(roster.lease, { ...owner, deviceId: "other" }, anchor));
  assert.throws(() =>
    assertLease(
      { ...roster.lease, expiresAt: new Date(wall + MAX_LEASE_MS + 1).toISOString() },
      owner,
      anchor,
    ),
  );
});

test("Android lease clock counts deep sleep and app restarts in one boot, but not reboots or a wound-back clock", () => {
  let elapsed = 5_000;
  let bootCount = 7;
  let now = wall;
  const native = { elapsedRealtimeMs: () => elapsed, bootCount: () => bootCount };
  const start = leaseClock({ platform: "android", native, processBootId: "p1", now: () => now })();
  const request = siteLeaseRequestSchema.parse({
    bootId: start.bootId,
    deviceTime: new Date(now).toISOString(),
    monotonicMs: start.monotonicMs,
  });
  assert.equal(request.bootId, androidBootId(7));
  const lease = { ...roster.lease, bootId: request.bootId, monotonicMs: request.monotonicMs };
  elapsed += 10 * 3_600_000; // asleep overnight: elapsedRealtime keeps counting
  now += 10 * 3_600_000;
  const restarted = leaseClock({
    platform: "android",
    native,
    processBootId: "p2",
    now: () => now,
  });
  assert.doesNotThrow(() => assertLease(lease, owner, restarted()));
  now -= 9 * 3_600_000; // back-dating a capture no longer matches the boot clock
  assert.throws(() => assertLease(lease, owner, restarted()), /clock changed/);
  now += 9 * 3_600_000;
  bootCount += 1;
  elapsed = 60_000;
  assert.throws(() => assertLease(lease, owner, restarted()), /Restart/);
});

test("Android fails closed without the native boot clock; iOS keeps its per-process clock", () => {
  assert.throws(
    leaseClock({ platform: "android", native: null, processBootId: "p" }),
    /Native boot clock missing/,
  );
  const noCount = { elapsedRealtimeMs: () => 1, bootCount: () => null };
  assert.equal(
    leaseClock({ platform: "android", native: noCount, processBootId: "p" })().bootId,
    "p",
  );
  assert.deepEqual(
    leaseClock({
      platform: "ios",
      native: null,
      processBootId: "p",
      now: () => wall,
      monotonic: () => 42,
    })(),
    { bootId: "p", monotonicMs: 42, wallMs: wall },
  );
  assert.notEqual(androidBootId(1), androidBootId(2));
  assert.throws(() => androidBootId(-1), /Invalid/);
});

test("capture and open shift commit atomically; failed shift write leaves no unsigned orphan", async () => {
  const f = await initialized();
  try {
    f.failOn("INSERT INTO shifts");
    await assert.rejects(f.store.capture(capture("in")), /disk failure/);
    assert.equal((await f.store.entries(owner)).length, 0);
    await f.store.capture(capture("in"));
    await assert.rejects(f.store.capture(capture("second-in")), /already checked in/);
    assert.equal((await f.store.entries(owner)).length, 1);
    await assert.rejects(
      f.store.capture(capture("out", { direction: "out", siteId: "wrong-site" })),
      /not in this leased roster/,
    );
  } finally {
    f.close();
  }
});

test("concurrent saves serialize on the keyed connection and cannot create two open shifts", async () => {
  const f = await initialized();
  try {
    const results = await Promise.allSettled([
      f.store.capture(capture("in-one")),
      f.store.capture(capture("in-two")),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.match(String(rejected?.reason), /already checked in/);
    assert.equal((await f.store.entries(owner)).length, 1);
  } finally {
    f.close();
  }
});

test("restart preserves pending bytes and open shift; renewed boot can check out a previous shift", async () => {
  const f = await initialized();
  try {
    await f.store.capture(capture("in"));
    const bytes = (await f.store.entries(owner))[0]!.payload;
    const restarted = new Store(f.database);
    await restarted.initialize();
    const newClock = { ...anchor, bootId: "new-boot", monotonicMs: 12 };
    await assert.rejects(
      restarted.capture(capture("out", { direction: "out", clock: () => newClock })),
      /Restart/,
    );
    assert.equal((await restarted.entries(owner))[0]!.payload, bytes);
    const renewed = {
      ...roster,
      lease: { ...roster.lease, id: "new-lease", bootId: newClock.bootId, monotonicMs: 12 },
    };
    await restarted.install(owner, renewed, "new-checkpoint", () => newClock);
    await restarted.capture(
      capture("out", { direction: "out", clock: () => newClock, checkpoint: "new-checkpoint" }),
    );
    const events = await restarted.entries(owner);
    assert.equal((JSON.parse(events[1]!.payload) as PushAttendanceEvent).event.shiftId, "shift-in");
    assert.equal(
      (JSON.parse(events[1]!.payload) as PushAttendanceEvent).event.leaseId,
      "new-lease",
    );
    await assert.rejects(
      restarted.capture(
        capture("second-out", {
          direction: "out",
          clock: () => newClock,
          checkpoint: "new-checkpoint",
        }),
      ),
      /No matching/,
    );
    assert.equal((await restarted.entries({ ...owner, userId: "other" })).length, 0);
    assert.equal((await restarted.pending({ ...owner, tenantId: "other" })).length, 0);
  } finally {
    f.close();
  }
});

test("overnight checkout validates engagement on the persisted check-in date after restart and lease renewal", async () => {
  const f = await initialized();
  try {
    const endingRoster = structuredClone(roster);
    endingRoster.projects[0]!.workers[0]!.engagementEnd = "2026-11-15";
    await f.store.install(owner, endingRoster, "checkpoint", () => anchor);
    await f.store.capture(capture("in"));

    const tomorrow = { bootId: "next-boot", monotonicMs: 12, wallMs: wall + 86_400_000 };
    const restarted = new Store(f.database);
    const renewed = {
      ...endingRoster,
      lease: {
        ...endingRoster.lease,
        id: "renewed-lease",
        bootId: tomorrow.bootId,
        monotonicMs: tomorrow.monotonicMs,
        serverTime: new Date(tomorrow.wallMs).toISOString(),
        deviceTime: new Date(tomorrow.wallMs).toISOString(),
        expiresAt: new Date(tomorrow.wallMs + MAX_LEASE_MS).toISOString(),
      },
    };
    const startsTomorrow = structuredClone(renewed);
    startsTomorrow.projects[0]!.workers[0]!.engagementStart = "2026-11-16";
    startsTomorrow.projects[0]!.workers[0]!.engagementEnd = null;
    await restarted.install(owner, startsTomorrow, "renewed", () => tomorrow);
    const checkout = capture("out", {
      direction: "out",
      clock: () => tomorrow,
      checkpoint: "renewed",
    });
    await assert.rejects(restarted.capture(checkout), /not active/);
    await restarted.install(owner, renewed, "renewed", () => tomorrow);
    await restarted.capture(checkout);
    const events = await restarted.entries(owner);
    assert.equal((JSON.parse(events[1]!.payload) as PushAttendanceEvent).event.shiftId, "shift-in");
    await assert.rejects(
      restarted.capture(
        capture("new-in", {
          clock: () => tomorrow,
          checkpoint: "renewed",
        }),
      ),
      /not active/,
    );
  } finally {
    f.close();
  }
});

test("snapshot/checkpoint install rolls back together and capture rejects a stale confirmation", async () => {
  const f = await initialized();
  try {
    f.failOn("INSERT INTO snapshots");
    await assert.rejects(
      f.store.install(owner, roster, "new", () => anchor),
      /disk failure/,
    );
    assert.equal((await f.store.snapshot(owner))?.checkpoint, "checkpoint");
    await f.store.install(owner, roster, "new", () => anchor);
    await assert.rejects(f.store.capture(capture("in")), /Roster changed/);
    const changed = structuredClone(roster);
    changed.projects[0]!.workers[0]!.engagementEnd = "2026-11-14";
    await f.store.install(owner, changed, "checkpoint", () => anchor);
    await assert.rejects(f.store.capture(capture("inactive")), /not active/);
  } finally {
    f.close();
  }
});

test("lost response and durable ack failure retry exact bytes; no delete-on-send", async () => {
  const f = await initialized();
  const sync = new Synchronizer();
  try {
    await f.store.capture(capture("in"));
    const sent: string[] = [];
    await assert.rejects(
      sync.run(
        f.store,
        () => owner,
        async (payload) => {
          sent.push(payload);
          throw new Error("response lost");
        },
      ),
      /response lost/,
    );
    assert.equal((await f.store.entries(owner))[0]!.status, "failed");
    f.failOn("UPDATE events SET status=?,receipt=");
    await assert.rejects(
      sync.run(
        f.store,
        () => owner,
        async (payload) => {
          sent.push(payload);
          return receipt("in");
        },
      ),
      /disk failure/,
    );
    await sync.run(
      f.store,
      () => owner,
      async (payload) => {
        sent.push(payload);
        return receipt("in");
      },
    );
    assert.equal(new Set(sent).size, 1);
    assert.equal((await f.store.entries(owner))[0]!.status, "confirmed");
    assert.equal((await f.store.pending(owner)).length, 0);
    assert.equal((await f.store.entries(owner)).length, 1);
  } finally {
    f.close();
  }
});

test("wrong receipt cannot ack; conflict is explicit, blocks dependent sends, and preserves payload", async () => {
  const f = await initialized();
  const sync = new Synchronizer();
  try {
    await f.store.capture(capture("in"));
    await f.store.capture(capture("out", { direction: "out" }));
    await assert.rejects(
      sync.run(
        f.store,
        () => owner,
        async () => receipt("wrong"),
      ),
      /does not match/,
    );
    assert.equal((await f.store.entries(owner))[0]!.receipt, null);
    let sent = 0;
    await assert.rejects(
      sync.run(
        f.store,
        () => owner,
        async () => {
          sent++;
          throw new HttpError(409, "conflict");
        },
      ),
      /conflict/,
    );
    assert.equal(sent, 1);
    assert.deepEqual(
      (await f.store.entries(owner)).map((item) => item.status),
      ["conflicted", "pending"],
    );
    await assert.rejects(f.store.pending(owner), /Conflicted/);
    await f.store.retryConflicts(owner);
    await sync.run(
      f.store,
      () => owner,
      async (payload) => {
        const event = (JSON.parse(payload) as PushAttendanceEvent).event;
        return { ...receipt(event.id), status: "quarantined", flags: ["location_unknown"] };
      },
    );
    assert.deepEqual(
      (await f.store.entries(owner)).map((item) => item.status),
      ["quarantined", "quarantined"],
    );
  } finally {
    f.close();
  }
});

test("identity switch before send or during request cannot transmit/ack under a new user", async () => {
  const f = await initialized();
  try {
    await f.store.capture(capture("in"));
    const sync = new Synchronizer();
    let reads = 0;
    await assert.rejects(
      sync.run(
        f.store,
        () => (++reads === 1 ? owner : { ...owner, userId: "other" }),
        async () => {
          throw new Error("must not send");
        },
      ),
      /Identity changed/,
    );
    let active = owner;
    await assert.rejects(
      sync.run(
        f.store,
        () => active,
        async () => {
          active = { ...owner, tenantId: "another" };
          return receipt("in");
        },
      ),
      /Identity changed/,
    );
    assert.equal((await f.store.entries(owner))[0]!.receipt, null);
    assert.equal((await f.store.entries(owner))[0]!.status, "failed");
  } finally {
    f.close();
  }
});

test("only the server's device-revoked code erases one scope, open shifts and photos included", async () => {
  const f = await initialized();
  try {
    const other = { ...owner, userId: "other-user" };
    await f.store.install(
      other,
      { ...roster, lease: { ...roster.lease, userId: other.userId } },
      "other",
      () => anchor,
    );
    await f.store.capture(capture("other-in", { identity: other, checkpoint: "other" }));
    await f.store.capture(capture("in"));
    await f.store.acknowledge("in", owner, receipt("in"));
    await f.store.capture(capture("out", { direction: "out" }));
    await f.store.capture(capture("in2")); // leaves an open shift referencing a pending event
    assert.deepEqual(await f.store.purge(owner), { unsynced: 2, synced: 1 });
    assert.equal(await f.store.snapshot(owner), null);
    assert.deepEqual(await f.store.counts(owner), {});
    assert.equal((await f.store.entries(other)).length, 1);
    assert.equal((await f.store.snapshot(other))?.checkpoint, "other");
    const secure = await f.database.getFirstAsync<{ secure_delete: number }>(
      "PRAGMA secure_delete",
    );
    assert.equal(secure?.secure_delete, 1);
  } finally {
    f.close();
  }
  assert.equal(
    isDeviceRevoked(new HttpError(403, "x", problemCode({ code: "device-revoked" }))),
    true,
  );
  for (const error of [
    new HttpError(403, "x", problemCode({ code: "forbidden" })),
    new HttpError(409, "x", "device-revoked"),
    new Error("device-revoked"),
  ])
    assert.equal(isDeviceRevoked(error), false);
  assert.equal(problemCode({ code: "Revoked for Amina W." }), null);
  assert.equal(problemCode("device-revoked"), null);
});
