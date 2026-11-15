"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { GRN_PHOTO_KINDS, type GrnPhotoKind } from "@pm-buddy/types";
import { selectClass } from "@/components/procurement/material-form";
import { Field, FieldLabel } from "@/components/ui/field";
import { DocumentUpload } from "./document-upload";

/** Adds a delivery-note or goods photo to a recorded GRN (images only, 5 MB each). */
export function GrnPhotoUpload({ grnId }: { grnId: string }) {
  const t = useTranslations("p2p.grns.detail");
  const tCapture = useTranslations("p2p.grns.capture");
  const [kind, setKind] = useState<GrnPhotoKind>("delivery_note");
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <p className="text-sm font-medium">{t("addPhoto")}</p>
      <Field className="max-w-xs">
        <FieldLabel htmlFor="grn-photo-kind">{t("photoKind")}</FieldLabel>
        <select
          id="grn-photo-kind"
          className={selectClass}
          value={kind}
          onChange={(event) => setKind(event.target.value as GrnPhotoKind)}
        >
          {GRN_PHOTO_KINDS.map((value) => (
            <option key={value} value={value}>
              {t(`kinds.${value}`)}
            </option>
          ))}
        </select>
      </Field>
      <DocumentUpload
        key={kind}
        id="grn-photo-file"
        path={`/procurement/grns/${grnId}/photos?kind=${kind}`}
        label={t("upload")}
        accept="image/jpeg,image/png,image/webp"
        hint={tCapture("photoHint")}
      />
    </div>
  );
}
