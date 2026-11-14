import type { INestApplicationContext } from "@nestjs/common";
import { addCalendarDays, nairobiDate } from "@pm-buddy/domain";
import type { ApprovalStatus, ComplianceStatus } from "@pm-buddy/types";
import {
  approvalResponseRequestSchema,
  createDocumentFieldsSchema,
  newVersionFieldsSchema,
  raiseApprovalRequestSchema,
  recordComplianceRequestSchema,
  recordInstructionRequestSchema,
  type ComplianceRegisterResponse,
  type DocumentDetail,
} from "@pm-buddy/validation";
import type { Request } from "express";
import sharp from "sharp";
import { uuidv7 } from "../common/uuid.js";
import { PrismaService } from "../infra/prisma.service.js";
import { ApprovalsService } from "../modules/documents/approvals.service.js";
import { ComplianceService } from "../modules/documents/compliance.service.js";
import { DocumentsOverviewService } from "../modules/documents/documents-overview.service.js";
import { DocumentsService } from "../modules/documents/documents.service.js";
import { InstructionsLogService } from "../modules/documents/instructions-log.service.js";
import type { Principal } from "../modules/identity/auth.service.js";
import { TenantDatabase } from "../modules/identity/tenant-database.service.js";
import { seedPrincipal } from "./demo-procure-to-pay.js";

/**
 * D8.4 demo documents, compliance, instructions and approval requests (synthetic), written through
 * the real services as the runtime role so every trigger applies. Files are tiny PDFs, PNGs and a
 * Word document generated here (no real documents). On RUI-HTS: drawing A-101 with revisions P1,
 * P2 and A (P1 and P2 superseded), S-201 with A and B, E-301; the signed contract, the priced BQ
 * and the CAR policy (confidential); permits and certificates; two submittals. The compliance
 * register covers every status: valid (county approval, NCA registration, signboard), expiring (the
 * CAR policy, renewed once), expired (the NEMA licence), missing (DOSHS registration) and not
 * applicable (the NCA levy); company items: the contractor's NCA registration (valid) and WIBA
 * (expiring). Instructions AI-001 (closed, linked to the balcony delay), EI-001 (acknowledged) and
 * SI-001 (received); approval requests APR-0001 (answered on paper), APR-0002 (overdue) and APR-0003
 * (pending). KIT-BNG gets its county approval only, so its other items show as missing. Dates are
 * relative to the seed day (Africa/Nairobi). Idempotent and resumable per project: every step is
 * skipped when what it creates is already there.
 */

export type DocumentsSeedSummary = {
  created: boolean;
  documents: number;
  drawings: { number: string; current: string; superseded: string[] }[];
  compliance: Record<ComplianceStatus, number>;
  reminders: number;
  instructions: { number: string; status: string }[];
  approvals: { code: string; status: ApprovalStatus; overdue: boolean }[];
};

type SeedUsers = { ownerId: string; projectManagerId: string; siteAgentId: string };
type Tx = Parameters<Parameters<TenantDatabase["run"]>[1]>[0];

const seedRequest = { headers: {} } as Request;

