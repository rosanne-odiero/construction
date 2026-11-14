# Phase 1 identity and tenancy API

Base: `/api/v1`, same-origin browser requests with `credentials: "include"`.

Before starting the development API, put a random 32-byte key in `apps/api/.env`
as `AUTH_MFA_ENCRYPTION_KEY=<64 hex characters>`; generate with
`node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
Labourer field encryption (D3.1) needs two more local-only values in the same file:
`FIELD_ENCRYPTION_KEYS=1:<64 hex characters>` (generate with
`node -e "console.log('1:' + require('node:crypto').randomBytes(32).toString('hex'))"`)
and a different `FIELD_BLIND_INDEX_KEY=<64 hex characters>`; see
[CONFIGURATION §8](../../docs/CONFIGURATION.md#8-process-environment-deployment-settings).
Do not commit this file or reuse a test key. Missing keys fail startup rather than
silently using a public development secret. Tests generate their own isolated keys.
Production also requires `AUTH_SIGNING_PRIVATE_KEY` (base64-encoded Ed25519 PKCS8
PEM), an HTTPS `WEB_ORIGIN`, and an approved notification provider before
notification-dependent workflows can be enabled. Development signing keys are
ephemeral; after an API restart, refresh the persisted session to obtain a new
access token.

1. `GET /auth/csrf` → `{ csrfToken }`, sets an HttpOnly CSRF cookie.
2. Every mutation sends `Origin: <WEB_ORIGIN>` and `X-CSRF-Token: <csrfToken>`.
3. Login issues HttpOnly access and rotating refresh cookies. Development cookie names:
   `pmb_at`, `pmb_rt`, `pmb_csrf`; production uses `__Host-pmb_at`,
   `__Secure-pmb_rt`, `__Host-pmb_csrf` and Secure.
4. On access expiry, `POST /auth/refresh {}` rotates refresh credentials; retry the
   original request once. Reusing an old refresh token revokes its entire session family.
5. Authentication responses are `{ user: { id, identifier, displayName, verified,
mfaEnabled, totpEnabled, passkeys }, session: { id, tenantId, mfaVerified, expiresAt },
mfaRequired }`. `mfaEnabled` means at least one MFA factor (an authenticator app or a
   passkey); `passkeys` is the number of registered passkeys.
   A password-only session can enrol/verify MFA but cannot enter tenants when MFA is required.
   Access expires after ten minutes, idle refresh after thirty minutes; absolute
   sessions last 24 hours, shortened to eight hours for MFA-enrolled accounts.
   Replaying a refresh credential also sends a development security alert.

| Method/path                              | Body                                     | Response                                                                     |
| ---------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------- |
| POST auth/register                       | `{identifier,password,displayName}`      | `{message}`                                                                  |
| POST auth/verify                         | `{identifier,code,password}`             | `{message}`                                                                  |
| POST auth/verification/resend            | `{identifier}`                           | `{message}`                                                                  |
| POST auth/login                          | `{identifier,password}`                  | authentication response                                                      |
| GET auth/me                              | —                                        | authentication response                                                      |
| POST auth/refresh                        | `{}`                                     | authentication response                                                      |
| POST auth/logout                         | `{}`                                     | `{message}`                                                                  |
| POST auth/mfa/enroll                     | `{}`                                     | `{secret,uri}`                                                               |
| POST auth/mfa/verify                     | `{code}`                                 | authentication response plus `recoveryCodes` (shown once)                    |
| POST auth/mfa/step-up                    | `{code}`                                 | authentication response                                                      |
| POST auth/mfa/recover                    | `{code}`                                 | authentication response                                                      |
| GET auth/passkeys                        | —                                        | `{passkeys:[{id,name,createdAt,lastUsedAt,backedUp,deviceType}]}`            |
| POST auth/passkeys/registration/options  | `{}`                                     | `{options}` (WebAuthn creation options; single-use challenge, 5 minutes)     |
| POST auth/passkeys/registration          | `{name,credential}`                      | 201: authentication response plus `passkey` (and `recoveryCodes`, see below) |
| DELETE auth/passkeys/:id                 | —                                        | `{message}` (fresh MFA; 409 for a privileged user's last factor)             |
| POST auth/passkeys/step-up/options       | `{}`                                     | `{options}` (WebAuthn request options for the account's passkeys)            |
| POST auth/passkeys/step-up               | `{credential}`                           | authentication response (MFA verified, like `mfa/step-up`)                   |
| POST auth/password/forgot                | `{identifier}`                           | `{message}` (always generic)                                                 |
| POST auth/password/reset                 | `{token,password}`                       | `{message}`                                                                  |
| GET auth/providers                       | —                                        | `{google}`: whether "Continue with Google" is configured                     |
| GET auth/google/start?next=              | —                                        | 303 to Google (or `/sign-in?google=unavailable`); see below                  |
| GET auth/google/callback                 | — (Google's redirect)                    | 303 to `/sign-in`; see below                                                 |
| GET auth/sessions                        | —                                        | `{sessions:[{id,createdAt,lastSeenAt,expiresAt,current}]}`                   |
| DELETE auth/sessions/:id                 | —                                        | `{message}`                                                                  |
| GET tenants                              | —                                        | `{tenants:[{id,name,role,roleName,tenantWide,permissions}]}`                 |
| POST tenants                             | `{name}`                                 | `{tenant:{id,name}}` (fresh MFA required; selects new tenant)                |
| POST tenants/:id/select                  | `{}`                                     | authentication response (rotates cookies)                                    |
| GET tenants/current/members              | —                                        | `{members}`                                                                  |
| POST tenants/current/invitations         | `{identifier,role,projectIds?:string[]}` | `{invitation:{id,identifier,role,roleName,expiresAt}}`                       |
| POST tenants/invitations/accept          | `{token}`                                | `{message}`                                                                  |
| DELETE tenants/current/members/:userId   | —                                        | `{message}`                                                                  |
| GET tenants/current/audit                | —                                        | `{events}` (most recent 100)                                                 |
| GET permissions                          | —                                        | `{areas:[{area,permissions:[{key,mfaRequired,projectScoped,assignable}]}]}`  |
| GET tenants/current/roles                | —                                        | `{roles:[role]}` (system and custom)                                         |
| POST tenants/current/roles               | `{name,permissions,tenantWide?}`         | `{role}`                                                                     |
| PATCH tenants/current/roles/:id          | `{name?,permissions?,tenantWide?}`       | `{role}` (custom roles only)                                                 |
| DELETE tenants/current/roles/:id         | —                                        | `{message}` (unused custom roles only)                                       |
| PUT tenants/current/members/:userId/role | `{role}`                                 | `{message}`; revokes the member's sessions in this company                   |

Projects, sites, geofences, WBS, milestones and team (D2.1; design in
[ARCHITECTURE §4.1](../../docs/ARCHITECTURE.md#41-projects-module-d21)). Mutations that
change an existing record send the `version` they read; a newer one is a 409
`version-conflict`.

| Method/path                                      | Body                                                                                                                                                                  | Response                                                                          |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| GET projects?status=&search=                     | —                                                                                                                                                                     | `{projects:[project]}` (projects the caller may view)                             |
| POST projects                                    | `{name, code?, description?, clientName?, clientEmail?, clientPhone?, contractSumMinor?, contractType?, startDate?, endDate?, county?, town?, latitude?, longitude?}` | 201 `{project}`; starts in `planning`; `code` defaults to the next `PRJ-NNN`      |
| GET projects/:id                                 | —                                                                                                                                                                     | `{project, permissions, siteCount, activationGaps, history}`                      |
| PATCH projects/:id                               | any project field, plus `version`                                                                                                                                     | `{project}` (`code` only while planning)                                          |
| POST projects/:id/status                         | `{to, reason?, version}`                                                                                                                                              | `{project}`; 409 `invalid-transition`, `reason-required`, `activation-incomplete` |
| GET projects/:id/sites                           | —                                                                                                                                                                     | `{sites:[site]}` with the geofence in force                                       |
| POST projects/:id/sites                          | `{name, address?, geofence}`                                                                                                                                          | 201 `{site}` (geofence version 1)                                                 |
| PATCH projects/:id/sites/:siteId                 | `{name?, address?, version}`                                                                                                                                          | `{site}`                                                                          |
| PUT projects/:id/sites/:siteId/geofence          | `{geofence, currentVersion}`                                                                                                                                          | `{site}` with a new geofence version; 409 if `currentVersion` is not the latest   |
| GET projects/:id/sites/:siteId/geofences?at=     | —                                                                                                                                                                     | `{versions}` newest first, or only the version in force at `at`                   |
| GET projects/:id/wbs                             | —                                                                                                                                                                     | `{nodes, weights:{complete, groups}, progress}` (`progress` null = unavailable)   |
| POST projects/:id/wbs                            | `{code, name, parentId?, weightBasisPoints?}`                                                                                                                         | 201 `{node}`                                                                      |
| PATCH projects/:id/wbs/:nodeId                   | `{code?, name?, parentId?, weightBasisPoints?, version}`                                                                                                              | `{node}`                                                                          |
| PUT projects/:id/wbs/order                       | `{parentId, nodeIds}` (every sibling, in order)                                                                                                                       | WBS response                                                                      |
| DELETE projects/:id/wbs/:nodeId                  | —                                                                                                                                                                     | `{message}` (leaf items without milestones)                                       |
| GET projects/:id/milestones                      | —                                                                                                                                                                     | `{milestones}`                                                                    |
| POST projects/:id/milestones                     | `{name, dueDate, wbsNodeId?}`                                                                                                                                         | 201 `{milestone}`                                                                 |
| PATCH projects/:id/milestones/:milestoneId       | `{name?, dueDate?, wbsNodeId?, version}`                                                                                                                              | `{milestone}`                                                                     |
| POST projects/:id/milestones/:milestoneId/status | `{to, reason?, actualDate?, version}`                                                                                                                                 | `{milestone}`                                                                     |
| DELETE projects/:id/milestones/:milestoneId      | —                                                                                                                                                                     | `{message}` (planned milestones only)                                             |
| GET projects/:id/team                            | —                                                                                                                                                                     | `{members, candidates, canAssign, grantable}`                                     |
| PUT projects/:id/members/:userId                 | `{permissions:string[]}`                                                                                                                                              | `{message}`                                                                       |
| DELETE projects/:id/members/:userId              | —                                                                                                                                                                     | `{message}`                                                                       |

A `geofence` is `{kind:"radius", center:{lat,lng}, radiusM}` (20–5,000 m) or
`{kind:"polygon", vertices:[{lat,lng}, …]}` (3–100 distinct vertices, no repeated closing
vertex, no crossing edges, 100 m²–25 km²). Every point must be inside Kenya's bounding box
(latitude −5 to 5.5, longitude 33.5 to 42). Coordinates are rounded to six decimals. The
validation and the area/perimeter maths are `packages/domain` (`validateGeofence`,
`geofenceMetrics`), shared with the web editor; failures are 400 problems whose field
messages are stable issue codes (`self_intersecting`, `closing_vertex_repeated`,
`coordinate_out_of_bounds`, `area_too_small`, …). Geofence versions are append-only: the
database numbers them and sets `effective_from`; nothing can update or delete one.

Identifiers accept email or Kenyan mobile numbers and are normalized. Passwords are
12–128 characters; common passwords are rejected. Every new password (registration and
reset) must also reach a zxcvbn-ts score of 3 or more, judged with the identifier, display
name and "pm-buddy" as context (`@zxcvbn-ts/core` with the common and English dictionaries;
only the first 64 characters are scored). With `AUTH_BREACHED_PASSWORD_CHECK=hibp` it is also
looked up in Have I Been Pwned's range API (k-anonymity: only the first five hex characters
of its SHA-1 are sent, with `Add-Padding: true`, two-second timeout); a failed lookup logs a
warning without the password or hash and accepts the password (fails open). Refusals are 400
problems with code `password-too-weak` or `password-breached`, and no score or match details.
Verification uses six-digit,
five-minute single-use codes; reset and invitation credentials are opaque single-use
tokens. These credentials are **never returned by the API**. Development/test
notifications go only to local Mailpit (`http://localhost:8025`). Delivery goes through a
`NotificationProvider` (`src/modules/notifications`) with `email`, `sms` and `whatsapp`
channels: email identifiers use email, phone identifiers use SMS. The development provider
puts every channel in Mailpit; SMS and WhatsApp messages go to a synthetic
`phone-<number>@development.invalid` inbox with a `[DEVELOPMENT ONLY][SMS]` or
`[DEVELOPMENT ONLY][WHATSAPP]` subject prefix. No real SMS, WhatsApp (Africa's Talking
arrives in D7.3), identity-provider, mobile device-binding, or biometric integration is claimed.
The development provider uses Mailpit's documented HTTP send API over fixed
loopback, with redirects forbidden and a three-second timeout. It does not release
or relay messages. `AUTH_NOTIFICATION_TRANSPORT=development` is forbidden in
production; `disabled` (the default) fails notification-dependent operations explicitly.
Deliveries run after the response (`notifyLater`), so neither status nor timing reveals
whether an account exists.

