import { present } from "./test-helpers.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { rankAccounts } from "../src/quota.ts";

const now = Date.parse("2026-11-07T00:00:00Z");
const at = (days: number) => new Date(now + days * 86400000).toISOString();
const account = (
  id: string,
  {
    provider = "claude",
    weeklyDays = 4,
    expiryDays = null,
    resets = 2,
    weeklyRemaining = 80,
    shortRemaining = 100,
    shortDays = 0.1,
  }: {
    provider?: string;
    weeklyDays?: number;
    expiryDays?: number | null;
    resets?: number;
    weeklyRemaining?: number;
    shortRemaining?: number;
    shortDays?: number;
  } = {},
) => ({
  id,
  name: `${id}.json`,
  provider,
  quota: {
    plan: null,
    fetchedAt: at(0),
    availableResets: resets,
    nextResetExpiresAt: expiryDays == null ? null : at(expiryDays),
    windows: [
      {
        id: "weekly",
        label: "Weekly limit",
        remaining: weeklyRemaining,
        resetsAt: at(weeklyDays),
      },
      {
        id: "five_hour",
        label: "5-hour limit",
        remaining: shortRemaining,
        resetsAt: at(shortDays),
      },
    ],
  },
});

test("usable accounts follow the earlier of weekly renewal and unused reset expiry", () => {
  for (const provider of ["claude", "codex"]) {
    const pool = [
      account("later", { provider, weeklyDays: 3, expiryDays: 5 }),
      account("credit-tomorrow", { provider, weeklyDays: 5, expiryDays: 1 }),
      account("weekly-today", {
        provider,
        weeklyDays: 0.25,
        expiryDays: 1,
        weeklyRemaining: 10,
      }),
      account("credit-today", { provider, weeklyDays: 4, expiryDays: 0.5 }),
    ];
    const ranks = rankAccounts(pool, now);
    assert.deepEqual(
      ranks.map((r) => r.id),
      ["weekly-today", "credit-today", "credit-tomorrow", "later"],
      provider,
    );
    assert.ok(ranks.every((r) => r.priority > 0));
    assert.equal(new Set(ranks.map((r) => r.priority)).size, 4);
    assert.match(ranks[1].reason, /reset.*expir/i);
  }
});

test("five-hour renewal times and positive remaining amounts do not set the long-term order", () => {
  const ranks = rankAccounts(
    [
      account("short-soon", {
        weeklyDays: 4,
        expiryDays: 3,
        shortDays: 0.01,
        shortRemaining: 1,
      }),
      account("weekly-soon", {
        weeklyDays: 2,
        expiryDays: 5,
        shortDays: 0.2,
        weeklyRemaining: 1,
      }),
    ],
    now,
  );
  assert.deepEqual(
    ranks.map((r) => r.id),
    ["weekly-soon", "short-soon"],
  );
});

test("held resets never make exhausted accounts immediately usable", () => {
  const ranks = rankAccounts(
    [
      account("short-empty", {
        weeklyDays: 0.1,
        expiryDays: 0.01,
        shortRemaining: 0,
      }),
      account("weekly-empty", {
        weeklyDays: 0.1,
        expiryDays: 0.01,
        weeklyRemaining: 0,
      }),
      account("healthy", { weeklyDays: 3, expiryDays: 5 }),
      { ...account("unknown"), quota: null },
      { ...account("paused", { expiryDays: 0.01 }), disabled: true },
      { ...account("runtime", { expiryDays: 0.01 }), runtimeOnly: true },
    ],
    now,
  );
  assert.deepEqual(
    ranks.slice(0, 2).map((r) => r.id),
    ["healthy", "unknown"],
  );
  assert.equal(present(ranks.find((r) => r.id === "unknown")).priority, 0);
  for (const id of ["short-empty", "weekly-empty"])
    assert.equal(present(ranks.find((r) => r.id === id)).priority, -1000000);
  assert.equal(ranks.length, 4);
});

test("missing, expired, or invalid credit details leave weekly ordering intact", () => {
  const details = [
    { availableResets: 0, nextResetExpiresAt: at(0.1) },
    { availableResets: null, nextResetExpiresAt: at(0.1) },
    { availableResets: "2", nextResetExpiresAt: at(0.1) },
    { availableResets: -1, nextResetExpiresAt: at(0.1) },
    { availableResets: 1.5, nextResetExpiresAt: at(0.1) },
    { availableResets: 2, nextResetExpiresAt: null },
    { availableResets: 2, nextResetExpiresAt: "invalid" },
    { availableResets: 2, nextResetExpiresAt: at(-1) },
    { availableResets: 2, nextResetExpiresAt: at(0) },
  ];
  for (const detail of details) {
    const later = account("later", { weeklyDays: 5 });
    Object.assign(later.quota, detail);
    assert.deepEqual(
      rankAccounts([later, account("sooner", { weeklyDays: 3 })], now).map(
        (r) => r.id,
      ),
      ["sooner", "later"],
      JSON.stringify(detail),
    );
  }
});

test("credit expiry cannot promote stale quota or an unknown or elapsed weekly renewal", () => {
  const stale = account("stale", { expiryDays: 0.1 });
  stale.quota.fetchedAt = new Date(now - 181000).toISOString();
  const missing = account("missing", { expiryDays: 0.1 });
  missing.quota.windows.shift();
  const elapsed = account("elapsed", { weeklyDays: -1, expiryDays: 0.1 });
  const ranks = rankAccounts(
    [stale, missing, elapsed, account("healthy")],
    now,
  );
  assert.equal(ranks[0].id, "healthy");
  assert.deepEqual(
    ranks.slice(1).map((r) => r.priority),
    [0, 0, 0],
  );
});

test("equal deadlines prefer the nearer weekly renewal with a stable account tie-break", () => {
  const pool = [
    account("b", { weeklyDays: 4, expiryDays: 1 }),
    account("a", { weeklyDays: 4, expiryDays: 1 }),
    account("weekly-sooner", { weeklyDays: 2, expiryDays: 1 }),
  ];
  assert.deepEqual(
    rankAccounts(pool, now).map((r) => r.id),
    ["weekly-sooner", "a", "b"],
  );
  assert.deepEqual(
    rankAccounts(pool.toReversed(), now).map((r) => r.id),
    ["weekly-sooner", "a", "b"],
  );
  assert.deepEqual(
    rankAccounts(
      [
        account("later-credit", { weeklyDays: 1, expiryDays: 3 }),
        account("sooner-credit", { weeklyDays: 1, expiryDays: 2 }),
      ],
      now,
    ).map((r) => r.id),
    ["sooner-credit", "later-credit"],
  );
});

test("each provider keeps its own first priority when credit expiry determines the winner", () => {
  const ranks = rankAccounts(
    [
      account("claude-weekly", { weeklyDays: 2 }),
      account("codex-weekly", { provider: "codex", weeklyDays: 2 }),
      account("claude-credit", { weeklyDays: 4, expiryDays: 1 }),
      account("codex-credit", {
        provider: "codex",
        weeklyDays: 4,
        expiryDays: 1,
      }),
    ],
    now,
  );
  for (const id of ["claude-credit", "codex-credit"])
    assert.equal(present(ranks.find((r) => r.id === id)).priority, 10000);
});
