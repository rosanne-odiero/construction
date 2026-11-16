import { getTranslations } from "next-intl/server";
import { payrollRulesResponseSchema } from "@pm-buddy/validation";
import { MINIMUM_WAGE_AREAS, MINIMUM_WAGE_OCCUPATIONS } from "@pm-buddy/types";
import { PayrollAction } from "@/components/payroll/payroll-action";
import { PayrollShell } from "@/components/payroll/payroll-shell";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { formatCalendarDate, formatKES } from "@/lib/format";
import { loadLive, requireSession } from "@/lib/server-api";

export default async function PayrollRulesPage() {
  const path = "/payroll/rules";
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await loadLive(path, payrollRulesResponseSchema, path);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const data = result.data;
  const t = await getTranslations("payrollLive");
  return (
    <PayrollShell title={t("rules")}>
      {data.permissions.canManage ? (
        <PayrollAction
          label={t("installDefaults")}
          path="/payroll/rules/defaults"
          request="empty"
          response="payrollRulesResponseSchema"
        />
      ) : null}
      {!data.rules.length ? <p role="status">{t("none")}</p> : null}
      {data.rules.map((rule) => (
        <section
          key={rule.id}
          aria-label={`${rule.kind.toUpperCase()} ${rule.effectiveFrom}`}
          className="space-y-3 rounded-xl border p-4"
        >
          <h2 className="font-semibold">
            {rule.kind.toUpperCase()} · {formatCalendarDate(rule.effectiveFrom)} –{" "}
            {rule.effectiveTo ? formatCalendarDate(rule.effectiveTo) : t("ongoing")}
          </h2>
          <p>
            {t(`values.${rule.status}`)} · {rule.inForce ? t("inForce") : t("notInForce")}
          </p>
          <p className="whitespace-pre-wrap break-words">{rule.sourceReference}</p>
          <p>{rule.notes}</p>
          <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
            {JSON.stringify(rule.parameters, null, 2)}
          </pre>
          {rule.verifiedBy ? (
            <p>
              {rule.verifiedBy.displayName} · {rule.verificationNote}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-3">
            {data.permissions.canManage ? (
              <PayrollAction
                label={t("newVersion")}
                path="/payroll/rules"
                request="createStatutoryRuleRequestSchema"
                response="statutoryRuleResponseSchema"
                body={{ kind: rule.kind }}
                fields={[
                  {
                    name: "effectiveFrom",
                    label: t("effectiveFrom"),
                    type: "date",
                    value: data.today,
                  },
                  {
                    name: "parameters",
                    label: t("parameters"),
                    type: "json",
                    value: JSON.stringify(rule.parameters, null, 2),
                  },
                  { name: "sourceReference", label: t("source"), type: "textarea" },
                  { name: "notes", label: t("notes"), type: "textarea" },
                ]}
              />
            ) : null}
            {data.permissions.canVerify &&
            rule.status === "unverified" &&
            rule.createdBy.id !== session.user.id ? (
              <PayrollAction
                label={t("verify")}
                path={`/payroll/rules/${rule.id}/verify`}
                request="verifyStatutoryRuleRequestSchema"
                response="statutoryRuleResponseSchema"
                fields={[{ name: "note", label: t("reviewNote"), type: "textarea" }]}
              />
            ) : null}
          </div>
        </section>
      ))}
      <section className="space-y-3">
        <h2 className="font-semibold">{t("minimumWages")}</h2>
        {data.permissions.canManage ? (
          <PayrollAction
            label={t("addMinimumWage")}
            path="/payroll/minimum-wages"
            request="createMinimumWageRequestSchema"
            response="minimumWageResponseSchema"
            fields={[
              { name: "effectiveFrom", label: t("effectiveFrom"), type: "date", value: data.today },
              {
                name: "area",
                label: t("area"),
                type: "select",
                value: MINIMUM_WAGE_AREAS[0],
                options: MINIMUM_WAGE_AREAS.map((value) => ({
                  value,
                  label: t(`values.${value}`),
                })),
              },
              {
                name: "occupation",
                label: t("occupation"),
                type: "select",
                value: MINIMUM_WAGE_OCCUPATIONS[0],
                options: MINIMUM_WAGE_OCCUPATIONS.map((value) => ({
                  value,
                  label: t(`values.${value}`),
                })),
              },
              { name: "monthlyMinor", label: t("monthlyAmount"), type: "money" },
              { name: "dailyMinor", label: t("dailyAmount"), type: "money", nullable: true },
              { name: "hourlyMinor", label: t("hourlyAmount"), type: "money", nullable: true },
              { name: "source", label: t("source"), type: "textarea" },
            ]}
          />
        ) : null}
        {data.minimumWages.map((wage) => (
          <p key={wage.id}>
            {t(`values.${wage.area}`)} · {t(`values.${wage.occupation}`)} ·{" "}
            {formatCalendarDate(wage.effectiveFrom)} · {formatKES(wage.monthlyMinor)} ·{" "}
            {t(`values.${wage.status}`)}
          </p>
        ))}
      </section>
    </PayrollShell>
  );
}