Passkeys (WebAuthn, `@simplewebauthn/server`) are an MFA factor next to TOTP. The relying
party is `WEB_ORIGIN`: its exact origin, and its hostname as RP ID. Registration and step-up
demand user verification; attestation is `none`; EdDSA, ES256 and RS256 keys are accepted.
Challenges are random, stored server-side as SHA-256 digests in `auth_challenges`, bound to
the user and the session that asked for them, single-use (a new request supersedes the
previous one) and valid for five minutes. Credential IDs are unique across accounts; the
signature counter must increase unless the authenticator always reports zero. `credential`
in the request bodies is the JSON that `@simplewebauthn/browser` returns
(`passkeyRegistrationRequestSchema`, `passkeyAuthenticationRequestSchema`).

- Adding a passkey (or TOTP) needs a sign-in within five minutes; once the account has an MFA
  factor it needs MFA verified within five minutes instead, so a password alone never adds a
  factor. Up to ten named passkeys per account (names unique per account).
- The first factor of an account signs out its other sessions, marks this session MFA-verified
  and, when the account has no unused recovery codes, returns ten one-time `recoveryCodes`.
- `POST auth/passkeys/step-up` sets the session's MFA time exactly like `POST auth/mfa/step-up`
  and shares its lockout: unknown, replayed or expired challenges, wrong origins or RP IDs, bad
  signatures, counter regressions and missing user verification all count as failures; the
  fifth in a row locks MFA for 15 minutes, revokes the session and notifies the user.
- Removing a passkey needs MFA verified within five minutes. Removing the last factor of
  someone holding an MFA-required permission is refused (409); the database enforces it too.
- `users.mfa_enabled` ("has at least one factor") is maintained by the `user_mfa` trigger from
  the TOTP secret and `webauthn_credentials`, so passkey-only users satisfy the privileged-MFA
  triggers. Adding or removing a passkey sends a security notification.

A `role` in requests and responses is a system role key (`owner`, `project_manager`,
`site_agent`, `foreman`, `quantity_surveyor`, `storekeeper`, `finance`, `client`,
`consultant`, `supplier`) or the ID of a company custom role; `roleName` is the custom
role's name or null. A `role` object is `{kind:"system"|"custom", id, name,
permissions, tenantWide, mfaRequired, memberCount, assignable}` (custom roles add
`createdAt`/`updatedAt`); `assignable` says whether the caller holds every permission
in it. Platform administrator (`platform_admin`, `platform.admin`) is never assignable.

Authorisation is permission-based ([ARCHITECTURE §8](../../docs/ARCHITECTURE.md#8-authorisation-rbac-with-project-scope),
`AccessPolicy`): members `users.invite` or `roles.manage`; invitations and project
assignments `users.invite`; member removal, member role changes and custom-role changes
`roles.manage`; audit `audit.view`; project creation `projects.create`; project reads
`projects.view` and project changes (details, status, sites, geofences, WBS, milestones)
`projects.manage` on that project; project assignments also `projects.manage` on the
project. The member list, invitations, assignments, removals, role changes, audit and
project creation need MFA verified within five minutes; without it the API answers 403 with
code `step-up-required`. Nobody can grant,
change or remove a role (or project permission) carrying permissions they do not hold;
system roles are immutable; roles in use or named in pending invitations cannot be
deleted; the last owner cannot be removed or demoted. Anyone holding an MFA-required
permission (`payroll.approve`, `payments.approve`, `payments.disburse`,
`payments.reverse`, `finance.manage`, `config.manage_statutory`, `roles.manage`,
`tenancy.manage`) must have enrolled MFA, verified this session, before entering the
company or accepting an invitation; the database enforces the same rule.

Only the selected tenant in a persisted session sets database context. Tenant-owned
queries run inside transactions with transaction-local tenant/user/request settings.
RLS is forced for the non-owner `pmb_app` runtime role; project access additionally
requires explicit permissions. Audit entries are append-only and hash chained in
serialized tenant transactions.
Assignable project permissions are the shared catalogue's project-scoped permissions
(`PROJECT_ASSIGNABLE_PERMISSIONS` in `packages/types`: `projects.*`, `bq.*`, `labour.*`,
`attendance.*`, `payroll.prepare`/`review`, `procurement.requisition`/`approve`,
`stores.manage`, `finance.view`, `site.diary`/`photos`, `quality`/`safety`/`plant`/
`documents.manage`, `reports.view`).
Company-wide roles (`owner`, `finance`, custom roles marked company-wide) act on every
project; other roles act only on assigned projects with role ∩ assignment. Self-membership
discovery (including the custom role the user holds) and verified-recipient invitation
discovery are narrowly scoped RLS bootstrap exceptions before selecting a tenant.

All foundation response contracts are exported from `@pm-buddy/validation`:
`csrfResponseSchema`, `authResponseSchema`, `messageResponseSchema`,
`mfaEnrollmentResponseSchema`, `mfaVerificationResponseSchema`,
`sessionsResponseSchema`, `tenantsResponseSchema`, `tenantCreatedResponseSchema`,
`projectsResponseSchema`, `projectResponseSchema`, `invitationResponseSchema`,
`membersResponseSchema`, `auditEventsResponseSchema`, `permissionCatalogueResponseSchema`,
`rolesResponseSchema`, `roleResponseSchema`, `passkeysResponseSchema`,
`passkeyRegistrationOptionsResponseSchema`, `passkeyAuthenticationOptionsResponseSchema` and
`passkeyRegistrationResponseSchema`, and the request schemas `createRoleRequestSchema`,
`updateRoleRequestSchema`, `memberRoleRequestSchema`, `roleReferenceSchema`,
`passkeyRegistrationRequestSchema` and `passkeyAuthenticationRequestSchema`. Their inferred TypeScript types are exported too, along with
`tenantRoleSchema`, `permissionSchema`, `tenantPermissionSchema`, `projectPermissionSchema`,
`TenantRole`, `ProjectPermission`, and the project entity's `projectSchema`/`Project`. The
D2.1 request and response schemas (projects, status changes, sites, geofences, WBS,
milestones, team) are in `packages/validation/src/projects.ts`.
These modules are browser-safe and do not import API/server code.

Errors use the existing RFC 9457 `application/problem+json` envelope. Invalid input:
400; invalid/missing auth: 401; authorization/CSRF/MFA: 403; conflicts: 409; throttling:
429; unavailable notification/database/rate-limit dependency: explicit 503/500. Some 400s
carry a more specific `code`: `password-too-weak`, `password-breached` and `passkey-invalid`
(a registration response that failed verification).

## Continue with Google

OpenID Connect authorisation code flow with PKCE (S256), `state` and `nonce`, using
`openid-client@6.8.9` (by the `jose` author; adds `oauth4webapi@3.8.8`). It is off until
`AUTH_GOOGLE_CLIENT_ID` and `AUTH_GOOGLE_CLIENT_SECRET` are both set in `apps/api/.env`
(never committed). In Google Cloud Console create an OAuth client of type **Web application**
and register this **Authorized redirect URI**: `${WEB_ORIGIN}/api/v1/auth/google/callback`
(for example `http://localhost:3000/api/v1/auth/google/callback`). Google returns the browser
to the web origin, which proxies `/api/*` here, so cookies stay first-party.

