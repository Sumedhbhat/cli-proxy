import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem } from "effect";
import { command } from "../src/command.ts";
import { InputError } from "../src/domain.ts";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Keep the running installation independent of a checkout or a T3 session.
const source = fileURLToPath(new URL("../", import.meta.url));
const destination = join(
  process.env.XDG_DATA_HOME || join(homedir(), ".local/share"),
  "cli-proxy",
);
const unitDir = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "systemd/user",
);
const dataDir = join(destination, ".local");
const systemctl = (args: ReadonlyArray<string>) =>
  command("systemctl", ["--user", ...args]);
const quote = (value: string) =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
const install = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const exists = fs.exists;

  if (process.platform !== "linux")
    return yield* new InputError({
      status: 400,
      message: "Persistent services require Linux with systemd user services.",
    });
  yield* fs.access(join(source, ".env"));
  yield* fs.access(join(source, ".local/cli-proxy-api"));
  yield* command("systemctl", ["--user", "show-environment"], { quiet: true });
  // Start this user's service manager at boot, including while the desktop is signed out.
  yield* command("loginctl", ["enable-linger", userInfo().username]);
  const lingering = (yield* command(
    "loginctl",
    ["show-user", userInfo().username, "--property=Linger", "--value"],
    { capture: true },
  )).trim();
  if (lingering !== "yes")
    return yield* new InputError({
      status: 500,
      message: "Could not enable startup before desktop sign-in",
    });
  yield* fs.makeDirectory(destination, { recursive: true, mode: 0o700 });
  yield* fs.makeDirectory(dataDir, { recursive: true, mode: 0o700 });
  yield* fs.makeDirectory(unitDir, { recursive: true });

  const consoleUnit = join(unitDir, "cli-proxy-console.service");
  const engineUnit = join(unitDir, "cli-proxy-engine.service");
  const updating = yield* exists(consoleUnit);
  const stopped: string[] = [];
  let installed = false;
  // Finalizers run on failure AND interruption, before NodeRuntime exits.
  yield* Effect.addFinalizer(() =>
    installed
      ? Effect.void
      : Effect.forEach(
          stopped.toReversed(),
          (unit) =>
            systemctl(["start", unit]).pipe(
              Effect.catch(() =>
                Effect.sync(() =>
                  console.error(
                    `Could not restart ${unit}; start it with systemctl --user start ${unit}`,
                  ),
                ),
              ),
            ),
          { discard: true },
        ),
  );

  if (updating) {
    for (const unit of [
      "cli-proxy-console.service",
      "cli-proxy-engine.service",
    ]) {
      const active = yield* command(
        "systemctl",
        ["--user", "is-active", "--quiet", unit],
        { quiet: true },
      ).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      );
      if (active) {
        stopped.push(unit);
        yield* systemctl(["stop", unit]);
      }
    }
  }

  if (resolve(source) !== resolve(destination)) {
    for (const path of [
      "src",
      "public",
      "dist",
      "scripts",
      "docs",
      "README.md",
      "package.json",
      "package-lock.json",
    ])
      yield* fs.copy(join(source, path), join(destination, path));
    // Preserve the deployed credentials and keys when installing a UI update.
    if (!(yield* exists(join(destination, ".env"))))
      yield* fs.copy(join(source, ".env"), join(destination, ".env"));
    if (!(yield* exists(join(dataDir, "engine.yaml")))) {
      const original = yield* fs.readFileString(
        join(source, ".local/engine.yaml"),
      );
      if (!/^auth-dir:/m.test(original))
        return yield* new InputError({
          status: 400,
          message: "Expected legacy auth-dir setting in engine configuration",
        });
      yield* fs.writeFileString(
        join(dataDir, "engine.yaml"),
        original.replace(
          /^auth-dir:.*$/m,
          `auth-dir: ${JSON.stringify(join(dataDir, "auth"))}`,
        ),
        { mode: 0o600 },
      );
      for (const path of ["auth", "settings.json", "priorities-backup.json"]) {
        if (yield* exists(join(source, ".local", path)))
          yield* fs.copy(join(source, ".local", path), join(dataDir, path));
      }
    }
    for (const path of ["cli-proxy-api", "engine-version"])
      yield* fs.copy(join(source, ".local", path), join(dataDir, path));
  }
  // Runtime dependencies are installed from the reviewed lockfile; no install scripts run.
  yield* command(
    "npm",
    ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: destination },
  );
  yield* fs.chmod(join(destination, ".env"), 0o600);
  yield* fs.chmod(join(dataDir, "engine.yaml"), 0o600);
  yield* fs.chmod(join(dataDir, "cli-proxy-api"), 0o700);

  const common =
    "Restart=always\nRestartSec=3\nTimeoutStopSec=15\n\n[Install]\nWantedBy=default.target\n";
  yield* fs.writeFileString(
    engineUnit,
    `[Unit]\nDescription=CLI Proxy authentication and inference engine\nAfter=network-online.target\n\n[Service]\nWorkingDirectory=${dataDir.replaceAll("%", "%%")}\nExecStart=${quote(join(dataDir, "cli-proxy-api"))} -config ${quote(join(dataDir, "engine.yaml"))}\n${common}`,
  );
  yield* fs.writeFileString(
    consoleUnit,
    `[Unit]\nDescription=CLI Proxy console and quota scheduler\nAfter=cli-proxy-engine.service\nWants=cli-proxy-engine.service\n\n[Service]\nWorkingDirectory=${destination.replaceAll("%", "%%")}\nExecStart=${quote(process.execPath)} ${quote(`--env-file=${join(destination, ".env")}`)} ${quote(join(destination, "src/server.ts"))}\n${common}`,
  );
  yield* systemctl(["daemon-reload"]);
  yield* systemctl([
    "enable",
    "--now",
    "cli-proxy-engine.service",
    "cli-proxy-console.service",
  ]);
  installed = true;
  console.log(`Persistent installation: ${destination}`);
  console.log(
    "Services: cli-proxy-engine.service and cli-proxy-console.service",
  );
  console.log(
    "Startup before desktop sign-in is enabled (systemd user lingering).",
  );
});
NodeRuntime.runMain(
  install.pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
