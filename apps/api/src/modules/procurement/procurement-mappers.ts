import {
  defineCustomUnit,
  derivedEdges,
  findUnit,
  type ConversionRule,
  type MaterialAttributes,
  type UnitDefinition,
} from "@pm-buddy/domain";
import {
  DIMENSION_BASE_UNITS,
  type MaterialCategory,
  type SizedDimension,
  type UnitDimension,
} from "@pm-buddy/types";
import {
  materialAttributesSchema,
  type Conversion,
  type ConversionStepWire,
  type Material,
  type PayoutVersion,
  type Price,
  type Supplier,
  type SupplierContact,
  type UnitWire,
} from "@pm-buddy/validation";
import type { Prisma } from "../../generated/prisma/client.js";

export type Tx = Prisma.TransactionClient;
export type MaterialRow = Prisma.MaterialGetPayload<object>;
export type UnitRow = Prisma.UnitGetPayload<object>;
export type ConversionRow = Prisma.UnitConversionGetPayload<object>;
export type PriceRow = Prisma.MaterialPriceGetPayload<object>;
export type SupplierRow = Prisma.SupplierGetPayload<object>;
export type ContactRow = Prisma.SupplierContactGetPayload<object>;
export type PayoutRow = Prisma.SupplierPayoutVersionGetPayload<object>;

export type People = ReadonlyMap<string, string>;
export type Ref = { id: string; code: string; name: string };

export const toCalendarDate = (value: Date): string => value.toISOString().slice(0, 10);
export const fromCalendarDate = (value: string): Date => new Date(`${value}T00:00:00.000Z`);
const iso = (value: Date | null) => (value ? value.toISOString() : null);

export const safeMinor = (value: bigint | number): number => {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new RangeError("Amount out of the safe integer range");
  return result;
};

/** Display names for audit-free references to people (the users table is not tenant data). */
export async function peopleOf(
  tx: Tx,
  ids: readonly (string | null | undefined)[],
): Promise<People> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!unique.length) return new Map();
  const users = await tx.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, displayName: true },
  });
  return new Map(users.map((user) => [user.id, user.displayName]));
}
export const personOf = (people: People, id: string) => ({
  id,
  displayName: people.get(id) ?? "—",
});
const optionalPerson = (people: People, id: string | null) => (id ? personOf(people, id) : null);

/** Field names (never values) for audit summaries. */
export const changedFields = (input: object) =>
  Object.entries(input)
    .filter(([key, value]) => key !== "version" && value !== undefined)
    .map(([key]) => key)
    .sort();

export function attributesOf(row: Pick<MaterialRow, "attributes">): MaterialAttributes {
  const parsed = materialAttributesSchema.safeParse(row.attributes);
  return parsed.success ? parsed.data : {};
}

export const supplierRef = (
  row: Pick<SupplierRow, "id" | "code" | "legalName" | "tradingName">,
) => ({
  id: row.id,
  code: row.code,
  name: row.tradingName ?? row.legalName,
});
export const materialRef = (row: Pick<MaterialRow, "id" | "code" | "name">) => ({
  id: row.id,
  code: row.code,
  name: row.name,
});

/** Company units as conversion-engine definitions (invalid rows are skipped, never guessed). */
export function unitDefinitions(rows: readonly UnitRow[]): UnitDefinition[] {
  return rows.flatMap((row) => {
    const result = defineCustomUnit({
      code: row.code,
      dimension: row.dimension as UnitDimension,
      equalsQuantity: row.equalsQuantity === null ? null : row.equalsQuantity.toFixed(),
      equalsUnit: row.equalsUnit,
    });
    return result.ok ? [result.unit] : [];
  });
}

export function toRule(row: ConversionRow): ConversionRule {
  return {
    id: row.id,
    supplierId: row.supplierId,
    fromUnit: row.fromUnit,
    fromQuantity: row.fromQuantity.toFixed(),
    toUnit: row.toUnit,
    toQuantity: row.toQuantity.toFixed(),
    effectiveFrom: toCalendarDate(row.effectiveFrom),
    effectiveTo: row.effectiveTo ? toCalendarDate(row.effectiveTo) : null,
  };
}

