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
| `bq.variation.vat_rate` | — | Not a separate setting: a variation's projected totals and the version it creates use the VAT rate, rule key and status **snapshotted on its base version** (originally `bq.vat.rate` at import), so a later rate change never alters an approved version | ARCHITECTURE §4.3 | COMPLIANCE-REVIEW (CR-TAX-01) | D2.3 |
| `bq.variation.limits` | platform | 500 lines per variation, 10 attachment references per instruction, numbers up to 30 characters; reasons 3–500 characters | ARCHITECTURE §4.3 | PRODUCT | D2.3 (constant `VARIATION_LIMITS`) |
| `bq.buildup.rounding` | tenant | Half-up to the cent per line (`half_up_line`): each resource line's quantity × (1 + waste % / 100) × unit cost is rounded once; the rate is the sum of the rounded lines; any unpriced line makes the rate unavailable. Fixed in code for D2.3 and stored on each build-up version | FINANCIAL_MODEL; ARCHITECTURE §4.3 | PRODUCT | D2.3 (constant `BUILDUP_ROUNDING`) |
| `bq.buildup.limits` | platform | 50 resource lines per build-up; quantities up to 6 decimal places; waste 0–100 % with up to 4 decimal places | ARCHITECTURE §4.3 | PRODUCT | D2.3 (constant `BUILDUP_LIMITS`) |
| Build-up assumptions (bag mass, densities, sand/ballast in tonnes) | per build-up version | Written by the user on each build-up (the seed example is synthetic: cement 50 kg bags, sand and ballast in tonnes). Not converted automatically; **a lorry trip is never a build-up unit** (brief §15 G) | Brief §5.2, §15 G | PRODUCT (QS review) | D2.3 (text on the version; conversions in D5.1) |
| `valuations.retention.rate` / `.cap_pct` | project | From the contract (for example 10% / 5%) | Contract terms | PRODUCT (CR-TAX-04) | D6.3 |
| `procurement.min_quotes` | tenant | 3 (whole number 1–10). Stored in `procurement_settings.min_quotes` (no row = default). Checked when an RFQ is **awarded**: it needs this many complete, valid (received, every line priced, not expired) quotations, or a single-source exception with a reason approved by someone with `procurement.approve` who did not prepare the RFQ (also enforced by the database). Changing it affects later awards only | Brief §5.3 ("configurable") | PRODUCT | D5.2 |
| `procurement.three_way_match.qty_tolerance_pct` / `.price_tolerance_pct` | tenant | 0% / 0% (0–100 with up to 4 decimals; inclusive: exactly at the limit passes). Stored in `procurement_settings.qty_tolerance_percent` / `price_tolerance_percent`. Quantity: cumulative billed ≤ accepted (and ordered) × (1 + q/100). Price: invoice net per base unit ≤ LPO net per base unit × (1 + p/100); a lower price is only a warning. The tolerances used are stored on each match; changing them makes every current match **stale** (`settings-changed`), so an invoice must be re-matched before approval | Proposal | PRODUCT | D5.2 |
| `procurement.block_payment_without_etims` | tenant | true. Stored in `procurement_settings.block_payment_without_etims`. On: an invoice without an eTIMS number fails the match (`etims-missing`), which **no exception can override**; off: it is a warning. The number's format is only checked for shape (PM-Buddy does not query KRA). Stored on each match; a change makes current matches stale | Brief §5.3 | COMPLIANCE-REVIEW (CR-TAX-02) | D5.2 |
| `stores.consumption_variance_percent` (planned as `stores.variance_alert_threshold_pct`) | tenant | 10% (0–1,000 with up to 4 decimals). Stored in `procurement_settings.consumption_variance_percent` (no row = default) and changed with `config.manage` on Stores → Settings (`PUT stores/settings`, optimistic `version`, audited `stores.settings_updated`). A consumption-variance alert fires when actual use of a material on a BQ item is **strictly above** theoretical × (1 + t/100) (ARCHITECTURE §4.6). Read when the report is generated, so a change applies to every item at once. Per-material thresholds are not implemented | Brief §5.3 (example) | PRODUCT | D5.3 |
| `stores.reorder_level` | store × material | None (no level: never low). `stock_reorder_levels.reorder_level` in the material's base unit, set with `stores.manage` on the store's Reorder levels page (`PUT stores/:id/reorder-levels`). Low when on hand ≤ level; a level of 0 never triggers | Brief §5.3 | PRODUCT | D5.3 |
| `stores.low_stock_days_cover` | site | 7. **Not implemented in D5.3**: low stock uses the explicit reorder levels above; days of cover needs a consumption forecast | Proposal | PRODUCT | later |
| `stores.negative_stock` | platform | **Never allowed** (D-50): an issue, wastage, transfer or negative adjustment beyond what is on hand is refused (409 `insufficient-stock`), in the API and the database. Not configurable; there is no override | INVARIANTS "Stock" | PRODUCT | D5.3 |
| `stores.valuation_method` | platform | Weighted average cost per store and material, net of VAT (D-49); not configurable | Proposal | COMPLIANCE-REVIEW (CR-STK-01) | D5.3 |
| `stores.limits` (D5.3) | platform | 50 lines per issue, return, wastage or transfer; 300 lines per stock take and 300 counts per batch; quantities ≤ 10¹² with ≤ 6 decimals (base units, six places); lists 50 per page (≤ 200). Code constant `STORES_LIMITS` | ARCHITECTURE §4.6 | PRODUCT | D5.3 |
| `materials.price_change_alert_pct` | tenant | 10% (strictly greater than; up to 4 decimals, 0 < value ≤ 1,000). Stored in `procurement_settings.price_change_alert_percent` (no row = default) and changed with `config.manage` on the Price alerts page; the threshold used is stored on each price, so changing it never re-flags history | Proposal | PRODUCT | D5.1 |
| Unit conversions (`unit_conversions`, for example sand or ballast tonnes per lorry trip) | tenant material / material + supplier | None seeded for trips (a lorry trip has **no** universal size); the starter catalogue adds material factors marked ASSUMPTION for review (loose bulk density of river sand 1.6 t/m³ and ballast 1.5 t/m³, 12.5 stones or blocks per m² of wall face, a 100 m cable roll, a 25 kg binding-wire roll). The demo seed's quarry trip factors (7 t sand, 10 t ballast) are synthetic. Effective-dated, never edited; resolution supplier → material → attribute formula → standard | Brief §5.3 ("configurable") | PRODUCT | D5.1 |
| `materials.conversion.rounding` | platform | Exact rational arithmetic, one half-up (away from zero) rounding to **6 decimal places** per converted quantity; comparable prices 6 decimals in minor units; price change 4 decimals. Code constants (`CONVERSION_ROUNDING`, `COMPARABLE_PRICE_DECIMALS`, `PRICE_CHANGE_DECIMALS`) | ARCHITECTURE §4.4 | PRODUCT | D5.1 |
| `materials.steel.mass_formula` | platform | d²/162 kg per metre for Y8–Y32 (Y12 = 0.888… kg/m; within 0.15 % of BS 4449 / KS EAS 412 nominal masses) and **12 m** standard bars unless the material states another length. Code constants (`STEEL_MASS_DIVISOR`, `STEEL_STANDARD_BAR_LENGTH_M`) | Industry rule of thumb; BS 4449 | PRODUCT (QS review) | D5.1 |
| `materials.limits` | platform | Quantities ≤ 10¹² with ≤ 6 decimals; conversion paths ≤ 8 steps; unit price ≤ KES 10 billion; credit limit ≤ KES 10¹³; credit terms ≤ 365 days; 5 contacts per supplier; 200 prices shown per material. Code constant `PROCUREMENT_LIMITS` | ARCHITECTURE §4.4 | PRODUCT | D5.1 |
| `materials.price.vat_rate` | — | Not a separate setting: a new price snapshots `bq.vat.rate` (`BQ_VAT_RATE_PERCENT`) and its rule status onto the row; comparisons use the net price | Brief §5.2; ARCHITECTURE §4.4 | COMPLIANCE-REVIEW (CR-TAX-01) | D5.1 |
| `suppliers.payout.contact_change_window_days` | platform | 30: anyone who changed a supplier contact's phone in the 30 days before a payout proposal (or while it is pending) is a contributor and cannot verify it. Code and database constant (`PAYOUT_CONTACT_CHANGE_WINDOW_DAYS`, `app.guard_payout_version`) | Brief §15 D; THREAT_MODEL A-25 | SECURITY | D5.1 |
| `procurement.limits` (D5.2) | platform | 100 lines per requisition, quotation, LPO, GRN or invoice; 10 requisitions and 10 suppliers per RFQ; 10 photos per GRN (JPEG, PNG or WebP, ≤ 5 MB each); quotation and invoice documents (PDF or image) ≤ 10 MB; 120 uploads per user per hour; position fixes worse than 100 m flagged as low accuracy; the geofence check allows the reported accuracy, capped at 50 m. Code constant `P2P_LIMITS` | ARCHITECTURE §4.5 | PRODUCT | D5.2 |
| `finance.budget_alert_thresholds` (implemented as `spending.budget_alert_percent`) | tenant | **80%** (whole number 1–100), one threshold for every budget row (project, category, bill): warning at the threshold, critical above 100 %. Stored in `spending_settings.budget_alert_percent` (no row = default; `DEFAULT_SPENDING_SETTINGS`). The planned 75/90/100 % steps per project are not implemented: one company threshold plus the over-budget level covers the D5.4 alert | Proposal | PRODUCT | D5.4 |
| `spending.unusual_spend_multiplier` / `.unusual_spend_min_samples` | tenant | **3** (1–100, up to 2 decimals) × the median of the float's previous 20 expenses that are not rejected, once at least **5** (3–20) exist. `spending_settings` | Proposal (median: one earlier outlier does not move it) | PRODUCT | D5.4 |
| `spending.duplicate_window_days` | tenant | **3** (0–30): the same counterparty and amount within this many days is a possible duplicate (warning); the same M-Pesa code or reference is always critical. `spending_settings` | Proposal | PRODUCT | D5.4 |
| `spending.forecast_weeks` | tenant | **13** (4–26) weeks, Monday–Sunday on Africa/Nairobi dates. `spending_settings` | Proposal | PRODUCT | D5.4 |
| `spending.opening_cash` | tenant | None: `opening_cash_minor` + `opening_cash_on` (both or neither) entered by a company-wide `finance.manage` holder; the company forecast moves it by receipts and payments recorded since. Without it the weekly closing balances are unavailable. Visible only to company-wide finance roles | Brief §5.8 | PRODUCT | D5.4 |
| `spending.cost_codes` | tenant | Starter set loaded on request (`POST cost-codes/defaults`, `DEFAULT_COST_CODES`): MAT-01 materials, LAB-01 casual labour, PLT-01 plant hire and fuel, SUB-01 subcontract works, PRE-01 site establishment, PRE-02 site security, FEE-01 professional fees, FEE-02 bank and M-Pesa charges, PER-01 approvals and permits, TRN-01 transport, PC-01 petty-cash sundries. Companies add their own (`[A-Z0-9-]`, 2–20 characters) and deactivate, never delete | Brief §5.8 | PRODUCT | D5.4 |
| `spending.petty_cash.float_limit` | site float | Set per float when it is opened (`limit_minor`, KES); a top-up may not take the balance above it | Brief §5.8 | PRODUCT | D5.4 |
| `spending.petty_cash.negative_balance` | platform | **Never allowed** (D-58): the database refuses a float entry that would take the balance below zero; not configurable | INVARIANTS | — | D5.4 |
| `spending.limits` (D5.4) | platform | 5,000 lines per budget version, 50 per journal; 3 receipts per expense (JPEG, PNG or WebP within the GRN photo limit); an expense dated within the last **90** days; a pasted SMS ≤ 1,000 characters; alerts look back 180 days; BQ item search returns 50; lists 50 per page (≤ 200). Code constant `SPENDING_LIMITS` | Proposal | PRODUCT | D5.4 |
| `spending.settlement_cost_rounding` | platform | The cost part of each supplier payment is apportioned cumulatively, half-up, so a fully settled invoice's paid cost equals its net subtotal exactly (`settlementCostMinor`, `app.settlement_cost_minor`); not configurable | ARCHITECTURE §4.8 (D-53) | COMPLIANCE-REVIEW (CR-SPD-01) | D5.4 |

