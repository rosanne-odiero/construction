# Build Brief: true, PM-Buddy — Construction Project Management System for Kenya

> **How to use:** Save this file in your repo as `docs/PROJECT_BRIEF.md`, open GitHub Copilot Chat in **Agent mode**, and say:
> *"Read #file:docs/PROJECT_BRIEF.md carefully. Start Phase 0 only."*
> Then approve one phase at a time.

---

## 1. Your role and how you must work

You are a senior full-stack engineer and solutions architect. Build a **production-grade, secure, scalable, multi-tenant construction project management system for the Kenyan market**, with a modern frontend, M-Pesa payments, Bill of Quantities (BQ) based cost and progress tracking, and labour management with biometric attendance.

Working rules:

1. **Work in phases** (Section 13). At the end of each phase, stop. Summarise what you built, list assumptions and open questions, and wait for my go-ahead.
2. **Phase 0 is design only, no feature code.** Produce `docs/ARCHITECTURE.md`, an ERD in Mermaid, an OpenAPI outline, the folder structure, a threat model, and a list of questions for me.
3. **Never hardcode** secrets, tax or statutory rates, M-Pesa limits or fees, overtime rules, or public holidays. Store them as configuration with `effective_from` / `effective_to` dates so they can change without a deploy.
4. **Don't invent Kenyan legal or tax rules.** Where a rule is unclear, make it configurable, add a `// COMPLIANCE-REVIEW:` comment, and log it in `docs/COMPLIANCE_TODO.md`.
5. TypeScript `strict` everywhere. Write unit and integration tests for every module, plus end-to-end tests for critical flows (payroll → M-Pesa payout, material request → delivery → payment, BQ import → valuation).
6. Use well-maintained libraries for auth, crypto and payments. Never hand-roll cryptography.
7. Small, reviewable commits with conventional commit messages.

---

## 2. Market context (read before designing)

- Users are contractors, developers, and individual home builders, **including diaspora clients building in Kenya from abroad** who need trustworthy, verifiable progress updates.
- Sites use a mix of **casual labourers (vibarua), skilled fundis, foremen and subcontractors**. Labourers are mostly paid **daily or weekly**, usually via **M-Pesa** or cash. Many have **feature phones, not smartphones**.
- The **BQ prepared by a Quantity Surveyor** is the backbone of costing, valuations and payment certificates.
- The biggest cost leaks are **material theft and wastage** (cement, steel, fuel, timber), **ghost workers and buddy-punching** on the muster roll, and **unrecorded cash payments**. The design must make these hard and visible.
- Sites often have **poor connectivity**. Supervisors use low-to-mid-range Android phones. **Site features must be offline-first.**
- Languages: **English and Kiswahili**. Currency: **KES** (optional display of USD/GBP/EUR equivalents for diaspora clients). Timezone: **Africa/Nairobi**. Phone numbers normalised to `2547XXXXXXXX` / `2541XXXXXXXX`.

---

## 3. Users, roles and permissions

Multi-tenant: each company (contractor or developer) is a tenant with many projects and sites. Access is role-based **and scoped per project**, enforced server-side with granular permissions (e.g. `payments.approve`, `bq.edit`, `attendance.override`).

| Role | Main capabilities |
|---|---|
| Platform Super Admin | Tenants, billing, platform config |
| Company Owner / Director | Everything in their company; final payment approval |
| Project Manager | Plans, approvals, budgets, payroll preparation |
| Site Agent / Site Engineer | Site diary, progress measurement, requisitions |
| Foreman / Supervisor | Daily attendance, gang assignment, task updates |
| Quantity Surveyor | BQ, variations, valuations, payment certificates |
| Storekeeper | Goods received, stock issues, stock takes |
| Accountant / Finance | Payments, reconciliation, statutory reports |
| Client / Project Owner | Read-only portal, pay instalments, approve variations |
| Consultant (Architect, Structural Engineer) | Issue instructions, inspections, approvals |
| Supplier | Portal: LPOs, deliveries, invoices, payment status |
| Labourer | USSD/SMS self-service only, no app required |

---

## 4. Tech stack (use unless you give a strong reason in Phase 0)

