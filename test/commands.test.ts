import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const run = promisify(execFile);
const temporary = async (t: import("node:test").TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "cli-proxy-commands-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};
test(
  "client configuration preserves settings and installs a standalone private Effect credential helper",
  { timeout: 15000 },
  async (t) => {
    const dir = await temporary(t),
      home = join(dir, "user"),
      installation = join(dir, "data/cli-proxy");
    await mkdir(join(home, ".codex"), { recursive: true });
    await mkdir(join(home, ".claude"), { recursive: true });
    await mkdir(installation, { recursive: true });
    const codex = 'model = "example"\n\n[unrelated]\nvalue = true\n';
    const claude = {
      custom: true,
      env: { KEEP: "yes", ANTHROPIC_API_KEY: "old" },
    };
    await writeFile(join(home, ".codex/config.toml"), codex);
    await writeFile(
      join(home, ".claude/settings.json"),
      JSON.stringify(claude),
    );
    await writeFile(
      join(installation, ".env"),
      "PROXY_API_KEY=fixture-private-key\n",
    );
    const preload = join(dir, "home.mjs");
    await writeFile(
      preload,
      'import os from "node:os"; import {syncBuiltinESMExports} from "node:module"; os.homedir=()=>process.env.CLI_PROXY_TEST_USER; syncBuiltinESMExports();',
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      XDG_DATA_HOME: join(dir, "data"),
      CLI_PROXY_TEST_USER: home,
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
    };
    delete env.CODEX_HOME;
    await run(
      process.execPath,
      ["--import", pathToFileURL(preload).href, "scripts/configure-clients.ts"],
      { env },
    );
    const updatedCodex = await readFile(
      join(home, ".codex/config.toml"),
      "utf8",
    );
    const updatedClaude = JSON.parse(
      await readFile(join(home, ".claude/settings.json"), "utf8"),
    );
    assert.match(updatedCodex, /model_provider = "cli_proxy"/);
    assert.match(updatedCodex, /\[unrelated\]/);
    assert.equal(updatedClaude.custom, true);
    assert.equal(updatedClaude.env.KEEP, "yes");
    assert.equal(updatedClaude.env.ANTHROPIC_API_KEY, undefined);
    const helper = join(installation, "client-api-key.cjs");
    const { stdout } = await run(helper, [], { cwd: dir });
    assert.equal(stdout, "fixture-private-key");
    assert.equal((await stat(helper)).mode & 0o777, 0o700);
    assert.doesNotMatch(await readFile(helper, "utf8"), /fixture-private-key/);
    const backups = (await import("node:fs/promises")).readdir;
    const backupDir = join(
      installation,
      "client-config-backups",
      (await backups(join(installation, "client-config-backups")))[0],
    );
    assert.equal(
      await readFile(join(backupDir, "codex-config.toml"), "utf8"),
      codex,
    );
  },
);

async function installationFixture(t: import("node:test").TestContext) {
  const dir = await temporary(t),
    source = join(dir, "source");
  await mkdir(source);
  for (const path of [
    "src",
    "scripts",
    "public",
    "dist",
    "docs",
    "README.md",
    "package.json",
    "package-lock.json",
  ])
    await cp(path, join(source, path), { recursive: true });
  await symlink(
    join(process.cwd(), "node_modules"),
    join(source, "node_modules"),
    "dir",
  );
  await mkdir(join(source, ".local/auth"), { recursive: true });
  await writeFile(join(source, ".env"), "PROXY_API_KEY=fixture-key\n");
  await writeFile(join(source, ".local/engine.yaml"), 'auth-dir: "fixture"\n');
  await writeFile(join(source, ".local/engine-version"), "8.0.59");
  await writeFile(join(source, ".local/cli-proxy-api"), "#!/bin/sh\nexit 0\n", {
    mode: 0o700,
  });
  return { dir, source };
}

test(
  "setup preserves an existing offline installation",
  { timeout: 10000 },
  async (t) => {
    const { source } = await installationFixture(t);
    await run(process.execPath, ["scripts/setup-engine.ts"], { cwd: source });
    assert.equal(
      await readFile(join(source, ".env"), "utf8"),
      "PROXY_API_KEY=fixture-key\n",
    );
    assert.equal(
      await readFile(join(source, ".local/engine.yaml"), "utf8"),
      'auth-dir: "fixture"\n',
    );
  },
);

test(
  "setup adds the usage ledger to a compatible engine configuration once",
  { timeout: 10000 },
  async (t) => {
    const { source } = await installationFixture(t);
    const yaml = 'auth-dir: "fixture"\napi-keys:\n  - "fixture-key"\n';
    await writeFile(join(source, ".local/engine.yaml"), yaml);
    await run(process.execPath, ["scripts/setup-engine.ts"], { cwd: source });
    const env = await readFile(join(source, ".env"), "utf8");
    assert.match(
      env,
      /^PROXY_API_KEY=fixture-key\nLEDGER_DEVICE_SECRET=[0-9a-f]{64}\n$/,
    );
    const configured = await readFile(
      join(source, ".local/engine.yaml"),
      "utf8",
    );
    assert.ok(configured.startsWith(yaml));
    assert.match(configured, /cli-proxy-ledger:\n {6}enabled: true/);
    assert.match(configured, /outbox-dir: ".*\/\.local\/usage-outbox"/);
    // The engine key is stored only as a digest.
    assert.ok(!configured.slice(yaml.length).includes("fixture-key"));
    await run(process.execPath, ["scripts/setup-engine.ts"], { cwd: source });
    assert.equal(await readFile(join(source, ".env"), "utf8"), env);
    assert.equal(
      await readFile(join(source, ".local/engine.yaml"), "utf8"),
      configured,
    );
  },
);

test(
  "setup configures T3 proxy and recovery launchers with real argument boundaries and repeatable settings",
  { timeout: 15000 },
  async (t) => {
    const dir = await temporary(t),
      home = join(dir, "user"),
      installation = join(dir, "data/cli-proxy");
    await mkdir(join(home, ".local/bin"), { recursive: true });
    await mkdir(installation, { recursive: true });
    await writeFile(
      join(installation, ".env"),
      "PORT=9918\nPROXY_API_KEY=private-do-not-embed\n",
    );
    await writeFile(
      join(home, ".local/bin/codex"),
      `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));`,
      { mode: 0o700 },
    );
    const settingsPath = join(dir, "settings.json");
    const original = {
      providerInstances: {
        codex: {
          driver: "codex",
          enabled: true,
          config: { launchArgs: '-c "features.multi_agent=false"' },
        },
        claudeAgent: {
          driver: "claudeAgent",
          enabled: true,
          config: {},
          environment: [
            {
              name: "ANTHROPIC_BASE_URL",
              value: "http://old",
              sensitive: false,
            },
            { name: "KEEP", value: "yes", sensitive: false },
          ],
        },
      },
      unrelated: true,
    };
    await writeFile(settingsPath, JSON.stringify(original));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      XDG_DATA_HOME: join(dir, "data"),
      CLI_PROXY_CLIENT_HOME: home,
      CODEX_HOME: join(home, ".codex"),
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
    };
    let previousArgs;
    for (let attempt = 0; attempt < 2; attempt++) {
      await run(
        process.execPath,
        [
          "scripts/install-recovery.ts",
          `--t3-settings=${settingsPath}`,
          "--configure-proxy",
        ],
        { env },
      );
      const settings = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.equal(settings.unrelated, true);
      assert.equal(settings.providerInstances.codexDirect.enabled, true);
      assert.equal(settings.providerInstances.claudeDirect.enabled, true);
      assert.ok(
        settings.providerInstances.claudeAgent.environment.some(
          (row: { name: string; value: string; sensitive: boolean }) =>
            row.name === "KEEP" && row.value === "yes",
        ),
      );
      assert.ok(
        settings.providerInstances.claudeAgent.environment.some(
          (row: { name: string; value: string; sensitive: boolean }) =>
            row.name === "ANTHROPIC_BASE_URL" &&
            row.value === "http://127.0.0.1:9918/claude" &&
            row.sensitive === false,
        ),
      );
      const launcher = settings.providerInstances.codex.config.binaryPath;
      const args = JSON.parse(
        (await run(launcher, ["app-server"], { env })).stdout,
      );
      assert.ok(args.includes('model_provider="openai_token_sharing"'));
      assert.ok(
        args.some((arg: string) =>
          arg.includes('base_url="http://127.0.0.1:9918/codex/v1"'),
        ),
      );
      assert.ok(args.includes("features.multi_agent=false"));
      assert.equal(args.at(-1), "app-server");
      assert.doesNotMatch(
        await readFile(launcher, "utf8"),
        /private-do-not-embed/,
      );
      if (previousArgs) assert.deepEqual(args, previousArgs);
      previousArgs = args;
    }
  },
);

