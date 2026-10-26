import test from 'node:test';
import assert from 'node:assert/strict';
import { codexUsageLimit, codexLimitError } from '../src/codex-limit.js';

const now = Date.parse('2026-10-26T04:00:00Z');
const at = minutes => new Date(now + minutes * 60000).toISOString();
const epoch = minutes => String(Math.floor((now + minutes * 60000) / 1000));
// Shaped like the engine's auth-files entries for Codex credentials.
const codex = (cooldowns, signals = {}, extra = {}) => ({
  provider: 'codex', plan_type: 'plus', cooldowns,
  quota: { observed_at: at(-60), signals },
  ...extra,
});
const exhausted = {
  'X-Codex-Active-Limit': 'premium', 'X-Codex-Plan-Type': 'plus',
  'X-Codex-Primary-Used-Percent': '100', 'X-Codex-Primary-Window-Minutes': '300', 'X-Codex-Primary-Reset-At': epoch(160),
  'X-Codex-Secondary-Used-Percent': '56', 'X-Codex-Secondary-Window-Minutes': '10080', 'X-Codex-Secondary-Reset-At': epoch(9000),
};

test('a Codex pool blocked by quota reports the provider windows and nearest reset', () => {
  const files = [
    codex([{ scope: 'credential', reason: 'credential_quota', retry_at: at(160) }], exhausted),
    codex([{ scope: 'model', model_key: 'gpt-6.1-sol', reason: 'quota', retry_at: at(400) }]),
    { provider: 'claude', cooldowns: [] },
  ];
  const limit = codexUsageLimit(files, 'gpt-6.1-sol', now);
  assert.equal(limit.resetsAt, at(160));
  assert.equal(limit.plan, 'plus');
  assert.equal(limit.windowMinutes, 300);
  assert.deepEqual(limit.headers, {
    'x-codex-primary-used-percent': '100', 'x-codex-primary-window-minutes': '300', 'x-codex-primary-reset-at': epoch(160),
    'x-codex-secondary-used-percent': '56', 'x-codex-secondary-window-minutes': '10080', 'x-codex-secondary-reset-at': epoch(9000),
  });
  // Without a model, as on a websocket upgrade, only credential-wide cooldowns count.
  assert.equal(codexUsageLimit(files, undefined, now), null);
  assert.equal(codexUsageLimit(files.slice(0, 1), undefined, now).resetsAt, at(160));
});

test('usable, transient, disabled, and elapsed cooldowns leave Codex retries alone', () => {
  const blocked = codex([{ scope: 'credential', reason: 'credential_quota', retry_at: at(30) }], exhausted);
  assert.equal(codexUsageLimit([blocked, codex([])], 'gpt-6.1-sol', now), null);
  assert.equal(codexUsageLimit([codex([{ scope: 'credential', reason: 'rate_limit', retry_at: at(1) }])], 'gpt-6.1-sol', now), null);
  assert.equal(codexUsageLimit([codex([{ scope: 'model', model_key: 'gpt-6-astra', reason: 'quota', retry_at: at(30) }])], 'gpt-6.1-sol', now), null);
  assert.equal(codexUsageLimit([codex([{ scope: 'credential', reason: 'credential_quota', retry_at: at(-1) }])], 'gpt-6.1-sol', now), null);
  assert.equal(codexUsageLimit([{ ...blocked, disabled: true }], 'gpt-6.1-sol', now), null);
  assert.ok(codexUsageLimit([blocked, codex([], {}, { disabled: true })], 'gpt-6.1-sol', now));
});

test('stale windows are replaced by the cooldown the engine enforces', () => {
  const stale = { ...exhausted, 'X-Codex-Primary-Used-Percent': '56' };
  const newer = { observed_at: at(-1), signals: { ...exhausted, 'X-Codex-Primary-Reset-At': epoch(170) } };
  const files = [codex([{ scope: 'credential', reason: 'credential_quota', retry_at: at(160) }], stale)];
  const limit = codexUsageLimit(files, 'gpt-6.1-sol', now);
  assert.deepEqual(limit.headers, { 'x-codex-primary-used-percent': '100', 'x-codex-primary-reset-at': epoch(160) });
  assert.equal(limit.windowMinutes, null);
  // The most recently observed provider headers win over older credential-level ones.
  const withModel = [{ ...files[0], model_quotas: { 'gpt-6.1-sol': newer } }];
  assert.equal(codexUsageLimit(withModel, 'gpt-6.1-sol', now).headers['x-codex-primary-reset-at'], epoch(170));
});

test('the refusal uses the error shape Codex treats as a usage limit', () => {
  const limit = { resetsAt: at(160), plan: 'plus', windowMinutes: 300, headers: {} };
  const error = codexLimitError(limit, { code: 'model_cooldown', message: 'All credentials for model gpt-6.1-sol are cooling down', reset_seconds: 9600 });
  assert.deepEqual(error, {
    code: 'model_cooldown',
    message: `All credentials for model gpt-6.1-sol are cooling down Nearest Codex account reset: ${at(160)}.`,
    reset_seconds: 9600,
    type: 'usage_limit_reached',
    resets_at: Number(epoch(160)),
    plan_type: 'plus',
    limit_window_minutes: 300,
  });
  assert.equal(Number.isInteger(codexLimitError({ ...limit, plan: null, windowMinutes: null }).resets_at), true);
  assert.equal('plan_type' in codexLimitError({ ...limit, plan: null }), false);
});
