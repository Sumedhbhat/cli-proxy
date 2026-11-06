import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restoreProxyReset } from '../src/claude-compat.js';

test('failed Claude quota refreshes always call upstream and retain cached quota and T3 resets', { timeout: 20000 }, async t => {
  let mode = 'success', reset = new Date(Date.now() + 3600000).toISOString(), resetsLeft = 2;
  const expiresAt = new Date(Date.now() + 86400000).toISOString();
  const calls = { plugin: 0, direct: 0, missing: 0 };
  const dir = await mkdtemp(join(tmpdir(), 'cli-proxy-cache-test-'));
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ intervalSeconds: 3600 }));
  let child, accountsGate = null, releaseAccounts;
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
    child = null;
  };
  const engine = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {}, path = new URL(req.url, 'http://local').pathname;
    res.setHeader('Content-Type', 'application/json');
    if (path.endsWith('/auth-files')) {
      await accountsGate;
      res.end(JSON.stringify({ files: Object.keys(calls).map(id => ({
        name: `${id}.json`, auth_index: id, provider: 'claude', supports_quota: id !== 'direct',
      })) }));
    } else if (path.endsWith('/config')) res.end(JSON.stringify({ routing: {} }));
    else if (path.endsWith('/quota/fetch') || path.endsWith('/api-call')) {
      calls[body.auth_index]++;
      if (mode === 'network') { res.destroy(); return; }
      if (body.auth_index === 'missing' || mode === 'http') {
        if (path.endsWith('/api-call')) res.end(JSON.stringify({ status_code: 503, body: '{}' }));
        else { res.writeHead(503); res.end('{}'); }
        return;
      }
      if (mode === 'malformed') { res.end('{'); return; }
      if (path.endsWith('/api-call')) {
        assert.equal(body.method, 'GET');
        assert.equal(new URL(body.url).searchParams.get('cedar_ember'), '1');
        assert.match(body.header['User-Agent'], /^claude-cli\//);
      }
      const quota = mode === 'unsupported' ? {} : { seven_day: { utilization: 100, resets_at: reset }, cedar_ember: { eligible: true, grants: [{ resets_left: resetsLeft, ends_at: expiresAt }] } };
      res.end(JSON.stringify(path.endsWith('/api-call') ? { status_code: 200, body: JSON.stringify(quota) } : quota));
    } else if (path === '/v1/messages') {
      res.writeHead(429);
      res.end(JSON.stringify({ error: { type: 'rate_limit_error', message: 'All credentials cooling down' } }));
    } else { res.writeHead(404); res.end('{}'); }
  });
  t.after(async () => {
    releaseAccounts?.();
    await stop();
    engine.closeAllConnections();
    await new Promise(resolve => engine.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  engine.listen(0, '127.0.0.1'); await once(engine, 'listening');
  const probe = http.createServer().listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`, cachePath = join(dir, 'quota-cache.json');
  const state = async () => (await fetch(base + '/api/state')).json();
  const waitForState = async (waitForRefresh = true) => {
    for (let i = 0; i < 100; i++) {
      try { const snapshot = await state(); if (!waitForRefresh || (snapshot.lastRefresh && !snapshot.refreshing)) return snapshot; } catch {}
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.fail('gateway did not reach the expected startup state');
  };
  const start = async (waitForRefresh = true) => {
    child = spawn(process.execPath, ['src/server.js'], { cwd: process.cwd(), env: {
      ...process.env, PORT: String(port), ENGINE_URL: `http://127.0.0.1:${engine.address().port}`,
      ENGINE_MANAGEMENT_KEY: 'test-management', PROXY_API_KEY: 'test-api', DATA_DIR: dir,
    }, stdio: 'ignore' });
    return waitForState(waitForRefresh);
  };
  const refresh = async id => {
    const response = await fetch(base + '/api/refresh', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
    return state();
  };
  const assertReset = async expected => {
    const response = await fetch(base + '/v1/messages', {
      method: 'POST', headers: { Authorization: 'Bearer test-api', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-5-5' }),
    });
    assert.equal(response.status, 429);
    const { error } = await response.json();
    assert.equal(error.resets_at, expected);
    assert.equal(response.headers.get('x-ratelimit-reset'), expected || null);
    if (expected) {
      assert.ok(Number(response.headers.get('retry-after')) > 0);
      assert.equal(response.headers.get('anthropic-ratelimit-unified-status'), 'rejected');
      assert.equal(response.headers.get('anthropic-ratelimit-unified-representative-claim'), 'seven_day');
      assert.equal(Number(response.headers.get('anthropic-ratelimit-unified-reset')), Math.ceil(Date.parse(expected) / 1000));
      const frame = restoreProxyReset({ type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: error.message }] } });
      assert.equal(frame.api_error_params.rate_limit_info.resetsAt, Date.parse(expected) / 1000);
    } else assert.equal(error.message, 'All credentials cooling down');
  };

  let snapshot = await start();
  const cached = new Map(snapshot.accounts.map(a => [a.id, a.quota]));
  assert.deepEqual(calls, { plugin: 1, direct: 1, missing: 1 });
  assert.equal(cached.get('missing'), null);
  assert.equal(cached.get('plugin').availableResets, 2);
  assert.equal(cached.get('direct').availableResets, 2);
  assert.equal(cached.get('plugin').nextResetExpiresAt, expiresAt);
  assert.equal(cached.get('direct').nextResetExpiresAt, expiresAt);
  assert.ok(snapshot.accounts.find(a => a.id === 'missing').quotaError);
  await assertReset(reset);

  for (mode of ['http', 'malformed', 'unsupported', 'network']) {
    const before = { ...calls };
    snapshot = await refresh();
    for (const account of snapshot.accounts) {
      assert.equal(calls[account.id], before[account.id] + 1);
      assert.deepEqual(account.quota, cached.get(account.id));
      assert.ok(account.quotaError);
    }
    await assertReset(reset);
  }
  // Refreshing one credential must not clear the others' cached-error status.
  const beforeTargeted = { ...calls };
  snapshot = await refresh('plugin');
  assert.deepEqual(calls, { ...beforeTargeted, plugin: beforeTargeted.plugin + 1 });
  assert.ok(snapshot.accounts.every(a => a.quotaError));

  const cachedErrors = new Map(snapshot.accounts.map(a => [a.id, a.quotaError]));
  await stop();
  const disk = JSON.parse(await readFile(cachePath, 'utf8'));
  assert.deepEqual(disk.map(a => a.quota), [...cached.values()]);
  // Age the persisted snapshots beyond three minutes without waiting in real time.
  const fetchedAt = new Date(Date.now() - 3600000).toISOString();
  disk.forEach(a => { if (a.quota) a.quota.fetchedAt = fetchedAt; });
  await writeFile(cachePath, JSON.stringify(disk));
  // Keep the startup refresh pending so it cannot replace the restored error state.
  accountsGate = new Promise(resolve => { releaseAccounts = resolve; });
  snapshot = await start(false);
  assert.equal(snapshot.lastRefresh, null);
  assert.equal(snapshot.refreshing, true);
  for (const account of snapshot.accounts) {
    assert.equal(account.quotaError, cachedErrors.get(account.id));
    assert.equal(account.quota?.availableResets, cached.get(account.id)?.availableResets);
    assert.equal(account.quota?.nextResetExpiresAt, cached.get(account.id)?.nextResetExpiresAt);
  }
  releaseAccounts(); accountsGate = null;
  snapshot = await waitForState();
  for (const account of snapshot.accounts.filter(a => a.quota)) {
    assert.equal(account.quota.fetchedAt, fetchedAt);
    assert.equal(account.quota.availableResets, cached.get(account.id).availableResets);
    assert.equal(snapshot.ranks.find(r => r.id === account.id).priority, 0);
  }
  await assertReset(reset);

  mode = 'success'; reset = new Date(Date.now() + 7200000).toISOString(); resetsLeft = 0;
  snapshot = await refresh();
  for (const account of snapshot.accounts.filter(a => a.quota)) {
    assert.equal(account.quota.windows[0].resetsAt, reset);
    assert.equal(account.quota.availableResets, 0);
    assert.equal(account.quota.nextResetExpiresAt, null);
    assert.notEqual(account.quota.fetchedAt, fetchedAt);
    assert.equal(account.quotaError, null);
  }
  await assertReset(reset);

  // An elapsed provider timestamp is never extended or treated as replenishment.
  reset = new Date(Date.now() - 1000).toISOString();
  await refresh();
  mode = 'http';
  await refresh();
  await assertReset(undefined);
});
