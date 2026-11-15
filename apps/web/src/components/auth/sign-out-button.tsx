"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { LogOut } from "lucide-react";
import { csrfResponseSchema, messageResponseSchema } from "@pm-buddy/validation";
import { Button } from "@/components/ui/button";
import { foundationRequest } from "@/lib/foundation-api";

/** Signs out (the API revokes the session and clears its cookies), then opens /sign-in. */
export function SignOutButton() {
  const t = useTranslations("topbar");
  const [busy, setBusy] = useState(false);
  async function signOut() {
    setBusy(true);
    try {
      const { csrfToken } = await foundationRequest("/auth/csrf", csrfResponseSchema);
      await foundationRequest("/auth/logout", messageResponseSchema, {
        method: "POST",
        body: {},
        headers: { "X-CSRF-Token": csrfToken },
      });
    } catch {
      // Sign-out always clears the cookies server-side; continue to the sign-in page either way.
    } finally {
      // A full page load, not a client navigation: the router cache of authenticated pages is
      // dropped with the old document, so Back cannot show them on a shared computer (D-153).
      window.location.replace("/sign-in");
    }
  }
  return (
    <Button variant="outline" size="sm" disabled={busy} onClick={() => void signOut()}>
      <LogOut aria-hidden /> {t("signOut")}
    </Button>
  );
}
