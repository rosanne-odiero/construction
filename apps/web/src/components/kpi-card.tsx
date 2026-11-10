import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function KpiCard({
  label,
  value,
  hint,
  icon,
  tone = "default",
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon?: React.ReactNode;
  tone?: "default" | "success" | "warning" | "danger";
  className?: string;
}) {
  return (
    <Card className={cn("gap-2", className)}>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
        {icon ? (
          <span className="flex size-8 items-center justify-center rounded-md bg-accent text-accent-foreground [&_svg]:size-4">
            {icon}
          </span>
        ) : null}
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
        {hint ? (
          <p
            className={cn(
              "mt-1 text-xs text-muted-foreground",
              tone === "success" && "text-success",
              tone === "warning" && "text-warning-foreground dark:text-warning",
              tone === "danger" && "text-destructive",
            )}
          >
            {hint}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
