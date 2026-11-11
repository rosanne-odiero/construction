"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  Check,
  ClockAlert,
  MapPinOff,
  QrCode,
  Route,
  ScanFace,
  ShieldAlert,
  UserCog,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge, severityTone } from "@/components/status-badge";
import { formatTime } from "@/lib/format";
import {
  anomalies as initialAnomalies,
  muster,
  type Anomaly,
  type AnomalyKind,
  type CaptureMethod,
} from "@/mocks/attendance";
import { gangs, labourerById, type GangKey } from "@/mocks/labour";

const methodIcon: Record<CaptureMethod, React.ReactNode> = {
  face_kiosk: <ScanFace className="size-3.5" aria-hidden />,
  qr_card_photo: <QrCode className="size-3.5" aria-hidden />,
  manual_override: <UserCog className="size-3.5" aria-hidden />,
};
const anomalyIcon: Record<AnomalyKind, React.ReactNode> = {
  impossible_travel: <Route className="size-4" aria-hidden />,
  outside_geofence: <MapPinOff className="size-4" aria-hidden />,
  clock_drift: <ClockAlert className="size-4" aria-hidden />,
  manual_override: <UserCog className="size-4" aria-hidden />,
  duplicate: <ShieldAlert className="size-4" aria-hidden />,
  low_confidence: <ScanFace className="size-4" aria-hidden />,
};

export function AttendanceView() {
  const t = useTranslations("attendance");
  const tTrades = useTranslations("trades");
  const [gang, setGang] = useState<GangKey | "all">("all");
  const [items, setItems] =
    useState<(Anomaly & { decision?: "accepted" | "rejected" })[]>(initialAnomalies);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const open = items.filter((a) => a.status === "open" && !a.decision).length;

  const rows = muster.filter((m) => gang === "all" || labourerById(m.labourerId)?.gang === gang);

  const decide = (id: string, decision: "accepted" | "rejected") => {
    if (decision === "rejected" && !notes[id]?.trim()) {
      toast.error(t("noteRequired"));
      return;
    }
    setItems((prev) => prev.map((a) => (a.id === id ? { ...a, decision } : a)));
    toast.success(t(decision === "accepted" ? "acceptedToast" : "rejectedToast"));
  };

  return (
    <Tabs defaultValue="muster" className="gap-4">
      <TabsList>
        <TabsTrigger value="muster">{t("tabs.muster")}</TabsTrigger>
        <TabsTrigger value="anomalies" className="gap-1.5">
          {t("tabs.anomalies")}
          {open > 0 ? (
            <span className="rounded-full bg-destructive px-1.5 text-[10px] font-semibold text-white tabular-nums">
              {open}
            </span>
          ) : null}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="muster" className="space-y-3">
        <Select value={gang} onValueChange={(v) => setGang(v as GangKey | "all")}>
          <SelectTrigger className="w-64" aria-label={t("gangFilter")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("allGangs")}</SelectItem>
            {(Object.keys(gangs) as GangKey[]).map((g) => (
              <SelectItem key={g} value={g}>
                {gangs[g].name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead>{t("cols.worker")}</TableHead>
                <TableHead>{t("cols.in")}</TableHead>
                <TableHead>{t("cols.out")}</TableHead>
                <TableHead>{t("cols.method")}</TableHead>
                <TableHead className="text-right">{t("cols.confidence")}</TableHead>
                <TableHead>{t("cols.geofence")}</TableHead>
                <TableHead>{t("cols.device")}</TableHead>
                <TableHead>{t("cols.flags")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((m) => {
                const l = labourerById(m.labourerId);
                if (!l) return null;
                return (
                  <TableRow
                    key={m.labourerId}
                    className={m.status === "absent" ? "text-muted-foreground" : undefined}
                  >
                    <TableCell>
                      <span className="block font-medium">{l.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {tTrades(l.trade)} · {t("gang", { gang: l.gang })}
                      </span>
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {m.checkIn ? (
                        <span
                          className={
                            m.status === "late"
                              ? "font-medium text-warning-foreground dark:text-warning"
                              : undefined
                          }
                        >
                          {formatTime(m.checkIn)}
                          {m.nightShift ? (
                            <span className="ml-1 text-xs text-muted-foreground">
                              ({t("nightShift")})
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        <StatusBadge tone="neutral">{t("absent")}</StatusBadge>
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {m.checkOut ? formatTime(m.checkOut) : "–"}
                    </TableCell>
                    <TableCell>
                      {m.method ? (
                        <span className="inline-flex items-center gap-1.5 text-sm">
                          {methodIcon[m.method]} {t(`methods.${m.method}`)}
                        </span>
                      ) : (
                        "–"
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {m.confidence !== undefined ? (
                        <span className={m.confidence < 0.8 ? "text-destructive" : undefined}>
                          {m.confidence.toFixed(2)}
                        </span>
                      ) : (
                        "–"
                      )}
                    </TableCell>
                    <TableCell>
                      {m.insideGeofence === undefined ? (
                        "–"
                      ) : m.insideGeofence ? (
                        <StatusBadge tone="success">{t("inside")}</StatusBadge>
                      ) : (
                        <StatusBadge tone="danger">
                          {t("outside", { distance: m.distanceM ?? 0 })}
                        </StatusBadge>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{m.device ?? "–"}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {m.flags.map((f) => (
                          <StatusBadge
                            key={f}
                            tone={
                              f === "impossible_travel"
                                ? "danger"
                                : f === "duplicate" || f === "low_confidence"
                                  ? "info"
                                  : "warning"
                            }
                          >
                            {t(`kinds.${f}`)}
                          </StatusBadge>
                        ))}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </TabsContent>

      <TabsContent value="anomalies" className="space-y-3">
        {items.map((a) => {
          const l = a.labourerId ? labourerById(a.labourerId) : undefined;
          return (
            <Card key={a.id} className={a.decision ? "opacity-60" : undefined}>
              <CardContent className="flex flex-col gap-4 lg:flex-row lg:items-start">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
                  {anomalyIcon[a.kind]}
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge tone={severityTone[a.severity]}>
                      {t(`severity.${a.severity}`)}
                    </StatusBadge>
                    <span className="font-medium">{t(`kinds.${a.kind}`)}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {formatTime(a.at)}
                    </span>
                    {a.status === "auto_resolved" ? (
                      <StatusBadge tone="neutral">{t("autoResolved")}</StatusBadge>
                    ) : null}
                    {a.decision ? (
                      <StatusBadge tone={a.decision === "accepted" ? "success" : "danger"}>
                        {t(`decisions.${a.decision}`)}
                      </StatusBadge>
                    ) : null}
                  </div>
                  {l ? <p className="text-sm font-medium">{l.name}</p> : null}
                  <p className="text-sm text-muted-foreground">
                    {t(`details.${a.kind}`, a.params)}
                  </p>
                </div>
                {a.status === "open" && !a.decision ? (
                  <div className="flex w-full flex-col gap-2 lg:w-72">
                    <Textarea
                      placeholder={t("notePlaceholder")}
                      aria-label={t("notePlaceholder")}
                      className="min-h-16"
                      value={notes[a.id] ?? ""}
                      onChange={(e) => setNotes((prev) => ({ ...prev, [a.id]: e.target.value }))}
                    />
                    <div className="flex gap-2">
                      <Button size="sm" className="flex-1" onClick={() => decide(a.id, "accepted")}>
                        <Check aria-hidden /> {t("accept")}
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        className="flex-1"
                        onClick={() => decide(a.id, "rejected")}
                      >
                        <X aria-hidden /> {t("reject")}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </TabsContent>
    </Tabs>
  );
}
