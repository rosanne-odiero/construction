# Phase 7 demo: supplier portal (D7.2)

This walkthrough is **not** Phase 7 acceptance. It covers the supplier portal (D7.2): a supplier's
contact, invited by the contractor, sees the orders (LPOs) addressed to their supplier, what was
delivered, submits an invoice with its KRA eTIMS number and PDF, and follows it through review to
payment, with a statement. The client portal (D7.1) and labourer USSD (D7.3) are separate. Paying
suppliers through M-Pesa B2B or a bank (D4.x) is not part of it: the portal only shows payments the
contractor **recorded**. eTIMS numbers are format-checked, never verified with KRA (COMPLIANCE_TODO
CR-SUP-01).

## Start

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

## Review

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

## What to look for

- The supplier never sees another supplier's orders, prices or invoices, the company's BQ, budgets,
  labour, requisitions or quotations, or the names of the company's staff.
- The supplier cannot approve, settle, cancel or change an invoice after submitting it.
- "Paid" is always "recorded by the company"; PM-Buddy does not move money to suppliers.
- The LPO page (staff) shows whether and when the supplier acknowledged it.
