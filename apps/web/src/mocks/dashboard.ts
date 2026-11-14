import { musterSummary } from "./attendance";
import { payrollBatch } from "./payroll";
import { projects } from "./projects";

export const kpis = {
  cashMinor: 7_842_300_00,
  cashChange: 0.12,
  mpesaFloatMinor: payrollBatch.floatMinor,
  spendMonthMinor: 3_624_000_00,
  spendPlanMinor: 4_100_000_00,
  workersToday: projects.reduce((a, p) => a + p.workersToday, 0),
  workersRostered: projects.reduce((a, p) => a + p.workersRostered, 0),
  awaitingApproval: 2,
  awaitingApprovalMinor: payrollBatch.netMinor + 214_600_00,
};

export const spendByCategory = [
  { key: "materials", amount: 1_918_400 },
  { key: "labour", amount: 1_082_600 },
  { key: "plant", amount: 214_000 },
  { key: "subcontract", amount: 180_000 },
  { key: "preliminaries", amount: 124_500 },
  { key: "transport", amount: 62_800 },
  { key: "pettyCash", amount: 35_600 },
  { key: "mpesaCharges", amount: 6_100 },
] as const;

export const cashFlowForecast = [
  { week: "16/11", inflow: 0, outflow: 0.61 },
  { week: "23/11", inflow: 1.25, outflow: 1.49 },
  { week: "30/11", inflow: 6.85, outflow: 0.98 },
  { week: "07/12", inflow: 0, outflow: 1.12 },
  { week: "14/12", inflow: 0, outflow: 0.87 },
  { week: "21/12", inflow: 2.1, outflow: 1.34 },
];

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

export const upcomingPayments = [
  {
    key: "payrollRuiru",
    date: "2026-11-13",
    amountMinor: payrollBatch.netMinor,
    direction: "out",
    state: "awaitingApproval",
    href: "/prototype/payroll",
  },
  {
    key: "payrollKitengela",
    date: "2026-11-13",
    amountMinor: 96_400_00,
    direction: "out",
    state: "prepared",
    href: "/prototype/payroll",
  },
  {
    key: "lpo42",
    date: "2026-11-18",
    amountMinor: 486_500_00,
    direction: "out",
    state: "matched",
    href: "/soon/materials",
  },
  {
    key: "lpo45",
    date: "2026-11-20",
    amountMinor: 214_600_00,
    direction: "out",
    state: "blocked",
    href: "/soon/materials",
  },
  {
    key: "ipc3",
    date: "2026-11-20",
    amountMinor: 1_245_600_00,
    direction: "in",
    state: "due",
    href: "/portal",
  },
] as const;

export const attendanceToday = musterSummary;
