"use client";

import { useTranslations } from "next-intl";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { FoundationApiError } from "@/lib/foundation-api";

/**
 * EN/SW text for measurement and valuation API problems. Codes shared with other modules but
 * worded for them (photo and PDF limits) get valuation wording here.
 */
export function useValuationProblem() {
  const problem = useProblemMessage();
  const t = useTranslations("valuations.problems");
  return (error: unknown): string => {
    if (error instanceof FoundationApiError) {
      if (error.code === "too-many-photos") return t("tooManyPhotos");
      if (error.code === "export-too-large") return t("exportTooLarge");
      if (error.code === "measurement-not-found") return t("measurementNotFound");
      if (error.code === "bq-not-approved") return t("bqNotApproved");
    }
    return problem(error);
  };
}
