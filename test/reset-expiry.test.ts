import { address } from "./test-helpers.ts";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createEngine } from "./effect-helpers.ts";

test("Codex fetches expiry details through the engine for direct and plugin quotas without losing quota on failure", async (t) => {
  const soon = new Date(Date.now() + 86400000).toISOString();
  const later = new Date(Date.now() + 172800000).toISOString();
  let mode = "success",
    count = 2,
    embedded = false;
  const detailCalls: unknown[] = [];
  const credits = [
    { status: "available", expires_at: later },
    { status: "available", expires_at: soon },
  ];
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer management-test");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    res.setHeader("Content-Type", "application/json");
    if (body.url?.endsWith("/rate-limit-reset-credits")) {
      detailCalls.push(body);
      if (mode === "network") {
        res.destroy();
        return;
      }
      res.end(
        JSON.stringify(
          mode === "http"
            ? { status_code: 503, body: "{}" }
            : {
                status_code: 200,
                body: mode === "malformed" ? "{" : JSON.stringify({ credits }),
              },
        ),
      );
      return;
    }
    const usage = {
      rate_limit: { primary_window: { used_percent: 17 } },
      rate_limit_reset_credits: {
        available_count: count,
        ...(embedded ? { credits } : {}),
      },
    };
    res.end(
      JSON.stringify(
        req.url?.endsWith("/quota/fetch")
          ? usage
          : { status_code: 200, body: JSON.stringify(usage) },
      ),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const makeEngine = () =>
    createEngine({
      url: `http://127.0.0.1:${address(server).port}`,
      key: "management-test",
    });
  for (const supportsQuota of [false, true]) {
    const account = {
      id: "codex-test",
      provider: "codex",
      accountId: "account-test",
      supportsQuota,
    };
    for (mode of ["success", "http", "malformed", "network"]) {
      const engine = await makeEngine();
      const before: number = detailCalls.length;
      const quota = await engine.quota(account);
      assert.equal(quota.availableResets, 2);
      assert.equal(quota.windows[0].remaining, 83);
      assert.equal(quota.nextResetExpiresAt, mode === "success" ? soon : null);
      assert.equal(detailCalls.length, before + 1);
      assert.deepEqual(detailCalls.at(-1), {
        auth_index: "codex-test",
        method: "GET",
        url: "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
        header: {
          Authorization: "Bearer $TOKEN$",
          "Chatgpt-Account-Id": "account-test",
        },
      });
    }
    const engine = await makeEngine();
    mode = "success";
    embedded = true;
    const before: number = detailCalls.length;
    assert.equal((await engine.quota(account)).nextResetExpiresAt, soon);
    embedded = false;
    count = 0;
    assert.equal((await engine.quota(account)).nextResetExpiresAt, null);
    count = 2;
    assert.equal(
      detailCalls.length,
      before,
      "embedded expiries and zero balances need no extra lookup",
    );
  }
});

test("optional Codex detail failures back off per account and recover after five minutes", async (t) => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: Date.parse("2026-11-07T00:00:00Z"),
  });
  const expiresAt = "2026-12-01T00:00:00.000Z";
  for (const failure of ["unsupported", "http", "network"]) {
    const engine = await createEngine({
      url: "http://engine.test",
      key: "test",
    });
    const lookups: unknown[] = [];
    let recovered = false,
      usageCalls = 0;
    const mockedFetch = t.mock.method(
      globalThis,
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(
          input instanceof Request ? input.url : input,
        ).pathname
          .split("/")
          .at(-1);
        const options = { body: JSON.parse(String(init?.body)) };
        const response = (value: unknown) =>
          new Response(JSON.stringify(value));
        if (path === "fetch") {
          usageCalls++;
          return response({
            rate_limit: { primary_window: { used_percent: 17 } },
            rate_limit_reset_credits: { available_count: 2 },
          });
        }
        lookups.push(options.body.auth_index);
        if (recovered)
          return response({
            status_code: 200,
            body: { credits: [{ status: "available", expires_at: expiresAt }] },
          });
        if (failure === "network") throw new Error("network unavailable");
        return response({
          status_code: failure === "http" ? 503 : 200,
          body: {},
        });
      },
    );
    const account = { id: "one", provider: "codex", supportsQuota: true };
    assert.equal((await engine.quota(account)).nextResetExpiresAt, null);
    t.mock.timers.tick(60000);
    const quota = await engine.quota(account);
    assert.equal(quota.availableResets, 2);
    assert.equal(quota.windows[0].remaining, 83);
    assert.equal(
      usageCalls,
      2,
      "quota refreshes continue during detail backoff",
    );
    assert.deepEqual(lookups, ["one"]);
    await engine.quota({ ...account, id: "two" });
    assert.deepEqual(
      lookups,
      ["one", "two"],
      "one account does not block another",
    );
    recovered = true;
    t.mock.timers.tick(240000);
    assert.equal((await engine.quota(account)).nextResetExpiresAt, expiresAt);
    assert.equal((await engine.quota(account)).nextResetExpiresAt, expiresAt);
    assert.deepEqual(
      lookups,
      ["one", "two", "one", "one"],
      "successful detail responses remain fresh on subsequent polls",
    );
    mockedFetch.mock.restore();
  }
});

test(
  "a hanging optional Codex detail request returns quota after its short timeout",
  { timeout: 5000 },
  async (t) => {
    const server = http.createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      if (body.url?.endsWith("/rate-limit-reset-credits")) return;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          rate_limit: { primary_window: { used_percent: 17 } },
          rate_limit_reset_credits: { available_count: 2 },
        }),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    const engine = await createEngine({
      url: `http://127.0.0.1:${address(server).port}`,
      key: "test",
    });
    const quota = await engine.quota({
      id: "one",
      provider: "codex",
      supportsQuota: true,
    });
    assert.equal(quota.availableResets, 2);
    assert.equal(quota.windows[0].remaining, 83);
    assert.equal(quota.nextResetExpiresAt, null);
  },
);
