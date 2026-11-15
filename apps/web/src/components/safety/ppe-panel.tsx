"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Plus } from "lucide-react";
import { PPE_ITEMS, PPE_RETURN_CONDITIONS, type PpeItem } from "@pm-buddy/types";
import {
  issuePpeRequestSchema,
  ppeIssueResponseSchema,
  returnPpeRequestSchema,
  voidRequestSchema,
  type PpeIssue,
  type PpeIssuesResponse,
  type SafetyLabourer,
  type Site,
} from "@pm-buddy/validation";
import {
  FormError,
  selectClass,
  useScheduleMutation,
} from "@/components/schedule/use-schedule-mutation";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { formatCalendarDate } from "@/lib/format";
import { liveRequest } from "@/lib/live-api";
import { parseCalendarInput } from "@/lib/project-input";
import { parseWholeNumber, ppeStateTone, safetyHref } from "@/lib/safety";
import { field, Pager, ReasonDialog } from "./common";
import { LabourerPicker } from "./labourer-picker";

export type PpeFilters = {
  siteId?: string;
  item?: string;
  status?: string;
  search?: string;
  cursor?: string;
};
type Mode =
  | { kind: "issue" }
  | { kind: "replace"; issue: PpeIssue }
  | { kind: "return"; issue: PpeIssue }
  | { kind: "void"; issue: PpeIssue };

