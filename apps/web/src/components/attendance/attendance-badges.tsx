import { useTranslations } from "next-intl";
import { ANOMALY_SEVERITY } from "@pm-buddy/types";
import type { Anomaly, AttendanceRecord, Correction, TimesheetPeriod } from "@pm-buddy/validation";
import { StatusBadge, severityTone, type Tone } from "@/components/status-badge";

type DayStatus = "draft" | "submitted" | "confirmed";

const attendanceTone: Record<AttendanceRecord["status"], Tone> = {
  present: "success",
  half_day: "info",
  absent: "neutral",
  leave: "neutral",
  sick: "neutral",
};
const dayTone: Record<DayStatus, Tone> = {
  draft: "neutral",
  submitted: "warning",
  confirmed: "success",
};
const periodTone: Record<TimesheetPeriod["status"], Tone> = {
  open: "neutral",
  submitted: "warning",
  rejected: "danger",
  approved: "success",
};
const decisionTone: Record<Correction["status"], Tone> = {
  pending: "warning",
  approved: "success",
  rejected: "neutral",
};
const anomalyStatusTone: Record<Anomaly["status"], Tone> = {
  open: "warning",
  resolved: "success",
  dismissed: "neutral",
  cleared: "neutral",
};

export function AttendanceStatusBadge({ status }: { status: AttendanceRecord["status"] }) {
  const t = useTranslations("attendanceLive.status");
  return <StatusBadge tone={attendanceTone[status]}>{t(status)}</StatusBadge>;
}

/** A muster day's status; `null` means nothing was recorded yet. */
export function DayStatusBadge({ status }: { status: DayStatus | null }) {
  const t = useTranslations("attendanceLive.dayStatus");
  return (
    <StatusBadge tone={status ? dayTone[status] : "neutral"}>{t(status ?? "none")}</StatusBadge>
  );
}

export function PeriodStatusBadge({ status }: { status: TimesheetPeriod["status"] }) {
  const t = useTranslations("attendanceLive.periodStatus");
  return <StatusBadge tone={periodTone[status]}>{t(status)}</StatusBadge>;
}

export function DecisionBadge({ status }: { status: Correction["status"] }) {
  const t = useTranslations("attendanceLive.decision");
  return <StatusBadge tone={decisionTone[status]}>{t(status)}</StatusBadge>;
}

/** An anomaly flag: severity colour, kind text; closed flags are muted. */
export function AnomalyBadge({ kind, status }: Pick<Anomaly, "kind" | "status">) {
  const t = useTranslations("attendanceLive.anomalyKind");
  const tone = status === "open" ? severityTone[ANOMALY_SEVERITY[kind]] : "neutral";
  return <StatusBadge tone={tone}>{t(kind)}</StatusBadge>;
}

export function AnomalyStatusBadge({ status }: { status: Anomaly["status"] }) {
  const t = useTranslations("attendanceLive.anomalyStatus");
  return <StatusBadge tone={anomalyStatusTone[status]}>{t(status)}</StatusBadge>;
}
