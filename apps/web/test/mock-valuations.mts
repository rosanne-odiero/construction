/**
 * D6.3 measurement and valuations in the Playwright mock API: the measurement sheet of Ruiru
 * Heights' BQ, measurements with site-photo evidence and an independent review, interim
 * valuations and payment certificates (materials on site, retention with its limit, adjustments,
 * VAT, certification by someone who did not prepare it, with step-up, on the digest seen), the
 * retention ledger, earned value with a weekly S-curve and cost to complete. Figures use the real
 * packages/domain functions (KE-VAL-1); requests and responses go through the shared schemas.
 * Permissions follow the API: MEASUREMENT_* and VALUATION_* lists on the project. The BQ below is
 * a valuations-local fixture (BQ version 1 in force, original = revised contract sum):
 *   P1 preliminaries, lump sum KES 500,000 (percent complete)
 *   A  excavation 24 m³ @ 16,500 = KES 396,000      B blockwork 120 m² @ 1,450 = KES 174,000
 *   PS1 provisional sum KES 300,000 (not measured)   D1 dayworks 100 hr @ 450 = KES 45,000
 * Contract settings v1: retention 10 % limited to 5 % of 1,415,000 (= 70,750), VAT 16 %,
 * materials on site 80 %, half released at practical completion. IPC-0001 (certified) valued
 * P1 at 40 % (200,000) and A at 12 m³ (198,000): gross 398,000, retention 39,800, due 358,200,
 * VAT 57,312. B at 60 m² (87,000) waits for approval. Synthetic data only.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  addCalendarDays,
  computeCertificate,
  costToComplete,
  earnedValueFigures,
  measuredPercent,
  measuredValueMinor,
  measurementBasis,
  measurementState,
  measurementsInForce,
  nairobiDate,
  sCurve,
  valuationCode,
  weekEnds,
  type MeasurableItem,
} from "@pm-buddy/domain";
import {
  CONTRACT_SETTINGS_PERMISSIONS,
  EARNED_VALUE_READ_PERMISSIONS,
  MEASUREMENT_APPROVE_PERMISSIONS,
  MEASUREMENT_READ_PERMISSIONS,
  MEASUREMENT_RECORD_PERMISSIONS,
  VALUATION_CERTIFY_PERMISSIONS,
  VALUATION_PREPARE_PERMISSIONS,
  VALUATION_READ_PERMISSIONS,
  VALUATION_RULE_VERSION,
  type AdjustmentKind,
  type MeasurementDecision,
  type Permission,
  type ValuationStatus,
} from "@pm-buddy/types";
import {
  addValuationAdjustmentRequestSchema,
  addValuationMaterialRequestSchema,
  approvalQueueResponseSchema,
  certifyValuationRequestSchema,
  contractSettingsResponseSchema,
  costToCompleteResponseSchema,
  createMeasurementRequestSchema,
  createValuationRequestSchema,
  earnedValueResponseSchema,
  measurementDetailResponseSchema,
  measurementItemsResponseSchema,
  measurementPhotosRequestSchema,
  measurementResponseSchema,
  projectValuationsResponseSchema,
  rejectMeasurementRequestSchema,
  updateContractSettingsRequestSchema,
  updateValuationRequestSchema,
  valuationReasonRequestSchema,
  valuationResponseSchema,
  valuationsOverviewResponseSchema,
  valuationVersionRequestSchema,
  type ContractSettings,
  type CostToCompleteRow,
  type Measurement,
  type ValuationDetail,
  type ValuationFigures,
  type ValuationSummary,
} from "@pm-buddy/validation";

type Person = { id: string; displayName: string };
type Reply = { status?: number; body: unknown; schema: import("zod").ZodType<unknown> };
type Bill = { lineageId: string; number: string; title: string };
type ProjectInfo = { id: string; code: string; name: string; status: string };

export type ValuationsDeps = {
  fail: (status: number, code: string) => Error;
  parse<T>(schema: import("zod").ZodType<T>, body: unknown): T;
  actor: Person;
  projects: ProjectInfo[];
  /** The persona's permissions on a project (company-wide roles hold their role everywhere). */
  projectPermissions(projectId: string): readonly Permission[];
  photo(
    projectId: string,
    photoId: string,
  ): { id: string; verified: boolean; caption: string | null } | null;
  requireStepUp(): void;
  idempotencyKey: string | undefined;
};

type MockItem = MeasurableItem & {
  lineageId: string;
  ref: string;
  description: string;
  unit: string | null;
  bill: Bill;
};

type MockMeasurement = {
  id: string;
  projectId: string;
  lineageId: string;
  measuredOn: string;
  quantityToDate: string;
  note: string | null;
  overMeasureReason: string | null;
  correctsMeasurementId: string | null;
  correctionReason: string | null;
  measuredBy: Person;
  recordedAt: string;
  photoIds: string[];
  review: {
    decision: MeasurementDecision;
    reason: string | null;
    decidedBy: Person;
    decidedAt: string;
  } | null;
};

type MaterialInput = {
  id: string;
  lineageId: string;
  description: string;
  unit: string | null;
  quantity: string;
  amountMinor: number;
  reference: string | null;
  createdBy: Person;
};
type AdjustmentInput = {
  id: string;
  kind: AdjustmentKind;
  description: string;
  amountMinor: number;
  createdBy: Person;
};

type Computed = Pick<ValuationDetail, "figures" | "lines" | "warnings" | "terms"> & {
  digest: string;
};

type MockValuation = {
  id: string;
  projectId: string;
  seq: number;
  number: string;
  certificateNumber: string | null;
  status: ValuationStatus;
  valuationDate: string;
  notes: string | null;
  materialsFromStores: boolean;
  returnReason: string | null;
  cancelReason: string | null;
  cancelledBy: Person | null;
  cancelledAt: string | null;
  createdBy: Person;
  createdAt: string;
  submittedBy: Person | null;
  submittedAt: string | null;
  certifiedBy: Person | null;
  certifiedAt: string | null;
  version: number;
  revision: number;
  contributors: string[];
  materials: MaterialInput[];
  adjustments: AdjustmentInput[];
  /** Fixed at submission (the lines and figures the certifier sees). */
  frozen: Computed | null;
};

export type ValuationsState = {
  projectId: string;
  bqVersionId: string;
  items: MockItem[];
  settings: ContractSettings;
  measurements: MockMeasurement[];
  valuations: MockValuation[];
  counters: { VAL: number; IPC: number };
  replays: Map<string, { digest: string; measurementId: string }>;
  /** Accrued actual cost by date (the D5.4 ledger in the API). */
  costs: { date: string; lineageId: string | null; valueMinor: number }[];
  budget: { id: string; versionNo: number; name: string; byItem: Map<string, number> };
  baseline: { id: string; start: string; finish: string };
};

