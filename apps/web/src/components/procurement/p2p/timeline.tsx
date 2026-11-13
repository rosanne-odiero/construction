import { getTranslations } from "next-intl/server";
import { formatDateTime } from "@/lib/format";

export type TimelineEvent = { label: string; at: string | null; by?: string | null };

/** A record's history as an ordered list (oldest first); events that did not happen are left out. */
export async function Timeline({ events }: { events: TimelineEvent[] }) {
  const t = await getTranslations("p2p.common");
  const happened = events.filter((event) => event.at);
  if (!happened.length) return null;
  return (
    <section aria-labelledby="record-history" className="space-y-2">
      <h2 id="record-history" className="text-base font-semibold">
        {t("history")}
      </h2>
      <ol className="space-y-2 border-l pl-4 text-sm">
        {happened.map((event, index) => (
          <li key={`${event.label}-${index}`} className="relative">
            <span
              className="absolute top-1.5 -left-[1.3rem] size-2 rounded-full bg-primary"
              aria-hidden
            />
            <span className="font-medium">{event.label}</span>
            <span className="block text-muted-foreground">
              {event.by
                ? t("byOn", { name: event.by, date: formatDateTime(event.at!) })
                : formatDateTime(event.at!)}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
