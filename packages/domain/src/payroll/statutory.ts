import { Decimal } from "decimal.js";
import {
  EMPLOYEE_STATUTORY,
  EMPLOYER_COSTS,
  STATUTORY_METHODS,
  STATUTORY_RULE_KINDS,
  type EmployeeStatutory,
  type EmployerCost,
  type EngagementType,
  type PayeBand,
  type RuleVerificationStatus,
  type StatutoryParameters,
  type StatutoryRuleKind,
} from "@pm-buddy/types";

/**
 * Kenyan statutory deductions and employer levies (brief §5.6, §6; D4.1). Pure integer arithmetic
 * on KES minor units with decimal.js for rates; every value comes from an effective-dated rule
 * version (COMPLIANCE-REVIEW CR-PAY-01 … CR-PAY-07), never from code.
 *
 * Monthly computation on a base B (gross pay subject to statutory deductions, in cents):
 * 1. NSSF Tier I = employee rate × min(B, LEL); Tier II = employee rate × (min(B, UEL) − LEL) when
 *    positive; employer the same with the employer rate. Each tier is rounded half-up to the cent.
 * 2. SHIF = max(minimum, rate × B) when B > 0, capped at the maximum when one is set.
 * 3. AHL = employee rate × B and employer rate × B, each rounded half-up.
 * 4. Taxable pay = B − the employee contributions listed in `deductibleBeforeTax` (from 27/12/2024
 *    NSSF, SHIF and AHL), never below zero.
 * 5. PAYE = Σ band portion × band rate, rounded half-up once to the cent, less personal relief,
 *    never below zero (relief larger than the tax gives zero, never a refund).
 * 6. NITA = the employer amount per employee when B > 0.
 * Items not applicable to the labourer's engagement type are zero.
 *
 * Non-monthly periods (method `cumulative_month_to_date`): each batch recomputes the month on the
 * aggregate base of the month's submitted batches plus this one, and its due amount is the monthly
 * figure less what earlier batches of the month already withheld (employee) or accrued (employer).
 */

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
type DecimalValue = InstanceType<typeof D>;

const toMinor = (value: DecimalValue): number => {
  const rounded = value.toDecimalPlaces(0, D.ROUND_HALF_UP).toNumber();
  if (!Number.isSafeInteger(rounded)) throw new RangeError("Amount out of range");
  return rounded;
};

/** `ratePercent` % of `amountMinor`, rounded half-up to the cent. */
export const percentMinor = (amountMinor: number, ratePercent: string): number =>
  toMinor(new D(amountMinor).times(ratePercent).dividedBy(100));

export type StatutoryRuleVersion<K extends StatutoryRuleKind = StatutoryRuleKind> = {
  [P in K]: {
    id: string;
    kind: P;
    effectiveFrom: string;
    status: RuleVerificationStatus;
    parameters: StatutoryParameters[P];
  };
}[K];

export type StatutoryRuleSet = { [K in StatutoryRuleKind]: StatutoryRuleVersion<K> };

/**
 * The version of each kind in force on `date` (latest `effectiveFrom` on or before it). `missing`
 * lists kinds with no version in force; `rules` is null then.
 */
export function selectRuleSet(
  versions: readonly StatutoryRuleVersion[],
  date: string,
): { rules: StatutoryRuleSet | null; missing: StatutoryRuleKind[] } {
  const chosen = new Map<StatutoryRuleKind, StatutoryRuleVersion>();
  for (const version of versions) {
    if (version.effectiveFrom > date) continue;
    const current = chosen.get(version.kind);
    if (!current || version.effectiveFrom > current.effectiveFrom)
      chosen.set(version.kind, version);
  }
  const missing = STATUTORY_RULE_KINDS.filter((kind) => !chosen.has(kind));
  if (missing.length) return { rules: null, missing };
  return { rules: Object.fromEntries(chosen) as StatutoryRuleSet, missing };
}

/** Rule versions in a set, in kind order. */
export const ruleSetVersions = (rules: StatutoryRuleSet): StatutoryRuleVersion[] =>
  STATUTORY_RULE_KINDS.map((kind) => rules[kind]);

/** PAYE before relief on monthly taxable pay: marginal bands, rounded half-up once. */
export function payeBeforeRelief(taxableMinor: number, bands: readonly PayeBand[]): number {
  if (taxableMinor <= 0) return 0;
  let tax = new D(0);
  let lower = 0;
  for (const band of bands) {
    const upper = band.upToMinor ?? Number.POSITIVE_INFINITY;
    const portion = Math.min(taxableMinor, upper) - lower;
    if (portion > 0) tax = tax.plus(new D(portion).times(band.ratePercent).dividedBy(100));
    if (taxableMinor <= upper) break;
    lower = upper;
  }
  return toMinor(tax);
}

