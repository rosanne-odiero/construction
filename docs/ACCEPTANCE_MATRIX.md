# PM-Buddy: Acceptance matrix

Status distinguishes **design specified**, **implemented/tested**, **pending evidence** and **not implemented**. Design text and prototype screens are not proof of working integrations. Phase 1 implementation approval does not approve later phases or a live pilot.

## Requirement coverage

| Requirement | Acceptance scenario | Test or manual evidence | Phase | Status |
|---|---|---|---|---|
| §15.A existing-work preservation, modular monolith | Integrate additions without rebuilding prototype or discarding worktree | Existing application retained; backend remains NestJS modules | 1 | Implemented; see status for checks |
| §15.A phase status and honest integrations | New session can identify real/mock surfaces and unexecuted tests | [Implementation status](./IMPLEMENTATION_STATUS.md); separate `/foundation`, `/design-system`, prototype routes | Every | Implemented; production approval withheld |
| §15.A dependency versions | Reproducible frozen-lockfile install and current integration documentation | Pinned new integrations/lockfile; official docs checked; install results in status | 1 | See command evidence |
| §15.B design deliverables | All nine design/review surfaces exist; pilot approval distinguished from live activation | [Workflows](./WORKFLOWS.md), [invariants](./INVARIANTS.md), [financial model](./FINANCIAL_MODEL.md), [offline sync](./OFFLINE_SYNC.md), [operations](./OPERATIONS.md), [release plan](./RELEASE_PLAN.md), [compliance](./COMPLIANCE_TODO.md), [pilot](./PILOT_PLAN.md), this matrix | 0/1 | Design specified; owner approved pilot design/delivery order only; domain review pending |
| §15.C explicit workflows, immutable snapshots, maker-checker | Invalid transition/edit or same-identity approval denied | Workflow contracts; database/concurrency suites required with financial modules | 4–6 | Design specified; not implemented |
| §15.C journal, precision and non-duplicated costs | Balanced golden postings, accrual not repeated at settlement | Financial model; independent accountant/QS review required | 4–6 | Design specified; reviewer pending |
| §15.C snapshots and historical stability | Rule/rate/BQ edits do not change past reports | Effective-version and closed-period tests required | 2–6 | Not implemented |
| §15.D payment uncertainty and idempotency | Crash/timeout never blindly repeats payout; changed keyed payload rejected | Failure scenarios P01–P06 below | 4 | Not implemented |
| §15.D callback trust and durable intake | Queue outage is safe; mismatched amount/currency/direction quarantined | Callback inbox, provider contract and restore tests required | 4 | Not implemented |
| §15.D recipient/funding/reconciliation | Changed recipient invalidates approval; reservation race safe; pause preserves obligations | Pre-approval verification and operational evidence required | 4 | Not implemented |
| §15.E event identity, conflicts, late attendance | Durable per-item ack, append-only corrections, no silent overwrite | Offline sync contract and P07–P09/P13 | 3 | Design specified; field evidence pending |
| §15.E offline lease, provenance and uploads | Revoked/offline device has bounded access; missing attachment visible | Real Android/lost-device/termination/storage-full/upload evidence required | 3 | Not implemented |
| §15.F identity lifecycle and recovery | Expired/replayed invitations, removed members and revoked sessions denied | Backend foundation suites and status; native secure-storage flow remains Phase 3 | 1/3 | See implementation status; remaining gates explicit |
| §15.F tenant/project scope and runtime RLS | Guessed IDs and pooled tenant context cannot leak data | Backend integration tests under actual non-owner runtime role | 1 and every module | See implementation status |
| §15.F sensitive-data/support boundaries | Support grant expiry; logs/audit redacted; signed URL/export/upload protections | Foundation logging tests plus per-feature security tests | Every | Partial; no production sensitive data approved |
| §15.F retention/lawful basis/USSD | Data-class retention/deletion and lawful basis reviewed; PIN rate limits | Compliance register and privacy reviewer; USSD tests in Phase 7 | 3/7 | Pending review/implementation |
| §15.G BQ/import/conversions | Source/mapping retained, duplicates/formulas/units/totals validated atomically | BQ import golden fixtures and resumability tests | 2 | Design specified; not implemented |
| §15.G progress/earned/certified/cash separation | Undefined ratios unavailable; material estimates not theft verdicts | Independently reviewed QS calculations | 2/6 | Not implemented |
| §15.G procurement/stock/certification | Controlled match exceptions, no duplicated materials valuation, concurrent stock safe | P10 plus invoice/return/retention golden cases | 5/6 | Not implemented |
| §15.H environments/migrations/compatibility | Old app safely reconnects after expand-contract release | Release plan plus migration-volume/forward-fix evidence | Every | Design specified; mobile evidence pending |
| §15.H coherent backup and restore | DB/object/config/key restore, payment pause, provider reconciliation | P12; measured RPO/RTO and operator sign-off | First relevant phase | Not rehearsed |
| §15.H observability/operations/costs | Actionable metrics, assigned alert owners, quotas and cost estimate | Operations plan; verified prices and named owners required | Every | Design specified; operational approval pending |
| §15.H UX/i18n/accessibility | EN/SW and light/dark gallery, errors/offline/pending states, mobile width | Web formatter/manifest unit tests; Playwright axe gallery checks | 1 | See command evidence; human review pending |
| §15.I golden cases and CI | Independent domain expectations plus failure-oriented integration tests | CI/browser jobs and per-phase reviewer sign-off | Every | Foundation tests only; domain cases pending |
| §15.J release gate | Evidence reviewed before pilot/payout/biometric activation | Pilot/release checklists and explicit owner decision | Release | Not approved |

