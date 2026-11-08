import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs/promises";
import { atomicWrite, installationRoot, shell } from "../src/deployment.ts";

const root = installationRoot();
await fs.mkdir(root, { recursive: true, mode: 0o700 });
await atomicWrite(
  join(root, "recovery.cjs"),
  await fs.readFile(
    fileURLToPath(new URL("../dist/recovery.cjs", import.meta.url)),
    "utf8",
  ),
);
const bin = join(process.env.CLI_PROXY_CLIENT_HOME || homedir(), ".local/bin");
await fs.mkdir(bin, { recursive: true });
for (const provider of ["codex", "claude"]) {
  const path = join(bin, `${provider}-direct`);
  await atomicWrite(
    path,
    `#!/bin/sh\nexport CLI_PROXY_CLIENT_HOME=${shell(process.env.CLI_PROXY_CLIENT_HOME || homedir())}\nexec ${shell(process.execPath)} ${shell(join(root, "recovery.cjs"))} ${provider} "$@"\n`,
  );
  await fs.chmod(path, 0o700);
  console.log(`Direct recovery launcher: ${path}`);
}

// Optional, explicit integration with an existing T3 settings file. T3 watches
// this file, so no server restart or existing-session changes are needed.
const settingsPath = process.argv
  .find((arg) => arg.startsWith("--t3-settings="))
  ?.slice("--t3-settings=".length);
if (settingsPath) {
  const original = await fs.readFile(settingsPath, "utf8");
  const settings = JSON.parse(original);
  if (
    !settings.providerInstances?.codex ||
    !settings.providerInstances?.claudeAgent
  )
    throw new Error("Expected existing Codex and Claude T3 instances");
  await atomicWrite(`${settingsPath}.before-direct-${Date.now()}`, original);
  if (process.argv.includes("--configure-proxy")) {
    const env = parseEnv(await fs.readFile(join(root, ".env"), "utf8"));
    const base = `http://127.0.0.1:${env.PORT || 8318}`;
    const home = process.env.CLI_PROXY_CLIENT_HOME || homedir();
    const helper = join(root, "client-api-key.cjs");
    const provider = `model_providers.openai_token_sharing={name="CLI Proxy",base_url=${JSON.stringify(base + "/codex/v1")},wire_api="responses",supports_websockets=true,auth={command=${JSON.stringify(helper)},timeout_ms=5000,refresh_interval_ms=300000}}`;
    const args = [
      "-c",
      'model_provider="openai_token_sharing"',
      "-c",
      provider,
      "-c",
      "features.api_key_model_discovery=true",
    ];
    const priorLauncher = await fs
      .readFile(join(root, "codex-proxy"), "utf8")
      .catch(() => "");
    for (const feature of new Set(
      (
        settings.providerInstances.codex.config.launchArgs || priorLauncher
      ).match(/features\.[A-Za-z_]+=(?:true|false)/g) || [],
    ))
      if (feature !== "features.api_key_model_discovery=true")
        args.push("-c", String(feature));
    const launcher = join(root, "codex-proxy");
    await atomicWrite(
      launcher,
      `#!/bin/sh\nexport CODEX_HOME=${shell(process.env.CODEX_HOME || join(home, ".codex"))}\nexec ${shell(join(home, ".local/bin/codex"))} ${args.map(shell).join(" ")} "$@"\n`,
    );
    await fs.chmod(launcher, 0o700);
    settings.providerInstances.codex = {
      ...settings.providerInstances.codex,
      config: {
        ...settings.providerInstances.codex.config,
        binaryPath: launcher,
        launchArgs: "",
        setupMode: "existing",
        homePath: process.env.CODEX_HOME || join(home, ".codex"),
      },
    };
    settings.providerInstances.claudeAgent = {
      ...settings.providerInstances.claudeAgent,
      config: {
        ...settings.providerInstances.claudeAgent.config,
        binaryPath: join(root, "scripts/claude-client.js"),
        homePath: process.env.CLAUDE_CONFIG_DIR || join(home, ".claude"),
      },
    };
    // The native CLI settings provide the key helper. Keep the T3 endpoint in step.
    const rows = settings.providerInstances.claudeAgent.environment || [];
    settings.providerInstances.claudeAgent.environment = rows.filter(
      (row: { name?: string }) =>
        ![
          "ANTHROPIC_BASE_URL",
          "ANTHROPIC_AUTH_TOKEN",
          "ANTHROPIC_API_KEY",
        ].includes(row.name || ""),
    );
    settings.providerInstances.claudeAgent.environment.push({
      name: "ANTHROPIC_BASE_URL",
      value: base + "/claude",
      sensitive: false,
    });
  }
  for (const [provider, driver, name] of [
    ["codex", "codex", "codexDirect"],
    ["claude", "claudeAgent", "claudeDirect"],
  ]) {
    const config = {
      ...settings.providerInstances[driver].config,
      binaryPath: join(bin, `${provider}-direct`),
    };
    if (provider === "codex") config.launchArgs = "";
    settings.providerInstances[name] = {
      driver,
      displayName: `${provider === "codex" ? "Codex" : "Claude"} (Direct recovery)`,
      enabled: true,
      config,
    };
  }
  if ((await fs.readFile(settingsPath, "utf8")) !== original)
    throw new Error("T3 settings changed during setup; retry");
  await atomicWrite(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  console.log("Added Codex and Claude direct recovery instances in T3");
}
