# PM-Buddy: Threat Model

> **Status:** Phase 0 draft for approval (D0). This is a living document. It is refreshed at the end of every deliverable and formally reviewed in **D9.1**.
>
> Related: [ARCHITECTURE](./ARCHITECTURE.md) · [ERD](./ERD.md) · [ROADMAP](./ROADMAP.md) · [DPIA template](./DPIA_TEMPLATE.md) · [Questions](./QUESTIONS.md) · [Compliance TODO](./COMPLIANCE_TODO.md)
>
> **Conventions.** "§14.4" means section 14.4 of [ARCHITECTURE.md](./ARCHITECTURE.md). "D4.2" is a deliverable in [ROADMAP.md](./ROADMAP.md). Entity names such as `AttendanceEvent` come from [ERD.md](./ERD.md). Configuration keys marked *proposed* are not yet in the configuration register and must be added there when the control is built.

---

## 1. Scope, method and maintenance

### 1.1 Scope

**In scope**

- Every container in §3: web app, API, worker and outbox relay, PostgreSQL behind PgBouncer, Redis, object storage, KMS or secrets manager, and the malware scanner hook.
- Field devices: the offline-first site app on supervisor phones, shared kiosk tablets, and biometric terminals (§12, §13).
- Integrations: Safaricom Daraja (§14), Africa's Talking USSD and SMS (§16), and WhatsApp, email and push (§15).
- CI/CD and the software supply chain (§20, §21), and platform administration (§4 `platform` module, §6.1 `pmb_platform` role).
- **Business processes where fraud is the main threat** (brief §2): muster roll, payroll, payouts, procurement and stores, petty cash, and progress and valuations.

**Out of scope for now** (revisit when decided): the chosen cloud provider's shared-responsibility controls (Phase 9), physical security of offices and sites, the internal security of Safaricom and Africa's Talking, and the future KRA eTIMS integration.

### 1.2 Method

1. **STRIDE per element.** For each element in the trust-boundary diagram (§4 of this document), we consider **S**poofing, **T**ampering, **R**epudiation, **I**nformation disclosure, **D**enial of service and **E**levation of privilege. Only credible, material threats are listed. Generic hygiene is covered by the ASVS mapping in §7.
2. **Domain abuse cases.** Misuse by legitimate insiders, and collusion between them, that STRIDE tends to miss: ghost workers, buddy punching, material theft and unrecorded cash. Each abuse case lists prevention, detection and the evidence the system keeps.
3. **Residual risk** is the risk that remains once the listed mitigations are built:

| Rating | Meaning | Required action |
|---|---|---|
| **L** | Unlikely, or limited impact | Accept and monitor |
| **M** | Plausible with material impact. Mitigations depend on detection, process or a pending decision | Track and review each phase |
| **H** | Plausible with severe impact (money, biometrics, cross-tenant data) and not yet adequately mitigated by the design | Reduce, or get explicit owner acceptance, before the relevant go-live gate |

IDs are stable. Threats are `T-xx`, abuse cases are `A-xx`, actors are `TA-xx`, trust boundaries are `TB-x` and open risks are `OR-xx`. Retired IDs are marked "retired" and never reused.

### 1.3 How to maintain this document

- **Every deliverable** (part of the definition of done): review the rows touched by new tables, endpoints, offline record types, roles, permissions or integrations. Add new IDs and update the residual rating and phase columns.
- **Out-of-cycle review** is triggered by: a new external integration or provider, a new capture method or biometric vendor, a new category of personal data, a change of hosting region, a security incident or near miss, a pen-test finding, or a change in Kenyan law or ODPC guidance.
- **Formal review in D9.1**, alongside the ASVS Level 2 checklist and pen-test preparation. The output is version 1.0, signed off by the product owner.
- **A mitigation counts as implemented only when it has a test** (see §8). Until then it is "designed".
- **Owner:** the engineering lead, until a security lead is appointed.

---

## 2. Assets (ranked)

| Rank | Asset | Why it matters | Where it lives | Main threats |
|---|---|---|---|---|
| 1 | **Money and payout integrity** | Direct loss. B2C and B2B payouts are effectively irreversible. | `PayrollBatch`, `Payment`, `PaymentProviderRequest`, the tenant's M-Pesa float | Float drain, duplicate payouts, payee swaps, forged callbacks |
| 2 | **M-Pesa (Daraja) credentials** | Whoever holds the consumer key and secret plus the initiator credential can pay out from a tenant's float **outside PM-Buddy** | KMS or secrets manager (`PaymentChannel.secret_ref`); OAuth tokens in Redis | Secret leakage, insiders, CI compromise |
| 3 | **Biometric templates** | Sensitive personal data that cannot be changed once leaked | `BiometricTemplate` (separate KEK), encrypted kiosk roster, terminals | Theft, function creep, vendor SDK exfiltration |
| 4 | **PII**: ID numbers, phones, KRA PINs, bank details, NSSF and SHA numbers, next of kin | Identity theft, SIM-swap targeting, loan-app fraud | `*_enc` columns and blind indexes, exports, notifications | Insider export, IDOR, backups |
| 5 | **Payroll data** | Wages, deductions and advances: both confidentiality and integrity | `PayrollLine`, `Timesheet`, `Advance` | Padding, disclosure, tampering |
| 6 | **Audit log integrity** | Evidence for disputes, fraud investigations and the ODPC | `AuditLog` (append-only, hash-chained) | Deletion, rewriting, gaps |
| 7 | **BQ and valuation integrity** | Decides what clients pay. Diaspora clients depend on it. | `BqVersion`, `ProgressMeasurement`, `Valuation`, `PaymentCertificate` | Manipulation, unapproved edits |
| 8 | **Photo and document evidence integrity** | Proof of delivery, progress and cash payments | Object storage, `Photo`, `File`, `GrnPhoto` | Reuse, substitution, EXIF forgery |
| 9 | **Availability of site sync** | Attendance and GRNs must never be lost, because wages depend on them | Device outbox, `/sync` API, queues | Device loss, sync storms, outages |
| 10 | **Tenant isolation** | A cross-tenant breach would end the platform's credibility | RLS, composite FKs, cache keys, storage paths | IDOR, RLS gaps, cache key mix-ups |

> Tenant isolation is ranked last only because its controls are structural (§6). Any isolation failure multiplies the impact on every other asset.
>
> **Supporting assets:** session and refresh tokens, device keys (Ed25519), KEKs and DEKs, blind-index keys, effective-dated statutory and payment configuration (§11), and USSD PINs.

---

## 3. Threat actors

| ID | Actor | Motivation | Access and capability | Assets at risk |
|---|---|---|---|---|
| TA-01 | **External attacker** | Money, data for resale, extortion | Internet only: credential stuffing, phishing, scanning, known CVEs | 1, 2, 4, 10 |
| TA-02 | **Malicious or compromised tenant user** | Personal gain, covering up mistakes | A valid account with some permissions in one tenant | 1, 5, 6, 7 |
| TA-03 | **Colluding foreman and workers** | Pay for days not worked, splitting ghost wages | Runs the muster roll and holds the site devices | 1, 5 |
| TA-04 | **Dishonest storekeeper colluding with a supplier** | Resell materials, bill for goods never delivered | Records GRNs and stock movements on a site device | 1, 7, 8 |
| TA-05 | **Insider finance clerk** | Divert payouts, hide cash | Prepares payroll, edits payee records, reconciles | 1, 4, 5 |
| TA-06 | **Compromised or lost site device** | Opportunistic thief or a rogue holder | Physical access, possibly a rooted phone | 3, 4, 9 |
| TA-07 | **Malicious other tenant** | Competitive intelligence, poaching workers, fraud | A valid account in a different tenant | 4, 10 |
| TA-08 | **Platform insider** (operator staff or contractor) | Curiosity, bribery, resale | Infrastructure, platform admin, CI | 2, 3, 4, 6 |
| TA-09 | **SIM-swap attacker** | Take over a victim's phone number | Social engineering of, or collusion with, mobile operator agents | 1, 4 |
| TA-10 | **Fake callback sender** | Make unpaid look paid, trigger releases | Can reach webhook URLs; knows Daraja payload formats | 1 |

