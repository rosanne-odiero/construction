"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { unitsCompatible } from "@pm-buddy/domain";
import {
  bqItemLinkResponseSchema,
  buildupsResponseSchema,
  type BqItemWire,
  type BuildupSummary,
} from "@pm-buddy/validation";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { formatKES } from "@/lib/format";
import { liveRequest } from "@/lib/live-api";
import { useUnitLabel } from "./bq-labels";

/**
 * Links a BQ item (by lineage) to the current version of a company build-up. Only build-ups
 * priced per the item's unit are offered; the API repeats the unit check (422 unit-mismatch).
 */
export function LinkBuildupDialog({
  projectId,
  item,
  onClose,
}: {
  projectId: string;
  item: BqItemWire | null;
  onClose: (changed: boolean) => void;
}) {
  return (
    <Dialog open={item !== null} onOpenChange={(next) => (next ? undefined : onClose(false))}>
      <DialogContent showCloseButton={false}>
        {item ? (
          <LinkForm key={item.lineageId} projectId={projectId} item={item} onClose={onClose} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** Mounted each time the dialog opens, so its state starts fresh. */
function LinkForm({
  projectId,
  item,
  onClose,
}: {
  projectId: string;
  item: BqItemWire;
  onClose: (changed: boolean) => void;
}) {
  const t = useTranslations("rateBuildUps.link");
  const unit = useUnitLabel();
  const problem = useProblemMessage();
  const [buildups, setBuildups] = useState<BuildupSummary[] | null>(null);
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    liveRequest("/rate-buildups", buildupsResponseSchema)
      .then((result) => setBuildups(result.buildups))
      .catch((error: unknown) => setFailure(problem(error)));
    // Loaded once per opening; `problem` only formats the message.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const compatible = (buildups ?? []).filter(
    (entry) => unitsCompatible({ unit: item.unit, unitRaw: item.unitRaw }, entry.unit).ok,
  );

  async function run(method: "PUT" | "DELETE") {
    setBusy(true);
    setFailure(null);
    try {
      const chosen = compatible.find((entry) => entry.id === choice);
      await liveRequest(
        `/projects/${projectId}/bq/items/${item.lineageId}/rate-buildup`,
        bqItemLinkResponseSchema,
        method === "PUT"
          ? { method, body: { buildupVersionId: chosen?.currentVersionId ?? "" } }
          : { method },
      );
      onClose(true);
    } catch (error) {
      setFailure(problem(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("title")}</DialogTitle>
        <DialogDescription>
          {t("description", {
            item: `${item.ref ? `${item.ref} · ` : ""}${item.description.slice(0, 80)}`,
            unit: unit(item.unit, item.unitRaw) || t("noUnit"),
          })}
        </DialogDescription>
      </DialogHeader>
      {failure ? (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      ) : null}
      {item.rateBuildUp ? (
        <p className="text-sm">
          {t("current", { code: item.rateBuildUp.code, version: item.rateBuildUp.versionNo })}
        </p>
      ) : null}
      {buildups === null && !failure ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("loading")}
        </p>
      ) : null}
      {buildups !== null ? (
        compatible.length ? (
          <Field>
            <FieldLabel htmlFor="link-buildup">{t("choose")}</FieldLabel>
            <select
              id="link-buildup"
              value={choice}
              onChange={(event) => setChoice(event.target.value)}
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            >
              <option value="">{t("placeholder")}</option>
              {compatible.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.code} · {entry.name} ·{" "}
                  {entry.rateMinor === null ? t("rateUnavailable") : formatKES(entry.rateMinor)} /{" "}
                  {unit(entry.unit, null)} (v{entry.currentVersionNo})
                </option>
              ))}
            </select>
            <FieldDescription>{t("versionNote")}</FieldDescription>
          </Field>
        ) : (
          <p className="text-sm text-muted-foreground">{t("noneCompatible")}</p>
        )
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onClose(false)}>
          {t("cancel")}
        </Button>
        {item.rateBuildUp ? (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void run("DELETE")}
          >
            {t("unlink")}
          </Button>
        ) : null}
        <Button type="button" disabled={busy || !choice} onClick={() => void run("PUT")}>
          {t("submit")}
        </Button>
      </DialogFooter>
    </>
  );
}
