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
});
test('plugin camelCase and snake_case buckets support 7d windows', () => {
  const q=normalizeQuota('xai',{groups:[{buckets:[{window:'7d',remaining_fraction:.25,reset_time:'2026-10-30T00:00:00Z'}]}]});
  assert.equal(weeklyWindow({quota:q}).remaining,25);
  assert.throws(()=>normalizeQuota('claude',{}),/no supported quota/);
});
