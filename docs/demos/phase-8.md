# Phase 8 demo: health and safety (D8.2), plant and equipment (D8.3), dashboards and reports (D8.1)

This walkthrough is **not** Phase 8 acceptance. It covers the health and safety module (D8.2):
site inductions with flags from attendance, toolbox talks, the PPE register, incidents and near
misses, corrective actions and first aid, and the done-when flow: incident → investigation →
corrective actions → done → verified → incident closed and locked. Plant and equipment (D8.3) and
dashboards and reports (D8.1) have their own walkthroughs [below](#plant-and-equipment-d83).
Documents and the compliance register (D8.4) and offline/site-app capture remain pending. Notifying the regulator (DOSH) and the OSHA/WIBA registers are **COMPLIANCE-REVIEW**
items (CR-HS-01 to CR-HS-04): the system records what you did; it files nothing.

## Start

Use the existing local services and API/web servers, or the root README quick start. Apply the
forward migration and seed the synthetic company:

```bash
pnpm --filter @pm-buddy/api db:generate
pnpm db:migrate
pnpm db:seed
```

The seed prints the synthetic accounts and their generated passwords. You need two identities in
separate browser profiles: the **site agent** (Kevin Kiprono) and the **project manager** (Brian
Otieno). Both hold `safety.manage` on Ruiru Heights; the walkthrough uses that to show the
maker-checker rule: the owner of a corrective action marks it done, and **someone else** verifies
it. A foreman (`site.diary`) can record but not investigate, verify or close.

## Review

1. As the site agent, open **Health and safety** in the sidebar (`/safety`). The overview lists
   Ruiru Heights with its open incidents, overdue actions, flagged labourers, PPE due and kits
   needing attention. Open the project's **Health and safety** tab.
2. **Incidents.** INC-0001 (near miss, closed and locked) and INC-0002 (injury, investigated, one
   overdue action) are listed with counts and filters.
3. **Report an incident on a phone** (narrow the window to 360 px): *Report an incident*, choose
   *Injury*, severity *Serious*, the location and a description (no names or medical details there).
   Under *People*, add the injured labourer (search by name or worker number), the injury and the
   part of the body, and a witness by name only. Report it. Note that *Before closing* lists the
   investigation and the regulator decision.
4. As the project manager, open the new incident: **Record investigation** (root-cause category and
   root cause), then **Raise a corrective action** owned by the site agent with a due date, then
   **Record the decision** (*Notified* with today's date, or *Not notifiable* with a reason). The
   manager cannot mark the agent's action done, and *Close incident* is not offered yet.
5. As the site agent, **Mark done** on the action with a note. The owner is not offered *Verify*.
6. As the project manager, **Verify** the action, then **Close incident**. The page shows "Closed and
   locked": no edit, void, investigation, action or photo controls remain; *Report a follow-up* is
   offered instead. The database refuses changes to a closed incident for every role.
7. **Corrective actions**: overdue actions come first (CA-0003 on INC-0002, owned by the site
   agent). Filter by *Overdue* or *Only mine*; *Send back* needs a reason.
8. **Inductions**: choose the Main plot. Two labourers are flagged "Worked here without a valid
   induction on …" (read from attendance; the muster was never blocked). Record an induction for one
   of them (topics from the company checklist, acknowledgement). The flag for the days already
   worked stays until it leaves the 14-day look-back.
9. **Toolbox talks**: *Record a toolbox talk* on a phone with a gang and an extra labourer, *Save
   draft*, then *Save and confirm*: once confirmed the talk and its attendance are locked.
10. **PPE register**: items due for replacement are flagged; *Replace* records the new issue,
    *Return* records the condition. The register does not move stock in the stores (decision D-72).
11. **First aid**: the scaffold kit's check is overdue; *Record a check* with the earliest expiry
    date. First-aiders show their certificate expiry; the treatment FA-0001 is linked to INC-0002.
    Sign in as a foreman (if you add one) to see that who was treated and injuries are restricted to
    safety managers.
12. As the owner, **Safety settings** (`/safety/settings`): the induction checklist, induction
    validity, the attendance look-back, the kit check interval and PPE replacement periods.
13. Switch to **SW** and the dark theme at 360 px: every view stays readable without sideways
    scrolling.

## What to look for

- Clients, suppliers, labourers and office roles (QS, finance) cannot open any safety record.
- Names of injured people and witnesses and injury codes appear only for safety managers; the audit
  log never contains them.
- Overdue actions are listed first everywhere and counted on the tab.
- The COMPLIANCE-REVIEW note on every view: thresholds and deadlines for notifying DOSH and the
  WIBA Director, the statutory registers, PPE and first-aid minimums await an adviser.

## Plant and equipment (D8.3)

This walkthrough covers the plant register, moves, operators, daily usage with monotonic meters,
fuel issues and the done-when: **a fuel variance flagged**, as an estimate for review, never proof
of theft. The seed (same commands as above) adds, on Ruiru Heights (RUI-HTS) and the Kitengela
bungalow (KIT-BNG), synthetic plant written through the real services:

- **EX-01** Excavator 20 t, hired from "Nairobi Plant Hire Ltd (synthetic)" at KES 18,000 a day,
  standard 14.00 L/h, with a machine operator from the registry. Full-tank fuellings at 2,450.0 h
  (70.0 L), 2,460.0 h (141.0 L: +0.7 %, within the standard) and 2,470.0 h (182.0 L against 140.0 L
  expected: **+30.0 %, over the standard**), then usage to 2,478.0 h.
- **MX-01** Concrete mixer 350 L (owned), serviced every 100 hours or 90 days: **service due**.
- **VB-01** Poker vibrators (2, owned) with an open **major breakdown** (BRK-0001): under repair.
- **RL-01** Vibrating roller 3 t, hired, on the KIT-BNG Bungalow plot with no working day since its
  hire began: **idle on hire**, and its hire ends in four days.
- **SCF-01** 240 scaffold frames (counted by quantity, no meter) and **GN-01** a generator in the
  yard.

The seed summary prints one line per item with its alerts.

1. As the project manager, open **Plant** in the sidebar (`/plant`). *Needs attention* lists EX-01
   "Fuel above the standard (estimate, not proof of theft)", MX-01 service due, VB-01 open
   breakdown and RL-01 idle on hire / hire ending. The register shows each item's location, meter,
   service state and (for cost holders) the estimated hire charge so far.
2. Open **EX-01**. *Fuel and consumption* lists the full-tank windows: 182.0 L for 10.0 h against
   140.0 L expected, +30.0 %, over the 15 % tolerance; the earlier window is within the standard.
   The wording says it is an estimate for review. *Daily usage* shows the readings per day and the
   operator; *Site history* the move onto the Main plot.
3. As the site agent, on a phone (360 px), open Ruiru Heights → **Plant** tab. Rates and estimates
   are hidden. *Log usage: EX-01*: the start reading is filled from the last one (2,478.0). Type a
   lower start reading: refused — the meter never goes backwards. Type 2,478.0 → 2,486.5 ("8.5 hours
   today") and save. *Log usage: VB-01* opens with *Broken down* selected (it is under repair).
4. *Log fuel: EX-01*: 280 litres at 2,486.5 h, tank filled. The result shows the window this
   fuelling closed: 16.5 h at 14.00 L/h = 231.0 L expected; 280.0 L is +21.2 %, **over the
   standard (estimate)**. Switch to SW and the dark theme: the same forms in Kiswahili without
   sideways scrolling.
5. As the project manager on EX-01, **Correct** the fuel entry (for example 230 litres, with a
   reason): the original stays visible as superseded; the window is judged again. Nothing can be
   edited or deleted.
6. On **VB-01**, *Record the repair* of BRK-0001: the item is back on site. Report an **unsafe**
   breakdown on another item: it goes under repair, no working day can be logged, and only the
   plant manager can record the repair.
7. On **RL-01**, *Move* it to the yard or *Off hire* (date and reason; final). *Assign an operator*
   without a certificate: the operator is flagged (rollers need one by default), not blocked.
8. As the owner, **Plant settings** (`/plant/settings`): the fuel tolerance, the minimum sample,
   idle-hire and hire-ending days, the service warning and the categories whose operators need a
   certificate. Raise the tolerance to 35 %: EX-01's alert clears; set it back.

What to look for:

- Fuel alerts always say "estimate, not proof of theft"; they are a reason to look, not a finding.
- Usage, fuel and hire estimates never appear in the cost ledger or the stores (cost enters through
  supplier invoices and petty cash, D-53).
- Clients, suppliers, consultants and labourers cannot open plant; site agents and storekeepers do
  not see hire rates.
- COMPLIANCE-REVIEW CR-PLT-01–03: operator certificate rules, consumption standards and record
  keeping await an adviser.

## Dashboards and reports (D8.1)

This walkthrough covers the live owner dashboard, the reports centre with PDF and Excel downloads
in English and Kiswahili, and scheduled emails. Its done-when — **all reports export** — is proved
by the API test that exports every report in the registry; here you check a few by hand. The seed
(same commands as above) adds two subscriptions: the owner's weekly cost ledger for Ruiru Heights
(Mondays) and the finance officer's monthly supplier invoice ageing (on the 1st, in Kiswahili).
Emails go to Mailpit in development (`AUTH_NOTIFICATION_TRANSPORT=development`); production email
stays off until a provider is approved.

1. As the **owner** (Wanjiru Kamau; TOTP from the seed output), open **Dashboard**. Check the KPI
   cards (cash position from the forecast, certified to date, actual cost, present today, supplier
   invoices overdue), *Needs attention* (each line links to its screen), the projects table with
   certified value and certified % of contract ("—" where a project has no contract sum), budget,
   committed and actual with used % ("Unavailable" without a budget), the company cash-flow
   forecast (chart and table) and today's attendance. Switch to SW and a phone width (360 px).
2. Sign in as the **site agent** (Kevin Kiprono) in another browser profile: the dashboard has no
   money sections at all (not zeros), and **Reports** lists only the muster roll, stock,
   procurement, petty cash and safety reports; the payroll register, cost ledger, budget against
   actual, valuations and audit log are under *Other reports* with the permission each needs.
3. As the owner, open **Reports** (`/reports`). Reports are grouped (labour, finance and
   reconciliation, materials and procurement, commercial, records); *M-Pesa payout reconciliation*
   is listed as **not available yet · arrives with D4.3**.
4. Open **Muster roll**: choose Ruiru Heights, then the Main plot (sites come from the project),
   keep the last seven days and *Show report*. The table shows each labourer's day codes (P, H, A,
   L, S), days present, absences and hours, with the legend; days whose muster is not yet confirmed
   are left out, and a note says how many were confirmed. *Download PDF* and *Download Excel*: open both. In Excel,
   money columns are numbers (shillings, two decimals) and dates are real dates.
5. Open **Payroll register** for Ruiru Heights and the seeded batch: gross, PAYE, NSSF, SHIF, AHL,
   deductions and net per worker, statutory totals, and the batch status (draft or submitted:
   approval and payment do not exist yet). Download both files in **Kiswahili** (switch the
   language first).
6. Open **Cost ledger** (all projects, last 30 days), **Budget against actual** (Ruiru Heights),
   **Stock**, **Valuations and certificates**, **LPO register**, **Supplier invoice ageing** (as at
   today: not yet due, 1–30, 31–60, 61–90, over 90 days overdue), **Supplier payments
   reconciliation**, **Petty-cash reconciliation** and **Health and safety**; compare one total in
   each with its source screen (for example the cost ledger's accrued total with *Spending →
   Ledger* for the same filters).
7. Open **Audit log**: it asks for a fresh two-step check (*Verify and show the report*). The
   details column shows IDs and codes only; your own report views and exports appear as
   `report.viewed` / `report.exported` with the report and parameter IDs (no amounts or names).
8. On any report, *Email me this report*: weekly on a day or monthly on a day of the month, email
   language. Open **Scheduled emails** (`/reports/subscriptions`): pause, resume and delete your
   own. The *Company* tab (owner, `config.manage`) lists everyone's with recent runs; *Send due
   emails now* runs the due ones (the scheduler does the same every minute). In Mailpit the email
   holds the report name, company, period and a link — **no figures and no attachment**. Open the
   link signed in as someone without the permission: the report is refused.

What to look for:

- A report never shows more than its source screen shows the same person (try the project
  manager: only the assigned projects are offered; another project by URL is refused).
- Excel files open without warnings; a cell that starts with `=` shows as text.
- A report above 5,000 rows offers Excel only; very long periods are refused with the limit.
- COMPLIANCE-REVIEW CR-RPT-01–05: statutory formats, personal data in exports, scheduled emails,
  the audit-log report and Kiswahili wording await an adviser.
