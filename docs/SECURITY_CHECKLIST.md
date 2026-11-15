# PM-Buddy: Security checklist (OWASP ASVS 5.0.0, Levels 1 and 2)

> **Status:** D9.1 security checklist report, built in `construction-pin` on branch `phase-9/d9.1-security` and **not yet independently reviewed**. Assessed on 14/11/2026 against `main` at `a233a90` plus the D9.1 changes.
>
> **Standard:** OWASP Application Security Verification Standard **5.0.0** (release tag `v5.0.0_release`, 30 May 2025), every Level 1 and Level 2 requirement: 253 of the 345 (L3 is out of scope, brief §7). Requirement IDs follow that release (`OWASP_Application_Security_Verification_Standard_5.0.0_en.csv`, SHA-256 `6124dba176dc563f66363a11ae0c47f9b86b8a4a84c66a793670bd196ed86cd5`). The ASVS is © OWASP Foundation, CC BY-SA 4.0; this report paraphrases each requirement and links to the standard for the normative text: <https://github.com/OWASP/ASVS/releases/tag/v5.0.0_release>.
>
> Related: [THREAT_MODEL](./THREAT_MODEL.md) (§7.1 maps chapters to threats) · [ARCHITECTURE §4.17](./ARCHITECTURE.md#417-security-hardening-d91) · [OPERATIONS "Key rotation"](./OPERATIONS.md#key-rotation) · [PENTEST_SCOPE](./PENTEST_SCOPE.md) · [IMPLEMENTATION_STATUS](./IMPLEMENTATION_STATUS.md)

---

## 1. What "the checklist passes" means

ROADMAP D9.1 is done when "the checklist passes". It passes when **every** L1 and L2 requirement in §6 has one of these statuses, each with evidence that a reviewer can open (code, test name, configuration or document section):

| Status | Meaning |
|---|---|
| **Pass** | Implemented before D9.1 and verified now, with the evidence named. |
| **N/A** | Does not apply to PM-Buddy, with the reason (for example, PM-Buddy is an OpenID Connect relying party, not an authorisation server). |
| **Fixed (D9.1)** | A gap found by this assessment and closed in D9.1, with the change and a test (or, for documentation requirements, the new section). |
| **Deferred (owner)** | Cannot be built or verified until an **unbuilt** deliverable or the production infrastructure exists. The owner is named: D9.3 (hosting, TLS, edge, secrets manager, log shipping, operations view), and the application part, when there is one, is already done. |

No requirement is "Gap" or "Partial". A deferred requirement is not a pass for go-live: each must become Pass in its owner deliverable, and the whole checklist is re-run before any real money moves (ROADMAP §4 "security review" gate) and after each later security-relevant deliverable (D4.2 Daraja, D7.3 USSD/SMS, D9.2, D9.3). Requirements that cover only unbuilt features (for example payment callbacks) are assessed again when those features arrive; the current statuses describe the code that exists.


## 2. Summary

| Chapter | L1 | L2 | Pass | N/A | Fixed in D9.1 | Deferred |
|---|---:|---:|---:|---:|---:|---:|
| V1 Encoding and Sanitization | 8 | 19 | 17 | 9 | 1 | 0 |
| V2 Validation and Business Logic | 4 | 7 | 10 | 0 | 1 | 0 |
| V3 Web Frontend Security | 8 | 11 | 11 | 2 | 6 | 0 |
| V4 API and Web Service | 2 | 8 | 2 | 6 | 0 | 2 |
| V5 File Handling | 4 | 5 | 7 | 0 | 2 | 0 |
| V6 Authentication | 13 | 22 | 26 | 3 | 6 | 0 |
| V7 Session Management | 6 | 12 | 10 | 0 | 7 | 1 |
| V8 Authorization | 4 | 3 | 7 | 0 | 0 | 0 |
| V9 Self-contained Tokens | 4 | 3 | 7 | 0 | 0 | 0 |
| V10 OAuth and OIDC | 5 | 24 | 7 | 22 | 0 | 0 |
| V11 Cryptography | 3 | 11 | 10 | 1 | 3 | 0 |
| V12 Secure Communication | 3 | 6 | 1 | 1 | 0 | 7 |
| V13 Configuration | 1 | 12 | 3 | 0 | 3 | 7 |
| V14 Data Protection | 2 | 7 | 5 | 0 | 4 | 0 |
| V15 Secure Coding and Architecture | 3 | 10 | 9 | 0 | 4 | 0 |
| V16 Security Logging and Error Handling | 0 | 16 | 7 | 0 | 6 | 3 |
| V17 WebRTC | 0 | 7 | 0 | 7 | 0 | 0 |
| **Total** | **70** | **183** | **139** | **51** | **43** | **20** |

Deferred requirements by owner: **D9.3**: V4.1.2, V4.2.1, V7.4.5, V12.1.1, V12.1.2, V12.2.1, V12.2.2, V12.3.1, V12.3.3, V12.3.4, V13.2.1, V13.2.3, V13.2.4, V13.2.5, V13.3.1, V13.3.2, V13.4.1, V16.2.2, V16.4.2, V16.4.3.

## 3. Gaps found and fixed in D9.1

Each fix has a test that fails without it (spot-checked by reverting the fix; see [IMPLEMENTATION_STATUS](./IMPLEMENTATION_STATUS.md)).

| # | Gap | Fix | Evidence |
|---|---|---|---|
| 1 | The web app sent **no CSP and no security headers**, although THREAT_MODEL T-02/T-04/T-07 assumed a nonce-based CSP | Next.js 16 `src/proxy.ts` sets a fresh 128-bit nonce per request and a strict CSP (`'strict-dynamic'`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`, `form-action 'self'`, `connect-src 'self'`; `'unsafe-eval'` only under `next dev`), plus HSTS (production), `nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP, CORP and `X-Frame-Options` on every page and static file. The root layout passes the nonce to next-themes. `X-Powered-By` is off | `web/lib/security-headers.test.ts`, `web-test/security-headers.spec.ts`; walk of 442 page loads against the real API (191 under `next dev`: owner, client and supplier; 251 in a production build: owner, project manager, client and supplier) without a violation |
| 2 | Zod 4 probed `new Function` in the browser, so the production CSP reported a violation on every page | `z.config({ jitless: true })` in the browser bundle (`web/lib/zod-config.ts`) | `zod-config.test.ts` "never probes eval, which the production CSP blocks" |
| 3 | No way to **change a password** (ASVS V6.2.2/V6.2.3) | `POST /api/v1/auth/password/change` (current password, fresh MFA step-up when MFA is on, registration policy, other sessions signed out unless kept, notification) and a card in the account console (EN/SW) | `api-test/passwords.e2e-spec.ts` (two tests) |
| 4 | Any session could sign out the user's other sessions without re-authenticating (V7.5.2) | Ending another session needs a sign-in or MFA within five minutes (403 `reauthentication-required`) | `api-test/identity.e2e-spec.ts` "lists and revokes only the caller's sessions" |
| 5 | Breached-password check off unless configured (V6.2.12) | Unset `AUTH_BREACHED_PASSWORD_CHECK` means `hibp` in production | `password-policy.spec.ts` |
| 6 | Swagger UI and the OpenAPI document published in production by default (V13.4.5) | Unset `API_DOCS_ENABLED` means off in production | `app-config.spec.ts` |
| 7 | Client-portal photo images cacheable for five minutes on shared computers (V14.3.2) | `Cache-Control: private, no-store` | `api-test/client-portal.e2e-spec.ts` |
| 8 | Sign-out kept the client router cache of authenticated pages (V14.3.1) | Sign-out loads `/sign-in` as a new document | Office and portal sign-out (`web-test/sign-in.spec.ts` signs out and finds `/projects` closed) |
| 9 | Authentication outcomes were not logged; request logs did not say who; refusals logged as info (V16.2.1, V16.3.1, V16.3.2) | `SecurityEvent` log entries (IDs and reason codes only); request logs carry user, session and company; 401/403/429 at `warn` | `logging.spec.ts`, `api-test/passwords.e2e-spec.ts` "logs authentication outcomes as security events without identifiers or secrets" |
| 10 | Nothing proved that every controller applies the CSRF and `no-store` guard (V3.5.1, V14.3.2) | A test enumerates every controller | `api-test/health.e2e-spec.ts` |
| 11 | `AUTH_MFA_ENCRYPTION_KEY` could not rotate (replacing it broke every TOTP enrolment) and no tool re-encrypted field data; append-only and immutable-row guards would have refused re-encryption (V11.2.2) | Versioned sealing keys (`kid`), `pnpm --filter @pm-buddy/api keys:rotate status|rewrap` (schema owner only, resumable, compare-and-swap, recorded in `key_rotation_runs`), migration `20261202090000_key_rotation` with an owner-only re-encryption path in the guards | `api-test/key-rotation.e2e-spec.ts` (2 tests), `sealed-secrets.spec.ts`, `key-rotation.spec.ts`; drill on the development database ([OPERATIONS](./OPERATIONS.md#key-rotation)) |
| 12 | No dependency audit gate or SBOM (V15.1.1, V15.1.2) | CI job: `pnpm audit --prod --audit-level high` and a CycloneDX SBOM artifact, weekly as well as on PRs | `.github/workflows/security.yml` |
| 13 | Uploads could only be refused or passed unscanned (development) (V5.4.3) | ClamAV `clamd` INSTREAM adapter (`MALWARE_SCANNER=clamav`), failing closed | `malware-scanner.spec.ts` (fake clamd), checked against a real clamd with the EICAR test file |
| 14 | ASVS documentation requirements not written down in one place | §5 below | — |

## 4. Deferred items and decisions for the owner

**Deferred (owner D9.3, infrastructure and operations):** TLS versions, ciphers and certificates (V12.1.1, V12.1.2, V12.2.1, V12.2.2), TLS to PostgreSQL, Valkey, storage, OTLP and between web and API (V12.3.1, V12.3.3, V12.3.4), HTTP→HTTPS redirect and request-smuggling-safe edge (V4.1.2, V4.2.1), service credentials, egress allowlists and the secrets manager (V13.2.1, V13.2.3–V13.2.5, V13.3.1, V13.3.2), images without `.git` (V13.4.1), host clock sync, log protection and shipping (V16.2.2, V16.4.2, V16.4.3), and the operations view's "sign out a member" and platform-wide session revocation (V7.4.5). In each case the application part is done or the interim procedure is in OPERATIONS.md.

**Owner decisions** (also [QUESTIONS](./QUESTIONS.md#security-d91) Q-SEC1–Q-SEC8 and THREAT_MODEL §9):

1. **MFA for every office role (V6.3.3).** ASVS L2 expects MFA for all users unless a documented rationale and compensating controls exist. PM-Buddy follows the brief: mandatory for every MFA-required permission (Owner, Finance, admin roles, anyone who can approve money or change roles), step-up for sensitive actions, optional for project managers, site agents, storekeepers and portal users, and a six-digit PIN for labourers (feature phones; own data only). This report records that as the documented relaxation (D-155). Decide before pilot whether project managers and site agents must enrol too.
2. **HSTS preload** (V3.4.1): the policy is preload-ready except for the `preload` token, which commits the whole domain to HTTPS for years. Decide with the domain choice (D9.3).
3. **Separate hostnames for portals** (V3.5.4): the office app and the client, supplier and labourer portals share one origin and session by design. Splitting them (for example `portal.` and `supplier.` hosts) would contain an XSS in one portal but needs separate sign-in. Recommended to keep one origin while the CSP has no `'unsafe-inline'` scripts.
4. **Prototype and design-system pages in production** (V15.2.3): `/prototype/**`, `/design-system` and `/site` are labelled static demos without API access. Decide whether production builds should hide them.
5. **Breached-password lookups** now go to Have I Been Pwned by default in production (five SHA-1 characters; fails open). Confirm, or set `off` and accept V6.2.12 as not met.
6. **Blind-index key rotation** is not supported (§5.5): decide whether to version blind indexes before any real personal data is stored.
7. **One-time links in query strings** (V14.2.1, A-131): keep (with the mitigations listed) or move tokens to the URL fragment.
8. **Pen-test vendor and timing** (OR-13): see [PENTEST_SCOPE](./PENTEST_SCOPE.md).

## 5. Supporting documentation required by ASVS

### 5.1 Authentication pathways and anti-automation (V6.1.1, V6.1.3, V6.3.4)

Every way to obtain or extend a PM-Buddy session, with its controls. Limits are per identifier or account; with `TRUST_PROXY` set (required in production) every authentication route is also limited to 60 requests a minute per client address. Counters live in Valkey and **fail closed** (503) when Valkey is down.

| Pathway | Who | Strength | Controls |
|---|---|---|---|
| Password sign-in `POST /auth/login` | Everyone with a verified account | Something you know; MFA follows when required | Argon2id; 10 attempts per 5 minutes per identifier; 5 wrong passwords lock the account for 15 minutes (the lockout is short and per account, so an attacker can delay but not disable sign-in; unknown and locked accounts get the same answer and timing); MFA mandatory for MFA-required permissions |
| Google sign-in `GET /auth/google/start` → callback | Gmail or matching Workspace addresses (when configured) | Google proves the email only | PKCE, state and nonce in an encrypted single-use cookie; signature, issuer, audience and expiry checks; PM-Buddy MFA still applies; never satisfies step-up |
| Labourer PIN `POST /auth/pin/login` | Labourers invited by a project manager | Phone number plus six-digit PIN | Argon2id with a server-side pepper; 10 attempts per 5 minutes per number; 5 wrong PINs lock for 15 minutes; 30 wrong PINs a day per number (then an SMS reset); a platform-wide hourly budget (`PIN_GLOBAL_FAILURES_PER_HOUR`) after which each number gets one wrong PIN an hour; PIN sessions can use the labourer portal only |
| TOTP `POST /auth/mfa/verify`, `/auth/mfa/step-up` | Accounts with TOTP | Second factor | 10 per 5 minutes and 30 per day per user; each time step usable once; 5 consecutive wrong codes lock MFA for 15 minutes, revoke the session and notify |
| Passkey `POST /auth/passkeys/step-up` | Accounts with passkeys | Second factor (phishing-resistant) | User verification required; challenges bound to user and session, five minutes, single use; shares the MFA lockout |
| Recovery code `POST /auth/mfa/recover` | Accounts with MFA | Replaces a lost factor once | 144-bit codes, single use; shares the MFA lockout |
| Refresh `POST /auth/refresh` | Signed-in browsers | Continues a session | Opaque 256-bit token rotated on every use; reuse revokes the session and notifies; 20 per minute per token; idle and absolute limits (§5.2) |
| Password reset `POST /auth/password/forgot`, `/reset` | Verified accounts | Account recovery | 256-bit token, 15 minutes, single use, 5 attempts per 15 minutes per token; signs out every session and does not sign in; MFA still required afterwards |
| Password change `POST /auth/password/change` (D9.1) | Signed-in users | Credential change | Current password, fresh step-up when MFA is on, 5 attempts per 15 minutes; other sessions signed out unless kept |
| Verification `POST /auth/verify` | New accounts | Proves control of the identifier | Six-digit code, 5 minutes, 5 tries per code, 10 per 5 minutes, 20 per day; also needs the registration password |
| Invitation acceptance | Invited users | Joins a company | Recipient-bound, single-use, expiring 256-bit token; privileged roles need verified MFA |

There are no other pathways: no API keys, no basic authentication, no passwordless passkey sign-in, no SMS one-time password as a factor, no impersonation (OR-08). Native site-app authentication with device binding arrives with D3.2 and USSD PINs with D7.3; both must be added here.

### 5.2 Sessions (V7.1.1–V7.1.3, V7.6.1)

| Item | Policy | Rationale |
|---|---|---|
| Access token | Ed25519-signed JWT, 10 minutes, HttpOnly cookie | Short-lived; every request also checks the session row |
| Inactivity timeout | 30 minutes, extended by each refresh | NIST SP 800-63B-4 AAL2 allows at most 1 hour; shared site and office computers |
| Absolute lifetime | 8 hours when the account has an MFA factor, 24 hours otherwise; then sign in again | AAL2 allows at most 24 hours; 8 hours fits a working day for people who can move money. Accounts without MFA are AAL1, for which NIST allows 30 days; 24 hours is kept for shared devices |
| Step-up | Sensitive actions need MFA within the last 5 minutes | Transaction-level assurance (brief §7) |
| Concurrent sessions | Unlimited; each browser or device has its own session | Staff use a phone and a laptop. Every session is listed in the account console and can be ended (after re-authentication, D9.1); password reset ends all; the first MFA factor and a password change (by default) end the others; a role change or removal ends the member's sessions in that company |
| Federated sessions | Google only proves the email at sign-in; PM-Buddy then issues its own session with the policy above. Signing out of PM-Buddy does not sign out of Google and Google's session is never consulted again; there is no single logout | PM-Buddy keeps control of MFA and lifetimes |

### 5.3 Context-specific words refused in passwords (V6.1.2, V6.2.11)

zxcvbn-ts receives, for every new password: `pm-buddy`, `pmbuddy`, `pm buddy`; the account's email or phone number, the email's local part, domain and the words in the local part, the phone in `07…` and `7…` forms; the display name and each of its words (`apps/api/src/modules/identity/password-policy.ts` `userInputs`). A local list adds a few common long passwords (`identity.schemas.ts`). Company and project names are not yet added (a person can belong to several companies).

### 5.4 Data classification and protection requirements (V14.1.1, V14.1.2)

| Class | Examples | Storage | Access | Logs, audit, exports | Retention |
|---|---|---|---|---|---|
| **S — Secrets** | Passwords, PIN hashes, TOTP seeds, recovery codes, session and reset tokens, encryption keys, future Daraja credentials | Hashed (Argon2id, SHA-256 for 256-bit tokens) or sealed (AES-256-GCM); keys only in the environment or secrets manager | Code paths only; never returned (seeds shown once at enrolment) | Never logged (redaction paths), never in audit metadata, never exported | Until replaced; tokens expire |
| **P — Personal identifiers** | National ID or passport, KRA PIN, NSSF and SHA numbers, phone numbers, bank account numbers, next of kin, do-not-rehire reasons; future biometric templates (separate key, D3.4) | Field encryption bound to company, table, column and row; blind indexes for exact lookups; masks for display | Masked by default; full value only with `labour.view_sensitive` (or the finance equivalent), fresh step-up and a recorded purpose | Never in logs, URLs or audit metadata (audit records only that a reveal happened); exports show masks | Per COMPLIANCE_TODO / DPIA (reviewed policy pending, brief §15 F) |
| **C — Confidential business** | Payroll, rates, costs, budgets, supplier payments, confidential documents (contracts, BQs, insurance), audit log | PostgreSQL with forced RLS; private object storage with SHA-256 | Permission and project scope (role ∩ assignment); clients and suppliers see curated views only | IDs in logs; audited actions and exports; spreadsheet cells neutralised; `no-store` | Financial records kept (Kenyan record-keeping rules, COMPLIANCE_TODO) |
| **I — Internal project data** | Projects, BQ items, schedule, diaries, verified photos (shared variants without EXIF) | As C | Project members; clients see approved and verified items | As C | Project lifetime plus retention policy |
| **O — Public** | Health liveness, the sign-in page | — | Anyone | — | — |

All classes rely on TLS in transit and on encrypted database, object-storage and backup volumes at rest (D9.3).

### 5.5 Cryptographic inventory and key management (V11.1.1, V11.1.2)

| Key or secret | Setting | Algorithm (library) | Protects / used for | Never used for | Rotation |
|---|---|---|---|---|---|
| Field master keys | `FIELD_ENCRYPTION_KEYS`, `FIELD_ENCRYPTION_ACTIVE_KEY_VERSION` | AES-256-GCM, per-company keys by HKDF-SHA-256 (Node crypto) | Labourer identifiers, supplier KRA PINs, contact phones, bank account numbers, do-not-rehire reasons; since D4.2 Daraja credentials, callback path tokens, payment recipients' phone numbers, raw callback bodies and cached OAuth tokens | Anything else | **Supported**: add a version, make it active, `keys:rotate rewrap`, remove the old one (drill done 14/11/2026; the e2e drill covers the payments columns since D4.2; cached OAuth tokens are refetched) |
| Blind-index key | `FIELD_BLIND_INDEX_KEY` | HMAC-SHA-256 per company | Exact-match lookups and uniqueness of ID numbers, phones and KRA PINs; payee-phone snapshots on payroll lines | Encryption (start-up refuses a blind-index key equal to an encryption key) | **Not supported**: unversioned, and approved payroll lines keep indexes whose plaintext is not stored, so they could not be recomputed. On suspected compromise: treat as an incident, then a planned maintenance window to recompute live tables with a versioned index (design in OPERATIONS) |
| Sealing key | `AUTH_MFA_ENCRYPTION_KEY`, `AUTH_MFA_ENCRYPTION_ACTIVE_KEY_VERSION` | JWE `dir` + A256GCM (jose), `kid` = version | TOTP seeds, pending enrolments, CSRF tokens, the Google sign-in cookie | Field data | **Supported since D9.1**: same steps as field keys; short-lived CSRF and Google cookies simply expire |
| Token signing key | `AUTH_SIGNING_PRIVATE_KEY` | Ed25519 (jose) | Access tokens (10 minutes) | Anything else | **By replacement**: old tokens fail, browsers refresh silently with their opaque refresh token (drill done) |
| PIN pepper | `AUTH_PIN_PEPPER_KEYS`, `AUTH_PIN_PEPPER_ACTIVE_VERSION` | HMAC-SHA-256 then Argon2id | Labourer PINs | Anything else | **Lazy**: each correct PIN sign-in re-hashes under the active version; `keys:rotate status` shows the counts; removing an old version early forces those labourers to reset their PIN |
| Google client secret | `AUTH_GOOGLE_CLIENT_SECRET` | OAuth client authentication | Token requests to Google | — | In Google Cloud, then replace and restart |
| Database, Valkey and storage credentials | `DATABASE_URL`, `DATABASE_MIGRATION_URL`, `REDIS_URL`, `S3_*` | Passwords and access keys | Service authentication | — | With the secrets manager (D9.3) |
| No key | — | Argon2id (passwords), SHA-256 (token digests, file integrity, audit hash chain), HMAC-SHA-1 TOTP (RFC 6238), WebAuthn signature verification (EdDSA, ES256, RS256), 128-bit CSP nonces (Web Crypto) | — | — | — |
| TLS certificates | Edge | — | Transport | — | D9.3 |

**Key management policy** (NIST SP 800-57 lifecycle): keys are generated with a CSPRNG (`openssl rand -hex 32`, `openssl genpkey -algorithm ed25519`) by the platform operator, distributed only through the secrets manager (never in the repository, chat, tickets or email), and each key has one purpose. Cryptoperiods: field, sealing and PIN-pepper keys yearly; the signing key every six months; all of them at once on suspected compromise or when someone with access leaves. Retired versions are removed from the running configuration once `keys:rotate status` shows nothing left on them, then kept disabled ("restore only") in the secrets manager for the backup retention period so an older backup can still be read, then destroyed. At most two named people hold production key access; every rotation is recorded in `key_rotation_runs` and in OPERATIONS. Keys are environment variables until the KMS or secrets-manager decision (D-30, OR-09, D9.3).

### 5.6 Communication inventory (V13.1.1, V13.2.4)

| From → to | Purpose | Notes |
|---|---|---|
| Browser → web (same origin) | Pages, static files, `/api/*` rewritten to the API | CSP `connect-src 'self'`; no third-party scripts, fonts or analytics |
| Browser → `tile.openstreetmap.org` | Map tiles | Development only (D-10); not in the production CSP |
| Web server → API (`API_INTERNAL_URL`) | Server rendering | Forwards only the Cookie header |
| API → PostgreSQL, Valkey, object storage | Data, rate limits, files | `DATABASE_URL` (`pmb_app`), `REDIS_URL`, `S3_ENDPOINT` |
| API → `api.pwnedpasswords.com` | Breached-password range lookups | Production default; five SHA-1 characters; 2-second timeout; redirects refused |
| API → Google (`accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com`) | OpenID Connect discovery, tokens and keys | Only when Google sign-in is configured |
| API → clamd (`CLAMAV_HOST:CLAMAV_PORT`) | Malware scanning | When `MALWARE_SCANNER=clamav` |
| API → OTLP collector | Traces | When `OTEL_EXPORTER_OTLP_ENDPOINT` is set |
| API → Mailpit on loopback | Development notifications | Refused in production |
| Planned | Safaricom Daraja (D4.2), Africa's Talking (D7.3), an email provider | Added here when built |

No feature lets a user supply a URL that the server fetches.

### 5.7 Log inventory (V16.1.1, V16.2.3, V16.3.3)

| Log | Written by | Content | Format and destination |
|---|---|---|---|
| Request log | pino-http (`apps/api/src/common/logging.ts`) | One line per request except health checks: time (UTC epoch ms), level, request ID, method, path without query string, client address (trusted proxies only), status, duration, service; user, session and company IDs once signed in. 401, 403 and 429 at `warn`, 5xx at `error` | JSON on stdout |
| Security events | `SecurityEvent` (`identity/security-events.ts`) | `auth.login.succeeded/failed/locked` (password, PIN, Google), `auth.mfa.succeeded/failed/locked` (TOTP, passkey, recovery code), `auth.password.reset/changed/change_failed`, `auth.session.refresh_reused/revoked`, `auth.logout`; with user, session, method and a reason code | JSON on stdout |
| Application warnings and errors | Nest loggers | Unexpected errors with trace ID (problem filter), notification failures, skipped breached-password checks, Google discovery failures, missing PIN pepper versions, the global PIN budget alert, clamd findings and failures | JSON on stdout |
| Audit log | `audit_events` (hash-chained, append-only) | Business and administrative actions per company with actor and request ID | PostgreSQL; visible to `audit.view` holders with step-up |
| Key rotations | `key_rotation_runs` | Who rotated which keys, counts, failures (row references only) | PostgreSQL; schema owner only |
| Traces | OpenTelemetry | Spans without bodies | OTLP (optional) |
| Web server | Next.js | Server errors | stdout |

**Never logged:** passwords, PINs, codes, tokens, cookies, `X-CSRF-Token`, emails and phone numbers as identifiers, ID numbers, KRA PINs, bank details, request bodies and query strings (`REDACT_PATHS`). **Security events and bypass attempts:** failed and successful authentication (above); CSRF and Origin refusals (403, warn); validation failures (400); rate limits (429, warn); permission refusals (403, warn, with the actor); database guard refusals mapped to 409/422 problems; business actions in the audit log. Shipping, retention (proposed 90 days searchable, one year archived) and access control: D9.3.

### 5.8 Dependency remediation time frames (V15.1.1)

| Severity (production dependency) | Fix or mitigate within |
|---|---|
| Critical | 7 days (CI blocks a PR that adds one) |
| High | 30 days (CI blocks) |
| Moderate | 90 days |
| Low | The next routine update |

Development-only tools follow the same windows without blocking CI. Dependabot proposes updates weekly after a 7-day cooldown; majors are reviewed at each phase. An exception (no fix available) is recorded in IMPLEMENTATION_STATUS with its owner and review date. On 14/11/2026: no high or critical; one moderate (minimatch, through the shadcn CLI) and one low with no fix (deepmerge, through the shadcn CLI), both within their windows.

### 5.9 Resource-demanding functions (V15.1.3, V15.2.2)

| Function | Cost | Protection |
|---|---|---|
| Password, PIN and code checks | Argon2id (19 MiB each) | Throttles per identifier and address (§5.1); a dummy hash keeps timing equal |
| BQ workbook import | XLSX parsing | 10 MB, ZIP limits checked first, parsing in a worker thread with time, memory, sheet, row and cell limits; 60 uploads an hour per user |
| Document, receipt and procurement uploads | Content inspection, hashing, scanning | 25/10/5 MB caps, ZIP limits, per-user rate limits, clamd timeout |
| Site photos | Image decoding and thumbnails (sharp) | 15 MB, 50 megapixels refused before decoding, 240 uploads an hour per user |
| PDF and Excel exports (BQ, certificates, statements, compliance register, reports) | Rendering | Per-user limits (for example 60 per 10 minutes for BQ and certificates, 30 per 10 minutes for client statements), row caps (PDF up to 5,000 lines) |
| Dashboard and reports | Aggregate queries | 30 dashboard loads a minute per user with a 60-second cache; bounded queries and page sizes |
| Identifier reveals | Decryption and audit | Permission, fresh step-up, purpose, audit |
| Report scheduler | Emails | One instance at a time (advisory lock); claims with `SKIP LOCKED` |
| Notifications | SMS cost (later) | Identity throttles; SMS budgets with D7.3 |

Outbound calls have timeouts (Have I Been Pwned 2 s, Google 5 s, web→API 10 s, clamd 30 s) and transactions 10 s unless a command needs longer. Load tests follow in D9.2.

### 5.10 Upload features (V5.1.1)

| Feature | Accepted (detected by content) | Size and archive limits | After upload | Download |
|---|---|---|---|---|
| BQ workbook (`POST …/bq/imports`) | XLSX, XLS | 10 MB; ≤ 100 MB uncompressed, ratio ≤ 100:1, no ZIP64, encryption or macros | SHA-256, malware scan, private storage under a server-chosen key | Original to `bq.import` holders through the API |
| Project documents | PDF (no scripts, launch actions or embedded files), JPEG, PNG, WebP, DOCX, XLSX (no macros or embedded programs); CAD and old Office refused | 25 MB; same ZIP limits | SHA-256, malware scan, versioning | Through the API after permission checks, SHA-256 verified, `attachment`, `nosniff`, sandbox CSP, audited |
| Site, quality and safety photos | JPEG, PNG, WebP | 15 MB, 50 megapixels | EXIF read for evidence checks, metadata-free thumbnail, SHA-256, malware scan | Thumbnails inline with `nosniff` and sandbox CSP; originals to permitted users |
| Petty-cash receipts, GRN photos | Images | 5 MB | SHA-256, malware scan | Through the API |
| Procurement and supplier-portal documents | PDF and images | 10 MB | SHA-256, malware scan | Through the API |

A file that clamd flags is refused (422 `malware-detected`) and not stored; if the scanner is unavailable or not configured the upload is refused (503 `malware-scanner-unavailable`). Nothing is ever served from a public bucket or a pre-signed URL.

### 5.11 Business limits (V2.1.3)

Per-user and global limits are the rate limits in §5.1 and §5.9 plus the record caps enforced by the API and database: at most 10 passkeys per account, 50 versions per document, 10 photos per GRN, 100 lines per procurement document, 10 suppliers and requisitions per RFQ, PDF exports of up to 5,000 lines, and the configurable business limits in [CONFIGURATION](./CONFIGURATION.md) (approval thresholds, tolerances, budgets). The global PIN failure budget (`PIN_GLOBAL_FAILURES_PER_HOUR`) is the only platform-wide limit today; tenant quotas for exports, uploads and notifications follow in D9.2 (brief §15 H).


## 6. Requirement by requirement

Paths: `api/` = `apps/api/src/`, `api-test/` = `apps/api/test/`, `web/` = `apps/web/src/`, `web-test/` = `apps/web/test/`, `val/` = `packages/validation/src/`, `dom/` = `packages/domain/src/`, `mig/` = `apps/api/prisma/migrations/`. Unit tests sit next to the file they test (`*.spec.ts` in the API, `*.test.ts` elsewhere). Quoted names are test titles. Requirement texts are short paraphrases; the normative text is the ASVS 5.0.0 release.


### V1 Encoding and Sanitization

27 requirements: 17 Pass, 9 N/A, 1 Fixed in D9.1, 0 Deferred.

| ID | L | Requirement (paraphrased) | Status | Evidence |
|---|---|---|---|---|
| V1.1.1 | 2 | Decode input to canonical form once, before validation | Pass | Express decodes URLs and JSON once; every controller parses the decoded body with a Zod schema at the boundary (`val/*.ts`, e.g. `api/modules/identity/identity.schemas.ts`); no second decoding anywhere |
| V1.1.2 | 2 | Encode output as the last step, for its interpreter | Pass | React escapes at render (no raw HTML; see V3.2.2); SQL values are bound parameters; PDF text is pdfmake text nodes; Excel cells go through `spreadsheetSafeText` (`dom/bq/text.ts`) |
| V1.2.1 | 1 | Context-aware output encoding for HTML, attributes, CSS and headers | Pass | JSX output encoding; `Content-Disposition` built by `contentDisposition()` (`dom/bq/text.ts`, RFC 6266 `filename*`); JSON via the framework; request IDs echoed only when they match `^[A-Za-z0-9-]{8,64}$` (`api/common/logging.ts`, test `logging.spec.ts` "replaces the unsafe inbound value") |
| V1.2.2 | 1 | Encode untrusted data in URLs; allow only safe URL schemes | Pass | Web builds API paths with `encodeURIComponent` (e.g. `web/components/auth/google-sign-in-button.tsx`, `foundation-console.tsx`); API redirects use `URLSearchParams` (`api/modules/identity/google-sign-in.service.ts`); `next` targets accepted only as same-site relative paths (`web/lib/safe-next.ts`, test "refuses absolute, protocol-relative, backslash and looping destinations"); no user-supplied link targets are rendered; the CSP blocks `javascript:` URLs (`web-test/security-headers.spec.ts` "blocks injected inline handlers, javascript: URLs and foreign resources") |
| V1.2.3 | 1 | Encode when building JavaScript or JSON | Pass | JSON is produced by `JSON.stringify`/framework serialisers only; no script is built from data (the only `dangerouslySetInnerHTML`, `web/components/ui/chart.tsx`, writes CSS variables from developer-defined chart configs) |
| V1.2.4 | 1 | Parameterised database queries (no SQL injection) | Pass | Prisma queries and tagged `$queryRaw`; the three `$queryRawUnsafe` calls (`api/modules/finance/spending-common.ts`, `procurement/stores/stores-common.ts`, `procurement/p2p/p2p-common.ts`) take table names from constant maps and bind the tenant ID; `api/keys/key-rotation.ts` uses `Prisma.raw` only for its constant column catalogue |
| V1.2.5 | 1 | No OS command injection | Pass | The API and web never start processes (`child_process` is not used); BQ parsing runs in a `worker_threads` worker (`api/modules/bq/parsing/parse.worker.ts`) |
| V1.2.6 | 2 | No LDAP injection | N/A | No LDAP |
| V1.2.7 | 2 | No XPath injection | N/A | No XPath or XML queries |
| V1.2.8 | 2 | LaTeX processors locked down | N/A | No LaTeX |
| V1.2.9 | 2 | Escape regex metacharacters from untrusted data | Pass | Every `new RegExp` is built from code constants (`api/modules/safety/safety-access.ts` `searchNumber` prefixes, `dom/documents/instructions.ts`, `dom/plant/quantities.ts`, `dom/spending/mpesa-sms.ts`); CodeQL runs on every PR (`.github/workflows/codeql.yml`) |
| V1.3.1 | 1 | Sanitise rich HTML input | N/A | No WYSIWYG or HTML input; all text is stored and rendered as text |
| V1.3.2 | 1 | No eval or dynamic code execution | Fixed (D9.1) | No `eval`/`new Function` in our code; the production CSP has no `'unsafe-eval'` (`web/lib/security-headers.ts`); D9.1 found Zod 4 probing `new Function` in the browser and switched it to `jitless` (`web/lib/zod-config.ts`, test `zod-config.test.ts` "never probes eval, which the production CSP blocks") |
| V1.3.3 | 2 | Sanitise data passed to dangerous contexts | Pass | File names sanitised for headers and storage keys (`dom/bq/text.ts` `sanitiseFileName`); spreadsheet cells neutralised against formula injection (`spreadsheetSafeText`, tests in `dom/bq/build.test.ts`); identifiers refused in URLs (`api-test/labour.e2e-spec.ts` "finds exact identifiers through blind indexes and refuses duplicates") |
| V1.3.4 | 2 | Sanitise or refuse scriptable SVG | Pass | Uploads are typed by content and SVG is never accepted (photos: JPEG/PNG/WebP via sharp; documents: PDF, JPEG, PNG, WebP, DOCX, XLSX — `dom/documents/files.ts`; `api-test/documents.e2e-spec.ts` "accepts files by their content only…") |
| V1.3.5 | 2 | Sanitise user Markdown, CSS, XSL or templates | N/A | No user-supplied Markdown, CSS, XSL or BBCode is rendered |
| V1.3.6 | 2 | Prevent SSRF with allowlists | Pass | The server never fetches a user-supplied URL; outbound calls go only to configured hosts (Have I Been Pwned with `redirect: "error"`, Google OIDC discovery for the fixed issuer, S3, Mailpit on loopback, OTLP) — inventory in §5.6 |
| V1.3.7 | 2 | No template injection | Pass | PDFs are code-defined pdfmake documents with user text as text nodes; i18n messages come from the catalogues with user values as ICU arguments only |
| V1.3.8 | 2 | No JNDI injection | N/A | Not a Java application |
| V1.3.9 | 2 | Sanitise memcache input | N/A | No memcache; Valkey keys are SHA-256 digests (`api/modules/identity/auth-security.service.ts` `rateKey`) |
| V1.3.10 | 2 | No format-string injection | Pass | User input is never used as a format string; log messages are constants with structured fields |
| V1.3.11 | 2 | No SMTP/IMAP injection | Pass | Recipients are Zod-validated emails or normalised Kenyan numbers (`api/modules/identity/identity.schemas.ts`); subjects are constants; development mail goes through Mailpit's JSON API (`api/modules/notifications/notification.provider.ts`), not raw SMTP. The production email/SMS provider arrives with D7.3 |
| V1.4.1 | 2 | Memory-safe string and buffer handling | N/A | TypeScript on Node.js (memory-safe runtime); native modules are vetted libraries (sharp/libvips, @node-rs/argon2) kept current by Dependabot |
| V1.4.2 | 2 | Prevent integer overflows | Pass | Money in integer minor units (`BigInt`/PostgreSQL `bigint`) and decimal strings; Zod ranges on every number (e.g. `val/spending.ts`); database CHECK constraints on amounts (INVARIANTS.md) |
| V1.4.3 | 2 | Release memory; no dangling pointers | N/A | Garbage-collected runtime; no manual memory management |
| V1.5.1 | 1 | XML parsers refuse external entities (XXE) | Pass | No general XML parser on user input; SheetJS reads XLSX parts without DTD or external-entity resolution; DOCX/XLSX inspection reads ZIP directories and part names only (`dom/documents/files.ts`, `api/modules/bq/parsing/file-inspection.ts`) |
| V1.5.2 | 2 | Safe deserialisation of untrusted data | Pass | Only JSON (`JSON.parse`, which cannot instantiate types) followed by Zod schemas; no YAML, `v8.deserialize` or class-instantiating deserialisers |

### V2 Validation and Business Logic

11 requirements: 10 Pass, 0 N/A, 1 Fixed in D9.1, 0 Deferred.

| ID | L | Requirement (paraphrased) | Status | Evidence |
|---|---|---|---|---|
| V2.1.1 | 1 | Documented input validation rules | Pass | The shared Zod schemas in `val/*.ts` are the single definition, published as the OpenAPI document generated from them (`api/common/openapi.ts`, `/api/docs/openapi.json`; outline `docs/api/openapi-outline.yaml`) |
| V2.1.2 | 2 | Documented rules for combined data items | Pass | INVARIANTS.md (cross-field and cross-record rules with the constraints and tests enforcing them) and WORKFLOWS.md (state transitions and their preconditions) |
| V2.1.3 | 2 | Documented business limits (per user and global) | Fixed (D9.1) | Consolidated in §5.11 (rate and size limits per feature) with CONFIGURATION.md for configurable ones |
| V2.2.1 | 1 | Positive input validation against expected structure | Pass | Strict Zod schemas on every endpoint (e.g. `identity.schemas.spec.ts` "rejects mass assignment and unsupported roles or permissions") |
| V2.2.2 | 1 | Validation enforced server-side | Pass | Every controller parses with Zod; the database repeats key rules as CHECKs and triggers (`mig/*`, e.g. `api-test/labour.e2e-spec.ts` "enforces the age, consent and ciphertext rules in the database when the API is bypassed") |
| V2.2.3 | 2 | Combinations of data items checked | Pass | Zod refinements and database CHECKs (date ranges, geofences, maker-checker contributor lists — ARCHITECTURE §8 and INVARIANTS.md) |
| V2.3.1 | 1 | Business flows only in the expected order | Pass | Explicit state machines enforced by services and database guards (WORKFLOWS.md; e.g. `api-test/documents.e2e-spec.ts` "logs instructions offline-ready and moves them only through responses") |
| V2.3.2 | 2 | Business limits implemented as documented | Pass | Limits in §5.11 are enforced in code with tests (e.g. `api-test/documents.e2e-spec.ts` "orders revisions, refuses stale, duplicate and out-of-order uploads, and caps versions") |
| V2.3.3 | 2 | Business operations are transactional | Pass | Every command runs in one transaction (`api/modules/identity/tenant-database.service.ts` `run`); ledgers are append-only with reversals |
| V2.3.4 | 2 | Locking prevents double-booking of limited resources | Pass | Row locks and constraints (`SELECT … FOR UPDATE`); `api-test/stores.e2e-spec.ts` "never lets two simultaneous issues of the last stock both succeed (API and direct SQL)" |
| V2.4.1 | 2 | Anti-automation against excessive calls | Pass | Valkey rate limits on authentication, uploads, exports, reports, invitations and reveals (§5.11); the limiter fails closed (`api-test/identity.e2e-spec.ts` "rate-limits atomically in Valkey and fails explicitly when the dependency is unavailable") |

### V3 Web Frontend Security

19 requirements: 11 Pass, 2 N/A, 6 Fixed in D9.1, 0 Deferred.

| ID | L | Requirement (paraphrased) | Status | Evidence |
|---|---|---|---|---|
| V3.2.1 | 1 | Responses cannot render in the wrong context | Pass | Downloads are `Content-Disposition: attachment` with `nosniff` and `default-src 'none'; sandbox` (`api/modules/documents/project-documents.controller.ts`, photo routes `api/modules/progress/photos.controller.ts`); API JSON carries `default-src 'none'` (`api/app.setup.ts`) |
| V3.2.2 | 1 | Text shown as text, never as HTML | Pass | React text rendering everywhere; the only raw-HTML injection writes developer-defined CSS variables (`web/components/ui/chart.tsx`); the CSP blocks injected handlers (`web-test/security-headers.spec.ts`) |
| V3.3.1 | 1 | Cookies Secure with __Host- or __Secure- prefix | Pass | Production names `__Host-pmb_at`, `__Host-pmb_csrf`, `__Secure-pmb_rt`, `__Secure-pmb_oauth`, all `Secure` (`api/modules/identity/auth-security.service.ts` `name`, `setCookie`; test `auth-security.service.spec.ts` "uses production Secure, HttpOnly, SameSite cookies with exact host/path scopes"). Local development over HTTP uses plain names |
| V3.3.2 | 2 | SameSite set per cookie purpose | Pass | All cookies `SameSite=Lax` (Lax is needed for the Google sign-in redirect back); state changes also need the CSRF token and exact Origin (`assertCsrf`) |
| V3.3.3 | 2 | __Host- prefix unless shared with other hosts | Pass | `__Host-` for the access and CSRF cookies. Documented deviation: the refresh and Google cookies are path-scoped (`/api/v1/auth`, `/api/v1/auth/google`), which `__Host-` forbids, so they use `__Secure-` and no Domain; duplicate cookie names are refused rather than guessed (`auth-security.service.spec.ts` "rejects ambiguous duplicate cookies rather than choosing an attacker-controlled value") |
| V3.3.4 | 2 | Session cookies HttpOnly and only set via Set-Cookie | Pass | Every cookie is HttpOnly; session values only travel in `Set-Cookie`; the CSRF token is deliberately readable (double-submit) and is not a session credential (`api-test/identity.e2e-spec.ts` "requires signed CSRF, same Origin, and HttpOnly host-only cookies") |
| V3.4.1 | 1 | HSTS on every response, ≥1 year, includeSubDomains | Fixed (D9.1) | Web: `max-age=63072000; includeSubDomains` on every page and static file in production (`web/proxy.ts`, `web/lib/security-headers.ts`, test `security-headers.test.ts`); API: helmet `max-age=31536000; includeSubDomains` (`api-test/health.e2e-spec.ts` "sets locked-down security headers on API responses"). `preload` is an owner decision (§3) |
| V3.4.2 | 1 | CORS origin fixed or allowlisted | Pass | CORS is not enabled: the browser calls the API same-origin through the Next.js rewrite (D-16) and no `Access-Control-Allow-Origin` is sent (`api/app.setup.ts`) |
| V3.4.3 | 2 | CSP with object-src 'none', base-uri 'none', nonces or allowlist | Fixed (D9.1) | Web had no CSP; now a per-request nonce policy with `'strict-dynamic'`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`, `form-action 'self'`, `connect-src 'self'` (`web/proxy.ts`, `web/lib/security-headers.ts`, `web/app/layout.tsx`; tests `security-headers.test.ts`, `web-test/security-headers.spec.ts`); API `default-src 'none'` |
| V3.4.4 | 2 | X-Content-Type-Options: nosniff on every response | Fixed (D9.1) | Web pages and static files now send it (`web/proxy.ts`; `security-headers.spec.ts` "sends the CSP and security headers on pages and static files"); API via helmet |
| V3.4.5 | 2 | Referrer policy prevents leaking URLs | Fixed (D9.1) | Web `strict-origin-when-cross-origin` (new), API `no-referrer` (helmet); asserted in both header tests |
| V3.4.6 | 2 | CSP frame-ancestors on every response | Fixed (D9.1) | Web `frame-ancestors 'none'` on every page and static file (new), plus `X-Frame-Options: DENY`; API already had it |
| V3.5.1 | 1 | Cross-origin requests to sensitive functions are rejected (anti-CSRF) | Pass | `BrowserGuard` requires the exact Origin, no cross-site `Sec-Fetch-Site` and a signed double-submit token on every non-GET; D9.1 added a test that every controller but health uses it (`api-test/health.e2e-spec.ts`); since D4.2 the Daraja provider callbacks are the one other exception (server to server with the company in the path token, no cookie to forge; `no-store` set by that controller) |
| V3.5.2 | 1 | If relying on CORS preflight, no simple-request bypass | N/A | PM-Buddy does not rely on preflight; it checks Origin and a custom header token on every state change (V3.5.1) |
| V3.5.3 | 1 | Sensitive functions use non-safe methods | Pass | All state changes are POST/PUT/PATCH/DELETE; the only state-changing GET is the Google OIDC callback, which the protocol requires and which is bound to state, nonce and PKCE in an encrypted single-use cookie (`api-test/google.e2e-spec.ts` "refuses tampered, replayed, cookieless and invalid-token callbacks without a session") |
| V3.5.4 | 2 | Separate applications on separate hostnames | Fixed (D9.1) | The office app and the client, supplier and labourer portals are one application with one session (role-based portals by design, ARCHITECTURE §8). The separate Swagger UI is no longer served in production unless explicitly enabled (`api/config/app-config.ts` `apiDocsEnabled`, test `app-config.spec.ts`); prototype and design-system pages are static demos without API access |
| V3.5.5 | 2 | postMessage origin and syntax checked | N/A | No `message` event listeners |
| V3.7.1 | 2 | Only supported client-side technologies | Pass | React 19, Next.js 16 and evergreen browsers; no plugins (and `object-src 'none'`) |
| V3.7.2 | 2 | Redirects to other hosts only on an allowlist | Pass | Only Google's fixed issuer (`GOOGLE_ISSUER`, `api/modules/identity/google-profile.ts`); `next` is same-site only (`web/lib/safe-next.ts`; `api-test/google.e2e-spec.ts` "reports cancellation and keeps next opaque for the web app to sanitise") |

### V4 API and Web Service

10 requirements: 2 Pass, 6 N/A, 0 Fixed in D9.1, 2 Deferred.

| ID | L | Requirement (paraphrased) | Status | Evidence |
|---|---|---|---|---|
| V4.1.1 | 1 | Content-Type matches the body, with charset | Pass | JSON and problem+json with `charset=utf-8` (`api-test/health.e2e-spec.ts` "refuses TRACE and answers errors as problem+json with a charset (ASVS V13.4.4, V4.1.1)"); files with their exact media type (binary); HTML `text/html; charset=utf-8` |
| V4.1.2 | 2 | Only user-facing endpoints redirect HTTP to HTTPS | Deferred (D9.3) | Done at the edge (load balancer/CDN), which D9.3 builds; the API never redirects to HTTPS itself and the web sends HSTS |
| V4.1.3 | 2 | Intermediary headers cannot be overridden by users | Pass | `req.ip` from `X-Forwarded-For` only for proxies listed in `TRUST_PROXY` (`api/config/app-config.ts` `trustProxySetting`, production refuses to start without it, `auth-security.service.spec.ts`); request IDs validated. Edge configuration itself: D9.3 |
| V4.2.1 | 2 | Message boundaries prevent request smuggling | Deferred (D9.3) | Node's HTTP parser rejects conflicting `Content-Length`/`Transfer-Encoding`; the load balancer and CDN configuration is D9.3 |
| V4.3.1 | 2 | GraphQL query cost limits | N/A | No GraphQL |
| V4.3.2 | 2 | GraphQL introspection off in production | N/A | No GraphQL |
| V4.4.1 | 1 | WebSockets over TLS | N/A | No WebSockets (only the development server's hot reload) |
| V4.4.2 | 2 | WebSocket Origin checked | N/A | No WebSockets |
| V4.4.3 | 2 | Dedicated WebSocket tokens | N/A | No WebSockets |
| V4.4.4 | 2 | WebSocket tokens from the HTTPS session | N/A | No WebSockets |

### V5 File Handling

9 requirements: 7 Pass, 0 N/A, 2 Fixed in D9.1, 0 Deferred.

| ID | L | Requirement (paraphrased) | Status | Evidence |
|---|---|---|---|---|
| V5.1.1 | 2 | Documented file types, extensions, sizes and handling per upload feature | Fixed (D9.1) | Consolidated in §5.10 (each upload's types, sizes, archive limits, malware handling and download behaviour) |
| V5.2.1 | 1 | Only files of a processable size are accepted | Pass | Multer limits per feature (`packages/types`: BQ 10 MB, documents 25 MB, procurement documents 10 MB, receipts and GRN photos 5 MB, site photos `PHOTO_LIMITS`), plus parser time, row and cell limits (`workbook-parser.spec.ts` "enforces sheet, row and cell limits and the time limit") |
| V5.2.2 | 1 | Extension and content type verified (also inside archives) | Pass | Types are decided by content only and stored names derive from the detected type (`dom/documents/files.ts`, `api/modules/bq/parsing/file-inspection.ts`; tests "accepts .xlsx zip packages and .xls OLE2 compound files by content", documents "accepts files by their content only…") |
| V5.2.3 | 2 | Archive size and entry count checked before decompression | Pass | ZIP central directory checked first (100 MB uncompressed, ratio 100:1, part count, no ZIP64 or encryption): `file-inspection.spec.ts` "refuses a zip bomb (over 100 MB uncompressed)", "refuses encrypted entries, ZIP64, broken directories and too many parts"; documents use the same limits |
| V5.3.1 | 1 | Uploaded files never executed from a public folder | Pass | Files go to a private object-storage bucket under server-chosen keys and are only streamed back through authorised API routes |
| V5.3.2 | 1 | File paths from internal data, not user file names | Pass | Object keys derive from tenant, project and record IDs (`api/infra/storage.service.ts` callers); user file names are only metadata, sanitised |
| V5.4.1 | 2 | User file names ignored or validated; Content-Disposition names the file | Pass | Downloads set `Content-Disposition` with a server-built name (`contentDisposition`, e.g. `api/modules/reports/report-renderer.ts`, documents download) |
| V5.4.2 | 2 | Served file names encoded (RFC 6266) | Pass | `contentDisposition()` writes an ASCII fallback plus RFC 5987 `filename*` (`dom/bq/text.ts`) |
| V5.4.3 | 2 | Untrusted files scanned by antivirus | Fixed (D9.1) | Every upload goes through the `MalwareScanner` hook; D9.1 added the ClamAV adapter (`MALWARE_SCANNER=clamav`, clamd INSTREAM, fails closed: `api/infra/malware-scanner.ts`, `malware-scanner.spec.ts` "refuses an infected upload", "fails closed when clamd errors, stalls or is unreachable"; checked against a real clamd with the EICAR test file, 14/11/2026). Production refuses the development no-op. Running clamd with signature updates is part of the D9.3 deployment |

### V6 Authentication

35 requirements: 26 Pass, 3 N/A, 6 Fixed in D9.1, 0 Deferred.

| ID | L | Requirement (paraphrased) | Status | Evidence |
|---|---|---|---|---|
| V6.1.1 | 1 | Documented anti-brute-force controls, incl. malicious lockout | Fixed (D9.1) | Consolidated in §5.1 (limits, lockouts, budgets and how malicious lockout is bounded) |
| V6.1.2 | 2 | Documented context-specific words for passwords | Pass | ARCHITECTURE §7 Passwords and §5.3 of this report (product names, the account's identifier and its parts, display name) |
| V6.1.3 | 2 | All authentication pathways documented with their controls | Fixed (D9.1) | §5.1 lists every pathway (password, Google, labourer PIN, TOTP, passkey, recovery code, refresh, password reset) with its controls |
| V6.2.1 | 1 | Passwords ≥ 8 characters (15 recommended) | Pass | Minimum 12 (`api/modules/identity/identity.schemas.ts` `passwordSchema`; `identity.schemas.spec.ts` "enforces password bounds and rejects common passwords without composition requirements") |
| V6.2.2 | 1 | Users can change their password | Fixed (D9.1) | New `POST /api/v1/auth/password/change` and the account console's Change password card (`auth.service.ts` `changePassword`, `web/app/foundation/foundation-console.tsx`; `api-test/passwords.e2e-spec.ts` "changes a password only with the current one and signs out the other sessions (D9.1)") |
| V6.2.3 | 1 | Password change needs the current and new password | Fixed (D9.1) | Same endpoint: 400 `current-password-incorrect` without the right current password (same test) |
| V6.2.4 | 1 | New passwords checked against ≥ 3000 common passwords | Pass | zxcvbn-ts with the common and English dictionaries (tens of thousands of common passwords) must score ≥ 3, plus a local list (`password-policy.ts`; `api-test/passwords.e2e-spec.ts` "refuses weak registrations with a generic, localisable code and stores nothing") |
| V6.2.5 | 1 | No composition rules | Pass | None (`password-policy.spec.ts` "accepts strong passphrases without composition rules") |
| V6.2.6 | 1 | Password fields are type=password | Pass | `web/app/(auth)/sign-in/sign-in-form.tsx`, the account console fields (`foundation-console.tsx`) |
| V6.2.7 | 1 | Paste and password managers allowed | Pass | No paste blocking; fields carry `autoComplete` `current-password`/`new-password` |
| V6.2.8 | 1 | Password verified exactly as entered | Pass | No trimming, truncation or case change (`loginSchema` `z.string().min(1).max(128)`; Argon2id over the raw value) |
| V6.2.9 | 2 | Passwords of ≥ 64 characters allowed | Pass | Up to 128 (`passwordSchema`) |
| V6.2.10 | 2 | No periodic password rotation | Pass | Passwords never expire |
| V6.2.11 | 2 | Context words used to refuse guessable passwords | Pass | `userInputs()` feeds them to zxcvbn (`password-policy.spec.ts` "uses the account's identifier and name as context"; e2e "Wanjiru Kamau 1" and "PMBuddy…" refused) |
| V6.2.12 | 2 | New passwords checked against breached passwords | Fixed (D9.1) | Have I Been Pwned range check (k-anonymity) is now on by default in production (`AppConfig.breachedPasswordCheck`; `password-policy.spec.ts` "selects the breach checker from configuration (on by default in production only)"); applies to registration, reset and change |
| V6.3.1 | 1 | Brute-force controls implemented as documented | Pass | `api-test/identity.e2e-spec.ts` "locks an account after five failed passwords without exposing account existence", "rate-limits by account rather than one shared IP when no trusted proxy is configured"; PIN budgets in `api-test/portals.e2e-spec.ts` |
| V6.3.2 | 1 | No default accounts | Pass | None; the demo seed refuses production (`demo-seed.spec.ts` "refuses to run in production") |
| V6.3.3 | 2 | MFA (or a combination of factors) to access the application | Pass | Documented relaxation (§5.1, D-155): MFA is mandatory for every MFA-required permission (Owner, Finance, admin roles; `api-test/roles.e2e-spec.ts` "makes MFA mandatory for anyone holding a privileged permission") and fresh step-up for sensitive actions; other roles may enrol. Owner decision recorded in §3 |
| V6.3.4 | 2 | No undocumented authentication pathways | Fixed (D9.1) | §5.1 enumerates them; each is tested (identity, google, portals, passkeys e2e suites) |
| V6.4.1 | 1 | Initial secrets random, short-lived, not long-term | Pass | Verification codes 6 random digits, 5 minutes, single use; invitation and reset tokens 256-bit, single use (`api-test/identity.e2e-spec.ts` "caps verification attempts and rejects expired verification credentials") |
| V6.4.2 | 1 | No password hints or secret questions | Pass | None exist |
| V6.4.3 | 2 | Password reset does not bypass MFA | Pass | Reset sets the password and revokes every session; the next sign-in still needs MFA (`api-test/identity.e2e-spec.ts` "resets passwords with single-use tokens and revokes every existing session") |
| V6.4.4 | 2 | Lost MFA factor needs identity proofing like enrolment | Pass | Only a recovery code issued at enrolment replaces a lost factor; there is no weaker path (no SMS or email MFA reset, no support bypass — OR-08) |
| V6.5.1 | 2 | OTPs, TOTPs and lookup secrets usable once | Pass | TOTP counter replay protection and single-use recovery codes (`api-test/identity.e2e-spec.ts` "rejects replayed TOTP codes, including concurrent submissions", "makes recovery codes single use and rotates credentials") |
| V6.5.2 | 2 | Low-entropy lookup secrets stored with a password hash | Pass | Recovery codes have 144 bits (24 base64url characters), above the 112-bit threshold, so SHA-256 storage is allowed; verification codes are stored with Argon2id |
| V6.5.3 | 2 | OTP seeds and lookup secrets from a CSPRNG | Pass | Node `crypto` (`randomBytes`, `randomInt`); TOTP seeds from `otpauth` `Secret` (Web Crypto) |
| V6.5.4 | 2 | Lookup secrets and OOB codes ≥ 20 bits | Pass | Six-digit codes (the requirement's example); recovery codes 144 bits |
| V6.5.5 | 2 | Defined lifetimes: OOB ≤ 10 min, TOTP 30 s | Pass | Verification codes 5 minutes; TOTP period 30 s with one step of clock-drift tolerance, each code accepted once |
| V6.6.1 | 2 | SMS/phone OTP only with validated numbers and stronger options | N/A | Phone OTP is not an authentication factor: codes only prove control of an identifier at registration; MFA is TOTP or passkey |
| V6.6.2 | 2 | OOB codes bound to the original request | Pass | Codes and tokens are bound to the user and purpose; a new code supersedes the old (`auth.service.ts` `sendVerification`) |
| V6.6.3 | 2 | OOB codes rate-limited against guessing | Pass | 5 attempts per code, 10 per 5 minutes and 20 per day per identifier (`api-test/identity.e2e-spec.ts` "caps verification attempts and rejects expired verification credentials") |
| V6.8.1 | 2 | One identity cannot be spoofed via another IdP | Pass | Google identities link by provider and stable subject; email linking only for a verified Google address (`api-test/google.e2e-spec.ts` "refuses a second Google account for an email already linked to another") |
| V6.8.2 | 2 | Assertion signatures always validated | Pass | ID tokens checked by `openid-client` with signature checks against Google's keys (`enableNonRepudiationChecks`, `google-sign-in.service.ts`; e2e "refuses tampered, replayed, cookieless and invalid-token callbacks without a session") |
| V6.8.3 | 2 | SAML assertions used once | N/A | No SAML |
| V6.8.4 | 2 | IdP authentication strength verified when relied on | N/A | PM-Buddy relies on no strength from Google: its own MFA still applies (`api-test/google.e2e-spec.ts` "still requires PM-Buddy MFA after Google for accounts with a factor") |

### V7 Session Management

18 requirements: 10 Pass, 0 N/A, 7 Fixed in D9.1, 1 Deferred.

| ID | L | Requirement (paraphrased) | Status | Evidence |
|---|---|---|---|---|
| V7.1.1 | 2 | Documented inactivity and absolute timeouts with NIST rationale | Fixed (D9.1) | §5.2 |
| V7.1.2 | 2 | Documented concurrent-session policy | Fixed (D9.1) | §5.2 |
| V7.1.3 | 2 | Documented federated session coordination | Fixed (D9.1) | §5.2 (Google sign-in creates an independent PM-Buddy session) |
| V7.2.1 | 1 | Session tokens verified by the backend | Pass | `AuthSecurity.accessClaims` and `AuthService.principal` check the signature and the session row on every request |
| V7.2.2 | 1 | Dynamic session tokens, not static keys | Pass | Per-session signed access tokens and opaque refresh tokens |
| V7.2.3 | 1 | Reference tokens unique, CSPRNG, ≥ 128 bits | Pass | Refresh tokens: 256-bit `randomBytes`, stored as SHA-256 (`opaqueToken`) |
| V7.2.4 | 1 | New session token on (re-)authentication | Pass | Sign-in creates a session; MFA, step-up and refresh rotate credentials and bump the generation (`api-test/identity.e2e-spec.ts` "rotates refresh tokens and revokes the family on replay") |
| V7.3.1 | 2 | Inactivity timeout enforced | Pass | 30 minutes idle (`newSessionData`, checked in `principal`, `refresh`, `issue`) |
| V7.3.2 | 2 | Absolute session lifetime enforced | Pass | 8 hours with MFA, 24 without (`newSessionData`; `api-test/identity.e2e-spec.ts` "rejects expired sessions and stale MFA for sensitive tenant actions") |
| V7.4.1 | 1 | Terminated sessions cannot be used | Pass | Every request checks the session row, so logout or revocation takes effect at once (`api-test/identity.e2e-spec.ts` "signs out with only the refresh cookie once the access token has expired") |
| V7.4.2 | 1 | Sessions end when an account is disabled or removed | Pass | Removing a member revokes their sessions in that company (`api-test/identity.e2e-spec.ts` "removes members, revokes active tenant sessions and preserves the last owner"); there is no account disable/delete feature yet |
| V7.4.3 | 2 | Option to end other sessions after an authentication factor change | Fixed (D9.1) | Password change signs out other sessions unless the user keeps them (D9.1); reset and the first MFA factor sign out all others; the session list lets users end any other session |
| V7.4.4 | 2 | Visible logout on every authenticated page | Pass | Office top-bar account menu, portal header button (`web/components/auth/sign-out-button.tsx`), account console (`web-test/sign-in.spec.ts` signs out from the account menu) |
| V7.4.5 | 2 | Administrators can terminate a user's or all users' sessions | Deferred (D9.3) | Company admins end a member's company sessions by changing their role or removing them; a dedicated "sign out this member" action and the platform-wide revoke belong to the restricted operations view (brief §15 H) in D9.3. Interim procedure: OPERATIONS.md "Key rotation" → emergency session revocation |
| V7.5.1 | 2 | Full re-authentication before changing authentication attributes | Fixed (D9.1) | Password change needs the current password and, with MFA, a fresh step-up (D9.1); adding factors needs a fresh sign-in or step-up (`api-test/passkeys.e2e-spec.ts` "needs a fresh sign-in, or a fresh step-up once the account has a factor"); identifiers cannot be changed |
| V7.5.2 | 2 | Users view sessions and end them after re-authenticating | Fixed (D9.1) | Ending another session now needs a sign-in or MFA within five minutes (403 `reauthentication-required`; `api-test/identity.e2e-spec.ts` "lists and revokes only the caller's sessions") |
| V7.6.1 | 2 | RP/IdP session lifetimes behave as documented | Fixed (D9.1) | §5.2: the PM-Buddy session is independent of the Google session and follows V7.3 |
| V7.6.2 | 2 | Sessions created only by explicit user action | Pass | Google sign-in starts only from the user's click (`GET /auth/google/start`); no silent SSO |

### V8 Authorization

7 requirements: 7 Pass, 0 N/A, 0 Fixed in D9.1, 0 Deferred.

| ID | L | Requirement (paraphrased) | Status | Evidence |
|---|---|---|---|---|
| V8.1.1 | 1 | Documented function- and data-level access rules | Pass | ARCHITECTURE §6 and §8 (permission catalogue, role ∩ project assignment, RLS) |
| V8.1.2 | 2 | Documented field-level access rules | Pass | ARCHITECTURE §8 "Sensitive fields" and the per-module sections (§4.3 labour identifiers, §4.4 payout details, §4.13 confidential documents, §4.12/§4.15 portal views) |
| V8.2.1 | 1 | Function-level access needs explicit permissions | Pass | `AccessPolicy.require` in every service; `api-test/roles.e2e-spec.ts` "applies role ∩ project assignment, while company-wide roles see every project" |
| V8.2.2 | 1 | Data-level access prevents IDOR/BOLA | Pass | Tenant from the session only, forced RLS, composite tenant keys (`api-test/identity.e2e-spec.ts` "forces RLS and policies on every tenant_id table discovered from the database", "rejects cross-tenant SQL reads, writes and composite references") |
| V8.2.3 | 2 | Field-level access prevents BOPLA | Pass | Masked responses and audited reveals (`api-test/labour.e2e-spec.ts` "masks by default; revealing needs labour.view_sensitive and fresh step-up and is audited") |
| V8.3.1 | 1 | Authorisation enforced in a trusted layer | Pass | API services and PostgreSQL RLS; the web only hides controls |
| V8.4.1 | 2 | Cross-tenant controls | Pass | `api-test/identity.e2e-spec.ts` "fails closed without context on every tenant table"; isolation tests in every module suite |

### V9 Self-contained Tokens

7 requirements: 7 Pass, 0 N/A, 0 Fixed in D9.1, 0 Deferred.

| ID | L | Requirement (paraphrased) | Status | Evidence |
|---|---|---|---|---|
| V9.1.1 | 1 | Tokens validated by signature before use | Pass | `jwtVerify` with the configured EdDSA public key (`auth-security.service.ts` `accessClaims`) |
| V9.1.2 | 1 | Algorithm allowlist, no 'none' | Pass | `algorithms: ["EdDSA"]`; JWE `dir` + `A256GCM` only (`sealed-secrets.ts`); `auth-security.service.spec.ts` "…accepts neither unsigned nor wrong-key access credentials" |
| V9.1.3 | 1 | Keys only from trusted configuration | Pass | Keys from configuration; `jku`/`x5u`/`jwk` headers are not used |
| V9.2.1 | 1 | exp/nbf enforced | Pass | jose validates `exp` (10 minutes) and `nbf` |
| V9.2.2 | 2 | Token type and purpose checked | Pass | Access tokens need issuer, audience, `sid` and `generation`; sealed values carry and check a `purpose` (CSRF, Google state, TOTP seed per user) |
| V9.2.3 | 2 | Audience checked | Pass | `audience: "pm-buddy-web"` |
| V9.2.4 | 2 | Audience restriction when a key serves several audiences | Pass | The signing key issues only access tokens for one audience |

### V10 OAuth and OIDC

29 requirements: 7 Pass, 22 N/A, 0 Fixed in D9.1, 0 Deferred.

| ID | L | Requirement (paraphrased) | Status | Evidence |
|---|---|---|---|---|
| V10.1.1 | 2 | Tokens only sent to components that need them | Pass | Google tokens never leave the API (only the ID token claims are used); PM-Buddy tokens live in HttpOnly cookies |
| V10.1.2 | 2 | Authorisation responses bound to the initiating user agent | Pass | State, nonce and PKCE verifier in an encrypted, path-scoped, single-use cookie (`api-test/google.e2e-spec.ts` "starts with PKCE, state and nonce held in an encrypted, path-scoped cookie") |
| V10.2.1 | 2 | Code flow protected by PKCE and state | Pass | PKCE S256 and state (same test) |
| V10.2.2 | 2 | Mix-up defence with several authorisation servers | N/A | One authorisation server (Google) |
| V10.3.1 | 2 | Resource server checks access-token audience | N/A | PM-Buddy accepts no OAuth access tokens |
| V10.3.2 | 2 | Resource server enforces delegated claims | N/A | Not a resource server |
| V10.3.3 | 2 | Resource server identifies users by non-reassignable claims | N/A | Not a resource server |
| V10.3.4 | 2 | Resource server checks authentication strength claims | N/A | Not a resource server |
| V10.4.1 | 1 | Exact redirect URI allowlist | N/A | Not an authorisation server (the Google client's redirect URI is registered at Google) |
| V10.4.2 | 1 | Authorisation codes single use | N/A | Not an authorisation server |
| V10.4.3 | 1 | Short-lived authorisation codes | N/A | Not an authorisation server |
| V10.4.4 | 1 | Only needed grants; no implicit or password grant | N/A | Not an authorisation server (the client uses only the code grant) |
| V10.4.5 | 1 | Refresh-token replay mitigated for public clients | N/A | Not an authorisation server |
| V10.4.6 | 2 | PKCE required by the authorisation server | N/A | Not an authorisation server |
| V10.4.7 | 2 | Dynamic client registration controlled | N/A | Not an authorisation server |
| V10.4.8 | 2 | Refresh tokens have an absolute expiry | N/A | Not an authorisation server (PM-Buddy's own refresh tokens end with the session, V7.3.2) |
| V10.4.9 | 2 | Users can revoke refresh tokens | N/A | Not an authorisation server (PM-Buddy sessions are revocable, V7.5.2) |
| V10.4.10 | 2 | Confidential clients authenticate on back-channel calls | N/A | Not an authorisation server (PM-Buddy authenticates to Google with its client secret) |
| V10.4.11 | 2 | Only required scopes assigned | N/A | Not an authorisation server (the client asks only `openid email profile`) |
| V10.5.1 | 2 | ID token replay prevented (nonce) | Pass | `expectedNonce` checked (`google-sign-in.service.ts` `callback`) |
| V10.5.2 | 2 | Users identified by non-reassignable sub | Pass | `user_identities` keyed by provider and subject (`api-test/google.e2e-spec.ts` "links an existing verified password account…") |
| V10.5.3 | 2 | Issuer metadata impersonation refused | Pass | Discovery for the fixed Google issuer; `openid-client` refuses metadata whose `issuer` differs |
| V10.5.4 | 2 | ID token audience equals the client ID | Pass | `openid-client` validates `aud` (and `iss`, `exp`) in `authorizationCodeGrant` |
| V10.5.5 | 2 | Back-channel logout hardened | N/A | No back-channel logout |
| V10.6.1 | 2 | OP allows only safe response modes | N/A | Not an OpenID Provider |
| V10.6.2 | 2 | OP mitigates forced logout | N/A | Not an OpenID Provider |
| V10.7.1 | 2 | Consent for each authorisation request | N/A | Not an authorisation server |
| V10.7.2 | 2 | Clear consent information | N/A | Not an authorisation server |
| V10.7.3 | 2 | Users can review and revoke consents | N/A | Not an authorisation server |

### V11 Cryptography

14 requirements: 10 Pass, 1 N/A, 3 Fixed in D9.1, 0 Deferred.

| ID | L | Requirement (paraphrased) | Status | Evidence |
|---|---|---|---|---|
| V11.1.1 | 2 | Documented key-management policy and lifecycle | Fixed (D9.1) | §5.5 and OPERATIONS.md "Key rotation" (generation, custody, rotation, retirement, escrow for restores, destruction, who may hold keys) |
| V11.1.2 | 2 | Cryptographic inventory | Fixed (D9.1) | §5.5 (every key, algorithm, library, where it may and may not be used) |
| V11.2.1 | 2 | Industry-validated crypto implementations | Pass | Node `crypto` (OpenSSL), `jose`, `@node-rs/argon2`, `@simplewebauthn/server`, `openid-client`; nothing hand-rolled (ARCHITECTURE §7 D-03) |
| V11.2.2 | 2 | Crypto agility (keys and algorithms replaceable) | Fixed (D9.1) | Versioned field envelopes and, since D9.1, versioned `AUTH_MFA_ENCRYPTION_KEY` (`kid`) with `keys:rotate rewrap` (`api-test/key-rotation.e2e-spec.ts`); PIN pepper versioned; format bytes and JWE headers allow algorithm changes |
| V11.2.3 | 2 | ≥ 128-bit security for all primitives | Pass | AES-256-GCM, HMAC-SHA-256, Ed25519, Argon2id |
| V11.3.1 | 1 | No ECB or weak encryption padding | Pass | Only AES-GCM; no RSA encryption (passkey RS256 is signature verification for compatibility) |
| V11.3.2 | 1 | Approved ciphers and modes (AES-GCM) | Pass | `field-cipher.ts`, `sealed-secrets.ts` |
| V11.3.3 | 2 | Encrypted data protected against modification | Pass | GCM tags with associated data binding company, table, column and row (`api-test/labour.e2e-spec.ts` "fails to decrypt with the wrong key, another row or a tampered value") |
| V11.4.1 | 1 | Only approved hash functions | Pass | SHA-256 and HMAC-SHA-256; SHA-1 only inside the Have I Been Pwned range protocol (a lookup, not a security function) and HMAC-SHA-1 in RFC 6238 TOTP for authenticator compatibility; no MD5 |
| V11.4.2 | 2 | Passwords stored with a tuned password hash | Pass | Argon2id 19 MiB, t=2, p=1 (OWASP) (`identity.schemas.spec.ts` "uses salted Argon2id hashes and verifies without custom crypto") |
| V11.4.3 | 2 | Collision-resistant hashes ≥ 256 bits for integrity | Pass | SHA-256 for file integrity, audit hash chain and token digests |
| V11.4.4 | 2 | Key stretching when deriving keys from passwords | N/A | No key is derived from a password (HKDF derives company keys from random master keys) |
| V11.5.1 | 2 | Non-guessable values from a CSPRNG, ≥ 128 bits | Pass | `randomBytes(32)` tokens, 128-bit CSP nonces (`web/lib/security-headers.ts` `createNonce`), 96-bit GCM nonces per encryption; UUIDs are never secrets |
| V11.6.1 | 2 | Approved algorithms for key generation and signatures | Pass | Ed25519 (`jose`/OpenSSL); WebAuthn EdDSA, ES256, RS256 verification |

### V12 Secure Communication

9 requirements: 1 Pass, 1 N/A, 0 Fixed in D9.1, 7 Deferred.

| ID | L | Requirement (paraphrased) | Status | Evidence |
|---|---|---|---|---|
| V12.1.1 | 1 | Only TLS 1.2/1.3, 1.3 preferred | Deferred (D9.3) | TLS terminates at the edge built in D9.3 |
| V12.1.2 | 2 | Only recommended cipher suites | Deferred (D9.3) | Edge configuration (D9.3) |
| V12.1.3 | 2 | mTLS client certificates validated | N/A | No mTLS |
| V12.2.1 | 1 | TLS for all external HTTP services, no fallback | Deferred (D9.3) | Application part done: production refuses a non-HTTPS `WEB_ORIGIN` (`auth-security.service.spec.ts` "fails closed on missing production keys…") and sends HSTS; the TLS endpoint is D9.3 |
| V12.2.2 | 1 | Publicly trusted certificates | Deferred (D9.3) | Certificates are issued with the edge (D9.3) |
| V12.3.1 | 2 | TLS for all inbound and outbound connections (DB, cache, storage, monitoring) | Deferred (D9.3) | Connection URLs come from configuration; production must use TLS for PostgreSQL, Valkey, object storage and OTLP (D9.3). Outbound HIBP and Google calls are HTTPS |
| V12.3.2 | 2 | TLS clients validate certificates | Pass | Node defaults; certificate checks are never disabled (no `rejectUnauthorized: false` or `NODE_TLS_REJECT_UNAUTHORIZED`) |
| V12.3.3 | 2 | TLS between internal HTTP services | Deferred (D9.3) | Web → API (`API_INTERNAL_URL`) runs over the private network today; TLS or a service mesh is decided in D9.3 |
| V12.3.4 | 2 | Internal TLS uses trusted certificates | Deferred (D9.3) | D9.3 |

### V13 Configuration

13 requirements: 3 Pass, 0 N/A, 3 Fixed in D9.1, 7 Deferred.

| ID | L | Requirement (paraphrased) | Status | Evidence |
|---|---|---|---|---|
| V13.1.1 | 2 | All communication needs documented | Fixed (D9.1) | §5.6 |
| V13.2.1 | 2 | Backend component communication authenticated | Deferred (D9.3) | The API authenticates to PostgreSQL (role passwords), Valkey and object storage; issuing per-service production credentials is D9.3 |
| V13.2.2 | 2 | Least privilege for backend accounts | Pass | `pmb_app` has DML only and no BYPASSRLS (`api-test/identity.e2e-spec.ts` "uses a non-owner, non-superuser role without BYPASSRLS"); the schema owner is used only by migrations and `keys:rotate`, which refuses any other role (`KeyRotation.assertOwner`) |
| V13.2.3 | 2 | No default credentials between services | Deferred (D9.3) | Local development uses documented throwaway credentials (`infra/docker/compose.yaml`); production credentials come from the secrets manager (D9.3) |
| V13.2.4 | 2 | Allowlist of external resources the app may reach | Deferred (D9.3) | The application only calls the hosts in §5.6; network egress enforcement is D9.3 |
| V13.2.5 | 2 | Server-level allowlist for outbound requests | Deferred (D9.3) | Egress firewall or proxy (D9.3) |
| V13.3.1 | 2 | Secrets in a secrets manager, not in code or builds | Deferred (D9.3) | No secrets in the repository (gitleaks in CI, `.env.example` placeholders); keys are environment variables until the KMS/secrets manager decision (D-30, OR-09), D9.3 |
| V13.3.2 | 2 | Least privilege for secret access | Deferred (D9.3) | Part of the secrets manager (D9.3); §5.5 lists who may hold each key |
| V13.4.1 | 1 | No source-control metadata deployed | Deferred (D9.3) | No deployment artefacts exist yet; the D9.3 images must exclude `.git` |
| V13.4.2 | 2 | Debug modes off in production | Fixed (D9.1) | Next.js production builds have no development overlay or `'unsafe-eval'`; API errors never include stacks; Swagger UI now off in production by default (`app-config.spec.ts` "hides the API docs in production unless explicitly enabled") |
| V13.4.3 | 2 | No directory listings | Pass | Neither Next.js nor NestJS lists directories; buckets are private |
| V13.4.4 | 2 | HTTP TRACE not supported | Pass | Unknown methods get 404 problem+json (`api-test/health.e2e-spec.ts` "refuses TRACE and answers errors as problem+json with a charset…") |
| V13.4.5 | 2 | Documentation and monitoring endpoints not exposed unless intended | Fixed (D9.1) | API docs off in production unless `API_DOCS_ENABLED=true`; `/api/v1/health/live` and `/ready` are intentionally public for load balancers and hide error details in production (ARCHITECTURE §19); restricting `/ready` to the internal network is noted for D9.3 |

### V14 Data Protection

9 requirements: 5 Pass, 0 N/A, 4 Fixed in D9.1, 0 Deferred.

| ID | L | Requirement (paraphrased) | Status | Evidence |
|---|---|---|---|---|
| V14.1.1 | 2 | Sensitive data identified and classified | Fixed (D9.1) | §5.4 |
| V14.1.2 | 2 | Protection requirements per classification level | Fixed (D9.1) | §5.4 |
| V14.2.1 | 1 | Sensitive data only in bodies or headers, never URLs | Pass | Session tokens only in cookies; identifiers looked up through request bodies and refused in query strings (`api-test/labour.e2e-spec.ts`, D-36); request logs drop query strings (`logging.spec.ts`). Documented exception: one-time invitation and PIN-reset links carry a single-use, 15-minute (reset) 256-bit token in the query string, as SMS and email links must; mitigated by `Referrer-Policy`, hashing at rest and expiry (A-131) |
| V14.2.2 | 2 | Sensitive data not cached in server components | Pass | API responses are `no-store`; the dashboard's 60-second cache is per caller in process memory and expires (`api/modules/reports/dashboard.service.ts`) |
| V14.2.3 | 2 | Sensitive data not sent to untrusted parties | Pass | No analytics or trackers; OpenStreetMap tiles only in development (D-10); Have I Been Pwned receives five SHA-1 characters |
| V14.2.4 | 2 | Data protection controls implemented as documented | Pass | Field encryption, masking, minimisation and audit per §5.4 with their tests (labour, procurement, documents e2e suites) |
| V14.3.1 | 1 | Authenticated data cleared from the client after sign-out | Fixed (D9.1) | Sign-out now loads `/sign-in` as a new document, dropping the client router cache (`web/components/top-bar.tsx`, `sign-out-button.tsx`); nothing is kept in browser storage; every authenticated response is `no-store` (V14.3.2) |
| V14.3.2 | 2 | Anti-caching headers on sensitive responses | Fixed (D9.1) | `no-store` on every API route (tested for all controllers) and on dynamic pages; client-portal photo images changed from `max-age=300` to `no-store` (`api-test/client-portal.e2e-spec.ts`) |
| V14.3.3 | 2 | No sensitive data in browser storage | Pass | Only the theme (localStorage) and the locale cookie |

### V15 Secure Coding and Architecture

13 requirements: 9 Pass, 0 N/A, 4 Fixed in D9.1, 0 Deferred.

| ID | L | Requirement (paraphrased) | Status | Evidence |
|---|---|---|---|---|
| V15.1.1 | 1 | Documented remediation time frames for vulnerable components | Fixed (D9.1) | §5.8, enforced by the new `pnpm audit --prod --audit-level high` CI job (`.github/workflows/security.yml`) |
| V15.1.2 | 2 | SBOM maintained; components from trusted repositories | Fixed (D9.1) | CycloneDX SBOM of production dependencies produced by CI (`pnpm sbom`, artifact `sbom-cyclonedx`); lockfile pins the npm registry; Dependabot with a 7-day cooldown |
| V15.1.3 | 2 | Documented resource-demanding functionality and its protections | Fixed (D9.1) | §5.9 |
| V15.2.1 | 1 | Components within the remediation time frames | Pass | `pnpm audit --prod` on 14/11/2026: no high or critical; one moderate (minimatch in the shadcn CLI) and one low with no fix (deepmerge in the shadcn CLI), both inside their windows |
| V15.2.2 | 2 | Defences for resource-demanding functionality | Pass | Rate limits, size and row caps, worker-thread BQ parsing with time and memory limits, bounded report queries (§5.9) |
| V15.2.3 | 2 | No test or development functionality in production | Fixed (D9.1) | Development notification transport, malware no-op and Google issuer override are refused in production (`auth-security.service.spec.ts`, `malware-scanner.spec.ts`); API docs off by default (D9.1). Prototype and design-system pages remain as labelled static demos (owner decision, §3) |
| V15.3.1 | 1 | Only the required fields are returned | Pass | Responses are built explicitly and parsed with response schemas; the e2e wire-contract check parses every success (`api-test/support.ts` `responseContract`) |
| V15.3.2 | 2 | Backend does not follow redirects unless intended | Pass | Have I Been Pwned `redirect: "error"`; web server-side API calls `redirect: "error"` (`web/lib/server-api.ts`) |
| V15.3.3 | 2 | Mass-assignment protection | Pass | `.strict()` request schemas (`identity.schemas.spec.ts` "rejects mass assignment and unsupported roles or permissions") |
| V15.3.4 | 2 | Original client IP from trusted fields only | Pass | `TRUST_PROXY` (V4.1.3) |
| V15.3.5 | 2 | Strict typing and comparisons | Pass | TypeScript strict mode, Zod types at every boundary, `===` only (oxlint/ESLint) |
| V15.3.6 | 2 | Prototype-pollution resistant code | Pass | `JSON.parse` creates own properties only; strict Zod schemas refuse unknown keys such as `__proto__`; no deep-merge of untrusted objects |
| V15.3.7 | 2 | HTTP parameter pollution handled | Pass | Express 5's simple query parser; scalar Zod schemas refuse repeated parameters (arrays) |

### V16 Security Logging and Error Handling

16 requirements: 7 Pass, 0 N/A, 6 Fixed in D9.1, 3 Deferred.

| ID | L | Requirement (paraphrased) | Status | Evidence |
|---|---|---|---|---|
| V16.1.1 | 2 | Log inventory documented | Fixed (D9.1) | §5.7 |
| V16.2.1 | 2 | Log entries carry when, where, who and what | Fixed (D9.1) | Request logs now name the user, session and company (`api/common/logging.ts` `requestLogProps`, `logging.spec.ts` "names the verified user, session and company, never an identifier") besides time, request ID, method, path, status and address |
| V16.2.2 | 2 | Synchronised time; UTC timestamps | Deferred (D9.3) | Application part done: pino writes epoch-millisecond UTC times; clock synchronisation of hosts is D9.3 |
| V16.2.3 | 2 | Logs only go to documented destinations | Fixed (D9.1) | §5.7: stdout (pino JSON) and the optional OTLP exporter only |
| V16.2.4 | 2 | Common, machine-readable log format | Pass | pino JSON |
| V16.2.5 | 2 | Sensitive data logged according to protection level | Pass | Redaction paths for credentials and identifiers (`api/common/logging.ts` `REDACT_PATHS`, `logging.spec.ts`); security events carry IDs only (`api-test/passwords.e2e-spec.ts` "logs authentication outcomes as security events without identifiers or secrets") |
| V16.3.1 | 2 | All authentication operations logged | Fixed (D9.1) | New `SecurityEvent` log entries for sign-in success/failure/lockout (password, PIN, Google), MFA (TOTP, passkey, recovery code), password reset and change, refresh-token reuse, logout and session revocation (`api/modules/identity/security-events.ts`; same test) |
| V16.3.2 | 2 | Failed authorisation attempts logged | Fixed (D9.1) | 401, 403 and 429 responses are logged at `warn` with the actor (`requestLogLevel`, `logging.spec.ts` "logs refused authentication, authorisation and rate limits as warnings") |
| V16.3.3 | 2 | Documented security events and bypass attempts logged | Fixed (D9.1) | §5.7 lists them: CSRF and Origin refusals (403), validation failures (400), rate limits (429), database guard refusals mapped to problems, plus the hash-chained audit log for business actions |
| V16.3.4 | 2 | Unexpected errors and control failures logged | Pass | The problem filter logs every 5xx with its trace ID (`api/common/problem-details.filter.ts`); dependency failures (Valkey limiter, storage, Google discovery) are logged |
| V16.4.1 | 2 | Log injection prevented | Pass | Structured JSON (pino escapes values); inbound request IDs validated |
| V16.4.2 | 2 | Logs protected from access and modification | Deferred (D9.3) | Log storage and access control are part of D9.3 |
| V16.4.3 | 2 | Logs sent to a separate system | Deferred (D9.3) | Log shipping and alerting are D9.3 |
| V16.5.1 | 2 | Generic error messages, no internals | Pass | `problem-details.filter.spec.ts` "never exposes internal error messages", "hides details of 5xx HTTP exceptions" |
| V16.5.2 | 2 | Secure operation when external resources fail | Pass | Rate limiting fails closed (503); breached-password lookups fail open with a warning by design; readiness reports dependencies; Google discovery retries; payment-provider degradation drills follow in D9.2 |
| V16.5.3 | 2 | Fail securely; no fail-open on exceptions | Pass | Exceptions end the transaction and return a problem; authorisation and database guards deny by default |

### V17 WebRTC

7 requirements: 0 Pass, 7 N/A, 0 Fixed in D9.1, 0 Deferred.

| ID | L | Requirement (paraphrased) | Status | Evidence |
|---|---|---|---|---|
| V17.1.1 | 2 | TURN restricts reserved addresses | N/A | No WebRTC |
| V17.2.1 | 2 | DTLS keys managed by policy | N/A | No WebRTC |
| V17.2.2 | 2 | Approved DTLS suites and SRTP profile | N/A | No WebRTC |
| V17.2.3 | 2 | SRTP authentication checked | N/A | No WebRTC |
| V17.2.4 | 2 | Media server resilient to malformed SRTP | N/A | No WebRTC |
| V17.3.1 | 2 | Signalling server rate-limited | N/A | No WebRTC |
| V17.3.2 | 2 | Signalling server resilient to malformed messages | N/A | No WebRTC |