const PM = { id: "21000000-0000-4000-8000-000000000002", displayName: "Brian Otieno" };
const AGENT = { id: "21000000-0000-4000-8000-000000000003", displayName: "Kevin Kiprono" };
const FINANCE = { id: "21000000-0000-4000-8000-000000000005", displayName: "Daniel Mwangi" };
const BILLS: Bill[] = [
  {
    lineageId: "77000000-0000-4000-8000-000000000001",
    number: "1",
    title: "Preliminaries (synthetic)",
  },
  {
    lineageId: "77000000-0000-4000-8000-000000000002",
    number: "2",
    title: "Substructure (synthetic)",
  },
  {
    lineageId: "77000000-0000-4000-8000-000000000003",
    number: "3",
    title: "Provisional sums and dayworks (synthetic)",
  },
];
export const VALUATION_ITEM_IDS = {
  P1: "77100000-0000-4000-8000-000000000001",
  A: "77100000-0000-4000-8000-000000000002",
  B: "77100000-0000-4000-8000-000000000003",
  PS1: "77100000-0000-4000-8000-000000000004",
  D1: "77100000-0000-4000-8000-000000000005",
} as const;
export const IPC1_ID = "77200000-0000-4000-8000-000000000001";
export const PENDING_MEASUREMENT_ID = "77300000-0000-4000-8000-000000000003";

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const now = () => new Date().toISOString();
const has = (held: readonly Permission[], keys: readonly Permission[]) =>
  keys.some((key) => held.includes(key));
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

export function initialValuations(projectId: string, photoIds: string[]): ValuationsState {
  const today = nairobiDate();
  const day = (offset: number) => addCalendarDays(today, offset);
  const item = (
    lineageId: string,
    bill: Bill,
    ref: string,
    description: string,
    fields: Pick<MockItem, "kind" | "amountSource" | "quantity" | "rate" | "amountMinor" | "unit">,
  ): MockItem => ({ lineageId, bill, ref, description, ...fields });
  const items = [
    item(VALUATION_ITEM_IDS.P1, BILLS[0]!, "P1", "Preliminaries and general items", {
      kind: "preliminary",
      amountSource: "lump_sum",
      quantity: null,
      rate: null,
      amountMinor: 50_000_000,
      unit: "item",
    }),
    item(VALUATION_ITEM_IDS.A, BILLS[1]!, "A", "Excavation to foundation trenches", {
      kind: "measured",
      amountSource: "computed",
      quantity: "24",
      rate: "16500",
      amountMinor: 39_600_000,
      unit: "m3",
    }),
    item(VALUATION_ITEM_IDS.B, BILLS[1]!, "B", "200 mm blockwork walling", {
      kind: "measured",
      amountSource: "computed",
      quantity: "120",
      rate: "1450",
      amountMinor: 17_400_000,
      unit: "m2",
    }),
    item(VALUATION_ITEM_IDS.PS1, BILLS[2]!, "PS1", "Provisional sum for electrical works", {
      kind: "provisional_sum",
      amountSource: "lump_sum",
      quantity: null,
      rate: null,
      amountMinor: 30_000_000,
      unit: "item",
    }),
    item(VALUATION_ITEM_IDS.D1, BILLS[2]!, "D1", "Dayworks: general labour", {
      kind: "daywork",
      amountSource: "computed",
      quantity: "100",
      rate: "450",
      amountMinor: 4_500_000,
      unit: "hr",
    }),
  ];
  const approved = (decidedAt: string) => ({
    decision: "approved" as const,
    reason: null,
    decidedBy: PM,
    decidedAt,
  });
  const measurement = (
    idSuffix: string,
    lineageId: string,
    measuredOn: string,
    quantityToDate: string,
    review: MockMeasurement["review"],
  ): MockMeasurement => ({
    id: `77300000-0000-4000-8000-00000000000${idSuffix}`,
    projectId,
    lineageId,
    measuredOn,
    quantityToDate,
    note: null,
    overMeasureReason: null,
    correctsMeasurementId: null,
    correctionReason: null,
    measuredBy: AGENT,
    recordedAt: `${measuredOn}T07:30:00.000Z`,
    photoIds: photoIds.slice(0, 1),
    review,
  });
  const state: ValuationsState = {
    projectId,
    bqVersionId: "77000000-0000-4000-8000-0000000000aa",
    items,
    settings: {
      retentionPercent: "10",
      retentionCapPercent: "5",
      vatPercent: "16",
      materialsPercent: "80",
      practicalReleasePercent: "50",
      version: 1,
      updatedAt: `${day(-40)}T08:00:00.000Z`,
      updatedBy: FINANCE,
    },
    measurements: [
      measurement(
        "1",
        VALUATION_ITEM_IDS.P1,
        day(-30),
        "40",
        approved(`${day(-29)}T09:00:00.000Z`),
      ),
      measurement("2", VALUATION_ITEM_IDS.A, day(-30), "12", approved(`${day(-29)}T09:05:00.000Z`)),
      measurement("3", VALUATION_ITEM_IDS.B, day(-2), "60", null),
    ],
    valuations: [],
    counters: { VAL: 1, IPC: 1 },
    replays: new Map(),
    costs: [
      { date: day(-45), lineageId: VALUATION_ITEM_IDS.P1, valueMinor: 12_000_000 },
      { date: day(-25), lineageId: VALUATION_ITEM_IDS.A, valueMinor: 15_000_000 },
      { date: day(-10), lineageId: VALUATION_ITEM_IDS.B, valueMinor: 6_000_000 },
      { date: day(-5), lineageId: null, valueMinor: 2_000_000 },
    ],
    budget: {
      id: "76000000-0000-4000-8000-000000000001",
      versionNo: 1,
      name: "Construction budget (synthetic)",
      byItem: new Map([
        [VALUATION_ITEM_IDS.P1, 40_000_000],
        [VALUATION_ITEM_IDS.A, 30_000_000],
        [VALUATION_ITEM_IDS.B, 14_000_000],
      ]),
    },
    baseline: { id: "77400000-0000-4000-8000-000000000001", start: day(-56), finish: day(56) },
  };
  const ipc1: MockValuation = {
    id: IPC1_ID,
    projectId,
    seq: 1,
    number: valuationCode("VAL", 1),
    certificateNumber: null,
    status: "draft",
    valuationDate: day(-28),
    notes: null,
    materialsFromStores: false,
    returnReason: null,
    cancelReason: null,
    cancelledBy: null,
    cancelledAt: null,
    createdBy: PM,
    createdAt: `${day(-28)}T10:00:00.000Z`,
    submittedBy: null,
    submittedAt: null,
    certifiedBy: null,
    certifiedAt: null,
    version: 1,
    revision: 0,
    contributors: [PM.id],
    materials: [],
    adjustments: [],
    frozen: null,
  };
  state.valuations.push(ipc1);
  ipc1.frozen = compute(state, ipc1);
  Object.assign(ipc1, {
    status: "certified",
    certificateNumber: valuationCode("IPC", 1),
    submittedBy: PM,
    submittedAt: `${day(-28)}T11:00:00.000Z`,
    certifiedBy: FINANCE,
    certifiedAt: `${day(-27)}T09:00:00.000Z`,
    version: 3,
    revision: 1,
  });
  return state;
}

function terms(state: ValuationsState) {
  const { settings } = state;
  return {
    retentionPercent: settings.retentionPercent,
    retentionCapPercent: settings.retentionCapPercent,
    vatPercent: settings.vatPercent,
    materialsPercent: settings.materialsPercent,
    practicalReleasePercent: settings.practicalReleasePercent,
    settingsVersion: settings.version,
    ruleVersion: VALUATION_RULE_VERSION,
  };
}

