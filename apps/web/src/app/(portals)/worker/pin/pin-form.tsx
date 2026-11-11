"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { LoaderCircle } from "lucide-react";
import { pinProblem, type PinProblem } from "@pm-buddy/domain";
import { messageResponseSchema } from "@pm-buddy/validation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { FoundationApiError } from "@/lib/foundation-api";
import { normalizeKenyanPhone } from "@/lib/format";
import { postWithCsrf } from "@/lib/csrf-post";

type Failure =
  | "invalidLink"
  | "mismatch"
  | "phone"
  | "rateLimited"
  | "network"
  | "unexpected"
  | `pin.${PinProblem}`;

function failureOf(error: unknown): Failure {
  if (!(error instanceof FoundationApiError)) return "unexpected";
  if (error.code === "pin-too-weak") return "pin.repeated";
  if (error.status === 401) return "invalidLink";
  if (error.status === 429) return "rateLimited";
  if (error.code === "network") return "network";
  return "unexpected";
}

/** Without a token: ask for an SMS link. With one: choose a new PIN. */
export function PinForm({ token }: { token: string | null }) {
  const t = useTranslations("portals.pin");
  const tJoin = useTranslations("portals.join");
  const tPin = useTranslations("portals.pinRules");
  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const normalised = normalizeKenyanPhone(phone);

  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setFailure(null);
    try {
      await operation();
      setDone(true);
    } catch (error) {
      setFailure(failureOf(error));
    } finally {
      setBusy(false);
    }
  }

  const alert = failure ? (
    <p
      role="alert"
      className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
    >
      {failure.startsWith("pin.")
        ? tPin(failure.slice(4) as PinProblem)
        : failure === "invalidLink"
          ? t("invalidLink")
          : tJoin(
              `errors.${failure as "mismatch" | "phone" | "rateLimited" | "network" | "unexpected"}`,
            )}
    </p>
  ) : null;

  return (
    <Card className="mx-auto w-full max-w-md">
      <CardHeader>
        <CardTitle>
          <h1 className="text-xl">{t("title")}</h1>
        </CardTitle>
        <CardDescription>{token ? t("setDescription") : t("requestDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        {done ? (
          <div role="status" className="space-y-3 text-sm">
            <p>{token ? t("saved") : t("sent")}</p>
            {token ? (
              <Button asChild>
                <Link href="/sign-in?next=%2Fworker">{t("signIn")}</Link>
              </Button>
            ) : null}
          </div>
        ) : token ? (
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              const problem = pinProblem(pin);
              if (problem) return setFailure(`pin.${problem}`);
              if (pin !== confirm) return setFailure("mismatch");
              void run(async () => {
                await postWithCsrf("/auth/pin/reset", messageResponseSchema, { token, pin });
              });
            }}
          >
            <FieldGroup>
              {alert}
              <Field>
                <FieldLabel htmlFor="reset-pin">{t("newPin")}</FieldLabel>
                <Input
                  id="reset-pin"
                  type="password"
                  inputMode="numeric"
                  autoComplete="new-password"
                  maxLength={6}
                  value={pin}
                  onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))}
                  aria-describedby="reset-pin-hint"
                  required
                />
                <FieldDescription id="reset-pin-hint">{tJoin("pinHint")}</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="reset-confirm">{tJoin("confirmPin")}</FieldLabel>
                <Input
                  id="reset-confirm"
                  type="password"
                  inputMode="numeric"
                  autoComplete="new-password"
                  maxLength={6}
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value.replace(/\D/g, ""))}
                  required
                />
              </Field>
              <Button type="submit" disabled={busy}>
                {busy ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
                {t("save")}
              </Button>
            </FieldGroup>
          </form>
        ) : (
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (!normalised) return setFailure("phone");
              void run(async () => {
                await postWithCsrf("/auth/password/forgot", messageResponseSchema, {
                  identifier: normalised,
                });
              });
            }}
          >
            <FieldGroup>
              {alert}
              <Field>
                <FieldLabel htmlFor="reset-phone">{tJoin("phone")}</FieldLabel>
                <Input
                  id="reset-phone"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  aria-describedby="reset-phone-hint"
                  required
                />
                <FieldDescription id="reset-phone-hint">
                  {normalised
                    ? tJoin("phoneNormalised", { phone: normalised })
                    : tJoin("phoneHint")}
                </FieldDescription>
              </Field>
              <Button type="submit" disabled={busy}>
                {busy ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
                {t("send")}
              </Button>
            </FieldGroup>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
