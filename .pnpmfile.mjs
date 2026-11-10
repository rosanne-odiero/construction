// Keeps pnpm-lock.yaml registry-agnostic. When dependencies are resolved through a registry
// mirror (for example a corporate npm proxy), pnpm records the mirror's tarball URL for every
// package, and CI or other contributors then cannot install. A URL that is just the standard
// "<registry>/<name>/-/<name>-<version>.tgz" path carries no information, so drop it: pnpm then
// downloads from whichever registry is configured. Other tarball URLs are kept.

function standardTarballSuffix(depPath) {
  const at = depPath.indexOf("@", 1);
  if (at === -1) return null;
  const name = depPath.slice(0, at);
  const version = depPath.slice(at + 1).replace(/\(.*$/, "");
  return `/${name}/-/${name.split("/").pop()}-${version}.tgz`;
}

function afterAllResolved(lockfile, context) {
  let removed = 0;
  for (const [depPath, pkg] of Object.entries(lockfile.packages ?? {})) {
    const tarball = pkg.resolution?.tarball;
    const suffix = standardTarballSuffix(depPath);
    if (typeof tarball !== "string" || !suffix) continue;
    if (decodeURIComponent(new URL(tarball).pathname).endsWith(suffix)) {
      delete pkg.resolution.tarball;
      removed += 1;
    }
  }
  if (removed > 0)
    context.log(`Removed ${removed} registry-specific tarball URLs from the lockfile`);
  return lockfile;
}

export const hooks = { afterAllResolved };
