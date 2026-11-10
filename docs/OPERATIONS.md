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

## Capacity and costs

Before pilot approval, estimate monthly database/backup, private storage/versioning, egress, SMS/USSD/WhatsApp, monitoring/log retention, support and hardware costs at one-site and growth volumes. Obtain current supplier prices and explicitly record assumptions; there is no verified quote yet.

Set tenant quotas for storage/uploads, exports and notifications; limit archive expansion, file size and expensive queries. Define retention/legal holds by data class across devices, exports, objects and backups. Test deletion propagation without destroying required immutable financial evidence.
