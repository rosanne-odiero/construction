"use client";

import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

/** Button for actions that are designed but not built yet: tells the reviewer which deliverable builds it. */
export function PrototypeAction({
  children,
  deliverable,
  variant = "outline",
  size = "default",
  className,
}: {
  children: React.ReactNode;
  deliverable: string;
  variant?: React.ComponentProps<typeof Button>["variant"];
  size?: React.ComponentProps<typeof Button>["size"];
  className?: string;
}) {
  const t = useTranslations("prototype");
  return (
    <Button
      variant={variant}
      size={size}
      className={className}
      onClick={() => toast.info(t("actionToast", { deliverable }))}
    >
      {children}
    </Button>
  );
}
