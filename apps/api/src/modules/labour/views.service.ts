import { Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import type { BuiltInLabourView } from "@pm-buddy/types";
import {
  labourViewFiltersSchema,
  labourViewResponseSchema,
  labourViewsResponseSchema,
  type LabourView,
  type LabourViewFilters,
} from "@pm-buddy/validation";
import type { z } from "zod";
import type { createLabourViewRequestSchema } from "@pm-buddy/validation";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { isEmpty, LabourAccess, labourConflict, rethrowLabourDbError } from "./labour-support.js";

/** Saved views per user and company (decision: personal, not shared; see ARCHITECTURE §4.2). */
export const MAX_SAVED_VIEWS = 20;

const BUILT_IN: Record<BuiltInLabourView, { name: string; filters: LabourViewFilters }> = {
  all: { name: "All", filters: {} },
  active: { name: "Active", filters: { status: "active" } },
  attention: { name: "Expiring NCA", filters: { status: "active", accreditation: "attention" } },
  doNotRehire: { name: "Do not rehire", filters: { doNotRehire: "true" } },
};

/**
 * Registry views: four built-in views (the do-not-rehire view only for callers who see the flag)
 * and up to twenty saved filter sets per user, private to that user in that company (RLS).
 */
@Injectable()
export class LabourViewsService {
  constructor(
    private readonly scope: TenantScope,
    private readonly access: LabourAccess,
  ) {}

  list(principal: Principal, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      await this.access.requireSomewhere(scope, "labour.view");
      const manage = await this.access.projectsWith(scope, "labour.manage");
      const dnr = await this.access.projectsWith(scope, "labour.do_not_rehire");
      const seesFlags = !isEmpty(manage) || !isEmpty(dnr);
      const builtIn: LabourView[] = (Object.keys(BUILT_IN) as BuiltInLabourView[])
        .filter((id) => id !== "doNotRehire" || seesFlags)
        .map((id) => ({
          id,
          name: BUILT_IN[id].name,
          builtIn: true,
          filters: BUILT_IN[id].filters,
        }));
      const saved = await scope.tx.labourSavedView.findMany({
        where: { tenantId: scope.access.tenantId, userId: scope.access.userId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      return labourViewsResponseSchema.parse({
        views: [
          ...builtIn,
          ...saved.flatMap((view) => {
            // A view saved before a filter changed shape is skipped rather than failing the page.
            const filters = labourViewFiltersSchema.safeParse(view.filters);
            return filters.success
              ? [{ id: view.id, name: view.name, builtIn: false, filters: filters.data }]
              : [];
          }),
        ],
      });
    });
  }

  create(
    principal: Principal,
    input: z.output<typeof createLabourViewRequestSchema>,
    req: Request,
  ) {
    return this.scope
      .run(principal, req, async (scope) => {
        await this.access.requireSomewhere(scope, "labour.view");
        const count = await scope.tx.labourSavedView.count({
          where: { tenantId: scope.access.tenantId, userId: scope.access.userId },
        });
        if (count >= MAX_SAVED_VIEWS)
          throw labourConflict("view-limit", `Keep at most ${MAX_SAVED_VIEWS} saved views.`);
        const view = await scope.tx.labourSavedView.create({
          data: {
            tenantId: scope.access.tenantId,
            userId: scope.access.userId,
            name: input.name,
            filters: input.filters,
          },
        });
        await this.scope.audit(scope.tx, "labour.view_saved", view.id, {
          filters: Object.keys(input.filters).sort(),
        });
        return labourViewResponseSchema.parse({
          view: { id: view.id, name: view.name, builtIn: false, filters: input.filters },
        });
      })
      .catch((error: unknown) => rethrowLabourDbError(error, "view-name-taken"));
  }

  remove(principal: Principal, viewId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      await this.access.requireSomewhere(scope, "labour.view");
      const removed = await scope.tx.labourSavedView.deleteMany({
        where: { tenantId: scope.access.tenantId, userId: scope.access.userId, id: viewId },
      });
      if (!removed.count) throw new NotFoundException("Saved view not found");
      await this.scope.audit(scope.tx, "labour.view_deleted", viewId, {});
      return { message: "Saved view deleted." };
    });
  }
}
