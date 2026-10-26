const clamp = n => Math.max(0, Math.min(100, n));
export function timestamp(value) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value * (value < 1e12 ? 1000 : 1) : Date.parse(value);
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
}
function quotaWindow(id, label, used, reset) {
  if (used == null || !Number.isFinite(Number(used))) return null;
  return { id, label, remaining: clamp(100 - Number(used)), resetsAt: timestamp(reset) };
}
export function normalizeQuota(provider, data) {
  let windows = [];
  if (Array.isArray(data.groups)) {
    windows = data.groups.flatMap((g, i) => (g.buckets || []).map((b, j) => {
      const fraction = b.remainingFraction ?? b.remaining_fraction;
      if (fraction == null || !Number.isFinite(Number(fraction))) return null;
      return { id: `${i}-${j}-${b.window || ''}`, label: b.description || b.window || g.displayName || g.display_name || 'Quota', remaining: clamp(Number(fraction) * 100), resetsAt: timestamp(b.resetTime ?? b.reset_time) };
    }));
  } else if (provider === 'claude') {
    windows = Object.entries(data).filter(([key, val]) => /five_hour|seven_day/.test(key) && val && typeof val === 'object').map(([key, val]) => quotaWindow(key, ({ five_hour: '5-hour limit', seven_day: '7-day limit', seven_day_fable: '7-day Fable', seven_day_opus: '7-day Opus', seven_day_sonnet: '7-day Sonnet' })[key] || key.replaceAll('_', ' '), val.utilization, val.resets_at));
  } else if (provider === 'codex') {
    for (const [key, value] of Object.entries(data.rate_limit || {})) {
      if (!value || typeof value !== 'object') continue;
      const seconds = value.limit_window_seconds;
      const label = seconds >= 604800 ? 'Weekly limit' : seconds >= 18000 ? '5-hour limit' : key.replaceAll('_', ' ');
      windows.push(quotaWindow(key, label, value.used_percent, value.reset_at));
    }
  }
  windows = windows.filter(Boolean);
  if (!windows.length) throw new Error('Provider returned no supported quota windows');
  return { windows, plan: data.subscription?.plan || data.plan_type || null, fetchedAt: new Date().toISOString() };
}
export function weeklyWindow(account) {
  const windows = account.quota?.windows || [];
  return windows.find(w => /fable/i.test(w.id + w.label) && /7|seven|week/i.test(w.id + w.label))
    || windows.find(w => /7[ _-]?day|7d|seven[ _-]?day|week/i.test(w.id + w.label)) || null;
}
export function rankAccounts(accounts, now = Date.now(), staleMs = 180000) {
  const eligible = accounts.filter(a => !a.disabled && !a.runtimeOnly);
  const groups = Map.groupBy(eligible, a => a.provider);
  const result = [];
  for (const pool of groups.values()) {
    const scored = pool.map(a => {
      const fresh = a.quota && now - Date.parse(a.quota.fetchedAt) <= staleMs;
      const w = weeklyWindow(a);
      // Never invent replenishment from a local timer. A fresh provider poll must confirm it.
      const future = w?.resetsAt && Date.parse(w.resetsAt) > now;
      const exhausted = fresh && a.quota.windows.some(x => x.remaining <= 0);
      return { account: a, exhausted, usable: fresh && future && !exhausted, reset: future ? Date.parse(w.resetsAt) : Infinity };
    }).sort((a, b) => Number(b.usable) - Number(a.usable) || Number(a.exhausted) - Number(b.exhausted) || a.reset - b.reset || a.account.id.localeCompare(b.account.id));
    scored.forEach((s, i) => result.push({ id: s.account.id, name: s.account.name, priority: s.exhausted ? -1000000 : s.usable ? 10000 - i : 0, reason: s.exhausted ? 'Quota exhausted; engine cooldown applies' : s.usable ? 'Earliest weekly reset first' : 'Quota unknown or stale; normal fallback' }));
  }
  return result;
}

// Use only recent provider data; local timers cannot confirm replenishment.
export function nearestResetInfo(accounts, model, now = Date.now()) {
  if (typeof model !== 'string') return null;
  const provider = /^claude-/i.test(model || '') ? 'claude' : /^(?:gpt-|codex|o[1-9])/i.test(model || '') ? 'codex' : null;
  if (!provider) return null;
  const resets = accounts.filter(a => a.provider === provider && !a.disabled && !a.runtimeOnly
    && now - Date.parse(a.quota?.fetchedAt) <= 180000).flatMap(a => {
      const windows = a.quota.windows.filter(w => {
        const family = /opus|sonnet|fable/i.exec(w.id + ' ' + w.label)?.[0];
        return !family || model.toLowerCase().includes(family.toLowerCase());
      });
      const blocked = windows.filter(w => w.remaining <= 0);
      const relevant = blocked.length ? blocked : windows;
      const times = relevant.map(w => Date.parse(w.resetsAt));
      if (!times.length || times.some(t => !Number.isFinite(t) || t <= now)) return [];
      const time = blocked.length ? Math.max(...times) : Math.min(...times);
      const window = relevant.find(w => Date.parse(w.resetsAt) === time);
      const rateLimitType = /^five_hour$|^seven_day(?:_opus|_sonnet|_fable)?$/.test(window.id) ? window.id : undefined;
      return [{ resetsAt: new Date(time).toISOString(), rateLimitType, provider }];
    });
  return resets.sort((a, b) => Date.parse(a.resetsAt) - Date.parse(b.resetsAt))[0] || null;
}

export function nearestReset(accounts, model, now = Date.now()) {
  return nearestResetInfo(accounts, model, now)?.resetsAt || null;
}
