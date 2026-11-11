# Phase 1 demo: foundation

Phase 1 has four deliverables (D1.1–D1.4). Each gets its own section here as it lands.

> **Safeguard integration:** implementation of D1.1–D1.4 is approved, not automatic acceptance. Read [implementation status](../IMPLEMENTATION_STATUS.md) for actual current evidence. The D1.1 walkthrough/results below are historical; they are not claims that this session reran every command. No pilot, live payments or biometrics are approved.

---

## D1.1: Workspace, tooling and CI

This walkthrough takes about 10 minutes. It is the first deliverable with a real backend: the **System status** page reads live data from the API. All other screens still show the D0 mock data.

### 1. Run it

Prerequisites: Node 24, pnpm 12 and Docker Desktop (running). On networks where Corepack can't download pnpm, prefix commands with `npx pnpm@12.17.0`.

```bash
git checkout phase-1/d1.1-workspace-ci
npx pnpm@12.17.0 install
npx pnpm@12.17.0 services:up     # PostgreSQL, Valkey, RustFS (S3) and Mailpit; waits until healthy
npx pnpm@12.17.0 db:migrate      # applies the base migration as the schema-owner role
npx pnpm@12.17.0 dev             # shared packages + API on :4000 + web on :3000
```

### 2. Walkthrough

| #   | What                     | Where                                                                                                                               | Try this                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | System status            | http://localhost:3000/status (sidebar footer → **System status**, or the last card on the tour)                                     | All four cards show **Operational** with response times. Switch **EN / SW** and the theme.                                                                                                                                                                                                                     |
| 2   | A service outage         | Terminal                                                                                                                            | Run `docker compose -f infra/docker/compose.yaml stop valkey`. Within 10 seconds the page turns amber without a reload: Valkey shows **Down** with the reason, the others stay up. Run `… start valkey` and watch it recover.                                                                                   |
| 3   | The API is down          | Terminal                                                                                                                            | Stop `pnpm dev` (Ctrl+C) and run only the web app: `npx pnpm@12.17.0 --filter @pm-buddy/web dev`. The page says the API can't be reached and lists the commands to fix it. Restart `pnpm dev` afterwards.                                                                                                       |
| 4   | API reference            | http://localhost:3000/api/docs                                                                                                      | Swagger UI, served by the API through the web app's same-origin `/api` rewrite (D-16). Open **GET /api/v1/health/ready** → **Try it out** → **Execute**.                                                                                                                                                       |
| 5   | Error format             | `curl -i -H 'X-Request-Id: demo-12345678' http://localhost:3000/api/v1/nope`                                                        | A 404 as `application/problem+json` (RFC 9457). The request ID comes back in the `X-Request-Id` header and as `traceId` in the body.                                                                                                                                                                         |
| 6   | Security headers         | `curl -sI http://localhost:4000/api/v1/health/live`                                                                                 | `Content-Security-Policy: default-src 'none';frame-ancestors 'none'`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, and no `X-Powered-By`.                                                                                                                                                     |
| 7   | Database roles           | `docker compose -f infra/docker/compose.yaml exec -e PGPASSWORD=pmb_app_dev postgres psql -h localhost -U pmb_app -d pmb -c "create table t(id int)"` | **Refused** (`permission denied for schema public`). The API's database role can't change the schema and can't bypass row-level security (ARCHITECTURE §6.1). Migrations use a separate owner role.                                                                                                             |
| 8   | Developer tools          | http://localhost:8025 and http://localhost:9001/rustfs/console/index.html (`pmbdev` / `pmbdevsecret`)                               | Mailpit stays empty until notifications land. The RustFS console shows the private `pmb-local` bucket the API created on start-up.                                                                                                                                                                              |
| 9   | The prototype still runs | http://localhost:3000                                                                                                               | Every D0 screen works as before. The banner now says screens show mock data unless marked **Live**. Registering a worker (`/labour` → **Register worker**) now uses the shared phone and age rules from `packages/domain`, the same code the API will use.                                                    |
| 10  | CI                       | `.github/`                                                                                                                          | `ci.yml`: format, lint, typecheck, unit tests, i18n check and build, plus API end-to-end tests against the same Docker services. `codeql.yml`, `security.yml` (gitleaks and dependency review) and Dependabot. They run on the first push or pull request. |

### 3. What changed under the hood

