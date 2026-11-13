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
