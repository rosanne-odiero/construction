# PM-Buddy: Compliance TODO

Every legal, tax or regulatory assumption in PM-Buddy lands here first (brief rule 4). Nothing in this list is hard-coded. Each item maps to one or more **configuration keys**, listed in [CONFIGURATION.md](./CONFIGURATION.md), with effective dates and a `compliance_status`.

Unverified rules are reference/demo material only and must be disabled for production calculations, not merely accompanied by a warning. In code, these points carry a `// COMPLIANCE-REVIEW:` comment. Approval requires the evidence fields below; expiry or a material legal change requires re-review.

## Required approval record

Every rule below requires a versioned review record. Existing "Where to check" entries identify research leads, not verified legal advice.

| Field | Requirement |
|---|---|
| Rule / affected features | Register ID, configuration keys, calculations, exports and workflows affected |
| Jurisdiction | Kenya plus relevant county/engagement context; review applicability explicitly |
| Authoritative source | Exact official publication/URL, section and published version; not an unsourced seed |
| Effective dates | `effective_from` and optional `effective_to`; do not assume the verification date is the effective date |
| Verification date | Date the reviewer checked the source and applicability |
| Reviewer | Named qualified reviewer and recorded approval evidence |
| Approval status | `open`, `in-review`, `confirmed` or `changed`; only confirmed records map to an approved production configuration |
| Impact and history | Superseded rule/version and affected feature/report migration; historical snapshots unchanged |

All existing entries remain unverified: source publication, effective dates, verification date and reviewer are not yet recorded. No production approval is implied by listing candidate sources or seed values.

> **Owner:** a qualified Kenyan adviser for each area (tax and payroll, employment law, data protection, construction regulation). **Status values:** `open` (not yet reviewed), `in-review`, `confirmed` (with a reference and date), `changed` (config updated).

| Area | Prefix | Needed before |
|---|---|---|
| Payroll, statutory deductions and employment | CR-PAY | D4.1 (engine), D4.3 (real payouts) |
| M-Pesa and payments | CR-PMT | D4.2 (sandbox), go-live per tenant |
| Tax, VAT and eTIMS | CR-TAX | D2.2 (VAT on BQ), D5.2 (eTIMS) |
| Construction regulation (NCA, county, NEMA) | CR-NCA | D2.1 / D8.4 |
| Occupational safety and work injury | CR-OSH | D8.2 |
| Data protection (DPA 2019, ODPC) | CR-DP | D1.3 (personal data), D3.4 (biometrics), go-live |

---

## Payroll, statutory deductions and employment

