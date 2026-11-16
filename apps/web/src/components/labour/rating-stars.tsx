import { Star } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Five stars for a score or a mean (rounded to whole stars). `label` is the text alternative, for
 * example "4.3 out of 5"; callers show the number as text as well, so colour is never the only cue.
 */
export function RatingStars({
  value,
  label,
  className,
}: {
  value: number;
  label: string;
  className?: string;
}) {
  const filled = Math.round(value);
  return (
    <span
      role="img"
      aria-label={label}
      className={cn("inline-flex items-center gap-0.5", className)}
    >
      {[1, 2, 3, 4, 5].map((star) => (
        <Star
          key={star}
          aria-hidden
          className={cn(
            "size-3.5",
            star <= filled ? "fill-warning text-warning" : "text-muted-foreground/40",
          )}
        />
      ))}
    </span>
  );
}
