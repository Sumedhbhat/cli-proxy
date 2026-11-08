import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyOutcome,
  classifyTokens,
  contextBucket,
  estimate,
  findPrice,
  resolveTier,
} from "../src/accounting.ts";
import type { RawTokens } from "../src/accounting.ts";
import { PRICES } from "../src/pricing.ts";
import type { Price } from "../src/pricing.ts";
import {
  parseBillingCsv,
  parseCsv,
  summarizeSpending,
} from "../src/billing.ts";
import { buildReport } from "../src/usage-report.ts";
import type { Group } from "../src/usage-report.ts";

const raw = (values: Partial<RawTokens>): RawTokens => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cached: 0,
  cache_read: 0,
  cache_creation: 0,
  total: 0,
  ...values,
});

test("Claude cache tokens are separate from input and thinking stays inside output", () => {
  // The engine sets CachedTokens to cache creation for Claude; it must be ignored.
  const result = classifyTokens(
    "claude",
    raw({
      input: 100,
      cache_read: 400,
      cache_creation: 50,
      cached: 400,
      output: 30,
      reasoning: 12,
      total: 580,
    }),
    false,
  );
  assert.equal(result.status, "complete");
  assert.deepEqual(result.tokens, {
    inputUncached: 100,
    cacheRead: 400,
    cacheWrite: 50,
    output: 30,
    reasoning: 12,
    total: 580,
  });
});

test("Codex cached input and reasoning are subsets and are not added twice", () => {
  const result = classifyTokens(
    "codex",
    raw({
      input: 1000,
      cached: 600,
      cache_read: 600,
      output: 300,
      reasoning: 200,
      total: 1300,
    }),
    false,
  );
  assert.deepEqual(result.tokens, {
    inputUncached: 400,
    cacheRead: 600,
    cacheWrite: 0,
    output: 300,
    reasoning: 200,
    total: 1300,
  });
});

test("missing usage is unknown rather than zero, and interrupted counts are partial", () => {
  const missing = classifyTokens("codex", raw({}), true);
  assert.equal(missing.status, "unknown");
  assert.equal(missing.tokens.total, null);
  assert.equal(classifyTokens("claude", raw({}), false).tokens.output, null);
  const interrupted = classifyTokens(
    "claude",
    raw({ input: 100, cache_read: 400, output: 1 }),
    true,
  );
  assert.equal(interrupted.status, "partial");
  assert.equal(interrupted.tokens.total, 501);
  const inconsistent = classifyTokens(
    "codex",
    raw({ input: 10, cache_read: 20, output: 5 }),
    false,
  );
  assert.equal(inconsistent.status, "partial");
  assert.equal(inconsistent.tokens.inputUncached, null);
  assert.equal(
    classifyTokens("xai", raw({ total: 9 }), false).tokens.inputUncached,
    null,
  );
});

test("outcomes and service tiers follow the most authoritative value", () => {
  assert.equal(classifyOutcome(false, 0), "success");
  assert.equal(classifyOutcome(true, 429), "rejected");
  assert.equal(classifyOutcome(true, 499), "interrupted");
  assert.equal(classifyOutcome(true, 502), "failed");
  assert.equal(resolveTier("claude", "fast", "", ""), "fast");
  assert.equal(resolveTier("claude", "", "", "default"), "standard");
  assert.equal(
    resolveTier("codex", "default", "priority", "priority"),
    "standard",
  );
  assert.equal(resolveTier("codex", "", "priority", ""), "fast");
  assert.equal(resolveTier("codex", "flex", "", ""), "flex");
  assert.equal(resolveTier("codex", "scale", "", ""), "scale");
});

test("estimates use cache rates, a write-duration range, and long-context prices", () => {
  const tokens = classifyTokens(
    "claude",
    raw({
      input: 1_000_000,
      cache_read: 1_000_000,
      cache_creation: 1_000_000,
      output: 1_000_000,
    }),
    false,
  ).tokens;
  const price = findPrice(
    "claude",
    "claude-opus-5-5",
    "standard",
    "standard",
    "2026-11-08",
  );
  const value = estimate(tokens, "complete", price);
  // $4 input + $0.20 cache read + $20 output, plus $5 (5-minute) to $8 (1-hour) writes.
  assert.equal(value.status, "priced");
  assert.equal(Number(value.low.toFixed(6)), 29.2);
  assert.equal(Number(value.high.toFixed(6)), 32.2);
  const fast = findPrice(
    "claude",
    "claude-opus-5-5",
    "fast",
    "standard",
    "2026-11-08",
  );
  assert.equal(fast?.input, 8);

  const long = classifyTokens(
    "codex",
    raw({ input: 300_000, output: 10 }),
    false,
  ).tokens;
  assert.equal(contextBucket("codex", "gpt-6.1-sol", long), "long");
  assert.equal(
    findPrice("codex", "gpt-6.1-sol", "standard", "long", "2026-11-08")?.input,
    4,
  );
  assert.equal(contextBucket("claude", "claude-opus-5-5", long), "standard");
  const haiku = classifyTokens(
    "claude",
    raw({ input: 20_000, cache_read: 90_000, output: 1 }),
    false,
  ).tokens;
  assert.equal(contextBucket("claude", "claude-haiku-5-5", haiku), "long");
});

