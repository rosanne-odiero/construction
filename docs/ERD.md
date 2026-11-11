# PM-Buddy: Entity Relationship Diagrams

> Phase 0 draft, refined from brief §10. The diagrams are split by domain so they stay readable. Each one shows **key attributes only**. The full column set lives in the Prisma schema from D1.1 onwards. Related: [ARCHITECTURE](./ARCHITECTURE.md) · [OpenAPI outline](./api/openapi-outline.yaml)

## Conventions (apply to every tenant-owned table)

| Convention | Rule |
|---|---|
| Standard columns | `tenant_id`, `created_at`, `created_by`, `updated_at`, `updated_by`, plus `deleted_at` where soft delete applies and `version` on editable aggregates. **They are left out of the diagrams below.** |
| Tenant isolation | RLS on `tenant_id`. Parents expose `UNIQUE (tenant_id, id)`, and child FKs are composite `(tenant_id, parent_id)` (ARCHITECTURE §6). |
| IDs | UUIDv7 (`uuid`) |
| Money | `*_minor` = `bigint` cents, with a `currency` column where it can differ from KES |
| Quantities and rates | `numeric(20,4)` |
| Encrypted fields | `*_enc` = envelope-encrypted `bytea`. `*_bidx` = blind index for exact lookup. |
| Append-only | Marked "append-only": no `UPDATE` or `DELETE` granted to the app role; corrections are new rows |
| Effective dating | Configuration tables carry `effective_from`, `effective_to`, `version`, `source_reference` and `compliance_status` |

Immutable event/journal/audit records have creation metadata and linked corrections, not mutable update/soft-delete semantics. Retention and deletion follow a reviewed data-class/legal-hold policy. The runtime Prisma schema and migrations, not these draft diagrams, prove implementation.

## Domain map

```mermaid
flowchart LR
  ID["1 Identity, tenancy, audit"] --> PRJ["3 Projects, sites, schedule"]
  CFG["2 Configuration and rules"] --> PAY["7 Payroll and payments"]
  CFG --> ATT
  PRJ --> BQ["4 BQ and commercial"]
  PRJ --> LAB["6 Labour, attendance, biometrics"]
  LAB --> ATT["6 Attendance"]
  ATT --> PAY
  BQ --> MAT["5 Materials, procurement, stores"]
  MAT --> PAY
  BQ --> FIN["8 Finance and cash flow"]
  PAY --> FIN
  MAT --> FIN
  PRJ --> OPS["9 Site ops, quality, H&S, plant"]
  OPS --> BQ
  ID --> DOC["10 Documents, notifications, platform plumbing"]
```

---

## 1. Identity, tenancy and audit

```mermaid
erDiagram
  Tenant ||--o{ Membership : "has members"
  Tenant ||--o{ Role : "defines custom"
  Tenant ||--o{ Device : "registers"
  Tenant ||--o{ AuditLog : "records"
  Tenant ||--o| Subscription : "billed by"
  User ||--o{ Membership : "belongs to"
  User ||--o{ Credential : "authenticates with"
  User ||--o{ MfaFactor : "enrols"
  User ||--o{ Session : "opens"
  Session ||--o{ RefreshToken : "rotates"
  Session }o--o| Device : "bound to"
  Membership ||--o{ MembershipRole : "granted"
  Role ||--o{ MembershipRole : "assigned via"
  Role ||--o{ RolePermission : "bundles"
  Permission ||--o{ RolePermission : "included in"
  User ||--o{ ProjectMembership : "works on"
  Role ||--o{ ProjectMembership : "as role"
  Tenant ||--o{ Invitation : "sends"

  Tenant {
    uuid id PK
    text name
    text legal_name
    bytea kra_pin_enc
    text nca_registration_no
    text default_locale "en or sw"
    text status "active, suspended"
  }
  Subscription {
    uuid tenant_id PK, FK
    text plan
    text status
    date current_period_end
  }
  User {
    uuid id PK
    text email UK "nullable"
    bytea phone_enc
    text phone_bidx UK "2547XXXXXXXX normalised"
    text display_name
    text locale
    bool mfa_required "true for Owner, Finance, Admin"
    text status
  }
  Credential {
    uuid id PK
    uuid user_id FK
    text kind "password"
    text argon2id_hash
    timestamptz changed_at
  }
  MfaFactor {
    uuid id PK
    uuid user_id FK
    text kind "totp, passkey, recovery_code"
    bytea secret_enc "TOTP secret"
    text credential_id "passkey"
    bytea public_key "passkey"
    timestamptz last_used_at
  }
  Session {
    uuid id PK
    uuid user_id FK
    uuid active_tenant_id FK
    uuid device_id FK
    text ip
    text user_agent
    timestamptz mfa_at "for step-up"
    timestamptz last_seen_at
    timestamptz revoked_at
  }
  RefreshToken {
    uuid id PK
    uuid session_id FK
    uuid family_id
    text token_sha256 UK
    timestamptz expires_at
    timestamptz used_at "reuse revokes family"
  }
  Device {
    uuid id PK
    text kind "browser, site_app, kiosk, terminal"
    bytea public_key "Ed25519 for signed sync"
    uuid site_id FK "kiosk and terminal"
    text status "active, revoked"
    timestamptz last_seen_at
  }
  Membership {
    uuid id PK
    uuid tenant_id FK
    uuid user_id FK
    text kind "staff, client, supplier, consultant"
    text status
  }
  Role {
    uuid id PK
    uuid tenant_id FK "null for system roles"
    text key "owner, pm, site_agent, foreman, qs, storekeeper, finance, client, consultant, supplier"
    bool is_system
  }
  Permission {
    text key PK "e.g. payments.approve"
    text module
    text description
  }
  RolePermission {
    uuid role_id PK, FK
    text permission_key PK, FK
  }
  MembershipRole {
    uuid membership_id PK, FK
    uuid role_id PK, FK
    bigint approval_limit_minor "nullable"
  }
  ProjectMembership {
    uuid id PK
    uuid project_id FK
    uuid user_id FK
    uuid role_id FK
    bigint approval_limit_minor
  }
  Invitation {
    uuid id PK
    text email_or_phone
    uuid role_id FK
    uuid project_id FK "optional"
    text token_sha256
    timestamptz expires_at
    timestamptz accepted_at
  }
  AuditLog {
    uuid id PK "append-only, monthly partitions"
    timestamptz occurred_at
    uuid actor_user_id
    uuid actor_device_id
    text ip
    text request_id
    text action "create, update, delete, approve, login, export"
    text entity_type
    uuid entity_id
    jsonb before
    jsonb after
    bytea prev_hash
    bytea hash "hash chain per tenant"
  }
```

