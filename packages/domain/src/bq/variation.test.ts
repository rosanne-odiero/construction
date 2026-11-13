import { describe, expect, it } from "vitest";
import {
  allowedVariationActions,
  applyVariation,
  buildupLineAmountMinor,
  buildupRate,
  checkVariationTransition,
  compareVersions,
  isVariationEditable,
  isVariationFinal,
  priceVariationLine,
  priceVariationLines,
  projectedTotals,
  unitsCompatible,
  VARIATION_STATUS_CHANGES,
  VARIATION_TRANSITIONS,
  variationSnapshotText,
  variationTotals,
  versionTotals,
  type VariationLineInput,
  type VersionContent,
  type VersionItem,
} from "../index.js";

const BILL = "b0000000-0000-4000-8000-000000000001";
const BILL_TWO = "b0000000-0000-4000-8000-000000000002";
const SECTION = "c0000000-0000-4000-8000-000000000001";
const SECTION_TWO = "c0000000-0000-4000-8000-000000000002";
const lineage = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const item = (n: number, fields: Partial<VersionItem>): VersionItem => ({
  lineageId: lineage(n),
  billLineageId: BILL,
  sectionLineageId: SECTION,
  ref: String.fromCharCode(64 + n),
  description: `Item ${n}`,
  unit: "m3",
  unitRaw: "m3",
  quantity: "10",
  rate: "100",
  amountMinor: 100_000,
  sheetAmountMinor: null,
  amountSource: "computed",
  overrideReason: null,
  kind: "measured",
  notes: null,
  sourceSheet: "Bill 2",
  sourceRow: 10 + n,
  hasFormula: false,
  sortOrder: n - 1,
  ...fields,
});

/** Bill 2 (two sections) and Bill 3; 16 % VAT. */
const base = (): VersionContent => ({
  bills: [
    {
      lineageId: BILL,
      number: "2",
      title: "SUBSTRUCTURE",
      kind: "measured",
      sortOrder: 0,
      sheetTotalMinor: null,
      sourceSheet: "Bill 2",
    },
    {
      lineageId: BILL_TWO,
      number: "3",
      title: "SUPERSTRUCTURE",
      kind: "measured",
      sortOrder: 1,
      sheetTotalMinor: null,
      sourceSheet: "Bill 3",
    },
  ],
  sections: [
    {
      lineageId: SECTION,
      billLineageId: BILL,
      code: "A",
      title: "EXCAVATION",
      notes: null,
      sortOrder: 0,
    },
    {
      lineageId: SECTION_TWO,
      billLineageId: BILL,
      code: "B",
      title: "CONCRETE",
      notes: null,
      sortOrder: 1,
    },
  ],
  items: [
    item(1, { quantity: "12.5", rate: "850.25", amountMinor: 1_062_813 }),
    item(2, {
      quantity: "3",
      rate: "0.335",
      amountMinor: 101,
      sectionLineageId: SECTION_TWO,
      sortOrder: 1,
    }),
    item(3, {
      quantity: null,
      rate: null,
      unit: "item",
      unitRaw: "Item",
      amountMinor: 5_000_000,
      sheetAmountMinor: 5_000_000,
      amountSource: "lump_sum",
      sectionLineageId: SECTION_TWO,
      sortOrder: 2,
    }),
    item(4, {
      billLineageId: BILL_TWO,
      sectionLineageId: null,
      sortOrder: 0,
      amountMinor: 100_000,
    }),
  ],
});

const line = (fields: Partial<VariationLineInput>): VariationLineInput => ({
  action: "adjust",
  itemLineageId: null,
  billLineageId: null,
  sectionLineageId: null,
  newSection: null,
  newLineageId: null,
  ref: null,
  description: null,
  unit: null,
  unitRaw: null,
  kind: null,
  quantity: null,
  rate: null,
  amountMinor: null,
  note: null,
  ...fields,
});

