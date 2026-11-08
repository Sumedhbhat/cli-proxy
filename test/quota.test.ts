import { present } from "./test-helpers.ts";
import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeQuota,
  rankAccounts,
  weeklyWindow,
  timestamp,
} from "../src/quota.ts";
const now = Date.now();
const account = (
  id: string,
  days: number,
  remaining = 80,
  overrides: { provider?: string; disabled?: boolean; quota?: null } = {},
) => ({
  id,
  name: `${id}.json`,
  provider: "claude",
  disabled: false,
  quota: {
    plan: null,
    availableResets: null,
    nextResetExpiresAt: null,
    fetchedAt: new Date(now).toISOString(),
    windows: [
      {
        id: "seven_day_fable",
        label: "7-day Fable",
        remaining,
        resetsAt: new Date(now + days * 86400000).toISOString(),
      },
      {
        id: "five_hour",
        label: "5-hour limit",
        remaining: 100,
        resetsAt: null,
      },
    ],
  },
  ...overrides,
});

test("new sessions use the nearest reset, independently per provider", () => {
  const ranks = rankAccounts(
    [
      account("later", 4),
      account("soon", 1),
      account("codex", 2, 50, { provider: "codex" }),
    ],
    now,
  );
  assert.ok(
    present(ranks.find((r) => r.id === "soon")).priority >
      present(ranks.find((r) => r.id === "later")).priority,
  );
  assert.equal(present(ranks.find((r) => r.id === "codex")).priority, 10000);
});
test("exhausted short windows cannot outrank usable accounts; disabled accounts are untouched", () => {
  const exhausted = account("empty", 0.5);
  present(exhausted.quota).windows[1].remaining = 0;
  const ranks = rankAccounts(
    [
      exhausted,
      account("healthy", 3),
      account("paused", 0.1, 100, { disabled: true }),
    ],
    now,
  );
  assert.equal(ranks[0].id, "healthy");
  assert.equal(ranks[1].priority, -1000000);
  assert.equal(ranks.length, 2);
});
test("stale, missing, and elapsed resets never imply replenishment", () => {
  const stale = account("stale", 0.1);
  present(stale.quota).fetchedAt = new Date(now - 181000).toISOString();
  assert.deepEqual(
    rankAccounts(
      [
        stale,
        account("elapsed", -1),
        account("unknown", 1, 80, { quota: null }),
      ],
      now,
    ).map((r) => r.priority),
    [0, 0, 0],
  );
});
test("Claude utilization is converted to remaining percentage without dropping zero", () => {
  const q = normalizeQuota("claude", {
    five_hour: { utilization: 100, resets_at: "2026-10-25T00:00:00Z" },
    seven_day: { utilization: 0, resets_at: "2026-10-30T00:00:00Z" },
    seven_day_sonnet: null,
  });
  assert.deepEqual(
    q.windows.map((w) => w.remaining),
    [0, 100],
  );
});
test("Codex reset timestamps and window durations are normalized", () => {
  const q = normalizeQuota("codex", {
    rate_limit: {
      primary_window: {
        used_percent: 17,
        limit_window_seconds: 18000,
        reset_at: 1792886400,
      },
      secondary_window: {
        used_percent: 83,
        limit_window_seconds: 604800,
        reset_at: 1793318400,
      },
    },
  });
  assert.equal(q.windows[0].remaining, 83);
  assert.equal(q.windows[1].label, "Weekly limit");
  assert.equal(timestamp(1792886400), "2026-10-25T00:00:00.000Z");
  assert.equal(timestamp(1e16), null);
  const bad = normalizeQuota("codex", {
    rate_limit: {
      primary_window: {
        used_percent: 17,
        limit_window_seconds: 18000,
        reset_at: 1e16,
      },
    },
  });
  assert.equal(bad.windows[0].resetsAt, null);
});
test("plugin camelCase and snake_case buckets support 7d windows", () => {
  const q = normalizeQuota("xai", {
    groups: [
      {
        buckets: [
          {
            window: "7d",
            remaining_fraction: 0.25,
            reset_time: "2026-10-30T00:00:00Z",
          },
        ],
      },
    ],
  });
  assert.equal(present(weeklyWindow({ quota: q })).remaining, 25);
  assert.throws(() => normalizeQuota("claude", {}), /no supported quota/);
});
test("Codex available resets preserve zero and distinguish missing or malformed balances", () => {
  const usage = { rate_limit: { primary_window: { used_percent: 17 } } };
  for (const count of [0, 1, 3, 120]) {
    const quota = normalizeQuota("codex", {
      ...usage,
      rate_limit_reset_credits: {
        available_count: count,
        applicable_available_count: 0,
      },
    });
    assert.equal(quota.availableResets, count);
    assert.equal(quota.windows[0].remaining, 83);
  }
  for (const count of [
    undefined,
    null,
    "",
    "2",
    true,
    -1,
    1.5,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.equal(
      normalizeQuota("codex", {
        ...usage,
        rate_limit_reset_credits: { available_count: count },
      }).availableResets,
      null,
    );
  }
  assert.equal(normalizeQuota("codex", usage).availableResets, null);
});
test("Claude counts unused active reset grants without requiring immediate redemption eligibility", () => {
  const grant = (resets_left: number, extra = {}) => ({
    resets_left,
    starts_at: new Date(now - 86400000).toISOString(),
    ends_at: new Date(now + 86400000).toISOString(),
    paused: false,
    usable_now: false,
    ...extra,
  });
  const usage = {
    seven_day: { utilization: 50 },
    cedar_ember: {
      eligible: true,
      grants: [
        grant(1),
        grant(2),
        grant(0),
        grant(4, { paused: true }),
        grant(8, { ends_at: new Date(now - 1000).toISOString() }),
        grant(16, { starts_at: new Date(now + 86400000).toISOString() }),
      ],
    },
  };
  assert.equal(normalizeQuota("claude", usage).availableResets, 3);
  for (const grants of [
    [],
    [grant(0)],
    [grant(1, { ends_at: new Date(now - 1000).toISOString() })],
  ]) {
    assert.equal(
      normalizeQuota("claude", {
        ...usage,
        cedar_ember: { eligible: true, grants },
      }).availableResets,
      0,
    );
  }
  for (const block of [
    undefined,
    null,
    {},
    { eligible: false, ineligible_reason: "surface", grants: [] },
    { eligible: true },
    { eligible: true, grants: [null] },
    { eligible: true, grants: [grant(-1)] },
    { eligible: true, grants: [grant(1, { ends_at: "invalid" })] },
  ]) {
    const quota = normalizeQuota("claude", { ...usage, cedar_ember: block });
    assert.equal(quota.availableResets, null);
    assert.equal(quota.windows[0].remaining, 50);
  }
});

test("Claude reports the earliest expiry among unused active grants, independent of grant order", (t) => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: Date.parse("2026-11-01T00:00:00Z"),
  });
  const soon = "2026-11-10T00:00:00.000Z",
    later = "2026-12-01T00:00:00.000Z";
  const usage = {
    seven_day: { utilization: 50, resets_at: "2026-11-02T00:00:00Z" },
    cedar_ember: {
      eligible: true,
      grants: [
        { resets_left: 1, ends_at: later },
        { resets_left: 1, ends_at: soon, usable_now: false },
        { resets_left: 0, ends_at: "2026-11-03T00:00:00Z" },
        { resets_left: 1, ends_at: "2026-11-04T00:00:00Z", paused: true },
        { resets_left: 1, ends_at: "2026-10-31T00:00:00Z" },
        { resets_left: 1, starts_at: later, ends_at: "2027-01-01T00:00:00Z" },
      ],
    },
  };
  const quota = normalizeQuota("claude", usage);
  assert.equal(quota.availableResets, 2);
  assert.equal(quota.nextResetExpiresAt, soon);
  usage.cedar_ember.grants.reverse();
  assert.equal(normalizeQuota("claude", usage).nextResetExpiresAt, soon);
  for (const grants of [
    [],
    [{ resets_left: 1 }],
    [{ resets_left: 1, ends_at: null }],
    [{ resets_left: 0, ends_at: soon }],
    [{ resets_left: 1, ends_at: "invalid" }],
  ]) {
    assert.equal(
      normalizeQuota("claude", {
        ...usage,
        cedar_ember: { eligible: true, grants },
      }).nextResetExpiresAt,
      null,
    );
  }
});

