# Phase 7 demo: client, supplier and labourer self-service

This walkthrough is **not** full Phase 7 acceptance: client STK Push remains unavailable. It
covers the client (D7.1), supplier (D7.2) and labourer (D7.3) flows. Real messaging and USSD require
provider provisioning and operator approval; the checks below use local/fake transports.

## Labourer self-service (D7.3)

1. Apply migrations and regenerate/build packages. As a labour manager, register a worker with
   their unique Kenyan phone, ID and project engagement. Invite that same phone to the project;
   in development the invitation is in Mailpit, not on a handset. Follow the invitation link to
   choose a six-digit PIN. Shared/duplicate registry phone numbers show no worker records.
2. Record, submit and independently confirm attendance. In `/worker`, the worker sees only their
   entries for the current Nairobi month and their assigned projects. Pending rows are labelled,
   not counted; a date counts at most one day (two half-day entries make one). These status-based
   totals do not replace payroll's rule-based payable time.
3. Prepare and **submit** payroll. The worker sees only their latest 12 submitted entries, gross,
   deductions and net; drafts/cancelled batches are absent. Disbursed advance balances subtract
   submitted recoveries, not draft reservations. No row is labelled paid: payroll payment
   confirmations are explicitly unavailable until D4.3.
4. In **Notifications**, opt in to SMS or WhatsApp, choose EN/SW and save. Reload: preferences
   persist. Request a reminder: development Mailpit receives a wage-free message. Opt-out
   disables the button and API. A disabled/rejecting provider shows an explicit error, never a
   sent confirmation; successful submission means provider acceptance, not handset delivery.
   **Notification history** persists the latest 50 own attempts in the selected company; refresh
   or reload to see accepted, unconfirmed and skipped attempts.
   For automatic local alerts, use `AUTH_NOTIFICATION_TRANSPORT=development` and
   `WORKER_NOTIFICATION_DISPATCHER=on`, restart the API, then confirm **new** attendance,
   submit/cancel payroll or disburse an advance after opting in. Within a normal 30-second
   cycle, each opted-in channel gets one wage-free Mailpit reminder and one history row.
   Existing historical events are not replayed. A disabled/rejecting provider records
   unconfirmed acceptance, not delivery; uncertain attempts are never retried automatically.
