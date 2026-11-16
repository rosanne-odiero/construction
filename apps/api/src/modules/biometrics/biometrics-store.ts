import {
  dpiaApprovalGaps,
  dpiaReviewDueRange,
  dpiaState,
  switchedOnUnder,
  biometricGate,
  dpiaCovers,
  type ApprovedDpia,
  type BiometricSwitchFact,
  type SwitchCandidate,
} from "@pm-buddy/domain";
import {
  BIOMETRIC_CAPTURE_METHODS,
  type BiometricCaptureMethod,
  type ControllerDecision,
  type DpiaGoLiveCondition,
  type DpiaStatus,
  type DpoOpinion,
  type Permission,
  type ProjectStatus,
  type ResidualRiskLevel,
} from "@pm-buddy/types";
import type { BiometricSite, DpiaDetail, DpiaSummary } from "@pm-buddy/validation";
import type { Prisma } from "../../generated/prisma/client.js";

type Tx = Prisma.TransactionClient;
type People = Map<string, string>;

export const toCalendarDate = (value: Date): string => value.toISOString().slice(0, 10);
export const fromCalendarDate = (value: string): Date => new Date(`${value}T00:00:00.000Z`);
const optionalDate = (value: Date | null) => (value ? toCalendarDate(value) : null);

/** Display names for references to people (the users table is not tenant data). */
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
const personOf = (people: People, id: string) => ({ id, displayName: people.get(id) ?? "—" });

export const recordColumns = {
  id: true,
  versionNo: true,
  status: true,
  captureMethods: true,
  dpoName: true,
  dpoPhone: true,
  dpoOpinion: true,
  dpoOpinionOn: true,
  dpoNote: true,
  controllerName: true,
  controllerRole: true,
  controllerDecision: true,
  controllerDecisionOn: true,
  controllerNote: true,
  residualRisk: true,
  odpcReference: true,
  documentId: true,
  reviewDue: true,
  conditionsConfirmed: true,
  approvedDigest: true,
  approvedBy: true,
  approvedAt: true,
  rejectedBy: true,
  rejectedAt: true,
  rejectReason: true,
  withdrawnBy: true,
  withdrawnAt: true,
  withdrawReason: true,
  supersededById: true,
  supersededAt: true,
  version: true,
  createdBy: true,
  createdAt: true,
  updatedBy: true,
  updatedAt: true,
} as const satisfies Prisma.DpiaRecordSelect;
export type RecordRow = Prisma.DpiaRecordGetPayload<{ select: typeof recordColumns }>;

export type SiteRow = {
  id: string;
  name: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  projectStatus: ProjectStatus;
};

/** Every site of the company with its project, ordered by project code and site name. */
export async function companySites(tx: Tx, tenantId: string): Promise<SiteRow[]> {
  const sites = await tx.site.findMany({
    where: { tenantId },
    select: {
      id: true,
      name: true,
      projectId: true,
      project: { select: { code: true, name: true, status: true } },
    },
  });
  return sites
    .map((site) => ({
      id: site.id,
      name: site.name,
      projectId: site.projectId,
      projectCode: site.project.code,
      projectName: site.project.name,
      projectStatus: site.project.status as ProjectStatus,
    }))
    .sort(
      (a, b) => a.projectCode.localeCompare(b.projectCode) || a.name.localeCompare(b.name, "en"),
    );
}

export async function scopeOf(tx: Tx, tenantId: string, dpiaRecordId: string): Promise<string[]> {
  const rows = await tx.dpiaRecordSite.findMany({
    where: { tenantId, dpiaRecordId },
    select: { siteId: true },
  });
  return rows.map((row) => row.siteId);
}

/** The approved DPIA (in force or lapsed) with its scope, or null. */
export async function approvedDpia(tx: Tx, tenantId: string): Promise<ApprovedDpia | null> {
  const row = await tx.dpiaRecord.findFirst({
    where: { tenantId, status: "approved" },
    select: { id: true, reviewDue: true, captureMethods: true },
  });
  if (!row?.reviewDue) return null;
  return {
    id: row.id,
    reviewDue: toCalendarDate(row.reviewDue),
    methods: row.captureMethods as BiometricCaptureMethod[],
    siteIds: await scopeOf(tx, tenantId, row.id),
  };
}

