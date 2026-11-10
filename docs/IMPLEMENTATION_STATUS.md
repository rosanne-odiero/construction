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
| `/foundation` | API-backed registration/verification/login/reset, TOTP enrollment/step-up/recovery, session refresh/revocation, companies/projects, invitations, membership/project access, roles and permissions (custom roles, member role changes; D1.4) and redacted audit summaries |
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

Explicit remaining backend requirements: passkeys, external messaging providers, action-bound financial step-up, mobile device binding and comprehensive breached-password checking. These are not represented as working integrations. Later financial features must not use a generic MFA timestamp as action-bound approval authority.

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
2. ~~D1.2 gap: shared `packages/i18n`~~ and ~~D1.4 gap: custom roles~~: done on `phase-1/d1-rbac-i18n` (see below), pending review.
3. Phase 1 acceptance evidence in [ACCEPTANCE_MATRIX.md](./ACCEPTANCE_MATRIX.md), then Phase 2 (projects, sites and BQ).

Follow the [Phase 1 demo](./demos/phase-1.md). A green build never stands in for production payment or biometric approval.

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
