import { useTranslations } from "next-intl";
import type { ProjectStatus } from "@pm-buddy/types";
import { StatusBadge, type Tone } from "@/components/status-badge";

const tones: Record<ProjectStatus, Tone> = {
  planning: "info",
  active: "success",
  on_hold: "warning",
  completed: "neutral",
  closed: "neutral",
  cancelled: "danger",
};

export function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
  const t = useTranslations("projectStatus");
  return <StatusBadge tone={tones[status]}>{t(status)}</StatusBadge>;
}
