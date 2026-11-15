/**
 * D5.3 stores in the Playwright mock API: stores per site, the append-only stock ledger with
 * weighted-average values, issues to a BQ item or gang, returns, wastage, reversals, inter-site
 * transfers (in transit, received, disputed, resolved), stock takes with independent approval,
 * reorder levels, the consumption-variance report, minimal progress measurements and build-up
 * line → material mappings. Quantities, values, conversions and the variance use the real
 * packages/domain functions; requests and responses go through the shared schemas. Permissions
 * follow the API (StoresAccess): viewing needs stores.manage, procurement.requisition,
 * procurement.approve, finance.view or finance.manage on the project; recording needs
 * stores.manage; approving a stock take or resolving a disputed transfer needs
 * procurement.approve and someone who did not take part. In this fixture the owner keeps the
 * stores and the project manager (procurement.approve on Ruiru Heights) is the independent
 * approver. The approved BQ items below are a stores-local fixture (the BQ mock's baseline is
 * still a draft); the rate build-up is the shared CONC-C25-SYN example. GRNs recorded in the
 * procure-to-pay mock do not post here; the store starts with a seeded receipt instead.
 * Synthetic data only.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  applyEntry,
  averageUnitCost,
  checkProcurementTransition,
  compareDecimals,
  consumptionVariance,
  convertQuantity,
  countVariance,
  EMPTY_POSITION,
  fromMicro,
  isLowStock,
  microTimes,
  microToMinor,
  nairobiDate,
  negateDecimal,
  Ratio,
  receiveIntoStock,
  returnableQuantity,
  STOCK_TAKE_TRANSITIONS,
  sumDecimals,
  takeFromStock,
  theoreticalConsumption,
  toMicro,
  TRANSFER_TRANSITIONS,
  type StockPosition,
} from "@pm-buddy/domain";
import {
  DEFAULT_CONSUMPTION_VARIANCE_PERCENT,
  STORES_LIMITS,
  type Permission,
  type StockEntryKind,
  type StockMovementKind,
  type StockTakeAction,
  type StockTakeStatus,
  type TransferAction,
  type TransferStatus,
  type VarianceState,
  type WastageReason,
} from "@pm-buddy/types";
import {
  buildupMaterialMappingRequestSchema,
  buildupMaterialsResponseSchema,
  createIssueRequestSchema,
  createMeasurementRequestSchema,
  createReturnRequestSchema,
  createStockTakeRequestSchema,
  createStoreRequestSchema,
  createWastageRequestSchema,
  dispatchTransferRequestSchema,
  idempotencyKeySchema,
  issueOptionsResponseSchema,
  ledgerResponseSchema,
  measurementResponseSchema,
  measurementsResponseSchema,
  movementResponseSchema,
  movementsResponseSchema,
  receiveTransferRequestSchema,
  recordCountsRequestSchema,
  reorderLevelsRequestSchema,
  reverseRequestSchema,
  stockTakeReasonRequestSchema,
  stockTakeResponseSchema,
  stockTakesResponseSchema,
  stockTakeVersionRequestSchema,
  storeDetailResponseSchema,
  storesResponseSchema,
  storesSettingsResponseSchema,
  transferDecisionRequestSchema,
  transferResponseSchema,
  transfersResponseSchema,
  transferTargetsResponseSchema,
  updateStoresSettingsRequestSchema,
  varianceResponseSchema,
  type LedgerEntry,
  type Movement,
  type StockTake,
  type StoreRef,
  type StoresBqItem,
  type Transfer,
  type VarianceRow,
} from "@pm-buddy/validation";
import type { MockBuildup, Person, Reply } from "./mock-bq-model.mts";
import { context as conversionContext, type ProcurementState } from "./mock-procurement.mts";

const NOW = "2026-11-10T07:45:00.000Z";
const RUIRU_ID = "30000000-0000-4000-8000-000000000001";
const MAIN_PLOT_ID = "31000000-0000-4000-8000-000000000001";
const OWNER: Person = { id: "21000000-0000-4000-8000-000000000001", displayName: "Wanjiru Kamau" };
const PM: Person = { id: "21000000-0000-4000-8000-000000000002", displayName: "Brian Otieno" };
export const MAIN_STORE_ID = "73000000-0000-4000-8000-000000000001";
const STORES_BQ_VERSION_ID = "71000000-0000-4000-8000-000000000001";
export const SLAB_LINEAGE_ID = "72000000-0000-4000-8000-000000000001";
const COLUMNS_LINEAGE_ID = "72000000-0000-4000-8000-000000000002";
const HARDCORE_LINEAGE_ID = "72000000-0000-4000-8000-000000000003";
const CONCRETE_BUILDUP_ID = "50000000-0000-4000-8000-000000000001";

const VIEW: readonly Permission[] = [
  "stores.manage",
  "procurement.requisition",
  "procurement.approve",
  "finance.view",
  "finance.manage",
];
const MANAGE: Permission = "stores.manage";
const APPROVE: Permission = "procurement.approve";
const UNAVAILABLE: readonly VarianceState[] = [
  "no_measurement",
  "no_buildup",
  "not_mapped",
  "not_in_buildup",
  "no_progress",
];

type ProjectInfo = {
  id: string;
  code: string;
  name: string;
  status: string;
  sites: { id: string; name: string }[];
};

export type StoresDeps = {
  fail: (status: number, code: string) => Error;
  parse<T>(schema: import("zod").ZodType<T>, body: unknown): T;
  actor: Person;
  projects: ProjectInfo[];
  /** The persona's project permissions (role ∩ assignment, as the API computes them). */
  projectPermissions(projectId: string): readonly Permission[];
  /** Company-level role permissions (config.manage for the settings). */
  companyPermissions: readonly Permission[];
  /** Permissions held company-wide or on at least one assigned project (the build-up library). */
  somewhere(): readonly Permission[];
  catalogue: ProcurementState;
  buildups: MockBuildup[];
  gangs: { id: string; projectId: string; name: string; status: string }[];
  idempotencyKey: string | undefined;
};

type MockStore = {
  id: string;
  name: string;
  projectId: string;
  siteId: string;
  storekeeper: Person | null;
  version: number;
};
type SourceType = LedgerEntry["source"]["type"];
type MockEntry = {
  id: string;
  seq: number;
  storeId: string;
  materialId: string;
  kind: StockEntryKind;
  quantity: string;
  unitCostMinor: string;
  valueMinor: string;
  balanceQuantity: string;
  balanceValueMinor: string;
  businessDate: string;
  recordedAt: string;
  recordedBy: Person;
  source: { type: SourceType; id: string; number: string };
  sourceLineId: string;
  bqItemLineageId: string | null;
  gangId: string | null;
  reversesEntryId: string | null;
};
type MockMovementLine = {
  id: string;
  lineNo: number;
  materialId: string;
  quantity: string;
  unit: string;
  baseQuantity: string;
  valueMinor: string;
  unitCostMinor: string;
  returnOfLineId: string | null;
};
type MockMovement = {
  id: string;
  number: string;
  kind: StockMovementKind;
  status: "posted" | "reversed";
  storeId: string;
  bqItemLineageId: string | null;
  gangId: string | null;
  issuedToName: string | null;
  returnOfId: string | null;
  wastageReason: WastageReason | null;
  notes: string | null;
  capturedAt: string;
  recordedAt: string;
  businessDate: string;
  recordedBy: Person;
  source: "web" | "site_app";
  reversedAt: string | null;
  reversedBy: Person | null;
  reversalReason: string | null;
  lines: MockMovementLine[];
  key: string;
  digest: string;
};
type MockTransferLine = {
  id: string;
  lineNo: number;
  materialId: string;
  quantity: string;
  unit: string;
  baseQuantity: string;
  unitCostMinor: string;
  dispatchedValueMinor: string;
  receivedBaseQuantity: string | null;
  differenceReason: string | null;
};
type MockTransfer = {
  id: string;
  number: string;
  status: TransferStatus;
  fromStoreId: string;
  toStoreId: string;
  capturedAt: string;
  dispatchedAt: string;
  dispatchedBy: Person;
  dispatchNotes: string | null;
  receivedAt: string | null;
  receivedBy: Person | null;
  receiveNotes: string | null;
  resolvedAt: string | null;
  resolvedBy: Person | null;
  resolutionNote: string | null;
  cancelledAt: string | null;
  cancelledBy: Person | null;
  cancelReason: string | null;
  source: "web" | "site_app";
  version: number;
  lines: MockTransferLine[];
  key: string;
  digest: string;
  receipt: { key: string; digest: string } | null;
};
type MockTakeLine = {
  id: string;
  lineNo: number;
  materialId: string;
  snapshotQuantity: string;
  countedQuantity: string | null;
  expectedQuantity: string | null;
  countedBy: Person | null;
  countedAt: string | null;
  adjustmentEntryId: string | null;
};
type MockTake = {
  id: string;
  number: string;
  status: StockTakeStatus;
  storeId: string;
  notes: string | null;
  createdAt: string;
  createdBy: Person;
  submittedAt: string | null;
  submittedBy: Person | null;
  approvedAt: string | null;
  approvedBy: Person | null;
  returnReason: string | null;
  cancelledAt: string | null;
  cancelledBy: Person | null;
  cancelReason: string | null;
  contributors: Person[];
  version: number;
  lines: MockTakeLine[];
  batches: Map<string, string>;
};
type MockItem = StoresBqItem & {
  projectId: string;
  buildup: { id: string; versionNo: number } | null;
};
type MockMeasurement = {
  id: string;
  projectId: string;
  lineageId: string;
  measuredOn: string;
  quantityToDate: string;
  note: string | null;
  measuredBy: Person;
  recordedAt: string;
  correctsMeasurementId: string | null;
  correctionReason: string | null;
};
type MockMapping = {
  id: string;
  lineId: string;
  materialId: string;
  unit: string;
  basePerUnit: string;
  mappedAt: string;
  mappedBy: Person;
};

export type StoresState = {
  stores: MockStore[];
  entries: MockEntry[];
  positions: Map<string, StockPosition>;
  movements: MockMovement[];
  transfers: MockTransfer[];
  takes: MockTake[];
  reorderLevels: Map<string, string>;
  items: MockItem[];
  measurements: MockMeasurement[];
  mappings: MockMapping[];
  settings: { threshold: string; version: number | null; updatedAt: string | null };
  counters: Record<"ISS" | "RTN" | "WST" | "TRF" | "STK", number>;
};

const id = () => randomUUID();
const now = () => new Date().toISOString();
const positionKey = (storeId: string, materialId: string) => `${storeId}:${materialId}`;
const nonZero = (value: string) => /[1-9]/.test(value);
const digestOf = (operation: string, body: unknown) =>
  createHash("sha256").update(JSON.stringify({ operation, body })).digest("hex");
