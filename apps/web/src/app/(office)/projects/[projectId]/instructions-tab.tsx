import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Plus } from "lucide-react";
import { APPROVAL_REQUEST_KINDS, INSTRUCTION_KINDS, INSTRUCTION_LIFECYCLE } from "@pm-buddy/types";
import {
  approvalListQuerySchema,
  approvalListResponseSchema,
  instructionLogListResponseSchema,
  instructionLogQuerySchema,
  type Project,
} from "@pm-buddy/validation";
import { LiveUnavailable } from "@/components/projects/live-state";
import { Pager } from "@/components/safety/common";
import { selectClass } from "@/components/schedule/use-schedule-mutation";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  approvalTone,
  INSTRUCTION_VIEWS,
  instructionTone,
  projectTabHref,
  type InstructionView,
} from "@/lib/documents";
import { formatCalendarDate } from "@/lib/format";
import { loadLive } from "@/lib/server-api";
import { cn } from "@/lib/utils";

type Params = Record<string, string | string[] | undefined>;
const one = (value: string | string[] | undefined) =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;
const query = (values: Record<string, string | number | undefined>) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && value !== "") params.set(key, String(value));
  const text = params.toString();
  return text ? `?${text}` : "";
};

/**
 * Consultant instructions received and approval requests sent (D8.4): the instructions log with its
 * status and cost/time flags, and the approval requests with their overdue flags.
 */
