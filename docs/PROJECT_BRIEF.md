# Build Brief: true, PM-Buddy — Construction Project Management System for Kenya

> **How to use:** Save this file in your repo as `docs/PROJECT_BRIEF.md`, open GitHub Copilot Chat in **Agent mode**, and say:
> *"Read #file:docs/PROJECT_BRIEF.md carefully. Start Phase 0 only."*
> Then approve one phase at a time.

> **Scope and precedence:** Section 15 incorporates the PM-Buddy additions and takes precedence over conflicting original wording. Existing modules and the Phase 0–9 roadmap remain in scope. Approval to implement Phase 1 (D1.1–D1.4) does not approve later phases, the proposed pilot, deployment, live payouts or biometric collection. Preserve existing work and record actual evidence in [IMPLEMENTATION_STATUS.md](./IMPLEMENTATION_STATUS.md).
>
> **Separate pilot decision:** The owner subsequently approved the [one-site pilot design and proposed delivery order](./PILOT_PLAN.md) only. Live activation and later-phase implementation remain gated.

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
- Languages: **English (default) and Kiswahili**. Currency: **KES** (optional display of USD/GBP/EUR equivalents for diaspora clients). Timezone: **Africa/Nairobi**. Phone numbers normalised to `2547XXXXXXXX` / `2541XXXXXXXX`.

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
- **Labourer registration:** full name, date of birth (**block registration under 18**), trade/speciality, skill level, engagement type and rate. Collect ID, photo, gender, payment details, next of kin/emergency contact, home county, statutory identifiers, induction, PPE and certification details only where necessary for the engagement and documented purpose, with appropriate access and retention controls.
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
- **Gross pay** = approved compatible earning components (attendance-based earnings, overtime, piece-rate output and allowances). Define which components may coexist; never double-count attendance and piece-rate earnings. **Net pay** = gross − approved advance recovery − applicable verified statutory deductions − other authorised deductions.
- **Statutory deductions engine (configurable, versioned by effective date)** for PAYE, NSSF, SHIF and the Affordable Housing Levy, plus employer-side NSSF, Housing Levy and NITA. Which deductions apply to which engagement type must be configurable. Seed values are in Section 6; mark all as `COMPLIANCE-REVIEW`.
- **Salary advances** with automatic recovery from future pay.
- **Maker-checker approval:** foreman/PM prepares the payroll batch → Finance reviews → Owner/Director approves with **MFA step-up** → disbursement. Approval limits per role.
- **Bulk M-Pesa B2C disbursement** (Section 5.7) with separate obligations, attempts and settlements; attempt states and uncertainty handling are defined in Section 15.D. Do not equate an accepted request with settlement.
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
- All results are **asynchronous**. A payment is only "paid" after a verified provider outcome matched to the expected identifiers, amount, currency and direction, never from the initial API response or the client side.
- Verify current official Daraja callback authentication and status-query capabilities before implementation; do not assume callback signatures exist. Use HTTPS, protected callback URLs and supported network restrictions as defence in depth, not proof of settlement. **Match callbacks to stored requests** (CheckoutRequestID, ConversationID, OriginatorConversationID); quarantine unknown or mismatched callbacks and alert for review.
- **Do not use the phone number in STK callbacks as a lookup key** (it may be masked). Match on request IDs.
- **Idempotency:** keys bind tenant, operation and payload fingerprint; reject changed payloads under an existing key. Use a transactional outbox and bounded, safe retries. Internal deduplication does not guarantee external exactly-once delivery.
- Acknowledge callbacks only after durable inbox persistence; return non-success if persistence fails. Process repeatably from the inbox even during queue outages. Protect retained provider evidence with redaction, restricted access and a reviewed retention policy.
- **Timeout handling:** if a timeout or crash leaves provider acceptance uncertain, mark the attempt `unknown` and reconcile using supported status/statement procedures before another payout. A queue retry must not resubmit it blindly.
- **Recipient verification:** independently verify payment details before approval using supported procedures. Changed details invalidate affected approvals. A name returned after disbursement detects problems only after payment.
- **Float check:** a provider balance check is advisory and can race; reserve approved internal funding where appropriate and handle insufficient provider funds safely.
- **Daily reconciliation job** against M-Pesa transaction records or an uploaded M-Pesa statement; show matched, unmatched and disputed items.
- Track **M-Pesa transaction charges** as a project cost.
- Transaction and daily limits configurable, not hardcoded.
- Also support recording **bank transfers and cash** payments (cash requires a photo/signature receipt and a reason).

