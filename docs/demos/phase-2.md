# Phase 2 demo: projects and BQ

Phase 2 has several deliverables (D2.1 onwards). Each gets its own section here as it lands.

> **Safeguard integration:** a demo is not acceptance. Read [implementation status](../IMPLEMENTATION_STATUS.md) for the commands actually run and their results. Everything below uses synthetic data on a local machine; no pilot, live payments or biometrics are approved.

---

## D2.1: Projects, sites and geofences

This walkthrough takes about 15 minutes. It is the first time the office app itself (not only `/foundation`) runs on the real API: you sign in on `/sign-in`, and **Projects** shows live data. Other menu items still show the D0 prototype and say so.

### 1. Run it

Prerequisites: Node 24, pnpm 12 and Docker Desktop (running). Commands use `npx pnpm@12.17.0` because `pnpm` may not be on your PATH.

```bash
git checkout phase-2/d2.1-projects-sites
npx pnpm@12.17.0 install
npx pnpm@12.17.0 services:up     # PostgreSQL, Valkey, RustFS and Mailpit
npx pnpm@12.17.0 db:migrate      # includes 20261110100000_projects_sites_geofences
npx pnpm@12.17.0 db:seed         # synthetic demo company; prints the demo credentials
npx pnpm@12.17.0 dev             # API on :4000, web on :3000
```

`apps/api/.env` needs `AUTH_MFA_ENCRYPTION_KEY` (see [apps/api/README.md](../../apps/api/README.md)); the seed encrypts the owner's TOTP secret with it.

**What the seed prints.** The first run creates the company and prints, for each account, the sign-in identifier and a newly generated password; for the owner it also prints the TOTP secret and an `otpauth://` URI (add it to an authenticator app, or generate codes with any TOTP tool). The output looks like this (generated values replaced):

```text
Demo company: Jenga Bora Builders Ltd (created)

Accounts (synthetic, local development only):
  Wanjiru Kamau — owner
    sign in as: owner@jenga-bora.example.test
    password:   <generated>
    TOTP secret: <generated base32 secret>
    otpauth URI: otpauth://totp/…
  Brian Otieno — project_manager
    sign in as: pm@jenga-bora.example.test
    password:   <generated>
  Kevin Kiprono — site_agent
    sign in as: site.agent@jenga-bora.example.test
    password:   <generated>

Projects:
  RUI-HTS  Ruiru Heights Apartments — active (created)
  KIT-BNG  Kitengela Bungalow — active (created)
  SYO-TWN  Syokimau Townhouses — planning (created)
```

Running it again changes nothing and says `already present` for every record, with `password: unchanged`. To issue new passwords and a new owner TOTP secret, run `npx pnpm@12.17.0 --filter @pm-buddy/api db:seed --reset-credentials`. The seed refuses to run when `NODE_ENV=production`. All identities are synthetic (`example.test` addresses); these credentials are for your machine only.

### 2. Walkthrough

