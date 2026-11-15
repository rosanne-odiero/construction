import {
  PETTY_CASH_READ_PERMISSIONS,
  SAFETY_READ_PERMISSIONS,
  SPENDING_READ_PERMISSIONS,
  VALUATION_READ_PERMISSIONS,
  type ReportId,
} from "@pm-buddy/types";
import { PAYROLL_VIEW } from "../payroll/payroll-support.js";
import { P2P_VIEW_PERMISSIONS } from "../procurement/p2p/p2p-common.js";
import { STORES_VIEW_PERMISSIONS } from "../procurement/stores/stores-common.js";
import {
  budgetVsActual,
  costLedger,
  pettyCash,
  supplierPayments,
} from "./builders/finance-reports.js";
import { musterRoll, payrollRegister } from "./builders/labour-reports.js";
import { invoiceAgeing, lpoRegister, stock } from "./builders/materials-reports.js";
import { auditLog, safetyActions, valuationsRegister } from "./builders/records-reports.js";
import type { ReportBuilder } from "./report-model.js";
import type { ReportRule } from "./reports-access.js";

const P2P = {
  project: P2P_VIEW_PERMISSIONS,
  companyAlso: ["procurement.manage_suppliers"],
} as const satisfies ReportRule;

/**
 * Each report's permission rule (D-120, INVARIANTS "Reports"): `reports.view` on the project plus
 * the permission of the screen the data comes from, with the same role ∩ assignment rule and the
 * same constants that screen uses, so a report never shows more than its source screen shows the
 * same person. Company reports need their company-level permission (and the same MFA check).
 */
export const REPORT_RULES: Readonly<Record<ReportId, ReportRule>> = {
  "muster-roll": { project: ["attendance.view"] },
  "payroll-register": { project: PAYROLL_VIEW },
  "cost-ledger": { project: SPENDING_READ_PERMISSIONS },
  "budget-vs-actual": { project: SPENDING_READ_PERMISSIONS },
  stock: { project: STORES_VIEW_PERMISSIONS },
  "valuations-register": { project: VALUATION_READ_PERMISSIONS },
  "lpo-register": P2P,
  "invoice-ageing": P2P,
  "supplier-payments": P2P,
  "petty-cash": { project: PETTY_CASH_READ_PERMISSIONS },
  "mpesa-reconciliation": { project: ["payments.view"] },
  "safety-actions": { project: SAFETY_READ_PERMISSIONS, alsoProject: ["projects.view"] },
  "audit-log": { company: "audit.view", stepUp: true },
};

/** The builder of each report; null while a report is not available. */
export const REPORT_BUILDERS: Readonly<Record<ReportId, ReportBuilder | null>> = {
  "muster-roll": musterRoll,
  "payroll-register": payrollRegister,
  "cost-ledger": costLedger,
  "budget-vs-actual": budgetVsActual,
  stock,
  "valuations-register": valuationsRegister,
  "lpo-register": lpoRegister,
  "invoice-ageing": invoiceAgeing,
  "supplier-payments": supplierPayments,
  "petty-cash": pettyCash,
  "mpesa-reconciliation": null,
  "safety-actions": safetyActions,
  "audit-log": auditLog,
};
