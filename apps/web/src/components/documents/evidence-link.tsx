import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { ComplianceRecord } from "@pm-buddy/validation";
import { StatusBadge } from "@/components/status-badge";
import { versionTone } from "@/lib/documents";

type Evidence = NonNullable<ComplianceRecord["evidence"]>;

/**
 * A compliance record's evidence: the document version with its state (current or superseded)
 * and a withdrawn document marked, so an old revision is never shown as if it were current (D-111).
 */
export async function EvidenceLink({ evidence }: { evidence: Evidence }) {
  const t = await getTranslations("documents");
  if (evidence.restricted)
    return <span className="text-muted-foreground">{t("common.restricted")}</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Link
        className="underline"
        href={`/projects/${evidence.projectId}/documents/${evidence.documentId}`}
      >
        {evidence.title} · {t("common.revision", { revision: evidence.revision })}
      </Link>
      <StatusBadge tone={versionTone[evidence.state]}>
        {t(`versionStates.${evidence.state}`)}
      </StatusBadge>
      {evidence.documentStatus === "withdrawn" ? (
        <StatusBadge tone="neutral">{t("documentStatuses.withdrawn")}</StatusBadge>
      ) : null}
    </span>
  );
}
