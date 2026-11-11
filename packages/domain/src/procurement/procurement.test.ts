import { describe, expect, it } from "vitest";
import {
  assessDeliveryLocation,
  checkProcurementTransition,
  classifyEtimsInvoiceNumber,
  documentTotals,
  INVOICE_TRANSITIONS,
  invoiceNumberKey,
  LPO_TRANSITIONS,
  lineNetAmountMinor,
  netPricePerBase,
  normaliseVehicleRegistration,
  perBaseMinor,
  REQUISITION_TRANSITIONS,
  RFQ_TRANSITIONS,
  allowedActions,
  statusChanges,
  Ratio,
  type Geofence,
} from "../index.js";

/** Hand-worked figures; see each comment. */
describe("procure-to-pay amounts", () => {
  it("prices net of VAT per base unit exactly and rounds each line once", () => {
    // Cement KES 900 per 50 kg bag, VAT inclusive at 16 %: net per bag = 90,000 × 100 / 116 =
    // 77,586.2068…; per kg (1/50 bag) = 1,551.7241379… minor units.
    const perKg = netPricePerBase(90_000, "inclusive", "16", Ratio.of(1, 50));
    expect(perBaseMinor(perKg)).toBe("1551.724138");
    // 150 kg = 3 bags: 27,000,000 / 116 = 232,758.62… → 232,759 (half-up once).
    expect(lineNetAmountMinor("150", perKg)).toBe(232_759);
    // Exclusive and not-applicable prices are already net.
    expect(perBaseMinor(netPricePerBase(200_000, "exclusive", "16", Ratio.ONE))).toBe("200000");
    expect(perBaseMinor(netPricePerBase(400_000, "not_applicable", "16", Ratio.of(1, 7)))).toBe(
      "57142.857143",
    );
  });

  it("charges VAT once on the VAT-able subtotal", () => {
    // 232,759 × 16 % = 37,241.44 → 37,241; the gross 2,700.00 of three bags is preserved.
    expect(
      documentTotals(
        [
          { netAmountMinor: 232_759, vatable: true },
          { netAmountMinor: 100_000, vatable: false },
        ],
        "16",
      ),
    ).toEqual({ subtotalMinor: 332_759, vatableMinor: 232_759, vatMinor: 37_241, totalMinor: 370_000 });
    // Half-up on the tie: 5 × 10 % = 0.5 → 1.
    expect(documentTotals([{ netAmountMinor: 5, vatable: true }], "10").vatMinor).toBe(1);
    expect(() => documentTotals([{ netAmountMinor: -1, vatable: true }], "16")).toThrow(RangeError);
  });
});

describe("procure-to-pay state machines", () => {
  it("follow WORKFLOWS for requisitions, RFQs, LPOs and invoices", () => {
    expect(checkProcurementTransition(REQUISITION_TRANSITIONS, "draft", "submit")).toEqual({
      ok: true,
      to: "submitted",
    });
    expect(checkProcurementTransition(REQUISITION_TRANSITIONS, "draft", "approve")).toEqual({
      ok: false,
      error: "invalid_transition",
    });
    expect(checkProcurementTransition(REQUISITION_TRANSITIONS, "submitted", "reject", " no")).toEqual(
      { ok: false, error: "reason_required" },
    );
    expect(checkProcurementTransition(REQUISITION_TRANSITIONS, "approved", "reopen")).toEqual({
      ok: true,
      to: "draft",
    });
    expect(checkProcurementTransition(REQUISITION_TRANSITIONS, "ordered", "cancel", "late")).toEqual(
      { ok: false, error: "invalid_transition" },
    );
    expect(checkProcurementTransition(RFQ_TRANSITIONS, "awarded", "reopen")).toEqual({
      ok: true,
      to: "open",
    });
    expect(checkProcurementTransition(LPO_TRANSITIONS, "approved", "return", "price")).toEqual({
      ok: false,
      error: "invalid_transition",
    });
    expect(checkProcurementTransition(LPO_TRANSITIONS, "approved", "cancel", "reissue")).toEqual({
      ok: true,
      to: "cancelled",
    });
    expect(checkProcurementTransition(INVOICE_TRANSITIONS, "disputed", "approve")).toEqual({
      ok: false,
      error: "invalid_transition",
    });
    expect(checkProcurementTransition(INVOICE_TRANSITIONS, "approved", "cancel", "oops")).toEqual({
      ok: false,
      error: "invalid_transition",
    });
    expect(allowedActions(INVOICE_TRANSITIONS, "matched")).toEqual([
      "match",
      "dispute",
      "reopen",
      "approve",
      "cancel",
    ]);
  });

  it("lists the status changes the database triggers accept", () => {
    expect(statusChanges(REQUISITION_TRANSITIONS)).toEqual([
      ["draft", "submitted"],
      ["submitted", "approved"],
      ["submitted", "rejected"],
      ["rejected", "draft"],
      ["submitted", "draft"],
      ["approved", "draft"],
      ["draft", "cancelled"],
      ["submitted", "cancelled"],
      ["approved", "ordered"],
      ["ordered", "approved"],
    ]);
    expect(statusChanges(INVOICE_TRANSITIONS)).toContainEqual(["matched", "disputed"]);
    expect(statusChanges(INVOICE_TRANSITIONS)).not.toContainEqual(["disputed", "approved"]);
    expect(statusChanges(INVOICE_TRANSITIONS)).toHaveLength(15);
    expect(statusChanges(LPO_TRANSITIONS)).toHaveLength(6);
  });
});

