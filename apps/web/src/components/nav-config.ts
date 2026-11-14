import {
  Banknote,
  Building,
  Calculator,
  ChartColumn,
  ClipboardCheck,
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
  ShoppingCart,
  Truck,
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
  | "quality"
  | "materials"
  | "suppliers"
  | "procurement"
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
      { key: "bq", href: "/bq", icon: FileSpreadsheet },
      { key: "suppliers", href: "/suppliers", icon: Truck },
      { key: "procurement", href: "/procurement", icon: ShoppingCart },
      { key: "valuations", href: "/soon/valuations", icon: Calculator, phase: 6 },
    ],
  },
  {
    key: "site",
    items: [
      { key: "labour", href: "/labour", icon: HardHat },
      { key: "attendance", href: "/attendance", icon: ScanFace },
      { key: "diary", href: "/diary", icon: NotebookPen },
      { key: "quality", href: "/quality", icon: ClipboardCheck },
      { key: "materials", href: "/catalogue", icon: Package },
      { key: "stores", href: "/stores", icon: Warehouse },
      { key: "plant", href: "/soon/plant", icon: Forklift, phase: 8 },
      { key: "safety", href: "/safety", icon: ShieldAlert },
    ],
  },
  {
    key: "finance",
    items: [
      // The live payroll screens (D4.1 web) are not on main yet; the D0 prototype stands in.
      { key: "payroll", href: "/prototype/payroll", icon: Wallet },
      { key: "payments", href: "/soon/payments", icon: Banknote, phase: 4 },
      { key: "spending", href: "/spending", icon: Receipt },
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
 * Routes backed by the real API: the projects list, project pages and site editors (D2.1), a
 * project's BQ viewer and import wizard (D2.2), the labour registry (D3.1), attendance and
 * timesheets (D3.3 web slice), payroll (D4.1), the catalogue and suppliers (D5.1),
 * procure-to-pay (D5.2), stores (D5.3), spending and cash flow (D5.4), quality (D6.1) and health
 * and safety (D8.2). The D0
 * labour, attendance and payroll prototypes live under /prototype.
 */
export function isLiveRoute(pathname: string): boolean {
  if (pathname === "/projects" || pathname === "/bq" || pathname === "/diary") return true;
  if (/^\/quality(\/templates(\/[0-9a-f-]{36})?)?$/.test(pathname)) return true;
  if (pathname === "/safety" || pathname === "/safety/settings") return true;
  if (pathname === "/labour" || pathname.startsWith("/labour/")) return true;
  if (pathname === "/attendance" || pathname.startsWith("/attendance/")) return true;
  if (pathname === "/payroll" || pathname.startsWith("/payroll/")) return true;
  if (/^\/catalogue(\/(alerts|convert|units|[0-9a-f-]{36}))?$/.test(pathname)) return true;
  if (/^\/suppliers(\/(new|[0-9a-f-]{36}(\/edit)?))?$/.test(pathname)) return true;
  if (/^\/rate-buildups(\/(new|[0-9a-f-]{36}))?$/.test(pathname)) return true;
  if (
    /^\/stores(\/(transfers|stock-takes|variance|settings)|\/(transfers|stock-takes|movements)\/[0-9a-f-]{36}(\/return)?|\/[0-9a-f-]{36}(\/(ledger|issue|wastage|transfer|reorder-levels))?)?$/.test(
      pathname,
    )
  )
    return true;
  if (
    /^\/spending(\/(ledger|petty-cash|forecast|alerts|budgets|journals|settings)|\/petty-cash\/(expenses\/)?[0-9a-f-]{36}(\/expense)?|\/(budgets|journals)\/[0-9a-f-]{36}|\/projects\/[0-9a-f-]{36}(\/bills\/[0-9a-f-]{36})?)?$/.test(
      pathname,
    )
  )
    return true;
  if (
    /^\/procurement(\/(requisitions|rfqs|lpos|grns|invoices)(\/(new|[0-9a-f-]{36}(\/(edit|print))?))?)?$/.test(
      pathname,
    )
  )
    return true;
  return /^\/projects\/[0-9a-f-]{36}(\/sites(\/[^/]+)?|\/quality\/inspections\/[0-9a-f-]{36}|\/safety\/(incidents|talks)\/(new|[0-9a-f-]{36})|\/bq(\/(import|instructions|versions|variations(\/[0-9a-f-]{36})?))?)?$/.test(
    pathname,
  );
}