export type MonthlyStatutory = {
  baseMinor: number;
  nssf: {
    pensionableMinor: number;
    tier1Minor: number;
    tier2Minor: number;
    employerTier1Minor: number;
    employerTier2Minor: number;
  };
  employee: Record<EmployeeStatutory, number>;
  employer: Record<EmployerCost, number>;
  taxablePayMinor: number;
  payeBeforeReliefMinor: number;
  personalReliefMinor: number;
};

const zeroEmployee = (): Record<EmployeeStatutory, number> => ({
  nssf: 0,
  shif: 0,
  ahl: 0,
  paye: 0,
});
const zeroEmployer = (): Record<EmployerCost, number> => ({
  nssf_employer: 0,
  ahl_employer: 0,
  nita: 0,
});

/** The month's statutory figures for one labourer on base `baseMinor` (see the module notes). */
export function monthlyStatutory(
  baseMinor: number,
  rules: StatutoryRuleSet,
  engagementType: EngagementType,
): MonthlyStatutory {
  const applies = rules.applicability.parameters[engagementType];
  const base = Math.max(0, baseMinor);
  const employee = zeroEmployee();
  const employer = zeroEmployer();
  const nssf = {
    pensionableMinor: 0,
    tier1Minor: 0,
    tier2Minor: 0,
    employerTier1Minor: 0,
    employerTier2Minor: 0,
  };
  if (base > 0 && applies.nssf) {
    const { lowerEarningsLimitMinor: lel, upperEarningsLimitMinor: uel } = rules.nssf.parameters;
    const pensionable = Math.min(base, uel);
    const tier1Base = Math.min(pensionable, lel);
    const tier2Base = Math.max(0, pensionable - lel);
    nssf.pensionableMinor = pensionable;
    nssf.tier1Minor = percentMinor(tier1Base, rules.nssf.parameters.employeeRatePercent);
    nssf.tier2Minor = percentMinor(tier2Base, rules.nssf.parameters.employeeRatePercent);
    nssf.employerTier1Minor = percentMinor(tier1Base, rules.nssf.parameters.employerRatePercent);
    nssf.employerTier2Minor = percentMinor(tier2Base, rules.nssf.parameters.employerRatePercent);
    employee.nssf = nssf.tier1Minor + nssf.tier2Minor;
    employer.nssf_employer = nssf.employerTier1Minor + nssf.employerTier2Minor;
  }
  if (base > 0 && applies.shif) {
    const { employeeRatePercent, minimumMinor, maximumMinor } = rules.shif.parameters;
    const computed = Math.max(minimumMinor, percentMinor(base, employeeRatePercent));
    employee.shif = maximumMinor === null ? computed : Math.min(computed, maximumMinor);
  }
  if (base > 0 && applies.ahl) {
    employee.ahl = percentMinor(base, rules.ahl.parameters.employeeRatePercent);
    employer.ahl_employer = percentMinor(base, rules.ahl.parameters.employerRatePercent);
  }
  if (base > 0 && applies.nita)
    employer.nita = rules.nita.parameters.employerAmountPerEmployeeMinor;
  let taxablePayMinor = 0;
  let payeBeforeReliefMinor = 0;
  let personalReliefMinor = 0;
  if (base > 0 && applies.paye) {
    const preTax = rules.paye.parameters.deductibleBeforeTax.reduce(
      (sum, item) => sum + employee[item],
      0,
    );
    taxablePayMinor = Math.max(0, base - preTax);
    payeBeforeReliefMinor = payeBeforeRelief(taxablePayMinor, rules.paye.parameters.bands);
    personalReliefMinor = Math.min(
      payeBeforeReliefMinor,
      rules.paye.parameters.personalReliefMinor,
    );
    employee.paye = payeBeforeReliefMinor - personalReliefMinor;
  }
  return {
    baseMinor: base,
    nssf,
    employee,
    employer,
    taxablePayMinor,
    payeBeforeReliefMinor,
    personalReliefMinor,
  };
}

/** What earlier submitted batches of the same statutory month withheld and accrued. */
export type PriorMonth = {
  baseMinor: number;
  withheld: Record<EmployeeStatutory, number>;
  employer: Record<EmployerCost, number>;
  batchIds: string[];
};

export const emptyPriorMonth = (): PriorMonth => ({
  baseMinor: 0,
  withheld: zeroEmployee(),
  employer: zeroEmployer(),
  batchIds: [],
});

export type BatchStatutory = {
  /** The month recomputed on the cumulative base (earlier batches plus this one). */
  monthly: MonthlyStatutory;
  cumulativeBaseMinor: number;
  /** Monthly figure less what earlier batches withheld; negative is a refund within the month. */
  due: Record<EmployeeStatutory, number>;
  /** What this batch withholds (never more than the pay available, statutory first). */
  withheld: Record<EmployeeStatutory, number>;
  /** Due but not withheld because pay ran out; recovered by later batches of the month. */
  shortfall: Record<EmployeeStatutory, number>;
  employer: Record<EmployerCost, number>;
  /** Gross less everything withheld here (refunds add back). Never negative for gross ≥ 0. */
  availableAfterMinor: number;
};