const ORIGINAL_MINOR = 141_500_000;
const contractSum = () => ({
  originalMinor: ORIGINAL_MINOR,
  revisedMinor: ORIGINAL_MINOR,
  revisedVersionNo: 1,
});

function stated(state: ValuationsState) {
  return state.measurements.map((row) => {
    const correction = state.measurements
      .filter((other) => other.correctsMeasurementId === row.id)
      .at(-1);
    return {
      row,
      state: measurementState({
        decision: row.review?.decision ?? null,
        correctedBy: correction ? { decision: correction.review?.decision ?? null } : null,
      }),
    };
  });
}

function inForce(state: ValuationsState, asOf: string) {
  return measurementsInForce(
    stated(state).map(({ row, state: current }) => ({
      id: row.id,
      lineageId: row.lineageId,
      measuredOn: row.measuredOn,
      recordedAt: row.recordedAt,
      state: current,
      row,
    })),
    asOf,
  );
}

const bqItem = (state: ValuationsState, item: MockItem) => ({
  versionId: state.bqVersionId,
  lineageId: item.lineageId,
  ref: item.ref,
  description: item.description,
  unit: item.unit,
  bill: item.bill,
});

function compute(state: ValuationsState, valuation: MockValuation): Computed {
  const certified = state.valuations.filter(
    (other) => other.status === "certified" && other.seq < valuation.seq && other.frozen,
  );
  const last = certified.at(-1)?.frozen ?? null;
  const valued = inForce(state, valuation.valuationDate);
  const items = state.items
    .filter((item) => measurementBasis(item) !== null)
    .map((item, index) => {
      const entry = valued.get(item.lineageId)?.row ?? null;
      const toDateMinor = entry ? measuredValueMinor(item, entry.quantityToDate) : 0;
      const previousMinor =
        last?.lines.items.find((line) => line.bqItem.lineageId === item.lineageId)?.toDateMinor ??
        0;
      return {
        lineNo: index + 1,
        bqItem: bqItem(state, item),
        kind: item.kind,
        basis: measurementBasis(item),
        itemQuantity: item.quantity,
        rate: item.rate,
        itemAmountMinor: item.amountMinor,
        measurementId: entry?.id ?? null,
        measuredOn: entry?.measuredOn ?? null,
        quantityToDate: entry?.quantityToDate ?? null,
        percentComplete: entry ? measuredPercent(item, entry.quantityToDate) : null,
        overMeasured: Boolean(entry?.overMeasureReason),
        previousMinor,
        toDateMinor,
        thisPeriodMinor: toDateMinor - previousMinor,
      };
    });
  const materials = [
    ...valuation.materials.map((input, index) => ({
      lineNo: index + 1,
      source: "manual" as const,
      description: input.description,
      unit: input.unit,
      quantity: input.quantity,
      amountMinor: input.amountMinor,
      bqItem: bqItem(
        state,
        state.items.find((item) => item.lineageId === input.lineageId)!,
      ),
      store: null,
      reference: input.reference,
    })),
    ...(valuation.materialsFromStores
      ? [
          {
            lineNo: valuation.materials.length + 1,
            source: "stores" as const,
            description: "Cement 42.5N (synthetic)",
            unit: "bag",
            quantity: "40",
            amountMinor: 3_000_000,
            bqItem: null,
            store: { id: "73000000-0000-4000-8000-000000000001", name: "Main yard store" },
            reference: null,
          },
        ]
      : []),
  ];
  const adjustments = valuation.adjustments.map((input, index) => ({
    lineNo: index + 1,
    kind: input.kind,
    description: input.description,
    amountMinor: input.amountMinor,
  }));
  const figures: ValuationFigures = computeCertificate({
    workDoneMinor: sum(items.map((line) => line.toDateMinor)),
    materialsGrossMinor: sum(materials.map((line) => line.amountMinor)),
    adjustmentsMinor: sum(adjustments.map((line) => line.amountMinor)),
    adjustmentsBeforeMinor: sum(certified.map((other) => other.frozen!.figures.adjustmentsMinor)),
    previousCertifiedMinor: sum(certified.map((other) => other.frozen!.figures.amountDueMinor)),
    stage: "none",
    originalContractSumMinor: ORIGINAL_MINOR,
    terms: state.settings,
  });
  const pending = stated(state).filter(
    (entry) => entry.state === "pending" && entry.row.measuredOn <= valuation.valuationDate,
  ).length;
  const warnings = [
    ...(pending ? [{ code: "pending-measurements" as const, count: pending }] : []),
    ...(items.some((line) => line.measurementId)
      ? []
      : [{ code: "no-measurements" as const, count: 0 }]),
    ...(figures.amountDueMinor < 0 ? [{ code: "negative-amount" as const, count: 0 }] : []),
  ];
  const lines = { items, materials, adjustments };
  const fixedTerms = terms(state);
  return {
    figures,
    lines,
    warnings,
    terms: fixedTerms,
    digest: sha({ figures, lines, terms: fixedTerms, date: valuation.valuationDate }),
  };
}

class Valuations {
  private readonly deps: ValuationsDeps;
  private readonly state: ValuationsState;
  constructor(deps: ValuationsDeps, state: ValuationsState) {
    this.deps = deps;
    this.state = state;
  }

  private fail(status: number, code: string): never {
    throw this.deps.fail(status, code);
  }

  private project(projectId: string) {
    const project = this.deps.projects.find((entry) => entry.id === projectId);
    if (!project) this.fail(404, "not-found");
    return project;
  }

  private ref(projectId: string) {
    const { id, code, name } = this.project(projectId);
    return { id, code, name };
  }

  private held(projectId: string) {
    return this.deps.projectPermissions(projectId);
  }

  /** 404 unless the caller may read `keys` on the project (the API hides what one cannot see). */
  private require(projectId: string, keys: readonly Permission[]) {
    this.project(projectId);
    if (!has(this.held(projectId), keys)) this.fail(404, "not-found");
    return this.held(projectId);
  }

  private writable(projectId: string) {
    const { status } = this.project(projectId);
    if (status === "closed" || status === "cancelled") this.fail(409, "project-read-only");
  }

  private ours(projectId: string) {
    return projectId === this.state.projectId;
  }

  private item(lineageId: string) {
    return this.state.items.find((entry) => entry.lineageId === lineageId) ?? null;
  }

  private stateOf(measurement: MockMeasurement) {
    return stated(this.state).find((entry) => entry.row.id === measurement.id)!.state;
  }