### 5.8 Spending, budget and cash flow
- Every shilling is tagged to: project, site, BQ item or cost code, category (materials, labour, plant, subcontract, preliminaries, fees, permits, transport, petty cash), supplier/worker, and payment reference.
- **Petty cash:** float per site, expenses with receipt photo, top-ups, reconciliation.
- **M-Pesa SMS parser:** paste a message to create a draft with amount, reference, recipient, date and time. SMS text, receipt images and manually entered references do not independently confirm settlement.
- Budget vs actual by project, bill, BQ item and category; committed costs (approved LPOs not yet paid); **cash-flow forecast** (upcoming payroll, LPO payments, expected client payments).
- Alerts: budget threshold reached, unusual spend, duplicate payments, payments without supporting documents.

### 5.9 Progress tracking and site diary
- **Daily site diary:** weather, workforce by trade (auto-filled from attendance), work done (linked to BQ items), materials received and used, plant used, visitors, instructions received, delays and causes, safety incidents. Submitted and signed by the site agent; locked after approval.
- **Photo progress:** retain claimed capture location/time separately from server receipt time, with provenance and confidence; do not label offline metadata server-verified. Tag to BQ item, location and date; before/after comparisons; timeline view.
- **Schedule:** Gantt with dependencies, milestones, baseline vs actual, delay log with causes (rain, materials, late payment, approvals, design changes).
- **Inspections and quality:** configurable checklists (setting out, foundation, slab, roofing, etc.), county and consultant inspections, concrete cube test results (7/28-day), slump tests, sign-offs.
- **Snag list / defects**, practical completion, defects liability period tracking.

### 5.10 Client / owner portal
- Progress %, S-curve, photo timeline showing evidence provenance and verification limitations, site diary summaries, milestones.
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
  - Biometric data is sensitive personal data. Review applicable ODPC registration obligations and complete a **Data Protection Impact Assessment (DPIA) before biometric attendance goes live**. Generate a DPIA template in `docs/`; require documented legal/privacy approval before rollout.
  - Review lawful basis, notices and employee consent limitations; do not assume consent alone is sufficient. Where applicable, capture explicit, informed consent in English/Kiswahili (read aloud option), with timestamp and version. **A non-biometric attendance alternative must always exist.**
  - Store **biometric templates/embeddings only**, not raw fingerprint images; encrypt them with a separate key; restrict access; never send them to analytics or logs.
  - Retention and deletion: automatically delete biometric data a configurable time after a worker's engagement ends; support data subject requests (access, correction, deletion).
  - Breach response runbook (notify the ODPC within the legal timeframe — configurable).
- **Payroll seed values (unverified reference examples only; disabled in production until an authorised reviewer approves authoritative sources and effective dates):**
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
- **Auth:** email or phone + password (Argon2id), SMS/WhatsApp OTP, **mandatory TOTP or passkey MFA for Finance, Owner and Admin roles**, step-up MFA for approving payments. Web sessions use httpOnly, Secure, SameSite cookies with rotation and CSRF protection. Native authentication uses reviewed flows and platform secure storage, not browser-cookie assumptions. Include recovery, expiry and session/device revocation without bypassing financial approvals.
- **Authorisation:** RBAC + project-level scoping, enforced in the API and in **PostgreSQL row-level security by `tenant_id`**. Tests proving one tenant cannot read another's data.
- **Encryption:** TLS everywhere; encryption at rest; **field-level encryption** for ID numbers, KRA PINs, phone numbers, bank details and biometric templates; keys in a KMS/secrets manager with rotation.
- **Payments:** maker-checker, approval limits, MFA step-up, alerting on unusual payouts (new recipient + large amount, many payouts to one number, payouts outside business hours).
- **Append-only audit log** for every create/update/delete and every approval, with who, what, when and authorised context. Before/after diffs must use redacted summaries or protected references, never secrets, raw biometrics or sensitive field values in ordinary logs, traces or audit records.
- Input validation with Zod on both sides, output encoding, CSRF protection, strict CSP, rate limiting and brute-force protection, secure file uploads (type checks, size limits, malware scanning hook, private buckets with signed URLs).
- Dependency scanning, secret scanning, SAST in CI; no secrets in the repo; `.env.example` only.