---

## 4. Trust boundaries

```mermaid
flowchart TB
  subgraph Z0["Untrusted: internet and phone networks"]
    BRW["Browsers: office, client, supplier, platform admin"]
    PHONE["Labourer feature phone"]
    ANY["Any internet host"]
  end
  subgraph Z1["Partly trusted: field devices"]
    SAPP["Site app on supervisor phone"]
    KIOSK["Kiosk tablet with on-device matching"]
    TERM["Biometric terminal"]
  end
  subgraph Z2["Third-party providers"]
    DAR["Safaricom Daraja"]
    AT["Africa's Talking SMS and USSD"]
    MSG["WhatsApp, email and push providers"]
  end
  subgraph Z3["Edge"]
    WAF["CDN and WAF"]
    HOOK["Webhook ingress with IP allowlist"]
  end
  subgraph Z4["Application tier"]
    WEB["Next.js web"]
    API["NestJS API"]
    WRK["Worker and outbox relay"]
    BIO["Biometrics module, separate key identity"]
  end
  subgraph Z5["Data tier"]
    PG[("PostgreSQL with RLS")]
    RDS[("Redis")]
    OBJ[("Object storage, private buckets")]
  end
  subgraph Z6["Key custody"]
    KMS["KMS and secrets manager"]
  end
  subgraph Z7["Build and operate"]
    CI["GitHub Actions and image registry"]
    OPS["Platform operators"]
  end

  BRW -->|"TB-1 HTTPS, cookies, CSRF token"| WAF
  ANY -.->|"TB-1 hostile traffic"| WAF
  ANY -.->|"TB-5 forged callbacks"| HOOK
  WAF --> WEB
  WEB -->|"same-origin rewrite"| API
  SAPP -->|"TB-2 bearer token and device proof"| WAF
  KIOSK -->|"TB-2 signed offline records"| WAF
  WAF --> API
  API -.->|"TB-2 encrypted site roster"| KIOSK
  TERM -->|"TB-3 vendor push protocol"| HOOK
  PHONE -->|"TB-4 USSD and SMS"| AT
  AT -->|"TB-5 webhooks"| HOOK
  DAR -->|"TB-5 unsigned callbacks"| HOOK
  HOOK --> API
  WRK -->|"TB-6 outbound TLS"| DAR
  WRK -->|"TB-6 outbound TLS"| AT
  WRK -->|"TB-6 outbound TLS"| MSG
  API -->|"TB-7 tenant-scoped transaction"| PG
  WRK -->|"TB-7 tenant-scoped transaction"| PG
  API --> RDS
  WRK --> RDS
  API -->|"pre-signed URLs only"| OBJ
  WRK --> OBJ
  API --> BIO
  BIO -->|"TB-8 biometric KEK only"| KMS
  API -->|"TB-8 tenant KEK and Daraja secrets"| KMS
  WRK -->|"TB-8 unwrap and secrets"| KMS
  CI -->|"TB-9 signed images and migrations"| API
  OPS -->|"TB-10 audited platform role"| API
```

| Boundary | What crosses it | Key controls |
|---|---|---|
| **TB-1** Internet → edge, web and API | Browser sessions, credentials, uploads | TLS, WAF, authentication, MFA and CSRF (§7), security headers (§18), rate limits |
| **TB-2** Field devices ↔ API | Sync batches, photos and signed offline records up; rosters, approvals and configuration down | Device binding (§7), Ed25519 record signatures (§12.2), verification and dedupe (§12.3), clock checks (§12.5) |
| **TB-3** Biometric terminal → webhook ingress | Punches in the vendor's push protocol | `AttendanceDeviceAdapter`, device registry and anomaly rules (§13) |
| **TB-4** Labourer phone → Africa's Talking | USSD input including ID and PIN; SMS | Menu design and PIN lockout (§7, §16) |
| **TB-5** Providers and the internet → webhook ingress | Daraja callbacks; Africa's Talking USSD, SMS and delivery webhooks; WhatsApp webhooks | Callback hardening (§14.4), WAF and IP allowlist (§20), USSD handling (§16) |
| **TB-6** Worker → providers | Payout instructions, message content | Secrets by reference (§14.1), provider interfaces (§15), outbox (§4) |
| **TB-7** Application tier → data tier | SQL with tenant context, cache entries, objects | RLS and database roles (§6.1), data rules (§9), file pipeline (§17) |
| **TB-8** Application tier → key custody | DEK unwrap, Daraja secrets | Envelope encryption and a separate biometric KEK (§10), per-tenant channels (§14.1) |
| **TB-9** CI/CD → runtime | Container images, migrations, mobile builds | SBOM, Trivy, cosign and manual production approval (§20) |
| **TB-10** Platform operators → tenant data | Platform admin actions, `pmb_platform` jobs | Database roles (§6.1), `platform` module (§4), audit (§9) |

---

## 5. STRIDE analysis per element

Columns: **ID**, **element**, **STRIDE** category, **threat**, **mitigation** (with ARCHITECTURE references), **residual** risk (L/M/H, see §1.2) and the **phase** (ROADMAP deliverable) that delivers the control. Where a control is not yet in ARCHITECTURE it is marked **Gap** and must be added in the named deliverable.

### 5.1 Web app (`apps/web`: office, client and supplier portals)

| ID | Element | STRIDE | Threat | Mitigation | Residual | Phase |
|---|---|---|---|---|---|---|
| T-01 | Web app | S | Credential stuffing or phishing of Owner and Finance accounts in order to approve payouts | Argon2id, breached-password blocklist, lockout and rate limits; mandatory TOTP or passkey MFA for Owner, Finance and Admin; step-up for approvals; session list with revoke (§7) | M: TOTP can be phished; prefer passkeys for approvers (OR-16) | D1.3 |
| T-02 | Web app | T, E | Stored XSS from imported or user text (BQ descriptions from Excel, diary notes, supplier names) used to act as the victim | React output encoding; lint ban on raw HTML injection; strict nonce-based CSP; httpOnly cookies so tokens cannot be read by script; Zod validation (§7, §18) | L | D1.2, D2.2 |
| T-03 | Web app | T | CSRF against state-changing calls (approve payroll, change a payee) | SameSite cookies, same-origin rewrites (D-16), double-submit `X-CSRF-Token`, Origin and Referer checks (§7) | L | D1.3 |
| T-04 | Web app | T | Clickjacking of approval screens | `frame-ancestors 'none'`; the approval dialog re-fetches amount and payee count from the server (§18) | L | D1.2 |
| T-05 | Web app | I | Payslips or PII left on shared or cyber-café computers (browser cache, PWA cache, downloaded exports) | Service worker caches the app shell only; `Cache-Control: no-store` on personal-data responses; masked fields by default (§8); shorter sessions for privileged roles (§7); exports through short-lived URLs (§17) | M | D1.2, D1.3 |
| T-06 | Web app | E | Client or supplier portal user reaches office functions by URL or direct API calls | Route groups are presentation only; every API call passes the policy guard with external-membership scope (§6.3, §8) | L | D1.4, D7.1, D7.2 |
| T-07 | Web app | I | A third-party script (analytics, chat widget, CDN library) reads page data | No third-party scripts on authenticated pages; self-hosted assets; nonce CSP (§18); dependency review (§21) | L | D1.2 |

### 5.2 API (`apps/api`, NestJS)