describe("variation state machine", () => {
  it("allows exactly the WORKFLOWS transitions", () => {
    expect(checkVariationTransition({ status: "draft", action: "submit" })).toEqual({
      ok: true,
      to: "submitted",
    });
    expect(checkVariationTransition({ status: "submitted", action: "approve" })).toEqual({
      ok: true,
      to: "approved",
    });
    expect(
      checkVariationTransition({ status: "submitted", action: "reject", reason: "Over budget" }),
    ).toEqual({ ok: true, to: "rejected" });
    expect(checkVariationTransition({ status: "rejected", action: "reopen" })).toEqual({
      ok: true,
      to: "draft",
    });
    expect(
      checkVariationTransition({ status: "draft", action: "cancel", reason: "Withdrawn by AI" }),
    ).toEqual({ ok: true, to: "cancelled" });
    for (const status of ["draft", "submitted", "rejected"] as const)
      expect(checkVariationTransition({ status, action: "rebase", stale: true })).toEqual({
        ok: true,
        to: "draft",
      });
  });

  it("refuses invalid transitions with stable codes", () => {
    const invalid = { ok: false, error: "invalid_transition" };
    expect(checkVariationTransition({ status: "draft", action: "approve" })).toEqual(invalid);
    expect(
      checkVariationTransition({ status: "approved", action: "reject", reason: "x x" }),
    ).toEqual(invalid);
    expect(checkVariationTransition({ status: "approved", action: "rebase", stale: true })).toEqual(
      invalid,
    );
    expect(checkVariationTransition({ status: "cancelled", action: "reopen" })).toEqual(invalid);
    expect(
      checkVariationTransition({ status: "submitted", action: "cancel", reason: "x" }),
    ).toEqual(invalid);
    expect(checkVariationTransition({ status: "rejected", action: "submit" })).toEqual(invalid);
    expect(checkVariationTransition({ status: "submitted", action: "reject" })).toEqual({
      ok: false,
      error: "reason_required",
    });
    expect(
      checkVariationTransition({ status: "submitted", action: "reject", reason: "  no " }),
    ).toEqual({ ok: false, error: "reason_required" });
    expect(checkVariationTransition({ status: "draft", action: "cancel" })).toEqual({
      ok: false,
      error: "reason_required",
    });
    expect(checkVariationTransition({ status: "draft", action: "rebase", stale: false })).toEqual({
      ok: false,
      error: "not_stale",
    });
  });

  it("matches the database's list of status changes", () => {
    const fromActions = new Set(
      Object.values(VARIATION_TRANSITIONS).flatMap((transition) =>
        transition.from
          .filter((from) => from !== transition.to)
          .map((from) => `${from}>${transition.to}`),
      ),
    );
    expect([...fromActions].sort()).toEqual(
      VARIATION_STATUS_CHANGES.map(([from, to]) => `${from}>${to}`).sort(),
    );
    expect(allowedVariationActions("draft")).toEqual(["submit", "cancel", "rebase"]);
    expect(allowedVariationActions("submitted")).toEqual(["approve", "reject", "rebase"]);
    expect(allowedVariationActions("approved")).toEqual([]);
    expect(isVariationEditable("draft")).toBe(true);
    expect(isVariationEditable("submitted")).toBe(false);
    expect(isVariationFinal("approved")).toBe(true);
    expect(isVariationFinal("cancelled")).toBe(true);
    expect(isVariationFinal("rejected")).toBe(false);
  });
});

