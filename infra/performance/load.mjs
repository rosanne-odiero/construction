import http from "k6/http";
import exec from "k6/execution";
import { check, fail } from "k6";
import { SharedArray } from "k6/data";
import { Counter } from "k6/metrics";
import { loadConfig, sameReceipt, validReceipt, validSnapshot } from "./contracts.mjs";

const samples = new SharedArray("synthetic workload", () => {
  const fixture = JSON.parse(open(__ENV.FIXTURE));
  return [{ config: loadConfig(__ENV, fixture) }, ...fixture.samples];
});
const config = samples[0].config;
const completed = new Counter("completed_samples");
const valid = new Counter("valid_samples");

export const options = {
  scenarios: {
    workload: {
      executor: "shared-iterations",
      vus: config.vus,
      iterations: config.count,
      maxDuration: "5m",
    },
  },
  // Never emit per-event URLs, cookie values, IDs or provider payloads in metric tags.
  systemTags: ["status", "method", "name", "scenario", "expected_response"],
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<800", "p(99)<1500"],
    checks: ["rate==1"],
    completed_samples: [`count==${config.count}`],
    valid_samples: [`count==${config.count}`],
    dropped_iterations: ["count==0"],
    ...(config.workload === "attendance"
      ? {
          "http_req_duration{name:attendance-new}": ["p(95)<800", "p(99)<1500"],
          "http_req_duration{name:attendance-retry}": ["p(95)<800", "p(99)<1500"],
        }
      : {}),
  },
};

function decode(response) {
  if (
    response.status !== 200 ||
    !String(response.headers["Content-Type"]).includes("application/json")
  ) {
    fail("Expected a JSON HTTP 200 response; inspect redacted API logs by request ID");
  }
  return response.json();
}

export default function () {
  const sample = samples[exec.scenario.iterationInTest + 1];
  const params = {
    headers: {
      Cookie: sample.cookie,
      Origin: sample.origin,
      "X-CSRF-Token": sample.csrfToken,
      "Content-Type": "application/json",
    },
    timeout: "10s",
    redirects: 0,
    tags: { name: config.workload === "attendance" ? "attendance-new" : config.workload },
  };
  // Each sample carries its own session; never reuse response cookies across synthetic users.
  http.cookieJar().clear(config.baseUrl);
  let success;
  if (config.workload === "attendance") {
    const url = `${config.baseUrl}/api/v1/attendance/capture/events`;
    const payload = JSON.stringify(sample.body);
    const first = decode(http.post(url, payload, params));
    if (
      !check(first, {
        "initial receipt matches signed event": (body) => validReceipt(body, sample),
      })
    ) {
      fail("Invalid initial attendance receipt");
    }
    const retry = decode(
      http.post(url, payload, { ...params, tags: { name: "attendance-retry" } }),
    );
    success = check(retry, {
      "retry returns the original durable receipt": (body) =>
        validReceipt(body, sample) && sameReceipt(first, body),
    });
  } else {
    const body = decode(
      http.get(`${config.baseUrl}/api/v1/payroll/batches/${sample.batchId}/snapshot`, params),
    );
    success = check(body, {
      "submitted snapshot remains intact": (value) => validSnapshot(value, sample),
    });
  }
  completed.add(1);
  if (success) valid.add(1);
}