**Where the spending settings are edited (D5.4).** The `spending.*` keys above are one row of `spending_settings` per company, read with `GET spending/settings` (spending readers; the opening cash only for company-wide finance roles) and changed with `PUT spending/settings` (company-wide `finance.manage`, expected `version`; audited `spending.settings_updated` with field names only) on the Spending → Settings page, which also manages the cost codes.

**Where the procurement settings are edited (D5.2).** `procurement.min_quotes`, both match tolerances, `procurement.block_payment_without_etims` and `materials.price_change_alert_pct` are one row of `procurement_settings` per company, read with `GET procurement/settings` and changed with `PUT procurement/settings` (`config.manage`, optimistic `version`, audited `procurement.settings_updated` with field names only). In the web app they are the **Procurement settings** card on Materials → Price alerts (`/catalogue/alerts#procurement-settings`, linked from the Procurement page); users without `config.manage` see the values read-only.

### Site photos (D6.1)

Code constants (`PHOTO_VERIFICATION_DEFAULTS`, `PHOTO_LIMITS` in `packages/domain`) until per-tenant configuration exists.

| Key | Scope | Seed / default | Source | Status | Used from |
|---|---|---|---|---|---|
| `photos.geofence_tolerance_m` | platform | 30 | Typical phone GPS accuracy | PRODUCT | D6.1 |
| `photos.max_age_hours` | platform | 72 | Allows upload after a day or two offline | PRODUCT | D6.1 |
| `photos.future_skew_minutes` | platform | 10 | Phone clocks running ahead | PRODUCT | D6.1 |
| `photos.max_file_mb` / `photos.max_pixels` | platform | 15 / 50,000,000 | Upload and decompression-bomb limits (JPEG only) | SECURITY | D6.1 |