/** A small valid PDF with a visible label (synthetic). */
function pdf(label: string): Buffer {
  const text = label.replace(/[()\\]/g, " ");
  const stream = `BT /F1 14 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

/** A small PNG "scan" (synthetic), its colour varied so every file is distinct. */
const png = (seed: number) =>
  sharp({
    create: {
      width: 48,
      height: 64,
      channels: 3,
      background: { r: 240, g: 236 - (seed % 40), b: 220 },
    },
  })
    .png()
    .toBuffer();

const file = (buffer: Buffer, originalname: string) => ({
  buffer,
  originalname,
  size: buffer.length,
});

type DocumentSpec = {
  key: string;
  category: string;
  title: string;
  drawingNumber?: string;
  discipline?: string;
  reference?: string;
  revisions: { revision: string; purpose?: string; note?: string; uploader?: "pm" | "owner" }[];
  png?: boolean;
};

const RUI_DOCUMENTS: DocumentSpec[] = [
  {
    key: "A-101",
    category: "drawing",
    title: "Ground floor plan (synthetic)",
    drawingNumber: "A-101",
    discipline: "architectural",
    revisions: [
      { revision: "P1", purpose: "for_information" },
      { revision: "P2", purpose: "for_approval", note: "Stair core moved 600 mm east" },
      {
        revision: "A",
        purpose: "for_construction",
        note: "Issued for construction after approval",
      },
    ],
  },
  {
    key: "S-201",
    category: "drawing",
    title: "Foundation layout and details (synthetic)",
    drawingNumber: "S-201",
    discipline: "structural",
    revisions: [
      { revision: "A", purpose: "for_construction" },
      { revision: "B", purpose: "for_construction", note: "Ground beam GB3 deepened to 600 mm" },
    ],
  },
  {
    key: "E-301",
    category: "drawing",
    title: "Electrical layout, ground floor (synthetic)",
    drawingNumber: "E-301",
    discipline: "electrical",
    revisions: [{ revision: "A", purpose: "for_construction" }],
  },
  {
    key: "contract",
    category: "contract",
    title: "Main contract, JBC 2017 form, signed copy (synthetic)",
    reference: "RUI-HTS/CON/001",
    revisions: [{ revision: "Signed" }],
  },
  {
    key: "bq",
    category: "bq",
    title: "Priced bills of quantities, contract copy (synthetic)",
    revisions: [{ revision: "1" }],
  },
  {
    key: "car",
    category: "insurance",
    title: "Contractor's All Risk policy (synthetic)",
    reference: "CAR/2026/0042",
    revisions: [{ revision: "2026" }],
  },
  {
    key: "wiba",
    category: "insurance",
    title: "WIBA policy, company cover (synthetic)",
    reference: "WIBA/2026/0117",
    revisions: [{ revision: "2026" }],
  },
  {
    key: "county",
    category: "permit",
    title: "County building approval, Kiambu (synthetic)",
    reference: "KCG/BP/2026/0381",
    revisions: [{ revision: "1" }],
  },
  {
    key: "nca",
    category: "certificate",
    title: "NCA project registration certificate (synthetic)",
    reference: "NCA/PRJ/2026/11873",
    revisions: [{ revision: "1" }],
  },
  {
    key: "staircase",
    category: "submittal",
    title: "Steel staircase shop drawing (synthetic)",
    revisions: [{ revision: "1", purpose: "for_approval", uploader: "owner" }],
  },
  {
    key: "formwork",
    category: "submittal",
    title: "Slab formwork method statement (synthetic)",
    revisions: [{ revision: "1", purpose: "for_approval", uploader: "owner" }],
  },
  {
    key: "tiles",
    category: "submittal",
    title: "Floor tile sample data sheet (synthetic)",
    revisions: [{ revision: "1", purpose: "for_approval", uploader: "owner" }],
    png: true,
  },
];

/** The consultant's signed response to APR-0001, scanned after the request was raised (D-117). */
const RESPONSE_SCAN: DocumentSpec = {
  key: "response",
  category: "correspondence",
  title: "Signed response to APR-0001, scan (synthetic)",
  revisions: [{ revision: "1" }],
  png: true,
};

export async function seedDocuments(
  app: INestApplicationContext,
  tenantId: string,
  users: SeedUsers,
): Promise<DocumentsSeedSummary> {
  const prisma = app.get(PrismaService);
  const db = app.get(TenantDatabase);
  const documents = app.get(DocumentsService);
  const compliance = app.get(ComplianceService);
  const instructionsLog = app.get(InstructionsLogService);
  const approvals = app.get(ApprovalsService);
  const read = <T>(work: (tx: Tx) => Promise<T>) =>
    db.run({ userId: users.ownerId, tenantId, requestId: "seed" }, work);
  const today = nairobiDate();
  const day = (offset: number) => addCalendarDays(today, offset);
  const [owner, pm, agent] = await Promise.all(
    [users.ownerId, users.projectManagerId, users.siteAgentId].map((id) =>
      seedPrincipal(prisma, id, tenantId),
    ),
  );
  const facts = await read(async (tx) => {
    const projects = await tx.project.findMany({
      where: { tenantId, code: { in: ["RUI-HTS", "KIT-BNG"] } },
      select: { id: true, code: true },
    });
    const rui = projects.find((project) => project.code === "RUI-HTS")!.id;
    const delay = await tx.scheduleDelay.findFirst({
      where: { tenantId, projectId: rui, cause: "client_instruction", versionNo: 1 },
      select: { id: true },
    });
    const photo = await tx.sitePhoto.findFirst({
      where: { tenantId, projectId: rui, purpose: "general", verified: true },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    return {
      rui,
      kit: projects.find((project) => project.code === "KIT-BNG")!.id,
      delayId: delay?.id ?? null,
      photoId: photo?.id ?? null,
    };
  });
  let created = false;

  /** A document by title on a project, uploading it and its later revisions where missing. */
  const ensureDocument = async (projectId: string, spec: DocumentSpec, index: number) => {
    const existing = await read((tx) =>
      tx.document.findFirst({ where: { tenantId, projectId, title: spec.title } }),
    );
    let detail: DocumentDetail | null = existing
      ? (await documents.detail(owner, projectId, existing.id, seedRequest)).document
      : null;
    for (const [position, step] of spec.revisions.entries()) {
      if (detail?.versions.some((version) => version.revision === step.revision)) continue;
      const by = step.uploader === "owner" ? owner : pm;
      const content = spec.png
        ? await png(index * 7 + position)
        : pdf(`${spec.title} rev ${step.revision} - PM-Buddy demo, synthetic`);
      const name = `${spec.drawingNumber ?? spec.key} rev ${step.revision}.${spec.png ? "png" : "pdf"}`;
      created = true;
      detail = detail
        ? (
            await documents.addVersion(
              by,
              projectId,
              detail.id,
              file(content, name),
              newVersionFieldsSchema.parse({
                revision: step.revision,
                ...(step.purpose ? { issuePurpose: step.purpose } : {}),
                changeNote: step.note ?? `Revision ${step.revision} (synthetic)`,
                basedOnVersionId: detail.current.id,
              }),
              seedRequest,
            )
          ).document
        : (
            await documents.create(
              by,
              projectId,
              file(content, name),
              createDocumentFieldsSchema.parse({
                category: spec.category,
                title: spec.title,
                ...(spec.drawingNumber ? { drawingNumber: spec.drawingNumber } : {}),
                ...(spec.discipline ? { discipline: spec.discipline } : {}),
                ...(spec.reference ? { reference: spec.reference } : {}),
                revision: step.revision,
                ...(step.purpose ? { issuePurpose: step.purpose } : {}),
                ...(position === 0 ? {} : { changeNote: step.note }),
              }),
              seedRequest,
            )
          ).document;
    }
    return detail!;
  };

  const rui = new Map<string, DocumentDetail>();
  for (const [index, spec] of RUI_DOCUMENTS.entries())
    rui.set(spec.key, await ensureDocument(facts.rui, spec, index));
  const kitApproval = await ensureDocument(
    facts.kit,
    {
      key: "kit-county",
      category: "permit",
      title: "County building approval, Kajiado (synthetic)",
      reference: "KJD/BP/2026/0094",
      revisions: [{ revision: "1" }],
    },
    99,
  );

  /** Records an item unless it has a record; `renewal` records an earlier one first. */
  const ensureItem = async (
    by: Principal,
    projectId: string | null,
    register: ComplianceRegisterResponse,
    key: string,
    records: object[],
  ) => {
    const item = register.items.find((entry) => entry.type.key === key)!;
    if (item.current) return;
    let supersedesId: string | null = null;
    for (const body of records) {
      created = true;
      const result = await compliance.record(
        by,
        projectId,
        recordComplianceRequestSchema.parse({ typeId: item.type.id, supersedesId, ...body }),
        seedRequest,
      );
      supersedesId = result.records[0]!.id;
    }
  };
  const ruiRegister = (await compliance.register(
    pm,
    facts.rui,
    seedRequest,
  )) as ComplianceRegisterResponse;
  const evidence = (key: string) => rui.get(key)!.current.id;
  await ensureItem(pm, facts.rui, ruiRegister, "county_building_approval", [
    {
      kind: "record",
      referenceNo: "KCG/BP/2026/0381",
      issuer: "County Government of Kiambu (synthetic)",
      issuedOn: day(-200),
      expiresOn: day(530),
      evidenceVersionId: evidence("county"),
    },
  ]);
  await ensureItem(pm, facts.rui, ruiRegister, "nca_project_registration", [
    {
      kind: "record",
      referenceNo: "NCA/PRJ/2026/11873",
      issuer: "National Construction Authority (synthetic)",
      issuedOn: day(-190),
      evidenceVersionId: evidence("nca"),
    },
  ]);
  await ensureItem(pm, facts.rui, ruiRegister, "nca_levy", [
    {
      kind: "not_applicable",
      reason:
        "The client pays the levy directly under the contract (synthetic; COMPLIANCE-REVIEW CR-NCA-01)",
    },
  ]);
  await ensureItem(pm, facts.rui, ruiRegister, "nema_licence", [
    {
      kind: "record",
      referenceNo: "NEMA/EIA/PR/2025/4410",
      issuer: "NEMA (synthetic)",
      issuedOn: day(-370),
      expiresOn: day(-5),
      notes: "Renewal applied for; awaiting NEMA (synthetic)",
    },
  ]);
  await ensureItem(pm, facts.rui, ruiRegister, "car_insurance", [
    {
      kind: "record",
      referenceNo: "CAR/2025/0042",
      issuer: "Jubilee Allianz (synthetic)",
      issuedOn: day(-718),
      expiresOn: day(-353),
    },
    {
      kind: "record",
      referenceNo: "CAR/2026/0042",
      issuer: "Jubilee Allianz (synthetic)",
      issuedOn: day(-353),
      expiresOn: day(12),
      evidenceVersionId: evidence("car"),
    },
  ]);
  await ensureItem(pm, facts.rui, ruiRegister, "site_signboard", [
    {
      kind: "record",
      issuedOn: day(-180),
      notes: "Signboard with NCA and county numbers erected at the gate (synthetic)",
    },
  ]);
  // Company items: recorded once by the owner (config.manage) and shown on every project.
  await ensureItem(owner, null, ruiRegister, "nca_contractor_registration", [
    {
      kind: "record",
      referenceNo: "NCA4/B/2026/0331 (synthetic)",
      issuer: "National Construction Authority (synthetic)",
      issuedOn: day(-215),
      expiresOn: day(150),
    },
  ]);
  await ensureItem(owner, null, ruiRegister, "wiba_insurance", [
    {
      kind: "record",
      referenceNo: "WIBA/2026/0117",
      issuer: "Britam General (synthetic)",
      issuedOn: day(-345),
      expiresOn: day(20),
      evidenceVersionId: evidence("wiba"),
    },
  ]);
  const kitRegister = (await compliance.register(
    pm,
    facts.kit,
    seedRequest,
  )) as ComplianceRegisterResponse;
  await ensureItem(pm, facts.kit, kitRegister, "county_building_approval", [
    {
      kind: "record",
      referenceNo: "KJD/BP/2026/0094",
      issuer: "County Government of Kajiado (synthetic)",
      issuedOn: day(-210),
      expiresOn: day(520),
      evidenceVersionId: kitApproval.current.id,
    },
  ]);

  // Instructions: recorded by the number on the consultant's paper.
  const existingInstructions = new Set(
    await read(async (tx) =>
      (
        await tx.instruction.findMany({
          where: { tenantId, projectId: facts.rui },
          select: { number: true },
        })
      ).map((row) => row.number),
    ),
  );
  const ensureInstruction = async (
    by: Principal,
    body: Record<string, unknown>,
    steps: { by: Principal; kind: "acknowledge" | "action" | "close" | "note"; body?: string }[],
    attachments: ({ documentVersionId: string } | { photoId: string })[],
  ) => {
    if (existingInstructions.has(body["number"] as string)) return;
    created = true;
    const id = uuidv7();
    let entry = (
      await instructionsLog.record(
        by,
        facts.rui,
        recordInstructionRequestSchema.parse({ id, ...body }),
        `seed-${id}`,
        seedRequest,
      )
    ).instruction;
    for (const attachment of attachments)
      entry = (await instructionsLog.attach(by, facts.rui, id, attachment, seedRequest))
        .instruction;
    for (const step of steps)
      entry = (
        await instructionsLog.respond(
          step.by,
          facts.rui,
          id,
          { kind: step.kind, body: step.body ?? null, version: entry.version },
          seedRequest,
        )
      ).instruction;
  };
  await ensureInstruction(
    pm,
    {
      number: "AI-001",
      kind: "architect_instruction",
      issuerName: "Arch. Wanjiru Kamau (synthetic)",
      issuerRole: "architect",
      issuerFirm: "Kamau Associates (synthetic)",
      issuedOn: "2026-09-25",
      receivedOn: "2026-09-26",
      subject: "Revise the first-floor balcony details (synthetic)",
      description:
        "Balcony slab edge to be stepped down 50 mm and the balustrade raised to 1,100 mm as per the revised detail (synthetic).",
      costImplication: true,
      timeImplication: true,
      ...(facts.delayId ? { delayId: facts.delayId } : {}),
    },
    [
      { by: agent, kind: "acknowledge" },
      {
        by: agent,
        kind: "action",
        body: "Balcony edges re-formed and balustrade raised (synthetic)",
      },
      { by: pm, kind: "close" },
    ],
    [{ documentVersionId: rui.get("A-101")!.current.id }],
  );
  await ensureInstruction(
    pm,
    {
      number: "EI-001",
      kind: "engineer_instruction",
      issuerName: "Eng. Otieno Ouma (synthetic)",
      issuerRole: "engineer",
      issuerFirm: "Ouma Consulting Engineers (synthetic)",
      issuedOn: day(-6),
      receivedOn: day(-5),
      subject: "Add two Y16 bars to ground beam GB3 at grid C (synthetic)",
      costImplication: true,
      timeImplication: false,
    },
    [
      { by: agent, kind: "acknowledge" },
      {
        by: agent,
        kind: "note",
        body: "Steel ordered; fixing after the next delivery (synthetic)",
      },
    ],
    [{ documentVersionId: rui.get("S-201")!.current.id }],
  );
  await ensureInstruction(
    agent,
    {
      number: "SI-001",
      kind: "site_instruction",
      issuerName: "Clerk of works, M. Njoroge (synthetic)",
      issuerRole: "other",
      issuedOn: day(-1),
      receivedOn: day(-1),
      subject: "Clear the access road before Friday's concrete pour (synthetic)",
      costImplication: false,
      timeImplication: false,
    },
    [],
    facts.photoId ? [{ photoId: facts.photoId }] : [],
  );

  // Approval requests: one answered on paper, one overdue, one pending.
  const existingApprovals = new Set(
    await read(async (tx) =>
      (
        await tx.approvalRequest.findMany({
          where: { tenantId, projectId: facts.rui },
          select: { title: true },
        })
      ).map((row) => row.title),
    ),
  );
  const ensureApproval = async (
    body: Record<string, unknown>,
    answer?: Record<string, unknown>,
    scan?: DocumentSpec,
  ) => {
    if (existingApprovals.has(body["title"] as string)) return;
    created = true;
    const raised = (
      await approvals.raise(pm, facts.rui, raiseApprovalRequestSchema.parse(body), seedRequest)
    ).approval;
    if (!answer || raised.document.restricted) return;
    // A paper response attaches a scan uploaded after the request was raised.
    const evidence = scan
      ? {
          evidenceVersionId: (await ensureDocument(facts.rui, scan, RUI_DOCUMENTS.length)).current
            .id,
        }
      : {};
    await approvals.respond(
      pm,
      facts.rui,
      raised.id,
      approvalResponseRequestSchema.parse({
        ...answer,
        ...evidence,
        documentSha256: raised.document.sha256,
        version: raised.version,
      }),
      seedRequest,
    );
  };
  await ensureApproval(
    {
      kind: "shop_drawing",
      title: "Steel staircase shop drawing (synthetic)",
      documentVersionId: rui.get("staircase")!.current.id,
      addressedTo: "Arch. Wanjiru Kamau, Kamau Associates (synthetic)",
      sentOn: day(-20),
      dueOn: day(-10),
    },
    {
      decision: "approved_with_comments",
      comments: "Add a handrail bracket every 1.2 m; galvanise all steel (synthetic)",
      respondedOn: day(-9),
      channel: "paper",
      responderName: "Arch. Wanjiru Kamau (synthetic)",
      responderFirm: "Kamau Associates (synthetic)",
    },
    RESPONSE_SCAN,
  );
  await ensureApproval({
    kind: "method_statement",
    title: "Slab formwork method statement (synthetic)",
    documentVersionId: rui.get("formwork")!.current.id,
    addressedTo: "Eng. Otieno Ouma, Ouma Consulting Engineers (synthetic)",
    sentOn: day(-12),
    dueOn: day(-5),
  });
  await ensureApproval({
    kind: "material_sample",
    title: "Ground floor tile sample (synthetic)",
    documentVersionId: rui.get("tiles")!.current.id,
    addressedTo: "Arch. Wanjiru Kamau, Kamau Associates (synthetic)",
    sentOn: day(-2),
    dueOn: day(8),
  });

  // The summary, as the project manager sees it.
  const register = (await compliance.register(
    pm,
    facts.rui,
    seedRequest,
  )) as ComplianceRegisterResponse;
  const list = await documents.list(pm, facts.rui, { status: "all", limit: 100 }, seedRequest);
  const drawings = [];
  for (const row of list.documents.filter((entry) => entry.category === "drawing")) {
    const detail = (await documents.detail(pm, facts.rui, row.id, seedRequest)).document;
    drawings.push({
      number: row.drawingNumber!,
      current: detail.current.revision,
      superseded: detail.versions
        .filter((version) => version.state === "superseded")
        .map((version) => version.revision)
        .reverse(),
    });
  }
  const log = await instructionsLog.list(pm, facts.rui, { limit: 100 }, seedRequest);
  const requests = await approvals.list(pm, facts.rui, { status: "all", limit: 100 }, seedRequest);
  const overview = await app.get(DocumentsOverviewService).overview(owner, seedRequest);
  return {
    created,
    documents: list.total,
    drawings,
    compliance: register.counts,
    reminders: overview.reminders.length,
    instructions: log.instructions
      .map((row) => ({ number: row.number, status: row.status }))
      .sort((a, b) => a.number.localeCompare(b.number)),
    approvals: requests.approvals
      .map((row) => ({ code: row.code, status: row.status, overdue: row.overdue }))
      .sort((a, b) => a.code.localeCompare(b.code)),
  };
}
