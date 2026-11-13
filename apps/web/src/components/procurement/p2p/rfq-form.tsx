"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { rfqDetailResponseSchema } from "@pm-buddy/validation";
import { selectClass } from "@/components/procurement/material-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatCalendarDate } from "@/lib/format";
import { liveRequest } from "@/lib/live-api";
import type { ProjectOption } from "@/lib/p2p-server";
import { useP2pProblem } from "./use-p2p-problem";

type RequisitionOption = {
  id: string;
  number: string;
  projectId: string;
  lineCount: number;
  neededBy: string;
};

/** Ask suppliers to quote for approved requisitions of one project (D5.2). */
export function RfqForm({
  projects,
  requisitions,
  suppliers,
  defaultProjectId,
  preselected,
}: {
  projects: ProjectOption[];
  requisitions: RequisitionOption[];
  suppliers: { id: string; code: string; name: string }[];
  defaultProjectId?: string;
  preselected?: string;
}) {
  const t = useTranslations("p2p.rfqs.form");
  const tReq = useTranslations("p2p.requisitions");
  const tCommon = useTranslations("p2p.common");
  const problem = useP2pProblem();
  const router = useRouter();
  const withRequisitions = projects.filter((project) =>
    requisitions.some((entry) => entry.projectId === project.id),
  );
  const [projectId, setProjectId] = useState(
    defaultProjectId ?? withRequisitions[0]?.id ?? projects[0]?.id ?? "",
  );
  const [chosen, setChosen] = useState<string[]>(preselected ? [preselected] : []);
  const [supplierIds, setSupplierIds] = useState<string[]>([]);
  const [respondBy, setRespondBy] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const available = requisitions.filter((entry) => entry.projectId === projectId);
  const selected = chosen.filter((id) => available.some((entry) => entry.id === id));
  const toggle = (list: string[], id: string, on: boolean) =>
    on ? [...new Set([...list, id])] : list.filter((entry) => entry !== id);

  async function save() {
    setBusy(true);
    setFailure(null);
    try {
      const result = await liveRequest("/procurement/rfqs", rfqDetailResponseSchema, {
        method: "POST",
        body: {
          requisitionIds: selected,
          supplierIds,
          respondBy: respondBy || null,
          notes: notes.trim() || null,
        },
      });
      router.push(`/procurement/rfqs/${result.rfq.id}`);
      router.refresh();
    } catch (error) {
      setFailure(problem(error));
      setBusy(false);
    }
  }

  return (
    <form
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (selected.length && supplierIds.length) void save();
      }}
    >
      <Card>
        <CardContent className="space-y-4">
          <Field className="max-w-md">
            <FieldLabel htmlFor="rfq-project">{t("project")}</FieldLabel>
            <select
              id="rfq-project"
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
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("requisitions")}</legend>
            {available.length ? (
              available.map((entry) => (
                <label key={entry.id} className="flex min-h-9 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={selected.includes(entry.id)}
                    onChange={(event) =>
                      setChosen((current) => toggle(current, entry.id, event.target.checked))
                    }
                  />
                  {t("requisitionLabel", {
                    number: entry.number,
                    lines: tReq("linesCount", { count: entry.lineCount }),
                    date: formatCalendarDate(entry.neededBy),
                  })}
                </label>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">{t("noRequisitions")}</p>
            )}
          </fieldset>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("suppliers")}</legend>
            <div className="grid gap-1 sm:grid-cols-2">
              {suppliers.map((supplier) => (
                <label key={supplier.id} className="flex min-h-9 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={supplierIds.includes(supplier.id)}
                    onChange={(event) =>
                      setSupplierIds((current) =>
                        toggle(current, supplier.id, event.target.checked),
                      )
                    }
                  />
                  <span>
                    <span className="font-mono text-xs">{supplier.code}</span> · {supplier.name}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="rfq-respond-by">{t("respondBy")}</FieldLabel>
              <Input
                id="rfq-respond-by"
                type="date"
                value={respondBy}
                onChange={(event) => setRespondBy(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="rfq-notes">{tCommon("notesOptional")}</FieldLabel>
              <Textarea
                id="rfq-notes"
                rows={2}
                maxLength={2000}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </Field>
          </div>
        </CardContent>
      </Card>
      {!selected.length ? (
        <p className="text-sm text-muted-foreground">{t("chooseRequisition")}</p>
      ) : null}
      {!supplierIds.length ? (
        <p className="text-sm text-muted-foreground">{t("chooseSupplier")}</p>
      ) : null}
      {failure ? (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      ) : null}
      <Button type="submit" disabled={busy || !selected.length || !supplierIds.length}>
        {t("create")}
      </Button>
    </form>
  );
}
