# PM-Buddy: Configuration Register

Every rule the brief says must not be hard-coded is a **configuration key** (ARCHITECTURE §11). This register lists each key with its seed value, where the value comes from and its review status. Update it whenever a deliverable adds or changes a key (Definition of Done).

**How keys work**

- **Scope** (`platform` → `tenant` → `project`): the most specific active version wins. Every key is **effective-dated** (`effective_from`, `effective_to`) and **versioned**.
- **Typed values.** Each key has a Zod schema in `packages/validation/config` (from D1.1). Statutory rules use `StatutoryRule` and `StatutoryRuleBand`. Overtime and holidays have their own tables (see the [ERD](./ERD.md) §2).
- **Reproducible.** Payroll lines, valuations and certificates store the rule versions they used. Changing a rule never changes an approved record.
- **Governed.** Changes need `config.manage` (or `config.manage_statutory`, with maker-checker and step-up MFA) and are audited.

**Status legend**

| Status | Meaning |
|---|---|
| `COMPLIANCE-REVIEW` | Legal or tax value; must be confirmed (see [COMPLIANCE_TODO](./COMPLIANCE_TODO.md)) |
| `PRODUCT` | Business choice; you decide |
| `SECURITY` | Security control; the default is a recommendation |
| `OPS` | Operational value from a provider or our infrastructure |
| `DEMO` | Value used only by the D0 prototype; not a recommendation |
| `TBD` | No seed yet; must be set before the feature goes live |

---

## 1. Payroll and statutory

| Key | Scope | Seed / default | Source | Status | Used from |
|---|---|---|---|---|---|
| `payroll.paye.bands` | platform | Monthly: 10% to 24,000 · 25% next 8,333 · 30% next 467,667 · 32.5% next 300,000 · 35% above 800,000 | Brief §6 | COMPLIANCE-REVIEW (CR-PAY-01) | D4.1 |
| `payroll.paye.personal_relief_monthly` | platform | KES 2,400 | Brief §6 | COMPLIANCE-REVIEW (CR-PAY-01) | D4.1 |
| `payroll.paye.proration_method` | platform | `period_equivalent` (weekly × 52/12) | Design proposal | COMPLIANCE-REVIEW (CR-PAY-01) | D4.1 |
| `payroll.nssf.employee_rate` / `employer_rate` | platform | 6% / 6% | Brief §6 | COMPLIANCE-REVIEW (CR-PAY-02) | D4.1 |
| `payroll.nssf.upper_earnings_limit` | platform | KES 108,000 from 01/02/2026 | Brief §6 | COMPLIANCE-REVIEW (CR-PAY-02) | D4.1 |
| `payroll.nssf.lower_earnings_limit` | platform | TBD | Not in brief | TBD, COMPLIANCE-REVIEW (CR-PAY-02) | D4.1 |
| `payroll.shif.rate` / `minimum` | platform | 2.75% / KES 300 | Brief §6 | COMPLIANCE-REVIEW (CR-PAY-03) | D4.1 |
| `payroll.ahl.employee_rate` / `employer_rate` | platform | 1.5% / 1.5% | Brief §6 | COMPLIANCE-REVIEW (CR-PAY-04) | D4.1 |
| `payroll.nita.employer_amount_per_employee` | platform | TBD | Brief: "configurable" | TBD, COMPLIANCE-REVIEW (CR-PAY-05) | D4.1 |
| `payroll.deductible_before_paye` | platform | TBD per deduction (NSSF, SHIF, AHL) | Brief: "where the law allows" | COMPLIANCE-REVIEW (CR-PAY-06) | D4.1 |
| `payroll.engagement_deductions` | platform/tenant | TBD mapping (casual, term, piece-rate) | Brief §5.6 | COMPLIANCE-REVIEW (CR-PAY-07) | D4.1 |
| `payroll.deductions.max_total_pct` | platform | TBD | Employment law check | COMPLIANCE-REVIEW (CR-PAY-15) | D4.1 |
| `payroll.minimum_wage_table` | platform | TBD (area × occupation) | Wages orders | COMPLIANCE-REVIEW (CR-PAY-09) | D3.1 |
| `labour_rates` (data, not a key) | tenant/project/labourer | None: each company sets its own; the development seed adds synthetic rates | Brief §5.4 | PRODUCT; COMPLIANCE-REVIEW (CR-PAY-09) where a rate meets the minimum wage | D3.1 |
| `payroll.advances.max_recovery_pct_per_period` | tenant | 50% of net | Proposal | PRODUCT | D4.1 |
| `payroll.pay_periods.allowed` | tenant/project | daily, weekly, fortnightly, monthly | Brief §5.6 | PRODUCT | D4.1 |
| `payroll.records_retention_years` | platform | TBD | Employment and tax law | COMPLIANCE-REVIEW (CR-PAY-13) | D4.1 |
| `nca.levy_rate` | platform/project | 0% | Brief §6 ("may be zero") | COMPLIANCE-REVIEW (CR-NCA-01) | D2.1 |

