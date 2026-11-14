# Phase 6 demo: site diary, verified photos and the schedule

This is increment 1 of D6.1, **not** Phase 6 acceptance. It records online web diaries
against real projects/sites. Workforce is manual; attendance auto-fill, photos,
quality inspections/tests/snags, offline/site-app capture, schedules and valuations
remain pending. No biometric collection, payouts, deployment or pilot is authorised.

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

## Automated evidence

```bash
pnpm --filter @pm-buddy/domain test
pnpm --filter @pm-buddy/validation test
pnpm --filter @pm-buddy/api exec vitest run --config vitest.config.e2e.ts test/diaries.e2e-spec.ts test/photos.e2e-spec.ts
pnpm --filter @pm-buddy/web exec playwright test test/diaries.spec.ts test/photos.spec.ts
# D6.2 schedule
pnpm --filter @pm-buddy/domain exec vitest run src/schedule
pnpm --filter @pm-buddy/api exec vitest run --config vitest.config.e2e.ts test/schedule.e2e-spec.ts
pnpm --filter @pm-buddy/web exec playwright test test/schedule.spec.ts
```

The API suite uses the separate `pmb_test` database and real non-owner runtime role.
Browser tests use synthetic contract-mocked API data, not a real-API browser smoke.
They run an isolated `.next-e2e` server and leave existing development servers alone.
See [implementation status](../IMPLEMENTATION_STATUS.md) for actual local results.
