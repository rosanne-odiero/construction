"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Plus } from "lucide-react";
import {
  allowedMilestoneTransitions,
  nairobiDate,
  REASON_LIMITS,
  type MilestoneTransition,
} from "@pm-buddy/domain";
import type { MilestoneStatus } from "@pm-buddy/types";
import {
  messageResponseSchema,
  milestoneResponseSchema,
  type Milestone,
  type WbsNode,
} from "@pm-buddy/validation";
import { StatusBadge, type Tone } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatCalendarDate } from "@/lib/format";
import { liveRequest } from "@/lib/live-api";
import { calendarInput, parseCalendarInput } from "@/lib/project-input";
import { useProblemMessage } from "./use-problem-message";

const tones: Record<MilestoneStatus, Tone> = {
  planned: "neutral",
  in_progress: "info",
  achieved: "success",
  cancelled: "danger",
};
const selectClass =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 outline-none";

type Draft = { milestone: Milestone | null; name: string; dueDate: string; wbsNodeId: string };

/** Milestones with an explicit lifecycle (planned → in progress → achieved; cancel; reopen). */
export function MilestonesPanel({
  projectId,
  milestones,
  nodes,
  canManage,
}: {
  projectId: string;
  milestones: Milestone[];
  nodes: WbsNode[];
  canManage: boolean;
}) {
  const t = useTranslations("liveMilestones");
  const tStatus = useTranslations("milestoneStatus");
  const problem = useProblemMessage();
  const router = useRouter();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [change, setChange] = useState<{
    milestone: Milestone;
    transition: MilestoneTransition;
  } | null>(null);
  const [reason, setReason] = useState("");
  const [actualDate, setActualDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const today = nairobiDate();
  const code = (id: string | null) => nodes.find((node) => node.id === id)?.code ?? "—";

  async function mutate(operation: () => Promise<unknown>, success: string) {
    setBusy(true);
    setMessage(null);
    try {
      await operation();
      setMessage({ error: false, text: success });
      setDraft(null);
      setChange(null);
      router.refresh();
    } catch (error) {
      setMessage({ error: true, text: problem(error) });
    } finally {
      setBusy(false);
    }
  }

  function saveDraft() {
    if (!draft) return;
    const dueDate = parseCalendarInput(draft.dueDate);
    if (!draft.name.trim() || !dueDate) {
      setMessage({ error: true, text: t("invalid") });
      return;
    }
    const body: Record<string, unknown> = {
      name: draft.name.trim(),
      dueDate,
      wbsNodeId: draft.wbsNodeId || null,
    };
    if (draft.milestone) body.version = draft.milestone.version;
    void mutate(
      () =>
        liveRequest(
          draft.milestone
            ? `/projects/${projectId}/milestones/${draft.milestone.id}`
            : `/projects/${projectId}/milestones`,
          milestoneResponseSchema,
          { method: draft.milestone ? "PATCH" : "POST", body },
        ),
      t("saved"),
    );
  }

  function submitChange() {
    if (!change) return;
    const achieved = change.transition.action === "achieve";
    const date = achieved ? parseCalendarInput(actualDate) : null;
    if (achieved && !date) {
      setMessage({ error: true, text: t("actualDateInvalid") });
      return;
    }
    void mutate(
      () =>
        liveRequest(
          `/projects/${projectId}/milestones/${change.milestone.id}/status`,
          milestoneResponseSchema,
          {
            method: "POST",
            body: {
              to: change.transition.to,
              version: change.milestone.version,
              ...(reason.trim() ? { reason: reason.trim() } : {}),
              ...(date ? { actualDate: date } : {}),
            },
          },
        ),
      t("statusChanged"),
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("title")}</h2>
        </CardTitle>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <p aria-live="polite" className={`text-sm ${message?.error ? "text-destructive" : ""}`}>
          {message?.text}
        </p>
        {milestones.length ? (
          <div className="relative overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">{t("title")}</caption>
              <thead className="border-b text-left text-muted-foreground">
                <tr>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    {t("name")}
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    {t("dueDate")}
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    {t("wbsNode")}
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    {t("status")}
                  </th>
                  {canManage ? (
                    <th scope="col" className="py-2 font-medium">
                      <span className="sr-only">{t("actionsColumn")}</span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody className="divide-y">
                {milestones.map((milestone) => {
                  const overdue =
                    milestone.dueDate < today &&
                    (milestone.status === "planned" || milestone.status === "in_progress");
                  return (
                    <tr key={milestone.id} className="align-top">
                      <td className="py-2 pr-3">
                        <span className="font-medium">{milestone.name}</span>
                        {milestone.statusReason ? (
                          <span className="block text-xs text-muted-foreground">
                            {milestone.statusReason}
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2 pr-3 tabular-nums">
                        {formatCalendarDate(milestone.dueDate)}
                        {milestone.actualDate ? (
                          <span className="block text-xs text-muted-foreground">
                            {t("achievedOn", { date: formatCalendarDate(milestone.actualDate) })}
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2 pr-3 font-mono text-xs">{code(milestone.wbsNodeId)}</td>
                      <td className="space-x-1 py-2 pr-3">
                        <StatusBadge tone={tones[milestone.status]}>
                          {tStatus(milestone.status)}
                        </StatusBadge>
                        {overdue ? <StatusBadge tone="warning">{t("overdue")}</StatusBadge> : null}
                      </td>
                      {canManage ? (
                        <td className="py-2">
                          <div className="flex flex-wrap gap-1">
                            {allowedMilestoneTransitions(milestone.status).map((transition) => (
                              <Button
                                key={transition.to}
                                size="sm"
                                variant="outline"
                                disabled={busy}
                                aria-label={t("actionNamed", {
                                  action: t(`actions.${transition.action}`),
                                  name: milestone.name,
                                })}
                                onClick={() => {
                                  setReason("");
                                  setActualDate(calendarInput(today));
                                  setChange({ milestone, transition });
                                }}
                              >
                                {t(`actions.${transition.action}`)}
                              </Button>
                            ))}
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              aria-label={t("editNamed", { name: milestone.name })}
                              onClick={() =>
                                setDraft({
                                  milestone,
                                  name: milestone.name,
                                  dueDate: calendarInput(milestone.dueDate),
                                  wbsNodeId: milestone.wbsNodeId ?? "",
                                })
                              }
                            >
                              {t("edit")}
                            </Button>
                            {milestone.status === "planned" ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                aria-label={t("deleteNamed", { name: milestone.name })}
                                onClick={() =>
                                  void mutate(
                                    () =>
                                      liveRequest(
                                        `/projects/${projectId}/milestones/${milestone.id}`,
                                        messageResponseSchema,
                                        { method: "DELETE" },
                                      ),
                                    t("deleted"),
                                  )
                                }
                              >
                                {t("delete")}
                              </Button>
                            ) : null}
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        )}

        {canManage && draft ? (
          <form
            className="grid gap-3 rounded-md border bg-muted/40 p-3 sm:grid-cols-3"
            onSubmit={(event) => {
              event.preventDefault();
              saveDraft();
            }}
          >
            <p className="text-sm font-medium sm:col-span-3">
              {draft.milestone ? t("editTitle", { name: draft.milestone.name }) : t("addTitle")}
            </p>
            <Field>
              <FieldLabel htmlFor="milestone-name">{t("name")}</FieldLabel>
              <Input
                id="milestone-name"
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                maxLength={150}
                required
                autoFocus
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="milestone-due">{t("dueDate")}</FieldLabel>
              <Input
                id="milestone-due"
                value={draft.dueDate}
                onChange={(event) => setDraft({ ...draft, dueDate: event.target.value })}
                placeholder="DD/MM/YYYY"
                aria-describedby="milestone-due-hint"
                required
              />
              <FieldDescription id="milestone-due-hint">{t("dateHint")}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="milestone-node">{t("wbsNode")}</FieldLabel>
              <select
                id="milestone-node"
                className={selectClass}
                value={draft.wbsNodeId}
                onChange={(event) => setDraft({ ...draft, wbsNodeId: event.target.value })}
              >
                <option value="">{t("noNode")}</option>
                {nodes.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.code} {node.name}
                  </option>
                ))}
              </select>
            </Field>
            <div className="flex gap-2 sm:col-span-3">
              <Button type="submit" size="sm" disabled={busy}>
                {t("save")}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setDraft(null)}>
                {t("cancel")}
              </Button>
            </div>
          </form>
        ) : null}
        {canManage && !draft ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setDraft({ milestone: null, name: "", dueDate: "", wbsNodeId: "" })}
          >
            <Plus aria-hidden /> {t("add")}
          </Button>
        ) : null}
      </CardContent>

      <Dialog open={change !== null} onOpenChange={(open) => (open ? undefined : setChange(null))}>
        <DialogContent showCloseButton={false}>
          {change ? (
            <>
              <DialogHeader>
                <DialogTitle>{t(`actions.${change.transition.action}`)}</DialogTitle>
                <DialogDescription>
                  {t("changeDescription", {
                    name: change.milestone.name,
                    from: tStatus(change.milestone.status),
                    to: tStatus(change.transition.to),
                  })}
                </DialogDescription>
              </DialogHeader>
              <form
                id="milestone-status-form"
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  submitChange();
                }}
              >
                {message?.error ? (
                  <p role="alert" className="text-sm text-destructive">
                    {message.text}
                  </p>
                ) : null}
                {change.transition.action === "achieve" ? (
                  <Field>
                    <FieldLabel htmlFor="milestone-actual">{t("actualDate")}</FieldLabel>
                    <Input
                      id="milestone-actual"
                      value={actualDate}
                      onChange={(event) => setActualDate(event.target.value)}
                      aria-describedby="milestone-actual-hint"
                      required
                    />
                    <FieldDescription id="milestone-actual-hint">
                      {t("actualDateHint")}
                    </FieldDescription>
                  </Field>
                ) : null}
                <Field>
                  <FieldLabel htmlFor="milestone-reason">{t("reason")}</FieldLabel>
                  <Textarea
                    id="milestone-reason"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    maxLength={REASON_LIMITS.max}
                    required={change.transition.reasonRequired}
                    rows={3}
                    aria-describedby="milestone-reason-hint"
                  />
                  <FieldDescription id="milestone-reason-hint">
                    {change.transition.reasonRequired ? t("reasonRequired") : t("reasonOptional")}
                  </FieldDescription>
                </Field>
              </form>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setChange(null)}>
                  {t("cancel")}
                </Button>
                <Button
                  type="submit"
                  form="milestone-status-form"
                  disabled={
                    busy ||
                    (change.transition.reasonRequired && reason.trim().length < REASON_LIMITS.min)
                  }
                >
                  {t("confirm")}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
