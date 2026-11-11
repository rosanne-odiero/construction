"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleCheck,
  FileSpreadsheet,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusBadge } from "@/components/status-badge";
import { formatKES } from "@/lib/format";
import { cn } from "@/lib/utils";
import { billTotalMinor, importPreviewColumns, importPreviewRows, ruiruBills } from "@/mocks/bq";

const fields = ["itemRef", "description", "unit", "quantity", "rate", "amount", "ignore"] as const;
type FieldKey = (typeof fields)[number];
const detectedMapping: FieldKey[] = [
  "itemRef",
  "description",
  "unit",
  "quantity",
  "rate",
  "amount",
];
const steps = ["upload", "sheet", "map", "hierarchy", "validate"] as const;
const rules = ["bill", "section", "collection", "lumpSum"] as const;

function rowRole(row: string[]): "bill" | "section" | "collection" | "item" {
  if (row[1].startsWith("BILL NO.")) return "bill";
  if (row[1].toLowerCase().includes("collection")) return "collection";
  if (!row[3] && row[1] === row[1].toUpperCase()) return "section";
  return "item";
}

const TYPO_DIFF_MINOR = 27_000_00;

export function ImportWizard({ projectId }: { projectId: string }) {
  const t = useTranslations("bqImport");
  const [step, setStep] = useState(0);
  const [mapping, setMapping] = useState<FieldKey[]>(detectedMapping);
  const [resolution, setResolution] = useState("computed");

  const billRows = ruiruBills.map((bill) => {
    const computed = billTotalMinor(bill);
    const sheet = bill.number === 2 ? computed - TYPO_DIFF_MINOR : computed;
    return { bill, computed, sheet };
  });
  const computedTotal = billRows.reduce((a, r) => a + r.computed, 0);
  const sheetTotal = billRows.reduce((a, r) => a + r.sheet, 0);

  return (
    <div className="space-y-6">
      <ol className="grid gap-2 sm:grid-cols-5" aria-label={t("stepsLabel")}>
        {steps.map((key, idx) => (
          <li key={key}>
            <button
              type="button"
              onClick={() => setStep(idx)}
              aria-current={idx === step ? "step" : undefined}
              className={cn(
                "flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                idx === step && "border-primary bg-accent text-accent-foreground",
                idx < step && "text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                  idx < step && "border-success bg-success text-white",
                  idx === step && "border-primary bg-primary text-primary-foreground",
                )}
              >
                {idx < step ? <Check className="size-3.5" aria-hidden /> : idx + 1}
              </span>
              <span className="truncate">{t(`steps.${key}`)}</span>
            </button>
          </li>
        ))}
      </ol>

      <Card>
        <CardHeader>
          <CardTitle>{t(`steps.${steps[step]}`)}</CardTitle>
          <CardDescription>{t(`help.${steps[step]}`)}</CardDescription>
        </CardHeader>
        <CardContent>
          {step === 0 ? (
            <div className="space-y-4">
              <div className="flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-10 text-center">
                <FileSpreadsheet className="size-10 text-primary" aria-hidden />
                <p className="font-medium">Ruiru_Heights_BQ_Final_v2.xlsx</p>
                <p className="text-sm text-muted-foreground">
                  684 KB · {t("uploadedBy", { name: "Faith Achieng" })}
                </p>
                <StatusBadge tone="success" icon={<ShieldCheck className="size-3" aria-hidden />}>
                  {t("scanned")}
                </StatusBadge>
              </div>
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                <li>{t("rules.xlsxOnly")}</li>
                <li>{t("rules.private")}</li>
              </ul>
            </div>
          ) : null}

          {step === 1 ? (
            <div className="grid gap-6 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="sheet">{t("sheet")}</Label>
                <Select defaultValue="all">
                  <SelectTrigger id="sheet" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("allBillSheets", { count: 9 })}</SelectItem>
                    <SelectItem value="summary">SUMMARY</SelectItem>
                    <SelectItem value="b2">BILL 2</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-sm text-muted-foreground">{t("headerDetected", { row: 7 })}</p>
              </div>
              <div className="space-y-3 rounded-lg border p-4">
                <div className="flex items-center justify-between gap-4">
                  <Label htmlFor="template">{t("useTemplate")}</Label>
                  <Switch id="template" defaultChecked />
                </div>
                <p className="text-sm text-muted-foreground">{t("templateName")}</p>
              </div>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="space-y-6">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {importPreviewColumns.map((col, idx) => (
                  <div key={col} className="space-y-1.5 rounded-lg border p-3">
                    <Label htmlFor={`col-${idx}`} className="font-mono text-xs">
                      {t("column", { letter: String.fromCharCode(65 + idx) })} · {col}
                    </Label>
                    <Select
                      value={mapping[idx]}
                      onValueChange={(value) =>
                        setMapping((prev) =>
                          prev.map((m, i) => (i === idx ? (value as FieldKey) : m)),
                        )
                      }
                    >
                      <SelectTrigger id={`col-${idx}`} className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {fields.map((f) => (
                          <SelectItem key={f} value={f}>
                            {t(`fields.${f}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/50">
                      <TableHead className="w-28">{t("detected")}</TableHead>
                      {importPreviewColumns.map((col, idx) => (
                        <TableHead key={col} className={idx >= 3 ? "text-right" : undefined}>
                          {t(`fields.${mapping[idx]}`)}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {importPreviewRows.map((row, rIdx) => {
                      const role = rowRole(row);
                      const typo = rIdx === 8;
                      return (
                        <TableRow key={rIdx} className={cn(typo && "bg-warning/10")}>
                          <TableCell>
                            <StatusBadge
                              tone={
                                role === "item"
                                  ? "neutral"
                                  : role === "collection"
                                    ? "info"
                                    : "success"
                              }
                            >
                              {t(`roles.${role}`)}
                            </StatusBadge>
                          </TableCell>
                          {row.map((cell, cIdx) => (
                            <TableCell
                              key={cIdx}
                              className={cn(
                                "text-sm",
                                cIdx >= 3 && "text-right tabular-nums",
                                cIdx === 1 && "max-w-sm whitespace-normal",
                                role !== "item" && "font-semibold",
                              )}
                            >
                              {cell}
                            </TableCell>
                          ))}
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </div>
          ) : null}

          {step === 3 ? (
            <div className="grid gap-6 lg:grid-cols-2">
              <ul className="space-y-3">
                {rules.map((rule) => (
                  <li
                    key={rule}
                    className="flex items-start justify-between gap-4 rounded-lg border p-3"
                  >
                    <Label htmlFor={`rule-${rule}`} className="leading-snug font-normal">
                      {t(`hierarchy.${rule}`)}
                    </Label>
                    <Switch id={`rule-${rule}`} defaultChecked />
                  </li>
                ))}
              </ul>
              <div className="rounded-lg border bg-muted/40 p-4">
                <p className="mb-3 text-sm font-medium">{t("treePreview")}</p>
                <dl className="grid grid-cols-3 gap-3 text-center">
                  {[
                    { label: t("counts.bills"), value: ruiruBills.length },
                    {
                      label: t("counts.sections"),
                      value: ruiruBills.reduce((a, b) => a + b.sections.length, 0),
                    },
                    {
                      label: t("counts.items"),
                      value: ruiruBills.reduce(
                        (a, b) => a + b.sections.reduce((x, s) => x + s.items.length, 0),
                        0,
                      ),
                    },
                  ].map((c) => (
                    <div key={c.label} className="rounded-md bg-background p-3">
                      <dd className="text-2xl font-semibold tabular-nums">{c.value}</dd>
                      <dt className="text-xs text-muted-foreground">{c.label}</dt>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
          ) : null}

          {step === 4 ? (
            <div className="space-y-6">
              <div className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm">
                <TriangleAlert
                  className="mt-0.5 size-5 shrink-0 text-warning-foreground dark:text-warning"
                  aria-hidden
                />
                <div className="space-y-3">
                  <p className="font-medium">{t("mismatchTitle")}</p>
                  <p>
                    {t("mismatchDetail", {
                      sheet: formatKES(947_400_00),
                      computed: formatKES(974_400_00),
                    })}
                  </p>
                  <RadioGroup value={resolution} onValueChange={setResolution} className="gap-2">
                    {(["computed", "sheet", "flag"] as const).map((opt) => (
                      <div key={opt} className="flex items-center gap-2">
                        <RadioGroupItem
                          value={opt}
                          id={`res-${opt}`}
                          className="border-muted-foreground/60 bg-background"
                        />
                        <Label htmlFor={`res-${opt}`} className="font-normal">
                          {t(`resolution.${opt}`)}
                        </Label>
                      </div>
                    ))}
                  </RadioGroup>
                </div>
              </div>
              <div className="overflow-hidden rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/50">
                      <TableHead>{t("billCol")}</TableHead>
                      <TableHead className="text-right">{t("sheetTotal")}</TableHead>
                      <TableHead className="text-right">{t("computedTotal")}</TableHead>
                      <TableHead>{t("result")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {billRows.map(({ bill, computed, sheet }) => (
                      <TableRow key={bill.number}>
                        <TableCell>
                          {bill.number}. {bill.title}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatKES(sheet)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatKES(computed)}
                        </TableCell>
                        <TableCell>
                          {sheet === computed ? (
                            <StatusBadge
                              tone="success"
                              icon={<CircleCheck className="size-3" aria-hidden />}
                            >
                              {t("match")}
                            </StatusBadge>
                          ) : (
                            <StatusBadge tone="warning">
                              {t("diff", { amount: formatKES(computed - sheet) })}
                            </StatusBadge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                    <TableRow className="bg-accent/50 font-semibold">
                      <TableCell>{t("grandTotal")}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatKES(sheetTotal)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatKES(computedTotal)}
                      </TableCell>
                      <TableCell>
                        <StatusBadge tone={resolution === "flag" ? "warning" : "success"}>
                          {resolution === "flag" ? t("pendingQs") : t("reconciled")}
                        </StatusBadge>
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            </div>
          ) : null}
        </CardContent>
        <CardFooter className="justify-between gap-2">
          {step === 0 ? (
            <Button asChild variant="ghost">
              <Link href={`/prototype/projects/${projectId}/bq`}>
                <ArrowLeft aria-hidden /> {t("cancel")}
              </Link>
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => setStep((s) => s - 1)}>
              <ArrowLeft aria-hidden /> {t("back")}
            </Button>
          )}
          {step < steps.length - 1 ? (
            <Button onClick={() => setStep((s) => s + 1)}>
              {t("next")} <ArrowRight aria-hidden />
            </Button>
          ) : (
            <Button onClick={() => toast.success(t("importedToast", { version: 4 }))}>
              <Check aria-hidden /> {t("importDraft", { version: 4 })}
            </Button>
          )}
        </CardFooter>
      </Card>
    </div>
  );
}
