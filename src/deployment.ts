// Deployment and recovery deliberately use only Node built-ins. The installed
// maintenance bundle must keep working when the application cannot load Effect.
import * as fs from "node:fs/promises";
import { appendDiagnostic, reasonCode } from "./diagnostics.ts";
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import net from "node:net";

const execute = promisify(execFile);
const units = ["cli-proxy-console.service", "cli-proxy-engine.service"];
export const installationRoot = () =>
  join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local/share"),
    "cli-proxy",
  );
const unitRoot = () =>
  join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "systemd/user",
  );
const exists = async (path: string) =>
  fs.access(path).then(
    () => true,
    () => false,
  );
const read = (path: string) => fs.readFile(path, "utf8");
const json = async <T>(path: string): Promise<T> =>
  JSON.parse(await read(path));
export async function atomicWrite(path: string, contents: string) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, contents, { mode: 0o600 });
    await fs.rename(temp, path);
  } finally {
    await fs.rm(temp, { force: true });
  }
}
export async function point(path: string, target: string) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await fs.symlink(target, temp);
    await fs.rename(temp, path);
  } finally {
    await fs.rm(temp, { force: true });
  }
}
const control = async (...args: string[]) => {
  await execute("systemctl", ["--user", ...args], { timeout: 30000 });
};
async function stopServices() {
  try {
    await control("stop", ...units);
  } catch (error) {
    const result = await execute("systemctl", [
      "--user",
      "show",
      ...units,
      "-p",
      "MainPID",
      "--value",
    ]);
    if (
      result.stdout
        .trim()
        .split(/\s+/)
        .some((pid) => Number(pid) > 0)
    )
      throw error;
  }
}
export interface Release {
  id: string;
  schemaVersion: number;
  node: string;
  engineVersion: string;
  files: Record<string, string>;
  createdAt: string;
  sourceCommit: string;
  sourceDirty?: boolean;
  buildDigest?: string;
}
interface Transaction {
  phase: "switching" | "verified" | "rolled-back" | "failed";
  candidate: string;
  previous: string | null;
  startedAt: string;
}
export async function locked<T>(
  root: string,
  work: () => Promise<T>,
): Promise<T> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const lock = join(root, ".deploy-lock");
  try {
    await fs.mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // A missing owner may be another process between mkdir and write. Never steal it.
    const owner = await json<{ pid: number }>(join(lock, "owner.json"));
    try {
      process.kill(owner.pid, 0);
      throw new Error("Another deployment is running");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
    }
    await fs.rm(lock, { recursive: true });
    await fs.mkdir(lock, { mode: 0o700 });
  }
  try {
    await atomicWrite(
      join(lock, "owner.json"),
      JSON.stringify({ pid: process.pid }),
    );
    return await work();
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}
export async function fingerprint(
  root: string,
  dir = "",
): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  for (const entry of await fs.readdir(join(root, dir), {
    withFileTypes: true,
  })) {
    if (["node_modules", "release.json", "preflight"].includes(entry.name))
      continue;
    const name = join(dir, entry.name);
    if (entry.isDirectory())
      Object.assign(entries, await fingerprint(root, name));
    else if (entry.isFile())
      entries[name] = createHash("sha256")
        .update(await fs.readFile(join(root, name)))
        .digest("hex");
    else throw new Error(`Release contains an unexpected symlink: ${name}`);
  }
  return entries;
}
export async function verifyRelease(release: string) {
  const manifest = await json<Release>(join(release, "release.json"));
  const actual = await fingerprint(release);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files))
    throw new Error("Release files changed after preparation");
  await execute(
    manifest.node,
    [
      "--input-type=module",
      "-e",
      'await import("@effect/platform-node/NodeRuntime"); await import("effect");',
    ],
    { cwd: release, timeout: 15000 },
  );
  return manifest;
}
async function freePort() {
  const server = net.createServer();
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", ok);
  });
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((ok, fail) =>
    server.close((e) => (e ? fail(e) : ok())),
  );
  return port;
}
export async function readiness(
  base: string,
  key: string,
  expected: string,
  signal?: AbortSignal,
) {
  const get = async (path: string, auth = false) => {
    const response = await fetch(`${base}${path}`, {
      headers: auth ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.any([
        AbortSignal.timeout(3000),
        ...(signal ? [signal] : []),
      ]),
    });
    if (!response.ok)
      throw new Error(`Readiness failed at ${path}: HTTP ${response.status}`);
    return response.json();
  };
  const health = await get("/healthz");
  if (health.release !== expected || health.demo)
    throw new Error("Unexpected release or demo service is answering");
  for (const path of ["/codex/v1/models", "/claude/v1/models"]) {
    const models = await get(path, true);
    if (!Array.isArray(models.data))
      throw new Error(`Invalid model response at ${path}`);
  }
}
export async function waitReady(
  check: () => Promise<void>,
  milliseconds = 30000,
  signal?: AbortSignal,
) {
  const deadline = Date.now() + milliseconds;
  let successes = 0;
  let last: unknown;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      await check();
      if (++successes === 3) return;
    } catch (e) {
      successes = 0;
      last = e;
    }
    await delay(1000, undefined, { signal });
  }
  throw new Error(
    `Service did not become stable: ${last instanceof Error ? last.message : "startup timeout"}`,
  );
}
const value = (env: Record<string, string | undefined>, name: string) => {
  if (!env[name]) throw new Error(`Missing ${name}`);
  return env[name];
};
async function management(base: string, key: string) {
  const res = await fetch(`${base}/v0/management/auth-files`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`Engine management check: HTTP ${res.status}`);
  await res.arrayBuffer();
}
// Rewrite a private copy only. Accounts and the outbox remain outside releases.
export function engineConfig(
  yaml: string,
  data: string,
  plugins: string,
  port?: number,
): string {
  let next = yaml
    .replace(
      /^auth-dir:.*$/m,
      `auth-dir: ${JSON.stringify(join(data, "auth"))}`,
    )
    .replace(/^(  dir:).*$/m, `$1 ${JSON.stringify(plugins)}`)
    .replace(
      /^(      outbox-dir:).*$/m,
      `$1 ${JSON.stringify(join(data, "usage-outbox"))}`,
    );
  if (port !== undefined) next = next.replace(/^port:.*$/m, `port: ${port}`);
  if (!/^auth-dir:/m.test(next) || !/^port:/m.test(next))
    throw new Error("Unrecognized engine configuration");
  return next;
}
export async function preflight(
  release: string,
  environment: Record<string, string | undefined>,
  signal?: AbortSignal,
) {
  const manifest = await verifyRelease(release);
  const scratch = join(release, "preflight");
  await fs.mkdir(join(scratch, "auth"), { recursive: true, mode: 0o700 });
  const ep = await freePort();
  const gp = await freePort();
  await atomicWrite(
    join(scratch, "engine.yaml"),
    engineConfig(
      await read(join(release, "engine.yaml")),
      scratch,
      join(release, "plugins"),
      ep,
    ),
  );
  const log = await fs.open(join(scratch, "startup.log"), "a", 0o600);
  const children: ReturnType<typeof spawn>[] = [];
  try {
    children.push(
      spawn(
        join(release, "cli-proxy-api"),
        ["-config", join(scratch, "engine.yaml")],
        { cwd: scratch, stdio: ["ignore", log.fd, log.fd] },
      ),
    );
    children.push(
      spawn(manifest.node, [join(release, "src/server.ts"), "--preflight"], {
        cwd: release,
        env: {
          ...process.env,
          ...environment,
          PORT: String(gp),
          ENGINE_URL: `http://127.0.0.1:${ep}`,
          DATA_DIR: scratch,
          CLI_PROXY_RELEASE: manifest.id,
        },
        stdio: ["ignore", log.fd, log.fd],
      }),
    );
    for (const child of children) child.on("error", () => {});
    await waitReady(
      async () => {
        if (children.some((c) => c.exitCode !== null || !c.pid))
          throw new Error("Candidate process exited");
        await management(
          `http://127.0.0.1:${ep}`,
          value(environment, "ENGINE_MANAGEMENT_KEY"),
        );
        await readiness(
          `http://127.0.0.1:${gp}`,
          value(environment, "PROXY_API_KEY"),
          manifest.id,
          signal,
        );
      },
      30000,
      signal,
    );
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        const exited = once(child, "exit").catch(() => {});
        child.kill("SIGKILL");
        await exited;
      }
    }
    await log.close();
  }
  const startup = await read(join(scratch, "startup.log"));
  if (!startup.includes(`CLIProxyAPI Version: ${manifest.engineVersion},`))
    throw new Error("Engine binary does not match its recorded version");
  await fs.rm(scratch, { recursive: true, force: true });
}
const quote = (s: string) =>
  `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
export function serviceUnits(root: string, node: string) {
  const current = join(root, "current");
  const data = join(root, ".local");
  const limits =
    "StartLimitIntervalSec=300\nStartLimitBurst=5\nOnFailure=cli-proxy-health.service\n";
  const service =
    "Restart=on-failure\nRestartSec=10\nSuccessExitStatus=130 143\nTimeoutStopSec=20\n\n[Install]\nWantedBy=default.target\n";
  return {
    "cli-proxy-engine.service": `[Unit]\nDescription=CLI Proxy engine\nAfter=network-online.target\n${limits}\n[Service]\nWorkingDirectory=${data.replaceAll("%", "%%")}\nExecStart=${quote(join(current, "cli-proxy-api"))} -config ${quote(join(current, "engine.yaml"))}\n${service}`,
    "cli-proxy-console.service": `[Unit]\nDescription=CLI Proxy gateway\nAfter=cli-proxy-engine.service\nWants=cli-proxy-engine.service\n${limits}\n[Service]\nWorkingDirectory=${current.replaceAll("%", "%%")}\nEnvironment=${quote(`DATA_DIR=${data}`)}\nEnvironment=${quote(`CLI_PROXY_INSTALLATION=${root}`)}\nExecStart=${quote(node)} ${quote(`--env-file=${join(root, ".env")}`)} ${quote(join(current, "src/server.ts"))}\n${service}`,
    "cli-proxy-health.service": `[Unit]\nDescription=CLI Proxy independent health and recovery\n\n[Service]\nType=oneshot\nEnvironment=${quote(`CLI_PROXY_INSTALLATION=${root}`)}\nExecStart=${quote(node)} ${quote(join(root, "maintenance.cjs"))} monitor\nTimeoutStartSec=120\n`,
    "cli-proxy-history.service": `[Unit]\nDescription=Read-only T3 usage metadata import\n\n[Service]\nType=oneshot\nEnvironment=${quote(`CLI_PROXY_INSTALLATION=${root}`)}\nExecStart=${quote(node)} ${quote(join(current, "scripts/import-history.ts"))} --month=all\nTimeoutStartSec=180\n`,
    "cli-proxy-history.timer":
      "[Unit]\nDescription=Collect T3 usage metadata without changing T3\n\n[Timer]\nOnBootSec=120\nOnUnitActiveSec=300\nUnit=cli-proxy-history.service\n\n[Install]\nWantedBy=timers.target\n",
    "cli-proxy-health.timer":
      "[Unit]\nDescription=Check CLI Proxy independently of its gateway\n\n[Timer]\nOnBootSec=90\nOnUnitActiveSec=60\nUnit=cli-proxy-health.service\n\n[Install]\nWantedBy=timers.target\n",
  };
}
export async function validateUnits(root: string, release: string) {
  const validation = join(release, "preflight");
  await fs.mkdir(validation, { recursive: true, mode: 0o700 });
  try {
    const paths: string[] = [];
    for (const [name, contents] of Object.entries(
      serviceUnits(root, process.execPath),
    )) {
      const path = join(validation, name);
      await atomicWrite(
        path,
        contents.replaceAll(join(root, "current"), release),
      );
      paths.push(path);
    }
    const validated = await execute(
      "systemd-analyze",
      ["--user", "verify", ...paths],
      {
        timeout: 15000,
        env: {
          ...process.env,
          XDG_RUNTIME_DIR:
            process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid!()}`,
        },
      },
    );
    const warnings = validated.stderr
      .split("\n")
      .filter((line) => /cli-proxy-(engine|console|health)/.test(line));
    if (warnings.length)
      throw new Error(`Unit validation warning: ${warnings.join("\n")}`);
  } finally {
    await fs.rm(validation, { recursive: true, force: true });
  }
}
async function unitBackups(root: string) {
  const backup = join(root, "unit-backup");
  await fs.mkdir(backup, { recursive: true, mode: 0o700 });
  for (const name of Object.keys(serviceUnits(root, process.execPath))) {
    const path = join(unitRoot(), name);
    await atomicWrite(
      join(backup, name + ".json"),
      JSON.stringify((await exists(path)) ? await read(path) : null),
    );
  }
}
async function restoreUnits(root: string) {
  await fs.mkdir(unitRoot(), { recursive: true });
  for (const name of Object.keys(serviceUnits(root, process.execPath))) {
    const old = await json<string | null>(
      join(root, "unit-backup", name + ".json"),
    );
    if (old === null) await fs.rm(join(unitRoot(), name), { force: true });
    else await atomicWrite(join(unitRoot(), name), old);
  }
  await control("daemon-reload");
}
async function liveReady(root: string, release: string) {
  const { parseEnv } = await import("node:util");
  const env = parseEnv(await read(join(root, ".env")));
  const m = await json<Release>(join(release, "release.json"));
  await management(
    env.ENGINE_URL || "http://127.0.0.1:8317",
    value(env, "ENGINE_MANAGEMENT_KEY"),
  );
  await readiness(
    `http://127.0.0.1:${env.PORT || 8318}`,
    value(env, "PROXY_API_KEY"),
    m.id,
  );
}
async function record(root: string, transaction: Transaction) {
  await appendDiagnostic(join(root, ".local"), "deploy", {
    kind: transaction.phase,
    release: basename(transaction.candidate),
    status: transaction.phase,
  }).catch(() => {});
  await atomicWrite(
    join(root, "deployment.json"),
    JSON.stringify(transaction, null, 2),
  );
}
export async function recover(root: string) {
  if (!(await exists(join(root, "deployment.json")))) return;
  const tx = await json<Transaction>(join(root, "deployment.json"));
  if (tx.phase !== "switching") return;
  await stopServices();
  if (tx.previous) {
    await verifyRelease(tx.previous);
    await point(join(root, "current"), tx.previous);
    await restoreUnits(root);
    await control("reset-failed", ...units);
    await control("start", ...units.toReversed());
    await waitReady(() => liveReady(root, tx.previous!));
    await record(root, { ...tx, phase: "rolled-back" });
  } else {
    // The legacy installation may already be broken. Preserve it, never label it good.
    await fs.rm(join(root, "current"), { force: true });
    await restoreUnits(root);
    await record(root, { ...tx, phase: "failed" });
    throw new Error(
      "First activation failed; no verified previous release. Services stopped; inspect incident.json and use a direct client.",
    );
  }
}
export async function deploy(source: string, signal?: AbortSignal) {
  if (process.platform !== "linux")
    throw new Error("Persistent services require Linux");
  const root = await fs.realpath(
    await fs
      .mkdir(installationRoot(), { recursive: true, mode: 0o700 })
      .then(() => installationRoot()),
  );
  return locked(root, async () => {
    await recover(root);
    const previous = await fs.realpath(join(root, "current")).catch(() => null);
    const id =
      new Date().toISOString().replaceAll(/[:.]/g, "-") +
      "-" +
      randomUUID().slice(0, 8);
    const release = join(root, "releases", id);
    await fs.mkdir(release, { recursive: true, mode: 0o700 });
    // Source, lockfile, generated files and dependencies enter a fresh directory.
    for (const name of [
      "src",
      "public",
      "scripts",
      "dist",
      "docs",
      "README.md",
      "package.json",
      "package-lock.json",
    ])
      await fs.cp(join(source, name), join(release, name), {
        recursive: true,
        dereference: true,
      });
    const data = join(root, ".local");
    await fs.mkdir(data, { recursive: true, mode: 0o700 });
    if (!(await exists(join(root, ".env"))))
      await fs.copyFile(join(source, ".env"), join(root, ".env"));
    if (!(await exists(join(data, "engine.yaml")))) {
      for (const name of [
        "auth",
        "settings.json",
        "priorities-backup.json",
        "engine.yaml",
      ])
        if (await exists(join(source, ".local", name)))
          await fs.cp(join(source, ".local", name), join(data, name), {
            recursive: true,
          });
    }
    // Stable legacy paths ARE the shared state. Never overwrite them on updates.
    await fs.chmod(join(root, ".env"), 0o600);
    const { parseEnv } = await import("node:util");
    const env = parseEnv(await read(join(root, ".env")));
    value(env, "PROXY_API_KEY");
    value(env, "ENGINE_MANAGEMENT_KEY");
    await fs.copyFile(
      join(source, ".local/cli-proxy-api"),
      join(release, "cli-proxy-api"),
    );
    await fs.chmod(join(release, "cli-proxy-api"), 0o700);
    if (await exists(join(source, ".local/plugins")))
      await fs.cp(join(source, ".local/plugins"), join(release, "plugins"), {
        recursive: true,
      });
    await atomicWrite(
      join(release, "engine.yaml"),
      engineConfig(
        await read(join(data, "engine.yaml")),
        data,
        join(release, "plugins"),
      ),
    );
    if (/^plugins:/m.test(await read(join(release, "engine.yaml")))) {
      const plugin = join(release, "plugins/cli-proxy-ledger.so");
      const meta = await json<{ sha256: string }>(
        join(release, "plugins/cli-proxy-ledger.json"),
      );
      if (
        createHash("sha256")
          .update(await fs.readFile(plugin))
          .digest("hex") !== meta.sha256
      )
        throw new Error("Engine plugin checksum mismatch");
    }
    await execute(
      "npm",
      ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: release, timeout: 180000, signal },
    );
    const { stdout: schema } = await execute(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'const {MIGRATIONS}=await import("./src/ledger.ts"); console.log(MIGRATIONS.length)',
      ],
      { cwd: release, timeout: 15000, signal },
    );
    const schemaVersion = Number(schema.trim());
    if (!Number.isInteger(schemaVersion))
      throw new Error("Invalid schema version");
    if (
      previous &&
      (await json<Release>(join(previous, "release.json"))).schemaVersion !==
        schemaVersion
    )
      throw new Error(
        "Schema change requires a separate migration plan; automatic rollback would be unsafe",
      );
    if (await exists(join(data, "accounting.sqlite"))) {
      const db = new DatabaseSync(join(data, "accounting.sqlite"), {
        readOnly: true,
      });
      try {
        const table = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name='schema_migrations'",
          )
          .get();
        const version = table
          ? Number(
              db
                .prepare(
                  "SELECT max(version) AS version FROM schema_migrations",
                )
                .get()?.version || 0,
            )
          : 0;
        if (version > schemaVersion)
          throw new Error("Installed database is newer than the candidate");
        if (previous && version !== schemaVersion)
          throw new Error(
            "Database migration requires a separate migration plan",
          );
      } finally {
        db.close();
      }
    }
    let sourceCommit = "uncommitted";
    try {
      sourceCommit = (
        await execute("git", ["rev-parse", "HEAD"], { cwd: source })
      ).stdout.trim();
    } catch {}
    const files = await fingerprint(release);
    const sourceDirty = await execute("git", ["status", "--porcelain"], {
      cwd: source,
    }).then(
      (v) => !!v.stdout.trim(),
      () => true,
    );
    const manifest: Release = {
      sourceDirty,
      buildDigest: createHash("sha256")
        .update(JSON.stringify(files))
        .digest("hex"),
      id,
      schemaVersion,
      node: process.execPath,
      engineVersion: (await read(join(source, ".local/engine-version"))).trim(),
      createdAt: new Date().toISOString(),
      sourceCommit,
      files,
    };
    await atomicWrite(
      join(release, "release.json"),
      JSON.stringify(manifest, null, 2),
    );
    await preflight(release, env, signal);
    signal?.throwIfAborted();
    if (previous) {
      await verifyRelease(previous);
      await liveReady(root, previous);
    }
    await execute("loginctl", [
      "enable-linger",
      (await import("node:os")).userInfo().username,
    ]);
    if (
      (
        await execute("loginctl", [
          "show-user",
          (await import("node:os")).userInfo().username,
          "--property=Linger",
          "--value",
        ])
      ).stdout.trim() !== "yes"
    )
      throw new Error("Boot startup could not be enabled");
    await fs.mkdir(unitRoot(), { recursive: true });
    await validateUnits(root, release);
    await unitBackups(root);
    await atomicWrite(
      join(root, "maintenance.cjs"),
      await read(join(release, "dist/maintenance.cjs")),
    );
    const tx: Transaction = {
      phase: "switching",
      candidate: release,
      previous,
      startedAt: new Date().toISOString(),
    };
    await record(root, tx);
    try {
      await stopServices();
      signal?.throwIfAborted();
      await point(join(root, "current"), release);
      for (const [name, contents] of Object.entries(
        serviceUnits(root, process.execPath),
      ))
        await atomicWrite(join(unitRoot(), name), contents);
      await control("daemon-reload");
      await control("reset-failed", ...units);
      await control(
        "enable",
        ...units.toReversed(),
        "cli-proxy-health.timer",
        "cli-proxy-history.timer",
      );
      await control("start", ...units.toReversed());
      await waitReady(() => liveReady(root, release), 30000, signal);
      if (previous) await point(join(root, "previous"), previous);
      await control(
        "start",
        "cli-proxy-health.timer",
        "cli-proxy-history.timer",
      );
      // Keep the Claude launcher path already stored by T3. Real code lives in current.
      await fs.mkdir(join(root, "scripts"), { recursive: true });
      await point(
        join(root, "scripts/claude-client.js"),
        join(root, "current/scripts/claude-client.js"),
      );
      await record(root, { ...tx, phase: "verified" });
      console.log(`Verified release ${id} at ${root}/current`);
    } catch (error) {
      await incident(root, "deployment-failed");
      await recover(root);
      throw error;
    }
  });
}
export async function incident(root: string, reason: string) {
  const tx = await json<Transaction>(join(root, "deployment.json")).catch(
    () => null,
  );
  const state = await execute("systemctl", [
    "--user",
    "show",
    ...units,
    "-p",
    "ActiveState",
    "-p",
    "NRestarts",
    "-p",
    "ExecMainStatus",
  ]).then(
    (x) => x.stdout,
    () => "unavailable",
  );
  const signature = `${reason}:${tx?.candidate}:${tx?.phase}`;
  const old = await json<{ signature: string; recoveredAt?: string }>(
    join(root, "incident.json"),
  ).catch(() => null);
  if (old?.signature === signature && !old.recoveredAt) return;
  await atomicWrite(
    join(root, "incident.json"),
    JSON.stringify(
      {
        signature,
        at: new Date().toISOString(),
        reason,
        deployment: tx,
        services: state,
      },
      null,
      2,
    ),
  );
  console.error(
    `CLI Proxy: ${reason}. See ${root}/incident.json; use codex-direct or claude-direct for recovery.`,
  );
}
export async function monitor(root: string) {
  return locked(root, async () => {
    try {
      await recover(root);
      const release = await fs.realpath(join(root, "current"));
      await liveReady(root, release);
      await appendDiagnostic(join(root, ".local"), "health", {
        kind: "heartbeat",
        release: basename(release),
        status: "ok",
      });
      const path = join(root, "incident.json");
      const old = await json<{ recoveredAt?: string }>(path).catch(() => null);
      if (old && !old.recoveredAt)
        await atomicWrite(
          path,
          JSON.stringify(
            { ...old, recoveredAt: new Date().toISOString() },
            null,
            2,
          ),
        );
    } catch (error) {
      await appendDiagnostic(join(root, ".local"), "health", {
        kind: "heartbeat",
        status: "error",
        reason: reasonCode(error),
      }).catch(() => {});
      await incident(root, "health-check-failed");
      throw error;
    }
  });
}
export async function rollback(root: string) {
  return locked(root, async () => {
    await recover(root);
    const current = await fs.realpath(join(root, "current"));
    const previous = await fs.realpath(join(root, "previous"));
    const a = await verifyRelease(current);
    const b = await verifyRelease(previous);
    if (a.schemaVersion !== b.schemaVersion)
      throw new Error("Rollback blocked by database schema compatibility");
    // Activate through the same interrupted-deployment recovery path.
    await record(root, {
      phase: "switching",
      candidate: current,
      previous,
      startedAt: new Date().toISOString(),
    });
    await unitBackups(root);
    await recover(root);
    await point(join(root, "previous"), current);
  });
}
export const shell = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
