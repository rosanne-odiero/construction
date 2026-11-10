// Keeps pnpm-lock.yaml registry-agnostic and on strong hashes when dependencies are resolved
// through a registry mirror (for example a corporate npm proxy). Such mirrors cause two problems:
//
// 1. pnpm records the mirror's tarball URL for every package, so CI and other contributors cannot
//    install. A URL that is just the standard "<registry>/<name>/-/<name>-<version>.tgz" path
//    carries no information, so it is dropped: pnpm then downloads from the configured registry.
// 2. Some mirrors only publish sha1 checksums, so every re-resolution downgrades the lockfile from
//    sha512 to sha1. A published npm version is immutable, so a sha512 already in the lockfile for
//    the same name@version is kept. For new packages the tarball is downloaded once, checked
//    against the sha1 the registry reported, and its sha512 recorded instead.
//
// pnpm still verifies every download against the recorded hash, so a wrong value fails the
// install rather than being trusted.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const LOCKFILE = new URL("./pnpm-lock.yaml", import.meta.url);

function standardTarballSuffix(depPath) {
  const at = depPath.indexOf("@", 1);
  if (at === -1) return null;
  const name = depPath.slice(0, at);
  const version = depPath.slice(at + 1).replace(/\(.*$/, "");
  return `/${name}/-/${name.split("/").pop()}-${version}.tgz`;
}

/** name@version → sha512 integrity from the lockfile currently on disk. */
function existingSha512() {
  const known = new Map();
  let text;
  try {
    text = readFileSync(LOCKFILE, "utf8");
  } catch {
    return known;
  }
  let inPackages = false;
  let key = null;
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) {
      inPackages = line.startsWith("packages:");
      key = null;
      continue;
    }
    if (!inPackages) continue;
    const keyMatch = /^ {2}'?(.+?)'?:$/.exec(line);
    if (keyMatch) {
      key = keyMatch[1];
      continue;
    }
    const integrity = /^ {4}resolution: \{integrity: (sha512-[A-Za-z0-9+/=]+)/.exec(line);
    if (integrity && key) known.set(key, integrity[1]);
  }
  return known;
}

async function sha512FromTarball(url, expectedSha1) {
  // Registry proxies sometimes reject bursts of parallel requests, so retry with backoff.
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const sha1 = `sha1-${createHash("sha1").update(bytes).digest("base64")}`;
      if (sha1 !== expectedSha1) throw new Error(`sha1 mismatch (${sha1})`);
      return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    } catch (error) {
      if (attempt >= 4 || error.message.startsWith("sha1 mismatch")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
}

async function afterAllResolved(lockfile, context) {
  const packages = Object.entries(lockfile.packages ?? {});
  const known = existingSha512();
  const toDownload = [];
  let reused = 0;

  for (const [depPath, pkg] of packages) {
    const integrity = pkg.resolution?.integrity;
    if (typeof integrity !== "string" || !integrity.startsWith("sha1-")) continue;
    const previous = known.get(depPath);
    if (previous) {
      pkg.resolution.integrity = previous;
      reused += 1;
    } else if (typeof pkg.resolution.tarball === "string") {
      toDownload.push([depPath, pkg]);
    }
  }

  const failures = [];
  const queue = [...toDownload];
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const [depPath, pkg] = item;
      try {
        pkg.resolution.integrity = await sha512FromTarball(
          pkg.resolution.tarball,
          pkg.resolution.integrity,
        );
      } catch (error) {
        failures.push(`${depPath}: ${error.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));

  let removed = 0;
  for (const [depPath, pkg] of packages) {
    const tarball = pkg.resolution?.tarball;
    const suffix = standardTarballSuffix(depPath);
    if (typeof tarball !== "string" || !suffix) continue;
    if (decodeURIComponent(new URL(tarball).pathname).endsWith(suffix)) {
      delete pkg.resolution.tarball;
      removed += 1;
    }
  }

  if (reused + toDownload.length > 0) {
    context.log(
      `Kept sha512 for ${reused} packages; computed it for ${toDownload.length - failures.length} new ones`,
    );
  }
  for (const failure of failures) context.log(`Kept sha1 (could not verify): ${failure}`);
  if (removed > 0) context.log(`Removed ${removed} registry-specific tarball URLs`);
  return lockfile;
}

export const hooks = { afterAllResolved };