| Area            | What's new                                                                                                                                                                                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared packages | `types` (permission catalogue, roles), `domain` (Kenyan phones, money in minor units, age, geofences; 34 tests), `validation` (environment and health schemas), `config` (tsconfig presets)                                                                                 |
| API             | NestJS 12, ESM. Health endpoints at `/api/v1/health/live` and `/ready`. Errors as problem+json. Strict security headers. Request IDs. pino logs that leave out headers and query strings and redact secrets and personal data. OpenTelemetry tracing when a collector is configured. |
| Database        | PostgreSQL 18 with two roles: `pmb_migrator` (owns the schema) and `pmb_app` (the API: no DDL, no RLS bypass). The base migration adds the fail-closed `app.current_tenant_id()` helper that tenant tables use from D1.3.                                                    |
| Local services  | Valkey instead of Redis and RustFS instead of MinIO, for licensing and availability reasons (ARCHITECTURE D-24). The app only uses the Redis protocol and the S3 API, so the cloud services chosen in Phase 9 drop in.                                                     |
| Supply chain    | The lockfile works with any npm registry and uses sha512 hashes; CI actions are pinned to commits; Dependabot waits 7 days before proposing new releases (D-26).                                                                                                           |

### 4. Checks run for this deliverable

- `pnpm format:check` and `pnpm turbo run lint typecheck test i18n:check build`: 21 tasks green, 70 unit tests, 0 lint warnings.
- API end-to-end suite: 7 tests against the real services, on a separate `pmb_test` database, connected as the restricted `pmb_app` role.
- `actionlint` on the workflows: 0 findings. gitleaks on the git history: no leaks.
- A clean install from an empty package store verified all 1,105 packages against the lockfile's sha512 hashes.
- `/status` checked in English and Kiswahili, light and dark: all up, Valkey down, API unreachable, and automatic recovery.
- The production build: 8 client-side navigations across the prototype with 0 console errors.

### 5. Known limits

- In `pnpm dev` only, the browser console may show a React `removeChild` error if you click to another page while it is still compiling for the first time. It comes from development hot reloading and does not occur in production builds.
- Swagger UI requests are not written to the API request log; API calls are.
- CI has not run on GitHub yet: the branches still need to be pushed from the `rosanne-odiero` account.

### 6. How to give feedback

Reply with the **item number and what to change**, or **"approved"**. Feedback is fixed on the `phase-1/d1.1-workspace-ci` branch before D1.2 starts.

---

## D1.2: Shared design system, i18n and installation metadata

1. Start the existing web app and open http://localhost:3000/design-system.
2. Switch EN/SW and light/dark. Inspect labelled inputs, visible validation, semantic status labels and KES/Nairobi formats.
3. Use keyboard Tab: the skip link receives focus first. Inspect on a 360px-wide viewport without horizontal overflow.
4. Read the pending/unknown-payment and offline examples: neither claims settlement or server-verified evidence. Gallery inputs are not persisted.
5. Inspect `/manifest.webmanifest` and `/icon.svg`. Manifest metadata is not offline attendance/payroll support; no service worker caches sensitive information.
6. Follow **Open live foundation** for real Phase 1 operations; **Browse prototype** retains mock business flows. The original `/sign-in` is a labelled D0 preview, not production authentication.

Checks: `pnpm --filter @pm-buddy/web test`, `lint`, `typecheck`, `build`, and `test:e2e`, plus `pnpm --filter @pm-buddy/i18n i18n:check` (the EN/SW catalogues now live in `packages/i18n/src/messages`; the web app loads them through `@pm-buddy/i18n`). Before browser tests run `pnpm --filter @pm-buddy/web exec playwright install --no-shell chromium`. Playwright owns/stops its isolated temporary server on port 3100; it does not reuse an unrelated developer server.

Automated axe coverage is not full WCAG certification. Human Kiswahili wording, shared-device privacy, outdoor readability and real low-end Android performance still require user evidence.

---

## D1.3/D1.4: Live identity, MFA and tenant/project foundation

These are real database-backed foundation operations, not the `/sign-in` mock. Full phase acceptance remains open for the limitations in [implementation status](../IMPLEMENTATION_STATUS.md).

### Setup

Start local services, apply migrations and run API/web as above. Configure the auth/key settings described in [the API README](../../apps/api/README.md). `WEB_ORIGIN` must exactly match the browser origin: normally `http://localhost:3000`; `127.0.0.1` and other ports are different origins. Never copy production keys/data into development.

### Walkthrough

