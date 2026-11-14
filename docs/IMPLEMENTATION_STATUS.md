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
| `/foundation` | API-backed registration/verification/login/reset, TOTP enrollment/step-up/recovery, passkey registration/listing/removal and passkey step-up (D1.3, branch `phase-1/d1-passkeys`), password-policy refusals, session refresh/revocation, companies/projects, invitations, membership/project access, roles and permissions (custom roles, member role changes; D1.4) and redacted audit summaries |
| `/sign-in` and office shell (D2.1) | Real API sign-in (password, TOTP/passkey/recovery-code step-up, company selection), signed-in user and company in the shell, sign-out; live pages redirect to `/sign-in?next=…` without a session |
| `/projects` (D2.1) | Live project list and detail (overview KPI shell with "unavailable" figures, sites with versioned geofences and a map editor, team, WBS and milestones); other business screens stay prototype, now also under `/prototype/projects` |
| `/projects/[id]/bq` and `/bq/import` (D2.2) | Live BQ viewer (tree, search, summary, import status, overrides, Excel/PDF export) and the 5-step Excel import wizard; imports tested with **synthetic** workbooks only (a real anonymised Kenyan BQ is still needed); the D0 BQ screens moved to `/prototype/projects/…/bq`; no ClamAV yet |
| BQ versions, variations and build-ups (D2.3) | Live baseline approval and contract sums on `/projects/[id]/bq` and the project overview, `…/bq/variations` (list, editor, submit/approve/reject/reopen/cancel/rebase with step-up), `…/bq/instructions`, `…/bq/versions` (history and compare), `/rate-buildups` (company library, versions, item links) and `/bq`; browser tests run against the mock API; no approval limits by amount, no attachment upload, no theoretical consumption yet |
| `/labour` (D3.1) | Live labourer registry (saved views, worker side panel with masked identifiers and audited reveal, registration with consent, consent screen, gangs, trades & rates, NCA alerts); the D0 labour screens moved to `/prototype/labour` and stay labelled. Built and verified locally on branch `phase-3/d3.1-labour-registry`; not pushed, not reviewed, not approved |
| `/attendance` (D3.3, web slice) | Live attendance and timesheets: overview, daily muster roll per project/site/day (keyboard entry, bulk "present", gang filter, inline flags), submit and confirm by a different person, corrections, anomaly review, weekly timesheet periods (submit, approve with an immutable snapshot, reject, reopen), adjustments to approved periods, rules & holidays, and an attendance summary in the worker panel; the D0 attendance screens moved to `/prototype/attendance`. Web-manual capture only (no site app, QR/NFC, photos, GPS/geofence, offline or biometrics). Built and verified locally on branch `phase-3/d3.3-web-timesheets`; not pushed, not reviewed, not approved |
| `/projects/[id]?tab=schedule` (D6.2) | Live schedule: SVG Gantt chart (critical path, baseline ghosts, actual dates, milestone diamonds, dependency arrows, today's line in Nairobi time, week/month zoom, keyboard item list, table alternative), activity editor with FS/SS/FF/SF links and lags, progress with a declared basis, per-project working calendar with the company's public holidays, CPM from `packages/domain`, append-only baselines with variance in working days, and the versioned delay log. Built and verified locally on `phase-6/d6.2-schedule`; not committed, not reviewed. No resource levelling, calendars per activity, MS Project/P6 import or client-portal schedule; measured progress and EVM are D6.3 |
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

Explicit remaining backend requirements: passkeys, external messaging providers, action-bound financial step-up, mobile device binding and comprehensive breached-password checking (passkeys, the password policy and development SMS/WhatsApp channels were since added on `phase-1/d1-passkeys`; see the last section). These are not represented as working integrations. Later financial features must not use a generic MFA timestamp as action-bound approval authority.

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

## Independent review of RBAC and custom roles

A separate reviewer checked the RBAC change for escalation paths, races, MFA bypasses, tenant isolation and migration errors and found no significant issues (it also reran the API e2e suite: 50/50). One hardening note was applied: the database's privileged-MFA trigger now locks the custom role row (`FOR SHARE`), so the database guard holds on its own, without relying on the application's tenant lock. Proven with two concurrent sessions: assigning a member without MFA to a harmless role while another session adds `payroll.approve` to it, the second session waited for the first to commit and was then refused; the role was unchanged. Independently rerun on a freshly migrated test database: 26/26 turbo tasks (145 unit tests), API e2e 50/50, web browser tests 9/9.

## Independent review of passkeys, password policy and notifications

A separate reviewer found one **high** issue, fixed with two independent layers and regression tests:

- **Finding:** confirming TOTP enrolment did not re-check the step-up rule. An attacker with the password could start TOTP enrolment while the account had no factor; after the owner added a passkey (which signed the attacker out), a new password-only session could still confirm the pending secret. That made the attacker's authenticator a permanent factor and handed them fresh recovery codes.
- **Fix 1:** a pending TOTP enrolment is bound to the session that started it (migration `20261110091000_bind_mfa_enrolment`), and confirmation re-checks the enrolment rule against the user and session rows locked in the transaction.
- **Fix 2:** adding a passkey discards any pending TOTP enrolment, and passkey registration re-checks the same rule under the lock.
- **Evidence:** removing both layers makes the new takeover test fail; either layer alone stops it. API e2e: 70/70.

Also fixed: the primary button's hover colour blended into the page and fell to 4.4:1 contrast. Dedicated `--primary-hover` tokens give 8.1:1 (light) and 6.7:1 (dark), and new browser tests scan the hovered button with axe in both themes (they fail on the old styling).

## Decisions and unresolved risks

- Modular monolith, explicit provider boundaries, and existing prototype retained.
- Design documents specify later-phase controls; they do not implement financial journals, callback inboxes, approval snapshots or device sync.
- Proposed posting/rounding policies need an independent accounting/QS reviewer; legal rules need authoritative source/effective dates/reviewer approval.
- [Pilot design and proposed delivery order](./PILOT_PLAN.md) are approved; live pilot activation is not. All existing phases/modules remain on the roadmap.
- Owner inputs still needed (a real anonymised Kenyan BQ for D2.2 sign-off, native Kiswahili review, a QS check of the starter catalogue, tax and payroll sign-off) are listed in the app under **Waiting on you** on the review home page (`/`).
- No production onboarding, coherent restore rehearsal, real-device offline test, human accessibility/Kiswahili field review, verified cost estimate or named operations ownership has been completed here.
- Only loopback development Mailpit messages were sent to synthetic identities; no external notifications or real payments, biometric collection, deployment or commit occurred.
- CI browser job runs in the official `mcr.microsoft.com/playwright` image, pinned by digest, as runner UID 1001. Two consecutive PR #20 runs failed before any test because the hosted runner could not resolve its Ubuntu apt mirror during `playwright install --with-deps`; the image already carries the browser libraries and fonts. Bump the image tag with `@playwright/test`.

## Next step and demo

**Phase 1 is built and merged** (PRs #2, #11, #15, #16), with CI green on every pull request and on `main`. Phase 1 acceptance holds: users sign up, verify, sign in with TOTP or a passkey, create a company and projects, and manage roles; the tenant-isolation suites pass under the restricted runtime role. Every change was independently security-reviewed and every finding fixed with a regression test.

Open items carried forward (not blockers for building Phase 2): real SMS/WhatsApp/email providers (D7.3); passwordless passkey sign-in; human review of Kiswahili wording and field accessibility (§15 H); passkey events in the company audit log.

Next: **Phase 2**. D2.1 (projects, sites and geofences) is built on `phase-2/d2.1-projects-sites` and awaits review (last section); D2.2 (BQ import) follows. See the [Phase 1 demo](./demos/phase-1.md) and the [Phase 2 demo](./demos/phase-2.md).

## D1.4 permission-based RBAC and D1.2 shared i18n (branch `phase-1/d1-rbac-i18n`)

**What changed**

- **Permission-based RBAC.** `packages/types` now defines `SYSTEM_ROLE_PERMISSIONS` (brief §3 defaults, table in [ARCHITECTURE §8.1](./ARCHITECTURE.md#81-system-role-defaults)), company-level vs project-scoped permissions, `MFA_REQUIRED_PERMISSIONS` and the company-wide system roles (`owner`, `finance`). Role-string checks (`membership.role !== "owner"`, `rolePermissions()`, `["owner","finance"]`) were replaced by one policy, `AccessPolicy`, used by every tenancy and project endpoint (`TenantScope` runs the tenant transaction and audit).
- **Custom roles.** Migration `20261110080000_custom_roles` adds `tenant_roles` (forced RLS, permission CHECK without `platform.admin`, reserved names, citext-unique names) and `custom_role_id` on memberships and invitations with composite `(tenant_id, custom_role_id)` foreign keys. It replaces `app.require_privileged_mfa()` with a permission-based version (`app.permissions_require_mfa`, `app.system_role_requires_mfa`) and adds `app.require_role_member_mfa()` on role permission changes. No existing rows are read or rewritten.
- **API.** `GET /permissions`, `GET/POST /tenants/current/roles`, `PATCH/DELETE /tenants/current/roles/:id`, `PUT /tenants/current/members/:userId/role`, with shared Zod request/response schemas in `packages/validation` and OpenAPI operations. Tenant, member and invitation responses now carry the role reference (system key or custom role ID) and `roleName`; the tenant list also carries the caller's `permissions` and `tenantWide`.
- **Web.** `/foundation` gates its sections by permission and adds **Roles and permissions**: system and custom roles with their permissions, a custom-role editor with permissions grouped by area (permissions the caller does not hold are disabled), and member role changes. EN and SW strings (988 keys in each).
- **Shared i18n.** `packages/i18n` (`@pm-buddy/i18n`) holds `src/messages/{en,sw}.json`, exports `catalogues`, `messages(locale)`, `LOCALES`/`Locale`, `isLocale` and the `Messages` type, and owns the `i18n:check` script (still run by `turbo run i18n:check`). The web app loads messages from it; `apps/web/messages` and `apps/web/scripts/check-i18n.mjs` were removed.

**Behaviour changes to note**

- Effective project permissions are role ∩ assignment. The existing e2e assertion that a **client** could rename a project after being granted `projects.manage` contradicted that rule; it now expects 403, and the positive path is covered by a project manager in `test/roles.e2e-spec.ts`. The tenant-list assertion was extended to the new fields. No other existing test changed.
- Member removal now needs `roles.manage` and the privilege-escalation guard (an actor cannot remove someone more privileged). Step-up requirements of the former owner-only endpoints are preserved, including the member list.
- `GET /tenants` and member/invitation payloads changed shape (new required fields); the web mocks and shared contract tests were updated accordingly.

**Commands run (from the repository root, this session) and actual results**

| Command | Actual result |
|---|---|
| `git switch -c phase-1/d1-rbac-i18n main` | Branch created from clean `main` (`916449a`) |
| `npx pnpm@12.17.0 install` | Added `@pm-buddy/i18n` workspace package; lockfile diff +28/−3 lines (importer changes only). `grep -c 'integrity: sha1-' pnpm-lock.yaml` → 0; `grep -c tarball: pnpm-lock.yaml` → 0 |
| `npx pnpm@12.17.0 install --frozen-lockfile` | Passed; lockfile unchanged |
| `npx pnpm@12.17.0 format:check` | Passed: "All matched files use Prettier code style!" |
| `npx pnpm@12.17.0 turbo run lint typecheck test i18n:check build --force` | Passed: 26 successful, 0 cached. Lint 0 warnings/0 errors in every oxlint package and ESLint clean in web. Unit tests: types 12, domain 34, validation 34, i18n 3, web 10, API 52 (145). `i18n OK: 988 keys in en and sw, all ICU messages compile.` Web `next build` passed |
| `npx pnpm@12.17.0 db:migrate` | `9 migrations found`, `No pending migrations to apply` (the new migration was applied to the development database earlier in the session; see note) |
| `PATH=/tmp/pnpm-shim:$PATH npx pnpm@12.17.0 turbo run test:e2e --force` | Passed: 7 tasks, 0 cached. API: 3 files, **50 tests** (health 7, identity 33, roles 10) against `pmb_test` under the real `pmb_app` role. Web: **9** Playwright tests with axe (including the extended foundation flow and a Kiswahili delegated-manager roles test) |
| `cd apps/api && npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` | "No difference detected.", exit code 0 |

Note: the first development `prisma migrate deploy` of the new migration failed inside its transaction (a policy referenced `memberships.custom_role_id` before that column was added), so nothing was applied. The statements were reordered, the failed record was marked rolled back with `prisma migrate resolve --rolled-back 20261110080000_custom_roles`, and the corrected migration applied cleanly to the development database and, through the e2e global setup, to `pmb_test`. A mutation check (temporarily removing the escalation guard from role creation) made two roles e2e tests fail, then the guard was restored and all tests passed.

**Roles e2e coverage (`apps/api/test/roles.e2e-spec.ts`, real `pmb_app` role):** catalogue contract and 401 when signed out; OpenAPI operations present; system roles listed with their defaults and immutable (403), `platform_admin` refused (400); custom role create/rename/change/delete with stale-MFA rejection, real TOTP step-up, case-insensitive duplicate names (409) and audit summaries; `platform.admin` refused by API (400) and database (CHECK) along with unknown permissions, empty roles and reserved names, while all 44 tenant permissions are accepted; a delegated role manager's escalation attempts (granting unheld permissions, company-wide scope, editing or deleting a stronger role, changing the owner, promoting themself, inviting as finance/owner, removing the owner) all 403 with nothing changed; company B cannot list, change, delete, assign or invite with company A's role, cannot read or write it in SQL, and composite keys reject cross-company references; the database MFA lists match the shared code for every permission and system role; a payments role needs MFA to be accepted; adding a privileged permission or the Finance role to a member without MFA is refused by the API (409) and the database; a member role change revokes only that company's sessions and is audited; role ∩ assignment and company-wide roles on projects; roles in use or in pending invitations cannot be deleted, and expired invitations are removed with the role.

**Limitations and follow-ups**

- Project assignments can carry only `projects.view` and `projects.manage` (the implemented project policy). When BQ, labour, attendance and payment modules land, widen `project_permissions_check` and `projectPermissionSchema` so role ∩ assignment covers them.
- Per-assignment approval limits and action-bound financial step-up are still to come with the financial modules.
- The Kiswahili permission names and role strings need a human language review.
- Custom role changes apply at the holder's next request (permissions are evaluated per request); only an explicit member role change revokes sessions.
- No GitHub CI run is claimed; nothing was committed or pushed.

## D1.3 passkeys, password policy and notification channels (branch `phase-1/d1-passkeys`)

**What changed**

- **Passkeys (WebAuthn) as an MFA factor and for step-up** with `@simplewebauthn/server@14.0.3` and `@simplewebauthn/browser@14.0.0` (MIT). Endpoints: `GET /auth/passkeys`, `POST /auth/passkeys/registration/options`, `POST /auth/passkeys/registration` (201), `DELETE /auth/passkeys/:id`, `POST /auth/passkeys/step-up/options`, `POST /auth/passkeys/step-up`; shared Zod schemas in `packages/validation/src/passkeys.ts`, OpenAPI operations on the controller. `PasskeyService` (`apps/api/src/modules/identity/passkey.service.ts`).
  - Relying party from `WEB_ORIGIN`: exact origin, RP ID = hostname. Attestation `none`, user verification required for both ceremonies, algorithms EdDSA/ES256/RS256 (ML-DSA is offered by the library's default list but Node 24 marks it experimental and prints a warning, so it is left out until stable).
  - Challenges: random, stored in `auth_challenges` as SHA-256 digests with the new `session_id` column, bound to user and session, single-use (consumed whether verification succeeds or not; a new request supersedes the previous one), five-minute expiry. Credential IDs are unique (DB unique index plus a check before insert; a race maps to 409). The library rejects non-increasing counters except zero-counter authenticators; the stored counter is updated on success.
  - Registration needs a sign-in within five minutes, or, **once the account has any factor, MFA verified within five minutes** (stricter than "fresh session or fresh step-up": otherwise a stolen password alone could add an attacker's passkey). The same rule now applies to TOTP enrolment, so a passkey-only account can add TOTP after a passkey step-up. Up to ten named passkeys per account (names unique per account).
  - First factor: signs out other sessions, marks the session MFA-verified (eight-hour cap, as for TOTP) and issues ten single-use recovery codes when the account has no unused ones. A passkey added next to TOTP keeps the existing codes.
  - Step-up sets `sessions.mfa_verified_at` exactly like TOTP and shares the lockout: every failed assertion (missing/expired/replayed/superseded challenge, unknown or foreign credential, wrong origin or RP ID, bad signature, counter regression, no user verification) calls the same `recordMfaFailure`; the fifth in a row locks MFA for 15 minutes, revokes the session and sends "Two-step verification locked" (its text now mentions failed passkey checks). Options are refused (429) while locked.
  - Removal needs MFA verified within five minutes; removing the last factor of someone holding an MFA-required permission is 409.
  - Listings never contain credential IDs or public keys; library error messages (which can quote origins and challenges) are neither logged nor returned. Adding and removing a passkey sends a security notification.
- **Factor model in the database.** Migration `20261110090000_passkeys` adds `webauthn_credentials` (user-scoped like `users`/`sessions`: no tenant data, no RLS; CHECKs on credential ID format and length, counter range, transports, names, device type; pmb_app lacks TRUNCATE/REFERENCES/TRIGGER) and `auth_challenges.session_id` (FK, cascade; passkey purposes must carry a session). `users.mfa_enabled` keeps its meaning, **"has at least one MFA factor"**, and is now maintained by `app.maintain_user_mfa()` (BEFORE INSERT/UPDATE OF `mfa_enabled`, `mfa_secret` on `users`) from the TOTP secret and the passkeys, fed by `app.sync_passkey_factor()` on `webauthn_credentials`. So the existing privileged-MFA triggers accept passkey-only users unchanged in meaning, a forged `mfa_enabled = true` is recomputed, and dropping to no factor while holding an MFA-required permission raises 23514 (the trigger reads the user's own memberships and custom roles by temporarily setting `app.user_id` to that user, then restores the caller's context). `app.require_privileged_mfa()` and `app.require_role_member_mfa()` were replaced (bodies otherwise identical) to share-lock the user rows they rely on, so a concurrent role grant and factor removal serialise. The migration asserts that `mfa_enabled` matched the TOTP secrets before it; no existing row is rewritten.
- **Password policy** (`apps/api/src/modules/identity/password-policy.ts`): on registration and reset (the only password-setting paths), after the existing length/common-password schema checks, zxcvbn-ts (`@zxcvbn-ts/core@4.2.0`, `language-common@4.1.3`, `language-en@4.1.1`, MIT) must score ≥ 3 with the identifier and its parts, the display name, "pm-buddy" and "pmbuddy" as context; only the first 64 characters are scored (zxcvbn's cost grows with length; measured roughly 60–250 ms per 64-character check here, versus up to ~600 ms at 128). Then the optional `PasswordBreachChecker`: `AUTH_BREACHED_PASSWORD_CHECK=off|hibp` (default `off`, validated in `env.ts`). `HibpBreachChecker` sends only the first five hex characters of the SHA-1 to `api.pwnedpasswords.com/range/` with `Add-Padding: true`, ignores zero-count padding rows, times out after two seconds and **fails open** with a warning that names only the reason (status, timeout or network error). Refusals are 400 problems with code `password-too-weak` or `password-breached` (the problem filter now honours a safe custom `code` from the thrower); no score is returned. Registration checks run before the account lookup, so answers are identical for existing and new accounts; reset checks the (256-bit) token first and uses its account as context, and a refused password does not spend the token.
- **Notification channels.** `apps/api/src/modules/notifications`: `NotificationProvider.send({ channel: "email" | "sms" | "whatsapp", recipient, subject, text })`; `DevelopmentNotificationProvider` (loopback Mailpit for every channel; SMS/WhatsApp to `phone-<number>@development.invalid` with `[DEVELOPMENT ONLY][SMS]` / `[DEVELOPMENT ONLY][WHATSAPP]`; refuses a recipient that does not fit the channel) and `DisabledNotificationProvider` (production default; every send throws 503). `AuthSecurity.notify/notifyLater` delegate to it and pick SMS for phone identifiers, email otherwise; `notifyLater` semantics are unchanged.
- **Web** (`/foundation`): a Passkeys card (`passkeys-panel.tsx`): add a named passkey (browser ceremony via `@simplewebauthn/browser`, recovery codes shown once for a first factor), list with added/last-used dates and synced/device-bound badge, remove, and **Verify with a passkey** next to the TOTP step-up form (the TOTP card now follows `totpEnabled`). A cancelled or failed browser prompt sends nothing. Refused passwords show "too easy to guess" / "found in a data breach". The auth response gained `user.totpEnabled` and `user.passkeys`. EN and SW strings (1009 keys each).

**Commands run (from the repository root unless noted) and actual results**

| Command | Actual result |
|---|---|
| `git switch -c phase-1/d1-passkeys main` | Branch created from clean `main` (`0918535`) |
| `npx pnpm@12.17.0 --filter @pm-buddy/api add @simplewebauthn/server@14.0.3 @zxcvbn-ts/core@4.2.0 @zxcvbn-ts/language-common@4.1.3 @zxcvbn-ts/language-en@4.1.1` | +64 packages; `.pnpmfile.mjs`: "Kept sha512 for 92 packages; computed it for 12 new ones", registry tarball URLs removed |
| `npx pnpm@12.17.0 --filter @pm-buddy/web add @simplewebauthn/browser@14.0.0` | "computed it for 1 new ones"; lockfile diff +290 lines, additions only |
| `grep -c 'integrity: sha1-' pnpm-lock.yaml` / `grep -c tarball: pnpm-lock.yaml` | 0 / 0 |
| `npx pnpm@12.17.0 licenses list --filter @pm-buddy/api --filter @pm-buddy/web --prod --json` | New packages and their dependencies: MIT (`@simplewebauthn/*`, `@zxcvbn-ts/*`, `@peculiar/*`, `@levischuck/tiny-cbor`, `@hexagon/base64`, `fastest-levenshtein`, `tsyringe`), BSD-3-Clause (`asn1js`). No AGPL/GPL/SSPL. The only copyleft entry is the pre-existing LGPL `@img/sharp-libvips` (Next.js) |
| Scratch database `pmb_scratch_passkeys` (created, all 10 migrations applied with `prisma migrate deploy`, then dropped) | As `pmb_app`: inserting a passkey set `mfa_enabled`; a duplicate credential ID and an unknown transport were refused; deleting an owner's only passkey was refused with and without a foreign `app.user_id` context, which was restored afterwards; a client could drop to no factor; `mfa_enabled = true` without a factor was recomputed to false; a passkey-only user could be made Finance; the custom-role path refused the last-factor removal and, after the role was made harmless, refused re-adding `payments.approve`; deleting a user cascaded through the trigger. **Two concurrent sessions, both orders**: removal committed first → the Finance grant waited and was refused; grant committed first → the removal waited and was refused |
| `npx pnpm@12.17.0 db:migrate` | First run: "All migrations have been successfully applied" (development database). Final run: "10 migrations found", "No pending migrations to apply" |
| `cd apps/api && npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` | "No difference detected.", exit code 0 |
| Mutation check (`passkey.service.ts` step-up: stored counter replaced by 0, an extra origin accepted) | 2 passkey e2e tests failed (origin and counter tests); file restored, all passkey tests passed |
| `npx pnpm@12.17.0 format:check` | "All matched files use Prettier code style!" |
| `npx pnpm@12.17.0 turbo run lint typecheck test i18n:check build --force` | 26 successful, 0 cached. oxlint "Found 0 warnings and 0 errors" in api, validation, i18n, domain and types; web ESLint clean. Unit tests: types 12, domain 34, validation 41, i18n 3, web 10, API 74 (174). `i18n OK: 1009 keys in en and sw, all ICU messages compile.` Web `next build` passed |
| `PATH=/tmp/pnpm-shim:$PATH npx pnpm@12.17.0 turbo run test:e2e --force` | 7 successful, 0 cached. API: 5 files, **68 tests** (health 7, identity 34, roles 10, passkeys 13, passwords 4) against `pmb_test` under `pmb_app`. Web: **12** Playwright tests with axe. The identity file prints Node's `MaxListenersExceededWarning` (supertest listeners during its 45 concurrent sign-ins; it occurs with that file alone) |
| `npx pnpm@12.17.0 install --frozen-lockfile` | "Lockfile is up to date"; passed |

**New test coverage**

- `apps/api/test/passkeys.e2e-spec.ts` (real `@simplewebauthn/server` verification; `test/webauthn.ts` is a software ES256 authenticator with a small CBOR encoder producing `none`-attestation registrations and signed assertions): the six OpenAPI operations, 401 without a session and 403 without CSRF; first-factor registration with options, stored digest/session-bound/consumed challenge, credential row, recovery codes and listing without credential material; replayed registration (400); wrong origin, wrong RP ID and missing user verification at registration (400); duplicate credential ID from another account (409) and duplicate names (409); freshness rules (stale sign-in 403; a fresh password-only session of an account with a factor cannot add a passkey or TOTP until it steps up); step-up sets the MFA time, updates counter/last use and unlocks company actions; TOTP step-up refused for a passkey-only account; replayed, expired, other-session and superseded challenges (401, counted); wrong origins, wrong RP ID, forged signature, no user verification and another account's passkey (401); counter regressions refused and zero-counter authenticators accepted; a passkey-only user accepts the Finance role; last-factor removal refused (403 when stale, 409 fresh, database refusal on direct delete, and 409 rather than 500 when the API check is bypassed); removal with a second factor and by a non-privileged user (mfa off afterwards); a passkey next to TOTP keeps the recovery codes; five failed assertions → 429, notification, session revoked, options locked, unlocked step-up works.
- `apps/api/test/passwords.e2e-spec.ts` (fake breach checker, no network): weak, identifier-, name- and product-derived passwords refused with `password-too-weak` and nothing stored or sent; breached passwords refused; identical answers for existing and new accounts; strength checked before the lookup; reset refuses weak, identifier-derived and breached passwords without spending the token; invalid reset tokens trigger no lookup.
- `apps/api/test/identity.e2e-spec.ts`: new real-Mailpit test that a phone registration arrives at `phone-<number>@development.invalid` with subject `[DEVELOPMENT ONLY][SMS] Verify your account` and its code verifies; the existing email Mailpit test still passes.
- Unit: `password-policy.spec.ts` (scores, context, generic codes, HIBP prefix/padding/suffix matching and fail-open logging without the password or any part of its hash, using a faked fetch), `notification.provider.spec.ts` (channel routing and prefixes, mismatched recipients, disabled provider), problem-filter custom codes, validation passkey contracts and env.
- Web `apps/web/test/passkeys.spec.ts`: Chromium's virtual authenticator (CDP WebAuthn domain) performs registration, a user-verification failure that sends nothing, a step-up (sign count increases) and removal against a mocked API that checks challenge, origin and type in `clientDataJSON`; EN and SW password refusals; axe on each. `foundation.spec.ts` mocks gained the new auth fields and the passkey listing; the Kiswahili test checks the Passkey card.

**Limitations and follow-ups**

- No real SMS, WhatsApp or email provider (Africa's Talking in D7.3); SMS OTP as a second factor for low-privilege roles is not implemented.
- No passwordless/usernameless passkey sign-in, attestation verification or authenticator allow-list. Passkeys are bound to the `WEB_ORIGIN` hostname: changing it orphans them, and IP-address origins cannot use them.
- Passkey and TOTP changes are user-level events: they send notifications but are not in a company's audit log (no user-level security log yet).
- The breached-password check is off by default, fails open, and was not exercised against the live service (tests use fakes). zxcvbn runs on the event loop (bounded by the 64-character prefix and the registration/reset rate limits); move it to a worker if registration volume grows.
- `docs/api/openapi-outline.yaml` still describes the design-time passkey paths (`/mfa/passkeys/...`); the live API documents its own paths in `/api/docs`.
- axe flags the shared primary button's **hover** colour (`hover:bg-primary/80`, 4.38:1) when the pointer rests on it; the new browser tests scan at rest like the existing ones. Pre-existing design-system issue to fix separately.
- Kiswahili passkey and password wording needs a human language review. Nothing was committed or pushed; no GitHub CI run is claimed.

## Independent review of D2.1

A separate reviewer found four issues; all are fixed with regression tests (API e2e 85/85, web 30/30 three runs in a row):

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | Medium | Open redirect: `?next=/.//evil.example` (or `/..//`, `/%2e%2e//`) normalised to `//evil.example` after the raw-string checks, sending a signed-in user to another site | The normalised path is checked too (no leading `//`, no backslash); five new unit cases |
| 2 | Medium | Invitations skipped the project-level escalation guard: acceptance grants the role's project permissions, but the inviter only needed `projects.manage` there | The inviter must hold every permission the invitee would get on each invited project (role ∩ their assignment), as for direct assignment; e2e test |
| 3 | Low | A code like `PRJ-9999999999999999` made the next automatic code overflow `VARCHAR(20)`, so every later create without a code failed with a 500 | Only `PRJ-` + up to 12 digits counts towards automatic numbering; e2e test |
| 4 | Low | An optional reason of 1–2 characters failed the database check with a 500 | The shared schema and the lifecycle rules require at least 3 characters whenever a reason is given; the dialogs disable submit; unit and e2e tests |

Also: the site honours "reduce motion" (WCAG 2.3.3), and the browser tests run with it on, removing a flaky accessibility scan of a button mid-fade.

**Local toolchain note.** On 11/11/2026 this Mac's `/usr/local/bin/node` pointed to Bun and Homebrew's Node was an x86_64 build, which can't load the arm64 native modules. Verification used the official Node 24.22.2 darwin-arm64 build (SHA-256 checked against nodejs.org) via PATH only; nothing on the system was changed.

## D2.1 projects, sites and geofences (branch `phase-2/d2.1-projects-sites`)

Status: built and verified locally; committed and pushed for CI and independent review. Design: [ARCHITECTURE §4.1](./ARCHITECTURE.md#41-projects-module-d21), §8 (wider project assignments), §18 (sign-in wiring, maps) and decisions D-27–D-29; implemented-model differences in [ERD §3](./ERD.md#3-projects-sites-and-schedule); walkthrough in the [Phase 2 demo](./demos/phase-2.md).

**What changed**

- **Shared packages.** `types`: Kenya's 47 counties, contract types, project/milestone statuses, geofence kinds and `PROJECT_ASSIGNABLE_PERMISSIONS` (26 project-scoped catalogue permissions). `domain` (now depends on `types`): `geofence.ts` (normalisation, validation with stable issue codes, area, perimeter, point-in-fence), `project-lifecycle.ts` (project and milestone transitions, activation checklist), `wbs.ts` (sibling weight groups, progress). `validation`: `projects.ts` with every D2.1 request and response schema (`projectSchema` moved here from `identity.ts`; `projectPermissionSchema` now uses `PROJECT_ASSIGNABLE_PERMISSIONS`).
- **Database.** Migration `20261110100000_projects_sites_geofences` (no existing migration edited): project fields, lifecycle trigger `app.guard_project`, `projects_active_details_check`, code unique per company (existing rows backfilled to `PRJ-001…` per company under NO FORCE/FORCE with a count assertion); new `project_status_changes`, `sites`, `site_geofences` (append-only versions, shape CHECKs, version/`effective_from` trigger), `wbs_nodes` (composite parent key, cycle trigger) and `milestones` (lifecycle trigger); forced RLS with WITH CHECK on every new table; composite `(tenant_id, …)` foreign keys; UPDATE/DELETE revoked from `pmb_app` on history tables and DELETE on `sites`; `project_permissions_check` widened to the 26 permissions.
- **API.** New `projects` module (23 operations, OpenAPI-annotated; table in §4.1) replacing the identity module's four project endpoints (list, create, rename, assign). All through `AccessPolicy`, the tenant transaction and the hash-chained audit log (field names only, plus `reasonGiven`). New helpers `src/common/openapi.ts` and `src/common/database-errors.ts`. `db:seed` (API and root; turbo task depends on the build, uncached, passes `NODE_ENV` through).
- **Web.** `/sign-in` wired to the API (`lib/live-api.ts` for browser calls with CSRF and single-flight refresh; `lib/server-api.ts` for server components through `API_INTERNAL_URL`, forwarding only the Cookie header; `lib/safe-next.ts` for relative `next` paths). The office layout reads the session: the top bar shows the user, role and company and offers sign-out; live pages redirect to sign-in without a session. Live `/projects`, `/projects/[projectId]` (Overview, Sites, Team, WBS & milestones tabs, BQ tab linking to the labelled prototype), `/projects/[projectId]/sites/new` and `/sites/[siteId]`. Components in `components/projects/*` and `components/maps/*` (custom react-leaflet editor; no new map dependency). The D0 project screens moved to `/prototype/projects/…` and are labelled. 13 new EN/SW namespaces (`i18n:check`: 1,409 keys in each).
- **Dependencies.** None from the registry. Workspace links only: `@pm-buddy/types` added to `apps/web` and `packages/domain` (lockfile +6 lines, importer entries only).

**Behaviour changes to note (existing code and tests)**

- `POST/GET/PATCH /projects` return the full D2.1 project shape, and `PATCH /projects/:id` requires the `version` the client read. Existing e2e tests in `identity.e2e-spec.ts` and `roles.e2e-spec.ts` now send `version` on PATCH and include `code` in direct Prisma creates; their assertions are unchanged. `test/support.ts` response contracts cover the new routes. The web `foundation.spec.ts` mocked project now has the D2.1 shape (it failed with "unexpected response" until updated, because the console parses responses with the shared schema).
- A stale-MFA refusal (`AuthService.requireMfa`) is still 403 but now carries `code: "step-up-required"`, so the office app can offer the step-up dialog; the foundation console treats that code like its existing "forbidden" message.
- An invitation's default project assignment is now the invited role's permissions within `PROJECT_ASSIGNABLE_PERMISSIONS` (previously only `projects.view`/`projects.manage`); role ∩ assignment still applies.
- `apps/api/src/modules/identity/identity.schemas.spec.ts` now checks `projectAssignmentRequestSchema` (the assignment schema moved to `projects.ts`).

**Commands run (from the repository root unless noted) and actual results**

| Command | Actual result |
|---|---|
| `git switch -c phase-2/d2.1-projects-sites main` | Branch created from clean `main` (`ac692fc`) |
| `npx pnpm@12.17.0 install` (after adding the workspace links) | Lockfile diff +6 lines, importer entries only |
| `npx pnpm@12.17.0 format:check` | "All matched files use Prettier code style!" |
| `npx pnpm@12.17.0 turbo run lint typecheck test i18n:check build` | Passed: 26 successful, 4 cached (the `types`/`domain`/`validation` builds and `db:generate`, replayed with unchanged inputs; every lint, typecheck, test, i18n and the web/API builds executed). oxlint "Found 0 warnings and 0 errors" in `i18n`, `types`, `domain`, `validation` and `api`; ESLint clean in web. Unit tests: types 15, domain 64, i18n 3, validation 52, web 18, API 77 (229). `i18n OK: 1409 keys in en and sw, all ICU messages compile.` `next build` passed with the new routes |
| `npx pnpm@12.17.0 db:migrate` | "12 migrations found in prisma/migrations", "No pending migrations to apply." (the D2.1 migration had been applied to the development database earlier in this session) |
| `npx pnpm@12.17.0 db:seed` (run 1 of this verification) | Exit 0. "Demo company: Jenga Bora Builders Ltd (already present)"; three accounts with "password: unchanged"; the owner's existing TOTP secret/URI; "RUI-HTS … active (already present)", "KIT-BNG … active (already present)", "SYO-TWN … planning (already present)". The data had been created by the first ever run earlier in this session, which printed "(created)" and generated passwords |
| `npx pnpm@12.17.0 db:seed` (run 2) | Exit 0; output identical to run 1 (no duplicates; idempotence is also asserted by the e2e seed test) |
| `NODE_ENV=production npx pnpm@12.17.0 db:seed` | Exit 1: "Refusing to seed demo data: NODE_ENV is production." |
| `npx pnpm@12.17.0 --filter @pm-buddy/api db:seed --reset-credentials` | Exit 0; new passwords printed for all three accounts (checks the documented flag) |
| `PATH=/tmp/pnpm-shim:$PATH npx pnpm@12.17.0 turbo run test:e2e` | Passed: 7 tasks (both `test:e2e` tasks executed; 5 cached build/generate dependencies). API: 6 files, **82 tests** against `pmb_test` under `pmb_app` (projects 12, identity 34, plus health, roles, passkeys and passwords). Web: **30** Playwright tests in 1.1 min (16 new: sign-in 4, projects 9 including the EN/SW × light/dark axe matrix and the 360 px check, site editor 3) |
| `cd apps/api && npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` | "No difference detected.", exit code 0 |
| `grep -c 'integrity: sha1-' pnpm-lock.yaml`; `grep -c tarball: pnpm-lock.yaml` | 0; 0 |
| `npx pnpm@12.17.0 install --frozen-lockfile` | Passed: "Lockfile is up to date, resolution step is skipped" |

**API e2e coverage (`apps/api/test/projects.e2e-spec.ts`, real `pmb_app` role):** OpenAPI documents every operation; planning projects with chosen or automatic codes, unique per company (409), step-up required; list by status and search limited to viewable projects; optimistic-version updates with audit metadata limited to field names; geofence validation (self-intersection, repeated closing vertex, out-of-bounds, tiny and huge areas, radius range), a new version per change with earlier versions unchanged (deep-equal before and after), the version in force at a given time, stale `currentVersion` refused, and direct UPDATE/DELETE of versions or sites by the runtime role refused; the lifecycle with every invalid transition refused (API and trigger), reasons required, activation checklist, read-only closed/cancelled projects and a fixed code; a site agent can view an assigned project but not manage it or see others; WBS weights (incomplete groups keep progress null, cycles and depth refused, reorder); milestone transitions; team assignment and removal within the escalation guard (unheld permissions and assignments by members without `users.invite`/`projects.manage` refused, role ∩ assignment applied); company B cannot read, change or reference company A's projects, sites, geofences, WBS nodes or milestones by guessed IDs or composite keys; the seed run twice creates nothing new.

**Issues found by the checks and fixed (no check was disabled or weakened)**

- axe `label-content-name-mismatch`: the account-menu button and the "Open project"/"Edit site and geofence" links had `aria-label`s that did not contain their visible text; they now use visible text plus screen-reader-only context, and the Kiswahili "remove member" label now starts with the visible word ("Ondoa").
- axe `aria-valid-attr-value`: the sign-in Email/Phone tabs pointed `aria-controls` at panels that were never rendered (also true of the D0 prototype); both panels now stay mounted (inactive one hidden).
- The 360 px check found horizontal scrolling on the Team tab: a screen-reader-only header inside the scrollable table escaped its container; scroll containers are now positioned.
- `next dev` logged "window is not defined" while server-rendering the site editor (it imported a Leaflet module for one constant); the constant moved to a Leaflet-free module.
- "Clear filters" kept the old search text in the uncontrolled field; the filter form is now keyed by the query.
- The first full web run had one failure in the existing `foundation.spec.ts` roles test (axe colour contrast of a primary button measured mid-transition, 2.4:1) while the dev server was compiling; it passed when rerun alone and in both later full runs. Not reproduced since; noted as a possible timing flake in that existing test.

**Incidents and notes**

- While checking the migration's backfill by hand, `ALTER TABLE projects NO FORCE ROW LEVEL SECURITY` was run once against the **development** database through psql; FORCE was restored immediately and every tenant table was re-checked as forced. No test or production database was involved. The migration itself lifts FORCE only inside its transaction and restores it.
- `identity.e2e-spec.ts` prints Node's `MaxListenersExceededWarning` (11 listeners on the supertest server) when run alone or in the full suite; it comes from that file's existing parallel requests (`Promise.all`), which this branch did not change. `projects.e2e-spec.ts` alone prints no warning.
- A real-API browser smoke (real sign-in with the seeded owner and TOTP, then list, overview, sites, team, WBS and the editor) was run earlier in this session with a scripted Playwright browser against the development API; the screens rendered correctly. The scratch script and screenshots were deleted.

**Limitations and follow-ups**

- Sites cannot be deleted yet (attendance will reference them). Progress and every KPI are "unavailable" until their modules exist (D2.2–D6.x). No passwordless passkey sign-in. Server components cannot refresh an expired access token (the refresh cookie is scoped to `/api/v1/auth`), so the user passes through `/sign-in`, which refreshes silently and returns.
- Production map tiles are still undecided (D-10, Q-T4); the editor's coordinate list works without tiles.
- Client details are plain fields until the client portal (D7.1); practical completion, the defects liability period and payment-linked milestones arrive with valuations (D6.x).
- Kiswahili strings need review by a native speaker (§15 H). GitHub CI has not run on this branch.
- Once during development a single server-side fetch from `next dev` to the API hung for about ten seconds (likely a stale socket after a crashed browser run); it did not recur.

## Independent review of D2.2

A separate reviewer reproduced three high-severity denial-of-service paths in upload parsing (reachable wherever uploads are enabled; the production default refuses uploads until a malware scanner is configured) and one medium bug. All are fixed, each with a regression test that fails without the fix:

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | High | Zip bomb past the upload check: SheetJS sizes entries from local headers or data descriptors and inflates without a bound, while the check read only the central directory (a 719 KB file grew the API process by 1.8 GB) | The parse worker inflates every entry itself with a hard cap equal to the size the central directory declares, checks length and CRC-32, refuses overlapping or duplicate entries, and hands SheetJS a rebuilt, uncompressed archive. Legitimate files with data descriptors still read |
| 2 | High | One shared string repeated in 200,000 cells cost little in the worker but was copied per cell into the API thread (about 3 GB) | The worker stops at 20 million characters of cell text in total (`too-much-text`) |
| 3 | High | A bill-number pattern backtracked on runs of Unicode spaces, blocking the API for minutes (the reviewer's input: 22.5 s for 400 rows on the old code) | Row text collapses all Unicode whitespace and both bill patterns use single optional spaces, so matching is linear |
| 4 | Medium | Templates couldn't be saved when the reference column had no title (negative offset rejected); a data offset above 20 caused a 500 | Template offsets are signed end to end (a template that doesn't fit a sheet isn't applied); offsets above 20 return a 400 |

## D2.2 BQ import (branch `phase-2/d2.2-bq-import`)

Status: built and verified locally; **not committed** (left for review). Design: [ARCHITECTURE §4.3](./ARCHITECTURE.md#42-bq-module-and-excel-import-d22), §17.8 and decisions D-13/D-15 (now Accepted); implemented-model differences in [ERD §4](./ERD.md#4-bq-variations-valuations-and-subcontracts); configuration in [CONFIGURATION](./CONFIGURATION.md) (`bq.vat.rate`, `bq.rounding`, `bq.import.*`, `MALWARE_SCANNER`, `BQ_VAT_RATE_PERCENT`); walkthrough in the [Phase 2 demo](./demos/phase-2.md#d22-bq-import). Every earlier security fix (D1.x reviews, the D2.1 review items) is untouched.

> **Acceptance still needs a real BQ.** Only synthetic workbooks generated by `apps/api/test/fixtures/bq/generate.mts` have been imported. The roadmap acceptance "A real Excel BQ imports correctly and totals match" needs an **anonymised real Kenyan BQ from the owner**; until then D2.2 stays ⏳.

**What changed**

- **Dependencies.** `xlsx` 0.20.3 from the SheetJS CDN (`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`, Apache-2.0; lockfile integrity `sha512-oLDq3jw7…AJA==`, which matched an independent `curl | openssl dgst -sha512` of the tarball) and `pdfmake` 0.3.13 (MIT; brings `pdfkit` 0.20.2, `fontkit` 2.0.4, `xmldoc`, `sax` (BlueOak-1.0.0) and other MIT packages), added with `npx pnpm@12.17.0 --filter @pm-buddy/api add …`; workspace link `@pm-buddy/i18n` added to the API (export labels in EN/SW). Lockfile +154 lines, additions only; `.pnpmfile.mjs` untouched. `pnpm licenses list --filter @pm-buddy/api --prod`: Apache-2.0, MIT, BSD-2/3, ISC, 0BSD, BlueOak-1.0.0 and PSF-2.0 (`argparse`, already present); no GPL, AGPL or SSPL.
- **Shared packages.** `types/bq.ts` (import statuses, limits, failures, sheet/bill/item kinds, amount sources, units, issue codes with severities, row actions, `BQ_VAT_RULE`, `BQ_ROUNDING`, `BQ_AMOUNT_TOLERANCE_MINOR`). `domain/bq/*` (grid model, text safety and `spreadsheetSafeText`, strict number parsing, units, header detection, sheet scoring, classification, the row-by-row bill builder, summary reconciliation, `buildBqImport`, the import lifecycle) and `money.ts` (`lineAmountFromRate`, `decimalToMinor`). `validation/bq.ts` (every request and response) and `env.ts` (`MALWARE_SCANNER`, `BQ_VAT_RATE_PERCENT`).
- **Database.** Migration `20261110110000_bq_import` (no existing migration edited): `bq_mapping_templates`, `bqs`, `bq_versions`, `bq_bills`, `bq_sections`, `bq_items`, `bq_imports`; `tenant_id`, ENABLE + FORCE RLS with `WITH CHECK` on `app.current_tenant_id()` and composite `(tenant_id, …)` FKs (including to the project) on all seven; item amount CHECK per `amount_source`; version totals CHECK; deferred constraint triggers that re-add items/sections/bills at commit; `app.guard_bq_import` (transitions, immutable source columns); `app.guard_bq_version_content` (content changes only on drafts); S3 key format CHECKs; one committed import per version; no DELETE for `pmb_app` on imports, BQs or versions.
- **API.** `bq` module (21 operations, OpenAPI-annotated; table in ARCHITECTURE §4.2 and `apps/api/README.md`), `src/infra/malware-scanner.ts` (`MalwareScanner`, development no-op, ClamAV TODO), `StorageService` put/get/delete, `src/common/uuid.ts` (UUIDv7), worker-thread parser and ZIP inspection. `TenantScope.run`/`TenantDatabase` take an optional transaction timeout (commit uses 120 s); `ProjectsModule` exports `ProjectAccess`. `.env.example` sets `MALWARE_SCANNER=development` and `BQ_VAT_RATE_PERCENT=16`.
- **Web.** Live `/projects/[projectId]/bq` (viewer) and `/bq/import` (wizard) with `components/bq/*`; the project's BQ tab links there for `bq.view` holders (no prototype label); the D0 BQ screens moved to `/prototype/projects/[projectId]/bq` (the sidebar's "BQ and variations" and the home tour still point at the prototype until D2.3); `liveUpload` (multipart with CSRF) in `lib/live-api.ts`; `formatDecimalString` and `decimalKesToMinor` in `lib/format.ts`; BQ problem codes mapped to messages. New EN/SW namespaces `liveBq`, `bqWizard`, `bqIssues`, `bqExport` (`i18n:check`: 1,807 keys in each).
- **Tests.** Fixture generator and committed fixtures (`apps/api/test/fixtures/bq`: multi-bill `.xlsx` and `.xls`, single-sheet, messy, zip bomb, PNG renamed `.xlsx`); domain tests `bq/parsing.test.ts`, `bq/build.test.ts`, extended `money.test.ts`; validation `bq.test.ts`; API unit specs for file inspection, the parser (limits, timeout, heap), export formatting, the scanner and UUIDv7; API e2e `test/bq.e2e-spec.ts` (13 tests); web `test/bq.spec.ts` (9 tests) with `test/mock-bq.mts` and `test/mock-bq-grids.mts` wired into `test/mock-api.mts`; two `format.test.ts` cases.

**Behaviour changes to note (existing code and tests)**

- `apps/web/test/mock-api.mts` now reads raw request bodies (JSON only when the content type is JSON, so multipart uploads reach the BQ mock), and the mock site agent's Ruiru assignment includes `bq.view` (as the seed's does). `test/projects.spec.ts` therefore expects "3 permissions" for Kevin Kiprono, and the BQ tab link is now "BQ" → `/projects/<id>/bq` instead of "BQ Prototype" → `/projects/ruiru-heights/bq`.
- `apps/web/tsconfig.json` sets `allowImportingTsExtensions` (type-check only; `noEmit` is on) so the mock API's `.mts` modules can import each other as Node runs them.
- New `apps/web/turbo.json` makes the web `typecheck` wait for the web `build`. In the first final run `tsc` read `.next/types/validator.ts` while `next build` was regenerating `.next/types`, and failed with `Cannot find module './routes.js'`; the same combined command runs in CI. With the ordering, `tsc` always sees a complete set of generated route types.
- `apps/api/test/support.ts` knows the BQ response contracts and gained `upload()` (multipart with cookies, origin and CSRF) and `download()` (binary bodies).
- CONFIGURATION: `bq.import.max_file_mb` is 10 (was 20 in the design), as the deliverable specifies.

**Commands run (from the repository root unless noted; PATH set to the verified arm64 Node 24.22.2 and the pnpm shim) and actual results**

| Command | Actual result |
|---|---|
| `git switch -c phase-2/d2.2-bq-import main` | Branch created from `main` |
| `npx pnpm@12.17.0 --filter @pm-buddy/api add https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz pdfmake@0.3.13` | Added; lockfile records `xlsx@https://cdn.sheetjs.com/…` with `integrity: sha512-oLDq3jw7…` and `tarball:` the CDN URL |
| `npx pnpm@12.17.0 format:check` (final) | "All matched files use Prettier code style!" (an earlier run flagged only a scratch `licenses.json`, deleted) |
| `npx pnpm@12.17.0 turbo run lint typecheck test i18n:check build` | First final run: **failed** in `@pm-buddy/web#typecheck` (`.next/types/validator.ts(5,56): error TS2307: Cannot find module './routes.js'`, the build/typecheck race above). After `apps/web/turbo.json`: passed, 26 successful (18 cached); with `--force`: **26 successful, 0 cached**; last run after the final edits: 26 successful (22 cached). oxlint "Found 0 warnings and 0 errors" in `types`, `i18n`, `domain`, `validation`, `api`; ESLint clean in web. Unit tests: types 15, domain 130, i18n 3, validation 56, web 20, API 94 (318). `i18n OK: 1807 keys in en and sw, all ICU messages compile.` `next build` passed |
| `npx pnpm@12.17.0 db:migrate` | "13 migrations found in prisma/migrations", "No pending migrations to apply." (the D2.2 migration was applied to the development database earlier in this session) |
| `npx pnpm@12.17.0 turbo run test:e2e` | Passed twice: 7 tasks (both `test:e2e` tasks executed). API: 7 files, **98 tests** against `pmb_test` under `pmb_app` (`bq.e2e-spec.ts` 13 in about 24 s). Web: **39** Playwright tests in 1.1 min (9 new in `bq.spec.ts`). A third run after the last edits (the `validation-stale` assertions in `bq.e2e-spec.ts`, docs) **failed to start the web suite**: "Another next dev server is already running" — a `npx pnpm@12.17.0 dev` started by another process in this shared environment (API on :4000, web on :3000) held Next's dev-server lock for `apps/web`. It was not mine, so it was left running |
| `npx pnpm@12.17.0 turbo run test:e2e --filter=@pm-buddy/api` (after the last edits) | Passed: 7 files, **98 tests** |
| `npx playwright test` from a temporary sibling copy of `apps/web` (`apps/.web-e2e-copy`, same relative `node_modules` links, deleted afterwards), because of the lock above | Passed: **39 tests** in 52.7 s. The web code was unchanged since the passing root runs. (pnpm's pre-run dependency check failed harmlessly in the copy, which is outside the workspace; the lockfile and `node_modules` were unchanged and `install --frozen-lockfile` passed again afterwards) |
| `cd apps/api && npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` | "No difference detected.", exit code 0 |
| `grep -c 'integrity: sha1-' pnpm-lock.yaml`; `grep -c 'tarball:' pnpm-lock.yaml` | 0; 1 (`tarball: https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`) |
| `npx pnpm@12.17.0 install --frozen-lockfile` | Passed: "Lockfile passes supply-chain policies", "Lockfile is up to date, resolution step is skipped" |
| `npx pnpm@12.17.0 licenses list --filter @pm-buddy/api --prod --json` | Licences listed above; no copyleft |

**API e2e coverage (`apps/api/test/bq.e2e-spec.ts`, real `pmb_app` role):** OpenAPI documents every BQ operation; the multi-bill workbook end to end (upload → parse → detection → mapping → validate → accept the contract-sum warning → preview → commit) with every bill total, subtotal **3,331,654,203**, VAT **533,064,672** and grand total **3,864,718,875** minor units, 39 items, Bill 2's section titles and items (binding wire KES 7.13, the ground-beams line, the `Cu.m` unit), the PC/provisional/dayworks/contingency lines and the Preliminaries/PC/attendance-profit/provisional/contingency/dayworks breakdown asserted exactly, search, the stored source under the tenant/project key equal to the upload with its SHA-256 (the key never appears in responses), and audit metadata free of file names, descriptions and amounts; the single-sheet layout (other column order and names; grand total **334,008,530**), with the Excel export re-read by SheetJS (totals numeric and equal, a description beginning with `=` written as text with a leading apostrophe) and the PDF starting with `%PDF` with a safe `Content-Disposition`; the legacy `.xls` with the same totals as the `.xlsx`; the messy workbook (issues with their rows; the duplicate ref and the 947,400 vs 974,400 amount block the commit with 409 `commit-blocked`; a sheet override without a reason, a decision for a row that was not offered, accepting an info item and a two-character reason are refused with 400; resolving only the errors still leaves the commit blocked until the warnings are accepted; excluding row 10 and overriding row 23 with a reason gives grand total **453,177,200**; the override is stored with its reason); re-import replaces the draft (same version row, `version` bumped) and the earlier import becomes `superseded`; **a forced failure after the first chunk of items rolls everything back** (the existing draft's version and bills are unchanged, the import stays `validated` with no version link and no commit audit event, and the same commit then succeeds); a parse that crashes leaves the import `uploaded` and it resumes with `POST …/parse`; invalid transitions (409 `invalid-import-state`), stale versions (409 `version-conflict`) and invalid mappings (400) refused; a contract sum changed after validation makes the commit 409 `validation-stale` until it is validated again; abandon is final; mapping templates saved, matched by header signature, applied and deleted (name unique per company); a site agent without `bq.import` gets 403 on upload, the import list and detail, the source file and templates, but can read and export the BQ; a project manager assigned to another project gets 403 on this one (and can upload to their own); an unauthenticated upload is refused before the body is read; the owner's source download matches the upload byte for byte; company B gets 404 for A's BQ, import, source file and bill by ID, sees no templates, cannot delete A's template, build one from A's import or commit A's import, and under B's tenant context RLS returns none of A's rows while inserting rows for A or pointing at A's project is refused (S3 keys are never returned by the API); upload safety (zip bomb 422 `unsafe-archive`; a PNG renamed `.xlsx`, an `.xls` renamed `.xlsx`, an `.xlsx` renamed `.xls` and a CSV all 415 `unsupported-file-type`; over 10 MB 413 `payload-too-large`) with nothing stored; and database protections under `pmb_app` (changing a committed import's mapping or source key, deleting an import, an item amount that breaks the amount rule, bill totals that no longer add up, and content edits after the version leaves draft are all refused).

**Issues found by the checks and fixed (no check was disabled or weakened)**

- Duplicate references: an excluded duplicate row was still counted, so excluding it did not clear the error; fixed in `bill.ts` with a domain test.
- axe `color-contrast` (4.38:1): an "info" badge on the wizard's muted status strip; the strip now uses the card background.
- Playwright found two regions with the same name ("Rows of the sheet as uploaded"); the outer wrapper no longer has a landmark label.
- ESLint/oxlint warnings in new code (unused destructured names in the mock; a `no-control-regex` disable comment that Prettier had moved away from its regex) fixed in code.
- Commits of two imports for the same project could race to create the BQ; the commit now locks the project row (`FOR NO KEY UPDATE`) before the import row.
- The web build/typecheck race described above.

**Incidents and notes**

- While reworking the deferred totals check, the uncommitted D2.2 migration was rolled back by hand on the **development** database (psql: dropped the new objects and its `_prisma_migrations` row) and re-applied; `prisma migrate diff` then reported no difference. No test or other database was touched.
- A worker given a heap limit of 1–2 MB makes V8 abort the whole process (seen in a scratch experiment); 4 MB and above end the worker cleanly with `parse-memory`. The limit is a code constant (384 MB), and a unit test pins the clean behaviour at 8 MB.
- `identity.e2e-spec.ts` still prints Node's `MaxListenersExceededWarning` (pre-existing, noted in D2.1).
- The full web run prints `[WebServer] ⨯ Error: The destination stream errored while writing data.` from `next dev` during `site-editor.spec.ts` (reproduced with that file alone; `bq.spec.ts` alone prints nothing). The tests pass; it looks like a server-rendered stream cut short by a navigation. Not investigated further (it is not from the BQ pages).

**Limitations and follow-ups**

- **Real BQ needed** (see above). Detection is tuned on synthetic layouts; expect to adjust keywords and heuristics on real files.
- No ClamAV: `MalwareScanner` is a development no-op (records `not_scanned`); `disabled` (the default) refuses uploads. Wire ClamAV before any pilot.
- Not supported yet: split "KShs | Cts" amount columns, nested sub-sections (flattened to one level), manual BQ edits (`bq.edit` unused), approval, variations and revisions (D2.3), and rate build-ups.
- The PDF renders in the API process (capped at 10,000 items); moving rendering and very large parses to the background worker comes with the reports module.
- The deferred totals trigger relies on a per-transaction marker; a session that runs `SET CONSTRAINTS … IMMEDIATE` could check earlier than intended. Only direct database access could do that; the API never does.
- VAT handling (rate, recompute-on-subtotal, inclusive/exclusive presentation) needs the tax review (CR-TAX-01). Kiswahili strings need a native speaker's review. The PDF layout has been checked by tests (structure, `%PDF`) but not yet by a person. GitHub CI has not run on this branch.

## Independent review of D2.3

A separate reviewer found three issues; all are fixed with a regression test (variations e2e 12/12; with the API rule removed the test fails, and the database still refuses the decision):

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | High | Maker-checker counted only a variation's creator and submitter, so a colleague could write all the lines and then approve them | `variation_orders.contributors`, kept by triggers on the variation and its lines (only ever grows); a decider on the list is refused by the API and by `variation_orders_state_check` |
| 2 | Medium | Baseline approval ignored whoever mapped or resolved the import, which can change the contract sum | `bq_imports.contributors` (upload, mapping, resolutions, validation, commit), checked by the API and by `app.guard_bq_version` |
| 3 | Medium | The database guard let content be re-pointed out of an approved version (`UPDATE bq_bills SET version_id = <draft>`), reproduced by the reviewer | The guard refuses any change of version or lineage and checks the row's current version; the totals check also re-validates the version a row left |

## D2.3 BQ versions, instructions, variations and rate build-ups (branch `phase-2/d2.3-bq-variations`)

Status: built and verified locally in a separate git worktree with its own Docker stack (`pmb-d23`: PostgreSQL on 55632); **not committed** (left for review). Design: [ARCHITECTURE §4.3](./ARCHITECTURE.md#43-bq-versions-variations-and-rate-build-ups-d23), §8 and decisions D-30 to D-33; implemented model in [ERD §4](./ERD.md#4-bq-variations-valuations-and-subcontracts); workflow additions in [WORKFLOWS](./WORKFLOWS.md#variation-as-implemented-d23); new invariants in [INVARIANTS](./INVARIANTS.md); acceptance rows and **Phase 2 acceptance** in [ACCEPTANCE_MATRIX](./ACCEPTANCE_MATRIX.md#phase-2-acceptance-projects-and-bq-d21d23); configuration (`bq.buildup.rounding`, `bq.buildup.limits`, `bq.variation.*`, build-up assumptions) in [CONFIGURATION](./CONFIGURATION.md); walkthrough in the [Phase 2 demo](./demos/phase-2.md#d23-bq-versions-instructions-variations-and-rate-build-ups). Every earlier security fix (D1.x reviews, the D2.1 and D2.2 review items) is untouched.

**What changed**

- **Dependencies.** None added or changed; `pnpm-lock.yaml`, every `package.json` and `.pnpmfile.mjs` are unchanged.
- **Shared packages.** `types/variations.ts` (instruction issuer roles and statuses, variation statuses, actions, line actions, line issue codes, addable kinds and limits, build-up resource kinds, limits, output units and `BUILDUP_ROUNDING`); `types/bq.ts` adds the amount sources `fixed` and `omitted` and `BQ_VERSION_SOURCES`. `domain/bq/variation-lifecycle.ts` (state machine), `variation.ts` (line pricing, `variationTotals`, `projectedTotals`, `versionTotals`, `applyVariation`, `variationSnapshotText`), `compare.ts` (`compareVersions`), `buildup.ts` (`buildupLineAmountMinor`, `buildupRate`, `unitsCompatible`). `validation/variations.ts` (every D2.3 request and response); `validation/bq.ts` gains lineage IDs, nullable source rows, version lineage and approval fields, `permissions.canEdit/canApprove`, `baselineApproval` and the item's build-up link. EN/SW namespaces `bqNav`, `bqIndex`, `contractSum`, `baseline`, `variations`, `variationDetail`, `instructions`, `bqVersions`, `rateBuildUps`, plus `liveBq` and `apiErrors` additions (`i18n:check`: 2,209 keys in each).
- **Database.** Migration `20261110130000_bq_variations` (no existing migration edited): `lineage_id` on bills and sections (unique per version, like items); nullable paired `source_sheet/source_row`; amount sources `fixed`/`omitted`; version `parent_version_id`, `variation_id`, `approved_by/at` with lineage, approval and uniqueness constraints; tables `instructions`, `variation_orders`, `variation_lines`, `variation_status_changes`, `rate_buildups`, `rate_buildup_versions`, `rate_buildup_lines`, `bq_item_rate_links`, each with `tenant_id`, ENABLE + FORCE RLS with `WITH CHECK` on `app.current_tenant_id()` and composite `(tenant_id, …)` FKs (project, BQ, version, bill/section/item lineage, instruction, variation, build-up version); triggers `app.guard_bq_version`, `app.guard_variation_order`, deferred `app.check_variation_version`, `app.guard_variation_line`, deferred build-up totals and current-version checks, `app.guard_bq_item_rate_link`; DELETE revoked on the history tables and UPDATE on status changes and build-up versions/lines for `pmb_app`. `prisma/schema.prisma` models all of it (the partial unique index `bq_item_rate_links_one_active` lives in SQL only; Prisma does not model partial indexes).
- **API.** `BqVersionsService`, `InstructionsService`, `VariationsService`, `BuildupsService`, `bq-content.ts`, `variation-digest.ts`; `BqVariationsController` (23 operations under `projects/:id/bq`) and `BuildupsController` (5 under `rate-buildups`), all OpenAPI-annotated (the e2e suite checks every operation ID). `BqAccess` gains `editable()`, `approver()` (permission + step-up) and the D2.3 problem codes; `AccessPolicy` gains `stepUp()`, `holdsSomewhere()` and `requireSomewhere()`; `BqVersionWriter.copyContent()`; the viewer returns lineage IDs, item build-up links, `canEdit/canApprove` and the baseline-approval state. Seed: one synthetic build-up `CONC-C25-SYN` (rate KES 13,285.25 per m³) with a summary line.
- **Web.** Pages `projects/[id]/bq` (rewritten: contract sum, baseline approval, sub-navigation), `bq/variations`, `bq/variations/[variationId]`, `bq/instructions`, `bq/versions`, `rate-buildups`, `rate-buildups/new`, `rate-buildups/[buildupId]`, `bq`; components `bq-subnav`, `contract-sum-card`, `baseline-approve`, `link-buildup-dialog`, `variation-status-badge`, `create-variation`, `variation-actions`, `variation-editor`, `instruction-dialog`, `buildup-editor`, `buildup-assumptions`; the project overview shows the contract sum card for `bq.view` holders; the sidebar's BQ entry opens the live `/bq` (no longer the prototype); the BQ tree shows and changes build-up links.
- **Tests.** Domain `bq/variation.test.ts`; validation `variations.test.ts`; API unit `variation-digest.spec.ts` and seed spec; API e2e `test/variations.e2e-spec.ts` (11 tests); web `test/variations.spec.ts` (5 tests) with new mock modules `mock-bq-model.mts`, `mock-bq-versions.mts`, `mock-variations.mts`, `mock-buildups.mts`.

**Behaviour changes to note (existing code and tests)**

- `apps/api/test/bq.e2e-spec.ts`: the BQ view's `permissions` now include `canEdit` and `canApprove`, and the QS's view reports `baselineApproval: { allowed: false, refusal: "permission" }`. `apps/api/test/projects.e2e-spec.ts`: the seed test expects the build-up (1 build-up, 5 lines, rate 1,328,525 minor units). `apps/api/test/support.ts` knows the D2.3 response contracts.
- `apps/web/test/mock-api.mts` has a third persona (`pm`, Brian Otieno, project manager on Ruiru with MFA) and per-persona step-up; personas signed in with the same session part of the token share fixture state (`live-helpers.ts` `switchPersona`), so a test can prepare as one person and approve as another. `mock-bq.mts` keeps several versions per project. Ruiru's mock BQ starts as a draft imported by the QS, so the owner can approve it.
- `apps/web/src/components/maps/geofence-map-inner.tsx` (D2.1 code): permanent fence labels now get `aria-label` (the visible site name, set as an attribute, never HTML) in Leaflet's synchronous `add` event. react-leaflet renders a tooltip's text through a portal one React render after Leaflet inserts the `role="tooltip"` element, so the element briefly had no name; under load axe caught it (`aria-tooltip-name` on `leaflet-tooltip-47`/`-50` in the second combined run below). A temporary probe spec (MutationObserver from page start, three loads of the Sites tab; deleted afterwards) recorded unnamed empty tooltips `leaflet-tooltip-47`, `-50`, `-47`, `-50`… with the original component and none with the fix.
- `apps/web/test/projects.spec.ts`: the EN/SW × light/dark accessibility matrix test calls `test.slow()` (Playwright's 3× time budget); its assertions are unchanged. The trace of the failed run showed 7 page loads taking 19.4 s and the axe scans 5.5 s under the parallel suite (load average about 30, other sessions also running browsers); the same test alone took 7.8–8.6 s.

**Commands run (from the worktree root unless noted; PATH set to the arm64 Node 24.22.2 and the pnpm shim) and actual results**

| Command | Actual result |
|---|---|
| `docker exec pmb-d23-postgres-1 psql -U pmb_migrator -d pmb` with the migration inside `BEGIN … ROLLBACK` (during development) | Applied cleanly and rolled back; then applied with `db:migrate` |
| `npx pnpm@12.17.0 format:check` | First final run **failed**: 13 new D2.3 files not yet formatted; formatted with `npx prettier --write` on those files, then "All matched files use Prettier code style!". A later run **failed** on 12 files under `.scratch/trace` (an unzipped Playwright trace used for the timing analysis); after deleting it: "All matched files use Prettier code style!" |
| `npx pnpm@12.17.0 turbo run lint typecheck test i18n:check build` | **26 successful, 0 cached** (28.2 s). oxlint "Found 0 warnings and 0 errors" in `types`, `i18n`, `domain`, `validation`, `api`; ESLint clean in web. Unit tests: types 15, domain 149, i18n 3, validation 62, web 20, API 100 (**349**). "i18n OK: 2209 keys in en and sw, all ICU messages compile." `next build` compiled successfully. After the last web edits (map label, `projects.spec.ts`): 26 successful (22 cached; web lint, typecheck, test (20) and build re-ran) |
| `npx pnpm@12.17.0 db:migrate` | "14 migrations found in prisma/migrations", "No pending migrations to apply." (the D2.3 migration was applied to the d23 development database earlier in the session) |
| `npx pnpm@12.17.0 test:e2e` in `apps/api` (after the seed-test change) | **8 files, 109 tests passed** (`variations.e2e-spec.ts` 11) against `pmb_test` under `pmb_app` |
| `PLAYWRIGHT_WEB_PORT=3410 PLAYWRIGHT_MOCK_API_PORT=3499 npx pnpm@12.17.0 turbo run test:e2e` | Run 1: API 109 passed; web **43 passed, 1 failed** (`projects.spec.ts` "live project pages are accessible in en, light": 30 s timeout, see above). Run 2 (after `test.slow()`): API 109 passed; web **43 passed, 1 failed** ("lists live projects…": axe `aria-tooltip-name` on empty Leaflet tooltips, see above). Run 3 (after the label fix): **7 successful** (both `test:e2e` tasks executed); API 8 files, **109 tests**; web **44 tests passed** in 1.6 min with 7 workers |
| Earlier web-only runs during stabilisation: `npx playwright test` (same ports) | 41 passed, 3 failed (the projects accessibility matrix timing out while the machine's load average was about 150 from other sessions); `test/projects.spec.ts` alone on a cold dev server: 3 passed, 6 failed (route compilation timeouts), then warm: 9 passed |
| `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` (in `apps/api`) | First attempt, straight after an e2e run: "Please make sure your database server is running at `localhost:55632`" although `pmb-d23-postgres-1` was up and healthy (transient connection refusal). Re-run: "No difference detected.", exit code 0 |
| `grep -c 'integrity: sha1-' pnpm-lock.yaml`; `grep -c 'tarball:' pnpm-lock.yaml` | 0; 1 (the SheetJS CDN line only) |
| `npx pnpm@12.17.0 install --frozen-lockfile` | Exit 0: "Lockfile passes supply-chain policies", "Lockfile is up to date, resolution step is skipped" |

**Not done / limitations**

- Approval limits by amount, client decisions on variations (portal), attachment upload for instructions, unit conversions and theoretical consumption (D5.x) are not implemented.
- A variation is always based on the newest approved version; stale variations are rebased, never merged. Percentage lines (PC attendance and profit) are not recomputed when their PC sum changes.
- Browser tests use the mock API (the mock reuses the shared domain functions for pricing and totals); the real API is covered by the API e2e suite. No real-API browser smoke was run for D2.3.
- The seed build-up's quantities and costs are synthetic. A QS should review the variation line model and the build-up example, and a native speaker the Kiswahili wording.

## Independent review of D5.1

A separate reviewer traced the payout maker-checker, tenant isolation (RLS, composite keys), encryption contexts, reveal and lookup limits and the conversion maths and found nothing critical or high. Its low findings and two found while checking the screens are fixed, each with a regression test that fails when the fix is reverted:

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | Low | A status reason of one or two characters passed validation and hit the database CHECK (500) | `statusReason` needs three characters (code points, as `char_length` counts); API e2e expects 400. The reviewer's emoji-name case was already a 400: Zod 4 counts code points |
| 2 | Low | Unlimited company units made the conversion search quadratic (2,000 units: 0.6 s per call on the shared event loop) | At most 200 company units per company (`unit-limit`, 409); the resolver only takes standard steps that end at the target or at a unit with a factor (3,000 units in a few ms; same results) |
| 3 | Low | Supplier and material pickers loaded only the first 200 records; a calculator link could not preselect a later material | Pickers follow the cursor (up to 10 pages) and the calculator fetches the linked material directly (`lib/procurement-server.ts`, `collectPages`) |
| 4 | Low | A 5-character account number was masked as `••••2345` | Numbers shorter than ten characters show only the last two (`••••45`); the database mask CHECK accepts both forms |
| 5 | Low | Comparable prices used the cent-rounded net, so a VAT-inclusive 800 → 900 showed +12.4989 % | The comparison uses the exact net and rounds once (`exactNetPrice`): +12.5 % |
| 6 | Low | The calculator text described the factor order backwards (EN and SW) | Now "supplier first, then material, then standard" |

## D5.1 catalogue and suppliers (branch `phase-5/d5.1-catalogue-suppliers`)

Status: built and verified locally in the `construction-d23` worktree (based on the D2.3 branch tip) with its own Docker stack (`pmb-d23`: PostgreSQL on 55632); **not committed** (left for review). Design: [ARCHITECTURE §4.4](./ARCHITECTURE.md#44-catalogue-and-suppliers-d51), §8 (maker-checker), §10 (encryption as built) and decisions D-34/D-35; implemented model in [ERD §5](./ERD.md#5-materials-procurement-and-stores); invariants in [INVARIANTS](./INVARIANTS.md); acceptance rows in [ACCEPTANCE_MATRIX](./ACCEPTANCE_MATRIX.md); configuration (`materials.price_change_alert_pct`, `materials.conversion.rounding`, `materials.steel.mass_formula`, `materials.limits`, `suppliers.payout.contact_change_window_days`, `suppliers.reveal.rate_limit`, `FIELD_*` keys) in [CONFIGURATION](./CONFIGURATION.md); threats A-25 and A-28 in [THREAT_MODEL](./THREAT_MODEL.md); walkthrough in the [Phase 5 demo](./demos/phase-5.md). Earlier security fixes are untouched.

**What changed**

- **Dependencies.** None added or changed (`decimal.js` was not needed: the conversion engine uses `BigInt` ratios); `pnpm-lock.yaml` and `.pnpmfile.mjs` are unchanged; `packages/domain/package.json` changes only its description.
- **Field cipher (shared with D3.1).** `apps/api/src/modules/labour/field-cipher.ts` and `field-cipher.spec.ts` are byte-identical copies of the D3.1 session's files (checked with `cmp`), with only its `packages/validation/src/env.ts` (`FIELD_ENCRYPTION_KEYS`, `FIELD_ENCRYPTION_ACTIVE_KEY_VERSION`, `FIELD_BLIND_INDEX_KEY`), `apps/api/.env.example` and `apps/api/vitest.config.e2e.ts` hunks applied, so both branches merge cleanly. It should move to a shared module once D3.1 merges. Local keys are in the git-ignored `apps/api/.env` (mode 600).
- **Shared packages.** `types/procurement.ts` (dimensions, standard unit codes, categories, steel and roofing constants, conversion sources and derived rules, rounding, VAT treatments, price sources and alert states, supplier/eTIMS/payout statuses, verification methods, reveal fields, `PAYOUT_CONTACT_CHANGE_WINDOW_DAYS`, `PROCUREMENT_LIMITS`). `domain/materials/`: `ratio.ts` (exact `BigInt` rationals, half-up), `units.ts` (standard and company units, unit classes), `attributes.ts` (steel d²/162, piece length, cover width, timber section, mesh sheet/roll), `convert.ts` (resolver, effective dating, refusals, `checkConversionRule`), `prices.ts` (`splitVat`, `comparableUnitPrice`, `priceChange`), `identifiers.ts` (KRA PIN and account number normalisation and masks), `defaults.ts` (21-material Kenyan starter catalogue). `validation/procurement.ts` (every D5.1 request and response). EN/SW namespaces `catalogue`, `suppliers`, `nav.items.suppliers` and `apiErrors` additions (`i18n:check`: 2,670 keys in each).
- **Database.** Migration `20261115090000_procurement_catalogue` (no existing migration edited): tables `units`, `materials`, `unit_conversions`, `material_prices`, `procurement_settings`, `suppliers`, `supplier_contacts`, `supplier_phone_changes`, `supplier_payout_versions`, each with `tenant_id`, ENABLE + FORCE RLS with `WITH CHECK`, composite `(tenant_id, …)` FKs and CHECKs; functions `app.standard_unit_dimension`, `app.unit_class`, triggers `app.guard_unit`, `app.guard_material`, `app.guard_supplier`, `app.guard_unit_conversion`, `app.guard_material_price`, `app.record_contact_phone_change`, `app.guard_payout_version`; DELETE revoked on all nine tables except contacts, UPDATE on prices and phone changes. Prisma models for all of it (partial unique indexes `supplier_payout_versions_one_current` and `supplier_contacts_one_primary` live in SQL only).
- **API.** `modules/procurement`: `CatalogueController` (16 operations) and `SuppliersController` (8), OpenAPI-annotated (the e2e suite checks every operation ID); `CatalogueService`, `ConversionsService`, `PricesService`, `SuppliersService`, `PayoutsService`, `CatalogueStore` (codes `MAT-NNNN`/`SUP-NNNN` under a company row lock, monotonic UUIDv7 IDs, conversion context), `ProcurementAccess`, `SupplierCrypto`, `starter-catalogue.ts`, mappers. Seed: a finance account (Daniel Mwangi, TOTP), the starter catalogue and `seed/demo-procurement.ts` (three synthetic suppliers, quarry trip factors, eight prices with one alert, one verified and one pending payout version).
- **Web.** Pages `catalogue` (list), `catalogue/[materialId]`, `catalogue/alerts`, `catalogue/convert`, `catalogue/units`, `suppliers`, `suppliers/new`, `suppliers/[supplierId]`, `suppliers/[supplierId]/edit`; components in `components/procurement/` (sub-navigation, material form, starter-catalogue button, conversion and end dialogs, price dialog, price chart (recharts, animation off), calculator, unit dialog and threshold form, supplier form, reveal button, payout panel); `lib/procurement.ts` (unit labels, exact money and factor formatting). The sidebar's **Materials** entry opens the live catalogue (no longer "Phase 5"); **Suppliers** is new under Commercial.
- **Tests.** Domain `materials/convert.test.ts` and `prices.test.ts` (39); validation `procurement.test.ts` (9); web `lib/procurement.test.ts` (2); API unit `field-cipher.spec.ts` (copied) and the seed spec; API e2e `test/procurement.e2e-spec.ts` (12); web `test/procurement.spec.ts` (6) with the mock module `test/mock-procurement.mts`.

**Decisions**

- **Exact conversions:** rationals on `BigInt`, one half-up rounding to 6 decimals per result with an `exact` flag; resolution supplier → material → attribute formula → standard; a lorry trip and package units have no universal size; steel d²/162 kg/m and 12 m bars (within 0.15 % of BS 4449). Same-dimension explicit factors are refused.
- **Prices compare net of VAT** per base unit on the exact net (rounded once to six decimals of a minor unit), so the seeded cement 800 → 900 (VAT-inclusive) is +12.5 %; the stored net and gross stay rounded to the cent. The alert is strictly above the threshold, and the threshold used is stored on the row.
- **No new permission keys or role changes.** View: any of `procurement.manage_suppliers`, `procurement.requisition`, `procurement.approve`, `stores.manage`, `finance.view`; manage: `procurement.manage_suppliers`; reveal identifiers: manage or company-wide `finance.view_sensitive`; reveal bank account: `finance.view_sensitive`; verify/reject payouts: company-wide `payments.approve` (+ step-up to verify); settings: `config.manage`.
- **Payout maker-checker in the database:** contributors include anyone who changed a supplier contact phone within 30 days (closes the "change the known number, then call it" path); the decider must be the signed-in user.
- **Alerts are listed, not pushed:** there is no in-app notification centre yet (D1.3 channels deliver authentication messages only), so alerts appear on the alerts page, the material and the catalogue list.
- **Forms:** React Hook Form is not in the repository; the forms follow the existing controlled-state + shared Zod schema pattern rather than adding a dependency.
- **Kiswahili:** materials and company units have an optional Kiswahili name; unit and category names come from the i18n catalogues. Terms needing native review: *safari ya lori* (lorry trip), *nondo* (steel bars), *mabati ya paa* (roofing), *wavu wa BRC*, *kiwango* (threshold), the payout verification methods.

**Behaviour changes to note (existing code and tests)**

- `apps/api/test/projects.e2e-spec.ts`: the seed test expects a fourth tenant member (finance) and the procurement summary (21 materials, 8 conversions, 3 suppliers, 8 prices, 1 alert; payout states pending and verified). `apps/api/test/support.ts` knows the D5.1 response contracts.
- `apps/web/test/mock-api.mts` has a fourth persona (`finance`, Daniel Mwangi, company-wide, MFA); non-company-wide personas get procurement access only through project assignments, like `AccessPolicy`. `use-problem-message.ts` maps the D5.1 problem codes.

**Commands run (from the worktree root unless noted; PATH set to the arm64 Node 24.22.2 and the pnpm shim) and actual results**

| Command | Actual result |
|---|---|
| `cmp` of the two cipher files against the D3.1 reference copies | Identical (checked again after formatting) |
| `npx pnpm@12.17.0 format:check` | First run **failed** on 9 new D5.1 files; after `npx prettier --write` on them: "All matched files use Prettier code style!" (the cipher files were not reformatted) |
| `npx pnpm@12.17.0 turbo run lint typecheck test i18n:check build` | **26 successful, 0 cached** (31.1 s). oxlint "Found 0 warnings and 0 errors" in `types`, `i18n`, `domain`, `validation`, `api`; ESLint clean in web. Unit tests: types 15, i18n 3, domain 188, validation 71, web 22, API 109 (**408**). "i18n OK: 2670 keys in en and sw, all ICU messages compile." `next build` compiled successfully |
| `docker compose -p pmb-d23 … exec postgres psql -U postgres`: drop/create `pmb_test` owned by `pmb_migrator`, schema owner, `REVOKE CREATE`, `GRANT USAGE`, default privileges (tables, sequences, functions) as in `infra/docker/postgres/init/01-roles.sh` | Done before the final e2e run |
| `PLAYWRIGHT_WEB_PORT=3410 PLAYWRIGHT_MOCK_API_PORT=3499 npx pnpm@12.17.0 turbo run test:e2e` | **7 successful** (2 m 39 s). API **9 files, 122 tests** (`procurement.e2e-spec.ts` 12, `projects.e2e-spec.ts` 15) against `pmb_test` under `pmb_app`; web **50 passed** (`procurement.spec.ts` 6) in 2.7 min |
| `npx prisma migrate status`; `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` (in `apps/api`, dev database `pmb` migrated with `prisma migrate deploy`) | "15 migrations found", "Database schema is up to date!"; "No difference detected.", exit code 0 |
| `grep -c 'integrity: sha1-' pnpm-lock.yaml`; `npx pnpm@12.17.0 install --frozen-lockfile` | 0; exit 0, "Lockfile passes supply-chain policies", "Lockfile is up to date" |
| Mutation: API maker-checker check in `PayoutsService` disabled, `procurement.e2e-spec.ts` run, file restored | 12/12 still pass: the database CHECK and trigger refuse self-verification on their own (mapped to 403 `maker-checker`) |
| Mutation: `divideHalfUp` replaced by truncation, `vitest run src/materials`, file restored | 9 tests fail (rounding, round-trip properties, steel, VAT split); restored: 39 pass |
| During development | One API e2e run hit a transient "Can't reach database server at localhost:55632" while the container was healthy; the re-run passed. The first web spec runs failed on wrong expectations in the new spec (KES formatting, +12.5 % instead of the net-of-VAT +12.4989 %, ambiguous locators); the spec was corrected, not the code. A supplier-page column header ("Supplier" over the material names) was found in the screenshots and fixed |

Screenshots (EN light catalogue, material and calculator; SW supplier profile; 360 px SW dark supplier profile) were taken with Playwright against the mock API and kept outside the repository.

**Not done / limitations**

- Supplier ratings, balances and statements (need supplier invoices, D5.2), prices written from quotations and invoices (D5.2), payment to verified details and a hold period before the first payment (D5.2/D4.3, OR-05), alert delivery by SMS, email or an in-app inbox (Phase 8), eTIMS checks with KRA (CR-TAX-02).
- Browser tests use the mock API (which reuses the shared domain functions); the real API is covered by the API e2e suite. No real-API browser smoke was run.
- The starter catalogue's densities and coverage factors are labelled ASSUMPTION and need QS review; the steel formula is the industry rule of thumb, not the BS 4449 table.

**Open risks**

- **Merge conflicts with D3.1** (labour registry, parallel session) are likely in `prisma/schema.prisma` (tenant relations), `app.module.ts`, `test/support.ts`, `demo-seed.ts`, the i18n JSON files, `nav-config.ts`, `mock-api.mts` and these docs (decision IDs D-34/D-35 and threat A-28 may collide). The cipher files and env hunks are byte-identical by design.
- Key management is the env-key interim (no KMS yet); losing `FIELD_ENCRYPTION_KEYS` makes supplier identifiers unreadable (CONFIGURATION §8).
- Partial unique indexes are in SQL only; a future `prisma migrate dev` must not drop them (the drift check passes because Prisma ignores them).

## D5.2 procure-to-pay (branch `phase-5/d5.2-web`)

Status: the **backend** (API, migration `20261115100000_procure_to_pay`, shared domain/validation/types, demo seed, API e2e) is on `main` (#25, merged as work in progress with no documentation); the **web screens, browser tests, mock API, documentation and two backend fixes** are built and verified locally in the `construction-d23` worktree on `phase-5/d5.2-web` (from `main` at `c1bec79`, with `main` merged in at `c66be1a`) with its own Docker stack (`pmb-d23`: PostgreSQL 55632); independently verified and reviewed (findings 5–9 below, all fixed). Roadmap: 🔎. Design: [ARCHITECTURE §4.5](./ARCHITECTURE.md#45-procure-to-pay-d52) (and the GRN offline contract in §12.2), [WORKFLOWS](./WORKFLOWS.md#procure-to-pay-as-implemented-d52), [ERD §5](./ERD.md#5-materials-procurement-and-stores), [CONFIGURATION §5](./CONFIGURATION.md#5-commercial-procurement-and-stores), [INVARIANTS](./INVARIANTS.md), threats A-09, A-10, A-25 in [THREAT_MODEL](./THREAT_MODEL.md), acceptance rows in [ACCEPTANCE_MATRIX](./ACCEPTANCE_MATRIX.md), walkthrough in the [Phase 5 demo](./demos/phase-5.md#d52-procure-to-pay).

### Findings fixed on this branch (self-review, then independent verification and code review)

| # | Severity | Finding | Fix and regression test |
|---|---|---|---|
| 1 | Medium | The inbox listed every disputed invoice as "an exception may be decided" for `payments.approve` holders, and the invoice's `permissions.canApproveException` was true, even when the mismatch is not exceptable (missing eTIMS number, inconsistent totals, empty invoice, line not on the LPO), so approvers were sent to an action the API refuses (`match-not-exceptable`) | `P2pOverviewService.inbox` reads the latest match and lists `invoice-exception` only when it is exceptable and not yet excepted; `InvoicesService` `canApproveException` requires the same. `procure-to-pay.e2e-spec.ts` "prevents double billing and blocks a missing eTIMS number…" now asserts the owner's view and inbox for INV-0002 (eTIMS missing: not offered) and INV-0003 (double billing: offered). Each fix reverted on its own fails that test |
| 2 | Low | At 360 px the GRN result panel showed the over-delivery sentence inside a non-wrapping badge, so the page scrolled sideways (found in the real-API smoke) | The badge shows the short status ("Over-delivered"); the sentence stays on the line. `procure-to-pay.spec.ts` (Kiswahili/360 px test) records an over-delivery GRN and asserts no horizontal scroll; it fails with the old badge |
| 3 | Low (tooling) | `turbo.json` runs in strict env mode without `PLAYWRIGHT_WEB_PORT`/`PLAYWRIGHT_MOCK_API_PORT`, so `PLAYWRIGHT_WEB_PORT=… turbo run test:e2e` silently used the default ports 3100/3199 (it collided with this session's own leftover servers from an aborted run) | Both variables added to `globalPassThroughEnv` (not part of cache hashes); `turbo run --dry=json` shows them passed through |
| 4 | Low (pre-existing test) | `attendance.e2e-spec.ts` created a "temporary" company holiday at today + 200 days; on 13 November 2026 that is Madaraka Day (1 June 2027), so the test failed with `holiday-exists` | Picks the first day from today + 200 that is not already a holiday and asserts 201. The hunk is byte-identical to the one on `fix/attendance-holiday-date` (`5101abf`) so the branches merge cleanly |
| 5 | Low | Independent browser check against the real API: a GRN without photos shows "Evidence incomplete: …" (a sentence, longer in Kiswahili) in a badge that never wrapped, so its detail page scrolled a 360 px screen sideways by 128 px | The badge wraps (`h-auto whitespace-normal`). The Kiswahili/360 px browser test opens the new GRN's detail page and asserts no horizontal scroll; it fails with the old badge |
| 6 | High | Code review: the invoice form validated a typed quantity trimmed but parsed it untrimmed, so "14 " (pasted from a PDF) threw during render and Next showed its error page, losing the form; amounts beyond 2⁵³ minor units threw the same way | `invoiceTotals` (`lib/p2p.ts`) trims, computes exactly with the domain functions and returns null instead of throwing. `p2p.test.ts` covers padded, malformed and out-of-range lines; the main browser flow types "21 ". Removing the trim or the catch fails the unit test |
| 7 | Medium | Code review: the match screen rounded per-base prices to cents, so an invoice at KES 86.21 net against an order of KES 100 incl. VAT (86.2069 net) failed the price check while all three prices read "KES 86.21" | `formatComparedPrices` (`lib/procurement.ts`) shows a row's prices with the fewest places, two at least, that keep different values apart (here 86.207 and 86.210). `procurement.test.ts`; fails if fixed at cents |
| 8 | Medium | Code review: when an invoice saved but its document upload failed, the form set an error and navigated away at once, so nobody saw that the file was missing | The form opens the invoice with `?upload=failed`; the detail page says the file was not attached (until one is) above the upload control. The main browser flow fails the upload, sees the alert, then attaches the file; it fails without the parameter |
| 9 | Medium | Code review: the invoice page showed reopen, cancel, run-again and attach from the company role, but the API checks project permissions (role ∩ assignment, and `finance.manage` cannot be assigned per project), so a project-scoped custom role with `finance.manage` saw four buttons that all returned 403 | The invoice detail returns `canRematch`, `canReopen`, `canCancel` and `canAttach` from the project permissions with the actions' own rules; the page uses only those. `procure-to-pay.e2e-spec.ts` creates such a role and asserts all four false (and 403 on reopen) while the owner's are true; computing them from company permissions fails it |
| 10 | Low (test) | `procure-to-pay.spec.ts` used the UTC date as "today" for quotation validity, needed-by and paid-on dates, but the app uses the Nairobi business date; between 21:00 and midnight UTC a quotation "valid until today" counted as expired and the single-source test failed (found by the full run at 21:05 UTC) | The spec uses `nairobiDate()`; the whole file passes at 21:07 UTC |

**What changed**

- **Web pages** (`apps/web/src/app/(office)/procurement/`): `page.tsx` (inbox from `GET procurement/inbox`, counts per stage from the list endpoints, committed / accrued / open / paid per project from `GET procurement/commitments`); `requisitions/` list (project and status filters, cursor pages), `new`, `[requisitionId]` (lines, history, submit / approve / reject / reopen / cancel shown from the record's `permissions`), `[requisitionId]/edit`; `rfqs/` list, `new` (approved requisitions of one project, invited suppliers, reply date), `[rfqId]` (record and withdraw quotations with documents, the comparison matrix, minimum-quotes status, single-source exception request and independent approval, award → LPO, cancel, "awarded as LPO-…" and reissue after a cancelled LPO); `lpos/` list, `[lpoId]` (supplier snapshot with masked KRA PIN and eTIMS status, delivery site/date/terms, lines with net per base unit, VAT and totals, received and invoiced progress, commitment, deliveries, invoices, submit / approve with step-up / return / cancel), `[lpoId]/print` (print stylesheet; the navigation is hidden with `data-print="hide"`); `grns/` list, `new` (mobile-first capture), `[grnId]` (lines, photos, geofence result, flags, void); `invoices/` list, `new` (against an approved LPO), `[invoiceId]/edit`, `[invoiceId]` (**the match screen**).
- **Components** (`components/procurement/p2p/`): `record-actions.tsx` (one confirmation dialog per transition, with reason, step-up and version handling), `requisition-form.tsx`, `bq-item-picker.tsx`, `rfq-form.tsx`, `rfq-panels.tsx` (quotation dialog with per-line price, unit, VAT treatment, delivery days and validity; award dialog), `comparison-matrix.tsx`, `lpo-panels.tsx`, `grn-capture.tsx` and `grn-photo-upload.tsx`, `invoice-form.tsx` (eTIMS format check and missing flag, exact totals preview with the domain functions), `match-panel.tsx`, `invoice-panels.tsx` (exception, approval with the bound payee and amount, settlements), `document-upload.tsx`, `list-filters.tsx`, `timeline.tsx`, `maker-checker.tsx`, `p2p-subnav.tsx`, `use-p2p-problem.ts`; `components/procurement/settings-form.tsx` (the four procurement settings; replaces the D5.1 threshold form on the Price alerts page). `lib/p2p.ts` (exact money and quantity helpers on `Ratio`), `lib/p2p-server.ts` (server-side option loaders). Navigation: a live **Procurement** entry under Commercial (Stores and Spending stay "Phase 5"). `use-problem-message.ts` maps every D5.2 problem code (EN/SW). `globals.css` has print rules.
- **i18n**: namespace `p2p` and `apiErrors` additions in EN and SW; unused `catalogue.alerts.settingsTitle/save/saved/readOnly` removed (`i18n:check`: 4,421 keys in each).
- **Browser tests and mock**: `apps/web/test/mock-p2p.mts` (the whole flow in memory, using the shared domain functions for pricing and the match and parsing every response with the shared schemas; fixture: REQ-0001 → RFQ-0001 with three quotations → LPO-0001 → GRN-0001 → MQ-INV-1001 matched, approved and settled, MQ-INV-1002 blocked), wired into `mock-api.mts`; `mock-procurement.mts` stores the D5.2 settings and a third supplier; `procure-to-pay.spec.ts` (6 tests); `global-setup.ts` warms the new routes; `procurement.spec.ts` follows the renamed settings button.
- **Backend**: findings 1 (two services) and the API e2e assertions; no migration, no schema change, no seed change (the seed already produces a blocked and a settled invoice; `projects.e2e-spec.ts` unchanged).
- **Dependencies**: none added or changed; `pnpm-lock.yaml` and `.pnpmfile.mjs` unchanged.

**Decisions**

- **Screens read the API's verdicts.** The match screen renders the stored match evidence (per-line figures, reasons, invoice checks, staleness) and the record's `permissions`; it never recomputes the match. The invoice form previews totals with the same domain functions the API uses, so the stated figures can be made to agree before submitting.
- **GRN capture**: the client ID, `Idempotency-Key` and capture time are created once per form, so a double click or a retry after a lost response replays the same GRN (the browser test drops the first response). Photos upload after the GRN exists (also after a replay) with per-photo retry; the position is optional, shows its accuracy, and the geofence verdict comes from the API after saving; nothing about the position blocks saving. Kenyan plates are normalised as you type; other plates are allowed and flagged.
- **Step-up** uses the shared dialog for LPO approval, invoice exception and approval, and settlements (and LPO return, which the API does not require it for: harmless).
- **Printable LPO** is a browser print stylesheet (no pdfmake document yet).
- **Forms** use the existing controlled-state + shared Zod pattern (no React Hook Form, as in D5.1).
- **Tables** that can overflow on a phone scroll inside focusable regions with a label (axe `scrollable-region-focusable`).
- **Kiswahili terms needing native review**: *ombi la vifaa* (requisition), *maombi ya bei* (RFQ), *agizo la ununuzi* (LPO), *mapokezi* (GRN), *ankara ya msambazaji*, *ulinganisho wa njia tatu* (three-way match), *msamaha* (exception), *idhinisha upya* (re-approve).

**Commands run (from the worktree root unless noted; PATH set to the arm64 Node 24.22.2 and the pnpm shim; `TURBO_CACHE_DIR` set to this worktree) and actual results**

| Command | Actual result |
|---|---|
| `npx -y pnpm@12.17.0 install --frozen-lockfile` | exit 0 |
| `npx -y pnpm@12.17.0 format:check` | First run **failed** on `apps/api/test/procure-to-pay.e2e-spec.ts` (new assertions); after `npx prettier --write` on it: "All matched files use Prettier code style!" |
| `npx -y pnpm@12.17.0 turbo run lint typecheck test i18n:check build --force` | **26 successful, 0 cached** (39 s). oxlint "Found 0 warnings and 0 errors" in `types`, `i18n`, `domain`, `validation`, `api`; ESLint clean in web. Unit tests: types 38, i18n 3, domain 333, validation 100, web 37, API 125 (**636**). "i18n OK: 4421 keys in en and sw, all ICU messages compile." `next build` compiled successfully. Re-run without `--force` after the last changes (`turbo.json`, the attendance spec, the docs): 26 successful (5 cached package builds), same counts; `format:check` clean |
| Reset `pmb_test` (`reset-d23-test-db.sh`: drop/create owned by `pmb_migrator`, grants as in `infra/docker/postgres/init/01-roles.sh`), then `PLAYWRIGHT_WEB_PORT=3410 PLAYWRIGHT_MOCK_API_PORT=3499 npx -y pnpm@12.17.0 turbo run test:e2e` | First run **failed**: `attendance.e2e-spec.ts` (finding 4) and, because turbo dropped the port variables (finding 3), the browser suite started on 3100/3199. After both fixes and killing this session's leftover servers by PID: **7 successful, 0 cached** (3 m 34 s). API **17 files, 224 tests** (`procure-to-pay.e2e-spec.ts` 11) under `pmb_app`; web **100 passed** (`procure-to-pay.spec.ts` 6, `procurement.spec.ts` 6) in 3.5 min |
| `cd apps/api && npx vitest run --config ./vitest.config.e2e.ts test/procure-to-pay.e2e-spec.ts` (whole file, fresh `pmb_test`) | 11/11 |
| Mutations (each reverted alone, whole file run, then restored): inbox exceptability; `canApproveException` exceptability; the GRN badge | API: 1 failed / 10 passed each ("expected [ 'INV-0003', 'INV-0002' ] to not include 'INV-0002'"; "expected true to be false"). Web: the Kiswahili/360 px test fails at "GRN result (sw, 360 px)" no-horizontal-scroll; 5 others pass |
| Real-API smoke: dev database `pmb` reset, `prisma migrate deploy`, `db:seed` (prints REQ-0001 → RFQ-0001 → LPO-0001 → GRN-0001, MQ-INV-1001 settled, MQ-INV-1002 disputed); API (`pnpm start`, :4400) and `next dev --port 3400`; a temporary Playwright script signed in through the API (password + TOTP) | 18 owner pages plus the inbox and match screen as finance, project manager and site agent rendered (page heading present, no console errors; the inbox, RFQ comparison, match screen and 360 px GRN form screenshots checked by eye). Through the UI: site agent records a GRN at 360 px with geolocation and photos (inside the geofence) → owner sees "Out of date: deliveries were recorded", runs the match again → matched, approves KES 25,520 bound to "M-Pesa Paybill 600000, account JENGA-BORA" (payout version 1) → finance records the payment → "Paid in full". Found finding 2. Script deleted, servers stopped |
| `cd apps/api && DATABASE_MIGRATION_URL=<pmb_test> npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` | "No difference detected." (schema unchanged) |
| `grep -c 'integrity: sha1-' pnpm-lock.yaml` | 0 |

**Independent verification (after merging `main`):** `format:check` clean; `turbo run lint typecheck test i18n:check build` 26/26; `pmb_test` reset, then `turbo run test:e2e` (ports 3410/3499) 7/7 tasks, API and web suites both run (not cached); `prisma migrate diff` against the migrated dev database: no difference. Real-API walk-through as the project manager: every list, form and detail screen plus the LPO print view, in English at 1280 px and Kiswahili at 360 px, with no console errors, no failed requests after sign-in and no untranslated keys; it found finding 5. After the review fixes: full `turbo run test:e2e` API 17 files passed and web 100 passed with one failure (finding 10, then `procure-to-pay.spec.ts` 6/6), and each of findings 5–9 mutation-checked (reverted alone, the named test fails).

Screenshots (Playwright against the mock API; kept outside the repository in the session folder `d52-screenshots/`): the match screen with the blocked invoice (EN, desktop), the comparison matrix (EN), GRN capture at 360 px (SW), the approvals inbox (EN, dark).

**Not done / limitations**

- GRN capture in the offline site app (D3.2 dependency); the web form works online on a phone and the API contract is offline-ready (ARCHITECTURE §12.2).
- Paying suppliers from PM-Buddy (Daraja B2B or a bank API): payments made elsewhere are recorded as settlements (D4.2/D4.3). No hold period before the first payment to new payout details (OR-05).
- Approval limits by amount, a selection reason when the lowest quotation is not awarded, split-order detection, credit notes and returns, a PDF LPO, supplier portal access (D7.x).
- Browser tests use the mock API; the real API is covered by the API e2e suite and the one-off smoke above (not automated).
- The seeded project manager has no authenticator, so in the demo LPO approval needs MFA enrolment first (or the owner approves LPOs prepared by someone else).

**Open risks**

- **Merge conflicts** with parallel sessions are likely in `packages/i18n/src/messages/{en,sw}.json`, `apps/web/test/mock-api.mts`, `nav-config.ts`, `use-problem-message.ts`, `turbo.json` and these docs; `attendance.e2e-spec.ts` matches `fix/attendance-holiday-date` exactly.
- A user holding both `procurement.requisition` and `stores.manage` (or a requester) can record the delivery for their own requisition; GRNs are not maker-checked against the requester (the match and invoice approval still are). Browser photos are not EXIF-verified (A-09 gap).
- Kiswahili wording and the default tolerances (0 %) need native-speaker and QS/finance review.

## D5.3 stores (branch `phase-5/d5.3-stores`)

Status: built and verified locally in the `construction-d23` worktree on `phase-5/d5.3-stores` (from `origin/main` at `9d1baad`, with `main` merged in after D6.2) with its own Docker stack (`pmb-d23`: PostgreSQL on 55632); independently reviewed (findings below, all fixed). Design: [ARCHITECTURE §4.6](./ARCHITECTURE.md#46-stores-d53) and decisions D-49 to D-52; model in [ERD §4 and §5](./ERD.md#5-materials-procurement-and-stores); state machines in [WORKFLOWS "Stores"](./WORKFLOWS.md#stores-d53); settings in [CONFIGURATION](./CONFIGURATION.md); the stock invariant in [INVARIANTS](./INVARIANTS.md); acceptance rows in [ACCEPTANCE_MATRIX](./ACCEPTANCE_MATRIX.md); threat A-31 and the D5.3 test row in [THREAT_MODEL](./THREAT_MODEL.md); valuation for accountant review as CR-STK-01 in [COMPLIANCE_TODO](./COMPLIANCE_TODO.md); walkthrough in the [Phase 5 demo](./demos/phase-5.md#d53-stores).

**Done-when: a variance alert fires on test data.** `stores.e2e-spec.ts` "fires a variance alert when cement issued exceeds what the measured concrete needs" (before any measurement the result is unavailable, not zero, and the unmapped ballast line is reported; then 10 m³ measured × 6.5 bags × 1.05 = 68.25 bags against 80 issued net of returns and a reversed issue → +17.2 %, an alert at the 10 % threshold and within at 20 %), and the demo seed prints "consumption variance alerts: 1" (column bases: 85.3125 bags theoretical, 105 actual, +23.1 %), shown on `/stores/variance` in the real-API smoke below. The browser test also clears an alert with a return.

**Findings fixed after independent code review**

| # | Severity | Finding | Fix and regression test |
|---|---|---|---|
| 1 | Medium | Reversing an inflow (voiding a mistaken GRN, reversing a return) took the stock out at the current average, not at the value it brought in, so correcting a mistake changed the store's value for good (4 bags worth KES 3,200 became about KES 3,969 after receiving and voiding 100 bags at KES 1,000) | `reverseInflow` (domain) and `app.post_stock_entry` reverse an inflow at its own value and unit cost; the average applies only when that value is no longer there, and emptying still takes all that is left (decision D-49). `stores.test.ts` covers it; `stores.e2e-spec.ts` raises a second order at a different price, voids its GRN and gets the store's quantity and value back exactly. Reverting the ledger or the trigger fails the e2e test |
| 2 | Medium | The issue form listed only the first 1,000 measured BQ items, ordered by bill UUID, and its filter searched only those, so items of large BQs could not be issued to | `GET stores/:id/issue-options?bqSearch=` searches the whole BQ in force on the server (still `stores.manage`; storekeepers hold no `bq.view`), in bill order, at most 200 at a time with `bqItemsTruncated`; the form searches as you type and keeps the chosen item. The e2e test finds two items by a case-insensitive search; ignoring the search fails it |
| 3 | Medium | Starting a stock take in a store with more than 300 materials failed with a 500 (the sheet's CHECK), so such a store could never be counted from the screen | Counted in turns: the sheet takes the 300 counted longest ago, never-counted first, and the response's `uncoveredMaterials` says how many wait for the next count (shown on the stock-take page, EN/SW; decision D-51). The e2e test creates 301 materials with reorder levels and starts a 300-line count; removing the selection fails it |

**What changed**

- **Database** (migration `20261118090000_stores`, new; no shipped migration edited): 13 tables (`stores`, `stock_balances`, `stock_ledger_entries`, `stock_movements` + `stock_movement_lines`, `stock_transfers` + `stock_transfer_lines`, `stock_takes` + `stock_take_lines` + `stock_take_counts`, `stock_reorder_levels`, `progress_measurements`, `rate_buildup_line_materials`), `procurement_settings.consumption_variance_percent`, and a unique key on `rate_buildup_lines (tenant_id, version_id, id)` for the mapping's composite foreign key. Every table has `tenant_id`, forced RLS with `WITH CHECK`, composite `(tenant_id, …)` foreign keys and `pmb_app` grants without DELETE on history (UPDATE revoked on the ledger, counts and measurements). Triggers: `app.post_stock_entry` (locks the balance row, checks source, valuation and non-negative stock, numbers the entry), `app.apply_stock_entry`, `app.guard_stock_balance`, `app.refuse_stock_entry_change`, `app.check_stock_entry_source`, guards for stores, movements and their lines, transfers and their lines, stock takes, lines and counts, measurements and mappings, `app.guard_material_stock_unit`, and deferred posting checks (`check_stock_movement_postings`, `check_stock_transfer_postings`, `check_stock_take_postings`, `check_grn_stock`). The migration receives existing recorded GRNs into their site's store (verified on a copy of the seeded database, below).
- **Shared packages**: `packages/types/src/stores.ts` (kinds, statuses, wastage reasons, variance states, `DEFAULT_CONSUMPTION_VARIANCE_PERCENT`, `STORES_LIMITS`); `packages/domain/src/stores/` (`decimal6.ts`, `valuation.ts`, `consumption.ts`, `lifecycle.ts`, 13 tests); `packages/validation/src/stores.ts` (every request and response, 3 tests); `packages/i18n` `stores` namespace and 22 `apiErrors` in EN and SW.
- **API** (`apps/api/src/modules/procurement/stores/`): `StockLedger`, `StoresAccess`, services for stores, movements, transfers, stock takes, variance and build-up mappings, five OpenAPI-annotated controllers; `apps/api/src/modules/progress/measurements/` (minimal measurement). `GrnsService` now receives accepted goods into the site's store and reverses them on void.
- **Seed** (`apps/api/src/seed/demo-stores.ts`; `demo-seed.ts` adds a **storekeeper** account, Grace Wambui, on RUI-HTS and KIT-BNG): a cement purchase (REQ-0002 → GRN-0002), an approved synthetic BQ with two concrete items linked to CONC-C25-SYN and its material lines mapped, 12.5 m³ measured, ISS-0001/RTN-0001/WST-0001, reorder levels (2 low), a Bungalow plot store with TRF-0001 disputed and TRF-0002 in transit, and STK-0001 submitted. Everything goes through the real services and triggers (the BQ rows are written directly, as the import needs a workbook, and approved by someone who did not write them). `projects.e2e-spec.ts` seed counts updated.
- **Web**: `src/app/(office)/stores/**` (15 routes), `src/components/stores/*` (actions, forms, count sheet, mapping section, sub-navigation), `src/lib/stores.ts` (+ test), the build-up page's "Materials for stores" section, Stores live in the sidebar (`nav-config.ts`), problem codes in `use-problem-message.ts`.
- **Browser tests and mock**: `apps/web/test/mock-stores.mts` (in-memory stores using the domain functions and the shared schemas, wired into `mock-api.mts`), `apps/web/test/stores.spec.ts` (5 tests), stores routes in `global-setup.ts`.
- **Dependencies**: none added; `pnpm-lock.yaml` unchanged.

**Decisions**

- **Valuation: weighted average cost** per store and material, net of VAT (D-49), flagged **COMPLIANCE-REVIEW CR-STK-01**. The API computes with exact six-place arithmetic and the trigger re-verifies division-free.
- **Negative stock is never allowed** (D-50): no override setting. Each movement locks its `(store, material)` balance row, so two simultaneous issues of the last stock cannot both succeed; proved through the API (`Promise.all`: one 201, one 409 `insufficient-stock`) and directly as the runtime role (two concurrent transactions).
- **Counts during movements** (D-51): no freeze; each count stores the system quantity when counted (snapshot + movements since), and the variance is against that.
- **Build-up mapping and measurement** (D-52): `rate_buildup_line_materials` (stamped, one active per line, exact base units per line unit from the D5.1 engine; build-up versions untouched) and an append-only `progress_measurements` (latest uncorrected measurement counts). Unmapped lines are reported `not_mapped`; unmeasured items are `no_measurement` (unavailable, not zero).
- **Permissions**: no new keys. View = `stores.manage`, `procurement.requisition`, `procurement.approve`, `finance.view` or `finance.manage` on the project; record = `stores.manage`; approve stock takes and resolve transfer disputes = `procurement.approve` (the storekeeper role does not hold it) and never a contributor, sender or receiver; settings = `config.manage`; measurements = `bq.edit`. `permissions` flags on every record use the same rules (D5.2 finding 9).
- **Offline contract**: as for GRNs, the client ID, `Idempotency-Key` and request digest are stored on the record itself (unique per company), not in `idempotency_records`; a replay returns the original, a changed body is 409.
- **GRNs need a site** now (the one sent, else the LPO's delivery site, else the project's only site; otherwise 400 `site-required`), because goods are received into a site's store. The web GRN form always sends one.
- **Web forms record quantities in the material's base unit** (the API accepts any convertible unit). Lists are keyset-paginated by time and ID (client-generated IDs are not time-ordered).
- **Kiswahili terms needing native review**: *stoo*, *mtunza stoo*, *utoaji* (issue), *urejeshaji* (return), *upotevu* (wastage), *uhamisho* (transfer), *kuhesabu stoo* (stock take), *tofauti ya matumizi* (consumption variance), *akiba ndogo* (low stock), *kiwango cha kuagiza tena* (reorder level).

**Found in existing code**

- `GrnsService` accepted a GRN without a site; it now resolves one or refuses (above).
- Not fixed (outside D5.3): the D5.2 GRN list orders by `id` descending, which is only time order for UUIDv7, but GRN IDs are client-generated (the web form uses `crypto.randomUUID()`, v4), so "newest first" is not guaranteed. The stores lists order by `(recorded/dispatched time, id)` instead.

**Commands run (from the worktree root unless noted; PATH set to the arm64 Node 24.22.2 and the pnpm 12.17.0 shim) and actual results**

| Command | Actual result |
|---|---|
| `pnpm run format:check` | "All matched files use Prettier code style!" |
| `npx turbo run lint typecheck test i18n:check build --force` | **26 successful, 0 cached** (60 s). oxlint "Found 0 warnings and 0 errors" in `types`, `i18n`, `domain`, `validation`; ESLint clean in web; API: 3 warnings in `stores.e2e-spec.ts` (an unused variable, two `sort()` without a comparator), fixed, then `turbo run lint --filter=@pm-buddy/api --force` "Found 0 warnings and 0 errors". Unit tests: types 38, i18n 3, domain 346, validation 103, web 42, API 132 (**664**). "i18n OK: 4809 keys in en and sw, all ICU messages compile." `next build` compiled successfully |
| Reset `pmb_test`, then `PLAYWRIGHT_WEB_PORT=3410 PLAYWRIGHT_MOCK_API_PORT=3499 npx turbo run test:e2e` | **7 successful**. API e2e 18 files, **236 tests** passed (`stores.e2e-spec.ts` 10/10); browser **106 passed** (`stores.spec.ts` 5/5) |
| After the lint fix: reset `pmb_test`, `cd apps/api && npx vitest run --config ./vitest.config.e2e.ts test/stores.e2e-spec.ts` | 10/10 |
| `cd apps/api && npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` (migrated dev database) | "No difference detected." |
| Migration backfill check: a copy of the seeded dev database with the D5.3 objects dropped, then `migration.sql` applied as `pmb_migrator` | The 3 recorded GRN lines were received into the Main plot store with the same seq, quantities, unit costs, values and running balances as the API had posted ("BACKFILL MATCHES"); FORCE RLS back on `grns`, `grn_lines`, `lpo_lines`, `sites`. Scratch database dropped |
| Real-API smoke: dev `pmb` reset, `prisma migrate deploy`, `pnpm run db:seed` (prints the stores summary above), API (`pnpm start`, :4400) and `pnpm dev --port 3400`; a temporary Playwright script signed in through the UI (owner with TOTP; storekeeper) | **23/23 checks**: home shows "1 variance alert" and cement low (13 bags, reorder at 20); the alert row shows 12.5, 6.5, 85.3125, 110, 105, 19.6875 and 23.1 %; store value KES 22,670; ledger lists GRN, issue, return, wastage; the owner approves STK-0001 (counted by the storekeeper) and resolves TRF-0001 (loss KES 800); as the storekeeper in Kiswahili at 360 px the home, issue form, issue result (ISS-0002) and transfer pages have no horizontal scroll and TRF-0002 is received; the alert reads "Juu ya kiwango" in dark mode. Servers stopped afterwards |
| `grep -c 'integrity: sha1-' pnpm-lock.yaml` | 0 |

Screenshots (real API, kept outside the repository in the session folder `d53-screenshots/`): stores home, variance alert with its inputs, store detail, stock ledger and the submitted stock take (EN, desktop); the issue form at 360 px (SW); the variance report (SW, dark).

**Not done / limitations**

- Stores in the offline site app (D3.2): the web forms work on a phone online and the API contract is offline-ready (ARCHITECTURE §12.2), without device signatures or `/sync/push` batching yet.
- No authorised negative-stock override (deliberately, D-50); per-material variance thresholds, days-of-cover low stock and alert notifications are not built; measurement is minimal (no approval, evidence or earned value: D6.3).
- A storekeeper who dispatches a transfer may also receive it if they keep both stores (the dispute is still resolved by someone else); counts use the server's time for "when counted".
- The demo BQ rows are written directly by the seed (the import needs a workbook); GRNs of multi-site projects without a site cannot be placed by the migration backfill (none exist in the seed; their goods would enter through a stock take).
- Browser tests run against the mock API (its GRNs do not post to the mock stores); the real API is covered by the API e2e suite and the one-off smoke above.

**Open risks**

- **Merge conflicts** with parallel sessions are likely in `packages/i18n/src/messages/{en,sw}.json`, `apps/web/test/mock-api.mts`, `nav-config.ts`, `use-problem-message.ts`, `schema.prisma`, `projects.e2e-spec.ts` (seed counts) and these docs; decision numbers D-49 to D-52 and threat A-31 may collide with other branches.
- The valuation method, the default 10 % threshold and the build-up allowances need accountant and QS review; variance results are estimates and depend on timely, complete measurement.

## D5.4 spending (branch `phase-5/d5.4-spending`)

Status: built and verified locally in the `construction-d23` worktree on `phase-5/d5.4-spending` (from `origin/main` at `1d0896e`, which has D5.1–D5.3 and D6.2) with its own Docker stack (`pmb-d23`: PostgreSQL on 55632), then merged with `main` (D6.1); independently reviewed (four findings, fixed below). Design: [ARCHITECTURE §4.8](./ARCHITECTURE.md#48-spending-and-cash-flow-d54), decisions D-53 to D-59 and D-67; workflows in [WORKFLOWS](./WORKFLOWS.md#spending-petty-cash-reconciliation-budgets-and-journals-d54); demo in [demos/phase-5.md](./demos/phase-5.md#d54-spending-and-cash-flow), with the **Phase 5 acceptance walkthrough**.

**Done-when: Phase 5 acceptance.** The D5.1–D5.4 chain works on one seeded company (see the walkthrough and ACCEPTANCE_MATRIX "Phase 5 acceptance"): the D5.2 invoice and settlement reach the cost ledger once each (accrued net of VAT; the cost part of the cash), the D5.2 open commitments are the committed figure, D5.3 stock issues re-allocate material cost to BQ items without adding it, and the demo seed raises one spend alert of each kind (`projects.e2e-spec.ts` checks the seed counts and every alert kind).

**What changed**

- **Database** (migration `20261123090000_spending`, new; no shipped migration edited): 14 tables (`spending_settings`, `cost_codes`, `budgets`, `budget_lines`, `cost_journals`, `cost_journal_lines`, `cost_entries`, `petty_cash_floats`, `petty_cash_entries`, `petty_cash_top_ups`, `petty_cash_expenses`, `petty_cash_receipts`, `petty_cash_counts`, `cash_flow_items`) with `tenant_id`, forced RLS with `WITH CHECK`, composite `(tenant_id, …)` FKs and `pmb_app` grants (UPDATE/DELETE revoked on the ledgers); guards for every lifecycle (`app.guard_*`), deferred posting checks, `app.check_cost_entry`, append-only triggers, `app.post_float_entry` (float row locked, never below zero), statement-level budget totals with transition tables; database posting of invoice accruals (`supplier_invoice_cost`) and settlement cost (`invoice_settlement_cost`, `app.settlement_cost_minor`); composite unique keys on `supplier_invoices (tenant_id, project_id, id)` and `invoice_settlements (tenant_id, invoice_id, id)`; `tenant_roles_permissions_check` and `project_permissions_check` rewritten with `finance.petty_cash`; a backfill posting already approved invoices and recorded settlements.
- **Shared packages**: `packages/types/src/spending.ts` (categories, measures, sources, purposes, statuses, alert kinds, M-Pesa kinds, reader/approver permission sets, `DEFAULT_SPENDING_SETTINGS`, `SPENDING_LIMITS`, `DEFAULT_COST_CODES`); `finance.petty_cash` in `PERMISSIONS`, `PROJECT_ASSIGNABLE_PERMISSIONS` and the project manager and site agent bundles; `packages/domain/src/spending/` (`mpesa-sms.ts` parser, `costs.ts` budget maths and settlement apportionment, `forecast.ts`, `alerts.ts`, `lifecycle.ts`; tests in `spending.test.ts`); `packages/validation/src/spending.ts` (every request and response; + tests).
- **API** (`apps/api/src/modules/finance/`): `SpendingAccess` and shared helpers, services for the report, cost codes and settings, budgets, the cost ledger and journals, petty cash, expenses and receipts (with the upload guard), cash flow and the forecast, alerts; six OpenAPI-annotated controllers; `FinanceModule` in `app.module.ts`. `p2p-overview.service.ts` now exports `projectCommitments` (same output) so the spending report and D5.2 share one computation.
- **Seed** (`apps/api/src/seed/demo-spending.ts`, called from `demo-seed.ts` after the schedule, summary printed by `main.ts`): settings with an opening cash, the default cost codes, an approved RUI-HTS budget, a float held by the site agent, seven expenses (one from a pasted SMS), receipts, an approved count, a maker-checked journal and forecast lines; one alert of each kind.
- **Web**: `src/app/(office)/spending/**` (15 routes), `src/components/spending/*` (generic action dialog, figures table and sub-navigation, sentence badge, cost tag picker with server-side search, expense form with the SMS paste box, receipt upload, budget line form, journal form, settings form, SVG forecast chart), `src/lib/spending.ts` (+ test), Spending live in the sidebar (`nav-config.ts`), problem codes in `use-problem-message.ts`, `spending` namespace and 30 API error messages in EN/SW, the `finance.petty_cash` permission label.
- **Browser tests and mock**: `apps/web/test/mock-spending.mts` (in-memory spending using the domain functions and the shared schemas, wired into `mock-api.mts` with a receipt download route), `apps/web/test/spending.spec.ts` (5 tests), spending routes in `global-setup.ts`.
- **Tests**: `apps/api/test/spending.e2e-spec.ts` (9 tests on the real runtime role), `support.ts` (spending response contracts), `projects.e2e-spec.ts` (seed counts and alert kinds).
- **Dependencies**: none added; `pnpm-lock.yaml` unchanged.

**Decisions** (ARCHITECTURE D-53 to D-67)

- **No double counting (D-53).** Material cost enters once, when the invoice is approved (net of VAT, "held in stores"); a settlement posts only the cost part of its cash, apportioned cumulatively half-up so a fully settled invoice's paid cost equals its subtotal exactly; stock issues re-allocate cost to BQ items in the report only (no entry), transfers are information, petty-cash materials cost once from the expense. Issued stock that is received but not yet invoiced makes the "not on BQ items" row negative until the invoice is approved (the page explains it; the total is right).
- **Cost sources (D-54).** Supplier invoices (accrual) and settlements (payment) posted by database triggers; approved petty-cash expenses (and M-Pesa charges as fees), approved counts (variance) and approved journals (lines or reversals) checked by `app.check_cost_entry`; once per source and purpose. **Payroll is not a source yet**: `main` has only draft/submitted/cancelled payroll batches, so no labour cost is posted until D4.3 adds approval/payout; the forecast uses the batches and the pay calendar.
- **Budgets (D-67).** Versioned; one draft or submitted version per project; lines are a BQ item (lineage on the budget's BQ version) or a cost code; submit stores a digest; approval by `finance.manage` + step-up, never a contributor, on that digest; the newest approved version is in force; approved versions never change. Rows without a budget line are unavailable (null), never zero; percentages are truncated to one decimal.
- **Petty-cash controls (D-58).** One float per site; custodian holds `finance.petty_cash`; the float's own append-only ledger, the float row locked per movement, never below zero, top-ups never above the limit; expenses only by the custodian, offline-ready (client ID + `Idempotency-Key` + digest), receipts private, approval by someone who neither recorded it nor holds the float; top-ups asked → approved (`payments.approve`) → paid (`payments.disburse`) by three people, the float's custodian neither approving nor paying; counts snapshot the book and post the variance after an independent approval; custodian handover only after an approved count.
- **Parser scope (D-55).** Sent, Pay Bill, till, received and withdrawal confirmations in English and reconstructed Kiswahili; amount, code, counterparty, masked phone, account, date/time, balance and charge; warnings for what is missing; never confirms settlement; the text is never stored; one M-Pesa code is one expense among those not rejected; the parser names records already holding the code.
- **Forecast assumptions (D-56).** Weeks Monday–Sunday (Nairobi), 13 by default; payroll from batches (draft = estimate, submitted = recorded) and later pay periods at the latest run rate (estimate), gross + employer cost; supplier invoices on their due date; approved LPOs not yet invoiced at delivery + credit days (estimate); manual expected receipts until client certificates exist; top-ups asked for or approved; overdue in week one; company opening entered and moved by what was recorded since, project opening derived.
- **Alert rules (D-57).** Budget threshold (default 80 %; critical above 100 %); unusual spend (> 3 × the median of the float's previous 20 expenses, once 5 exist); duplicate payments (same code or reference: critical; same counterparty and amount within 3 days: warning); missing documents (expenses without a receipt, settlements of invoices without a document); computed on read, 180-day lookback, in-app only.
- **Permissions (D-59).** One new key, `finance.petty_cash` (project-assignable; PM and site agent): holding a float without seeing budgets or the ledger. Everything else reuses `finance.view`/`finance.manage`, `payments.approve`/`disburse`, `procurement.approve` and `bq.edit`. Reader sets: `SPENDING_READ_PERMISSIONS`, `PETTY_CASH_READ_PERMISSIONS`; clients, suppliers and consultants hold none. Existing project assignments are not backfilled with the new key (an owner adds it to custodians).
- **Kiswahili terms needing native review**: *pesa ndogo* (petty cash), *akiba* (float), *ujazaji* (top-up), *mtunzaji* (custodian), *leja ya gharama* (cost ledger), *iliyoahidiwa* (committed), *iliyokusanywa* (accrued), *msimbo wa gharama* (cost code), *mtiririko wa pesa* (cash flow), *jarida* (journal).

**Found and fixed in existing code**

- D5.2's commitment computation lived inside `P2pOverviewService.commitments`; it is now the exported `projectCommitments` (same output; `procure-to-pay.e2e-spec.ts` unchanged and passing) so committed figures cannot drift between the procurement and spending screens.
- ARCHITECTURE §8.1 said the owner holds "50 tenant permissions"; it was already 57 before D5.4 and is now 58.
- Found in my own work before reporting (each covered by a test that fails without the fix): spending settings (with the company's opening cash) and cost codes were readable by any member, including portal clients — now spending/petty-cash/budget readers only, with the opening cash for company-wide finance roles (e2e outsiders test); duplicate-payment pairs on the same date were ordered by random ID — now by recording time (domain test); a budget totals check used a two-column subquery (500 on every budget) and journal lines could not be tied to their proposing transaction (500 on reversals) — fixed in the new migration; the journal form's line keys were random UUIDs used as element IDs (hydration mismatch, found by the real-API smoke) — now deterministic.

**Independent review of D5.4** (a separate code-review agent on the committed branch; four findings, all fixed with tests that fail without the fix)

| # | Severity | Finding | Fix | Test |
|---|---|---|---|---|
| 1 | High | A top-up could be paid by its requester (only "payer ≠ approver" was enforced), and a float's custodian holding `payments.approve`/`payments.disburse` (an owner, say) could approve or pay cash into their own float | The API refuses both (403 `maker-checker`) and the `permissions` flags say so; `petty_cash_top_ups_check` adds `paid_by <> requested_by`; `app.guard_petty_cash_top_up` refuses a decision or payment by the float's custodian | `spending.e2e-spec.ts` "keeps a top-up's requester, approver, payer and the float's custodian apart" (API refusals, flags, direct SQL under the runtime role) |
| 2 | Medium | The expense form renewed its record ID and `Idempotency-Key` on every 4xx: after a lost reply, editing and resubmitting gave 409 `idempotency-key-reused`, and the next submit recorded the expense a second time | `expenseRetryPlan` (`lib/spending.ts`): a collision with the form's own key or ID keeps both and links to the recorded expense; only other refusals renew them | `spending.test.ts` "never renews the ID and key when they collide with an earlier recorded attempt" |
| 3 | Medium | Changing a used cost code's category left its budget lines on the old category: copying a budget or editing such a line was refused by `app.guard_budget_line` (500) | A code used by a budget line, cost entry, journal line or expense keeps its category (409 `cost-code-in-use`, API and `app.guard_cost_code`); budget-line writes lock the code's row `FOR SHARE` so the two cannot pass each other; budget and cost-code database refusals map to problems, never 500 | `spending.e2e-spec.ts` "prepares a budget from the BQ…" (409 for a used code, an unused code recategorised, direct SQL refused) |
| 4 | Medium | A settlement's "settled before" used `recorded_at` defaulting to the transaction start, so two overlapping payments on one invoice could each count only the other's absence and mis-apportion cost | `app.stamp_invoice_settlement` (BEFORE INSERT, after the invoice row lock) stamps `recorded_at` with `clock_timestamp()` | `spending.e2e-spec.ts` "accrues an approved invoice's subtotal once…" (a settlement inserted 0.4 s into its transaction is stamped at the insert; rolled back) |

Mutation checks (each applied to a freshly migrated `pmb_test`, `spending.e2e-spec.ts` run): no stamping trigger → the settlement test fails; no custodian clause in the top-up trigger → the top-up test fails; the top-up CHECK without `paid_by <> requested_by` → the top-up test fails; no category clause in `app.guard_cost_code` → the budget test fails; `expenseRetryPlan` renewing on a collision → the web unit test fails. (The forecast test also fails in each top-up case, because the uncancelled top-up appears in the forecast.)

**Commands run (from the worktree root unless noted; PATH set to the arm64 Node 24.22.2 and the pnpm 12.17.0 shim) and actual results**

| Command | Actual result |
|---|---|
| `pnpm run format:check` | "All matched files use Prettier code style!" |
| After the review fixes: `npx turbo run lint typecheck test i18n:check build` | **26 successful** (`spending.e2e-spec.ts` 9/9 on its own after resetting `pmb_test`) |
| `npx turbo run lint typecheck test i18n:check build --force` | **26 successful, 0 cached** (38 s). oxlint "Found 0 warnings and 0 errors" in `types`, `domain`, `i18n`, `validation`, `api`; ESLint clean in web; unit tests: types 38, domain 391, i18n 3, validation 112, web 53, api 132; "i18n OK: 5754 keys in en and sw" |
| Reset `pmb_test`, then `PLAYWRIGHT_WEB_PORT=3410 PLAYWRIGHT_MOCK_API_PORT=3499 npx turbo run test:e2e` | **7 successful** (4 m 50 s). API e2e 20 files, **258 tests** passed (`spending.e2e-spec.ts` 8/8); browser **117 passed** (`spending.spec.ts` 5/5). Two earlier full runs on the heavily loaded shared machine (load average ≈ 30) each had unrelated timeouts — `procure-to-pay.spec.ts` (a click before hydration) once, three `labour.spec.ts` accessibility tests (30 s timeout) once; both files then passed on their own (11/11 with `spending.spec.ts`, 13/13) and the next full run passed completely |
| Mutation checks (each patched, `pmb_test` reset, `spending.e2e-spec.ts` run, restored): settlement cost per payment instead of cumulative; no overdraft check in the API nor the float trigger; settings and cost codes readable by anyone | 2, 4 and 1 tests fail respectively (removing only the API overdraft check still passes: the database refuses the overdraft with the same 409) |
| `cd apps/api && npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` (migrated dev database) | "No difference detected." (exit 0) |
| Real-API smoke: dev `pmb` reset, `prisma migrate deploy`, `pnpm run db:seed`, API (`pnpm start`, :4400) and `pnpm dev --port 3400`; a temporary Playwright script signed in through the UI as the project manager, the site agent (360 px), finance (TOTP; EN and SW at 360 px) and the owner (TOTP) | **18/18 checks, no console errors, no 5xx, no horizontal overflow, no raw message keys**: BvA with petty cash at threshold, every alert kind, the PM approving EXP-0007, an expense recorded from a pasted SMS with a receipt photo, finance approving TOP-0002 but unable to pay it, the owner paying it, the company forecast chart with the entered opening. Run before the last change (paging links on the float's lists and the forecast's expected lines), which the browser tests and the final full run cover |
| `grep -c 'integrity: sha1-' pnpm-lock.yaml` | 0 |

Screenshots (real API, kept outside the repository in the session folder `d54-screenshots/`): spending home, project budget vs actual vs committed, bill items, alerts and an approved expense (project manager, EN); the float, the expense form filled from an SMS and the recorded expense (site agent, 360 px); the approved top-up, company forecast, cost ledger and settings (finance, EN); the forecast (finance, SW, 360 px); the paid top-up (owner).

**Not done / limitations**

- No payroll cost in the ledger until D4.3 (no approved/paid payroll state on `main`); client receipts are manual lines until client certificates (D6.3/D7.1); alert notifications are Phase 8; petty cash in the offline site app (D3.2) — the API contract is offline-ready.
- The expense form tags workers and other payees; tagging a registered supplier is API-only (site agents cannot list suppliers). A receipt reused across expenses is not detected yet (SHA-256 is stored for it).
- The forecast's payroll uses the latest submitted run rate and gross + employer cost (conservative); LPO payment dates are estimates; the company opening is only as good as the entered figure.
- The summary page computes each project's figures in turn (fine for tens of projects; a company with hundreds would need a summary table).
- Browser tests run against the mock API; the real API is covered by the API e2e suite and the one-off smoke above.

**Open risks**

- **Merge conflicts** with parallel branches are likely in `packages/i18n/src/messages/{en,sw}.json`, `mock-api.mts`, `nav-config.ts`, `use-problem-message.ts`, `schema.prisma` (also reformatted alignment around new relations), `projects.e2e-spec.ts` and these docs; the permission CHECK rewrite must be redone if another branch adds a permission (D6.1 uses `20261122…`); decision numbers D-53 to D-67 and threats A-32 to A-36 may collide.
- Net-of-VAT costing, count variances, petty-cash policy and the reconstructed Kiswahili SMS wording need accountant and field review (COMPLIANCE_TODO CR-SPD-01 to CR-SPD-05).

## D3.1 labourer registry (branch `phase-3/d3.1-labour-registry`)

Status: **built and verified locally; committed on the branch, not pushed.** One independent review has happened (two defects, fixed below); no CI run or approval yet, so the roadmap shows ⏳. Design: [ARCHITECTURE §4.3](./ARCHITECTURE.md#43-labour-module-d31), §8 (role defaults), §10 (field encryption) and decisions D-30–D-36; implemented-model differences in [ERD §6](./ERD.md#6-labour-attendance-and-biometrics); API contract in [apps/api/README.md](../apps/api/README.md#labour-registry-d31); walkthrough in the [Phase 3 demo](./demos/phase-3.md). The branch is rebased onto `origin/main` at `42e93c9` (D2.2 BQ import merged) and also carries the commit "test: honour configured Mailpit and Playwright ports". An independent review found two defects, fixed in a follow-up commit (see "Independent review of D3.1" below). Work and checks ran in a separate git worktree with its own Docker stack (compose project `pmb-p34`: PostgreSQL 55532, Valkey 56479, RustFS 9100, Mailpit 1125/8125; API 4300, web 3300; Playwright 3310/3399), so another session on the main checkout was not disturbed.

**What changed**

- **Shared packages.** `types`: `labour.ts` (statuses, engagement types, rate bases, ID document types, NCA and accreditation categories, consent kinds/methods/statuses, versioned consent notices with pinned SHA-256 digests, sensitive fields, reveal purposes, built-in views, the 15 default trades and 4 skill levels in EN/SW, `MINIMUM_LABOURER_AGE_YEARS`, alert-day limits); permissions `labour.do_not_rehire` and `labour.consent` (46 tenant permissions; both project-assignable); role defaults PM +`labour.do_not_rehire` +`labour.consent`, site agent and foreman +`labour.consent`, finance +`labour.view_sensitive`; `ProblemDetails.match`. `domain`: `labour.ts` (calendar-day arithmetic, `latestAllowedBirthDate`/`isOldEnoughToRegister` matching PostgreSQL's interval arithmetic, accreditation status and summary, identifier normalisation and masking, rate scopes, `resolveRate`, `rateEffectiveTo`). `validation`: `labour.ts` (every labour request and response schema) and the `FIELD_*` environment keys. `i18n`: the EN/SW consent notice `registrationV1` and the `labourLive` namespace plus 34 API error messages (`i18n:check`: 1,882 keys in each).
- **Database.** Migration `20261111090000_labour_registry` (no existing migration edited): 12 tables (`trades`, `skill_levels`, `labour_settings`, `labourers`, `labour_engagements`, `labourer_consents`, `labourer_accreditations`, `do_not_rehire_events`, `labour_rates`, `gangs`, `gang_memberships`, `labour_saved_views`), all with forced RLS and `WITH CHECK`, composite `(tenant_id, …)` foreign keys and narrowed grants for `pmb_app` (no TRUNCATE/REFERENCES/TRIGGER; no UPDATE/DELETE on history). Invariants in the database: `labourers_minimum_age_check` with `registered_on` stamped to the Nairobi date by `app.guard_labourer`; the deferred constraint trigger `labourer_consent_required`; ciphertext envelope and blind-index format checks; immutable identity columns; a do-not-rehire change only with a matching event in the same transaction; `app.guard_engagement` (age on the start date, active consent, one open engagement per project, override for flagged workers); `app.guard_consent` (one withdrawal, database timestamps); append-only `do_not_rehire_events`; `app.guard_labour_rate` (scope key, no backdating, no updates, only scheduled rates deletable); gang and membership triggers. `tenant_roles_permissions_check` and `project_permissions_check` widened.
- **API.** New `labour` module (36 operations after the review fix, OpenAPI-annotated; table in ARCHITECTURE §4.3 and the README), `FieldCipher` (AES-256-GCM, HKDF per-company keys, row-bound associated data, key versions, HMAC blind indexes) and `LabourCrypto`. `ProblemDetailsFilter` passes an allow-listed `match` (`labourerId`, `workerNo`, `matchedOn`) on 409s; more pino redaction paths for identifiers. Database rule violations map to 409 `labour-rule`, never 500. The development seed adds the labour data (`src/seed/labour-seed.ts`).
- **Web.** Live `/labour` (registry table with built-in and per-user saved views, filters, search, paging, worker side panel), `/labour/register` (consent step, then details with under-18, duplicate and do-not-rehire handling), `/labour/[labourerId]/consent`, `/labour/gangs`, `/labour/gangs/[gangId]`, `/labour/setup` and `/labour/alerts`; components in `components/labour/*`; `lib/labour.ts`; labour problem codes in `use-problem-message.ts`; `FoundationApiError.match`. The D0 labour prototype moved to `/prototype/labour` (labelled), with the command menu and tour links updated, mirroring how D2.1 handled projects.
- **Dependencies.** None added; the lockfile is unchanged.

**Behaviour changes to note (existing code and tests)**

- The owner now holds 46 tenant permissions; the permission tests, the catalogue endpoint and the database checks list the two new keys. Existing tests needed no change beyond the seed test.
- `apps/api/test/projects.e2e-spec.ts`: the seed test also asserts the labour counts (40 labourers, 40 consents, 40 engagements, 18 NCA cards, 6 gangs, 39 open memberships, 1 do-not-rehire, 15 trades) and idempotence. `test/support.ts` gained the labour response contracts; `vitest.config.e2e.ts` generates random `FIELD_*` keys per run.
- The API refuses to start without `FIELD_ENCRYPTION_KEYS` and `FIELD_BLIND_INDEX_KEY` (like `AUTH_MFA_ENCRYPTION_KEY`); `.env.example` documents them as commented placeholders with generation commands.
- Web tests: `test/mock-api.mts` delegates `/labour` routes to the new `test/mock-labour.mts` (schema-validated like the rest) and its errors can carry `match`; `apps/web/tsconfig.json` sets `allowImportingTsExtensions` so the `.mts` mock can import its sibling; `playwright.config.ts` has a `globalSetup` (`test/global-setup.ts`) that requests each live route once before the tests, because with 43 tests and several parallel workers the first `next dev` compiles of new routes timed out under load (see below).

**Commands run (from the repository root unless noted) and actual results**

| Command | Actual result |
|---|---|
| `npx --yes pnpm@12.17.0 format:check` | "All matched files use Prettier code style!" |
| `npx --yes pnpm@12.17.0 turbo run lint typecheck test i18n:check build --force` | Passed: **26 successful, 0 cached**. oxlint "Found 0 warnings and 0 errors" in `types`, `domain`, `i18n`, `validation` and `api`; ESLint clean in web. Unit tests: types 20, domain 146, i18n 3, validation 67, web 27, API 107 (**370**, including D2.2's). `i18n OK: 2287 keys in en and sw, all ICU messages compile.` `next build` lists the live `/labour` and `/projects/[projectId]/bq` routes |
| `NODE_OPTIONS=--throw-deprecation npx --yes pnpm@12.17.0 --filter @pm-buddy/api test:e2e` | Passed: 8 files, **118 tests** in 9.9 s against a freshly recreated `pmb_test` under `pmb_app` (labour **20**, BQ 13, identity 34, projects 15, passkeys 15, roles 10, health 7, passwords 4); no deprecation thrown |
| `PLAYWRIGHT_WEB_PORT=3310 PLAYWRIGHT_MOCK_API_PORT=3399 npx --yes pnpm@12.17.0 --filter @pm-buddy/web test:e2e` | Passed: **52 tests** (13 labour, 9 BQ, 30 earlier) in 1.2 min with 7 workers; a second full run also passed 52/52 |
| Drop and recreate `pmb` and `pmb_test` on the isolated stack (`pmb-p34`, port 55532) with the same statements as `infra/docker/postgres/init/01-roles.sh`, then `npx --yes pnpm@12.17.0 db:migrate` | "14 migrations found"; applied in order, `20261110110000_bq_import` before `20261111090000_labour_registry`; "All migrations have been successfully applied." A later `db:migrate` reports "No pending migrations to apply." |
| `npx --yes pnpm@12.17.0 db:seed` (run 1, empty database) | Exit 0: company, accounts and projects "created"; "15 trades; 6 gangs; 16 new rates this run", "40 labourers (40 created this run)" |
| `npx --yes pnpm@12.17.0 db:seed` (run 2) | Exit 0: everything "already present"; "0 new rates", "0 created this run". Counts: 40 labourers with 40 distinct ID indexes, 40 consents, 16 rates, 6 gangs, 18 NCA cards |
| `cd apps/api && npx --yes pnpm@12.17.0 exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` | "No difference detected.", exit 0 |
| Real-API smoke (before the review fixes and the rebase): `nest start --watch` (API 4300) and `next dev --port 3300`, signed in as the seeded project manager through the web's `/api` rewrite (after `db:seed --reset-credentials`) | `GET /labour/labourers` returned 40 masked rows; every live labour page rendered on the server with real data (registry "40 workers", "Expiring NCA" view "5 workers", alerts "5 alerts" including missing cards, gangs, setup, consent, register); a scripted Chromium opened the worker panel for the flagged worker: masked identifiers, the do-not-rehire section visible to the PM, no **Show full** buttons (the PM role lacks `labour.view_sensitive`), no console errors. Both servers were stopped afterwards; the scratch script and cookie jar were deleted |

**Test coverage added.** Unit: `packages/domain/src/labour.test.ts` (age boundary: 18th birthday today allowed, one day short refused, 29 February births, invalid dates; NCA status and summary; normalisation and masking; rate precedence and effective-dating), `packages/types/src/labour.test.ts`, `packages/validation/src/labour.test.ts`, `apps/api/src/modules/labour/field-cipher.spec.ts` (round trip with fresh nonces, tampering of nonce/body/tag/version byte, binding to company/table/column/row, wrong key, rotation across versions, per-company blind indexes, configuration errors without echoing keys), `problem-details.filter.spec.ts` (`match` allow-list), `demo-seed.spec.ts` (synthetic identifiers), `apps/web/src/lib/labour.test.ts` and `consent-notice.test.ts` (pinned digests). API e2e (`apps/api/test/labour.e2e-spec.ts`, real `pmb_app`): OpenAPI coverage; configuration permissions; registration storing only ciphertext and blind indexes (raw columns queried for every plaintext); the under-18 boundary in the API; the database, with the API bypassed, refusing an under-18 insert or date-of-birth update, a labourer without a consent row, plaintext in a ciphertext column, and deleting labourers or changing/deleting consent records, and stamping `registered_on` itself; decryption failing with the wrong key, another row or a tampered value; masking, reveal permission, step-up, `mfa-required` and audit; blind-index search and duplicate refusal; do-not-rehire set/clear with step-up, matches by ID/phone/KRA PIN and recorded overrides; consent versions and withdrawal blocking engagements; rates without overwrite, backdating or in-force deletion (also as direct SQL); NCA alerts with a changed lead time; gangs, leaders and membership history; project scoping for PM and site agent (including `manageableProjects`); versioned updates re-encrypting corrected identifiers; status changes; private saved views; company B refused on every new table; no plaintext in the audit log. Browser (`apps/web/test/labour.spec.ts`, 13 tests): registry, views, search and saved views; reveal after step-up and do-not-rehire flagging; registration with consent in Kiswahili, under-18 error, duplicate and do-not-rehire override; consent withdrawal and re-consent; gangs; setup and rates; alerts; site-agent denial; axe in EN/SW × light/dark on all eight labour pages; 360 px viewport.

**Issues found by the checks and fixed (no check was disabled or weakened)**

- pg warned "client.query() already executing" (a Node deprecation) inside tenant transactions: Prisma runs a multi-relation `include` and `Promise.all` queries concurrently on the transaction's single connection. Relations are now loaded one query at a time (`loadLabourers`, `loadGangs`); the e2e suite runs with `--throw-deprecation` to keep it that way.
- Prisma fills `@default(now())` on the client, so database checks comparing timestamps with `now()` failed; consent capture/withdrawal and do-not-rehire event times are now stamped by database triggers.
- A project manager without MFA got a generic 403 on reveal/flag; such accounts now get 403 `mfa-required` (enrol MFA first) instead of a step-up prompt they cannot complete.
- Listing failed when a stored value could not be decrypted (a test inserted a fake ciphertext); masking now shows `•••••` and logs a warning without the value, and the test seals a real ciphertext.
- Browser tests: buttons with screen-reader-only context have names like "Show full : ID number" (as in D2.1, matched with a regex); the language toggle in the top bar is also a radio named "Kiswahili", so the test scopes to the consent step; required-field labels include a visual asterisk, so selects are found by role.
- Under heavy machine load (another session's Playwright suite was running at the same time; load average up to ~117 on 14 cores) the first full browser runs timed out in cold `next dev` compiles, including in the existing projects tests. The global warm-up fixed the cold-compile part; the remaining failures disappeared once the load dropped, and the final runs passed in full.
- ESLint flagged two unused destructured variables in the new mock; fixed.

**Incidents and notes**

- While developing, the unreleased D3.1 migration was edited once (to add the database-side timestamp triggers) after it had been applied to this worktree's isolated `pmb` and `pmb_test` databases. It was rolled back there by a scratch SQL script run as the PostgreSQL superuser inside the `pmb-p34` container (dropping the new labour objects and the migration's `_prisma_migrations` row) and re-applied with `db:migrate`. No other database, stack or migration was touched; `prisma migrate diff` reports no drift.
- `next dev` logs "The destination stream errored while writing data" when a test navigates away while a server response is still streaming; it does not fail any test.
- The seeded dev passwords were reset once for the real-API smoke (`--reset-credentials`); they were never written to the repository.

**Decisions and assumptions (see ARCHITECTURE D-30–D-36)**

- Keys come from configuration with HKDF per-company derivation and a version byte (D-30); a KMS provider remains open (D-07, OR-09).
- Registration requires consent (brief §6, DPA): COMPLIANCE-REVIEW CR-DP-03 may later allow another lawful basis for some purposes.
- Saved views are private per user (D-33); built-in views are All, Active, Expiring NCA and Do not rehire (managers only).
- Labourers are visible company-wide to company-wide roles, otherwise on projects where the caller holds `labour.view` and the labourer is or was engaged. A project manager can still engage a worker first registered on another project (the duplicate-ID response names the record so it can be engaged instead of duplicated).
- Gang membership changes need `labour.manage` (project managers by default); the foreman's daily gang assignment comes with attendance (D3.2–D3.3).
- NCA alerts are computed on read (D-34): there is no queue or notification infrastructure yet, so nothing is sent.

**Limitations and follow-ups**

- No re-encryption job for key rotation; the blind-index key cannot rotate without recomputing indexes; bulk-reveal rate limits and alerts are not built.
- Date of birth is not checked against the ID document; no ID/live photos or evidence files yet; NCA cards have no uploaded evidence.
- Accreditation filters are evaluated in memory after the database query (fine for hundreds of workers per company; revisit with a stored expiry index if companies grow large).
- No minimum-wage table (CR-PAY-09: rates report `not_configured`); no casual-to-term warning (CR-PAY-10, needs attendance); no bank details (payroll).
- Consent text is a draft awaiting legal and professional Kiswahili review (CR-DP-03, CR-DP-11); biometric consent is D3.4. Kiswahili UI strings need native-speaker review.
- Not pushed; GitHub CI has not run on this branch; no independent review yet.

**Independent review of D3.1 (two defects, both fixed)**

| # | Severity | Finding | Fix and tests |
|---|---|---|---|
| 1 | High | The ID blind index was an HMAC over `idType:idNumber` and every document type accepts an all-digit number, so a do-not-rehire person (or a duplicate) could register again by resubmitting the same digits as a passport or alien ID; registration and corrections looked up only the submitted type | The index is now computed over `identityIndexValue(number)` from `packages/domain`: the normalised number without its document type, and all-digit numbers without leading zeros. The existing unique index `(tenant_id, id_number_bidx)` therefore holds across types at the database level; registration, corrections, do-not-rehire matching, the identifier lookup and the seed all use the same function (D-35). Tests: domain unit tests; API e2e: duplicates refused as passport, alien ID and leading-zero national ID; a flagged national ID refused as passport and alien ID (with and without a leading zero); corrections to another worker's number under another type refused; a direct database update to a colliding index refused by the unique index; web: the registration form detects a duplicate entered as a passport |
| 2 | Medium | Saved-view filters kept `search`, so a view saved after searching a full ID, phone or KRA PIN stored it in plaintext in `labour_saved_views.filters` and returned it from `GET /labour/views`; the registry's GET search form put identifiers in URLs, browser history and sign-in redirects | Decision (D-36): saved views **never** store search text (`labourViewFiltersSchema` omits `search`; the API answers 400; the database CHECK `labour_saved_views_check` refuses `filters ? 'search'`). `GET /labour/labourers` accepts names and worker numbers only (a term with digits other than `WRK-…` is 400). Full identifiers go to the new `POST /labour/labourers/lookup` with the identifier in the body (`*.identifier` is already redacted from logs; query strings never were logged). The web search box has no `name` attribute; identifier-like terms are looked up client-side and shown under "Identifier lookup" without touching the URL, and an identifier pasted into the address is dropped and redirected away before the page loads data or builds a sign-in `next`. Tests: validation and web unit tests; API e2e (GET search with identifiers refused, name and worker-number search still work, view with search refused by API and database, no identifier in `GET /labour/views`); web (lookup request body checked, page URL never contains the identifier before or after opening a match, pasted identifier removed, name search still in the URL, save-view hint) |

The fixes needed no change to existing migrations other than this branch's own unreleased `20261111090000_labour_registry` (one CHECK clause). Because stored ID indexes changed, the isolated databases were recreated and re-seeded rather than migrated in place; nothing was released with the old index.

**Rebase onto D2.2.** `git rebase origin/main` replayed the four branch commits on `42e93c9`. Conflicts were resolved by keeping both sides: `schema.prisma` (Tenant and Project back-relations for BQ and labour; BQ models before labour models), `app.module.ts` (`BqModule` and `LabourModule`), the `types`/`domain`/`validation` index exports and `packages/domain/package.json`, the EN/SW catalogues (BQ and labour API errors; `bqExport`…`bqIssues` before `labourConsentNotices` and `labourLive`), `test/support.ts` (BQ and labour response contracts), `use-problem-message.ts`, `nav-config.ts` (live BQ routes and live `/labour`), the tour links (BQ and labour prototypes under `/prototype`), `mock-api.mts` (BQ and labour state), the API README (BQ then labour sections), and the docs (ROADMAP branches, IMPLEMENTATION_STATUS surfaces and sections, ARCHITECTURE, where the labour module became §4.3 because D2.2 took §4.2). The Playwright port overrides and the warm-up were kept; the warm-up now also compiles the BQ routes. No conflict needed a choice between behaviours.

**For the next deliverable (web attendance and timesheets → payroll).** Reference a worker by `labourers.id` (UUIDv7; `worker_no` such as `WRK-0001` is the human number). A worker is engaged on a project on a day when a `labour_engagements` row has `start_date <= day` and `end_date` null or on/after the day; only `status = 'active'` workers with active consent can be newly engaged. Gangs are `gangs` and `gang_memberships` (`joined_on`/`left_on`). The rate for a day comes from `labour_rates` via `resolveRate` in `packages/domain` (or `GET /api/v1/labour/labourers/:id/rate?projectId=&date=&basis=`); payroll lines should store the `labour_rates.id` they used. Sites are `sites` with versioned `site_geofences` (D2.1).

## D3.3 web attendance and timesheets (branch `phase-3/d3.3-web-timesheets`)

Status: **web-only slice built and verified locally; committed on the branch, not pushed.** One independent review found four defects, all fixed with tests (see "Independent review of D3.3" below); no CI run or approval yet. The roadmap keeps D3.3 at ⏳: the site-app capture (QR/NFC card and photo, geofence, signed offline records, clock drift, duplicate and impossible-travel rules) needs D3.2. The branch is stacked on `phase-3/d3.1-labour-registry` (D3.1 commits unchanged). Design: [ARCHITECTURE §4.4](./ARCHITECTURE.md#44-attendance-and-timesheets-module-d33-web-slice), §8.1, §13 and decisions D-37–D-42; tables in [ERD §6](./ERD.md#6-labour-attendance-and-biometrics); API and the payroll contract in [apps/api/README.md](../apps/api/README.md#attendance-and-timesheets-d33-web-slice); configuration in [CONFIGURATION §2](./CONFIGURATION.md#2-time-and-attendance); compliance notes and holiday sources in [COMPLIANCE_TODO](./COMPLIANCE_TODO.md#d33-implementation-notes-attendance-and-timesheets-web-slice); walkthrough in the [Phase 3 demo](./demos/phase-3.md#d33-web-slice-muster-roll-timesheets-and-adjustments). Work ran in the separate worktree and Docker stack described for D3.1 (compose project `pmb-p34`; API 4300, web 3300; Playwright 3310/3399).

**What changed**

- **Shared packages.** `types/attendance.ts`: capture methods (`web_manual` implemented; `qr_card`, `face`, `fingerprint`, `terminal` reserved) and evidence field names, attendance/day/period/decision statuses, day types, anomaly kinds with severities, holiday kinds, rule limits, the Q-C3/Q-C4 demonstration rule and period settings (COMPLIANCE-REVIEW CR-PAY-08), and `KENYA_PUBLIC_HOLIDAYS` 2026–2027 with sources (CR-PAY-14). Permissions `attendance.confirm`, `timesheets.submit`, `timesheets.approve`, `timesheets.manage_rules` (50 tenant permissions; all project-assignable); role defaults: PM +all four, site agent +`attendance.confirm` +`timesheets.submit`, finance +`attendance.view` +`timesheets.approve`; foreman unchanged (records only). `domain/attendance/*`: clock parsing, ISO weekdays and Africa/Nairobi instants, rule resolution, day types, rule and entry checks (overnight shifts supported, impossible entries refused), `computeLabourerDay` (integer minutes and half-day units, counted once across sites), totals and deltas, anomaly rules, weekly periods with the cut-off, transitions. `validation/attendance.ts`: every request and response schema. `i18n`: `attendanceLive` (EN/SW), permission labels and 26 API error messages (`i18n:check`: 2,663 keys in each).
- **Database.** Migration `20261112090000_attendance_timesheets` (no existing migration edited): 12 tables (`attendance_settings`, `timesheet_rule_versions`, `public_holidays`, `timesheet_periods`, `attendance_days`, `attendance_records`, `attendance_corrections`, `attendance_anomalies`, `timesheet_lines`, `timesheet_adjustments`, `idempotency_records`, `outbox_events`) with forced RLS and `WITH CHECK`, composite tenant keys and narrowed `pmb_app` grants (no TRUNCATE/REFERENCES/TRIGGER; UPDATE revoked on rule versions, holidays, timesheet lines, idempotency records and the outbox; DELETE revoked on all history). Triggers and CHECKs: engagement on the date, one record per labourer/site/day, evidence columns empty for `web_manual`, check-out after check-in unless overnight, maker ≠ checker for days, corrections, periods and adjustments, record changes only on draft days in editable periods (or with a correction decided in the same transaction), no overlapping periods, cut-off before submission, every day confirmed before submission, lines only at approval, approved periods immutable, rule versions and holidays locked inside submitted/approved periods, database timestamps. Permission CHECKs widened.
- **API.** New `attendance` module, 32 operations (OpenAPI-annotated), with `Idempotency-Key` replays, version checks, step-up for corrections and adjustments, redacted hash-chained audit for every command and outbox events (`attendance.day_confirmed`, `timesheet.period_approved`, `timesheet.adjustment_approved`). Database rule violations map to 409 `attendance-rule`. Production refuses to approve periods computed with unverified rules (409 `rules-unverified`).
- **Seed.** `src/seed/attendance-seed.ts` (one transaction; skipped when a period exists): holidays, the unverified demo rule, nine weeks of muster rolls ending today for the seeded labourers on Ruiru Heights and Kitengela (watchmen overnight, a Sunday pour, a holiday crew), past weeks confirmed and approved by distinct people, the last complete week submitted, the current week open, a two-site day and an excessive-hours day left open, and one approved adjustment.
- **Web.** Live `/attendance`, `/attendance/muster`, `/attendance/periods`, `/attendance/periods/[periodId]`, `/attendance/anomalies`, `/attendance/settings`; components in `components/attendance/*`; `lib/attendance.ts` (commands with a fresh `Idempotency-Key`, date and UUID parameters, default shift, draft/entry conversion); `liveRequest` accepts extra headers; attendance problem codes; the worker panel shows an attendance summary; `/attendance` is a live route; the D0 attendance prototype moved to `/prototype/attendance` (tour and prototype links updated).
- **Dependencies.** None added; the lockfile is unchanged.

**Behaviour changes to note (existing code and tests)**

- The owner holds 50 tenant permissions; site agents can now confirm muster days and submit timesheet periods on their projects; finance can view attendance and approve timesheet periods.
- `apps/api/test/projects.e2e-spec.ts`: the seed test also checks the attendance part (records, days, periods by status, snapshot lines only on approved periods, open two-site and excessive-hours anomalies, one approved adjustment decided by someone other than the requester, idempotence). It tolerates a reused `pmb_test` (the data may already exist). `test/support.ts` gained the attendance response contracts and an optional header argument.
- Web tests: `test/mock-api.mts` delegates `/attendance` routes to `test/mock-attendance.mts` (schema-validated, computes hours with the shared domain code, requires an `Idempotency-Key` on commands; fixed clock Tuesday 10/11/2026); `test/global-setup.ts` warms the new routes.

**Commands run (from the repository root unless noted) and actual results**

| Command | Actual result |
|---|---|
| `npx --yes pnpm@12.17.0 format:check` | "All matched files use Prettier code style!" |
| `npx --yes pnpm@12.17.0 turbo run lint typecheck test i18n:check build --force` | Passed: **26 successful, 0 cached**. oxlint "Found 0 warnings and 0 errors" in `types`, `domain`, `i18n`, `validation` and `api`; ESLint clean in web. Unit tests: types 28, domain 173, i18n 3, validation 74, web 33, API 107 (**418**; 48 new). `i18n OK: 2663 keys in en and sw, all ICU messages compile.` `next build` lists `/attendance`, `/attendance/anomalies`, `/attendance/muster`, `/attendance/periods`, `/attendance/periods/[periodId]`, `/attendance/settings` and `/prototype/attendance` |
| Drop and recreate `pmb_test` on the isolated stack, then `NODE_OPTIONS=--throw-deprecation npx --yes pnpm@12.17.0 --filter @pm-buddy/api test:e2e`, twice | Passed both times: 9 files, **132 tests** (attendance **14**, labour 20, BQ 13, identity 34, projects 15, passkeys 15, roles 10, health 7, passwords 4) in about 13 s under `pmb_app`; no deprecation thrown. The second run reuses the database |
| `PLAYWRIGHT_WEB_PORT=3310 PLAYWRIGHT_MOCK_API_PORT=3399 npx --yes pnpm@12.17.0 --filter @pm-buddy/web test:e2e` | Passed: **67 tests** (15 attendance, 52 earlier) in 2.4 min with 7 workers; an earlier full run also passed 67/67 (1.9 min). `next dev` logged a few "destination stream errored while writing data" messages while earlier suites navigated away mid-render; no test failed |
| Drop and recreate `pmb` on the isolated stack, then `npx --yes pnpm@12.17.0 db:migrate` | "15 migrations found"; applied `20261112090000_attendance_timesheets` last; "All migrations have been successfully applied." A second `db:migrate`: "No pending migrations to apply." |
| `npx --yes pnpm@12.17.0 db:seed` (run 1, empty database) | Exit 0 in 11.4 s: company, accounts, projects and 40 labourers "created"; "Attendance and timesheets (synthetic; created): 1508 attendance records; 20 timesheet periods (16 approved); 29 open anomalies; 1 adjustment(s); 23 public holidays" |
| `npx --yes pnpm@12.17.0 db:seed` (run 2) | Exit 0 in 4.7 s: everything "already present", the same attendance counts |
| `cd apps/api && npx --yes pnpm@12.17.0 exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` | "No difference detected.", exit 0 |
| Real-API smoke: `nest start --watch` (API 4300) and `next dev --port 3300`; a scratch script signed in through the web's `/api` rewrite as the seeded site agent and project manager (passwords from the local seed output, never printed) | Overview: Ruiru Heights with today's Main plot draft (31 records) and Materials yard draft (3), 29 open anomalies, 1 period awaiting approval, current period 06/11–12/11/2026 open. Agent submitted today's Main plot day (200; the same `Idempotency-Key` replayed with `Idempotent-Replayed: true`); the agent's own confirmation was refused (409 `same-person`); the PM confirmed it (200); the PM's correction request was refused (403 `mfa-required`, the seeded PM has no MFA). Periods: 8 approved, 30/10 submitted by Kevin Kiprono (PM `canApprove` true, 9 open anomalies to review first), 06/11 open. `GET periods/:id/lines` for an approved week: 34 attendance lines with the unverified rule version (×1.50). Every live attendance page rendered on the server (HTTP 200, the expected heading, no prototype banner outside the message payload). Both servers were stopped; the scratch script and logs were deleted |

**Test coverage added.** Unit: `packages/domain/src/attendance/attendance.test.ts` (27: times and Nairobi instants, rule resolution and holiday-over-rest-day, rule and entry checks including overnight shifts and explicit refusals, default and entered breaks, half-day threshold boundary, lateness grace on weekdays only, rest-day and holiday overtime, a two-site day counted once, overlapping minutes, locked allocations, missing rules, absences, largest-remainder sharing, adjustment deltas, every anomaly rule, Friday–Thursday periods with the Thursday 18:00 cut-off exactly at the boundary, transitions); `types` (8: capture methods, severities, demo values within limits, holiday list sorted/unique/sourced, Sunday rule, role defaults); `validation` (7); web `lib/attendance.test.ts` (6). API e2e `test/attendance.e2e-spec.ts` (14): OpenAPI coverage; settings, rules and holidays by permission (backdating into locked periods refused); muster roll for engaged labourers only with versions and validation; idempotency bound to caller and payload; maker ≠ checker for days; evidence columns and impossible shifts refused by the database; anomaly flags; corrections with reason, step-up and a second person; the full period walk (cut-off, submit, approve, snapshot, lock, refusals inside locked periods); digest binding, reject and reopen; adjustments to an approved period with a concurrent approval race (one 200, one 409); labourer summary scoping; tenant isolation for every new table (API 404s and direct inserts/reads under `pmb_app`); audit without reasons or notes. Browser `test/attendance.spec.ts` (15): overview, keyboard entry and bulk present with validation and the `Idempotency-Key` header, self-confirmation refused, confirming another recorder's day, correction with step-up and a refused self-approval, period approval into a snapshot, reject and reopen, adjustment decisions (and a refused self-approval) landing in the next period, anomaly review, rules/holidays/cut-off settings, the worker-panel summary, site-agent limits, axe in EN/SW × light/dark on every page (and on the correction, adjustment and review dialogs), and a 360 px viewport.

**Decisions and assumptions**

- One muster entry per labourer, site and day (D-37); inactive and do-not-rehire labourers can be recorded but are flagged, labourers not engaged that day are refused (D-42).
- Overnight shifts are supported and dated on their start day; times are minutes after midnight; a shift longer than 24 h is impossible.
- Lateness only on weekdays and not for overnight shifts; the governing rule of a labourer-day is that of the earliest worked record's project.
- Leave and sick days are counted, not paid; overtime multipliers are recorded with the rule version and applied by payroll (D4.1).
- Holidays: Act Part I days, the s.4 Sunday rule (no Saturday rule), the 2026 Idd dates from the Gazette, the 2027 general election; 2027 Idd days omitted until gazetted. Sources are listed in COMPLIANCE_TODO and on every row.
- Adjustments land in the open (or rejected) period covering today, or the next one; periods are weekly only (Q-C4).

**Limitations**

- No site app, QR/NFC, photos, GPS/geofence, offline signed records, clock-drift, duplicate-window or impossible-travel rules, kiosk or biometrics; `web_manual` relies on the supervisor's account and a confirmer.
- Rule values and holidays are unverified demonstration data (CR-PAY-08, CR-PAY-14); there is no workflow to approve a rule version, so production approval is blocked until one exists.
- No notifications for pending confirmations, corrections or approvals; no outbox relay (events accumulate in `outbox_events`).
- No casual-to-term warning (CR-PAY-10), no retention jobs (CR-PAY-13), no pay calculation.
- No CI run on a pull request yet. One independent review has happened (four defects, fixed below).

**Independent review of D3.3 (four defects, all fixed)**

Fixed in follow-up commits on the same branch. The database changes are a new migration, `20261112120000_attendance_review_fixes`, rather than an edit of `20261112090000_attendance_timesheets`: a database that already applied the first one (the isolated `pmb` and `pmb_test`, or a reviewer's) just migrates forward. `prisma migrate diff` stays clean because the changes are CHECKs and trigger functions.

1. **A person who rejected a period could never submit it again (MEDIUM).** The CHECK `rejected_by <> submitted_by` applied in every state, and reopening kept `rejected_by`, so "agent submits, PM rejects, PM reopens, PM submits for another approver" hit the CHECK and returned a generic 409. Fix: the CHECK now applies only while the period is rejected (`status <> 'rejected' OR rejected_by <> submitted_by`); approval keeps `approved_by <> submitted_by`. The last rejection stays on the period as history; every rejection is in the audit log. Test: e2e "lets the person who rejected a period submit it again once reopened" (that exact scenario; then the PM's own approval is refused and the owner approves).
2. **Half days across sites (MEDIUM).** `half_day` at site A plus `half_day` at site B counted one half for the day, while `half_day` + `present` counted two. Fix (`packages/domain` `computeLabourerDay`, `shareHalfDays`): each `half_day` record is worth one half; a day has at most two halves; the threshold applies only when a `present` record is involved and never lowers the labelled halves; a `half_day` record gets at most one half when units are shared. The result no longer depends on record order, site or project. Tests: domain "half days across sites and projects" (half+half, half+present either way round, a long half day with a short present record, three half days, short present work, monotonic with an extra present record).
3. **Locked cross-project shares were never revisited (MEDIUM).** After one project's period was approved, a later change to the labourer's record on another project left the approved share as it was: (a) p2 05:00–07:00 + p1 07:00–16:00, p1 approved at 360 normal + 120 overtime, then p2 absent: p1 stayed overpaid; (b) A 07:00–11:00 + B 12:00–16:00 (half each), A approved, B absent: the day was worth two halves but only A's one was paid. Fix: `computeLabourerDay` also computes the day with nothing locked and reports `lockedDrift`; `AnomalyEvaluator` (on every save, correction approval, period submission and adjustment approval) opens a **blocking** `locked_share_changed` anomaly (new kind, critical) on the day's records in open periods, and proposes one pending adjustment for the approved period with unchanged values (`proposed = previous`, reason `AUTOMATIC_ADJUSTMENT_REASON`, requested by whoever made the change, audited with `automatic: true`). Someone else approves it; its `delta` (after − before, `after` = the share recomputed with nothing locked) lands in a later open period and the anomaly clears itself. A rejected automatic proposal is not repeated until the day changes again, and reviewers can dismiss the anomaly with a note. A manual adjustment with unchanged values is accepted only while such a difference exists. Tests: domain "locked shares when another record of the day changes" (both cases and no false positives); e2e "re-evaluates an approved share…" (case a: anomaly with paid/ideal minutes, the p2 period blocked, the automatic proposal, self-approval refused, delta +120 normal / −120 overtime, anomaly cleared; case b: delta +1 half; no second proposal on a re-save; the approved snapshot unchanged; both lines land in the current period; audit events); web anomaly and adjustment rendering in EN/SW.
4. **Lost update on correction approval (MEDIUM).** A correction asked for on a submitted day could be approved after the day was returned to draft and the foreman changed the record, overwriting the newer value. Fix: returning a day is refused while a correction is pending (API 409 `pending-corrections` and the `guard_attendance_day` trigger); approval requires the day to be submitted or confirmed and the record to still hold the correction's `previous` values (API 409 `correction-outdated` via `correctionApplies`, and the `guard_attendance_correction` trigger). Chosen over silently voiding pending corrections, so a decision is always explicit and audited. Tests: e2e "never applies a correction over a newer value" (return refused in the API and directly in the database, reject then return, the foreman's newer value, the old correction cannot be applied, a new correction starts from the newer value); unit `attendance-mappers.spec.ts` (day state, every value, missing records).

Also: `@pm-buddy/types` exports `AUTOMATIC_ADJUSTMENT_REASON`; the web shows a translated explanation for automatic adjustments and the paid-versus-recomputed text for `locked_share_changed`; i18n gained 4 keys (`i18n:check`: 2,667 keys in each); the browser mock mirrors the return and correction refusals.

**Commands run after the fixes (from the repository root unless noted) and actual results**

| Command | Actual result |
|---|---|
| `npx --yes pnpm@12.17.0 format:check` | "All matched files use Prettier code style!" |
| `npx --yes pnpm@12.17.0 turbo run lint typecheck test i18n:check build --force` | Passed: **26 successful, 0 cached**; oxlint 0 warnings and 0 errors, ESLint clean. Unit tests: types 28, domain 180, i18n 3, validation 74, web 33, API 112 (**430**). `i18n OK: 2667 keys in en and sw` |
| `NODE_OPTIONS=--throw-deprecation npx --yes pnpm@12.17.0 --filter @pm-buddy/api test:e2e` on the reused `pmb_test` (migrated forward), then on a freshly recreated `pmb_test` | Passed both times: 9 files, **135 tests** (attendance **17**) |
| `PLAYWRIGHT_WEB_PORT=3310 PLAYWRIGHT_MOCK_API_PORT=3399 npx --yes pnpm@12.17.0 --filter @pm-buddy/web test:e2e` | First run under a load average of about 35 (another session on the machine): 58 passed, 9 timed out in `page.goto` (labour and project accessibility loops, untouched by these fixes). Two reruns: **67 passed** each (1.7 min) |
| `npx --yes pnpm@12.17.0 db:migrate` on the populated isolated `pmb` | "16 migrations found"; applied `20261112120000_attendance_review_fixes` |
| Drop and recreate `pmb`, then `db:migrate`, `db:migrate`, `db:seed`, `db:seed` | All migrations applied, then "No pending migrations to apply."; seed run 1 "created": 1508 attendance records, 20 periods (16 approved), 29 open anomalies, 1 adjustment, 23 holidays; run 2 "already present" with the same counts |
| `cd apps/api && npx --yes pnpm@12.17.0 exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` | "No difference detected.", exit 0 |


## Phase 6 — increment 1: live site-diary foundation (11 November 2026)

Owner selected **"Implement all Phase 6 incrementally, starting with its foundations"**.
This increment starts D6.1; it does not mark D6.1 or Phase 6 accepted, and does not
silently assume the attendance, stores or financial-ledger modules exist.

Delivered:

- `/diary` lists accessible projects; the sidebar opens it and legacy `/soon/diary`
  redirects to it. `/projects/[projectId]?tab=diary` is live, not a prototype.
- Daily site drafts capture work, weather, constraints and a **manual**, nullable
  workforce count. Unknown remains null; zero explicitly means no workers. Site/day
  is unique; future Nairobi dates and mismatched project/site IDs are refused.
- Original-author edits, submission, independent `quality.manage` approval/rejection,
  author reopening of rejection, expected-version conflicts and permanent approval
  locking. Reads use `projects.view`; writing uses `site.diary`. All permissions use
  the existing role ∩ assignment policy. EN/SW, mobile layout and explicit errors.
- Persisted `site_diaries` with forced tenant RLS, composite tenant/project/site
  reference, database actor/state/version/locking protections, safe-summary audit in
  the same transaction, bounded cursor pagination and strict shared contracts.
- Local development migration applied successfully; `prisma migrate diff
  --from-config-datasource --to-schema prisma/schema.prisma --exit-code` reported
  **No difference detected**. No production migration/deployment was performed.

Executed evidence:

| Command | Actual result |
|---|---|
| `pnpm --filter @pm-buddy/domain test` | 10 files, 133 tests passed |
| `pnpm --filter @pm-buddy/validation test` | 7 files, 62 tests passed, including impossible sign-off response rejection |
| `pnpm --filter @pm-buddy/api exec vitest run --config vitest.config.e2e.ts test/diaries.e2e-spec.ts` | 10 tests passed against real PostgreSQL/runtime role: persistence, CSRF/auth, role/project scope, cross-tenant RLS and references, concurrent edits, author-only drafts, independent approval, rejection/reopen, immutable SQL backstops, pagination, audit redaction, revoked assignments and cancelled-project writes |
| API integration regression run: diary + projects + identity | 3 files, 58 tests passed before the final cancelled-project test was added; final diary suite rerun separately as above |
| `pnpm --filter @pm-buddy/web exec playwright test test/diaries.spec.ts` | 3 Chromium tests passed: live-route navigation, draft CRUD/submission, independent lock/reload, rejection reason, stale-version and malformed-success failures, EN/SW, 360px, dark theme and axe |
| `pnpm --filter @pm-buddy/web test` | 5 files, 20 existing unit tests passed |
| API/web `typecheck`, `lint`; domain/validation `lint` | Passed |
| `pnpm --filter @pm-buddy/i18n i18n:check` | Passed: 1,855 EN/SW keys and ICU compilation |
| `pnpm --filter @pm-buddy/api build` | Passed |
| `PLAYWRIGHT_TEST=1 pnpm --filter @pm-buddy/web build` | Passed; includes `/diary` and project diary tab |

Tooling used the already-cached pnpm 12.17.0 executable after the interactive PATH
lacked pnpm/npx. Browser tests now use `.next-e2e` (`PLAYWRIGHT_TEST=1`) so they do not
compete with the existing developer server. ESLint ignores generated browser build
and test-output directories. Existing server at port 3200 was left running and
remained responsive. The existing identity suite still emits its previously noted
Node listener warning. No GitHub CI or all-project browser-suite run is claimed.
The running API's OpenAPI document through port 3200 exposes all three diary paths;
an unauthenticated diary read returns 401, and `/diary` redirects to sign-in. These
are route/auth smoke checks, not a real-API authenticated browser workflow.

Remaining Phase 6 work, in incremental delivery order:

1. Finish D6.1: attendance-backed workforce snapshot with provenance; offline/site-app
   capture; attachments and server photo verification; inspections/checklists,
   cube/slump tests, snags, practical completion and defects-liability workflow.
2. D6.2: schedule activities/dependencies, milestones, immutable baseline, actual
   dates, variance/Gantt and reasoned delays.
3. D6.3: approved-BQ-linked measurements/evidence, separate physical/earned/certified
   values, cost inputs and unavailable ratios when undefined, S-curve, retention and
   releases, subcontract/piece-rate linkage, cost-to-complete, independent certificate
   review/issuance and immutable PDF snapshots. Prevent double billing materials on
   site when incorporated. No EVM or certificate figures are fabricated today.

See [Phase 6 demo](./demos/phase-6.md) and the [API contract](../apps/api/README.md#site-diary-foundation-d61-phase-6-increment-1).

## Continue with Google (11 November 2026)

Owner request: "allow login with gmail". Owner decisions: accept **Gmail and Google
Workspace addresses** (Google-authoritative only), **link automatically** to an existing
account with the same email, and **create a new verified account** for people without one.

Delivered: "Continue with Google" on `/sign-in` (EN/SW), shown only when the API reports it
configured; OpenID Connect code flow with PKCE, state and nonce via `openid-client@6.8.9`
(pinned; adds `oauth4webapi@3.8.8`, reuses `jose@6.2.15`); ID token issuer, audience,
expiry, nonce and signature checks; `user_identities` table (migration
`20261116100000_google_sign_in`, unique per Google subject and per user); emailed notice on
linking; takeover of an unverified pending registration discards its password; explicit
`?google=` outcomes; PM-Buddy MFA, roles and tenancy unchanged. Off unless
`AUTH_GOOGLE_CLIENT_ID` / `AUTH_GOOGLE_CLIENT_SECRET` are set (see the
[API README](../apps/api/README.md#continue-with-google)).

| Command | Actual result |
|---|---|
| `pnpm --filter @pm-buddy/api exec vitest run --config vitest.config.e2e.ts test/google.e2e-spec.ts` | 11 tests passed against a local fake provider with the real openid-client exchange and PostgreSQL |
| `pnpm --filter @pm-buddy/api test` / `test:e2e` | 100 unit tests (17 files) and 119 integration tests (9 files) passed |
| `pnpm --filter @pm-buddy/web exec playwright test test/sign-in.spec.ts` | 6 Chromium tests passed (4 existing, 2 new: button and safe `next`, EN/SW errors, hidden when off, MFA after Google, axe) |
| API/web `typecheck` and `lint`; `i18n:check` | Passed (1,864 EN/SW keys) |
| Local migration + `prisma migrate diff --exit-code` | Applied; no difference |
| Running dev server (port 3200) | `GET /api/v1/auth/providers` → `{"google":false}`; `/auth/google/start` → 303 to `/sign-in?google=unavailable&next=%2Fdiary` |

Not yet done: a sign-in against real Google (needs the owner's OAuth client and redirect URI
registration); unlinking Google from an account; showing linked sign-in methods in the
account console. Google sign-in does not reset password-lockout counters.

## Independent review of the portals, Google and PIN sign-in

Reviewed when this work was merged into main. Google sign-in (state, nonce and PKCE in a single-use encrypted cookie, issuer/audience/signature checks, linking by Google subject, MFA still enforced), the portals, diaries, photos and the migrations raised nothing. Three findings on the PIN sign-in:

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | Medium | Every PIN attempt, right or wrong, counted against the 30-per-day budget per number, which was checked before the PIN and not cleared by a reset: 30 wrong guesses locked a labourer out for the day, even after resetting | Only wrong PINs count (`PIN_DAILY_FAILURES`, checked before verifying, recorded after); a spent budget answers `pin-reset-required` (429, EN/SW message pointing to "Forgot PIN?"); a PIN reset clears it. Portals e2e |
| 2 | Medium | PIN sessions were limited with `portalFor`, which treats `projects.view`, `bq.view` and `portal.client` as non-staff, so a custom role with `portal.worker` plus those let a guessed PIN read BQ rates and contract sums | `pinAllowed` (packages/types): a PIN session's role must hold `portal.worker` and nothing else, checked when joining, accepting an invitation and on every tenant request. Unit test and portals e2e (join refused; a role that later gains view permissions loses PIN access) |
| 3 | Low | PIN hashes use the password Argon2id settings without a server-side pepper; with 10⁶ PINs a database dump reveals them | **Fixed (13/11/2026, `security/pin-hardening`):** PINs are keyed with HMAC-SHA-256 under `AUTH_PIN_PEPPER_KEYS` (environment / secrets manager, versioned like the field keys, required in production) before Argon2id; `users.pin_pepper_version` records the key, and older hashes are re-hashed on the next correct sign-in. Unit tests and portals e2e |

Also fixed then: production refuses to start without `TRUST_PROXY` (or with `0` or an empty list), so per-address limits always apply; and a platform-wide hourly budget of wrong PINs (`PIN_GLOBAL_FAILURES_PER_HOUR`, default 200) logs an alert once and then allows each number one wrong PIN an hour, while correct PINs keep working for numbers without a wrong PIN since. An independent review of these changes found two medium and two low issues, all fixed: parallel guesses could each pass the budget check before any was counted (each attempt now reserves its place atomically first); one address could spend the platform-wide budget and earlier typos then locked numbers out (only wrong PINs made while it is spent count now, so tripping it only tightens guessing; a second review rejected capping each address's share, which let one client guess on uncounted, so every wrong PIN still counts); `TRUST_PROXY=0` passed the production check; and with several pepper keys the active one was implicit, so instances could disagree mid-rotation (now required), while an unlisted key version was refused faster than a real check (it now costs a full Argon2id check and logs a warning). Each fix was mutation-checked: reverting it fails a test (pepper, re-hash, rotation rule, timing, tightening, single alert, reservation race, every wrong PIN counted, attack window, reset, `TRUST_PROXY`).

## Portals for clients, labourers and staff (11 November 2026)

Owner request: "id like different portals for clients admin and labourers" (and Google sign-in,
delivered above). Owner decisions: **admin = company staff** (the existing office app),
**one sign-in page routing by role**, **labourers sign in with phone + PIN invited by a PM**, and
**all three portals now with the live data that exists**. This adds a labourer web portal on top
of the brief's USSD-only plan (§3); USSD remains D7.3.

Delivered: `labourer` system role (`portal.worker` only); `portal.client`/`portal.worker`
project-assignable (migration `20261116110000_portals`, backfilling existing clients); `portalFor`
routing in sign-in, the office layout and both portal layouts; live `/portal` (assigned
projects, milestones, approved diaries) and `/worker` (assigned projects and sites, attendance
and pay explicitly "coming"); `/worker/join` and `/worker/pin`; **Labourer PIN** tab on
`/sign-in`; **Invite a labourer** on a project's Team tab (`labour.manage`); PIN accounts
(Argon2id, weak-PIN rules, shared lockout, per-number limits) with `sessions.auth_method` and
PIN sessions limited to the labourer portal; site-diary lists restricted to staff permissions so
clients never see drafts; the mock client-portal prototype moved to `/prototype/portal`.

| Command | Actual result |
|---|---|
| `pnpm --filter @pm-buddy/api exec vitest run --config vitest.config.e2e.ts test/portals.e2e-spec.ts` | 9 tests passed (real PostgreSQL, `pmb_app` role) |
| `pnpm --filter @pm-buddy/api test` / `test:e2e` (after the API changes) | 100 unit tests (17 files) and 128 integration tests (10 files) passed |
| `pnpm --filter @pm-buddy/web exec playwright test` | Full browser suite: 53 passed, including 8 new portal tests |
| `pnpm --filter @pm-buddy/web test`, `typecheck`, `lint`, `PLAYWRIGHT_TEST=1 … build` | Passed (20 unit tests; build lists `/portal`, `/worker`, `/worker/join`, `/worker/pin`, `/prototype/portal`) |
| Shared packages: types 16, domain 138, validation 62, i18n 3 tests; `i18n:check` | Passed (1,951 EN/SW keys) |
| `pnpm exec prettier --check packages apps/api/src apps/api/test apps/web/src apps/web/test` | Passed |
| Dev database: `pnpm db:migrate`, `prisma migrate diff --exit-code` | Applied; no difference |
| Running dev servers (port 3200) | Portal APIs 401 signed out; `/portal`, `/worker` redirect to sign-in; `/worker/join`, `/worker/pin`, `/prototype/portal` 200; OpenAPI lists all seven new operations |

Limitations: production SMS (invitation and PIN-reset links) is unavailable until the D7.3
provider is approved; no USSD; no attendance or pay data; client photos, certificates, payments,
variations and FX are not built; no supplier portal; a six-digit PIN is a low-entropy secret,
which is why PIN sessions are confined to labourer data. Kiswahili strings need a native
speaker's review. No real-API browser smoke of the portals and no GitHub CI run are claimed.

## Phase 6 — increment 2: verified site photos (11 November 2026)

Owner instruction: "continue" (Phase 6, incrementally). This increment delivers D6.1's second
done-when check, "photo metadata is verified"; with locked approved diaries (increment 1) both
D6.1 checks now pass locally. D6.1 is still not complete: attendance-backed workforce, in-app and
offline capture, inspections/checklists, cube/slump tests, snags and completion/DLP remain.

Delivered: project **Photos** tab (upload from the phone camera, timeline with Verified / Not
verified and reasons, EN/SW); `site_photos` (migration `20261116120000_site_photos`: forced RLS,
composite site and draft-diary references, CHECKs binding `verified` to the checks and keys to
tenant/project/photo, insert-only for the runtime role, unique SHA-256 per project); EXIF reading
(`sharp@0.35.5`, `exif-reader@2.0.3`, both pinned); `verifyPhotoEvidence` against the geofence
version in force at capture; private originals and metadata-free thumbnails; `liveUpload`
can send form fields.

| Command | Actual result |
|---|---|
| `pnpm --filter @pm-buddy/domain test` | 142 tests passed (photo evidence: tolerance, distance outside, missing data, future/stale, Nairobi diary day) |
| `pnpm --filter @pm-buddy/validation test` | 65 tests passed |
| `pnpm --filter @pm-buddy/api test` | 103 unit tests passed (EXIF reader against generated JPEGs) |
| `pnpm --filter @pm-buddy/api test:e2e` | 11 files, 137 tests passed, including 9 photo tests (real PostgreSQL, object storage, generated EXIF JPEGs: verified/outside/missing/stale/future/assumed zone, geofence version in force, draft-diary only, duplicate, PNG, corrupt, 56-megapixel and 15 MB+ refusals, permissions, cross-company 404s, append-only SQL, pagination, audit redaction) |
| `pnpm --filter @pm-buddy/web exec playwright test --workers=3` | 55 passed, including 2 photo tests (badges and reasons, upload/duplicate/unverified outcomes, EN/SW, 360 px, axe) |
| Web `typecheck`, `lint`, unit tests (20), `PLAYWRIGHT_TEST=1 … build`; API/domain/validation lint; `i18n:check` (1,995 keys); `prettier --check` | Passed |
| Dev database migration + `prisma migrate diff --exit-code` | Applied; no difference |
| Running dev API (port 3200) | Photo list 401 signed out; OpenAPI lists the four photo operations |

Test notes: a concurrent labourer-join test from the portals increment expected exactly 409 for
the losing request; it can correctly be 401 when it arrives after the invitation is spent (the
invariant, one account, held). The assertion now accepts either. The 7-page project
accessibility sweep is marked slow (it took 24 s alone against a 30 s limit). Default-parallel
browser runs were unstable while another checkout (`construction-p34`) ran its own Playwright
suite on this machine (load average ~170); with three workers the full suite passed.

Limitations: no in-app capture proof (web uploads can come from the gallery) and no perceptual
reuse detection, so the badge is weaker than THREAT_MODEL A-13's target; HEIC is refused;
thumbnails are generated in the API process; no client-portal photo timeline yet (D7.1).

Remaining Phase 6 work: rest of D6.1 (inspections/checklists, cube/slump tests, snags,
completion/DLP; attendance-backed workforce and site-app capture after Phase 3), D6.2 schedule
(baseline, actuals, variance, delay log), D6.3 measurement, EVM and interim payment certificates.

## D6.2 schedule (branch `phase-6/d6.2-schedule`)

Status: **built, independently verified and reviewed** (findings below, all fixed). Work ran in the `construction-pin` worktree on `phase-6/d6.2-schedule` (from `origin/main` at `9d1baad`) with its own Docker stack (`pmb-pin`: PostgreSQL 55732, Valkey 56679, RustFS 9300, Mailpit 8325; API 4500, web 3500; Playwright 3510/3599). Roadmap: 🔎. **Done when "the baseline is frozen and variance is shown": met locally.** Baselines are append-only in PostgreSQL (no UPDATE or DELETE privilege, and triggers that refuse every role including the schema owner; mutation-checked below), and the Schedule tab shows variance in working days per activity, per milestone and for the project finish. Design: [ARCHITECTURE §4.6](./ARCHITECTURE.md#46-schedule-d62) and decisions D-14, D-44–D-48, [WORKFLOWS](./WORKFLOWS.md#schedule-baseline-and-delay-log-d62), [ERD §3](./ERD.md#3-projects-sites-and-schedule), [CONFIGURATION](./CONFIGURATION.md#schedule-d62), [INVARIANTS](./INVARIANTS.md), threat A-30 in [THREAT_MODEL](./THREAT_MODEL.md), acceptance rows in [ACCEPTANCE_MATRIX](./ACCEPTANCE_MATRIX.md), API contract in [apps/api/README.md](../apps/api/README.md#schedule-d62), walkthrough in the [Phase 6 demo](./demos/phase-6.md#d62-schedule-gantt-baseline-and-variance-delay-log).

**Findings fixed after independent verification and code review**

| # | Severity | Finding | Fix and regression test |
|---|---|---|---|
| 1 | High | Every schedule read needed only `projects.view`, which the client and supplier roles hold, so a client assigned to the project could read every delay's claim flag (`excusable`, `compensable`), description and history: the contractor's position on its own claims, readable by the other party | Schedule and baselines need a working permission; the delay log needs a contractor-staff permission (decision D-48). The web hides the tab and the view with the same lists. `schedule.e2e-spec.ts` refuses a client, a supplier and a view-only member everything, and a consultant the delay log only; `schedule.test.ts` covers `scheduleAccess`. Dropping either API check fails the e2e test |
| 2 | Medium | Amending a delay could silently remove its site-diary link: the form only listed the newest 100 diaries, and the API turned an omitted `siteDiaryId` into null | Leaving `siteDiaryId` out of an amendment keeps the cited diary (null still clears it), and the form always offers every diary a delay cites (`withCitedDiaries`). The delay e2e test amends without the diary (kept) and with null (cleared); a unit test covers the form list. Using the raw request fails the e2e test |
| 3 | Medium | A milestone linked from a task's start (SS or SF) showed on the working day before that task started, and its predecessor's float was one day too much | `startToMilestone` adds the missing day in the forward pass and takes it off in the backward pass. A unit test places such a milestone on the task's start day and makes its chain critical; reverting either pass fails it |
| 4 | Medium | One milestone or project date more than about 16 years from the project start (a typo such as 2062, or 2045) made the whole schedule return 422, and with it every schedule edit | Planning dates (project, milestone, activity and delay requests) must be in 2000–2099 (`PLANNING_DATE_RANGE`), and the working-day index covers that whole range even on a seven-day week. Unit tests reach 31/12/2099 from 2000 and refuse 2100; the e2e test computes a schedule with a 2099 milestone and refuses 2100. The old cap fails it |

**What changed**

- **Shared packages.**
  - `types`: `schedule.ts`. It holds the item kinds, the link types FS/SS/FF/SF, the progress bases `physical` and `quantity`, and the activity statuses. It has the 10 delay causes and the claim flags `not_assessed`, `non_excusable`, `excusable` and `compensable`. It has the delay statuses and `DEFAULT_WORKING_WEEKDAYS` (Monday–Saturday). `SCHEDULE_LIMITS` sets 500 activities, 2,000 links, durations of 1–1,000 working days, lags from −60 to +365, 50 baselines and 50 activities per delay.
  - `domain`:
    - `schedule/calendar.ts`: a working-day index over ISO weekdays and holidays.
    - `schedule/cpm.ts`: `computeSchedule` does the forward and backward pass for all four link types with lags. It gives early and late dates, total float, the critical path and driving links, handles start-no-earlier-than, and computes progress at a data date. Also `findDependencyCycle` and `dependencyCreatesCycle`.
    - `schedule/progress.ts`: progress checks, quantity percent, duration-weighted project progress, variance and delay days.
    - 23 unit tests.
  - `validation`: `schedule.ts`, with every request and response schema (4 tests).
  - `i18n`: the `schedule` namespace, the `projectDetail.tabs.schedule` label and the schedule `apiErrors`, in EN and SW.
- **Database.** Migration `20261119090000_schedule` adds seven tables. Each has `tenant_id`, forced RLS with `WITH CHECK` on `app.current_tenant_id()`, composite `(tenant_id, …)` foreign keys and grants to `pmb_app`.
  - **Tables:**
    - `schedule_settings`: one row per project, with the working weekdays and whether public holidays count. It cannot be deleted.
    - `schedule_activities`: a task or a milestone link. A task has a code, name, WBS node, an optional BQ item lineage on an approved BQ version, a duration, an optional start-no-earlier-than date, actual start and finish, and progress (basis, percent, quantity done and total, unit). A milestone link points to a `milestones` row and is created on that milestone's first dependency. Both carry a version.
    - `schedule_dependencies`: FS/SS/FF/SF with a lag and a version; one per pair, and no self-links.
    - `schedule_baselines` and `schedule_baseline_items`: the append-only snapshot. A baseline stores its number, name, reason, data date, calendar, item count and who/when. Each item stores its kind, reference, code, name, duration and computed start and finish.
    - `schedule_delays` and `schedule_delay_activities`: the versioned, append-only delay log. Each version stores the delay ID, version, `supersedes`, number, cause, claim flag, period, working days lost (half days), description, an optional site diary, status and reason.
  - **CHECK constraints** cover shapes, dates and limits. A task is 100 % exactly when it has an actual finish. A quantity percent equals done ÷ total, rounded down to 0.01.
  - **Triggers:**
    - `app.assert_schedule_writable`: closed or cancelled projects are read-only.
    - Actual dates, delay periods and a baseline's data date cannot be after `app.business_today()`.
    - `app.reject_schedule_cycle`: recursive reachability under a project row lock.
    - Baseline items and delay activities are accepted only in their parent's transaction, with a deferred item-count check at commit.
    - `app.reject_history_mutation` on the four history tables, plus REVOKE of UPDATE and DELETE.
  - **Existing tables:** new unique `(tenant_id, project_id, id)` indexes on `milestones` and `site_diaries`, needed for the composite references. No permission was added, so `tenant_roles_permissions_check` and `project_permissions_check` are unchanged.
  - **Prisma:** seven models and their back-relations. `schedule_delays_one_number_per_project` is a partial unique index in SQL only; Prisma ignores it, so `migrate diff` stays clean.
- **API.** `apps/api/src/modules/schedule/` is registered in `app.module.ts`. It has 17 OpenAPI operations under `/api/v1/projects/:projectId/schedule`:
  - `GET`: the computed schedule with CPM results and variance; add `?baselineId=` to compare with another baseline.
  - `PUT calendar`.
  - Activities: `POST`, `PATCH` and `DELETE activities`, and `PUT activities/:activityId/progress`.
  - Dependencies: `POST`, `PATCH` and `DELETE dependencies`.
  - Baselines: `GET` and `POST baselines`, and `GET baselines/:baselineId`.
  - Delays: `GET` and `POST delays`, `GET delays/:delayId` (with history), `POST delays/:delayId/amend` and `POST delays/:delayId/withdraw`.

  `schedule-model.ts` loads the network (activities, linked milestones, links, and the calendar with the company's `public_holidays`) and computes it with the domain functions. Separate services handle activities, links and the calendar; baselines; and delays.
  - Every edit checks an optimistic version (`expectedVersion`); a stale one returns 409 `version-conflict`.
  - Cycles are refused before the insert.
  - Every record's `permissions` come from the project permissions and the record's state, using the actions' own rules.
  - Every change writes a hash-chained audit event (`schedule.*`) with IDs, codes and field names only.
- **Seed.** `apps/api/src/seed/schedule-seed.ts` runs from the demo seed after payroll. RUI-HTS gets:
  - 22 activities across the WBS;
  - 30 dependencies (FS and SS, including one lead);
  - the project's milestones linked into the network;
  - baseline 1 "Contract programme", with a data date of 02/03/2026;
  - actual dates that slipped;
  - three delays (weather, supplier/material, client instruction).

  On 14/11/2026 this shows a planned finish of 12/04/2027 against a baseline finish of 25/01/2027: **+64 working days**. Progress is 40.7 %, with 10 critical items and 27 baseline items.
- **Web.** `/projects/[id]?tab=schedule` (`schedule-tab.tsx`) takes `view=gantt|baselines|delays`, and `baseline=` to compare. Components in `components/schedule/`:
  - `gantt-chart.tsx`: an SVG chart with planned or forecast bars, the critical path, actual bars, baseline ghosts, milestone diamonds, dependency arrows, today's line in Nairobi time, and week or month zoom. It has a keyboard item list, and the chart scrolls inside a labelled, focusable region.
  - `schedule-table.tsx`: the table alternative, with every figure.
  - `activity-dialogs.tsx` (create, edit, progress), `dependencies-panel.tsx`, `calendar-panel.tsx` and `schedule-workspace.tsx`.
  - `baselines-panel.tsx`: freeze or re-baseline with a reason, the list, the variance table and comparison.
  - `delays-panel.tsx`: totals by cause, record, amend, withdraw and history.
  - `variance-badge.tsx` and `use-schedule-mutation.tsx`.

  `lib/schedule.ts` holds chart geometry and formatting (6 unit tests). `use-problem-message.ts` maps 20 new problem codes.
- **Tests and mock.**
  - `apps/api/test/schedule.e2e-spec.ts` (10 tests), and `scheduleContract` in `test/support.ts`.
  - `apps/web/test/mock-schedule.mts` computes with the domain functions at a fixed data date (10/11/2026) and parses every response with the shared schemas. Its Ruiru fixture has 8 activities, 2 milestones, baseline 1 and a weather delay. It is wired into `mock-api.mts`.
  - `schedule.spec.ts` (6 tests); `global-setup.ts` warms the schedule routes.
- **Docs.** ROADMAP (D6.2 → 🔎), ARCHITECTURE (§4.6, permission rows, D-14 accepted, D-44–D-48), WORKFLOWS, ERD §3, CONFIGURATION, INVARIANTS, THREAT_MODEL A-30, ACCEPTANCE_MATRIX, the API README and the Phase 6 demo.
- **Dependencies.** None added; `pnpm-lock.yaml` is unchanged.

**Decisions**

- **Calendar (D-44).**
  - Each project has its own ISO working weekdays (default Monday–Saturday, editable), plus the company's public holidays from attendance (on by default).
  - Durations, lags, float, variance and delay days are all in working days.
  - Each baseline stores the calendar it was computed with.
- **CPM (D-45).** The schedule is computed on every read in `packages/domain`; planned dates are never stored. The data date is today in Nairobi:
  - Completed work keeps its actual dates.
  - Started work ignores its predecessors. Its remaining time is the duration × (1 − percent), or the full duration when no percent is reported.
  - Unstarted work cannot start before the data date.

  Total float is late finish − early finish, and an item is critical when its float is ≤ 0. Milestones are zero-duration markers; a cancelled milestone leaves the network.
- **Baseline immutability (D-46).**
  - Freezing copies every task's and milestone's computed start and finish, with the name, reason, data date, who and when.
  - The database makes baselines append-only.
  - The newest baseline is current, so there is no pointer to update. Comparing with an older baseline is a query parameter.
  - Variance is null ("unavailable") when there is no baseline, and for items added after it.
- **Percent complete (D-47).**
  - It is physical progress with a declared basis: a whole-percent estimate, or quantity done ÷ total. It is 100 % only with an actual finish.
  - Project progress is weighted by planned duration and labelled as physical progress, not earned or certified value (brief §15 G). It is null when undefined.
- **Permissions (D-48).** No new permission was added:
  - Every change needs `projects.manage` (role ∩ assignment), as for the WBS and milestones. Reading the schedule and baselines needs `projects.view` plus a working permission (`SCHEDULE_READ_PERMISSIONS`), so portal-only roles never see them; the delay log, which holds the contractor's claim positions, needs a contractor-staff permission (`DELAY_LOG_READ_PERMISSIONS`: `projects.manage`, `site.diary`, `bq.edit`, `finance.manage`), so clients, suppliers and consultants never see it.
  - Closed or cancelled projects are read-only.
  - This avoids rewriting the permission CHECK constraints while D5.3 also changes them.
- **Delay log (D-48).**
  - Rows are versioned and append-only: amending or withdrawing appends a version with a reason.
  - Causes come from a fixed list.
  - The claim flag is the company's position, not a legal determination.
  - Working days lost cannot exceed the working days in the period.
- **Gantt (D-14).** It is drawn with SVG in React, with no library. The SVG is `aria-hidden`; the item list and the table carry the data.

**Found and fixed**

| # | Severity | Finding | Fix and regression test |
|---|---|---|---|
| 1 | Low | At 360 px the schedule page scrolled sideways (811 px wide). The `sr-only` table captions and headers are absolutely positioned, and they escaped the scroll regions because those were not positioned | Every schedule scroll region is now `relative`. The Kiswahili/dark/360 px test in `schedule.spec.ts` checks for horizontal scroll on all three views; it fails without the fix |
| 2 | Low | `apiErrors.actualDateFuture` mentioned only the achieved date (milestones), but activity actual dates now return the same code | The message now reads "An actual or achieved date cannot be in the future." (EN and SW) |
| 3 | Docs | The plan pointed at ERD §4 for `ScheduleActivity` and `ActivityDependency`, but they are in ERD §3 | "Implemented in D6.2" is noted in ERD §3 |

**Behaviour changes to existing features**

- A WBS node used by a schedule activity can no longer be deleted. The foreign key refuses it, and the existing `wbs-in-use` problem reports it.
- Deleting a milestone removes its schedule link row and its dependencies (cascade).

**Commands run (from the worktree root; PATH set to the arm64 Node 24.22.2 and the pnpm 12.17.0 shim) and actual results**

| Command | Actual result |
|---|---|
| `pnpm run format:check` | "All matched files use Prettier code style!", after `prettier --write` on the new files |
| `npx turbo run lint typecheck test i18n:check build --force` | **26 successful, 0 cached** (34 s). oxlint "Found 0 warnings and 0 errors"; ESLint clean in web. Unit tests: types 38, i18n 3, domain 356 (schedule 23), validation 104 (schedule 4), API 132, web 46 (schedule 6); **679** in total. "i18n OK: 4723 keys in en and sw". `next build` succeeded |
| `bash reset-db.sh pmb-pin pmb_test`, then `PLAYWRIGHT_WEB_PORT=3510 PLAYWRIGHT_MOCK_API_PORT=3599 npx turbo run test:e2e` | **First full run passed:** API 18 files, 236 tests (schedule 10); web 107 passed (schedule 6). **Second run** (`--force`, after a small table layout change): API 236 passed; web 105 passed and **2 failed**, both in `procure-to-pay.spec.ts` (D5.2 code). One was an eTIMS hint that did not update; the other was axe reporting "Execution context was destroyed". The load average was about 15. That file alone then passed 6/6 (1.1 min). **Third run** (`--force`, `pmb_test` reset again): API 18 files, 236 tests passed; web 106 passed and **1 failed**. This time it was `variations.spec.ts` (D2.3): axe ran before the page `<title>` had streamed (`document-title`), at a load average of 16–20. That file alone then passed 5/5. **Final run** (`pmb_test` reset again, load about 10): **7 successful, 7 total**. API **18 files, 236 tests**; web **107 passed** (3.7 min). The e2e tasks ran; only the package builds came from the cache. Every run passed `schedule.spec.ts` and `schedule.e2e-spec.ts` |
| `cd apps/api && npx vitest run --config ./vitest.config.e2e.ts test/schedule.e2e-spec.ts` (whole file, fresh `pmb_test`) | 10/10 |
| **Mutation checks** on `pmb_test`, each with the whole file rerun and then restored | Dropping the baseline append-only triggers: the baseline test fails ("promise resolved [1,1] instead of rejecting": the schema owner's UPDATE and DELETE went through). Dropping `schedule_dependency_no_cycle`: the cycle test fails. Removing `relative` from the scroll regions: the 360 px browser test fails |
| `cd apps/api && npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` (migrated dev database) | "No difference detected." |
| `grep -c 'integrity: sha1-' pnpm-lock.yaml` | 0 |
| **Real-API smoke** | The dev database `pmb` was reset, then `prisma migrate deploy` and `db:seed`. The API ran with `pnpm start` on :4500 and the web app with `next dev --port 3500`. A temporary Playwright script, kept outside the repository, signed in as the project manager and drove these flows: the Gantt; adding an activity and a dependency; a loop being refused; progress; re-baselining with a reason and comparing with baseline 1; recording, amending and withdrawing a delay, then its history. It then repeated them in Kiswahili with the dark theme at 360 px (no sideways scroll), and checked the site agent's read-only view. Everything worked. Afterwards dev was reseeded so the screenshots show a clean demo, and both servers were stopped |

Screenshots from the real-API smoke are kept outside the repository, in the session folder `d62-screenshots/`:

- the Gantt chart with the baseline and variance (EN);
- the headline variance (EN);
- the schedule table (EN);
- the Gantt chart, dark theme (EN);
- baselines and variance, and the comparison with baseline 1 (EN);
- the delay log, delay form and history (EN);
- the Gantt chart, baselines and delays in Kiswahili, dark theme, at 360 px;
- the site agent's read-only view.

**Not done / limitations**

- Scheduling features not built:
  - resource levelling;
  - calendars per activity;
  - constraints other than start-no-earlier-than;
  - a "retained logic" option (started work always ignores its predecessors);
  - schedule import or export (MS Project, P6).
- The schedule is recomputed on every read, with no cache (bounded by 500 activities and 2,000 links).
- Measured BQ progress, EVM and S-curves are D6.3. A client-portal schedule is D7.1.
- Recording a delay needs `projects.manage`. There is no site-agent permission for delays yet; that needs an owner decision and the permission CHECK rewrite.
- Actual dates and progress are corrections that overwrite the previous value; the audit keeps field names, not values. There is no maker-checker on progress or delays (THREAT_MODEL A-30 gaps).
- The browser tests use the mock API. The real API is covered by the API e2e suite and the one-off smoke above, which is not automated.

**Open risks**

- **Merge conflicts** with parallel work (D5.3 and the Daraja work) are likely in these files:
  - `packages/i18n/src/messages/{en,sw}.json`;
  - `apps/web/test/mock-api.mts` and `global-setup.ts`;
  - `use-problem-message.ts`;
  - `schema.prisma`;
  - `demo-seed.ts` and `main.ts`;
  - these docs.

  The migration timestamp `20261119090000` sorts between D5.3 (`20261118…`) and Daraja (`20261120…`).
- During the smoke, clicking Withdraw on a delay just after another change, before the page refresh finished, sent a stale version. It returned 409 `version-conflict` with a message and changed nothing (safe, the standard behaviour).
- In `next dev`, one intermittent hydration warning ("attributes didn't match") appeared once. It did not reproduce in about 30 later page loads.
- The demo seed back-dates baseline 1's data date; the API always uses today. A baseline's data date can therefore be earlier than its creation (noted in A-30).
- These Kiswahili terms need a native speaker's review:
  - *ratiba* (schedule);
  - *msingi uliogandishwa* (frozen baseline);
  - *tofauti* (variance);
  - *njia muhimu* (critical path);
  - *utegemezi* (dependencies);
  - *nafasi ya ziada* (float);
  - *daftari la ucheleweshaji* (delay log);
  - *msimamo wa madai* (claim position);
  - *unasameheka* / *unafidiwa* (excusable / compensable).

## D6.1 quality (branch `phase-6/d6.1-quality`)

Status: **built, independently verified and reviewed** (findings below, all fixed). Work ran in the `construction-pin` worktree on `phase-6/d6.1-quality` (from `origin/main` at `1d0896e`, which already had the diary foundation, verified photos, the portals, D6.2, D5.1–D5.3, D3.1 and D3.3) with its own Docker stack (`pmb-pin`: PostgreSQL 55732, Valkey 56679, RustFS 9300, Mailpit 8325; API 4500, web 3500; Playwright 3510/3599). Roadmap: D6.1 🔎. This completes the D6.1 "remaining" lists in the two Phase 6 increments above, except offline/site-app capture (Phase 3 site app).

**Findings fixed after independent code review**

| # | Severity | Finding | Fix and regression test |
|---|---|---|---|
| 1 | Medium | A reopened snag kept the rejected fix's photos as "photos of the fix", so a later fix recorded without photos looked evidenced and could be closed on the old pictures; re-attaching an already linked photo was silently dropped | Fix photos carry their fix round (`snag_photos.fix_round`, part of the key with the stage; the trigger requires the snag's current reopen count); the snag shows the current fix's photos and lists `earlierFixes` apart; duplicates are no longer skipped silently. `quality.e2e-spec.ts` reopens a fixed snag and expects no current fix photos and the old one under `earlierFixes`; showing every round fails it |
| 2 | Medium | `app.guard_inspection_item_photo` skipped every check whenever it ran inside another trigger, so `pmb_app` could delete photos of a signed-off inspection from a temporary trigger of its own | Only a cascade from an inspection item that is already gone skips the checks. The e2e test tries the delete from a `pg_temp` trigger and expects the guard's refusal; the old bypass fails it |
| 3 | Medium (tests) | The docs claimed self sign-off and self-certification are refused in SQL as `pmb_app`, but only the snag verifier had a direct-SQL test | The e2e tests now try, as `pmb_app`, the author signing off and returning their own inspection and the proposer certifying their own completion, and expect the triggers' refusals; dropping the author check from the sign-off trigger fails them |

**What changed**

- **Database** (two new migrations; no shipped migration edited):
  - `20261122090000_diary_workforce`: `site_diaries` gains `workforce_source` (`manual`/`attendance`, default `manual`, so existing diaries keep their counts), `workforce_by_trade` (jsonb), `workforce_muster_status` and `workforce_snapshot_at`, with a CHECK tying them together; `app.diary_attendance_workforce(tenant, site, date)` computes attendance by trade; `app.guard_site_diary` is replaced: it recomputes an attendance snapshot when a draft stores one (refusing a mismatch), stamps the snapshot time with the database clock and adds the workforce columns to the submitted/approved content freeze.
  - `20261122100000_quality`: 12 tables (`quality_settings`, `checklist_templates` + `checklist_template_items`, `inspections` + `inspection_items` + `inspection_item_photos`, `snags` + `snag_photos`, `cube_sets` + `cube_results`, `slump_tests`, `project_completions`), each with `tenant_id`, forced RLS with `WITH CHECK`, composite `(tenant_id, …)` foreign keys (to projects, sites, WBS nodes, schedule activities, approved BQ items by lineage, site photos of the same project) and `pmb_app` privileges reduced to what the API needs (no DELETE except unlinking a photo from a draft item; no UPDATE on templates, results, slump tests and snag photos; no TRUNCATE). Guard triggers enforce the lifecycles, independence, locking, numbering order, the cube rule, the DLP end date and read-only closed/cancelled projects. One existing-table change: a unique `(tenant_id, project_id, id)` index on `site_photos` for the composite photo references.
- **Shared packages**: `packages/types/src/quality.ts` (vocabulary, `CUBE_RULE` KE-CUBE-1, `SLUMP_RULE` KE-SLUMP-1, `DEFAULT_QUALITY_SETTINGS`, `QUALITY_LIMITS`, `QUALITY_READ_PERMISSIONS`, `QUALITY_RECORD_PERMISSIONS`, `WORKFORCE_SOURCES`, seven bilingual `STARTER_CHECKLIST_TEMPLATES`); `packages/domain/src/quality/` (`concrete.ts` cube and slump rules with integer-tenth arithmetic and overdue dates, `lifecycle.ts` inspection/snag/completion transitions and independence, `completion.ts` blockers and `addCalendarMonths`, `workforce.ts` `summariseWorkforce`; 19 tests); `packages/validation/src/quality.ts` (strict request/response schemas; 4 tests) and `site-diary.ts` (workforce source, snapshot and attendance preview schemas).
- **API**: `apps/api/src/modules/quality/` (`QualityAccess`, mappers, services for templates, inspections, snags, concrete tests, completion and settings; `QualityController` with 24 operations and `TemplatesController` with 8, all OpenAPI-annotated); `DiariesService`/`DiariesController` take and refresh the attendance snapshot and add `GET …/diaries/attendance`. Every action writes a `quality.*` audit event with IDs, codes, counts and outcomes only.
- **Seed** (`apps/api/src/seed/quality-seed.ts`, through the real services as the runtime role; `demo-seed.ts` adds the completed project **Juja Road Duplex (JUJ-DPX)**): the seven starter templates; on RUI-HTS a signed-off slab inspection, a failed county walling inspection with snags from its failed items, a roofing inspection awaiting sign-off, four cube sets (CUBE-0002 failing at 28 days, CUBE-0004 overdue), three slump tests (one outside tolerance) and two diaries with an attendance snapshot (one approved); on JUJ-DPX practical completion certified 75 days before the seed day with a six-month DLP and two DLP defects. Summary line: "7 checklist templates, 4 inspections, 8 snags; 4 cube sets (1 failed at 28 days, 1 overdue); 3 slump tests; 2 diaries with an attendance workforce; JUJ-DPX practical completion 2026-08-31; defects liability period ends 2027-02-28".
- **Web**: the project's **Quality** tab (`quality-tab.tsx`: inspections, concrete tests, snags and defects, completion and DLP, with server filters, search and cursor paging), the phone checklist page (`/projects/:id/quality/inspections/:inspectionId`), `/quality` and `/quality/templates[/:id]` (templates and settings), `src/components/quality/*` and `src/lib/quality.ts` (+ test); the diary form's *From attendance* / *Typed in* choice with an attendance preview and the provenance on each diary; Quality in the sidebar; 23 problem codes mapped; 355 new keys in each of EN and SW (5,451 in total).
- **Browser tests and mock**: `apps/web/test/mock-quality.mts` (in-memory quality using the domain rules and the shared schemas, wired into `mock-api.mts`), `mock-diaries.mts` (attendance offer and snapshot), `quality.spec.ts` (6 tests), `diaries.spec.ts` (+1 test), quality routes in `global-setup.ts`.
- **API tests**: `apps/api/test/quality.e2e-spec.ts` (8 tests against PostgreSQL as `pmb_app`), quality and diary-attendance contracts in `test/support.ts`, seed counts in `projects.e2e-spec.ts`.
- **Dependencies**: none added; `pnpm-lock.yaml` unchanged.

**Decisions** (ARCHITECTURE §4.7 and D-60–D-66)

- **Permissions (D-60)**: no new keys, so the permission CHECK constraints are unchanged. Read = `projects.view` + one of `QUALITY_READ_PERMISSIONS` (`quality.manage`, `site.diary`, `site.photos`, `projects.manage`, `reports.view`, `safety.manage`); clients and suppliers get 403 and no portal subset is exposed yet. Record (inspections, tests, raise and fix snags) = `site.diary` or `quality.manage`. Sign-off, return, snag close/reopen/edit, corrections, voiding and certification = `quality.manage`, never by the record's maker (creator/submitter, fixer, proposer), checked in the API and in the triggers. Propose and withdraw completion = `projects.manage`. Templates: create/revise/retire with `quality.manage` on some project; settings with `config.manage`. Record `permissions` flags use the same rules.
- **Workforce provenance (D-61)**: `manual` (typed count, may be unknown) or `attendance` (server snapshot by trade of people present or on a half day at the site that day, the muster state and the snapshot time). Taken on create and edit, refreshed on submission (version + 2), recomputed and verified by the database, frozen while submitted and after approval.
- **Template versioning (D-62)**: append-only versions of a lineage; revising or retiring appends a version; inspections start only from the current, non-retired version and copy its items.
- **Cube rule (D-63, COMPLIANCE-REVIEW CR-QA-01)**: KE-CUBE-1 — 28 days decides (mean ≥ f_cu and every cube ≥ f_cu − 3 N/mm²; class number = cube strength); 7 days indicative (low below 65 % of f_cu); overdue after cast + age + 2 grace days. **Slump (CR-QA-02)**: KE-SLUMP-1 — pass within the stated tolerance; BS EN 206 bands suggested.
- **Results are immutable (D-64)**: append-only; corrections are new rows superseding the original once, with a reason, by `quality.manage`.
- **Snag lifecycle (D-65)**: open → fixed → closed (verified independently), or fixed → open (reopen with a reason); closed is final; snags after a certified practical completion are DLP defects.
- **Completion and DLP (D-66, CR-QA-03)**: practical and final certificates, proposed by `projects.manage`, certified independently (locked) or withdrawn with a reason; practical refused while critical snags are not closed unless an exception reason is recorded (re-checked at certification); **DLP default 6 months** (the usual JBC building default; configurable 1–24 per company and per certificate; 12 months is common for civil works); final completion after the DLP end with no open snags. The project status is not changed automatically. D6.3 retention release reads the certified rows; no valuation is built.

**Found and fixed in existing code**

- The diary limitations text and the API README said the workforce was always manual ("no attendance integration yet"); both now describe the two sources.
- The diary form dialog could not scroll, so on short screens its *Save draft* button sat outside the viewport once the workforce section grew (the D6.1 browser test caught it); it now scrolls within 90 % of the viewport height.
- The mock API's site agent lacked `site.photos`, which the real `site_agent` role holds; the mock now matches (the project team test shows four permissions for that member).

**Commands run (from the worktree root unless noted; PATH set to the arm64 Node 24.22.2 and the pnpm 12.17.0 shim) and actual results**

| Command | Actual result |
|---|---|
| `pnpm run format:check` | "All matched files use Prettier code style!" |
| `npx turbo run lint typecheck test i18n:check build` | **26 successful** (15 cached). oxlint "Found 0 warnings and 0 errors" in `types`, `i18n`, `domain`, `validation` and `api`; ESLint clean in web. Unit tests: types 38, domain 391 (23 files, incl. `quality.test.ts` 19), validation 113, i18n 3, web 53, API 132. i18n "OK: 5451 keys in en and sw, all ICU messages compile". API and web builds pass |
| Reset `pmb_test`, then `PLAYWRIGHT_WEB_PORT=3510 PLAYWRIGHT_MOCK_API_PORT=3599 npx turbo run test:e2e` | **7 successful**. API e2e 20 files, **258 tests** passed (`quality.e2e-spec.ts` 8/8); browser **119 passed** (`quality.spec.ts` 6/6, `diaries.spec.ts` 4/4) |
| `cd apps/api && npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` (migrated dev database) | "No difference detected." (exit 0) |
| Mutation checks (`d61-mutations.py`, session folder): each change applied alone, `pmb_test` reset, `quality.e2e-spec.ts` (or the domain quality tests) run, file restored | **8/8 caught**: API self sign-off; API client read; DB edit after sign-off; DB fixer closing own snag; DB forged cube outcome; DB forged attendance workforce; domain completion ignoring critical snags; domain cube rule without the individual-cube criterion. The forged-cube case first passed because the test matched any error naming the rule; the test now inserts a row that is valid except for its outcome and expects the trigger's message. Baseline after restore: pass |
| Real-API smoke: dev `pmb` reset, `prisma migrate deploy`, `pnpm run build`, `pnpm run db:seed`; API `pnpm start` (:4500) and `pnpm dev --port 3500`; a Playwright script signed in through the UI as the site agent and the project manager | See below |
| `grep -c 'integrity: sha1-' pnpm-lock.yaml` | 0 |

Real-API smoke (site agent, then project manager, then Kiswahili/dark/360 px): a diary for 11/11/2026 *From attendance* showed "30 people on site from attendance (muster confirmed)" by trade (Electrician 3 incl. 1 half day) and saved with "30 from attendance" and the snapshot time; a *Setting out* inspection answered at 360 px (no sideways scroll) with one failed, explained item, submitted, and **no sign-off offered to its author**; SNG-0004 marked fixed, and **no verification offered to the fixer**; the overdue CUBE-0004 7-day result recorded (17.5, 18, 18.2 → mean 17.90, 71.6 %, "On track (indicative)"). As the project manager: the inspection **signed off and locked** (no save offered afterwards); SNG-0004 verified and closed; **practical completion on RUI-HTS refused** ("Critical snags are open. Close them or record an exception reason.", HTTP 409, the only 4xx seen); JUJ-DPX shows the certified practical completion (31/08/2026), the DLP running to 28/02/2027 and its two DLP defects. Kiswahili + dark at 360 px: inspections, tests, snags, completion and templates without sideways scrolling. One intermittent `next dev` hydration warning ("attributes didn't match") appeared on two pages; it did not reproduce in 34 further loads across EN/SW, light/dark and 360/1280 px (the D6.2 smoke noted the same).

Screenshots (real API, kept outside the repository in the session folder `d61-screenshots/`): `01-diary-attendance-offer`, `02-diary-workforce-provenance`, `03-inspection-checklist-360`, `04-concrete-tests`, `05-inspection-signed-off`, `06-snags`, `07-practical-completion-refused`, `08-completion-dlp-running`, `09-completion-sw-dark-360`, `10-snags-sw-dark-360`, `11-templates-sw-dark-360`.

**Not done / limitations**

- Offline and site-app capture of inspections, tests and snags (Phase 3 site app); the web screens work on a phone online.
- The BQ item link is in the API (`bqItemLineageId`, newest approved BQ) but the inspection form offers only the WBS item and schedule task.
- No client-portal view of completion or snags (D7.1), and no notifications for overdue cubes or snags.
- Cube conformity is per set (no rolling groups, no core-test workflow); a failed 28-day result is flagged, not acted on. The rules await an engineer (CR-QA-01/02); the DLP default awaits a contracts adviser (CR-QA-03).
- Template text is company data in one language (the starter set loads in EN or SW); inspections copy it as written.
- Retention release, valuations and certificates of payment are D6.3; practical completion does not move the project to `completed`.
- Two colluding `quality.manage` holders can still pass each other's work (THREAT_MODEL A-41).
- Browser tests run against the mock API; the real API is covered by the API e2e suite and the one-off smoke above.

**Open risks**

- **Merge conflicts** with D5.4 (built in parallel in `construction-d23`) are likely in `packages/i18n/src/messages/{en,sw}.json`, `apps/web/test/mock-api.mts` and `global-setup.ts`, `nav-config.ts`, `use-problem-message.ts`, `schema.prisma`, `demo-seed.ts`/`main.ts`, `projects.e2e-spec.ts` (seed counts: a fourth project) and these docs. Decision numbers D-60–D-66 and threat IDs A-40–A-44 were chosen to avoid D5.4's range; migration timestamps `20261122…` sort after D5.4's `20261121…`.
- These Kiswahili terms need a native speaker's review: *ubora* (quality), *ukaguzi* (inspection), *violezo vya orodha* (checklist templates), *kasoro* (snag/defect), *kipindi cha dhamana ya kasoro* (defects liability period), *ukamilishaji wa kivitendo* (practical completion), *kyubu za zege* (concrete cubes), *majaribio ya slump* (slump tests), *idhinisha na funga* (sign off and lock), *hatari / kubwa / ndogo* (critical / major / minor), *kutoka mahudhurio* / *imeandikwa* (from attendance / typed in).

## D8.2 health and safety (branch `phase-8/d8.2-health-safety`)

Status: built and verified locally, committed, merged with `main` (D5.4 spending; health and safety is ARCHITECTURE §4.9 because §4.8 is spending), and independently reviewed (four findings, fixed below). Work ran in the `construction-pin` worktree on `phase-8/d8.2-health-safety` (from `origin/main` at `b665731`, which already had D1–D3.x, D5.1–D5.3, D6.1 and D6.2) with its own Docker stack (`pmb-pin`: PostgreSQL 55732, Valkey 56679, RustFS 9300, Mailpit 8325; API 4500, web 3500; Playwright 3510/3599). Roadmap: D8.2 🔎. The done-when flow (incident → investigation → corrective actions → done → verified → incident closed and locked) works in the API, the database, the web app and the real-API smoke below.

**What changed**

- **Database** (one new migration; no shipped migration edited): `20261124090000_health_safety` adds 13 tables (`safety_settings`, `safety_inductions`, `toolbox_talks` + `toolbox_talk_attendees`, `ppe_issues`, `safety_incidents` + `safety_incident_people` + `safety_incident_photos`, `corrective_actions`, `first_aid_kits` + `first_aid_kit_checks`, `first_aiders`, `first_aid_treatments`), each with `tenant_id`, forced RLS with `WITH CHECK` on `app.current_tenant_id()`, composite `(tenant_id, …)` foreign keys (projects, sites, labourers, gangs, users through memberships, inspections, site photos of the same site) and `pmb_app` privileges reduced to what the API needs (no TRUNCATE; no DELETE except a draft talk's attendees and an open incident's people; no UPDATE on attendees, people, photos and kit checks). CHECK constraints tie every status to its columns (for example a verified action has `verified_by` ≠ owner ≠ `done_by`). Guard triggers (`app.guard_safety_*`, `app.guard_toolbox_talk*`, `app.guard_ppe_issue`, `app.guard_corrective_action`, `app.guard_first_aid_*`) enforce the lifecycles, numbering order, maker-checker, the closing rules and **locking of closed and voided incidents for every role**, plus a deferred constraint trigger for "an injury has an injured person, a near miss none". No guard skips its checks because it runs inside another trigger: only a cascade from a parent row that is already gone is let through (the D6.1 finding). No permission was added, so the permission CHECK constraints are unchanged (and D5.4's `finance.petty_cash` needs no literal here).
- **Shared packages**: `packages/types/src/safety.ts` (vocabulary, `STARTER_INDUCTION_TOPICS`, `DEFAULT_PPE_REPLACEMENT_DAYS`, `DEFAULT_SAFETY_SETTINGS`, `SAFETY_SETTINGS_LIMITS`, `SAFETY_WARNING_DAYS`, `SAFETY_LIMITS`, `SAFETY_READ_PERMISSIONS`, `SAFETY_RECORD_PERMISSIONS`); `packages/domain/src/safety/` (`lifecycle.ts` incident, action and talk transitions; `rules.ts` overdue and ordering, induction coverage and flags, PPE replacement, kit and certificate states, the regulator rule and `incidentCloseBlockers`; 17 tests); `packages/validation/src/safety.ts` (strict request/response schemas; 5 tests).
- **API**: `apps/api/src/modules/safety/` (`SafetyAccess`, mappers, services for inductions, talks, PPE, incidents, corrective actions, first aid and settings; `SafetyController` with 38 operations and `SafetyCompanyController` with 3, all OpenAPI-annotated). Every action writes a `safety.*` audit event with IDs, codes, kinds, severities, counts and statuses only.
- **Seed** (`apps/api/src/seed/safety-seed.ts`, through the real services as the runtime role; skipped when RUI-HTS already has an incident): inductions for the labourers on site except two who attended without one, all Materials-yard workers, the site agent and a visitor; three toolbox talks (gangs A and B confirmed, gang C draft); PPE issues (some due, one returned); INC-0001 near miss closed with a verified action; INC-0002 injury investigated with CA-0002 verified and CA-0003 two days overdue (owner: the site agent); two first-aid kits (one never checked/expiring), the site agent as first-aider and FA-0001 linked to INC-0002. Summary line: "35 inductions (2 labourers flagged for working without one), 3 toolbox talks, 17 PPE issues (5 due for replacement); incidents: INC-0001 near_miss (closed), INC-0002 injury (investigated); corrective actions: 3 (2 verified, 1 overdue); 2 first-aid kits; 1 treatment(s)".
- **Web**: *Health and safety* is live in the sidebar (`/safety` overview, `/safety/settings`); the project's **Health and safety** tab (`safety-tab.tsx`: incidents, corrective actions, inductions, toolbox talks, PPE register, first aid, with server filters, search and paging); the incident report (`/projects/:id/safety/incidents/new`) and toolbox-talk form (`…/safety/talks/new`, `…/safety/talks/:talkId`) as one-column 360 px forms; the incident page (`…/safety/incidents/:incidentId`); `src/components/safety/*` and `src/lib/safety.ts` (+ 5 tests); 23 problem codes mapped; 547 new keys in each of EN and SW (5,999 in total).
- **Browser tests and mock**: `apps/web/test/mock-safety.mts` (in-memory H&S using the domain rules and the shared schemas, wired into `mock-api.mts` with the members' effective permissions), `safety.spec.ts` (8 tests), safety routes in `global-setup.ts`.
- **API tests**: `apps/api/test/safety.e2e-spec.ts` (9 tests against PostgreSQL as `pmb_app`, plus the schema owner for the lock), the safety contract in `test/support.ts`, seed counts in `projects.e2e-spec.ts`.
- **Docs**: ARCHITECTURE §4.9 and D-70–D-75, WORKFLOWS (incident, corrective action and talk state machines), ERD ("Implemented in D8.2"), CONFIGURATION (safety settings), INVARIANTS, THREAT_MODEL A-50–A-54, DPIA annex §14 (injury data), ACCEPTANCE_MATRIX, COMPLIANCE_TODO (CR-OSH rows updated, CR-HS-01–04 added), ROADMAP, the API README and `docs/demos/phase-8.md`.
- **Dependencies**: none added; `pnpm-lock.yaml` unchanged.

**Decisions** (ARCHITECTURE §4.9 and D-70–D-75)

- **Permissions (D-70)**: no new keys. Read = `projects.view` + one of `SAFETY_READ_PERMISSIONS` (`safety.manage`, `site.diary`, `projects.manage`): owner, project manager, site agent and foreman; QS, finance, consultant, storekeeper, client, supplier and labourer get 403. Record = `site.diary` or `safety.manage`. Investigate, raise/change/verify/send back/cancel actions, close, void, correct details and manage first aid = `safety.manage`. Done = the action's owner only. Record `permissions` flags use the same rules.
- **Induction flags (D-71)**: read from attendance (present or half day at the site within the look-back window, default 14 days) and never block it; the flag for days worked before a later induction stays visible until it leaves the window.
- **PPE vs stores (D-72)**: a **register only**. Issuing PPE does not post a stores movement, so a site that issues PPE from its D5.3 store records that issue in the stores and the handover here, and nothing is counted twice. A later link to a stores issue line can be added without changing the register.
- **Incident and action lifecycle (D-73)**: reported → investigated → closed (or voided). Closing needs the investigation, every action verified or cancelled, a verified action or a no-action reason, and a regulator decision for serious/fatal injuries and dangerous occurrences (COMPLIANCE-REVIEW CR-HS-01). A closed incident is locked with its people, photos, actions and linked treatments. Actions: open → done (owner) → verified (independent `safety.manage`) or sent back with a reason; cancelled with a reason; overdue first.
- **Personal data (D-74)**: people are labourer references, staff or a name only; injuries coded (type and body part, no free text); names, injuries and who was treated only for `safety.manage`; audit metadata IDs, codes and counts only (checked by the e2e suite and in the real audit table after the smoke: 92 `safety.*` events, none containing a name, an injury or free text).
- **Settings (D-75)**: company-level (`config.manage`); records keep the values they were made with.

**Found and fixed in existing code**

- Nothing outside D8.2 needed a fix. Wiring only: the sidebar's Health and safety entry was a "Phase 8" placeholder (`/soon/safety`, now redirected to `/safety`), and `isLiveRoute` now knows the safety pages.
- Found while building this branch and fixed before the report: a toolbox talk could be confirmed (and locked) from the form without a confirmation step (now a "Confirm this toolbox talk" dialog); incident and talk list links had accessible names that did not contain their visible text (axe `label-content-name-mismatch` in Kiswahili); long Kiswahili button labels in the PPE list pushed the page 2 px wider than 360 px (buttons now clamp to the row); the incident form reported a missing injured person before the basic field errors; the mock API offered a non-reader as an action owner.

**Independent review of D8.2** (a separate code-review agent on the committed branch; four findings, all fixed with tests that fail without the fix)

| # | Severity | Finding | Fix | Test |
|---|---|---|---|---|
| 1 | High | Incident photos were ordinary site photos: the project's photo list and photo downloads showed them to every photo reader, including the QS (`reports.view`), finance (company-wide) and consultants, whom the safety module refuses (D-74) | Site photos gain a `purpose` (`general`, `safety_incident`; an incident photo is never on a diary); the incident forms upload `safety_incident` photos (needs `site.diary` or `safety.manage`); the photo list returns general photos only; an incident photo's content needs `SAFETY_READ_PERMISSIONS`; incidents accept only incident photos (API 422 `photo-not-on-site` and `app.guard_safety_incident_photo`); quality evidence accepts only general photos | `safety.e2e-spec.ts` "runs incident → …": a general photo refused as evidence (API and direct SQL), the incident photo absent from the QS's photo list and 403 to download, 200 for a safety manager |
| 2 | Medium | Saving an unchanged investigation or regulator decision as another safety manager re-stamped the author, which the trigger refuses — a 500; no safety endpoint mapped database refusals | Unchanged saves return the incident unchanged (same version, same author); `SafetyDatabaseErrors` (both safety controllers) maps 23514/23505/23503/23P01 to 409 `safety-rule` and 42501 to 403, without echoing the database message | The same test (a second manager saves both unchanged: same version and author); `safety-errors.spec.ts` |
| 3 | Medium | Voiding a PPE replacement left the item it replaced `replaced` for ever: out of the "due" counts and impossible to return or replace again (the unique index counted the voided row) | Voiding a replacement puts the original back to `issued` in the same transaction; `app.guard_ppe_issue` allows `replaced → issued` only when no live replacement names it; the unique index on `replaces_issue_id` excludes voided rows | "keeps the PPE register…": the original is `issued` and due again, can be replaced again, and direct SQL cannot restore an item that still has a live replacement |
| 4 | Low | The SQL test of "locked after close" could pass without the incident check (the actions were already final) | Direct SQL inserts against the closed incident: a new corrective action, a new incident photo and linking a treatment, each with its exact trigger message | "runs incident → …" |

Mutation checks (each applied alone to a freshly migrated `pmb_test`, `safety.e2e-spec.ts` run, restored; **7/7 caught**): the purpose clause removed from the incident-photo trigger; the live-replacement check removed from the PPE trigger; the closed-incident check removed from the corrective-action trigger; the general-only filter removed from the photo list; incident-photo content gated by the general photo readers; the unchanged-investigation shortcut removed; the PPE restore removed. Mapping 23514 removed from `safetyDatabaseProblem` fails `safety-errors.spec.ts`.

A browser test (`safety.spec.ts`, induction dialog) failed once in a full run under heavy load: it clicked a button right after a filter reloaded the page and before it hydrated; it now retries the click until the dialog opens (24/24 repeated runs passed).

**Commands run (from the worktree root unless noted; PATH set to the arm64 Node 24.22.2 and the pnpm 12.17.0 shim) and actual results**

| Command | Actual result |
|---|---|
| `pnpm run format:check` | "All matched files use Prettier code style!" |
| `npx turbo run lint typecheck test i18n:check build` | **26 successful**. oxlint "Found 0 warnings and 0 errors" in `types`, `i18n`, `domain`, `validation` and `api`; ESLint clean in web. Unit tests: types 38, domain 408 (24 files, incl. `safety.test.ts` 17), validation 118, i18n 3, web 58, API 132. i18n "OK: 5999 keys in en and sw, all ICU messages compile". API and web builds pass |
| Reset `pmb_test`, then `PLAYWRIGHT_WEB_PORT=3510 PLAYWRIGHT_MOCK_API_PORT=3599 npx turbo run test:e2e` | **7 successful**. API e2e 21 files, **267 tests** passed (`safety.e2e-spec.ts` 9/9); browser **127 passed** (`safety.spec.ts` 8/8), no retries, no load-related timeouts |
| `cd apps/api && npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` (dev database reset and migrated) | "No difference detected." (exit 0) |
| Mutation checks (`d82/mutations.py`, session folder): each change applied alone, `pmb_test` reset, `safety.e2e-spec.ts` (or the domain safety tests) run, file restored | **12/12 caught**: DB closed incident editable; DB owner verifying their own action; DB closing with an action outstanding; DB closing a serious injury without a regulator decision; DB nested-trigger bypass on incident people; API anyone marking done; API clients/office roles reading; API people shown to every reader; API names in the audit; domain close ignoring the regulator; domain done actions counted overdue; domain induction never covering a day. The regulator case was first **missed** (only the API refused it); the e2e test now tries the close in SQL and expects the trigger's refusal. Baseline after restore: pass |
| Real-API smoke: dev `pmb` reset, `prisma migrate deploy`, `pnpm run build`, `pnpm run db:seed`; API `pnpm start` (:4500) and `pnpm dev --port 3500`; a Playwright script signed in through the UI as the site agent and the project manager | See below |
| `grep -c 'integrity: sha1-' pnpm-lock.yaml` | 0 |

Real-API smoke (site agent at 360 px, project manager at 1280 px, then Kiswahili/dark/360 px): the site agent reported INC-0004, a serious injury with a registered labourer (sprain, foot or ankle) and a witness by name; *Before closing* listed the investigation, a verified action and the regulator decision. The project manager recorded the investigation, raised CA-0005 owned by the site agent (the manager was **not offered "Mark done"**, and *Close incident* was not offered) and recorded the regulator decision (*Notified*, synthetic reference). The site agent marked the action done and was **not offered "Verify"**. The project manager verified it and closed the incident: "Closed and locked", **no edit, void, investigation, action, decision or photo control left**. Corrective actions list overdue CA-0003 first; inductions flag the two seeded labourers; toolbox talks, PPE, first aid, the overview and a 360 px talk form (draft saved) work. Kiswahili + dark at 360 px: incidents, actions, inductions, first aid and the closed incident without sideways scrolling. No console errors, no 4xx/5xx responses, no overflow on any page.

Screenshots (real API, kept outside the repository in the session folder `d82-screenshots/`): `01-report-injury-360`, `02-incident-reported-agent-360`, `03-investigated-action-raised-pm`, `04-action-done-owner-360`, `05-incident-closed-locked-pm`, `06-incidents`, `07-corrective-actions`, `08-inductions-flags`, `09-toolbox-talks`, `10-ppe-register`, `11-first-aid`, `12-toolbox-talk-detail`, `13-safety-overview`, `14-toolbox-talk-form-360`, `15-sw-dark-incidents-360`, `16-sw-dark-actions-360`, `17-sw-dark-inductions-360`, `18-sw-dark-first-aid-360`, `19-sw-dark-incident-closed-360`.

**Not done / limitations**

- Offline and site-app capture (Phase 3 site app); the web forms work on a phone online.
- PPE issues do not link to stores issues (D-72); no PPE acknowledgement by the labourer.
- Actions can be raised from an inspection through the API (`source: inspection`), but the inspection screen has no "raise a safety action" button yet; actions from talks are raised on the talk page.
- No notifications or reminders (overdue actions, kit checks, expiring certificates, PPE due); D7.3/D8.1.
- No deadline tracking for regulator notifications and nothing is filed with DOSH or the WIBA Director; thresholds, registers, PPE and first-aid minimums await review (COMPLIANCE_TODO CR-HS-01–04). No retention period is applied to injury data yet (CR-HS-02, CR-DP-06).
- Toolbox-talk attendance is not cross-checked against that day's attendance (THREAT_MODEL A-54); a recorder can back-date an induction to clear past flags (A-53, the recording time shows it); two colluding `safety.manage` holders can verify each other's actions (A-51).
- Browser tests run against the mock API; the real API is covered by the API e2e suite and the one-off smoke above.

**Open risks**

- **Merge conflicts** with D5.4 (merged separately) are likely in `packages/i18n/src/messages/{en,sw}.json`, `apps/web/test/mock-api.mts` and `global-setup.ts`, `nav-config.ts`, `use-problem-message.ts`, `schema.prisma` (back-relations on `Tenant`, `Project`, `Site`, `Labourer`, `Gang`, `SitePhoto`, `Inspection`), `demo-seed.ts`/`main.ts`, `projects.e2e-spec.ts` (seed counts) and these docs. Decision numbers D-70–D-75 and threat IDs A-50–A-54 were chosen to avoid D5.4's range; the migration timestamp `20261124…` sorts after D5.4's `20261123…`.
- These Kiswahili terms need a native speaker's review: *afya na usalama* (health and safety), *ajali* / *karibu-ajali* (incident / near miss), *tukio la hatari* (dangerous occurrence), *hatua za kurekebisha* (corrective actions), *mafunzo ya kuanza kazi* (site induction), *mazungumzo ya usalama* (toolbox talk), *vifaa vya kujikinga* (PPE), *huduma ya kwanza* / *mtoa huduma ya kwanza* (first aid / first-aider), *imechunguzwa* (investigated), *imefungwa · haibadiliki* (closed · locked), *imethibitishwa* (verified).

## Fix: the sidebar's Payroll link (branch `fix/payroll-nav`)

Since the D3.1/D3.3/D4.1 merge (#23) the sidebar's **Payroll** entry pointed at `/payroll`, which has no page on `main` (the live payroll screens are still work in progress on `phase-4/d4.1-payroll-engine`; the D0 prototype moved to `/prototype/payroll`), so it opened a 404 and every page prefetched it (a console error on every screen). The entry and the prototype project page's payroll link now open `/prototype/payroll` until the live screens land. `apps/web/src/components/nav-config.test.ts` checks that every sidebar link has a page under `src/app` (fails on `/payroll` without the fix).

## D8.3 plant and equipment (branch `phase-8/d8.3-plant`)

Status: built and verified locally, **not committed** (left for review) and **not yet independently reviewed**. Work ran in the `construction-pin` worktree on `phase-8/d8.3-plant` (from `origin/main` at `e5f1cf0`, which has D1–D3.x, D5.1–D5.4, D6.1, D6.2 and D8.2) with its own Docker stack (`pmb-pin`: PostgreSQL 55732; API 4500, web 3500; Playwright 3510/3599). Plant and equipment is ARCHITECTURE §4.11 (§4.10 is reserved for D6.3). Roadmap: D8.3 🔎.

**Done-when: "Fuel variance flagged".** A fuel issue records litres, the meter reading and whether the tank was filled; full-tank windows are compared with meter advance × the item's standard consumption (copied on each issue); a window more than the company tolerance (default 15 %) above the expected litres, once it covers the minimum sample (10 h / 100 km), is flagged "Fuel above the standard (estimate, not proof of theft)" on the register, the item page, the project tab and the fuel form. Proven by `plant.e2e-spec.ts` (182.0 L for 10.0 h at 14.00 L/h = 140.0 L expected → +30.0 % flagged; 150.0 L → +7.1 % not; a 5.0 h window not judged; +10.0 % on another item not flagged; a 35 % tolerance clears it), the domain golden cases (exactly 161.0 L at 15 % is not over), the browser tests and the real-API smoke (the seeded EX-01 window +30.0 %; the site agent's new fuelling +21.2 %).

**What changed**

- **Database** (one new migration; no shipped migration edited): `20261126090000_plant` adds 9 tables (`plant_settings`, `plant_items`, `plant_moves`, `plant_operators`, `plant_meter_resets`, `plant_usage_logs`, `plant_fuel_issues`, `plant_breakdowns`, `plant_services`), each with `tenant_id`, forced RLS with `WITH CHECK` on `app.current_tenant_id()`, composite `(tenant_id, …)` foreign keys (suppliers, LPOs, projects, sites as `(tenant_id, project_id, site_id)`, labourers, BQ items by lineage, cost codes, the item, the corrected row) and `pmb_app` privileges without DELETE or TRUNCATE on every plant table and without UPDATE on moves, meter resets, usage logs and fuel issues. CHECK constraints tie ownership to hire terms, meter and fuel types to readings and the standard, and statuses to their columns. Guard triggers `app.guard_plant_settings`, `…_item`, `…_move`, `…_operator`, `…_meter_reset`, `…_usage_log`, `…_fuel_issue`, `…_breakdown`, `…_service` repeat the API's rules (signed-in actor, read-only closed/cancelled projects, presence at the site that day, monotonic meters through `app.check_plant_reading`, the 24.0 h / 1,500 km day limit, one original usage per day (partial unique index), no working day on unsafe plant, operators assigned on the day, receivers engaged/members, the standard snapshot, numbering, final states) and stamp times with the database clock (`clock_timestamp()` on ledgers); `app.check_plant_state` runs as a **deferred constraint trigger** on items, moves and breakdowns (status = closure, else under repair with an open major/unsafe breakdown, else on site / available; the site is the last move's destination). No guard skips its checks inside another trigger. Every new function has `REVOKE EXECUTE … FROM PUBLIC`; the helpers are granted to `pmb_app`. **No permission was added**, so the permission CHECK constraints are unchanged.
- **Shared packages**: `packages/types/src/plant.ts` (vocabulary, `DEFAULT_PLANT_SETTINGS`, `PLANT_SETTINGS_LIMITS`, `PLANT_LIMITS`, `PLANT_READ/RECORD/FUEL/COST_PERMISSIONS`); `packages/domain/src/plant/` (`quantities.ts`, `meter.ts`, `fuel.ts`, `maintenance.ts`, `rules.ts`; `plant.test.ts` 18 tests; coverage of the new files 100 % statements and lines, 95.9 % branches); `packages/validation/src/plant.ts` (strict request/response schemas, `hireIssues`, `meterIssues`; 6 tests).
- **API**: `apps/api/src/modules/plant/` — `PlantController` (23 operations under `/api/v1/plant`) and `ProjectPlantController` (2 under `/api/v1/projects/:projectId/plant`), all OpenAPI-annotated; `PlantAccess`/`PlantCaller` (named reader permission sets; `permissions` flags from the same rules), `PlantRegisterService`, `PlantOperatorsService`, `PlantRecordsService`, `PlantMaintenanceService`, `ProjectPlantService`, `plant-model.ts`, `plant-mappers.ts`; `PlantDatabaseErrors` on both controllers (23514/23505/23503/23P01 → 409 `plant-rule`, a meter refusal → 409 `meter-out-of-order`, 42501 → 403; never the database message) with `plant-errors.spec.ts` (3 tests). Usage and fuel creates/corrections are offline-ready (client ID, `capturedAt`, `Idempotency-Key` + SHA-256 request digest; replay returns the original). Every change writes a `plant.*` audit event with IDs, codes, dates, statuses and field names only; optimistic `version` on every edit.
- **Seed** (`apps/api/src/seed/plant-seed.ts`, after safety, through the real services as the runtime role; skipped when the company already has EX-01): the synthetic plant-hire supplier "Nairobi Plant Hire Ltd (synthetic)" (so the seeded supplier count is now 4) and EX-01 (hired excavator with a certified operator; full-tank windows +0.7 % and **+30.0 %**), MX-01 (service due), VB-01 (open major breakdown, under repair), RL-01 (hired roller on KIT-BNG, idle on hire, hire ending), SCF-01 (240 scaffold frames) and GN-01 (generator in the yard). Summary: "Plant and equipment (synthetic, created): 6 items in service, 1 fuel variance alert(s) (an estimate, not proof of theft)" with one line per item and its alerts.
- **Web**: **Plant** is live in the sidebar (`nav-config.ts`: `/plant`, `isLiveRoute` knows `/plant`, `/plant/new`, `/plant/settings`, `/plant/:id`, `/projects/:id/plant/usage|fuel`; `plant` left `comingSoonSections`; `/soon/plant` redirects to `/plant`). Pages: `/plant` (register with filters, search, paging and *Needs attention*), `/plant/new`, `/plant/settings`, `/plant/:id` (overview, fuel windows, usage, breakdowns, maintenance, operators, site history and the allowed actions), the project's **Plant** tab and the 360 px **usage** and **fuel** forms. `src/components/plant/*`, `src/lib/plant.ts` (+ 4 tests); 24 problem codes mapped in `use-problem-message.ts`; 347 new keys in each of EN and SW (7,008 in total).
- **Browser tests and mock**: `apps/web/test/mock-plant.mts` (in-memory plant using the domain rules and the shared schemas, wired into `mock-api.mts`), `plant.spec.ts` (4 tests incl. SW + dark + 360 px axe and overflow checks), plant routes in `global-setup.ts`.
- **API tests**: `apps/api/test/plant.e2e-spec.ts` (9 tests against PostgreSQL as `pmb_app`, plus the schema owner for the append-only triggers and a temporary refusal probe), the plant contract in `test/support.ts`, plant counts and alerts in `projects.e2e-spec.ts` (and suppliers 3 → 4).
- **Docs**: ARCHITECTURE §4.11, the module table and D-90–D-99; ERD ("Implemented in D8.3"); INVARIANTS (six rows); THREAT_MODEL A-70–A-74 and the D8.3 test-plan row; WORKFLOWS ("Plant and equipment (D8.3)"); ACCEPTANCE_MATRIX (§5.13 rows); COMPLIANCE_TODO (CR-PLT-01–03); CONFIGURATION (plant settings); the API README; `docs/demos/phase-8.md` (D8.3 walkthrough); ROADMAP.
- **Dependencies**: none added; `pnpm-lock.yaml` unchanged.

**Decisions** (ARCHITECTURE §4.11 and D-90–D-99)

- **Permissions (D-90)**: no new keys. Read = `projects.view` + one of `plant.manage`, `site.diary`, `projects.manage`, `stores.manage`, `finance.view`, `finance.manage` (owner, project manager, site agent, foreman, QS, storekeeper, finance; clients, suppliers, consultants and labourers 403). Record usage, breakdowns, services = `site.diary` or `plant.manage`; fuel also `stores.manage`; corrections = the recording permission and (`plant.manage` or the original recorder); register, moves, operators, meter resets, off hire/disposal, service voids and **unsafe** repairs = `plant.manage`; rates and estimates = `plant.manage`, `finance.view` or `finance.manage`; settings = `config.manage`. A new key would have meant rewriting both permission CHECK constraints for no gain.
- **Append-only usage and fuel (D-91)**; **monotonic meters with reasoned resets (D-92)**; **fuel log independent of the stores ledger, no cost postings (D-93)** — much diesel never passes through a D5.3 store, posting from the log would double count what the storekeeper already issued, and the cost is counted once at invoice approval or petty cash (D-53); **full-tank variance with tolerance, minimum sample, snapshotted standard, "estimate, never proof of theft" (D-94)**; **integer tenths/hundredths, percentages truncated (D-95)**: readings `numeric(8,1)`, litres `numeric(5,1)` (0.1–2,000.0 L per issue), standards `numeric(5,2)`; **service by meter and/or days, base = last `service` record (D-96)**; **hire estimate on read, never posted; idle-on-hire, hire-ending and overrun alerts (D-97)**; **no independent sign-off except unsafe repairs, off hire and write-off need `plant.manage` (D-98)** — usage and fuel are reviewed through the alerts and corrected append-only, and returning unsafe plant to work is a safety decision; **derived, database-checked status; moves are the only way to change site (D-99)**.

**Found and fixed**

- Nothing outside D8.3 needed a fix. Wiring only: the sidebar's Plant entry was a "Phase 8" placeholder (`/soon/plant`, now redirected), `isLiveRoute` knows the plant pages, and `projects.e2e-spec.ts` counts the new plant-hire supplier.
- Found while building and fixed before this report: ending an operator assignment on a closed project was refused by the guard (the writable-project check now applies to new assignments only); the global problem filter drops extra fields, so the meter bounds of a refused reading are now in the `detail` text; the operator dialog never loaded the staff list when opened from its button; the mock's alert counts broke the shared contract (every kind must be counted); a fuel receiver who is not a company member was refused only by the API (now also `app.guard_plant_fuel_issue`, with a SQL test); no test sent a database-only refusal through HTTP (a temporary probe trigger now proves 409/403 problems, never a 500); no SQL test covered "no working day on unsafe plant" (added); the project tab hid *Record usage* for plant under repair, so a "broken down" day could not be logged (the link is back and the form defaults to *Broken down* for such items); the fuel window line had no unit ("16.5" → "16.5 h"); a comment stated the wrong numeric precisions.

**Mutation checks** (`.d83/mutations.py`, run from the worktree and deleted afterwards: each change applied alone, `pmb_test` reset for database changes, the targeted suite run, the file restored and its SHA-256 checked; **20/20 caught**; baseline after restore: pass)

| # | Mutation | Caught by |
|---|---|---|
| 1 | DB: monotonic check removed from `app.check_plant_reading` | e2e "keeps meter readings monotonic in the API and in SQL, with a reasoned reset" |
| 2 | DB: presence check (`app.plant_present`) removed from the usage guard | e2e "refuses every plant rule in SQL under the runtime role" |
| 3 | DB: `REVOKE UPDATE` on moves, resets, usage and fuel removed | e2e "corrects and voids usage and fuel as new rows, never edits, and replays idempotently" |
| 4 | DB: standard-consumption snapshot check removed | e2e "refuses every plant rule in SQL…" |
| 5 | DB: working day on unsafe plant allowed | e2e "moves plant between sites, stops unsafe plant working, …" |
| 6 | DB: derived-status check removed from `app.check_plant_state` | e2e "refuses every plant rule in SQL…" |
| 7 | DB: fuel receiver membership check removed | e2e "refuses every plant rule in SQL…" |
| 8 | API: unsafe-breakdown check on working days removed | e2e "moves plant between sites, stops unsafe plant working, …" (the database still refused, as `plant-rule`) |
| 9 | API: `canManage` granted to every reader | e2e "lets site staff record, storekeepers fuel, cost holders see rates, and refuses everyone else" |
| 10 | API: hire rates shown to every reader | e2e "lets site staff record, …" |
| 11 | API: anyone who records may correct anyone's entry | e2e "corrects and voids usage and fuel as new rows, …" |
| 12 | API: check violations no longer mapped by `PlantDatabaseErrors` | e2e "answers a database refusal the API did not catch first with a problem, never a 500" |
| 13 | Domain: flagged at exactly the tolerance (`>` → `>=`) | domain "is not over at exactly the tolerance (161.0 L for 140.0 L at 15 %)" |
| 14 | Domain: tolerance ignored | domain "flags 182.0 L … and not 150.0 L (+7.1 %)" |
| 15 | Domain: short windows not extended to the minimum sample | domain "extends a window below the minimum sample …" |
| 16 | Domain: static-meter fuel never flagged | domain "flags fuel issued while the meter has not moved" |
| 17 | Domain: a reading may exceed a later reading | domain "refuses a reading lower than an earlier one or higher than a later one" |
| 18 | Domain: service never due before the interval | domain "is due within the last 10 % of the interval and overdue after it" |
| 19 | Domain: monthly hire over 31 days | domain "estimates hire charges per day, month and hour, rounded half up" |
| 20 | Domain: idle days count today | domain "counts idle days without today" |

In the first batch, mutations 8–12 (API) ran on a test database still migrated with mutation 7, so "refuses every plant rule in SQL" also failed for them; each was re-run alone on a freshly migrated database and caught only by its targeted test (plus the audit test, which reads events from the earlier tests).

**Commands run (from the worktree root unless noted; PATH set to the arm64 Node 24.22.2 and the pnpm 12.17.0 shim) and actual results**

| Command | Actual result |
|---|---|
| `pnpm run format:check` | "All matched files use Prettier code style!" |
| `npx turbo run lint typecheck test i18n:check build --force` | **26 successful, 26 total** (1 m 4 s). oxlint "Found 0 warnings and 0 errors" in `types`, `domain`, `i18n`, `validation` and `api`; ESLint clean in web (5 unused-variable warnings in `mock-plant.mts` fixed before the final run). Unit tests: types 38, domain **445** (26 files), validation **128** (19 files), i18n 3, web **67** (17 files), API **137** (26 files). i18n "OK: 7008 keys in en and sw, all ICU messages compile". API and web builds pass (`/plant`, `/plant/[plantId]`, `/plant/new`, `/plant/settings`, `/projects/[projectId]/plant/usage`, `/projects/[projectId]/plant/fuel`) |
| Domain coverage of the new files (`vitest run src/plant --coverage …`) | `src/plant/**` 100 % statements, 95.9 % branches, 100 % functions, 100 % lines |
| Reset `pmb_test`, then `cd apps/api && npx vitest run --config ./vitest.config.e2e.ts` | **23 files, 285 tests passed** (38 s; main had 22 / 276): `plant.e2e-spec.ts` 9/9 |
| `cd apps/web && PLAYWRIGHT_WEB_PORT=3510 PLAYWRIGHT_MOCK_API_PORT=3599 npx playwright test` | **136 passed** (5.4 m; main had 132): `plant.spec.ts` 4/4, no retries, no load-related timeouts |
| `cd apps/api && npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` (dev `pmb` reset and migrated) | "No difference detected." (exit 0) |
| Mutation checks (above) | **20/20 caught**; baseline after restore: plant e2e and domain plant tests pass |
| Real-API smoke: dev `pmb` reset, `prisma migrate deploy`, `npm run db:seed` (built by turbo); API `npm start` (:4500) and `npx next start --port 3500`; a temporary Playwright script (deleted) signed in through the UI (TOTP from the seed's secrets) as the site agent (Kiswahili, dark, 360 px), the project manager, the owner and finance | See below |

Real-API smoke: the seed printed one fuel variance alert (EX-01), MX-01 service due, VB-01 open breakdown and RL-01 idle on hire and hire ending. **Site agent** (SW, dark, 360 px): the project's Plant tab without hire rates; *Rekodi matumizi* for EX-01 with the start reading filled (2478.0); a lower start reading refused with the Kiswahili meter message (the expected 409); 2478.0 → 2486.5 saved ("Matumizi yamehifadhiwa."); *Rekodi mafuta* 280 L at 2486.5 h → "Juu ya kiwango (makadirio) · Lita 280.0 kwa 16.5 h dhidi ya lita 231.0 zilizotarajiwa (+21.2 %). · Ni makadirio ya kukaguliwa, kamwe si ushahidi wa wizi."; VB-01 (under repair) opened with *Imeharibika* selected and saved; the company register and EX-01 without rates or estimates. **Project manager**: *Needs attention* lists EX-01 fuel above the standard, VB-01, MX-01 and RL-01; EX-01 shows the windows +21.2 %, +30.0 % (over) and +0.7 % (within), rate KES 18,000 / day and the estimate KES 234,000 so far; *Record the repair* on VB-01 put it back on site; RL-01, *Register plant* and the project tab render; no *Save settings* for the project manager. **Owner**: plant settings editable. **Finance**: the register shows hire estimates. No console errors other than the deliberate 409, no other 4xx and no 5xx, no horizontal overflow, no raw message keys on any page.

Screenshots (real API, kept outside the repository in the session folder `d83-screenshots/`): `agent-sw-360-dark-project-tab`, `…-usage-form`, `…-usage-backwards-refused`, `…-usage-filled`, `…-usage-saved`, `…-fuel-form`, `…-fuel-result`, `…-usage-under-repair`, `…-register`, `…-ex01`; `pm-en-register`, `pm-en-ex01`, `pm-en-vb01`, `pm-en-vb01-repaired`, `pm-en-rl01`, `pm-en-new`, `pm-en-project-tab`; `owner-en-settings`, `owner-en-register`, `owner-en-ex01`; `finance-en-register`, `finance-en-ex01`.

**Not done / limitations**

- Plant in the offline site app (Phase 3): the usage and fuel endpoints are offline-ready (client ID, `capturedAt`, `Idempotency-Key` + digest), but no offline queue or sync is built. Telematics/GPS, automatic hire-invoice matching, depreciation and a plant cost report that allocates already-recorded invoice cost are not in D8.3.
- The fuel log does not link to stores issue lines (D-93; source + free-text reference only), so fuel drawn from a store but never logged against plant is a stores question, not a plant alert.
- A usage day is one pair of readings: a day with a mid-day meter change cannot be split (record the day on the old meter and the reset after it).
- A jump between one day's end reading and the next day's start is visible in the usage list but not flagged (THREAT_MODEL A-73).
- The register and alerts are computed in memory for up to 2,000 items per company (enough for the pilot; a stored read model would be needed beyond that). The *Needs attention* list shows one row per alert, so an item with two alerts appears twice.
- The web usage form tags a cost code; tagging a BQ item is API-only for now. Meter resets, item edits, corrections and settings work in the web app; the browser mock records no meter resets and offers no BQ items (the API e2e suite covers both).
- Alerts are in-app lists only (no notifications until D8.1/notifications); certificate rules, consumption standards and record keeping await review (COMPLIANCE_TODO CR-PLT-01–03).
- Browser tests run against the mock API; the real API is covered by the API e2e suite and the one-off smoke above.

**Open risks**

- **Merge conflicts** with D6.3 (in progress on another branch) are likely in `packages/i18n/src/messages/{en,sw}.json`, `apps/web/test/mock-api.mts` and `global-setup.ts`, `nav-config.ts` (+ test), `use-problem-message.ts`, `schema.prisma` (back-relations on `Tenant`, `Supplier`, `Lpo`, `Site`, `Project`, `Labourer`, `BqItem`, `CostCode`), `app.module.ts`, `demo-seed.ts`/`main.ts`, `projects.e2e-spec.ts` (seed counts), `test/support.ts` and these docs (ARCHITECTURE §4.10/§4.11 placement and the decision log, ERD, INVARIANTS, THREAT_MODEL, WORKFLOWS, ACCEPTANCE_MATRIX, CONFIGURATION, ROADMAP, this file). Decision numbers D-90–D-99, threats A-70–A-74 and CR-PLT were chosen to avoid D6.3; the migration `20261126…` sorts after D6.3's `20261125…`.
- These Kiswahili terms need a native speaker's review: *mitambo na vifaa* (plant and equipment), *kipima saa* / *odomita* (hour meter / odometer), *kiwango cha matumizi* (standard consumption), *uvumilivu wa mafuta* (fuel tolerance), *kukodisha* / *mkodishaji* / *imerudishwa kwa mkodishaji* (hire / hirer / off hire), *imekodishwa lakini haifanyi kazi* (idle on hire), *hitilafu* (breakdown), *hatari (isitumike)* (unsafe), *huduma inakaribia / imechelewa* (service due / overdue), *mwendeshaji* (operator), *kitetemeshi cha zege* (poker vibrator), *jukwaa la ujenzi* (scaffolding), *fomu za zege* (formwork), *gari la mafuta* (bowser), *makadirio, si ushahidi wa wizi* (estimate, not proof of theft).
- Fuel alerts are only as good as the standard consumption a company enters and whether "tank filled" is recorded honestly; the wording keeps them a reason to look, not a finding (§15 G).
