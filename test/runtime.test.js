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
