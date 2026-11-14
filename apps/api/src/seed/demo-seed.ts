import { randomBytes, randomUUID } from "node:crypto";
import type { INestApplicationContext } from "@nestjs/common";
import { Secret, TOTP } from "otpauth";
import {
  buildupRate,
  geofenceMetrics,
  normaliseGeofence,
  validateGeofence,
  type BuildupLineInput,
  type Geofence,
} from "@pm-buddy/domain";
import {
  BUILDUP_ROUNDING,
  PROJECT_ASSIGNABLE_PERMISSIONS,
  SYSTEM_ROLE_PERMISSIONS,
  type ContractType,
  type County,
  type MilestoneStatus,
  type TenantSystemRole,
} from "@pm-buddy/types";
import { AppConfig } from "../config/app-config.js";
import type { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../infra/prisma.service.js";
import { AuthSecurity, hashPassword } from "../modules/identity/auth-security.service.js";
import { TenantDatabase } from "../modules/identity/tenant-database.service.js";
import { seedProcurement, type ProcurementSeedSummary } from "./demo-procurement.js";
import { LabourCrypto } from "../modules/labour/labour-support.js";
import { seedAttendance, type AttendanceSeedSummary } from "./attendance-seed.js";
import { seedLabour, type LabourSeedSummary } from "./labour-seed.js";
import { seedPayroll, type PayrollSeedSummary } from "./payroll-seed.js";
import { seedProcureToPay, type ProcureToPaySeedSummary } from "./demo-procure-to-pay.js";
import { seedStores, type StoresSeedSummary } from "./demo-stores.js";
import { seedQuality, type QualitySeedSummary } from "./quality-seed.js";
import { seedSafety, type SafetySeedSummary } from "./safety-seed.js";
import { seedSchedule, type ScheduleSeedSummary } from "./schedule-seed.js";
import { seedSpending, type SpendingSeedSummary } from "./demo-spending.js";

/**
 * Development seed (brief §11): a synthetic demo company matching the prototype, with an owner
 * (password + TOTP), a project manager, a site agent and a finance user (TOTP), three projects with
 * Kenyan sites, geofences, WBS and milestones, (D3.1) the labour registry: trades, rates, 40
 * synthetic labourers with consent, gangs and NCA cards (labour-seed.ts), (D3.3) nine weeks of
 * synthetic attendance with timesheet periods, anomalies and an adjustment (attendance-seed.ts),
 * and (D5.1) the starter catalogue with synthetic suppliers, prices and payout details
 * (demo-procurement.ts), and (D6.2) the RUI-HTS schedule with a baseline, slipped actuals and
 * delays (schedule-seed.ts), and (D5.4) an approved RUI-HTS budget, cost codes, a petty-cash float
 * with expenses, a count, a journal and forecast lines (demo-spending.ts). Idempotent: existing records are kept as they are. Never runs in
 * production. All identities are synthetic (example.test addresses; the only phone number is in
 * Ofcom's 07700 900xxx range reserved for fiction).
 */

export const DEMO_COMPANY = "Jenga Bora Builders Ltd";
const SOURCE = { source: "seed" } as const;

type Tx = Prisma.TransactionClient;
type Audit = (
  tx: Tx,
  action: string,
  resourceId: string,
  metadata?: Prisma.InputJsonValue,
) => Promise<unknown>;

type DemoAccount = {
  key: "owner" | "projectManager" | "siteAgent" | "finance" | "storekeeper";
  role: TenantSystemRole;
  identifier: string;
  displayName: string;
  totp: boolean;
};
export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  {
    key: "owner",
    role: "owner",
    identifier: "owner@jenga-bora.example.test",
    displayName: "Wanjiru Kamau",
    totp: true,
  },
  {
    key: "projectManager",
    role: "project_manager",
    identifier: "pm@jenga-bora.example.test",
    displayName: "Brian Otieno",
    totp: false,
  },
  {
    key: "siteAgent",
    role: "site_agent",
    identifier: "site.agent@jenga-bora.example.test",
    displayName: "Kevin Kiprono",
    totp: false,
  },
  {
    // D5.1: verifies supplier payout details proposed by the owner (maker-checker).
    key: "finance",
    role: "finance",
    identifier: "finance@jenga-bora.example.test",
    displayName: "Daniel Mwangi",
    totp: true,
  },
  {
    // D5.3: keeps the site stores (issues, returns, wastage, transfers, counts).
    key: "storekeeper",
    role: "storekeeper",
    identifier: "storekeeper@jenga-bora.example.test",
    displayName: "Grace Wambui",
    totp: false,
  },
];

