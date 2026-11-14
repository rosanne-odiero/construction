/**
 * D8.2 health and safety for the mock API: inductions with attendance flags, toolbox talks locked
 * once confirmed, the PPE register, incidents with investigation, the regulator decision and
 * closing, corrective actions with an independent verifier, first aid and the company settings.
 * It computes with the shared domain rules (packages/domain) and returns the shared response
 * schemas, so the browser tests exercise the real wire contract. Dates are relative to today in
 * Nairobi. Synthetic data only.
 */
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import {
  addCalendarDays,
  certificateState,
  checkProcurementTransition,
  compareCorrectiveActions,
  correctiveActionDaysOverdue,
  correctiveActionOverdue,
  correctiveActionVerifierIndependent,
  CORRECTIVE_ACTION_TRANSITIONS,
  incidentCloseBlockers,
  inductionStatus,
  inductionValidUntil,
  kitNextCheckOn,
  kitState,
  nairobiDate,
  ppeReplacementDueOn,
  ppeReplacementState,
  regulatorState,
  TOOLBOX_TALK_TRANSITIONS,
  uninductedAttendance,
} from "@pm-buddy/domain";
import {
  DEFAULT_PPE_REPLACEMENT_DAYS,
  SAFETY_READ_PERMISSIONS,
  SAFETY_RECORD_PERMISSIONS,
  SAFETY_WARNING_DAYS,
  STARTER_INDUCTION_TOPICS,
  type CorrectiveActionStatus,
  type IncidentStatus,
  type InductionTopic,
} from "@pm-buddy/types";
import {
  addFirstAiderRequestSchema,
  addIncidentPhotosRequestSchema,
  closeIncidentRequestSchema,
  correctiveActionActionRequestSchema,
  correctiveActionResponseSchema,
  correctiveActionsQuerySchema,
  correctiveActionsResponseSchema,
  createCorrectiveActionRequestSchema,
  createFirstAidKitRequestSchema,
  createInductionRequestSchema,
  createToolboxTalkRequestSchema,
  firstAiderResponseSchema,
  firstAidKitResponseSchema,
  firstAidResponseSchema,
  incidentDetailResponseSchema,
  incidentsQuerySchema,
  incidentsResponseSchema,
  inductionResponseSchema,
  inductionsQuerySchema,
  inductionsResponseSchema,
  inductionStatusQuerySchema,
  inductionStatusResponseSchema,
  investigateIncidentRequestSchema,
  issuePpeRequestSchema,
  linkTreatmentRequestSchema,
  ppeIssueResponseSchema,
  ppeIssuesResponseSchema,
  ppeQuerySchema,
  recordKitCheckRequestSchema,
  recordTreatmentRequestSchema,
  regulatorDecisionRequestSchema,
  reportIncidentRequestSchema,
  returnPpeRequestSchema,
  safetyOptionsResponseSchema,
  safetyOverviewResponseSchema,
  safetySettingsResponseSchema,
  safetySummaryResponseSchema,
  toolboxTalkActionRequestSchema,
  toolboxTalkResponseSchema,
  toolboxTalksResponseSchema,
  treatmentResponseSchema,
  updateCorrectiveActionRequestSchema,
  updateIncidentRequestSchema,
  updateSafetySettingsRequestSchema,
  updateToolboxTalkRequestSchema,
  voidRequestSchema,
  type CorrectiveAction,
  type FirstAider,
  type FirstAidKit,
  type Incident,
  type IncidentPerson,
  type Induction,
  type PpeIssue,
  type SafetyLabourer,
  type SafetyPhoto,
  type SafetySettings,
  type ToolboxTalk,
  type Treatment,
} from "@pm-buddy/validation";

/** A copy without the given keys (response schemas are strict). */
function without<T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.includes(key as K)),
  ) as Omit<T, K>;
}

type Person = { id: string; displayName: string };
type Reply = { status?: number; body: unknown; schema: z.ZodType<unknown> };
type Staff = Person & { permissions: readonly string[] };

type InductionRow = Omit<
  Induction,
  "projectId" | "siteName" | "code" | "validUntil" | "state" | "permissions"
>;
type TalkRow = Omit<
  ToolboxTalk,
  "projectId" | "siteName" | "code" | "attendeeCount" | "permissions"
>;
type PpeRow = Omit<PpeIssue, "projectId" | "siteName" | "replacementState" | "permissions">;
type IncidentRow = Omit<
  Incident,
  | "projectId"
  | "siteName"
  | "code"
  | "people"
  | "peopleCounts"
  | "regulator"
  | "actionCounts"
  | "closeBlockers"
  | "permissions"
  | "followUpOf"
> & {
  people: IncidentPerson[];
  regulator: {
    decision: "notified" | "not_notifiable" | null;
    notifiedOn: string | null;
    reference: string | null;
    reason: string | null;
    decidedBy: Person | null;
    decidedAt: string | null;
  };
  followUpOfId: string | null;
};
type ActionRow = Omit<
  CorrectiveAction,
  | "projectId"
  | "code"
  | "incident"
  | "inspection"
  | "toolboxTalk"
  | "overdue"
  | "daysOverdue"
  | "permissions"
> & { incidentId: string | null; toolboxTalkId: string | null; ownerId: string };
type KitRow = Omit<
  FirstAidKit,
  "siteName" | "lastCheck" | "nextCheckOn" | "state" | "checkCount" | "permissions"
> & {
  checks: {
    checkedOn: string;
    outcome: "complete" | "restocked" | "incomplete";
    expiresOn: string | null;
    notes: string | null;
    checkedBy: Person;
  }[];
};
type AiderRow = Omit<FirstAider, "siteName" | "certificateState" | "permissions">;
type TreatmentRow = Omit<
  Treatment,
  "code" | "siteName" | "restricted" | "firstAider" | "incident" | "permissions"
> & {
  firstAiderId: string | null;
  incidentId: string | null;
};
type ProjectSafety = {
  inductions: InductionRow[];
  talks: TalkRow[];
  ppe: PpeRow[];
  incidents: IncidentRow[];
  actions: ActionRow[];
  kits: KitRow[];
  aiders: AiderRow[];
  treatments: TreatmentRow[];
  /** Synthetic recent attendance (days worked) the induction flags are read from. */
  attendance: { siteId: string; labourerId: string; workDate: string }[];
};
export type SafetyState = {
  settings: Omit<SafetySettings, "permissions">;
  projects: Map<string, ProjectSafety>;
};
export type SafetyDeps = {
  /** null for the company routes (settings, overview). */
  project: { id: string; code: string; name: string; status: string } | null;
  sites: { id: string; name: string }[];
  /** Effective permissions on the project (role ∩ assignment). */
  permissions: readonly string[];
  /** Permissions held on some project (company-level reads). */
  somewhere: readonly string[];
  companyPermissions: readonly string[];
  actor: Person;
  /** Project members with their effective permissions on the project. */
  staff: Staff[];
  /** Labourers engaged on the project, with their current gang. */
  labourers: (SafetyLabourer & { gangId: string | null })[];
  gangs: { id: string; name: string; siteId: string | null; members: string[] }[];
  photo: (id: string) => (SafetyPhoto & { siteId: string }) | null;
  /** The readable projects for the overview. */
  projects: { id: string; code: string; name: string; status: string; readable: boolean }[];
  fail: (status: number, code: string) => Error;
  parse: <T>(schema: z.ZodType<T>, body: unknown) => T;
};

const now = () => new Date().toISOString();
const code = (prefix: string, number: number) => `${prefix}-${String(number).padStart(4, "0")}`;
const empty = (): ProjectSafety => ({
  inductions: [],
  talks: [],
  ppe: [],
  incidents: [],
  actions: [],
  kits: [],
  aiders: [],
  treatments: [],
  attendance: [],
});

