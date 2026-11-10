/**
 * A short, human-readable reason for logs and health reports. Node's dual-stack connection
 * failures are AggregateErrors with an empty message, so fall back to the errno code.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as NodeJS.ErrnoException).code;
  return error.message || code || error.name;
}
