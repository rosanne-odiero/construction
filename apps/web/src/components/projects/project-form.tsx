"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { CONTRACT_TYPES, KENYA_COUNTIES } from "@pm-buddy/types";
import {
  createProjectRequestSchema,
  projectResponseSchema,
  updateProjectRequestSchema,
  type Project,
} from "@pm-buddy/validation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { liveRequest } from "@/lib/live-api";
import {
  calendarInput,
  parseCalendarInput,
  parseCoordinate,
  parseShillings,
  shillingsInput,
} from "@/lib/project-input";
import { useStepUp } from "./step-up";
import { useProblemMessage } from "./use-problem-message";

type Values = Record<
  | "code"
  | "name"
  | "description"
  | "clientName"
  | "clientEmail"
  | "clientPhone"
  | "contractSum"
  | "contractType"
  | "startDate"
  | "endDate"
  | "county"
  | "town"
  | "latitude"
  | "longitude",
  string
>;
type FieldName = keyof Values;
type InvalidKey =
  "money" | "date" | "coordinates" | "email" | "phone" | "code" | "name" | "endBeforeStart";

const selectClass =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 outline-none";

function initialValues(project: Project | null): Values {
  return {
    code: project?.code ?? "",
    name: project?.name ?? "",
    description: project?.description ?? "",
    clientName: project?.clientName ?? "",
    clientEmail: project?.clientEmail ?? "",
    clientPhone: project?.clientPhone ?? "",
    contractSum: shillingsInput(project?.contractSumMinor ?? null),
    contractType: project?.contractType ?? "",
    startDate: calendarInput(project?.startDate ?? null),
    endDate: calendarInput(project?.endDate ?? null),
    county: project?.county ?? "",
    town: project?.town ?? "",
    latitude: project?.latitude?.toString() ?? "",
    longitude: project?.longitude?.toString() ?? "",
  };
}

/**
 * Create or edit a project in a dialog. Values are checked with the shared request schema before
 * sending; the API checks them again and the dialog shows its problem codes in EN/SW.
 */
