import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Download, FileUp, GitCompare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { KpiCard } from "@/components/kpi-card";
import { PageHeader } from "@/components/page-header";
import { PrototypeAction } from "@/components/prototype-action";
import { StatusBadge, type Tone } from "@/components/status-badge";
import { formatDate, formatKES, formatPercent } from "@/lib/format";
import {
  approvedVariationsMinor,
  bqVersions,
  revisedContractSumMinor,
  ruiruBills,
  ruiruSummary,
  ruiruVariations,
  VAT_RATE,
  type VoStatus,
} from "@/mocks/bq";
import { getProject } from "@/mocks/projects";
import { BqTable } from "./bq-table";

export async function generateMetadata() {
  const t = await getTranslations("bq");
  return { title: t("title") };
}

const voTone: Record<VoStatus, Tone> = {
  approved: "success",
  awaiting_client: "warning",
  draft: "neutral",
};

export default async function BqPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const project = getProject(projectId);
  if (!project || project.id !== "ruiru-heights") notFound();

  const t = await getTranslations("bq");
  const s = ruiruSummary;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href={`/projects/${project.id}`} className="hover:underline">
            {project.name}
          </Link>
        }
        title={t("title")}
        description={t("description", { items: s.itemCount, version: bqVersions.length })}
        actions={
          <>
            <Button asChild>
              <Link href={`/projects/${project.id}/bq/import`}>
                <FileUp aria-hidden /> {t("import")}
              </Link>
            </Button>
            <PrototypeAction deliverable="D2.2">
              <Download aria-hidden /> {t("exportExcel")}
            </PrototypeAction>
            <PrototypeAction deliverable="D2.2">
              <Download aria-hidden /> {t("exportPdf")}
            </PrototypeAction>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label={t("kpi.original")}
          value={formatKES(s.contractSumMinor)}
          hint={t("kpi.originalHint")}
        />
        <KpiCard
          label={t("kpi.variations")}
          value={formatKES(Math.round(approvedVariationsMinor * (1 + VAT_RATE)))}
          hint={t("kpi.variationsHint", {
            count: ruiruVariations.filter((v) => v.status === "approved").length,
          })}
        />
        <KpiCard
          label={t("kpi.revised")}
          value={formatKES(revisedContractSumMinor)}
          hint={t("kpi.revisedHint")}
        />
        <KpiCard
          label={t("kpi.done")}
          value={formatKES(s.doneMinor)}
          hint={t("kpi.doneHint", { pct: formatPercent(s.progress) })}
          tone="success"
        />
      </div>

      <div className="grid gap-4 2xl:grid-cols-4">
        <div className="space-y-4 2xl:col-span-3">
          <BqTable bills={ruiruBills} />
          <Card>
            <CardHeader>
              <CardTitle>{t("summaryTitle")}</CardTitle>
              <CardDescription>{t("summaryDescription")}</CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              <Table>
                <TableBody>
                  <TableRow>
                    <TableCell className="pl-6">{t("summary.bills")}</TableCell>
                    <TableCell className="pr-6 text-right tabular-nums">
                      {formatKES(s.billsTotalMinor)}
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="pl-6">{t("summary.contingency")}</TableCell>
                    <TableCell className="pr-6 text-right tabular-nums">
                      {formatKES(s.contingencyMinor)}
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="pl-6 font-medium">{t("summary.subtotal")}</TableCell>
                    <TableCell className="pr-6 text-right font-medium tabular-nums">
                      {formatKES(s.subtotalMinor)}
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="pl-6">
                      {t("summary.vat", { rate: formatPercent(VAT_RATE) })}
                    </TableCell>
                    <TableCell className="pr-6 text-right tabular-nums">
                      {formatKES(s.vatMinor)}
                    </TableCell>
                  </TableRow>
                  <TableRow className="bg-accent/50">
                    <TableCell className="pl-6 font-semibold">{t("summary.contractSum")}</TableCell>
                    <TableCell className="pr-6 text-right font-semibold tabular-nums">
                      {formatKES(s.contractSumMinor)}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>{t("versionsTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="space-y-3">
                {[...bqVersions].reverse().map((v, idx) => (
                  <li key={v.version} className="flex items-start justify-between gap-2 text-sm">
                    <div>
                      <p className="font-medium">
                        v{v.version} · {v.label}
                      </p>
                      <p className="text-xs text-muted-foreground tabular-nums">
                        {formatDate(v.date)}
                      </p>
                    </div>
                    {idx === 0 ? <StatusBadge tone="info">{t("current")}</StatusBadge> : null}
                  </li>
                ))}
              </ol>
              <PrototypeAction deliverable="D2.3" size="sm" className="mt-4 w-full">
                <GitCompare aria-hidden /> {t("compare")}
              </PrototypeAction>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t("variationsTitle")}</CardTitle>
              <CardDescription>{t("variationsDescription")}</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-3">
                {ruiruVariations.map((vo) => (
                  <li key={vo.number} className="rounded-lg border p-3 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">
                        {vo.number}{" "}
                        <span className="text-muted-foreground">· {vo.instruction}</span>
                      </span>
                      <StatusBadge tone={voTone[vo.status]}>
                        {t(`voStatus.${vo.status}`)}
                      </StatusBadge>
                    </div>
                    <p className="mt-1 leading-snug">{vo.title}</p>
                    <p
                      className={`mt-1 font-medium tabular-nums ${vo.amountMinor < 0 ? "text-destructive" : ""}`}
                    >
                      {vo.amountMinor > 0 ? "+" : ""}
                      {formatKES(vo.amountMinor)}{" "}
                      <span className="text-xs font-normal text-muted-foreground">
                        {t("exVat")}
                      </span>
                    </p>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
