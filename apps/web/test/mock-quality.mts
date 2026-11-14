/**
 * D6.1 quality for the mock API: company checklist templates (versioned), inspections with an
 * independent sign-off, snags with an independent verifier, concrete cube and slump tests with
 * corrections, and practical completion with the defects liability period. It computes with the
 * shared domain rules (packages/domain) and returns the shared response schemas, so the browser
 * tests exercise the real wire contract. Dates are relative to today in Nairobi. Synthetic data.
 */
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import {
  addCalendarDays,
  assessCubes,
  assessSlump,
  checkProcurementTransition,
  classStrength,
  completionBlockers,
  COMPLETION_TRANSITIONS,
  cubeAgeState,
  cubeDueDate,
  dlpEndDate,
  dlpState,
  inspectionOutcome,
  inspectionReviewIndependent,
  inspectionSubmitIssues,
  INSPECTION_TRANSITIONS,
  nairobiDate,
  snagDecisionIndependent,
  SNAG_TRANSITIONS,
} from "@pm-buddy/domain";
import {
  CUBE_TEST_AGES,
  QUALITY_READ_PERMISSIONS,
  QUALITY_RECORD_PERMISSIONS,
  STARTER_CHECKLIST_TEMPLATES,
  type CompletionKind,
  type ConcreteClass,
  type CubeTestAge,
  type InspectionCategory,
  type InspectionItemResult,
  type InspectorType,
  type SnagResponsibleKind,
  type SnagSeverity,
} from "@pm-buddy/types";
import {
  checklistTemplateResponseSchema,
  checklistTemplatesResponseSchema,
  completionActionRequestSchema,
  completionResponseSchema,
  correctCubeResultRequestSchema,
  correctSlumpTestRequestSchema,
  createChecklistTemplateRequestSchema,
  createCubeSetRequestSchema,
  createInspectionRequestSchema,
  createSlumpTestRequestSchema,
  createSnagRequestSchema,
  cubeSetResponseSchema,
  cubeSetsQuerySchema,
  cubeSetsResponseSchema,
  inspectionActionRequestSchema,
  inspectionDetailResponseSchema,
  inspectionsQuerySchema,
  inspectionsResponseSchema,
  loadStarterTemplatesRequestSchema,
  loadStarterTemplatesResponseSchema,
  proposeCompletionRequestSchema,
  qualitySettingsResponseSchema,
  qualitySummaryResponseSchema,
  recordCubeResultRequestSchema,
  retireChecklistTemplateRequestSchema,
  reviseChecklistTemplateRequestSchema,
  slumpTestResponseSchema,
  slumpTestsQuerySchema,
  slumpTestsResponseSchema,
  snagActionRequestSchema,
  snagResponseSchema,
  snagsQuerySchema,
  snagsResponseSchema,
  updateInspectionRequestSchema,
  updateQualitySettingsRequestSchema,
  updateSnagRequestSchema,
  voidCubeSetRequestSchema,
  type CompletionCertificate,
  type CubeResult,
  type CubeSet,
  type Inspection,
  type QualityPhoto,
  type SlumpTest,
  type Snag,
} from "@pm-buddy/validation";

type Person = { id: string; displayName: string };
type Template = {
  id: string;
  lineageId: string;
  version: number;
  name: string;
  category: InspectionCategory;
  description: string | null;
  retired: boolean;
  items: string[];
  createdBy: Person;
  createdAt: string;
};
type InspectionRow = {
  id: string;
  siteId: string;
  number: number;
  templateId: string;
  location: string;
  inspectorType: InspectorType;
  inspectorName: string | null;
  inspectedOn: string;
  wbsNodeId: string | null;
  notes: string | null;
  status: Inspection["status"];
  result: Inspection["result"];
  version: number;
  createdBy: Person;
  createdAt: string;
  submittedBy: Person | null;
  submittedAt: string | null;
  signedOffBy: Person | null;
  signedOffAt: string | null;
  returnedBy: Person | null;
  returnedAt: string | null;
  returnReason: string | null;
  items: {
    id: string;
    text: string;
    result: InspectionItemResult;
    note: string | null;
    photos: QualityPhoto[];
  }[];
};
type SnagRow = Omit<Snag, "projectId" | "siteName" | "code" | "overdue" | "permissions">;
type CubeRow = {
  id: string;
  siteId: string;
  number: number;
  element: string;
  concreteClass: ConcreteClass;
  castOn: string;
  cubesPerAge: number;
  batchReference: string | null;
  status: "active" | "void";
  voidReason: string | null;
  version: number;
  createdBy: Person;
  createdAt: string;
  results: CubeResult[];
};
type SlumpRow = Omit<SlumpTest, "projectId" | "siteName" | "code" | "permissions" | "current"> & {
  siteId: string;
};
type CompletionRow = Omit<CompletionCertificate, "permissions">;
type ProjectQuality = {
  inspections: InspectionRow[];
  snags: SnagRow[];
  cubes: CubeRow[];
  slump: SlumpRow[];
  completions: CompletionRow[];
};
export type QualityState = {
  templates: Template[];
  settings: {
    dlpMonths: number;
    cubeOverdueGraceDays: number;
    version: number;
    updatedAt: string | null;
  };
  projects: Map<string, ProjectQuality>;
};
export type QualityDeps = {
  /** null for the company-level routes (templates, settings). */
  project: { id: string; status: string } | null;
  sites: { id: string; name: string }[];
  wbs: { id: string; code: string; name: string }[];
  /** Effective permissions on the project (role ∩ assignment). */
  permissions: readonly string[];
  /** Permissions held on some project (company-level reads and template writes). */
  somewhere: readonly string[];
  companyPermissions: readonly string[];
  actor: Person;
  photo: (id: string) => QualityPhoto | null;
  fail: (status: number, code: string) => Error;
  parse: <T>(schema: z.ZodType<T>, body: unknown) => T;
};
type Reply = { status?: number; body: unknown; schema: z.ZodType<unknown> };

const now = () => new Date().toISOString();
const code = (prefix: string, number: number) => `${prefix}-${String(number).padStart(4, "0")}`;

