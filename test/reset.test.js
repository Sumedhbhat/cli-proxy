import test from 'node:test';
import assert from 'node:assert/strict';
import { nearestReset } from '../src/quota.js';
test('reset selection separates providers and waits for all exhausted windows', () => {
  const now = Date.now();
  const account = (provider, times, extra = {}) => ({ provider, quota: { fetchedAt: new Date(now).toISOString(), windows: times.map(seconds => ({id:'five_hour', label:'Limit', remaining:0, resetsAt:new Date(now+seconds*1000).toISOString()})) }, ...extra });
  const accounts = [account('claude',[10,90]),account('claude',[60]),account('codex',[20]),account('claude',[1],{disabled:true})];
  assert.equal(Date.parse(nearestReset(accounts,'claude-opus-5-5',now)),now+60000);
  assert.equal(Date.parse(nearestReset(accounts,'gpt-6.1-sol',now)),now+20000);
  assert.equal(nearestReset(accounts,'unknown',now),null);
  assert.equal(nearestReset(accounts,'claude-opus-5-5',now+180001),null);
});