| ID | Item | Current design and seed | What to confirm | Where to check | Needed by | Status |
|---|---|---|---|---|---|---|
| CR-PAY-01 | PAYE bands and personal relief | Monthly bands from the brief: 10% to 24,000; 25% on the next 8,333; 30% on the next 467,667; 32.5% on the next 300,000; 35% above 800,000. Relief KES 2,400/month. Weekly and daily pay converted with `payroll.paye.proration_method`. | Current bands and relief with effective dates. **The correct method for casual workers paid daily or weekly** (cumulative vs period-equivalent). | Income Tax Act, Finance Acts, KRA PAYE guidance | D4.1 | open |
| CR-PAY-02 | NSSF contributions | 6% employee + 6% employer on pensionable pay up to the upper earnings limit. Seed UEL KES 108,000 from 01/02/2026 (brief). **The lower earnings limit (Tier I/II split) is not in the brief.** | LEL and UEL schedule by date. Tier I/II treatment. Whether casual and daily-paid workers are covered. | NSSF Act 2013 and schedules, NSSF guidance | D4.1 | open |
| CR-PAY-03 | SHIF | 2.75% of gross with a minimum of KES 300 (brief) | How the monthly minimum applies to weekly or daily pay. Applicability to casual workers. Remittance due date. | Social Health Insurance Act and regulations, SHA guidance | D4.1 | open |
| CR-PAY-04 | Affordable Housing Levy | 1.5% employee + 1.5% employer on gross (brief) | Base pay definition, casual applicability, remittance channel and due date | Affordable Housing Act, KRA guidance | D4.1 | open |
| CR-PAY-05 | NITA levy | Employer amount per employee. **No seed.** | Amount, which employees count, frequency | Industrial Training Act and Training Levy Order | D4.1 | open |
| CR-PAY-06 | Deductions before PAYE | Brief: "deductions are applied before PAYE where the law allows". Configurable flag per deduction. | Which of NSSF, SHIF and Housing Levy are allowable deductions (or reliefs), and from which date | Tax Laws (Amendment) Acts, KRA guidance | D4.1 | open |
| CR-PAY-07 | Engagement-type mapping | `EngagementDeductionRule` decides which deductions apply to casual, term, piece-rate and subcontractor staff | The correct mapping for each engagement type | Advisers: tax, employment | D4.1 | open |
| CR-PAY-08 | Normal hours and overtime | Normal hours, breaks, lateness grace, half-day threshold, and OT multipliers for weekdays, rest days and public holidays. **Demo values only.** | Statutory minimums, including any building and construction wages order; tenant policy above the minimum | Employment Act, Labour Institutions Act, wages orders | D3.3 | open |
| CR-PAY-09 | Minimum wage checks | A rate below the configured minimum for the area and occupation raises an alert | Current minimum wage tables (usually revised around Labour Day) and how areas map to them | Regulation of Wages orders (Kenya Gazette) | D3.1 | open |
| CR-PAY-10 | Casual-to-term conversion warning | Warn once continuous engagement passes `attendance.casual_conversion_warning_days`. The prototype uses 25 days (demo only). | The legal test for conversion: period, aggregation rules, consequences | Employment Act (casual employment provisions) | D3.1 | open |
| CR-PAY-11 | Statutory remittance files | CSV templates that you map to the official upload formats (brief §5.6) | Current PAYE (iTax), NSSF, SHA and Housing Levy upload formats and due dates | KRA iTax, NSSF, SHA portals | D4.1 | open |
| CR-PAY-12 | Payslip content | SMS payslip in EN/SW: days, rate, gross, deductions, net, M-Pesa reference | Whether an SMS payslip meets the itemised pay statement requirement, and what else must be kept or available | Employment Act (pay statements) | D4.3 | open |
| CR-PAY-13 | Payroll and attendance record retention | `attendance.records_retention_years`, `payroll.records_retention_years` | Minimum retention periods (employment and tax law) weighed against data minimisation (CR-DP-06) | Employment Act, Tax Procedures Act | D4.1 | open |
| CR-PAY-14 | Public holidays | `PublicHoliday` table seeded per year. Ad-hoc holidays added by an admin. | 2026–2027 holiday list, including variable-date holidays and gazetted ad-hoc days | Public Holidays Act, Kenya Gazette notices | D3.3 | open |
| CR-PAY-15 | Cap on total deductions from wages | `payroll.deductions.max_total_pct` blocks or flags payroll lines whose deductions (advances included) exceed the cap | Whether a statutory cap on deductions applies, and its value | Employment Act (deductions from wages) | D4.1 | open |
| CR-PAY-16 | Advances and piece-rate pay | Advance recovery plans; piece-rate pay from measured quantity × agreed rate | Treatment of advances (loans vs wages) and piece-rate for statutory deductions | Advisers: tax, employment | D4.1 | open |

## M-Pesa and payments

| ID | Item | Current design and seed | What to confirm | Where to check | Needed by | Status |
|---|---|---|---|---|---|---|
| CR-PMT-01 | Daraja API versions and fields | `DarajaProvider` with a mock server that mirrors the expected payloads | Current endpoint versions (for example B2C v1 vs v3), field names, result codes, sandbox behaviour | Safaricom Daraja documentation and sandbox | D4.2 | open |
| CR-PMT-02 | Transaction limits and tariffs | `mpesa.*.max_per_transaction`, `mpesa.*.daily_limit`, `MpesaTariff`. The prototype shows **KES 250,000 per STK transaction as a placeholder.** | Current limits per product (STK, C2B, B2C, B2B) and per customer; the tariff schedule for each tenant's account type | Safaricom tariffs, tenant agreements | D4.2 | open |
| CR-PMT-03 | Callback source IP allowlist | `mpesa.callback.ip_allowlist` (config, not code) | Safaricom's current published callback IP ranges | Safaricom developer support | D4.2 | open |
| CR-PMT-04 | Production go-live per tenant | Each tenant uses its own shortcodes and credentials (brief §5.7) | Go-live requirements, KYC, B2C bulk disbursement account. **Whether PM-Buddy acting for tenants needs any licence or registration** (see Q-M1). | Safaricom, Central Bank of Kenya (National Payment System) | Before the first production payout | open |
| CR-PMT-05 | Paying wages by M-Pesa or cash | Workers' M-Pesa numbers are registered. Cash needs evidence, a reason and approval, with a configurable cap. | Rules for paying wages by mobile money or cash (worker consent, records) and any cash limits | Employment Act (payment of wages) | D4.3 | open |
| CR-PMT-06 | Recipient-name data | The B2C result's receiver name is compared with the registered name and the result is kept for review | Keeping returned names is proportionate; retention period | DPA 2019 (data minimisation) | D4.3 | open |

## Tax, VAT and eTIMS

