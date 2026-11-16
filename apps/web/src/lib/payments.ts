import type { Tone } from "@/components/status-badge";

/** Uncertain outcomes must never inherit the successful-payment treatment. */
export function paymentTone(status: string): Tone {
  if (status === "confirmed" || status === "processed") return "success";
  if (status === "failed") return "danger";
  if (
    [
      "unknown",
      "uncertain",
      "pending",
      "submitting",
      "quarantined",
      "open",
      "reversal_pending",
    ].includes(status)
  )
    return "warning";
  return "neutral";
}

export function wholeKesMinor(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const minor = Number(value) * 100;
  return Number.isSafeInteger(minor) ? minor : null;
}

export function paymentRoute(segments: string[] = []) {
  if (!segments.length) return { kind: "overview" as const, path: "/payments/overview" };
  if (
    segments.length === 1 &&
    ["requests", "callbacks", "cases", "settings", "new"].includes(segments[0])
  )
    return {
      kind: segments[0] as "requests" | "callbacks" | "cases" | "settings" | "new",
      path: `/payments/${segments[0]}`,
    };
  if (
    segments.length === 2 &&
    ["requests", "callbacks", "cases"].includes(segments[0]) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segments[1])
  )
    return {
      kind: `${segments[0]}Detail` as "requestsDetail" | "callbacksDetail" | "casesDetail",
      path: `/payments/${segments.join("/")}`,
    };
  return null;
}
