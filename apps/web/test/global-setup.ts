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
  "/attendance",
  "/attendance/muster?project=30000000-0000-4000-8000-000000000001&site=31000000-0000-4000-8000-000000000001&date=2026-11-10",
  "/attendance/periods?project=30000000-0000-4000-8000-000000000001",
  "/attendance/periods/00000000-0000-4000-8000-000000000000",
  "/attendance/anomalies",
  "/attendance/settings",
  "/procurement",
  "/procurement/requisitions",
  "/procurement/requisitions/new",
  "/procurement/rfqs",
  "/procurement/rfqs/new",
  "/procurement/lpos",
  "/procurement/grns",
  "/procurement/grns/new",
  "/procurement/invoices",
  "/procurement/invoices/new",
  "/catalogue/alerts",
  "/stores",
  "/stores/transfers",
  "/stores/stock-takes",
  "/stores/variance",
  "/stores/settings",
  "/stores/73000000-0000-4000-8000-000000000001",
  "/stores/73000000-0000-4000-8000-000000000001/ledger",
  "/stores/73000000-0000-4000-8000-000000000001/issue",
  "/stores/73000000-0000-4000-8000-000000000001/wastage",
  "/stores/73000000-0000-4000-8000-000000000001/transfer",
  "/stores/73000000-0000-4000-8000-000000000001/reorder-levels",
  "/rate-buildups/50000000-0000-4000-8000-000000000001",
  // Unknown IDs answer 404 but compile the procurement detail routes.
  "/procurement/requisitions/00000000-0000-4000-8000-000000000000",
  "/procurement/requisitions/00000000-0000-4000-8000-000000000000/edit",
  "/procurement/rfqs/00000000-0000-4000-8000-000000000000",
  "/procurement/lpos/00000000-0000-4000-8000-000000000000",
  "/procurement/lpos/00000000-0000-4000-8000-000000000000/print",
  "/procurement/grns/00000000-0000-4000-8000-000000000000",
  "/procurement/invoices/00000000-0000-4000-8000-000000000000",
  "/procurement/invoices/00000000-0000-4000-8000-000000000000/edit",
  "/stores/movements/00000000-0000-4000-8000-000000000000",
  "/stores/movements/00000000-0000-4000-8000-000000000000/return",
  "/stores/transfers/00000000-0000-4000-8000-000000000000",
  "/stores/stock-takes/00000000-0000-4000-8000-000000000000",
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