type DemoSite = { name: string; address: string; geofence: Geofence };
type DemoWbs = { code: string; name: string; weight: number; children?: DemoWbs[] };
type DemoMilestone = {
  name: string;
  dueDate: string;
  wbs?: string;
  status?: MilestoneStatus;
  actualDate?: string;
};
type DemoProject = {
  code: string;
  name: string;
  description: string;
  clientName: string;
  clientEmail: string | null;
  clientPhone: string | null;
  /** KES minor units; null while a tender is open. */
  contractSumMinor: number | null;
  contractType: ContractType;
  startDate: string;
  endDate: string;
  county: County;
  town: string;
  latitude: number | null;
  longitude: number | null;
  activate: boolean;
  /** D6.1: practically complete (active → completed); quality-seed.ts certifies completion. */
  complete?: boolean;
  sites: DemoSite[];
  wbs: DemoWbs[];
  milestones: DemoMilestone[];
  team: DemoAccount["key"][];
};

export const DEMO_PROJECTS: readonly DemoProject[] = [
  {
    code: "RUI-HTS",
    name: "Ruiru Heights Apartments",
    description: "4-storey apartment block, 16 units",
    clientName: "Mavuno Homes Ltd",
    clientEmail: "projects@mavuno-homes.example.test",
    clientPhone: null,
    contractSumMinor: 8_640_000_000,
    contractType: "lump_sum",
    startDate: "2026-03-02",
    endDate: "2027-04-30",
    county: "kiambu",
    town: "Ruiru",
    latitude: -1.1489,
    longitude: 36.9612,
    activate: true,
    sites: [
      {
        name: "Main plot",
        address: "Off Kamiti Road, near the Ruiru Kimbo stage",
        geofence: {
          kind: "polygon",
          vertices: [
            { lat: -1.1487, lng: 36.96093 },
            { lat: -1.1487, lng: 36.96147 },
            { lat: -1.14888, lng: 36.96156 },
            { lat: -1.149105, lng: 36.96147 },
            { lat: -1.149105, lng: 36.96093 },
          ],
        },
      },
      {
        name: "Materials yard",
        address: "Fenced yard behind the main plot",
        geofence: { kind: "radius", center: { lat: -1.1494, lng: 36.9612 }, radiusM: 40 },
      },
    ],
    wbs: [
      { code: "1", name: "Preliminaries", weight: 1_000 },
      { code: "2", name: "Substructure", weight: 2_000 },
      {
        code: "3",
        name: "Superstructure",
        weight: 4_500,
        children: [
          { code: "3.1", name: "Ground floor", weight: 2_500 },
          { code: "3.2", name: "First floor", weight: 2_500 },
          { code: "3.3", name: "Second floor", weight: 2_500 },
          { code: "3.4", name: "Third floor and roof", weight: 2_500 },
        ],
      },
      { code: "4", name: "Finishes", weight: 1_500 },
      { code: "5", name: "Services", weight: 1_000 },
    ],
    milestones: [
      {
        name: "Substructure complete",
        dueDate: "2026-06-15",
        wbs: "2",
        status: "achieved",
        actualDate: "2026-06-26",
      },
      {
        name: "First floor slab cast",
        dueDate: "2026-08-31",
        wbs: "3.2",
        status: "achieved",
        actualDate: "2026-09-18",
      },
      { name: "Roof beam cast", dueDate: "2026-11-30", wbs: "3.4", status: "in_progress" },
      { name: "Roof covered", dueDate: "2027-01-31", wbs: "3.4" },
      { name: "Practical completion", dueDate: "2027-04-30" },
    ],
    team: ["projectManager", "siteAgent", "storekeeper"],
  },
  {
    code: "KIT-BNG",
    name: "Kitengela Bungalow",
    description: "3-bedroom bungalow for a diaspora client",
    clientName: "Dr. Grace Wambui (London, UK)",
    clientEmail: "grace.wambui@example.test",
    clientPhone: "+447700900123",
    contractSumMinor: 984_640_000,
    contractType: "lump_sum",
    startDate: "2026-05-12",
    endDate: "2027-02-15",
    county: "kajiado",
    town: "Kitengela",
    latitude: -1.4772,
    longitude: 36.9589,
    activate: true,
    sites: [
      {
        name: "Bungalow plot",
        address: "Kitengela, off Namanga Road",
        geofence: { kind: "radius", center: { lat: -1.4772, lng: 36.9589 }, radiusM: 60 },
      },
    ],
    wbs: [
      { code: "1", name: "Foundation", weight: 2_500 },
      { code: "2", name: "Walling to ring beam", weight: 3_000 },
      { code: "3", name: "Roofing", weight: 2_000 },
      { code: "4", name: "Finishes and handover", weight: 2_500 },
    ],
    milestones: [
      {
        name: "Foundation complete",
        dueDate: "2026-07-10",
        wbs: "1",
        status: "achieved",
        actualDate: "2026-07-08",
      },
      { name: "Ring beam cast", dueDate: "2026-10-05", wbs: "2", status: "in_progress" },
      { name: "Plastering complete", dueDate: "2026-12-15", wbs: "4" },
      { name: "Handover", dueDate: "2027-02-15" },
    ],
    team: ["projectManager", "storekeeper"],
  },
  {
    code: "SYO-TWN",
    name: "Syokimau Townhouses",
    description: "Tender stage: 8 townhouses, awaiting the signed contract and site survey",
    clientName: "Kilima Developers Ltd",
    clientEmail: null,
    clientPhone: null,
    contractSumMinor: null,
    contractType: "design_and_build",
    startDate: "2027-01-11",
    endDate: "2028-03-31",
    county: "machakos",
    town: "Syokimau",
    latitude: null,
    longitude: null,
    activate: false,
    sites: [],
    wbs: [],
    milestones: [],
    team: [],
  },
  {
    // D6.1: handed over; practical completion certified and the defects liability period running
    // (quality-seed.ts, dates relative to the seed day).
    code: "JUJ-DPX",
    name: "Juja Road Duplex",
    description: "Two-storey 4-bedroom duplex, handed over; defects liability period running",
    clientName: "Wairimu Family Trust (synthetic)",
    clientEmail: "wairimu.trust@example.test",
    clientPhone: null,
    contractSumMinor: 2_150_000_000,
    contractType: "lump_sum",
    startDate: "2025-10-06",
    endDate: "2026-08-31",
    county: "kiambu",
    town: "Juja",
    latitude: -1.1012,
    longitude: 37.0144,
    activate: true,
    complete: true,
    sites: [
      {
        name: "Duplex plot",
        address: "Off Juja Farm Road",
        geofence: { kind: "radius", center: { lat: -1.1012, lng: 37.0144 }, radiusM: 45 },
      },
    ],
    wbs: [
      { code: "1", name: "Substructure", weight: 2_000 },
      { code: "2", name: "Superstructure and roof", weight: 4_500 },
      { code: "3", name: "Finishes and services", weight: 3_500 },
    ],
    milestones: [
      {
        name: "Roof covered",
        dueDate: "2026-04-30",
        wbs: "2",
        status: "achieved",
        actualDate: "2026-05-08",
      },
      { name: "Handover", dueDate: "2026-08-31", status: "achieved", actualDate: "2026-08-28" },
    ],
    team: ["projectManager", "siteAgent"],
  },
];