export function toConversion(
  row: ConversionRow,
  extras: {
    people: People;
    suppliers: ReadonlyMap<string, Ref>;
    on: string;
    factor: string;
    ratio: string;
  },
): Conversion {
  const rule = toRule(row);
  return {
    id: row.id,
    materialId: row.materialId,
    supplier: row.supplierId ? (extras.suppliers.get(row.supplierId) ?? null) : null,
    fromUnit: row.fromUnit,
    fromQuantity: rule.fromQuantity,
    toUnit: row.toUnit,
    toQuantity: rule.toQuantity,
    factor: extras.factor,
    ratio: extras.ratio,
    effectiveFrom: rule.effectiveFrom,
    effectiveTo: rule.effectiveTo,
    note: row.note,
    inForce:
      rule.effectiveFrom <= extras.on &&
      (rule.effectiveTo === null || extras.on < rule.effectiveTo),
    createdAt: row.createdAt.toISOString(),
    createdBy: personOf(extras.people, row.createdBy),
    endedAt: iso(row.endedAt),
    endedBy: optionalPerson(extras.people, row.endedBy),
  };
}

/** Standard factors from a material's attributes (bar mass, piece length, cover, section…). */
export function derivedFactors(row: MaterialRow) {
  return derivedEdges(row.category as MaterialCategory, attributesOf(row)).map((edge) => ({
    from: edge.from,
    to: edge.to,
    factor: edge.ratio.toDecimal(12).value,
    ratio: edge.ratio.toString(),
    rule: edge.rule!,
  }));
}

export function toMaterial(
  row: MaterialRow,
  extras: {
    latest: (PriceRow & { supplier: Ref }) | null;
    alertCount: number;
  },
): Material {
  const latest = extras.latest;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    nameSw: row.nameSw,
    category: row.category as Material["category"],
    baseUnit: row.baseUnit,
    spec: row.spec,
    attributes: attributesOf(row),
    notes: row.notes,
    status: row.status as Material["status"],
    latestPrice: latest
      ? {
          id: latest.id,
          supplier: latest.supplier,
          unit: latest.unit,
          unitPriceMinor: safeMinor(latest.unitPriceMinor),
          vatTreatment: latest.vatTreatment as Price["vatTreatment"],
          effectiveOn: toCalendarDate(latest.effectiveOn),
          alertState: latest.alertState as Price["alertState"],
        }
      : null,
    alertCount: extras.alertCount,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toPrice(
  row: PriceRow,
  extras: { people: People; material: Ref; supplier: Ref; correctedById: string | null },
): Price {
  const snapshot = row.conversionSnapshot as { steps?: ConversionStepWire[] } | null;
  return {
    id: row.id,
    material: extras.material,
    supplier: extras.supplier,
    unit: row.unit,
    unitPriceMinor: safeMinor(row.unitPriceMinor),
    currency: "KES",
    vatTreatment: row.vatTreatment as Price["vatTreatment"],
    vatRatePercent: row.vatRatePercent === null ? null : row.vatRatePercent.toFixed(),
    netUnitPriceMinor: safeMinor(row.netUnitPriceMinor),
    grossUnitPriceMinor: safeMinor(row.grossUnitPriceMinor),
    effectiveOn: toCalendarDate(row.effectiveOn),
    source: row.source as Price["source"],
    sourceReference: row.sourceReference,
    note: row.note,
    comparable:
      row.comparableUnit && row.comparableUnitPriceMinor
        ? {
            unit: row.comparableUnit,
            unitPriceMinor: row.comparableUnitPriceMinor.toFixed(),
            steps: snapshot?.steps ?? [],
          }
        : null,
    change:
      row.previousPriceId && row.changePercent
        ? { previousPriceId: row.previousPriceId, percent: row.changePercent.toFixed() }
        : null,
    alertState: row.alertState as Price["alertState"],
    alertThresholdPercent: row.alertThresholdPercent.toFixed(),
    correctsPriceId: row.correctsPriceId,
    correctionReason: row.correctionReason,
    correctedById: extras.correctedById,
    recordedAt: row.recordedAt.toISOString(),
    recordedBy: personOf(extras.people, row.recordedBy),
  };
}

const standardUnitWire = (unit: UnitDefinition): UnitWire => ({
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
});
export { standardUnitWire };

export function toUnitWire(row: UnitRow): UnitWire {
  const definition = unitDefinitions([row])[0];
  return {
    id: row.id,
    code: row.code,
    dimension: row.dimension as UnitDimension,
    standard: false,
    name: row.name,
    nameSw: row.nameSw,
    equalsQuantity: row.equalsQuantity === null ? null : row.equalsQuantity.toFixed(),
    equalsUnit: row.equalsUnit,
    sizeInBase: definition?.perBase ? definition.perBase.toDecimal(12).value : null,
    baseUnit: definition?.perBase ? DIMENSION_BASE_UNITS[row.dimension as SizedDimension] : null,
    status: row.status as UnitWire["status"],
    version: row.version,
  };
}

/** A unit's code is known (standard or the company's) and, when `activeOnly`, not archived. */
export function unitKnown(code: string, rows: readonly UnitRow[], activeOnly = true): boolean {
  if (findUnit(code)) return true;
  const row = rows.find((unit) => unit.code === code);
  return Boolean(row && (!activeOnly || row.status === "active"));
}

export function toContact(row: ContactRow): SupplierContact {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    phoneMasked: row.phoneMasked,
    email: row.email,
    primary: row.isPrimary,
    phoneChangedAt: iso(row.phoneChangedAt),
  };
}

