"use client";

import { useTranslations } from "next-intl";
import type { BqIssueCode, BqUnit } from "@pm-buddy/types";
import type { BqIssueWire } from "@pm-buddy/validation";
import { decimalKesToMinor, formatDecimalString, formatKES } from "@/lib/format";

/** Unit display: a translated label for normalised units, the original spelling otherwise. */
export function useUnitLabel() {
  const t = useTranslations("liveBq.units");
  return (unit: BqUnit | null, raw: string | null): string => {
    if (!unit) return "";
    if (unit === "other") return raw ?? "";
    return t(unit);
  };
}

const money = (value: string | undefined) => {
  if (value === undefined) return "";
  const minor = decimalKesToMinor(value);
  return minor === null ? value : formatKES(minor);
};

/** EN/SW title and explanation for a validation finding, with amounts formatted as KES. */
export function useIssueText() {
  const titles = useTranslations("bqIssues.titles");
  const details = useTranslations("bqIssues.details");
  const fields = useTranslations("bqWizard.columns.fields");
  return {
    title: (code: BqIssueCode) => titles(code),
    detail: (issue: BqIssueWire): string => {
      const values = issue.values;
      const field = values["field"];
      return details(issue.code, {
        sheet: money(values["sheet"]),
        computed: money(values["computed"]),
        expected: money(values["expected"]),
        contractSum: money(values["contractSum"]),
        base: money(values["base"]),
        quantity: values["quantity"] ? formatDecimalString(values["quantity"]) : "",
        rate: values["rate"] ?? "",
        sheetRate: values["sheetRate"] ?? "—",
        percent: values["percent"] ?? "",
        value: values["value"] ?? "",
        unit: values["unit"] ?? "",
        text: values["text"] === "out_of_range" ? "—" : (values["text"] ?? ""),
        count: values["count"] ?? "",
        field: field === "quantity" || field === "rate" || field === "amount" ? fields(field) : "",
      });
    },
  };
}
