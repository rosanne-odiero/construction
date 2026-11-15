/**
 * D3.4 DPIA gate for the browser tests: DPIA versions, the signed PDF, approval with every go-live
 * condition, and per-site switches. Uses the shared domain rules (packages/domain biometrics) and
 * returns the shared response schemas, like the API. In memory, per test session; nothing is
 * seeded, so each test walks the flow from "no DPIA".
 */
import { createHash, randomUUID } from "node:crypto";
import type { z } from "zod";
import {
  biometricGate,
  carriedForwardSwitches,
  dpiaApprovalGaps,
  dpiaCovers,
  dpiaReviewDueRange,
  dpiaState,
  isDpiaReviewDueValid,
  nairobiDate,
  switchedOnUnder,
  type ApprovedDpia,
} from "@pm-buddy/domain";
import {
  BIOMETRIC_CAPTURE_METHODS,
  DPIA_GO_LIVE_CONDITIONS,
  DPIA_REVIEW_INTERVAL_MONTHS,
  type BiometricCaptureMethod,
  type ProjectStatus,
} from "@pm-buddy/types";
import {
  approveDpiaRequestSchema,
  biometricSwitchRequestSchema,
  biometricSwitchResponseSchema,
  biometricsOverviewResponseSchema,
  createDpiaRequestSchema,
  dpiaResponseSchema,
  rejectDpiaRequestSchema,
  updateDpiaRequestSchema,
  withdrawDpiaRequestSchema,
  type BiometricSite,
  type CreateDpiaRequest,
  type DpiaDetail,
  type DpiaSummary,
} from "@pm-buddy/validation";

type Reply = { status?: number; body: unknown; schema: z.ZodType<unknown> };
type Person = { id: string; displayName: string };
type Site = {
  id: string;
  name: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  projectStatus: ProjectStatus;
};

export type BiometricsDeps = {
  sites: Site[];
  companyPermissions: readonly string[];
  actor: Person;
  stepUpFresh: () => boolean;
  fail: (status: number, code: string) => Error;
  parse: <T>(schema: z.ZodType<T>, body: unknown) => T;
};

type Record = Omit<CreateDpiaRequest, "siteIds"> & {
  id: string;
  versionNo: number;
  status: DpiaDetail["status"];
  siteIds: string[];
  document: {
    id: string;
    fileName: string;
    sizeBytes: number;
    sha256: string;
    uploadedBy: Person;
    uploadedAt: string;
  } | null;
  uploads: number;
  approval: { by: Person; at: string; reviewDue: string; digest: string } | null;
  closure: { kind: "rejected" | "withdrawn"; by: Person; at: string; reason: string } | null;
  supersession: { by: { id: string; versionNo: number }; at: string } | null;
  version: number;
  createdBy: Person;
  createdAt: string;
  updatedBy: Person;
  updatedAt: string;
};
type Switch = {
  siteId: string;
  method: BiometricCaptureMethod;
  enabled: boolean;
  dpiaRecordId: string | null;
  carriedForward: boolean;
  by: Person;
  at: string;
};

export type BiometricsState = { records: Record[]; switches: Switch[] };
export const initialBiometrics = (): BiometricsState => ({ records: [], switches: [] });

const READERS = ["biometrics.manage", "biometrics.approve"];
const closureOf = ({ by, at, reason }: NonNullable<Record["closure"]>) => ({ by, at, reason });

/** The uploaded file of a multipart body: its name and bytes. */
function filePart(raw: Buffer): { name: string; content: Buffer } | null {
  const text = raw.toString("latin1");
  const header = /name="file"; filename="([^"]*)"\r\n(?:[^\r\n]+\r\n)*\r\n/.exec(text);
  if (!header) return null;
  const start = header.index + header[0].length;
  const boundary = text.slice(0, text.indexOf("\r\n"));
  const end = text.indexOf(`\r\n${boundary}`, start);
  return { name: header[1]!, content: raw.subarray(start, end === -1 ? raw.length : end) };
}

