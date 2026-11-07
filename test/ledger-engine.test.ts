// End to end: client -> gateway -> CLIProxyAPI v8.0.59 with the ledger plugin
// -> local mock provider, then outbox -> ingestion -> dashboard API and export.
// No paid inference: the mock returns provider-shaped usage.
//
// Requires the engine binary and the built plugin:
//   CLI_PROXY_ENGINE_BINARY (default .local/cli-proxy-api)
//   CLI_PROXY_LEDGER_PLUGIN (default .local/plugins/cli-proxy-ledger.so)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { STALL, startMockProvider } from "./mock-provider.ts";

const engineBinary = resolve(
  process.env.CLI_PROXY_ENGINE_BINARY || ".local/cli-proxy-api",
);
const pluginPath = resolve(
  process.env.CLI_PROXY_LEDGER_PLUGIN || ".local/plugins/cli-proxy-ledger.so",
);
const available = existsSync(engineBinary) && existsSync(pluginPath);

const SHARED_KEY = "gateway-shared-key-for-tests-0001";
const SECRET = "ledger-device-secret-for-tests-0123456789";
const MANAGEMENT = "management-key-for-tests";
const UPSTREAM = "upstream-provider-key";
const PROMPT = "PRIVATE PROMPT TEXT";

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(
  what: string,
  probe: () => Promise<T | undefined>,
  timeoutMs = 20000,
  describe?: () => Promise<unknown>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline)
      throw new Error(
        `Timed out waiting for ${what}${describe ? `: ${JSON.stringify(await describe().catch((e) => String(e)))}` : ""}`,
      );
    await sleep(200);
  }
}
const stop = async (
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill(signal);
  await exited;
};

