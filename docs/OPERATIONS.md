# PM-Buddy: Operations and recovery

Pre-production operating design and portable D9 tooling. Operational owners and thresholds below must be assigned/approved before a live pilot. A synthetic PostgreSQL PITR drill has passed; no production or coherent application recovery has been rehearsed. Cloud-specific Terraform is **deferred by owner choice** until the hosting cloud, region and transfer controls are approved. Nothing here authorises deployment, real notifications, money movement or a live pilot.

## D9 implementation and acceptance gates

| Area | Implemented | Not yet accepted |
|---|---|---|
| D9.2 load | Real k6 attendance ingestion + exact-byte retry/immutable receipt checks; submitted payroll snapshot integrity reads; bounded concurrency, latency/error/correctness/completion thresholds | Representative API load measurement, approved budgets, sustained/soak testing and browser/3G budgets |
| D9.2 tuning | Measurement and query-plan procedure below; fresh writes and retries have separate latency thresholds | No index/pool change is justified without a measured bottleneck and before/after evidence |
| D9.2 outages | Automated SMS 429, 503 and connection-reset refusal/recovery tests; existing timeout test; no automatic transport retries | M-Pesa transport, durable callback inbox and payout workers are absent (D4.2/D4.3); their outage and payout load tests are blocked, not simulated as passed |
| D9.3 recovery | Disposable physical base backup + archived-WAL point-in-time recovery, manifest verification, pre-/post-target data assertions and cleanup | Managed/offsite encrypted backups, retention/freshness alerts and coherent application/object/key recovery |
| D9.3 monitoring | Blackbox liveness/readiness probes, five Prometheus alerts with rule tests, importable Grafana dashboard | Alertmanager delivery/routing, business metrics, production scrape/network/auth configuration and external dead-man check |
| D9.3 operations | Deployment, dependency/provider incident, restore and breach runbooks below; portable checks in CI | Chosen-cloud Terraform, live rehearsal, named owners and independent sign-off |
| D9.3 access log | Every signed-in request in a company (reads, changes, refusals) recorded with IDs, outcome and request ID; 365-day purge; **Access log** report; append-only, RLS and purge e2e-tested | Alert routing for dropped entries, USSD sessions, compliance sign-off on IP processing and retention (CR-DP-13) |

Neither D9.2 nor D9.3 is marked complete by these portable checks.

## Load testing and measured tuning

Use k6 1.0.0 or a validated newer version. Run only on an isolated environment with synthetic workers, camera images, accounts and payment data. Do not copy production cookies, worker photographs, phone numbers or database records. Disable real notification delivery and do not configure real payment credentials. Obtain explicit target-owner approval and a time window before testing shared staging.

The fixture is a local JSON object:

```json
{
  "synthetic": true,
  "workload": "attendance",
  "samples": [
    {
      "cookie": "<synthetic browser session Cookie header>",
      "csrfToken": "<matching CSRF cookie token>",
      "origin": "http://localhost:3000",
      "expectedStatus": "confirmed",
      "body": {
        "event": "<complete signedAttendanceEventSchema object>",
        "signature": "<128 hex characters signing canonical event JSON>",
        "photoBase64": "<synthetic JPEG matching event.photoSha256>"
      }
    }
  ]
}
```

Replace placeholders with real **synthetic test-environment** values, not strings standing in for objects. Prepare device registrations, current leases, worker cards, engagement/site/geofence/rule data and test sessions through the existing API/test setup. The capture API is not a generic bulk insert: every event must have a valid Ed25519 signature, an authorised device and a matching photo digest. Use independent event/shift IDs and non-conflicting workers/shifts; include paired check-in/out cases where allocation is part of the workload. Do not modify IDs, timestamps or payloads after signing.

Each sample is sent once, then immediately retried with identical signed bytes. Check-ins acknowledge evidence, not payable wages. Set `expectedStatus` explicitly; unexpected quarantine fails the run. Confirm capture/muster counts under the tenant runtime role after the run to prove no extra wage records were allocated. A second run needs **new event IDs**, otherwise it benchmarks only deduplication. Pre-generated evidence must remain inside its lease/session window. At least one sample per VU is required; choose enough distinct samples to exercise fresh writes throughout the test.

