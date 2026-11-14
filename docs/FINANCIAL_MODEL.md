# PM-Buddy: Financial model

**Design proposal; posting examples require a QS/accounting review before implementation or live use.** Scope is construction cost, payroll, payable/receivable settlement and reconciliation, not a general accounting suite.

## Records and dimensions

Separate payable obligations, immutable approval snapshots, payment attempts, provider transactions, settlement allocations and balanced journal entries/lines. Every tenant has its own accounts. Lines carry project, applicable site and BQ/cost-code dimensions and a unique business-source/posting-purpose reference.

Committed cost is an approved outstanding procurement commitment. Incurred cost is recognised work/material/service expense or accrual. Cash paid is settled cash outflow. These are separate measures; paying an invoice clears a payable, not another expense.

## Proposed posting examples (KES)

Amounts below are synthetic calculation fixtures, not statutory rates.

| Event | Debit | Credit | Control |
|---|---|---|---|
| Approved supplier invoice 10,000 | Materials/cost or inventory 10,000 | Supplier payable 10,000 | Recognition/stock valuation reviewed; remove corresponding commitment |
| First partial settlement 4,000 | Supplier payable 4,000 | Provider cash/clearing 4,000 | Outstanding becomes 6,000; incurred cost unchanged |
| Remaining settlement 6,000 | Supplier payable 6,000 | Provider cash/clearing 6,000 | Outstanding zero; no further allocation |
| Payroll approved, gross 5,000; authorised deductions 500 | Labour cost 5,000 | Worker payable 4,500 + deduction liabilities 500 | Actual deductions require reviewed rules, not this example |
| Worker payout 4,500 plus fee 20 | Worker payable 4,500 + payment fees 20 | Provider cash/clearing 4,520 | Fee linked separately to provider evidence |
| Issued certificate 20,000; retained 1,000 | Client receivable 19,000 + retention receivable 1,000 | Certified work control 20,000 | Accountant determines revenue recognition independently of certification |
| Advance to worker 1,000 | Worker advance receivable 1,000 | Cash/clearing 1,000 | Future approved recovery reduces receivable, not gross earnings |
| Confirmed reversal of a 4,000 supplier payout | Cash/clearing 4,000 | Supplier payable 4,000 | Linked compensating entry; original settlement retained |

Provider confirmation may first post to a clearing account, with statement reconciliation moving between clearing and the tenant's cash account. Never credit both cash and clearing for the same outflow. Uncertain attempts hold reservations but do not assert settlement.

## Precision and rounding proposal