1. Open http://localhost:3000/foundation. Register a **synthetic** identity such as a unique `review-...@example.invalid`, with a test-only password of 12–128 characters.
2. Read its verification code in local Mailpit, http://localhost:8025. Phone-first identities use a `phone-<canonical-number>@development.invalid` mailbox, not real SMS.
3. Verify the identity, then sign in. Invalid/unverified credentials and codes remain errors; the UI does not auto-refresh or retry them.
4. Choose **Set up authenticator MFA**, add the temporary secret/URI to an authenticator, then confirm a six-digit code. Save the ten recovery codes securely; they appear once and are never stored in browser storage. Hide them after saving.
5. Create a company. A fresh MFA check is required; TOTP codes cannot be reused, including the enrollment code. After five minutes, verify a new authenticator code before privileged operations.
6. Create a project. Reload the workspace to verify it persists. Create/select another company and confirm the first company's projects disappear; switch back to recover the authorised view.
7. Invite a synthetic second identity with a role and project assignments. Its invitation arrives only in Mailpit, expires after 48 hours and is recipient-bound/single-use. Register/verify that identity separately, accept its token and select the company. Owner/Finance invitations also require enrolled/fresh MFA.
8. As an owner, load members and grant/revoke project view/manage access. The canonical permissions are `projects.view` and `projects.manage`; the API checks membership/project scope independently of controls. A member's effective project permissions are their role's permissions ∩ the assignment, so granting "manage" to a client still leaves them read-only.
9. Load the latest audit events. The UI shows event summaries, not raw sensitive diffs. The database refuses audit UPDATE/DELETE/TRUNCATE.
10. Inspect active sessions. Refresh explicitly, revoke another session or sign out; consumed refresh replay revokes the family. Revoking the current session returns to signed-out forms and clears workspace state.
11. Try the password-reset and MFA-recovery forms with synthetic credentials. Reset revokes sessions but preserves MFA; a recovery code works once and does not disable financial approval controls.
12. Switch EN/SW and light/dark. Disconnect the API or enter an invalid token and verify actionable errors, not saved-success fallbacks. The prototype tour remains separate and labelled.

### Evidence and remaining gates

Final local verification: 22 lint/type/unit/i18n/build tasks successful, formatting passed; 35 API integration tests and 8 browser/a11y tests passed. A separate real-browser smoke used the actual API, PostgreSQL runtime role and Mailpit to verify registration through MFA, company/project persistence, cross-company switching, audit/member views and logout. Its isolated database/message and helper servers were cleaned up.

External messaging providers, action-bound financial approvals and mobile binding are not presented as implemented. Passkeys, the password policy and the development SMS/WhatsApp channels arrived later in D1.3; see the next section. Financial/domain reviewer approval, coherent restore and field/mobile evidence remain required before any live pilot.

---

## D1.4: Roles and permissions

