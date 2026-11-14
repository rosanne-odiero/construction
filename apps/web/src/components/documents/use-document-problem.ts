"use client";

import { useTranslations } from "next-intl";
import { FoundationApiError } from "@/lib/foundation-api";
import { useProblemMessage } from "@/components/projects/use-problem-message";

/**
 * Problem text for document uploads: the file-type and size refusals are worded for documents
 * (PDF, images, Word, Excel up to 25 MB), not for BQ workbooks or photos.
 */
export function useDocumentProblem() {
  const problem = useProblemMessage();
  const tErrors = useTranslations("apiErrors");
  const t = useTranslations("documents");
  return (error: unknown): string => {
    if (error instanceof FoundationApiError) {
      if (error.code === "unsupported-file-type" || error.code === "unsafe-archive")
        return tErrors("unsupportedDocumentType");
      if (error.code === "payload-too-large") return t("upload.tooLarge");
    }
    return problem(error);
  };
}

/** The ISO date a native date field holds, or null when empty. */
export const dateValue = (form: FormData, name: string): string | null => {
  const value = String(form.get(name) ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
};

/** The trimmed text of a field, or undefined when empty (so optional fields are left out). */
export const optional = (form: FormData, name: string): string | undefined => {
  const value = String(form.get(name) ?? "").trim();
  return value === "" ? undefined : value;
};
