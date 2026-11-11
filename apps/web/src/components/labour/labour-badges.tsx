import { useTranslations } from "next-intl";
import { CircleAlert, ShieldAlert } from "lucide-react";
import type { LabourerSummary } from "@pm-buddy/validation";
import { StatusBadge, type Tone } from "@/components/status-badge";
import { formatCalendarDate } from "@/lib/format";
import { accreditationTone, consentTone } from "@/lib/labour";

const statusTone: Record<LabourerSummary["status"], Tone> = {
  active: "success",
  inactive: "neutral",
  left: "neutral",
};

export function LabourerStatusBadge({ status }: { status: LabourerSummary["status"] }) {
  const t = useTranslations("labourLive.status");
  return <StatusBadge tone={statusTone[status]}>{t(status)}</StatusBadge>;
}

/** NCA accreditation: valid / expiring / expired / missing, with the expiry date when known. */
export function AccreditationBadge({
  accreditation,
}: {
  accreditation: LabourerSummary["accreditation"];
}) {
  const t = useTranslations("labourLive.accreditation");
  if (accreditation.status === "not_required")
    return <span className="text-xs text-muted-foreground">{t("not_required")}</span>;
  return (
    <span className="flex flex-col items-start gap-0.5">
      <StatusBadge tone={accreditationTone[accreditation.status]}>
        {t(accreditation.status)}
      </StatusBadge>
      {accreditation.expiresOn ? (
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatCalendarDate(accreditation.expiresOn)}
        </span>
      ) : null}
    </span>
  );
}

export function ConsentBadge({ consent }: { consent: LabourerSummary["consent"] }) {
  const t = useTranslations("labourLive.consentStatus");
  if (consent.status === "granted" && !consent.current)
    return <StatusBadge tone="warning">{t("outdated")}</StatusBadge>;
  return <StatusBadge tone={consentTone[consent.status]}>{t(consent.status)}</StatusBadge>;
}

export function DoNotRehireBadge() {
  const t = useTranslations("labourLive.flags");
  return (
    <StatusBadge tone="danger" icon={<ShieldAlert className="size-3" aria-hidden />}>
      {t("doNotRehire")}
    </StatusBadge>
  );
}

/** A localised configuration name (trades and skill levels carry EN and SW names). */
export function localName(
  entry: { nameEn: string; nameSw: string } | null,
  locale: string,
): string {
  if (!entry) return "—";
  return locale === "sw" ? entry.nameSw : entry.nameEn;
}

export function ComplianceNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
      <CircleAlert
        className="mt-0.5 size-4 shrink-0 text-warning-foreground dark:text-warning"
        aria-hidden
      />
      <span>{children}</span>
    </p>
  );
}