| #   | What | Where | Try this |
| --- | --- | --- | --- |
| 1 | Live pages need a session | http://localhost:3000/projects | You land on `/sign-in?next=%2Fprojects`. Try `http://localhost:3000/sign-in?next=https://example.com`: after signing in you stay inside PM-Buddy (only relative `next` paths are followed). |
| 2 | Real sign-in with MFA | `/sign-in` | Sign in as the owner. Because the owner holds MFA-required permissions, the next step asks for the authenticator code (or a passkey or recovery code). With one company the app selects it and returns you to `/projects`. The top bar shows **Wanjiru Kamau** (**Owner**), the sidebar and user menu show **Jenga Bora Builders Ltd**, and **Sign out** is in the user menu. |
| 3 | Projects list | `/projects` | Three projects with code, client, status, contract sum (`KES 86,400,000`), dates (`DD/MM/YYYY`) and progress **Unavailable**. Search "syok" and filter by status; **Clear filters** resets both. Switch **EN / SW** and the theme. |
| 4 | Create a project | **New project** | Enter a name only, or a code, client, contract sum, dates (end before start is refused), county from the list of 47, town and optional coordinates. Creating needs a fresh MFA check: the step-up dialog asks for a code. A new project starts in **Planning** with a checklist of what activation needs. |
| 5 | Lifecycle | Project → **Change status** | On a new project, **Activate** is refused until the checklist is complete (a site with a geofence is one item). **Cancel the project** needs a reason; a cancelled or closed project becomes read-only. On Ruiru Heights try **Put on hold** (reason required) and **Resume**. The history at the bottom lists each change with its reason. |
| 6 | Overview tab | Ruiru Heights → **Overview** | KPI cards for % complete, budget burn, cash position, labour on site today and open issues say **Unavailable** and name the deliverable that will supply them. They never show 0 % or a made-up number. Contract details, dates and the status history are live. |
| 7 | Sites and geofences | **Sites** tab | The map shows each site's geofence (polygon or radius) with area, perimeter, version and the time it came into force. OpenStreetMap tiles appear only in development. |
| 8 | Draw a polygon | **Add site** | Click the map to add vertices, drag one to move it, click one and **Delete selected vertex**, **Undo**. Area and perimeter update as you go; crossing edges, too few vertices, a point outside Kenya, an area under 100 m² or over 25 km² are explained and block saving. |
| 9 | Keyboard alternative | Same page, **Coordinates** card | Without the mouse: switch the shape with the arrow keys, use **Add vertex**, type coordinates, reorder with the arrow buttons, or set a radius with the number field or slider (20–5,000 m). Everything the map does can be done here. |
| 10 | Geofence versions | **Edit site and geofence** on Main plot | Move a vertex and **Save new geofence version**. The history lists the new version and keeps the earlier ones unchanged; attendance (D3.3) will check each capture against the version in force at that time. |
| 11 | WBS | **WBS & milestones** tab | A tree with codes, names and weights. Add an item: the group no longer adds up to 100 %, and the page says so; progress stays **Unavailable** until every group is complete (and, in D2.1, until progress measurements arrive in D6.3). Reorder with the arrows; edit or delete items. |
| 12 | Milestones | Same tab | Start, mark achieved (with the actual date, not in the future), cancel (reason) or reopen (reason). Invalid moves are not offered, and the API refuses them anyway. |
| 13 | Team | **Team** tab | Members with their company role and effective project permissions (role ∩ assignment). As the owner, **Edit** Brian Otieno's permissions or add a member: a step-up check is required, permissions outside the member's role are marked "no effect", and you cannot grant what you do not hold. |
| 14 | A site agent's view | Sign out (user menu), sign in as `site.agent@…` | Only Ruiru Heights is listed. Pages are read-only: no **New project**, **Change status**, **Add site** or WBS edits. Opening another project's URL shows **You do not have access**. |
| 15 | Prototype screens | `/prototype/projects`, the BQ tab | Mock screens are still reachable and labelled **Prototype**; the BQ tab links to the D0 BQ prototype until D2.2. |

### 3. What changed under the hood

| Area | What's new |
| --- | --- |
| Shared packages | `types`: Kenya's 47 counties, contract types, project and milestone statuses, `PROJECT_ASSIGNABLE_PERMISSIONS`. `domain`: `geofence.ts` (validation, area, perimeter, point-in-fence), `project-lifecycle.ts` (project and milestone transitions, activation checklist), `wbs.ts` (weights and progress). `validation`: request and response schemas for every new endpoint. |
| API | `projects` module: projects, status transitions, sites, versioned geofences, WBS, milestones and team, all through `AccessPolicy` and audited with field names only. OpenAPI at `/api/docs`. |
| Database | Migration `20261110100000_projects_sites_geofences`: project fields and lifecycle trigger, `project_status_changes`, `sites`, `site_geofences` (append-only versions with CHECKs), `wbs_nodes`, `milestones`; forced RLS and composite tenant keys; wider `project_permissions_check`. |
| Web | Real `/sign-in`, signed-in office shell and sign-out, live `/projects` and project detail tabs, site map editor with a coordinate list, team, WBS and milestone panels; EN and SW. |
| Seed | `db:seed` (development only, idempotent). |
| Tests | Unit tests for geofences, lifecycles and WBS weights; API e2e under the real `pmb_app` role (CRUD, transitions, permissions, isolation, versioning, WBS weights, team escalation guard, seed twice); Playwright with a mock API for sign-in, projects, the site editor, axe in EN/SW light/dark and a 360 px check. |