  private wire(measurement: MockMeasurement): Measurement {
    const item = this.item(measurement.lineageId)!;
    const current = this.stateOf(measurement);
    const held = this.held(measurement.projectId);
    const canRecord = has(held, MEASUREMENT_RECORD_PERMISSIONS);
    const canApprove = has(held, MEASUREMENT_APPROVE_PERMISSIONS);
    const pending = current === "pending";
    const own = measurement.measuredBy.id === this.deps.actor.id;
    const corrected = this.state.measurements.some(
      (other) => other.correctsMeasurementId === measurement.id,
    );
    const photos = measurement.photoIds
      .map((photoId) => this.deps.photo(measurement.projectId, photoId))
      .filter((photo) => photo !== null);
    return {
      id: measurement.id,
      projectId: measurement.projectId,
      bqItem: {
        versionId: this.state.bqVersionId,
        lineageId: item.lineageId,
        ref: item.ref,
        description: item.description,
        unit: item.unit,
      },
      measuredOn: measurement.measuredOn,
      quantityToDate: measurement.quantityToDate,
      status: "recorded",
      state: current,
      basis: measurementBasis(item),
      itemQuantity: item.quantity,
      itemAmountMinor: item.amountMinor,
      valueMinor: measuredValueMinor(item, measurement.quantityToDate),
      percentComplete: measuredPercent(item, measurement.quantityToDate),
      overMeasured: Boolean(measurement.overMeasureReason),
      overMeasureReason: measurement.overMeasureReason,
      note: measurement.note,
      measuredBy: measurement.measuredBy,
      recordedAt: measurement.recordedAt,
      correctsMeasurementId: measurement.correctsMeasurementId,
      correctionReason: measurement.correctionReason,
      corrected,
      photos,
      review: measurement.review,
      permissions: {
        canApprove: canApprove && pending && !own && photos.length > 0,
        canReject: canApprove && pending && !own,
        canCorrect: canRecord && !corrected && current !== "superseded",
        canAddPhotos: canRecord && pending && photos.length < 6,
      },
    };
  }

  private measurement(projectId: string, measurementId: string) {
    this.require(projectId, MEASUREMENT_READ_PERMISSIONS);
    const found = this.state.measurements.find(
      (entry) => entry.id === measurementId && entry.projectId === projectId,
    );
    if (!found) this.fail(404, "measurement-not-found");
    return found;
  }

  // Measurements ------------------------------------------------------------------------------

  sheet(projectId: string, query: URLSearchParams): Reply {
    const held = this.require(projectId, MEASUREMENT_READ_PERMISSIONS);
    const ours = this.ours(projectId);
    const search = query.get("search")?.trim().toLowerCase();
    const bill = query.get("billLineageId");
    const approved = inForce(this.state, nairobiDate());
    const all = stated(this.state);
    const rows = (ours ? this.state.items : [])
      .filter(
        (item) =>
          (!search || `${item.ref} ${item.description}`.toLowerCase().includes(search)) &&
          (!bill || item.bill.lineageId === bill),
      )
      .map((item) => {
        const inForceRow = approved.get(item.lineageId)?.row;
        const latest = all
          .filter((entry) => entry.row.lineageId === item.lineageId)
          .sort((a, b) => b.row.recordedAt.localeCompare(a.row.recordedAt))[0];
        return {
          item: bqItem(this.state, item),
          kind: item.kind,
          basis: measurementBasis(item),
          quantity: item.quantity,
          rate: item.rate,
          amountMinor: item.amountMinor,
          approved: inForceRow
            ? {
                measurementId: inForceRow.id,
                measuredOn: inForceRow.measuredOn,
                quantityToDate: inForceRow.quantityToDate,
                valueMinor: measuredValueMinor(item, inForceRow.quantityToDate),
                percentComplete: measuredPercent(item, inForceRow.quantityToDate),
              }
            : null,
          latest: latest
            ? {
                measurementId: latest.row.id,
                state: latest.state,
                measuredOn: latest.row.measuredOn,
                quantityToDate: latest.row.quantityToDate,
              }
            : null,
          pendingCount: all.filter(
            (entry) => entry.row.lineageId === item.lineageId && entry.state === "pending",
          ).length,
        };
      });
    const measurable = this.state.items.filter((item) => measurementBasis(item) !== null);
    const measurableMinor = ours ? sum(measurable.map((item) => item.amountMinor)) : 0;
    const approvedValueMinor = ours
      ? sum(
          [...approved.values()].map(({ row }) =>
            measuredValueMinor(this.item(row.lineageId)!, row.quantityToDate),
          ),
        )
      : 0;
    return {
      body: {
        project: this.ref(projectId),
        bqVersion: ours ? { id: this.state.bqVersionId, versionNo: 1 } : null,
        bills: ours ? BILLS : [],
        items: rows,
        page: { nextCursor: null, hasMore: false },
        totals: {
          measurableMinor,
          approvedValueMinor,
          percentComplete: measurableMinor
            ? (Math.floor((approvedValueMinor * 1000) / measurableMinor) / 10).toFixed(1)
            : null,
          pendingCount: ours ? all.filter((entry) => entry.state === "pending").length : 0,
        },
        permissions: {
          canRecord: has(held, MEASUREMENT_RECORD_PERMISSIONS),
          canApprove: has(held, MEASUREMENT_APPROVE_PERMISSIONS),
        },
      },
      schema: measurementItemsResponseSchema,
    };
  }

  /** Records a measurement of a valuations-fixture item; null hands others to the stores mock. */
  record(projectId: string, body: unknown): Reply | null {
    const input = this.deps.parse(createMeasurementRequestSchema, body);
    const item = this.ours(projectId) ? this.item(input.bqItemLineageId) : null;
    if (!item) return null;
    const held = this.require(projectId, MEASUREMENT_READ_PERMISSIONS);
    if (!has(held, MEASUREMENT_RECORD_PERMISSIONS)) this.fail(403, "forbidden");
    this.writable(projectId);
    const key = this.deps.idempotencyKey;
    if (key) {
      const replay = this.state.replays.get(key);
      if (replay) {
        if (replay.digest !== sha(input)) this.fail(422, "idempotency-key-reused");
        const original = this.state.measurements.find(
          (entry) => entry.id === replay.measurementId,
        )!;
        return {
          status: 200,
          body: { measurement: this.wire(original), replayed: true },
          schema: measurementResponseSchema,
        };
      }
    }
    if (input.id && this.state.measurements.some((entry) => entry.id === input.id))
      this.fail(409, "measurement-id-conflict");
    const basis = measurementBasis(item);
    if (!basis) this.fail(422, "item-not-measurable");
    if (input.measuredOn > nairobiDate()) this.fail(422, "measurement-future");
    if (basis === "percent" && Number(input.quantityToDate) > 100)
      this.fail(422, "percent-over-100");
    const over = basis === "quantity" && Number(input.quantityToDate) > Number(item.quantity);
    if (over && !input.overMeasureReason) this.fail(422, "over-measure-reason-required");
    if (input.correctsMeasurementId) {
      const original = this.state.measurements.find(
        (entry) => entry.id === input.correctsMeasurementId,
      );
      if (!original) this.fail(404, "measurement-not-found");
      if (original.lineageId !== item.lineageId || original.measuredOn !== input.measuredOn)
        this.fail(422, "correction-date-mismatch");
    }
    for (const photoId of input.photoIds)
      if (!this.deps.photo(projectId, photoId)) this.fail(422, "photo-not-in-project");
    const measurement: MockMeasurement = {
      id: input.id ?? randomUUID(),
      projectId,
      lineageId: item.lineageId,
      measuredOn: input.measuredOn,
      quantityToDate: input.quantityToDate,
      note: input.note ?? null,
      overMeasureReason: over ? (input.overMeasureReason ?? null) : null,
      correctsMeasurementId: input.correctsMeasurementId,
      correctionReason: input.correctionReason ?? null,
      measuredBy: this.deps.actor,
      recordedAt: now(),
      photoIds: input.photoIds,
      review: null,
    };
    this.state.measurements.push(measurement);
    if (key) this.state.replays.set(key, { digest: sha(input), measurementId: measurement.id });
    return {
      status: 201,
      body: { measurement: this.wire(measurement), replayed: false },
      schema: measurementResponseSchema,
    };
  }