For `workload: "payroll-snapshot"`, each sample instead carries `batchId` and the expected 64-hex `digest`, plus the same session/CSRF/origin fields. Use submitted, immutable synthetic batches at representative worker counts. Repeated reads of a batch are allowed. A response passes only if its batch ID, submitted status and both digests match and `matches` is true. **This is not payroll calculation, payout throughput or settlement testing.**

Keep fixtures mode 0600 under ignored `infra/performance/*.local.json`; never commit them or upload them as CI artifacts. The runner does not print response bodies, but k6 debug/HTTP tracing can expose credentials: do not enable it. Delete the exact fixture files and revoke test sessions when finished.

```sh
pnpm test:ops
# Exercises actual k6 against a loopback contract stub, including negative business outcomes:
pnpm test:load-harness

mkdir -p infra/performance/results
SYNTHETIC_ONLY=yes BASE_URL=http://127.0.0.1:4000 VUS=5 \
  FIXTURE="$PWD/infra/performance/attendance.local.json" \
  k6 run --summary-export=infra/performance/results/attendance.json \
  infra/performance/load.mjs
```

Non-loopback targets require HTTPS and `APPROVED_LOAD_TARGET` equal to `BASE_URL` exactly. This is a deliberate operator acknowledgement, **not environment detection**; never approve a production URL. No redirects are followed. Concurrency is 1–50 VUs, iterations equal fixture length and the run is capped at five minutes. Samples are partitioned globally, not selected by per-VU iteration number. Credentials/payloads are shared once in memory rather than replicated in every VU.

Proposed, **unapproved** initial budgets: HTTP p95 <800 ms, p99 <1,500 ms, transport error rate <1%, all business checks passing, all fixture samples valid/completed and no dropped iterations. Fresh attendance writes and retries must also each meet the latency budget independently. Any 401/403/429, malformed response, wrong receipt or mismatch fails; do not discount these as acceptable throughput. Count thresholds prevent an empty/aborted run from passing.

For a capacity report, use at least 1,000 fresh samples at each of 1, 5, 10, 25 and 50 VUs (with fresh fixtures per run), repeat representative runs, then extend the harness explicitly for an approved sustained/soak profile. Record commit, runtime/hardware, topology/replicas, database size and worker counts, fixture counts, VUs, durations, throughput, p50/p95/p99, errors, checks, initial/replay outcomes, request IDs for failures and competing load. Stub smoke timings are never application performance evidence.

Tuning procedure:

1. Capture the baseline with normal RLS, guards, audit, idempotency and provider safety controls enabled. Do not disable them to meet the budget.
2. Correlate slow request IDs with redacted logs/traces. On synthetic staging inspect `pg_stat_activity`, pool waiters, lock waits and `pg_stat_user_tables`/`pg_stat_user_indexes`; use `pg_stat_statements` only when explicitly installed/approved. Watch CPU, memory, storage and WAL growth.
3. Use `EXPLAIN (ANALYZE, BUFFERS)` **only on synthetic data** and inside the same tenant/runtime-role transaction context as the request. ANALYZE executes the statement: never point a write plan at live data. Include cold and warm plans, row estimates and index/write costs. Do not index encrypted identifiers or disable FORCE RLS.
4. Add only the demonstrated missing index/query change in a forward migration with regression tests. Budget the total pool across replicas against database connection capacity; the existing five-second connection acquisition bound is not a throughput guarantee.
5. Rerun identical-sized fresh fixtures and isolation/idempotency tests. Keep before/after plans and metrics; reject changes that merely shift latency to writes, exhaust connections or weaken correctness.

### Provider outage drill

The safe local automated boundary check is:

```sh
pnpm --filter @pm-buddy/api exec vitest run src/modules/notifications/notification.provider.spec.ts
```

It mocks network responses, not provider state. A 429, 503, connection reset or timeout must surface as unconfirmed acceptance/503; a failed send makes one transport call, never a hidden automatic retry. An explicit subsequent send may succeed after recovery. This proves neither handset delivery nor durable worker replay.

