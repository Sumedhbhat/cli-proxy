import {
  account as baseAccount,
  quota as baseQuota,
} from "./application-fixture.ts";
import type { Account, DashboardState } from "../src/domain.ts";
import { present } from "./test-helpers.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeQuota, rankAccounts } from "../src/quota.ts";
import { dashboard } from "./dashboard-fixture.ts";

test("quota and account views show reset balances, nearest expiries, unknown values, and snapshot freshness", async (t) => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: Date.parse("2026-11-07T00:00:00Z"),
  });
  const soon = new Date(Date.now() + 86400000).toISOString();
  const later = new Date(Date.now() + 172800000).toISOString();
  const expiryQuota = normalizeQuota("codex", {
    rate_limit: { primary_window: { used_percent: 17 } },
    rate_limit_reset_credits: {
      available_count: 2,
      credits: [
        { status: "available", expires_at: later },
        { status: "available", expires_at: soon },
      ],
    },
  });
  const account = (
    id: string,
    provider: string,
    availableResets: number | null | undefined,
    extra: Partial<Account> = {},
  ): Account => ({
    ...baseAccount(id),
    provider,
    quota: { ...baseQuota(0), availableResets: availableResets ?? null },
    ...extra,
  });
  const rankedAccount = (
    id: string,
    weeklyDays: number,
    expiryDays: number,
    shortRemaining = 100,
  ) =>
    account(id, "codex", 2, {
      quota: {
        ...baseQuota(0),
        availableResets: 2,
        fetchedAt: new Date().toISOString(),
        nextResetExpiresAt: new Date(
          Date.now() + expiryDays * 86400000,
        ).toISOString(),
        windows: [
          {
            id: "weekly",
            label: "Weekly limit",
            remaining: 50,
            resetsAt: new Date(
              Date.now() + weeklyDays * 86400000,
            ).toISOString(),
          },
          {
            id: "five_hour",
            label: "5-hour limit",
            remaining: shortRemaining,
            resetsAt: new Date(Date.now() + 3600000).toISOString(),
          },
        ],
      },
    });
  const state = {
    demo: false,
    refreshing: false,
    lastRefresh: null,
    refreshError: null,
    schedulerError: null,
    accounts: [
      account("one", "claude", 1),
      account("zero", "codex", 0),
      account("unknown", "codex", undefined),
      account("invalid", "codex", -1),
      account("cached", "claude", 2, { quotaError: "Upstream unavailable" }),
      account("stale", "claude", 3, {
        quota: {
          ...baseQuota(0),
          availableResets: 3,
          fetchedAt: new Date(Date.now() - 3600000).toISOString(),
          windows: [],
        },
      }),
      account("unsupported", "xai", null),
      account("expiring", "codex", 2, { quota: expiryQuota }),
      account("cached-expiry", "codex", 2, {
        quota: expiryQuota,
        quotaError: "Upstream unavailable",
      }),
      account("stale-expiry", "codex", 2, {
        quota: {
          ...baseQuota(0),
          ...expiryQuota,
          fetchedAt: new Date(Date.now() - 3600000).toISOString(),
        },
      }),
      account("elapsed-expiry", "codex", 2, {
        quota: {
          ...baseQuota(0),
          ...expiryQuota,
          nextResetExpiresAt: new Date(Date.now() - 1000).toISOString(),
        },
      }),
      account("invalid-expiry", "codex", 2, {
        quota: {
          ...baseQuota(0),
          ...expiryQuota,
          nextResetExpiresAt: "invalid",
        },
      }),
      account("zero-expiry", "codex", 0, {
        quota: {
          ...baseQuota(0),
          ...expiryQuota,
          availableResets: 0,
        },
      }),
      rankedAccount("a-later", 3, 5),
      rankedAccount("m-credit-tomorrow", 4, 1),
      rankedAccount("z-weekly-today", 0.5, 2),
      rankedAccount("blocked", 0.1, 0.1, 0),
    ],
    ranks: rankAccounts([]),
    settings: { scheduler: false, intervalSeconds: 60 },
    routing: { affinity: true, strategy: "fill-first" },
    events: [],
    connected: true,
  } satisfies DashboardState;
  state.ranks = rankAccounts(state.accounts);
  const { main, location, handlers } = await dashboard(t, state);
  const rowFor = (id: string) =>
    present(
      [
        ...main.innerHTML.matchAll(
          /<article class="account-row">[\s\S]*?<\/article>/g,
        ),
      ].find(([html]) => html.includes(`data-id="${id}"`))?.[0],
    );
  const assertAccountBalance = (id: string, text: string) => {
    const row = rowFor(id);
    assert.ok(row, `missing row for ${id}: ${main.innerHTML}`);
    assert.equal(
      row.match(/<div class="account-resets"[^>]*>([^<]*)<\/div>/)?.[1],
      text,
      `balance for ${id}`,
    );
  };
  const assertBalances = () => {
    assertAccountBalance("one", "1 reset available");
    assertAccountBalance("zero", "0 resets available");
    assertAccountBalance("unknown", "Resets not reported");
    assertAccountBalance("invalid", "Resets not reported");
    assertAccountBalance("cached", "Cached · 2 resets available");
    assertAccountBalance("stale", "Stale · 3 resets available");
    const when = new Date(soon).toLocaleString([], {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    });
    for (const [id, age] of [
      ["expiring", ""],
      ["cached-expiry", "Cached · "],
      ["stale-expiry", "Stale · "],
    ]) {
      const expiryText = rowFor(id).match(
        /<div class="account-reset-expiry">([^<]*)<\/div>/,
      )?.[1];
      assert.equal(expiryText, `${age}Next reset expires in 1 day · ${when}`);
    }
    assert.match(
      rowFor("elapsed-expiry"),
      /Reset expiry passed · .* · refresh needed/,
    );
    assert.match(rowFor("invalid-expiry"), />Expiry not reported</);
    assert.match(rowFor("one"), />Expiry not reported</);
    for (const id of ["zero", "unknown", "invalid", "zero-expiry"])
      assert.doesNotMatch(rowFor(id), /account-reset-expiry/);
    assert.doesNotMatch(main.innerHTML, /Invalid Date/);
    assert.doesNotMatch(main.innerHTML, /-1 resets available/);
  };
  const assertRoutingOrder = () => {
    const ids = [...main.innerHTML.matchAll(/data-id="([^"]+)"/g)]
      .map(([, id]) => id)
      .filter((id) =>
        ["a-later", "m-credit-tomorrow", "z-weekly-today", "blocked"].includes(
          id,
        ),
      );
    assert.deepEqual(ids, [
      "z-weekly-today",
      "m-credit-tomorrow",
      "a-later",
      "blocked",
    ]);
    assert.match(rowFor("z-weekly-today"), /Next for new sessions/);
    assert.doesNotMatch(rowFor("blocked"), /Next for new sessions/);
    assert.match(rowFor("m-credit-tomorrow"), /Next reset expires in 1 day/);
  };
  assertBalances();
  assertRoutingOrder();
  await main.handlers.change({ target: { id: "layout", value: "cards" } });
  assert.match(main.innerHTML, /class="card-view"/);
  assertBalances();
  assertRoutingOrder();
  location.hash = "#accounts";
  handlers.hashchange();
  assertBalances();
  assertRoutingOrder();
  await main.handlers.change({ target: { id: "layout", value: "ledger" } });
  assert.match(main.innerHTML, /class="ledger-head"/);
  assertBalances();
  assertRoutingOrder();
  await main.handlers.change({ target: { id: "sort", value: "name" } });
  const names = [...main.innerHTML.matchAll(/data-id="([^"]+)"/g)]
    .map(([, id]) => id)
    .filter((id) =>
      ["a-later", "m-credit-tomorrow", "z-weekly-today", "blocked"].includes(
        id,
      ),
    );
  assert.deepEqual(names, [
    "a-later",
    "blocked",
    "m-credit-tomorrow",
    "z-weekly-today",
  ]);
  assert.match(rowFor("z-weekly-today"), /Next for new sessions/);
  assertBalances();
});