### Quality (D6.1)

One row of `quality_settings` per company (no row means the defaults), read with `GET quality/settings` (any quality reader) and changed with `PUT quality/settings` (`config.manage`, optimistic `version`; the web form is on `/quality/templates`). Defaults are `DEFAULT_QUALITY_SETTINGS` in `packages/types`.

| Key | Scope | Seed / default | Source | Status | Used from |
|---|---|---|---|---|---|
| `quality.dlp_months` | company (per certificate) | **6 months**, 1–24. The practical-completion proposal may set its own value (the contract's period); the certificate stores the months and the end date | Usual JBC building-contract default; 12 months is common for civil works. COMPLIANCE-REVIEW CR-QA-03 | COMPLIANCE-REVIEW | D6.1 |
| `quality.cube_overdue_grace_days` | company | 2 days, 0–14: a 7- or 28-day result is overdue after cast date + age + grace (Nairobi dates) | Site practice (laboratory turnaround) | PRODUCT | D6.1 |
| `quality.cube_rule` | platform | `KE-CUBE-1`: at 28 days mean ≥ f_cu and every cube ≥ f_cu − 3 N/mm²; 7 days indicative (< 65 % of f_cu flagged low). Code constant `CUBE_RULE`; the version is stored on each result | BS 5328-4 / BS 8110 practice. COMPLIANCE-REVIEW CR-QA-01 | COMPLIANCE-REVIEW | D6.1 |
| `quality.slump_rule` | platform | `KE-SLUMP-1`: pass when the measured slump is within the tolerance of the target; suggested tolerance ±10 mm (< 50 mm), ±20 mm (50–99 mm), ±30 mm (≥ 100 mm). Code constant `SLUMP_RULE` | BS EN 206 slump tolerances. COMPLIANCE-REVIEW CR-QA-02 | COMPLIANCE-REVIEW | D6.1 |
| `quality.limits` | platform | 60 items per template (300 characters each); 6 cubes per age; strengths 0–150 N/mm² (one decimal); slump ≤ 300 mm (target ≤ 250, tolerance ≤ 60); 6 photos per checklist item or snag stage; 100 rows per page. Code constant `QUALITY_LIMITS` | ARCHITECTURE §4.7 | PRODUCT | D6.1 |
| `diary.workforce_source` | diary | `manual` for diaries recorded before D6.1; the web form selects *From attendance* for a new diary (the author can switch to *Typed in*) | ARCHITECTURE §4.7 (D-61) | PRODUCT | D6.1 |

### Schedule (D6.2)

The working calendar is a per-project setting (`schedule_settings`, one row per project; no row means the defaults). It is read with `GET projects/:id/schedule` (`calendar`) and changed with `PUT projects/:id/schedule/calendar` (`projects.manage`, optimistic `version`; version 0 saves the defaults the first time; audited `schedule.calendar_updated`). In the web app it is the **Working calendar** card on the project's Schedule tab. The limits are code and database constants (`SCHEDULE_LIMITS` in `packages/types`, CHECKs in migration `20261119090000_schedule`).

| Key | Scope | Seed / default | Source | Status | Used from |
|---|---|---|---|---|---|
| `schedule.working_weekdays` | project | Monday–Saturday (ISO 1–6). Any non-empty set of weekdays | Common Kenyan site practice (six-day week); ARCHITECTURE §4.6 | PRODUCT | D6.2 |
| `schedule.include_public_holidays` | project | On: the company's `public_holidays` (attendance settings, seeded from the Public Holidays Act and Gazette notices, COMPLIANCE-REVIEW CR-PAY-14) are non-working days | Brief §5.9; attendance holidays (D3.3) | PRODUCT | D6.2 |
| `schedule.data_date` | platform | Today in Africa/Nairobi (`nairobiDate()`): remaining work is never scheduled before it. Not configurable | ARCHITECTURE §4.6 | PRODUCT | D6.2 |
| `schedule.limits` | platform | 500 activities and 2,000 dependencies per project; durations 1–1,000 working days; lags −60…365 working days; 50 baselines per project; 50 activities per delay; working days lost 0–1,000 in half days. Code constant `SCHEDULE_LIMITS` | ARCHITECTURE §4.6 | PRODUCT | D6.2 |
| `schedule.progress_basis` | activity | `physical` (whole-percent estimate) or `quantity` (done ÷ total in a unit, rounded down to 0.01 %); project progress is weighted by planned duration | Brief §15 G | PRODUCT | D6.2 |

### Valuations (D6.3)

The contract terms of interim payment certificates are per-project, append-only versions (`contract_settings`; no row = the defaults below, shown as version 0). They are read with `GET projects/:id/valuations` (`settings`) and changed with `PUT projects/:id/contract-settings` (`finance.manage`, optimistic `version`). A new version applies to valuations not yet certified: drafts recompute and a submitted valuation becomes stale (409 `valuation-stale`) until it is returned and resubmitted. Every certificate stores the settings version, the five values and the rule version it used (ARCHITECTURE §11 reproducibility). All values are COMPLIANCE-REVIEW (CR-VAL-01–04).

| Key | Scope | Seed / default | Source | Status | Used from |
|---|---|---|---|---|---|
| `valuations.retention_percent` | project | **10 %** (0–20, up to 2 decimals) of the gross valuation (work done + materials on site) | Common Kenyan building contracts (JBC); CR-VAL-01 | COMPLIANCE-REVIEW | D6.3 |
| `valuations.retention_cap_percent` | project | **5 %** of the **original** contract sum (excluding VAT); empty = no limit (0–100) | JBC practice; CR-VAL-01 | COMPLIANCE-REVIEW | D6.3 |
| `valuations.practical_release_percent` | project | **50 %** of the computed retention released at certified practical completion; the rest at certified final completion | JBC practice; CR-VAL-01 | COMPLIANCE-REVIEW | D6.3 |
| `valuations.vat_percent` | project | **16 %** (0–30) on each certificate's amount due, shown separately (certified amounts are net of VAT) | VAT Act 2013 standard rate; CR-VAL-04, CR-TAX-01 | COMPLIANCE-REVIEW | D6.3 |
| `valuations.materials_percent` | project | **100 %** (0–100) of materials on site at cost (the demo seed uses 100 % on RUI-HTS; tests use 80 %) | CR-VAL-03 | COMPLIANCE-REVIEW | D6.3 |
| `valuations.rule_version` | platform | `KE-VAL-1` (formulas in ARCHITECTURE §4.10; half away from zero once per figure) | ARCHITECTURE §4.10 | COMPLIANCE-REVIEW | D6.3 |
| `valuations.limits` | platform | 6 photos per measurement; 100 materials lines and 50 adjustments per valuation; 20,000 lines per certificate (items, materials and adjustments; the API refuses more with `valuation-too-large` and `valuations_check` holds the same bound; larger certificates export to Excel, the PDF takes 5,000); approval queue 200; S-curve 260 weeks; certificate exports 60 per user per 10 minutes. Code constants `VALUATION_LIMITS`, `CERTIFICATE_PDF_MAX_LINES` | ARCHITECTURE §4.10 | PRODUCT | D6.3 |
| `valuations.evm_weighting` | platform | PV: each measurable item's contract value over the working days of its linked baseline tasks, else over the baseline span; the baseline's working weekdays and the company's public holidays. Not configurable | CR-VAL-05; D-87 | COMPLIANCE-REVIEW | D6.3 |

### Health and safety (D8.2)

One row of `safety_settings` per company (no row means the defaults, reported as version 0), read with `GET safety/settings` (any safety reader) and changed with `PUT safety/settings` (`config.manage`, optimistic `version`; audited `safety.settings_updated` with the changed field names only). The web form is `/safety/settings`. Defaults are `DEFAULT_SAFETY_SETTINGS`, `STARTER_INDUCTION_TOPICS` and `DEFAULT_PPE_REPLACEMENT_DAYS` in `packages/types`; the limits are `SAFETY_SETTINGS_LIMITS` and CHECKs in migration `20261124090000_health_safety`. Records keep the values they were made with (D-75).

| Key | Scope | Seed / default | Source | Status | Used from |
|---|---|---|---|---|---|
| `safety.induction_topics` | company | The ten starter topics (site rules and hours, emergency procedures and assembly point, first aid and first-aiders, PPE, site hazards, working at height and scaffolds, excavations, electrical safety, housekeeping, reporting incidents and near misses), translated EN/SW; 1–30 topics; a company topic has its own label (2–120 characters, one language) | Common Kenyan site induction content; the legal minimum awaits review (COMPLIANCE-REVIEW CR-HS-02) | PRODUCT | D8.2 |
| `safety.induction_validity_days` | company | **None** (an induction at a site does not expire); 30–1,095 days when set | Company policy (many contractors re-induct yearly or after a long absence) | PRODUCT | D8.2 |
| `safety.induction_lookback_days` | company | **14 days**, 1–90: attendance this far back is read to flag labourers who worked at a site without a valid induction | ARCHITECTURE §4.9 (D-71) | PRODUCT | D8.2 |
| `safety.kit_check_interval_days` | company | **30 days**, 7–180: a kit's next check is due this long after the last one | Site practice; legal contents and inspection frequency await review (COMPLIANCE-REVIEW CR-HS-04) | COMPLIANCE-REVIEW | D8.2 |
| `safety.ppe_replacement_days` | company (per item) | Helmet 1,095; safety boots 365; reflective vest 180; gloves 30; harness 1,825; goggles 180; ear protection 90; dust mask 7; overalls 365 days (each 1–3,650). Stored on each issue with its due date | Typical manufacturer service lives; COMPLIANCE-REVIEW CR-HS-03 | COMPLIANCE-REVIEW | D8.2 |
| `safety.warning_days` | platform | PPE due soon 14 days before the replacement date; kit contents expiring and first-aid certificates expiring within 30 days. Code constant `SAFETY_WARNING_DAYS` | ARCHITECTURE §4.9 | PRODUCT | D8.2 |
| `safety.regulator_review_rule` | platform | A regulator decision is required before closing a **serious or fatal injury** or any **dangerous occurrence** (`packages/domain` `regulatorReviewRequired`, re-checked by `app.guard_safety_incident`) | OSHA 2007 / WIBA 2007 reporting duties as understood; COMPLIANCE-REVIEW CR-HS-01 | COMPLIANCE-REVIEW | D8.2 |
| `safety.limits` | platform | 200 labourers per toolbox talk (500 others counted); 20 people and 6 photos per incident; PPE quantity 1–20; 100 rows per page. Code constant `SAFETY_LIMITS` | ARCHITECTURE §4.9 | PRODUCT | D8.2 |

### Supplier portal (D7.2)

No company settings: the portal uses the D5.2 procurement settings (match tolerances, `procurement.block_payment_without_etims`) as they are. Limits are code constants until per-tenant configuration exists.

| Key | Scope | Seed / default | Source | Status | Used from |
|---|---|---|---|---|---|
| `supplier_portal.limits` | platform | 30 invoice submissions per portal user per hour; 3 documents from the supplier per invoice, across all its portal users (PDF or photo within the D5.2 document limit; also enforced by `app.stamp_procurement_document_source`); statements default to the last 90 days, at most 1,096 days, PDF up to 5,000 lines (Excel unlimited); 30 statement exports per user per 10 minutes; 20 portal invitations per staff user per hour; 50 rows per page (≤ 200). Code constant `SUPPLIER_PORTAL_LIMITS` | ARCHITECTURE §4.12; THREAT_MODEL A-86 | PRODUCT | D7.2 |
| `supplier_portal.etims_required` | platform | Always: a portal invoice needs an eTIMS number (staff-recorded invoices follow `procurement.block_payment_without_etims`) | COMPLIANCE_TODO CR-SUP-01 | COMPLIANCE-REVIEW | D7.2 |

### Plant and equipment (D8.3)

One row of `plant_settings` per company (no row means the defaults, reported as version 0), read with `GET plant/settings` (any plant reader or `config.manage`) and changed with `PUT plant/settings` (`config.manage`, optimistic `version`; audited `plant.settings_updated` with the changed field names only). The web form is `/plant/settings`. Defaults are `DEFAULT_PLANT_SETTINGS` in `packages/types`; the limits are `PLANT_SETTINGS_LIMITS` and the CHECK in migration `20261126090000_plant`. Alerts are computed on read, so a change applies to every item at once (old fuel windows are judged by the standard each issue carried, D-94).

| Key | Scope | Seed / default | Source | Status | Used from |
|---|---|---|---|---|---|
| `plant.fuel_variance_percent` | company | **15 %**, 1–100: a full-tank window is flagged when actual litres > expected × (1 + tolerance) | Site practice; COMPLIANCE-REVIEW CR-PLT-02 | Proposed | D8.3 |
| `plant.fuel_min_hours` / `plant.fuel_min_km` | company | **10 hours** (1–200) / **100 km** (10–5,000): a window shorter than this is not judged and extends to the next full filling | Measurement error on a few litres; CR-PLT-02 | Proposed | D8.3 |
| `plant.idle_hire_days` | company | **3 days**, 1–60: hired plant with no working day for this long (today not counted) is flagged idle on hire | Site practice (ghost hire days, THREAT_MODEL A-72) | Proposed | D8.3 |
| `plant.hire_ending_days` | company | **7 days**, 1–60: hired plant whose hire ends within this many days is flagged | Site practice | Proposed | D8.3 |
| `plant.service_due_soon_percent` | company | **10 %**, 0–50: a service is due within the last 10 % of its meter or calendar interval, overdue after it | Dealer practice (service by hours or months, whichever first) | Proposed | D8.3 |
| `plant.certificate_categories` | company | excavator, loader, roller, crane/hoist, vehicle: an operator of these without a current certificate is flagged (never blocked) | COMPLIANCE-REVIEW CR-PLT-01 | Proposed | D8.3 |
| Per item: standard consumption, service interval | item | Entered on the register (litres per hour or km, two decimals; every N hours/km and/or N days, 1–3,650 days); none by default | The company / manufacturers' data; CR-PLT-02 | Proposed | D8.3 |
| `plant.limits` | platform | `PLANT_LIMITS`: one day ≤ 24.0 hours or 1,500 km; one fuel issue 0.1–2,000.0 L; readings ≤ 9,999,999.9; usage, fuel, breakdowns, repairs, services, moves and closing back-dated at most 60 days; fuel windows listed for 180 days and alerts from the last 30 days; certificates expiring within 30 days warned; hire rates ≤ KES 10 million; 100 rows per page | Product limits | Proposed | D8.3 |

### Dashboards and reports (D8.1)

No company settings: limits are code constants (`REPORT_LIMITS`, `REPORT_DEFINITIONS` in `packages/types/src/reports.ts`) until per-tenant configuration exists.

| Key | Scope | Seed / default | Source | Status | Used from |
|---|---|---|---|---|---|
| `reports.periods` | platform | Muster roll at most **31** days (default 7); audit log at most **92** (default 7); other range reports at most **366** (defaults: cost ledger, stock and petty cash 30; LPO register, supplier payments and safety 90); invoice ageing as at a date within the last year (default today) | Bounded queries (D-129) | PRODUCT | D8.1 |
| `reports.limits` | platform | Screen: 200 rows per section; PDF: **5,000** rows (above: 422 `use-excel`); any report: **20,000** rows (422 `report-too-large`); 60 previews per user per minute; 60 exports per user per 10 minutes; exports in a 30-second transaction; audit-log action filter ≤ 100 characters | D-122 | PRODUCT | D8.1 |
| `reports.excel_money` | platform | Excel money as **numbers of shillings with two decimals** (`#,##0.00`); dates as Excel dates (`dd/mm/yyyy`), times as Nairobi wall-clock (`dd/mm/yyyy hh:mm`), percentages as fractions (`0.0%`); the screen and PDF show `KES 1,234.50` | D-122 | PRODUCT | D8.1 |
| `reports.subscriptions` | platform | Weekly (ISO weekday) or monthly (day 1–31, clamped to the month's end), sent at **07:00 Africa/Nairobi**; at most **20** per person and **200** per company; the scheduler checks every **60 s** and takes at most **25** due subscriptions per cycle | D-126 | PRODUCT | D8.1 |
| `reports.dashboard_due_soon_days` | platform | **7**: approved supplier invoices due within 7 days count as "due soon" on the dashboard | D-121 | PRODUCT | D8.1 |

## 6. Security, auth and operations

| Key | Scope | Seed / default | Source | Status | Used from |
|---|---|---|---|---|---|
| `auth.password.min_length` | platform | 12 | OWASP ASVS | SECURITY | D1.3 |
| `suppliers.reveal.rate_limit` | platform | 20 reveals (KRA PIN, contact phone, account number) and 30 exact-match lookups (KRA PIN or phone) per user per 10 minutes; each audited. Code constant `PROCUREMENT_LIMITS` | THREAT_MODEL (enumeration) | SECURITY | D5.1 |
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
| `TRUST_PROXY` | api | unset (trust no proxy) | Proxies allowed to report the client IP in `X-Forwarded-For` (addresses, CIDRs or a hop count; `true` is rejected). Set it only when an edge proxy **appends** the real client address, because the web app's `/api` rewrite passes client-supplied values through. When unset, rate limits key on accounts, users, sessions and tokens only, so **production refuses to start without it**, or with `0` or an empty list (which Express accepts but which trust no proxy) | SECURITY |
| `AUTH_MFA_ENCRYPTION_KEY` | api | none (required; 64 hex characters) | Encrypts TOTP secrets and CSRF tokens. Replacing it invalidates TOTP enrolments. Secrets manager outside local development | SECURITY |
| `AUTH_PIN_PEPPER_KEYS` | api | none (**required in production**; `<version>:<64 hex>`, comma-separated during a rotation) | HMAC-SHA-256 pepper applied to labourer PINs before Argon2id, so a leaked database does not reveal PINs. Each user row records the version (`users.pin_pepper_version`; null = an older, unpeppered hash). Keep an old version listed until every PIN using it has been re-hashed, which a correct sign-in does. With more than one key listed, `AUTH_PIN_PEPPER_ACTIVE_VERSION` is required, so a rotation takes two deploys: add the new key everywhere with the active version unchanged, then make it active. A PIN whose version is not listed cannot sign in (a warning with the version is logged). Losing a key makes the PINs hashed with it unusable until the labourers reset by SMS. Secrets manager outside local development; optional locally (PINs are then stored unpeppered) | SECURITY |
| `AUTH_PIN_PEPPER_ACTIVE_VERSION` | api | the only listed version (**required when more than one is listed**) | Pepper version for new PIN hashes; must be listed in `AUTH_PIN_PEPPER_KEYS` | SECURITY |
| `PIN_GLOBAL_FAILURES_PER_HOUR` | api | 200 (10–100,000) | Wrong PINs per hour across all numbers, from every address. When reached, an alert is logged once (`event: pin_failure_budget_exceeded`) and each number gets one wrong PIN an hour (`pin-temporarily-limited` after it, until the hour ends or an SMS reset). Only wrong PINs made while it is spent count, so correct PINs keep working for every number without one: one client can trip the budget, but that only tightens guessing and cannot lock labourers out | SECURITY |
| `FIELD_ENCRYPTION_KEYS` | api | none (required; `<version>:<64 hex>`, comma-separated during a rotation) | Master keys for labourer field encryption (D3.1): AES-256-GCM under per-company keys derived with HKDF-SHA-256, envelope tagged with the key version. Every listed version stays readable; losing a version makes the values written with it unreadable. **Development placeholders only** (generate locally, see `apps/api/.env.example`); production must use managed key material from the secrets manager/KMS (ARCHITECTURE §10) | SECURITY |
| `FIELD_ENCRYPTION_ACTIVE_KEY_VERSION` | api | the highest listed version | Version used for new values; must be listed in `FIELD_ENCRYPTION_KEYS` | SECURITY |
| `FIELD_BLIND_INDEX_KEY` | api | none (required; 64 hex characters) | HMAC key for blind indexes (duplicate ID, phone and KRA PIN matching, do-not-rehire checks). Separate from the encryption keys and **not rotatable without recomputing every index**. Same handling as above | SECURITY |
| `AUTH_SIGNING_PRIVATE_KEY` | api | ephemeral in development | Base64 Ed25519 PKCS8 PEM that signs access tokens; required in production | SECURITY |
| `AUTH_NOTIFICATION_TRANSPORT` / `AUTH_MAILPIT_PORT` | api | `disabled` (`development` in `.env.example`) / `8025` | Selects the `NotificationProvider`. `development` delivers every channel (email, SMS, WhatsApp) to loopback Mailpit only, phone channels to `phone-<number>@development.invalid` with a `[DEVELOPMENT ONLY][SMS]` / `[WHATSAPP]` subject prefix, and is refused in production; `disabled` makes every send fail explicitly. Delivery runs after the response, so it never reveals whether an account exists. Real SMS/WhatsApp (Africa's Talking) arrives in D7.3 | SECURITY |
| `AUTH_BREACHED_PASSWORD_CHECK` | api | `off` (`off` in `.env.example`) | `hibp` checks new passwords (registration, reset) against the Have I Been Pwned range API: only the first five hex characters of the password's SHA-1 leave the server, with `Add-Padding: true` and a two-second timeout. On a timeout or error it **fails open**: the password is accepted and a warning is logged without the password or any part of its hash. Needs outbound HTTPS to `api.pwnedpasswords.com`. Strength checks (`auth.password.min_strength`) apply either way | SECURITY |
| `AUTH_GOOGLE_CLIENT_ID` / `AUTH_GOOGLE_CLIENT_SECRET` | api | unset (Google sign-in hidden) | Both or neither (startup fails otherwise). A Google Cloud OAuth client of type *Web application* whose authorised redirect URI is exactly `${WEB_ORIGIN}/api/v1/auth/google/callback`. Only verified Gmail or matching Google Workspace (`hd`) addresses are accepted; matching accounts are linked automatically and new ones created; PM-Buddy MFA still applies ([API README](../apps/api/README.md#continue-with-google)). The secret belongs in `apps/api/.env` or the secrets manager, never in the repository. Needs outbound HTTPS to `accounts.google.com`, `oauth2.googleapis.com` and `www.googleapis.com` | SECURITY |
| `AUTH_GOOGLE_ISSUER` | api (tests) | unset (`https://accounts.google.com`) | Test-only override pointing at a local fake provider; plain HTTP only on loopback; refused in production | SECURITY |
| `MALWARE_SCANNER` | api | `disabled` (`development` in `.env.example`) | Selects the `MalwareScanner` for uploads (ARCHITECTURE §17). `development` is a no-op that records `not_scanned` / `development-noop` on each import and is refused in production; `disabled` refuses BQ uploads with 503 `malware-scanner-unavailable`. ClamAV is a TODO before any pilot | SECURITY |
| `REPORT_SCHEDULER` | api | unset (on, except under `NODE_ENV=test`); `off` in the e2e suite | `on`/`off`: the in-process scheduler for report emails (D-126). With several API instances every one may run it (an advisory lock lets one cycle run at a time). Emails go through `AUTH_NOTIFICATION_TRANSPORT`, which stays `disabled` in production until a provider is approved; while it is disabled every due run is recorded as `failed` (`delivery-failed`) and nothing is sent | OPS |
| `BQ_VAT_RATE_PERCENT` | api | `16` | Interim source of `bq.vat.rate` (decimal string, 0–100, up to 4 decimals). Snapshot onto each BQ version at commit; changing it never changes committed versions. COMPLIANCE-REVIEW (CR-TAX-01) | COMPLIANCE-REVIEW |
| `FIELD_ENCRYPTION_KEYS` / `FIELD_ENCRYPTION_ACTIVE_KEY_VERSION` / `FIELD_BLIND_INDEX_KEY` | api | none (required: the API does not start without them) / highest listed version / none | Field-level encryption (ARCHITECTURE §10): comma-separated `<version>:<64 hex>` AES-256-GCM master keys (per-company keys derived with HKDF), the active version for new values, and a separate 64-hex HMAC key for blind indexes. Used for supplier KRA PINs, contact phones and bank account numbers (D5.1) and labourer identifiers (D3.1). Generate local values as shown in `apps/api/.env.example`; the e2e suite generates throwaway keys. Losing a key makes values written with it unreadable; rotating means listing the new version and re-encrypting. Secrets manager / KMS outside local development | SECURITY |
| `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_SERVICE_NAME` | api | unset / `pm-buddy-api` | Tracing starts only when the endpoint is set; needs `pnpm start`, which preloads `telemetry.js` | OPS |
| `API_INTERNAL_URL` | web | `http://localhost:4000` | Where the web server reaches the API. Also the target of the same-origin `/api/*` rewrite, which is **fixed at build time** (D-16) | OPS |