Before a future **staging-only** M-Pesa drill, implement/verify durable intake, dispatch pause and reconciliation controls. Use the approved sandbox transport/fault proxy, never a public live provider outage. Inject refusal, rate limit, timeout after acceptance, lost callback, duplicate callback and worker restart separately. Record local attempt/inbox IDs (no recipient data), reservations, provider call counts and outcomes before/after. An uncertain attempt must remain unknown, cannot become paid from HTTP acceptance, and must not be reissued under a fresh idempotency key. Intake must remain durable while processing is stopped. Resume only reconciled work with independent Finance approval. Until those boundaries exist this drill is **blocked**, not an executable payment feature.

## Portable PostgreSQL PITR drill

```sh
pnpm drill:pitr
```

Requires Docker and the pinned PostgreSQL 18.6 image. The script accepts **only** `--synthetic-only`: no database URLs, host paths, existing volume names or credentials. Every invocation creates UUID-named containers/volumes, publishes no ports and uses `--network none`. Trust authentication is confined to these network-isolated synthetic databases; it is not a deployment pattern.

The drill creates a synthetic marker table, takes a streaming physical base backup, runs `pg_verifybackup`, acknowledges another committed marker, creates a named restore target, commits an unwanted later marker and archives the WAL. It copies the base backup into another isolated server, replays archived WAL to that target and promotes. It asserts the base and acknowledged markers survived and the post-target marker did not. Success JSON is emitted **only after cleanup succeeds**; any assertion, Docker/timeout or cleanup failure exits nonzero. Cleanup targets only resource names created by that invocation. Do not use global Docker prune/down commands.

This tests actual physical PITR, **not logical `pg_dump` restore**. It does not back up the application or claim offsite durability, encryption, key recovery, backup retention or a measured production RPO. It never uses the shared development Compose services.

### Recorded rehearsal (16 November 2026, local)

| Check | Result |
|---|---|
| Base backup manifest verified | Passed |
| Data present at base backup restored | Passed |
| Acknowledged write after base backup recovered through archived WAL | Passed |
| Write after chosen restore target excluded | Passed |
| Recovery promoted and drill resources cleaned up | Passed |
| Restore/promotion/assertion interval | 0.93 seconds for a two-row synthetic result; **not production RTO** |
| Complete drill before cleanup | 2.97 seconds |
| k6 contract tests | 4 passed |
| Actual k6 loopback stub tests | 5 passed: attendance/read success, deliberately invalid business evidence and correct-but-over-budget responses |
| Notification provider suite | 29 passed, including three added outage/recovery cases |
| Monitoring validation | Prometheus config/rules and blackbox config valid; alert-rule behavior tests passed |

No CI run, application capacity result, production restore or full-system RPO/RTO sign-off is claimed.

## Monitoring configuration

Portable configurations are in [infra/monitoring](../infra/monitoring). Review probe targets before starting:

```sh
docker compose -f infra/monitoring/compose.yaml config --quiet
docker compose -f infra/monitoring/compose.yaml up -d --wait
curl -fsS http://127.0.0.1:19090/-/ready
```

Prometheus binds loopback only; `MONITORING_PORT` overrides its port. Blackbox is internal. The default targets are the local API on port 4000 using `host.docker.internal`; change both to the approved API origin for another environment. Health success requires HTTP 200 and JSON `status: "ok"`; redirects do not count as health. Readiness covers PostgreSQL, Valkey and object storage; liveness intentionally does not.

Import [dashboard.json](../infra/monitoring/dashboard.json) into an existing Grafana and select its Prometheus data source. It graphs actual `probe_success`, `probe_duration_seconds` and exporter `up` series, **not invented application/payment metrics**. Health-probe latency is not business-request latency. Prometheus local storage in this example is disposable and limited to seven days; provision durable restricted storage before operational use.

[alerts.yml](../infra/monitoring/alerts.yml) covers liveness/readiness failure (two minutes), slow probes (>2 seconds for five minutes), scrape failure and missing health series (two minutes). Rule tests cover firing delays, healthy state, absent series, slow/exporter-failed state and recovery. CI validates configuration, rule behavior and blackbox configuration.