---

## 8. Reliability and scalability

- Stateless API, horizontally scalable; background work in queues; connection pooling.
- **Offline-first site app** with stable event IDs, versioned schemas, at-least-once delivery, server deduplication, per-item durable acknowledgement and visible recovery states. Attendance, stock and financial events are append-only; corrections reference originals. Editable records use optimistic version checks and consequential conflicts require review, never silent last-write-wins. Approved records are immutable.
- Idempotent endpoints for anything financial; outbox pattern for external calls.
- Automated database backups with point-in-time recovery; documented restore test; target RPO ≤ 15 min, RTO ≤ 4 h (configurable).
- Graceful degradation when M-Pesa, SMS or WhatsApp are down: show pending/unknown states and use bounded provider-specific retries. Reconcile uncertain payments before resubmission; notification retries must never retry a payment.
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

Tenant-owned tables carry `tenant_id` and appropriate creation/actor metadata; distinguish global identity/platform records explicitly. Mutable records carry update/version metadata. Immutable journals, audit and event records are append-only, with linked corrections rather than updates or soft deletion. Define retention by data class, legal holds and deletion propagation, not universal soft deletion. Money uses defined integer minor units or decimal `numeric`, never floats; tenant-consistent foreign keys and database constraints enforce invariants.

Extend the starting model with PayableObligation, PaymentAttempt, ProviderTransaction, SettlementAllocation, JournalAccount, JournalEntry, JournalLine, ApprovalSnapshot, IdempotencyRecord, CallbackInbox, OutboxEvent and versioned SyncEvent. Do not collapse these into one mutable payment record.

---

## 11. Seed and demo data

Synthetic Kenyan-context demo data: a fictional contractor company with two projects (e.g. a 4-storey apartment block in Ruiru, Kiambu, and a bungalow in Kitengela, Kajiado), a sample BQ with Preliminaries, Substructure, Superstructure, Finishes and Services, 40 fictional labourers across trades, suppliers (hardware, quarry, steel), two months of attendance, payroll, deliveries and M-Pesa sandbox transactions. Use synthetic identities, phone numbers and credentials; never send test payments or notifications to real people.

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
| **0. Design** | Architecture, ERD, API outline, threat model, DPIA outline, questions, Section 15.B design and acceptance documents | I approve the docs; proposed pilot/delivery-order changes require separate approval |
| **1. Foundation** | Monorepo, CI, auth + MFA, tenants, RBAC, audit log, design system, i18n | Users can sign up, log in with MFA, create a company and project; tenant isolation tests pass |
| **2. Projects & BQ** | Projects, sites, geofences, BQ import with mapping, versions, variations | A real Excel BQ imports correctly and totals match |
| **3. Labour & attendance** | Registration, consent, gangs, attendance (fallback method first, then one biometric method), offline sync | A foreman can record attendance offline and it syncs correctly with anomalies flagged |
| **4. Payroll & M-Pesa** | Payroll engine, statutory rules, advances, maker-checker, Daraja (B2C, STK, C2B, B2B, status, balance, reversal), reconciliation | A weekly payroll for 40 workers pays out in sandbox with all callbacks reconciled; failed and duplicate cases handled |
| **5. Materials & stores** | Requisition → RFQ → LPO → GRN → invoice → payment, stores, variance alerts | Three-way match blocks bad payments; variance alert fires on test data |
| **6. Progress & valuations** | Site diary, photos, schedule/Gantt, progress measurement, EVM, S-curve, valuations, certificates | An interim payment certificate generates correctly from measured progress |
| **7. Portals & self-service** | Client portal with STK Push, supplier portal, USSD/SMS for labourers | A client can view progress and pay; a labourer can check pay via USSD |
| **8. Reports, H&S, plant, compliance register** | Dashboards, reports, exports, safety, plant, document expiry | All reports export to PDF/Excel |
| **9. Hardening** | Final security review, performance, recovery rehearsal, observability, docs, deployment runbook; foundational controls start in the first relevant phase | Security checklist passes; coherent restore drill and release evidence documented |

