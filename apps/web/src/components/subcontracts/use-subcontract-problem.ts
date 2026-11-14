"use client";

import { useTranslations } from "next-intl";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { FoundationApiError } from "@/lib/foundation-api";
import { SUBCONTRACT_PROBLEM_KEYS } from "@/lib/subcontracts";

/** EN/SW text for subcontract and piece-rate problems; anything else as everywhere else. */
export function useSubcontractProblem() {
  const problem = useProblemMessage();
  const t = useTranslations("subcontracts.problems");
  return (error: unknown): string => {
    if (error instanceof FoundationApiError && error.code in SUBCONTRACT_PROBLEM_KEYS)
      return t(SUBCONTRACT_PROBLEM_KEYS[error.code as keyof typeof SUBCONTRACT_PROBLEM_KEYS]);
    return problem(error);
  };
}
