import test from "node:test";
import assert from "node:assert/strict";
import type { Account, DashboardState, JsonObject } from "../src/domain.ts";
import { normalizeQuota } from "../src/quota.ts";
import { account } from "./application-fixture.ts";
import { dashboard } from "./dashboard-fixture.ts";
import { present } from "./test-helpers.ts";

const claude = (id: string, usage: JsonObject): Account => ({
  ...account(id),
  provider: "claude",
  quota: normalizeQuota("claude", usage),
});
const state = (accounts: Account[]): DashboardState => ({
  demo: false,
  connected: true,
  accounts,
  settings: { scheduler: false, intervalSeconds: 60 },
  routing: { strategy: "fill-first", affinity: true },
  refreshing: false,
  lastRefresh: null,
  refreshError: null,
  schedulerError: null,
  ranks: [],
  events: [],
});
const cards = (html: string) =>
  [...html.matchAll(/<article class="summary-card">[\s\S]*?<\/article>/g)].map(
    ([card]) => card,
  );
const cardFor = (html: string, provider: string, label: string) =>
  present(
    cards(html).find(
      (card) =>
        card.includes(`class="provider-mark ${provider}"`) &&
        card.includes(`<div class="summary-label">${label}</div>`),
    ),
  );
const rowFor = (html: string, id: string) =>
  present(
    [
      ...html.matchAll(/<article class="account-row">[\s\S]*?<\/article>/g),
    ].find(([row]) => row.includes(`data-id="${id}"`))?.[0],
  );
const additionalSection = (row: string) =>
  present(
    /<section class="additional-limits" aria-label="Additional limits">([\s\S]*?)<\/section>/.exec(
      row,
    )?.[1],
  );

test("reported Claude limits have independent totals and account details in both layouts", async (t) => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: Date.parse("2026-11-10T00:00:00Z"),
  });
  const at = (days: number) =>
    new Date(Date.now() + days * 86400000).toISOString();
  const fableReset = at(1);
  const generalReset = at(5);
  const { main, location, handlers } = await dashboard(
    t,
    state([
      account("codex"),
      claude("mixed", {
        five_hour: { utilization: 45, resets_at: at(0.1) },
        seven_day: { utilization: 20, resets_at: generalReset },
        seven_day_opus: { utilization: 60, resets_at: at(2) },
        seven_day_sonnet: { utilization: 10, resets_at: at(3) },
        seven_day_fable: { utilization: 90, resets_at: fableReset },
        one_day_research: { utilization: 25, resets_at: at(0.5) },
      }),
      claude("ordinary", {
        seven_day: { utilization: 70, resets_at: generalReset },
        seven_day_fable: null,
      }),
      claude("fable-empty", {
        seven_day: { utilization: 60, resets_at: generalReset },
        seven_day_fable: { utilization: 100, resets_at: at(4) },
      }),
      {
        ...claude("paused", {
          seven_day: { utilization: 0, resets_at: at(0.5) },
          seven_day_fable: { utilization: 0, resets_at: at(0.5) },
          seven_day_paused_only: { utilization: 0 },
        }),
        disabled: true,
      },
    ]),
  );
  const assertSummaries = () => {
    assert.equal(cards(main.innerHTML).length, 6);
    const general = cardFor(main.innerHTML, "claude", "Weekly limit");
    assert.match(general, /<strong>150%<\/strong><span>of 300%<\/span>/);
    assert.match(general, /<small>3 credentials<\/small>/);
    assert.match(general, /in 5 days/);
    const fable = cardFor(main.innerHTML, "claude", "7-day Fable");
    assert.match(fable, /<strong>10%<\/strong><span>of 200%<\/span>/);
    assert.match(fable, /<small>2 credentials<\/small>/);
    assert.match(fable, /in 1 day/);
    assert.equal((fable.match(/role="meter"/g) || []).length, 2);
    assert.match(fable, /aria-valuenow="0"/);
    const research = cardFor(main.innerHTML, "claude", "One-day Research");
    assert.match(research, /<strong>75%<\/strong><span>of 100%<\/span>/);
    assert.match(research, /<small>1 credential<\/small>/);
  };
  const assertLimits = () => {
    const row = rowFor(main.innerHTML, "mixed");
    for (const [label, remaining] of [
      ["7-day limit", 80],
      ["5-hour limit", 55],
      ["7-day Fable", 10],
      ["7-day Opus", 40],
      ["7-day Sonnet", 90],
      ["One-day Research", 75],
    ]) {
      assert.match(
        row,
        new RegExp(`<span>${label}</span><strong>${remaining}%`),
      );
    }
    assert.ok(row.indexOf("7-day limit") < row.indexOf("5-hour limit"));
    assert.ok(row.indexOf("5-hour limit") < row.indexOf("7-day Fable"));
    const additional = additionalSection(row);
    assert.match(additional, /90% used · 10% remaining/);
    assert.match(additional, /in 1 day<br>/);
    assert.ok(
      additional.includes(
        new Date(fableReset).toLocaleString([], {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }),
      ),
    );
    assert.doesNotMatch(additional, /7-day limit|5-hour limit/);
    assert.equal((row.match(/7-day Fable/g) || []).length, 1);
    assert.doesNotMatch(
      rowFor(main.innerHTML, "ordinary"),
      /Additional limits|Fable|Research/,
    );
    assert.match(
      additionalSection(rowFor(main.innerHTML, "fable-empty")),
      /100% used · 0% remaining/,
    );
    assert.doesNotMatch(rowFor(main.innerHTML, "codex"), /Fable/);
  };
  assert.match(
    main.innerHTML,
    /<span>Short window<\/span><span>Additional limits<\/span>/,
  );
  assertSummaries();
  assertLimits();
  await main.handlers.change({ target: { id: "layout", value: "cards" } });
  assertSummaries();
  assertLimits();
  location.hash = "#accounts";
  handlers.hashchange();
  assertLimits();
  location.hash = "#overview";
  handlers.hashchange();
  assertSummaries();
});