test("Codex reset expiry uses available supported credits rather than quota renewal or redeemed credits", (t) => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: Date.parse("2026-11-01T00:00:00Z"),
  });
  const soon = "2026-11-30T19:36:32.781Z";
  const usage = {
    rate_limit: { primary_window: { used_percent: 17, reset_at: 1793577600 } },
    rate_limit_reset_credits: {
      available_count: 2,
      credits: [
        { status: "available", expires_at: "2026-12-01T22:12:49.917421Z" },
        {
          status: "available",
          expires_at: "2026-11-30T19:36:32.781944Z",
          is_supported_by_plan: true,
        },
        { status: "redeemed", expires_at: "2026-11-02T00:00:00Z" },
        {
          status: "available",
          is_supported_by_plan: false,
          expires_at: "2026-11-03T00:00:00Z",
        },
        { status: "available", expires_at: "2026-10-31T00:00:00Z" },
        { status: "available", expires_at: "invalid" },
        null,
      ],
    },
  };
  const quota = normalizeQuota("codex", usage);
  assert.equal(quota.availableResets, 2);
  assert.equal(quota.nextResetExpiresAt, soon);
  for (const count of [0, null, -1, "2"]) {
    assert.equal(
      normalizeQuota("codex", {
        ...usage,
        rate_limit_reset_credits: {
          ...usage.rate_limit_reset_credits,
          available_count: count,
        },
      }).nextResetExpiresAt,
      null,
    );
  }
  for (const credits of [undefined, [], {}, [{ status: "available" }]]) {
    assert.equal(
      normalizeQuota("codex", {
        ...usage,
        rate_limit_reset_credits: { available_count: 2, credits },
      }).nextResetExpiresAt,
      null,
    );
  }
});