  detail(projectId: string, measurementId: string): Reply {
    const measurement = this.measurement(projectId, measurementId);
    return {
      body: {
        measurement: this.wire(measurement),
        project: this.ref(projectId),
        history: this.state.measurements
          .filter((entry) => entry.lineageId === measurement.lineageId)
          .sort(
            (a, b) =>
              b.measuredOn.localeCompare(a.measuredOn) || b.recordedAt.localeCompare(a.recordedAt),
          )
          .map((entry) => this.wire(entry)),
      },
      schema: measurementDetailResponseSchema,
    };
  }

  addPhotos(projectId: string, measurementId: string, body: unknown): Reply {
    const measurement = this.measurement(projectId, measurementId);
    if (!has(this.held(projectId), MEASUREMENT_RECORD_PERMISSIONS)) this.fail(403, "forbidden");
    const input = this.deps.parse(measurementPhotosRequestSchema, body);
    if (this.stateOf(measurement) !== "pending") this.fail(409, "measurement-not-pending");
    const ids = [...new Set([...measurement.photoIds, ...input.photoIds])];
    if (ids.length > 6) this.fail(422, "too-many-photos");
    for (const photoId of input.photoIds)
      if (!this.deps.photo(projectId, photoId)) this.fail(422, "photo-not-in-project");
    measurement.photoIds = ids;
    return {
      body: { measurement: this.wire(measurement), replayed: false },
      schema: measurementResponseSchema,
    };
  }

  decide(projectId: string, measurementId: string, decision: MeasurementDecision, body: unknown) {
    const measurement = this.measurement(projectId, measurementId);
    if (!has(this.held(projectId), MEASUREMENT_APPROVE_PERMISSIONS)) this.fail(403, "forbidden");
    const reason =
      decision === "rejected" ? this.deps.parse(rejectMeasurementRequestSchema, body).reason : null;
    if (this.stateOf(measurement) !== "pending") this.fail(409, "measurement-not-pending");
    if (measurement.measuredBy.id === this.deps.actor.id) this.fail(403, "maker-checker");
    if (decision === "approved" && measurement.photoIds.length === 0)
      this.fail(422, "measurement-evidence-required");
    measurement.review = { decision, reason, decidedBy: this.deps.actor, decidedAt: now() };
    return {
      body: { measurement: this.wire(measurement), replayed: false },
      schema: measurementResponseSchema,
    } satisfies Reply;
  }

  queue(): Reply {
    const entries = stated(this.state)
      .filter(
        (entry) =>
          entry.state === "pending" &&
          has(this.held(entry.row.projectId), MEASUREMENT_APPROVE_PERMISSIONS),
      )
      .map((entry) => ({
        project: this.ref(entry.row.projectId),
        measurement: this.wire(entry.row),
      }));
    return { body: { entries, truncated: false }, schema: approvalQueueResponseSchema };
  }

  // Valuations --------------------------------------------------------------------------------

  private abilities(projectId: string) {
    const held = this.held(projectId);
    return {
      read: has(held, VALUATION_READ_PERMISSIONS),
      prepare: has(held, VALUATION_PREPARE_PERMISSIONS),
      certify: has(held, VALUATION_CERTIFY_PERMISSIONS),
      settings: has(held, CONTRACT_SETTINGS_PERMISSIONS),
    };
  }

  private valuation(valuationId: string) {
    const found = this.state.valuations.find((entry) => entry.id === valuationId);
    if (!found || !this.abilities(found.projectId).read) this.fail(404, "not-found");
    return found;
  }

  private summary(valuation: MockValuation): ValuationSummary {
    const frozen = valuation.status === "draft" ? null : valuation.frozen;
    return {
      id: valuation.id,
      project: this.ref(valuation.projectId),
      number: valuation.number,
      certificateNumber: valuation.certificateNumber,
      kind: "interim",
      releaseStage: null,
      materialsFromStores: valuation.materialsFromStores,
      status: valuation.status,
      valuationDate: valuation.valuationDate,
      amountDueMinor: frozen?.figures.amountDueMinor ?? null,
      totalMinor: frozen?.figures.totalMinor ?? null,
      createdBy: valuation.createdBy,
      createdAt: valuation.createdAt,
      submittedAt: valuation.submittedAt,
      certifiedBy: valuation.certifiedBy,
      certifiedAt: valuation.certifiedAt,
      version: valuation.version,
    };
  }

  private detailOf(valuation: MockValuation): Reply {
    const preview = valuation.status === "draft";
    const computed =
      preview || !valuation.frozen ? compute(this.state, valuation) : valuation.frozen;
    const can = this.abilities(valuation.projectId);
    const contributor = valuation.contributors.includes(this.deps.actor.id);
    const status = valuation.status;
    const body: { valuation: ValuationDetail } = {
      valuation: {
        ...this.summary(valuation),
        notes: valuation.notes,
        materialsFromStores: valuation.materialsFromStores,
        returnReason: valuation.returnReason,
        cancelReason: valuation.cancelReason,
        cancelledBy: valuation.cancelledBy,
        cancelledAt: valuation.cancelledAt,
        submittedBy: valuation.submittedBy,
        bqVersion: { id: this.state.bqVersionId, versionNo: 1 },
        contractSum: contractSum(),
        terms: computed.terms,
        figures: computed.figures,
        preview,
        digest: status === "cancelled" ? null : computed.digest,
        revision: valuation.revision,
        lines: computed.lines,
        inputs: {
          materials: valuation.materials.map((input) => ({
            id: input.id,
            bqItem: bqItem(this.state, this.item(input.lineageId)!),
            description: input.description,
            unit: input.unit,
            quantity: input.quantity,
            amountMinor: input.amountMinor,
            reference: input.reference,
            createdBy: input.createdBy,
          })),
          adjustments: valuation.adjustments.map(
            ({ id, kind, description, amountMinor, createdBy }) => ({
              id,
              kind,
              description,
              amountMinor,
              createdBy,
            }),
          ),
        },
        warnings: computed.warnings,
        permissions: {
          canEdit: status === "draft" && can.prepare,
          canSubmit: status === "draft" && can.prepare,
          canCertify: status === "submitted" && can.certify && !contributor,
          canReturn: status === "submitted" && can.certify,
          canCancel: (status === "draft" || status === "submitted") && (can.prepare || can.certify),
        },
      },
    };
    return { body, schema: valuationResponseSchema };
  }

  private certifiedOf(projectId: string) {
    return this.state.valuations.filter(
      (entry) => entry.projectId === projectId && entry.status === "certified",
    );
  }

