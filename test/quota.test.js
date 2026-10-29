import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQuota, rankAccounts, weeklyWindow, timestamp } from '../src/quota.js';
const now = Date.now();
const account = (id, days, remaining = 80, overrides = {}) => ({ id, name: `${id}.json`, provider: 'claude', disabled: false, quota: { fetchedAt: new Date(now).toISOString(), windows: [{ id: 'seven_day_fable', label: '7-day Fable', remaining, resetsAt: new Date(now + days * 86400000).toISOString() }, { id: 'five_hour', label: '5-hour limit', remaining: 100 }] }, ...overrides });

test('new sessions use the nearest reset, independently per provider', () => {
  const ranks = rankAccounts([account('later',4),account('soon',1),account('codex',2,50,{provider:'codex'})],now);
  assert.ok(ranks.find(r=>r.id==='soon').priority > ranks.find(r=>r.id==='later').priority);
  assert.equal(ranks.find(r=>r.id==='codex').priority,10000);
});
test('exhausted short windows cannot outrank usable accounts; disabled accounts are untouched', () => {
  const exhausted=account('empty',.5);exhausted.quota.windows[1].remaining=0;
  const ranks=rankAccounts([exhausted,account('healthy',3),account('paused',.1,100,{disabled:true})],now);
  assert.equal(ranks[0].id,'healthy');assert.equal(ranks[1].priority,-1000000);assert.equal(ranks.length,2);
});
test('stale, missing, and elapsed resets never imply replenishment', () => {
  const stale=account('stale',.1);stale.quota.fetchedAt=new Date(now-181000).toISOString();
  assert.deepEqual(rankAccounts([stale,account('elapsed',-1),account('unknown',1,80,{quota:null})],now).map(r=>r.priority),[0,0,0]);
});
test('Claude utilization is converted to remaining percentage without dropping zero', () => {
  const q=normalizeQuota('claude',{five_hour:{utilization:100,resets_at:'2026-10-25T00:00:00Z'},seven_day:{utilization:0,resets_at:'2026-10-30T00:00:00Z'},seven_day_sonnet:null});
  assert.deepEqual(q.windows.map(w=>w.remaining),[0,100]);
});
test('Codex reset timestamps and window durations are normalized', () => {
  const q=normalizeQuota('codex',{rate_limit:{primary_window:{used_percent:17,limit_window_seconds:18000,reset_at:1792886400},secondary_window:{used_percent:83,limit_window_seconds:604800,reset_at:1793318400}}});
  assert.equal(q.windows[0].remaining,83);assert.equal(q.windows[1].label,'Weekly limit');assert.equal(timestamp(1792886400),'2026-10-25T00:00:00.000Z');
  assert.equal(timestamp(1e16),null);
  const bad=normalizeQuota('codex',{rate_limit:{primary_window:{used_percent:17,limit_window_seconds:18000,reset_at:1e16}}});
  assert.equal(bad.windows[0].resetsAt,null);
});
test('plugin camelCase and snake_case buckets support 7d windows', () => {
  const q=normalizeQuota('xai',{groups:[{buckets:[{window:'7d',remaining_fraction:.25,reset_time:'2026-10-30T00:00:00Z'}]}]});
  assert.equal(weeklyWindow({quota:q}).remaining,25);
  assert.throws(()=>normalizeQuota('claude',{}),/no supported quota/);
});
test('Codex available resets preserve zero and distinguish missing or malformed balances', () => {
  const usage = { rate_limit: { primary_window: { used_percent: 17 } } };
  for (const count of [0, 1, 3, 120]) {
    const quota = normalizeQuota('codex', { ...usage, rate_limit_reset_credits: { available_count: count, applicable_available_count: 0 } });
    assert.equal(quota.availableResets, count);
    assert.equal(quota.windows[0].remaining, 83);
  }
  for (const count of [undefined, null, '', '2', true, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(normalizeQuota('codex', { ...usage, rate_limit_reset_credits: { available_count: count } }).availableResets, null);
  }
  assert.equal(normalizeQuota('codex', usage).availableResets, null);
});
test('Claude counts unused active reset grants without requiring immediate redemption eligibility', () => {
  const grant = (resets_left, extra = {}) => ({ resets_left, starts_at: new Date(now - 86400000).toISOString(), ends_at: new Date(now + 86400000).toISOString(), paused: false, usable_now: false, ...extra });
  const usage = { seven_day: { utilization: 50 }, cedar_ember: { eligible: true, grants: [
    grant(1), grant(2), grant(0), grant(4, { paused: true }),
    grant(8, { ends_at: new Date(now - 1000).toISOString() }),
    grant(16, { starts_at: new Date(now + 86400000).toISOString() }),
  ] } };
  assert.equal(normalizeQuota('claude', usage).availableResets, 3);
  for (const grants of [[], [grant(0)], [grant(1, { ends_at: new Date(now - 1000).toISOString() })]]) {
    assert.equal(normalizeQuota('claude', { ...usage, cedar_ember: { eligible: true, grants } }).availableResets, 0);
  }
  for (const block of [undefined, null, {}, { eligible: false, ineligible_reason: 'surface', grants: [] }, { eligible: true }, { eligible: true, grants: [null] }, { eligible: true, grants: [grant(-1)] }, { eligible: true, grants: [grant(1, { ends_at: 'invalid' })] }]) {
    const quota = normalizeQuota('claude', { ...usage, cedar_ember: block });
    assert.equal(quota.availableResets, null);
    assert.equal(quota.windows[0].remaining, 50);
  }
});
