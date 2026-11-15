"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { nairobiDate, outputAmountMinor } from "@pm-buddy/domain";
import { pieceRateJobResponseSchema } from "@pm-buddy/validation";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { formatKES } from "@/lib/format";
import { liveRequest } from "@/lib/live-api";
import { parseKesInput } from "@/lib/spending";
import { newIdempotencyKey, parseDecimalInput } from "@/lib/subcontracts";
import { Failure, selectClass } from "./subcontract-forms";
import { useSubcontractProblem } from "./use-subcontract-problem";

const formClass = "grid gap-3 rounded-xl border p-4 sm:grid-cols-2";
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type JobItemOption = {
  lineageId: string;
  label: string;
  units: { unit: string; factor: string }[];
};

/**
 * A piece-rate job (payroll.prepare or labour.manage): the agreed rate and quantity on a BQ item
 * for a gang or a labourer, in the item's unit or one D5.1 converts exactly. Someone else
 * approves it before output is recorded against it.
 */
export function NewJobForm({
  projectId,
  items,
  gangs,
  labourers,
}: {
  projectId: string;
  items: JobItemOption[];
  gangs: { id: string; name: string; members: number }[];
  labourers: { id: string; workerNo: string; fullName: string }[];
}) {
  const t = useTranslations("subcontracts.pieceRate.create");
  const problem = useSubcontractProblem();
  const router = useRouter();
  const today = nairobiDate();
  const [lineage, setLineage] = useState(items[0]?.lineageId ?? "");
  const item = items.find((row) => row.lineageId === lineage);
  const [unit, setUnit] = useState(items[0]?.units[0]?.unit ?? "");
  const [worker, setWorker] = useState(
    gangs[0] ? `gang:${gangs[0].id}` : labourers[0] ? `labourer:${labourers[0].id}` : "",
  );
  const [description, setDescription] = useState("");
  const [rate, setRate] = useState("");
  const [quantity, setQuantity] = useState("");
  const [start, setStart] = useState(today);
  const [end, setEnd] = useState(today);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function create() {
    const rateMinor = parseKesInput(rate);
    const agreed = parseDecimalInput(quantity, 3, { maxWhole: 9 });
    const [kind, id] = worker.split(":");
    if (!item || rateMinor === null || agreed === null || !id || description.trim().length < 3) {
      setFailure(t("invalid"));
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      const result = await liveRequest(
        `/payroll/projects/${projectId}/piece-rate-jobs`,
        pieceRateJobResponseSchema,
        {
          method: "POST",
          body: {
            bqItemLineageId: item.lineageId,
            ...(kind === "gang" ? { gangId: id } : { labourerId: id }),
            description: description.trim(),
            unit,
            rateMinor,
            agreedQuantity: agreed,
            startDate: start,
            endDate: end,
          },
        },
      );
      router.push(`/subcontracts/piece-rate-jobs/${result.job.id}`);
    } catch (error) {
      setFailure(problem(error));
      setBusy(false);
    }
  }

  if (!items.length || (!gangs.length && !labourers.length))
    return <p className="text-sm text-muted-foreground">{t("nothing")}</p>;
  return (
    <form
      className={formClass}
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <h3 className="font-semibold sm:col-span-2">{t("title")}</h3>
      <Field className="sm:col-span-2">
        <FieldLabel htmlFor="job-item">{t("item")}</FieldLabel>
        <select
          id="job-item"
          className={selectClass}
          value={lineage}
          onChange={(event) => {
            setLineage(event.target.value);
            setUnit(
              items.find((row) => row.lineageId === event.target.value)?.units[0]?.unit ?? "",
            );
          }}
        >
          {items.map((row) => (
            <option key={row.lineageId} value={row.lineageId}>
              {row.label}
            </option>
          ))}
        </select>
      </Field>
      <Field>
        <FieldLabel htmlFor="job-worker">{t("worker")}</FieldLabel>
        <select
          id="job-worker"
          className={selectClass}
          value={worker}
          onChange={(event) => setWorker(event.target.value)}
        >
          {gangs.map((gang) => (
            <option key={gang.id} value={`gang:${gang.id}`}>
              {t("gang", { name: gang.name, members: gang.members })}
            </option>
          ))}
          {labourers.map((labourer) => (
            <option key={labourer.id} value={`labourer:${labourer.id}`}>
              {labourer.workerNo} · {labourer.fullName}
            </option>
          ))}
        </select>
      </Field>
      <Field>
        <FieldLabel htmlFor="job-unit">{t("unit")}</FieldLabel>
        <select
          id="job-unit"
          className={selectClass}
          value={unit}
          onChange={(event) => setUnit(event.target.value)}
        >
          {(item?.units ?? []).map((row) => (
            <option key={row.unit} value={row.unit}>
              {row.factor === "1"
                ? row.unit
                : t("converted", { unit: row.unit, factor: row.factor })}
            </option>
          ))}
        </select>
        <FieldDescription>{t("unitHint")}</FieldDescription>
      </Field>
      <Field className="sm:col-span-2">
        <FieldLabel htmlFor="job-description">{t("description")}</FieldLabel>
        <Input
          id="job-description"
          maxLength={200}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          required
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="job-rate">{t("rate")}</FieldLabel>
        <Input
          id="job-rate"
          inputMode="decimal"
          value={rate}
          onChange={(event) => setRate(event.target.value)}
          required
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="job-quantity">{t("quantity")}</FieldLabel>
        <Input
          id="job-quantity"
          inputMode="decimal"
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
          required
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="job-start">{t("start")}</FieldLabel>
        <Input
          id="job-start"
          type="date"
          value={start}
          onChange={(event) => setStart(event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="job-end">{t("end")}</FieldLabel>
        <Input
          id="job-end"
          type="date"
          value={end}
          min={start}
          onChange={(event) => setEnd(event.target.value)}
        />
      </Field>
      <div className="space-y-2 sm:col-span-2">
        <Failure message={failure} />
        <Button type="submit" disabled={busy || !DATE.test(start) || !DATE.test(end)}>
          {t("submit")}
        </Button>
      </div>
    </form>
  );
}

/** Asks for more quantity on an approved job, with a reason; someone else approves it. */
export function ExtensionForm({ jobId, unit }: { jobId: string; unit: string }) {
  const t = useTranslations("subcontracts.pieceRate.extension");
  const problem = useSubcontractProblem();
  const router = useRouter();
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  return (
    <form
      className={formClass}
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = parseDecimalInput(quantity, 3, { maxWhole: 9 });
        if (parsed === null || Array.from(reason.trim()).length < 3) {
          setFailure(t("invalid"));
          return;
        }
        setBusy(true);
        setFailure(null);
        liveRequest(`/payroll/piece-rate-jobs/${jobId}/extensions`, pieceRateJobResponseSchema, {
          method: "POST",
          body: { quantity: parsed, reason: reason.trim() },
        })
          .then(() => {
            setQuantity("");
            setReason("");
            router.refresh();
          })
          .catch((error: unknown) => setFailure(problem(error)))
          .finally(() => setBusy(false));
      }}
    >
      <h3 className="font-semibold sm:col-span-2">{t("title")}</h3>
      <Field>
        <FieldLabel htmlFor="extension-quantity">{t("quantity", { unit })}</FieldLabel>
        <Input
          id="extension-quantity"
          inputMode="decimal"
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
          required
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="extension-reason">{t("reason")}</FieldLabel>
        <Input
          id="extension-reason"
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          required
        />
      </Field>
      <div className="space-y-2 sm:col-span-2">
        <Failure message={failure} />
        <Button type="submit" disabled={busy}>
          {t("submit")}
        </Button>
      </div>
    </form>
  );
}

