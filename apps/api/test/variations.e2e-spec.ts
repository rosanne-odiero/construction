import { readFileSync } from "node:fs";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { App } from "supertest/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  bqBillResponseSchema,
  bqCompareResponseSchema,
  bqContractSumResponseSchema,
  bqImportResponseSchema,
  bqItemLinkResponseSchema,
  bqResponseSchema,
  bqVersionResponseSchema,
  bqVersionsResponseSchema,
  buildupResponseSchema,
  buildupsResponseSchema,
  buildupVersionResponseSchema,
  instructionResponseSchema,
  instructionsResponseSchema,
  projectResponseSchema,
  variationResponseSchema,
  variationsResponseSchema,
  type BqImport,
  type BqItemWire,
  type Instruction,
  type Project,
  type VariationDetail,
} from "@pm-buddy/validation";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { PrismaService } from "../src/infra/prisma.service.js";
import { AuthSecurity } from "../src/modules/identity/auth-security.service.js";
import { TenantDatabase } from "../src/modules/identity/tenant-database.service.js";
import { Browser, notifications } from "./support.js";

/**
 * D2.3 BQ versions, instructions, variations and rate build-ups end to end under the real
 * runtime role (pmb_app, forced RLS). Expected amounts are worked out by hand from the synthetic
 * multi-bill fixture (test/fixtures/bq/generate.mts), independently of the code under test.
 */
const fixture = (name: string) => readFileSync(new URL(`./fixtures/bq/${name}`, import.meta.url));
const MULTI = {
  subtotal: 3_331_654_203,
  vat: 533_064_672,
  grand: 3_864_718_875,
  bills: { "1": 343_000_000, "2": 859_500_213, "3": 1_612_503_990, "4": 516_650_000 },
};
/** VO-001: +2,128,750 +56 −97,440,000 +4,533,317 +2,500,000 (net −88,277,877). */
const VO1 = {
  additions: 9_162_123,
  omissions: 97_440_000,
  net: -88_277_877,
  subtotal: 3_243_376_326,
  vat: 518_940_212,
  grand: 3_762_316_538,
  effect: -102_402_337,
  bills: { "1": 343_000_000, "2": 764_189_019, "3": 1_617_037_307, "4": 519_150_000 },
};
/** VO-002 on version 1: slab 81.25 → 85 m³ (+6,075,000) and wire rate 4.75 → 6 (+187). */
const VO2_ON_V1 = { net: 6_075_187, effect: 7_047_217 };
/** VO-002 rebased onto version 2 (wire base 7.69 → 9.00: +131). */
const VO2_ON_V2 = {
  net: 6_075_131,
  subtotal: 3_249_451_457,
  vat: 519_912_233,
  grand: 3_769_363_690,
  effect: 7_047_152,
};

