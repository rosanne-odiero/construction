"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Eye, EyeOff, Lock, ShieldAlert } from "lucide-react";
import { addCalendarDays, nairobiDate } from "@pm-buddy/domain";
import {
  ACCREDITATION_CATEGORIES,
  countyName,
  ENGAGEMENT_TYPES,
  LABOURER_STATUSES,
  RATE_BASES,
  REVEAL_PURPOSES,
  type County,
  type RevealPurpose,
  type SensitiveLabourField,
} from "@pm-buddy/types";
import {
  labourerResponseSchema,
  revealResponseSchema,
  type LabourerAttendanceResponse,
  type LabourerDetail,
  type LabourSetupResponse,
  type RevealResponse,
} from "@pm-buddy/validation";
import { StatusBadge } from "@/components/status-badge";
import { WorkerAttendance } from "@/components/attendance/worker-attendance";
import { useStepUp } from "@/components/projects/step-up";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { calendarInput, parseCalendarInput } from "@/lib/project-input";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { liveRequest } from "@/lib/live-api";
import { ActionDialog, selectClass } from "./action-dialog";
import {
  AccreditationBadge,
  ConsentBadge,
  DoNotRehireBadge,
  LabourerStatusBadge,
  localName,
} from "./labour-badges";

type Dialogs = "reveal" | "flag" | "status" | "engage" | "end" | "accreditation" | "edit" | null;

const REVEALABLE: { field: SensitiveLabourField; masked: keyof LabourerDetail }[] = [
  { field: "idNumber", masked: "idNumberMasked" },
  { field: "phone", masked: "phoneMasked" },
  { field: "kraPin", masked: "kraPinMasked" },
  { field: "nssfNumber", masked: "nssfNumberMasked" },
  { field: "shaNumber", masked: "shaNumberMasked" },
];

/**
 * The worker side panel (D3.1): masked identifiers with an audited reveal (labour.view_sensitive
 * and a fresh step-up), work details, engagements, gangs, NCA cards, consent and, for managers,
 * the do-not-rehire flag. Every change goes to the API and the page is refreshed from it.
 */
