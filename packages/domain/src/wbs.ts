/**
 * Work breakdown structure weights (brief §5.1, §15 G). Each node carries a progress weight in
 * basis points (1 % = 100 bp). The rule: the children of one parent (and the top-level nodes)
 * must sum to exactly 100 % (10,000 bp). Nodes may be saved while weights are incomplete, but
 * percentage complete is unavailable until every sibling group sums to 100 % and every leaf has
 * a measured progress value. Nothing is ever shown as 0 % for want of data.
 */

export const FULL_WEIGHT_BP = 10_000;
/** The deepest level a WBS may reach (1 = top level). */
export const MAX_WBS_DEPTH = 6;

export type WbsWeightNode = { id: string; parentId: string | null; weightBasisPoints: number };

export type WbsWeightGroup = {
  parentId: string | null;
  sumBasisPoints: number;
  complete: boolean;
  nodeIds: string[];
};

/** Sibling groups (top level first, then by first appearance) with their weight totals. */
export function wbsWeightGroups(nodes: readonly WbsWeightNode[]): WbsWeightGroup[] {
  const groups = new Map<string | null, WbsWeightGroup>();
  for (const node of nodes) {
    const group = groups.get(node.parentId) ?? {
      parentId: node.parentId,
      sumBasisPoints: 0,
      complete: false,
      nodeIds: [],
    };
    group.sumBasisPoints += node.weightBasisPoints;
    group.nodeIds.push(node.id);
    groups.set(node.parentId, group);
  }
  const result = [...groups.values()].map((group) => ({
    ...group,
    complete: group.sumBasisPoints === FULL_WEIGHT_BP,
  }));
  return result.sort((a, b) => Number(a.parentId !== null) - Number(b.parentId !== null));
}

/** Whether every sibling group sums to exactly 100 % (and there is at least one node). */
export const wbsWeightsComplete = (nodes: readonly WbsWeightNode[]): boolean =>
  nodes.length > 0 && wbsWeightGroups(nodes).every((group) => group.complete);

/**
 * Weighted percentage complete as a ratio in [0, 1], or null ("unavailable") when the weights
 * are incomplete or any leaf has no measured progress. `leafProgress` holds ratios in [0, 1].
 */
export function wbsProgress(
  nodes: readonly WbsWeightNode[],
  leafProgress: ReadonlyMap<string, number>,
): number | null {
  if (!wbsWeightsComplete(nodes)) return null;
  const children = new Map<string | null, WbsWeightNode[]>();
  for (const node of nodes)
    children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
  const progressOf = (node: WbsWeightNode, depth: number): number | null => {
    if (depth > MAX_WBS_DEPTH) return null;
    const below = children.get(node.id);
    if (!below?.length) {
      const value = leafProgress.get(node.id);
      return value === undefined || !Number.isFinite(value) || value < 0 || value > 1
        ? null
        : value;
    }
    let total = 0;
    for (const child of below) {
      const value = progressOf(child, depth + 1);
      if (value === null) return null;
      total += (value * child.weightBasisPoints) / FULL_WEIGHT_BP;
    }
    return total;
  };
  let total = 0;
  for (const node of children.get(null) ?? []) {
    const value = progressOf(node, 1);
    if (value === null) return null;
    total += (value * node.weightBasisPoints) / FULL_WEIGHT_BP;
  }
  return total;
}

/** Depth of a node (1 = top level), or null if its ancestry is broken or cyclic. */
export function wbsDepth(
  nodes: readonly { id: string; parentId: string | null }[],
  id: string,
): number | null {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  let depth = 0;
  let current = byId.get(id);
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current.id)) return null;
    seen.add(current.id);
    depth++;
    if (current.parentId === null) return depth;
    current = byId.get(current.parentId);
  }
  return null;
}

/** Whether giving `id` the parent `parentId` would make a node its own ancestor. */
export function wouldCreateCycle(
  nodes: readonly { id: string; parentId: string | null }[],
  id: string,
  parentId: string | null,
): boolean {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  let current = parentId;
  const seen = new Set<string>();
  while (current !== null) {
    if (current === id || seen.has(current)) return true;
    seen.add(current);
    current = byId.get(current)?.parentId ?? null;
  }
  return false;
}

/** The height of the subtree rooted at `id` (1 for a leaf). */
export function wbsSubtreeHeight(
  nodes: readonly { id: string; parentId: string | null }[],
  id: string,
  guard = 0,
): number {
  if (guard > nodes.length) return Number.POSITIVE_INFINITY; // cyclic data
  const children = nodes.filter((node) => node.parentId === id);
  return 1 + Math.max(0, ...children.map((child) => wbsSubtreeHeight(nodes, child.id, guard + 1)));
}
