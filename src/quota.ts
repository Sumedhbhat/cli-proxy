import { record, records } from "./domain.ts";
import type {
  Quota,
  QuotaWindow,
  RankedAccount,
  Rank,
  JsonObject,
} from "./domain.ts";
const clamp = (n: number) => Math.max(0, Math.min(100, n));
export function timestamp(value: unknown): string | null {
  if (value == null || value === "") return null;
  const n =
    typeof value === "number"
      ? value * (value < 1e12 ? 1000 : 1)
      : typeof value === "string"
        ? Date.parse(value)
        : NaN;
  // Out-of-range values are finite but still invalid dates.
  const date = new Date(n);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function quotaWindow(
  id: string,
  label: string,
  used: unknown,
  reset: unknown,
): QuotaWindow | null {
  if (used == null || !Number.isFinite(Number(used))) return null;
  return {
    id,
    label,
    remaining: clamp(100 - Number(used)),
    resetsAt: timestamp(reset),
  };
}
const resetCount = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
function availableResets(provider: string, data: JsonObject, now: number) {
  const unknown = { availableResets: null, nextResetExpiresAt: null };
  const nearest = (times: string[]) =>
    times.sort((a, b) => Date.parse(a) - Date.parse(b))[0] || null;
  if (provider === "codex") {
    const block = record(data.rate_limit_reset_credits);
    const count = resetCount(block?.available_count);
    const expiries = (Array.isArray(block?.credits) ? block.credits : [])
      .map(record)
      .filter(
        (credit) =>
          credit?.status === "available" &&
          credit.is_supported_by_plan !== false,
      )
      .map((credit) => timestamp(credit.expires_at))
      .filter(
        (time): time is string => time !== null && Date.parse(time) > now,
      );
    return {
      availableResets: count,
      nextResetExpiresAt: count != null && count > 0 ? nearest(expiries) : null,
    };
  }
  if (provider !== "claude") return unknown;
  const block = record(data.cedar_ember);
  // An ineligible caller (for example an older CLI) does not establish a zero balance.
  if (block?.eligible !== true || !Array.isArray(block.grants)) return unknown;
  let available = 0;
  const expiries = [];
  for (const grant of block.grants.map(record)) {
    const count = resetCount(grant?.resets_left);
    if (count == null) return unknown;
    const startsAt = timestamp(grant.starts_at),
      endsAt = timestamp(grant.ends_at);
    if (
      (grant.starts_at != null && !startsAt) ||
      (grant.ends_at != null && !endsAt)
    )
      return unknown;
    if (
      grant.paused === true ||
      (startsAt && Date.parse(startsAt) > now) ||
      (endsAt && Date.parse(endsAt) <= now)
    )
      continue;
    // usable_now describes redemption eligibility, not how many unused resets are held.
    available += count;
    if (count != null && count > 0 && endsAt) expiries.push(endsAt);
  }
  const count = resetCount(available);
  return {
    availableResets: count,
    nextResetExpiresAt: count != null && count > 0 ? nearest(expiries) : null,
  };
}
export function normalizeQuota(provider: string, input: JsonObject): Quota {
  const data = input;
  const now = Date.now();
  let windows: Array<QuotaWindow | null> = [];
  if (Array.isArray(data.groups)) {
    windows = records(data.groups).flatMap((g, i) =>
      records(g.buckets).map((b, j) => {
        const fraction = b.remainingFraction ?? b.remaining_fraction;
        if (fraction == null || !Number.isFinite(Number(fraction))) return null;
        return {
          id: `${i}-${j}-${b.window || ""}`,
          label: String(
            b.description ||
              b.window ||
              g.displayName ||
              g.display_name ||
              "Quota",
          ),
          remaining: clamp(Number(fraction) * 100),
          resetsAt: timestamp(b.resetTime ?? b.reset_time),
        };
      }),
    );
  } else if (provider === "claude") {
    windows = Object.entries(data)
      .filter(
        ([key, val]) =>
          /five_hour|seven_day/.test(key) && val && typeof val === "object",
      )
      .map(([key, val]) =>
        quotaWindow(
          key,
          (
            {
              five_hour: "5-hour limit",
              seven_day: "7-day limit",
              seven_day_fable: "7-day Fable",
              seven_day_opus: "7-day Opus",
              seven_day_sonnet: "7-day Sonnet",
            } as Record<string, string>
          )[key] || key.replaceAll("_", " "),
          record(val).utilization,
          record(val).resets_at,
        ),
      );
  } else if (provider === "codex") {
    for (const [key, value] of Object.entries(record(data.rate_limit))) {
      if (!value || typeof value !== "object") continue;
      const window = record(value);
      const seconds = Number(window.limit_window_seconds);
      const label =
        seconds >= 604800
          ? "Weekly limit"
          : seconds >= 18000
            ? "5-hour limit"
            : key.replaceAll("_", " ");
      windows.push(
        quotaWindow(key, label, window.used_percent, window.reset_at),
      );
    }
  }
  const supported = windows.filter(
    (window): window is QuotaWindow => window !== null,
  );
  if (!supported.length)
    throw new Error("Provider returned no supported quota windows");
  return {
    windows: supported,
    ...availableResets(provider, data, now),
    plan:
      typeof record(data.subscription).plan === "string"
        ? (record(data.subscription).plan as string)
        : typeof data.plan_type === "string"
          ? data.plan_type
          : null,
    fetchedAt: new Date(now).toISOString(),
  };
}
export function weeklyWindow(
  account: Pick<RankedAccount, "quota">,
): QuotaWindow | null {
  const windows = account.quota?.windows || [];
  return (
    windows.find(
      (w) =>
        /fable/i.test(w.id + w.label) && /7|seven|week/i.test(w.id + w.label),
    ) ||
    windows.find((w) =>
      /7[ _-]?day|7d|seven[ _-]?day|week/i.test(w.id + w.label),
    ) ||
    null
  );
}
export function rankAccounts(
  accounts: ReadonlyArray<RankedAccount>,
  now = Date.now(),
  staleMs = 180000,
): Rank[] {
  const eligible = accounts.filter((a) => !a.disabled && !a.runtimeOnly);
  const groups = Map.groupBy(eligible, (a) => a.provider);
  const result: Rank[] = [];
  for (const pool of groups.values()) {
    const scored = pool
      .map((a) => {
        const fresh =
          !!a.quota && now - Date.parse(a.quota!.fetchedAt) <= staleMs;
        const w = weeklyWindow(a);
        // Never invent replenishment from a local timer. A fresh provider poll must confirm it.
        const future = w?.resetsAt && Date.parse(w.resetsAt ?? "") > now;
        const exhausted =
          fresh && !!a.quota?.windows.some((x) => x.remaining <= 0);
        const reset =
          future && w?.resetsAt ? Date.parse(w.resetsAt ?? "") : Infinity;
        const expiresAt =
          (resetCount(a.quota?.availableResets) ?? 0) > 0 &&
          a.quota?.nextResetExpiresAt
            ? Date.parse(a.quota.nextResetExpiresAt)
            : NaN;
        const expiry = expiresAt > now ? expiresAt : Infinity;
        // Short windows affect availability, but only weekly renewal and unused
        // reset expiry determine which account's usable quota to consume first.
        return {
          account: a,
          exhausted,
          usable: Boolean(fresh && future && !exhausted),
          reset,
          expiry,
          deadline: Math.min(reset, expiry),
        };
      })
      .sort(
        (a, b) =>
          Number(b.usable) - Number(a.usable) ||
          Number(a.exhausted) - Number(b.exhausted) ||
          a.deadline - b.deadline ||
          a.reset - b.reset ||
          a.expiry - b.expiry ||
          a.account.id.localeCompare(b.account.id),
      );
    scored.forEach((s, i) => {
      const reason = s.exhausted
        ? "Quota exhausted; engine cooldown applies"
        : !s.usable
          ? "Quota unknown or stale; normal fallback"
          : s.expiry < s.reset
            ? "Unused reset expires before weekly renewal"
            : "Earliest weekly reset first";
      result.push({
        id: s.account.id,
        name: s.account.name,
        priority: s.exhausted ? -1000000 : s.usable ? 10000 - i : 0,
        reason,
      });
    });
  }
  return result;
}

export function modelProvider(model: unknown): "claude" | "codex" | null {
  if (typeof model !== "string") return null;
  return /^claude-/i.test(model)
    ? "claude"
    : /^(?:gpt-|codex|o[1-9])/i.test(model)
      ? "codex"
      : null;
}

// Claude reset timestamps remain useful during quota outages even after the
// utilization snapshot goes stale. Reuse only provider-reported future resets;
// local timers still cannot confirm replenishment.
export function nearestResetInfo(
  accounts: ReadonlyArray<RankedAccount>,
  model: string,
  now = Date.now(),
) {
  const provider = modelProvider(model);
  if (!provider) return null;
  const resets = accounts
    .filter(
      (a) =>
        a.provider === provider &&
        !a.disabled &&
        !a.runtimeOnly &&
        a.quota &&
        (provider === "claude" ||
          now - Date.parse(a.quota!.fetchedAt) <= 180000),
    )
    .flatMap((a) => {
      const windows = a.quota!.windows.filter((w) => {
        const family = /opus|sonnet|fable/i.exec(w.id + " " + w.label)?.[0];
        return !family || model.toLowerCase().includes(family.toLowerCase());
      });
      const blocked = windows.filter((w) => w.remaining <= 0);
      const relevant = blocked.length
        ? blocked
        : windows.filter((w) => Date.parse(w.resetsAt ?? "") > now);
      const times = relevant.map((w) => Date.parse(w.resetsAt ?? ""));
      if (!times.length || times.some((t) => !Number.isFinite(t))) return [];
      const time = blocked.length ? Math.max(...times) : Math.min(...times);
      if (time <= now) return [];
      const window = relevant.find(
        (w) => Date.parse(w.resetsAt ?? "") === time,
      );
      const rateLimitType =
        window &&
        /^five_hour$|^seven_day(?:_opus|_sonnet|_fable)?$/.test(window.id)
          ? window.id
          : undefined;
      return [
        { resetsAt: new Date(time).toISOString(), rateLimitType, provider },
      ];
    });
  return (
    resets.sort((a, b) => Date.parse(a.resetsAt) - Date.parse(b.resetsAt))[0] ||
    null
  );
}

export function nearestReset(
  accounts: ReadonlyArray<RankedAccount>,
  model: string,
  now = Date.now(),
) {
  return nearestResetInfo(accounts, model, now)?.resetsAt || null;
}