for (const validChecksum of [true, false]) {
  test(
    validChecksum
      ? "setup installs an API-downloaded engine only after verifying its checksum"
      : "setup rejects an API-downloaded engine with a bad checksum and preserves the installed binary",
    { timeout: 10000 },
    async (t) => {
      const { dir, source } = await installationFixture(t);
      await writeFile(join(source, ".local/engine-version"), "old-version");
      const payload = join(dir, "payload");
      await mkdir(payload);
      const binary = "#!/bin/sh\n# replacement engine\nexit 0\n";
      await writeFile(join(payload, "cli-proxy-api"), binary);
      const archive = join(dir, "engine.tar.gz");
      await run("tar", ["-czf", archive, "-C", payload, "cli-proxy-api"]);
      const digest = validChecksum
        ? createHash("sha256")
            .update(await readFile(archive))
            .digest("hex")
        : "0".repeat(64);
      const preload = join(dir, "download.mjs");
      await writeFile(
        preload,
        `
        import { readFileSync } from "node:fs";
        import { arch, platform } from "node:os";
        const platformName = { linux: "linux", darwin: "darwin" }[platform()];
        const architecture = { x64: "amd64", arm64: "aarch64" }[arch()];
        const name = "CLIProxyAPI_8.0.59_" + platformName + "_" + architecture + ".tar.gz";
        globalThis.fetch = async (url, options) => {
          if (url.startsWith("https://github.com/")) return new Response(null, { status: 504 });
          if (url.endsWith("/tags/v8.0.59")) return Response.json({ assets: [{ name, id: 123 }, { name: "checksums.txt", id: 456 }] });
          if (new Headers(options.headers).get("accept") !== "application/octet-stream") throw new Error("Expected asset download");
          if (url.endsWith("/assets/123")) return new Response(readFileSync(process.env.CLI_PROXY_TEST_ARCHIVE));
          if (url.endsWith("/assets/456")) return new Response(process.env.CLI_PROXY_TEST_DIGEST + "  " + name + "\\n");
          throw new Error("Unexpected download URL: " + url);
        };
      `,
      );
      const setup = () =>
        run(
          process.execPath,
          ["--import", pathToFileURL(preload).href, "scripts/setup-engine.ts"],
          {
            cwd: source,
            env: {
              ...process.env,
              CLI_PROXY_TEST_ARCHIVE: archive,
              CLI_PROXY_TEST_DIGEST: digest,
            },
          },
        );
      if (validChecksum) {
        await setup();
        assert.equal(
          await readFile(join(source, ".local/cli-proxy-api"), "utf8"),
          binary,
        );
        assert.equal(
          await readFile(join(source, ".local/engine-version"), "utf8"),
          "8.0.59",
        );
        assert.equal(
          (await stat(join(source, ".local/cli-proxy-api"))).mode & 0o777,
          0o700,
        );
      } else {
        await assert.rejects(setup, (error) => {
          assert.match(
            error instanceof Error && "stdout" in error && "stderr" in error
              ? String(error.stdout) + String(error.stderr)
              : String(error),
            /Engine checksum verification failed/,
          );
          return true;
        });
        assert.equal(
          await readFile(join(source, ".local/cli-proxy-api"), "utf8"),
          "#!/bin/sh\nexit 0\n",
        );
        assert.equal(
          await readFile(join(source, ".local/engine-version"), "utf8"),
          "old-version",
        );
      }
      assert.equal(
        await readFile(join(source, ".env"), "utf8"),
        "PROXY_API_KEY=fixture-key\n",
      );
    },
  );
}
