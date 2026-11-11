import {
  Banknote,
  Building,
  Calculator,
  ChartColumn,
  FileSpreadsheet,
  FolderOpen,
  Forklift,
  HardHat,
  LayoutDashboard,
  NotebookPen,
  Package,
  Receipt,
  ScanFace,
  ShieldAlert,
  Wallet,
  Warehouse,
  type LucideIcon,
} from "lucide-react";

export type NavKey =
  | "dashboard"
  | "projects"
  | "bq"
  | "valuations"
  | "labour"
  | "attendance"
  | "diary"
  | "materials"
  | "stores"
  | "plant"
  | "safety"
  | "payroll"
  | "payments"
  | "spending"
  | "documents"
  | "reports";

export interface NavItem {
  key: NavKey;
  href: string;
  icon: LucideIcon;
  phase?: number;
}

export const navGroups: {
  key: "overview" | "commercial" | "site" | "finance" | "records";
  items: NavItem[];
}[] = [
  {
    key: "overview",
    items: [
      { key: "dashboard", href: "/dashboard", icon: LayoutDashboard },
      { key: "projects", href: "/projects", icon: Building },
    ],
  },
  {
    key: "commercial",
    items: [
      { key: "bq", href: "/prototype/projects/ruiru-heights/bq", icon: FileSpreadsheet },
      { key: "valuations", href: "/soon/valuations", icon: Calculator, phase: 6 },
    ],
  },
  {
    key: "site",
    items: [
      { key: "labour", href: "/labour", icon: HardHat },
      { key: "attendance", href: "/attendance", icon: ScanFace },
      { key: "diary", href: "/diary", icon: NotebookPen },
      { key: "materials", href: "/soon/materials", icon: Package, phase: 5 },
      { key: "stores", href: "/soon/stores", icon: Warehouse, phase: 5 },
      { key: "plant", href: "/soon/plant", icon: Forklift, phase: 8 },
      { key: "safety", href: "/soon/safety", icon: ShieldAlert, phase: 8 },
    ],
  },
  {
    key: "finance",
    items: [
      { key: "payroll", href: "/payroll", icon: Wallet },
      { key: "payments", href: "/soon/payments", icon: Banknote, phase: 4 },
      { key: "spending", href: "/soon/spending", icon: Receipt, phase: 5 },
    ],
  },
  {
    key: "records",
    items: [
      { key: "documents", href: "/soon/documents", icon: FolderOpen, phase: 8 },
      { key: "reports", href: "/soon/reports", icon: ChartColumn, phase: 8 },
    ],
  },
];

/** Sections that render the "coming in phase N" empty state. */
export const comingSoonSections = {
  valuations: 6,
  diary: 6,
  materials: 5,
  stores: 5,
  plant: 8,
  safety: 8,
  payments: 4,
  spending: 5,
  documents: 8,
  reports: 8,
  settings: 1,
} as const;

export type ComingSoonSection = keyof typeof comingSoonSections;

/**
 * Routes backed by the real API: the projects list, project pages and site editors (D2.1), and a
 * project's BQ viewer and import wizard (D2.2).
 */
export function isLiveRoute(pathname: string): boolean {
  if (pathname === "/projects" || pathname === "/diary") return true;
  return /^\/projects\/[0-9a-f-]{36}(\/sites(\/[^/]+)?|\/bq(\/import)?)?$/.test(pathname);
}
