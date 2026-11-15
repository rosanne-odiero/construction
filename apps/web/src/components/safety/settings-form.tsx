"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Plus, X } from "lucide-react";
import {
  PPE_ITEMS,
  STARTER_INDUCTION_TOPICS,
  type InductionTopic,
  type PpeItem,
  type StarterInductionTopic,
} from "@pm-buddy/types";
import {
  safetySettingsResponseSchema,
  updateSafetySettingsRequestSchema,
  type SafetySettings,
} from "@pm-buddy/validation";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { FormError } from "@/components/schedule/use-schedule-mutation";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { liveRequest } from "@/lib/live-api";
import { parseWholeNumber } from "@/lib/safety";
import { field } from "./common";

type TopicDraft = InductionTopic & { draftKey: number };
const starter = new Set<string>(STARTER_INDUCTION_TOPICS);

/**
 * The company's safety settings (config.manage to change): the induction checklist, how long
 * inductions last, the attendance look-back, the kit check interval and PPE replacement periods.
 */
export function SafetySettingsForm({ settings }: { settings: SafetySettings }) {
  const t = useTranslations("safety");
  const problem = useProblemMessage();
  const router = useRouter();
  const canEdit = settings.permissions.canEdit;
  const next = useRef(settings.inductionTopics.length + 1);
  const [topics, setTopics] = useState<TopicDraft[]>(
    settings.inductionTopics.map((topic, index) => ({ ...topic, draftKey: index + 1 })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save(form: FormData) {
    const validity = field(form, "inductionValidityDays");
    const ppe = Object.fromEntries(
      PPE_ITEMS.map((item) => [item, parseWholeNumber(field(form, `ppe-${item}`), 1, 3650)]),
    ) as Record<PpeItem, number | null>;
    const parsed = updateSafetySettingsRequestSchema.safeParse({
      inductionTopics: topics.map((topic) => ({
        key: topic.key,
        label: topic.label === null ? null : topic.label.trim(),
      })),
      inductionValidityDays: validity === "" ? null : parseWholeNumber(validity, 30, 1095),
      inductionLookbackDays: parseWholeNumber(field(form, "inductionLookbackDays"), 1, 90),
      kitCheckIntervalDays: parseWholeNumber(field(form, "kitCheckIntervalDays"), 7, 180),
      ppeReplacementDays: ppe,
      version: settings.version,
    });
    if (!parsed.success) {
      setError(t("settings.invalid"));
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await liveRequest("/safety/settings", safetySettingsResponseSchema, {
        method: "PUT",
        body: parsed.data,
      });
      setSaved(true);
      router.refresh();
    } catch (caught) {
      setError(problem(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      noValidate
      className="max-w-3xl space-y-6"
      onSubmit={(event) => {
        event.preventDefault();
        void save(new FormData(event.currentTarget));
      }}
    >
      {canEdit ? null : (
        <p className="rounded-md border bg-muted p-3 text-sm">{t("settings.readOnly")}</p>
      )}
      {settings.version === 0 ? (
        <p className="text-sm text-muted-foreground">{t("settings.defaults")}</p>
      ) : null}
      <FormError message={error} />
      {saved ? (
        <p role="status" className="text-sm text-success">
          {t("settings.saved")}
        </p>
      ) : null}
      <fieldset className="space-y-3">
        <legend className="text-base font-semibold">{t("settings.topics")}</legend>
        <p className="text-sm text-muted-foreground">{t("settings.topicsHint")}</p>
        <ol className="space-y-2">
          {topics.map((topic, index) => (
            <li key={topic.draftKey} className="flex items-center gap-2">
              {topic.label === null && starter.has(topic.key) ? (
                <span className="min-w-0 flex-1 text-sm break-words">
                  {index + 1}. {t(`topics.${topic.key as StarterInductionTopic}`)}
                </span>
              ) : (
                <Input
                  aria-label={t("settings.topicLabel", { index: index + 1 })}
                  className="min-w-0 flex-1"
                  value={topic.label ?? ""}
                  maxLength={120}
                  disabled={!canEdit || busy}
                  onChange={(event) => {
                    const label = event.currentTarget.value;
                    setTopics((current) =>
                      current.map((entry) =>
                        entry.draftKey === topic.draftKey ? { ...entry, label } : entry,
                      ),
                    );
                  }}
                />
              )}
              {canEdit ? (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  disabled={busy || topics.length <= 1}
                  aria-label={t("settings.removeTopic", { index: index + 1 })}
                  onClick={() =>
                    setTopics((current) =>
                      current.filter((entry) => entry.draftKey !== topic.draftKey),
                    )
                  }
                >
                  <X className="size-4" aria-hidden />
                </Button>
              ) : null}
            </li>
          ))}
        </ol>
        {canEdit ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || topics.length >= 30}
            onClick={() => {
              const draftKey = next.current++;
              setTopics((current) => [
                ...current,
                { key: `custom_${Date.now().toString(36)}_${draftKey}`, label: "", draftKey },
              ]);
            }}
          >
            <Plus className="size-4" aria-hidden />
            {t("settings.addTopic")}
          </Button>
        ) : null}
      </fieldset>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field>
          <FieldLabel htmlFor="settings-validity">{t("settings.validity")}</FieldLabel>
          <Input
            id="settings-validity"
            name="inductionValidityDays"
            inputMode="numeric"
            defaultValue={settings.inductionValidityDays ?? ""}
            disabled={!canEdit || busy}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="settings-lookback">{t("settings.lookback")}</FieldLabel>
          <Input
            id="settings-lookback"
            name="inductionLookbackDays"
            inputMode="numeric"
            defaultValue={settings.inductionLookbackDays}
            disabled={!canEdit || busy}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="settings-kits">{t("settings.kitInterval")}</FieldLabel>
          <Input
            id="settings-kits"
            name="kitCheckIntervalDays"
            inputMode="numeric"
            defaultValue={settings.kitCheckIntervalDays}
            disabled={!canEdit || busy}
          />
        </Field>
      </div>
      <fieldset className="space-y-3">
        <legend className="text-base font-semibold">{t("settings.ppe")}</legend>
        <p className="text-sm text-muted-foreground">{t("settings.ppeHint")}</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {PPE_ITEMS.map((item) => (
            <Field key={item}>
              <FieldLabel htmlFor={`settings-ppe-${item}`}>{t(`ppeItem.${item}`)}</FieldLabel>
              <Input
                id={`settings-ppe-${item}`}
                name={`ppe-${item}`}
                inputMode="numeric"
                defaultValue={settings.ppeReplacementDays[item]}
                disabled={!canEdit || busy}
              />
            </Field>
          ))}
        </div>
      </fieldset>
      {canEdit ? (
        <Button type="submit" disabled={busy}>
          {t("settings.save")}
        </Button>
      ) : null}
    </form>
  );
}