---

## 14. Definition of done (every phase)

- Code, tests and docs updated; CI green.
- No secrets committed; `.env.example` updated.
- New configuration values documented with their source and `COMPLIANCE-REVIEW` status.
- Short demo script in `docs/demos/phase-N.md` explaining how to try the new features.
- Section 15 acceptance matrix satisfied with commands actually run and manual evidence distinguished; migrations, recovery, permissions, limitations and implementation status documented. CI alone is not production approval.

**For a new project, start with Phase 0 only. In this repository, resume the approved phase recorded in [IMPLEMENTATION_STATUS.md](./IMPLEMENTATION_STATUS.md); do not restart completed work. Ask unresolved scope questions before writing feature code.**

---

## 15. Mandatory safeguards (PM-Buddy additions)

These requirements supplement the original scope and take precedence over conflicting wording. Preserve the existing modules and roadmap; propose pilot-scope or delivery-order changes for review. Do not restart completed work or implement later phases without approval.

### A. Copilot working contract

- Inspect existing code, migrations, tests and repository instructions before changing anything. Preserve unrelated work. Do not rebuild an existing application without justification.
- Work on one approved phase at a time. Record implementation status, decisions, unresolved risks and the next step in [IMPLEMENTATION_STATUS.md](./IMPLEMENTATION_STATUS.md) so a new session can resume.
- Use a modular monolith initially unless documented constraints justify distributed services. Keep business logic separate from HTTP handlers, UI and external providers.
- Pin compatible dependency versions and commit the lockfile. Verify current official documentation before selecting integrations. Do not assume a named API, SDK or library feature exists.
- Do not present mocked, sandbox or placeholder integrations as working production integrations. Clearly label them in demos and status reports.
- Never weaken authorisation, disable failing checks or bypass financial controls to make a demo pass.
- At each phase boundary report changes, commands actually run, results, remaining limitations and a short demonstration procedure. Never claim tests passed if they were not executed.
- Use synthetic demo identities, phone numbers and credentials. Do not send notifications or payments to real people during tests.

### B. Phase 0 deliverables and pilot scope

In addition to the original Phase 0 deliverables, produce:

1. [WORKFLOWS.md](./WORKFLOWS.md): state diagrams and transition tables for payroll, payment attempts, requisitions, invoices, variations and certificates. For each transition specify actor, scope, preconditions, side effects, retry behaviour and audit event.
2. [INVARIANTS.md](./INVARIANTS.md): business rules that must always hold, database constraints that enforce them, and tests that prove them.
3. [FINANCIAL_MODEL.md](./FINANCIAL_MODEL.md): postings, rounding, period closure, allocations, reversals and reconciliation.
4. [OFFLINE_SYNC.md](./OFFLINE_SYNC.md): event identity, versioning, conflict resolution, revoked-device behaviour, attachment upload and migration compatibility.
5. [OPERATIONS.md](./OPERATIONS.md): alert ownership, recovery procedures, backups, restore ordering, payment reconciliation and support access.
6. [RELEASE_PLAN.md](./RELEASE_PLAN.md): staging, migrations, feature flags, mobile/API compatibility and deployment rollback.
7. [COMPLIANCE_TODO.md](./COMPLIANCE_TODO.md): rule, jurisdiction, authoritative source, effective dates, verification date, reviewer, approval status and affected features. Unverified production rules must remain disabled.
8. [PILOT_PLAN.md](./PILOT_PLAN.md): propose one contractor, one site, manual/QR attendance, reviewed payroll, one payout method and reconciliation. Keep biometrics, USSD, additional payment rails and advanced analytics on the later roadmap unless explicitly prioritised.
9. [ACCEPTANCE_MATRIX.md](./ACCEPTANCE_MATRIX.md): requirement → acceptance scenario → test or manual evidence → phase → status.