- **Monorepo:** pnpm + Turborepo, with a shared `packages/types` and `packages/validation` (Zod schemas shared by frontend and backend).
- **Web app (office, client and supplier portals):** Next.js (App Router, latest stable), React, TypeScript, Tailwind CSS, shadcn/ui, TanStack Query, React Hook Form + Zod, Apache ECharts or Recharts for charts, an open-source Gantt component. Installable as a PWA.
- **Site app (Android-first):** React Native with Expo. Offline storage in SQLite, background sync, camera, GPS, and native modules for biometric scanners. Supports a **kiosk mode** for a shared site tablet.
- **Backend:** NestJS (TypeScript), REST + OpenAPI, PostgreSQL (latest stable) with Prisma, Redis, BullMQ for background jobs, S3-compatible object storage (MinIO locally) for photos and documents.
- **Messaging:** Africa's Talking (SMS and USSD), WhatsApp Business Cloud API, email (SMTP/SES). Behind a `NotificationProvider` interface.
- **Payments:** Safaricom Daraja API behind a `PaymentProvider` interface, so an aggregator or bank API (e.g. PesaLink) can be added later.
- **Infra:** Docker, docker-compose for local dev, GitHub Actions CI/CD, infrastructure-as-code (Terraform). Hosting region configurable; document cross-border data transfer considerations under Kenya's Data Protection Act.
- **Observability:** OpenTelemetry, structured JSON logs (pino), Sentry, health and readiness endpoints.

---

## 5. Core modules

### 5.1 Projects and sites
- Projects with client, contract sum, contract type, start/end dates, location, and one or more **sites with a GPS geofence** (polygon or radius).
- Phases / work breakdown structure (WBS), milestones, baseline schedule.
- Project team assignment by role.
- Project status dashboard: % complete, budget burn, cash position, labour on site today, open issues.

### 5.2 Bill of Quantities (BQ)
- **Import BQ from Excel (.xlsx) with a column-mapping screen**, because Kenyan QS formats vary. Preserve the hierarchy: Bill → Section/Element → Item.
- Item fields: item ref, description, unit (m³, m², m, kg, t, No., Item, LS), quantity, rate, amount, notes.
- Support Preliminaries, Provisional Sums, Prime Cost (PC) sums, Contingencies, Dayworks, and VAT (rate configurable, default 16%).
- **BQ versions and Variation Orders**, linked to an Architect's/Engineer's Instruction, with approval workflow and audit trail. Show original vs revised contract sum.
- **Rate build-up library** (configurable): e.g. 1 m³ of concrete of a given mix = X bags cement + Y t sand + Z t ballast + labour hours. Used to compute theoretical material consumption.
- **Progress measurement against BQ:** the site engineer records quantity completed per item with photo evidence; the system computes % complete and value of work done.
- **Earned value:** Planned Value, Earned Value, Actual Cost, CPI, SPI, and an **S-curve** (planned vs actual).
- **Interim valuations and Interim Payment Certificates:** gross value of work done + materials on site − retention (configurable %, optional cap) − previous certificates = amount due. Track **retention release** at practical completion and at the end of the defects liability period.
- Budget vs actual and cost-to-complete forecast **per BQ item and per bill**.
- Export BQ, valuations and certificates to Excel and PDF.

### 5.3 Materials, procurement and stores
- **Material catalogue** with Kenyan units and conversions: 50 kg cement bags, ballast and sand by tonne or lorry trip (configurable conversion), building blocks/machine-cut stones by piece, steel bars (Y8–Y32) by length and kg, BRC mesh, timber, roofing sheets by gauge, etc.
- Flow: **Material requisition** (site) → approval → **RFQ / quotation comparison** (configurable minimum number of quotes) → **LPO** → **delivery / Goods Received Note** (quantity counted, photo of delivery note and goods, vehicle reg, received by, GPS + timestamp) → **supplier invoice** → **payment**.
- **Three-way match** (LPO ↔ GRN ↔ invoice) before payment can be approved. Mismatches block payment until resolved.
- Capture the **KRA eTIMS invoice number** on supplier invoices and flag invoices without one (expense deductibility depends on it).
- **Store per site:** stock ledger, issues to a BQ item or gang, returns, inter-site transfers, periodic stock takes, wastage records, low-stock alerts.
- **Variance alerts:** theoretical consumption (progress × rate build-up) vs actual issued. Flag when variance exceeds a configurable threshold (e.g. cement issued far above what the measured concrete needs).
- **Price history** per material and supplier, with price-change alerts.
- **Supplier management:** KRA PIN, eTIMS status, M-Pesa Paybill/Till and account number, bank details, credit terms, balances, statements, ratings.