/** The PPE register (D8.2): items still issued first, soonest replacement first. */
export function PpePanel({
  projectId,
  data,
  sites,
  filters,
  today,
}: {
  projectId: string;
  data: PpeIssuesResponse;
  sites: Site[];
  filters: PpeFilters;
  today: string;
}) {
  const t = useTranslations("safety");
  const { busy, error, setError, run } = useScheduleMutation();
  const [mode, setMode] = useState<Mode | null>(null);
  const [siteId, setSiteId] = useState(filters.siteId ?? sites[0]?.id ?? "");
  const [labourer, setLabourer] = useState<SafetyLabourer | null>(null);
  const kept = {
    siteId: filters.siteId,
    item: filters.item,
    status: filters.status,
    search: filters.search,
  };
  const open = (next: Mode) => {
    setError(null);
    setLabourer(next.kind === "replace" ? next.issue.labourer : null);
    if (next.kind === "replace") setSiteId(next.issue.siteId);
    setMode(next);
  };
  const itemName = (item: PpeItem) => t(`ppeItem.${item}`);
  const todayIso = parseCalendarInput(today)!;

  function issue(form: FormData) {
    const issuedOn = parseCalendarInput(field(form, "issuedOn"));
    const quantity = parseWholeNumber(field(form, "quantity"), 1, 20);
    const replaces = mode?.kind === "replace" ? mode.issue : null;
    const parsed = issuePpeRequestSchema.safeParse({
      siteId,
      labourerId: labourer?.id,
      item: replaces?.item ?? form.get("item"),
      size: field(form, "size"),
      quantity,
      issuedOn,
      ...(replaces ? { replacesIssueId: replaces.id } : {}),
    });
    if (!parsed.success || !issuedOn || issuedOn > todayIso) {
      setError(t("ppe.invalid"));
      return;
    }
    void run(
      () =>
        liveRequest(`/projects/${projectId}/safety/ppe`, ppeIssueResponseSchema, {
          method: "POST",
          body: parsed.data,
        }),
      () => setMode(null),
    );
  }

  function returnIssue(form: FormData, target: PpeIssue) {
    const returnedOn = parseCalendarInput(field(form, "returnedOn"));
    const parsed = returnPpeRequestSchema.safeParse({
      version: target.version,
      returnedOn,
      condition: form.get("condition"),
    });
    if (!parsed.success || !returnedOn || returnedOn > todayIso || returnedOn < target.issuedOn) {
      setError(t("ppe.returnInvalid"));
      return;
    }
    void run(
      () =>
        liveRequest(
          `/projects/${projectId}/safety/ppe/${target.id}/return`,
          ppeIssueResponseSchema,
          { method: "POST", body: parsed.data },
        ),
      () => setMode(null),
    );
  }

  return (
    <section aria-labelledby="ppe-heading" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-1">
          <h3 id="ppe-heading" className="text-base font-semibold">
            {t("ppe.title")}
          </h3>
          <p className="text-sm text-muted-foreground">{t("ppe.hint")}</p>
        </div>
        {data.permissions.canIssue && sites.length ? (
          <Button onClick={() => open({ kind: "issue" })}>
            <Plus className="size-4" aria-hidden />
            {t("ppe.issue")}
          </Button>
        ) : null}
      </div>
      <ul className="flex flex-wrap gap-2" aria-label={t("ppe.countsLabel")}>
        <li>
          <StatusBadge
            tone={data.counts.due ? "danger" : "neutral"}
            className="h-auto whitespace-normal"
          >
            {t("ppe.countDue", { count: data.counts.due })}
          </StatusBadge>
        </li>
        <li>
          <StatusBadge
            tone={data.counts.dueSoon ? "warning" : "neutral"}
            className="h-auto whitespace-normal"
          >
            {t("ppe.countDueSoon", { count: data.counts.dueSoon })}
          </StatusBadge>
        </li>
        <li>
          <StatusBadge tone="info" className="h-auto whitespace-normal">
            {t("ppe.countIssued", { count: data.counts.issued })}
          </StatusBadge>
        </li>
      </ul>
      <form
        method="get"
        action={`/projects/${projectId}`}
        className="grid grid-cols-1 gap-3 rounded-md border p-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_2fr_auto] lg:items-end"
      >
        <input type="hidden" name="tab" value="safety" />
        <input type="hidden" name="view" value="ppe" />
        <Field>
          <FieldLabel htmlFor="ppe-status">{t("filters.status")}</FieldLabel>
          <select
            id="ppe-status"
            name="status"
            defaultValue={filters.status ?? ""}
            className={selectClass}
          >
            <option value="">{t("filters.all")}</option>
            <option value="due">{t("ppe.dueFilter")}</option>
            {(["issued", "returned", "replaced", "voided"] as const).map((status) => (
              <option key={status} value={status}>
                {t(`ppeStatus.${status}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor="ppe-item">{t("filters.item")}</FieldLabel>
          <select
            id="ppe-item"
            name="item"
            defaultValue={filters.item ?? ""}
            className={selectClass}
          >
            <option value="">{t("filters.all")}</option>
            {PPE_ITEMS.map((item) => (
              <option key={item} value={item}>
                {itemName(item)}
              </option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor="ppe-site">{t("filters.site")}</FieldLabel>
          <select
            id="ppe-site"
            name="siteId"
            defaultValue={filters.siteId ?? ""}
            className={selectClass}
          >
            <option value="">{t("filters.allSites")}</option>
            {sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.name}
              </option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor="ppe-search">{t("filters.search")}</FieldLabel>
          <Input
            id="ppe-search"
            name="search"
            type="search"
            maxLength={100}
            defaultValue={filters.search ?? ""}
            placeholder={t("ppe.searchPlaceholder")}
          />
        </Field>
        <Button type="submit" variant="outline">
          {t("filters.apply")}
        </Button>
      </form>
      {data.issues.length ? (
        <ul className="divide-y rounded-md border">
          {data.issues.map((entry) => {
            const name = entry.labourer.fullName;
            const item = itemName(entry.item);
            return (
              <li
                key={entry.id}
                aria-label={t("ppe.rowLabel", { item, name })}
                className="space-y-2 p-3"
              >
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{item}</span>
                  {entry.size ? <span className="text-sm">({entry.size})</span> : null}
                  <span className="text-sm">× {entry.quantity}</span>
                  {entry.replacementState ? (
                    <StatusBadge
                      tone={ppeStateTone[entry.replacementState]}
                      className="h-auto whitespace-normal"
                    >
                      {t(`ppeState.${entry.replacementState}`)}
                    </StatusBadge>
                  ) : (
                    <StatusBadge tone="neutral" className="h-auto whitespace-normal">
                      {t(`ppeStatus.${entry.status}`)}
                    </StatusBadge>
                  )}
                </p>
                <p className="text-sm break-words">
                  <span className="font-mono text-xs text-muted-foreground">
                    {entry.labourer.workerNo}
                  </span>{" "}
                  {name} · {entry.siteName}
                </p>
                <p className="text-sm break-words text-muted-foreground">
                  {t("ppe.issued", { date: formatCalendarDate(entry.issuedOn) })}
                  {entry.status === "issued"
                    ? ` · ${t("ppe.replacementDue", { date: formatCalendarDate(entry.replacementDueOn) })}`
                    : ""}
                  {entry.returnedOn && entry.returnCondition
                    ? ` · ${t("ppe.returned", {
                        date: formatCalendarDate(entry.returnedOn),
                        condition: t(`returnCondition.${entry.returnCondition}`),
                      })}`
                    : ""}
                  {entry.status === "replaced" ? ` · ${t("ppe.replacedNote")}` : ""}
                </p>
                {entry.voidReason ? (
                  <p className="text-sm break-words">{entry.voidReason}</p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {entry.permissions.canReplace ? (
                    <Button
                      size="sm"
                      variant={entry.replacementState === "due" ? "default" : "outline"}
                      className="h-auto min-h-8 max-w-full whitespace-normal"
                      onClick={() => open({ kind: "replace", issue: entry })}
                    >
                      {t("ppe.replace", { item, name })}
                    </Button>
                  ) : null}
                  {entry.permissions.canReturn ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-auto min-h-8 max-w-full whitespace-normal"
                      onClick={() => open({ kind: "return", issue: entry })}
                    >
                      {t("ppe.return", { item, name })}
                    </Button>
                  ) : null}
                  {entry.permissions.canVoid ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-auto min-h-8 max-w-full whitespace-normal"
                      onClick={() => open({ kind: "void", issue: entry })}
                    >
                      {t("ppe.void", { item, name })}
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{t("ppe.empty")}</p>
      )}
      <Pager
        label={t("ppe.pages")}
        offset
        firstHref={filters.cursor ? safetyHref(projectId, "ppe", kept) : null}
        nextHref={
          data.nextCursor !== null
            ? safetyHref(projectId, "ppe", { ...kept, cursor: String(data.nextCursor) })
            : null
        }
      />
      <ReasonDialog
        open={mode?.kind === "void"}
        title={t("ppe.voidTitle")}
        hint={t("ppe.voidHint")}
        busy={busy}
        error={error}
        onOpenChange={(next) => {
          if (!next) setMode(null);
        }}
        onSubmit={(reason) => {
          if (mode?.kind !== "void") return;
          const parsed = voidRequestSchema.safeParse({ version: mode.issue.version, reason });
          if (!parsed.success) return setError(t("actions.reasonInvalid"));
          void run(
            () =>
              liveRequest(
                `/projects/${projectId}/safety/ppe/${mode.issue.id}/void`,
                ppeIssueResponseSchema,
                { method: "POST", body: parsed.data },
              ),
            () => setMode(null),
          );
        }}
      />
      <Dialog
        open={mode !== null && mode.kind !== "void"}
        onOpenChange={(next) => {
          if (!busy && !next) setMode(null);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {mode?.kind === "return"
                ? t("ppe.returnTitle")
                : mode?.kind === "replace"
                  ? t("ppe.replaceTitle")
                  : t("ppe.issue")}
            </DialogTitle>
            <DialogDescription>
              {mode?.kind === "return" || mode?.kind === "replace"
                ? t("ppe.rowLabel", {
                    item: itemName(mode.issue.item),
                    name: mode.issue.labourer.fullName,
                  })
                : t("ppe.issueHint")}
            </DialogDescription>
          </DialogHeader>
          <form
            noValidate
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              if (mode?.kind === "return") returnIssue(form, mode.issue);
              else issue(form);
            }}
          >
            <FormError message={error} />
            {mode?.kind === "return" ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="ppe-returned">{t("ppe.returnedOn")}</FieldLabel>
                  <Input
                    id="ppe-returned"
                    name="returnedOn"
                    inputMode="numeric"
                    defaultValue={today}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="ppe-condition">{t("ppe.condition")}</FieldLabel>
                  <select
                    id="ppe-condition"
                    name="condition"
                    defaultValue="good"
                    className={selectClass}
                  >
                    {PPE_RETURN_CONDITIONS.map((condition) => (
                      <option key={condition} value={condition}>
                        {t(`returnCondition.${condition}`)}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            ) : (
              <>
                {mode?.kind === "issue" ? (
                  <>
                    <Field>
                      <FieldLabel htmlFor="ppe-issue-site">{t("filters.site")}</FieldLabel>
                      <select
                        id="ppe-issue-site"
                        value={siteId}
                        className={selectClass}
                        onChange={(event) => setSiteId(event.currentTarget.value)}
                      >
                        {sites.map((site) => (
                          <option key={site.id} value={site.id}>
                            {site.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <LabourerPicker
                      projectId={projectId}
                      siteId={siteId}
                      value={labourer}
                      onChange={setLabourer}
                    />
                    <Field>
                      <FieldLabel htmlFor="ppe-issue-item">{t("ppe.item")}</FieldLabel>
                      <select
                        id="ppe-issue-item"
                        name="item"
                        defaultValue="helmet"
                        className={selectClass}
                      >
                        {PPE_ITEMS.map((item) => (
                          <option key={item} value={item}>
                            {itemName(item)}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </>
                ) : null}
                <div className="grid grid-cols-2 gap-4">
                  <Field>
                    <FieldLabel htmlFor="ppe-size">{t("ppe.size")}</FieldLabel>
                    <Input
                      id="ppe-size"
                      name="size"
                      maxLength={12}
                      defaultValue={mode?.kind === "replace" ? (mode.issue.size ?? "") : ""}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="ppe-quantity">{t("ppe.quantity")}</FieldLabel>
                    <Input
                      id="ppe-quantity"
                      name="quantity"
                      inputMode="numeric"
                      defaultValue={mode?.kind === "replace" ? String(mode.issue.quantity) : "1"}
                    />
                  </Field>
                </div>
                <Field>
                  <FieldLabel htmlFor="ppe-issued">{t("ppe.issuedOn")}</FieldLabel>
                  <Input id="ppe-issued" name="issuedOn" inputMode="numeric" defaultValue={today} />
                </Field>
              </>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setMode(null)}>
                {t("actions.cancel")}
              </Button>
              <Button type="submit" disabled={busy}>
                {mode?.kind === "return" ? t("actions.save") : t("ppe.issue")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
