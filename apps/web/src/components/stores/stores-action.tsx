"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { z } from "zod";
import { REASON_LIMITS } from "@pm-buddy/domain";
import {
  movementResponseSchema,
  stockTakeResponseSchema,
  storeDetailResponseSchema,
  transferResponseSchema,
} from "@pm-buddy/validation";
import { useP2pProblem } from "@/components/procurement/p2p/use-p2p-problem";
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
import { Textarea } from "@/components/ui/textarea";
import { liveRequest } from "@/lib/live-api";

export type ActionText = { button: string; title: string; description: string; confirm: string };

/** What a command returns, and the page that shows a record it created. */
const ENTITIES = {
  store: {
    schema: storeDetailResponseSchema,
    href: (result: { store: { id: string } }) => `/stores/${result.store.id}`,
  },
  movement: {
    schema: movementResponseSchema,
    href: (result: { movement: { id: string } }) => `/stores/movements/${result.movement.id}`,
  },
  transfer: {
    schema: transferResponseSchema,
    href: (result: { transfer: { id: string } }) => `/stores/transfers/${result.transfer.id}`,
  },
  stockTake: {
    schema: stockTakeResponseSchema,
    href: (result: { stockTake: { id: string } }) => `/stores/stock-takes/${result.stockTake.id}`,
  },
} as const;
export type StoresEntity = keyof typeof ENTITIES;

/**
 * One stores command behind a confirmation dialog (with a reason where the workflow needs one).
 * The API decides: refusals such as maker-checker, version conflicts or insufficient stock are
 * shown in the dialog in EN/SW. On success the page refreshes, or opens the created record
 * (`openResult`). Props are serialisable: server pages render this client component.
 */
export function StoresAction({
  path,
  entity,
  body = {},
  reason = false,
  text,
  primary = false,
  destructive = false,
  method = "POST",
  openResult = false,
  icon,
}: {
  path: string;
  entity: StoresEntity;
  body?: Record<string, unknown>;
  reason?: boolean;
  text: ActionText;
  primary?: boolean;
  destructive?: boolean;
  method?: "POST" | "PUT" | "DELETE";
  openResult?: boolean;
  icon?: React.ReactNode;
}) {
  const tCommon = useTranslations("stores.common");
  const problem = useP2pProblem();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const id = `action-${path.replace(/[^a-z0-9]/gi, "-")}`;

  async function run() {
    setBusy(true);
    setFailure(null);
    try {
      const target = ENTITIES[entity];
      const result = await liveRequest(path, target.schema as z.ZodType<unknown>, {
        method,
        body: reason ? { ...body, reason: why.trim() } : body,
      });
      setOpen(false);
      setWhy("");
      if (openResult) router.push((target.href as (value: unknown) => string)(result));
      else router.refresh();
    } catch (error) {
      setFailure(problem(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant={primary ? "default" : "outline"}
        onClick={() => {
          setFailure(null);
          setWhy("");
          setOpen(true);
        }}
      >
        {icon} {text.button}
      </Button>
      <Dialog open={open} onOpenChange={(next) => (next ? undefined : setOpen(false))}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{text.title}</DialogTitle>
            <DialogDescription>{text.description}</DialogDescription>
          </DialogHeader>
          {failure ? (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          ) : null}
          {reason ? (
            <Field>
              <FieldLabel htmlFor={`${id}-reason`}>{tCommon("reason")}</FieldLabel>
              <Textarea
                id={`${id}-reason`}
                value={why}
                onChange={(event) => setWhy(event.target.value)}
                maxLength={REASON_LIMITS.max}
                rows={3}
                required
              />
              <FieldDescription>{tCommon("reasonHint")}</FieldDescription>
            </Field>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {tCommon("close")}
            </Button>
            <Button
              type="button"
              variant={destructive ? "destructive" : "default"}
              disabled={busy || (reason && why.trim().length < REASON_LIMITS.min)}
              onClick={() => void run()}
            >
              {text.confirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
