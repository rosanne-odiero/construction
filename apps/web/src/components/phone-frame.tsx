import { BatteryMedium, Signal, Wifi, WifiOff } from "lucide-react";

export function PhoneFrame({
  children,
  caption,
  time = "07:12",
  offline = false,
}: {
  children: React.ReactNode;
  caption: string;
  time?: string;
  offline?: boolean;
}) {
  return (
    <figure className="flex flex-col items-center gap-3">
      <div className="relative h-[740px] w-[360px] rounded-[2.75rem] border-[10px] border-zinc-900 bg-zinc-900 shadow-2xl ring-1 ring-zinc-700/40">
        <div className="flex h-full w-full flex-col overflow-hidden rounded-[2.1rem] bg-background">
          <div className="flex h-8 shrink-0 items-center justify-between bg-zinc-950 px-5 text-[11px] font-medium text-white">
            <span className="tabular-nums">{time}</span>
            <span className="h-4 w-20 rounded-full bg-black" aria-hidden />
            <span className="flex items-center gap-1" aria-hidden>
              <Signal className="size-3" />
              {offline ? <WifiOff className="size-3" /> : <Wifi className="size-3" />}
              <BatteryMedium className="size-3.5" />
            </span>
          </div>
          <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        </div>
      </div>
      <figcaption className="max-w-[360px] text-center text-sm text-muted-foreground">
        {caption}
      </figcaption>
    </figure>
  );
}
