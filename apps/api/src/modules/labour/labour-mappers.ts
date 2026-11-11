import {
  accreditationStatus,
  ageOn,
  calendarDaysBetween,
  maskIdentifier,
  maskPhone,
  summariseAccreditation,
} from "@pm-buddy/domain";
import { CURRENT_CONSENT_NOTICE, type Permission } from "@pm-buddy/types";
import type {
  AccreditationRecord,
  ConsentRecord,
  Engagement,
  LabourerDetail,
  LabourerSummary,
  LabourRate,
  SkillLevel,
  Trade,
} from "@pm-buddy/validation";
import { Logger } from "@nestjs/common";
import type { Prisma } from "../../generated/prisma/client.js";
import { toCalendarDate } from "../projects/project-mappers.js";
import { FieldCipherError } from "./field-cipher.js";
import { inProjects, type LabourCrypto, type ProjectSet } from "./labour-support.js";

const optionalDate = (value: Date | null) => (value ? toCalendarDate(value) : null);
const logger = new Logger("LabourMappers");
/** Shown when a stored value cannot be decrypted (for example a retired key version). */
export const UNREADABLE_MASK = "•••••";

/**
 * Masks a decrypted value. A value that cannot be decrypted shows as unreadable and is logged
 * (without any value) instead of failing the whole registry page.
 */
function safely(labourerId: string, column: string, mask: () => string): string {
  try {
    return mask();
  } catch (error) {
    if (!(error instanceof FieldCipherError)) throw error;
    logger.warn(`Unreadable ${column} for labourer ${labourerId}: ${error.message}`);
    return UNREADABLE_MASK;
  }
}

export type TradeRow = Prisma.TradeGetPayload<object>;
export type SkillLevelRow = Prisma.SkillLevelGetPayload<object>;
export type RateRow = Prisma.LabourRateGetPayload<object>;

export const toTrade = (row: TradeRow): Trade => ({
  id: row.id,
  key: row.key,
  nameEn: row.nameEn,
  nameSw: row.nameSw,
  active: row.active,
  sortOrder: row.sortOrder,
  version: row.version,
});

export const toSkillLevel = (row: SkillLevelRow): SkillLevel => ({
  id: row.id,
  key: row.key,
  nameEn: row.nameEn,
  nameSw: row.nameSw,
  ncaCategory: row.ncaCategory as SkillLevel["ncaCategory"],
  accreditationExpected: row.accreditationExpected,
  active: row.active,
  sortOrder: row.sortOrder,
  version: row.version,
});

/** Every relation the registry row and the side panel need (one query per page). */
export const labourerInclude = {
  trade: true,
  skillLevel: true,
  engagements: {
    include: { project: { select: { id: true, code: true, name: true } } },
    orderBy: [{ startDate: "desc" }, { createdAt: "desc" }],
  },
  gangMembers: {
    include: { gang: { select: { id: true, name: true, projectId: true } } },
    orderBy: [{ joinedOn: "desc" }, { createdAt: "desc" }],
  },
  accreditations: { orderBy: [{ expiresOn: "desc" }, { createdAt: "desc" }] },
  consents: { orderBy: [{ capturedAt: "desc" }, { id: "desc" }] },
} satisfies Prisma.LabourerInclude;
export type LabourerRow = Prisma.LabourerGetPayload<{ include: typeof labourerInclude }>;

const groupBy = <T extends { labourerId: string }>(rows: readonly T[]) => {
  const groups = new Map<string, T[]>();
  for (const row of rows) groups.set(row.labourerId, [...(groups.get(row.labourerId) ?? []), row]);
  return groups;
};

/**
 * Labourers with every relation the registry and side panel need, loaded with one query per
 * relation in sequence. (A multi-relation `include` makes Prisma issue concurrent queries, which a
 * single transaction connection cannot run in parallel.)
 */
export async function loadLabourers(
  tx: Prisma.TransactionClient,
  tenantId: string,
  where: Prisma.LabourerWhereInput,
): Promise<LabourerRow[]> {
  const rows = await tx.labourer.findMany({
    where: { AND: [{ tenantId }, where] },
    orderBy: { workerNo: "asc" },
  });
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const byLabourer = { tenantId, labourerId: { in: ids } };
  const trades = await tx.trade.findMany({
    where: { tenantId, id: { in: [...new Set(rows.map((row) => row.tradeId))] } },
  });
  const levels = await tx.skillLevel.findMany({
    where: { tenantId, id: { in: [...new Set(rows.map((row) => row.skillLevelId))] } },
  });
  const engagements = groupBy(
    await tx.labourEngagement.findMany({ where: byLabourer, ...labourerInclude.engagements }),
  );
  const gangMembers = groupBy(
    await tx.gangMembership.findMany({ where: byLabourer, ...labourerInclude.gangMembers }),
  );
  const accreditations = groupBy(
    await tx.labourerAccreditation.findMany({
      where: byLabourer,
      ...labourerInclude.accreditations,
    }),
  );
  const consents = groupBy(
    await tx.labourerConsent.findMany({ where: byLabourer, ...labourerInclude.consents }),
  );
  const tradeById = new Map(trades.map((trade) => [trade.id, trade]));
  const levelById = new Map(levels.map((level) => [level.id, level]));
  return rows.map((row) => ({
    ...row,
    trade: tradeById.get(row.tradeId)!,
    skillLevel: levelById.get(row.skillLevelId)!,
    engagements: engagements.get(row.id) ?? [],
    gangMembers: gangMembers.get(row.id) ?? [],
    accreditations: accreditations.get(row.id) ?? [],
    consents: consents.get(row.id) ?? [],
  }));
}