export function handleBiometrics(
  deps: BiometricsDeps,
  state: BiometricsState,
  method: string,
  path: string,
  body: unknown,
  raw: Buffer,
): Reply | null {
  if (path !== "/biometrics" && !path.startsWith("/biometrics/")) return null;
  const { fail, parse, actor } = deps;
  const today = nairobiDate();
  const now = new Date().toISOString();
  const holds = (permission: string) => deps.companyPermissions.includes(permission);
  const require = (permission: string, stepUp = false) => {
    if (!holds(permission)) throw fail(403, "forbidden");
    if (stepUp && !deps.stepUpFresh()) throw fail(403, "step-up-required");
  };
  if (!READERS.some(holds)) throw fail(403, "forbidden");

  const approved = (): ApprovedDpia | null => {
    const record = state.records.find((entry) => entry.status === "approved");
    return record?.approval
      ? {
          id: record.id,
          reviewDue: record.approval.reviewDue,
          methods: record.methods,
          siteIds: record.siteIds,
        }
      : null;
  };
  const latest = (siteId: string, method: BiometricCaptureMethod) =>
    state.switches.findLast((entry) => entry.siteId === siteId && entry.method === method) ?? null;
  const facts = (record: Record) => ({
    ...record,
    hasDocument: record.document !== null,
    siteCount: record.siteIds.length,
  });
  const summary = (record: Record): DpiaSummary => ({
    id: record.id,
    versionNo: record.versionNo,
    status: record.status,
    state: dpiaState(record.status, record.approval?.reviewDue ?? null, today),
    methods: record.methods,
    siteCount: record.siteIds.length,
    reviewDue: record.approval?.reviewDue ?? null,
    approvedAt: record.approval?.at ?? null,
    approvedBy: record.approval?.by ?? null,
    createdAt: record.createdAt,
    createdBy: record.createdBy,
  });
  const detail = (record: Record): DpiaDetail => {
    const draft = record.status === "draft";
    return {
      ...summary(record),
      sites: deps.sites.filter((site) => record.siteIds.includes(site.id)),
      dpo: {
        name: record.dpoName,
        opinion: record.dpoOpinion,
        opinionOn: record.dpoOpinionOn,
        note: record.dpoNote,
      },
      controller: {
        name: record.controllerName,
        role: record.controllerRole,
        decision: record.controllerDecision,
        decisionOn: record.controllerDecisionOn,
        note: record.controllerNote,
      },
      residualRisk: record.residualRisk,
      odpcReference: record.odpcReference,
      document: record.document ? { ...record.document, scanStatus: "not_scanned" } : null,
      replacedDocuments: Math.max(0, record.uploads - (record.document ? 1 : 0)),
      approval: record.approval
        ? { ...record.approval, conditions: [...DPIA_GO_LIVE_CONDITIONS] }
        : null,
      rejection: record.closure?.kind === "rejected" ? closureOf(record.closure) : null,
      withdrawal: record.closure?.kind === "withdrawn" ? closureOf(record.closure) : null,
      supersession: record.supersession,
      approvalGaps: draft ? dpiaApprovalGaps(facts(record), today) : [],
      reviewDueRange: dpiaReviewDueRange(today),
      updatedAt: record.updatedAt,
      updatedBy: record.updatedBy,
      version: record.version,
      permissions: {
        canEdit: draft && holds("biometrics.manage"),
        canApprove: draft && holds("biometrics.approve"),
        canReject: draft && holds("biometrics.approve"),
        canWithdraw: record.status === "approved" && holds("biometrics.approve"),
      },
    };
  };
  const siteState = (site: Site): BiometricSite => {
    const inForce = approved();
    return {
      ...site,
      methods: BIOMETRIC_CAPTURE_METHODS.map((method) => {
        const last = latest(site.id, method);
        const gate = biometricGate({
          platformAvailable: true,
          projectStatus: site.projectStatus,
          approved: inForce,
          latestSwitch: last,
          siteId: site.id,
          method,
          today,
        });
        return {
          method,
          on: gate.on,
          reason: gate.reason,
          switchedOn: switchedOnUnder(last, inForce),
          inScope: inForce ? dpiaCovers(inForce, site.id, method) : false,
          lastChange: last
            ? {
                enabled: last.enabled,
                at: last.at,
                by: last.by,
                carriedForward: last.carriedForward,
              }
            : null,
        };
      }),
    };
  };
  const touch = (record: Record) => {
    record.version += 1;
    record.updatedBy = actor;
    record.updatedAt = now;
  };
  const checkSites = (siteIds: readonly string[]) => {
    if (siteIds.some((id) => !deps.sites.some((site) => site.id === id)))
      throw fail(422, "unknown-site");
  };
  const reply = (record: Record, status = 200): Reply => ({
    status,
    body: { dpia: detail(record) },
    schema: dpiaResponseSchema,
  });

  if (path === "/biometrics" && method === "GET") {
    const records = [...state.records].sort((a, b) => b.versionNo - a.versionNo).map(summary);
    return {
      body: {
        today,
        platformAvailable: true,
        reviewIntervalMonths: DPIA_REVIEW_INTERVAL_MONTHS,
        current: records.find((record) => record.status === "approved") ?? null,
        draft: records.find((record) => record.status === "draft") ?? null,
        history: records,
        sites: deps.sites.map(siteState),
        permissions: {
          canPrepare: holds("biometrics.manage"),
          canApprove: holds("biometrics.approve"),
          canSwitchOn: holds("biometrics.approve"),
          canSwitchOff: true,
        },
      },
      schema: biometricsOverviewResponseSchema,
    };
  }

  if (path === "/biometrics/dpias" && method === "POST") {
    require("biometrics.manage");
    const input = parse(createDpiaRequestSchema, body);
    if (state.records.some((record) => record.status === "draft"))
      throw fail(409, "dpia-draft-exists");
    checkSites(input.siteIds);
    const record: Record = {
      ...input,
      id: randomUUID(),
      versionNo: state.records.length + 1,
      status: "draft",
      siteIds: [...input.siteIds],
      document: null,
      uploads: 0,
      approval: null,
      closure: null,
      supersession: null,
      version: 1,
      createdBy: actor,
      createdAt: now,
      updatedBy: actor,
      updatedAt: now,
    };
    state.records.push(record);
    return reply(record, 201);
  }

  const switchRoute = /^\/biometrics\/sites\/([^/]+)\/methods\/([^/]+)$/.exec(path);
  if (switchRoute && method === "PUT") {
    const input = parse(biometricSwitchRequestSchema, body);
    if (input.enabled) require("biometrics.approve", true);
    const site = deps.sites.find((entry) => entry.id === switchRoute[1]);
    const capture = BIOMETRIC_CAPTURE_METHODS.find((entry) => entry === switchRoute[2]);
    if (!site || !capture) throw fail(404, "not-found");
    const last = latest(site.id, capture);
    const inForce = approved();
    if (input.enabled) {
      const gate = biometricGate({
        platformAvailable: true,
        projectStatus: site.projectStatus,
        approved: inForce,
        latestSwitch: last,
        siteId: site.id,
        method: capture,
        today,
      });
      const codes = {
        platform_off: "biometrics-unavailable",
        project_closed: "project-read-only",
        no_dpia: "dpia-required",
        dpia_lapsed: "dpia-lapsed",
        not_in_scope: "dpia-scope",
      } as const;
      if (!gate.on && gate.reason !== "switched_off") throw fail(409, codes[gate.reason]);
      if (!gate.on)
        state.switches.push({
          siteId: site.id,
          method: capture,
          enabled: true,
          dpiaRecordId: inForce!.id,
          carriedForward: false,
          by: actor,
          at: now,
        });
    } else if (last?.enabled) {
      state.switches.push({ ...last, enabled: false, carriedForward: false, by: actor, at: now });
    }
    return { body: { site: siteState(site) }, schema: biometricSwitchResponseSchema };
  }

  const route = /^\/biometrics\/dpias\/([^/]+)(?:\/(document|approve|reject|withdraw))?$/.exec(
    path,
  );
  if (!route) return null;
  const record = state.records.find((entry) => entry.id === route[1]);
  if (!record) throw fail(404, "not-found");
  const action = route[2];
  const draftOnly = (version?: number) => {
    if (record.status !== "draft") throw fail(409, "dpia-not-draft");
    if (version !== undefined && version !== record.version) throw fail(409, "version-conflict");
  };

  if (!action && method === "GET") return reply(record);
  if (!action && method === "PUT") {
    require("biometrics.manage");
    const input = parse(updateDpiaRequestSchema, body);
    draftOnly(input.version);
    checkSites(input.siteIds);
    const { version: _version, ...fields } = input;
    Object.assign(record, fields, { siteIds: [...input.siteIds] });
    touch(record);
    return reply(record);
  }
  if (action === "document" && method === "POST") {
    require("biometrics.manage");
    draftOnly();
    const file = filePart(raw);
    if (!file?.content.length) throw fail(400, "file-required");
    if (file.content.subarray(0, 5).toString("latin1") !== "%PDF-") throw fail(415, "pdf-required");
    record.document = {
      id: randomUUID(),
      fileName: file.name,
      sizeBytes: file.content.length,
      sha256: createHash("sha256").update(file.content).digest("hex"),
      uploadedBy: actor,
      uploadedAt: now,
    };
    record.uploads += 1;
    touch(record);
    return reply(record);
  }
  if (action === "approve" && method === "POST") {
    const input = parse(approveDpiaRequestSchema, body);
    require("biometrics.approve", true);
    draftOnly(input.version);
    if (dpiaApprovalGaps(facts(record), today).length) throw fail(422, "dpia-incomplete");
    if (record.document!.sha256 !== input.documentSha256) throw fail(409, "document-changed");
    if (!isDpiaReviewDueValid(input.reviewDue, today)) throw fail(422, "review-date-invalid");
    if (DPIA_GO_LIVE_CONDITIONS.some((condition) => !input.confirmations.includes(condition)))
      throw fail(422, "conditions-unconfirmed");
    const previous = state.records.find((entry) => entry.status === "approved");
    if (previous) {
      const candidates = BIOMETRIC_CAPTURE_METHODS.flatMap((capture) =>
        deps.sites.flatMap((site) => {
          const last = latest(site.id, capture);
          return last ? [{ ...last, projectStatus: site.projectStatus }] : [];
        }),
      );
      for (const entry of carriedForwardSwitches(candidates, previous.id, record))
        state.switches.push({
          ...entry,
          enabled: true,
          dpiaRecordId: record.id,
          carriedForward: true,
          by: actor,
          at: now,
        });
      previous.status = "superseded";
      previous.supersession = { by: { id: record.id, versionNo: record.versionNo }, at: now };
      touch(previous);
    }
    record.status = "approved";
    record.approval = {
      by: actor,
      at: now,
      reviewDue: input.reviewDue,
      digest: createHash("sha256").update(`${record.id}|${record.version}`).digest("hex"),
    };
    touch(record);
    return reply(record);
  }
  if ((action === "reject" || action === "withdraw") && method === "POST") {
    const input = parse(
      action === "reject" ? rejectDpiaRequestSchema : withdrawDpiaRequestSchema,
      body,
    );
    require("biometrics.approve", true);
    if (action === "reject") draftOnly(input.version);
    else {
      if (record.status !== "approved") throw fail(409, "dpia-not-approved");
      if (input.version !== record.version) throw fail(409, "version-conflict");
    }
    record.status = action === "reject" ? "rejected" : "withdrawn";
    record.closure = {
      kind: action === "reject" ? "rejected" : "withdrawn",
      by: actor,
      at: now,
      reason: input.reason,
    };
    touch(record);
    return reply(record);
  }
  return null;
}