test(
  "engine-to-ledger-to-dashboard accounting",
  {
    skip: !available && "engine binary or ledger plugin not built",
    timeout: 180000,
  },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "cli-proxy-ledger-e2e-"));
    const data = join(dir, "data");
    mkdirSync(join(data, "plugins"), { recursive: true });
    mkdirSync(join(data, "auth"));
    copyFileSync(pluginPath, join(data, "plugins/cli-proxy-ledger.so"));
    const mock = await startMockProvider({
      failFirst: { MOCK_FAIL_ONCE: { count: 1, status: 429 } },
    });
    const enginePort = await freePort();
    const gatewayPort = await freePort();
    const children: ChildProcess[] = [];
    t.after(async () => {
      for (const child of children) await stop(child, "SIGKILL");
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    });

    writeFileSync(
      join(data, "engine.yaml"),
      `host: "127.0.0.1"
port: ${enginePort}
auth-dir: ${JSON.stringify(join(data, "auth"))}
remote-management:
  allow-remote: false
  secret-key: ${JSON.stringify(MANAGEMENT)}
  disable-control-panel: true
api-keys:
  - ${JSON.stringify(SHARED_KEY)}
routing:
  strategy: fill-first
  session-affinity: true
ws-auth: true
request-retry: 2
logging-to-file: false
usage-statistics-enabled: false
claude-api-key:
  - api-key: ${JSON.stringify(UPSTREAM)}
    base-url: ${JSON.stringify(mock.url)}
  - api-key: ${JSON.stringify(`${UPSTREAM}-second`)}
    base-url: ${JSON.stringify(mock.url)}
codex-api-key:
  - api-key: ${JSON.stringify(UPSTREAM)}
    base-url: ${JSON.stringify(mock.url)}
plugins:
  enabled: true
  dir: ${JSON.stringify(join(data, "plugins"))}
  configs:
    cli-proxy-ledger:
      enabled: true
      priority: 100
      outbox-dir: ${JSON.stringify(join(data, "usage-outbox"))}
      device-secret: ${JSON.stringify(SECRET)}
      engine-key-sha256: ${JSON.stringify(createHash("sha256").update(SHARED_KEY).digest("hex"))}
`,
      { mode: 0o600 },
    );
    const engineURL = `http://127.0.0.1:${enginePort}`;
    const startEngine = async () => {
      const child = spawn(
        engineBinary,
        ["-config", join(data, "engine.yaml")],
        { cwd: data, stdio: "ignore" },
      );
      children.push(child);
      await until("ledger plugin", async () => {
        const response = await fetch(`${engineURL}/v0/management/plugins`, {
          headers: { Authorization: `Bearer ${MANAGEMENT}` },
        });
        const body = (await response.json()) as {
          plugins?: Array<{
            id: string;
            registered: boolean;
            effective_enabled: boolean;
          }>;
        };
        const plugin = body.plugins?.find((p) => p.id === "cli-proxy-ledger");
        return plugin?.registered && plugin.effective_enabled
          ? true
          : undefined;
      });
      // Model registration for the API-key credentials finishes shortly after startup.
      await until("models", async () => {
        const response = await fetch(`${engineURL}/v1/models`, {
          headers: { Authorization: `Bearer ${SHARED_KEY}` },
        });
        const body = (await response.json()) as {
          data?: Array<{ id: string }>;
        };
        const ids = new Set(body.data?.map((m) => m.id));
        return ids.has("claude-opus-5-5") && ids.has("gpt-6.1-sol")
          ? true
          : undefined;
      });
      return child;
    };
    const gateway = `http://127.0.0.1:${gatewayPort}`;
    const startGateway = async () => {
      const child = spawn(process.execPath, ["src/server.ts"], {
        env: {
          ...process.env,
          PORT: String(gatewayPort),
          DATA_DIR: data,
          ENGINE_URL: engineURL,
          ENGINE_MANAGEMENT_KEY: MANAGEMENT,
          PROXY_API_KEY: SHARED_KEY,
          LEDGER_DEVICE_SECRET: SECRET,
        },
        stdio: ["ignore", "pipe", "inherit"],
      });
      children.push(child);
      await until("gateway", async () =>
        (await fetch(`${gateway}/healthz`)).ok ? true : undefined,
      );
      return child;
    };
    let engine = await startEngine();
    let console_ = await startGateway();
    const api = async (path: string, init?: RequestInit) => {
      const response = await fetch(`${gateway}${path}`, {
        ...init,
        headers: { "Content-Type": "application/json", ...init?.headers },
      });
      const text = await response.text();
      assert.ok(response.ok, `${path}: ${response.status} ${text}`);
      return JSON.parse(text);
    };

    const laptop = await api("/api/devices", {
      method: "POST",
      body: JSON.stringify({ label: "Work laptop" }),
    });
    const phone = await api("/api/devices", {
      method: "POST",
      body: JSON.stringify({ label: "Phone" }),
    });
    assert.match(laptop.key, /^cpk_/);
    assert.match(laptop.id, /^work-laptop-[0-9a-f]{6}$/);

    const claude = (
      key: string,
      content: string,
      stream: boolean,
      extra: Record<string, string> = {},
    ) =>
      fetch(`${gateway}/v1/messages`, {
        method: "POST",
        headers: {
          "x-api-key": key,
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          ...extra,
        },
        body: JSON.stringify({
          model: "claude-opus-5-5",
          max_tokens: 16,
          stream,
          messages: [{ role: "user", content }],
        }),
      });
    const codex = (key: string, input: string) =>
      fetch(`${gateway}/v1/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-6.1-sol", input, stream: true }),
      });
    const drain = async (response: Response) => {
      assert.equal(response.status, 200, await response.clone().text());
      await response.text();
    };

    // Attributed traffic for two devices and the shared key.
    await drain(await claude(SHARED_KEY, PROMPT, false));
    await drain(await claude(laptop.key, PROMPT, true));
    await drain(await codex(laptop.key, PROMPT));
    await drain(await codex(phone.key, PROMPT));
    // A client cannot claim a device: its header is replaced by the gateway.
    await drain(
      await claude(SHARED_KEY, PROMPT, false, {
        "x-cli-proxy-device": `${phone.id}.forged`,
      }),
    );
    // WebSocket upgrades pass the plugin's exclusive authentication with a
    // device key; a wrong key is refused by the gateway.
    const upgrade = (key: string) =>
      new Promise<number>((resolve, reject) => {
        const request = http.request(`${gateway}/v1/responses`, {
          headers: {
            Connection: "Upgrade",
            Upgrade: "websocket",
            "Sec-WebSocket-Version": "13",
            "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
            Authorization: `Bearer ${key}`,
          },
        });
        request.on("upgrade", (response, socket) => {
          socket.destroy();
          resolve(response.statusCode ?? 0);
        });
        request.on("response", (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        });
        request.on("error", reject);
        request.end();
      });
    assert.equal(await upgrade(laptop.key), 101);
    assert.equal(await upgrade("cpk_not-a-device"), 401);
    // Unknown and revoked keys are refused before reaching the engine.
    assert.equal((await claude("cpk_not-a-device", PROMPT, false)).status, 401);
    await api("/api/devices/revoke", {
      method: "POST",
      body: JSON.stringify({ id: phone.id }),
    });
    assert.equal((await claude(phone.key, PROMPT, false)).status, 401);

    // A provider 429 on one credential, then fallback to the other: two
    // attempts under one parent request, each on the account that handled it.
    await drain(await claude(laptop.key, `MOCK_FAIL_ONCE ${PROMPT}`, false));

    // Streams interrupted before the provider's terminal usage event.
    for (const response of [
      await claude(laptop.key, `${STALL} ${PROMPT}`, true),
      await codex(laptop.key, `${STALL} ${PROMPT}`),
    ]) {
      const reader = response.body!.getReader();
      await reader.read();
      await sleep(300);
      await reader.cancel();
    }

    type Report = Record<string, any>;
    const report = (query = ""): Promise<Report> => api(`/api/usage${query}`);
    const settled = await until(
      "ingested executions",
      async () => {
        const r = await report();
        return r.totals.executions >= 8 ? r : undefined;
      },
      30000,
      async () => {
        const r = await report();
        return {
          totals: r.totals,
          providers: r.providers,
          coverage: r.coverage,
        };
      },
    );

    const claudeTotals = settled.providers.claude;
    const codexTotals = settled.providers.codex;
    // Four complete Claude responses at 100 input + 400 cache read + 50 write + 20 output.
    assert.equal(claudeTotals.status.complete, 4, JSON.stringify(claudeTotals));
    assert.equal(claudeTotals.outcomes.rejected, 1);
    assert.equal(
      claudeTotals.status.partial,
      1,
      "interrupted Claude stream keeps its reported counts",
    );
    // Two complete Codex responses; cached and reasoning tokens are subsets.
    assert.equal(codexTotals.status.complete, 2);
    // CLIProxyAPI v8.0.59 publishes nothing for a Codex stream the client cancels
    // (codex_executor_stream.go). The gateway's own count shows the gap.
    assert.equal(codexTotals.executions, 2);
    const cancelled = await until("gateway counts", async () => {
      const r = await report();
      const rows = r.coverage.gatewayRequests as Array<{
        provider: string;
        clientClosed: number;
        count: number;
      }>;
      const row = rows.find(
        (g) => g.provider === "codex" && g.clientClosed === 1,
      );
      return row ? row.count : undefined;
    });
    assert.equal(cancelled, 1);
    assert.equal(codexTotals.tokens.cacheRead, 1200);
    assert.equal(codexTotals.tokens.inputUncached, 800);
    assert.equal(codexTotals.tokens.reasoning, 400);
    assert.equal(codexTotals.tokens.total, 2600);
    // Plus the interrupted stream's message_start counts: 100 + 400 + 50 + 1.
    assert.equal(claudeTotals.tokens.total, 4 * 570 + 551);
    assert.equal(claudeTotals.tokens.cacheWrite, 5 * 50);

    // The retry is a distinct execution under the same parent request.
    const rows = (await api("/api/usage/export?format=json"))
      .executions as Array<Record<string, any>>;
    const retried = rows.filter(
      (r) =>
        r.provider === "claude" &&
        (r.outcome === "rejected" || r.status_code === 429),
    );
    assert.equal(retried.length, 1);
    const retryParent = rows.filter((r) => r.trace_id === retried[0].trace_id);
    assert.equal(retryParent.length, 2);
    assert.notEqual(retryParent[0].execution_id, retryParent[1].execution_id);
    const accounts = new Set(retryParent.map((r) => r.account_id));
    assert.equal(
      accounts.size,
      2,
      "each attempt is attributed to the credential that handled it",
    );
    assert.deepEqual(retryParent.map((r) => r.outcome).sort(), [
      "rejected",
      "success",
    ]);

    // Device attribution.
    const devices = Object.fromEntries(
      (
        settled.breakdowns.devices as Array<{
          key: string;
          provider: string;
          executions: number;
        }>
      ).map((d) => [`${d.provider}:${d.key}`, d.executions]),
    );
    // One completed Codex response; its cancelled stream left no engine record.
    assert.equal(devices[`codex:${laptop.id}`], 1);
    assert.equal(devices[`claude:${laptop.id}`], 4);
    assert.equal(devices[`codex:${phone.id}`], 1);
    assert.equal(devices["claude:shared-key"], 2);
    assert.equal(devices[`claude:${phone.id}`], undefined);
    const laptopOnly = await report(`?device=${laptop.id}&provider=codex`);
    assert.equal(laptopOnly.totals.executions, 1);

    // API-equivalent value for one complete Claude response at Opus 5.5 list prices.
    const one = (100 * 4 + 400 * 0.2 + 20 * 20) / 1e6;
    const claudeOnly = await report("?provider=claude&model=claude-opus-5-5");
    assert.ok(
      Math.abs(claudeOnly.totals.estimate.executions.priced - 4) < 1e-9,
    );
    assert.ok(
      claudeOnly.totals.estimate.low >= 4 * (one + (50 * 5) / 1e6) - 1e-9,
    );
    assert.ok(claudeOnly.totals.estimate.high > claudeOnly.totals.estimate.low);
    assert.equal(settled.coverage.plugin.loaded, true);
    assert.equal(settled.coverage.attributionEnabled, true);

    // Exports and the database contain no prompts, keys, or secrets.
    const csv = await (
      await fetch(`${gateway}/api/usage/export?format=csv`)
    ).text();
    assert.match(csv.split("\r\n")[0], /^execution_id,trace_id/);
    assert.equal(csv.trim().split("\r\n").length, rows.length + 1);
    const outbox = readdirSync(join(data, "usage-outbox"))
      .map((f) => readFileSync(join(data, "usage-outbox", f), "utf8"))
      .join("");
    const database =
      readFileSync(join(data, "accounting.sqlite")).toString("latin1") +
      (existsSync(join(data, "accounting.sqlite-wal"))
        ? readFileSync(join(data, "accounting.sqlite-wal")).toString("latin1")
        : "");
    for (const secret of [
      PROMPT,
      "MOCK_FAIL_ONCE",
      SHARED_KEY,
      laptop.key,
      phone.key,
      SECRET,
      UPSTREAM,
      MANAGEMENT,
      "mock limit",
    ])
      for (const [name, text] of [
        ["csv", csv],
        ["json", JSON.stringify(rows)],
        ["outbox", outbox],
        ["database", database],
      ])
        assert.ok(
          !text.includes(secret),
          `${name} contains ${secret.slice(0, 12)}…`,
        );

    // Restarts: a clean engine stop, then an engine killed without its final marker.
    const before = settled.totals.executions;
    await stop(console_);
    await stop(engine);
    engine = await startEngine();
    await stop(engine, "SIGKILL");
    engine = await startEngine();
    console_ = await startGateway();
    await drain(await claude(laptop.key, PROMPT, false));
    const after = await until(
      "restart coverage",
      async () => {
        const r = await report();
        return r.totals.executions === before + 1 &&
          r.coverage.events.some(
            (e: { kind: string }) => e.kind === "unclean-stop",
          )
          ? r
          : undefined;
      },
      30000,
      async () => {
        const r = await report();
        return {
          before,
          executions: r.totals.executions,
          events: r.coverage.events,
          writers: r.coverage.writers,
        };
      },
    );
    assert.equal(after.coverage.writers.length, 3);
    assert.equal(
      after.coverage.events.filter(
        (e: { kind: string }) => e.kind === "unclean-stop",
      ).length,
      1,
    );
    assert.equal(after.coverage.counters.duplicate_deliveries ?? 0, 0);
    await stop(console_);
    await stop(engine);
  },
);