Permission-based RBAC with company custom roles ([ARCHITECTURE §8](../ARCHITECTURE.md#8-authorisation-rbac-with-project-scope)). Use synthetic identities only.

1. Sign in to `/foundation` as a company owner with MFA, load the workspace, then choose **Load roles and permissions**. The ten system roles show their permissions, scope (all projects or assigned projects), whether MFA is required and how many members hold them. System roles have no edit or delete buttons; the API refuses changes to them too.
2. Verify a fresh authenticator code (every role change needs MFA from the last five minutes). Under **Create a custom role**, name it (for example "Site clerk"), tick permissions grouped by area and save. Permissions marked "needs MFA" make MFA mandatory for every holder. `platform.admin` is never offered, and the API and database both reject it.
3. Edit the role: rename it or change its permissions. Try a duplicate name in a different case: the API answers with a conflict.
4. Load company members and use **Change a member's role** to move a member to the custom role. The member's sessions in this company are signed out at once; when they sign in again the new permissions apply. The audit log shows `role.created`, `role.updated` (added/removed permissions) and `membership.role_changed`.
5. Try to delete the role while the member still holds it: the request is refused. Move the member back, then delete it.
6. Create a custom role with **Manage roles and members**, **Invite people and assign projects** and **View projects**, and invite a second synthetic identity (with MFA) into it. Signed in as that person, the editor disables permissions they do not hold and the company-wide option, and only roles whose permissions they hold are offered. Attempts through the API to grant more, to change the owner or to edit a more powerful role are refused (403).
7. Try to change the last owner's role: refused (409). Adding a privileged permission to a role whose holder has no MFA, or giving such a member the Finance role, is also refused (409).
8. Switch to Kiswahili: the roles panel, permission names and notices are translated.

Checks: `pnpm --filter @pm-buddy/types test`, `pnpm --filter @pm-buddy/validation test`, `pnpm --filter @pm-buddy/api test`, `pnpm --filter @pm-buddy/api test:e2e` (`test/roles.e2e-spec.ts` runs under the real `pmb_app` role) and `pnpm --filter @pm-buddy/web test:e2e` (`test/foundation.spec.ts`, axe included).

Remaining: project assignments still carry only `projects.view`/`projects.manage` until later modules give other permissions project behaviour; approval limits per assignment arrive with the financial modules; Kiswahili permission wording needs a human review.

---

## D1.3: Passkeys, password policy and notification channels

Passkeys (WebAuthn) as an MFA factor and for step-up, a server-side password strength check with an optional breached-password lookup, and SMS/WhatsApp channels behind the notification provider ([ARCHITECTURE §7](../ARCHITECTURE.md#7-identity-authentication-and-sessions)). Synthetic identities only; nothing leaves the machine.

### Setup

As above. Open the web app at exactly the `WEB_ORIGIN` origin, normally **http://localhost:3000**: passkeys are bound to that hostname, and browsers refuse WebAuthn on IP addresses such as `127.0.0.1`. You need a passkey-capable browser and either a platform authenticator (Touch ID, Windows Hello, an Android or iOS screen lock), a security key, or Chrome DevTools' **WebAuthn** panel ("Enable virtual authenticator environment", then add a ctap2/internal authenticator with user verification).

### Walkthrough

1. **Password policy.** Register a synthetic identity with a guessable password such as `password12345678`, or one built from your own name and email: the form explains that it is too easy to guess (400, `password-too-weak`). A long passphrase works. With `AUTH_BREACHED_PASSWORD_CHECK=hibp` in `apps/api/.env`, a password known from breaches is refused with "found in a data breach"; only five characters of its SHA-1 leave the API, and an unreachable service lets the password through with a warning in the API log. The default is `off`. Switch to Kiswahili to see the same messages translated.
2. **SMS channel.** Register a phone identity (for example a synthetic `07…` number). Its verification code arrives in Mailpit (http://localhost:8025) addressed to `phone-2547…@development.invalid`, with the subject `[DEVELOPMENT ONLY][SMS] Verify your account`. No real SMS is sent.
3. **First passkey.** Verify and sign in a fresh synthetic account (no authenticator app). Within five minutes of signing in, type a name under **Passkeys** (for example "Site phone") and choose **Add passkey**. Complete the browser prompt (fingerprint, face, PIN or the virtual authenticator). The passkey appears in the list, the account now has MFA, the other sessions are signed out and **ten recovery codes are shown once**: save them, then hide them. Mailpit receives a "Passkey added" notice.
4. **Sign-in with a passkey as the second factor.** Sign out and sign in again with the password. MFA is now required: choose **Verify with a passkey** and complete the prompt. Load the workspace; the passkey shows when it was last used.
5. **Step-up.** Wait five minutes (or sign in again), then try a privileged action such as creating a company: it is refused until you verify a fresh MFA check. **Verify with a passkey** counts exactly like an authenticator code. Users with both factors can use either.
6. **Second passkey.** After a fresh step-up, add another passkey (a different authenticator, or a second virtual one). Adding a factor never works with a password alone: once an account has a factor, the API demands a fresh MFA check first. Names must be unique per account; ten passkeys at most.
7. **Privileged role.** As a company owner, invite the passkey-only account as **Finance**. It can accept the invitation (after a fresh passkey check) because a passkey satisfies MFA-required permissions, in the API and in the database trigger.
8. **Removal.** As the Finance member, after a fresh step-up, remove one passkey: allowed while another factor remains. Removing the **last** one is refused ("conflicts with current state"); the database refuses it too. An account without an MFA-required permission may remove its last passkey and goes back to having no MFA.
9. **Cancelled prompts and lockout.** Cancel the browser prompt: the page says the prompt was cancelled, nothing is sent to the API and nothing changes. Assertions that reach the API and fail verification (replayed, expired or superseded challenges, wrong origin, bad signature, counter regression) count toward the MFA lockout like wrong authenticator codes: five in a row lock two-step verification for 15 minutes, sign the session out and send "Two-step verification locked". A normal browser does not produce such assertions, so the API tests below demonstrate this.

### Checks

`pnpm --filter @pm-buddy/api test:e2e` runs `test/passkeys.e2e-spec.ts` (a software ES256 authenticator produces real `none`-attestation registrations and signed assertions; nothing in the WebAuthn verification is mocked), `test/passwords.e2e-spec.ts` (fake breach checker, no network) and the Mailpit email and SMS-channel tests in `test/identity.e2e-spec.ts`. `pnpm --filter @pm-buddy/web test:e2e` runs `test/passkeys.spec.ts`, which drives Chromium's virtual authenticator through registration, step-up, a cancelled prompt and removal against a mocked API, plus EN/SW password refusals, all with axe.

### Known limits

No real SMS, WhatsApp or email provider (Africa's Talking is D7.3). No passwordless or usernameless passkey sign-in, attestation checks or authenticator allow-lists. Passkey changes send notifications but are not in a company's audit log. The breached-password check is optional and fails open. Kiswahili wording needs a human review.
