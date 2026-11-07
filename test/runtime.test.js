import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { readFile, readdir, stat } from "node:fs/promises";
import { startGateway } from "./server-fixture.js";

const defaults = (req, res) => {
  if (req.url.endsWith("/auth-files")) {
    res.end('{"files":[]}');
    return true;
  }
  if (req.url.endsWith("/config")) {
    res.end('{"routing":{}}');
    return true;
  }
  return false;
};
const waitFor = async (predicate) => {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Condition did not become true");
};

test(
  "absolute request targets cannot redirect the proxy key to another origin",
  { timeout: 10000 },
  async (t) => {
    let leaked = false;
    const other = http.createServer((req, res) => {
      leaked = true;
      res.end("leaked");
    });
    other.listen(0, "127.0.0.1");
    await once(other, "listening");
    t.after(() => new Promise((resolve) => other.close(resolve)));
    const { base } = await startGateway(t, (req, res) => {
      if (defaults(req, res)) return;
      assert.equal(req.url, "/v1/models?x=1");
      assert.equal(req.headers.authorization, "Bearer proxy-test");
      res.end('{"data":[]}');
    });
    for (const target of [
      `http://127.0.0.1:${other.address().port}/v1/models?x=1`,
      `//127.0.0.1:${other.address().port}/v1/models?x=1`,
    ]) {
      const result = await new Promise((resolve, reject) => {
        const req = http.request(
          base,
          { path: target, headers: { Authorization: "Bearer proxy-test" } },
          (res) => {
            let text = "";
            res.on("data", (chunk) => (text += chunk));
            res.on("end", () => resolve({ status: res.statusCode, text }));
          },
        );
        req.on("error", reject);
        req.end();
      });
      assert.equal(result.status, 200);
      assert.equal(result.text, '{"data":[]}');
    }
    assert.equal(leaked, false);
  },
);

test(
  "disconnecting a streaming client cancels its upstream without stopping the gateway",
  { timeout: 10000 },
  async (t) => {
    let upstreamClosed;
    const closed = new Promise((resolve) => {
      upstreamClosed = resolve;
    });
    const { base } = await startGateway(t, (req, res) => {
      if (defaults(req, res)) return;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: started\n\n");
      res.once("close", upstreamClosed);
    });
    await new Promise((resolve, reject) => {
      const req = http.get(
        base + "/v1/responses",
        { headers: { Authorization: "Bearer proxy-test" } },
        (res) => {
          res.once("data", () => {
            res.destroy();
            resolve();
          });
        },
      );
      req.on("error", reject);
    });
    await closed;
    assert.equal((await fetch(base + "/healthz")).status, 200);
  },
);

test(
  "overlapping quota refreshes share one bounded worker pool and retain original priorities",
  { timeout: 15000 },
  async (t) => {
    let inFlight = 0,
      maximum = 0,
      quotaCalls = 0,
      release;
    let gate = null;
    const patches = [];
    const { base, dataDir } = await startGateway(t, async (req, res) => {
      let text = "";
      for await (const chunk of req) text += chunk;
      const body = text ? JSON.parse(text) : {};
      if (req.url.endsWith("/auth-files")) {
        res.end(
          JSON.stringify({
            files: Array.from({ length: 7 }, (_, i) => ({
              name: `${i}.json`,
              auth_index: String(i + 1),
              provider: "codex",
              supports_quota: true,
              priority: 42,
            })),
          }),
        );
        return;
      }
      if (req.url.endsWith("/config")) {
        res.end(
          '{"routing":{"strategy":"fill-first","session-affinity":true}}',
        );
        return;
      }
      if (req.url.endsWith("/quota/fetch")) {
        quotaCalls++;
        maximum = Math.max(maximum, ++inFlight);
        await gate;
        res.end(
          JSON.stringify({
            rate_limit: {
              weekly: {
                used_percent: 10,
                limit_window_seconds: 604800,
                reset_at: (Date.now() + 86400000) / 1000,
              },
            },
          }),
        );
        inFlight--;
        return;
      }
      if (req.url.endsWith("/fields")) {
        patches.push(body);
        res.end("{}");
        return;
      }
      res.writeHead(404);
      res.end("{}");
    });
    await waitFor(
      async () => (await (await fetch(base + "/api/state")).json()).lastRefresh,
    );
    quotaCalls = 0;
    gate = new Promise((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    const requests = Array.from({ length: 8 }, () =>
      fetch(base + "/api/refresh", { method: "POST", body: "{}" }),
    );
    await waitFor(() => inFlight === 3);
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await Promise.all(requests);
    assert.equal(maximum, 3);
    assert.equal(quotaCalls, 7);
    const put = (scheduler) =>
      fetch(base + "/api/settings", {
        method: "PUT",
        body: JSON.stringify({ scheduler }),
      });
    assert.equal((await put(true)).status, 200);
    assert.equal((await put(false)).status, 200);
    assert.equal((await put(true)).status, 200);
    const backup = JSON.parse(
      await readFile(`${dataDir}/priorities-backup.json`, "utf8"),
    );
    assert.equal(backup.length, 7);
    assert.ok(backup.every((a) => a.priority === 42));
    assert.equal(patches.length, 7);
    assert.equal((await stat(`${dataDir}/settings.json`)).mode & 0o777, 0o600);
    assert.deepEqual(
      (await readdir(dataDir)).filter((name) => name.endsWith(".tmp")),
      [],
    );
  },
);

test(
  "request boundaries reject invalid JSON values without changing scheduler state",
  { timeout: 10000 },
  async (t) => {
    const { base } = await startGateway(t, (req, res) => {
      if (!defaults(req, res)) res.end("{}");
    });
    for (const body of [
      "null",
      "[]",
      "1",
      '"text"',
      "{",
      '{"scheduler":"true"}',
    ]) {
      const response = await fetch(base + "/api/settings", {
        method: "PUT",
        body,
      });
      assert.equal(response.status, 400, body);
    }
    const oversized = await fetch(base + "/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        scheduler: true,
        padding: "x".repeat(2 * 1024 * 1024),
      }),
    });
    assert.equal(oversized.status, 413);
    assert.equal(
      (await (await fetch(base + "/api/state")).json()).settings.scheduler,
      false,
    );
  },
);