## 2. Time and attendance

| Key | Scope | Seed / default | Source | Status | Used from |
|---|---|---|---|---|---|
| `attendance.normal_hours_per_day` → `timesheet_rule_versions.normal_minutes` | tenant/project (effective-dated) | 480 (8 h) | Prototype, QUESTIONS Q-C3 | DEMO, COMPLIANCE-REVIEW (CR-PAY-08); seeded `unverified` | D3.3 (built) |
| `attendance.late_after` → `day_start_minutes` + `late_grace_minutes` | tenant/project (effective-dated) | 07:00 + 15 min (late after 07:15) | Prototype | DEMO, PRODUCT | D3.3 (built) |
| `attendance.break` → `default_break_minutes` after `break_after_minutes` | tenant/project (effective-dated) | 60 min when the shift is longer than 5 h; a break entered on the muster roll wins | Proposal | DEMO, COMPLIANCE-REVIEW (CR-PAY-08) | D3.3 (built) |
| `attendance.half_day_hours` → `half_day_threshold_minutes` | tenant/project (effective-dated) | 240 (a day of 4 h or more is a full day; shorter, or all records `half_day`, is a half) | Proposal | PRODUCT, COMPLIANCE-REVIEW (CR-PAY-08) | D3.3 (built) |
| `attendance.max_plausible_minutes` | tenant/project (effective-dated) | 720 (12 h worked); above it the day is flagged `excess_hours` (still counted, never capped silently) | Proposal | PRODUCT, SECURITY | D3.3 (built) |
| `attendance.rest_days` → `rest_days` (ISO weekdays) | tenant/project (effective-dated) | Sunday | Prototype, Q-C3 | DEMO, COMPLIANCE-REVIEW (CR-PAY-08) | D3.3 (built) |
| `attendance.overtime.multipliers` → `ot_weekday_multiplier`, `ot_rest_day_multiplier`, `ot_holiday_multiplier` | tenant/project (effective-dated) | Weekday 1.50 · rest day 2.00 · public holiday 2.00 (exact decimal strings; payroll applies them) | Prototype, Q-C3 | DEMO, COMPLIANCE-REVIEW (CR-PAY-08) | D3.3 (built) |
| `attendance.period.week_ends_on` / `.cutoff_time` / `.payday` → `attendance_settings` | tenant | Thursday · 18:00 Africa/Nairobi · Friday (weekly periods Friday–Thursday) | QUESTIONS Q-C4 | DEMO, PRODUCT | D3.3 (built) |
| `attendance.face_match_threshold` | tenant/site | 0.80 | Prototype; vendor-tuned in D3.4 | DEMO, SECURITY | D3.4 |
| `attendance.liveness_threshold` | tenant | Vendor-specific | D3.4 vendor choice | SECURITY | D3.4 |
| `attendance.duplicate_window_minutes` | tenant | 10 | Proposal | PRODUCT | D3.3 |
| `attendance.clock_drift_minutes` | platform | 5 | Proposal | SECURITY | D3.3 |
| `attendance.impossible_travel_kmh` | platform | 60 (straight-line) | Proposal | SECURITY | D3.3 |
| `attendance.geofence_tolerance_m` | site | 30 (plus reported GPS accuracy) | Proposal | PRODUCT | D3.3 |
| `attendance.override.step_up` | tenant | true (corrections and adjustments need MFA verified within 5 minutes; `ATTENDANCE_OVERRIDE_STEP_UP`) | Threat model | SECURITY | D3.3 (built, constant for now) |
| `attendance.casual_conversion_warning_days` | tenant | 25 | Prototype | DEMO, COMPLIANCE-REVIEW (CR-PAY-10) | D3.1 |
| `attendance.dispute_response_days` | tenant | TBD | DPIA | PRODUCT | D3.3 |
| `attendance.records_retention_years` | platform | TBD | DPIA | COMPLIANCE-REVIEW (CR-PAY-13, CR-DP-06) | D3.3 |
| `attendance.gps_retention_days` | platform | TBD | DPIA | COMPLIANCE-REVIEW (CR-DP-06) | D3.3 |
| `attendance.evidence_photo_retention_days` | platform | TBD | DPIA | COMPLIANCE-REVIEW (CR-DP-06) | D3.3 |
| `attendance.store_evidence_photo_on_biometric_match` | tenant | false | DPIA (minimisation) | COMPLIANCE-REVIEW (CR-DP-08) | D3.4 |
| Public holidays (`public_holidays` table) | tenant | 2026: 12 days (including the gazetted Idd-ul-Fitr 20/03 and Idd-ul-Adha 27/05); 2027: 11 days (no Idd yet; Sunday holidays observed on Monday) — `KENYA_PUBLIC_HOLIDAYS` with a source per row | Public Holidays Act Cap. 110 and Kenya Gazette notices (sources in [COMPLIANCE_TODO](./COMPLIANCE_TODO.md#d33-implementation-notes-attendance-and-timesheets-web-slice)) | COMPLIANCE-REVIEW (CR-PAY-14); rows `unverified` | D3.3 (built) |

**How the D3.3 web slice stores these values.** Timesheet rules are rows of `timesheet_rule_versions`: a company default (`project_id` null) and optional project overrides, each effective from a date; the rule for a project on a date is the latest version of that project, else the latest company version (`resolveTimesheetRule`). A version cannot start inside a submitted or approved period, and only versions that have not started can be cancelled, so a rule change never alters an approved timesheet; approved lines also keep the rule version id they used. New rule versions start `unverified`; in production (`NODE_ENV=production`) a period whose lines use an unverified rule cannot be approved (COMPLIANCE-REVIEW). The rule values are validated by `ruleIssues` (shared Zod schema) and by database CHECK constraints (`TIMESHEET_RULE_LIMITS`).

## 3. Biometrics and data protection

| Key | Scope | Seed / default | Source | Status | Used from |
|---|---|---|---|---|---|
| `biometrics.retention_days_after_engagement` | platform/tenant | TBD | Brief §6, DPIA §8 | COMPLIANCE-REVIEW (CR-DP-06) | D3.4 |
| `biometrics.withdrawal_deletion_hours` | platform | TBD | DPIA §8 | COMPLIANCE-REVIEW (CR-DP-06) | D3.4 |
| `biometrics.device_purge_max_hours` | platform | TBD | DPIA §8 | SECURITY | D3.4 |
| `dp.breach_notification_hours` | platform | 72 | DPA 2019 s.43 | COMPLIANCE-REVIEW (CR-DP-04) | D9.3 |
| `dp.processor_breach_notification_hours` | platform | TBD | DPIA §10 | COMPLIANCE-REVIEW (CR-DP-04) | D9.3 |
| `dp.dsr_response_days.access` / `.correction` / `.deletion` / `.objection` | platform | TBD | DPIA §9 | COMPLIANCE-REVIEW (CR-DP-07) | D3.1 |
| `dp.dsr_record_retention_years` | platform | TBD | DPIA §9 | COMPLIANCE-REVIEW (CR-DP-06) | D3.1 |
| `dp.consent_record_retention_years` | platform | TBD | DPIA §8 | COMPLIANCE-REVIEW (CR-DP-06) | D3.1 |
| `dp.dpia_review_interval_months` | tenant | 12 | DPIA §13 | PRODUCT | D3.4 |
| `labour.inactive_worker_retention_days` | platform | TBD | DPIA §8 | COMPLIANCE-REVIEW (CR-DP-06) | D3.1 |
| `labour.accreditation_alert_days` | tenant | 30 (allowed 1–365) | Brief §5.4 ("alert before expiry") | PRODUCT | D3.1 (implemented: `labour_settings.accreditation_alert_days`; 30 until a company saves its own) |
| `labour.minimum_age_years` | platform | 18 | Brief §6 | COMPLIANCE-REVIEW (CR-DP-10) | D3.1 (implemented as the code constant `MINIMUM_LABOURER_AGE_YEARS` and repeated in the database CHECK and triggers; deliberately not editable at runtime, so changing it needs a migration) |
| `labour.consent_notice_version` | platform | `registration-2026-11-v1` (EN/SW text pinned by SHA-256) | Brief §6, DPIA §7 | COMPLIANCE-REVIEW (CR-DP-03, CR-DP-11) | D3.1 (`CURRENT_CONSENT_NOTICE` in `packages/types`; a new wording is a new version) |
| `labour.trades` / `labour.skill_levels` | tenant | 15 trades from brief §5.4 (EN/SW); skilled, semi-skilled, unskilled and site supervisor (NCA categories) | Brief §5.4 | PRODUCT; COMPLIANCE-REVIEW (CR-NCA-03) for which levels expect an NCA card | D3.1 (`trades`, `skill_levels`; "Add the standard list" installs them) |

## 4. Payments and M-Pesa

| Key | Scope | Seed / default | Source | Status | Used from |
|---|---|---|---|---|---|
| `mpesa.stk.max_per_transaction` | platform/tenant | KES 250,000 (prototype display only) | Placeholder | DEMO, COMPLIANCE-REVIEW (CR-PMT-02) | D4.2 |
| `mpesa.b2c.max_per_transaction` / `mpesa.b2c.daily_limit` | platform/tenant | TBD | Safaricom | TBD, COMPLIANCE-REVIEW (CR-PMT-02) | D4.2 |
| `mpesa.b2b.max_per_transaction` | platform/tenant | TBD | Safaricom | TBD (CR-PMT-02) | D5.2 |
| M-Pesa tariffs (`MpesaTariff` table) | platform/tenant | TBD; the prototype estimates KES 15 per payout | Safaricom tariff | DEMO, COMPLIANCE-REVIEW (CR-PMT-02) | D4.2 |
| `mpesa.callback.ip_allowlist` | platform | Safaricom's published ranges | Safaricom | OPS (CR-PMT-03) | D4.2 |
| `mpesa.result_timeout_minutes` | platform | 10, then a transaction status query | Proposal | OPS | D4.2 |
| `mpesa.tps_limit` | channel | Per Safaricom agreement | Safaricom | OPS | D4.2 |
| `payments.name_match.threshold` | tenant | 0.80 similarity | Proposal | PRODUCT, SECURITY | D4.3 |
| `payments.name_mismatch.hold_future_payouts` | tenant | true | Proposal | SECURITY | D4.3 |
| `payments.payee_change_hold_hours` | tenant | 24 | Threat model | SECURITY | D4.3 |
| `payments.cash.max_per_worker_period` | tenant | TBD | Threat model | PRODUCT (CR-PMT-05) | D4.3 |
| `payments.unusual.new_recipient_amount` | tenant | KES 50,000 | Proposal | SECURITY | D4.3 |
| `payments.unusual.business_hours` | tenant | 06:00–20:00 EAT | Proposal | SECURITY | D4.3 |
| Approval limits | role assignment | e.g. Director KES 2,000,000 (prototype) | Data, not config (ARCHITECTURE §8) | PRODUCT | D1.4 |

## 5. Commercial, procurement and stores

| Key | Scope | Seed / default | Source | Status | Used from |
|---|---|---|---|---|---|
| `bq.vat.rate` | platform/project | 16% (`BQ_VAT_RATE_PERCENT`, §8, until the effective-dated rules engine holds it) | Brief §5.2 | COMPLIANCE-REVIEW (CR-TAX-01) | D2.2 (snapshot onto each BQ version with this key and status) |
| `bq.rounding` | tenant | Half-up to the cent per line (`half_up_line`): each item's quantity × rate is rounded once; VAT once on the subtotal. Fixed in code for D2.2 and snapshot onto each version | FINANCIAL_MODEL; ARCHITECTURE §4.2 | PRODUCT | D2.2 |
| `bq.import.amount_tolerance_minor` | platform | 100 (KES 1.00): a sheet amount further than this from quantity × rate is an `amount-mismatch` error; totals use the same tolerance | Proposal | PRODUCT | D2.2 (constant `BQ_AMOUNT_TOLERANCE_MINOR`) |
| `bq.import.max_file_mb` | platform | 10 (was 20 in the design) | Brief §15 F; D2.2 | SECURITY | D2.2 (constant `BQ_IMPORT_LIMITS`) |
| `bq.import.limits` | platform | 100 MB uncompressed, 100:1 ratio, 10,000 ZIP entries; 50 sheets, 20,000 rows and 100 columns per sheet, 200,000 cells, 4,000 characters per cell; 30 s and 384 MB heap per parse; 2 parses at a time (8 waiting) | ARCHITECTURE §4.2 | SECURITY | D2.2 (constant `BQ_IMPORT_LIMITS`) |
| `valuations.retention.rate` / `.cap_pct` | project | From the contract (for example 10% / 5%) | Contract terms | PRODUCT (CR-TAX-04) | D6.3 |
| `procurement.min_quotes` | tenant | 3 | Brief §5.3 ("configurable") | PRODUCT | D5.2 |
| `procurement.three_way_match.qty_tolerance_pct` / `.price_tolerance_pct` | tenant | 0% / 0% | Proposal | PRODUCT | D5.2 |
| `procurement.block_payment_without_etims` | tenant | true | Brief §5.3 | COMPLIANCE-REVIEW (CR-TAX-02) | D5.2 |
| `stores.variance_alert_threshold_pct` | tenant/material | 10% | Brief §5.3 (example) | PRODUCT | D5.3 |
| `stores.low_stock_days_cover` | site | 7 | Proposal | PRODUCT | D5.3 |
| `materials.price_change_alert_pct` | tenant | 10% | Proposal | PRODUCT | D5.1 |
| Unit conversions (`UnitConversion` table, for example sand per lorry trip) | tenant/supplier | TBD per supplier | Brief §5.3 ("configurable") | PRODUCT | D5.1 |
| `finance.budget_alert_thresholds` | project | 75%, 90%, 100% | Proposal | PRODUCT | D5.4 |

## 6. Security, auth and operations

| Key | Scope | Seed / default | Source | Status | Used from |
|---|---|---|---|---|---|
| `auth.password.min_length` | platform | 12 | OWASP ASVS | SECURITY | D1.3 |
| `auth.password.min_strength` | platform | zxcvbn-ts score 3 (of 4), with the identifier, display name and "pm-buddy" as context; first 64 characters scored. A code constant (`MINIMUM_PASSWORD_SCORE`), applied on registration and reset | OWASP ASVS 2.1.7; ARCHITECTURE §7 | SECURITY | D1.3 |
| `auth.passkeys.max_per_user` | platform | 10 (named, names unique per account). A code and schema constant (`MAX_PASSKEYS`) | Proposal | SECURITY | D1.3 |
| `auth.passkeys.challenge_ttl` | platform | 300 seconds, single-use, bound to user and session. Same five-minute window as `auth.step_up.max_age` | ARCHITECTURE §7 | SECURITY | D1.3 |
| `auth.mfa.lockout` | platform | 5 consecutive wrong TOTP codes, recovery codes or failed passkey assertions lock MFA for 15 minutes, revoke the session and notify the user; 30 MFA attempts per user per day | Brief §7; implementation | SECURITY | D1.3 |
| `auth.otp.ttl_seconds` / `auth.otp.max_attempts` | platform | 300 / 5 | Proposal | SECURITY | D1.3 |
| `auth.lockout.threshold` / `.window_minutes` | platform | 10 / 15 | Proposal | SECURITY | D1.3 |
| `auth.access_token_ttl_seconds` | platform | 600 | ARCHITECTURE §7 | SECURITY | D1.3 |
| `auth.refresh.idle_days` / `.absolute_days` | platform/role | 14 / 30; privileged roles 7 / 14 | Proposal | SECURITY | D1.3 |
| `auth.step_up.max_age` | platform | 300 seconds | ARCHITECTURE §7 | SECURITY | D1.3 |
| `auth.mfa.required_permissions` (was `auth.mfa.required_roles`) | platform | `payroll.approve`, `payments.approve`, `payments.disburse`, `payments.reverse`, `finance.manage`, `config.manage_statutory`, `roles.manage`, `tenancy.manage`, `platform.admin`; so Owner/Director, Finance and Admin by default. A code and database constant (`MFA_REQUIRED_PERMISSIONS`, `app.permissions_require_mfa`), not runtime-configurable: it may only grow, through a migration | Brief §7; ARCHITECTURE §8 | SECURITY | D1.4 |
| `files.max_upload_mb` / `files.allowed_types` | platform | 20 / images, PDF, XLSX (BQ workbooks: 10 MB, `.xlsx`/`.xls` by content signature, see `bq.import.max_file_mb`) | Proposal | SECURITY | D2.2 (BQ only); general files later |
| `backup.rpo_minutes` / `backup.rto_hours` | platform | 15 / 4 | Brief §8 | OPS | D9.3 |
| `backup.retention_days` | platform | 35 | Proposal | OPS | D9.3 |

## 7. Localisation and display

| Key | Scope | Seed / default | Source | Status | Used from |
|---|---|---|---|---|---|
| `i18n.supported_locales` / `default_locale` | platform/tenant/user | en, sw / en | Brief §2 | PRODUCT | D0 |
| `fx.display_currencies` | tenant | USD, GBP, EUR | Brief §2 | PRODUCT | D7.1 |
| `fx.provider` / `fx.refresh_minutes` | platform | TBD / 60 | Proposal | OPS | D7.1 |
| `maps.tile_provider` | platform | OpenStreetMap (development only) | D-10 | OPS (Q-T4) | D2.1 |

> Fixed by design, not configurable: money in integer minor units, display formats `KES 1,250,000` and `DD/MM/YYYY`, and the Africa/Nairobi timezone for business dates (brief §2, §9).

## 8. Process environment (deployment settings)

These are not business rules: they tell each process where its dependencies are. The API validates them at start-up and refuses to start with a readable error if any is wrong (`apiEnvSchema` in `packages/validation/src/env.ts`). Outside production, `apps/api/.env` and then `apps/api/.env.example` fill any value not set in the environment, so a fresh clone runs with the local docker compose services. Secrets come from the secrets manager in deployed environments (ARCHITECTURE §10, §20).

| Variable | Used by | Default / local value | Notes | Status |
|---|---|---|---|---|
| `NODE_ENV` | api | `development` | `production` hides health error details and stops `.env` file loading | OPS |
| `PORT` | api | `4000` | | OPS |
| `LOG_LEVEL` | api | `info` | pino level; `silent` in the e2e suite | OPS |
| `APP_VERSION` / `GIT_SHA` | api | `0.0.0-dev` (local `0.1.0`) / unset | Shown by the health endpoints and `/status`; set by the release pipeline | OPS |
| `DATABASE_URL` | api | `pmb_app` on `localhost:55432/pmb` | Runtime role: no `BYPASSRLS`, no DDL (§6.1). The e2e suite swaps the database for `pmb_test` | SECURITY |
| `DATABASE_MIGRATION_URL` | prisma migrate | `pmb_migrator` on `localhost:55432/pmb` | Schema owner; only migrations use it | SECURITY |
| `REDIS_URL` | api | `redis://localhost:56379` | Valkey locally (D-24) | OPS |
| `S3_ENDPOINT` / `S3_REGION` / `S3_BUCKET` / `S3_FORCE_PATH_STYLE` | api | `http://localhost:9000` / `us-east-1` / `pmb-local` / `true` | Any S3-compatible service (RustFS locally) | OPS |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | api | Throwaway local keys in `.env.example` | Secrets manager outside local development | SECURITY |
| `S3_AUTO_CREATE_BUCKET` | api | `false` (`true` in `.env.example`) | Development convenience only; deployed buckets come from infrastructure code | SECURITY |
| `API_DOCS_ENABLED` | api | `true` | Swagger UI at `/api/docs`. Decide before go-live whether production publishes it | SECURITY |
| `HEALTH_CHECK_TIMEOUT_MS` | api | `2000` | Per dependency probe in `/api/v1/health/ready` | OPS |
| `WEB_ORIGIN` | api | `http://localhost:3000` | Exact origin of the web app (scheme, host and port). State-changing requests must send this `Origin`; production requires HTTPS. Also the passkey relying party: WebAuthn responses must come from exactly this origin, and its hostname is the RP ID (passkeys are bound to it, so changing the hostname orphans registered passkeys; IP addresses cannot be RP IDs) | SECURITY |
| `TRUST_PROXY` | api | unset (trust no proxy) | Proxies allowed to report the client IP in `X-Forwarded-For` (addresses, CIDRs or a hop count; `true` is rejected). Set it only when an edge proxy **appends** the real client address, because the web app's `/api` rewrite passes client-supplied values through. When unset, rate limits key on accounts, users, sessions and tokens only | SECURITY |
| `AUTH_MFA_ENCRYPTION_KEY` | api | none (required; 64 hex characters) | Encrypts TOTP secrets and CSRF tokens. Replacing it invalidates TOTP enrolments. Secrets manager outside local development | SECURITY |
| `FIELD_ENCRYPTION_KEYS` | api | none (required; `<version>:<64 hex>`, comma-separated during a rotation) | Master keys for labourer field encryption (D3.1): AES-256-GCM under per-company keys derived with HKDF-SHA-256, envelope tagged with the key version. Every listed version stays readable; losing a version makes the values written with it unreadable. **Development placeholders only** (generate locally, see `apps/api/.env.example`); production must use managed key material from the secrets manager/KMS (ARCHITECTURE §10) | SECURITY |
| `FIELD_ENCRYPTION_ACTIVE_KEY_VERSION` | api | the highest listed version | Version used for new values; must be listed in `FIELD_ENCRYPTION_KEYS` | SECURITY |
| `FIELD_BLIND_INDEX_KEY` | api | none (required; 64 hex characters) | HMAC key for blind indexes (duplicate ID, phone and KRA PIN matching, do-not-rehire checks). Separate from the encryption keys and **not rotatable without recomputing every index**. Same handling as above | SECURITY |
| `AUTH_SIGNING_PRIVATE_KEY` | api | ephemeral in development | Base64 Ed25519 PKCS8 PEM that signs access tokens; required in production | SECURITY |
| `AUTH_NOTIFICATION_TRANSPORT` / `AUTH_MAILPIT_PORT` | api | `disabled` (`development` in `.env.example`) / `8025` | Selects the `NotificationProvider`. `development` delivers every channel (email, SMS, WhatsApp) to loopback Mailpit only, phone channels to `phone-<number>@development.invalid` with a `[DEVELOPMENT ONLY][SMS]` / `[WHATSAPP]` subject prefix, and is refused in production; `disabled` makes every send fail explicitly. Delivery runs after the response, so it never reveals whether an account exists. Real SMS/WhatsApp (Africa's Talking) arrives in D7.3 | SECURITY |
| `AUTH_BREACHED_PASSWORD_CHECK` | api | `off` (`off` in `.env.example`) | `hibp` checks new passwords (registration, reset) against the Have I Been Pwned range API: only the first five hex characters of the password's SHA-1 leave the server, with `Add-Padding: true` and a two-second timeout. On a timeout or error it **fails open**: the password is accepted and a warning is logged without the password or any part of its hash. Needs outbound HTTPS to `api.pwnedpasswords.com`. Strength checks (`auth.password.min_strength`) apply either way | SECURITY |
| `MALWARE_SCANNER` | api | `disabled` (`development` in `.env.example`) | Selects the `MalwareScanner` for uploads (ARCHITECTURE §17). `development` is a no-op that records `not_scanned` / `development-noop` on each import and is refused in production; `disabled` refuses BQ uploads with 503 `malware-scanner-unavailable`. ClamAV is a TODO before any pilot | SECURITY |
| `BQ_VAT_RATE_PERCENT` | api | `16` | Interim source of `bq.vat.rate` (decimal string, 0–100, up to 4 decimals). Snapshot onto each BQ version at commit; changing it never changes committed versions. COMPLIANCE-REVIEW (CR-TAX-01) | COMPLIANCE-REVIEW |
| `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_SERVICE_NAME` | api | unset / `pm-buddy-api` | Tracing starts only when the endpoint is set; needs `pnpm start`, which preloads `telemetry.js` | OPS |
| `API_INTERNAL_URL` | web | `http://localhost:4000` | Where the web server reaches the API. Also the target of the same-origin `/api/*` rewrite, which is **fixed at build time** (D-16) | OPS |
