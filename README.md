# PM-Buddy

Construction project management for Kenya: a secure, multi-tenant system for contractors, developers and home builders (including diaspora clients). It covers:

- Bill of Quantities–based cost and progress tracking
- Labour management with biometric attendance
- Payroll with M-Pesa payouts
- Materials and stores
- An offline-first site app
- Client, supplier and USSD self-service

> **Status: Phase 1 core foundation implemented and locally verified; full phase acceptance remains open. D2.1 (projects, sites and geofences) is in progress.** D0 (design pack and clickable prototype) is approved. Business screens remain **mock data** except `/projects`; `/sign-in`, `/projects`, `/foundation` and `/status` use the real API. See [implementation status](docs/IMPLEMENTATION_STATUS.md) for exact evidence and missing requirements, and the [roadmap](docs/ROADMAP.md) for all deliverables.

> **Safeguard integration:** D1.1–D1.4 implementation is approved, not automatically accepted. See [implementation status](docs/IMPLEMENTATION_STATUS.md) and [acceptance matrix](docs/ACCEPTANCE_MATRIX.md) for actual evidence and remaining work. Business previews remain mock data. No live pilot, payments or biometrics are approved.

## Documents

| Document                                               | What it covers                                                                   |
| ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| [Project brief](docs/PROJECT_BRIEF.md)                 | Original scope plus mandatory workflow, payment, offline and release safeguards  |
| [Implementation status](docs/IMPLEMENTATION_STATUS.md) | Changes, actual commands/results, limitations and next step                      |
| [Acceptance matrix](docs/ACCEPTANCE_MATRIX.md)         | Requirement coverage and mandatory failure-mode evidence                         |
| [Workflows](docs/WORKFLOWS.md)                         | State machines, actors, preconditions, retry and audit contracts                 |
| [Invariants](docs/INVARIANTS.md)                       | Database/business correctness constraints and required tests                     |
| [Financial model](docs/FINANCIAL_MODEL.md)             | Proposed postings, precision, allocations, reversals and closure                 |
| [Offline sync](docs/OFFLINE_SYNC.md)                   | Deduplication, conflict review, revoked devices and uploads                      |
| [Operations](docs/OPERATIONS.md)                       | Alerts, support boundaries and coherent restore/reconciliation                   |
| [Release plan](docs/RELEASE_PLAN.md)                   | Environments, migration compatibility, rollback and release gates                |
| [Pilot design](docs/PILOT_PLAN.md)                     | One-site design/delivery order approved; live activation still gated             |
| [Roadmap](docs/ROADMAP.md)                             | Phases → deliverables, review gates, definition of done                          |
| [Architecture](docs/ARCHITECTURE.md)                   | System design, folder structure, security, payments, offline sync, decision log  |
| [ERD](docs/ERD.md)                                     | Data model (Mermaid), split by domain                                            |
| [OpenAPI outline](docs/api/openapi-outline.yaml)       | REST API outline (OpenAPI 3.1)                                                   |
| [Threat model](docs/THREAT_MODEL.md)                   | STRIDE analysis and domain abuse cases                                           |
| [DPIA template](docs/DPIA_TEMPLATE.md)                 | Data protection impact assessment for biometric attendance                       |
| [Compliance TODO](docs/COMPLIANCE_TODO.md)             | Legal, tax and regulatory items awaiting expert confirmation                     |
| [Configuration register](docs/CONFIGURATION.md)        | Every configurable rule, its seed value and status                               |
| [Open questions](docs/QUESTIONS.md)                    | Decisions needed from the product owner                                          |
| [Phase 0 demo script](docs/demos/phase-0.md)           | How to run and review the prototype                                              |
| [Phase 1 demo script](docs/demos/phase-1.md)           | How to run and review the Phase 1 deliverables                                   |
| [Phase 2 demo script](docs/demos/phase-2.md)           | How to run and review the Phase 2 deliverables (D2.1 projects, sites, geofences) |

## Quick start

