# Phase 5 demo: materials, procurement and stores

Phase 5 has several deliverables (D5.1 onwards). Each gets its own section here as it lands.

> **Safeguard integration:** a demo is not acceptance. Read [implementation status](../IMPLEMENTATION_STATUS.md) for the commands actually run and their results. Everything below uses synthetic data on a local machine; no pilot, live payments or real supplier data.

---

## D5.1: Catalogue and suppliers

This walkthrough takes about 15 minutes. **Materials** and **Suppliers** in the sidebar now show live data: the materials catalogue with Kenyan units, conversions and price history, the unit calculator, and supplier profiles with masked identifiers and verified payout details.

### 1. Run it

Prerequisites: Node 24, pnpm 12 and Docker Desktop (running). Commands use `npx pnpm@12.17.0` because `pnpm` may not be on your PATH.

```bash
git checkout phase-5/d5.1-catalogue-suppliers
npx pnpm@12.17.0 install
npx pnpm@12.17.0 services:up     # PostgreSQL, Valkey, RustFS and Mailpit
npx pnpm@12.17.0 db:migrate      # includes 20261115090000_procurement_catalogue
npx pnpm@12.17.0 db:seed         # synthetic company; prints accounts, materials and suppliers
npx pnpm@12.17.0 dev             # API on :4000, web on :3000
```

`apps/api/.env` needs, besides `AUTH_MFA_ENCRYPTION_KEY`, the field-encryption keys `FIELD_ENCRYPTION_KEYS` and `FIELD_BLIND_INDEX_KEY` (the API refuses to start without them). Generate local values with the two `node -e …` commands in `apps/api/.env.example`, keep the file private (`chmod 600`), and never reuse local keys anywhere else. Losing a key makes the values written with it unreadable: re-seed a fresh database in that case.

The seed adds a **finance** account (Daniel Mwangi, `finance@jenga-bora.example.test`, password and TOTP printed like the owner's), the 21-material Kenyan starter catalogue, and three synthetic suppliers:

| Supplier | What to look at |
|---|---|
| SUP-0001 Mlolongo Quarry (synthetic) | M-Pesa Paybill 600000, account JENGA-BORA, **verified** by the finance user (call-back); its own lorry-trip factors for river sand (7 t) and ballast (10 t) |
| SUP-0002 Athi River Steel (synthetic) | Till 174379 and an Equity Bank account, **awaiting verification** (proposed by the owner); cement prices 780 → 800 → 900 per bag, the last one **above the 10 % alert** |
| SUP-0003 Kitengela Hardware (synthetic) | **On hold** with a reason; no payout details |

KRA PINs are synthetic (`P000000001Z`, `P000000002Z`); the contact phone is the Safaricom Daraja sandbox test number.

### 2. Catalogue (sign in as the owner)

1. **Materials** → the catalogue: search (`steel`), filter by category, see each material's latest price and alert count. **Add material** shows category-specific attributes (bar diameter Y8–Y32, roofing gauge and cover width, timber section, mesh sizes). **Load Kenyan starter catalogue** is idempotent.
2. Open **MAT-0003 Steel bar Y12**: *Standard conversions* lists 1 m = 0.888889 kg (d²/162) and 1 piece = 12 m.
3. Open **MAT-0001 Cement 42.5N**: the price chart (net per bag by supplier) and the history: +2.5641 % *within threshold*, then +12.5 % *above threshold* (prices compare on the exact net of 16 % VAT). **Record price** previews net and gross before saving; **Correct** adds a new row with a reason; nothing is ever edited.
4. Open **MAT-0002 River sand**: the quarry's factor *1 lorry trip = 7 tonne*. **Add conversion** → 1 lorry trip = 10 tonne for the quarry: the 7 t factor ends today and stays in history. Try 1 tonne = 990 kg: refused, because tonnes and kilograms already convert exactly.
5. **Unit calculator**: 2 lorry trips → tonne without a material is **refused** (a trip has no universal size); with river sand and the quarry it is exactly 14 t; 10 pieces of Y12 → 106.666667 kg (rounded half-up to six places, marked *rounded*), with the steps shown.
6. **Units**: add a company unit, e.g. `debe` = 20 litres. **Price alerts**: the alerts list and the threshold (owner: change it to 5 %).

### 3. Suppliers and payout verification

1. **Suppliers** → list with masked KRA PINs, eTIMS status (as recorded; not checked with KRA), payout state and terms.
2. **Add supplier** with a KRA PIN such as `p 000000003 z` (normalised to `P000000003Z`) and a contact mobile `0708 374 149`: the profile shows `P•••••••03Z` and `2547•••••149`; **Reveal** shows the full value (each reveal is audited; 20 per 10 minutes). Adding a second supplier with the same PIN is refused.
3. On the new supplier, **Add payout details** (Paybill 400200, account KTY-001): confirm with your authenticator code. The details are *awaiting verification* and *not usable for payment*, and the owner is told someone else must verify them.
4. Sign out and sign in as **finance** (Daniel Mwangi): open the supplier, **Verify**, choose *Call-back to a known number*, describe the check, confirm with the authenticator code: *Usable for payment*. Finance can also reveal the Athi River Steel bank account number (the owner sees it masked unless they hold `finance.view_sensitive`; the seeded owner does).
5. Change a contact's mobile number while a proposal is pending: the proposal shows a warning and the person who changed it can no longer verify it.

### 4. What is not here yet

Supplier balances, statements and ratings (with supplier invoices, D5.2); quotations and invoices writing prices; payment to verified details with a hold period (D5.2/D4.3); SMS/email/in-app alert delivery (Phase 8). The field cipher lives in `apps/api/src/modules/labour` (shared with D3.1) and moves to a shared module after D3.1 merges.

### 5. Automated checks

```bash
npx pnpm@12.17.0 --filter @pm-buddy/domain test      # conversion and price tests
cd apps/api && npx vitest run --config ./vitest.config.e2e.ts test/procurement.e2e-spec.ts
cd apps/web && npx playwright test test/procurement.spec.ts
```
