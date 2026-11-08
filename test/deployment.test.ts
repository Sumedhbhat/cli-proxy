import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import {
  atomicWrite,
  point,
  locked,
  fingerprint,
  verifyRelease,
  readiness,
  recover,
  serviceUnits,
  engineConfig,
  validateUnits,
} from "../src/deployment.ts";
import { directInvocation } from "../scripts/recovery.ts";

const exec = promisify(execFile);
async function fixture(t: { after: (f: () => Promise<unknown>) => void }) {
  const root = await fs.mkdtemp(join(tmpdir(), "proxy-release-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return fs.realpath(root);
}
test("deployment lock refuses concurrency, clears on failure, and recovers a dead owner", async (t) => {
  const root = await fixture(t);
  await locked(root, async () => {
    await assert.rejects(
      locked(root, async () => {}),
      /Another deployment/,
    );
  });
  await assert.rejects(
    locked(root, async () => {
      throw new Error("injected");
    }),
    /injected/,
  );
  await fs.mkdir(join(root, ".deploy-lock"));
  await fs.writeFile(
    join(root, ".deploy-lock/owner.json"),
    JSON.stringify({ pid: 2147483647 }),
  );
  await locked(root, async () => {});
});
test("atomic pointer switches retain both releases and reject modified artifacts", async (t) => {
  const root = await fixture(t);
  for (const name of ["a", "b"]) {
    const release = join(root, name);
    await fs.mkdir(release);
    await fs.writeFile(join(release, "package.json"), '{"type":"module"}');
    await fs.writeFile(join(release, "app.txt"), name);
    await fs.symlink(
      join(process.cwd(), "node_modules"),
      join(release, "node_modules"),
    );
    await atomicWrite(
      join(release, "release.json"),
      JSON.stringify({
        id: name,
        node: process.execPath,
        files: await fingerprint(release),
      }),
    );
  }
  await point(join(root, "current"), join(root, "a"));
  await point(join(root, "current"), join(root, "b"));
  assert.equal(await fs.readFile(join(root, "a/app.txt"), "utf8"), "a");
  await verifyRelease(join(root, "b"));
  await fs.writeFile(join(root, "b/app.txt"), "broken");
  await assert.rejects(verifyRelease(join(root, "b")), /changed/);
  await fs.rm(join(root, "a/node_modules"));
  await assert.rejects(verifyRelease(join(root, "a")), /Command failed/);
});
test("readiness rejects demo, wrong release, unauthenticated and malformed transport", async (t) => {
  let mode = "good";
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/healthz")
      res.end(
        JSON.stringify({
          release: mode === "wrong" ? "old" : "new",
          demo: mode === "demo",
        }),
      );
    else if (
      mode === "unauthorized" ||
      req.headers.authorization !== "Bearer private"
    ) {
      res.writeHead(401);
      res.end("{}");
    } else res.end(JSON.stringify(mode === "malformed" ? {} : { data: [] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await readiness(base, "private", "new");
  for (mode of ["wrong", "demo", "unauthorized", "malformed"])
    await assert.rejects(readiness(base, "private", "new"));
});
test("engine copy moves auth and outbox paths without changing secrets or source", () => {
  const yaml =
    'port: 8317\nauth-dir: "old"\nplugins:\n  dir: "old"\n      outbox-dir: "old"\n      device-secret: "secret"\n';
  const next = engineConfig(yaml, "/shared", "/release/plugins", 9187);
  assert.match(next, /port: 9187/);
  assert.match(next, /auth-dir: "\/shared\/auth"/);
  assert.match(next, /outbox-dir: "\/shared\/usage-outbox"/);
  assert.match(next, /device-secret: "secret"/);
  assert.match(yaml, /auth-dir: "old"/);
});
test("bounded units and standalone recovery never depend on proxy credentials", () => {
  const units = serviceUnits("/tmp/installed", "/bin/node");
  assert.match(units["cli-proxy-console.service"], /StartLimitBurst=5/);
  assert.match(units["cli-proxy-console.service"], /DATA_DIR=/);
  assert.match(units["cli-proxy-health.service"], /maintenance.cjs/);
  for (const provider of ["codex", "claude"]) {
    const call = directInvocation(provider, ["--help"], {
      ANTHROPIC_AUTH_TOKEN: "private",
      ANTHROPIC_BASE_URL: "http://proxy",
      OPENAI_BASE_URL: "http://proxy",
      OPENAI_API_KEY: "private",
      CLI_PROXY_CLIENT_HOME: "/test",
    });
    assert.equal(call.env.ANTHROPIC_AUTH_TOKEN, undefined);
    if (provider === "codex") {
      assert.doesNotMatch(
        call.args.join(" "),
        /model_providers\.openai|openai_base_url/,
      );
      assert.match(call.args.join(" "), /model_provider="openai"/);
    }
    assert.equal(call.args.at(-1), "--help");
    assert.equal(call.env.OPENAI_API_KEY, undefined);
    assert.doesNotMatch(
      call.args.join(" "),
      /http:\/\/proxy|private|client-api-key/,
    );
    assert.equal(call.binary, `/test/.local/bin/${provider}`);
  }
});
test(
  "failed dependency install never stops services or replaces current",
  { skip: process.platform !== "linux" },
  async (t) => {
    const root = await fixture(t);
    const source = join(root, "source");
    const data = join(root, "data");
    await fs.mkdir(source);
    await fs.mkdir(join(root, "bin"));
    for (const name of [
      "src",
      "scripts",
      "public",
      "dist",
      "docs",
      "README.md",
      "package.json",
      "package-lock.json",
    ])
      await fs.cp(name, join(source, name), { recursive: true });
    await fs.symlink(
      join(process.cwd(), "node_modules"),
      join(source, "node_modules"),
    );
    await fs.mkdir(join(source, ".local"));
    await fs.writeFile(
      join(source, ".env"),
      "PROXY_API_KEY=private\nENGINE_MANAGEMENT_KEY=management\n",
    );
    await fs.writeFile(
      join(source, ".local/engine.yaml"),
      'port: 8317\nauth-dir: "fixture"\n',
    );
    await fs.writeFile(join(source, ".local/engine-version"), "8.0.59");
    await fs.writeFile(join(source, ".local/cli-proxy-api"), "unused");
    await fs.writeFile(join(root, "bin/npm"), "#!/bin/sh\nexit 1\n", {
      mode: 0o700,
    });
    const log = join(root, "calls");
    await fs.writeFile(
      join(root, "bin/systemctl"),
      `#!/bin/sh\necho "$@" >> '${log}'\n`,
      { mode: 0o700 },
    );
    await assert.rejects(
      exec(process.execPath, [join(source, "scripts/install-service.ts")], {
        env: {
          ...process.env,
          PATH: join(root, "bin") + ":" + process.env.PATH,
          XDG_DATA_HOME: data,
          XDG_CONFIG_HOME: join(root, "config"),
        },
      }),
    );
    await assert.rejects(fs.access(log));
    await assert.rejects(fs.access(join(data, "cli-proxy/current")));
  },
);
async function recoveryFixture(t: Parameters<typeof fixture>[0]) {
  const root = await fixture(t);
  const release = join(root, "releases/good");
  const bin = join(root, "bin");
  const config = join(root, "config");
  await fs.mkdir(release, { recursive: true });
  await fs.mkdir(bin);
  await fs.mkdir(config);
  await fs.mkdir(join(root, "unit-backup"));
  await fs.symlink(
    join(process.cwd(), "node_modules"),
    join(release, "node_modules"),
  );
  await fs.writeFile(join(release, "package.json"), '{"type":"module"}');
  await atomicWrite(
    join(release, "release.json"),
    JSON.stringify({
      id: "good",
      node: process.execPath,
      schemaVersion: 2,
      files: await fingerprint(release),
    }),
  );
  for (const name of Object.keys(serviceUnits(root, process.execPath)))
    await atomicWrite(
      join(root, "unit-backup", name + ".json"),
      JSON.stringify("previous unit"),
    );
  const oldPath = process.env.PATH,
    oldConfig = process.env.XDG_CONFIG_HOME;
  process.env.PATH = bin + ":" + oldPath;
  process.env.XDG_CONFIG_HOME = config;
  t.after(async () => {
    process.env.PATH = oldPath;
    if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldConfig;
  });
  const log = join(root, "calls");
  await fs.writeFile(
    join(bin, "systemctl"),
    `#!/bin/sh\necho "$@" >> '${log}'\n`,
    { mode: 0o700 },
  );
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(
        req.url === "/healthz"
          ? { release: "good", demo: false }
          : { data: [] },
      ),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const port = (server.address() as { port: number }).port;
  await fs.writeFile(
    join(root, ".env"),
    `PORT=${port}\nENGINE_URL=http://127.0.0.1:${port}\nPROXY_API_KEY=private\nENGINE_MANAGEMENT_KEY=management\n`,
  );
  await fs.mkdir(join(root, ".local"));
  await fs.writeFile(join(root, ".local/usage.txt"), "must survive");
  await point(join(root, "current"), release);
  return { root, release, log };
}
test("an interrupted activation restores and verifies the complete previous release, preserving shared data", async (t) => {
  const { root, release, log } = await recoveryFixture(t);
  await atomicWrite(
    join(root, "deployment.json"),
    JSON.stringify({
      phase: "switching",
      candidate: "broken",
      previous: release,
      startedAt: "test",
    }),
  );
  await recover(root);
  assert.equal(await fs.realpath(join(root, "current")), release);
  assert.equal(
    JSON.parse(await fs.readFile(join(root, "deployment.json"), "utf8")).phase,
    "rolled-back",
  );
  assert.equal(
    await fs.readFile(join(root, ".local/usage.txt"), "utf8"),
    "must survive",
  );
  assert.match(
    await fs.readFile(log, "utf8"),
    /stop cli-proxy-console.service cli-proxy-engine.service/,
  );
  const before = await fs.readFile(log, "utf8");
  await recover(root);
  assert.equal(await fs.readFile(log, "utf8"), before);
});
test("first activation failure never claims the broken legacy installation is a valid rollback", async (t) => {
  const { root } = await recoveryFixture(t);
  await atomicWrite(
    join(root, "deployment.json"),
    JSON.stringify({
      phase: "switching",
      candidate: "broken",
      previous: null,
      startedAt: "test",
    }),
  );
  await assert.rejects(recover(root), /no verified previous release/);
  assert.equal(
    JSON.parse(await fs.readFile(join(root, "deployment.json"), "utf8")).phase,
    "failed",
  );
  await assert.rejects(fs.access(join(root, "current")));
});

test(
  "systemd accepts generated units before they can replace live units",
  { skip: process.platform !== "linux" },
  async (t) => {
    const runtime =
      process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid!()}`;
    if (
      !(await fs.access(runtime).then(
        () => true,
        () => false,
      ))
    ) {
      t.skip("No user runtime for systemd verification");
      return;
    }
    const root = await fixture(t);
    const release = join(root, "release");
    await fs.mkdir(release);
    await fs.mkdir(join(root, ".local"));
    await fs.symlink("/bin/true", join(release, "cli-proxy-api"));
    await validateUnits(root, release);
  },
);
