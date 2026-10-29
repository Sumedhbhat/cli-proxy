import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('quota and account views show reset balances, unknown values, and snapshot freshness', async () => {
  const account = (id, provider, availableResets, extra = {}) => ({
    id, name: `${id}.json`, provider, quota: {
      availableResets, fetchedAt: new Date().toISOString(), windows: [],
    }, ...extra,
  });
  const state = {
    accounts: [
      account('one', 'claude', 1), account('zero', 'codex', 0),
      account('unknown', 'codex', undefined), account('invalid', 'codex', -1),
      account('cached', 'claude', 2, { quotaError: 'Upstream unavailable' }),
      account('stale', 'claude', 3, { quota: { availableResets: 3, fetchedAt: new Date(Date.now() - 3600000).toISOString(), windows: [] } }),
      account('unsupported', 'xai', null),
    ], ranks: [], settings: {}, routing: {}, events: [], connected: true,
  };
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      innerHTML: '', handlers: {}, addEventListener(type, handler) { this.handlers[type] = handler; },
    });
    return elements.get(selector);
  };
  const location = { href: 'http://localhost/', hash: '#quota' }, handlers = {};
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  await vm.runInNewContext(`(async () => { ${source}\n })()`, {
    document: { querySelector: element, querySelectorAll: () => [], documentElement: { dataset: {} }, body: { classList: { remove() {} } } },
    window: { addEventListener(type, handler) { handlers[type] = handler; } },
    location, localStorage: { getItem: () => null }, URL,
    fetch: async () => ({ ok: true, json: async () => state }), setInterval() {},
  });
  const main = element('#main');
  const assertAccountBalance = (id, text) => {
    const row = [...main.innerHTML.matchAll(/<article class="account-row">[\s\S]*?<\/article>/g)]
      .find(([html]) => html.includes(`data-id="${id}"`))?.[0];
    assert.ok(row, `missing row for ${id}`);
    assert.equal(row.match(/<div class="account-resets"[^>]*>([^<]*)<\/div>/)?.[1], text, `balance for ${id}`);
  };
  const assertBalances = () => {
    assertAccountBalance('one', '1 reset available');
    assertAccountBalance('zero', '0 resets available');
    assertAccountBalance('unknown', 'Resets not reported');
    assertAccountBalance('invalid', 'Resets not reported');
    assertAccountBalance('cached', 'Cached · 2 resets available');
    assertAccountBalance('stale', 'Stale · 3 resets available');
    assert.doesNotMatch(main.innerHTML, /-1 resets available/);
  };
  assertBalances();
  await main.handlers.change({ target: { id: 'layout', value: 'cards' } });
  assert.match(main.innerHTML, /class="card-view"/);
  assertBalances();
  location.hash = '#accounts';
  handlers.hashchange();
  assertBalances();
  await main.handlers.change({ target: { id: 'layout', value: 'ledger' } });
  assert.match(main.innerHTML, /class="ledger-head"/);
  assertBalances();
});
