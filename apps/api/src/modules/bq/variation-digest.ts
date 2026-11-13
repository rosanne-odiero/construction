import { createHash } from "node:crypto";
import { variationSnapshotText } from "@pm-buddy/domain";

/**
 * SHA-256 of the canonical proposal (packages/domain variationSnapshotText). Stored on submission;
 * approval and rejection must quote it and the server recomputes it from the stored lines and the
 * base version, so a decision always binds to exactly what was submitted (brief §15 C).
 */
export function variationDigest(input: Parameters<typeof variationSnapshotText>[0]): string {
  return createHash("sha256").update(variationSnapshotText(input)).digest("hex");
}