export function WorkerPanel({
  labourer,
  closeHref,
  setup,
  attendance = null,
}: {
  labourer: LabourerDetail;
  closeHref: string;
  setup: LabourSetupResponse | null;
  /** Attendance summary (D3.3); null when the caller cannot view attendance. */
  attendance?: LabourerAttendanceResponse | null;
}) {
  const t = useTranslations("labourLive.panel");
  const tLabour = useTranslations("labourLive");
  const locale = useLocale();
  const router = useRouter();
  const stepUp = useStepUp();
  const [open, setOpen] = useState(true);
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [revealField, setRevealField] = useState<SensitiveLabourField>("idNumber");
  const [revealed, setRevealed] = useState<Partial<Record<SensitiveLabourField, RevealResponse>>>(
    {},
  );
  const { permissions } = labourer;
  const manageable = setup?.manageableProjects ?? [];
  const engagedOn = new Set(labourer.engagements.filter((e) => e.open).map((e) => e.projectId));
  const engageable = manageable.filter((project) => !engagedOn.has(project.id));
  const refresh = () => router.refresh();
  const call = (path: string, method: "POST" | "PUT" | "PATCH" | "DELETE", body?: object) =>
    liveRequest(path, labourerResponseSchema, {
      method,
      body: body as Record<string, unknown> | undefined,
    });
  const base = `/labour/labourers/${labourer.id}`;

  const close = () => {
    setOpen(false);
    router.push(closeHref, { scroll: false });
  };

  const masked = (value: unknown) => (typeof value === "string" ? value : null);

  return (
    <Sheet open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{labourer.fullName}</SheetTitle>
          <SheetDescription>
            <span className="font-mono">{labourer.workerNo}</span> ·{" "}
            {localName(labourer.trade, locale)} · {localName(labourer.skillLevel, locale)}
          </SheetDescription>
          <div className="flex flex-wrap gap-1.5 pt-1">
            <LabourerStatusBadge status={labourer.status} />
            <ConsentBadge consent={labourer.consent} />
            <AccreditationBadge accreditation={labourer.accreditation} />
            {labourer.doNotRehire ? <DoNotRehireBadge /> : null}
          </div>
        </SheetHeader>

        <div className="space-y-6 px-4 pb-8 text-sm">
          <section aria-labelledby="panel-identity" className="space-y-2">
            <h3 id="panel-identity" className="font-semibold">
              {t("identity")}
            </h3>
            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {t("encryptedNote")}
            </p>
            <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-x-4 gap-y-2">
              {REVEALABLE.map(({ field, masked: key }) => {
                const value = masked(labourer[key]);
                const shown = revealed[field];
                return (
                  <div key={field} className="contents">
                    <dt className="text-muted-foreground">
                      {field === "idNumber"
                        ? t(`idTypes.${labourer.idType}`)
                        : t(`fields.${field}`)}
                    </dt>
                    <dd className="flex flex-wrap items-center gap-2">
                      <span className="font-mono">
                        {shown ? String(shown.value ?? "—") : (value ?? t("notRecorded"))}
                      </span>
                      {value && permissions.canReveal ? (
                        shown ? (
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() =>
                              setRevealed((current) => {
                                const next = { ...current };
                                delete next[field];
                                return next;
                              })
                            }
                          >
                            <EyeOff aria-hidden /> {t("hide")}
                            <span className="sr-only">: {t(`fields.${field}`)}</span>
                          </Button>
                        ) : (
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => {
                              setRevealField(field);
                              setDialog("reveal");
                            }}
                          >
                            <Eye aria-hidden /> {t("reveal")}
                            <span className="sr-only">: {t(`fields.${field}`)}</span>
                          </Button>
                        )
                      ) : null}
                    </dd>
                  </div>
                );
              })}
              <dt className="text-muted-foreground">{t("fields.nextOfKin")}</dt>
              <dd className="flex flex-wrap items-center gap-2">
                {revealed.nextOfKin?.value && typeof revealed.nextOfKin.value === "object" ? (
                  <span>
                    {revealed.nextOfKin.value.name} ({revealed.nextOfKin.value.relationship})
                    {revealed.nextOfKin.value.phone ? ` · ${revealed.nextOfKin.value.phone}` : ""}
                  </span>
                ) : (
                  <span>{labourer.nextOfKinRecorded ? t("recorded") : t("notRecorded")}</span>
                )}
                {labourer.nextOfKinRecorded && permissions.canReveal && !revealed.nextOfKin ? (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => {
                      setRevealField("nextOfKin");
                      setDialog("reveal");
                    }}
                  >
                    <Eye aria-hidden /> {t("reveal")}
                    <span className="sr-only">: {t("fields.nextOfKin")}</span>
                  </Button>
                ) : null}
              </dd>
            </dl>
          </section>

          <Separator />
          <section aria-labelledby="panel-person" className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 id="panel-person" className="font-semibold">
                {t("person")}
              </h3>
              {permissions.canManage && setup ? (
                <Button size="sm" variant="outline" onClick={() => setDialog("edit")}>
                  {t("edit.open")}
                </Button>
              ) : null}
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
              <dt className="text-muted-foreground">{t("fields.dateOfBirth")}</dt>
              <dd className="tabular-nums">
                {formatCalendarDate(labourer.dateOfBirth)} ({t("age", { age: labourer.age })})
              </dd>
              <dt className="text-muted-foreground">{t("fields.gender")}</dt>
              <dd>{t(`genders.${labourer.gender}`)}</dd>
              <dt className="text-muted-foreground">{t("fields.homeCounty")}</dt>
              <dd>{labourer.homeCounty ? countyName(labourer.homeCounty as County) : "—"}</dd>
              <dt className="text-muted-foreground">{t("fields.engagementType")}</dt>
              <dd>{t(`engagementTypes.${labourer.engagementType}`)}</dd>
              <dt className="text-muted-foreground">{t("fields.rateBasis")}</dt>
              <dd>{t(`rateBases.${labourer.rateBasis}`)}</dd>
              <dt className="text-muted-foreground">{t("fields.registeredOn")}</dt>
              <dd className="tabular-nums">{formatCalendarDate(labourer.registeredOn)}</dd>
            </dl>
          </section>

          <Separator />
          <section aria-labelledby="panel-engagements" className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 id="panel-engagements" className="font-semibold">
                {t("engagements.title")}
              </h3>
              {engageable.length && labourer.consent.status === "granted" ? (
                <Button size="sm" variant="outline" onClick={() => setDialog("engage")}>
                  {t("engagements.engage")}
                </Button>
              ) : null}
            </div>
            {labourer.engagements.length ? (
              <ul className="space-y-1.5">
                {labourer.engagements.map((engagement) => (
                  <li
                    key={engagement.id}
                    className="flex flex-wrap items-center justify-between gap-2"
                  >
                    <span>
                      <span className="font-mono text-xs">{engagement.projectCode}</span>{" "}
                      {engagement.projectName}
                      <span className="block text-xs text-muted-foreground tabular-nums">
                        {formatCalendarDate(engagement.startDate)} –{" "}
                        {engagement.endDate
                          ? formatCalendarDate(engagement.endDate)
                          : t("engagements.ongoing")}
                      </span>
                    </span>
                    {engagement.open &&
                    manageable.some((project) => project.id === engagement.projectId) ? (
                      <EndEngagementButton
                        labourerId={labourer.id}
                        engagement={engagement}
                        onDone={refresh}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">{t("engagements.none")}</p>
            )}
            {labourer.gangHistory.length ? (
              <>
                <h4 className="pt-2 text-xs font-semibold text-muted-foreground uppercase">
                  {t("gangs")}
                </h4>
                <ul className="space-y-1">
                  {labourer.gangHistory.map((membership) => (
                    <li key={membership.membershipId}>
                      <Link href={`/labour/gangs/${membership.gangId}`} className="hover:underline">
                        {membership.gangName}
                      </Link>
                      <span className="block text-xs text-muted-foreground tabular-nums">
                        {formatCalendarDate(membership.joinedOn)} –{" "}
                        {membership.leftOn
                          ? formatCalendarDate(membership.leftOn)
                          : t("engagements.ongoing")}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </section>

          {attendance ? (
            <>
              <Separator />
              <WorkerAttendance summary={attendance} />
            </>
          ) : null}

          <Separator />
          <section aria-labelledby="panel-nca" className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 id="panel-nca" className="font-semibold">
                {t("accreditations.title")}
              </h3>
              {permissions.canManage ? (
                <Button size="sm" variant="outline" onClick={() => setDialog("accreditation")}>
                  {t("accreditations.add")}
                </Button>
              ) : null}
            </div>
            {labourer.accreditations.length ? (
              <ul className="space-y-2">
                {labourer.accreditations.map((card) => (
                  <li key={card.id} className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      <span className="font-mono">{card.cardNumber}</span> ·{" "}
                      {t(`accreditations.categories.${card.category}`)}
                      <span className="block text-xs text-muted-foreground tabular-nums">
                        {t("accreditations.expires", { date: formatCalendarDate(card.expiresOn) })}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <StatusBadge
                        tone={
                          card.status === "valid"
                            ? "success"
                            : card.status === "expiring"
                              ? "warning"
                              : "danger"
                        }
                      >
                        {tLabour(`accreditation.${card.status}`)}
                      </StatusBadge>
                      {permissions.canManage ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() =>
                            void call(`${base}/accreditations/${card.id}`, "DELETE").then(refresh)
                          }
                        >
                          {t("accreditations.remove")}
                          <span className="sr-only">: {card.cardNumber}</span>
                        </Button>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">
                {labourer.accreditation.status === "missing"
                  ? t("accreditations.missing")
                  : t("accreditations.none")}
              </p>
            )}
          </section>

          <Separator />
          <section aria-labelledby="panel-consent" className="space-y-2">
            <h3 id="panel-consent" className="font-semibold">
              {t("consent.title")}
            </h3>
            {labourer.consents[0] ? (
              <p>
                {t("consent.latest", {
                  date: formatDateTime(labourer.consents[0].capturedAt),
                  name: labourer.consents[0].capturedBy.displayName,
                  language: labourer.consents[0].language.toUpperCase(),
                })}
              </p>
            ) : null}
            <Button asChild size="sm" variant="outline">
              <Link href={`/labour/${labourer.id}/consent`}>{t("consent.open")}</Link>
            </Button>
          </section>

          {labourer.doNotRehireDetail ? (
            <>
              <Separator />
              <section
                aria-labelledby="panel-dnr"
                className="space-y-2 rounded-lg border border-dashed p-3"
              >
                <h3 id="panel-dnr" className="flex items-center gap-2 font-semibold">
                  <ShieldAlert className="size-4" aria-hidden /> {t("dnr.title")}
                </h3>
                <p className="text-xs text-muted-foreground">{t("dnr.managersOnly")}</p>
                {labourer.doNotRehireDetail.flagged ? (
                  <>
                    <p>
                      {t("dnr.setBy", {
                        name: labourer.doNotRehireDetail.setBy?.displayName ?? "—",
                        date: labourer.doNotRehireDetail.setAt
                          ? formatDateTime(labourer.doNotRehireDetail.setAt)
                          : "—",
                      })}
                    </p>
                    {labourer.doNotRehireDetail.reason ? (
                      <p className="rounded bg-muted p-2">{labourer.doNotRehireDetail.reason}</p>
                    ) : null}
                  </>
                ) : (
                  <p>{t("dnr.notFlagged")}</p>
                )}
                {permissions.canFlag ? (
                  <Button
                    size="sm"
                    variant={labourer.doNotRehireDetail.flagged ? "outline" : "destructive"}
                    onClick={() => setDialog("flag")}
                  >
                    {labourer.doNotRehireDetail.flagged ? t("dnr.clear") : t("dnr.flag")}
                  </Button>
                ) : null}
              </section>
            </>
          ) : null}

          {permissions.canManage ? (
            <>
              <Separator />
              <Button size="sm" variant="outline" onClick={() => setDialog("status")}>
                {t("status.open")}
              </Button>
            </>
          ) : null}
        </div>

        <RevealDialog
          open={dialog === "reveal"}
          field={revealField}
          onOpenChange={(next) => setDialog(next ? "reveal" : null)}
          onReveal={async (purpose) => {
            const result = await stepUp.run(() =>
              liveRequest(`${base}/reveal`, revealResponseSchema, {
                method: "POST",
                body: { field: revealField, purpose },
              }),
            );
            setRevealed((current) => ({ ...current, [revealField]: result }));
          }}
        />
        <FlagDialog
          open={dialog === "flag"}
          flagged={Boolean(labourer.doNotRehireDetail?.flagged)}
          onOpenChange={(next) => setDialog(next ? "flag" : null)}
          onSubmit={async (reason) => {
            await stepUp.run(() =>
              call(`${base}/do-not-rehire`, "PUT", {
                flagged: !labourer.doNotRehireDetail?.flagged,
                reason,
                version: labourer.version,
              }),
            );
            refresh();
          }}
        />
        <StatusDialog
          open={dialog === "status"}
          labourer={labourer}
          onOpenChange={(next) => setDialog(next ? "status" : null)}
          onSubmit={async (body) => {
            await call(`${base}/status`, "POST", { ...body, version: labourer.version });
            refresh();
          }}
        />
        <EngageDialog
          open={dialog === "engage"}
          projects={engageable}
          flagged={Boolean(labourer.doNotRehire)}
          onOpenChange={(next) => setDialog(next ? "engage" : null)}
          onSubmit={async (body) => {
            await call(`${base}/engagements`, "POST", body);
            refresh();
          }}
        />
        <AccreditationDialog
          open={dialog === "accreditation"}
          onOpenChange={(next) => setDialog(next ? "accreditation" : null)}
          onSubmit={async (body) => {
            await call(`${base}/accreditations`, "POST", body);
            refresh();
          }}
        />
        {setup ? (
          <EditDialog
            open={dialog === "edit"}
            labourer={labourer}
            setup={setup}
            onOpenChange={(next) => setDialog(next ? "edit" : null)}
            onSubmit={async (body) => {
              await call(base, "PATCH", { ...body, version: labourer.version });
              refresh();
            }}
          />
        ) : null}
        {stepUp.dialog}
      </SheetContent>
    </Sheet>
  );
}

function RevealDialog({
  open,
  field,
  onOpenChange,
  onReveal,
}: {
  open: boolean;
  field: SensitiveLabourField;
  onOpenChange: (open: boolean) => void;
  onReveal: (purpose: RevealPurpose) => Promise<void>;
}) {
  const t = useTranslations("labourLive.panel");
  const [purpose, setPurpose] = useState<RevealPurpose>("identity_verification");
  return (
    <ActionDialog
      id="reveal-form"
      open={open}
      onOpenChange={onOpenChange}
      title={t("revealTitle", { field: t(`fields.${field}`) })}
      description={t("revealHint")}
      submitLabel={t("reveal")}
      onSubmit={() => onReveal(purpose)}
    >
      <Field>
        <FieldLabel htmlFor="reveal-purpose">{t("purpose")}</FieldLabel>
        <select
          id="reveal-purpose"
          className={selectClass}
          value={purpose}
          onChange={(event) => setPurpose(event.target.value as RevealPurpose)}
        >
          {REVEAL_PURPOSES.map((value) => (
            <option key={value} value={value}>
              {t(`purposes.${value}`)}
            </option>
          ))}
        </select>
      </Field>
    </ActionDialog>
  );
}

function FlagDialog({
  open,
  flagged,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  flagged: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const t = useTranslations("labourLive.panel.dnr");
  const [reason, setReason] = useState("");
  return (
    <ActionDialog
      id="flag-form"
      open={open}
      onOpenChange={onOpenChange}
      title={flagged ? t("clear") : t("flag")}
      description={t("hint")}
      submitLabel={flagged ? t("clear") : t("flag")}
      destructive={!flagged}
      submitDisabled={reason.trim().length < 10}
      onSubmit={() => onSubmit(reason.trim())}
    >
      <Field>
        <FieldLabel htmlFor="flag-reason">{t("reason")}</FieldLabel>
        <Textarea
          id="flag-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          minLength={10}
          maxLength={500}
          rows={3}
          required
          aria-describedby="flag-reason-hint"
        />
        <FieldDescription id="flag-reason-hint">{t("reasonHint")}</FieldDescription>
      </Field>
    </ActionDialog>
  );
}

function StatusDialog({
  open,
  labourer,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  labourer: LabourerDetail;
  onOpenChange: (open: boolean) => void;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
}) {
  const t = useTranslations("labourLive.panel.status");
  const tStatus = useTranslations("labourLive.status");
  const choices = LABOURER_STATUSES.filter((status) => status !== labourer.status);
  const [to, setTo] = useState(choices[0]!);
  const [reason, setReason] = useState("");
  const [override, setOverride] = useState("");
  const needsOverride = to === "active" && Boolean(labourer.doNotRehire);
  return (
    <ActionDialog
      id="status-form"
      open={open}
      onOpenChange={onOpenChange}
      title={t("title")}
      description={t("description")}
      submitLabel={t("submit")}
      submitDisabled={needsOverride && override.trim().length < 10}
      onSubmit={() =>
        onSubmit({
          to,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
          ...(needsOverride ? { doNotRehireOverride: { reason: override.trim() } } : {}),
        })
      }
    >
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium">{t("to")}</legend>
        {choices.map((status) => (
          <label key={status} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="labourer-status"
              value={status}
              checked={to === status}
              onChange={() => setTo(status)}
              className="size-4 accent-primary"
            />
            {tStatus(status)}
          </label>
        ))}
      </fieldset>
      {to === "left" ? <p className="text-sm text-muted-foreground">{t("leftHint")}</p> : null}
      <Field>
        <FieldLabel htmlFor="status-reason">{t("reason")}</FieldLabel>
        <Textarea
          id="status-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={500}
          rows={2}
        />
      </Field>
      {needsOverride ? <OverrideField value={override} onChange={setOverride} /> : null}
    </ActionDialog>
  );
}

function OverrideField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const t = useTranslations("labourLive.override");
  return (
    <Field>
      <FieldLabel htmlFor="override-reason">{t("reason")}</FieldLabel>
      <Textarea
        id="override-reason"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        minLength={10}
        maxLength={500}
        rows={3}
        required
        aria-describedby="override-hint"
      />
      <FieldDescription id="override-hint">{t("hint")}</FieldDescription>
    </Field>
  );
}

function EngageDialog({
  open,
  projects,
  flagged,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  projects: LabourSetupResponse["manageableProjects"];
  flagged: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
}) {
  const t = useTranslations("labourLive.panel.engagements");
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [start, setStart] = useState(calendarInput(nairobiDate()));
  const [override, setOverride] = useState("");
  const startDate = parseCalendarInput(start);
  return (
    <ActionDialog
      id="engage-form"
      open={open}
      onOpenChange={onOpenChange}
      title={t("engageTitle")}
      description={t("engageHint")}
      submitLabel={t("engage")}
      submitDisabled={!projectId || !startDate || (flagged && override.trim().length < 10)}
      onSubmit={() =>
        onSubmit({
          projectId,
          startDate: startDate ?? undefined,
          ...(flagged ? { doNotRehireOverride: { reason: override.trim() } } : {}),
        })
      }
    >
      <Field>
        <FieldLabel htmlFor="engage-project">{t("project")}</FieldLabel>
        <select
          id="engage-project"
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
      <Field>
        <FieldLabel htmlFor="engage-start">{t("startDate")}</FieldLabel>
        <Input
          id="engage-start"
          value={start}
          onChange={(event) => setStart(event.target.value)}
          inputMode="numeric"
          aria-describedby="engage-start-hint"
        />
        <FieldDescription id="engage-start-hint">{t("dateHint")}</FieldDescription>
      </Field>
      {flagged ? <OverrideField value={override} onChange={setOverride} /> : null}
    </ActionDialog>
  );
}

function EndEngagementButton({
  labourerId,
  engagement,
  onDone,
}: {
  labourerId: string;
  engagement: LabourerDetail["engagements"][number];
  onDone: () => void;
}) {
  const t = useTranslations("labourLive.panel.engagements");
  const [open, setOpen] = useState(false);
  const [end, setEnd] = useState(calendarInput(nairobiDate()));
  const [reason, setReason] = useState("");
  const endDate = parseCalendarInput(end);
  return (
    <>
      <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
        {t("end")}
        <span className="sr-only">: {engagement.projectCode}</span>
      </Button>
      <ActionDialog
        id={`end-${engagement.id}`}
        open={open}
        onOpenChange={setOpen}
        title={t("endTitle", { project: engagement.projectCode })}
        description={t("endHint")}
        submitLabel={t("end")}
        submitDisabled={!endDate}
        onSubmit={async () => {
          await liveRequest(
            `/labour/labourers/${labourerId}/engagements/${engagement.id}/end`,
            labourerResponseSchema,
            {
              method: "POST",
              body: { endDate, ...(reason.trim() ? { reason: reason.trim() } : {}) },
            },
          );
          onDone();
        }}
      >
        <Field>
          <FieldLabel htmlFor={`end-date-${engagement.id}`}>{t("endDate")}</FieldLabel>
          <Input
            id={`end-date-${engagement.id}`}
            value={end}
            onChange={(event) => setEnd(event.target.value)}
            inputMode="numeric"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`end-reason-${engagement.id}`}>{t("endReason")}</FieldLabel>
          <Textarea
            id={`end-reason-${engagement.id}`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={500}
            rows={2}
          />
        </Field>
      </ActionDialog>
    </>
  );
}

function AccreditationDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
}) {
  const t = useTranslations("labourLive.panel.accreditations");
  const [category, setCategory] =
    useState<(typeof ACCREDITATION_CATEGORIES)[number]>("nca_skilled_worker");
  const [cardNumber, setCardNumber] = useState("");
  const [expires, setExpires] = useState(calendarInput(addCalendarDays(nairobiDate(), 365)));
  const expiresOn = parseCalendarInput(expires);
  return (
    <ActionDialog
      id="accreditation-form"
      open={open}
      onOpenChange={onOpenChange}
      title={t("addTitle")}
      description={t("addHint")}
      submitLabel={t("add")}
      submitDisabled={!expiresOn || cardNumber.trim().length < 3}
      onSubmit={() => onSubmit({ category, cardNumber: cardNumber.trim(), expiresOn })}
    >
      <Field>
        <FieldLabel htmlFor="nca-category">{t("category")}</FieldLabel>
        <select
          id="nca-category"
          className={selectClass}
          value={category}
          onChange={(event) => setCategory(event.target.value as typeof category)}
        >
          {ACCREDITATION_CATEGORIES.map((value) => (
            <option key={value} value={value}>
              {t(`categories.${value}`)}
            </option>
          ))}
        </select>
      </Field>
      <Field>
        <FieldLabel htmlFor="nca-card">{t("cardNumber")}</FieldLabel>
        <Input
          id="nca-card"
          value={cardNumber}
          onChange={(event) => setCardNumber(event.target.value)}
          maxLength={40}
          required
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="nca-expires">{t("expiresOn")}</FieldLabel>
        <Input
          id="nca-expires"
          value={expires}
          onChange={(event) => setExpires(event.target.value)}
          inputMode="numeric"
          aria-describedby="nca-expires-hint"
        />
        <FieldDescription id="nca-expires-hint">{t("dateHint")}</FieldDescription>
      </Field>
    </ActionDialog>
  );
}

function EditDialog({
  open,
  labourer,
  setup,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  labourer: LabourerDetail;
  setup: LabourSetupResponse;
  onOpenChange: (open: boolean) => void;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
}) {
  const t = useTranslations("labourLive.panel");
  const locale = useLocale();
  const [fullName, setFullName] = useState(labourer.fullName);
  const [tradeId, setTradeId] = useState(labourer.trade?.id ?? "");
  const [skillLevelId, setSkillLevelId] = useState(labourer.skillLevel?.id ?? "");
  const [engagementType, setEngagementType] = useState(labourer.engagementType);
  const [rateBasis, setRateBasis] = useState(labourer.rateBasis);
  const [phone, setPhone] = useState("");
  const changes = {
    ...(fullName.trim() !== labourer.fullName ? { fullName: fullName.trim() } : {}),
    ...(tradeId !== labourer.trade?.id ? { tradeId } : {}),
    ...(skillLevelId !== labourer.skillLevel?.id ? { skillLevelId } : {}),
    ...(engagementType !== labourer.engagementType ? { engagementType } : {}),
    ...(rateBasis !== labourer.rateBasis ? { rateBasis } : {}),
    ...(phone.trim() ? { phone: phone.trim() } : {}),
  };
  return (
    <ActionDialog
      id="edit-form"
      open={open}
      onOpenChange={onOpenChange}
      title={t("edit.title")}
      description={t("edit.hint")}
      submitLabel={t("edit.save")}
      submitDisabled={!Object.keys(changes).length || fullName.trim().length < 3}
      onSubmit={() => onSubmit(changes)}
    >
      <Field>
        <FieldLabel htmlFor="edit-name">{t("fields.fullName")}</FieldLabel>
        <Input
          id="edit-name"
          value={fullName}
          onChange={(event) => setFullName(event.target.value)}
          maxLength={150}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="edit-trade">{t("fields.trade")}</FieldLabel>
        <select
          id="edit-trade"
          className={selectClass}
          value={tradeId}
          onChange={(event) => setTradeId(event.target.value)}
        >
          {setup.trades
            .filter((trade) => trade.active || trade.id === labourer.trade?.id)
            .map((trade) => (
              <option key={trade.id} value={trade.id}>
                {localName(trade, locale)}
              </option>
            ))}
        </select>
      </Field>
      <Field>
        <FieldLabel htmlFor="edit-skill">{t("fields.skillLevel")}</FieldLabel>
        <select
          id="edit-skill"
          className={selectClass}
          value={skillLevelId}
          onChange={(event) => setSkillLevelId(event.target.value)}
        >
          {setup.skillLevels
            .filter((level) => level.active || level.id === labourer.skillLevel?.id)
            .map((level) => (
              <option key={level.id} value={level.id}>
                {localName(level, locale)}
              </option>
            ))}
        </select>
      </Field>
      <Field>
        <FieldLabel htmlFor="edit-engagement">{t("fields.engagementType")}</FieldLabel>
        <select
          id="edit-engagement"
          className={selectClass}
          value={engagementType}
          onChange={(event) => setEngagementType(event.target.value as typeof engagementType)}
        >
          {ENGAGEMENT_TYPES.map((value) => (
            <option key={value} value={value}>
              {t(`engagementTypes.${value}`)}
            </option>
          ))}
        </select>
      </Field>
      <Field>
        <FieldLabel htmlFor="edit-basis">{t("fields.rateBasis")}</FieldLabel>
        <select
          id="edit-basis"
          className={selectClass}
          value={rateBasis}
          onChange={(event) => setRateBasis(event.target.value as typeof rateBasis)}
        >
          {RATE_BASES.map((value) => (
            <option key={value} value={value}>
              {t(`rateBases.${value}`)}
            </option>
          ))}
        </select>
      </Field>
      <Field>
        <FieldLabel htmlFor="edit-phone">{t("edit.newPhone")}</FieldLabel>
        <Input
          id="edit-phone"
          type="tel"
          inputMode="tel"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          aria-describedby="edit-phone-hint"
        />
        <FieldDescription id="edit-phone-hint">{t("edit.newPhoneHint")}</FieldDescription>
      </Field>
    </ActionDialog>
  );
}