export function initialSafety(
  ruiru: { projectId: string; siteId: string },
  people: { owner: Person; pm: Person; agent: Person },
  workers: SafetyLabourer[],
): SafetyState {
  const today = nairobiDate();
  const day = (offset: number) => addCalendarDays(today, offset);
  const at = (offset: number, time = "07:30") => `${day(offset)}T${time}:00+03:00`;
  const iso = (offset: number, time = "07:30") => new Date(at(offset, time)).toISOString();
  const [amina, joseph, grace, peter] = workers;
  const site = ruiru.siteId;
  const topics: InductionTopic[] = STARTER_INDUCTION_TOPICS.map((key) => ({ key, label: null }));
  const induction = (number: number, labourer: SafetyLabourer, offset: number): InductionRow => ({
    id: randomUUID(),
    siteId: site,
    number,
    personKind: "labourer",
    labourer,
    staff: null,
    visitorName: null,
    visitorOrganisation: null,
    inductedOn: day(offset),
    inductor: people.agent,
    topics,
    topicsTotal: topics.length,
    acknowledgement: "signed",
    notes: null,
    status: "recorded",
    recordedBy: people.agent,
    recordedAt: iso(offset),
    voidedBy: null,
    voidedAt: null,
    voidReason: null,
    version: 1,
  });
  const nearMissId = randomUUID();
  const injuryId = randomUUID();
  const action = (
    number: number,
    incidentId: string,
    description: string,
    dueOffset: number,
    status: CorrectiveActionStatus,
  ): ActionRow => ({
    id: randomUUID(),
    number,
    source: "incident",
    incidentId,
    toolboxTalkId: null,
    description,
    ownerId: people.agent.id,
    owner: people.agent,
    dueOn: day(dueOffset),
    status,
    doneBy: status === "open" ? null : people.agent,
    doneAt: status === "open" ? null : iso(dueOffset - 1, "15:00"),
    doneNote: null,
    verifiedBy: status === "verified" ? people.pm : null,
    verifiedAt: status === "verified" ? iso(dueOffset, "09:00") : null,
    rejectCount: 0,
    lastRejectReason: null,
    cancelledBy: null,
    cancelledAt: null,
    cancelReason: null,
    raisedBy: people.pm,
    raisedAt: iso(-12, "16:00"),
    version: status === "open" ? 1 : status === "done" ? 2 : 3,
  });
  const incident = (
    id: string,
    number: number,
    fields: Partial<IncidentRow> &
      Pick<IncidentRow, "kind" | "severity" | "location" | "description" | "status">,
  ): IncidentRow => ({
    id,
    siteId: site,
    number,
    occurredAt: iso(-12, "10:40"),
    immediateActions: null,
    firstAidGiven: false,
    people: [],
    photos: [],
    reportedBy: people.agent,
    reportedAt: iso(-12, "11:00"),
    investigation: {
      rootCauseCategory: "procedure_not_followed",
      rootCause: "Materials stacked at an unprotected slab edge to save carrying.",
      contributingFactors: null,
      investigatedBy: people.pm,
      investigatedAt: iso(-11),
    },
    regulator: {
      decision: null,
      notifiedOn: null,
      reference: null,
      reason: null,
      decidedBy: null,
      decidedAt: null,
    },
    closedBy: null,
    closedAt: null,
    closureNote: null,
    noActionReason: null,
    voidedBy: null,
    voidedAt: null,
    voidReason: null,
    followUpOfId: null,
    version: 3,
    ...fields,
  });
  const ruiruSafety: ProjectSafety = {
    inductions: [induction(1, amina!, -30), induction(2, joseph!, -30)],
    talks: [
      {
        id: randomUUID(),
        siteId: site,
        number: 1,
        heldOn: day(-3),
        topic: "Working at height: harness checks",
        notes: null,
        durationMinutes: 15,
        presenter: people.agent,
        photo: null,
        otherAttendees: 0,
        status: "confirmed",
        createdBy: people.agent,
        createdAt: iso(-3),
        confirmedBy: people.agent,
        confirmedAt: iso(-3, "07:45"),
        cancelledBy: null,
        cancelledAt: null,
        cancelReason: null,
        version: 2,
        attendees: [amina!, joseph!].map((labourer) => ({ labourer, gang: null })),
      },
    ],
    ppe: [
      {
        id: randomUUID(),
        siteId: site,
        labourer: amina!,
        item: "helmet",
        size: null,
        quantity: 1,
        issuedOn: day(-40),
        replacementDueOn: ppeReplacementDueOn(day(-40), DEFAULT_PPE_REPLACEMENT_DAYS.helmet),
        status: "issued",
        returnedOn: null,
        returnCondition: null,
        replacesIssueId: null,
        issuedBy: people.agent,
        issuedAt: iso(-40),
        returnedBy: null,
        voidedBy: null,
        voidedAt: null,
        voidReason: null,
        version: 1,
      },
      {
        id: randomUUID(),
        siteId: site,
        labourer: joseph!,
        item: "gloves",
        size: "L",
        quantity: 2,
        issuedOn: day(-35),
        replacementDueOn: ppeReplacementDueOn(day(-35), DEFAULT_PPE_REPLACEMENT_DAYS.gloves),
        status: "issued",
        returnedOn: null,
        returnCondition: null,
        replacesIssueId: null,
        issuedBy: people.agent,
        issuedAt: iso(-35),
        returnedBy: null,
        voidedBy: null,
        voidedAt: null,
        voidReason: null,
        version: 1,
      },
    ],
    incidents: [
      incident(nearMissId, 1, {
        kind: "near_miss",
        severity: "serious",
        location: "First-floor slab edge, grid C/4",
        description: "Blocks stacked at the slab edge fell to the walkway below. Nobody was hurt.",
        status: "closed",
        closedBy: people.pm,
        closedAt: iso(-6),
        closureNote: "Edge barriers checked weekly",
        version: 4,
      }),
      incident(injuryId, 2, {
        kind: "injury",
        severity: "moderate",
        occurredAt: iso(-9, "14:15"),
        reportedAt: iso(-9, "14:40"),
        location: "Scaffold, gable wall, second lift",
        description: "A mason slipped on a wet scaffold board and twisted an ankle.",
        firstAidGiven: true,
        people: [
          {
            id: randomUUID(),
            role: "injured",
            labourer: amina!,
            staff: null,
            name: null,
            injuryType: "sprain",
            bodyPart: "foot",
          },
        ],
        status: "investigated",
        investigation: {
          rootCauseCategory: "unsafe_condition",
          rootCause: "Boards were wet after overnight rain and had no anti-slip finish.",
          contributingFactors: null,
          investigatedBy: people.pm,
          investigatedAt: iso(-8),
        },
      }),
    ],
    actions: [
      action(
        1,
        nearMissId,
        "Fix edge barriers and mark a no-stacking zone at slab edges",
        -8,
        "verified",
      ),
      action(2, injuryId, "Replace smooth scaffold boards with anti-slip boards", -4, "verified"),
      action(3, injuryId, "Record the morning scaffold check on the tag every day", -2, "open"),
    ],
    kits: [
      {
        id: randomUUID(),
        siteId: site,
        label: "Site office kit",
        location: "Container office",
        status: "active",
        retiredReason: null,
        version: 1,
        checks: [
          {
            checkedOn: day(-10),
            outcome: "restocked",
            expiresOn: day(200),
            notes: null,
            checkedBy: people.agent,
          },
        ],
      },
      {
        id: randomUUID(),
        siteId: site,
        label: "Scaffold kit",
        location: "Hoist base",
        status: "active",
        retiredReason: null,
        version: 1,
        checks: [],
      },
    ],
    aiders: [
      {
        id: randomUUID(),
        siteId: site,
        labourer: null,
        staff: people.agent,
        certificateExpiresOn: day(300),
        certificateReference: "SYN-FA-2041",
        status: "active",
        removedReason: null,
        version: 1,
      },
    ],
    treatments: [],
    attendance: [
      ...[amina, joseph, grace].map((labourer) => ({
        siteId: site,
        labourerId: labourer!.id,
        workDate: day(-1),
      })),
      ...[amina, joseph, peter].map((labourer) => ({
        siteId: site,
        labourerId: labourer!.id,
        workDate: day(-2),
      })),
    ],
  };
  ruiruSafety.treatments.push({
    id: randomUUID(),
    number: 1,
    siteId: site,
    treatedAt: iso(-9, "14:25"),
    labourer: amina!,
    personName: null,
    injuryType: "sprain",
    treatment: "cold_compress",
    referral: "clinic",
    firstAiderId: ruiruSafety.aiders[0]!.id,
    incidentId: injuryId,
    status: "recorded",
    recordedBy: people.agent,
    recordedAt: iso(-9, "14:30"),
    voidReason: null,
    version: 1,
  });
  return {
    settings: {
      inductionTopics: topics,
      inductionValidityDays: null,
      inductionLookbackDays: 14,
      kitCheckIntervalDays: 30,
      ppeReplacementDays: { ...DEFAULT_PPE_REPLACEMENT_DAYS },
      version: 0,
      updatedAt: null,
    },
    projects: new Map([[ruiru.projectId, ruiruSafety]]),
  };
}

