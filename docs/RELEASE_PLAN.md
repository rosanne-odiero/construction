# PM-Buddy: Release and compatibility plan

## Gates and environments

Keep development, staging and production credentials, provider accounts, object buckets and datasets isolated. Development delivery adapters are labelled mocks and must not be usable in production. No deployment, real payout or biometric collection is approved by Phase 1 code approval.

Each phase needs [acceptance evidence](./ACCEPTANCE_MATRIX.md), actual command results, permission/isolation tests, migration/recovery notes, limitations and a demo. Production additionally needs verified provider onboarding, reviewed effective rules, assigned operators, coherent restore rehearsal, real-device offline evidence and controlled reconciliation.

## Migration procedure

1. Review migration SQL and runtime grants/RLS; identify affected invariants and incompatible clients.
2. Rehearse on representative synthetic volume, including failed migration and restoration. Record duration and locks.
3. Use expand-contract: add compatible structures, deploy dual-compatible code, backfill with checkpoints, validate, then remove old structures only after minimum-client adoption and retention windows.
4. Run migrations with a separate migration role. The API role must not own tenant tables, bypass RLS or mutate audit history.
5. Deploy staging, run integration/contract/negative-isolation tests and demonstrate old-client behaviour.
6. Production rollout requires owner approval and monitored health/queue/reconciliation thresholds.

An application rollback is not a schema rollback. Destructive/data migrations need explicit forward-fix and restore plans; never assume redeploying old code reverses them.

## API/mobile compatibility

Version `/api/v1` and sync envelopes explicitly. Publish minimum supported app/schema versions and a compatibility matrix with each release. Test a device reconnecting after weeks offline, transactional local database migration, preservation of unsynced events and an actionable upgrade path.

Unsupported clients must get explicit recoverable errors, not partial silent acceptance. Do not remove columns/endpoints used by still-supported offline clients.

## Feature gates

Production payment initiation, provider rails, biometric collection and unverified compliance rules remain disabled until their acceptance/review gates pass. Tenant flags never bypass permissions, MFA, limits or maker-checker.

The payout pause control is independent of queued obligations and must survive operational recovery. A code release must not implicitly resume a restored outbox.

## Verification and rollback

Run lint, strict typecheck, unit/domain golden cases, database/runtime-role tests, targeted browser/a11y checks, build, dependency/secret/security checks and relevant integration tests in CI. Record manual field/hardware evidence separately.

On failed health/isolation/financial checks: stop rollout, pause new external effects, preserve evidence and restore the last compatible application only if schema compatibility is established. Use an approved forward fix otherwise. Database restore follows [OPERATIONS.md](./OPERATIONS.md), including provider reconciliation before workers resume.