test("absent and null additional limits leave no tiles, columns, or placeholders", async (t) => {
  const accounts = [
    claude("absent", { seven_day: { utilization: 40 } }),
    claude("null", {
      seven_day: { utilization: 20 },
      seven_day_fable: null,
    }),
  ];
  const { main } = await dashboard(t, state(accounts));
  assert.equal(cards(main.innerHTML).length, 2);
  assert.match(
    cardFor(main.innerHTML, "claude", "Weekly limit"),
    /<strong>140%<\/strong><span>of 200%<\/span>/,
  );
  assert.doesNotMatch(main.innerHTML, /Fable|Additional limits/);

  const refresh = () =>
    main.handlers.click({
      target: {
        closest: (selector: string) =>
          selector === "[data-action]"
            ? { dataset: { action: "refresh" } }
            : null,
      },
    });
  const original = accounts[0];
  accounts[0] = claude(original.id, {
    seven_day: { utilization: 40 },
    seven_day_fable: { utilization: 15 },
    seven_day_research: { utilization: 35 },
  });
  await refresh();
  assert.match(cardFor(main.innerHTML, "claude", "7-day Fable"), /85%/);
  assert.match(cardFor(main.innerHTML, "claude", "7-day Research"), /65%/);
  assert.match(
    additionalSection(rowFor(main.innerHTML, original.id)),
    /Research/,
  );

  accounts[0] = original;
  await refresh();
  assert.doesNotMatch(main.innerHTML, /Fable|Research|Additional limits/);
});

test("Fable-only accounts cannot be counted as general Claude quota", async (t) => {
  const { main } = await dashboard(
    t,
    state([claude("fable-only", { seven_day_fable: { utilization: 35 } })]),
  );
  assert.match(cardFor(main.innerHTML, "claude", "7-day Fable"), /65%/);
  assert.match(
    additionalSection(rowFor(main.innerHTML, "fable-only")),
    /35% used · 65% remaining/,
  );
  const general = cardFor(main.innerHTML, "claude", "Weekly limit");
  assert.match(general, /<strong>—<\/strong><span>of 0% known<\/span>/);
  assert.match(general, /No fresh quota loaded/);
});

test("cached and stale Fable snapshots keep the tile without inventing fresh quota", async (t) => {
  const cached = {
    ...claude("cached", { seven_day_fable: { utilization: 25 } }),
    quotaError: "Provider unavailable",
  };
  const staleAccount = claude("stale", { seven_day_fable: { utilization: 0 } });
  const stale = {
    ...staleAccount,
    quota: {
      ...present(staleAccount.quota),
      fetchedAt: new Date(Date.now() - 181000).toISOString(),
    },
  };
  const { main } = await dashboard(t, state([cached, stale]));
  const fable = cardFor(main.innerHTML, "claude", "7-day Fable");
  assert.match(fable, /<strong>75%<\/strong><span>of 100% known<\/span>/);
  assert.match(fable, /<small>2 credentials<\/small>/);
  assert.match(fable, /Cached · Reset not reported/);
  assert.match(
    additionalSection(rowFor(main.innerHTML, "cached")),
    /Cached · Reset not reported/,
  );
  assert.match(
    additionalSection(rowFor(main.innerHTML, "stale")),
    /Stale · Reset not reported/,
  );
});

test("a stale Fable limit stays discoverable and providers are not displaced by the optional tile", async (t) => {
  const staleAccount = claude("stale", { seven_day_fable: { utilization: 0 } });
  const stale = {
    ...staleAccount,
    quota: {
      ...present(staleAccount.quota),
      fetchedAt: new Date(Date.now() - 181000).toISOString(),
    },
  };
  const { main } = await dashboard(
    t,
    state([
      stale,
      ...["codex", "xai", "kimi", "gemini"].map((provider) => ({
        ...account(provider),
        provider,
      })),
    ]),
  );
  const fable = cardFor(main.innerHTML, "claude", "7-day Fable");
  assert.match(fable, /<strong>—<\/strong><span>of 0% known<\/span>/);
  assert.match(fable, /No fresh quota loaded/);
  assert.equal(cards(main.innerHTML).length, 6);
  for (const provider of ["codex", "xai", "kimi", "gemini"])
    assert.ok(cardFor(main.innerHTML, provider, "Weekly limit"));
});
