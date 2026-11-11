import {
  addCalendarDays,
  nairobiDate,
  normaliseIdNumber,
  normalizeKenyanPhone,
} from "@pm-buddy/domain";
import {
  CURRENT_CONSENT_NOTICE,
  DEFAULT_SKILL_LEVELS,
  DEFAULT_TRADES,
  PROJECT_ASSIGNABLE_PERMISSIONS,
  SYSTEM_ROLE_PERMISSIONS,
  type County,
  type EngagementType,
  type Gender,
  type TenantSystemRole,
} from "@pm-buddy/types";
import type { Prisma } from "../generated/prisma/client.js";
import { LabourCrypto, uuidv7 } from "../modules/labour/labour-support.js";

/**
 * Labour part of the development seed (D3.1, brief §11): the standard trades and skill levels,
 * company day rates, 40 synthetic labourers on the two active demo projects with consent records,
 * gangs with leaders, NCA cards (some expiring or expired) and one do-not-rehire case.
 *
 * Every identity is synthetic: names are invented, national IDs use the unissued 9000xxxx block,
 * phones the 0700 000 0xx block and KRA PINs A9000000xxZ. Nothing is ever sent to these numbers
 * (development notifications go to Mailpit only). Idempotent: labourers are matched by worker
 * number, gangs by name, rates by trade.
 */

type Tx = Prisma.TransactionClient;
type Audit = (
  tx: Tx,
  action: string,
  resourceId: string,
  metadata?: Prisma.InputJsonValue,
) => Promise<unknown>;
const SOURCE = { source: "seed" } as const;
const calendar = (value: string) => new Date(`${value}T00:00:00.000Z`);

type DemoTrade = (typeof DEFAULT_TRADES)[number]["key"];
type DemoSkill = (typeof DEFAULT_SKILL_LEVELS)[number]["key"];

export type DemoLabourer = {
  fullName: string;
  gender: Gender;
  dateOfBirth: string;
  homeCounty: County;
  trade: DemoTrade;
  skill: DemoSkill;
  engagementType: EngagementType;
  /** Project codes the worker is engaged on (open engagements). */
  projects: string[];
  gang?: string;
  leads?: boolean;
  /** NCA card expiry, in days from the first seed run (negative = already expired). */
  ncaExpiresInDays?: number;
  consentLanguage: "en" | "sw";
  phone: boolean;
  kraPin: boolean;
  doNotRehire?: string;
};

/** Company day rates in KES (demo values; minimum-wage check: COMPLIANCE-REVIEW CR-PAY-09). */
export const DEMO_DAY_RATES_KES: Readonly<Record<DemoTrade, number>> = {
  mason: 1_500,
  carpenter: 1_500,
  steel_fixer: 1_500,
  plumber: 1_400,
  electrician: 1_700,
  painter: 1_200,
  tiler: 1_400,
  welder: 1_600,
  plasterer: 1_400,
  roofer: 1_300,
  machine_operator: 1_300,
  foreman: 2_000,
  general_labourer: 800,
  watchman: 800,
  storekeeper: 1_000,
};

export const DEMO_GANGS = [
  { project: "RUI-HTS", name: "Gang A: concrete and formwork", site: "Main plot" },
  { project: "RUI-HTS", name: "Gang B: masonry and plaster", site: "Main plot" },
  { project: "RUI-HTS", name: "Gang C: steel fixing", site: "Main plot" },
  { project: "RUI-HTS", name: "Gang D: services", site: "Main plot" },
  { project: "RUI-HTS", name: "Gang E: security and stores", site: "Materials yard" },
  { project: "KIT-BNG", name: "Gang K: bungalow crew", site: "Bungalow plot" },
] as const;
const gang = (letter: string) =>
  DEMO_GANGS.find((entry) => entry.name.startsWith(`Gang ${letter}:`))!.name;

const w = (
  fullName: string,
  gender: Gender,
  dateOfBirth: string,
  homeCounty: County,
  trade: DemoTrade,
  skill: DemoSkill,
  letter: string | null,
  extra: Partial<DemoLabourer> = {},
): DemoLabourer => ({
  fullName,
  gender,
  dateOfBirth,
  homeCounty,
  trade,
  skill,
  engagementType: "casual",
  projects: [letter === "K" ? "KIT-BNG" : "RUI-HTS"],
  ...(letter ? { gang: gang(letter) } : {}),
  consentLanguage: "sw",
  phone: true,
  kraPin: skill === "skilled" || skill === "site_supervisor",
  ...extra,
});

