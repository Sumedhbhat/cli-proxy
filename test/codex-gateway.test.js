import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test(
  "Codex refusals use Codex usage-limit errors on HTTP and websocket upgrades",
  { timeout: 20000 },
  async (t) => {
    const resetAt = new Date(Date.now() + 3600000).toISOString(),
      resetEpoch = String(Math.floor(Date.parse(resetAt) / 1000));
    let cooldown = {
      scope: "credential",
      reason: "credential_quota",
      retry_at: resetAt,
    };
    let upgrades = 0;
    const signals = {
      "X-Codex-Active-Limit": "premium",
      "X-Codex-Plan-Type": "plus",
      "X-Codex-Primary-Used-Percent": "100",
      "X-Codex-Primary-Window-Minutes": "300",
      "X-Codex-Primary-Reset-At": resetEpoch,
    };
    const engine = http.createServer(async (req, res) => {
      for await (const _ of req);
      const path = new URL(req.url, "http://local").pathname;
      res.setHeader("Content-Type", "application/json");
      if (path.endsWith("/auth-files"))
        res.end(
          JSON.stringify({
            files: [
              {
                name: "codex.json",
                auth_index: "codex",
                provider: "codex",
                cooldowns: [cooldown],
                quota: { observed_at: new Date().toISOString(), signals },
              },
            ],
          }),
        );
      else if (path.endsWith("/config"))
        res.end(
          JSON.stringify({
            routing: { strategy: "fill-first", "session-affinity": true },
          }),
        );
      else if (path === "/v1/responses") {
        res.writeHead(429, { "Retry-After": "3600" });
        res.end(
          JSON.stringify({
            error: {
              code: "model_cooldown",
              message: "All credentials for model gpt-6.1-sol are cooling down",
              reset_seconds: 3600,
            },
          }),
        );
      } else {
        res.writeHead(404);
        res.end("{}");
      }
    });
    engine.on("upgrade", (req, socket) => {
      upgrades++;
      socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    });
    engine.listen(0, "127.0.0.1");
    await once(engine, "listening");
    const probe = http.createServer().listen(0, "127.0.0.1");
    await once(probe, "listening");
    const port = probe.address().port;
    await new Promise((r) => probe.close(r));
    const dir = await mkdtemp(join(tmpdir(), "cli-proxy-codex-test-"));
    const child = spawn(process.execPath, ["src/server.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        ENGINE_URL: `http://127.0.0.1:${engine.address().port}`,
        ENGINE_MANAGEMENT_KEY: "test-management",
        PROXY_API_KEY: "test-api",
        DATA_DIR: dir,
      },
      stdio: "ignore",
    });
    t.after(async () => {
      child.kill("SIGTERM");
      engine.closeAllConnections();
      engine.close();
      await rm(dir, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(base + "/healthz")).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 30));
    }
    const ask = (body) =>
      fetch(base + "/v1/responses", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-api",
          "Content-Type": "application/json",
        },
        body,
      });

    const limited = await ask(
      JSON.stringify({ model: "gpt-6.1-sol", stream: true }),
    );
    assert.equal(limited.status, 429);
    const { error } = await limited.json();
    assert.equal(error.type, "usage_limit_reached");
    assert.equal(error.resets_at, Math.ceil(Date.parse(resetAt) / 1000));
    assert.equal(error.plan_type, "plus");
    assert.equal(error.code, "model_cooldown");
    assert.match(error.message, /Nearest Codex account reset:/);
    assert.equal(limited.headers.get("x-codex-primary-used-percent"), "100");
    assert.equal(limited.headers.get("x-codex-primary-reset-at"), resetEpoch);
    assert.equal(limited.headers.get("x-codex-active-limit"), null);
    // Large turns overflow the captured body; the model is still read from its prefix.
    const large = await ask(
      JSON.stringify({
        model: "gpt-6.1-sol",
        input: "x".repeat(3 * 1024 * 1024),
      }),
    );
    assert.equal((await large.json()).error.type, "usage_limit_reached");

    const upgrade = () =>
      new Promise((resolve, reject) => {
        const req = http.request(base + "/v1/responses", {
          headers: {
            Authorization: "Bearer test-api",
            Connection: "Upgrade",
            Upgrade: "websocket",
            "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
            "Sec-WebSocket-Version": "13",
          },
        });
        req.on("error", reject);
        req.on("upgrade", () => reject(new Error("unexpected upgrade")));
        req.on("response", async (res) => {
          let text = "";
          for await (const chunk of res) text += chunk;
          resolve({ res, text });
        });
        req.end();
      });
    const refused = await upgrade();
    assert.equal(refused.res.statusCode, 429);
    assert.equal(JSON.parse(refused.text).error.type, "usage_limit_reached");
    assert.equal(refused.res.headers["x-codex-primary-used-percent"], "100");
    assert.equal(upgrades, 0);

    // A transient cooldown is not a usage limit: keep the engine's response and let Codex retry.
    cooldown = { scope: "credential", reason: "rate_limit", retry_at: resetAt };
    await new Promise((r) => setTimeout(r, 5100));
    const transient = await ask(JSON.stringify({ model: "gpt-6.1-sol" }));
    const body = await transient.json();
    assert.equal(body.error.type, undefined);
    assert.equal(
      body.error.message,
      "All credentials for model gpt-6.1-sol are cooling down",
    );
    assert.equal((await upgrade()).res.statusCode, 502);
    assert.equal(upgrades, 1);
  },
);

