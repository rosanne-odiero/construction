import { Injectable, NotFoundException } from "@nestjs/common";
import { nairobiDate } from "@pm-buddy/domain";
import type { Permission } from "@pm-buddy/types";
import { labourerResponseSchema, type LabourerWarning } from "@pm-buddy/validation";
import type { Scope } from "../identity/access-policy.js";
import {
  displayNames,
  loadLabourers,
  toDetail,
  type LabourerRow,
  type MapContext,
} from "./labour-mappers.js";
import { inProjects, LabourAccess, LabourCrypto, type ProjectSet } from "./labour-support.js";
import { alertDays } from "./setup.service.js";

/** Builds registry rows and the side-panel detail with the caller's visibility rules applied. */
@Injectable()
export class LabourerReader {
  constructor(
    private readonly access: LabourAccess,
    private readonly crypto: LabourCrypto,
  ) {}

  /** Projects whose labour data the caller may see, and those where they see do-not-rehire flags. */
  async visibility(scope: Scope): Promise<{ visible: ProjectSet; flags: ProjectSet }> {
    // Sequential: one transaction runs one query at a time.
    const visible = await this.access.projectsWith(scope, "labour.view");
    const manage = await this.access.projectsWith(scope, "labour.manage");
    const flag = await this.access.projectsWith(scope, "labour.do_not_rehire");
    const flags: ProjectSet =
      manage === "all" || flag === "all" ? "all" : [...new Set([...manage, ...flag])];
    return { visible, flags };
  }

  async context(
    scope: Scope,
    visibility?: { visible: ProjectSet; flags: ProjectSet },
  ): Promise<Omit<MapContext, "canSeeFlag"> & { flags: ProjectSet }> {
    const { visible, flags } = visibility ?? (await this.visibility(scope));
    return {
      crypto: this.crypto,
      tenantId: scope.access.tenantId,
      today: nairobiDate(),
      alertDays: await alertDays(scope.tx, scope.access.tenantId),
      visibleProjects: visible,
      flags,
    };
  }

  /** Whether the caller sees this labourer's do-not-rehire flag. */
  static canSeeFlag(row: Pick<LabourerRow, "engagements">, flags: ProjectSet): boolean {
    return (
      flags === "all" ||
      row.engagements.some((engagement) => inProjects(flags, engagement.projectId))
    );
  }

  /** The side-panel detail (404 if the caller cannot view the labourer). */
  async detail(scope: Scope, labourerId: string, warnings: LabourerWarning[] = []) {
    const { effective } = await this.access.labourer(scope, labourerId);
    const [row] = await loadLabourers(scope.tx, scope.access.tenantId, { id: labourerId });
    if (!row) throw new NotFoundException("Labourer not found");
    const base = await this.context(scope);
    const canSeeFlag = effective.has("labour.manage") || effective.has("labour.do_not_rehire");
    const names = await displayNames(scope.tx, [
      ...row.consents.flatMap((consent) => [consent.capturedBy, consent.withdrawnBy]),
      row.doNotRehireBy,
    ]);
    const reason = await this.flagReason(scope, row, effective);
    return labourerResponseSchema.parse({
      labourer: toDetail(
        row,
        { ...base, canSeeFlag },
        { effective, names, doNotRehireReason: reason },
      ),
      warnings,
    });
  }

  private async flagReason(
    scope: Scope,
    row: Pick<LabourerRow, "id" | "doNotRehire">,
    effective: ReadonlySet<Permission>,
  ): Promise<string | null> {
    if (!row.doNotRehire || !effective.has("labour.do_not_rehire")) return null;
    const event = await scope.tx.doNotRehireEvent.findFirst({
      where: { tenantId: scope.access.tenantId, labourerId: row.id, action: "set" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    return event ? this.crypto.openReason(scope.access.tenantId, event.id, event.reasonEnc) : null;
  }
}
