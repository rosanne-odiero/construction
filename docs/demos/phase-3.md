# Phase 3 demo: labour and attendance

Phase 3 has several deliverables (D3.1 onwards). Each gets its own section here as it lands.

> **Safeguard integration:** a demo is not acceptance. Read [implementation status](../IMPLEMENTATION_STATUS.md) for the commands actually run and their results. Everything below uses synthetic people and identifiers on a local machine; no pilot, live payments or biometrics are approved, and nothing is sent to the seeded phone numbers.

---

## D3.1: Labourer registry

This walkthrough takes about 20 minutes. **Labour** in the sidebar now shows live data: the registry, gangs, NCA alerts and trades & rates. The D0 labour screens are still available, labelled **Prototype**, at `/prototype/labour` (the same treatment D2.1 gave the project screens). Attendance, timesheets, the site app and biometrics are later deliverables.

### 1. Run it

Prerequisites as for [D2.1](./phase-2.md#1-run-it): Node 24, pnpm 12 and Docker Desktop. The canonical local ports are **web http://localhost:3000** and **API http://localhost:4000**.

```bash
git checkout phase-3/d3.1-labour-registry
npx pnpm@12.17.0 install
npx pnpm@12.17.0 services:up     # PostgreSQL, Valkey, RustFS and Mailpit
npx pnpm@12.17.0 db:migrate      # includes 20261111090000_labour_registry
npx pnpm@12.17.0 db:seed         # adds 40 synthetic labourers to the demo company
npx pnpm@12.17.0 dev             # API on :4000, web on :3000
```

`apps/api/.env` needs, besides `AUTH_MFA_ENCRYPTION_KEY`, two **local-only** field-encryption values (the API refuses to start without them; see [apps/api/README.md](../../apps/api/README.md) and [CONFIGURATION §8](../CONFIGURATION.md#8-process-environment-deployment-settings)):

```bash
node -e "console.log('FIELD_ENCRYPTION_KEYS=1:' + require('node:crypto').randomBytes(32).toString('hex'))" >> apps/api/.env
node -e "console.log('FIELD_BLIND_INDEX_KEY=' + require('node:crypto').randomBytes(32).toString('hex'))" >> apps/api/.env
```

Keep them: values encrypted with one key cannot be read with another. If you change them after seeding, the registry shows `•••••` for the old values; reset the development database and seed again.

**What the seed adds.** After the D2.1 output it prints a labour summary like:

```text
Labour registry (synthetic people and identifiers):
  15 trades; 6 gangs; 16 new rates this run
  40 labourers (40 created this run)
```

A second run reports `0 created this run` and `0 new rates`. The labourers have fictional names, national IDs `900000xx`, phones in the `0700 000 0xx` block and KRA PINs `A9000000xxZ`; three NCA cards expire within 30 days, two have expired, and **Oscar Mutai Kirui** is flagged do not rehire. Another worktree may use other ports (for example web 3300 and API 4300); the steps are the same.

### 2. Walkthrough

Sign in as the owner (`owner@jenga-bora.example.test`, with the TOTP code) unless a step says otherwise.

| #   | What | Where | Try this |
| --- | --- | --- | --- |
| 1 | Registry | http://localhost:3000/labour | 40 workers with worker number, trade and skill, projects and gang, NCA state, consent, **masked** phone (`2547•••••0xx`) and ID (`•••••0xx`). Switch **EN / SW** and the theme; trade and skill names follow the language. |
| 2 | Built-in views | **Views**: All workers, Active, Expiring NCA, Do not rehire | **Expiring NCA** lists active workers whose card has expired or expires within 30 days, with red/amber badges and dates (`DD/MM/YYYY`). **Do not rehire** shows Oscar; it is visible only to managers. |
| 3 | Filters and search | Filter bar | Filter by status, trade, skill level, gang, NCA state or consent. Search by name or worker number (`WRK-0001`): these stay in the address. Type a **full** ID number (`90000001`), phone (`0700000001`) or KRA PIN instead and the matches appear under **Identifier lookup** while the address bar does not change: identifiers are sent in a request body and found through the blind index, never by decrypting the table. Pasting `?search=90000001` into the address removes it. |
| 4 | Saved views | Set a filter, **Save view** | Name it (for example "Masons"). It appears next to the built-in views for you only (another user does not see it); the × deletes it. Views keep the filters, never the search text. |
| 5 | Worker panel | Click a worker's name | The side panel shows identity (masked), personal and work details, projects, gang history, NCA cards and consent. Close it with Esc. |
| 6 | Reveal a full number | Panel → **Show full** next to the ID | Choose a purpose; a fresh two-step check (authenticator code) is required; the full number appears until you **Hide** it or close the panel. The audit log (`/foundation` → audit) records `labourer.sensitive_revealed` with the field and purpose, never the value. A project manager without `labour.view_sensitive` sees no **Show full** button. |
| 7 | Register: consent first | **Register worker** | Step 1 shows the consent notice. Choose **Kiswahili** to show it in Kiswahili, choose **Signed form** or **Read aloud … with a witness** (then name the witness) and tick that the worker agreed. Without that you cannot continue. |
| 8 | Under 18 refused | Step 2 | Enter a date of birth one day short of 18 years ago: the form explains who can be registered today. The API and the database refuse it too. Exactly 18 today is allowed. |
| 9 | Duplicate ID | Step 2 | Use an existing ID such as `90000001`, even with **Passport** chosen as the document or with a leading zero: you are told it is already registered as `WRK-0001`, with **Open WRK-0001** and **Engage WRK-0001 on …** instead of a second record. |
| 10 | Do-not-rehire match | Step 2 | Oscar's ID number under any document type is refused. Use Oscar's phone (open his panel and reveal it): registration is blocked with a do-not-rehire warning. As the owner you may **Register with override** after giving a reason; it is recorded. |
| 11 | Register | Step 2 | Fill name, date of birth, gender, a new ID, trade, skill level and project; optionally an NCA card. The confirmation shows the new worker number and any warnings (for example "NCA card missing" for a skilled worker without a card). |
| 12 | Consent screen | Panel → **Consent records** | The history shows notice version, language, method, witness, who recorded it and when. **Record withdrawal**: the worker can no longer be engaged on new projects; then record consent again with the current notice. |
| 13 | Do not rehire | Panel → **Flag do not rehire** | Give a factual reason (10+ characters); step-up is required. The flag, who set it and when appear in the panel; the reason is visible only to people with `labour.do_not_rehire`. **Clear the flag** works the same way. |
| 14 | NCA cards | Panel → **Add NCA card** | Add a card expiring next week: the badge turns **NCA expiring** and the worker appears under **NCA alerts**. |
| 15 | Engagements and status | Panel → **Engage on a project**, **End engagement**, **Change status** | Engaging needs active consent and age 18 on the start date. **Left** ends open engagements and gang memberships. Reactivating Oscar needs an override reason. |
| 16 | Gangs | **Gangs** tab | Six gangs with project, site, leader and member count. Open one: current and past members with join/leave dates. **New gang**, **Add member** (only workers engaged on that project), **Make leader**; the leader cannot leave until replaced. |
| 17 | NCA alerts | **NCA alerts** tab | Expired, expiring and missing cards for active workers, with days left or days ago. The lead time is set on **Trades & rates**. |
| 18 | Trades, skill levels, rates | **Trades & rates** tab | EN/SW trades and NCA-aligned skill levels (add, rename, deactivate). Change the alert lead time. Rates: company defaults and per-project rates in KES; **Add rate** starts today or later (a past date is refused), and only a scheduled rate can be cancelled. The COMPLIANCE-REVIEW note explains that minimum-wage checks are not configured (CR-PAY-09). |
| 19 | Project manager | Sign in as `pm@jenga-bora.example.test` | Brian sees only workers on his projects, can register and engage on them and flag do not rehire, but has no **Show full** (no `labour.view_sensitive`) and cannot change trades or company rates. |
| 20 | Prototype screens | `/prototype/labour` | The D0 labour mock is still reachable and labelled **Prototype**. |

### 3. What changed under the hood

| Area | What's new |
| --- | --- |
| Shared packages | `types`: labour vocabularies, consent notice versions with pinned digests, `labour.do_not_rehire` and `labour.consent` permissions and role defaults. `domain`: age boundary, NCA expiry, identifier normalisation and masking, rate resolution and effective-dating. `validation`: every labour request and response schema; `FIELD_*` environment keys. `i18n`: the EN/SW consent notice and all labour screens. |
| API | `labour` module: setup, rates, labourers (register, update, status, reveal, do-not-rehire, engagements), NCA cards, consent, alerts, saved views and gangs; AES-256-GCM field encryption with keyed blind indexes; audited with field names only. OpenAPI at `/api/docs`. |
| Database | Migration `20261111090000_labour_registry`: 12 tables with forced RLS and composite tenant keys; minimum-age CHECK, consent-required deferred trigger, ciphertext and blind-index checks, append-only consent and do-not-rehire history, never-updated rates, gang and engagement triggers; wider permission checks. |
| Web | Live `/labour` registry with saved views and worker panel, `/labour/register`, `/labour/[id]/consent`, `/labour/gangs`, `/labour/setup`, `/labour/alerts`; EN and SW; the D0 labour screens moved to `/prototype/labour`. |
| Seed | 15 trades, 4 skill levels, 40 labourers, rates, 6 gangs, NCA cards and one do-not-rehire case (idempotent). |
| Tests | Unit tests for the age boundary (including 29 February), encryption round trip, tampering, wrong key and key versions, blind indexes and rate effective-dating; API e2e under the real `pmb_app` role for every endpoint, permission denials, step-up, raw ciphertext columns, database-level age and consent rules and isolation of every new table; Playwright with a mock API for every new screen, axe in EN/SW light/dark and a 360 px check. |

### 4. Known limitations

- Keys come from configuration (development placeholders), not a KMS; there is no re-encryption job for key rotation yet, and the blind-index key cannot rotate without recomputing indexes (D-30).
- The date of birth is not checked against the ID document; no ID or live photos yet (they come with attendance evidence).
- NCA alerts are computed when you open the page; no reminders are sent until notifications exist.
- Rates are not checked against a minimum-wage table (CR-PAY-09); casual-to-term warnings wait for attendance (CR-PAY-10).
- The consent wording is a draft for legal and Kiswahili review (CR-DP-03, CR-DP-11); biometric consent is part of D3.4.
- Saved views are personal; there are no company-shared views.

---

## D3.3 (web slice): Muster roll, timesheets and adjustments

This walkthrough takes about 25 minutes. **Attendance** in the sidebar now shows live data: the overview, the daily muster roll, timesheet periods, anomaly review, and rules & holidays. The D0 attendance screens (biometric and QR capture with mock data) moved to `/prototype/attendance` and stay labelled **Prototype**. Only the **web** part of D3.3 is built: a supervisor enters the roll in the web app (`web_manual`); QR/NFC cards, photos, geofences, offline signed records and clock-drift checks come with the site app (D3.2–D3.3).

### 1. Run it

As for [D3.1](#1-run-it) (the `FIELD_*` keys are still needed):

```bash
git checkout phase-3/d3.3-web-timesheets
npx pnpm@12.17.0 install
npx pnpm@12.17.0 services:up
npx pnpm@12.17.0 db:migrate      # includes 20261112090000_attendance_timesheets and 20261112120000_attendance_review_fixes
npx pnpm@12.17.0 db:seed         # adds holidays, the demo rule and nine weeks of attendance
npx pnpm@12.17.0 dev             # API on :4000, web on :3000
```

**What the seed adds.** After the labour summary it prints something like:

```text
Attendance and timesheets (synthetic; created):
  1508 attendance records; 20 timesheet periods (16 approved)
  29 open anomalies; 1 adjustment(s); 23 public holidays
```

The numbers depend on the day you seed (the nine weeks end on that day). Ruiru Heights is recorded by the site agent and Kitengela by the owner; past weeks are confirmed by the project manager and approved by someone other than the submitter; the last complete week is **submitted** and waits for approval; the current week is **open** (today's sheets are drafts; yesterday's, when it is in the current week, wait for confirmation). Watchmen work overnight 18:00–06:00. A yard helper also appears on the Main plot one recent afternoon (a **two-site** day), a mason has a 05:30–20:30 slab pour (**excessive hours**), and skilled workers without a valid NCA card on the day (a mason and an electrician whose cards expired) are flagged. A second run prints "already present" and adds nothing.

Accounts: the owner (`owner@jenga-bora.example.test`, TOTP), the project manager Brian (`pm@…`, no MFA) and the site agent Kevin (`site.agent@…`, Ruiru Heights only). Use two browsers (or a private window) to act as two people.

### 2. Walkthrough

| #   | What | Where | Try this |
| --- | --- | --- | --- |
| 1 | Overview | http://localhost:3000/attendance | Each project you can see, today's muster status per site, the current period (dates, cut-off Thursday 18:00) and the queues: open anomalies, corrections and adjustments to decide, periods awaiting approval. |
| 2 | Muster roll | **Record attendance at Main plot** (as Kevin) | Engaged labourers only, sorted by worker number, with trade and gang. Filter by **Gang**; change the date (DD/MM/YYYY) or use **Previous day**. Labourers not engaged that day cannot be recorded. |
| 3 | Fast entry | Same page | **Mark N unrecorded workers present** fills the rule's default shift (07:00–16:00). Tab moves between fields; in a status list type the first letter (P, H, A, L, S; in Kiswahili Y, N, H, L, M); **Enter** or **Ctrl+S** saves. Set a check-out before check-in: the row is refused until you tick **Overnight**. Hours, overtime and lateness appear per row after saving. |
| 4 | Submit and confirm | **Submit the day**, then as Brian **Confirm the day** | Kevin cannot confirm his own day (a "same person" message); Brian can, or **Return for changes** with a reason. Anyone who recorded an entry of the day cannot confirm it either. |
| 5 | Correction | A confirmed day, as the owner → **Correct** | Change a status or time with a reason (10+ characters); a fresh authenticator code is asked; the row is flagged **Manual correction** and the change waits under **Corrections**. The owner cannot approve it; Brian can. Brian himself cannot ask for corrections until he enables two-step verification. |
| 6 | Anomalies | **Anomalies** | Two sites the same day (both records flagged; the hours are counted once), overlapping times, hours above the maximum (12 h), NCA card expired, and corrections. Filter by project, status or kind; **Review** → **Resolve** or **Dismiss** with a note. Someone who recorded the attendance cannot review it. **Approved share changed** appears when a day changes on one project after another project's week was approved (for example the early record on the second plot is set to absent): the approved week is not edited; a proposed adjustment waits on that week for someone else to approve. |
| 7 | Timesheets | **Timesheets** | Weekly periods newest first with muster days, unconfirmed days, open anomalies and workers. Open the **Submitted** week: totals per worker (days, worked, normal, overtime by weekday/rest day/holiday, late, absences) and the blockers. Approve as someone other than the submitter after reviewing its anomalies: the period shows **Approved snapshot** and can no longer change. **Reject** (with a reason) and **Reopen** are also there. |
| 8 | Adjustment | An approved week → **Request an adjustment** (owner) | Choose a worker, site, date and the corrected values with a reason; step-up again. Brian approves it: the approved week is untouched, and the difference appears as an **adjustment** line in the current week (**Lands in a later period**). The seed already has one. |
| 9 | Rules & holidays | **Rules & holidays** | The company rule (8 h, 1 h break after 5 h, start 07:00 + 15 min grace, full day from 4 h, maximum 12 h, Sunday rest, ×1.50/×2.00/×2.00) is marked **Unverified (compliance review)**. Add a project override from a future date and cancel it; a version cannot start inside a submitted or approved week. The 2026 and 2027 Kenyan holidays list their source (Act, Gazette notice, Sunday rule); add the 2027 Idd days when gazetted. The cut-off and pay day can be changed. |
| 10 | Worker panel | **Labour** → a worker's name | The panel has an **Attendance** section: days, hours and overtime from approved and not-yet-approved weeks, the last day worked and open anomalies. |
| 11 | Languages and themes | Language switch and theme toggle | Every attendance page works in Kiswahili and in dark mode, and fits a 360 px phone. |
| 12 | Payroll contract | `GET /api/v1/attendance/periods/<approved period id>/lines` (signed in) | The immutable lines payroll (D4.1) will read: totals in minutes and half days, the rule versions with their multipliers, source record ids and the period's holidays. |

### 3. What changed under the hood

- Migration `20261112090000_attendance_timesheets`: 12 tables with forced RLS, composite tenant keys and narrowed `pmb_app` grants; triggers enforce engagement on the date, one record per labourer/site/day, maker ≠ checker, period locks and insert-only snapshots ([ERD §6](../ERD.md#6-labour-attendance-and-biometrics)).
- `packages/domain/src/attendance`: the integer-minute timesheet arithmetic, anomaly rules and weekly periods (unit-tested at every boundary); `packages/validation/src/attendance.ts`: every request and response schema; `packages/types/src/attendance.ts`: vocabularies, the demo rule and the holiday calendar with sources.
- API module `attendance` (32 operations, [ARCHITECTURE §4.4](../ARCHITECTURE.md#44-attendance-and-timesheets-module-d33-web-slice)) with idempotency keys, audit and an outbox; permissions `attendance.confirm`, `timesheets.submit`, `timesheets.approve`, `timesheets.manage_rules`.
- Web: `/attendance`, `/attendance/muster`, `/attendance/periods`, `/attendance/periods/[periodId]`, `/attendance/anomalies`, `/attendance/settings`, and the worker-panel summary.

### 4. Known limitations

- No site app yet: no QR/NFC cards, photos, GPS or geofence checks, offline signed records, clock-drift detection, duplicate-window or impossible-travel rules (D3.2–D3.3), and no biometrics (D3.4).
- The rule values and the holiday list are demonstration values awaiting compliance review (CR-PAY-08, CR-PAY-14); the 2027 Idd holidays are not included. Production refuses to approve with unverified rules, and there is no screen yet to mark a rule as approved.
- Overtime multipliers are recorded, not applied: pay comes with D4.1. Weekly periods only (Q-C4); daily, fortnightly or monthly periods are reserved.
- Notifications (for example "a day waits for your confirmation") and an outbox relay are not built; the queues are on the overview.
- Casual-to-term conversion warnings (CR-PAY-10) are not computed yet.
