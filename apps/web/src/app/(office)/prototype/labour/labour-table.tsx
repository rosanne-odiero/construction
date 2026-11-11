"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Eye, Lock, MessageSquareText, Search, TriangleAlert, Users } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatusBadge } from "@/components/status-badge";
import { formatDate, formatKES, initials, maskId, maskPhone } from "@/lib/format";
import { muster } from "@/mocks/attendance";
import { NOW } from "@/mocks/company";
import {
  CASUAL_CONVERSION_WARNING_DAYS,
  gangs,
  isAccreditationExpiringSoon,
  labourers,
  type Labourer,
  type TradeKey,
} from "@/mocks/labour";
import { payrollLines } from "@/mocks/payroll";

const views = ["all", "onSite", "expiring", "declined", "nearThreshold"] as const;
type View = (typeof views)[number];

const presentIds = new Set(muster.filter((m) => m.status !== "absent").map((m) => m.labourerId));

function inView(l: Labourer, view: View) {
  switch (view) {
    case "onSite":
      return presentIds.has(l.id);
    case "expiring":
      return isAccreditationExpiringSoon(l, NOW);
    case "declined":
      return l.biometricConsent === "declined";
    case "nearThreshold":
      return l.engagement === "casual" && l.continuousDays >= CASUAL_CONVERSION_WARNING_DAYS;
    default:
      return true;
  }
}