/**
 * A worked rate build-up example for the library (D2.3). SYNTHETIC values, not market prices:
 * concrete class 25 (1:2:4) per m³, with cement in 50 kg bags and sand and ballast in tonnes
 * (never lorry trips, which are not a universal mass or volume; brief §15 G).
 */
export const DEMO_BUILDUP = {
  code: "CONC-C25-SYN",
  name: "Concrete class 25 (1:2:4), per m³ (synthetic example)",
  unit: "m3",
  assumptions:
    "SYNTHETIC EXAMPLE VALUES, not market prices. Cement in 50 kg bags; sand and ballast in tonnes (convert lorry loads only with a measured, documented conversion). Waste allowances are illustrative.",
  lines: [
    {
      kind: "material",
      resourceName: "Cement, 50 kg bag",
      unit: "bag (50 kg)",
      quantity: "6.5",
      wastePercent: "5",
      unitCostMinor: 85_000,
    },
    {
      kind: "material",
      resourceName: "River sand",
      unit: "t",
      quantity: "0.7",
      wastePercent: "10",
      unitCostMinor: 250_000,
    },
    {
      kind: "material",
      resourceName: "Ballast 20 mm",
      unit: "t",
      quantity: "1.4",
      wastePercent: "5",
      unitCostMinor: 220_000,
    },
    {
      kind: "labour",
      resourceName: "Mason and two helpers",
      unit: "hr",
      quantity: "4.5",
      wastePercent: null,
      unitCostMinor: 35_000,
    },
    {
      kind: "plant",
      resourceName: "Concrete mixer (0.5 m³)",
      unit: "hr",
      quantity: "0.5",
      wastePercent: null,
      unitCostMinor: 150_000,
    },
  ] satisfies BuildupLineInput[],
} as const;

