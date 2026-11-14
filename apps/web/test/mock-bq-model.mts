/**
 * Shared state and wire helpers for the BQ parts of the Playwright mock API (mock-bq.mts,
 * mock-variations.mts, mock-buildups.mts). Versions hold the domain's lineage-addressed content,
 * so variations, comparisons and totals use the real packages/domain functions.
 */
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import {
  buildupRate,
  versionTotals,
  type BqBuildResult,
  type BqKindTotals,
  type BqMapping,
  type VariationLineInput,
  type VersionContent,
  type VersionItem,
} from "@pm-buddy/domain";
import type {
  BqItemKind,
  BuildupOutputUnit,
  BuildupResourceKind,
  Permission,
  VariationAction,
  VariationStatus,
} from "@pm-buddy/types";
import type {
  BqBillWire,
  BqImport,
  BqItemRateLink,
  BqItemWire,
  BqTemplate,
  BqVersionWire,
  Instruction,
  Project,
  StaffClientRequest,
} from "@pm-buddy/validation";
import type { WorkbookGrid } from "@pm-buddy/domain";

export const VAT = "16";
export type Person = { id: string; displayName: string };
export type Reply = { status?: number; body: unknown; schema: z.ZodType<unknown> };
export type Fail = (status: number, code: string) => Error;

export type MockImport = { record: BqImport; grid: WorkbookGrid };
export type MockVersion = {
  id: string;
  versionNo: number;
  version: number;
  status: "draft" | "approved";
  source: "import" | "variation";
  parentVersionId: string | null;
  variation: { id: string; number: string } | null;
  createdBy: Person;
  updatedBy: Person;
  approvedBy: Person | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  content: VersionContent;
  /** Wire IDs of this version's bills, sections and items by lineage. */
  ids: Map<string, string>;
  importId: string | null;
};
export type MockVariation = {
  id: string;
  number: string;
  title: string;
  description: string | null;
  status: VariationStatus;
  instructionId: string;
  baseVersionId: string;
  lines: { id: string; input: VariationLineInput }[];
  /** The lines' pricing against the base version (as stored by the API). */
  priced: { baseAmountMinor: number; newAmountMinor: number; deltaMinor: number }[];
  createdBy: Person;
  createdAt: string;
  submittedBy: Person | null;
  submittedAt: string | null;
  digest: string | null;
  decidedBy: Person | null;
  decidedAt: string | null;
  decisionReason: string | null;
  cancelReason: string | null;
  history: {
    from: VariationStatus | null;
    to: VariationStatus;
    action: VariationAction | "create";
    reason: string | null;
    by: Person;
    at: string;
  }[];
  version: number;
  /** D7.1 sendings of the current and earlier submissions to the client. */
  clientRequests?: StaffClientRequest[];
};
export type MockLink = {
  buildupId: string;
  buildupVersionId: string;
  linkedAt: string;
  linkedBy: Person;
};
export type ProjectBq = {
  imports: MockImport[];
  versions: MockVersion[];
  instructions: Instruction[];
  variations: MockVariation[];
  links: Map<string, MockLink>;
};
export type MockBuildupVersion = {
  id: string;
  versionNo: number;
  name: string;
  unit: BuildupOutputUnit;
  assumptions: string | null;
  lines: {
    kind: BuildupResourceKind;
    resourceName: string;
    unit: string;
    quantity: string;
    wastePercent: string | null;
    unitCostMinor: number | null;
  }[];
  createdAt: string;
  createdBy: Person;
};
export type MockBuildup = {
  id: string;
  code: string;
  versions: MockBuildupVersion[];
  updatedAt: string;
  version: number;
};
export type BqState = {
  projects: Map<string, ProjectBq>;
  templates: BqTemplate[];
  buildups: MockBuildup[];
};

export type BqDeps = {
  fail: Fail;
  parse<T>(schema: z.ZodType<T>, body: unknown): T;
  project(permission: Permission): Project;
  permissions(): Permission[];
  actor: Person;
  requireStepUp(): void;
};

export const emptyProjectBq = (): ProjectBq => ({
  imports: [],
  versions: [],
  instructions: [],
  variations: [],
  links: new Map(),
});

export const latestApproved = (entry: ProjectBq): MockVersion | null =>
  [...entry.versions].reverse().find((version) => version.status === "approved") ?? null;
export const currentVersion = (entry: ProjectBq): MockVersion | null =>
  latestApproved(entry) ?? entry.versions.at(-1) ?? null;

/** Domain content (with fresh lineages) from a built import. */
export function contentFromBuild(result: BqBuildResult): VersionContent {
  const content: VersionContent = { bills: [], sections: [], items: [] };
  result.bills.forEach((bill, billOrder) => {
    const billLineageId = randomUUID();
    content.bills.push({
      lineageId: billLineageId,
      number: bill.number,
      title: bill.title,
      kind: bill.kind,
      sortOrder: billOrder,
      sheetTotalMinor: bill.sheetTotalMinor,
      sourceSheet: bill.sheetName,
    });
    let itemOrder = 0;
    bill.sections.forEach((section, sectionOrder) => {
      const sectionLineageId = randomUUID();
      content.sections.push({
        lineageId: sectionLineageId,
        billLineageId,
        code: section.code,
        title: section.title,
        notes: section.notes,
        sortOrder: sectionOrder,
      });
      for (const item of section.items) {
        content.items.push({
          lineageId: randomUUID(),
          billLineageId,
          sectionLineageId,
          ref: item.ref,
          description: item.description,
          unit: item.unit,
          unitRaw: item.unitRaw,
          quantity: item.quantity,
          rate: item.rate,
          amountMinor: item.amountMinor,
          sheetAmountMinor: item.sheetAmountMinor,
          amountSource: item.amountSource,
          overrideReason: item.overrideReason,
          kind: item.kind,
          notes: item.notes,
          sourceSheet: bill.sheetName,
          sourceRow: item.sheetRow,
          hasFormula: item.hasFormula,
          sortOrder: itemOrder++,
        });
      }
    });
  });
  return content;
}

