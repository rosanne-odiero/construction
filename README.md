# PM-Buddy

Construction project management for Kenya: a secure, multi-tenant system for contractors, developers and home builders (including diaspora clients). It covers:

- Bill of Quantities–based cost and progress tracking
- Labour management with biometric attendance
- Payroll with M-Pesa payouts
- Materials and stores
- An offline-first site app
- Client, supplier and USSD self-service

> **Status: Phase 1, deliverable D1.1 (workspace, tooling and CI) in review.** D0 (design pack and clickable prototype) is approved. Most screens still show **mock data**; the `/status` page is the first one on the real API. See the [roadmap](docs/ROADMAP.md) for the 32 deliverables.

## Documents

| Document                                         | What it covers                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| [Project brief](docs/PROJECT_BRIEF.md)           | The original requirements                                                       |
| [Roadmap](docs/ROADMAP.md)                       | Phases → deliverables, review gates, definition of done                         |
| [Architecture](docs/ARCHITECTURE.md)             | System design, folder structure, security, payments, offline sync, decision log |
| [ERD](docs/ERD.md)                               | Data model (Mermaid), split by domain                                           |
| [OpenAPI outline](docs/api/openapi-outline.yaml) | REST API outline (OpenAPI 3.1)                                                  |
| [Threat model](docs/THREAT_MODEL.md)             | STRIDE analysis and domain abuse cases                                          |
| [DPIA template](docs/DPIA_TEMPLATE.md)           | Data protection impact assessment for biometric attendance                      |
| [Compliance TODO](docs/COMPLIANCE_TODO.md)       | Legal, tax and regulatory items awaiting expert confirmation                    |
| [Configuration register](docs/CONFIGURATION.md)  | Every configurable rule, its seed value and status                              |
| [Open questions](docs/QUESTIONS.md)              | Decisions needed from the product owner                                         |
| [Phase 0 demo script](docs/demos/phase-0.md)     | How to run and review the prototype                                             |
| [Phase 1 demo script](docs/demos/phase-1.md)     | How to run and review the Phase 1 deliverables                                  |

## Quick start

Prerequisites: **Node 24**, **pnpm 12** and **Docker** (Docker Desktop on macOS or Windows). If Corepack can't download pnpm on your network, use `npx pnpm@12.17.0` in place of `pnpm`.

```bash
pnpm install
pnpm services:up   # PostgreSQL, Valkey, RustFS (S3) and Mailpit in Docker, waits until healthy
pnpm db:migrate    # apply database migrations
pnpm dev           # shared packages, API on :4000 and web on :3000, all in watch mode
```

Then open http://localhost:3000/status: every service should show **Operational**.

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
pnpm test:e2e      # API end-to-end tests; needs `pnpm services:up`
```

`pnpm services:down` stops the containers and keeps the data. To start again from empty databases and storage, run `docker compose -f infra/docker/compose.yaml down -v`. All local credentials are throwaway development values ([configuration §8](docs/CONFIGURATION.md#8-process-environment-deployment-settings)).

## Repository layout (today)

```text
apps/web/          Next.js (App Router) + Tailwind + shadcn/ui: prototype screens and /status
  messages/        English and Kiswahili catalogues
  src/mocks/       Mock data (replaced by the API from D1.3 onwards)
apps/api/          NestJS 12 API: health module, Prisma 7, pino logging, OpenAPI
packages/types/    Permission catalogue, roles, shared types
packages/domain/   Pure business rules: Kenyan phones, money, age, geofences
packages/validation/ Zod schemas shared by web and API (environment, health, primitives)
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
