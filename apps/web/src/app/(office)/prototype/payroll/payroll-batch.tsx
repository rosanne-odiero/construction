"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  Check,
  CircleCheck,
  LoaderCircle,
  ShieldCheck,
  TriangleAlert,
  Undo2,
  UserRoundX,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "@/components/ui/input-otp";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusBadge, type Tone } from "@/components/status-badge";
import { formatDateTime, formatKES, maskPhone } from "@/lib/format";
import { cn } from "@/lib/utils";
import { currentUser } from "@/mocks/company";
import { payrollBatch, payrollLines, type PayoutStatus } from "@/mocks/payroll";

const statusTone: Record<PayoutStatus, Tone> = {
  pending: "neutral",
  sent: "info",
  confirmed: "success",
  failed: "danger",
  reversed: "warning",
};

const SENT_SPACING = 0.6;
const CONFIRM_DELAY = 6;
const TICK_MS = 140;

export function PayrollBatchView() {
  const t = useTranslations("payroll");
  const [approvedAt, setApprovedAt] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [code, setCode] = useState("");
  const [tick, setTick] = useState(0);

  const lastTick = Math.floor((payrollLines.length - 1) * SENT_SPACING) + CONFIRM_DELAY;
  const phase: "awaiting" | "disbursing" | "done" = !approvedAt
    ? "awaiting"
    : tick > lastTick
      ? "done"
      : "disbursing";

  useEffect(() => {
    if (!approvedAt) return;
    const id = setInterval(
      () => setTick((value) => (value > lastTick ? value : value + 1)),
      TICK_MS,
    );
    return () => clearInterval(id);
  }, [approvedAt, lastTick]);

  useEffect(() => {
    if (phase === "done") toast.warning(t("doneToast"));
  }, [phase, t]);

  const statusOf = (index: number): PayoutStatus => {
    if (phase === "awaiting") return "pending";
    const sentAt = Math.floor(index * SENT_SPACING);
    if (tick < sentAt) return "pending";
    if (tick < sentAt + CONFIRM_DELAY) return "sent";
    return payrollLines[index].outcome.result === "failed" ? "failed" : "confirmed";
  };

  const statuses = payrollLines.map((_, i) => statusOf(i));
  const confirmed = statuses.filter((s) => s === "confirmed").length;
  const failed = statuses.filter((s) => s === "failed").length;
  const mismatches = payrollLines.filter(
    (l, i) => l.outcome.result === "name_mismatch" && statuses[i] === "confirmed",
  ).length;
  const totals = useMemo(
    () => ({
      statutory: payrollBatch.statutoryMinor,
      charges: payrollBatch.chargesMinor,
      required: payrollBatch.netMinor + payrollBatch.chargesMinor,
    }),
    [],
  );
  const floatOk = payrollBatch.floatMinor >= totals.required;
  const withinLimit = payrollBatch.netMinor <= currentUser.approvalLimitMinor;

  const steps = [
    { key: "prepared", who: payrollBatch.preparedBy, at: payrollBatch.preparedAt, done: true },
    { key: "reviewed", who: payrollBatch.reviewedBy, at: payrollBatch.reviewedAt, done: true },
    {
      key: "approved",
      who: currentUser.name,
      at: approvedAt ?? undefined,
      done: phase !== "awaiting",
    },
    {
      key: "disbursed",
      who: "M-Pesa B2C",
      at:
        phase === "done" && approvedAt
          ? new Date(Date.parse(approvedAt) + (lastTick + 1) * TICK_MS).toISOString()
          : undefined,
      done: phase === "done",
    },
  ] as const;

  return (
    <div className="space-y-6">
      <Card>
        <CardContent>
          <ol className="grid gap-4 md:grid-cols-4">
            {steps.map((step, idx) => {
              const current = !step.done && (idx === 0 || steps[idx - 1].done);
              return (
                <li key={step.key} className="flex items-start gap-3">
                  <span
                    className={cn(
                      "flex size-8 shrink-0 items-center justify-center rounded-full border text-sm font-semibold",
                      step.done && "border-success bg-success text-white",
                      current && "border-primary bg-primary text-primary-foreground",
                    )}
                  >
                    {step.done ? <Check className="size-4" aria-hidden /> : idx + 1}
                  </span>
                  <div className="min-w-0 text-sm">
                    <p className="font-medium">{t(`steps.${step.key}`)}</p>
                    <p className="truncate text-muted-foreground">{step.who}</p>
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {step.at ? formatDateTime(step.at) : current ? t("waitingForYou") : "–"}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t("summaryTitle")}</CardTitle>
            <CardDescription>
              {t("summaryDescription", { workers: payrollBatch.workers })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              {(
                [
                  { key: "gross", value: payrollBatch.grossMinor },
                  { key: "statutory", value: totals.statutory },
                  { key: "advances", value: payrollBatch.advancesMinor },
                  { key: "net", value: payrollBatch.netMinor, strong: true },
                  { key: "charges", value: totals.charges },
                  { key: "required", value: totals.required },
                ] as const
              ).map((item) => (
                <div key={item.key} className="rounded-lg border p-3">
                  <dt className="text-xs text-muted-foreground">{t(`summary.${item.key}`)}</dt>
                  <dd
                    className={cn(
                      "mt-1 tabular-nums",
                      "strong" in item ? "text-lg font-semibold" : "font-medium",
                    )}
                  >
                    {formatKES(item.value)}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="mt-4 flex items-start gap-2 rounded-md bg-warning/10 p-3 text-xs">
              <TriangleAlert
                className="mt-0.5 size-4 shrink-0 text-warning-foreground dark:text-warning"
                aria-hidden
              />
              {t("illustrative")}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("checksTitle")}</CardTitle>
            <CardAction>
              <StatusBadge
                tone={
                  phase === "awaiting" ? "warning" : phase === "disbursing" ? "info" : "success"
                }
              >
                {phase === "awaiting"
                  ? t("awaitingApproval")
                  : phase === "disbursing"
                    ? t("stagePaying")
                    : t("stageDone")}
              </StatusBadge>
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <CheckRow
              ok={floatOk}
              label={t("checks.float", { float: formatKES(payrollBatch.floatMinor) })}
            />
            <CheckRow
              ok={withinLimit}
              label={t("checks.limit", { limit: formatKES(currentUser.approvalLimitMinor) })}
            />
            <CheckRow ok label={t("checks.makerChecker")} />
            <CheckRow ok label={t("checks.timesheets")} />
            {phase === "awaiting" ? (
              <div className="flex gap-2 pt-2">
                <Button
                  className="flex-1"
                  onClick={() => setDialogOpen(true)}
                  disabled={!floatOk || !withinLimit}
                >
                  <ShieldCheck aria-hidden /> {t("approve")}
                </Button>
                <Button variant="outline" onClick={() => toast.info(t("returnedToast"))}>
                  <Undo2 aria-hidden /> {t("return")}
                </Button>
              </div>
            ) : (
              <Alert>
                {phase === "disbursing" ? (
                  <LoaderCircle className="animate-spin" aria-hidden />
                ) : (
                  <CircleCheck aria-hidden />
                )}
                <AlertTitle>
                  {t(phase === "disbursing" ? "disbursingTitle" : "doneTitle")}
                </AlertTitle>
                <AlertDescription>
                  {t("progress", { confirmed, failed, total: payrollLines.length })}
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      </div>

      {phase === "done" ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Alert variant="destructive">
            <UserRoundX aria-hidden />
            <AlertTitle>{t("failedTitle", { count: failed })}</AlertTitle>
            <AlertDescription>{t("failedDetail")}</AlertDescription>
          </Alert>
          <Alert className="border-warning/40 bg-warning/10">
            <TriangleAlert aria-hidden />
            <AlertTitle>{t("mismatchTitle", { count: mismatches })}</AlertTitle>
            <AlertDescription>{t("mismatchDetail")}</AlertDescription>
          </Alert>
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead>{t("cols.worker")}</TableHead>
              <TableHead className="text-right">{t("cols.days")}</TableHead>
              <TableHead className="text-right">{t("cols.ot")}</TableHead>
              <TableHead className="text-right">{t("cols.gross")}</TableHead>
              <TableHead className="text-right">{t("cols.statutory")}</TableHead>
              <TableHead className="text-right">{t("cols.advance")}</TableHead>
              <TableHead className="text-right">{t("cols.net")}</TableHead>
              <TableHead>{t("cols.mpesa")}</TableHead>
              <TableHead>{t("cols.status")}</TableHead>
              <TableHead>{t("cols.receipt")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {payrollLines.map((line, index) => {
              const status = statuses[index];
              const statutory = line.nssfMinor + line.shifMinor + line.ahlMinor + line.payeMinor;
              const mismatch = line.outcome.result === "name_mismatch" && status === "confirmed";
              return (
                <TableRow
                  key={line.labourer.id}
                  className={cn(
                    mismatch && "bg-warning/10",
                    status === "failed" && "bg-destructive/5",
                  )}
                >
                  <TableCell>
                    <span className="block font-medium">{line.labourer.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {line.labourer.workerNo}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{line.days}</TableCell>
                  <TableCell className="text-right tabular-nums">{line.otHours || "–"}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatKES(line.grossMinor)}
                  </TableCell>
                  <TableCell
                    className="text-right tabular-nums"
                    title={`NSSF ${formatKES(line.nssfMinor)} · SHIF ${formatKES(line.shifMinor)} · AHL ${formatKES(line.ahlMinor)} · PAYE ${formatKES(line.payeMinor)}`}
                  >
                    {formatKES(statutory)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {line.advanceMinor ? formatKES(line.advanceMinor) : "–"}
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {formatKES(line.netMinor)}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {maskPhone(line.labourer.phone)}
                  </TableCell>
                  <TableCell>
                    <StatusBadge tone={statusTone[status]}>{t(`statuses.${status}`)}</StatusBadge>
                  </TableCell>
                  <TableCell className="text-xs">
                    {status === "confirmed" ? (
                      <span className="font-mono">{line.outcome.receipt}</span>
                    ) : null}
                    {mismatch ? (
                      <span className="mt-1 block text-warning-foreground dark:text-warning">
                        {t("nameOnMpesa", { name: line.outcome.mpesaName ?? "" })}
                      </span>
                    ) : null}
                    {status === "failed" ? (
                      <span className="text-destructive">{t("failedReason")}</span>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell className="font-semibold">{t("totals")}</TableCell>
              <TableCell colSpan={2} />
              <TableCell className="text-right font-semibold tabular-nums">
                {formatKES(payrollBatch.grossMinor)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatKES(totals.statutory)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatKES(payrollBatch.advancesMinor)}
              </TableCell>
              <TableCell className="text-right font-semibold tabular-nums">
                {formatKES(payrollBatch.netMinor)}
              </TableCell>
              <TableCell colSpan={3} />
            </TableRow>
          </TableFooter>
        </Table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("stepUpTitle")}</DialogTitle>
            <DialogDescription>
              {t("stepUpDescription", {
                batch: payrollBatch.number,
                amount: formatKES(payrollBatch.netMinor),
                workers: payrollBatch.workers,
              })}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setDialogOpen(false);
              setTick(0);
              setApprovedAt(new Date().toISOString());
              toast.success(t("approvedToast"));
            }}
            className="space-y-4"
          >
            <div className="flex justify-center">
              <InputOTP
                maxLength={6}
                value={code}
                onChange={setCode}
                autoFocus
                aria-label={t("codeLabel")}
              >
                <InputOTPGroup>
                  <InputOTPSlot index={0} />
                  <InputOTPSlot index={1} />
                  <InputOTPSlot index={2} />
                </InputOTPGroup>
                <InputOTPSeparator />
                <InputOTPGroup>
                  <InputOTPSlot index={3} />
                  <InputOTPSlot index={4} />
                  <InputOTPSlot index={5} />
                </InputOTPGroup>
              </InputOTP>
            </div>
            <p className="text-center text-xs text-muted-foreground">{t("stepUpNote")}</p>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setDialogOpen(false)}>
                {t("cancel")}
              </Button>
              <Button type="submit" disabled={code.length < 6}>
                {t("confirmApprove")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CheckRow({ ok, label }: { ok: boolean; label: string }) {
  return (
    <p className="flex items-start gap-2">
      {ok ? (
        <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
      ) : (
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
      )}
      <span>{label}</span>
    </p>
  );
}
