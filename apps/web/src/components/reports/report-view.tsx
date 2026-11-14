import { getTranslations } from "next-intl/server";
import type { ReportModel } from "@pm-buddy/validation";
import { ScrollTable } from "@/components/stores/stores-subnav";
import { formatDateTime } from "@/lib/format";
import { cellText, isNumeric } from "@/lib/reports";
import { cn } from "@/lib/utils";

/**
 * The on-screen renderer of any report model (D8.1): the common header (company, parameters,
 * generated at in Nairobi time and by whom) and one accessible table per section, with totals over
 * every row, notes, and a line when the screen shows fewer rows than the downloads.
 */
export async function ReportView({ model }: { model: ReportModel }) {
  const t = await getTranslations("reports.view");
  return (
    <article className="space-y-6" aria-labelledby="report-title">
      <header className="space-y-2 rounded-xl border p-4 text-sm">
        <h2 id="report-title" className="text-lg font-semibold">
          {model.report.title}
        </h2>
        <p className="text-muted-foreground">{model.company.name}</p>
        <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[max-content_1fr]">
          {model.parameters.map((parameter) => (
            <div key={parameter.key} className="contents">
              <dt className="font-medium">{parameter.label}</dt>
              <dd className="break-words text-muted-foreground">{parameter.value}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-muted-foreground">
          {t("generated", {
            date: formatDateTime(model.generatedAt),
            name: model.generatedBy.displayName,
          })}
        </p>
      </header>
      {model.sections.map((section) => {
        const wide = section.columns.length > 12;
        return (
          <section
            key={section.key}
            aria-labelledby={`section-${section.key}`}
            className="space-y-2"
          >
            <h3 id={`section-${section.key}`} className="text-base font-semibold">
              {section.title}
            </h3>
            {section.rows.length === 0 ? (
              <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
                {section.emptyText}
              </p>
            ) : (
              <ScrollTable
                label={section.title}
                minWidth={Math.max(560, section.columns.length * (wide ? 44 : 110))}
              >
                <thead className="bg-muted/50 text-left text-xs">
                  <tr>
                    {section.columns.map((column) => (
                      <th
                        key={column.key}
                        scope="col"
                        className={cn(
                          "px-2 py-2 font-medium",
                          isNumeric(column.type) && "text-right",
                        )}
                      >
                        {column.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {section.rows.map((row, rowIndex) => (
                    <tr key={rowIndex} className="border-t align-top">
                      {section.columns.map((column, index) => (
                        <td
                          key={column.key}
                          className={cn(
                            "px-2 py-1.5",
                            isNumeric(column.type) && "text-right whitespace-nowrap tabular-nums",
                            column.type === "date" && "whitespace-nowrap",
                          )}
                        >
                          {cellText(column.type, row[index] ?? null)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                {section.totals ? (
                  <tfoot>
                    <tr className="border-t-2 font-semibold">
                      {section.columns.map((column, index) => {
                        const cell = section.totals![index] ?? null;
                        return (
                          <td
                            key={column.key}
                            className={cn(
                              "px-2 py-2",
                              isNumeric(column.type) && "text-right whitespace-nowrap tabular-nums",
                            )}
                          >
                            {index === 0
                              ? String(cell ?? "")
                              : cell === null
                                ? ""
                                : cellText(column.type, cell)}
                          </td>
                        );
                      })}
                    </tr>
                  </tfoot>
                ) : null}
              </ScrollTable>
            )}
            {section.rows.length < section.rowCount ? (
              <p className="text-xs text-muted-foreground">
                {t("rowsShown", { shown: section.rows.length, total: section.rowCount })}
              </p>
            ) : null}
            {section.notes.map((note) => (
              <p key={note} className="text-xs text-muted-foreground">
                {note}
              </p>
            ))}
          </section>
        );
      })}
      {model.notes.length ? (
        <section aria-labelledby="report-notes" className="space-y-1 rounded-xl border p-4 text-sm">
          <h3 id="report-notes" className="font-semibold">
            {t("notes")}
          </h3>
          {model.notes.map((note) => (
            <p key={note} className="text-muted-foreground">
              {note}
            </p>
          ))}
        </section>
      ) : null}
    </article>
  );
}
