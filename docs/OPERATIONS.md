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

## Key rotation

Application keys, what each protects and its cryptoperiod are in [SECURITY_CHECKLIST §5.5](./SECURITY_CHECKLIST.md#55-cryptographic-inventory-and-key-management-v1111-v1112). Generate keys on the operator's machine (`openssl rand -hex 32`; signing keys `openssl genpkey -algorithm ed25519 | base64`), store them only in the secrets manager, and never paste key material into tickets, chat, documents or this file. Every `keys:rotate rewrap` run is recorded in `key_rotation_runs` (operator, target version, counts, unreadable rows by reference); write the run IDs in the change record.

`keys:rotate` (`apps/api/src/keys/main.ts`) runs from `apps/api` with the API's key variables and **`DATABASE_MIGRATION_URL`** (the schema owner; it refuses `pmb_app`). It prints counts, never values:

```sh
pnpm --filter @pm-buddy/api keys:rotate status [--tenant <company ID>]
pnpm --filter @pm-buddy/api keys:rotate rewrap --operator "<your name>" [--only field|mfa] [--tenant <company ID>] [--batch 200] [--dry-run]
```

`rewrap` re-encrypts, company by company, every field value (and with `--only mfa` or by default every sealed TOTP seed) that is not on the active key version. It is safe to stop and run again: each batch is a transaction, each update compares the old value first (a value the application changed meanwhile is left alone) and only values on another version are selected. It exits with status 1 if any value could not be read (wrong or missing key, tampered row); those rows are listed by table and ID.

### Field encryption and sealing keys (`FIELD_ENCRYPTION_KEYS`, `AUTH_MFA_ENCRYPTION_KEY`)

1. Generate the new key (version `n+1`) and add it to the secrets manager next to the current one.
2. Deploy every API instance with both versions and the **current one still active**: `FIELD_ENCRYPTION_KEYS=<n>:…,<n+1>:…` with `FIELD_ENCRYPTION_ACTIVE_KEY_VERSION=<n>`; `AUTH_MFA_ENCRYPTION_KEY=<n>:…,<n+1>:…` with `AUTH_MFA_ENCRYPTION_ACTIVE_KEY_VERSION=<n>` (a single 64-hex `AUTH_MFA_ENCRYPTION_KEY` is version 1). Wait until every instance runs it.
3. Deploy again with `<n+1>` active. New values now use the new key and every instance can already read them; old values still read. (Doing steps 2 and 3 in one deploy lets instances still on the old configuration meet values they cannot read during the roll-out: refused CSRF tokens, failed TOTP checks, failed identifier reveals.)
4. `keys:rotate status`, then `rewrap --dry-run` (every old value must read), then `rewrap`; repeat until `status` shows only the new version.
5. Deploy without the old version. Check sign-in with TOTP and a labourer identifier reveal.
6. Move the old key to "restore only" in the secrets manager (backups taken before step 4 still need it), and destroy it when the backup retention period has passed.

Short-lived values sealed with the old MFA key (CSRF tokens, the Google sign-in cookie) simply expire; the web app fetches a new CSRF token before each change.

### Token signing key (`AUTH_SIGNING_PRIVATE_KEY`)

Replace the key and restart every API instance. Access tokens signed with the old key are refused (401); browsers refresh once with their opaque refresh token, which no key protects, and carry on. Server-rendered pages bounce through `/sign-in` and resume the session without asking for credentials. Keep the old key nowhere: nothing stored depends on it.

### PIN pepper (`AUTH_PIN_PEPPER_KEYS`)

Add the new version everywhere with the active version unchanged, then make it active (two deploys, so instances never disagree). Each correct PIN sign-in re-hashes the PIN under the active version; `keys:rotate status` shows how many PINs remain on each version (`pinPepper`). Remove an old version only when its count is zero, or accept that the labourers still on it must reset their PIN by SMS (a PIN whose version is not listed can no longer sign in, and a warning names the version).

### Blind-index key (`FIELD_BLIND_INDEX_KEY`): not rotatable

Blind indexes carry no version, and approved payroll lines keep payee-phone indexes whose plaintext is not stored, so a new key cannot be rolled in safely (OR-21). If the key is suspected leaked, treat it as a personal-data incident (DPIA §10): the attacker also needs the database to use it. Recovery needs a planned maintenance window with the API stopped: recompute `labourers.id_number_bidx`, `phone_bidx`, `kra_pin_bidx`, `suppliers.kra_pin_bidx` and `supplier_contacts.phone_bidx` from the decrypted values under the new key, and record that payroll snapshots before that date carry indexes under the old key. Versioned blind indexes are the recommended fix before real personal data is stored.

### Emergency: sign everyone out

Until the operations view exists (D9.3), revoke every session as the schema owner, then rotate the signing key: `UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL;` (one company: add `AND active_tenant_id = '<company ID>'`). Users sign in again; nothing else changes. Record who ran it and why.

### Drill on the development database (14/11/2026, D9.1)

Run against the `pmb-pin` development stack (database `pmb`, seeded demo company) with throwaway keys generated for the drill and kept outside the repository. API on port 4500, schema owner `pmb_migrator`. Commands as run, with the keys passed as environment variables (values omitted):

| Step | Command | Result |
|---|---|---|
| 0 | `prisma migrate deploy` (migration `20261202090000_key_rotation`) | Applied |
| 1 | `keys:rotate status` (current keys: field v1, sealing v1, no PIN pepper) | Field values on v1: 40 ID numbers, 39 labourer phones, 18 labourer KRA PINs, 1 do-not-rehire reason, 2 supplier KRA PINs, 1 contact phone, 1 bank account number (102); TOTP seeds on v1: 2; PINs: none |
| 2 | API started with signing key A; PM signed in and the session saved; owner signed in with password and TOTP and revealed 9 identifiers of 3 labourers | 9/9 revealed; fingerprint of the values `93734da065a5e968` |
| 3 | API restarted with `FIELD_ENCRYPTION_KEYS=1:…,2:…` (active 2), `AUTH_MFA_ENCRYPTION_KEY=1:…,2:…` (active 2) and signing key B | Old access token → 401; `POST /auth/refresh` → 200; new token → 200 (signing-key rotation). Owner TOTP sign-in → 200; reveals → same fingerprint |
| 4 | `keys:rotate rewrap --operator "D9.1 drill (Copilot agent)" --dry-run` | field: 102 on an older key, 0 written, 0 unreadable; mfa: 2, 0, 0 |
| 5 | `keys:rotate rewrap --operator "D9.1 drill (Copilot agent)" --batch 25` | field: 102 re-encrypted, 0 unreadable; mfa: 2 re-encrypted, 0 unreadable (exit 0) |
| 6 | Same command again | 0 on an older key (idempotent) |
| 7 | API restarted with version 2 only | Owner TOTP sign-in → 200; reveals → same fingerprint; `status`: every value on v2 |
| 8 | `rewrap --dry-run` with only the old version 1 keys | field: 102 unreadable; mfa: 2 unreadable (exit 1): the retired keys read nothing |
| 9 | `apps/api/.env` switched to the version 2 keys | Development API and web walk (dashboard, projects, uploads, downloads, portals) normal |

`key_rotation_runs` holds the eight runs (field and TOTP each: a dry run, the rewrap, the empty rerun and the retired-key check). The same sequence runs automatically in `apps/api/test/key-rotation.e2e-spec.ts` for every encrypted column and the TOTP seeds, and also proves that `pmb_app` cannot use the re-encryption path and that the owner cannot change anything else on immutable rows.