test(
  "a client reset during the upgrade cooldown lookup does not stop the gateway",
  { timeout: 20000 },
  async (t) => {
    // The startup refresh reads auth-files first; the upgrade's cooldown lookup is the
    // next read, held open so the client can reset while the gateway waits on it.
    let lookups = 0,
      startupRead,
      upgradeRead;
    const startup = new Promise((r) => {
        startupRead = r;
      }),
      upgradeLookup = new Promise((r) => {
        upgradeRead = r;
      });
    const engine = http.createServer((req, res) => {
      const path = new URL(req.url, "http://local").pathname;
      if (path.endsWith("/auth-files")) {
        if (++lookups === 1) {
          startupRead();
          res.end('{"files":[]}');
        } else {
          upgradeRead();
          setTimeout(() => res.end('{"files":[]}'), 1000);
        }
      } else if (path.endsWith("/config")) res.end('{"routing":{}}');
      else {
        res.writeHead(404);
        res.end("{}");
      }
    });
    engine.listen(0, "127.0.0.1");
    await once(engine, "listening");
    const probe = http.createServer().listen(0, "127.0.0.1");
    await once(probe, "listening");
    const port = probe.address().port;
    await new Promise((r) => probe.close(r));
    const dir = await mkdtemp(join(tmpdir(), "cli-proxy-reset-test-"));
    const child = spawn(process.execPath, ["src/server.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        ENGINE_URL: `http://127.0.0.1:${engine.address().port}`,
        ENGINE_MANAGEMENT_KEY: "test-management",
        PROXY_API_KEY: "test-api",
        DATA_DIR: dir,
      },
      stdio: "ignore",
    });
    let exited = false;
    child.on("exit", () => {
      exited = true;
    });
    t.after(async () => {
      child.kill("SIGTERM");
      engine.closeAllConnections();
      engine.close();
      await rm(dir, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(base + "/healthz")).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 30));
    }
    await startup;
    const socket = net.connect(port, "127.0.0.1", () =>
      socket.write(
        "GET /v1/responses HTTP/1.1\r\nHost: local\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nAuthorization: Bearer test-api\r\n\r\n",
      ),
    );
    socket.on("error", () => {});
    await upgradeLookup;
    socket.resetAndDestroy();
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(exited, false);
    assert.equal((await fetch(base + "/healthz")).status, 200);
  },
);
