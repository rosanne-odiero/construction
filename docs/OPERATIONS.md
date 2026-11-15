# PM-Buddy: Operations and recovery

Pre-production operating design. Operational owners and thresholds below must be assigned/approved before a live pilot. No production recovery has been rehearsed yet.

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

## Payments: queue outage and reconciliation (D4.2)

1. In **Payments → Settings**, pause payouts (`payments.review` or
   `payments.manage_credentials`; no step-up needed to pause). This retains queued work and
   blocks new outbound submissions; callback intake, STK collections and read-only reconciliation
   remain active. To stop every payment worker, set `PAYMENTS_WORKERS_ENABLED=false` and restart
   the API; leave callback intake reachable.
2. Check request timelines, quarantined callbacks and open cases. A timeout is **unknown**, never
   permission to retry the payment with another key. **Query status** is read-only. STK Query
   success without a receipt still needs statement evidence. A reviewer other than the maker,
   with fresh MFA, supplies the exact receipt and amount before manually confirming.
3. If Valkey is unavailable, the relay logs the outage and processes PostgreSQL work directly.
   The inbox and outbox remain durable. After restoring queue access, or with workers disabled,
   run `pnpm --filter @pm-buddy/api build` then
   `pnpm --filter @pm-buddy/api payments:drain`. It runs a bounded number of passes over **due**
   work only; delayed retries may need a later pass. Repeating it does not resubmit an accepted
   or uncertain attempt.
4. Investigate `outbox.dead_lettered` timeline/audit events and the `ALERT payments outbox` log;
   dead-lettered rows are not silently retried by drain. Resolve the cause and use a reviewed
   operator recovery procedure; never directly rewrite attempts or receipts. The console's
   pending-outbox count excludes dead letters, so also monitor these alerts.
5. Unknown callbacks and mismatches need review, not deletion. Dismissing a callback does not
   make a payment confirmed. C2B provider receipts marked **unallocated** are not client-ledger
   receipts. Keep callback URLs and credentials out of support tickets and log exports.
6. Only a credentials manager with fresh MFA can resume payouts. Re-check queued requests before
   resuming: enabling the switch releases eligible queued test transactions.

Callback-token rotation keeps accepting results on the old route for 72 hours (work already in
flight); every provider call made after the rotation, queued payments and status queries for older
attempts included, carries the new route. Update registered C2B URLs after a rotation. For results
arriving later than the overlap, obtain provider evidence and reconcile; never submit the money
movement again. Keep the public HTTPS callback endpoint and the approved source-IP/proxy
configuration under monitoring.

A queued payment waits while its environment or the shortcode it recorded differs from the
settings; it never goes out from another shortcode. D4.2 has no action to cancel a queued attempt:
restore the setting to release it, or leave it queued (it stays in progress in the console).

## Capacity and costs

Before pilot approval, estimate monthly database/backup, private storage/versioning, egress, SMS/USSD/WhatsApp, monitoring/log retention, support and hardware costs at one-site and growth volumes. Obtain current supplier prices and explicitly record assumptions; there is no verified quote yet.

Set tenant quotas for storage/uploads, exports and notifications; limit archive expansion, file size and expensive queries. Define retention/legal holds by data class across devices, exports, objects and backups. Test deletion propagation without destroying required immutable financial evidence.