| ID | Element | STRIDE | Threat | Mitigation | Residual | Phase |
|---|---|---|---|---|---|---|
| T-08 | API | E | Broken object-level authorisation (IDOR): reading or changing another project's or tenant's records by ID | Tenant only from the session `tid`; project policy guard; fail-closed RLS; composite tenant FKs; generated tenant-isolation suite (§6.1, §6.3, §8) | L | D1.4 |
| T-09 | API | E | Mass assignment or property-level authorisation gaps: a client sets `status`, `approved_by`, `tenant_id` or a rate, or reads masked fields | Strict Zod schemas that reject unknown keys; state changes only through domain commands; response DTOs mask sensitive fields without `*.view_sensitive` (§6.1, §8) | L | D1.4 |
| T-10 | API | S | Forged or replayed access token | `jose` with pinned EdDSA/ES256; 10-minute TTL; `sid` checked against revoked sessions; rotating refresh tokens with reuse detection (§7) | L | D1.3 |
| T-11 | API | D | Resource and cost exhaustion: OTP SMS pumping, expensive exports, huge BQ imports, unbounded lists | Redis rate limits per identifier, IP and device; OTP quotas (§7); heavy work queued (§3); size and page caps; SMS spend alerts (§19) | M: SMS pumping costs real money | D1.3, D2.2, D9.2 |
| T-12 | API | R | An approver denies approving a payroll or changing a payee | Append-only, hash-chained audit with actor, IP, device and before/after (§9); `Approval.action_hash` binds step-up MFA to the entity and amount (§7) | L | D1.4, D4.3 |
| T-13 | API | T | Replayed or double-submitted financial requests create duplicates | `Idempotency-Key` required on financial endpoints and stored with the request hash in `IdempotencyRecord` (§14.4) | L | D4.2 |
| T-14 | API | I | Stack traces, SQL errors or PII in responses and logs | Problem+JSON without internals; pino redaction paths for phones, IDs, tokens and biometric fields; Sentry scrubbing (§19) | L | D1.1 |
| T-15 | API | T | Formula injection in CSV and Excel exports (statutory CSVs, reports) opened by Finance | Escape cells that start with `=`, `+`, `-`, `@`, tab or carriage return. **Gap:** add to §17 in D2.2 | L once added | D2.2, D8.1 |

### 5.3 Worker and queues (BullMQ, schedulers, outbox relay)

| ID | Element | STRIDE | Threat | Mitigation | Residual | Phase |
|---|---|---|---|---|---|---|
| T-16 | Worker/queues | T | A forged or altered job in Redis triggers a payout | Jobs carry IDs only. Before any payout the worker re-reads PostgreSQL and re-checks the approval chain, state machine and limits (§4 rule 2, §14.2, §14.3) | L | D4.2 |
| T-17 | Worker/queues | T | At-least-once delivery runs a payout job twice | Unique `OriginatorConversationID` and idempotency key per provider request; monotonic transitions; retries only after Transaction Status confirms "not processed" (§14.4, §14.5) | L | D4.2 |
| T-18 | Worker/queues | E | A job runs without tenant context and writes across tenants | Jobs carry `tenant_id` and set `app.tenant_id` per transaction; the worker uses `pmb_app`, so RLS applies; `pmb_platform` only for named, audited jobs (§6.1) | L | D1.4 |
| T-19 | Worker/queues | E | A malicious upload exploits a parser (Excel zip bomb, image decoder bug) | Quarantine, magic-byte sniffing, ClamAV hook, size limits (§17); sandboxed Excel parsing (D-13); thumbnails made in a low-privilege process | M | D2.2, D6.1 |
| T-20 | Worker/queues | I | SSRF from HTML-to-PDF rendering in headless Chromium reaches cloud metadata or internal services | Render trusted templates only, JavaScript off, block every network request except bundled assets, no user-supplied URLs. **Gap:** record in ARCHITECTURE when D-15 is decided | M until decided | D2.2 |
| T-21 | Worker/queues | D | Backlog (sync storm after connectivity returns, callback bursts, report jobs) delays payouts and OTPs | Separate queues and concurrency per priority (payments, OTP, sync, reports); backlog in readiness checks; queue-depth alerts (§19) | M | D9.2 |

### 5.4 PostgreSQL

| ID | Element | STRIDE | Threat | Mitigation | Residual | Phase |
|---|---|---|---|---|---|---|
| T-22 | PostgreSQL | E | RLS bypass through a new table without a policy, a view owned by the table owner, a `SECURITY DEFINER` function or a privileged connection | `ENABLE` and `FORCE` RLS; CI migration check; isolation suite generated from the model list; `pmb_app` without `BYPASSRLS` (§6.1); views created with `security_invoker`; definer functions only after review | L | D1.4 |
| T-23 | PostgreSQL | T | Audit log or append-only ledgers altered, or rows deleted | `pmb_app` has `INSERT`/`SELECT` only on `audit_log` and no `UPDATE`/`DELETE` on append-only tables (§6.1, §9); per-tenant hash chain verified on a schedule; chain heads exported to write-once storage (OR-07) | M: whoever holds `pmb_migrator` could still rewrite history | D1.4, D9.1 |
| T-24 | PostgreSQL | I | Backups, replicas or ad-hoc dumps expose PII and payroll | Sensitive fields are ciphertext in every copy (§10); encrypted backups with restricted access; restore drills use the same controls (§20); no production dumps on laptops | M | D9.3 |
| T-25 | PostgreSQL | T | SQL injection through raw SQL (reports, RLS helpers, search) | Prisma parameterised queries; raw SQL only through tagged templates; CodeQL (§21) | L | D1.1 |
| T-26 | PostgreSQL | D | Connection exhaustion or slow report queries starve financial transactions | PgBouncer transaction pooling (§3); statement timeouts per role; heavy reports on a read replica (§9) | M | D9.2 |

### 5.5 Object storage

| ID | Element | STRIDE | Threat | Mitigation | Residual | Phase |
|---|---|---|---|---|---|---|
| T-27 | Object storage | I | ID photos, worker photos or receipts exposed by a public bucket or a long-lived link | Private buckets; short-lived pre-signed GET only after an authorisation check (§17); tenant-prefixed object keys; bucket policy checked in IaC | L | D1.1, D3.1 |
| T-28 | Object storage | T | Malware, polyglot or oversized upload; spoofed content type | Pre-signed PUT constrained by type, size and SHA-256; quarantine; magic-byte sniffing; ClamAV hook (§17) | L | D3.1 |
| T-29 | Object storage | T, R | An evidence photo (GRN, progress, cash receipt) is swapped after approval | Objects are immutable (new evidence means a new object); SHA-256 kept in `File` and `Photo` and re-checked (§12.7, §17); object lock or versioning on evidence buckets (OR-07) | M | D6.1, D9.3 |
| T-30 | Object storage | I | EXIF GPS in shared photos reveals workers' or clients' locations | Metadata stripped from shared variants; original metadata kept in the database only (§17) | L | D6.1 |

### 5.6 Redis

| ID | Element | STRIDE | Threat | Mitigation | Residual | Phase |
|---|---|---|---|---|---|---|
| T-31 | Redis | I, T | Exposed Redis lets an attacker read USSD sessions or Daraja OAuth tokens, or tamper with queues and rate-limit counters | Private network only, AUTH and TLS (§3); no PII beyond the session minimum (§16); OAuth tokens short-lived (§14.1); payout jobs re-validated against PostgreSQL (T-16) | M | D1.1, D9.3 |
| T-32 | Redis | D | Redis outage or eviction resets rate limits and loses queued jobs | The outbox in PostgreSQL is the source of truth (§4); `noeviction` and persistence for queues; authentication endpoints fail closed if the limiter is unavailable | M | D9.2 |
| T-33 | Redis | I | Cache entries shared across tenants because a key lacks `tenant_id` | A cache wrapper that requires tenant-prefixed keys; authorisation results cached per request only (§8) | L | D1.4 |

