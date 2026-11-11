import { describe, expect, it } from "vitest";
import {
  convertQuerySchema,
  createConversionRequestSchema,
  createMaterialRequestSchema,
  createSupplierRequestSchema,
  createUnitRequestSchema,
  proposePayoutRequestSchema,
  quantitySchema,
  recordPriceRequestSchema,
  supplierListQuerySchema,
  supplierRevealRequestSchema,
  updateMaterialRequestSchema,
  updateProcurementSettingsRequestSchema,
  updateSupplierRequestSchema,
} from "./index.js";

const ID = "01900000-0000-7000-8000-000000000001";
const issues = (result: { success: boolean; error?: { issues: { message: string }[] } }) =>
  result.success ? [] : result.error!.issues.map((issue) => issue.message);

describe("D5.1 catalogue schemas", () => {
  it("accepts quantities with up to six decimals and explains refusals", () => {
    for (const value of ["0", "12.5", "0.000001", "1000000000000"])
      expect(quantitySchema.safeParse(value).success, value).toBe(true);
    expect(issues(quantitySchema.safeParse("-1"))).toEqual(["negative_quantity"]);
    expect(issues(quantitySchema.safeParse("1e3"))).toEqual(["invalid_quantity"]);
    expect(issues(quantitySchema.safeParse("1.1234567"))).toEqual(["invalid_quantity"]);
    expect(issues(quantitySchema.safeParse("1000000000001"))).toEqual(["quantity_too_large"]);
  });

  it("validates materials and refuses attributes that do not fit the category", () => {
    const steel = createMaterialRequestSchema.parse({
      name: "Steel bar Y12",
      category: "steel",
      baseUnit: "kg",
      attributes: { diameterMm: 12, pieceLengthM: "12" },
    });
    expect(steel).toMatchObject({ attributes: { diameterMm: 12, pieceLengthM: "12" } });
    expect(
      createMaterialRequestSchema.parse({ name: "Sand", category: "aggregates", baseUnit: "t" })
        .attributes,
    ).toEqual({});
    expect(
      issues(
        createMaterialRequestSchema.safeParse({
          name: "Sand",
          category: "aggregates",
          baseUnit: "t",
          attributes: { diameterMm: 12 },
        }),
      ),
    ).toEqual(["attribute_not_allowed"]);
    expect(
      createMaterialRequestSchema.safeParse({
        name: "Steel bar Y14",
        category: "steel",
        baseUnit: "kg",
        attributes: { diameterMm: 14 },
      }).success,
    ).toBe(false);
    expect(
      createMaterialRequestSchema.safeParse({
        name: "Mabati",
        category: "roofing",
        baseUnit: "m",
        attributes: { gauge: 31 },
      }).success,
    ).toBe(false);
    expect(
      createMaterialRequestSchema.safeParse({
        name: "Sand",
        category: "aggregates",
        baseUnit: "t",
        tenantId: ID,
      }).success,
    ).toBe(false);
    expect(
      createMaterialRequestSchema.safeParse({
        name: "Sand\u0007",
        category: "aggregates",
        baseUnit: "t",
      }).success,
    ).toBe(false);
    expect(updateMaterialRequestSchema.safeParse({ version: 1, status: "archived" }).success).toBe(
      true,
    );
    expect(updateMaterialRequestSchema.safeParse({ status: "archived" }).success).toBe(false);
  });

  it("requires positive factors and refuses negative or zero quantities", () => {
    const valid = { fromUnit: "trip", fromQuantity: "1", toUnit: "t", toQuantity: "7" };
    expect(createConversionRequestSchema.parse(valid)).toMatchObject({ supplierId: null });
    expect(createConversionRequestSchema.safeParse({ ...valid, toQuantity: "0" }).success).toBe(
      false,
    );
    expect(createConversionRequestSchema.safeParse({ ...valid, toQuantity: "-7" }).success).toBe(
      false,
    );
    expect(createConversionRequestSchema.safeParse({ ...valid, fromUnit: "Trip" }).success).toBe(
      false,
    );
    expect(createConversionRequestSchema.safeParse({ ...valid, materialId: ID }).success).toBe(
      false,
    );
  });

  it("validates company units (sized units need a size, packages must not have one)", () => {
    expect(
      createUnitRequestSchema.parse({
        code: "Debe",
        name: "Debe (20 l)",
        dimension: "volume",
        equalsQuantity: "20",
        equalsUnit: "l",
      }),
    ).toMatchObject({ code: "debe" });
    expect(
      createUnitRequestSchema.safeParse({ code: "x", name: "X", dimension: "package" }).success,
    ).toBe(false);
    expect(
      createUnitRequestSchema.parse({ code: "karai", name: "Karai", dimension: "package" }),
    ).toMatchObject({ equalsQuantity: null, equalsUnit: null });
  });

  it("accepts calculator queries and records prices in minor units", () => {
    expect(convertQuerySchema.safeParse({ from: "trip", to: "t", quantity: "3" }).success).toBe(
      true,
    );
    expect(
      convertQuerySchema.safeParse({ from: "trip", to: "t", quantity: "3", extra: "1" }).success,
    ).toBe(false);
    const price = {
      supplierId: ID,
      unit: "bag_50kg",
      unitPriceMinor: 78_000,
      vatTreatment: "inclusive",
      effectiveOn: "2026-11-15",
    };
    expect(recordPriceRequestSchema.safeParse(price).success).toBe(true);
    expect(recordPriceRequestSchema.safeParse({ ...price, unitPriceMinor: 0 }).success).toBe(false);
    expect(recordPriceRequestSchema.safeParse({ ...price, unitPriceMinor: 780.5 }).success).toBe(
      false,
    );
    expect(recordPriceRequestSchema.safeParse({ ...price, source: "invoice" }).success).toBe(false);
    expect(
      updateProcurementSettingsRequestSchema.safeParse({
        priceChangeAlertPercent: "12.5",
        version: 0,
      }).success,
    ).toBe(true);
    for (const value of ["0", "-5", "1001", "abc", "10.12345"])
      expect(
        updateProcurementSettingsRequestSchema.safeParse({
          priceChangeAlertPercent: value,
          version: 0,
        }).success,
        value,
      ).toBe(false);
  });
});

