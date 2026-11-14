# Portals demo: office, client and labourer

One sign-in page (`/sign-in`) sends each person to their portal by their role in the selected
company. Business data is live from the API; nothing in `/portal` or `/worker` is mock data (the
old client-portal prototype address, `/prototype/portal`, now redirects to `/portal`).

| Who | Portal | Signs in with | Sees |
|---|---|---|---|
| Company staff (owner, PM, QS, site agent, finance…) | Office app, `/projects` | Email or phone + password, or Google; MFA where the role requires it | Everything their permissions allow |
| Clients (role `client`) | `/portal` | Email or phone + password, or Google | Assigned projects: progress and S-curve, milestones, site photos, approved site diaries, certificates and statement, how to pay, variations to decide, indicative USD/GBP/EUR (D7.1; walkthrough in [phase-7.md](./phase-7.md)) |
| Labourers (role `labourer`) | `/worker` | Kenyan phone + 6-digit PIN | Company, assigned projects and sites; attendance and pay "coming" |

## Try it locally

Start the stack (root README), run `pnpm db:migrate`, and sign in as a seeded owner or project
manager (`pnpm db:seed` prints the accounts).

1. **Labourer.** Open a project → **Team** → **Invite a labourer**, enter a Kenyan mobile such
   as `0712 345 678`. Open Mailpit (http://localhost:8025): the development SMS carries a
   `/worker/join?token=…` link. Open it in another browser profile, enter the same number, a
   name and a PIN (try `123456` to see it refused), and you land in `/worker`. Sign out, then
   sign in on `/sign-in` → **Labourer PIN**. Visiting `/projects` sends you back to `/worker`.
   **Forgot PIN?** sends a reset link to Mailpit.
2. **Client.** The seed prints a synthetic client already assigned to Ruiru Heights (RUI-HTS);
   sign in with it and you land in `/portal` (see [phase-7.md](./phase-7.md) for the D7.1
   walkthrough). To add another, invite an email address with role **Client** and the project in
   the account console (`/foundation`), register it, accept and sign in. Approve a site diary in
   the office app (author and reviewer must differ) and it appears under **Site updates**; drafts
   never do.
3. **Staff.** Signing in as staff opens the office app; `/portal` and `/worker` redirect back.
4. **Google.** Set `AUTH_GOOGLE_CLIENT_ID`/`AUTH_GOOGLE_CLIENT_SECRET` (see the API README) and
   "Continue with Google" appears on `/sign-in` and on the **Create account** card; the person
   still goes to the portal their role gives them.

## Not yet included

Client: Pay with M-Pesa (STK Push) waits for the Daraja integration (D4.2); clients pay by the
Paybill instructions and finance records the receipt. Labourer: attendance, pay, USSD and a
production SMS provider (D7.3). Unlinking Google from an account.

## Automated evidence

```bash
pnpm --filter @pm-buddy/api exec vitest run --config vitest.config.e2e.ts test/portals.e2e-spec.ts test/client-portal.e2e-spec.ts test/google.e2e-spec.ts
pnpm --filter @pm-buddy/web exec playwright test test/portals.spec.ts test/client-portal.spec.ts test/sign-in.spec.ts
```
