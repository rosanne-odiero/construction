"use client";

import { useTranslations } from "next-intl";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { FoundationApiError } from "@/lib/foundation-api";

/**
 * EN/SW text for procure-to-pay API problems. Upload problems get procurement wording (PDF or
 * photos) instead of the BQ workbook wording the shared table uses for the same codes.
 */
export function useP2pProblem() {
  const problem = useProblemMessage();
  const t = useTranslations("p2p.upload");
  return (error: unknown): string => {
    if (error instanceof FoundationApiError) {
      if (error.code === "unsupported-file-type") return t("unsupportedFile");
      if (error.code === "payload-too-large") return t("fileTooLarge");
      if (error.code === "file-required") return t("fileRequired");
    }
    return problem(error);
  };
}