### 5.7 Site app and device (supervisor phones)

| ID | Element | STRIDE | Threat | Mitigation | Residual | Phase |
|---|---|---|---|---|---|---|
| T-34 | Site app & device | S | A stolen or borrowed supervisor phone is used to submit attendance, GRNs or stock issues | Device binding with a Keystore key and proof-of-possession; refresh token in SecureStore; app unlock with PIN or BiometricPrompt (§7); remote revoke (§12.6) | M | D3.2 |
| T-35 | Site app & device | T | Offline records edited in local storage before sync, on a rooted phone | SQLCipher (§12.1); Ed25519 signature per record with the device key (§12.2); server verifies signatures and `device_seq` continuity (§12.3) | M: keys can be extracted from rooted phones without hardware-backed storage | D3.2 |
| T-36 | Site app & device | S | GPS spoofing with a mock-location app | Mock-location flag recorded and flagged (§12.2); server-side geofence and impossible-travel rules (§13); device attestation (OR-10) | M | D3.3 |
| T-37 | Site app & device | T | Device clock changed to back-date or forward-date records | Anchors `(serverTime, elapsedRealtime, bootId)` and GNSS time; `CLOCK_DRIFT` and `TIME_UNVERIFIED` flags; server receipt time always stored (§12.5) | L | D3.3 |
| T-38 | Site app & device | I | A lost device leaks roster PII and photos | Encrypted SQLite (§12.1); app-private photo storage (§12.7); roster limited to the fields the site needs; local data purged on revoke at next contact (§12.6) | M | D3.2 |
| T-39 | Site app & device | R | A supervisor denies confirming a check-in or an override | `AttendanceEvent.confirmed_by_user_id`, device signature, mandatory override reason, audit (§12.2, §13) | L | D3.3 |
| T-40 | Site app & device | S | A fake or repackaged site app (sideloaded APK) harvests credentials | Signed builds distributed through Play or MDM; device enrolment only by a PM-provisioned QR code (§12.6); app attestation (OR-10) | M | D3.2 |

### 5.8 Kiosk tablet (shared, on-device matching)

| ID | Element | STRIDE | Threat | Mitigation | Residual | Phase |
|---|---|---|---|---|---|---|
| T-41 | Kiosk tablet | S | Presentation attack (photo, video or mask) to clock in absent workers | Liveness detection; configurable match threshold; below it, card + photo + supervisor; `low_confidence` anomaly (§13) | M: depends on the SDK's liveness quality (OR-03) | D3.4 |
| T-42 | Kiosk tablet | E | Escape from kiosk mode to settings or other apps; sideloading tools | Android lock-task mode with device-owner or MDM (§12.6, OR-02); USB debugging disabled; supervisor unlock with PIN plus BiometricPrompt (§7) | M until the MDM decision | D3.2 |
| T-43 | Kiosk tablet | I | Encrypted roster templates extracted from a stolen tablet | Templates encrypted on the device with a Keystore-held key; only this site's roster present; purged on roster change, revoke or deletion (D-17, §10, §13) | M | D3.4 |
| T-44 | Kiosk tablet | D | Tablet broken, stolen or flat, blocking check-in and causing wage disputes | Mandatory fallback method on any supervisor phone (§13); offline queue and visible sync status (§12.8) | L | D3.3 |

### 5.9 Biometric terminals (ZKTeco-style push)

| ID | Element | STRIDE | Threat | Mitigation | Residual | Phase |
|---|---|---|---|---|---|---|
| T-45 | Biometric terminals | S | A spoofed terminal posts punches. Vendor push protocols often identify devices by serial number only, sometimes over plain HTTP | Terminal registered as a `Device` bound to one site; per-device secret in the push URL; TLS-terminating gateway; per-site IP allowlist where possible; anomaly rules on every punch (§12.6, §13) | **H** until the vendor protocol is assessed (OR-03) | D3.4 |
| T-46 | Biometric terminals | E | Terminal admin menu misused: default password, local enrolment of extra people, template export over USB | Vendor due diligence; admin password rotated; local enrolment and USB export disabled; terminal user list reconciled with the roster daily (§13) | M | D3.4 |
| T-47 | Biometric terminals | I | Templates kept on the terminal in vendor format, possibly unencrypted | Vendor assessment recorded in the DPIA; prefer devices with encrypted storage; deletions pushed to terminals and confirmed (§13) | M | D3.4 |

### 5.10 USSD and SMS (Africa's Talking)

| ID | Element | STRIDE | Threat | Mitigation | Residual | Phase |
|---|---|---|---|---|---|---|
| T-48 | USSD/SMS | S | Direct calls to the USSD webhook with a forged `phoneNumber` to probe accounts or guess PINs | Path token and IP allowlist on the webhook (§20); ID + PIN required whatever the phone number; lockout (§16) | M | D7.3 |
| T-49 | USSD/SMS | S | Distributed PIN guessing across many ID numbers | Argon2id PIN hashes; lockout per labourer and per MSISDN; weak PINs refused; supervisor-assisted reset with OTP (§7, §16) | M | D7.3 |
| T-50 | USSD/SMS | I | Pay details seen on shared handsets or by bystanders | Minimal content; no ID numbers in SMS; only the worker's own data (§16); worker chooses the language (§15) | M | D7.3 |
| T-51 | USSD/SMS | D | Toll fraud or SMS pumping through OTP or USSD-triggered messages | Rate limits per number and per tenant (§7); daily SMS budget per tenant with alerts (§19) | M | D1.3, D7.3 |

### 5.11 Daraja callbacks and outbound calls

| ID | Element | STRIDE | Threat | Mitigation | Residual | Phase |
|---|---|---|---|---|---|---|
| T-52 | Daraja | S | A forged result callback marks an unpaid payout as paid, or a client STK payment as received | Unguessable channel and per-request URL tokens; IP allowlist; matching to a stored pending request only; unknown callbacks stored as `unmatched` and alerted; amount and shortcode compared with the request (§14.2, §14.4) | L | D4.2 |
| T-53 | Daraja | T | A genuine callback replayed or delivered out of order | Unique M-Pesa receipt constraint; monotonic state transitions; duplicates recorded as `duplicate` (§14.4) | L | D4.2 |
| T-54 | Daraja | I | Leaked consumer key and secret, initiator password or passkey let someone pay out from the float outside PM-Buddy | Secrets only in the KMS or secrets manager, by reference; write-only in the UI; `SecurityCredential` built at call time (§14.1); redaction (§19); statement lines with no PM-Buddy request raise a critical alert (A-08) | M | D4.2, D4.3 |
| T-55 | Daraja | D | Daraja slow or down; timeouts leave payouts in limbo | Outbox, retries with backoff, timeout followed by Transaction Status, visible status (§14.2, §14.3) | L | D4.2, D9.2 |
| T-56 | Daraja | T | C2B payments against guessed or closed account references | The validation URL checks open invoice and project codes and limits (§14.4 item 6) | L | D7.1 |
| T-57 | Daraja | R | A worker or supplier disputes receiving a payout | Raw callbacks kept (redacted), receipt numbers, name check, daily reconciliation, SMS payslip with the M-Pesa reference (§14.3, §14.5) | L | D4.3 |

### 5.12 Notification providers (WhatsApp, email, push, SMS delivery)

