"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { startAuthentication } from "@simplewebauthn/browser";
import { KeyRound, ShieldCheck } from "lucide-react";
import {
  authResponseSchema,
  passkeyAuthenticationOptionsResponseSchema,
  type AuthResponse,
} from "@pm-buddy/validation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { FoundationApiError } from "@/lib/foundation-api";
import { liveRequest } from "@/lib/live-api";
import { useProblemMessage } from "./use-problem-message";

/**
 * Sensitive project actions (creating a project, assigning the team) need MFA verified within
 * five minutes. `run` retries an operation once after the user verifies with their authenticator
 * code or a passkey; cancelling rethrows the original step-up error.
 */
export function useStepUp() {
  const pending = useRef<((verified: boolean) => void) | null>(null);
  const [open, setOpen] = useState(false);

  const run = useCallback(async <T,>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof FoundationApiError && error.code === "step-up-required")) throw error;
      const verified = await new Promise<boolean>((resolve) => {
        pending.current = resolve;
        setOpen(true);
      });
      if (!verified) throw error;
      return operation();
    }
  }, []);

  const finish = (verified: boolean) => {
    setOpen(false);
    pending.current?.(verified);
    pending.current = null;
  };

  return { run, dialog: <StepUpDialog open={open} onDone={finish} /> };
}

function StepUpDialog({ open, onDone }: { open: boolean; onDone: (verified: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onDone(false))}>
      <DialogContent showCloseButton={false}>
        {open ? <StepUpForm onDone={onDone} /> : null}
      </DialogContent>
    </Dialog>
  );
}

/** Mounted each time the dialog opens, so its state starts fresh. */
function StepUpForm({ onDone }: { onDone: (verified: boolean) => void }) {
  const t = useTranslations("stepUp");
  const problem = useProblemMessage();
  const [account, setAccount] = useState<AuthResponse | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    liveRequest("/auth/me", authResponseSchema)
      .then(setAccount)
      .catch((error: unknown) => setFailure(problem(error)));
    // Loaded once per opening; `problem` only formats the message.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function verify(operation: () => Promise<unknown>) {
    setBusy(true);
    setFailure(null);
    try {
      await operation();
      onDone(true);
    } catch (error) {
      setFailure(problem(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <ShieldCheck className="size-4" aria-hidden /> {t("title")}
        </DialogTitle>
        <DialogDescription>{t("description")}</DialogDescription>
      </DialogHeader>
      {failure ? (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      ) : null}
      {account?.user.totpEnabled !== false ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void verify(() =>
              liveRequest("/auth/mfa/step-up", authResponseSchema, {
                method: "POST",
                body: { code },
              }),
            );
          }}
        >
          <Field>
            <FieldLabel htmlFor="step-up-code">{t("code")}</FieldLabel>
            <Input
              id="step-up-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
              required
            />
          </Field>
          <Button type="submit" className="w-full" disabled={busy || code.length !== 6}>
            {t("verify")}
          </Button>
        </form>
      ) : null}
      {account && account.user.passkeys > 0 ? (
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void verify(async () => {
              const { options } = await liveRequest(
                "/auth/passkeys/step-up/options",
                passkeyAuthenticationOptionsResponseSchema,
                { method: "POST" },
              );
              let credential;
              try {
                credential = await startAuthentication({ optionsJSON: options });
              } catch {
                throw new FoundationApiError(0, "passkey-cancelled");
              }
              await liveRequest("/auth/passkeys/step-up", authResponseSchema, {
                method: "POST",
                body: { credential },
              });
            })
          }
        >
          <KeyRound aria-hidden /> {t("passkey")}
        </Button>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onDone(false)}>
          {t("cancel")}
        </Button>
      </DialogFooter>
    </>
  );
}