export async function InstructionsTab({
  project,
  view,
  params,
  returnTo,
}: {
  project: Project;
  view: InstructionView;
  params: Params;
  returnTo: string;
}) {
  const t = await getTranslations("documents");
  const base = `/projects/${project.id}`;
  let body: React.ReactNode;

  if (view === "approvals") {
    const filters = approvalListQuerySchema.safeParse({
      status: one(params["status"]),
      kind: one(params["kind"]),
      search: one(params["search"]),
      cursor: one(params["cursor"]),
    });
    const values = filters.success ? filters.data : { status: "all" as const, limit: 30 };
    const list = await loadLive(
      `${base}/approvals${query({
        status: values.status === "all" ? undefined : values.status,
        kind: values.kind,
        search: values.search,
        cursor: values.cursor,
      })}`,
      approvalListResponseSchema,
      returnTo,
    );
    if (!list.ok) return <LiveUnavailable retryHref={returnTo} />;
    const { approvals, counts, nextCursor, permissions } = list.data;
    const kept = {
      view: "approvals",
      status: values.status === "all" ? undefined : values.status,
      kind: values.kind,
      search: values.search,
    };
    const filtered = Boolean(values.status !== "all" || values.kind || values.search);
    body = (
      <section aria-labelledby="approvals-heading" className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="space-y-1">
            <h3 id="approvals-heading" className="text-base font-semibold">
              {t("approvals.title")}
            </h3>
            <p className="text-sm text-muted-foreground">{t("approvals.hint")}</p>
          </div>
          {permissions.canRaise ? (
            <Button asChild>
              <Link href={`${base}/approvals/new`}>
                <Plus className="size-4" aria-hidden />
                {t("approvals.raise")}
              </Link>
            </Button>
          ) : null}
        </div>
        <p className="text-sm tabular-nums">
          {t("approvals.counts", {
            pending: counts.pending,
            overdue: counts.overdue,
            decided: counts.decided,
          })}
        </p>
        <form
          method="get"
          action={base}
          className="grid grid-cols-1 gap-3 rounded-md border p-3 sm:grid-cols-[1fr_1fr_2fr_auto] sm:items-end"
        >
          <input type="hidden" name="tab" value="instructions" />
          <input type="hidden" name="view" value="approvals" />
          <Field>
            <FieldLabel htmlFor="approval-status">{t("approvals.filters.status")}</FieldLabel>
            <select
              id="approval-status"
              name="status"
              defaultValue={values.status === "all" ? "" : values.status}
              className={selectClass}
            >
              <option value="">{t("approvals.filters.all")}</option>
              {(["pending", "overdue", "decided", "cancelled"] as const).map((status) => (
                <option key={status} value={status}>
                  {t(`approvals.filters.${status}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="approval-kind">{t("approvals.filters.kind")}</FieldLabel>
            <select
              id="approval-kind"
              name="kind"
              defaultValue={values.kind ?? ""}
              className={selectClass}
            >
              <option value="">{t("common.all")}</option>
              {APPROVAL_REQUEST_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`approvalKinds.${kind}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="approval-search">{t("common.search")}</FieldLabel>
            <Input
              id="approval-search"
              name="search"
              type="search"
              maxLength={100}
              defaultValue={values.search ?? ""}
            />
          </Field>
          <Button type="submit" variant="secondary">
            {t("common.filter")}
          </Button>
        </form>
        {approvals.length ? (
          <div className="relative overflow-x-auto rounded-md border">
            <table className="w-full text-sm" data-testid="approval-list">
              <caption className="sr-only">{t("approvals.title")}</caption>
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th scope="col" className="p-2 font-medium">
                    {t("approvals.cols.code")}
                  </th>
                  <th scope="col" className="p-2 font-medium">
                    {t("approvals.cols.title")}
                  </th>
                  <th scope="col" className="p-2 font-medium">
                    {t("approvals.cols.document")}
                  </th>
                  <th scope="col" className="p-2 font-medium">
                    {t("approvals.cols.sentTo")}
                  </th>
                  <th scope="col" className="p-2 font-medium">
                    {t("approvals.cols.due")}
                  </th>
                  <th scope="col" className="p-2 font-medium">
                    {t("approvals.cols.status")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {approvals.map((approval) => (
                  <tr key={approval.id} className="border-t align-top">
                    <th scope="row" className="p-2 text-left font-mono font-medium">
                      <Link
                        className="underline-offset-2 hover:underline"
                        href={`${base}/approvals/${approval.id}`}
                      >
                        {approval.code}
                      </Link>
                    </th>
                    <td className="p-2">
                      {approval.title}
                      <span className="block text-xs text-muted-foreground">
                        {t(`approvalKinds.${approval.kind}`)}
                      </span>
                    </td>
                    <td className="p-2">
                      {approval.document.restricted ? (
                        <span className="text-muted-foreground">{t("common.restricted")}</span>
                      ) : (
                        <>
                          {approval.document.title} ·{" "}
                          {t("common.revision", { revision: approval.document.revision })}
                          {approval.document.state === "superseded" ? (
                            <StatusBadge tone="neutral" className="ml-1">
                              {t("versionStates.superseded")}
                            </StatusBadge>
                          ) : null}
                        </>
                      )}
                    </td>
                    <td className="p-2">{approval.addressedTo}</td>
                    <td className="p-2 tabular-nums">
                      {formatCalendarDate(approval.dueOn)}
                      {approval.overdue ? (
                        <StatusBadge tone="danger" className="mt-1 flex w-fit">
                          {t("common.overdueDays", { days: approval.daysOverdue })}
                        </StatusBadge>
                      ) : null}
                    </td>
                    <td className="p-2">
                      <StatusBadge
                        tone={approvalTone[approval.status]}
                        className="h-auto whitespace-normal"
                      >
                        {t(`approvalStatuses.${approval.status}`)}
                      </StatusBadge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {filtered ? t("approvals.emptyFiltered") : t("approvals.empty")}
          </p>
        )}
        <Pager
          label={t("approvals.title")}
          offset
          firstHref={values.cursor ? projectTabHref(project.id, "instructions", kept) : null}
          nextHref={
            nextCursor !== null
              ? projectTabHref(project.id, "instructions", { ...kept, cursor: nextCursor })
              : null
          }
        />
      </section>
    );
  } else {
    const filters = instructionLogQuerySchema.safeParse({
      status: one(params["status"]),
      kind: one(params["kind"]),
      flag: one(params["flag"]),
      search: one(params["search"]),
      cursor: one(params["cursor"]),
    });
    const values = filters.success ? filters.data : { limit: 30 };
    const list = await loadLive(
      `${base}/instructions${query({
        status: values.status,
        kind: values.kind,
        flag: values.flag,
        search: values.search,
        cursor: values.cursor,
      })}`,
      instructionLogListResponseSchema,
      returnTo,
    );
    if (!list.ok) return <LiveUnavailable retryHref={returnTo} />;
    const { instructions, counts, nextCursor, permissions } = list.data;
    const kept = {
      status: values.status,
      kind: values.kind,
      flag: values.flag,
      search: values.search,
    };
    const filtered = Boolean(values.status || values.kind || values.flag || values.search);
    body = (
      <section aria-labelledby="instructions-heading" className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="space-y-1">
            <h3 id="instructions-heading" className="text-base font-semibold">
              {t("instructions.title")}
            </h3>
            <p className="text-sm text-muted-foreground">{t("instructions.hint")}</p>
          </div>
          {permissions.canRecord ? (
            <Button asChild>
              <Link href={`${base}/instructions/new`}>
                <Plus className="size-4" aria-hidden />
                {t("instructions.record")}
              </Link>
            </Button>
          ) : null}
        </div>
        <p className="text-sm tabular-nums">
          {t("instructions.counts", {
            received: counts.received,
            acknowledged: counts.acknowledged,
            actioned: counts.actioned,
            closed: counts.closed,
          })}
        </p>
        <form
          method="get"
          action={base}
          className="grid grid-cols-1 gap-3 rounded-md border p-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_2fr_auto] lg:items-end"
        >
          <input type="hidden" name="tab" value="instructions" />
          <Field>
            <FieldLabel htmlFor="instruction-status">{t("instructions.filters.status")}</FieldLabel>
            <select
              id="instruction-status"
              name="status"
              defaultValue={values.status ?? ""}
              className={selectClass}
            >
              <option value="">{t("common.all")}</option>
              <option value="open">{t("instructions.filters.open")}</option>
              {INSTRUCTION_LIFECYCLE.map((status) => (
                <option key={status} value={status}>
                  {t(`instructionStatuses.${status}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="instruction-kind">{t("instructions.filters.kind")}</FieldLabel>
            <select
              id="instruction-kind"
              name="kind"
              defaultValue={values.kind ?? ""}
              className={selectClass}
            >
              <option value="">{t("common.all")}</option>
              {INSTRUCTION_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`instructionKinds.${kind}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="instruction-flag">{t("instructions.filters.flag")}</FieldLabel>
            <select
              id="instruction-flag"
              name="flag"
              defaultValue={values.flag ?? ""}
              className={selectClass}
            >
              <option value="">{t("common.all")}</option>
              <option value="cost">{t("instructions.filters.cost")}</option>
              <option value="time">{t("instructions.filters.time")}</option>
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="instruction-search">{t("instructions.filters.search")}</FieldLabel>
            <Input
              id="instruction-search"
              name="search"
              type="search"
              maxLength={100}
              defaultValue={values.search ?? ""}
            />
          </Field>
          <Button type="submit" variant="secondary">
            {t("common.filter")}
          </Button>
        </form>
        {instructions.length ? (
          <div className="relative overflow-x-auto rounded-md border">
            <table className="w-full text-sm" data-testid="instruction-list">
              <caption className="sr-only">{t("instructions.title")}</caption>
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th scope="col" className="p-2 font-medium">
                    {t("instructions.cols.number")}
                  </th>
                  <th scope="col" className="p-2 font-medium">
                    {t("instructions.cols.subject")}
                  </th>
                  <th scope="col" className="p-2 font-medium">
                    {t("instructions.cols.issuer")}
                  </th>
                  <th scope="col" className="p-2 font-medium">
                    {t("instructions.cols.received")}
                  </th>
                  <th scope="col" className="p-2 font-medium">
                    {t("instructions.cols.status")}
                  </th>
                  <th scope="col" className="p-2 font-medium">
                    {t("instructions.cols.flags")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {instructions.map((instruction) => (
                  <tr key={instruction.id} className="border-t align-top">
                    <th scope="row" className="p-2 text-left font-mono font-medium">
                      <Link
                        className="underline-offset-2 hover:underline"
                        href={`${base}/instructions/${instruction.id}`}
                      >
                        {instruction.number}
                      </Link>
                    </th>
                    <td className="p-2">
                      {instruction.subject}
                      <span className="block text-xs text-muted-foreground">
                        {t(`instructionKinds.${instruction.kind}`)}
                      </span>
                    </td>
                    <td className="p-2">
                      {instruction.issuerName}
                      <span className="block text-xs text-muted-foreground">
                        {t(`issuerRoles.${instruction.issuerRole}`)}
                        {instruction.issuerFirm ? ` · ${instruction.issuerFirm}` : ""}
                      </span>
                    </td>
                    <td className="p-2 tabular-nums">
                      {formatCalendarDate(instruction.receivedOn)}
                    </td>
                    <td className="p-2">
                      <StatusBadge tone={instructionTone[instruction.status]}>
                        {t(`instructionStatuses.${instruction.status}`)}
                      </StatusBadge>
                    </td>
                    <td className="p-2">
                      <span className="flex flex-wrap gap-1">
                        {instruction.costImplication ? (
                          <StatusBadge tone="warning">{t("instructions.costFlag")}</StatusBadge>
                        ) : null}
                        {instruction.timeImplication ? (
                          <StatusBadge tone="warning">{t("instructions.timeFlag")}</StatusBadge>
                        ) : null}
                        {!instruction.costImplication && !instruction.timeImplication ? "—" : null}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {filtered ? t("instructions.emptyFiltered") : t("instructions.empty")}
          </p>
        )}
        <Pager
          label={t("instructions.title")}
          offset
          firstHref={values.cursor ? projectTabHref(project.id, "instructions", kept) : null}
          nextHref={
            nextCursor !== null
              ? projectTabHref(project.id, "instructions", { ...kept, cursor: nextCursor })
              : null
          }
        />
      </section>
    );
  }

  return (
    <div className="space-y-4">
      <nav aria-label={t("nav.instructions")}>
        <ul className="flex flex-wrap gap-2">
          {INSTRUCTION_VIEWS.map((key) => (
            <li key={key}>
              <Link
                href={projectTabHref(
                  project.id,
                  "instructions",
                  key === "instructions" ? {} : { view: key },
                )}
                aria-current={key === view ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-8 items-center rounded-md border px-3 py-1 text-sm font-medium",
                  key === view
                    ? "border-primary bg-primary text-primary-foreground"
                    : "bg-background hover:bg-accent",
                )}
              >
                {t(`nav.${key}`)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {body}
    </div>
  );
}
