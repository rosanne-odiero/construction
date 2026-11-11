/**
 * Labour registry (D3.1) routes of the Playwright mock API (see mock-api.mts). Requests are parsed
 * with the shared request schemas and every reply names its shared response schema, so the browser
 * suite also checks the wire contract. Identifiers are kept in plain text here only because this
 * is an in-memory test double; the real API stores them encrypted. Synthetic data only.
 */
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import {
  accreditationStatus,
  addCalendarDays,
  calendarDaysBetween,
  isOldEnoughToRegister,
  maskIdentifier,
  maskPhone,
  nairobiDate,
  rateEffectiveTo,
  rateScopeOf,
  summariseAccreditation,
} from "@pm-buddy/domain";
import { CURRENT_CONSENT_NOTICE, type ConsentNoticeVersion } from "@pm-buddy/types";
import {
  accreditationAlertsResponseSchema,
  addGangMemberRequestSchema,
  createAccreditationRequestSchema,
  createEngagementRequestSchema,
  createGangRequestSchema,
  createLabourRateRequestSchema,
  createLabourViewRequestSchema,
  createSkillLevelRequestSchema,
  createTradeRequestSchema,
  doNotRehireRequestSchema,
  endEngagementRequestSchema,
  gangDetailResponseSchema,
  gangsResponseSchema,
  labourerListQuerySchema,
  labourerResponseSchema,
  labourersResponseSchema,
  labourerStatusRequestSchema,
  labourRateResponseSchema,
  labourRatesResponseSchema,
  labourSetupResponseSchema,
  labourViewResponseSchema,
  labourViewsResponseSchema,
  leaveGangRequestSchema,
  messageResponseSchema,
  recordConsentRequestSchema,
  registerLabourerRequestSchema,
  revealRequestSchema,
  revealResponseSchema,
  skillLevelResponseSchema,
  tradeResponseSchema,
  updateGangRequestSchema,
  updateLabourerRequestSchema,
  updateLabourSettingsRequestSchema,
  updateSkillLevelRequestSchema,
  updateTradeRequestSchema,
  withdrawConsentRequestSchema,
  type AccreditationRecord,
  type ConsentRecord,
  type Engagement,
  type LabourerDetail,
  type LabourerSummary,
  type LabourerWarning,
  type LabourRate,
  type LabourView,
  type SkillLevel,
  type Trade,
} from "@pm-buddy/validation";

export const LABOUR_IDS = {
  mason: "40000000-0000-4000-8000-000000000001",
  carpenter: "40000000-0000-4000-8000-000000000002",
  general: "40000000-0000-4000-8000-000000000003",
  skilled: "41000000-0000-4000-8000-000000000001",
  semiSkilled: "41000000-0000-4000-8000-000000000002",
  unskilled: "41000000-0000-4000-8000-000000000003",
  amina: "42000000-0000-4000-8000-000000000001",
  joseph: "42000000-0000-4000-8000-000000000002",
  grace: "42000000-0000-4000-8000-000000000003",
  peter: "42000000-0000-4000-8000-000000000004",
  mercy: "42000000-0000-4000-8000-000000000005",
  oscar: "42000000-0000-4000-8000-000000000006",
  gang: "43000000-0000-4000-8000-000000000001",
} as const;
/** Joseph's synthetic national ID and Oscar's (flagged) phone, used by the registration tests. */
export const MOCK_DUPLICATE_ID = "23456781";
export const MOCK_FLAGGED_PHONE = "0700000106";

export type Reply = { status?: number; body: unknown; schema: z.ZodType<unknown> };
export type LabourContext = {
  persona: "owner" | "agent";
  user: { id: string; displayName: string };
  projects: { id: string; code: string; name: string; status: string }[];
  stepUpFresh: () => boolean;
  fail: (status: number, code: string, match?: Record<string, string>) => never;
};

type Card = Omit<AccreditationRecord, "status" | "daysLeft">;
type MockLabourer = {
  id: string;
  workerNo: string;
  fullName: string;
  status: LabourerSummary["status"];
  gender: LabourerSummary["gender"];
  homeCounty: LabourerDetail["homeCounty"];
  tradeId: string;
  skillLevelId: string;
  engagementType: LabourerSummary["engagementType"];
  rateBasis: LabourerSummary["rateBasis"];
  dateOfBirth: string;
  registeredOn: string;
  idType: LabourerSummary["idType"];
  idNumber: string;
  phone: string | null;
  kraPin: string | null;
  nssfNumber: string | null;
  shaNumber: string | null;
  nextOfKin: { name: string; relationship: string; phone: string | null } | null;
  flag: { flagged: boolean; setAt: string | null; reason: string | null };
  engagements: Engagement[];
  cards: Card[];
  consents: ConsentRecord[];
  version: number;
  createdAt: string;
  updatedAt: string;
};
type MockGang = {
  id: string;
  projectId: string;
  siteId: string | null;
  siteName: string | null;
  name: string;
  status: "active" | "archived";
  leaderId: string | null;
  members: { membershipId: string; labourerId: string; joinedOn: string; leftOn: string | null }[];
  version: number;
  createdAt: string;
  updatedAt: string;
};
type MockRate = Omit<LabourRate, "scope" | "effectiveTo" | "inForce" | "scheduled">;
export type LabourState = {
  trades: Trade[];
  skillLevels: SkillLevel[];
  settings: { accreditationAlertDays: number; version: number };
  labourers: MockLabourer[];
  gangs: MockGang[];
  rates: MockRate[];
  views: LabourView[];
};