export type JobOption = {
  id: string;
  code: string;
  label: string;
  worker: string;
  unit: string;
  rateMinor: number;
  remaining: string;
  startDate: string;
  endDate: string;
  /** The job's dates as shown to the user. */
  datesLabel: string;
};

/**
 * Piece-rate output against a job (attendance.record or payroll.prepare): the job picker fixes
 * the BQ item, the worker, the unit and the rate, so only the day and the quantity are typed. A
 * fresh Idempotency-Key per entry makes a retry on a weak connection safe.
 */
export function JobOutputForm({
  jobs,
  initialJobId,
}: {
  jobs: JobOption[];
  initialJobId?: string;
}) {
  const t = useTranslations("subcontracts.pieceRate.output");
  const problem = useSubcontractProblem();
  const router = useRouter();
  const today = nairobiDate();
  const [jobId, setJobId] = useState(
    jobs.some((job) => job.id === initialJobId) ? initialJobId! : (jobs[0]?.id ?? ""),
  );
  const job = jobs.find((row) => row.id === jobId);
  const [date, setDate] = useState(today);
  const [quantity, setQuantity] = useState("");
  const [key, setKey] = useState(newIdempotencyKey);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  if (!jobs.length) return <p className="text-sm text-muted-foreground">{t("noJobs")}</p>;
  const parsed = parseDecimalInput(quantity, 3, { maxWhole: 9 });
  const amount = job && parsed !== null ? outputAmountMinor(parsed, job.rateMinor) : null;
  return (
    <form
      className={formClass}
      onSubmit={(event) => {
        event.preventDefault();
        if (!job || parsed === null) {
          setFailure(t("invalid"));
          return;
        }
        setBusy(true);
        setFailure(null);
        setSaved(null);
        liveRequest(`/payroll/piece-rate-jobs/${job.id}/outputs`, pieceRateJobResponseSchema, {
          method: "POST",
          body: { workDate: date, quantity: parsed },
          headers: { "Idempotency-Key": key },
        })
          .then(() => {
            setSaved(t("saved", { quantity: parsed, unit: job.unit, code: job.code }));
            setQuantity("");
            setKey(newIdempotencyKey());
            router.refresh();
          })
          .catch((error: unknown) => setFailure(problem(error)))
          .finally(() => setBusy(false));
      }}
    >
      <h3 className="font-semibold sm:col-span-2">{t("formTitle")}</h3>
      <Field className="sm:col-span-2">
        <FieldLabel htmlFor="output-job">{t("job")}</FieldLabel>
        <select
          id="output-job"
          className={selectClass}
          value={jobId}
          onChange={(event) => {
            setJobId(event.target.value);
            setKey(newIdempotencyKey());
          }}
        >
          {jobs.map((row) => (
            <option key={row.id} value={row.id}>
              {row.code} · {row.label}
            </option>
          ))}
        </select>
      </Field>
      {job ? (
        <dl className="grid grid-cols-2 gap-2 rounded-lg bg-muted/50 p-3 text-sm sm:col-span-2">
          <div>
            <dt className="text-muted-foreground">{t("worker")}</dt>
            <dd>{job.worker}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("rate")}</dt>
            <dd className="tabular-nums">
              {t("perUnit", { amount: formatKES(job.rateMinor), unit: job.unit })}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("remaining")}</dt>
            <dd className="tabular-nums">
              {job.remaining} {job.unit}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("dates")}</dt>
            <dd>{job.datesLabel}</dd>
          </div>
        </dl>
      ) : null}
      <Field>
        <FieldLabel htmlFor="output-date">{t("date")}</FieldLabel>
        <Input
          id="output-date"
          type="date"
          value={date}
          max={today}
          min={job?.startDate}
          onChange={(event) => setDate(event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="output-quantity">
          {t("quantity", { unit: job?.unit ?? "" })}
        </FieldLabel>
        <Input
          id="output-quantity"
          inputMode="decimal"
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
          required
        />
        <FieldDescription>
          {amount === null ? t("rateFixed") : t("amount", { amount: formatKES(amount) })}
        </FieldDescription>
      </Field>
      <div className="space-y-2 sm:col-span-2">
        <Failure message={failure} />
        {saved ? (
          <p role="status" className="text-sm text-success">
            {saved}
          </p>
        ) : null}
        <Button type="submit" disabled={busy || !DATE.test(date)}>
          {t("submit")}
        </Button>
      </div>
    </form>
  );
}