export function initialQuality(
  ruiru: { projectId: string; siteId: string },
  people: { owner: Person; pm: Person; agent: Person },
): QualityState {
  const today = nairobiDate();
  const day = (offset: number) => addCalendarDays(today, offset);
  const at = (offset: number) => `${day(offset)}T07:30:00.000Z`;
  const templates: Template[] = STARTER_CHECKLIST_TEMPLATES.filter((starter) =>
    ["setting_out", "slab", "blockwork", "handover"].includes(starter.key),
  ).map((starter) => {
    const id = randomUUID();
    return {
      id,
      lineageId: id,
      version: 1,
      name: starter.name.en,
      category: starter.category,
      description: null,
      retired: false,
      items: starter.items.map((item) => item.en),
      createdBy: people.owner,
      createdAt: at(-120),
    };
  });
  const template = (category: InspectionCategory) =>
    templates.find((entry) => entry.category === category)!;
  const inspection = (
    number: number,
    category: InspectionCategory,
    location: string,
    results: InspectionItemResult[],
    status: InspectionRow["status"],
    offset: number,
  ): InspectionRow => {
    const source = template(category);
    const items = source.items.map((text, index) => {
      const result = results[index] ?? "pass";
      return {
        id: randomUUID(),
        text,
        result,
        note: result === "fail" ? "Synthetic: lintel bearing 100 mm, 150 mm required" : null,
        photos: [],
      };
    });
    return {
      id: randomUUID(),
      siteId: ruiru.siteId,
      number,
      templateId: source.id,
      location,
      inspectorType: category === "blockwork" ? "county" : "consultant",
      inspectorName: category === "blockwork" ? "County inspector (synthetic)" : null,
      inspectedOn: day(offset),
      wbsNodeId: null,
      notes: null,
      status,
      result: status === "draft" ? null : inspectionOutcome(items.map((item) => item.result)),
      version: status === "signed_off" ? 4 : 3,
      createdBy: people.agent,
      createdAt: at(offset),
      submittedBy: people.agent,
      submittedAt: at(offset),
      signedOffBy: status === "signed_off" ? people.pm : null,
      signedOffAt: status === "signed_off" ? at(offset + 1) : null,
      returnedBy: null,
      returnedAt: null,
      returnReason: null,
      items,
    };
  };
  const slab = inspection(1, "slab", "First floor slab, bays 1–4", [], "signed_off", -40);
  const walling = inspection(
    2,
    "blockwork",
    "Second floor, block A walling",
    ["pass", "pass", "pass", "fail"],
    "submitted",
    -3,
  );
  const snag = (
    number: number,
    fields: Partial<SnagRow> & Pick<SnagRow, "location" | "description" | "severity">,
  ): SnagRow => ({
    id: randomUUID(),
    siteId: ruiru.siteId,
    number,
    responsibleKind: "gang",
    responsibleName: "Gang B: masonry and plaster",
    dueOn: day(3),
    phase: "construction",
    inspection: null,
    status: "open",
    fixNote: null,
    reopenCount: 0,
    lastReopenReason: null,
    photos: { raised: [], fixed: [], earlierFixes: [] },
    raisedBy: people.agent,
    raisedAt: at(-3),
    fixedBy: null,
    fixedAt: null,
    closedBy: null,
    closedAt: null,
    version: 1,
    ...fields,
  });
  const snags: SnagRow[] = [
    snag(1, {
      location: "Second floor, door D3",
      description: "Lintel bearing short: extend the bearing before loading",
      severity: "critical",
      inspection: {
        id: walling.id,
        code: code("INS", walling.number),
        itemText: walling.items[3]!.text,
      },
    }),
    snag(2, {
      location: "Ground floor stair core",
      description: "Honeycombing at the base of column C4",
      severity: "major",
      status: "fixed",
      fixNote: "Hacked back and made good",
      fixedBy: people.agent,
      fixedAt: at(-1),
      version: 2,
    }),
    snag(3, {
      location: "Main plot hoarding by the gate",
      description: "Hoarding panel loose",
      severity: "minor",
      dueOn: day(-5),
      responsibleKind: "supplier",
      responsibleName: "Hoarding hire company (synthetic)",
    }),
  ];
  const cubeSet = (
    number: number,
    element: string,
    castOffset: number,
    results: { age: CubeTestAge; strengths: string[] }[],
  ): CubeRow => {
    const castOn = day(castOffset);
    return {
      id: randomUUID(),
      siteId: ruiru.siteId,
      number,
      element,
      concreteClass: "C25",
      castOn,
      cubesPerAge: 3,
      batchReference: null,
      status: "active",
      voidReason: null,
      version: 1,
      createdBy: people.agent,
      createdAt: at(castOffset),
      results: results.map(({ age, strengths }) => {
        const assessment = assessCubes("C25", age, strengths);
        return {
          id: randomUUID(),
          ageDays: age,
          testedOn: addCalendarDays(castOn, age),
          strengths,
          ...assessment,
          laboratory: "Synthetic Materials Lab",
          reportReference: null,
          supersedesId: null,
          correctionReason: null,
          current: true,
          recordedBy: people.agent,
          recordedAt: `${addCalendarDays(castOn, age)}T09:00:00.000Z`,
        };
      }),
    };
  };
  const cubes = [
    cubeSet(1, "Ground floor slab", -60, [
      { age: 7, strengths: ["17.8", "18.4", "18.1"] },
      { age: 28, strengths: ["27.6", "28.9", "26.8"] },
    ]),
    cubeSet(2, "First floor slab, bay 2", -40, [
      { age: 7, strengths: ["15.0", "15.6", "14.8"] },
      { age: 28, strengths: ["22.4", "21.6", "23.9"] },
    ]),
    cubeSet(3, "Roof beam, gridlines A–C", -10, []),
  ];
  const slump: SlumpRow[] = [
    {
      id: randomUUID(),
      siteId: ruiru.siteId,
      number: 1,
      testedOn: day(-60),
      element: "Ground floor slab",
      concreteClass: "C25",
      cubeSet: { id: cubes[0]!.id, code: "CUBE-0001" },
      targetMm: 75,
      toleranceMm: 20,
      measuredMm: 80,
      deviationMm: 5,
      outcome: "pass",
      ruleVersion: "KE-SLUMP-1",
      notes: null,
      supersedesId: null,
      correctionReason: null,
      recordedBy: people.agent,
      recordedAt: at(-60),
    },
  ];
  return {
    templates,
    settings: { dlpMonths: 6, cubeOverdueGraceDays: 2, version: 0, updatedAt: null },
    projects: new Map([
      [ruiru.projectId, { inspections: [slab, walling], snags, cubes, slump, completions: [] }],
    ]),
  };
}