export function ProjectFormDialog({
  open,
  onOpenChange,
  project,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The project to edit; null creates a new one. */
  project: Project | null;
}) {
  const t = useTranslations("liveProjects.form");
  const tTypes = useTranslations("contractTypes");
  const problem = useProblemMessage();
  const router = useRouter();
  const stepUp = useStepUp();
  const [values, setValues] = useState<Values>(() => initialValues(project));
  const [invalid, setInvalid] = useState<Partial<Record<FieldName, InvalidKey>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const editing = project !== null;

  const set = (name: FieldName) => (event: { target: { value: string } }) =>
    setValues((current) => ({ ...current, [name]: event.target.value }));

  function body(): Record<string, unknown> | null {
    const errors: Partial<Record<FieldName, InvalidKey>> = {};
    const contractSumMinor = parseShillings(values.contractSum);
    const startDate = parseCalendarInput(values.startDate);
    const endDate = parseCalendarInput(values.endDate);
    const latitude = parseCoordinate(values.latitude);
    const longitude = parseCoordinate(values.longitude);
    if (!values.name.trim()) errors.name = "name";
    if (values.code.trim() && !/^[A-Za-z0-9][A-Za-z0-9-]{1,19}$/.test(values.code.trim()))
      errors.code = "code";
    if (contractSumMinor === undefined) errors.contractSum = "money";
    if (startDate === undefined) errors.startDate = "date";
    if (endDate === undefined) errors.endDate = "date";
    else if (startDate && endDate && endDate < startDate) errors.endDate = "endBeforeStart";
    if (
      latitude === undefined ||
      longitude === undefined ||
      (latitude === null) !== (longitude === null)
    )
      errors.longitude = "coordinates";
    const text = (value: string) => value.trim() || null;
    const draft: Record<string, unknown> = {
      name: values.name.trim(),
      description: text(values.description),
      clientName: text(values.clientName),
      clientEmail: text(values.clientEmail),
      clientPhone: text(values.clientPhone),
      contractSumMinor,
      contractType: values.contractType || null,
      startDate,
      endDate,
      county: values.county || null,
      town: text(values.town),
      latitude,
      longitude,
    };
    if (values.code.trim()) draft.code = values.code.trim();
    let request: Record<string, unknown> = draft;
    if (editing) {
      const before = initialValues(project);
      request = { version: project.version };
      for (const [key, value] of Object.entries(draft)) {
        const field =
          ({ contractSumMinor: "contractSum" } as Record<string, FieldName>)[key] ??
          (key as FieldName);
        if (values[field] !== before[field]) request[key] = value;
      }
      // Coordinates travel as a pair.
      if ("latitude" in request || "longitude" in request) {
        request.latitude = latitude;
        request.longitude = longitude;
      }
    } else {
      for (const key of Object.keys(request)) if (request[key] === null) delete request[key];
    }
    const parsed = (editing ? updateProjectRequestSchema : createProjectRequestSchema).safeParse(
      request,
    );
    if (!parsed.success)
      for (const issue of parsed.error.issues) {
        const path = String(issue.path[0] ?? "");
        if (path === "clientEmail") errors.clientEmail = "email";
        else if (path === "clientPhone") errors.clientPhone = "phone";
        else if (path === "latitude" || path === "longitude") errors.longitude = "coordinates";
        else if (path === "code") errors.code = "code";
      }
    setInvalid(errors);
    if (Object.keys(errors).length) return null;
    if (editing && Object.keys(request).length === 1) {
      onOpenChange(false);
      return null;
    }
    return request;
  }

  async function submit() {
    const request = body();
    if (!request) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await stepUp.run(() =>
        liveRequest(editing ? `/projects/${project.id}` : "/projects", projectResponseSchema, {
          method: editing ? "PATCH" : "POST",
          body: request,
        }),
      );
      onOpenChange(false);
      if (editing) router.refresh();
      else router.push(`/projects/${result.project.id}`);
    } catch (error) {
      setFailure(problem(error));
    } finally {
      setBusy(false);
    }
  }

  const field = (
    name: FieldName,
    options: {
      hint?: string;
      required?: boolean;
      type?: string;
      autoComplete?: string;
      inputMode?: "decimal" | "tel" | "email";
    } = {},
  ) => (
    <Field data-invalid={invalid[name] ? true : undefined}>
      <FieldLabel htmlFor={`project-${name}`}>
        {t(name)}
        {options.required ? <span aria-hidden> *</span> : null}
      </FieldLabel>
      <Input
        id={`project-${name}`}
        value={values[name]}
        onChange={set(name)}
        type={options.type ?? "text"}
        inputMode={options.inputMode}
        autoComplete={options.autoComplete ?? "off"}
        required={options.required}
        aria-invalid={invalid[name] ? true : undefined}
        aria-describedby={options.hint ? `project-${name}-hint` : undefined}
      />
      {options.hint ? (
        <FieldDescription id={`project-${name}-hint`}>{options.hint}</FieldDescription>
      ) : null}
      {invalid[name] ? <FieldError>{t(`invalid.${invalid[name]}`)}</FieldError> : null}
    </Field>
  );

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          showCloseButton={false}
          className="max-h-[90svh] overflow-y-auto sm:max-w-2xl"
        >
          <DialogHeader>
            <DialogTitle>{editing ? t("editTitle") : t("createTitle")}</DialogTitle>
            <DialogDescription>{t("planningHint")}</DialogDescription>
          </DialogHeader>
          <form
            id="project-form"
            noValidate
            className="grid gap-4 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {failure ? (
              <p role="alert" className="text-sm text-destructive sm:col-span-2">
                {failure}
              </p>
            ) : null}
            <div className="sm:col-span-2">{field("name", { required: true })}</div>
            {field("code", { hint: editing ? t("codeHintEdit") : t("codeHint") })}
            <Field>
              <FieldLabel htmlFor="project-contractType">{t("contractType")}</FieldLabel>
              <select
                id="project-contractType"
                className={selectClass}
                value={values.contractType}
                onChange={set("contractType")}
              >
                <option value="">{t("notSelected")}</option>
                {CONTRACT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {tTypes(type)}
                  </option>
                ))}
              </select>
            </Field>
            <div className="sm:col-span-2">
              <Field>
                <FieldLabel htmlFor="project-description">{t("description")}</FieldLabel>
                <Textarea
                  id="project-description"
                  value={values.description}
                  onChange={set("description")}
                  maxLength={2000}
                  rows={2}
                />
              </Field>
            </div>
            {field("clientName", { autoComplete: "organization" })}
            {field("clientEmail", { type: "email", inputMode: "email" })}
            {field("clientPhone", { type: "tel", inputMode: "tel", hint: t("clientPhoneHint") })}
            {field("contractSum", { inputMode: "decimal", hint: t("contractSumHint") })}
            {field("startDate", { hint: t("dateHint") })}
            {field("endDate", { hint: t("dateHint") })}
            <Field>
              <FieldLabel htmlFor="project-county">{t("county")}</FieldLabel>
              <select
                id="project-county"
                className={selectClass}
                value={values.county}
                onChange={set("county")}
              >
                <option value="">{t("notSelected")}</option>
                {KENYA_COUNTIES.map((county) => (
                  <option key={county.key} value={county.key}>
                    {county.name}
                  </option>
                ))}
              </select>
            </Field>
            {field("town")}
            {field("latitude", { inputMode: "decimal", hint: t("coordinatesHint") })}
            {field("longitude", { inputMode: "decimal" })}
          </form>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("cancel")}
            </Button>
            <Button type="submit" form="project-form" disabled={busy}>
              {editing ? t("save") : t("create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {stepUp.dialog}
    </>
  );
}

/** The "New project" button of the projects list. */
export function NewProjectButton() {
  const t = useTranslations("liveProjects");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>{t("newProject")}</Button>
      {open ? <ProjectFormDialog open={open} onOpenChange={setOpen} project={null} /> : null}
    </>
  );
}

/** The "Edit details" button of a project. */
export function EditProjectButton({ project }: { project: Project }) {
  const t = useTranslations("projectDetail");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        {t("edit")}
      </Button>
      {open ? <ProjectFormDialog open={open} onOpenChange={setOpen} project={project} /> : null}
    </>
  );
}