## Mandatory failure scenarios (brief §15.I)

All financial/field scenarios below remain release-blocking until their phase provides actual evidence.

| ID / scenario | Expected outcome | Test or manual evidence | Phase | Status |
|---|---|---|---|---|
| P01 concurrent approval/disbursement | One valid transition/attempt; no duplicate settlement | Database race test, not UI button test | 4 | Not implemented |
| P02 crash after provider acceptance | Unknown retained; reconcile before resubmission | Fault injection before local response persistence | 4 | Not implemented |
| P03 duplicate/out-of-order callbacks | No duplicate journal or regression | Local provider simulator and inbox replay | 4 | Not implemented |
| P04 queue outage at callback | Durable inbox or non-success if persistence fails | Stop queue; verify persisted intake/recovery | 4 | Not implemented |
| P05 recipient/amount edit after approval | Approval invalidated; payout blocked | Snapshot mismatch and independent reapproval tests | 4 | Not implemented |
| P06 partly failed payroll | Settled lines remain settled; retry only demonstrably unpaid | Partial outcomes plus unknown-attempt blocking | 4 | Not implemented |
| P07 repeated multi-day sync | Each event once; conflicts/missing attachments visible | Duplicate sync suite and real-device field test | 3 | Not implemented |
| P08 revoked device reconnects | No new sensitive access; evidence quarantine policy | Lost-device/revocation suite and field evidence | 3 | Not implemented |
| P09 late attendance after closure | Linked correction; no settled payroll mutation | Closed-period adjustment golden case | 3/4 | Not implemented |
| P10 concurrent remaining-stock issues | Approved stock policy enforced, no lost update | Concurrent DB integration test | 5 | Not implemented |
| P11 guessed file/export/job IDs | Cross-tenant access denied on all delivery paths | Per-surface runtime-role/isolation tests | Every surface | Foundation coverage only; later paths pending |
| P12 restore to prior point | Consistency checks and payout pause until reconciliation | Coherent restore rehearsal, recorded provider evidence | First financial phase | Not rehearsed |
| P13 old mobile app reconnects | Compatible sync or recoverable upgrade; no silent loss | Old-client contract/local-migration test | 3 onward | Not implemented |
| P14 SMS failure after payment | Retry notification only; payment stays confirmed | Separate notification/payment worker fault injection | 4 | Not implemented |

## Review

No human accounting, QS, privacy, Kiswahili field-language, hardware or live-pilot approval has been inferred. Owner approval of the pilot design/proposed delivery order is recorded in [PILOT_PLAN.md](./PILOT_PLAN.md), not treated as activation approval. Record reviewer/date/evidence when obtained. Commands actually run and their outcomes are maintained in [IMPLEMENTATION_STATUS.md](./IMPLEMENTATION_STATUS.md), not represented by planned test names.
