import type { INestApplicationContext } from "@nestjs/common";
import type { ProposePayoutRequest, RecordPriceRequest } from "@pm-buddy/validation";
import { AccessPolicy, type Scope } from "../modules/identity/access-policy.js";
import type { Principal } from "../modules/identity/auth.service.js";
import { TenantDatabase } from "../modules/identity/tenant-database.service.js";
import { ConversionsService } from "../modules/procurement/conversions.service.js";
import { PayoutsService } from "../modules/procurement/payouts.service.js";
import { PricesService } from "../modules/procurement/prices.service.js";
import { businessToday } from "../modules/procurement/catalogue-store.js";
import { loadStarterCatalogue } from "../modules/procurement/starter-catalogue.js";
import { SuppliersService } from "../modules/procurement/suppliers.service.js";

/**
 * D5.1 demo data for the synthetic company: the Kenyan starter catalogue, three suppliers with
 * synthetic identifiers, supplier lorry-trip factors, a price history with one alert, and payout
 * details (one verified by the finance user, one pending so the maker-checker flow can be shown).
 * KRA PINs are all-zero synthetic values, the phone is Safaricom's public Daraja sandbox test
 * MSISDN, and the Paybill/Till are Daraja sandbox shortcodes: nothing reaches a real person.
 */

type DemoPrice = Omit<RecordPriceRequest, "supplierId"> & { material: string };
type DemoSupplier = {
  legalName: string;
  tradingName: string;
  kraPin: string | null;
  etimsStatus: "registered" | "unknown" | "not_registered";
  creditDays: number;
  creditLimitMinor: number | null;
  status?: { status: "on_hold"; reason: string };
  contact: { name: string; role: string; phone: string | null; email: string } | null;
  trips: { material: string; tonnes: string; note: string }[];
  prices: DemoPrice[];
  payout: (ProposePayoutRequest & { verify: boolean }) | null;
};

/** Safaricom's documented Daraja sandbox test MSISDN (not a person's number). */
export const DEMO_TEST_MSISDN = "254708374149";

export const DEMO_SUPPLIERS: readonly DemoSupplier[] = [
  {
    legalName: "Mlolongo Quarry Supplies Ltd (synthetic)",
    tradingName: "Mlolongo Quarry (synthetic)",
    kraPin: "P000000001Z",
    etimsStatus: "registered",
    creditDays: 30,
    creditLimitMinor: 50_000_000,
    contact: {
      name: "Achieng Otieno (synthetic)",
      role: "Sales",
      phone: DEMO_TEST_MSISDN,
      email: "sales@mlolongo-quarry.example.test",
    },
    trips: [
      { material: "River sand", tonnes: "7", note: "7-tonne lorry, weighed at the quarry (demo)" },
      { material: "Ballast 20 mm", tonnes: "10", note: "10-tonne lorry (demo)" },
    ],
    prices: [
      {
        material: "River sand",
        unit: "trip",
        unitPriceMinor: 2_800_000,
        vatTreatment: "not_applicable",
        effectiveOn: "2026-10-01",
      },
      {
        material: "River sand",
        unit: "trip",
        unitPriceMinor: 3_000_000,
        vatTreatment: "not_applicable",
        effectiveOn: "2026-11-02",
      },
      {
        material: "Ballast 20 mm",
        unit: "t",
        unitPriceMinor: 220_000,
        vatTreatment: "not_applicable",
        effectiveOn: "2026-10-01",
      },
    ],
    payout: {
      replaces: null,
      mpesaKind: "paybill",
      paybillNumber: "600000",
      accountReference: "JENGA-BORA",
      tillNumber: null,
      bank: null,
      verify: true,
    },
  },
  {
    legalName: "Athi River Steel & Hardware Ltd (synthetic)",
    tradingName: "Athi River Steel (synthetic)",
    kraPin: "P000000002Z",
    etimsStatus: "registered",
    creditDays: 14,
    creditLimitMinor: 200_000_000,
    contact: {
      name: "Peter Mwangi (synthetic)",
      role: "Accounts",
      phone: null,
      email: "accounts@athi-steel.example.test",
    },
    trips: [],
    prices: [
      {
        material: "Cement 42.5N (50 kg bag)",
        unit: "bag_50kg",
        unitPriceMinor: 78_000,
        vatTreatment: "inclusive",
        effectiveOn: "2026-09-01",
      },
      {
        material: "Cement 42.5N (50 kg bag)",
        unit: "bag_50kg",
        unitPriceMinor: 80_000,
        vatTreatment: "inclusive",
        effectiveOn: "2026-10-15",
      },
      {
        material: "Cement 42.5N (50 kg bag)",
        unit: "bag_50kg",
        unitPriceMinor: 90_000,
        vatTreatment: "inclusive",
        effectiveOn: "2026-11-05",
      },
      {
        material: "Steel bar Y12 (high yield, 12 m)",
        unit: "nr",
        unitPriceMinor: 125_000,
        vatTreatment: "inclusive",
        effectiveOn: "2026-10-01",
      },
      {
        material: "Steel bar Y12 (high yield, 12 m)",
        unit: "t",
        unitPriceMinor: 11_800_000,
        vatTreatment: "inclusive",
        effectiveOn: "2026-11-01",
      },
    ],
    payout: {
      replaces: null,
      mpesaKind: "till",
      paybillNumber: null,
      accountReference: null,
      tillNumber: "174379",
      bank: {
        bankName: "Equity Bank (synthetic)",
        branch: "Athi River",
        accountName: "Athi River Steel & Hardware Ltd",
        accountNumber: "0000000000002",
      },
      verify: false,
    },
  },
  {
    legalName: "Kitengela Hardware Stores (synthetic)",
    tradingName: "Kitengela Hardware (synthetic)",
    kraPin: null,
    etimsStatus: "unknown",
    creditDays: 0,
    creditLimitMinor: null,
    status: { status: "on_hold", reason: "Awaiting KRA PIN and eTIMS confirmation (demo)" },
    contact: null,
    trips: [],
    prices: [],
    payout: null,
  },
];