| ID | Element | STRIDE | Threat | Mitigation | Residual | Phase |
|---|---|---|---|---|---|---|
| T-58 | Notification providers | S | Spoofed delivery-receipt or WhatsApp webhook calls | WhatsApp webhook signatures verified with the app secret; path token and IP allowlist for Africa's Talking; receipts only change notification status (§15) | L | D7.3 |
| T-59 | Notification providers | I | Personal data exposed through message content held by providers | Minimal templates with no ID numbers, KRA PINs or full bank details; data-processing terms with each provider; providers listed in the DPIA (§15) | M | D7.3 |
| T-60 | Notification providers | S | Phishing SMS or WhatsApp messages that imitate PM-Buddy ("approve payment here") | Registered sender ID; no login or approval links in SMS; approvals only inside the app with step-up; passkeys for approvers (§7, §15) | M | D7.3, D9.1 |
| T-61 | Notification providers | S | OTP intercepted through SIM swap, SS7 abuse or a shared phone | OTP is never the only second factor for Owner, Finance or Admin; six digits, five-minute expiry, hashed and rate-limited (§7); see A-22 | M | D1.3 |

### 5.13 CI/CD and supply chain

| ID | Element | STRIDE | Threat | Mitigation | Residual | Phase |
|---|---|---|---|---|---|---|
| T-62 | CI/CD & supply chain | T | Malicious or typosquatted npm package, or a compromised native biometric SDK | Lockfile, dependency review, OSV-Scanner, CodeQL, SBOM (syft), Trivy (§20, §21); native SDKs pinned by checksum and reviewed before upgrade | M | D1.1, D3.4 |
| T-63 | CI/CD & supply chain | I | Secrets committed to the repo or printed in CI logs | gitleaks; `.env.example` only; masked CI secrets; OIDC federation to the cloud instead of long-lived keys, confirmed with the cloud choice (§20, §21) | L | D1.1 |
| T-64 | CI/CD & supply chain | E | A compromised workflow (unpinned action, `pull_request_target` misuse) ships a malicious image | Protected `main` with required checks; actions pinned by commit SHA; least-privilege `GITHUB_TOKEN`; cosign-signed images verified at deploy; manual approval for production (§20) | M | D1.1, D9.3 |
| T-65 | CI/CD & supply chain | E | Dev-only components reach production: `apps/mock-daraja`, the static dev KEK, sandbox credentials | Production images exclude mock apps; a startup guard refuses a static KEK or mock provider in production (§10, §20); environment-scoped secrets | L | D1.1, D4.2 |

### 5.14 Platform admin

| ID | Element | STRIDE | Threat | Mitigation | Residual | Phase |
|---|---|---|---|---|---|---|
| T-66 | Platform admin | E | An operator uses `pmb_platform` (bypasses RLS) to read tenant PII or payroll | No generic data browser in the `platform` module (§4); `pmb_platform` used only by named, audited jobs (§6.1); break-glass access time-boxed, dual-approved and visible to the tenant; the biometric KEK is not usable by platform identities (§10) | M | D1.4, D9.1 |
| T-67 | Platform admin | S | Takeover of a platform super-admin account | Mandatory passkey or TOTP; short sessions (§7); admin access from allowlisted networks (to decide in D9.1) | M | D1.3 |
| T-68 | Platform admin | T | Platform-level configuration (Safaricom IP allowlist, statutory seed rules) changed silently | Configuration changes need a permission plus maker-checker and are audited; rules that are not approved show warnings (§11) | L | D1.4, D4.1 |
| T-69 | Platform admin | I | A "log in as tenant user" support feature is abused | Not built by default. If needed: granted by the tenant, time-limited, read-only, bannered and audited (OR-08) | M | D9.1 |

---

## 6. Domain abuse cases

These are misuse cases by people with legitimate access, often colluding. The design goal from brief §2 is to make them **hard to do and visible when tried**. Detections raise an `Alert` (one inbox, ERD §10) or an `AttendanceAnomaly`. "Evidence" lists what the system keeps to support an investigation or dispute.

