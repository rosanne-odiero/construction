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
