import { describe, expect, it } from "vitest";
import {
  FULL_WEIGHT_BP,
  wbsDepth,
  wbsProgress,
  wbsSubtreeHeight,
  wbsWeightGroups,
  wbsWeightsComplete,
  wouldCreateCycle,
  type WbsWeightNode,
} from "./wbs.js";

const nodes: WbsWeightNode[] = [
  { id: "sub", parentId: null, weightBasisPoints: 3_000 },
  { id: "super", parentId: null, weightBasisPoints: 5_000 },
  { id: "fin", parentId: null, weightBasisPoints: 2_000 },
  { id: "super-frame", parentId: "super", weightBasisPoints: 6_000 },
  { id: "super-walls", parentId: "super", weightBasisPoints: 4_000 },
];

describe("WBS weights", () => {
  it("groups siblings and checks each group sums to 100 %", () => {
    const groups = wbsWeightGroups(nodes);
    expect(groups.map((group) => [group.parentId, group.sumBasisPoints, group.complete])).toEqual([
      [null, FULL_WEIGHT_BP, true],
      ["super", FULL_WEIGHT_BP, true],
    ]);
    expect(wbsWeightsComplete(nodes)).toBe(true);
  });

  it("is incomplete when any sibling group is off 100 %, or there are no nodes", () => {
    expect(wbsWeightsComplete([])).toBe(false);
    const off = nodes.map((node) =>
      node.id === "super-walls" ? { ...node, weightBasisPoints: 3_999 } : node,
    );
    expect(wbsWeightsComplete(off)).toBe(false);
    expect(wbsWeightGroups(off).find((group) => group.parentId === "super")).toMatchObject({
      sumBasisPoints: 9_999,
      complete: false,
    });
  });
});

describe("WBS progress", () => {
  const measured = new Map([
    ["sub", 1],
    ["super-frame", 0.5],
    ["super-walls", 0.25],
    ["fin", 0],
  ]);

  it("rolls up weighted progress from the leaves", () => {
    // 0.3 × 1 + 0.5 × (0.6 × 0.5 + 0.4 × 0.25) + 0.2 × 0 = 0.5
    expect(wbsProgress(nodes, measured)).toBeCloseTo(0.5, 10);
  });

  it("is unavailable (null), never 0, without valid weights or measurements", () => {
    expect(wbsProgress([], measured)).toBeNull();
    expect(wbsProgress(nodes, new Map())).toBeNull();
    expect(wbsProgress(nodes, new Map([["sub", 1]]))).toBeNull();
    const off = nodes.map((node) =>
      node.id === "fin" ? { ...node, weightBasisPoints: 1_000 } : node,
    );
    expect(wbsProgress(off, measured)).toBeNull();
    expect(wbsProgress(nodes, new Map([...measured, ["fin", 1.5]]))).toBeNull();
  });
});

describe("WBS structure", () => {
  it("measures depth and refuses cycles", () => {
    expect(wbsDepth(nodes, "sub")).toBe(1);
    expect(wbsDepth(nodes, "super-frame")).toBe(2);
    expect(wbsDepth(nodes, "missing")).toBeNull();
    expect(wouldCreateCycle(nodes, "super", "super-frame")).toBe(true);
    expect(wouldCreateCycle(nodes, "super", "super")).toBe(true);
    expect(wouldCreateCycle(nodes, "super-frame", "sub")).toBe(false);
    expect(wouldCreateCycle(nodes, "super-frame", null)).toBe(false);
    expect(wbsSubtreeHeight(nodes, "super")).toBe(2);
    expect(wbsSubtreeHeight(nodes, "fin")).toBe(1);
  });
});