### 5.4 Labour management
- **Labourer registration:** full name, National ID / Alien ID / passport, photo, date of birth (**block registration under 18**), gender, M-Pesa phone number, trade/speciality, skill level, engagement type, rate, next of kin and emergency contact, home county, NSSF number, SHA number, KRA PIN (optional for casuals), induction date, PPE issued, certifications (e.g. welding, working at heights).
- **Trades (configurable list):** mason, carpenter, steel fixer, plumber, electrician, painter, tiler, welder, plasterer, roofer, machine/plant operator, foreman, general labourer/helper (kibarua), watchman, storekeeper.
- **Skill level** aligned to NCA categories (skilled, semi-skilled, unskilled). For skilled workers and site supervisors, capture **NCA accreditation card number and expiry** and alert before expiry.
- **Rates:** default daily rate per trade per project, overridable per worker; hourly, daily or piece-rate.
- **Gangs/crews** with a foreman; daily assignment of workers to a site and BQ activity.
- **Productivity:** output per worker-day per trade (e.g. m² of blockwork per mason per day), compared across gangs and projects.
- **Per-labourer ledger:** days worked, hours, overtime, total earned, total paid, advances outstanding, per project and overall.
- **Casual-to-term conversion warning:** flag casual workers approaching the continuous-engagement threshold under the Employment Act (threshold configurable, mark `COMPLIANCE-REVIEW`).
- Worker history across projects, performance notes, and a "do not rehire" flag that requires a reason and is visible only to managers.

### 5.5 Attendance and biometrics
Design attendance as a **pluggable "capture method"** so a site can use whichever fits:

1. **Face recognition with liveness detection** on a shared site tablet in kiosk mode (1:N match **only against that site's roster**).
2. **Fingerprint** via an external USB/OTG scanner on an Android tablet (vendor SDK behind an interface).
3. **Standalone biometric terminals** (e.g. ZKTeco-style devices) integrated through the vendor's push protocol or SDK.
4. **Non-biometric fallback (mandatory):** QR/NFC worker card + photo capture + supervisor confirmation, for workers who decline biometrics or when hardware fails.

Important constraints:
- **Do not use the phone's built-in fingerprint/face unlock (Android BiometricPrompt / WebAuthn) to identify labourers.** It only confirms the phone's owner and cannot tell which of 50 workers is present. Use it only to secure supervisor and manager logins.
- Every check-in/check-out records: worker, method, match confidence, device ID (registered to the site), GPS position and whether inside the geofence, device time and server time, photo (where applicable).
- **Offline mode:** records are stored encrypted on the device, signed, and synced later. Detect clock tampering by comparing device time, monotonic time and server time on sync; flag drift.
- **Anti-fraud:** duplicate detection, check-ins outside the geofence flagged, same worker on two sites, impossible travel, manual overrides require a reason and are flagged for review, all edits audit-logged.
- **Timesheet rules (configurable):** normal hours, breaks, lateness, half-day, absence, overtime multipliers for weekdays, rest days and **Kenyan public holidays** (holiday calendar configurable).
- **Biometric data handling:** see Section 6 — consent, DPIA, template-only storage, encryption, deletion.

### 5.6 Payroll and labourer payments
- Pay periods: daily, weekly, fortnightly or monthly, per project.
- **Gross pay** = attendance × rate + overtime + piece-rate output + allowances. **Net pay** = gross − advances − statutory deductions − other deductions.
- **Statutory deductions engine (configurable, versioned by effective date)** for PAYE, NSSF, SHIF and the Affordable Housing Levy, plus employer-side NSSF, Housing Levy and NITA. Which deductions apply to which engagement type must be configurable. Seed values are in Section 6; mark all as `COMPLIANCE-REVIEW`.
- **Salary advances** with automatic recovery from future pay.
- **Maker-checker approval:** foreman/PM prepares the payroll batch → Finance reviews → Owner/Director approves with **MFA step-up** → disbursement. Approval limits per role.
- **Bulk M-Pesa B2C disbursement** (Section 5.7) with per-worker status: pending, sent, confirmed, failed, reversed.
- **Payslip by SMS** in English or Kiswahili (days, rate, gross, deductions, net, M-Pesa reference).
- Exports for statutory remittance (PAYE, NSSF, SHIF, Housing Levy). Use CSV templates I can map to the official upload formats; flag formats as `COMPLIANCE-REVIEW`.

### 5.7 M-Pesa and payments (Safaricom Daraja)
Implement a `DarajaProvider` behind the `PaymentProvider` interface, sandbox first, with configuration per tenant (each company has its own shortcode and credentials).

- **OAuth** token generation with caching and refresh.
- **M-Pesa Express (STK Push) + STK Query:** clients pay deposits and instalments against a payment certificate or invoice.
- **C2B (register validation and confirmation URLs):** clients paying via the Paybill menu, using a project/invoice code as the account number.
- **B2C:** pay labourer wages (salary payment type) and individual fundis.
- **B2B (Paybill / Buy Goods):** pay suppliers' Paybill or Till numbers with the correct account reference.
- **Transaction Status, Account Balance and Reversal** APIs.
- **SecurityCredential:** the initiator password encrypted with Safaricom's certificate; certificate and credentials stored in a secrets manager, never in code or logs.

Reliability and security rules for payments:
- All results are **asynchronous**. A payment is only "paid" after a confirmed result callback or Transaction Status check, never from the initial API response or the client side.
- Daraja callbacks are not signed. Protect them with: HTTPS only, a unique unguessable token in each callback URL, a configurable Safaricom IP allowlist, and **matching every callback to a stored pending request** (CheckoutRequestID, ConversationID, OriginatorConversationID). Unknown callbacks are stored and alerted, never applied.
- **Do not use the phone number in STK callbacks as a lookup key** (it may be masked). Match on request IDs.
- **Idempotency:** idempotency keys on every outgoing payment; duplicate callbacks are ignored safely. Use the **transactional outbox pattern** and BullMQ with retries and backoff.
- Respond to callbacks fast (200 OK) and process them in a queue. Store every raw request and response payload (with secrets redacted).
- **Timeout handling:** if no result arrives within a configurable time, query Transaction Status and reconcile.
- **Recipient name check:** compare the receiver name returned in B2C results to the registered worker name; flag mismatches for review.
- **Float check:** check Account Balance before a bulk payout and block if insufficient.
- **Daily reconciliation job** against M-Pesa transaction records or an uploaded M-Pesa statement; show matched, unmatched and disputed items.
- Track **M-Pesa transaction charges** as a project cost.
- Transaction and daily limits configurable, not hardcoded.
- Also support recording **bank transfers and cash** payments (cash requires a photo/signature receipt and a reason).

### 5.8 Spending, budget and cash flow
- Every shilling is tagged to: project, site, BQ item or cost code, category (materials, labour, plant, subcontract, preliminaries, fees, permits, transport, petty cash), supplier/worker, and payment reference.
- **Petty cash:** float per site, expenses with receipt photo, top-ups, reconciliation.
- **M-Pesa SMS parser:** paste an M-Pesa confirmation message and auto-fill amount, reference, recipient, date and time.
- Budget vs actual by project, bill, BQ item and category; committed costs (approved LPOs not yet paid); **cash-flow forecast** (upcoming payroll, LPO payments, expected client payments).
- Alerts: budget threshold reached, unusual spend, duplicate payments, payments without supporting documents.

### 5.9 Progress tracking and site diary
- **Daily site diary:** weather, workforce by trade (auto-filled from attendance), work done (linked to BQ items), materials received and used, plant used, visitors, instructions received, delays and causes, safety incidents. Submitted and signed by the site agent; locked after approval.
- **Photo progress:** geotagged and timestamped (server-verified), tagged to BQ item, location and date; before/after comparisons; timeline view.
- **Schedule:** Gantt with dependencies, milestones, baseline vs actual, delay log with causes (rain, materials, late payment, approvals, design changes).
- **Inspections and quality:** configurable checklists (setting out, foundation, slab, roofing, etc.), county and consultant inspections, concrete cube test results (7/28-day), slump tests, sign-offs.
- **Snag list / defects**, practical completion, defects liability period tracking.

### 5.10 Client / owner portal
- Progress %, S-curve, photo timeline with verified location and time, site diary summaries, milestones.
- Payment certificates and statements; **pay via STK Push**; payment history.
- Approve or reject variations with comments.
- Designed for diaspora clients: clear, trustworthy, mobile-friendly, optional foreign-currency display.

### 5.11 Documents, approvals and compliance register
- Document repository with version control: drawings, contracts, BQs, permits, certificates, insurance policies.
- **Compliance register per project with expiry reminders:** county building approval, **NCA project registration** (and any NCA levy if applicable — configurable), NEMA licence where required, contractor NCA registration, insurance (e.g. Contractor's All Risk, WIBA), OSH workplace registration, site signboard requirement.
- Consultant instructions and approvals log.

### 5.12 Health and safety
- Site induction records, toolbox talks with attendance, PPE register, incident and near-miss reporting with photos, first-aid log, corrective actions. Aligned to the Occupational Safety and Health Act and Work Injury Benefits Act (mark details `COMPLIANCE-REVIEW`).

### 5.13 Plant and equipment
- Owned and hired plant (mixers, vibrators, excavators, scaffolding, formwork): hire rates, days/hours used, fuel issued and consumption, breakdowns, maintenance, operator assignment.

### 5.14 Subcontractors and piece-rate work
- Labour-only and supply-and-fix subcontracts linked to BQ items.
- **Piece-rate jobs** (e.g. plaster per m², blockwork per m², tiling per m²): measured quantity × agreed rate, approval, then M-Pesa payment.
- Subcontractor retention, advances and statements.

### 5.15 Notifications
- SMS, WhatsApp, email, and push, with templates in English and Kiswahili and per-user preferences.
- Events: payment sent/received, approvals pending, low stock, budget alerts, document expiry, attendance anomalies, missed site diary.

### 5.16 Labourer self-service (USSD and SMS)
- USSD menu (via Africa's Talking) in English and Kiswahili: days worked this period, amount earned, payments received, advances outstanding.
- Verification by ID number + PIN. No smartphone required.

### 5.17 Reports and dashboards
- Owner dashboard across projects: cash position, spend by category, budget burn, labour cost per day, top variances, upcoming payments, alerts.
- Standard reports: muster roll, payroll summary, labourer ledger, material reconciliation, stock valuation, supplier statements, valuation history, cost report, M-Pesa reconciliation, audit log.
- Export to PDF and Excel; scheduled email reports.

---

## 6. Kenyan compliance (all configurable, all flagged for human review)

- **Data Protection Act, 2019 and the ODPC Guidance Note on Biometric Data:**
  - Biometric data is sensitive personal data. The company must be registered with the ODPC and must complete a **Data Protection Impact Assessment (DPIA) before biometric attendance goes live**. Generate a DPIA template in `docs/`.
  - **Explicit, informed consent** captured in English/Kiswahili (read aloud option), stored with timestamp and version. **A non-biometric attendance alternative must always exist.**
  - Store **biometric templates/embeddings only**, not raw fingerprint images; encrypt them with a separate key; restrict access; never send them to analytics or logs.
  - Retention and deletion: automatically delete biometric data a configurable time after a worker's engagement ends; support data subject requests (access, correction, deletion).
  - Breach response runbook (notify the ODPC within the legal timeframe — configurable).
- **Payroll seed values (verify before go-live; store with effective dates):**
  - PAYE monthly bands: 10% on first KES 24,000; 25% on next 8,333; 30% on next 467,667; 32.5% on next 300,000; 35% above 800,000; personal relief KES 2,400/month.
  - NSSF: 6% employee + 6% employer on pensionable pay up to the upper earnings limit (seed: KES 108,000 from February 2026).
  - SHIF: 2.75% of gross (seed minimum KES 300).
  - Affordable Housing Levy: 1.5% employee + 1.5% employer.
  - NITA: employer levy per employee (configurable).
  - Deductions are applied before PAYE where the law allows; remittance due dates configurable.
- **NCA:** project registration, contractor registration and category, accreditation of skilled workers and site supervisors (validity period configurable), construction levy configurable (may be zero).
- **KRA eTIMS:** capture and validate eTIMS invoice details on supplier invoices; design for a later direct eTIMS integration.
- **Child labour:** block registration of anyone under 18.

---

## 7. Security requirements

- Target **OWASP ASVS Level 2**; follow the OWASP Top 10 and API Security Top 10.
- **Auth:** email or phone + password (Argon2id), SMS/WhatsApp OTP, **mandatory TOTP or passkey MFA for Finance, Owner and Admin roles**, step-up MFA for approving payments, short-lived access tokens + rotating refresh tokens in httpOnly, Secure, SameSite cookies. Device binding for site tablets.
- **Authorisation:** RBAC + project-level scoping, enforced in the API and in **PostgreSQL row-level security by `tenant_id`**. Tests proving one tenant cannot read another's data.
- **Encryption:** TLS everywhere; encryption at rest; **field-level encryption** for ID numbers, KRA PINs, phone numbers, bank details and biometric templates; keys in a KMS/secrets manager with rotation.
- **Payments:** maker-checker, approval limits, MFA step-up, alerting on unusual payouts (new recipient + large amount, many payouts to one number, payouts outside business hours).
- **Append-only audit log** for every create/update/delete and every approval, with who, what, when, where (IP/device) and before/after values.
- Input validation with Zod on both sides, output encoding, CSRF protection, strict CSP, rate limiting and brute-force protection, secure file uploads (type checks, size limits, malware scanning hook, private buckets with signed URLs).
- Dependency scanning, secret scanning, SAST in CI; no secrets in the repo; `.env.example` only.

---

## 8. Reliability and scalability

- Stateless API, horizontally scalable; background work in queues; connection pooling.
- **Offline-first site app** with a sync engine: local queue, retries, conflict resolution rules (server wins for approved records, last-write-wins with audit for drafts), and a visible sync status.
- Idempotent endpoints for anything financial; outbox pattern for external calls.
- Automated database backups with point-in-time recovery; documented restore test; target RPO ≤ 15 min, RTO ≤ 4 h (configurable).
- Graceful degradation when M-Pesa, SMS or WhatsApp are down (queue and retry, show status to users).
- Pagination, indexing and caching for large projects (thousands of workers, tens of thousands of transactions).
- Performance budget: usable on a low-end Android phone on 3G; web pages interactive in under ~3 s on mobile.

---

## 9. Frontend and UX direction

- **Modern, clean, professional.** Neutral base with one strong accent colour; clear typography; generous spacing; light and dark mode.
- **Mobile-first for site users:** large touch targets, high contrast for outdoor sunlight, minimal typing (pickers, scanners, voice notes), works offline.
- **Desktop-first for office users:** dense data tables with filters, saved views, bulk actions, keyboard shortcuts, and side-panel detail views.
- Dashboards with KPI cards, S-curves, budget burn charts and map views of sites.
- Full **English/Kiswahili i18n**, KES formatting (e.g. `KES 1,250,000`), dates in `DD/MM/YYYY`, Africa/Nairobi time.
- Accessibility: WCAG 2.2 AA.
- Clear empty states, loading skeletons, and human error messages (in both languages).

---

## 10. Data model (starting point — refine in Phase 0)

Tenant, User, Role, Permission, ProjectMembership, Project, Site, Geofence, Phase/WBS, Milestone, ScheduleActivity, BQ, BQVersion, BQBill, BQSection, BQItem, RateBuildUp, VariationOrder, Instruction, ProgressMeasurement, Valuation, PaymentCertificate, Retention, Material, Unit, UnitConversion, Supplier, Requisition, RFQ, Quotation, LPO, GoodsReceivedNote, SupplierInvoice, Store, StockLedgerEntry, StockTake, Labourer, Trade, SkillLevel, Accreditation, Gang, GangAssignment, BiometricEnrolment, Consent, AttendanceDevice, AttendanceEvent, Timesheet, OvertimeRule, PublicHoliday, PayPeriod, PayrollBatch, PayrollLine, StatutoryRule, Advance, PieceRateJob, Subcontract, Payment, PaymentProviderRequest, PaymentCallback, Reconciliation, Expense, PettyCashFloat, SiteDiary, Photo, Inspection, Snag, Document, ComplianceItem, SafetyIncident, ToolboxTalk, PPEIssue, Plant, PlantUsage, FuelIssue, Notification, AuditLog.

All tables carry `tenant_id`, `created_at`, `created_by`, `updated_at`, `updated_by`; soft deletes where appropriate; money as integer cents/`numeric`, never floats.

---

## 11. Seed and demo data

Realistic Kenyan demo data: a contractor company with two projects (e.g. a 4-storey apartment block in Ruiru, Kiambu, and a bungalow in Kitengela, Kajiado), a sample BQ with Preliminaries, Substructure, Superstructure, Finishes and Services, 40 labourers across trades with Kenyan names, suppliers (hardware, quarry, steel), two months of attendance, payroll, deliveries and M-Pesa sandbox transactions.

---

## 12. Testing and quality

- Unit tests for calculations (payroll, statutory deductions, valuations, earned value, variance).
- Integration tests for the API and database, including tenant-isolation tests.
- **Daraja sandbox + a local mock server** that can simulate success, failure, timeout, duplicate and out-of-order callbacks.
- End-to-end tests (Playwright for web, Detox or Maestro for the site app).
- Load test scripts for payroll payout and attendance sync.
- Linting, formatting, type checks and tests must pass in CI before merge.

---

## 13. Phases and acceptance criteria

| Phase | Scope | Done when |
|---|---|---|
| **0. Design** | Architecture, ERD, API outline, threat model, DPIA outline, questions | I approve the docs |
| **1. Foundation** | Monorepo, CI, auth + MFA, tenants, RBAC, audit log, design system, i18n | Users can sign up, log in with MFA, create a company and project; tenant isolation tests pass |
| **2. Projects & BQ** | Projects, sites, geofences, BQ import with mapping, versions, variations | A real Excel BQ imports correctly and totals match |
| **3. Labour & attendance** | Registration, consent, gangs, attendance (fallback method first, then one biometric method), offline sync | A foreman can record attendance offline and it syncs correctly with anomalies flagged |
| **4. Payroll & M-Pesa** | Payroll engine, statutory rules, advances, maker-checker, Daraja (B2C, STK, C2B, B2B, status, balance, reversal), reconciliation | A weekly payroll for 40 workers pays out in sandbox with all callbacks reconciled; failed and duplicate cases handled |
| **5. Materials & stores** | Requisition → RFQ → LPO → GRN → invoice → payment, stores, variance alerts | Three-way match blocks bad payments; variance alert fires on test data |
| **6. Progress & valuations** | Site diary, photos, schedule/Gantt, progress measurement, EVM, S-curve, valuations, certificates | An interim payment certificate generates correctly from measured progress |
| **7. Portals & self-service** | Client portal with STK Push, supplier portal, USSD/SMS for labourers | A client can view progress and pay; a labourer can check pay via USSD |
| **8. Reports, H&S, plant, compliance register** | Dashboards, reports, exports, safety, plant, document expiry | All reports export to PDF/Excel |
| **9. Hardening** | Security review, performance, backups/restore drill, observability, docs, deployment runbook | Security checklist passes; restore drill documented |

---

## 14. Definition of done (every phase)

- Code, tests and docs updated; CI green.
- No secrets committed; `.env.example` updated.
- New configuration values documented with their source and `COMPLIANCE-REVIEW` status.
- Short demo script in `docs/demos/phase-N.md` explaining how to try the new features.

**Start with Phase 0 only. Ask me your questions before writing any feature code.**