describe("BQ versions, instructions, variations and build-ups (real runtime role)", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let db: TenantDatabase;
  let owner: Browser;
  let ownerB: Browser;
  let qs: Browser;
  let pm: Browser;
  let agent: Browser;
  let consultant: Browser;
  let qsNowhere: Browser;
  let tenantA: string;
  let tenantB: string;
  let main: Project;
  let race: Project;
  let makerProject: Project;
  let draftProject: Project;
  let bProject: Project;
  let ai1: Instruction;
  let ai2: Instruction;
  let vo1: VariationDetail;
  let vo2: VariationDetail;
  let v1Id: string;
  let notificationSpy: ReturnType<typeof vi.spyOn>;

  const fresh = (browser: Browser) =>
    prisma.session.update({
      where: { id: browser.auth.session.id },
      data: { mfaVerifiedAt: new Date() },
    });
  const stale = (browser: Browser) =>
    prisma.session.update({
      where: { id: browser.auth.session.id },
      data: { mfaVerifiedAt: new Date(Date.now() - 10 * 60_000) },
    });
  const join = async (member: Browser, role: string, projectIds: string[]) => {
    await fresh(owner);
    const invited = await owner.call("post", "tenants/current/invitations", {
      identifier: member.identifier,
      role,
      projectIds,
    });
    expect(invited.status, JSON.stringify(invited.body)).toBe(201);
    const token = notifications
      .get(member.identifier)
      ?.at(-1)
      ?.text.match(/Invitation token: ([A-Za-z0-9_-]+)/)?.[1];
    expect((await member.call("post", "tenants/invitations/accept", { token })).status).toBe(200);
    expect((await member.call("post", `tenants/${tenantA}/select`, {})).status).toBe(200);
  };
  const createProject = async (browser: Browser, name: string, extra: object = {}) => {
    await fresh(browser);
    const res = await browser.call("post", "projects", { name, ...extra });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return projectResponseSchema.parse(res.body).project;
  };
  const problem = (res: request.Response) => (res.body as { code?: string }).code;
  const base = (project: Project) => `projects/${project.id}/bq`;
  const imported = (res: request.Response) => bqImportResponseSchema.parse(res.body).import;
  const variation = (res: request.Response) => {
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return variationResponseSchema.parse(res.body).variation;
  };

  /** Upload → mapping → validation → accept any warnings → commit (version 1, draft). */
  const importBq = async (browser: Browser, project: Project, file: string) => {
    const uploaded = await browser.upload(`${base(project)}/imports`, fixture(file), file);
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
    let current: BqImport = imported(uploaded);
    const mapped = await browser.call("put", `${base(project)}/imports/${current.id}/mapping`, {
      mapping: current.mapping,
      version: current.version,
    });
    current = imported(mapped);
    const validated = await browser.call(
      "post",
      `${base(project)}/imports/${current.id}/validate`,
      { version: current.version },
    );
    current = imported(validated);
    const warnings = current.report!.readiness.unacceptedWarnings;
    if (warnings.length) {
      const resolved = await browser.call(
        "put",
        `${base(project)}/imports/${current.id}/resolutions`,
        {
          resolutions: {
            rows: [],
            accepted: warnings.map((code) => ({ code, reason: "Synthetic test fixture" })),
          },
          version: current.version,
        },
      );
      current = imported(resolved);
    }
    const committed = await browser.call("post", `${base(project)}/imports/${current.id}/commit`, {
      version: current.version,
    });
    expect(committed.status, JSON.stringify(committed.body)).toBe(200);
    return imported(committed);
  };
  const getBq = async (browser: Browser, project: Project) => {
    const res = await browser.call("get", base(project));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return bqResponseSchema.parse(res.body);
  };
  /** Every item of the project's current version (all bills). */
  const itemsOf = async (browser: Browser, project: Project) => {
    const view = await getBq(browser, project);
    const items: (BqItemWire & { billNumber: string; billLineageId: string })[] = [];
    for (const bill of view.bq!.bills) {
      const res = await browser.call("get", `${base(project)}/bills/${bill.id}`);
      const parsed = bqBillResponseSchema.parse(res.body);
      items.push(
        ...parsed.items.map((entry) => ({
          ...entry,
          billNumber: bill.number,
          billLineageId: bill.lineageId,
        })),
      );
    }
    return { view, items };
  };
  const itemOf = (items: BqItemWire[], text: string) => {
    const found = items.find((entry) => entry.description.startsWith(text));
    expect(found, text).toBeDefined();
    return found!;
  };
  const sums = async (browser: Browser, project: Project) => {
    const res = await browser.call("get", `${base(project)}/contract-sum`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return bqContractSumResponseSchema.parse(res.body);
  };
  const versions = async (browser: Browser, project: Project) => {
    const res = await browser.call("get", `${base(project)}/versions`);
    expect(res.status).toBe(200);
    return bqVersionsResponseSchema.parse(res.body).versions;
  };
  const approveBaseline = async (browser: Browser, project: Project) => {
    const [draft] = await versions(browser, project);
    await fresh(browser);
    return browser.call("post", `${base(project)}/versions/${draft!.id}/approve`, {
      version: draft!.version,
    });
  };
  const createInstruction = async (browser: Browser, project: Project, number: string) => {
    const res = await browser.call("post", `${base(project)}/instructions`, {
      number,
      issuedOn: "2026-11-02",
      issuerName: "Arch. Achieng Otieno (synthetic)",
      issuerRole: "architect",
      subject: `Instruction ${number}: revised foundations (synthetic)`,
      description: "SECRET-DESCRIPTION-TEXT: do not copy into the audit log",
      attachments: [{ name: "Drawing A-104 rev C", reference: "DRG/A/104/C" }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return instructionResponseSchema.parse(res.body).instruction;
  };
  const createVariation = async (
    browser: Browser,
    project: Project,
    instruction: Instruction,
    title: string,
  ) => {
    const res = await browser.call("post", `${base(project)}/variations`, {
      instructionId: instruction.id,
      title,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return variationResponseSchema.parse(res.body).variation;
  };
  const saveLines = (
    browser: Browser,
    project: Project,
    target: VariationDetail,
    lines: object[],
  ) =>
    browser.call("put", `${base(project)}/variations/${target.id}/lines`, {
      lines,
      version: target.version,
    });
  const act = (
    browser: Browser,
    project: Project,
    target: VariationDetail,
    action: string,
    extra: object = {},
  ) =>
    browser.call("post", `${base(project)}/variations/${target.id}/${action}`, {
      version: target.version,
      ...extra,
    });
  const decide = (
    browser: Browser,
    project: Project,
    target: VariationDetail,
    action: "approve" | "reject",
    extra: object = {},
  ) => act(browser, project, target, action, { snapshotDigest: target.snapshot!.digest, ...extra });
  const getVariation = async (browser: Browser, project: Project, id: string) =>
    variation(await browser.call("get", `${base(project)}/variations/${id}`));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    db = app.get(TenantDatabase);
    notificationSpy = vi
      .spyOn(app.get(AuthSecurity), "notify")
      .mockImplementation(async (identifier, subject, text) => {
        notifications.set(identifier, [
          ...(notifications.get(identifier) ?? []),
          { subject, text },
        ]);
      });
    owner = new Browser(app);
    ownerB = new Browser(app);
    qs = new Browser(app);
    pm = new Browser(app);
    agent = new Browser(app);
    consultant = new Browser(app);
    qsNowhere = new Browser(app);
    for (const browser of [owner, ownerB, pm, consultant]) {
      await browser.register();
      await browser.enroll();
    }
    for (const browser of [qs, agent, qsNowhere]) await browser.register();
    const a = await owner.call("post", "tenants", { name: "Variations company A" });
    const b = await ownerB.call("post", "tenants", { name: "Variations company B" });
    expect([a.status, b.status]).toEqual([201, 201]);
    tenantA = (a.body as { tenant: { id: string } }).tenant.id;
    tenantB = (b.body as { tenant: { id: string } }).tenant.id;
    main = await createProject(owner, "Ruiru Heights variations (synthetic)", {
      contractSumMinor: MULTI.grand,
    });
    race = await createProject(owner, "Concurrent approvals (synthetic)");
    makerProject = await createProject(owner, "Owner-imported BQ (synthetic)");
    draftProject = await createProject(owner, "Draft baseline (synthetic)");
    bProject = await createProject(ownerB, "Company B variations project");
    await join(qs, "quantity_surveyor", [main.id, race.id, draftProject.id]);
    await join(pm, "project_manager", [main.id]);
    await join(agent, "site_agent", [main.id]);
    await join(consultant, "consultant", [main.id, race.id]);
    await join(qsNowhere, "quantity_surveyor", []);
  }, 180_000);

  afterAll(async () => {
    notificationSpy?.mockRestore();
    await app?.close();
  });

  it("documents every D2.3 operation in OpenAPI", async () => {
    const openApi = await request(app.getHttpServer()).get("/api/docs/openapi.json").expect(200);
    const operations = Object.values(
      (openApi.body as { paths: Record<string, Record<string, { operationId?: string }>> }).paths,
    ).flatMap((path) => Object.values(path).map((operation) => operation.operationId));
    for (const id of [
      "listBqVersions",
      "compareBqVersions",
      "getBqVersionBill",
      "approveBqBaseline",
      "getBqContractSum",
      "listInstructions",
      "createInstruction",
      "getInstruction",
      "updateInstruction",
      "listVariations",
      "createVariation",
      "getVariation",
      "updateVariation",
      "saveVariationLines",
      "submitVariation",
      "approveVariation",
      "rejectVariation",
      "reopenVariation",
      "cancelVariation",
      "rebaseVariation",
      "getBqItemBuildup",
      "linkBqItemBuildup",
      "unlinkBqItemBuildup",
      "listRateBuildups",
      "createRateBuildup",
      "getRateBuildup",
      "updateRateBuildup",
      "getRateBuildupVersion",
    ])
      expect(operations, id).toContain(id);
  });

  it("approves the imported draft as the baseline: permission, step-up, maker-checker, immutability", async () => {
    await importBq(qs, main, "kenyan-multi-bill.xlsx");
    const asQs = await getBq(qs, main);
    expect(asQs.bq!.version).toMatchObject({ versionNo: 1, status: "draft", current: true });
    expect(asQs.baselineApproval).toEqual({ allowed: false, refusal: "permission" });
    expect((await getBq(owner, main)).baselineApproval).toEqual({ allowed: true, refusal: null });
    const [draft] = await versions(qs, main);
    v1Id = draft!.id;
    // Before approval there is no contract baseline: variations cannot be raised yet.
    expect(await sums(qs, main)).toMatchObject({
      status: "draft",
      draftTotalMinor: MULTI.grand,
      originalMinor: null,
      revisedMinor: null,
    });

    // Without the permission (quantity surveyor), without a fresh step-up, or as the importer.
    const byQs = await qs.call("post", `${base(main)}/versions/${v1Id}/approve`, {
      version: draft!.version,
    });
    expect(byQs.status).toBe(403);
    await stale(owner);
    const notFresh = await owner.call("post", `${base(main)}/versions/${v1Id}/approve`, {
      version: draft!.version,
    });
    expect([notFresh.status, problem(notFresh)]).toEqual([403, "step-up-required"]);
    await importBq(owner, makerProject, "single-sheet-alt-columns.xlsx");
    expect((await getBq(owner, makerProject)).baselineApproval).toEqual({
      allowed: false,
      refusal: "maker",
    });
    const byMaker = await approveBaseline(owner, makerProject);
    expect([byMaker.status, problem(byMaker)]).toEqual([403, "maker-checker"]);

    const stalePayload = await (async () => {
      await fresh(owner);
      return owner.call("post", `${base(main)}/versions/${v1Id}/approve`, {
        version: draft!.version + 1,
      });
    })();
    expect([stalePayload.status, problem(stalePayload)]).toEqual([409, "version-conflict"]);
    const approved = await approveBaseline(owner, main);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(bqVersionResponseSchema.parse(approved.body).version).toMatchObject({
      versionNo: 1,
      status: "approved",
      source: "import",
      parentVersionId: null,
      variation: null,
      approvedBy: { id: owner.auth.user.id },
      current: true,
      grandTotalMinor: MULTI.grand,
    });
    const again = await owner.call("post", `${base(main)}/versions/${v1Id}/approve`, {
      version: draft!.version + 1,
    });
    expect([again.status, problem(again)]).toEqual([409, "bq-not-draft"]);

    // Re-import is refused once approved (D2.2's draft replacement only works while draft).
    const uploaded = await qs.upload(
      `${base(main)}/imports`,
      fixture("kenyan-multi-bill.xlsx"),
      "again.xlsx",
    );
    let current = imported(uploaded);
    current = imported(
      await qs.call("put", `${base(main)}/imports/${current.id}/mapping`, {
        mapping: current.mapping,
        version: current.version,
      }),
    );
    current = imported(
      await qs.call("post", `${base(main)}/imports/${current.id}/validate`, {
        version: current.version,
      }),
    );
    const reimport = await qs.call("post", `${base(main)}/imports/${current.id}/commit`, {
      version: current.version,
    });
    expect([reimport.status, problem(reimport)]).toEqual([409, "bq-not-draft"]);

    // The database refuses changes to an approved version directly, under the runtime role.
    const context = { userId: qs.auth.user.id, tenantId: tenantA, requestId: "d23-immutable" };
    await expect(
      db.run(
        context,
        (tx) =>
          tx.$executeRaw`UPDATE bq_versions SET grand_total_minor = grand_total_minor + 1,
          subtotal_minor = subtotal_minor + 1 WHERE id = ${v1Id}::uuid`,
      ),
    ).rejects.toThrow(/approved BQ version never changes/);
    await expect(
      db.run(
        context,
        (tx) => tx.$executeRaw`UPDATE bq_versions SET status = 'draft' WHERE id = ${v1Id}::uuid`,
      ),
    ).rejects.toThrow(/approved BQ version never changes/);
    await expect(
      db.run(
        context,
        (tx) =>
          tx.$executeRaw`UPDATE bq_items SET quantity = quantity + 1 WHERE version_id = ${v1Id}::uuid`,
      ),
    ).rejects.toThrow(/Only a draft BQ version can change/);
    await expect(
      db.run(context, (tx) => tx.$executeRaw`DELETE FROM bq_versions WHERE id = ${v1Id}::uuid`),
    ).rejects.toThrow(/permission denied/);

    expect(await sums(agent, main)).toEqual({
      status: "approved",
      vatRatePercent: "16",
      draftTotalMinor: null,
      originalMinor: MULTI.grand,
      approvedVariationsMinor: 0,
      revisedMinor: MULTI.grand,
      approvedCount: 0,
      pendingMinor: 0,
      pendingCount: 0,
      currentVersionNo: 1,
      baselineApprovedAt: expect.any(String),
    });
  });

  it("keeps an instruction register: bq.edit to change, numbers unique per project", async () => {
    ai1 = await createInstruction(qs, main, "AI-001");
    ai2 = await createInstruction(qs, main, "AI-002");
    expect(ai1).toMatchObject({
      number: "AI-001",
      issuerRole: "architect",
      status: "open",
      attachments: [{ name: "Drawing A-104 rev C", reference: "DRG/A/104/C" }],
      variations: { total: 0, approved: 0, pending: 0 },
      createdBy: { id: qs.auth.user.id },
    });
    const duplicate = await qs.call("post", `${base(main)}/instructions`, {
      number: "AI-001",
      issuedOn: "2026-11-03",
      issuerName: "Eng. Mwangi",
      issuerRole: "engineer",
      subject: "Duplicate number",
    });
    expect([duplicate.status, problem(duplicate)]).toEqual([409, "instruction-number-taken"]);
    const byAgent = await agent.call("post", `${base(main)}/instructions`, {
      number: "AI-099",
      issuedOn: "2026-11-03",
      issuerName: "Eng. Mwangi",
      issuerRole: "engineer",
      subject: "No permission",
    });
    expect(byAgent.status).toBe(403);
    const listed = instructionsResponseSchema.parse(
      (await agent.call("get", `${base(main)}/instructions`)).body,
    );
    expect(listed.permissions).toEqual({ canEdit: false });
    expect(listed.instructions.map((entry) => entry.number).sort()).toEqual(["AI-001", "AI-002"]);

    const changed = await qs.call("patch", `${base(main)}/instructions/${ai2.id}`, {
      subject: "Close off the store room door (synthetic)",
      status: "closed",
      version: ai2.version,
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    ai2 = instructionResponseSchema.parse(changed.body).instruction;
    expect(ai2).toMatchObject({ status: "closed", version: 2 });
    const conflict = await qs.call("patch", `${base(main)}/instructions/${ai2.id}`, {
      subject: "Stale edit",
      version: 1,
    });
    expect([conflict.status, problem(conflict)]).toEqual([409, "version-conflict"]);
    // The same number on another project is fine.
    await createInstruction(qs, race, "AI-001");
  });

  it("drafts, prices and submits variations with exact add, omit and net totals", async () => {
    const { view, items } = await itemsOf(qs, main);
    const columnBases = itemOf(items, "Excavate for column bases");
    const wire = itemOf(items, "Galvanised binding wire");
    const beams = itemOf(items, "Reinforced concrete class 25 in ground beams");
    const slab = itemOf(items, "Ground floor slab 150 mm thick");
    expect([
      columnBases.amountMinor,
      wire.amountMinor,
      beams.amountMinor,
      slab.amountMinor,
    ]).toEqual([20_150_000, 713, 97_440_000, 131_625_000]);
    const billThree = view.bq!.bills.find((bill) => bill.number === "3")!;
    const billFour = view.bq!.bills.find((bill) => bill.number === "4")!;
    const billTwo = view.bq!.bills.find((bill) => bill.number === "2")!;

    // Raising a variation needs bq.edit and an open instruction.
    const byAgent = await agent.call("post", `${base(main)}/variations`, {
      instructionId: ai1.id,
      title: "No permission",
    });
    expect(byAgent.status).toBe(403);
    const closed = await qs.call("post", `${base(main)}/variations`, {
      instructionId: ai2.id,
      title: "On a closed instruction",
    });
    expect([closed.status, problem(closed)]).toEqual([409, "instruction-closed"]);

    vo1 = await createVariation(qs, main, ai1, "Foundations revised by AI-001 (synthetic)");
    expect(vo1).toMatchObject({
      number: "VO-001",
      status: "draft",
      baseVersion: { id: v1Id, versionNo: 1 },
      stale: false,
      snapshot: null,
      permissions: { canEdit: true, actions: ["submit", "cancel"] },
    });

    // Invalid lines are refused with a stable code, naming the line.
    for (const lines of [
      [{ action: "adjust", itemLineageId: crypto.randomUUID(), quantity: "1" }],
      [{ action: "adjust", itemLineageId: wire.lineageId }],
      [
        { action: "adjust", itemLineageId: wire.lineageId, rate: "5" },
        { action: "omit", itemLineageId: wire.lineageId },
      ],
      [
        {
          action: "add",
          billLineageId: billThree.lineageId,
          sectionLineageId: billTwo.sections[0]!.lineageId,
          description: "Section of another bill",
          unit: "m",
          kind: "measured",
          quantity: "1",
          rate: "1",
        },
      ],
    ]) {
      const refused = await saveLines(qs, main, vo1, lines);
      expect([refused.status, problem(refused)], JSON.stringify(lines)).toEqual([
        400,
        "variation-line-invalid",
      ]);
    }

    vo1 = variation(
      await saveLines(qs, main, vo1, [
        { action: "adjust", itemLineageId: columnBases.lineageId, quantity: "342.75" },
        {
          action: "adjust",
          itemLineageId: wire.lineageId,
          rate: "5.125",
          note: "Supplier price list",
        },
        {
          action: "omit",
          itemLineageId: beams.lineageId,
          note: "Ground beams replaced by strip footing",
        },
        {
          action: "add",
          billLineageId: billThree.lineageId,
          newSection: { code: "X", title: "EXTRA WORKS (VO-001)" },
          ref: "X1",
          description: "Extra precast lintels over new openings (synthetic)",
          unit: "m",
          kind: "measured",
          quantity: "24.5",
          rate: "1850.3333",
        },
        {
          action: "add",
          billLineageId: billFour.lineageId,
          newSection: { title: "DAYWORKS (VO-001)" },
          description: "Daywork allowance for removing ground beam formwork (synthetic)",
          kind: "daywork",
          amountMinor: 2_500_000,
        },
      ]),
    );
    expect(
      vo1.lines.map((line) => [
        line.action,
        line.baseAmountMinor,
        line.newAmountMinor,
        line.deltaMinor,
      ]),
    ).toEqual([
      ["adjust", 20_150_000, 22_278_750, 2_128_750],
      ["adjust", 713, 769, 56],
      ["omit", 97_440_000, 0, -97_440_000],
      ["add", 0, 4_533_317, 4_533_317],
      ["add", 0, 2_500_000, 2_500_000],
    ]);
    expect(vo1.totals).toEqual({
      additionsMinor: VO1.additions,
      omissionsMinor: VO1.omissions,
      netMinor: VO1.net,
    });
    expect(vo1.projected).toEqual({
      subtotalMinor: VO1.subtotal,
      vatMinor: VO1.vat,
      grandTotalMinor: VO1.grand,
    });
    expect(vo1.grandTotalEffectMinor).toBe(VO1.effect);
    expect(vo1.lines.every((line) => line.issue === null)).toBe(true);
    const lostUpdate = await saveLines(qs, main, { ...vo1, version: 1 }, []);
    expect([lostUpdate.status, problem(lostUpdate)]).toEqual([409, "version-conflict"]);

    vo2 = await createVariation(qs, main, ai1, "Thicker slab and dearer wire (synthetic)");
    vo2 = variation(
      await saveLines(qs, main, vo2, [
        { action: "adjust", itemLineageId: slab.lineageId, quantity: "85" },
        { action: "adjust", itemLineageId: wire.lineageId, rate: "6" },
      ]),
    );
    expect(vo2.totals.netMinor).toBe(VO2_ON_V1.net);
    expect(vo2.grandTotalEffectMinor).toBe(VO2_ON_V1.effect);

    // An empty draft cannot be submitted; a draft can be cancelled with a reason.
    let empty = await createVariation(qs, main, ai1, "Raised by mistake");
    const emptySubmit = await act(qs, main, empty, "submit");
    expect([emptySubmit.status, problem(emptySubmit)]).toEqual([409, "variation-empty"]);
    const noReason = await act(qs, main, empty, "cancel", { reason: "no" });
    expect(noReason.status).toBe(400);
    empty = variation(await act(qs, main, empty, "cancel", { reason: "Raised by mistake" }));
    expect(empty).toMatchObject({ status: "cancelled", cancelReason: "Raised by mistake" });
    const afterCancel = await act(qs, main, empty, "submit");
    expect([afterCancel.status, problem(afterCancel)]).toEqual([409, "invalid-transition"]);

    vo1 = variation(await act(qs, main, vo1, "submit"));
    vo2 = variation(await act(qs, main, vo2, "submit"));
    expect(vo1).toMatchObject({
      status: "submitted",
      snapshot: {
        digest: expect.stringMatching(/^[0-9a-f]{64}$/),
        submittedBy: { id: qs.auth.user.id },
      },
      permissions: { canEdit: false },
    });
    expect(vo1.snapshot!.digest).not.toBe(vo2.snapshot!.digest);
    // Frozen: neither the API nor a direct UPDATE can change a submitted proposal.
    const frozen = await saveLines(qs, main, vo1, []);
    expect([frozen.status, problem(frozen)]).toEqual([409, "invalid-transition"]);
    const context = { userId: qs.auth.user.id, tenantId: tenantA, requestId: "d23-frozen" };
    await expect(
      db.run(
        context,
        (tx) =>
          tx.$executeRaw`UPDATE variation_lines SET quantity = 1 WHERE variation_id = ${vo1.id}::uuid`,
      ),
    ).rejects.toThrow(/only while the variation is a draft/);
    await expect(
      db.run(
        context,
        (tx) =>
          tx.$executeRaw`UPDATE variation_orders SET title = 'Changed after submission' WHERE id = ${vo1.id}::uuid`,
      ),
    ).rejects.toThrow(/submitted variation cannot change/);

    // Pending variations are reported separately and never added into the revised sum.
    expect(await sums(qs, main)).toMatchObject({
      originalMinor: MULTI.grand,
      revisedMinor: MULTI.grand,
      approvedVariationsMinor: 0,
      pendingMinor: VO1.effect + VO2_ON_V1.effect,
      pendingCount: 2,
    });
    expect(VO1.effect + VO2_ON_V1.effect).toBe(-95_355_120);
    const list = variationsResponseSchema.parse(
      (await qs.call("get", `${base(main)}/variations?status=submitted`)).body,
    );
    expect(list.variations.map((entry) => entry.number)).toEqual(["VO-002", "VO-001"]);
    expect(list).toMatchObject({
      permissions: { canCreate: true, canApprove: false },
      createBlocker: null,
    });
  });

  it("refuses decisions without the permission, without step-up, by the maker, or on a changed snapshot", async () => {
    const byQs = await decide(qs, main, vo1, "approve");
    expect(byQs.status).toBe(403);
    const byAgent = await decide(agent, main, vo1, "approve");
    expect(byAgent.status).toBe(403);
    await stale(consultant);
    const notFresh = await decide(consultant, main, vo1, "approve");
    expect([notFresh.status, problem(notFresh)]).toEqual([403, "step-up-required"]);

    // The project manager raises and submits VO-003, then cannot decide it themselves.
    const { items } = await itemsOf(pm, main);
    const oversite = itemOf(items, "Excavate oversite");
    let vo3 = await createVariation(pm, main, ai1, "Oversite rate (synthetic)");
    vo3 = variation(
      await saveLines(pm, main, vo3, [
        { action: "adjust", itemLineageId: oversite.lineageId, rate: "185" },
      ]),
    );
    vo3 = variation(await act(pm, main, vo3, "submit"));
    await fresh(pm);
    const ownApproval = await decide(pm, main, vo3, "approve");
    expect([ownApproval.status, problem(ownApproval)]).toEqual([403, "maker-checker"]);
    const ownRejection = await decide(pm, main, vo3, "reject", { reason: "Rejecting my own" });
    expect([ownRejection.status, problem(ownRejection)]).toEqual([403, "maker-checker"]);
    const pmView = await getVariation(pm, main, vo3.id);
    expect(pmView.permissions).toMatchObject({ actions: [], approvalBlocker: "maker" });

    const firstDigest = vo3.snapshot!.digest;
    const noReason = await decide(owner, main, vo3, "reject", { reason: "no" });
    expect(noReason.status).toBe(400);
    vo3 = variation(
      await decide(owner, main, vo3, "reject", { reason: "Rate needs a supplier quotation" }),
    );
    expect(vo3).toMatchObject({
      status: "rejected",
      decision: {
        outcome: "rejected",
        by: { id: owner.auth.user.id },
        reason: "Rate needs a supplier quotation",
      },
    });
    vo3 = variation(await act(pm, main, vo3, "reopen"));
    expect(vo3).toMatchObject({ status: "draft", snapshot: null, decision: null });
    vo3 = variation(
      await saveLines(pm, main, vo3, [
        { id: vo3.lines[0]!.id, action: "adjust", itemLineageId: oversite.lineageId, rate: "190" },
      ]),
    );
    vo3 = variation(await act(pm, main, vo3, "submit"));
    expect(vo3.snapshot!.digest).not.toBe(firstDigest);
    // Approving what was reviewed before the edit is refused: the snapshot changed.
    await fresh(owner);
    const staleApproval = await act(owner, main, vo3, "approve", { snapshotDigest: firstDigest });
    expect([staleApproval.status, problem(staleApproval)]).toEqual([409, "variation-stale"]);
    vo3 = variation(
      await decide(owner, main, vo3, "reject", { reason: "Withdrawn by the architect" }),
    );
    expect(vo3.history.map((entry) => entry.action)).toEqual([
      "create",
      "submit",
      "reject",
      "reopen",
      "submit",
      "reject",
    ]);
    expect(vo3.history[2]).toMatchObject({
      reason: "Rate needs a supplier quotation",
      by: { id: owner.auth.user.id },
    });
  });

  it("approves a variation into the next version atomically; the other goes stale until rebased", async () => {
    await fresh(owner);
    const approved = variation(await decide(owner, main, vo1, "approve"));
    expect(approved).toMatchObject({
      status: "approved",
      resultVersion: { versionNo: 2 },
      decision: { outcome: "approved", by: { id: owner.auth.user.id } },
      permissions: { canEdit: false, actions: [] },
    });
    const history = await versions(qs, main);
    expect(
      history.map((entry) => [entry.versionNo, entry.status, entry.source, entry.current]),
    ).toEqual([
      [2, "approved", "variation", true],
      [1, "approved", "import", false],
    ]);
    const v2 = history[0]!;
    expect(v2).toMatchObject({
      parentVersionId: v1Id,
      variation: { id: vo1.id, number: "VO-001" },
      createdBy: { id: qs.auth.user.id },
      approvedBy: { id: owner.auth.user.id },
      vatRatePercent: "16",
      vatRuleStatus: "compliance_review",
      subtotalMinor: VO1.subtotal,
      vatMinor: VO1.vat,
      grandTotalMinor: VO1.grand,
      itemCount: 41,
    });
    const { view, items } = await itemsOf(qs, main);
    expect(
      Object.fromEntries(view.bq!.bills.map((bill) => [bill.number, bill.totalMinor])),
    ).toEqual(VO1.bills);
    expect(itemOf(items, "Excavate for column bases")).toMatchObject({
      quantity: "342.75",
      amountMinor: 22_278_750,
      amountSource: "computed",
    });
    expect(itemOf(items, "Galvanised binding wire")).toMatchObject({
      rate: "5.125",
      amountMinor: 769,
    });
    expect(itemOf(items, "Reinforced concrete class 25 in ground beams")).toMatchObject({
      quantity: "0",
      amountMinor: 0,
      amountSource: "omitted",
    });
    expect(itemOf(items, "Extra precast lintels")).toMatchObject({
      ref: "X1",
      unit: "m",
      amountMinor: 4_533_317,
      sourceSheet: null,
      sourceRow: null,
    });
    expect(itemOf(items, "Daywork allowance")).toMatchObject({
      kind: "daywork",
      amountSource: "fixed",
      rate: null,
      amountMinor: 2_500_000,
    });
    const extras = view.bq!.bills.find((bill) => bill.number === "3")!.sections.at(-1)!;
    expect(extras).toMatchObject({
      code: "X",
      title: "EXTRA WORKS (VO-001)",
      totalMinor: 4_533_317,
    });
    const again = await decide(owner, main, vo1, "approve");
    expect([again.status, problem(again)]).toEqual([409, "invalid-transition"]);
    await expect(
      db.run(
        { userId: qs.auth.user.id, tenantId: tenantA, requestId: "d23-v2" },
        (tx) =>
          tx.$executeRaw`UPDATE bq_items SET amount_minor = 0, amount_source = 'unpriced'
          WHERE version_id = ${v2.id}::uuid`,
      ),
    ).rejects.toThrow(/Only a draft BQ version can change/);

    // VO-002 was based on version 1: approval is refused until it is rebased.
    await fresh(owner);
    const staleBase = await decide(owner, main, vo2, "approve");
    expect([staleBase.status, problem(staleBase)]).toEqual([409, "variation-stale"]);
    vo2 = await getVariation(qs, main, vo2.id);
    expect(vo2).toMatchObject({ stale: true, latestVersion: { versionNo: 2 } });
    expect(vo2.permissions.actions).toEqual(["rebase"]);
    expect((await getVariation(owner, main, vo2.id)).permissions.approvalBlocker).toBe("stale");
    expect(await sums(qs, main)).toMatchObject({
      revisedMinor: VO1.grand,
      approvedVariationsMinor: VO1.effect,
      approvedCount: 1,
      pendingMinor: VO2_ON_V1.effect,
      pendingCount: 1,
    });

    vo2 = variation(await act(qs, main, vo2, "rebase"));
    expect(vo2).toMatchObject({
      status: "draft",
      stale: false,
      baseVersion: { versionNo: 2 },
      snapshot: null,
      totals: { netMinor: VO2_ON_V2.net },
      grandTotalEffectMinor: VO2_ON_V2.effect,
    });
    expect(vo2.lines.map((line) => [line.baseAmountMinor, line.deltaMinor, line.issue])).toEqual([
      [131_625_000, 6_075_000, null],
      [769, 131, null],
    ]);
    const notStale = await act(qs, main, vo2, "rebase");
    expect([notStale.status, problem(notStale)]).toEqual([409, "variation-not-stale"]);
    expect((await sums(qs, main)).pendingCount).toBe(0);
    vo2 = variation(await act(qs, main, vo2, "submit"));
    await fresh(owner);
    vo2 = variation(await decide(owner, main, vo2, "approve"));
    expect(vo2.resultVersion).toMatchObject({ versionNo: 3 });
    expect(await sums(qs, main)).toEqual({
      status: "approved",
      vatRatePercent: "16",
      draftTotalMinor: null,
      originalMinor: MULTI.grand,
      approvedVariationsMinor: VO2_ON_V2.grand - MULTI.grand,
      revisedMinor: VO2_ON_V2.grand,
      approvedCount: 2,
      pendingMinor: 0,
      pendingCount: 0,
      currentVersionNo: 3,
      baselineApprovedAt: expect.any(String),
    });
    expect(VO2_ON_V2.grand - MULTI.grand).toBe(-95_355_185);
    const [v3] = await versions(qs, main);
    expect(v3).toMatchObject({ subtotalMinor: VO2_ON_V2.subtotal, vatMinor: VO2_ON_V2.vat });
  });

  it("compares versions item by item and bill by bill", async () => {
    const [v3, , v1] = await versions(qs, main);
    const res = await qs.call("get", `${base(main)}/versions/compare?from=${v1!.id}&to=${v3!.id}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const result = bqCompareResponseSchema.parse(res.body);
    expect(
      result.added.map((entry) => [entry.description.slice(0, 20), entry.differenceMinor]),
    ).toEqual([
      ["Extra precast lintel", 4_533_317],
      ["Daywork allowance fo", 2_500_000],
    ]);
    expect(result.removed).toEqual([]);
    expect(
      result.changed.map((entry) => [
        entry.description.slice(0, 24),
        entry.fields,
        entry.differenceMinor,
      ]),
    ).toEqual([
      ["Excavate for column base", ["quantity", "amount"], 2_128_750],
      ["Reinforced concrete clas", ["quantity", "amount", "amountSource"], -97_440_000],
      ["Ground floor slab 150 mm", ["quantity", "amount"], 6_075_000],
      ["Galvanised binding wire", ["rate", "amount"], 187],
    ]);
    expect(
      result.bills.map((bill) => [bill.number, bill.fromMinor, bill.toMinor, bill.differenceMinor]),
    ).toEqual([
      ["1", 343_000_000, 343_000_000, 0],
      ["2", 859_500_213, 770_264_150, -89_236_063],
      ["3", 1_612_503_990, 1_617_037_307, 4_533_317],
      ["4", 516_650_000, 519_150_000, 2_500_000],
    ]);
    expect(result.totals.difference).toEqual({
      subtotalMinor: VO2_ON_V2.subtotal - MULTI.subtotal,
      vatMinor: VO2_ON_V2.vat - MULTI.vat,
      grandTotalMinor: -95_355_185,
    });
    const reverse = bqCompareResponseSchema.parse(
      (await qs.call("get", `${base(main)}/versions/compare?from=${v3!.id}&to=${v1!.id}`)).body,
    );
    expect(reverse.removed.map((entry) => entry.differenceMinor)).toEqual([-4_533_317, -2_500_000]);
    const unknown = await qs.call(
      "get",
      `${base(main)}/versions/compare?from=${v1!.id}&to=${crypto.randomUUID()}`,
    );
    expect(unknown.status).toBe(404);
    // A bill of an older version can still be read (the variation editor uses its base).
    const oldBills = (await getBq(qs, main)).bq!.bills;
    expect(oldBills).toHaveLength(4);
  });

  it("serialises concurrent approvals per BQ: exactly one succeeds", async () => {
    await importBq(qs, race, "single-sheet-alt-columns.xlsx");
    expect((await approveBaseline(owner, race)).status).toBe(200);
    const instruction = instructionsResponseSchema.parse(
      (await qs.call("get", `${base(race)}/instructions`)).body,
    ).instructions[0]!;
    const { items } = await itemsOf(qs, race);
    const priced = items.filter((entry) => entry.amountSource === "computed");
    let first = await createVariation(qs, race, instruction, "Race A (synthetic)");
    let second = await createVariation(qs, race, instruction, "Race B (synthetic)");
    first = variation(
      await saveLines(qs, race, first, [
        { action: "adjust", itemLineageId: priced[0]!.lineageId, quantity: "1" },
      ]),
    );
    second = variation(
      await saveLines(qs, race, second, [
        { action: "adjust", itemLineageId: priced[1]!.lineageId, quantity: "2" },
      ]),
    );
    first = variation(await act(qs, race, first, "submit"));
    second = variation(await act(qs, race, second, "submit"));

    // Two approvals of two variations on the same base, at the same time, by two approvers.
    await fresh(owner);
    await fresh(consultant);
    const results = await Promise.all([
      decide(owner, race, first, "approve"),
      decide(consultant, race, second, "approve"),
    ]);
    expect(results.map((res) => res.status).sort((left, right) => left - right)).toEqual([
      200, 409,
    ]);
    expect(problem(results.find((res) => res.status === 409)!)).toBe("variation-stale");
    let raceVersions = await versions(qs, race);
    expect(raceVersions.map((entry) => entry.versionNo)).toEqual([2, 1]);
    const winner = results[0]!.status === 200 ? first : second;
    let loser = results[0]!.status === 200 ? second : first;
    expect(raceVersions[0]!.variation!.id).toBe(winner.id);

    // The same variation approved twice at the same time: one approval, one new version.
    loser = variation(await act(qs, race, await getVariation(qs, race, loser.id), "rebase"));
    loser = variation(await act(qs, race, loser, "submit"));
    await fresh(owner);
    await fresh(consultant);
    const twice = await Promise.all([
      decide(owner, race, loser, "approve"),
      decide(consultant, race, loser, "approve"),
    ]);
    expect(twice.map((res) => res.status).sort((left, right) => left - right)).toEqual([200, 409]);
    raceVersions = await versions(qs, race);
    expect(raceVersions.map((entry) => entry.versionNo)).toEqual([3, 2, 1]);
    // The database also refuses a second child of the same version.
    await expect(
      db.run(
        { userId: qs.auth.user.id, tenantId: tenantA, requestId: "d23-fork" },
        (tx) =>
          tx.$executeRaw`INSERT INTO bq_versions (id, tenant_id, project_id, bq_id, version_no,
          source, parent_version_id, variation_id, vat_rate_percent, vat_rule_key, vat_rule_status,
          rounding, subtotal_minor, vat_minor, grand_total_minor, bill_count, item_count,
          created_by, updated_by)
          SELECT ${crypto.randomUUID()}::uuid, tenant_id, project_id, bq_id, 3, 'variation', id,
            ${winner.id}::uuid, vat_rate_percent, vat_rule_key, vat_rule_status, rounding, 0, 0, 0,
            0, 0, created_by, updated_by
          FROM bq_versions WHERE id = ${raceVersions[1]!.id}::uuid`,
      ),
    ).rejects.toThrow();
  });

  it("keeps a versioned rate build-up library and links BQ items to a version", async () => {
    const lines = [
      {
        kind: "material",
        resourceName: "Cement (bag, assumed 50 kg)",
        unit: "bag",
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
        wastePercent: null,
        unitCostMinor: 220_000,
      },
      {
        kind: "labour",
        resourceName: "Mason and helpers",
        unit: "hr",
        quantity: "4.333333",
        wastePercent: null,
        unitCostMinor: 35_050,
      },
      {
        kind: "plant",
        resourceName: "Concrete mixer",
        unit: "hr",
        quantity: "0.5",
        wastePercent: null,
        unitCostMinor: 150_000,
      },
    ];
    expect((await qsNowhere.call("get", "rate-buildups")).status).toBe(403);
    const forAgent = buildupsResponseSchema.parse((await agent.call("get", "rate-buildups")).body);
    expect(forAgent.permissions).toEqual({ canEdit: false });
    const denied = await agent.call("post", "rate-buildups", {
      code: "NOPE",
      name: "No permission",
      unit: "m3",
      lines,
    });
    expect(denied.status).toBe(403);
    const created = await qs.call("post", "rate-buildups", {
      code: "conc-c25",
      name: "Concrete class 25 (1:2:4) — synthetic",
      unit: "m3",
      assumptions:
        "Synthetic values. Cement bag 50 kg; sand and ballast in tonnes, not lorry trips.",
      lines,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    let concrete = buildupResponseSchema.parse(created.body);
    expect(concrete.buildup).toMatchObject({
      code: "CONC-C25",
      unit: "m3",
      currentVersionNo: 1,
      rateMinor: 1_307_508,
      unpricedLines: 0,
      lineCount: 5,
    });
    expect(concrete.current.lines.map((line) => line.amountMinor)).toEqual([
      580_125, 192_500, 308_000, 151_883, 75_000,
    ]);
    expect(concrete.current.byKind).toEqual({
      material: 1_080_625,
      labour: 151_883,
      plant: 75_000,
    });
    const duplicate = await qs.call("post", "rate-buildups", {
      code: "CONC-C25",
      name: "Again",
      unit: "m3",
      lines,
    });
    expect([duplicate.status, problem(duplicate)]).toEqual([409, "buildup-code-taken"]);
    const unpriced = buildupResponseSchema.parse(
      (
        await qs.call("post", "rate-buildups", {
          code: "BLOCK-200",
          name: "Machine-cut stone walling 200 mm (synthetic)",
          unit: "m2",
          lines: [{ ...lines[0], unitCostMinor: null }],
        })
      ).body,
    );
    expect(unpriced.buildup).toMatchObject({ rateMinor: null, unpricedLines: 1 });
    const versionOne = concrete.current.id;

    // Editing appends version 2; version 1 is unchanged.
    const edited = await qs.call("put", `rate-buildups/${concrete.buildup.id}`, {
      name: concrete.current.name,
      unit: "m3",
      assumptions: concrete.current.assumptions,
      lines: [{ ...lines[0], unitCostMinor: 90_000 }, ...lines.slice(1)],
      version: concrete.buildup.version,
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    concrete = buildupResponseSchema.parse(edited.body);
    // 6.5 × 1.05 × 900 = 6,142.50
    expect(concrete.buildup).toMatchObject({ currentVersionNo: 2, rateMinor: 1_341_633 });
    expect(concrete.versions.map((entry) => [entry.versionNo, entry.rateMinor])).toEqual([
      [2, 1_341_633],
      [1, 1_307_508],
    ]);
    const old = buildupVersionResponseSchema.parse(
      (await agent.call("get", `rate-buildups/${concrete.buildup.id}/versions/1`)).body,
    ).version;
    expect(old).toMatchObject({ id: versionOne, rateMinor: 1_307_508 });
    const staleEdit = await qs.call("put", `rate-buildups/${concrete.buildup.id}`, {
      name: "Stale",
      unit: "m3",
      lines,
      version: 1,
    });
    expect([staleEdit.status, problem(staleEdit)]).toEqual([409, "version-conflict"]);

    // Linking checks units and keeps the version used.
    const { items } = await itemsOf(qs, main);
    const columnConcrete = itemOf(items, "Reinforced concrete class 25 in column bases");
    const blinding = itemOf(items, "Blinding 50 mm thick");
    const linked = await qs.call(
      "put",
      `${base(main)}/items/${columnConcrete.lineageId}/rate-buildup`,
      {
        buildupVersionId: versionOne,
      },
    );
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    expect(bqItemLinkResponseSchema.parse(linked.body).link).toMatchObject({
      code: "CONC-C25",
      versionNo: 1,
      rateMinor: 1_307_508,
      linkedBy: { id: qs.auth.user.id },
    });
    const { items: after } = await itemsOf(agent, main);
    expect(itemOf(after, "Reinforced concrete class 25 in column bases").rateBuildUp).toMatchObject(
      {
        versionNo: 1,
        rateMinor: 1_307_508,
      },
    );
    const mismatch = await qs.call(
      "put",
      `${base(main)}/items/${blinding.lineageId}/rate-buildup`,
      {
        buildupVersionId: versionOne,
      },
    );
    expect([mismatch.status, problem(mismatch)]).toEqual([422, "unit-mismatch"]);
    expect((mismatch.body as { detail: string }).detail).toMatch(
      /per m3 but the item is measured in m2/,
    );
    const byAgent = await agent.call(
      "put",
      `${base(main)}/items/${columnConcrete.lineageId}/rate-buildup`,
      {
        buildupVersionId: versionOne,
      },
    );
    expect(byAgent.status).toBe(403);
    await importBq(qs, draftProject, "single-sheet-alt-columns.xlsx");
    const { items: draftItems } = await itemsOf(qs, draftProject);
    const notApproved = await qs.call(
      "put",
      `${base(draftProject)}/items/${draftItems[0]!.lineageId}/rate-buildup`,
      { buildupVersionId: versionOne },
    );
    expect([notApproved.status, problem(notApproved)]).toEqual([409, "bq-not-approved"]);
    const draftInstruction = await createInstruction(qs, draftProject, "AI-001");
    const beforeBaseline = await qs.call("post", `${base(draftProject)}/variations`, {
      instructionId: draftInstruction.id,
      title: "Before the baseline",
    });
    expect([beforeBaseline.status, problem(beforeBaseline)]).toEqual([
      409,
      "baseline-not-approved",
    ]);

    // Relinking to version 2 keeps the earlier link as history; unlinking stamps it.
    const relinked = bqItemLinkResponseSchema.parse(
      (
        await qs.call("put", `${base(main)}/items/${columnConcrete.lineageId}/rate-buildup`, {
          buildupVersionId: concrete.current.id,
        })
      ).body,
    );
    expect(relinked.link).toMatchObject({ versionNo: 2, rateMinor: 1_341_633 });
    const unlinked = await qs.call(
      "delete",
      `${base(main)}/items/${columnConcrete.lineageId}/rate-buildup`,
    );
    expect(bqItemLinkResponseSchema.parse(unlinked.body).link).toBeNull();
    const again = await qs.call(
      "delete",
      `${base(main)}/items/${columnConcrete.lineageId}/rate-buildup`,
    );
    expect(again.status).toBe(404);
    const links = await db.run(
      { userId: qs.auth.user.id, tenantId: tenantA, requestId: "d23-links" },
      (tx) => tx.bqItemRateLink.findMany({ where: { itemLineageId: columnConcrete.lineageId } }),
    );
    expect(links).toHaveLength(2);
    expect(links.every((link) => link.unlinkedAt !== null)).toBe(true);
    await qs.call("put", `${base(main)}/items/${columnConcrete.lineageId}/rate-buildup`, {
      buildupVersionId: versionOne,
    });

    // Build-up versions and lines are append-only for the runtime role.
    const context = { userId: qs.auth.user.id, tenantId: tenantA, requestId: "d23-buildups" };
    await expect(
      db.run(
        context,
        (tx) =>
          tx.$executeRaw`UPDATE rate_buildup_versions SET rate_minor = 1 WHERE id = ${versionOne}::uuid`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.run(
        context,
        (tx) =>
          tx.$executeRaw`INSERT INTO rate_buildup_lines (id, tenant_id, version_id, line_no, kind,
          resource_name, unit, quantity, unit_cost_minor, amount_minor)
          VALUES (${crypto.randomUUID()}::uuid, ${tenantA}::uuid, ${versionOne}::uuid, 9, 'labour',
            'Extra', 'hr', 1, 100, 100)`,
      ),
    ).rejects.toThrow(/Build-up version totals do not match/);
    await expect(
      db.run(
        context,
        (tx) =>
          tx.$executeRaw`UPDATE bq_item_rate_links SET buildup_version_id = ${concrete.current.id}::uuid
          WHERE item_lineage_id = ${columnConcrete.lineageId}::uuid AND unlinked_at IS NULL`,
      ),
    ).rejects.toThrow(/never edited/);
  });

  it("keeps company B out of A's instructions, variations, versions and build-ups", async () => {
    const [v3] = await versions(qs, main);
    const buildups = buildupsResponseSchema.parse(
      (await qs.call("get", "rate-buildups")).body,
    ).buildups;
    expect(buildups.length).toBeGreaterThan(0);
    for (const path of [
      `${base(main)}/instructions/${ai1.id}`,
      `${base(bProject)}/instructions/${ai1.id}`,
      `${base(main)}/variations/${vo1.id}`,
      `${base(bProject)}/variations/${vo1.id}`,
      `${base(main)}/versions`,
      `${base(bProject)}/versions/compare?from=${v1Id}&to=${v3!.id}`,
      `${base(main)}/contract-sum`,
      `rate-buildups/${buildups[0]!.id}`,
      `rate-buildups/${buildups[0]!.id}/versions/1`,
    ])
      expect((await ownerB.call("get", path)).status, path).toBe(404);
    expect(
      buildupsResponseSchema.parse((await ownerB.call("get", "rate-buildups")).body).buildups,
    ).toEqual([]);
    await fresh(ownerB);
    for (const path of [
      `${base(main)}/variations/${vo2.id}/approve`,
      `${base(bProject)}/variations/${vo2.id}/approve`,
    ])
      expect(
        (await ownerB.call("post", path, { version: vo2.version, snapshotDigest: "a".repeat(64) }))
          .status,
        path,
      ).toBe(404);
    expect(
      (await ownerB.call("post", `${base(bProject)}/versions/${v1Id}/approve`, { version: 1 }))
        .status,
    ).toBe(404);
    expect(
      (
        await ownerB.call("put", `rate-buildups/${buildups[0]!.id}`, {
          name: "Stolen",
          unit: "m3",
          lines: [
            {
              kind: "labour",
              resourceName: "x",
              unit: "hr",
              quantity: "1",
              wastePercent: null,
              unitCostMinor: 1,
            },
          ],
          version: 1,
        })
      ).status,
    ).toBe(404);

    const contextB = { userId: ownerB.auth.user.id, tenantId: tenantB, requestId: "d23-rls" };
    await db.run(contextB, async (tx) => {
      expect(await tx.instruction.count()).toBe(0);
      expect(await tx.variationOrder.count()).toBe(0);
      expect(await tx.variationLine.count()).toBe(0);
      expect(await tx.variationStatusChange.count()).toBe(0);
      expect(await tx.rateBuildup.count()).toBe(0);
      expect(await tx.rateBuildupVersion.count()).toBe(0);
      expect(await tx.bqItemRateLink.count()).toBe(0);
    });
    // Writing A's tenant ID, or pointing B's rows at A's project, variation, version or build-up
    // through the composite keys, is refused.
    await expect(
      db.run(contextB, (tx) =>
        tx.instruction.create({
          data: {
            tenantId: tenantA,
            projectId: main.id,
            number: "AI-X",
            issuedOn: new Date("2026-11-01"),
            issuerName: "Cross tenant",
            issuerRole: "architect",
            subject: "Cross tenant",
            createdBy: ownerB.auth.user.id,
            updatedBy: ownerB.auth.user.id,
          },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      db.run(contextB, (tx) =>
        tx.instruction.create({
          data: {
            tenantId: tenantB,
            projectId: main.id,
            number: "AI-X",
            issuedOn: new Date("2026-11-01"),
            issuerName: "Cross project",
            issuerRole: "architect",
            subject: "Cross project",
            createdBy: ownerB.auth.user.id,
            updatedBy: ownerB.auth.user.id,
          },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      db.run(
        contextB,
        (tx) =>
          tx.$executeRaw`INSERT INTO variation_lines (id, tenant_id, variation_id, base_version_id,
          line_no, action, item_lineage_id, base_amount_minor, new_amount_minor, delta_minor)
          VALUES (${crypto.randomUUID()}::uuid, ${tenantB}::uuid, ${vo1.id}::uuid, ${v1Id}::uuid, 1,
            'omit', ${crypto.randomUUID()}::uuid, 0, 0, 0)`,
      ),
    ).rejects.toThrow();
    await expect(
      db.run(
        contextB,
        (tx) =>
          tx.$executeRaw`INSERT INTO bq_item_rate_links (id, tenant_id, project_id, bq_id, version_id,
          item_lineage_id, buildup_id, buildup_version_id, linked_by)
          SELECT ${crypto.randomUUID()}::uuid, ${tenantB}::uuid, ${bProject.id}::uuid,
            ${crypto.randomUUID()}::uuid, ${v1Id}::uuid, ${crypto.randomUUID()}::uuid,
            ${buildups[0]!.id}::uuid, ${buildups[0]!.currentVersionId}::uuid, ${ownerB.auth.user.id}::uuid`,
      ),
    ).rejects.toThrow();
  });

  it("audits every change with redacted summaries (no amounts, descriptions or reasons)", async () => {
    // The audit API lists the newest 100 events; read them all under the runtime role instead.
    await fresh(owner);
    expect((await owner.call("get", "tenants/current/audit")).status).toBe(200);
    const events = (
      await db.run(
        { userId: owner.auth.user.id, tenantId: tenantA, requestId: "d23-audit" },
        (tx) =>
          tx.auditEvent.findMany({ where: { tenantId: tenantA }, orderBy: { sequence: "asc" } }),
      )
    ).filter((event) =>
      /^(variation|instruction|rate_buildup)\.|^bq\.(baseline|item)\./.test(event.action),
    );
    const actions = new Set(events.map((event) => event.action));
    for (const action of [
      "bq.baseline.approved",
      "instruction.created",
      "instruction.updated",
      "variation.created",
      "variation.lines_saved",
      "variation.submitted",
      "variation.approved",
      "variation.rejected",
      "variation.reopened",
      "variation.cancelled",
      "variation.rebased",
      "rate_buildup.created",
      "rate_buildup.versioned",
      "bq.item.rate_linked",
      "bq.item.rate_unlinked",
    ])
      expect(actions.has(action), action).toBe(true);
    const text = JSON.stringify(events.map((event) => event.metadata));
    for (const secret of [
      "SECRET-DESCRIPTION-TEXT",
      "revised foundations",
      "Achieng",
      "precast lintels",
      "Daywork allowance",
      "supplier quotation",
      "Withdrawn by the architect",
      "Raised by mistake",
      "Supplier price list",
      "Cement",
      "lorry",
      "342.75",
      "5.125",
      String(VO1.additions),
      String(VO1.omissions),
      String(-VO1.net),
      "4533317",
      "2500000",
      "1307508",
      "85000",
    ])
      expect(text, secret).not.toContain(secret);
  });

  it("treats everyone who shaped a proposal or an import as a maker, and keeps approved content in place", async () => {
    const asUser = (browser: Browser, requestId: string) => ({
      userId: browser.auth.user.id,
      tenantId: tenantA,
      requestId,
    });

    // A variation raised and submitted by the QS, with lines written by the owner: the owner wrote
    // the proposal, so the owner may not decide it (API and database).
    const instruction = await createInstruction(qs, main, "AI-099");
    const { items } = await itemsOf(qs, main);
    const target = items.find((item) => item.quantity !== null && item.rate !== null)!;
    let vo = await createVariation(qs, main, instruction, "Owner-written lines (synthetic)");
    vo = variation(
      await saveLines(owner, main, vo, [
        { action: "adjust", itemLineageId: target.lineageId, rate: "123" },
      ]),
    );
    vo = variation(await act(qs, main, vo, "submit"));
    await fresh(owner);
    const byWriter = await decide(owner, main, vo, "approve");
    expect([byWriter.status, problem(byWriter)]).toEqual([403, "maker-checker"]);
    expect((await getVariation(owner, main, vo.id)).permissions.approvalBlocker).toBe("maker");
    const stored = await db.run(asUser(owner, "d23-contributors"), (tx) =>
      tx.variationOrder.findFirstOrThrow({ where: { id: vo.id }, select: { contributors: true } }),
    );
    expect(stored.contributors).toEqual(
      expect.arrayContaining([qs.auth.user.id, owner.auth.user.id]),
    );
    await expect(
      db.run(
        asUser(owner, "d23-direct-decision"),
        (tx) => tx.$executeRaw`UPDATE variation_orders SET status = 'rejected',
          decided_by = ${owner.auth.user.id}::uuid, decided_at = now(),
          decision_reason = 'Direct write', updated_by = ${owner.auth.user.id}::uuid
          WHERE id = ${vo.id}::uuid`,
      ),
    ).rejects.toThrow(/variation_orders_state_check/);
    await expect(
      db.run(
        asUser(owner, "d23-erase-contributors"),
        (tx) =>
          tx.$executeRaw`UPDATE variation_orders SET contributors = '{}' WHERE id = ${vo.id}::uuid`,
      ),
    ).rejects.toThrow(/only ever added/);
    // Someone who took no part can still decide.
    await fresh(consultant);
    const independent = await decide(consultant, main, vo, "reject", {
      reason: "Synthetic independent rejection",
    });
    expect(independent.status, JSON.stringify(independent.body)).toBe(200);

    // An import uploaded and committed by the QS but mapped by the owner: the owner may not
    // approve the baseline it produced.
    const project = await createProject(owner, "Import contributors (synthetic)");
    await fresh(owner);
    const assigned = await owner.call("put", `projects/${project.id}/members/${qs.auth.user.id}`, {
      permissions: ["projects.view", "bq.view", "bq.import", "bq.edit"],
    });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    const uploaded = await qs.upload(
      `${base(project)}/imports`,
      fixture("single-sheet-alt-columns.xlsx"),
      "single-sheet-alt-columns.xlsx",
    );
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
    let current = imported(uploaded);
    current = imported(
      await owner.call("put", `${base(project)}/imports/${current.id}/mapping`, {
        mapping: current.mapping,
        version: current.version,
      }),
    );
    current = imported(
      await qs.call("post", `${base(project)}/imports/${current.id}/validate`, {
        version: current.version,
      }),
    );
    const warnings = current.report!.readiness.unacceptedWarnings;
    if (warnings.length)
      current = imported(
        await qs.call("put", `${base(project)}/imports/${current.id}/resolutions`, {
          resolutions: {
            rows: [],
            accepted: warnings.map((code) => ({ code, reason: "Synthetic test fixture" })),
          },
          version: current.version,
        }),
      );
    const committed = await qs.call("post", `${base(project)}/imports/${current.id}/commit`, {
      version: current.version,
    });
    expect(committed.status, JSON.stringify(committed.body)).toBe(200);
    expect((await getBq(owner, project)).baselineApproval).toEqual({
      allowed: false,
      refusal: "maker",
    });
    const byMapper = await approveBaseline(owner, project);
    expect([byMapper.status, problem(byMapper)]).toEqual([403, "maker-checker"]);
    const [draft] = await versions(owner, project);
    await expect(
      db.run(
        asUser(owner, "d23-direct-baseline"),
        (tx) => tx.$executeRaw`UPDATE bq_versions SET status = 'approved',
          approved_by = ${owner.auth.user.id}::uuid, approved_at = now()
          WHERE id = ${draft!.id}::uuid`,
      ),
    ).rejects.toThrow(/makers cannot approve it/);

    // Approved content never moves to another version, and lineage never changes.
    await expect(
      db.run(
        asUser(owner, "d23-move-bill"),
        (tx) => tx.$executeRaw`UPDATE bq_bills SET version_id = ${draft!.id}::uuid
          WHERE version_id = ${v1Id}::uuid`,
      ),
    ).rejects.toThrow(/Only a draft BQ version can change/);
    await expect(
      db.run(
        asUser(owner, "d23-lineage"),
        (tx) => tx.$executeRaw`UPDATE bq_items SET lineage_id = gen_random_uuid()
          WHERE version_id = ${draft!.id}::uuid`,
      ),
    ).rejects.toThrow(/keeps its version and lineage/);
  });
});