describe("D5.1 supplier schemas", () => {
  it("normalises KRA PINs and Kenyan phones and refuses invalid ones", () => {
    const supplier = createSupplierRequestSchema.parse({
      legalName: "Mlolongo Quarry Supplies Ltd",
      kraPin: "p051 234 567q",
      contacts: [{ name: "Achieng", phone: "0712 345 678", primary: true }],
    });
    expect(supplier).toMatchObject({
      kraPin: "P051234567Q",
      etimsStatus: "unknown",
      creditDays: 0,
      contacts: [{ phone: "254712345678", primary: true }],
    });
    expect(
      issues(createSupplierRequestSchema.safeParse({ legalName: "X Ltd", kraPin: "B051234567Q" })),
    ).toEqual(["invalid_kra_pin"]);
    expect(
      createSupplierRequestSchema.safeParse({
        legalName: "X Ltd",
        contacts: [{ name: "Juma", phone: "0612" }],
      }).success,
    ).toBe(false);
    expect(
      issues(
        createSupplierRequestSchema.safeParse({
          legalName: "X Ltd",
          contacts: [
            { name: "Juma", primary: true },
            { name: "Wafula", primary: true },
          ],
        }),
      ),
    ).toEqual(["one_primary_contact"]);
    expect(
      createSupplierRequestSchema.safeParse({ legalName: "X Ltd", creditDays: 400 }).success,
    ).toBe(false);
  });

  it("requires a reason to put a supplier on hold or block it", () => {
    expect(
      issues(updateSupplierRequestSchema.safeParse({ version: 1, status: "blocked" })),
    ).toEqual(["reason_required"]);
    expect(
      updateSupplierRequestSchema.safeParse({
        version: 1,
        status: "blocked",
        statusReason: "Short deliveries",
      }).success,
    ).toBe(true);
    expect(updateSupplierRequestSchema.safeParse({ version: 1, status: "active" }).success).toBe(
      true,
    );
    // The database needs at least three characters: a shorter reason is a 400, not a 500.
    for (const statusReason of ["ab", "  x  ", "🧱🧱"])
      expect(
        updateSupplierRequestSchema.safeParse({ version: 1, status: "blocked", statusReason })
          .success,
        statusReason,
      ).toBe(false);
    expect(updateSupplierRequestSchema.safeParse({ version: 1, statusReason: "ab" }).success).toBe(
      false,
    );
    expect(updateSupplierRequestSchema.safeParse({ version: 1, statusReason: "Bad" }).success).toBe(
      true,
    );
    // Names are counted in characters (code points) as PostgreSQL does: one emoji is too short.
    expect(createSupplierRequestSchema.safeParse({ legalName: "🧱" }).success).toBe(false);
    expect(createSupplierRequestSchema.safeParse({ legalName: "🧱🧱" }).success).toBe(true);
    // An existing contact keeps its phone when none is sent.
    expect(
      updateSupplierRequestSchema.parse({ version: 1, contacts: [{ id: ID, name: "Juma" }] })
        .contacts?.[0],
    ).not.toHaveProperty("phone");
  });

  it("checks payout channels: Paybill needs an account reference, Till never has one", () => {
    const base = { replaces: null };
    expect(
      proposePayoutRequestSchema.safeParse({
        ...base,
        mpesaKind: "paybill",
        paybillNumber: "247247",
        accountReference: "JENGA-01",
      }).success,
    ).toBe(true);
    expect(
      issues(
        proposePayoutRequestSchema.safeParse({
          ...base,
          mpesaKind: "paybill",
          paybillNumber: "247247",
        }),
      ),
    ).toEqual(["required"]);
    expect(
      proposePayoutRequestSchema.safeParse({ ...base, mpesaKind: "till", tillNumber: "5123456" })
        .success,
    ).toBe(true);
    expect(
      issues(
        proposePayoutRequestSchema.safeParse({
          ...base,
          mpesaKind: "till",
          tillNumber: "5123456",
          accountReference: "X1",
        }),
      ),
    ).toEqual(["not_allowed"]);
    expect(issues(proposePayoutRequestSchema.safeParse({ ...base, mpesaKind: "none" }))).toEqual([
      "payout_channel_required",
    ]);
    expect(
      proposePayoutRequestSchema.safeParse({ ...base, mpesaKind: "till", tillNumber: "51234567" })
        .success,
    ).toBe(false);
    const bank = proposePayoutRequestSchema.parse({
      ...base,
      mpesaKind: "none",
      bank: {
        bankName: "Equity Bank",
        accountName: "Mlolongo Quarry Supplies Ltd",
        accountNumber: "0123 4567 8912 34",
      },
    });
    expect(bank.bank?.accountNumber).toBe("01234567891234");
    expect(
      proposePayoutRequestSchema.safeParse({
        ...base,
        mpesaKind: "none",
        bank: { bankName: "Equity", accountName: "X Ltd", accountNumber: "12" },
      }).success,
    ).toBe(false);
  });

  it("requires the target of a reveal and exact-match lookups in valid formats", () => {
    expect(supplierRevealRequestSchema.safeParse({ field: "kraPin" }).success).toBe(true);
    expect(supplierRevealRequestSchema.safeParse({ field: "contactPhone" }).success).toBe(false);
    expect(
      supplierRevealRequestSchema.safeParse({ field: "accountNumber", payoutId: ID }).success,
    ).toBe(true);
    expect(supplierRevealRequestSchema.safeParse({ field: "password" }).success).toBe(false);
    expect(
      supplierListQuerySchema.parse({ kraPin: "p051234567q", phone: "0712345678" }),
    ).toMatchObject({ kraPin: "P051234567Q", phone: "254712345678", limit: 50 });
    expect(supplierListQuerySchema.safeParse({ kraPin: "123" }).success).toBe(false);
  });
});