These are **alert definitions, not delivered pages**: no receiver is configured. Before release, provision Alertmanager/authenticated delivery, assign primary/secondary owners, set absolute runbook URLs, and send an end-to-end synthetic firing/resolution notification. Add an external dead-man check: a stopped Prometheus cannot page about itself. Add database backup freshness, storage capacity, real business error/latency, provider/queue/unknown-payment and notification-failure metrics once their producers exist. Do not treat missing instrumentation as zero errors. Traces are already optional through `OTEL_EXPORTER_OTLP_ENDPOINT`; restrict collector access and review redaction/retention before enabling production export.

When finished, stop only this stack with `docker compose -f infra/monitoring/compose.yaml down`; do not stop the shared development stack.

### API or dependency outage

1. Acknowledge, assign incident commander and severity; record UTC times, affected releases/tenants and redacted request IDs. Verify the monitoring path and probe the approved API directly.
2. Compare liveness with readiness. If liveness is healthy but readiness is degraded, inspect individual dependency status in approved internal diagnostics, database connections/locks/capacity, Valkey and storage. Production health responses intentionally hide exception detail.
3. Stop rollout and isolate the failing change. Use only a reviewed, implemented dispatch pause for payments; no generic payment pause flag exists yet. Do not delete obligations, retry unknown payouts, flush queues, disable RLS or weaken security to restore availability.
4. Roll back an application artifact only if compatible with the current schema/configuration. For data damage follow coherent restore, not blind restart/replay.
5. Require dependency recovery, representative authorised reads/writes, tenant isolation and financial consistency checks before resolving. Record actual impact, data exposure/loss, owner and corrective actions.

### Monitoring failure

Check Prometheus targets, configuration reload failures, exporter/network/TLS/DNS and external dead-man delivery. A missing probe is an incident, not healthy service. Independently probe the approved API; do not disable alerts to clear the incident. After repair verify both firing and resolved notifications with a synthetic incident.

## Deployment and rollback runbook

1. Obtain deployment approval, release owner, maintenance/rollback window and migration compatibility review. Cloud Terraform remains blocked on a cloud/region decision; no infrastructure is provisioned by this work.
2. Build the immutable release from its recorded commit using the lockfile. Run CI, focused business acceptance tests and the portable operations job. Do not claim CI success from local results.
3. Verify approved region/transfer assessment, private DB/object endpoints, TLS, allowed proxy/origin configuration, secrets/key versions, independent migrator and no-BYPASSRLS runtime role, quotas, live-provider switches, monitoring delivery and a fresh verified recoverable backup.
4. Apply reviewed migrations **once** with the migration role (`pnpm --filter @pm-buddy/api db:migrate`); never give the runtime DDL/owner privileges. Use expand/contract migrations when the old and new artifacts must overlap.
5. Deploy the recorded artifact with API/web compatibility and graceful shutdown. Check `/api/v1/health/live`, `/api/v1/health/ready`, sign-in/CSRF, one authorised tenant-scoped synthetic workflow and an unauthorised/cross-tenant refusal. Check traces/log redaction and alert delivery.
6. Observe approved error/latency/dependency and financial-invariant gates. On a failed gate stop rollout; restore the last compatible application artifact/configuration. Never auto-run down migrations or restore a database merely to undo an application release.
7. Record commit/artifact, migrations, key/config versions (not values), operator, timings, checks, decision and follow-up. Enabling real payments, biometrics or pilot users still requires separate explicit approval.

## Backup policy and full-system restore drill

Proposed targets remain server RPO ≤15 minutes, RTO ≤4 hours and 35-day backup retention, pending owner/compliance approval and measurement. The synthetic drill proves none of the hosting-policy controls below.