export type SeededAccount = {
  role: TenantSystemRole;
  identifier: string;
  displayName: string;
  /** Set when this run created the account or reset its credentials; otherwise unchanged. */
  password: string | null;
  totp: { secret: string; uri: string } | null;
  created: boolean;
};
export type SeedSummary = {
  company: { id: string; name: string; created: boolean };
  accounts: SeededAccount[];
  projects: { code: string; name: string; status: string; created: boolean }[];
  buildups: { code: string; name: string; rateMinor: number | null; created: boolean }[];
  procurement: ProcurementSeedSummary;
  labour: LabourSeedSummary;
  attendance: AttendanceSeedSummary;
  payroll: PayrollSeedSummary;
  procureToPay: ProcureToPaySeedSummary;
  stores: StoresSeedSummary;
  schedule: ScheduleSeedSummary;
  spending: SpendingSeedSummary;
  quality: QualitySeedSummary;
  safety: SafetySeedSummary;
};

/** Refuses production: demo accounts and data must never reach a live environment. */
export function assertSeedAllowed(nodeEnv: string | undefined): void {
  if (nodeEnv === "production")
    throw new Error("Refusing to seed demo data: NODE_ENV is production.");
}

/** A random password (144 bits of entropy), printed once for local use. */
const newPassword = () => `Demo-${randomBytes(18).toString("base64url")}`;
const calendar = (value: string) => new Date(`${value}T00:00:00.000Z`);

