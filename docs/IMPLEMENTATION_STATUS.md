# PM-Buddy: Implementation status

## Approval and scope

- D0 (design pack and prototype) and D1.1 (workspace, tooling and CI) are approved and merged to `main` (PRs #1 and #2), with CI green on the pull request and on `main`.
- **Owner instruction (11/11/2026):** "continue to the last phase". Scope is every roadmap phase through Phase 9; work does not stop for review between deliverables or phases and pauses only when it needs something from the owner; pull requests may be merged once CI is green. Each deliverable still gets its own branch, PR, demo script and CI run.
- This is approval to **build**, not to activate. Brief §15 J still governs real payouts, biometric collection, deployment and a live pilot: each needs its own evidence and the owner's explicit go-ahead.
- The one-site pilot **design and proposed delivery order** were approved earlier ([PILOT_PLAN.md](./PILOT_PLAN.md)); pilot activation is not.
- Mandatory additions are integrated into [PROJECT_BRIEF.md](./PROJECT_BRIEF.md) §15, including corrections to conflicting original requirements.

## Delivered surfaces

| Surface | Implementation / limitation |
|---|---|
| Brief and design safeguards | Workflow states/transition contracts, invariants, proposed financial model, offline protocol, operations, release plan, compliance evidence schema, pilot proposal and acceptance matrix |
| Existing business routes | Preserved mock prototype; not working payroll, Daraja, procurement, offline sync or biometric integrations |
| `/status` | Existing live API/dependency readiness |
| `/design-system` | Shared tokens/controls, KES/Nairobi formats, explicit pending/conflict/failure/loading/offline examples; EN/SW and light/dark |
| Web manifest | Same-origin installation metadata and icon; no service worker or sensitive-data cache; no offline business-sync claim |
| `/foundation` | API-backed registration/verification/login/reset, TOTP enrollment/step-up/recovery, session refresh/revocation, companies/projects, invitations, membership/project access and redacted audit summaries |
| CI | Existing lint/type/test/build/API/security workflows retained; browser/a11y job added |

## Executed evidence (this session)

Commands used `npx pnpm@12.17.0` because `pnpm` is not on the interactive PATH.

| Command | Actual result |
|---|---|
| `pnpm --filter @pm-buddy/web i18n:check` | Passed: 893 matching EN/SW keys, all ICU messages compile |
| `pnpm --filter @pm-buddy/web test` | Passed: 3 files, 10 formatter/manifest/API transport unit tests |
| `pnpm --filter @pm-buddy/web lint` | Passed, including final combined CI-equivalent run |
| `pnpm --filter @pm-buddy/web typecheck` | Passed with shared validated response schemas and typed notice keys |
| `pnpm --filter @pm-buddy/web build` | Passed with `/foundation`, `/design-system`, manifest and existing routes |
| `pnpm --filter @pm-buddy/web test:e2e` | Passed: 8 browser tests covering gallery EN/SW light/dark, keyboard, 360px viewport/manifest, full foundation contract flow, canonical permissions, recovery-code handling, revocation and rejected malformed successes; axe checks included |
| Browser install | Full Chromium installed with `playwright install --no-shell chromium`; separate headless-shell download stalled and was stopped. Tests use supported Chromium channel/new headless mode, not a skipped browser check |
| `pnpm turbo run lint typecheck test i18n:check build` | Passed: 22 tasks, 8 cached. Unit suite results: API 33, validation 27, web 10, domain 34 and types 4 (108 total; some upstream results replayed from cache) |
| `pnpm format:check` | Passed after formatting the changed browser test |
| `pnpm test:e2e` | Passed final combined run: API 35 integration/e2e tests and web 8 browser/a11y tests |
| `pnpm install --frozen-lockfile` | Passed; dependency manifests and persistent lockfile agree |
| `actionlint .github/workflows/ci.yml` | Not executed successfully: `actionlint` is unavailable (`command not found`). YAML formatting/parsing passed via Prettier; GitHub workflow execution remains pending |
| Real browser → real API → PostgreSQL/Mailpit smoke | Passed registration, local verification message, login, TOTP enrollment, one-time recovery display, company/project persistence, members/audit, two-company switching/isolation and logout revocation. No mocked API responses in this separate smoke; 0 browser page errors |

The first gallery scan found light-theme contrast below 4.5:1; shared muted/success/error tokens were darkened and all scans rerun successfully. Browser fixtures were corrected to match the actual ten-recovery-code response and accessible text; checks were not disabled.

The real smoke used a newly created isolated database, non-owner `pmb_app` runtime role, temporary API/web ports and a unique synthetic recipient in local Mailpit. The explicitly identified message, temporary database/script and both helper servers were removed/stopped afterward; existing development services/data were retained. These are local results; no GitHub CI run is claimed.

## Backend foundation evidence

Backend implementation includes identity/security/tenancy modules, application wiring/configuration/redaction, Prisma schema and six foundation migrations after the existing base. API lint/typecheck/build, 33 unit tests and 35 integration/e2e tests passed; shared validation build/lint/typecheck and 27 tests passed. Development/test migrations were applied, schema drift checked as zero and compiled-server readiness/CSRF smoke passed.

Parent independently reran the API suite and final combined `test:e2e`: **2 API files, 35 tests passed**. Coverage includes forced fail-closed RLS across every discovered tenant table under the actual non-owner/no-BYPASSRLS runtime role, cross-tenant reads/writes/composite references, concurrent pooled context cleanup, TOTP replay, recovery single use, privileged MFA, refresh replay revocation, invitations and append-only hash-chain audit enforcement. No production migration/deployment was performed.

The canonical project permissions are `projects.view` and `projects.manage`, matching the shared catalogue. A forward migration converts the initial draft names without rewriting applied migrations; the legacy-value fixture was migrated and forced RLS preserved. Shared response schemas are exported from `@pm-buddy/validation` and consumed by the frontend; malformed responses never become saved-success UI.

The backend contract/configuration is in [apps/api/README.md](../apps/api/README.md). The ignored local encryption-key file is permission-restricted; deployments must supply separately managed key material. `WEB_ORIGIN` must match the actual web origin exactly, including hostname and port. The live frontend is wired and separately smoke-tested end to end; this still does not waive remaining Phase 1 requirements.

Explicit remaining backend requirements: passkeys, external messaging providers, custom roles, action-bound financial step-up, mobile device binding and comprehensive breached-password checking. These are not represented as working integrations. Later financial features must not use a generic MFA timestamp as action-bound approval authority.

## Independent security review of the identity foundation

Before merging, a separate reviewer read every changed file. All six findings were confirmed against the source and fixed, each with a regression test (API e2e suite: 40 tests).

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | High | Rate limits keyed on `req.ip`. Behind the web app's `/api` rewrite every request shares one address, so 41 sign-ins a minute blocked sign-in for everyone. Tested: the rewrite sends no `X-Forwarded-For` of its own and passes a client-supplied one through unchanged | Limits key on the account identifier, user, refresh-token or reset-token digest. A per-IP limit applies only when `TRUST_PROXY` names an edge proxy that appends the real client IP |
| 2 | High | Account pre-hijacking: verifying an email activated whatever password an earlier, unverified registration had set | Re-registering an unverified account replaces its password and invalidates earlier codes; verification requires that password as well as the code |
| 3 | Medium | Sign-out failed once the 10-minute access token expired, leaving a refresh cookie that the next person could use | Sign-out finds the session through the access or refresh token, always clears cookies and always succeeds |
| 4 | Medium | Account enumeration: register, resend and forgot differed in status (503 only for some accounts in production) and timing | Delivery runs after the response (`notifyLater`) and its failure is only logged; every path does the same hashing work; existing verified accounts get a "registration attempt" notice |
| 5 | Medium | TOTP and recovery codes had a rolling rate limit but no lockout | After 5 wrong codes in a row two-step verification locks for 15 minutes, the session is revoked and the user is notified; plus a 30-per-day cap. Email verification has a 20-per-day cap per identifier |
| 6 | Low | Migration 50000 ran under FORCE row-level security without a tenant context, so it would copy no invitation project scopes and then drop the column | Lifts FORCE for the copy, checks every scope was copied, restores FORCE. Proven on a scratch database: the original copied 0 of 2 scopes, the fix copies both |

Also fixed while testing: the CSRF endpoint treated an empty cookie as an existing token (400 instead of a fresh token).

**Lockfile hygiene.** Re-resolving dependencies through the corporate npm proxy had turned 805 lockfile hashes back to sha1. `.pnpmfile.mjs` now keeps the existing sha512 for each unchanged `name@version` (published npm versions are immutable) and computes it, after checking the sha1, for new packages. A forced full re-resolution confirmed it: 805 entries restored, no other change.

## Decisions and unresolved risks

- Modular monolith, explicit provider boundaries, and existing prototype retained.
- Design documents specify later-phase controls; they do not implement financial journals, callback inboxes, approval snapshots or device sync.
- Proposed posting/rounding policies need an independent accounting/QS reviewer; legal rules need authoritative source/effective dates/reviewer approval.
- [Pilot design and proposed delivery order](./PILOT_PLAN.md) are approved; live pilot activation is not. All existing phases/modules remain on the roadmap.
- No production onboarding, coherent restore rehearsal, real-device offline test, human accessibility/Kiswahili field review, verified cost estimate or named operations ownership has been completed here.
- Only loopback development Mailpit messages were sent to synthetic identities; no external notifications or real payments, biometric collection, deployment or commit occurred.

## Next step and demo

The core of D1.2–D1.4 is merged after the review fixes above. To close Phase 1:

1. D1.3 gaps: passkeys (WebAuthn), a development SMS/WhatsApp code provider behind the notification interface, and a breached-password check.
2. D1.2 gap: move the EN/SW catalogues into a shared `packages/i18n` so the API and site app can use them.
3. D1.4 gap: custom roles on top of the system roles.
4. Phase 1 acceptance evidence in [ACCEPTANCE_MATRIX.md](./ACCEPTANCE_MATRIX.md), then Phase 2 (projects, sites and BQ).

Follow the [Phase 1 demo](./demos/phase-1.md). A green build never stands in for production payment or biometric approval.
