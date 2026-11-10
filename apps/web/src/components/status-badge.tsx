import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type Tone = "success" | "warning" | "danger" | "info" | "neutral";

const toneClasses: Record<Tone, string> = {
  success: "border-success/30 bg-success/10 text-success dark:bg-success/15",
  warning: "border-warning/40 bg-warning/15 text-warning-foreground dark:text-warning",
  danger: "border-destructive/30 bg-destructive/10 text-destructive",
  info: "border-info/30 bg-info/10 text-info",
  neutral: "border-border bg-muted text-muted-foreground",
};

export function StatusBadge({
  tone,
  children,
  className,
  icon,
}: {
  tone: Tone;
  children: React.ReactNode;
  className?: string;
  icon?: React.ReactNode;
}) {
  return (
    <Badge variant="outline" className={cn("gap-1 font-medium", toneClasses[tone], className)}>
      {icon}
      {children}
    </Badge>
  );
}

export const severityTone = {
  critical: "danger",
  warning: "warning",
  info: "info",
} as const satisfies Record<string, Tone>;