export async function seedDemo(
  app: INestApplicationContext,
  options: { resetCredentials?: boolean } = {},
): Promise<SeedSummary> {
  assertSeedAllowed(process.env["NODE_ENV"]);
  assertSeedAllowed(app.get(AppConfig).get("NODE_ENV"));
  const prisma = app.get(PrismaService);
  const security = app.get(AuthSecurity);
  const db = app.get(TenantDatabase);

  const accounts: (SeededAccount & { id: string; key: DemoAccount["key"] })[] = [];
  for (const demo of DEMO_ACCOUNTS) {
    const existing = await prisma.user.findUnique({ where: { identifier: demo.identifier } });
    const reset = !existing || options.resetCredentials === true;
    const password = reset ? newPassword() : null;
    const user =
      existing ??
      (await prisma.user.create({
        data: {
          id: randomUUID(),
          identifier: demo.identifier,
          displayName: demo.displayName,
          passwordHash: await hashPassword(password!),
          verifiedAt: new Date(),
        },
      }));
    if (existing && password) {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          passwordHash: await hashPassword(password),
          failedLogins: 0,
          lockedUntil: null,
          mfaFailedAttempts: 0,
          mfaLockedUntil: null,
        },
      });
      await prisma.session.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    let totp: SeededAccount["totp"] = null;
    if (demo.totp) {
      const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      // A secret encrypted under a previous AUTH_MFA_ENCRYPTION_KEY can no longer be read (the
      // account could not sign in), so it is re-issued like a reset.
      let base32 =
        reset || !stored.mfaSecret
          ? null
          : await security.decrypt(stored.mfaSecret, `totp:${user.id}`).catch(() => null);
      if (!base32) {
        base32 = new Secret({ size: 20 }).base32;
        await prisma.user.update({
          where: { id: user.id },
          data: {
            mfaSecret: await security.encrypt(base32, `totp:${user.id}`),
            mfaCounter: -1,
            mfaPending: null,
            mfaPendingUntil: null,
            mfaPendingSessionId: null,
          },
        });
      }
      const label = { issuer: "PM-Buddy", label: demo.identifier };
      totp = {
        secret: base32,
        uri: new TOTP({ ...label, secret: Secret.fromBase32(base32) }).toString(),
      };
    }
    accounts.push({
      id: user.id,
      key: demo.key,
      role: demo.role,
      identifier: demo.identifier,
      displayName: demo.displayName,
      password,
      totp,
      created: !existing,
    });
  }
  const owner = accounts.find((account) => account.key === "owner")!;
  const userOf = (key: DemoAccount["key"]) => accounts.find((account) => account.key === key)!;

  // The owner discovers their own memberships before a company is selected (memberships_read).
  const memberships = await db.run({ userId: owner.id, tenantId: null, requestId: "seed" }, (tx) =>
    tx.membership.findMany({
      where: { userId: owner.id, role: "owner" },
      select: { tenant: { select: { id: true, name: true } } },
    }),
  );
  const found = memberships.find((membership) => membership.tenant.name === DEMO_COMPANY);
  const tenantId = found?.tenant.id ?? randomUUID();
  const audit: Audit = (tx, action, resourceId, metadata = {}) =>
    tx.auditEvent.create({
      data: { tenantId, actorId: owner.id, requestId: "seed", action, resourceId, metadata },
    });

  const projects: SeedSummary["projects"] = [];
  const buildups: SeedSummary["buildups"] = [];
  await db.run({ userId: owner.id, tenantId, requestId: "seed" }, async (tx) => {
    if (!found) {
      await tx.tenant.create({ data: { id: tenantId, name: DEMO_COMPANY, createdBy: owner.id } });
      await tx.membership.create({ data: { tenantId, userId: owner.id, role: "owner" } });
      await audit(tx, "tenant.created", tenantId, SOURCE);
    }
    await tx.$queryRaw`SELECT tenant_id FROM tenants WHERE tenant_id = ${tenantId}::uuid FOR UPDATE`;
    for (const account of accounts.filter((entry) => entry.key !== "owner")) {
      const member = await tx.membership.findUnique({
        where: { tenantId_userId: { tenantId, userId: account.id } },
      });
      if (!member) {
        await tx.membership.create({ data: { tenantId, userId: account.id, role: account.role } });
        await audit(tx, "membership.joined", account.id, { ...SOURCE, role: account.role });
      }
    }
    for (const demo of DEMO_PROJECTS)
      projects.push(await seedProject(tx, tenantId, owner.id, demo, userOf, audit));
    buildups.push(await seedBuildup(tx, tenantId, owner.id, audit));
  });

  const procurement = await seedProcurement(app, tenantId, owner.id, userOf("finance").id);
  const procureToPay = await seedProcureToPay(app, tenantId, {
    ownerId: owner.id,
    projectManagerId: userOf("projectManager").id,
    siteAgentId: userOf("siteAgent").id,
    financeId: userOf("finance").id,
  });

  const crypto = app.get(LabourCrypto);
  const labour = await db.run({ userId: owner.id, tenantId, requestId: "seed" }, async (tx) => {
    await tx.$queryRaw`SELECT tenant_id FROM tenants WHERE tenant_id = ${tenantId}::uuid FOR UPDATE`;
    const rows = await tx.project.findMany({
      where: { tenantId, code: { in: DEMO_PROJECTS.map((project) => project.code) } },
      include: { sites: { select: { id: true, name: true } } },
    });
    const byCode = new Map(
      rows.map((row) => [
        row.code,
        { id: row.id, sites: new Map(row.sites.map((site) => [site.name, site.id])) },
      ]),
    );
    const team = accounts
      .filter((account) => account.key !== "owner")
      .map((account) => ({
        id: account.id,
        role: account.role,
        projectCodes: DEMO_PROJECTS.filter((project) => project.team.includes(account.key)).map(
          (project) => project.code,
        ),
      }));
    return seedLabour(tx, crypto, tenantId, owner.id, byCode, team, audit);
  });

  const attendance = await seedAttendance(
    app,
    tenantId,
    {
      ownerId: owner.id,
      pmId: userOf("projectManager").id,
      agentId: userOf("siteAgent").id,
    },
    audit,
  );
  const payroll = await seedPayroll(app, tenantId, {
    ownerId: owner.id,
    pmId: userOf("projectManager").id,
    agentId: userOf("siteAgent").id,
  });
  const stores = await seedStores(app, tenantId, {
    ownerId: owner.id,
    projectManagerId: userOf("projectManager").id,
    siteAgentId: userOf("siteAgent").id,
    storekeeperId: userOf("storekeeper").id,
  });
  // After the attendance seed, so the company's public holidays shape the working calendar.
  const schedule = await seedSchedule(app, tenantId, owner.id);
  // After procure-to-pay and stores: the ledger already holds the invoice and its settlement, and
  // the budget starts from the approved BQ.
  const spending = await seedSpending(app, tenantId, {
    ownerId: owner.id,
    projectManagerId: userOf("projectManager").id,
    siteAgentId: userOf("siteAgent").id,
    financeId: userOf("finance").id,
  });
  // After attendance (diary snapshots) and the schedule.
  const quality = await seedQuality(app, tenantId, {
    ownerId: owner.id,
    projectManagerId: userOf("projectManager").id,
    siteAgentId: userOf("siteAgent").id,
  });
  // After attendance (induction flags read it) and the labour gangs.
  const safety = await seedSafety(app, tenantId, {
    ownerId: owner.id,
    projectManagerId: userOf("projectManager").id,
    siteAgentId: userOf("siteAgent").id,
  });

  return {
    company: { id: tenantId, name: DEMO_COMPANY, created: !found },
    accounts: accounts.map(({ id: _id, key: _key, ...account }) => account),
    projects,
    buildups,
    procurement,
    labour,
    attendance,
    payroll,
    procureToPay,
    stores,
    schedule,
    spending,
    quality,
    safety,
  };
}

