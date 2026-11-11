"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { LogOut } from "lucide-react";
import { csrfResponseSchema, messageResponseSchema } from "@pm-buddy/validation";
import { Button } from "@/components/ui/button";
import { foundationRequest } from "@/lib/foundation-api";

/** Signs out (the API revokes the session and clears its cookies), then opens /sign-in. */
export function SignOutButton() {
  const t = useTranslations("topbar");
  const router = useRouter();
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
      router.replace("/sign-in");
      router.refresh();
    }
  }
  return (
    <Button variant="outline" size="sm" disabled={busy} onClick={() => void signOut()}>
      <LogOut aria-hidden /> {t("signOut")}
    </Button>
  );
}