Prerequisites: **Node 24**, **pnpm 12** and **Docker** (Docker Desktop on macOS or Windows). If Corepack can't download pnpm on your network, use `npx pnpm@12.17.0` in place of `pnpm`.

```bash
pnpm install
pnpm services:up   # PostgreSQL, Valkey, RustFS (S3) and Mailpit in Docker, waits until healthy
pnpm db:migrate    # apply database migrations
pnpm db:seed       # optional: synthetic demo company and projects; prints demo sign-ins (never in production)
pnpm dev           # shared packages, API on :4000 and web on :3000, all in watch mode
```

Then open http://localhost:3000/status: every service should show **Operational**.

Foundation review: `/foundation` (API-backed identity/company setup) and `/design-system` (EN/SW, light/dark controls and states). Since D2.1, `/sign-in` signs in against the real API and `/projects` (list, detail, sites and geofence editor, team, WBS and milestones) is live; sign in with an account printed by `pnpm db:seed` (see the [Phase 2 demo](docs/demos/phase-2.md)). Other business dashboards remain labelled prototype routes. The web manifest supplies installation metadata only; it does not imply offline payroll/attendance capability or cache sensitive records.

| URL                                             | What                                       |
| ----------------------------------------------- | ------------------------------------------ |
| http://localhost:3000                           | Web app (prototype tour)                   |
| http://localhost:3000/status                    | Live system status                         |
| http://localhost:3000/api/docs                  | API reference (Swagger UI) through the web |
| http://localhost:4000/api/v1/health/ready       | API readiness (JSON)                       |
| http://localhost:8025                           | Mailpit: emails sent in development        |
| http://localhost:9001/rustfs/console/index.html | RustFS console (`pmbdev` / `pmbdevsecret`) |

Checks (CI runs the same):

```bash
pnpm format:check
pnpm turbo run lint typecheck test i18n:check build
pnpm test:e2e      # API and web browser tests; API needs `pnpm services:up`
```

Before the first web browser run, install its browser: `pnpm --filter @pm-buddy/web exec playwright install --no-shell chromium`.

To run the checks from a second checkout (for example a `git worktree`) while the first is running, point its `apps/api/.env` at a second compose stack on other ports. The API e2e tests read Mailpit from `AUTH_MAILPIT_PORT`, and the browser tests take `PLAYWRIGHT_WEB_PORT` (default 3100) and `PLAYWRIGHT_MOCK_API_PORT` (default 3199).

`pnpm services:down` stops the containers and keeps the data. To start again from empty databases and storage, run `docker compose -f infra/docker/compose.yaml down -v`. All local credentials are throwaway development values ([configuration §8](docs/CONFIGURATION.md#8-process-environment-deployment-settings)).

## Repository layout (today)

```text
apps/web/          Next.js + shared design system: /foundation, /status and labelled business previews
  src/mocks/       Mock data (replaced by the API from D1.3 onwards)
apps/api/          NestJS API: health, identity/MFA/sessions, tenancy, roles and permissions, project access and audit
packages/i18n/     English and Kiswahili ICU catalogues (src/messages) and the i18n:check parity script
packages/types/    Permission catalogue, system role defaults, shared types
packages/domain/   Pure business rules: Kenyan phones, money, age, geofences
packages/validation/ Shared Zod request primitives and foundation response contracts
packages/config/   Shared tsconfig presets
infra/docker/      Local services (compose.yaml) and database role setup
.github/           CI, CodeQL, secret scanning, dependency review, Dependabot
docs/              Design pack, demo scripts
```

The full target structure (API, site app, shared packages, infrastructure) is in [ARCHITECTURE §5](docs/ARCHITECTURE.md#5-folder-structure).

## How we work

- One deliverable at a time, each on its own branch (`phase-N/dN.x-slug`) with [Conventional Commits](https://www.conventionalcommits.org/).
- Every deliverable ends with a running frontend to review, a demo script in `docs/demos/`, and an explicit approval before the next one starts.
- No secrets in the repository. Tax, statutory and M-Pesa rules are configuration, never code. Anything legal is flagged `COMPLIANCE-REVIEW`.
