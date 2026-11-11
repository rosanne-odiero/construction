import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { labourRatesResponseSchema, labourSetupResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { ComplianceNote, localName } from "@/components/labour/labour-badges";
import { LabourNav } from "@/components/labour/labour-nav";
import {
  AddRateButton,
  AlertDaysForm,
  CancelRateButton,
  ConfigEntryButton,
  InstallDefaultsButton,
} from "@/components/labour/setup-actions";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCalendarDate, formatKES } from "@/lib/format";
import { cn } from "@/lib/utils";
import { loadLive, requireSession, serverApi } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("labourLive.setup");
  return { title: t("title") };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function LabourSetupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const projectId =
    typeof raw.projectId === "string" && UUID.test(raw.projectId) ? raw.projectId : null;
  const path = `/labour/setup${projectId ? `?projectId=${projectId}` : ""}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await loadLive("/labour/setup", labourSetupResponseSchema, path);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const setup = result.data;
  const rates = await serverApi(
    `/labour/rates${projectId ? `?projectId=${projectId}` : ""}`,
    labourRatesResponseSchema,
  );
  const t = await getTranslations("labourLive");
  const locale = await getLocale();
  const tradeName = new Map(setup.trades.map((trade) => [trade.id, localName(trade, locale)]));
  const levelName = new Map(setup.skillLevels.map((level) => [level.id, localName(level, locale)]));
  const project = setup.manageableProjects.find((entry) => entry.id === projectId) ?? null;
  const canAddRate = projectId ? project !== null : setup.canConfigure;

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={<StatusBadge tone="info">{t("live")}</StatusBadge>}
        title={t("setup.title")}
        description={t("setup.description")}
      />
      <LabourNav current="setup" />
      {!setup.canConfigure ? (
        <p className="text-sm text-muted-foreground">{t("setup.readOnly")}</p>
      ) : null}

      <section aria-labelledby="trades-heading" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="trades-heading" className="text-base font-semibold">
            {t("setup.trades")}
          </h2>
          {setup.canConfigure ? (
            <div className="flex flex-wrap gap-2">
              <InstallDefaultsButton />
              <ConfigEntryButton kind="trade" value={null} />
            </div>
          ) : null}
        </div>
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableCaption className="sr-only">{t("setup.trades")}</TableCaption>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead>{t("setup.key")}</TableHead>
                <TableHead>{t("setup.nameEn")}</TableHead>
                <TableHead>{t("setup.nameSw")}</TableHead>
                <TableHead>{t("setup.state")}</TableHead>
                {setup.canConfigure ? (
                  <TableHead className="text-right">{t("setup.actions")}</TableHead>
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {setup.trades.map((trade) => (
                <TableRow key={trade.id}>
                  <TableCell className="font-mono text-xs">{trade.key}</TableCell>
                  <TableCell lang="en">{trade.nameEn}</TableCell>
                  <TableCell lang="sw">{trade.nameSw}</TableCell>
                  <TableCell>
                    <StatusBadge tone={trade.active ? "success" : "neutral"}>
                      {trade.active ? t("setup.activeState") : t("setup.inactiveState")}
                    </StatusBadge>
                  </TableCell>
                  {setup.canConfigure ? (
                    <TableCell className="text-right">
                      <ConfigEntryButton key={trade.version} kind="trade" value={trade} />
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
              {setup.trades.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-6 text-center text-sm text-muted-foreground">
                    {t("setup.noTrades")}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      </section>

      <section aria-labelledby="skills-heading" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="skills-heading" className="text-base font-semibold">
            {t("setup.skillLevels")}
          </h2>
          {setup.canConfigure ? <ConfigEntryButton kind="skill" value={null} /> : null}
        </div>
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableCaption className="sr-only">{t("setup.skillLevels")}</TableCaption>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead>{t("setup.key")}</TableHead>
                <TableHead>{t("setup.nameEn")}</TableHead>
                <TableHead>{t("setup.nameSw")}</TableHead>
                <TableHead>{t("setup.ncaCategory")}</TableHead>
                <TableHead>{t("setup.state")}</TableHead>
                {setup.canConfigure ? (
                  <TableHead className="text-right">{t("setup.actions")}</TableHead>
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {setup.skillLevels.map((level) => (
                <TableRow key={level.id}>
                  <TableCell className="font-mono text-xs">{level.key}</TableCell>
                  <TableCell lang="en">{level.nameEn}</TableCell>
                  <TableCell lang="sw">{level.nameSw}</TableCell>
                  <TableCell className="text-sm">
                    {t(`setup.ncaCategories.${level.ncaCategory}`)}
                    {level.accreditationExpected ? (
                      <span className="block text-xs text-muted-foreground">
                        {t("setup.cardExpected")}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <StatusBadge tone={level.active ? "success" : "neutral"}>
                      {level.active ? t("setup.activeState") : t("setup.inactiveState")}
                    </StatusBadge>
                  </TableCell>
                  {setup.canConfigure ? (
                    <TableCell className="text-right">
                      <ConfigEntryButton key={level.version} kind="skill" value={level} />
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
              {setup.skillLevels.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-6 text-center text-sm text-muted-foreground">
                    {t("setup.noSkillLevels")}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      </section>

      <section aria-labelledby="alerts-setting" className="space-y-3">
        <h2 id="alerts-setting" className="text-base font-semibold">
          {t("setup.alertsTitle")}
        </h2>
        {setup.canConfigure ? (
          <AlertDaysForm settings={setup.settings} />
        ) : (
          <p className="text-sm">
            {t("setup.alertDaysValue", { days: setup.settings.accreditationAlertDays })}
          </p>
        )}
      </section>

      <section aria-labelledby="rates-heading" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="rates-heading" className="text-base font-semibold">
            {t("setup.rates.title")}
          </h2>
          {rates.ok && canAddRate ? <AddRateButton setup={setup} projectId={projectId} /> : null}
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">{t("setup.rates.description")}</p>
        <ComplianceNote>{t("setup.rates.minimumWage")}</ComplianceNote>
        {setup.manageableProjects.length ? (
          <nav aria-label={t("setup.rates.scope")} className="flex flex-wrap gap-2">
            {[
              { id: null, label: t("setup.rates.company") },
              ...setup.manageableProjects.map((entry) => ({
                id: entry.id,
                label: `${entry.code} · ${entry.name}`,
              })),
            ].map((entry) => (
              <Link
                key={entry.id ?? "company"}
                href={entry.id ? `/labour/setup?projectId=${entry.id}` : "/labour/setup"}
                aria-current={entry.id === projectId ? "page" : undefined}
                className={cn(
                  "inline-flex h-8 items-center rounded-full border px-3 text-sm",
                  entry.id === projectId
                    ? "border-primary bg-primary text-primary-foreground"
                    : "hover:bg-accent hover:text-accent-foreground",
                )}
              >
                {entry.label}
              </Link>
            ))}
          </nav>
        ) : null}
        {rates.ok ? (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableCaption className="sr-only">{t("setup.rates.title")}</TableCaption>
              <TableHeader>
                <TableRow className="bg-muted/50">
                  <TableHead>{t("setup.rates.appliesTo")}</TableHead>
                  <TableHead>{t("setup.rates.basis")}</TableHead>
                  <TableHead className="text-right">{t("setup.rates.amount")}</TableHead>
                  <TableHead>{t("setup.rates.period")}</TableHead>
                  <TableHead>{t("setup.state")}</TableHead>
                  <TableHead className="text-right">{t("setup.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rates.data.rates.map((rate) => {
                  const appliesTo = rate.labourerId
                    ? t("setup.rates.labourerRate")
                    : `${tradeName.get(rate.tradeId ?? "") ?? "—"}${
                        rate.skillLevelId ? ` · ${levelName.get(rate.skillLevelId) ?? "—"}` : ""
                      }`;
                  return (
                    <TableRow key={rate.id}>
                      <TableCell className="text-sm">
                        {appliesTo}
                        <span className="block text-xs text-muted-foreground">
                          {t(`setup.rates.scopes.${rate.scope}`)}
                        </span>
                      </TableCell>
                      <TableCell>{t(`panel.rateBases.${rate.basis}`)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatKES(rate.rateMinor)}
                      </TableCell>
                      <TableCell className="text-sm tabular-nums">
                        {formatCalendarDate(rate.effectiveFrom)} –{" "}
                        {rate.effectiveTo
                          ? formatCalendarDate(rate.effectiveTo)
                          : t("setup.rates.open")}
                      </TableCell>
                      <TableCell>
                        <StatusBadge
                          tone={rate.inForce ? "success" : rate.scheduled ? "info" : "neutral"}
                        >
                          {rate.inForce
                            ? t("setup.rates.inForce")
                            : rate.scheduled
                              ? t("setup.rates.scheduled")
                              : t("setup.rates.ended")}
                        </StatusBadge>
                      </TableCell>
                      <TableCell className="text-right">
                        {rate.scheduled && canAddRate && rate.projectId === projectId ? (
                          <CancelRateButton
                            rateId={rate.id}
                            label={`${appliesTo} · ${formatKES(rate.rateMinor)} · ${formatCalendarDate(rate.effectiveFrom)}`}
                          />
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {rates.data.rates.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="py-6 text-center text-sm text-muted-foreground"
                    >
                      {t("setup.rates.none")}
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("setup.rates.noAccess")}</p>
        )}
      </section>
    </div>
  );
}
