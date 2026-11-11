"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { siteResponseSchema, type Site } from "@pm-buddy/validation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { liveRequest } from "@/lib/live-api";
import { useProblemMessage } from "./use-problem-message";

/** Renames a site or changes its address/landmark (the geofence is versioned separately). */
export function SiteDetailsForm({ projectId, site }: { projectId: string; site: Site }) {
  const t = useTranslations("sites.editor");
  const problem = useProblemMessage();
  const router = useRouter();
  const [name, setName] = useState(site.name);
  const [address, setAddress] = useState(site.address ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const changed = name.trim() !== site.name || address.trim() !== (site.address ?? "");

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const body: Record<string, unknown> = { version: site.version };
      if (name.trim() !== site.name) body.name = name.trim();
      if (address.trim() !== (site.address ?? "")) body.address = address.trim() || null;
      await liveRequest(`/projects/${projectId}/sites/${site.id}`, siteResponseSchema, {
        method: "PATCH",
        body,
      });
      setMessage({ error: false, text: t("detailsSaved") });
      router.refresh();
    } catch (error) {
      setMessage({ error: true, text: problem(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("detailsTitle")}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Field>
            <FieldLabel htmlFor="site-details-name">{t("name")}</FieldLabel>
            <Input
              id="site-details-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              required
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="site-details-address">{t("address")}</FieldLabel>
            <Input
              id="site-details-address"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              maxLength={250}
            />
          </Field>
          <Button type="submit" variant="outline" disabled={busy || !changed || !name.trim()}>
            {t("saveDetails")}
          </Button>
          <p
            aria-live="polite"
            className={`text-sm sm:col-span-3 ${message?.error ? "text-destructive" : ""}`}
          >
            {message?.text}
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
