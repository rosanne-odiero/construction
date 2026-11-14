import type { ComplianceStatus } from "@pm-buddy/types";
import { StatusBadge } from "@/components/status-badge";
import { complianceTone } from "@/lib/documents";

/** A compliance status as a badge; the text always names the status (colour is never alone). */
export function ComplianceStatusBadge({
  status,
  children,
}: {
  status: ComplianceStatus;
  children: React.ReactNode;
}) {
  return (
    <StatusBadge tone={complianceTone[status]} className="h-auto whitespace-normal">
      {children}
    </StatusBadge>
  );
}
