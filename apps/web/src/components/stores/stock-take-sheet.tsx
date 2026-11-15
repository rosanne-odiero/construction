"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { StandardUnitCode } from "@pm-buddy/types";
import {
  stockTakeResponseSchema,
  type StockTakeResponse,
  type UnitWire,
} from "@pm-buddy/validation";
import { useP2pProblem } from "@/components/procurement/p2p/use-p2p-problem";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { formatKES } from "@/lib/format";
import { liveRequest } from "@/lib/live-api";
import { unitLabel } from "@/lib/procurement";
import { formatStock, newClientId, nonNegativeQuantity } from "@/lib/stores";

/**
 * The count sheet of a stock take (D5.3). Each line shows the system quantity when the sheet was
 * started; once counted, the system quantity at that moment (snapshot + movements since), the
 * variance and its estimated value. Counts are saved as a batch with client IDs and one
 * Idempotency-Key per save (kept until it succeeds, so a retry replays rather than recounts).
 */
export function StockTakeSheet({ take, units }: { take: StockTakeResponse; units: UnitWire[] }) {
  const t = useTranslations("stores.sheet");
  const tCommon = useTranslations("stores.common");
  const tUnits = useTranslations("catalogue.units");
  const problem = useP2pProblem();
  const router = useRouter();
  const label = (code: string) => unitLabel(code, (unit: StandardUnitCode) => tUnits(unit), units);
  const { stockTake, permissions } = take;
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<{
    key: string;
    signature: string;
    body: { capturedAt: string; counts: { id: string; lineId: string; countedQuantity: string }[] };
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const entered = stockTake.lines
    .map((line) => ({ line, raw: (counts[line.id] ?? "").trim() }))
    .filter((entry) => entry.raw !== "");
  const invalid = entered.filter((entry) => nonNegativeQuantity(entry.raw) === null);

  async function save() {
    if (!entered.length || invalid.length) return;
    setBusy(true);
    setFailure(null);
    setSaved(false);
    const signature = JSON.stringify(entered.map((entry) => [entry.line.id, entry.raw]));
    // A retry of the same counts resends the same body (IDs, capture time) under the same key,
    // so the API replays it instead of refusing a reused key.
    const attempt =
      pending && pending.signature === signature
        ? pending
        : {
            key: newClientId(),
            signature,
            body: {
              capturedAt: new Date().toISOString(),
              counts: entered.map((entry) => ({
                id: newClientId(),
                lineId: entry.line.id,
                countedQuantity: nonNegativeQuantity(entry.raw) ?? "0",
              })),
            },
          };
    setPending(attempt);
    try {
      await liveRequest(`/stock-takes/${stockTake.id}/counts`, stockTakeResponseSchema, {
        method: "POST",
        headers: { "Idempotency-Key": attempt.key },
        body: attempt.body,
      });
      setPending(null);
      setCounts({});
      setSaved(true);
      router.refresh();
    } catch (error) {
      setFailure(problem(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="sheet-title" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="sheet-title" className="text-lg font-semibold">
          {t("title")}
        </h2>
        <p className="text-sm text-muted-foreground" role="status">
          {t("progress", { counted: stockTake.countedCount, total: stockTake.lineCount })}
        </p>
      </div>
      <ul className="space-y-2">
        {stockTake.lines.map((line) => {
          const id = `count-${line.lineNo}`;
          const raw = counts[line.id] ?? "";
          const unit = label(line.material.baseUnit);
          return (
            <li key={line.id} className="space-y-2 rounded-lg border p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="font-medium">{line.material.name}</p>
                {line.varianceQuantity !== null && line.varianceQuantity !== "0" ? (
                  <StatusBadge tone="warning">
                    {t("variance", { quantity: formatStock(line.varianceQuantity), unit })}
                  </StatusBadge>
                ) : line.varianceQuantity === "0" ? (
                  <StatusBadge tone="success">{t("matches")}</StatusBadge>
                ) : null}
              </div>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted-foreground">{t("snapshot")}</dt>
                <dd>
                  {formatStock(line.snapshotQuantity)} {unit}
                </dd>
                {line.countedQuantity !== null ? (
                  <>
                    <dt className="text-muted-foreground">{t("movements")}</dt>
                    <dd>
                      {formatStock(line.movementsSinceSnapshot ?? "0")} {unit}
                    </dd>
                    <dt className="text-muted-foreground">{t("expected")}</dt>
                    <dd>
                      {formatStock(line.expectedQuantity ?? "0")} {unit}
                    </dd>
                    <dt className="text-muted-foreground">{t("counted")}</dt>
                    <dd>
                      {formatStock(line.countedQuantity)} {unit}
                      {line.countedBy ? ` · ${line.countedBy.displayName}` : ""}
                    </dd>
                    {line.varianceValueMinor !== null ? (
                      <>
                        <dt className="text-muted-foreground">{t("varianceValue")}</dt>
                        <dd>{formatKES(line.varianceValueMinor)}</dd>
                      </>
                    ) : null}
                  </>
                ) : null}
              </dl>
              {permissions.canCount ? (
                <Field>
                  <FieldLabel htmlFor={id}>
                    {line.countedQuantity === null
                      ? t("countIn", { unit })
                      : t("recountIn", { unit })}
                  </FieldLabel>
                  <Input
                    id={id}
                    inputMode="decimal"
                    className="h-11 text-base"
                    value={raw}
                    aria-invalid={raw.trim() !== "" && nonNegativeQuantity(raw) === null}
                    onChange={(event) =>
                      setCounts((current) => ({ ...current, [line.id]: event.target.value }))
                    }
                  />
                </Field>
              ) : null}
            </li>
          );
        })}
      </ul>
      {permissions.canCount ? (
        <div className="space-y-2">
          {invalid.length ? <p className="text-sm text-destructive">{t("invalid")}</p> : null}
          {failure ? (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          ) : null}
          {saved ? (
            <p role="status" className="text-sm">
              {t("saved")}
            </p>
          ) : null}
          <Button
            type="button"
            className="h-11 w-full sm:w-auto"
            disabled={busy || !entered.length || invalid.length > 0}
            onClick={() => void save()}
          >
            {busy ? tCommon("saving") : t("save")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