export type MapContext = {
  crypto: LabourCrypto;
  tenantId: string;
  today: string;
  alertDays: number;
  /** Projects whose engagements and gangs the caller may see. */
  visibleProjects: ProjectSet;
  /** The caller sees the do-not-rehire flag (labour.manage or labour.do_not_rehire). */
  canSeeFlag: boolean;
};

const named = (row: { id: string; nameEn: string; nameSw: string; active: boolean }) => ({
  id: row.id,
  nameEn: row.nameEn,
  nameSw: row.nameSw,
  active: row.active,
});

/** Granted and not withdrawn → granted; only withdrawn ones → withdrawn; none → missing. */
export function consentSummary(row: Pick<LabourerRow, "consents">): LabourerSummary["consent"] {
  const consents = row.consents.filter((consent) => consent.kind === "registration_data");
  const active = consents.find((consent) => consent.granted && !consent.withdrawnAt);
  if (active)
    return {
      status: "granted",
      noticeVersion: active.noticeVersion as LabourerSummary["consent"]["noticeVersion"],
      current: active.noticeVersion === CURRENT_CONSENT_NOTICE.version,
    };
  const withdrawn = consents.find((consent) => consent.withdrawnAt);
  return {
    status: withdrawn ? "withdrawn" : "missing",
    noticeVersion: (withdrawn?.noticeVersion ??
      null) as LabourerSummary["consent"]["noticeVersion"],
    current: false,
  };
}

export function accreditationSummary(
  row: Pick<LabourerRow, "accreditations" | "skillLevel">,
  today: string,
  alertDays: number,
) {
  return summariseAccreditation(
    row.accreditations.map((card) => ({ expiresOn: toCalendarDate(card.expiresOn) })),
    row.skillLevel.accreditationExpected,
    today,
    alertDays,
  );
}

export function toSummary(row: LabourerRow, ctx: MapContext): LabourerSummary {
  const open = (column: Parameters<LabourCrypto["open"]>[2], value: Uint8Array) =>
    ctx.crypto.open(ctx.tenantId, row.id, column, value);
  const gang = row.gangMembers.find(
    (member) => !member.leftOn && inProjects(ctx.visibleProjects, member.gang.projectId),
  );
  return {
    id: row.id,
    workerNo: row.workerNo,
    fullName: row.fullName,
    status: row.status as LabourerSummary["status"],
    gender: row.gender as LabourerSummary["gender"],
    trade: named(row.trade),
    skillLevel: {
      ...named(row.skillLevel),
      ncaCategory: row.skillLevel.ncaCategory as SkillLevel["ncaCategory"],
    },
    engagementType: row.engagementType as LabourerSummary["engagementType"],
    rateBasis: row.rateBasis as LabourerSummary["rateBasis"],
    projects: row.engagements
      .filter(
        (engagement) =>
          !engagement.endDate && inProjects(ctx.visibleProjects, engagement.projectId),
      )
      .map((engagement) => ({
        projectId: engagement.projectId,
        code: engagement.project.code,
        name: engagement.project.name,
        startDate: toCalendarDate(engagement.startDate),
      })),
    gang: gang ? { id: gang.gang.id, name: gang.gang.name, projectId: gang.gang.projectId } : null,
    accreditation: accreditationSummary(row, ctx.today, ctx.alertDays),
    consent: consentSummary(row),
    idType: row.idType as LabourerSummary["idType"],
    idNumberMasked: safely(row.id, "id_number_enc", () =>
      maskIdentifier(open("id_number_enc", row.idNumberEnc)),
    ),
    phoneMasked: row.phoneEnc
      ? safely(row.id, "phone_enc", () => maskPhone(open("phone_enc", row.phoneEnc!)))
      : null,
    doNotRehire: ctx.canSeeFlag ? row.doNotRehire : null,
    registeredOn: toCalendarDate(row.registeredOn),
  };
}

export type DetailExtras = {
  effective: ReadonlySet<Permission>;
  names: ReadonlyMap<string, string>;
  /** The latest "set" event's decrypted reason, when the caller may read it. */
  doNotRehireReason: string | null;
};