| ID | Abuse case (actors) | Prevention | Detection | Evidence kept | Phase |
|---|---|---|---|---|---|
| A-01 | **Ghost workers**: fictitious or departed workers kept on the roll, with wages sent to accomplices (TA-03, TA-05) | One record per ID number per tenant via `Labourer.id_number_bidx`; ID photo and live photo at registration; under-18 block; the registrar cannot prepare payroll; pay only from attendance with capture evidence (§10, §13) | Several workers sharing one M-Pesa number (`phone_bidx`); a worker's number matching a staff member's; B2C receiver-name mismatch (§14.5); workers never seen by biometric or photo capture; surprise headcounts against the muster roll | `Labourer`, `Consent`, `AttendanceEvent.photo_id`, `Payment.name_check`, `Alert` | D3.1, D3.3, D4.3 |
| A-02 | **Buddy punching**: workers or the foreman clock in absent colleagues (TA-03) | Card + live photo + supervisor confirmation; face kiosk with liveness where the worker consented; one event per worker per window; site-registered devices only (§13) | Sampled photo review; duplicate rule; bursts of check-ins on one device; low-confidence and liveness flags; anomaly rate per foreman | `AttendanceEvent` (`match_confidence`, `liveness_score`, `confirmed_by_user_id`), `AttendanceAnomaly` | D3.3, D3.4 |
| A-03 | **Payroll padding**: extra days or overtime (TA-03, TA-05) | Timesheets derived from events by configured rules only; overrides need a reason and are always flagged; timesheets lock at approval (§13); maker-checker (§8); rules effective-dated (§11) | Overtime outliers against gang and site norms; overrides per supervisor; site diary workforce vs attendance; payroll lines without source events | `TimesheetLine.source_event_ids`, `Approval`, audit before/after values | D3.3, D4.1, D4.3 |
| A-04 | **Worker's M-Pesa number changed just before payout** (TA-05, TA-02, TA-09) | Payee change needs step-up MFA (§7) and a second approver; worker present with card and photo; SMS to the old and new numbers; hold before the first payout to a new number (*proposed* `payments.payee_change_hold_hours`) | "New recipient + large amount" rule (§14.5); changes shortly before a payout; many changes by one user; name check on the first payout | Audit (blind-index values only, never plaintext), `Approval`, `Notification` | D3.1, D4.3 |
| A-05 | **Duplicate payouts** through a bug, retry, re-approval or the same worker in two batches | Idempotency keys and unique provider IDs; monotonic state machine; retries only after Transaction Status (§14.2, §14.4, §14.5); one payroll line per worker per pay period; a work date can be paid only once across projects | `duplicate_payment` alert; daily reconciliation; the same worker and date in two batches | `PaymentProviderRequest`, `PaymentCallback`, `ReconciliationItem` | D4.2, D4.3 |
| A-06 | **Callback spoofing or replay** (TA-10) | All §14.4 layers: URL tokens, IP allowlist, matching to a pending request, unique receipt, monotonic states; amount and shortcode checked against the request | Unmatched callbacks alerted; non-allowlisted source IPs; amount mismatches; reconciliation | `PaymentCallback` (`source_ip`, `raw_redacted`, `match_status`) | D4.2 |
| A-07 | **STK phone masking**: the payer uses another phone, the callback MSISDN is masked, or someone claims another person's payment | Never key on the phone number; match on `CheckoutRequestID` and `MerchantRequestID`; amount and account reference must match; client-side "paid" ignored (§14.2, §14.4) | STK Query for stale requests; statement reconciliation; amount mismatches | `PaymentProviderRequest`, `PaymentCallback` | D4.2, D7.1 |
| A-08 | **Float drain** through stolen credentials or insider payouts (TA-01, TA-05, TA-08) | Daraja secrets only in the KMS, write-only (§14.1); B2C only for approved batches, re-checked by the worker; per-transaction, daily and per-recipient limits; step-up; unusual-payout rules (§14.5); just-in-time float top-ups (tenant policy) | Balance falls faster than expected outflow; **B2C results or statement lines with no PM-Buddy request mean a payout was made outside the system**: critical alert | `Reconciliation`, unmatched `PaymentCallback`, `Alert` | D4.2, D4.3 |
| A-09 | **Inflated GRN or short delivery** (TA-04) | Line-by-line count; photos of delivery note, goods and vehicle; GPS and time; quantity capped at the LPO unless approved; three-way match before payment (brief §5.3, §17) | Theoretical vs actual consumption variance; stock-take variance; GRNs outside the geofence or working hours; the same delivery-note photo hash reused | `Grn`, `GrnLine`, `GrnPhoto`, `ThreeWayMatch`, `StockTakeLine` | D5.2, D5.3 |
| A-10 | **Supplier and storekeeper collusion**: invoices for goods never delivered, split orders, fake competing quotes, inflated prices (TA-04) | Minimum number of quotes (`procurement.min_quotes`) with a selection reason; storekeepers cannot approve LPOs or invoices; approval limits; supplier payee changes controlled as in A-25 | Price-change alerts against price history; one supplier always wins; quoting suppliers sharing a phone, KRA PIN or bank blind index; orders just under approval limits | `Rfq`, `Quotation`, `MaterialPrice`, `Alert` | D5.1, D5.2, D5.3 |
| A-11 | **Fake receipts and petty-cash abuse** | Receipt photo required; the M-Pesa SMS parser fills in the reference; approver is not the custodian; float limits; periodic cash counts | The same receipt hash or M-Pesa reference on two expenses; amounts just under thresholds; count variances | `Expense` (`receipt_file_id`, `mpesa_ref`), `File.sha256`, `PettyCashCount` | D5.4 |
| A-12 | **Unrecorded or fictitious cash payments** | Cash needs a reason, a photo or signature and an approver (§14.5); the worker gets an SMS acknowledgement with a way to dispute; per-worker cash cap (*proposed* `payments.cash.max_per_worker_period`, OR-06) | Cash share by site and foreman; workers with attendance but no payment; repeated cash to one worker; disputes through USSD or SMS | `Payment` (`method = cash`, `evidence_file_id`, `reason`), `Approval`, `Notification` | D4.3, D7.3 |
| A-13 | **Old or reused progress photos** | The verified badge needs in-app capture, EXIF GPS inside the geofence, EXIF time consistent with device and server time, and a matching hash (§12.7, §17) | Duplicate SHA-256; perceptual-hash similarity to earlier photos (**Gap:** add in D6.1); gallery imports shown as unverified | `Photo` (`verified`, `verification_reasons`, `sha256`) | D6.1 |
| A-14 | **GPS spoofing or mock location** | Mock-location flag (§12.2); server-side geofence check; kiosks fixed to one site (§12.6); device attestation (OR-10) | `mock_location` and `impossible_travel` anomalies; implausibly constant accuracy values | `AttendanceEvent` (`mock_location`, `accuracy_m`), `AttendanceAnomaly` | D3.3 |
| A-15 | **Device clock tampering** | Monotonic anchors and GNSS time; server receipt time always stored (§12.5) | `clock_drift` and `time_unverified` anomalies; gaps in `device_seq` | `AttendanceEvent` (`device_time`, `elapsed_realtime_ms`, `boot_id`), `DeviceSyncState` | D3.3 |
| A-16 | **Maker-checker bypass by role stacking**: one person, or one shared login, holds prepare, review and approve | One user cannot act at two steps of the same entity (DB trigger, §8); role assignment blocks conflicting permissions on the same project unless the Owner accepts with a reason (OR-04); MFA bound to a personal factor | Segregation-of-duties report; different users approving from the same device or session fingerprint minutes apart | `Approval`, `MembershipRole`, `Session`, audit | D1.4, D4.3 |
| A-17 | **Approval by a compromised account** | Step-up MFA bound to the approval ID and amount (§7); passkeys preferred for approvers (OR-16); approval limits (§8); the Owner is notified of every payout approval | Approvals from a new device or IP, from abroad, or outside business hours; refresh-token reuse; unusual-payout rules (§14.5) | `Approval` (`step_up_mfa_at`, `action_hash`), `Session`, audit | D1.3, D4.3 |
| A-18 | **Insider PII export**: lists of IDs and phone numbers sold to loan apps or SIM-swap gangs | Masked by default; unmasking needs `labour.view_sensitive`, step-up and a reason (§8); exports exclude full ID numbers unless explicitly permitted; volume limits; watermarked files | Audit of `export` and reveal events; alerts on volume or off-hours activity | `AuditLog` (`action = export`), export jobs | D3.1, D8.1 |
| A-19 | **Tenant data leakage through IDOR** (TA-07) | Defence in depth (§6.1); authorisation never relies on unguessable IDs (UUIDv7 is time-ordered); signed URLs only after authorisation (§17) | Isolation suite in CI; spikes of 403/404 per user; RLS `WITH CHECK` violations alerted | Test reports, logs, audit | D1.4 onwards |
| A-20 | **Biometric template theft or misuse** (TA-08, TA-06, vendor) | Separate KEK that only the biometrics identity can unwrap (§10, OR-01); no export API; encrypted on-device roster (D-17); SDK network egress blocked; deletion after engagement ends (§13) | KMS unwrap audit and volume alerts; template access logs; device revocations | KMS logs, `AuditLog`, deletion log | D3.4 |
| A-21 | **USSD PIN brute force** | Argon2id PINs; lockout after a configurable number of failures; per-ID and per-MSISDN throttles; weak PINs refused (§7, §16) | Failure-rate alerts; one MSISDN trying many IDs | USSD authentication events in the audit log | D7.3 |
| A-22 | **OTP interception or SIM swap** (TA-09) | OTP is never enough for privileged roles; their recovery needs recovery codes or an assisted check (§7); payouts go only to the registered number and every B2C result is name-checked (§14.5); operator SIM-swap check if available (OR-12) | Name mismatches; worker disputes; login from a new device soon after a recovery | `Payment.name_check`, `Session`, audit | D1.3, D4.3 |
| A-23 | **BQ or valuation manipulation** | Approved BQ versions are immutable; changes only by VO linked to an instruction and approved; measurements need photos and approval; quantity to date capped at BQ plus approved VOs; valuations snapshot rule versions (§11) | Measured progress vs material consumption and labour-hours; jumps in % complete; version diff report; the client sees verified evidence | `BqVersion`, `VariationOrder`, `ProgressMeasurement`, `Valuation.rule_snapshot` | D2.2, D2.3, D6.3 |
| A-24 | **Deleting or rewriting the audit trail** | App role can only insert and select (§6.1); hash chain (§9); chain heads exported to write-once storage (OR-07); DDL on audit partitions only by the migrator under dual control | Scheduled chain verification; sequence gaps; alerts on DDL against audit tables | Chain verification reports | D1.4, D9.1 |
| A-25 | **Supplier payee details changed** (Paybill, Till or bank) before an invoice is paid | As A-04: step-up, second approver, confirmation through a known supplier contact, hold period | Payment to recently changed details; change notifications in the supplier portal | `Supplier` audit, `Approval` | D5.1, D5.2 |
| A-26 | **Fuel and plant theft**: fuel issued beyond use, hire days inflated | Fuel issues tied to a plant item with a meter-reading photo; hire days from usage logs | Consumption per hour against norms; fuel issued while plant was idle | `FuelIssue`, `PlantUsage` | D8.3 |
| A-27 | **Advance abuse**: advances to ghost or departing workers that are never recovered | Advances go through maker-checker with per-worker limits and a recovery plan | Outstanding advances on inactive workers; repeated advances | `Advance`, `AdvanceRecovery` | D4.1, D4.3 |

---

## 7. Security requirements traceability

### 7.1 OWASP ASVS

