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
