import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Engine } from '../src/engine.js';

test('Codex fetches expiry details through the engine for direct and plugin quotas without losing quota on failure', async t => {
  const soon = new Date(Date.now() + 86400000).toISOString();
  const later = new Date(Date.now() + 172800000).toISOString();
  let mode = 'success', count = 2, embedded = false;
  const detailCalls = [];
  const credits = [{ status: 'available', expires_at: later }, { status: 'available', expires_at: soon }];
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer management-test');
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    res.setHeader('Content-Type', 'application/json');
    if (body.url?.endsWith('/rate-limit-reset-credits')) {
      detailCalls.push(body);
      if (mode === 'network') { res.destroy(); return; }
      res.end(JSON.stringify(mode === 'http' ? { status_code: 503, body: '{}' } : {
        status_code: 200, body: mode === 'malformed' ? '{' : JSON.stringify({ credits }),
      }));
      return;
    }
    const usage = { rate_limit: { primary_window: { used_percent: 17 } }, rate_limit_reset_credits: {
      available_count: count, ...(embedded ? { credits } : {}),
    } };
    res.end(JSON.stringify(req.url.endsWith('/quota/fetch') ? usage : { status_code: 200, body: JSON.stringify(usage) }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const makeEngine = () => new Engine({ url: `http://127.0.0.1:${server.address().port}`, key: 'management-test' });
  for (const supportsQuota of [false, true]) {
    const account = { id: 'codex-test', provider: 'codex', accountId: 'account-test', supportsQuota };
    for (mode of ['success', 'http', 'malformed', 'network']) {
      const engine = makeEngine();
      const before = detailCalls.length;
      const quota = await engine.quota(account);
      assert.equal(quota.availableResets, 2);
      assert.equal(quota.windows[0].remaining, 83);
      assert.equal(quota.nextResetExpiresAt, mode === 'success' ? soon : null);
      assert.equal(detailCalls.length, before + 1);
      assert.deepEqual(detailCalls.at(-1), {
        auth_index: 'codex-test', method: 'GET', url: 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
        header: { Authorization: 'Bearer $TOKEN$', 'Chatgpt-Account-Id': 'account-test' },
      });
    }
    const engine = makeEngine();
    mode = 'success'; embedded = true;
    const before = detailCalls.length;
    assert.equal((await engine.quota(account)).nextResetExpiresAt, soon);
    embedded = false; count = 0;
    assert.equal((await engine.quota(account)).nextResetExpiresAt, null);
    count = 2;
    assert.equal(detailCalls.length, before, 'embedded expiries and zero balances need no extra lookup');
  }
});

test('optional Codex detail failures back off per account and recover after five minutes', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-07T00:00:00Z') });
  const expiresAt = '2026-12-01T00:00:00.000Z';
  for (const failure of ['unsupported', 'http', 'network']) {
    const engine = new Engine({ url: 'http://engine.test', key: 'test' });
    const lookups = [];
    let recovered = false, usageCalls = 0;
    engine.request = async (path, options) => {
      if (path === 'quota/fetch') {
        usageCalls++;
        return { rate_limit: { primary_window: { used_percent: 17 } }, rate_limit_reset_credits: { available_count: 2 } };
      }
      lookups.push(options.body.auth_index);
      if (recovered) return { status_code: 200, body: { credits: [{ status: 'available', expires_at: expiresAt }] } };
      if (failure === 'network') throw new Error('network unavailable');
      return { status_code: failure === 'http' ? 503 : 200, body: {} };
    };
    const account = { id: 'one', provider: 'codex', supportsQuota: true };
    assert.equal((await engine.quota(account)).nextResetExpiresAt, null);
    t.mock.timers.tick(60000);
    const quota = await engine.quota(account);
    assert.equal(quota.availableResets, 2);
    assert.equal(quota.windows[0].remaining, 83);
    assert.equal(usageCalls, 2, 'quota refreshes continue during detail backoff');
    assert.deepEqual(lookups, ['one']);
    await engine.quota({ ...account, id: 'two' });
    assert.deepEqual(lookups, ['one', 'two'], 'one account does not block another');
    recovered = true;
    t.mock.timers.tick(240000);
    assert.equal((await engine.quota(account)).nextResetExpiresAt, expiresAt);
    assert.equal((await engine.quota(account)).nextResetExpiresAt, expiresAt);
    assert.deepEqual(lookups, ['one', 'two', 'one', 'one'], 'successful detail responses remain fresh on subsequent polls');
  }
});

test('a hanging optional Codex detail request returns quota after its short timeout', { timeout: 5000 }, async t => {
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (body.url?.endsWith('/rate-limit-reset-credits')) return;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ rate_limit: { primary_window: { used_percent: 17 } }, rate_limit_reset_credits: { available_count: 2 } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const engine = new Engine({ url: `http://127.0.0.1:${server.address().port}`, key: 'test' });
  const quota = await engine.quota({ id: 'one', provider: 'codex', supportsQuota: true });
  assert.equal(quota.availableResets, 2);
  assert.equal(quota.windows[0].remaining, 83);
  assert.equal(quota.nextResetExpiresAt, null);
});
