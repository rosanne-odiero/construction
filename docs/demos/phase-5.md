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

---

## D5.2: Procure-to-pay

This walkthrough takes about 25 minutes. **Procurement** in the sidebar is live: the approvals inbox, requisitions, RFQs with the quotation comparison, LPOs, deliveries (GRNs), supplier invoices with eTIMS, the three-way match screen and payments recorded outside PM-Buddy. Stores and Spending are still Phase 5 "soon" pages.

### 1. Run it

Same prerequisites and commands as D5.1 (§1 above), on the branch with the D5.2 web screens. `db:migrate` now includes `20261115100000_procure_to_pay`, and `db:seed` prints the procure-to-pay chain it created on RUI-HTS (synthetic values; the eTIMS numbers are made up):

```text
Procure-to-pay (synthetic, created): REQ-0001 → RFQ-0001 → LPO-0001 → GRN-0001
  invoice MQ-INV-1001 — settled
  invoice MQ-INV-1002 — disputed
```

| Record | What the seed did, and who |
|---|---|
| REQ-0001 | 14 t river sand and 20 t ballast, raised by the **site agent** (Kevin Kiprono), approved by the **project manager** (Brian Otieno) |
| RFQ-0001 | Three quotations (quarry, steel, hardware suppliers), all prices excluding VAT; the quarry is lowest on both lines |
| LPO-0001 | Awarded to Mlolongo Quarry; approved by the project manager (KES 100,000 net) |
| GRN-0001 | Two 7 t lorry trips of sand and 10 t of ballast, recorded by the site agent |
| MQ-INV-1001 | Sand 14 t + ballast 10 t, recorded by **finance** (Daniel Mwangi), matched, approved by the **owner** (Wanjiru Kamau), paid by finance (bank transfer `DEMO-FT-0001`, KES 90,480) |
| MQ-INV-1002 | Another 10 t of ballast that has **not been delivered**: the three-way match blocks it |

Steps that need a step-up (LPO approval, invoice exception and approval, recording a payment) ask for an authenticator code. The owner and finance accounts have TOTP; the project manager must first set up an authenticator to approve LPOs (**Live foundation** → *Set up authenticator MFA*, as in the [Phase 1 demo](./phase-1.md)), or let the owner approve LPOs prepared by someone else.

### 2. The inbox and the blocked invoice (owner)

1. **Procurement** → *Waiting for you* lists **MQ-INV-1002** as "Blocked invoice: an exception may be decided" (only what you may act on and did not prepare). *By stage* counts records per state; *Committed cost by project* shows RUI-HTS: committed KES 100,000, accrued KES 78,000, still open KES 22,000, paid KES 90,480.
2. Open **MQ-INV-1002**: the **three-way match** screen. Ballast: ordered 20, received 10, billed before 10, billed now 10 → **Fail** "More is billed (with earlier invoices) than was accepted on site". The invoice checks (arithmetic, VAT, LPO total, eTIMS number) pass, the totals are stated vs computed, and **Approve for payment** is disabled: "Approval is blocked while the three-way match does not pass". Finance cannot approve it either: they recorded it (maker-checker note).

### 3. A delivery on a phone (site agent, 360 px)

1. Sign in as the site agent on a phone (or a 360 px browser window). **Procurement → Record a delivery**: pick **LPO-0001**; each line shows what was ordered and already received.
2. Ballast: count **10** t (try a rejected quantity: a reason becomes required). Vehicle `kbz 234c` → "Kenyan plate KBZ 234C" (a foreign plate is kept and flagged). **Use my position** shows the accuracy; inside or outside the site geofence is shown after saving and never blocks the delivery. Add a photo of the delivery note and of the goods.
3. **Record the delivery**: GRN-0002 with the geofence result and plate flag; photos upload after the GRN is saved. Pressing the button twice (or retrying after a lost connection) replays the same GRN instead of creating a second one.

### 4. Rematch, approve and pay (owner, then finance)

