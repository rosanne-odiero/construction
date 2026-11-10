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
mfaEnabled }, session: { id, tenantId, mfaVerified, expiresAt }, mfaRequired }`.
   A password-only session can enrol/verify MFA but cannot enter tenants when MFA is required.
   Access expires after ten minutes, idle refresh after thirty minutes; absolute
   sessions last 24 hours, shortened to eight hours for MFA-enrolled accounts.
   Replaying a refresh credential also sends a development security alert.

| Method/path                            | Body                                     | Response                                                      |
| -------------------------------------- | ---------------------------------------- | ------------------------------------------------------------- |
| POST auth/register                     | `{identifier,password,displayName}`      | `{message}`                                                   |
| POST auth/verify                       | `{identifier,code}`                      | `{message}`                                                   |
| POST auth/verification/resend          | `{identifier}`                           | `{message}`                                                   |
| POST auth/login                        | `{identifier,password}`                  | authentication response                                       |
| GET auth/me                            | —                                        | authentication response                                       |
| POST auth/refresh                      | `{}`                                     | authentication response                                       |
| POST auth/logout                       | `{}`                                     | `{message}`                                                   |
| POST auth/mfa/enroll                   | `{}`                                     | `{secret,uri}`                                                |
| POST auth/mfa/verify                   | `{code}`                                 | authentication response plus `recoveryCodes` (shown once)     |
| POST auth/mfa/step-up                  | `{code}`                                 | authentication response                                       |
| POST auth/mfa/recover                  | `{code}`                                 | authentication response                                       |
| POST auth/password/forgot              | `{identifier}`                           | `{message}` (always generic)                                  |
| POST auth/password/reset               | `{token,password}`                       | `{message}`                                                   |
| GET auth/sessions                      | —                                        | `{sessions:[{id,createdAt,lastSeenAt,expiresAt,current}]}`    |
| DELETE auth/sessions/:id               | —                                        | `{message}`                                                   |
| GET tenants                            | —                                        | `{tenants:[{id,name,role}]}`                                  |
| POST tenants                           | `{name}`                                 | `{tenant:{id,name}}` (fresh MFA required; selects new tenant) |
| POST tenants/:id/select                | `{}`                                     | authentication response (rotates cookies)                     |
| GET tenants/current/members            | —                                        | `{members}`                                                   |
| POST tenants/current/invitations       | `{identifier,role,projectIds?:string[]}` | `{invitation:{id,identifier,role,expiresAt}}`                 |
| POST tenants/invitations/accept        | `{token}`                                | `{message}`                                                   |
| DELETE tenants/current/members/:userId | —                                        | `{message}`                                                   |
| GET tenants/current/audit              | —                                        | `{events}` (most recent 100)                                  |
| GET projects                           | —                                        | `{projects:[{id,name,createdAt}]}` (project-scoped)           |
| POST projects                          | `{name}`                                 | `{project:{id,name,createdAt}}`                               |
| PATCH projects/:id                     | `{name}`                                 | `{project}`                                                   |
| PUT projects/:id/members/:userId       | `{permissions:string[]}`                 | `{message}`                                                   |

Identifiers accept email or Kenyan mobile numbers and are normalized. Passwords are
12–128 characters; common passwords are rejected. Verification uses six-digit,
five-minute single-use codes; reset and invitation credentials are opaque single-use
tokens. These credentials are **never returned by the API**. Development/test
notifications go only to local Mailpit (`http://localhost:8025`); phone messages use
a synthetic `phone-<number>@development.invalid` inbox. No SMS, WhatsApp, passkey,
identity-provider, mobile device-binding, or biometric integration is claimed.
The development provider uses Mailpit's documented HTTP send API over fixed
loopback, with redirects forbidden and a three-second timeout. It does not release
or relay messages. `AUTH_NOTIFICATION_TRANSPORT=development` is forbidden in
production; `disabled` fails notification-dependent operations explicitly.

Supported assignable tenant roles: `owner`, `project_manager`, `site_agent`,
`foreman`, `quantity_surveyor`, `storekeeper`, `finance`, `client`, `consultant`,
`supplier`. Owners/finance must already have enabled MFA to accept invitations.
Platform administrator is not self-assignable. Owners retain control of invitations,
members and project assignments; the last owner cannot be removed.

Only the selected tenant in a persisted session sets database context. Tenant-owned
queries run inside transactions with transaction-local tenant/user/request settings.
RLS is forced for the non-owner `pmb_app` runtime role; project access additionally
requires explicit permissions. Audit entries are append-only and hash chained in
serialized tenant transactions.
Assignable project permissions are the shared catalogue's `projects.view` and `projects.manage`. Team and
project-assignment administration remains owner-only. Self-membership discovery
and verified-recipient invitation discovery are narrowly scoped RLS bootstrap
exceptions before selecting a tenant.

All foundation response contracts are exported from `@pm-buddy/validation`:
`csrfResponseSchema`, `authResponseSchema`, `messageResponseSchema`,
`mfaEnrollmentResponseSchema`, `mfaVerificationResponseSchema`,
`sessionsResponseSchema`, `tenantsResponseSchema`, `tenantCreatedResponseSchema`,
`projectsResponseSchema`, `projectResponseSchema`, `invitationResponseSchema`,
`membersResponseSchema`, and `auditEventsResponseSchema`. Their inferred TypeScript
types are exported too, along with `tenantRoleSchema`, `projectPermissionSchema`,
`TenantRole`, `ProjectPermission`, and the project entity's `projectSchema`/`Project`.
These modules are browser-safe and do not import API/server code.

Errors use the existing RFC 9457 `application/problem+json` envelope. Invalid input:
400; invalid/missing auth: 401; authorization/CSRF/MFA: 403; conflicts: 409; throttling:
429; unavailable notification/database/rate-limit dependency: explicit 503/500.

## Deliberate remaining scope

This is the working D1.3/D1.4 foundation, not a claim that every roadmap bullet is
finished. Passkeys, external email/SMS/WhatsApp providers, custom tenant role
definitions, action-bound transaction-signing step-up tokens, mobile device
proof-of-possession, admin force-sign-out across arbitrary users, and a complete
breached-password corpus/provider are not implemented. Step-up currently marks a
persisted session with fresh TOTP/recovery authentication for foundation actions;
it must not be used as payment authorization. The local common-password denylist
is intentionally small. No financial or biometric workflow is implemented here.

Vetted primitives are pinned to `@node-rs/argon2@2.2.2`,
`jose@6.2.15`, and `otpauth@9.6.0`; their official documentation was checked before
integration. Mailpit delivery follows its [documented Send API](https://mailpit.axllent.org/docs/api-v1/).
