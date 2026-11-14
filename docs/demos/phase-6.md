# Phase 6 demo: site diary, verified photos, quality, the schedule and valuations

This walkthrough covers online web diaries (increment 1), verified photos (increment 2), the
schedule (D6.2), quality (D6.1: workforce from attendance, inspections, concrete tests, snags,
practical completion and the defects liability period) and measurement and valuations (D6.3 part
A). The **Phase 6 acceptance walkthrough** is at the end. Offline/site-app capture, subcontracts
and piece-rate links (D6.3 part B) remain pending. No biometric collection, payouts, deployment
or pilot is authorised.

## Start

Use the existing local services and API/web servers, or the root README quick start.
After generating Prisma/shared packages, apply the forward migration:

```bash
pnpm --filter @pm-buddy/api db:generate
pnpm db:migrate
```

Two different signed-in identities are needed: an assigned author with `projects.view`
and `site.diary`, and an assigned independent reviewer with `projects.view` and
`quality.manage`. A company-wide owner can review someone else's diary, but cannot
review their own. Use separate browser profiles for the two identities.

## Review

1. As the author, select **Site diary** in the sidebar (`/diary`); choose a project.
   The project's **Site diary** tab opens. Create a site first if necessary.
2. Choose **New diary**. Select a site, a day no later than today in Nairobi and a
   work description. Leave workforce blank, save, then edit it to zero: unknown and
   zero must display differently. Weather and delays are optional.
3. Try another diary for the same site/day: it must fail explicitly. A future date
   must also fail; neither operation saves a second record.
4. Open the draft in two tabs, edit/save one, then save the stale copy: it must show
   a version conflict and keep the form open, not claim success.
5. Submit the draft. Content editing disappears; the author's own approval is not
   offered and direct API self-approval is refused.
6. As the independent reviewer, open the same diary. Reject with a reason; the author
   sees that reason, reopens, corrects and resubmits.
7. Approve with the reviewer. Reload: the diary remains **Approved · locked**, with
   no edit/reopen/delete action. The database also refuses direct content mutation.
8. Switch EN/SW and test at 360px. On API/network failure the UI must show an error,
   never mock records or saved-success feedback.

## Review: verified site photos (increment 2)

1. Open a project → **Photos** (needs `site.photos` to upload). On a phone, choose **Photo
   (JPEG)** to open the camera; keep the camera's location setting on.
2. Upload a photo taken on site today: it shows **Verified**, "Taken inside <site> (geofence
   version N)" and the capture time. Open the original to see the file as uploaded.
3. Upload a photo taken elsewhere, an old photo, or a screenshot/edited image without metadata:
   it is stored but **Not verified**, with the reason (metres outside, older than three days, no
   GPS position or capture time). Uploading the same file again is refused.
4. Change the site's geofence, then upload a photo taken before the change: it is checked
   against the version in force when it was taken.
5. Attach a photo to your **draft** diary; after submission, attaching is refused, so an
   approved diary stays locked. A photo taken on another day shows "a different day from its
   diary".
6. Switch EN/SW and test at 360 px. A verified badge means the photo's own metadata is
   consistent; metadata can be edited, so it is evidence for review, not proof.

## D6.1 quality: workforce from attendance, inspections, tests, snags, completion and DLP

Seeded data (`pnpm run db:seed`; synthetic): the seven starter checklist templates; on **Ruiru
Heights Apartments (RUI-HTS)** a signed-off slab inspection (INS-0001), a **failed** walling
inspection by the county inspector (INS-0002) with snags raised from its failed items, a roofing
inspection awaiting sign-off (INS-0003), four cube sets (CUBE-0002 **fails at 28 days**, CUBE-0004
has an **overdue** 7-day result), three slump tests (SLP-0002 outside tolerance), and two diaries
whose workforce is an attendance snapshot; **Juja Road Duplex (JUJ-DPX)** at **practical
completion** (certified 75 days before the seed day) with its **six-month defects liability period
running** and two DLP defects. Sign in as the **site agent** (records; holds `site.diary` and
`quality.manage`) and the **project manager** (independent reviewer; also `projects.manage`), in
separate browser profiles. The seed output (kept outside the repository) lists the accounts.