describe("pricing variation lines", () => {
  it("adjusts quantity and rate with half-up rounding per line", () => {
    // 12.5 × 850.25 = 10,628.125 → 10,628.13 (tie away from zero)
    expect(base().items[0]!.amountMinor).toBe(1_062_813);
    const result = priceVariationLine(
      line({ itemLineageId: lineage(1), quantity: "14.75" }),
      base(),
    );
    // 14.75 × 850.25 = 12,541.1875 → 12,541.19
    expect(result).toEqual({
      ok: true,
      priced: {
        baseAmountMinor: 1_062_813,
        newAmountMinor: 1_254_119,
        deltaMinor: 191_306,
        quantity: "14.75",
        rate: "850.25",
        amountSource: "computed",
        noChange: false,
      },
    });
    // 3 × 0.3349 = 1.0047 → 1.00; a rate cut on a cheap line
    const cheap = priceVariationLine(line({ itemLineageId: lineage(2), rate: "0.3349" }), base());
    expect(cheap.ok && cheap.priced).toMatchObject({ newAmountMinor: 100, deltaMinor: -1 });
  });

  it("omits an item to quantity 0 and amount 0", () => {
    const result = priceVariationLine(line({ action: "omit", itemLineageId: lineage(1) }), base());
    expect(result).toEqual({
      ok: true,
      priced: {
        baseAmountMinor: 1_062_813,
        newAmountMinor: 0,
        deltaMinor: -1_062_813,
        quantity: "0",
        rate: "850.25",
        amountSource: "omitted",
        noChange: false,
      },
    });
    const lump = priceVariationLine(line({ action: "omit", itemLineageId: lineage(3) }), base());
    expect(lump.ok && lump.priced).toMatchObject({ quantity: null, deltaMinor: -5_000_000 });
  });

  it("adjusts an amount-only line by amount and refuses rate with amount", () => {
    expect(
      priceVariationLine(line({ itemLineageId: lineage(3), amountMinor: 6_250_000 }), base()),
    ).toMatchObject({
      ok: true,
      priced: { amountSource: "fixed", rate: null, deltaMinor: 1_250_000 },
    });
    expect(
      priceVariationLine(line({ itemLineageId: lineage(3), amountMinor: 1, rate: "2" }), base()),
    ).toEqual({ ok: false, error: "amount-or-rate" });
    expect(priceVariationLine(line({ itemLineageId: lineage(3), quantity: "2" }), base())).toEqual({
      ok: false,
      error: "quantity-and-rate-required",
    });
    expect(
      priceVariationLine(line({ itemLineageId: lineage(3), quantity: "2", rate: "1000" }), base()),
    ).toMatchObject({ ok: true, priced: { amountSource: "computed", newAmountMinor: 200_000 } });
  });

  it("adds measured items, lump sums and dayworks to existing and new sections", () => {
    const measured = priceVariationLine(
      line({
        action: "add",
        billLineageId: BILL,
        sectionLineageId: SECTION_TWO,
        newLineageId: lineage(90),
        description: "Extra column bases",
        unit: "m3",
        kind: "measured",
        quantity: "2.333",
        rate: "15000.5",
      }),
      base(),
    );
    // 2.333 × 15,000.50 = 34,996.1665 → 34,996.17
    expect(measured).toMatchObject({ ok: true, priced: { newAmountMinor: 3_499_617 } });
    const daywork = priceVariationLine(
      line({
        action: "add",
        billLineageId: BILL_TWO,
        newSection: { code: null, title: "Dayworks for VO-1" },
        newLineageId: lineage(91),
        description: "Labour on daywork",
        kind: "daywork",
        amountMinor: 1_500_000,
      }),
      base(),
    );
    expect(daywork).toMatchObject({
      ok: true,
      priced: { amountSource: "fixed", deltaMinor: 1_500_000 },
    });
  });

  it("refuses invalid lines with stable codes", () => {
    const add = (fields: Partial<VariationLineInput>) =>
      priceVariationLine(
        line({
          action: "add",
          billLineageId: BILL,
          sectionLineageId: SECTION,
          newLineageId: lineage(99),
          description: "New",
          unit: "m2",
          kind: "measured",
          quantity: "1",
          rate: "1",
          ...fields,
        }),
        base(),
      );
    expect(priceVariationLine(line({ itemLineageId: lineage(77), rate: "1" }), base())).toEqual({
      ok: false,
      error: "item-not-found",
    });
    expect(priceVariationLine(line({ itemLineageId: lineage(1) }), base())).toEqual({
      ok: false,
      error: "line-no-change",
    });
    expect(add({ billLineageId: lineage(55) })).toEqual({ ok: false, error: "bill-not-found" });
    expect(add({ sectionLineageId: lineage(56) })).toEqual({
      ok: false,
      error: "section-not-found",
    });
    expect(add({ billLineageId: BILL_TWO })).toEqual({ ok: false, error: "section-not-in-bill" });
    expect(add({ sectionLineageId: null })).toEqual({ ok: false, error: "section-required" });
    expect(add({ description: "  " })).toEqual({ ok: false, error: "description-required" });
    expect(add({ kind: null })).toEqual({ ok: false, error: "kind-required" });
    expect(add({ unit: null })).toEqual({ ok: false, error: "unit-required" });
    expect(add({ rate: null })).toEqual({ ok: false, error: "quantity-and-rate-required" });
    expect(add({ amountMinor: 5 })).toEqual({ ok: false, error: "amount-or-rate" });
    const omitted = {
      ...base(),
      items: base().items.map((entry) =>
        entry.lineageId === lineage(1)
          ? { ...entry, quantity: "0", amountMinor: 0, amountSource: "omitted" as const }
          : entry,
      ),
    };
    // Omitting an item that is already omitted (possible after a rebase) changes nothing.
    expect(
      priceVariationLine(line({ action: "omit", itemLineageId: lineage(1) }), omitted),
    ).toMatchObject({ ok: true, priced: { deltaMinor: 0, noChange: true } });
    expect(
      priceVariationLines([line({ action: "omit", itemLineageId: lineage(1) })], omitted),
    ).toEqual({ ok: false, index: 0, error: "line-no-change" });
  });

  it("checks the set of lines: one line per item, no-ops only after a rebase", () => {
    const lines = [
      line({ itemLineageId: lineage(1), quantity: "13" }),
      line({ action: "omit", itemLineageId: lineage(1) }),
    ];
    expect(priceVariationLines(lines, base())).toEqual({
      ok: false,
      index: 1,
      error: "duplicate-target",
    });
    const same = [line({ itemLineageId: lineage(1), quantity: "12.5000" })];
    expect(priceVariationLines(same, base())).toEqual({
      ok: false,
      index: 0,
      error: "line-no-change",
    });
    const allowed = priceVariationLines(same, base(), { allowNoChange: true });
    expect(allowed.ok && allowed.priced[0]?.noChange).toBe(true);
  });

  it("projects the new totals with VAT recomputed once on the new subtotal", () => {
    // Base: subtotal 6,162,914, VAT 986,066 (16 %), grand 7,148,980; net −871,507.
    expect(
      projectedTotals({ subtotalMinor: 6_162_914, grandTotalMinor: 7_148_980 }, -871_507, "16"),
    ).toEqual({
      subtotalMinor: 5_291_407,
      // 5,291,407 × 16 % = 846,625.12 → 846,625
      vatMinor: 846_625,
      grandTotalMinor: 6_138_032,
      grandTotalEffectMinor: -1_010_948,
    });
  });

  it("totals additions, omissions and net", () => {
    expect(
      variationTotals([{ deltaMinor: 191_306 }, { deltaMinor: -1_062_813 }, { deltaMinor: 0 }]),
    ).toEqual({ additionsMinor: 191_306, omissionsMinor: 1_062_813, netMinor: -871_507 });
    expect(variationTotals([])).toEqual({ additionsMinor: 0, omissionsMinor: 0, netMinor: 0 });
  });
});