1. `auth/google/start` stores state, nonce, the PKCE verifier and `next` in an encrypted
   (A256GCM), HttpOnly, SameSite=Lax cookie (`pmb_oauth`; production `__Secure-pmb_oauth`,
   path `/api/v1/auth/google`, 10 minutes) and redirects to Google with
   `scope=openid email profile` and `prompt=select_account`.
2. `auth/google/callback` clears that cookie first (a callback URL works once), exchanges the
   code and validates the ID token: issuer, audience, expiry, nonce and the signature against
   Google's published keys.
3. Only addresses Google is authoritative for are accepted: a verified `@gmail.com` /
   `@googlemail.com`, or a verified Google Workspace address whose `hd` claim equals the email
   domain. Anything else returns `?google=email-unsupported`.
4. The account is found by Google's stable subject (`user_identities`). Otherwise an account
   with the same email is linked automatically: a verified account receives an emailed
   notice; an unverified pending registration becomes verified and its password is replaced
   (pre-hijacking defence). Otherwise a new verified account is created with no usable
   password (`password/forgot` can set one). An email already linked to another Google
   account returns `?google=account-conflict`.
5. A normal session is issued (same lifetimes as password sign-in) and the browser returns to
   `/sign-in?next=…`, which resumes it. **PM-Buddy MFA still applies**: accounts with a factor
   or an MFA-required role must verify TOTP, a passkey or a recovery code before company
   access. Google sign-in does not reset password-lockout counters.

Failures return to `/sign-in?google=<cancelled|unavailable|rate-limited|email-unsupported|
account-conflict|failed>`; nothing about the code, tokens or claims is logged. `next` is
passed through unchanged; the web app's `safeNextPath` sanitises it. The web app shows the
button on `/sign-in` and on the account console's **Create account** card (`/foundation`),
only while `GET auth/providers` reports `google: true`. `AUTH_GOOGLE_ISSUER` is a
test-only override (loopback HTTP allowed, refused in production) used by
`test/google.e2e-spec.ts` with the local `test/fake-google.ts` provider.

## Portals: client, labourer and staff (owner request, 11/11/2026)

One sign-in page routes each person by their selected company's permissions
(`portalFor`, `packages/types`): staff → office app, `portal.client` only → `/portal`,
`portal.worker` only → `/worker`. The `labourer` system role holds only `portal.worker`;
`portal.client` and `portal.worker` are project-assignable (migration `20261116110000_portals`,
which also gives existing client assignments `portal.client`).

| Method/path                             | Body                                    | Response / access                                                                                                               |
| --------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| GET portal/client/projects              | —                                       | `{company, projects}`: assigned projects with milestone counts; `portal.client`                                                 |
| GET portal/client/projects/:id          | —                                       | `{project, milestones, diaries}`: **approved** diaries only (30 newest); `portal.client` on the project, otherwise 403/404      |
| GET portal/worker                       | —                                       | `{displayName, company, assignments:[{project, sites}], attendance:null, pay:null}`; `portal.worker`                            |
| POST projects/:id/labourers/invitations | `{identifier}` (Kenyan mobile)          | 201 `{invitation}`; `labour.manage` on the project; 409 `already-member`                                                        |
| POST auth/pin/login                     | `{identifier, pin}`                     | authentication response (PIN session)                                                                                           |
| POST auth/pin/join                      | `{identifier, token, displayName, pin}` | authentication response, company selected; 400 `pin-too-weak`, 401 invalid invitation, 409 `account-exists`                     |
| POST auth/pin/reset                     | `{token, pin}`                          | `{message}`; token from `auth/password/forgot` (PIN accounts get an SMS link to `/worker/pin?token=…`); signs out every session |

Labourer invitations (from this endpoint, or the general invitation with role `labourer`, which
refuses email identifiers with `labourer-phone-required`) send an SMS link to
`${WEB_ORIGIN}/worker/join?token=…`, valid 48 hours. Joining creates the verified account, sets
the PIN, joins the company and assigns the project in one transaction; a pending password
registration for the number is taken over and its password discarded. The account has no
usable password until `auth/password/reset` sets one.

PINs are six digits, Argon2id-hashed, and refuse repeated digits/pairs/triples, runs up or down
and the last six digits of the phone (`pinProblem`, `packages/domain`). PIN sign-in shares the
five-failure, 15-minute lockout and is limited per number (10 per 5 minutes, 30 per day).
**PIN sessions are limited to the labourer portal:** any company request whose role is not
worker-only gets 403 `pin-session-limited`, and PIN sessions cannot enrol MFA factors, create
companies or accept staff invitations. Sessions record `auth_method` (`password`, `google`, `pin`).

Site-diary lists now need `site.diary`, `quality.manage`, `projects.manage` or `reports.view`
in addition to `projects.view`, so clients (who hold `projects.view`) see diaries only through
their portal, approved ones only. Production SMS delivery still waits for D7.3 (Africa's
Talking); in development, invitation and PIN-reset SMS go to Mailpit.

## Quality (D6.1)

Project paths are relative to `/api/v1/projects/:projectId/quality`; company paths start with
`/api/v1/quality`. Authentication, the selected company and the CSRF guard apply; permissions
are the project's (role ∩ assignment). Reads need `projects.view` plus one of `quality.manage`,
`site.diary`, `site.photos`, `projects.manage`, `reports.view` or `safety.manage` (clients and
suppliers get 403). Every change sends the `version` it read (409 `version-conflict`); closed and
cancelled projects are read-only (409 `project-read-only`). Lists take `cursor`, `limit` (1–100,
default 30) and `search` (a number such as `12` or `SNG-0012`, or text).

| Method / path                                                      | Input                                                                                                                                                                                        | Result / permission                                                                                                           |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| GET `/summary`                                                     | —                                                                                                                                                                                            | Counts: inspections, overdue and failed cube sets, failed slump tests, snags, completion state and DLP end                    |
| GET / POST `/inspections`                                          | `status?`, `result?` / `{siteId, templateId, location, inspectorType, inspectorName?, inspectedOn, notes?, wbsNodeId?, scheduleActivityId?, bqItemLineageId?}`                               | `{inspections, nextCursor, permissions}` / 201 `{inspection, items, snags}`; create: `site.diary` or `quality.manage`         |
| GET / PATCH `/inspections/:id`                                     | — / `{version, location?, inspectorType?, inspectorName?, inspectedOn?, notes?, wbsNodeId?, scheduleActivityId?, bqItemLineageId?, items?: [{id, result, note, photoIds}]}`                  | `{inspection, items, snags}`; PATCH by the author, draft only                                                                 |
| POST `/inspections/:id/actions`                                    | `{action: submit / sign_off / return, version, reason?}`                                                                                                                                     | Submit: the author; sign-off and return (reason): `quality.manage`, not the creator or submitter                              |
| GET / POST `/snags`                                                | `status?` (`open`, `fixed`, `closed`, `active`), `severity?`, `phase?` / `{siteId, location, description, severity, responsibleKind, responsibleName, dueOn?, inspectionItemId?, photoIds?}` | `{snags, nextCursor, counts, permissions}` / 201 `{snag}`; create: `site.diary` or `quality.manage`                           |
| GET / PATCH `/snags/:id`                                           | — / `{version, location?, description?, severity?, responsibleKind?, responsibleName?, dueOn?}`                                                                                              | `{snag}`; PATCH: `quality.manage`, open snags only                                                                            |
| POST `/snags/:id/actions`                                          | `{action: fix / close / reopen, version, note?, photoIds?, reason?}`                                                                                                                         | `{snag}`; fix (note and photos): `site.diary` or `quality.manage`; close and reopen (reason): `quality.manage`, not the fixer |
| GET / POST `/cubes`                                                | `filter?` (`all`, `overdue`, `failed`) / `{siteId, element, concreteClass, castOn, cubesPerAge?, batchReference?, notes?}`                                                                   | `{cubeSets, nextCursor, counts, permissions}` / 201 `{cubeSet, history}`                                                      |
| GET `/cubes/:id`; POST `/cubes/:id/results`                        | — / `{ageDays: 7 or 28, testedOn, strengths: ["25.5", …], laboratory?, reportReference?}`                                                                                                    | `{cubeSet, history}`; one original result per age                                                                             |
| POST `/cubes/:id/results/:resultId/corrections`                    | `{testedOn, strengths, laboratory?, reportReference?, reason}`                                                                                                                               | `{cubeSet, history}`; `quality.manage`; supersedes the original once                                                          |
| POST `/cubes/:id/void`                                             | `{version, reason}`                                                                                                                                                                          | `{cubeSet, history}`; `quality.manage`                                                                                        |
| GET / POST `/slump-tests`; GET `/slump-tests/:id`                  | `outcome?` / `{siteId, testedOn, element, concreteClass?, cubeSetId?, targetMm, toleranceMm, measuredMm, notes?}`                                                                            | `{slumpTests, nextCursor, permissions}` / 201 `{slumpTest, history}`                                                          |
| POST `/slump-tests/:id/corrections`                                | the test fields plus `reason`                                                                                                                                                                | `{slumpTest, history}`; `quality.manage`                                                                                      |
| GET / POST `/completion`                                           | — / `{kind: practical / final, completionDate, dlpMonths? (practical), exceptionReason?, notes?}`                                                                                            | `{practical, final, history, dlp, readiness, defaultDlpMonths, permissions}`; propose: `projects.manage`                      |
| POST `/completion/:id/actions`                                     | `{action: certify / withdraw, version, reason?}`                                                                                                                                             | Certify: `quality.manage`, not the proposer; withdraw (reason): `projects.manage`                                             |
| GET / POST `/api/v1/quality/templates`                             | `includeRetired?` / `{name, category, description?, items: [{text}]}`                                                                                                                        | `{templates, permissions}` / 201 `{template, history}`; read: any quality reader; create: `quality.manage` on some project    |
| POST `/api/v1/quality/templates/starter`                           | `{language: en / sw}`                                                                                                                                                                        | `{created}`: the seven starter templates (existing names skipped)                                                             |
| GET `/api/v1/quality/templates/:id`; POST `…/versions`, `…/retire` | — / template content plus `expectedVersion` / `{expectedVersion}`                                                                                                                            | `{template, history}`; a revision or retirement appends the next version                                                      |
| GET / PUT `/api/v1/quality/settings`                               | — / `{dlpMonths, cubeOverdueGraceDays, version}`                                                                                                                                             | `{settings}`; read: any quality reader; change: `config.manage`                                                               |