export type LatestSwitch = BiometricSwitchFact & {
  siteId: string;
  projectId: string;
  method: BiometricCaptureMethod;
  carriedForward: boolean;
  actorId: string;
  createdAt: Date;
};

const switchKey = (siteId: string, method: string) => `${siteId}|${method}`;

/** The latest switch per site and method (the switch position), keyed by `site|method`. */
export async function latestSwitches(
  tx: Tx,
  tenantId: string,
  siteId?: string,
): Promise<Map<string, LatestSwitch>> {
  const rows = await tx.$queryRaw<
    {
      site_id: string;
      project_id: string;
      method: string;
      enabled: boolean;
      dpia_record_id: string | null;
      carried_forward: boolean;
      actor_id: string;
      created_at: Date;
    }[]
  >`SELECT DISTINCT ON (site_id, method) site_id, project_id, method, enabled, dpia_record_id,
           carried_forward, actor_id, created_at
      FROM biometric_switches
     WHERE tenant_id = ${tenantId}::uuid
       AND (${siteId ?? null}::uuid IS NULL OR site_id = ${siteId ?? null}::uuid)
     ORDER BY site_id, method, seq DESC`;
  return new Map(
    rows.map((row) => [
      switchKey(row.site_id, row.method),
      {
        siteId: row.site_id,
        projectId: row.project_id,
        method: row.method as BiometricCaptureMethod,
        enabled: row.enabled,
        dpiaRecordId: row.dpia_record_id,
        carriedForward: row.carried_forward,
        actorId: row.actor_id,
        createdAt: row.created_at,
      },
    ]),
  );
}

export const latestFor = (
  latest: Map<string, LatestSwitch>,
  siteId: string,
  method: BiometricCaptureMethod,
): LatestSwitch | null => latest.get(switchKey(siteId, method)) ?? null;

/** Switch candidates for carriedForwardSwitches, with each site's project status. */
export function switchCandidates(
  latest: Map<string, LatestSwitch>,
  sites: readonly SiteRow[],
): (SwitchCandidate & { projectId: string })[] {
  const status = new Map(sites.map((site) => [site.id, site.projectStatus]));
  return [...latest.values()].map((entry) => ({
    ...entry,
    projectStatus: status.get(entry.siteId) ?? "closed",
  }));
}

/** A site's gate state for every biometric method today. */
export function siteState(
  site: SiteRow,
  context: {
    platformAvailable: boolean;
    approved: ApprovedDpia | null;
    latest: Map<string, LatestSwitch>;
    today: string;
    people: People;
  },
): BiometricSite {
  return {
    ...site,
    methods: BIOMETRIC_CAPTURE_METHODS.map((method) => {
      const latest = latestFor(context.latest, site.id, method);
      const gate = biometricGate({
        platformAvailable: context.platformAvailable,
        projectStatus: site.projectStatus,
        approved: context.approved,
        latestSwitch: latest,
        siteId: site.id,
        method,
        today: context.today,
      });
      return {
        method,
        on: gate.on,
        reason: gate.reason,
        switchedOn: switchedOnUnder(latest, context.approved),
        inScope: context.approved ? dpiaCovers(context.approved, site.id, method) : false,
        lastChange: latest
          ? {
              enabled: latest.enabled,
              at: latest.createdAt.toISOString(),
              by: personOf(context.people, latest.actorId),
              carriedForward: latest.carriedForward,
            }
          : null,
      };
    }),
  };
}

export const switchPeople = (latest: Map<string, LatestSwitch>) =>
  [...latest.values()].map((entry) => entry.actorId);

export function summaryOf(
  row: Pick<
    RecordRow,
    | "id"
    | "versionNo"
    | "status"
    | "captureMethods"
    | "reviewDue"
    | "approvedAt"
    | "approvedBy"
    | "createdAt"
    | "createdBy"
  >,
  siteCount: number,
  people: People,
  today: string,
): DpiaSummary {
  const status = row.status as DpiaStatus;
  const reviewDue = optionalDate(row.reviewDue);
  return {
    id: row.id,
    versionNo: row.versionNo,
    status,
    state: dpiaState(status, reviewDue, today),
    methods: row.captureMethods as BiometricCaptureMethod[],
    siteCount,
    reviewDue,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    approvedBy: row.approvedBy ? personOf(people, row.approvedBy) : null,
    createdAt: row.createdAt.toISOString(),
    createdBy: personOf(people, row.createdBy),
  };
}

