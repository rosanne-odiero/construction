import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("./load.mjs", import.meta.url));

async function smoke(workload, broken = false, delayMs = 0) {
  const directory = await mkdtemp(join(tmpdir(), "pmb-k6-"));
  const requests = [];
  const server = createServer(async (req, res) => {
    let payload = "";
    for await (const chunk of req) payload += chunk;
    requests.push({ path: req.url, method: req.method, payload });
    const authorised =
      req.headers.cookie === "pmb_at=synthetic" &&
      req.headers["x-csrf-token"] === "synthetic" &&
      req.headers.origin === "http://localhost:3000";
    res.setHeader("Content-Type", "application/json");
    if (!authorised) {
      res.writeHead(403).end("{}");
      return;
    }
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (workload === "attendance") {
      const { event } = JSON.parse(payload);
      res.end(
        JSON.stringify({
          eventId: event.id,
          receiptId: event.id,
          receivedAt: "2026-11-16T00:00:00.000Z",
          status: broken ? "quarantined" : "confirmed",
          flags: [],
          recordId: null,
        }),
      );
    } else {
      res.end(
        JSON.stringify({
          batchId: req.url.split("/").at(-2),
          status: "submitted",
          version: 1,
          digest: "a".repeat(64),
          recomputedDigest: "a".repeat(64),
          matches: !broken,
          snapshot: {},
        }),
      );
    }
  });
  let child;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const samples = Array.from({ length: 4 }, (_, index) => {
      const id = `00000000-0000-4000-8000-00000000000${index}`;
      return {
        cookie: "pmb_at=synthetic",
        csrfToken: "synthetic",
        origin: "http://localhost:3000",
        expectedStatus: "confirmed",
        body: { event: { id }, signature: "a".repeat(128), photoBase64: "/9j/" },
        batchId: id,
        digest: "a".repeat(64),
      };
    });
    const fixture = join(directory, "fixture.json");
    await writeFile(fixture, JSON.stringify({ synthetic: true, workload, samples }), {
      mode: 0o600,
    });
    child = spawn(process.env.K6_BIN ?? "k6", ["run", "--quiet", script], {
      env: {
        ...process.env,
        FIXTURE: fixture,
        BASE_URL: `http://127.0.0.1:${address.port}`,
        SYNTHETIC_ONLY: "yes",
        VUS: "2",
        K6_NO_USAGE_REPORT: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8").on("data", (chunk) => {
        output += chunk;
      });
    }
    const timer = setTimeout(() => child.kill("SIGTERM"), 30_000);
    let code;
    try {
      [code] = await once(child, "exit");
    } finally {
      clearTimeout(timer);
    }
    assert.equal(code, broken || delayMs ? 99 : 0, output);
    if (!broken) {
      assert.equal(requests.length, workload === "attendance" ? 8 : 4);
      for (const sample of samples) {
        if (workload === "attendance") {
          const pair = requests.filter(
            (request) => JSON.parse(request.payload).event.id === sample.body.event.id,
          );
          assert.equal(pair.length, 2);
          assert.equal(pair[0].payload, pair[1].payload);
          assert.ok(
            pair.every(
              (request) =>
                request.method === "POST" && request.path === "/api/v1/attendance/capture/events",
            ),
          );
        } else {
          assert.ok(
            requests.some(
              (request) =>
                request.method === "GET" &&
                request.path === `/api/v1/payroll/batches/${sample.batchId}/snapshot`,
            ),
          );
        }
      }
    }
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

for (const workload of ["attendance", "payroll-snapshot"]) {
  test(`k6 ${workload} sends every sample exactly once (attendance retry twice)`, () =>
    smoke(workload));
  test(`k6 ${workload} fails its thresholds on incorrect business evidence`, () =>
    smoke(workload, true));
}

test("k6 rejects correct but two-second responses exceeding its latency budget", () =>
  smoke("payroll-snapshot", false, 2000));