Ask for approval of the proposed pilot and revised delivery order after producing these documents. Do not assume the pilot is approved. Hardware experiments belong in design validation; prototype code requires agreement if Phase 0 remains design-only.

### C. Workflow integrity and financial invariants

- Define explicit states, not independent status flags. Reject invalid transitions server-side.
- Payroll example: draft → submitted → reviewed → approved → disbursing → partially_settled/settled. Rejection, cancellation and adjustments need explicit paths. A payroll batch status must be derived consistently from its obligations and attempts.
- Approval binds to a versioned snapshot containing amounts, recipients, allocation, rates and rules. A material edit invalidates prior approvals. Enforce maker-checker separation by user identity, not merely role labels.
- Approved payroll and issued certificates are immutable. Correct them with linked amendments, adjustment runs, credit notes or reversals, with reasons and fresh approvals.
- Separate payable obligations, payment attempts, provider transactions, settlement allocations and journal postings. Support partial settlement without paying more than the authorised outstanding balance.
- Model a balanced, immutable financial journal with per-tenant accounts and project/cost-code dimensions. Ask an accounting reviewer to approve posting examples. Do not build a general-purpose accounting suite beyond needed scope.
- Distinguish committed cost, incurred/accrued cost and cash paid. An invoice and its settlement must not both increase the same cost measure.
- Specify partial payments, overpayments, advances, refunds, fees, retentions, credit notes, opening balances and closed-period corrections.
- Use decimal arithmetic and explicit precision for quantities/rates; KES settlement amounts use defined minor units. Specify rounding per line and document and reconcile rounding differences. Foreign-currency display must not change KES ledger amounts.
- Snapshot applied pay rates, statutory rules, BQ versions and conversions. Historical reports must not change when current configuration changes.
- Prevent double-counting attendance and piece-rate earnings; define which earning components can coexist.
- Enforce uniqueness, tenant-consistent foreign keys and transactional controls in the database. Test two simultaneous approvals, payouts and stock issues. Never rely on disabled buttons or a Redis lock alone for financial correctness.

### D. Payment correctness and external-provider uncertainty

- Distinguish `created`, `queued`, `submitting`, `pending`, `unknown`, `confirmed`, `failed` and reversal states at the attempt level. Document valid transitions and handling of late results.
- An HTTP timeout or worker crash may happen after the provider accepted a request. Mark the attempt unknown and reconcile before any new payout. Never automatically resubmit an uncertain payout simply because the queue retries.
- Internal idempotency prevents duplicate internal processing; it does not prove external exactly-once delivery. Verify provider-supported guarantees and document the residual failure window.
- Bind idempotency keys to tenant, operation and a request-body fingerprint. Reusing a key with a different payload must fail. Define retention for keys and provider receipt uniqueness.
- Persist callback intake durably before acknowledging it; use an inbox/deduplication record. Queue processing must be repeatable. Verify available callback authentication and status-query capabilities against current official provider documentation.
- Do not treat an unguessable URL or an IP allowlist alone as definitive proof of payment. Match identifiers, amounts, currency and expected transaction direction; quarantine mismatches and unknown requests.
- Use a transactional outbox for committed internal events. Document crash recovery before and after every provider call, and replay rules after restoration.
- A balance check is advisory and can race with other payouts. Reserve approved internal funding where appropriate and handle provider-side insufficient funds safely.
- Recipient name returned after disbursement is post-payment detection. Verify recipient details before approval using supported procedures. Changed payment details require independent verification and invalidate affected approvals.
- SMS text, receipt images, client responses and manually entered references cannot independently confirm provider settlement. Parsed messages create drafts only.
- Reconciliation must expose unmatched, duplicated, disputed and uncertain items with owner, age, evidence and resolution history. Provide a payout pause switch that does not erase queued obligations.
- Bound retries, use backoff and provider-specific limits; dead-letter failures for review. Notification failure must never retry the underlying payment.

