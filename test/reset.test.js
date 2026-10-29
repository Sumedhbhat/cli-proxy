import test from 'node:test';
import assert from 'node:assert/strict';
import { nearestReset, nearestResetInfo, rankAccounts } from '../src/quota.js';
test('reset selection separates providers and waits for all exhausted windows', () => {
  const now = Date.now();
  const account = (provider, times, extra = {}) => ({ provider, quota: { fetchedAt: new Date(now).toISOString(), windows: times.map(seconds => ({id:'five_hour', label:'Limit', remaining:0, resetsAt:new Date(now+seconds*1000).toISOString()})) }, ...extra });
  const accounts = [account('claude',[10,90]),account('claude',[60]),account('codex',[20]),account('claude',[1],{disabled:true})];
  assert.equal(Date.parse(nearestReset(accounts,'claude-opus-5-5',now)),now+60000);
  assert.equal(Date.parse(nearestReset(accounts,'gpt-6.1-sol',now)),now+20000);
  assert.equal(nearestReset(accounts,'unknown',now),null);
  assert.equal(nearestReset(accounts,'claude-opus-5-5',now+180001),null);
});

test('cached Claude resets outlive quota freshness without refreshing utilization', () => {
  const now = Date.now();
  const quota = { fetchedAt: new Date(now - 3600000).toISOString(), windows: [
    { id: 'seven_day', label: '7-day limit', remaining: 0, resetsAt: new Date(now + 86400000).toISOString() },
  ] };
  const claude = { id: 'claude', name: 'claude.json', provider: 'claude', quota, quotaError: 'Quota unavailable' };
  assert.deepEqual(nearestResetInfo([claude], 'claude-opus-5-5', now), {
    resetsAt: quota.windows[0].resetsAt, rateLimitType: 'seven_day', provider: 'claude',
  });
  assert.equal(rankAccounts([claude], now)[0].priority, 0);
  assert.equal(nearestReset([{ ...claude, provider: 'codex' }], 'gpt-6.1-sol', now), null);
  // A persisted snapshot can also be used before the first refresh completes.
  assert.equal(nearestReset([{ ...claude, quotaError: undefined }], 'claude-opus-5-5', now), quota.windows[0].resetsAt);
  assert.equal(nearestReset([claude], 'claude-opus-5-5', now + 86400000), null);
});

test('cached Claude resets keep waiting for future blockers after shorter windows pass', () => {
  const now = Date.now(), reset = new Date(now + 3600000).toISOString();
  const account = { provider: 'claude', quota: { fetchedAt: new Date(now - 3600000).toISOString(), windows: [
    { id: 'five_hour', label: '5-hour limit', remaining: 0, resetsAt: new Date(now - 60000).toISOString() },
    { id: 'seven_day', label: '7-day limit', remaining: 0, resetsAt: reset },
  ] } };
  assert.deepEqual(nearestResetInfo([account], 'claude-opus-5-5', now), {
    resetsAt: reset, rateLimitType: 'seven_day', provider: 'claude',
  });
  account.quota.windows[0].resetsAt = null;
  assert.equal(nearestReset([account], 'claude-opus-5-5', now), null);
});

test('cached Claude reset selection ignores disabled accounts and unrelated model windows', () => {
  const now = Date.now(), reset = new Date(now + 3600000).toISOString();
  const account = { provider: 'claude', quota: { fetchedAt: new Date(now - 3600000).toISOString(), windows: [
    { id: 'seven_day_opus', label: '7-day Opus', remaining: 0, resetsAt: reset },
  ] } };
  assert.equal(nearestReset([account], 'claude-sonnet-4-6', now), null);
  assert.equal(nearestReset([{ ...account, disabled: true }], 'claude-opus-5-5', now), null);
  assert.equal(nearestReset([{ ...account, runtimeOnly: true }], 'claude-opus-5-5', now), null);
  assert.equal(nearestReset([{ ...account, quota: null }], 'claude-opus-5-5', now), null);
  account.quota.windows[0].resetsAt = 'invalid';
  assert.equal(nearestReset([account], 'claude-opus-5-5', now), null);
});