### 4. Known limitations

- Sites cannot be deleted yet (attendance will reference them); rename them instead.
- Progress, cost, schedule, labour and safety figures stay **Unavailable** until their modules land (D2.2–D6.x).
- No production map tiles: the editor works with the coordinate list when tiles are off (D-10).
- Client details are simple fields until the client portal (D7.1).
- Kiswahili wording needs review by a native speaker in the field (§15 H).

---

## D2.2: BQ import

This walkthrough takes about 20 minutes. It imports **synthetic** Kenyan-style workbooks from `apps/api/test/fixtures/bq/` into a project, then views and exports the result. No real BQ has been imported yet; acceptance ("A real Excel BQ imports correctly") still needs an anonymised real BQ from the owner.

### 1. Run it

As for D2.1, on branch `phase-2/d2.2-bq-import`:

```bash
npx pnpm@12.17.0 install
npx pnpm@12.17.0 services:up     # RustFS (S3) holds the uploaded workbooks in the private pmb-local bucket
npx pnpm@12.17.0 db:migrate      # includes 20261110110000_bq_import
npx pnpm@12.17.0 db:seed
npx pnpm@12.17.0 dev
```

`apps/api/.env` needs `MALWARE_SCANNER=development` (as in `.env.example`): the default `disabled` refuses uploads until a real scanner (ClamAV) is wired. `BQ_VAT_RATE_PERCENT` defaults to 16.

The fixtures (regenerate with `node apps/api/test/fixtures/bq/generate.mts`):

| File | What it is | Expected result |
| --- | --- | --- |
| `kenyan-multi-bill.xlsx` | Bill 1 Preliminaries, Bill 2 Substructure, Bill 3 Superstructure, Bill 4 PC & Provisional Sums, Grand Summary with VAT 16 %; carried-forward rows, collection pages, KShs columns | 4 bills, 39 items; subtotal **KES 33,316,542.03**, VAT **KES 5,330,646.72**, grand total **KES 38,647,188.75**; no errors |
| `single-sheet-alt-columns.xlsx` | One sheet with section headings, columns in another order with other names | 10 items; grand total **KES 3,340,085.30** |
| `messy.xlsx` | Duplicate refs, a missing unit, a formula cell, a wrong amount (947,400 instead of 974,400) and a wrong page total | Errors and warnings to resolve (step 6) |
| `kenyan-multi-bill.xls` | Legacy `.xls` copy of the first file | Same totals as the `.xlsx` |
| `zip-bomb.xlsx`, `not-excel.xlsx` | A 150 MB-uncompressed ZIP and a PNG renamed `.xlsx` | Refused before parsing |

### 2. Walkthrough

