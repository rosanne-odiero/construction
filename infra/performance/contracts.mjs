const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const timestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
const text = (value) => typeof value === "string" && value.length > 0 && !/[\r\n]/.test(value);

export function loadConfig(env, fixture) {
  const baseUrl = env.BASE_URL;
  if (
    !/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(baseUrl ?? "") &&
    !(
      /^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(baseUrl ?? "") &&
      env.APPROVED_LOAD_TARGET === baseUrl
    )
  ) {
    throw new Error("Use a loopback BASE_URL or explicitly approve the exact HTTPS staging target");
  }
  if (env.SYNTHETIC_ONLY !== "yes" || fixture?.synthetic !== true) {
    throw new Error("Load tests require SYNTHETIC_ONLY=yes and a synthetic fixture");
  }
  const vus = Number(env.VUS ?? 5);
  if (!Number.isInteger(vus) || vus < 1 || vus > 50) throw new Error("VUS must be 1..50");
  if (!["attendance", "payroll-snapshot"].includes(fixture.workload)) {
    throw new Error("Unsupported workload; no payout transport is implemented");
  }
  if (!Array.isArray(fixture.samples) || fixture.samples.length < vus) {
    throw new Error("Provide at least one distinct sample per VU");
  }
  const ids = new Set();
  for (const sample of fixture.samples) {
    if (
      !text(sample.cookie) ||
      !text(sample.csrfToken) ||
      !/^https?:\/\/[^/\s]+$/.test(sample.origin ?? "")
    ) {
      throw new Error("Every sample needs a session cookie, CSRF token and exact WEB_ORIGIN");
    }
    const id = fixture.workload === "attendance" ? sample.body?.event?.id : sample.batchId;
    if (!uuid.test(id ?? "") || (fixture.workload === "attendance" && ids.has(id))) {
      throw new Error("Sample IDs must be UUIDs; attendance event IDs must be unique");
    }
    ids.add(id);
    if (fixture.workload === "attendance") {
      if (
        !["confirmed", "quarantined"].includes(sample.expectedStatus) ||
        !/^[0-9a-f]{128}$/i.test(sample.body?.signature ?? "") ||
        typeof sample.body?.photoBase64 !== "string"
      ) {
        throw new Error("Attendance samples need signed evidence and an explicit expected status");
      }
    } else if (!/^[0-9a-f]{64}$/i.test(sample.digest ?? "")) {
      throw new Error("Payroll samples need the expected submitted snapshot digest");
    }
  }
  return { baseUrl, vus, workload: fixture.workload, count: fixture.samples.length };
}

export function validReceipt(body, sample) {
  return (
    body !== null &&
    typeof body === "object" &&
    Object.keys(body).sort().join(",") === "eventId,flags,receiptId,receivedAt,recordId,status" &&
    body.eventId === sample.body.event.id &&
    uuid.test(body.receiptId) &&
    timestamp(body.receivedAt) &&
    body.status === sample.expectedStatus &&
    Array.isArray(body.flags) &&
    body.flags.every((flag) => typeof flag === "string") &&
    (body.recordId === null || uuid.test(body.recordId))
  );
}

export function sameReceipt(first, retry) {
  return (
    first.eventId === retry.eventId &&
    first.receiptId === retry.receiptId &&
    first.receivedAt === retry.receivedAt &&
    first.status === retry.status &&
    first.recordId === retry.recordId &&
    JSON.stringify(first.flags) === JSON.stringify(retry.flags)
  );
}

export function validSnapshot(body, sample) {
  return (
    body?.batchId === sample.batchId &&
    body.status === "submitted" &&
    body.matches === true &&
    body.digest === sample.digest &&
    body.recomputedDigest === sample.digest &&
    Number.isInteger(body.version) &&
    body.version >= 1 &&
    body.snapshot !== null &&
    typeof body.snapshot === "object" &&
    !Array.isArray(body.snapshot)
  );
}