export function handleSafety(
  deps: SafetyDeps,
  state: SafetyState,
  method: string,
  path: string,
  query: URLSearchParams,
  body: unknown,
): Reply | null {
  const { fail, parse, actor } = deps;
  const has = (list: readonly string[], permissions = deps.permissions) =>
    list.some((key) => permissions.includes(key));
  const today = nairobiDate();

  // Company: settings and overview --------------------------------------------------------------
  if (path === "/safety/settings") {
    const canEdit = deps.companyPermissions.includes("config.manage");
    if (method === "PUT") {
      if (!canEdit) throw fail(403, "forbidden");
      const input = parse(updateSafetySettingsRequestSchema, body);
      if (input.version !== state.settings.version) throw fail(409, "version-conflict");
      const { version, ...values } = input;
      state.settings = { ...values, version: version + 1, updatedAt: now() };
    } else if (!canEdit && !has(SAFETY_READ_PERMISSIONS, deps.somewhere))
      throw fail(403, "forbidden");
    return {
      body: { settings: { ...state.settings, permissions: { canEdit } } },
      schema: safetySettingsResponseSchema,
    };
  }
  if (path === "/safety/overview" && method === "GET") {
    return {
      body: {
        projects: deps.projects
          .filter((project) => project.readable)
          .map((project) => {
            const data = state.projects.get(project.id) ?? empty();
            return {
              id: project.id,
              code: project.code,
              name: project.name,
              status: project.status,
              openIncidents: data.incidents.filter((row) => isOpen(row.status)).length,
              overdueActions: data.actions.filter((row) => correctiveActionOverdue(row, today))
                .length,
              flaggedLabourers: flaggedCount(data, state.settings, today),
              ppeDue: data.ppe.filter(
                (row) => row.status === "issued" && row.replacementDueOn <= today,
              ).length,
              kitsAttention: data.kits.filter((kit) =>
                attention(kitStateOf(kit, state.settings, today)),
              ).length,
            };
          }),
      },
      schema: safetyOverviewResponseSchema,
    };
  }

  const project = deps.project;
  if (!project) return null;
  if (!deps.permissions.includes("projects.view") || !has(SAFETY_READ_PERMISSIONS))
    throw fail(403, "forbidden");
  const readOnly = project.status === "closed" || project.status === "cancelled";
  const canRecord = !readOnly && has(SAFETY_RECORD_PERMISSIONS);
  const canManage = !readOnly && deps.permissions.includes("safety.manage");
  const canSeePersonal = deps.permissions.includes("safety.manage");
  let data = state.projects.get(project.id);
  if (!data) {
    data = empty();
    state.projects.set(project.id, data);
  }
  const rows = data;
  const siteName = (id: string) => deps.sites.find((site) => site.id === id)?.name ?? "—";
  const requireSite = (id: string) => {
    if (!deps.sites.some((site) => site.id === id)) throw fail(404, "not-found");
  };
  const writable = (allowed: boolean) => {
    if (readOnly) throw fail(409, "project-read-only");
    if (!allowed) throw fail(403, "forbidden");
  };
  const notFuture = (date: string) => {
    if (date > today) throw fail(409, "safety-date-future");
  };
  const labourer = (id: string): SafetyLabourer => {
    const found = deps.labourers.find((entry) => entry.id === id);
    if (!found) throw fail(422, "labourer-not-on-project");
    return { id: found.id, workerNo: found.workerNo, fullName: found.fullName };
  };
  const staffMember = (id: string, permissions: readonly string[]) => {
    const found = deps.staff.find((entry) => entry.id === id);
    if (!found || !has(permissions, found.permissions)) throw fail(422, "staff-not-on-project");
    return { id: found.id, displayName: found.displayName };
  };
  const sitePhoto = (id: string, siteId: string): SafetyPhoto => {
    const found = deps.photo(id);
    if (!found || found.siteId !== siteId) throw fail(422, "photo-not-on-site");
    return { id: found.id, verified: found.verified, caption: found.caption };
  };
  const versioned = <T extends { version: number }>(row: T | undefined, version: number) => {
    if (!row) throw fail(404, "not-found");
    if (row.version !== version) throw fail(409, "version-conflict");
    return row;
  };
  const rest = path.slice(`/projects/${project.id}/safety`.length);
  const settings = state.settings;

  // Views -----------------------------------------------------------------------------------------
  const inductionView = (row: InductionRow): Induction => {
    const validUntil = inductionValidUntil(row.inductedOn, settings.inductionValidityDays);
    return {
      ...row,
      projectId: project.id,
      siteName: siteName(row.siteId),
      code: code("IND", row.number),
      validUntil,
      state:
        row.status !== "recorded"
          ? "none"
          : validUntil === null || today <= validUntil
            ? "valid"
            : "expired",
      permissions: { canVoid: canManage && row.status === "recorded" },
    };
  };
  const talkView = (row: TalkRow): ToolboxTalk => ({
    ...row,
    projectId: project.id,
    siteName: siteName(row.siteId),
    code: code("TBT", row.number),
    attendeeCount: row.attendees.length,
    permissions: {
      canEdit: canRecord && row.status === "draft",
      canConfirm: canRecord && row.status === "draft",
      canCancel: canRecord && row.status === "draft",
      canRaiseAction: canManage && row.status === "confirmed",
    },
  });
  const talkSummary = (row: TalkRow) => {
    return without(talkView(row), "attendees");
  };
  const ppeView = (row: PpeRow): PpeIssue => ({
    ...row,
    projectId: project.id,
    siteName: siteName(row.siteId),
    replacementState:
      row.status === "issued" ? ppeReplacementState(row.replacementDueOn, today) : null,
    permissions: {
      canReturn: canRecord && row.status === "issued",
      canReplace: canRecord && row.status === "issued",
      canVoid: canManage && row.status === "issued",
    },
  });
  const actionView = (row: ActionRow): CorrectiveAction => {
    const incident = row.incidentId
      ? rows.incidents.find((entry) => entry.id === row.incidentId)
      : null;
    const talk = row.toolboxTalkId
      ? rows.talks.find((entry) => entry.id === row.toolboxTalkId)
      : null;
    const writable = !readOnly && (!incident || isOpen(incident.status));
    const independent = correctiveActionVerifierIndependent(
      { ownerId: row.ownerId, doneBy: row.doneBy?.id ?? null },
      actor.id,
    );
    const wire = without(row, "incidentId", "toolboxTalkId", "ownerId");
    return {
      ...wire,
      projectId: project.id,
      code: code("CA", row.number),
      incident: incident ? { id: incident.id, code: code("INC", incident.number) } : null,
      inspection: null,
      toolboxTalk: talk ? { id: talk.id, code: code("TBT", talk.number) } : null,
      overdue: correctiveActionOverdue(row, today),
      daysOverdue: correctiveActionDaysOverdue(row, today),
      permissions: {
        canEdit: writable && canManage && row.status === "open",
        canMarkDone: writable && row.status === "open" && row.ownerId === actor.id,
        canVerify: writable && canManage && row.status === "done" && independent,
        canReject: writable && canManage && row.status === "done" && independent,
        canCancel: writable && canManage && (row.status === "open" || row.status === "done"),
      },
    };
  };
  const incidentView = (row: IncidentRow): Incident => {
    const actions = rows.actions.filter((entry) => entry.incidentId === row.id);
    const open = isOpen(row.status);
    const blockers = open
      ? incidentCloseBlockers(
          {
            status: row.status,
            kind: row.kind,
            severity: row.severity,
            regulatorDecision: row.regulator.decision,
          },
          actions,
          null,
        )
      : [];
    const count = (status: CorrectiveActionStatus) =>
      actions.filter((entry) => entry.status === status).length;
    const role = (name: string) => row.people.filter((person) => person.role === name).length;
    const followUp = row.followUpOfId
      ? rows.incidents.find((entry) => entry.id === row.followUpOfId)
      : null;
    const { people, regulator } = row;
    const wire = without(row, "people", "regulator", "followUpOfId");
    return {
      ...wire,
      projectId: project.id,
      siteName: siteName(row.siteId),
      code: code("INC", row.number),
      people: canSeePersonal ? people : null,
      peopleCounts: {
        injured: role("injured"),
        involved: role("involved"),
        witness: role("witness"),
      },
      regulator: {
        state: regulatorState(row.kind, row.severity, regulator.decision),
        notifiedOn: regulator.notifiedOn,
        reference: regulator.reference,
        reason: regulator.reason,
        decidedBy: regulator.decidedBy,
        decidedAt: regulator.decidedAt,
      },
      actionCounts: {
        open: count("open"),
        overdue: actions.filter((entry) => correctiveActionOverdue(entry, today)).length,
        done: count("done"),
        verified: count("verified"),
        cancelled: count("cancelled"),
      },
      closeBlockers: blockers,
      followUpOf: followUp ? { id: followUp.id, code: code("INC", followUp.number) } : null,
      permissions: {
        canEdit: canManage && open,
        canInvestigate: canManage && open,
        canDecideRegulator: canManage && open,
        canClose:
          canManage &&
          row.status === "investigated" &&
          blockers.every((blocker) => blocker === "no_verified_action"),
        canVoid: canManage && open,
        canAddPhotos: canRecord && open && row.photos.length < 6,
        canRaiseAction: canManage && open,
        canSeePeople: canSeePersonal,
      },
    };
  };
  const treatmentView = (row: TreatmentRow): Treatment => {
    const aider = row.firstAiderId
      ? rows.aiders.find((entry) => entry.id === row.firstAiderId)
      : null;
    const incident = row.incidentId
      ? rows.incidents.find((entry) => entry.id === row.incidentId)
      : null;
    const incidentOpen = !incident || isOpen(incident.status);
    const wire = without(row, "firstAiderId", "incidentId");
    return {
      ...wire,
      code: code("FA", row.number),
      siteName: siteName(row.siteId),
      labourer: canSeePersonal ? row.labourer : null,
      personName: canSeePersonal ? row.personName : null,
      injuryType: canSeePersonal ? row.injuryType : null,
      treatment: canSeePersonal ? row.treatment : null,
      restricted: !canSeePersonal,
      firstAider: aider
        ? { id: aider.id, displayName: aider.labourer?.fullName ?? aider.staff?.displayName ?? "—" }
        : null,
      incident: incident ? { id: incident.id, code: code("INC", incident.number) } : null,
      permissions: {
        canVoid: canManage && row.status === "recorded" && incidentOpen,
        canLink: canManage && row.status === "recorded" && !incident,
      },
    };
  };
  const kitView = (row: KitRow): FirstAidKit => {
    const last = [...row.checks].sort((a, b) => b.checkedOn.localeCompare(a.checkedOn))[0] ?? null;
    const { checks, ...wire } = row;
    return {
      ...wire,
      siteName: siteName(row.siteId),
      lastCheck: last,
      nextCheckOn:
        row.status === "active"
          ? kitNextCheckOn(last?.checkedOn ?? null, settings.kitCheckIntervalDays)
          : null,
      state: kitState(
        {
          status: row.status,
          lastCheckedOn: last?.checkedOn ?? null,
          expiresOn: last?.expiresOn ?? null,
        },
        settings.kitCheckIntervalDays,
        today,
      ),
      checkCount: checks.length,
      permissions: {
        canCheck: canRecord && row.status === "active",
        canRetire: canManage && row.status === "active",
      },
    };
  };
  const aiderView = (row: AiderRow): FirstAider => ({
    ...row,
    siteName: siteName(row.siteId),
    certificateState: certificateState(row.certificateExpiresOn, today),
    permissions: { canRemove: canManage && row.status === "active" },
  });
  const incidentDetail = (row: IncidentRow, status = 200): Reply => ({
    status,
    body: {
      incident: incidentView(row),
      correctiveActions: rows.actions
        .filter((entry) => entry.incidentId === row.id)
        .sort((a, b) => a.number - b.number)
        .map(actionView),
      treatments: rows.treatments.filter((entry) => entry.incidentId === row.id).map(treatmentView),
    },
    schema: incidentDetailResponseSchema,
  });
  const openIncident = (id: string, version: number) => {
    const row = rows.incidents.find((entry) => entry.id === id);
    if (!row) throw fail(404, "not-found");
    if (!isOpen(row.status)) throw fail(409, "incident-not-open");
    if (row.version !== version) throw fail(409, "version-conflict");
    return row;
  };
  const coverage = (siteId: string) => {
    const from = addCalendarDays(today, -(settings.inductionLookbackDays - 1));
    return deps.labourers.map((entry) => {
      const given = rows.inductions
        .filter(
          (row) =>
            row.status === "recorded" && row.siteId === siteId && row.labourer?.id === entry.id,
        )
        .map((row) => ({ inductedOn: row.inductedOn }));
      const worked = rows.attendance
        .filter(
          (row) =>
            row.siteId === siteId &&
            row.labourerId === entry.id &&
            row.workDate >= from &&
            row.workDate <= today,
        )
        .map((row) => row.workDate);
      const status = inductionStatus(given, settings.inductionValidityDays, today);
      const days = uninductedAttendance(worked, given, settings.inductionValidityDays).reverse();
      const gang = deps.gangs.find((candidate) => candidate.id === entry.gangId);
      return {
        labourer: { id: entry.id, workerNo: entry.workerNo, fullName: entry.fullName },
        gang: gang ? { id: gang.id, name: gang.name } : null,
        state: status.state,
        inductedOn: status.inductedOn,
        validUntil: status.validUntil,
        uninductedDays: days,
        flagged: days.length > 0,
      };
    });
  };

  // Summary and options ------------------------------------------------------------------------
  if (rest === "/summary" && method === "GET")
    return {
      body: {
        incidents: {
          reported: rows.incidents.filter((row) => row.status === "reported").length,
          investigated: rows.incidents.filter((row) => row.status === "investigated").length,
          regulatorPending: rows.incidents.filter(
            (row) =>
              isOpen(row.status) &&
              regulatorState(row.kind, row.severity, row.regulator.decision) === "required",
          ).length,
          last90Days: rows.incidents.filter((row) => row.status !== "voided").length,
          nearMissesLast90Days: rows.incidents.filter((row) => row.kind === "near_miss").length,
        },
        actions: {
          open: rows.actions.filter((row) => row.status === "open").length,
          overdue: rows.actions.filter((row) => correctiveActionOverdue(row, today)).length,
          awaitingVerification: rows.actions.filter((row) => row.status === "done").length,
        },
        inductions: {
          flagged: flaggedCount(rows, settings, today),
          lookbackDays: settings.inductionLookbackDays,
        },
        talks: {
          draft: rows.talks.filter((row) => row.status === "draft").length,
          last30Days: rows.talks.filter((row) => row.status === "confirmed").length,
        },
        ppe: {
          due: rows.ppe.filter((row) => row.status === "issued" && row.replacementDueOn <= today)
            .length,
          dueSoon: rows.ppe.filter(
            (row) =>
              row.status === "issued" &&
              row.replacementDueOn > today &&
              row.replacementDueOn <= addCalendarDays(today, SAFETY_WARNING_DAYS.ppe),
          ).length,
        },
        firstAid: {
          kitsAttention: rows.kits.filter((kit) => attention(kitView(kit).state)).length,
          certificatesExpired: rows.aiders.filter(
            (row) =>
              row.status === "active" &&
              certificateState(row.certificateExpiresOn, today) === "expired",
          ).length,
        },
        permissions: { canRecord, canManage, canSeePersonal },
      },
      schema: safetySummaryResponseSchema,
    };
  if (rest === "/options" && method === "GET")
    return {
      body: {
        staff: deps.staff.map((member) => ({
          id: member.id,
          displayName: member.displayName,
          canRecord: has(SAFETY_RECORD_PERMISSIONS, member.permissions),
          canManage: member.permissions.includes("safety.manage"),
        })),
        gangs: deps.gangs.map((gang) => ({
          id: gang.id,
          name: gang.name,
          siteId: gang.siteId,
          members: gang.members.length,
        })),
        inductionTopics: settings.inductionTopics,
      },
      schema: safetyOptionsResponseSchema,
    };

  // Inductions ---------------------------------------------------------------------------------
  if (rest === "/induction-status" && method === "GET") {
    const input = parse(inductionStatusQuerySchema, Object.fromEntries(query));
    requireSite(input.siteId);
    const all = coverage(input.siteId);
    const search = input.search?.trim().toLowerCase();
    const rank = { none: 0, expired: 1, valid: 2 } as const;
    const filtered = all
      .filter((row) =>
        input.filter === "flagged"
          ? row.flagged
          : input.filter === "not_inducted"
            ? row.state !== "valid"
            : true,
      )
      .filter(
        (row) =>
          !search ||
          row.labourer.fullName.toLowerCase().includes(search) ||
          row.labourer.workerNo.toLowerCase().includes(search),
      )
      .sort(
        (a, b) =>
          Number(b.flagged) - Number(a.flagged) ||
          rank[a.state] - rank[b.state] ||
          a.labourer.fullName.localeCompare(b.labourer.fullName),
      );
    const offset = input.cursor ?? 0;
    return {
      body: {
        siteId: input.siteId,
        lookbackDays: settings.inductionLookbackDays,
        from: addCalendarDays(today, -(settings.inductionLookbackDays - 1)),
        rows: filtered.slice(offset, offset + input.limit),
        nextCursor: filtered.length > offset + input.limit ? offset + input.limit : null,
        counts: {
          labourers: all.length,
          valid: all.filter((row) => row.state === "valid").length,
          expired: all.filter((row) => row.state === "expired").length,
          none: all.filter((row) => row.state === "none").length,
          flagged: all.filter((row) => row.flagged).length,
        },
      },
      schema: inductionStatusResponseSchema,
    };
  }
  if (rest === "/inductions" && method === "GET") {
    const input = parse(inductionsQuerySchema, Object.fromEntries(query));
    const list = rows.inductions
      .filter((row) => !input.siteId || row.siteId === input.siteId)
      .filter((row) => !input.cursor || row.number < input.cursor)
      .sort((a, b) => b.number - a.number);
    const page = list.slice(0, input.limit);
    return {
      body: {
        inductions: page.map(inductionView),
        nextCursor: list.length > input.limit ? page.at(-1)!.number : null,
        permissions: { canCreate: canRecord },
      },
      schema: inductionsResponseSchema,
    };
  }
  if (rest === "/inductions" && method === "POST") {
    writable(canRecord);
    const input = parse(createInductionRequestSchema, body);
    requireSite(input.siteId);
    notFuture(input.inductedOn);
    const inductor = staffMember(input.inductorId, SAFETY_RECORD_PERMISSIONS);
    const topics = settings.inductionTopics.filter((topic) => input.topics.includes(topic.key));
    if (topics.length !== input.topics.length) throw fail(422, "induction-topic-unknown");
    const row: InductionRow = {
      id: randomUUID(),
      siteId: input.siteId,
      number: Math.max(0, ...rows.inductions.map((entry) => entry.number)) + 1,
      personKind: input.personKind,
      labourer: input.labourerId ? labourer(input.labourerId) : null,
      staff: input.userId ? staffMember(input.userId, SAFETY_READ_PERMISSIONS) : null,
      visitorName: input.visitorName ?? null,
      visitorOrganisation: input.visitorOrganisation,
      inductedOn: input.inductedOn,
      inductor,
      topics,
      topicsTotal: settings.inductionTopics.length,
      acknowledgement: input.acknowledgement,
      notes: input.notes,
      status: "recorded",
      recordedBy: actor,
      recordedAt: now(),
      voidedBy: null,
      voidedAt: null,
      voidReason: null,
      version: 1,
    };
    rows.inductions.push(row);
    return {
      status: 201,
      body: { induction: inductionView(row) },
      schema: inductionResponseSchema,
    };
  }
  let match = /^\/inductions\/([^/]+)\/void$/.exec(rest);
  if (match && method === "POST") {
    writable(canManage);
    const input = parse(voidRequestSchema, body);
    const row = versioned(
      rows.inductions.find((entry) => entry.id === match![1]),
      input.version,
    );
    if (row.status !== "recorded") throw fail(409, "invalid-transition");
    Object.assign(row, {
      status: "voided",
      voidedBy: actor,
      voidedAt: now(),
      voidReason: input.reason,
      version: row.version + 1,
    });
    return { body: { induction: inductionView(row) }, schema: inductionResponseSchema };
  }

  // Toolbox talks ------------------------------------------------------------------------------
  const attendeesFor = (input: { gangIds: string[]; labourerIds: string[] }) => {
    const attendees = new Map<
      string,
      { labourer: SafetyLabourer; gang: { id: string; name: string } | null }
    >();
    for (const gangId of input.gangIds) {
      const gang = deps.gangs.find((entry) => entry.id === gangId);
      if (!gang) throw fail(422, "gang-not-in-project");
      for (const member of gang.members)
        if (!attendees.has(member))
          attendees.set(member, {
            labourer: labourer(member),
            gang: { id: gang.id, name: gang.name },
          });
    }
    for (const id of input.labourerIds)
      if (!attendees.has(id)) attendees.set(id, { labourer: labourer(id), gang: null });
    return [...attendees.values()];
  };
  if (rest === "/talks" && method === "GET") {
    const list = [...rows.talks].sort((a, b) => b.number - a.number);
    return {
      body: {
        talks: list.map(talkSummary),
        nextCursor: null,
        permissions: { canCreate: canRecord },
      },
      schema: toolboxTalksResponseSchema,
    };
  }
  if (rest === "/talks" && method === "POST") {
    writable(canRecord);
    const input = parse(createToolboxTalkRequestSchema, body);
    requireSite(input.siteId);
    notFuture(input.heldOn);
    const attendees = attendeesFor(input);
    if (input.confirm && attendees.length + input.otherAttendees < 1)
      throw fail(409, "talk-no-attendees");
    const row: TalkRow = {
      id: randomUUID(),
      siteId: input.siteId,
      number: Math.max(0, ...rows.talks.map((entry) => entry.number)) + 1,
      heldOn: input.heldOn,
      topic: input.topic,
      notes: input.notes,
      durationMinutes: input.durationMinutes,
      presenter: staffMember(input.presenterId, SAFETY_RECORD_PERMISSIONS),
      photo: input.photoId ? sitePhoto(input.photoId, input.siteId) : null,
      otherAttendees: input.otherAttendees,
      status: input.confirm ? "confirmed" : "draft",
      createdBy: actor,
      createdAt: now(),
      confirmedBy: input.confirm ? actor : null,
      confirmedAt: input.confirm ? now() : null,
      cancelledBy: null,
      cancelledAt: null,
      cancelReason: null,
      version: input.confirm ? 2 : 1,
      attendees,
    };
    rows.talks.push(row);
    return { status: 201, body: { talk: talkView(row) }, schema: toolboxTalkResponseSchema };
  }
  match = /^\/talks\/([^/]+)(\/actions)?$/.exec(rest);
  if (match) {
    const row = rows.talks.find((entry) => entry.id === match![1]);
    if (!row) throw fail(404, "not-found");
    if (!match[2] && method === "GET")
      return { body: { talk: talkView(row) }, schema: toolboxTalkResponseSchema };
    writable(canRecord);
    if (!match[2] && method === "PUT") {
      const input = parse(updateToolboxTalkRequestSchema, body);
      versioned(row, input.version);
      if (row.status !== "draft") throw fail(409, "invalid-transition");
      notFuture(input.heldOn);
      Object.assign(row, {
        heldOn: input.heldOn,
        topic: input.topic,
        notes: input.notes,
        durationMinutes: input.durationMinutes,
        presenter: staffMember(input.presenterId, SAFETY_RECORD_PERMISSIONS),
        photo: input.photoId ? sitePhoto(input.photoId, row.siteId) : null,
        otherAttendees: input.otherAttendees,
        attendees: attendeesFor(input),
        version: row.version + 1,
      });
      return { body: { talk: talkView(row) }, schema: toolboxTalkResponseSchema };
    }
    if (match[2] && method === "POST") {
      const input = parse(toolboxTalkActionRequestSchema, body);
      versioned(row, input.version);
      const check = checkProcurementTransition(
        TOOLBOX_TALK_TRANSITIONS,
        row.status,
        input.action,
        input.reason,
      );
      if (!check.ok) throw fail(409, "invalid-transition");
      if (input.action === "confirm") {
        if (row.attendees.length + row.otherAttendees < 1) throw fail(409, "talk-no-attendees");
        Object.assign(row, { status: "confirmed", confirmedBy: actor, confirmedAt: now() });
      } else
        Object.assign(row, {
          status: "cancelled",
          cancelledBy: actor,
          cancelledAt: now(),
          cancelReason: input.reason,
        });
      row.version += 1;
      return { body: { talk: talkView(row) }, schema: toolboxTalkResponseSchema };
    }
  }

  // PPE ------------------------------------------------------------------------------------------
  if (rest === "/ppe" && method === "GET") {
    const input = parse(ppeQuerySchema, Object.fromEntries(query));
    const soon = addCalendarDays(today, SAFETY_WARNING_DAYS.ppe);
    const search = input.search?.trim().toLowerCase();
    const list = rows.ppe
      .filter((row) => !input.siteId || row.siteId === input.siteId)
      .filter((row) => !input.item || row.item === input.item)
      .filter((row) =>
        input.status === "due"
          ? row.status === "issued" && row.replacementDueOn <= soon
          : !input.status || row.status === input.status,
      )
      .filter((row) => !search || row.labourer.fullName.toLowerCase().includes(search))
      .sort(
        (a, b) =>
          a.status.localeCompare(b.status) || a.replacementDueOn.localeCompare(b.replacementDueOn),
      );
    const offset = input.cursor ?? 0;
    return {
      body: {
        issues: list.slice(offset, offset + input.limit).map(ppeView),
        nextCursor: list.length > offset + input.limit ? offset + input.limit : null,
        counts: {
          issued: rows.ppe.filter((row) => row.status === "issued").length,
          due: rows.ppe.filter((row) => row.status === "issued" && row.replacementDueOn <= today)
            .length,
          dueSoon: rows.ppe.filter(
            (row) =>
              row.status === "issued" &&
              row.replacementDueOn > today &&
              row.replacementDueOn <= soon,
          ).length,
        },
        permissions: { canIssue: canRecord },
      },
      schema: ppeIssuesResponseSchema,
    };
  }
  if (rest === "/ppe" && method === "POST") {
    writable(canRecord);
    const input = parse(issuePpeRequestSchema, body);
    requireSite(input.siteId);
    notFuture(input.issuedOn);
    const replaced = input.replacesIssueId
      ? rows.ppe.find((row) => row.id === input.replacesIssueId)
      : null;
    if (input.replacesIssueId) {
      if (!replaced) throw fail(404, "not-found");
      if (
        replaced.status !== "issued" ||
        replaced.labourer.id !== input.labourerId ||
        replaced.item !== input.item
      )
        throw fail(409, "ppe-replacement-invalid");
    }
    const row: PpeRow = {
      id: randomUUID(),
      siteId: input.siteId,
      labourer: labourer(input.labourerId),
      item: input.item,
      size: input.size,
      quantity: input.quantity,
      issuedOn: input.issuedOn,
      replacementDueOn: ppeReplacementDueOn(
        input.issuedOn,
        settings.ppeReplacementDays[input.item],
      ),
      status: "issued",
      returnedOn: null,
      returnCondition: null,
      replacesIssueId: input.replacesIssueId ?? null,
      issuedBy: actor,
      issuedAt: now(),
      returnedBy: null,
      voidedBy: null,
      voidedAt: null,
      voidReason: null,
      version: 1,
    };
    rows.ppe.push(row);
    if (replaced) Object.assign(replaced, { status: "replaced", version: replaced.version + 1 });
    return { status: 201, body: { issue: ppeView(row) }, schema: ppeIssueResponseSchema };
  }
  match = /^\/ppe\/([^/]+)\/(return|void)$/.exec(rest);
  if (match && method === "POST") {
    const row = rows.ppe.find((entry) => entry.id === match![1]);
    if (match[2] === "return") {
      writable(canRecord);
      const input = parse(returnPpeRequestSchema, body);
      versioned(row, input.version);
      if (row!.status !== "issued") throw fail(409, "invalid-transition");
      notFuture(input.returnedOn);
      if (input.returnedOn < row!.issuedOn) throw fail(409, "ppe-return-before-issue");
      Object.assign(row!, {
        status: "returned",
        returnedOn: input.returnedOn,
        returnCondition: input.condition,
        returnedBy: actor,
        version: row!.version + 1,
      });
    } else {
      writable(canManage);
      const input = parse(voidRequestSchema, body);
      versioned(row, input.version);
      if (row!.status !== "issued") throw fail(409, "invalid-transition");
      Object.assign(row!, {
        status: "voided",
        voidedBy: actor,
        voidedAt: now(),
        voidReason: input.reason,
        version: row!.version + 1,
      });
    }
    return { body: { issue: ppeView(row!) }, schema: ppeIssueResponseSchema };
  }

  // Incidents --------------------------------------------------------------------------------------
  const peopleFor = (
    input: {
      role: IncidentPerson["role"];
      labourerId?: string;
      userId?: string;
      name?: string;
      injuryType?: IncidentPerson["injuryType"];
      bodyPart?: IncidentPerson["bodyPart"];
    }[],
  ) =>
    input.map((person) => ({
      id: randomUUID(),
      role: person.role,
      labourer: person.labourerId ? labourer(person.labourerId) : null,
      staff: person.userId ? staffMember(person.userId, SAFETY_READ_PERMISSIONS) : null,
      name: person.name ?? null,
      injuryType: person.injuryType ?? null,
      bodyPart: person.bodyPart ?? null,
    }));
  if (rest === "/incidents" && method === "GET") {
    const input = parse(incidentsQuerySchema, Object.fromEntries(query));
    const search = input.search?.trim().toLowerCase();
    const list = rows.incidents
      .filter((row) => !input.siteId || row.siteId === input.siteId)
      .filter((row) => !input.kind || row.kind === input.kind)
      .filter((row) =>
        input.status === "open" ? isOpen(row.status) : !input.status || row.status === input.status,
      )
      .filter(
        (row) =>
          !search ||
          row.location.toLowerCase().includes(search) ||
          row.description.toLowerCase().includes(search),
      )
      .filter((row) => !input.cursor || row.number < input.cursor)
      .sort((a, b) => b.number - a.number);
    const page = list.slice(0, input.limit);
    return {
      body: {
        incidents: page.map(incidentView),
        nextCursor: list.length > input.limit ? page.at(-1)!.number : null,
        counts: {
          reported: rows.incidents.filter((row) => row.status === "reported").length,
          investigated: rows.incidents.filter((row) => row.status === "investigated").length,
          closed: rows.incidents.filter((row) => row.status === "closed").length,
          regulatorPending: rows.incidents.filter(
            (row) =>
              isOpen(row.status) &&
              regulatorState(row.kind, row.severity, row.regulator.decision) === "required",
          ).length,
        },
        permissions: { canReport: canRecord },
      },
      schema: incidentsResponseSchema,
    };
  }
  if (rest === "/incidents" && method === "POST") {
    writable(canRecord);
    const input = parse(reportIncidentRequestSchema, body);
    requireSite(input.siteId);
    if (new Date(input.occurredAt).getTime() > Date.now() + 300_000)
      throw fail(409, "safety-date-future");
    const row: IncidentRow = {
      id: randomUUID(),
      siteId: input.siteId,
      number: Math.max(0, ...rows.incidents.map((entry) => entry.number)) + 1,
      kind: input.kind,
      severity: input.severity,
      occurredAt: new Date(input.occurredAt).toISOString(),
      location: input.location,
      description: input.description,
      immediateActions: input.immediateActions,
      firstAidGiven: input.firstAidGiven,
      people: peopleFor(input.people),
      photos: input.photoIds.map((id) => sitePhoto(id, input.siteId)),
      status: "reported",
      reportedBy: actor,
      reportedAt: now(),
      investigation: null,
      regulator: {
        decision: null,
        notifiedOn: null,
        reference: null,
        reason: null,
        decidedBy: null,
        decidedAt: null,
      },
      closedBy: null,
      closedAt: null,
      closureNote: null,
      noActionReason: null,
      voidedBy: null,
      voidedAt: null,
      voidReason: null,
      followUpOfId: input.followUpOfId ?? null,
      version: 1,
    };
    rows.incidents.push(row);
    return incidentDetail(row, 201);
  }
  match = /^\/incidents\/([^/]+)(?:\/(investigation|regulator|close|void|photos))?$/.exec(rest);
  if (match) {
    const id = match[1]!;
    const verb = match[2];
    if (!verb && method === "GET") {
      const row = rows.incidents.find((entry) => entry.id === id);
      if (!row) throw fail(404, "not-found");
      return incidentDetail(row);
    }
    if (verb === "photos" && method === "POST") {
      writable(canRecord);
      const input = parse(addIncidentPhotosRequestSchema, body);
      const row = openIncident(id, input.version);
      const added = input.photoIds
        .filter((photoId) => !row.photos.some((photo) => photo.id === photoId))
        .map((photoId) => sitePhoto(photoId, row.siteId));
      if (row.photos.length + added.length > 6) throw fail(409, "invalid-transition");
      row.photos.push(...added);
      row.version += 1;
      return incidentDetail(row);
    }
    writable(canManage);
    if (!verb && method === "PATCH") {
      const input = parse(updateIncidentRequestSchema, body);
      const row = openIncident(id, input.version);
      const people = input.people ? peopleFor(input.people) : row.people;
      const kind = input.kind ?? row.kind;
      const injured = people.some((person) => person.role === "injured");
      if (kind === "injury" && !injured) throw fail(422, "injured-person-required");
      if (kind === "near_miss" && injured) throw fail(422, "near-miss-without-injury");
      Object.assign(row, {
        kind,
        severity: input.severity ?? row.severity,
        location: input.location ?? row.location,
        description: input.description ?? row.description,
        immediateActions:
          input.immediateActions === undefined ? row.immediateActions : input.immediateActions,
        firstAidGiven: input.firstAidGiven ?? row.firstAidGiven,
        people,
        version: row.version + 1,
      });
      return incidentDetail(row);
    }
    if (verb === "investigation" && method === "POST") {
      const input = parse(investigateIncidentRequestSchema, body);
      const row = openIncident(id, input.version);
      Object.assign(row, {
        status: "investigated",
        investigation: {
          rootCauseCategory: input.rootCauseCategory,
          rootCause: input.rootCause,
          contributingFactors: input.contributingFactors,
          investigatedBy: actor,
          investigatedAt: now(),
        },
        version: row.version + 1,
      });
      return incidentDetail(row);
    }
    if (verb === "regulator" && method === "POST") {
      const input = parse(regulatorDecisionRequestSchema, body);
      const row = openIncident(id, input.version);
      if (input.notifiedOn) notFuture(input.notifiedOn);
      row.regulator = {
        decision: input.decision,
        notifiedOn: input.decision === "notified" ? input.notifiedOn! : null,
        reference: input.decision === "notified" ? (input.reference ?? null) : null,
        reason: input.decision === "notified" ? null : input.reason!,
        decidedBy: actor,
        decidedAt: now(),
      };
      row.version += 1;
      return incidentDetail(row);
    }
    if (verb === "close" && method === "POST") {
      const input = parse(closeIncidentRequestSchema, body);
      const row = openIncident(id, input.version);
      const actions = rows.actions.filter((entry) => entry.incidentId === row.id);
      const blockers = incidentCloseBlockers(
        {
          status: row.status,
          kind: row.kind,
          severity: row.severity,
          regulatorDecision: row.regulator.decision,
        },
        actions,
        input.noActionReason,
      );
      if (blockers.length) throw fail(409, "incident-close-blocked");
      const verified = actions.some((entry) => entry.status === "verified");
      Object.assign(row, {
        status: "closed",
        closedBy: actor,
        closedAt: now(),
        closureNote: input.closureNote,
        noActionReason: verified ? null : input.noActionReason,
        version: row.version + 1,
      });
      return incidentDetail(row);
    }
    if (verb === "void" && method === "POST") {
      const input = parse(voidRequestSchema, body);
      const row = openIncident(id, input.version);
      if (
        rows.actions.some(
          (entry) =>
            entry.incidentId === row.id && (entry.status === "open" || entry.status === "done"),
        )
      )
        throw fail(409, "incident-actions-outstanding");
      Object.assign(row, {
        status: "voided",
        voidedBy: actor,
        voidedAt: now(),
        voidReason: input.reason,
        version: row.version + 1,
      });
      return incidentDetail(row);
    }
  }

  // Corrective actions --------------------------------------------------------------------------
  if (rest === "/corrective-actions" && method === "GET") {
    const input = parse(correctiveActionsQuerySchema, Object.fromEntries(query));
    const search = input.search?.trim().toLowerCase();
    const list = rows.actions
      .filter((row) =>
        input.status === "active"
          ? row.status === "open" || row.status === "done"
          : input.status === "overdue"
            ? correctiveActionOverdue(row, today)
            : !input.status || row.status === input.status,
      )
      .filter((row) => !input.incidentId || row.incidentId === input.incidentId)
      .filter((row) => input.mine !== "true" || row.ownerId === actor.id)
      .filter((row) => !search || row.description.toLowerCase().includes(search))
      .sort(compareCorrectiveActions(today));
    const offset = input.cursor ?? 0;
    return {
      body: {
        actions: list.slice(offset, offset + input.limit).map(actionView),
        nextCursor: list.length > offset + input.limit ? offset + input.limit : null,
        counts: {
          open: rows.actions.filter((row) => row.status === "open").length,
          overdue: rows.actions.filter((row) => correctiveActionOverdue(row, today)).length,
          done: rows.actions.filter((row) => row.status === "done").length,
          verified: rows.actions.filter((row) => row.status === "verified").length,
        },
        permissions: { canCreate: canManage },
      },
      schema: correctiveActionsResponseSchema,
    };
  }
  if (rest === "/corrective-actions" && method === "POST") {
    writable(canManage);
    const input = parse(createCorrectiveActionRequestSchema, body);
    const owner = staffMember(input.ownerId, SAFETY_READ_PERMISSIONS);
    if (input.incidentId) {
      const incident = rows.incidents.find((entry) => entry.id === input.incidentId);
      if (!incident) throw fail(404, "not-found");
      if (!isOpen(incident.status)) throw fail(409, "incident-not-open");
    }
    if (
      input.toolboxTalkId &&
      rows.talks.find((entry) => entry.id === input.toolboxTalkId)?.status !== "confirmed"
    )
      throw fail(422, "action-source-invalid");
    if (input.inspectionId) throw fail(422, "action-source-invalid");
    const row: ActionRow = {
      id: randomUUID(),
      number: Math.max(0, ...rows.actions.map((entry) => entry.number)) + 1,
      source: input.source,
      incidentId: input.incidentId ?? null,
      toolboxTalkId: input.toolboxTalkId ?? null,
      description: input.description,
      ownerId: owner.id,
      owner,
      dueOn: input.dueOn,
      status: "open",
      doneBy: null,
      doneAt: null,
      doneNote: null,
      verifiedBy: null,
      verifiedAt: null,
      rejectCount: 0,
      lastRejectReason: null,
      cancelledBy: null,
      cancelledAt: null,
      cancelReason: null,
      raisedBy: actor,
      raisedAt: now(),
      version: 1,
    };
    rows.actions.push(row);
    return {
      status: 201,
      body: { action: actionView(row) },
      schema: correctiveActionResponseSchema,
    };
  }
  match = /^\/corrective-actions\/([^/]+)(\/actions)?$/.exec(rest);
  if (match) {
    const row = rows.actions.find((entry) => entry.id === match![1]);
    if (!row) throw fail(404, "not-found");
    if (!match[2] && method === "GET")
      return { body: { action: actionView(row) }, schema: correctiveActionResponseSchema };
    const incident = row.incidentId
      ? rows.incidents.find((entry) => entry.id === row.incidentId)
      : null;
    if (incident && !isOpen(incident.status)) throw fail(409, "incident-not-open");
    if (!match[2] && method === "PATCH") {
      writable(canManage);
      const input = parse(updateCorrectiveActionRequestSchema, body);
      versioned(row, input.version);
      if (row.status !== "open") throw fail(409, "invalid-transition");
      if (input.ownerId) {
        row.owner = staffMember(input.ownerId, SAFETY_READ_PERMISSIONS);
        row.ownerId = input.ownerId;
      }
      Object.assign(row, {
        description: input.description ?? row.description,
        dueOn: input.dueOn ?? row.dueOn,
        version: row.version + 1,
      });
      return { body: { action: actionView(row) }, schema: correctiveActionResponseSchema };
    }
    if (match[2] && method === "POST") {
      const input = parse(correctiveActionActionRequestSchema, body);
      writable(input.action === "done" ? true : canManage);
      versioned(row, input.version);
      const check = checkProcurementTransition(
        CORRECTIVE_ACTION_TRANSITIONS,
        row.status,
        input.action,
        input.reason,
      );
      if (!check.ok) throw fail(409, "invalid-transition");
      if (input.action === "done" && row.ownerId !== actor.id) throw fail(403, "action-owner-only");
      if (
        (input.action === "verify" || input.action === "reject") &&
        !correctiveActionVerifierIndependent(
          { ownerId: row.ownerId, doneBy: row.doneBy?.id ?? null },
          actor.id,
        )
      )
        throw fail(403, "action-independent-verification");
      if (input.action === "done")
        Object.assign(row, {
          status: "done",
          doneBy: actor,
          doneAt: now(),
          doneNote: input.note ?? null,
        });
      else if (input.action === "verify")
        Object.assign(row, { status: "verified", verifiedBy: actor, verifiedAt: now() });
      else if (input.action === "reject")
        Object.assign(row, {
          status: "open",
          doneBy: null,
          doneAt: null,
          doneNote: null,
          rejectCount: row.rejectCount + 1,
          lastRejectReason: input.reason,
        });
      else
        Object.assign(row, {
          status: "cancelled",
          cancelledBy: actor,
          cancelledAt: now(),
          cancelReason: input.reason,
        });
      row.version += 1;
      return { body: { action: actionView(row) }, schema: correctiveActionResponseSchema };
    }
  }

  // First aid ----------------------------------------------------------------------------------
  if (rest === "/first-aid" && method === "GET") {
    const treatments = [...rows.treatments].sort((a, b) => b.number - a.number);
    const kits = rows.kits.map(kitView);
    return {
      body: {
        kits,
        firstAiders: rows.aiders.filter((row) => row.status === "active").map(aiderView),
        treatments: treatments.map(treatmentView),
        nextCursor: null,
        kitCheckIntervalDays: settings.kitCheckIntervalDays,
        counts: {
          kitsAttention: kits.filter((kit) => attention(kit.state)).length,
          certificatesExpired: rows.aiders.filter(
            (row) =>
              row.status === "active" &&
              certificateState(row.certificateExpiresOn, today) === "expired",
          ).length,
          treatmentsLast30Days: rows.treatments.filter((row) => row.status === "recorded").length,
        },
        permissions: { canRecord, canManage, canSeePersonal },
      },
      schema: firstAidResponseSchema,
    };
  }
  if (rest === "/first-aid/kits" && method === "POST") {
    writable(canManage);
    const input = parse(createFirstAidKitRequestSchema, body);
    requireSite(input.siteId);
    if (rows.kits.some((kit) => kit.siteId === input.siteId && kit.label === input.label))
      throw fail(409, "kit-label-taken");
    const row: KitRow = {
      id: randomUUID(),
      siteId: input.siteId,
      label: input.label,
      location: input.location,
      status: "active",
      retiredReason: null,
      version: 1,
      checks: [],
    };
    rows.kits.push(row);
    return { status: 201, body: { kit: kitView(row) }, schema: firstAidKitResponseSchema };
  }
  match = /^\/first-aid\/kits\/([^/]+)\/(checks|retire)$/.exec(rest);
  if (match && method === "POST") {
    const row = rows.kits.find((kit) => kit.id === match![1]);
    if (!row) throw fail(404, "not-found");
    if (row.status !== "active") throw fail(409, "kit-retired");
    if (match[2] === "checks") {
      writable(canRecord);
      const input = parse(recordKitCheckRequestSchema, body);
      notFuture(input.checkedOn);
      row.checks.push({ ...input, checkedBy: actor });
      return { status: 201, body: { kit: kitView(row) }, schema: firstAidKitResponseSchema };
    }
    writable(canManage);
    const input = parse(voidRequestSchema, body);
    versioned(row, input.version);
    Object.assign(row, {
      status: "retired",
      retiredReason: input.reason,
      version: row.version + 1,
    });
    return { body: { kit: kitView(row) }, schema: firstAidKitResponseSchema };
  }
  if (rest === "/first-aid/first-aiders" && method === "POST") {
    writable(canManage);
    const input = parse(addFirstAiderRequestSchema, body);
    requireSite(input.siteId);
    const person = input.labourerId ? labourer(input.labourerId) : null;
    const staff = input.userId ? staffMember(input.userId, SAFETY_READ_PERMISSIONS) : null;
    if (
      rows.aiders.some(
        (row) =>
          row.status === "active" &&
          row.siteId === input.siteId &&
          ((person && row.labourer?.id === person.id) || (staff && row.staff?.id === staff.id)),
      )
    )
      throw fail(409, "first-aider-exists");
    const row: AiderRow = {
      id: randomUUID(),
      siteId: input.siteId,
      labourer: person,
      staff,
      certificateExpiresOn: input.certificateExpiresOn,
      certificateReference: input.certificateReference,
      status: "active",
      removedReason: null,
      version: 1,
    };
    rows.aiders.push(row);
    return { status: 201, body: { firstAider: aiderView(row) }, schema: firstAiderResponseSchema };
  }
  match = /^\/first-aid\/first-aiders\/([^/]+)\/remove$/.exec(rest);
  if (match && method === "POST") {
    writable(canManage);
    const input = parse(voidRequestSchema, body);
    const row = versioned(
      rows.aiders.find((entry) => entry.id === match![1]),
      input.version,
    );
    if (row.status !== "active") throw fail(409, "invalid-transition");
    Object.assign(row, {
      status: "removed",
      removedReason: input.reason,
      version: row.version + 1,
    });
    return { body: { firstAider: aiderView(row) }, schema: firstAiderResponseSchema };
  }
  if (rest === "/first-aid/treatments" && method === "POST") {
    writable(canRecord);
    const input = parse(recordTreatmentRequestSchema, body);
    requireSite(input.siteId);
    if (new Date(input.treatedAt).getTime() > Date.now() + 300_000)
      throw fail(409, "safety-date-future");
    if (
      input.firstAiderId &&
      !rows.aiders.some((row) => row.id === input.firstAiderId && row.siteId === input.siteId)
    )
      throw fail(422, "first-aider-not-on-site");
    if (
      input.incidentId &&
      !isOpen(rows.incidents.find((row) => row.id === input.incidentId)?.status ?? "voided")
    )
      throw fail(409, "incident-not-open");
    const row: TreatmentRow = {
      id: randomUUID(),
      number: Math.max(0, ...rows.treatments.map((entry) => entry.number)) + 1,
      siteId: input.siteId,
      treatedAt: new Date(input.treatedAt).toISOString(),
      labourer: input.labourerId ? labourer(input.labourerId) : null,
      personName: input.personName ?? null,
      injuryType: input.injuryType,
      treatment: input.treatment,
      referral: input.referral,
      firstAiderId: input.firstAiderId ?? null,
      incidentId: input.incidentId ?? null,
      status: "recorded",
      recordedBy: actor,
      recordedAt: now(),
      voidReason: null,
      version: 1,
    };
    rows.treatments.push(row);
    return {
      status: 201,
      body: { treatment: treatmentView(row) },
      schema: treatmentResponseSchema,
    };
  }
  match = /^\/first-aid\/treatments\/([^/]+)\/(void|link)$/.exec(rest);
  if (match && method === "POST") {
    writable(canManage);
    const row = rows.treatments.find((entry) => entry.id === match![1]);
    if (!row) throw fail(404, "not-found");
    if (row.status !== "recorded") throw fail(409, "invalid-transition");
    const current = row.incidentId
      ? rows.incidents.find((entry) => entry.id === row.incidentId)
      : null;
    if (current && !isOpen(current.status)) throw fail(409, "incident-not-open");
    if (match[2] === "void") {
      const input = parse(voidRequestSchema, body);
      versioned(row, input.version);
      Object.assign(row, { status: "voided", voidReason: input.reason, version: row.version + 1 });
    } else {
      const input = parse(linkTreatmentRequestSchema, body);
      versioned(row, input.version);
      if (row.incidentId) throw fail(409, "treatment-linked");
      if (
        !isOpen(rows.incidents.find((entry) => entry.id === input.incidentId)?.status ?? "voided")
      )
        throw fail(409, "incident-not-open");
      Object.assign(row, { incidentId: input.incidentId, version: row.version + 1 });
    }
    return { body: { treatment: treatmentView(row) }, schema: treatmentResponseSchema };
  }
  throw fail(404, "not-found");
}

