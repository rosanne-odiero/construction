# Phase 6 demo: site diary and verified photos

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

## Automated evidence

```bash
pnpm --filter @pm-buddy/domain test
pnpm --filter @pm-buddy/validation test
pnpm --filter @pm-buddy/api exec vitest run --config vitest.config.e2e.ts test/diaries.e2e-spec.ts test/photos.e2e-spec.ts
pnpm --filter @pm-buddy/web exec playwright test test/diaries.spec.ts test/photos.spec.ts
```

The API suite uses the separate `pmb_test` database and real non-owner runtime role.
Browser tests use synthetic contract-mocked API data, not a real-API browser smoke.
They run an isolated `.next-e2e` server and leave existing development servers alone.
See [implementation status](../IMPLEMENTATION_STATUS.md) for actual local results.