describe("delivery and invoice identifiers", () => {
  it("normalises Kenyan registrations and flags others", () => {
    expect(normaliseVehicleRegistration(" kda 123a ")).toEqual({ value: "KDA 123A", format: "kenyan" });
    expect(normaliseVehicleRegistration("KBX123")).toEqual({ value: "KBX 123", format: "kenyan" });
    expect(normaliseVehicleRegistration("kmda123a")).toEqual({
      value: "KMDA 123A",
      format: "kenyan",
    });
    expect(normaliseVehicleRegistration("GKA 123B")).toEqual({ value: "GK A123B", format: "kenyan" });
    expect(normaliseVehicleRegistration("ze-1234")).toEqual({ value: "ZE 1234", format: "kenyan" });
    expect(normaliseVehicleRegistration("T 123  ABC")).toEqual({ value: "T 123 ABC", format: "other" });
    expect(normaliseVehicleRegistration("UAB 123X")).toEqual({ value: "UAB 123X", format: "other" });
    expect(normaliseVehicleRegistration("")).toBeNull();
    expect(normaliseVehicleRegistration("K@A 1")).toBeNull();
    expect(normaliseVehicleRegistration("- -")).toBeNull();
    expect(normaliseVehicleRegistration("KDA 123A 4567 89012")).toBeNull();
  });

  it("classifies eTIMS numbers by format only and keys invoice numbers", () => {
    expect(classifyEtimsInvoiceNumber(" kracu0400000078/2231")).toEqual({
      value: "KRACU0400000078/2231",
      format: "etims",
    });
    expect(classifyEtimsInvoiceNumber("0040799720000000123")).toEqual({
      value: "0040799720000000123",
      format: "unrecognised",
    });
    expect(classifyEtimsInvoiceNumber("ab1")).toBeNull();
    expect(classifyEtimsInvoiceNumber("KRA CU 04 <script>")).toBeNull();
    expect(invoiceNumberKey(" inv-001 ")).toBe("INV001");
    expect(invoiceNumberKey("INV 001")).toBe(invoiceNumberKey("inv/001"));
  });
});

describe("delivery location against the site geofence", () => {
  const centre = { lat: -1.2921, lng: 36.8219 };
  const site: Geofence = { kind: "radius", center: centre, radiusM: 100 };
  const north = (metres: number) => centre.lat + metres / 111_195;

  it("allows the reported accuracy, capped, and flags instead of refusing", () => {
    expect(assessDeliveryLocation({ ...centre, accuracyM: 10 }, site)).toEqual({
      state: "inside",
      lowAccuracy: false,
    });
    // 120 m from the centre with ±30 m: within 100 + 30.
    expect(assessDeliveryLocation({ lat: north(120), lng: centre.lng, accuracyM: 30 }, site).state).toBe(
      "inside",
    );
    // 200 m with ±500 m: the tolerance is capped at 50 m, so outside, and the fix is imprecise.
    expect(assessDeliveryLocation({ lat: north(200), lng: centre.lng, accuracyM: 500 }, site)).toEqual(
      { state: "outside", lowAccuracy: true },
    );
    expect(assessDeliveryLocation(null, site)).toEqual({ state: "no_fix", lowAccuracy: false });
    expect(assessDeliveryLocation({ ...centre, accuracyM: Number.NaN }, site).state).toBe("no_fix");
    expect(assessDeliveryLocation({ ...centre, accuracyM: 5 }, null).state).toBe("no_geofence");
  });
});
