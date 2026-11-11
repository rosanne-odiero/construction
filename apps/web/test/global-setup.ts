import type { FullConfig } from "@playwright/test";

/**
 * `next dev` compiles each route on its first request. With many parallel workers the first
 * visits all compile at once and slow navigations past the expectation timeouts, so the live
 * routes are requested once, one after another, before the tests start (the mock API answers).
 */
const ROUTES = [
  "/projects",
  "/projects/30000000-0000-4000-8000-000000000001",
  "/projects/30000000-0000-4000-8000-000000000001/sites/new",
  "/projects/30000000-0000-4000-8000-000000000001/sites/31000000-0000-4000-8000-000000000001",
  "/projects/30000000-0000-4000-8000-000000000001/bq",
  "/projects/30000000-0000-4000-8000-000000000001/bq/import",
  "/labour",
  "/labour/register",
  "/labour/42000000-0000-4000-8000-000000000001/consent",
  "/labour/gangs",
  "/labour/gangs/43000000-0000-4000-8000-000000000001",
  "/labour/setup",
  "/labour/alerts",
];

export default async function warmUp(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) return;
  for (const route of ROUTES)
    await fetch(`${baseURL}${route}`, {
      headers: { cookie: "pmb_at=owner.warm-up" },
      signal: AbortSignal.timeout(120_000),
    }).catch(() => undefined);
}