  overview(): Reply {
    const projects = this.deps.projects
      .filter(
        (project) =>
          has(this.held(project.id), MEASUREMENT_READ_PERMISSIONS) ||
          this.abilities(project.id).read,
      )
      .map((project) => {
        const read = this.abilities(project.id).read;
        const ours = this.ours(project.id);
        const certified = ours ? this.certifiedOf(project.id) : [];
        const latest = certified.at(-1);
        const open = ours
          ? this.state.valuations.find(
              (entry) => entry.status === "draft" || entry.status === "submitted",
            )
          : undefined;
        return {
          project: this.ref(project.id),
          canReadValuations: read,
          canMeasure: has(this.held(project.id), MEASUREMENT_RECORD_PERMISSIONS),
          canApprove: has(this.held(project.id), MEASUREMENT_APPROVE_PERMISSIONS),
          contractSum: read && ours ? contractSum() : null,
          certifiedMinor: read
            ? sum(certified.map((entry) => entry.frozen!.figures.amountDueMinor))
            : null,
          retentionHeldMinor: read ? (latest?.frozen?.figures.retentionHeldMinor ?? 0) : null,
          latestCertificate:
            read && latest
              ? {
                  id: latest.id,
                  certificateNumber: latest.certificateNumber!,
                  valuationDate: latest.valuationDate,
                  amountDueMinor: latest.frozen!.figures.amountDueMinor,
                }
              : null,
          openValuation:
            read && open ? { id: open.id, number: open.number, status: open.status } : null,
          pendingMeasurements: ours
            ? stated(this.state).filter((entry) => entry.state === "pending").length
            : 0,
        };
      });
    const approvalQueue = stated(this.state).filter(
      (entry) =>
        entry.state === "pending" &&
        entry.row.measuredBy.id !== this.deps.actor.id &&
        has(this.held(entry.row.projectId), MEASUREMENT_APPROVE_PERMISSIONS),
    ).length;
    return { body: { projects, approvalQueue }, schema: valuationsOverviewResponseSchema };
  }

  projectView(projectId: string): Reply {
    this.require(projectId, VALUATION_READ_PERMISSIONS);
    const ours = this.ours(projectId);
    const can = this.abilities(projectId);
    const certified = ours ? this.certifiedOf(projectId) : [];
    let held = 0;
    const ledger = certified.map((entry) => {
      const after = entry.frozen!.figures.retentionHeldMinor;
      const movementMinor = after - held;
      held = after;
      return {
        valuationId: entry.id,
        certificateNumber: entry.certificateNumber!,
        kind: "interim" as const,
        releaseStage: null,
        valuationDate: entry.valuationDate,
        certifiedAt: entry.certifiedAt!,
        heldMinor: after,
        movementMinor,
      };
    });
    const figures = certified.map((entry) => entry.frozen!.figures);
    return {
      body: {
        project: this.ref(projectId),
        contractSum: ours ? contractSum() : null,
        settings: this.state.settings,
        valuations: ours
          ? [...this.state.valuations].reverse().map((entry) => this.summary(entry))
          : [],
        retention: { heldMinor: held, releasedMinor: 0, stage: "none", ledger },
        certified: {
          count: certified.length,
          amountDueMinor: sum(figures.map((entry) => entry.amountDueMinor)),
          vatMinor: sum(figures.map((entry) => entry.vatMinor)),
          totalMinor: sum(figures.map((entry) => entry.totalMinor)),
          workDoneMinor: figures.at(-1)?.workDoneMinor ?? 0,
        },
        completions: { practical: null, final: null },
        permissions: {
          canCreate: can.prepare && ours,
          canRelease: { practical: false, final: false },
          canEditSettings: can.settings,
        },
      },
      schema: projectValuationsResponseSchema,
    };
  }

  create(projectId: string, body: unknown): Reply {
    this.require(projectId, VALUATION_READ_PERMISSIONS);
    if (!this.abilities(projectId).prepare) this.fail(403, "forbidden");
    this.writable(projectId);
    const input = this.deps.parse(createValuationRequestSchema, body);
    if (!this.ours(projectId)) this.fail(409, "bq-not-approved");
    if (input.kind === "retention_release") this.fail(409, "completion-not-certified");
    if (
      this.state.valuations.some(
        (entry) => entry.status === "draft" || entry.status === "submitted",
      )
    )
      this.fail(409, "valuation-open");
    const last = this.certifiedOf(projectId).at(-1);
    if (input.valuationDate > nairobiDate() || (last && input.valuationDate < last.valuationDate))
      this.fail(422, "valuation-date-invalid");
    this.state.counters.VAL += 1;
    const valuation: MockValuation = {
      id: randomUUID(),
      projectId,
      seq: this.state.counters.VAL,
      number: valuationCode("VAL", this.state.counters.VAL),
      certificateNumber: null,
      status: "draft",
      valuationDate: input.valuationDate,
      notes: input.notes ?? null,
      materialsFromStores: input.materialsFromStores ?? last?.materialsFromStores ?? false,
      returnReason: null,
      cancelReason: null,
      cancelledBy: null,
      cancelledAt: null,
      createdBy: this.deps.actor,
      createdAt: now(),
      submittedBy: null,
      submittedAt: null,
      certifiedBy: null,
      certifiedAt: null,
      version: 1,
      revision: 0,
      contributors: [this.deps.actor.id],
      materials: [],
      adjustments: [],
      frozen: null,
    };
    this.state.valuations.push(valuation);
    return { ...this.detailOf(valuation), status: 201 };
  }

  private draft(valuationId: string, version: number) {
    const valuation = this.valuation(valuationId);
    if (!this.abilities(valuation.projectId).prepare) this.fail(403, "forbidden");
    if (valuation.status !== "draft") this.fail(409, "invalid-transition");
    if (valuation.version !== version) this.fail(409, "version-conflict");
    valuation.version += 1;
    if (!valuation.contributors.includes(this.deps.actor.id))
      valuation.contributors.push(this.deps.actor.id);
    return valuation;
  }

  get(valuationId: string): Reply {
    return this.detailOf(this.valuation(valuationId));
  }

  update(valuationId: string, body: unknown): Reply {
    const input = this.deps.parse(updateValuationRequestSchema, body);
    const valuation = this.draft(valuationId, input.version);
    if (input.valuationDate !== undefined) {
      const last = this.certifiedOf(valuation.projectId).at(-1);
      if (input.valuationDate > nairobiDate() || (last && input.valuationDate < last.valuationDate))
        this.fail(422, "valuation-date-invalid");
      valuation.valuationDate = input.valuationDate;
    }
    if (input.notes !== undefined) valuation.notes = input.notes ?? null;
    if (input.materialsFromStores !== undefined)
      valuation.materialsFromStores = input.materialsFromStores;
    return this.detailOf(valuation);
  }

  addMaterial(valuationId: string, body: unknown): Reply {
    const input = this.deps.parse(addValuationMaterialRequestSchema, body);
    const valuation = this.valuation(valuationId);
    const item = this.item(input.bqItemLineageId);
    if (!item || !measurementBasis(item)) this.fail(422, "item-not-measurable");
    const done =
      compute(this.state, valuation).lines.items.find(
        (line) => line.bqItem.lineageId === item.lineageId,
      )?.toDateMinor ?? 0;
    const entered = sum(
      valuation.materials
        .filter((entry) => entry.lineageId === item.lineageId)
        .map((entry) => entry.amountMinor),
    );
    if (done + entered + input.amountMinor > item.amountMinor)
      this.fail(409, "materials-exceed-remaining");
    this.draft(valuationId, input.version);
    valuation.materials.push({
      id: randomUUID(),
      lineageId: item.lineageId,
      description: input.description,
      unit: input.unit ?? null,
      quantity: input.quantity,
      amountMinor: input.amountMinor,
      reference: input.reference ?? null,
      createdBy: this.deps.actor,
    });
    return this.detailOf(valuation);
  }