const NOW = "2026-11-10T07:45:00.000Z";
const RUIRU = "30000000-0000-4000-8000-000000000001";
const id = () => randomUUID();
const actor = (ctx: LabourContext) => ({ id: ctx.user.id, displayName: ctx.user.displayName });

function consent(capturedAt: string, language: "en" | "sw" = "en"): ConsentRecord {
  return {
    id: id(),
    kind: "registration_data",
    noticeVersion: CURRENT_CONSENT_NOTICE.version,
    language,
    method: language === "sw" ? "witnessed_verbal" : "signed",
    witnessName: language === "sw" ? "Kevin Kiprono" : null,
    granted: true,
    capturedAt,
    capturedBy: { id: "21000000-0000-4000-8000-000000000001", displayName: "Wanjiru Kamau" },
    withdrawnAt: null,
    withdrawnBy: null,
    withdrawalMethod: null,
  };
}

export function labourFixture(): LabourState {
  const today = nairobiDate();
  const name = (key: string, nameEn: string, nameSw: string, sortOrder: number) => ({
    key,
    nameEn,
    nameSw,
    active: true,
    sortOrder,
    version: 1,
  });
  const trades: Trade[] = [
    { id: LABOUR_IDS.mason, ...name("mason", "Mason", "Fundi mwashi", 0) },
    { id: LABOUR_IDS.carpenter, ...name("carpenter", "Carpenter", "Seremala", 1) },
    { id: LABOUR_IDS.general, ...name("general_labourer", "General labourer", "Kibarua", 2) },
  ];
  const skillLevels: SkillLevel[] = [
    {
      id: LABOUR_IDS.skilled,
      ...name("skilled", "Skilled", "Stadi", 0),
      ncaCategory: "skilled",
      accreditationExpected: true,
    },
    {
      id: LABOUR_IDS.semiSkilled,
      ...name("semi_skilled", "Semi-skilled", "Nusu stadi", 1),
      ncaCategory: "semi_skilled",
      accreditationExpected: false,
    },
    {
      id: LABOUR_IDS.unskilled,
      ...name("unskilled", "Unskilled", "Asiye stadi", 2),
      ncaCategory: "unskilled",
      accreditationExpected: false,
    },
  ];
  const engagement = (startDate: string, endDate: string | null = null): Engagement => ({
    id: id(),
    projectId: RUIRU,
    projectCode: "RUI-HTS",
    projectName: "Ruiru Heights Apartments",
    startDate,
    endDate,
    endReason: endDate ? "Contract for the substructure ended" : null,
    open: endDate === null,
  });
  const card = (cardNumber: string, expiresOn: string): Card => ({
    id: id(),
    category: "nca_skilled_worker",
    cardNumber,
    issuedOn: null,
    expiresOn,
    version: 1,
  });
  const person = (
    fields: Partial<MockLabourer> &
      Pick<MockLabourer, "id" | "workerNo" | "fullName" | "idNumber" | "tradeId" | "skillLevelId">,
  ): MockLabourer => ({
    status: "active",
    gender: "male",
    homeCounty: "kiambu",
    engagementType: "casual",
    rateBasis: "daily",
    dateOfBirth: "1990-05-14",
    registeredOn: "2026-03-02",
    idType: "national_id",
    phone: null,
    kraPin: null,
    nssfNumber: null,
    shaNumber: null,
    nextOfKin: null,
    flag: { flagged: false, setAt: null, reason: null },
    engagements: [engagement("2026-03-02")],
    cards: [],
    consents: [consent("2026-03-02T06:30:00.000Z")],
    version: 1,
    createdAt: "2026-03-02T06:30:00.000Z",
    updatedAt: "2026-03-02T06:30:00.000Z",
    ...fields,
  });
  const labourers = [
    person({
      id: LABOUR_IDS.amina,
      workerNo: "WRK-0001",
      fullName: "Amina Wekesa Njoroge",
      gender: "female",
      idNumber: "12345678",
      phone: "254700000101",
      kraPin: "A000000101Z",
      nssfNumber: "NSSF000101",
      nextOfKin: { name: "Halima Wekesa", relationship: "Sister", phone: "254700000201" },
      tradeId: LABOUR_IDS.mason,
      skillLevelId: LABOUR_IDS.skilled,
      cards: [card("NCA-TEST-0101", addCalendarDays(today, 400))],
    }),
    person({
      id: LABOUR_IDS.joseph,
      workerNo: "WRK-0002",
      fullName: "Joseph Mwangi Kariuki",
      idNumber: MOCK_DUPLICATE_ID,
      phone: "254700000102",
      tradeId: LABOUR_IDS.mason,
      skillLevelId: LABOUR_IDS.skilled,
      cards: [card("NCA-TEST-0102", addCalendarDays(today, 12))],
      consents: [consent("2026-03-02T06:40:00.000Z", "sw")],
    }),
    person({
      id: LABOUR_IDS.grace,
      workerNo: "WRK-0003",
      fullName: "Grace Atieno Odhiambo",
      gender: "female",
      idNumber: "34567812",
      phone: "254700000103",
      tradeId: LABOUR_IDS.carpenter,
      skillLevelId: LABOUR_IDS.skilled,
      cards: [card("NCA-TEST-0103", addCalendarDays(today, -6))],
    }),
    person({
      id: LABOUR_IDS.peter,
      workerNo: "WRK-0004",
      fullName: "Peter Kiprotich Langat",
      idNumber: "45678123",
      tradeId: LABOUR_IDS.carpenter,
      skillLevelId: LABOUR_IDS.skilled,
    }),
    person({
      id: LABOUR_IDS.mercy,
      workerNo: "WRK-0005",
      fullName: "Mercy Chebet Rotich",
      gender: "female",
      idNumber: "56781234",
      phone: "254700000105",
      tradeId: LABOUR_IDS.general,
      skillLevelId: LABOUR_IDS.unskilled,
      status: "inactive",
    }),
    person({
      id: LABOUR_IDS.oscar,
      workerNo: "WRK-0006",
      fullName: "Oscar Mutai Kirui",
      idNumber: "67812345",
      phone: "254700000106",
      tradeId: LABOUR_IDS.general,
      skillLevelId: LABOUR_IDS.unskilled,
      status: "left",
      engagements: [engagement("2026-03-02", "2026-06-30")],
      flag: {
        flagged: true,
        setAt: "2026-07-01T08:00:00.000Z",
        reason: "Synthetic example: repeated safety breaches recorded in the site diary.",
      },
    }),
  ];
  const gang: MockGang = {
    id: LABOUR_IDS.gang,
    projectId: RUIRU,
    siteId: "31000000-0000-4000-8000-000000000001",
    siteName: "Main plot",
    name: "Masonry gang A",
    status: "active",
    leaderId: LABOUR_IDS.amina,
    members: [LABOUR_IDS.amina, LABOUR_IDS.joseph].map((labourerId) => ({
      membershipId: id(),
      labourerId,
      joinedOn: "2026-03-02",
      leftOn: null,
    })),
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const owner = { id: "21000000-0000-4000-8000-000000000001", displayName: "Wanjiru Kamau" };
  const rate = (rateMinor: number, effectiveFrom: string): MockRate => ({
    id: id(),
    projectId: null,
    labourerId: null,
    tradeId: LABOUR_IDS.mason,
    skillLevelId: null,
    basis: "daily",
    rateMinor,
    currency: "KES",
    effectiveFrom,
    createdAt: NOW,
    createdBy: owner,
  });
  return {
    trades,
    skillLevels,
    settings: { accreditationAlertDays: 30, version: 0 },
    labourers,
    gangs: [gang],
    rates: [rate(150_000, "2026-01-01"), rate(165_000, addCalendarDays(today, 7))],
    views: [],
  };
}

// Projections ------------------------------------------------------------------------------------

function wireRates(rates: MockRate[], today: string): LabourRate[] {
  return rates
    .map((row) => {
      const effectiveTo = rateEffectiveTo(row, rates);
      return {
        ...row,
        scope: rateScopeOf(row),
        effectiveTo,
        inForce: row.effectiveFrom <= today && (effectiveTo === null || effectiveTo >= today),
        scheduled: row.effectiveFrom > today,
      };
    })
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
}

function setupView(ctx: LabourContext, labour: LabourState) {
  return {
    trades: labour.trades,
    skillLevels: labour.skillLevels,
    settings: labour.settings,
    canConfigure: true,
    manageableProjects: ctx.projects
      .filter((project) => !["closed", "cancelled"].includes(project.status))
      .map(({ id: projectId, code, name }) => ({ id: projectId, code, name })),
  };
}

function summary(labour: LabourState, row: MockLabourer): LabourerSummary {
  const today = nairobiDate();
  const trade = labour.trades.find((entry) => entry.id === row.tradeId)!;
  const level = labour.skillLevels.find((entry) => entry.id === row.skillLevelId)!;
  const gang = labour.gangs.find((entry) =>
    entry.members.some((member) => member.labourerId === row.id && member.leftOn === null),
  );
  const active = row.consents.find((entry) => entry.granted && !entry.withdrawnAt);
  return {
    id: row.id,
    workerNo: row.workerNo,
    fullName: row.fullName,
    status: row.status,
    gender: row.gender,
    trade: { id: trade.id, nameEn: trade.nameEn, nameSw: trade.nameSw, active: trade.active },
    skillLevel: {
      id: level.id,
      nameEn: level.nameEn,
      nameSw: level.nameSw,
      active: level.active,
      ncaCategory: level.ncaCategory,
    },
    engagementType: row.engagementType,
    rateBasis: row.rateBasis,
    projects: row.engagements
      .filter((entry) => entry.open)
      .map((entry) => ({
        projectId: entry.projectId,
        code: entry.projectCode,
        name: entry.projectName,
        startDate: entry.startDate,
      })),
    gang: gang ? { id: gang.id, name: gang.name, projectId: gang.projectId } : null,
    accreditation: summariseAccreditation(
      row.cards,
      level.accreditationExpected,
      today,
      labour.settings.accreditationAlertDays,
    ),
    consent: active
      ? {
          status: "granted",
          noticeVersion: active.noticeVersion,
          current: active.noticeVersion === CURRENT_CONSENT_NOTICE.version,
        }
      : row.consents.length
        ? { status: "withdrawn", noticeVersion: row.consents[0]!.noticeVersion, current: false }
        : { status: "missing", noticeVersion: null, current: false },
    idType: row.idType,
    idNumberMasked: maskIdentifier(row.idNumber),
    phoneMasked: row.phone ? maskPhone(row.phone) : null,
    doNotRehire: row.flag.flagged,
    registeredOn: row.registeredOn,
  };
}

function detail(labour: LabourState, row: MockLabourer, ctx: LabourContext): LabourerDetail {
  const today = nairobiDate();
  const years = Number(today.slice(0, 4)) - Number(row.dateOfBirth.slice(0, 4));
  const age = today.slice(5) < row.dateOfBirth.slice(5) ? years - 1 : years;
  const owner = { id: ctx.user.id, displayName: ctx.user.displayName };
  return {
    ...summary(labour, row),
    dateOfBirth: row.dateOfBirth,
    age,
    homeCounty: row.homeCounty,
    kraPinMasked: row.kraPin ? maskIdentifier(row.kraPin) : null,
    nssfNumberMasked: row.nssfNumber ? maskIdentifier(row.nssfNumber) : null,
    shaNumberMasked: row.shaNumber ? maskIdentifier(row.shaNumber) : null,
    nextOfKinRecorded: row.nextOfKin !== null,
    engagements: row.engagements,
    gangHistory: labour.gangs.flatMap((gang) =>
      gang.members
        .filter((member) => member.labourerId === row.id)
        .map((member) => ({
          membershipId: member.membershipId,
          gangId: gang.id,
          gangName: gang.name,
          projectId: gang.projectId,
          joinedOn: member.joinedOn,
          leftOn: member.leftOn,
        })),
    ),
    accreditations: row.cards.map((entry) => ({
      ...entry,
      status: accreditationStatus(entry.expiresOn, today, labour.settings.accreditationAlertDays),
      daysLeft: calendarDaysBetween(today, entry.expiresOn),
    })),
    consents: [...row.consents].reverse(),
    doNotRehireDetail: {
      flagged: row.flag.flagged,
      setAt: row.flag.setAt,
      setBy: row.flag.setAt ? owner : null,
      reason: row.flag.reason,
    },
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    permissions: { canManage: true, canReveal: true, canFlag: true, canConsent: true },
  };
}

function gangView(labour: LabourState, ctx: LabourContext, gang: MockGang) {
  const project = ctx.projects.find((entry) => entry.id === gang.projectId)!;
  const leader = labour.labourers.find((entry) => entry.id === gang.leaderId);
  return {
    id: gang.id,
    projectId: gang.projectId,
    projectCode: project.code,
    projectName: project.name,
    siteId: gang.siteId,
    siteName: gang.siteName,
    name: gang.name,
    status: gang.status,
    leader: leader
      ? { labourerId: leader.id, workerNo: leader.workerNo, fullName: leader.fullName }
      : null,
    memberCount: gang.members.filter((member) => member.leftOn === null).length,
    version: gang.version,
    createdAt: gang.createdAt,
    updatedAt: gang.updatedAt,
  };
}

function gangDetail(labour: LabourState, ctx: LabourContext, gang: MockGang) {
  return {
    gang: gangView(labour, ctx, gang),
    members: gang.members.map((member) => {
      const person = labour.labourers.find((entry) => entry.id === member.labourerId)!;
      return {
        ...member,
        workerNo: person.workerNo,
        fullName: person.fullName,
        current: member.leftOn === null,
      };
    }),
    canManage: true,
  };
}

// Routes -----------------------------------------------------------------------------------------

function parse<T>(ctx: LabourContext, schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) ctx.fail(400, "validation-error");
  return result.data!;
}