describe("applying a variation to a version", () => {
  it("copies the base, applies every line and recomputes totals and VAT", () => {
    const content = base();
    const before = versionTotals(content, "16");
    expect(before).toMatchObject({
      subtotalMinor: 1_062_813 + 101 + 5_000_000 + 100_000,
      billCount: 2,
      itemCount: 4,
    });
    // 6,162,914 × 16 % = 986,066.24 → 986,066
    expect(before.vatMinor).toBe(986_066);
    const lines = [
      line({ itemLineageId: lineage(1), quantity: "14.75" }),
      line({ action: "omit", itemLineageId: lineage(3) }),
      line({
        action: "add",
        billLineageId: BILL,
        newSection: { code: "C", title: "Drainage" },
        newLineageId: lineage(90),
        description: "uPVC pipe 110 mm",
        unit: "m",
        unitRaw: "m",
        kind: "measured",
        quantity: "30",
        rate: "1250.33",
      }),
      line({
        action: "add",
        billLineageId: BILL,
        newSection: { code: "C", title: " drainage " },
        newLineageId: lineage(91),
        description: "Manhole",
        unit: "nr",
        kind: "measured",
        quantity: "1",
        rate: "18500",
      }),
      line({
        action: "add",
        billLineageId: BILL,
        sectionLineageId: SECTION,
        newLineageId: lineage(92),
        description: "Extra excavation",
        unit: "m3",
        kind: "measured",
        quantity: "5",
        rate: "450",
      }),
    ];
    const checked = priceVariationLines(lines, content);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    let next = 0;
    const applied = applyVariation(content, lines, checked.priced, "16", () =>
      lineage(500 + ++next),
    );
    // The base is untouched.
    expect(content.items).toHaveLength(4);
    expect(content.items[2]!.amountSource).toBe("lump_sum");
    expect(applied.counts).toEqual({ adjusted: 1, omitted: 1, added: 3, newSections: 1 });
    const items = applied.content.items;
    expect(items.find((entry) => entry.lineageId === lineage(1))).toMatchObject({
      quantity: "14.75",
      amountMinor: 1_254_119,
    });
    expect(items.find((entry) => entry.lineageId === lineage(3))).toMatchObject({
      quantity: null,
      amountMinor: 0,
      amountSource: "omitted",
    });
    // Both "Drainage" lines share one new section at the end of Bill 2.
    const drainage = applied.content.sections.filter(
      (entry) => entry.title !== null && /drainage/i.test(entry.title),
    );
    expect(drainage).toEqual([
      {
        lineageId: lineage(501),
        billLineageId: BILL,
        code: "C",
        title: "Drainage",
        notes: null,
        sortOrder: 2,
      },
    ]);
    // Bill 2 order: section A (item 1, new excavation), B (items 2, 3), C (new pipe, manhole).
    expect(
      items
        .filter((entry) => entry.billLineageId === BILL)
        .sort((left, right) => left.sortOrder - right.sortOrder)
        .map((entry) => [entry.lineageId, entry.sortOrder]),
    ).toEqual([
      [lineage(1), 0],
      [lineage(92), 1],
      [lineage(2), 2],
      [lineage(3), 3],
      [lineage(90), 4],
      [lineage(91), 5],
    ]);
    // 30 × 1,250.33 = 37,509.90; 1 × 18,500; 5 × 450 = 2,250
    const billTwo = 1_254_119 + 101 + 0 + 3_750_990 + 1_850_000 + 225_000;
    expect(applied.totals.bills[BILL]).toBe(billTwo);
    expect(applied.totals.bills[BILL_TWO]).toBe(100_000);
    expect(applied.totals.sections[lineage(501)]).toBe(3_750_990 + 1_850_000);
    expect(applied.totals.subtotalMinor).toBe(billTwo + 100_000);
    // VAT once on the subtotal: 7,180,210 × 16 % = 1,148,833.60 → 1,148,834 (half-up)
    expect(applied.totals.subtotalMinor).toBe(7_180_210);
    expect(applied.totals.vatMinor).toBe(1_148_834);
    expect(applied.totals.grandTotalMinor).toBe(7_180_210 + 1_148_834);
    expect(applied.totals.itemCount).toBe(7);
  });
});

