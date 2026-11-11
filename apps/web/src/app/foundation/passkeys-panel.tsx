"use client";

import { useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import type { Passkey } from "@pm-buddy/validation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { formatDateTime } from "@/lib/format";

const subscribe = () => () => {};

/** WebAuthn support is a property of the browser, fixed for the page's lifetime. */
function useWebAuthnSupport() {
  return useSyncExternalStore(subscribe, browserSupportsWebAuthn, () => false);
}

/**
 * Passkeys as an MFA factor: register (named), list, remove, and verify a fresh MFA check with
 * one. The ceremonies and API calls live in the console; this renders and collects input.
 */
export function PasskeysPanel({
  passkeys,
  registered,
  disabled,
  onRegister,
  onStepUp,
  onRemove,
}: {
  /** Loaded passkey details (empty until the workspace is loaded). */
  passkeys: Passkey[];
  /** The account's passkey count from the session, known before the list is loaded. */
  registered: number;
  disabled: boolean;
  onRegister: (name: string) => void;
  onStepUp: () => void;
  onRemove: (passkey: Passkey) => void;
}) {
  const t = useTranslations("foundation");
  const supported = useWebAuthnSupport();
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("passkeys")}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm">{t("passkeysHint")}</p>
        {!supported ? (
          <p role="note" className="rounded border p-3 text-sm">
            {t("passkeysUnsupported")}
          </p>
        ) : null}
        {registered > 0 ? (
          <Button disabled={disabled || !supported} onClick={onStepUp}>
            {t("passkeyStepUp")}
          </Button>
        ) : null}
        {passkeys.length ? (
          <ul className="space-y-3" aria-label={t("passkeys")}>
            {passkeys.map((passkey) => (
              <li
                key={passkey.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded border p-3"
              >
                <span className="space-y-1">
                  <span className="block font-medium">{passkey.name}</span>
                  <span className="block text-sm text-muted-foreground">
                    {t("passkeyAdded", { time: formatDateTime(passkey.createdAt) })} ·{" "}
                    {passkey.lastUsedAt
                      ? t("passkeyLastUsed", { time: formatDateTime(passkey.lastUsedAt) })
                      : t("passkeyNeverUsed")}
                  </span>
                  <Badge variant="outline">
                    {passkey.deviceType === "multiDevice"
                      ? t("passkeySynced")
                      : t("passkeyDeviceBound")}
                  </Badge>
                </span>
                <Button variant="outline" disabled={disabled} onClick={() => onRemove(passkey)}>
                  {t("removePasskey", { name: passkey.name })}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            {registered ? t("passkeysLoadHint") : t("passkeysEmpty")}
          </p>
        )}
        <p className="text-sm text-muted-foreground">{t("passkeyRemoveHint")}</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const name = new FormData(form).get("name");
            if (typeof name === "string") onRegister(name);
          }}
        >
          <fieldset disabled={disabled || !supported} className="space-y-4">
            <Field>
              <FieldLabel htmlFor="passkey-name">{t("passkeyName")}</FieldLabel>
              <Input id="passkey-name" name="name" autoComplete="off" maxLength={60} required />
            </Field>
            <Button type="submit">{t("addPasskey")}</Button>
          </fieldset>
        </form>
      </CardContent>
    </Card>
  );
}