1. **Diary workforce.** As the site agent open **Projects → Ruiru Heights → Site diary**, choose
   *New diary*, pick a day with a muster sheet and keep *From attendance*: *Show attendance for
   this day* lists the people present by trade (half days counted). Save: the diary shows "N from
   attendance" and "Snapshot: muster confirmed, <time>". Switch a draft to *Typed in* and enter a
   count: it shows "(typed in)". Submit an attendance diary: the snapshot is taken again. An
   approved diary keeps its figure even if attendance is corrected later.
2. **Templates.** Open **Quality** in the sidebar → *Checklist templates*. Open *Suspended slab
   before casting*, *Revise* it (add an item) and save: version 2 becomes current and version 1 stays in
   the history. Retire a template: it can no longer start inspections. *Load the starter templates*
   adds any missing starters in English or Kiswahili. The settings card shows the default DLP (6
   months) and the cube grace days (2); only `config.manage` (the owner) can change them.
3. **Inspection on a phone.** Project → **Quality** → *Inspections* → *New inspection*: site,
   template (current versions only), location, inspector (internal, consultant or county) and
   optional WBS item or schedule task. On the checklist page (try 360 px) answer each item
   *Pass*, *Fail* or *N/A*, add a note and photos (from the project's site photos), *Save*, then
   *Submit*: every item must be answered and every failure explained. The author's own sign-off is
   not offered (and refused by the API and the database).
4. **Independent sign-off.** As the project manager open INS-0003 (*Awaiting sign-off*): *Sign off and
   lock* locks it (no edit anywhere), or *Return for changes* with a reason sends it back to draft. Open INS-0002
   (failed): its failed items offer *Raise a snag*, and the snags already raised are listed.
5. **Concrete tests.** *Concrete tests*: CUBE-0002 shows **Fail at 28 days** (mean, % of the class
   and the weakest cube against C25 under rule KE-CUBE-1); CUBE-0004 shows **Overdue** for 7 days.
   Record a 7-day result for CUBE-0004 (three strengths, one decimal place): the mean and an
   indicative outcome appear. As the project manager *Correct* a result with a reason: the
   original stays, marked "corrected", and the correction references it. Record a slump test:
   the tolerance is suggested from the target (75 mm → ±20 mm) and the outcome follows. The rules
   are flagged for an engineer's review (COMPLIANCE_TODO CR-QA-01/02).
6. **Snags.** *Snags and defects*: counts by state; filter *Open* and search "SNG-0004". As the site
   agent *Mark fixed* on SNG-0004 with a note. As the project manager *Verify and close* it, or
   *Reopen* with a reason (the reopen count rises). The person who recorded the fix is never
   offered verification. Edit SNG-0001's severity (project manager only).
7. **Practical completion refused.** On Ruiru Heights *Completion and DLP*: proposing practical
   completion is blocked by SNG-0001 (critical, open); it can only go ahead with an exception
   reason, which the certificate keeps. Withdraw the proposal with a reason.
8. **DLP running.** On Juja Road Duplex *Completion and DLP*: the certified practical completion
   (locked), the DLP dates and days remaining, and the DLP defects. Raise a new snag: it is marked
   *DLP*. Final completion stays blocked until the DLP has ended and no snags are open (this is
   what D6.3 retention release will read).
9. Switch to Kiswahili and the dark theme and narrow the window to 360 px: no sideways scrolling;
   long badges wrap. A client account (portal) cannot open any quality record.

## D6.2 schedule: Gantt, baseline and variance, delay log

Seeded data: the development seed gives **Ruiru Heights Apartments (RUI-HTS)** a schedule of 22
activities with dependencies, the project's milestones linked into the network, the **contract
programme frozen as baseline 1** (planned on 02/03/2026) and actual progress that slipped
(long rains, late reinforcement, a client instruction), with three delays in the log. Sign in as
the owner or the project manager (both hold `projects.manage` on RUI-HTS); the site agent sees
the same schedule read-only.

1. Open **Projects → Ruiru Heights Apartments → Schedule**. The headline figures show the planned
   finish, the baseline finish and the **finish variance in working days** (red when late), the
   duration-weighted physical progress (labelled as such; not earned or certified value) and the
   number of critical items.
2. The **Gantt chart**: blue bars are planned or forecast dates, red bars the critical path,
   green bars completed work, the thin dark bar above each bar the actual dates, the grey bar
   below the baseline, diamonds the milestones, arrows the dependencies (red on the critical
   path) and the dashed orange line today (Nairobi). Switch **Weeks/Months**. Keyboard: Tab to the
   item list, use the up and down arrows, Home and End; the selected item's dates and variance
   appear under the chart. The chart scrolls sideways inside its own frame; the **Schedule
   table** below has every figure for screen readers and small screens.
3. **Activities**: *Add activity* (code, name, duration in working days, WBS item, optional
   "start no earlier than", optional BQ item from the newest approved BQ). Add a dependency
   (FS/SS/FF/SF, lag in working days, negative for a lead) from the new activity back to an
   earlier one: it is refused as a loop. *Progress* records actual dates and progress by
   **physical estimate** (whole percent) or **quantity installed** (done of total in a unit);
   100 % only with an actual finish, no future dates. Open the same activity in two tabs and
   save both: the second shows the version conflict and keeps the form.
4. **Working calendar**: untick Saturday and save; durations and variance are recounted in
   working days (public holidays from the attendance settings stay non-working). Tick it again.
5. **Baselines and variance**: baseline 1 *Contract programme* is current; the variance table
   shows each item's baseline and current dates with start and finish variance (unavailable for
   anything added after the baseline). **Re-baseline** with a name and a reason; confirm. The new
   baseline becomes current (variance back to "On baseline"); *Compare with baseline 1* still
   shows the slip against the contract programme. Baselines have no edit or delete anywhere: the
   database refuses UPDATE and DELETE even for the schema owner.
