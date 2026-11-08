import { dashboard as readDashboard, present } from "./test-helpers.ts";
import type { DashboardState } from "../src/domain.ts";
import { address } from "./test-helpers.ts";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

test(
  "tailnet dashboard opens without login while inference stays authenticated",
  { timeout: 20000 },
  async (t) => {
    const patches: Array<{ priority: number }> = [],
      seen: Array<{
        headers: http.IncomingHttpHeaders;
        body?: unknown;
        websocket?: boolean;
      }> = [],
      sockets = new Set<import("node:stream").Duplex>();
    let usableQuota = false;
    const engine = http.createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      const path = new URL(req.url || "/", "http://local").pathname;
      res.setHeader("Content-Type", "application/json");
      if (
        req.headers.authorization !== "Bearer test-management" &&
        path.startsWith("/v0/management/")
      ) {
        res.writeHead(401);
        res.end("{}");
        return;
      }
      if (path.endsWith("/auth-files"))
        res.end(
          JSON.stringify({
            files: [
              {
                name: "later.json",
                auth_index: "later",
                provider: "claude",
                supports_quota: true,
              },
              {
                name: "soon.json",
                auth_index: "soon",
                provider: "claude",
                supports_quota: true,
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
      else if (path.endsWith("/quota/fetch"))
        res.end(
          JSON.stringify({
            seven_day: {
              utilization: usableQuota ? 50 : 100,
              resets_at: new Date(
                Date.now() + (body.auth_index === "soon" ? 1 : 4) * 86400000,
              ).toISOString(),
            },
            cedar_ember: {
              eligible: true,
              grants: [
                {
                  resets_left: 2,
                  ends_at: new Date(
                    Date.now() +
                      (body.auth_index === "soon" ? 5 : 0.5) * 86400000,
                  ).toISOString(),
                },
              ],
            },
          }),
        );
      else if (path.endsWith("/auth-files/fields")) {
        patches.push(body);
        res.end('{"status":"ok"}');
      } else if (path.endsWith("/anthropic-auth-url"))
        res.end(
          '{"url":"https://claude.ai/oauth/authorize","state":"test-state"}',
        );
      else if (path === "/v1/models") {
        assert.equal(req.headers["if-none-match"], undefined);
        res.setHeader("ETag", '"unfiltered"');
        if (
          new URL(req.url || "/", "http://local").searchParams.has(
            "client_version",
          )
        ) {
          res.end(
            JSON.stringify({
              models: [
                { slug: "g5", context_window: 400000 },
                { slug: "claude-opus-5-5", context_window: 200000 },
              ],
            }),
          );
        } else
          res.end(
            JSON.stringify({
              object: "list",
              data: [
                ...[
                  "gpt-6.1-sol",
                  "codex-mini-latest",
                  "o3",
                  "claude-opus-5-5",
                  "gemini-pro",
                ].map((id) => ({ id, object: "model" })),
                { id: "g5", object: "model", owned_by: "openai" },
              ],
            }),
          );
      } else if (path === "/v1/messages") {
        res.writeHead(429);
        res.end(
          JSON.stringify({
            error: {
              type: "rate_limit_error",
              message: "All credentials cooling down",
            },
          }),
        );
      } else if (path === "/v1/responses") {
        seen.push({ headers: req.headers, body });
        res.setHeader("Content-Type", "text/event-stream");
        res.write('event: response.created\ndata: {"id":"test"}\n\n');
        res.end("event: response.completed\ndata: {}\n\n");
      } else {
        res.writeHead(404);
        res.end("{}");
      }
    });
    engine.on("upgrade", (req, socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      seen.push({ headers: req.headers, websocket: true });
      const key = createHash("sha1")
        .update(
          req.headers["sec-websocket-key"] +
            "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
        )
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${key}\r\n\r\n`,
      );
      socket.on("data", () => {});
      socket.on("error", () => {});
    });
    engine.listen(0, "127.0.0.1");
    await once(engine, "listening");
    const portProbe = http.createServer().listen(0, "127.0.0.1");
    await once(portProbe, "listening");
    const port = address(portProbe).port;
    await new Promise((r) => portProbe.close(r));
    const dir = await mkdtemp(join(tmpdir(), "cli-proxy-test-"));
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({ scheduler: true, intervalSeconds: 60 }),
    );
    const child = spawn(process.execPath, ["src/server.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        ENGINE_URL: `http://127.0.0.1:${address(engine).port}`,
        ENGINE_MANAGEMENT_KEY: "test-management",
        PROXY_API_KEY: "test-api",
        DATA_DIR: dir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (c) => (output += c));
    child.stderr.on("data", (c) => (output += c));
    t.after(async () => {
      child.kill("SIGTERM");
      for (const socket of sockets) socket.destroy();
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
    assert.match(output, /CLI Proxy/);
    const dashboard = await fetch(base + "/api/state");
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.headers.get("set-cookie"), null);
    assert.doesNotMatch(
      await (await fetch(base)).text(),
      /id="login"|CONSOLE_KEY/,
    );
    assert.equal((await fetch(base + "/v0/management/config")).status, 404);
    assert.equal(
      (await fetch(base + "/v1/responses", { method: "POST", body: "{}" }))
        .status,
      401,
    );
    assert.equal((await fetch(base + "/codex/v1/models")).status, 401);
    const catalogHeaders = { Authorization: "Bearer test-api" };
    for (const [provider, expected] of [
      ["codex", ["gpt-6.1-sol", "codex-mini-latest", "o3", "g5"]],
      ["claude", ["claude-opus-5-5"]],
    ]) {
      const catalog = await fetch(base + `/${provider}/v1/models?limit=100`, {
        headers: { ...catalogHeaders, "If-None-Match": '"unfiltered"' },
      });
      assert.equal(catalog.status, 200);
      assert.equal(catalog.headers.get("etag"), null);
      assert.deepEqual(
        (await catalog.json()).data.map((model: { id: string }) => model.id),
        expected,
      );
    }
    assert.equal(
      (
        await (
          await fetch(base + "/v1/models", { headers: catalogHeaders })
        ).json()
      ).data.length,
      6,
    );
    const capabilities = await fetch(
      base + "/codex/v1/models?client_version=0.159.0",
      { headers: catalogHeaders },
    );
    assert.equal(capabilities.status, 200);
    assert.deepEqual(await capabilities.json(), {
      models: [{ slug: "g5", context_window: 400000 }],
    });
    assert.equal(
      (
        await fetch(base + "/api/refresh", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "http://evil.test",
          },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(base + "/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
      404,
    );
    const auth = { "Content-Type": "application/json" };
    assert.equal(
      (
        await fetch(base + "/api/refresh", {
          method: "POST",
          headers: auth,
          body: "{}",
        })
      ).status,
      200,
    );
    const state = await (
      await fetch(base + "/api/state", { headers: auth })
    ).json();
    assert.equal(state.accounts.length, 2);
    assert.equal(state.schedulerError, null);
    assert.ok(patches.every((p) => p.priority === -1000000));
    assert.equal(JSON.stringify(state).includes("test-management"), false);
    const limited = await fetch(base + "/v1/messages", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-api",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "claude-opus-5-5" }),
    });
    assert.equal(limited.status, 429);
    const limitedBody = await limited.json();
    assert.match(limitedBody.error.message, /Nearest Claude account reset:/);
    assert.equal(
      limitedBody.error.resets_at,
      limited.headers.get("x-ratelimit-reset"),
    );
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
    assert.equal(
      limited.headers.get("anthropic-ratelimit-unified-status"),
      "rejected",
    );
    assert.equal(
      limited.headers.get("anthropic-ratelimit-unified-representative-claim"),
      "seven_day",
    );
    assert.equal(
      Number(limited.headers.get("anthropic-ratelimit-unified-reset")),
      Math.ceil(Date.parse(limitedBody.error.resets_at) / 1000),
    );
    const unknown = await fetch(base + "/v1/messages", {
      method: "POST",
      headers: { Authorization: "Bearer test-api" },
      body: JSON.stringify({ model: "unknown" }),
    });
    assert.equal(
      (await unknown.json()).error.message,
      "All credentials cooling down",
    );
    usableQuota = true;
    assert.equal(
      (
        await fetch(base + "/api/refresh", {
          method: "POST",
          headers: auth,
          body: "{}",
        })
      ).status,
      200,
    );
    const usableState = await readDashboard(await fetch(base + "/api/state"));
    assert.equal(usableState.schedulerError, null);
    assert.deepEqual(
      usableState.ranks.map((r) => r.id),
      ["later", "soon"],
    );
    assert.deepEqual(
      usableState.accounts.map((a) => [a.id, a.priority]),
      [
        ["later", 10000],
        ["soon", 9999],
      ],
    );
    assert.deepEqual(patches.slice(-2), [
      { name: "later.json", priority: 10000 },
      { name: "soon.json", priority: 9999 },
    ]);
    const oauth = await fetch(base + "/api/oauth/start", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ provider: "claude" }),
    });
    assert.equal(oauth.status, 200);
    assert.equal((await oauth.json()).state, "test-state");
    const stream = await fetch(base + "/codex/v1/responses", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-api",
        Cookie: "private=do-not-forward",
        "Content-Type": "application/json",
        session_id: "sticky-123",
      },
      body: JSON.stringify({ model: "test", stream: true }),
    });
    assert.match(present(stream.headers.get("content-type")), /event-stream/);
    assert.match(await stream.text(), /response.completed/);
    assert.equal(seen[0].headers.cookie, undefined);
    assert.equal(seen[0].headers.session_id, "sticky-123");
    assert.equal(seen[0].headers.authorization, "Bearer test-api");
    // Verify the authenticated upgrade without a third-party WebSocket client.
    await new Promise<void>((resolve, reject) => {
      const req = http.request(base + "/codex/v1/responses", {
        headers: {
          Authorization: "Bearer test-api",
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version": "13",
        },
      });
      req.on("error", reject);
      req.on("upgrade", (res, socket) => {
        try {
          assert.equal(res.statusCode, 101);
          assert.ok(res.headers["x-cli-proxy-release"]);
          assert.ok(res.headers["x-cli-proxy-request-id"]);
          assert.equal(
            present(seen.at(-1)).headers.authorization,
            "Bearer test-api",
          );
          socket.destroy();
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      req.end();
    });
  },
);