describe("comparing versions", () => {
  it("lists added, removed and changed items, bill subtotals and the overall difference", () => {
    const from = base();
    const lines = [
      line({ itemLineageId: lineage(2), rate: "0.5" }),
      line({ action: "omit", itemLineageId: lineage(4) }),
      line({
        action: "add",
        billLineageId: BILL_TWO,
        newSection: { code: null, title: "Extras" },
        newLineageId: lineage(90),
        description: "Lintel",
        unit: "m",
        kind: "measured",
        quantity: "4",
        rate: "900",
      }),
    ];
    const checked = priceVariationLines(lines, from);
    if (!checked.ok) throw new Error(checked.error);
    const to = applyVariation(from, lines, checked.priced, "16", () => lineage(600)).content;
    const result = compareVersions(
      { content: from, vatRatePercent: "16" },
      { content: to, vatRatePercent: "16" },
    );
    expect(result.added.map((entry) => [entry.lineageId, entry.differenceMinor])).toEqual([
      [lineage(90), 360_000],
    ]);
    expect(
      result.changed.map((entry) => [entry.lineageId, entry.fields, entry.differenceMinor]),
    ).toEqual([
      [lineage(2), ["rate", "amount"], 49],
      [lineage(4), ["quantity", "amount", "amountSource"], -100_000],
    ]);
    expect(result.removed).toEqual([]);
    expect(result.bills).toEqual([
      expect.objectContaining({ number: "2", differenceMinor: 49 }),
      expect.objectContaining({
        number: "3",
        fromMinor: 100_000,
        toMinor: 360_000,
        differenceMinor: 260_000,
      }),
    ]);
    expect(result.totals.difference.subtotalMinor).toBe(260_049);
    expect(result.totals.difference.grandTotalMinor).toBe(
      result.totals.to.grandTotalMinor - result.totals.from.grandTotalMinor,
    );
    const reverse = compareVersions(
      { content: to, vatRatePercent: "16" },
      { content: from, vatRatePercent: "16" },
    );
    expect(reverse.removed.map((entry) => [entry.lineageId, entry.differenceMinor])).toEqual([
      [lineage(90), -360_000],
    ]);
  });
});