export type ProcurementSeedSummary = {
  materials: { created: number; existing: number };
  suppliers: { code: string; name: string; created: boolean }[];
};

export async function seedProcurement(
  app: INestApplicationContext,
  tenantId: string,
  ownerId: string,
  financeId: string,
): Promise<ProcurementSeedSummary> {
  const db = app.get(TenantDatabase);
  const policy = app.get(AccessPolicy);
  const suppliers = app.get(SuppliersService);
  const conversions = app.get(ConversionsService);
  const prices = app.get(PricesService);
  const payouts = app.get(PayoutsService);
  // Seed writes run as the owner (or the finance user for verification) with their real access;
  // permission checks live in the public service methods, which the development seed bypasses.
  const scopeFor = async (tx: Scope["tx"], userId: string): Promise<Scope> => {
    const access = await policy.load(tx, tenantId, userId);
    if (!access) throw new Error("Seed user is not a member of the demo company");
    return { tx, access, principal: undefined as unknown as Principal };
  };

  const toVerify: { supplierId: string; payoutId: string }[] = [];
  const summary = await db.run(
    { userId: ownerId, tenantId, requestId: "seed" },
    async (tx) => {
      await tx.$queryRaw`SELECT tenant_id FROM tenants WHERE tenant_id = ${tenantId}::uuid FOR UPDATE`;
      const scope = await scopeFor(tx, ownerId);
      const loaded = await loadStarterCatalogue(tx, tenantId, ownerId, businessToday());
      const materials = new Map(
        (await tx.material.findMany({ where: { tenantId } })).map((row) => [row.name, row]),
      );
      const seeded: ProcurementSeedSummary["suppliers"] = [];
      for (const demo of DEMO_SUPPLIERS) {
        const existing = await tx.supplier.findFirst({
          where: { tenantId, legalName: demo.legalName },
        });
        if (existing) {
          seeded.push({ code: existing.code, name: demo.tradingName, created: false });
          continue;
        }
        const supplierId = await suppliers.createInScope(scope, {
          legalName: demo.legalName,
          tradingName: demo.tradingName,
          kraPin: demo.kraPin,
          etimsStatus: demo.etimsStatus,
          etimsCheckedOn: demo.etimsStatus === "registered" ? "2026-11-01" : null,
          creditDays: demo.creditDays,
          creditLimitMinor: demo.creditLimitMinor,
          notes: "Synthetic demo supplier.",
          contacts: demo.contact
            ? [
                {
                  name: demo.contact.name,
                  role: demo.contact.role,
                  phone: demo.contact.phone,
                  email: demo.contact.email,
                  primary: true,
                },
              ]
            : [],
        });
        if (demo.status)
          await tx.supplier.update({
            where: { tenantId_id: { tenantId, id: supplierId } },
            data: {
              status: demo.status.status,
              statusReason: demo.status.reason,
              version: { increment: 1 },
            },
          });
        for (const trip of demo.trips)
          await conversions.createInScope(scope, materials.get(trip.material)!.id, {
            supplierId,
            fromUnit: "trip",
            fromQuantity: "1",
            toUnit: "t",
            toQuantity: trip.tonnes,
            effectiveFrom: "2026-09-01",
            note: trip.note,
          });
        for (const { material, ...price } of demo.prices)
          await prices.recordInScope(
            scope,
            materials.get(material)!.id,
            { ...price, supplierId },
            null,
          );
        if (demo.payout) {
          const { verify, ...proposal } = demo.payout;
          const payoutId = await payouts.proposeInScope(scope, supplierId, proposal);
          if (verify) toVerify.push({ supplierId, payoutId });
        }
        const row = await tx.supplier.findUniqueOrThrow({
          where: { tenantId_id: { tenantId, id: supplierId } },
        });
        seeded.push({ code: row.code, name: demo.tradingName, created: true });
      }
      return {
        materials: { created: loaded.created, existing: loaded.existing },
        suppliers: seeded,
      };
    },
    60_000,
  );

  // Independent verification by a different person (maker-checker), as the finance user.
  for (const { supplierId, payoutId } of toVerify)
    await db.run({ userId: financeId, tenantId, requestId: "seed" }, async (tx) => {
      const scope = await scopeFor(tx, financeId);
      await payouts.verifyInScope(scope, supplierId, payoutId, {
        method: "call_back_known_number",
        note: "Called the supplier on the number already on file (demo data).",
      });
    });
  return summary;
}