export function handleQuality(
  deps: QualityDeps,
  state: QualityState,
  method: string,
  path: string,
  query: URLSearchParams,
  body: unknown,
): Reply | null {
  const { fail, parse, actor } = deps;
  const has = (list: readonly string[], permissions = deps.permissions) =>
    list.some((key) => permissions.includes(key));

  // Company: templates and settings -----------------------------------------------------------
  if (path === "/quality/settings") {
    const canEdit = deps.companyPermissions.includes("config.manage");
    if (method === "PUT") {
      if (!canEdit) throw fail(403, "forbidden");
      const input = parse(updateQualitySettingsRequestSchema, body);
      if (input.version !== state.settings.version) throw fail(409, "version-conflict");
      state.settings = {
        dlpMonths: input.dlpMonths,
        cubeOverdueGraceDays: input.cubeOverdueGraceDays,
        version: input.version + 1,
        updatedAt: now(),
      };
    } else if (!canEdit && !has(QUALITY_READ_PERMISSIONS, deps.somewhere))
      throw fail(403, "forbidden");
    return {
      body: { settings: { ...state.settings, permissions: { canEdit } } },
      schema: qualitySettingsResponseSchema,
    };
  }
  if (path === "/quality/templates" || path.startsWith("/quality/templates/")) {
    if (!has(QUALITY_READ_PERMISSIONS, deps.somewhere)) throw fail(403, "forbidden");
    const canWrite = deps.somewhere.includes("quality.manage");
    const newest = (lineageId: string) =>
      state.templates
        .filter((entry) => entry.lineageId === lineageId)
        .sort((a, b) => b.version - a.version)[0]!;
    const summary = (template: Template) => ({
      id: template.id,
      lineageId: template.lineageId,
      version: template.version,
      name: template.name,
      category: template.category,
      description: template.description,
      retired: template.retired,
      itemCount: template.items.length,
      createdBy: template.createdBy,
      createdAt: template.createdAt,
    });
    const detail = (template: Template, status = 200): Reply => {
      const current = newest(template.lineageId).id === template.id;
      const allowed = current && !template.retired && canWrite;
      return {
        status,
        body: {
          template: {
            ...summary(template),
            current,
            items: template.items.map((text, index) => ({
              id: `${template.id.slice(0, 24)}${String(index + 1).padStart(12, "0")}`,
              position: index + 1,
              text,
            })),
            permissions: { canRevise: allowed, canRetire: allowed },
          },
          history: state.templates
            .filter((entry) => entry.lineageId === template.lineageId && entry.id !== template.id)
            .sort((a, b) => b.version - a.version)
            .map(summary),
        },
        schema: checklistTemplateResponseSchema,
      };
    };
    const append = (base: Template, content: Partial<Template>): Template => {
      const latest = newest(base.lineageId);
      if (latest.retired) throw fail(409, "template-retired");
      const next = { ...latest, ...content, id: randomUUID(), version: latest.version + 1 };
      next.createdBy = actor;
      next.createdAt = now();
      state.templates.push(next);
      return next;
    };
    if (path === "/quality/templates" && method === "GET") {
      const lineages = [...new Set(state.templates.map((entry) => entry.lineageId))].map(newest);
      return {
        body: {
          templates: lineages
            .filter((entry) => query.get("includeRetired") === "true" || !entry.retired)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(summary),
          permissions: { canCreate: canWrite },
        },
        schema: checklistTemplatesResponseSchema,
      };
    }
    if (!canWrite && method !== "GET") throw fail(403, "forbidden");
    if (path === "/quality/templates" && method === "POST") {
      const input = parse(createChecklistTemplateRequestSchema, body);
      const id = randomUUID();
      const created: Template = {
        id,
        lineageId: id,
        version: 1,
        name: input.name,
        category: input.category,
        description: input.description,
        retired: false,
        items: input.items.map((item) => item.text),
        createdBy: actor,
        createdAt: now(),
      };
      state.templates.push(created);
      return detail(created, 201);
    }
    if (path === "/quality/templates/starter" && method === "POST") {
      const { language } = parse(loadStarterTemplatesRequestSchema, body);
      const names = new Set(state.templates.map((entry) => entry.name.toLowerCase()));
      let created = 0;
      for (const starter of STARTER_CHECKLIST_TEMPLATES) {
        if (names.has(starter.name[language].toLowerCase())) continue;
        const id = randomUUID();
        state.templates.push({
          id,
          lineageId: id,
          version: 1,
          name: starter.name[language],
          category: starter.category,
          description: null,
          retired: false,
          items: starter.items.map((item) => item[language]),
          createdBy: actor,
          createdAt: now(),
        });
        created += 1;
      }
      return { status: 201, body: { created }, schema: loadStarterTemplatesResponseSchema };
    }
    const match = /^\/quality\/templates\/([^/]+)(\/(versions|retire))?$/.exec(path);
    const template = state.templates.find((entry) => entry.id === match?.[1]);
    if (!match || !template) throw fail(404, "not-found");
    if (!match[2] && method === "GET") return detail(template);
    if (match[3] === "versions" && method === "POST") {
      const input = parse(reviseChecklistTemplateRequestSchema, body);
      if (newest(template.lineageId).version !== input.expectedVersion)
        throw fail(409, "version-conflict");
      return detail(
        append(template, {
          name: input.name,
          category: input.category,
          description: input.description,
          items: input.items.map((item) => item.text),
        }),
        201,
      );
    }
    if (match[3] === "retire" && method === "POST") {
      const input = parse(retireChecklistTemplateRequestSchema, body);
      if (newest(template.lineageId).version !== input.expectedVersion)
        throw fail(409, "version-conflict");
      return detail(append(template, { retired: true }), 201);
    }
    throw fail(404, "not-found");
  }

  // Project records -----------------------------------------------------------------------------
  const project = deps.project;
  if (!project) return null;
  if (!has(QUALITY_READ_PERMISSIONS)) throw fail(403, "forbidden");
  const readOnly = project.status === "closed" || project.status === "cancelled";
  const canRecord = !readOnly && has(QUALITY_RECORD_PERMISSIONS);
  const canReview = !readOnly && deps.permissions.includes("quality.manage");
  const canPropose = !readOnly && deps.permissions.includes("projects.manage");
  const recorder = () => {
    if (readOnly) throw fail(409, "project-read-only");
    if (!canRecord) throw fail(403, "forbidden");
  };
  const reviewer = () => {
    if (readOnly) throw fail(409, "project-read-only");
    if (!canReview) throw fail(403, "forbidden");
  };
  const records =
    state.projects.get(project.id) ??
    (state.projects.set(project.id, {
      inspections: [],
      snags: [],
      cubes: [],
      slump: [],
      completions: [],
    }),
    state.projects.get(project.id)!);
  const today = nairobiDate();
  const siteName = (id: string) => deps.sites.find((site) => site.id === id)?.name ?? "—";
  const requireSite = (id: string) => {
    if (!deps.sites.some((site) => site.id === id)) throw fail(404, "not-found");
  };
  const future = (date: string) => {
    if (date > today) throw fail(409, "quality-date-future");
  };
  const photos = (ids: readonly string[]) =>
    ids.map((id) => {
      const found = deps.photo(id);
      if (!found) throw fail(422, "photo-not-in-project");
      return found;
    });
  const version = (row: { version: number }, expected: number) => {
    if (row.version !== expected) throw fail(409, "version-conflict");
  };
  const page = <T extends { number: number }>(rows: T[], cursor?: number, limit = 30) => {
    const sorted = rows
      .filter((row) => !cursor || row.number < cursor)
      .sort((a, b) => b.number - a.number);
    const slice = sorted.slice(0, limit);
    return { slice, nextCursor: sorted.length > limit ? slice.at(-1)!.number : null };
  };
  const matches = (text: string, search: string | undefined, prefix: string, number: number) => {
    if (!search?.trim()) return true;
    const value = search.trim();
    const numbered = new RegExp(`^(?:${prefix}-?)?0*(\\d{1,9})$`, "i").exec(value);
    return (
      text.toLowerCase().includes(value.toLowerCase()) ||
      (numbered !== null && Number(numbered[1]) === number)
    );
  };

  const toSnag = (row: SnagRow): Snag => {
    const decider = snagDecisionIndependent({ fixedBy: row.fixedBy?.id ?? null }, actor.id);
    return {
      ...row,
      projectId: project.id,
      siteName: siteName(row.siteId),
      code: code("SNG", row.number),
      overdue: row.status === "open" && row.dueOn !== null && row.dueOn < today,
      permissions: {
        canEdit: canReview && row.status === "open",
        canFix: canRecord && row.status === "open",
        canClose: canReview && row.status === "fixed" && decider,
        canReopen: canReview && row.status === "fixed" && decider,
      },
    };
  };
  const toInspection = (row: InspectionRow): Inspection => {
    const template = state.templates.find((entry) => entry.id === row.templateId)!;
    const count = (result: InspectionItemResult) =>
      row.items.filter((item) => item.result === result).length;
    const author = row.createdBy.id === actor.id;
    const reviewing =
      canReview &&
      row.status === "submitted" &&
      inspectionReviewIndependent(
        { createdBy: row.createdBy.id, submittedBy: row.submittedBy?.id ?? null },
        actor.id,
      );
    const node = deps.wbs.find((entry) => entry.id === row.wbsNodeId) ?? null;
    return {
      id: row.id,
      projectId: project.id,
      siteId: row.siteId,
      siteName: siteName(row.siteId),
      number: row.number,
      code: code("INS", row.number),
      template: { id: template.id, name: template.name, version: template.version },
      category: template.category,
      location: row.location,
      inspectorType: row.inspectorType,
      inspectorName: row.inspectorName,
      inspectedOn: row.inspectedOn,
      links: { wbsNode: node, scheduleActivity: null, bqItem: null },
      status: row.status,
      result: row.result,
      itemCounts: {
        total: row.items.length,
        pass: count("pass"),
        fail: count("fail"),
        na: count("na"),
        pending: count("pending"),
      },
      notes: row.notes,
      version: row.version,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      submittedBy: row.submittedBy,
      submittedAt: row.submittedAt,
      signedOffBy: row.signedOffBy,
      signedOffAt: row.signedOffAt,
      returnedBy: row.returnedBy,
      returnedAt: row.returnedAt,
      returnReason: row.returnReason,
      permissions: {
        canEdit: canRecord && author && row.status === "draft",
        canSubmit: canRecord && author && row.status === "draft",
        canSignOff: reviewing,
        canReturn: reviewing,
        canRaiseSnags: canRecord && row.status !== "draft" && row.result === "fail",
      },
    };
  };
  const inspectionDetail = (row: InspectionRow, status = 200): Reply => ({
    status,
    body: {
      inspection: toInspection(row),
      items: row.items.map((item, index) => ({
        id: item.id,
        position: index + 1,
        text: item.text,
        result: item.result,
        note: item.note,
        photos: item.photos,
        snagCount: records.snags.filter(
          (snag) => snag.inspection?.itemText === item.text && snag.inspection.id === row.id,
        ).length,
      })),
      snags: records.snags.filter((snag) => snag.inspection?.id === row.id).map(toSnag),
    },
    schema: inspectionDetailResponseSchema,
  });
  const grace = state.settings.cubeOverdueGraceDays;
  const toCubeSet = (row: CubeRow): CubeSet => {
    const superseded = new Set(row.results.map((result) => result.supersedesId).filter(Boolean));
    const current = row.results.filter((result) => !superseded.has(result.id));
    const active = row.status === "active";
    const ages = CUBE_TEST_AGES.map((age) => {
      const result = current.find((entry) => entry.ageDays === age) ?? null;
      return {
        ageDays: age,
        dueOn: cubeDueDate(row.castOn, age),
        state: active
          ? cubeAgeState({
              castOn: row.castOn,
              ageDays: age,
              today,
              graceDays: grace,
              recorded: !!result,
            })
          : result
            ? ("recorded" as const)
            : ("not_due" as const),
        result: result ? { ...result, current: true } : null,
      };
    });
    const outcome = ages[1]!.result?.outcome;
    return {
      id: row.id,
      projectId: project.id,
      siteId: row.siteId,
      siteName: siteName(row.siteId),
      number: row.number,
      code: code("CUBE", row.number),
      element: row.element,
      concreteClass: row.concreteClass,
      specifiedStrength: classStrength(row.concreteClass),
      castOn: row.castOn,
      cubesPerAge: row.cubesPerAge,
      batchReference: row.batchReference,
      notes: null,
      status: row.status,
      voidReason: row.voidReason,
      ages,
      outcome: outcome === "pass" || outcome === "fail" ? outcome : null,
      version: row.version,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      permissions: {
        canRecord: canRecord && active && ages.some((age) => !age.result),
        canCorrect: canReview && active && current.length > 0,
        canVoid: canReview && active,
      },
    };
  };
  const cubeDetail = (row: CubeRow, status = 200): Reply => {
    const superseded = new Set(row.results.map((result) => result.supersedesId).filter(Boolean));
    return {
      status,
      body: {
        cubeSet: toCubeSet(row),
        history: [...row.results]
          .reverse()
          .map((result) => ({ ...result, current: !superseded.has(result.id) })),
      },
      schema: cubeSetResponseSchema,
    };
  };
  const overdue = (row: CubeRow) =>
    row.status === "active" &&
    CUBE_TEST_AGES.some(
      (age) =>
        cubeAgeState({
          castOn: row.castOn,
          ageDays: age,
          today,
          graceDays: grace,
          recorded: row.results.some((result) => result.ageDays === age),
        }) === "overdue",
    );
  const failed = (row: CubeRow) => toCubeSet(row).outcome === "fail";
  const toSlump = (row: SlumpRow): SlumpTest => {
    const current = !records.slump.some((entry) => entry.supersedesId === row.id);
    return {
      ...row,
      projectId: project.id,
      siteName: siteName(row.siteId),
      code: code("SLP", row.number),
      current,
      permissions: { canCorrect: canReview && current },
    };
  };
  const slumpDetail = (row: SlumpRow, status = 200): Reply => {
    const versions = records.slump.filter((entry) => entry.number === row.number).map(toSlump);
    const current = versions.find((entry) => entry.current) ?? toSlump(row);
    return {
      status,
      body: {
        slumpTest: current,
        history: versions.filter((entry) => entry.id !== current.id).reverse(),
      },
      schema: slumpTestResponseSchema,
    };
  };
  const openSnags = () => records.snags.filter((snag) => snag.status !== "closed");
  const certifiedPractical = () =>
    records.completions.find((entry) => entry.kind === "practical" && entry.status === "certified");
  const completionView = (status = 200): Reply => {
    const toCertificate = (row: CompletionRow): CompletionCertificate => ({
      ...row,
      permissions: {
        canCertify: canReview && row.status === "proposed" && row.proposedBy.id !== actor.id,
        canWithdraw: canPropose && row.status === "proposed",
      },
    });
    const live = (kind: CompletionKind) =>
      records.completions.find((entry) => entry.kind === kind && entry.status !== "withdrawn") ??
      null;
    const practical = live("practical");
    const final = live("final");
    const open = openSnags();
    const critical = open.filter((snag) => snag.severity === "critical").length;
    const certified = certifiedPractical();
    const blockers = (kind: CompletionKind) =>
      completionBlockers({
        kind,
        completionDate: today,
        today,
        openCriticalSnags: critical,
        openSnags: open.length,
        exceptionReason: null,
        practical: certified?.dlpEndsOn ? { dlpEndsOn: certified.dlpEndsOn } : null,
      });
    const dlpSnags = records.snags.filter((snag) => snag.phase === "dlp");
    return {
      status,
      body: {
        practical: practical ? toCertificate(practical) : null,
        final: final ? toCertificate(final) : null,
        history: [...records.completions].reverse().map(toCertificate),
        dlp:
          certified?.dlpEndsOn && certified.dlpMonths
            ? {
                startsOn: certified.completionDate,
                endsOn: certified.dlpEndsOn,
                months: certified.dlpMonths,
                ...dlpState(today, certified.dlpEndsOn),
                defects: {
                  open: dlpSnags.filter((snag) => snag.status === "open").length,
                  fixed: dlpSnags.filter((snag) => snag.status === "fixed").length,
                  closed: dlpSnags.filter((snag) => snag.status === "closed").length,
                },
              }
            : null,
        readiness: {
          openCriticalSnags: critical,
          openSnags: open.length,
          practicalBlockers: blockers("practical"),
          finalBlockers: blockers("final"),
        },
        defaultDlpMonths: state.settings.dlpMonths,
        permissions: { canPropose },
      },
      schema: completionResponseSchema,
    };
  };
  const completionProblem = {
    open_critical_snags: "completion-open-critical-snags",
    open_snags: "completion-open-snags",
    practical_not_certified: "completion-practical-required",
    dlp_not_ended: "completion-dlp-not-ended",
    date_future: "quality-date-future",
  } as const;
  const checkCompletion = (
    kind: CompletionKind,
    completionDate: string,
    exceptionReason: string | null,
  ) => {
    const open = openSnags();
    const certified = certifiedPractical();
    const blockers = completionBlockers({
      kind,
      completionDate,
      today,
      openCriticalSnags: open.filter((snag) => snag.severity === "critical").length,
      openSnags: open.length,
      exceptionReason,
      practical: certified?.dlpEndsOn ? { dlpEndsOn: certified.dlpEndsOn } : null,
    });
    if (blockers.length) throw fail(409, completionProblem[blockers[0]!]);
    return {
      openSnags: open.length,
      openCriticalSnags: open.filter((snag) => snag.severity === "critical").length,
    };
  };

  const rest = path.slice(`/projects/${project.id}/quality`.length);
  if (rest === "/summary" && method === "GET") {
    const practical = records.completions.find(
      (entry) => entry.kind === "practical" && entry.status !== "withdrawn",
    );
    const final = records.completions.find(
      (entry) => entry.kind === "final" && entry.status !== "withdrawn",
    );
    const count = <T,>(rows: T[], keep: (row: T) => boolean) => rows.filter(keep).length;
    return {
      body: {
        inspections: {
          draft: count(records.inspections, (row) => row.status === "draft"),
          submitted: count(records.inspections, (row) => row.status === "submitted"),
          signedOff: count(records.inspections, (row) => row.status === "signed_off"),
          failed: count(records.inspections, (row) => row.result === "fail"),
        },
        cubes: { overdue: count(records.cubes, overdue), failed: count(records.cubes, failed) },
        slumpFailed: count(
          records.slump.map(toSlump),
          (row) => row.current && row.outcome === "fail",
        ),
        snags: {
          open: count(records.snags, (row) => row.status === "open"),
          fixed: count(records.snags, (row) => row.status === "fixed"),
          openCritical: count(openSnags(), (row) => row.severity === "critical"),
          overdue: count(records.snags.map(toSnag), (row) => row.overdue),
        },
        completion: {
          practical: practical?.status ?? null,
          final: final?.status ?? null,
          dlpEndsOn: practical?.status === "certified" ? practical.dlpEndsOn : null,
        },
      },
      schema: qualitySummaryResponseSchema,
    };
  }

  // Inspections
  if (rest === "/inspections" && method === "GET") {
    const input = parse(inspectionsQuerySchema, Object.fromEntries(query));
    const rows = records.inspections.filter((row) => {
      const template = state.templates.find((entry) => entry.id === row.templateId)!;
      return (
        (!input.status || row.status === input.status) &&
        (!input.result || row.result === input.result) &&
        matches(`${row.location} ${template.name}`, input.search, "INS", row.number)
      );
    });
    const { slice, nextCursor } = page(rows, input.cursor, input.limit);
    return {
      body: {
        inspections: slice.map(toInspection),
        nextCursor,
        permissions: { canCreate: canRecord },
      },
      schema: inspectionsResponseSchema,
    };
  }
  if (rest === "/inspections" && method === "POST") {
    recorder();
    const input = parse(createInspectionRequestSchema, body);
    requireSite(input.siteId);
    future(input.inspectedOn);
    const template = state.templates.find((entry) => entry.id === input.templateId);
    if (!template) throw fail(404, "not-found");
    const latest = state.templates
      .filter((entry) => entry.lineageId === template.lineageId)
      .sort((a, b) => b.version - a.version)[0]!;
    if (latest.retired) throw fail(409, "template-retired");
    if (latest.id !== template.id) throw fail(409, "template-not-current");
    const row: InspectionRow = {
      id: randomUUID(),
      siteId: input.siteId,
      number: Math.max(0, ...records.inspections.map((entry) => entry.number)) + 1,
      templateId: template.id,
      location: input.location,
      inspectorType: input.inspectorType,
      inspectorName: input.inspectorName,
      inspectedOn: input.inspectedOn,
      wbsNodeId: input.wbsNodeId ?? null,
      notes: input.notes,
      status: "draft",
      result: null,
      version: 1,
      createdBy: actor,
      createdAt: now(),
      submittedBy: null,
      submittedAt: null,
      signedOffBy: null,
      signedOffAt: null,
      returnedBy: null,
      returnedAt: null,
      returnReason: null,
      items: template.items.map((text) => ({
        id: randomUUID(),
        text,
        result: "pending",
        note: null,
        photos: [],
      })),
    };
    records.inspections.push(row);
    return inspectionDetail(row, 201);
  }
  const inspectionMatch = /^\/inspections\/([^/]+)(\/actions)?$/.exec(rest);
  if (inspectionMatch) {
    const row = records.inspections.find((entry) => entry.id === inspectionMatch[1]);
    if (!row) throw fail(404, "not-found");
    if (method === "GET" && !inspectionMatch[2]) return inspectionDetail(row);
    if (method === "PATCH" && !inspectionMatch[2]) {
      recorder();
      const input = parse(updateInspectionRequestSchema, body);
      version(row, input.version);
      if (row.createdBy.id !== actor.id) throw fail(403, "inspection-author-required");
      if (row.status !== "draft") throw fail(409, "inspection-not-draft");
      for (const item of input.items ?? []) {
        const target = row.items.find((entry) => entry.id === item.id);
        if (!target) throw fail(422, "inspection-item-unknown");
        Object.assign(target, {
          result: item.result,
          note: item.note,
          photos: photos(item.photoIds),
        });
      }
      if (input.location) row.location = input.location;
      row.version += 1;
      return inspectionDetail(row);
    }
    if (method === "POST" && inspectionMatch[2]) {
      const input = parse(inspectionActionRequestSchema, body);
      if (input.action === "submit") recorder();
      else reviewer();
      version(row, input.version);
      const check = checkProcurementTransition(
        INSPECTION_TRANSITIONS,
        row.status,
        input.action,
        input.reason,
      );
      if (!check.ok) throw fail(409, "invalid-transition");
      if (input.action === "submit") {
        if (row.createdBy.id !== actor.id) throw fail(403, "inspection-author-required");
        if (inspectionSubmitIssues(row.items).length) throw fail(409, "inspection-incomplete");
        Object.assign(row, {
          status: "submitted",
          submittedBy: actor,
          submittedAt: now(),
          result: inspectionOutcome(row.items.map((item) => item.result)),
        });
      } else {
        if (
          !inspectionReviewIndependent(
            { createdBy: row.createdBy.id, submittedBy: row.submittedBy?.id ?? null },
            actor.id,
          )
        )
          throw fail(403, "inspection-independent-review");
        if (input.action === "sign_off")
          Object.assign(row, { status: "signed_off", signedOffBy: actor, signedOffAt: now() });
        else
          Object.assign(row, {
            status: "draft",
            submittedBy: null,
            submittedAt: null,
            result: null,
            returnedBy: actor,
            returnedAt: now(),
            returnReason: input.reason,
          });
      }
      row.version += 1;
      return inspectionDetail(row);
    }
  }

  // Snags
  if (rest === "/snags" && method === "GET") {
    const input = parse(snagsQuerySchema, Object.fromEntries(query));
    const rows = records.snags.filter(
      (row) =>
        (!input.status ||
          (input.status === "active" ? row.status !== "closed" : row.status === input.status)) &&
        (!input.severity || row.severity === input.severity) &&
        (!input.phase || row.phase === input.phase) &&
        matches(
          `${row.location} ${row.description} ${row.responsibleName}`,
          input.search,
          "SNG",
          row.number,
        ),
    );
    const { slice, nextCursor } = page(rows, input.cursor, input.limit);
    const all = records.snags.map(toSnag);
    return {
      body: {
        snags: slice.map(toSnag),
        nextCursor,
        counts: {
          open: all.filter((row) => row.status === "open").length,
          fixed: all.filter((row) => row.status === "fixed").length,
          closed: all.filter((row) => row.status === "closed").length,
          openCritical: all.filter((row) => row.status !== "closed" && row.severity === "critical")
            .length,
          overdue: all.filter((row) => row.overdue).length,
          dlpOpen: all.filter((row) => row.phase === "dlp" && row.status !== "closed").length,
        },
        permissions: { canCreate: canRecord },
      },
      schema: snagsResponseSchema,
    };
  }
  if (rest === "/snags" && method === "POST") {
    recorder();
    const input = parse(createSnagRequestSchema, body);
    requireSite(input.siteId);
    let inspection: SnagRow["inspection"] = null;
    if (input.inspectionItemId) {
      const owner = records.inspections.find((entry) =>
        entry.items.some((item) => item.id === input.inspectionItemId),
      );
      const item = owner?.items.find((entry) => entry.id === input.inspectionItemId);
      if (!owner || !item) throw fail(404, "not-found");
      if (item.result !== "fail" || owner.status === "draft")
        throw fail(409, "snag-item-not-failed");
      inspection = { id: owner.id, code: code("INS", owner.number), itemText: item.text };
    }
    const row: SnagRow = {
      id: randomUUID(),
      siteId: input.siteId,
      number: Math.max(0, ...records.snags.map((entry) => entry.number)) + 1,
      location: input.location,
      description: input.description,
      severity: input.severity as SnagSeverity,
      responsibleKind: input.responsibleKind as SnagResponsibleKind,
      responsibleName: input.responsibleName,
      dueOn: input.dueOn,
      phase: certifiedPractical() ? "dlp" : "construction",
      inspection,
      status: "open",
      fixNote: null,
      reopenCount: 0,
      lastReopenReason: null,
      photos: { raised: photos(input.photoIds), fixed: [], earlierFixes: [] },
      raisedBy: actor,
      raisedAt: now(),
      fixedBy: null,
      fixedAt: null,
      closedBy: null,
      closedAt: null,
      version: 1,
    };
    records.snags.push(row);
    return { status: 201, body: { snag: toSnag(row) }, schema: snagResponseSchema };
  }
  const snagMatch = /^\/snags\/([^/]+)(\/actions)?$/.exec(rest);
  if (snagMatch) {
    const row = records.snags.find((entry) => entry.id === snagMatch[1]);
    if (!row) throw fail(404, "not-found");
    if (method === "GET" && !snagMatch[2])
      return { body: { snag: toSnag(row) }, schema: snagResponseSchema };
    if (method === "PATCH" && !snagMatch[2]) {
      reviewer();
      const input = parse(updateSnagRequestSchema, body);
      version(row, input.version);
      if (row.status !== "open") throw fail(409, "snag-not-open");
      for (const [key, value] of Object.entries(input))
        if (key !== "version" && value !== undefined) Object.assign(row, { [key]: value });
      row.version += 1;
      return { body: { snag: toSnag(row) }, schema: snagResponseSchema };
    }
    if (method === "POST" && snagMatch[2]) {
      const input = parse(snagActionRequestSchema, body);
      if (input.action === "fix") recorder();
      else reviewer();
      version(row, input.version);
      const check = checkProcurementTransition(
        SNAG_TRANSITIONS,
        row.status,
        input.action,
        input.reason,
      );
      if (!check.ok) throw fail(409, "invalid-transition");
      if (
        input.action !== "fix" &&
        !snagDecisionIndependent({ fixedBy: row.fixedBy?.id ?? null }, actor.id)
      )
        throw fail(403, "snag-independent-verification");
      if (input.action === "fix")
        Object.assign(row, {
          status: "fixed",
          fixedBy: actor,
          fixedAt: now(),
          fixNote: input.note ?? null,
          photos: { ...row.photos, fixed: [...row.photos.fixed, ...photos(input.photoIds ?? [])] },
        });
      else if (input.action === "close")
        Object.assign(row, { status: "closed", closedBy: actor, closedAt: now() });
      else
        Object.assign(row, {
          status: "open",
          fixedBy: null,
          fixedAt: null,
          fixNote: null,
          reopenCount: row.reopenCount + 1,
          lastReopenReason: input.reason,
          photos: {
            ...row.photos,
            fixed: [],
            earlierFixes: [...row.photos.earlierFixes, ...row.photos.fixed],
          },
        });
      row.version += 1;
      return { body: { snag: toSnag(row) }, schema: snagResponseSchema };
    }
  }

  // Concrete
  if (rest === "/cubes" && method === "GET") {
    const input = parse(cubeSetsQuerySchema, Object.fromEntries(query));
    const rows = records.cubes.filter(
      (row) =>
        (input.filter === "overdue"
          ? overdue(row)
          : input.filter === "failed"
            ? failed(row)
            : true) &&
        matches(`${row.element} ${row.batchReference ?? ""}`, input.search, "CUBE", row.number),
    );
    const { slice, nextCursor } = page(rows, input.cursor, input.limit);
    return {
      body: {
        cubeSets: slice.map(toCubeSet),
        nextCursor,
        counts: {
          overdue: records.cubes.filter(overdue).length,
          failed: records.cubes.filter(failed).length,
        },
        permissions: { canCreate: canRecord },
      },
      schema: cubeSetsResponseSchema,
    };
  }
  if (rest === "/cubes" && method === "POST") {
    recorder();
    const input = parse(createCubeSetRequestSchema, body);
    requireSite(input.siteId);
    future(input.castOn);
    const row: CubeRow = {
      id: randomUUID(),
      siteId: input.siteId,
      number: Math.max(0, ...records.cubes.map((entry) => entry.number)) + 1,
      element: input.element,
      concreteClass: input.concreteClass,
      castOn: input.castOn,
      cubesPerAge: input.cubesPerAge,
      batchReference: input.batchReference,
      status: "active",
      voidReason: null,
      version: 1,
      createdBy: actor,
      createdAt: now(),
      results: [],
    };
    records.cubes.push(row);
    return cubeDetail(row, 201);
  }
  const cubeMatch = /^\/cubes\/([^/]+)(\/results(\/([^/]+)\/corrections)?|\/void)?$/.exec(rest);
  if (cubeMatch) {
    const row = records.cubes.find((entry) => entry.id === cubeMatch[1]);
    if (!row) throw fail(404, "not-found");
    if (method === "GET" && !cubeMatch[2]) return cubeDetail(row);
    if (method !== "POST") throw fail(404, "not-found");
    if (cubeMatch[2] === "/void") {
      reviewer();
      const input = parse(voidCubeSetRequestSchema, body);
      version(row, input.version);
      if (row.status !== "active") throw fail(409, "cube-set-void");
      Object.assign(row, { status: "void", voidReason: input.reason });
      row.version += 1;
      return cubeDetail(row);
    }
    const correcting = Boolean(cubeMatch[4]);
    if (correcting) reviewer();
    else recorder();
    if (row.status !== "active") throw fail(409, "cube-set-void");
    let age: CubeTestAge;
    let supersedes: CubeResult | null = null;
    let input;
    if (correcting) {
      input = parse(correctCubeResultRequestSchema, body);
      supersedes = row.results.find((result) => result.id === cubeMatch[4]) ?? null;
      if (!supersedes) throw fail(404, "not-found");
      if (row.results.some((result) => result.supersedesId === supersedes!.id))
        throw fail(409, "cube-result-superseded");
      age = supersedes.ageDays;
    } else {
      const recorded = parse(recordCubeResultRequestSchema, body);
      input = recorded;
      age = recorded.ageDays;
      if (row.results.some((result) => result.ageDays === age))
        throw fail(409, "cube-result-exists");
    }
    future(input.testedOn);
    if (input.testedOn < row.castOn) throw fail(422, "cube-tested-before-cast");
    row.results.push({
      id: randomUUID(),
      ageDays: age,
      testedOn: input.testedOn,
      strengths: input.strengths,
      ...assessCubes(row.concreteClass, age, input.strengths),
      laboratory: input.laboratory,
      reportReference: input.reportReference,
      supersedesId: supersedes?.id ?? null,
      correctionReason: "reason" in input ? input.reason : null,
      current: true,
      recordedBy: actor,
      recordedAt: now(),
    });
    return cubeDetail(row, 201);
  }
  if (rest === "/slump-tests" && method === "GET") {
    const input = parse(slumpTestsQuerySchema, Object.fromEntries(query));
    const rows = records.slump
      .map(toSlump)
      .filter(
        (row) =>
          row.current &&
          (!input.outcome || row.outcome === input.outcome) &&
          matches(row.element, input.search, "SLP", row.number),
      );
    const { slice, nextCursor } = page(rows, input.cursor, input.limit);
    return {
      body: { slumpTests: slice, nextCursor, permissions: { canCreate: canRecord } },
      schema: slumpTestsResponseSchema,
    };
  }
  const slumpMatch = /^\/slump-tests(\/([^/]+)(\/corrections)?)?$/.exec(rest);
  if (slumpMatch && method === "POST") {
    const correcting = Boolean(slumpMatch[3]);
    if (correcting) reviewer();
    else recorder();
    let previous: SlumpRow | null = null;
    let input;
    if (correcting) {
      input = parse(correctSlumpTestRequestSchema, body);
      previous = records.slump.find((entry) => entry.id === slumpMatch[2]) ?? null;
      if (!previous) throw fail(404, "not-found");
      if (records.slump.some((entry) => entry.supersedesId === previous!.id))
        throw fail(409, "slump-test-superseded");
    } else {
      input = parse(createSlumpTestRequestSchema, body);
      requireSite(input.siteId);
    }
    future(input.testedOn);
    const set =
      "cubeSetId" in input && input.cubeSetId
        ? records.cubes.find((entry) => entry.id === input.cubeSetId)
        : null;
    const { outcome, deviationMm, ruleVersion } = assessSlump(
      input.targetMm,
      input.toleranceMm,
      input.measuredMm,
    );
    const row: SlumpRow = {
      id: randomUUID(),
      siteId: previous?.siteId ?? ("siteId" in input ? input.siteId : ""),
      number: previous?.number ?? Math.max(0, ...records.slump.map((entry) => entry.number)) + 1,
      testedOn: input.testedOn,
      element: input.element,
      concreteClass: input.concreteClass,
      cubeSet: previous?.cubeSet ?? (set ? { id: set.id, code: code("CUBE", set.number) } : null),
      targetMm: input.targetMm,
      toleranceMm: input.toleranceMm,
      measuredMm: input.measuredMm,
      deviationMm,
      outcome,
      ruleVersion,
      notes: input.notes,
      supersedesId: previous?.id ?? null,
      correctionReason: "reason" in input ? input.reason : null,
      recordedBy: actor,
      recordedAt: now(),
    };
    records.slump.push(row);
    return slumpDetail(row, 201);
  }
  if (slumpMatch?.[2] && method === "GET") {
    const row = records.slump.find((entry) => entry.id === slumpMatch[2]);
    if (!row) throw fail(404, "not-found");
    return slumpDetail(row);
  }

  // Completion
  if (rest === "/completion" && method === "GET") return completionView();
  if (rest === "/completion" && method === "POST") {
    if (readOnly) throw fail(409, "project-read-only");
    if (!canPropose) throw fail(403, "forbidden");
    const input = parse(proposeCompletionRequestSchema, body);
    if (
      records.completions.some((entry) => entry.kind === input.kind && entry.status !== "withdrawn")
    )
      throw fail(409, "completion-exists");
    const counts = checkCompletion(input.kind, input.completionDate, input.exceptionReason);
    const dlpMonths =
      input.kind === "practical" ? (input.dlpMonths ?? state.settings.dlpMonths) : null;
    records.completions.push({
      id: randomUUID(),
      kind: input.kind,
      status: "proposed",
      completionDate: input.completionDate,
      dlpMonths,
      dlpEndsOn: dlpMonths === null ? null : dlpEndDate(input.completionDate, dlpMonths),
      ...counts,
      exceptionReason: input.exceptionReason,
      notes: input.notes,
      version: 1,
      proposedBy: actor,
      proposedAt: now(),
      certifiedBy: null,
      certifiedAt: null,
      withdrawnBy: null,
      withdrawnAt: null,
      withdrawReason: null,
    });
    return completionView(201);
  }
  const completionMatch = /^\/completion\/([^/]+)\/actions$/.exec(rest);
  if (completionMatch && method === "POST") {
    const input = parse(completionActionRequestSchema, body);
    if (input.action === "certify") reviewer();
    else if (!canPropose)
      throw fail(readOnly ? 409 : 403, readOnly ? "project-read-only" : "forbidden");
    const row = records.completions.find((entry) => entry.id === completionMatch[1]);
    if (!row) throw fail(404, "not-found");
    version(row, input.version);
    const check = checkProcurementTransition(
      COMPLETION_TRANSITIONS,
      row.status,
      input.action,
      input.reason,
    );
    if (!check.ok) throw fail(409, "invalid-transition");
    if (input.action === "certify") {
      if (row.proposedBy.id === actor.id) throw fail(403, "completion-independent");
      Object.assign(row, checkCompletion(row.kind, row.completionDate, row.exceptionReason), {
        status: "certified",
        certifiedBy: actor,
        certifiedAt: now(),
      });
    } else
      Object.assign(row, {
        status: "withdrawn",
        withdrawnBy: actor,
        withdrawnAt: now(),
        withdrawReason: input.reason,
      });
    row.version += 1;
    return completionView();
  }
  throw fail(404, "not-found");
}
