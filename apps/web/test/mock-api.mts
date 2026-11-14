/**
 * A small stateful stand-in for the PM-Buddy API, used only by the Playwright suite. The web
 * server renders live pages on the server (API_INTERNAL_URL), where Playwright cannot intercept
 * requests, so this server answers both those server-side calls and the browser's same-origin
 * /api calls that the Next.js rewrite forwards here.
 *
 * Each test signs in with its own `pmb_at=<persona>.<id>` cookie and gets its own copy of the
 * fixture data; cookies with the same <id> share that copy, so a test can switch between the
 * owner, the project manager and the site agent on the same data (the client, labourer and
 * supplier personas have their own). Requests are validated with the shared request schemas and every response is
 * validated with the shared response schema before it is sent, so the suite also checks the wire
 * contract. Synthetic data only.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import {
  activationGaps,
  checkMilestoneTransition,
  checkProjectTransition,
  geofenceMetrics,
  nairobiDate,
  normalizeKenyanPhone,
  wbsWeightGroups,
  wbsWeightsComplete,
  type Geofence,
} from "@pm-buddy/domain";
import {
  isProjectPermission,
  PROJECT_ASSIGNABLE_PERMISSIONS,
  PROJECT_PERMISSIONS,
  SAFETY_READ_PERMISSIONS,
  SYSTEM_ROLE_PERMISSIONS,
  TENANT_PERMISSIONS,
  type Permission,
} from "@pm-buddy/types";
import {
  authProvidersResponseSchema,
  authResponseSchema,
  changeGeofenceRequestSchema,
  createMilestoneRequestSchema,
  createProjectRequestSchema,
  createSiteRequestSchema,
  createWbsNodeRequestSchema,
  csrfResponseSchema,
  geofenceHistoryResponseSchema,
  invitationResponseSchema,
  messageResponseSchema,
  milestoneResponseSchema,
  milestonesResponseSchema,
  milestoneStatusRequestSchema,
  projectAssignmentRequestSchema,
  projectDetailResponseSchema,
  projectResponseSchema,
  projectsResponseSchema,
  projectStatusRequestSchema,
  projectTeamResponseSchema,
  reorderWbsRequestSchema,
  siteResponseSchema,
  sitesResponseSchema,
  tenantsResponseSchema,
  updateMilestoneRequestSchema,
  updateProjectRequestSchema,
  updateSiteRequestSchema,
  updateWbsNodeRequestSchema,
  wbsNodeResponseSchema,
  wbsResponseSchema,
  type GeofenceVersion,
  type Milestone,
  type Project,
  type ProjectStatusChange,
  type Site,
  type SiteDiary,
  type SitePhoto,
  type WbsNode,
} from "@pm-buddy/validation";
import { handleBq, initialProjectBq, type BqState } from "./mock-bq.mts";
import { handleBuildups, initialBuildups } from "./mock-buildups.mts";
import {
  handleProcurement,
  initialProcurement,
  type ProcurementState,
} from "./mock-procurement.mts";
import { attendanceFixture, handleAttendance, type AttendanceState } from "./mock-attendance.mts";
import { handleLabour, labourFixture, type LabourState } from "./mock-labour.mts";
import { handleDiaries, initialDiaries } from "./mock-diaries.mts";
import { handlePortalPersona, isPortalPersona } from "./mock-portals.mts";
import { handlePhotos, initialPhotos } from "./mock-photos.mts";
import { latestApproved } from "./mock-bq-model.mts";
import { handleP2p, initialP2p, p2pDocument, type P2pDeps, type P2pState } from "./mock-p2p.mts";
import {
  handleSupplierPersona,
  handleSupplierPortalUsers,
  initialSupplierPortalUsers,
  isSupplierPersona,
  supplierPortalFile,
  type SupplierPortalStaffState,
} from "./mock-supplier-portal.mts";
import { handleStores, initialStores, type StoresState } from "./mock-stores.mts";
import {
  handleSpending,
  initialSpending,
  spendingReceipt,
  type SpendingState,
} from "./mock-spending.mts";
import { handleSchedule, initialSchedule, type ScheduleState } from "./mock-schedule.mts";
import { handleQuality, initialQuality, type QualityState } from "./mock-quality.mts";
import {
  handleValuations,
  initialValuations,
  valuationExport,
  type ValuationsState,
} from "./mock-valuations.mts";
import { handleSafety, initialSafety, type SafetyState } from "./mock-safety.mts";
import { handlePlant, initialPlant, type PlantState } from "./mock-plant.mts";
import {
  documentDownload,
  handleDocuments,
  initialDocuments,
  type DocumentsDeps,
  type DocumentsState,
} from "./mock-documents.mts";

export const MOCK_CSRF = "mock-csrf-token";
export const MOCK_STEP_UP_CODE = "246810";
export const RUIRU_ID = "30000000-0000-4000-8000-000000000001";
export const SYOKIMAU_ID = "30000000-0000-4000-8000-000000000002";
export const MAIN_PLOT_ID = "31000000-0000-4000-8000-000000000001";
const TENANT_ID = "20000000-0000-4000-8000-000000000001";
const OWNER_ID = "21000000-0000-4000-8000-000000000001";
const PM_ID = "21000000-0000-4000-8000-000000000002";
const AGENT_ID = "21000000-0000-4000-8000-000000000003";
const QS_ID = "21000000-0000-4000-8000-000000000004";
const FINANCE_ID = "21000000-0000-4000-8000-000000000005";
const NOW = "2026-11-10T07:45:00.000Z";

type Persona = "owner" | "agent" | "pm" | "finance";
const PERSONAS: Record<
  Persona,
  {
    id: string;
    identifier: string;
    displayName: string;
    role: "owner" | "site_agent" | "project_manager" | "finance";
    mfa: boolean;
  }
> = {
  owner: {
    id: OWNER_ID,
    identifier: "owner@jenga-bora.example.test",
    displayName: "Wanjiru Kamau",
    role: "owner",
    mfa: true,
  },
  agent: {
    id: AGENT_ID,
    identifier: "site.agent@jenga-bora.example.test",
    displayName: "Kevin Kiprono",
    role: "site_agent",
    mfa: false,
  },
  pm: {
    id: PM_ID,
    identifier: "pm@jenga-bora.example.test",
    displayName: "Brian Otieno",
    role: "project_manager",
    mfa: true,
  },
  finance: {
    id: FINANCE_ID,
    identifier: "finance@jenga-bora.example.test",
    displayName: "Daniel Mwangi",
    role: "finance",
    mfa: true,
  },
};
/** Company-wide memberships (the others are limited to their project assignments). */
const isTenantWide = (persona: Persona) => persona === "owner" || persona === "finance";
type TeamEntry = {
  userId: string;
  displayName: string;
  role: "owner" | "project_manager" | "site_agent" | "quantity_surveyor";
  assignment: Permission[] | null;
};
type ProjectState = {
  project: Project;
  history: ProjectStatusChange[];
  sites: { site: Omit<Site, "geofence">; versions: GeofenceVersion[] }[];
  wbs: WbsNode[];
  milestones: Milestone[];
};
type State = {
  persona: Persona;
  /** When each persona last completed a step-up (each has its own session). */
  stepUpAt: Map<Persona, number>;
  projects: ProjectState[];
  team: Map<string, TeamEntry[]>;
  bq: BqState;
  procurement: ProcurementState;
  /** D5.2 procure-to-pay records (mock-p2p.mts). */
  p2p: P2pState;
  /** D5.3 stores, ledger, transfers, stock takes and variance (mock-stores.mts). */
  stores: StoresState;
  /** D5.4 budgets, cost ledger, petty cash, forecast and alerts (mock-spending.mts). */
  spending: SpendingState;
  labour: LabourState;
  attendance: AttendanceState;
  diaries: SiteDiary[];
  photos: SitePhoto[];
  /** D6.2 schedules by project (mock-schedule.mts). */
  schedule: ScheduleState;
  /** D6.1 quality: templates, inspections, tests, snags, completion (mock-quality.mts). */
  quality: QualityState;
  /** D6.3 measurements, valuations, certificates and earned value (mock-valuations.mts). */
  valuations: ValuationsState;
  /** D8.2 health and safety (mock-safety.mts). */
  safety: SafetyState;
  /** D7.2 each supplier's portal users (mock-supplier-portal.mts). */
  supplierPortal: SupplierPortalStaffState;
  /** D8.3 plant and equipment (mock-plant.mts). */
  plant: PlantState;
  /** D8.4 documents, compliance, instructions and approvals (mock-documents.mts). */
  documents: DocumentsState;
};

