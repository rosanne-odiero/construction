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
- No manual BQ editing, approval, variations or revisions (these arrive in D2.3, below).
- PDF export is limited to 10,000 items and renders in the API process.
- Kiswahili wording needs a native speaker's review.

---

## D2.3: BQ versions, instructions, variations and rate build-ups

This walkthrough takes about 25 minutes. It continues from D2.2: Ruiru Heights has a committed BQ (version 1, draft) imported from `kenyan-multi-bill.xlsx` (grand total **KES 38,647,188.75**). Two people are needed, because the person who imported or drafted something may not approve it: the **project manager** (Brian, `pm@jenga-bora.example.test`) prepares, and the **owner** (Wanjiru, `owner@jenga-bora.example.test`, TOTP enrolled) approves with a fresh authenticator code. Use two browsers, or a private window for the second person.

### 1. Run it

As for D2.2, on branch `phase-2/d2.3-bq-variations`:

```bash
npx pnpm@12.17.0 install
npx pnpm@12.17.0 services:up
npx pnpm@12.17.0 db:migrate      # includes 20261110130000_bq_variations
npx pnpm@12.17.0 db:seed         # also adds the synthetic rate build-up CONC-C25-SYN
npx pnpm@12.17.0 dev
```

If the BQ was imported by the owner in the D2.2 demo, swap the roles below (only someone with an authenticator can approve, so either import again as Brian or enrol TOTP for Brian first).

### 2. Walkthrough

| # | What | Who and where | Try this |
| --- | --- | --- | --- |
| 1 | Contract sum before approval | Anyone → Ruiru Heights → **BQ** | The contract sum card says the BQ is still a draft (with its total) and that the original contract sum is fixed when it is approved; there is no revised sum yet. The sub-navigation shows **BQ**, **Variations**, **Instructions**, **Versions** and **Rate build-ups**. |
| 2 | Maker-checker on the baseline | Brian (the importer) → **BQ** | No approve button: "You imported this BQ, so someone else must approve it as the contract baseline." The API refuses it too (403 `maker-checker`). |
| 3 | Approve the baseline | Wanjiru → **BQ** → **Approve as contract baseline** | The dialog shows the grand total and says the version will never change; **Approve baseline**, then enter the authenticator code in **Confirm it is you**. Version 1 becomes the contract baseline: **Original = KES 38,647,188.75**. A re-import is now refused ("This BQ has been approved; changes need a variation or revision."). |
| 4 | Register an instruction | Brian → **Instructions** → **Register instruction** | Number `AI-001`, today's date, issued by "Arch. Achieng Odhiambo", Architect, subject "Revise column bases". A second instruction with the same number is refused. |
| 5 | Draft a variation | Brian → **Variations** → **New variation** | Choose `AI-001`; the base is the newest approved version (version 1). In the editor, pick items from the BQ tree: **Change quantity or rate** on an excavation item, **Omit** a provisional item (it stays in the BQ with quantity 0), and **Add a new item** to an existing bill in a new section (ref, description, unit, quantity and rate, or a fixed amount for a lump sum or daywork). Each line shows the base amount, the new amount and the difference; the totals show additions, omissions, net and the projected grand total with VAT at the base version's snapshotted 16 %. **Save lines**. |
| 6 | Submit | Brian → **Submit** | The proposal is frozen and gets a snapshot digest (shown shortened on the page). Lines can no longer change. |
| 7 | Pending is not revised | Anyone → project **Overview** | The contract sum card lists the submitted variation under **Pending**; the revised sum is unchanged. |
| 8 | Maker-checker on the variation | Brian → the submitted variation | No approve or reject buttons: "You raised or submitted this variation, so someone else must approve or reject it." The API refuses it too (403 `maker-checker`). |
| 9 | Approve | Wanjiru → the variation → **Approve** | The dialog shows the totals and the digest being approved; enter the authenticator code. The variation is approved and **version 2** is created in the same transaction. |
| 10 | Versions and compare | Anyone → **Versions** | Version 2: source "Variation VO-001", parent version 1, created by Brian, approved by Wanjiru, its totals and VAT rate. The comparison lists items added, removed and changed (quantity, rate, amount before and after), bill subtotals and the overall difference. |
| 11 | Original vs revised | Project **Overview** | Original (version 1), approved variations (the net effect including VAT), revised (version 2) and pending (now zero). |
| 12 | Stale and rebase | Brian drafts and submits VO-002 on version 1 *before* step 9; after VO-001 is approved, Wanjiru → VO-002 → **Approve** | Refused as stale: a newer version was approved. Brian → **Rebase**: VO-002 moves to version 2, returns to draft, its lines are repriced; submit again and Wanjiru can approve it as version 3. |
| 13 | Reject and reopen | Wanjiru → a submitted variation → **Reject** (a reason is required) | Brian → **Reopen** (**Reopen as draft**) returns it to draft for changes; **Cancel variation** (with a reason) ends a draft. |
| 14 | Rate build-up library | Brian → **Rate build-ups** | `CONC-C25-SYN` (synthetic): cement in 50 kg bags with 5 % waste, sand and ballast in tonnes, labour hours; the rate per m³ is the sum of the lines, each rounded to the cent. Read the **Assumptions** panel: conversions are written assumptions, and a lorry trip is not a unit of mass or volume. **New build-up** creates another; editing one creates version 2 and keeps version 1 viewable. |
| 15 | Link an item | Brian → **BQ** → a concrete item measured in m³ → **Link build-up** | Only build-ups priced per the item's unit are offered (an item in m² shows "No build-up is priced per this item's unit."; the API refuses a mismatch with 422 `unit-mismatch`). Choose `CONC-C25-SYN` and **Link**: the tree shows "Build-up CONC-C25-SYN v1" with its rate. Editing the build-up later does not change the version the item is linked to. |
| 16 | A site agent's view | Kevin (`site.agent@…`) | Versions, variations, instructions and the library are visible (`bq.view`), but nothing can be created, decided or linked. |

