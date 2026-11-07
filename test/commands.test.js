import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
const temporary = async (t) => {
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
    const env = {
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

async function installationFixture(t) {
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
  await writeFile(join(source, ".local/engine-version"), "8.0.23");
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
    await run(process.execPath, ["scripts/setup.ts"], { cwd: source });
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
  "service installation copies runtime artifacts and recovers stopped services after dependency installation fails",
  { timeout: 20000 },
  async (t) => {
    const { dir, source } = await installationFixture(t),
      bin = join(dir, "bin"),
      configDir = join(dir, "config"),
      dataDir = join(dir, "data");
    await mkdir(bin);
    await mkdir(join(configDir, "systemd/user"), { recursive: true });
    await writeFile(
      join(configDir, "systemd/user/cli-proxy-console.service"),
      "existing",
    );
    const log = join(dir, "commands.jsonl");
    for (const name of ["systemctl", "loginctl", "npm"]) {
      await writeFile(
        join(bin, name),
        `#!${process.execPath}\nconst fs=require('node:fs'); fs.appendFileSync(process.env.CLI_PROXY_TEST_LOG,JSON.stringify([${JSON.stringify(name)},...process.argv.slice(2)])+'\\n'); if(${JSON.stringify(name)}==='loginctl'&&process.argv.includes('show-user'))console.log('yes'); if(${JSON.stringify(name)}==='npm'&&process.env.CLI_PROXY_TEST_FAIL)process.exit(1);`,
        { mode: 0o700 },
      );
    }
    const env = {
      ...process.env,
      PATH: bin + ":" + process.env.PATH,
      XDG_DATA_HOME: dataDir,
      XDG_CONFIG_HOME: configDir,
      CLI_PROXY_TEST_LOG: log,
      CLI_PROXY_TEST_FAIL: "yes",
    };
    await assert.rejects(
      run(process.execPath, ["scripts/install-service.ts"], {
        cwd: source,
        env,
      }),
    );
    let commands = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.deepEqual(
      commands.filter((a) => a.includes("start")).map((a) => a.at(-1)),
      ["cli-proxy-engine.service", "cli-proxy-console.service"],
    );
    assert.ok(
      commands.some(
        (a) =>
          a[0] === "npm" &&
          a.includes("--omit=dev") &&
          a.includes("--ignore-scripts"),
      ),
    );
    const deployed = join(dataDir, "cli-proxy");
    await access(join(deployed, "public/app.js"));
    await access(join(deployed, "dist/client-api-key.cjs"));
    await access(join(deployed, "package-lock.json"));
    // Re-run successfully; the private deployed key must survive the update.
    await writeFile(join(deployed, ".env"), "PROXY_API_KEY=preserved\n");
    delete env.CLI_PROXY_TEST_FAIL;
    await run(process.execPath, ["scripts/install-service.ts"], {
      cwd: source,
      env,
    });
    assert.equal(
      await readFile(join(deployed, ".env"), "utf8"),
      "PROXY_API_KEY=preserved\n",
    );
    assert.equal((await stat(join(deployed, ".env"))).mode & 0o777, 0o600);
    assert.match(
      await readFile(
        join(configDir, "systemd/user/cli-proxy-console.service"),
        "utf8",
      ),
      /src\/server\.ts/,
    );
  },
);

test(
  "interrupting a pending service stop restarts the originally active unit",
  { timeout: 15000 },
  async (t) => {
    const { spawn } = await import("node:child_process");
    const { once } = await import("node:events");
    const { dir, source } = await installationFixture(t);
    const bin = join(dir, "bin"),
      configDir = join(dir, "config"),
      log = join(dir, "commands.jsonl"),
      stopped = join(dir, "stopped");
    await mkdir(bin);
    await mkdir(join(configDir, "systemd/user"), { recursive: true });
    await writeFile(
      join(configDir, "systemd/user/cli-proxy-console.service"),
      "existing",
    );
    await writeFile(
      join(bin, "loginctl"),
      `#!${process.execPath}\nif(process.argv.includes('show-user'))console.log('yes');`,
      { mode: 0o700 },
    );
    await writeFile(
      join(bin, "systemctl"),
      `#!${process.execPath}\nconst fs=require('node:fs'); const args=process.argv.slice(2); fs.appendFileSync(process.env.CLI_PROXY_TEST_LOG,JSON.stringify(args)+'\\n'); if(args.includes('stop')){ fs.writeFileSync(process.env.CLI_PROXY_TEST_STOPPED,'stopped'); setInterval(()=>{},1000); }`,
      { mode: 0o700 },
    );
    const child = spawn(process.execPath, ["scripts/install-service.ts"], {
      cwd: source,
      env: {
        ...process.env,
        PATH: bin + ":" + process.env.PATH,
        XDG_DATA_HOME: join(dir, "data"),
        XDG_CONFIG_HOME: configDir,
        CLI_PROXY_TEST_LOG: log,
        CLI_PROXY_TEST_STOPPED: stopped,
      },
      stdio: "ignore",
    });
    const exited = once(child, "exit");
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    });
    let committedStop = false;
    for (let attempts = 0; attempts < 200; attempts++) {
      try {
        await access(stopped);
        committedStop = true;
        break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(committedStop, true);
    child.kill("SIGTERM");
    const [code] = await exited;
    assert.equal(code, 130);
    const commands = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.deepEqual(
      commands
        .filter((args) => args.includes("start"))
        .map((args) => args.at(-1)),
      ["cli-proxy-console.service"],
    );
  },
);
