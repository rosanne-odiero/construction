# D4.2: Daraja payments review

This is a mock/sandbox transport review, not approval for real money or D4.3 payroll payouts.
Use the existing synthetic company and a company-wide owner/finance account with MFA.

## Local mock

1. Start the checkout's Docker services, apply migrations, and build shared packages and the API.
2. Start the [mock Daraja server](../../apps/mock-daraja/README.md), then the API and web.
   Use separate ports/services for another checkout; do not reset someone else's database.
3. Open `/payments`. As owner, initialise payment settings in **mock**, configure synthetic
   STK `174379`, C2B `600966`, B2C `600992`, B2B `600993`, and synthetic credentials.
   Credentials are write-only. Limits are explicitly DEMO; payouts start off.
4. Create an STK test collection for KES 250 to a synthetic Kenyan test phone, account `TEST-INV`.
   The timeline must show queued/submitting/pending before a reconciled callback confirms it.
   The creation response and provider acknowledgement are not proof of payment.
5. Create a B2C test payout with payouts still paused: it stays queued. Enable payouts with a fresh
   step-up, then follow the request to confirmation. No payroll or supplier invoice is settled.
6. Exercise KES 1,001 (failure), 1,006 (duplicates), 1,007 (late timeout), 1,008 (conflict),
   1,009 (unknown callback) and 1,010 (amount mismatch). Inspect callback alerts/cases and the
   request's timeline. Duplicates create no second receipt; a late failure never undoes confirmation.
7. KES 1,003 loses its result. After the configured result timeout, it becomes unknown.
   A B2C status query can reconcile; STK Query success without a receipt stays unverified and
   needs an independent reviewer with exact statement evidence.
8. Request an Account Balance check: it is advisory, never a reservation. Register C2B URLs,
   then use the mock's C2B control endpoint. Its receipt remains **unallocated**.
9. A distinct authorised reviewer can request a reversal of a confirmed test payment with fresh
   MFA and a reason. Check the separate reversal attempt and final reversed state.
10. Check English/Kiswahili and phone-width screens. Finance must not see credential values or
    unmasked callback URLs; clients/suppliers must not enter the office console.

```bash
pnpm turbo run lint typecheck test build --filter=@pm-buddy/api --filter=@pm-buddy/mock-daraja
pnpm --filter @pm-buddy/api exec vitest run --config vitest.config.e2e.ts test/payments.e2e-spec.ts
```

## Sandbox gate

The optional suite skips unless **all** of these test-process variables are supplied securely:

`DARAJA_SANDBOX_CONSUMER_KEY`, `DARAJA_SANDBOX_CONSUMER_SECRET`,
`DARAJA_SANDBOX_PASSKEY`, `DARAJA_SANDBOX_INITIATOR_NAME`,
`DARAJA_SANDBOX_INITIATOR_PASSWORD`, `DARAJA_SANDBOX_SHORTCODE`,
`DARAJA_SANDBOX_B2C_SHORTCODE`, `DARAJA_SANDBOX_PHONE`,
`DARAJA_SANDBOX_CERTIFICATE_PATH`, `DARAJA_SANDBOX_CALLBACK_BASE_URL`.

The callback base must be an approved public HTTPS endpoint reaching this **test API**.
Set `DARAJA_SANDBOX_LISTEN_PORT` to the forwarded port (otherwise the suite listens on an
ephemeral port). Do not expose a developer database, an unauthenticated mock or unrelated
services. Do not open a public tunnel or use existing credentials without the owner's approval.

```bash
pnpm --filter @pm-buddy/api exec vitest run --config vitest.config.e2e.ts test/payments-sandbox.e2e-spec.ts
```

The current sandbox smoke checks that an STK submission leaves the queue without claiming
settlement from the creation response. It is **not** end-to-end sandbox certification: retain
evidence of callback reconciliation and verify the other enabled operations, current endpoint
versions, shortcodes, limits and certificate with Safaricom before accepting D4.2's sandbox gate.
Production remains blocked under CR-PMT-01–04.

## Still outside this review

- D4.3: business approvals, bulk payroll payouts, recipient-name checks, tariffs, statement uploads,
  allocation to obligations/invoices, SMS payslips and production go-live.
- D7.1 payment completion: the portal remains on its disabled STK boundary until certificate-bound
  receipt allocation and safe account references are implemented. C2B is not automatically
  allocated to certificates. Nothing in the console marks a client certificate as paid.