The brief targets **ASVS Level 2**. The current major version is **ASVS 5.0**. The exact version (for example 5.0.x) is **pinned in D9.1**, when the requirement-level checklist is produced. Version 5.0 renumbered requirements compared with 4.0.3, so this table maps at chapter level only.

| ASVS 5.0 chapter | PM-Buddy controls | ARCHITECTURE | Related IDs | First verified |
|---|---|---|---|---|
| V1 Encoding and Sanitization | React output encoding, no raw HTML, parameterised SQL, formula escaping in exports | §9, §18 | T-02, T-15, T-25 | D1.2, D2.2 |
| V2 Validation and Business Logic | Shared Zod schemas; state machines; maker-checker; approval limits; anomaly rules; idempotency | §8, §13, §14 | T-09, A-03, A-05, A-16 | D1.4, D3.3, D4.3 |
| V3 Web Frontend Security | Nonce-based CSP, HSTS, `frame-ancestors 'none'`, `__Host-` cookies, SameSite | §7, §18 | T-02, T-04, T-07 | D1.2 |
| V4 API and Web Service | OpenAPI contract, problem+JSON, webhook hardening, `Idempotency-Key` | §14.4, §16, §21 | T-13, T-48, T-52 | D1.1, D4.2 |
| V5 File Handling | Constrained pre-signed uploads, quarantine, magic bytes, malware scan, private buckets | §17 | T-19, T-27, T-28 | D3.1, D6.1 |
| V6 Authentication | Argon2id, breached-password check, TOTP and passkeys, OTP limits, USSD PIN lockout | §7 | T-01, T-49, T-61 | D1.3, D7.3 |
| V7 Session Management | Short access tokens, rotating refresh tokens with reuse detection, session revoke, device binding | §7 | T-10, T-34 | D1.3, D3.2 |
| V8 Authorization | RBAC with project scope, RLS, composite FKs, sensitive-field masking, step-up | §6, §8 | T-08, T-22, A-19 | D1.4 |
| V9 Self-contained Tokens | JWT with pinned algorithms, short TTL, claim checks, action-bound step-up token | §7 | T-10, A-17 | D1.3 |
| V10 OAuth and OIDC | Daraja OAuth client-credential token caching; applies more widely if an external IdP is chosen (D-03) | §7, §14.1 | T-54 | D4.2 |
| V11 Cryptography | AES-256-GCM envelope encryption, KMS-held KEKs, separate biometric KEK, HMAC blind indexes, Ed25519 device signatures, vetted libraries only | §10, §12.2 | T-35, A-20 | D1.3, D3.1, D3.4 |
| V12 Secure Communication | TLS everywhere, including Redis and PostgreSQL connections; HSTS | §18, §20 | T-31 | D1.1, D9.3 |
| V13 Configuration | Secrets manager, no secrets in the repo, production guards, hardened images, governed business configuration | §11, §14.1, §20 | T-63, T-65, T-68 | D1.1, D9.1 |
| V14 Data Protection | Field-level encryption, masking, minimisation, retention and deletion jobs, `no-store` caching, DPIA | §8, §10, §17 | T-05, T-24, A-18 | D3.1, D3.4 |
| V15 Secure Coding and Architecture | Module boundaries (dependency-cruiser), dependency hygiene, SBOM, safe concurrency | §4, §20, §21 | T-17, T-62 | D1.1 |
| V16 Security Logging and Error Handling | Hash-chained audit, log redaction, Sentry scrubbing, security alerts | §9, §19 | T-12, T-14, A-24 | D1.4 |
| V17 WebRTC | Not applicable: no WebRTC is planned | n/a | n/a | n/a |

### 7.2 OWASP API Security Top 10 (2023)

| Item | PM-Buddy controls | Related IDs |
|---|---|---|
| **API1:2023** Broken Object Level Authorization | Tenant only from the session; project policy guard; fail-closed RLS; composite tenant FKs; generated isolation suite (§6) | T-08, T-22, A-19 |
| **API2:2023** Broken Authentication | Argon2id; mandatory MFA for privileged roles; OTP limits; rotating refresh tokens; device proof-of-possession; USSD PIN lockout (§7, §16) | T-01, T-10, T-49 |
| **API3:2023** Broken Object Property Level Authorization | Strict Zod input schemas that reject unknown keys; masked response DTOs without `*.view_sensitive` (§8) | T-09, A-18 |
| **API4:2023** Unrestricted Resource Consumption | Rate limits; page, size and upload caps; heavy work queued; SMS spend alerts (§7, §17, §19) | T-11, T-21, T-51 |
| **API5:2023** Broken Function Level Authorization | `@RequirePermission` on every route, deny by default; authorisation matrix tests generated from the permission catalogue (§8) | T-06, T-09 |
| **API6:2023** Unrestricted Access to Sensitive Business Flows | Maker-checker, step-up and approval limits for payouts; payee-change hold; OTP throttles; STK Push only to the client's verified numbers and rate-limited (*proposed*) (§7, §14.5) | A-04, A-08, A-16 |
| **API7:2023** Server Side Request Forgery | No user-supplied URLs; locked-down PDF rendering; egress allowlist for workers | T-20 |
| **API8:2023** Security Misconfiguration | Security headers and CSP; same-origin API with no permissive CORS; IaC policy checks; production startup guards (§18, §20) | T-04, T-65 |
| **API9:2023** Improper Inventory Management | OpenAPI as the single source of truth; versioned paths; mock and sandbox endpoints never deployed to production; inventory of webhook endpoints (§20, §21) | T-65 |
| **API10:2023** Unsafe Consumption of APIs | Zod validation of Daraja, Africa's Talking, WhatsApp, terminal and FX payloads; timeouts; TLS verification; provider data never trusted for authorisation (§14, §15, §16) | T-45, T-52, T-58 |

---

## 8. Security testing plan per phase

Every mitigation above needs at least one automated test before it counts as implemented. Tooling follows §21.