/** The synthetic build-up example (version 1), unless the company already has it. */
async function seedBuildup(
  tx: Tx,
  tenantId: string,
  ownerId: string,
  audit: Audit,
): Promise<SeedSummary["buildups"][number]> {
  const rate = buildupRate(DEMO_BUILDUP.lines);
  const existing = await tx.rateBuildup.findUnique({
    where: { tenantId_code: { tenantId, code: DEMO_BUILDUP.code } },
  });
  if (existing)
    return { code: existing.code, name: existing.name, rateMinor: rate.rateMinor, created: false };
  const id = randomUUID();
  const versionId = randomUUID();
  await tx.rateBuildup.create({
    data: {
      id,
      tenantId,
      code: DEMO_BUILDUP.code,
      name: DEMO_BUILDUP.name,
      unit: DEMO_BUILDUP.unit,
      currentVersionNo: 1,
      createdBy: ownerId,
      updatedBy: ownerId,
    },
  });
  await tx.rateBuildupVersion.create({
    data: {
      id: versionId,
      tenantId,
      buildupId: id,
      versionNo: 1,
      name: DEMO_BUILDUP.name,
      unit: DEMO_BUILDUP.unit,
      assumptions: DEMO_BUILDUP.assumptions,
      rateMinor: rate.rateMinor === null ? null : BigInt(rate.rateMinor),
      pricedMinor: BigInt(rate.pricedMinor),
      unpricedLines: rate.unpricedLines,
      lineCount: DEMO_BUILDUP.lines.length,
      rounding: BUILDUP_ROUNDING,
      createdBy: ownerId,
    },
  });
  await tx.rateBuildupLine.createMany({
    data: DEMO_BUILDUP.lines.map((line, index) => ({
      id: randomUUID(),
      tenantId,
      versionId,
      lineNo: index + 1,
      kind: line.kind,
      resourceName: line.resourceName,
      unit: line.unit,
      quantity: line.quantity,
      wastePercent: line.wastePercent,
      unitCostMinor: BigInt(line.unitCostMinor),
      amountMinor: BigInt(rate.lineAmountsMinor[index]!),
    })),
  });
  await audit(tx, "rate_buildup.created", id, {
    ...SOURCE,
    versionNo: 1,
    lines: DEMO_BUILDUP.lines.length,
  });
  return {
    code: DEMO_BUILDUP.code,
    name: DEMO_BUILDUP.name,
    rateMinor: rate.rateMinor,
    created: true,
  };
}

