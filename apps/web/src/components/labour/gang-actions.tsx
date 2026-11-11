"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Plus } from "lucide-react";
import { nairobiDate } from "@pm-buddy/domain";
import { gangDetailResponseSchema, type GangDetailResponse } from "@pm-buddy/validation";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { liveRequest } from "@/lib/live-api";
import { calendarInput, parseCalendarInput } from "@/lib/project-input";
import { ActionDialog, selectClass } from "./action-dialog";

type ProjectOption = { id: string; code: string; name: string };
type Option = { id: string; label: string };

export function CreateGangButton({ projects }: { projects: ProjectOption[] }) {
  const t = useTranslations("labourLive.gangs");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [name, setName] = useState("");
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus aria-hidden /> {t("create")}
      </Button>
      <ActionDialog
        id="create-gang-form"
        open={open}
        onOpenChange={setOpen}
        title={t("createTitle")}
        description={t("createHint")}
        submitLabel={t("create")}
        submitDisabled={!projectId || name.trim().length < 2}
        onSubmit={async () => {
          const result = await liveRequest("/labour/gangs", gangDetailResponseSchema, {
            method: "POST",
            body: { projectId, name: name.trim() },
          });
          router.push(`/labour/gangs/${result.gang.id}`);
        }}
      >
        <Field>
          <FieldLabel htmlFor="gang-project">{t("project")}</FieldLabel>
          <select
            id="gang-project"
            className={selectClass}
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.code} · {project.name}
              </option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor="gang-name">{t("name")}</FieldLabel>
          <Input
            id="gang-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            required
          />
        </Field>
      </ActionDialog>
    </>
  );
}

/** Rename, move to a site, or archive (labour.manage on the gang's project). */
export function EditGangButton({
  gang,
  sites,
}: {
  gang: GangDetailResponse["gang"];
  sites: Option[];
}) {
  const t = useTranslations("labourLive.gangs");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(gang.name);
  const [siteId, setSiteId] = useState(gang.siteId ?? "");
  const [archived, setArchived] = useState(gang.status === "archived");
  const changes = {
    ...(name.trim() !== gang.name ? { name: name.trim() } : {}),
    ...(siteId !== (gang.siteId ?? "") ? { siteId: siteId || null } : {}),
    ...(archived !== (gang.status === "archived")
      ? { status: archived ? "archived" : "active" }
      : {}),
  };
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        {t("edit")}
      </Button>
      <ActionDialog
        id="edit-gang-form"
        open={open}
        onOpenChange={setOpen}
        title={t("editTitle")}
        description={t("editHint")}
        submitLabel={t("save")}
        submitDisabled={!Object.keys(changes).length || name.trim().length < 2}
        onSubmit={async () => {
          await liveRequest(`/labour/gangs/${gang.id}`, gangDetailResponseSchema, {
            method: "PATCH",
            body: { ...changes, version: gang.version },
          });
          router.refresh();
        }}
      >
        <Field>
          <FieldLabel htmlFor="edit-gang-name">{t("name")}</FieldLabel>
          <Input
            id="edit-gang-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="edit-gang-site">{t("site")}</FieldLabel>
          <select
            id="edit-gang-site"
            className={selectClass}
            value={siteId}
            onChange={(event) => setSiteId(event.target.value)}
          >
            <option value="">{t("noSite")}</option>
            {sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.label}
              </option>
            ))}
          </select>
        </Field>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={archived}
            onChange={(event) => setArchived(event.target.checked)}
            className="mt-0.5 size-4 accent-primary"
          />
          <span>
            {t("archive")}
            <span className="block text-xs text-muted-foreground">{t("archiveHint")}</span>
          </span>
        </label>
      </ActionDialog>
    </>
  );
}

export function AddMemberButton({ gangId, candidates }: { gangId: string; candidates: Option[] }) {
  const t = useTranslations("labourLive.gangs");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [labourerId, setLabourerId] = useState(candidates[0]?.id ?? "");
  const [joined, setJoined] = useState(calendarInput(nairobiDate()));
  const joinedOn = parseCalendarInput(joined);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)} disabled={!candidates.length}>
        <Plus aria-hidden /> {t("addMember")}
      </Button>
      <ActionDialog
        id="add-member-form"
        open={open}
        onOpenChange={setOpen}
        title={t("addMember")}
        description={t("addMemberHint")}
        submitLabel={t("addMember")}
        submitDisabled={!labourerId || !joinedOn}
        onSubmit={async () => {
          await liveRequest(`/labour/gangs/${gangId}/members`, gangDetailResponseSchema, {
            method: "POST",
            body: { labourerId, joinedOn: joinedOn ?? undefined },
          });
          router.refresh();
        }}
      >
        <Field>
          <FieldLabel htmlFor="member-labourer">{t("worker")}</FieldLabel>
          <select
            id="member-labourer"
            className={selectClass}
            value={labourerId}
            onChange={(event) => setLabourerId(event.target.value)}
          >
            {candidates.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.label}
              </option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor="member-joined">{t("joinedOn")}</FieldLabel>
          <Input
            id="member-joined"
            value={joined}
            onChange={(event) => setJoined(event.target.value)}
            inputMode="numeric"
            aria-describedby="member-joined-hint"
          />
          <FieldDescription id="member-joined-hint">{t("dateHint")}</FieldDescription>
        </Field>
      </ActionDialog>
    </>
  );
}

export function MemberActions({
  gang,
  member,
}: {
  gang: GangDetailResponse["gang"];
  member: GangDetailResponse["members"][number];
}) {
  const t = useTranslations("labourLive.gangs");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [left, setLeft] = useState(calendarInput(nairobiDate()));
  const leftOn = parseCalendarInput(left);
  const isLeader = gang.leader?.labourerId === member.labourerId;
  const problem = useProblemMessage();
  const [failure, setFailure] = useState<string | null>(null);
  return (
    <span className="flex flex-wrap justify-end gap-1.5">
      {!isLeader ? (
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            setFailure(null);
            void liveRequest(`/labour/gangs/${gang.id}`, gangDetailResponseSchema, {
              method: "PATCH",
              body: { leaderLabourerId: member.labourerId, version: gang.version },
            })
              .then(() => router.refresh())
              .catch((error: unknown) => setFailure(problem(error)));
          }}
        >
          {t("makeLeader")}
          <span className="sr-only">: {member.fullName}</span>
        </Button>
      ) : null}
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        {t("leave")}
        <span className="sr-only">: {member.fullName}</span>
      </Button>
      {failure ? (
        <span role="alert" className="w-full text-right text-xs text-destructive">
          {failure}
        </span>
      ) : null}
      <ActionDialog
        id={`leave-${member.membershipId}`}
        open={open}
        onOpenChange={setOpen}
        title={t("leaveTitle", { name: member.fullName })}
        description={isLeader ? t("leaderLeaveHint") : t("leaveHint")}
        submitLabel={t("leave")}
        submitDisabled={!leftOn}
        onSubmit={async () => {
          await liveRequest(
            `/labour/gangs/${gang.id}/members/${member.membershipId}/leave`,
            gangDetailResponseSchema,
            { method: "POST", body: { leftOn: leftOn ?? undefined } },
          );
          router.refresh();
        }}
      >
        <Field>
          <FieldLabel htmlFor={`left-${member.membershipId}`}>{t("leftOn")}</FieldLabel>
          <Input
            id={`left-${member.membershipId}`}
            value={left}
            onChange={(event) => setLeft(event.target.value)}
            inputMode="numeric"
          />
        </Field>
      </ActionDialog>
    </span>
  );
}
