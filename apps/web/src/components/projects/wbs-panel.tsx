"use client";

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from "lucide-react";
import { FULL_WEIGHT_BP, MAX_WBS_DEPTH, wbsDepth } from "@pm-buddy/domain";
import {
  messageResponseSchema,
  wbsNodeResponseSchema,
  type WbsNode,
  type WbsResponse,
} from "@pm-buddy/validation";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { formatBasisPoints } from "@/lib/format";
import { liveRequest } from "@/lib/live-api";
import { basisPointsInput, parsePercentToBasisPoints } from "@/lib/project-input";
import { useProblemMessage } from "./use-problem-message";

type Draft = {
  /** The node being edited, or null when adding under `parentId`. */
  node: WbsNode | null;
  parentId: string | null;
  code: string;
  name: string;
  weight: string;
};

const selectClass =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 outline-none";

/**
 * WBS tree editor (D2.1). Sibling weights must add up to exactly 100 % before progress can be
 * computed; until then (and until WBS nodes are linked to measured BQ items) % complete is shown
 * as unavailable.
 * Reordering uses buttons, so the tree is fully keyboard-operable.
 */
export function WbsPanel({
  projectId,
  wbs,
  canManage,
}: {
  projectId: string;
  wbs: WbsResponse;
  canManage: boolean;
}) {
  const t = useTranslations("wbs");
  const problem = useProblemMessage();
  const router = useRouter();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const children = (parentId: string | null) =>
    wbs.nodes
      .filter((node) => node.parentId === parentId)
      .sort((a, b) => a.sortOrder - b.sortOrder);
  const group = (parentId: string | null) =>
    wbs.weights.groups.find((entry) => entry.parentId === parentId);
  const incomplete = wbs.weights.groups.filter((entry) => !entry.complete);
  const nodeName = (id: string | null) =>
    id === null ? t("topLevel") : (wbs.nodes.find((node) => node.id === id)?.code ?? "");

  async function mutate(operation: () => Promise<unknown>, success: string) {
    setBusy(true);
    setMessage(null);
    try {
      await operation();
      setMessage({ error: false, text: success });
      setDraft(null);
      router.refresh();
    } catch (error) {
      setMessage({ error: true, text: problem(error) });
    } finally {
      setBusy(false);
    }
  }

  function move(node: WbsNode, offset: -1 | 1) {
    const siblings = children(node.parentId);
    const index = siblings.findIndex((sibling) => sibling.id === node.id);
    const target = index + offset;
    if (target < 0 || target >= siblings.length) return;
    const order = siblings.map((sibling) => sibling.id);
    [order[index], order[target]] = [order[target]!, order[index]!];
    void mutate(
      () =>
        liveRequest(`/projects/${projectId}/wbs/order`, messageResponseSchema, {
          method: "PUT",
          body: { parentId: node.parentId, nodeIds: order },
        }),
      t("reordered"),
    );
  }

  function save() {
    if (!draft) return;
    const weightBasisPoints = parsePercentToBasisPoints(draft.weight);
    if (weightBasisPoints === undefined || !draft.code.trim() || !draft.name.trim()) {
      setMessage({ error: true, text: t("invalid") });
      return;
    }
    const body: Record<string, unknown> = {
      code: draft.code.trim(),
      name: draft.name.trim(),
      weightBasisPoints,
    };
    if (draft.node) {
      body.version = draft.node.version;
      if (draft.parentId !== draft.node.parentId) body.parentId = draft.parentId;
    } else body.parentId = draft.parentId;
    void mutate(
      () =>
        liveRequest(
          draft.node ? `/projects/${projectId}/wbs/${draft.node.id}` : `/projects/${projectId}/wbs`,
          wbsNodeResponseSchema,
          { method: draft.node ? "PATCH" : "POST", body },
        ),
      t("saved"),
    );
  }

  const form = draft ? (
    <form
      className="grid gap-3 rounded-md border bg-muted/40 p-3 sm:grid-cols-[8rem_1fr_7rem]"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <p className="text-sm font-medium sm:col-span-3">
        {draft.node
          ? t("editTitle", { code: draft.node.code })
          : t("addTitle", { parent: nodeName(draft.parentId) })}
      </p>
      <Field>
        <FieldLabel htmlFor="wbs-code">{t("code")}</FieldLabel>
        <Input
          id="wbs-code"
          value={draft.code}
          onChange={(event) => setDraft({ ...draft, code: event.target.value })}
          maxLength={30}
          required
          autoFocus
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="wbs-name">{t("name")}</FieldLabel>
        <Input
          id="wbs-name"
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          maxLength={150}
          required
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="wbs-weight">{t("weight")}</FieldLabel>
        <Input
          id="wbs-weight"
          inputMode="decimal"
          value={draft.weight}
          onChange={(event) => setDraft({ ...draft, weight: event.target.value })}
          aria-describedby="wbs-weight-hint"
          required
        />
      </Field>
      <p id="wbs-weight-hint" className="text-xs text-muted-foreground sm:col-span-3">
        {t("weightHint")}
      </p>
      {draft.node ? (
        <Field className="sm:col-span-3">
          <FieldLabel htmlFor="wbs-parent">{t("parent")}</FieldLabel>
          <select
            id="wbs-parent"
            className={selectClass}
            value={draft.parentId ?? ""}
            onChange={(event) => setDraft({ ...draft, parentId: event.target.value || null })}
          >
            <option value="">{t("topLevel")}</option>
            {wbs.nodes
              .filter((node) => node.id !== draft.node?.id)
              .map((node) => (
                <option key={node.id} value={node.id}>
                  {node.code} {node.name}
                </option>
              ))}
          </select>
        </Field>
      ) : null}
      <div className="flex gap-2 sm:col-span-3">
        <Button type="submit" size="sm" disabled={busy}>
          {t("save")}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setDraft(null)}>
          {t("cancel")}
        </Button>
      </div>
    </form>
  ) : null;

  const renderLevel = (parentId: string | null): React.ReactNode => {
    const level = children(parentId);
    if (!level.length) return null;
    const sum = group(parentId);
    return (
      <ul className={parentId ? "mt-2 space-y-2 border-l pl-4" : "space-y-2"}>
        {sum && !sum.complete ? (
          <li className="text-xs text-warning-foreground dark:text-warning">
            {t("groupIncomplete", { sum: formatBasisPoints(sum.sumBasisPoints) })}
          </li>
        ) : null}
        {level.map((node, index) => {
          const depth = wbsDepth(wbs.nodes, node.id) ?? MAX_WBS_DEPTH;
          return (
            <li key={node.id}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2">
                <span className="font-mono text-xs text-muted-foreground">{node.code}</span>
                <span className="min-w-0 flex-1 font-medium">{node.name}</span>
                <span className="text-sm tabular-nums">
                  <span aria-hidden>{formatBasisPoints(node.weightBasisPoints)}</span>
                  <span className="sr-only">
                    {t("weightOf", { weight: formatBasisPoints(node.weightBasisPoints) })}
                  </span>
                </span>
                {canManage ? (
                  <span className="flex gap-1">
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("addChild", { code: node.code })}
                      disabled={busy || depth >= MAX_WBS_DEPTH}
                      onClick={() =>
                        setDraft({
                          node: null,
                          parentId: node.id,
                          code: `${node.code}.`,
                          name: "",
                          weight: "",
                        })
                      }
                    >
                      <Plus aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("editNode", { code: node.code })}
                      disabled={busy}
                      onClick={() =>
                        setDraft({
                          node,
                          parentId: node.parentId,
                          code: node.code,
                          name: node.name,
                          weight: basisPointsInput(node.weightBasisPoints),
                        })
                      }
                    >
                      <Pencil aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("moveUp", { code: node.code })}
                      disabled={busy || index === 0}
                      onClick={() => move(node, -1)}
                    >
                      <ArrowUp aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("moveDown", { code: node.code })}
                      disabled={busy || index === level.length - 1}
                      onClick={() => move(node, 1)}
                    >
                      <ArrowDown aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("deleteNode", { code: node.code })}
                      disabled={busy}
                      onClick={() =>
                        void mutate(
                          () =>
                            liveRequest(
                              `/projects/${projectId}/wbs/${node.id}`,
                              messageResponseSchema,
                              {
                                method: "DELETE",
                              },
                            ),
                          t("deleted", { code: node.code }),
                        )
                      }
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </span>
                ) : null}
              </div>
              {draft &&
              (draft.node?.id === node.id || (!draft.node && draft.parentId === node.id)) ? (
                <div className="mt-2">{form}</div>
              ) : null}
              {renderLevel(node.id)}
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("title")}</h2>
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {t("rule", { total: formatBasisPoints(FULL_WEIGHT_BP) })}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">{t("weightsStatus")}</dt>
            <dd>
              {wbs.nodes.length === 0 ? (
                <StatusBadge tone="neutral">{t("noNodes")}</StatusBadge>
              ) : wbs.weights.complete ? (
                <StatusBadge tone="success">{t("weightsComplete")}</StatusBadge>
              ) : (
                <StatusBadge tone="warning">
                  {t("weightsIncomplete", { count: incomplete.length })}
                </StatusBadge>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("progress")}</dt>
            <dd>
              {wbs.progress === null ? (
                <span>
                  {t("unavailable")}{" "}
                  <span className="text-xs text-muted-foreground">
                    {wbs.weights.complete ? t("unavailableMeasurements") : t("unavailableWeights")}
                  </span>
                </span>
              ) : (
                formatBasisPoints(Math.round(wbs.progress * FULL_WEIGHT_BP))
              )}
            </dd>
          </div>
        </dl>
        <p aria-live="polite" className={`text-sm ${message?.error ? "text-destructive" : ""}`}>
          {message?.text}
        </p>
        {wbs.nodes.length ? (
          renderLevel(null)
        ) : (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        )}
        {canManage ? (
          <Fragment>
            {draft && !draft.node && draft.parentId === null ? form : null}
            {!draft ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setDraft({ node: null, parentId: null, code: "", name: "", weight: "" })
                }
              >
                <Plus aria-hidden /> {t("addTop")}
              </Button>
            ) : null}
          </Fragment>
        ) : null}
      </CardContent>
    </Card>
  );
}