const isOpen = (status: IncidentStatus) => status === "reported" || status === "investigated";

/** Labourers who worked at a site in the look-back window without a valid induction there. */
function flaggedCount(target: ProjectSafety, settings: SafetyState["settings"], today: string) {
  const from = addCalendarDays(today, -(settings.inductionLookbackDays - 1));
  const flagged = new Set<string>();
  for (const record of target.attendance) {
    if (record.workDate < from || record.workDate > today) continue;
    const given = target.inductions
      .filter(
        (row) =>
          row.status === "recorded" &&
          row.siteId === record.siteId &&
          row.labourer?.id === record.labourerId,
      )
      .map((row) => ({ inductedOn: row.inductedOn }));
    if (uninductedAttendance([record.workDate], given, settings.inductionValidityDays).length)
      flagged.add(record.labourerId);
  }
  return flagged.size;
}

function kitStateOf(kit: KitRow, settings: SafetyState["settings"], today: string) {
  const last = [...kit.checks].sort((a, b) => b.checkedOn.localeCompare(a.checkedOn))[0] ?? null;
  return kitState(
    {
      status: kit.status,
      lastCheckedOn: last?.checkedOn ?? null,
      expiresOn: last?.expiresOn ?? null,
    },
    settings.kitCheckIntervalDays,
    today,
  );
}
const attention = (state: FirstAidKit["state"]) =>
  state === "never_checked" || state === "check_due" || state === "expired" || state === "expiring";