- Settlement/journal values: integer KES cents; never JavaScript floating-point money.
- Quantities and unit rates: decimal arithmetic, proposed scale 6; validate bounds and reject excess precision unless an explicit import rounding policy applies.
- Proposed monetary rounding: decimal half-up to cents per line; document total is the sum of rounded lines. Retention/tax/advance calculations must define their own reviewed bases and rounding order.
- Record any provider/document rounding discrepancy in an explicit rounding account with configured tolerance and approval; do not silently change approved obligation amounts.
- Foreign exchange displays retain the display rate/source/time and never rewrite the KES journal.
- As implemented for the BQ (D2.2/D2.3, [ARCHITECTURE §4.2–4.3](./ARCHITECTURE.md#43-bq-versions-variations-and-rate-build-ups-d23)): item amount = quantity × rate rounded half-up once per line; a variation line's delta = new rounded amount − base rounded amount; additions/omissions/net are sums of deltas; VAT is rounded once on the version subtotal at the base version's snapshotted rate. A rate build-up line = quantity × (1 + waste % / 100) × unit cost, rounded half-up once per line; the build-up rate is the sum of the rounded lines (`bq.buildup.rounding`).

These are proposed accounting policies, not approved defaults for production.

## Subcontract certificates — rule KE-SUB-1 (D6.3 part B, as implemented)

[ARCHITECTURE §4.16](./ARCHITECTURE.md#416-subcontracts-and-piece-rate-jobs-d63-part-b), decisions D-144–D-148. KES minor units, net of VAT, rounded half away from zero once per figure (`packages/domain` `computeSubcontractCertificate`, repeated by the database CHECK `subcontract_certificates_check`):

| Figure | Rule |
|---|---|
| Work done W | Σ lines: quantity to date × the subcontract's own rate (a lump-sum share: lump sum × % to date ÷ share). Quantities are claims allocated from **approved D6.3 measurement**; per BQ item all subcontracts together never claim more than was measured |
| Retention R | min(round(W × retention %), round(original value × limit %)); after the practical release R − round(R × release %); after final 0 |
| Advance recovery V | min(round(W × recovery %), advances paid on or before the certificate date) — outstanding (paid − V) is never negative |
| Amount due D | W − R − V − Σ amounts due already certified (may be negative: it corrects the last certificate) |
| VAT | round(D × VAT % × VATable work ÷ W), VATable = standard-rated lines (CR-SCN-02) |
| Withholding tax | round(D × WHT %), shown separately, default 0 until configured (CR-SCN-01) |
| Payable | D + VAT − WHT |

Golden figures (synthetic; seed, e2e and domain tests): plastering 450 m² @ 280 = 126,000.00, retention 5 % limited to 5 % (6,300.00), advance 20,000.00 paid and recovered at 20 %, WHT 3 %, no VAT; at 200 m²: W 56,000.00, R 2,800.00, V 11,200.00, D 42,000.00, WHT 1,260.00, payable 40,740.00; the practical release then pays 1,400.00 (WHT 42.00, payable 1,358.00). Windows 36 m² @ 8,200, standard-rated at 16 %, retention 10 % limited to 5 %: at 12 m² W 98,400.00, R 9,840.00, D 88,560.00, VAT 14,169.60, payable 102,729.60.

**Cost postings (D-145, D-53, database triggers, each once):**

| Event | Cost ledger entry | Control |
|---|---|---|
| Certificate certified | `accrued`, category `subcontract`, per line on its BQ item: value to date − previous (source `subcontract_certificate`) | Unique per certificate and line; a retention release posts nothing (work accrued gross) |
| Payment recorded against it (outside PM-Buddy) | `paid`, `subcontract`: the cost part of the cash, `settlement_cost_minor(due, payable, paid before, amount)` (cumulative half-up; the parts add up to D) | Unique per payment; never above payable − paid; never by the certifier |
| Advance recorded as paid | `paid`, `subcontract`, no BQ item: the advance (source `subcontract_advance`) | Unique per advance; recovered by later certificates |
| Subcontractor's tax invoice matched | **Nothing** (the certificate is the accrual) | Its number can never also be a D5.2 supplier invoice of the same supplier |
| Correction | A D5.4 reversal journal of the entry, approved by another person | The original entry is never changed |

Committed (D-146) = approved and active subcontracts' value in force − certified work, per line and BQ item; it is reported apart from actual (accrued) and paid, so no shilling is counted twice. An accounting reviewer must still approve these policies and the withholding-tax and VAT treatment before live use (COMPLIANCE_TODO CR-SCN-01–05).

## Allocations, corrections and period closure

- Positive settlement allocations lock the obligation and cannot exceed its authorised outstanding balance after reservations/confirmed allocations.
- Overpayments become unapplied funds/refund cases, not negative outstanding balances or silent extra expense. Partial receipts remain visible.
- Retentions, advances, recovery, refunds and credit notes have separate linked obligations/accounts; certificate calculations exclude previously certified materials when incorporated into measured work.
- Opening balances require source evidence, a balanced opening journal and independent approval.
- Closing a period freezes postings, rule/rate/BQ/conversion snapshots and reconciliation evidence. Corrections post linked reversals/adjustments into an open period, retaining the original effective period for reporting.
- Successful lines of a partly failed payroll remain settled. Only definitively unpaid balances are eligible for another separately identified attempt.

## Reconciliation and review gate

Provider transaction identity is unique per tenant/provider account and expected direction. Match provider identifiers, amount and currency, then allocate against an obligation; SMS, screenshots and manual references are draft evidence only.

Unmatched, duplicate, disputed and unknown items carry an owner, age, supporting evidence and append-only resolution history. Resolvers cannot approve their own financial adjustments. After restore, pause payouts and reconcile outcomes since the restored point before resuming.

Golden cases required: partial/full payments, fee separation, duplicate callback, reversal, overpayment/refund, advance recovery, retained materials incorporation, closed-period correction and line/document rounding. A named accounting reviewer must approve expected figures and posting policy.