export function payoutSummary(current: PayoutRow | null): Supplier["payout"] {
  if (!current)
    return { status: "none", usableForPayment: false, mpesaKind: "none", hasBank: false };
  return {
    status: current.status === "verified" ? "verified" : "pending",
    usableForPayment: current.status === "verified",
    mpesaKind: current.mpesaKind as Supplier["payout"]["mpesaKind"],
    hasBank: current.bankName !== null,
  };
}

export function toSupplier(
  row: SupplierRow,
  extras: { primary: ContactRow | null; current: PayoutRow | null },
): Supplier {
  return {
    id: row.id,
    code: row.code,
    legalName: row.legalName,
    tradingName: row.tradingName,
    kraPinMasked: row.kraPinMasked,
    etimsStatus: row.etimsStatus as Supplier["etimsStatus"],
    etimsCheckedOn: row.etimsCheckedOn ? toCalendarDate(row.etimsCheckedOn) : null,
    status: row.status as Supplier["status"],
    statusReason: row.statusReason,
    creditDays: row.creditDays,
    creditLimitMinor: row.creditLimitMinor === null ? null : safeMinor(row.creditLimitMinor),
    primaryContact: extras.primary
      ? {
          name: extras.primary.name,
          phoneMasked: extras.primary.phoneMasked,
          email: extras.primary.email,
        }
      : null,
    payout: payoutSummary(extras.current),
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toPayout(
  row: PayoutRow,
  extras: { people: People; callerId: string; callerCanVerify: boolean },
): PayoutVersion {
  return {
    id: row.id,
    versionNo: row.versionNo,
    status: row.status as PayoutVersion["status"],
    mpesaKind: row.mpesaKind as PayoutVersion["mpesaKind"],
    paybillNumber: row.paybillNumber,
    accountReference: row.accountReference,
    tillNumber: row.tillNumber,
    bank:
      row.bankName && row.accountName && row.accountNumberMasked
        ? {
            bankName: row.bankName,
            branch: row.bankBranch,
            accountName: row.accountName,
            accountNumberMasked: row.accountNumberMasked,
          }
        : null,
    proposedAt: row.proposedAt.toISOString(),
    proposedBy: personOf(extras.people, row.proposedBy),
    contributors: row.contributors.map((id) => personOf(extras.people, id)),
    verifiedAt: iso(row.verifiedAt),
    verifiedBy: optionalPerson(extras.people, row.verifiedBy),
    verificationMethod: row.verificationMethod as PayoutVersion["verificationMethod"],
    verificationNote: row.verificationNote,
    rejectedAt: iso(row.rejectedAt),
    rejectedBy: optionalPerson(extras.people, row.rejectedBy),
    rejectionReason: row.rejectionReason,
    supersededAt: iso(row.supersededAt),
    usableForPayment: row.status === "verified",
    contactChangeWarning: row.contactChangeWarning,
    canDecide:
      extras.callerCanVerify &&
      row.status === "pending" &&
      !row.contributors.includes(extras.callerId),
  };
}
