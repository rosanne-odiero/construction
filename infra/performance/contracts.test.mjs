import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, sameReceipt, validReceipt, validSnapshot } from "./contracts.mjs";

const id = "00000000-0000-4000-8000-000000000001";
const sample = {
  cookie: "pmb_at=synthetic; pmb_csrf=synthetic",
  csrfToken: "synthetic",
  origin: "http://localhost:3000",
  expectedStatus: "confirmed",
  body: { event: { id }, signature: "a".repeat(128), photoBase64: "/9j/" },
};
const fixture = { synthetic: true, workload: "attendance", samples: [sample] };
const env = { BASE_URL: "http://127.0.0.1:4000", SYNTHETIC_ONLY: "yes", VUS: "1" };

test("refuses unapproved, malformed or non-synthetic load targets", () => {
  assert.equal(loadConfig(env, fixture).count, 1);
  for (const BASE_URL of [
    "https://production.example",
    "http://localhost.evil.test",
    "http://localhost:4000/path",
    "http://user:password@localhost",
  ]) {
    assert.throws(() => loadConfig({ ...env, BASE_URL }, fixture));
  }
  assert.equal(
    loadConfig(
      {
        ...env,
        BASE_URL: "https://staging.example",
        APPROVED_LOAD_TARGET: "https://staging.example",
      },
      fixture,
    ).baseUrl,
    "https://staging.example",
  );
  assert.throws(() => loadConfig({ ...env, SYNTHETIC_ONLY: "no" }, fixture));
  assert.throws(() => loadConfig(env, { ...fixture, synthetic: false }));
});

test("refuses duplicate events, header injection, excess concurrency and invented payout routes", () => {
  assert.throws(() => loadConfig(env, { ...fixture, samples: [sample, sample] }));
  assert.throws(() =>
    loadConfig(env, { ...fixture, samples: [{ ...sample, cookie: "x\r\nHost: other" }] }),
  );
  for (const VUS of ["0", "51", "1.5", "NaN"]) {
    assert.throws(() => loadConfig({ ...env, VUS }, fixture));
  }
  assert.throws(() => loadConfig(env, { ...fixture, workload: "payroll-payout" }));
});

test("attendance acceptance checks identity, explicit outcome and immutable retry evidence", () => {
  const body = {
    eventId: id,
    receiptId: id,
    receivedAt: "2026-11-16T00:00:00.000Z",
    status: "confirmed",
    flags: [],
    recordId: null,
  };
  assert.ok(validReceipt(body, sample));
  assert.ok(sameReceipt(body, { ...body }));
  assert.equal(validReceipt({ ...body, status: "quarantined" }, sample), false);
  assert.equal(validReceipt({ ...body, eventId: "another" }, sample), false);
  assert.equal(validReceipt({ ...body, receiptId: null }, sample), false);
  assert.equal(validReceipt({ ...body, receivedAt: "invalid" }, sample), false);
  assert.equal(sameReceipt(body, { ...body, receivedAt: "later" }), false);
  assert.equal(sameReceipt(body, { ...body, flags: ["clock_drift"] }), false);
});

test("payroll read requires the exact submitted digest, never just HTTP success", () => {
  const payroll = { ...sample, batchId: id, digest: "b".repeat(64) };
  const body = {
    batchId: id,
    status: "submitted",
    version: 1,
    digest: payroll.digest,
    recomputedDigest: payroll.digest,
    matches: true,
    snapshot: {},
  };
  assert.ok(validSnapshot(body, payroll));
  assert.equal(validSnapshot({ ...body, status: "draft" }, payroll), false);
  assert.equal(validSnapshot({ ...body, matches: false }, payroll), false);
  assert.equal(validSnapshot({ ...body, recomputedDigest: "c".repeat(64) }, payroll), false);
  assert.equal(
    loadConfig(env, { synthetic: true, workload: "payroll-snapshot", samples: [payroll] }).workload,
    "payroll-snapshot",
  );
});
