"use client";

import { Fragment, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatKES, formatNumber, formatPercent } from "@/lib/format";
import {
  billDoneMinor,
  billTotalMinor,
  itemAmountMinor,
  itemDoneMinor,
  sectionTotalMinor,
  type BqBill,
} from "@/mocks/bq";

export function BqTable({ bills }: { bills: BqBill[] }) {
  const t = useTranslations("bq");
  const [query, setQuery] = useState("");
  const [openBills, setOpenBills] = useState<Set<number>>(() => new Set([2, 3]));

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      bills
        .map((bill) => ({
          ...bill,
          sections: bill.sections
            .map((sec) => ({
              ...sec,
              items: sec.items.filter(
                (item) =>
                  !q ||
                  item.description.toLowerCase().includes(q) ||
                  item.ref.toLowerCase().includes(q),
              ),
            }))
            .filter((sec) => sec.items.length > 0),
        }))
        .filter((bill) => bill.sections.length > 0),
    [bills, q],
  );

  const toggle = (n: number) =>
    setOpenBills((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });

  const allOpen = openBills.size === bills.length;
  const grandTotal = bills.reduce((a, b) => a + billTotalMinor(b), 0);
  const grandDone = bills.reduce((a, b) => a + billDoneMinor(b), 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search
            className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("search")}
            aria-label={t("search")}
            className="pl-8"
          />
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOpenBills(allOpen ? new Set() : new Set(bills.map((b) => b.number)))}
        >
          {allOpen ? <ChevronsDownUp aria-hidden /> : <ChevronsUpDown aria-hidden />}
          {allOpen ? t("collapseAll") : t("expandAll")}
        </Button>
      </div>

      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead className="w-24">{t("cols.ref")}</TableHead>
              <TableHead>{t("cols.description")}</TableHead>
              <TableHead className="w-16">{t("cols.unit")}</TableHead>
              <TableHead className="w-24 text-right">{t("cols.qty")}</TableHead>
              <TableHead className="w-24 text-right">{t("cols.rate")}</TableHead>
              <TableHead className="w-36 text-right">{t("cols.amount")}</TableHead>
              <TableHead className="w-32">{t("cols.done")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((bill) => {
              const open = openBills.has(bill.number) || q.length > 0;
              return (
                <Fragment key={bill.number}>
                  <TableRow className="bg-accent/50 hover:bg-accent">
                    <TableCell colSpan={5} className="font-semibold">
                      <button
                        type="button"
                        className="flex items-center gap-1.5 text-left"
                        aria-expanded={open}
                        onClick={() => toggle(bill.number)}
                      >
                        {open ? (
                          <ChevronDown className="size-4" aria-hidden />
                        ) : (
                          <ChevronRight className="size-4" aria-hidden />
                        )}
                        {t("billLabel", { number: bill.number })}: {bill.title}
                        {bill.kind !== "measured" ? (
                          <span className="ml-1 rounded bg-background px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground uppercase">
                            {t(`kinds.${bill.kind}`)}
                          </span>
                        ) : null}
                      </button>
                    </TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">
                      {formatKES(billTotalMinor(bill))}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground tabular-nums">
                      {formatPercent(billDoneMinor(bill) / billTotalMinor(bill))}
                    </TableCell>
                  </TableRow>
                  {open
                    ? bill.sections.map((sec) => (
                        <Fragment key={sec.code}>
                          <TableRow className="hover:bg-transparent">
                            <TableCell className="pl-8 text-xs font-medium text-muted-foreground">
                              {sec.code}
                            </TableCell>
                            <TableCell
                              colSpan={4}
                              className="text-xs font-semibold tracking-wide uppercase"
                            >
                              {sec.title}
                            </TableCell>
                            <TableCell className="text-right text-xs text-muted-foreground tabular-nums">
                              {formatKES(sectionTotalMinor(sec))}
                            </TableCell>
                            <TableCell />
                          </TableRow>
                          {sec.items.map((item) => (
                            <TableRow key={item.ref}>
                              <TableCell className="pl-8 font-mono text-xs">{item.ref}</TableCell>
                              <TableCell className="max-w-md text-sm whitespace-normal">
                                {item.description}
                              </TableCell>
                              <TableCell className="text-sm">{item.unit}</TableCell>
                              <TableCell className="text-right text-sm tabular-nums">
                                {formatNumber(item.qty)}
                              </TableCell>
                              <TableCell className="text-right text-sm tabular-nums">
                                {formatNumber(item.rate)}
                              </TableCell>
                              <TableCell className="text-right text-sm tabular-nums">
                                {formatKES(itemAmountMinor(item))}
                              </TableCell>
                              <TableCell>
                                <div
                                  className="flex items-center gap-2"
                                  title={formatKES(itemDoneMinor(item))}
                                >
                                  <Progress
                                    value={item.done * 100}
                                    className="h-1.5"
                                    aria-label={t("cols.done")}
                                  />
                                  <span className="w-9 text-right text-xs tabular-nums">
                                    {formatPercent(item.done)}
                                  </span>
                                </div>
                              </TableCell>
                            </TableRow>
                          ))}
                        </Fragment>
                      ))
                    : null}
                </Fragment>
              );
            })}
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                  {t("noResults")}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell colSpan={5} className="font-semibold">
                {t("billsTotal")}
              </TableCell>
              <TableCell className="text-right font-semibold tabular-nums">
                {formatKES(grandTotal)}
              </TableCell>
              <TableCell className="text-xs tabular-nums">{formatKES(grandDone)}</TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </div>
    </div>
  );
}
