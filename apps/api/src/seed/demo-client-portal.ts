import { randomBytes, randomUUID } from "node:crypto";
import type { INestApplicationContext } from "@nestjs/common";
import type { Request } from "express";
import sharp from "sharp";
import { nairobiDate } from "@pm-buddy/domain";
import {
  createFxRateRequestSchema,
  createInstructionRequestSchema,
  createVariationRequestSchema,
  recordClientPaymentRequestSchema,
  saveVariationLinesRequestSchema,
  sendVariationToClientRequestSchema,
  updatePaymentInstructionsRequestSchema,
  updateClientSettingsRequestSchema,
} from "@pm-buddy/validation";
import { uuidv7 } from "../common/uuid.js";
import { PrismaService } from "../infra/prisma.service.js";
import { InstructionsService } from "../modules/bq/instructions.service.js";
import { VariationsService } from "../modules/bq/variations.service.js";
import { hashPassword } from "../modules/identity/auth-security.service.js";
import { TenantDatabase } from "../modules/identity/tenant-database.service.js";
import { ClientCompanyService } from "../modules/portals/client/client-company.service.js";
import { ClientPaymentsService } from "../modules/portals/client/client-payments.service.js";
import { ClientVariationsService } from "../modules/portals/client/client-variations.service.js";
import { PhotosService } from "../modules/progress/photos.service.js";
import { seedPrincipal } from "./demo-procure-to-pay.js";

/**
 * D7.1 demo data (synthetic): the client portal account of Mavuno Homes Ltd (the Ruiru Heights
 * client), assigned to RUI-HTS with the `client` role and showing amounts in GBP as well as KES;
 * the company's Paybill instructions (Safaricom's public sandbox shortcode 174379, never a live
 * Paybill) and indicative USD/GBP/EUR rates marked synthetic; RUI-HTS's client terms (variations
 * wait for the client; 14 days to pay); a part payment recorded by finance against IPC-0001; an
 * unverified photo (no GPS or capture time in it) beside the verified measurement photos; and a
 * variation submitted by the project manager and sent to the client, awaiting their decision.
 * Everything goes through the real services and database rules. Idempotent: each part is skipped
 * when present.
 */
export const DEMO_CLIENT_USER = {
  identifier: "client@mavuno-homes.example.test",
  displayName: "Joseph Kariuki (Mavuno Homes, synthetic)",
} as const;
const DEMO_VARIATION_TITLE = "Additional visitor parking slab (synthetic)";

export type ClientPortalSeedSummary = {
  created: boolean;
  account: {
    identifier: string;
    displayName: string;
    /** Set when this run created the account or reset its credentials; otherwise unchanged. */
    password: string | null;
    created: boolean;
  };
  project: string;
  displayCurrency: string;
  paybill: string | null;
  rates: string[];
  receipts: number;
  variation: { number: string; state: string } | null;
};

type SeedUsers = {
  ownerId: string;
  projectManagerId: string;
  siteAgentId: string;
  financeId: string;
};

const seedRequest = { headers: {} } as Request;
const newPassword = () => `Demo-${randomBytes(18).toString("base64url")}`;
const RATES = [
  { currency: "USD", kesPerUnit: "129.45" },
  { currency: "GBP", kesPerUnit: "170.10" },
  { currency: "EUR", kesPerUnit: "150.30" },
] as const;

/** A JPEG without GPS or capture time: the server cannot verify where or when it was taken. */
const unverifiedPhoto = () =>
  sharp({
    create: { width: 96, height: 72, channels: 3, background: { r: 140, g: 132, b: 120 } },
  })
    .jpeg()
    .withExif({ IFD0: { ImageDescription: `Blockwork delivery ${uuidv7()}` } })
    .toBuffer();