> **Implemented in D1.4 (differs from the target model above):** system roles and their permissions are code constants (`packages/types` `SYSTEM_ROLE_PERMISSIONS`), not `Role` rows. Company custom roles are `tenant_roles (tenant_id, id, name citext, permissions text[], tenant_wide)` with forced RLS. `memberships` and `invitations` hold `role` (a system key, or `custom`) plus `custom_role_id`, referencing `tenant_roles` through the composite key `(tenant_id, custom_role_id)`. Permission keys are checked by database CHECK constraints rather than a `Permission` table. `ProjectMembership.permissions` holds the project assignment (effective = role ∩ assignment). See [ARCHITECTURE §8](./ARCHITECTURE.md#8-authorisation-rbac-with-project-scope).

## 2. Configuration and rules (effective-dated)

```mermaid
erDiagram
  ConfigRule {
    uuid id PK
    text key "e.g. payroll.shif, mpesa.b2c.limits"
    text scope "platform, tenant, project"
    uuid scope_id
    jsonb value "validated by Zod schema per key"
    date effective_from
    date effective_to
    int version
    text source_reference
    text compliance_status "draft, needs_review, approved"
    uuid approved_by
  }
  StatutoryRule ||--o{ StatutoryRuleBand : "has bands"
  StatutoryRule {
    uuid id PK
    text kind "paye, nssf, shif, ahl, nita"
    text scope
    uuid scope_id
    jsonb params "relief, floors, caps, rates, LEL and UEL"
    date effective_from
    date effective_to
    int version
    text compliance_status
    text source_reference
  }
  StatutoryRuleBand {
    uuid id PK
    uuid rule_id FK
    int seq
    bigint lower_minor
    bigint upper_minor "null = no cap"
    numeric rate
  }
  EngagementDeductionRule {
    uuid id PK
    text engagement_type "casual, term, piece_rate"
    text statutory_kind
    bool applies
    bool deductible_before_paye
    date effective_from
    text compliance_status
  }
  OvertimeRule {
    uuid id PK
    text scope
    text day_type "weekday, rest_day, public_holiday"
    numeric threshold_hours
    numeric multiplier
    date effective_from
    date effective_to
    text compliance_status
  }
  PublicHoliday {
    uuid id PK
    date holiday_date
    text name_en
    text name_sw
    text scope
    text gazette_reference
  }
  MpesaTariff {
    uuid id PK
    text product "b2c, b2b, c2b"
    bigint lower_minor
    bigint upper_minor
    bigint charge_minor
    date effective_from
    date effective_to
  }
  FxRate {
    uuid id PK
    text currency "USD, GBP, EUR"
    numeric kes_per_unit
    timestamptz as_of
    text source
  }
```

## 3. Projects, sites and schedule

```mermaid
erDiagram
  Client ||--o{ Project : "commissions"
  Project ||--|{ Site : "has"
  Site ||--o{ Geofence : "bounded by"
  Project ||--o{ WbsNode : "broken down into"
  WbsNode ||--o{ WbsNode : "parent of"
  Project ||--o{ Milestone : "tracks"
  WbsNode ||--o{ ScheduleActivity : "groups"
  ScheduleActivity ||--o{ ActivityDependency : "predecessor"
  ScheduleActivity ||--o{ ActivityDependency : "successor"
  Project ||--o{ ScheduleBaseline : "freezes"
  ScheduleBaseline ||--|{ BaselineActivity : "snapshots"
  ScheduleActivity ||--o{ DelayEvent : "delayed by"
  Project ||--o{ ProjectMembership : "team"

  Client {
    uuid id PK
    text kind "individual, company"
    text name
    text email
    bytea phone_enc
    text country "diaspora support"
    text preferred_currency "KES, USD, GBP, EUR"
  }
  Project {
    uuid id PK
    uuid client_id FK
    text code UK "used as C2B account number"
    text name
    text contract_type "JBC, lump sum, remeasurement, design and build"
    bigint contract_sum_minor
    date start_date
    date end_date
    text county
    text status "planning, active, practical_completion, dlp, closed"
    int dlp_months
  }
  Site {
    uuid id PK
    uuid project_id FK
    text name
    text address
    text county
  }
  Geofence {
    uuid id PK
    uuid site_id FK
    text kind "polygon, radius"
    jsonb polygon_geojson
    numeric center_lat
    numeric center_lon
    int radius_m
    date active_from
  }
  WbsNode {
    uuid id PK
    uuid project_id FK
    uuid parent_id FK
    text code
    text name
    int sort
  }
  Milestone {
    uuid id PK
    uuid project_id FK
    uuid wbs_node_id FK
    text name
    date planned_date
    date actual_date
    bool payment_linked
  }
  ScheduleActivity {
    uuid id PK
    uuid wbs_node_id FK
    uuid bq_item_id FK "optional link"
    text name
    date planned_start
    date planned_finish
    date actual_start
    date actual_finish
    numeric percent_complete
  }
  ActivityDependency {
    uuid predecessor_id PK, FK
    uuid successor_id PK, FK
    text kind "FS, SS, FF, SF"
    int lag_days
  }
  ScheduleBaseline {
    uuid id PK
    uuid project_id FK
    text name
    timestamptz captured_at
  }
  BaselineActivity {
    uuid baseline_id PK, FK
    uuid activity_id PK, FK
    date planned_start
    date planned_finish
  }
  DelayEvent {
    uuid id PK
    uuid activity_id FK
    text cause "rain, materials, late_payment, approvals, design_change, other"
    date start_date
    date end_date
    numeric days
    text notes
  }
```

**Implemented in D2.1** (migration `20261110100000_projects_sites_geofences`; [ARCHITECTURE §4.1](./ARCHITECTURE.md#41-projects-module-d21)). The model above remains the target; the implemented tables differ as follows.

| Entity | Implemented as | Difference from the target model |
|---|---|---|
| Client | Not yet a table | `projects.client_name`, `client_email`, `client_phone` hold a simple contact until the client portal (D7.1) introduces `Client` and `client_id`. |
| Project | `projects` | `code` is unique per company (`PRJ-001…` assigned when omitted; existing rows were backfilled). `status` is `planning, active, on_hold, completed, closed, cancelled` with transitions in `app.guard_project`; practical completion and the defects liability period (`dlp_months`) join with valuations and retentions (D6.x). `contract_type` is `lump_sum, remeasurement, design_and_build, cost_plus, labour_only` (JBC is a standard form, not a pricing basis). Adds `description`, `town`, optional `latitude`/`longitude`, `currency` (KES only), `version` (optimistic concurrency), `created_by`, `updated_at`. |
| ProjectStatusChange | `project_status_changes` | New: append-only history of transitions (`from_status`, `to_status`, `reason`, `changed_by`, `changed_at`). |
| Site | `sites` | `name` (unique per project), `address` (address or landmark) and `version`; the county stays on the project. Sites cannot be deleted yet (attendance will reference them). |
| Geofence | `site_geofences` | One row per **version** (`version`, `effective_from timestamptz` set by the database, strictly increasing per site) instead of `active_from date`, so the version in force at a capture time is exact. A polygon is a jsonb array of `{lat,lng}` vertices (open ring) rather than GeoJSON; a radius is `center_lat`/`center_lng`/`radius_m`. `area_m2` and `perimeter_m` are stored. Rows are never updated or deleted. |
| WbsNode | `wbs_nodes` | Adds `weight_basis_points` (share of the parent, 10,000 = 100 %), `sort_order` (for `sort`) and `version`; the parent is referenced through `(tenant_id, project_id, parent_id)`. Codes are unique per project. |
| Milestone | `milestones` | `due_date` (for `planned_date`), `status` (`planned, in_progress, achieved, cancelled`), `actual_date`, `status_reason`, `version`; names are unique per project. `payment_linked` waits for valuations (D6.x). |
| ProjectMembership | `project_memberships` | `project_permissions_check` widened to the project-scoped catalogue (`PROJECT_ASSIGNABLE_PERMISSIONS`). |

## 4. BQ, variations, valuations and subcontracts

```mermaid
erDiagram
  Project ||--o{ Bq : "has"
  Bq ||--|{ BqVersion : "versioned as"
  BqVersion ||--|{ BqBill : "contains"
  BqBill ||--o{ BqSection : "contains"
  BqSection ||--o{ BqSection : "sub-element"
  BqSection ||--o{ BqItem : "contains"
  BqItem }o--o| RateBuildUp : "priced by"
  RateBuildUp ||--|{ RateBuildUpComponent : "made of"
  BqImportJob ||--o| BqVersion : "produces"
  BqMappingTemplate ||--o{ BqImportJob : "reused by"
  Instruction ||--o{ VariationOrder : "authorises"
  VariationOrder ||--|{ VariationLine : "changes"
  VariationOrder ||--o| BqVersion : "creates revision"
  BqItem ||--o{ ProgressMeasurement : "measured by"
  Valuation ||--|{ ValuationLine : "values"
  BqItem ||--o{ ValuationLine : "valued in"
  Valuation ||--o| PaymentCertificate : "certified as"
  PaymentCertificate ||--o{ RetentionEntry : "holds or releases"
  Subcontract ||--|{ SubcontractItem : "covers"
  BqItem ||--o{ SubcontractItem : "sublet as"
  BqItem ||--o{ PieceRateJob : "paid piece-rate"

  Bq {
    uuid id PK
    uuid project_id FK
    text name
    uuid current_version_id FK
  }
  BqVersion {
    uuid id PK
    uuid bq_id FK
    int version_no
    text status "draft, approved, superseded"
    text source "import, variation, manual"
    uuid variation_order_id FK
    bigint contract_sum_minor
    numeric vat_rate "from config"
    uuid approved_by
  }
  BqBill {
    uuid id PK
    uuid bq_version_id FK
    text number "Bill No. 1"
    text title
    text kind "preliminaries, measured, provisional, pc_sum, contingency, dayworks"
    int sort
  }
  BqSection {
    uuid id PK
    uuid bill_id FK
    uuid parent_section_id FK
    text code
    text title "element"
    int sort
  }
  BqItem {
    uuid id PK
    uuid section_id FK
    uuid lineage_id "stable across versions"
    text item_ref "A, B, C or 2.1.3"
    text description
    text unit_code FK "m3, m2, m, kg, t, No, Item, LS"
    numeric quantity
    bigint rate_minor
    bigint amount_minor
    text item_type "measured, prov_sum, pc_sum, lump_sum, dayworks, note"
    uuid rate_buildup_id FK
  }
  BqImportJob {
    uuid id PK
    uuid project_id FK
    uuid file_id FK
    text sheet_name
    int header_row
    jsonb column_mapping
    bigint sheet_total_minor
    bigint computed_total_minor
    jsonb issues "row-level warnings"
    text status "uploaded, mapped, validated, imported, failed"
  }
  BqMappingTemplate {
    uuid id PK
    text name "e.g. QS firm format"
    jsonb mapping
  }
  RateBuildUp {
    uuid id PK
    text code
    text name "e.g. Concrete class 25 (1:2:4)"
    text output_unit_code
  }
  RateBuildUpComponent {
    uuid id PK
    uuid buildup_id FK
    text kind "material, labour, plant"
    uuid material_id FK
    uuid trade_id FK
    numeric quantity "per output unit"
    text unit_code
    numeric wastage_pct
  }
  Instruction {
    uuid id PK
    uuid project_id FK
    text number "AI-007"
    text issuer_kind "architect, engineer, qs, client"
    uuid consultant_id FK
    date issued_on
    text subject
    uuid file_id FK
  }
  VariationOrder {
    uuid id PK
    uuid instruction_id FK
    text number "VO-004"
    text title
    bigint amount_minor "plus or minus"
    text status "draft, submitted, approved, rejected"
    text client_decision "pending, approved, rejected"
    text client_comment
  }
  VariationLine {
    uuid id PK
    uuid variation_order_id FK
    uuid bq_item_lineage_id "nullable for new items"
    text action "add, omit, adjust"
    text description
    numeric quantity_delta
    bigint rate_minor
    bigint amount_minor
  }
  ProgressMeasurement {
    uuid id PK
    uuid bq_item_id FK
    date measured_on
    numeric quantity_to_date
    numeric quantity_this_period
    uuid measured_by
    text status "draft, submitted, approved"
  }
  Valuation {
    uuid id PK
    uuid project_id FK
    int number
    date valuation_date
    bigint gross_work_done_minor
    bigint materials_on_site_minor
    bigint retention_minor
    bigint previous_certified_minor
    bigint amount_due_minor
    bigint vat_minor
    jsonb rule_snapshot "retention and VAT rule versions"
    text status
  }
  ValuationLine {
    uuid valuation_id PK, FK
    uuid bq_item_id PK, FK
    numeric quantity_to_date
    bigint value_to_date_minor
  }
  PaymentCertificate {
    uuid id PK
    uuid valuation_id FK
    text number "IPC-04"
    date issued_on
    date due_date
    bigint amount_due_minor
    text status "issued, part_paid, paid, cancelled"
    uuid file_id FK
  }
  RetentionEntry {
    uuid id PK
    uuid certificate_id FK
    text kind "held, release_practical_completion, release_dlp"
    bigint amount_minor
    date entry_date
  }
  Subcontract {
    uuid id PK
    uuid project_id FK
    uuid subcontractor_id FK
    text kind "labour_only, supply_and_fix"
    bigint contract_sum_minor
    numeric retention_pct
    text status
  }
  SubcontractItem {
    uuid subcontract_id PK, FK
    uuid bq_item_id PK, FK
    numeric quantity
    bigint rate_minor
  }
  PieceRateJob {
    uuid id PK
    uuid bq_item_id FK
    uuid labourer_id FK "or gang_id"
    uuid gang_id FK
    text description "plaster per m2"
    text unit_code
    bigint rate_minor
    numeric measured_quantity
    text status "open, measured, approved, paid"
    uuid payroll_line_id FK
  }
```

## 5. Materials, procurement and stores

```mermaid
erDiagram
  Unit ||--o{ UnitConversion : "from"
  Material ||--o{ UnitConversion : "material-specific"
  Material ||--o{ MaterialPrice : "priced"
  Supplier ||--o{ MaterialPrice : "quotes"
  Requisition ||--|{ RequisitionLine : "requests"
  Requisition ||--o| Rfq : "goes to market"
  Rfq ||--o{ Quotation : "receives"
  Quotation ||--|{ QuotationLine : "prices"
  Quotation ||--o| Lpo : "awarded as"
  Supplier ||--o{ Lpo : "receives"
  Lpo ||--|{ LpoLine : "orders"
  Lpo ||--o{ Grn : "delivered via"
  Grn ||--|{ GrnLine : "counts"
  Grn ||--o{ GrnPhoto : "evidenced by"
  Lpo ||--o{ SupplierInvoice : "billed by"
  SupplierInvoice ||--|{ SupplierInvoiceLine : "bills"
  SupplierInvoice ||--o| ThreeWayMatch : "checked by"
  Site ||--o{ Store : "has"
  Store ||--o{ StockLedgerEntry : "moves"
  Material ||--o{ StockLedgerEntry : "of"
  Store ||--o{ StockTake : "counted by"
  StockTake ||--|{ StockTakeLine : "lines"
  Store ||--o{ StockTransfer : "sends"

  Unit {
    text code PK "m3, m2, m, kg, t, No, bag, trip, LS, Item"
    text name_en
    text name_sw
    text dimension "mass, volume, area, length, count, lump"
  }
  UnitConversion {
    uuid id PK
    text from_unit FK
    text to_unit FK
    uuid material_id FK "e.g. sand: 1 trip = N t (configurable)"
    numeric factor
    date effective_from
  }
  Material {
    uuid id PK
    text code
    text name "Cement 42.5N 50kg bag"
    text category "cement, aggregate, steel, timber, blocks, roofing, fuel"
    text base_unit_code FK
    text spec "Y12, gauge 30, 200mm"
    numeric kg_per_unit
  }
  Supplier {
    uuid id PK
    text name
    bytea kra_pin_enc
    text kra_pin_bidx
    text etims_status "registered, unknown, not_registered"
    text mpesa_kind "paybill, till, none"
    text mpesa_shortcode
    text mpesa_account_ref
    bytea bank_details_enc
    int credit_terms_days
    numeric rating
  }
  MaterialPrice {
    uuid id PK
    uuid material_id FK
    uuid supplier_id FK
    text unit_code
    bigint price_minor
    date observed_on
    text source "quote, lpo, invoice"
  }
  Requisition {
    uuid id PK
    uuid site_id FK
    text number
    uuid requested_by
    date needed_by
    text status "draft, submitted, approved, rejected, rfq, ordered, closed"
  }
  RequisitionLine {
    uuid id PK
    uuid requisition_id FK
    uuid material_id FK
    uuid bq_item_id FK
    numeric quantity
    text unit_code
  }
  Rfq {
    uuid id PK
    uuid requisition_id FK
    text number
    int min_quotes "from config"
    text status
  }
  Quotation {
    uuid id PK
    uuid rfq_id FK
    uuid supplier_id FK
    date valid_until
    bigint total_minor
    bool selected
    text selection_reason
    uuid file_id FK
  }
  QuotationLine {
    uuid id PK
    uuid quotation_id FK
    uuid requisition_line_id FK
    bigint unit_price_minor
    numeric quantity
  }
  Lpo {
    uuid id PK
    uuid project_id FK
    uuid supplier_id FK
    uuid quotation_id FK
    text number "LPO-0042"
    bigint total_minor
    bigint vat_minor
    text status "draft, approved, issued, part_delivered, delivered, closed"
  }
  LpoLine {
    uuid id PK
    uuid lpo_id FK
    uuid material_id FK
    numeric quantity
    text unit_code
    bigint unit_price_minor
  }
  Grn {
    uuid id PK
    uuid lpo_id FK
    uuid site_id FK
    text number
    timestamptz received_at
    uuid received_by
    text vehicle_reg
    text delivery_note_no
    numeric lat
    numeric lon
    bool inside_geofence
    uuid device_id FK
  }
  GrnLine {
    uuid id PK
    uuid grn_id FK
    uuid lpo_line_id FK
    numeric quantity_received
    numeric quantity_rejected
    text rejection_reason
  }
  GrnPhoto {
    uuid grn_id PK, FK
    uuid photo_id PK, FK
    text kind "delivery_note, goods, vehicle"
  }
  SupplierInvoice {
    uuid id PK
    uuid supplier_id FK
    uuid lpo_id FK
    text number
    date invoice_date
    text etims_invoice_no "flag if missing"
    bool etims_validated
    bigint total_minor
    bigint vat_minor
    text status "received, matched, blocked, approved, paid"
  }
  SupplierInvoiceLine {
    uuid id PK
    uuid invoice_id FK
    uuid lpo_line_id FK
    numeric quantity
    bigint unit_price_minor
  }
  ThreeWayMatch {
    uuid id PK
    uuid invoice_id FK
    text status "matched, mismatch, overridden"
    jsonb differences "qty and price vs LPO and GRN"
    uuid resolved_by
    text resolution_note
  }
  Store {
    uuid id PK
    uuid site_id FK
    text name
    uuid storekeeper_user_id
  }
  StockLedgerEntry {
    uuid id PK "append-only"
    uuid store_id FK
    uuid material_id FK
    timestamptz occurred_at
    text kind "receipt, issue, return, transfer_in, transfer_out, wastage, adjustment"
    numeric quantity "signed, base unit"
    bigint unit_cost_minor
    text ref_type "grn, issue, transfer, stocktake"
    uuid ref_id
    uuid bq_item_id FK "issues"
    uuid gang_id FK "issues"
    uuid device_id FK
  }
  StockTransfer {
    uuid id PK
    uuid from_store_id FK
    uuid to_store_id FK
    text status "dispatched, received, disputed"
    timestamptz dispatched_at
    timestamptz received_at
  }
  StockTake {
    uuid id PK
    uuid store_id FK
    date counted_on
    text status "draft, submitted, approved"
    uuid approved_by
  }
  StockTakeLine {
    uuid id PK
    uuid stock_take_id FK
    uuid material_id FK
    numeric system_quantity
    numeric counted_quantity
    numeric variance
  }
```

## 6. Labour, attendance and biometrics

```mermaid
erDiagram
  Trade ||--o{ Labourer : "primary trade"
  Labourer ||--o{ Accreditation : "holds"
  Labourer ||--o{ ProjectEngagement : "engaged on"
  Project ||--o{ ProjectEngagement : "engages"
  Project ||--o{ LabourRate : "sets default rates"
  Trade ||--o{ LabourRate : "rate for"
  Project ||--o{ Gang : "organises"
  Gang ||--o{ GangAssignment : "daily roster"
  Labourer ||--o{ GangAssignment : "assigned"
  Labourer ||--o{ Consent : "gives or withdraws"
  Labourer ||--o{ BiometricEnrolment : "enrolled"
  Consent ||--o{ BiometricEnrolment : "authorises"
  BiometricEnrolment ||--o{ BiometricTemplate : "stores"
  Site ||--o{ AttendanceDevice : "registers"
  AttendanceDevice ||--o{ AttendanceEvent : "captures"
  Labourer ||--o{ AttendanceEvent : "checks in or out"
  AttendanceEvent ||--o{ AttendanceAnomaly : "flagged by"
  Labourer ||--o{ Timesheet : "per pay period"
  Timesheet ||--|{ TimesheetLine : "per day"
  Labourer ||--o{ DataSubjectRequest : "exercises rights"
  DpiaRecord ||--o{ BiometricEnrolment : "permits"

  Trade {
    uuid id PK
    text key "mason, carpenter, steel_fixer, kibarua"
    text name_en
    text name_sw
  }
  Labourer {
    uuid id PK
    text worker_no UK
    text full_name
    text id_type "national_id, alien_id, passport"
    bytea id_number_enc
    text id_number_bidx UK "duplicate and ghost-worker check"
    date date_of_birth "registration blocked if under 18"
    text gender
    bytea phone_enc "M-Pesa number"
    text phone_bidx
    uuid photo_file_id FK
    uuid trade_id FK
    text skill_level "skilled, semi_skilled, unskilled"
    text engagement_type "casual, term, piece_rate"
    text rate_basis "hourly, daily, piece"
    bigint default_rate_minor
    bytea next_of_kin_enc
    text home_county
    bytea nssf_no_enc
    bytea sha_no_enc
    bytea kra_pin_enc
    date induction_date
    bool do_not_rehire "managers only"
    bytea do_not_rehire_reason_enc
    text status "active, inactive, left"
  }
  Accreditation {
    uuid id PK
    uuid labourer_id FK
    text kind "nca_skilled, nca_supervisor, welding, working_at_heights"
    text card_no
    date issued_on
    date expires_on "alert before expiry"
    uuid file_id FK
  }
  ProjectEngagement {
    uuid id PK
    uuid project_id FK
    uuid labourer_id FK
    date start_date
    date end_date
    bigint rate_override_minor
    int continuous_days "casual-to-term warning"
  }
  LabourRate {
    uuid id PK
    uuid project_id FK
    uuid trade_id FK
    text skill_level
    text basis
    bigint rate_minor
    date effective_from
    date effective_to
  }
  Gang {
    uuid id PK
    uuid project_id FK
    text name
    uuid foreman_labourer_id FK
  }
  GangAssignment {
    uuid id PK
    uuid gang_id FK
    uuid labourer_id FK
    date work_date
    uuid site_id FK
    uuid bq_item_id FK "activity"
  }
  Consent {
    uuid id PK
    uuid labourer_id FK
    text kind "biometric_face, biometric_fingerprint, data_processing, photo"
    text text_version
    text language "en, sw"
    text method "signed, read_aloud_witnessed"
    bool granted
    timestamptz captured_at
    uuid captured_by
    text witness_name
    timestamptz withdrawn_at
    uuid evidence_file_id FK
  }
  DpiaRecord {
    uuid id PK "biometrics stay off until an approved record exists (D3.4 gate)"
    text processing "biometric_attendance"
    text capture_method "face_kiosk, fingerprint_usb, terminal_push"
    int version
    text status "draft, dpo_reviewed, approved, expired"
    uuid document_id FK "signed DPIA"
    uuid approved_by
    date approved_on
    date review_due
  }
  BiometricEnrolment {
    uuid id PK
    uuid labourer_id FK
    uuid consent_id FK
    uuid dpia_record_id FK
    text modality "face, fingerprint"
    text status "active, revoked, deleted"
    uuid device_id FK
    date delete_after "engagement end + retention period"
  }
  BiometricTemplate {
    uuid id PK
    uuid enrolment_id FK
    bytea template_enc "separate KEK, never raw images"
    text algorithm
    text algorithm_version
    numeric quality_score
    int key_version
  }
  AttendanceDevice {
    uuid id PK
    uuid site_id FK
    uuid device_id FK
    text kind "kiosk_tablet, phone, terminal"
    text serial_no
    jsonb capture_methods "qr_card_photo, face_kiosk"
    text status
  }
  AttendanceEvent {
    uuid id PK "client-generated, append-only"
    uuid site_id FK
    uuid labourer_id FK
    text kind "check_in, check_out"
    text method "qr_card_photo, nfc_card_photo, face_kiosk, fingerprint_usb, terminal_push, manual_override"
    numeric match_confidence
    numeric liveness_score
    uuid attendance_device_id FK
    bigint device_seq
    timestamptz device_time
    bigint elapsed_realtime_ms
    text boot_id
    timestamptz server_received_at
    numeric lat
    numeric lon
    numeric accuracy_m
    bool inside_geofence
    bool mock_location
    uuid photo_id FK
    uuid confirmed_by_user_id
    text override_reason
    bytea signature "Ed25519 by device key"
    uuid supersedes_event_id FK
  }
  AttendanceAnomaly {
    uuid id PK
    uuid event_id FK
    text kind "duplicate, outside_geofence, two_sites, impossible_travel, clock_drift, time_unverified, mock_location, unregistered_device, low_confidence, manual_override, missing_checkout"
    text severity
    jsonb details
    text status "open, accepted, rejected"
    uuid reviewed_by
    text review_note
  }
  Timesheet {
    uuid id PK
    uuid labourer_id FK
    uuid pay_period_id FK
    text status "draft, approved, locked"
  }
  TimesheetLine {
    uuid id PK
    uuid timesheet_id FK
    date work_date
    text day_type "weekday, rest_day, public_holiday"
    text day_status "present, half_day, absent, leave"
    numeric normal_hours
    numeric overtime_hours
    int late_minutes
    jsonb source_event_ids
  }
  DataSubjectRequest {
    uuid id PK
    uuid labourer_id FK
    text kind "access, correction, deletion, objection"
    date received_on
    date due_on
    text status
  }
```

## 7. Payroll and payments

The original draft diagram below is retained for context. Its combined `Payment` and `PaymentProviderRequest` model and status labels are superseded by **§7.1**, [WORKFLOWS.md](./WORKFLOWS.md) and [FINANCIAL_MODEL.md](./FINANCIAL_MODEL.md). Do not implement the draft's one-payment-per-payroll-line assumption or use its flags as independent settlement truth.

```mermaid
erDiagram
  PayPeriod ||--o{ PayrollBatch : "paid in"
  PayrollBatch ||--|{ PayrollLine : "pays"
  PayrollLine ||--|{ PayrollLineItem : "itemised"
  Labourer ||--o{ PayrollLine : "earns"
  Labourer ||--o{ Advance : "receives"
  Advance ||--o{ AdvanceRecovery : "recovered via"
  PayrollLine ||--o{ AdvanceRecovery : "deducts"
  PayrollBatch ||--o{ Approval : "maker-checker"
  PayrollLine ||--o| Payment : "settled by"
  PaymentChannel ||--o{ PaymentProviderRequest : "used by"
  Payment ||--o{ PaymentProviderRequest : "attempted via"
  PaymentProviderRequest ||--o{ PaymentCallback : "answered by"
  PaymentChannel ||--o{ PaymentCallback : "receives"
  PaymentChannel ||--o{ Reconciliation : "reconciled"
  Reconciliation ||--|{ ReconciliationItem : "lines"
  ReconciliationItem }o--o| Payment : "matches"

  PayPeriod {
    uuid id PK
    uuid project_id FK
    text frequency "daily, weekly, fortnightly, monthly"
    date start_date
    date end_date
    text status "open, closed"
  }
  PayrollBatch {
    uuid id PK
    uuid pay_period_id FK
    text number "PR-2026-W45"
    text status "draft, prepared, reviewed, approved, disbursing, completed, partially_failed, cancelled"
    uuid prepared_by
    uuid reviewed_by "must differ from prepared_by"
    uuid approved_by "step-up MFA"
    bigint total_gross_minor
    bigint total_deductions_minor
    bigint total_net_minor
    bigint total_employer_minor
    bigint est_charges_minor
  }
  PayrollLine {
    uuid id PK
    uuid batch_id FK
    uuid labourer_id FK
    numeric days_worked
    numeric normal_hours
    numeric overtime_hours
    bigint gross_minor
    bigint deductions_minor
    bigint net_minor
    jsonb rule_snapshot "rule version ids used"
    text payout_method "mpesa, bank, cash"
    text status "pending, sent, confirmed, failed, reversed"
  }
  PayrollLineItem {
    uuid id PK
    uuid line_id FK
    text kind "basic, overtime, piece_rate, allowance, paye, nssf_ee, shif, ahl_ee, advance_recovery, other, nssf_er, ahl_er, nita"
    bigint amount_minor
    uuid rule_version_id FK
    jsonb basis
  }
  Advance {
    uuid id PK
    uuid labourer_id FK
    uuid project_id FK
    bigint amount_minor
    date issued_on
    jsonb recovery_plan
    bigint outstanding_minor
    text status
    uuid payment_id FK
  }
  AdvanceRecovery {
    uuid advance_id PK, FK
    uuid payroll_line_id PK, FK
    bigint amount_minor
  }
  Approval {
    uuid id PK
    text entity_type "payroll_batch, variation_order, lpo, payment, statutory_rule"
    uuid entity_id
    text step "prepare, review, approve"
    text decision "approved, rejected, returned"
    uuid actor_user_id
    timestamptz step_up_mfa_at
    text action_hash "binds MFA to entity and amount"
    text comment
  }
  PaymentChannel {
    uuid id PK
    text provider "daraja"
    text environment "sandbox, production"
    text purpose "stk, c2b, b2c, b2b"
    text shortcode
    text secret_ref "pointer into secrets manager"
    text callback_token_sha256
    text status
  }
  Payment {
    uuid id PK
    uuid project_id FK
    text direction "in, out"
    text purpose "payroll, supplier, advance, piece_rate, client_instalment, petty_cash_topup, refund"
    text method "mpesa_b2c, mpesa_b2b, mpesa_stk, mpesa_c2b, bank, cash"
    text payee_type
    uuid payee_id
    bigint amount_minor
    bigint charges_minor
    text status "pending, sent, confirmed, failed, reversed"
    text provider_receipt UK "M-Pesa receipt"
    text idempotency_key UK
    text name_check "match, mismatch, n_a"
    uuid evidence_file_id FK "cash and bank"
    text reason "required for cash"
  }
  PaymentProviderRequest {
    uuid id PK
    uuid payment_id FK
    uuid channel_id FK
    text operation "stk_push, stk_query, b2c, b2b, tx_status, balance, reversal, c2b_register"
    text idempotency_key UK
    text originator_conversation_id UK
    text conversation_id
    text checkout_request_id
    text merchant_request_id
    text request_token_sha256 "per-request callback token"
    text state "created, queued, submitted, accepted, succeeded, failed, timed_out, reversed"
    int attempt
    jsonb request_redacted
    jsonb response_redacted
    timestamptz timeout_at
    text result_code
  }
  PaymentCallback {
    uuid id PK "append-only, monthly partitions"
    uuid channel_id FK
    text kind "stk, c2b_validation, c2b_confirmation, b2c_result, b2b_result, status_result, balance_result, reversal_result, timeout"
    timestamptz received_at
    text source_ip
    jsonb raw_redacted
    text match_status "matched, unmatched, duplicate, invalid"
    uuid provider_request_id FK
    timestamptz processed_at
  }
  Reconciliation {
    uuid id PK
    uuid channel_id FK
    date period_start
    date period_end
    text source "statement_upload, api"
    uuid file_id FK
    int matched_count
    int unmatched_count
    int disputed_count
  }
  ReconciliationItem {
    uuid id PK
    uuid reconciliation_id FK
    text statement_receipt
    bigint statement_amount_minor
    timestamptz statement_time
    uuid payment_id FK
    text status "matched, unmatched, disputed"
  }
```

### 7.1 Canonical obligation, attempt, allocation and journal boundaries

Conceptual design for Phase 4; not implemented by foundation migrations.

```mermaid
erDiagram
  PayrollLine ||--o{ PayableObligation : authorises
  ApprovalSnapshot ||--o{ PayableObligation : binds
  PayableObligation ||--o{ PaymentAttempt : attempted
  PaymentChannel ||--o{ PaymentAttempt : routes
  PaymentAttempt ||--o{ ProviderTransaction : reconciles
  ProviderTransaction ||--o{ SettlementAllocation : allocates
  PayableObligation ||--o{ SettlementAllocation : settled
  SettlementAllocation ||--o{ JournalEntry : posts
  JournalEntry ||--|{ JournalLine : balances
  JournalAccount ||--o{ JournalLine : classifies
  PaymentAttempt ||--o{ CallbackInbox : receives
  PaymentAttempt ||--o{ OutboxEvent : schedules
  IdempotencyRecord }o--o| PaymentAttempt : identifies

  ApprovalSnapshot {
    uuid id PK
    int entity_version
    text content_digest
    jsonb protected_snapshot "amounts, recipients, allocations, rates and rules"
    uuid preparer_id
    uuid reviewer_id
    uuid approver_id
  }
  PayableObligation {
    uuid id PK
    uuid approval_snapshot_id FK
    uuid project_id FK
    bigint authorised_minor
    text currency "KES"
    uuid correction_of_id FK
  }
  PaymentAttempt {
    uuid id PK
    uuid obligation_id FK
    uuid channel_id FK
    bigint reserved_minor
    text state "created, queued, submitting, pending, unknown, confirmed, failed, reversal_pending, reversed"
    text request_fingerprint
    uuid reversal_of_id FK
  }
  ProviderTransaction {
    uuid id PK
    uuid attempt_id FK
    text receipt "unique per tenant and provider account"
    bigint amount_minor
    text currency
    text direction
    text verification_evidence_ref
  }
  SettlementAllocation {
    uuid id PK
    uuid obligation_id FK
    uuid provider_transaction_id FK
    bigint amount_minor
    uuid reversal_of_id FK
  }
  JournalEntry {
    uuid id PK
    text source_posting_key UK
    date posting_date
    uuid reversal_of_id FK
  }
  JournalLine {
    uuid id PK
    uuid entry_id FK
    uuid account_id FK
    uuid project_id FK
    uuid cost_code_id FK
    bigint debit_minor
    bigint credit_minor
  }
  JournalAccount {
    uuid id PK
    text code "unique per tenant"
    text kind
  }
  CallbackInbox {
    uuid id PK
    uuid attempt_id FK
    text event_fingerprint
    timestamptz received_at
    text protected_payload_ref
  }
  IdempotencyRecord {
    uuid id PK
    text operation
    text key "unique per tenant and operation"
    text request_fingerprint
    timestamptz retain_until
  }
  OutboxEvent {
    uuid id PK
    uuid attempt_id FK
    text event_type
    int schema_version
  }
```

Every tenant-owned relation uses tenant-consistent foreign keys and runtime-role RLS. Settlement/reservation transactions lock the obligation; total allocations cannot exceed authorised outstanding. Each journal balances exactly, remains immutable and retains project/cost-code lineage. Inbox intake is durable before callback acknowledgement; queue processing state lives separately from append-only evidence. Unknown attempts retain reservations and require reconciliation before a new payout.

## 8. Finance: costs, budgets, petty cash and cash flow

```mermaid
erDiagram
  Project ||--o{ Budget : "budgeted by"
  Budget ||--|{ BudgetLine : "lines"
  CostCode ||--o{ BudgetLine : "classifies"
  Project ||--o{ CostEntry : "incurs"
  CostCode ||--o{ CostEntry : "classifies"
  Payment ||--o{ CostEntry : "evidences"
  Project ||--o{ Commitment : "committed"
  Site ||--o{ PettyCashFloat : "holds"
  PettyCashFloat ||--o{ Expense : "spent from"
  PettyCashFloat ||--o{ PettyCashTopUp : "replenished by"
  PettyCashFloat ||--o{ PettyCashCount : "reconciled by"

  CostCode {
    uuid id PK
    text code
    text name
    text category "materials, labour, plant, subcontract, preliminaries, fees, permits, transport, petty_cash, mpesa_charges"
  }
  Budget {
    uuid id PK
    uuid project_id FK
    int version
    text status "draft, approved"
  }
  BudgetLine {
    uuid id PK
    uuid budget_id FK
    uuid bq_bill_id FK
    uuid bq_item_id FK
    uuid cost_code_id FK
    bigint amount_minor
  }
  CostEntry {
    uuid id PK "append-only"
    uuid project_id FK
    uuid site_id FK
    date occurred_on
    text category
    uuid cost_code_id FK
    uuid bq_item_id FK
    uuid supplier_id FK
    uuid labourer_id FK
    bigint amount_minor
    text source_type "payroll_line, supplier_invoice, expense, plant_usage, mpesa_charge"
    uuid source_id
    uuid payment_id FK
    uuid reverses_entry_id FK
  }
  Commitment {
    uuid id PK
    uuid project_id FK
    text source_type "lpo, subcontract"
    uuid source_id
    bigint amount_minor
    bigint remaining_minor
  }
  PettyCashFloat {
    uuid id PK
    uuid site_id FK
    uuid custodian_user_id
    bigint limit_minor
    bigint balance_minor
  }
  Expense {
    uuid id PK
    uuid float_id FK
    uuid project_id FK
    date spent_on
    text category
    bigint amount_minor
    text description
    uuid receipt_file_id FK "required"
    text mpesa_ref "auto-filled by SMS parser"
    bool parsed_from_sms
    text status "submitted, approved, rejected"
  }
  PettyCashTopUp {
    uuid id PK
    uuid float_id FK
    bigint amount_minor
    uuid payment_id FK
  }
  PettyCashCount {
    uuid id PK
    uuid float_id FK
    date counted_on
    bigint expected_minor
    bigint counted_minor
    bigint variance_minor
  }
```

> **Cash-flow forecast** is a read model (`cash_flow_forecast_v`), not a table. It combines upcoming payroll (open pay periods × rates), approved LPOs not yet paid (`Commitment`), issued payment certificates not yet paid, and client instalment schedules.

## 9. Site operations: diary, photos, quality, H&S, plant

```mermaid
erDiagram
  Site ||--o{ SiteDiary : "daily"
  SiteDiary ||--o{ DiaryLine : "records"
  Site ||--o{ Photo : "evidence"
  Photo }o--o| BqItem : "tagged to"
  Project ||--o{ Inspection : "inspected"
  ChecklistTemplate ||--o{ Inspection : "uses"
  Inspection ||--o{ InspectionResult : "items"
  Project ||--o{ TestResult : "tests"
  Project ||--o{ Snag : "defects"
  Site ||--o{ SafetyIncident : "reports"
  SafetyIncident ||--o{ CorrectiveAction : "requires"
  Site ||--o{ ToolboxTalk : "holds"
  ToolboxTalk ||--o{ ToolboxTalkAttendance : "attended by"
  Labourer ||--o{ InductionRecord : "inducted"
  Labourer ||--o{ PpeIssue : "issued"
  Plant ||--o{ PlantUsage : "used"
  Plant ||--o{ FuelIssue : "fuelled"
  Plant ||--o{ PlantMaintenance : "maintained"

  SiteDiary {
    uuid id PK
    uuid site_id FK
    date diary_date UK "one per site per day"
    jsonb weather
    jsonb workforce_by_trade "auto-filled from attendance"
    text status "draft, submitted, approved, locked"
    uuid submitted_by
    uuid approved_by
    bytea signature
  }
  DiaryLine {
    uuid id PK
    uuid diary_id FK
    text kind "work_done, material_received, material_used, plant, visitor, instruction, delay, incident"
    text ref_type
    uuid ref_id
    text description
    numeric quantity
    text unit_code
  }
  Photo {
    uuid id PK
    uuid file_id FK
    uuid site_id FK
    uuid bq_item_id FK
    timestamptz device_time
    timestamptz exif_time
    timestamptz server_received_at
    numeric lat
    numeric lon
    bool inside_geofence
    bool verified "server-verified badge"
    jsonb verification_reasons
    text sha256
    text location_label "Block A, 2nd floor"
    uuid device_id FK
  }
  ChecklistTemplate {
    uuid id PK
    text name "setting out, foundation, slab, roofing"
    jsonb items
  }
  Inspection {
    uuid id PK
    uuid project_id FK
    uuid template_id FK
    text kind "internal, county, consultant"
    date inspected_on
    text result "pass, fail, conditional"
    uuid signed_off_by
  }
  InspectionResult {
    uuid id PK
    uuid inspection_id FK
    text item_key
    text result
    uuid photo_id FK
  }
  TestResult {
    uuid id PK
    uuid project_id FK
    text kind "cube_7d, cube_28d, slump"
    text sample_ref
    uuid bq_item_id FK
    date cast_on
    date tested_on
    numeric value
    numeric spec_min
    bool pass
    uuid file_id FK
  }
  Snag {
    uuid id PK
    uuid project_id FK
    text location
    text description
    uuid assigned_to
    date due_date
    text status "open, fixed, verified, closed"
  }
  SafetyIncident {
    uuid id PK
    uuid site_id FK
    timestamptz occurred_at
    text kind "incident, near_miss, first_aid"
    text severity
    text description
    bool wiba_reportable "COMPLIANCE-REVIEW"
    text status
  }
  CorrectiveAction {
    uuid id PK
    uuid incident_id FK
    text description
    uuid owner_user_id
    date due_date
    text status
  }
  ToolboxTalk {
    uuid id PK
    uuid site_id FK
    date held_on
    text topic
    uuid conducted_by
  }
  ToolboxTalkAttendance {
    uuid talk_id PK, FK
    uuid labourer_id PK, FK
  }
  InductionRecord {
    uuid id PK
    uuid labourer_id FK
    uuid site_id FK
    date inducted_on
    uuid inducted_by
  }
  PpeIssue {
    uuid id PK
    uuid labourer_id FK
    text item "helmet, boots, vest, gloves, harness, goggles"
    date issued_on
    int quantity
    date returned_on
  }
  Plant {
    uuid id PK
    text code
    text name "concrete mixer, poker vibrator, excavator"
    text ownership "owned, hired"
    uuid supplier_id FK "hire company"
    bigint hire_rate_minor
    text hire_rate_basis "hour, day, week, month"
    text status
  }
  PlantUsage {
    uuid id PK
    uuid plant_id FK
    uuid site_id FK
    date used_on
    numeric hours
    uuid operator_labourer_id FK
    uuid bq_item_id FK
  }
  FuelIssue {
    uuid id PK
    uuid plant_id FK
    uuid site_id FK
    date issued_on
    numeric litres
    bigint unit_cost_minor
    numeric meter_reading
    uuid stock_ledger_entry_id FK
  }
  PlantMaintenance {
    uuid id PK
    uuid plant_id FK
    text kind "breakdown, service, repair"
    timestamptz start_at
    timestamptz end_at
    bigint cost_minor
  }
```

## 10. Documents, compliance, notifications and platform plumbing

```mermaid
erDiagram
  Project ||--o{ Document : "stores"
  Document ||--|{ DocumentVersion : "versions"
  File ||--o{ DocumentVersion : "content"
  Project ||--o{ ComplianceItem : "registers"
  Document ||--o{ ComplianceItem : "evidences"
  NotificationTemplate ||--o{ Notification : "renders"
  User ||--o{ NotificationPreference : "sets"
  User ||--o{ Notification : "receives"
  Project ||--o{ Alert : "raises"
  Consultant ||--o{ Instruction : "issues"
  Subcontractor ||--o{ Subcontract : "holds"
  Supplier ||--o{ SupplierUser : "portal users"
  User ||--o{ SupplierUser : "acts for"
  Device ||--o| DeviceSyncState : "sync cursor"

  File {
    uuid id PK
    text bucket
    text object_key
    text content_type "sniffed from magic bytes"
    bigint size_bytes
    text sha256
    text status "quarantine, clean, infected, rejected"
    jsonb exif
    uuid uploaded_by
  }
  Document {
    uuid id PK
    uuid project_id FK
    text category "drawing, contract, bq, permit, certificate, insurance, other"
    text title
    uuid current_version_id FK
  }
  DocumentVersion {
    uuid id PK
    uuid document_id FK
    int version_no
    uuid file_id FK
    text notes
  }
  ComplianceItem {
    uuid id PK
    uuid project_id FK "null = company-level"
    text kind "county_approval, nca_project_registration, nca_contractor_registration, nca_levy, nema_licence, car_insurance, wiba_insurance, osh_registration, site_signboard"
    text reference_no
    date issued_on
    date expires_on
    uuid document_id FK
    jsonb reminder_days "e.g. 60, 30, 7"
    text status "valid, expiring, expired, missing"
  }
  NotificationTemplate {
    uuid id PK
    text event_key "payment.sent, approval.pending, stock.low"
    text channel "sms, whatsapp, email, push"
    text locale "en, sw"
    int version
    text body_icu
    text whatsapp_template_name
  }
  Notification {
    uuid id PK
    uuid recipient_user_id FK
    bytea recipient_phone_enc "labourers without accounts"
    text channel
    text event_key
    uuid template_id FK
    jsonb payload
    text status "queued, sent, delivered, failed"
    text provider_message_id
    int attempts
  }
  NotificationPreference {
    uuid user_id PK, FK
    text event_key PK
    text channel PK
    bool enabled
  }
  Alert {
    uuid id PK
    uuid project_id FK
    text kind "budget_threshold, unusual_spend, duplicate_payment, missing_documents, material_variance, low_stock, attendance_anomaly, accreditation_expiry, document_expiry, casual_conversion, unusual_payout, unmatched_callback, price_change, name_mismatch"
    text severity "info, warning, critical"
    text ref_type
    uuid ref_id
    jsonb details
    text status "open, acknowledged, resolved"
    uuid assigned_to
  }
  Consultant {
    uuid id PK
    text name
    text discipline "architect, structural, qs, services"
    text firm
    text email
  }
  Subcontractor {
    uuid id PK
    text name
    bytea kra_pin_enc
    text nca_category
    text mpesa_kind
    text mpesa_shortcode
    bytea bank_details_enc
  }
  SupplierUser {
    uuid supplier_id PK, FK
    uuid user_id PK, FK
  }
  OutboxEvent {
    uuid id PK
    text aggregate_type
    uuid aggregate_id
    text event_type
    jsonb payload
    timestamptz published_at
    int attempts
  }
  IdempotencyRecord {
    text key PK
    uuid user_id
    text request_sha256
    int status_code
    jsonb response
    timestamptz expires_at
  }
  SyncChange {
    bigint seq PK "per tenant change log"
    uuid site_id FK
    text entity_type
    uuid entity_id
    text op "upsert, delete"
    timestamptz changed_at
  }
  DeviceSyncState {
    uuid device_id PK, FK
    bigint last_pull_seq
    timestamptz last_push_at
    timestamptz anchor_server_time
    bigint anchor_elapsed_ms
    text anchor_boot_id
  }
```

---

## Coverage: brief §10 entities → model

| Brief entity | Modelled as | Brief entity | Modelled as |
|---|---|---|---|
| Tenant | `Tenant` (+ `Subscription`) | Store | `Store` |
| User | `User`, `Credential`, `MfaFactor`, `Session`, `RefreshToken` | StockLedgerEntry | `StockLedgerEntry` (append-only) |
| Role / Permission | `Role`, `Permission`, `RolePermission`, `MembershipRole` | StockTake | `StockTake`, `StockTakeLine` |
| ProjectMembership | `ProjectMembership` | Labourer | `Labourer`, `ProjectEngagement` |
| Project / Site / Geofence | `Project`, `Site`, `Geofence`, `Client` | Trade / SkillLevel | `Trade`, `Labourer.skill_level` enum |
| Phase/WBS / Milestone | `WbsNode`, `Milestone` | Accreditation | `Accreditation` |
| ScheduleActivity | `ScheduleActivity`, `ActivityDependency`, `ScheduleBaseline`, `DelayEvent` | Gang / GangAssignment | `Gang`, `GangAssignment` |
| BQ / BQVersion | `Bq`, `BqVersion`, `BqImportJob`, `BqMappingTemplate` | BiometricEnrolment | `BiometricEnrolment`, `BiometricTemplate` |
| BQBill / BQSection / BQItem | `BqBill`, `BqSection`, `BqItem` | Consent | `Consent` |
| RateBuildUp | `RateBuildUp`, `RateBuildUpComponent` | AttendanceDevice / AttendanceEvent | `AttendanceDevice`, `AttendanceEvent`, `AttendanceAnomaly` |
| VariationOrder / Instruction | `VariationOrder`, `VariationLine`, `Instruction`, `Consultant` | Timesheet | `Timesheet`, `TimesheetLine` |
| ProgressMeasurement | `ProgressMeasurement` | OvertimeRule / PublicHoliday | `OvertimeRule`, `PublicHoliday` |
| Valuation / PaymentCertificate | `Valuation`, `ValuationLine`, `PaymentCertificate` | PayPeriod / PayrollBatch / PayrollLine | `PayPeriod`, `PayrollBatch`, `PayrollLine`, `PayrollLineItem`, `Approval` |
| Retention | `RetentionEntry` | StatutoryRule | `StatutoryRule`, `StatutoryRuleBand`, `EngagementDeductionRule` |
| Material / Unit / UnitConversion | `Material`, `Unit`, `UnitConversion`, `MaterialPrice` | Advance | `Advance`, `AdvanceRecovery` |
| Supplier | `Supplier`, `SupplierUser` | PieceRateJob / Subcontract | `PieceRateJob`, `Subcontract`, `SubcontractItem`, `Subcontractor` |
| Requisition / RFQ / Quotation | `Requisition`, `Rfq`, `Quotation` (+ lines) | Payment / PaymentProviderRequest / PaymentCallback | `Payment`, `PaymentChannel`, `PaymentProviderRequest`, `PaymentCallback` |
| LPO | `Lpo`, `LpoLine` | Reconciliation | `Reconciliation`, `ReconciliationItem` |
| GoodsReceivedNote | `Grn`, `GrnLine`, `GrnPhoto` | Expense / PettyCashFloat | `Expense`, `PettyCashFloat`, `PettyCashTopUp`, `PettyCashCount`, `CostEntry`, `Budget`, `Commitment` |
| SupplierInvoice | `SupplierInvoice`, `SupplierInvoiceLine`, `ThreeWayMatch` | SiteDiary / Photo | `SiteDiary`, `DiaryLine`, `Photo` |
| Inspection / Snag | `Inspection`, `ChecklistTemplate`, `InspectionResult`, `TestResult`, `Snag` | Document / ComplianceItem | `Document`, `DocumentVersion`, `File`, `ComplianceItem` |
| SafetyIncident / ToolboxTalk / PPEIssue | `SafetyIncident`, `CorrectiveAction`, `ToolboxTalk`, `InductionRecord`, `PpeIssue` | Plant / PlantUsage / FuelIssue | `Plant`, `PlantUsage`, `FuelIssue`, `PlantMaintenance` |
| Notification | `Notification`, `NotificationTemplate`, `NotificationPreference`, `Alert` | AuditLog | `AuditLog` (hash-chained, append-only) |

**Added beyond the brief:**
- `Client`, `Consultant` and `Subcontractor` as parties.
- `ConfigRule`, `EngagementDeductionRule`, `MpesaTariff` and `FxRate` for configurability.
- `OutboxEvent`, `IdempotencyRecord`, `SyncChange` and `DeviceSyncState` for reliability and offline sync.
- `DataSubjectRequest` for Data Protection Act rights, and `DpiaRecord` for the biometric go-live gate.
- `Alert` as one inbox for anomalies and thresholds.
