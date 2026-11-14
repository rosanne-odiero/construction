# PM-Buddy: Delivery Roadmap

This is the end-to-end delivery plan for [PROJECT_BRIEF.md](./PROJECT_BRIEF.md). The brief's ten phases (0–9) are split into **32 small deliverables**. Each one is built and reviewed on its own, and each ends with a frontend you can click through and approve.

> Status legend: ⏳ in progress · 🔎 in review · ✅ approved · ⬜ not started
>
> **Safeguard addendum:** [brief §15](./PROJECT_BRIEF.md#15-mandatory-safeguards-pm-buddy-additions) applies to every deliverable. Phase 1 (D1.1–D1.4) implementation is approved; this is not acceptance of completed work or approval of later phases. The historical table labels below are not implementation evidence; current results and remaining work live in [IMPLEMENTATION_STATUS.md](./IMPLEMENTATION_STATUS.md) and [ACCEPTANCE_MATRIX.md](./ACCEPTANCE_MATRIX.md). The [pilot design and delivery order](./PILOT_PLAN.md) have separate owner approval; live activation does not.

---

## 1. How each deliverable works

```mermaid
flowchart LR
  A[Branch off main<br/>phase-N/dN.x-slug] --> B[Build<br/>code + tests + docs]
  B --> C[Verify<br/>lint, types, tests, build]
  C --> D[Demo<br/>localhost + screenshots<br/>+ demo script]
  D --> E{You review<br/>in the browser}
  E -- feedback --> B
  E -- approved --> F[You merge to main]
  F --> A
```

1. **Branch.** Every deliverable gets its own branch off `main`, named like `phase-1/d1.3-auth-mfa`. Commits follow [Conventional Commits](https://www.conventionalcommits.org/), for example `feat(auth): add TOTP enrolment`.
2. **Build.** Code, unit and integration tests, docs, and `.env.example` all get updated together. Seed data grows with each deliverable.
3. **Verify.** Lint, type checks, tests and the build must all pass locally (and in CI from D1.1 onwards).
4. **Demo.**
   - The app runs at **http://localhost:3000** (web). The API runs at http://localhost:4000 from D1.1.
   - I share screenshots of each new screen in English and Kiswahili, light and dark.
   - I add a step-by-step script in `docs/demos/phase-N.md`.
5. **Review.** You click through the screens and reply **"approved"** or give feedback. Feedback gets fixed on the same branch.
6. **Merge.** You merge the branch, and the next deliverable branches off the updated `main`.

### What you get at every review gate

- A list of the new screens and flows to try, with direct URLs.
- A summary of what was built, the assumptions I made and any open questions.
- New configuration values, recorded in [CONFIGURATION.md](./CONFIGURATION.md) and flagged `COMPLIANCE-REVIEW` where relevant.
- Updates to [COMPLIANCE_TODO.md](./COMPLIANCE_TODO.md) and [QUESTIONS.md](./QUESTIONS.md).

### Definition of done (every deliverable)

- [ ] Code, tests and docs are updated, and the checks are green (CI from D1.1).
- [ ] No secrets are committed, and `.env.example` is up to date.
- [ ] New configuration values are documented with their source and `COMPLIANCE-REVIEW` status.
- [ ] All new UI strings exist in **English and Kiswahili** (`pnpm --filter @pm-buddy/i18n i18n:check` passes). Money is shown as `KES 1,250,000`, dates as `DD/MM/YYYY`, in the `Africa/Nairobi` timezone.
- [ ] The UI works in light and dark mode, is keyboard accessible, and targets WCAG 2.2 AA.
- [ ] The demo script is updated in `docs/demos/phase-N.md`.
- [ ] Tenant isolation tests cover every new table (from D1.4).
- [ ] Snapshot-bound identity-based approvals, explicit workflow states, redacted audit and relevant database invariants are covered.
- [ ] Applicable failure-mode scenarios in brief §15.I have evidence; manual field/hardware results are distinguished from automated tests.
- [ ] Migrations, recovery, actual commands/results, limitations and next steps are recorded. Security/observability/recovery start now, not only in Phase 9.

---

## 2. Deliverables

Size is relative effort (S < M < L < XL). It's not a calendar estimate.

### Phase 0: Design

| ID | Deliverable | What you'll review in the browser | Done when | Size | Status |
|---|---|---|---|---|---|
| **D0** | Design pack: [architecture](./ARCHITECTURE.md), [ERD](./ERD.md), [OpenAPI outline](./api/openapi-outline.yaml), [threat model](./THREAT_MODEL.md), [DPIA template](./DPIA_TEMPLATE.md), [compliance TODO](./COMPLIANCE_TODO.md), [configuration register](./CONFIGURATION.md), [questions](./QUESTIONS.md), plus a **clickable UI prototype** (mock data only) | Sign-in + MFA, app shell, owner dashboard, project overview, BQ + import mapping, labour registry, attendance muster roll, payroll approval with M-Pesa statuses, client portal with STK Push, site-app phone mockups, EN/SW toggle, dark mode | You approve the docs and the look and feel | L | ✅ |

### Phase 1: Foundation

| ID | Deliverable | What you'll review | Done when | Size | Status |
|---|---|---|---|---|---|
| D1.1 | **Workspace, tooling and CI**:<br/>• pnpm + Turborepo packages: `types`, `validation`, `domain`, `config`<br/>• NestJS API skeleton with health/readiness, OpenAPI docs, pino logging and OpenTelemetry hooks<br/>• Prisma base migration, database roles for row-level security<br/>• docker-compose with PostgreSQL 18, Valkey, RustFS (S3-compatible) and Mailpit (D-24)<br/>• GitHub Actions: lint, types, tests, build, e2e, CodeQL, gitleaks, dependency review; Dependabot | Live `/status` page (the first screen on the real API); API docs at `/api/docs`; health endpoints; prototype still runs | `pnpm dev` starts everything; CI is green on a PR | M | ✅ |
| D1.2 | **Design system and i18n**:<br/>• Tokens and components extracted from the prototype<br/>• Shared EN/SW catalogues in an `i18n` package<br/>• KES, date and phone formatters with tests<br/>• Accessibility baseline (axe in Playwright)<br/>• PWA manifest | `/design-system` component gallery; app shell; language and theme switch | Gallery approved; formatter and a11y tests pass | M | ✅ |
| D1.3 | **Authentication and MFA**:<br/>• Sign-up by email or phone; verification<br/>• Argon2id passwords<br/>• Short-lived access token + rotating refresh token in httpOnly cookies<br/>• TOTP and passkeys; OTP by SMS/WhatsApp (dev mock provider)<br/>• Step-up MFA; lockout and rate limits<br/>• Password reset; active sessions list<br/>• Password strength (zxcvbn-ts) and optional breached-password check<br/>_Status note: passkeys (WebAuthn) as a factor and for step-up, the password policy and development SMS/WhatsApp channels behind `NotificationProvider` are on `phase-1/d1-passkeys`, pending review. SMS OTP as a second factor for low-privilege roles and real providers (D7.3) remain._ | Sign-up, login, MFA enrolment, step-up dialog, sessions page | Users can sign up and log in with MFA; auth tests pass | L | ✅ |
| D1.4 | **Tenancy, RBAC and audit**:<br/>• Create a company<br/>• Invite users<br/>• Roles and granular permissions, with project-scoped membership<br/>• Create a project<br/>• PostgreSQL RLS by `tenant_id`<br/>• Append-only, hash-chained audit log | Company onboarding, team and roles, project creation, audit log viewer | **Phase 1 acceptance:** users can sign up, log in with MFA, and create a company and project; tenant isolation tests pass | L | ✅ |

### Phase 2: Projects and BQ

| ID | Deliverable | What you'll review | Done when | Size | Status |
|---|---|---|---|---|---|
| D2.1 | **Projects, sites and geofences**: polygon or radius geofences drawn on a map; WBS/phases; milestones; team assignment by role; project dashboard shell | Project list and detail, site map editor, team tab | Projects and sites with geofences persist and are tenant-isolated | M | ✅ |
| D2.2 | **BQ import**:<br/>• `.xlsx` upload; sheet and header detection; column-mapping screen; saved mapping templates<br/>• Bill → Section → Item hierarchy<br/>• Preliminaries, provisional sums, PC sums, contingencies, dayworks and VAT<br/>• Totals reconciliation; BQ viewer; Excel and PDF export | Import wizard, BQ tree table, totals check | **A real Excel BQ imports correctly and totals match** | L | ✅ |
| D2.3 | **BQ versions and variations**: Architect's/Engineer's Instructions; Variation Orders with an approval workflow; original vs revised contract sum; rate build-up library | VO list and approval, version compare, rate build-up editor | **Phase 2 acceptance** | M | ✅ |

### Phase 3: Labour and attendance

| ID | Deliverable | What you'll review | Done when | Size | Status |
|---|---|---|---|---|---|
| D3.1 | **Labourer registry**:<br/>• Registration that blocks anyone under 18<br/>• Field-level encryption for IDs, PINs and phone numbers<br/>• Trades, skill levels and rates<br/>• NCA accreditation with expiry alerts<br/>• Gangs<br/>• Consent capture (EN/SW)<br/>• Do-not-rehire flag | Registry table with saved views, worker side panel, registration form, consent screen | Registry works; encryption and under-18 tests pass | L | ✅ |
| D3.2 | **Site app foundation (Expo, Android-first)**: login with device binding; kiosk mode; encrypted SQLite; push/pull sync engine; sync status UI | Expo app on your Android phone (Expo Go) or an emulator, plus a web preview | The app works offline and syncs when back online | L | ⬜ |
| D3.3 | **Attendance, fallback method first**:<br/>• QR/NFC worker card + photo + supervisor confirmation<br/>• Geofence checks; signed offline records; clock-drift detection<br/>• Anomaly rules: duplicates, two sites, impossible travel<br/>• Override workflow<br/>• Timesheet rules and public holidays<br/>• Muster roll in the web app | Kiosk check-in on the device, muster roll with flags, anomaly review | A foreman records attendance offline; it syncs correctly and anomalies are flagged | L | ⏳ |
| D3.4 | **Attendance, first biometric method** (chosen in [QUESTIONS.md](./QUESTIONS.md)):<br/>• Uses the `CaptureMethod` interface<br/>• Gated per tenant behind a signed-off DPIA<br/>• Template-only encrypted storage<br/>• Retention and deletion jobs | Enrolment and identification on the kiosk, consent and DPIA gate, deletion log | **Phase 3 acceptance** | XL | ⬜ |

> **D3.3 is partly built (⏳).** The web-only slice is built and verified locally on `phase-3/d3.3-web-timesheets` (not pushed, not reviewed): pluggable capture method (`web_manual` implemented; `qr_card`, `face`, `fingerprint` and `terminal` reserved with nullable evidence columns), the daily muster roll in the web app with supervisor confirmation by a different person, corrections and anomaly review, effective-dated timesheet rules (company default and project overrides) with the 2026–2027 Kenyan public holidays, weekly periods with a Thursday 18:00 cut-off, approval that snapshots immutable timesheet lines for payroll, and adjustments to approved periods. Still to do for D3.3: the site-app check-in (QR/NFC card and photo), geofence checks, signed offline records, clock-drift detection, duplicate and impossible-travel rules, and the kiosk flow (they need D3.2). See [IMPLEMENTATION_STATUS](./IMPLEMENTATION_STATUS.md#d33-web-attendance-and-timesheets-branch-phase-3d33-web-timesheets).

### Phase 4: Payroll and M-Pesa

| ID | Deliverable | What you'll review | Done when | Size | Status |
|---|---|---|---|---|---|
| D4.1 | **Payroll engine**:<br/>• Daily, weekly, fortnightly or monthly pay periods<br/>• Gross pay from attendance, overtime, piece-rate output and allowances<br/>• Versioned statutory rules (PAYE, NSSF, SHIF, Housing Levy, NITA)<br/>• Advances with automatic recovery<br/>• Payslip preview; statutory export CSVs | Payroll batch builder, payslip preview, rule versions screen | Unit tests cover every rule boundary; seed rules are flagged `COMPLIANCE-REVIEW` | L | ⏳ |
| D4.2 | **Daraja integration**:<br/>• `PaymentProvider` interface with `DarajaProvider`: OAuth, STK Push + query, C2B, B2C, B2B, transaction status, account balance, reversal<br/>• Per-tenant credentials<br/>• Outbox + BullMQ<br/>• Callback hardening<br/>• Local mock Daraja server for success, failure, timeout, duplicate and out-of-order callbacks | Payments console: requests, callbacks, state timeline, unknown-callback alerts | Mock and sandbox flows pass the integration suite | XL | ⬜ |
| D4.3 | **Approvals and payouts**:<br/>• Maker-checker with step-up MFA and approval limits<br/>• Float check, then bulk B2C payout with per-worker status<br/>• Recipient name check<br/>• SMS payslips<br/>• Daily reconciliation and statement upload<br/>• M-Pesa charges booked as cost<br/>• Cash and bank payments; unusual-payout alerts | Approval flow, live payout statuses, reconciliation screen | **Phase 4 acceptance:** a weekly payroll for 40 workers pays out in sandbox with every callback reconciled; failed and duplicate cases are handled | L | ⬜ |

### Phase 5: Materials, stores and spending

| ID | Deliverable | What you'll review | Done when | Size | Status |
|---|---|---|---|---|---|
| D5.1 | **Catalogue and suppliers**:<br/>• Materials with Kenyan units and conversions (bags, tonnes, lorry trips, steel by length/kg)<br/>• Suppliers: KRA PIN, eTIMS, Paybill/Till, bank details, terms<br/>• Price history | Catalogue, unit conversions, supplier profile | Conversions are unit-tested | M | ✅ |
| D5.2 | **Procure-to-pay**:<br/>• Requisition → approval → RFQ and quote comparison → LPO<br/>• Goods Received Note in the site app (offline, photos, GPS, vehicle reg)<br/>• Supplier invoice with eTIMS<br/>• Three-way match; B2B or bank payment | End-to-end procurement flow; match screen | **The three-way match blocks bad payments** | XL | 🔎 |
| D5.3 | **Stores**: stock ledger per site; issues to a BQ item or gang; returns and transfers; stock takes; wastage; low stock; theoretical vs actual consumption variance alerts | Stock ledger, stock take, variance alerts | **A variance alert fires on test data** | L | 🔎 |
| D5.4 | **Spending and cash flow** (brief §5.8):<br/>• Cost tagging<br/>• Petty cash floats; expenses with receipts<br/>• M-Pesa SMS parser<br/>• Budget vs actual vs committed; cash-flow forecast; spend alerts | Petty cash, expense capture, budget and cash-flow views | **Phase 5 acceptance** | M | 🔎 |

> **D5.2 is in review (🔎).** The backend (requisitions, RFQs with the net-of-VAT comparison and minimum quotes, LPOs, idempotent GRNs, supplier invoices with eTIMS, the three-way match enforced in the API and in SQL, payee-bound approval and settlements recorded outside PM-Buddy) and the web screens, browser tests, mock API and docs (independently reviewed, `phase-5/d5.2-web`) are on `main`, waiting for the owner's review of the screens. Not in D5.2 yet: GRN capture in the offline site app (the web form is mobile-first and the API contract is offline-ready, see [ARCHITECTURE §12.2](./ARCHITECTURE.md#122-records-created-offline)), and paying suppliers through M-Pesa B2B or a bank API (payments made elsewhere are recorded as settlements; Daraja payouts are D4.2/D4.3). See [IMPLEMENTATION_STATUS](./IMPLEMENTATION_STATUS.md#d52-procure-to-pay-branch-phase-5d52-web).

> **D5.3 is in review (🔎)** on branch `phase-5/d5.3-stores`. Stores per site with an append-only stock ledger in base units (running balances locked per movement, weighted average cost, negative stock never allowed), GRN receipts and void reversals, issues to a BQ item or gang, returns, wastage, inter-site transfers (in transit, disputed, resolved), stock takes with independent approval, reorder levels and low stock, and **theoretical-versus-actual consumption variance alerts** (the done-when: an API e2e test and the demo seed both fire one). Two gaps were closed minimally for D6.3 to extend: build-up material lines are mapped to catalogue materials in a separate table, and a minimal append-only progress measurement exists. Web screens (EN/SW, 360 px), browser tests and docs are included. Not in D5.3: stores in the offline site app (the API contract is offline-ready), per-material variance thresholds, days-of-cover low stock and an authorised negative-stock override (deliberately not offered, D-50). See [IMPLEMENTATION_STATUS](./IMPLEMENTATION_STATUS.md#d53-stores-branch-phase-5d53-stores).

> **D5.4 is in review (🔎)** on branch `phase-5/d5.4-spending`. An append-only cost ledger tags every shilling with project, site, BQ item or cost code, category, counterparty and payment reference. It is fed once per source by the database: approved supplier invoices (accrued, net of VAT), their settlements (the cost part of the cash paid), approved petty-cash expenses, approved float counts and maker-checked journals; corrections are reversal journals. Material cost is counted once, when the invoice is approved; stock issues only move it to BQ items in the reports (D-53). Versioned budgets come from the approved BQ and company cost codes and are approved by someone who did not prepare them, on the digest they saw. Budget against committed (D5.2 open commitments), actual and paid by project, category, bill and BQ item; undefined ratios show as unavailable. Petty-cash floats per site: custodian, maker-checked top-ups, offline-ready expenses with receipt photos, a float that can never go negative (locked like the stock ledger), counts with independent approval. A Kenyan M-Pesa SMS parser (EN/SW) fills a draft only — it never confirms settlement — and duplicate M-Pesa codes are refused. A weekly cash-flow forecast (company and project) and four in-app spend alerts. **Phase 5 acceptance** is the D5.1–D5.4 set working end to end on the demo data: see [the Phase 5 walkthrough](./demos/phase-5.md#phase-5-acceptance-walkthrough) and [ACCEPTANCE_MATRIX](./ACCEPTANCE_MATRIX.md). Not in D5.4: payroll costs in the ledger (no approved/paid payroll state exists on `main` yet; the forecast uses draft and submitted batches), notifications for alerts (Phase 8), client certificates as receipts (D6.3/D7.1) and petty cash in the offline site app (the API contract is offline-ready). See [IMPLEMENTATION_STATUS](./IMPLEMENTATION_STATUS.md#d54-spending-branch-phase-5d54-spending).

### Phase 6: Progress and valuations

| ID | Deliverable | What you'll review | Done when | Size | Status |
|---|---|---|---|---|---|
| D6.1 | **Site diary and quality**:<br/>• Daily diary with workforce auto-filled from attendance; sign-off and locking<br/>• Geotagged photos with server verification<br/>• Inspections and checklists; cube and slump tests<br/>• Snags; practical completion and defects liability period | Diary (site app and web), photo timeline, inspections, snags | A diary is locked after approval; photo metadata is verified | L | 🔎 |
| D6.2 | **Schedule**: Gantt with dependencies, milestones, baseline vs actual, delay log with causes | Gantt view, delay log | The baseline is frozen and variance is shown | M | 🔎 |
| D6.3 | **Measurement and valuations**:<br/>• Progress measured against BQ items, with photos<br/>• Earned value (PV, EV, AC, CPI, SPI) and S-curve<br/>• Interim valuations and payment certificates; retention and its release<br/>• Subcontracts and piece-rate links (brief §5.14)<br/>• Cost to complete | Measurement entry, EVM dashboard, valuation and certificate PDF | **Phase 6 acceptance:** an interim payment certificate generates correctly from measured progress | XL | 🔎 |

> **D6.1 is in review (🔎).** On `main` (from `phase-6/d6.1-quality`) and independently reviewed; waiting for the owner's review of the screens. On top of the diary, sign-off/locking, verified photos and portals it adds: the diary's workforce as an **attendance snapshot by trade** with its provenance (or typed in, shown as such; re-checked by the database, frozen on approval); **versioned company checklist templates** (seven synthetic starters); **inspections** per project and site (internal, consultant or county inspector; optional WBS item, schedule task or BQ item) answered pass/fail/N/A with notes and site photos, submitted, then **signed off and locked by an independent `quality.manage` holder**; **cube tests** (7/28-day results per cube, mean and minimum judged by rule KE-CUBE-1, overdue flags) and **slump tests** (KE-SLUMP-1), append-only with corrections that reference the original; **snags** open → fixed → verified/closed by someone else, or reopened; and **practical completion** (refused with open critical snags unless excepted with a reason) starting a **defects liability period** (default 6 months, 1–24), and **final completion** ready for D6.3 retention release. Not in D6.1: offline/site-app capture (Phase 3 site app), valuations and retention release (D6.3), a client-portal view of quality or completion (D7.1), and professional review of the cube/slump rules (COMPLIANCE_TODO CR-QA-01–03). See [IMPLEMENTATION_STATUS](./IMPLEMENTATION_STATUS.md#d61-quality-branch-phase-6d61-quality).

> **D6.2 is in review (🔎).** On `main` (from `phase-6/d6.2-schedule`) and independently reviewed; waiting for the owner's review of the screens. It adds the project's Schedule tab with an SVG Gantt chart (critical path, baseline ghosts, actual dates, milestones, dependency arrows, today's line, keyboard item list and table alternative), the activity editor with FS/SS/FF/SF dependencies and progress with a declared basis, a per-project working calendar with the company's public holidays, CPM in `packages/domain`, **baselines frozen by the database** (append-only, re-baselining with a reason) with **variance in working days**, and a versioned, append-only delay log with causes and a claim-support flag. Not in D6.2: measured BQ progress, EVM and S-curves (D6.3), resource levelling, calendars per activity, schedule import/export (MS Project, P6) and a client-portal schedule (D7.1). See [IMPLEMENTATION_STATUS](./IMPLEMENTATION_STATUS.md#d62-schedule-branch-phase-6d62-schedule).

> **D6.3 part A is in review (🔎)** on branch `phase-6/d6.3-valuations` (independently reviewed; five findings fixed, including carrying the materials-from-stores choice to the next interim). Measurement of BQ items (quantity to date, or percent of a priced lump sum) with site-photo evidence and an **independent approval** (never the measurer, only with a photo), append-only with reasoned corrections and over-measures, offline-ready. **Interim valuations and payment certificates** (VAL/IPC per project) computed by rule KE-VAL-1 from approved measurements up to the valuation date: work done + materials on site (entered against an item at cost or from stores at weighted average cost, never paid twice) − retention (10 % limited to 5 % of the original contract sum by default, per-project versioned settings) ± agreed adjustments (advances and recoveries) − previous certificates = amount due, with VAT shown separately; frozen at submission and **certified by finance with step-up on the digest they saw**, never by a contributor; a certified certificate never changes (database-enforced). **Retention release** certificates at D6.1's certified practical (half) and final completion. EN/SW **certificate PDF** and Excel. **Earned value** (PV from the D6.2 baseline weighted by linked tasks' working days, EV from approved measurements, AC from the D5.4 ledger; CPI, SPI, EAC with stated formulas; undefined ratios unavailable) with a weekly SVG S-curve and **cost to complete** by bill and item. **Phase 6 acceptance** — an IPC generates correctly from measured progress — is the API e2e done-when test and the [Phase 6 walkthrough](./demos/phase-6.md#phase-6-acceptance-walkthrough). Not in D6.3 part A: subcontracts and piece-rate links (brief §5.14, part B), a client-portal certificate view and STK Push against a certificate (D7.1/D4.x), invoiced value (D7.1), WBS progress from measurements and site-app capture; the rules await QS/accountant review (COMPLIANCE_TODO CR-VAL-01–05). See [IMPLEMENTATION_STATUS](./IMPLEMENTATION_STATUS.md#d63-measurement-and-valuations-branch-phase-6d63-valuations).

### Phase 7: Portals and self-service

| ID | Deliverable | What you'll review | Done when | Size | Status |
|---|---|---|---|---|---|
| D7.1 | **Client portal**:<br/>• Progress, S-curve and verified photo timeline; diary summaries<br/>• Certificates and statements; **pay via STK Push**; C2B Paybill instructions<br/>• Variation approvals<br/>• FX display (USD/GBP/EUR) | Client portal on mobile and desktop | A client can view progress and pay (sandbox) | L | 🟨 Live client portal (assigned projects, milestones, approved diaries) built early on owner request; photos, certificates, STK Push, variations and FX remain |
| D7.2 | **Supplier portal**: LPOs, deliveries, invoices with eTIMS, payment status, statements | Supplier portal | A supplier can see an LPO and submit an invoice | M | ⬜ |
| D7.3 | **Labourer USSD/SMS and notifications**:<br/>• Africa's Talking USSD menu (EN/SW) with ID + PIN<br/>• Notification centre: templates (EN/SW), preferences, WhatsApp | USSD simulator, notification settings and templates | **Phase 7 acceptance:** a labourer can check pay via USSD | M | 🟨 Labourer web portal with phone + PIN built early on owner request (assigned sites only); USSD, pay, attendance and the real SMS provider remain |

### Phase 8: Reports, H&S, plant and compliance

| ID | Deliverable | What you'll review | Done when | Size | Status |
|---|---|---|---|---|---|
| D8.1 | **Dashboards and reports**: owner dashboard; standard reports (muster roll, payroll, ledgers, stock, valuations, cost, reconciliation, audit); PDF/Excel export; scheduled emails | Reports centre, exports | All reports export | L | ⬜ |
| D8.2 | **Health and safety**: inductions, toolbox talks, PPE register, incidents and near misses, first aid, corrective actions | H&S module (site app and web) | Incident to corrective action flow works | M | 🔎 |
| D8.3 | **Plant and equipment**: owned and hired plant, usage, fuel issues and consumption, breakdowns, maintenance, operators | Plant register, fuel log | Fuel variance flagged | M | 🔎 |
| D8.4 | **Documents and compliance register**: versioned document repository; compliance items with expiry reminders; consultant instructions log | Documents, compliance register | **Phase 8 acceptance:** all reports export to PDF and Excel | M | ⬜ |

> **D8.2 is in review (🔎).** Built on `phase-8/d8.2-health-safety` and independently reviewed (four findings fixed, including restricting incident photos to safety readers): **site inductions** (labourers, staff or named visitors; company checklist; acknowledgement) with induction status per labourer and site and **flags read from attendance, never blocking it**; **toolbox talks** with gang or picked attendance, an optional site photo, locked once confirmed; the **PPE register** (issues, replacement dates from company periods, returns, replacements; a register only, no stores movement, D-72); **incidents and near misses** (Nairobi time, coded people and injuries visible only to `safety.manage`, photos, investigation, regulator decision flagged COMPLIANCE-REVIEW CR-HS-01); **corrective actions** done by their owner and **verified by someone else**, overdue first; **first aid** (kits and checks, first-aiders, coded treatments linked to incidents); and the done-when flow: incident → investigation → corrective actions → done → verified → **incident closed and locked** (database-enforced for every role). Web: the live Health and safety area and the project's Health and safety tab (EN/SW, 360 px forms). Not in D8.2: offline/site-app capture (Phase 3 site app), a link from PPE issues to stores issues, raising actions from the inspection screen, notifications for overdue actions, and legal review of the OSHA/WIBA rules (COMPLIANCE_TODO CR-HS-01–04). See [IMPLEMENTATION_STATUS](./IMPLEMENTATION_STATUS.md#d82-health-and-safety-branch-phase-8d82-health-safety).

> **D8.3 is in review (🔎).** Built on `phase-8/d8.3-plant` and independently reviewed (six findings fixed, including logging the day of a meter reset and keeping corrections on the standard they were recorded under): a company **plant register** of owned and hired items (code unique per company, 13 categories incl. scaffolding and formwork counted by quantity; hire supplier, rate per day/hour/month, hire period and LPO; meter and fuel type; **standard consumption**; service intervals) whose status follows its **moves** (append-only site history), breakdowns and off hire/disposal (database-checked); **operators** (labourers on the project or staff, certificate flagged where the category needs one, never blocked, COMPLIANCE-REVIEW CR-PLT-01); **daily usage** with **meter readings that never go backwards** unless a reasoned meter reset lies between (API and database), corrections as new rows; **fuel issues** and the done-when: **fuel variance flagged** per full-tank window against meter advance × standard, beyond a company tolerance (15 %) once a minimum sample (10 h / 100 km) is covered, plus fuel on a static meter — always worded as **an estimate, never proof of theft** (§15 G); **breakdowns** (unsafe plant cannot log working days; only `plant.manage` repairs it), **service due/overdue** by hours/km and days, **hire** idle/ending/overrun alerts and an estimated hire charge that is never posted. Nothing posts to the cost or stores ledgers (D-93). Web: the live Plant area, item pages and the project's Plant tab with 360 px usage and fuel forms (EN/SW). Not in D8.3: plant in the offline site app (the API is offline-ready: client ID + `Idempotency-Key` + digest), telematics/GPS, automatic hire-invoice matching, depreciation and cost allocation reports. See [IMPLEMENTATION_STATUS](./IMPLEMENTATION_STATUS.md#d83-plant-and-equipment-branch-phase-8d83-plant).

### Phase 9: Hardening and launch readiness

| ID | Deliverable | What you'll review | Done when | Size | Status |
|---|---|---|---|---|---|
| D9.1 | **Security**: OWASP ASVS L2 checklist; threat model refresh; header and CSP review; key rotation drill; pen-test preparation | Security checklist report | The checklist passes | L | ⬜ |
| D9.2 | **Performance and reliability**: k6 load tests (payroll payout, attendance sync); index and query tuning; degradation drills (M-Pesa, SMS down) | Load test report | Performance budget met | M | ⬜ |
| D9.3 | **Operations**: Terraform for the chosen cloud; backups with point-in-time recovery; **restore drill**; observability dashboards and alerts; deployment, incident and breach runbooks | Runbooks, dashboards | **Phase 9 acceptance:** restore drill documented | L | ⬜ |

---

## 3. Where each brief section lands

Some brief sections (§5.8, §5.14, §5.15) aren't assigned to a phase in the brief's phase table. This map places them.

| Brief section | Deliverables |
|---|---|
| §5.1 Projects and sites | D1.4 (create project), D2.1 |
| §5.2 Bill of Quantities | D2.2, D2.3, D6.3 |
| §5.3 Materials, procurement and stores | D5.1–D5.3 |
| §5.4 Labour management | D3.1 (productivity and ledger finished in D4.1/D6.3) |
| §5.5 Attendance and biometrics | D3.2–D3.4 |
| §5.6 Payroll | D4.1, D4.3 |
| §5.7 M-Pesa and payments | D4.2, D4.3, D7.1 (STK/C2B for clients), D5.2 (B2B for suppliers) |
| §5.8 Spending, budget and cash flow | D5.4 |
| §5.9 Progress and site diary | D6.1–D6.3 |
| §5.10 Client portal | D7.1 |
| §5.11 Documents and compliance register | D8.4 |
| §5.12 Health and safety | D8.2 |
| §5.13 Plant and equipment | D8.3 |
| §5.14 Subcontractors and piece-rate | D4.1 (piece-rate pay), D6.3 (subcontracts, retention) |
| §5.15 Notifications | Provider interface in D1.3 (OTP); events added in each deliverable; centre and preferences in D7.3 |
| §5.16 USSD and SMS | D7.3 |
| §5.17 Reports and dashboards | KPIs grow with each phase; full reports in D8.1 |
| §6 Kenyan compliance | Config register from D1.1; rules land with their modules; DPIA gate in D3.4 |
| §7 Security | Continuous; formal review in D9.1 |
| §8 Reliability and scalability | Continuous; formal tests in D9.2 |
| §11 Seed and demo data | Grows per deliverable: company/users (D1.4) → projects/BQ (D2) → 40 labourers + 2 months of attendance (D3) → payroll + sandbox transactions (D4) → suppliers/deliveries (D5) |

---

## 4. Go-live gates (outside the build)

These have legal or commercial lead times, so they should start early:

| Gate | Needed before | Owner |
|---|---|---|
| ODPC registration as data controller/processor | Any real personal data in production | Company |
| Signed DPIA per tenant | Turning on biometric attendance (D3.4) | Tenant + DPO |
| Safaricom Daraja production go-live (per tenant shortcode; B2C needs a bulk disbursement account) | Real M-Pesa payouts (D4.3) | Each tenant + Safaricom |
| Africa's Talking USSD code and SMS sender ID | USSD/SMS in production (D7.3) | Company |
| WhatsApp Business account and approved templates | WhatsApp notifications | Company |
| Legal and tax review of every `COMPLIANCE-REVIEW` item | Payroll in production | Company + advisers |
| Security review (subset of D9.1) | **Any real money moving**, even in a pilot | Engineering |

> **Pilot design/delivery order approved; activation not approved:** one contractor, one site, manual/QR attendance, reviewed payroll, one payout method and reconciliation. Biometrics, USSD, other rails and advanced analytics stay on the roadmap. The gates above plus a coherent restore rehearsal, real-device offline test, assigned operators and controlled reconciliation evidence must pass first. See [PILOT_PLAN.md](./PILOT_PLAN.md).

---

## 5. Branches

| Deliverable | Branch |
|---|---|
| D0 | `phase-0/design-pack` |
| D1.1 | `phase-1/d1.1-workspace-ci` |
| D1.2 | `phase-1/d1.2-design-system-i18n` |
| D1.3 | `phase-1/d1.3-auth-mfa` |
| D1.4 | `phase-1/d1.4-tenancy-rbac-audit` |
| D2.1 | `phase-2/d2.1-projects-sites` |
| D2.2 | `phase-2/d2.2-bq-import` |
| D2.3 | `phase-2/d2.3-bq-variations` |
| D5.1 | `phase-5/d5.1-catalogue-suppliers` |
| D5.2 | backend on `main` (#25); web `phase-5/d5.2-web` |
| D5.3 | `phase-5/d5.3-stores` |
| D5.4 | `phase-5/d5.4-spending` |
| D6.1 | `phase-6/d6.1-quality` |
| D6.2 | `phase-6/d6.2-schedule` |
| D6.3 | `phase-6/d6.3-valuations` |
| D3.1 | `phase-3/d3.1-labour-registry` |
| D3.3 (web slice) | `phase-3/d3.3-web-timesheets` |
| … | `phase-N/dN.x-<slug>` |