Diary workforce: `GET /api/v1/projects/:projectId/diaries/attendance?siteId=&date=` previews the
attendance snapshot (by trade, total, muster state); diaries created or edited with
`workforceSource: "attendance"` store it, and submitting refreshes it (the version advances by
two). The database recomputes the snapshot and refuses a forged one.

Rules: cube results follow `KE-CUBE-1` and slump tests `KE-SLUMP-1` (COMPLIANCE-REVIEW
CR-QA-01/02, ARCHITECTURE §4.7); the defects liability period defaults to 6 months (1–24,
CR-QA-03). Results, template versions and certified, signed-off or closed records are immutable
in the database. Problem codes are listed in ARCHITECTURE §4.7.

## Schedule (D6.2)

All paths are relative to `/api/v1/projects/:projectId/schedule`; authentication, the selected company and the CSRF guard apply. Reads need `projects.view` and every change `projects.manage` on the project (role ∩ assignment); closed and cancelled projects are read-only (409 `project-read-only`). Design: [ARCHITECTURE §4.6](../../docs/ARCHITECTURE.md#46-schedule-d62).

| Method / path                                | Input                                                                                                                       | Result                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET                                          | `baselineId?`                                                                                                               | The computed schedule: calendar, start, data date, items (tasks and milestones with planned, late and actual dates, float, critical flag, baseline dates, variance, progress, `permissions`), dependencies (driving, critical), finish, compared baseline, project variance, items removed since the baseline, duration-weighted progress, schedule `permissions` |
| PUT `/calendar`                              | `{workingWeekdays, includePublicHolidays, version}` (version 0 the first time)                                              | `{calendar}`                                                                                                                                                                                                                                                                                                                                                      |
| POST `/activities`                           | `{code, name, durationDays, wbsNodeId?, bqItemLineageId?, startNoEarlierThan?}`                                             | 201 `{item}`                                                                                                                                                                                                                                                                                                                                                      |
| PATCH `/activities/:activityId`              | any of the above plus `version`                                                                                             | `{item}`                                                                                                                                                                                                                                                                                                                                                          |
| PUT `/activities/:activityId/progress`       | `{version, actualStart, actualFinish, basis, percentComplete?}` or quantities `{quantityDone, quantityTotal, quantityUnit}` | `{item}`                                                                                                                                                                                                                                                                                                                                                          |
| DELETE `/activities/:activityId?version=`    | —                                                                                                                           | `{message}`; unstarted and not in the delay log only                                                                                                                                                                                                                                                                                                              |
| POST `/dependencies`                         | `{predecessor: {kind, id}, successor: {kind, id}, type, lagDays}` (`kind` `task` or `milestone`)                            | 201 `{dependency}`; 409 `schedule-cycle`, `dependency-exists`, `milestone-cancelled`                                                                                                                                                                                                                                                                              |
| PATCH / DELETE `/dependencies/:dependencyId` | `{type?, lagDays?, version}` / `?version=`                                                                                  | `{dependency}` / `{message}`                                                                                                                                                                                                                                                                                                                                      |
| GET / POST `/baselines`                      | — / `{name, reason}`                                                                                                        | `{baselines, permissions}` / 201 `{baseline, items}`                                                                                                                                                                                                                                                                                                              |
| GET `/baselines/:baselineId`                 | —                                                                                                                           | `{baseline, items}`                                                                                                                                                                                                                                                                                                                                               |
| GET / POST `/delays`                         | — / `{cause, startDate, endDate, workingDaysLost, description, activityIds, siteDiaryId?, claimFlag?}`                      | `{delays, totals, permissions}` / 201 `{delay, history}`                                                                                                                                                                                                                                                                                                          |
| GET `/delays/:delayId`                       | —                                                                                                                           | `{delay, history}` (every version, newest first)                                                                                                                                                                                                                                                                                                                  |
| POST `/delays/:delayId/amend`, `/withdraw`   | the delay content plus `{version, reason}` / `{version, reason}`                                                            | `{delay, history}`                                                                                                                                                                                                                                                                                                                                                |

Planned dates are computed on every read (CPM at today's Nairobi date) and never stored. Baselines and delay versions are append-only in the database. Problem codes are listed in ARCHITECTURE §4.6.

## Site photos (D6.1, Phase 6 increment 2)

| Method / path                                       | Input                                                              | Result / permission                                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| GET `projects/:projectId/photos`                    | `siteId?`, `diaryId?`, `cursor?`, `limit?` (1–60, default 24)      | `{photos, nextCursor}`; `projects.view` plus `site.photos`, `site.diary`, `quality.manage`, `projects.manage` or `reports.view` |
| POST `projects/:projectId/photos`                   | multipart: `file` (JPEG ≤ 15 MB), `siteId`, `diaryId?`, `caption?` | 201 `{photo}`; `site.photos`; closed/cancelled projects read-only                                                               |
| GET `projects/:projectId/photos/:photoId/thumbnail` | —                                                                  | JPEG ≤ 960 px, no metadata; same read access                                                                                    |
| GET `projects/:projectId/photos/:photoId/original`  | —                                                                  | The uploaded JPEG, byte for byte; same read access                                                                              |

The position and capture time come **only from the photo's EXIF** (`photo-metadata.ts`,
`exif-reader@2.0.3` on the EXIF block extracted by `sharp@0.35.5`): capture time prefers the
camera time with its offset, then the GPS clock, then camera time assumed to be Nairobi
(`timeSource: assumed_nairobi`). `verifyPhotoEvidence` (`packages/domain`) checks the location
against the site's geofence version in force at capture (30 m tolerance; distance recorded when
outside) and the time against the upload (≤ 10 minutes ahead, ≤ 72 hours old, and the diary's
Nairobi date when attached). `verified` = location inside and time ok; otherwise the reasons are
stored (`missing`, `outside`, `no_geofence`, `future`, `stale`, `diary_mismatch`).

Uploads are refused unless they are JPEG by signature (415 `unsupported-file-type`) and decode
within 50 megapixels (422 `invalid-image`); the guard refuses bodies over 15 MB before reading
(413 `payload-too-large`) and limits 240 uploads per user per hour. The malware hook runs. The
original is stored privately with its SHA-256 and a fresh, rotated, metadata-free thumbnail
beside it (`tenants/:tenant/projects/:project/photos/:id/…`); the same file twice in a project
is 409 `photo-duplicate`. Photos attach only to a **draft** diary of the same site (409
`diary-not-draft`), so approved diaries stay locked. Rows are append-only (database CHECKs bind
`verified` to the checks, keys to the tenant/project/photo, and the runtime role cannot update
or delete). Audit `photo.uploaded` records outcomes only, never coordinates, captions or names.
Images are served with `nosniff` and a sandboxing CSP.

Limits: a web upload cannot prove in-app capture, and EXIF can be edited, so the badge means
"metadata consistent", not proof (THREAT_MODEL A-13 also wants site-app capture and perceptual
reuse detection, both later). Thumbnails are generated in the API process; HEIC is not accepted.

## Site diary foundation (D6.1, Phase 6 increment 1)

All paths below are relative to `/api/v1/projects/:projectId/diaries`; authentication,
selected-company membership and the existing CSRF guard apply. Permissions are resolved
through `AccessPolicy` (role ∩ project assignment), not role names.

