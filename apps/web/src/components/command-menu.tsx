"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Building, HardHat, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { navGroups } from "@/components/nav-config";
import { labourers } from "@/mocks/labour";
import { projects } from "@/mocks/projects";

export function CommandMenu() {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const t = useTranslations("command");
  const tNav = useTranslations("nav");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  return (
    <>
      <Button
        variant="outline"
        className="h-8 w-full justify-start gap-2 text-muted-foreground sm:w-56 md:w-64"
        onClick={() => setOpen(true)}
      >
        <Search className="size-4" aria-hidden />
        <span className="truncate">{t("placeholder")}</span>
        <Kbd className="ml-auto hidden sm:inline-flex">⌘K</Kbd>
      </Button>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title={t("title")}
        description={t("placeholder")}
      >
        <CommandInput placeholder={t("placeholder")} />
        <CommandList>
          <CommandEmpty>{t("empty")}</CommandEmpty>
          <CommandGroup heading={t("pages")}>
            {navGroups
              .flatMap((g) => g.items)
              .map((item) => (
                <CommandItem key={item.key} onSelect={() => go(item.href)}>
                  <item.icon aria-hidden />
                  {tNav(`items.${item.key}`)}
                </CommandItem>
              ))}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading={t("projects")}>
            {projects.map((p) => (
              <CommandItem
                key={p.id}
                value={p.name}
                onSelect={() => go(`/prototype/projects/${p.id}`)}
              >
                <Building aria-hidden />
                {p.name}
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading={t("workers")}>
            {labourers.map((l) => (
              <CommandItem
                key={l.id}
                value={`${l.name} ${l.workerNo}`}
                onSelect={() => go(`/labour?worker=${l.id}`)}
              >
                <HardHat aria-hidden />
                <span>{l.name}</span>
                <span className="ml-auto text-xs text-muted-foreground">{l.workerNo}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}
