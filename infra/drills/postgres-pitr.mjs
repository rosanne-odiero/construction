import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

// No URLs, credentials, existing volumes or Compose projects are accepted by this drill.
const prefix = `pmb-pitr-${randomUUID()}`;
const source = `${prefix}-source`;
const restored = `${prefix}-restore`;
const volumes = ["source", "archive", "backup", "restore"].map((name) => `${prefix}-${name}`);
const image = "postgres:18.6-alpine";
const containers = [];
const createdVolumes = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const sql = (container, query) =>
  docker(
    "exec",
    "--user",
    "postgres",
    container,
    "psql",
    "-XAt",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "postgres",
    "-c",
    query,
  );

async function waitFor(label, check) {
  const deadline = performance.now() + 90_000;
  while (performance.now() < deadline) {
    if (check()) return;
    await pause(500);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function start(name, mounts, command) {
  // Register before creation so cleanup also covers a client timeout after Docker accepted it.
  containers.push(name);
  return docker(
    "run",
    "--detach",
    "--name",
    name,
    "--network",
    "none",
    "--env",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    ...mounts.flatMap(([volume, target, readonly]) => [
      "--mount",
      `type=volume,source=${volume},target=${target}${readonly ? ",readonly" : ""}`,
    ]),
    "--entrypoint",
    "sh",
    image,
    "-ec",
    command,
  );
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== "--synthetic-only") {
    throw new Error("Usage: node infra/drills/postgres-pitr.mjs --synthetic-only");
  }
  const started = performance.now();
  let report;
  try {
    for (const volume of volumes) {
      createdVolumes.push(volume);
      docker("volume", "create", "--label", `pmb.drill=${prefix}`, volume);
    }
    start(
      source,
      [
        [volumes[0], "/var/lib/postgresql"],
        [volumes[1], "/archive"],
        [volumes[2], "/backup"],
      ],
      `mkdir -p /archive /backup; chown postgres:postgres /archive /backup;
      exec docker-entrypoint.sh postgres -c wal_level=replica -c archive_mode=on -c 'archive_command=test ! -f /archive/%f && cp %p /archive/%f'`,
    );
    await waitFor(
      "source database",
      () =>
        docker(
          "exec",
          source,
          "sh",
          "-c",
          "pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && echo ready || true",
        ) === "ready",
    );
    sql(
      source,
      `CREATE TABLE recovery_evidence (marker text PRIMARY KEY);
      INSERT INTO recovery_evidence VALUES ('base-backup');`,
    );
    docker(
      "exec",
      "--user",
      "postgres",
      source,
      "pg_basebackup",
      "-h",
      "127.0.0.1",
      "-U",
      "postgres",
      "-D",
      "/backup/base",
      "-X",
      "stream",
      "--checkpoint=fast",
    );
    docker("exec", "--user", "postgres", source, "pg_verifybackup", "/backup/base");
    sql(source, "INSERT INTO recovery_evidence VALUES ('acknowledged-before-target')");
    sql(source, `SELECT pg_create_restore_point('d9_recovery_target')`);
    sql(source, "INSERT INTO recovery_evidence VALUES ('must-not-survive-target')");
    const wal = sql(source, "SELECT pg_walfile_name(pg_current_wal_insert_lsn())");
    sql(source, "SELECT pg_switch_wal()");
    await waitFor(
      "archived WAL containing the target",
      () =>
        docker("exec", source, "sh", "-c", `test -s /archive/${wal} && echo archived || true`) ===
        "archived",
    );
    // Measure recovery separately from backup preparation, without stopping any existing service.
    const recoveryStarted = performance.now();
    start(
      restored,
      [
        [volumes[3], "/var/lib/postgresql"],
        [volumes[1], "/archive", true],
        [volumes[2], "/backup", true],
      ],
      `mkdir -p "$PGDATA"; cp -a /backup/base/. "$PGDATA/";
      touch "$PGDATA/recovery.signal"; chown -R postgres:postgres "$PGDATA";
      exec docker-entrypoint.sh postgres -c 'restore_command=cp /archive/%f %p' -c recovery_target_name=d9_recovery_target -c recovery_target_action=promote`,
    );
    await waitFor(
      "restored database",
      () =>
        docker(
          "exec",
          restored,
          "sh",
          "-c",
          "pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && echo ready || true",
        ) === "ready",
    );
    await waitFor("recovery promotion", () => sql(restored, "SELECT pg_is_in_recovery()") === "f");
    const markers = sql(restored, "SELECT marker FROM recovery_evidence ORDER BY marker");
    if (markers !== "acknowledged-before-target\nbase-backup") {
      throw new Error(`PITR marker verification failed: ${markers}`);
    }
    const recoverySeconds = (performance.now() - recoveryStarted) / 1000;
    if (recoverySeconds > 4 * 3600) throw new Error("Recovery exceeded the proposed four-hour RTO");
    report = {
      drill: "synthetic-postgresql-pitr",
      executedAt: new Date().toISOString(),
      image,
      result: "passed",
      checks: {
        baseBackupRestored: true,
        baseBackupManifestVerified: true,
        acknowledgedWalRecovered: true,
        postTargetWriteExcluded: true,
        promoted: true,
      },
      recoverySeconds: Math.round(recoverySeconds * 100) / 100,
      totalSeconds: Math.round((performance.now() - started) / 10) / 100,
      limitations: [
        "Synthetic database only; not application, object, configuration or key recovery",
        "No production backup freshness, retention, offsite durability or achieved RPO claim",
      ],
    };
  } finally {
    const failures = [];
    for (const container of containers.reverse()) {
      try {
        docker("rm", "--force", "--volumes", container);
      } catch (error) {
        failures.push(new Error(`Cleanup failed for container ${container}`, { cause: error }));
      }
    }
    for (const volume of createdVolumes.reverse()) {
      try {
        docker("volume", "rm", volume);
      } catch (error) {
        failures.push(new Error(`Cleanup failed for volume ${volume}`, { cause: error }));
      }
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        "Drill cleanup failed; remove only the listed drill resources",
      );
  }
  console.log(JSON.stringify(report, null, 2));
}

await main();
