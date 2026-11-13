import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { variationSnapshotText } from "@pm-buddy/domain";
import { variationDigest } from "./variation-digest.js";

const ID = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const input = () => ({
  variationId: ID(1),
  instructionId: ID(2),
  baseVersionId: ID(3),
  baseGrandTotalMinor: 3_864_718_875,
  vatRatePercent: "16",
  lines: [
    {
      action: "adjust" as const,
      itemLineageId: ID(4),
      billLineageId: null,
      sectionLineageId: null,
      newSection: null,
      newLineageId: null,
      ref: null,
      description: null,
      unit: null,
      unitRaw: null,
      kind: null,
      quantity: "14.75",
      rate: null,
      amountMinor: null,
      note: null,
      baseAmountMinor: 1_062_813,
      newAmountMinor: 1_254_119,
    },
  ],
  totals: { additionsMinor: 191_306, omissionsMinor: 0, netMinor: 191_306 },
});

describe("variation snapshot digest", () => {
  it("is the SHA-256 of the canonical snapshot text, stable for equal proposals", () => {
    const digest = variationDigest(input());
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(createHash("sha256").update(variationSnapshotText(input())).digest("hex"));
    expect(variationDigest(input())).toBe(digest);
  });

  it("changes when the base version, a line or the totals change", () => {
    const digest = variationDigest(input());
    const rebased = input();
    rebased.baseVersionId = ID(9);
    expect(variationDigest(rebased)).not.toBe(digest);
    const edited = input();
    edited.lines[0]!.quantity = "14.76";
    expect(variationDigest(edited)).not.toBe(digest);
    const total = input();
    total.baseGrandTotalMinor += 1;
    expect(variationDigest(total)).not.toBe(digest);
  });
});