export function LabourTable({ initialWorkerId }: { initialWorkerId?: string }) {
  const t = useTranslations("labour");
  const tTrades = useTranslations("trades");
  const tSkill = useTranslations("skills");
  const [view, setView] = useState<View>("all");
  const [query, setQuery] = useState("");
  const [trade, setTrade] = useState<TradeKey | "all">("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | undefined>(initialWorkerId);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return labourers.filter(
      (l) =>
        inView(l, view) &&
        (trade === "all" || l.trade === trade) &&
        (!q || l.name.toLowerCase().includes(q) || l.workerNo.toLowerCase().includes(q)),
    );
  }, [view, query, trade]);

  const counts = Object.fromEntries(
    views.map((v) => [v, labourers.filter((l) => inView(l, v)).length]),
  ) as Record<View, number>;
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const open = labourers.find((l) => l.id === openId);
  const tradeOptions = Array.from(new Set(labourers.map((l) => l.trade)));

  return (
    <div className="space-y-3">
      <Tabs value={view} onValueChange={(v) => setView(v as View)}>
        <TabsList className="h-auto flex-wrap justify-start">
          {views.map((v) => (
            <TabsTrigger key={v} value={v} className="gap-1.5">
              {t(`views.${v}`)}
              <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums">
                {counts[v]}
              </span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search
            className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("search")}
            aria-label={t("search")}
            className="pl-8"
          />
        </div>
        <Select value={trade} onValueChange={(v) => setTrade(v as TradeKey | "all")}>
          <SelectTrigger className="w-48" aria-label={t("cols.trade")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("allTrades")}</SelectItem>
            {tradeOptions.map((tr) => (
              <SelectItem key={tr} value={tr}>
                {tTrades(tr)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {selected.size > 0 ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-accent px-3 py-1.5 text-sm text-accent-foreground">
            <span className="font-medium">{t("selected", { count: selected.size })}</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => toast.info(t("bulkToast", { deliverable: "D3.1" }))}
            >
              <Users aria-hidden /> {t("bulk.assignGang")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => toast.info(t("bulkToast", { deliverable: "D7.3" }))}
            >
              <MessageSquareText aria-hidden /> {t("bulk.sms")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              {t("bulk.clear")}
            </Button>
          </div>
        ) : null}
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead className="w-10">
                <Checkbox
                  checked={allSelected}
                  aria-label={t("selectAll")}
                  onCheckedChange={(checked) =>
                    setSelected(checked ? new Set(rows.map((r) => r.id)) : new Set())
                  }
                />
              </TableHead>
              <TableHead>{t("cols.worker")}</TableHead>
              <TableHead>{t("cols.trade")}</TableHead>
              <TableHead>{t("cols.gang")}</TableHead>
              <TableHead className="text-right">{t("cols.rate")}</TableHead>
              <TableHead>{t("cols.phone")}</TableHead>
              <TableHead>{t("cols.today")}</TableHead>
              <TableHead>{t("cols.flags")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((l) => {
              const today = muster.find((m) => m.labourerId === l.id);
              const expiring = isAccreditationExpiringSoon(l, NOW);
              const nearThreshold =
                l.engagement === "casual" && l.continuousDays >= CASUAL_CONVERSION_WARNING_DAYS;
              return (
                <TableRow key={l.id} data-state={selected.has(l.id) ? "selected" : undefined}>
                  <TableCell>
                    <Checkbox
                      checked={selected.has(l.id)}
                      aria-label={t("selectWorker", { name: l.name })}
                      onCheckedChange={(checked) =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (checked) next.add(l.id);
                          else next.delete(l.id);
                          return next;
                        })
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <button
                      type="button"
                      className="flex items-center gap-2 text-left"
                      onClick={() => setOpenId(l.id)}
                    >
                      <Avatar className="size-8">
                        <AvatarFallback className="text-xs">{initials(l.name)}</AvatarFallback>
                      </Avatar>
                      <span>
                        <span className="block font-medium hover:underline">{l.name}</span>
                        <span className="block text-xs text-muted-foreground">{l.workerNo}</span>
                      </span>
                    </button>
                  </TableCell>
                  <TableCell>
                    <span className="block text-sm">{tTrades(l.trade)}</span>
                    <span className="block text-xs text-muted-foreground">{tSkill(l.skill)}</span>
                  </TableCell>
                  <TableCell className="text-sm">{l.gang}</TableCell>
                  <TableCell className="text-right text-sm tabular-nums">
                    {formatKES(l.dailyRateMinor)}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{maskPhone(l.phone)}</TableCell>
                  <TableCell>
                    {today?.status === "absent" ? (
                      <StatusBadge tone="neutral">{t("status.absent")}</StatusBadge>
                    ) : today?.flags.length ? (
                      <StatusBadge tone="warning">{t("status.flagged")}</StatusBadge>
                    ) : (
                      <StatusBadge tone="success">{t("status.onSite")}</StatusBadge>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {expiring ? (
                        <StatusBadge tone="warning">{t("flags.expiring")}</StatusBadge>
                      ) : null}
                      {l.biometricConsent === "declined" ? (
                        <StatusBadge tone="info">{t("flags.qrOnly")}</StatusBadge>
                      ) : null}
                      {nearThreshold ? (
                        <StatusBadge tone="warning">{t("flags.threshold")}</StatusBadge>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                  {t("empty")}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>

      <Sheet open={!!open} onOpenChange={(value) => !value && setOpenId(undefined)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-md">
          {open ? <WorkerDetail worker={open} /> : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function WorkerDetail({ worker }: { worker: Labourer }) {
  const t = useTranslations("labour.detail");
  const tTrades = useTranslations("trades");
  const tSkill = useTranslations("skills");
  const [revealed, setRevealed] = useState(false);
  const line = payrollLines.find((p) => p.labourer.id === worker.id);
  const nearThreshold =
    worker.engagement === "casual" && worker.continuousDays >= CASUAL_CONVERSION_WARNING_DAYS;

  return (
    <>
      <SheetHeader>
        <div className="flex items-center gap-3">
          <Avatar className="size-12">
            <AvatarFallback>{initials(worker.name)}</AvatarFallback>
          </Avatar>
          <div>
            <SheetTitle>{worker.name}</SheetTitle>
            <SheetDescription>
              {worker.workerNo} · {tTrades(worker.trade)} · {tSkill(worker.skill)}
            </SheetDescription>
          </div>
        </div>
      </SheetHeader>
      <div className="space-y-6 px-4 pb-6 text-sm">
        <section className="space-y-2">
          <h3 className="font-semibold">{t("identity")}</h3>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
            <dt className="text-muted-foreground">{t("idNumber")}</dt>
            <dd className="flex items-center gap-2 font-mono">
              {revealed ? worker.idNumber : maskId(worker.idNumber)}
              {!revealed ? (
                <Button
                  size="xs"
                  variant="outline"
                  className="font-sans"
                  onClick={() => {
                    setRevealed(true);
                    toast.info(t("revealToast"));
                  }}
                >
                  <Eye aria-hidden /> {t("reveal")}
                </Button>
              ) : null}
            </dd>
            <dt className="text-muted-foreground">{t("phone")}</dt>
            <dd className="font-mono">{revealed ? worker.phone : maskPhone(worker.phone)}</dd>
            <dt className="text-muted-foreground">{t("dob")}</dt>
            <dd className="tabular-nums">{formatDate(worker.dob)}</dd>
            <dt className="text-muted-foreground">{t("county")}</dt>
            <dd>{worker.homeCounty}</dd>
          </dl>
        </section>
        <Separator />
        <section className="space-y-2">
          <h3 className="font-semibold">{t("engagement")}</h3>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
            <dt className="text-muted-foreground">{t("type")}</dt>
            <dd>{t(`engagementTypes.${worker.engagement}`)}</dd>
            <dt className="text-muted-foreground">{t("rate")}</dt>
            <dd className="tabular-nums">{formatKES(worker.dailyRateMinor)}</dd>
            <dt className="text-muted-foreground">{t("gang")}</dt>
            <dd>{gangs[worker.gang].name}</dd>
            <dt className="text-muted-foreground">{t("joined")}</dt>
            <dd className="tabular-nums">{formatDate(worker.joined)}</dd>
          </dl>
          {nearThreshold ? (
            <p className="flex items-start gap-2 rounded-md bg-warning/10 p-2 text-xs">
              <TriangleAlert
                className="mt-0.5 size-4 shrink-0 text-warning-foreground dark:text-warning"
                aria-hidden
              />
              {t("thresholdWarning", { days: worker.continuousDays })}
            </p>
          ) : null}
        </section>
        <Separator />
        {line ? (
          <section className="space-y-2">
            <h3 className="font-semibold">{t("ledger")}</h3>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
              <dt className="text-muted-foreground">{t("days")}</dt>
              <dd className="tabular-nums">{line.days}</dd>
              <dt className="text-muted-foreground">{t("gross")}</dt>
              <dd className="tabular-nums">{formatKES(line.grossMinor)}</dd>
              <dt className="text-muted-foreground">{t("advances")}</dt>
              <dd className="tabular-nums">{formatKES(line.advanceMinor)}</dd>
              <dt className="text-muted-foreground">{t("net")}</dt>
              <dd className="font-medium tabular-nums">{formatKES(line.netMinor)}</dd>
            </dl>
          </section>
        ) : null}
        <Separator />
        <section className="space-y-2">
          <h3 className="font-semibold">{t("compliance")}</h3>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
            <dt className="text-muted-foreground">{t("accreditation")}</dt>
            <dd className="tabular-nums">
              {worker.accreditationExpiry
                ? formatDate(worker.accreditationExpiry)
                : t("notApplicable")}
            </dd>
            <dt className="text-muted-foreground">{t("consent")}</dt>
            <dd>
              {worker.biometricConsent === "granted" ? (
                <StatusBadge tone="success">{t("consentGranted")}</StatusBadge>
              ) : (
                <StatusBadge tone="info">{t("consentDeclined")}</StatusBadge>
              )}
            </dd>
          </dl>
          <p className="text-xs text-muted-foreground">{t("consentNote")}</p>
        </section>
        <Separator />
        <section className="space-y-3 rounded-lg border border-dashed p-3">
          <h3 className="flex items-center gap-2 font-semibold">
            <Lock className="size-4" aria-hidden /> {t("managersOnly")}
          </h3>
          <div className="flex items-center justify-between gap-3">
            <label htmlFor="dnr">{t("doNotRehire")}</label>
            <Switch id="dnr" onCheckedChange={() => toast.info(t("dnrToast"))} />
          </div>
          <p className="text-xs text-muted-foreground">{t("dnrNote")}</p>
        </section>
      </div>
    </>
  );
}