/**
 * Statutory amounts for one labourer in one batch (cumulative month-to-date method). Withholding
 * order: refunds first, then NSSF, SHIF, AHL and PAYE, each up to the pay still available, so net
 * pay never goes negative; any shortfall stays due and later batches of the month withhold it.
 */
export function batchStatutory(
  grossMinor: number,
  baseMinor: number,
  prior: PriorMonth,
  rules: StatutoryRuleSet,
  engagementType: EngagementType,
): BatchStatutory {
  if (!(STATUTORY_METHODS as readonly string[]).includes(rules.method.parameters.method))
    throw new RangeError(`Unsupported statutory method ${rules.method.parameters.method}`);
  const cumulativeBaseMinor = prior.baseMinor + baseMinor;
  const monthly = monthlyStatutory(cumulativeBaseMinor, rules, engagementType);
  const due = zeroEmployee();
  const withheld = zeroEmployee();
  const shortfall = zeroEmployee();
  for (const item of EMPLOYEE_STATUTORY) due[item] = monthly.employee[item] - prior.withheld[item];
  let remaining = Math.max(0, grossMinor);
  for (const item of EMPLOYEE_STATUTORY)
    if (due[item] < 0) {
      withheld[item] = due[item];
      remaining -= due[item];
    }
  for (const item of EMPLOYEE_STATUTORY) {
    if (due[item] <= 0) continue;
    const take = Math.min(due[item], remaining);
    withheld[item] = take;
    shortfall[item] = due[item] - take;
    remaining -= take;
  }
  const employer = zeroEmployer();
  for (const item of EMPLOYER_COSTS) employer[item] = monthly.employer[item] - prior.employer[item];
  const totalWithheld = EMPLOYEE_STATUTORY.reduce((sum, item) => sum + withheld[item], 0);
  return {
    monthly,
    cumulativeBaseMinor,
    due,
    withheld,
    shortfall,
    employer,
    availableAfterMinor: grossMinor - totalWithheld,
  };
}

/** Issues with a rule version's parameters (empty when valid). Used by validation and the seed. */
export function statutoryParameterIssues<K extends StatutoryRuleKind>(
  kind: K,
  parameters: StatutoryParameters[K],
): string[] {
  const issues: string[] = [];
  const rate = (value: string, max = 100) => {
    if (!/^\d{1,3}(\.\d{1,4})?$/.test(value) || Number(value) > max) issues.push("rate");
  };
  const amount = (value: number | null) => {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) issues.push("amount");
  };
  switch (kind) {
    case "paye": {
      const paye = parameters as StatutoryParameters["paye"];
      if (!paye.bands.length || paye.bands.at(-1)?.upToMinor !== null) issues.push("bands");
      let previous = 0;
      paye.bands.forEach((band, index) => {
        rate(band.ratePercent);
        if (band.upToMinor !== null) {
          amount(band.upToMinor);
          if (band.upToMinor <= previous) issues.push("bands");
          previous = band.upToMinor;
        } else if (index !== paye.bands.length - 1) issues.push("bands");
      });
      amount(paye.personalReliefMinor);
      if (new Set(paye.deductibleBeforeTax).size !== paye.deductibleBeforeTax.length)
        issues.push("deductible");
      break;
    }
    case "nssf": {
      const nssf = parameters as StatutoryParameters["nssf"];
      rate(nssf.employeeRatePercent);
      rate(nssf.employerRatePercent);
      amount(nssf.lowerEarningsLimitMinor);
      amount(nssf.upperEarningsLimitMinor);
      if (nssf.lowerEarningsLimitMinor > nssf.upperEarningsLimitMinor) issues.push("limits");
      break;
    }
    case "shif": {
      const shif = parameters as StatutoryParameters["shif"];
      rate(shif.employeeRatePercent);
      amount(shif.minimumMinor);
      amount(shif.maximumMinor);
      if (shif.maximumMinor !== null && shif.maximumMinor < shif.minimumMinor)
        issues.push("limits");
      break;
    }
    case "ahl": {
      const ahl = parameters as StatutoryParameters["ahl"];
      rate(ahl.employeeRatePercent);
      rate(ahl.employerRatePercent);
      break;
    }
    case "nita":
      amount((parameters as StatutoryParameters["nita"]).employerAmountPerEmployeeMinor);
      break;
    case "method":
      if (
        !(STATUTORY_METHODS as readonly string[]).includes(
          (parameters as StatutoryParameters["method"]).method,
        )
      )
        issues.push("method");
      break;
    case "applicability":
      break;
  }
  return [...new Set(issues)];
}
