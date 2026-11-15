import { StatusBadge, type Tone } from "@/components/status-badge";

/** A badge holding a sentence: it wraps instead of overflowing small screens. */
export function SentenceBadge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <StatusBadge tone={tone} className="h-auto max-w-full text-left break-words whitespace-normal">
      {children}
    </StatusBadge>
  );
}
