"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  tenantRoleSchema,
  type MembersResponse,
  type PermissionCatalogueResponse,
  type Role,
} from "@pm-buddy/validation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

type Member = MembersResponse["members"][number];
type Permission = Role["permissions"][number];
export type RoleDraft = {
  id: string | null;
  name: string;
  permissions: string[];
  tenantWide: boolean;
};

/** A role's display name: the custom name, or the localised system role. */
export function useRoleLabel() {
  const t = useTranslations("foundation");
  return (role: string, roleName: string | null) => {
    if (roleName) return roleName;
    const system = tenantRoleSchema.safeParse(role);
    return system.success ? t(`roles.${system.data}`) : t("customRole");
  };
}

function RoleForm({
  editing,
  catalogue,
  held,
  heldTenantWide,
  disabled,
  onSave,
  onCancel,
}: {
  editing: Role | null;
  catalogue: PermissionCatalogueResponse;
  held: readonly string[];
  heldTenantWide: boolean;
  disabled: boolean;
  onSave: (draft: RoleDraft) => Promise<boolean>;
  onCancel: () => void;
}) {
  const t = useTranslations("foundation");
  const title =
    editing?.kind === "custom" ? t("editRole", { name: editing.name }) : t("createRole");
  return (
    <form
      aria-labelledby="role-form-title"
      className="space-y-4 rounded border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        void onSave({
          id: editing?.id ?? null,
          name: String(data.get("name") ?? ""),
          permissions: data.getAll("permissions").map(String),
          tenantWide: data.get("tenantWide") === "on",
        });
      }}
    >
      <h3 id="role-form-title" className="font-medium">
        {title}
      </h3>
      <fieldset disabled={disabled} className="space-y-4">
        <Field>
          <FieldLabel htmlFor="role-name">{t("roleName")}</FieldLabel>
          <Input
            id="role-name"
            name="name"
            autoComplete="off"
            minLength={2}
            maxLength={60}
            defaultValue={editing?.kind === "custom" ? editing.name : ""}
            required
          />
        </Field>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="tenantWide"
            className="mt-1"
            defaultChecked={editing?.tenantWide ?? false}
            disabled={!heldTenantWide}
          />
          <span>
            {t("tenantWide")}
            <span className="block text-muted-foreground">{t("tenantWideHint")}</span>
          </span>
        </label>
        <fieldset className="space-y-3">
          <legend className="mb-2 text-sm font-medium">{t("permissionsLegend")}</legend>
          {catalogue.areas.map((area) => {
            const entries = area.permissions.filter((entry) => entry.assignable);
            if (!entries.length) return null;
            return (
              <fieldset key={area.area} className="rounded border p-3">
                <legend className="px-1 text-sm font-medium">
                  {t(`permissionAreas.${area.area}`)}
                </legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {entries.map((entry) => {
                    const notHeld = !held.includes(entry.key);
                    return (
                      <label key={entry.key} className="flex items-start gap-2 text-sm">
                        <input
                          type="checkbox"
                          name="permissions"
                          value={entry.key}
                          className="mt-1"
                          defaultChecked={editing?.permissions.includes(entry.key) ?? false}
                          disabled={notHeld}
                        />
                        <span>
                          {t(`permissionLabels.${entry.key}`)}
                          {entry.mfaRequired ? (
                            <span className="text-muted-foreground"> · {t("needsMfa")}</span>
                          ) : null}
                          {notHeld ? (
                            <span className="text-muted-foreground"> · {t("notHeld")}</span>
                          ) : null}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            );
          })}
        </fieldset>
        <div className="flex flex-wrap gap-2">
          <Button type="submit">{t("saveRole")}</Button>
          {editing ? (
            <Button type="button" variant="outline" onClick={onCancel}>
              {t("cancelEdit")}
            </Button>
          ) : null}
        </div>
      </fieldset>
    </form>
  );
}

/** Roles and permissions: system and custom roles, the custom-role editor and member role changes. */
export function RolesPanel({
  disabled,
  held,
  heldTenantWide,
  canManage,
  roles,
  catalogue,
  members,
  onLoad,
  onSave,
  onDelete,
  onChangeMemberRole,
}: {
  disabled: boolean;
  held: readonly string[];
  heldTenantWide: boolean;
  canManage: boolean;
  roles: Role[];
  catalogue: PermissionCatalogueResponse | null;
  members: Member[];
  onLoad: () => void;
  /** Resolves true once the role was saved. */
  onSave: (draft: RoleDraft) => Promise<boolean>;
  onDelete: (role: Role) => void;
  onChangeMemberRole: (userId: string, role: string) => void;
}) {
  const t = useTranslations("foundation");
  const roleLabel = useRoleLabel();
  const [editing, setEditing] = useState<Role | null>(null);
  // Bumped after a save so the uncontrolled form starts empty again.
  const [version, setVersion] = useState(0);
  const label = (role: Role) => roleLabel(role.id, role.name);
  const permissionLabel = (permission: Permission) => t(`permissionLabels.${permission}`);

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("rolesTitle")}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <p className="text-sm text-muted-foreground">{t("rolesHint")}</p>
        <Button variant="outline" disabled={disabled} onClick={onLoad}>
          {t("loadRoles")}
        </Button>
        {roles.length ? (
          <ul className="space-y-3">
            {roles.map((role) => (
              <li key={role.id} className="space-y-2 rounded border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{label(role)}</span>
                  <Badge variant="outline">
                    {role.kind === "system" ? t("systemRole") : t("customRole")}
                  </Badge>
                  <Badge variant="secondary">
                    {role.tenantWide ? t("companyWide") : t("projectScoped")}
                  </Badge>
                  {role.mfaRequired ? (
                    <Badge variant="outline">{t("mfaRequiredBadge")}</Badge>
                  ) : null}
                  <span className="text-sm text-muted-foreground">
                    {t("memberCount", { count: role.memberCount })}
                  </span>
                </div>
                <details>
                  <summary className="cursor-pointer text-sm">
                    {t("showPermissions", { count: role.permissions.length })}
                  </summary>
                  <ul className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
                    {role.permissions.map((permission) => (
                      <li key={permission}>{permissionLabel(permission)}</li>
                    ))}
                  </ul>
                </details>
                {canManage && role.kind === "custom" ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={disabled || !role.assignable}
                      onClick={() => setEditing(role)}
                    >
                      {t("editRole", { name: role.name })}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={disabled || !role.assignable}
                      onClick={() => {
                        if (editing?.id === role.id) setEditing(null);
                        onDelete(role);
                      }}
                    >
                      {t("deleteRole", { name: role.name })}
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {canManage && catalogue ? (
          <RoleForm
            key={`${editing?.id ?? "new"}-${version}`}
            editing={editing}
            catalogue={catalogue}
            held={held}
            heldTenantWide={heldTenantWide}
            disabled={disabled}
            onCancel={() => setEditing(null)}
            onSave={async (draft) => {
              const saved = await onSave(draft);
              if (saved) {
                setEditing(null);
                setVersion((current) => current + 1);
              }
              return saved;
            }}
          />
        ) : null}
        {canManage && roles.length && members.length ? (
          <form
            aria-labelledby="member-role-title"
            className="space-y-4 rounded border p-4"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              onChangeMemberRole(String(data.get("member") ?? ""), String(data.get("role") ?? ""));
            }}
          >
            <h3 id="member-role-title" className="font-medium">
              {t("changeRole")}
            </h3>
            <p className="text-sm text-muted-foreground">{t("changeRoleHint")}</p>
            <fieldset disabled={disabled} className="space-y-4">
              <Field>
                <FieldLabel htmlFor="member-role-member">{t("member")}</FieldLabel>
                <select
                  id="member-role-member"
                  name="member"
                  required
                  className="h-10 rounded border bg-background px-3"
                >
                  {members.map((member) => (
                    <option key={member.userId} value={member.userId}>
                      {member.user.displayName} ({roleLabel(member.role, member.roleName)})
                    </option>
                  ))}
                </select>
              </Field>
              <Field>
                <FieldLabel htmlFor="member-role-role">{t("newRole")}</FieldLabel>
                <select
                  id="member-role-role"
                  name="role"
                  required
                  className="h-10 rounded border bg-background px-3"
                >
                  {roles
                    .filter((role) => role.assignable)
                    .map((role) => (
                      <option key={role.id} value={role.id}>
                        {label(role)}
                      </option>
                    ))}
                </select>
              </Field>
              <Button type="submit">{t("changeRole")}</Button>
            </fieldset>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}