describe("variation snapshot", () => {
  const input = () => ({
    variationId: lineage(700),
    instructionId: lineage(701),
    baseVersionId: lineage(702),
    baseGrandTotalMinor: 7_148_980,
    vatRatePercent: "16.0000",
    lines: [
      {
        ...line({ itemLineageId: lineage(1), quantity: "14.750" }),
        baseAmountMinor: 1_062_813,
        newAmountMinor: 1_254_119,
      },
    ],
    totals: { additionsMinor: 191_306, omissionsMinor: 0, netMinor: 191_306 },
  });

  it("is canonical and changes with anything material", () => {
    const text = variationSnapshotText(input());
    expect(text).toBe(variationSnapshotText(input()));
    // Decimal spelling does not matter: 14.750 = 14.75, 16.0000 = 16.
    const respelled = input();
    respelled.lines[0]!.quantity = "14.75";
    respelled.vatRatePercent = "16";
    expect(variationSnapshotText(respelled)).toBe(text);
    const changes: ((value: ReturnType<typeof input>) => void)[] = [
      (value) => (value.baseVersionId = lineage(703)),
      (value) => (value.baseGrandTotalMinor += 1),
      (value) => (value.instructionId = lineage(704)),
      (value) => (value.lines[0]!.quantity = "14.76"),
      (value) => (value.lines[0]!.rate = "850"),
      (value) => (value.lines[0]!.baseAmountMinor += 1),
      (value) => (value.lines[0]!.note = "Changed"),
      (value) => (value.totals.netMinor += 1),
      (value) => value.lines.push({ ...value.lines[0]! }),
    ];
    for (const change of changes) {
      const changed = input();
      change(changed);
      expect(variationSnapshotText(changed)).not.toBe(text);
    }
  });
});

