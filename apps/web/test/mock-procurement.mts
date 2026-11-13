/**
 * The D5.1 catalogue and suppliers in the Playwright mock API: materials, units, conversions,
 * prices and alerts, suppliers with masked identifiers, reveal and maker-checker payout details.
 * Conversions, VAT, comparable prices and alerts use the real packages/domain functions; requests
 * and responses go through the shared schemas. Synthetic data only.
 */
import { randomUUID } from "node:crypto";
import {
  checkConversionRule,
  comparableUnitPrice,
  exactNetPrice,
  convertQuantity,
  defineCustomUnit,
  derivedEdges,
  KENYAN_STARTER_CATALOGUE,
  maskAccountNumber,
  maskKraPin,
  maskPhone,
  nairobiDate,
  priceChange,
  splitVat,
  STANDARD_UNITS,
  type ConversionContext,
  type ConversionRule,
  type UnitDefinition,
} from "@pm-buddy/domain";
import {
  DEFAULT_BLOCK_PAYMENT_WITHOUT_ETIMS,
  DEFAULT_MIN_QUOTES,
  DEFAULT_PRICE_CHANGE_ALERT_PERCENT,
  DEFAULT_PRICE_TOLERANCE_PERCENT,
  DEFAULT_QTY_TOLERANCE_PERCENT,
  DIMENSION_BASE_UNITS,
  type Permission,
  type SizedDimension,
  type UnitDimension,
} from "@pm-buddy/types";
import {
  conversionResponseSchema,
  conversionResultResponseSchema,
  convertQuerySchema,
  correctPriceRequestSchema,
  createConversionRequestSchema,
  createMaterialRequestSchema,
  createSupplierRequestSchema,
  createUnitRequestSchema,
  endConversionRequestSchema,
  loadDefaultsResponseSchema,
  materialDetailResponseSchema,
  materialResponseSchema,
  materialsResponseSchema,
  priceAlertsResponseSchema,
  priceResponseSchema,
  procurementSettingsResponseSchema,
  proposePayoutRequestSchema,
  recordPriceRequestSchema,
  rejectPayoutRequestSchema,
  supplierDetailResponseSchema,
  supplierRevealRequestSchema,
  supplierRevealResponseSchema,
  suppliersResponseSchema,
  unitResponseSchema,
  unitsResponseSchema,
  updateMaterialRequestSchema,
  updateProcurementSettingsRequestSchema,
  updateSupplierRequestSchema,
  updateUnitRequestSchema,
  verifyPayoutRequestSchema,
  type Conversion,
  type Material,
  type MaterialAttributesInput,
  type PayoutVersion,
  type Price,
  type RecordPriceRequest,
  type Supplier,
  type UnitWire,
} from "@pm-buddy/validation";
import type { Person, Reply } from "./mock-bq-model.mts";

const NOW = "2026-11-10T07:45:00.000Z";
const VAT = "16";
const OWNER: Person = { id: "21000000-0000-4000-8000-000000000001", displayName: "Wanjiru Kamau" };
const FINANCE: Person = {
  id: "21000000-0000-4000-8000-000000000005",
  displayName: "Daniel Mwangi",
};

type Ref = { id: string; code: string; name: string };
type MockMaterial = Omit<Material, "latestPrice" | "alertCount">;
type MockUnit = UnitWire & { id: string };
type MockConversion = Conversion & { pairKey: string };
type MockContact = {
  id: string;
  name: string;
  role: string | null;
  phone: string | null;
  email: string | null;
  primary: boolean;
  phoneChangedAt: string | null;
};
type MockPayout = Omit<PayoutVersion, "canDecide"> & {
  accountNumber: string | null;
  contributorIds: string[];
};
type MockSupplier = {
  supplier: Omit<Supplier, "primaryContact" | "payout"> & { notes: string | null };
  kraPin: string | null;
  contacts: MockContact[];
  payouts: MockPayout[];
};
export type ProcurementState = {
  materials: MockMaterial[];
  units: MockUnit[];
  conversions: MockConversion[];
  prices: Price[];
  suppliers: MockSupplier[];
  settings: { percent: string; version: number };
};

export type ProcurementDeps = {
  fail: (status: number, code: string) => Error;
  parse<T>(schema: import("zod").ZodType<T>, body: unknown): T;
  permissions: readonly Permission[];
  tenantWide: boolean;
  actor: Person;
  requireStepUp(): void;
};

const ref = (row: {
  id: string;
  code: string;
  name?: string;
  tradingName?: string | null;
  legalName?: string;
}): Ref => ({
  id: row.id,
  code: row.code,
  name: row.name ?? row.tradingName ?? row.legalName ?? "",
});