- Use managed PITR or a reviewed physical-backup/WAL archive service with continuous archiving, encrypted offsite storage and failure/freshness alerts against the **last recoverable WAL**, not just the last base-backup timestamp.
- Keep backup deletion privileges separate from application and routine operator credentials. Test restoration with the actual restricted recovery identity and available key versions. Include key/config recovery and expiration monitoring; never store the only key copy with the encrypted backup.
- Retain private object versions/manifests/checksums and preserve DB references consistently. Treat Valkey/queues as rebuildable only where database inbox/outbox state actually makes them so. Do not assume a payment queue implementation exists.
- Review retention, legal holds, deletion propagation, region and cross-border transfer obligations for DB, objects, WAL, logs and keys. Never copy production personal data to an unapproved drill environment.

Run the coherent restore order below quarterly and after material backup/schema/key changes. Record backup/manifest IDs and key **versions**, chosen recovery point, latest acknowledged canary time, restore start, DB/object/config/key readiness, consistency checks, lost acknowledged writes, measured RPO/RTO, queued/unknown work inventory, Finance/incident sign-offs and cleanup. Production acceptance requires application data volume, non-owner RLS tests, audit continuity, balances, attachment checksums and safe provider reconciliation. A green backup job or the two-row PITR exercise alone cannot close Phase 9.

## Suspected data breach runbook

1. Page the incident commander, security lead and designated data-protection/controller contact immediately; record discovery time, facts and uncertainty. Restrict incident evidence to authorised responders.
2. Preserve redacted logs, audit continuity and immutable evidence with access records. Do not destroy logs, expose secrets/worker data in tickets, or copy production data into a developer machine.
3. Contain the affected credential/session/device/route with the least disruptive reviewed control. Rotate compromised keys with a recoverability plan; do not discard encryption keys needed to recover lawful records. Retain safe callback evidence and isolate uncertain financial work.
4. Determine affected controllers/processors, data classes, tenants, time range and likely harm with the data-protection lead. Use the **Access log** report (person, record and period filters) and the audit log, correlated by request ID, to establish who accessed which records and when; keep the exports as restricted evidence. Use the compliance register (CR-DP-04) and approved counsel/controller procedure to determine ODPC, controller and data-subject notifications. The proposed 72-hour controller/regulator clock is **not a verified legal conclusion or permission to wait**; processor deadlines/contact routes also need explicit approval.
5. Track notification decisions, legal basis, recipients, deadlines, decision owner and evidence, without adding personal data to general incident channels. Recover only after containment and validation, monitor recurrence, and retain an independently reviewed incident report and remediation owner.

## Ownership and alerts

| Signal | Proposed threshold / action | Required owner |
|---|---|---|
| Unknown payment | Any item: open reconciliation case, pause affected obligation; escalate after provider-specific SLA | Tenant Finance + payment on-call |
| Reconciliation discrepancy | Any unmatched duplicate/amount/direction mismatch: quarantine, never auto-settle | Independent Finance reviewer |
| Callback inbox / queue lag | Oldest unprocessed item exceeds configured SLA: investigate durable intake and worker health | Backend on-call |
| Sync conflict / lag | Conflict immediate in UI; stale device beyond configured field window | Site supervisor + support |
| Failed notifications | Exhausted retry budget: dead-letter and report; never retry payment | Messaging on-call |
| Backup freshness | Beyond approved RPO or failed job: page operator and block release | Database operator |
| Missing attachments | Any evidence-dependent approval: block and request retry/recovery | Site supervisor / storage operator |

Use aggregate IDs/status labels, not names, phones or other personal data in metrics. Threshold configuration, actual recipient, escalation contact and coverage hours are release prerequisites, not implied by this table.

## Safe triage and support

Use tenant/project-scoped operations views and redacted audit evidence. Support requires an explicit purpose, approved least-privilege grant, expiry and audited access. Platform admin status does not automatically grant payroll/biometric access.

Reprocessing requires a reason, permission, expected version and safe idempotency domain. Financial overrides require independent approval and reconciliation evidence. Never edit a confirmed outcome or bypass an unknown attempt with a new key.

## Access log (who accessed what and when)

Every signed-in API request made in a company (reads, changes and refusals) is recorded once its response finishes (decision D-141). An entry holds:

