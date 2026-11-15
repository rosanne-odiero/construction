# Local Daraja mock

Development and tests only: no Safaricom calls and no real money. The server binds to loopback
on port 4690. Never expose it publicly: its control endpoints are intentionally unauthenticated.
It delivers callbacks only to loopback HTTP URLs (`127.0.0.1` or `localhost`); a callback URL
naming another host or scheme is recorded as refused and never requested.

```bash
pnpm --filter @pm-buddy/mock-daraja build
pnpm --filter @pm-buddy/mock-daraja start
curl http://127.0.0.1:4690/__mock/health
```

Set the API's `DARAJA_MOCK_BASE_URL=http://127.0.0.1:4690` and
`PAYMENTS_CALLBACK_BASE_URL=http://127.0.0.1:4000` (adjust for its port). Configure **mock**
payments in the payments console, then enter synthetic consumer key, consumer secret,
initiator name/password and passkey. Do not reuse sandbox or production secrets.
The mock supplies its own generated certificate. Payouts start paused.

Supported calls: OAuth, STK Push/query, C2B URL registration, B2C, B2B Paybill/Buy Goods,
Transaction Status, Account Balance and reversal. It validates SecurityCredential against its
test key and records redacted request bodies.

## Scenarios

The following **KES whole-shilling amounts**, not minor units, select an outcome. Every other
amount succeeds. For example, enter KES 1,006 in the console, or `amountMinor: 100600` through
the API, to test duplicate callbacks.

| KES   | Scenario                                                                            |
| ----- | ----------------------------------------------------------------------------------- |
| 1,001 | Failure (STK cancellation; B2C/B2B failure)                                         |
| 1,002 | Insufficient balance                                                                |
| 1,003 | No result callback; status query reports completion                                 |
| 1,004 | No result callback; status query reports failure                                    |
| 1,005 | Lost HTTP acknowledgement, then success callback                                    |
| 1,006 | Duplicate success callbacks                                                         |
| 1,007 | Success followed by a late timeout                                                  |
| 1,008 | Success followed by a conflicting failure                                           |
| 1,009 | Success plus an unknown callback                                                    |
| 1,010 | Callback amount mismatch                                                            |
| 1,011 | Submission refused (HTTP 400)                                                       |
| 1,012 | HTTP 500 after processing; uncertain outcome                                        |
| 1,013 | Interim result followed by success                                                  |
| 1,014 | Result callback before the HTTP acknowledgement                                     |
| 1,015 | No result callback; first status query refused as busy, the next reports completion |

`MOCK_DARAJA_PORT` defaults to 4690; `MOCK_DARAJA_CALLBACK_DELAY_MS` to 500;
`MOCK_DARAJA_RESPONSE_DELAY_MS` to 20000. Keep the last larger than the API's HTTP timeout
when testing a lost acknowledgement. `MOCK_DARAJA_EXTERNAL_VALIDATION=true` also sends C2B
validation before confirmation.

## Control endpoints

- `GET /__mock/certificate`: generated public test certificate.
- `GET /__mock/state`: recorded requests and callback deliveries.
- `POST /__mock/scenario` with `{"scenario":"duplicate_callback"}`: select the next outcome;
  names are listed in [scenarios.ts](src/scenarios.ts). A reversal honours only `server_error`
  (HTTP 500, uncertain outcome, no result).
- `POST /__mock/c2b` with
  `{"shortCode":"600966","amount":1500,"billRefNumber":"TEST-INV"}`: simulate a payment to
  previously registered C2B URLs. Amount is in whole shillings.
- `POST /__mock/reset`: clear test state.

The API integration suite starts and closes its own mock on an ephemeral port:

```bash
pnpm --filter @pm-buddy/api exec vitest run --config vitest.config.e2e.ts test/payments.e2e-spec.ts
```

It needs the checkout's PostgreSQL and Valkey services. The optional real-provider sandbox suite
is separate; passing this mock suite is not evidence that Safaricom sandbox or production works.
