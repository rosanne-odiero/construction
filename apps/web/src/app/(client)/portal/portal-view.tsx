"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  BadgeCheck,
  Banknote,
  CalendarDays,
  Check,
  CircleAlert,
  CloudRain,
  HardHat,
  ImageIcon,
  LoaderCircle,
  MapPin,
  Smartphone,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ProgressRing } from "@/components/progress-ring";
import { StatusBadge } from "@/components/status-badge";
import {
  formatDate,
  formatDateTime,
  formatForeign,
  formatKES,
  normalizeKenyanPhone,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  MPESA_STK_LIMIT_MINOR,
  certificates,
  diaryWeek,
  fxRates,
  paymentInstructions,
  pendingVariation,
  portalClient,
  portalPhotos,
} from "@/mocks/portal";
import { getProject } from "@/mocks/projects";

type Currency = "KES" | "GBP" | "USD" | "EUR";

export function PortalView() {
  const t = useTranslations("portal");
  const tMilestones = useTranslations("milestones");
  const project = getProject("kitengela-bungalow")!;
  const [currency, setCurrency] = useState<Currency>(portalClient.preferredCurrency);
  const [voDecision, setVoDecision] = useState<"approved" | "rejected" | null>(null);
  const [voComment, setVoComment] = useState("");
  const [payOpen, setPayOpen] = useState(false);
  const [showBank, setShowBank] = useState(false);
  const [paidMinor, setPaidMinor] = useState(0);

  const money = (minor: number) => {
    if (currency === "KES") return formatKES(minor);
    return `${formatForeign(minor, currency, fxRates[currency])}`;
  };
  const due = certificates.find((c) => c.status === "due")!;
  const balance = due.amountMinor - paidMinor;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm text-muted-foreground">
            {t("welcome", { name: portalClient.name })}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
          <p className="flex items-center gap-1 text-sm text-muted-foreground">
            <MapPin className="size-4" aria-hidden /> {project.town}, {project.county}
          </p>
        </div>
        <div className="space-y-1">
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            spacing={0}
            value={currency}
            onValueChange={(v) => v && setCurrency(v as Currency)}
            aria-label={t("currency")}
          >
            {(["KES", "GBP", "USD", "EUR"] as const).map((c) => (
              <ToggleGroupItem key={c} value={c} className="px-3 text-xs font-semibold">
                {c}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <p className="text-xs text-muted-foreground">
            {t("fxNote", { asOf: formatDateTime(fxRates.asOf) })}
          </p>
        </div>
      </div>

      {/* On mobile the two columns dissolve (display: contents) so cards can be re-ordered: payment due comes before photos. */}
      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-3 lg:items-start">
        <div className="contents lg:col-span-2 lg:block lg:space-y-6">
          <Card className="order-1">
            <CardContent className="flex flex-col items-center gap-6 sm:flex-row">
              <ProgressRing
                value={project.progress}
                label={t("progressLabel", { pct: Math.round(project.progress * 100) })}
              />
              <div className="flex-1 space-y-3 text-center sm:text-left">
                <StatusBadge tone="success">{t("onTrack")}</StatusBadge>
                <p className="text-lg font-medium">
                  {t("progressSummary", { planned: Math.round(project.plannedProgress * 100) })}
                </p>
                <dl className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <dt className="text-muted-foreground">{t("contractSum")}</dt>
                    <dd className="font-medium tabular-nums">{money(project.revisedSumMinor)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t("handover")}</dt>
                    <dd className="font-medium tabular-nums">{formatDate(project.endDate)}</dd>
                  </div>
                </dl>
              </div>
            </CardContent>
          </Card>

          {voDecision === null ? (
            <Card className="order-2 border-primary/40">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <CircleAlert className="size-5 text-primary" aria-hidden /> {t("voTitle")}
                </CardTitle>
                <CardDescription>
                  {t("voDescription", {
                    number: pendingVariation.number,
                    instruction: pendingVariation.instruction,
                    architect: pendingVariation.architect,
                    date: formatDate(pendingVariation.issued),
                  })}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm">{t("voBody")}</p>
                <p className="text-lg font-semibold tabular-nums">
                  +{money(pendingVariation.amountMinor)}{" "}
                  <span className="text-xs font-normal text-muted-foreground">{t("inclVat")}</span>
                </p>
                <Textarea
                  value={voComment}
                  onChange={(e) => setVoComment(e.target.value)}
                  placeholder={t("voCommentPlaceholder")}
                  aria-label={t("voCommentPlaceholder")}
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    onClick={() => {
                      setVoDecision("approved");
                      toast.success(t("voApprovedToast"));
                    }}
                  >
                    <Check aria-hidden /> {t("approve")}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      if (!voComment.trim()) {
                        toast.error(t("voReasonRequired"));
                        return;
                      }
                      setVoDecision("rejected");
                      toast.info(t("voRejectedToast"));
                    }}
                  >
                    <X aria-hidden /> {t("reject")}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card className="order-2">
              <CardContent className="flex items-center gap-3 text-sm">
                <BadgeCheck className="size-5 text-success" aria-hidden />
                {t(voDecision === "approved" ? "voApprovedNote" : "voRejectedNote", {
                  number: pendingVariation.number,
                })}
              </CardContent>
            </Card>
          )}

          <Card className="order-4">
            <CardHeader>
              <CardTitle>{t("photosTitle")}</CardTitle>
              <CardDescription>{t("photosDescription")}</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-3">
                {portalPhotos.map((photo) => (
                  <li key={photo.id} className="overflow-hidden rounded-lg border">
                    <div
                      className={cn(
                        "flex aspect-[4/3] items-center justify-center bg-gradient-to-br",
                        photo.tone,
                      )}
                    >
                      <ImageIcon className="size-8 text-white/80" aria-hidden />
                    </div>
                    <div className="space-y-1.5 p-2.5 text-xs sm:p-3 sm:text-sm">
                      <p className="font-medium">{t(`photos.${photo.caption}`)}</p>
                      <p className="text-xs text-muted-foreground">
                        {photo.location} · {formatDateTime(photo.date)}
                      </p>
                      {photo.verified ? (
                        <StatusBadge
                          tone="success"
                          icon={<BadgeCheck className="size-3" aria-hidden />}
                        >
                          {t("verified")}
                        </StatusBadge>
                      ) : (
                        <StatusBadge tone="warning">{t("unverified")}</StatusBadge>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              <p className="mt-4 text-xs text-muted-foreground">{t("verifiedExplainer")}</p>
            </CardContent>
          </Card>
        </div>

        <div className="contents lg:block lg:space-y-6">
          <Card className="order-3 border-primary/40">
            <CardHeader>
              <CardTitle>{t("dueTitle")}</CardTitle>
              <CardDescription>
                {t("dueDescription", {
                  number: due.number,
                  date: formatDate(due.due ?? due.issued),
                })}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <p className="text-3xl font-semibold tabular-nums">{money(balance)}</p>
                {currency !== "KES" ? (
                  <p className="text-xs text-muted-foreground">
                    {t("payInKes", { amount: formatKES(balance) })}
                  </p>
                ) : null}
                {paidMinor > 0 ? (
                  <p className="mt-1 text-xs text-success">
                    {t("partPaid", { amount: formatKES(paidMinor) })}
                  </p>
                ) : null}
              </div>
              <div className="grid gap-2">
                <Button size="lg" onClick={() => setPayOpen(true)} disabled={balance <= 0}>
                  <Smartphone aria-hidden /> {t("payMpesa")}
                </Button>
                <Button
                  size="lg"
                  variant="outline"
                  onClick={() => setShowBank((v) => !v)}
                  aria-expanded={showBank}
                >
                  <Banknote aria-hidden /> {t("payOther")}
                </Button>
              </div>
              {showBank ? (
                <dl className="grid grid-cols-2 gap-2 rounded-lg bg-muted p-3 text-sm">
                  <dt className="text-muted-foreground">{t("paybill")}</dt>
                  <dd className="font-mono">{paymentInstructions.paybill}</dd>
                  <dt className="text-muted-foreground">{t("account")}</dt>
                  <dd className="font-mono">{paymentInstructions.account}</dd>
                  <dd className="col-span-2 text-xs text-muted-foreground">{t("bankNote")}</dd>
                </dl>
              ) : null}
            </CardContent>
          </Card>

          <Card className="order-5">
            <CardHeader>
              <CardTitle>{t("milestonesTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="space-y-3">
                {project.milestones.map((m) => (
                  <li key={m.key} className="flex items-start gap-3 text-sm">
                    <span
                      className={cn(
                        "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border",
                        m.state === "done" && "border-success bg-success text-white",
                        m.state === "in_progress" && "border-primary text-primary",
                      )}
                    >
                      {m.state === "done" ? <Check className="size-3" aria-hidden /> : null}
                    </span>
                    <div>
                      <p className="font-medium">{tMilestones(m.key)}</p>
                      <p className="text-xs text-muted-foreground tabular-nums">
                        {m.actual
                          ? t("completedOn", { date: formatDate(m.actual) })
                          : t("plannedFor", { date: formatDate(m.planned) })}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>

          <Card className="order-6">
            <CardHeader>
              <CardTitle>{t("weekTitle")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p className="flex items-center gap-2">
                <HardHat className="size-4 text-muted-foreground" aria-hidden />{" "}
                {t("weekWorkers", { count: diaryWeek.avgWorkers })}
              </p>
              <p className="flex items-center gap-2">
                <CalendarDays className="size-4 text-muted-foreground" aria-hidden />{" "}
                {t("weekPlaster", { pct: diaryWeek.plasterPct })}
              </p>
              <p className="flex items-center gap-2">
                <CloudRain className="size-4 text-muted-foreground" aria-hidden />{" "}
                {t("weekRain", { days: diaryWeek.rainDays })}
              </p>
            </CardContent>
          </Card>

          <Card className="order-7">
            <CardHeader>
              <CardTitle>{t("historyTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="divide-y text-sm">
                {certificates.map((c) => (
                  <li key={c.number} className="flex items-center justify-between gap-2 py-2">
                    <div>
                      <p className="font-medium">{c.number}</p>
                      <p className="text-xs text-muted-foreground tabular-nums">
                        {formatDate(c.issued)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="tabular-nums">{money(c.amountMinor)}</p>
                      <StatusBadge tone={c.status === "paid" ? "success" : "warning"}>
                        {t(`certStatus.${c.status}`)}
                      </StatusBadge>
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>

      <StkPushDialog
        open={payOpen}
        onOpenChange={setPayOpen}
        balanceMinor={balance}
        reference={due.number}
        onPaid={(amount) => setPaidMinor((p) => p + amount)}
      />
    </div>
  );
}

function StkPushDialog({
  open,
  onOpenChange,
  balanceMinor,
  reference,
  onPaid,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  balanceMinor: number;
  reference: string;
  onPaid: (amountMinor: number) => void;
}) {
  const t = useTranslations("portal.stk");
  const [phone, setPhone] = useState("0712 345 678");
  const [amount, setAmount] = useState(String(Math.min(balanceMinor, MPESA_STK_LIMIT_MINOR) / 100));
  const [state, setState] = useState<"form" | "waiting" | "confirmed">("form");
  const normalised = normalizeKenyanPhone(phone);
  const amountMinor = Math.round(Number(amount.replace(/,/g, "")) * 100);
  const overLimit = amountMinor > MPESA_STK_LIMIT_MINOR;
  const invalidAmount =
    !Number.isFinite(amountMinor) || amountMinor <= 0 || amountMinor > balanceMinor;

  const reset = (value: boolean) => {
    onOpenChange(value);
    if (!value) setTimeout(() => setState("form"), 200);
  };

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description", { reference })}</DialogDescription>
        </DialogHeader>
        {state === "form" ? (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!normalised || overLimit || invalidAmount) return;
              setState("waiting");
              setTimeout(() => {
                setState("confirmed");
                onPaid(amountMinor);
              }, 3500);
            }}
          >
            <Field data-invalid={!normalised || undefined}>
              <FieldLabel htmlFor="stk-phone">{t("phone")}</FieldLabel>
              <Input
                id="stk-phone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                aria-invalid={!normalised}
              />
              {normalised ? (
                <FieldDescription>{t("willPrompt", { phone: normalised })}</FieldDescription>
              ) : (
                <FieldError>{t("phoneInvalid")}</FieldError>
              )}
            </Field>
            <Field data-invalid={overLimit || invalidAmount || undefined}>
              <FieldLabel htmlFor="stk-amount">{t("amount")}</FieldLabel>
              <Input
                id="stk-amount"
                inputMode="numeric"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              {overLimit ? (
                <FieldError>
                  {t("overLimit", { limit: formatKES(MPESA_STK_LIMIT_MINOR) })}
                </FieldError>
              ) : invalidAmount ? (
                <FieldError>{t("invalidAmount", { max: formatKES(balanceMinor) })}</FieldError>
              ) : (
                <FieldDescription>
                  {t("limitNote", { limit: formatKES(MPESA_STK_LIMIT_MINOR) })}
                </FieldDescription>
              )}
            </Field>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => reset(false)}>
                {t("cancel")}
              </Button>
              <Button type="submit" disabled={!normalised || overLimit || invalidAmount}>
                {t("send")}
              </Button>
            </DialogFooter>
          </form>
        ) : state === "waiting" ? (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <LoaderCircle className="size-10 animate-spin text-primary" aria-hidden />
            <p className="font-medium">{t("waitingTitle")}</p>
            <p className="text-sm text-muted-foreground">{t("waitingBody")}</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <BadgeCheck className="size-10 text-success" aria-hidden />
            <p className="font-medium">{t("confirmedTitle", { amount: formatKES(amountMinor) })}</p>
            <p className="font-mono text-sm">TKB4X9P2QM</p>
            <p className="text-sm text-muted-foreground">{t("confirmedBody")}</p>
            <Button onClick={() => reset(false)}>{t("done")}</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