function material(
  code: string,
  name: string,
  category: Material["category"],
  baseUnit: string,
  attributes: MaterialAttributesInput = {},
  nameSw: string | null = null,
): MockMaterial {
  return {
    id: randomUUID(),
    code,
    name,
    nameSw,
    category,
    baseUnit,
    spec: null,
    attributes,
    notes: null,
    status: "active",
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** The synthetic catalogue each test starts with (mirrors the demo seed). */
export function initialProcurement(): ProcurementState {
  const cement = material(
    "MAT-0001",
    "Cement 42.5N (50 kg bag)",
    "cement",
    "bag_50kg",
    {},
    "Saruji 42.5N (mfuko wa kilo 50)",
  );
  const sand = material("MAT-0002", "River sand", "aggregates", "t", {}, "Mchanga wa mto");
  const y12 = material(
    "MAT-0003",
    "Steel bar Y12 (high yield, 12 m)",
    "steel",
    "kg",
    { diameterMm: 12, pieceLengthM: "12" },
    "Nondo Y12 (mita 12)",
  );
  const brc = material("MAT-0004", "BRC mesh A142", "brc_mesh", "m2", {
    meshType: "A142",
    sheetWidthM: "2.4",
    sheetLengthM: "4.8",
    rollLengthM: "48",
  });
  const quarry: MockSupplier = {
    supplier: {
      id: "60000000-0000-4000-8000-000000000001",
      code: "SUP-0001",
      legalName: "Mlolongo Quarry Supplies Ltd (synthetic)",
      tradingName: "Mlolongo Quarry (synthetic)",
      kraPinMasked: maskKraPin("P000000001Z"),
      etimsStatus: "registered",
      etimsCheckedOn: "2026-11-01",
      status: "active",
      statusReason: null,
      creditDays: 30,
      creditLimitMinor: 50_000_000,
      notes: "Synthetic demo supplier.",
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
    },
    kraPin: "P000000001Z",
    contacts: [
      {
        id: randomUUID(),
        name: "Achieng Otieno (synthetic)",
        role: "Sales",
        phone: "254708374149",
        email: "sales@mlolongo-quarry.example.test",
        primary: true,
        phoneChangedAt: "2026-09-01T06:00:00.000Z",
      },
    ],
    payouts: [],
  };
  const steel: MockSupplier = {
    supplier: {
      id: "60000000-0000-4000-8000-000000000002",
      code: "SUP-0002",
      legalName: "Athi River Steel & Hardware Ltd (synthetic)",
      tradingName: "Athi River Steel (synthetic)",
      kraPinMasked: maskKraPin("P000000002Z"),
      etimsStatus: "registered",
      etimsCheckedOn: "2026-11-01",
      status: "active",
      statusReason: null,
      creditDays: 14,
      creditLimitMinor: 200_000_000,
      notes: null,
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
    },
    kraPin: "P000000002Z",
    contacts: [],
    payouts: [],
  };
  const state: ProcurementState = {
    materials: [cement, sand, y12, brc],
    units: [],
    conversions: [],
    prices: [],
    suppliers: [quarry, steel],
    settings: { percent: DEFAULT_PRICE_CHANGE_ALERT_PERCENT, version: 0 },
  };
  quarry.payouts.push(
    payout(
      1,
      {
        mpesaKind: "paybill",
        paybillNumber: "600000",
        accountReference: "JENGA-BORA",
        tillNumber: null,
        bank: null,
      },
      OWNER,
      false,
    ),
  );
  Object.assign(quarry.payouts[0]!, {
    proposedAt: "2026-11-03T08:00:00.000Z",
    status: "verified",
    verifiedAt: NOW,
    verifiedBy: FINANCE,
    verificationMethod: "call_back_known_number",
    verificationNote: "Called the supplier on the number already on file (demo data).",
    usableForPayment: true,
  });
  steel.payouts.push(
    payout(
      1,
      {
        mpesaKind: "till",
        paybillNumber: null,
        accountReference: null,
        tillNumber: "174379",
        bank: {
          bankName: "Equity Bank (synthetic)",
          branch: "Athi River",
          accountName: "Athi River Steel & Hardware Ltd",
          accountNumber: "0000000000002",
        },
      },
      OWNER,
      false,
    ),
  );
  steel.payouts[0]!.proposedAt = "2026-11-09T09:30:00.000Z";
  state.conversions.push(
    conversionRow(
      sand,
      quarry,
      {
        fromUnit: "trip",
        fromQuantity: "1",
        toUnit: "t",
        toQuantity: "7",
        effectiveFrom: "2026-09-01",
        note: "7-tonne lorry, weighed at the quarry (demo)",
      },
      OWNER,
    ),
  );
  const record = (
    target: MockMaterial,
    supplier: MockSupplier,
    input: Omit<RecordPriceRequest, "supplierId">,
  ) => writePrice(state, target, { ...input, supplierId: supplier.supplier.id }, OWNER, null);
  record(cement, steel, {
    unit: "bag_50kg",
    unitPriceMinor: 78_000,
    vatTreatment: "inclusive",
    effectiveOn: "2026-09-01",
  });
  record(cement, steel, {
    unit: "bag_50kg",
    unitPriceMinor: 80_000,
    vatTreatment: "inclusive",
    effectiveOn: "2026-10-15",
  });
  record(cement, steel, {
    unit: "bag_50kg",
    unitPriceMinor: 90_000,
    vatTreatment: "inclusive",
    effectiveOn: "2026-11-05",
  });
  record(sand, quarry, {
    unit: "trip",
    unitPriceMinor: 2_800_000,
    vatTreatment: "not_applicable",
    effectiveOn: "2026-10-01",
  });
  record(sand, quarry, {
    unit: "trip",
    unitPriceMinor: 3_000_000,
    vatTreatment: "not_applicable",
    effectiveOn: "2026-11-02",
  });
  record(y12, steel, {
    unit: "nr",
    unitPriceMinor: 125_000,
    vatTreatment: "inclusive",
    effectiveOn: "2026-10-01",
  });
  return state;
}

function payout(
  versionNo: number,
  input: {
    mpesaKind: PayoutVersion["mpesaKind"];
    paybillNumber: string | null;
    accountReference: string | null;
    tillNumber: string | null;
    bank: {
      bankName: string;
      branch?: string | null;
      accountName: string;
      accountNumber: string;
    } | null;
  },
  actor: Person,
  warning: boolean,
): MockPayout {
  const account = input.bank?.accountNumber.replace(/[\s-]/g, "").toUpperCase() ?? null;
  return {
    id: randomUUID(),
    versionNo,
    status: "pending",
    mpesaKind: input.mpesaKind,
    paybillNumber: input.paybillNumber,
    accountReference: input.accountReference,
    tillNumber: input.tillNumber,
    bank:
      input.bank && account
        ? {
            bankName: input.bank.bankName,
            branch: input.bank.branch ?? null,
            accountName: input.bank.accountName,
            accountNumberMasked: maskAccountNumber(account),
          }
        : null,
    accountNumber: account,
    proposedAt: new Date().toISOString(),
    proposedBy: actor,
    contributors: [actor],
    contributorIds: [actor.id],
    verifiedAt: null,
    verifiedBy: null,
    verificationMethod: null,
    verificationNote: null,
    rejectedAt: null,
    rejectedBy: null,
    rejectionReason: null,
    supersededAt: null,
    usableForPayment: false,
    contactChangeWarning: warning,
  };
}

function conversionRow(
  target: MockMaterial,
  supplier: MockSupplier | null,
  input: {
    fromUnit: string;
    fromQuantity: string;
    toUnit: string;
    toQuantity: string;
    effectiveFrom: string;
    note: string | null;
  },
  actor: Person,
  units: UnitDefinition[] = [],
): MockConversion {
  const check = checkConversionRule(input, units);
  if (!check.ok) throw new Error(`Invalid mock conversion: ${check.issue}`);
  return {
    id: randomUUID(),
    materialId: target.id,
    supplier: supplier ? ref(supplier.supplier) : null,
    fromUnit: input.fromUnit,
    fromQuantity: input.fromQuantity,
    toUnit: input.toUnit,
    toQuantity: input.toQuantity,
    factor: check.ratio.toDecimal(12).value,
    ratio: check.ratio.toString(),
    effectiveFrom: input.effectiveFrom,
    effectiveTo: null,
    note: input.note,
    inForce: true,
    createdAt: new Date().toISOString(),
    createdBy: actor,
    endedAt: null,
    endedBy: null,
    pairKey: check.pairKey,
  };
}

const customDefinitions = (state: ProcurementState): UnitDefinition[] =>
  state.units.flatMap((unit) => {
    const result = defineCustomUnit({
      code: unit.code,
      dimension: unit.dimension as UnitDimension,
      equalsQuantity: unit.equalsQuantity,
      equalsUnit: unit.equalsUnit,
    });
    return result.ok ? [result.unit] : [];
  });

const toRule = (conversion: MockConversion): ConversionRule => ({
  id: conversion.id,
  supplierId: conversion.supplier?.id ?? null,
  fromUnit: conversion.fromUnit,
  fromQuantity: conversion.fromQuantity,
  toUnit: conversion.toUnit,
  toQuantity: conversion.toQuantity,
  effectiveFrom: conversion.effectiveFrom,
  effectiveTo: conversion.effectiveTo,
});

function context(
  state: ProcurementState,
  target: MockMaterial | null,
  supplierId: string | null,
  on: string,
): ConversionContext {
  return {
    on,
    supplierId,
    customUnits: customDefinitions(state),
    material: target ? { category: target.category, attributes: target.attributes } : null,
    rules: target
      ? state.conversions.filter((conversion) => conversion.materialId === target.id).map(toRule)
      : [],
  };
}

const correctedBy = (state: ProcurementState, priceId: string) =>
  state.prices.find((price) => price.correctsPriceId === priceId)?.id ?? null;

function writePrice(
  state: ProcurementState,
  target: MockMaterial,
  input: RecordPriceRequest,
  actor: Person,
  correction: { priceId: string; reason: string } | null,
): Price {
  const supplier = state.suppliers.find((entry) => entry.supplier.id === input.supplierId)!;
  const vat = splitVat(input.unitPriceMinor, input.vatTreatment, VAT);
  const comparable = comparableUnitPrice(
    exactNetPrice(input.unitPriceMinor, input.vatTreatment, VAT),
    input.unit,
    target.baseUnit,
    context(state, target, input.supplierId, input.effectiveOn),
  );
  let alertState: Price["alertState"] = "not_comparable";
  let change: Price["change"] = null;
  if (comparable.ok) {
    // Newest first: the latest effective date wins, then the latest recorded on that date.
    const previous = [...state.prices]
      .reverse()
      .filter(
        (price) =>
          price.material.id === target.id &&
          price.supplier.id === input.supplierId &&
          price.comparable &&
          price.effectiveOn <= input.effectiveOn &&
          correctedBy(state, price.id) === null &&
          price.id !== correction?.priceId,
      )
      .sort((left, right) =>
        left.effectiveOn < right.effectiveOn ? 1 : left.effectiveOn > right.effectiveOn ? -1 : 0,
      )[0];
    if (!previous) alertState = "first_price";
    else {
      const result = priceChange(
        previous.comparable!.unitPriceMinor,
        comparable.valueMinor,
        state.settings.percent,
      );
      if (result) {
        alertState = result.state;
        change = { previousPriceId: previous.id, percent: result.percent };
      }
    }
  }
  const price: Price = {
    id: randomUUID(),
    material: ref(target),
    supplier: ref(supplier.supplier),
    unit: input.unit,
    unitPriceMinor: input.unitPriceMinor,
    currency: "KES",
    vatTreatment: input.vatTreatment,
    vatRatePercent: vat.ratePercent,
    netUnitPriceMinor: vat.netMinor,
    grossUnitPriceMinor: vat.grossMinor,
    effectiveOn: input.effectiveOn,
    source: "manual",
    sourceReference: input.sourceReference ?? null,
    note: input.note ?? null,
    comparable: comparable.ok
      ? { unit: target.baseUnit, unitPriceMinor: comparable.valueMinor, steps: comparable.steps }
      : null,
    change,
    alertState,
    alertThresholdPercent: state.settings.percent,
    correctsPriceId: correction?.priceId ?? null,
    correctionReason: correction?.reason ?? null,
    correctedById: null,
    recordedAt: new Date().toISOString(),
    recordedBy: actor,
  };
  state.prices.push(price);
  return price;
}

const CATALOGUE_VIEW: readonly Permission[] = [
  "procurement.manage_suppliers",
  "procurement.requisition",
  "procurement.approve",
  "stores.manage",
  "finance.view",
];

export function handleProcurement(
  deps: ProcurementDeps,
  state: ProcurementState,
  method: string,
  path: string,
  query: URLSearchParams,
  body: unknown,
): Reply | null {
  const { fail, parse, actor } = deps;
  const has = (permission: Permission) => deps.permissions.includes(permission);
  const canManage = has("procurement.manage_suppliers");
  const companyWide = (permission: Permission) => has(permission) && deps.tenantWide;
  const viewer = () => {
    if (!CATALOGUE_VIEW.some(has)) throw fail(403, "forbidden");
  };
  const manager = () => {
    if (!canManage) throw fail(403, "forbidden");
  };
  const today = nairobiDate();
  const findMaterial = (id: string) => {
    const found = state.materials.find((entry) => entry.id === id);
    if (!found) throw fail(404, "not-found");
    return found;
  };
  const findSupplier = (id: string) => {
    const found = state.suppliers.find((entry) => entry.supplier.id === id);
    if (!found) throw fail(404, "not-found");
    return found;
  };
  const unitKnown = (code: string) =>
    STANDARD_UNITS.some((unit) => unit.code === code) ||
    state.units.some((unit) => unit.code === code && unit.status === "active");
  const summary = (entry: MockMaterial): Material => {
    const live = state.prices
      .filter((price) => price.material.id === entry.id && correctedBy(state, price.id) === null)
      .sort((left, right) => (left.effectiveOn < right.effectiveOn ? 1 : -1));
    const latest = live[0];
    return {
      ...entry,
      latestPrice: latest
        ? {
            id: latest.id,
            supplier: latest.supplier,
            unit: latest.unit,
            unitPriceMinor: latest.unitPriceMinor,
            vatTreatment: latest.vatTreatment,
            effectiveOn: latest.effectiveOn,
            alertState: latest.alertState,
          }
        : null,
      alertCount: live.filter((price) => price.alertState === "above_threshold").length,
    };
  };
  const priceWire = (price: Price): Price => ({
    ...price,
    correctedById: correctedBy(state, price.id),
  });
  const conversionWire = (conversion: MockConversion): Conversion => {
    const wire: Conversion & { pairKey?: string } = { ...conversion };
    delete wire.pairKey;
    return {
      ...wire,
      inForce:
        conversion.effectiveFrom <= today &&
        (conversion.effectiveTo === null || today < conversion.effectiveTo),
    };
  };
  const detail = (entry: MockMaterial) => {
    const prices = state.prices
      .filter((price) => price.material.id === entry.id)
      .sort((left, right) =>
        left.effectiveOn < right.effectiveOn ? 1 : left.effectiveOn > right.effectiveOn ? -1 : 0,
      )
      .map(priceWire);
    const conversions = state.conversions.filter(
      (conversion) => conversion.materialId === entry.id,
    );
    const supplierIds = new Set([
      ...prices.map((price) => price.supplier.id),
      ...conversions.flatMap((conversion) => (conversion.supplier ? [conversion.supplier.id] : [])),
    ]);
    return {
      body: {
        material: summary(entry),
        conversions: conversions.map(conversionWire),
        standardConversions: derivedEdges(entry.category, entry.attributes).map((edge) => ({
          from: edge.from,
          to: edge.to,
          factor: edge.ratio.toDecimal(12).value,
          ratio: edge.ratio.toString(),
          rule: edge.rule!,
        })),
        prices,
        suppliers: state.suppliers
          .filter((supplier) => supplierIds.has(supplier.supplier.id))
          .map((supplier) => ref(supplier.supplier)),
        priceChangeAlertPercent: state.settings.percent,
        vatRatePercent: VAT,
        permissions: { canManage },
      },
      schema: materialDetailResponseSchema,
    };
  };
  const supplierSummary = (entry: MockSupplier): Supplier => {
    const current = entry.payouts.find(
      (version) => version.status === "pending" || version.status === "verified",
    );
    const primary = entry.contacts.find((contact) => contact.primary);
    const fields: Omit<Supplier, "primaryContact" | "payout"> & { notes?: string | null } = {
      ...entry.supplier,
    };
    delete fields.notes;
    return {
      ...fields,
      primaryContact: primary
        ? {
            name: primary.name,
            phoneMasked: primary.phone ? maskPhone(primary.phone) : null,
            email: primary.email,
          }
        : null,
      payout: current
        ? {
            status: current.status === "verified" ? "verified" : "pending",
            usableForPayment: current.status === "verified",
            mpesaKind: current.mpesaKind,
            hasBank: current.bank !== null,
          }
        : { status: "none", usableForPayment: false, mpesaKind: "none", hasBank: false },
    };
  };
  const supplierDetail = (entry: MockSupplier) => {
    const canVerify = companyWide("payments.approve");
    const versions = [...entry.payouts].sort((left, right) => right.versionNo - left.versionNo);
    const current =
      versions.find((version) => version.status === "pending" || version.status === "verified") ??
      null;
    const wire = (version: MockPayout): PayoutVersion => {
      const rest: Omit<PayoutVersion, "canDecide"> & Partial<MockPayout> = { ...version };
      delete rest.accountNumber;
      delete rest.contributorIds;
      return {
        ...rest,
        canDecide:
          canVerify && version.status === "pending" && !version.contributorIds.includes(actor.id),
      };
    };
    const { notes, ...supplier } = entry.supplier;
    return {
      body: {
        supplier: { ...supplierSummary(entry), ...supplier, notes },
        contacts: entry.contacts.map((contact) => ({
          id: contact.id,
          name: contact.name,
          role: contact.role,
          phoneMasked: contact.phone ? maskPhone(contact.phone) : null,
          email: contact.email,
          primary: contact.primary,
          phoneChangedAt: contact.phoneChangedAt,
        })),
        payout: {
          current: current ? wire(current) : null,
          history: versions.filter((version) => version !== current).map(wire),
        },
        prices: state.prices
          .filter((price) => price.supplier.id === entry.supplier.id)
          .map(priceWire)
          .slice(0, 20),
        permissions: {
          canManage,
          canRevealIdentifiers: canManage || companyWide("finance.view_sensitive"),
          canRevealBank: companyWide("finance.view_sensitive"),
          canVerifyPayout: canVerify,
        },
      },
      schema: supplierDetailResponseSchema,
    };
  };

  if (path === "/materials" && method === "GET") {
    viewer();
    const search = query.get("search")?.toLowerCase();
    const category = query.get("category");
    const status = query.get("status");
    const materials = state.materials
      .filter((entry) => !category || entry.category === category)
      .filter((entry) => !status || entry.status === status)
      .filter(
        (entry) =>
          !search ||
          [entry.code, entry.name, entry.nameSw, entry.spec].some((value) =>
            value?.toLowerCase().includes(search),
          ),
      )
      .map(summary);
    return {
      body: { materials, page: { nextCursor: null, hasMore: false }, permissions: { canManage } },
      schema: materialsResponseSchema,
    };
  }
  if (path === "/materials" && method === "POST") {
    manager();
    const input = parse(createMaterialRequestSchema, body);
    if (!unitKnown(input.baseUnit)) throw fail(422, "unit-unknown");
    if (state.materials.some((entry) => entry.name.toLowerCase() === input.name.toLowerCase()))
      throw fail(409, "material-name-taken");
    const created = material(
      `MAT-${String(state.materials.length + 1).padStart(4, "0")}`,
      input.name,
      input.category,
      input.baseUnit,
      input.attributes,
      input.nameSw ?? null,
    );
    Object.assign(created, { spec: input.spec ?? null, notes: input.notes ?? null });
    state.materials.push(created);
    return { status: 201, body: { material: summary(created) }, schema: materialResponseSchema };
  }
  if (path === "/materials/defaults" && method === "POST") {
    manager();
    let created = 0;
    let existing = 0;
    let conversions = 0;
    for (const starter of KENYAN_STARTER_CATALOGUE) {
      if (
        state.materials.some((entry) => entry.name.toLowerCase() === starter.name.toLowerCase())
      ) {
        existing += 1;
        continue;
      }
      const row = material(
        `MAT-${String(state.materials.length + 1).padStart(4, "0")}`,
        starter.name,
        starter.category,
        starter.baseUnit,
        starter.attributes,
        starter.nameSw,
      );
      row.spec = starter.spec;
      state.materials.push(row);
      created += 1;
      for (const conversion of starter.conversions) {
        state.conversions.push(
          conversionRow(row, null, { ...conversion, effectiveFrom: today }, actor),
        );
        conversions += 1;
      }
    }
    return { body: { created, existing, conversions }, schema: loadDefaultsResponseSchema };
  }
  if (path === "/price-alerts" && method === "GET") {
    viewer();
    const alerts = state.prices
      .filter(
        (price) => price.alertState === "above_threshold" && correctedBy(state, price.id) === null,
      )
      .reverse()
      .map(priceWire);
    return {
      body: {
        alerts,
        page: { nextCursor: null, hasMore: false },
        priceChangeAlertPercent: state.settings.percent,
      },
      schema: priceAlertsResponseSchema,
    };
  }
  if (path === "/conversions/calculate" && method === "GET") {
    viewer();
    const input = parse(convertQuerySchema, Object.fromEntries(query));
    const target = input.materialId ? findMaterial(input.materialId) : null;
    if (input.supplierId) findSupplier(input.supplierId);
    const on = input.on ?? today;
    const result = convertQuantity(
      input.quantity,
      input.from,
      input.to,
      context(state, target, input.supplierId ?? null, on),
    );
    if (!result.ok)
      throw fail(422, result.reason === "unknown-unit" ? "unit-unknown" : result.reason);
    return {
      body: {
        result: {
          input: input.quantity,
          from: input.from,
          to: input.to,
          quantity: result.quantity,
          exact: result.exact,
          factor: result.ratio.toDecimal(12).value,
          ratio: result.ratio.toString(),
          on,
          steps: result.steps,
        },
      },
      schema: conversionResultResponseSchema,
    };
  }
  if (path === "/units" && method === "GET") {
    viewer();
    const standard: UnitWire[] = STANDARD_UNITS.map((unit) => ({
      id: null,
      code: unit.code,
      dimension: unit.dimension,
      standard: true,
      name: null,
      nameSw: null,
      equalsQuantity: null,
      equalsUnit: null,
      sizeInBase: unit.perBase ? unit.perBase.toDecimal(12).value : null,
      baseUnit: unit.perBase ? DIMENSION_BASE_UNITS[unit.dimension as SizedDimension] : null,
      status: "active",
      version: 0,
    }));
    return {
      body: { units: [...standard, ...state.units], permissions: { canManage } },
      schema: unitsResponseSchema,
    };
  }
  if (path === "/units" && method === "POST") {
    manager();
    const input = parse(createUnitRequestSchema, body);
    const check = defineCustomUnit({
      code: input.code,
      dimension: input.dimension,
      equalsQuantity: input.equalsQuantity,
      equalsUnit: input.equalsUnit,
    });
    if (!check.ok)
      throw fail(
        check.issue === "standard-code" ? 409 : 400,
        check.issue === "standard-code" ? "unit-code-taken" : "unit-invalid",
      );
    if (state.units.some((unit) => unit.code === input.code)) throw fail(409, "unit-code-taken");
    const sized = check.unit.perBase;
    const unit: MockUnit = {
      id: randomUUID(),
      code: input.code,
      dimension: input.dimension,
      standard: false,
      name: input.name,
      nameSw: input.nameSw ?? null,
      equalsQuantity: input.equalsQuantity,
      equalsUnit: input.equalsUnit,
      sizeInBase: sized ? sized.toDecimal(12).value : null,
      baseUnit: sized ? DIMENSION_BASE_UNITS[input.dimension as SizedDimension] : null,
      status: "active",
      version: 1,
    };
    state.units.push(unit);
    return { status: 201, body: { unit }, schema: unitResponseSchema };
  }
  const unitMatch = /^\/units\/([^/]+)$/.exec(path);
  if (unitMatch && method === "PATCH") {
    manager();
    const input = parse(updateUnitRequestSchema, body);
    const unit = state.units.find((entry) => entry.id === unitMatch[1]);
    if (!unit) throw fail(404, "not-found");
    if (unit.version !== input.version) throw fail(409, "version-conflict");
    unit.status = input.status;
    unit.version += 1;
    return { body: { unit }, schema: unitResponseSchema };
  }
  if (path === "/procurement/settings") {
    const view = () => ({
      body: {
        settings: {
          priceChangeAlertPercent: state.settings.percent,
          // D5.2 settings at their defaults (the screens to change them come with D5.2's web).
          minQuotes: DEFAULT_MIN_QUOTES,
          qtyTolerancePercent: DEFAULT_QTY_TOLERANCE_PERCENT,
          priceTolerancePercent: DEFAULT_PRICE_TOLERANCE_PERCENT,
          blockPaymentWithoutEtims: DEFAULT_BLOCK_PAYMENT_WITHOUT_ETIMS,
          version: state.settings.version,
          updatedAt: state.settings.version ? NOW : null,
          updatedBy: state.settings.version ? OWNER : null,
        },
        permissions: { canManage: has("config.manage") },
      },
      schema: procurementSettingsResponseSchema,
    });
    if (method === "GET") {
      viewer();
      return view();
    }
    if (!has("config.manage")) throw fail(403, "forbidden");
    const input = parse(updateProcurementSettingsRequestSchema, body);
    if (input.version !== state.settings.version) throw fail(409, "version-conflict");
    state.settings = {
      percent: input.priceChangeAlertPercent,
      version: state.settings.version + 1,
    };
    return view();
  }

  const materialMatch = /^\/materials\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (materialMatch) {
    const [, materialId, rest = ""] = materialMatch;
    if (rest === "" && method === "GET") {
      viewer();
      return detail(findMaterial(materialId!));
    }
    manager();
    const target = findMaterial(materialId!);
    if (rest === "" && method === "PATCH") {
      const { version, ...fields } = parse(updateMaterialRequestSchema, body);
      if (target.version !== version) throw fail(409, "version-conflict");
      Object.assign(
        target,
        Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
      );
      target.version += 1;
      target.updatedAt = new Date().toISOString();
      return { body: { material: summary(target) }, schema: materialResponseSchema };
    }
    if (rest === "conversions" && method === "POST") {
      const input = parse(createConversionRequestSchema, body);
      const supplier = input.supplierId ? findSupplier(input.supplierId) : null;
      if (!unitKnown(input.fromUnit) || !unitKnown(input.toUnit)) throw fail(422, "unit-unknown");
      const check = checkConversionRule(input, customDefinitions(state));
      if (!check.ok)
        throw fail(
          check.issue === "standard-conversion-exists" ? 409 : 400,
          check.issue === "standard-conversion-exists"
            ? "standard-conversion-exists"
            : check.issue === "same-unit"
              ? "same-unit"
              : "invalid-quantity",
        );
      const effectiveFrom = input.effectiveFrom ?? today;
      const current = state.conversions.find(
        (conversion) =>
          conversion.materialId === target.id &&
          (conversion.supplier?.id ?? null) === input.supplierId &&
          conversion.pairKey === check.pairKey &&
          conversion.effectiveTo === null,
      );
      if (current) {
        if (current.effectiveFrom >= effectiveFrom) throw fail(409, "conversion-overlap");
        Object.assign(current, {
          effectiveTo: effectiveFrom,
          endedAt: new Date().toISOString(),
          endedBy: actor,
        });
      }
      const conversion = conversionRow(
        target,
        supplier,
        { ...input, effectiveFrom, note: input.note ?? null },
        actor,
        customDefinitions(state),
      );
      state.conversions.push(conversion);
      return {
        status: 201,
        body: { conversion: conversionWire(conversion) },
        schema: conversionResponseSchema,
      };
    }
    const endMatch = /^conversions\/([^/]+)\/end$/.exec(rest);
    if (endMatch && method === "POST") {
      const { effectiveTo } = parse(endConversionRequestSchema, body);
      const conversion = state.conversions.find(
        (entry) => entry.id === endMatch[1] && entry.materialId === target.id,
      );
      if (!conversion) throw fail(404, "not-found");
      if (conversion.effectiveTo) throw fail(409, "conversion-ended");
      if (effectiveTo <= conversion.effectiveFrom) throw fail(400, "conversion-end-invalid");
      Object.assign(conversion, { effectiveTo, endedAt: new Date().toISOString(), endedBy: actor });
      return { body: { conversion: conversionWire(conversion) }, schema: conversionResponseSchema };
    }
    if (rest === "prices" && method === "POST") {
      const input = parse(recordPriceRequestSchema, body);
      findSupplier(input.supplierId);
      if (!unitKnown(input.unit)) throw fail(422, "unit-unknown");
      return {
        status: 201,
        body: { price: priceWire(writePrice(state, target, input, actor, null)) },
        schema: priceResponseSchema,
      };
    }
    const correctMatch = /^prices\/([^/]+)\/corrections$/.exec(rest);
    if (correctMatch && method === "POST") {
      const { reason, ...input } = parse(correctPriceRequestSchema, body);
      findSupplier(input.supplierId);
      if (!state.prices.some((price) => price.id === correctMatch[1])) throw fail(404, "not-found");
      if (correctedBy(state, correctMatch[1]!)) throw fail(409, "price-already-corrected");
      const price = writePrice(state, target, input, actor, { priceId: correctMatch[1]!, reason });
      return { status: 201, body: { price: priceWire(price) }, schema: priceResponseSchema };
    }
    throw fail(404, "not-found");
  }

  if (path === "/suppliers" && method === "GET") {
    viewer();
    const search = query.get("search")?.toLowerCase();
    const status = query.get("status");
    const etims = query.get("etims");
    const suppliers = state.suppliers
      .filter((entry) => !status || entry.supplier.status === status)
      .filter((entry) => !etims || entry.supplier.etimsStatus === etims)
      .filter(
        (entry) =>
          !search ||
          [entry.supplier.code, entry.supplier.legalName, entry.supplier.tradingName].some(
            (value) => value?.toLowerCase().includes(search),
          ),
      )
      .map(supplierSummary);
    return {
      body: { suppliers, page: { nextCursor: null, hasMore: false }, permissions: { canManage } },
      schema: suppliersResponseSchema,
    };
  }
  if (path === "/suppliers" && method === "POST") {
    manager();
    const input = parse(createSupplierRequestSchema, body);
    if (input.kraPin && state.suppliers.some((entry) => entry.kraPin === input.kraPin))
      throw fail(409, "kra-pin-taken");
    const entry: MockSupplier = {
      supplier: {
        id: randomUUID(),
        code: `SUP-${String(state.suppliers.length + 1).padStart(4, "0")}`,
        legalName: input.legalName,
        tradingName: input.tradingName ?? null,
        kraPinMasked: input.kraPin ? maskKraPin(input.kraPin) : null,
        etimsStatus: input.etimsStatus,
        etimsCheckedOn: input.etimsCheckedOn ?? null,
        status: "active",
        statusReason: null,
        creditDays: input.creditDays,
        creditLimitMinor: input.creditLimitMinor ?? null,
        notes: input.notes ?? null,
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      kraPin: input.kraPin ?? null,
      contacts: input.contacts.map((contact) => ({
        id: randomUUID(),
        name: contact.name,
        role: contact.role ?? null,
        phone: contact.phone ?? null,
        email: contact.email ?? null,
        primary: contact.primary,
        phoneChangedAt: contact.phone ? new Date().toISOString() : null,
      })),
      payouts: [],
    };
    state.suppliers.push(entry);
    return { status: 201, ...supplierDetail(entry) };
  }
  const supplierMatch = /^\/suppliers\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (!supplierMatch) return null;
  const [, supplierId, rest = ""] = supplierMatch;
  const entry = findSupplier(supplierId!);
  if (rest === "" && method === "GET") {
    viewer();
    return supplierDetail(entry);
  }
  if (rest === "" && method === "PATCH") {
    manager();
    const { version, contacts, kraPin, ...fields } = parse(updateSupplierRequestSchema, body);
    if (entry.supplier.version !== version) throw fail(409, "version-conflict");
    if (kraPin && state.suppliers.some((other) => other !== entry && other.kraPin === kraPin))
      throw fail(409, "kra-pin-taken");
    Object.assign(
      entry.supplier,
      Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
    );
    if (entry.supplier.status === "active") entry.supplier.statusReason = null;
    if (kraPin !== undefined) {
      entry.kraPin = kraPin;
      entry.supplier.kraPinMasked = kraPin ? maskKraPin(kraPin) : null;
    }
    if (contacts) {
      entry.contacts = contacts.map((contact) => {
        const previous = entry.contacts.find((existing) => existing.id === contact.id);
        const phone = contact.phone === undefined ? (previous?.phone ?? null) : contact.phone;
        const changed = phone !== (previous?.phone ?? null);
        if (changed)
          for (const version of entry.payouts)
            if (version.status === "pending") {
              version.contactChangeWarning = true;
              if (!version.contributorIds.includes(actor.id)) {
                version.contributorIds.push(actor.id);
                version.contributors.push(actor);
              }
            }
        return {
          id: previous?.id ?? randomUUID(),
          name: contact.name,
          role: contact.role ?? null,
          phone,
          email: contact.email ?? null,
          primary: contact.primary,
          phoneChangedAt: changed ? new Date().toISOString() : (previous?.phoneChangedAt ?? null),
        };
      });
    }
    entry.supplier.version += 1;
    entry.supplier.updatedAt = new Date().toISOString();
    return supplierDetail(entry);
  }
  if (rest === "reveal" && method === "POST") {
    const input = parse(supplierRevealRequestSchema, body);
    const allowed =
      input.field === "accountNumber"
        ? companyWide("finance.view_sensitive")
        : canManage || companyWide("finance.view_sensitive");
    if (!allowed) throw fail(403, "forbidden");
    const value =
      input.field === "kraPin"
        ? entry.kraPin
        : input.field === "contactPhone"
          ? (entry.contacts.find((contact) => contact.id === input.contactId)?.phone ?? null)
          : (entry.payouts.find((version) => version.id === input.payoutId)?.accountNumber ?? null);
    if (!value) throw fail(409, "nothing-to-reveal");
    return { body: { field: input.field, value }, schema: supplierRevealResponseSchema };
  }
  if (rest === "payout-details" && method === "POST") {
    manager();
    const input = parse(proposePayoutRequestSchema, body);
    deps.requireStepUp();
    const current =
      entry.payouts.find(
        (version) => version.status === "pending" || version.status === "verified",
      ) ?? null;
    if ((current?.id ?? null) !== input.replaces) throw fail(409, "payout-stale");
    if (current)
      Object.assign(current, {
        status: "superseded",
        supersededAt: new Date().toISOString(),
        usableForPayment: false,
      });
    const warning = entry.contacts.some(
      (contact) =>
        contact.phoneChangedAt && Date.now() - Date.parse(contact.phoneChangedAt) < 30 * 86_400_000,
    );
    entry.payouts.push(payout(entry.payouts.length + 1, input, actor, warning));
    return { status: 201, ...supplierDetail(entry) };
  }
  const decideMatch = /^payout-details\/([^/]+)\/(verify|reject)$/.exec(rest);
  if (decideMatch && method === "POST") {
    if (!companyWide("payments.approve")) throw fail(403, "forbidden");
    const version = entry.payouts.find((candidate) => candidate.id === decideMatch[1]);
    if (!version) throw fail(404, "payout-not-found");
    if (decideMatch[2] === "verify") {
      const input = parse(verifyPayoutRequestSchema, body);
      deps.requireStepUp();
      if (version.status !== "pending") throw fail(409, "payout-not-pending");
      if (version.contributorIds.includes(actor.id)) throw fail(403, "maker-checker");
      Object.assign(version, {
        status: "verified",
        verifiedAt: new Date().toISOString(),
        verifiedBy: actor,
        verificationMethod: input.method,
        verificationNote: input.note,
        usableForPayment: true,
      });
    } else {
      const input = parse(rejectPayoutRequestSchema, body);
      if (version.status !== "pending") throw fail(409, "payout-not-pending");
      if (version.contributorIds.includes(actor.id)) throw fail(403, "maker-checker");
      Object.assign(version, {
        status: "rejected",
        rejectedAt: new Date().toISOString(),
        rejectedBy: actor,
        rejectionReason: input.reason,
      });
    }
    return supplierDetail(entry);
  }
  throw fail(404, "not-found");
}