- the person, their session and sign-in method;
- the HTTP method and route template, such as `GET /api/v1/payroll/batches/:id`;
- record IDs: path parameters, plus query values that are UUIDs (such as `projectId`). When someone switches company, the target company's ID is redacted, so a company's log never names another company the person belongs to;
- the outcome (HTTP status) and the duration;
- the request ID returned to the client as `X-Request-Id`, which the request's audit events share;
- the client IP, but only when `TRUST_PROXY` names the edge proxy.

Request bodies, search text and other query values are never recorded. Requests that never resolve a signed-in session (sign-in attempts, CSRF, health) are not in it, and USSD sessions are not recorded yet. Once a session is resolved, the request log line also carries `userId` and `tenantId`.

To answer an access question, open **Reports → Access log**. It needs company `audit.view` and a recent MFA check, and opening it is itself recorded and audited. Filter by period (at most 92 days, default today), person and record ID. Export to Excel for analysis, or to PDF up to 5,000 rows; more than 20,000 matching rows is refused, so narrow the filters. To see what a request changed, look up its request ID in the audit log.

| Property | Behaviour |
|---|---|
| Storage | `access_events`, with forced RLS per company. `pmb_app` may only insert and read; a trigger refuses any update, delete or truncate for every role |
| Retention | 365 days (`access_log.retention_days`, COMPLIANCE-REVIEW CR-DP-13). Each API instance runs `app.purge_access_events()` five minutes after start and then hourly; the function deletes only older rows. Changing the period needs a reviewed migration. Backups keep purged rows until the backups expire |
| Durability | Entries are written in batches every second, one transaction per company, so a crash can lose the last second. While the database is unreachable, up to 20,000 entries wait and writes back off (up to 30 seconds). Beyond that, and for requests finishing after shutdown has begun, entries are dropped and counted |
| Signals | `Access log write failed … (code)` (warning) and `Access log dropped N entries` (error) in the API log, with counts and codes only. Alert on any dropped entries and on repeated write failures; no receiver is configured yet |

Drain traffic from an instance before stopping it: the final flush runs during shutdown, and requests that finish after it are dropped. Treat the log and its exports as personal data and restricted audit evidence.

## Backup set and coherent restore order

Back up PostgreSQL with PITR, private objects with versioning/retention, configuration and recoverable access to encryption keys. Protect backup credentials separately. Target server-data RPO ≤15 minutes and RTO ≤4 hours pending measured rehearsal; unsynced device data is outside that RPO.

1. Declare incident; stop external payout initiation and disable worker replay. Record current provider account state and incident timeline.
2. Isolate restore environment, use approved credentials and restore key access/configuration.
3. Restore database to the chosen point; restore object versions consistent with references and verify checksums/missing attachments.
4. Validate schema, RLS/runtime role, memberships, financial balances and audit continuity. Inventory inbox/outbox states; do not replay automatically.
5. Query/upload provider outcomes since the restored point, including calls whose local intent/results were lost. Quarantine uncertain and mismatched items; rebuild allocations/journal only through reviewed reconciliation.
6. Reconcile queues/inbox/outbox and unsynced devices against restored state. Release only individually safe work.
7. Obtain incident commander and Finance sign-off before resuming payouts; observe and record actual RPO/RTO and unresolved exposure.

Test a coherent restore, not just backup job success. Never copy production personal data into unapproved development systems.

## Provider outages and payment pause

Keep obligations and reservations; show pending/unknown rather than success. Bound retries, respect provider limits and use dead-letter review. A pause must block new provider calls without deleting queued obligations. Callback intake remains durable while workers are stopped. Notification outages leave confirmed payments unchanged.

## Capacity and costs

Before pilot approval, estimate monthly database/backup, private storage/versioning, egress, SMS/USSD/WhatsApp, monitoring/log retention, support and hardware costs at one-site and growth volumes. Obtain current supplier prices and explicitly record assumptions; there is no verified quote yet.

Set tenant quotas for storage/uploads, exports and notifications; limit archive expansion, file size and expensive queries. Define retention/legal holds by data class across devices, exports, objects and backups. Test deletion propagation without destroying required immutable financial evidence.
