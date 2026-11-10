// Checks that the EN and SW catalogues have identical keys and placeholders,
// and that every ICU message compiles in both locales. Run: pnpm --filter @pm-buddy/web i18n:check
import { readFileSync } from "node:fs";
import { IntlMessageFormat } from "intl-messageformat";

const load = (locale) =>
  JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), "utf8"));

const flatten = (obj, prefix = "") =>
  Object.entries(obj).flatMap(([key, value]) =>
    typeof value === "object" ? flatten(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]],
  );

const placeholders = (message) =>
  [...new Set([...message.matchAll(/\{\s*([a-zA-Z0-9_]+)\s*[,}]/g)].map((m) => m[1]))].sort();

const catalogues = { en: new Map(flatten(load("en"))), sw: new Map(flatten(load("sw"))) };
const problems = [];

for (const key of catalogues.en.keys())
  if (!catalogues.sw.has(key)) problems.push(`missing in sw: ${key}`);
for (const key of catalogues.sw.keys())
  if (!catalogues.en.has(key)) problems.push(`missing in en: ${key}`);

for (const [key, en] of catalogues.en) {
  const sw = catalogues.sw.get(key);
  if (sw !== undefined && placeholders(en).join() !== placeholders(sw).join()) {
    problems.push(
      `placeholder mismatch: ${key} (en: ${placeholders(en)} | sw: ${placeholders(sw)})`,
    );
  }
}

for (const [locale, messages] of Object.entries(catalogues)) {
  for (const [key, message] of messages) {
    try {
      const values = Object.fromEntries(placeholders(message).map((name) => [name, 2]));
      new IntlMessageFormat(message, locale).format(values);
    } catch (error) {
      problems.push(`ICU error (${locale}) ${key}: ${error.message}`);
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`i18n OK: ${catalogues.en.size} keys in en and sw, all ICU messages compile.`);
