import { getTranslations } from "next-intl/server";
import {
  BadgeCheck,
  ClipboardList,
  Clock,
  CloudUpload,
  HardHat,
  LockKeyhole,
  NotebookPen,
  Package,
  QrCode,
  RefreshCw,
  ScanFace,
  ShieldCheck,
  Tablet,
  WifiOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { LanguageSwitcher } from "@/components/language-switcher";
import { PhoneFrame } from "@/components/phone-frame";
import { PrototypeBanner } from "@/components/prototype-banner";
import { ThemeToggle } from "@/components/theme-toggle";
import { formatTime, initials } from "@/lib/format";
import { muster } from "@/mocks/attendance";
import { labourers } from "@/mocks/labour";

export async function generateMetadata() {
  const t = await getTranslations("site");
  return { title: t("title") };
}

export default async function SiteAppPage() {
  const t = await getTranslations("site");
  // Kept consistent with the office muster roll: Peter Ndungu has not checked in, Sankale Lemayian is absent.
  const shownNames = [
    "Patrick Wekesa Simiyu",
    "Samuel Kariuki Mwangi",
    "John Otieno Ouma",
    "Stephen Kiprono Rotich",
    "Isaac Kazungu Baya",
    "Peter Ndungu Waweru",
    "Sankale Lemayian",
  ];
  const gangB = shownNames.flatMap((name) => labourers.filter((l) => l.name === name));
  const notYetName = "Peter Ndungu Waweru";
  const absentName = "Sankale Lemayian";
  const statusFor = (id: string) => muster.find((m) => m.labourerId === id);

  return (
    <div className="flex min-h-svh flex-col">
      <PrototypeBanner />
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 sm:px-8">
        <div>
          <h1 className="text-lg font-semibold">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <LanguageSwitcher />
          <ThemeToggle />
        </div>
      </header>

      <main
        id="main"
        className="flex flex-1 flex-wrap items-start justify-center gap-10 px-4 py-10"
      >
        {/* 1. Shared kiosk tablet: face check-in with bilingual prompts */}
        <PhoneFrame caption={t("captions.kiosk")}>
          <div className="flex items-center justify-between bg-primary px-4 py-3 text-primary-foreground">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Tablet className="size-4" aria-hidden /> {t("kiosk.header")}
            </div>
            <span className="rounded-full bg-white/20 px-2 py-0.5 text-[11px]">
              {t("kiosk.synced")}
            </span>
          </div>
          <div className="relative m-4 flex h-64 items-center justify-center overflow-hidden rounded-2xl bg-gradient-to-b from-zinc-700 to-zinc-900">
            <div
              className="h-44 w-36 rounded-[50%] border-4 border-dashed border-emerald-400/90"
              aria-hidden
            />
            <div
              className="absolute inset-x-6 top-1/2 h-0.5 animate-pulse bg-emerald-400/80"
              aria-hidden
            />
            <p className="absolute bottom-3 left-0 w-full text-center text-sm font-semibold text-white">
              Look at the camera · Angalia kamera
            </p>
            <p className="absolute top-3 left-0 w-full text-center text-xs text-emerald-200">
              Blink slowly · Pepesa macho polepole
            </p>
          </div>
          <div className="mx-4 flex items-center gap-3 rounded-xl border border-success/40 bg-success/10 p-3">
            <span className="flex size-11 items-center justify-center rounded-full bg-success text-sm font-bold text-white">
              SK
            </span>
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-semibold">Samuel Kariuki Mwangi</p>
              <p className="text-xs text-muted-foreground">{t("kiosk.result")}</p>
            </div>
            <BadgeCheck className="size-6 text-success" aria-hidden />
          </div>
          <div className="mt-auto grid gap-3 p-4">
            <div className="grid grid-cols-2 gap-3">
              <Button size="lg" className="h-14 text-base">
                {t("kiosk.checkIn")}
              </Button>
              <Button size="lg" variant="secondary" className="h-14 text-base">
                {t("kiosk.checkOut")}
              </Button>
            </div>
            <Button size="lg" variant="outline" className="h-12">
              <QrCode aria-hidden /> Worker card · Kadi ya mfanyakazi
            </Button>
          </div>
        </PhoneFrame>

        {/* 2. Foreman's phone: offline muster roll for the gang */}
        <PhoneFrame caption={t("captions.muster")} offline time="07:24">
          <div className="flex items-center gap-2 bg-warning px-4 py-2 text-xs font-medium text-warning-foreground">
            <WifiOff className="size-4 shrink-0" aria-hidden /> {t("muster.offline", { count: 12 })}
          </div>
          <div className="border-b px-4 py-3">
            <p className="text-base font-semibold">{t("muster.gang")}</p>
            <p className="text-xs text-muted-foreground">{t("muster.today")}</p>
            <div className="mt-2 flex gap-2 text-xs">
              <span className="rounded-full bg-success/15 px-2 py-0.5 font-medium text-success">
                {t("muster.in", { count: 5 })}
              </span>
              <span className="rounded-full bg-muted px-2 py-0.5 font-medium">
                {t("muster.notYet", { count: 1 })}
              </span>
              <span className="rounded-full bg-muted px-2 py-0.5 font-medium">
                {t("muster.absent", { count: 1 })}
              </span>
            </div>
          </div>
          <ul className="flex-1 divide-y overflow-hidden">
            {gangB.map((l) => {
              const notYet = l.name === notYetName;
              const absent = l.name === absentName;
              const record = statusFor(l.id);
              return (
                <li key={l.id} className="flex min-h-14 items-center gap-3 px-4 py-2">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold">
                    {initials(l.name)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{l.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {absent
                        ? t("muster.statusAbsent")
                        : notYet
                          ? t("muster.statusNotYet")
                          : t("muster.statusIn", {
                              time: record?.checkIn ? formatTime(record.checkIn) : "06:50",
                            })}
                    </p>
                  </div>
                  {notYet ? (
                    <Button size="sm" variant="outline" className="h-10">
                      <QrCode aria-hidden /> {t("muster.card")}
                    </Button>
                  ) : absent ? null : (
                    <ScanFace className="size-5 text-success" aria-hidden />
                  )}
                </li>
              );
            })}
          </ul>
          <nav className="grid grid-cols-4 border-t text-[11px]" aria-label={t("muster.nav")}>
            {[
              { icon: ClipboardList, label: t("tabs.muster"), active: true },
              { icon: NotebookPen, label: t("tabs.diary") },
              { icon: Package, label: t("tabs.stores") },
              { icon: RefreshCw, label: t("tabs.sync") },
            ].map((tab) => (
              <span
                key={tab.label}
                className={`flex flex-col items-center gap-1 py-2.5 ${tab.active ? "font-semibold text-primary" : "text-muted-foreground"}`}
              >
                <tab.icon className="size-5" aria-hidden />
                {tab.label}
              </span>
            ))}
          </nav>
        </PhoneFrame>

        {/* 3. Sync, clock-integrity and device status */}
        <PhoneFrame caption={t("captions.sync")} offline time="07:25">
          <div className="border-b px-4 py-3">
            <p className="text-base font-semibold">{t("sync.title")}</p>
            <p className="text-xs text-muted-foreground">
              {t("sync.lastSynced", { time: "06:58" })}
            </p>
          </div>
          <div className="flex-1 space-y-3 p-4 text-sm">
            <div className="rounded-xl border p-3">
              <p className="mb-2 flex items-center gap-2 font-semibold">
                <CloudUpload className="size-4 text-primary" aria-hidden /> {t("sync.waiting")}
              </p>
              <ul className="space-y-1.5">
                <li className="flex justify-between">
                  <span className="flex items-center gap-2">
                    <ScanFace className="size-4 text-muted-foreground" aria-hidden />{" "}
                    {t("sync.attendance")}
                  </span>
                  <span className="font-semibold tabular-nums">12</span>
                </li>
                <li className="flex justify-between">
                  <span className="flex items-center gap-2">
                    <Package className="size-4 text-muted-foreground" aria-hidden /> {t("sync.grn")}
                  </span>
                  <span className="font-semibold tabular-nums">1</span>
                </li>
                <li className="flex justify-between">
                  <span className="flex items-center gap-2">
                    <HardHat className="size-4 text-muted-foreground" aria-hidden />{" "}
                    {t("sync.photos")}
                  </span>
                  <span className="font-semibold tabular-nums">3</span>
                </li>
              </ul>
            </div>
            <div className="flex items-start gap-3 rounded-xl border p-3">
              <Clock className="mt-0.5 size-4 text-success" aria-hidden />
              <div>
                <p className="font-semibold">{t("sync.clockTitle")}</p>
                <p className="text-xs text-muted-foreground">{t("sync.clockBody")}</p>
              </div>
            </div>
            <div className="flex items-start gap-3 rounded-xl border p-3">
              <ShieldCheck className="mt-0.5 size-4 text-success" aria-hidden />
              <div>
                <p className="font-semibold">{t("sync.deviceTitle")}</p>
                <p className="text-xs text-muted-foreground">{t("sync.deviceBody")}</p>
              </div>
            </div>
            <div className="flex items-start gap-3 rounded-xl border p-3">
              <LockKeyhole className="mt-0.5 size-4 text-success" aria-hidden />
              <div>
                <p className="font-semibold">{t("sync.securityTitle")}</p>
                <p className="text-xs text-muted-foreground">{t("sync.securityBody")}</p>
              </div>
            </div>
          </div>
          <div className="p-4">
            <Button size="lg" className="h-12 w-full" disabled>
              <RefreshCw aria-hidden /> {t("sync.syncNow")}
            </Button>
            <p className="mt-2 text-center text-xs text-muted-foreground">{t("sync.autoNote")}</p>
          </div>
        </PhoneFrame>
      </main>
      <p className="px-4 pb-8 text-center text-xs text-muted-foreground">{t("footnote")}</p>
    </div>
  );
}
