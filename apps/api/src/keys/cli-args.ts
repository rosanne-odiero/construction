import { z } from "zod";

export const USAGE = `Usage:
  keys:rotate status [--tenant <company ID>]
  keys:rotate rewrap --operator "<name>" [--only field|mfa] [--tenant <company ID>] [--batch <rows>] [--dry-run]`;

const argsSchema = z.object({
  command: z.enum(["status", "rewrap"]),
  operator: z.string().trim().min(2).max(100).optional(),
  only: z.enum(["field", "mfa"]).optional(),
  tenant: z.uuid().optional(),
  batch: z.coerce.number().int().min(1).max(5000).optional(),
  dryRun: z.boolean().default(false),
});

export function parseArgs(argv: readonly string[]) {
  const [command, ...rest] = argv;
  const options: Record<string, unknown> = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]!;
    if (flag === "--dry-run") options["dryRun"] = true;
    else if (["--operator", "--only", "--tenant", "--batch"].includes(flag)) {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
      options[flag.slice(2)] = value;
      index += 1;
    } else throw new Error(`Unknown option ${flag}`);
  }
  const parsed = argsSchema.parse(options);
  if (parsed.command === "rewrap" && !parsed.operator)
    throw new Error("rewrap needs --operator: the person running the rotation (recorded)");
  return parsed;
}
