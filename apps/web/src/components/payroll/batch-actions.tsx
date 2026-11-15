"use client";

import { useTranslations } from "next-intl";
import type { BatchDetailResponse } from "@pm-buddy/validation";
import { PayrollAction } from "./payroll-action";

export function BatchActions({ data }: { data: BatchDetailResponse }) {
  const t = useTranslations("payrollLive");
  const path = `/payroll/batches/${data.batch.id}`;
  const body = { version: data.batch.version };
  return (
    <div className="flex flex-wrap gap-3">
      {data.permissions.canRecalculate ? (
        <PayrollAction
          label={t("recalculate")}
          path={`${path}/recalculate`}
          request="batchActionRequestSchema"
          response="batchDetailResponseSchema"
          body={body}
        />
      ) : null}
      {data.permissions.canSubmit ? (
        <PayrollAction
          label={t("submit")}
          path={`${path}/submit`}
          request="batchActionRequestSchema"
          response="batchDetailResponseSchema"
          body={body}
          disabled={data.production && data.batch.unverifiedRules}
        />
      ) : null}
      {data.permissions.canCancel ? (
        <PayrollAction
          label={t("cancelBatch")}
          path={`${path}/cancel`}
          request="cancelBatchRequestSchema"
          response="batchDetailResponseSchema"
          body={body}
          fields={[{ name: "reason", label: t("reason"), type: "textarea" }]}
        />
      ) : null}
    </div>
  );
}