const states = new Map<string, State>();
const id = () => randomUUID();
const at = (east: number, north: number) => ({
  lat: Math.round((-1.1489 + north / 111_195) * 1e6) / 1e6,
  lng: Math.round((36.9612 + east / 111_173) * 1e6) / 1e6,
});

function version(number: number, geofence: Geofence, effectiveFrom = NOW): GeofenceVersion {
  const metrics = geofenceMetrics(geofence);
  return {
    id: id(),
    version: number,
    effectiveFrom,
    areaM2: Math.round(metrics.areaM2 * 10) / 10,
    perimeterM: Math.round(metrics.perimeterM * 10) / 10,
    geofence:
      geofence.kind === "radius"
        ? { ...geofence }
        : { kind: "polygon", vertices: [...geofence.vertices] },
  };
}

function baseProject(fields: Partial<Project> & Pick<Project, "id" | "code" | "name">): Project {
  return {
    description: null,
    clientName: null,
    clientEmail: null,
    clientPhone: null,
    contractSumMinor: null,
    currency: "KES",
    contractType: null,
    startDate: null,
    endDate: null,
    county: null,
    town: null,
    latitude: null,
    longitude: null,
    status: "planning",
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...fields,
  };
}

function node(
  code: string,
  name: string,
  weight: number,
  parentId: string | null,
  sortOrder: number,
): WbsNode {
  return {
    id: id(),
    parentId,
    code,
    name,
    sortOrder,
    weightBasisPoints: weight,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function fixture(persona: Persona): State {
  const superstructure = node("3", "Superstructure", 4_500, null, 2);
  const wbs = [
    node("1", "Preliminaries", 1_000, null, 0),
    node("2", "Substructure", 2_000, null, 1),
    superstructure,
    node("3.1", "Ground floor", 5_000, superstructure.id, 0),
    node("3.2", "First floor", 5_000, superstructure.id, 1),
    node("4", "Finishes", 2_500, null, 3),
  ];
  const plot: Geofence = {
    kind: "polygon",
    vertices: [at(0, 0), at(60, 0), at(70, 20), at(60, 45), at(0, 45)],
  };
  const ruiru: ProjectState = {
    project: baseProject({
      id: RUIRU_ID,
      code: "RUI-HTS",
      name: "Ruiru Heights Apartments",
      description: "4-storey apartment block, 16 units",
      clientName: "Mavuno Homes Ltd",
      clientEmail: "projects@mavuno-homes.example.test",
      contractSumMinor: 8_640_000_000,
      contractType: "lump_sum",
      startDate: "2026-03-02",
      endDate: "2027-04-30",
      county: "kiambu",
      town: "Ruiru",
      latitude: -1.1489,
      longitude: 36.9612,
      status: "active",
      version: 2,
    }),
    history: [
      {
        from: "planning",
        to: "active",
        reason: "Contract signed and site handed over",
        changedAt: NOW,
        changedBy: { id: OWNER_ID, displayName: "Wanjiru Kamau" },
      },
    ],
    sites: [
      {
        site: {
          id: MAIN_PLOT_ID,
          name: "Main plot",
          address: "Off Kamiti Road",
          version: 1,
          createdAt: NOW,
          updatedAt: NOW,
        },
        versions: [
          version(2, plot, "2026-11-01T06:00:00.000Z"),
          version(
            1,
            { kind: "radius", center: at(30, 20), radiusM: 80 },
            "2026-03-01T06:00:00.000Z",
          ),
        ],
      },
      {
        site: {
          id: id(),
          name: "Materials yard",
          address: null,
          version: 1,
          createdAt: NOW,
          updatedAt: NOW,
        },
        versions: [version(1, { kind: "radius", center: at(30, -40), radiusM: 40 })],
      },
    ],
    wbs,
    milestones: [
      {
        id: id(),
        wbsNodeId: wbs[1]!.id,
        name: "Substructure complete",
        dueDate: "2026-06-15",
        status: "achieved",
        actualDate: "2026-06-26",
        statusReason: null,
        version: 2,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: id(),
        wbsNodeId: superstructure.id,
        name: "Roof covered",
        dueDate: "2027-01-31",
        status: "planned",
        actualDate: null,
        statusReason: null,
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  };
  const syokimau: ProjectState = {
    project: baseProject({
      id: SYOKIMAU_ID,
      code: "SYO-TWN",
      name: "Syokimau Townhouses",
      clientName: "Kilima Developers Ltd",
      county: "machakos",
      town: "Syokimau",
    }),
    history: [],
    sites: [],
    wbs: [],
    milestones: [],
  };
  const labour = labourFixture();
  const pmAssignment = PROJECT_ASSIGNABLE_PERMISSIONS.filter((key) =>
    SYSTEM_ROLE_PERMISSIONS.project_manager.includes(key),
  );
  const procurement = initialProcurement();
  const bq: BqState = {
    projects: new Map([
      [RUIRU_ID, initialProjectBq(true, ruiru.project.contractSumMinor)],
      [SYOKIMAU_ID, initialProjectBq(false, null)],
    ]),
    templates: [],
    buildups: initialBuildups(),
  };
  const projects = [ruiru, syokimau];
  const photos = initialPhotos(RUIRU_ID, MAIN_PLOT_ID);
  return {
    persona,
    stepUpAt: new Map(),
    schedule: new Map([
      [
        RUIRU_ID,
        initialSchedule(
          {
            id: RUIRU_ID,
            status: ruiru.project.status,
            startDate: ruiru.project.startDate,
          },
          ruiru.milestones,
          wbs,
          { id: OWNER_ID, displayName: "Wanjiru Kamau" },
        ),
      ],
    ]),
    diaries: initialDiaries(RUIRU_ID, MAIN_PLOT_ID, OWNER_ID, AGENT_ID),
    quality: initialQuality(
      { projectId: RUIRU_ID, siteId: MAIN_PLOT_ID },
      {
        owner: { id: OWNER_ID, displayName: "Wanjiru Kamau" },
        pm: { id: PM_ID, displayName: "Brian Otieno" },
        agent: { id: AGENT_ID, displayName: "Kevin Kiprono" },
      },
    ),
    safety: initialSafety(
      { projectId: RUIRU_ID, siteId: MAIN_PLOT_ID },
      {
        owner: { id: OWNER_ID, displayName: "Wanjiru Kamau" },
        pm: { id: PM_ID, displayName: "Brian Otieno" },
        agent: { id: AGENT_ID, displayName: "Kevin Kiprono" },
      },
      labour.labourers.map(({ id: labourerId, workerNo, fullName }) => ({
        id: labourerId,
        workerNo,
        fullName,
      })),
    ),
    plant: initialPlant(
      { projectId: RUIRU_ID, siteId: MAIN_PLOT_ID },
      {
        id: procurement.suppliers[0]!.supplier.id,
        name:
          procurement.suppliers[0]!.supplier.tradingName ??
          procurement.suppliers[0]!.supplier.legalName,
      },
      {
        owner: { id: OWNER_ID, displayName: "Wanjiru Kamau" },
        agent: { id: AGENT_ID, displayName: "Kevin Kiprono" },
      },
    ),
    documents: initialDocuments(RUIRU_ID, {
      owner: { id: OWNER_ID, displayName: "Wanjiru Kamau" },
      pm: { id: PM_ID, displayName: "Brian Otieno" },
      agent: { id: AGENT_ID, displayName: "Kevin Kiprono" },
    }),
    photos,
    valuations: initialValuations(RUIRU_ID, [photos[0]!.id]),
    bq,
    procurement,
    p2p: initialP2p(p2pBase(projects, procurement, bq)),
    stores: initialStores(procurement, bq.buildups),
    spending: initialSpending(projectInfo(projects)),
    supplierPortal: initialSupplierPortalUsers(),
    projects,
    labour,
    attendance: attendanceFixture(ruiru.sites[1]!.site.id, labour),
    team: new Map([
      [
        RUIRU_ID,
        [
          { userId: OWNER_ID, displayName: "Wanjiru Kamau", role: "owner", assignment: null },
          {
            userId: PM_ID,
            displayName: "Brian Otieno",
            role: "project_manager",
            assignment: pmAssignment,
          },
          {
            userId: AGENT_ID,
            displayName: "Kevin Kiprono",
            role: "site_agent",
            assignment: ["projects.view", "site.diary", "site.photos", "bq.view"],
          },
          {
            userId: QS_ID,
            displayName: "Faith Achieng",
            role: "quantity_surveyor",
            assignment: [],
          },
        ],
      ],
      [
        SYOKIMAU_ID,
        [
          { userId: OWNER_ID, displayName: "Wanjiru Kamau", role: "owner", assignment: null },
          { userId: PM_ID, displayName: "Brian Otieno", role: "project_manager", assignment: [] },
          { userId: AGENT_ID, displayName: "Kevin Kiprono", role: "site_agent", assignment: [] },
          {
            userId: QS_ID,
            displayName: "Faith Achieng",
            role: "quantity_surveyor",
            assignment: [],
          },
        ],
      ],
    ]),
  };
}

/** What the procure-to-pay mock needs from the rest of the fixture (projects, catalogue, BQ). */
function p2pBase(
  projects: ProjectState[],
  procurement: ProcurementState,
  bq: BqState,
): Omit<P2pDeps, "persona"> {
  return {
    fail: (status, code) => new HttpError(status, code),
    parse,
    requireStepUp: () => undefined,
    projects: projects.map(({ project, sites }) => ({
      id: project.id,
      code: project.code,
      name: project.name,
      status: project.status,
      sites: sites.map(({ site, versions }) => ({
        id: site.id,
        name: site.name,
        geofence: versions[0]?.geofence ?? null,
        geofenceVersion: versions[0]?.version ?? null,
      })),
    })),
    catalogue: procurement,
    // The fixture is seeded as if the agent could raise requisitions on Ruiru Heights.
    projectPermissions: (projectId) => (projectId === RUIRU_ID ? PROJECT_PERMISSIONS : []),
    bqItem: (projectId, lineageId) => {
      const entry = bq.projects.get(projectId);
      const version = entry ? latestApproved(entry) : null;
      const item = version?.content.items.find((candidate) => candidate.lineageId === lineageId);
      return version && item
        ? { versionId: version.id, lineageId, ref: item.ref, description: item.description }
        : null;
    },
    idempotencyKey: undefined,
    contentType: undefined,
    raw: Buffer.alloc(0),
  };
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  /** RFC 9457 extension naming an existing record (labour duplicate and do-not-rehire matches). */
  readonly match: Record<string, string> | undefined;
  constructor(status: number, code: string, match?: Record<string, string>) {
    super(code);
    this.status = status;
    this.code = code;
    this.match = match;
  }
}

const cookie = (req: IncomingMessage, name: string) =>
  (req.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);

function stateFor(req: IncomingMessage): State {
  const token = cookie(req, "pmb_at");
  const [name, session] = token?.split(".") ?? [];
  if (!token || !session || !name || !Object.hasOwn(PERSONAS, name))
    throw new HttpError(401, "unauthorized");
  const persona = name as Persona;
  let state = states.get(session);
  if (!state) {
    state = fixture(persona);
    states.set(session, state);
  }
  state.persona = persona;
  return state;
}

const ownerAccount = (state: State) => {
  const user = PERSONAS[state.persona];
  return {
    user: {
      id: user.id,
      identifier: user.identifier,
      displayName: user.displayName,
      verified: true,
      mfaEnabled: user.mfa,
      totpEnabled: user.mfa,
      passkeys: 0,
    },
    session: {
      id: "22000000-0000-4000-8000-000000000001",
      tenantId: TENANT_ID,
      mfaVerified: user.mfa,
      expiresAt: "2026-11-11T07:45:00.000Z",
    },
    mfaRequired: false,
  };
};

const rolePermissions = (state: State): readonly Permission[] =>
  state.persona === "owner"
    ? TENANT_PERMISSIONS
    : SYSTEM_ROLE_PERMISSIONS[PERSONAS[state.persona].role];

function projectPermissions(state: State, entry: ProjectState): Permission[] {
  if (state.persona === "owner") return [...PROJECT_PERMISSIONS];
  const user = PERSONAS[state.persona];
  const assignment =
    state.team.get(entry.project.id)?.find((member) => member.userId === user.id)?.assignment ?? [];
  return SYSTEM_ROLE_PERMISSIONS[user.role].filter((key) => assignment.includes(key));
}

/** Company-wide members (owner, finance) hold their role on every project, as in the API. */
function valuationPermissions(state: State, projectId: string): readonly Permission[] {
  const entry = state.projects.find((candidate) => candidate.project.id === projectId);
  if (!entry) return [];
  return isTenantWide(state.persona) ? rolePermissions(state) : projectPermissions(state, entry);
}

/** Projects with the caller's permissions and photos, as the documents mock sees them. */
function documentsDeps(state: State): DocumentsDeps {
  return {
    projects: state.projects.map((entry) => ({
      id: entry.project.id,
      code: entry.project.code,
      name: entry.project.name,
      status: entry.project.status,
      permissions: valuationPermissions(state, entry.project.id),
    })),
    companyPermissions: rolePermissions(state),
    actor: { id: PERSONAS[state.persona].id, displayName: PERSONAS[state.persona].displayName },
    photos: (projectId) =>
      state.photos
        .filter((photo) => photo.projectId === projectId)
        .map((photo) => ({
          id: photo.id,
          caption: photo.caption,
          verified: photo.verified,
          capturedAt: photo.capturedAt,
        })),
    fail: (status: number, code: string) => new HttpError(status, code),
    parse,
  };
}

/** Projects with their sites, as the spending and stores mocks see them. */
function projectInfo(projects: ProjectState[]) {
  return projects.map(({ project, sites }) => ({
    id: project.id,
    code: project.code,
    name: project.name,
    status: project.status,
    sites: sites.map(({ site }) => ({ id: site.id, name: site.name })),
  }));
}

function find(state: State, projectId: string, permission: Permission): ProjectState {
  const entry = state.projects.find((candidate) => candidate.project.id === projectId);
  if (!entry) throw new HttpError(404, "not-found");
  if (!projectPermissions(state, entry).includes(permission)) throw new HttpError(403, "forbidden");
  return entry;
}

function editable(state: State, projectId: string): ProjectState {
  const entry = find(state, projectId, "projects.manage");
  if (entry.project.status === "closed" || entry.project.status === "cancelled")
    throw new HttpError(409, "project-read-only");
  return entry;
}

function requireStepUp(state: State) {
  if (Date.now() - (state.stepUpAt.get(state.persona) ?? 0) > 5 * 60_000)
    throw new HttpError(403, "step-up-required");
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new HttpError(400, "validation-error");
  return result.data;
}

const touch = <T extends { version: number; updatedAt: string }>(
  record: T,
  expected: number,
): T => {
  if (record.version !== expected) throw new HttpError(409, "version-conflict");
  record.version += 1;
  record.updatedAt = new Date().toISOString();
  return record;
};

const currentSite = (entry: ProjectState["sites"][number]): Site => ({
  ...entry.site,
  geofence: entry.versions[0]!,
});

function detail(state: State, entry: ProjectState) {
  const project = entry.project;
  return {
    project,
    permissions: projectPermissions(state, entry),
    siteCount: entry.sites.length,
    activationGaps:
      project.status === "planning"
        ? activationGaps({ ...project, geofencedSites: entry.sites.length })
        : [],
    history: [...entry.history].reverse(),
  };
}

function wbsView(entry: ProjectState) {
  const weights = entry.wbs.map(({ id: nodeId, parentId, weightBasisPoints }) => ({
    id: nodeId,
    parentId,
    weightBasisPoints,
  }));
  return {
    nodes: entry.wbs,
    weights: {
      complete: wbsWeightsComplete(weights),
      groups: wbsWeightGroups(weights).map(({ parentId, sumBasisPoints, complete }) => ({
        parentId,
        sumBasisPoints,
        complete,
      })),
    },
    progress: null,
  };
}

function teamView(state: State, entry: ProjectState) {
  const members = state.team.get(entry.project.id) ?? [];
  const canAssign = state.persona === "owner";
  const effective = (member: TeamEntry) => {
    const scoped = SYSTEM_ROLE_PERMISSIONS[member.role].filter(isProjectPermission);
    return member.role === "owner"
      ? scoped
      : scoped.filter((key) => member.assignment?.includes(key));
  };
  return {
    members: members
      .filter((member) => member.role === "owner" || (member.assignment?.length ?? 0) > 0)
      .map((member) => ({
        userId: member.userId,
        displayName: member.displayName,
        role: member.role,
        roleName: null,
        companyWide: member.role === "owner",
        assignment: member.role === "owner" ? null : member.assignment,
        effective: effective(member),
      })),
    candidates: canAssign
      ? members
          .filter((member) => member.role !== "owner" && !(member.assignment?.length ?? 0))
          .map(({ userId, displayName, role }) => ({ userId, displayName, role, roleName: null }))
      : [],
    canAssign,
    grantable: canAssign ? [...PROJECT_ASSIGNABLE_PERMISSIONS] : [],
  };
}

type Reply = { status?: number; body: unknown; schema: z.ZodType<unknown> };

async function handle(
  method: string,
  path: string,
  query: URLSearchParams,
  req: IncomingMessage,
  body: unknown,
  raw: Buffer,
): Promise<Reply> {
  if (path === "/auth/csrf") return { body: { csrfToken: MOCK_CSRF }, schema: csrfResponseSchema };
  // Google sign-in is offered unless a test sets the `mock_google=off` cookie.
  if (path === "/auth/providers")
    return {
      body: { google: !/(^|;\s*)mock_google=off(;|$)/.test(req.headers.cookie ?? "") },
      schema: authProvidersResponseSchema,
    };
  if (path === "/auth/refresh") throw new HttpError(401, "unauthorized");
  if (path === "/auth/logout")
    return { body: { message: "Signed out." }, schema: messageResponseSchema };
  const [persona, session = ""] = cookie(req, "pmb_at")?.split(".") ?? [];
  if (isSupplierPersona(persona)) {
    if (method !== "GET" && req.headers["x-csrf-token"] !== MOCK_CSRF)
      throw new HttpError(403, "forbidden");
    return handleSupplierPersona(
      session,
      method,
      path,
      query,
      body,
      {
        idempotencyKey:
          typeof req.headers["idempotency-key"] === "string"
            ? req.headers["idempotency-key"]
            : undefined,
        contentType: req.headers["content-type"],
        raw,
      },
      (status, code) => new HttpError(status, code),
      parse,
    );
  }
  if (isPortalPersona(persona)) {
    if (method !== "GET" && req.headers["x-csrf-token"] !== MOCK_CSRF)
      throw new HttpError(403, "forbidden");
    return handlePortalPersona(
      persona,
      method,
      path,
      (status, code) => new HttpError(status, code),
    );
  }
  const state = stateFor(req);
  if (method !== "GET" && req.headers["x-csrf-token"] !== MOCK_CSRF)
    throw new HttpError(403, "forbidden");
  if (path === "/auth/me") return { body: ownerAccount(state), schema: authResponseSchema };
  if (path === "/auth/mfa/step-up" && method === "POST") {
    if ((body as { code?: string }).code !== MOCK_STEP_UP_CODE)
      throw new HttpError(401, "unauthorized");
    state.stepUpAt.set(state.persona, Date.now());
    return { body: ownerAccount(state), schema: authResponseSchema };
  }
  if (path === "/tenants")
    return {
      body: {
        tenants: [
          {
            id: TENANT_ID,
            name: "Jenga Bora Builders Ltd",
            role: PERSONAS[state.persona].role,
            roleName: null,
            tenantWide: isTenantWide(state.persona),
            permissions: [...rolePermissions(state)],
          },
        ],
      },
      schema: tenantsResponseSchema,
    };
  // The labour and attendance mocks know two personas; anyone but the owner acts as the agent.
  const labour = handleLabour(
    {
      persona: state.persona === "owner" ? "owner" : "agent",
      user:
        state.persona === "owner"
          ? { id: OWNER_ID, displayName: "Wanjiru Kamau" }
          : { id: AGENT_ID, displayName: "Kevin Kiprono" },
      projects: state.projects.map(({ project }) => ({
        id: project.id,
        code: project.code,
        name: project.name,
        status: project.status,
      })),
      stepUpFresh: () => Date.now() - (state.stepUpAt.get(state.persona) ?? 0) <= 5 * 60_000,
      fail: (status, code, match) => {
        throw new HttpError(status, code, match);
      },
    },
    state.labour,
    method,
    path,
    query,
    body,
  );
  if (labour) return labour;
  const attendance = handleAttendance(
    {
      persona: state.persona === "owner" ? "owner" : "agent",
      user:
        state.persona === "owner"
          ? { id: OWNER_ID, displayName: "Wanjiru Kamau" }
          : { id: AGENT_ID, displayName: "Kevin Kiprono" },
      projects: state.projects.map(({ project, sites }) => ({
        id: project.id,
        code: project.code,
        name: project.name,
        status: project.status,
        sites: sites.map(({ site }) => ({ id: site.id, name: site.name })),
      })),
      labour: state.labour,
      idempotencyKey:
        typeof req.headers["idempotency-key"] === "string"
          ? req.headers["idempotency-key"]
          : undefined,
      stepUpFresh: () => Date.now() - (state.stepUpAt.get(state.persona) ?? 0) <= 5 * 60_000,
      fail: (status, code) => {
        throw new HttpError(status, code);
      },
    },
    state.attendance,
    method,
    path,
    query,
    body,
  );
  if (attendance) return attendance;
  if (path === "/projects" && method === "GET") {
    const status = query.get("status");
    const search = query.get("search")?.toLowerCase();
    const projects = state.projects
      .filter((entry) => projectPermissions(state, entry).includes("projects.view"))
      .map((entry) => entry.project)
      .filter((project) => !status || project.status === status)
      .filter(
        (project) =>
          !search ||
          [project.code, project.name, project.clientName, project.town].some((value) =>
            value?.toLowerCase().includes(search),
          ),
      );
    return { body: { projects }, schema: projectsResponseSchema };
  }
  if (path === "/projects" && method === "POST") {
    if (state.persona !== "owner") throw new HttpError(403, "forbidden");
    const input = parse(createProjectRequestSchema, body);
    requireStepUp(state);
    const code = input.code ?? `PRJ-${String(state.projects.length + 1).padStart(3, "0")}`;
    if (state.projects.some((entry) => entry.project.code === code))
      throw new HttpError(409, "project-code-taken");
    const fields = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    );
    const project = baseProject({ ...fields, id: id(), code, name: input.name });
    state.projects.push({ project, history: [], sites: [], wbs: [], milestones: [] });
    state.team.set(project.id, [
      { userId: OWNER_ID, displayName: "Wanjiru Kamau", role: "owner", assignment: null },
    ]);
    return { status: 201, body: { project }, schema: projectResponseSchema };
  }
  const documents = handleDocuments(
    documentsDeps(state),
    state.documents,
    method,
    path,
    query,
    body,
    raw,
  );
  if (documents) return documents;
  const valuations = handleValuations(
    {
      fail: (status, code) => new HttpError(status, code),
      parse,
      actor: { id: PERSONAS[state.persona].id, displayName: PERSONAS[state.persona].displayName },
      projects: projectInfo(state.projects),
      projectPermissions: (projectId) => valuationPermissions(state, projectId),
      photo: (projectId, photoId) => {
        const found = state.photos.find(
          (candidate) => candidate.id === photoId && candidate.projectId === projectId,
        );
        return found ? { id: found.id, verified: found.verified, caption: found.caption } : null;
      },
      requireStepUp: () => requireStepUp(state),
      idempotencyKey:
        typeof req.headers["idempotency-key"] === "string"
          ? req.headers["idempotency-key"]
          : undefined,
    },
    state.valuations,
    method,
    path,
    query,
    body,
  );
  if (valuations) return valuations;
  const stores = handleStores(
    {
      fail: (status, code) => new HttpError(status, code),
      parse,
      actor: { id: PERSONAS[state.persona].id, displayName: PERSONAS[state.persona].displayName },
      projects: state.projects.map(({ project, sites }) => ({
        id: project.id,
        code: project.code,
        name: project.name,
        status: project.status,
        sites: sites.map(({ site }) => ({ id: site.id, name: site.name })),
      })),
      projectPermissions: (projectId) => {
        const entry = state.projects.find((candidate) => candidate.project.id === projectId);
        return entry ? projectPermissions(state, entry) : [];
      },
      companyPermissions: rolePermissions(state),
      somewhere: () => [
        ...new Set([
          ...(isTenantWide(state.persona) ? rolePermissions(state) : []),
          ...state.projects.flatMap((entry) => projectPermissions(state, entry)),
        ]),
      ],
      catalogue: state.procurement,
      buildups: state.bq.buildups,
      gangs: state.labour.gangs.map((gang) => ({
        id: gang.id,
        projectId: gang.projectId,
        name: gang.name,
        status: gang.status,
      })),
      idempotencyKey:
        typeof req.headers["idempotency-key"] === "string"
          ? req.headers["idempotency-key"]
          : undefined,
    },
    state.stores,
    method,
    path,
    query,
    body,
  );
  if (stores) return stores;
  const spending = handleSpending(
    {
      fail: (status, code) => new HttpError(status, code),
      parse,
      actor: { id: PERSONAS[state.persona].id, displayName: PERSONAS[state.persona].displayName },
      projects: projectInfo(state.projects),
      projectPermissions: (projectId) => {
        const entry = state.projects.find((candidate) => candidate.project.id === projectId);
        return entry ? projectPermissions(state, entry) : [];
      },
      // Company-wide members (owner, finance) hold their role on every project, as in the API.
      companyPermissions: isTenantWide(state.persona) ? rolePermissions(state) : null,
      holders: (projectId, permission) =>
        (state.team.get(projectId) ?? [])
          .filter((member) =>
            member.role === "owner"
              ? true
              : SYSTEM_ROLE_PERMISSIONS[member.role].includes(permission) &&
                (member.assignment ?? []).includes(permission),
          )
          .map((member) => ({ id: member.userId, displayName: member.displayName })),
      requireStepUp: () => requireStepUp(state),
      idempotencyKey:
        typeof req.headers["idempotency-key"] === "string"
          ? req.headers["idempotency-key"]
          : undefined,
      contentType: req.headers["content-type"],
      raw,
    },
    state.spending,
    method,
    path,
    query,
    body,
  );
  if (spending) return spending;
  const p2p = handleP2p(
    {
      ...p2pBase(state.projects, state.procurement, state.bq),
      persona: state.persona,
      requireStepUp: () => requireStepUp(state),
      projectPermissions: (projectId) => {
        const entry = state.projects.find((candidate) => candidate.project.id === projectId);
        return entry ? projectPermissions(state, entry) : [];
      },
      idempotencyKey:
        typeof req.headers["idempotency-key"] === "string"
          ? req.headers["idempotency-key"]
          : undefined,
      contentType: req.headers["content-type"],
      raw,
    },
    state.p2p,
    method,
    path,
    query,
    body,
  );
  if (p2p) return p2p;
  const supplierPortalUsers = handleSupplierPortalUsers(
    {
      fail: (status, code) => new HttpError(status, code),
      parse,
      actor: { id: PERSONAS[state.persona].id, displayName: PERSONAS[state.persona].displayName },
      canManage:
        rolePermissions(state).includes("procurement.manage_suppliers") ||
        (isTenantWide(state.persona) && rolePermissions(state).includes("finance.manage")),
      requireStepUp: () => requireStepUp(state),
      supplier: (id) => {
        const found = state.procurement.suppliers.find((entry) => entry.supplier.id === id);
        return found
          ? {
              id: found.supplier.id,
              code: found.supplier.code,
              name: found.supplier.tradingName ?? found.supplier.legalName,
            }
          : null;
      },
    },
    state.supplierPortal,
    method,
    path,
    body,
  );
  if (supplierPortalUsers) return supplierPortalUsers;
  const procurement = handleProcurement(
    {
      fail: (status, code) => new HttpError(status, code),
      parse,
      // Company-wide members hold their role; others hold company-level keys plus what a
      // project assignment grants somewhere (the API's AccessPolicy).
      permissions: isTenantWide(state.persona)
        ? rolePermissions(state)
        : [
            ...new Set([
              ...rolePermissions(state).filter((key) => !isProjectPermission(key)),
              ...state.projects.flatMap((entry) => projectPermissions(state, entry)),
            ]),
          ],
      tenantWide: isTenantWide(state.persona),
      actor: { id: PERSONAS[state.persona].id, displayName: PERSONAS[state.persona].displayName },
      requireStepUp: () => requireStepUp(state),
    },
    state.procurement,
    method,
    path,
    query,
    body,
  );
  if (procurement) return procurement;
  const buildups = handleBuildups(
    {
      fail: (status, code) => new HttpError(status, code),
      parse,
      somewhere: () => [
        ...new Set(state.projects.flatMap((entry) => projectPermissions(state, entry))),
      ],
      actor: { id: PERSONAS[state.persona].id, displayName: PERSONAS[state.persona].displayName },
    },
    state.bq,
    method,
    path,
    body,
  );
  if (buildups) return buildups;
  const actor = {
    id: PERSONAS[state.persona].id,
    displayName: PERSONAS[state.persona].displayName,
  };
  const somewhere = [
    ...new Set(state.projects.flatMap((entry) => projectPermissions(state, entry))),
  ];
  const qualityDeps = (entry: ProjectState | null) => ({
    project: entry ? { id: entry.project.id, status: entry.project.status } : null,
    sites: entry ? entry.sites.map(({ site }) => ({ id: site.id, name: site.name })) : [],
    wbs: entry ? entry.wbs.map(({ id: nodeId, code, name }) => ({ id: nodeId, code, name })) : [],
    permissions: entry ? projectPermissions(state, entry) : [],
    somewhere,
    companyPermissions: rolePermissions(state),
    actor,
    photo: (photoId: string) => {
      const found = state.photos.find(
        (photo) => photo.id === photoId && photo.projectId === entry?.project.id,
      );
      return found ? { id: found.id, verified: found.verified, caption: found.caption } : null;
    },
    fail: (status: number, code: string) => new HttpError(status, code),
    parse,
  });
  if (path.startsWith("/quality/"))
    return handleQuality(qualityDeps(null), state.quality, method, path, query, body)!;
  const safetyDeps = (entry: ProjectState | null) => ({
    project: entry
      ? {
          id: entry.project.id,
          code: entry.project.code,
          name: entry.project.name,
          status: entry.project.status,
        }
      : null,
    sites: entry ? entry.sites.map(({ site }) => ({ id: site.id, name: site.name })) : [],
    permissions: entry ? projectPermissions(state, entry) : [],
    somewhere,
    companyPermissions: rolePermissions(state),
    actor,
    // Members who can read safety records, with their effective permissions on the project:
    // role ∩ assignment (owner: all), as projectStaff() in the API.
    staff: entry
      ? (state.team.get(entry.project.id) ?? [])
          .map((member) => ({
            id: member.userId,
            displayName: member.displayName,
            permissions:
              member.role === "owner"
                ? PROJECT_PERMISSIONS
                : SYSTEM_ROLE_PERMISSIONS[member.role].filter(
                    (key) => isProjectPermission(key) && (member.assignment ?? []).includes(key),
                  ),
          }))
          .filter(
            (member) =>
              member.permissions.includes("projects.view") &&
              SAFETY_READ_PERMISSIONS.some((key) => member.permissions.includes(key)),
          )
          .sort((a, b) => a.displayName.localeCompare(b.displayName))
      : [],
    labourers: entry
      ? state.labour.labourers
          .filter((labourer) =>
            labourer.engagements.some((engagement) => engagement.projectId === entry.project.id),
          )
          .map((labourer) => ({
            id: labourer.id,
            workerNo: labourer.workerNo,
            fullName: labourer.fullName,
            gangId:
              state.labour.gangs.find((gang) =>
                gang.members.some(
                  (member) => member.labourerId === labourer.id && member.leftOn === null,
                ),
              )?.id ?? null,
          }))
      : [],
    gangs: entry
      ? state.labour.gangs
          .filter((gang) => gang.projectId === entry.project.id && gang.status === "active")
          .map((gang) => ({
            id: gang.id,
            name: gang.name,
            siteId: gang.siteId,
            members: gang.members
              .filter((member) => member.leftOn === null)
              .map((member) => member.labourerId),
          }))
      : [],
    photo: (photoId: string) => {
      const found = state.photos.find(
        (photo) => photo.id === photoId && photo.projectId === entry?.project.id,
      );
      return found
        ? { id: found.id, verified: found.verified, caption: found.caption, siteId: found.siteId }
        : null;
    },
    projects: state.projects.map((candidate) => {
      const permissions = projectPermissions(state, candidate);
      return {
        id: candidate.project.id,
        code: candidate.project.code,
        name: candidate.project.name,
        status: candidate.project.status,
        readable:
          permissions.includes("projects.view") &&
          SAFETY_READ_PERMISSIONS.some((key) => permissions.includes(key)),
      };
    }),
    fail: (status: number, code: string) => new HttpError(status, code),
    parse,
  });
  if (path.startsWith("/safety/"))
    return handleSafety(safetyDeps(null), state.safety, method, path, query, body)!;
  if (
    path === "/plant" ||
    path.startsWith("/plant/") ||
    /^\/projects\/[^/]+\/plant(\/options)?$/.test(path)
  ) {
    const plant = handlePlant(
      {
        projects: state.projects.map((entry) => ({
          id: entry.project.id,
          code: entry.project.code,
          name: entry.project.name,
          status: entry.project.status,
          sites: entry.sites.map(({ site }) => ({ id: site.id, name: site.name })),
          permissions: projectPermissions(state, entry),
        })),
        companyPermissions: rolePermissions(state),
        actor,
        suppliers: state.procurement.suppliers.map(({ supplier }) => ({
          id: supplier.id,
          code: supplier.code,
          name: supplier.tradingName ?? supplier.legalName,
        })),
        labourers: (projectId) =>
          state.labour.labourers
            .filter((labourer) =>
              labourer.engagements.some((engagement) => engagement.projectId === projectId),
            )
            .map(({ id: labourerId, workerNo, fullName }) => ({
              id: labourerId,
              workerNo,
              fullName,
            })),
        staff: [
          { id: PM_ID, displayName: "Brian Otieno" },
          { id: AGENT_ID, displayName: "Kevin Kiprono" },
        ],
        fail: (status: number, code: string) => new HttpError(status, code),
        parse,
      },
      state.plant,
      method,
      path,
      query,
      body,
    );
    if (plant) return plant;
    throw new HttpError(404, "not-found");
  }
  const match = /^\/projects\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (!match) throw new HttpError(404, "not-found");
  const [, projectId, rest = ""] = match;
  if (rest === "photos") {
    const entry = find(state, projectId!, method === "GET" ? "projects.view" : "site.photos");
    return handlePhotos(
      state.photos,
      projectId!,
      entry.sites.map((site) => site.site.id),
      method,
      raw,
      (status, code) => new HttpError(status, code),
    );
  }
  if (rest === "schedule" || rest.startsWith("schedule/")) {
    const entry = find(state, projectId!, "projects.view");
    const { project } = entry;
    return handleSchedule(
      {
        project: { id: project.id, status: project.status, startDate: project.startDate },
        milestones: entry.milestones,
        wbs: entry.wbs,
        canEdit:
          projectPermissions(state, entry).includes("projects.manage") &&
          project.status !== "closed" &&
          project.status !== "cancelled",
        actor: { id: PERSONAS[state.persona].id, displayName: PERSONAS[state.persona].displayName },
        fail: (status, code) => new HttpError(status, code),
        parse,
      },
      state.schedule,
      method,
      rest,
      query,
      body,
    )!;
  }
  if (rest === "quality" || rest.startsWith("quality/")) {
    const entry = find(state, projectId!, "projects.view");
    return handleQuality(qualityDeps(entry), state.quality, method, path, query, body)!;
  }
  if (rest === "safety" || rest.startsWith("safety/")) {
    const entry = find(state, projectId!, "projects.view");
    return handleSafety(safetyDeps(entry), state.safety, method, path, query, body)!;
  }
  if (rest === "diaries" || rest.startsWith("diaries/")) {
    const entry = find(state, projectId!, method === "GET" ? "projects.view" : "site.diary");
    if (method !== "GET" && ["closed", "cancelled"].includes(entry.project.status))
      throw new HttpError(409, "project-read-only");
    return handleDiaries(
      state.diaries,
      state.persona === "owner" ? OWNER_ID : AGENT_ID,
      projectId!,
      entry.sites.map((site) => site.site.id),
      method,
      rest,
      query,
      body,
      (status, code) => new HttpError(status, code),
    );
  }
  if (rest === "bq" || rest.startsWith("bq/")) {
    const entry = find(state, projectId!, "projects.view");
    return handleBq(
      {
        fail: (status, code) => new HttpError(status, code),
        parse,
        project: (permission) => find(state, projectId!, permission).project,
        permissions: () => projectPermissions(state, entry),
        actor: { id: PERSONAS[state.persona].id, displayName: PERSONAS[state.persona].displayName },
        requireStepUp: () => requireStepUp(state),
      },
      state.bq,
      method,
      rest,
      query,
      body,
      raw,
    );
  }
  if (rest === "" && method === "GET")
    return {
      body: detail(state, find(state, projectId!, "projects.view")),
      schema: projectDetailResponseSchema,
    };
  if (rest === "" && method === "PATCH") {
    const entry = editable(state, projectId!);
    const { version: expected, ...fields } = parse(updateProjectRequestSchema, body);
    touch(entry.project, expected);
    Object.assign(
      entry.project,
      Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
    );
    return { body: { project: entry.project }, schema: projectResponseSchema };
  }
  if (rest === "status" && method === "POST") {
    const entry = find(state, projectId!, "projects.manage");
    const input = parse(projectStatusRequestSchema, body);
    if (entry.project.version !== input.version) throw new HttpError(409, "version-conflict");
    const check = checkProjectTransition({
      from: entry.project.status,
      to: input.to,
      reason: input.reason,
      facts: { ...entry.project, geofencedSites: entry.sites.length },
    });
    if (!check.ok)
      throw new HttpError(
        check.error === "reason_required" ? 400 : 409,
        check.error === "reason_required"
          ? "reason-required"
          : check.error === "activation_incomplete"
            ? "activation-incomplete"
            : "invalid-transition",
      );
    entry.history.push({
      from: entry.project.status,
      to: input.to,
      reason: input.reason?.trim() || null,
      changedAt: new Date().toISOString(),
      changedBy: { id: OWNER_ID, displayName: "Wanjiru Kamau" },
    });
    touch(entry.project, input.version).status = input.to;
    return { body: { project: entry.project }, schema: projectResponseSchema };
  }
  if (rest === "sites" && method === "GET")
    return {
      body: { sites: find(state, projectId!, "projects.view").sites.map(currentSite) },
      schema: sitesResponseSchema,
    };
  if (rest === "sites" && method === "POST") {
    const entry = editable(state, projectId!);
    const input = parse(createSiteRequestSchema, body);
    if (entry.sites.some((site) => site.site.name === input.name))
      throw new HttpError(409, "site-name-taken");
    const site = {
      site: {
        id: id(),
        name: input.name,
        address: input.address ?? null,
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
      },
      versions: [version(1, input.geofence, new Date().toISOString())],
    };
    entry.sites.push(site);
    return { status: 201, body: { site: currentSite(site) }, schema: siteResponseSchema };
  }
  const siteMatch = /^sites\/([^/]+)(?:\/(geofence|geofences))?$/.exec(rest);
  if (siteMatch) {
    const [, siteId, sub] = siteMatch;
    const view = method === "GET";
    const entry = view ? find(state, projectId!, "projects.view") : editable(state, projectId!);
    const site = entry.sites.find((candidate) => candidate.site.id === siteId);
    if (!site) throw new HttpError(404, "not-found");
    if (sub === "geofences" && view)
      return { body: { versions: site.versions }, schema: geofenceHistoryResponseSchema };
    if (sub === "geofence" && method === "PUT") {
      const input = parse(changeGeofenceRequestSchema, body);
      if (site.versions[0]!.version !== input.currentVersion)
        throw new HttpError(409, "version-conflict");
      site.versions.unshift(
        version(input.currentVersion + 1, input.geofence, new Date().toISOString()),
      );
      return { body: { site: currentSite(site) }, schema: siteResponseSchema };
    }
    if (!sub && method === "PATCH") {
      const { version: expected, ...fields } = parse(updateSiteRequestSchema, body);
      touch(site.site, expected);
      if (fields.name !== undefined) site.site.name = fields.name;
      if (fields.address !== undefined) site.site.address = fields.address;
      return { body: { site: currentSite(site) }, schema: siteResponseSchema };
    }
  }
  if (rest === "wbs" && method === "GET")
    return { body: wbsView(find(state, projectId!, "projects.view")), schema: wbsResponseSchema };
  if (rest === "wbs" && method === "POST") {
    const entry = editable(state, projectId!);
    const input = parse(createWbsNodeRequestSchema, body);
    if (entry.wbs.some((existing) => existing.code === input.code))
      throw new HttpError(409, "wbs-code-taken");
    const parentId = input.parentId ?? null;
    const created = node(
      input.code,
      input.name,
      input.weightBasisPoints,
      parentId,
      entry.wbs.filter((sibling) => sibling.parentId === parentId).length,
    );
    entry.wbs.push(created);
    return { status: 201, body: { node: created }, schema: wbsNodeResponseSchema };
  }
  if (rest === "wbs/order" && method === "PUT") {
    const entry = editable(state, projectId!);
    const input = parse(reorderWbsRequestSchema, body);
    input.nodeIds.forEach((nodeId, index) => {
      const found = entry.wbs.find((candidate) => candidate.id === nodeId);
      if (found) found.sortOrder = index;
    });
    return { body: { message: "WBS order saved." }, schema: messageResponseSchema };
  }
  const wbsMatch = /^wbs\/([^/]+)$/.exec(rest);
  if (wbsMatch) {
    const entry = editable(state, projectId!);
    const found = entry.wbs.find((candidate) => candidate.id === wbsMatch[1]);
    if (!found) throw new HttpError(404, "not-found");
    if (method === "DELETE") {
      if (entry.wbs.some((child) => child.parentId === found.id))
        throw new HttpError(409, "wbs-has-children");
      entry.wbs = entry.wbs.filter((candidate) => candidate !== found);
      return { body: { message: "WBS node removed." }, schema: messageResponseSchema };
    }
    const { version: expected, ...fields } = parse(updateWbsNodeRequestSchema, body);
    touch(found, expected);
    Object.assign(
      found,
      Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
    );
    return { body: { node: found }, schema: wbsNodeResponseSchema };
  }
  if (rest === "milestones" && method === "GET")
    return {
      body: { milestones: find(state, projectId!, "projects.view").milestones },
      schema: milestonesResponseSchema,
    };
  if (rest === "milestones" && method === "POST") {
    const entry = editable(state, projectId!);
    const input = parse(createMilestoneRequestSchema, body);
    const milestone: Milestone = {
      id: id(),
      wbsNodeId: input.wbsNodeId ?? null,
      name: input.name,
      dueDate: input.dueDate,
      status: "planned",
      actualDate: null,
      statusReason: null,
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    entry.milestones.push(milestone);
    return { status: 201, body: { milestone }, schema: milestoneResponseSchema };
  }
  const milestoneMatch = /^milestones\/([^/]+)(\/status)?$/.exec(rest);
  if (milestoneMatch) {
    const entry = editable(state, projectId!);
    const milestone = entry.milestones.find((candidate) => candidate.id === milestoneMatch[1]);
    if (!milestone) throw new HttpError(404, "not-found");
    if (milestoneMatch[2] && method === "POST") {
      const input = parse(milestoneStatusRequestSchema, body);
      if (milestone.version !== input.version) throw new HttpError(409, "version-conflict");
      const check = checkMilestoneTransition({
        from: milestone.status,
        to: input.to,
        reason: input.reason,
        actualDate: input.actualDate,
        today: nairobiDate(),
      });
      if (!check.ok)
        throw new HttpError(
          check.error === "invalid_transition" ? 409 : 400,
          check.error.replaceAll("_", "-"),
        );
      touch(milestone, input.version);
      milestone.status = input.to;
      milestone.actualDate =
        check.transition.action === "achieve" ? (input.actualDate ?? null) : null;
      milestone.statusReason = input.reason?.trim() || null;
      return { body: { milestone }, schema: milestoneResponseSchema };
    }
    if (method === "DELETE") {
      entry.milestones = entry.milestones.filter((candidate) => candidate !== milestone);
      return { body: { message: "Milestone removed." }, schema: messageResponseSchema };
    }
    const { version: expected, ...fields } = parse(updateMilestoneRequestSchema, body);
    touch(milestone, expected);
    Object.assign(
      milestone,
      Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
    );
    return { body: { milestone }, schema: milestoneResponseSchema };
  }
  if (rest === "labourers/invitations" && method === "POST") {
    find(state, projectId!, "labour.manage");
    const identifier = normalizeKenyanPhone(
      String((body as { identifier?: unknown })?.identifier ?? ""),
    );
    if (!identifier) throw new HttpError(400, "validation-error");
    return {
      status: 201,
      body: {
        invitation: {
          id: id(),
          identifier,
          role: "labourer",
          roleName: null,
          expiresAt: new Date(Date.now() + 48 * 3_600_000).toISOString(),
        },
      },
      schema: invitationResponseSchema,
    };
  }
  if (rest === "team" && method === "GET")
    return {
      body: teamView(state, find(state, projectId!, "projects.view")),
      schema: projectTeamResponseSchema,
    };
  const memberMatch = /^members\/([^/]+)$/.exec(rest);
  if (memberMatch) {
    const entry = find(state, projectId!, "projects.view");
    if (state.persona !== "owner") throw new HttpError(403, "forbidden");
    const permissions =
      method === "DELETE" ? [] : parse(projectAssignmentRequestSchema, body).permissions;
    requireStepUp(state);
    const member = state.team
      .get(entry.project.id)
      ?.find((candidate) => candidate.userId === memberMatch[1]);
    if (!member) throw new HttpError(404, "not-found");
    member.assignment = permissions;
    return {
      body: {
        message: method === "DELETE" ? "Removed from the project." : "Project permissions updated.",
      },
      schema: messageResponseSchema,
    };
  }
  throw new HttpError(404, "not-found");
}

async function readBody(req: IncomingMessage): Promise<{ json: unknown; raw: Buffer }> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks);
  if (!raw.length || !(req.headers["content-type"] ?? "").includes("application/json"))
    return { json: undefined, raw };
  return { json: JSON.parse(raw.toString("utf8")) as unknown, raw };
}

function send(res: ServerResponse, status: number, body: unknown, problem = false) {
  res.writeHead(status, {
    "Content-Type": problem ? "application/problem+json" : "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", "http://mock.invalid");
    if (url.pathname === "/health") return send(res, 200, { status: "ok" });
    const path = url.pathname.replace(/^\/api\/v1/, "");
    // The supplier's invoice documents and statement exports are bytes.
    const [persona, session = ""] = cookie(req, "pmb_at")?.split(".") ?? [];
    if (
      isSupplierPersona(persona) &&
      req.method === "GET" &&
      /^\/portal\/supplier\/(documents|statement\/export)\//.test(path)
    ) {
      const file = supplierPortalFile(session, path);
      if (!file) return send(res, 404, { code: "not-found" }, true);
      res.writeHead(200, {
        "Content-Type": file.contentType,
        ...(file.filename
          ? { "Content-Disposition": `attachment; filename="${file.filename}"` }
          : {}),
        "Cache-Control": "no-store",
      });
      return res.end(file.content);
    }
    // Procurement documents and GRN photos are downloaded as bytes, not JSON.
    const download = /^\/procurement\/documents\/([^/]+)$/.exec(path);
    if (download && req.method === "GET") {
      try {
        const file = p2pDocument(stateFor(req).p2p, download[1]!);
        if (!file) return send(res, 404, { code: "not-found" }, true);
        res.writeHead(200, { "Content-Type": file.contentType, "Cache-Control": "no-store" });
        return res.end(file.content);
      } catch {
        return send(res, 401, { code: "unauthorized" }, true);
      }
    }
    // Certificate PDF and Excel files are bytes too.
    const certificate = /^\/valuations\/([^/]+)\/export\/(pdf|xlsx)$/.exec(path);
    if (certificate && req.method === "GET") {
      try {
        const state = stateFor(req);
        const file = valuationExport(
          { projectPermissions: (projectId) => valuationPermissions(state, projectId) },
          state.valuations,
          certificate[1]!,
          certificate[2]!,
        );
        if (!file) return send(res, 404, { code: "not-found" }, true);
        res.writeHead(200, {
          "Content-Type": file.contentType,
          "Content-Disposition": `attachment; filename="certificate.${certificate[2]}"`,
          "Cache-Control": "no-store",
        });
        return res.end(file.content);
      } catch {
        return send(res, 401, { code: "unauthorized" }, true);
      }
    }
    // Document versions are downloaded as bytes, with the version state in a header.
    const documentFile =
      /^\/projects\/([^/]+)\/documents\/([^/]+)\/versions\/([^/]+)\/content$/.exec(path);
    if (documentFile && req.method === "GET") {
      try {
        const state = stateFor(req);
        const file = documentDownload(
          documentsDeps(state),
          state.documents,
          documentFile[1]!,
          documentFile[2]!,
          documentFile[3]!,
        );
        if (!file) return send(res, 404, { code: "not-found" }, true);
        res.writeHead(200, {
          "Content-Type": file.contentType,
          "Content-Disposition": `attachment; filename="${file.fileName}"`,
          "X-Content-Type-Options": "nosniff",
          "X-Document-Version-State": file.state,
          "Cache-Control": "no-store",
        });
        return res.end(file.content);
      } catch {
        return send(res, 401, { code: "unauthorized" }, true);
      }
    }
    // Petty-cash receipt photos are downloaded as bytes too.
    const receipt = /^\/petty-cash\/receipts\/([^/]+)$/.exec(path);
    if (receipt && req.method === "GET") {
      try {
        const file = spendingReceipt(stateFor(req).spending, receipt[1]!);
        if (!file) return send(res, 404, { code: "not-found" }, true);
        res.writeHead(200, { "Content-Type": file.contentType, "Cache-Control": "no-store" });
        return res.end(file.content);
      } catch {
        return send(res, 401, { code: "unauthorized" }, true);
      }
    }
    try {
      const { json, raw } = await readBody(req);
      const reply = await handle(req.method ?? "GET", path, url.searchParams, req, json, raw);
      const checked = reply.schema.safeParse(reply.body);
      if (!checked.success) {
        console.error(
          `Mock response for ${req.method} ${path} breaks the shared contract`,
          checked.error.issues,
        );
        return send(res, 500, { code: "mock-contract-violation" }, true);
      }
      send(res, reply.status ?? 200, reply.body);
    } catch (error) {
      if (error instanceof HttpError)
        return send(
          res,
          error.status,
          {
            status: error.status,
            code: error.code,
            ...(error.match ? { match: error.match } : {}),
          },
          true,
        );
      console.error(error);
      send(res, 500, { code: "internal-error" }, true);
    }
  })();
});

server.listen(Number(process.env.MOCK_API_PORT ?? 3199), "127.0.0.1");
