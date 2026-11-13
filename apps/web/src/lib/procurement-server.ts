import "server-only";
import {
  materialDetailResponseSchema,
  materialsResponseSchema,
  suppliersResponseSchema,
} from "@pm-buddy/validation";
import { collectPages } from "./procurement";
import { serverApi } from "./server-api";

/** A supplier or material as the pickers show it. */
export type PickerRef = { id: string; code: string; name: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const pageQuery = (cursor: string | null) =>
  `limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;

/** Every supplier for a picker (D5.1), not just the first page. */
export async function supplierPicker(): Promise<PickerRef[]> {
  const result = await collectPages(async (cursor) => {
    const page = await serverApi(`/suppliers?${pageQuery(cursor)}`, suppliersResponseSchema);
    if (!page.ok) return null;
    return {
      items: page.data.suppliers.map((supplier) => ({
        id: supplier.id,
        code: supplier.code,
        name: supplier.tradingName ?? supplier.legalName,
      })),
      nextCursor: page.data.page.hasMore ? page.data.page.nextCursor : null,
    };
  });
  return result?.items ?? [];
}

/**
 * Every active material for the calculator, plus `includeId` when it is not among them (a link
 * from a material page must preselect that material).
 */
export async function materialPicker(
  includeId?: string,
): Promise<(PickerRef & { baseUnit: string })[]> {
  const result = await collectPages(async (cursor) => {
    const page = await serverApi(
      `/materials?status=active&${pageQuery(cursor)}`,
      materialsResponseSchema,
    );
    if (!page.ok) return null;
    return {
      items: page.data.materials.map(({ id, code, name, baseUnit }) => ({
        id,
        code,
        name,
        baseUnit,
      })),
      nextCursor: page.data.page.hasMore ? page.data.page.nextCursor : null,
    };
  });
  const items = result?.items ?? [];
  if (includeId && UUID.test(includeId) && !items.some((material) => material.id === includeId)) {
    const detail = await serverApi(
      `/materials/${encodeURIComponent(includeId)}`,
      materialDetailResponseSchema,
    );
    if (detail.ok) {
      const { id, code, name, baseUnit } = detail.data.material;
      items.unshift({ id, code, name, baseUnit });
    }
  }
  return items;
}
