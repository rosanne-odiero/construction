# PM-Buddy: Open Questions

Questions for you, grouped by topic. Each one has the **default I'll use if there's no answer**, so work never stalls, and the **deliverable that needs it**. Answer inline (or in chat) and I'll record the decision here and in the [ARCHITECTURE decision log](./ARCHITECTURE.md).

Defaults are design assumptions only, not owner approval. Under [brief §15](./PROJECT_BRIEF.md#15-mandatory-safeguards-pm-buddy-additions), later-phase implementation, pilot scope/delivery-order changes, live payouts, biometric collection and production legal rules need explicit approval. D1.1–D1.4 implementation is approved; evidence/acceptance is tracked separately.

> **Most urgent (for D0 approval):** Q-R1–Q-R3. **Needed before D1.x:** Q-A1, Q-A3, Q-H2, Q-U4, Q-U5, Q-E1, Q-E2.

## Review of this deliverable (D0)

| ID | Question | Default if no answer | Needed by |
|---|---|---|---|
| Q-R1 | Do you approve the **look and feel** in the prototype (royal blue on neutral, density, layout, mobile screens)? What would you change? | Keep it as is | D1.2 |
| Q-R2 | Do you approve the **delivery plan** ([ROADMAP](./ROADMAP.md)): 32 deliverables, review gates, branches per deliverable? | Preserve existing roadmap; changes await explicit review | D1.1 |
| Q-R3 | Do you approve the decisions marked **Proposed** in ARCHITECTURE §22 (D-03, D-07, D-08, D-10, D-12–D-15, D-17)? | Keep proposed decisions unapproved; do not infer acceptance | Relevant implementation gate |

## Product and scope

| ID | Question | Default if no answer | Needed by |
|---|---|---|---|
| Q-P1 | Who are the **first customers**: contractor size, number of sites, workers per site? | Mid-size contractors: 2–5 sites, up to 200 workers | D1.4 (seed data, performance targets) |
| Q-P2 | How will tenants **pay for PM-Buddy** (per project, per active worker, per site, flat)? | Model a `Subscription` only; billing UI later | D1.4 |
| Q-P3 | Do you approve the [one-contractor/one-site pilot proposal](./PILOT_PLAN.md): manual/QR attendance, reviewed payroll, one payout method and reconciliation, with later biometrics/USSD/rails/analytics? | Answered: owner approved design and proposed delivery order only; activation/evidence gates remain | Before live pilot activation |
| Q-P4 | Should PM-Buddy integrate with **accounting software** (QuickBooks, Xero, Sage, Odoo)? | CSV/Excel exports only; integration later | D5.4 |
| Q-P5 | Should diaspora clients pay by **card or international transfer** (for example Pesapal, Flutterwave, Stripe) as well as M-Pesa and bank? | M-Pesa STK, C2B Paybill and recorded bank transfers only | D7.1 |
| Q-P6 | Do **suppliers** need their own logins at launch, or are emailed/SMS links enough? | Logins in D7.2 | D7.2 |

## Sign-in and identity

| ID | Question | Default if no answer | Needed by |
|---|---|---|---|
| Q-A1 | Do you have (or will you open) an **Africa's Talking** account with an SMS sender ID, and a **WhatsApp Business** account? | Africa's Talking sandbox in dev; WhatsApp later | D1.3 |
| Q-A2 | Should **passkeys** be the preferred MFA for approvers (they resist phishing), with TOTP as the fallback? | Yes | D1.3 |
| Q-A3 | Is building auth on **vetted libraries inside the API** (D-03) acceptable, or do you prefer an **external identity provider** (Keycloak, Microsoft Entra External ID, Auth0)? | Built-in on vetted libraries | D1.3 |

## Biometrics and attendance

| ID | Question | Default if no answer | Needed by |
|---|---|---|---|
| Q-B1 | Which **biometric method first** in D3.4: face recognition on a kiosk tablet, a USB fingerprint scanner, or ZKTeco-style terminals? Do you already own hardware? Is on-device matching against the site's roster (D-17) acceptable? | Face on an Android kiosk tablet with on-device matching | D3.4 |
| Q-B2 | What is the **budget for a commercial face/liveness SDK** (per-device licence) vs an open-source model? | Short spike in D3.4 comparing 2 vendors and 1 open-source option | D3.4 |
| Q-B3 | Will tenants appoint a **DPO** (or adviser) to sign off DPIAs? | Each tenant names one before enabling biometrics | D3.4 |

## Site devices

| ID | Question | Default if no answer | Needed by |
|---|---|---|---|
| Q-S1 | What **phones and tablets** do site teams use (Android version, RAM), and how good is connectivity? | Android 10+, 3 GB RAM, patchy 3G/4G | D3.2 |
| Q-S2 | Are you willing to use **MDM / Android Enterprise** (dedicated-device mode) to lock kiosk tablets? | Yes: Android Enterprise dedicated devices | D3.2 |
| Q-S3 | Worker cards: printed **QR** only, or **NFC** cards too? | QR first; NFC optional | D3.3 |

## Money and M-Pesa

| ID | Question | Default if no answer | Needed by |
|---|---|---|---|
| Q-M1 | Will each tenant use **its own Safaricom shortcodes and Daraja credentials** (brief §5.7), or should PM-Buddy hold shortcodes for tenants? The second option may need a payments licence or registration (CR-PMT-04). | Each tenant uses its own shortcodes | D4.2 |
| Q-M2 | Can you share the **M-Pesa limits and tariffs** that apply to your accounts, to seed the configuration? | Placeholder values marked DEMO | D4.2 |
| Q-M3 | Should **cash wage payments** be allowed at all, and with what cap? | Allowed with photo/signature, reason, approval and a configurable cap | D4.3 |
| Q-M4 | Are **bank payouts** (for example PesaLink) needed at launch, or is recording bank transfers enough? | Record-only | D4.3 |

## Payroll and compliance

| ID | Question | Default if no answer | Needed by |
|---|---|---|---|
| Q-C1 | Who will **confirm the COMPLIANCE_TODO items** (tax/payroll adviser, employment lawyer, data protection adviser)? | Items stay unverified and disabled for production calculations | Before relevant production feature |
| Q-C2 | What do you **deduct for casual workers (vibarua)** today? | Nothing assumed; the adviser decides (CR-PAY-07) | D4.1 |
| Q-C3 | What **overtime policy** and normal working hours do your sites use? | Demo values (8 h day; 1.5× / 2.0×) until confirmed | D3.3 |
| Q-C4 | What are your **pay periods, pay day and cut-off times** (for example weekly, Friday afternoon, timesheets locked Thursday 18:00)? | Weekly, Friday payout, Thursday cut-off | D4.1 |

## Hosting and data protection

| ID | Question | Default if no answer | Needed by |
|---|---|---|---|
| Q-H1 | **Data residency**: host in Kenya (local data centre or colocation), or a regional hyperscaler with documented safeguards? (CR-DP-05) | Decide before production data; stay cloud-agnostic until then | Before the first pilot |
| Q-H2 | Is your company (the PM-Buddy operator) **registered with the ODPC**, and is a **DPO** appointed? | Registration done before real personal data | D1.4 |
| Q-H3 | Are **RPO ≤ 15 min / RTO ≤ 4 h** (brief) right for launch? | Yes | D9.3 |

## Design and language

| ID | Question | Default if no answer | Needed by |
|---|---|---|---|
| Q-U1 | Do you have a **native Kiswahili reviewer** for UI strings and consent text? The prototype strings are good first drafts. | We keep a glossary and flag strings for review | D1.2 |
| Q-U2 | Which **Kiswahili terms** do sites actually use? For example "kibarua" vs "mfanyakazi wa muda", "fundi mwashi", "BQ". | Terms used in the prototype | D1.2 |
| Q-U3 | Should **client and supplier portals** stay in the same web app (route groups) or use their own subdomains? | Same app, route groups | D7.1 |
| Q-U4 | Do you have a **logo or wordmark**? | Placeholder hard-hat icon | D1.2 |
| Q-U5 | What **domain name** will PM-Buddy use? It's needed for email/SMS sender IDs, cookies and passkeys. | `pm-buddy.example` placeholder | D1.3 |

## Technology choices with cost or vendor impact

| ID | Question | Default if no answer | Needed by |
|---|---|---|---|
| Q-T1 | **Email provider**: Amazon SES, Postmark, SendGrid, or your SMTP? | SMTP (Mailpit in dev); provider chosen with the cloud | D1.3 |
| Q-T2 | Is **Sentry (SaaS)** acceptable for error tracking? Personal data is scrubbed, but events leave Kenya. Self-hosting is the alternative. | Sentry SaaS with strict scrubbing | D1.1 |
| Q-T3 | **FX rate source** for the diaspora display (for example a Central Bank of Kenya reference rate, or a commercial API) | Commercial API, cached hourly, labelled "indicative" | D7.1 |
| Q-T4 | **Map tiles in production**: MapTiler, Mapbox, Google, or self-hosted? OpenStreetMap's tile policy doesn't allow heavy production use. | MapTiler free tier, then paid | D2.1 |

## Engineering process

| ID | Question | Default if no answer | Needed by |
|---|---|---|---|
| Q-E1 | May I add **GitHub Actions, Dependabot, CodeQL and secret scanning**, and would you turn on **branch protection** for `main`? | Yes | D1.1 |
| Q-E2 | Should I **push branches and open PRs** for each deliverable? That needs `gh` or a token. Or will you push and merge yourself? | You push and merge; I commit locally on the branch | D1.1 |
| Q-E3 | This machine can only reach npm through the Microsoft package proxy, so Corepack can't download pnpm. Is `npx pnpm@12.17.0` (or a global `npm i -g pnpm@12.17.0`) acceptable locally? CI will use `pnpm/action-setup`. | Use `npx pnpm@12.17.0` | D1.1 |