/** A stable UUID for a build-up line (the mock's build-up lines carry no IDs of their own). */
export function buildupLineId(versionId: string, lineNo: number): string {
  const hex = createHash("sha256").update(`${versionId}:${lineNo}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const toMinor = (value: string) => microToMinor(toMicro(value));
/** quantity × unit cost, rounded once to six places (as the ledger values a movement). */
const microTimesDecimal = (quantity: string, unitCost: string) =>
  fromMicro(microTimes(toMicro(quantity), toMicro(unitCost)));
/** A copy without the given keys (list rows omit their lines; schemas are strict). */
function without<T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.includes(key as K)),
  ) as Omit<T, K>;
}

/** The fixture: one store on Ruiru Heights' main plot with a received delivery and one issue. */
export function initialStores(catalogue: ProcurementState, buildups: MockBuildup[]): StoresState {
  const cement = catalogue.materials.find((material) => material.code === "MAT-0001")!;
  const sand = catalogue.materials.find((material) => material.code === "MAT-0002")!;
  const state: StoresState = {
    stores: [
      {
        id: MAIN_STORE_ID,
        name: "Main plot store",
        projectId: RUIRU_ID,
        siteId: MAIN_PLOT_ID,
        storekeeper: OWNER,
        version: 1,
      },
    ],
    entries: [],
    positions: new Map(),
    movements: [],
    transfers: [],
    takes: [],
    reorderLevels: new Map([[positionKey(MAIN_STORE_ID, cement.id), "50"]]),
    items: [
      {
        projectId: RUIRU_ID,
        versionId: STORES_BQ_VERSION_ID,
        lineageId: SLAB_LINEAGE_ID,
        ref: "B2/1",
        description: "Concrete class 25 (1:2:4) in ground floor slab, 150 mm thick",
        unit: "m3",
        buildup: { id: CONCRETE_BUILDUP_ID, versionNo: 1 },
      },
      {
        projectId: RUIRU_ID,
        versionId: STORES_BQ_VERSION_ID,
        lineageId: COLUMNS_LINEAGE_ID,
        ref: "B2/4",
        description: "Concrete class 25 (1:2:4) in columns",
        unit: "m3",
        buildup: { id: CONCRETE_BUILDUP_ID, versionNo: 1 },
      },
      {
        projectId: RUIRU_ID,
        versionId: STORES_BQ_VERSION_ID,
        lineageId: HARDCORE_LINEAGE_ID,
        ref: "B1/3",
        description: "Hardcore filling, 200 mm, compacted in layers",
        unit: "m3",
        buildup: null,
      },
    ],
    measurements: [
      {
        id: id(),
        projectId: RUIRU_ID,
        lineageId: SLAB_LINEAGE_ID,
        measuredOn: "2026-11-09",
        quantityToDate: "10",
        note: "Ground floor slab bays 1–4 (synthetic).",
        measuredBy: PM,
        recordedAt: NOW,
        correctsMeasurementId: null,
        correctionReason: null,
      },
    ],
    mappings: [],
    settings: { threshold: DEFAULT_CONSUMPTION_VARIANCE_PERCENT, version: null, updatedAt: null },
    counters: { ISS: 0, RTN: 0, WST: 0, TRF: 0, STK: 0 },
  };
  const version = buildups.find((entry) => entry.id === CONCRETE_BUILDUP_ID)?.versions[0];
  if (version) {
    state.mappings.push(
      {
        id: id(),
        lineId: buildupLineId(version.id, 1),
        materialId: cement.id,
        unit: "bag_50kg",
        basePerUnit: "1/1",
        mappedAt: NOW,
        mappedBy: OWNER,
      },
      {
        id: id(),
        lineId: buildupLineId(version.id, 2),
        materialId: sand.id,
        unit: "t",
        basePerUnit: "1/1",
        mappedAt: NOW,
        mappedBy: OWNER,
      },
    );
  }
  // A delivery received into the main plot store (GRN-0001 in the demo seed).
  const grn = { type: "grn" as const, id: id(), number: "GRN-0001" };
  const recordedAt = "2026-11-09T06:30:00.000Z";
  for (const [material, quantity, cost] of [
    [cement, "120", "80000"],
    [sand, "20", "400000"],
  ] as const) {
    const before = EMPTY_POSITION;
    const inflow = receiveIntoStock(before, quantity, cost);
    post(state, {
      storeId: MAIN_STORE_ID,
      materialId: material.id,
      kind: "receipt",
      quantity,
      valueMinor: inflow.valueMinor,
      unitCostMinor: cost,
      source: grn,
      sourceLineId: id(),
      recordedAt,
      recordedBy: OWNER,
      bqItemLineageId: null,
      gangId: null,
      reversesEntryId: null,
    });
  }
  return state;
}

type PostInput = Omit<
  MockEntry,
  "id" | "seq" | "balanceQuantity" | "balanceValueMinor" | "businessDate"
>;

/** Appends a ledger entry and moves the running balance (the DB trigger's job in the API). */
function post(state: StoresState, input: PostInput): MockEntry {
  const key = positionKey(input.storeId, input.materialId);
  const after = applyEntry(state.positions.get(key) ?? EMPTY_POSITION, input);
  state.positions.set(key, after);
  const entry: MockEntry = {
    ...input,
    id: id(),
    seq:
      state.entries.filter(
        (candidate) =>
          candidate.storeId === input.storeId && candidate.materialId === input.materialId,
      ).length + 1,
    balanceQuantity: after.quantity,
    balanceValueMinor: after.valueMinor,
    businessDate: nairobiDate(new Date(input.recordedAt)),
  };
  state.entries.push(entry);
  return entry;
}

class Stores {
  private readonly deps: StoresDeps;
  private readonly state: StoresState;
  constructor(deps: StoresDeps, state: StoresState) {
    this.deps = deps;
    this.state = state;
  }

  fail(status: number, code: string): never {
    throw this.deps.fail(status, code);
  }

  // Access ----------------------------------------------------------------------------------

  private held(projectId: string) {
    return new Set(this.deps.projectPermissions(projectId));
  }
  can(projectId: string, permission: Permission) {
    return this.held(projectId).has(permission) && this.writable(projectId);
  }
  private writable(projectId: string) {
    const project = this.project(projectId);
    return project.status !== "closed" && project.status !== "cancelled";
  }
  visibleProjects(filter?: string | null) {
    return this.deps.projects
      .filter((project) => VIEW.some((key) => this.held(project.id).has(key)))
      .filter((project) => !filter || project.id === filter)
      .map((project) => project.id);
  }
  private project(projectId: string) {
    const project = this.deps.projects.find((entry) => entry.id === projectId);
    if (!project) this.fail(404, "not-found");
    return project;
  }
  private require(projectId: string, permission: Permission) {
    const held = this.held(projectId);
    if (!VIEW.some((key) => held.has(key))) this.fail(404, "not-found");
    if (!held.has(permission)) this.fail(403, "forbidden");
    if (!this.writable(projectId)) this.fail(409, "project-read-only");
  }
  store(storeId: string): MockStore {
    const store = this.state.stores.find((entry) => entry.id === storeId);
    if (!store || !this.visibleProjects().includes(store.projectId)) this.fail(404, "not-found");
    return store;
  }

  // Wire helpers ----------------------------------------------------------------------------

  private material(materialId: string) {
    const material = this.deps.catalogue.materials.find((entry) => entry.id === materialId);
    if (!material) this.fail(404, "not-found");
    return material;
  }
  private materialRef(materialId: string) {
    const material = this.material(materialId);
    return {
      id: material.id,
      code: material.code,
      name: material.name,
      baseUnit: material.baseUnit,
    };
  }
  storeRef(store: MockStore): StoreRef {
    const project = this.project(store.projectId);
    const site = project.sites.find((entry) => entry.id === store.siteId)!;
    return {
      id: store.id,
      name: store.name,
      project: { id: project.id, code: project.code, name: project.name },
      site: { id: site.id, name: site.name },
    };
  }
  private item(lineageId: string | null): StoresBqItem | null {
    const item = this.state.items.find((entry) => entry.lineageId === lineageId);
    if (!item) return null;
    return {
      versionId: item.versionId,
      lineageId: item.lineageId,
      ref: item.ref,
      description: item.description,
      unit: item.unit,
    };
  }
  private gang(gangId: string | null) {
    const gang = this.deps.gangs.find((entry) => entry.id === gangId);
    return gang ? { id: gang.id, name: gang.name } : null;
  }
  private position(storeId: string, materialId: string) {
    return this.state.positions.get(positionKey(storeId, materialId)) ?? EMPTY_POSITION;
  }
  private number(prefix: keyof StoresState["counters"]) {
    this.state.counters[prefix] += 1;
    return `${prefix}-${String(this.state.counters[prefix]).padStart(4, "0")}`;
  }
  private toBase(materialId: string, quantity: string, unit: string) {
    const material = this.material(materialId);
    if (unit === material.baseUnit) return quantity;
    const converted = convertQuantity(
      quantity,
      unit,
      material.baseUnit,
      conversionContext(this.deps.catalogue, material, null, nairobiDate()),
    );
    if (!converted.ok) this.fail(422, "no-conversion");
    return converted.quantity;
  }
  private key() {
    const key = idempotencyKeySchema.safeParse(this.deps.idempotencyKey);
    if (!key.success) this.fail(400, "idempotency-key-required");
    return key.data;
  }

  // Stores ----------------------------------------------------------------------------------

  private summary(store: MockStore) {
    const positions = [...this.state.positions.entries()].filter(([key]) =>
      key.startsWith(`${store.id}:`),
    );
    const held = positions.filter(([, position]) => nonZero(position.quantity));
    const low = positions.filter(([key, position]) =>
      isLowStock(position.quantity, this.state.reorderLevels.get(key) ?? null),
    );
    const levelsOnly = [...this.state.reorderLevels.entries()].filter(
      ([key, level]) =>
        key.startsWith(`${store.id}:`) && !this.state.positions.has(key) && isLowStock("0", level),
    );
    const last = this.state.entries
      .filter((entry) => entry.storeId === store.id)
      .map((entry) => entry.recordedAt)
      .sort()
      .at(-1);
    return {
      id: store.id,
      name: store.name,
      project: this.storeRef(store).project,
      site: this.storeRef(store).site,
      storekeeper: store.storekeeper,
      valueMinor: toMinor(sumDecimals(positions.map(([, position]) => position.valueMinor))),
      materialCount: held.length,
      lowStockCount: low.length + levelsOnly.length,
      inTransitIn: this.state.transfers.filter(
        (transfer) => transfer.toStoreId === store.id && transfer.status === "dispatched",
      ).length,
      inTransitOut: this.state.transfers.filter(
        (transfer) => transfer.fromStoreId === store.id && transfer.status === "dispatched",
      ).length,
      lastMovementAt: last ?? null,
      version: store.version,
    };
  }

  private lowStock(stores: MockStore[]) {
    return stores.flatMap((store) =>
      [...this.state.reorderLevels.entries()]
        .filter(([key]) => key.startsWith(`${store.id}:`))
        .map(([key, level]) => ({ materialId: key.split(":")[1]!, level, key }))
        .filter((entry) =>
          isLowStock(this.state.positions.get(entry.key)?.quantity ?? "0", entry.level),
        )
        .map((entry) => ({
          store: { id: store.id, name: store.name },
          material: this.materialRef(entry.materialId),
          quantity: this.state.positions.get(entry.key)?.quantity ?? "0",
          reorderLevel: entry.level,
        })),
    );
  }

  list(): Reply {
    const visible = this.visibleProjects();
    const stores = this.state.stores.filter((store) => visible.includes(store.projectId));
    const summaries = stores.map((store) => this.summary(store));
    return {
      body: {
        stores: summaries,
        sitesWithoutStore: this.deps.projects
          .filter((project) => visible.includes(project.id))
          .flatMap((project) =>
            project.sites
              .filter((site) => !this.state.stores.some((store) => store.siteId === site.id))
              .map((site) => ({
                project: { id: project.id, code: project.code, name: project.name },
                site,
                canCreate: this.can(project.id, MANAGE),
              })),
          ),
        lowStock: this.lowStock(stores),
        totalValueMinor: summaries.reduce((total, store) => total + store.valueMinor, 0),
      },
      schema: storesResponseSchema,
    };
  }

  create(body: unknown): Reply {
    const input = this.deps.parse(createStoreRequestSchema, body);
    const project = this.deps.projects.find((entry) =>
      entry.sites.some((site) => site.id === input.siteId),
    );
    if (!project) this.fail(404, "not-found");
    this.require(project.id, MANAGE);
    if (this.state.stores.some((store) => store.siteId === input.siteId))
      this.fail(409, "store-exists");
    const site = project.sites.find((entry) => entry.id === input.siteId)!;
    const store: MockStore = {
      id: id(),
      name: input.name ?? `${site.name} store`,
      projectId: project.id,
      siteId: site.id,
      storekeeper: null,
      version: 1,
    };
    this.state.stores.push(store);
    return { ...this.detail(store.id), status: 201 };
  }

  detail(storeId: string): Reply {
    const store = this.store(storeId);
    const canManage = this.can(store.projectId, MANAGE);
    const keys = new Set([
      ...[...this.state.positions.keys()].filter((key) => key.startsWith(`${store.id}:`)),
      ...[...this.state.reorderLevels.keys()].filter((key) => key.startsWith(`${store.id}:`)),
    ]);
    const balances = [...keys]
      .map((key) => {
        const materialId = key.split(":")[1]!;
        const position = this.position(store.id, materialId);
        const level = this.state.reorderLevels.get(key) ?? null;
        const last = this.state.entries
          .filter((entry) => entry.storeId === store.id && entry.materialId === materialId)
          .map((entry) => entry.recordedAt)
          .sort()
          .at(-1);
        return {
          material: this.materialRef(materialId),
          quantity: position.quantity,
          averageUnitCostMinor: averageUnitCost(position),
          valueMinor: toMinor(position.valueMinor),
          reorderLevel: level,
          low: isLowStock(position.quantity, level),
          lastMovementAt: last ?? null,
        };
      })
      .filter((row) => nonZero(row.quantity) || row.reorderLevel !== null)
      .sort((left, right) => left.material.code.localeCompare(right.material.code));
    const openTake = this.state.takes.find(
      (take) =>
        take.storeId === store.id && (take.status === "draft" || take.status === "submitted"),
    );
    return {
      body: {
        store: this.summary(store),
        balances,
        inTransit: this.state.transfers
          .filter(
            (transfer) =>
              transfer.status === "dispatched" &&
              (transfer.fromStoreId === store.id || transfer.toStoreId === store.id),
          )
          .map((transfer) => ({
            transfer: { id: transfer.id, number: transfer.number, status: transfer.status },
            direction: transfer.toStoreId === store.id ? ("in" as const) : ("out" as const),
            otherStore: this.storeRef(
              this.state.stores.find(
                (entry) =>
                  entry.id ===
                  (transfer.toStoreId === store.id ? transfer.fromStoreId : transfer.toStoreId),
              )!,
            ),
            dispatchedAt: transfer.dispatchedAt,
            valueMinor: toMinor(
              sumDecimals(transfer.lines.map((line) => line.dispatchedValueMinor)),
            ),
            lines: transfer.lines.map((line) => ({
              material: this.materialRef(line.materialId),
              baseQuantity: line.baseQuantity,
            })),
          })),
        openStockTake: openTake
          ? { id: openTake.id, number: openTake.number, status: openTake.status }
          : null,
        storekeeperCandidates: [],
        permissions: {
          canIssue: canManage,
          canWaste: canManage,
          canTransfer: canManage,
          canCount: canManage && !openTake,
          canEditReorderLevels: canManage,
          canEdit: canManage,
        },
      },
      schema: storeDetailResponseSchema,
    };
  }

  reorderLevels(storeId: string, body: unknown): Reply {
    const store = this.store(storeId);
    this.require(store.projectId, MANAGE);
    const input = this.deps.parse(reorderLevelsRequestSchema, body);
    for (const level of input.levels) {
      this.material(level.materialId);
      const key = positionKey(store.id, level.materialId);
      if (level.reorderLevel === null) this.state.reorderLevels.delete(key);
      else this.state.reorderLevels.set(key, level.reorderLevel);
    }
    return this.detail(store.id);
  }

  ledger(storeId: string, query: URLSearchParams): Reply {
    const store = this.store(storeId);
    const materialId = query.get("materialId");
    const kind = query.get("kind");
    const cursor = query.get("cursor");
    const limit = Number(query.get("limit") ?? 50);
    const all = this.state.entries
      .filter(
        (entry) =>
          entry.storeId === store.id &&
          (!materialId || entry.materialId === materialId) &&
          (!kind || entry.kind === kind),
      )
      .sort(
        (left, right) =>
          right.recordedAt.localeCompare(left.recordedAt) ||
          this.state.entries.indexOf(right) - this.state.entries.indexOf(left),
      );
    const start = cursor ? all.findIndex((entry) => entry.id === cursor) + 1 : 0;
    const page = all.slice(start, start + limit);
    const hasMore = start + limit < all.length;
    return {
      body: {
        store: { id: store.id, name: store.name },
        entries: page.map((entry) => ({
          id: entry.id,
          seq: entry.seq,
          kind: entry.kind,
          material: this.materialRef(entry.materialId),
          quantity: entry.quantity,
          unitCostMinor: entry.unitCostMinor,
          valueMinor: entry.valueMinor,
          balanceQuantity: entry.balanceQuantity,
          balanceValueMinor: entry.balanceValueMinor,
          businessDate: entry.businessDate,
          recordedAt: entry.recordedAt,
          recordedBy: entry.recordedBy,
          source: entry.source,
          bqItem: this.item(entry.bqItemLineageId),
          gang: this.gang(entry.gangId),
          reversesEntryId: entry.reversesEntryId,
        })),
        page: { nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null, hasMore },
      },
      schema: ledgerResponseSchema,
    };
  }

  issueOptions(storeId: string, query: URLSearchParams): Reply {
    const store = this.store(storeId);
    if (!this.held(store.projectId).has(MANAGE)) this.fail(403, "forbidden");
    const needle = (query.get("bqSearch") ?? "").trim().toLowerCase();
    const matching = this.state.items
      .filter((item) => item.projectId === store.projectId)
      .map((item) => this.item(item.lineageId)!)
      .filter(
        (item) =>
          !needle ||
          item.description.toLowerCase().includes(needle) ||
          (item.ref ?? "").toLowerCase().includes(needle),
      );
    return {
      body: {
        store: this.storeRef(store),
        bqItems: matching.slice(0, STORES_LIMITS.issueBqItems),
        bqItemsTruncated: matching.length > STORES_LIMITS.issueBqItems,
        gangs: this.deps.gangs
          .filter((gang) => gang.projectId === store.projectId && gang.status === "active")
          .map((gang) => ({ id: gang.id, name: gang.name })),
        stock: [...this.state.positions.entries()]
          .filter(([key, position]) => key.startsWith(`${store.id}:`) && nonZero(position.quantity))
          .map(([key, position]) => ({
            material: this.materialRef(key.split(":")[1]!),
            quantity: position.quantity,
          }))
          .sort((left, right) => left.material.code.localeCompare(right.material.code)),
      },
      schema: issueOptionsResponseSchema,
    };
  }

  transferTargets(storeId: string): Reply {
    const store = this.store(storeId);
    if (!this.held(store.projectId).has(MANAGE)) this.fail(403, "forbidden");
    const visible = this.visibleProjects();
    return {
      body: {
        stores: this.state.stores
          .filter((entry) => entry.id !== store.id && visible.includes(entry.projectId))
          .map((entry) => this.storeRef(entry)),
      },
      schema: transferTargetsResponseSchema,
    };
  }

  // Movements -------------------------------------------------------------------------------

  /** Takes the lines out of the store at average cost, all or nothing. */
  private planOutflows(storeId: string, lines: { materialId: string; baseQuantity: string }[]) {
    const scratch = new Map<string, StockPosition>();
    return lines.map((line) => {
      const before = scratch.get(line.materialId) ?? this.position(storeId, line.materialId);
      const out = takeFromStock(before, line.baseQuantity);
      if (!out.ok) this.fail(409, "insufficient-stock");
      scratch.set(line.materialId, out.after);
      return out;
    });
  }

  private movementReply(movement: MockMovement, replayed: boolean, status = 200): Reply {
    const store = this.state.stores.find((entry) => entry.id === movement.storeId)!;
    const returns = this.state.movements.filter(
      (entry) => entry.kind === "return" && entry.returnOfId === movement.id,
    );
    const returnedOf = (lineId: string) =>
      sumDecimals(
        returns
          .filter((entry) => entry.status === "posted")
          .flatMap((entry) => entry.lines)
          .filter((line) => line.returnOfLineId === lineId)
          .map((line) => line.baseQuantity),
      );
    const lines = movement.lines.map((line) => {
      const returned = movement.kind === "issue" ? returnedOf(line.id) : null;
      return {
        id: line.id,
        lineNo: line.lineNo,
        material: this.materialRef(line.materialId),
        quantity: line.quantity,
        unit: line.unit,
        baseQuantity: line.baseQuantity,
        valueMinor: line.valueMinor,
        unitCostMinor: line.unitCostMinor,
        returnOfLineId: line.returnOfLineId,
        returnedBaseQuantity: returned,
        returnableBaseQuantity:
          returned === null
            ? null
            : movement.status === "posted"
              ? returnableQuantity(line.baseQuantity, returned)
              : "0",
      };
    });
    const returnOf = this.state.movements.find((entry) => entry.id === movement.returnOfId);
    const wire: Movement = {
      id: movement.id,
      number: movement.number,
      kind: movement.kind,
      status: movement.status,
      store: this.storeRef(store),
      bqItem: this.item(movement.bqItemLineageId),
      gang: this.gang(movement.gangId),
      issuedToName: movement.issuedToName,
      returnOf: returnOf
        ? { id: returnOf.id, number: returnOf.number, status: returnOf.status }
        : null,
      wastageReason: movement.wastageReason,
      notes: movement.notes,
      capturedAt: movement.capturedAt,
      recordedAt: movement.recordedAt,
      businessDate: movement.businessDate,
      recordedBy: movement.recordedBy,
      source: movement.source,
      reversedAt: movement.reversedAt,
      reversedBy: movement.reversedBy,
      reversalReason: movement.reversalReason,
      totalValueMinor: toMinor(sumDecimals(movement.lines.map((line) => line.valueMinor))),
      lineCount: movement.lines.length,
      lines,
      returns: returns.map((entry) => ({
        id: entry.id,
        number: entry.number,
        status: entry.status,
      })),
    };
    const manage = this.can(store.projectId, MANAGE);
    const posted = movement.status === "posted";
    const hasReturns = returns.some((entry) => entry.status === "posted");
    return {
      status,
      body: {
        movement: wire,
        replayed,
        permissions: {
          canReverse: manage && posted && !hasReturns,
          canReturn:
            manage &&
            posted &&
            movement.kind === "issue" &&
            lines.some((line) => nonZero(line.returnableBaseQuantity ?? "0")),
        },
      },
      schema: movementResponseSchema,
    };
  }

  private replay(operation: string, input: { id: string }): Reply | null {
    const key = this.key();
    const digest = digestOf(operation, input);
    const existing = this.state.movements.find((movement) => movement.key === key);
    if (existing) {
      if (existing.digest !== digest || existing.id !== input.id)
        this.fail(409, "idempotency-key-reused");
      return this.movementReply(existing, true, 201);
    }
    if (this.state.movements.some((movement) => movement.id === input.id))
      this.fail(409, "movement-id-conflict");
    return null;
  }

  createOutflow(kind: "issue" | "wastage", body: unknown): Reply {
    const input =
      kind === "issue"
        ? this.deps.parse(createIssueRequestSchema, body)
        : this.deps.parse(createWastageRequestSchema, body);
    const store = this.store(input.storeId);
    this.require(store.projectId, MANAGE);
    const replayed = this.replay(`stock.${kind}`, input);
    if (replayed) return replayed;
    const target =
      "bqItemLineageId" in input
        ? { lineageId: input.bqItemLineageId, gangId: input.gangId, name: input.issuedToName }
        : null;
    if (target?.lineageId) {
      const item = this.state.items.find((entry) => entry.lineageId === target.lineageId);
      if (!item || item.projectId !== store.projectId) this.fail(404, "bq-item-not-found");
    }
    if (target?.gangId) {
      const gang = this.deps.gangs.find((entry) => entry.id === target.gangId);
      if (!gang || gang.projectId !== store.projectId) this.fail(409, "gang-not-in-project");
    }
    const lines = input.lines.map((line) => ({
      ...line,
      baseQuantity: this.toBase(line.materialId, line.quantity, line.unit),
    }));
    const outflows = this.planOutflows(store.id, lines);
    const recordedAt = now();
    const movement: MockMovement = {
      id: input.id,
      number: this.number(kind === "issue" ? "ISS" : "WST"),
      kind,
      status: "posted",
      storeId: store.id,
      bqItemLineageId: target?.lineageId ?? null,
      gangId: target?.gangId ?? null,
      issuedToName: target?.name ?? null,
      returnOfId: null,
      wastageReason: "reason" in input ? input.reason : null,
      notes: input.notes ?? null,
      capturedAt: input.capturedAt,
      recordedAt,
      businessDate: nairobiDate(new Date(recordedAt)),
      recordedBy: this.deps.actor,
      source: input.source,
      reversedAt: null,
      reversedBy: null,
      reversalReason: null,
      lines: [],
      key: this.key(),
      digest: digestOf(`stock.${kind}`, input),
    };
    lines.forEach((line, index) => {
      const out = outflows[index]!;
      if (!out.ok) return;
      const lineId = id();
      movement.lines.push({
        id: lineId,
        lineNo: index + 1,
        materialId: line.materialId,
        quantity: line.quantity,
        unit: line.unit,
        baseQuantity: line.baseQuantity,
        valueMinor: out.valueMinor,
        unitCostMinor: out.unitCostMinor,
        returnOfLineId: null,
      });
      post(this.state, {
        storeId: store.id,
        materialId: line.materialId,
        kind,
        quantity: negateDecimal(line.baseQuantity),
        valueMinor: negateDecimal(out.valueMinor),
        unitCostMinor: out.unitCostMinor,
        source: { type: "movement", id: movement.id, number: movement.number },
        sourceLineId: lineId,
        recordedAt,
        recordedBy: this.deps.actor,
        bqItemLineageId: movement.bqItemLineageId,
        gangId: movement.gangId,
        reversesEntryId: null,
      });
    });
    this.state.movements.push(movement);
    return this.movementReply(movement, false, 201);
  }

  createReturn(body: unknown): Reply {
    const input = this.deps.parse(createReturnRequestSchema, body);
    const issue = this.movement(input.issueId);
    const store = this.state.stores.find((entry) => entry.id === issue.storeId)!;
    this.require(store.projectId, MANAGE);
    const replayed = this.replay("stock.return", input);
    if (replayed) return replayed;
    if (issue.kind !== "issue") this.fail(404, "not-found");
    if (issue.status !== "posted") this.fail(409, "issue-not-posted");
    const current = this.movementReply(issue, false).body as {
      movement: Movement;
    };
    const lines = input.lines.map((line) => {
      const issued = issue.lines.find((entry) => entry.id === line.issueLineId);
      if (!issued) this.fail(400, "line-not-on-issue");
      const baseQuantity = this.toBase(issued.materialId, line.quantity, line.unit ?? issued.unit);
      const returnable =
        current.movement.lines.find((entry) => entry.id === issued.id)?.returnableBaseQuantity ??
        "0";
      if (compareDecimals(baseQuantity, returnable) > 0) this.fail(409, "return-exceeds-issued");
      return { issued, baseQuantity, quantity: line.quantity, unit: line.unit ?? issued.unit };
    });
    const recordedAt = now();
    const movement: MockMovement = {
      id: input.id,
      number: this.number("RTN"),
      kind: "return",
      status: "posted",
      storeId: store.id,
      bqItemLineageId: issue.bqItemLineageId,
      gangId: issue.gangId,
      issuedToName: null,
      returnOfId: issue.id,
      wastageReason: null,
      notes: input.notes ?? null,
      capturedAt: input.capturedAt,
      recordedAt,
      businessDate: nairobiDate(new Date(recordedAt)),
      recordedBy: this.deps.actor,
      source: input.source,
      reversedAt: null,
      reversedBy: null,
      reversalReason: null,
      lines: [],
      key: this.key(),
      digest: digestOf("stock.return", input),
    };
    lines.forEach((line, index) => {
      const inflow = receiveIntoStock(
        this.position(store.id, line.issued.materialId),
        line.baseQuantity,
        line.issued.unitCostMinor,
      );
      const lineId = id();
      movement.lines.push({
        id: lineId,
        lineNo: index + 1,
        materialId: line.issued.materialId,
        quantity: line.quantity,
        unit: line.unit,
        baseQuantity: line.baseQuantity,
        valueMinor: inflow.valueMinor,
        unitCostMinor: line.issued.unitCostMinor,
        returnOfLineId: line.issued.id,
      });
      post(this.state, {
        storeId: store.id,
        materialId: line.issued.materialId,
        kind: "return",
        quantity: line.baseQuantity,
        valueMinor: inflow.valueMinor,
        unitCostMinor: line.issued.unitCostMinor,
        source: { type: "movement", id: movement.id, number: movement.number },
        sourceLineId: lineId,
        recordedAt,
        recordedBy: this.deps.actor,
        bqItemLineageId: movement.bqItemLineageId,
        gangId: movement.gangId,
        reversesEntryId: null,
      });
    });
    this.state.movements.push(movement);
    return this.movementReply(movement, false, 201);
  }

  movement(movementId: string): MockMovement {
    const movement = this.state.movements.find((entry) => entry.id === movementId);
    if (!movement) this.fail(404, "not-found");
    this.store(movement.storeId);
    return movement;
  }

  movementDetail(movementId: string): Reply {
    return this.movementReply(this.movement(movementId), false);
  }

  /** Reversing entries for every line of a movement or transfer (never edits). */
  private reverseEntries(sourceId: string) {
    const recordedAt = now();
    const originals = this.state.entries.filter(
      (entry) =>
        entry.source.id === sourceId &&
        entry.reversesEntryId === null &&
        !this.state.entries.some((other) => other.reversesEntryId === entry.id),
    );
    // Inflows (returns, transfers in) leave at average cost first, so a refusal changes nothing.
    for (const entry of originals.filter(
      (candidate) => compareDecimals(candidate.quantity, "0") > 0,
    ))
      this.planOutflows(entry.storeId, [
        { materialId: entry.materialId, baseQuantity: entry.quantity },
      ]);
    for (const entry of originals) {
      const inflowReversal = compareDecimals(entry.quantity, "0") > 0;
      const position = this.position(entry.storeId, entry.materialId);
      const out = inflowReversal ? takeFromStock(position, entry.quantity) : null;
      if (out && !out.ok) this.fail(409, "insufficient-stock");
      post(this.state, {
        storeId: entry.storeId,
        materialId: entry.materialId,
        kind: entry.kind,
        quantity: negateDecimal(entry.quantity),
        valueMinor: out?.ok ? negateDecimal(out.valueMinor) : negateDecimal(entry.valueMinor),
        unitCostMinor: out?.ok ? out.unitCostMinor : entry.unitCostMinor,
        source: entry.source,
        sourceLineId: entry.sourceLineId,
        recordedAt,
        recordedBy: this.deps.actor,
        bqItemLineageId: entry.bqItemLineageId,
        gangId: entry.gangId,
        reversesEntryId: entry.id,
      });
    }
  }

  reverse(movementId: string, body: unknown): Reply {
    const movement = this.movement(movementId);
    const store = this.state.stores.find((entry) => entry.id === movement.storeId)!;
    this.require(store.projectId, MANAGE);
    const input = this.deps.parse(reverseRequestSchema, body);
    if (movement.status !== "posted") this.fail(409, "invalid-transition");
    if (
      this.state.movements.some(
        (entry) => entry.returnOfId === movement.id && entry.status === "posted",
      )
    )
      this.fail(409, "movement-has-returns");
    this.reverseEntries(movement.id);
    movement.status = "reversed";
    movement.reversedAt = now();
    movement.reversedBy = this.deps.actor;
    movement.reversalReason = input.reason;
    return this.movementReply(movement, false);
  }

  movements(query: URLSearchParams): Reply {
    const visible = this.visibleProjects();
    const storeId = query.get("storeId");
    const kind = query.get("kind");
    const limit = Number(query.get("limit") ?? 50);
    const cursor = query.get("cursor");
    const all = [...this.state.movements]
      .filter((movement) => {
        const store = this.state.stores.find((entry) => entry.id === movement.storeId)!;
        return (
          visible.includes(store.projectId) &&
          (!storeId || movement.storeId === storeId) &&
          (!kind || movement.kind === kind)
        );
      })
      .reverse();
    const start = cursor ? all.findIndex((movement) => movement.id === cursor) + 1 : 0;
    const page = all.slice(start, start + limit);
    const hasMore = start + limit < all.length;
    return {
      body: {
        movements: page.map((movement) =>
          without(
            (this.movementReply(movement, false).body as { movement: Movement }).movement,
            "lines",
            "returns",
          ),
        ),
        page: { nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null, hasMore },
      },
      schema: movementsResponseSchema,
    };
  }

  // Transfers -------------------------------------------------------------------------------

  private transfer(transferId: string): MockTransfer {
    const transfer = this.state.transfers.find((entry) => entry.id === transferId);
    if (!transfer) this.fail(404, "not-found");
    const visible = this.visibleProjects();
    const from = this.state.stores.find((entry) => entry.id === transfer.fromStoreId)!;
    const to = this.state.stores.find((entry) => entry.id === transfer.toStoreId)!;
    if (!visible.includes(from.projectId) && !visible.includes(to.projectId))
      this.fail(404, "not-found");
    return transfer;
  }

  private transferWire(transfer: MockTransfer): Transfer {
    const from = this.state.stores.find((entry) => entry.id === transfer.fromStoreId)!;
    const to = this.state.stores.find((entry) => entry.id === transfer.toStoreId)!;
    const received = transfer.lines.every((line) => line.receivedBaseQuantity !== null);
    const dispatched = sumDecimals(transfer.lines.map((line) => line.dispatchedValueMinor));
    const arrived = sumDecimals(
      transfer.lines.map((line) =>
        microTimesDecimal(line.receivedBaseQuantity ?? "0", line.unitCostMinor),
      ),
    );
    const lost =
      transfer.status === "received"
        ? "0"
        : received && transfer.status !== "cancelled"
          ? sumDecimals([dispatched, negateDecimal(arrived)])
          : null;
    return {
      id: transfer.id,
      number: transfer.number,
      status: transfer.status,
      fromStore: this.storeRef(from),
      toStore: this.storeRef(to),
      capturedAt: transfer.capturedAt,
      dispatchedAt: transfer.dispatchedAt,
      dispatchedBy: transfer.dispatchedBy,
      dispatchNotes: transfer.dispatchNotes,
      receivedAt: transfer.receivedAt,
      receivedBy: transfer.receivedBy,
      receiveNotes: transfer.receiveNotes,
      resolvedAt: transfer.resolvedAt,
      resolvedBy: transfer.resolvedBy,
      resolutionNote: transfer.resolutionNote,
      cancelledAt: transfer.cancelledAt,
      cancelledBy: transfer.cancelledBy,
      cancelReason: transfer.cancelReason,
      source: transfer.source,
      version: transfer.version,
      dispatchedValueMinor: toMinor(dispatched),
      transitLossValueMinor: lost === null ? null : toMinor(lost),
      lineCount: transfer.lines.length,
      lines: transfer.lines.map((line) => ({
        id: line.id,
        lineNo: line.lineNo,
        material: this.materialRef(line.materialId),
        quantity: line.quantity,
        unit: line.unit,
        baseQuantity: line.baseQuantity,
        unitCostMinor: line.unitCostMinor,
        dispatchedValueMinor: line.dispatchedValueMinor,
        receivedBaseQuantity: line.receivedBaseQuantity,
        differenceBaseQuantity:
          line.receivedBaseQuantity === null
            ? null
            : sumDecimals([line.receivedBaseQuantity, negateDecimal(line.baseQuantity)]),
        differenceReason: line.differenceReason,
      })),
    };
  }

  private transferReply(transfer: MockTransfer, replayed: boolean, status = 200): Reply {
    const from = this.state.stores.find((entry) => entry.id === transfer.fromStoreId)!;
    const to = this.state.stores.find((entry) => entry.id === transfer.toStoreId)!;
    const me = this.deps.actor.id;
    return {
      status,
      body: {
        transfer: this.transferWire(transfer),
        replayed,
        permissions: {
          canReceive: transfer.status === "dispatched" && this.can(to.projectId, MANAGE),
          canCancel: transfer.status === "dispatched" && this.can(from.projectId, MANAGE),
          canResolve:
            transfer.status === "disputed" &&
            (this.can(from.projectId, APPROVE) || this.can(to.projectId, APPROVE)) &&
            me !== transfer.dispatchedBy.id &&
            me !== transfer.receivedBy?.id,
        },
      },
      schema: transferResponseSchema,
    };
  }

  dispatch(body: unknown): Reply {
    const input = this.deps.parse(dispatchTransferRequestSchema, body);
    const from = this.store(input.fromStoreId);
    const to = this.store(input.toStoreId);
    this.require(from.projectId, MANAGE);
    const key = this.key();
    const digest = digestOf("stock.transfer", input);
    const existing = this.state.transfers.find((transfer) => transfer.key === key);
    if (existing) {
      if (existing.digest !== digest || existing.id !== input.id)
        this.fail(409, "idempotency-key-reused");
      return this.transferReply(existing, true, 201);
    }
    if (this.state.transfers.some((transfer) => transfer.id === input.id))
      this.fail(409, "transfer-id-conflict");
    const lines = input.lines.map((line) => ({
      ...line,
      baseQuantity: this.toBase(line.materialId, line.quantity, line.unit),
    }));
    const outflows = this.planOutflows(from.id, lines);
    const recordedAt = now();
    const transfer: MockTransfer = {
      id: input.id,
      number: this.number("TRF"),
      status: "dispatched",
      fromStoreId: from.id,
      toStoreId: to.id,
      capturedAt: input.capturedAt,
      dispatchedAt: recordedAt,
      dispatchedBy: this.deps.actor,
      dispatchNotes: input.notes ?? null,
      receivedAt: null,
      receivedBy: null,
      receiveNotes: null,
      resolvedAt: null,
      resolvedBy: null,
      resolutionNote: null,
      cancelledAt: null,
      cancelledBy: null,
      cancelReason: null,
      source: input.source,
      version: 1,
      lines: [],
      key,
      digest,
      receipt: null,
    };
    lines.forEach((line, index) => {
      const out = outflows[index]!;
      if (!out.ok) return;
      const lineId = id();
      transfer.lines.push({
        id: lineId,
        lineNo: index + 1,
        materialId: line.materialId,
        quantity: line.quantity,
        unit: line.unit,
        baseQuantity: line.baseQuantity,
        unitCostMinor: out.unitCostMinor,
        dispatchedValueMinor: out.valueMinor,
        receivedBaseQuantity: null,
        differenceReason: null,
      });
      post(this.state, {
        storeId: from.id,
        materialId: line.materialId,
        kind: "transfer_out",
        quantity: negateDecimal(line.baseQuantity),
        valueMinor: negateDecimal(out.valueMinor),
        unitCostMinor: out.unitCostMinor,
        source: { type: "transfer", id: transfer.id, number: transfer.number },
        sourceLineId: lineId,
        recordedAt,
        recordedBy: this.deps.actor,
        bqItemLineageId: null,
        gangId: null,
        reversesEntryId: null,
      });
    });
    this.state.transfers.push(transfer);
    return this.transferReply(transfer, false, 201);
  }

  receive(transferId: string, body: unknown): Reply {
    const transfer = this.transfer(transferId);
    const to = this.state.stores.find((entry) => entry.id === transfer.toStoreId)!;
    this.require(to.projectId, MANAGE);
    const input = this.deps.parse(receiveTransferRequestSchema, body);
    const key = this.key();
    const digest = digestOf("stock.transfer_receive", input);
    if (transfer.receipt?.key === key) {
      if (transfer.receipt.digest !== digest) this.fail(409, "idempotency-key-reused");
      return this.transferReply(transfer, true);
    }
    if (
      input.lines.length !== transfer.lines.length ||
      transfer.lines.some((line) => !input.lines.some((entry) => entry.lineId === line.id))
    )
      this.fail(400, "transfer-lines-mismatch");
    const differs = input.lines.some((entry) => {
      const line = transfer.lines.find((candidate) => candidate.id === entry.lineId)!;
      return compareDecimals(entry.receivedQuantity, line.baseQuantity) !== 0;
    });
    const action: TransferAction = differs ? "dispute" : "receive";
    const check = checkProcurementTransition(TRANSFER_TRANSITIONS, transfer.status, action);
    if (!check.ok) this.fail(409, "invalid-transition");
    for (const entry of input.lines) {
      const line = transfer.lines.find((candidate) => candidate.id === entry.lineId)!;
      if (
        compareDecimals(entry.receivedQuantity, line.baseQuantity) !== 0 &&
        (entry.differenceReason ?? "").length < 3
      )
        this.fail(400, "difference-reason-required");
    }
    const recordedAt = now();
    for (const entry of input.lines) {
      const line = transfer.lines.find((candidate) => candidate.id === entry.lineId)!;
      line.receivedBaseQuantity = entry.receivedQuantity;
      line.differenceReason = entry.differenceReason ?? null;
      if (!nonZero(entry.receivedQuantity)) continue;
      const inflow = receiveIntoStock(
        this.position(to.id, line.materialId),
        entry.receivedQuantity,
        line.unitCostMinor,
      );
      post(this.state, {
        storeId: to.id,
        materialId: line.materialId,
        kind: "transfer_in",
        quantity: entry.receivedQuantity,
        valueMinor: inflow.valueMinor,
        unitCostMinor: line.unitCostMinor,
        source: { type: "transfer", id: transfer.id, number: transfer.number },
        sourceLineId: line.id,
        recordedAt,
        recordedBy: this.deps.actor,
        bqItemLineageId: null,
        gangId: null,
        reversesEntryId: null,
      });
    }
    transfer.status = check.to;
    transfer.receivedAt = recordedAt;
    transfer.receivedBy = this.deps.actor;
    transfer.receiveNotes = input.notes ?? null;
    transfer.receipt = { key, digest };
    transfer.version += 1;
    return this.transferReply(transfer, false);
  }

  decide(transferId: string, action: "resolve" | "cancel", body: unknown): Reply {
    const transfer = this.transfer(transferId);
    const from = this.state.stores.find((entry) => entry.id === transfer.fromStoreId)!;
    const to = this.state.stores.find((entry) => entry.id === transfer.toStoreId)!;
    const input = this.deps.parse(transferDecisionRequestSchema, body);
    if (action === "cancel") this.require(from.projectId, MANAGE);
    else if (!this.can(from.projectId, APPROVE) && !this.can(to.projectId, APPROVE))
      this.require(from.projectId, APPROVE);
    const check = checkProcurementTransition(
      TRANSFER_TRANSITIONS,
      transfer.status,
      action,
      input.reason,
    );
    if (!check.ok) this.fail(409, "invalid-transition");
    if (transfer.version !== input.version) this.fail(409, "version-conflict");
    if (
      action === "resolve" &&
      (transfer.dispatchedBy.id === this.deps.actor.id ||
        transfer.receivedBy?.id === this.deps.actor.id)
    )
      this.fail(403, "maker-checker");
    const at = now();
    if (action === "cancel") {
      this.reverseEntries(transfer.id);
      transfer.cancelledAt = at;
      transfer.cancelledBy = this.deps.actor;
      transfer.cancelReason = input.reason;
    } else {
      transfer.resolvedAt = at;
      transfer.resolvedBy = this.deps.actor;
      transfer.resolutionNote = input.reason;
    }
    transfer.status = check.to;
    transfer.version += 1;
    return this.transferReply(transfer, false);
  }

  transferDetail(transferId: string): Reply {
    return this.transferReply(this.transfer(transferId), false);
  }

  transfers(query: URLSearchParams): Reply {
    const visible = this.visibleProjects();
    const status = query.get("status");
    const storeId = query.get("storeId");
    const limit = Number(query.get("limit") ?? 50);
    const cursor = query.get("cursor");
    const all = [...this.state.transfers]
      .filter((transfer) => {
        const from = this.state.stores.find((entry) => entry.id === transfer.fromStoreId)!;
        const to = this.state.stores.find((entry) => entry.id === transfer.toStoreId)!;
        return (
          (visible.includes(from.projectId) || visible.includes(to.projectId)) &&
          (!status || transfer.status === status) &&
          (!storeId || transfer.fromStoreId === storeId || transfer.toStoreId === storeId)
        );
      })
      .reverse();
    const start = cursor ? all.findIndex((transfer) => transfer.id === cursor) + 1 : 0;
    const page = all.slice(start, start + limit);
    const hasMore = start + limit < all.length;
    return {
      body: {
        transfers: page.map((transfer) => without(this.transferWire(transfer), "lines")),
        page: { nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null, hasMore },
      },
      schema: transfersResponseSchema,
    };
  }

  // Stock takes -----------------------------------------------------------------------------

  private take(takeId: string): MockTake {
    const take = this.state.takes.find((entry) => entry.id === takeId);
    if (!take) this.fail(404, "not-found");
    this.store(take.storeId);
    return take;
  }

  private takeWire(take: MockTake): StockTake {
    const store = this.state.stores.find((entry) => entry.id === take.storeId)!;
    const lines = take.lines.map((line) => {
      const variance =
        line.countedQuantity !== null && line.expectedQuantity !== null
          ? countVariance(line.expectedQuantity, line.countedQuantity)
          : null;
      const cost = averageUnitCost(this.position(store.id, line.materialId)) ?? "0";
      return {
        id: line.id,
        lineNo: line.lineNo,
        material: this.materialRef(line.materialId),
        snapshotQuantity: line.snapshotQuantity,
        countedQuantity: line.countedQuantity,
        expectedQuantity: line.expectedQuantity,
        movementsSinceSnapshot:
          line.expectedQuantity === null
            ? null
            : sumDecimals([line.expectedQuantity, negateDecimal(line.snapshotQuantity)]),
        varianceQuantity: variance,
        varianceValueMinor: variance === null ? null : toMinor(microTimesDecimal(variance, cost)),
        countedBy: line.countedBy,
        countedAt: line.countedAt,
        adjustmentEntryId: line.adjustmentEntryId,
      };
    });
    return {
      id: take.id,
      number: take.number,
      status: take.status,
      store: this.storeRef(store),
      notes: take.notes,
      createdAt: take.createdAt,
      createdBy: take.createdBy,
      submittedAt: take.submittedAt,
      submittedBy: take.submittedBy,
      approvedAt: take.approvedAt,
      approvedBy: take.approvedBy,
      returnReason: take.returnReason,
      cancelledAt: take.cancelledAt,
      cancelledBy: take.cancelledBy,
      cancelReason: take.cancelReason,
      contributors: take.contributors,
      version: take.version,
      lineCount: lines.length,
      countedCount: lines.filter((line) => line.countedQuantity !== null).length,
      varianceCount: lines.filter(
        (line) => line.varianceQuantity !== null && nonZero(line.varianceQuantity),
      ).length,
      lines,
    };
  }

  private takeReply(take: MockTake, replayed: boolean, status = 200): Reply {
    const store = this.state.stores.find((entry) => entry.id === take.storeId)!;
    const manage = this.can(store.projectId, MANAGE);
    const approve = this.can(store.projectId, APPROVE);
    const draft = take.status === "draft";
    const submitted = take.status === "submitted";
    const wire = this.takeWire(take);
    return {
      status,
      body: {
        stockTake: wire,
        replayed,
        uncoveredMaterials: 0,
        permissions: {
          canCount: manage && draft,
          canSubmit: manage && draft && wire.countedCount === wire.lineCount,
          canApprove:
            approve &&
            submitted &&
            !take.contributors.some((person) => person.id === this.deps.actor.id),
          canReturn: approve && submitted,
          canCancel: (manage || approve) && (draft || submitted),
        },
      },
      schema: stockTakeResponseSchema,
    };
  }

  private contribute(take: MockTake) {
    if (!take.contributors.some((person) => person.id === this.deps.actor.id))
      take.contributors.push(this.deps.actor);
  }

  startTake(body: unknown): Reply {
    const input = this.deps.parse(createStockTakeRequestSchema, body);
    const store = this.store(input.storeId);
    this.require(store.projectId, MANAGE);
    if (
      this.state.takes.some(
        (take) =>
          take.storeId === store.id && (take.status === "draft" || take.status === "submitted"),
      )
    )
      this.fail(409, "stock-take-open");
    const materialIds = [
      ...new Set(
        [...this.state.positions.entries(), ...this.state.reorderLevels.entries()]
          .filter(([key]) => key.startsWith(`${store.id}:`))
          .filter(
            ([key]) =>
              nonZero(this.state.positions.get(key)?.quantity ?? "0") ||
              this.state.reorderLevels.has(key),
          )
          .map(([key]) => key.split(":")[1]!),
      ),
    ]
      .filter((materialId) => !input.materialIds || input.materialIds.includes(materialId))
      .sort((left, right) => this.material(left).code.localeCompare(this.material(right).code));
    if (!materialIds.length) this.fail(409, "stock-take-empty");
    const take: MockTake = {
      id: id(),
      number: this.number("STK"),
      status: "draft",
      storeId: store.id,
      notes: input.notes ?? null,
      createdAt: now(),
      createdBy: this.deps.actor,
      submittedAt: null,
      submittedBy: null,
      approvedAt: null,
      approvedBy: null,
      returnReason: null,
      cancelledAt: null,
      cancelledBy: null,
      cancelReason: null,
      contributors: [this.deps.actor],
      version: 1,
      lines: materialIds.map((materialId, index) => ({
        id: id(),
        lineNo: index + 1,
        materialId,
        snapshotQuantity: this.position(store.id, materialId).quantity,
        countedQuantity: null,
        expectedQuantity: null,
        countedBy: null,
        countedAt: null,
        adjustmentEntryId: null,
      })),
      batches: new Map(),
    };
    this.state.takes.push(take);
    return this.takeReply(take, false, 201);
  }

  counts(takeId: string, body: unknown): Reply {
    const take = this.take(takeId);
    const store = this.state.stores.find((entry) => entry.id === take.storeId)!;
    this.require(store.projectId, MANAGE);
    const input = this.deps.parse(recordCountsRequestSchema, body);
    const key = this.key();
    const digest = digestOf("stock_take.counts", input);
    const replay = take.batches.get(key);
    if (replay !== undefined) {
      if (replay !== digest) this.fail(409, "idempotency-key-reused");
      return this.takeReply(take, true);
    }
    if (take.status !== "draft") this.fail(409, "invalid-transition");
    for (const count of input.counts)
      if (!take.lines.some((line) => line.id === count.lineId))
        this.fail(400, "line-not-on-stock-take");
    const at = now();
    for (const count of input.counts) {
      const line = take.lines.find((entry) => entry.id === count.lineId)!;
      line.countedQuantity = count.countedQuantity;
      line.expectedQuantity = this.position(store.id, line.materialId).quantity;
      line.countedBy = this.deps.actor;
      line.countedAt = at;
    }
    this.contribute(take);
    take.batches.set(key, digest);
    take.version += 1;
    return this.takeReply(take, false);
  }

  takeCommand(takeId: string, action: StockTakeAction, body: unknown): Reply {
    const take = this.take(takeId);
    const store = this.state.stores.find((entry) => entry.id === take.storeId)!;
    const withReason = action === "return" || action === "cancel";
    const input = withReason
      ? this.deps.parse(stockTakeReasonRequestSchema, body)
      : { ...this.deps.parse(stockTakeVersionRequestSchema, body), reason: null };
    if (action === "submit") this.require(store.projectId, MANAGE);
    else if (action === "cancel") {
      if (!this.can(store.projectId, MANAGE)) this.require(store.projectId, APPROVE);
    } else this.require(store.projectId, APPROVE);
    const check = checkProcurementTransition(
      STOCK_TAKE_TRANSITIONS,
      take.status,
      action,
      input.reason,
    );
    if (!check.ok) this.fail(409, "invalid-transition");
    if (take.version !== input.version) this.fail(409, "version-conflict");
    const at = now();
    if (action === "submit") {
      if (take.lines.some((line) => line.countedQuantity === null))
        this.fail(409, "stock-take-incomplete");
      this.contribute(take);
      take.submittedAt = at;
      take.submittedBy = this.deps.actor;
      take.returnReason = null;
    } else if (action === "approve") {
      if (take.contributors.some((person) => person.id === this.deps.actor.id))
        this.fail(403, "maker-checker");
      const variances = take.lines
        .map((line) => ({
          line,
          variance: countVariance(line.expectedQuantity ?? "0", line.countedQuantity ?? "0"),
        }))
        .filter((entry) => nonZero(entry.variance));
      // Shortfalls are checked against the stock now before anything is posted (all or nothing).
      this.planOutflows(
        store.id,
        variances
          .filter((entry) => entry.variance.startsWith("-"))
          .map((entry) => ({
            materialId: entry.line.materialId,
            baseQuantity: entry.variance.slice(1),
          })),
      );
      for (const { line, variance } of variances) {
        const position = this.position(store.id, line.materialId);
        const source = { type: "stock_take" as const, id: take.id, number: take.number };
        if (variance.startsWith("-")) {
          const out = takeFromStock(position, variance.slice(1));
          if (!out.ok) this.fail(409, "insufficient-stock");
          line.adjustmentEntryId = post(this.state, {
            storeId: store.id,
            materialId: line.materialId,
            kind: "adjustment",
            quantity: variance,
            valueMinor: negateDecimal(out.valueMinor),
            unitCostMinor: out.unitCostMinor,
            source,
            sourceLineId: line.id,
            recordedAt: at,
            recordedBy: this.deps.actor,
            bqItemLineageId: null,
            gangId: null,
            reversesEntryId: null,
          }).id;
        } else {
          const cost = averageUnitCost(position) ?? "0";
          const inflow = receiveIntoStock(position, variance, cost);
          line.adjustmentEntryId = post(this.state, {
            storeId: store.id,
            materialId: line.materialId,
            kind: "adjustment",
            quantity: variance,
            valueMinor: inflow.valueMinor,
            unitCostMinor: cost,
            source,
            sourceLineId: line.id,
            recordedAt: at,
            recordedBy: this.deps.actor,
            bqItemLineageId: null,
            gangId: null,
            reversesEntryId: null,
          }).id;
        }
      }
      take.approvedAt = at;
      take.approvedBy = this.deps.actor;
    } else if (action === "return") {
      take.submittedAt = null;
      take.submittedBy = null;
      take.returnReason = input.reason;
    } else {
      take.cancelledAt = at;
      take.cancelledBy = this.deps.actor;
      take.cancelReason = input.reason;
    }
    take.status = check.to;
    take.version += 1;
    return this.takeReply(take, false);
  }

  takeDetail(takeId: string): Reply {
    return this.takeReply(this.take(takeId), false);
  }

  takes(query: URLSearchParams): Reply {
    const visible = this.visibleProjects();
    const storeId = query.get("storeId");
    const status = query.get("status");
    const limit = Number(query.get("limit") ?? 50);
    const cursor = query.get("cursor");
    const all = [...this.state.takes]
      .filter((take) => {
        const store = this.state.stores.find((entry) => entry.id === take.storeId)!;
        return (
          visible.includes(store.projectId) &&
          (!storeId || take.storeId === storeId) &&
          (!status || take.status === status)
        );
      })
      .reverse();
    const start = cursor ? all.findIndex((take) => take.id === cursor) + 1 : 0;
    const page = all.slice(start, start + limit);
    const hasMore = start + limit < all.length;
    return {
      body: {
        stockTakes: page.map((take) => without(this.takeWire(take), "lines")),
        page: { nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null, hasMore },
      },
      schema: stockTakesResponseSchema,
    };
  }

  // Settings --------------------------------------------------------------------------------

  settings(): Reply {
    return {
      body: {
        settings: {
          varianceThresholdPercent: this.state.settings.threshold,
          negativeStockAllowed: false,
          version: this.state.settings.version,
          updatedAt: this.state.settings.updatedAt,
        },
        permissions: { canEdit: this.deps.companyPermissions.includes("config.manage") },
      },
      schema: storesSettingsResponseSchema,
    };
  }

  updateSettings(body: unknown): Reply {
    if (!this.deps.companyPermissions.includes("config.manage")) this.fail(403, "forbidden");
    const input = this.deps.parse(updateStoresSettingsRequestSchema, body);
    if (input.version !== this.state.settings.version) this.fail(409, "version-conflict");
    this.state.settings = {
      threshold: Ratio.fromDecimal(input.varianceThresholdPercent).toDecimal(4).value,
      version: (this.state.settings.version ?? 0) + 1,
      updatedAt: now(),
    };
    return this.settings();
  }

  // Measurements ----------------------------------------------------------------------------

  /** D6.3 wire shape; review, photos and values live in mock-valuations (its own BQ fixture). */
  private measurementWire(measurement: MockMeasurement) {
    const corrected = this.state.measurements.some(
      (entry) => entry.correctsMeasurementId === measurement.id,
    );
    return {
      id: measurement.id,
      projectId: measurement.projectId,
      bqItem: this.item(measurement.lineageId)!,
      measuredOn: measurement.measuredOn,
      quantityToDate: measurement.quantityToDate,
      status: "recorded" as const,
      state: corrected ? ("withdrawn" as const) : ("pending" as const),
      basis: "quantity" as const,
      itemQuantity: null,
      itemAmountMinor: 0,
      valueMinor: 0,
      percentComplete: null,
      overMeasured: false,
      overMeasureReason: null,
      note: measurement.note,
      measuredBy: measurement.measuredBy,
      recordedAt: measurement.recordedAt,
      correctsMeasurementId: measurement.correctsMeasurementId,
      correctionReason: measurement.correctionReason,
      corrected,
      photos: [],
      review: null,
      permissions: {
        canApprove: false,
        canReject: false,
        canCorrect: !corrected,
        canAddPhotos: false,
      },
    };
  }

  measurements(projectId: string, query: URLSearchParams): Reply {
    const held = this.held(projectId);
    if (!held.has("projects.view")) this.fail(404, "not-found");
    const lineage = query.get("bqItemLineageId");
    return {
      body: {
        measurements: this.state.measurements
          .filter(
            (entry) => entry.projectId === projectId && (!lineage || entry.lineageId === lineage),
          )
          .map((entry) => this.measurementWire(entry)),
        permissions: {
          canRecord: this.can(projectId, "bq.edit") || this.can(projectId, "site.diary"),
          canApprove: this.can(projectId, "bq.edit"),
        },
      },
      schema: measurementsResponseSchema,
    };
  }

  measure(projectId: string, body: unknown): Reply {
    const held = this.held(projectId);
    if (!held.has("projects.view")) this.fail(404, "not-found");
    if (!held.has("bq.edit") && !held.has("site.diary")) this.fail(403, "forbidden");
    const input = this.deps.parse(createMeasurementRequestSchema, body);
    const item = this.state.items.find(
      (entry) => entry.lineageId === input.bqItemLineageId && entry.projectId === projectId,
    );
    if (!item) this.fail(404, "bq-item-not-found");
    if (input.measuredOn > nairobiDate()) this.fail(422, "measurement-future");
    if (
      input.correctsMeasurementId &&
      !this.state.measurements.some((entry) => entry.id === input.correctsMeasurementId)
    )
      this.fail(404, "measurement-not-found");
    const measurement: MockMeasurement = {
      id: id(),
      projectId,
      lineageId: item.lineageId,
      measuredOn: input.measuredOn,
      quantityToDate: Ratio.fromDecimal(input.quantityToDate).toDecimal(4).value,
      note: input.note ?? null,
      measuredBy: this.deps.actor,
      recordedAt: now(),
      correctsMeasurementId: input.correctsMeasurementId,
      correctionReason: input.correctionReason ?? null,
    };
    this.state.measurements.push(measurement);
    return {
      status: 201,
      body: { measurement: this.measurementWire(measurement), replayed: false },
      schema: measurementResponseSchema,
    };
  }

  // Build-up material mappings --------------------------------------------------------------

  private buildupVersion(buildupId: string, versionNo: number) {
    const buildup = this.deps.buildups.find((entry) => entry.id === buildupId);
    const version = buildup?.versions.find((entry) => entry.versionNo === versionNo);
    if (!buildup || !version) this.fail(404, "not-found");
    return { buildup, version };
  }

  private activeMapping(lineId: string) {
    return this.state.mappings.find((mapping) => mapping.lineId === lineId) ?? null;
  }

  buildupMaterials(buildupId: string, versionNo: number): Reply {
    if (!this.deps.somewhere().includes("bq.view")) this.fail(403, "forbidden");
    const { buildup, version } = this.buildupVersion(buildupId, versionNo);
    const current = buildup.versions.at(-1)!;
    return {
      body: {
        buildup: { id: buildup.id, code: buildup.code, name: current.name, unit: current.unit },
        versionNo: version.versionNo,
        lines: version.lines
          .map((line, index) => ({ line, lineNo: index + 1 }))
          .filter(({ line }) => line.kind === "material")
          .map(({ line, lineNo }) => {
            const lineId = buildupLineId(version.id, lineNo);
            const mapping = this.activeMapping(lineId);
            return {
              lineId,
              lineNo,
              resourceName: line.resourceName,
              unit: line.unit,
              quantity: line.quantity,
              wastePercent: line.wastePercent,
              mapping: mapping
                ? {
                    id: mapping.id,
                    material: this.materialRef(mapping.materialId),
                    unit: mapping.unit,
                    basePerUnit: mapping.basePerUnit,
                    basePerUnitDecimal: Ratio.parse(mapping.basePerUnit).toDecimal(6).value,
                    mappedAt: mapping.mappedAt,
                    mappedBy: mapping.mappedBy,
                  }
                : null,
            };
          }),
        permissions: { canMap: this.deps.somewhere().includes("bq.edit") },
      },
      schema: buildupMaterialsResponseSchema,
    };
  }

  map(buildupId: string, versionNo: number, lineId: string, method: string, body: unknown): Reply {
    if (!this.deps.somewhere().includes("bq.edit")) this.fail(403, "forbidden");
    const { version } = this.buildupVersion(buildupId, versionNo);
    const lineNo =
      version.lines.findIndex((_, index) => buildupLineId(version.id, index + 1) === lineId) + 1;
    if (!lineNo) this.fail(404, "not-found");
    if (version.lines[lineNo - 1]!.kind !== "material") this.fail(409, "buildup-line-not-material");
    this.state.mappings = this.state.mappings.filter((mapping) => mapping.lineId !== lineId);
    if (method === "PUT") {
      const input = this.deps.parse(buildupMaterialMappingRequestSchema, body);
      const material = this.material(input.materialId);
      const converted = convertQuantity(
        "1",
        input.unit,
        material.baseUnit,
        conversionContext(this.deps.catalogue, material, null, nairobiDate()),
      );
      if (!converted.ok || converted.ratio.isZero()) this.fail(422, "no-conversion");
      this.state.mappings.push({
        id: id(),
        lineId,
        materialId: material.id,
        unit: input.unit,
        basePerUnit: converted.ratio.toString(),
        mappedAt: now(),
        mappedBy: this.deps.actor,
      });
    }
    return this.buildupMaterials(buildupId, versionNo);
  }

  // Consumption variance --------------------------------------------------------------------

  variance(query: URLSearchParams): Reply {
    const projectFilter = query.get("projectId");
    const stateFilter = query.get("state");
    const threshold = this.state.settings.threshold;
    const rows = this.visibleProjects(projectFilter).flatMap((projectId) =>
      this.projectVariance(projectId, threshold),
    );
    return {
      body: {
        thresholdPercent: threshold,
        generatedOn: nairobiDate(),
        rows: stateFilter ? rows.filter((row) => row.state === stateFilter) : rows,
        counts: {
          alert: rows.filter((row) => row.state === "alert").length,
          within: rows.filter((row) => row.state === "within").length,
          unavailable: rows.filter((row) => UNAVAILABLE.includes(row.state)).length,
        },
      },
      schema: varianceResponseSchema,
    };
  }

  private projectVariance(projectId: string, threshold: string): VarianceRow[] {
    const project = this.project(projectId);
    const projectRef = { id: project.id, code: project.code, name: project.name };
    const canMeasure = this.can(projectId, "bq.edit");
    const storeIds = this.state.stores
      .filter((store) => store.projectId === projectId)
      .map((store) => store.id);
    const consumed = this.state.entries.filter(
      (entry) =>
        storeIds.includes(entry.storeId) &&
        entry.bqItemLineageId !== null &&
        (entry.kind === "issue" || entry.kind === "return"),
    );
    const items = this.state.items.filter(
      (item) =>
        item.projectId === projectId &&
        (item.buildup !== null ||
          consumed.some((entry) => entry.bqItemLineageId === item.lineageId)),
    );
    const rows: VarianceRow[] = [];
    for (const item of items) {
      const bqItem = this.item(item.lineageId)!;
      const usage = new Map<string, { issued: string; returned: string }>();
      for (const entry of consumed.filter(
        (candidate) => candidate.bqItemLineageId === item.lineageId,
      )) {
        const current = usage.get(entry.materialId) ?? { issued: "0", returned: "0" };
        if (entry.kind === "issue")
          current.issued = sumDecimals([current.issued, negateDecimal(entry.quantity)]);
        else current.returned = sumDecimals([current.returned, entry.quantity]);
        usage.set(entry.materialId, current);
      }
      const latest = this.state.measurements
        .filter(
          (entry) =>
            entry.lineageId === item.lineageId &&
            !this.state.measurements.some((other) => other.correctsMeasurementId === entry.id),
        )
        .sort(
          (left, right) =>
            right.measuredOn.localeCompare(left.measuredOn) ||
            right.recordedAt.localeCompare(left.recordedAt),
        )[0];
      const measured = latest
        ? {
            id: latest.id,
            quantityToDate: latest.quantityToDate,
            measuredOn: latest.measuredOn,
            measuredBy: latest.measuredBy,
          }
        : null;
      const base = (material: VarianceRow["material"], used = { issued: "0", returned: "0" }) => ({
        project: projectRef,
        bqItem,
        material,
        measurement: measured,
        issuedQuantity: used.issued,
        returnedQuantity: used.returned,
        actualQuantity: sumDecimals([used.issued, negateDecimal(used.returned)]),
        canMeasure,
      });
      const empty = {
        buildup: null,
        mapping: null,
        theoreticalQuantity: null,
        limitQuantity: null,
        varianceQuantity: null,
        variancePercent: null,
      };
      const found = item.buildup
        ? this.deps.buildups.find((entry) => entry.id === item.buildup!.id)
        : undefined;
      const version = found?.versions.find((entry) => entry.versionNo === item.buildup?.versionNo);
      if (!found || !version) {
        for (const [materialId, used] of usage)
          rows.push({
            ...base(this.materialRef(materialId), used),
            ...empty,
            state: "no_buildup",
          });
        continue;
      }
      const lines = version.lines
        .map((line, index) => ({ line, lineNo: index + 1 }))
        .filter(({ line }) => line.kind === "material");
      const grouped = new Map<
        string,
        { lineNo: number; line: (typeof lines)[number]["line"]; mapping: MockMapping }[]
      >();
      const describe = (entry: (typeof lines)[number]) => ({
        id: found.id,
        code: found.code,
        versionNo: version.versionNo,
        lineNo: entry.lineNo,
        resourceName: entry.line.resourceName,
        unit: entry.line.unit,
        quantityPerUnit: entry.line.quantity,
        wastePercent: entry.line.wastePercent,
      });
      for (const entry of lines) {
        const mapping = this.activeMapping(buildupLineId(version.id, entry.lineNo));
        if (!mapping) {
          rows.push({ ...base(null), ...empty, buildup: describe(entry), state: "not_mapped" });
          continue;
        }
        const group = grouped.get(mapping.materialId) ?? [];
        group.push({ ...entry, mapping });
        grouped.set(mapping.materialId, group);
      }
      for (const [materialId, group] of grouped) {
        const first = group[0]!;
        const row = base(this.materialRef(materialId), usage.get(materialId));
        const mappingWire = {
          unit: first.mapping.unit,
          basePerUnit: first.mapping.basePerUnit,
          basePerUnitDecimal: Ratio.parse(first.mapping.basePerUnit).toDecimal(6).value,
        };
        if (!measured) {
          rows.push({
            ...row,
            ...empty,
            buildup: describe(first),
            mapping: mappingWire,
            state: "no_measurement",
          });
          continue;
        }
        const theoretical = sumDecimals(
          group.map((entry) =>
            theoreticalConsumption({
              measuredQuantity: measured.quantityToDate,
              quantityPerUnit: entry.line.quantity,
              wastePercent: entry.line.wastePercent,
              basePerUnit: Ratio.parse(entry.mapping.basePerUnit),
            }),
          ),
        );
        const result = consumptionVariance({
          theoretical,
          issued: row.issuedQuantity,
          returned: row.returnedQuantity,
          thresholdPercent: threshold,
        });
        rows.push({
          ...row,
          buildup: describe(first),
          mapping: mappingWire,
          theoreticalQuantity: theoretical,
          limitQuantity: result.limit,
          varianceQuantity: result.variance,
          variancePercent: result.variancePercent,
          state: result.state,
        });
      }
      for (const [materialId, used] of usage) {
        if (grouped.has(materialId)) continue;
        rows.push({
          ...base(this.materialRef(materialId), used),
          ...empty,
          state: "not_in_buildup",
        });
      }
    }
    const order: Record<VarianceState, number> = {
      alert: 0,
      not_in_buildup: 1,
      no_progress: 2,
      within: 3,
      no_measurement: 4,
      not_mapped: 5,
      no_buildup: 6,
    };
    return rows.sort(
      (left, right) =>
        order[left.state] - order[right.state] ||
        (left.bqItem.ref ?? "").localeCompare(right.bqItem.ref ?? ""),
    );
  }
}

/** Routes the stores endpoints; null when the path is not a stores path. */
export function handleStores(
  deps: StoresDeps,
  state: StoresState,
  method: string,
  path: string,
  query: URLSearchParams,
  body: unknown,
): Reply | null {
  const stores = new Stores(deps, state);
  const mapping = /^\/rate-buildups\/([^/]+)\/versions\/(\d+)\/materials(?:\/([^/]+))?$/.exec(path);
  if (mapping) {
    const [, buildupId, versionNo, lineId] = mapping;
    if (!lineId && method === "GET") return stores.buildupMaterials(buildupId!, Number(versionNo));
    if (lineId && (method === "PUT" || method === "DELETE"))
      return stores.map(buildupId!, Number(versionNo), lineId, method, body);
    return null;
  }
  const measurements = /^\/projects\/([^/]+)\/measurements$/.exec(path);
  if (measurements) {
    if (method === "GET") return stores.measurements(measurements[1]!, query);
    if (method === "POST") return stores.measure(measurements[1]!, body);
    return null;
  }
  if (path === "/stores") {
    if (method === "GET") return stores.list();
    if (method === "POST") return stores.create(body);
    return null;
  }
  if (path === "/stores/settings") {
    if (method === "GET") return stores.settings();
    if (method === "PUT") return stores.updateSettings(body);
    return null;
  }
  if (path === "/stores/variance" && method === "GET") return stores.variance(query);
  const store =
    /^\/stores\/([^/]+)(?:\/(ledger|reorder-levels|issue-options|transfer-targets))?$/.exec(path);
  if (store) {
    const [, storeId, sub] = store;
    if (!sub && method === "GET") return stores.detail(storeId!);
    if (sub === "ledger" && method === "GET") return stores.ledger(storeId!, query);
    if (sub === "reorder-levels" && method === "PUT") return stores.reorderLevels(storeId!, body);
    if (sub === "issue-options" && method === "GET") return stores.issueOptions(storeId!, query);
    if (sub === "transfer-targets" && method === "GET") return stores.transferTargets(storeId!);
    return null;
  }
  if (path === "/stock-movements" && method === "GET") return stores.movements(query);
  if (path === "/stock-movements/issues" && method === "POST")
    return stores.createOutflow("issue", body);
  if (path === "/stock-movements/wastage" && method === "POST")
    return stores.createOutflow("wastage", body);
  if (path === "/stock-movements/returns" && method === "POST") return stores.createReturn(body);
  const movement = /^\/stock-movements\/([^/]+)(\/reverse)?$/.exec(path);
  if (movement) {
    if (!movement[2] && method === "GET") return stores.movementDetail(movement[1]!);
    if (movement[2] && method === "POST") return stores.reverse(movement[1]!, body);
    return null;
  }
  if (path === "/stock-transfers") {
    if (method === "GET") return stores.transfers(query);
    if (method === "POST") return stores.dispatch(body);
    return null;
  }
  const transfer = /^\/stock-transfers\/([^/]+)(?:\/(receive|resolve|cancel))?$/.exec(path);
  if (transfer) {
    const [, transferId, action] = transfer;
    if (!action && method === "GET") return stores.transferDetail(transferId!);
    if (action === "receive" && method === "POST") return stores.receive(transferId!, body);
    if ((action === "resolve" || action === "cancel") && method === "POST")
      return stores.decide(transferId!, action, body);
    return null;
  }
  if (path === "/stock-takes") {
    if (method === "GET") return stores.takes(query);
    if (method === "POST") return stores.startTake(body);
    return null;
  }
  const take = /^\/stock-takes\/([^/]+)(?:\/(counts|submit|approve|return|cancel))?$/.exec(path);
  if (take) {
    const [, takeId, action] = take;
    if (!action && method === "GET") return stores.takeDetail(takeId!);
    if (action === "counts" && method === "POST") return stores.counts(takeId!, body);
    if (action && action !== "counts" && method === "POST")
      return stores.takeCommand(takeId!, action as StockTakeAction, body);
    return null;
  }
  return null;
}