5. To simulate USSD locally, configure paired `USSD_CALLBACK_TOKEN` and `USSD_SERVICE_CODE`
   (see [configuration](../CONFIGURATION.md#8-process-environment-deployment-settings)), then
   POST form data to `/api/v1/ussd` with `X-USSD-Token` in a trusted **server-side** tool. Send the
   same `sessionId`, registered `phoneNumber` and configured `serviceCode` for each step, with
   cumulative `text`: empty → `1` (English; `2` for Kiswahili) → `1*<ID>` →
   `1*<ID>*<PIN>` → `1*<ID>*<PIN>*1` (company) → `1*<ID>*<PIN>*1*2` (latest submitted net).
   The last response starts `END`, includes the submitted net shown in the portal and says it is
   **not payment**. Dial again for confirmed days, payments-unavailable or outstanding advances.
   Never paste real PINs/tokens into a shared shell history or enable request-body logging.
6. Wrong gateway header: 403. Wrong phone/ID/PIN, skipped/replayed steps, a revoked session or
   expiry: no wage data. An altered company membership or project assignment is rechecked on
   data reads. Sessions end after a result and expire after three minutes.

Automated evidence: `apps/api/test/portals.e2e-spec.ts` (runtime-role reads, RLS preferences and
the EN/SW callback); `apps/api/test/payroll.e2e-spec.ts` (actual submitted payroll → worker portal
→ USSD net); provider/unit tests use fake HTTP responses; `apps/web/test/portals.spec.ts` uses the
mock API, including Kiswahili at 360 px, no horizontal scroll and axe checks.

Not demonstrated: real handset delivery or USSD gateway latency/ingress setup, delivery receipts,
monetary/SMS-segment spending budgets, staff/client/supplier notifications or payroll settlement.
No live provider send or pilot activation is authorised by these local tests.

## Client portal (D7.1)

A client (the developer or homeowner the company builds for) follows progress on the projects they
are assigned to, sees what the contractor certified and what was received, how to pay, and approves
or rejects the variations sent to them. **Pay with M-Pesa (STK Push) is not available yet**: it waits
for the Daraja integration (D4.2), so the done-when's "pay (sandbox)" is open; the client pays by the
Paybill instructions and finance records the receipt. Foreign currencies are indicative only
(COMPLIANCE_TODO CR-CLI-01).

### Start

As for the supplier portal below (`pnpm db:migrate`, `pnpm db:seed`). The seed prints the **client
portal user** (Joseph Kariuki, Mavuno Homes, synthetic; assigned to Ruiru Heights, RUI-HTS, display
currency GBP) with its password, and the owner, finance and project manager accounts (with TOTP
secrets). It gives RUI-HTS certified certificates, one **part payment** recorded against IPC-0001,
verified and unverified site photos, approved diaries, the company's Paybill (the Safaricom sandbox
shortcode 174379, synthetic), USD/GBP/EUR rates (synthetic) and variation VO-001 **sent to the client
and awaiting a decision**; the project requires the client's approval before staff approve a
variation.

### Review

1. **Client, on a phone (360 px).** Sign in with the client account: you land on `/portal` (never the
   office). Each project shows what is outstanding and overdue in KES with "≈ GBP … (indicative)",
   milestones and "1 variation awaits your decision".
2. **Overview and progress.** Open the project: *Work done* (earned value ÷ BQ value, with the BQ
   version and date), *Planned by now* (or "not available" without a baseline), ahead/behind, the
   certificates summary and the next amount due. *Progress* shows the S-curve (planned vs earned,
   no costs) with a weekly table.
3. **Photos and site updates.** *Photos*: newest first; each says **Location and time verified** or
   **Not verified** with the reason (for example "No GPS position in the photo"), when it was taken
   (and how the time is known) and received; *What "verified" means* explains the limits. No
   incident photos, locations or uploaders. *Site updates*: approved diaries with the workforce by
   trade (counts only).
4. **Statement.** Certificates with amount due, VAT, total, certified and due dates, received and
   outstanding (**Part paid**, or **Overdue by N days**), each with its PDF; the payments recorded
   and any reversal with its reason; the running balance; *Statement (PDF/Excel)* in EN or SW.
5. **Pay.** The Paybill number, account name and the steps; per certificate the **account number**
   to type (for example `RUI-HTS-0001`). *Pay with M-Pesa* is disabled: "Pay with M-Pesa will be
   available soon; use the Paybill instructions above."
6. **Variations.** Open VO-001: the instruction, priced lines (added, omitted, changed), the net
   change, VAT and the contract sum before and after. *Reject* without a comment is refused;
   *Approve* records the decision once (the page shows who decided and when).
7. **Display currency.** *Display currency* (from the home page): choose USD; amounts now show
   "≈ USD … at 129.45 KES/USD on … (indicative)". Documents stay in KES. Switch to **SW**: every page
   reads in Kiswahili without sideways scrolling.
8. **Finance (desktop).** *Valuations → Ruiru Heights → Client payments*: the certified certificates
   with their Paybill references, the receipts recorded, the client terms. **Record a payment**
   (certificate, amount up to what is outstanding, date, method, reference); **Reverse** one with a
   reason — the client sees both on their statement.
9. **Owner and project manager.** As the owner, open VO-001 (*Projects → Ruiru Heights → BQ →
   Variations*): the **Client approval** panel shows the sending (by the project manager, who raised
   the variation) and, after step 6, the client's decision. Before the client approved, *Approve* was
   not offered and the page said the client must approve it first. As the project manager, *Send to
   client* is offered on any other submitted variation.
10. **Owner.** *Valuations → Client portal settings*: the Paybill instructions (changing them needs a
   fresh MFA check and makes a new version) and the FX rates (*Add rate*).

### What to look for

- The client never sees another project (any other address is "not found"), the company's costs,
  budgets, rate build-ups, workers' names, incident photos or staff notes.
- Nothing is "paid" unless finance recorded it; nothing in the portal moves money.
- A variation decision applies to exactly the figures shown; a changed variation must be sent again.

## Supplier portal (D7.2)

The supplier portal covers a supplier's contact, invited by the contractor, who sees the orders
(LPOs) addressed to their supplier, what was delivered, submits an invoice with its KRA eTIMS number
and PDF, and follows it through review to payment, with a statement. Paying suppliers through M-Pesa
B2B or a bank (D4.x) is not part of it: the portal only shows payments the contractor **recorded**.
eTIMS numbers are format-checked, never verified with KRA (COMPLIANCE_TODO CR-SUP-01).

### Start

Use the existing local services and API/web servers, or the root README quick start. Apply the
forward migration and seed the synthetic company:

```bash
pnpm --filter @pm-buddy/api db:generate
pnpm db:migrate
pnpm db:seed
```

The seed prints the synthetic accounts and their generated passwords, including the **supplier
portal user** (Achieng Otieno (synthetic), bound to Mlolongo Quarry, SUP-0001) and the owner and
finance accounts (with TOTP secrets). Use separate browser profiles for the supplier and for staff.
The seed gives the supplier, on Kitengela Bungalows (KIT-BNG), an acknowledged LPO with a delivery
(one load rejected), one invoice **approved and partly paid** and one **waiting for review**.

### Review

1. **Supplier, on a phone (360 px).** Sign in with the supplier account. You land on `/supplier`
   (never the office): the outstanding amount, open orders, deliveries, invoices under review and
   awaiting payment, and the note that payment status is what the company recorded.
2. **Orders.** Open *Orders*, then the LPO: lines with quantities, prices, VAT, the delivery site and
   date, credit terms, and per line what was received, invoiced, under review and still left to
   invoice. An order not yet acknowledged shows *Acknowledge this order* (it does not change the
   order). Cancelled orders are marked "do not deliver".
3. **Deliveries.** What the site recorded as received, rejected and why, with the delivery-note
   number and vehicle. No internal notes, photos, GPS or names of the receiver.
4. **Submit an invoice.** From the LPO, *Submit an invoice*: your invoice number and date, the
   eTIMS number as printed (try `not etims!` — refused; `KRACU0400000078/2301` — accepted), the
   lines (pre-filled with what was delivered and not yet invoiced), the totals as printed and the
   PDF. Submit. The invoice opens as **Under review** (or **Disputed** with the reasons if it does
   not match the order and deliveries). Submitting again with the same number is refused.
5. **Staff, as finance or the owner.** *Procurement → Invoices*: the invoice is in the queue with
   **Submitted by the supplier** (filter *Source*). Open it: the three-way match, and a note that a
   supplier invoice cannot be reopened — cancel it with a reason to ask for a corrected one. Approve
   it as usual (independent approver, step-up) and record a partial settlement.
6. **Supplier again.** The invoice shows **Partly paid** with the payment (amount, date, method,
   reference). *Statement*: opening balance, invoices, payments, closing balance; change the period
   or the project; download the PDF or Excel (EN or SW).
7. **Staff manage access.** On the supplier's page (*Suppliers → Mlolongo Quarry*), the **Supplier
   portal users** card lists the contact. *Invite a contact* (email or Kenyan mobile; needs a fresh
   MFA check) sends a link to `/supplier/join`. *Revoke access* with a reason: the supplier's next
   page load says access has ended.
8. Switch to **SW** and the dark theme at 360 px: every supplier page stays readable without
   sideways scrolling.

### What to look for

- The supplier never sees another supplier's orders, prices or invoices, the company's BQ, budgets,
  labour, requisitions or quotations, or the names of the company's staff.
- The supplier cannot approve, settle, cancel or change an invoice after submitting it.
- "Paid" is always "recorded by the company"; PM-Buddy does not move money to suppliers.
- The LPO page (staff) shows whether and when the supplier acknowledged it.