6. **Delay log**: totals by cause; each delay shows its period, working days lost of the working
   days in the period, the affected activities, an optional site diary and the **claim
   position** (the company's position for a claim; not a legal determination). *Record delay*,
   then *Amend* it with a reason and open *History*; *Withdraw* another with a reason: it stays
   in the log, struck through, and no longer counts.
7. Switch to Kiswahili and the dark theme, and narrow the window to 360 px: the page never
   scrolls sideways; the chart and tables scroll inside their own labelled regions.

## D6.3 measurement and valuations: measured progress to a payment certificate

Seeded data (synthetic): on **Ruiru Heights (RUI-HTS)** the contract settings are retention
10 % limited to 5 % of the original contract sum, VAT 16 %, materials on site at 100 % of cost
and half the retention released at practical completion. The site agent's measurements of BQ
items A, B and C carry site photos and were approved by the project manager; **IPC-0001** (with a
KES 50,000 mobilisation advance) and **IPC-0002** (materials in stores at cost, a KES 20,000
advance recovery, netting off IPC-0001) were prepared by the project manager and certified by
finance. One measurement of item C waits in the approval queue. Schedule tasks S02–S04 name items
A, B and C, and a maker-checked labour journal gives earned value an actual cost: **CPI 1.37,
SPI 0.63**, retention held **KES 56,940**. **Juja Road Duplex (JUJ-DPX)**, handed over, has two
interim certificates and **IPC-0003, the practical-completion retention release** (held KES
306,900 after it).

1. **Site agent at 360 px** (Kevin Kiprono, `site.agent@…`): **Valuations → RUI-HTS → Record
   measurement**. Pick a measured item (search by ref or words), type the quantity done **to
   date** (not this period), take a photo or pick a recent site photo (the verified badge is shown), submit.
   The measurement shows *Waiting for approval* and no approve button: the measurer never approves.
   Type a quantity above the BQ quantity: a reason is required before it can be submitted. A
   provisional sum is listed as *not measured*. Switch to Kiswahili and dark mode: nothing scrolls
   sideways.
2. **Project manager** (Brian Otieno, `pm@…`): **Valuations → Measurements to approve**. Check the
   photo and approve the item C measurement (the value at BQ rates is in the dialog); reject one
   with a reason to see it leave the queue. The measurement sheet shows approved quantity, %
   complete and value per item (unavailable, never 0 %, where an item has no basis).
3. **Project manager**: **Certificates → Start a valuation** (interim, today, optionally
   materials from stores). The draft is a preview of the cumulative certificate: work done from
   approved measurements up to the date, materials on site, retention (with its limit), agreed
   adjustments to date, previous certificates, amount due, VAT shown separately and the total.
   Add materials on site to an item whose work is almost complete: refused, they would be paid
   twice. Add an *advance recovery* larger than the advance: refused. **Submit for
   certification**: the figures and lines are frozen with a digest; there is no certify button for
   the preparer.
4. **Finance** (Daniel Mwangi, `finance@…`, TOTP): open the submitted valuation, **Certify**,
   confirm your identity (step-up). It becomes **IPC-0003** for RUI-HTS, locked. If a measurement
   had been approved after submission, certification would say the figures changed (stale).
   Download the **PDF (English and Kiswahili)** and **Excel**: project, client, original and
   revised contract sums, the valuation summary, lines, retention, previous certificates, amount
   due, VAT and signature blocks; drafts carry a *NOT CERTIFIED* watermark.
5. **Retention** tab: held and released amounts, completion dates and the ledger (each
   certificate's movement). On **JUJ-DPX** the practical-completion release (IPC-0003) halved the
   retention held; the final release becomes possible only after final completion is certified
   (D6.1).
6. **Earned value** tab (finance or owner): BAC, PV, EV, AC, CPI, SPI, CV, SV, EAC, ETC and VAC
   with the formulas; physical progress (schedule), earned, certified, invoiced (unavailable until
   D7.1) and cash received kept apart; the weekly **S-curve** (SVG, with the week-by-week table
   for screen readers and phones); **cost to complete** by bill, then by item for a bill.
7. **Contract settings** (finance): save a new version (e.g. materials on site 100 → 80 %):
   certified certificates keep the terms they used; a draft recalculates.
8. Sign in as a **client** or a **supplier** portal user, or open `/api/v1/valuations/<id>` as
   one: nothing — certificates, measurements and earned value are internal (the API e2e
   permission matrix covers clients, consultants, suppliers, site agents and another company).

## Automated evidence

```bash
pnpm --filter @pm-buddy/domain test
pnpm --filter @pm-buddy/validation test
pnpm --filter @pm-buddy/api exec vitest run --config vitest.config.e2e.ts test/diaries.e2e-spec.ts test/photos.e2e-spec.ts
pnpm --filter @pm-buddy/web exec playwright test test/diaries.spec.ts test/photos.spec.ts
# D6.1 quality and the diary workforce
pnpm --filter @pm-buddy/domain exec vitest run src/quality
pnpm --filter @pm-buddy/api exec vitest run --config vitest.config.e2e.ts test/quality.e2e-spec.ts
pnpm --filter @pm-buddy/web exec playwright test test/quality.spec.ts test/diaries.spec.ts
# D6.2 schedule
pnpm --filter @pm-buddy/domain exec vitest run src/schedule
pnpm --filter @pm-buddy/api exec vitest run --config vitest.config.e2e.ts test/schedule.e2e-spec.ts
pnpm --filter @pm-buddy/web exec playwright test test/schedule.spec.ts
# D6.3 measurement and valuations (the Phase 6 done-when test is valuations.e2e-spec.ts)
pnpm --filter @pm-buddy/domain exec vitest run src/valuations
pnpm --filter @pm-buddy/validation exec vitest run src/valuations.test.ts
pnpm --filter @pm-buddy/api exec vitest run --config vitest.config.e2e.ts test/valuations.e2e-spec.ts
pnpm --filter @pm-buddy/web exec playwright test test/valuations.spec.ts
```

The API suite uses the separate `pmb_test` database and real non-owner runtime role.
Browser tests use synthetic contract-mocked API data, not a real-API browser smoke.
They run an isolated `.next-e2e` server and leave existing development servers alone.
See [implementation status](../IMPLEMENTATION_STATUS.md) for actual local results.

## Phase 6 acceptance walkthrough

Phase 6 is accepted when D6.1–D6.3 work together on one freshly seeded company and **an interim
payment certificate generates correctly from measured progress** (ROADMAP). Start from a fresh
database (`db:migrate`, `db:seed`) and sign in as each person below (the seed output prints the
synthetic accounts; finance and the owner need TOTP).

| # | Step (who) | What to see | Deliverable |
|---|---|---|---|
| 1 | **Diary** (site agent, 360 px): today's RUI-HTS diary with the workforce from attendance and a verified photo; submit | Workforce snapshot by trade with its source; verified-photo badge from EXIF inside the geofence | D6.1 |
| 2 | **Diary approval** (project manager): approve the agent's diary | Independent sign-off; the approved diary is locked | D6.1 |
| 3 | **Quality** (project manager / owner): an inspection signed off by someone else; a cube set judged at 28 days; a snag fixed and verified; JUJ-DPX practical completion certified with its DLP end | Independent sign-offs; KE-CUBE-1; DLP end date | D6.1 |
| 4 | **Schedule** (project manager): RUI-HTS Gantt with the critical path, baseline 1 and the slip in working days; the delay log | Baseline frozen; variance in working days; physical % labelled as not earned value | D6.2 |
| 5 | **Measure** (site agent, 360 px): record a quantity to date with a site photo | Pending; the measurer cannot approve; over-measure needs a reason | D6.3 |
| 6 | **Approve** (project manager): approve it in the queue | Approved measured value at BQ rates on the sheet | D6.3 |
| 7 | **Interim valuation** (project manager): start, check the preview, submit | Work done from approved measurements; materials on site; retention with its limit; adjustments; previous certificates; amount due; VAT separate; frozen with a digest | D6.3 |
| 8 | **Certify** (finance, step-up): certify the submitted valuation; download the PDF in Kiswahili | `IPC-NNNN`, locked; the PDF matches the screen | **D6.3 — Phase 6 acceptance** |
| 9 | **Retention** (finance): RUI-HTS ledger; JUJ-DPX release IPC-0003 after the certified practical completion | Retention released only after a certified completion, never more than held | D6.3 + D6.1 |
| 10 | **Earned value** (finance): CPI, SPI, EAC with formulas; the S-curve and its table; cost to complete by bill | Undefined ratios unavailable; earned, certified, invoiced and received kept apart | D6.3 + D6.2 + D5.4 |
| 11 | **Outside parties**: a client or supplier cannot open certificates, measurements or earned value | 403/404; nothing internal leaks | D6.3 |

Automated evidence for the same chain: API e2e `diaries`, `photos`, `quality`, `schedule` and
`valuations` (the done-when test "generates IPC-0001 from measured progress, certified
independently on the digest seen", with hand-computed figures) plus `projects` (demo seed counts)
on the real runtime role; browser `diaries.spec.ts`, `photos.spec.ts`, `quality.spec.ts`,
`schedule.spec.ts` and `valuations.spec.ts`. Actual results are in
[IMPLEMENTATION_STATUS](../IMPLEMENTATION_STATUS.md#d63-measurement-and-valuations-branch-phase-6d63-valuations).