1. As the owner, reopen **MQ-INV-1002**: "Out of date: deliveries were recorded or voided" → **Run the match again** → **Matched**.
2. **Approve for payment** shows the bound payee (the quarry's *verified* payout details, M-Pesa Paybill 600000, account JENGA-BORA, version 1) and the amount (KES 25,520); confirm with the authenticator code. The owner is now told someone else must record the payment.
3. Sign in as **finance**: *Payments* shows "Outstanding KES 25,520 of KES 25,520". An amount above the outstanding is refused; record a bank transfer with a reference (e.g. `DEMO-FT-0002`) and the authenticator code → **Paid in full**. Using the same reference again is refused.
4. Payee change: as the owner propose new payout details for the quarry (Suppliers, D5.1) while another approved invoice is unpaid: that invoice shows "re-approval needed" and payments are refused until it is approved again against the newly verified details.

### 5. A new purchase from the start

1. **Site agent:** **New requisition** on RUI-HTS (materials from the catalogue in any convertible unit, optional BQ item, needed-by date), save and **Submit**. The agent cannot approve it.
2. **Project manager:** the requisition appears in *Waiting for you*; **Approve** (or **Reject** with a reason, which the agent can **Reopen**).
3. **Owner:** **RFQs → New RFQ** from the approved requisition, invite the three suppliers, then **Record quotation** for each (price per line, unit, VAT treatment, delivery days, validity, a PDF or photo). The **comparison** is net of VAT per base unit; the lowest price per line and the lowest complete total are highlighted; incomplete or expired quotations are marked. With fewer than three complete quotations, **Award** is refused: **Request a single-source exception** with a reason; someone else with approval rights (the project manager) approves it.
4. **Award** the chosen quotation → a draft **LPO**; check the delivery site, date and terms, **Submit**. The **project manager** approves it with the authenticator code (the owner who prepared it cannot). **Printable LPO** opens a print-friendly page with the supplier's masked KRA PIN and eTIMS status.
5. Continue with a delivery (§3), then as **finance** **Record an invoice** against the LPO: the eTIMS number is format-checked as you type and a missing number is flagged; the totals preview shows exactly what the match will compute. **Submit** runs the match.

### 6. Settings (owner)

**Materials → Price alerts → Procurement settings** (also linked from the Procurement page; `config.manage`): minimum quotes (default 3), quantity and price tolerance (default 0 %) and "block payment without an eTIMS number" (default on). Changing a tolerance or the eTIMS rule makes every current match out of date: invoices must be matched again before approval. Users without `config.manage` see the values read-only.

### 7. What is not here yet

GRN capture in the offline site app (the API contract is ready, ARCHITECTURE §12.2; the web form works on a phone online only); paying suppliers through M-Pesa B2B or a bank API from PM-Buddy (payments are recorded, not sent: D4.2/D4.3); approval limits by amount; a hold period before the first payment to new payout details (OR-05); credit notes and returns; stores (D5.3).

### 8. Automated checks

```bash
npx pnpm@12.17.0 --filter @pm-buddy/domain test      # match, pricing and state-machine tests
cd apps/api && npx vitest run --config ./vitest.config.e2e.ts test/procure-to-pay.e2e-spec.ts
cd apps/web && npx playwright test test/procure-to-pay.spec.ts
```

---

## D5.3: Stores

This walkthrough takes about 20 minutes. **Stores** in the sidebar is live: stores per site with their stock value, the stock ledger, issues to a BQ item or gang, returns, wastage, transfers between sites, stock takes with independent approval, reorder levels and **consumption variance alerts**. Every figure below is synthetic.

### 1. Run it

Same prerequisites and commands as D5.1 (§1 above), on branch `phase-5/d5.3-stores`. `db:migrate` now includes `20261118090000_stores` (it also receives any GRNs already recorded on the database into their site's store), and `db:seed` adds a **storekeeper** account (Grace Wambui, `storekeeper@jenga-bora.example.test`, password printed like the others) and prints:

```text
Stores (synthetic, created): Bungalow plot store, Main plot store
  RTN-0001, ISS-0001, WST-0001; transfers TRF-0001 (disputed), TRF-0002 (dispatched); stock take STK-0001 (submitted)
  consumption variance alerts: 1; low-stock items: 2
```

| Record | What the seed did, and who |
|---|---|
| GRN-0002 (cement) | A second purchase on RUI-HTS (REQ-0002 → RFQ-0002 → LPO-0002) delivers 120 bags of cement at KES 790 a bag (net of VAT) into the **Main plot store**; GRN-0001's sand and ballast went in the same way |
| BQ baseline | Items A (column bases, 24 m³) and B (ground floor slab, 36 m³) linked to the **CONC-C25-SYN** build-up, whose cement, sand and ballast lines are mapped to catalogue materials; approved by the project manager |
| Measurement | The project manager measured **12.5 m³** of item A to date |
| ISS-0001 | The storekeeper issued 110 bags of cement, 9 t of sand and 8 t of ballast to item A and the concrete gang |
| RTN-0001, WST-0001 | 5 bags came back; 2 bags were damaged (wastage with a reason) |
| Reorder levels | Cement 20 bags, sand 1 t, ballast 5 t: cement (13 left) and ballast (2 t) are **low** |
| TRF-0001, TRF-0002 | 2 t of sand sent to the **Bungalow plot store** (KIT-BNG) and 1.8 t received: **disputed** (spillage); 1 t more is **in transit** |
| STK-0001 | The storekeeper counted cement (12 against 13 on the books) and ballast, and submitted it for approval |

The cement alert, worked by hand: 12.5 m³ × 6.5 bags per m³ × 1.05 (5 % waste) = **85.3125 bags** theoretical; actual = 110 issued − 5 returned = **105 bags**; 105 > 85.3125 × 1.10 = 93.84 (10 % threshold) → **+19.69 bags, 23.1 % over**. Sand (9 t against 9.625 t) and ballast (8 t against 18.375 t) are within.

### 2. Stores home and a store (owner or storekeeper)

1. **Stores**: total stock value, low-stock items, transfers in transit and "1 variance alert"; each store's value, materials, low and in-transit counts. *Low stock* lists cement (13 bags, reorder at 20) and ballast. Sites without a store can get one (**Create store**); a store is also created automatically when a site receives its first delivery.
2. Open **Main plot store**: on-hand balances with average cost and value (cement 13 bags at KES 790 = KES 10,270), the reorder level, stock in transit to the Bungalow plot store, recent issues, returns and wastage. **Stock ledger** shows every entry in the base unit with its value, running balance and source (GRN, issue, return, wastage, transfer, stock take); filter by material or kind.

### 3. Variance alerts (owner or project manager)

1. **Stores → Consumption variance**: the note says these are estimates for review, not proof of theft. The alert row for item A shows every input: measured 12.5 m³ and its date, 6.5 bags per m³, 5 % waste, theoretical 85.3125 (limit 93.84375), issued 110, returned 5, actual 105, variance 19.6875 (23.1 %).
2. Item B has no measurement: its rows say **Unavailable: not measured** (never zero). **Record measurement** (needs `bq.edit`) adds one; the rows become estimates.
3. Open the build-up from a row (or **BQ and variations → Rate build-ups → CONC-C25-SYN**): *Materials for stores* shows each material line's mapping (for example "Cement 42.5N (50 kg bag): 1 bag (50 kg) = 1 bag (50 kg)"). **Remove mapping** on a line and the variance report shows it as "Build-up line not mapped"; map it again.
4. **Stores → Settings** (`config.manage`): the variance threshold (default 10 %). At 25 % the cement row is within the threshold. The page also states the fixed policies: negative stock is never allowed, and stock is valued at weighted average cost.

### 4. Issue, return and wastage on a phone (storekeeper, 360 px)

1. Sign in as the storekeeper on a phone (or a 360 px window). **Main plot store → Issue**: find a BQ item, choose a gang, who took it, and a quantity in the base unit. More than is on hand is stopped on the form and refused by the API; there is no override.
2. After recording, open the issue: **Record a return** allows at most what is still outstanding per line. **Reverse** (with a reason) posts reversing entries; nothing is edited.
3. **Record wastage** needs a reason (damaged, expired, spilled, weather, theft suspected, other) and what happened.

### 5. Transfers and the stock take (storekeeper, then project manager)

1. **Transfers → TRF-0001**: sent 2 t, received 1.8 t with the reason, **Lost in transit** valued at the dispatch cost. The storekeeper cannot resolve it; the **project manager** (who neither sent nor received it) **Resolves** it with a note. TRF-0002 is still in transit; the Bungalow plot store can **Receive** it (a different quantity needs a reason).
2. **Stock takes → STK-0001**: the count sheet shows the system quantity at the start, the movements since, the system quantity when counted, the count and the variance (cement −1 bag, about −KES 790). The storekeeper sees that someone else approves it. Sign in as the **project manager** → **Approve**: the variance is posted to the ledger as an adjustment. Counting does not freeze the store: an issue made while counting is not mistaken for a loss.

### 6. What is not here yet

Stores in the offline site app (the API contract is offline-ready: client IDs and `Idempotency-Key`, ARCHITECTURE §12.2); per-material variance thresholds; days-of-cover low-stock alerts; notifications for alerts; earned value and certificates (D6.3 extends the measurement); an authorised negative-stock override (deliberately not offered, D-45). Stock valuation (weighted average cost) is waiting for accountant review (COMPLIANCE_TODO CR-STK-01).

### 7. Automated checks

```bash
npx pnpm@12.17.0 --filter @pm-buddy/domain test      # valuation, consumption and variance tests
cd apps/api && npx vitest run --config ./vitest.config.e2e.ts test/stores.e2e-spec.ts
cd apps/web && npx playwright test test/stores.spec.ts
```
