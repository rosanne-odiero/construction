# Phase 1 identity and tenancy API

Base: `/api/v1`, same-origin browser requests with `credentials: "include"`.

Before starting the development API, put a random 32-byte key in `apps/api/.env`
as `AUTH_MFA_ENCRYPTION_KEY=<64 hex characters>`; generate with
`node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
Do not commit this file or reuse a test key. Missing keys fail startup rather than
silently using a public development secret. Tests generate their own isolated key.
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

## Development seed

`npx pnpm@12.17.0 db:seed` (root; it builds the API first) creates the synthetic company
"Jenga Bora Builders Ltd" with an owner (TOTP enrolled), a project manager and a site agent,
and three projects (Ruiru Heights Apartments, Kitengela Bungalow, Syokimau Townhouses) with
sites, geofences, WBS and milestones. It prints each account's identifier and, when it
creates the account, a generated password; for the owner also the TOTP secret and
`otpauth://` URI. It is idempotent: a second run reports "already present" and leaves
passwords unchanged. `npx pnpm@12.17.0 --filter @pm-buddy/api db:seed --reset-credentials`
issues new passwords and a new owner TOTP secret. It needs `DATABASE_URL` and
`AUTH_MFA_ENCRYPTION_KEY` like the API, and **refuses to run when `NODE_ENV=production`**.
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
