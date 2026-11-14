import { operatorCertificateState } from "@pm-buddy/domain";
import { PLANT_LIMITS, PLANT_READ_PERMISSIONS, type PlantCategory } from "@pm-buddy/types";
import type { PlantOperator } from "@pm-buddy/validation";
import type { Prisma } from "../../generated/prisma/client.js";
import { customRoleColumns, type Scope } from "../identity/access-policy.js";
import { effectiveProjectPermissions, grantOf } from "../identity/role-grants.js";
import { personOf, type People } from "../procurement/procurement-mappers.js";
import { toCalendarDate } from "../projects/project-mappers.js";
import type { PlantSettingsValues } from "./plant-access.js";
import { optionalDate } from "./plant-model.js";

export type OperatorRow = Prisma.PlantOperatorGetPayload<{
  include: { labourer: { select: { id: true; workerNo: true; fullName: true } } };
}>;

/** An operator assignment as the detail page shows it, with its certificate state. */
export function operatorState(
  row: OperatorRow,
  item: { category: string },
  settings: PlantSettingsValues,
  people: People,
  today: string,
  canEnd: boolean,
): PlantOperator {
  const toOn = optionalDate(row.toOn);
  const fromOn = toCalendarDate(row.fromOn);
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind as PlantOperator["kind"],
    labourer: row.labourer
      ? { id: row.labourer.id, workerNo: row.labourer.workerNo, fullName: row.labourer.fullName }
      : null,
    user: row.userId ? personOf(people, row.userId) : null,
    fromOn,
    toOn,
    certificateRef: row.certificateRef,
    certificateExpiresOn: optionalDate(row.certificateExpiresOn),
    certificateState: operatorCertificateState({
      category: item.category as PlantCategory,
      requiredCategories: settings.certificateCategories,
      certificateRef: row.certificateRef,
      expiresOn: optionalDate(row.certificateExpiresOn),
      today,
      warningDays: PLANT_LIMITS.certificateWarningDays,
    }),
    active: fromOn <= today && (toOn === null || toOn >= today),
    version: row.version,
    permissions: { canEnd: canEnd && row.endedBy === null },
  };
}

/**
 * Company members who can read plant records on the project (role ∩ assignment): the staff who
 * may operate an item or receive fuel.
 */
export async function plantStaff(scope: Scope, projectId: string) {
  const { tx, access } = scope;
  const [members, assignments] = await Promise.all([
    tx.membership.findMany({
      where: { tenantId: access.tenantId },
      select: { userId: true, ...customRoleColumns, user: { select: { displayName: true } } },
      orderBy: { joinedAt: "asc" },
    }),
    tx.projectMembership.findMany({
      where: { tenantId: access.tenantId, projectId },
      select: { userId: true, permissions: true },
    }),
  ]);
  const assigned = new Map(assignments.map((row) => [row.userId, row.permissions]));
  return members
    .map((member) => ({
      id: member.userId,
      displayName: member.user.displayName,
      effective: effectiveProjectPermissions(grantOf(member), assigned.get(member.userId) ?? null),
    }))
    .filter(
      (member) =>
        member.effective.has("projects.view") &&
        PLANT_READ_PERMISSIONS.some((permission) => member.effective.has(permission)),
    )
    .map(({ id, displayName }) => ({ id, displayName }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}