export const DEMO_LABOURERS: readonly DemoLabourer[] = [
  w("Peter Njoroge Kamau", "male", "1979-04-12", "kiambu", "foreman", "site_supervisor", "A", {
    leads: true,
    engagementType: "term",
    ncaExpiresInDays: 290,
    consentLanguage: "en",
  }),
  w("Patrick Wekesa Simiyu", "male", "1983-09-03", "bungoma", "foreman", "site_supervisor", "B", {
    leads: true,
    engagementType: "term",
    ncaExpiresInDays: 125,
  }),
  w("Samuel Kariuki Mwangi", "male", "1988-01-21", "muranga", "mason", "skilled", "B", {
    ncaExpiresInDays: 230,
  }),
  w("John Otieno Ouma", "male", "1991-06-30", "siaya", "mason", "skilled", "B", {
    ncaExpiresInDays: 17,
  }),
  w("Wycliffe Wekesa Barasa", "male", "1993-02-14", "kakamega", "mason", "skilled", "B", {
    ncaExpiresInDays: 305,
  }),
  w("Stephen Kiprono Rotich", "male", "1986-11-08", "uasin-gishu", "mason", "skilled", "B", {
    ncaExpiresInDays: -6,
  }),
  w("Moses Muli Kioko", "male", "1997-08-19", "machakos", "mason", "semi_skilled", "B"),
  w("George Nyakundi Ongeri", "male", "1990-03-27", "kisii", "mason", "skilled", "B", {
    ncaExpiresInDays: 410,
    consentLanguage: "en",
  }),
  w("Charles Odhiambo Okoth", "male", "1984-12-02", "kisumu", "steel_fixer", "skilled", "C", {
    leads: true,
    ncaExpiresInDays: 180,
  }),
  w("Joseph Mutua Musyoka", "male", "1995-05-15", "makueni", "steel_fixer", "semi_skilled", "C"),
  w("Daniel Kipkemboi Kosgei", "male", "1992-07-07", "nandi", "steel_fixer", "skilled", "C", {
    ncaExpiresInDays: 26,
  }),
  w("Abdi Hassan Mohamed", "male", "1989-10-10", "garissa", "welder", "skilled", "C", {
    ncaExpiresInDays: 66,
  }),
  w("Kevin Waweru Ndungu", "male", "1987-01-29", "nyeri", "electrician", "skilled", "D", {
    leads: true,
    ncaExpiresInDays: 200,
    consentLanguage: "en",
  }),
  w("Brian Kinoti Murithi", "male", "1994-04-04", "meru", "electrician", "skilled", "D", {
    ncaExpiresInDays: 197,
  }),
  w("Dennis Ochieng Owiti", "male", "1990-09-09", "kisumu", "electrician", "skilled", "D", {
    ncaExpiresInDays: -40,
  }),
  w("Collins Masinde Shikuku", "male", "1996-12-12", "vihiga", "plumber", "semi_skilled", "D"),
  w("Faith Wanjiru Mwangi", "female", "1998-02-02", "nakuru", "plumber", "semi_skilled", "D"),
  w("Sankale Lemayian", "male", "1985-06-16", "kajiado", "plasterer", "skilled", "B", {
    ncaExpiresInDays: 215,
  }),
  w("Mercy Akinyi Onyango", "female", "1999-03-03", "siaya", "plasterer", "semi_skilled", "B"),
  w("Grace Nduta Kimani", "female", "1997-11-11", "nyandarua", "tiler", "semi_skilled", "B"),
  w("Simon Kahindi Baya", "male", "1993-08-08", "kwale", "machine_operator", "semi_skilled", "A"),
  w("James Kamau Githinji", "male", "1991-05-05", "kiambu", "carpenter", "skilled", "A", {
    ncaExpiresInDays: 150,
  }),
  w("Elijah Kiplagat Too", "male", "1989-07-17", "elgeyo-marakwet", "carpenter", "skilled", "A", {
    ncaExpiresInDays: 9,
  }),
  w(
    "Beatrice Nafula Wekesa",
    "female",
    "2000-01-15",
    "busia",
    "general_labourer",
    "unskilled",
    "A",
  ),
  w("Kelvin Mutiso Muli", "male", "2001-06-21", "machakos", "general_labourer", "unskilled", "A"),
  w("Dancan Kibet Rono", "male", "1999-09-30", "bomet", "general_labourer", "unskilled", "A"),
  w("Victor Kazungu Charo", "male", "2002-04-18", "kilifi", "general_labourer", "unskilled", "A"),
  w("Felix Okoth Owuor", "male", "1998-10-25", "kisumu", "general_labourer", "unskilled", "C"),
  w("Lucy Moraa Kerubo", "female", "2003-02-11", "nyamira", "general_labourer", "unskilled", "B", {
    phone: false,
  }),
  w("Esther Wanjiku Njeri", "female", "2001-12-24", "kiambu", "general_labourer", "unskilled", "B"),
  w("Naomi Gatwiri Kirimi", "female", "2000-08-08", "meru", "general_labourer", "unskilled", "D"),
  w("Hassan Abdi Noor", "male", "1981-03-14", "wajir", "watchman", "unskilled", "E", {
    leads: true,
    engagementType: "term",
  }),
  w("Lekishon Mpaka", "male", "1987-07-01", "narok", "watchman", "unskilled", "E"),
  w(
    "Agnes Chepkoech Langat",
    "female",
    "1992-12-05",
    "kericho",
    "storekeeper",
    "semi_skilled",
    "E",
    {
      engagementType: "term",
      consentLanguage: "en",
    },
  ),
  w("Tom Barasa Wafula", "male", "1985-02-20", "trans-nzoia", "foreman", "site_supervisor", "K", {
    leads: true,
    engagementType: "term",
    ncaExpiresInDays: 85,
    consentLanguage: "en",
  }),
  w("Ruth Nyokabi Mwangi", "female", "1994-07-12", "kajiado", "mason", "skilled", "K", {
    ncaExpiresInDays: 240,
  }),
  w("Paul Saitoti Ole Nkoitoi", "male", "1990-11-30", "kajiado", "mason", "semi_skilled", "K"),
  w(
    "Rose Naserian Lemayian",
    "female",
    "2002-05-09",
    "kajiado",
    "general_labourer",
    "unskilled",
    "K",
  ),
  w("Isaac Mwendwa Nzioka", "male", "1996-03-17", "machakos", "roofer", "semi_skilled", "K"),
  w("Oscar Mutai Kirui", "male", "1988-08-28", "bomet", "painter", "semi_skilled", null, {
    projects: [],
    doNotRehire: "Left site twice without notice during a concrete pour (synthetic demo case)",
  }),
];

