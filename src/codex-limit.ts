import { record, records } from "./domain.ts";
import type { JsonObject } from "./domain.ts";
export interface CodexLimit {
  readonly resetsAt: string;
  readonly plan: string | null;
  readonly windowMinutes: number | null;
  readonly headers: Record<string, string>;
}
// Codex stops retrying a 429 only when it carries Codex's own usage-limit shape:
// error.type "usage_limit_reached" with resets_at in epoch seconds. The x-codex-*
// window headers let Codex publish the exhausted window, which T3 needs to arm its
// reset. Everything here comes from the engine's cooldowns and the provider headers
// it recorded; nothing is inferred from local timers.
const WINDOWS = ["primary", "secondary"];

function latestSignals(file: JsonObject, model?: string) {
  const observed = [record(file.model_quotas)[model ?? ""], file.quota]
    .map(record)
    .filter((q) => q.signals);
  observed.sort(
    (a, b) =>
      (Date.parse(String(b.observed_at)) || 0) -
      (Date.parse(String(a.observed_at)) || 0),
  );
  return Object.fromEntries(
    Object.entries(record(observed[0]?.signals)).map(([k, v]) => [
      k.toLowerCase(),
      String(v),
    ]),
  );
}

// Returns the nearest reset when every enabled Codex credential is blocked by a quota
// cooldown for this model. Without a model, only credential-wide cooldowns count.
// Transient cooldowns return null so Codex keeps its normal retries.
export function codexUsageLimit(
  files: ReadonlyArray<JsonObject>,
  model?: string,
  now = Date.now(),
): CodexLimit | null {
  const pool = files.filter(
    (f) => (f.provider || f.type) === "codex" && !f.disabled && !f.runtime_only,
  );
  if (!pool.length) return null;
  const blocked = [];
  for (const file of pool) {
    const until = records(file.cooldowns)
      .filter(
        (c) =>
          /quota/i.test(String(c.reason || "")) &&
          (c.scope === "credential" || (model && c.model_key === model)),
      )
      .map((c) => Date.parse(String(c.retry_at)))
      .filter((t) => t > now);
    if (!until.length) return null;
    blocked.push({ file, resetsAt: Math.max(...until) });
  }
  const { file, resetsAt } = blocked.sort((a, b) => a.resetsAt - b.resetsAt)[0];
  const signals = latestSignals(file, model);
  const number = (key: string) => (signals[key] ? Number(signals[key]) : NaN);
  const windows = WINDOWS.map((name) => ({
    name,
    used: number(`x-codex-${name}-used-percent`),
    minutes: number(`x-codex-${name}-window-minutes`),
    resetAt: number(`x-codex-${name}-reset-at`),
  })).filter((w) => Number.isFinite(w.used));
  const exhausted = windows.filter(
    (w) => w.used >= 100 && w.resetAt * 1000 > now,
  );
  const headers: Record<string, string> = {};
  if (exhausted.length) {
    for (const w of windows) {
      headers[`x-codex-${w.name}-used-percent`] = String(w.used);
      if (Number.isFinite(w.minutes))
        headers[`x-codex-${w.name}-window-minutes`] = String(w.minutes);
      if (Number.isFinite(w.resetAt))
        headers[`x-codex-${w.name}-reset-at`] = String(w.resetAt);
    }
  } else {
    // Recorded windows predate the cooldown. Report only what the engine enforces.
    headers["x-codex-primary-used-percent"] = "100";
    headers["x-codex-primary-reset-at"] = String(Math.ceil(resetsAt / 1000));
  }
  const limiting = exhausted.sort((a, b) => b.resetAt - a.resetAt)[0];
  return {
    resetsAt: new Date(resetsAt).toISOString(),
    plan:
      signals["x-codex-plan-type"] ||
      (typeof file.plan_type === "string" ? file.plan_type : null),
    windowMinutes:
      limiting && Number.isFinite(limiting.minutes) ? limiting.minutes : null,
    headers,
  };
}

export function codexLimitError(limit: CodexLimit, error: JsonObject = {}) {
  const message =
    typeof error.message === "string"
      ? error.message
      : "All Codex credentials are cooling down.";
  return {
    ...error,
    type: "usage_limit_reached",
    message: `${message} Nearest Codex account reset: ${limit.resetsAt}.`,
    resets_at: Math.ceil(Date.parse(limit.resetsAt) / 1000),
    ...(limit.plan ? { plan_type: limit.plan } : {}),
    ...(limit.windowMinutes
      ? { limit_window_minutes: limit.windowMinutes }
      : {}),
  };
}
