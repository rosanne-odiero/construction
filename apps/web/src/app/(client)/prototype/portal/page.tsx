import { getTranslations } from "next-intl/server";
import { PortalView } from "./portal-view";

export async function generateMetadata() {
  const t = await getTranslations("portal");
  return { title: t("portalName") };
}

export default function ClientPortalPage() {
  return <PortalView />;
}