describe("rate build-ups", () => {
  it("computes the rate as the sum of lines rounded half-up per line", () => {
    // Synthetic values: concrete class 25 (1:2:4) per m³.
    const lines = [
      {
        kind: "material" as const,
        resourceName: "Cement (bag, assumed 50 kg)",
        unit: "bag",
        quantity: "6.5",
        wastePercent: "5",
        unitCostMinor: 85_000,
      },
      {
        kind: "material" as const,
        resourceName: "River sand",
        unit: "t",
        quantity: "0.7",
        wastePercent: "10",
        unitCostMinor: 250_000,
      },
      {
        kind: "material" as const,
        resourceName: "Ballast 20 mm",
        unit: "t",
        quantity: "1.4",
        wastePercent: null,
        unitCostMinor: 220_000,
      },
      {
        kind: "labour" as const,
        resourceName: "Mason and helpers",
        unit: "hr",
        quantity: "4.333333",
        wastePercent: null,
        unitCostMinor: 35_050,
      },
      {
        kind: "plant" as const,
        resourceName: "Concrete mixer",
        unit: "hr",
        quantity: "0.5",
        wastePercent: null,
        unitCostMinor: 150_000,
      },
    ];
    // 6.5 × 1.05 × 850 = 5,801.25; 0.7 × 1.1 × 2,500 = 1,925; 1.4 × 2,200 = 3,080;
    // 4.333333 × 350.50 = 1,518.8332… → 1,518.83; 0.5 × 1,500 = 750
    expect(buildupLineAmountMinor("6.5", "5", 85_000)).toBe(580_125);
    expect(buildupLineAmountMinor("4.333333", null, 35_050)).toBe(151_883);
    const result = buildupRate(lines);
    expect(result.lineAmountsMinor).toEqual([580_125, 192_500, 308_000, 151_883, 75_000]);
    expect(result.rateMinor).toBe(1_307_508);
    expect(result.byKind).toEqual({ material: 1_080_625, labour: 151_883, plant: 75_000 });
    // A tie rounds half-up: 0.5 × 3 cents = 1.5 → 2; 0.25 × 2 cents = 0.5 → 1.
    expect(buildupLineAmountMinor("0.5", null, 3)).toBe(2);
    expect(buildupLineAmountMinor("0.25", "0", 2)).toBe(1);
  });

  it("leaves the rate unavailable while any line has no unit cost", () => {
    const result = buildupRate([
      {
        kind: "material",
        resourceName: "A",
        unit: "t",
        quantity: "1",
        wastePercent: null,
        unitCostMinor: 100,
      },
      {
        kind: "labour",
        resourceName: "B",
        unit: "hr",
        quantity: "2",
        wastePercent: null,
        unitCostMinor: null,
      },
    ]);
    expect(result).toMatchObject({ rateMinor: null, pricedMinor: 100, unpricedLines: 1 });
    expect(buildupRate([]).rateMinor).toBeNull();
  });

  it("links only to items measured in the same unit after normalisation", () => {
    expect(unitsCompatible({ unit: "m3", unitRaw: "Cu.m" }, "m3")).toEqual({
      ok: true,
      unit: "m3",
    });
    expect(unitsCompatible({ unit: "other", unitRaw: "cubic metres" }, "m3")).toEqual({
      ok: true,
      unit: "m3",
    });
    expect(unitsCompatible({ unit: "m2", unitRaw: "sqm" }, "m3")).toEqual({
      ok: false,
      error: "unit-mismatch",
    });
    expect(unitsCompatible({ unit: "pct", unitRaw: "%" }, "m3")).toEqual({
      ok: false,
      error: "unit-mismatch",
    });
    expect(unitsCompatible({ unit: null, unitRaw: null }, "m3")).toEqual({
      ok: false,
      error: "item-unit-missing",
    });
    expect(unitsCompatible({ unit: "other", unitRaw: "lorry trip" }, "m3")).toEqual({
      ok: false,
      error: "item-unit-unknown",
    });
  });
});
