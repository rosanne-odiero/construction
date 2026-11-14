"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Paperclip } from "lucide-react";
import {
  portalDocumentResponseSchema,
  procurementDocumentResponseSchema,
} from "@pm-buddy/validation";
import { Button } from "@/components/ui/button";
import { liveUpload } from "@/lib/live-api";
import { useP2pProblem } from "./use-p2p-problem";

/**
 * Attaches one file to a procurement record (quotation or invoice document, GRN photo). The API
 * sniffs the content, checks the size and runs the malware hook; the page refreshes afterwards.
 */
export function DocumentUpload({
  path,
  label,
  accept = "application/pdf,image/jpeg,image/png,image/webp",
  hint,
  id,
  contract = "procurement",
}: {
  path: string;
  label: string;
  accept?: string;
  hint?: string;
  id: string;
  /** The upload's response contract (the supplier portal answers with its own). */
  contract?: "procurement" | "supplier-portal";
}) {
  const t = useTranslations("p2p.common");
  const problem = useP2pProblem();
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  async function upload() {
    if (!file) return;
    setBusy(true);
    setMessage(null);
    try {
      if (contract === "supplier-portal")
        await liveUpload(path, file, portalDocumentResponseSchema);
      else await liveUpload(path, file, procurementDocumentResponseSchema);
      setMessage({ text: t("attached"), error: false });
      setFile(null);
      if (input.current) input.current.value = "";
      router.refresh();
    } catch (error) {
      setMessage({ text: problem(error), error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={input}
          id={id}
          type="file"
          accept={accept}
          className="max-w-full text-sm file:mr-2 file:rounded-md file:border file:bg-background file:px-2 file:py-1"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!file || busy}
          onClick={() => void upload()}
        >
          <Paperclip aria-hidden /> {busy ? t("uploading") : t("attach")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{hint ?? t("attachHint")}</p>
      {message ? (
        <p
          role={message.error ? "alert" : "status"}
          className={message.error ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