| ID | Item | Current design and seed | What to confirm | Where to check | Needed by | Status |
|---|---|---|---|---|---|---|
| CR-TAX-01 | VAT on contracts, certificates and variations | `bq.vat.rate` seed 16% (brief), with per-project override | VAT treatment of provisional and PC sums, variations and certificates; zero-rated or exempt projects (for example, special housing incentives) | VAT Act, KRA guidance | D2.2 | open |
| CR-TAX-02 | eTIMS invoices | eTIMS number captured on supplier invoices; missing numbers are flagged and block payment approval (configurable) | Current deductibility rules for expenses without eTIMS invoices, and exemptions | Tax Procedures Act, Finance Acts, KRA eTIMS guidance | D5.2 | open |
| CR-TAX-03 | Withholding tax and withholding VAT | **Not in the brief.** No withholding is applied by default. | Whether withholding tax or withholding VAT applies to payments to subcontractors, consultants or suppliers, and the rates | Income Tax Act, VAT Act, KRA | D5.2 | open |
| CR-TAX-04 | Retention and certificates | Retention % and optional cap are **contract terms** (per project), not law | Standard contract forms used (for example JBC/PPRA) and their defaults | Contract documents | D6.3 | open |

## Construction regulation

| ID | Item | Current design and seed | What to confirm | Where to check | Needed by | Status |
|---|---|---|---|---|---|---|
| CR-NCA-01 | NCA project registration and levy | Compliance register item; `nca.levy_rate` seed 0 (brief: "may be zero") | Registration thresholds and current levy status | NCA Act and regulations, NCA guidance | D2.1 / D8.4 | open |
| CR-NCA-02 | Contractor registration and category | Tenant profile and compliance register | Category rules for contract values and works types | NCA | D8.4 | open |
| CR-NCA-03 | Skilled worker and supervisor accreditation | Accreditation card number and expiry, with alerts (`labour.accreditation_alert_days`) | Which trades and roles need accreditation, and validity periods | NCA | D3.1 | open |
| CR-NCA-04 | County approvals, NEMA licences, signboard | Compliance register items with expiry reminders | When a NEMA licence or EIA is required; county approval and signboard requirements | County governments, NEMA, Physical and Land Use Planning Act | D8.4 | open |

## Occupational safety and work injury

| ID | Item | Current design and seed | What to confirm | Where to check | Needed by | Status |
|---|---|---|---|---|---|---|
| CR-OSH-01 | Workplace registration and incident reporting | Incident register with reporting deadlines (`osh.incident_report_days`) | Registration requirements; which incidents are reportable and their deadlines | OSHA 2007, DOSHS | D8.2 | open |
| CR-OSH-02 | WIBA | WIBA insurance in the compliance register; `wiba_reportable` flag on incidents | Accident reporting deadlines and insurance obligations for casual workers | WIBA 2007 | D8.2 | open |
| CR-OSH-03 | PPE, induction, first aid | PPE register, inductions, first-aid log | Minimum PPE and first-aid provisions for construction sites | OSHA 2007 and its rules | D8.2 | open |

## Data protection

These are summarised here. The detail is in [DPIA_TEMPLATE.md](./DPIA_TEMPLATE.md) and [THREAT_MODEL.md](./THREAT_MODEL.md).

