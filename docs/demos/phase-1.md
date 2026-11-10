# Phase 1 demo: foundation

Phase 1 has four deliverables (D1.1–D1.4). Each gets its own section here as it lands.

---

## D1.1: Workspace, tooling and CI

This walkthrough takes about 10 minutes. It is the first deliverable with a real backend: the **System status** page reads live data from the API. All other screens still show the D0 mock data.

### 1. Run it

Prerequisites: Node 24, pnpm 12 and Docker Desktop (running). On networks where Corepack can't download pnpm, prefix commands with `npx pnpm@12.17.0`.

```bash
git checkout phase-1/d1.1-workspace-ci
npx pnpm@12.17.0 install
npx pnpm@12.17.0 services:up     # PostgreSQL, Valkey, RustFS (S3) and Mailpit; waits until healthy
npx pnpm@12.17.0 db:migrate      # applies the base migration as the schema-owner role
npx pnpm@12.17.0 dev             # shared packages + API on :4000 + web on :3000
```

### 2. Walkthrough

| #   | What                     | Where                                                                                                                               | Try this                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | System status            | http://localhost:3000/status (sidebar footer → **System status**, or the last card on the tour)                                     | All four cards show **Operational** with response times. Switch **EN / SW** and the theme.                                                                                                                                                                                                                     |
| 2   | A service outage         | Terminal                                                                                                                            | Run `docker compose -f infra/docker/compose.yaml stop valkey`. Within 10 seconds the page turns amber without a reload: Valkey shows **Down** with the reason, the others stay up. Run `… start valkey` and watch it recover.                                                                                   |
| 3   | The API is down          | Terminal                                                                                                                            | Stop `pnpm dev` (Ctrl+C) and run only the web app: `npx pnpm@12.17.0 --filter @pm-buddy/web dev`. The page says the API can't be reached and lists the commands to fix it. Restart `pnpm dev` afterwards.                                                                                                       |
| 4   | API reference            | http://localhost:3000/api/docs                                                                                                      | Swagger UI, served by the API through the web app's same-origin `/api` rewrite (D-16). Open **GET /api/v1/health/ready** → **Try it out** → **Execute**.                                                                                                                                                       |
| 5   | Error format             | `curl -i -H 'X-Request-Id: demo-12345678' http://localhost:3000/api/v1/nope`                                                        | A 404 as `application/problem+json` (RFC 9457). The request ID comes back in the `X-Request-Id` header and as `traceId` in the body.                                                                                                                                                                         |
| 6   | Security headers         | `curl -sI http://localhost:4000/api/v1/health/live`                                                                                 | `Content-Security-Policy: default-src 'none';frame-ancestors 'none'`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, and no `X-Powered-By`.                                                                                                                                                     |
| 7   | Database roles           | `docker compose -f infra/docker/compose.yaml exec -e PGPASSWORD=pmb_app_dev postgres psql -h localhost -U pmb_app -d pmb -c "create table t(id int)"` | **Refused** (`permission denied for schema public`). The API's database role can't change the schema and can't bypass row-level security (ARCHITECTURE §6.1). Migrations use a separate owner role.                                                                                                             |
| 8   | Developer tools          | http://localhost:8025 and http://localhost:9001/rustfs/console/index.html (`pmbdev` / `pmbdevsecret`)                               | Mailpit stays empty until notifications land. The RustFS console shows the private `pmb-local` bucket the API created on start-up.                                                                                                                                                                              |
| 9   | The prototype still runs | http://localhost:3000                                                                                                               | Every D0 screen works as before. The banner now says screens show mock data unless marked **Live**. Registering a worker (`/labour` → **Register worker**) now uses the shared phone and age rules from `packages/domain`, the same code the API will use.                                                    |
| 10  | CI                       | `.github/`                                                                                                                          | `ci.yml`: format, lint, typecheck, unit tests, i18n check and build, plus API end-to-end tests against the same Docker services. `codeql.yml`, `security.yml` (gitleaks and dependency review) and Dependabot. They run on the first push or pull request. |

### 3. What changed under the hood

| Area            | What's new                                                                                                                                                                                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared packages | `types` (permission catalogue, roles), `domain` (Kenyan phones, money in minor units, age, geofences; 34 tests), `validation` (environment and health schemas), `config` (tsconfig presets)                                                                                 |
| API             | NestJS 12, ESM. Health endpoints at `/api/v1/health/live` and `/ready`. Errors as problem+json. Strict security headers. Request IDs. pino logs that leave out headers and query strings and redact secrets and personal data. OpenTelemetry tracing when a collector is configured. |
| Database        | PostgreSQL 18 with two roles: `pmb_migrator` (owns the schema) and `pmb_app` (the API: no DDL, no RLS bypass). The base migration adds the fail-closed `app.current_tenant_id()` helper that tenant tables use from D1.3.                                                    |
| Local services  | Valkey instead of Redis and RustFS instead of MinIO, for licensing and availability reasons (ARCHITECTURE D-24). The app only uses the Redis protocol and the S3 API, so the cloud services chosen in Phase 9 drop in.                                                     |
| Supply chain    | The lockfile works with any npm registry and uses sha512 hashes; CI actions are pinned to commits; Dependabot waits 7 days before proposing new releases (D-26).                                                                                                           |

### 4. Checks run for this deliverable

- `pnpm format:check` and `pnpm turbo run lint typecheck test i18n:check build`: 21 tasks green, 70 unit tests, 0 lint warnings.
- API end-to-end suite: 7 tests against the real services, on a separate `pmb_test` database, connected as the restricted `pmb_app` role.
- `actionlint` on the workflows: 0 findings. gitleaks on the git history: no leaks.
- A clean install from an empty package store verified all 1,105 packages against the lockfile's sha512 hashes.
- `/status` checked in English and Kiswahili, light and dark: all up, Valkey down, API unreachable, and automatic recovery.
- The production build: 8 client-side navigations across the prototype with 0 console errors.

### 5. Known limits

- In `pnpm dev` only, the browser console may show a React `removeChild` error if you click to another page while it is still compiling for the first time. It comes from development hot reloading and does not occur in production builds.
- Swagger UI requests are not written to the API request log; API calls are.
- CI has not run on GitHub yet: the branches still need to be pushed from the `rosanne-odiero` account.

### 6. How to give feedback

Reply with the **item number and what to change**, or **"approved"**. Feedback is fixed on the `phase-1/d1.1-workspace-ci` branch before D1.2 starts.