const bump = (
  row: { version: number; updatedAt: string },
  expected?: number,
  ctx?: LabourContext,
) => {
  if (expected !== undefined && row.version !== expected) ctx!.fail(409, "version-conflict");
  row.version += 1;
  row.updatedAt = new Date().toISOString();
};

function labourerReply(
  labour: LabourState,
  ctx: LabourContext,
  row: MockLabourer,
  warnings: LabourerWarning[] = [],
  status?: number,
): Reply {
  return {
    status,
    body: { labourer: detail(labour, row, ctx), warnings },
    schema: labourerResponseSchema,
  };
}

export function handleLabour(
  ctx: LabourContext,
  labour: LabourState,
  method: string,
  path: string,
  query: URLSearchParams,
  body: unknown,
): Reply | null {
  if (!path.startsWith("/labour")) return null;
  // The site-agent persona holds no labour permission on any project in this fixture.
  if (ctx.persona !== "owner") ctx.fail(403, "forbidden");
  const today = nairobiDate();
  const project = (projectId: string) => {
    const entry = ctx.projects.find((candidate) => candidate.id === projectId);
    if (!entry) ctx.fail(404, "not-found");
    return entry!;
  };
  const labourer = (labourerId: string) => {
    const row = labour.labourers.find((entry) => entry.id === labourerId);
    if (!row) ctx.fail(404, "not-found");
    return row!;
  };
  const setup = (): Reply => ({ body: setupView(ctx, labour), schema: labourSetupResponseSchema });

  if (path === "/labour/setup" && method === "GET") return setup();
  if (path === "/labour/setup/defaults" && method === "POST") return setup();
  if (path === "/labour/settings" && method === "PUT") {
    const input = parse(ctx, updateLabourSettingsRequestSchema, body);
    if (input.version !== labour.settings.version) ctx.fail(409, "version-conflict");
    labour.settings = {
      accreditationAlertDays: input.accreditationAlertDays,
      version: input.version + 1,
    };
    return setup();
  }
  if (path === "/labour/trades" && method === "POST") {
    const input = parse(ctx, createTradeRequestSchema, body);
    if (labour.trades.some((entry) => entry.key === input.key)) ctx.fail(409, "trade-key-taken");
    const trade: Trade = {
      id: id(),
      ...input,
      active: true,
      sortOrder: labour.trades.length,
      version: 1,
    };
    labour.trades.push(trade);
    return { status: 201, body: { trade }, schema: tradeResponseSchema };
  }
  const tradeMatch = /^\/labour\/trades\/([^/]+)$/.exec(path);
  if (tradeMatch && method === "PATCH") {
    const input = parse(ctx, updateTradeRequestSchema, body);
    const trade = labour.trades.find((entry) => entry.id === tradeMatch[1]);
    if (!trade) ctx.fail(404, "not-found");
    if (trade!.version !== input.version) ctx.fail(409, "version-conflict");
    const { nameEn, nameSw, active, sortOrder } = input;
    Object.assign(
      trade!,
      Object.fromEntries(
        Object.entries({ nameEn, nameSw, active, sortOrder }).filter(([, v]) => v !== undefined),
      ),
      { version: trade!.version + 1 },
    );
    return { body: { trade }, schema: tradeResponseSchema };
  }
  if (path === "/labour/skill-levels" && method === "POST") {
    const input = parse(ctx, createSkillLevelRequestSchema, body);
    if (labour.skillLevels.some((entry) => entry.key === input.key))
      ctx.fail(409, "skill-level-key-taken");
    const skillLevel: SkillLevel = {
      id: id(),
      ...input,
      active: true,
      sortOrder: labour.skillLevels.length,
      version: 1,
    };
    labour.skillLevels.push(skillLevel);
    return { status: 201, body: { skillLevel }, schema: skillLevelResponseSchema };
  }
  const levelMatch = /^\/labour\/skill-levels\/([^/]+)$/.exec(path);
  if (levelMatch && method === "PATCH") {
    const input = parse(ctx, updateSkillLevelRequestSchema, body);
    const level = labour.skillLevels.find((entry) => entry.id === levelMatch[1]);
    if (!level) ctx.fail(404, "not-found");
    if (level!.version !== input.version) ctx.fail(409, "version-conflict");
    const { nameEn, nameSw, ncaCategory, accreditationExpected, active, sortOrder } = input;
    Object.assign(
      level!,
      Object.fromEntries(
        Object.entries({
          nameEn,
          nameSw,
          ncaCategory,
          accreditationExpected,
          active,
          sortOrder,
        }).filter(([, v]) => v !== undefined),
      ),
      { version: level!.version + 1 },
    );
    return { body: { skillLevel: level }, schema: skillLevelResponseSchema };
  }

  // Rates
  if (path === "/labour/rates" && method === "GET") {
    const projectId = query.get("projectId");
    const rows = labour.rates.filter(
      (rate) => rate.projectId === null || (projectId !== null && rate.projectId === projectId),
    );
    return {
      body: {
        rates: wireRates(rows, today),
        today,
        minimumWage: { status: "not_configured", reference: "CR-PAY-09" },
      },
      schema: labourRatesResponseSchema,
    };
  }
  if (path === "/labour/rates" && method === "POST") {
    const input = parse(ctx, createLabourRateRequestSchema, body);
    if (input.effectiveFrom < today) ctx.fail(400, "rate-backdated");
    const row: MockRate = {
      id: id(),
      projectId: input.projectId ?? null,
      labourerId: input.labourerId ?? null,
      tradeId: input.tradeId ?? null,
      skillLevelId: input.skillLevelId ?? null,
      basis: input.basis,
      rateMinor: input.rateMinor,
      currency: "KES",
      effectiveFrom: input.effectiveFrom,
      createdAt: new Date().toISOString(),
      createdBy: actor(ctx),
    };
    labour.rates.push(row);
    const [rate] = wireRates([row], today);
    return {
      status: 201,
      body: { rate, minimumWage: { status: "not_configured", reference: "CR-PAY-09" } },
      schema: labourRateResponseSchema,
    };
  }
  const rateMatch = /^\/labour\/rates\/([^/]+)$/.exec(path);
  if (rateMatch && method === "DELETE") {
    const index = labour.rates.findIndex((entry) => entry.id === rateMatch[1]);
    if (index < 0) ctx.fail(404, "not-found");
    if (labour.rates[index]!.effectiveFrom <= today) ctx.fail(409, "rate-in-force");
    labour.rates.splice(index, 1);
    return { body: { message: "Rate cancelled." }, schema: messageResponseSchema };
  }

  // Labourers
  if (path === "/labour/labourers" && method === "GET") {
    const filters = parse(ctx, labourerListQuerySchema, Object.fromEntries(query));
    const search = filters.search?.toLowerCase();
    const rows = labour.labourers
      .map((row) => ({ row, view: summary(labour, row) }))
      .filter(({ row, view }) => {
        if (filters.status && row.status !== filters.status) return false;
        if (filters.tradeId && row.tradeId !== filters.tradeId) return false;
        if (filters.skillLevelId && row.skillLevelId !== filters.skillLevelId) return false;
        if (
          filters.projectId &&
          !view.projects.some((entry) => entry.projectId === filters.projectId)
        )
          return false;
        if (filters.gangId && view.gang?.id !== filters.gangId) return false;
        if (filters.doNotRehire && !row.flag.flagged) return false;
        if (filters.consent === "withdrawn" && view.consent.status === "granted") return false;
        if (
          filters.consent === "outdated" &&
          !(view.consent.status === "granted" && !view.consent.current)
        )
          return false;
        if (filters.accreditation) {
          const state = view.accreditation.status;
          if (filters.accreditation === "attention" && state !== "expiring" && state !== "expired")
            return false;
          if (filters.accreditation !== "attention" && state !== filters.accreditation)
            return false;
        }
        if (search) {
          const digits = search.replace(/\D/g, "");
          const matches =
            row.fullName.toLowerCase().includes(search) ||
            row.workerNo.toLowerCase().includes(search) ||
            row.idNumber === search.toUpperCase() ||
            (digits.length >= 9 && row.phone?.endsWith(digits.slice(-9)));
          if (!matches) return false;
        }
        return true;
      })
      .map(({ view }) => view);
    return {
      body: {
        labourers: rows.slice(filters.offset, filters.offset + filters.limit),
        total: rows.length,
        today,
        alertDays: labour.settings.accreditationAlertDays,
        permissions: { canRegister: true, canFlag: true, canConfigure: true },
      },
      schema: labourersResponseSchema,
    };
  }
  if (path === "/labour/labourers" && method === "POST") {
    const input = parse(ctx, registerLabourerRequestSchema, body);
    if (input.projectId) project(input.projectId);
    if (!isOldEnoughToRegister(input.dateOfBirth, today)) ctx.fail(400, "under-minimum-age");
    if (input.consent.noticeVersion !== CURRENT_CONSENT_NOTICE.version)
      ctx.fail(400, "notice-not-current");
    const same = labour.labourers.find(
      (entry) => entry.idType === input.idType && entry.idNumber === input.idNumber,
    );
    if (same)
      ctx.fail(409, same.flag.flagged ? "do-not-rehire-match" : "duplicate-identity", {
        labourerId: same.id,
        workerNo: same.workerNo,
        matchedOn: "id",
      });
    const flagged = input.phone
      ? labour.labourers.find((entry) => entry.flag.flagged && entry.phone === input.phone)
      : undefined;
    if (flagged && !input.doNotRehireOverride)
      ctx.fail(409, "do-not-rehire-match", {
        labourerId: flagged.id,
        workerNo: flagged.workerNo,
        matchedOn: "phone",
      });
    const projectEntry = input.projectId ? project(input.projectId) : null;
    const now = new Date().toISOString();
    const row: MockLabourer = {
      id: id(),
      workerNo: `WRK-${String(labour.labourers.length + 1).padStart(4, "0")}`,
      fullName: input.fullName,
      status: "active",
      gender: input.gender,
      homeCounty: input.homeCounty ?? null,
      tradeId: input.tradeId,
      skillLevelId: input.skillLevelId,
      engagementType: input.engagementType,
      rateBasis: input.rateBasis,
      dateOfBirth: input.dateOfBirth,
      registeredOn: today,
      idType: input.idType,
      idNumber: input.idNumber,
      phone: input.phone ?? null,
      kraPin: input.kraPin ?? null,
      nssfNumber: input.nssfNumber ?? null,
      shaNumber: input.shaNumber ?? null,
      nextOfKin: input.nextOfKin
        ? { ...input.nextOfKin, phone: input.nextOfKin.phone ?? null }
        : null,
      flag: { flagged: false, setAt: null, reason: null },
      engagements: projectEntry
        ? [
            {
              id: id(),
              projectId: projectEntry.id,
              projectCode: projectEntry.code,
              projectName: projectEntry.name,
              startDate: input.engagementStartDate ?? today,
              endDate: null,
              endReason: null,
              open: true,
            },
          ]
        : [],
      cards: input.accreditation
        ? [
            {
              id: id(),
              ...input.accreditation,
              issuedOn: input.accreditation.issuedOn ?? null,
              version: 1,
            },
          ]
        : [],
      consents: [
        {
          ...consent(now, input.consent.language),
          method: input.consent.method,
          witnessName: input.consent.witnessName ?? null,
          capturedBy: actor(ctx),
        },
      ],
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    labour.labourers.push(row);
    const warnings: LabourerWarning[] = [];
    if (
      input.phone &&
      labour.labourers.some((entry) => entry !== row && entry.phone === input.phone)
    )
      warnings.push("phone-shared");
    const state = summary(labour, row).accreditation.status;
    if (state === "missing") warnings.push("accreditation-missing");
    if (flagged) warnings.push("do-not-rehire-overridden");
    return labourerReply(labour, ctx, row, warnings, 201);
  }
  const labourerMatch = /^\/labour\/labourers\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (labourerMatch) {
    const row = labourer(labourerMatch[1]!);
    const rest = labourerMatch[2] ?? "";
    if (rest === "" && method === "GET") return labourerReply(labour, ctx, row);
    if (rest === "" && method === "PATCH") {
      const input = parse(ctx, updateLabourerRequestSchema, body);
      bump(row, input.version, ctx);
      for (const key of [
        "fullName",
        "gender",
        "tradeId",
        "skillLevelId",
        "engagementType",
        "rateBasis",
      ] as const)
        if (input[key] !== undefined) Object.assign(row, { [key]: input[key] });
      if (input.phone !== undefined) row.phone = input.phone;
      return labourerReply(labour, ctx, row);
    }
    if (rest === "status" && method === "POST") {
      const input = parse(ctx, labourerStatusRequestSchema, body);
      if (input.to === row.status) ctx.fail(409, "invalid-status-change");
      if (input.to === "active" && row.flag.flagged && !input.doNotRehireOverride)
        ctx.fail(409, "do-not-rehire-match", {
          labourerId: row.id,
          workerNo: row.workerNo,
          matchedOn: "id",
        });
      bump(row, input.version, ctx);
      row.status = input.to;
      if (input.to === "left")
        for (const entry of row.engagements.filter((candidate) => candidate.open))
          Object.assign(entry, { endDate: today, open: false, endReason: input.reason ?? null });
      return labourerReply(labour, ctx, row);
    }
    if (rest === "reveal" && method === "POST") {
      const input = parse(ctx, revealRequestSchema, body);
      if (!ctx.stepUpFresh()) ctx.fail(403, "step-up-required");
      const value = {
        idNumber: row.idNumber,
        phone: row.phone ? `0${row.phone.slice(3)}` : null,
        kraPin: row.kraPin,
        nssfNumber: row.nssfNumber,
        shaNumber: row.shaNumber,
        nextOfKin: row.nextOfKin,
      }[input.field];
      return {
        body: { field: input.field, value, revealedAt: new Date().toISOString() },
        schema: revealResponseSchema,
      };
    }
    if (rest === "do-not-rehire" && method === "PUT") {
      const input = parse(ctx, doNotRehireRequestSchema, body);
      if (input.flagged === row.flag.flagged) ctx.fail(409, "do-not-rehire-unchanged");
      if (!ctx.stepUpFresh()) ctx.fail(403, "step-up-required");
      bump(row, input.version, ctx);
      row.flag = input.flagged
        ? { flagged: true, setAt: new Date().toISOString(), reason: input.reason }
        : { flagged: false, setAt: null, reason: null };
      return labourerReply(labour, ctx, row);
    }
    if (rest === "engagements" && method === "POST") {
      const input = parse(ctx, createEngagementRequestSchema, body);
      const entry = project(input.projectId);
      if (row.engagements.some((candidate) => candidate.open && candidate.projectId === entry.id))
        ctx.fail(409, "already-engaged");
      if (!row.consents.some((candidate) => candidate.granted && !candidate.withdrawnAt))
        ctx.fail(409, "consent-withdrawn");
      if (row.flag.flagged && !input.doNotRehireOverride)
        ctx.fail(409, "do-not-rehire-match", {
          labourerId: row.id,
          workerNo: row.workerNo,
          matchedOn: "id",
        });
      bump(row);
      row.status = "active";
      row.engagements.push({
        id: id(),
        projectId: entry.id,
        projectCode: entry.code,
        projectName: entry.name,
        startDate: input.startDate ?? today,
        endDate: null,
        endReason: null,
        open: true,
      });
      return labourerReply(labour, ctx, row, [], 201);
    }
    const endMatch = /^engagements\/([^/]+)\/end$/.exec(rest);
    if (endMatch && method === "POST") {
      const input = parse(ctx, endEngagementRequestSchema, body);
      const entry = row.engagements.find((candidate) => candidate.id === endMatch[1]);
      if (!entry) ctx.fail(404, "not-found");
      if (!entry!.open) ctx.fail(409, "engagement-ended");
      if (input.endDate < entry!.startDate) ctx.fail(400, "end-before-start");
      Object.assign(entry!, {
        endDate: input.endDate,
        endReason: input.reason || null,
        open: false,
      });
      bump(row);
      return labourerReply(labour, ctx, row);
    }
    if (rest === "accreditations" && method === "POST") {
      const input = parse(ctx, createAccreditationRequestSchema, body);
      row.cards.push({ id: id(), ...input, issuedOn: input.issuedOn ?? null, version: 1 });
      bump(row);
      return labourerReply(labour, ctx, row, [], 201);
    }
    const cardMatch = /^accreditations\/([^/]+)$/.exec(rest);
    if (cardMatch && method === "DELETE") {
      row.cards = row.cards.filter((entry) => entry.id !== cardMatch[1]);
      bump(row);
      return labourerReply(labour, ctx, row);
    }
    if (rest === "consents" && method === "POST") {
      const input = parse(ctx, recordConsentRequestSchema, body);
      const active = row.consents.find((entry) => entry.granted && !entry.withdrawnAt);
      if (active?.noticeVersion === input.noticeVersion) ctx.fail(409, "consent-current");
      row.consents.push({
        ...consent(new Date().toISOString(), input.language),
        noticeVersion: input.noticeVersion as ConsentNoticeVersion,
        method: input.method,
        witnessName: input.witnessName ?? null,
        capturedBy: actor(ctx),
      });
      bump(row);
      return labourerReply(labour, ctx, row, [], 201);
    }
    if (rest === "consents/withdraw" && method === "POST") {
      const input = parse(ctx, withdrawConsentRequestSchema, body);
      const active = row.consents.filter((entry) => entry.granted && !entry.withdrawnAt);
      if (!active.length) ctx.fail(409, "consent-not-active");
      for (const entry of active)
        Object.assign(entry, {
          withdrawnAt: new Date().toISOString(),
          withdrawnBy: actor(ctx),
          withdrawalMethod: input.method,
        });
      bump(row);
      return labourerReply(labour, ctx, row);
    }
  }

  if (path === "/labour/accreditation-alerts" && method === "GET") {
    const alerts = labour.labourers
      .filter((row) => row.status === "active")
      .flatMap((row) => {
        const view = summary(labour, row);
        const state = view.accreditation.status;
        if (state !== "expired" && state !== "expiring" && state !== "missing") return [];
        const latest = row.cards.find((entry) => entry.expiresOn === view.accreditation.expiresOn);
        return [
          {
            labourerId: row.id,
            workerNo: row.workerNo,
            fullName: row.fullName,
            kind: state,
            accreditationId: latest?.id ?? null,
            category: latest?.category ?? null,
            expiresOn: view.accreditation.expiresOn,
            daysLeft: view.accreditation.daysLeft,
          },
        ];
      });
    return {
      body: { alerts, alertDays: labour.settings.accreditationAlertDays, today },
      schema: accreditationAlertsResponseSchema,
    };
  }

  // Saved views (per user)
  if (path === "/labour/views" && method === "GET") {
    const builtIn: LabourView[] = [
      { id: "all", name: "All", builtIn: true, filters: {} },
      { id: "active", name: "Active", builtIn: true, filters: { status: "active" } },
      {
        id: "attention",
        name: "Expiring NCA",
        builtIn: true,
        filters: { status: "active", accreditation: "attention" },
      },
      { id: "doNotRehire", name: "Do not rehire", builtIn: true, filters: { doNotRehire: "true" } },
    ];
    return { body: { views: [...builtIn, ...labour.views] }, schema: labourViewsResponseSchema };
  }
  if (path === "/labour/views" && method === "POST") {
    const input = parse(ctx, createLabourViewRequestSchema, body);
    if (labour.views.some((view) => view.name === input.name)) ctx.fail(409, "view-name-taken");
    const view: LabourView = { id: id(), name: input.name, builtIn: false, filters: input.filters };
    labour.views.push(view);
    return { status: 201, body: { view }, schema: labourViewResponseSchema };
  }
  const viewMatch = /^\/labour\/views\/([^/]+)$/.exec(path);
  if (viewMatch && method === "DELETE") {
    labour.views = labour.views.filter((view) => view.id !== viewMatch[1]);
    return { body: { message: "View deleted." }, schema: messageResponseSchema };
  }

  // Gangs
  if (path === "/labour/gangs" && method === "GET")
    return {
      body: {
        gangs: labour.gangs.map((gang) => gangView(labour, ctx, gang)),
        manageableProjectIds: ctx.projects.map((entry) => entry.id),
      },
      schema: gangsResponseSchema,
    };
  if (path === "/labour/gangs" && method === "POST") {
    const input = parse(ctx, createGangRequestSchema, body);
    project(input.projectId);
    if (labour.gangs.some((gang) => gang.projectId === input.projectId && gang.name === input.name))
      ctx.fail(409, "gang-name-taken");
    const now = new Date().toISOString();
    const gang: MockGang = {
      id: id(),
      projectId: input.projectId,
      siteId: null,
      siteName: null,
      name: input.name,
      status: "active",
      leaderId: null,
      members: [],
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    labour.gangs.push(gang);
    return { status: 201, body: gangDetail(labour, ctx, gang), schema: gangDetailResponseSchema };
  }
  const gangMatch = /^\/labour\/gangs\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (gangMatch) {
    const gang = labour.gangs.find((entry) => entry.id === gangMatch[1]);
    if (!gang) ctx.fail(404, "not-found");
    const rest = gangMatch[2] ?? "";
    if (rest === "" && method === "GET")
      return { body: gangDetail(labour, ctx, gang!), schema: gangDetailResponseSchema };
    if (rest === "" && method === "PATCH") {
      const input = parse(ctx, updateGangRequestSchema, body);
      if (input.leaderLabourerId)
        if (
          !gang!.members.some((m) => m.labourerId === input.leaderLabourerId && m.leftOn === null)
        )
          ctx.fail(409, "leader-not-member");
      if (input.status === "archived" && gang!.members.some((member) => member.leftOn === null))
        ctx.fail(409, "gang-has-members");
      bump(gang!, input.version, ctx);
      if (input.name !== undefined) gang!.name = input.name;
      if (input.leaderLabourerId !== undefined) gang!.leaderId = input.leaderLabourerId;
      if (input.status !== undefined) gang!.status = input.status;
      if (input.siteId !== undefined) {
        gang!.siteId = input.siteId;
        gang!.siteName = input.siteId ? "Main plot" : null;
      }
      return { body: gangDetail(labour, ctx, gang!), schema: gangDetailResponseSchema };
    }
    if (rest === "members" && method === "POST") {
      const input = parse(ctx, addGangMemberRequestSchema, body);
      const row = labourer(input.labourerId);
      if (!row.engagements.some((entry) => entry.open && entry.projectId === gang!.projectId))
        ctx.fail(409, "not-engaged");
      const inGang = labour.gangs.some(
        (entry) =>
          entry.projectId === gang!.projectId &&
          entry.members.some((member) => member.labourerId === row.id && member.leftOn === null),
      );
      if (inGang) ctx.fail(409, "already-in-gang");
      gang!.members.push({
        membershipId: id(),
        labourerId: row.id,
        joinedOn: input.joinedOn ?? today,
        leftOn: null,
      });
      bump(gang!);
      return {
        status: 201,
        body: gangDetail(labour, ctx, gang!),
        schema: gangDetailResponseSchema,
      };
    }
    const leaveMatch = /^members\/([^/]+)\/leave$/.exec(rest);
    if (leaveMatch && method === "POST") {
      const input = parse(ctx, leaveGangRequestSchema, body);
      const member = gang!.members.find((entry) => entry.membershipId === leaveMatch[1]);
      if (!member) ctx.fail(404, "not-found");
      if (member!.leftOn) ctx.fail(409, "membership-ended");
      if (gang!.leaderId === member!.labourerId) ctx.fail(409, "leader-must-change");
      member!.leftOn = input.leftOn ?? today;
      bump(gang!);
      return { body: gangDetail(labour, ctx, gang!), schema: gangDetailResponseSchema };
    }
  }
  return ctx.fail(404, "not-found");
}
