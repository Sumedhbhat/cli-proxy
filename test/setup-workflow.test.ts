import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSetup } from "../src/setup-workflow.ts";
import type { SetupRunner } from "../src/setup-workflow.ts";

async function fixture(t: { after: (f: () => Promise<unknown>) => void }) {
  const root = await fs.mkdtemp(join(tmpdir(), "proxy-setup-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  await fs.mkdir(source);
  const installation = join(root, "data/cli-proxy");
  await fs.mkdir(installation, { recursive: true });
  await fs.mkdir(join(installation, ".local"));
  await fs.writeFile(
    join(installation, ".env"),
    "PROXY_API_KEY=keep\nPORT=9918\n",
  );
  await fs.writeFile(
    join(installation, ".local/engine.yaml"),
    "original configuration",
  );
  const t3 = join(root, "t3-settings.json");
  await fs.writeFile(t3, "{}");
  const calls: string[][] = [];
  const run: SetupRunner = async (binary, args) => {
    calls.push([binary, ...args]);
    return args.includes("GOVERSION") ? "go1.26.8\n" : "";
  };
  const env = {
    XDG_DATA_HOME: join(root, "data"),
    CLI_PROXY_CLIENT_HOME: join(root, "client"),
    CLI_PROXY_T3_SETTINGS: t3,
    PATH: process.env.PATH,
  };
  return { source, installation, calls, run, env };
}
test("one command bootstraps without node_modules, runs every stage in order, and preserves private configuration on rerun", async (t) => {
  const f = await fixture(t);
  await runSetup(f.source, { env: f.env, platform: "linux", run: f.run });
  await assert.rejects(fs.access(join(f.source, "node_modules")));
  const stages = f.calls.filter((c) =>
    c.some((v) => v.endsWith(".ts") || v.endsWith("maintenance.cjs")),
  );
  assert.deepEqual(
    stages.map((c) => c[1]),
    [
      "scripts/build.ts",
      "scripts/setup-engine.ts",
      "scripts/build-plugin.ts",
      "scripts/install-recovery.ts",
      "scripts/install-service.ts",
      "scripts/configure-clients.ts",
      "scripts/install-recovery.ts",
      join(f.installation, "maintenance.cjs"),
    ],
  );
  assert.ok(
    f.calls.some(
      (c) =>
        c[0] === "npm" &&
        c.includes("--ignore-scripts") &&
        c.includes("--include=dev"),
    ),
  );
  assert.ok(
    stages
      .find((c) => c[1] === "scripts/configure-clients.ts")
      ?.includes("http://127.0.0.1:9918"),
  );
  assert.ok(stages.some((c) => c.includes("--configure-proxy")));
  assert.equal(
    await fs.readFile(join(f.source, ".env"), "utf8"),
    "PROXY_API_KEY=keep\nPORT=9918\n",
  );
  await fs.writeFile(join(f.source, ".env"), "source-specific\n");
  await runSetup(f.source, { env: f.env, platform: "linux", run: f.run });
  assert.equal(
    await fs.readFile(join(f.source, ".env"), "utf8"),
    "source-specific\n",
  );
  assert.equal(
    await fs.readFile(join(f.installation, ".env"), "utf8"),
    "PROXY_API_KEY=keep\nPORT=9918\n",
  );
});
test("missing prerequisites and old Go stop before dependency installation or service changes", async (t) => {
  for (const broken of ["npm", "cc", "go"]) {
    const f = await fixture(t);
    const run: SetupRunner = async (binary, args, capture) => {
      if (binary === broken) throw new Error("missing");
      return f.run(binary, args, capture);
    };
    await assert.rejects(
      runSetup(f.source, { env: f.env, platform: "linux", run }),
      /Setup stopped/,
    );
    assert.ok(
      !f.calls.some(
        (c) => c.includes("ci") || c.includes("scripts/install-service.ts"),
      ),
    );
  }
  const f = await fixture(t);
  await assert.rejects(
    runSetup(f.source, {
      env: f.env,
      platform: "linux",
      run: async () => "go1.25.0",
    }),
    /Go 1.26/,
  );
});
test("a failed build never activates services; a failed activation never reconfigures proxy clients or reports success", async (t) => {
  for (const failed of [
    "ci",
    "scripts/build.ts",
    "scripts/build-plugin.ts",
    "scripts/install-service.ts",
  ]) {
    const f = await fixture(t);
    const run: SetupRunner = async (binary, args, capture) => {
      f.calls.push([binary, ...args]);
      if (args.includes(failed)) throw new Error("injected");
      return args.includes("GOVERSION") ? "go1.26.8" : "";
    };
    await assert.rejects(
      runSetup(f.source, { env: f.env, platform: "linux", run }),
      /Setup stopped/,
    );
    assert.ok(!f.calls.some((c) => c.includes("scripts/configure-clients.ts")));
    if (failed !== "scripts/install-service.ts")
      assert.ok(!f.calls.some((c) => c.includes("scripts/install-service.ts")));
    // A retry is allowed after the failed setup releases its lock.
    await runSetup(f.source, { env: f.env, platform: "linux", run: f.run });
  }
});
test("unsupported platforms and installed release directories are rejected before setup work", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    runSetup(f.source, { env: f.env, platform: "darwin", run: f.run }),
    /No changes/,
  );
  await fs.writeFile(join(f.source, "release.json"), "{}");
  await assert.rejects(
    runSetup(f.source, { env: f.env, platform: "linux", run: f.run }),
    /development checkout/,
  );
  assert.equal(f.calls.length, 0);
});

test("read-only T3 mode never passes a T3 settings path to client or recovery setup", async (t) => {
  const f = await fixture(t);
  await runSetup(f.source, {
    env: { ...f.env, CLI_PROXY_SKIP_T3: "1" },
    platform: "linux",
    run: f.run,
  });
  assert.ok(!f.calls.flat().some((v) => v.startsWith("--t3-settings")));
  assert.ok(!f.calls.flat().includes("--configure-proxy"));
  assert.equal(await fs.readFile(f.env.CLI_PROXY_T3_SETTINGS, "utf8"), "{}");
});
