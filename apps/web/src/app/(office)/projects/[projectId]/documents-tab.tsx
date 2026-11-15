import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Download, Plus } from "lucide-react";
import { DOCUMENT_CATEGORIES, DRAWING_DISCIPLINES } from "@pm-buddy/types";
import {
  documentListQuerySchema,
  documentListResponseSchema,
  drawingRegisterQuerySchema,
  drawingRegisterResponseSchema,
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
  downloadHref,
  projectTabHref,
  type DocumentView,
  DOCUMENT_VIEWS,
} from "@/lib/documents";
import { formatDate } from "@/lib/format";
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
 * The project's documents (D8.4): every document with its current version, filtered by category,
 * discipline and status, and the drawing register (current revisions only; decision D-111).
 */
export async function DocumentsTab({
  project,
  view,
  params,
  returnTo,
}: {
  project: Project;
  view: DocumentView;
  params: Params;
  returnTo: string;
}) {
  const t = await getTranslations("documents");
  const base = `/projects/${project.id}/documents`;

  let body: React.ReactNode;
  let canUpload = false;
  let canSeeConfidential = true;
  if (view === "drawings") {
    const filters = drawingRegisterQuerySchema.safeParse({
      discipline: one(params["discipline"]),
      search: one(params["search"]),
    });
    const values = filters.success ? filters.data : {};
    const [register, list] = await Promise.all([
      loadLive(
        `${base}/drawings${query({ discipline: values.discipline, search: values.search })}`,
        drawingRegisterResponseSchema,
        returnTo,
      ),
      loadLive(`${base}?limit=1`, documentListResponseSchema, returnTo),
    ]);
    if (!register.ok || !list.ok) return <LiveUnavailable retryHref={returnTo} />;
    canUpload = list.data.permissions.canUpload;
    canSeeConfidential = list.data.permissions.canSeeConfidential;
    const { drawings, disciplines } = register.data;
    body = (
      <section aria-labelledby="drawings-heading" className="space-y-4">
        <div className="space-y-1">
          <h3 id="drawings-heading" className="text-base font-semibold">
            {t("nav.drawings")}
          </h3>
          <p className="text-sm text-muted-foreground">{t("tab.drawingsHint")}</p>
        </div>
        <form
          method="get"
          action={`/projects/${project.id}`}
          className="grid grid-cols-1 gap-3 rounded-md border p-3 sm:grid-cols-[1fr_2fr_auto] sm:items-end"
        >
          <input type="hidden" name="tab" value="documents" />
          <input type="hidden" name="view" value="drawings" />
          <Field>
            <FieldLabel htmlFor="drawing-discipline">{t("tab.filters.discipline")}</FieldLabel>
            <select
              id="drawing-discipline"
              name="discipline"
              defaultValue={values.discipline ?? ""}
              className={selectClass}
            >
              <option value="">{t("tab.filters.allDisciplines")}</option>
              {DRAWING_DISCIPLINES.map((discipline) => (
                <option key={discipline} value={discipline}>
                  {t(`disciplines.${discipline}`)} ({disciplines[discipline]})
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="drawing-search">{t("tab.filters.search")}</FieldLabel>
            <Input
              id="drawing-search"
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
        {drawings.length ? (
          <div className="relative overflow-x-auto rounded-md border">
            <table className="w-full text-sm" data-testid="drawing-register">
              <caption className="sr-only">{t("nav.drawings")}</caption>
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th scope="col" className="p-2 font-medium">
                    {t("tab.cols.number")}
                  </th>
                  <th scope="col" className="p-2 font-medium">
                    {t("tab.cols.title")}
                  </th>
                  <th scope="col" className="p-2 font-medium">
                    {t("tab.cols.discipline")}
                  </th>
                  <th scope="col" className="p-2 font-medium">
                    {t("tab.cols.revision")}
                  </th>
                  <th scope="col" className="p-2 font-medium">
                    {t("tab.cols.purpose")}
                  </th>
                  <th scope="col" className="p-2 font-medium">
                    {t("tab.cols.updated")}
                  </th>
                  <th scope="col" className="p-2 font-medium">
                    <span className="sr-only">{t("common.download")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {drawings.map((drawing) => (
                  <tr key={drawing.id} className="border-t align-top">
                    <th scope="row" className="p-2 text-left font-mono font-medium">
                      <Link
                        className="underline-offset-2 hover:underline"
                        href={`${base}/${drawing.id}`}
                      >
                        {drawing.drawingNumber}
                      </Link>
                    </th>
                    <td className="p-2">{drawing.title}</td>
                    <td className="p-2">
                      {drawing.discipline ? t(`disciplines.${drawing.discipline}`) : "—"}
                    </td>
                    <td className="p-2">
                      <span className="flex flex-wrap items-center gap-1">
                        <span className="font-mono">{drawing.current.revision}</span>
                        <StatusBadge tone="success">{t("versionStates.current")}</StatusBadge>
                      </span>
                    </td>
                    <td className="p-2">
                      {drawing.current.issuePurpose
                        ? t(`purposes.${drawing.current.issuePurpose}`)
                        : "—"}
                    </td>
                    <td className="p-2 tabular-nums">{formatDate(drawing.current.uploadedAt)}</td>
                    <td className="p-2">
                      <a
                        className="inline-flex items-center gap-1 underline"
                        href={downloadHref(project.id, drawing.id, drawing.current.id)}
                        download
                      >
                        <Download className="size-4" aria-hidden />
                        {t("common.downloadRevision", { revision: drawing.current.revision })}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {values.discipline || values.search ? t("tab.emptyFiltered") : t("tab.empty")}
          </p>
        )}
      </section>
    );
  } else {
    const filters = documentListQuerySchema.safeParse({
      category: one(params["category"]),
      discipline: one(params["discipline"]),
      status: one(params["status"]),
      search: one(params["search"]),
      cursor: one(params["cursor"]),
    });
    const values = filters.success ? filters.data : { status: "active" as const, limit: 30 };
    const list = await loadLive(
      `${base}${query({
        category: values.category,
        discipline: values.discipline,
        status: values.status === "active" ? undefined : values.status,
        search: values.search,
        cursor: values.cursor,
      })}`,
      documentListResponseSchema,
      returnTo,
    );
    if (!list.ok) return <LiveUnavailable retryHref={returnTo} />;
    const { documents, counts, total, nextCursor, permissions } = list.data;
    canUpload = permissions.canUpload;
    canSeeConfidential = permissions.canSeeConfidential;
    const kept = {
      category: values.category,
      discipline: values.discipline,
      status: values.status === "active" ? undefined : values.status,
      search: values.search,
    };
    const filtered = Boolean(
      values.category || values.discipline || values.search || values.status !== "active",
    );
    body = (
      <section aria-labelledby="documents-heading" className="space-y-4">
        <h3 id="documents-heading" className="sr-only">
          {t("nav.all")}
        </h3>
        <ul className="flex flex-wrap gap-2" aria-label={t("tab.filters.category")}>
          {DOCUMENT_CATEGORIES.filter((category) => counts[category] > 0).map((category) => (
            <li key={category}>
              <Link
                href={projectTabHref(project.id, "documents", { category })}
                className="inline-flex"
              >
                <StatusBadge tone={values.category === category ? "info" : "neutral"}>
                  {t(`categories.${category}`)} · {counts[category]}
                </StatusBadge>
              </Link>
            </li>
          ))}
        </ul>
        <form
          method="get"
          action={`/projects/${project.id}`}
          className="grid grid-cols-1 gap-3 rounded-md border p-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_2fr_auto] lg:items-end"
        >
          <input type="hidden" name="tab" value="documents" />
          <Field>
            <FieldLabel htmlFor="document-category">{t("tab.filters.category")}</FieldLabel>
            <select
              id="document-category"
              name="category"
              defaultValue={values.category ?? ""}
              className={selectClass}
            >
              <option value="">{t("tab.filters.allCategories")}</option>
              {DOCUMENT_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {t(`categories.${category}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="document-discipline">{t("tab.filters.discipline")}</FieldLabel>
            <select
              id="document-discipline"
              name="discipline"
              defaultValue={values.discipline ?? ""}
              className={selectClass}
            >
              <option value="">{t("tab.filters.allDisciplines")}</option>
              {DRAWING_DISCIPLINES.map((discipline) => (
                <option key={discipline} value={discipline}>
                  {t(`disciplines.${discipline}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="document-status">{t("tab.filters.status")}</FieldLabel>
            <select
              id="document-status"
              name="status"
              defaultValue={values.status === "active" ? "" : values.status}
              className={selectClass}
            >
              <option value="">{t("tab.filters.active")}</option>
              <option value="withdrawn">{t("tab.filters.withdrawn")}</option>
              <option value="all">{t("tab.filters.all")}</option>
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="document-search">{t("tab.filters.search")}</FieldLabel>
            <Input
              id="document-search"
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
        {documents.length ? (
          <div className="relative overflow-x-auto rounded-md border">
            <table className="w-full text-sm" data-testid="document-list">
              <caption className="sr-only">{t("nav.all")}</caption>
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th scope="col" className="p-2 font-medium">
                    {t("tab.cols.document")}
                  </th>
                  <th scope="col" className="p-2 font-medium">
                    {t("tab.cols.category")}
                  </th>
                  <th scope="col" className="p-2 font-medium">
                    {t("tab.cols.revision")}
                  </th>
                  <th scope="col" className="p-2 font-medium">
                    {t("tab.cols.purpose")}
                  </th>
                  <th scope="col" className="p-2 font-medium">
                    {t("tab.cols.updated")}
                  </th>
                  <th scope="col" className="p-2 font-medium">
                    {t("tab.cols.approval")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {documents.map((document) => (
                  <tr key={document.id} className="border-t align-top">
                    <th scope="row" className="p-2 text-left font-medium">
                      <Link
                        className="underline-offset-2 hover:underline"
                        href={`${base}/${document.id}`}
                      >
                        {document.drawingNumber ? (
                          <span className="font-mono">{document.drawingNumber} · </span>
                        ) : null}
                        {document.title}
                      </Link>
                      <span className="block text-xs font-normal text-muted-foreground">
                        {t("tab.versionCount", { count: document.versionCount })}
                        {document.reference ? ` · ${document.reference}` : ""}
                      </span>
                      {document.status === "withdrawn" ? (
                        <StatusBadge tone="neutral" className="mt-1">
                          {t("tab.withdrawn")}
                        </StatusBadge>
                      ) : null}
                    </th>
                    <td className="p-2">
                      {t(`categories.${document.category}`)}
                      {document.discipline ? (
                        <span className="block text-xs text-muted-foreground">
                          {t(`disciplines.${document.discipline}`)}
                        </span>
                      ) : null}
                    </td>
                    <td className="p-2">
                      <span className="flex flex-wrap items-center gap-1">
                        <span className="font-mono">{document.current.revision}</span>
                        <StatusBadge tone="success">{t("versionStates.current")}</StatusBadge>
                      </span>
                    </td>
                    <td className="p-2">
                      {document.current.issuePurpose
                        ? t(`purposes.${document.current.issuePurpose}`)
                        : "—"}
                    </td>
                    <td className="p-2 tabular-nums">{formatDate(document.updatedAt)}</td>
                    <td className="p-2">
                      {document.current.approval ? (
                        <StatusBadge tone={approvalTone[document.current.approval.status]}>
                          {t("detail.approval", {
                            code: document.current.approval.code,
                            status: t(`approvalStatuses.${document.current.approval.status}`),
                          })}
                        </StatusBadge>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {filtered ? t("tab.emptyFiltered") : t("tab.empty")}
          </p>
        )}
        <p className="text-xs text-muted-foreground tabular-nums">
          {documents.length
            ? t("common.pageOf", {
                from: (values.cursor ?? 0) + 1,
                to: (values.cursor ?? 0) + documents.length,
                total,
              })
            : null}
        </p>
        <Pager
          label={t("nav.all")}
          offset
          firstHref={values.cursor ? projectTabHref(project.id, "documents", kept) : null}
          nextHref={
            nextCursor !== null
              ? projectTabHref(project.id, "documents", { ...kept, cursor: nextCursor })
              : null
          }
        />
      </section>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{t("tab.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("tab.hint")}</p>
        </div>
        {canUpload ? (
          <Button asChild>
            <Link href={`${base}/new`}>
              <Plus className="size-4" aria-hidden />
              {t("tab.upload")}
            </Link>
          </Button>
        ) : null}
      </div>
      <nav aria-label={t("tab.title")}>
        <ul className="flex flex-wrap gap-2">
          {DOCUMENT_VIEWS.map((key) => (
            <li key={key}>
              <Link
                href={projectTabHref(project.id, "documents", key === "all" ? {} : { view: key })}
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
      {canSeeConfidential ? null : (
        <p role="note" className="rounded-md border bg-muted p-3 text-sm">
          {t("tab.confidentialHidden")}
        </p>
      )}
      {body}
    </div>
  );
}
