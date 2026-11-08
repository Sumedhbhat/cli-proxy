// Bootstrap cannot import application packages: it must work before npm ci.
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type SetupRunner = (
  binary: string,
  args: string[],
  capture?: boolean,
) => Promise<string>;
export async function runSetup(
  source: string,
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: string;
    nodeVersion?: string;
    run?: SetupRunner;
    signal?: AbortSignal;
  } = {},
) {
  const env = { ...(options.env || process.env) };
  if ((options.platform || process.platform) !== "linux")
    throw new Error(
      "Managed setup requires Linux with systemd. No changes were made.",
    );
  if (Number((options.nodeVersion || process.versions.node).split(".")[0]) < 24)
    throw new Error("Setup requires Node.js 24 or newer.");
  const exists = (path: string) =>
    fs.access(path).then(
      () => true,
      () => false,
    );
  if (await exists(join(source, "release.json")))
    throw new Error(
      "Run setup from a development checkout, not an installed release.",
    );
  const home = homedir();
  // Follow the user's existing relocated CLI directory, without assuming /workspaces.
  const nativeBin = await fs.realpath(join(home, ".local/bin")).catch(() => "");
  const clientHome =
    env.CLI_PROXY_CLIENT_HOME ||
    (nativeBin.endsWith("/.local/bin") ? dirname(dirname(nativeBin)) : home);
  env.CLI_PROXY_CLIENT_HOME = clientHome;
  env.CODEX_HOME ||= join(clientHome, ".codex");
  env.CLAUDE_CONFIG_DIR ||= join(clientHome, ".claude");
  env.PATH = [
    dirname(process.execPath),
    join(clientHome, ".local/bin"),
    env.PATH || "",
  ].join(":");
  const installation = join(
    env.XDG_DATA_HOME || join(home, ".local/share"),
    "cli-proxy",
  );
  const t3Candidates = [
    env.CLI_PROXY_T3_SETTINGS,
    env.T3CODE_HOME && join(env.T3CODE_HOME, "userdata/settings.json"),
    join(clientHome, ".t3/userdata/settings.json"),
  ].filter((s): s is string => !!s);
  if (env.CLI_PROXY_T3_SETTINGS && !(await exists(env.CLI_PROXY_T3_SETTINGS)))
    throw new Error("CLI_PROXY_T3_SETTINGS does not exist");
  let t3: string | undefined;
  for (const path of t3Candidates)
    if (await exists(path)) {
      t3 = path;
      break;
    }
  const run: SetupRunner =
    options.run ||
    (async (binary, args, capture = false) => {
      options.signal?.throwIfAborted();
      if (capture)
        return (
          await promisify(execFile)(binary, args, {
            cwd: source,
            env,
            signal: options.signal,
            timeout: 15000,
          })
        ).stdout;
      await new Promise<void>((ok, fail) => {
        const child = spawn(binary, args, {
          cwd: source,
          env,
          stdio: "inherit",
          signal: options.signal,
        });
        let failure: Error | undefined;
        child.once("error", (error) => {
          failure = error;
        });
        // SIGTERM is handled by the installer. Wait for its rollback to finish.
        child.once("close", (code) =>
          failure
            ? fail(failure)
            : code === 0
              ? ok()
              : fail(new Error(`Command exited with status ${code}`)),
        );
      });
      return "";
    });
  const step = async (
    name: string,
    binary: string,
    args: string[],
    capture = false,
  ) => {
    console.log(`Setup: ${name}`);
    try {
      return await run(binary, args, capture);
    } catch {
      throw new Error(
        `Setup stopped at: ${name}. See the command output above. Rerun npm run setup after resolving it.`,
      );
    }
  };
  // Reject missing host prerequisites before modifying dependencies or services.
  for (const [binary, args] of [
    ["npm", ["--version"]],
    ["tar", ["--version"]],
    [env.CC?.trim().split(/\s+/)[0] || "cc", ["--version"]],
    ["systemctl", ["--user", "show-environment"]],
    ["systemd-analyze", ["--version"]],
  ] as const)
    await step(`check ${binary}`, binary, [...args], true);
  const version = (
    await step("check Go 1.26+", env.GO || "go", ["env", "GOVERSION"], true)
  ).trim();
  const go = /^go(\d+)\.(\d+)/.exec(version);
  if (!go || Number(go[1]) < 1 || (Number(go[1]) === 1 && Number(go[2]) < 26))
    throw new Error(
      "Go 1.26 or newer is required to build the ledger plugin. Set GO to its executable, then rerun npm run setup.",
    );
  const { locked } = await import("./deployment.ts");
  await locked(join(installation, "setup"), async () => {
    await step("install locked project dependencies", "npm", [
      "ci",
      "--include=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ]);
    await step("build assets and standalone recovery tools", process.execPath, [
      "scripts/build.ts",
    ]);
    // A fresh checkout on an existing host reuses its private configuration.
    for (const [target, original] of [
      [".env", ".env"],
      [".local/engine.yaml", ".local/engine.yaml"],
      [".local/settings.json", ".local/settings.json"],
    ]) {
      if (
        !(await exists(join(source, target))) &&
        (await exists(join(installation, original)))
      ) {
        await fs.mkdir(dirname(join(source, target)), {
          recursive: true,
          mode: 0o700,
        });
        await fs.copyFile(
          join(installation, original),
          join(source, target),
          constants.COPYFILE_EXCL,
        );
        await fs.chmod(join(source, target), 0o600);
      }
    }
    await step(
      "prepare verified engine and private configuration",
      process.execPath,
      ["scripts/setup-engine.ts"],
    );
    await step("build and check the matching ledger plugin", process.execPath, [
      "scripts/build-plugin.ts",
    ]);
    await step("install independent recovery clients", process.execPath, [
      "scripts/install-recovery.ts",
      ...(t3 ? [`--t3-settings=${t3}`] : []),
    ]);
    await step("deploy and verify the complete release", process.execPath, [
      "scripts/install-service.ts",
    ]);
    const { parseEnv } = await import("node:util");
    const deployed = parseEnv(
      await fs.readFile(join(installation, ".env"), "utf8"),
    );
    await step("configure coding clients", process.execPath, [
      "scripts/configure-clients.ts",
      `http://127.0.0.1:${deployed.PORT || 8318}`,
    ]);
    if (t3)
      await step("configure T3 proxy and recovery profiles", process.execPath, [
        "scripts/install-recovery.ts",
        `--t3-settings=${t3}`,
        "--configure-proxy",
      ]);
    await step("verify installed services and transport", process.execPath, [
      join(installation, "maintenance.cjs"),
      "monitor",
    ]);
    console.log(
      `Setup complete. Verified installation: ${installation}/current`,
    );
    console.log(
      "Existing keys and accounts were preserved. For a new installation, connect your provider accounts in the dashboard. Provider quota and login are separate from service health.",
    );
  });
}
