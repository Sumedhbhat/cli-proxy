import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Schema } from "effect";
import { InputError, JsonObject, record } from "../src/domain.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";

const configure = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = homedir();
  const installation = join(
    process.env.XDG_DATA_HOME || join(home, ".local/share"),
    "cli-proxy",
  );
  const baseURL = (process.argv[2] || "http://127.0.0.1:8318").replace(
    /\/$/,
    "",
  );
  const gateway = new URL(baseURL);
  if (!["http:", "https:"].includes(gateway.protocol))
    return yield* new InputError({
      status: 400,
      message: "Expected an HTTP(S) gateway URL",
    });
  // The clients send the proxy key as a bearer token; plain HTTP may only stay on this host.
  const loopback =
    gateway.hostname === "localhost" ||
    gateway.hostname === "[::1]" ||
    /^127\.\d+\.\d+\.\d+$/.test(gateway.hostname);
  if (gateway.protocol === "http:" && !loopback)
    return yield* new InputError({
      status: 400,
      message: "Use an https:// gateway URL for a remote gateway",
    });
  const deployedEnv = join(installation, ".env");
  let envPath = deployedEnv;
  if (!(yield* fs.exists(envPath)))
    envPath = fileURLToPath(new URL("../.env", import.meta.url));
  if (!parseEnv(yield* fs.readFileString(envPath)).PROXY_API_KEY)
    return yield* new InputError({
      status: 400,
      message: "The proxy API key is missing; run setup first",
    });
  yield* fs.makeDirectory(installation, { recursive: true, mode: 0o700 });
  const backup = join(
    installation,
    "client-config-backups",
    new Date().toISOString().replaceAll(":", "-"),
  );
  yield* fs.makeDirectory(backup, { recursive: true, mode: 0o700 });

  const helper = join(installation, "client-api-key.cjs");
  const helperTemplate = yield* fs.readFileString(
    fileURLToPath(new URL("../dist/client-api-key.cjs", import.meta.url)),
  );
  if (!helperTemplate.includes('"__CLI_PROXY_ENV_FILE__"'))
    return yield* new InputError({
      status: 500,
      message: "Build the credential helper with npm run build first",
    });
  yield* fs.writeFileString(
    helper,
    `#!${process.execPath}\n${helperTemplate.replaceAll('"__CLI_PROXY_ENV_FILE__"', () => JSON.stringify(envPath))}`,
    { mode: 0o700 },
  );
  yield* fs.chmod(helper, 0o700);

  const codexHome = process.env.CODEX_HOME || join(home, ".codex");
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  yield* fs.makeDirectory(codexHome, { recursive: true });
  yield* fs.makeDirectory(claudeHome, { recursive: true });
  const readAndBackup = (path: string, name: string) =>
    Effect.gen(function* () {
      const value = yield* fs
        .readFileString(path)
        .pipe(
          Effect.catchTag("PlatformError", (error) =>
            error.reason._tag === "NotFound"
              ? Effect.succeed("")
              : Effect.fail(error),
          ),
        );
      if (value) {
        yield* fs.copyFile(path, join(backup, name));
        yield* fs.chmod(join(backup, name), 0o600);
      }
      return value;
    });

  const codexPath = join(codexHome, "config.toml");
  let codex = yield* readAndBackup(codexPath, "codex-config.toml");
  const lines = codex.split("\n");
  let skipping = false;
  codex = lines
    .filter((line) => {
      if (/^\s*\[/.test(line))
        skipping =
          /^\s*\[model_providers\.cli_proxy(?:\.auth)?\]\s*(?:#.*)?$/.test(
            line,
          );
      return !skipping;
    })
    .join("\n");
  const firstSection = codex.search(/^\s*\[/m);
  let root = firstSection < 0 ? codex : codex.slice(0, firstSection);
  const sections = firstSection < 0 ? "" : codex.slice(firstSection);
  root = /^model_provider\s*=/m.test(root)
    ? root.replace(/^model_provider\s*=.*$/m, 'model_provider = "cli_proxy"')
    : `model_provider = "cli_proxy"\n${root}`;
  codex = `${root}${sections}\n\n[model_providers.cli_proxy]\nname = "CLI Proxy"\nbase_url = ${JSON.stringify(`${baseURL}/v1`)}\nwire_api = "responses"\nsupports_websockets = true\n\n[model_providers.cli_proxy.auth]\ncommand = ${JSON.stringify(helper)}\ntimeout_ms = 5000\nrefresh_interval_ms = 300000\n`;
  yield* fs.writeFileString(codexPath, codex, { mode: 0o600 });

  const claudePath = join(claudeHome, "settings.json");
  const originalClaude = yield* readAndBackup(
    claudePath,
    "claude-settings.json",
  );
  const claude: Record<string, unknown> = originalClaude
    ? {
        ...(yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(JsonObject),
        )(originalClaude)),
      }
    : {};
  const claudeEnv: Record<string, unknown> = {
    ...record(claude.env),
    ANTHROPIC_BASE_URL: baseURL,
  };
  claude.env = claudeEnv;
  // The helper supplies both authorization headers; remove conflicting static keys from this settings file.
  delete claudeEnv.ANTHROPIC_AUTH_TOKEN;
  delete claudeEnv.ANTHROPIC_API_KEY;
  claude.apiKeyHelper = JSON.stringify(helper);
  yield* fs.writeFileString(
    claudePath,
    `${JSON.stringify(claude, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(`Configured Codex and Claude Code to use ${baseURL}`);
  console.log(`Original settings backed up in ${backup}`);
  console.log(
    "Credentials are read privately from the proxy installation. Restart existing CLI sessions to apply the new settings.",
  );
});
NodeRuntime.runMain(configure.pipe(Effect.provide(NodeServices.layer)));