| Phase | Security tests and gates |
|---|---|
| **D1.1** | CI from day one: CodeQL, gitleaks (pre-commit and CI), dependency review, OSV-Scanner, Trivy image scan, SBOM. Lint bans on raw HTML injection and untagged raw SQL. Unit tests for production guards (no static KEK, no mock provider). |
| **D1.2** | Security-header and CSP snapshot tests; XSS regression tests on free-text fields. |
| **D1.3** | Authentication integration tests: lockout, OTP expiry and rate limits, refresh-token rotation and **reuse revokes the family**, step-up required and **bound to the action hash** (changing the amount after MFA must fail), CSRF rejection without a token or with a foreign Origin. |
| **D1.4** | **Tenant isolation suite** generated from the Prisma model list: cross-tenant read, update and delete through the API and directly as `pmb_app` with a missing or wrong `app.tenant_id` (must fail closed). RLS migration check. Authorisation matrix tests (role × permission × endpoint). Maker-checker trigger tests. Audit hash-chain verification, including tamper detection. |
| **D2.2** | Excel import fuzzing (malformed, oversized, zip bombs, formulas, external links). Formula-injection tests on exports. Upload type and size enforcement. |
| **D3.1** | Field encryption tests: ciphertext at rest, associated data stops a ciphertext being moved to another row, blind-index lookups, masked responses. Under-18 block. No enrolment without consent. |
| **D3.2** | Revoked device rejected; replayed proof-of-possession rejected; SQLCipher enabled. Kiosk lock-down checklist on real hardware. |
| **D3.3** | Sync tests: bad signature, replayed record IDs, `device_seq` gaps. Property-based tests in `packages/domain` for clock drift, mock location, geofence, two sites and impossible travel. |
| **D3.4** | DPIA gate: biometric capture is disabled until the DPIA is approved. **Canary template values must never appear in logs, traces, Sentry or analytics.** KEK separation: a non-biometric identity cannot unwrap. Deletion and withdrawal jobs, including device purge. Presentation-attack tests. False-match and false-non-match rates measured on a representative sample (DPIA R-03). SDK network-egress test. |
| **D4.2** | **Payment callback fuzzing with `apps/mock-daraja`:** success, failure, timeout, duplicate, out-of-order, unknown request, wrong channel token, wrong request token, non-allowlisted IP, amount mismatch, malformed or oversized body, and concurrent duplicate delivery. State-machine property tests. Idempotency under parallel requests. Nightly sandbox smoke tests. |
| **D4.3** | End-to-end maker-checker with role-stacking attempts. Float-check block. Name-mismatch hold. Unusual-payout rules. Payee-change hold. Reconciliation with injected statement lines unknown to PM-Buddy (float-drain detection). |
| **D5.x** | Three-way match bypass attempts; split-order detection; duplicate receipt detection; supplier payee-change hold. |
| **D6.1** | Photo verification: forged EXIF, reused hash, gallery import, outside the geofence. |
| **D7.x** | Client and supplier portal object-level authorisation; USSD webhook authentication and PIN brute force; STK Push throttles; WhatsApp signature verification. |
| **D8.1** | Export authorisation, masking and watermarking; `export` audit events. |
| **D9.1** | ASVS Level 2 checklist (version pinned). **ZAP baseline scan against staging** in CI. Header and CSP review. Key rotation drill (KEKs including the biometric KEK, DEK re-wrap). Threat model v1.0. Pen-test preparation. |
| **D9.2** | Abuse load tests: sync storms, callback bursts, OTP floods. Degradation drills (M-Pesa, SMS down). |
| **D9.3** | Restore drill, with audit-chain verification after the restore. Breach runbook tabletop exercise (with [DPIA](./DPIA_TEMPLATE.md) §10). Secret rotation. |
| **Before any real money moves** | **Independent penetration test** covering web, API, site app, kiosk and terminal, USSD and payment callbacks. This is the "security review" go-live gate in ROADMAP §4 and applies to a pilot too. High findings are fixed and retested. |

**D3.1 status (labour registry, built locally; see [IMPLEMENTATION_STATUS](./IMPLEMENTATION_STATUS.md)).** Automated tests now cover: plaintext identifiers absent from the raw `labourers` columns (queried directly), decryption failing with the wrong key, a tampered byte, a ciphertext moved to another row or company and an unknown key version; blind-index uniqueness for ID numbers and KRA PINs; masked list and detail responses; reveal refused without `labour.view_sensitive` or fresh MFA and audited without the value; audit metadata free of identifiers; the under-18 boundary in the API and directly in the database (insert as `pmb_app`); registration impossible without a consent row; do-not-rehire matches by ID, phone and KRA PIN, with overrides recorded; cross-company reads, writes and composite-key references refused for every new table under the runtime role. Residual risks: the master keys live in configuration rather than a KMS (D-30, OR-09), the blind-index key cannot rotate without recomputing indexes, and a person with `labour.view_sensitive` and MFA can still reveal values one at a time (every reveal is audited with a purpose; rate limits and alerts on bulk reveals are not built yet). A-01 (ghost workers): the ID blind index and the shared-phone warning are implemented; live photos and attendance evidence come with D3.2–D3.3. An independent review found two defects, both fixed with tests: the ID blind index included the document type, so a flagged or duplicate person could re-register with the same digits as a passport or alien ID (now type-independent, D-35); and full identifiers could be stored in saved views and carried in registry URLs (now looked up only through a request body, refused in query strings and never saved, D-36).

---

## 9. Open risks and decisions needed

**Residual risk summary (STRIDE):** 1 High (T-45), 35 Medium, 33 Low across 69 threats. The High item must be reduced or explicitly accepted before D3.4 ships terminal support.

**Gaps found by this model** (now in ARCHITECTURE §17 items 6–7 and §10): formula-injection escaping for exports (T-15, D2.2); locked-down PDF rendering against SSRF (T-20, D2.2); perceptual-hash photo reuse detection (A-13, D6.1); biometric KEK held by a separately deployed worker (OR-01, D3.4).

Each decision below should be logged in [QUESTIONS.md](./QUESTIONS.md). Legal and regulatory items are also tracked in [COMPLIANCE_TODO.md](./COMPLIANCE_TODO.md).

| ID | Risk or decision | Why it matters | Recommendation | Needed by |
|---|---|---|---|---|
| OR-01 | **Biometric key separation inside a modular monolith** | §10 says only the biometrics identity can unwrap the biometric KEK. In one process, that separation is only logical. | Run biometric enrolment and matching in a separate deployment with its own KMS principal | D3.4 |
| OR-02 | **Kiosk lock-down needs device-owner mode or MDM** | Without it, kiosk escape (T-42) stays Medium | Choose an MDM, or device-owner provisioning, and budget for it | D3.2 |
| OR-03 | **Biometric vendor due diligence** | Liveness quality, offline operation, telemetry, template storage and push-protocol security drive T-41, T-45 to T-47 | Criteria: offline-only, no telemetry, encrypted templates, signed SDK, documented push security, independent presentation-attack testing (for example ISO/IEC 30107-3) | D3.4 |
| OR-04 | **Segregation of duties for small tenants** | Some contractors have only one or two office staff (A-16) | Require two distinct people for payouts by default. Allow an Owner waiver with a reason, a visible banner, audit and lower limits. | D4.3 |
| OR-05 | **Payee-change hold and verification** | Fraud protection (A-04, A-25) against urgent-payment friction | Default hold with an Owner override under step-up; confirm the worker in person on site | D4.3 |
| OR-06 | **Cash payment policy** | Unrecorded cash is a top leak (A-12) | Per-tenant cap, or disallow cash for payroll; require worker acknowledgement | D4.3 |
| OR-07 | **Where to anchor audit-chain heads and evidence objects** | Protects against insiders with database or storage admin rights (T-23, T-29, A-24) | Object-lock (WORM) bucket in a separate account, or an external timestamping service | D1.4, D9.1 |
| OR-08 | **Platform support access** | Impersonation is powerful and easy to abuse (T-66, T-69) | No impersonation in v1; break-glass only, dual-approved and tenant-visible | D1.4 |
| OR-09 | **Hosting region and cross-border transfer** | Affects where the KMS, backups and biometric data live (DPIA §11) | Decide before any real personal data reaches production | Before Phase 9, and before any pilot |
| OR-10 | **Device attestation (Play Integrity)** | Raises the bar on mock location and repackaged apps (T-36, T-40), but depends on Google Play services and may fail on some low-end phones | Use the verdict as an anomaly signal, not a hard block | D3.2, D3.3 |
| OR-11 | **Confirming high-value inbound payments** | Defence in depth for STK and C2B receipts (A-06, A-07) | Run Transaction Status before issuing a receipt above a configurable threshold | D7.1 |
| OR-12 | **Operator SIM-swap check** | Reduces payouts diverted by SIM swap (A-22) | Ask Safaricom whether a SIM-swap check is commercially available | D4.3 |
| OR-13 | **Pen-test vendor, scope and timing** | Required before any real money moves (ROADMAP §4) | Book early; include kiosk and terminal hardware and USSD | Before pilot |
| OR-14 | **Vulnerability disclosure** | Researchers need a safe channel | Publish `security.txt` and a disclosure policy | D9.1 |
| OR-15 | **1:1 verification vs 1:N identification** | 1:1 (tap card, then match only that worker's template) is less intrusive and more accurate than 1:N | Evaluate 1:1 as the default where cards are issued; record the choice in the DPIA | D3.4 |
| OR-16 | **Passkeys for approvers** | TOTP can be phished in real time (T-01, A-17) | Require passkeys for payout approval, with TOTP as a fallback only | D1.3, D4.3 |