test("unknown models, tiers, dates, and unpublished write rates are not priced as zero", () => {
  const tokens = classifyTokens(
    "codex",
    raw({ input: 10, output: 10, cache_creation: 5 }),
    false,
  ).tokens;
  assert.equal(
    estimate(
      tokens,
      "complete",
      findPrice("codex", "gpt-9", "standard", "standard", "2026-11-08"),
    ).status,
    "no-price",
  );
  assert.equal(
    findPrice("codex", "gpt-6.1-sol", "scale", "standard", "2026-11-08"),
    null,
  );
  assert.equal(
    findPrice(
      "claude",
      "claude-opus-5-5",
      "standard",
      "standard",
      "2026-01-01",
    ),
    null,
  );
  // A promotional price stops applying when its published period ends.
  assert.ok(
    findPrice("codex", "gpt-5.6-sol", "standard", "standard", "2026-11-30"),
  );
  assert.equal(
    findPrice("codex", "gpt-5.6-sol", "standard", "standard", "2026-12-01"),
    null,
  );
  const astra = findPrice(
    "codex",
    "gpt-6-astra",
    "standard",
    "standard",
    "2026-11-08",
  );
  assert.equal(estimate(tokens, "complete", astra).status, "partial");
  assert.equal(
    estimate(classifyTokens("codex", raw({}), false).tokens, "unknown", astra)
      .status,
    "no-usage",
  );
});

test("a price change applies from its effective day without rewriting earlier days", () => {
  const old = PRICES.find((p) => p.models.includes("claude-sonnet-5-5"))!;
  const catalog: Price[] = [
    {
      ...old,
      id: "old",
      effectiveFrom: "2026-11-01",
      effectiveUntil: "2026-12-01",
    },
    {
      ...old,
      id: "new",
      input: 3,
      effectiveFrom: "2026-12-01",
      effectiveUntil: null,
    },
  ];
  assert.equal(
    findPrice(
      "claude",
      "claude-sonnet-5-5",
      "standard",
      "standard",
      "2026-11-30",
      catalog,
    )?.id,
    "old",
  );
  assert.equal(
    findPrice(
      "claude",
      "claude-sonnet-5-5",
      "standard",
      "standard",
      "2026-12-01",
      catalog,
    )?.id,
    "new",
  );
  for (const price of PRICES) {
    assert.ok(price.source.startsWith("https://"), price.id);
    assert.equal(price.currency, "USD");
  }
  assert.equal(new Set(PRICES.map((p) => p.id)).size, PRICES.length);
});

test("reports separate providers, keep unknown executions countable, and list missing prices", () => {
  const group = (overrides: Partial<Group>): Group => ({
    day: "2026-11-08",
    provider: "claude",
    model: "claude-opus-5-5",
    tier: "standard",
    context: "standard",
    usageStatus: "complete",
    account: "claude-a.json",
    device: "laptop-1",
    principal: "device",
    classified: true,
    outcome: "success",
    executions: 2,
    tokens: {
      inputUncached: 200,
      cacheRead: 800,
      cacheWrite: 100,
      output: 40,
      reasoning: 0,
      total: 1140,
    },
    ...overrides,
  });
  const report = buildReport([
    group({}),
    group({
      provider: "codex",
      model: "gpt-mystery",
      account: "codex-b.json",
      device: null,
      principal: "shared-key",
      executions: 1,
      tokens: {
        inputUncached: 1,
        cacheRead: 0,
        cacheWrite: 0,
        output: 1,
        reasoning: 0,
        total: 2,
      },
    }),
    group({
      usageStatus: "unknown",
      classified: false,
      outcome: "interrupted",
      executions: 3,
      tokens: {
        inputUncached: null,
        cacheRead: null,
        cacheWrite: null,
        output: null,
        reasoning: null,
        total: null,
      },
    }),
  ]);
  assert.equal(report.totals.executions, 6);
  assert.equal(report.totals.status.unknown, 3);
  assert.equal(report.totals.tokens.total, 1142);
  assert.equal(report.providers.claude.tokens.total, 1140);
  assert.equal(report.providers.codex.estimate.executions["no-price"], 1);
  assert.deepEqual(
    report.pricing.missing.map((m) => m.model),
    ["gpt-mystery"],
  );
  assert.deepEqual(report.breakdowns.devices.map((d) => d.key).sort(), [
    "laptop-1",
    "shared-key",
  ]);
  assert.ok(
    report.totals.estimate.low > 0 &&
      report.totals.estimate.high > report.totals.estimate.low,
  );
});

test("billing imports validate rows and count credit use separately from spending", () => {
  assert.deepEqual(parseCsv('a,"b,""c"""\r\n1,2\n'), [
    ["a", 'b,"c"'],
    ["1", "2"],
  ]);
  const parsed = parseBillingCsv(
    [
      "date,kind,provider,amount,currency,period_start,period_end,description",
      "2026-11-01,subscription,claude,200.00,USD,2026-11-01,2026-11-30,Max plan",
      "2026-11-02,credit_purchase,codex,50,USD,,,Credits",
      "2026-11-05,credit_consumption,codex,12.5,USD,,,Paid from credits",
      "2026-11-06,usage_charge,codex,3.10,USD,,,",
      "2026-11-07,refund,claude,20,USD,,,",
    ].join("\n"),
  );
  assert.deepEqual(parsed.errors, []);
  const totals = summarizeSpending(parsed.records);
  assert.equal(totals.USD.spend, 20000 + 5000 + 310 - 2000);
  assert.equal(totals.USD.credit_consumption, 1250);
  const bad = parseBillingCsv(
    "date,kind,provider,amount,currency\n2026-13-01,gift,claude,1.234,usd\n",
  );
  assert.equal(bad.records.length, 0);
  assert.match(bad.errors[0], /kind must be/);
  assert.match(parseBillingCsv("date,amount\n").errors[0], /Missing columns/);
});