| ID | Item | Current design and seed | What to confirm | Where to check | Needed by | Status |
|---|---|---|---|---|---|---|
| CR-DP-01 | ODPC registration | Go-live gate (ROADMAP §4) | Registration of the PM-Buddy operator (processor and/or controller) and of each tenant (controller); categories and fees | DPA 2019; Data Protection (Registration of Data Controllers and Data Processors) Regulations | D1.4 (first real personal data) | open |
| CR-DP-02 | DPIA before biometrics | DPIA template; in-app `DpiaRecord` gate (D3.4) | Process and content, and whether ODPC prior consultation is needed | DPA 2019 s.31; ODPC DPIA guidance | D3.4 | open |
| CR-DP-03 | Lawful basis and consent | Explicit consent for biometrics, with a mandatory non-biometric alternative and no penalty | Lawful basis per purpose. Whether workers' consent can be "freely given" and what extra safeguards are needed. | DPA 2019, ODPC guidance on biometrics and consent | D3.1 | open |
| CR-DP-04 | Breach notification | `dp.breach_notification_hours` seed 72 (s.43); `dp.processor_breach_notification_hours` | Timelines, content and data-subject notification threshold | DPA 2019 s.43, General Regulations 2021 | D9.3 | open |
| CR-DP-05 | Cross-border transfer and hosting | Cloud-agnostic until the Phase 9 hosting decision (D-18) | Whether offshore hosting is allowed for this data, safeguards and documentation, and any in-country processing requirement | DPA 2019 Part VI (s.48–50), General Regulations 2021 | Before production data | open |
| CR-DP-06 | Retention periods | `biometrics.retention_days_after_engagement`, `biometrics.withdrawal_deletion_hours`, `attendance.gps_retention_days`, `attendance.evidence_photo_retention_days`, `dp.consent_record_retention_years` and others | Proportionate periods, balanced against CR-PAY-13 | DPA 2019, adviser | D3.1 / D3.4 | open |
| CR-DP-07 | Data subject requests | `dp.dsr_response_days.*` | Response times, verification and whether a fee can be charged | DPA 2019, General Regulations 2021 | D3.1 | open |
| CR-DP-08 | Evidence photos as biometric data | Live photo kept as fallback evidence (`attendance.store_evidence_photo_on_biometric_match` is configurable) | Whether face photos used for verification count as biometric data | ODPC guidance | D3.3 | open |
| CR-DP-09 | Automated decisions | Anomaly flags never change pay automatically; a person reviews and decides | Rules on automated decision-making and the right to human review | DPA 2019 (automated decisions) | D3.3 | open |
| CR-DP-10 | Children | Registration blocked under 18 (brief); age taken from DOB and checked against ID where possible | That DOB checks are adequate; handling of under-18s who appear on site | Children Act, Employment Act | D3.1 | open |
| CR-DP-11 | Kiswahili consent text | Draft notices in DPIA §7 | Legal review and professional Kiswahili review, including read-aloud suitability | Adviser plus translator | D3.1 | open |
| CR-DP-12 | ODPC biometric guidance | Design follows brief §6 | Obtain the current ODPC guidance note on biometric data and map every requirement to a control | ODPC | D3.4 | open |

## D3.1 implementation notes (labour registry)

How the D3.1 build handles the items above. Every status stays `open`: nothing here is a legal confirmation, and the code carries `COMPLIANCE-REVIEW` comments at each point.

| Item | What D3.1 does | Still needed |
|---|---|---|
| CR-DP-10 (children) | Registration, engagement and date-of-birth corrections are refused for anyone under 18 on the registration or start date in Africa/Nairobi (18th birthday today is allowed; a 29 February birthday turns 18 on 1 March in non-leap years). Enforced in the API (`isOldEnoughToRegister`) and by the database (`labourers_minimum_age_check` plus the engagement trigger), so no path can store an under-18 labourer. The date of birth is taken as entered; it is not yet checked against the ID document | Confirm DOB-only checks are adequate; procedure for under-18s found on site |
| CR-DP-03 (lawful basis and consent) | Registration requires recorded consent to the current notice (purposes: identity and age, preventing payment fraud, pay, statutory duties, NCA checks); the database refuses a labourer without a consent row. Withdrawal is recorded (records kept) and blocks new engagements and reactivation. Biometric consent is **not** captured: it needs its own notice and the D3.4 DPIA gate (`CONSENT_KINDS` is the extension point) | Lawful basis per purpose (some purposes may rest on legal obligation or contract rather than consent, which would change the "consent required" rule); whether worker consent can be freely given |
| CR-DP-11 (Kiswahili consent text) | Draft EN/SW notice `registration-2026-11-v1` (DPIA §7 basis) shown in the language the worker chooses, signed or read aloud with a named witness. The text is pinned by SHA-256 in `packages/types`; the digest, version, language, method and witness are stored with each record | Legal review and professional Kiswahili review, including read-aloud suitability |
| CR-DP-06 / CR-DP-07 (retention, data subject requests) | Consent and do-not-rehire history are append-only; labourers are never deleted (status `left`). Revealing a full identifier records the purpose (`data_subject_request` is one) in the audit log | Retention periods (`labour.inactive_worker_retention_days`, `dp.consent_record_retention_years`) and a DSR workflow |
| CR-NCA-03 (accreditation) | NCA skilled-worker and site-supervisor cards (number, issue and expiry dates); skill levels mark whether a card is expected; expiring (default 30 days, `labour.accreditation_alert_days`) and expired cards are flagged in the registry and on the alerts page | Which trades and roles need accreditation; validity periods; whether to block engagement without a valid card (D3.1 only warns) |
| CR-PAY-09 (minimum wage) | Rates are effective-dated KES amounts per company, project, trade, skill level or labourer. No minimum-wage table exists, so every rate response says `minimumWage: { status: "not_configured", reference: "CR-PAY-09" }` and the setup screen shows a COMPLIANCE-REVIEW warning; nothing is invented | The current wages orders by area and occupation, then `payroll.minimum_wage_table` and an alert below it |
| CR-PAY-10 (casual-to-term conversion) | Engagements record start and end dates per project, which the warning will count; no warning yet | Needs attendance (D3.2–D3.3) and the legal test |
