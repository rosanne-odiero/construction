# Phase 0 demo: design pack and clickable prototype (D0)

This walkthrough takes about 15 minutes. Everything runs locally with **mock data only**: nothing is saved, sent or charged.

## 1. Run it

Prerequisites: Node 24 and pnpm 12. On networks where Corepack can't download pnpm, prefix commands with `npx pnpm@12.17.0`.

```bash
git checkout phase-0/design-pack
npx pnpm@12.17.0 install
npx pnpm@12.17.0 dev          # starts apps/web on http://localhost:3000
```

Open **http://localhost:3000**. The tour page links to every screen. Use the **EN / SW** switch (top right) and the **theme** button on any page.

## 2. Walkthrough

| # | Screen | URL | Try this |
|---|---|---|---|
| 1 | Prototype tour | `/` | Read "What to look for", then **Start at sign-in**. |
| 2 | Sign-in and MFA | `/sign-in` | Switch to **Phone** and type `0712 345 678`; it is normalised to `254712345678`. Click **Continue**, type any six digits, then **Verify**. Try **Use a passkey** and **Send a code by SMS**. |
| 3 | Owner dashboard | `/dashboard` | Check KPIs, CPI/SPI (red when behind), alerts (click one), spend and cash-flow charts, and the sites map. Press **⌘K / Ctrl+K** and search for "Wekesa". |
| 4 | Project overview | `/projects/ruiru-heights` | S-curve (planned vs actual), budget vs earned vs actual by bill, milestones, the 120 m **geofence** on the map, recent activity. |
| 5 | Bill of Quantities | `/projects/ruiru-heights/bq` | Expand and collapse bills; search "Y12"; compare original vs revised contract sum; read the summary with VAT, versions and variation orders. |
| 6 | BQ import | `/projects/ruiru-heights/bq/import` | Step through all five steps. On **Map columns**, change a mapping. On **Validate**, see the row-23 typo (947,400 vs 974,400) and choose a resolution. |
| 7 | Labour | `/labour` | Try saved views (**Expiring accreditation**, **Card + photo only**, **Near casual limit**). Select rows to see the bulk bar. Open a worker and press **Reveal** (audited). Open **Register worker**: DOB 2009 is blocked as under 18, and the phone is normalised. |
| 8 | Attendance | `/attendance` | Filter the muster roll by gang. On the **Anomalies** tab, accept one, then try to reject without a note (blocked). |
| 9 | Payroll and M-Pesa | `/payroll` | Review the checks, click **Approve and pay**, enter six digits and watch the payouts: 39 confirmed with receipts, 1 failed, 1 name mismatch held for review. |
| 10 | Client portal | `/portal` | Use a phone-sized window (DevTools device toolbar). Switch KES/GBP/USD/EUR. Approve or reject VO-002 (rejecting needs a comment). **Pay with M-Pesa**: try KES 1,245,600 (over the per-transaction limit), then 250,000, and see the confirmation. |
| 11 | Site app mock-ups | `/site` | Kiosk face check-in (bilingual prompts), the foreman's offline muster roll and the sync and clock-integrity screen. |
| 12 | Coming soon | e.g. `/soon/materials` | Every unbuilt module says which phase delivers it. |

## 3. What is real and what is mock

| Real (carried into Phase 1) | Mock (replaced as features land) |
|---|---|
| Design tokens (royal blue on neutral, light and dark), shadcn/ui components, layout patterns | All data in `apps/web/src/mocks` |
| EN/SW catalogues (`apps/web/messages` in D0, now `packages/i18n/src/messages`), locale switching, KES / `DD/MM/YYYY` / Africa/Nairobi formatting | Sign-in, MFA, passkeys, SMS |
| BQ totals computed from quantity × rate, so the totals reconcile | Payroll deductions (**illustrative only**; the real engine comes in D4.1, `COMPLIANCE-REVIEW`) |
| Phone normalisation and the under-18 registration check | M-Pesa STK and B2C behaviour, receipts and callbacks |
| | Map tiles (OpenStreetMap, development only) |

## 4. Checks run for this deliverable

- `tsc --noEmit`, `eslint` and `next build`: all pass.
- EN/SW catalogue parity (`pnpm --filter @pm-buddy/i18n i18n:check`; `pnpm --filter @pm-buddy/web i18n:check` in D0): identical keys, the same placeholders, and every ICU message compiles in both languages.
- All 14 routes loaded fresh in English and Kiswahili with **0 console errors or warnings**.
- The OpenAPI outline passes Redocly lint with 0 errors.

## 5. How to give feedback

Reply with the **screen number and what to change**, or **"approved"**. Feedback is fixed on the `phase-0/design-pack` branch before D1.1 starts.