test(
  "malformed unauthenticated upgrade targets return 400 without stopping the gateway",
  { timeout: 10000 },
  async (t) => {
    const { base, child } = await startGateway(t, (req, res) => {
      if (!defaults(req, res)) res.end("{}");
    });
    const { connect } = await import("node:net");
    const response = await new Promise((resolve, reject) => {
      let received = "";
      const socket = connect(new URL(base).port, "127.0.0.1", () => {
        socket.write(
          "GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
        );
      });
      socket.on("data", (chunk) => (received += chunk));
      socket.on("end", () => resolve(received));
      socket.on("error", reject);
    });
    assert.match(response, /^HTTP\/1\.1 400 Bad Request/);
    assert.equal(child.exitCode, null);
    assert.equal((await fetch(base + "/healthz")).status, 200);
    assert.equal((await fetch(base + "/v1/models")).status, 401);
  },
);

for (const scenario of [
  "disconnect",
  "oversized catalog",
  "oversized refusal",
]) {
  test(
    `upstream ${scenario} reports 502 and a safe activity event`,
    { timeout: 10000 },
    async (t) => {
      const { base } = await startGateway(t, (req, res) => {
        if (defaults(req, res)) return;
        if (scenario === "disconnect") {
          res.destroy();
          return;
        }
        res.writeHead(scenario === "oversized refusal" ? 429 : 200, {
          "Content-Type": "application/json",
        });
        const padding = "x".repeat(2 * 1024 * 1024);
        res.end(
          JSON.stringify(
            scenario === "oversized catalog"
              ? { data: [{ id: "gpt-test", metadata: padding }] }
              : { error: { message: padding } },
          ),
        );
      });
      const path =
        scenario === "oversized catalog" ? "/codex/v1/models" : "/v1/responses";
      const response = await fetch(base + path + "?private=hidden-query", {
        method: scenario === "oversized catalog" ? "GET" : "POST",
        headers: { Authorization: "Bearer proxy-test" },
        ...(scenario !== "oversized catalog"
          ? { body: '{"model":"gpt-test","input":"private-inference-body"}' }
          : {}),
      });
      assert.equal(response.status, 502);
      const state = await (await fetch(base + "/api/state")).json();
      assert.ok(
        state.events.some(
          (event) =>
            event.type === "error" &&
            event.message === "Upstream connection failed",
        ),
      );
      assert.doesNotMatch(
        JSON.stringify(state.events),
        /hidden-query|private-inference-body|proxy-test|management-test/,
      );
      assert.equal((await fetch(base + "/healthz")).status, 200);
    },
  );
}

for (const scenario of ["oversized", "malformed", "unavailable"]) {
  test(
    `an invalid ownership catalog (${scenario}) reports an upstream failure`,
    { timeout: 10000 },
    async (t) => {
      const { base } = await startGateway(t, (req, res) => {
        if (defaults(req, res)) return;
        res.setHeader("Content-Type", "application/json");
        if (req.url.includes("client_version")) {
          res.end('{"models":[{"slug":"g5","context_window":400000}]}');
          return;
        }
        if (scenario === "unavailable") res.writeHead(503);
        res.end(
          scenario === "oversized"
            ? JSON.stringify({ data: [], padding: "x".repeat(2 * 1024 * 1024) })
            : scenario === "malformed"
              ? "{"
              : "{}",
        );
      });
      const response = await fetch(base + "/codex/v1/models?client_version=1", {
        headers: { Authorization: "Bearer proxy-test" },
      });
      assert.equal(response.status, 502);
      assert.equal((await fetch(base + "/healthz")).status, 200);
    },
  );
}

test(
  "disconnecting during ownership lookup cancels the unfinished upstream body",
  { timeout: 10000 },
  async (t) => {
    const { promise: started, resolve: markStarted } = Promise.withResolvers();
    const { promise: closed, resolve: markClosed } = Promise.withResolvers();
    const { base } = await startGateway(t, (req, res) => {
      if (defaults(req, res)) return;
      res.setHeader("Content-Type", "application/json");
      if (req.url.includes("client_version")) {
        res.end('{"models":[{"slug":"g5"}]}');
        return;
      }
      res.once("close", markClosed);
      res.write('{"data":[');
      markStarted();
    });
    const request = http.get(base + "/codex/v1/models?client_version=1", {
      headers: { Authorization: "Bearer proxy-test" },
    });
    request.on("error", () => {});
    t.after(() => request.destroy());
    await started;
    request.destroy();
    await closed;
    assert.equal((await fetch(base + "/healthz")).status, 200);
  },
);
