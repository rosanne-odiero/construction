"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Paperclip } from "lucide-react";
import { receiptResponseSchema } from "@pm-buddy/validation";
import { useP2pProblem } from "@/components/procurement/p2p/use-p2p-problem";
import { Button } from "@/components/ui/button";
import { liveUpload } from "@/lib/live-api";

/** Adds a receipt photo to an expense (JPEG, PNG or WebP; private storage, malware-scanned). */
export function ReceiptUpload({ expenseId }: { expenseId: string }) {
  const t = useTranslations("spending.receipts");
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
      await liveUpload(`/petty-cash/expenses/${expenseId}/receipts`, file, receiptResponseSchema);
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
      <label htmlFor="receipt-file" className="block text-sm font-medium">
        {t("add")}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={input}
          id="receipt-file"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          capture="environment"
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
      <p className="text-xs text-muted-foreground">{t("hint")}</p>
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
