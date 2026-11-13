import { getTranslations } from "next-intl/server";
import { Info } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";

/**
 * Maker-checker explained: who prepared the record (they may not approve it), and a plainer
 * notice when the signed-in user is one of them while a decision is pending.
 */
export async function MakerChecker({
  contributors,
  userId,
  pending,
}: {
  contributors: { id: string; displayName: string }[];
  userId: string;
  pending: boolean;
}) {
  const t = await getTranslations("p2p.common");
  if (!contributors.length) return null;
  const mine = contributors.some((person) => person.id === userId);
  return (
    <Alert role="note" data-testid="maker-checker">
      <Info aria-hidden />
      <AlertDescription>
        {pending && mine
          ? t("youContributed")
          : t("contributors", {
              names: contributors.map((person) => person.displayName).join(", "),
            })}
      </AlertDescription>
    </Alert>
  );
}