| # | What | Where | Try this |
| --- | --- | --- | --- |
| 1 | BQ tab | Ruiru Heights → **BQ** tab | The tab opens the live `/projects/…/bq` (no "Prototype" label). With no BQ yet the page says so and offers **Import BQ** (owner, project manager and QS hold `bq.import`). |
| 2 | Upload | **Import BQ** → step 1 | Choose `kenyan-multi-bill.xlsx` and **Upload and read**. The step shows the file's SHA-256 and the malware-scan result. The file is checked (type by content, size, ZIP limits), hashed, stored under a server-chosen key and read in a sandboxed worker. Try `not-excel.xlsx` (refused as not an Excel workbook) and `zip-bomb.xlsx` (refused as unsafe). |
| 3 | Sheets | Step 2 | Each sheet is scored as a bill, a summary or other. Check the bill numbers and names, the header row and the data rows; untick a sheet to leave it out. |
| 4 | Columns | Step 3 | The proposed mapping (with its confidence) is shown above the sheet's raw rows; the header row is highlighted and formula cells are marked. Change a column with the selects, then **Save mapping**. **Save as template** stores it for the company; a later upload with the same headers can **Apply** it from **Saved mapping templates**. |
| 5 | Validate | Step 4 → **Run validation** | For the multi-bill file only info items and the contract-sum warning appear (the grand total differs from Ruiru's contract sum of KES 86,400,000): accept it with a reason. |
| 6 | Messy file | Start another import with `messy.xlsx` | Errors block the commit: the duplicate reference on row 10 and the amount on row 23 ("The sheet says KES 947,400 but quantity × rate is KES 974,400"). Choose **Exclude the row** for row 10 and **Use quantity × rate** (or **Keep the sheet amount**, with a reason) for row 23. Accept the warnings (missing unit on row 11, the formula on row 12, the page total on row 25) with reasons. |
| 7 | Review and commit | Step 5 | The preview lists the bills, item counts and totals and, on a re-import, the differences from the current draft. Nothing is stored until **Commit the BQ**; the commit is one transaction. |
| 8 | Viewer | **Open the BQ** | Version 1 (draft). The summary lists every bill, Preliminaries, PC and Provisional sums (with attendance and profit), Contingencies, Dayworks, the subtotal, VAT at 16 % and the grand total. Expand a bill to see sections and items with quantities, units, rates and amounts (e.g. Bill 2 "Galvanised binding wire", 1.5 kg at 4.75 = KES 7.13). Search "binding". The **Import and validation** card shows the source file, when and by whom it was committed, the accepted warnings with their reasons and every row decision. |
| 9 | Exports | **Export Excel**, **Export PDF** | The Excel file has a Summary sheet and one sheet per bill with subtotals; text that starts with `=`, `+`, `-` or `@` is shown as text, never run as a formula. The PDF is A4 with the company and project, page numbers and a **Draft** watermark. |
| 10 | Re-import | **Import BQ** again with `kenyan-multi-bill.xls` | Committing replaces the draft atomically; the earlier import stays in the list as superseded. |
| 11 | Leave and resume | Start an import, close the tab | **Import BQ** lists **Unfinished imports**; **Continue …** picks up where you stopped, or **Abandon this import**. |
| 12 | A site agent's view | Sign in as `site.agent@…` | The BQ is visible and exportable (`bq.view`), but there is no **Import BQ**, and `/bq/import` says **You do not have access**. |

### 3. What changed under the hood

| Area | What's new |
| --- | --- |
| Shared packages | `types/bq.ts` (statuses, limits, units, issue codes and severities, the VAT rule). `domain/bq/*` (grid, text safety, numbers, units, header detection, classification, hierarchy, reconciliation, lifecycle) and `money.ts` (`lineAmountFromRate`, `decimalToMinor`). `validation/bq.ts` (every request and response). |
| API | `bq` module: upload guard, file inspection, `MalwareScanner`, worker-thread parser, imports state machine, templates, viewer, Excel (SheetJS) and PDF (pdfmake) exports; OpenAPI at `/api/docs`. |
| Database | Migration `20261110110000_bq_import`: `bq_mapping_templates`, `bqs`, `bq_versions`, `bq_bills`, `bq_sections`, `bq_items`, `bq_imports`; forced RLS, composite tenant keys, amount and totals CHECKs, deferred totals trigger, import transition trigger. |
| Web | Live `/projects/[id]/bq` (tree, search, summary, import status, overrides, exports) and `/projects/[id]/bq/import` (5-step wizard); the D0 BQ screens moved to `/prototype/projects/…/bq`. EN and SW. |
| Tests | Fixture generator and committed fixtures; domain unit tests (detection, units, hierarchy, classification, money, reconciliation, formula-injection neutralisation); API unit tests (file inspection, parser limits, exports formatting); API e2e under `pmb_app` (13 tests); Playwright (9 BQ tests against the mock API, including axe EN/SW × light/dark and 360 px). |

### 4. Known limitations

- Only synthetic fixtures have been imported. A real anonymised Kenyan BQ is needed for acceptance.
- No ClamAV yet (`MALWARE_SCANNER=development` records "not scanned").
- Sections are one level deep; Kenyan "KShs | Cts" split amount columns are not recognised (map the shillings column, or join them first).
- No manual BQ editing, approval, variations or revisions (D2.3).
- PDF export is limited to 10,000 items and renders in the API process.
- Kiswahili wording needs a native speaker's review.
