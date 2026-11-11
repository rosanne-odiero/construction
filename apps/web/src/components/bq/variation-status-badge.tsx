import { useTranslations } from "next-intl";
import type { VariationStatus } from "@pm-buddy/types";
import { StatusBadge, type Tone } from "@/components/status-badge";

const TONES: Record<VariationStatus, Tone> = {
  draft: "neutral",
  submitted: "info",
  approved: "success",
  rejected: "danger",
  cancelled: "neutral",
};

export function VariationStatusBadge({ status }: { status: VariationStatus }) {
  const t = useTranslations("variations.status");
  return <StatusBadge tone={TONES[status]}>{t(status)}</StatusBadge>;
}