/** Synthetic identifiers for the n-th demo labourer (1-based). */
export function demoIdentifiers(n: number) {
  const suffix = String(n).padStart(2, "0");
  return {
    workerNo: `WRK-${String(n).padStart(4, "0")}`,
    idNumber: normaliseIdNumber("national_id", `900000${suffix}`)!,
    phone: normalizeKenyanPhone(`07000000${suffix}`)!,
    kraPin: `A9000000${suffix}Z`,
  };
}

type Projects = ReadonlyMap<string, { id: string; sites: ReadonlyMap<string, string> }>;

export type LabourSeedSummary = {
  trades: number;
  labourersCreated: number;
  labourersTotal: number;
  gangs: number;
  rates: number;
};

export async function seedLabour(
  tx: Tx,
  crypto: LabourCrypto,
  tenantId: string,
  ownerId: string,
  projects: Projects,
  team: readonly { id: string; role: TenantSystemRole; projectCodes: readonly string[] }[],
  audit: Audit,
): Promise<LabourSeedSummary> {
  const today = nairobiDate();

  // Project assignments carry the labour permissions added in D3.1 (role ∩ assignment).
  for (const member of team)
    for (const code of member.projectCodes) {
      const project = projects.get(code);
      if (!project) continue;
      const assignment = await tx.projectMembership.findUnique({
        where: {
          tenantId_projectId_userId: { tenantId, projectId: project.id, userId: member.id },
        },
      });
      const wanted = PROJECT_ASSIGNABLE_PERMISSIONS.filter((permission) =>
        SYSTEM_ROLE_PERMISSIONS[member.role].includes(permission),
      );
      if (assignment && wanted.some((permission) => !assignment.permissions.includes(permission)))
        await tx.projectMembership.update({
          where: {
            tenantId_projectId_userId: { tenantId, projectId: project.id, userId: member.id },
          },
          data: { permissions: [...new Set([...assignment.permissions, ...wanted])] },
        });
    }

  const trades = new Map<string, string>();
  for (const [index, entry] of DEFAULT_TRADES.entries()) {
    const existing = await tx.trade.findUnique({
      where: { tenantId_key: { tenantId, key: entry.key } },
    });
    const row =
      existing ??
      (await tx.trade.create({
        data: {
          tenantId,
          key: entry.key,
          nameEn: entry.nameEn,
          nameSw: entry.nameSw,
          sortOrder: index * 10,
          createdBy: ownerId,
        },
      }));
    trades.set(entry.key, row.id);
  }
  const levels = new Map<string, string>();
  for (const [index, entry] of DEFAULT_SKILL_LEVELS.entries()) {
    const existing = await tx.skillLevel.findUnique({
      where: { tenantId_key: { tenantId, key: entry.key } },
    });
    const row =
      existing ??
      (await tx.skillLevel.create({
        data: {
          tenantId,
          key: entry.key,
          nameEn: entry.nameEn,
          nameSw: entry.nameSw,
          ncaCategory: entry.ncaCategory,
          accreditationExpected: entry.accreditationExpected,
          sortOrder: index * 10,
          createdBy: ownerId,
        },
      }));
    levels.set(entry.key, row.id);
  }

  // Company day rates (first run: effective today; rates are never backdated or overwritten).
  let rates = 0;
  for (const [key, kes] of Object.entries(DEMO_DAY_RATES_KES)) {
    const tradeId = trades.get(key)!;
    const existing = await tx.labourRate.findFirst({
      where: { tenantId, tradeId, projectId: null, labourerId: null, basis: "daily" },
    });
    if (existing) continue;
    const rate = await tx.labourRate.create({
      data: {
        tenantId,
        tradeId,
        basis: "daily",
        rateMinor: BigInt(kes * 100),
        effectiveFrom: calendar(today),
        createdBy: ownerId,
      },
    });
    rates += 1;
    await audit(tx, "labour.rate_created", rate.id, {
      ...SOURCE,
      tradeId,
      basis: "daily",
      effectiveFrom: today,
    });
  }
  const ruiru = projects.get("RUI-HTS");
  if (ruiru) {
    const masonSkilled = await tx.labourRate.findFirst({
      where: { tenantId, projectId: ruiru.id, tradeId: trades.get("mason"), labourerId: null },
    });
    if (!masonSkilled) {
      const rate = await tx.labourRate.create({
        data: {
          tenantId,
          projectId: ruiru.id,
          tradeId: trades.get("mason")!,
          skillLevelId: levels.get("skilled")!,
          basis: "daily",
          rateMinor: 160_000n,
          effectiveFrom: calendar(today),
          createdBy: ownerId,
        },
      });
      rates += 1;
      await audit(tx, "labour.rate_created", rate.id, {
        ...SOURCE,
        projectId: ruiru.id,
        basis: "daily",
        effectiveFrom: today,
      });
    }
  }

  const gangs = new Map<string, { id: string; projectId: string }>();
  for (const demo of DEMO_GANGS) {
    const project = projects.get(demo.project);
    if (!project) continue;
    const existing = await tx.gang.findUnique({
      where: { tenantId_projectId_name: { tenantId, projectId: project.id, name: demo.name } },
    });
    const row =
      existing ??
      (await tx.gang.create({
        data: {
          tenantId,
          projectId: project.id,
          siteId: project.sites.get(demo.site) ?? null,
          name: demo.name,
          createdBy: ownerId,
        },
      }));
    if (!existing) await audit(tx, "gang.created", row.id, { ...SOURCE, projectId: project.id });
    gangs.set(demo.name, { id: row.id, projectId: project.id });
  }

  let created = 0;
  for (const [index, demo] of DEMO_LABOURERS.entries()) {
    const ids = demoIdentifiers(index + 1);
    const existing = await tx.labourer.findUnique({
      where: { tenantId_workerNo: { tenantId, workerNo: ids.workerNo } },
      select: { id: true },
    });
    if (existing) continue;
    created += 1;
    const id = uuidv7();
    // Engagements started some weeks ago; the first-run date is the reference for NCA expiries.
    const startDate = addCalendarDays(today, -(21 + (index % 9) * 7));
    await tx.labourer.create({
      data: {
        id,
        tenantId,
        workerNo: ids.workerNo,
        fullName: demo.fullName,
        dateOfBirth: calendar(demo.dateOfBirth),
        registeredOn: calendar(today),
        gender: demo.gender,
        homeCounty: demo.homeCounty,
        tradeId: trades.get(demo.trade)!,
        skillLevelId: levels.get(demo.skill)!,
        engagementType: demo.engagementType,
        rateBasis: "daily",
        idType: "national_id",
        idNumberEnc: crypto.seal(tenantId, id, "id_number_enc", ids.idNumber),
        idNumberBidx: crypto.idIndex(tenantId, "national_id", ids.idNumber),
        ...(demo.phone
          ? {
              phoneEnc: crypto.seal(tenantId, id, "phone_enc", ids.phone),
              phoneBidx: crypto.index(tenantId, "phone", ids.phone),
            }
          : {}),
        ...(demo.kraPin
          ? {
              kraPinEnc: crypto.seal(tenantId, id, "kra_pin_enc", ids.kraPin),
              kraPinBidx: crypto.index(tenantId, "kra_pin", ids.kraPin),
            }
          : {}),
        createdBy: ownerId,
      },
    });
    await tx.labourerConsent.create({
      data: {
        tenantId,
        labourerId: id,
        kind: "registration_data",
        noticeVersion: CURRENT_CONSENT_NOTICE.version,
        noticeDigest: CURRENT_CONSENT_NOTICE.digests[demo.consentLanguage],
        language: demo.consentLanguage,
        method: demo.consentLanguage === "sw" ? "witnessed_verbal" : "signed",
        witnessName: demo.consentLanguage === "sw" ? "Kevin Kiprono (site agent)" : null,
        granted: true,
        capturedBy: ownerId,
      },
    });
    for (const code of demo.doNotRehire ? ["RUI-HTS"] : demo.projects) {
      const project = projects.get(code);
      if (!project) continue;
      await tx.labourEngagement.create({
        data: {
          tenantId,
          labourerId: id,
          projectId: project.id,
          startDate: calendar(startDate),
          createdBy: ownerId,
        },
      });
    }
    if (demo.ncaExpiresInDays !== undefined)
      await tx.labourerAccreditation.create({
        data: {
          tenantId,
          labourerId: id,
          category: demo.skill === "site_supervisor" ? "nca_site_supervisor" : "nca_skilled_worker",
          cardNumber: `NCA-DEMO-${String(index + 1).padStart(4, "0")}`,
          issuedOn: calendar(addCalendarDays(today, demo.ncaExpiresInDays - 365)),
          expiresOn: calendar(addCalendarDays(today, demo.ncaExpiresInDays)),
          createdBy: ownerId,
        },
      });
    await audit(tx, "labourer.registered", id, {
      ...SOURCE,
      workerNo: ids.workerNo,
      consent: { noticeVersion: CURRENT_CONSENT_NOTICE.version, language: demo.consentLanguage },
    });
    const membership = demo.gang ? gangs.get(demo.gang) : undefined;
    if (membership) {
      await tx.gangMembership.create({
        data: {
          tenantId,
          projectId: membership.projectId,
          gangId: membership.id,
          labourerId: id,
          joinedOn: calendar(startDate),
          addedBy: ownerId,
        },
      });
      if (demo.leads)
        await tx.gang.update({
          where: { tenantId_id: { tenantId, id: membership.id } },
          data: { leaderLabourerId: id, version: { increment: 1 } },
        });
    }
    if (demo.doNotRehire) {
      // The worker left; a manager then flagged them do not rehire with an encrypted reason.
      const engagement = await tx.labourEngagement.findFirst({
        where: { tenantId, labourerId: id },
      });
      if (engagement)
        await tx.labourEngagement.update({
          where: { id: engagement.id },
          data: {
            endDate: calendar(addCalendarDays(today, -7)),
            endReason: "Left without notice",
            endedBy: ownerId,
            endedAt: new Date(),
          },
        });
      const eventId = uuidv7();
      await tx.doNotRehireEvent.create({
        data: {
          id: eventId,
          tenantId,
          labourerId: id,
          action: "set",
          reasonEnc: crypto.sealReason(tenantId, eventId, demo.doNotRehire),
          actorId: ownerId,
        },
      });
      await tx.labourer.update({
        where: { tenantId_id: { tenantId, id } },
        data: {
          status: "left",
          doNotRehire: true,
          doNotRehireAt: new Date(),
          doNotRehireBy: ownerId,
          version: { increment: 1 },
        },
      });
      await audit(tx, "labourer.do_not_rehire_set", id, { ...SOURCE, reasonGiven: true });
    }
  }

  return {
    trades: trades.size,
    labourersCreated: created,
    labourersTotal: await tx.labourer.count({ where: { tenantId } }),
    gangs: gangs.size,
    rates,
  };
}
