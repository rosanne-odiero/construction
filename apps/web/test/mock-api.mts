/**
 * A small stateful stand-in for the PM-Buddy API, used only by the Playwright suite. The web
 * server renders live pages on the server (API_INTERNAL_URL), where Playwright cannot intercept
 * requests, so this server answers both those server-side calls and the browser's same-origin
 * /api calls that the Next.js rewrite forwards here.
 *
 * Each test signs in with its own `pmb_at=<persona>.<id>` cookie and gets its own copy of the
 * fixture data. Requests are validated with the shared request schemas and every response is
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
  wbsWeightGroups,
  wbsWeightsComplete,
  type Geofence,
} from "@pm-buddy/domain";
import {
  isProjectPermission,
  PROJECT_ASSIGNABLE_PERMISSIONS,
  PROJECT_PERMISSIONS,
  SYSTEM_ROLE_PERMISSIONS,
  TENANT_PERMISSIONS,
  type Permission,
} from "@pm-buddy/types";
import {
  authResponseSchema,
  changeGeofenceRequestSchema,
  createMilestoneRequestSchema,
  createProjectRequestSchema,
  createSiteRequestSchema,
  createWbsNodeRequestSchema,
  csrfResponseSchema,
  geofenceHistoryResponseSchema,
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
  type WbsNode,
} from "@pm-buddy/validation";
import { handleBq, initialProjectBq, type BqState } from "./mock-bq.mts";
import { handleLabour, labourFixture, type LabourState } from "./mock-labour.mts";

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
const NOW = "2026-11-10T07:45:00.000Z";

type Persona = "owner" | "agent";
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
  stepUpAt: number;
  projects: ProjectState[];
  team: Map<string, TeamEntry[]>;
  bq: BqState;
  labour: LabourState;
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
  const pmAssignment = PROJECT_ASSIGNABLE_PERMISSIONS.filter((key) =>
    SYSTEM_ROLE_PERMISSIONS.project_manager.includes(key),
  );
  return {
    persona,
    stepUpAt: 0,
    bq: {
      projects: new Map([
        [RUIRU_ID, initialProjectBq(true, ruiru.project.contractSumMinor)],
        [SYOKIMAU_ID, initialProjectBq(false, null)],
      ]),
      templates: [],
    },
    projects: [ruiru, syokimau],
    labour: labourFixture(),
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
            assignment: ["projects.view", "site.diary", "bq.view"],
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
  const persona = token?.split(".")[0];
  if (!token || (persona !== "owner" && persona !== "agent"))
    throw new HttpError(401, "unauthorized");
  let state = states.get(token);
  if (!state) {
    state = fixture(persona);
    states.set(token, state);
  }
  return state;
}

const ownerAccount = (state: State) => ({
  user: {
    id: state.persona === "owner" ? OWNER_ID : AGENT_ID,
    identifier:
      state.persona === "owner"
        ? "owner@jenga-bora.example.test"
        : "site.agent@jenga-bora.example.test",
    displayName: state.persona === "owner" ? "Wanjiru Kamau" : "Kevin Kiprono",
    verified: true,
    mfaEnabled: state.persona === "owner",
    totpEnabled: state.persona === "owner",
    passkeys: 0,
  },
  session: {
    id: "22000000-0000-4000-8000-000000000001",
    tenantId: TENANT_ID,
    mfaVerified: state.persona === "owner",
    expiresAt: "2026-11-11T07:45:00.000Z",
  },
  mfaRequired: false,
});

const rolePermissions = (state: State): readonly Permission[] =>
  state.persona === "owner" ? TENANT_PERMISSIONS : SYSTEM_ROLE_PERMISSIONS.site_agent;

function projectPermissions(state: State, entry: ProjectState): Permission[] {
  if (state.persona === "owner") return [...PROJECT_PERMISSIONS];
  const assignment =
    state.team.get(entry.project.id)?.find((member) => member.userId === AGENT_ID)?.assignment ??
    [];
  return SYSTEM_ROLE_PERMISSIONS.site_agent.filter((key) => assignment.includes(key));
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
  if (Date.now() - state.stepUpAt > 5 * 60_000) throw new HttpError(403, "step-up-required");
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
  if (path === "/auth/refresh") throw new HttpError(401, "unauthorized");
  if (path === "/auth/logout")
    return { body: { message: "Signed out." }, schema: messageResponseSchema };
  const state = stateFor(req);
  if (method !== "GET" && req.headers["x-csrf-token"] !== MOCK_CSRF)
    throw new HttpError(403, "forbidden");
  if (path === "/auth/me") return { body: ownerAccount(state), schema: authResponseSchema };
  if (path === "/auth/mfa/step-up" && method === "POST") {
    if ((body as { code?: string }).code !== MOCK_STEP_UP_CODE)
      throw new HttpError(401, "unauthorized");
    state.stepUpAt = Date.now();
    return { body: ownerAccount(state), schema: authResponseSchema };
  }
  if (path === "/tenants")
    return {
      body: {
        tenants: [
          {
            id: TENANT_ID,
            name: "Jenga Bora Builders Ltd",
            role: state.persona === "owner" ? "owner" : "site_agent",
            roleName: null,
            tenantWide: state.persona === "owner",
            permissions: [...rolePermissions(state)],
          },
        ],
      },
      schema: tenantsResponseSchema,
    };
  const labour = handleLabour(
    {
      persona: state.persona,
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
      stepUpFresh: () => Date.now() - state.stepUpAt <= 5 * 60_000,
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
  const match = /^\/projects\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (!match) throw new HttpError(404, "not-found");
  const [, projectId, rest = ""] = match;
  if (rest === "bq" || rest.startsWith("bq/")) {
    const entry = find(state, projectId!, "projects.view");
    return handleBq(
      {
        fail: (status, code) => new HttpError(status, code),
        parse,
        project: (permission) => find(state, projectId!, permission).project,
        permissions: () => projectPermissions(state, entry),
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