### E. Offline data and evidence

- Give events stable client-generated IDs and versioned schemas. Sync must be at least once with server deduplication, per-item acknowledgement and safe incremental checkpoints.
- Attendance and inventory movements are append-only events; corrections reference original events. Do not use last-write-wins for financial, attendance or stock data.
- Use optimistic version checks for editable records. Present consequential draft conflicts for review; never silently overwrite unsynced work.
- Display pending, syncing, confirmed, conflicted and failed records with clear recovery actions. Retain local records until durable acknowledgement. Handle application termination and device storage exhaustion.
- Sync attachments separately using resumable/retryable uploads and checksums. Show when a business record exists but evidence upload is incomplete.
- Define treatment of offline attendance submitted after a payroll period closes: flag and route to a correction workflow; do not silently recalculate paid payroll.
- Server-side authorisation is evaluated at sync time. Revoked users/devices must not receive new sensitive data. Quarantine already-captured records for authorised review under a documented policy.
- Define a bounded offline access lease. Remote revocation cannot immediately erase data from a disconnected device; encrypt local storage and define re-authentication and eventual wipe behaviour.
- GPS, photos, signatures and device clocks are evidence with limitations. Server receipt time is distinct from claimed capture time. Store provenance and confidence; do not label an offline photo's location/time server-verified.
- Device signatures prove possession of a key, not physical presence or an honest clock. Treat fraud indicators as review signals, not automatic wage-denial decisions.

### F. Identity, privacy and tenant boundaries

- Implement invitation expiry, membership removal, session/device revocation, lost-device handling, MFA recovery and ownership transfer. Recovery must not bypass payment approval controls.
- Separate web-cookie authentication from native-app credential storage using platform secure storage and reviewed auth flows. Do not blindly apply browser-cookie assumptions to mobile.
- Explicitly scope background jobs, caches, file keys, exports, search, notifications and signed URLs by tenant and project. Resolve tenant context server-side rather than trusting submitted IDs.
- Test PostgreSQL RLS with the actual runtime database role and pooled connections; privileged or table-owner roles can defeat intended isolation. Clear/set tenant context safely per transaction.
- Platform support access must be explicit, least privilege, time limited and audited. Platform administrators do not automatically receive access to biometric/payroll records.
- Never include secrets, raw biometric data or sensitive field values in ordinary logs, traces, audit diffs or error reports. Use redacted summaries or protected references.
- Define retention by data class, legal holds and deletion propagation to devices, exports, objects and backups. Financial retention and personal-data deletion need a reviewed policy, not universal soft deletion.
- Minimise sensitive worker fields to what is necessary for the engagement and documented purpose. Require review of biometric lawful basis, notices, employee consent limitations, DPIA and registration obligations before rollout.
- Rate-limit USSD/PIN verification and recovery. Treat ID numbers as identifiers, not secrets. Prevent account enumeration and minimise wage details in SMS and shared-phone displays.
- Limit signed URL lifetime; do not expose sensitive files publicly. Protect exports against spreadsheet formula injection and uploads against malicious or oversized archives/files.

### G. Construction-specific correctness

- Define unit conversions, density assumptions and effective versions explicitly. A lorry trip is not a universal mass or volume.
- Preserve BQ import source, mapping, validation report and version. Preview changes before commit; reject or flag duplicate references, unsupported formulas, inconsistent totals and missing units. Large imports must be resumable or fail atomically.
- Separate physical progress, earned value, certified value, invoiced value and cash received. Define progress weightings and baseline changes before showing percentage complete or CPI/SPI. Undefined ratios should display as unavailable.
- Rate-build-up consumption alerts are estimates, not proof of theft. Account for returns, transfers, waste allowances and unrecorded/incomplete measurement.
- Specify invoice matching tolerances, partial deliveries/invoices, returns, credits and service/non-stock exceptions with controlled approvals.
- Prevent duplicate billing of materials on site when they are later incorporated into measured work. Define retention, advance recovery and certificate adjustment rules for review by a QS/accountant.
- Document authorised negative-stock policy and stock valuation method; serialise competing stock movements or enforce equivalent transactional protections.