| Method / path       | Input                                                            | Result / permission                                                                                           |
| ------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| GET                 | `siteId?`, `cursor?`, `limit?` (1–100, default 30)               | `{diaries, nextCursor}`; `projects.view`; newest created first                                                |
| POST                | `{siteId, date, workPerformed, weather, delays, workforceCount}` | 201 `{diary}`; `site.diary`; one diary per site/day                                                           |
| PATCH `/:id`        | `{workPerformed, weather, delays, workforceCount, version}`      | `{diary}`; author + `site.diary`, draft only                                                                  |
| POST `/:id/actions` | `{action, version, reason?}`                                     | `{diary}`; submit/reopen by author with `site.diary`; approve/reject by independent `quality.manage` reviewer |

Dates are valid `YYYY-MM-DD` Nairobi calendar days and may not be future-dated.
`workPerformed` is required (1–6,000 trimmed characters); weather/delays are nullable
strings (250/2,000 characters); workforce is a nullable integer from 0 to 100,000.
Null means unknown, not zero. Since D6.1 (quality) `workforceSource` is `manual` (the
count as sent) or `attendance` (the count is not sent: the server stores a snapshot of attendance
on the diary's site and date by trade, with the muster state and time; see "Quality" below).
`reason` is required only for rejection (3–500 characters).
Create/update/action schemas are strict and exported from `@pm-buddy/validation`.

The lifecycle is `draft → submitted → approved` or `submitted → rejected → draft`.
The original author alone edits/submits/reopens; an author cannot review their own diary.
Submitted and rejected content is immutable; reopening clears current sign-off metadata
and requires resubmission. Approval locks the row permanently; there is no DELETE
endpoint or approved-record reopening. Closed/cancelled projects reject all mutations.
Every write and its safe-summary hash-chained audit event share a tenant transaction;
updates require the last-read version.

Database backstops include forced tenant RLS, a composite tenant/project/site foreign
key, unique site/day, transition/actor/version constraints and immutable approved rows.
Problem codes: 409 `diary-date-taken`, `diary-future-date`, `diary-not-draft`,
`diary-invalid-transition`, `version-conflict`, `project-read-only`; 403
`diary-author-required`, `diary-independent-review`; foreign resources return 404.

Web entry points: `/diary` (accessible project picker) and
`/projects/:projectId?tab=diary`; legacy `/soon/diary` redirects to `/diary`.
Photo verification (increment 2), the schedule (D6.2) and quality with the attendance
workforce (D6.1 quality) were added later; offline/site-app capture and valuations remain.

## BQ import, viewer and exports (D2.2)

Design in [ARCHITECTURE §4.2](../../docs/ARCHITECTURE.md#42-bq-module-and-excel-import-d22).
All paths are under `projects/:id/bq`. Reading and exporting need `bq.view` on the project;
everything about imports and templates needs `bq.import` (role ∩ assignment for project-scoped
users). Changes send the import `version` they read (409 `version-conflict` otherwise).

| Method/path                           | Body                                             | Response                                                                 |
| ------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------ |
| GET                                   | —                                                | `{bq}`: version, bills, summary, latest import status and overrides      |
| GET bills/:billId                     | —                                                | `{bill, items}` (sections and items of one bill)                         |
| GET search?q=                         | —                                                | `{items, truncated}` (matches by description or reference)               |
| GET export/xlsx?locale=en\|sw         | —                                                | `.xlsx` attachment (summary sheet plus one sheet per bill)               |
| GET export/pdf?locale=en\|sw          | —                                                | PDF attachment (A4, page numbers, "Draft" watermark while a draft)       |
| GET imports                           | —                                                | `{imports}` (summaries, newest first)                                    |
| POST imports                          | multipart `file` (`.xlsx`/`.xls`, at most 10 MB) | 201 `{import}` (`parsed`, or `failed` with `failureCode`)                |
| GET imports/:importId                 | —                                                | `{import}` with sheets, mapping, resolutions and report                  |
| POST imports/:importId/parse          | `{version}`                                      | `{import}` (retries reading an `uploaded` import)                        |
| GET imports/:importId/sheets/:n/rows  | `?from=&count=` (at most 200 rows)               | rows as text, with the formula cells marked                              |
| PUT imports/:importId/mapping         | `{mapping, version}`                             | `{import}` (`mapped`; clears the report and resolutions)                 |
| POST imports/:importId/apply-template | `{templateId, version}`                          | `{import}` with the template applied to sheets whose headers match       |
| POST imports/:importId/validate       | `{version}`                                      | `{import}` (`validated`, with the stored report)                         |
| PUT imports/:importId/resolutions     | `{resolutions:{rows, accepted}, version}`        | `{import}` with the report recomputed                                    |
| GET imports/:importId/preview         | —                                                | bills, totals, readiness, the existing draft and the differences from it |
| POST imports/:importId/commit         | `{version}`                                      | `{import}` (`committed`); one transaction; see the 409 codes below       |
| POST imports/:importId/abandon        | `{version}`                                      | `{import}` (`abandoned`)                                                 |
| GET imports/:importId/source          | —                                                | the original workbook (attachment)                                       |
| GET templates / POST templates        | — / `{name, importId, sheetIndex}`               | `{templates}` / 201 `{template}`                                         |
| DELETE templates/:templateId          | —                                                | `{message}`                                                              |

Upload refusals are problems with stable codes: 413 `payload-too-large`, 415
`unsupported-file-type` / `macro-workbook`, 422 `unsafe-archive` (ZIP bomb, ZIP64, encrypted),
400 `empty-file`, 503 `malware-scanner-unavailable` (`MALWARE_SCANNER=disabled`, the default)
and 503 `parser-busy`. Other BQ codes: 409 `invalid-import-state`, `commit-blocked`,
`validation-stale`, `bq-not-draft`, `project-read-only`, `template-name-taken`,
`template-not-applicable`; 422
`export-too-large` (PDF over 10,000 items). Quantities and rates are decimal strings; amounts
are integer minor units (`…Minor`). Line amounts are quantity × rate rounded half-up to the
cent per line; VAT (`BQ_VAT_RATE_PERCENT`, default 16, COMPLIANCE-REVIEW) once on the
subtotal. Fixtures and their generator are in `test/fixtures/bq` (`node
test/fixtures/bq/generate.mts` rewrites them; the content is synthetic).

## BQ versions, instructions, variations and rate build-ups (D2.3)

Design in [ARCHITECTURE §4.3](../../docs/ARCHITECTURE.md#43-bq-versions-variations-and-rate-build-ups-d23).
Paths under `projects/:id/bq` need `bq.view` to read, `bq.edit` to change (closed and cancelled
projects are read-only) and `bq.approve_variation` plus MFA verified within five minutes to
approve. Changes send the record's `version` (409 `version-conflict`).

| Method/path                                    | Body                                     | Response / notes                                                                   |
| ---------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------- |
| GET versions                                   | —                                        | `{versions}` newest first (source, parent, variation, approval, totals)            |
| GET versions/compare?from=&to=                 | —                                        | items added/removed/changed, bill subtotals, overall difference                    |
| GET versions/:versionId/bills/:billId          | —                                        | `{bill, items}` of any version of this BQ (a variation's base)                     |
| POST versions/:versionId/approve               | `{version}`                              | approves the imported draft as the baseline; not the importer (403)                |
| GET contract-sum                               | —                                        | original, approved variations, revised, pending (with VAT)                         |
| GET/POST instructions, GET/PATCH …/:id         | instruction fields (`status` on PATCH)   | the AI/EI register; 409 `instruction-number-taken`                                 |
| GET variations?status=, POST variations        | `{instructionId, title, description?}`   | 409 `baseline-not-approved`, `instruction-closed`                                  |
| GET/PATCH variations/:id                       | `{title?, description?, instructionId?}` | detail: lines, totals, projection, snapshot, decision, history, actions            |
| PUT variations/:id/lines                       | `{lines, version}`                       | adjust / omit / add lines priced against the base; 400 `variation-line-invalid`    |
| POST variations/:id/submit                     | `{version}`                              | freezes the snapshot digest; 409 `variation-empty`, `variation-stale`              |
| POST variations/:id/approve                    | `{version, snapshotDigest}`              | creates the next BQ version atomically; 409 `variation-stale`; 403 `maker-checker` |
| POST variations/:id/reject                     | `{version, snapshotDigest, reason}`      | `bq.approve_variation`, not the maker                                              |
| POST variations/:id/reopen, …/cancel, …/rebase | `{version}` (`reason` to cancel)         | rejected → draft; draft → cancelled; stale → draft on the newest version           |
| GET/PUT/DELETE items/:lineageId/rate-buildup   | `{buildupVersionId}` on PUT              | link a current-version item to a build-up version; 422 `unit-mismatch`             |

The company library is at `rate-buildups` (`GET`, `POST`), `rate-buildups/:id` (`GET`, `PUT`
appends a version) and `rate-buildups/:id/versions/:n`. Reading needs `bq.view` and changing
`bq.edit`, held company-wide or on at least one assigned project. Each line's amount is
quantity × (1 + waste %) × unit cost rounded half-up to the cent; the rate is the sum of the
lines and is `null` while any line has no unit cost. 409 `buildup-code-taken`.

## Labour registry (D3.1)

All routes are under `/api/v1/labour`, follow the conventions above (CSRF, `Origin`, RFC 9457
problems with a `code`) and use the shared schemas in `packages/validation/src/labour.ts`
(request schemas are strict; every response is parsed with its schema before it is sent).
Calendar dates are `YYYY-MM-DD` business dates in Africa/Nairobi; money is integer KES minor
units. "On the labourer" means: on a project the labourer is or was engaged on, or through a
company-wide role; labourers the caller cannot view are 404. Design notes:
[ARCHITECTURE §4.3](../../docs/ARCHITECTURE.md#43-labour-module-d31).

| Method/path                                                           | Body / query                                                                                                                                                                                                                                                                                                                                                                                           | Response                                                                                                                                                                                                                                                                                                                    | Permission and main errors                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET setup                                                             |                                                                                                                                                                                                                                                                                                                                                                                                        | `labourSetupResponseSchema` `{trades, skillLevels, settings{accreditationAlertDays, version}, canConfigure, manageableProjects[{id,code,name}]}`                                                                                                                                                                            | `labour.view` somewhere or `config.manage`                                                                                                                                                                                                                                                                                                                 |
| POST setup/defaults                                                   |                                                                                                                                                                                                                                                                                                                                                                                                        | setup response                                                                                                                                                                                                                                                                                                              | `config.manage`; adds the 15 standard trades and 4 skill levels that are missing                                                                                                                                                                                                                                                                           |
| POST trades · PATCH trades/:id                                        | `{key, nameEn, nameSw, sortOrder?}` · `{nameEn?, nameSw?, active?, sortOrder?, version}`                                                                                                                                                                                                                                                                                                               | `{trade}`                                                                                                                                                                                                                                                                                                                   | `config.manage`; 409 `trade-key-taken`, `version-conflict`                                                                                                                                                                                                                                                                                                 |
| POST skill-levels · PATCH skill-levels/:id                            | `{key, nameEn, nameSw, ncaCategory, accreditationExpected, sortOrder?}` · partial + `version`                                                                                                                                                                                                                                                                                                          | `{skillLevel}`                                                                                                                                                                                                                                                                                                              | `config.manage`; 409 `skill-level-key-taken`, `version-conflict`                                                                                                                                                                                                                                                                                           |
| PUT settings                                                          | `{accreditationAlertDays (1–365), version (0 = defaults)}`                                                                                                                                                                                                                                                                                                                                             | setup response                                                                                                                                                                                                                                                                                                              | `config.manage`                                                                                                                                                                                                                                                                                                                                            |
| GET rates                                                             | `?projectId=&labourerId=&tradeId=`                                                                                                                                                                                                                                                                                                                                                                     | `{rates[{id, scope, projectId, labourerId, tradeId, skillLevelId, basis, rateMinor, currency, effectiveFrom, effectiveTo, inForce, scheduled, createdAt, createdBy}], today, minimumWage{status:"not_configured", reference:"CR-PAY-09"}}`                                                                                  | `labour.manage` or `finance.view` (on the project when given)                                                                                                                                                                                                                                                                                              |
| POST rates                                                            | `{projectId?, labourerId?, tradeId?, skillLevelId?, basis, rateMinor, effectiveFrom}`                                                                                                                                                                                                                                                                                                                  | `{rate, minimumWage}` (201)                                                                                                                                                                                                                                                                                                 | company rates `config.manage`, project/labourer rates `labour.manage` on the project; 400 `rate-backdated`; 409 `rate-exists`                                                                                                                                                                                                                              |
| DELETE rates/:id                                                      |                                                                                                                                                                                                                                                                                                                                                                                                        | `{message}`                                                                                                                                                                                                                                                                                                                 | as for adding; 409 `rate-in-force` once the rate has started                                                                                                                                                                                                                                                                                               |
| GET labourers                                                         | `?status&tradeId&skillLevelId&projectId&gangId&accreditation=valid\|expiring\|expired\|missing\|attention&doNotRehire=true&consent=withdrawn\|outdated&search&limit(≤500)&offset`                                                                                                                                                                                                                      | `{labourers[summary], total, today, alertDays, permissions{canRegister, canFlag, canConfigure}}`; a summary has masked `idNumberMasked`/`phoneMasked`, `accreditation{status, expiresOn, daysLeft}`, `consent{status, noticeVersion, current}`, `doNotRehire` (null for non-managers)                                       | `labour.view`; `search` matches names and worker numbers only: a term with digits (other than a worker number such as `WRK-0012`) is refused (400 `validation-error`) so identifiers never travel in a URL                                                                                                                                                 |
| POST labourers/lookup                                                 | `{identifier}` (4–40 characters, body only)                                                                                                                                                                                                                                                                                                                                                            | the GET labourers response shape with the exact matches                                                                                                                                                                                                                                                                     | `labour.view`, labourers the caller can see; exact match of a full ID/passport number (across document types, leading zeros ignored), phone or KRA PIN through the blind indexes                                                                                                                                                                           |
| POST labourers                                                        | `{fullName, dateOfBirth, gender, homeCounty?, idType, idNumber, phone?, kraPin?, nssfNumber?, shaNumber?, nextOfKin?{name, relationship, phone?}, tradeId, skillLevelId, engagementType, rateBasis, projectId?, engagementStartDate?, consent{noticeVersion, language, method, witnessName?, granted:true}, accreditation?{category, cardNumber, issuedOn?, expiresOn}, doNotRehireOverride?{reason}}` | `{labourer[detail], warnings[]}` (201); warnings `phone-shared`, `accreditation-missing`/`-expiring`/`-expired`, `do-not-rehire-overridden`                                                                                                                                                                                 | `labour.manage` on `projectId` (company-wide role without one); 400 `under-minimum-age`, `notice-not-current`, `date-in-future`; 409 `duplicate-identity`, `kra-pin-taken`, `do-not-rehire-match` with `match{labourerId, workerNo, matchedOn: id\|phone\|kraPin}` (a phone match can be overridden with `labour.do_not_rehire` and `doNotRehireOverride`) |
| GET labourers/:id                                                     |                                                                                                                                                                                                                                                                                                                                                                                                        | `{labourer, warnings: []}`: summary + `dateOfBirth, age, homeCounty, kraPinMasked, nssfNumberMasked, shaNumberMasked, nextOfKinRecorded, engagements[], gangHistory[], accreditations[], consents[], doNotRehireDetail{flagged, setAt, setBy, reason}`, `version`, `permissions{canManage, canReveal, canFlag, canConsent}` | `labour.view` on the labourer; `doNotRehireDetail` null for non-managers, `reason` only with `labour.do_not_rehire`                                                                                                                                                                                                                                        |
| PATCH labourers/:id                                                   | any personal field, identifier corrections (`idType`+`idNumber`, `phone`, … `null` clears), `version`                                                                                                                                                                                                                                                                                                  | labourer response                                                                                                                                                                                                                                                                                                           | `labour.manage` on the labourer; 400 `under-minimum-age`; 409 `duplicate-identity`, `version-conflict`                                                                                                                                                                                                                                                     |
| POST labourers/:id/status                                             | `{to: active\|inactive\|left, reason?, version, doNotRehireOverride?}`                                                                                                                                                                                                                                                                                                                                 | labourer response                                                                                                                                                                                                                                                                                                           | `labour.manage`; leaving ends open engagements and gang memberships; 409 `invalid-status-change`, `consent-withdrawn`, `do-not-rehire-match`                                                                                                                                                                                                               |
| POST labourers/:id/reveal                                             | `{field: idNumber\|phone\|kraPin\|nssfNumber\|shaNumber\|nextOfKin, purpose}`                                                                                                                                                                                                                                                                                                                          | `{field, value, revealedAt}`                                                                                                                                                                                                                                                                                                | `labour.view_sensitive` + step-up (403 `step-up-required`, or `mfa-required` without MFA); audited with field and purpose                                                                                                                                                                                                                                  |
| PUT labourers/:id/do-not-rehire                                       | `{flagged, reason (10–500), version}`                                                                                                                                                                                                                                                                                                                                                                  | labourer response                                                                                                                                                                                                                                                                                                           | `labour.do_not_rehire` + step-up; 409 `do-not-rehire-unchanged`                                                                                                                                                                                                                                                                                            |
| GET labourers/:id/rate                                                | `?projectId&date?&basis?`                                                                                                                                                                                                                                                                                                                                                                              | `{labourerId, projectId, onDate, basis, rate (or null), minimumWage}`                                                                                                                                                                                                                                                       | `labour.manage` or `finance.view` on the project                                                                                                                                                                                                                                                                                                           |
| POST labourers/:id/engagements                                        | `{projectId, startDate?, doNotRehireOverride?}`                                                                                                                                                                                                                                                                                                                                                        | labourer response (201)                                                                                                                                                                                                                                                                                                     | `labour.manage` on the project; 400 `under-minimum-age`, `date-in-future`; 409 `already-engaged`, `consent-withdrawn`, `do-not-rehire-match`, `project-read-only`                                                                                                                                                                                          |
| POST labourers/:id/engagements/:engagementId/end                      | `{endDate, reason?}`                                                                                                                                                                                                                                                                                                                                                                                   | labourer response                                                                                                                                                                                                                                                                                                           | `labour.manage` on the project; 400 `end-before-start`; 409 `engagement-ended`                                                                                                                                                                                                                                                                             |
| POST · PATCH · DELETE labourers/:id/accreditations[/:accreditationId] | `{category, cardNumber, issuedOn?, expiresOn}` · partial + `version` · —                                                                                                                                                                                                                                                                                                                               | labourer response                                                                                                                                                                                                                                                                                                           | `labour.manage` on the labourer                                                                                                                                                                                                                                                                                                                            |
| POST labourers/:id/consents                                           | `{noticeVersion, language, method, witnessName?, granted:true}`                                                                                                                                                                                                                                                                                                                                        | labourer response (201)                                                                                                                                                                                                                                                                                                     | `labour.consent`; 409 `consent-current`                                                                                                                                                                                                                                                                                                                    |
| POST labourers/:id/consents/withdraw                                  | `{method, witnessName?}`                                                                                                                                                                                                                                                                                                                                                                               | labourer response                                                                                                                                                                                                                                                                                                           | `labour.consent`; 409 `consent-not-active`                                                                                                                                                                                                                                                                                                                 |
| GET accreditation-alerts                                              | `?projectId`                                                                                                                                                                                                                                                                                                                                                                                           | `{alerts[{labourerId, workerNo, fullName, kind: expired\|expiring\|missing, accreditationId, category, expiresOn, daysLeft}], alertDays, today}`                                                                                                                                                                            | `labour.view`                                                                                                                                                                                                                                                                                                                                              |
| GET views · POST views · DELETE views/:id                             | — · `{name, filters}` · —                                                                                                                                                                                                                                                                                                                                                                              | `{views[{id, name, builtIn, filters}]}` · `{view}` · `{message}`                                                                                                                                                                                                                                                            | `labour.view`; saved views are private to the user (at most 20) and never store search text (`filters.search` is refused with 400; the database CHECK refuses it too); 409 `view-name-taken`, `view-limit`                                                                                                                                                 |
| GET gangs                                                             | `?projectId&status`                                                                                                                                                                                                                                                                                                                                                                                    | `{gangs[{id, projectId, projectCode, projectName, siteId, siteName, name, status, leader, memberCount, version, …}], manageableProjectIds}`                                                                                                                                                                                 | `labour.view`                                                                                                                                                                                                                                                                                                                                              |
| POST gangs · GET/PATCH gangs/:id                                      | `{projectId, name, siteId?}` · — / `{name?, siteId?, leaderLabourerId?, status?, version}`                                                                                                                                                                                                                                                                                                             | `{gang, members[{membershipId, labourerId, workerNo, fullName, joinedOn, leftOn, current}], canManage}`                                                                                                                                                                                                                     | `labour.manage` on the project to change; 409 `gang-name-taken`, `leader-not-member`, `gang-has-members`, `site-not-in-project`                                                                                                                                                                                                                            |
| POST gangs/:id/members · POST gangs/:id/members/:membershipId/leave   | `{labourerId, joinedOn?}` · `{leftOn?}`                                                                                                                                                                                                                                                                                                                                                                | gang detail                                                                                                                                                                                                                                                                                                                 | `labour.manage`; 409 `not-engaged`, `already-in-gang`, `gang-archived`, `leader-must-change`, `membership-ended`                                                                                                                                                                                                                                           |

**Identifiers (review fixes).** The ID blind index is computed over the number without its
document type (all-digit numbers also without leading zeros), so the same number submitted as a
national ID, alien ID or passport is one identity: duplicate detection, the per-company unique
index and do-not-rehire matching hold across types, on registration and on corrections. Full
identifiers are searched only with `POST labourers/lookup` (body), never in a query string, and
saved views store structured filters only.

Database rules repeat the API's: forced RLS on every labour table, composite tenant keys,
`labourers_minimum_age_check`, a deferred trigger requiring a consent row, ciphertext and
blind-index format checks, append-only consent and do-not-rehire history, never-updated
rates, and gang/engagement triggers. A rule broken only at the database level is a 409
`labour-rule` (never a 500).

**For attendance and payroll (D3.2+).** Reference a labourer by `labourers.id` (UUIDv7;
`worker_no` is the human number). A worker is on a project while a `labour_engagements` row has
`start_date <= day` and `end_date` null or `>= day`; gangs are `gangs`/`gang_memberships`
(`joined_on`/`left_on`). The rate for a day is `resolveRate` in `packages/domain` over
`labour_rates`, or `GET labourers/:id/rate?projectId&date&basis`; a payroll line should store the
`labour_rates.id` it used.

## Attendance and timesheets (D3.3, web slice)

All routes are under `/api/v1/attendance`, follow the conventions above and use the shared
schemas in `packages/validation/src/attendance.ts`. Dates are `YYYY-MM-DD` in Africa/Nairobi;
times are `HH:MM` (24 h); durations are integer minutes; day counts are half-day units
(`halfDays`, with `days` as the decimal string `"4.5"`). Every command accepts an optional
`Idempotency-Key` header (8–128 letters, digits, `-`, `_`): a retry with the same key, user and
payload returns the stored response with `Idempotent-Replayed: true`; another payload is 409
`idempotency-key-reused`. Commands send the `version` they read (409 `version-conflict`).
Design notes: [ARCHITECTURE §4.4](../../docs/ARCHITECTURE.md#44-attendance-and-timesheets-module-d33-web-slice).

| Method/path                                                                 | Body / query                                                                                                                                                                                                                                                    | Response                                                                                                                                                                | Permission                                                                                                   |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| GET overview                                                                | —                                                                                                                                                                                                                                                               | `{today, projects[{sites[{today}], openAnomalies, pendingCorrections, pendingAdjustments, periodsAwaitingApproval, currentPeriod, canRecord}]}`                         | `attendance.view`                                                                                            |
| GET settings                                                                | —                                                                                                                                                                                                                                                               | `{today, periodSettings, rules, holidays, canConfigure, ruleProjects}`                                                                                                  | `attendance.view`, `timesheets.manage_rules` or `config.manage`                                              |
| PUT settings/periods                                                        | `{weekEndsOn, cutoffTime, paydayWeekday, version}`                                                                                                                                                                                                              | settings                                                                                                                                                                | `config.manage`                                                                                              |
| POST rules                                                                  | `{projectId?, effectiveFrom, normalMinutes, defaultBreakMinutes, breakAfterMinutes, dayStartMinutes, lateGraceMinutes, halfDayThresholdMinutes, maxPlausibleMinutes, restDays, otWeekdayMultiplier, otRestDayMultiplier, otHolidayMultiplier, sourceReference}` | 201 `{rule}`                                                                                                                                                            | company: `config.manage`; override: `timesheets.manage_rules`                                                |
| POST rules/defaults · DELETE rules/:id                                      | —                                                                                                                                                                                                                                                               | settings · `{message}` (scheduled versions only)                                                                                                                        | `config.manage` (delete: as for adding)                                                                      |
| POST holidays · POST holidays/defaults · DELETE holidays/:id                | `{date, nameEn, nameSw, kind, source}` · — · —                                                                                                                                                                                                                  | 201 `{holiday}` · settings · `{message}`                                                                                                                                | `config.manage`                                                                                              |
| GET projects/:projectId/muster                                              | `?siteId&date&gangId?`                                                                                                                                                                                                                                          | `{project, site, sites, gangs, date, dayType, holiday, rule, period, day, rows[{labourer, record, anomalies, otherSites}], corrections, editable, locked, permissions}` | `attendance.view`                                                                                            |
| PUT projects/:projectId/muster                                              | `{siteId, date, dayVersion, entries[{labourerId, status, checkIn, checkOut, overnight, breakMinutes, notes, version}]}`                                                                                                                                         | muster                                                                                                                                                                  | `attendance.record`                                                                                          |
| POST days/:dayId/submit · confirm · return                                  | `{version}` · `{version}` · `{version, reason}`                                                                                                                                                                                                                 | muster                                                                                                                                                                  | submit `attendance.record`; confirm/return `attendance.confirm`, not the submitter (confirm: nor a recorder) |
| POST days/:dayId/corrections                                                | `{labourerId, status, checkIn, checkOut, overnight, breakMinutes, notes, reason, recordVersion}`                                                                                                                                                                | 201 `{correction}`                                                                                                                                                      | `attendance.override` + step-up                                                                              |
| GET projects/:projectId/corrections · POST corrections/:id/approve · reject | `?status` · `{version, note?}` · `{version, note}`                                                                                                                                                                                                              | `{corrections}` · `{correction}`                                                                                                                                        | view; decide `attendance.confirm`, not the requester                                                         |
| GET anomalies · POST anomalies/:id/review                                   | `?projectId&status&kind&from&to` · `{decision: resolve\|dismiss, note, version}`                                                                                                                                                                                | `{anomalies, counts, reviewableProjectIds, projects}` · `{anomaly}`                                                                                                     | view; review `attendance.review_anomalies`, not a recorder                                                   |
| GET projects/:projectId/periods · GET periods/:id                           | —                                                                                                                                                                                                                                                               | `{project, periods, settings, pendingAdjustments}` · `{project, period, source, lines, totals, rules, holidays, blockers, adjustments, permissions}`                    | `attendance.view`                                                                                            |
| GET periods/:id/lines                                                       | —                                                                                                                                                                                                                                                               | `{project, period, lines, ruleVersions, holidays}` (approved periods only; 409 `period-not-approved`)                                                                   | `attendance.view`, `payroll.prepare` or `finance.view`                                                       |
| POST periods/:id/submit · reopen                                            | `{version}`                                                                                                                                                                                                                                                     | period detail                                                                                                                                                           | `timesheets.submit`                                                                                          |
| POST periods/:id/approve · reject                                           | `{version}` · `{version, reason}`                                                                                                                                                                                                                               | period detail                                                                                                                                                           | `timesheets.approve`, not the submitter                                                                      |
| POST periods/:id/adjustments                                                | `{labourerId, siteId, date, status, checkIn, checkOut, overnight, breakMinutes, notes, reason}`                                                                                                                                                                 | 201 `{adjustment}`                                                                                                                                                      | `attendance.override` + step-up                                                                              |
| GET projects/:projectId/adjustments · POST adjustments/:id/approve · reject | `?status` · `{version, note?}` · `{version, note}`                                                                                                                                                                                                              | `{adjustments}` · `{adjustment}`                                                                                                                                        | view; decide `timesheets.approve`, not the requester                                                         |
| GET labourers/:labourerId/summary                                           | `?from&to` (default the last 56 days)                                                                                                                                                                                                                           | `{labourerId, from, to, projects[{approved, pending, lastWorkedOn}], openAnomalies}`                                                                                    | `attendance.view` on the projects shown                                                                      |

Attendance problem codes (409 unless noted): `not-engaged`, `period-locked`, `period-overlap`,
`day-not-draft`, `day-empty`, `invalid-transition`, `same-person`, `no-changes`,
`correction-pending`, `correction-not-needed`, `correction-outdated` (the day or record changed
since the correction was asked for), `pending-corrections` (also when returning a day that has
one), `period-not-due`,
`unconfirmed-days`, `open-anomalies`, `rules-not-configured`, `rules-unverified` (production
only), `period-changed`, `period-not-approved`, `date-outside-period`, `adjustment-pending`,
`no-target-period`, `use-correction`, `rule-exists`, `rule-in-force`, `holiday-exists`,
`idempotency-key-reused`, `attendance-rule` (a database rule); 400
`date-in-future`, `site-not-in-project`, `invalid-idempotency-key`; 403 `step-up-required`, `mfa-required`. Database
triggers and CHECKs repeat every rule (engagement on the date, maker ≠ checker, period locks,
one record per labourer/site/day, insert-only snapshots).

**Review fixes (follow-up migration `20261112120000_attendance_review_fixes`).** (1) Maker ≠
checker binds the current submission: after a rejected period is reopened, the person who
rejected it may submit it again for someone else to approve (the last rejection stays on the
period; every rejection is audited). (2) Half days: each `half_day` record is worth one half, at
most two a day; the threshold applies only with a `present` record. (3) When another record of a
labourer's day changes after one project's period was approved, the day is recomputed with
nothing locked; a differing approved share opens a blocking `locked_share_changed` anomaly on
the day's open records and the system proposes a pending adjustment with unchanged values
(`proposed = previous`, `reason` = `AUTOMATIC_ADJUSTMENT_REASON` from `packages/types`,
requested by whoever made the change, audited with `automatic: true`); approving it (someone
else) clears the anomaly. A manual adjustment with unchanged values is accepted only while such a
difference exists. (4) A day cannot be returned while a correction is pending, and a correction
is applied only while its day is submitted or confirmed and the record still holds its
`previous` values.

### Payroll-facing timesheet contract

D4.1 payroll reads **approved** periods only, and never recomputes them:

- **Where.** `GET /api/v1/attendance/periods/:id/lines` (shared schema
  `timesheetLinesResponseSchema`), or the `timesheet_lines` table joined to
  `timesheet_periods` where `status = 'approved'`. Approval publishes the outbox event
  `timesheet.period_approved` (`aggregate_id` = period id; payload `projectId`, `startDate`,
  `endDate`, `lines`) in the same transaction, so payroll can pick periods up from
  `outbox_events` (no relay runs yet).
- **One line per labourer and `line_key`.** `kind = 'attendance'` (`line_key = 'attendance'`)
  holds the labourer's attendance on the project in the period; `kind = 'adjustment'`
  (`line_key = 'adjustment:<adjustment id>'`, `adjustment_id`, `original_period_id`) is an approved
  adjustment of an earlier approved period that landed here — its totals are a signed **delta**
  (after − before), so payroll adds it to this period's pay and never reopens the original
  period. Columns: `half_days`, `worked_minutes`, `normal_minutes`, `ot_weekday_minutes`,
  `ot_rest_day_minutes`, `ot_holiday_minutes`, `late_minutes`, `present_count`,
  `half_day_count`, `absent_count`, `leave_count`, `sick_count`, `rule_version_ids`,
  `record_ids` (source `attendance_records`) and `days` (per date: day type, rule version id,
  totals, record ids). The API shape is `TimesheetLine` (`totals.overtimeMinutes.weekday`,
  `.rest_day`, `.public_holiday`; `days[].ruleVersionId`).
- **Rule snapshot.** Lines reference the `timesheet_rule_versions` rows they were computed with
  (`rule_version_ids`, and per day `days[].ruleVersionId`); the endpoint returns them in
  `ruleVersions` with the overtime multipliers (decimal strings such as `"1.50"`), and the
  period's public holidays. Rule versions are never updated, and none can take effect inside a
  submitted or approved period, so the referenced values are the ones used. Multipliers are
  **not** applied here: gross pay = rate (`resolveRate` over `labour_rates`) × days or hours plus
  overtime minutes × multiplier is payroll's job. Rules start `unverified` (COMPLIANCE-REVIEW
  CR-PAY-08); production refuses to approve periods computed with them.
- **Days, not money.** A full day is 2 half-day units; a labourer's day is counted once across
  all sites and projects, and a project's lines carry only its share (a two-site day is never
  paid twice). Absence, leave and sick days are counted (`*_count`) without minutes; whether
  leave or sick days are paid is payroll policy.
- **Adjustments.** `timesheet_adjustments` (status `approved`, `delta`, `target_period_id`)
  explain each adjustment line; `GET projects/:projectId/adjustments` lists them with the reason,
  requester and decider. Some adjustment lines are reallocations proposed by the system
  (`reason` = `AUTOMATIC_ADJUSTMENT_REASON`): another record of the labourer's day changed after
  approval, so the delta moves this project's share to the recomputed one (for example overtime
  becoming normal time, or a half day becoming a full day). Payroll treats them like any other
  signed delta; the original period is never reopened.

## Development seed

`npx pnpm@12.17.0 db:seed` (root; it builds the API first) creates the synthetic company
"Jenga Bora Builders Ltd" with an owner (TOTP enrolled), a project manager and a site agent,
and three projects (Ruiru Heights Apartments, Kitengela Bungalow, Syokimau Townhouses) with
sites, geofences, WBS and milestones, plus one rate build-up example (`CONC-C25-SYN`, concrete
class 25 per m³, clearly marked **synthetic** values: 50 kg cement bags, sand and ballast in
tonnes). Since D3.1 it also adds the standard trades and skill
levels, 40 synthetic labourers (national IDs `900000xx`, phones `0700 000 0xx`, KRA PINs
`A9000000xxZ`; encrypted with the configured field keys), rates, six gangs, NCA cards (some
expiring or expired) and one do-not-rehire case. Since D3.3 it also adds the 2026–2027 public
holidays, the unverified demonstration timesheet rule and nine weeks of synthetic muster rolls
on Ruiru Heights and Kitengela (past weeks approved with their timesheet lines, the last
complete week submitted, the current week open, open two-site and excessive-hours anomalies,
one approved adjustment); this part is one transaction and is skipped when the company already
has a timesheet period. Since D6.2 it also adds the Ruiru Heights schedule: 22 activities across
the WBS with 30 dependencies (including a lead and start-to-start links), the milestones linked
into the network, the contract programme frozen as baseline 1 (as planned on 02/03/2026), actual
dates and progress that slipped, and three delays (weather, late reinforcement, a client
instruction); skipped when the project already has schedule activities. Since D6.1 (quality) it
also adds a fourth project, **Juja Road Duplex (JUJ-DPX)**, status completed, and quality data
written through the real services: the seven starter checklist templates; on Ruiru Heights a
signed-off slab inspection, a failed walling inspection (county inspector) with snags from its
failed items, a roofing inspection awaiting sign-off, four cube sets (one failing at 28 days, one
with an overdue 7-day result), three slump tests (one outside tolerance) and two diaries whose
workforce is an attendance snapshot (one approved, one draft); on Juja Road a pre-handover
inspection, closed construction snags, practical completion certified 75 days before the seed
day with a six-month defects liability period, and two DLP defects; skipped when Ruiru Heights
already has an inspection. It prints each account's identifier and, when it
creates the account, a generated password; for the owner also the TOTP secret and
`otpauth://` URI. It is idempotent: a second run reports "already present" and leaves
passwords unchanged. `npx pnpm@12.17.0 --filter @pm-buddy/api db:seed --reset-credentials`
issues new passwords and a new owner TOTP secret. It needs `DATABASE_URL`,
`AUTH_MFA_ENCRYPTION_KEY` and the `FIELD_*` keys like the API, and **refuses to run when `NODE_ENV=production`**.
All identities are synthetic (`example.test` addresses, a reserved UK drama number for the
diaspora client).

## Deliberate remaining scope

This is the working D1.3/D1.4 foundation, not a claim that every roadmap bullet is
finished. External email/SMS/WhatsApp providers, passkey sign-in without a password
(usernameless/discoverable login), passkey attestation or authenticator allow-lists,
per-assignment approval limits, action-bound transaction-signing step-up tokens, mobile
device proof-of-possession and admin force-sign-out across arbitrary users are not
implemented. The breached-password check is optional (`AUTH_BREACHED_PASSWORD_CHECK=hibp`)
and fails open. Step-up currently marks a persisted session with fresh TOTP, passkey or
recovery authentication for foundation actions; it must not be used as payment
authorization. Passkey changes are user-level events: they send a security notification but
do not appear in a company's audit log. No financial or biometric workflow is implemented here.

Vetted primitives are pinned to `@node-rs/argon2@2.2.2`,
`jose@6.2.15`, `otpauth@9.6.0`, `@simplewebauthn/server@14.0.3` (browser `14.0.0`) and
`@zxcvbn-ts/core@4.2.0` (`language-common@4.1.3`, `language-en@4.1.1`), all MIT or similar;
their official documentation was checked before integration. The HIBP range API follows its
[documented k-anonymity model](https://haveibeenpwned.com/API/v3#PwnedPasswords). Mailpit delivery follows its [documented Send API](https://mailpit.axllent.org/docs/api-v1/).