export const recordPeople = (row: RecordRow) => [
  row.createdBy,
  row.updatedBy,
  row.approvedBy,
  row.rejectedBy,
  row.withdrawnBy,
];

/** Draft facts for dpiaApprovalGaps. */
export const draftFacts = (row: RecordRow, siteCount: number) => ({
  hasDocument: row.documentId !== null,
  methods: row.captureMethods as BiometricCaptureMethod[],
  siteCount,
  dpoName: row.dpoName,
  dpoPhone: row.dpoPhone,
  dpoOpinion: row.dpoOpinion as DpoOpinion | null,
  dpoOpinionOn: optionalDate(row.dpoOpinionOn),
  dpoNote: row.dpoNote,
  controllerName: row.controllerName,
  controllerDecision: row.controllerDecision as ControllerDecision | null,
  controllerDecisionOn: optionalDate(row.controllerDecisionOn),
  controllerNote: row.controllerNote,
  residualRisk: row.residualRisk as ResidualRiskLevel | null,
  odpcReference: row.odpcReference,
});

export function detailOf(input: {
  row: RecordRow;
  sites: readonly SiteRow[];
  document: {
    id: string;
    fileName: string;
    sizeBytes: number;
    sha256: string;
    scanStatus: string;
    uploadedBy: string;
    uploadedAt: Date;
  } | null;
  replacedDocuments: number;
  successor: { id: string; versionNo: number } | null;
  people: People;
  permissions: ReadonlySet<Permission>;
  today: string;
}): DpiaDetail {
  const { row, people, today, permissions } = input;
  const status = row.status as DpiaStatus;
  const manage = permissions.has("biometrics.manage");
  const approve = permissions.has("biometrics.approve");
  const draft = status === "draft";
  return {
    ...summaryOf(row, input.sites.length, people, today),
    sites: [...input.sites],
    dpo: {
      name: row.dpoName,
      phone: row.dpoPhone,
      opinion: row.dpoOpinion as DpoOpinion | null,
      opinionOn: optionalDate(row.dpoOpinionOn),
      note: row.dpoNote,
    },
    controller: {
      name: row.controllerName,
      role: row.controllerRole,
      decision: row.controllerDecision as ControllerDecision | null,
      decisionOn: optionalDate(row.controllerDecisionOn),
      note: row.controllerNote,
    },
    residualRisk: row.residualRisk as ResidualRiskLevel | null,
    odpcReference: row.odpcReference,
    document: input.document
      ? {
          id: input.document.id,
          fileName: input.document.fileName,
          sizeBytes: input.document.sizeBytes,
          sha256: input.document.sha256,
          scanStatus: input.document.scanStatus as "clean" | "not_scanned",
          uploadedBy: personOf(people, input.document.uploadedBy),
          uploadedAt: input.document.uploadedAt.toISOString(),
        }
      : null,
    replacedDocuments: input.replacedDocuments,
    approval:
      row.approvedAt && row.approvedBy && row.reviewDue && row.approvedDigest
        ? {
            by: personOf(people, row.approvedBy),
            at: row.approvedAt.toISOString(),
            reviewDue: toCalendarDate(row.reviewDue),
            conditions: row.conditionsConfirmed as DpiaGoLiveCondition[],
            digest: row.approvedDigest,
          }
        : null,
    rejection:
      row.rejectedAt && row.rejectedBy && row.rejectReason
        ? {
            by: personOf(people, row.rejectedBy),
            at: row.rejectedAt.toISOString(),
            reason: row.rejectReason,
          }
        : null,
    withdrawal:
      row.withdrawnAt && row.withdrawnBy && row.withdrawReason
        ? {
            by: personOf(people, row.withdrawnBy),
            at: row.withdrawnAt.toISOString(),
            reason: row.withdrawReason,
          }
        : null,
    supersession:
      row.supersededAt && input.successor
        ? { by: input.successor, at: row.supersededAt.toISOString() }
        : null,
    approvalGaps: draft ? dpiaApprovalGaps(draftFacts(row, input.sites.length), today) : [],
    reviewDueRange: dpiaReviewDueRange(today),
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: personOf(people, row.updatedBy),
    version: row.version,
    permissions: {
      canEdit: draft && manage,
      canApprove: draft && approve,
      canReject: draft && approve,
      canWithdraw: status === "approved" && approve,
    },
  };
}