  addAdjustment(valuationId: string, body: unknown): Reply {
    const input = this.deps.parse(addValuationAdjustmentRequestSchema, body);
    const valuation = this.valuation(valuationId);
    const advances = sum(
      [...valuation.adjustments, input]
        .filter((entry) => entry.kind === "advance")
        .map((entry) => entry.amountMinor),
    );
    const recoveries = sum(
      [...valuation.adjustments, input]
        .filter((entry) => entry.kind === "advance_recovery")
        .map((entry) => -entry.amountMinor),
    );
    if (recoveries > advances) this.fail(409, "recovery-exceeds-advance");
    this.draft(valuationId, input.version);
    valuation.adjustments.push({
      id: randomUUID(),
      kind: input.kind,
      description: input.description,
      amountMinor: input.amountMinor,
      createdBy: this.deps.actor,
    });
    return this.detailOf(valuation);
  }

  remove(
    valuationId: string,
    kind: "materials" | "adjustments",
    lineId: string,
    query: URLSearchParams,
  ) {
    const version = Number(query.get("version"));
    if (!Number.isInteger(version) || version < 1) this.fail(400, "validation-error");
    const valuation = this.draft(valuationId, version);
    const list: { id: string }[] =
      kind === "materials" ? valuation.materials : valuation.adjustments;
    const index = list.findIndex((entry) => entry.id === lineId);
    if (index < 0) this.fail(404, "not-found");
    list.splice(index, 1);
    return this.detailOf(valuation);
  }

  submit(valuationId: string, body: unknown): Reply {
    const input = this.deps.parse(valuationVersionRequestSchema, body);
    const valuation = this.draft(valuationId, input.version);
    valuation.frozen = compute(this.state, valuation);
    valuation.status = "submitted";
    valuation.submittedBy = this.deps.actor;
    valuation.submittedAt = now();
    valuation.revision += 1;
    valuation.returnReason = null;
    return this.detailOf(valuation);
  }

  certify(valuationId: string, body: unknown): Reply {
    const input = this.deps.parse(certifyValuationRequestSchema, body);
    const valuation = this.valuation(valuationId);
    if (!this.abilities(valuation.projectId).certify) this.fail(403, "forbidden");
    if (valuation.status !== "submitted") this.fail(409, "invalid-transition");
    if (valuation.version !== input.version) this.fail(409, "version-conflict");
    if (valuation.contributors.includes(this.deps.actor.id)) this.fail(403, "maker-checker");
    this.deps.requireStepUp();
    const current = compute(this.state, valuation);
    if (input.digest !== valuation.frozen?.digest || current.digest !== valuation.frozen.digest)
      this.fail(409, "valuation-stale");
    this.state.counters.IPC += 1;
    Object.assign(valuation, {
      status: "certified",
      certificateNumber: valuationCode("IPC", this.state.counters.IPC),
      certifiedBy: this.deps.actor,
      certifiedAt: now(),
      version: valuation.version + 1,
    });
    return this.detailOf(valuation);
  }

  decideValuation(valuationId: string, action: "return" | "cancel", body: unknown): Reply {
    const input = this.deps.parse(valuationReasonRequestSchema, body);
    const valuation = this.valuation(valuationId);
    const can = this.abilities(valuation.projectId);
    if (action === "return" ? !can.certify : !(can.prepare || can.certify))
      this.fail(403, "forbidden");
    const allowed = action === "return" ? ["submitted"] : ["draft", "submitted"];
    if (!allowed.includes(valuation.status)) this.fail(409, "invalid-transition");
    if (valuation.version !== input.version) this.fail(409, "version-conflict");
    valuation.version += 1;
    if (action === "return") {
      valuation.status = "draft";
      valuation.returnReason = input.reason;
      valuation.frozen = null;
    } else {
      valuation.status = "cancelled";
      valuation.cancelReason = input.reason;
      valuation.cancelledBy = this.deps.actor;
      valuation.cancelledAt = now();
    }
    return this.detailOf(valuation);
  }

  updateSettings(projectId: string, body: unknown): Reply {
    this.require(projectId, VALUATION_READ_PERMISSIONS);
    if (!this.abilities(projectId).settings) this.fail(403, "forbidden");
    const input = this.deps.parse(updateContractSettingsRequestSchema, body);
    if (input.version !== this.state.settings.version) this.fail(409, "version-conflict");
    this.state.settings = {
      retentionPercent: input.retentionPercent,
      retentionCapPercent: input.retentionCapPercent,
      vatPercent: input.vatPercent,
      materialsPercent: input.materialsPercent,
      practicalReleasePercent: input.practicalReleasePercent,
      version: input.version + 1,
      updatedAt: now(),
      updatedBy: this.deps.actor,
    };
    return {
      body: { project: this.ref(projectId), settings: this.state.settings },
      schema: contractSettingsResponseSchema,
    };
  }

  // Earned value ------------------------------------------------------------------------------

  private ev(asOf: string) {
    return sum(
      [...inForce(this.state, asOf).values()].map(({ row }) =>
        measuredValueMinor(this.item(row.lineageId)!, row.quantityToDate),
      ),
    );
  }

  earnedValue(projectId: string): Reply {
    this.require(projectId, EARNED_VALUE_READ_PERMISSIONS);
    const ours = this.ours(projectId);
    const today = nairobiDate();
    const measurable = ours
      ? this.state.items.filter((item) => measurementBasis(item) !== null)
      : [];
    const bac = sum(measurable.map((item) => item.amountMinor));
    const { start, finish } = this.state.baseline;
    const span = Date.parse(finish) - Date.parse(start);
    // Linear plan over the baseline span (the API weights by linked activities' working days).
    const pv = (date: string) =>
      date <= start
        ? 0
        : date >= finish
          ? bac
          : Math.round((bac * (Date.parse(date) - Date.parse(start))) / span);
    const evAt = (date: string) => (ours ? this.ev(date) : 0);
    const acAt = (date: string) =>
      ours
        ? sum(this.state.costs.filter((cost) => cost.date <= date).map((cost) => cost.valueMinor))
        : 0;
    const figures = earnedValueFigures({
      bacMinor: bac,
      pvMinor: ours ? pv(today) : null,
      evMinor: evAt(today),
      acMinor: acAt(today),
    });
    const curve = ours
      ? sCurve({ weekEnds: weekEnds(start, finish, 260), dataDate: today, pv, ev: evAt, ac: acAt })
      : [];
    const certified = ours ? this.certifiedOf(projectId) : [];
    return {
      body: {
        project: this.ref(projectId),
        dataDate: today,
        bqVersion: ours ? { id: this.state.bqVersionId, versionNo: 1 } : null,
        baseline: ours
          ? {
              id: this.state.baseline.id,
              baselineNo: 1,
              name: "Contract programme (synthetic)",
              startDate: start,
              finishDate: finish,
            }
          : null,
        figures,
        curve,
        curveTruncated: false,
        values: {
          physicalPercent: ours ? "38.0" : null,
          earnedMinor: figures.evMinor,
          certifiedWorkMinor: certified.at(-1)?.frozen?.figures.workDoneMinor ?? null,
          certifiedNetMinor: sum(certified.map((entry) => entry.frozen!.figures.amountDueMinor)),
          invoicedMinor: null,
          receivedMinor: ours ? 30_000_000 : null,
        },
        notes: {
          stockOnHandMinor: ours ? 3_000_000 : 0,
          itemsLinkedToBaseline: 0,
          itemsSpreadOverBaseline: measurable.length,
        },
      },
      schema: earnedValueResponseSchema,
    };
  }