/** Assigns the demo team to a project: each member without an assignment gets their role's. */
async function assignTeam(
  tx: Tx,
  tenantId: string,
  projectId: string,
  demo: DemoProject,
  userOf: (key: DemoAccount["key"]) => { id: string; role: TenantSystemRole },
  audit: Audit,
) {
  for (const key of demo.team) {
    const member = userOf(key);
    const assigned = await tx.projectMembership.findFirst({
      where: { tenantId, projectId, userId: member.id },
      select: { userId: true },
    });
    if (assigned) continue;
    const permissions = PROJECT_ASSIGNABLE_PERMISSIONS.filter((permission) =>
      SYSTEM_ROLE_PERMISSIONS[member.role].includes(permission),
    );
    await tx.projectMembership.create({
      data: { tenantId, projectId, userId: member.id, permissions },
    });
    await audit(tx, "project.permissions.changed", projectId, {
      ...SOURCE,
      userId: member.id,
      permissions,
    });
  }
}

async function seedProject(
  tx: Tx,
  tenantId: string,
  ownerId: string,
  demo: DemoProject,
  userOf: (key: DemoAccount["key"]) => { id: string; role: TenantSystemRole },
  audit: Audit,
) {
  const existing = await tx.project.findUnique({
    where: { tenantId_code: { tenantId, code: demo.code } },
  });
  if (existing) {
    // A database seeded before a team member was added (the storekeeper in D5.3) gets the new
    // assignment; existing assignments are left as they are.
    await assignTeam(tx, tenantId, existing.id, demo, userOf, audit);
    return { code: demo.code, name: existing.name, status: existing.status, created: false };
  }

  const project = await tx.project.create({
    data: {
      tenantId,
      code: demo.code,
      name: demo.name,
      description: demo.description,
      clientName: demo.clientName,
      clientEmail: demo.clientEmail,
      clientPhone: demo.clientPhone,
      contractSumMinor: demo.contractSumMinor === null ? null : BigInt(demo.contractSumMinor),
      contractType: demo.contractType,
      startDate: calendar(demo.startDate),
      endDate: calendar(demo.endDate),
      county: demo.county,
      town: demo.town,
      latitude: demo.latitude,
      longitude: demo.longitude,
      createdBy: ownerId,
    },
  });
  await audit(tx, "project.created", project.id, { ...SOURCE, code: demo.code });

  for (const site of demo.sites) {
    const geofence = normaliseGeofence(site.geofence);
    const issues = validateGeofence(geofence);
    if (issues.length)
      throw new Error(`Seed geofence for ${site.name} is invalid: ${issues.join(", ")}`);
    const metrics = geofenceMetrics(geofence);
    const row = await tx.site.create({
      data: {
        tenantId,
        projectId: project.id,
        name: site.name,
        address: site.address,
        createdBy: ownerId,
      },
    });
    await tx.siteGeofence.create({
      data: {
        tenantId,
        siteId: row.id,
        createdBy: ownerId,
        areaM2: Math.round(metrics.areaM2 * 10) / 10,
        perimeterM: Math.round(metrics.perimeterM * 10) / 10,
        ...(geofence.kind === "radius"
          ? {
              kind: "radius",
              centerLat: geofence.center.lat,
              centerLng: geofence.center.lng,
              radiusM: geofence.radiusM,
            }
          : { kind: "polygon", polygon: geofence.vertices.map(({ lat, lng }) => ({ lat, lng })) }),
      },
    });
    await audit(tx, "site.created", row.id, {
      ...SOURCE,
      projectId: project.id,
      geofence: { version: 1, kind: geofence.kind },
    });
  }

  const nodeIds = new Map<string, string>();
  const addNodes = async (nodes: DemoWbs[], parentId: string | null) => {
    for (const [index, node] of nodes.entries()) {
      const row = await tx.wbsNode.create({
        data: {
          tenantId,
          projectId: project.id,
          parentId,
          code: node.code,
          name: node.name,
          sortOrder: index,
          weightBasisPoints: node.weight,
          createdBy: ownerId,
        },
      });
      nodeIds.set(node.code, row.id);
      if (node.children) await addNodes(node.children, row.id);
    }
  };
  await addNodes(demo.wbs, null);

  for (const milestone of demo.milestones) {
    const row = await tx.milestone.create({
      data: {
        tenantId,
        projectId: project.id,
        wbsNodeId: milestone.wbs ? (nodeIds.get(milestone.wbs) ?? null) : null,
        name: milestone.name,
        dueDate: calendar(milestone.dueDate),
        createdBy: ownerId,
      },
    });
    if (milestone.status && milestone.status !== "planned")
      await tx.milestone.update({
        where: { tenantId_id: { tenantId, id: row.id } },
        data: {
          status: milestone.status,
          actualDate: milestone.actualDate ? calendar(milestone.actualDate) : null,
          version: { increment: 1 },
        },
      });
  }

  await assignTeam(tx, tenantId, project.id, demo, userOf, audit);

  if (!demo.activate)
    return { code: demo.code, name: demo.name, status: project.status, created: true };
  await tx.project.update({
    where: { tenantId_id: { tenantId, id: project.id } },
    data: { status: "active", version: { increment: 1 } },
  });
  await tx.projectStatusChange.create({
    data: {
      tenantId,
      projectId: project.id,
      fromStatus: "planning",
      toStatus: "active",
      reason: "Contract signed and site handed over (demo data)",
      changedBy: ownerId,
    },
  });
  await audit(tx, "project.status_changed", project.id, {
    ...SOURCE,
    from: "planning",
    to: "active",
    action: "activate",
    reasonGiven: true,
  });
  if (!demo.complete) return { code: demo.code, name: demo.name, status: "active", created: true };
  await tx.project.update({
    where: { tenantId_id: { tenantId, id: project.id } },
    data: { status: "completed", version: { increment: 1 } },
  });
  await tx.projectStatusChange.create({
    data: {
      tenantId,
      projectId: project.id,
      fromStatus: "active",
      toStatus: "completed",
      reason: null,
      changedBy: ownerId,
    },
  });
  await audit(tx, "project.status_changed", project.id, {
    ...SOURCE,
    from: "active",
    to: "completed",
    action: "complete",
    reasonGiven: false,
  });
  return { code: demo.code, name: demo.name, status: "completed", created: true };
}
