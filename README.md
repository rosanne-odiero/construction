# PM-Buddy

Construction project management for Kenya: a secure, multi-tenant system for contractors, developers and home builders (including diaspora clients). It covers:

- Bill of Quantities–based cost and progress tracking
- Labour management with biometric attendance
- Payroll with M-Pesa payouts
- Materials and stores
- An offline-first site app
- Client, supplier and USSD self-service

> **Status: Phase 0 (design), deliverable D0 in review.** This branch contains the design pack and a **clickable prototype with mock data**. See the [roadmap](docs/ROADMAP.md) for the 32 deliverables to come.

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

## Quick start

Prerequisites: **Node 24** and **pnpm 12**. If Corepack can't download pnpm on your network, use `npx pnpm@12.17.0` in place of `pnpm`.

```bash
pnpm install
pnpm dev        # web app on http://localhost:3000
pnpm lint       # ESLint across the workspace
pnpm typecheck  # TypeScript (strict)
pnpm build      # production build
```

## Repository layout (today)

```text
apps/web/        Next.js (App Router) + Tailwind + shadcn/ui: the D0 clickable prototype
  messages/      English and Kiswahili catalogues
  src/mocks/     Mock data (replaced by the API from Phase 1)
docs/            Design pack, demo scripts
```

The full target structure (API, site app, shared packages, infrastructure) is in [ARCHITECTURE §5](docs/ARCHITECTURE.md#5-folder-structure).

## How we work

- One deliverable at a time, each on its own branch (`phase-N/dN.x-slug`) with [Conventional Commits](https://www.conventionalcommits.org/).
- Every deliverable ends with a running frontend to review, a demo script in `docs/demos/`, and an explicit approval before the next one starts.
- No secrets in the repository. Tax, statutory and M-Pesa rules are configuration, never code. Anything legal is flagged `COMPLIANCE-REVIEW`.