### 3. What changed under the hood

| Area | What's new |
| --- | --- |
| Shared packages | `types/variations.ts` (instruction, variation and build-up vocabulary). `domain/bq/variation-lifecycle.ts` (state machine), `variation.ts` (line pricing, totals, apply, snapshot text), `compare.ts`, `buildup.ts` (rate maths, unit compatibility). `validation/variations.ts` (wire contracts). |
| API | `BqVersionsService` (baseline approval, compare, contract sums), `InstructionsService`, `VariationsService` (lifecycle, snapshot digest, atomic approval serialised per BQ, rebase), `BuildupsService` (library versions, item links); two controllers with OpenAPI. `AccessPolicy.stepUp`/`holdsSomewhere`. |
| Database | Migration `20261110130000_bq_variations`: lineage IDs on bills and sections; version lineage, parent and approval columns; `instructions`, `variation_orders`, `variation_lines`, `variation_status_changes`, `rate_buildups`, `rate_buildup_versions`, `rate_buildup_lines`, `bq_item_rate_links`; forced RLS, composite tenant keys to project, BQ, version, bill, section and item lineage; state CHECKs and triggers (`app.guard_bq_version`, `app.guard_variation_order`, `app.guard_variation_line`, build-up totals, link guard); history tables append-only for `pmb_app`. |
| Web | `/projects/[id]/bq` (contract sum, baseline approval, sub-navigation), `…/bq/variations` (list with status filter, editor, actions with the step-up dialog), `…/bq/instructions`, `…/bq/versions` (history and compare), `/rate-buildups` (list, editor, versions), `/bq` (projects' BQs), contract sum card on the project overview, link dialog in the BQ tree. EN and SW. |
| Tests | Domain and validation unit tests; API unit test of the digest; API e2e `variations.e2e-spec.ts` (11 tests under `pmb_app`); Playwright `variations.spec.ts` (5 tests with axe, EN/SW, light/dark, 360 px) on an extended mock API. |

### 4. Known limitations

- Approval limits by amount (for example "may approve up to KES 2,000,000") are not implemented; any holder of `bq.approve_variation` with step-up may approve.
- A variation is always based on the newest approved version; there is no branching or merging, only rebase.
- Percentage lines (PC attendance and profit) are not recomputed when their PC sum changes; adjust them with their own line.
- Instruction attachments are metadata only (no upload until the files module).
- Build-ups do not convert units or use material and trade masters yet (D5.1); theoretical consumption arrives in D5.x. Seed values are synthetic, not market rates.
- The client's decision on a variation (client portal) is not modelled yet.
- Kiswahili wording needs a native speaker's review.
