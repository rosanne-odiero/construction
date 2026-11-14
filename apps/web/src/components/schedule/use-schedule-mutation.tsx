"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useProblemMessage } from "@/components/projects/use-problem-message";

/**
 * Runs a schedule change: shows the API's problem as an alert (the dialog stays open, so nothing
 * typed is lost on a version conflict), and refreshes the server-rendered page on success.
 */
export function useScheduleMutation() {
  const problem = useProblemMessage();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(operation: () => Promise<unknown>, onDone?: () => void): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await operation();
      onDone?.();
      router.refresh();
      return true;
    } catch (caught) {
      setError(problem(caught));
      return false;
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, setError, run };
}

export function FormError({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="text-sm text-destructive">
      {message}
    </p>
  ) : null;
}

export const selectClass =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";