export async function seedClientPortal(
  app: INestApplicationContext,
  tenantId: string,
  users: SeedUsers,
  options: { resetCredentials?: boolean } = {},
): Promise<ClientPortalSeedSummary> {
  const prisma = app.get(PrismaService);
  const db = app.get(TenantDatabase);
  const asOwner = <T>(
    work: (tx: Parameters<Parameters<TenantDatabase["run"]>[1]>[0]) => Promise<T>,
  ) => db.run({ userId: users.ownerId, tenantId, requestId: "seed" }, work);
  const today = nairobiDate();

  // The client's account (password printed once, like the other demo accounts).
  const existing = await prisma.user.findUnique({
    where: { identifier: DEMO_CLIENT_USER.identifier },
  });
  const reset = !existing || options.resetCredentials === true;
  const password = reset ? newPassword() : null;
  const account =
    existing ??
    (await prisma.user.create({
      data: {
        id: randomUUID(),
        identifier: DEMO_CLIENT_USER.identifier,
        displayName: DEMO_CLIENT_USER.displayName,
        passwordHash: await hashPassword(password!),
        verifiedAt: new Date(),
      },
    }));
  if (existing && password) {
    await prisma.user.update({
      where: { id: account.id },
      data: { passwordHash: await hashPassword(password), failedLogins: 0, lockedUntil: null },
    });
    await prisma.session.updateMany({
      where: { userId: account.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  const rui = await asOwner((tx) =>
    tx.project.findFirstOrThrow({
      where: { tenantId, code: "RUI-HTS" },
      include: { sites: { select: { id: true, name: true } } },
    }),
  );
  // Membership with the client role, assigned to RUI-HTS (the client's permissions only).
  const joined = await asOwner(async (tx) => {
    await tx.$queryRaw`SELECT tenant_id FROM tenants WHERE tenant_id = ${tenantId}::uuid FOR UPDATE`;
    const member = await tx.membership.findUnique({
      where: { tenantId_userId: { tenantId, userId: account.id } },
    });
    if (member) return false;
    await tx.membership.create({ data: { tenantId, userId: account.id, role: "client" } });
    await tx.projectMembership.create({
      data: {
        tenantId,
        projectId: rui.id,
        userId: account.id,
        permissions: ["projects.view", "bq.view", "portal.client"],
      },
    });
    await tx.auditEvent.create({
      data: {
        tenantId,
        actorId: users.ownerId,
        requestId: "seed",
        action: "membership.joined",
        resourceId: account.id,
        metadata: { source: "seed", role: "client" },
      },
    });
    return true;
  });
  // The client prefers to see pounds as well (their own row; RLS lets only them write it).
  await db.run({ userId: account.id, tenantId, requestId: "seed" }, async (tx) => {
    if (
      !(await tx.clientPreference.findUnique({
        where: { tenantId_userId: { tenantId, userId: account.id } },
      }))
    )
      await tx.clientPreference.create({
        data: { tenantId, userId: account.id, displayCurrency: "GBP" },
      });
  });

  const owner = await seedPrincipal(prisma, users.ownerId, tenantId);
  const pm = await seedPrincipal(prisma, users.projectManagerId, tenantId);
  const agent = await seedPrincipal(prisma, users.siteAgentId, tenantId);
  const finance = await seedPrincipal(prisma, users.financeId, tenantId);
  const company = app.get(ClientCompanyService);
  const payments = app.get(ClientPaymentsService);

  // The Paybill instructions (owner, config.manage with step-up) and indicative rates (finance).
  const instructions = await company.instructions(owner, seedRequest);
  if (!instructions.instructions)
    await company.updateInstructions(
      owner,
      updatePaymentInstructionsRequestSchema.parse({
        version: 0,
        paybillNumber: "174379",
        tillNumber: null,
        accountName: "Jenga Bora Builders Ltd (sandbox Paybill, synthetic)",
        accountFormat: "project_certificate",
        bankInstructions:
          "Bank transfer: Demo Bank Kenya, Ruiru branch, account 0000000000 (synthetic). Quote the account reference.",
      }),
      seedRequest,
    );
  const rates = await company.rates(owner, seedRequest);
  for (const rate of RATES)
    if (!rates.rates.some((row) => row.currency === rate.currency && row.rateDate === today))
      await company.createRate(
        finance,
        createFxRateRequestSchema.parse({
          ...rate,
          rateDate: today,
          source: "Synthetic demo rate (not a market quote)",
        }),
        seedRequest,
      );

  // RUI-HTS's client terms: variations wait for the client's approval; 14 days to pay.
  let view = await payments.view(finance, rui.id, seedRequest);
  if (view.settings.version === 0)
    view = await payments.updateSettings(
      pm,
      rui.id,
      updateClientSettingsRequestSchema.parse({
        version: 0,
        clientApprovalRequired: true,
        paymentTermsDays: 14,
      }),
      seedRequest,
    );
  // A part payment against the first certificate, recorded by finance (M-Pesa Paybill).
  const first = view.certificates.find((row) => row.kind === "interim");
  if (first && !view.payments.length) {
    const amountMinor = Math.floor((first.totalMinor * 0.6) / 100_000) * 100_000;
    if (amountMinor > 0)
      view = await payments.record(
        finance,
        rui.id,
        recordClientPaymentRequestSchema.parse({
          id: uuidv7(),
          valuationId: first.id,
          amountMinor,
          receivedOn: today,
          method: "mpesa_paybill",
          reference: "SKD7Q3X9ZT",
          note: "Part payment of IPC-0001 (synthetic M-Pesa receipt)",
        }),
        `seed-client-receipt-${first.id}`,
        seedRequest,
      );
  }

  // An unverified photo beside the verified measurement photos (no GPS or capture time in it).
  const site = rui.sites.find((row) => row.name === "Materials yard") ?? rui.sites[0]!;
  const unverified = await asOwner((tx) =>
    tx.sitePhoto.count({
      where: { tenantId, projectId: rui.id, purpose: "general", verified: false },
    }),
  );
  if (!unverified)
    await app
      .get(PhotosService)
      .upload(
        agent,
        rui.id,
        { buffer: await unverifiedPhoto(), originalname: "delivery.jpg", size: 1 },
        { siteId: site.id, caption: "Blockwork delivered to the materials yard" },
        seedRequest,
      );

  // A variation submitted by the project manager and sent to the client for a decision.
  const variations = app.get(VariationsService);
  const sending = app.get(ClientVariationsService);
  let variation = await asOwner((tx) =>
    tx.variationOrder.findFirst({
      where: { tenantId, projectId: rui.id, title: DEMO_VARIATION_TITLE },
    }),
  );
  if (!variation) {
    let instruction = await asOwner((tx) =>
      tx.instruction.findFirst({
        where: { tenantId, projectId: rui.id, status: { not: "closed" } },
        orderBy: { issuedOn: "asc" },
      }),
    );
    if (!instruction) {
      const created = await app.get(InstructionsService).create(
        pm,
        rui.id,
        createInstructionRequestSchema.parse({
          number: "AI-D71",
          issuedOn: today,
          issuerName: "Arch. Wanjiku Mbugua (synthetic)",
          issuerRole: "architect",
          subject: "Visitor parking at the gate",
        }),
        seedRequest,
      );
      instruction = await asOwner((tx) =>
        tx.instruction.findFirstOrThrow({ where: { tenantId, id: created.instruction.id } }),
      );
    }
    const bill = await asOwner(async (tx) => {
      const version = await tx.bqVersion.findFirstOrThrow({
        where: { tenantId, projectId: rui.id, status: "approved" },
        orderBy: { versionNo: "desc" },
      });
      return (
        (await tx.bqBill.findFirst({
          where: { tenantId, versionId: version.id, kind: "measured" },
          orderBy: { sortOrder: "asc" },
        })) ??
        (await tx.bqBill.findFirstOrThrow({
          where: { tenantId, versionId: version.id },
          orderBy: { sortOrder: "asc" },
        }))
      );
    });
    let detail = (
      await variations.create(
        pm,
        rui.id,
        createVariationRequestSchema.parse({
          instructionId: instruction.id,
          title: DEMO_VARIATION_TITLE,
          description: "A 40 m² visitor parking slab inside the gate, requested by the client.",
        }),
        seedRequest,
      )
    ).variation;
    detail = (
      await variations.saveLines(
        pm,
        rui.id,
        detail.id,
        saveVariationLinesRequestSchema.parse({
          version: detail.version,
          lines: [
            {
              action: "add",
              billLineageId: bill.lineageId,
              newSection: { title: "Variations (synthetic)" },
              ref: "V1",
              description: "Concrete class 25 slab, 150 mm, with A142 mesh (synthetic)",
              unit: "m2",
              kind: "measured",
              quantity: "40",
              rate: "2850",
            },
          ],
        }),
        seedRequest,
      )
    ).variation;
    detail = (
      await variations.submit(pm, rui.id, detail.id, { version: detail.version }, seedRequest)
    ).variation;
    await sending.send(
      pm,
      rui.id,
      detail.id,
      sendVariationToClientRequestSchema.parse({
        version: detail.version,
        snapshotDigest: detail.snapshot!.digest,
        message: "Please review the parking slab you asked for (synthetic).",
      }),
      seedRequest,
    );
    variation = await asOwner((tx) =>
      tx.variationOrder.findFirstOrThrow({ where: { tenantId, id: detail.id } }),
    );
  }
  const sent = await sending.view(pm, rui.id, variation.id, seedRequest);
  const latestView = await payments.view(finance, rui.id, seedRequest);
  return {
    created: joined,
    account: {
      identifier: DEMO_CLIENT_USER.identifier,
      displayName: DEMO_CLIENT_USER.displayName,
      password,
      created: !existing,
    },
    project: rui.code,
    displayCurrency: "GBP",
    paybill: (await company.instructions(owner, seedRequest)).instructions?.paybillNumber ?? null,
    rates: (await company.rates(owner, seedRequest)).current.flatMap((row) =>
      row.rate ? [`${row.currency} ${row.rate.kesPerUnit}`] : [],
    ),
    receipts: latestView.payments.length,
    variation: sent.requests[0]
      ? { number: variation.number, state: sent.requests[0].state }
      : null,
  };
}
