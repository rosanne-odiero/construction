"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { UserPlus } from "lucide-react";
import {
  permissionArea,
  PROJECT_ASSIGNABLE_PERMISSIONS,
  SYSTEM_ROLE_PERMISSIONS,
  type Permission,
  type PermissionArea,
} from "@pm-buddy/types";
import {
  messageResponseSchema,
  tenantRoleSchema,
  type ProjectTeamResponse,
} from "@pm-buddy/validation";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { liveRequest } from "@/lib/live-api";
import { useStepUp } from "./step-up";
import { useProblemMessage } from "./use-problem-message";

type Member = ProjectTeamResponse["members"][number];
type Candidate = ProjectTeamResponse["candidates"][number];

const selectClass =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 outline-none";

/** The project permissions a system role carries; null for custom roles (not known here). */
function rolePermissions(role: string): readonly Permission[] | null {
  const system = tenantRoleSchema.safeParse(role);
  return system.success ? SYSTEM_ROLE_PERMISSIONS[system.data] : null;
}

/**
 * Project team (D2.1): members with their company role and effective permissions (role ∩
 * assignment). Assigning needs users.invite and projects.manage plus a fresh MFA step-up; only
 * permissions the caller holds on this project are offered, and the API enforces the same rule.
 */
export function TeamPanel({ projectId, team }: { projectId: string; team: ProjectTeamResponse }) {
  const t = useTranslations("team");
  const tPermissions = useTranslations("foundation");
  const problem = useProblemMessage();
  const router = useRouter();
  const stepUp = useStepUp();
  const [editing, setEditing] = useState<{
    userId: string;
    name: string;
    role: string;
    permissions: Permission[];
  } | null>(null);
  const [candidate, setCandidate] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const label = (permission: Permission) => tPermissions(`permissionLabels.${permission}`);
  const roleLabel = (member: { role: string; roleName: string | null }) => {
    if (member.roleName) return member.roleName;
    const system = tenantRoleSchema.safeParse(member.role);
    return system.success ? tPermissions(`roles.${system.data}`) : tPermissions("customRole");
  };

  function startEditing(person: Member | Candidate) {
    const role = rolePermissions(person.role);
    const assignment = "assignment" in person ? person.assignment : null;
    setMessage(null);
    setEditing({
      userId: person.userId,
      name: person.displayName,
      role: person.role,
      permissions:
        assignment ??
        team.grantable.filter((permission) =>
          role ? role.includes(permission) : permission === "projects.view",
        ),
    });
  }

  async function mutate(operation: () => Promise<unknown>, success: string) {
    setBusy(true);
    setMessage(null);
    try {
      await stepUp.run(operation);
      setMessage({ error: false, text: success });
      setEditing(null);
      setCandidate("");
      router.refresh();
    } catch (error) {
      setMessage({ error: true, text: problem(error) });
    } finally {
      setBusy(false);
    }
  }

  const grantableByArea = PROJECT_ASSIGNABLE_PERMISSIONS.filter((permission) =>
    team.grantable.includes(permission),
  ).reduce<Record<string, Permission[]>>((groups, permission) => {
    (groups[permissionArea(permission)] ??= []).push(permission);
    return groups;
  }, {});
  const editingRole = editing ? rolePermissions(editing.role) : null;

  return (
    <div className="space-y-4">
      <p aria-live="polite" className={`text-sm ${message?.error ? "text-destructive" : ""}`}>
        {message?.text}
      </p>
      <Card>
        <CardContent className="relative overflow-x-auto p-0">
          <table className="w-full text-sm">
            <caption className="sr-only">{t("tableCaption")}</caption>
            <thead className="border-b text-left text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">
                  {t("name")}
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  {t("role")}
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  {t("access")}
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  {t("effective")}
                </th>
                {team.canAssign ? (
                  <th scope="col" className="px-4 py-2 font-medium">
                    <span className="sr-only">{t("actions")}</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody className="divide-y">
              {team.members.map((member) => (
                <tr key={member.userId} className="align-top">
                  <td className="px-4 py-3 font-medium">{member.displayName}</td>
                  <td className="px-4 py-3">{roleLabel(member)}</td>
                  <td className="px-4 py-3">
                    {member.companyWide ? (
                      <StatusBadge tone="info">{t("companyWide")}</StatusBadge>
                    ) : (
                      <StatusBadge tone="neutral">{t("assigned")}</StatusBadge>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <details>
                      <summary className="cursor-pointer">
                        {t("permissionCount", { count: member.effective.length })}
                      </summary>
                      <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs">
                        {member.effective.map((permission) => (
                          <li key={permission}>{label(permission)}</li>
                        ))}
                      </ul>
                    </details>
                  </td>
                  {team.canAssign ? (
                    <td className="space-x-2 px-4 py-3 whitespace-nowrap">
                      {!member.companyWide ? (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            aria-label={t("editNamed", { name: member.displayName })}
                            onClick={() => startEditing(member)}
                          >
                            {t("edit")}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            aria-label={t("removeNamed", { name: member.displayName })}
                            onClick={() =>
                              void mutate(
                                () =>
                                  liveRequest(
                                    `/projects/${projectId}/members/${member.userId}`,
                                    messageResponseSchema,
                                    { method: "DELETE" },
                                  ),
                                t("removed", { name: member.displayName }),
                              )
                            }
                          >
                            {t("remove")}
                          </Button>
                        </>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {team.canAssign && !editing ? (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const person = team.candidates.find((entry) => entry.userId === candidate);
            if (person) startEditing(person);
          }}
        >
          <Field className="min-w-56 flex-1 sm:max-w-sm">
            <FieldLabel htmlFor="team-candidate">{t("addMember")}</FieldLabel>
            <select
              id="team-candidate"
              className={selectClass}
              value={candidate}
              onChange={(event) => setCandidate(event.target.value)}
            >
              <option value="">
                {team.candidates.length ? t("chooseMember") : t("noCandidates")}
              </option>
              {team.candidates.map((person) => (
                <option key={person.userId} value={person.userId}>
                  {person.displayName} ({roleLabel(person)})
                </option>
              ))}
            </select>
          </Field>
          <Button type="submit" variant="outline" disabled={!candidate}>
            <UserPlus aria-hidden /> {t("choosePermissions")}
          </Button>
        </form>
      ) : null}

      {editing ? (
        <Card>
          <CardHeader>
            <CardTitle>
              <h3>{t("assignTitle", { name: editing.name })}</h3>
            </CardTitle>
            <p className="text-sm text-muted-foreground">{t("assignHint")}</p>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void mutate(
                  () =>
                    liveRequest(
                      `/projects/${projectId}/members/${editing.userId}`,
                      messageResponseSchema,
                      {
                        method: "PUT",
                        body: { permissions: editing.permissions },
                      },
                    ),
                  t("saved", { name: editing.name }),
                );
              }}
            >
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {Object.entries(grantableByArea).map(([area, permissions]) => (
                  <fieldset key={area} className="space-y-1.5">
                    <legend className="mb-1 text-sm font-medium">
                      {tPermissions(`permissionAreas.${area as PermissionArea}`)}
                    </legend>
                    {permissions.map((permission) => {
                      const outsideRole = editingRole !== null && !editingRole.includes(permission);
                      return (
                        <label key={permission} className="flex items-start gap-2 text-sm">
                          <input
                            type="checkbox"
                            className="mt-0.5 size-4 accent-primary"
                            checked={editing.permissions.includes(permission)}
                            onChange={(event) =>
                              setEditing({
                                ...editing,
                                permissions: event.target.checked
                                  ? PROJECT_ASSIGNABLE_PERMISSIONS.filter(
                                      (key) =>
                                        key === permission || editing.permissions.includes(key),
                                    )
                                  : editing.permissions.filter((key) => key !== permission),
                              })
                            }
                          />
                          <span>
                            {label(permission)}
                            {outsideRole ? (
                              <span className="block text-xs text-muted-foreground">
                                {t("notInRole")}
                              </span>
                            ) : null}
                          </span>
                        </label>
                      );
                    })}
                  </fieldset>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={busy}>
                  {t("save")}
                </Button>
                <Button type="button" variant="outline" onClick={() => setEditing(null)}>
                  {t("cancel")}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}
      {stepUp.dialog}
    </div>
  );
}
