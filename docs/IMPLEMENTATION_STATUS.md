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

Status: built and verified locally; **not committed** (left for review). Design: [ARCHITECTURE §4.2](./ARCHITECTURE.md#42-bq-module-and-excel-import-d22), §17.8 and decisions D-13/D-15 (now Accepted); implemented-model differences in [ERD §4](./ERD.md#4-bq-variations-valuations-and-subcontracts); configuration in [CONFIGURATION](./CONFIGURATION.md) (`bq.vat.rate`, `bq.rounding`, `bq.import.*`, `MALWARE_SCANNER`, `BQ_VAT_RATE_PERCENT`); walkthrough in the [Phase 2 demo](./demos/phase-2.md#d22-bq-import). Every earlier security fix (D1.x reviews, the D2.1 review items) is untouched.

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
