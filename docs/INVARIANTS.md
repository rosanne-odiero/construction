# PM-Buddy: Invariants

Design contract. A planned constraint/test is not evidence that it exists. Implementation evidence is tracked in [ACCEPTANCE_MATRIX.md](./ACCEPTANCE_MATRIX.md).

| Invariant | Required enforcement | Proof required / phase |
|---|---|---|
| Tenant data is inaccessible without active membership and project scope | Server-resolved context, permission checks, transaction-local context, forced RLS under a non-owner/no-BYPASSRLS runtime role; composite tenant foreign keys | Two tenants, guessed IDs, revoked membership, pooled-connection reuse and absent context; Phase 1 and every new surface |
| Support has no implicit sensitive-data access | Separate expiring support grant, purpose and audit; no default payroll/biometric permission | Grant expiry/revocation and restricted exports; before support rollout |
| Authentication recovery cannot confer approval authority | Expiring single-use verification/reset/invitation tokens; session revocation, MFA and financial permission checks remain required | Token replay/expiry, membership removal, lost device and recovery; Phase 1 |
| Audit history is append-only and redacted | Runtime UPDATE/DELETE/TRUNCATE denied; insert and business mutation in one transaction; explicit safe metadata allowlist | Direct SQL mutation denied; rollback leaves no orphan audit; sensitive values absent; Phase 1 |
| Approval refers to exactly one unchanged snapshot | Expected version, immutable content digest, identity-based maker-checker, step-up MFA and limits | Concurrent approval; changed recipient/rate/amount/allocation invalidates approval; Phase 4 |
| Approved payroll/certificates never mutate | Database state-aware protection and application service; corrections link originals | Direct and API mutation denied; adjustment retains lineage; Phases 4/6 |
| Approved site diaries never mutate; authors cannot approve their own work | Expected versions, independent `quality.manage` reviewer, submitted-content freeze, database lifecycle/actor/locking trigger; unique site/day and composite tenant/project/site reference | `apps/api/test/diaries.e2e-spec.ts` covers API and direct-SQL rejection, concurrency, RLS and project closure; D6.1 web foundation implemented locally |
| Photo evidence is recorded once and never rewritten | Verification computed server-side from the file's own metadata at upload; database CHECK ties `verified` to the location/time checks and keys to tenant/project/photo; insert-only for the runtime role; attach only to draft diaries; unique SHA-256 per project | `apps/api/test/photos.e2e-spec.ts` (direct SQL update/delete/inconsistent insert refused); D6.1 |
| Journal balances in KES minor units | Integer/decimal precision, posting transaction, deferred balancing constraint; immutable entries/lines | Independent golden cases, unbalanced write rejected, no float rounding; Phase 4 |
| Settlements never exceed authorised outstanding | Serialise obligation/reservation row; checked amounts; unique allocations/provider receipts | Concurrent partial settlement/payout and duplicate callbacks; Phase 4 |
| Uncertain external effects cannot be resubmitted blindly | Persisted attempt state and reservation, unique active/uncertain attempt control; reconciliation gate | Crash on both sides of provider call, delayed result and worker retry; Phase 4 |
| Callback acknowledgement means durable intake | Committed inbox before 2xx; unique provider event fingerprint; process repeatably | Queue outage and database outage; Phase 4 |
| Costs are not counted on both accrual and settlement | Unique source/posting purpose; separate committed, incurred and cash dimensions | Invoice + payment changes cash, not incurred cost twice; Phases 4/5 |
| Closed periods and historical reports are stable | Effective rule/rate/unit/BQ snapshots; no backdating into closed period | Change current rules and replay report; late attendance creates adjustment; Phases 3–6 |
| Offline events apply at most once | Unique tenant/device/client-event ID with immutable payload fingerprint; per-item durable ack | Multi-day duplicate sync, conflicting payload, app termination; Phase 3 |
| Offline evidence is not silently discarded or overstated | Append-only correction references; optimistic versions; provenance and separate attachment state | Missing attachment, revoked device quarantine, clock/GPS uncertainty; Phase 3 |
| Stock cannot violate approved policy | Ledger transaction locks stock position or equivalent serialisation; tenant-consistent movement references | Two simultaneous final-stock issues, returns/transfers and negative policy; Phase 5 |
| BQ imports preserve source and totals | Source checksum/mapping/version, validated hierarchy/units/formulas, atomic commit or resumable job | Duplicates, unsupported formulas, partial failure, independent totals; Phase 2 |
| Unverified legal rules cannot drive production calculations | Effective-dated rule approval with source/reviewer; production fail-closed gate | Missing/unapproved/expired rule rejected; Phases 2–4 |
| Restore never blindly repeats external money movement | Payment pause persisted outside replayable work; post-restore provider reconciliation before worker resume | Coherent DB/object/key restore and controlled reconciliation; first financial phase |
| Notifications cannot change payment outcome | Separate notification job/idempotency domain | SMS failure retries only notification after confirmed payment; Phase 4 |

Each later migration must identify the invariant it enforces and add a negative/concurrent integration test using the real runtime role. Redis locks and UI disabling are not correctness boundaries.
