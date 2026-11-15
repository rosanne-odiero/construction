"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { BadgeCheck, FilePlus2, Power, PowerOff, Upload } from "lucide-react";
import {
  BIOMETRIC_CAPTURE_METHODS,
  CONTROLLER_DECISIONS,
  DPIA_GO_LIVE_CONDITIONS,
  DPO_OPINIONS,
  RESIDUAL_RISK_LEVELS,
  type BiometricCaptureMethod,
} from "@pm-buddy/types";
import {
  biometricSwitchResponseSchema,
  dpiaResponseSchema,
  type BiometricSite,
  type DpiaDetail,
} from "@pm-buddy/validation";
import { ActionDialog, selectClass } from "@/components/labour/action-dialog";
import { useStepUp } from "@/components/projects/step-up";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  dpiaFormState,
  dpiaRequest,
  renewalRequest,
  shortHash,
  type DpiaFormState,
} from "@/lib/biometrics";
import { liveRequest, liveUpload } from "@/lib/live-api";
import { calendarInput, parseCalendarInput } from "@/lib/project-input";

/**
 * Starts the next DPIA version (biometrics.manage). A renewal is prefilled from the DPIA in force
 * (methods, sites, names, residual risk); the opinion, decision and signed document are new.
 */
export function StartDpiaButton({ currentId }: { currentId: string | null }) {
  const t = useTranslations("biometrics.dpia");
  const router = useRouter();
  const problem = useProblemMessage();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <Button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setFailure(null);
          try {
            const current = currentId
              ? (await liveRequest(`/biometrics/dpias/${currentId}`, dpiaResponseSchema)).dpia
              : null;
            const { dpia } = await liveRequest("/biometrics/dpias", dpiaResponseSchema, {
              method: "POST",
              body: renewalRequest(current),
            });
            router.push(`/attendance/biometrics/dpias/${dpia.id}`);
          } catch (error) {
            setFailure(problem(error));
            setBusy(false);
          }
        }}
      >
        <FilePlus2 aria-hidden /> {currentId ? t("renew") : t("start")}
      </Button>
      {currentId ? <p className="text-sm text-muted-foreground">{t("startHint")}</p> : null}
      {failure ? (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Switches one site and method on (biometrics.approve, fresh step-up; the API refuses wherever the
 * gate is closed) or off (always allowed).
 */
export function SiteSwitchButton({
  site,
  method,
  enabled,
}: {
  site: Pick<BiometricSite, "id" | "name">;
  method: BiometricCaptureMethod;
  enabled: boolean;
}) {
  const t = useTranslations("biometrics");
  const router = useRouter();
  const problem = useProblemMessage();
  const stepUp = useStepUp();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const label = t(enabled ? "sites.switchOnLabel" : "sites.switchOffLabel", {
    method: t(`methods.${method}`),
    site: site.name,
  });
  return (
    <>
      <Button
        size="sm"
        variant={enabled ? "default" : "outline"}
        disabled={busy}
        aria-label={label}
        onClick={async () => {
          setBusy(true);
          setFailure(null);
          try {
            await stepUp.run(() =>
              liveRequest(
                `/biometrics/sites/${site.id}/methods/${method}`,
                biometricSwitchResponseSchema,
                { method: "PUT", body: { enabled } },
              ),
            );
            router.refresh();
          } catch (error) {
            setFailure(problem(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        {enabled ? <Power aria-hidden /> : <PowerOff aria-hidden />}
        {enabled ? t("sites.switchOn") : t("sites.switchOff")}
      </Button>
      {failure ? (
        <p role="alert" className="basis-full text-sm text-destructive">
          {failure}
        </p>
      ) : null}
      {stepUp.dialog}
    </>
  );
}

/** The draft editor (biometrics.manage): saving replaces every field and the sites in scope. */
export function DpiaForm({ dpia, sites }: { dpia: DpiaDetail; sites: readonly BiometricSite[] }) {
  const t = useTranslations("biometrics");
  const router = useRouter();
  const problem = useProblemMessage();
  const [form, setForm] = useState<DpiaFormState>(() => dpiaFormState(dpia));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const set = (change: Partial<DpiaFormState>) => setForm({ ...form, ...change });
  const toggle = (list: string[], value: string, on: boolean) =>
    on ? [...new Set([...list, value])] : list.filter((entry) => entry !== value);
  const request = dpiaRequest(form);
  const projects = [...new Set(sites.map((site) => site.projectId))];
  const text = (
    id: string,
    key: keyof DpiaFormState,
    label: string,
    options: { hint?: string; max?: number } = {},
  ) => (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        value={form[key] as string}
        maxLength={options.max ?? 120}
        onChange={(event) => set({ [key]: event.target.value })}
        {...(options.hint ? { placeholder: options.hint } : {})}
      />
    </Field>
  );
  const select = (
    id: string,
    key: "dpoOpinion" | "controllerDecision" | "residualRisk",
    label: string,
    options: readonly { value: string; label: string }[],
  ) => (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <select
        id={id}
        value={form[key]}
        onChange={(event) => set({ [key]: event.target.value })}
        className={selectClass}
      >
        <option value="">{t("form.choose")}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
  const note = (id: string, key: "dpoNote" | "controllerNote") => (
    <Field className="sm:col-span-2">
      <FieldLabel htmlFor={id}>{t("detail.note")}</FieldLabel>
      <Textarea
        id={id}
        value={form[key]}
        maxLength={2000}
        rows={3}
        onChange={(event) => set({ [key]: event.target.value })}
      />
    </Field>
  );
  return (
    <form
      aria-labelledby="dpia-form-title"
      className="space-y-6 rounded-xl border p-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!request) {
          setNotice({ error: true, text: t("form.invalidDate") });
          return;
        }
        setBusy(true);
        setNotice(null);
        try {
          await liveRequest(`/biometrics/dpias/${dpia.id}`, dpiaResponseSchema, {
            method: "PUT",
            body: { ...request, version: dpia.version },
          });
          setNotice({ error: false, text: t("form.saved") });
          router.refresh();
        } catch (error) {
          setNotice({ error: true, text: problem(error) });
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2 id="dpia-form-title" className="text-lg font-semibold">
        {t("form.title")}
      </h2>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("detail.methods")}</legend>
        <div className="flex flex-wrap gap-4">
          {BIOMETRIC_CAPTURE_METHODS.map((method) => (
            <label key={method} className="flex items-center gap-1.5 text-sm">
              <Checkbox
                checked={form.methods.includes(method)}
                onCheckedChange={(checked) =>
                  set({ methods: toggle(form.methods, method, checked === true) })
                }
              />
              {t(`methods.${method}`)}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("detail.sites")}</legend>
        {sites.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("sites.none")}</p>
        ) : null}
        {projects.map((projectId) => {
          const inProject = sites.filter((site) => site.projectId === projectId);
          const first = inProject[0]!;
          return (
            <div key={projectId} className="space-y-1">
              <p className="text-sm text-muted-foreground">
                {first.projectCode} · {first.projectName}
              </p>
              <div className="flex flex-wrap gap-4">
                {inProject.map((site) => (
                  <label key={site.id} className="flex items-center gap-1.5 text-sm">
                    <Checkbox
                      checked={form.siteIds.includes(site.id)}
                      onCheckedChange={(checked) =>
                        set({ siteIds: toggle(form.siteIds, site.id, checked === true) })
                      }
                    />
                    {site.name}
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </fieldset>
      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-medium">{t("detail.dpo")}</legend>
        {text("dpia-dpo-name", "dpoName", t("detail.name"))}
        {select(
          "dpia-dpo-opinion",
          "dpoOpinion",
          t("detail.opinion"),
          DPO_OPINIONS.map((value) => ({ value, label: t(`opinions.${value}`) })),
        )}
        {text("dpia-dpo-date", "dpoOpinionOn", t("detail.date"), { hint: t("form.dateHint") })}
        {note("dpia-dpo-note", "dpoNote")}
      </fieldset>
      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-medium">{t("detail.controller")}</legend>
        {text("dpia-controller-name", "controllerName", t("detail.name"))}
        {text("dpia-controller-role", "controllerRole", t("detail.role"))}
        {select(
          "dpia-controller-decision",
          "controllerDecision",
          t("detail.decision"),
          CONTROLLER_DECISIONS.map((value) => ({ value, label: t(`decisions.${value}`) })),
        )}
        {text("dpia-controller-date", "controllerDecisionOn", t("detail.date"), {
          hint: t("form.dateHint"),
        })}
        {note("dpia-controller-note", "controllerNote")}
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        {select(
          "dpia-residual-risk",
          "residualRisk",
          t("detail.residualRisk"),
          RESIDUAL_RISK_LEVELS.map((value) => ({ value, label: t(`risks.${value}`) })),
        )}
        {text("dpia-odpc-reference", "odpcReference", t("detail.odpcReference"), { max: 80 })}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy}>
          {t("form.save")}
        </Button>
        <p
          role={notice?.error ? "alert" : "status"}
          className={notice?.error ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
        >
          {notice?.text ?? ""}
        </p>
      </div>
    </form>
  );
}

/** Uploads the signed DPIA (PDF) to a draft; it replaces an earlier upload. */
export function DpiaDocumentUpload({ dpia }: { dpia: DpiaDetail }) {
  const t = useTranslations("biometrics.upload");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const title = dpia.document ? t("replace") : t("upload");
  return (
    <>
      <Button
        variant={dpia.document ? "outline" : "default"}
        onClick={() => {
          setFile(null);
          setOpen(true);
        }}
      >
        <Upload aria-hidden /> {title}
      </Button>
      <ActionDialog
        id="dpia-upload"
        open={open}
        onOpenChange={setOpen}
        title={title}
        description={t("hint")}
        submitLabel={t("submit")}
        submitDisabled={!file}
        onSubmit={async () => {
          await liveUpload(`/biometrics/dpias/${dpia.id}/document`, file!, dpiaResponseSchema);
          router.refresh();
        }}
      >
        <Field>
          <FieldLabel htmlFor="dpia-file">{t("file")}</FieldLabel>
          <Input
            id="dpia-file"
            type="file"
            accept="application/pdf,.pdf"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </Field>
      </ActionDialog>
    </>
  );
}

/** Approve, close as not approved, or withdraw (biometrics.approve, fresh step-up). */
export function DpiaDecisions({ dpia }: { dpia: DpiaDetail }) {
  const t = useTranslations("biometrics");
  const router = useRouter();
  const stepUp = useStepUp();
  const [dialog, setDialog] = useState<"approve" | "reject" | "withdraw" | null>(null);
  const [reviewDue, setReviewDue] = useState(calendarInput(dpia.reviewDueRange.latest));
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState("");
  const parsedReview = parseCalendarInput(reviewDue);
  const decide = (action: "approve" | "reject" | "withdraw", body: Record<string, unknown>) =>
    stepUp.run(() =>
      liveRequest(`/biometrics/dpias/${dpia.id}/${action}`, dpiaResponseSchema, {
        method: "POST",
        body: { ...body, version: dpia.version },
      }),
    );
  const open = (next: "approve" | "reject" | "withdraw") => {
    setReason("");
    setConfirmed(new Set());
    setReviewDue(calendarInput(dpia.reviewDueRange.latest));
    setDialog(next);
  };
  const { canApprove, canReject, canWithdraw } = dpia.permissions;
  if (!canApprove && !canReject && !canWithdraw) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {canApprove ? (
        <Button disabled={dpia.approvalGaps.length > 0} onClick={() => open("approve")}>
          <BadgeCheck aria-hidden /> {t("approve.button")}
        </Button>
      ) : null}
      {canReject ? (
        <Button variant="outline" onClick={() => open("reject")}>
          {t("reject.button")}
        </Button>
      ) : null}
      {canWithdraw ? (
        <Button variant="destructive" onClick={() => open("withdraw")}>
          {t("withdraw.button")}
        </Button>
      ) : null}
      <ActionDialog
        id="dpia-approve"
        open={dialog === "approve"}
        onOpenChange={(next) => setDialog(next ? "approve" : null)}
        title={t("approve.title", { version: dpia.versionNo })}
        description={t("approve.description")}
        submitLabel={t("approve.submit")}
        submitDisabled={
          !parsedReview ||
          !dpia.document ||
          DPIA_GO_LIVE_CONDITIONS.some((condition) => !confirmed.has(condition))
        }
        onSubmit={async () => {
          await decide("approve", {
            documentSha256: dpia.document!.sha256,
            reviewDue: parsedReview,
            confirmations: [...confirmed],
          });
          router.refresh();
        }}
      >
        {dpia.document ? (
          <p className="text-sm break-words">
            {t("approve.document", {
              name: dpia.document.fileName,
              hash: shortHash(dpia.document.sha256),
            })}
          </p>
        ) : null}
        <Field>
          <FieldLabel htmlFor="dpia-review-due">{t("approve.reviewDue")}</FieldLabel>
          <Input
            id="dpia-review-due"
            value={reviewDue}
            placeholder={t("form.dateHint")}
            onChange={(event) => setReviewDue(event.target.value)}
          />
          <FieldDescription>
            {t("approve.reviewHint", {
              earliest: calendarInput(dpia.reviewDueRange.earliest),
              latest: calendarInput(dpia.reviewDueRange.latest),
            })}
          </FieldDescription>
        </Field>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t("approve.conditions")}</legend>
          {DPIA_GO_LIVE_CONDITIONS.map((condition) => (
            <label key={condition} className="flex items-start gap-2 text-sm">
              <Checkbox
                className="mt-0.5"
                checked={confirmed.has(condition)}
                onCheckedChange={(checked) => {
                  const next = new Set(confirmed);
                  if (checked === true) next.add(condition);
                  else next.delete(condition);
                  setConfirmed(next);
                }}
              />
              {t(`conditions.${condition}`)}
            </label>
          ))}
        </fieldset>
      </ActionDialog>
      {(["reject", "withdraw"] as const).map((action) => (
        <ActionDialog
          key={action}
          id={`dpia-${action}`}
          open={dialog === action}
          onOpenChange={(next) => setDialog(next ? action : null)}
          title={t(`${action}.title`, { version: dpia.versionNo })}
          description={t(`${action}.description`)}
          submitLabel={t(`${action}.submit`)}
          submitDisabled={reason.trim().length < 10}
          destructive={action === "withdraw"}
          onSubmit={async () => {
            await decide(action, { reason });
            router.refresh();
          }}
        >
          <Field>
            <FieldLabel htmlFor={`dpia-${action}-reason`}>{t(`${action}.reason`)}</FieldLabel>
            <Textarea
              id={`dpia-${action}-reason`}
              value={reason}
              maxLength={500}
              rows={3}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
        </ActionDialog>
      ))}
      {stepUp.dialog}
    </div>
  );
}
