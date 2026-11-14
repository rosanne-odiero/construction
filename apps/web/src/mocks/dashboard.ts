/**
 * Prototype alerts for the top bar on D0 prototype pages only (the live dashboard, D8.1, reads the
 * API; notifications arrive with D7.3).
 */
export type AlertSeverity = "critical" | "warning" | "info";
export interface DashboardAlert {
  key:
    | "materialVariance"
    | "impossibleTravel"
    | "budgetThreshold"
    | "unusualPayout"
    | "accreditationExpiry"
    | "etimsMissing"
    | "documentExpiry";
  severity: AlertSeverity;
  project: string;
  href: string;
  params: Record<string, string | number>;
}

export const alerts: DashboardAlert[] = [
  {
    key: "materialVariance",
    severity: "critical",
    project: "Ruiru Heights",
    href: "/soon/stores",
    params: { pct: 18, bill: "3", week: 45 },
  },
  {
    key: "impossibleTravel",
    severity: "critical",
    project: "Ruiru Heights",
    href: "/attendance",
    params: { name: "Erick Owino Onyango", km: 34, minutes: 25 },
  },
  {
    key: "budgetThreshold",
    severity: "warning",
    project: "Ruiru Heights",
    href: "/prototype/projects/ruiru-heights",
    params: { pct: 85, bill: "3" },
  },
  {
    key: "unusualPayout",
    severity: "warning",
    project: "Kitengela Bungalow",
    href: "/soon/payments",
    params: { amount: "KES 85,000", phone: "2547•••••311" },
  },
  {
    key: "etimsMissing",
    severity: "warning",
    project: "Ruiru Heights",
    href: "/soon/materials",
    params: { invoice: "INV-7781", supplier: "Juja Quarry Products" },
  },
  {
    key: "accreditationExpiry",
    severity: "warning",
    project: "Ruiru Heights",
    href: "/labour",
    params: { count: 2, days: 30 },
  },
  {
    key: "documentExpiry",
    severity: "info",
    project: "Ruiru Heights",
    href: "/documents",
    params: { date: "30/11/2026" },
  },
];