/** Wire IDs for every bill, section and item of a content (new rows for a new version). */
export function idsFor(content: VersionContent): Map<string, string> {
  return new Map(
    [...content.bills, ...content.sections, ...content.items].map(
      (row) => [row.lineageId, randomUUID()] as const,
    ),
  );
}

export const totalsOf = (version: MockVersion) => versionTotals(version.content, VAT);

const KIND_BUCKET: Record<BqItemKind, keyof BqKindTotals> = {
  measured: "measured",
  preliminary: "preliminaries",
  provisional_sum: "provisionalSums",
  pc_sum: "pcSums",
  pc_attendance: "pcAttendanceProfit",
  pc_profit: "pcAttendanceProfit",
  contingency: "contingencies",
  daywork: "dayworks",
};

export function byKindOf(version: MockVersion): BqKindTotals {
  const totals: BqKindTotals = {
    measured: 0,
    preliminaries: 0,
    provisionalSums: 0,
    pcSums: 0,
    pcAttendanceProfit: 0,
    contingencies: 0,
    dayworks: 0,
  };
  for (const item of version.content.items) totals[KIND_BUCKET[item.kind]] += item.amountMinor;
  return totals;
}

export function versionWire(entry: ProjectBq, version: MockVersion): BqVersionWire {
  const totals = totalsOf(version);
  return {
    id: version.id,
    versionNo: version.versionNo,
    status: version.status,
    source: version.source,
    parentVersionId: version.parentVersionId,
    variation: version.variation,
    createdBy: version.createdBy,
    approvedBy: version.approvedBy,
    approvedAt: version.approvedAt,
    current: currentVersion(entry)?.id === version.id,
    vatRatePercent: VAT,
    vatRuleKey: "bq.vat.rate",
    vatRuleStatus: "compliance_review",
    rounding: "half_up_line",
    subtotalMinor: totals.subtotalMinor,
    vatMinor: totals.vatMinor,
    grandTotalMinor: totals.grandTotalMinor,
    billCount: totals.billCount,
    itemCount: totals.itemCount,
    createdAt: version.createdAt,
    updatedAt: version.updatedAt,
    version: version.version,
  };
}

export function billWires(version: MockVersion): BqBillWire[] {
  const totals = totalsOf(version);
  const sortedBills = [...version.content.bills].sort(
    (left, right) => left.sortOrder - right.sortOrder,
  );
  return sortedBills.map((bill) => {
    const sections = version.content.sections
      .filter((section) => section.billLineageId === bill.lineageId)
      .sort((left, right) => left.sortOrder - right.sortOrder);
    return {
      id: version.ids.get(bill.lineageId)!,
      lineageId: bill.lineageId,
      number: bill.number,
      title: bill.title,
      kind: bill.kind,
      totalMinor: totals.bills[bill.lineageId] ?? 0,
      sheetTotalMinor: bill.sheetTotalMinor,
      itemCount: version.content.items.filter((item) => item.billLineageId === bill.lineageId)
        .length,
      sections: sections.map((section) => ({
        id: version.ids.get(section.lineageId)!,
        lineageId: section.lineageId,
        code: section.code,
        title: section.title,
        notes: section.notes,
        totalMinor: totals.sections[section.lineageId] ?? 0,
        itemCount: version.content.items.filter(
          (item) => item.sectionLineageId === section.lineageId,
        ).length,
      })),
    };
  });
}

export function linkWire(state: BqState, link: MockLink | undefined): BqItemRateLink | null {
  if (!link) return null;
  const buildup = state.buildups.find((entry) => entry.id === link.buildupId);
  const version = buildup?.versions.find((entry) => entry.id === link.buildupVersionId);
  if (!buildup || !version) return null;
  return {
    buildupId: buildup.id,
    buildupVersionId: version.id,
    code: buildup.code,
    name: version.name,
    versionNo: version.versionNo,
    unit: version.unit,
    rateMinor: buildupRateOf(version),
    linkedAt: link.linkedAt,
    linkedBy: link.linkedBy,
  };
}

export function itemWire(
  state: BqState,
  entry: ProjectBq,
  version: MockVersion,
  item: VersionItem,
): BqItemWire {
  return {
    id: version.ids.get(item.lineageId)!,
    lineageId: item.lineageId,
    sectionId: item.sectionLineageId ? (version.ids.get(item.sectionLineageId) ?? null) : null,
    ref: item.ref,
    description: item.description,
    unit: item.unit,
    unitRaw: item.unitRaw,
    quantity: item.quantity,
    rate: item.rate,
    amountMinor: item.amountMinor,
    sheetAmountMinor: item.sheetAmountMinor,
    amountSource: item.amountSource,
    overrideReason: item.overrideReason,
    kind: item.kind,
    notes: item.notes,
    sourceSheet: item.sourceSheet,
    sourceRow: item.sourceRow,
    hasFormula: item.hasFormula,
    rateBuildUp: linkWire(state, entry.links.get(item.lineageId)),
  };
}

/** Items of one bill of a version, in order, as wire items. */
export function billItems(
  state: BqState,
  entry: ProjectBq,
  version: MockVersion,
  billLineageId: string,
) {
  return version.content.items
    .filter((item) => item.billLineageId === billLineageId)
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((item) => itemWire(state, entry, version, item));
}

export function buildupRateOf(version: MockBuildupVersion): number | null {
  return buildupRate(version.lines).rateMinor;
}

export const mappingOf = (record: BqImport) => record.mapping as unknown as BqMapping;