export function toDetail(row: LabourerRow, ctx: MapContext, extras: DetailExtras): LabourerDetail {
  const summary = toSummary(row, ctx);
  const actor = (id: string | null) =>
    id ? { id, displayName: extras.names.get(id) ?? "—" } : null;
  const masked = (column: Parameters<LabourCrypto["open"]>[2], value: Uint8Array | null) =>
    value
      ? safely(row.id, column, () =>
          maskIdentifier(ctx.crypto.open(ctx.tenantId, row.id, column, value)),
        )
      : null;
  const dateOfBirth = toCalendarDate(row.dateOfBirth);
  const engagements: Engagement[] = row.engagements
    .filter((engagement) => inProjects(ctx.visibleProjects, engagement.projectId))
    .map((engagement) => ({
      id: engagement.id,
      projectId: engagement.projectId,
      projectCode: engagement.project.code,
      projectName: engagement.project.name,
      startDate: toCalendarDate(engagement.startDate),
      endDate: optionalDate(engagement.endDate),
      endReason: engagement.endReason,
      open: !engagement.endDate,
    }));
  const accreditations: AccreditationRecord[] = row.accreditations.map((card) => {
    const expiresOn = toCalendarDate(card.expiresOn);
    return {
      id: card.id,
      category: card.category as AccreditationRecord["category"],
      cardNumber: card.cardNumber,
      issuedOn: optionalDate(card.issuedOn),
      expiresOn,
      status: accreditationStatus(expiresOn, ctx.today, ctx.alertDays),
      daysLeft: calendarDaysBetween(ctx.today, expiresOn),
      version: card.version,
    };
  });
  const consents: ConsentRecord[] = row.consents.map((consent) => ({
    id: consent.id,
    kind: consent.kind as ConsentRecord["kind"],
    noticeVersion: consent.noticeVersion as ConsentRecord["noticeVersion"],
    language: consent.language as ConsentRecord["language"],
    method: consent.method as ConsentRecord["method"],
    witnessName: consent.witnessName,
    granted: consent.granted,
    capturedAt: consent.capturedAt.toISOString(),
    capturedBy: actor(consent.capturedBy)!,
    withdrawnAt: consent.withdrawnAt?.toISOString() ?? null,
    withdrawnBy: actor(consent.withdrawnBy),
    withdrawalMethod: (consent.withdrawalMethod ?? null) as ConsentRecord["withdrawalMethod"],
  }));
  const canFlag = extras.effective.has("labour.do_not_rehire");
  return {
    ...summary,
    dateOfBirth,
    age: ageOn(dateOfBirth, ctx.today),
    homeCounty: row.homeCounty as LabourerDetail["homeCounty"],
    kraPinMasked: masked("kra_pin_enc", row.kraPinEnc),
    nssfNumberMasked: masked("nssf_number_enc", row.nssfNumberEnc),
    shaNumberMasked: masked("sha_number_enc", row.shaNumberEnc),
    nextOfKinRecorded: row.nextOfKinEnc !== null,
    engagements,
    gangHistory: row.gangMembers
      .filter((member) => inProjects(ctx.visibleProjects, member.gang.projectId))
      .map((member) => ({
        membershipId: member.id,
        gangId: member.gang.id,
        gangName: member.gang.name,
        projectId: member.gang.projectId,
        joinedOn: toCalendarDate(member.joinedOn),
        leftOn: optionalDate(member.leftOn),
      })),
    accreditations,
    consents,
    doNotRehireDetail: ctx.canSeeFlag
      ? {
          flagged: row.doNotRehire,
          setAt: row.doNotRehireAt?.toISOString() ?? null,
          setBy: actor(row.doNotRehireBy),
          reason: row.doNotRehire && canFlag ? extras.doNotRehireReason : null,
        }
      : null,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    permissions: {
      canManage: extras.effective.has("labour.manage"),
      canReveal: extras.effective.has("labour.view_sensitive"),
      canFlag,
      canConsent: extras.effective.has("labour.consent"),
    },
  };
}

/** A rate row on the wire; `all` is the full history so `effectiveTo` can be derived. */
export function toRate(
  row: RateRow,
  effectiveTo: string | null,
  today: string,
  names: ReadonlyMap<string, string>,
): LabourRate {
  const effectiveFrom = toCalendarDate(row.effectiveFrom);
  const rateMinor = Number(row.rateMinor);
  return {
    id: row.id,
    scope: row.labourerId
      ? "labourer"
      : row.projectId
        ? row.skillLevelId
          ? "project_skill"
          : "project_trade"
        : row.skillLevelId
          ? "company_skill"
          : "company_trade",
    projectId: row.projectId,
    labourerId: row.labourerId,
    tradeId: row.tradeId,
    skillLevelId: row.skillLevelId,
    basis: row.basis as LabourRate["basis"],
    rateMinor,
    currency: "KES",
    effectiveFrom,
    effectiveTo,
    inForce: effectiveFrom <= today && (effectiveTo === null || effectiveTo >= today),
    scheduled: effectiveFrom > today,
    createdAt: row.createdAt.toISOString(),
    createdBy: { id: row.createdBy, displayName: names.get(row.createdBy) ?? "—" },
  };
}

export async function displayNames(
  tx: Prisma.TransactionClient,
  ids: readonly (string | null)[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!unique.length) return new Map();
  const users = await tx.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, displayName: true },
  });
  return new Map(users.map((user) => [user.id, user.displayName]));
}