  costToComplete(projectId: string, query: URLSearchParams): Reply {
    this.require(projectId, EARNED_VALUE_READ_PERMISSIONS);
    const ours = this.ours(projectId);
    const today = nairobiDate();
    const approved = inForce(this.state, today);
    const row = (items: MockItem[]): CostToCompleteRow => {
      const contractMinor = sum(items.map((item) => item.amountMinor));
      const evMinor = sum(
        items.map((item) => {
          const entry = approved.get(item.lineageId)?.row;
          return entry ? measuredValueMinor(item, entry.quantityToDate) : 0;
        }),
      );
      const budgets = items.map((item) => this.state.budget.byItem.get(item.lineageId));
      const budgetMinor = budgets.every((value) => value === undefined)
        ? null
        : sum(budgets.map((value) => value ?? 0));
      const actualMinor = sum(
        this.state.costs
          .filter((cost) => items.some((item) => item.lineageId === cost.lineageId))
          .map((cost) => cost.valueMinor),
      );
      return {
        contractMinor,
        evMinor,
        budgetMinor,
        actualMinor,
        ...costToComplete({ contractMinor, evMinor, budgetMinor, actualMinor }),
      };
    };
    const measured = ours ? this.state.items.filter((item) => measurementBasis(item) !== null) : [];
    const billId = query.get("billLineageId");
    const bill = BILLS.find((entry) => entry.lineageId === billId) ?? null;
    return {
      body: {
        project: this.ref(projectId),
        bqVersion: ours ? { id: this.state.bqVersionId, versionNo: 1 } : null,
        budget: ours
          ? {
              id: this.state.budget.id,
              versionNo: this.state.budget.versionNo,
              name: this.state.budget.name,
            }
          : null,
        totals: row(measured),
        bills: ours
          ? BILLS.map((entry) => ({
              bill: entry,
              ...row(measured.filter((item) => item.bill.lineageId === entry.lineageId)),
            })).filter((entry) => entry.contractMinor > 0)
          : [],
        bill: ours ? bill : null,
        items:
          ours && bill
            ? measured
                .filter((item) => item.bill.lineageId === bill.lineageId)
                .map((item) => {
                  const entry = approved.get(item.lineageId)?.row;
                  return {
                    item: bqItem(this.state, item),
                    percentComplete: entry ? measuredPercent(item, entry.quantityToDate) : null,
                    ...row([item]),
                  };
                })
            : [],
        page: null,
        notOnBqItems: {
          actualMinor: ours
            ? sum(
                this.state.costs
                  .filter((cost) => cost.lineageId === null)
                  .map((cost) => cost.valueMinor),
              )
            : 0,
          budgetMinor: null,
        },
      },
      schema: costToCompleteResponseSchema,
    };
  }
}

/** PDF/Excel bytes of a certificate the caller may read; null when not found or hidden. */
export function valuationExport(
  deps: Pick<ValuationsDeps, "projectPermissions">,
  state: ValuationsState,
  valuationId: string,
  format: string,
) {
  const valuation = state.valuations.find((entry) => entry.id === valuationId);
  if (!valuation || !has(deps.projectPermissions(valuation.projectId), VALUATION_READ_PERMISSIONS))
    return null;
  return format === "pdf"
    ? {
        contentType: "application/pdf",
        content: Buffer.from(`%PDF-1.4\n% ${valuation.number} (mock)\n`),
      }
    : {
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        content: Buffer.from(`PK mock ${valuation.number}`),
      };
}

export function handleValuations(
  deps: ValuationsDeps,
  state: ValuationsState,
  method: string,
  path: string,
  query: URLSearchParams,
  body: unknown,
): Reply | null {
  const valuations = new Valuations(deps, state);
  if (path === "/valuations" && method === "GET") return valuations.overview();
  if (path === "/measurements/pending" && method === "GET") return valuations.queue();
  const measurement =
    /^\/projects\/([^/]+)\/measurements(?:\/(items|[0-9a-f-]{36})(?:\/(photos|approve|reject))?)?$/.exec(
      path,
    );
  if (measurement) {
    const [, projectId, target, action] = measurement;
    if (!target) return method === "POST" ? valuations.record(projectId!, body) : null;
    if (target === "items") return method === "GET" ? valuations.sheet(projectId!, query) : null;
    if (!state.measurements.some((entry) => entry.id === target)) return null;
    if (!action && method === "GET") return valuations.detail(projectId!, target);
    if (action === "photos" && method === "POST")
      return valuations.addPhotos(projectId!, target, body);
    if (action === "approve" && method === "POST")
      return valuations.decide(projectId!, target, "approved", body);
    if (action === "reject" && method === "POST")
      return valuations.decide(projectId!, target, "rejected", body);
    return null;
  }
  const project =
    /^\/projects\/([^/]+)\/(valuations|contract-settings|earned-value|cost-to-complete)$/.exec(
      path,
    );
  if (project) {
    const [, projectId, area] = project;
    if (area === "valuations")
      return method === "GET"
        ? valuations.projectView(projectId!)
        : method === "POST"
          ? valuations.create(projectId!, body)
          : null;
    if (area === "contract-settings" && method === "PUT")
      return valuations.updateSettings(projectId!, body);
    if (area === "earned-value" && method === "GET") return valuations.earnedValue(projectId!);
    if (area === "cost-to-complete" && method === "GET")
      return valuations.costToComplete(projectId!, query);
    return null;
  }
  const valuation =
    /^\/valuations\/([0-9a-f-]{36})(?:\/(materials|adjustments)(?:\/([0-9a-f-]{36}))?|\/(submit|certify|return|cancel))?$/.exec(
      path,
    );
  if (!valuation) return null;
  const [, valuationId, inputs, lineId, action] = valuation;
  if (inputs && lineId && method === "DELETE")
    return valuations.remove(valuationId!, inputs as "materials" | "adjustments", lineId, query);
  if (inputs === "materials" && method === "POST")
    return valuations.addMaterial(valuationId!, body);
  if (inputs === "adjustments" && method === "POST")
    return valuations.addAdjustment(valuationId!, body);
  if (action === "submit" && method === "POST") return valuations.submit(valuationId!, body);
  if (action === "certify" && method === "POST") return valuations.certify(valuationId!, body);
  if ((action === "return" || action === "cancel") && method === "POST")
    return valuations.decideValuation(valuationId!, action, body);
  if (!inputs && !action) {
    if (method === "GET") return valuations.get(valuationId!);
    if (method === "PATCH") return valuations.update(valuationId!, body);
  }
  return null;
}