### H. Delivery, observability and recovery

- Security, observability, backups and recovery tests start with the first relevant phase; they are not deferred entirely to Phase 9.
- Maintain isolated development, staging and production credentials/data. Use expand-contract migrations compatible with older mobile clients and rolling deployments.
- Version APIs and sync payloads. Define minimum supported app versions, local database migrations and handling of devices reconnecting after weeks offline.
- Test migrations against representative data volumes and failures. Distinguish application rollback from irreversible schema/data changes; document forward-fix procedures.
- Back up database, private objects, configuration and recoverable encryption-key access. Test a coherent restore, not only whether a backup job succeeded.
- After restore, pause external payments, reconcile provider outcomes since the restored point, rebuild internal state and only then resume workers. Never blindly replay a restored outbox.
- RPO applies to acknowledged server data; document exposure of records still only on offline devices. Set retention/versioning for attachments to match recovery needs.
- Track payment uncertainty age, reconciliation discrepancies, sync lag/conflicts, queue backlog, failed notifications, backup freshness and missing attachments. Avoid personal data in metric labels.
- Define alert thresholds, recipient/owner, escalation and actionable runbooks. Provide a restricted operations view with safe reprocessing and audited overrides.
- Estimate monthly database, storage, egress, SMS, monitoring and hardware costs at pilot and growth scale. Add tenant quotas and protection against abusive exports/uploads/notifications.
- Validate accessibility, Kiswahili wording, outdoor readability, shared-device privacy and low-end Android performance with users. Include loading, empty, error, offline and pending-payment states.

### I. Mandatory failure-mode acceptance scenarios

| Scenario | Expected outcome |
| --- | --- |
| Two requests approve/disburse the same obligation | One valid transition/attempt; no duplicate payable settlement |
| Worker dies after provider acceptance but before local response save | Unknown outcome retained; reconciliation precedes any resubmission |
| Duplicate or out-of-order callbacks | Idempotent processing; no duplicate journal entry or status regression |
| Callback arrives during queue outage | Durably accepted for later processing, or non-success returned if intake cannot persist |
| Recipient or amount changes after approval | Approval invalidated; disbursement blocked pending new approval |
| Payroll batch partly fails | Successful lines remain settled; only demonstrably unpaid obligations are eligible for new attempts |
| Tablet syncs repeatedly after several days offline | Each event accepted once; conflicts and missing attachments visible |
| Revoked device reconnects | No new sensitive access; submitted evidence handled by explicit quarantine policy |
| Attendance arrives after payroll closure | Reviewable correction; no mutation of settled payroll |
| Two storekeepers issue the same remaining stock | Enforced stock policy; no silent lost update |
| Tenant A guesses Tenant B's file/export/job IDs | Access denied across every delivery path |
| Database and objects restored to a prior point | Data consistency checked; payment workers paused until provider reconciliation |
| Old app reconnects after API/schema update | Compatible sync or explicit recoverable upgrade flow; no silent record loss |
| SMS sends unsuccessfully after confirmed payment | Notification retries only; payment remains confirmed |

Add calculation golden cases reviewed independently by the relevant domain reviewer. Test invariants and failure behaviour rather than mirroring implementation details. Run dependency/security checks and relevant integration tests in CI; document manual hardware and field evidence separately.

### J. Phase completion and release gate

A phase is complete only when its acceptance matrix is satisfied, migrations and failure recovery are documented, permissions are tested, and remaining limitations are explicit. A green CI result alone is insufficient for production payments or biometrics.

Before a live pilot, obtain verified provider onboarding/configuration, reviewed payroll rules, a restore rehearsal, a real-device offline test, identified operational owners and a small controlled reconciliation exercise. Present concrete evidence and outstanding decisions for owner review. Do not deploy, enable real payouts or collect biometric data merely because the feature code compiles.
