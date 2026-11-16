"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import QRCode from "react-qr-code";
import { messageResponseSchema, workerCardResponseSchema } from "@pm-buddy/validation";
import { ActionDialog, selectClass } from "@/components/labour/action-dialog";
import { useStepUp } from "@/components/projects/step-up";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { liveRequest } from "@/lib/live-api";
import { attendanceCommand } from "@/lib/attendance";

export function CaptureReview({ eventId, name }: { eventId: string; name: string }) {
  const t = useTranslations("attendanceLive.capture");
  const common = useTranslations("attendanceLive.common");
  const [open, setOpen] = useState(false);
  const [decision, setDecision] = useState<"resolve" | "dismiss">("resolve");
  const [reason, setReason] = useState("");
  const stepUp = useStepUp();
  const router = useRouter();
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        {t("review")}
      </Button>
      <ActionDialog
        id={`capture-review-${eventId}`}
        open={open}
        onOpenChange={setOpen}
        title={t("reviewTitle", { name })}
        description={t("reviewHint")}
        submitLabel={t(decision)}
        submitDisabled={reason.trim().length < 10}
        onSubmit={async () => {
          await stepUp.run(() =>
            attendanceCommand(
              `/attendance/capture/events/${eventId}/review`,
              messageResponseSchema,
              { decision, reason },
            ),
          );
          setReason("");
          router.refresh();
        }}
      >
        <Field>
          <FieldLabel htmlFor={`decision-${eventId}`}>{t("review")}</FieldLabel>
          <select
            id={`decision-${eventId}`}
            value={decision}
            className={selectClass}
            onChange={(event) =>
              setDecision(event.target.value === "dismiss" ? "dismiss" : "resolve")
            }
          >
            <option value="resolve">{t("resolve")}</option>
            <option value="dismiss">{t("dismiss")}</option>
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor={`reason-${eventId}`}>{common("reason")}</FieldLabel>
          <Textarea
            id={`reason-${eventId}`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            minLength={10}
            maxLength={500}
            required
          />
        </Field>
      </ActionDialog>
      {stepUp.dialog}
    </>
  );
}

export function CaptureRevoke({ id, kind }: { id: string; kind: "cards" | "devices" }) {
  const t = useTranslations("attendanceLive.capture");
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const stepUp = useStepUp();
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        {t(kind === "cards" ? "revokeCard" : "revokeDevice")}
      </Button>
      <ActionDialog
        id={`revoke-${id}`}
        open={open}
        onOpenChange={setOpen}
        destructive
        title={t(kind === "cards" ? "revokeTitle" : "revokeDeviceTitle")}
        description={t(kind === "cards" ? "revokeHint" : "deviceHint")}
        submitLabel={t(kind === "cards" ? "revokeCard" : "revokeDevice")}
        onSubmit={async () => {
          await stepUp.run(() =>
            attendanceCommand(
              `/attendance/capture/${kind}/${id}/revoke`,
              messageResponseSchema,
              {},
            ),
          );
          router.refresh();
        }}
      >
        {null}
      </ActionDialog>
      {stepUp.dialog}
    </>
  );
}

export function WorkerCardIssue({ workers }: { workers: { id: string; name: string }[] }) {
  const t = useTranslations("attendanceLive.capture");
  const [open, setOpen] = useState(false);
  const [workerId, setWorkerId] = useState(workers[0]?.id ?? "");
  const [issued, setIssued] = useState<{ token: string; name: string } | null>(null);
  const qr = useRef<HTMLDivElement>(null);
  const router = useRouter();
  return (
    <div className="space-y-3">
      <Button
        variant="outline"
        disabled={!workers.length}
        onClick={() => {
          setIssued(null);
          setOpen(true);
        }}
      >
        {t("issue")}
      </Button>
      <ActionDialog
        id="issue-worker-card"
        open={open}
        onOpenChange={setOpen}
        title={t("issueTitle")}
        description={t("issueHint")}
        submitLabel={t("issue")}
        submitDisabled={!workerId}
        onSubmit={async () => {
          const result = await liveRequest("/attendance/capture/cards", workerCardResponseSchema, {
            method: "POST",
            body: { labourerId: workerId },
          });
          setIssued({
            token: result.card.token,
            name: workers.find((worker) => worker.id === workerId)!.name,
          });
          router.refresh();
        }}
      >
        <Field>
          <FieldLabel htmlFor="card-worker">{t("worker")}</FieldLabel>
          <select
            id="card-worker"
            className={selectClass}
            value={workerId}
            onChange={(event) => setWorkerId(event.target.value)}
          >
            {workers.map((worker) => (
              <option key={worker.id} value={worker.id}>
                {worker.name}
              </option>
            ))}
          </select>
        </Field>
      </ActionDialog>
      {issued ? (
        <section role="status" className="space-y-3 rounded-lg border p-4">
          <p className="font-medium">{issued.name}</p>
          <div ref={qr} className="w-fit bg-white p-3">
            <QRCode value={issued.token} size={192} title={issued.name} />
          </div>
          <Button
            variant="outline"
            onClick={() => {
              const svg = qr.current?.querySelector("svg");
              if (!svg) throw new Error("QR card has not rendered");
              const file = new Blob([new XMLSerializer().serializeToString(svg)], {
                type: "image/svg+xml",
              });
              const url = URL.createObjectURL(file);
              const link = document.createElement("a");
              link.href = url;
              link.download = "worker-card.svg";
              link.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            {t("saveQr")}
          </Button>
          <p className="text-sm">{t("token")}</p>
          <code className="block break-all text-xs">{issued.token}</code>
        </section>
      ) : null}
    </div>
  );
}
